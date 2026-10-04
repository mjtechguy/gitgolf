package main

import (
	"context"
	"errors"
	"github.com/mjtechguy/golf-git/internal/server"
	"github.com/mjtechguy/golf-git/internal/server/database"
	"os"
)

func runEmailWorker(ctx context.Context, args []string) error {
	if len(args) != 1 || os.Getenv("DATABASE_URL") == "" {
		return errors.New("email-worker requires operator configuration")
	}
	db, e := database.Open(ctx, os.Getenv("DATABASE_URL"))
	if e != nil {
		return errors.New("Email worker database is unavailable")
	}
	defer db.Close()
	config := serverConfig()
	config.WebDir = ""
	app, e := server.New(config, db)
	if e != nil {
		return e
	}
	defer app.CloseCodexAccounts()
	return app.RunEmailWorker(ctx)
}
