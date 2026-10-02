package database_test

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"database/sql"
	"errors"
	"fmt"
	"os"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/stdlib"
	"github.com/mjtechguy/golf-git/internal/server/database"
	"github.com/pressly/goose/v3"
	"github.com/pressly/goose/v3/lock"
)

// Each test owns only a random schema in the explicitly supplied test database.
// No existing schemas, tables, rows or credentials are changed.
func isolatedDatabase(t *testing.T) (context.Context, string) {
	t.Helper()
	dsn := os.Getenv("GOLF_TEST_DATABASE_URL")
	if dsn == "" {
		t.Skip("set GOLF_TEST_DATABASE_URL for real PostgreSQL integration")
	}
	config, err := pgx.ParseConfig(dsn)
	if err != nil {
		t.Fatal("invalid GOLF_TEST_DATABASE_URL")
	}
	ctx, cancel := context.WithTimeout(t.Context(), 30*time.Second)
	t.Cleanup(cancel)
	admin := stdlib.OpenDB(*config)
	t.Cleanup(func() { admin.Close() })
	random := make([]byte, 8)
	if _, err := rand.Read(random); err != nil {
		t.Fatal(err)
	}
	schema := pgx.Identifier{fmt.Sprintf("golf_db_test_%x", random)}.Sanitize()
	if _, err := admin.ExecContext(ctx, "CREATE SCHEMA "+schema); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		cleanup, done := context.WithTimeout(context.Background(), 10*time.Second)
		defer done()
		if _, err := admin.ExecContext(cleanup, "DROP SCHEMA "+schema+" CASCADE"); err != nil {
			t.Errorf("remove isolated test schema: %v", err)
		}
	})
	config.RuntimeParams["search_path"] = schema
	registered := stdlib.RegisterConnConfig(config)
	t.Cleanup(func() { stdlib.UnregisterConnConfig(registered) })
	return ctx, registered
}

func migratedDatabase(t *testing.T) (context.Context, *sql.DB, *database.Queries) {
	t.Helper()
	ctx, dsn := isolatedDatabase(t)
	db, err := database.Open(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { db.Close() })
	return ctx, db, database.New(db)
}

func fixtureUser() database.UpsertUserParams {
	return database.UpsertUserParams{
		ForgeURL: "https://forge.example.invalid", ForgeUserID: 42, Login: "alice",
		FullName: "Alice Fixture", AvatarURL: "https://forge.example.invalid/avatar/42",
	}
}

func readUser(t *testing.T, ctx context.Context, db *sql.DB, id int64) database.GolfUser {
	t.Helper()
	var user database.GolfUser
	err := db.QueryRowContext(ctx, `SELECT id, forge_url, forge_user_id, login, full_name, avatar_url
		FROM golf_users WHERE id = $1`, id).Scan(&user.ID, &user.ForgeURL, &user.ForgeUserID, &user.Login, &user.FullName, &user.AvatarURL)
	if err != nil {
		t.Fatal(err)
	}
	return user
}

func TestSessionQueriesPostgres(t *testing.T) {
	ctx, db, queries := migratedDatabase(t)
	user := fixtureUser()
	id, err := queries.UpsertUser(ctx, user)
	if err != nil {
		t.Fatal(err)
	}
	user.Login, user.FullName, user.AvatarURL = "renamed", "O'Connor; SELECT 'literal text'", "https://forge.example.invalid/new-avatar"
	updatedID, err := queries.UpsertUser(ctx, user)
	if err != nil || updatedID != id {
		t.Fatalf("upsert must preserve the existing identity: id=%d error=%v", updatedID, err)
	}
	stored := readUser(t, ctx, db, id)
	if stored.Login != user.Login || stored.FullName != user.FullName || stored.AvatarURL != user.AvatarURL {
		t.Fatal("identity profile was not updated verbatim")
	}
	otherForge := user
	otherForge.ForgeURL = "https://other-forge.example.invalid"
	otherID, err := queries.UpsertUser(ctx, otherForge)
	if err != nil || otherID == id {
		t.Fatalf("same upstream user ID must stay scoped to its forge: error=%v", err)
	}
	var now time.Time
	if err := db.QueryRowContext(ctx, "SELECT now()").Scan(&now); err != nil {
		t.Fatal(err)
	}
	liveHash, expiredHash, otherHash := sha256.Sum256([]byte("live")), sha256.Sum256([]byte("expired")), sha256.Sum256([]byte("other"))
	credential := []byte{0, 0xff, 0x80, 1, 2, 3}
	for _, session := range []database.CreateSessionParams{
		{CredentialKind: "pat", TokenHash: liveHash[:], UserID: id, EncryptedToken: credential, ExpiresAt: now.Add(time.Hour)},
		{CredentialKind: "pat", TokenHash: expiredHash[:], UserID: id, EncryptedToken: []byte("expired envelope"), ExpiresAt: now.Add(-time.Hour)},
		{CredentialKind: "pat", TokenHash: otherHash[:], UserID: otherID, EncryptedToken: []byte("other envelope"), ExpiresAt: now.Add(time.Hour)},
	} {
		if err := queries.CreateSession(ctx, session); err != nil {
			t.Fatal(err)
		}
	}
	lookup := database.GetSessionCredentialParams{TokenHash: liveHash[:], ForgeURL: user.ForgeURL}
	got, err := queries.GetSessionCredential(ctx, lookup)
	if err != nil || !bytes.Equal(got.EncryptedToken, credential) {
		t.Fatalf("opaque credential must round-trip unchanged: error=%v", err)
	}
	for _, denied := range []database.GetSessionCredentialParams{
		{TokenHash: liveHash[:], ForgeURL: otherForge.ForgeURL},
		{TokenHash: expiredHash[:], ForgeURL: user.ForgeURL},
		{TokenHash: []byte("unknown"), ForgeURL: user.ForgeURL},
	} {
		if _, err := queries.GetSessionCredential(ctx, denied); !errors.Is(err, sql.ErrNoRows) {
			t.Fatalf("expired, unknown and other-forge credentials must be absent: %v", err)
		}
	}
	if err := queries.DeleteExpiredSessions(ctx); err != nil {
		t.Fatal(err)
	}
	var remaining int
	if err := db.QueryRowContext(ctx, "SELECT count(*) FROM golf_sessions").Scan(&remaining); err != nil || remaining != 2 {
		t.Fatalf("expiry cleanup must remove only expired sessions: count=%d error=%v", remaining, err)
	}
	for range 2 {
		if err := queries.DeleteSession(ctx, liveHash[:]); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := queries.GetSessionCredential(ctx, lookup); !errors.Is(err, sql.ErrNoRows) {
		t.Fatalf("deleted session remained accessible: %v", err)
	}
	if _, err := queries.GetSessionCredential(ctx, database.GetSessionCredentialParams{TokenHash: otherHash[:], ForgeURL: otherForge.ForgeURL}); err != nil {
		t.Fatalf("deleting one session affected another: %v", err)
	}
}

func TestSessionReplacementTransactionPostgres(t *testing.T) {
	ctx, db, queries := migratedDatabase(t)
	user := fixtureUser()
	id, err := queries.UpsertUser(ctx, user)
	if err != nil {
		t.Fatal(err)
	}
	oldHash, newHash := sha256.Sum256([]byte("old session")), sha256.Sum256([]byte("new session"))
	old := database.CreateSessionParams{CredentialKind: "pat", TokenHash: oldHash[:], UserID: id, EncryptedToken: []byte("old envelope"), ExpiresAt: time.Now().Add(time.Hour)}
	if err := queries.CreateSession(ctx, old); err != nil {
		t.Fatal(err)
	}
	newSession := old
	newSession.TokenHash, newSession.EncryptedToken = newHash[:], []byte("new envelope")
	replacementUser := user
	replacementUser.Login = "replacement-profile"
	for _, fail := range []bool{true, false} {
		tx, err := db.BeginTx(ctx, nil)
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { tx.Rollback() })
		transaction := queries.WithTx(tx)
		if _, err := transaction.UpsertUser(ctx, replacementUser); err != nil {
			t.Fatal(err)
		}
		if err := transaction.CreateSession(ctx, newSession); err != nil {
			t.Fatal(err)
		}
		if err := transaction.DeleteSession(ctx, oldHash[:]); err != nil {
			t.Fatal(err)
		}
		if fail {
			// A duplicate token hash aborts PostgreSQL's transaction after all
			// replacement writes, proving they cannot leak through a failed login.
			if err := transaction.CreateSession(ctx, newSession); err == nil {
				t.Fatal("duplicate session hash was accepted")
			}
			if err := tx.Rollback(); err != nil {
				t.Fatal(err)
			}
		} else if err := tx.Commit(); err != nil {
			t.Fatal(err)
		}
		live, absent, expectedLogin := newHash[:], oldHash[:], replacementUser.Login
		if fail {
			live, absent, expectedLogin = oldHash[:], newHash[:], user.Login
		}
		if _, err := queries.GetSessionCredential(ctx, database.GetSessionCredentialParams{TokenHash: live, ForgeURL: user.ForgeURL}); err != nil {
			t.Fatalf("expected session after transaction: %v", err)
		}
		if _, err := queries.GetSessionCredential(ctx, database.GetSessionCredentialParams{TokenHash: absent, ForgeURL: user.ForgeURL}); !errors.Is(err, sql.ErrNoRows) {
			t.Fatalf("unexpected session after transaction: %v", err)
		}
		if stored := readUser(t, ctx, db, id); stored.Login != expectedLogin {
			t.Fatal("identity profile did not follow the session transaction")
		}
	}
}

func TestMigrationLockAndConcurrentStartupPostgres(t *testing.T) {
	ctx, dsn := isolatedDatabase(t)
	db, err := sql.Open("pgx", dsn)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { db.Close() })
	conn, err := db.Conn(ctx)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { conn.Close() })
	locker, err := lock.NewPostgresSessionLocker()
	if err != nil {
		t.Fatal(err)
	}
	if err := locker.SessionLock(ctx, conn); err != nil {
		t.Fatal(err)
	}
	locked := true
	t.Cleanup(func() {
		if locked {
			cleanup, done := context.WithTimeout(context.Background(), 10*time.Second)
			defer done()
			if err := locker.SessionUnlock(cleanup, conn); err != nil {
				t.Errorf("release test migration lock: %v", err)
			}
		}
	})
	blocked, cancel := context.WithTimeout(ctx, 250*time.Millisecond)
	opened, err := database.Open(blocked, dsn)
	cancel()
	if opened != nil {
		opened.Close()
	}
	if !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("startup must wait for the held migration lock: %v", err)
	}
	var migrated bool
	if err := db.QueryRowContext(ctx, "SELECT to_regclass('golf_users') IS NOT NULL").Scan(&migrated); err != nil || migrated {
		t.Fatalf("schema changed while migration lock was held: migrated=%t error=%v", migrated, err)
	}
	if err := locker.SessionUnlock(ctx, conn); err != nil {
		t.Fatal(err)
	}
	locked = false
	start := make(chan struct{})
	type result struct {
		db  *sql.DB
		err error
	}
	const starters = 4
	results := make(chan result, starters)
	for range starters {
		go func() {
			<-start
			db, err := database.Open(ctx, dsn)
			results <- result{db, err}
		}()
	}
	close(start)
	for range starters {
		result := <-results
		if result.err != nil {
			t.Errorf("concurrent migration startup: %v", result.err)
		}
		if result.db != nil {
			result.db.Close()
		}
	}
	if t.Failed() {
		return
	}
	var applied int
	if err := db.QueryRowContext(ctx, "SELECT count(*) FROM goose_db_version WHERE version_id = $1 AND is_applied", 1).Scan(&applied); err != nil || applied != 1 {
		t.Fatalf("migration must be recorded exactly once: count=%d error=%v", applied, err)
	}
	if _, err := database.New(db).UpsertUser(ctx, fixtureUser()); err != nil {
		t.Fatalf("migrated schema unusable after competing startups: %v", err)
	}
}

func TestOAuthMigrationPreservesPATPostgres(t *testing.T) {
	ctx, dsn := isolatedDatabase(t)
	db, err := sql.Open("pgx", dsn)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	provider, err := goose.NewProvider(goose.DialectPostgres, db, os.DirFS("migrations"))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := provider.UpTo(ctx, 1); err != nil {
		t.Fatal(err)
	}
	id, err := database.New(db).UpsertUser(ctx, fixtureUser())
	if err != nil {
		t.Fatal(err)
	}
	hash := sha256.Sum256([]byte("existing PAT"))
	envelope := []byte{0xff, 0, 1, 2, 3, 0x80}
	if _, err := db.ExecContext(ctx, "INSERT INTO golf_sessions(token_hash,user_id,encrypted_token,expires_at) VALUES ($1,$2,$3,$4)", hash[:], id, envelope, time.Now().Add(time.Hour)); err != nil {
		t.Fatal(err)
	}
	migrated, err := database.Open(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	defer migrated.Close()
	row, err := database.New(migrated).GetSessionCredential(ctx, database.GetSessionCredentialParams{TokenHash: hash[:], ForgeURL: fixtureUser().ForgeURL})
	if err != nil || row.CredentialKind != "pat" || !bytes.Equal(row.EncryptedToken, envelope) {
		t.Fatal("upgrade changed PAT credential or lost explicit kind")
	}
	oauthHash := sha256.Sum256([]byte("OAuth envelope"))
	if err := database.New(migrated).CreateSession(ctx, database.CreateSessionParams{TokenHash: oauthHash[:], UserID: id, EncryptedToken: []byte("encrypted OAuth"), ExpiresAt: time.Now().Add(time.Hour), CredentialKind: "oauth"}); err != nil {
		t.Fatal(err)
	}
	if _, err := provider.DownTo(ctx, 1); err != nil {
		t.Fatal(err)
	}
	var retained []byte
	var count int
	if err := db.QueryRowContext(ctx, "SELECT encrypted_token FROM golf_sessions WHERE token_hash=$1", hash[:]).Scan(&retained); err != nil || !bytes.Equal(retained, envelope) {
		t.Fatal("downgrade lost PAT")
	}
	if err := db.QueryRowContext(ctx, "SELECT count(*) FROM golf_sessions").Scan(&count); err != nil || count != 1 {
		t.Fatal("downgrade retained an OAuth envelope without its kind")
	}
}
