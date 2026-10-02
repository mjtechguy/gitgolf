package main

import (
	"context"
	"errors"
	"io"
	"log"
	"net"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/mjtechguy/golf-git/internal/server"
	"github.com/mjtechguy/golf-git/internal/server/database"
	"github.com/mjtechguy/golf-git/internal/telemetry"
	"github.com/rs/zerolog"
)

func env(name, fallback string) string {
	if value := os.Getenv(name); value != "" {
		return value
	}
	return fallback
}

func run() error {
	logger := zerolog.New(os.Stderr).With().Timestamp().Logger()
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	return runCommand(ctx, os.Args[1:], os.Stdout, logger)
}

func runCommand(ctx context.Context, args []string, output io.Writer, logger zerolog.Logger) error {
	if len(args) > 0 {
		if args[0] == "local-account" {
			options, err := parseLocalAccountCommand(args)
			if err != nil {
				return err
			}
			return runLocalAccount(ctx, options, os.Stdin, output)
		}
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

func serve(ctx context.Context, logger zerolog.Logger) error {
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
	observability, metricsAddress, metricsToken, err := observabilityConfig(logger)
	if err != nil {
		return err
	}
	runtime, err := telemetry.New(ctx, observability)
	if err != nil {
		return err
	}
	defer func() {
		shutdown, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if runtime.Shutdown(shutdown) != nil {
			logger.Error().Msg("telemetry shutdown failed")
		}
	}()
	config.Telemetry = runtime
	startup, cancel := context.WithTimeout(ctx, 60*time.Second)
	db, err := database.OpenWithTracer(startup, os.Getenv("DATABASE_URL"), runtime)
	cancel()
	if err != nil {
		return errors.New("database connection or migration failed; verify database availability and schema permissions")
	}
	defer db.Close()
	app, err := server.New(config, db)
	if err != nil {
		return err
	}
	httpServer := newHTTPServer(env("GOLF_LISTEN_ADDR", ":8080"), app, logger)
	// Bind every enabled listener before starting any of them. An occupied
	// metrics port cannot leave an otherwise running application behind.
	public, err := net.Listen("tcp", httpServer.Addr)
	if err != nil {
		return errors.New("application listener unavailable")
	}
	defer public.Close()
	servers := []*http.Server{httpServer}
	listeners := []net.Listener{public}
	if metricsAddress != "" {
		private, err := net.Listen("tcp", metricsAddress)
		if err != nil {
			return errors.New("metrics listener unavailable")
		}
		defer private.Close()
		servers = append(servers, newHTTPServer(metricsAddress, privateMetrics(runtime.MetricsHandler(), metricsToken), logger))
		listeners = append(listeners, private)
	}
	finished := make(chan error, len(servers))
	for i, srv := range servers {
		go func() { finished <- srv.Serve(listeners[i]) }()
	}
	logger.Info().Bool("metrics_enabled", metricsAddress != "").Msg("Golf listening")
	var serveError error
	select {
	case err := <-finished:
		if !errors.Is(err, http.ErrServerClosed) {
			serveError = errors.New("HTTP listener failed")
		}
	case <-ctx.Done():
	}
	shutdown, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	for _, srv := range servers {
		if err := srv.Shutdown(shutdown); err != nil {
			_ = srv.Close()
			serveError = errors.New("HTTP shutdown failed")
		}
	}
	return serveError
}

func newHTTPServer(address string, handler http.Handler, logger zerolog.Logger) *http.Server {
	return &http.Server{Addr: address, Handler: handler, ReadHeaderTimeout: 5 * time.Second, ReadTimeout: 20 * time.Second, WriteTimeout: 30 * time.Second, IdleTimeout: 60 * time.Second, MaxHeaderBytes: 32 << 10, ErrorLog: log.New(safeHTTPLog{logger}, "", 0)}
}

// net/http's default panic and TLS diagnostics can contain caller-supplied
// values. Keep its exceptional diagnostics bounded too.
type safeHTTPLog struct{ logger zerolog.Logger }

func (w safeHTTPLog) Write(p []byte) (int, error) {
	w.logger.Error().Msg("HTTP transport error")
	return len(p), nil
}

func main() {
	if err := run(); err != nil {
		logger := zerolog.New(os.Stderr).With().Timestamp().Logger()
		logger.Error().Str("error", err.Error()).Msg("Golf stopped")
		os.Exit(1)
	}
}
