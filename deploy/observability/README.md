# Optional local monitoring

This overlay adds a local Jaeger collector/query UI, Prometheus and Grafana to Golf's canonical three-service Compose installation. It instruments the existing HTTP API, Golf's Gitea client and PostgreSQL calls. It does not deploy jobs, runners, a log collector, alerts, a production monitoring service or Cloudflare infrastructure.

From the repository root, after preparing the normal `.env` and building Golf:

```sh
python3 deploy/observability/init.py
docker compose --env-file .env --env-file .tmp/observability/monitoring.env \
  -f compose.yaml -f compose.observability.yaml up -d --build
```

The initializer creates fresh random credentials and refuses to overwrite an existing directory. `.tmp/observability` is mode `0700`; `monitoring.env` is `0600`. Its two individual secret files are `0444` inside the private directory so the non-root container UIDs can read their read-only mounts. Do not move those files into a publicly traversable directory. Compose file secrets are local bind mounts, not encrypted secret storage; host/Docker administrators remain trusted. Do not print or share resolved `docker compose config`/container environment output. [Compose secrets semantics](https://docs.docker.com/reference/compose-file/services/#secrets).

| Interface | Local URL | Access / data |
| --- | --- | --- |
| Grafana | `http://localhost:3037/d/golf-local` | User `golf`; password stored in `.tmp/observability/grafana-password`. Anonymous access/sign-up disabled. |
| Jaeger | `http://localhost:16687` | Local unauthenticated trace UI; select service `golf`. |
| Prometheus | `http://localhost:9097` | Local unauthenticated query UI. |
| Golf metrics | Internal `golf:9090/metrics` | Not host-published. Requires the generated bearer token; Prometheus reads its private file. |
| OTLP HTTP | Internal `jaeger:4318/v1/traces` | Not host-published. This trusted local Compose network uses HTTP. |

All published monitoring ports bind to loopback. Other local users/processes and services on the Compose network can reach the unauthenticated Jaeger/Prometheus interfaces; this is a single-owner development profile, not tenant isolation or a production ingress policy. Keep these ports private. No Docker socket or privileged host mounts are provided to monitoring containers.

The overlay explicitly sets `GOLF_METRICS_ADDR=:9090`, `GOLF_METRICS_TOKEN`, `GOLF_OTLP_HTTP_ENDPOINT=http://jaeger:4318`, `GOLF_OTLP_INSECURE=true` and `GOLF_TRACE_SAMPLE_RATIO=1`. This profile samples all requests; the application default ratio outside the overlay is 0.1 when export is enabled. Remove ambient nonempty `OTEL_*` settings from the Golf process: enabled export rejects them rather than accepting hidden SDK overrides. Trace transport is best effort, bounded and independent of request completion; an export failure is a fixed log message and counter, not a request failure. Lost batches are not replayed indefinitely.

The provisioned **Golf local runtime** dashboard shows scrape reachability, request counts/errors, request latency, Gitea calls, PostgreSQL queries and trace-export results. Gitea duration ends at response headers; it does not measure subsequent body download. Use the Jaeger UI at `http://localhost:16687` for traces. The Grafana Jaeger datasource is not provisioned: its health check did not qualify against this pinned Jaeger release. Match `golf.request_id`/trace ID to Golf JSON logs. Routes and SQL verbs are bounded labels; repository names, identities, arbitrary paths, SQL statements/arguments, credentials and source bodies are excluded from Golf telemetry. HTTP status panels reflect transport status; a typed `OUTCOME_UNKNOWN` repository creation can legitimately return HTTP 200 and is not a measured successful mutation. Missing/empty metric series are not proof of zero failures. No SLO or availability certification is implied.

Jaeger retains at most 5,000 traces in memory and loses them on restart. Prometheus retention is limited to 24 hours and 256 MB of retained blocks (WAL/head data and filesystem usage add overhead); Grafana/Prometheus use their own named volumes. The containers have memory limits; these are modest developer defaults, not measured production capacity. No log aggregation or monitoring backup is configured.

To disable monitoring, stop its services, then recreate Golf with the ordinary core configuration so it no longer exports:

```sh
docker compose --env-file .env --env-file .tmp/observability/monitoring.env \
  -f compose.yaml -f compose.observability.yaml stop jaeger prometheus grafana
docker compose --env-file .env -f compose.yaml up -d --no-deps --force-recreate golf
docker compose --env-file .env --env-file .tmp/observability/monitoring.env \
  -f compose.yaml -f compose.observability.yaml rm -f jaeger prometheus grafana
```

These commands preserve application and monitoring volumes. Do **not** use `down --volumes` on the shared installation to remove monitoring: that also removes PostgreSQL/Gitea data. Changing Grafana's initial admin-password file does not reset the password already stored in its database; use Grafana's supported password management. Reuse existing initializer files to restart the same monitoring installation.

## Reproducible native qualification

```sh
docker build -t golf-local:observability .
python3 scripts/observability-smoke.py --image golf-local:observability
```

The proof uses a fresh randomly named six-service Compose project, private temporary credentials, random loopback ports and fresh native PostgreSQL/Gitea volumes. It never restarts the normal stack. It requires a locally available current Golf image; monitoring images may be pulled by immutable digest. It creates ordinary fixture users/repositories through supported Gitea CLI/API, exercises real Golf sign-in, durable creation, source browsing and private denial, then verifies:

- Metrics reject missing/incorrect bearer tokens, Prometheus actually scrapes them and the provisioned authenticated Grafana dashboard/datasources load.
- A source request's real Gitea client and PostgreSQL spans share its API parent; Golf logs correlate the same opaque request/trace IDs.
- Observed metric families and labels match the contract; fixture tokens, cookies, encryption/database secrets, usernames, repository/source paths/content and SQL fragments are absent from the collected Golf logs/traces/metrics. Caller trace IDs/baggage/request IDs cannot inject those values.
- Stopping only the isolated collector produces an export-error counter while native application reads remain usable; restarting it resumes successful exports.
- Fixture identities are purged and all isolated containers, volumes and network are removed.

This bounded proof checks actual local integration and canaries, not every possible sensitive value, load condition, exporter, architecture or Kubernetes telemetry deployment. Gitea/PostgreSQL internal server tracing is not enabled: dependency spans describe Golf's client calls. Provider logs are outside this Golf telemetry privacy claim. Background/job correlation remains unimplemented.

The full native drill passed on 2026-10-02 using Golf image `sha256:8ee648f2f7a3e81b8f884ffa90112bc0258b6805d1c9d18b26ca14ac47bbcdaa`, PostgreSQL 18.4, Gitea 1.27.3 and the monitoring pins below. It included collector outage/recovery and independent verification that the disposable project's containers, volumes and network were gone. This is local evidence, not a production performance or recovery guarantee.

## Pinned upstream components

Versions and multiarchitecture index digests were resolved on 2026-10-02 using `docker buildx imagetools inspect` and checked against official release/install sources. The complete immutable image references are in `compose.observability.yaml`.

| Component | Version | Primary source |
| --- | --- | --- |
| Jaeger | 2.21.0 | [Official container](https://www.jaegertracing.io/docs/2.21/getting-started/) and [pinned configuration source](https://github.com/jaegertracing/jaeger/blob/v2.21.0/cmd/jaeger/config.yaml) |
| Prometheus | 3.15.0 | [Official releases](https://prometheus.io/download/) and [scrape authorization configuration](https://prometheus.io/docs/prometheus/latest/configuration/configuration/) |
| Grafana OSS (`grafana/grafana`) | 13.2.3 | [Official download](https://grafana.com/grafana/download?platform=docker), [Docker images](https://grafana.com/docs/grafana/latest/setup-grafana/installation/docker/), [file secrets](https://grafana.com/docs/grafana/latest/setup-grafana/configure-docker/) and [provisioning](https://grafana.com/docs/grafana/latest/administration/provisioning/) |

The Jaeger config enables only its OTLP HTTP receiver, query UI and bounded memory store; optional AI/MCP, remote sampling, Zipkin, gRPC and profiling extensions are not enabled. Grafana plugins are not automatically installed, and outbound analytics/update checks are disabled. Upgrade a pinned component by reviewing its upstream changes and rerunning the actual native qualification.
