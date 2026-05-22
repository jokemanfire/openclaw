package security

import (
	"testing"
)

// TestCheckToolCall_AllowRules 测试 ALLOW 类型规则的放行能力
// 针对 command_list_analysis.md 中 ALLOW 类别的每个 Pattern/Command 举例一条指令
func TestCheckToolCall_AllowRules(t *testing.T) {
	policy, err := LoadPolicy(nil)
	if err != nil {
		t.Fatalf("LoadPolicy() error = %v", err)
	}
	varReboot_phone := `/system_ext/bin/tools-cli.sh '{"name": "reboot_phone", "arguments": "{\"isConfirm\":\"TBD\"}"}'"}'`
	varDownload_or_install_app := `/system_ext/bin/tools-cli.sh '{"name": "download_or_install_app", "arguments": "{\"app\": \"微信\"}"}'`
	varUninstall_app := `/system_ext/bin/tools-cli.sh '{"name": "uninstall_app", "arguments": "{\"app\": \"微信\"}"}'`
	varShutdown_phone := `/system_ext/bin/tools-cli.sh '{"name": "shutdown_phone", "arguments": "{\"isConfirm\":\"TBD\"}"}'"}'`
	tests := []struct {
		name         string
		toolName     string
		params       map[string]any
		ctx          ToolContext
		wantDecision Decision
	}{
		{
			name:     "system_ext/bin/tools-cli.sh_reboot_phone",
			toolName: "exec",
			params:   map[string]any{"command": varReboot_phone},
			ctx:      ToolContext{CWD: ""},
			// allow_chmod_openclaw_dot_openclaw 规则被 ALLOW
			wantDecision: DecisionDeny,
		},
		{
			name:     "system_ext/bin/tools-cli.sh_shutdown_phone",
			toolName: "exec",
			params:   map[string]any{"command": varShutdown_phone},
			ctx:      ToolContext{CWD: ""},
			// allow_chmod_openclaw_dot_openclaw 规则被 ALLOW
			wantDecision: DecisionDeny,
		},
		{
			name:     "system_ext/bin/tools-cli.sh_download_or_install_app",
			toolName: "exec",
			params:   map[string]any{"command": varDownload_or_install_app},
			ctx:      ToolContext{CWD: ""},
			// allow_chmod_openclaw_dot_openclaw 规则被 ALLOW
			wantDecision: DecisionDeny,
		},
		{
			name:     "system_ext/bin/tools-cli.sh_uninstall_app",
			toolName: "exec",
			params:   map[string]any{"command": varUninstall_app},
			ctx:      ToolContext{CWD: ""},
			// allow_chmod_openclaw_dot_openclaw 规则被 ALLOW
			wantDecision: DecisionDeny,
		},
		{
			name:     "chmod 755 /var/log",
			toolName: "exec",
			params:   map[string]any{"command": "chmod 755 /var/log"},
			ctx:      ToolContext{CWD: ""},
			// allow_chmod_openclaw_dot_openclaw 规则被 ALLOW
			wantDecision: DecisionAsk,
		},
		{
			name:     "chmod 755 /data/openclaw/tmp - 允许 /data/openclaw/tmp 下 chmod",
			toolName: "exec",
			params:   map[string]any{"command": "chmod 755 /data/openclaw/tmp"},
			ctx:      ToolContext{CWD: "/tmp"},
			// allow_chmod_openclaw_tmp 规则被 ALLOW
			wantDecision: DecisionAsk,
		},
		{
			name:     "chown root:root /data/openclaw/home/.openclaw - 允许 .openclaw 下 chown",
			toolName: "exec",
			params:   map[string]any{"command": "chown root:root /data/openclaw/home/.openclaw"},
			ctx:      ToolContext{CWD: "/tmp"},
			// allow_chown_openclaw_dot_openclaw 规则被 ALLOW
			wantDecision: DecisionAsk,
		},
		{
			name:     "chown root:root /data/openclaw/tmp - 允许 /data/openclaw/tmp 下 chown",
			toolName: "exec",
			params:   map[string]any{"command": "chown root:root /data/openclaw/tmp"},
			ctx:      ToolContext{CWD: "/tmp"},
			// allow_chown_openclaw_tmp 规则被 ALLOW
			wantDecision: DecisionAsk,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			result := CheckToolCall(tt.toolName, tt.params, tt.ctx, policy)

			if result.Decision != tt.wantDecision {
				t.Errorf("CheckToolCall() decision = %v, want %v, reason=%s, ruleID=%s", result.Decision, tt.wantDecision, result.Reason, result.RuleID)
			}
		})
	}
}
