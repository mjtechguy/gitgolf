package main

import (
	"bytes"
	"context"
	"encoding/json"
	"github.com/rs/zerolog"
	"io"
	"strings"
	"testing"
	"time"
)

func TestRecoveryCommandBounds(t *testing.T) {
	id := strings.Repeat("a", 32)
	options, err := parseRecoveryCommand([]string{"recovery", "invalidate-sessions", "--backup-id", id})
	if err != nil || options.backupID != id || options.timeout != time.Minute {
		t.Fatal("valid recovery command did not preserve its bounded arguments")
	}
	for _, args := range [][]string{
		{"recovery"}, {"recovery", "preserve-sessions"}, {"recovery", "invalidate-sessions"},
		{"recovery", "invalidate-sessions", "--backup-id", strings.Repeat("A", 32)},
		{"recovery", "invalidate-sessions", "--backup-id", id, "--timeout", "0s"},
		{"recovery", "invalidate-sessions", "--backup-id", id, "--timeout", "5m1s"},
		{"recovery", "invalidate-sessions", "--backup-id", id, "--preserve"},
		{"recovery", "invalidate-sessions", "--backup-id", id, "extra"},
		{"recovery", "invalidate-sessions", "--backup-id", id, "--database-url", "private-test-secret"},
	} {
		_, err := parseRecoveryCommand(args)
		if err == nil || err.Error() != recoveryUsage || strings.Contains(err.Error(), "private-test-secret") {
			t.Fatal("invalid recovery arguments were accepted or disclosed")
		}
	}
}

func TestRecoveryCommandRequiresOnlyDatabaseAndSanitizesFailure(t *testing.T) {
	operatorEnvironment(t)
	t.Setenv("GOLF_ENCRYPTION_KEY", "invalid-private-key-value")
	t.Setenv("GOLF_PUBLIC_URL", "invalid-http-configuration")
	logger := zerolog.New(io.Discard)
	id := strings.Repeat("d", 32)
	for _, dsn := range []string{"", "invalid:private-database-password"} {
		t.Setenv("DATABASE_URL", dsn)
		var output bytes.Buffer
		err := runCommand(context.Background(), []string{"recovery", "invalidate-sessions", "--backup-id", id}, &output, logger)
		if err == nil || strings.Contains(err.Error(), "key configuration") || strings.Contains(output.String()+err.Error(), "private-") || strings.Contains(output.String(), id) {
			t.Fatal("recovery required keys, echoed arguments, or exposed database credentials")
		}
		var response map[string]any
		if json.Unmarshal(output.Bytes(), &response) != nil || response["schema_version"] != "golf.recovery.v1" || response["state"] != "failed" || response["action"] != "invalidate-sessions" || response["result"] != nil {
			t.Fatal("failed recovery command emitted invalid success metadata")
		}
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	var output bytes.Buffer
	if err := runCommand(ctx, []string{"recovery", "invalidate-sessions", "--backup-id", id}, &output, logger); err == nil || !strings.Contains(output.String(), `"state":"interrupted"`) || strings.Contains(output.String(), id) {
		t.Fatal("canceled recovery did not return a private interrupted result")
	}
}
