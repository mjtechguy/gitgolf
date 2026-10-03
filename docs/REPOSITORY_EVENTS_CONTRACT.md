# Native repository push-event intake

Golf can authenticate and durably record bounded Gitea push deliveries for explicitly configured repositories. This portable foundation has no Cloudflare dependency. Every recorded event has `state=RECORDED` and `execution_state=UNAVAILABLE`: the receipt projection alone does not authorize execution. Separately enabled [automatic push admission](PUSH_AUTOMATION_CONTRACT.md) records its own grant-bound decisions; agent tasks and trusted merge evidence remain separate gates.

## Operator configuration

`GOLF_REPOSITORY_EVENT_CONNECTIONS` is an optional JSON array, read at startup. Empty or `[]` disables intake. A connection contains:

```json
[
  {
    "id": "46e3f1d3-3c06-4fb2-82c3-91ce5d739c11",
    "repositoryId": "101",
    "ownerId": "42",
    "repository": "owner/repository",
    "secret": "REPLACE_WITH_A_DISTINCT_RANDOM_SECRET"
  }
]
```

The example is a shape, not a usable credential. Generate a distinct random signing secret for each connection, for example `openssl rand -hex 32`, and supply it through the deployment's private environment/secret mechanism. Secrets must contain 32–256 ASCII letters, digits, `_` or `-`. The JSON is limited to 128 KiB and 128 entries. Connection IDs must be canonical nonzero UUIDs; repository and owner IDs must be canonical positive signed-int64 decimal strings. Duplicate connection IDs, repository IDs or secrets in the active configuration are rejected. Unknown or duplicate configuration fields fail validation.

Obtain the native IDs and exact `owner/repository` name through a currently authorized supported native API. Configure a **repository-level Gitea hook**, JSON content type, POST, Push events, with the exact secret and target `https://<Golf-origin>/hooks/gitea/<connection-id>`. Golf does not automatically provision or modify native hooks. Organization, user and system hooks are outside this initial intake. No native database, repository files or refs are modified.

The startup configuration is validated before opening PostgreSQL, then immutable connection rows are registered transactionally when the real database-backed server starts. The database records configured forge URL, native repository/owner IDs and exact repository name; it never stores the signing secret. A connection ID cannot be rebound, even across a restart. Rename, transfer or a changed configured forge requires a new connection ID and explicit hook/configuration updates. Removed connections stop being accepted by new processes; their historical records remain.

Secret changes are process configuration, not a distributed revocation epoch. Drain old processes and in-flight webhook requests before claiming the old secret or removed connection is no longer accepted. Restarted processes can use a new secret for the same immutable binding without losing delivery deduplication. Mixed configurations across live replicas do not provide immediate revocation or hot reload.

## HTTP boundary

`POST /hooks/gitea/{connectionID}` uses the native protocol, not browser cookies or a Connect procedure. Required single-valued headers are `Content-Type`, `X-Gitea-Delivery`, `X-Gitea-Event`, `X-Gitea-Event-Type`, `X-Gitea-Signature`, and `X-Gitea-Hook-Installation-Target-Type`. The native values must describe `push`, `push` and `repository`, respectively; the delivery ID must be a canonical nonzero UUID. Compatibility signature/header aliases do not substitute for the native headers.

Golf verifies `X-Gitea-Signature`, a lowercase 64-character hex HMAC-SHA256 of the **exact raw body**, using constant-time comparison before JSON interpretation. That matches the [pinned Gitea delivery implementation](https://github.com/go-gitea/gitea/blob/v1.27.3/services/webhook/deliver.go#L90) and [official webhook documentation](https://docs.gitea.com/usage/webhooks). No secret in a JSON field is trusted.

The endpoint accepts JSON with absent charset or UTF-8 charset only. It rejects content encodings, cookies, Authorization headers, query strings and noncanonical encoded path aliases. The body limit is 1 MiB; aggregate parsed header names/values/Host are limited to 16 KiB and 64 header names. JSON must be valid UTF-8, contain one value, have no duplicate object keys, stay within depth 32 and 65,536 tokens, and decode to the bounded push projection. Other native payload fields are ignored after these checks.

The signed body must match the configured repository ID, owner ID, exact full name and corresponding owner-login/repository-name pair. It must have a positive native sender ID, a valid full `refs/heads/...` or `refs/tags/...` name, and same-length lowercase 40- or 64-hex before/after object IDs. Zero-before creation and zero-after deletion are accepted, but both cannot be zero. These are authenticated **reported observations**, not independent object existence, branch freshness, current membership or actor-authority checks. Payload URLs are never followed.

## Durable acknowledgment and privacy

`golf_repository_event_connections` retains the immutable connection binding. `golf_repository_events` retains a compact projection: opaque row ID, connection ID, native delivery UUID, raw-body SHA256/byte count, event type, ref, before/after IDs, sender ID, database receive time and the fixed receipt/execution states. Raw JSON, commit messages, file lists, sender email, arbitrary URLs, signatures and secrets are discarded. Ref names and object/identity metadata are still private repository information; any separate ledger API must authorize current native access before exposing them.

The unique key is `(connection_id, delivery_id)`. A first delivery returns **202** with only `{"status":"recorded","execution":"unavailable"}` after PostgreSQL commits. An identical raw-body digest for the same key returns **204**, including after restart. A different digest for the same key returns **409** without modifying the original row. Concurrent identical deliveries produce one row. Insertion or commit failure returns **503** and never acknowledges durable success. A lost response can be retried with the original delivery ID and exact body.

Other failures return a generic `{"status":"rejected"}` without resource IDs, private payloads, signatures or diagnostic SQL. Unknown/disabled connections return 404; malformed input or ambiguous headers 400; invalid signatures 401; body limits 413; media types 415; header limits 431. Responses are `Cache-Control: no-store`. Standard telemetry must use a bounded fixed route label and must not log dynamic webhook paths, header values or bodies.

Both tables have append-only SQL guards, with guarded migration downgrade once bindings/history exist. A database owner can alter those guards; this is not cryptographic or WORM assurance. Retention, archival/export and bounded total-storage policy remain open. Per-request bounds do not limit the number of receipts an authorized sender can submit.

## Replay and execution limits

Gitea signs the body, not its delivery/event headers, and provides no signed timestamp for this contract. A captured valid body can therefore be submitted with a new delivery UUID and recorded again. Exact-key deduplication is **not** a cryptographic freshness or universal replay guarantee. Reordered deliveries remain separate observations; Golf does not treat receipt order as current branch order or reconstruct gaps. Native hook test deliveries can also have identical before/after IDs and are receipt evidence only.

Automatic CI execution needs a separately qualified durable execution principal, encrypted scoped native authority, revocation/transfer handling, event/workflow policy and immutable source verification at dispatch. The current manual runner is bound to an initiating session; silently reusing that session or treating `sender.id` as a principal would be incorrect. Queue/outbox processing, retries/reconciliation, schedules, pull-request/fork trust and external-provider normalization remain separate gates. Post-push intake cannot reject an already accepted Git write or close the protected-publication gate.

## Qualification

`go test -race ./internal/server -run '^TestRepositoryEvent' -count=1 -timeout 120s` covers bounded configuration and HTTP/JSON failures. With `GOLF_TEST_DATABASE_URL`, it additionally uses isolated real-PostgreSQL schemas for concurrent deduplication, restart/secret rotation, exact-payload conflicts, connection scope/rebinding, append-only guards, failed configuration rollback and forced insertion/deferred-commit failures. Database tests skip without the DSN.

The real-PostgreSQL race run passed all six test groups. The complete native drill also passed:

```sh
python3 scripts/repository-events-smoke.py \
  --image sha256:798e232c939a4d07815ef22c8c63bed7a7772416508883399d5c77a7537f7052
```

The script starts a fresh three-service Compose core with Gitea 1.27.3 and an ordinary private-repository owner. Supported hook APIs configure the fixture; two actual Git pushes produce native HMAC-signed deliveries accepted with 202. It verifies exact repository/owner IDs, ref and before/after commit IDs, then restarts Golf and replays the first captured delivery unchanged: 204 with no new row. Signed different payload under the original delivery ID returns 409; invalid signature, mismatched repository/owner and unknown connection fail. The compact ledger and Golf logs contain no source text, commit email or fixture credentials. No workflow run is created. Removing the active connection returns 404 while its two historical receipts remain.

The pinned [REST routes](https://github.com/go-gitea/gitea/blob/v1.27.3/routers/api/v1/api.go#L1181) expose hook management and test delivery but no delivery-list/redelivery endpoint. A bounded private-memory fixture recorder verifies the native HMAC and forwards the exact body and required native headers to Golf. The later replay is a **fixture transport replay**, not evidence of a Gitea redelivery API or production relay. The qualified callback uses Docker Desktop's `host.docker.internal` host bridge; the fixture changes the native callback allowlist only inside its disposable Gitea instance. It verifies removal of all fixture containers, volumes, network, recorder and private temporary Git/configuration afterward. Normal services and their accounts are untouched. No cross-provider event mapping, multi-replica secret cutover or automatic execution is qualified by this drill.

Schema021 adds an immutable connection/payload SHA-256 canonical ledger because delivery headers are unsigned. Same signed bodies under new delivery UUIDs return204 and do not append receipts. The ledger snapshots the admission flag so enabling later cannot replay disabled intake; existing receipts backfill ineligible. The prior receipt `execution_state` remains its immutable intake-era projection; consult materialization/run provenance for actual admission.
