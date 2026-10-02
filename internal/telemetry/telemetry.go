// Package telemetry instruments Golf's existing request and dependency paths.
// Every runtime owns its provider, registry and logger; no global telemetry
// configuration or request-derived labels are installed.
package telemetry

import (
	"context"
	"crypto/rand"
	"crypto/tls"
	"encoding/hex"
	"errors"
	"math"
	"net/http"
	"net/url"
	"os"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	golfv1 "github.com/mjtechguy/golf-git/gen/golf/v1"
	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promhttp"
	"github.com/rs/zerolog"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/codes"
	"go.opentelemetry.io/otel/exporters/otlp/otlptrace/otlptracehttp"
	"go.opentelemetry.io/otel/sdk/resource"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	"go.opentelemetry.io/otel/trace"
	"go.opentelemetry.io/otel/trace/noop"
)

type Config struct {
	Logger         zerolog.Logger
	OTLPEndpoint   string
	OTLPInsecure   bool
	SampleRatio    float64
	ServiceVersion string
}

type Runtime struct {
	logger    zerolog.Logger
	tracer    trace.Tracer
	provider  *sdktrace.TracerProvider
	registry  *prometheus.Registry
	routes    map[string]struct{}
	requests  *prometheus.CounterVec
	duration  *prometheus.HistogramVec
	gitea     *prometheus.CounterVec
	giteaTime *prometheus.HistogramVec
	queries   *prometheus.CounterVec
	queryTime *prometheus.HistogramVec
	exports   *prometheus.CounterVec
	transport *http.Transport
}

// New does not connect to a collector. Export is disabled unless an explicit
// Golf endpoint is configured; a collector failure never blocks application IO.
func New(ctx context.Context, config Config) (*Runtime, error) {
	if math.IsNaN(config.SampleRatio) || math.IsInf(config.SampleRatio, 0) || config.SampleRatio < 0 || config.SampleRatio > 1 {
		return nil, errors.New("trace sample ratio must be between zero and one")
	}
	if len(config.ServiceVersion) > 64 || strings.ContainsAny(config.ServiceVersion, "\r\n\t") {
		return nil, errors.New("invalid telemetry service version")
	}
	r := &Runtime{logger: config.Logger, registry: prometheus.NewRegistry(), routes: map[string]struct{}{
		"/healthz": {}, "/readyz": {}, "/auth/gitea/callback": {}, "web": {}, "not_found": {},
	}}
	services := golfv1.File_golf_v1_golf_proto.Services()
	for i := 0; i < services.Len(); i++ {
		service := services.Get(i)
		for j := 0; j < service.Methods().Len(); j++ {
			r.routes["/rpc/"+string(service.FullName())+"/"+string(service.Methods().Get(j).Name())] = struct{}{}
		}
	}
	r.requests = prometheus.NewCounterVec(prometheus.CounterOpts{Name: "golf_http_requests_total", Help: "Completed Golf HTTP requests by bounded route and transport status."}, []string{"method", "route", "status"})
	r.duration = prometheus.NewHistogramVec(prometheus.HistogramOpts{Name: "golf_http_request_duration_seconds", Help: "Golf HTTP handler duration in seconds."}, []string{"method", "route", "status"})
	r.gitea = prometheus.NewCounterVec(prometheus.CounterOpts{Name: "golf_gitea_requests_total", Help: "Gitea HTTP round trips by method and transport status."}, []string{"method", "status"})
	r.giteaTime = prometheus.NewHistogramVec(prometheus.HistogramOpts{Name: "golf_gitea_request_duration_seconds", Help: "Gitea HTTP round-trip duration through response headers, excluding body consumption."}, []string{"method", "status"})
	r.queries = prometheus.NewCounterVec(prometheus.CounterOpts{Name: "golf_database_queries_total", Help: "PostgreSQL operations by bounded SQL verb and outcome."}, []string{"operation", "outcome"})
	r.queryTime = prometheus.NewHistogramVec(prometheus.HistogramOpts{Name: "golf_database_query_duration_seconds", Help: "PostgreSQL operation duration in seconds."}, []string{"operation", "outcome"})
	r.exports = prometheus.NewCounterVec(prometheus.CounterOpts{Name: "golf_telemetry_trace_exports_total", Help: "Trace export batches acknowledged successfully or lost to an export failure."}, []string{"outcome"})
	r.registry.MustRegister(r.requests, r.duration, r.gitea, r.giteaTime, r.queries, r.queryTime, r.exports)
	r.tracer = noop.NewTracerProvider().Tracer("golf")
	if config.OTLPEndpoint == "" {
		if config.OTLPInsecure {
			return nil, errors.New("insecure trace export requires an endpoint")
		}
		return r, nil
	}
	endpoint, err := validatedEndpoint(config.OTLPEndpoint, config.OTLPInsecure)
	if err != nil {
		return nil, err
	}
	// The official SDK reads and logs malformed ambient configuration before
	// applying explicit options. Reject overrides without printing their values,
	// rather than modifying process environment or a global OTel logger.
	for _, variable := range os.Environ() {
		name, value, _ := strings.Cut(variable, "=")
		if strings.HasPrefix(name, "OTEL_") && value != "" {
			return nil, errors.New("ambient OTEL settings are unsupported; configure Golf telemetry explicitly")
		}
	}
	r.transport = &http.Transport{TLSClientConfig: &tls.Config{MinVersion: tls.VersionTLS12}, MaxIdleConns: 2, MaxIdleConnsPerHost: 2, IdleConnTimeout: 30 * time.Second}
	client := &http.Client{Transport: r.transport, Timeout: 3 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error {
		return http.ErrUseLastResponse
	}}
	exporter, err := otlptracehttp.New(ctx, otlptracehttp.WithEndpointURL(endpoint), otlptracehttp.WithHTTPClient(client),
		otlptracehttp.WithHeaders(map[string]string{}), otlptracehttp.WithEncoding(otlptracehttp.EncodingProtobuf),
		otlptracehttp.WithCompression(otlptracehttp.NoCompression), otlptracehttp.WithRetry(otlptracehttp.RetryConfig{Enabled: false}),
		otlptracehttp.WithTimeout(3*time.Second), otlptracehttp.WithMaxRequestSize(1<<20), otlptracehttp.WithMaxResponseSize(64<<10))
	if err != nil {
		r.transport.CloseIdleConnections()
		return nil, errors.New("could not configure trace export")
	}
	version := config.ServiceVersion
	if version == "" {
		version = "development"
	}
	r.provider = sdktrace.NewTracerProvider(
		sdktrace.WithResource(resource.NewSchemaless(attribute.String("service.name", "golf"), attribute.String("service.version", version))),
		sdktrace.WithSampler(sdktrace.ParentBased(sdktrace.TraceIDRatioBased(config.SampleRatio))),
		sdktrace.WithBatcher(&safeExporter{exporter: exporter, runtime: r}, sdktrace.WithMaxQueueSize(256), sdktrace.WithMaxExportBatchSize(64),
			sdktrace.WithBatchTimeout(time.Second), sdktrace.WithExportTimeout(3*time.Second)),
	)
	r.tracer = r.provider.Tracer("github.com/mjtechguy/golf-git/internal/telemetry")
	return r, nil
}

func validatedEndpoint(value string, insecure bool) (string, error) {
	u, err := url.Parse(value)
	if err != nil || len(value) > 2048 || u.Host == "" || u.User != nil || u.RawQuery != "" || u.ForceQuery || u.Fragment != "" ||
		(u.Scheme != "https" && u.Scheme != "http") || (u.Scheme == "http" && !insecure) {
		return "", errors.New("trace endpoint must be HTTP(S) without credentials, query or fragment; HTTP requires explicit insecure configuration")
	}
	if u.Path == "" || u.Path == "/" {
		u.Path = "/v1/traces"
	}
	return u.String(), nil
}

func (r *Runtime) Shutdown(ctx context.Context) error {
	if r == nil || r.provider == nil {
		return nil
	}
	err := r.provider.Shutdown(ctx)
	r.transport.CloseIdleConnections()
	if err != nil {
		return errors.New("trace shutdown did not complete")
	}
	return nil
}

// MetricsHandler has no authentication; only mount it behind the server
// operator's separate authenticated listener, never on the public application.
func (r *Runtime) MetricsHandler() http.Handler {
	return promhttp.HandlerFor(r.registry, promhttp.HandlerOpts{EnableOpenMetrics: true, Timeout: 5 * time.Second})
}

type Request struct {
	ID, TraceID string
	runtime     *Runtime
	span        trace.Span
	method      string
	route       string
	started     time.Time
	once        sync.Once
}

func (r *Runtime) StartRequest(ctx context.Context, method, route string) (context.Context, *Request) {
	method = boundedMethod(method)
	if _, known := r.routes[route]; !known {
		route = "not_found"
	}
	var id [16]byte
	_, _ = rand.Read(id[:])
	request := &Request{ID: hex.EncodeToString(id[:]), runtime: r, method: method, route: route, started: time.Now()}
	// External trace IDs, sampling flags and baggage are not trusted inputs to
	// this initial boundary. Child provider/SQL spans share this fresh root.
	ctx, request.span = r.tracer.Start(ctx, "HTTP "+route, trace.WithNewRoot(), trace.WithSpanKind(trace.SpanKindServer),
		trace.WithAttributes(attribute.String("http.request.method", method), attribute.String("http.route", route), attribute.String("golf.request_id", request.ID)))
	if id := request.span.SpanContext().TraceID(); id.IsValid() {
		request.TraceID = id.String()
	}
	return ctx, request
}

// End records the observed HTTP status. Zero means no response was committed
// before abort; a failure after committed headers retains its committed status.
func (request *Request) End(status int) {
	request.once.Do(func() {
		status, label := boundedStatus(status)
		elapsed := time.Since(request.started).Seconds()
		r := request.runtime
		r.requests.WithLabelValues(request.method, request.route, label).Inc()
		r.duration.WithLabelValues(request.method, request.route, label).Observe(elapsed)
		request.span.SetAttributes(attribute.Int("http.response.status_code", status))
		if status == 0 || status >= 500 {
			request.span.SetStatus(codes.Error, "HTTP request failed")
		}
		request.span.End()
		event := r.logger.Info().Str("request_id", request.ID).Str("method", request.method).Str("route", request.route).Int("status", status).Float64("duration_seconds", elapsed)
		if request.TraceID != "" {
			event.Str("trace_id", request.TraceID).Str("span_id", request.span.SpanContext().SpanID().String())
		}
		event.Msg("http.request")
	})
}

func boundedMethod(value string) string {
	switch value {
	case "GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS", "CONNECT", "TRACE":
		return value
	default:
		return "OTHER"
	}
}

func boundedStatus(status int) (int, string) {
	if status < 100 || status > 599 {
		return 0, "aborted"
	}
	return status, strconv.Itoa(status)
}

type safeExporter struct {
	exporter sdktrace.SpanExporter
	runtime  *Runtime
	stopped  atomic.Bool
}

func (e *safeExporter) ExportSpans(ctx context.Context, spans []sdktrace.ReadOnlySpan) error {
	if err := e.exporter.ExportSpans(ctx, spans); err != nil {
		e.runtime.exports.WithLabelValues("error").Inc()
		e.runtime.logger.Error().Msg("trace export failed; batch may be lost")
		// BSP forwards errors to the global OTel error handler. Best-effort
		// export failures are represented by our fixed log and metric instead.
		return nil
	}
	e.runtime.exports.WithLabelValues("success").Inc()
	return nil
}

func (e *safeExporter) Shutdown(ctx context.Context) error {
	if e.stopped.Swap(true) {
		return nil
	}
	if err := e.exporter.Shutdown(ctx); err != nil {
		return errors.New("trace exporter shutdown failed")
	}
	return nil
}
