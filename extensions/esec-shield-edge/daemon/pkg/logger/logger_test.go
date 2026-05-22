package logger

import (
	"testing"
)

func TestNewStderr(t *testing.T) {
	cfg := LogConfig{
		Output: "stderr",
		Level:  "info",
	}

	log, err := New(cfg)
	if err != nil {
		t.Errorf("failed to create logger: %v", err)
	}
	_ = log
}

func TestNewStdout(t *testing.T) {
	cfg := LogConfig{
		Output: "stdout",
		Level:  "debug",
	}

	log, err := New(cfg)
	if err != nil {
		t.Errorf("failed to create logger: %v", err)
	}
	_ = log
}

func TestNewDefault(t *testing.T) {
	cfg := LogConfig{
		Output: "",
		Level:  "",
	}

	log, err := New(cfg)
	if err != nil {
		t.Errorf("failed to create logger: %v", err)
	}
	_ = log
}

func TestNewInvalidLevel(t *testing.T) {
	cfg := LogConfig{
		Output: "stderr",
		Level:  "invalid",
	}

	log, err := New(cfg)
	if err != nil {
		t.Errorf("invalid level should fallback to info: %v", err)
	}
	_ = log
}

func TestNewFile(t *testing.T) {
	cfg := LogConfig{
		Output:     "/tmp/test-daemon.log",
		Level:      "info",
		MaxSize:    10,
		MaxBackups: 1,
		MaxAge:     1,
		Compress:   false,
	}

	log, err := New(cfg)
	if err != nil {
		t.Errorf("failed to create file logger: %v", err)
	}

	if log != nil {
		log.Sync()
	}
}
