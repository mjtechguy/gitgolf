package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"io"
	"os"
	"time"

	"github.com/mjtechguy/golf-git/internal/server"
	"github.com/mjtechguy/golf-git/internal/server/database"
)

const recoveryUsage = "usage: golf recovery invalidate-sessions --backup-id ID [--timeout 60s]. ID must be 32 lowercase hexadecimal characters. Stop and drain all writers first. Supply DATABASE_URL through the environment."

type recoveryOptions struct {
	backupID string
	timeout  time.Duration
}

func parseRecoveryCommand(args []string) (recoveryOptions, error) {
	options := recoveryOptions{timeout: time.Minute}
	invalid := errors.New(recoveryUsage)
	if len(args) < 2 || args[0] != "recovery" || args[1] != "invalidate-sessions" {
		return options, invalid
	}
	flags := flag.NewFlagSet("recovery", flag.ContinueOnError)
	flags.SetOutput(io.Discard) // Never echo supplied argument values.
	flags.StringVar(&options.backupID, "backup-id", "", "backup identifier")
	flags.DurationVar(&options.timeout, "timeout", options.timeout, "overall deadline")
	if flags.Parse(args[2:]) != nil || flags.NArg() != 0 || !server.ValidRecoveryBackupID(options.backupID) || options.timeout < time.Second || options.timeout > 5*time.Minute {
		return options, invalid
	}
	return options, nil
}

func runRecovery(parent context.Context, options recoveryOptions, output io.Writer) (resultErr error) {
	ctx, cancel := context.WithTimeout(parent, options.timeout)
	defer cancel()
	response := struct {
		SchemaVersion string                 `json:"schema_version"`
		Action        string                 `json:"action"`
		State         string                 `json:"state"`
		Result        *server.RecoveryResult `json:"result,omitempty"`
		Error         string                 `json:"error,omitempty"`
	}{SchemaVersion: "golf.recovery.v1", Action: "invalidate-sessions", State: "failed"}
	defer func() {
		if resultErr != nil {
			if ctx.Err() != nil {
				response.State = "interrupted"
				resultErr = errors.New("recovery invalidation interrupted; keep traffic quarantined and verify recovery history before retrying")
			}
			response.Error = resultErr.Error()
		}
		if err := json.NewEncoder(output).Encode(response); err != nil {
			resultErr = errors.New("cannot write recovery result; keep traffic quarantined and verify recovery history before retrying")
		}
	}()
	if os.Getenv("DATABASE_URL") == "" {
		return errors.New("DATABASE_URL is required")
	}
	db, err := database.Open(ctx, os.Getenv("DATABASE_URL"))
	if err != nil {
		return errors.New("database connection or migration failed; verify database availability and schema permissions")
	}
	defer db.Close()
	result, err := server.InvalidateRestoredSessions(ctx, db, options.backupID)
	if err != nil {
		return errors.New("recovery invalidation failed; keep traffic quarantined and verify database availability and recovery history before retrying")
	}
	response.Result, response.State = &result, "complete"
	return nil
}
