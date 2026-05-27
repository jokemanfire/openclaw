/**
 * Shared types for the agentloop app-server modules.
 * Single source of truth for OcMessage, AgentEvent, and related types.
 */

// ── Internal message types (extractMessages output / buildMessageEvent input) ──

export type OcAssistantTextMessage = {
  role: "assistant";
  content: string;
  timestamp: number;
};

export type OcAssistantToolCallMessage = {
  role: "assistant";
  toolCallId: string;
  content: Array<{ type: "toolCall"; name: string; arguments: unknown }>;
  timestamp: number;
};

export type OcToolResultMessage = {
  role: "toolResult";
  toolCallId: string;
  toolName: string;
  content: unknown;
  isError?: boolean;
  timestamp: number;
};

export type OcMessage = OcAssistantTextMessage | OcAssistantToolCallMessage | OcToolResultMessage;

// ── Agent event type ──

export type AgentEvent = {
  stream: string;
  data: Record<string, unknown>;
  text?: string;
  lastChunk?: string;
  emittedSnapshot?: string;
};

export type MessageEventState = { lastChunk: string; emittedSnapshot: string };

export type PushAgentEventFn = (stream: string, data: Record<string, unknown>) => void;

// ── Unixsocket defaults ──

export const UNIXSOCKET_DEFAULT_SOCKET_PATH = "/var/run/ai-daemon.sock";
export const UNIXSOCKET_DEFAULT_CONNECT_TIMEOUT_MS = 10_000;
export const UNIXSOCKET_DEFAULT_READ_TIMEOUT_MS = 120_000;
export const UNIXSOCKET_DEFAULT_MAX_RETRIES = 3;
export const UNIXSOCKET_DEFAULT_CONTEXT_WINDOW = 4096;
export const UNIXSOCKET_DEFAULT_MAX_TOKENS = 2048;
