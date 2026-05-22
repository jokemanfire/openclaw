package security

import (
	"encoding/base64"
	"net"
	"net/url"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"unicode/utf16"
)

const maxEmbeddedDepth = 3

func CheckCommand(command string, policy *Policy, cwd string) CheckResult {
	return checkCommandDepth(command, policy, cwd, 0)
}

func checkCommandDepth(command string, policy *Policy, cwd string, depth int) CheckResult {
	// 优先检查命令黑白名单，命中则直接放行
	if hit, ok := checkCommandWhiteList(command, policy); ok {
		return hit
	}
	// if hit, ok := checkPowerShell(command, policy); ok {
	// 	return hit
	// }
	parsed := parseForSecurity(command)
	switch parsed.Kind {
	case ParseTooComplex:
		reason := "命令结构过于复杂，无法静态验证，需要人工审批"
		if parsed.Reason != "" {
			reason += "：" + parsed.Reason
		}
		return CheckResult{Decision: DecisionAsk, Reason: reason, Source: "parse", Commands: parsed.Commands, ParseKind: parsed.Kind}
	case ParseUnavailable:
		return CheckResult{Decision: DecisionAsk, Reason: "命令解析器当前不可用，需要人工审批", Source: "parse", ParseKind: parsed.Kind}
	}
	if len(parsed.Commands) == 0 {
		return allow("空命令，默认放行")
	}

	if hit, ok := checkEmbeddedPayloads(parsed.Commands, policy, cwd, depth); ok {
		hit.Commands = parsed.Commands
		hit.ParseKind = parsed.Kind
		return hit
	}
	if hit, ok := checkCompound(parsed.Commands); ok {
		hit.Commands = parsed.Commands
		hit.ParseKind = parsed.Kind
		return hit
	}

	var pending *CheckResult
	for _, cmd := range parsed.Commands {
		if hit, ok := checkOpenClawScriptRunner(cmd); ok {
			hit.Commands = parsed.Commands
			hit.ParseKind = parsed.Kind
			if hit.Decision == DecisionDeny {
				return hit
			}
			if pending == nil {
				pending = &hit
			}
		}
		if hit, ok := applyRules(command, cmd, policy); ok {
			hit.Commands = parsed.Commands
			hit.ParseKind = parsed.Kind
			if hit.Decision == DecisionDeny {
				return hit
			}
			if pending == nil {
				pending = &hit
			}
		}
	}
	if hit, ok := checkCommandPathPolicy(command, parsed.Commands, policy, cwd); ok {
		hit.Commands = parsed.Commands
		hit.ParseKind = parsed.Kind
		if hit.Decision == DecisionDeny {
			return hit
		}
		if pending == nil {
			pending = &hit
		}
	}
	if pending != nil {
		return *pending
	}
	res := allow("命令允许执行")
	res.Commands = parsed.Commands
	return res
}

// checkOpenClawScriptRunner 检查命令是否直接运行 OpenClaw 入口脚本
// 用于拦截通过 node 或 bun 直接执行 openclaw.mjs 脚本的行为
// 参数 cmd: 解析后的简单命令结构
// 返回值：
//   - CheckResult: 检查结果，当检测到 openclaw.mjs 时返回询问决策
//   - bool: 是否命中 OpenClaw 脚本模式
//
// 检测逻辑:
// 1. 标准化命令参数列表，失败则返回不命中
// 2. 提取并标准化命令名，仅处理 node 和 bun 解释器
// 3. 遍历后续参数，查找文件名匹配 openclaw.mjs 的参数（不区分大小写）
// 4. 命中时根据解释器类型返回对应的规则 ID 和询问原因
func checkOpenClawScriptRunner(cmd SimpleCommand) (CheckResult, bool) {
	argv, err := normalizeArgv(cmd.Argv)
	if err != nil || len(argv) == 0 {
		return CheckResult{}, false
	}
	base := normalizeBase(argv[0])
	if base != "node" && base != "bun" {
		return CheckResult{}, false
	}
	for _, arg := range argv[1:] {
		if strings.EqualFold(filepath.Base(arg), "openclaw.mjs") {
			ruleID := "builtin.openclaw.runner.node"
			if base == "bun" {
				ruleID = "builtin.openclaw.runner.bun.script"
			}
			return ask("rule", ruleID, "直跑 openclaw 入口脚本可能触发高影响操作，需要人工审批"), true
		}
	}
	return CheckResult{}, false
}

func checkEmbeddedPayloads(commands []SimpleCommand, policy *Policy, cwd string, depth int) (CheckResult, bool) {
	if depth >= maxEmbeddedDepth {
		return ask("parse", "", "嵌套解释器层级过深，无法静态验证，需要人工审批"), true
	}
	var pending *CheckResult
	for _, cmd := range commands {
		payload := embeddedPayload(cmd)
		if payload == "" {
			continue
		}
		hit := checkCommandDepth(payload, policy, cwd, depth+1)
		if hit.Decision == DecisionAllow {
			continue
		}
		hit.Reason = "内联解释器载荷命中策略：" + hit.Reason
		if hit.Decision == DecisionDeny {
			return hit, true
		}
		if pending == nil {
			pending = &hit
		}
	}
	if pending != nil {
		return *pending, true
	}
	return CheckResult{}, false
}

func embeddedPayload(cmd SimpleCommand) string {
	argv, err := normalizeArgv(cmd.Argv)
	if err != nil || len(argv) < 3 {
		return ""
	}
	base := normalizeBase(argv[0])
	switch base {
	case "bash", "sh", "dash", "zsh", "ksh":
		for i := 1; i < len(argv)-1; i++ {
			if argv[i] == "-c" || argv[i] == "--command" || (strings.HasPrefix(argv[i], "-") && strings.Contains(argv[i], "c")) {
				return argv[i+1]
			}
		}
	case "python", "python2", "python3", "node", "nodejs", "perl", "ruby", "php":
		flag := "-e"
		if strings.HasPrefix(base, "python") {
			flag = "-c"
		} else if base == "php" {
			flag = "-r"
		}
		code := exactFlag(argv, flag, "--eval", "--command")
		return extractShellStringFromCode(base, code)
	}
	return ""
}

func exactFlag(argv []string, flags ...string) string {
	for i := 1; i < len(argv)-1; i++ {
		for _, f := range flags {
			if argv[i] == f {
				return argv[i+1]
			}
		}
	}
	return ""
}

func extractShellStringFromCode(base, code string) string {
	if code == "" {
		return ""
	}
	markers := []string{"system(", "exec(", "execSync(", ".exec(", "spawn(", "spawnSync(", "os.system(", "subprocess.run("}
	for _, marker := range markers {
		if idx := strings.Index(code, marker); idx >= 0 {
			if payload := firstStringLiteral(code[idx+len(marker):]); payload != "" {
				if strings.HasPrefix(marker, "subprocess.") && !strings.Contains(code[idx:], "shell=True") && !strings.Contains(code[idx:], "shell = True") {
					continue
				}
				return payload
			}
		}
	}
	if i := strings.Index(code, "`"); i >= 0 {
		if j := strings.Index(code[i+1:], "`"); j >= 0 {
			return code[i+1 : i+1+j]
		}
	}
	return ""
}

func firstStringLiteral(s string) string {
	for i := 0; i < len(s); i++ {
		q := s[i]
		if q != '\'' && q != '"' {
			continue
		}
		var b strings.Builder
		for j := i + 1; j < len(s); j++ {
			if s[j] == '\\' && j+1 < len(s) {
				b.WriteByte(s[j+1])
				j++
				continue
			}
			if s[j] == q {
				return b.String()
			}
			b.WriteByte(s[j])
		}
	}
	return ""
}

// checkCompound 检查复合命令中的可疑模式
// 主要检测两种风险场景:
// 1. 多次目录切换 (cd): 可能用于在不同目录间执行恶意操作
// 2. 目录切换与 git 操作组合: 可能用于篡改代码仓库
// 参数 commands: 解析后的简单命令列表
// 返回值：CheckResult 和是否命中可疑模式
func checkCompound(commands []SimpleCommand) (CheckResult, bool) {
	cdCount := 0
	hasGit := false
	for _, cmd := range commands {
		if len(cmd.Argv) == 0 {
			continue
		}
		switch cmd.Argv[0] {
		case "cd":
			cdCount++
		case "git":
			hasGit = true
		}
	}
	if cdCount > 1 {
		return ask("compound", "", "一次命令中包含多次目录切换，需要人工审批"), true
	}
	if cdCount > 0 && hasGit {
		return ask("compound", "", "目录切换与 git 操作组合出现，需要人工审批"), true
	}
	return CheckResult{}, false
}

// applyRules 将命令与安全策略规则进行匹配，返回命中的最佳规则结果
// 参数:
//   - raw: 原始命令字符串
//   - cmd: 解析后的简单命令结构
//   - policy: 安全策略对象，包含命令规则列表
//
// 返回值:
//   - CheckResult: 检查结果，包含决策、原因、规则 ID 等信息
//   - bool: 是否命中规则
//
// 匹配逻辑:
// 1. 遍历所有 CommandRules，使用 ruleMatches 检查是否匹配
// 2. 对匹配的规则计算特异性分数 (specificity)
// 3. 按优先级选择最佳规则：拒绝 > 询问 > 允许，同优先级时选择特异性更高的规则
// 4. 特异性相同时，选择在规则列表中索引更大的规则（后定义的优先）
func applyRules(raw string, cmd SimpleCommand, policy *Policy) (CheckResult, bool) {
	if len(cmd.Argv) == 0 || policy == nil {
		return CheckResult{}, false
	}
	type candidate struct {
		idx int
		sp  int
		res CheckResult
	}
	var best *candidate
	for i, rule := range policy.CommandRules {
		if !ruleMatches(raw, cmd, rule, policy) {
			continue
		}
		res := CheckResult{Decision: rule.Action, Reason: nonEmpty(rule.Reason, "hitWhiteStrategy"), Source: "rule", RuleID: rule.ID, ParseKind: ParseSimple}
		c := candidate{idx: i, sp: specificity(rule), res: res}
		//定义规则集中reson为"hitWhiteStrategy"定义为白最高优先级
		if c.res.Reason == "hitWhiteStrategy" {
			return res, true
		}
		if best == nil || decisionRank(c.res.Decision) > decisionRank(best.res.Decision) || (decisionRank(c.res.Decision) == decisionRank(best.res.Decision) && (c.sp > best.sp || (c.sp == best.sp && c.idx >= best.idx))) {
			best = &c
		}
	}

	if best == nil {
		return CheckResult{}, false
	}
	return best.res, true
}

type parsedCommand struct {
	argv        []string
	base        string
	positionals []string
	flags       []string
}

func parseRuleCommand(cmd SimpleCommand) (parsedCommand, bool) {
	argv, err := normalizeArgv(cmd.Argv)
	if err != nil || len(argv) == 0 {
		return parsedCommand{}, false
	}
	base := normalizeBase(argv[0])
	if base == "" {
		return parsedCommand{}, false
	}
	var pos, flags []string
	afterDash := false
	for _, token := range argv[1:] {
		if afterDash {
			pos = append(pos, token)
			continue
		}
		if token == "--" {
			afterDash = true
			continue
		}
		if fs := normalizeFlag(token, base); len(fs) > 0 {
			flags = append(flags, fs...)
			continue
		}
		pos = append(pos, token)
	}
	if base == "dd" {
		for _, ev := range cmd.EnvVars {
			if ev.Name == "of" || ev.Name == "if" {
				flags = append(flags, strings.ToLower(ev.Name))
			}
		}
	}
	return parsedCommand{argv: argv, base: base, positionals: pos, flags: flags}, true
}

// ruleMatches 检查解析后的命令是否匹配给定的安全策略规则
// 该函数是命令安全策略系统的核心匹配逻辑，支持多种匹配类型
//
// 参数:
//   - raw: 原始命令字符串，用于前缀匹配和网络协议检测
//   - cmd: 解析后的简单命令结构 (SimpleCommand)，包含参数列表和环境变量
//   - rule: 命令规则对象 (CommandRule)，定义匹配类型、基础命令、禁止标志等
//   - policy: 安全策略对象 (Policy)，用于目标范围匹配验证
//
// 返回值:
//   - bool: 命令是否匹配该规则
//
// 支持的匹配类型:
// 1. prefix: 前缀匹配，检查命令参数拼接后的字符串是否以规则前缀开头
// 2. any_args: 任意参数匹配，检查基础命令、子命令、参数基名后，验证目标范围
// 3. dangerous_flags: 危险标志匹配，在 any_args 基础上额外检查是否包含禁止的标志
// 4. network_target: 网络目标匹配，专门处理网络连接类命令的目标地址匹配
//
// 匹配流程 (非 prefix 类型):
// 1. 解析命令结构，提取基础命令名、位置参数和标志
// 2. 验证基础命令名是否匹配 (network_target 且 BaseCommand 为/dev/tcp 时例外)
// 3. 对于 network_target 类型，检查原始命令是否包含/dev/tcp/或/dev/udp/路径
// 4. 验证必需子命令序列是否匹配 (支持子序列匹配)
// 5. 验证必需参数基名是否匹配
// 6. 根据具体匹配类型执行额外的目标范围检查
func ruleMatches(raw string, cmd SimpleCommand, rule CommandRule, policy *Policy) bool {
	switch rule.MatchType {
	case "prefix":
		// 前缀匹配模式：将命令参数用空格拼接，检查是否以规则前缀开头
		return strings.HasPrefix(strings.Join(cmd.Argv, " "), rule.Prefix)
	case "any_args", "dangerous_flags", "network_target":
		// 解析命令结构，提取基础命令、位置参数和标志
		parsed, ok := parseRuleCommand(cmd)
		if !ok {
			return false
		}
		// 验证基础命令名是否匹配
		// 特例：network_target 类型且 BaseCommand 为/dev/tcp 时跳过此检查
		if !(rule.MatchType == "network_target" && rule.BaseCommand == "/dev/tcp") && parsed.base != rule.BaseCommand {
			return false
		}
		// 特殊处理：network_target 类型且 BaseCommand 为/dev/tcp 时，
		// 检查原始命令是否包含 bash 的网络重定向语法/dev/tcp/或/dev/udp/
		if rule.MatchType == "network_target" && rule.BaseCommand == "/dev/tcp" && !strings.Contains(raw, "/dev/tcp/") && !strings.Contains(raw, "/dev/udp/") {
			return false
		}
		// 验证必需的子命令序列是否匹配（支持子序列匹配）
		if !hasSubsequence(parsed.positionals, appendIf(rule.RequiredSubCommands, rule.RequiredSubCommand)) {
			return false
		}
		// 验证必需的参数基名是否匹配
		if !matchesBasenames(parsed.positionals, rule.RequiredArgBasenames) {
			return false
		}
		// 根据具体匹配类型执行额外的目标范围检查
		switch rule.MatchType {
		case "any_args":
			// 任意参数模式：仅检查目标范围匹配
			return targetScopeMatches(rule, parsed, raw, policy)
		case "dangerous_flags":
			// 危险标志模式：同时检查是否包含禁止标志和目标范围匹配
			return hasForbidden(rule, parsed, raw) && targetScopeMatches(rule, parsed, raw, policy)
		case "network_target":
			// 网络目标模式：提取网络目标地址并检查是否在目标范围内
			return targetsMatch(extractNetworkTargets(parsed, raw, rule), rule.TargetScope, policy)
		}
	}
	return false
}

func normalizeBase(s string) string {
	base := strings.ToLower(filepath.Base(strings.Trim(s, `"'`)))
	if strings.HasPrefix(base, "mkfs.") {
		return "mkfs"
	}
	return base
}

func normalizeFlag(token, base string) []string {
	lower := strings.ToLower(token)
	if base == "dd" && strings.Contains(lower, "=") {
		return []string{strings.SplitN(lower, "=", 2)[0]}
	}
	if strings.HasPrefix(token, "--") {
		t := lower
		if i := strings.Index(t, "="); i >= 0 {
			t = t[:i]
		}
		return []string{t}
	}
	if strings.HasPrefix(token, "-") && !strings.HasPrefix(token, "--") && len(token) > 2 {
		out := []string{token}
		for _, r := range token[1:] {
			out = append(out, "-"+string(r))
		}
		return out
	}
	if strings.HasPrefix(lower, "/") {
		if i := strings.Index(lower, ":"); i > 0 {
			return []string{lower[:i]}
		}
	}
	if strings.HasPrefix(token, "-") || strings.HasPrefix(lower, "/") || strings.HasPrefix(lower, "+") {
		if strings.HasPrefix(token, "-") && !strings.HasPrefix(token, "--") {
			return []string{token}
		}
		return []string{lower}
	}
	return nil
}

// hasForbidden 检查解析后的命令是否包含规则中定义的禁止标志
// 用于 dangerous_flags 匹配类型，检测命令中是否存在被策略明确禁止的参数或标志
//
// 参数:
//   - rule: 命令规则对象，包含 ForbiddenFlags 禁止标志列表
//   - parsed: 解析后的命令结构，包含 flags（标志列表）和 positionals（位置参数列表）
//   - raw: 原始命令字符串，用于特殊字符（如管道符 | ）检测
//
// 返回值:
//   - bool: 当命令包含任一禁止标志时返回 true，否则返回 false
//
// 检测逻辑:
//  1. 构建命令标志集合：同时记录原始形式和小写形式，支持大小写不敏感匹配
//  2. 遍历规则的禁止标志列表，执行以下检查：
//     a. 管道符特例：当禁止标志为"|"时，直接检查原始命令字符串是否包含管道符
//     b. Unix 短标志：对形如"-x"的短标志进行精确匹配（区分大小写）
//     c. 其他标志：使用小写形式进行不区分大小写的匹配
//     d. 位置参数：检查位置参数列表中是否有与禁止标志完全匹配的项（不区分大小写）
//  3. 命中任一禁止标志即返回 true，全部未命中则返回 false
func hasForbidden(rule CommandRule, parsed parsedCommand, raw string) bool {
	// 构建命令标志集合，同时记录原始形式和小写形式
	flagSet := map[string]bool{}
	flagLowerSet := map[string]bool{}
	for _, f := range parsed.flags {
		flagSet[f] = true
		flagLowerSet[strings.ToLower(f)] = true
	}
	// 遍历规则定义的禁止标志列表
	for _, f := range rule.ForbiddenFlags {
		// 特殊处理：管道符检测
		// 当禁止标志为"|"时，直接检查原始命令字符串是否包含管道符
		if f == "|" && strings.Contains(raw, "|") {
			return true
		}
		// Unix 短标志精确匹配（区分大小写）
		if shortUnixFlag(f) {
			if flagSet[f] {
				return true
			}
		} else if flagLowerSet[strings.ToLower(f)] {
			// 其他标志使用小写形式进行不区分大小写的匹配
			return true
		}
		// 检查位置参数是否包含禁止标志（不区分大小写）
		for _, p := range parsed.positionals {
			if strings.ToLower(p) == f {
				return true
			}
		}
	}
	return false
}

func shortUnixFlag(flag string) bool {
	return strings.HasPrefix(flag, "-") && !strings.HasPrefix(flag, "--") && len([]rune(flag)) == 2
}

func targetScopeMatches(rule CommandRule, parsed parsedCommand, raw string, policy *Policy) bool {
	if rule.TargetScope == "" || rule.TargetScope == "any" {
		return true
	}
	return targetsMatch(extractNetworkTargets(parsed, raw, rule), rule.TargetScope, policy)
}

func extractNetworkTargets(parsed parsedCommand, raw string, rule CommandRule) []string {
	var targets []string
	if rule.BaseCommand == "/dev/tcp" || strings.Contains(raw, "/dev/tcp/") || strings.Contains(raw, "/dev/udp/") {
		re := regexp.MustCompile(`/dev/(?:tcp|udp)/([^/\s]+)/\d+`)
		for _, m := range re.FindAllStringSubmatch(raw, -1) {
			targets = append(targets, m[1])
		}
	}
	switch parsed.base {
	case "curl", "wget", "ftp", "lftp":
		for _, token := range parsed.positionals {
			targets = append(targets, hostFromToken(token, hostURL|hostBare))
		}
	case "ssh", "sftp", "nc", "netcat", "ncat":
		for _, token := range parsed.positionals {
			targets = append(targets, hostFromToken(token, hostUserAt|hostBare|hostURL))
		}
		if len(targets) > 0 {
			targets = targets[:1]
		}
	case "scp", "rsync":
		for _, token := range parsed.positionals {
			targets = append(targets, hostFromToken(token, hostRemoteSpec|hostUserAt|hostURL))
		}
	case "socat":
		for _, token := range parsed.positionals {
			targets = append(targets, socatHostFromToken(token))
		}
		if len(targets) > 0 {
			targets = targets[:1]
		}
	default:
		for _, token := range append(parsed.positionals, parsed.flags...) {
			targets = append(targets, hostFromToken(token, hostURL|hostUserAt))
		}
	}
	out := targets[:0]
	for _, t := range targets {
		if t != "" {
			out = append(out, t)
		}
	}
	return out
}

type hostMode uint8

const (
	hostURL hostMode = 1 << iota
	hostUserAt
	hostBare
	hostRemoteSpec
)

func hostFromToken(token string, mode hostMode) string {
	token = strings.Trim(token, `"'`)
	if mode&hostURL != 0 {
		if u, err := url.Parse(token); err == nil && u.Hostname() != "" {
			return u.Hostname()
		}
	}
	if mode&hostRemoteSpec != 0 {
		if host := remoteSpecHost(token); host != "" {
			return host
		}
	}
	if mode&hostUserAt != 0 && strings.Contains(token, "@") && !strings.Contains(token, "/") {
		host := strings.Split(token, "@")[1]
		if i := strings.Index(host, ":"); i >= 0 {
			host = host[:i]
		}
		return strings.Trim(host, "[]")
	}
	if mode&hostBare != 0 && bareHostLike(token) {
		return strings.Trim(token, "[]")
	}
	return ""
}

func remoteSpecHost(token string) string {
	if !strings.Contains(token, ":") || strings.Contains(token, "://") {
		return ""
	}
	before, _, _ := strings.Cut(token, ":")
	return hostFromToken(before, hostUserAt|hostBare)
}

func socatHostFromToken(token string) string {
	if host := hostFromToken(token, hostURL|hostUserAt|hostBare); host != "" {
		return host
	}
	parts := strings.Split(token, ":")
	if len(parts) < 2 {
		return ""
	}
	switch strings.ToLower(parts[0]) {
	case "tcp", "tcp4", "tcp6", "udp", "udp4", "udp6", "sctp", "openssl", "ssl", "tcp-connect", "udp-connect":
		return strings.Trim(parts[1], "[]")
	default:
		return ""
	}
}

func bareHostLike(token string) bool {
	cleaned := strings.ToLower(strings.Trim(strings.TrimSpace(token), "[]"))
	if cleaned == "" {
		return false
	}
	if ip := net.ParseIP(cleaned); ip != nil {
		return true
	}
	if cleaned == "localhost" || strings.HasSuffix(cleaned, ".localhost") {
		return true
	}
	return strings.Contains(cleaned, ".") || strings.Contains(cleaned, "-")
}

func targetsMatch(targets []string, scope string, policy *Policy) bool {
	if scope != "external" {
		return true
	}
	if len(targets) == 0 {
		return true
	}
	for _, target := range targets {
		if isExternalTarget(target, policy) {
			return true
		}
	}
	return false
}

func isExternalTarget(host string, policy *Policy) bool {
	h := strings.ToLower(strings.Trim(host, "[]"))
	if h == "" || h == "localhost" || strings.HasSuffix(h, ".localhost") || strings.HasSuffix(h, ".local") || strings.HasSuffix(h, ".internal") {
		return false
	}
	for _, ih := range policy.InternalHosts {
		if h == strings.ToLower(ih) {
			return false
		}
	}
	for _, suffix := range policy.InternalSuffix {
		if strings.HasSuffix(h, strings.ToLower(suffix)) {
			return false
		}
	}
	if ip := net.ParseIP(h); ip != nil {
		return !(ip.IsLoopback() || ip.IsPrivate() || ip.IsLinkLocalUnicast())
	}
	return true
}

func checkPowerShell(command string, policy *Policy) (CheckResult, bool) {
	if policy == nil {
		return CheckResult{}, false
	}
	lower := strings.ToLower(command)
	isPS := strings.Contains(lower, "powershell") || strings.Contains(lower, "pwsh")
	if isPS {
		if regexp.MustCompile(`(?i)(?:-runasadministrator\b|-runas\b|(?:-verb|/verb)\s*:?\s*runas\b)`).MatchString(command) {
			return ask("powershell", "powershell.runas", "PowerShell RunAs 提权参数需要人工审批"), true
		}
		if regexp.MustCompile(`(?i)(?:-windowstyle|-w)\s+hidden`).MatchString(command) {
			return ask("powershell", "powershell.hidden-window", "PowerShell 隐藏窗口执行会降低可见性，需要人工审批"), true
		}
		if regexp.MustCompile(`(?i)\bstart-process\b[^;\n\r]*\b(?:powershell|pwsh)(?:\.exe)?\b`).MatchString(command) {
			return ask("powershell", "powershell.start-process-nested", "Start-Process 启动嵌套 PowerShell 进程无法静态验证"), true
		}
		if regexp.MustCompile(`(?i)(?:-enc|-encodedcommand)\b`).MatchString(command) {
			if payload := encodedPowerShellPayload(command); payload != "" {
				if hit, ok := checkPowerShellScript(payload, policy); ok {
					return hit, true
				}
			}
			return ask("powershell", "powershell.encoded-command", "PowerShell 编码命令会隐藏真实载荷，需要人工审批"), true
		}
		if regexp.MustCompile(`(?i)(?:-executionpolicy|-ep)\s+bypass`).MatchString(command) {
			return ask("powershell", "powershell.executionpolicy-bypass", "PowerShell ExecutionPolicy Bypass 需要人工审批"), true
		}
		if regexp.MustCompile(`(?i)(?:-executionpolicy|-ep)\b`).MatchString(command) {
			return ask("powershell", "powershell.executionpolicy", "PowerShell ExecutionPolicy 覆盖需要人工审批"), true
		}
		if regexp.MustCompile(`(?i)(?:-command|-c)\b`).MatchString(command) {
			if hit, ok := checkPowerShellScript(command, policy); ok {
				return hit, true
			}
			return ask("powershell", "powershell.command-flag", "PowerShell -Command 执行需要人工审批"), true
		}
		if regexp.MustCompile(`(?i)\.(ps1|psm1)\b`).MatchString(command) {
			return ask("powershell", "powershell.file-execution", "PowerShell 脚本文件执行无法静态验证，需要人工审批"), true
		}
	}
	if !isPS && !looksLikePowerShellScript(command) {
		return CheckResult{}, false
	}
	return checkPowerShellScript(command, policy)
}

func looksLikePowerShellScript(command string) bool {
	return regexp.MustCompile(`(?i)(^|[^A-Za-z0-9_-])(?:start-process|get-wmiobject|invoke-wmimethod|invoke-webrequest|invoke-restmethod|iwr|irm|certutil|set-netfirewallrule|set-netfirewallprofile|iex|invoke-expression|new-object|add-type|register-scheduledtask|set-itemproperty|set-mppreference|set-alias|import-module|invoke-item|invoke-command|write-output|remove-item|stop-process|restart-computer|stop-computer)([^A-Za-z0-9_-]|$)|^\s*\$env:|\[[A-Za-z0-9_.]+\]::|\[[A-Za-z0-9_.]+\]\.[A-Za-z_]|amsi|&\s*\(`).MatchString(command)
}

func encodedPowerShellPayload(command string) string {
	re := regexp.MustCompile(`(?i)(?:-enc|-encodedcommand)\s+([A-Za-z0-9+/=]+)`)
	m := re.FindStringSubmatch(command)
	if len(m) < 2 {
		return ""
	}
	raw, err := base64.StdEncoding.DecodeString(m[1])
	if err != nil || len(raw)%2 != 0 {
		return ""
	}
	u16 := make([]uint16, len(raw)/2)
	for i := range u16 {
		u16[i] = uint16(raw[i*2]) | uint16(raw[i*2+1])<<8
	}
	return string(utf16.Decode(u16))
}

func checkPowerShellScript(script string, policy *Policy) (CheckResult, bool) {
	tests := []struct {
		reason string
		id     string
		pat    string
	}{
		{"Start-Process 携带 RunAs 时需要人工审批", "powershell.start-process-runas", `(?i)\bstart-process\b[^;\n\r]*(?:-verb|/verb)\s*:?\s*runas\b`},
		{"Start-Process 隐藏窗口执行会降低可见性，需要人工审批", "powershell.start-process-hidden", `(?i)\bstart-process\b[^;\n\r]*(?:-windowstyle|/windowstyle)\s*:?\s*hidden\b`},
		{"Start-Process 启动嵌套 PowerShell 进程无法静态验证", "powershell.start-process-nested", `(?i)\bstart-process\b[^;\n\r]*\b(?:powershell|pwsh)(?:\.exe)?\b`},
		{"PowerShell 直接网络请求原语需要人工审批", "powershell.network-request", `(?i)(^|[^A-Za-z0-9_-])(?:invoke-webrequest|invoke-restmethod|iwr|irm)([^A-Za-z0-9_-]|$)`},
		{"PowerShell 下载并执行模式需要人工审批", "powershell.download-cradle", `(?i)(downloadstring|downloadfile|new-object\s+net\.webclient)`},
		{"PowerShell 下载工具调用需要人工审批", "powershell.download-utility", `(?i)\b(?:certutil|bitsadmin)(?:\.exe)?\b[^;\n\r]*(?:-urlcache|/urlcache|-decode|-decodehex|-encode|-transfer|/transfer)`},
		{"PowerShell 别名或变量修改会影响后续命令解析", "powershell.runtime-state", `(?i)(\bset-alias\b|\bnew-alias\b|\bset-variable\b|\bnew-variable\b)`},
		{"PowerShell 通过 Invoke-Expression 进行动态求值，需要人工审批", "powershell.dynamic-eval", `(?i)(invoke-expression|\biex\b)`},
		{"PowerShell 子表达式可能隐藏命令执行，需要人工审批", "powershell.subexpression", `\$\(`},
		{"Add-Type 会编译或加载 .NET 代码，需要人工审批", "powershell.add-type", `(?i)(^|[^A-Za-z0-9_-])add-type([^A-Za-z0-9_-]|$)`},
		{"PowerShell 对象实例化可能创建执行或下载原语", "powershell.com-or-webclient", `(?i)\bnew-object\b[^;\n\r]*(?:-comobject|net\.webclient|wscript\.shell)`},
		{"Invoke-Item 会使用默认处理器打开内容，可能执行任意代码", "powershell.invoke-item", `(?i)(^|[^A-Za-z0-9_-])(?:invoke-item|ii)([^A-Za-z0-9_-]|$)`},
		{"计划任务的创建或修改属于持久化原语", "powershell.scheduled-task", `(?i)(register-scheduledtask|new-scheduledtask|schtasks(?:\.exe)?.*(/create|/change|-create|-change))`},
		{"PowerShell 修改 Run/RunOnce 注册表项属于持久化原语", "powershell.registry-persistence", `(?i)(currentversion[\\/]+run(?:once)?|registry::hkey_)`},
		{"PowerShell Defender 配置变更会削弱主机防护", "powershell.defender-tamper", `(?i)(set-mppreference|add-mppreference|remove-mppreference)`},
		{"PowerShell AMSI 绕过特征需要人工审批", "powershell.amsi-bypass", `(?i)(amsiutils|amsiinitfailed|system\.management\.automation\.amsi)`},
		{"PowerShell 的 .NET 成员调用可能访问具备执行能力的 API", "powershell.member-invocation", `(?i)(\[[A-Za-z0-9_.]+\]::|\.[A-Za-z_][A-Za-z0-9_]*\s*\()`},
		{"PowerShell 防火墙配置变更需要人工审批", "powershell.firewall", `(?i)(set-netfirewallrule|set-netfirewallprofile)`},
		{"PowerShell 环境变量修改会影响后续命令执行", "powershell.env-mutation", `(?i)(\$env:[A-Za-z_][A-Za-z0-9_]*\s*=|\b(?:set-item|new-item|remove-item|clear-item|set-content|add-content)\b[^;\n\r]*\benv:)`},
		{"PowerShell 模块或程序集加载可能执行任意代码", "powershell.module-loading", `(?i)(\bimport-module\b|\binstall-module\b|\bsave-module\b|\busing\s+(?:module|assembly)\b)`},
		{"PowerShell 的 WMI/CIM 执行原语可能启动任意进程", "powershell.wmi-spawn", `(?i)(\binvoke-wmimethod\b|\binvoke-cimmethod\b|\bget-wmiobject\b|\bget-ciminstance\b|\bnew-object\b[^;\n\r]*(?:-comobject|system\.management))`},
		{"PowerShell 动态命令名无法静态验证", "powershell.dynamic-command-name", `(?i)(^|[;(|&\s])&\s*(?:\(|\$|\{)`},
		{"执行型 cmdlet 中的 PowerShell script block 需要人工审批", "powershell.script-block", `(?i)\b(?:invoke-command|invoke-expression|register-scheduledjob|start-job|start-threadjob)\b[^;\n\r]*\{`},
	}
	for _, t := range tests {
		if regexp.MustCompile(t.pat).MatchString(script) {
			return ask("powershell", t.id, t.reason), true
		}
	}
	for _, cmdlet := range policy.PowerShell.DirectHighRiskCmdlets {
		if regexp.MustCompile(`(?i)(^|[^A-Za-z0-9_-])` + regexp.QuoteMeta(cmdlet) + `($|[^A-Za-z0-9_-])`).MatchString(script) {
			return ask("powershell", "powershell."+strings.ToLower(cmdlet), cmdlet+" 需要人工审批"), true
		}
	}
	return CheckResult{}, false
}

func specificity(rule CommandRule) int {
	base := map[string]int{"prefix": 8, "any_args": 16, "dangerous_flags": 24, "network_target": 28}[rule.MatchType]
	return base + len(strings.Fields(rule.Prefix))*4 + boolScore(rule.BaseCommand != "")*4 + boolScore(rule.RequiredSubCommand != "")*4 + len(rule.RequiredSubCommands)*4 + len(rule.RequiredArgBasenames)*4 + len(rule.ForbiddenFlags)*2 + boolScore(rule.TargetScope == "external")*2
}

func decisionRank(d Decision) int {
	switch d {
	case DecisionDeny:
		return 3
	case DecisionAsk:
		return 2
	default:
		return 1
	}
}

func appendIf(items []string, item string) []string {
	out := append([]string(nil), items...)
	if item != "" {
		out = append(out, item)
	}
	return out
}

func hasSubsequence(values, required []string) bool {
	if len(required) == 0 {
		return true
	}
	j := 0
	for _, value := range values {
		if strings.EqualFold(value, required[j]) {
			j++
			if j == len(required) {
				return true
			}
		}
	}
	return false
}

func matchesBasenames(values, required []string) bool {
	if len(required) == 0 {
		return true
	}
	have := map[string]bool{}
	for _, v := range values {
		have[strings.ToLower(filepath.Base(v))] = true
	}
	for _, r := range required {
		if !have[strings.ToLower(r)] {
			return false
		}
	}
	return true
}

func nonEmpty(s, fallback string) string {
	if strings.TrimSpace(s) == "" {
		return fallback
	}
	return s
}

func boolScore(v bool) int {
	if v {
		return 1
	}
	return 0
}

func sortedKeys(m map[string]bool) []string {
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	return keys
}

// checkCommandWhiteList 检查命令是否匹配白名单检测规则
// 支持三种策略动作：BLOCK(拦截)、CONFIRM(确认)、ALLOW(允许)
// 参数:
//   - command: 待检查的命令字符串
//   - policy: 安全策略对象，包含白名单检测配置
//
// 返回值:
//   - CheckResult: 检查结果，包含决策类型（DecisionDeny/DecisionAsk/DecisionAllow）
//   - bool: 是否命中白名单规则
//
// 决策映射:
//   - BLOCK -> DecisionDeny: 直接拦截命令执行
//   - CONFIRM -> DecisionAsk: 需要用户确认后才能执行
//   - ALLOW -> DecisionAllow: 直接允许命令执行
func checkCommandWhiteList(command string, policy *Policy) (CheckResult, bool) {
	if policy == nil {
		return CheckResult{}, false
	}

	// 优先使用新的 CommandWhiteDetection 配置
	if len(policy.CommandWhiteDetection.PolicyRules) > 0 {
		for _, rule := range policy.CommandWhiteDetection.PolicyRules {
			// 构建正则表达式，支持 flags 选项
			pattern := rule.Pattern
			if rule.Flags != "" {
				pattern = "(?" + rule.Flags + ")" + pattern
			}

			if matched, _ := regexp.MatchString(pattern, command); matched {
				decision := strings.ToUpper(rule.Decision)
				switch decision {
				case "BLOCK":
					return deny("rule", rule.ID, rule.Reason), true
				case "CONFIRM":
					return ask("rule", rule.ID, rule.Reason), true
				case "ALLOW":
					return allow(rule.Reason), true
				default:
					// 未知决策类型，默认按确认处理
					return ask("rule", rule.ID, rule.Reason), true
				}
			}
		}
		return CheckResult{}, false
	}
	return CheckResult{}, false
}
