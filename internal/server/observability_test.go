package server

import (
	"bufio"
	"bytes"
	"context"
	"encoding/hex"
	"encoding/json"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/go-chi/chi/v5/middleware"
	"github.com/mjtechguy/golf-git/gen/golf/v1/golfv1connect"
	"github.com/mjtechguy/golf-git/internal/telemetry"
	"github.com/rs/zerolog"
	collectortrace "go.opentelemetry.io/proto/otlp/collector/trace/v1"
	tracev1 "go.opentelemetry.io/proto/otlp/trace/v1"
	"google.golang.org/protobuf/encoding/protojson"
	"google.golang.org/protobuf/proto"
)

func TestHTTPObservationPrivacyCorrelationAndIsolation(t *testing.T) {
	const secret = "private-observation-canary"
	var logs bytes.Buffer
	var captured []*tracev1.Span
	var collection sync.Mutex
	collector := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, err := io.ReadAll(r.Body)
		var batch collectortrace.ExportTraceServiceRequest
		if err != nil || proto.Unmarshal(body, &batch) != nil || r.URL.Path != "/v1/traces" {
			t.Error("invalid trace export")
			w.WriteHeader(400)
			return
		}
		collection.Lock()
		defer collection.Unlock()
		for _, resource := range batch.ResourceSpans {
			for _, scope := range resource.ScopeSpans {
				captured = append(captured, scope.Spans...)
			}
		}
		w.Header().Set("Content-Type", "application/x-protobuf")
	}))
	defer collector.Close()
	runtime, err := telemetry.New(context.Background(), telemetry.Config{Logger: zerolog.New(&logs), OTLPEndpoint: collector.URL, OTLPInsecure: true, SampleRatio: 1})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = runtime.Shutdown(context.Background()) })
	forge := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/v1/repos/"+secret || r.Header.Get("Authorization") != "token "+secret {
			t.Error("instrumentation changed native provider request")
		}
		if r.Header.Get("traceparent") != "" || r.Header.Get("baggage") != "" {
			t.Error("unexpected external trace propagation")
		}
		respond(w, 200, map[string]string{"private": secret})
	}))
	defer forge.Close()
	config := testConfig(forge.URL)
	config.Telemetry = runtime
	config.WebDir = t.TempDir()
	if err := os.WriteFile(filepath.Join(config.WebDir, "index.html"), []byte("<main>Golf</main>"), 0600); err != nil {
		t.Fatal(err)
	}
	s, err := New(config, nil)
	if err != nil {
		t.Fatal(err)
	}
	requestIDs := map[string]bool{}
	for _, tc := range []struct{ method, path, route string }{
		{"GET", "/healthz?token=" + secret, "/healthz"},
		{"POST", "/rpc" + golfv1connect.SessionServiceGetAuthenticationOptionsProcedure, "/rpc" + golfv1connect.SessionServiceGetAuthenticationOptionsProcedure},
		{"POST", "/rpc/" + secret, "not_found"},
		{"GET", "/api/" + secret, "not_found"},
		{secret, "/" + secret, "not_found"},
		{"GET", "/" + secret, "web"},
	} {
		body := `{}`
		if tc.path == "/rpc/"+secret {
			body = `{"token":"` + secret + `"}`
		}
		r := httptest.NewRequest(tc.method, tc.path, strings.NewReader(body))
		r.Header.Set("Authorization", "Bearer "+secret)
		r.Header.Set("Cookie", "golf_session="+secret)
		r.Header.Set("User-Agent", secret)
		r.Header.Set("Referer", "https://example.test/"+secret)
		r.Header.Set("X-Request-ID", secret)
		r.Header.Set("traceparent", "00-11111111111111111111111111111111-2222222222222222-01")
		r.Header.Set("tracestate", "private="+secret)
		r.Header.Set("baggage", "private="+secret)
		r.Header.Set("Accept", "text/html")
		r.Header.Set("Origin", config.PublicURL)
		r.Header.Set("Content-Type", "application/json")
		r.Header.Set("Connect-Protocol-Version", "1")
		w := httptest.NewRecorder()
		s.ServeHTTP(w, r)
		id := w.Header().Get("X-Request-ID")
		if decoded, err := hex.DecodeString(id); err != nil || len(decoded) != 16 || requestIDs[id] {
			t.Fatalf("invalid or reused response request ID %q", id)
		}
		requestIDs[id] = true
		lines := strings.Split(strings.TrimSpace(logs.String()), "\n")
		var entry map[string]any
		if err := json.Unmarshal([]byte(lines[len(lines)-1]), &entry); err != nil || entry["request_id"] != id || entry["route"] != tc.route || entry["status"] != float64(w.Code) {
			t.Fatalf("response and sanitized request log disagree: %s", lines[len(lines)-1])
		}
	}
	// Use the configured native client under the same request context. The
	// provider receives its real path and token; exported telemetry receives none.
	procedure := "/rpc" + golfv1connect.RepositoryServiceGetRepositoryProcedure
	w := httptest.NewRecorder()
	s.observeHTTP(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var output map[string]string
		if _, err := s.forge(r.Context(), "GET", "/repos/"+secret, forgeCredential{Kind: "pat", Token: secret}, nil, &output); err != nil || output["private"] != secret {
			t.Error("instrumented provider read failed")
		}
		w.WriteHeader(204)
	}), false).ServeHTTP(w, httptest.NewRequest("POST", procedure, nil))
	providerRequestID := w.Header().Get("X-Request-ID")
	shutdown, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := runtime.Shutdown(shutdown); err != nil {
		t.Fatal(err)
	}
	metrics := httptest.NewRecorder()
	runtime.MetricsHandler().ServeHTTP(metrics, httptest.NewRequest("GET", "/metrics", nil))
	if strings.Contains(logs.String()+metrics.Body.String(), secret) || strings.Contains(metrics.Body.String(), providerRequestID) {
		t.Fatal("private request data or high-cardinality ID leaked into telemetry")
	}
	collection.Lock()
	defer collection.Unlock()
	var serverSpan, providerSpan *tracev1.Span
	for _, span := range captured {
		data, _ := protojson.Marshal(span)
		if strings.Contains(string(data), secret) || hex.EncodeToString(span.TraceId) == "11111111111111111111111111111111" {
			t.Fatal("private input or untrusted parent appeared in a trace")
		}
		if span.Name == "HTTP "+procedure {
			serverSpan = span
		}
		if span.Name == "forge.request" {
			providerSpan = span
		}
	}
	if serverSpan == nil || providerSpan == nil || !bytes.Equal(serverSpan.TraceId, providerSpan.TraceId) || !bytes.Equal(serverSpan.SpanId, providerSpan.ParentSpanId) || len(serverSpan.ParentSpanId) != 0 {
		t.Fatal("native provider span did not belong to the fresh HTTP root")
	}
	if !strings.Contains(logs.String(), hex.EncodeToString(serverSpan.TraceId)) || !strings.Contains(logs.String(), providerRequestID) {
		t.Fatal("request log missing trace correlation")
	}
	other, err := telemetry.New(context.Background(), telemetry.Config{Logger: zerolog.Nop()})
	if err != nil {
		t.Fatal(err)
	}
	otherMetrics := httptest.NewRecorder()
	other.MetricsHandler().ServeHTTP(otherMetrics, httptest.NewRequest("GET", "/metrics", nil))
	if strings.Contains(otherMetrics.Body.String(), "golf_http_requests_total{") || strings.Contains(otherMetrics.Body.String(), "golf_forge_requests_total{") {
		t.Fatal("independent runtime inherited another server's observations")
	}
}

func TestHTTPObservationStatusAndSafePanic(t *testing.T) {
	for _, tc := range []struct {
		name   string
		handle http.HandlerFunc
		status int
		abort  bool
	}{
		{"implicit", func(http.ResponseWriter, *http.Request) {}, 200, false},
		{"explicit", func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(204) }, 204, false},
		{"first status wins", func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(201); w.WriteHeader(418) }, 201, false},
		{"flush", func(w http.ResponseWriter, _ *http.Request) { _ = http.NewResponseController(w).Flush() }, 200, false},
		{"panic", func(http.ResponseWriter, *http.Request) { panic("private-panic-canary") }, 500, false},
		{"abort before headers", func(http.ResponseWriter, *http.Request) { panic(http.ErrAbortHandler) }, 0, true},
		{"panic after headers", func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(201); panic("private-panic-canary") }, 201, true},
		{"panic after flush", func(w http.ResponseWriter, _ *http.Request) { w.(http.Flusher).Flush(); panic("private-panic-canary") }, 200, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var logs bytes.Buffer
			runtime, err := telemetry.New(context.Background(), telemetry.Config{Logger: zerolog.New(&logs)})
			if err != nil {
				t.Fatal(err)
			}
			s := &Server{config: Config{Telemetry: runtime}}
			w := httptest.NewRecorder()
			var panicValue any
			func() {
				defer func() { panicValue = recover() }()
				s.observeHTTP(tc.handle, false).ServeHTTP(w, httptest.NewRequest("GET", "/healthz", nil))
			}()
			if (panicValue == http.ErrAbortHandler) != tc.abort || (panicValue != nil && panicValue != http.ErrAbortHandler) {
				t.Fatalf("unexpected recovered value: %T", panicValue)
			}
			var event map[string]any
			if err := json.Unmarshal(logs.Bytes(), &event); err != nil || event["status"] != float64(tc.status) {
				t.Fatalf("wrong recorded status: %s", logs.String())
			}
			if strings.Contains(logs.String()+w.Body.String(), "private-panic-canary") || strings.Contains(logs.String(), "goroutine") {
				t.Fatal("panic text or stack escaped safe recovery")
			}
			if tc.status == 500 && w.Body.String() != "Internal server error.\n" {
				t.Fatal("pre-header panic did not return a generic error")
			}
			if tc.abort && w.Body.Len() != 0 {
				t.Fatal("aborted response was incorrectly appended with a 500")
			}
		})
	}
}

type observationFancyWriter struct {
	*httptest.ResponseRecorder
	connection net.Conn
	copied     bool
}

func (w *observationFancyWriter) Hijack() (net.Conn, *bufio.ReadWriter, error) {
	return w.connection, bufio.NewReadWriter(bufio.NewReader(w.connection), bufio.NewWriter(w.connection)), nil
}
func (w *observationFancyWriter) ReadFrom(r io.Reader) (int64, error) {
	w.copied = true
	return io.Copy(w.ResponseRecorder, r)
}

func TestHTTPObservationStreamingInterfaces(t *testing.T) {
	var logs bytes.Buffer
	runtime, err := telemetry.New(context.Background(), telemetry.Config{Logger: zerolog.New(&logs)})
	if err != nil {
		t.Fatal(err)
	}
	s := &Server{config: Config{Telemetry: runtime}}
	left, right := net.Pipe()
	defer left.Close()
	defer right.Close()
	w := &observationFancyWriter{ResponseRecorder: httptest.NewRecorder(), connection: left}
	s.observeHTTP(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		if _, ok := w.(http.Flusher); !ok {
			t.Fatal("flusher lost")
		}
		if _, ok := w.(io.ReaderFrom); !ok {
			t.Fatal("native optimized copying lost")
		}
		if _, _, err := http.NewResponseController(w).Hijack(); err != nil {
			t.Fatal(err)
		}
	}), false).ServeHTTP(w, httptest.NewRequest("GET", "/healthz", nil))
	if !strings.Contains(logs.String(), `"status":0`) {
		t.Fatal("hijacked response incorrectly claimed an implicit 200")
	}
	logs.Reset()
	w = &observationFancyWriter{ResponseRecorder: httptest.NewRecorder()}
	s.observeHTTP(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.(io.ReaderFrom).ReadFrom(strings.NewReader("stream"))
		_ = http.NewResponseController(w).Flush()
	}), false).ServeHTTP(w, httptest.NewRequest("GET", "/healthz", nil))
	if !w.copied || !w.Flushed || w.Body.String() != "stream" || !strings.Contains(logs.String(), `"status":200`) {
		t.Fatal("streaming wrapper changed copy/flush behavior")
	}
	// net/http handles informational responses before the final status; use a
	// real HTTP connection because ResponseRecorder does not model this behavior.
	logs.Reset()
	server := httptest.NewServer(s.observeHTTP(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(103)
		w.WriteHeader(202)
	}), false))
	response, err := server.Client().Get(server.URL + "/healthz")
	if err != nil {
		server.Close()
		t.Fatal(err)
	}
	_ = response.Body.Close()
	server.Close()
	if response.StatusCode != 202 || !strings.Contains(logs.String(), `"status":202`) {
		t.Fatal("informational header replaced the actual final status")
	}
}

func TestHTTPObservationIncludesTimeoutStatus(t *testing.T) {
	var logs bytes.Buffer
	runtime, err := telemetry.New(context.Background(), telemetry.Config{Logger: zerolog.New(&logs)})
	if err != nil {
		t.Fatal(err)
	}
	s := &Server{config: Config{Telemetry: runtime}}
	w := httptest.NewRecorder()
	handler := middleware.Timeout(time.Millisecond)(http.HandlerFunc(func(_ http.ResponseWriter, r *http.Request) {
		<-r.Context().Done()
	}))
	s.observeHTTP(handler, false).ServeHTTP(w, httptest.NewRequest("GET", "/readyz", nil))
	if w.Code != 504 || !strings.Contains(logs.String(), `"status":504`) {
		t.Fatal("outer observer missed the timeout middleware's final response")
	}
}
