package main

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/mjtechguy/golf-git/internal/server"
	"github.com/mjtechguy/golf-git/internal/server/database"
)

func env(name, fallback string) string {
	if value := os.Getenv(name); value != "" {
		return value
	}
	return fallback
}

func run() error {
	logger := slog.New(slog.NewJSONHandler(os.Stderr, nil))
	slog.SetDefault(logger)
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	return runCommand(ctx, os.Args[1:], os.Stdout, logger)
}

func runCommand(ctx context.Context, args []string, output io.Writer, logger *slog.Logger) error {
	if len(args) > 0 {
		if args[0] == "recovery" {
			options, err := parseRecoveryCommand(args)
			if err != nil {
				return err
			}
			return runRecovery(ctx, options, output)
		}
		options, err := parseKeyCommand(args)
		if err != nil {
			return err
		}
		return runKeys(ctx, options, output)
	}
	return serve(ctx, logger)
}

func serverConfig() server.Config {
	return server.Config{
		PublicURL: env("GOLF_PUBLIC_URL", "http://localhost:8080"), GiteaURL: env("GITEA_URL", "http://gitea:3000"),
		GiteaPublicURL: os.Getenv("GITEA_PUBLIC_URL"), GiteaOAuthClientID: os.Getenv("GITEA_OAUTH_CLIENT_ID"),
		GiteaOAuthClientSecret: os.Getenv("GITEA_OAUTH_CLIENT_SECRET"),
		EncryptionKey:          os.Getenv("GOLF_ENCRYPTION_KEY"), EncryptionKeysJSON: os.Getenv("GOLF_ENCRYPTION_KEYS"),
		EncryptionActiveKeyID: os.Getenv("GOLF_ACTIVE_ENCRYPTION_KEY"),
		AllowInsecureCookies:  os.Getenv("GOLF_ALLOW_INSECURE_COOKIES") == "true", WebDir: env("GOLF_WEB_DIR", "web/dist"),
	}
}

func serve(ctx context.Context, logger *slog.Logger) error {
	if os.Getenv("DATABASE_URL") == "" {
		return errors.New("DATABASE_URL is required")
	}
	config := serverConfig()
	// Validate configuration before opening a database; errors contain no secret values.
	validationConfig := config
	validationConfig.WebDir = ""
	if _, err := server.New(validationConfig, nil); err != nil {
		return err
	}
	startup, cancel := context.WithTimeout(ctx, 60*time.Second)
	db, err := database.Open(startup, os.Getenv("DATABASE_URL"))
	cancel()
	if err != nil {
		return errors.New("database connection or migration failed; verify database availability and schema permissions")
	}
	defer db.Close()
	app, err := server.New(config, db)
	if err != nil {
		return err
	}
	httpServer := &http.Server{Addr: env("GOLF_LISTEN_ADDR", ":8080"), Handler: app, ReadHeaderTimeout: 5 * time.Second, ReadTimeout: 20 * time.Second, WriteTimeout: 30 * time.Second, IdleTimeout: 60 * time.Second, MaxHeaderBytes: 32 << 10}
	finished := make(chan error, 1)
	go func() { finished <- httpServer.ListenAndServe() }()
	logger.Info("Golf listening", "address", httpServer.Addr)
	select {
	case err := <-finished:
		if !errors.Is(err, http.ErrServerClosed) {
			return err
		}
	case <-ctx.Done():
		shutdown, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		return httpServer.Shutdown(shutdown)
	}
	return nil
}

func main() {
	if err := run(); err != nil {
		slog.Error("Golf stopped", "error", err.Error())
		os.Exit(1)
	}
}
