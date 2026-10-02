package database

import (
	"context"
	"crypto/rand"
	"database/sql"
	"errors"
	"fmt"
	"net"
	"os"
	"strings"
	"sync/atomic"
	"syscall"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/stdlib"
)

func startupPostgres(t *testing.T) (*pgx.ConnConfig, *sql.DB) {
	t.Helper()
	dsn := os.Getenv("GOLF_TEST_DATABASE_URL")
	if dsn == "" {
		t.Skip("set GOLF_TEST_DATABASE_URL for real PostgreSQL integration")
	}
	config, err := pgx.ParseConfig(dsn)
	if err != nil {
		t.Fatal("invalid dedicated PostgreSQL configuration")
	}
	admin := stdlib.OpenDB(*config)
	t.Cleanup(func() { admin.Close() })
	suffix := make([]byte, 8)
	if _, err := rand.Read(suffix); err != nil {
		t.Fatal("generate isolated schema name")
	}
	schema := pgx.Identifier{fmt.Sprintf("golf_startup_%x", suffix)}.Sanitize()
	ctx, cancel := context.WithTimeout(t.Context(), 10*time.Second)
	defer cancel()
	if _, err := admin.ExecContext(ctx, "CREATE SCHEMA "+schema); err != nil {
		t.Fatal("create isolated PostgreSQL schema")
	}
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		if _, err := admin.ExecContext(ctx, "DROP SCHEMA "+schema+" CASCADE"); err != nil {
			t.Error("remove isolated PostgreSQL schema")
		}
	})
	config.RuntimeParams["search_path"] = schema
	return config, admin
}

func startupDSN(t *testing.T, config *pgx.ConnConfig) string {
	t.Helper()
	dsn := stdlib.RegisterConnConfig(config)
	t.Cleanup(func() { stdlib.UnregisterConnConfig(dsn) })
	return dsn
}

func TestStartupDelayedPostgres(t *testing.T) {
	config, _ := startupPostgres(t)
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal("reserve unavailable local endpoint")
	}
	unavailable := listener.Addr().String()
	listener.Close()
	var attempts atomic.Int32
	dial := config.DialFunc
	config.DialFunc = func(ctx context.Context, network, address string) (net.Conn, error) {
		if attempts.Add(1) <= 2 {
			// Exercise real TCP refusal before allowing native PostgreSQL
			// authentication, Ping and migration against the isolated schema.
			return dial(ctx, "tcp", unavailable)
		}
		return dial(ctx, network, address)
	}
	// This positive case includes native migrations and their shared advisory
	// lock under the full race suite; short cancellation is tested separately.
	ctx, cancel := context.WithTimeout(t.Context(), 30*time.Second)
	defer cancel()
	db, err := Open(ctx, startupDSN(t, config))
	if err != nil {
		t.Fatal("startup failed before transient PostgreSQL availability recovered")
	}
	defer db.Close()
	var migrations int
	if err := db.QueryRowContext(ctx, "SELECT count(*) FROM goose_db_version WHERE version_id=1 AND is_applied").Scan(&migrations); err != nil || migrations != 1 {
		t.Fatal("recovered real PostgreSQL connection did not migrate exactly once")
	}
	if attempts.Load() < 3 {
		t.Fatal("transient native connection outage was not exercised")
	}
}

func TestStartupDelayedDNSPostgres(t *testing.T) {
	config, _ := startupPostgres(t)
	address := config.Host
	config.Host = "postgres.startup.invalid"
	var attempts atomic.Int32
	config.LookupFunc = func(context.Context, string) ([]string, error) {
		if attempts.Add(1) <= 2 {
			// Docker can temporarily withdraw a service record during restart.
			return nil, &net.DNSError{IsNotFound: true}
		}
		// Use the dedicated fixture's numeric address without external DNS.
		return []string{address}, nil
	}
	if net.ParseIP(address) == nil {
		t.Fatal("dedicated PostgreSQL DNS fixture requires a numeric address")
	}
	ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
	defer cancel()
	db, err := Open(ctx, startupDSN(t, config))
	if err != nil {
		t.Fatal("startup failed before missing PostgreSQL DNS record recovered")
	}
	defer db.Close()
	var migrations int
	if err := db.QueryRowContext(ctx, "SELECT count(*) FROM goose_db_version WHERE version_id=1 AND is_applied").Scan(&migrations); err != nil || migrations != 1 || attempts.Load() < 3 {
		t.Fatal("recovered DNS did not connect to real PostgreSQL and migrate exactly once")
	}
}

func TestStartupRetryClassification(t *testing.T) {
	cases := []struct {
		name  string
		err   error
		retry bool
	}{
		{"refused", &net.OpError{Op: "dial", Net: "tcp", Err: syscall.ECONNREFUSED}, true},
		{"reset", fmt.Errorf("transport: %w", syscall.ECONNRESET), true},
		{"broken pipe", syscall.EPIPE, true},
		{"aborted", syscall.ECONNABORTED, true},
		{"transport timeout", syscall.ETIMEDOUT, true},
		{"per-connection deadline", context.DeadlineExceeded, true},
		{"temporary DNS", &net.DNSError{IsTemporary: true}, true},
		{"DNS timeout", &net.DNSError{IsTimeout: true}, true},
		{"starting PostgreSQL", &pgconn.PgError{Code: "57P03"}, true},
		{"connection slots exhausted", &pgconn.PgError{Code: "53300"}, true},
		{"wrapped transient alternatives", fmt.Errorf("connect: %w", errors.Join(syscall.ECONNREFUSED, syscall.ECONNRESET)), true},
		{"password", &pgconn.PgError{Code: "28P01"}, false},
		{"authentication", &pgconn.PgError{Code: "28000"}, false},
		{"database absent", &pgconn.PgError{Code: "3D000"}, false},
		{"permission", &pgconn.PgError{Code: "42501"}, false},
		{"unknown provider error", &pgconn.PgError{Code: "XX000"}, false},
		{"DNS absent", &net.DNSError{IsNotFound: true}, true},
		{"unclassified DNS", &net.DNSError{}, false},
		{"cancelled", context.Canceled, false},
		{"unknown", errors.New("unexpected connection failure"), false},
		{"mixed auth and transport", errors.Join(syscall.ECONNREFUSED, &pgconn.PgError{Code: "28P01"}), false},
		{"mixed startup and auth", errors.Join(&pgconn.PgError{Code: "57P03"}, &pgconn.PgError{Code: "28000"}), false},
	}
	for _, tt := range cases {
		t.Run(tt.name, func(t *testing.T) {
			if retryableConnectionError(tt.err) != tt.retry {
				t.Fatal("connection error received incorrect retry classification")
			}
		})
	}
}

func TestStartupConnectionCancellation(t *testing.T) {
	for _, missingDNS := range []bool{false, true} {
		for _, deadline := range []bool{false, true} {
			t.Run(fmt.Sprintf("dns=%t/deadline=%t", missingDNS, deadline), func(t *testing.T) {
				config, err := pgx.ParseConfig("postgres://unused@127.0.0.1:1/unused?sslmode=disable")
				if err != nil {
					t.Fatal("parse fixture connection")
				}
				attempted := make(chan struct{}, 1)
				var attempts atomic.Int32
				attempt := func() {
					attempts.Add(1)
					select {
					case attempted <- struct{}{}:
					default:
					}
				}
				var cause error = syscall.ECONNREFUSED
				if missingDNS {
					config.Host = "postgres.startup.invalid"
					cause = &net.DNSError{IsNotFound: true}
					config.LookupFunc = func(context.Context, string) ([]string, error) {
						attempt()
						return nil, cause
					}
				}
				config.DialFunc = func(context.Context, string, string) (net.Conn, error) {
					attempt()
					return nil, cause
				}
				ctx, cancel := context.WithCancel(t.Context())
				defer cancel()
				want := context.Canceled
				if deadline {
					var stop context.CancelFunc
					ctx, stop = context.WithTimeout(ctx, 650*time.Millisecond)
					defer stop()
					want = context.DeadlineExceeded
				}
				dsn := startupDSN(t, config)
				outcome := make(chan error, 1)
				go func() {
					db, err := Open(ctx, dsn)
					if db != nil {
						db.Close()
					}
					outcome <- err
				}()
				select {
				case <-attempted:
				case <-time.After(2 * time.Second):
					t.Fatal("connection attempt never began")
				}
				if !deadline {
					cancel()
				}
				select {
				case err := <-outcome:
					if !errors.Is(err, want) || !errors.Is(err, cause) {
						t.Fatal("cancellation lost context or connection cause")
					}
				case <-time.After(2 * time.Second):
					t.Fatal("connection wait ignored cancellation")
				}
				if deadline && attempts.Load() < 2 {
					t.Fatal("deadline did not cover a retry")
				}
			})
		}
	}
}

func TestStartupDefaultConnectionDeadline(t *testing.T) {
	config, err := pgx.ParseConfig("postgres://unused@127.0.0.1:1/unused?sslmode=disable")
	if err != nil {
		t.Fatal("parse fixture connection")
	}
	var remaining time.Duration
	config.DialFunc = func(ctx context.Context, _, _ string) (net.Conn, error) {
		deadline, bounded := ctx.Deadline()
		if bounded {
			remaining = time.Until(deadline)
		}
		return nil, &pgconn.PgError{Code: "28P01"}
	}
	if db, err := Open(context.Background(), startupDSN(t, config)); db != nil || err == nil {
		if db != nil {
			db.Close()
		}
		t.Fatal("permanent failure did not settle")
	}
	if remaining < 59*time.Second || remaining > 60*time.Second {
		t.Fatal("connection without caller deadline did not receive a bounded 60-second deadline")
	}
	if db, err := Open(context.Background(), "postgres://bad:%zz@invalid/invalid"); db != nil || err == nil {
		if db != nil {
			db.Close()
		}
		t.Fatal("invalid DSN accepted")
	}
}

func TestStartupPermanentPostgresDenials(t *testing.T) {
	for _, missingDatabase := range []bool{false, true} {
		t.Run(fmt.Sprintf("missing_database=%t", missingDatabase), func(t *testing.T) {
			config, _ := startupPostgres(t)
			if missingDatabase {
				config.Database = "golf_absent_startup_database"
			} else {
				config.User = "golf_absent_startup_user"
			}
			var attempts atomic.Int32
			dial := config.DialFunc
			config.DialFunc = func(ctx context.Context, network, address string) (net.Conn, error) {
				attempts.Add(1)
				return dial(ctx, network, address)
			}
			ctx, cancel := context.WithTimeout(t.Context(), 3*time.Second)
			defer cancel()
			db, err := Open(ctx, startupDSN(t, config))
			if db != nil {
				db.Close()
			}
			var postgres *pgconn.PgError
			if !errors.As(err, &postgres) || attempts.Load() != 1 || missingDatabase && postgres.Code != "3D000" || !missingDatabase && postgres.Code != "28P01" && postgres.Code != "28000" {
				t.Fatal("real PostgreSQL permanent denial was not returned after one attempt")
			}
		})
	}
}

type startupMigrationTrace struct{ attempts atomic.Int32 }

func (trace *startupMigrationTrace) TraceQueryStart(ctx context.Context, _ *pgx.Conn, data pgx.TraceQueryStartData) context.Context {
	if strings.Contains(data.SQL, "CREATE TABLE golf_users (") {
		trace.attempts.Add(1)
	}
	return ctx
}
func (*startupMigrationTrace) TraceQueryEnd(context.Context, *pgx.Conn, pgx.TraceQueryEndData) {}

func TestStartupDoesNotRetryMigrationPostgres(t *testing.T) {
	config, admin := startupPostgres(t)
	ctx, cancel := context.WithTimeout(t.Context(), 3*time.Second)
	defer cancel()
	if _, err := admin.ExecContext(ctx, "CREATE TABLE "+config.RuntimeParams["search_path"]+".golf_users (fixture int)"); err != nil {
		t.Fatal("prepare isolated migration failure")
	}
	trace := &startupMigrationTrace{}
	config.Tracer = trace
	db, err := Open(ctx, startupDSN(t, config))
	if db != nil {
		db.Close()
	}
	var postgres *pgconn.PgError
	if !errors.As(err, &postgres) || postgres.Code != "42P07" || trace.attempts.Load() != 1 {
		t.Fatal("migration failure was not returned after one execution")
	}
}
