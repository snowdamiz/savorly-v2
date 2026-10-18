package main

import (
	"context"
	"log/slog"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/joho/godotenv"
	"savorly/api/internal/app"
	"savorly/api/internal/database"
)

func main() {
	// `server -healthcheck` probes a running server and exits (healthcheck.go, Dockerfile).
	if len(os.Args) > 1 && (os.Args[1] == "-healthcheck" || os.Args[1] == "--healthcheck") {
		os.Exit(healthcheck())
	}
	_ = godotenv.Load("../../.env", ".env")
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	config := app.LoadConfig()
	app.SetupLogging(config)
	url := os.Getenv("DATABASE_URL")
	if url == "" {
		slog.Error("DATABASE_URL is required")
		os.Exit(1)
	}
	db, e := database.Open(ctx, url)
	if e != nil {
		slog.Error("database connection failed", "error", e)
		os.Exit(1)
	}
	defer db.Close()
	if os.Getenv("SEED_DATA") == "true" {
		if e = database.Seed(ctx, db); e != nil {
			slog.Error("seed failed", "error", e)
			os.Exit(1)
		}
	}
	server := app.NewWithContext(ctx, db, config)
	worker := make(chan struct{})
	go func() {
		defer close(worker)
		app.RunWorker(ctx, db, config)
	}()
	go app.RunJanitor(ctx, db)
	go app.RunFoodIndex(ctx, db)
	go app.RunEquipmentIndex(ctx, db)
	go app.RunNotifications(ctx, db)
	go app.RunCreatorFund(ctx, db)
	go app.RunCookInsights(ctx, db)
	go func() {
		<-ctx.Done()
		if e := server.ShutdownWithTimeout(10 * time.Second); e != nil {
			slog.Error("shutdown failed", "error", e)
		}
	}()
	slog.Info("Savorly API listening", "port", app.Env("PORT", "8080"))
	if e = server.Listen(":" + app.Env("PORT", "8080")); e != nil {
		slog.Error("server stopped", "error", e)
	}
	// In-flight sous-chef turns and AI jobs settle before the pool closes, within the time a
	// container gets to stop, so a slow provider call can't hold shutdown open.
	stop()
	select {
	case <-worker:
	case <-time.After(20 * time.Second):
		slog.Warn("background work was still settling at shutdown")
	}
}
