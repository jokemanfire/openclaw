package security

import (
	"bytes"
	"fmt"
	"regexp"
	"strconv"
	"strings"

	"mvdan.cc/sh/v3/syntax"
)

const (
	cmdSubPlaceholder = "__CMDSUB_OUTPUT__"
	varPlaceholder    = "__TRACKED_VAR__"
)

type parseResult struct {
	Kind     ParseKind
	Commands []SimpleCommand
	Reason   string
}

// parseForSecurity 对 Shell 命令进行安全解析，将其分解为简单命令列表
// 参数 command: 待解析的 Shell 命令字符串
// 返回值 parseResult: 包含解析结果的结构体，包括：
//   - Kind: 解析类型（ParseSimple 表示简单命令，ParseTooComplex 表示过于复杂）
//   - Commands: 解析后的简单命令列表
//   - Reason: 如果解析失败，返回失败原因描述
//
// 函数执行流程：
// 1. 预检查：调用 preflightShell 进行安全检查，检测控制字符、Unicode 空白、命令注入等风险
// 2. 空命令处理：如果命令为空或只包含空白字符，直接返回 ParseSimple
// 3. 语法解析：使用 mvdan.cc/sh/v3/syntax 包解析命令为 AST（抽象语法树）
// 4. 语句收集：遍历 AST 中的所有语句，提取简单命令并维护变量作用域
// 5. 结果返回：成功时返回 ParseSimple 和命令列表，失败时返回 ParseTooComplex 和原因
func parseForSecurity(command string) parseResult {
	// 步骤 1: 执行预检查，检测可能存在的安全风险和复杂语法
	// 如果发现问题（如控制字符、命令注入语法等），立即返回 ParseTooComplex
	if reason := preflightShell(command); reason != "" {
		return parseResult{Kind: ParseTooComplex, Reason: reason}
	}
	// 步骤 2: 处理空命令情况
	// 如果命令去除空白后为空，认为是简单命令，无需进一步解析
	if strings.TrimSpace(command) == "" {
		return parseResult{Kind: ParseSimple}
	}

	// 步骤 3: 创建语法解析器并解析命令
	// KeepComments(false) 表示不保留注释，减少 AST 节点数量
	parser := syntax.NewParser(syntax.KeepComments(false))
	file, err := parser.Parse(strings.NewReader(command), "")
	if err != nil {
		// 解析失败通常意味着命令语法复杂或有误，返回 ParseTooComplex
		return parseResult{Kind: ParseTooComplex, Reason: err.Error()}
	}

	// 步骤 4: 收集并遍历 AST 中的所有语句
	// cmds: 用于存储解析后的简单命令列表
	// scope: 变量作用域映射，用于跟踪变量的值，防止变量注入攻击
	var cmds []SimpleCommand
	scope := map[string]string{}
	// collectStmts 递归遍历 AST 节点，提取简单命令
	// 如果遇到无法处理的复杂结构（如动态命令名），返回错误原因
	if reason := collectStmts(file.Stmts, &cmds, scope); reason != "" {
		return parseResult{Kind: ParseTooComplex, Reason: reason}
	}
	// 步骤 5: 所有检查通过，返回解析成功的结果
	return parseResult{Kind: ParseSimple, Commands: cmds}
}

// preflightShell 对 Shell 命令进行预检查，检测可能存在的安全风险和复杂语法
// 参数 command: 待检查的 Shell 命令字符串
// 返回值：如果发现问题则返回错误描述字符串，否则返回空字符串表示通过检查
//
// 检查项目包括：
// 1. 控制字符检测：检测除换行、回车、制表符外的控制字符（ASCII < 0x20）
// 2. Unicode 空白字符检测：检测各种 Unicode 空白字符，防止利用特殊空白字符进行混淆攻击
// 3. 反斜杠转义空白字符检测：检测使用反斜杠转义的空白字符
// 4. 数组下标命令替换检测：检测类似 array[$(cmd)] 的语法，可能导致命令注入
// 5. Zsh 动态目录语法检测：检测 zsh 特有的 ~[...] 动态目录语法
// 6. Zsh 等号扩展检测：检测 zsh 特有的 =cmd 等号扩展语法
func preflightShell(command string) string {
	// 遍历命令中的每个字符进行安全检查
	for _, r := range command {
		// 检查控制字符：ASCII 码小于 0x20 的字符，但允许换行 (\n)、回车 (\r) 和制表符 (\t)
		if r < 0x20 && r != '\n' && r != '\r' && r != '\t' {
			return "Contains control characters"
		}
		// 检查 Unicode 空白字符：包括不间断空格、窄不间断空格、各种宽度空格、行分隔符、段落分隔符等
		// 这些特殊空白字符可能被用于混淆攻击或绕过安全检查
		if r == '\u00a0' || r == '\u1680' || (r >= '\u2000' && r <= '\u200a') || r == '\u2028' || r == '\u2029' || r == '\u202f' || r == '\u205f' || r == '\u3000' {
			return "Contains Unicode whitespace"
		}
	}
	// 检查反斜杠转义的空白字符：如 \ 、\t、\r、\n 等
	// 这种转义可能被用于绕过基于字符串匹配的安全检查
	if regexp.MustCompile(`\\[ \t\r\n]`).MatchString(command) {
		return "Contains backslash-escaped whitespace"
	}
	// 检查数组下标中的命令替换语法：如 array[$(cmd)] 形式
	// 这种语法会在数组下标求值时执行命令替换，可能导致命令注入
	if regexp.MustCompile(`[A-Za-z_][A-Za-z0-9_]*\[\$\(`).MatchString(command) {
		return "Builtin argument may evaluate subscript command substitution"
	}
	// 检查 Zsh 的动态目录语法：~[...] 形式
	// 这是 zsh shell 特有的动态目录命名功能，可能被用于路径遍历攻击
	if strings.Contains(command, "~[") {
		return "Contains zsh ~[ dynamic directory syntax"
	}
	// 检查 Zsh 的等号扩展：=cmd 形式（前面是空白、分号、& 或 | 等分隔符）
	// zsh 会将 =cmd 自动扩展为命令的完整路径，这可能被用于信息收集或绕过限制
	if regexp.MustCompile(`(^|[\s;&|])=[A-Za-z0-9_./-]+`).MatchString(command) {
		return "Contains zsh =cmd equals expansion"
	}
	// 所有检查通过，返回空字符串
	return ""
}

// collectStmts 遍历并收集 AST 中的所有语句，进行安全检查
// 参数 stmts: 语法语句列表
// 参数 commands: 用于存储解析后的简单命令列表的指针
// 参数 scope: 变量作用域映射，用于跟踪变量的值
// 返回值：如果发现问题则返回错误描述字符串，否则返回空字符串
//
// 函数执行流程：
// 1. 遍历所有语句，跳过空语句
// 2. 检查后台执行（&）和协进程（coprocess），这些被视为复杂语法
// 3. 调用 collectStmt 处理单个语句
func collectStmts(stmts []*syntax.Stmt, commands *[]SimpleCommand, scope map[string]string) string {
	for _, stmt := range stmts {
		if stmt == nil {
			continue
		}
		// 检查后台执行和协进程，这些是不安全的执行方式
		if stmt.Background || stmt.Coprocess {
			return "Contains background or coprocess execution"
		}
		// 递归处理单个语句
		if reason := collectStmt(stmt, commands, scope); reason != "" {
			return reason
		}
	}
	return ""
}

// collectStmt 处理单个语法语句，提取命令并处理重定向
// 参数 stmt: 语法语句节点
// 参数 commands: 用于存储解析后的简单命令列表的指针
// 参数 scope: 变量作用域映射
// 返回值：如果发现问题则返回错误描述字符串，否则返回空字符串
//
// 函数执行流程：
// 1. 处理否定语句（! command），创建局部作用域
// 2. 调用 collectCommand 处理命令部分
// 3. 处理重定向（如 >、>>、< 等），将重定向信息附加到命令
func collectStmt(stmt *syntax.Stmt, commands *[]SimpleCommand, scope map[string]string) string {
	// 处理否定的命令（以! 开头的命令）
	if stmt.Negated {
		local := cloneScope(scope)
		return collectCommand(stmt.Cmd, commands, local)
	}
	// 记录处理命令前的命令数量，用于判断是否生成了新命令
	before := len(*commands)
	// 处理命令主体
	if reason := collectCommand(stmt.Cmd, commands, scope); reason != "" {
		return reason
	}
	// 处理重定向（如果有）
	if len(stmt.Redirs) > 0 {
		var redirects []Redirect
		for _, redir := range stmt.Redirs {
			r, reason := walkRedirect(redir, commands, scope)
			if reason != "" {
				return reason
			}
			redirects = append(redirects, r)
		}
		// 如果已生成命令，将重定向附加到最后一条命令
		if len(*commands) > before {
			last := &(*commands)[len(*commands)-1]
			last.Redirects = append(last.Redirects, redirects...)
		} else {
			// 否则创建只包含重定向的新命令
			*commands = append(*commands, SimpleCommand{Redirects: redirects, Text: render(stmt)})
		}
	}
	return ""
}

// collectCommand 根据命令类型分发处理逻辑，是 AST 遍历的核心函数
// 参数 cmd: 语法命令节点接口
// 参数 commands: 用于存储解析后的简单命令列表的指针
// 参数 scope: 变量作用域映射
// 返回值：如果发现问题则返回错误描述字符串，否则返回空字符串
//
// 支持的命令类型：
// - CallExpr: 普通命令调用
// - BinaryCmd: 二元命令（如 &&、||、管道等）
// - Subshell: 子 shell（括号内的命令）
// - Block: 命令块
// - IfClause: if 条件语句
// - WhileClause: while 循环语句
// - ForClause: for 循环语句
// - DeclClause: 变量声明语句
// - TestClause: 测试表达式（如 [ ]、[[ ]]）
func collectCommand(cmd syntax.Command, commands *[]SimpleCommand, scope map[string]string) string {
	switch c := cmd.(type) {
	// 普通命令调用，如 ls -la
	case *syntax.CallExpr:
		simple, reason := walkCall(c, commands, scope)
		if reason != "" {
			return reason
		}
		*commands = append(*commands, simple)
	// 二元命令，如 cmd1 && cmd2、cmd1 || cmd2、cmd1 | cmd2
	case *syntax.BinaryCmd:
		// 分别处理左右两个子命令，各自使用独立的作用域副本
		leftScope := cloneScope(scope)
		if reason := collectStmt(c.X, commands, leftScope); reason != "" {
			return reason
		}
		rightScope := cloneScope(scope)
		if reason := collectStmt(c.Y, commands, rightScope); reason != "" {
			return reason
		}
	// 子 shell，如 (cmd)
	case *syntax.Subshell:
		// 创建局部作用域，子 shell 内的变量不影响外部
		local := cloneScope(scope)
		return collectStmts(c.Stmts, commands, local)
	// 命令块，如 { cmd; }
	case *syntax.Block:
		return collectStmts(c.Stmts, commands, scope)
	// if 条件语句
	case *syntax.IfClause:
		return collectIf(c, commands, scope)
	// while/until 循环语句
	case *syntax.WhileClause:
		// 先处理条件部分
		if reason := collectStmts(c.Cond, commands, scope); reason != "" {
			return reason
		}
		// 再处理循环体部分
		bodyScope := cloneScope(scope)
		return collectStmts(c.Do, commands, bodyScope)
	// for 循环语句
	case *syntax.ForClause:
		bodyScope := cloneScope(scope)
		// 如果是 for 迭代循环，将迭代变量标记为占位符
		if c.Loop != nil {
			if wl, ok := c.Loop.(*syntax.WordIter); ok && wl.Name != nil {
				bodyScope[wl.Name.Value] = varPlaceholder
			}
		}
		return collectStmts(c.Do, commands, bodyScope)
	// 变量声明语句，如 declare、local、export 等
	case *syntax.DeclClause:
		simple, reason := walkDecl(c, commands, scope)
		if reason != "" {
			return reason
		}
		*commands = append(*commands, simple)
	// 测试表达式，如 [[ $a -eq $b ]]
	case *syntax.TestClause:
		simple, reason := walkTest(c, commands, scope)
		if reason != "" {
			return reason
		}
		*commands = append(*commands, simple)
	// 空命令
	case nil:
		return ""
	// 其他未处理的命令类型
	default:
		return fmt.Sprintf("Unhandled node type: %T", cmd)
	}
	return ""
}

// collectIf 递归处理 if 条件语句的各个分支
// 参数 c: if 条件语句节点
// 参数 commands: 用于存储解析后的简单命令列表的指针
// 参数 scope: 变量作用域映射
// 返回值：如果发现问题则返回错误描述字符串，否则返回空字符串
//
// 函数执行流程：
// 1. 处理条件部分（Cond）
// 2. 处理 then 分支（Then）
// 3. 递归处理 else 分支（如果有）
func collectIf(c *syntax.IfClause, commands *[]SimpleCommand, scope map[string]string) string {
	if c == nil {
		return ""
	}
	// 处理条件表达式
	if reason := collectStmts(c.Cond, commands, scope); reason != "" {
		return reason
	}
	// 处理 then 分支，使用独立的作用域副本
	thenScope := cloneScope(scope)
	if reason := collectStmts(c.Then, commands, thenScope); reason != "" {
		return reason
	}
	// 递归处理 else 分支（可能是 elif 或 else）
	if c.Else != nil {
		elseScope := cloneScope(scope)
		return collectIf(c.Else, commands, elseScope)
	}
	return ""
}

// walkCall 处理普通命令调用，提取命令参数和环境变量
// 参数 call: 命令表达式节点
// 参数 commands: 用于存储解析后的简单命令列表的指针
// 参数 scope: 变量作用域映射
// 返回值：解析后的 SimpleCommand 结构体和错误信息（如果有）
//
// 函数执行流程：
// 1. 处理命令前的变量赋值（如 VAR=value cmd arg）
// 2. 处理命令参数（Args）
// 3. 构建 SimpleCommand 结构
// 4. 进行语义安全检查
func walkCall(call *syntax.CallExpr, commands *[]SimpleCommand, scope map[string]string) (SimpleCommand, string) {
	var argv []string
	var envs []EnvVar
	var redirects []Redirect
	// 处理命令前的环境变量赋值
	for _, assign := range call.Assigns {
		name, value, reason := walkAssign(assign, commands, scope)
		if reason != "" {
			return SimpleCommand{}, reason
		}
		envs = append(envs, EnvVar{Name: name, Value: value})
	}
	// 处理命令参数
	for _, word := range call.Args {
		arg, reason := walkWord(word, commands, scope, false)
		if reason != "" {
			return SimpleCommand{}, reason
		}
		argv = append(argv, arg)
	}
	// 构建简单命令结构
	simple := SimpleCommand{Argv: argv, EnvVars: envs, Redirects: redirects, Text: render(call)}
	// 进行语义安全检查，如检查命令名是否合法、是否有危险标志等
	if reason := checkSimpleSemantics(simple); reason != "" {
		return SimpleCommand{}, reason
	}
	return simple, ""
}

// walkDecl 处理变量声明语句（如 declare、local、export 等）
// 参数 decl: 声明子句节点
// 参数 commands: 用于存储解析后的简单命令列表的指针
// 参数 scope: 变量作用域映射
// 返回值：解析后的 SimpleCommand 结构体和错误信息（如果有）
//
// 函数执行流程：
// 1. 获取声明类型（如 declare、local、export）
// 2. 处理裸参数（无等号的参数）
// 3. 处理变量赋值，更新作用域
// 4. 进行语义安全检查
func walkDecl(decl *syntax.DeclClause, commands *[]SimpleCommand, scope map[string]string) (SimpleCommand, string) {
	// 初始化 argv，第一个元素是声明关键字（如 declare、local）
	argv := []string{decl.Variant.Value}
	for _, assign := range decl.Args {
		// 处理裸参数（没有等号的参数）
		if assign.Naked {
			if assign.Name != nil {
				argv = append(argv, assign.Name.Value)
				continue
			}
			if assign.Value != nil {
				value, reason := walkWord(assign.Value, commands, scope, false)
				if reason != "" {
					return SimpleCommand{}, reason
				}
				argv = append(argv, value)
				continue
			}
		}
		// 处理变量赋值（name=value 形式）
		name, value, reason := walkAssign(assign, commands, scope)
		if reason != "" {
			return SimpleCommand{}, reason
		}
		// 更新作用域中的变量
		scope[name] = value
		argv = append(argv, name+"="+value)
	}
	simple := SimpleCommand{Argv: argv, Text: render(decl)}
	// 进行语义安全检查
	if reason := checkSimpleSemantics(simple); reason != "" {
		return SimpleCommand{}, reason
	}
	return simple, ""
}

// walkTest 处理测试表达式（如 [[ $a -eq $b ]]）
// 参数 test: 测试子句节点
// 参数 commands: 用于存储解析后的简单命令列表的指针
// 参数 scope: 变量作用域映射
// 返回值：解析后的 SimpleCommand 结构体和错误信息（如果有）
//
// 函数执行流程：
// 1. 初始化 argv，以 [[ 开头
// 2. 使用 syntax.Walk 遍历测试表达式的所有节点
// 3. 提取单词节点的值并添加到 argv
// 4. 构建 SimpleCommand 结构
func walkTest(test *syntax.TestClause, commands *[]SimpleCommand, scope map[string]string) (SimpleCommand, string) {
	// 初始化 argv，以 [[ 作为测试表达式的开始标记
	argv := []string{"[["}
	var reason string
	// 遍历测试表达式树，提取所有单词节点
	syntax.Walk(test.X, func(node syntax.Node) bool {
		if reason != "" || node == nil {
			return false
		}
		// 如果是单词节点，解析其值
		if w, ok := node.(*syntax.Word); ok {
			var value string
			value, reason = walkWord(w, commands, scope, false)
			if reason == "" {
				argv = append(argv, value)
			}
			return false
		}
		return true
	})
	if reason != "" {
		return SimpleCommand{}, reason
	}
	return SimpleCommand{Argv: argv, Text: render(test)}, ""
}

func walkAssign(assign *syntax.Assign, commands *[]SimpleCommand, scope map[string]string) (string, string, string) {
	if assign.Name == nil {
		return "", "", "Variable assignment without name"
	}
	value := ""
	if assign.Value != nil {
		var reason string
		value, reason = walkWord(assign.Value, commands, scope, true)
		if reason != "" {
			return "", "", reason
		}
	}
	if strings.Contains(value, "~") {
		return "", "", "Tilde in assignment value - bash may expand at assignment time"
	}
	if assign.Append {
		value = scope[assign.Name.Value] + value
	}
	if strings.Contains(value, cmdSubPlaceholder) || strings.Contains(value, varPlaceholder) {
		scope[assign.Name.Value] = varPlaceholder
	} else {
		scope[assign.Name.Value] = value
	}
	return assign.Name.Value, value, ""
}

func walkRedirect(redir *syntax.Redirect, commands *[]SimpleCommand, scope map[string]string) (Redirect, string) {
	if redir.Hdoc != nil {
		return Redirect{}, "Heredoc with unquoted delimiter undergoes shell expansion"
	}
	target := ""
	if redir.Word != nil {
		var reason string
		target, reason = walkWord(redir.Word, commands, scope, false)
		if reason != "" {
			return Redirect{}, reason
		}
	}
	var fd *int
	if redir.N != nil {
		if n, err := strconv.Atoi(redir.N.Value); err == nil {
			fd = &n
		} else {
			return Redirect{}, "Invalid file descriptor"
		}
	}
	return Redirect{Op: redir.Op.String(), Target: target, FD: fd}, ""
}

// walkWord 处理单词（word）节点，解析单词的各个部分
// 参数 word: 单词节点
// 参数 commands: 用于存储解析后的简单命令列表的指针
// 参数 scope: 变量作用域映射
// 参数 insideString: 是否在字符串内部
// 返回值：解析后的字符串值和错误信息（如果有）
//
// 函数执行流程：
// 1. 遍历单词的所有部分（Parts）
// 2. 调用 walkWordPart 处理每个部分
// 3. 跟踪是否看到动态内容和字面量
// 4. 检查纯动态字符串的风险
func walkWord(word *syntax.Word, commands *[]SimpleCommand, scope map[string]string, insideString bool) (string, string) {
	var out strings.Builder
	sawDynamic := false // 标记是否看到动态内容（变量、命令替换等）
	sawLiteral := false // 标记是否看到字面量
	for _, part := range word.Parts {
		value, dynamic, reason := walkWordPart(part, commands, scope, insideString || len(word.Parts) > 1)
		if reason != "" {
			return "", reason
		}
		if dynamic {
			sawDynamic = true
		}
		if value != "" && value != varPlaceholder && value != cmdSubPlaceholder {
			sawLiteral = true
		}
		out.WriteString(value)
	}
	// 安全检查：如果字符串完全是动态的（没有字面量），可能存在风险
	if sawDynamic && !sawLiteral && insideString {
		return "", "String is only dynamic placeholder"
	}
	return out.String(), ""
}

// walkWordPart 处理单词部分的节点，是 walkWord 的子函数
// 参数 part: 单词部分节点
// 参数 commands: 用于存储解析后的简单命令列表的指针
// 参数 scope: 变量作用域映射
// 参数 insideString: 是否在字符串内部
// 返回值：解析后的字符串值、是否动态、错误信息（如果有）
//
// 支持的单词部分类型：
// - Lit: 字面量文本
// - SglQuoted: 单引号字符串
// - DblQuoted: 双引号字符串
// - ParamExp: 变量展开（如 $VAR、${VAR}）
// - CmdSubst: 命令替换（如 $(cmd)、`cmd`）
// - ArithmExp: 算术表达式（如 $((1+2))）
func walkWordPart(part syntax.WordPart, commands *[]SimpleCommand, scope map[string]string, insideString bool) (string, bool, string) {
	switch p := part.(type) {
	// 字面量文本
	case *syntax.Lit:
		text := p.Value
		// 检查大括号展开语法（如 {1..10}、{a,b,c}）
		if strings.ContainsAny(text, "{}") && (strings.Contains(text, ",") || strings.Contains(text, "..")) {
			return "", false, "Word contains brace expansion syntax"
		}
		return text, false, ""
	// 单引号字符串，不进行任何展开
	case *syntax.SglQuoted:
		return p.Value, false, ""
	// 双引号字符串，允许变量和命令替换
	case *syntax.DblQuoted:
		var out strings.Builder
		dynamic := false
		literal := false
		// 递归处理双引号内的所有部分
		for _, inner := range p.Parts {
			value, dyn, reason := walkWordPart(inner, commands, scope, true)
			if reason != "" {
				return "", false, reason
			}
			if dyn {
				dynamic = true
			}
			if value != "" && value != varPlaceholder && value != cmdSubPlaceholder {
				literal = true
			}
			out.WriteString(value)
		}
		// 安全检查：双引号内不能完全是动态内容
		if dynamic && !literal {
			return "", false, "String is only dynamic placeholder"
		}
		return out.String(), dynamic, ""
	// 变量展开
	case *syntax.ParamExp:
		name := ""
		if p.Param != nil {
			name = p.Param.Value
		}
		// 检查作用域中是否已跟踪该变量
		if tracked, ok := scope[name]; ok {
			// 如果变量值是动态的
			if strings.Contains(tracked, varPlaceholder) || strings.Contains(tracked, cmdSubPlaceholder) {
				if !insideString {
					return "", false, "Runtime value used as bare argument"
				}
				return varPlaceholder, true, ""
			}
			// 空变量展开
			if tracked == "" && !insideString {
				return "", false, "Empty expansion used as bare argument"
			}
			return tracked, false, ""
		}
		// 检查是否是安全的环境变量
		if insideString && isSafeEnvVar(name) {
			return varPlaceholder, true, ""
		}
		return "", false, "Untracked variable expansion"
	// 命令替换
	case *syntax.CmdSubst:
		// 创建局部作用域并递归处理命令
		local := cloneScope(scope)
		if reason := collectStmts(p.Stmts, commands, local); reason != "" {
			return "", false, reason
		}
		// 在字符串内返回占位符，否则拒绝
		if insideString {
			return cmdSubPlaceholder, true, ""
		}
		return "", false, "Contains command_substitution"
	// 算术表达式
	case *syntax.ArithmExp:
		return render(p), false, ""
	// 其他未处理的类型
	default:
		return "", false, fmt.Sprintf("Contains %T", part)
	}
}

// checkSimpleSemantics 检查简单命令的语义安全性
// 参数 cmd: 要检查的 SimpleCommand 结构
// 返回值：如果发现问题则返回错误描述字符串，否则返回空字符串
//
// 检查项目包括：
// 1. 空命令名检查
// 2. 动态命令名检查（包含占位符）
// 3. 不完整片段检查（以 -、|、& 开头）
// 4. Shell 关键字检查
// 5. 隐藏参数检查（换行后跟#注释）
// 6. jq 命令特殊检查（system() 函数、危险标志）
// 7. 评估类内置命令检查（eval、source 等）
// 8. zsh 危险内置命令检查
// 9. printf/read/[['s 命令注入检查
func checkSimpleSemantics(cmd SimpleCommand) string {
	if len(cmd.Argv) == 0 {
		return ""
	}
	// 标准化参数列表，处理 time、nohup、env 等包装命令
	argv, err := normalizeArgv(cmd.Argv)
	if err != nil {
		return err.Error()
	}
	if len(argv) == 0 {
		return ""
	}
	name := argv[0]
	// 检查空命令名
	if name == "" {
		return "Empty command name"
	}
	// 检查命令名是否包含动态占位符（运行时确定）
	if strings.Contains(name, varPlaceholder) || strings.Contains(name, cmdSubPlaceholder) {
		return "Command name is runtime-determined"
	}
	// 检查命令名是否以特殊字符开头（可能是不完整片段）
	if strings.HasPrefix(name, "-") || strings.HasPrefix(name, "|") || strings.HasPrefix(name, "&") {
		return "Command appears to be an incomplete fragment"
	}
	// 检查是否使用 Shell 关键字作为命令名
	if shellKeywords[strings.ToLower(name)] {
		return "Shell keyword '" + name + "' as command name"
	}
	// 检查是否有换行后跟#的情况（可能用于隐藏参数）
	if strings.Contains(cmd.Text, "\n") && regexp.MustCompile(`(?m)\n\s*#`).MatchString(cmd.Text) {
		return "Newline followed by # can hide arguments from validation"
	}
	lower := strings.ToLower(name)
	// 特殊处理 jq 命令
	if lower == "jq" {
		for _, arg := range argv {
			// 检查 system() 函数调用
			if regexp.MustCompile(`(?i)\bsystem\s*\(`).MatchString(arg) {
				return "jq command contains system() function which executes arbitrary commands"
			}
			// 检查危险标志
			if arg == "-f" || arg == "--from-file" || arg == "-L" || strings.HasPrefix(arg, "--argfile") || strings.HasPrefix(arg, "--rawfile") {
				return "jq command contains dangerous flags that could execute code or read arbitrary files"
			}
		}
	}
	// 检查评估类内置命令（可重新解释参数为代码）
	if evalLikeBuiltins[lower] {
		return "Command re-interprets arguments as code: " + name
	}
	// 检查 zsh 危险内置命令
	if zshDangerousBuiltins[lower] {
		return "Dangerous zsh builtin: " + name
	}
	// 检查 printf 命令的-v 标志
	if lower == "printf" {
		for i, arg := range argv {
			if arg == "-v" && i+1 < len(argv) && strings.Contains(argv[i+1], "$(") {
				return "Builtin argument may evaluate subscript command substitution"
			}
		}
	}
	// 检查 read 和 [[ 命令的参数
	if lower == "read" || lower == "[[" {
		for _, arg := range argv[1:] {
			if strings.Contains(arg, "$(") {
				return "Builtin argument may evaluate subscript command substitution"
			}
		}
	}
	return ""
}

// normalizeArgv 标准化命令参数列表，提取实际的命令和参数
// 参数 argv: 原始参数列表
// 返回值：标准化后的参数列表和错误信息（如果有）
//
// 处理的包装命令：
// - time/nohup: 时间统计和后台运行命令
// - env: 环境变量设置命令
// - timeout/nice/stdbuf: 超时/优先级/缓冲区控制命令
//
// 函数会递归地剥离这些包装命令，返回最终的被执行命令
func normalizeArgv(argv []string) ([]string, error) {
	args := append([]string(nil), argv...)
	for len(args) > 0 {
		switch args[0] {
		// 处理 time 和 nohup 命令
		case "time", "nohup":
			if len(args) > 1 && args[1] == "--" {
				args = args[2:]
			} else {
				args = args[1:]
			}
		// 处理 env 命令
		case "env":
			i := 1
			for i < len(args) {
				a := args[i]
				if a == "--" {
					i++
					break
				}
				// 跳过环境变量参数和标志
				if strings.Contains(a, "=") || strings.HasPrefix(a, "-") {
					i++
					continue
				}
				break
			}
			args = args[i:]
		// 处理 timeout、nice、stdbuf 命令
		case "timeout", "nice", "stdbuf":
			i := 1
			// 跳过所有标志参数
			for i < len(args) && strings.HasPrefix(args[i], "-") {
				i++
			}
			// timeout 命令需要额外跳过一个参数（持续时间）
			if i < len(args) && args[0] == "timeout" {
				i++
			}
			args = args[min(i, len(args)):]
		default:
			return args, nil
		}
	}
	return args, nil
}

// render 将语法树节点渲染为字符串表示
// 参数 node: 要渲染的语法树节点
// 返回值：渲染后的字符串
//
// 使用 mvdan.cc/sh/v3/syntax 包的 Printer 将 AST 节点
// 转换回 Shell 命令文本，用于记录和审计
func render(node syntax.Node) string {
	var buf bytes.Buffer
	_ = syntax.NewPrinter().Print(&buf, node)
	return buf.String()
}

// cloneScope 克隆变量作用域映射
// 参数 in: 输入的作用域映射
// 返回值：新的作用域映射副本
//
// 创建输入映射的浅拷贝，用于在不同作用域之间
// 传递变量状态，避免修改原始作用域
func cloneScope(in map[string]string) map[string]string {
	out := make(map[string]string, len(in))
	for k, v := range in {
		out[k] = v
	}
	return out
}

// isSafeEnvVar 判断环境变量是否为安全的环境变量
// 参数 name: 环境变量名称
// 返回值：true 表示是安全的环境变量，false 表示不是
//
// 安全的环境变量包括常见的系统和用户相关变量，
// 这些变量的值通常是可以信任的
func isSafeEnvVar(name string) bool {
	switch name {
	case "HOME", "USER", "USERNAME", "TMPDIR", "TMP", "TEMP", "PWD", "OLDPWD", "SHELL", "PATH":
		return true
	default:
		return false
	}
}

// shellKeywords 定义 Shell 关键字映射，用于检查命令名是否使用了保留关键字
// key: 关键字名称，value: true 表示是关键字（禁止作为命令名），false 表示不是关键字
// 包含 if/then/else/elif/fi、for/while/until/do/done、case/esac、function/select 等
var shellKeywords = map[string]bool{
	"if": true, "then": true, "else": true, "elif": true, "fi": true, "for": true,
	"while": true, "until": true, "do": true, "done": true, "case": true, "esac": true,
	"function": true, "select": true, "time": false,
}

// evalLikeBuiltins 定义可重新解释参数为代码的内置命令
// 这些命令可以执行动态代码，存在安全风险，需要被安全检查拦截
// 包括 eval（执行字符串代码）、source/.（ sourcing 脚本）、exec（替换进程）、command/builtin（绕过检查）
var evalLikeBuiltins = map[string]bool{
	"eval": true, "source": true, ".": true, "exec": true, "command": true, "builtin": true,
}

// zshDangerousBuiltins 定义 zsh 中危险的内置命令
// 这些命令可能被用于加载恶意模块或执行危险操作
// 包括 zcompile（编译脚本）、zmodload（加载模块）、autoload（自动加载函数）
var zshDangerousBuiltins = map[string]bool{
	"zcompile": true, "zmodload": true, "autoload": true,
}
