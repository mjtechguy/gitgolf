package server

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/hex"
	"os"
	"os/exec"
	"regexp"
	"strconv"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/stdlib"
)

// This is an actual Golf-schema dump/fresh-database restore on the owned host
// test server. It is not the separate native volumes/RustFS/full-stack drill.
func TestRecoveryHostDumpRestorePostgres(t *testing.T) {
	dumpTool, restoreTool := os.Getenv("GOLF_TEST_PG_DUMP"), os.Getenv("GOLF_TEST_PG_RESTORE")
	if dumpTool == "" || restoreTool == "" {
		t.Skip("supply matching owned host pg_dump/pg_restore binaries")
	}
	f, codes := recoveryMFAFixture(t)
	_, challenge := recoverySession(t, f, "alice", "")
	config, e := pgx.ParseConfig(os.Getenv("GOLF_TEST_DATABASE_URL"))
	if e != nil || config.Host != "127.0.0.1" || config.Port != 45472 || config.Database != "postgres" || config.User != "postgres" {
		t.Fatal("use exact owned loopback host PostgreSQL fixture")
	}
	var schema string
	if e = f.db.QueryRow(`SELECT current_schema()`).Scan(&schema); e != nil || !regexp.MustCompile(`^golf_test_[a-f0-9]{16}$`).MatchString(schema) {
		t.Fatal("source is not owned test schema")
	}
	name := "golf_recovery083_" + hex.EncodeToString([]byte(schema[len("golf_test_"):]))
	admin := stdlib.OpenDB(*config)
	if _, e = admin.Exec(`CREATE DATABASE ` + name + ` TEMPLATE template0`); e != nil {
		admin.Close()
		t.Fatal("fresh owned restore target unavailable")
	}
	var restored *sql.DB
	t.Cleanup(func() {
		if restored != nil {
			restored.Close()
		}
		if _, e := admin.Exec(`DROP DATABASE ` + name + ` WITH (FORCE)`); e != nil {
			t.Error("owned restore database cleanup failed")
		}
		admin.Close()
	})
	env := []string{"PATH=/usr/bin:/bin", "PGHOST=127.0.0.1", "PGPORT=45472", "PGUSER=postgres", "PGPASSWORD=" + config.Password, "PGSSLMODE=disable", "PGCONNECT_TIMEOUT=5"}
	ctx, cancel := context.WithTimeout(t.Context(), 45*time.Second)
	defer cancel()
	var dump bytes.Buffer
	command := exec.CommandContext(ctx, dumpTool, "--dbname=postgres", "--format=custom", "--no-owner", "--no-acl", "--schema="+schema)
	command.Env = env
	command.Stdout = &dump
	if command.Run() != nil || dump.Len() == 0 || dump.Len() > 64<<20 {
		t.Fatal("owned Golf schema dump failed")
	}
	// Consume a code in the source after its snapshot. The restored copy must
	// not automatically regain that one-time authority from the older backup.
	if mfaLoginRequest(f.s, "CompletePasswordMFA", map[string]string{"code": codes[0]}, challenge).Code != 200 {
		t.Fatal("source post-backup code consumption")
	}
	command = exec.CommandContext(ctx, restoreTool, "--dbname="+name, "--single-transaction", "--exit-on-error", "--no-owner", "--no-acl")
	command.Env = env
	command.Stdin = bytes.NewReader(dump.Bytes())
	if command.Run() != nil {
		t.Fatal("fresh owned Golf schema restore failed")
	}
	config.Database = name
	config.RuntimeParams["search_path"] = schema
	restored = stdlib.OpenDB(*config)
	var unused int
	if e = restored.QueryRow(`SELECT count(*) FROM golf_mfa_recovery_codes WHERE used_at IS NULL`).Scan(&unused); e != nil || unused != 10 {
		t.Fatal("snapshot did not restore original factor state")
	}
	var sourceUnused int
	if e = f.db.QueryRow(`SELECT count(*) FROM golf_mfa_recovery_codes WHERE used_at IS NULL`).Scan(&sourceUnused); e != nil || sourceUnused != 9 {
		t.Fatal("source mutation unexpectedly entered backup")
	}
	backup := "08308308308308308308308308308308"
	result, e := InvalidateRestoredSessions(t.Context(), restored, backup)
	if e != nil || result.Quarantine.MFAAccounts != 1 || result.Quarantine.MFARecoveryCodes != 10 || result.Quarantine.MFAChallenges != 1 {
		t.Fatal("fresh restore did not revoke copied factor authority", e)
	}
	var removed, disabled int
	if e = restored.QueryRow(`SELECT (SELECT count(*) FROM golf_mfa_recovery_codes),(SELECT count(*) FROM golf_local_accounts WHERE disabled_at IS NOT NULL)`).Scan(&removed, &disabled); e != nil || removed != 0 || disabled != 1 {
		t.Fatal("restored challenge/factor account was reopened")
	}
	var sourceEnabled bool
	if e = f.db.QueryRow(`SELECT enabled FROM golf_local_mfa`).Scan(&sourceEnabled); e != nil || !sourceEnabled {
		t.Fatal("restore quarantine touched original database")
	}
	var recorded string
	if e = restored.QueryRow(`SELECT quarantine_counts->>'mfa_recovery_codes' FROM golf_recovery_events WHERE operation_id=$1`, result.OperationID).Scan(&recorded); e != nil || recorded != strconv.Itoa(unused) {
		t.Fatal("restored audit did not bind exact revoked snapshot")
	}
	if _, e = restored.Exec(`DELETE FROM golf_recovery_events`); e == nil {
		t.Fatal("restored append-only history guard missing")
	}
}
