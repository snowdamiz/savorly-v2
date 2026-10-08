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
	_ = godotenv.Load("../../.env", ".env")
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	config := app.LoadConfig()
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
	go app.RunWorker(ctx, db, config)
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
}
