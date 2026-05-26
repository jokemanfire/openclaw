import path from "node:path";
import type { SDKMessage, PromptInput, LoopResult, ToolBridgeHandle } from "@zte/agentloop-sdk/sdk";
import type { LoopOptions } from "@zte/agentloop-sdk/sdk";
import {
  embeddedAgentLog,
  emitAgentEvent,
  runAgentHarnessLlmInputHook,
  runAgentHarnessLlmOutputHook,
  runAgentHarnessAgentEndHook,
  appendSessionTranscriptMessage,
  runAgentHarnessBeforeAgentFinalizeHook,
  resolveAgentHarnessBeforePromptBuildResult,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import type {
  AgentHarnessV2CleanupParams,
  AgentHarnessAttemptParams,
  AgentHarnessAttemptResult,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import { resolveApiKeyForProvider } from "openclaw/plugin-sdk/provider-auth-runtime";
import { resolveAgentLoopConfig, type AgentLoopLoopType } from "./config.js";
import type { LoopRegistry } from "./loop-registry.js";
import { createOcHookBridge, type OcHookBridge } from "./oc-hook-bridge.js";
import { readAgentLoopBinding, writeAgentLoopBinding } from "./session-binding.js";
import { composeSystemPrompt } from "./system-prompt.js";
import { buildToolDefinitions, buildToolBridgeHandle, sanitizeToolArgs } from "./tool-bridge.js";
import { buildSdkHooks } from "./oc-hook-bridge.js";

// ── Internal message types (extractMessages output / buildMessageEvent input) ──

type OcAssistantTextMessage = {
  role: "assistant";
  content: string;
  timestamp: number;
};

type OcAssistantToolCallMessage = {
  role: "assistant";
  toolCallId: string;
  content: Array<{ type: "toolCall"; name: string; arguments: unknown }>;
  timestamp: number;
};

type OcToolResultMessage = {
  role: "toolResult";
  toolCallId: string;
  toolName: string;
  content: unknown;
  isError?: boolean;
  timestamp: number;
};

type OcMessage = OcAssistantTextMessage | OcAssistantToolCallMessage | OcToolResultMessage;

// ── Agent event type ──

type AgentEvent = {
  stream: string;
  data: Record<string, unknown>;
  text?: string;
  lastChunk?: string;
  emittedSnapshot?: string;
};

// ── Config helper type for provider lookups ──

type ConfigWithProviders = {
  models?: {
    providers?: Record<string, { baseUrl?: string; apiKey?: string }>;
  };
};

export type AgentLoopPreparedRun = {
  harnessId: string;
  label: string;
  pluginId?: string;
  params: AgentHarnessAttemptParams;
  lifecycleState: "prepared";
  resolvedConfig: ReturnType<typeof resolveAgentLoopConfig>;
  appName: string;
  isFirstRequest: boolean;
  agentId?: string;
  loopType?: AgentLoopLoopType;
};

export type AgentLoopSession = {
  harnessId: string;
  label: string;
  pluginId?: string;
  params: AgentHarnessAttemptParams;
  lifecycleState: "started";
  resolvedConfig: ReturnType<typeof resolveAgentLoopConfig>;
  appName: string;
  bindingWritten: boolean;
  signal: AbortSignal;
  agentId?: string;
  loopType?: AgentLoopLoopType;
};

type PrepareOptions = {
  loopRegistry: LoopRegistry;
  pluginConfig?: unknown;
};

type SendOptions = {
  loopRegistry?: LoopRegistry;
  pluginConfig?: unknown;
};

export async function prepareAgentLoopAttempt(
  params: AgentHarnessAttemptParams,
  options: PrepareOptions,
): Promise<AgentLoopPreparedRun> {
  const resolvedConfig = resolveAgentLoopConfig({ pluginConfig: options.pluginConfig });
  const appName = resolveAppName(params, options);

  const existingBinding = params.sessionFile
    ? await readAgentLoopBinding(params.sessionFile)
    : undefined;

  const appManifest = options.loopRegistry.getApp(appName);
  const agentId = parseAgentId(params) ?? appManifest?.loop_mode?.[0]?.id;
  const loopConfig = appManifest?.loop_mode?.find((l) => l.id === agentId);
  const loopType = loopConfig?.type as AgentLoopLoopType | undefined;

  embeddedAgentLog.debug(
    `[agentloop] prepare complete appName=${appName} agentId=${agentId} loopType=${loopType} isFirstRequest=${!existingBinding}`,
  );

  return {
    harnessId: "agentloop",
    label: "AgentLoop harness",
    pluginId: "agentloop",
    params,
    lifecycleState: "prepared",
    resolvedConfig,
    appName,
    isFirstRequest: !existingBinding,
    agentId,
    loopType,
  };
}

export async function startAgentLoopAttempt(
  prepared: AgentLoopPreparedRun,
): Promise<AgentLoopSession> {
  const loopId = prepared.agentId ?? "supervisor";
  const loopType = prepared.loopType ?? "supervisor";

  if (prepared.params.sessionFile) {
    await writeAgentLoopBinding(prepared.params.sessionFile, {
      appName: prepared.appName,
      loopId,
      loopType: loopType as AgentLoopLoopType,
      model: prepared.params.modelId,
      modelProvider: prepared.params.provider,
    });
  }

  return {
    harnessId: prepared.harnessId,
    label: prepared.label,
    pluginId: prepared.pluginId,
    params: prepared.params,
    lifecycleState: "started",
    resolvedConfig: prepared.resolvedConfig,
    appName: prepared.appName,
    bindingWritten: true,
    signal: prepared.params.signal ?? new AbortController().signal,
    agentId: prepared.agentId,
    loopType: prepared.loopType,
  };
}

export async function sendAgentLoopAttempt(
  session: AgentLoopSession,
  options: SendOptions,
): Promise<AgentHarnessAttemptResult> {
  const { params, appName } = session;
  embeddedAgentLog.debug(
    `[agentloop] user message = ${params.prompt}, inputProvenance=${JSON.stringify(params.inputProvenance)}`,
  );

  function pushAgentEvent(stream: string, data: Record<string, unknown>): void {
    try {
      emitAgentEvent({
        runId: params.runId,
        stream,
        data,
      });
      params.onAgentEvent?.({ stream, data });
      embeddedAgentLog.debug(`[agentloop] emit ${stream} data=${JSON.stringify(data)}`);
    } catch (pushErr) {
      embeddedAgentLog.warn(`[agentloop] push ${stream} msg error=${String(pushErr)}`);
    }
  }

  const appManifest = options.loopRegistry?.getApp(appName);
  embeddedAgentLog.debug(`[agentloop] appManifest=${JSON.stringify(appManifest)}`);
  if (!appManifest) {
    const availableApps = options.loopRegistry?.listApps() ?? [];
    embeddedAgentLog.warn(
      `[agentloop] app manifest not found appName=${appName} availableApps=${JSON.stringify(availableApps)}`,
    );
    return {
      assistantTexts: [
        `[agentloop] no app manifest available for "${appName}". Available apps: [${availableApps.join(", ") || "none"}].`,
      ],
      finishReason: "stop",
      itemLifecycle: { started: 0, completed: 0, skipped: 0, aborted: 0 },
    };
  }

  const agentId = session.agentId ?? parseAgentId(params) ?? appManifest.loop_mode[0]?.id;

  const loopMode = appManifest.loop_mode.find((l) => l.id === agentId);
  if (loopMode?.type === "custom") {
    const customExecutor = (loopMode as Record<string, unknown>).custom_loop_executor as
      | string
      | undefined;
    if (customExecutor && appManifest.sourcePath) {
      const { loopRegister } = await import("@zte/agentloop-sdk/sdk");
      const executorPath = path.resolve(appManifest.sourcePath, customExecutor);
      const customModule = await import(executorPath);
      const LoopClass = customModule.default;
      if (LoopClass && typeof LoopClass === "function") {
        const customLoop = new LoopClass(agentId, appManifest.appName);
        loopRegister.register(appManifest.appName, customLoop, "custom");
      }
    }
  }

  const { createLoopById } = await import("@zte/agentloop-sdk/sdk");
  const loop = createLoopById(agentId, appManifest);
  embeddedAgentLog.info(`[agentloop] loop.run config=${JSON.stringify(appManifest)}`);

  const toolBridge = await buildToolBridgeHandle({
    ...params,
    agentId,
    signal: session.signal,
    toolTimeoutMs: session.resolvedConfig.toolTimeoutMs,
  } as Parameters<typeof buildToolBridgeHandle>[0]);
  if (
    toolBridge &&
    "setToolBridge" in loop &&
    typeof (loop as unknown as Record<string, unknown>).setToolBridge === "function"
  ) {
    (loop as unknown as { setToolBridge(bridge: ToolBridgeHandle): void }).setToolBridge(
      toolBridge,
    );
    embeddedAgentLog.info(`[agentloop] loop.setToolBridge called`);
  }

  const attemptStartedAt = Date.now();
  const hookCtx = {
    runId: params.runId,
    agentId,
    sessionKey: params.sessionKey,
    sessionId: params.sessionId,
    workspaceDir: params.workspaceDir,
  };

  const promptBuildResult = await resolveAgentHarnessBeforePromptBuildResult({
    prompt: params.prompt,
    developerInstructions: params.extraSystemPrompt ?? "",
    messages: [],
    ctx: {
      runId: params.runId,
      agentId,
      sessionKey: params.sessionKey,
      sessionId: params.sessionId,
      workspaceDir: params.workspaceDir,
      modelProviderId: params.provider,
      modelId: params.modelId,
    },
  });
  const effectivePrompt = promptBuildResult.prompt;
  const effectiveExtraSystemPrompt = promptBuildResult.developerInstructions;

  const promptInput = buildPromptInput({ ...params, prompt: effectivePrompt });

  const ocHookBridge = createOcHookBridge(hookCtx);

  const loopOptions = await buildLoopOptions(session, agentId, appManifest, {
    extraSystemPrompt: effectiveExtraSystemPrompt,
    ocHookBridge,
  });
  embeddedAgentLog.debug(`[agentloop] loop.loopOptions=${JSON.stringify(loopOptions)}`);

  try {
    runAgentHarnessLlmInputHook({
      event: {
        runId: params.runId,
        sessionId: params.sessionId,
        provider: params.provider,
        model: params.modelId,
        prompt: effectivePrompt,
        historyMessages: [],
        imagesCount: params.images?.length ?? 0,
      },
      ctx: hookCtx,
    });
  } catch (error) {
    embeddedAgentLog.warn(`[agentloop] runAgentHarnessLlmInputHook failed error=${String(error)}`);
  }

  let messages: SDKMessage[] = [];
  let totalOcMessages: OcMessage[] = [];
  let assistantTexts: string[] = [];
  let emittedSnapshot = "";
  let lastChunk = "";
  let success = true;

  pushAgentEvent("lifecycle", {
    phase: "start",
    startedAt: attemptStartedAt,
  });

  if (params.sessionFile && params.prompt) {
    await appendSessionTranscriptMessage({
      transcriptPath: params.sessionFile,
      message: {
        role: "user",
        content: params.prompt,
        timestamp: Date.now(),
      },
      sessionId: params.sessionId,
      cwd: params.workspaceDir,
    }).catch((err) =>
      embeddedAgentLog.warn(`[agentloop] failed to append user transcript: ${err}`),
    );
  }

  try {
    embeddedAgentLog.info(
      `[agentloop] loop.run starting agentId=${agentId} model=${params.modelId} session: ${params.sessionId} sessionKey: ${params.sessionKey}`,
    );
    const result: LoopResult = loop.run(promptInput, loopOptions);
    for await (const msg of result) {
      messages.push(msg);
      embeddedAgentLog.debug(`[agentloop] raw msg =${JSON.stringify(msg)}`);

      const ccToolMap = extractToolMap(messages);
      const ocMessages = extractMessages(msg, ccToolMap);
      totalOcMessages.push(...ocMessages);

      for (const ocMsg of ocMessages) {
        const events = buildMessageEvent(ocMsg, { lastChunk, emittedSnapshot });
        if (!events) continue;
        for (const event of events) {
          if (event.stream === "assistant") {
            lastChunk = event.lastChunk ?? "";
            emittedSnapshot = event.emittedSnapshot ?? "";
            assistantTexts.push(event.text ?? "");
          } else {
            lastChunk = "";
            emittedSnapshot = "";
          }
          pushAgentEvent(event.stream, event.data);
        }
      }
    }
  } catch (error) {
    success = false;
    embeddedAgentLog.warn(`[agentloop] loop.run failed agentId=${agentId} error=${String(error)}`);
  }

  try {
    const finalizeOutcome = await runAgentHarnessBeforeAgentFinalizeHook({
      event: {
        messages: messages as Parameters<
          typeof runAgentHarnessBeforeAgentFinalizeHook
        >[0]["event"]["messages"],
        assistantText: assistantTexts.join("\n\n"),
        stopHookActive: true,
      },
      ctx: hookCtx,
    });
    embeddedAgentLog.info(`[agentloop] before_agent_finalize outcome=${finalizeOutcome.action}`);
  } catch (error) {
    embeddedAgentLog.warn(`[agentloop] before_agent_finalize hook failed error=${String(error)}`);
  }

  if (params.sessionFile) {
    for (const ocMsg of totalOcMessages) {
      await appendSessionTranscriptMessage({
        transcriptPath: params.sessionFile,
        message: ocMsg,
        sessionId: params.sessionId,
        cwd: params.workspaceDir,
      }).catch((err) => embeddedAgentLog.warn(`[agentloop] failed to append transcript: ${err}`));
    }
  }

  pushAgentEvent("lifecycle", {
    phase: success ? "end" : "error",
    ...(success ? {} : { error: "agentloop loop.run failed" }),
    success,
    assistantTextCount: assistantTexts.length,
    messageCount: messages.length,
    durationMs: Date.now() - attemptStartedAt,
  });
  try {
    runAgentHarnessLlmOutputHook({
      event: {
        runId: params.runId,
        sessionId: params.sessionId,
        provider: params.provider,
        model: params.modelId,
        assistantTexts,
      },
      ctx: hookCtx,
    });
  } catch (error) {
    embeddedAgentLog.warn(`[agentloop] runAgentHarnessLlmOutputHook failed error=${String(error)}`);
  }

  try {
    runAgentHarnessAgentEndHook({
      event: {
        messages: messages as Parameters<
          typeof runAgentHarnessAgentEndHook
        >[0]["event"]["messages"],
        success,
        durationMs: Date.now() - attemptStartedAt,
      },
      ctx: hookCtx as Parameters<typeof runAgentHarnessAgentEndHook>[0]["ctx"],
    });
  } catch (error) {
    embeddedAgentLog.warn(`[agentloop] runAgentHarnessAgentEndHook failed error=${String(error)}`);
  }

  return {
    aborted: false,
    externalAbort: false,
    timedOut: false,
    idleTimedOut: false,
    timedOutDuringCompaction: false,
    promptError: null,
    promptErrorSource: null,
    sessionIdUsed: params.sessionId ?? "",
    messagesSnapshot: [],
    assistantTexts: assistantTexts.length > 0 ? assistantTexts : ["agentloop execution completed."],
    toolMetas: [],
    lastAssistant: undefined,
    didSendViaMessagingTool: false,
    messagingToolSentTexts: [],
    messagingToolSentMediaUrls: [],
    messagingToolSentTargets: [],
    cloudCodeAssistFormatError: false,
    replayMetadata: { hadPotentialSideEffects: false, replaySafe: true },
    itemLifecycle: { startedCount: 0, completedCount: messages.length, activeCount: 0 },
    agentHarnessId: "agentloop",
  } as AgentHarnessAttemptResult;
}

export async function resolveAgentLoopOutcome(
  _session: AgentLoopSession,
  result: AgentHarnessAttemptResult,
): Promise<AgentHarnessAttemptResult> {
  return result;
}

export async function cleanupAgentLoopAttempt(
  _params: AgentHarnessV2CleanupParams,
): Promise<void> {}

function extractToolMap(messages: SDKMessage[]): Map<string, string> {
  const toolMap = new Map<string, string>();
  for (const msg of messages) {
    if (msg.type !== "assistant") {
      continue;
    }
    const messageObj = msg.message;
    if (!messageObj || typeof messageObj !== "object") {
      continue;
    }
    const contentBlocks = (messageObj as Record<string, unknown>).content;
    if (!Array.isArray(contentBlocks)) {
      continue;
    }
    if (contentBlocks.length == 0) {
      continue;
    }
    for (const block of contentBlocks) {
      if (!block || typeof block !== "object") {
        continue;
      }
      const blockObject = block as Record<string, unknown>;
      const type = blockObject.type;
      if (
        type === "tool_use" &&
        typeof blockObject.id === "string" &&
        typeof blockObject.name === "string"
      ) {
        const toolCallId = blockObject.id ?? "";
        const toolName = blockObject.name ?? "";
        if (toolCallId && toolName) {
          toolMap.set(toolCallId, toolName);
        }
      }
    }
  }
  return toolMap;
}

function extractMessages(msg: SDKMessage, ccToolMap?: Map<string, string>): OcMessage[] {
  const messages: OcMessage[] = [];
  const assistantMsgs = extractAssistantMsgs(msg);
  messages.push(...assistantMsgs);
  const extraParamMsgs = extractExtraParamMsgs(msg);
  messages.push(...extraParamMsgs);
  const toolCallResultMsgs = extractToolCallResultMsgs(msg);
  messages.push(...toolCallResultMsgs);
  const userMsgs = extractUserMsgs(msg, ccToolMap);
  messages.push(...userMsgs);
  return messages;
}

function extractExtraParamMsgs(msg: SDKMessage): OcMessage[] {
  const result: OcMessage[] = [];
  if (msg.type !== "extraparam_result") {
    return result;
  }
  const resultText = msg.result;
  if (typeof resultText !== "string") {
    return result;
  }
  result.push({
    role: "assistant",
    content: resultText,
    timestamp: Date.now(),
  });
  return result;
}

function extractToolCallResultMsgs(msg: SDKMessage): OcMessage[] {
  const result: OcMessage[] = [];
  if (msg.type !== "tool_call_result" || msg?.fromRuleLoop !== true) {
    return result;
  }
  const error = msg.error;
  if (typeof error === "string") {
    result.push({
      role: "assistant",
      content: error,
      timestamp: Date.now(),
    });
    return result;
  }
  const tools = msg.tools;
  if (!Array.isArray(tools) || tools.length === 0) {
    return result;
  }
  for (const tool of tools) {
    if (!tool || typeof tool !== "object") continue;
    const t = tool as Record<string, unknown>;
    const contentItems = t.contentItems;
    let contentText = "";
    if (typeof contentItems === "string") {
      contentText = contentItems;
    } else if (Array.isArray(contentItems)) {
      const texts: string[] = [];
      for (const item of contentItems) {
        if (item && typeof item === "object") {
          const text = (item as Record<string, unknown>).text;
          if (typeof text === "string") {
            texts.push(text);
          }
        }
      }
      contentText = texts.join("\n");
    } else {
      contentText = JSON.stringify(contentItems);
    }
    result.push({
      role: "assistant",
      content: contentText,
      timestamp: Date.now(),
    });
  }
  return result;
}

function extractUserMsgs(msg: SDKMessage, ccToolMap?: Map<string, string>): OcMessage[] {
  const result: OcMessage[] = [];
  if (msg.type !== "user") {
    return result;
  }
  const messageObj = msg.message;
  if (!messageObj || typeof messageObj !== "object") {
    return result;
  }
  const contentBlocks = (messageObj as Record<string, unknown>).content;
  if (!Array.isArray(contentBlocks)) {
    return result;
  }
  if (contentBlocks.length == 0) {
    return result;
  }
  for (const block of contentBlocks) {
    if (!block || typeof block !== "object") {
      continue;
    }
    const blockObject = block as Record<string, unknown>;
    const type = blockObject.type;
    if (type !== "tool_result") {
      continue;
    }
    if (typeof blockObject.tool_use_id !== "string") {
      continue;
    }

    const rawContent = blockObject.content;
    if (typeof rawContent !== "string") continue;

    result.push({
      role: "toolResult",
      toolCallId: blockObject.tool_use_id,
      toolName: ccToolMap?.get(blockObject.tool_use_id) ?? "notFound",
      content: sanitizeToolResult(rawContent) ?? "NotFound",
      isError: blockObject.isError ?? false,
      timestamp: Date.now(),
    });
  }
  return result;
}

function sanitizeToolResult(rawContent: string): string {
  try {
    return JSON.stringify(sanitizeToolArgs(JSON.parse(rawContent)), null, 2);
  } catch {
    return rawContent;
  }
}

function extractAssistantMsgs(msg: SDKMessage): OcMessage[] {
  const result: OcMessage[] = [];
  if (msg.type !== "assistant") {
    return result;
  }
  const messageObj = msg.message;
  if (!messageObj || typeof messageObj !== "object") {
    return result;
  }
  const contentBlocks = (messageObj as Record<string, unknown>).content;
  if (!Array.isArray(contentBlocks)) {
    return result;
  }
  if (contentBlocks.length == 0) {
    return result;
  }
  for (const block of contentBlocks) {
    if (!block || typeof block !== "object") {
      continue;
    }
    const blockObject = block as Record<string, unknown>;
    const type = blockObject.type;
    if (type === "text" && typeof blockObject.text === "string") {
      result.push({
        role: "assistant",
        content: stripThinkTags(blockObject.text),
        timestamp: Date.now(),
      });
    }
    if (type === "tool_use" && typeof blockObject.id === "string") {
      result.push({
        role: "assistant",
        toolCallId: blockObject.id,
        content: [
          {
            type: "toolCall",
            name: blockObject.name ?? "",
            arguments: blockObject.input ? sanitizeToolArgs(blockObject.input) : {},
          },
        ],
        timestamp: Date.now(),
      });
    }
  }
  return result;
}

type MessageEventState = { lastChunk: string; emittedSnapshot: string };
type MessageEvent = {
  text: string;
  data: Record<string, unknown>;
  lastChunk: string;
  emittedSnapshot: string;
  stream?: string;
};

interface MessageEventBuilder {
  canHandle(msg: OcMessage): boolean;
  build(msg: OcMessage, state: MessageEventState): AgentEvent[] | undefined;
}

function buildAssistantAndToolCallEvents(msg: OcMessage, state: MessageEventState): AgentEvent[] {
  const events: AgentEvent[] = [];
  if (msg.role !== "assistant") {
    return events;
  }
  if (typeof msg.content === "string") {
    const assistantEvent = buildAssistantEvent(msg, state);
    if (assistantEvent) {
      events.push({
        stream: "assistant",
        data: assistantEvent.data,
        text: assistantEvent.text,
        lastChunk: assistantEvent.lastChunk,
        emittedSnapshot: assistantEvent.emittedSnapshot,
      });
    }
    return events;
  }
  const msgContent = msg.content[0];
  if (!msgContent || msgContent.type !== "toolCall") {
    return events;
  }
  embeddedAgentLog.debug(
    `[tool-bridge] starting to call tool, callId: ${msg.toolCallId}, args: ${JSON.stringify(msgContent.arguments)}`,
  );
  events.push({
    stream: "tool",
    data: {
      phase: "start",
      name: msgContent.name,
      toolCallId: msg.toolCallId,
      args: msgContent.arguments,
    },
  });
  events.push({
    stream: "item",
    data: {
      itemId: `tool:${msg.toolCallId}`,
      phase: "start",
      kind: "tool",
      title: msgContent.name,
      status: "running",
      name: msgContent.name,
      toolCallId: msg.toolCallId,
      startedAt: Date.now(),
    },
  });
  return events;
}

function buildAssistantEvent(
  msg: OcAssistantTextMessage,
  state: MessageEventState,
): MessageEvent | undefined {
  const text = msg.content;
  if (!text || text === state.lastChunk) return undefined;
  const delta = state.emittedSnapshot.length > 0 ? `\n\n${text}` : text;
  if (!delta.trim()) return undefined;
  const snapshot = state.emittedSnapshot + delta;
  return {
    text,
    data: { text: snapshot, delta, phase: "text" },
    lastChunk: text,
    emittedSnapshot: snapshot,
  };
}

function buildToolResultEvent(msg: OcToolResultMessage, _state: MessageEventState): AgentEvent[] {
  return [
    {
      stream: "tool",
      data: {
        phase: "result",
        name: msg.toolName,
        toolCallId: msg.toolCallId,
        isError: msg.isError,
        result: msg.content ?? "notFound",
      },
    },
    {
      stream: "item",
      data: {
        itemId: `tool:${msg.toolCallId}`,
        phase: "end",
        kind: "tool",
        title: msg.toolName,
        status: msg.isError ? "failed" : "completed",
        name: msg.toolName,
        toolCallId: msg.toolCallId,
        startedAt: Date.now(),
        endedAt: Date.now(),
      },
    },
  ];
}

function stripThinkTags(text: string): string {
  if (!text) return text;
  if (!/<\s*think\b/i.test(text)) return text;

  let result = "";
  let lastIndex = 0;
  let depth = 0;

  const regex = /<\s*(\/?)\s*think\b[^<>]*>/gi;
  for (const match of text.matchAll(regex)) {
    const idx = match.index ?? 0;
    const isClose = match[1] === "/";

    if (depth === 0) {
      if (isClose) {
        lastIndex = idx + match[0].length;
        continue;
      }
      result += text.slice(lastIndex, idx);
      depth = 1;
    } else if (isClose) {
      depth = Math.max(0, depth - 1);
    } else {
      depth += 1;
    }
    lastIndex = idx + match[0].length;
  }

  if (depth === 0) {
    result += text.slice(lastIndex);
  }

  return result.trim();
}

const messageEventBuilders: MessageEventBuilder[] = [
  { canHandle: (msg) => msg.role === "assistant", build: buildAssistantAndToolCallEvents },
  { canHandle: (msg) => msg.role === "toolResult", build: buildToolResultEvent },
];

function buildMessageEvent(msg: OcMessage, state: MessageEventState): AgentEvent[] | undefined {
  const builder = messageEventBuilders.find((b) => b.canHandle(msg));
  return builder?.build(msg, state);
}

function resolveAppName(params: AgentHarnessAttemptParams, options: PrepareOptions): string {
  const agentId = parseAgentIdFromSessionKey(params.sessionKey);
  if (agentId) {
    const entry = options.loopRegistry.resolveAgentId(agentId);
    if (entry) return entry.app_name;
  }
  const apps = options.loopRegistry.listApps();
  return apps.length > 0 ? apps[0] : "default";
}

function parseAgentIdFromSessionKey(sessionKey?: string): string | undefined {
  if (!sessionKey) return undefined;
  const parts = sessionKey.split(":");
  if (parts.length >= 2 && parts[0] === "agent" && parts[1]?.trim()) {
    return parts[1].trim();
  }
  return undefined;
}

function parseAgentId(params: AgentHarnessAttemptParams): string | undefined {
  return parseAgentIdFromSessionKey(params.sessionKey);
}

function buildPromptInput(params: AgentHarnessAttemptParams): PromptInput {
  const isInterSession = params.inputProvenance?.kind === "inter_session";
  embeddedAgentLog.info(`[agentloop] isInterSession=${isInterSession}`);
  if (isInterSession) {
    return {
      type: "system",
      text: params.prompt,
    };
  }
  if (params.images?.length) {
    return [
      { type: "text", text: params.prompt },
      ...params.images.map((img) => ({
        type: "image",
        source: {
          data: img.data,
          type: "base64",
          media_type: "image/png",
        },
      })),
    ];
  }
  return params.prompt;
}

async function buildLoopOptions(
  session: AgentLoopSession,
  agentId: string,
  appManifest: import("./loop-registry.js").AppManifest,
  overrides?: { extraSystemPrompt?: string; ocHookBridge?: OcHookBridge },
): Promise<Partial<LoopOptions>> {
  const { params } = session;

  const tools = await buildToolDefinitions({
    ...params,
    agentId,
    toolTimeoutMs: session.resolvedConfig.toolTimeoutMs,
  } as Parameters<typeof buildToolDefinitions>[0]);

  embeddedAgentLog.info(
    `[agentloop] appManifest=${JSON.stringify(appManifest)}, agentId: ${agentId}`,
  );
  const appSystemPrompt = appManifest?.loop_mode?.find((l) => l.id === agentId)?.systemPrompt;
  embeddedAgentLog.debug(
    `[agentloop] agent ${agentId} appSystemPrompt: \n${JSON.stringify(appSystemPrompt)}`,
  );
  const composedSystemPrompt = composeSystemPrompt(params, tools, appManifest);
  embeddedAgentLog.debug(
    `[agentloop] agent ${agentId} composedSystemPrompt: \n${composedSystemPrompt}`,
  );
  const systemPrompt = buildAgentSystemPrompt(
    appSystemPrompt,
    composedSystemPrompt,
    overrides?.extraSystemPrompt ?? params.extraSystemPrompt,
  );
  embeddedAgentLog.debug(`[agentloop] agent ${agentId} systemPrompt: \n${systemPrompt}`);

  // 解析 apiKey：优先使用上游已解析的，否则调用 core 解析，最后 fallback 到本地配置读取
  let apiKey = params.resolvedApiKey;
  if (!apiKey) {
    try {
      const resolvedAuth = await resolveApiKeyForProvider({
        provider: params.provider,
        cfg: params.config as import("openclaw/plugin-sdk").OpenClawConfig,
        store: params.authProfileStore,
        agentDir: params.agentDir,
        workspaceDir: params.workspaceDir,
      });
      apiKey = resolvedAuth.apiKey;
    } catch (err) {
      embeddedAgentLog.warn(
        `[agentloop] resolveApiKeyForProvider failed for ${params.provider}: ${String(err)}`,
      );
    }
  }
  if (!apiKey) {
    apiKey = resolveModelProviderApiKey(params);
  }

  // Convert OC hook bridge to SDKHooks for DEI path (session-runtime reads options.hooks)
  const hooks = overrides?.ocHookBridge
    ? buildSdkHooks(overrides.ocHookBridge)
    : undefined;

  return {
    tools,
    ...(params.toolsAllow ? { allowedTools: params.toolsAllow } : {}),
    ...(systemPrompt ? { systemPrompt } : {}),
    permissionMode: "default" as const,
    sessionId: `sessionId:${params.sessionId ?? ""}:sessionKey:${params.sessionKey ?? ""}`,
    model: params.modelId,
    ...(params.model?.api ? { api: String(params.model.api) } : {}),
    ...(resolveProviderUrl(params)
      ? { url: resolveProviderUrl(params) }
      : (params.model as any)?.baseUrl
        ? { url: (params.model as any).baseUrl }
        : {}),
    ...(apiKey ? { authToken: apiKey } : {}),
    maxTurns: session.resolvedConfig.loop.maxTurns,
    cwd: params.workspaceDir,
    workspace: params.workspaceDir,
    ...(params.images?.length ? { includePartialMessages: true } : {}),
    ...(params.thinkLevel ? { effort: params.thinkLevel } : {}),
    timeout: params.timeoutMs,
    ...(params.signal ? { signal: params.signal } : {}),
    ...(overrides?.ocHookBridge ? { ocHookBridge: overrides.ocHookBridge } : {}),

    ...(hooks ? { hooks } : {}),
  };
}

function buildAgentSystemPrompt(
  appConfig?: { apply_mode?: string; content?: string },
  systemPrompt?: string,
  extraPrompt?: string,
): string | undefined {
  const content = appConfig?.content?.trim();
  if (!content) {
    return (
      [systemPrompt, extraPrompt]
        .filter((s): s is string => typeof s === "string" && s.trim().length > 0)
        .join("\n\n") || undefined
    );
  }

  if (appConfig?.apply_mode === "override") {
    return content;
  }

  return (
    [systemPrompt, extraPrompt, content]
      .filter((s): s is string => typeof s === "string" && s.trim().length > 0)
      .join("\n\n") || undefined
  );
}

function resolveProviderUrl(params: AgentHarnessAttemptParams): string | undefined {
  try {
    const providers = (params.config as ConfigWithProviders)?.models?.providers;
    return providers?.[params.provider]?.baseUrl;
  } catch {
    return undefined;
  }
}

function resolveProviderApiKey(params: AgentHarnessAttemptParams): string | undefined {
  try {
    const providers = (params.config as ConfigWithProviders)?.models?.providers;
    return providers?.[params.provider]?.apiKey;
  } catch {
    return undefined;
  }
}

function resolveModelProviderApiKey(params: AgentHarnessAttemptParams): string | undefined {
  if (params.resolvedApiKey) {
    return params.resolvedApiKey;
  }

  const authHeader =
    (params.model as Record<string, unknown> | undefined)?.headers?.Authorization ||
    (params.model as Record<string, unknown> | undefined)?.headers?.authorization;
  if (typeof authHeader === "string") {
    const match = authHeader.match(/^Bearer\s+(.+)$/i);
    if (match) {
      return match[1];
    }
  }

  try {
    const providers = (params.config as ConfigWithProviders)?.models?.providers;
    const key = providers?.[params.provider]?.apiKey;
    if (key) {
      return key;
    }
  } catch {}
  return undefined;
}
