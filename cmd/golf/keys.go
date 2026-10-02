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

const keyUsage = "usage: golf keys status|activate [--timeout 60s]; golf keys rotate [--batch-size 100] [--max-batches 10] [--timeout 60s]; golf keys retirement-check --key-id ID [--timeout 60s]. Supply database and encryption credentials through the environment only."

type keyOptions struct {
	action                string
	keyID                 string
	batchSize, maxBatches int
	timeout               time.Duration
}

func parseKeyCommand(args []string) (keyOptions, error) {
	options := keyOptions{batchSize: 100, maxBatches: 10, timeout: 60 * time.Second}
	invalid := errors.New(keyUsage)
	if len(args) < 2 || args[0] != "keys" {
		return options, invalid
	}
	options.action = args[1]
	flags := flag.NewFlagSet("keys", flag.ContinueOnError)
	// Flag's default diagnostics echo supplied values, which may contain secrets.
	flags.SetOutput(io.Discard)
	flags.DurationVar(&options.timeout, "timeout", options.timeout, "overall operation deadline")
	switch options.action {
	case "status", "activate":
	case "rotate":
		flags.IntVar(&options.batchSize, "batch-size", options.batchSize, "maximum credentials per transaction")
		flags.IntVar(&options.maxBatches, "max-batches", options.maxBatches, "maximum transactions this invocation")
	case "retirement-check":
		flags.StringVar(&options.keyID, "key-id", "", "configured key label to check")
	default:
		return options, invalid
	}
	if flags.Parse(args[2:]) != nil || flags.NArg() != 0 || options.timeout < time.Second || options.timeout > 5*time.Minute || options.batchSize < 1 || options.batchSize > 1000 || options.maxBatches < 1 || options.maxBatches > 100 || options.action == "retirement-check" && !server.ValidKeyID(options.keyID) {
		return options, invalid
	}
	return options, nil
}

type keyCommandResult struct {
	SchemaVersion string `json:"schema_version"`
	Action        string `json:"action"`
	State         string `json:"state"`
	KeyID         string `json:"key_id,omitempty"`
	Result        any    `json:"result,omitempty"`
	Error         string `json:"error,omitempty"`
}

func runKeys(parent context.Context, options keyOptions, output io.Writer) (resultErr error) {
	ctx, cancel := context.WithTimeout(parent, options.timeout)
	defer cancel()
	response := keyCommandResult{SchemaVersion: "golf.keys.v1", Action: options.action, State: "failed"}
	defer func() {
		if resultErr != nil {
			if ctx.Err() != nil {
				response.State = "interrupted"
				resultErr = errors.New("key operation interrupted; committed batches remain durable; inspect status before retrying")
			}
			response.Error = resultErr.Error()
		}
		if err := json.NewEncoder(output).Encode(response); err != nil {
			resultErr = errors.New("cannot write key operation result; inspect status before retrying")
		}
	}()
	keys, err := server.ParseKeyring(os.Getenv("GOLF_ENCRYPTION_KEY"), os.Getenv("GOLF_ENCRYPTION_KEYS"), os.Getenv("GOLF_ACTIVE_ENCRYPTION_KEY"))
	if err != nil {
		return errors.New("encryption key configuration is invalid; verify the keyring and active key label")
	}
	if os.Getenv("DATABASE_URL") == "" {
		return errors.New("DATABASE_URL is required")
	}
	db, err := database.Open(ctx, os.Getenv("DATABASE_URL"))
	if err != nil {
		return errors.New("database connection or migration failed; verify database availability and schema permissions")
	}
	defer db.Close()
	if options.action == "status" {
		status, err := server.KeyStatus(ctx, db, keys)
		if err != nil {
			return errors.New("key status unavailable; verify database policy and availability")
		}
		response.Result, response.State = status, "complete"
		return nil
	}
	var operation server.CredentialKeyOperation
	switch options.action {
	case "activate":
		operation, err = server.ActivateKey(ctx, db, keys)
	case "rotate":
		operation, err = server.RotateCredentials(ctx, db, keys, options.batchSize, options.maxBatches)
	case "retirement-check":
		operation, err = server.CheckKeyRetirement(ctx, db, keys, options.keyID)
	}
	response.Result = operation
	if err != nil {
		operation.Complete = false
		response.Result = operation
		return errors.New("key operation failed; verify configured key IDs, database policy and stored credentials; inspect status before retrying")
	}
	response.State = "partial"
	if operation.Complete {
		response.State = "complete"
		if options.action == "retirement-check" {
			response.State = "eligible"
			response.KeyID = options.keyID
		}
	}
	return nil
}
