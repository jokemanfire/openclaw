import { embeddedAgentLog } from "openclaw/plugin-sdk/agent-harness-runtime";
import { getGlobalHookRunner } from "openclaw/plugin-sdk/agent-harness-runtime";
import type {
  AgentHarness,
  AgentHarnessAttemptParams,
  AgentHarnessAttemptResult,
  AgentHarnessSupportContext,
  AgentHarnessSupport,
  AgentHarnessCompactParams,
  AgentHarnessCompactResult,
  AgentHarnessResetParams,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import { createAppLoader } from "./src/app-server/app-loader.js";
import type { AgentLoopPluginConfig } from "./src/app-server/config.js";
import { loadAppManifests, type LoopRegistry } from "./src/app-server/loop-registry.js";
import {
  prepareAgentLoopAttempt,
  startAgentLoopAttempt,
  sendAgentLoopAttempt,
  resolveAgentLoopOutcome,
  cleanupAgentLoopAttempt,
  type AgentLoopPreparedRun,
  type AgentLoopSession,
} from "./src/app-server/run-lifecycle.js";

export type AgentLoopHarnessOptions = {
  pluginConfig?: AgentLoopPluginConfig;
  pluginRootDir?: string;
};

export function createAgentLoopHarness(options?: AgentLoopHarnessOptions): AgentHarness & {
  init(): Promise<LoopRegistry>;
  prepare: (params: AgentHarnessAttemptParams) => Promise<AgentLoopPreparedRun>;
  start: (prepared: AgentLoopPreparedRun) => Promise<AgentLoopSession>;
  send: (
    session: AgentLoopSession,
    opts?: { loopRegistry?: LoopRegistry },
  ) => Promise<AgentHarnessAttemptResult>;
  resolveOutcome: (
    session: AgentLoopSession,
    result: AgentHarnessAttemptResult,
  ) => Promise<AgentHarnessAttemptResult>;
  cleanup: (params: {
    prepared?: AgentLoopPreparedRun;
    session?: AgentLoopSession;
    result?: AgentHarnessAttemptResult;
    error?: unknown;
  }) => Promise<void>;
} {
  let loopRegistryPromise: Promise<LoopRegistry> | undefined;
  let appsLoadPromise: Promise<void> | undefined;

  const MAX_PARAMS_CACHE_SIZE = 20;
  const paramsLoopRegistryCache = new Map<string, Promise<LoopRegistry>>();

  function evictParamsCacheLRU(): void {
    if (paramsLoopRegistryCache.size >= MAX_PARAMS_CACHE_SIZE) {
      const firstKey = paramsLoopRegistryCache.keys().next().value;
      if (firstKey !== undefined) {
        paramsLoopRegistryCache.delete(firstKey);
      }
    }
  }

  function getLoopRegistry(params?: AgentHarnessAttemptParams): Promise<LoopRegistry> {
    if (params) {
      const key = params.sessionKey ?? params.sessionId ?? "_";
      if (!paramsLoopRegistryCache.has(key)) {
        evictParamsCacheLRU();
        paramsLoopRegistryCache.set(key, loadAppManifests(options?.pluginRootDir!, params));
      }
      return paramsLoopRegistryCache.get(key)!;
    }
    if (!loopRegistryPromise) {
      loopRegistryPromise = loadAppManifests(options?.pluginRootDir!);
    }
    return loopRegistryPromise;
  }

  async function ensureAppsLoaded(params?: AgentHarnessAttemptParams): Promise<LoopRegistry> {
    if (appsLoadPromise) {
      await appsLoadPromise;
      return getLoopRegistry(params);
    }

    let capturedRegistry: LoopRegistry;
    appsLoadPromise = (async () => {
      capturedRegistry = await getLoopRegistry(params);
      const appLoader = createAppLoader();
      const apps = capturedRegistry.listApps();
      embeddedAgentLog.info(`[agentloop] registry.listApps() apps=${JSON.stringify(apps)}`);
      for (const appName of capturedRegistry.listApps()) {
        const manifest = capturedRegistry.getApp(appName);
        if (!manifest) continue;
        await appLoader.loadApp(manifest.sourcePath, appName);
        embeddedAgentLog.info(
          `[agentloop] app loaded appName=${appName} sourcePath=${manifest.sourcePath}`,
        );
      }

      embeddedAgentLog.info(
        `[agentloop] all apps loaded apps=${JSON.stringify(capturedRegistry.listApps())}`,
      );
    })();

    await appsLoadPromise;
    return capturedRegistry!;
  }

  return {
    id: "agentloop",
    label: "AgentLoop harness",
    deliveryDefaults: { sourceVisibleReplies: "message_tool" },

    async init(): Promise<LoopRegistry> {
      const sdk = await import("@zte/agentloop-sdk/sdk");
      const sdkLog = embeddedAgentLog.child("agentloop-sdk");
      if (typeof (sdk as Record<string, unknown>).setSdkLogger === "function") {
        (
          (sdk as Record<string, unknown>).setSdkLogger as (logger: {
            debug: (msg: string) => void;
            info: (msg: string) => void;
            warn: (msg: string) => void;
            error: (msg: string) => void;
          }) => void
        )({
          debug: (msg: string) => sdkLog.debug(msg),
          info: (msg: string) => sdkLog.info(msg),
          warn: (msg: string) => sdkLog.warn(msg),
          error: (msg: string) => sdkLog.error(msg),
        });
      }
      return getLoopRegistry();
    },

    supports(_ctx: AgentHarnessSupportContext): AgentHarnessSupport {
      return { supported: true, priority: 100 };
    },

    async runAttempt(params: AgentHarnessAttemptParams): Promise<AgentHarnessAttemptResult> {
      let prepared: AgentLoopPreparedRun | undefined;
      let session: AgentLoopSession | undefined;
      let rawResult: AgentHarnessAttemptResult | undefined;

      try {
        const loopRegistry = await ensureAppsLoaded(params);

        // P0: before_agent_reply — plugins can return synthetic reply, short-circuiting the agent
        const hookRunner = getGlobalHookRunner();
        if (hookRunner?.hasHooks("before_agent_reply")) {
          const beforeReplyResult = await hookRunner.runBeforeAgentReply(
            { cleanedBody: params.prompt },
            {
              agentId: params.agentId ?? "",
              sessionKey: params.sessionKey,
              sessionId: params.sessionId,
              workspaceDir: params.workspaceDir,
              runId: params.runId,
              trigger: "user",
            },
          );
          if (beforeReplyResult?.handled) {
            return {
              assistantTexts: [beforeReplyResult.reply ?? ""],
              finishReason: "stop",
              itemLifecycle: { started: 1, completed: 1, skipped: 0, aborted: 0 },
            };
          }
        }

        prepared = await this.prepare(params);
        session = await this.start(prepared);
        rawResult = await this.send(session, { loopRegistry });
        return rawResult;
      } catch (error) {
        embeddedAgentLog.warn(
          `[agentloop] runAttempt failed sessionKey=${params.sessionKey} error=${String(error)}`,
        );
        throw error;
      } finally {
        try {
          await this.cleanup({ prepared, session, result: rawResult });
        } catch {}
      }
    },

    async compact(
      params: AgentHarnessCompactParams,
    ): Promise<AgentHarnessCompactResult | undefined> {
      const { maybeCompactAgentLoopSession } = await import("./src/app-server/compact.js");
      return maybeCompactAgentLoopSession(params, {
        loopRegistry: await getLoopRegistry(),
        pluginConfig: options?.pluginConfig,
      });
    },

    async reset(params: AgentHarnessResetParams): Promise<void> {
      if (params.sessionFile) {
        const { clearAgentLoopBinding } = await import("./src/app-server/session-binding.js");
        await clearAgentLoopBinding(params.sessionFile);
      }
    },

    async dispose(): Promise<void> {
      appsLoadPromise = undefined;
      loopRegistryPromise = undefined;
    },

    async prepare(params: AgentHarnessAttemptParams): Promise<AgentLoopPreparedRun> {
      return prepareAgentLoopAttempt(params, {
        loopRegistry: await getLoopRegistry(params),
        pluginConfig: options?.pluginConfig,
      });
    },

    async start(prepared: AgentLoopPreparedRun): Promise<AgentLoopSession> {
      return startAgentLoopAttempt(prepared);
    },

    async send(
      session: AgentLoopSession,
      opts?: { loopRegistry?: LoopRegistry },
    ): Promise<AgentHarnessAttemptResult> {
      return sendAgentLoopAttempt(session, {
        loopRegistry: opts?.loopRegistry,
        pluginConfig: options?.pluginConfig,
      });
    },

    async resolveOutcome(
      session: AgentLoopSession,
      result: AgentHarnessAttemptResult,
    ): Promise<AgentHarnessAttemptResult> {
      return resolveAgentLoopOutcome(session, result);
    },

    async cleanup(params: {
      prepared?: AgentLoopPreparedRun;
      session?: AgentLoopSession;
      result?: AgentHarnessAttemptResult;
      error?: unknown;
    }): Promise<void> {
      return cleanupAgentLoopAttempt(params);
    },
  };
}
