//go:build !windows

package main

import (
	"context"
	"os"
	"os/signal"
	"syscall"

	"go.uber.org/zap"

	debugsrv "esec-shield-daemon-edge/pkg/debug"
)

func handleSignals(ctx context.Context, cancel context.CancelFunc, log *zap.Logger) {
	sigChan := make(chan os.Signal, 1)
	signal.Notify(sigChan, syscall.SIGINT, syscall.SIGTERM, syscall.SIGUSR1)

	var debugServer *debugsrv.Server

	for {
		select {
		case sig := <-sigChan:
			switch sig {
			case syscall.SIGUSR1:
				if debugServer == nil {
					debugServer = debugsrv.NewServer(log)
				}
				debugServer.Reload("./debug.sock")
				log.Info("received SIGUSR1, toggled debug server")
			default:
				if debugServer != nil {
					debugServer.Shutdown()
				}
				log.Info("received signal, shutting down", zap.String("signal", sig.String()))
				cancel()
				return
			}
		case <-ctx.Done():
			if debugServer != nil {
				debugServer.Shutdown()
			}
			return
		}
	}
}
