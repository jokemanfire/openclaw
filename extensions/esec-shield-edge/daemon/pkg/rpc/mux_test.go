package rpc

import (
	"context"
	"encoding/json"
	"testing"
)

func TestMuxHandle(t *testing.T) {
	mux := NewMux()

	handler := func(ctx context.Context, params json.RawMessage) (result any, err *Error) {
		return "ok", nil
	}

	mux.Handle(HookGatewayStart, handler)

	if !mux.HasHandler(HookGatewayStart) {
		t.Error("expected handler to be registered")
	}

	if mux.HasHandler(HookSessionStart) {
		t.Error("expected nonexistent handler to not be registered")
	}
}

func TestMuxDispatch(t *testing.T) {
	mux := NewMux()

	handler := func(ctx context.Context, params json.RawMessage) (result any, err *Error) {
		return "ok", nil
	}

	mux.Handle(HookGatewayStart, handler)

	params := json.RawMessage(`{"event":{},"context":{}}`)
	result, err := mux.Dispatch(context.Background(), HookGatewayStart, params)

	if err != nil {
		t.Errorf("unexpected error: %v", err)
	}

	if result != "ok" {
		t.Errorf("expected 'ok', got %v", result)
	}
}

func TestMuxDispatchNoHandler(t *testing.T) {
	mux := NewMux()

	params := json.RawMessage(`{"event":{},"context":{}}`)
	result, err := mux.Dispatch(context.Background(), HookSessionStart, params)

	if err == nil {
		t.Fatal("expected error for no handler")
	}

	if err.Code != ErrCodeNotFound {
		t.Errorf("expected error code %d, got %d", ErrCodeNotFound, err.Code)
	}

	if result != nil {
		t.Errorf("expected nil result for no handler, got %v", result)
	}
}

func TestMuxDispatchHandlerError(t *testing.T) {
	mux := NewMux()

	handler := func(ctx context.Context, params json.RawMessage) (result any, err *Error) {
		return nil, NewError(ErrCodeInternal, "internal error", nil)
	}

	mux.Handle(HookAgentEnd, handler)

	params := json.RawMessage(`{}`)
	result, err := mux.Dispatch(context.Background(), HookAgentEnd, params)

	if err == nil {
		t.Fatal("expected error from handler")
	}

	if err.Code != ErrCodeInternal {
		t.Errorf("expected error code %d, got %d", ErrCodeInternal, err.Code)
	}

	if result != nil {
		t.Errorf("expected nil result, got %v", result)
	}
}
