package config

const PluginID = "esec-shield-edge"

// PluginVersion is set at build time via -ldflags.
// Example: go build -ldflags="-X esec-shield-daemon-edge/config.PluginVersion=1.0.0"
var PluginVersion = "2026.5.18"

func DefaultConfig() *Config {
	return &Config{
		Log: LogConfig{
			Output:     "stderr",
			Level:      "debug",
			MaxSize:    30,
			MaxBackups: 3,
			MaxAge:     7,
			Compress:   true,
		},
	}
}
