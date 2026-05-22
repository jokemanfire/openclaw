import type { HookName } from "./rpc-protocol.js";

const ALLOWED_FIELDS_BY_HOOK: Record<HookName, ReadonlySet<string>> = {
  gateway_start: new Set(),
  session_start: new Set(["sessionId", "sessionKey"]),
  session_end: new Set(["sessionId", "sessionKey"]),
  agent_end: new Set(),
  before_agent_reply: new Set(["cleanedBody"]),
  before_prompt_build: new Set(["prompt"]),
  before_tool_call: new Set(["toolName", "params"]),
  llm_input: new Set(),
  llm_output: new Set(),
  message_sending: new Set(["to", "content", "replyToId", "threadId", "metadata"]),
};

export function filterEvent(hook: HookName, event: unknown): Record<string, unknown> {
  const allowed = ALLOWED_FIELDS_BY_HOOK[hook];

  if (allowed.size === 0) {
    return Object.create(null);
  }

  if (!event || typeof event !== "object") {
    return Object.create(null);
  }

  const result: Record<string, unknown> = Object.create(null);
  const source = event as Record<string, unknown>;

  for (const field of allowed) {
    if (Object.hasOwn(source, field)) {
      result[field] = source[field];
    }
  }

  return result;
}
