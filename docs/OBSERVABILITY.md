# Golf observability

Golf's shared Go service has an injected, per-process telemetry runtime. Cloudflare and AI are not required. The runtime uses zerolog JSON completion logs, OpenTelemetry OTLP/HTTP traces and an independent Prometheus registry. It does not change global loggers, trace providers or metric registries.

## Configuration

| Environment variable | Default | Meaning |
| --- | --- | --- |
| `GOLF_METRICS_ADDR` | empty | Disabled unless explicitly enabled. Separate TCP listener, e.g. `127.0.0.1:9090` on a host or `:9090` inside a restricted container. |
| `GOLF_METRICS_TOKEN` | empty | Required whenever metrics are enabled: 32–256 printable ASCII bytes without spaces. Owner-managed secret, separate from user/provider credentials. |
| `GOLF_OTLP_HTTP_ENDPOINT` | empty | Empty disables trace export. HTTP(S) collector origin or explicit trace endpoint path; no credentials, query or fragment. Origins append `/v1/traces`. |
| `GOLF_OTLP_INSECURE` | false | Explicit `true` required for plaintext HTTP collector transport. Use HTTPS outside a trusted private development network. |
| `GOLF_TRACE_SAMPLE_RATIO` | 0.1 | Finite number from zero to one. Local proof uses one; choose production sampling for volume and cost. |

With export enabled, ambient `OTEL_*` environment overrides are rejected before creating the official exporter. Configure telemetry through the Golf variables above. This prevents the exporter's environment diagnostics from echoing malformed private values and keeps each runtime's configuration explicit.

Every enabled listener is bound before serving. A failed private bind fails startup; listeners close during bounded graceful shutdown. `/metrics` is available only on the separate listener with a single `Authorization: Bearer …` header. Query tokens, duplicate credentials and other methods are rejected. Golf's public API listener does not expose the metrics handler. A configured Kubernetes or reverse proxy must preserve this separation.

## Data boundary

Each HTTP request gets a fresh server-generated `X-Request-ID`. Caller-supplied correlation headers do not choose Golf's request or trace identity. When recording traces, request completion logs include their trace/span IDs. Logs and metrics use fixed known API procedure/route categories and bounded HTTP methods/statuses.

API server spans contain native Forgejo HTTP client and PostgreSQL query child spans when those calls occur. PostgreSQL operations are classified by a bounded SQL verb; statements and arguments are omitted. Provider instrumentation omits endpoint paths, query strings, headers, bodies and raw errors. There is no propagation of arbitrary incoming baggage or repository identity into telemetry.

Excluded data includes provider tokens, cookies, OAuth state/verifiers, encrypted session values, source/issue text, repository/user names, SQL statements/arguments and DSNs. HTTP panic/transport diagnostics use fixed messages without panic values or stack dumps. These constraints apply to Golf telemetry; independently operated Forgejo/PostgreSQL/collector logs need their own policies.

Telemetry is best effort. Export failures produce a fixed diagnostic and a bounded failure counter; they do not fail authorized application operations or emit the collector's raw error. Sampling, a full queue, collector outage or shutdown can lose traces. Metrics and logs are not the durable security audit journal or evidence for a protected write.

## Optional local stack

The separate `deploy/compose/compose.observability.yaml` overlay adds Jaeger, Prometheus and Grafana to the development installation. Its provisioned Grafana metrics dashboard shows request/provider/database rates and latencies, response statuses and trace-export failures. Inspect traces in the separate Jaeger UI; the latest pinned Grafana/Jaeger pair did not qualify a Jaeger datasource, so that unsupported integration is omitted. Use the overlay's operator instructions for secrets, ports and lifecycle.

The ordinary three-service Docker profile remains unchanged. The offline recovery operator qualifies only that canonical profile; adding monitoring services does not establish backup/restore coverage for the expanded topology. Collector/dashboard data is disposable development data, not durable recovery evidence.

## Kubernetes

The Helm chart can enable `observability.metrics.enabled`, referencing `GOLF_METRICS_TOKEN` in its precreated Secret. It adds a ClusterIP metrics port and only grants network-policy access to `observability.metrics.ingressFrom` peers. When NetworkPolicy is enabled, an empty peer list grants no metrics ingress. Public ingress continues to target the application port.

Set `observability.tracing.endpoint`, `insecure` and `sampleRatio` for an external collector. With network policies enabled, provide explicit `networkPolicy.externalEgress` rules for that collector. The chart does not install an observability operator, collector, Grafana, CRDs or cloud service. Its rendering checks do not qualify cluster scraping or OTLP delivery.

## Implementation boundary

This increment covers current API, provider and database paths. Golf has no job/runner execution engine yet, so it cannot qualify API-to-job traces, worker queue metrics or runner dashboards. Full P1.7 acceptance, fleet/load SLOs, retention/access controls, alerts, cloud export and production operational qualification remain open.

Primary references: [OpenTelemetry Go exporters](https://opentelemetry.io/docs/languages/go/exporters/), [pgx database/sql integration](https://pkg.go.dev/github.com/jackc/pgx/v5/stdlib), [Prometheus client library](https://github.com/prometheus/client_golang), [zerolog](https://github.com/rs/zerolog).
