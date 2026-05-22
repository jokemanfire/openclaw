package rpc

import (
	"context"
	"encoding/json"
	"fmt"
)

type Handler func(ctx context.Context, params json.RawMessage) (result any, err *Error)

type Mux struct {
	// method name: method handler
	handlers map[string]Handler
}

func NewMux() *Mux {
	return &Mux{
		handlers: make(map[string]Handler),
	}
}

func (m *Mux) Handle(method string, h Handler) {
	m.handlers[method] = h
}

func (m *Mux) Dispatch(ctx context.Context, method string, params json.RawMessage) (result any, err *Error) {
	h, ok := m.handlers[method]
	if !ok {
		message := fmt.Sprintf("mux: method %q handler not found", method)
		return nil, NewError(ErrCodeNotFound, message, nil)
	}
	return h(ctx, params)
}

func (m *Mux) HasHandler(method string) bool {
	_, ok := m.handlers[method]
	return ok
}
