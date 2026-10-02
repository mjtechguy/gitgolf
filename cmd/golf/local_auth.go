package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"flag"
	"io"
	"os"
	"time"
	"unicode/utf8"

	"github.com/mjtechguy/golf-git/internal/server"
	"github.com/mjtechguy/golf-git/internal/server/database"
)

const localAccountUsage = "usage: golf local-account create|reset-password|disable|enable|set-email [--timeout 60s]. Supply one bounded JSON object on stdin; never put passwords or forge tokens in arguments."

type localAccountOptions struct {
	action  string
	timeout time.Duration
}

func parseLocalAccountCommand(args []string) (localAccountOptions, error) {
	options := localAccountOptions{timeout: 60 * time.Second}
	invalid := errors.New(localAccountUsage)
	if len(args) < 2 || args[0] != "local-account" {
		return options, invalid
	}
	options.action = args[1]
	switch options.action {
	case "create", "reset-password", "disable", "enable", "set-email":
	default:
		return options, invalid
	}
	flags := flag.NewFlagSet("local-account", flag.ContinueOnError)
	flags.SetOutput(io.Discard)
	flags.DurationVar(&options.timeout, "timeout", options.timeout, "operation deadline")
	if flags.Parse(args[2:]) != nil || flags.NArg() != 0 || options.timeout < time.Second || options.timeout > 5*time.Minute {
		return options, invalid
	}
	return options, nil
}

func readLocalAccountInput(reader io.Reader, action string) (server.LocalAccountInput, error) {
	fail := errors.New("local-account requires one valid JSON object with exactly the action's documented fields")
	var input server.LocalAccountInput
	data, err := io.ReadAll(io.LimitReader(reader, (8<<10)+1))
	if err != nil || len(data) > 8<<10 || !utf8.Valid(data) {
		return input, fail
	}
	decoder := json.NewDecoder(bytes.NewReader(data))
	token, err := decoder.Token()
	if err != nil || token != json.Delim('{') {
		return input, fail
	}
	fields := map[string]json.RawMessage{}
	for decoder.More() {
		token, err := decoder.Token()
		key, ok := token.(string)
		if err != nil || !ok || fields[key] != nil {
			return input, fail
		}
		switch key {
		case "username", "email", "password", "forge_token", "is_instance_admin":
		default:
			return input, fail
		}
		var value json.RawMessage
		if decoder.Decode(&value) != nil || bytes.Equal(value, []byte("null")) {
			return input, fail
		}
		fields[key] = value
	}
	if end, err := decoder.Token(); err != nil || end != json.Delim('}') {
		return input, fail
	}
	if _, err := decoder.Token(); err != io.EOF {
		return input, fail
	}
	expected := []string{"username"}
	switch action {
	case "create":
		expected = append(expected, "password", "forge_token", "is_instance_admin")
		if fields["email"] != nil {
			expected = append(expected, "email")
		}
	case "set-email":
		expected = append(expected, "email")
	case "reset-password":
		expected = append(expected, "password")
	case "enable":
		expected = append(expected, "password", "forge_token")
	case "disable":
	default:
		return input, fail
	}
	if len(fields) != len(expected) {
		return input, fail
	}
	for _, key := range expected {
		if fields[key] == nil {
			return input, fail
		}
	}
	if json.Unmarshal(data, &input) != nil {
		return input, fail
	}
	return input, nil
}

func boundedLocalInput(ctx context.Context, reader io.Reader) ([]byte, error) {
	type result struct {
		data []byte
		err  error
	}
	finished := make(chan result, 1)
	go func() { data, err := io.ReadAll(io.LimitReader(reader, (8<<10)+1)); finished <- result{data, err} }()
	select {
	case value := <-finished:
		if value.err != nil || len(value.data) > 8<<10 {
			return nil, errors.New("local-account stdin is unavailable or exceeds its size limit")
		}
		return value.data, nil
	case <-ctx.Done():
		if closer, ok := reader.(io.Closer); ok {
			_ = closer.Close()
		}
		return nil, ctx.Err()
	}
}

func runLocalAccount(parent context.Context, options localAccountOptions, input io.Reader, output io.Writer) (resultErr error) {
	ctx, cancel := context.WithTimeout(parent, options.timeout)
	defer cancel()
	response := struct {
		SchemaVersion string `json:"schema_version"`
		Action        string `json:"action"`
		State         string `json:"state"`
		Result        any    `json:"result,omitempty"`
		Error         string `json:"error,omitempty"`
	}{SchemaVersion: "golf.local-account.v1", Action: options.action, State: "failed"}
	defer func() {
		if resultErr != nil {
			if ctx.Err() != nil {
				resultErr = errors.New("local-account operation interrupted; inspect the account before retrying")
			}
			response.Error = resultErr.Error()
		}
		if err := json.NewEncoder(output).Encode(response); err != nil {
			resultErr = errors.New("cannot write local-account result; inspect the account before retrying")
		}
	}()
	data, err := boundedLocalInput(ctx, input)
	if err != nil {
		return err
	}
	account, err := readLocalAccountInput(bytes.NewReader(data), options.action)
	if err != nil {
		return err
	}
	keys, err := server.ParseKeyring(os.Getenv("GOLF_ENCRYPTION_KEY"), os.Getenv("GOLF_ENCRYPTION_KEYS"), os.Getenv("GOLF_ACTIVE_ENCRYPTION_KEY"))
	if err != nil {
		return errors.New("encryption key configuration is invalid")
	}
	if os.Getenv("DATABASE_URL") == "" {
		return errors.New("DATABASE_URL is required")
	}
	db, err := database.Open(ctx, os.Getenv("DATABASE_URL"))
	if err != nil {
		return errors.New("database connection or migration failed")
	}
	defer db.Close()
	result, err := server.ManageLocalAccount(ctx, db, keys, env("GITEA_URL", "http://gitea:3000"), options.action, account)
	// Credentials never appear in operator output, argv or logs.
	account.Password, account.ForgeToken = "", ""
	if err != nil {
		return err
	}
	response.Result, response.State = result, "complete"
	return nil
}
