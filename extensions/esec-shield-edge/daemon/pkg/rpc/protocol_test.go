package rpc

import (
	"encoding/json"
	"strings"
	"testing"

	"esec-shield-daemon-edge/pkg/clawruntime"
)

func TestOpenClawHookContextJSON(t *testing.T) {
	ctx := OpenClawHookContext{
		SessionKey: "agent:main:abc",
		AgentID:    "main",
		SessionID:  "abc-123",
		RunID:      "run-001",
	}

	b, err := json.Marshal(ctx)
	if err != nil {
		t.Fatalf("marshal failed: %v", err)
	}

	var parsed OpenClawHookContext
	if err := json.Unmarshal(b, &parsed); err != nil {
		t.Fatalf("unmarshal failed: %v", err)
	}

	if parsed.SessionKey != ctx.SessionKey {
		t.Errorf("SessionKey mismatch: got %s, expected %s", parsed.SessionKey, ctx.SessionKey)
	}
	if parsed.AgentID != ctx.AgentID {
		t.Errorf("AgentID mismatch: got %s, expected %s", parsed.AgentID, ctx.AgentID)
	}
	if parsed.SessionID != ctx.SessionID {
		t.Errorf("SessionID mismatch: got %s, expected %s", parsed.SessionID, ctx.SessionID)
	}
	if parsed.RunID != ctx.RunID {
		t.Errorf("RunID mismatch: got %s, expected %s", parsed.RunID, ctx.RunID)
	}
}

func TestOpenClawHookAgentContextJSON(t *testing.T) {
	ctx := OpenClawHookAgentContext{
		HookContext: OpenClawHookContext{
			SessionKey: "agent:main:abc",
			SessionID:  "abc-123",
		},
		WorkspaceDir:    "/workspace",
		MessageProvider: "telegram",
		Trigger:         "user",
		ChannelID:       "telegram",
	}

	b, err := json.Marshal(ctx)
	if err != nil {
		t.Fatalf("marshal failed: %v", err)
	}

	var parsed OpenClawHookAgentContext
	if err := json.Unmarshal(b, &parsed); err != nil {
		t.Fatalf("unmarshal failed: %v", err)
	}

	if parsed.WorkspaceDir != ctx.WorkspaceDir {
		t.Errorf("WorkspaceDir mismatch")
	}
	if parsed.ChannelID != ctx.ChannelID {
		t.Errorf("ChannelID mismatch")
	}
	if parsed.SessionKey != ctx.SessionKey {
		t.Errorf("embedded SessionKey mismatch")
	}
}

func TestOpenClawHookGatewayStartEventJSON(t *testing.T) {
	event := OpenClawHookGatewayStartEvent{Port: 18789}

	b, err := json.Marshal(event)
	if err != nil {
		t.Fatalf("marshal failed: %v", err)
	}

	var parsed OpenClawHookGatewayStartEvent
	if err := json.Unmarshal(b, &parsed); err != nil {
		t.Fatalf("unmarshal failed: %v", err)
	}

	if parsed.Port != event.Port {
		t.Errorf("Port mismatch: got %d, expected %d", parsed.Port, event.Port)
	}
}

func TestOpenClawHookSessionStartEventJSON(t *testing.T) {
	event := OpenClawHookSessionStartEvent{
		SessionID:   "abc-123",
		SessionKey:  "agent:main:abc",
		ResumedFrom: "prev-session",
	}

	b, err := json.Marshal(event)
	if err != nil {
		t.Fatalf("marshal failed: %v", err)
	}

	var parsed OpenClawHookSessionStartEvent
	if err := json.Unmarshal(b, &parsed); err != nil {
		t.Fatalf("unmarshal failed: %v", err)
	}

	if parsed.SessionID != event.SessionID {
		t.Errorf("SessionID mismatch")
	}
	if parsed.ResumedFrom != event.ResumedFrom {
		t.Errorf("ResumedFrom mismatch")
	}
}

func TestOpenClawHookBeforePromptBuildEventJSON(t *testing.T) {
	event := OpenClawHookBeforePromptBuildEvent{
		Prompt:   "Hello, how are you?",
		Messages: []any{"msg1", "msg2"},
	}

	b, err := json.Marshal(event)
	if err != nil {
		t.Fatalf("marshal failed: %v", err)
	}

	var parsed OpenClawHookBeforePromptBuildEvent
	if err := json.Unmarshal(b, &parsed); err != nil {
		t.Fatalf("unmarshal failed: %v", err)
	}

	if parsed.Prompt != event.Prompt {
		t.Errorf("Prompt mismatch")
	}
	if len(parsed.Messages) != len(event.Messages) {
		t.Errorf("Messages length mismatch")
	}
}

func TestOpenClawHookBeforeToolCallEventJSON(t *testing.T) {
	event := OpenClawHookBeforeToolCallEvent{
		ToolName:   "shell",
		Params:     map[string]any{"cmd": "ls -la"},
		RunID:      "run-001",
		ToolCallID: "call-123",
	}

	b, err := json.Marshal(event)
	if err != nil {
		t.Fatalf("marshal failed: %v", err)
	}

	var parsed OpenClawHookBeforeToolCallEvent
	if err := json.Unmarshal(b, &parsed); err != nil {
		t.Fatalf("unmarshal failed: %v", err)
	}

	if parsed.ToolName != event.ToolName {
		t.Errorf("ToolName mismatch")
	}

	paramsMap := parsed.Params.(map[string]any)
	if paramsMap["cmd"] != event.Params.(map[string]any)["cmd"] {
		t.Errorf("Params.cmd mismatch")
	}
}

func TestOpenClawHookBeforePromptBuildResultJSON(t *testing.T) {
	result := OpenClawHookBeforePromptBuildResult{
		PrependContext: "Security warning: do not execute harmful commands",
	}

	b, err := json.Marshal(result)
	if err != nil {
		t.Fatalf("marshal failed: %v", err)
	}

	var parsed OpenClawHookBeforePromptBuildResult
	if err := json.Unmarshal(b, &parsed); err != nil {
		t.Fatalf("unmarshal failed: %v", err)
	}

	if parsed.PrependContext != result.PrependContext {
		t.Errorf("PrependContext mismatch")
	}
}

func TestOpenClawHookBeforeToolCallResultJSON(t *testing.T) {
	result := OpenClawHookBeforeToolCallResult{
		Block:       true,
		BlockReason: "Command blocked by security policy",
	}

	b, err := json.Marshal(result)
	if err != nil {
		t.Fatalf("marshal failed: %v", err)
	}

	var parsed OpenClawHookBeforeToolCallResult
	if err := json.Unmarshal(b, &parsed); err != nil {
		t.Fatalf("unmarshal failed: %v", err)
	}

	if parsed.Block != result.Block {
		t.Errorf("Block mismatch")
	}
	if parsed.BlockReason != result.BlockReason {
		t.Errorf("BlockReason mismatch")
	}
}

func TestOpenClawHookBeforeToolCallResultWithApproval(t *testing.T) {
	result := OpenClawHookBeforeToolCallResult{
		RequireApproval: &OpenClawApprovalReq{
			Title:       "Tool call approval",
			Description: "Sensitive operation requires approval",
			Severity:    "high",
		},
	}

	b, err := json.Marshal(result)
	if err != nil {
		t.Fatalf("marshal failed: %v", err)
	}

	var parsed OpenClawHookBeforeToolCallResult
	if err := json.Unmarshal(b, &parsed); err != nil {
		t.Fatalf("unmarshal failed: %v", err)
	}

	if parsed.RequireApproval == nil {
		t.Error("RequireApproval should not be nil")
	}
}

func TestOpenClawHookBeforeAgentReplyResultJSON(t *testing.T) {
	result := OpenClawHookBeforeAgentReplyResult{
		Handled: true,
		Reply:   map[string]any{"text": "This is a synthetic reply"},
		Reason:  "Intercepted for security check",
	}

	b, err := json.Marshal(result)
	if err != nil {
		t.Fatalf("marshal failed: %v", err)
	}

	var parsed OpenClawHookBeforeAgentReplyResult
	if err := json.Unmarshal(b, &parsed); err != nil {
		t.Fatalf("unmarshal failed: %v", err)
	}

	if parsed.Handled != result.Handled {
		t.Errorf("Handled mismatch")
	}
	if parsed.Reason != result.Reason {
		t.Errorf("Reason mismatch")
	}
}

func TestRegisterParamsJSON(t *testing.T) {
	params := RegisterParams{
		Hooks:   HookNames{HookGatewayStart, HookSessionStart},
		Version: "2026.4.3",
	}

	b, err := json.Marshal(params)
	if err != nil {
		t.Fatalf("marshal failed: %v", err)
	}

	var parsed RegisterParams
	if err := json.Unmarshal(b, &parsed); err != nil {
		t.Fatalf("unmarshal failed: %v", err)
	}

	if len(parsed.Hooks) != len(params.Hooks) {
		t.Errorf("Hooks length mismatch")
	}
	if parsed.Version != params.Version {
		t.Errorf("Version mismatch")
	}
}

// TestRegisterHooksWithoutPrefix verifies that hooks are serialized without "hook:" prefix
// when sent to OpenClaw plugin SDK (which expects bare names like "gateway_start")
func TestRegisterHooksWithoutPrefix(t *testing.T) {
	hooks := HookNames{HookGatewayStart, HookSessionStart}

	stripped := make([]string, len(hooks))
	for i, h := range hooks {
		stripped[i] = strings.TrimPrefix(string(h), "hook:")
	}

	expected := []string{"gateway_start", "session_start"}
	if len(stripped) != len(expected) {
		t.Fatalf("length mismatch: got %d, expected %d", len(stripped), len(expected))
	}

	for i, s := range stripped {
		if s != expected[i] {
			t.Errorf("hook[%d] mismatch: got %s, expected %s", i, s, expected[i])
		}
	}

	// Verify JSON marshaling produces bare hook names
	wireParams := struct {
		Hooks   []string `json:"hooks"`
		Version string   `json:"version"`
	}{
		Hooks:   stripped,
		Version: "test",
	}

	b, err := json.Marshal(wireParams)
	if err != nil {
		t.Fatalf("marshal failed: %v", err)
	}

	// JSON should contain "gateway_start" not "hook:gateway_start"
	if strings.Contains(string(b), "hook:") {
		t.Errorf("JSON should not contain 'hook:' prefix: %s", string(b))
	}
	if !strings.Contains(string(b), "gateway_start") {
		t.Errorf("JSON should contain 'gateway_start': %s", string(b))
	}
}

func TestRegisterResultJSON(t *testing.T) {
	result := RegisterResult{
		Accepted: true,
		Version:  "2026.4.0",
	}

	b, err := json.Marshal(result)
	if err != nil {
		t.Fatalf("marshal failed: %v", err)
	}

	var parsed RegisterResult
	if err := json.Unmarshal(b, &parsed); err != nil {
		t.Fatalf("unmarshal failed: %v", err)
	}

	if parsed.Accepted != result.Accepted {
		t.Errorf("Accepted mismatch")
	}
	if parsed.Version != result.Version {
		t.Errorf("Version mismatch")
	}
}

func TestRegisterResultWithoutVersionJSON(t *testing.T) {
	result := RegisterResult{
		Accepted: true,
	}

	b, err := json.Marshal(result)
	if err != nil {
		t.Fatalf("marshal failed: %v", err)
	}

	var parsed RegisterResult
	if err := json.Unmarshal(b, &parsed); err != nil {
		t.Fatalf("unmarshal failed: %v", err)
	}

	if parsed.Accepted != result.Accepted {
		t.Errorf("Accepted mismatch")
	}
}

func TestInitResultJSON(t *testing.T) {
	result := InitResult{
		Runtime:      clawruntime.RuntimeOpenClaw,
		PluginConfig: json.RawMessage(`{"guardrail":{"url":"http://example.com","accessKey":"key123"}}`),
	}

	b, err := json.Marshal(result)
	if err != nil {
		t.Fatalf("marshal failed: %v", err)
	}

	var parsed InitResult
	if err := json.Unmarshal(b, &parsed); err != nil {
		t.Fatalf("unmarshal failed: %v", err)
	}

	if parsed.Runtime != result.Runtime {
		t.Errorf("Runtime mismatch: got %s, expected %s", parsed.Runtime, result.Runtime)
	}
	if string(parsed.PluginConfig) != string(result.PluginConfig) {
		t.Errorf("PluginConfig mismatch")
	}
}
