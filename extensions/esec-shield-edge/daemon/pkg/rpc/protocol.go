// Package rpc provides JSON-RPC 2.0 protocol types for daemon-plugin communication.
//
// Protocol flow:
// 1. init: daemon → plugin, get runtime + pluginConfig + deviceInfo + userInfo
//   - Runtime: determines which hook handler set to use (openclaw or zeroclaw)
//   - PluginConfig: JSON from plugin config, used to build deps (guardrail client, etc)
//   - DeviceInfo: JSON device fingerprint (osType, machineCode, ipAddress, machineName)
//   - UserInfo: JSON user identity (userId) for telemetry
//
// 2. register: daemon → plugin, subscribe hooks, negotiate version
//   - Hooks: list of hook names daemon wants to receive (without "hook:" prefix)
//   - Version: daemon version for compatibility negotiation
//   - Plugin responds with accepted=true/false
//
// 3. hook events: plugin → daemon, runtime hook invocations (loop)
//   - Method: "hook:xxx" where xxx is hook name
//   - Params: {event: {...}, context: {...}}
//   - Daemon responds with hook-specific result or error
//
// Type aliases:
// - OpenClawXxx: types for OpenClaw Plugin SDK hooks
// - ZeroClawXxx: types for ZeroClaw Rust hooks
// - Handlers use appropriate types based on runtime from init
package rpc

import (
	"encoding/json"

	"esec-shield-daemon-edge/pkg/clawruntime"
	"esec-shield-daemon-edge/pkg/clawruntime/openclaw"
	"esec-shield-daemon-edge/pkg/clawruntime/zeroclaw"
)

// JSON-RPC 2.0 error codes (standard + internal)
const (
	ErrCodeParse    = -32700 // Parse error
	ErrCodeInvalid  = -32600 // Invalid Request
	ErrCodeNotFound = -32601 // Method not found
	ErrCodeInternal = -32603 // Internal error
)

// Method names for daemon→plugin control messages
const MethodInit = "init"         // Phase 1: get runtime/config/deviceInfo/userInfo
const MethodRegister = "register" // Phase 2: subscribe hooks, negotiate version

// HookName/HookNames: aliases from clawruntime package
type HookName = clawruntime.HookName
type HookNames = clawruntime.HookNames

// Hook constants: wire format method names
const (
	HookGatewayStart      HookName = clawruntime.HookGatewayStart
	HookSessionStart      HookName = clawruntime.HookSessionStart
	HookSessionEnd        HookName = clawruntime.HookSessionEnd
	HookBeforeAgentReply  HookName = clawruntime.HookBeforeAgentReply
	HookBeforePromptBuild HookName = clawruntime.HookBeforePromptBuild
	HookBeforeToolCall    HookName = clawruntime.HookBeforeToolCall
	HookAgentEnd          HookName = clawruntime.HookAgentEnd
	HookLlmInput          HookName = clawruntime.HookLlmInput
	HookLlmOutput         HookName = clawruntime.HookLlmOutput
	HookMessageSending    HookName = clawruntime.HookMessageSending
)

// Request: JSON-RPC 2.0 request from plugin to daemon.
type Request struct {
	Jsonrpc string          `json:"jsonrpc"`
	ID      int             `json:"id"`
	Method  string          `json:"method"`
	Params  json.RawMessage `json:"params"`
}

// Response: JSON-RPC 2.0 response from daemon to plugin.
type Response struct {
	Jsonrpc string          `json:"jsonrpc"`
	ID      int             `json:"id"`
	Result  json.RawMessage `json:"result,omitempty"`
	Error   *Error          `json:"error,omitempty"`
}

// RegisterParams: daemon's register request params.
// Hooks: list of hook names to subscribe (daemon sends without "hook:" prefix)
type RegisterParams struct {
	Hooks   []HookName `json:"hooks"`
	Version string     `json:"version"`
}

type InitParams struct{}

// InitResult: response from plugin to daemon's init request.
// Runtime: determines which hook handler set to use (openclaw or zeroclaw)
// PluginConfig: JSON from plugin config, used to build deps (guardrail client, etc)
type InitResult struct {
	Runtime      clawruntime.ClawRuntime `json:"runtime"`
	PluginConfig json.RawMessage         `json:"pluginConfig"`
}

// RegisterResult: response from plugin to daemon's register request.
// Accepted: must be true for daemon to proceed; false causes daemon exit
// Version: negotiated plugin version (daemon logs it, may use for compat checks)
type RegisterResult struct {
	Accepted bool   `json:"accepted"`
	Version  string `json:"version"`
}

// Error: JSON-RPC 2.0 error object.
type Error struct {
	Code    int             `json:"code"`
	Message string          `json:"message"`
	Data    json.RawMessage `json:"data,omitempty"`
}

func NewError(code int, message string, data json.RawMessage) *Error {
	return &Error{
		Code:    code,
		Message: message,
		Data:    data,
	}
}

func (e *Error) Error() string {
	return e.Message
}

// HookEventParams: params for hook event requests.
// Event: hook-specific event data (prompt, messages, tool params, etc)
// Context: hook context (sessionKey, agentId, sessionId, runId, etc)
type HookEventParams struct {
	Event   json.RawMessage `json:"event"`
	Context json.RawMessage `json:"context"`
}

// OpenClaw type aliases: import from openclaw package
// Used by handlers when runtime == "openclaw"
type (
	OpenClawHookContext        = openclaw.HookContext
	OpenClawHookAgentContext   = openclaw.HookAgentContext
	OpenClawHookSessionContext = openclaw.HookSessionContext
	OpenClawHookGatewayContext = openclaw.HookGatewayContext
	OpenClawHookToolContext    = openclaw.HookToolContext

	OpenClawHookGatewayStartEvent      = openclaw.HookGatewayStartEvent
	OpenClawHookSessionStartEvent      = openclaw.HookSessionStartEvent
	OpenClawHookSessionEndEvent        = openclaw.HookSessionEndEvent
	OpenClawHookAgentEndEvent          = openclaw.HookAgentEndEvent
	OpenClawHookLlmInputEvent          = openclaw.HookLlmInputEvent
	OpenClawHookLlmOutputEvent         = openclaw.HookLlmOutputEvent
	OpenClawHookBeforePromptBuildEvent = openclaw.HookBeforePromptBuildEvent
	OpenClawHookBeforeAgentReplyEvent  = openclaw.HookBeforeAgentReplyEvent
	OpenClawHookBeforeToolCallEvent    = openclaw.HookBeforeToolCallEvent

	OpenClawHookBeforePromptBuildResult = openclaw.HookBeforePromptBuildResult
	OpenClawHookBeforeAgentReplyResult  = openclaw.HookBeforeAgentReplyResult
	OpenClawHookBeforeToolCallResult    = openclaw.HookBeforeToolCallResult
	OpenClawApprovalReq                 = openclaw.ApprovalReq

	OpenClawHookMessageContext       = openclaw.HookMessageContext
	OpenClawHookMessageSendingEvent  = openclaw.HookMessageSendingEvent
	OpenClawHookMessageSendingResult = openclaw.HookMessageSendingResult
)

// ZeroClaw type aliases: import from zeroclaw package
// Used by handlers when runtime == "zeroclaw"
type (
	ZeroClawHookContext        = zeroclaw.HookContext
	ZeroClawHookAgentContext   = zeroclaw.HookAgentContext
	ZeroClawHookSessionContext = zeroclaw.HookSessionContext
	ZeroClawHookGatewayContext = zeroclaw.HookGatewayContext
	ZeroClawHookToolContext    = zeroclaw.HookToolContext
	ZeroClawHookLlmContext     = zeroclaw.HookLlmContext

	ZeroClawHookGatewayStartEvent      = zeroclaw.HookGatewayStartEvent
	ZeroClawHookSessionStartEvent      = zeroclaw.HookSessionStartEvent
	ZeroClawHookSessionEndEvent        = zeroclaw.HookSessionEndEvent
	ZeroClawHookAgentEndEvent          = zeroclaw.HookAgentEndEvent
	ZeroClawHookLlmInputEvent          = zeroclaw.HookLlmInputEvent
	ZeroClawHookLlmOutputEvent         = zeroclaw.HookLlmOutputEvent
	ZeroClawHookBeforePromptBuildEvent = zeroclaw.HookBeforePromptBuildEvent
	ZeroClawHookBeforeAgentReplyEvent  = zeroclaw.HookBeforeAgentReplyEvent
	ZeroClawHookBeforeToolCallEvent    = zeroclaw.HookBeforeToolCallEvent

	ZeroClawHookBeforePromptBuildResult = zeroclaw.HookBeforePromptBuildResult
	ZeroClawHookBeforeToolCallResult    = zeroclaw.HookBeforeToolCallResult
)
