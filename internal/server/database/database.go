package database

import (
	"context"
	"database/sql"
	"embed"
	"io/fs"

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
	if err = db.PingContext(ctx); err != nil {
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
