package rpc

import (
	"bytes"
	"encoding/json"
	"strings"
	"sync"
	"testing"
)

func TestWriterWrite(t *testing.T) {
	buf := &bytes.Buffer{}
	w := NewWriter(buf)

	msg := Response{
		Jsonrpc: "2.0",
		ID:      1,
		Result:  json.RawMessage(`"test"`),
	}

	if err := w.Write(msg); err != nil {
		t.Errorf("write failed: %v", err)
	}

	output := strings.TrimSpace(buf.String())

	var resp Response
	if err := json.Unmarshal([]byte(output), &resp); err != nil {
		t.Errorf("parse output failed: %v, output: %s", err, output)
	}

	if resp.Jsonrpc != "2.0" {
		t.Errorf("expected jsonrpc 2.0, got %s", resp.Jsonrpc)
	}

	if resp.ID != 1 {
		t.Errorf("expected id 1, got %d", resp.ID)
	}
}

func TestWriterWriteRegister(t *testing.T) {
	buf := &bytes.Buffer{}
	w := NewWriter(buf)

	params, _ := json.Marshal(RegisterParams{
		Hooks:   HookNames{HookGatewayStart},
		Version: "1.0.0",
	})

	msg := Request{
		Jsonrpc: "2.0",
		ID:      1,
		Method:  MethodRegister,
		Params:  params,
	}

	if err := w.Write(msg); err != nil {
		t.Errorf("write failed: %v", err)
	}

	output := strings.TrimSpace(buf.String())

	var req Request
	if err := json.Unmarshal([]byte(output), &req); err != nil {
		t.Errorf("parse output failed: %v, output: %s", err, output)
	}

	if req.Method != MethodRegister {
		t.Errorf("expected method '%s', got %s", MethodRegister, req.Method)
	}
}

func TestWriterWriteMultiple(t *testing.T) {
	buf := &bytes.Buffer{}
	w := NewWriter(buf)

	for i := range 10 {
		resultBytes, _ := json.Marshal(i)
		msg := Response{
			Jsonrpc: "2.0",
			ID:      i,
			Result:  resultBytes,
		}
		if err := w.Write(msg); err != nil {
			t.Errorf("write %d failed: %v", i, err)
		}
	}

	lines := strings.Split(strings.TrimSpace(buf.String()), "\n")
	if len(lines) != 10 {
		t.Errorf("expected 10 lines, got %d", len(lines))
	}
}

func TestWriterConcurrentWrite(t *testing.T) {
	buf := &bytes.Buffer{}
	w := NewWriter(buf)

	var wg sync.WaitGroup
	for i := range 100 {
		wg.Add(1)
		go func(id int) {
			defer wg.Done()
			msg := Response{Jsonrpc: "2.0", ID: id}
			w.Write(msg)
		}(i)
	}

	wg.Wait()

	lines := strings.Split(strings.TrimSpace(buf.String()), "\n")
	if len(lines) != 100 {
		t.Errorf("expected 100 lines, got %d", len(lines))
	}
}
