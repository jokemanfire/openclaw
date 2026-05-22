package core

import (
	"encoding/json"

	"go.uber.org/zap"
)

type configManager struct {
	pluginConfig *pluginConfig
	logger       *zap.Logger
}

func newConfigManager(logger *zap.Logger) *configManager {
	return &configManager{
		pluginConfig: defaultPluginConfig(),
		logger:       logger,
	}
}

func (m *configManager) updateFromPluginConfig(raw json.RawMessage) {
	if raw == nil {
		return
	}
	cfg, err := parsePluginConfig(raw)
	if err != nil {
		m.logger.Warn("parse pluginConfig", zap.Error(err))
		return
	}
	if cfg != nil {
		m.pluginConfig = cfg
		m.logger.Info("pluginConfig updated",
			zap.Bool("highRiskInstructionDetection", cfg.HighRiskInstructionDetection))
	}
}

type pluginConfig struct {
	HighRiskInstructionDetection bool `json:"highRiskInstructionDetection"`
}

func (m *configManager) getCurrent() *pluginConfig {
	return m.pluginConfig
}

func parsePluginConfig(raw json.RawMessage) (*pluginConfig, error) {
	if raw == nil {
		return nil, nil
	}
	var cfg pluginConfig
	if err := json.Unmarshal(raw, &cfg); err != nil {
		return nil, err
	}
	return &cfg, nil
}

func defaultPluginConfig() *pluginConfig {
	return &pluginConfig{
		HighRiskInstructionDetection: false,
	}
}
