package security

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestReviewConfirmLivesInSecurity(t *testing.T) {
	p := mustPolicy(t)
	got := CheckToolCall("exec", map[string]any{
		"command":      "git reset --hard HEAD~1",
		"_sec_confirm": "true",
	}, ToolContext{}, p)
	if got.Decision != DecisionAllow || got.Source != "review-confirm" {
		t.Fatalf("got %s/%s", got.Decision, got.Source)
	}
	if got.Params == nil || got.Params["_sec_confirm"] != nil || got.Params["command"] != "git reset --hard HEAD~1" {
		t.Fatalf("bad sanitized params: %#v", got.Params)
	}
	if reviewConfirmed(map[string]any{"_sec_confirm": false}) {
		t.Fatal("false confirmation should not pass")
	}
	if reviewConfirmed(map[string]any{"_sec_confirm": 1}) {
		t.Fatal("non bool/string confirmation should not pass")
	}
	if !reviewConfirmed(map[string]any{"_sec_confirm": "yes"}) {
		t.Fatal("yes confirmation should pass")
	}
}

func TestPolicyBranches(t *testing.T) {
	if _, err := LoadPolicy(json.RawMessage(`{"bad":`)); err == nil {
		t.Fatal("invalid wrapper config should fail")
	}
	if _, err := LoadPolicy(json.RawMessage(`{"policy":{"bad":`)); err == nil {
		t.Fatal("invalid embedded policy should fail")
	}
	p, err := LoadPolicy(json.RawMessage(`{"mode":"acceptEdits"}`))
	if err != nil {
		t.Fatal(err)
	}
	if p.Mode != "acceptEdits" {
		t.Fatalf("mode not applied: %q", p.Mode)
	}
	custom, err := LoadPolicy(json.RawMessage(`{"policy":{"protectedTools":["exec"],"path":{},"tools":{"exec":{"shell":{"commandRules":[{"id":"x","matchType":"any_args","baseCommand":"x","action":"deny","reason":"x"}]}}}}}`))
	if err != nil {
		t.Fatal(err)
	}
	if custom.Protects("gateway") {
		t.Fatal("gateway should not be protected")
	}
	if !custom.Protects("exec") {
		t.Fatal("exec should be protected")
	}
}

func TestToolBranchesForCoverage(t *testing.T) {
	p := mustPolicy(t)
	cases := []struct {
		name     string
		tool     string
		params   map[string]any
		ctx      ToolContext
		decision Decision
	}{
		{"unprotected", "unknown", nil, ToolContext{}, DecisionAllow},
		{"exec missing", "exec", map[string]any{}, ToolContext{}, DecisionAllow},
		{"nodes missing action", "nodes", map[string]any{}, ToolContext{}, DecisionAllow},
		{"nodes run array", "nodes", map[string]any{"action": "run", "command": []any{"git", "status"}}, ToolContext{}, DecisionAllow},
		{"nodes run missing", "nodes", map[string]any{"action": "run"}, ToolContext{}, DecisionAllow},
		{"nodes invoke raw", "nodes", map[string]any{"action": "invoke", "invokeCommand": "system.run", "rawCommand": "git status"}, ToolContext{}, DecisionAllow},
		{"nodes invoke json", "nodes", map[string]any{"action": "invoke", "invokeCommand": "system.run", "invokeParamsJson": `{"command":"git status"}`}, ToolContext{}, DecisionAllow},
		{"nodes invoke ignored", "nodes", map[string]any{"action": "invoke", "invokeCommand": "device.info"}, ToolContext{}, DecisionAllow},
		{"read missing", "read", map[string]any{}, ToolContext{}, DecisionAllow},
		{"patch cmd fallback", "apply_patch", map[string]any{"cmd": "*** Begin Patch\n*** Add File: a.txt\n+x\n*** End Patch"}, ToolContext{}, DecisionAllow},
		{"patch missing", "apply_patch", map[string]any{}, ToolContext{}, DecisionAllow},
		{"gateway missing", "gateway", map[string]any{}, ToolContext{}, DecisionAllow},
		{"gateway deny explicit", "gateway", map[string]any{"action": "restart"}, ToolContext{}, DecisionAsk},
		{"sessions spawn thread", "sessions_spawn", map[string]any{"threadRequested": true}, ToolContext{}, DecisionAsk},
		{"sessions spawn cross agent", "sessions_spawn", map[string]any{"agentId": "other"}, ToolContext{CurrentAgentID: "main"}, DecisionAsk},
		{"sessions spawn target no current", "sessions_spawn", map[string]any{"sessionKey": "target"}, ToolContext{}, DecisionAsk},
		{"sessions send same session", "sessions_send", map[string]any{"sessionKey": "main"}, ToolContext{CurrentSessionKey: "main"}, DecisionAllow},
		{"sessions send same agent", "sessions_send", map[string]any{"agentId": "main"}, ToolContext{CurrentAgentID: "main"}, DecisionAllow},
	}
	for _, tc := range cases {
		got := CheckToolCall(tc.tool, tc.params, tc.ctx, p)
		if got.Decision != tc.decision {
			t.Fatalf("%s: got %s/%s reason=%s", tc.name, got.Decision, got.Source, got.Reason)
		}
	}
	denyPolicy := *p
	denyPolicy.ToolPolicy.SessionsSend.DefaultAction = "deny"
	got := CheckToolCall("sessions_send", map[string]any{"sessionKey": "other"}, ToolContext{CurrentSessionKey: "main"}, &denyPolicy)
	if got.Decision != DecisionDeny {
		t.Fatalf("sessions_send deny got %s", got.Decision)
	}
}

func TestPatchParserErrorBranches(t *testing.T) {
	for _, patch := range []string{
		"*** Begin Patch\n*** Add File: \n*** End Patch",
		"*** Begin Patch\n*** Delete File: \n*** End Patch",
		"*** Begin Patch\n*** Update File: \n*** End Patch",
		"*** Begin Patch\n*** Move to: x\n*** End Patch",
		"*** Begin Patch\n*** Update File: a\n*** Move to: \n*** End Patch",
		"*** Begin Patch\n*** End Patch",
	} {
		if _, err := parsePatchTargets(patch); err == nil {
			t.Fatalf("expected error for %q", patch)
		}
	}
}

func TestPathBranchesForCoverage(t *testing.T) {
	p := mustPolicy(t)
	p.Path.AllowReadDirs = []string{"/workspace/project"}
	p.Path.AllowWriteDirs = []string{"/workspace/project"}
	p.Mode = "acceptEdits"
	cases := []struct {
		path     string
		op       fileOp
		decision Decision
	}{
		{"", fileRead, DecisionAllow},
		{"/dev/null", fileWrite, DecisionAllow},
		{"\\\\server\\share\\x", fileRead, DecisionAsk},
		{"C:/tmp/file::$DATA", fileRead, DecisionAsk},
		{"$HOME/.ssh/id_rsa", fileRead, DecisionAsk},
		{"*.txt", fileRead, DecisionAsk},
		{"/proc/123/environ", fileRead, DecisionDeny},
		{"outside.txt", fileRead, DecisionAllow},
		{"/outside.txt", fileRead, DecisionAsk},
		{"safe.txt", fileWrite, DecisionAllow},
	}
	for _, tc := range cases {
		_, got, _, blocked := validatePath(tc.path, tc.op, p, "/workspace/project")
		if !blocked && tc.decision != DecisionAllow {
			t.Fatalf("%s: expected block", tc.path)
		}
		if blocked && got != tc.decision {
			t.Fatalf("%s: got %s want %s", tc.path, got, tc.decision)
		}
	}
	p.Mode = ""
	_, got, _, blocked := validatePath("safe.txt", fileWrite, p, "/workspace/project")
	if !blocked || got != DecisionAsk {
		t.Fatalf("write without acceptEdits got blocked=%v decision=%s", blocked, got)
	}
}

func TestCommandAndPowerShellBranchesForCoverage(t *testing.T) {
	p := mustPolicy(t)
	cases := []struct {
		command  string
		decision Decision
	}{
		{"cd a && cd b", DecisionAsk},
		{"cd repo && git status", DecisionAsk},
		{"python3 -c \"import subprocess; subprocess.run('git status')\"", DecisionAllow},
		{"bash -c", DecisionAllow},
	}
	for _, tc := range cases {
		got := CheckCommand(tc.command, p, "/workspace/project")
		if got.Decision != tc.decision {
			t.Fatalf("%q got %s/%s reason=%s", tc.command, got.Decision, got.Source, got.Reason)
		}
	}
	if encodedPowerShellPayload("powershell -EncodedCommand Z") != "" {
		t.Fatal("bad base64 should decode empty")
	}
	if firstStringLiteral("abc") != "" {
		t.Fatal("no literal should be empty")
	}
	if !strings.Contains(strings.Join(sortedKeys(map[string]bool{"b": true, "a": true}), ","), "a,b") {
		t.Fatal("sorted keys broken")
	}
}

func TestASTAdditionalBranchesForCoverage(t *testing.T) {
	p := mustPolicy(t)
	cases := []struct {
		command  string
		decision Decision
	}{
		{"(git status)", DecisionAllow},
		{"{ git status; }", DecisionAllow},
		{"while test -f go.mod; do echo ok; break; done", DecisionAllow},
		{"if test -f go.mod; then echo ok; else echo no; fi", DecisionAllow},
		{"export FOO; echo ok", DecisionAllow},
		{"declare FOO=bar; echo $FOO", DecisionAllow},
		{"case x in x) echo ok;; esac", DecisionAsk},
		{"let x=1", DecisionAsk},
		{"function f { echo ok; }", DecisionAsk},
		{"echo ${UNTRACKED}", DecisionAsk},
		{"FOO=; echo $FOO", DecisionAsk},
		{"echo $?", DecisionAsk},
		{"echo ${HOME:-/tmp}", DecisionAsk},
		{"echo $((1+2))", DecisionAsk},
		{"echo $'ansi'", DecisionAllow},
		{"echo @(a|b)", DecisionAsk},
	}
	for _, tc := range cases {
		got := CheckCommand(tc.command, p, "/workspace/project")
		if got.Decision != tc.decision {
			t.Fatalf("%q got %s/%s reason=%s", tc.command, got.Decision, got.Source, got.Reason)
		}
	}
}

func TestCommandPathRequestBranchesForCoverage(t *testing.T) {
	cases := []struct {
		cmd  SimpleCommand
		want int
	}{
		{SimpleCommand{Argv: []string{"rm", "-r", "build"}}, 1},
		{SimpleCommand{Argv: []string{"unlink", "file"}}, 1},
		{SimpleCommand{Argv: []string{"mv", "a", "b"}}, 2},
		{SimpleCommand{Argv: []string{"cp", "a", "b"}}, 2},
		{SimpleCommand{Argv: []string{"install", "a", "b"}}, 2},
		{SimpleCommand{Argv: []string{"chmod", "600", "secret"}}, 2},
		{SimpleCommand{Argv: []string{"touch", "new"}}, 1},
		{SimpleCommand{Argv: []string{"sed", "-n", "1p", "file"}}, 2},
		{SimpleCommand{Redirects: []Redirect{{Op: ">", Target: "out"}}}, 1},
		{SimpleCommand{Argv: []string{"cat"}, Redirects: []Redirect{{Op: "<", Target: "/dev/tcp/example.com/443"}}}, 1},
	}
	for _, tc := range cases {
		got := commandPathRequests(strings.Join(tc.cmd.Argv, " "), tc.cmd)
		if len(got) != tc.want {
			t.Fatalf("%#v got %d want %d: %#v", tc.cmd.Argv, len(got), tc.want, got)
		}
	}
	if got := positionalPathArgs([]string{"--", "-literal"}); len(got) != 1 || got[0] != "-literal" {
		t.Fatalf("double dash handling failed: %#v", got)
	}
	if got := commandPathRequests("cat </dev/tcp/example.com/443", SimpleCommand{Argv: []string{"cat"}}); len(got) != 1 || got[0].path != "/dev/tcp" {
		t.Fatalf("dev tcp raw branch failed: %#v", got)
	}
}

func TestNetworkAndPolicyHelpersForCoverage(t *testing.T) {
	p := mustPolicy(t)
	p.InternalHosts = []string{"metadata.google.internal"}
	p.InternalSuffix = []string{"corp.internal"}
	for _, host := range []string{"localhost", "127.0.0.1", "10.0.0.1", "service.corp.internal", "metadata.google.internal"} {
		if isExternalTarget(host, p) {
			t.Fatalf("%s should be internal", host)
		}
	}
	if !isExternalTarget("example.com", p) {
		t.Fatal("example.com should be external")
	}
	if targetsMatch(nil, "external", p) != true {
		t.Fatal("unknown target should conservatively match")
	}
	if targetsMatch([]string{"localhost"}, "external", p) {
		t.Fatal("localhost should not match external")
	}
	if decisionRank(DecisionAllow) != 1 || decisionRank(DecisionAsk) != 2 || decisionRank(DecisionDeny) != 3 {
		t.Fatal("decision rank mismatch")
	}
	if appendIf([]string{"a"}, "")[0] != "a" {
		t.Fatal("appendIf empty mismatch")
	}
	if nonEmpty("", "fallback") != "fallback" || nonEmpty("x", "fallback") != "x" {
		t.Fatal("nonEmpty mismatch")
	}
}

func TestStructuredPolicyBranchesForCoverage(t *testing.T) {
	p := mustPolicy(t)
	custom := *p
	nodes := custom.ToolPolicy.Named["nodes"]
	nodes.DenyActions = []string{"status"}
	nodes.AllowActions = nil
	custom.ToolPolicy.Named["nodes"] = nodes
	got := CheckToolCall("nodes", map[string]any{"action": "status"}, ToolContext{}, &custom)
	if got.Decision != DecisionDeny {
		t.Fatalf("custom nodes deny got %s", got.Decision)
	}
	custom2 := *p
	cron := custom2.ToolPolicy.Cron
	cron.DenyActions = []string{"remove"}
	custom2.ToolPolicy.Cron = cron
	got = CheckToolCall("cron", map[string]any{"action": "remove"}, ToolContext{}, &custom2)
	if got.Decision != DecisionDeny {
		t.Fatalf("cron deny got %s", got.Decision)
	}
	f := false
	if boolPtrValue(&f, true) {
		t.Fatal("boolPtrValue false failed")
	}
	if boolPtrValue(nil, true) != true {
		t.Fatal("boolPtrValue fallback failed")
	}
}
