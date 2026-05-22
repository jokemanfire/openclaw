// Package rpc provides connection management for daemon-plugin IPC.
//
// Conn: manages stdin/stdout JSON-RPC 2.0 connection.
// - Call: sends request to plugin, returns AsyncCall for awaiting response
// - Run: reads from stdin, dispatches requests to mux, handles responses
// - Close: graceful shutdown with context timeout
//
// Key design:
// - AsyncCall: pending request awaiting response from plugin
// - pending map: tracks all pending calls for response matching
// - goroutine dispatch: each request handled in separate goroutine
// - mutex-protected stdout: Writer ensures concurrent-safe writes
//
// Protocol flow:
// 1. Run() starts read loop
// 2. Init() sends init request, awaits response (must call after Run starts)
// 3. Register() sends register request (must call after handlers registered)
// 4. Plugin sends hook events, Conn dispatches to Mux
// 5. Close() shuts down gracefully
package rpc

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"strings"
	"sync"
	"sync/atomic"

	"go.uber.org/zap"
)

// Conn: manages stdin/stdout JSON-RPC 2.0 connection.
// - seq: atomic request ID counter
// - reader: stdin for receiving requests/responses
// - writer: stdout for sending requests/responses (mutex-protected)
// - mux: handler router for dispatching requests
// - pending: map of pending calls awaiting response
type Conn struct {
	seq int64 // Atomic counter for request IDs

	reader io.Reader
	writer *Writer
	mux    *Mux
	logger *zap.Logger

	pendingMu sync.Mutex
	pending   map[int64]*AsyncCall // Pending calls awaiting response

	ctx    context.Context
	cancel context.CancelFunc
	done   chan struct{}
	wg     sync.WaitGroup

	stateMu sync.Mutex
	state   connState
}

type connState struct {
	closing  bool
	readErr  error
	writeErr error
}

// AsyncCall: pending request awaiting response from plugin.
// - id: request ID for matching response
// - ready: channel signaled when response received
// - result: response result (if success)
// - err: response error (if failure)
type AsyncCall struct {
	id     int64
	ready  chan struct{}
	result json.RawMessage
	err    *Error
	conn   *Conn
}

func NewConn(r io.Reader, w io.Writer, mux *Mux, logger *zap.Logger) *Conn {
	ctx, cancel := context.WithCancel(context.Background())
	return &Conn{
		reader: r,
		writer: NewWriter(w),
		mux:    mux,
		logger: logger,
		ctx:    ctx,
		cancel: cancel,
		done:   make(chan struct{}),
	}
}

// Call: sends request to plugin, returns AsyncCall for awaiting response.
// Request queued in pending map, response matched by ID.
func (c *Conn) Call(ctx context.Context, method string, params any) *AsyncCall {
	id := atomic.AddInt64(&c.seq, 1)

	ac := &AsyncCall{
		id:    id,
		ready: make(chan struct{}),
		conn:  c,
	}

	// Check connection state before sending
	c.stateMu.Lock()
	if c.state.closing || c.state.readErr != nil || c.state.writeErr != nil {
		ac.err = NewError(ErrCodeInternal, "connection closing", nil)
		close(ac.ready)
		c.stateMu.Unlock()
		return ac
	}
	c.stateMu.Unlock()

	// Marshal params
	rawParams, marshalErr := marshalParams(params)
	if marshalErr != nil {
		c.logger.Error("marshal params", zap.Int64("id", id), zap.String("method", method), zap.Error(marshalErr))
		c.retireCall(id, ac, nil, NewError(ErrCodeInternal, fmt.Sprintf("marshal params: %v", marshalErr), nil))
		return ac
	}

	// Track pending call for response matching
	c.pendingMu.Lock()
	if c.pending == nil {
		c.pending = make(map[int64]*AsyncCall)
	}
	c.pending[id] = ac
	c.pendingMu.Unlock()

	// Send request
	req := Request{
		Jsonrpc: "2.0",
		ID:      int(id),
		Method:  method,
		Params:  rawParams,
	}

	if writeErr := c.writer.Write(req); writeErr != nil {
		c.logger.Error("write call", zap.Int64("id", id), zap.String("method", method), zap.Error(writeErr))
		c.stateMu.Lock()
		if c.state.writeErr == nil {
			c.state.writeErr = writeErr
		}
		c.stateMu.Unlock()
		c.retireCall(id, ac, nil, NewError(ErrCodeInternal, "write failed", nil))
		return ac
	}

	c.logger.Debug("call sent", zap.Int64("id", id), zap.String("method", method))
	return ac
}

// Init: sends init request and awaits response.
// Must be called after Run() starts (read loop must be active).
// Returns runtime, pluginConfig, deviceInfo, userInfo from plugin.
func Init(ctx context.Context, conn *Conn) (InitResult, error) {
	ac := conn.Call(ctx, MethodInit, struct{}{})
	var result InitResult
	if err := ac.Await(ctx, &result); err != nil {
		return InitResult{}, err
	}
	return result, nil
}

// Register: sends register request with hooks and version.
// Must be called after handlers are registered on mux.
// Hooks sent without "hook:" prefix (OpenClaw SDK uses bare names).
// Plugin responds with accepted=true/false and negotiated version.
func Register(ctx context.Context, conn *Conn, params RegisterParams) (RegisterResult, error) {
	// Strip "hook:" prefix for wire format
	strippedHooks := make([]string, len(params.Hooks))
	for i, h := range params.Hooks {
		strippedHooks[i] = strings.TrimPrefix(string(h), "hook:")
	}
	ac := conn.Call(ctx, MethodRegister, registerParamsForWire{
		Hooks:   strippedHooks,
		Version: params.Version,
	})
	var result RegisterResult
	if err := ac.Await(ctx, &result); err != nil {
		return RegisterResult{}, err
	}
	return result, nil
}

// registerParamsForWire: internal type for JSON serialization without "hook:" prefix
type registerParamsForWire struct {
	Hooks   []string `json:"hooks"`
	Version string   `json:"version"`
}

// Await: waits for response and unmarshals result.
// Returns error if response has error field or unmarshal fails.
func (ac *AsyncCall) Await(ctx context.Context, result any) error {
	select {
	case <-ctx.Done():
		// Context canceled: remove from pending
		ac.conn.pendingMu.Lock()
		if ac.conn.pending[ac.id] == ac {
			delete(ac.conn.pending, ac.id)
		}
		ac.conn.pendingMu.Unlock()
		return ctx.Err()
	case <-ac.ready:
	}

	if ac.err != nil {
		return ac.err
	}

	if result == nil {
		return nil
	}

	if unmarshalErr := json.Unmarshal(ac.result, result); unmarshalErr != nil {
		ac.conn.logger.Warn("unmarshal result", zap.Int64("id", ac.id), zap.Error(unmarshalErr))
		return fmt.Errorf("unmarshal result: %w", unmarshalErr)
	}

	return nil
}

// Run: reads from stdin, dispatches requests to mux, handles responses.
// Loop continues until EOF or scanner error.
// Each request dispatched in separate goroutine for concurrent handling.
func (c *Conn) Run() error {
	scanner := bufio.NewScanner(c.reader)

	for scanner.Scan() {
		raw := scanner.Bytes()
		c.logger.Debug("daemon recv rpc msg", zap.ByteString("msg", raw))
		msg, decodeErr := decodeMessage(raw)
		if decodeErr != nil {
			c.logger.Error("decode message", zap.Error(decodeErr))
			c.sendError(0, ErrCodeParse, "parse error", nil)
			continue
		}

		// Request has method + id, Notification has method only (id == 0), Response has id only (no method)
		if msg.Method != "" {
			if msg.ID == 0 {
				c.handleNotify(msg)
			} else {
				c.handleRequest(msg)
			}
		} else {
			c.handleResponse(msg)
		}
	}

	scanErr := scanner.Err()
	if scanErr != nil && !errors.Is(scanErr, io.EOF) {
		c.logger.Error("scanner error", zap.Error(scanErr))
	}

	// Mark connection as closed
	c.stateMu.Lock()
	c.state.readErr = scanErr
	c.stateMu.Unlock()

	// Retire all pending calls with error
	c.pendingMu.Lock()
	for id, ac := range c.pending {
		ac.err = NewError(ErrCodeInternal, "connection closed", nil)
		close(ac.ready)
		c.logger.Warn("pending call retired", zap.Int64("id", id))
	}
	c.pending = nil
	c.pendingMu.Unlock()

	close(c.done)

	if errors.Is(scanErr, io.EOF) {
		return nil
	}
	return scanErr
}

// Close: graceful shutdown with context timeout.
// Waits for all handler goroutines to complete.
func (c *Conn) Close(ctx context.Context) error {
	c.stateMu.Lock()
	if c.state.closing {
		c.stateMu.Unlock()
		return nil
	}
	c.state.closing = true
	c.stateMu.Unlock()

	c.cancel()

	// Wait for handlers to complete
	done := make(chan struct{})
	go func() {
		c.wg.Wait()
		close(done)
	}()

	select {
	case <-done:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

// retireCall: removes call from pending, sets result/error, signals ready.
func (c *Conn) retireCall(id int64, ac *AsyncCall, result json.RawMessage, err *Error) {
	c.pendingMu.Lock()
	delete(c.pending, id)
	c.pendingMu.Unlock()

	ac.result = result
	ac.err = err
	close(ac.ready)
}

// handleResponse: matches response to pending call, signals ready.
func (c *Conn) handleResponse(msg *wireMessage) {
	id := int64(msg.ID)

	c.pendingMu.Lock()
	ac := c.pending[id]
	if ac != nil {
		delete(c.pending, id)
	}
	c.pendingMu.Unlock()

	if ac == nil {
		c.logger.Warn("response for unknown call", zap.Int("id", msg.ID))
		return
	}

	if msg.Error != nil {
		ac.err = msg.Error
		c.logger.Debug("call error response", zap.Int64("id", ac.id), zap.Int("code", msg.Error.Code), zap.String("message", msg.Error.Message))
	} else {
		ac.result = msg.Result
		c.logger.Debug("call success response", zap.Int64("id", ac.id))
	}

	close(ac.ready)
}

// handleRequest: dispatches request to mux in separate goroutine, sends response.
func (c *Conn) handleRequest(msg *wireMessage) {
	c.handleMethod(msg, true)
}

// handleNotify: dispatches notification to mux in separate goroutine, no response.
func (c *Conn) handleNotify(msg *wireMessage) {
	c.handleMethod(msg, false)
}

// handleMethod: common dispatch logic for both request and notification.
// If reply is true, sends result/error response; otherwise handles silently.
func (c *Conn) handleMethod(msg *wireMessage, reply bool) {
	c.wg.Go(func() {
		defer func() {
			if r := recover(); r != nil {
				c.logger.Error("handler panic", zap.String("method", msg.Method), zap.Any("panic", r), zap.StackSkip("stack", 1))
				if reply {
					c.sendError(msg.ID, ErrCodeInternal, fmt.Sprintf("handler panic: method=%s", msg.Method), nil)
				}
			}
		}()

		result, err := c.mux.Dispatch(c.ctx, msg.Method, msg.Params)
		if err != nil {
			c.logger.Error("handler error", zap.String("method", msg.Method), zap.Int("code", err.Code), zap.String("message", err.Message))
			if reply {
				c.sendError(msg.ID, err.Code, err.Message, err.Data)
			}
			return
		}

		if !reply {
			c.logger.Debug("handler success", zap.String("method", msg.Method))
			return
		}

		if result == nil {
			result = struct{}{}
		}
		c.logger.Debug("handler success", zap.Int("id", msg.ID), zap.String("method", msg.Method))
		c.sendResult(msg.ID, result)
	})
}

func (c *Conn) sendResult(id int, result any) {
	resp := Response{
		Jsonrpc: "2.0",
		ID:      id,
		Result:  mustMarshal(result),
	}
	if writeErr := c.writer.Write(resp); writeErr != nil {
		c.logger.Error("write result", zap.Int("id", id), zap.Error(writeErr))
		c.stateMu.Lock()
		if c.state.writeErr == nil {
			c.state.writeErr = writeErr
		}
		c.stateMu.Unlock()
	}
}

func (c *Conn) sendError(id int, code int, message string, data json.RawMessage) {
	resp := Response{
		Jsonrpc: "2.0",
		ID:      id,
		Error:   NewError(code, message, data),
	}
	if writeErr := c.writer.Write(resp); writeErr != nil {
		c.logger.Error("write error", zap.Int("id", id), zap.Error(writeErr))
		c.stateMu.Lock()
		if c.state.writeErr == nil {
			c.state.writeErr = writeErr
		}
		c.stateMu.Unlock()
	}
}

// wireMessage: internal type for decoding requests, responses, and notifications.
type wireMessage struct {
	Jsonrpc string          `json:"jsonrpc"`
	ID      int             `json:"id,omitempty"`
	Method  string          `json:"method,omitempty"`
	Params  json.RawMessage `json:"params,omitempty"`
	Result  json.RawMessage `json:"result,omitempty"`
	Error   *Error          `json:"error,omitempty"`
}

func decodeMessage(raw []byte) (*wireMessage, error) {
	var msg wireMessage
	if unmarshalErr := json.Unmarshal(raw, &msg); unmarshalErr != nil {
		return nil, fmt.Errorf("unmarshal: %w", unmarshalErr)
	}
	if msg.Jsonrpc != "2.0" {
		return nil, fmt.Errorf("invalid jsonrpc version: %s", msg.Jsonrpc)
	}
	return &msg, nil
}

func marshalParams(params any) (json.RawMessage, error) {
	if params == nil {
		return nil, nil
	}
	data, err := json.Marshal(params)
	if err != nil {
		return nil, err
	}
	return json.RawMessage(data), nil
}

func mustMarshal(v any) json.RawMessage {
	data, err := json.Marshal(v)
	if err != nil {
		return nil
	}
	return json.RawMessage(data)
}
