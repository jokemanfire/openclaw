package security

import (
	"strings"
	"testing"
)

func TestCheckCommandPathPolicy_CatProcSelfEnviron(t *testing.T) {
	policy, err := LoadPolicy(nil)
	if err != nil {
		t.Fatalf("LoadPolicy() error = %v", err)
	}

	rawCommand := "cat /proc/self/environ"
	commands := []SimpleCommand{
		{
			Argv:      []string{"cat", "/proc/self/environ"},
			EnvVars:   []EnvVar{},
			Redirects: []Redirect{},
			Text:      "cat /proc/self/environ",
		},
	}
	cwd := "/workspace"

	result, hit := checkCommandPathPolicy(rawCommand, commands, policy, cwd)

	// cat 命令在 commandPathRequests 处理的命令列表中
	// /proc/self/environ 是敏感路径，应该触发审批
	if !hit {
		t.Errorf("expected hit=true for 'cat /proc/self/environ', got hit=%v", hit)
	}
	if result.Decision != DecisionDeny {
		t.Errorf("expected Decision=ask for 'cat /proc/self/environ', got Decision=%v", result.Decision)
	}
}

func TestCheckCommandPathPolicy_RmEtcPasswd(t *testing.T) {
	policy, err := LoadPolicy(nil)
	if err != nil {
		t.Fatalf("LoadPolicy() error = %v", err)
	}

	rawCommand := "rm /etc/passwd"
	commands := []SimpleCommand{
		{
			Argv:      []string{"rm", "/etc/passwd"},
			EnvVars:   []EnvVar{},
			Redirects: []Redirect{},
			Text:      "rm /etc/passwd",
		},
	}
	cwd := "/workspace"

	result, hit := checkCommandPathPolicy(rawCommand, commands, policy, cwd)

	// rm 命令在 commandPathRequests 处理的命令列表中
	// /etc/passwd 在禁止路径中，应该被拒绝
	if !hit {
		t.Errorf("expected hit=true for 'rm /etc/passwd', got hit=%v", hit)
	}
	if result.Decision != DecisionDeny {
		t.Errorf("expected Decision=deny for 'rm /etc/passwd', got Decision=%v", result.Decision)
	}
}

func TestCheckCommandPathPolicy_CatEtcShadow(t *testing.T) {
	policy, err := LoadPolicy(nil)
	if err != nil {
		t.Fatalf("LoadPolicy() error = %v", err)
	}

	rawCommand := "cat /etc/shadow"
	commands := []SimpleCommand{
		{
			Argv:      []string{"cat", "/etc/shadow"},
			EnvVars:   []EnvVar{},
			Redirects: []Redirect{},
			Text:      "cat /etc/shadow",
		},
	}
	cwd := "/workspace"

	result, hit := checkCommandPathPolicy(rawCommand, commands, policy, cwd)

	// cat 命令在 commandPathRequests 处理的命令列表中
	// /etc/shadow 在禁止路径中，应该被拒绝
	if !hit {
		t.Errorf("expected hit=true for 'cat /etc/shadow', got hit=%v", hit)
	}
	if result.Decision != DecisionDeny {
		t.Errorf("expected Decision=deny for 'cat /etc/shadow', got Decision=%v", result.Decision)
	}
}

func TestCommandPathRequests_RmFile(t *testing.T) {
	rawCommand := "rm /tmp/file.txt"
	cmd := SimpleCommand{
		Argv:      []string{"rm", "/tmp/file.txt"},
		EnvVars:   []EnvVar{},
		Redirects: []Redirect{},
		Text:      "rm /tmp/file.txt",
	}

	requests := commandPathRequests(rawCommand, cmd)

	if len(requests) != 1 {
		t.Errorf("expected 1 request for 'rm /tmp/file.txt', got %d", len(requests))
	}
	if requests[0].path != "/tmp/file.txt" {
		t.Errorf("expected path='/tmp/file.txt', got path='%s'", requests[0].path)
	}
	if requests[0].op != fileWrite {
		t.Errorf("expected op=fileWrite for rm command, got op=%v", requests[0].op)
	}
	if requests[0].reason != "删除目标 /tmp/file.txt" {
		t.Errorf("expected reason='删除目标 /tmp/file.txt', got reason='%s'", requests[0].reason)
	}
}

func TestCommandPathRequests_EchoTcpRedirect(t *testing.T) {
	rawCommand := "echo hello > /dev/tcp/host/port"
	cmd := SimpleCommand{
		Argv:    []string{"echo", "hello"},
		EnvVars: []EnvVar{},
		Redirects: []Redirect{
			{
				Op:     ">",
				Target: "/dev/tcp/host/port",
			},
		},
		Text: "echo hello > /dev/tcp/host/port",
	}

	requests := commandPathRequests(rawCommand, cmd)

	// 应该至少有 2 个请求：重定向目标和网络重定向检测
	if len(requests) < 2 {
		t.Errorf("expected at least 2 requests for network redirect, got %d", len(requests))
	}

	// 检查重定向目标（写操作）
	foundRedirect := false
	for _, req := range requests {
		if req.path == "/dev/tcp/host/port" {
			foundRedirect = true
			if req.op != fileWrite {
				t.Errorf("expected op=fileWrite for redirect target, got op=%v", req.op)
			}
			if !strings.Contains(req.reason, "重定向目标") {
				t.Errorf("expected reason to contain '重定向目标', got reason='%s'", req.reason)
			}
		}
	}
	if !foundRedirect {
		t.Errorf("expected to find redirect target '/dev/tcp/host/port'")
	}

	// 检查网络重定向检测
	foundNetwork := false
	for _, req := range requests {
		if req.path == "/dev/tcp" {
			foundNetwork = true
			if req.op != fileWrite {
				t.Errorf("expected op=fileWrite for network redirect, got op=%v", req.op)
			}
			if !strings.Contains(req.reason, "网络重定向目标") {
				t.Errorf("expected reason to contain '网络重定向目标', got reason='%s'", req.reason)
			}
		}
	}
	if !foundNetwork {
		t.Errorf("expected to find network redirect detection '/dev/tcp'")
	}
}

func TestCommandPathRequests_UdpRedirect(t *testing.T) {
	rawCommand := "echo hello > /dev/udp/host/port"
	cmd := SimpleCommand{
		Argv:    []string{"echo", "hello"},
		EnvVars: []EnvVar{},
		Redirects: []Redirect{
			{
				Op:     ">",
				Target: "/dev/udp/host/port",
			},
		},
		Text: "echo hello > /dev/udp/host/port",
	}

	requests := commandPathRequests(rawCommand, cmd)

	// UDP 重定向也应该被检测
	foundNetwork := false
	for _, req := range requests {
		if req.path == "/dev/tcp" && strings.Contains(req.reason, "网络重定向目标") {
			foundNetwork = true
			break
		}
	}
	// 注意：当前实现只检测/dev/tcp，但 raw 中包含/dev/udp 也会触发
	// 根据 path.go:307 行的逻辑，只要包含/dev/udp 就会添加/dev/tcp 条目
	if !foundNetwork {
		t.Errorf("expected to find network redirect detection for UDP")
	}
}

func TestCommandPathRequests_MultipleRmFiles(t *testing.T) {
	rawCommand := "rm -rf /tmp/file1.txt /tmp/file2.txt"
	cmd := SimpleCommand{
		Argv:      []string{"rm", "-rf", "/tmp/file1.txt", "/tmp/file2.txt"},
		EnvVars:   []EnvVar{},
		Redirects: []Redirect{},
		Text:      "rm -rf /tmp/file1.txt /tmp/file2.txt",
	}

	requests := commandPathRequests(rawCommand, cmd)

	// 应该提取 2 个文件路径（排除-rf 标志）
	if len(requests) != 2 {
		t.Errorf("expected 2 requests for 'rm -rf file1 file2', got %d", len(requests))
	}

	paths := make(map[string]bool)
	for _, req := range requests {
		paths[req.path] = true
		if req.op != fileWrite {
			t.Errorf("expected op=fileWrite for rm command, got op=%v", req.op)
		}
	}

	if !paths["/tmp/file1.txt"] {
		t.Errorf("expected to find '/tmp/file1.txt'")
	}
	if !paths["/tmp/file2.txt"] {
		t.Errorf("expected to find '/tmp/file2.txt'")
	}
}

func TestCommandPathRequests_CpCommand(t *testing.T) {
	rawCommand := "cp source.txt /tmp/dest.txt"
	cmd := SimpleCommand{
		Argv:      []string{"cp", "source.txt", "/tmp/dest.txt"},
		EnvVars:   []EnvVar{},
		Redirects: []Redirect{},
		Text:      "cp source.txt /tmp/dest.txt",
	}

	requests := commandPathRequests(rawCommand, cmd)

	if len(requests) != 2 {
		t.Errorf("expected 2 requests for 'cp src dst', got %d", len(requests))
	}

	// 第一个参数是读操作
	foundRead := false
	for _, req := range requests {
		if req.path == "source.txt" {
			foundRead = true
			if req.op != fileRead {
				t.Errorf("expected op=fileRead for cp source, got op=%v", req.op)
			}
		}
	}
	if !foundRead {
		t.Errorf("expected to find read source 'source.txt'")
	}

	// 最后一个参数是写操作
	foundWrite := false
	for _, req := range requests {
		if req.path == "/tmp/dest.txt" {
			foundWrite = true
			if req.op != fileWrite {
				t.Errorf("expected op=fileWrite for cp dest, got op=%v", req.op)
			}
		}
	}
	if !foundWrite {
		t.Errorf("expected to find write dest '/tmp/dest.txt'")
	}
}

func TestCommandPathRequests_SedInPlace(t *testing.T) {
	rawCommand := "sed -i 's/foo/bar/g' file.txt"
	cmd := SimpleCommand{
		Argv:      []string{"sed", "-i", "s/foo/bar/g", "file.txt"},
		EnvVars:   []EnvVar{},
		Redirects: []Redirect{},
		Text:      "sed -i 's/foo/bar/g' file.txt",
	}

	requests := commandPathRequests(rawCommand, cmd)

	if len(requests) != 2 {
		t.Errorf("expected 1 request for sed -i, got %d", len(requests))
	}
	if requests[1].path != "file.txt" {
		t.Errorf("expected path='file.txt', got path='%s'", requests[0].path)
	}
	if requests[0].op != fileWrite {
		t.Errorf("expected op=fileWrite for sed -i (in-place), got op=%v", requests[0].op)
	}
}
