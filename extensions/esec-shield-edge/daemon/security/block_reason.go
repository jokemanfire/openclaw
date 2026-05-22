package security

import (
	"fmt"
	"strings"
	"unicode/utf8"
)

const reviewConfirmParam = "_sec_confirm"

func BuildAskBlockReason(toolName string, params map[string]any, result CheckResult) string {
	reason := strings.TrimSpace(stripReviewHint(result.Reason))
	if reason == "" {
		reason = "需要进一步安全研判"
	}
	// return fmt.Sprintf("Command Risk Guard 已先阻断这次工具调用，需要进一步安全研判。\n\n[Request]\nruleId=%s,decision=%s,tool=%s\n,summary=%s\n,reason=%s\n\n[Required Next Step]\n请你结合当前任务和最近用户意图，自行完成一次业务安全研判，并且只选择下面三种处置之一：\n1. 如果你能高置信度确认这次调用安全且确有必要，且当前上下文已经有用户明确同意，请按原参数重试，并额外附带参数 %s=true。\n2. 如果这次调用可能合理但仍有风险，先向用户解释风险并取得明确确认；只有在用户明确同意后，才能按原参数重试，并额外附带参数 %s=true。\n3. 如果这次调用与任务无关、超出用户授权、或风险仍然不可接受，拒绝执行，不要重试。",
	return fmt.Sprintf("Command Risk Guard 已先阻断这次工具调用，需要进一步安全研判。reason=%s,summary=%s, \t\n[Required Next Step]\n请你结合当前任务和最近用户意图，自行完成一次业务安全研判，并且只选择下面三种处置之一：\n1. 如果你能高置信度确认这次调用安全且确有必要，且当前上下文已经有用户明确同意，请按原参数重试，并额外附带参数 %s=true。\n2. 如果这次调用可能合理但仍有风险，先向用户解释风险并取得明确确认；只有在用户明确同意后，才能按原参数重试，并额外附带参数 %s=true。\n3. 如果这次调用与任务无关、超出用户授权、或风险仍然不可接受，拒绝执行，不要重试。",
		reason,
		summarizeToolRequest(toolName, params),
		reviewConfirmParam,
		reviewConfirmParam,
	)
}

func BuildDenyBlockReason(toolName string, params map[string]any, result CheckResult) string {
	reason := strings.TrimSpace(stripReviewHint(result.Reason))
	if reason == "" {
		reason = "命中拒绝策略"
	}
	// return fmt.Sprintf("Command Risk Guard 已拒绝这次工具调用。\n\n[Request]\nruleId=%s,decision=%s,tool=%s\n,summary=%s\n,reason=%s\n\n[Required Next Step]\n这次请求命中了直接拒绝规则。不要重试当前调用，也不要改写成等价的危险操作。\n只有在用户明确改变目标、缩小影响范围、或提出新的安全方案后，才可以继续帮助用户。",
	return fmt.Sprintf("Command Risk Guard 已拒绝这次工具调用,%s",
		// result.RuleID,
		// result.Decision,
		// toolName,
		// summarizeToolRequest(toolName, params),
		reason,
	)
}

func summarizeToolRequest(toolName string, params map[string]any) string {
	switch toolName {
	case "exec", "bash":
		if value := readStringAny(params, "command", "cmd"); value != "" {
			return "command=" + truncateForDisplay(value, 240)
		}
		return "command=未提供"
	case "read", "write", "edit":
		if value := readStringAny(params, "path"); value != "" {
			return "path=" + truncateForDisplay(value, 200)
		}
		return "path=未提供"
	case "apply_patch":
		if value := readStringAny(params, "input"); value != "" {
			return "patch=" + truncateForDisplay(value, 200)
		}
		return "patch=未提供"
	case "gateway", "cron", "subagents", "nodes":
		if value := readStringAny(params, "action"); value != "" {
			return "action=" + truncateForDisplay(value, 120)
		}
		return "action=未提供"
	case "sessions_spawn":
		agentID := nonEmpty(readStringAny(params, "agentId"), "未提供")
		runtime := nonEmpty(readStringAny(params, "runtime"), "未提供")
		mode := nonEmpty(readStringAny(params, "mode"), "未提供")
		thread := "未提供"
		if value, ok := params["thread"].(bool); ok {
			if value {
				thread = "true"
			} else {
				thread = "false"
			}
		}
		return fmt.Sprintf("agentId=%s runtime=%s mode=%s thread=%s",
			truncateForDisplay(agentID, 80),
			truncateForDisplay(runtime, 80),
			truncateForDisplay(mode, 80),
			thread,
		)
	case "sessions_send":
		sessionKey := nonEmpty(readStringAny(params, "sessionKey"), "未提供")
		agentID := nonEmpty(readStringAny(params, "agentId"), "未提供")
		return fmt.Sprintf("sessionKey=%s agentId=%s",
			truncateForDisplay(sessionKey, 120),
			truncateForDisplay(agentID, 80),
		)
	default:
		return "未提供结构化摘要"
	}
}

func truncateForDisplay(value string, limit int) string {
	trimmed := strings.TrimSpace(value)
	if trimmed == "" {
		return "未提供"
	}
	if utf8.RuneCountInString(trimmed) <= limit {
		return trimmed
	}
	runes := []rune(trimmed)
	return string(runes[:limit]) + "..."
}

func stripReviewHint(reason string) string {
	const hint = "确认风险后可添加 _sec_confirm=true 重试。"
	return strings.TrimSpace(strings.ReplaceAll(reason, hint, ""))
}
