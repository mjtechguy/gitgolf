# Golf Operations dashboard

The integrated Golf page at `/admin/operations` shows connected services, health observations and overall metrics. It uses the same frontend, fonts, tables and Connect RPC in local, Docker, Kubernetes, Cloudflare bridge and Cloudflare-native profiles. There is no Grafana deployment in Cloudflare and no mandatory monitoring stack to open this page.

The page is read-only. It never allocates resources, queries arbitrary URLs or exposes credentials. Tables search/sort their loaded snapshot. Visible pages refresh every 30 seconds; hidden pages stop polling. A refresh rechecks authority; failed authorization removes the previous private snapshot. Sign-out and unmount cancel in-flight reads.

## Authorization and scope

Portable profiles require a current, operator-enrolled Golf administrator password session. A Forgejo administrator, personal provider token or delegated API token does not acquire instance administration. Authority is checked again after dependency/metrics collection.

Native installations require current Cloudflare Access identity, an active Golf user and an active `operations_admins` record in their native D1 partition. Repository creation permission, repository administrator grants and ordinary Git bearer credentials never acquire operational authority. The API rechecks both the role and its current email-to-user mapping before returning data. The shared administration flag exposes the portal, but its native scope is explicitly the single installed workspace, not every SaaS tenant or the Cloudflare account.

Organization drilldown and scoped machine operations credentials are not implemented. Do not expose this RPC to a broader identity through a proxy or a reusable Git credential.

## Observation states

| State | Meaning |
| --- | --- |
| available | The stated operation/observation succeeded at its timestamp; read probes do not prove writes or provider-wide availability. |
| observed | A completed workload or verified output records successful service activity at its timestamp. This is historical evidence, not a current provider health probe. |
| configured | A binding, connection or policy is present. No successful probe is asserted. |
| disabled | The installation has not enabled/bound this consumer. |
| degraded | A recorded attempt failed, has pending work, is running without completion, or its successful observation is too old. |
| unknown | No sufficient observation exists. Numeric values are omitted. |
| unavailable | This metric is not collected by the current implementation. |

Each row identifies its data source and observation time. Provider usage may arrive late. Historic successful values can remain visible beside a degraded collector status; their timestamp/window continues to describe the last successful observation. An empty provider dataset is never interpreted as zero traffic. Real observed zero counts remain zero.

Native snapshots use one fixed D1 batch for inventory aggregates. Completed evidence deliveries, test/agent executions, AI advice, ready managed previews and verified browser captures supply historical activity for their corresponding services. Current Access admission is observed from the authenticated administrator request. A configured binding without this evidence remains configured; storage totals and billing remain unknown until their collectors exist.

## Portable setup: local, Docker and Kubernetes

The Operations RPC is included in the ordinary Golf Go backend; deploy the matching generated contracts/frontend. Existing administrator enrollment applies. Telemetry uses the injected process registry and does not require scraping, Prometheus or Grafana to serve the page.

It shows PostgreSQL/Forgejo readiness, process metrics and telemetry configuration, plus configured object storage, enrolled runners, managed execution, Access bridge and preview runtime. Configuration rows do not establish successful jobs or provider access. Dependency probes have a three-second collection deadline and authority is checked after the wait.

Available process metrics include HTTP requests/transport server errors, Forgejo requests, database queries, failed trace-export batches and approximate p50/p95/p99 durations for HTTP handlers, database operations and Forgejo response headers. Counters and histogram estimates cover this process since start. They are not a fleet-wide rolling window, browser navigation timing, database billing or proof of protected mutation success. Empty metric families remain unknown.

The optional Docker monitoring overlay remains separately documented in `deploy/observability/README.md`; it can provide the existing Grafana dashboard and Jaeger UI. Kubernetes can expose the protected metrics listener and send traces to an external collector using Helm's existing observability settings. The chart does not install a collector, Grafana or CRDs. This source increment does not claim live Kubernetes scraper qualification.

## Cloudflare-native fresh setup

Use the separate `scripts/cloudflare_forge.py` setup flow from `CLOUDFLARE_NATIVE_SETUP.md`, with Access audience and verified owner email. Fresh bootstrap explicitly enrolls the configured owner in `operations_admins`. The setup script prepares private configuration/bootstrap SQL and provisions nothing itself. A bearer-only installation has no human operations login until Access identity is configured.

Optional additional setup arguments:

```text
--operations-service-health
--operations-analytics-store APPROVED_SECRET_STORE_ID
--operations-analytics-name APPROVED_ANALYTICS_READ_SECRET_NAME
--operations-observability
--operations-sampling 0.1
--evidence-dead-letter-queue EXISTING_SEPARATE_FAILURE_QUEUE
```

Service probes use existing Artifacts and R2 bindings, with no management token. Worker analytics requires a separate account-scoped Analytics Read token in an approved Secrets Store entry. Pass only the store ID and secret name, never a token value. Do not reuse the preview provisioner's broader management token. Provider eligibility and actual permissions require live qualification independently of a successful source build.

The failure queue is an explicitly existing operator-owned queue, distinct from the main evidence queue. The native builder adds its consumer and connects it as the evidence consumer's dead-letter destination. It does not create that queue or transfer ownership. Record its lifecycle with the operator installation; a disposable demo must not silently acquire ownership of a pre-existing queue. Without this allocation, failed-delivery retention is disabled.

The equivalent private `forge.json` settings are:

```json
{
  "operations": {
    "service_health": true,
    "analytics_secret": {
      "store": "APPROVED_32_HEX_STORE_ID",
      "name": "golf-analytics-read"
    },
    "observability": {
      "enabled": true,
      "sampling": 0.1
    }
  }
}
```

The example is a configuration shape; replace the placeholder with the actual approved store ID. Flags and source configuration validate unknown fields, canonical secret references and sampling from zero through 0.1. All optional consumers are disabled by default. The native dashboard itself requires no analytics credential.

## Existing native installation upgrade

1. Build matching portable/native frontend assets and prepare the native bundle/release manifest.
2. Apply the additive `cloudflare/forge/migrations/0010_operations.sql` using the existing native release operator's `migrate` action. Never apply it to PostgreSQL/Forgejo.
3. Read back the new tables and reviewed indexes. The release operator checks the new schema before rollout; it does not roll back the database.
4. Enroll the intended existing native user's immutable numeric ID in `operations_admins`, after independently verifying their active Access email/user mapping. Existing `can_create` values and repository grants are deliberately not converted into administration.
5. Deploy through the guarded release flow, read back the served release/schema and verify Access admission, ordinary-user denial and role revocation.
6. Open `/admin/operations` through the installed public hostname. Inspect sources, timestamps and collector outcomes before declaring services healthy.

Native administrator enrollment is an explicit operator action in Golf's D1 partition. After verifying the intended user's ID, use a parameterized operator query equivalent to:

```sql
INSERT INTO operations_admins(user_id,active) VALUES(?,1)
ON CONFLICT(user_id) DO UPDATE SET active=1;
```

Revocation sets `active=0` for that exact ID. Do not authorize account administration from a username supplied by a browser or write Forgejo's database. The live setup/upgrade is not performed by this source increment; the old disposable demo remains stopped.

## Native inventory and provider observations

| Measurement | Source and boundary |
| --- | --- |
| Active repositories | Current installed D1 partition, active rows. |
| Queued/running jobs | Evidence journal; running state is not an independent container probe. |
| Oldest queue age | Journal creation timestamp, zero when there is no queued backlog. |
| Retained report bytes | Sum of known journal report lengths; excludes other R2 objects and billing. |
| Preview bundle/capture bytes | Sum of unpurged preview bundle and capture journal lengths; excludes other R2 objects and billing. |
| Active previews | Current READY, unpurged, unexpired rows. |
| Cleanup backlog | Unpurged revoked/expired previews and expired allocations. |
| App resources not retired | Resource journal states, not an independent account-wide resource list. |
| Retained read indexes | READY, unexpired immutable index records. |
| Failed deliveries | Durable messages observed in the last seven days, not all provider failures. |
| Maintenance results | Last attempt, last success, outcome, known processed/pending counts. A stage failure leaves counts unknown. |
| Worker traffic | Optional background Workers adaptive Analytics query, constrained to the installed account and control Worker. |
| Artifacts read health | Optional info/read of one existing owned active repository, with namespace/remote verification. No source-body reads or repository creation. |
| R2 read health | Optional HEAD against a fixed absent probe key. A successful missing-object response proves the read binding responded; no object is created. |

Worker analytics polls at most once per ten minutes using an atomic D1 reservation. It queries a thirty-minute window ending five minutes before collection to allow ingestion lag. Requests, errors and subrequests remain provider analytics observations, not hard quota or billing authority. A failed, malformed, empty, truncated/grouped or mismatched response does not overwrite last successful values. Errors contain no raw provider response or secret.

Read health probes have the same ten-minute throttle. A successful probe older than twenty minutes is degraded. Artifacts with no existing active repository has no success claim. The provider table retains only fixed service identities and aggregate values; no email, repository name, prompts, source or credentials are returned in the dashboard.

Storage billing, D1 row/storage provider metrics, R2 total retained bytes, Artifacts capacity, container provider runtime and invoice/estimated spend are not yet collected. They remain explicit unknown/unavailable values. The $10/day testing envelope is not a provider billing cap.

## Managed logs

Optional Worker observability emits structured request ID, release, transport status and handler duration. Query strings are redacted and automatic invocation logs are disabled. Trace capture is disabled in this initial profile pending its own privacy/retention qualification. No repository names, paths, email, body, headers or credentials are included in Golf's request records.

This config uses Cloudflare's managed logging. It does not install Grafana, Prometheus, a collector or another always-running service. Container/preview Workers keep their separate existing observability defaults. Sampling and provider retention/usage remain operational configuration, not a complete production log guarantee.

## Hosted maintenance and failed deliveries

Hosted cron records separate CI intake, preview cleanup, evidence reconciliation and index retirement outcomes. Each stage continues even if another fails. Failed observations retain last success and omit unknown work counts. The dashboard reports stale maintenance after fifteen minutes.

The Cron Trigger is the schedule. The workspace Durable Object also keeps a five-minute alarm: when no scheduled run has reported in for ten minutes it runs the same stages and collectors itself, and it stands down as soon as a scheduled run reports in again. The journal does not record which of the two started a stage. An installation that receives no requests after a deploy has no workspace object in memory until the first one arrives, so the alarm is armed by that request.

Evidence reconciliation uses the existing original job/workflow identity and current user/grant/source policy. It does not replace a failed acknowledgement with another execution ID. Exhausted delivery attempts refuse an unstarted job; an already-started job remains governed by its execution deadline and current authority. Expired/revoked execution is stopped before terminal retirement.

An optional dead-letter consumer records the provider message ID and original known job ID before acknowledging. Redelivery is idempotent. Provider retry and message-retention limits still apply; a prolonged D1 outage can prevent inbox persistence. The original job journal remains the recovery authority. Unknown jobs and arbitrary bodies create no retained record. The consumer never starts an execution or publishes source. The existing reconciler remains the recovery authority. Up to one hundred expired failure observations are retired per evidence maintenance pass after seven days.

Whole-demo retirement, full partial-deletion recovery, orphaned provisioning and guarded admin replay controls remain separate open work in `CLOUDFLARE_ROBUSTNESS_OPERATIONS_PLAN.md`. Hosted preview expiry is not a claim that the entire demo can retire itself independently of the operator supervisor.

The disposable-demo launcher also requires an independent user-systemd stop timer before reporting `awaiting_login` or `ready`. The timer preserves the operator CLI path, waits thirty minutes for initial login, and resets to the approved four-hour window after readiness. `cloudflare_demo.py begin` first arms a bounded preparation deadline; failure to confirm the timer withholds the start request. This protects against a lost supervisor process, but still depends on the operator host and credentials. A Cloudflare-owned whole-allocation retirement controller remains open.

Demo activation renews the original static and Worker preview IDs instead of revoking and reprovisioning them. Both ready previews must exist before activation. Renewal rechecks current writer permission, canonical open PR source and policy; an atomic update requires the exact observed original expiry. A stale/replayed lease update is refused. The configured lifetime is capped at four hours and at any explicit demo deadline. Activation failure retains the prepared UI for a bounded thirty-minute repair window, records an error and requires a new explicit begin request. The release rehearsal qualifies lease renewal before asking for human login.

`cloudflare_demo.py stop ORIGINAL_PRIVATE_RECEIPT` signals only the recorded process identity. If that process is gone, the recovery tool checks current provider identities and owned storage inventory, journals each deletion before dispatch, and confirms absence. It can resume a missing bucket/database from its previously saved inventory. Static preview objects can be retired after their writers; managed Worker apps must already be purged with all app-resource journal entries deleted. Unknown allocations and changed identities stop recovery. Retained release assets and replaceable repository indexes are included in storage ownership; a failed bucket cleanup preserves D1 as recovery authority. Recovery credentials are short-lived, journaled by ID and explicitly revoked with readback.

The owned hosted launcher accepts `--operations-rehearsal` alongside its existing human-demo flags. Before asking for login it applies/checks schema10, retains and verifies reviewed assets, deploys the exact release, checks served diagnostics and asset bytes, denies machine Operations administration, rolls back to the recorded predecessor, and re-promotes the same reviewed version. A failed or uncertain deployment stays failed; automatic write replay is withheld. Read-only R2 retrieval retries only timeouts and explicit transient HTTP statuses, with a finite bound and private diagnostics.

## Verification

Source checks include generated contract consistency, native/portable builds, Go telemetry and PostgreSQL-backed authority/race tests, Node privacy/cache/provider/dead-letter tests, native CLI build-output validation and Python setup/release migration recovery tests. The local workerd check verifies Access identity mapping, native admin admission/revocation and real D1/DO/Queues/Workflows/R2 boundaries; provider API collection itself is source-tested with controlled responses.

The shared browser could not reach this environment's local high port, so visual browser acceptance remains open. No new hosted resources or real analytics token were provisioned for this increment. Record source checks and live evidence independently in `IMPLEMENTATION_STATUS.md`.

Provider references: [Workers Analytics query](https://developers.cloudflare.com/analytics/graphql-api/tutorials/querying-workers-metrics/), [Workers observability](https://developers.cloudflare.com/workers/observability/), [Queues dead letters](https://developers.cloudflare.com/queues/configuration/dead-letter-queues/).
