/**
 * Global Plugin Hook Runner
 *
 * Singleton hook runner that's initialized when plugins are loaded
 * and can be called from anywhere in the codebase.
 */

import { createSubsystemLogger } from "../logging/subsystem.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import { notifyAiKnowledgeMemoryWriteViaAdb } from "../zte_modules/memory/casual-memory/notifyAiKnowledgeMemoryWriteViaAdb.js";
import type { GlobalHookRunnerRegistry } from "./hook-registry.types.js";
import type {
  EmbeddedRunTrigger,
  PluginHookAfterToolCallEvent,
  PluginHookGatewayContext,
  PluginHookGatewayStopEvent,
  PluginHookToolContext,
} from "./hook-types.js";
import { createHookRunner, type HookRunner } from "./hooks.js";

type HookRunnerGlobalState = {
  hookRunner: HookRunner | null;
  registry: GlobalHookRunnerRegistry | null;
};

const hookRunnerGlobalStateKey = Symbol.for("openclaw.plugins.hook-runner-global-state");
const getState = () =>
  resolveGlobalSingleton<HookRunnerGlobalState>(hookRunnerGlobalStateKey, () => ({
    hookRunner: null,
    registry: null,
  }));

const getLog = () => createSubsystemLogger("plugins");

function normalizeFsPathForMatch(filePath: string): string {
  return filePath.replaceAll("\\", "/").trim();
}

function isMemoryWritePath(filePath: string): boolean {
  const normalized = normalizeFsPathForMatch(filePath);
  if (!normalized) return false;

  const lower = normalized.toLowerCase();
  const segments = lower.split("/").filter(Boolean);
  const base = segments.length > 0 ? segments[segments.length - 1] : "";

  if (!segments.includes("memory") && (base === "memory.md" || base === "user.md")) {
    return true;
  }

  return /(^|\/)memory\/[^/]+\.md$/i.test(lower);
}

const AIK_MEMORY_NOTIFY_BLOCKED_RUN_TRIGGERS = new Set<EmbeddedRunTrigger>([
  "memory",
  "heartbeat",
  "cron",
  "overflow",
]);

function shouldNotifyAiKnowledgeFromMemoryToolWrite(
  runTrigger: EmbeddedRunTrigger | undefined,
): boolean {
  if (runTrigger === undefined) {
    return true;
  }
  return !AIK_MEMORY_NOTIFY_BLOCKED_RUN_TRIGGERS.has(runTrigger);
}

function isSessionMemoryHandoffArchivePath(filePath: string): boolean {
  const normalized = normalizeFsPathForMatch(filePath);
  if (!normalized) return false;
  const lower = normalized.toLowerCase();
  const segments = lower.split("/").filter(Boolean);
  const base = segments.length > 0 ? segments[segments.length - 1] : "";
  if (!base) return false;
  const underMemoryDir = /(^|\/)memory\//i.test(lower);
  if (!underMemoryDir) return false;
  return /^\d{4}-\d{2}-\d{2}-.+\.md$/i.test(base);
}

export function initializeGlobalHookRunner(registry: GlobalHookRunnerRegistry): void {
  const state = getState();
  const log = getLog();
  state.registry = registry;
  state.hookRunner = createHookRunner(registry, {
    logger: {
      debug: (msg) => log.debug(msg),
      warn: (msg) => log.warn(msg),
      error: (msg) => log.error(msg),
    },
    catchErrors: true,
    failurePolicyByHook: {
      before_tool_call: "fail-closed",
    },
  });

  const base = state.hookRunner;
  state.hookRunner = {
    ...base,
    hasHooks: (hookName) => (hookName === "after_tool_call" ? true : base.hasHooks(hookName)),
    runAfterToolCall: async (event: PluginHookAfterToolCallEvent, ctx: PluginHookToolContext) => {
      try {
        const toolName = event.toolName?.trim().toLowerCase();
        const path = (event.params as Record<string, unknown> | undefined)?.path;
        const isMemoryFilesystemTool = toolName === "write" || toolName === "edit";
        const ok = !event.error;
        if (isMemoryFilesystemTool && ok && typeof path === "string" && isMemoryWritePath(path)) {
          const sessionHandoffArchive = isSessionMemoryHandoffArchivePath(path);
          const notifyAi =
            shouldNotifyAiKnowledgeFromMemoryToolWrite(ctx.runTrigger) && !sessionHandoffArchive;
          log.info(
            `[after_tool_call] memory file hook triggered tool=${JSON.stringify(
              toolName,
            )} runTrigger=${JSON.stringify(ctx.runTrigger ?? null)} path=${JSON.stringify(
              normalizeFsPathForMatch(path),
            )} sessionHandoffArchive=${JSON.stringify(sessionHandoffArchive)} notifyAiK=${JSON.stringify(notifyAi)}`,
          );
          if (notifyAi) {
            void notifyAiKnowledgeMemoryWriteViaAdb({
              filePath: path,
              memoryWriteUserBodyPlain: ctx.memoryWriteUserBodyPlain,
              config: ctx.config,
              log,
            });
          } else {
            log.debug(
              `[after_tool_call] memory file hook skipped AIK provider notify (${
                sessionHandoffArchive ? "session handoff archive path" : "background run"
              }) runTrigger=${JSON.stringify(
                ctx.runTrigger,
              )} path=${JSON.stringify(normalizeFsPathForMatch(path))}`,
            );
          }
        }
      } catch (err) {
        log.warn(`[after_tool_call] memory write monitor failed: ${String(err)}`);
      }
      return await base.runAfterToolCall(event, ctx);
    },
  };

  const hookCount = registry.hooks.length;
  if (hookCount > 0) {
    log.debug(`hook runner initialized with ${hookCount} registered hooks`);
  }
}

/**
 * Get the global hook runner.
 * Returns null if plugins haven't been loaded yet.
 */
export function getGlobalHookRunner(): HookRunner | null {
  return getState().hookRunner;
}

/**
 * Get the global plugin registry.
 * Returns null if plugins haven't been loaded yet.
 */
export function getGlobalPluginRegistry(): GlobalHookRunnerRegistry | null {
  return getState().registry;
}

/**
 * Check if any hooks are registered for a given hook name.
 */
export function hasGlobalHooks(hookName: Parameters<HookRunner["hasHooks"]>[0]): boolean {
  return getState().hookRunner?.hasHooks(hookName) ?? false;
}

export async function runGlobalGatewayStopSafely(params: {
  event: PluginHookGatewayStopEvent;
  ctx: PluginHookGatewayContext;
  onError?: (err: unknown) => void;
}): Promise<void> {
  const log = getLog();
  const hookRunner = getGlobalHookRunner();
  if (!hookRunner?.hasHooks("gateway_stop")) {
    return;
  }
  try {
    await hookRunner.runGatewayStop(params.event, params.ctx);
  } catch (err) {
    if (params.onError) {
      params.onError(err);
      return;
    }
    log.warn(`gateway_stop hook failed: ${String(err)}`);
  }
}

/**
 * Reset the global hook runner (for testing).
 */
export function resetGlobalHookRunner(): void {
  const state = getState();
  state.hookRunner = null;
  state.registry = null;
}
