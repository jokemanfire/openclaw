package security

import (
	"testing"
)

// TestParseForSecurity_DevTCP 测试 parseForSecurity 函数对 /dev/tcp 设备文件访问的解析
// 覆盖命令：nice -n 5 cat </dev/tcp/example.com/443
func TestParseForSecurity_DevTCP(t *testing.T) {
	tests := []struct {
		name         string
		command      string
		wantKind     ParseKind
		wantReason   string
		wantCmdCount int
	}{
		{
			name:         "read { path: \"./src/index.ts\" }",
			command:      "read { path: \"./src/index.ts\" }",
			wantKind:     ParseSimple,
			wantCmdCount: 1,
		},
		{
			name:         "rm -rf /tmp/test",
			command:      "rm -rf /tmp/test",
			wantKind:     ParseSimple,
			wantCmdCount: 1,
		},
		{
			name:         "nice with dev tcp redirect",
			command:      "nice -n 5 cat </dev/tcp/example.com/443",
			wantKind:     ParseSimple,
			wantCmdCount: 1,
		},
		{
			name:         "simple cat with dev tcp",
			command:      "cat </dev/tcp/example.com/443",
			wantKind:     ParseSimple,
			wantCmdCount: 1,
		},
		{
			name:         "nice without priority",
			command:      "nice cat </dev/tcp/example.com/443",
			wantKind:     ParseSimple,
			wantCmdCount: 1,
		},
		{
			name:         "dev tcp with different port",
			command:      "cat </dev/tcp/192.168.1.1/8080",
			wantKind:     ParseSimple,
			wantCmdCount: 1,
		},
		{
			name:         "dev tcp output redirect",
			command:      "echo test > /dev/tcp/example.com/443",
			wantKind:     ParseSimple,
			wantCmdCount: 1,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			result := parseForSecurity(tt.command)
			if result.Kind != tt.wantKind {
				t.Errorf("parseForSecurity(%q) Kind = %v, want %v", tt.command, result.Kind, tt.wantKind)
			}
			if tt.wantReason != "" && result.Reason != tt.wantReason {
				t.Errorf("parseForSecurity(%q) Reason = %q, want %q", tt.command, result.Reason, tt.wantReason)
			}
			if len(result.Commands) != tt.wantCmdCount {
				t.Errorf("parseForSecurity(%q) Commands count = %d, want %d", tt.command, len(result.Commands), tt.wantCmdCount)
			}
			if tt.wantCmdCount > 0 && len(result.Commands) > 0 {
				cmd := result.Commands[0]
				t.Logf("Command: %s, Argv: %v, Redirects: %v", cmd.Text, cmd.Argv, cmd.Redirects)
			}
		})
	}
}
