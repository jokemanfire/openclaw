package main

import (
	"context"
	"fmt"
	"os"
	"runtime/debug"
	"time"

	"go.uber.org/zap"

	"esec-shield-daemon-edge/config"
	"esec-shield-daemon-edge/core"
	"esec-shield-daemon-edge/pkg/clawruntime"
	"esec-shield-daemon-edge/pkg/logger"
	"esec-shield-daemon-edge/pkg/rpc"
)

// IPC Protocol Flow:
//
// 1. Init: daemon → plugin, gets runtime + pluginConfig + deviceInfo
//    Request:  {"jsonrpc":"2.0","id":1,"method":"init","params":{}}
//    Response: {"jsonrpc":"2.0","id":1,"result":{"runtime":"openclaw","pluginConfig":{}}}
//
// 2. Register: daemon → plugin, subscribes hooks, gets version negotiation
//    Request:  {"jsonrpc":"2.0","id":2,"method":"register","params":{"hooks":[...],"version":"..."}}
//    Response: {"jsonrpc":"2.0","id":2,"result":{"accepted":true,"version":"..."}}
//
// 3. Hook Events: plugin → daemon, runtime hook invocations (loop)
//    Request:  {"jsonrpc":"2.0","id":N,"method":"hook:xxx","params":{"event":{},...}}
//    Response: {"jsonrpc":"2.0","id":N,"result":{...}}
//
// Key insight: init provides config BEFORE deps are built, register happens AFTER handlers are registered.

func setupCrashLog() *os.File {
	crashLogPath := ".daemon-crash.log"

	if info, err := os.Stat(crashLogPath); err == nil && info.Size() > 0 {
		backupPath := crashLogPath + ".prev"
		if err := os.Rename(crashLogPath, backupPath); err != nil {
			fmt.Fprintf(os.Stderr, "backup crash log: %v\n", err)
		}
	}

	f, err := os.OpenFile(crashLogPath, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0644)
	if err != nil {
		fmt.Fprintf(os.Stderr, "create crash log: %v\n", err)
		return nil
	}
	return f
}

func main() {
	crashLogFile := setupCrashLog()
	if crashLogFile != nil {
		debug.SetCrashOutput(crashLogFile, debug.CrashOptions{})
		_ = crashLogFile.Close()
	}

	cfg, err := config.LoadConfig()
	if err != nil {
		fmt.Fprintf(os.Stderr, "load config: %v\n", err)
		os.Exit(1)
	}

	log, err := logger.New(logger.LogConfig(cfg.Log))
	if err != nil {
		fmt.Fprintf(os.Stderr, "init logger: %v\n", err)
		os.Exit(1)
	}
	defer log.Sync()

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	go handleSignals(ctx, cancel, log)

	mux := rpc.NewMux()
	conn := rpc.NewConn(os.Stdin, os.Stdout, mux, log)

	runErr := make(chan error, 1)
	go func() {
		runErr <- conn.Run()
	}()

	initResult, err := rpc.Init(ctx, conn)
	if err != nil {
		log.Error("init failed", zap.Error(err))
		os.Exit(1)
	}

	deps := buildDeps(initResult, cfg, log)

	_ = buildPluginCore(deps, mux, initResult.Runtime)

	hooks := rpc.HookNames{
		rpc.HookBeforeToolCall,
	}

	registerResult, err := rpc.Register(ctx, conn, rpc.RegisterParams{
		Hooks:   hooks,
		Version: config.PluginVersion,
	})
	if err != nil {
		log.Error("register failed", zap.Error(err))
		os.Exit(1)
	}
	if !registerResult.Accepted {
		log.Error("register rejected")
		os.Exit(1)
	}

	log.Info("register accepted",
		zap.Strings("hooks", hooks.ToStrings()),
		zap.String("runtime", string(initResult.Runtime)),
		zap.String("plugin_version", registerResult.Version))

	waitForRunCompletion(ctx, conn, runErr, log)
}

func buildDeps(initResult rpc.InitResult, cfg *config.Config, log *zap.Logger) *core.PluginCoreDeps {
	_ = cfg
	return &core.PluginCoreDeps{
		Logger:       log,
		PluginConfig: initResult.PluginConfig,
	}
}

func buildPluginCore(deps *core.PluginCoreDeps, mux *rpc.Mux, runtime clawruntime.ClawRuntime) *core.PluginCore {
	pluginCore := core.NewPluginCore(deps)
	pluginCore.RegisterHandlers(mux, runtime)
	return pluginCore
}

func waitForRunCompletion(ctx context.Context, conn *rpc.Conn, runErr chan error, log *zap.Logger) {
	select {
	case <-ctx.Done():
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if err := conn.Close(shutdownCtx); err != nil {
			log.Warn("shutdown timeout", zap.Error(err))
		}
	case err := <-runErr:
		if err != nil {
			log.Error("conn run", zap.Error(err))
		}
	}
}
