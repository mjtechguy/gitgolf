package database

import (
	"context"
	"database/sql"
	"embed"
	"errors"
	"io/fs"
	"net"
	"syscall"
	"time"

	"github.com/jackc/pgx/v5/pgconn"
	_ "github.com/jackc/pgx/v5/stdlib"
	"github.com/pressly/goose/v3"
	"github.com/pressly/goose/v3/lock"
)

//go:embed migrations/*.sql
var migrations embed.FS

// Open verifies connectivity and applies embedded migrations under a PostgreSQL
// advisory lock so simultaneous application startups cannot race migrations.
func Open(ctx context.Context, dsn string) (*sql.DB, error) {
	db, err := sql.Open("pgx", dsn)
	if err != nil {
		return nil, err
	}
	db.SetMaxOpenConns(10)
	db.SetMaxIdleConns(5)
	if err = waitForConnection(ctx, db); err != nil {
		db.Close()
		return nil, err
	}
	files, err := fs.Sub(migrations, "migrations")
	if err != nil {
		db.Close()
		return nil, err
	}
	locker, err := lock.NewPostgresSessionLocker()
	if err != nil {
		db.Close()
		return nil, err
	}
	provider, err := goose.NewProvider(goose.DialectPostgres, db, files, goose.WithSessionLocker(locker))
	if err == nil {
		_, err = provider.Up(ctx)
	}
	if err != nil {
		db.Close()
		return nil, err
	}
	return db, nil
}

// Only connection readiness is retried. Invalid DSN syntax, authentication and
// all migration failures retain their immediate failure behavior.
func waitForConnection(ctx context.Context, db *sql.DB) error {
	if _, bounded := ctx.Deadline(); !bounded {
		var cancel context.CancelFunc
		ctx, cancel = context.WithTimeout(ctx, 60*time.Second)
		defer cancel()
	}
	for {
		err := db.PingContext(ctx)
		if err == nil {
			return nil
		}
		if ctx.Err() != nil {
			return errors.Join(ctx.Err(), err)
		}
		if !retryableConnectionError(err) {
			return err
		}
		select {
		case <-ctx.Done():
			return errors.Join(ctx.Err(), err)
		case <-time.After(250 * time.Millisecond):
		}
	}
}

func retryableConnectionError(err error) bool {
	switch value := err.(type) {
	case *pgconn.PgError:
		// Startup/recovery rejects connections; temporary connection-slot
		// exhaustion can also clear without changing configuration.
		return value.Code == "57P03" || value.Code == "53300"
	case *net.DNSError:
		// A service's DNS record can disappear during a container restart.
		// An unresolved valid hostname, including a typo, waits only until
		// the bounded startup deadline; it cannot be classified earlier.
		return value.IsNotFound || value.IsTemporary || value.IsTimeout
	case interface{ Unwrap() []error }:
		causes := value.Unwrap()
		for _, cause := range causes {
			if !retryableConnectionError(cause) {
				return false
			}
		}
		return len(causes) != 0
	case interface{ Unwrap() error }:
		return retryableConnectionError(value.Unwrap())
	}
	if err == context.DeadlineExceeded || err == syscall.ECONNREFUSED || err == syscall.ECONNRESET ||
		err == syscall.ECONNABORTED || err == syscall.EPIPE || err == syscall.ETIMEDOUT {
		return true
	}
	var network net.Error
	return errors.As(err, &network) && (network.Timeout() || network.Temporary())
}
