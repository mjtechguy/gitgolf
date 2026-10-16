package telemetry

import (
	"context"
	"net/http"
	"strings"
	"time"
	"unicode"

	"github.com/jackc/pgx/v5"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/codes"
	"go.opentelemetry.io/otel/trace"
)

type providerTransport struct {
	runtime *Runtime
	base    http.RoundTripper
}

// HTTPTransport instruments only the configured Forgejo client. The category is
// fixed; URL paths/hosts, request/response bodies and credentials are untouched
// and never become span attributes or metric labels. Duration ends at headers.
func (r *Runtime) HTTPTransport(base http.RoundTripper) http.RoundTripper {
	if base == nil {
		base = http.DefaultTransport
	}
	return providerTransport{runtime: r, base: base}
}

func (t providerTransport) RoundTrip(request *http.Request) (*http.Response, error) {
	method := boundedMethod(request.Method)
	ctx, span := t.runtime.tracer.Start(request.Context(), "forge.request", trace.WithSpanKind(trace.SpanKindClient),
		trace.WithAttributes(attribute.String("server.address", "forgejo"), attribute.String("http.request.method", method)))
	started := time.Now()
	response, err := t.base.RoundTrip(request.Clone(ctx))
	status := 0
	if response != nil {
		status = response.StatusCode
	}
	status, label := boundedStatus(status)
	span.SetAttributes(attribute.Int("http.response.status_code", status))
	if err != nil || status == 0 || status >= 400 {
		span.SetStatus(codes.Error, "Forgejo request failed")
	}
	span.End()
	t.runtime.forge.WithLabelValues(method, label).Inc()
	t.runtime.forgeTime.WithLabelValues(method, label).Observe(time.Since(started).Seconds())
	return response, err
}

type queryKey struct{}
type query struct {
	span      trace.Span
	operation string
	started   time.Time
}

var _ pgx.QueryTracer = (*Runtime)(nil)

func (r *Runtime) TraceQueryStart(ctx context.Context, _ *pgx.Conn, data pgx.TraceQueryStartData) context.Context {
	operation := queryOperation(data.SQL)
	ctx, span := r.tracer.Start(ctx, "postgres.query", trace.WithSpanKind(trace.SpanKindClient),
		trace.WithAttributes(attribute.String("db.system.name", "postgresql"), attribute.String("db.operation.name", operation)))
	return context.WithValue(ctx, queryKey{}, query{span: span, operation: operation, started: time.Now()})
}

func (r *Runtime) TraceQueryEnd(ctx context.Context, _ *pgx.Conn, data pgx.TraceQueryEndData) {
	query, ok := ctx.Value(queryKey{}).(query)
	if !ok {
		return
	}
	outcome := "success"
	if data.Err != nil {
		outcome = "error"
		query.span.SetStatus(codes.Error, "PostgreSQL query failed")
	}
	query.span.End()
	r.queries.WithLabelValues(query.operation, outcome).Inc()
	r.queryTime.WithLabelValues(query.operation, outcome).Observe(time.Since(query.started).Seconds())
}

// Only a small prefix and an allowlisted verb are inspected. SQLC's leading
// name comment is skipped; SQL text, arguments, tags and error messages are
// neither retained in context nor emitted. Unrecognized statements are OTHER.
func queryOperation(sql string) string {
	if len(sql) > 1024 {
		sql = sql[:1024]
	}
	for {
		sql = strings.TrimLeftFunc(sql, unicode.IsSpace)
		if strings.HasPrefix(sql, "--") {
			_, rest, found := strings.Cut(sql, "\n")
			if !found {
				return "OTHER"
			}
			sql = rest
			continue
		}
		if strings.HasPrefix(sql, "/*") {
			_, rest, found := strings.Cut(sql, "*/")
			if !found {
				return "OTHER"
			}
			sql = rest
			continue
		}
		break
	}
	end := 0
	for end < len(sql) && ((sql[end] >= 'A' && sql[end] <= 'Z') || (sql[end] >= 'a' && sql[end] <= 'z')) {
		end++
	}
	switch verb := strings.ToUpper(sql[:end]); verb {
	case "SELECT", "INSERT", "UPDATE", "DELETE", "WITH", "BEGIN", "COMMIT", "ROLLBACK", "CREATE", "ALTER", "DROP", "GRANT", "REVOKE", "TRUNCATE", "SET", "SHOW", "DO":
		return verb
	default:
		return "OTHER"
	}
}
