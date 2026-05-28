import {
  runAgentHarnessAfterToolCallHook,
  getGlobalHookRunner,
} from "openclaw/plugin-sdk/agent-harness-runtime";

/**
 * OC Hook Bridge — bridges cosight-code engine events to OpenClaw plugin hooks.
 * Defined in agentloop, invoked at the Loop layer (ClaudeSdkLoop) via SDKHooks conversion.
 * Transport-agnostic: works for both InProcessTransport (Level 2) and DEI (Level 3) modes.
 */
export interface OcHookBridge {
  /** PreToolUse -> OC before_tool_call */
  onPreToolUse?: (event: {
    toolName: string;
    toolUseId: string;
    arguments: Record<string, unknown>;
  }) => Promise<{ blocked: boolean; reason?: string }>;

  /** PostToolUse / PostToolUseFailure -> OC after_tool_call */
  onPostToolUse?: (event: {
    toolName: string;
    toolUseId: string;
    arguments: Record<string, unknown>;
    result?: unknown;
    error?: string;
  }) => Promise<void>;
}

export function createOcHookBridge(ctx: {
  runId: string;
  agentId?: string;
  sessionKey?: string;
  sessionId?: string;
  workspaceDir?: string;
}): OcHookBridge {
  const hookRunner = getGlobalHookRunner();
  const hookCtx = {
    runId: ctx.runId,
    agentId: ctx.agentId,
    sessionKey: ctx.sessionKey,
    sessionId: ctx.sessionId,
    workspaceDir: ctx.workspaceDir,
  };

  return {
    onPreToolUse: async (event) => {
      if (!hookRunner?.hasHooks("before_tool_call")) {
        return { blocked: false };
      }
      const result = await hookRunner.runBeforeToolCall(
        {
          toolName: event.toolName,
          params: event.arguments,
          toolCallId: event.toolUseId,
        },
        {
          toolName: event.toolName,
          toolCallId: event.toolUseId,
          ...hookCtx,
        },
      );
      return {
        blocked: result?.block ?? false,
        reason: result?.blockReason,
      };
    },

    onPostToolUse: async (event) => {
      console.error("[DEBUG oc-hook-bridge] onPostToolUse called", {
        toolName: event.toolName,
        toolUseId: event.toolUseId,
        hasResult: event.result !== undefined,
        hasError: event.error !== undefined,
      });
      await runAgentHarnessAfterToolCallHook({
        toolName: event.toolName,
        toolCallId: event.toolUseId,
        startArgs: event.arguments,
        result: event.result,
        error: event.error,
        runId: ctx.runId,
        agentId: ctx.agentId,
        sessionId: ctx.sessionId,
        sessionKey: ctx.sessionKey,
      });
      console.error("[DEBUG oc-hook-bridge] onPostToolUse completed");
    },
  };
}
