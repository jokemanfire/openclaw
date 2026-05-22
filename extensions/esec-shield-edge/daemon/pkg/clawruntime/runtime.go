// Package clawruntime defines runtime-agnostic hook types and constants.
// Used by rpc package to dispatch hook events to appropriate handlers.
//
// Supported runtimes:
// - openclaw: OpenClaw Plugin SDK hooks (TypeScript gateway)
// - zeroclaw: ZeroClaw Rust hooks (Rust agent runtime)
//
// Hook naming convention:
// - Wire format: "hook:xxx" (e.g., "hook:gateway_start")
// - OpenClaw SDK uses bare names: "gateway_start"
// - Register strips "hook:" prefix when sending to plugin
package clawruntime

type ClawRuntime string

const (
	RuntimeOpenClaw ClawRuntime = "openclaw"
	RuntimeZeroClaw ClawRuntime = "zeroclaw"
)

// HookName: wire format method name for JSON-RPC requests.
// Format: "hook:xxx" where xxx is the hook name from OpenClaw/ZeroClaw.
type HookName = string

// Hook constants - aligned with OpenClaw Plugin Hooks and ZeroClaw Rust hooks.
// Void hooks: parallel, fire-and-forget (gateway_start, session_start, session_end, agent_end, llm_input, llm_output)
// Modifying hooks: sequential, can modify/cancel (before_agent_reply, before_prompt_build, before_tool_call, message_sending)
const (
	HookGatewayStart      HookName = "hook:gateway_start"
	HookSessionStart      HookName = "hook:session_start"
	HookSessionEnd        HookName = "hook:session_end"
	HookBeforeAgentReply  HookName = "hook:before_agent_reply"
	HookBeforePromptBuild HookName = "hook:before_prompt_build"
	HookBeforeToolCall    HookName = "hook:before_tool_call"
	HookAgentEnd          HookName = "hook:agent_end"
	HookLlmInput          HookName = "hook:llm_input"
	HookLlmOutput         HookName = "hook:llm_output"
	HookMessageSending    HookName = "hook:message_sending"
)

type HookNames []HookName

func (h HookNames) ToStrings() []string {
	result := make([]string, len(h))
	for i, name := range h {
		result[i] = string(name)
	}
	return result
}
