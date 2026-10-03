# Automatic branch-push shell CI

This is Golf's portable, opt-in automatic shell executor, not complete GitHub Actions or GitLab engine compatibility. AI and Cloudflare are optional. The retained development installation stays on qualified schema019 with push admission disabled while schema021 is qualified in disposable stacks.

## Enable explicitly

1. Configure a native repository hook and its immutable resource binding using [native event intake](REPOSITORY_EVENTS_CONTRACT.md). Use a distinct signing secret, supported native API and actual repository/owner IDs.
2. Enroll the dedicated Docker worker and approved exact image digests using [runner isolation](RUNNER_ISOLATION_CONTRACT.md). PostgreSQL owns durable coordination; RustFS/S3 or PostgreSQL stores the exact ordinary-source snapshot. No separate queue engine is required for this bounded slice.
3. Set `GOLF_PUSH_CI_ENABLED=true` in the private operator environment and recreate Golf. Startup refuses enabled admission without event connections and runner/image configuration. Compose supplies `false` by default. The flag is an admission switch: revoke grants or deny push policy to fence already admitted work.
4. Create an independent personal-PAT [automation grant](AUTOMATION_GRANTS_CONTRACT.md) with exact branches/workflow paths and expiry. Allow push execution at every applicable instance, organization and repository policy ceiling. Manual and push permission are independent; both default denied.
5. Wait at least seven seconds after grant creation before the first qualifying push. Push a supported configuration as the grant sponsor. Only exact allowlisted branch refs and nonzero after-commit IDs qualify. Tags, deletion, foreign senders, unsupported syntax and missing native evidence do not execute.

Restart the Compose worker after recreating Golf: its loopback transport shares Golf's private network namespace. `make local-up` already drains/recreates the worker in order. Recreating only Golf leaves the old worker namespace behind.

## Durable admission and replay

A raw-body HMAC authenticates the native payload; the delivery header is unsigned. Native redelivery generates another UUID, so Golf deduplicates **connection + signed payload SHA-256** in an immutable canonical-receipt ledger. Existing duplicate receipt history survives migration; only its earliest receipt is canonical.

The ledger snapshots whether admission was enabled **at receipt time**. Pre-upgrade receipts and receipts received while disabled remain ineligible when the switch is enabled later. A grant only selects canonical receipts after its creation and its exact branch/workflow scope. Saving policies never retries terminal decisions or historical work.

Schema 021 records one materialization per event/grant/path, including pinned grant revision, revocation epoch and credential version. Terminal states are admitted, blocked and skipped. A short PostgreSQL admission lock bounds pending preparation to 512 items; batches contain at most 20. Coordinators lease candidates with `FOR UPDATE SKIP LOCKED`; each process prepares one at a time. The lease lasts 90 seconds; preparation is bounded to 60 seconds. Only uncertain **read-only preparation** resumes after lease expiry, at most three attempts. Proven denials/nonmatching triggers stay terminal. No source-fetch or provider call holds a PostgreSQL row lock.

Before reading command/source content, Golf verifies delegated sponsor identity, immutable native repository/owner/type, current native permission, grant expiry/versions, local sponsor state and all push policy ceilings. It resolves exactly the event's after commit, verifies the exact workflow blob, compiles the supported push subset and normalizes the ordinary-source archive. Jobs get no native token, browser cookie or Git metadata. The private plan and source use existing approved image and object-storage bindings.

Immediately before admission, native authority is observed again. The final transaction locks sponsor, grant/credential and policy scopes, checks unchanged policy epochs and the current unexpired materialization lease, and atomically inserts the push-origin run and its admitted decision. A repository may have at most 64 queued/running runs when admitting another automatic run; excess decisions block with `repository_queue_capacity`. The native activity/grant/workflow uniqueness also prevents multiple payload representations of one native push from executing twice. A source uploaded before a later denial can remain an unreferenced immutable object; automatic object garbage collection is not yet implemented.

Worker poll, source, heartbeat, logs and finish retain the current grant/native/policy fences. Browser logout and backend restart do not revoke delegation. Grant revocation, expiry, local sponsor disable, native permission/resource changes or policy epoch changes fence work. Expired executed attempts become lost; Golf never assumes an ambiguous job is safe to replay.

## Independent native freshness evidence

Golf reads the supported native repository activities API using the delegated credential. Admission requires matching original `commit_repo` activity with the exact repository, full branch ref, sponsor actor and after-commit SHA. The recorded native activity ID is durable evidence; webhook receipt time and Git author dates are insufficient.

The initial slice is **sponsor-authored pushes only**, because private activity from another native user can be invisible to a personal PAT. Only the newest 100 activities (two pages of 50) are searched; missing/older/inaccessible evidence denies execution. Feed/page/content bounds and duplicate-key checks fail closed. HTTP Date must be within five seconds of Golf, and native activity must be later than grant creation plus the five-second margin; whole-second precision intentionally excludes early pushes. Golf, PostgreSQL and the native forge require synchronized, stable trusted clocks. A native-clock activation boundary and broader shared automation-account qualification remain future work.

Native1.27.3 has no supported public webhook-task/delivery-list API. Golf does not scrape internal pages or inspect the native database to prove freshness. See native sources: [push activity](https://github.com/go-gitea/gitea/blob/v1.27.3/services/feed/notifier.go), [visibility](https://github.com/go-gitea/gitea/blob/v1.27.3/models/activities/action.go), [body signature](https://github.com/go-gitea/gitea/blob/v1.27.3/services/webhook/deliver.go), [new UUID on replay](https://github.com/go-gitea/gitea/blob/v1.27.3/models/webhook/hooktask.go).

## Product surfaces and qualification

The existing workflow-run table includes typed manual/push origin; push details expose event ref/receipt/grant IDs to authorized repository viewers without secrets. Grant receipts say `requires_push_admission` when the operator switch is enabled, not that delegation alone authorizes execution. Status distinguishes disabled admission, degraded coordinator/worker and active coordinator/worker. Ready infrastructure does not override per-repository policy/grant/native checks. Detailed materialization history is currently operator SQL; an authorized product inventory remains to build.

Run the disposable qualification with locally built images:

```sh
python3 scripts/push-ci-smoke.py --image golf-push-automation:development --runner-image golf-runner:latest
```

It uses actual native Git/HMAC callbacks, RustFS and isolated Docker shell execution. It checks exact commit/blob/source, independent logout, queued and completed restarts, same-body/new-delivery-ID replay, running revocation, subsequent push denial, bounded executor cleanup and credential-safe diagnostics. Captured-body replay is not a claim of a native public redelivery API. PostgreSQL race checks additionally cover concurrent/SKIP LOCKED claims, stale leases, bounded preparation retries, disabled/historical exclusion and recovery quarantine.

Schema020/021 require stopped-writer coordinated upgrade; mixed binaries have incompatible manual uniqueness contracts. Schema 021 recovery cancels queued/leased preparation and revokes grants, but encrypted whole-stack restore with RustFS/automatic-origin history is **not qualified**. The recovery tool intentionally refuses these schema versions until the expanded drill passes. Keep the retained schema019 stack available.

Remaining limits: full provider engine syntax/matrix/remote actions, artifacts/cache/check attribution, production multi-tenant isolation, fair autoscaling/backpressure, Helm job execution, Cloudflare execution adapters and the five coding-agent harnesses are separate acceptance gates. PostgreSQL is the local coordination backend; Workflows/Queues remain optional qualified Cloudflare adapters under the same Golf authority model.
