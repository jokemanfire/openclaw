package security

import (
	"encoding/json"
	"esec-shield-daemon-edge/pkg/rpc"
	"strings"
)

func HandleOpenClawBeforeToolCall(event rpc.OpenClawHookBeforeToolCallEvent, hookCtx *rpc.OpenClawHookToolContext) (bool, *rpc.OpenClawHookBeforeToolCallResult, CheckResult) {
	params := toOpenClawParamMap(event.Params)
	toolName := strings.ToLower(strings.TrimSpace(event.ToolName))
	if toolName == "" && hookCtx.ToolName != "" {
		toolName = strings.ToLower(strings.TrimSpace(hookCtx.ToolName))
	}

	policy, err := LoadPolicy(nil)
	if err != nil {
		return false, nil, CheckResult{}
	}
	result := CheckToolCall(toolName, params, ToolContext{
		CurrentSessionKey: hookCtx.SessionKey,
		CurrentAgentID:    hookCtx.AgentID,
		CWD:               openClawCWD(params),
	}, policy)

	switch result.Decision {
	case DecisionDeny:
		return true, &rpc.OpenClawHookBeforeToolCallResult{
				Block:       true,
				BlockReason: BuildDenyBlockReason(toolName, params, result)},
			result
	case DecisionAsk:
		return true, &rpc.OpenClawHookBeforeToolCallResult{
				Block:       true,
				BlockReason: BuildAskBlockReason(toolName, params, result),
			},
			result
	default:
		if result.Params != nil {
			return true, &rpc.OpenClawHookBeforeToolCallResult{Params: result.Params},
				result
		}
		return false, &rpc.OpenClawHookBeforeToolCallResult{}, result
	}
}

func toOpenClawParamMap(value any) map[string]any {
	if value == nil {
		return map[string]any{}
	}
	if m, ok := value.(map[string]any); ok {
		return m
	}
	raw, err := json.Marshal(value)
	if err != nil {
		return map[string]any{}
	}
	var out map[string]any
	if json.Unmarshal(raw, &out) != nil {
		return map[string]any{}
	}
	return out
}

func openClawCWD(params map[string]any) string {
	for _, key := range []string{"cwd", "workdir", "workingDirectory"} {
		if value, ok := params[key].(string); ok && strings.TrimSpace(value) != "" {
			return value
		}
	}
	return ""
}
