package rpc

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"strings"
	"testing"
	"time"

	"esec-shield-daemon-edge/pkg/clawruntime"

	"go.uber.org/zap/zaptest"
)

func TestConnInitAndRegister(t *testing.T) {
	mux := NewMux()

	mux.Handle(HookGatewayStart, func(ctx context.Context, params json.RawMessage) (result any, err *Error) {
		return struct{}{}, nil
	})

	logger := zaptest.NewLogger(t)

	r, w := io.Pipe()
	defer r.Close()
	defer w.Close()

	output := &bytes.Buffer{}

	conn := NewConn(r, output, mux, logger)

	runDone := make(chan error, 1)
	go func() {
		runDone <- conn.Run()
	}()

	ctx := context.Background()

	go func() {
		w.Write([]byte(`{"jsonrpc":"2.0","id":1,"result":{"runtime":"openclaw","pluginConfig":{},"deviceInfo":{},"userInfo":{"userId":"testuser"}}}` + "\n"))
	}()

	initResult, initErr := Init(ctx, conn)
	if initErr != nil {
		t.Errorf("unexpected init error: %v", initErr)
	}

	if initResult.Runtime != clawruntime.RuntimeOpenClaw {
		t.Errorf("expected runtime openclaw, got %s", initResult.Runtime)
	}

	if initResult.PluginConfig == nil {
		t.Error("expected pluginConfig")
	}

	go func() {
		w.Write([]byte(`{"jsonrpc":"2.0","id":2,"result":{"accepted":true,"version":"2026.4.0"}}` + "\n"))
	}()

	result, registerErr := Register(ctx, conn, RegisterParams{
		Hooks:   HookNames{HookGatewayStart},
		Version: "test",
	})

	if registerErr != nil {
		t.Errorf("unexpected register error: %v", registerErr)
	}

	if !result.Accepted {
		t.Error("expected accepted true")
	}

	if result.Version != "2026.4.0" {
		t.Errorf("expected version 2026.4.0, got %s", result.Version)
	}

	w.Close()

	select {
	case err := <-runDone:
		if err != nil {
			t.Errorf("unexpected run error: %v", err)
		}
	case <-time.After(2 * time.Second):
		t.Error("run did not complete")
	}
}

func TestConnCallTimeout(t *testing.T) {
	mux := NewMux()
	logger := zaptest.NewLogger(t)

	r, w := io.Pipe()
	defer r.Close()
	defer w.Close()

	output := &bytes.Buffer{}

	conn := NewConn(r, output, mux, logger)

	runDone := make(chan error, 1)
	go func() {
		runDone <- conn.Run()
	}()

	timeoutCtx, cancel := context.WithTimeout(context.Background(), 100*time.Millisecond)
	defer cancel()

	_, registerErr := Init(timeoutCtx, conn)

	if registerErr == nil {
		t.Error("expected timeout error")
	}

	if !errors.Is(registerErr, context.DeadlineExceeded) {
		t.Errorf("expected DeadlineExceeded, got %v", registerErr)
	}

	w.Close()

	select {
	case err := <-runDone:
		if err != nil && !errors.Is(err, io.EOF) {
			t.Errorf("unexpected run error: %v", err)
		}
	case <-time.After(2 * time.Second):
		t.Error("run did not complete")
	}
}

func TestConnRunHandleRequest(t *testing.T) {
	mux := NewMux()

	mux.Handle(HookGatewayStart, func(ctx context.Context, params json.RawMessage) (result any, err *Error) {
		return map[string]string{"status": "ok"}, nil
	})

	logger := zaptest.NewLogger(t)

	r, w := io.Pipe()
	defer r.Close()

	output := &bytes.Buffer{}

	conn := NewConn(r, output, mux, logger)

	runDone := make(chan error, 1)
	go func() {
		runDone <- conn.Run()
	}()

	req := `{"jsonrpc":"2.0","id":1,"method":"hook:gateway_start","params":{"event":{},"context":{}}}` + "\n"
	w.Write([]byte(req))

	time.Sleep(100 * time.Millisecond) // wait for response

	w.Close()

	select {
	case err := <-runDone:
		if err != nil {
			t.Errorf("unexpected run error: %v", err)
		}
	case <-time.After(2 * time.Second):
		t.Error("run did not complete")
	}

	resp := strings.TrimSpace(output.String())
	if resp == "" {
		t.Error("expected non-empty response")
		return
	}

	var response Response
	if unmarshalErr := json.Unmarshal([]byte(resp), &response); unmarshalErr != nil {
		t.Errorf("unmarshal response: %v", unmarshalErr)
	}

	if response.ID != 1 {
		t.Errorf("expected id 1, got %d", response.ID)
	}

	if response.Error != nil {
		t.Errorf("unexpected error: %v", response.Error)
	}
}

func TestConnRunParseError(t *testing.T) {
	mux := NewMux()
	logger := zaptest.NewLogger(t)

	r, w := io.Pipe()
	defer r.Close()
	defer w.Close()

	output := &bytes.Buffer{}

	conn := NewConn(r, output, mux, logger)

	runDone := make(chan error, 1)
	go func() {
		runDone <- conn.Run()
	}()

	w.Write([]byte("invalid json\n"))
	w.Close()

	select {
	case err := <-runDone:
		if err != nil {
			t.Errorf("unexpected run error: %v", err)
		}
	case <-time.After(2 * time.Second):
		t.Error("run did not complete")
	}

	resp := strings.TrimSpace(output.String())
	var response Response
	if unmarshalErr := json.Unmarshal([]byte(resp), &response); unmarshalErr != nil {
		t.Errorf("unmarshal response: %v", unmarshalErr)
	}

	if response.Error == nil {
		t.Error("expected parse error")
	}

	if response.Error.Code != ErrCodeParse {
		t.Errorf("expected error code %d, got %d", ErrCodeParse, response.Error.Code)
	}
}

func TestConnCloseGraceful(t *testing.T) {
	mux := NewMux()
	logger := zaptest.NewLogger(t)

	r, w := io.Pipe()
	defer r.Close()
	defer w.Close()

	output := &bytes.Buffer{}

	conn := NewConn(r, output, mux, logger)

	done := make(chan error, 1)
	go func() {
		done <- conn.Run()
	}()

	time.Sleep(50 * time.Millisecond)
	w.Close()

	shutdownCtx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()

	closeErr := conn.Close(shutdownCtx)

	if closeErr != nil {
		t.Errorf("unexpected close error: %v", closeErr)
	}

	select {
	case err := <-done:
		if err != nil {
			t.Errorf("unexpected run error: %v", err)
		}
	case <-time.After(3 * time.Second):
		t.Error("run did not complete")
	}
}

func TestConnCloseTimeout(t *testing.T) {
	mux := NewMux()

	mux.Handle(HookGatewayStart, func(ctx context.Context, params json.RawMessage) (result any, err *Error) {
		time.Sleep(10 * time.Second) // block forever
		return nil, nil
	})

	logger := zaptest.NewLogger(t)

	r, w := io.Pipe()
	defer r.Close()
	defer w.Close()

	output := &bytes.Buffer{}

	conn := NewConn(r, output, mux, logger)

	done := make(chan error, 1)
	go func() {
		done <- conn.Run()
	}()

	req := `{"jsonrpc":"2.0","id":1,"method":"hook:gateway_start","params":{}}` + "\n"
	w.Write([]byte(req))

	time.Sleep(50 * time.Millisecond)

	shutdownCtx, cancel := context.WithTimeout(context.Background(), 100*time.Millisecond)
	defer cancel()

	closeErr := conn.Close(shutdownCtx)

	if closeErr == nil {
		t.Error("expected close timeout error")
	}

	if !errors.Is(closeErr, context.DeadlineExceeded) {
		t.Errorf("expected DeadlineExceeded, got %v", closeErr)
	}
}

func TestConnCallConnectionClosing(t *testing.T) {
	mux := NewMux()
	logger := zaptest.NewLogger(t)

	r, w := io.Pipe()
	defer r.Close()
	defer w.Close()

	output := &bytes.Buffer{}

	conn := NewConn(r, output, mux, logger)

	shutdownCtx, cancel := context.WithTimeout(context.Background(), 1*time.Second)
	defer cancel()
	conn.Close(shutdownCtx)

	ac := conn.Call(context.Background(), "register", RegisterParams{})

	var result RegisterResult
	awaitErr := ac.Await(context.Background(), &result)

	if awaitErr == nil {
		t.Error("expected connection closing error")
	}
}

func TestAsyncCallAwaitUnmarshalError(t *testing.T) {
	mux := NewMux()
	logger := zaptest.NewLogger(t)

	r, w := io.Pipe()
	defer r.Close()
	defer w.Close()

	output := &bytes.Buffer{}

	conn := NewConn(r, output, mux, logger)

	runDone := make(chan error, 1)
	go func() {
		runDone <- conn.Run()
	}()

	ctx := context.Background()
	ac := conn.Call(ctx, "register", RegisterParams{})

	w.Write([]byte(`{"jsonrpc":"2.0","id":1,"result":"invalid"}` + "\n"))
	w.Close()

	var result RegisterResult
	awaitErr := ac.Await(ctx, &result)

	if awaitErr == nil {
		t.Error("expected unmarshal error")
	}

	if !strings.Contains(awaitErr.Error(), "unmarshal") {
		t.Errorf("expected unmarshal error, got %v", awaitErr)
	}

	select {
	case err := <-runDone:
		if err != nil {
			t.Errorf("unexpected run error: %v", err)
		}
	case <-time.After(2 * time.Second):
		t.Error("run did not complete")
	}
}
