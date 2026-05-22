import type { SubscribeEmbeddedPiSessionParams } from "../../pi-embedded-subscribe.types.js";
import { log } from "../logger.js";

type IdleAwareAgent = {
  waitForIdle?: (() => Promise<void>) | undefined;
  reset?: (() => void) | undefined;
  beforeToolCall?: unknown;
  afterToolCall?: unknown;
};

type ToolResultFlushManager = {
  flushPendingToolResults?: (() => void) | undefined;
  clearPendingToolResults?: (() => void) | undefined;
};
export function buildEmbeddedSubscriptionParams(
  params: SubscribeEmbeddedPiSessionParams,
): SubscribeEmbeddedPiSessionParams {
  return params;
}

export async function cleanupEmbeddedAttemptResources(params: {
  removeToolResultContextGuard?: () => void;
  flushPendingToolResultsAfterIdle: (params: {
    agent: IdleAwareAgent | null | undefined;
    sessionManager: ToolResultFlushManager | null | undefined;
    timeoutMs?: number;
    clearPendingOnTimeout?: boolean;
  }) => Promise<void>;
  session?: { agent?: unknown; dispose(): void };
  sessionManager: unknown;
  releaseWsSession: (sessionId: string, options?: { allowPool?: boolean }) => void;
  allowWsSessionPool?: boolean;
  sessionId: string;
  bundleMcpRuntime?: { dispose(): Promise<void> | void };
  bundleLspRuntime?: { dispose(): Promise<void> | void };
  sessionLock: { release(): Promise<void> | void };
}): Promise<void> {
  try {
    try {
      params.removeToolResultContextGuard?.();
    } catch {
      /* best-effort */
    }
    try {
      await params.flushPendingToolResultsAfterIdle({
        agent: params.session?.agent as IdleAwareAgent | null | undefined,
        sessionManager: params.sessionManager as ToolResultFlushManager | null | undefined,
        clearPendingOnTimeout: true,
      });
    } catch {
      /* best-effort */
    }
    try {
      if (params.session) {
        params.session.dispose();

        const sessionRecord = params.session as Record<string, unknown>;
        if (sessionRecord.agent) {
          const agent = sessionRecord.agent as IdleAwareAgent;
          if (typeof agent.reset === "function") {
            agent.reset();
          }
          agent.beforeToolCall = undefined;
          agent.afterToolCall = undefined;
        }

        const heavyFields: readonly string[] = [
          "_resourceLoader",
          "_toolRegistry",
          "_toolDefinitions",
          "_toolPromptSnippets",
          "_toolPromptGuidelines",
          "_baseToolDefinitions",
          "_extensionRunner",
          "_baseSystemPrompt",
          "_baseSystemPromptOptions",
          "_customTools",
          "_pendingNextTurnMessages",
          "_pendingBashMessages",
          "_scopedModels",
        ];
        for (const field of heavyFields) {
          if (field in sessionRecord) {
            sessionRecord[field] = null;
          }
        }
      }
    } catch (error) {
      log.warn("cleanup: failed to deep dispose session", {
        sessionId: params.sessionId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    try {
      params.releaseWsSession(params.sessionId, { allowPool: params.allowWsSessionPool === true });
    } catch {
      /* best-effort */
    }
    try {
      await params.bundleMcpRuntime?.dispose();
    } catch {
      /* best-effort */
    }
    try {
      await params.bundleLspRuntime?.dispose();
    } catch {
      /* best-effort */
    }
  } finally {
    await params.sessionLock.release();
  }
}
