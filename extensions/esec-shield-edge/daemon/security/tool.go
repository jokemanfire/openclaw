package security

import (
	"encoding/json"
	"fmt"
	"strings"
)

func CheckToolCall(toolName string, params map[string]any, ctx ToolContext, policy *Policy) (result CheckResult) {
	defer func() {
		result = withReviewHint(result)
	}()
	tool := strings.ToLower(strings.TrimSpace(toolName))
	if reviewConfirmed(params) {
		return CheckResult{
			Decision:  DecisionAllow,
			Reason:    "用户已通过安全确认标志复核执行",
			Source:    "review-confirm",
			ParseKind: ParseSimple,
			Params:    stripReviewConfirm(params),
		}
	}
	// if policy != nil && !policy.Protects(tool) {
	// 	return allow("当前工具不在 command-risk-guard-go 的处理范围内，已忽略")
	// }
	if ctx.CWD == "" {
		ctx.CWD = "/"
	}
	if policy != nil && ctx.Mode != "" {
		policyCopy := *policy
		policyCopy.Mode = ctx.Mode
		policy = &policyCopy
	}
	switch tool {
	case "exec", "bash":
		command := readStringAny(params, "command", "cmd")
		if command == "" {
			return allow("exec 调用未提供命令，已忽略")
		}
		return CheckCommand(command, policy, ctx.CWD)
	case "nodes":
		return checkNodes(params, ctx, policy)
	case "read":
		return checkFileTool(fileRead, params, policy, ctx.CWD)
	case "write":
		return checkFileTool(fileWrite, params, policy, ctx.CWD)
	case "edit":
		return checkFileTool(fileWrite, params, policy, ctx.CWD)
	case "apply_patch":
		return checkApplyPatchTool(params, policy, ctx.CWD)
	case "cron", "gateway", "subagents":
		if tool == "cron" {
			return checkCronTool(params, ctx, policy)
		}
		action := strings.ToLower(readStringAny(params, "action", "name"))
		return checkNamedTool(tool, action, params, ctx, policy)
	case "sessions_spawn":
		return checkSessionsSpawn(params, ctx, policy)
	case "sessions_send":
		return checkSessionsSend(params, ctx, policy)
	default:
		command := readStringAny(params, "command", "cmd")
		if command == "" {
			return allow("exec 调用未提供命令，已忽略")
		}
		return CheckCommand(command, policy, ctx.CWD)

	}
	// return allow("当前工具不在 command-risk-guard-go 的处理范围内，已忽略")
}

func withReviewHint(result CheckResult) CheckResult {
	if result.Decision != DecisionAsk {
		return result
	}
	const hint = "确认风险后可添加 _sec_confirm=true 重试。"
	if !strings.Contains(result.Reason, "_sec_confirm=true") {
		result.Reason = strings.TrimSpace(result.Reason + "\n" + hint)
	}
	return result
}

func checkNodes(params map[string]any, ctx ToolContext, policy *Policy) CheckResult {
	action := strings.ToLower(readStringAny(params, "action"))
	switch action {
	case "run":
		command := formatCommandValue(params["command"])
		if command == "" {
			return allow("nodes.run 未提供命令，已忽略")
		}
		return CheckCommand(command, policy, ctx.CWD)
	case "invoke":
		command := extractNodeInvoke(params)
		if command == "" {
			return allow("nodes.invoke 不是可执行命令形态，已忽略")
		}
		return CheckCommand(command, policy, ctx.CWD)
	default:
		return checkNamedTool("nodes", action, params, ctx, policy)
	}
}

func checkFileTool(op fileOp, params map[string]any, policy *Policy, cwd string) CheckResult {
	path := readStringAny(params, "path", "file_path", "filePath", "filename")
	if path == "" {
		return allow("文件工具未提供路径，已忽略")
	}
	if hit, ok := checkPathAccess(path, op, "路径目标", policy, cwd, "file"); ok {
		return hit
	}
	return allow("文件操作已放行")
}

func checkApplyPatchTool(params map[string]any, policy *Policy, cwd string) CheckResult {
	patch := readStringAny(params, "patch", "input", "content")
	if patch == "" {
		if s, ok := params["cmd"].(string); ok {
			patch = s
		}
	}
	if patch == "" {
		return allow("apply_patch 未提供补丁内容，已忽略")
	}
	targets, err := parsePatchTargets(patch)
	if err != nil {
		return ask("apply_patch", "", err.Error())
	}
	for _, target := range targets {
		op := fileWrite
		if target.create {
			op = fileCreate
		}
		if hit, ok := checkPathAccess(target.path, op, "补丁目标 "+target.path, policy, cwd, "apply_patch"); ok {
			return hit
		}
	}
	return allow("补丁操作已放行")
}

type patchTarget struct {
	path   string
	create bool
}

func parsePatchTargets(patch string) ([]patchTarget, error) {
	var targets []patchTarget
	sawBegin := false
	sawEnd := false
	sawUpdate := false
	for _, raw := range strings.Split(patch, "\n") {
		line := strings.TrimRight(raw, "\r")
		switch {
		case line == "*** Begin Patch":
			sawBegin = true
		case line == "*** End Patch":
			sawEnd = true
		case strings.HasPrefix(line, "*** Add File: "):
			path := strings.TrimSpace(strings.TrimPrefix(line, "*** Add File: "))
			if path == "" {
				return nil, fmt.Errorf("补丁中的 Add File 目标为空")
			}
			targets = append(targets, patchTarget{path: path, create: true})
			sawUpdate = false
		case strings.HasPrefix(line, "*** Delete File: "):
			path := strings.TrimSpace(strings.TrimPrefix(line, "*** Delete File: "))
			if path == "" {
				return nil, fmt.Errorf("补丁中的 Delete File 目标为空")
			}
			targets = append(targets, patchTarget{path: path})
			sawUpdate = false
		case strings.HasPrefix(line, "*** Update File: "):
			path := strings.TrimSpace(strings.TrimPrefix(line, "*** Update File: "))
			if path == "" {
				return nil, fmt.Errorf("补丁中的 Update File 目标为空")
			}
			targets = append(targets, patchTarget{path: path})
			sawUpdate = true
		case strings.HasPrefix(line, "*** Move to: "):
			if !sawUpdate {
				return nil, fmt.Errorf("补丁中的 Move to 之前缺少 Update File")
			}
			path := strings.TrimSpace(strings.TrimPrefix(line, "*** Move to: "))
			if path == "" {
				return nil, fmt.Errorf("补丁中的 Move to 目标为空")
			}
			targets = append(targets, patchTarget{path: path, create: true})
		}
	}
	if !sawBegin || !sawEnd {
		return nil, fmt.Errorf("补丁缺少必要的 Begin/End 标记")
	}
	if len(targets) == 0 {
		return nil, fmt.Errorf("补丁没有引用任何文件目标")
	}
	return targets, nil
}

func checkNamedTool(tool, action string, params map[string]any, ctx ToolContext, policy *Policy) CheckResult {
	if action == "" {
		return allow(tool + " 调用未提供 action，已忽略")
	}
	cfg, ok := policy.ToolPolicy.Named[tool]
	if !ok {
		return allow("当前工具不在结构化策略范围内，已忽略")
	}
	if containsFold(cfg.DenyActions, action) {
		return deny("tool", "tool."+tool+"."+action, tool+"."+action+" 已被策略拒绝")
	}
	if containsFold(cfg.AllowActions, action) {
		return allow("结构化工具操作已放行")
	}
	if tool == "gateway" && mutatesSensitiveConfig(params, cfg.SensitiveConfigKeys) {
		return deny("tool", "tool.gateway.sensitive-config", "gateway 配置修改触及敏感键，已拒绝")
	}
	if containsFold(cfg.MutateActions, action) || containsFold(cfg.AskActions, action) || cfg.DefaultAction == "ask" || cfg.DefaultAction == "" {
		return ask("tool", "tool."+tool+"."+action, tool+"."+action+" 需要人工审批")
	}
	return allow("结构化工具操作已放行")
}

func checkCronTool(params map[string]any, ctx ToolContext, policy *Policy) CheckResult {
	action := strings.ToLower(readStringAny(params, "action"))
	if action == "" {
		return allow("cron 调用未提供 action，已忽略")
	}
	cfg := policy.ToolPolicy.Cron
	if containsFold(cfg.DenyActions, action) {
		return deny("tool", "tool.cron."+action, "cron."+action+" 已被策略拒绝")
	}
	if containsFold(cfg.AllowActions, action) {
		return allow("cron 操作已放行")
	}
	payloadKind := readStringAny(params, "payloadKind", "payload_kind")
	if containsFold(cfg.MutateActions, action) || containsFold(cfg.AskActions, action) || containsFold(cfg.AutonomousPayloadKinds, payloadKind) {
		return ask("tool", "tool.cron."+action, "cron."+action+" 需要人工审批")
	}
	return ask("tool", "tool.cron."+action, "cron."+action+" 需要人工审批")
}

func checkSessionsSpawn(params map[string]any, ctx ToolContext, policy *Policy) CheckResult {
	cfg := policy.ToolPolicy.SessionsSpawn
	runtime := strings.ToLower(readStringAny(params, "runtime"))
	mode := strings.ToLower(readStringAny(params, "mode"))
	if containsFold(cfg.AskRuntimes, runtime) || containsFold(cfg.AskModes, mode) {
		return ask("tool", "tool.sessions_spawn", "sessions_spawn 目标运行时或模式需要人工审批")
	}
	if boolParam(params, "threadRequested", "thread") && boolPtrValue(cfg.AskWhenThreadRequested, true) {
		return ask("tool", "tool.sessions_spawn.thread", "sessions_spawn 请求新线程，需要人工审批")
	}
	targetAgent := readStringAny(params, "agentId", "targetAgentId")
	if targetAgent != "" && ctx.CurrentAgentID != "" && targetAgent != ctx.CurrentAgentID && boolPtrValue(cfg.AskWhenCrossAgent, true) {
		return ask("tool", "tool.sessions_spawn.cross-agent", "sessions_spawn 跨 agent 创建会话，需要人工审批")
	}
	targetSession := readStringAny(params, "sessionKey", "targetSessionKey")
	if targetSession != "" && ctx.CurrentSessionKey == "" && boolPtrValue(cfg.AskWhenTargetWithoutCurrent, true) {
		return ask("tool", "tool.sessions_spawn.target-without-current", "sessions_spawn 指定目标但当前会话未知，需要人工审批")
	}
	return allow("sessions_spawn 操作已放行")
}

func checkSessionsSend(params map[string]any, ctx ToolContext, policy *Policy) CheckResult {
	cfg := policy.ToolPolicy.SessionsSend
	targetSession := readStringAny(params, "sessionKey", "targetSessionKey")
	targetAgent := readStringAny(params, "agentId", "targetAgentId")
	if targetSession != "" && targetSession == ctx.CurrentSessionKey && boolPtrValue(cfg.AllowSameSession, true) {
		return allow("同会话 sessions_send 已放行")
	}
	if targetSession == "" && targetAgent != "" && targetAgent == ctx.CurrentAgentID && boolPtrValue(cfg.AllowSameAgentWithoutSession, true) {
		return allow("同 agent sessions_send 已放行")
	}
	if cfg.DefaultAction == "deny" {
		return deny("tool", "tool.sessions_send", "sessions_send 目标不满足放行条件，已拒绝")
	}
	return ask("tool", "tool.sessions_send", "sessions_send 目标不满足自动放行条件，需要人工审批")
}

// readStringAny 从参数映射中按优先级顺序查找并返回第一个匹配的字符串值。
// 支持多种键名变体，用于处理不同来源的参数格式差异。
// 如果找到的值是字符串类型，直接返回；如果是数组类型，则拼接为空格分隔的字符串。
// 参数:
//   - params: 参数映射表
//   - keys: 按优先级排序的键名列表
//
// 返回值:
//   - 匹配的第一个有效字符串值，如果未找到则返回空字符串
func readStringAny(params map[string]any, keys ...string) string {
	for _, key := range keys {
		if value, ok := params[key]; ok {
			switch v := value.(type) {
			case string:
				return v
			case []any:
				return formatCommandValue(v)
			}
		}
	}
	return ""
}

func formatCommandValue(value any) string {
	switch v := value.(type) {
	case string:
		return v
	case []any:
		parts := make([]string, 0, len(v))
		for _, item := range v {
			parts = append(parts, fmt.Sprint(item))
		}
		return strings.Join(parts, " ")
	case []string:
		return strings.Join(v, " ")
	default:
		return ""
	}
}

func extractNodeInvoke(params map[string]any) string {
	name := strings.ToLower(readStringAny(params, "invokeCommand", "commandName", "name"))
	if !strings.Contains(name, "exec") && !strings.Contains(name, "run") && !strings.Contains(name, "shell") {
		return ""
	}
	if raw := readStringAny(params, "rawCommand", "command", "cmd"); raw != "" {
		return raw
	}
	if raw := readStringAny(params, "invokeParamsJson"); raw != "" {
		var nested map[string]any
		if json.Unmarshal([]byte(raw), &nested) == nil {
			return readStringAny(nested, "rawCommand", "command", "cmd")
		}
	}
	return ""
}

func mutatesSensitiveConfig(params map[string]any, sensitive []string) bool {
	raw, _ := json.Marshal(params)
	text := strings.ToLower(string(raw))
	for _, key := range sensitive {
		if strings.Contains(text, strings.ToLower(key)) {
			return true
		}
	}
	return false
}

func containsFold(items []string, value string) bool {
	for _, item := range items {
		if strings.EqualFold(item, value) {
			return true
		}
	}
	return false
}

func boolParam(params map[string]any, keys ...string) bool {
	for _, key := range keys {
		if v, ok := params[key].(bool); ok {
			return v
		}
	}
	return false
}

func boolPtrValue(v *bool, fallback bool) bool {
	if v == nil {
		return fallback
	}
	return *v
}

func reviewConfirmed(params map[string]any) bool {
	value, ok := params["_sec_confirm"]
	if !ok {
		return false
	}
	switch v := value.(type) {
	case bool:
		return v
	case string:
		return strings.EqualFold(v, "true") || v == "1" || strings.EqualFold(v, "yes")
	default:
		return false
	}
}

func stripReviewConfirm(params map[string]any) map[string]any {
	out := make(map[string]any, len(params))
	for k, v := range params {
		if k == "_sec_confirm" {
			continue
		}
		out[k] = v
	}
	return out
}
