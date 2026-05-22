// Package core provides OpenClaw-specific hook handlers.

package core

import (
	"context"
	"encoding/json"
	"strings"

	"go.uber.org/zap"

	"esec-shield-daemon-edge/pkg/rpc"
	"esec-shield-daemon-edge/security"
)

// handleBeforeToolCall: blocks risky commands if session marked blocked by guardrail.
// Only blocks shell command tool calls with "command" parameter.
// Reports to telemetry for security audit logging.
func (p *PluginCore) handleBeforeToolCall(ctx context.Context, event rpc.OpenClawHookBeforeToolCallEvent, hookCtx *rpc.OpenClawHookToolContext) (any, *rpc.Error) {
	// Extract shell command from tool params
	cfg := p.configManager.getCurrent()
	if cfg.HighRiskInstructionDetection {
		p.logger.Debug("toolCallEventPara", zap.Any("params", event.Params))
		handled, result, checkResult := security.HandleOpenClawBeforeToolCall(event, hookCtx)
		if result != nil {
			p.logger.Debug("detected highRiskInstruction",
				zap.String("reson", result.BlockReason),
				zap.String("decision", checkResult.Reason),
				zap.String("ruleId", checkResult.RuleID),
				zap.Bool("block", result.Block),
				zap.String("tool", event.ToolName))
		}
		if handled {
			return result, nil
		}
	} else {
		p.logger.Warn("highRiskInstructionDetection=false",
			zap.String("tool", event.ToolName))
	}
	command := extractCommand(event.Params)
	if command == "" {
		return nil, nil
	}
	normalizedCommand := normalizeCommand(command)
	p.logger.Debug("tool call check",
		zap.String("toolName", event.ToolName),
		zap.String("command", normalizedCommand),
		zap.String("sessionKey", hookCtx.SessionKey))

	return nil, nil
}

// extractCommand: extracts shell command from tool params.
// Only handles tools with "command" field (shell, bash, exec).
func extractCommand(params any) string {
	if params == nil {
		return ""
	}
	if m, ok := params.(map[string]any); ok {
		if cmd, ok := m["command"].(string); ok {
			return cmd
		}
	}
	return ""
}

// normalizeCommand: collapses whitespace for consistent logging.
func normalizeCommand(cmd string) string {
	var result strings.Builder
	space := false
	for _, c := range cmd {
		if c == ' ' || c == '\t' || c == '\n' || c == '\r' {
			if !space {
				result.WriteRune(' ')
				space = true
			}
		} else {
			result.WriteRune(c)
			space = false
		}
	}
	return strings.TrimSpace(result.String())
}

func (p *PluginCore) gatewayMethodExample(ctx context.Context, req GatewayMethodReq, params json.RawMessage) (any, *rpc.Error) {
	return map[string]string{"result": "ok"}, nil
}

// registerOpenClawHandlers: registers all OpenClaw rpc handlers.
func (p *PluginCore) registerOpenClawHandlers(mux *rpc.Mux) {
	// hooks
	mux.Handle(rpc.HookBeforeToolCall, adaptHook(p.handleBeforeToolCall))

	// gateway method requests
	mux.Handle("gw_method:example", adaptGatewayMethod(p.gatewayMethodExample))

	// functions
	mux.Handle("func:on_resolution", p.HookBeforeToolCallOnResolution)
}

func (p *PluginCore) HookBeforeToolCallOnResolution(ctx context.Context, params json.RawMessage) (any, *rpc.Error) {
	p.logger.Info("HookBeforeToolCallOnResolution", zap.ByteString("params", params))
	return nil, nil
}
