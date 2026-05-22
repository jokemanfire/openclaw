package logger

import (
	"io"
	"os"

	"go.uber.org/zap"
	"go.uber.org/zap/zapcore"
	"gopkg.in/natefinch/lumberjack.v2"
)

type LogConfig struct {
	Output     string `json:"output"`     // "stderr" | "stdout" | 文件路径
	Level      string `json:"level"`      // "debug" | "info" | "warn" | "error"
	MaxSize    int    `json:"maxSize"`    // MB, 轮转大小
	MaxBackups int    `json:"maxBackups"` // 保留文件数
	MaxAge     int    `json:"maxAge"`     // 保留天数
	Compress   bool   `json:"compress"`   // 是否压缩旧日志
}

func New(cfg LogConfig) (*zap.Logger, error) {
	level, err := parseLevel(cfg.Level)
	if err != nil {
		level = zapcore.InfoLevel
	}
	encoder := zapcore.NewJSONEncoder(zapcore.EncoderConfig{
		TimeKey:        "ts",
		LevelKey:       "level",
		NameKey:        "logger",
		CallerKey:      "caller",
		FunctionKey:    zapcore.OmitKey,
		MessageKey:     "msg",
		StacktraceKey:  "stacktrace",
		LineEnding:     zapcore.DefaultLineEnding,
		EncodeLevel:    zapcore.LowercaseLevelEncoder,
		EncodeTime:     zapcore.ISO8601TimeEncoder,
		EncodeDuration: zapcore.SecondsDurationEncoder,
		EncodeCaller:   zapcore.ShortCallerEncoder,
	})

	writeSyncer, err := getWriteSyncer(cfg)
	if err != nil {
		return nil, err
	}

	core := zapcore.NewCore(encoder, writeSyncer, level)
	return zap.New(core, zap.AddCaller()), nil
}

func parseLevel(level string) (zapcore.Level, error) {
	var l zapcore.Level
	err := l.UnmarshalText([]byte(level))
	return l, err
}

func getWriteSyncer(cfg LogConfig) (zapcore.WriteSyncer, error) {
	var w io.Writer

	switch cfg.Output {
	case "stderr":
		w = os.Stderr
	case "stdout":
		w = os.Stdout
	case "":
		w = os.Stderr
	default:
		w = &lumberjack.Logger{
			Filename:   cfg.Output,
			MaxSize:    cfg.MaxSize,
			MaxBackups: cfg.MaxBackups,
			MaxAge:     cfg.MaxAge,
			Compress:   cfg.Compress,
		}
	}

	return zapcore.AddSync(w), nil
}
