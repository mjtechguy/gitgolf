package main

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net"
	"os"
	"os/exec"
	"strings"
	"syscall"
	"testing"
	"time"
)

func TestParseKeyCommand(t *testing.T) {
	for _, test := range []struct {
		name string
		args []string
		want keyOptions
	}{
		{"status", []string{"keys", "status"}, keyOptions{action: "status", batchSize: 100, maxBatches: 10, timeout: time.Minute}},
		{"activate", []string{"keys", "activate", "--timeout", "5m"}, keyOptions{action: "activate", batchSize: 100, maxBatches: 10, timeout: 5 * time.Minute}},
		{"rotate bounds", []string{"keys", "rotate", "--batch-size", "1000", "--max-batches", "100", "--timeout", "1s"}, keyOptions{action: "rotate", batchSize: 1000, maxBatches: 100, timeout: time.Second}},
		{"retirement", []string{"keys", "retirement-check", "--key-id", "key.2026-10_02"}, keyOptions{action: "retirement-check", keyID: "key.2026-10_02", batchSize: 100, maxBatches: 10, timeout: time.Minute}},
	} {
		t.Run(test.name, func(t *testing.T) {
			got, err := parseKeyCommand(test.args)
			if err != nil || got != test.want {
				t.Fatalf("unexpected options: got %#v, error %v", got, err)
			}
		})
	}
}

func TestKeyArgumentsRejectSecretsAndInvalidBounds(t *testing.T) {
	const secret = "not-a-real-private-secret"
	for _, args := range [][]string{
		{}, {"unexpected", secret}, {"keys"}, {"keys", secret}, {"keys", "status", secret},
		{"keys", "status", "--dsn", secret}, {"keys", "activate", "--key", secret},
		{"keys", "status", "--batch-size", "1"}, {"keys", "rotate", "--key-id", "new"},
		{"keys", "rotate", "--batch-size", "0"}, {"keys", "rotate", "--batch-size", "1001"},
		{"keys", "rotate", "--max-batches", "0"}, {"keys", "rotate", "--max-batches", "101"},
		{"keys", "rotate", "--batch-size", secret}, {"keys", "status", "--timeout", secret},
		{"keys", "status", "--timeout", "0s"}, {"keys", "status", "--timeout", "999ms"},
		{"keys", "status", "--timeout", "5m1s"}, {"keys", "retirement-check"},
		{"keys", "retirement-check", "--key-id", "../" + secret}, {"keys", "retirement-check", "--key-id", strings.Repeat("k", 65)},
		{"keys", "status", "--", secret},
	} {
		_, err := parseKeyCommand(args)
		if err == nil || err.Error() != keyUsage || strings.Contains(err.Error(), secret) {
			t.Fatal("invalid command did not return only the fixed usage message")
		}
	}
}

func operatorEnvironment(t *testing.T) {
	t.Helper()
	for _, name := range []string{"DATABASE_URL", "GOLF_ENCRYPTION_KEY", "GOLF_ENCRYPTION_KEYS", "GOLF_ACTIVE_ENCRYPTION_KEY"} {
		t.Setenv(name, "")
	}
}

func TestKeyCommandValidatesBeforeDatabaseAndHidesConfiguration(t *testing.T) {
	operatorEnvironment(t)
	const secret = "test-only-database-and-key-secret"
	t.Setenv("DATABASE_URL", "invalid:"+secret)
	t.Setenv("GOLF_ENCRYPTION_KEY", secret)
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	var output bytes.Buffer
	err := runCommand(context.Background(), []string{"keys", "status", "--password", secret}, &output, logger)
	if err == nil || err.Error() != keyUsage || output.Len() != 0 {
		t.Fatal("unknown arguments must stop before crypto and database validation")
	}
	err = runCommand(context.Background(), []string{"keys", "status"}, &output, logger)
	if err == nil || !strings.Contains(err.Error(), "encryption key configuration is invalid") {
		t.Fatal("invalid key configuration must stop before database opening")
	}
	if strings.Contains(output.String(), secret) || strings.Contains(err.Error(), secret) {
		t.Fatal("secret appeared in a configuration diagnostic")
	}
	var response keyCommandResult
	if json.Unmarshal(output.Bytes(), &response) != nil || response.SchemaVersion != "golf.keys.v1" || response.State != "failed" || response.Action != "status" || response.Result != nil {
		t.Fatal("configuration error output is not a bounded failed metadata result")
	}
	output.Reset()
	t.Setenv("GOLF_ENCRYPTION_KEY", base64.StdEncoding.EncodeToString(make([]byte, 32)))
	t.Setenv("GOLF_PUBLIC_URL", "invalid-http-configuration")
	err = runCommand(context.Background(), []string{"keys", "status"}, &output, logger)
	if err == nil || !strings.Contains(err.Error(), "database connection or migration failed") || strings.Contains(output.String(), secret) || strings.Contains(err.Error(), secret) {
		t.Fatal("operator must ignore HTTP configuration and sanitize database failures")
	}
	output.Reset()
	unknownID := strings.Repeat("a", 40)
	err = runCommand(context.Background(), []string{"keys", "retirement-check", "--key-id", unknownID}, &output, logger)
	if err == nil || strings.Contains(output.String(), unknownID) || strings.Contains(err.Error(), unknownID) || strings.Contains(output.String(), `"key_id"`) {
		t.Fatal("unsuccessful retirement checks must not echo supplied key labels")
	}
}

func TestServerConfigLoadsKeyringOnlyFromEnvironment(t *testing.T) {
	operatorEnvironment(t)
	t.Setenv("GOLF_ENCRYPTION_KEY", "legacy-test-value")
	t.Setenv("GOLF_ENCRYPTION_KEYS", `{"current":"test-value"}`)
	t.Setenv("GOLF_ACTIVE_ENCRYPTION_KEY", "current")
	config := serverConfig()
	if config.EncryptionKey != "legacy-test-value" || config.EncryptionKeysJSON != `{"current":"test-value"}` || config.EncryptionActiveKeyID != "current" {
		t.Fatal("server key configuration did not preserve composition values")
	}
}

// Execute the actual process signal setup and operator path without requiring a
// PostgreSQL fixture. A stalled TCP peer qualifies connection cancellation only;
// transactional rotation and committed partial progress use real backend DB tests.
func TestKeyCommandInterruption(t *testing.T) {
	for _, mode := range []string{"sigterm", "deadline"} {
		t.Run(mode, func(t *testing.T) {
			listener, err := net.Listen("tcp", "127.0.0.1:0")
			if err != nil {
				t.Fatal(err)
			}
			defer listener.Close()
			accepted := make(chan net.Conn, 1)
			acceptDone := make(chan struct{})
			go func() {
				defer close(acceptDone)
				if connection, err := listener.Accept(); err == nil {
					accepted <- connection
				}
			}()
			defer func() {
				_ = listener.Close()
				<-acceptDone
				select {
				case connection := <-accepted:
					_ = connection.Close()
				default:
				}
			}()
			const secret = "test-only-database-password"
			var stdout, stderr bytes.Buffer
			command := exec.Command(os.Args[0], "-test.run=^TestKeyCommandHelperProcess$")
			command.Env = append(os.Environ(), "GOLF_KEY_COMMAND_HELPER=1", "GOLF_KEY_COMMAND_TIMEOUT=30s", "GOLF_ENCRYPTION_KEYS=", "GOLF_ACTIVE_ENCRYPTION_KEY=", "GOLF_ENCRYPTION_KEY="+base64.StdEncoding.EncodeToString(make([]byte, 32)), "DATABASE_URL=postgres://operator:"+secret+"@"+listener.Addr().String()+"/golf?sslmode=disable")
			if mode == "deadline" {
				command.Env = append(command.Env, "GOLF_KEY_COMMAND_TIMEOUT=1s")
			}
			command.Stdout, command.Stderr = &stdout, &stderr
			stdin, err := command.StdinPipe()
			if err != nil {
				t.Fatal(err)
			}
			defer stdin.Close() // Leave it open: the command must never wait for credentials on stdin.
			if err := command.Start(); err != nil {
				t.Fatal(err)
			}
			done := make(chan error, 1)
			go func() { done <- command.Wait() }()
			waited := false
			defer func() {
				if !waited {
					_ = command.Process.Kill()
					<-done
				}
			}()
			select {
			case connection := <-accepted:
				defer connection.Close()
			case <-time.After(5 * time.Second):
				t.Fatal("operator did not start the bounded database connection")
			}
			if mode == "sigterm" {
				if err := command.Process.Signal(syscall.SIGTERM); err != nil {
					t.Fatal(err)
				}
			}
			select {
			case err := <-done:
				waited = true
				var exit *exec.ExitError
				if !errors.As(err, &exit) || exit.ExitCode() != 1 {
					t.Fatal("interrupted operator must return exit status one")
				}
			case <-time.After(5 * time.Second):
				t.Fatal("operator did not honor cancellation while stdin remained open")
			}
			var response keyCommandResult
			if json.Unmarshal(stdout.Bytes(), &response) != nil || response.State != "interrupted" || response.SchemaVersion != "golf.keys.v1" || response.Error == "" || response.Result != nil {
				t.Fatal("interrupted connection reported unexpected operation progress")
			}
			for _, content := range []string{stdout.String(), stderr.String()} {
				if strings.Contains(content, secret) || strings.Contains(content, "postgres://") || strings.Contains(content, base64.StdEncoding.EncodeToString(make([]byte, 32))) {
					t.Fatal("operator emitted configuration credentials")
				}
			}
		})
	}
}

func TestKeyCommandHelperProcess(t *testing.T) {
	if os.Getenv("GOLF_KEY_COMMAND_HELPER") != "1" {
		return
	}
	os.Args = []string{"golf", "keys", "status", "--timeout", os.Getenv("GOLF_KEY_COMMAND_TIMEOUT")}
	main()
}
