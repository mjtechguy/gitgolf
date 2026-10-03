package main

import (
	"context"
	"errors"
	"os"

	"github.com/mjtechguy/golf-git/internal/server"
	"github.com/mjtechguy/golf-git/internal/server/database"
)

func runAgentWorker(ctx context.Context, args []string) error {
	if len(args) != 1 || os.Getenv("DATABASE_URL") == "" {
		return errors.New("agent-worker requires operator configuration")
	}
	config := serverConfig()
	config.WebDir = ""
	db, e := database.Open(ctx, os.Getenv("DATABASE_URL"))
	if e != nil {
		return errors.New("Agent worker database is unavailable")
	}
	defer db.Close()
	app, e := server.New(config, db)
	if e != nil {
		return e
	}
	defer app.CloseCodexAccounts()
	return app.RunAgentWorker(ctx, env("GOLF_AGENT_WORKER_ID", "local-agents"), env("GOLF_AGENT_SECCOMP", "/app/seccomp.json"))
}
