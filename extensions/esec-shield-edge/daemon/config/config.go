package config

import (
	"encoding/json"
	"os"
	"time"
)

// Duration: custom type for JSON unmarshaling from string (e.g., "5s", "1m").
type Duration time.Duration

func (d *Duration) UnmarshalJSON(data []byte) error {
	var s string
	if err := json.Unmarshal(data, &s); err == nil {
		parsed, err := time.ParseDuration(s)
		if err != nil {
			return err
		}
		*d = Duration(parsed)
		return nil
	}

	var n float64
	if err := json.Unmarshal(data, &n); err != nil {
		return err
	}
	*d = Duration(time.Duration(n))
	return nil
}

func (d Duration) MarshalJSON() ([]byte, error) {
	return json.Marshal(time.Duration(d).String())
}

type Config struct {
	Log LogConfig `json:"log"`
}

type LogConfig struct {
	Output     string `json:"output"`
	Level      string `json:"level"`
	MaxSize    int    `json:"maxSize"`
	MaxBackups int    `json:"maxBackups"`
	MaxAge     int    `json:"maxAge"`
	Compress   bool   `json:"compress"`
}

// LoadConfig: loads config from ./daemon-config.json, falls back to DefaultConfig if not found.
func LoadConfig() (*Config, error) {
	data, err := os.ReadFile("daemon-config.json")
	if err != nil {
		if os.IsNotExist(err) {
			return DefaultConfig(), nil
		}
		return nil, err
	}

	cfg := DefaultConfig()
	if err := json.Unmarshal(data, cfg); err != nil {
		return nil, err
	}

	return cfg, nil
}
