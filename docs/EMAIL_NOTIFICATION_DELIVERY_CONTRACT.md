# Verified mailbox notifications and portable SMTP

This is a consumer-backed **Partial** increment for Golf's email/notification requirements. It adds an actual SMTP queue consumer, verified own-mailbox preferences, repository subscriptions and delivery inspection. Source tests and browser fixtures are separate from deployed qualification. No external email, provider account, Cloudflare service or retained deployment is exercised by this packet.

## Scope and activation

An instance administrator explicitly adds named, immutable SMTP transport versions and activates one exact saved version using current password confirmation and the observed activation generation. Saving or activating is configuration, not a connection-health result. Exactly one version is active. Changing activation generation cancels older queued attempts; an already accepted message cannot be recalled.

The `email-worker` command consumes the durable queue using two PostgreSQL advisory slots. It must be launched by the operator; the UI never infers that a worker is healthy from saved configuration. An unconfigured transport creates a terminal `transport_unconfigured` result rather than a simulated send. API/Cloudflare email adapters are not implemented here.

Public destinations require implicit verified TLS on port 465 or mandatory STARTTLS on port 587. DNS answers are bounded, every answer must pass egress policy, the dial uses one validated address, and the connected peer must match that address and port. There is no proxy, redirect, alternate-address fallback or opportunistic TLS downgrade. Authentication is never permitted over plaintext.

`GOLF_EMAIL_EGRESS_POLICY` is an operator-only JSON array of exact `{host, port, tls_mode, ips}` records. IP entries are canonical CIDRs. It permits controlled private/local sinks; `operator_plaintext` requires an explicit matching policy and cannot carry credentials. Public UI users cannot install the exception. Sender ownership, SPF, DKIM and DMARC remain relay/operator responsibilities; this screen does not claim to verify them.

## Mailbox identity and consent

Only a managed **local Golf account** can use this first background-delivery contract. Native PAT/bearer sessions do not become background identities. The recipient is the account's current Golf login alias, never an arbitrary address or inferred native email. Contact identity binds Golf user ID, native actor ID, local account ID and local credential version.

The explicit verification request creates an eight-digit challenge and a queued verification message in one SQL transaction. It expires after 30 minutes, permits at most five valid-shaped attempts, and requests are limited to three per account per hour. Exact operation replay returns the original request metadata and current own state; it does not send another message. Codes are hashed in challenge metadata and the original message is encrypted. Codes are never returned by RPC or persisted in browser storage. Verification establishes notification-mailbox control only: it does not implement password recovery, native email changes or identity-provider assurance.

After verification, the account explicitly enables notification delivery and authorizes continued delivery after browser logout. Repository subscriptions also require explicit consent and current native read access. They bind the immutable native repository **and owner** IDs, native actor, local account/credential version and contact version. A transfer does not adopt old consent: the new owner scope requires a new explicit subscription. Disabling/replacing credentials or disabling an account pauses delivery and invalidates verification; logout alone does not revoke previously approved background consent.

Version fields are canonical signed-64 decimal strings. Preference and subscription writes use exact observed CAS versions. Repository operations also require the current canonical routing key, native repository ID and native owner ID, with current actor/read authority observed before and after the operation. Configuration does not grant authority. A denied mutation or child history read clears cached private settings; a late response cannot restore them. Errors and lost acknowledgement require explicit inspection, never automatic resubmission.

## Events and bounded queue

The producer consumes Golf's **committed repository activity categories**: `source`, `issues`, `pulls` and `actions`. Delivery rows are inserted in the activity transaction and roll back with it. Recipient-specific/private agent activity is excluded. These are category notices, not complete typed push, issue, pipeline or agent notification payloads. Notices contain a constant summary and authenticated repository link; they contain no issue/PR body, source, log, prompt, tool output or private agent content.

Admission is serialized and bounded to 100 subscriptions per account, 500 per repository and 10,000 per instance. Admission caps count retained subscription records, including disabled historical owner scopes. The per-account pending queue is capped at 200. Claims and expiry processing are bounded, use `SKIP LOCKED`, and are scoped to the worker's configured forge. These limits bound transactional fanout; they do not qualify batched fanout, million-tenant scale or arbitrary sustained throughput.

Every send rechecks enabled/current Golf account, alias/contact version, background consent, local credential version, exact subscription version/epoch and current native actor/repository read authority. The stored encrypted local delegation is used; there is no global impersonation or raw PAT entry. SQL lease/activation checks and native authority are independent observations immediately before SMTP `DATA`. A permission change after that boundary cannot recall mail already accepted by the relay.

Transport configuration, recipient, rendered body, Message-ID and event/consent identity are frozen for an admitted attempt. Public payloads and server reads are bounded. SMTP response text is not retained or returned. The SMTP socket has bounded time, response bytes and cleanup. No database transaction spans SMTP I/O.

## Results, retry and suppression

| Observed result | Meaning |
| --- | --- |
| `queued` / `sending` / `retrying` | Actual durable queue/lease state; not delivery progress or a health claim. |
| `accepted`, SMTP 250 | Relay accepted the completed DATA transaction. No proof of inbox delivery, human reading or provider settlement. |
| `cancelled` | Current consent, account, target, transport generation or lease observations no longer admit a send. |
| `suppressed` | Exact RCPT 550 enhanced `5.1.1` mailbox rejection paused the own mailbox. Other 5xx responses are not guessed to be mailbox bounces. |
| `failed` | Permanent refusal, exhausted retries, missing configuration or queue capacity. Failure codes are fixed metadata. |

Temporary/transient failures retry with bounded backoff, at most six attempts. Lost DATA acknowledgement, expired sending leases or a lost SQL result after acceptance may duplicate mail. Automatic retries reuse the exact frozen body and stable Message-ID, which assists receiver deduplication without guaranteeing it. Explicit authorized redelivery creates a new operation/message ID and marks possible duplication. Replay requires current authority and never blindly resends. QUIT loss after a DATA 250 does not turn known relay acceptance into a failure.

History is owned by the subscriber. Repository history requires current exact native repository/owner access; account-level history includes verification mail only and cannot expose revoked private repository metadata. There are no private message bodies or SMTP credentials in history RPCs.

## Unsubscribe

Activity mail carries an opaque 256-bit capability for the exact current subscription version. GET displays confirmation and never changes preference. A deliberate POST disables that capability's subscription and increments its epoch; it has no identity/repository output, cookies or redirect. Editing the subscription replaces the capability. Requests are bounded, `no-store`, `no-referrer`, with a restrictive CSP.

This is not an RFC 8058 one-click/DKIM implementation. Provider complaints, asynchronous bounces, inbound replies, digests, accessibility/localization of mail templates and notification routing beyond own verified local aliases remain open.

## Encryption and key lifecycle

Schema 043 adds `golf_notification_contents`: immutable identity/kind/binding and encrypted transport, contact, subscription-token and rendered-mail content. AEAD domain `notification_content` binds the UUID and content kind. Cipher/key changes are rotation-only; retained content/effect history is not deleted. Active-key insert/update guards apply.

`CredentialKeyUsage.NotificationContents` and `CredentialKeyOperation.RotatedNotificationContents` are named counters, included in startup missing-key checks, complete legacy bootstrap pages, total batch budgets, `SKIP LOCKED` rotation, crypto audit counts and retirement refusal. The named `appendCryptoInventory` seam prevents positional loss when other encrypted families are merged; the older bounded `appendCrypto` wrapper remains compatible. A failed crypto audit rolls back the whole batch. Recovery qualification for the combined latest schema remains separate.

## Browser-only wire and integration

`EmailNotificationService` exposes eleven managed-browser methods: List/Save/ActivateEmailTransports, GetOwnEmailNotifications, Request/ConfirmEmailVerification, SaveOwnEmailPreference, Get/SaveRepositoryEmailSubscription, ListOwnEmailDeliveries and RedeliverOwnEmail. Native/bearer API delegation is not granted. Host integration must use the existing exact Origin/session guard, `no-store` responses and current local-account checks.

The three consumers are account notifications, own repository notification subscriptions and administrator SMTP inventory. They use explicit Add/Edit actions, shared TanStack Form/DataTable and global layout classes. Secret fields clear on submit/revocation; saved credentials are metadata-only. Forms and queued/accepted results do not make the entire Email/Webhooks settings section Ready.

## Validation and remaining qualification

Prepared source fixtures cover actual owned SMTP/TLS exchanges over `net.Pipe`, accepted-QUIT-loss, RCPT suppression classification, lost DATA acknowledgement, required TLS, certificate/peer/DNS refusal, response/time caps, current-before-DATA authority and cancellation. Browser fixtures cover exact IDs/CAS, lost acknowledgement inspection, no automatic send on reload, explicit consent, read-member subscriptions, private revocation/late-response clearing, secret retention, explicit activation/redelivery and both themes at 390/1440.

Source validation on 2026-10-04: final disposable PostgreSQL/race packet **PASS 31.903s**, with the owned instance removed in `finally` (`.tmp/email-notification-postgres-final.log`). This covers verification/CAS/rate/expiry, committed-outbox rollback/private exclusion, current native authority/CV/repository replacement before DATA, lost DATA/SQL acknowledgement, stable retry identity, explicit redelivery/replay privacy, transfer consent, forge scope, unsubscribe, admission cap and encrypted-family rollback/busy/retirement/501-row bootstrap. Native authorization is exercised through owned HTTP fixtures, not a deployed native installation.

The earlier 28.938s PostgreSQL run failed one fixture: an old activation-generation cancellation correctly paused its subscription, while the test incorrectly assumed it was still enabled before unsubscribe. The final fixture explicitly re-enables through the production CAS/consent method, then proves GET-inert/POST behavior. Earlier failure evidence remains `.tmp/email-notification-postgres-first.log`.

Final pure SMTP/race tests **PASS 2.151s**, including required STARTTLS plus authentication and verified TLS, bounded server reads, Unicode quoted-printable templates and sanitized refusal codes. Final browser fixtures **15 PASS, 7.5s** (`.tmp/email-notification-browser-final.log`), with fonts served through the isolated test host; no screenshots are presented as actual native qualification. `make check`, generation drift, Go/vet/TypeScript and production web build pass. The isolated host route wiring is excluded from the feature commit; parent integration owns those shared paths.

Deployed controlled SMTP delivery is pending parent integration/qualification. Browser fixtures are not served native evidence. Earlier webhook HTTPS/HMAC qualification is a different capability and must not be relabeled SMTP evidence.

The full settings requirement still includes renewable OAuth background delegation, generic provider/API adapters, optional Cloudflare email, verified sender-domain guidance, provider bounce/complaint integration, richer preferences/semantic producers, production workload sizing and combined recovery. [Go's SMTP package](https://pkg.go.dev/net/smtp) provides low-level SMTP rather than a mail product. [RFC 8058](https://www.rfc-editor.org/rfc/rfc8058.html) has additional one-click/DKIM requirements. [Cloudflare Email Service](https://developers.cloudflare.com/email-service/) is a separate optional adapter requiring its own authentication, sender/domain and delivery qualification.

## Integrated product surfaces

The shared managed-browser client and all eleven RPC methods are registered behind the cookie/Origin/no-store boundary; delegated API credentials cannot use them. Notification verification/preferences are inventories on `/account/settings`. Own repository email subscriptions and history accompany `/OWNER/REPO/settings/webhooks`, with one contextual settings layout. Named SMTP transports have a dedicated Admin portal page at `/admin/settings/notifications`; saving/activation remains configuration, not observed health. Private account/target denials clear the editors and history. The opaque `/notifications/unsubscribe` capability endpoint is outside the managed-session boundary so GET remains a confirmation and explicit POST can unsubscribe without logging in.

The optional `compose.email.yaml` packages the portable `email-worker` with read-only root filesystem, bounded resources, dropped capabilities and operator-only egress configuration. It is not automatically activated on the retained development instance. Startup rejects invalid operator SMTP policy before opening a database, and the actual worker still rechecks current authority before SMTP DATA. No SMTP credentials, notification destinations, provider grants or retained account settings are created by this overlay. Actual disposable SMTP/native/browser qualification and combined encryption/recovery evidence remain required.

## Prepared disposable SMTP qualifier

The maintained parent/browser helpers are `scripts/email-notifications-smoke.py` and `scripts/email-notifications-browser.mjs`. They are **prepared, unrun source** until the operator executes them against an exact combined image. Pure preparation can be checked without Docker, native HTTP, SMTP or provider traffic:

```sh
python3 scripts/email-notifications-smoke.py --self-check
node --check scripts/email-notifications-browser.mjs
```

A parent-authorized actual run requires an already present revision-labeled Golf image, the existing pinned native/PostgreSQL dependencies, an explicitly supplied local Python 3 sink image, Docker/Compose/OpenSSL, at least 2 GiB Docker VM free reserve, and a **new** owner-only evidence directory. `--ui` uses the existing local Playwright installation and adds twelve captures, without installing dependencies:

```sh
python3 scripts/email-notifications-smoke.py \
  --image "$GOLF_EMAIL_PROOF_IMAGE" \
  --sink-image "$GOLF_EMAIL_PROOF_SINK_IMAGE" \
  --output .tmp/email-notifications-served-proof \
  --ui
```

The helper creates a fresh Compose project and ordinary native actors, enrolls explicitly scoped managed local Golf accounts, and activates SMTP only in that fresh project. The actual receiver is private bridge `receiver.golf.test:465`, with a generated fixture CA and verified hostname. The worker uses an exact host/IP/port operator exception and the fixture CA; there is no insecure TLS bypass, image build/pull, retained-stack mutation, paid inference, external provider or third-party message.

Verification codes and unsubscribe capabilities stay in receiver RAM and are fetched once through a secret-protected loopback control endpoint. Receiver message bodies are parsed transiently to check envelope/headers/private-body exclusion; evidence retains only delivery IDs, attempt numbers, body byte/hash observations, fixed outcome flags and safe RPC status metadata. Neither codes nor message bodies are written to artifact files, browser storage or logs. The helper does not decrypt Golf's encrypted content tables.

The prepared runtime checks cover queued-before-worker state, actual verification and one-time confirmation, read-member repository consent, logout continuation, backend/worker restart without replay, a 451 SMTP retry, dropped DATA acknowledgement with potential duplicate/stable Message-ID+body, explicit redelivery, GET-inert/POST unsubscribe and replaced-capability refusal, then native access removal/local account disable with unchanged receiver connection and receipt counts. SQL checks are bounded metadata-only reads of owned fresh delivery state; no direct Golf/native fixture writes are used. Browser paths are `/account/settings`, `/{owner}/{name}/settings/webhooks` and `/admin/settings/notifications`. UI verification, explicit consent, own subscriptions, metadata-only SMTP editors, reload no-dispatch, native read revocation and dark/light 1440/390 captures use actual served data.

`manifest.json` must finish with both `status: passed` and `cleanup: passed`; browser success alone is pending parent cleanup. Exact image IDs/source labels and before/after runtime identities are separate from the working checkout revision. Cleanup revokes/disables owned managed accounts, purges owned native actors and removes the fresh project's containers, volumes and networks. Original failure type/stage/line remains recorded alongside cleanup failures. This fresh-target proof does not establish retained-stack recovery, public production DNS/TLS, actual STARTTLS/authenticated relay operation, inbox delivery, provider bounces, Cloudflare adapters, full notification readiness or workload scale.

## Actual owned SMTP evidence

Root attempt4 on frozen848eeae core `sha256:4a7d6e33f42d723ca2f465d8523097c9b5ba3ae2f9465a1148bf62162c64e08a` passes actual native/managed enrollment, verified-TLS465 receiver acceptance, verification, consent/logout/restart, retry/uncertain DATA acknowledgement, unsubscribe, native/local revocation, twelve served theme/width captures and exact cleanup. See `.tmp/email-notifications-served-attempt4/manifest.json` and the implementation ledger. The controlled receiver has a second fresh-project default network for its loopback control port; SMTP still uses the exact private proof-network address, SAN verification and operator allowlist. Attempts1–3 remain failed separately. This closes the bounded actual portable implicit-TLS consumer gate; the full Notifications requirement, STARTTLS/authenticated relay qualification, provider/Cloudflare adapters, inbox delivery, scale and recovery remain open.

## Instance configuration, consumer observation and delivery evidence

The source-only status reader `readEmailConfigurationStatus` is intended for the existing managed-session instance-administrator transport inventory, under its current actor/admin check before and after the read. It does not grant delivery authority or expose another subscriber's mailbox, recipient, body, challenge, delivery ID or unsubscribe capability. Root integration owns the additive wire and UI fields; the unintegrated helper is not a served status feature.

Configuration and observations remain separate:

- `Configured`, exact transport ID/version and activation generation describe the saved active configuration. They do not prove a consumer is running or the SMTP destination is reachable.
- `ConnectedWorkers` counts the two existing exclusive, granted email-worker PostgreSQL advisory-lock slots in the current database and under the reader's same database role. `RecentlyActiveWorkers` counts those owned connections whose observed activity is within 30 seconds using the database clock. `LastWorkerActivity` is connection activity, not a queue-poll acknowledgement or delivery heartbeat. No new heartbeat table, credentials or runtime subsystem is created. A held lock may belong to a stalled process; a stale connection is not inferred to be dead. Operators using a different database role for worker and core may have unavailable activity visibility. Trusted database-role holders can also acquire these locks; this is operational observation, not worker attestation.
- `LatestDelivery` is at most one **most recently created** delivery for the exact currently active transport/version/activation generation. It includes only created/completed timestamps, durable state, actual attempt count, SMTP status and possible-duplicate metadata. It is not the most recently completed attempt, a global health rate or a count of inbox deliveries. A newer queued message can supersede an older accepted observation. Missing current-generation evidence is explicit; acceptance from a previous activation is never presented as validation of its replacement.
- `RelayAccepted` is true only for the durable `accepted` state with SMTP 250 and a completed attempted delivery. It proves the relay accepted DATA, without proving inbox delivery. Unknown acknowledgements/retries remain distinct and may duplicate mail.

One five-second bounded read uses current configuration, lock/activity observations and an indexed latest-created lookup. Migration045 adds the exact `(transport_id, transport_version, activation_generation, created_at DESC, id DESC)` metadata index with covering status columns. It does not index message contents or add a retained secret family. The observations remain operational and current, not a promise of continued availability or a full-readiness badge. Existing SMTP lease/consent/native fences still govern every actual send.

Source qualification: pure/race projection checks pass **1.477s**; narrow disposable PostgreSQL/race checks pass **3.493s** (`.tmp/email-status-postgres.log`), with zero remaining test schemas and owned container removal confirmed. The actual database fixture proves saved configuration without a worker, exclusion of shared/unrelated advisory locks, exact exclusive ownership acquire/release visibility, queued versus accepted metadata and old-generation evidence exclusion after an explicit transport activation. It performs no SMTP send, provider operation or retained-stack mutation. Wire/UI integration, served consumer observations, latest-schema recovery and the wider Email/Webhooks readiness requirements remain open.

## Active transport Pause control

Local schema061/component `234d471` exposes an explicit current-admin/password-confirmed Pause action for the exact active transport ID/version/generation. It clears the active pair and advances generation atomically; current consumer fences cancel superseded queued/retry work before DATA. Already accepted DATA cannot be recalled. Reactivation does not replay old cancelled messages, and affected subscriptions may require explicit renewal. No credential version is deleted. [Actual PostgreSQL and before-DATA socket checks](../.tmp/smtp-pause-postgres-attempt2.log) pass20.720s; [running component verification](../.tmp/settings-061-running-proof/manifest.json) passes. This does not complete provider adapters, production inbox delivery or combined recovery.
