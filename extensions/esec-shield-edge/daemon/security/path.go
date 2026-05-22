package security

import (
	"os"
	"path/filepath"
	"regexp"
	"strings"
)

// checkPathDetectionRules 检查路径是否命中 pathDetection 策略规则
// 参数:
//   - path: 待检查的路径
//   - policy: 安全策略配置
//
// 返回值:
//   - bool: 是否命中规则
//   - string: 命中的规则 ID
//   - string: 决策原因
//   - Decision: 决策结果
func checkPathDetectionRules(path string, policy *Policy) (bool, string, string, Decision) {
	for _, rule := range policy.PathDetection.PolicyRules {
		if rule.Pattern == "" {
			continue
		}
		if matched, _ := regexp.MatchString(rule.Pattern, path); matched {
			decision := DecisionAsk
			if strings.ToUpper(rule.Decision) == "BLOCK" {
				decision = DecisionDeny
			} else if strings.ToUpper(rule.Decision) == "ALLOW" {
				decision = DecisionAllow
			}
			return true, rule.ID, rule.Reason, decision
		}
	}
	return false, "", "", DecisionAllow
}

type fileOp string

const (
	fileRead   fileOp = "read"
	fileWrite  fileOp = "write"
	fileCreate fileOp = "create"
)

func checkPathAccess(target string, op fileOp, reasonPrefix string, policy *Policy, cwd string, source string) (CheckResult, bool) {
	resolved, decision, reason, blocked := validatePath(target, op, policy, cwd)
	if !blocked {
		return CheckResult{}, false
	}
	return CheckResult{
		Decision:  decision,
		Reason:    strings.TrimSpace(reasonPrefix + " " + nonEmpty(reason, resolved)),
		Source:    source,
		ParseKind: ParseSimple,
	}, true
}

// validatePath 验证文件路径的安全性，检查目标路径是否符合安全策略
//
// 参数:
//   - target: 待验证的目标路径字符串
//   - op: 文件操作类型 (fileRead/fileWrite/fileCreate)
//   - policy: 安全策略配置，包含允许/拒绝的路径列表等
//   - cwd: 当前工作目录，用于解析相对路径
//
// 返回值:
//   - string: 解析后的完整路径
//   - Decision: 决策结果 (DecisionAllow/DecisionAsk/DecisionDeny)
//   - string: 决策原因描述
//   - bool: 是否被拦截 (true 表示需要拦截或审批)
//
// 检查流程:
//  1. 预处理：清理路径并检查空路径/特殊路径
//  2. 快速检查：UNC 路径、可疑 Windows 路径、Shell 展开语法
//  3. 路径解析：解析符号链接，获取所有可能的视图
//  4. 二次检查：对解析后的路径再次进行 UNC 和 Windows 路径检查
//  5. 禁止路径检查：检查是否命中明确禁止的路径或特殊进程路径
//  6. 敏感路径检查：根据操作类型检查敏感读/写路径
//  7. 读操作特殊检查：敏感文件名、仓库敏感文件、允许目录范围
//  8. 写操作特殊检查：危险自动编辑文件、写入目录范围
func validatePath(target string, op fileOp, policy *Policy, cwd string) (string, Decision, string, bool) {
	// 步骤 1: 路径预处理 - 去除引号和空白字符
	clean := trimPathQuotes(strings.TrimSpace(target))

	// 空路径或/dev/null 直接放行
	if clean == "" || clean == "/dev/null" {
		return "", DecisionAllow, "", false
	}

	// 步骤 2: 快速检查 - UNC 路径检测（如 \\server\share）
	if isUNC(clean) {
		return clean, DecisionAsk, "目标看起来是 UNC 路径，需要人工审批", true
	}

	// 步骤 2: 快速检查 - 可疑 Windows 路径模式检测
	if suspiciousWindowsPath(clean) {
		return clean, DecisionAsk, "目标包含可疑的 Windows 路径模式，需要人工审批", true
	}

	// 步骤 2: 快速检查 - Shell 展开语法检测（如 *, $(), {} 等）
	if shellExpansionPath(clean, op) {
		return clean, DecisionAsk, "目标使用了 shell 展开语法，需要人工审批", true
	}

	// 步骤 3: 路径解析 - 将相对路径转换为绝对路径
	resolved := resolvePathWithoutClean(clean, cwd)

	// 步骤 3: 收集所有视图 - 包括原始路径和符号链接解析后的真实路径
	views := []string{resolved}
	if real, err := filepath.EvalSymlinks(resolved); err == nil && real != resolved {
		views = append(views, filepath.Clean(real))
	}
	// 步骤 3.5: pathDetection 策略检查 - 检查路径是否命中动态检测规则
	if hit, ruleID, reason, decision := checkPathDetectionRules(resolved, policy); hit {
		blocked := decision != DecisionAllow
		return resolved, decision, "pathDetection: " + nonEmpty(reason, "命中路径检测规则 "+ruleID), blocked
	}
	// 步骤 4: 二次检查 - 对所有视图进行 UNC 和 Windows 路径检查
	for _, v := range views {
		if isUNC(v) || suspiciousWindowsPath(v) {
			return resolved, DecisionAsk, "目标包含可疑的 Windows 路径模式，需要人工审批", true
		}
	}

	// 步骤 5: 禁止路径检查 - 检查是否命中明确禁止的路径或特殊进程路径
	for _, v := range views {
		if matchesAnyPath(v, policy.Path.DenyPaths) || specialProcPath(v) {
			return resolved, DecisionDeny, "访问命中了禁止路径：" + resolved, true
		}
	}

	// 步骤 6: 敏感路径检查 - 根据操作类型选择敏感路径列表
	sensitive := policy.Path.SensitiveReadPaths
	if op == fileWrite || op == fileCreate {
		sensitive = policy.Path.SensitiveWritePaths
	}
	for _, v := range views {
		if matchesAnyPath(v, sensitive) {
			return resolved, DecisionAsk, "访问命中了敏感路径，需要人工审批", true
		}
	}

	// 步骤 7: 读操作特殊检查
	if op == fileRead {
		// 检查敏感文件名（如 .env, credentials, id_rsa 等）和仓库敏感文件
		for _, v := range views {
			if pathMatchesName(v, policy.Path.SensitiveReadFiles) || sensitiveRepoRead(v) {
				return resolved, DecisionAsk, "访问命中了敏感文件，需要人工审批", true
			}
		}
		// 检查是否在允许的读取目录范围内
		dirs := append([]string{}, policy.Path.AllowReadDirs...)
		dirs = append(dirs, policy.Path.AllowWriteDirs...)
		if len(dirs) == 0 || allowedInAllViews(views, dirs, cwd) {
			return resolved, DecisionAllow, "", false
		}
		return resolved, DecisionAsk, "目标不在允许读取的目录范围内", true
	}

	// 步骤 8: 写操作特殊检查 - 危险自动编辑文件检测
	for _, v := range views {
		if dangerousAutoEdit(v, policy) {
			return resolved, DecisionAsk, "目标命中了敏感文件或目录", true
		}
	}

	// 步骤 8: 写操作目录范围检查
	if len(policy.Path.AllowWriteDirs) > 0 {
		if policy.Mode != "acceptEdits" {
			return resolved, DecisionAsk, "写入操作要求运行在 acceptEdits 模式下", true
		}
		if !allowedInAllViews(views, policy.Path.AllowWriteDirs, cwd) {
			return resolved, DecisionAsk, "目标不在允许写入的目录范围内", true
		}
	}

	// 所有检查通过，允许访问
	return resolved, DecisionAllow, "", false
}

// checkCommandPathPolicy 检查命令列表中涉及的文件路径是否符合安全策略
// 参数:
//   - raw: 原始命令字符串
//   - commands: SimpleCommand 列表，包含待检查的命令信息
//   - policy: 安全策略配置
//   - cwd: 当前工作目录
//
// 返回值:
//   - CheckResult: 检查结果，包含决策、原因等信息
//   - bool: 是否命中策略（true 表示需要拦截或审批）
//
// 处理逻辑:
//  1. 遍历所有命令，提取每个命令涉及的路径请求
//  2. 对每个路径请求调用 checkPathAccess 进行访问检查
//  3. 如果命中 DecisionDeny 则立即返回拒绝结果
//  4. 否则收集第一个需要审批的结果并返回
func checkCommandPathPolicy(raw string, commands []SimpleCommand, policy *Policy, cwd string) (CheckResult, bool) {
	var pending *CheckResult
	for _, cmd := range commands {
		requests := commandPathRequests(raw, cmd)
		for _, req := range requests {
			if hit, ok := checkPathAccess(req.path, req.op, req.reason, policy, cwd, "path"); ok {
				if hit.Decision == DecisionDeny {
					return hit, true
				}
				if pending == nil {
					pending = &hit
				}
			}
		}
	}
	if pending != nil {
		return *pending, true
	}
	return CheckResult{}, false
}

type pathReq struct {
	path   string
	op     fileOp
	reason string
}

// commandPathRequests 从命令中提取所有涉及的文件路径请求
//
// 参数:
//   - raw: 原始命令字符串
//   - cmd: SimpleCommand 对象，包含命令的重定向信息和参数列表
//
// 返回值:
//   - []pathReq: 路径请求列表，每个请求包含路径、操作类型和原因描述
//
// 功能说明:
// 该函数用于解析命令行中涉及的所有文件路径，并根据命令类型判断每个路径的操作类型
// (读/写)，为后续的安全策略检查提供输入。
//
// 处理流程:
//  1. 重定向处理：遍历命令的所有重定向操作，判断操作类型
//     - 包含 ">" 的重定向视为写操作 (如 > file, >> file)
//     - 其他重定向视为读操作 (如 < file)
//  2. 参数规范化：对命令参数进行规范化处理，提取基础命令名
//  3. 命令类型识别：根据不同命令的语义，提取涉及的路径并判断操作类型
//     - 删除类命令 (rm/unlink/rmdir/shred): 所有位置参数均为写操作
//     - 移动命令 (mv): 所有位置参数均为写操作
//     - 复制命令 (cp/install): 除最后一个参数为写操作外，其余为读操作
//     - 属性修改命令 (chmod/chown/chgrp/touch/truncate): 所有位置参数均为写操作
//     - 读取类命令 (cat/less/more/head/tail/sed/awk): 默认为读操作
//     - sed 命令若使用 -i 参数则为写操作（原地编辑）
//  4. 网络重定向检测：检查命令是否涉及/dev/tcp 或/dev/udp 路径
//
// 特殊处理:
//   - 使用 positionalPathArgs 过滤掉命令行标志和选项，只保留位置参数
//   - sed 命令通过 sedEditsInPlace 检测是否使用原地编辑模式
//
// 示例（返回值不为空的情况）:
//  1. 重定向命令:
//     - "cat input.txt > output.txt" → 提取 output.txt(写), input.txt(读)
//     - "echo hello >> log.txt" → 提取 log.txt(写)
//  2. 删除命令:
//     - "rm /tmp/file.txt" → 提取 /tmp/file.txt(写)
//     - "rm -rf ./build" → 提取 ./build(写)
//  3. 移动命令:
//     - "mv src.txt dest.txt" → 提取 src.txt(写), dest.txt(写)
//  4. 复制命令:
//     - "cp source.txt /tmp/" → 提取 source.txt(读), /tmp/(写)
//     - "install app /usr/bin/" → 提取 app(读), /usr/bin/(写)
//  5. 属性修改命令:
//     - "chmod 755 script.sh" → 提取 script.sh(写)
//     - "touch newfile.txt" → 提取 newfile.txt(写)
//  6. 读取命令:
//     - "cat /etc/passwd" → 提取 /etc/passwd(读)
//     - "less ~/.bashrc" → 提取 ~/.bashrc(读)
//     - "sed -i 's/a/b/g' file.txt" → 提取 file.txt(写，因为是原地编辑)
//  7. 网络重定向:
//     - "echo hello > /dev/tcp/host/port" → 提取 /dev/tcp(写)
//
// 注意:
//   - 不在上述命令列表中的命令（如 ls、ps 等）不会提取路径请求，返回空列表
func commandPathRequests(raw string, cmd SimpleCommand) []pathReq {
	var out []pathReq
	// 步骤 1: 处理重定向操作
	for _, r := range cmd.Redirects {
		op := fileRead
		if strings.Contains(r.Op, ">") {
			op = fileWrite
		}
		out = append(out, pathReq{path: r.Target, op: op, reason: "重定向目标 " + r.Target})
	}
	// 步骤 2: 规范化命令参数
	argv, err := normalizeArgv(cmd.Argv)
	if err != nil || len(argv) == 0 {
		return out
	}
	// 获取基础命令名（去除路径前缀）
	base := normalizeBase(argv[0])
	// 步骤 3: 根据命令类型提取路径请求
	switch base {
	case "rm", "unlink", "rmdir", "shred":
		// 删除类命令：所有位置参数均为写操作
		for _, p := range positionalPathArgs(argv[1:]) {
			out = append(out, pathReq{path: p, op: fileWrite, reason: "删除目标 " + p})
		}
	case "mv":
		// 移动命令：所有位置参数均为写操作
		ps := positionalPathArgs(argv[1:])
		for _, p := range ps {
			out = append(out, pathReq{path: p, op: fileWrite, reason: "移动目标 " + p})
		}
	case "cp", "install":
		// 复制命令：除最后一个参数（目标）为写操作外，其余（源）为读操作
		ps := positionalPathArgs(argv[1:])
		for i, p := range ps {
			op := fileRead
			if i == len(ps)-1 {
				op = fileWrite
			}
			out = append(out, pathReq{path: p, op: op, reason: "文件目标 " + p})
		}
	case "chmod", "chown", "chgrp", "touch", "truncate":
		// 属性修改命令：所有位置参数均为写操作
		for _, p := range positionalPathArgs(argv[1:]) {
			out = append(out, pathReq{path: p, op: fileWrite, reason: "文件修改目标 " + p})
		}
	case "cat", "less", "more", "head", "tail", "sed", "awk":
		// 读取类命令：默认为读操作
		op := fileRead
		reasonPrefix := "文件读取目标 "
		// sed 命令若使用 -i 参数则为写操作（原地编辑）
		if base == "sed" && sedEditsInPlace(argv[1:]) {
			op = fileWrite
			reasonPrefix = "文件修改目标 "
		}
		for _, p := range positionalPathArgs(argv[1:]) {
			out = append(out, pathReq{path: p, op: op, reason: reasonPrefix + p})
		}
	default:
		op := fileRead
		reasonPrefix := "当前操作"
		for _, p := range argv[1:] {
			out = append(out, pathReq{path: p, op: op, reason: reasonPrefix + p})
		}
	}
	// 步骤 4: 检测网络重定向（/dev/tcp 或 /dev/udp）
	if strings.Contains(raw, "/dev/tcp/") || strings.Contains(raw, "/dev/udp/") {
		out = append(out, pathReq{path: "/dev/tcp", op: fileWrite, reason: "网络重定向目标 /dev/tcp"})
	}
	return out
}

func sedEditsInPlace(args []string) bool {
	for _, arg := range args {
		if arg == "--" {
			return false
		}
		if arg == "-i" || arg == "--in-place" || strings.HasPrefix(arg, "--in-place=") {
			return true
		}
		if strings.HasPrefix(arg, "-i") && arg != "-in" {
			return true
		}
	}
	return false
}

// positionalPathArgs 从命令行参数中提取位置参数，过滤掉标志和选项
//
// 参数:
//   - args: 命令行参数列表（通常不包含命令名本身）
//
// 返回值:
//   - []string: 提取后的位置参数列表
//
// 功能说明:
// 该函数用于解析命令行参数，识别并过滤掉各种形式的标志（flags）和选项（options），
// 只保留实际的路径或文件参数。这对于安全策略检查非常重要，因为需要准确识别
// 命令操作的目标文件路径。
//
// 处理规则:
//  1. "--" 分隔符：遇到"--"后，所有后续参数都视为位置参数
//  2. 短选项处理：以"-"开头的参数视为选项
//     - 已知无参数选项：-f, -r, -R, -p, -a, -v, -i, -n 直接跳过
//     - 其他选项：若不含"="则跳过下一个参数（认为是带值的选项）
//  3. 长选项处理：以"--"开头但不是"--"的参数，按类似规则处理
//  4. 位置参数：非选项参数直接添加到结果列表
//
// 示例:
//   - "rm -rf ./build" → 提取 ["./build"]
//   - "cp -a src.txt dest.txt" → 提取 ["src.txt", "dest.txt"]
//   - "sed -i 's/a/b/g' file.txt" → 提取 ["file.txt"]
//   - "cat -- -file.txt" → 提取 ["-file.txt"]（"--"后的参数即使是"-"开头也视为位置参数）
func positionalPathArgs(args []string) []string {
	var out []string
	skipNext := false
	afterDoubleDash := false
	for _, a := range args {
		if skipNext {
			skipNext = false
			continue
		}
		if afterDoubleDash {
			out = append(out, a)
			continue
		}
		if a == "--" {
			afterDoubleDash = true
			continue
		}
		if strings.HasPrefix(a, "-") {
			switch a {
			// case "-f", "-r", "-R", "-p", "-a", "-v", "-i", "-n":
			default:
				if isSubString(a) {
					continue
				}
				if !strings.Contains(a, "=") {
					skipNext = true
				}
			}
			continue
		}
		out = append(out, a)
	}
	return out
}

func isSubString(subStr string) bool {
	prefixStrings := []string{"-f", "-r", "-R", "-p", "-a", "-v", "-i", "-n"}
	for _, prefix := range prefixStrings {
		if strings.Contains(subStr, prefix) {
			return true
		}

	}
	return false
}
func resolvePath(target, cwd string) string {
	if strings.HasPrefix(target, "~") {
		if home, err := os.UserHomeDir(); err == nil {
			if target == "~" {
				target = home
			} else if strings.HasPrefix(target, "~/") {
				target = filepath.Join(home, target[2:])
			}
		}
	}
	if cwd == "" {
		cwd = "/"
	}
	if !filepath.IsAbs(target) {
		target = filepath.Join(cwd, target)
	}
	return filepath.Clean(target)
}

func resolvePathWithoutClean(target, cwd string) string {
	if strings.HasPrefix(target, "~") {
		if home, err := os.UserHomeDir(); err == nil {
			if target == "~" {
				target = home
			} else if strings.HasPrefix(target, "~/") {
				target = filepath.Join(home, target[2:])
			}
		}
	}
	if cwd == "" {
		cwd = "/"
	}
	if !filepath.IsAbs(target) {
		target = filepath.Join(cwd, target)
	}
	return target
}

func trimPathQuotes(s string) string {
	return strings.Trim(s, `"'`)
}

func isUNC(path string) bool {
	return strings.HasPrefix(path, `\\`) || strings.HasPrefix(path, "//")
}

func suspiciousWindowsPath(path string) bool {
	if strings.HasPrefix(path, `\\?\`) || strings.HasPrefix(path, `\\.\`) || strings.HasPrefix(path, "//?/") || strings.HasPrefix(path, "//./") {
		return true
	}
	if strings.Contains(path, "::$DATA") || regexp.MustCompile(`~\d`).MatchString(path) || regexp.MustCompile(`[.\s]+$`).MatchString(path) {
		return true
	}
	if len(path) > 2 && strings.Contains(path[2:], ":") {
		return true
	}
	return regexp.MustCompile(`(?i)(^|[/\\])(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(\.|[/\\]|$)|(^|[/\\])\.{3,}([/\\]|$)`).MatchString(path)
}

func shellExpansionPath(path string, op fileOp) bool {
	if strings.ContainsAny(path, "*?[") || strings.Contains(path, "$") || strings.Contains(path, "`") || strings.Contains(path, "$(") {
		return true
	}
	return op != fileRead && strings.Contains(path, "{")
}

func specialProcPath(path string) bool {
	return regexp.MustCompile(`^/proc/(self|\d+)/(environ|mem|fd|map_files)(/|$)`).MatchString(path)
}

func matchesAnyPath(path string, patterns []string) bool {
	for _, pattern := range patterns {
		p := resolvePath(pattern, "/")
		if path == p || strings.HasPrefix(path, strings.TrimRight(p, "/")+"/") {
			return true
		}
	}
	return false
}

func pathMatchesName(path string, names []string) bool {
	base := strings.ToLower(filepath.Base(path))
	for _, name := range names {
		if base == strings.ToLower(name) {
			return true
		}
	}
	return false
}

func sensitiveRepoRead(path string) bool {
	base := strings.ToLower(filepath.Base(path))
	if base == ".env" || base == ".npmrc" || base == ".pypirc" || base == "credentials" || base == "id_rsa" || base == "id_ed25519" {
		return true
	}
	for _, part := range strings.FieldsFunc(strings.ToLower(path), func(r rune) bool { return r == '/' || r == '\\' }) {
		if part == ".git" {
			return true
		}
	}
	return false
}

// dangerousAutoEdit 检查目标路径是否属于危险自动编辑文件或目录
//
// 参数:
//   - path: 待检查的目标路径
//   - policy: 安全策略配置，包含危险文件和目录列表
//
// 返回值:
//   - bool: 是否为危险自动编辑目标（true 表示需要拦截或审批）
//
// 功能说明:
// 该函数用于识别可能对系统安全造成风险的自动编辑操作目标。
// 当 AI 助手或自动化工具尝试修改某些敏感文件或目录时，
// 需要进行额外的安全审查，以防止意外破坏关键配置或泄露敏感信息。
//
// 检查流程:
//  1. UNC 路径检查：UNC 路径（如 \\server\share）直接视为危险目标
//  2. 危险目录检查：遍历路径各部分，检查是否命中配置的危险目录列表
//  3. 危险文件名检查：检查文件名是否命中配置的危险文件列表
//
// 典型危险文件示例:
//   - 配置文件：.bashrc, .profile, .ssh/config
//   - 凭证文件：credentials, .npmrc, .pypirc
//   - 密钥文件：id_rsa, id_ed25519
//
// 典型危险目录示例:
//   - 系统配置目录：/etc, /usr/bin
//   - 用户配置目录：~/.ssh, ~/.config
//   - 版本控制目录：.git
func dangerousAutoEdit(path string, policy *Policy) bool {
	// 步骤 1: UNC 路径检查 - UNC 路径直接视为危险目标
	if isUNC(path) {
		return true
	}
	// 步骤 2: 危险目录检查 - 将路径按分隔符拆分，逐部分检查是否命中危险目录
	parts := strings.FieldsFunc(strings.ToLower(path), func(r rune) bool { return r == '/' || r == '\\' })
	for _, part := range parts {
		for _, dir := range policy.Path.DangerousDirectories {
			if part == strings.ToLower(dir) {
				return true
			}
		}
	}
	// 步骤 3: 危险文件名检查 - 检查文件名是否命中危险文件列表
	return pathMatchesName(path, policy.Path.DangerousFiles)
}

func allowedInAllViews(views, dirs []string, cwd string) bool {
	for _, v := range views {
		ok := false
		for _, d := range dirs {
			dir := resolvePath(d, cwd)
			if v == dir || strings.HasPrefix(v, strings.TrimRight(dir, "/")+"/") {
				ok = true
				break
			}
		}
		if !ok {
			return false
		}
	}
	return true
}
