package database

import (
	"context"
	"net/url"
	"os"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
)

type countingTracer struct{ starts, ends atomic.Int64 }

func (t *countingTracer) TraceQueryStart(ctx context.Context, _ *pgx.Conn, _ pgx.TraceQueryStartData) context.Context {
	t.starts.Add(1)
	return ctx
}
func (t *countingTracer) TraceQueryEnd(_ context.Context, _ *pgx.Conn, _ pgx.TraceQueryEndData) {
	t.ends.Add(1)
}

func TestOpenWithTracerRealPostgres(t *testing.T) {
	config, _ := startupPostgres(t)
	dsn := os.Getenv("GOLF_TEST_DATABASE_URL")
	if strings.HasPrefix(dsn, "postgres://") || strings.HasPrefix(dsn, "postgresql://") {
		parsed, err := url.Parse(dsn)
		if err != nil {
			t.Fatal("invalid fixture URL")
		}
		query := parsed.Query()
		query.Set("search_path", config.RuntimeParams["search_path"])
		parsed.RawQuery = query.Encode()
		dsn = parsed.String()
	} else {
		dsn += " search_path='" + config.RuntimeParams["search_path"] + "'"
	}
	ctx, cancel := context.WithTimeout(t.Context(), 30*time.Second)
	defer cancel()
	tracer := new(countingTracer)
	db, err := OpenWithTracer(ctx, dsn, tracer)
	if err != nil {
		t.Fatal("traced database startup failed")
	}
	defer db.Close()
	before := tracer.starts.Load()
	var result string
	if err := db.QueryRowContext(ctx, "SELECT $1::text", "private-value").Scan(&result); err != nil || result != "private-value" {
		t.Fatal("query behavior changed")
	}
	if tracer.starts.Load() <= before || tracer.starts.Load() != tracer.ends.Load() {
		t.Fatal("native pgx query tracer not attached")
	}
	// A second uninstrumented pool must not reuse the first pool's tracer.
	other, err := Open(ctx, dsn)
	if err != nil {
		t.Fatal("ordinary database startup failed")
	}
	defer other.Close()
	before = tracer.starts.Load()
	if err := other.QueryRowContext(ctx, "SELECT 'ordinary'").Scan(&result); err != nil || tracer.starts.Load() != before {
		t.Fatal("tracer leaked between pools")
	}
}
