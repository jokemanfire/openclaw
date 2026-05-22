package core

import (
	"context"
	"encoding/json"

	"esec-shield-daemon-edge/pkg/rpc"
)

type typedHookHandler[E any, C any] func(ctx context.Context, event E, hookCtx *C) (any, *rpc.Error)

type hookRequest[E any, C any] struct {
	Event   E `json:"event"`
	Context C `json:"context"`
}

func adaptHook[E any, C any](fn typedHookHandler[E, C]) rpc.Handler {
	return func(ctx context.Context, params json.RawMessage) (any, *rpc.Error) {
		var req hookRequest[E, C]
		if err := json.Unmarshal(params, &req); err != nil {
			return nil, rpc.NewError(rpc.ErrCodeParse, "parse hook params", nil)
		}
		return fn(ctx, req.Event, &req.Context)
	}
}

type GatewayMethodReq struct {
	ID     string
	Method string
}

// GatewayMethodHandler: handler for custom gateway methods.
type GatewayMethodHandler[P any] func(ctx context.Context, req GatewayMethodReq, params P) (any, *rpc.Error)

type gatewayMethodRequest[P any] struct {
	Req    GatewayMethodReq `json:"req"`
	Params P                `json:"params"`
}

// adaptGatewayMethod: adapts a typed gateway method handler to GatewayMethodHandler.
// Similar to adaptHook, uses generics to auto-unmarshal request into typed struct.
func adaptGatewayMethod[P any](fn GatewayMethodHandler[P]) rpc.Handler {
	return func(ctx context.Context, params json.RawMessage) (any, *rpc.Error) {
		var req gatewayMethodRequest[P]
		if err := json.Unmarshal(params, &req); err != nil {
			return nil, rpc.NewError(rpc.ErrCodeParse, "parse gateway method request", nil)
		}
		return fn(ctx, req.Req, req.Params)
	}
}
