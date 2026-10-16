# Account session management

The current account control lists and revokes the signed-in user's active **Golf sessions**. It works with scoped Forgejo PAT bootstrap and configured Forgejo browser OAuth. It does not replace Golf local/OIDC identity, invitation, MFA/recovery, credential rotation or organization authorization work.

Open **Sessions** in the workspace sidebar. The page identifies the current session, creation and absolute expiration times, and whether its stored upstream credential uses PAT or OAuth. It shows no inferred device/location/IP data. Revocation requires an explicit confirmation; cancelling leaves access unchanged.

## API and metadata

All operations use the existing generated `golf.v1.SessionService` Connect contract, exact-Origin protection, opaque HttpOnly cookie authentication and `Cache-Control: no-store`.

| Procedure | Behavior |
| --- | --- |
| `ListSessions` | Paginated active-session metadata scoped to the current immutable user and configured forge. |
| `RevokeSession` | Delete an accessible active session by its non-credential decimal ID. A missing, expired or foreign session receives the same not-found response. Revoking the caller clears its cookie and identifies that result in the response. |
| `RevokeOtherSessions` | Delete the account's other active sessions, including those outside the loaded page. Preserve the caller and return the decimal uint64 deletion count. |

Returned fields are `id`, `createdAt`, `expiresAt`, `current` and `credentialKind`. A session's management ID is separate from its authentication cookie/verifier. It is never accepted as a credential. Token values, token hashes, encrypted envelopes and OAuth refresh credentials are not returned. IDs are canonical positive decimal strings; clients must not convert them to imprecise JavaScript numbers.

Pagination defaults to page1/limit20, with limit100 and page10000 ceilings. Ordering is descending creation time then management ID. Offset pagination is not a snapshot across concurrent logins/deletions; clients reset to page one after changes. The UI deduplicates loaded IDs. If the last permitted page still has more results, the API fails visibly rather than reporting a complete listing.

## Authorization and concurrency

The API checks the current upstream credential and compares the actual immutable Forgejo user ID with the stored identity. A revoked credential, wrong identity, missing Golf session or expired caller cannot list or revoke sessions. Forge URL and user scoping remain in the SQL queries; possession of another user's management ID does not grant access.

Management transactions lock the Golf user before the caller session, recheck current authorization after lock waits, and serialize competing account revocations. This avoids two callers holding the very session rows the other wants to delete. A concurrent revoke-other race can leave one caller authorized; the deleted caller receives unauthenticated rather than revoking through a stale session. Login and management share the identity-first lock order; OAuth refresh only locks its own session.

Absolute expiration is checked again before commit. A database/provider error or expired caller rolls back pending changes and returns a safe error. Revocation takes effect on subsequent authorization checks; it does not cancel an already authorized in-flight repository request or prevent a new authorized login after the transaction. Provider state and PostgreSQL cannot be changed atomically.

The additive migration assigns management IDs to existing PAT/OAuth sessions without changing their cookie hashes, ciphertext or twelve-hour lifetime. Downgrading removes management metadata while preserving these sessions. It does not change the earlier OAuth downgrade's explicit invalidation rule.

## Provider and browser boundaries

Revoking Golf sessions does **not** revoke the Forgejo PAT, OAuth consent, Forgejo browser session, Git SSH/deploy keys or provider account. A still-valid credential can establish a new Golf session. Revoke those credentials through their owning provider when necessary. The development CLI's ephemeral bootstrap sessions can briefly appear while a command is running.

Session queries are private, per-user, abortable and uncached after the dialog closes. Failed refresh/revocation hides prior rows. Current-session revocation and unauthenticated errors reuse the existing sign-out path to cancel/remove private queries. Theme selection is the only persisted browser preference involved; no credentials/session metadata are stored in localStorage.

## Recorded account activity

Open **Account activity** for the selected successful session events recorded by this installation. Covered sign-in, sign-out, individual/bulk revocation and replacement write an event in the same database transaction; history retains non-credential session IDs after removal. No pre-migration login history is fabricated. Automatic expiry cleanup, OAuth refresh and credential deletion after invalid grants/identity rejection remain unaudited, as do failed attempts. A missing/already-deleted logout cookie returns success without an event. See the [account audit contract](ACCOUNT_AUDIT_CONTRACT.md) for exact action metadata, snapshot pagination and append-only/upgrade limits.

## Verification

The implementation ledger records real PostgreSQL migration/scoping/expiry/rollback/concurrency checks, generated-contract browser checks and the actual Compose checks:

```sh
python3 scripts/sessions-smoke.py
python3 scripts/oauth-smoke.py --refresh
```

The PAT smoke creates disposable users, checks private pagination/foreign-ID denial/current/bulk/replay/concurrent revocation and upstream-token rejection, and uses the production-served dialog for dark/light/mobile and confirmation/cleanup checks. Its non-credential screenshots are written under ignored `.tmp/session-smoke/`. OAuth verification creates a separate disposable user/session so session deletion cannot substitute for the existing upstream-consent-revocation proof. Both harnesses purge their provider fixtures afterward.

The isolated Kubernetes smoke also exercises listing through both actual Golf pods, revoking a second session on another replica, saved-session rejection and stable management IDs after replacing all core workloads. It shares the PostgreSQL/session policy across both infrastructure tracks; no Cloudflare dependency is required.

These controls address concrete session lifecycle requirements from the plan. They do not close the full identity/role/security release gate. Reference: [OWASP session management guidance](https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html).

Account sessions are managed on the dedicated `/account/sessions` page, inside the shared personal-settings navigation. Only revocation confirmations use dialogs. Leaving the page cancels pending private reads and revocation requests; a cancellation does not undo a native mutation that already completed.
