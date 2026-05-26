import type { UnifiedTool, ToolBridgeHandle } from "@zte/agentloop-sdk/sdk";
import { createOpenClawCodingTools } from "openclaw/plugin-sdk/agent-harness";
import {
  embeddedAgentLog,
  supportsModelTools,
  AgentHarnessAttemptParams,
  createAgentToolResultMiddlewareRunner,
  emitAgentEvent,
  appendSessionTranscriptMessage,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import type { AnyAgentTool } from "openclaw/plugin-sdk/agent-harness-runtime";
import { applyDynamicToolProfile } from "./dynamic-tool-profile.js";

type ContentItem = { type: string; text?: string };

type ToolBridgeBaseParams = AgentHarnessAttemptParams & {
  pluginConfig?: Record<string, unknown>;
  toolTimeoutMs?: number;
  signal?: AbortSignal;
};

type ToolBridgeDefinitionParams = ToolBridgeBaseParams;

type ToolBridgeHandleParams = ToolBridgeBaseParams & {
  agentId: string;
  signal: AbortSignal;
};

export async function buildToolDefinitions(
  params: ToolBridgeDefinitionParams,
): Promise<UnifiedTool[]> {
  if (params.disableTools || !supportsModelTools(params.model)) {
    return [];
  }

  const allTools = createOpenClawCodingTools({
    agentId: params.agentId ?? "",
    sessionKey: params.sessionKey ?? params.sessionId ?? "",
    sessionId: params.sessionId ?? "",
    runId: params.runId ?? "",
    config: params.config,
    agentDir: params.agentDir ?? params.workspaceDir ?? "",
    workspaceDir: params.workspaceDir ?? "",
    modelProvider: params.provider,
    modelId: params.modelId,
    modelApi: typeof params.model?.api === "string" ? params.model.api : undefined,
    modelContextWindowTokens:
      typeof params.model?.contextWindow === "number" ? params.model.contextWindow : undefined,
    messageProvider: params.messageChannel ?? params.messageProvider,
    messageTo: params.messageTo,
    messageThreadId: params.messageThreadId,
    groupId: params.groupId,
    groupChannel: params.groupChannel,
    groupSpace: params.groupSpace,
    spawnedBy: params.spawnedBy,
    senderId: params.senderId,
    senderName: params.senderName,
    senderUsername: params.senderUsername,
    senderE164: params.senderE164,
    senderIsOwner: params.senderIsOwner,
    currentChannelId: params.currentChannelId,
    currentThreadTs: params.currentThreadTs,
    currentMessageId: params.currentMessageId,
    abortSignal: params.signal,
    exec: params.execOverrides,
    sandbox: params.sandbox,
    agentAccountId: params.agentAccountId,
    allowGatewaySubagentBinding: params.allowGatewaySubagentBinding,
    replyToMode: params.replyToMode,
    hasRepliedRef: params.hasRepliedRef,
    requireExplicitMessageTarget: params.requireExplicitMessageTarget,
    disableMessageTool: params.disableMessageTool,
  });

  const toolTimeoutMs = params.toolTimeoutMs ?? 30000;
  const profiled = applyDynamicToolProfile(allTools as AnyAgentTool[], {
    toolTimeoutMs,
  });

  embeddedAgentLog.debug(
    `[agentloop] built tools total=${allTools.length} profiled=${profiled.length}`,
  );

  const hookContext = {
    agentId: params.agentId ?? "",
    sessionId: params.sessionId ?? "",
    sessionKey: params.sessionKey ?? params.sessionId ?? "",
    runId: params.runId ?? "",
  };

  const middlewareRunner = createAgentToolResultMiddlewareRunner({
    runtime: "agentloop",
    ...hookContext,
  });

  const sessionSignal = params.signal as AbortSignal | undefined;
  return profiled.map((tool) =>
    toUnifiedTool(tool, toolTimeoutMs, sessionSignal, middlewareRunner),
  );
}

function toUnifiedTool(
  tool: AnyAgentTool,
  toolTimeoutMs: number,
  sessionSignal?: AbortSignal,
  middlewareRunner?: ReturnType<typeof createAgentToolResultMiddlewareRunner>,
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
        if (middlewareRunner) {
          const middlewareResult = await middlewareRunner.applyToolResultMiddleware({
            threadId: "",
            turnId: "",
            toolCallId: callId,
            toolName: tool.name,
            args: preparedArgs,
            result,
          });
          console.log("[tool-bridge] middleware result:", JSON.stringify(middlewareResult));
          return middlewareResult;
        }
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
  params: ToolBridgeHandleParams,
): Promise<ToolBridgeHandle | undefined> {
  if (params.disableTools || !supportsModelTools(params.model)) {
    return undefined;
  }

  const allTools = createOpenClawCodingTools({
    agentId: params.agentId ?? "",
    sessionKey: params.sessionKey ?? params.sessionId ?? "",
    sessionId: params.sessionId ?? "",
    runId: params.runId ?? "",
    config: params.config,
    agentDir: params.agentDir ?? params.workspaceDir ?? "",
    workspaceDir: params.workspaceDir ?? "",
    modelProvider: params.provider,
    modelId: params.modelId,
    modelApi: typeof params.model?.api === "string" ? params.model.api : undefined,
    modelContextWindowTokens:
      typeof params.model?.contextWindow === "number" ? params.model.contextWindow : undefined,
    messageProvider: params.messageChannel ?? params.messageProvider,
    messageTo: params.messageTo,
    messageThreadId: params.messageThreadId,
    groupId: params.groupId,
    groupChannel: params.groupChannel,
    groupSpace: params.groupSpace,
    spawnedBy: params.spawnedBy,
    senderId: params.senderId,
    senderName: params.senderName,
    senderUsername: params.senderUsername,
    senderE164: params.senderE164,
    senderIsOwner: params.senderIsOwner,
    currentChannelId: params.currentChannelId,
    currentThreadTs: params.currentThreadTs,
    currentMessageId: params.currentMessageId,
    abortSignal: params.signal,
    exec: params.execOverrides,
    sandbox: params.sandbox,
    agentAccountId: params.agentAccountId,
    allowGatewaySubagentBinding: params.allowGatewaySubagentBinding,
    replyToMode: params.replyToMode,
    hasRepliedRef: params.hasRepliedRef,
    requireExplicitMessageTarget: params.requireExplicitMessageTarget,
    disableMessageTool: params.disableMessageTool,
  });

  const toolTimeoutMs = params.toolTimeoutMs ?? 30000;
  const profiled = applyDynamicToolProfile(allTools as AnyAgentTool[], {
    toolTimeoutMs,
  });

  if (profiled.length === 0) return undefined;

  const hookContext = {
    agentId: params.agentId,
    sessionId: params.sessionId,
    sessionKey: params.sessionKey ?? params.sessionId,
    runId: params.runId,
  };

  const tools = profiled;

  const toolMap = new Map(tools.map((tool) => [tool.name, tool]));
  const middlewareRunner = createAgentToolResultMiddlewareRunner({
    runtime: "agentloop",
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
          cwd: params.workspaceDir,
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
            cwd: params.workspaceDir,
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
            cwd: params.workspaceDir,
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

export function sanitizeToolArgs(args: unknown): Record<string, unknown> | unknown {
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

function extractTextContentItems(result: unknown): ContentItem[] {
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
