# ADR-0006: Private injected telemetry and an optional local stack

Status: accepted for the current API/provider/database increment, 2026-10-02.

## Context

The adopted technology guide requires correlated zerolog logs, OpenTelemetry traces, Prometheus metrics, native pgx instrumentation and a reproducible observability environment. Its complete development stack prescribes Grafana/Prometheus/Tempo/Loki. Golf's canonical minimal Docker installation currently has three services and its offline recovery proof is scoped to those services. Jobs and runner execution do not exist yet.

## Decision

Inject a runtime at the executable composition root. It owns its logger, trace provider/exporter and Prometheus registry; attach its query tracer to the actual database/sql pgx connection configuration. One native query callback records both bounded metrics and a child span. No global defaults or unused secondary pool are installed.

Keep metrics off by default and serve them only through a separate bearer-authenticated listener. Never place repository, tenant, source, request IDs or raw provider paths in metric labels. Export only fixed route/method/status and SQL-verb categories. Generate request IDs locally; do not trust arbitrary incoming trace or baggage headers.

Keep the optional monitoring environment in a separate Compose overlay. Use Jaeger's native OTLP/HTTP ingestion and trace-query interface with Prometheus and Grafana to make the API→provider/database proof directly inspectable. This is an explicit deviation from the guide's Tempo/Loki stack: it supplies tracing and dashboard verification with fewer supporting services, but does not implement centralized log retention/search. JSON stderr collection remains the operator's responsibility; add a log collector when its storage/access/retention requirements are selected. The original full-stack obligation remains tracked in TG-05.6, rather than being called fully satisfied.

Use the official exporter behind a small sanitized failure boundary because its SDK otherwise invokes a process-global raw error handler. Reject ambient `OTEL_*` overrides when export is enabled to prevent environment parsing diagnostics from echoing values. Export is best effort and bounded; fixed diagnostics and an export-failure metric expose delivery failure without blocking application requests.

## Consequences and checks

The portable core remains usable without a monitoring stack or cloud. The optional overlay does not extend the recovery operator's qualified topology. Its temporary dashboards/traces are disposable development evidence.

Tests must cover private listener authentication, unknown-input cardinality, separate runtime isolation, failure/panic privacy and native pgx attachment. The monitoring proof must demonstrate real provider/database child spans in the request trace, scrapes and provisioned dashboards. Do not claim job handoff tracing, full guide compliance, production SLOs, durable telemetry or cross-service incoming propagation from this increment. See [observability contract](../OBSERVABILITY.md) and [implementation ledger](../IMPLEMENTATION_STATUS.md).
