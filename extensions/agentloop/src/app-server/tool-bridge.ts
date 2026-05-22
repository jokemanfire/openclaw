import type { UnifiedTool, ToolBridgeHandle } from "@zte/agentloop-sdk/sdk";
import { createOpenClawCodingTools } from "openclaw/plugin-sdk/agent-harness";
import {
  embeddedAgentLog,
  supportsModelTools,
  AgentHarnessAttemptParams,
  createAgentToolResultMiddlewareRunner,
  emitAgentEvent,
  appendSessionTranscriptMessage,
  isToolWrappedWithBeforeToolCallHook,
  runAgentHarnessAfterToolCallHook,
  wrapToolWithBeforeToolCallHook,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import type { AnyAgentTool } from "openclaw/plugin-sdk/agent-harness-runtime";
import { applyDynamicToolProfile } from "./dynamic-tool-profile.js";

export async function buildToolDefinitions(
  params: AgentHarnessAttemptParams & {
    pluginConfig?: Record<string, unknown>;
    toolTimeoutMs?: number;
  },
): Promise<UnifiedTool[]> {
  const p = params as Record<string, unknown>;

  if (p.disableTools || !supportsModelTools(p.model)) {
    return [];
  }

  const allTools = createOpenClawCodingTools({
    agentId: (p.agentId as string) ?? "",
    sessionKey: (p.sessionKey as string) ?? (p.sessionId as string) ?? "",
    sessionId: (p.sessionId as string) ?? "",
    runId: (p.runId as string) ?? "",
    config: p.config,
    agentDir: (p.agentDir as string) ?? (p.workspaceDir as string) ?? "",
    workspaceDir: (p.workspaceDir as string) ?? "",
    modelProvider: p.provider as string,
    modelId: p.modelId as string,
    modelApi:
      typeof (p.model as Record<string, unknown>)?.api === "string"
        ? ((p.model as Record<string, unknown>).api as string)
        : undefined,
    modelContextWindowTokens:
      typeof (p.model as Record<string, unknown>)?.contextWindow === "number"
        ? ((p.model as Record<string, unknown>).contextWindow as number)
        : undefined,
    messageProvider: (p.messageChannel as string) ?? (p.messageProvider as string),
    messageTo: p.messageTo as string,
    messageThreadId: p.messageThreadId as string | number,
    groupId: p.groupId as string | null,
    groupChannel: p.groupChannel as string | null,
    groupSpace: p.groupSpace as string | null,
    spawnedBy: p.spawnedBy as string | null,
    senderId: p.senderId as string | null,
    senderName: p.senderName as string | null,
    senderUsername: p.senderUsername as string | null,
    senderE164: p.senderE164 as string | null,
    senderIsOwner: p.senderIsOwner as boolean,
    currentChannelId: p.currentChannelId as string,
    currentThreadTs: p.currentThreadTs as string,
    currentMessageId: p.currentMessageId as string | number,
    abortSignal: p.signal as AbortSignal,
    exec: p.execOverrides,
    sandbox: p.sandbox,
    agentAccountId: p.agentAccountId as string,
    allowGatewaySubagentBinding: p.allowGatewaySubagentBinding as boolean,
    replyToMode: p.replyToMode as string,
    hasRepliedRef: p.hasRepliedRef,
    requireExplicitMessageTarget: p.requireExplicitMessageTarget as boolean,
    disableMessageTool: p.disableMessageTool as boolean,
  });

  const toolTimeoutMs = params.toolTimeoutMs ?? 30000;
  const profiled = applyDynamicToolProfile(allTools as unknown as AnyAgentTool[], {
    toolTimeoutMs,
  });

  embeddedAgentLog.debug(
    `[agentloop] built tools total=${allTools.length} profiled=${profiled.length}`,
  );

  const sessionSignal = params.signal as AbortSignal | undefined;
  return profiled.map((tool) => toUnifiedTool(tool, toolTimeoutMs, sessionSignal));
}

function toUnifiedTool(
  tool: AnyAgentTool,
  toolTimeoutMs: number,
  sessionSignal?: AbortSignal,
): UnifiedTool {
  return {
    name: tool.name,
    description: tool.description,
    parameters: (tool.parameters as Record<string, unknown>) ?? {},
    execute: async (args: Record<string, unknown>) => {
      console.log("[tool-bridge] calling tool:", tool.name, "args:", JSON.stringify(args));
      const callId = `call_${Date.now()}_${Math.random().toString(36).slice(2)}`;
      const { signal, clear } = createToolAbortSignal(toolTimeoutMs, sessionSignal, tool.name);
      const preparedArgs =
        tool.prepareArguments?.(args) ?? (args === null || args === undefined ? {} : args);
      try {
        const result = await tool.execute(callId, preparedArgs, signal);
        console.log("[tool-bridge] result:", JSON.stringify(result));
        return result;
      } catch (error) {
        if (signal.aborted) {
          embeddedAgentLog.warn(`[agentloop] tool "${tool.name}" aborted (callId=${callId})`);
        }
        throw error;
      } finally {
        clear();
      }
    },
  } as UnifiedTool;
}

export async function buildToolBridgeHandle(
  params: AgentHarnessAttemptParams & {
    pluginConfig?: Record<string, unknown>;
    agentId: string;
    signal: AbortSignal;
    toolTimeoutMs?: number;
  },
): Promise<ToolBridgeHandle | undefined> {
  const p = params as Record<string, unknown>;

  if (p.disableTools || !supportsModelTools(p.model)) {
    return undefined;
  }

  const allTools = createOpenClawCodingTools({
    agentId: (p.agentId as string) ?? "",
    sessionKey: (p.sessionKey as string) ?? (p.sessionId as string) ?? "",
    sessionId: (p.sessionId as string) ?? "",
    runId: (p.runId as string) ?? "",
    config: p.config,
    agentDir: (p.agentDir as string) ?? (p.workspaceDir as string) ?? "",
    workspaceDir: (p.workspaceDir as string) ?? "",
    modelProvider: p.provider as string,
    modelId: p.modelId as string,
    modelApi:
      typeof (p.model as Record<string, unknown>)?.api === "string"
        ? ((p.model as Record<string, unknown>).api as string)
        : undefined,
    modelContextWindowTokens:
      typeof (p.model as Record<string, unknown>)?.contextWindow === "number"
        ? ((p.model as Record<string, unknown>).contextWindow as number)
        : undefined,
    messageProvider: (p.messageChannel as string) ?? (p.messageProvider as string),
    messageTo: p.messageTo as string,
    messageThreadId: p.messageThreadId as string | number,
    groupId: p.groupId as string | null,
    groupChannel: p.groupChannel as string | null,
    groupSpace: p.groupSpace as string | null,
    spawnedBy: p.spawnedBy as string | null,
    senderId: p.senderId as string | null,
    senderName: p.senderName as string | null,
    senderUsername: p.senderUsername as string | null,
    senderE164: p.senderE164 as string | null,
    senderIsOwner: p.senderIsOwner as boolean,
    currentChannelId: p.currentChannelId as string,
    currentThreadTs: p.currentThreadTs as string,
    currentMessageId: p.currentMessageId as string | number,
    abortSignal: params.signal,
    exec: p.execOverrides,
    sandbox: p.sandbox,
    agentAccountId: p.agentAccountId as string,
    allowGatewaySubagentBinding: p.allowGatewaySubagentBinding as boolean,
    replyToMode: p.replyToMode as string,
    hasRepliedRef: p.hasRepliedRef,
    requireExplicitMessageTarget: p.requireExplicitMessageTarget as boolean,
    disableMessageTool: p.disableMessageTool as boolean,
  });

  const toolTimeoutMs = params.toolTimeoutMs ?? 30000;
  const profiled = applyDynamicToolProfile(allTools as unknown as AnyAgentTool[], {
    toolTimeoutMs,
  });

  if (profiled.length === 0) return undefined;

  const hookContext = {
    agentId: params.agentId,
    sessionId: params.sessionId,
    sessionKey: params.sessionKey ?? params.sessionId,
    runId: params.runId,
  };

  const tools = profiled.map((tool) =>
    isToolWrappedWithBeforeToolCallHook(tool)
      ? tool
      : wrapToolWithBeforeToolCallHook(tool, hookContext),
  );

  const toolMap = new Map(tools.map((tool) => [tool.name, tool]));
  const middlewareRunner = createAgentToolResultMiddlewareRunner({
    runtime: "pi",
    ...hookContext,
  });

  return {
    handleToolCall: async (call) => {
      const tool = toolMap.get(call.toolName);
      if (!tool) {
        return {
          contentItems: [{ type: "text", text: `Unknown tool: ${call.toolName}` }],
          success: false,
        };
      }

      const args = call.arguments;
      const startedAt = Date.now();
      const toolCallId = call.callId;
      embeddedAgentLog.debug(
        `[tool-bridge] starting to call tool, callId: ${toolCallId}, args: ${JSON.stringify(args)}`,
      );

      emitAgentEvent({
        runId: hookContext.runId,
        stream: "tool",
        data: {
          phase: "start",
          name: tool.name,
          toolCallId,
          args: sanitizeToolArgs(args),
        },
      });
      emitAgentEvent({
        runId: hookContext.runId,
        stream: "item",
        data: {
          itemId: `tool:${toolCallId}`,
          phase: "start",
          kind: "tool",
          title: tool.name,
          status: "running",
          name: tool.name,
          toolCallId,
          startedAt,
        },
      });

      if (params.sessionFile) {
        await appendSessionTranscriptMessage({
          transcriptPath: params.sessionFile,
          message: {
            role: "assistant",
            toolCallId,
            content: [
              { type: "toolcall", name: tool.name, arguments: sanitizeToolArgs(args) ?? {} },
            ],
            timestamp: Date.now(),
          },
          sessionId: params.sessionId,
          cwd: (params as Record<string, unknown>).workspaceDir as string | undefined,
        }).catch((err) =>
          embeddedAgentLog.warn(`[agentloop] failed to append tool-call transcript: ${err}`),
        );
      }

      try {
        const preparedArgs = tool.prepareArguments ? tool.prepareArguments(args) : args;
        const { signal: toolSignal, clear: clearToolTimeout } = createToolAbortSignal(
          toolTimeoutMs,
          params.signal,
          tool.name,
        );
        let rawResult: unknown;
        try {
          rawResult = await tool.execute(toolCallId, preparedArgs, toolSignal);
        } catch (execError) {
          if (toolSignal.aborted) {
            embeddedAgentLog.warn(
              `[agentloop] tool "${tool.name}" aborted during execution (toolCallId=${toolCallId})`,
            );
          }
          throw execError;
        } finally {
          clearToolTimeout();
        }

        const wasAborted = toolSignal.aborted;
        const middlewareResult = await middlewareRunner.applyToolResultMiddleware({
          threadId: "",
          turnId: "",
          toolCallId,
          toolName: tool.name,
          args,
          isError: wasAborted,
          result: rawResult,
        });

        void runAgentHarnessAfterToolCallHook({
          toolName: tool.name,
          toolCallId,
          runId: hookContext.runId,
          agentId: hookContext.agentId,
          sessionId: hookContext.sessionId,
          sessionKey: hookContext.sessionKey,
          startArgs: args,
          result: middlewareResult,
          startedAt,
        });

        const resultText = extractTextContentItems(middlewareResult)
          .map((i) => i.text)
          .filter((t): t is string => t != null)
          .join("\n");

        if (params.sessionFile && resultText) {
          await appendSessionTranscriptMessage({
            transcriptPath: params.sessionFile,
            message: {
              role: "toolResult",
              toolCallId,
              toolName: tool.name,
              content: [{ type: "text", text: resultText }],
              timestamp: Date.now(),
            },
            sessionId: params.sessionId,
            cwd: (params as Record<string, unknown>).workspaceDir as string | undefined,
          }).catch((err) =>
            embeddedAgentLog.warn(`[agentloop] failed to append tool-result transcript: ${err}`),
          );
        }

        emitAgentEvent({
          runId: hookContext.runId,
          stream: "tool",
          data: {
            phase: "result",
            name: tool.name,
            toolCallId,
            isError: wasAborted,
            result: resultText || rawResult,
          },
        });
        emitAgentEvent({
          runId: hookContext.runId,
          stream: "item",
          data: {
            itemId: `tool:${toolCallId}`,
            phase: "end",
            kind: "tool",
            title: tool.name,
            status: wasAborted ? "failed" : "completed",
            name: tool.name,
            toolCallId,
            startedAt,
            endedAt: Date.now(),
          },
        });

        return {
          contentItems: extractTextContentItems(middlewareResult),
          success: !wasAborted,
        };
      } catch (error) {
        void runAgentHarnessAfterToolCallHook({
          toolName: tool.name,
          toolCallId,
          runId: hookContext.runId,
          agentId: hookContext.agentId,
          sessionId: hookContext.sessionId,
          sessionKey: hookContext.sessionKey,
          startArgs: args,
          error: error instanceof Error ? error.message : String(error),
          startedAt,
        });

        const errorText = error instanceof Error ? error.message : String(error);

        if (params.sessionFile) {
          await appendSessionTranscriptMessage({
            transcriptPath: params.sessionFile,
            message: {
              role: "toolResult",
              toolCallId,
              toolName: tool.name,
              content: [{ type: "text", text: errorText }],
              isError: true,
              timestamp: Date.now(),
            },
            sessionId: params.sessionId,
            cwd: (params as Record<string, unknown>).workspaceDir as string | undefined,
          }).catch((err) =>
            embeddedAgentLog.warn(`[agentloop] failed to append tool-error transcript: ${err}`),
          );
        }

        emitAgentEvent({
          runId: hookContext.runId,
          stream: "tool",
          data: {
            phase: "result",
            name: tool.name,
            toolCallId,
            isError: true,
            result: errorText,
          },
        });
        emitAgentEvent({
          runId: hookContext.runId,
          stream: "item",
          data: {
            itemId: `tool:${toolCallId}`,
            phase: "end",
            kind: "tool",
            title: tool.name,
            status: "failed",
            name: tool.name,
            toolCallId,
            startedAt,
            endedAt: Date.now(),
            error: errorText,
          },
        });

        return {
          contentItems: [
            {
              type: "text",
              text: errorText,
            },
          ],
          success: false,
        };
      }
    },
  };
}

function sanitizeToolArgs(args: unknown): unknown {
  if (!args || typeof args !== "object") {
    return args;
  }
  const record = args as Record<string, unknown>;
  const sensitiveKeys = new Set([
    "apikey",
    "api_key",
    "password",
    "token",
    "secret",
    "auth",
    "authorization",
    "credentials",
  ]);
  const cleaned: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    if (sensitiveKeys.has(key.toLowerCase())) {
      cleaned[key] = "***";
    } else if (typeof value === "object" && value !== null) {
      cleaned[key] = sanitizeToolArgs(value);
    } else {
      cleaned[key] = value;
    }
  }
  return cleaned;
}

function extractTextContentItems(result: unknown): Array<{ type: string; text?: string }> {
  if (!result || typeof result !== "object") {
    return [{ type: "text", text: String(result) }];
  }
  const r = result as Record<string, unknown>;
  const content = r.content;
  if (!Array.isArray(content)) {
    return [{ type: "text", text: JSON.stringify(r) }];
  }
  return content.map((item) => {
    if (item === null || typeof item !== "object") {
      return { type: "text", text: String(item) };
    }
    const obj = item as Record<string, unknown>;
    return {
      type: typeof obj.type === "string" ? obj.type : "text",
      text: obj.text != null ? String(obj.text) : undefined,
    };
  });
}

function createToolAbortSignal(
  toolTimeoutMs: number,
  sessionSignal?: AbortSignal,
  toolName?: string,
): { signal: AbortSignal; clear: () => void } {
  const controller = new AbortController();
  let timeoutId: NodeJS.Timeout | undefined;

  if (Number.isFinite(toolTimeoutMs) && toolTimeoutMs > 0) {
    timeoutId = setTimeout(() => {
      if (toolName) {
        embeddedAgentLog.warn(
          `[agentloop] tool "${toolName}" timed out after ${toolTimeoutMs}ms, aborting`,
        );
      }
      controller.abort();
    }, toolTimeoutMs);
  }

  if (sessionSignal) {
    if (sessionSignal.aborted) {
      if (timeoutId) clearTimeout(timeoutId);
      controller.abort();
    } else {
      const onAbort = () => {
        if (timeoutId) clearTimeout(timeoutId);
        controller.abort();
      };
      sessionSignal.addEventListener("abort", onAbort, { once: true });
    }
  }

  return {
    signal: controller.signal,
    clear: () => {
      if (timeoutId) clearTimeout(timeoutId);
    },
  };
}
