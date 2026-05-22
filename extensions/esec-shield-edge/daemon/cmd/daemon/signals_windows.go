//go:build windows

package main

import (
	"context"
	"os"
	"os/signal"
	"syscall"

	"go.uber.org/zap"
)

func handleSignals(ctx context.Context, cancel context.CancelFunc, log *zap.Logger) {
	sigChan := make(chan os.Signal, 1)
	signal.Notify(sigChan, syscall.SIGINT, syscall.SIGTERM)

	for {
		select {
		case sig := <-sigChan:
			log.Info("received signal, shutting down", zap.String("signal", sig.String()))
			cancel()
			return
		case <-ctx.Done():
			return
		}
	}
}
