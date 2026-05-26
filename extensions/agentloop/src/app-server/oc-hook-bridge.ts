import {
  runAgentHarnessAfterToolCallHook,
  getGlobalHookRunner,
} from "openclaw/plugin-sdk/agent-harness-runtime";

/**
 * OC Hook Bridge — bridges cosight-code engine events to OpenClaw plugin hooks.
 * Defined in agentloop, invoked at the Loop layer via SDKHooks conversion.
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

type ToolUseBlockExtra = { name: string; id: string; input?: Record<string, unknown> };
type ToolResultItem = { toolUseId: string; content: unknown; isError: boolean };

/**
 * Convert OcHookBridge callbacks to cosight-code SDKHooks format.
 *
 * Shared by both Transport path (ClaudeSdkLoop → InProcessTransportOptions.hooks)
 * and DEI path (buildLoopOptions → session-runtime → SourceSDKClient).
 *
 * Runtime invocation comes from HookRegistry.trigger() which passes HookInput:
 *   { loopId, loopType, sessionId, messages, context, extra }
 *
 * Hooks are BATCH-level (once per turn). The extra field carries:
 *   before_tool_call:  { toolUseBlocks: [{ name, id, input }] }
 *   after_tool_call:   { toolUseBlocks: [{ name, id, input }], toolResultsCount, toolResults }
 */
export function buildSdkHooks(bridge: OcHookBridge): Record<string, unknown> {
  const hooks: Record<string, unknown> = {};

  if (bridge.onPreToolUse) {
    hooks.beforeToolCall = async (rawInput: unknown) => {
      const input = rawInput as Record<string, unknown>;
      const extra = input.extra as Record<string, unknown> | undefined;
      const toolUseBlocks =
        (extra?.toolUseBlocks as ToolUseBlockExtra[] | undefined) ?? [];

      for (const block of toolUseBlocks) {
        const result = await bridge.onPreToolUse!({
          toolName: block.name,
          toolUseId: block.id,
          arguments: block.input ?? {},
        });
        if (result.blocked) {
          return { continue: false };
        }
      }
      return { continue: true };
    };
  }

  if (bridge.onPostToolUse) {
    hooks.afterToolCall = async (rawInput: unknown) => {
      const input = rawInput as Record<string, unknown>;
      const extra = input.extra as Record<string, unknown> | undefined;
      const toolUseBlocks =
        (extra?.toolUseBlocks as ToolUseBlockExtra[] | undefined) ?? [];
      const toolResults =
        (extra?.toolResults as ToolResultItem[] | undefined) ?? [];
      const resultsById = new Map(toolResults.map(r => [r.toolUseId, r]));

      for (const block of toolUseBlocks) {
        const matched = resultsById.get(block.id);
        await bridge.onPostToolUse!({
          toolName: block.name,
          toolUseId: block.id,
          arguments: block.input ?? {},
          result: matched?.content,
          error: matched?.isError ? String(matched.content) : undefined,
        });
      }
      return { continue: true };
    };
  }

  return hooks;
}
