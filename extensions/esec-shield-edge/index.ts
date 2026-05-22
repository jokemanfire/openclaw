/**
 * esec-shield Plugin Entry
 *
 * Architecture: Plugin (TypeScript) + Daemon (Go) via stdin/stdout JSON-RPC 2.0
 *
 * Flow:
 * 1. gateway_start: spawn daemon process, establish IPC connection
 * 2. init: daemon → plugin, get runtime + pluginConfig + deviceInfo
 * 3. register: daemon → plugin, subscribe hooks, negotiate version
 * 4. hook events: plugin → daemon, runtime hook invocations (loop)
 * 5. gateway_stop: shutdown daemon, cleanup
 *
 * Key design:
 * - KeyedAsyncQueue: ensures same sessionKey hooks execute in order (before_agent_reply → before_prompt_build)
 * - Singleton manager: global symbol key prevents multiple daemon spawns
 * - Void hooks: fire-and-forget, errors logged but not thrown
 * - Result hooks: return modified result or fallback, errors logged and fallback returned
 */
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import { definePluginEntry, KeyedAsyncQueue } from "openclaw/plugin-sdk/core";
import { DaemonManager } from "./src/daemon-manager.js";
import { filterEvent } from "./src/event-filter.js";
import { fallbackHookResult } from "./src/rpc-protocol.js"
import type { HookName, BeforeToolCallOnResolutionResult, BeforeToolCallResult } from "./src/rpc-protocol.js";
import { createPermissionsGetHandler, createPermissionsUpdateHandler } from "./src/permission-control.js";

const PLUGIN_ID = "esec-shield-edge";
const PLUGIN_NAME = "eSEC-Shield-Edge";

// Global singleton key - prevents multiple daemon spawns across plugin reloads
const MANAGER_KEY = Symbol.for("openclaw.plugin.esec-shield-edge.manager");

const esecShieldEdgePlugin = {
  id: PLUGIN_ID,
  name: PLUGIN_NAME,
  description: "esec终端安全检测插件",

  register(api: OpenClawPluginApi) {
    // Singleton pattern: reuse existing manager if already spawned
    const store = globalThis as Record<symbol, DaemonManager | undefined>;
    let manager = store[MANAGER_KEY];
    if (!manager) {
      // Use __dirname (plugin directory) instead of process.cwd() (gateway working directory)
      const pluginRoot = api.rootDir ?? __dirname;
      manager = new DaemonManager({
        pluginRoot,
        logger: api.logger,
        pluginConfig: api.pluginConfig,
      });
      store[MANAGER_KEY] = manager;
    }

    // Per-session queue: same sessionKey hooks execute sequentially
    // Critical for: before_agent_reply (store original input) → before_prompt_build (check input)
    const queue = new KeyedAsyncQueue();

    // Void hook handler: fire-and-forget, no result returned to OpenClaw
    // Errors logged but swallowed - daemon failure should not crash gateway
    const handleVoidHook = async (hook: HookName, event: unknown, ctx: any): Promise<void> => {
      if (!manager.isHookSubscribed(hook)) return;

      const sessionKey = ctx.sessionKey ?? "default";
      await queue.enqueue(sessionKey, async () => {
        try {
          const filteredEvent = filterEvent(hook, event);
          await manager.request(`hook:${hook}`, { event: filteredEvent, context: ctx });
        } catch (err) {
          api.logger.warn?.(`[esec-shield-edge] hook ${hook} error: ${err instanceof Error ? err.message : String(err)}`);
        }
      });
    };

    // Result hook handler: returns modified result or fallback
    // Errors logged, fallback returned - daemon failure treated as "no modification"
    const handleResultHook = async (hook: HookName, event: unknown, ctx: any): Promise<any> => {
      if (!manager.isHookSubscribed(hook)) {
        return fallbackHookResult(hook);
      }

      const sessionKey = ctx.sessionKey ?? "default";
      return queue.enqueue(sessionKey, async () => {
        try {
          const filteredEvent = filterEvent(hook, event);
          return await manager.request(`hook:${hook}`, { event: filteredEvent, context: ctx });
        } catch (err) {
          api.logger.warn?.(`[esec-shield-edge] hook ${hook} error: ${err instanceof Error ? err.message : String(err)}`);
          return fallbackHookResult(hook);
        }
      });
    };

    // Lifecycle hooks: spawn daemon on gateway start, cleanup on gateway stop
    api.on("gateway_start", (_event, _ctx) => manager.start());
    api.on("gateway_stop", async (_event, _ctx) => {
      await manager.shutdown();
      const store = globalThis as Record<symbol, DaemonManager | undefined>;
      delete store[MANAGER_KEY];
    });

    // Void hooks: parallel execution in OpenClaw, sequential per-sessionKey in plugin
    api.on("session_start", (event, ctx) => handleVoidHook("session_start", event, ctx));
    api.on("session_end", (event, ctx) => handleVoidHook("session_end", event, ctx));
    api.on("agent_end", (event, ctx) => handleVoidHook("agent_end", event, ctx));
    api.on("llm_input", (event, ctx) => handleVoidHook("llm_input", event, ctx));
    api.on("llm_output", (event, ctx) => handleVoidHook("llm_output", event, ctx));

    // Result hooks: sequential in OpenClaw, sequential per-sessionKey in plugin
    api.on("before_agent_reply", (event, ctx) => handleResultHook("before_agent_reply", event, ctx));
    api.on("before_prompt_build", (event, ctx) => handleResultHook("before_prompt_build", event, ctx));
    api.on("before_tool_call", async (event, ctx) => {
      const daemonResult = await handleResultHook("before_tool_call", event, ctx) as BeforeToolCallResult;
      if (!daemonResult?.requireApproval) return daemonResult;
      // Build the final BeforeToolCallResult from daemon response.
      // Daemon returns requireApproval metadata (without onResolution function).
      // Plugin injects onResolution callback that notifies daemon before completing.
      return {
        ...daemonResult,
        requireApproval: {
          ...daemonResult.requireApproval,
          onResolution: async (decision) => {
            const params: BeforeToolCallOnResolutionResult = {
              context: {
                agentId: ctx.agentId,
                sessionKey: ctx.sessionKey,
                sessionId: ctx.sessionId,
                runId: ctx.runId,
                toolName: ctx.toolName,
                toolCallId: ctx.toolCallId,
              },
              decision,
            }
            manager.notify("func:on_resolution", params);
          },
        },
      };
    });
    api.on("message_sending", (event, ctx) => handleResultHook("message_sending", event, ctx));

    // Gateway methods: expose permissions management to UI
    api.registerGatewayMethod(
      "esecShieldEdge.permissions.get",
      createPermissionsGetHandler(api.logger)
    );

    api.registerGatewayMethod(
      "esecShieldEdge.permissions.update",
      createPermissionsUpdateHandler(api.logger)
    );
  },
};

export default definePluginEntry(esecShieldEdgePlugin);
