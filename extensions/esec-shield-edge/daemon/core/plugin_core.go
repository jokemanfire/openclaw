// Package core provides the plugin core that orchestrates security guardrail logic.
//
// PluginCore: central component
// /
// RegisterHandlers: routes hook events to appropriate handler set based on runtime.
// - openclaw: handlers for OpenClaw Plugin SDK (TypeScript gateway)
// - zeroclaw: handlers for ZeroClaw Rust hooks (Rust agent runtime)
//
// Dependency injection: all components passed via PluginCoreDeps, no globals.
package core

import (
	"encoding/json"

	"go.uber.org/zap"

	"esec-shield-daemon-edge/pkg/clawruntime"
	"esec-shield-daemon-edge/pkg/rpc"
)

// PluginCoreDeps: dependencies for PluginCore construction.
// All passed from main.go after init phase, no global references.
type PluginCoreDeps struct {
	Logger       *zap.Logger
	PluginConfig json.RawMessage
}

// PluginCore: central orchestrator for security guardrail logic.
// - logger: structured logging (zap)
type PluginCore struct {
	logger        *zap.Logger
	configManager *configManager
}

// NewPluginCore: creates PluginCore with injected dependencies.
// Config initialized from pluginConfig received in init phase.
func NewPluginCore(deps *PluginCoreDeps) *PluginCore {
	p := &PluginCore{
		logger:        deps.Logger,
		configManager: newConfigManager(deps.Logger),
	}
	p.configManager.updateFromPluginConfig(deps.PluginConfig)
	return p
}

// RegisterHandlers: routes hook events to appropriate handler set.
// Dispatch based on runtime from init phase.
func (p *PluginCore) RegisterHandlers(mux *rpc.Mux, runtime clawruntime.ClawRuntime) {
	switch runtime {
	case clawruntime.RuntimeOpenClaw:
		p.registerOpenClawHandlers(mux)
	case clawruntime.RuntimeZeroClaw:
		p.registerZeroClawHandlers(mux)
	}
}
