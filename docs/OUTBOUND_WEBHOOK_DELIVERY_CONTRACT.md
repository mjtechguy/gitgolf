# Outbound repository webhooks

This packet implements named, repository-scoped generic HTTP subscriptions, a PostgreSQL activity outbox, signed delivery workers and a managed-browser settings consumer. It is source-qualified in isolation; a retained-stack controlled receiver and actual served browser qualification are still required. It does not make the entire **Webhooks and notifications** settings section Ready. Email, semantic push/pipeline/deployment notifications, personal/organization/instance delivery preferences, Slack payload adapters, Cloudflare-specific delivery and operational retention remain separate acceptance work.

## Scope and current values

`/OWNER/REPO/settings/webhooks` lists saved subscriptions before any editor. Add/Edit opens a shared TanStack Form; inventories and paginated delivery history use the shared searchable/sortable DataTable and global CSS. Secret inputs disappear after saving, cancellation, uncertain acknowledgement or denied access. URL paths/query and signing keys are never returned, copied into browser storage or displayed in history; only destination host and credential-presence metadata are exposed.

`RepositoryWebhookService` has five managed-browser-only procedures:

| Procedure | Binding and result |
| --- | --- |
| `ListRepositoryWebhooks` | Exact current repository key, canonical positive signed-64 repository ID and native owner ID; paged subscription metadata and whether the current session has supported local-account background authorization. |
| `SaveRepositoryWebhook` | Canonical UUIDv4 subscription ID, canonical saved version (`0` for create), name, 1–4 distinct activity topics, optional replacement URL/key, enabled state and explicit background consent. Every accepted save creates a new immutable encrypted credential version and metadata audit record. |
| `ListRepositoryWebhookDeliveries` | Exact target and subscription UUID; paged delivery metadata, never payload, URL, credential or receiver response text. |
| `TestRepositoryWebhook` | Exact target, current subscription version and UUIDv4 operation ID; queues a synthetic `golf.webhook.test` event. It does not claim receiver acceptance. |
| `RedeliverRepositoryWebhook` | Exact target, original delivery UUID, current authorized subscription version and UUIDv4 operation ID; queues a new delivery preserving the original event ID and exact payload bytes. |

Repository/native-owner IDs stay decimal strings, including values above JavaScript's safe integer range. Subscription versions use positive signed-64 decimal strings; operations and subscription/delivery identities use UUIDv4. Loaded-page search/sort is not a total server inventory search. Names are bounded to 120 UTF-8 bytes, destinations to 2,048 bytes, keys to 32–128 supported ASCII key characters. Page bounds are 1–10,000 with limits 1–100; the UI requests 20. Subscription configuration ceilings are 20 per repository and 5,000 per instance, including disabled retained configurations. There is no tenant destination/header proxy, arbitrary payload editor or API-token/MCP mutation grant.

## Explicit continued authorization

Configuration and history require an authenticated managed Golf browser session, exact Origin, the same current native repository/owner identities and native owner/admin permission before and after the operation. Golf instance administration grants no native repository override. Current organization-admin capability is derived from the same native repository permission observation; it does not invent a global impersonation identity.

Enabling explicitly approves continued background delivery **after browser logout**, using that local account's existing encrypted native delegation. No raw native token is accepted by the webhook UI, copied into a subscription or synthesized by the worker. Local-account-only delivery is deliberate until renewable OAuth background delegation is implemented and qualified.

Every attempt rechecks the enabled Golf local account, exact Golf/native actor binding, native credential version, subscription version/epoch, repository and native owner IDs, current native repository-admin permission and the worker's claimed lease. These checks repeat before dialing, after TCP connection and after TLS handshake before handing the connection to HTTP. There is no cross-provider atomic permission interval; a request already accepted by the receiver cannot be recalled.

Disabling or replacing configuration cancels queued/retrying work. Local-account disable or credential-version replacement permanently pauses the subscription and advances its epoch; re-enabling the account alone cannot revive consent. Loss of current native admin authority or native target identity pauses it during worker admission. Explicitly saving an enabled subscription under current local/admin authority creates a new authorization version. Browser logout only revokes the browser session and deliberately retains approved background delivery.

Native rename/transfer observations remain independent. The frozen repository/owner identity cannot be rewritten to another tenant; a stale routing name or changed native owner is refused rather than adopted. The current owner cannot list or adopt an old-owner subscription, delivery history or operation receipt after a transfer, even if they now have native admin authority. Operators must review and explicitly configure a valid current target.

## Transactional producer and bounded queue

Only committed **shared** `golf_repository_activity` rows in `source`, `issues`, `pulls` and `actions` fan out in their originating SQL transaction. Rolled-back activity creates no delivery. Recipient-private `agents` events never fan out. Payloads contain the fixed schema `golf.webhook.v1`, `repository.activity.<topic>`, stable `activity:<journal ID>` event ID, fixed producer `golf.repository_activity`, exact repository ID and observation timestamp. They contain no issue/PR body, source, prompt, tool output, native token or claimed semantic completion result.

These categories mean “recorded repository activity changed”; `actions` is not proof of successful CI, `source` is not a typed Git-push receipt, and `pulls` is not protected approval/merge eligibility. Future semantic producers must have their own authoritative event contracts.

The outbox is unique per subscription/original event. Capacity is 200 pending deliveries per subscription; excess events retain terminal `queue_capacity` history instead of silently disappearing or rolling back the originating activity. Queue locks are scoped per subscription and acquired consistently with subscription/FK locks. Fanout ordering is deterministic. Worker recovery/cancellation maintenance is forge-scoped and batched at 100 rows. Terminal history and encrypted configuration versions are retained; automatic retention, quotas across history and benchmarked high-volume fanout remain open.

## Actual worker and HTTP transport

`golf webhook-worker` consumes the real PostgreSQL queue. Workers acquire at most two instance advisory-lock slots, then claim individual rows with `FOR UPDATE SKIP LOCKED`, a random lease ID, 30-second lease and durable attempt increment before HTTP. A SQL transaction never spans network I/O. Owner connection loss or expired/replaced delivery lease prevents a stale worker from sending or overwriting the new owner. Cancellation cleanup commits even when no delivery is eligible.

The worker is opt-in: Compose requires `compose.webhooks.yaml`; Helm requires `webhooks.enabled`. Merely saving a URL does not launch a worker or prove delivery. The overlay uses the existing Golf image, key configuration, database/native service and a read-only, bounded container without a Docker socket, native filesystem mounts, provider auth or paid AI. Helm operator values/secret/network-policy integration must be qualified separately; the template alone is not proof of working Kubernetes egress.

Normal tenant destinations require public HTTPS on port 443. DNS is resolved anew for each attempt; all answers must be valid public addresses, with at most 32 answers. Private, loopback, link-local/metadata, multicast, reserved/documentation and IPv4-mapped/transition bypasses are rejected. The TCP dial is pinned to the validated address and its actual remote IP/port verified. TLS validates the destination hostname with system roots, minimum TLS 1.2; there is no tenant insecure-TLS toggle. Proxies, redirects, shared keepalive, cookies and caller-chosen auth headers are disabled. DNS, TCP, TLS, response header/body and complete attempt are bounded; payloads are at most 16 KiB and response text is discarded under a bounded reader.

For controlled local qualification, `GOLF_WEBHOOK_EGRESS_POLICY` permits **operator-only** exact origin/IP/path exceptions. JSON entries are `{origin, addresses, path_prefix}` with at most 16 origins and 32 exact canonical IPs each. This can allow owned private/loopback HTTP receivers without turning link-local/metadata or arbitrary tenant egress into an exception. The origin, every resolved address and literal path boundary must match; dot-segment and prefix-neighbor escapes are refused. Save-time validation and workers must use the same operator configuration. These exceptions are not proof of public DNS/TLS delivery.

## Receiver signature and replay handling

Requests carry `Content-Type: application/json`, `User-Agent: Golf-Webhooks/1` and:

- `X-Golf-Event-ID`: stable event ID, preserved across automatic retry and explicit redelivery.
- `X-Golf-Delivery-ID`: one durable delivery UUID, preserved across its automatic retries; a new explicit redelivery has a new UUID.
- `X-Golf-Timestamp`: decimal Unix seconds for this attempt.
- `X-Golf-Signature-256`: `sha256=` plus lowercase hexadecimal HMAC-SHA256.

The exact signed bytes are:

```text
UTF8(timestamp) || LF || UTF8(event_id) || LF || raw_HTTP_body_bytes
```

The key is the saved signing secret. There is no trailing LF unless it is present in the immutable body. Verify the exact received body bytes, compare MACs in constant time, enforce a receiver-selected timestamp acceptance window and persistently deduplicate the **signed event ID** within the subscription context. The delivery-ID header is informational and is not a separate signed identity in this first contract. A valid signature alone does not establish that a receiver acted exactly once.

## Acceptance, retry and uncertainty

A recorded 2xx response is `accepted`; it proves HTTP acceptance only, not a human notification or successful downstream effect. Nonretryable responses are terminal `failed`. Transport uncertainty, 408, 429 and 5xx retry with exponential backoff, positive bounded jitter and bounded `Retry-After` (maximum one hour), at most six attempts. Response text and raw transport errors are never retained. Delivery status/fixed failure category/attempt count/status code/timestamps and possible-duplicate metadata are visible to current repository admins.

The request can succeed externally while SQL finalization fails. Recovery records `lease_expired_uncertain`, retains the original event/delivery IDs and sets `possible_duplicate`; it does not claim no effect. An expired worker cannot finalize or send using a replaced lease. Automatic retry is explicitly **at least once**. Exact repeated test/redelivery operation IDs inspect the original durable receipt without creating another delivery; changing intent under the same ID is refused. New redelivery is an explicit user action with a duplicate warning, not automatic adoption or a replacement key after an unknown response.

Save uses subscription/version CAS. A lost acknowledgement is not proof of a failed save: the UI clears secret inputs, blocks a blind retry and asks for explicit inventory/history inspection. Reload and status/history reads never queue work. A post-commit native authority failure can withhold the save receipt; current authorized inspection remains the source of saved state, not attribution guessed from a timeout.

## Encryption, key lifecycle and recovery

URL/key payloads use the dedicated `webhook_credential` keyring domain with derived subscription-ID/version binding. Immutable credential rows retain metadata identity while ciphertext/key ID may change only through key rotation; copied authenticated ciphertext cannot be opened or re-encrypted under a substituted subscription/version binding.

Startup, permanent key fingerprints, full inventory, legacy bootstrap including pages beyond 500, bounded shared rotation, audit counters, required-key validation and retirement include **all** retained webhook versions. Rotation uses the existing shared budget and `SKIP LOCKED`; a failed credential/audit transaction cannot legitimize a partial rotation. There is no blanket plaintext credential retrofit.

Existing offline recovery disables local accounts in its transaction; the new revocation trigger therefore pauses local-only webhook subscriptions. Original activity/delivery/attempt/configuration/credential history is preserved, and restored queued work is cancelled instead of automatically replayed. This source regression does not qualify latest-migration040 coordinated Docker/Kubernetes restore, external acceptance reconciliation, RPO/RTO or safe reopening of traffic. Downgrade refuses deletion of encrypted/external-effect history.

## Evidence and remaining acceptance

Source evidence in the isolated webhook worktree:

- Real disposable PostgreSQL race tests: extended worker/key-family packet **29.932 s**, derived-binding/key bootstrap501/rotation-fault/worker/CAS/accepted-HTTP-lost-SQL subset **8.728 s**, full webhook packet **21.192 s**, and final frozen-owner/native-admin/transfer isolation subset **12.183 s**, with containers removed after each run. These exercise actual SQL migrations/constraints/queries and local owned HTTP receivers; native authorization is a controlled HTTP boundary substitute, not actual Gitea qualification.
- Focused browser fixtures cover explicit editor/consent/CAS, lost acknowledgement and reload without writes, exact receipts, queue/history/redelivery, access loss/late response clearing and shared dark/light 390/1440 layout. The final **12 cases passed in 16.5 s**. These are source browser tests, not retained-stack screenshots.
- Pure transport tests independently verify HMAC bytes, owned TLS, redirect refusal, address pinning, mixed/rebound DNS, exact operator exceptions and late authority denial before HTTP bytes.

Before marking this bounded slice qualified: integrate migration040 and combined descriptor, run local checks, deploy the actual worker with matching operator policy, deliver to an owned controlled sink, independently verify signatures/body/event IDs/retry and actual browser CRUD/history/revocation, inspect both themes/mobile/desktop, record the exact running image before/after and clean fixture subscriptions/accounts/receiver without erasing retained encrypted history. Public production TLS/DNS, Cloudflare delivery, email/Slack and broader semantic producers require their own evidence. See [implementation plan](../GOLF_IMPLEMENTATION_PLAN.md) and [implementation status](IMPLEMENTATION_STATUS.md); this packet does not make the overall product or all repository settings complete.
