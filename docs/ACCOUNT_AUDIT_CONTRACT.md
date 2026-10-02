# Own-account session audit foundation

The current developer preview implements this bounded contract through the generated API, browser and CLI. The [implementation ledger](IMPLEMENTATION_STATUS.md) distinguishes real PostgreSQL, browser-fixture and live-provider evidence. This does not complete the broader audit or identity plan tasks.

## Scope and ownership

This increment records successful changes to a user's **Golf sessions** in Golf's PostgreSQL database and lets that same account read its activity through the generated API, browser and CLI. It is a bounded contribution to P1.3, P1.8 and P5.5, shared by both infrastructure tracks. It does not introduce Cloudflare or AI dependencies.

The event set is limited to `SIGN_IN`, `SIGN_OUT`, `SESSION_REVOKED`, `OTHER_SESSIONS_REVOKED` and `SESSION_REPLACED`. These describe selected committed Golf session lifecycle changes, not provider consent changes, Git credentials or native Gitea sessions. Events retain their recorded session references after a session is removed. Existing session-management behavior and separate upstream credential ownership remain documented in [account session management](SESSION_MANAGEMENT.md).

Automatic expired-session cleanup, OAuth refresh and credential deletion after an invalid grant or identity rejection do not create events. Failed attempts and provider operations are also outside this event set. Logout with a missing, malformed or already-deleted cookie succeeds without an event; explicitly logging out a retained expired session can record `SIGN_OUT`. A successful bulk revoke with no other active sessions records a zero-count event.

No events are synthesized for sessions created before the audit migration. A pre-existing session can generate a later real lifecycle event, but its earlier login history is unavailable. An empty account history means no recorded event in this system, not proof that the account never signed in or acted elsewhere.

## Event data and privacy

The generated [`AuditEvent`](../api/golf/v1/golf.proto) fields are `id`, `occurredAt`, `action`, `actorSessionId`, `targetSessionId`, `credentialKind`, `revokedCount`, `operationId` and optional `expiresAt`. `action` uses the `AUDIT_ACTION_` prefix on the names below. Preserve opaque IDs and uint64 counts as exact decimal strings; TypeScript generated uint64 fields are bigint values, not floating-point numbers. Protobuf JSON can omit default empty strings/zero counts, while generated clients restore them.

| Action | Actor session | Target session | Revoked count | Expiration metadata |
| --- | --- | --- | --- | --- |
| `SIGN_IN` | New session | Same new session | 0 | New session's absolute `expiresAt` |
| `SIGN_OUT` | Removed session | Same removed session | 1 | Absent |
| `SESSION_REPLACED` | Removed session | Same removed session | 1 | Absent |
| `SESSION_REVOKED` | Current caller | Removed session | 1 | Absent |
| `OTHER_SESSIONS_REVOKED` | Current caller | Empty | Actual count, including 0 | Absent |

For individual/bulk revocation, `credentialKind` identifies the caller's credential kind, which can differ from the revoked session. For the other actions it identifies the affected session's `pat` or `oauth` kind. `expiresAt` is a sign-in snapshot of absolute session expiry; it is not an audit retention deadline.

Session management IDs identify records and cannot authenticate a request. Audit data must not contain cookie values, session verifier hashes, plaintext/encrypted provider credentials, OAuth codes/state, passwords, request bodies, inferred device/IP/location, or unrelated-account identity/session data. The random 32-character `operationId` is nonsecret correlation metadata, not authentication or a retry-idempotency promise. Same-account replacement and its new sign-in share one operation ID; cross-account replacement/sign-in use distinct operation IDs and contain only their own account’s session handles. The UI renders recorded text as plain text.

Account scoping uses the immutable Golf/forge identity, not login spelling, email, a caller-supplied account ID or organization ownership. Audit views do not become organization-admin views merely because a provider account is an administrator.

## Transaction and concurrency boundary

Each recorded event is written in the same PostgreSQL transaction as its corresponding session mutation. If the event insert or commit fails, the session mutation rolls back and the request returns an error; each successful covered mutation has its paired event. The automatic cleanup and credential-rejection paths excluded above are not covered mutations. This does not make upstream OAuth token exchange/rotation atomic with PostgreSQL or extend that guarantee to repository operations.

Account locks serialize event allocation and session changes. Operations touching two account identities during cookie/session replacement acquire those locks in a consistent order. A reader capturing its account's highest committed event ID must not later encounter a previously uncommitted event inserted below that boundary. Concurrent sign-ins, sign-outs, session revocations and cross-account replacements need the same ordering rule.

Audit reads require `read:user` and a valid Golf session, current provider identity matching the stored immutable user, and local expiry/revocation checks around provider waits and database access. Logout must remain possible without a currently valid provider credential; deleting a local Golf session does not require refreshing or successfully contacting Gitea first. Failed/denied reads do not become successful empty histories.

These are Golf database guarantees. They do not cancel already-authorized provider requests, revoke upstream grants, or implement a general cross-service transaction. An unknown client outcome after a lost response still requires inspecting the actual resulting state.

## API and stable pagination

The generated procedure is `AuditService.ListAuditEvents` at `POST /rpc/golf.v1.AuditService/ListAuditEvents`. It uses the same exact-Origin, Connect protocol, opaque session cookie and `Cache-Control: no-store` boundary as other application reads.

The request has `limit` (zero/omitted defaults to 20, maximum 100), optional `beforeId`, and optional `snapshotId`. Cursors are canonical positive signed-int64 decimal strings, at most `9223372036854775807`; signs, leading zeroes and zero are rejected. A `beforeId` requires a `snapshotId` and cannot exceed it. Both supplied IDs must identify existing events belonging to this account; foreign and missing IDs share a generic `invalid_argument` error. The response carries `events`, `nextBeforeId` and `snapshotId`. Events are returned newest first using event-ID keyset pagination; this is not the offset page/nextPage contract used by repository lists.

The first page captures the account's snapshot boundary. Continue with the returned `snapshotId` and `nextBeforeId`, keeping that snapshot for every subsequent page. New events above the captured boundary remain outside that traversal. Refresh starts a new snapshot and can include them. The next cursor is the last returned event ID only when another page exists; an empty cursor means the traversal is complete. `snapshotId` is empty only when the account has no recorded events. IDs up to the snapshot are eligible, and continuation selects IDs strictly below `beforeId`. Records and cursors must never be rounded through JavaScript numbers. Capture/list operations hold the account lock used by writers, so the upper bound is based on committed account history.

A snapshot provides a bounded view of recorded account events. It is not a signed export, a snapshot of Gitea state, a global ordering across accounts, or a retention/backup guarantee.

## Browser and CLI behavior

The **Account activity** view uses the typed `/audit` route. It shows recorded event kinds, times and applicable nonsecret metadata, with explicit loading, empty and error states. Load more continues the captured snapshot; refresh resets it. Private queries are scoped to the signed-in user, abortable and removed when unused. Sign-out/expiry clears private data, and denied/refetch states hide previous private rows. Audit records are not stored in localStorage.

The read-only CLI command is:

```sh
./bin/golf audit list --limit 20
./bin/golf audit list --limit 20 --before-id BEFORE_ID --snapshot-id SNAPSHOT_ID
```

Replace the cursors with exact returned strings. Global flags such as `--url` and `--token-stdin` precede `audit`. The existing CLI creates a temporary PAT-bootstrap session for every invocation and logs out before returning successful `golf.cli.v1` output. Those sign-in/sign-out mutations themselves create account events once auditing is active. Capture the first response's snapshot and reuse it for continuation: starting a new snapshot on every invocation would keep including new CLI activity. No saved credentials, managed CLI OAuth/device login or dedicated export workflow is added.

## Migration, write guards and operating limits

Migration `202610020001_session_audit.sql` creates an initially empty event history while preserving existing PAT/OAuth sessions. It does not backfill invented sign-ins. Events retain non-credential session IDs without cascading session foreign keys. Their account foreign key restricts deletion of the referenced Golf user; a future account deletion/retention design must handle that lifecycle explicitly. The migration’s down path drops the audit table and guard function, permanently deleting this history while retaining sessions. Do not treat an application binary rollback as approval to run that destructive schema downgrade; preserve and qualify recovery before any production migration.

The audited-operation guarantee applies to audit-aware Golf binaries. During a rolling deployment, an old writer can still change sessions without recording events because its compatible SQL does not insert them; the database guards do not require paired events from that old code. Drain and replace every old writer before claiming an audited operating window. The live upgrade qualified replacement of one Golf service, not gapless audit during a mixed-version multi-replica rollout. Binary rollback can resume unaudited writes even if the audit table is retained.

Database guards reject ordinary `UPDATE`, `DELETE` and `TRUNCATE` of event history. A database owner or sufficiently privileged operator can alter/disable those guards or otherwise replace data. This provides application-level append-only behavior under the stated database privilege boundary; it is not cryptographic tamper evidence, externally enforced retention, WORM storage, legal hold or compliance assurance.

This increment adds no retention scheduler, deletion/export API, signed evidence bundle, external sink, transactional outbox or job dispatcher. History growth and coordinated backup/restore still need the plan's retention and operational work. Provider repositories, failed attempts, organization policy, role administration, deployment, agent and runner events remain outside this event set. The broader requirements in [plan §14.4](../GOLF_IMPLEMENTATION_PLAN.md#144-audit-and-retention) remain open, as do complete identity, recovery and protected-publication gates.

## Verification evidence

The [implementation ledger](IMPLEMENTATION_STATUS.md) records these completed checks:

- Real PostgreSQL race tests cover all five action classes, forced audit-insert rollback, own-account scoping and expiry, stable keyset ordering under account-lock contention, same/cross-account replacement, ordinary SQL update/delete/truncate rejection and additive migration preserving existing PAT/OAuth sessions without backfill.
- `python3 scripts/audit-smoke.py --upgrade --restart --cli bin/golf` passed against the actual Compose provider. Sessions created on the pre-audit `70b3f02` binary retained their exact IDs, kinds and expiry after the new image started; their initial history was empty. This live upgrade used PAT sessions; legacy OAuth preservation is covered separately by the PostgreSQL migration tests.
- The same live run checks all five actions, `read:user`-only access, malformed/foreign/future cursor rejection, stable captured traversal after later sign-in/sign-out, exact bulk counts including zero, no credential fields, ephemeral CLI-session cleanup, history/session persistence after Golf restart, and successful local logout after provider-account deletion.
- The production-served browser passes pagination, metadata details, direct `/audit` navigation/reload, dark/light/mobile presentation and private-data removal after current-session revocation. The complete generated-contract Playwright suite passes 51 checks, including the activity view's cursor validation and failure states.

The live harness removes its Gitea users and active Golf sessions. Their immutable Golf identities and recorded history intentionally remain; fixture cleanup is not an audit deletion facility. `--upgrade` expects an already-built new image and a running pre-audit service; `--restart` interrupts the local Golf service. Ordinary checks against an already-upgraded installation can omit both flags. No repository CI is added; these checks run locally.

Passing this bounded event corpus does not complete P1.3's audit/outbox/jobs requirements or the full product audit contract.
