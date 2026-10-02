package telemetry

import (
	"bytes"
	"context"
	"encoding/hex"
	"errors"
	"io"
	"math"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/rs/zerolog"
	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/sdk/trace/tracetest"
	"go.opentelemetry.io/otel/trace"
	collectorv1 "go.opentelemetry.io/proto/otlp/collector/trace/v1"
	tracev1 "go.opentelemetry.io/proto/otlp/trace/v1"
	"google.golang.org/protobuf/proto"
)

type capture struct {
	sync.Mutex
	bytes.Buffer
}

func (c *capture) Write(p []byte) (int, error) { c.Lock(); defer c.Unlock(); return c.Buffer.Write(p) }
func (c *capture) text() string                { c.Lock(); defer c.Unlock(); return c.Buffer.String() }

func clearAmbient(t *testing.T) {
	t.Helper()
	for _, variable := range os.Environ() {
		name, _, _ := strings.Cut(variable, "=")
		if strings.HasPrefix(name, "OTEL_") {
			t.Setenv(name, "")
		}
	}
}

func metrics(t *testing.T, runtime *Runtime) string {
	t.Helper()
	response := httptest.NewRecorder()
	runtime.MetricsHandler().ServeHTTP(response, httptest.NewRequest("GET", "/metrics", nil))
	if response.Code != http.StatusOK {
		t.Fatal("metrics unavailable")
	}
	return response.Body.String()
}

func shutdown(t *testing.T, runtime *Runtime) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := runtime.Shutdown(ctx); err != nil {
		t.Fatal(err)
	}
}

func TestCorrelatedOTLPHTTPAndPrivateDataOmission(t *testing.T) {
	clearAmbient(t)
	const secret = "private-source-token-query-error-canary"
	var logs capture
	var mu sync.Mutex
	var batches []*collectorv1.ExportTraceServiceRequest
	collector := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
		if request.URL.Path != "/v1/traces" || request.Header.Get("Content-Type") != "application/x-protobuf" || request.Header.Get("Authorization") != "" {
			t.Error("wrong export boundary")
		}
		data, _ := io.ReadAll(io.LimitReader(request.Body, 1<<20))
		if bytes.Contains(data, []byte(secret)) {
			t.Error("private data exported")
		}
		batch := new(collectorv1.ExportTraceServiceRequest)
		if err := proto.Unmarshal(data, batch); err != nil {
			t.Error("invalid OTLP payload")
		}
		mu.Lock()
		batches = append(batches, batch)
		mu.Unlock()
		w.Header().Set("Content-Type", "application/x-protobuf")
	}))
	defer collector.Close()
	globalProvider := otel.GetTracerProvider()
	runtime, err := New(context.Background(), Config{Logger: zerolog.New(&logs), OTLPEndpoint: collector.URL, OTLPInsecure: true, SampleRatio: 1, ServiceVersion: "test"})
	if err != nil {
		t.Fatal(err)
	}
	ctx, request := runtime.StartRequest(context.Background(), "POST", "/rpc/golf.v1.RepositoryService/GetContents")
	if len(request.ID) != 32 || len(request.TraceID) != 32 {
		t.Fatal("missing generated correlation")
	}
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != secret || !strings.Contains(r.URL.RawQuery, secret) {
			t.Error("instrumentation changed actual provider input")
		}
		w.WriteHeader(403)
		io.WriteString(w, secret)
	}))
	defer provider.Close()
	httpRequest, _ := http.NewRequestWithContext(ctx, "GET", provider.URL+"/"+secret+"?access="+secret, nil)
	httpRequest.Header.Set("Authorization", secret)
	response, err := (&http.Client{Transport: runtime.HTTPTransport(nil)}).Do(httpRequest)
	if err != nil {
		t.Fatal(err)
	}
	body, _ := io.ReadAll(response.Body)
	response.Body.Close()
	if string(body) != secret {
		t.Fatal("provider body changed")
	}
	dbctx := runtime.TraceQueryStart(ctx, nil, pgx.TraceQueryStartData{SQL: "-- name: " + secret + "\nSELECT $1", Args: []any{secret}})
	runtime.TraceQueryEnd(dbctx, nil, pgx.TraceQueryEndData{Err: errors.New(secret)})
	request.End(403)
	request.End(500) // A defensive duplicate completion must not change evidence.
	_, unknown := runtime.StartRequest(context.Background(), secret, "/"+secret)
	unknown.End(0)
	shutdown(t, runtime)
	if otel.GetTracerProvider() != globalProvider {
		t.Fatal("global provider changed")
	}
	mu.Lock()
	defer mu.Unlock()
	var spans []*tracev1.Span
	for _, batch := range batches {
		for _, resource := range batch.ResourceSpans {
			for _, scope := range resource.ScopeSpans {
				spans = append(spans, scope.Spans...)
			}
		}
	}
	if len(spans) != 4 {
		t.Fatalf("got %d spans; need HTTP, provider, query and sanitized unknown request", len(spans))
	}
	var parent *tracev1.Span
	for _, span := range spans {
		if span.Name == "HTTP /rpc/golf.v1.RepositoryService/GetContents" {
			parent = span
		}
	}
	if parent == nil || hex.EncodeToString(parent.TraceId) != request.TraceID || len(parent.ParentSpanId) != 0 {
		t.Fatal("root correlation is wrong")
	}
	for _, span := range spans {
		if span.Name == "gitea.request" || span.Name == "postgres.query" {
			if !bytes.Equal(span.TraceId, parent.TraceId) || !bytes.Equal(span.ParentSpanId, parent.SpanId) || span.Status.Code != tracev1.Status_STATUS_CODE_ERROR {
				t.Fatal("dependency span lost context or sanitized error status")
			}
		}
	}
	encoded := metrics(t, runtime)
	if strings.Contains(encoded+logs.text(), secret) || strings.Contains(encoded, request.ID) || strings.Contains(encoded, request.TraceID) {
		t.Fatal("private data or high-cardinality correlation leaked into metrics")
	}
	for _, expected := range []string{`route="not_found",status="aborted"} 1`, `route="/rpc/golf.v1.RepositoryService/GetContents",status="403"} 1`, `golf_database_queries_total{operation="SELECT",outcome="error"} 1`, `golf_telemetry_trace_exports_total{outcome="success"}`} {
		if !strings.Contains(encoded, expected) {
			t.Fatalf("missing bounded metric %s", expected)
		}
	}
	if !strings.Contains(logs.text(), `"request_id":"`+request.ID+`"`) || !strings.Contains(logs.text(), `"trace_id":"`+request.TraceID+`"`) {
		t.Fatal("completion log lost correlation")
	}
}

func TestExplicitConfigurationAndNoGlobalActivation(t *testing.T) {
	clearAmbient(t)
	for _, config := range []Config{
		{SampleRatio: -1}, {SampleRatio: 2}, {SampleRatio: math.NaN()}, {SampleRatio: math.Inf(1)},
		{OTLPInsecure: true}, {OTLPEndpoint: "http://collector:4318"},
		{OTLPEndpoint: "https://user:private@collector/v1/traces"}, {OTLPEndpoint: "https://collector/?private=yes"},
		{OTLPEndpoint: "https://collector/#private"}, {OTLPEndpoint: "ftp://collector"}, {OTLPEndpoint: "private"},
	} {
		if runtime, err := New(context.Background(), config); err == nil || runtime != nil || strings.Contains(err.Error(), "private") {
			t.Fatal("unsafe configuration accepted or reflected")
		}
	}
	t.Setenv("OTEL_EXPORTER_OTLP_HEADERS", "private-ambient-malformed-header")
	if _, err := New(context.Background(), Config{OTLPEndpoint: "https://collector"}); err == nil || strings.Contains(err.Error(), "private") {
		t.Fatal("ambient SDK config not rejected safely")
	}
	var logs capture
	runtime, err := New(context.Background(), Config{Logger: zerolog.New(&logs)})
	if err != nil {
		t.Fatal(err)
	}
	_, request := runtime.StartRequest(context.Background(), "GET", "/healthz")
	if request.ID == "" || request.TraceID != "" {
		t.Fatal("disabled export adopted ambient config")
	}
	request.End(200)
	other, _ := New(context.Background(), Config{Logger: zerolog.Nop()})
	if strings.Contains(metrics(t, other), "golf_http_requests_total{") {
		t.Fatal("private registries share state")
	}
	shutdown(t, runtime)
	shutdown(t, other)
}

func TestRootSamplingIgnoresRemoteParent(t *testing.T) {
	clearAmbient(t)
	var exported int
	collector := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) { exported++ }))
	defer collector.Close()
	runtime, err := New(context.Background(), Config{Logger: zerolog.Nop(), OTLPEndpoint: collector.URL, OTLPInsecure: true, SampleRatio: 0})
	if err != nil {
		t.Fatal(err)
	}
	remote := trace.NewSpanContext(trace.SpanContextConfig{TraceID: trace.TraceID{1}, SpanID: trace.SpanID{2}, TraceFlags: trace.FlagsSampled, Remote: true})
	ctx, request := runtime.StartRequest(trace.ContextWithRemoteSpanContext(context.Background(), remote), "GET", "/healthz")
	if request.TraceID == remote.TraceID().String() || trace.SpanFromContext(ctx).SpanContext().IsSampled() {
		t.Fatal("untrusted parent controlled request trace or sampling")
	}
	request.End(200)
	shutdown(t, runtime)
	if exported != 0 {
		t.Fatal("zero sampling exported data")
	}
}

// Exercise a failing collector in a subprocess so any SDK/global stderr output
// is included in the privacy assertion, not only our injected logger.
func TestCollectorErrorsStayLocal(t *testing.T) {
	const marker = "private-collector-error-marker"
	if os.Getenv("GOLF_TEST_TELEMETRY_CHILD") != "1" {
		command := exec.Command(os.Args[0], "-test.run=^TestCollectorErrorsStayLocal$")
		command.Env = append(os.Environ(), "GOLF_TEST_TELEMETRY_CHILD=1")
		output, err := command.CombinedOutput()
		if err != nil || bytes.Contains(output, []byte(marker)) {
			t.Fatal("collector failure escaped the sanitized runtime boundary")
		}
		return
	}
	clearAmbient(t)
	var logs capture
	collector := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(503)
		io.WriteString(w, marker)
	}))
	defer collector.Close()
	runtime, err := New(context.Background(), Config{Logger: zerolog.New(&logs), OTLPEndpoint: collector.URL, OTLPInsecure: true, SampleRatio: 1})
	if err != nil {
		t.Fatal("runtime failed")
	}
	_, request := runtime.StartRequest(context.Background(), "GET", "/readyz")
	request.End(200)
	shutdown(t, runtime)
	if strings.Contains(logs.text(), marker) || !strings.Contains(logs.text(), "trace export failed") || !strings.Contains(metrics(t, runtime), `golf_telemetry_trace_exports_total{outcome="error"} 1`) {
		t.Fatal("collector error was not represented safely")
	}
}

func TestRedirectRefusal(t *testing.T) {
	clearAmbient(t)
	var targetCalls int
	target := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) { targetCalls++ }))
	defer target.Close()
	redirect := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, target.URL, http.StatusTemporaryRedirect)
	}))
	defer redirect.Close()
	runtime, err := New(context.Background(), Config{Logger: zerolog.Nop(), OTLPEndpoint: redirect.URL, OTLPInsecure: true, SampleRatio: 1})
	if err != nil {
		t.Fatal(err)
	}
	_, request := runtime.StartRequest(context.Background(), "GET", "/healthz")
	request.End(200)
	shutdown(t, runtime)
	if targetCalls != 0 || !strings.Contains(metrics(t, runtime), `outcome="error"} 1`) {
		t.Fatal("export redirect followed or not counted")
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if err := runtime.Shutdown(ctx); err != nil && strings.Contains(err.Error(), redirect.URL) {
		t.Fatal("shutdown exposed collector endpoint")
	}
}

func TestShutdownRespectsCallerDeadline(t *testing.T) {
	clearAmbient(t)
	started := make(chan struct{})
	collector := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		io.Copy(io.Discard, r.Body)
		close(started)
		<-r.Context().Done()
	}))
	defer collector.Close()
	runtime, err := New(context.Background(), Config{Logger: zerolog.Nop(), OTLPEndpoint: collector.URL, OTLPInsecure: true, SampleRatio: 1})
	if err != nil {
		t.Fatal(err)
	}
	_, request := runtime.StartRequest(context.Background(), "GET", "/healthz")
	request.End(200)
	select {
	case <-started:
	case <-time.After(2 * time.Second):
		t.Fatal("export did not start")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Millisecond)
	defer cancel()
	begin := time.Now()
	err = runtime.Shutdown(ctx)
	if err == nil || time.Since(begin) > time.Second || strings.Contains(err.Error(), collector.URL) {
		t.Fatal("shutdown failed to honor caller deadline safely")
	}
}

func TestBoundedQueryClassificationAndExporterShutdownFailure(t *testing.T) {
	for sql, want := range map[string]string{"-- name: Private\nselect $1": "SELECT", " /* comment */ WITH private AS (SELECT 1) SELECT * FROM private": "WITH", "SECRET": "OTHER", "--" + strings.Repeat("x", 2048) + "\nSELECT 1": "OTHER", "": "OTHER", "DO $$ private $$": "DO"} {
		if got := queryOperation(sql); got != want {
			t.Fatalf("operation got %s, want %s", got, want)
		}
	}
	exporter := &safeExporter{exporter: failingShutdown{tracetest.NewInMemoryExporter()}}
	if err := exporter.Shutdown(context.Background()); err == nil || strings.Contains(err.Error(), "private") {
		t.Fatal("exporter shutdown error reflected")
	}
}

type failingShutdown struct{ *tracetest.InMemoryExporter }

func (failingShutdown) Shutdown(context.Context) error { return errors.New("private-shutdown-error") }
