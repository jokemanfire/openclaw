export type HookName =
  | "gateway_start"
  | "session_start"
  | "session_end"
  | "before_agent_reply"
  | "before_prompt_build"
  | "before_tool_call"
  | "agent_end"
  | "llm_input"
  | "llm_output"
  | "message_sending";

export type BeforeAgentReplyResult = {
  handled: boolean;
  reply?: unknown;
  reason?: string;
};

export type BeforePromptBuildResult = {
  prependContext?: string;
  systemPrompt?: string;
};

export type BeforeToolCallResult = {
  block?: boolean;
  blockReason?: string;
  params?: Record<string, unknown>;
  requireApproval?: {
    title: string;
    description: string;
    severity?: "info" | "warning" | "critical";
    timeoutMs?: number;
    timeoutBehavior?: "allow" | "deny";
    allowedDecisions?: Array<"allow-once" | "allow-always" | "deny">;
    pluginId?: string;
  };
};

export type BeforeToolCallOnResolutionContext = {
  agentId?: string;
  sessionKey?: string;
  sessionId?: string;
  runId?: string;
  toolName: string;
  toolCallId?: string;
}

export type BeforeToolCallOnResolutionResult = {
  context: BeforeToolCallOnResolutionContext;
  decision: "deny" | "allow-once" | "allow-always" | "timeout" | "cancelled"
}

export type MessageSendingResult = {
  content?: string;
  cancel?: boolean;
};

export type GatewayMethodRequest = {
  req: {
    id: string;
    method: string;
  };
  params: Record<string, unknown>;
};

export type HookResult = void | BeforeAgentReplyResult | BeforePromptBuildResult | BeforeToolCallResult | MessageSendingResult;

const VOID_HOOKS: ReadonlySet<HookName> = new Set([
  "gateway_start",
  "session_start",
  "session_end",
  "agent_end",
  "llm_input",
  "llm_output",
]);

const CLAIMING_HOOKS: ReadonlySet<HookName> = new Set(["before_agent_reply"]);

function isVoidHook(hook: HookName): boolean {
  return VOID_HOOKS.has(hook);
}

function isClaimingHook(hook: HookName): boolean {
  return CLAIMING_HOOKS.has(hook);
}

export function fallbackHookResult(hook: HookName): HookResult | undefined {
  if (isVoidHook(hook)) return undefined;
  if (isClaimingHook(hook)) return { handled: false };
  return undefined;
}
