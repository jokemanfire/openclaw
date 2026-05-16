import { embeddedAgentLog } from "openclaw/plugin-sdk/agent-harness-runtime";
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
import { loadAppManifests, type LoopRegistry } from "./src/app-server/loop-registry.js";
import { createAppLoader } from "./src/app-server/app-loader.js";
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
  pluginConfig?: unknown;
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

  function getLoopRegistry(): Promise<LoopRegistry> {
    if (!loopRegistryPromise) {
      loopRegistryPromise = loadAppManifests(options?.pluginRootDir!);
    }
    return loopRegistryPromise;
  }

  async function ensureAppsLoaded(): Promise<LoopRegistry> {
    if (appsLoadPromise) {
      await appsLoadPromise;
      return getLoopRegistry();
    }

    appsLoadPromise = (async () => {
      const registry = await getLoopRegistry();
      const appLoader = createAppLoader();
      const apps = registry.listApps();
      embeddedAgentLog.info(`[agentloop] registry.listApps() apps=${JSON.stringify(apps)}`);
      for (const appName of registry.listApps()) {
        const manifest = registry.getApp(appName);
        if (!manifest) continue;
        await appLoader.loadApp(manifest.sourcePath, appName);
        embeddedAgentLog.info(`[agentloop] app loaded appName=${appName} sourcePath=${manifest.sourcePath}`);
      }

      embeddedAgentLog.info(`[agentloop] all apps loaded apps=${JSON.stringify(registry.listApps())}`);
    })();

    await appsLoadPromise;
    return getLoopRegistry();
  }

  return {
    id: "agentloop",
    label: "AgentLoop harness",
    deliveryDefaults: { sourceVisibleReplies: "message_tool" },

    async init(): Promise<LoopRegistry> {
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
        const loopRegistry = await ensureAppsLoaded();
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
        } catch {
        }
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
        loopRegistry: await getLoopRegistry(),
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
