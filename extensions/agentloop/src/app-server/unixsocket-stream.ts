/**
 * Unix Socket provider adapter for agentloop harness.
 *
 * When provider === "unixsocket", bypasses the normal loop.run() → agentloop-sdk → HTTP path
 * and directly calls the unixsocket extension's createUnixSocketStreamFn, converting
 * pi-ai events into SDKMessage format that the existing extractMessages / buildMessageEvent
 * pipeline can consume.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { SDKMessage } from "@zte/agentloop-sdk/sdk";
import type {
  AgentHarnessAttemptParams,
  AgentHarnessAttemptResult,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import { embeddedAgentLog } from "openclaw/plugin-sdk/agent-harness-runtime";
import type { OcMessage, AgentEvent, MessageEventState, PushAgentEventFn } from "./types.js";
import {
  UNIXSOCKET_DEFAULT_SOCKET_PATH,
  UNIXSOCKET_DEFAULT_CONNECT_TIMEOUT_MS,
  UNIXSOCKET_DEFAULT_READ_TIMEOUT_MS,
  UNIXSOCKET_DEFAULT_MAX_RETRIES,
  UNIXSOCKET_DEFAULT_CONTEXT_WINDOW,
  UNIXSOCKET_DEFAULT_MAX_TOKENS,
} from "./types.js";

// ── Config helper type (local, extends base with unixsocket-specific params) ──

type ConfigWithProviders = {
  models?: {
    providers?: Record<
      string,
      {
        baseUrl?: string;
        apiKey?: string;
        params?: {
          socketPath?: string;
          modelId?: string;
          connectTimeoutMs?: number;
          readTimeoutMs?: number;
          maxRetries?: number;
          contextWindow?: number;
          maxTokens?: number;
        };
      }
    >;
  };
};

// ── Resolve unixsocket-provider api path ──

function resolveUnixsocketApiPath(): string {
  const thisDir = path.dirname(fileURLToPath(import.meta.url));

  const candidates = [
    // harness chunk at dist/harness-<hash>.js → dist/extensions/unixsocket/api.js
    path.resolve(thisDir, "extensions", "unixsocket", "api.js"),
    // harness entry at dist/extensions/agentloop/harness.js
    path.resolve(thisDir, "..", "..", "extensions", "unixsocket", "api.js"),
    // dist-runtime fallback
    path.resolve(thisDir, "..", "dist-runtime", "extensions", "unixsocket", "api.js"),
  ];

  for (const candidate of candidates) {
    try {
      fs.accessSync(candidate);
      return candidate;
    } catch {}
  }

  throw new Error(
    `[agentloop:unixsocket] Cannot locate unixsocket api.js. Searched: ${candidates.join(", ")}`,
  );
}

// ── Tool conversion (UnifiedTool → pi-ai Tool format) ──

type ToolLike = {
  name: string;
  description: string;
  parameters?: Record<string, unknown>;
  inputSchema?: unknown;
};

function toPiAiTools(
  tools: ToolLike[],
): Array<{ name: string; description: string; parameters: Record<string, unknown> }> {
  return tools.map((t) => ({
    name: t.name,
    description: t.description,
    parameters: t.parameters ?? (t.inputSchema as Record<string, unknown>) ?? {},
  }));
}

// ── Provider detection ──

export function isUnixSocketProvider(params: AgentHarnessAttemptParams): boolean {
  return params.provider === "unixsocket";
}

// ── Config resolution ──

function resolveSocketConfig(params: AgentHarnessAttemptParams) {
  const providerCfg = (params.config as ConfigWithProviders)?.models?.providers?.["unixsocket"];
  const p = providerCfg?.params;
  return {
    socketPath: p?.socketPath ?? UNIXSOCKET_DEFAULT_SOCKET_PATH,
    connectTimeoutMs: p?.connectTimeoutMs ?? UNIXSOCKET_DEFAULT_CONNECT_TIMEOUT_MS,
    readTimeoutMs: p?.readTimeoutMs ?? UNIXSOCKET_DEFAULT_READ_TIMEOUT_MS,
    maxRetries: p?.maxRetries ?? UNIXSOCKET_DEFAULT_MAX_RETRIES,
    contextWindow:
      ((p as Record<string, unknown>)?.contextWindow as number) ??
      UNIXSOCKET_DEFAULT_CONTEXT_WINDOW,
    maxTokens:
      ((p as Record<string, unknown>)?.maxTokens as number) ?? UNIXSOCKET_DEFAULT_MAX_TOKENS,
  };
}

// ── SDKMessage helpers ──

function makeTextSDKMessage(text: string): SDKMessage {
  return {
    type: "assistant",
    message: {
      content: [{ type: "text", text }],
    },
  } as unknown as SDKMessage;
}

// ── Message extraction (mirrors run-lifecycle.ts extractAssistantMsgs for "assistant" text only) ──

function extractOcMessages(msg: SDKMessage): OcMessage[] {
  if (msg.type !== "assistant") return [];
  const messageObj = (msg as Record<string, unknown>).message;
  if (!messageObj || typeof messageObj !== "object") return [];
  const contentBlocks = (messageObj as Record<string, unknown>).content;
  if (!Array.isArray(contentBlocks)) return [];

  const result: OcMessage[] = [];
  for (const block of contentBlocks) {
    if (!block || typeof block !== "object") continue;
    const b = block as Record<string, unknown>;
    if (b.type === "text" && typeof b.text === "string") {
      result.push({ role: "assistant", content: b.text, timestamp: Date.now() });
    }
  }
  return result;
}

// ── Event building (mirrors buildAssistantEvent from run-lifecycle.ts) ──

function buildAssistantEvent(
  msg: OcMessage & { role: "assistant"; content: string },
  state: MessageEventState,
): AgentEvent | undefined {
  const text = msg.content;
  if (!text || text === state.lastChunk) return undefined;
  const delta = state.emittedSnapshot.length > 0 ? `\n\n${text}` : text;
  if (!delta.trim()) return undefined;
  const snapshot = state.emittedSnapshot + delta;
  return {
    stream: "assistant",
    data: { text: snapshot, delta, phase: "text" },
    text,
    lastChunk: text,
    emittedSnapshot: snapshot,
  };
}

// ── Main entry ──

export interface UnixSocketStreamCallbacks {
  pushAgentEvent: PushAgentEventFn;
}

export async function sendUnixSocketStream(
  params: AgentHarnessAttemptParams,
  prompt: string,
  systemPrompt: string | undefined,
  callbacks: UnixSocketStreamCallbacks,
  signal?: AbortSignal,
  tools?: ToolLike[],
): Promise<{ messages: SDKMessage[]; assistantTexts: string[] }> {
  const { pushAgentEvent } = callbacks;
  const socketConfig = resolveSocketConfig(params);

  embeddedAgentLog.info(
    `[agentloop:unixsocket] starting stream socketPath=${socketConfig.socketPath} model=${params.modelId} tools=${tools?.length ?? 0}`,
  );
  embeddedAgentLog.debug(
    `[agentloop:unixsocket] params: provider=${params.provider} modelId=${params.modelId} sessionId=${params.sessionId} sessionKey=${params.sessionKey}`,
  );

  // Resolve unixsocket-provider api via dist path (tsdown bundles agentloop harness,
  // so bare package specifiers like @openclaw/unixsocket-provider/api.js are not resolvable).
  // Walk up from this file's compiled location to find dist/extensions/unixsocket/api.js.
  const { createUnixSocketStreamFn } = await import(
    /* @vite-ignore */
    resolveUnixsocketApiPath()
  );

  const streamFn = createUnixSocketStreamFn({
    socketPath: socketConfig.socketPath,
    connectTimeoutMs: socketConfig.connectTimeoutMs,
    readTimeoutMs: socketConfig.readTimeoutMs,
    maxRetries: socketConfig.maxRetries,
  });

  // Build Model<Api> from params
  const model = {
    id: params.modelId ?? "local-model",
    name: params.modelId ?? "local-model",
    api: "openai-completions" as const,
    provider: "unixsocket",
    reasoning: false,
    input: ["text"] as const,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: socketConfig.contextWindow,
    maxTokens: socketConfig.maxTokens,
  };

  // Build Context from prompt + systemPrompt + tools
  const piAiTools = tools && tools.length > 0 ? toPiAiTools(tools) : undefined;
  const context = {
    messages: [
      {
        role: "user" as const,
        content: prompt,
        timestamp: Date.now(),
      },
    ],
    ...(systemPrompt ? { systemPrompt } : {}),
    ...(piAiTools ? { tools: piAiTools } : {}),
  };

  embeddedAgentLog.debug(
    `[agentloop:unixsocket] request context: systemPromptLen=${systemPrompt?.length ?? 0} messages=1 tools=${piAiTools?.length ?? 0} toolNames=[${piAiTools?.map((t) => t.name).join(",") ?? ""}]`,
  );
  embeddedAgentLog.debug(
    `[agentloop:unixsocket] systemPrompt preview: ${systemPrompt?.slice(0, 500) ?? "(none)"}`,
  );
  embeddedAgentLog.debug(`[agentloop:unixsocket] user prompt: ${prompt.slice(0, 200)}`);
  if (piAiTools) {
    for (const tool of piAiTools) {
      embeddedAgentLog.debug(
        `[agentloop:unixsocket] tool: name=${tool.name} desc=${tool.description?.slice(0, 80) ?? ""} paramsKeys=[${Object.keys(tool.parameters ?? {}).join(",")}]`,
      );
    }
  }

  const options = {
    ...(signal ? { signal } : {}),
  };

  // Call the stream function
  const eventStream = streamFn(
    model as any,
    context as any,
    Object.keys(options).length > 0 ? (options as any) : undefined,
  );

  // Process the event stream → SDKMessage → OcMessage → AgentEvent
  const messages: SDKMessage[] = [];
  const assistantTexts: string[] = [];
  let lastChunk = "";
  let emittedSnapshot = "";

  try {
    for await (const event of eventStream as AsyncIterable<Record<string, unknown>>) {
      const eventType = event.type as string;

      if (eventType === "text_delta") {
        const delta = (event as Record<string, unknown>).delta as string;
        if (!delta) continue;
        embeddedAgentLog.debug(`[agentloop:unixsocket] text_delta: delta="${delta.slice(0, 200)}"`);

        const sdkMsg = makeTextSDKMessage(delta);
        messages.push(sdkMsg);

        const ocMsgs = extractOcMessages(sdkMsg);
        for (const ocMsg of ocMsgs) {
          const agentEvent = buildAssistantEvent(
            ocMsg as OcMessage & { role: "assistant"; content: string },
            { lastChunk, emittedSnapshot },
          );
          if (!agentEvent) continue;
          lastChunk = agentEvent.lastChunk ?? "";
          emittedSnapshot = agentEvent.emittedSnapshot ?? "";
          assistantTexts.push(agentEvent.text ?? "");
          pushAgentEvent(agentEvent.stream, agentEvent.data);
        }
      }

      if (eventType === "done") {
        const reason = (event as Record<string, unknown>).reason as string;
        const usage = (event as Record<string, unknown>).usage;
        embeddedAgentLog.info(
          `[agentloop:unixsocket] stream done reason=${reason} usage=${JSON.stringify(usage)}`,
        );
        embeddedAgentLog.debug(
          `[agentloop:unixsocket] done event full: ${JSON.stringify(event).slice(0, 500)}`,
        );
      }

      if (eventType === "error") {
        const errorObj = (event as Record<string, unknown>).error;
        const errorText =
          typeof errorObj === "string"
            ? errorObj
            : errorObj instanceof Error
              ? errorObj.message
              : JSON.stringify(errorObj ?? "Unknown unixsocket error");

        embeddedAgentLog.warn(`[agentloop:unixsocket] stream error: ${errorText}`);
        embeddedAgentLog.debug(
          `[agentloop:unixsocket] error event full: ${JSON.stringify(event).slice(0, 1000)}`,
        );
        const sdkMsg = makeTextSDKMessage(errorText);
        messages.push(sdkMsg);

        const ocMsgs = extractOcMessages(sdkMsg);
        for (const ocMsg of ocMsgs) {
          const agentEvent = buildAssistantEvent(
            ocMsg as OcMessage & { role: "assistant"; content: string },
            { lastChunk, emittedSnapshot },
          );
          if (agentEvent) {
            pushAgentEvent(agentEvent.stream, agentEvent.data);
          }
        }
      }
    }
  } catch (err) {
    embeddedAgentLog.warn(`[agentloop:unixsocket] stream iteration failed: ${String(err)}`);
  }

  embeddedAgentLog.info(
    `[agentloop:unixsocket] stream completed messages=${messages.length} texts=${assistantTexts.length}`,
  );
  if (assistantTexts.length > 0) {
    embeddedAgentLog.debug(
      `[agentloop:unixsocket] assistant text preview: "${assistantTexts.join("").slice(0, 300)}"`,
    );
  }

  return { messages, assistantTexts };
}
