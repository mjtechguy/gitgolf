# Own local account security

`AccountSecurityService` reads the currently authenticated user's own Golf enrollment and changes only that account's Golf password or sign-in email alias. Its three procedures require the existing browser cookie/Origin boundary; API bearer credentials cannot invoke them. Native account email, login, password, role and provider tokens are outside this mutation allowlist.

`GetAccountSecurity` returns verified immutable native user ID, local account ID, Golf username, local sign-in alias and credential version for a current local-password session. A native PAT/OAuth session receives `can_manage=false` and no inferred local alias/account ID/version. Merely sharing the same native user does not let a nonlocal session acquire local password-management authority. A Golf instance administrator cannot select a different target through these own-account methods.

The sign-in email is an **unverified local login alias**, not evidence of mailbox ownership. It cannot establish password recovery, SSO identity, notification routing or verified contact identity. Canonicalization and uniqueness use the existing Golf enrollment rules. The native email may differ; it never substitutes for the Golf alias. The unchanged Golf username remains a sign-in fallback after an alias update.

Each change requires immutable local account/native user IDs, the observed credential version and the current Golf password. Password requirements remain the shared local authentication validator: at least 15 Unicode characters and at most 1024 UTF-8 bytes. Confirmation uses the existing bounded Argon2id verifier and durable shared login limiter; changing methods or restarting the server does not create a separate guessing allowance. New password hashing, current password verification and provider identity waits occur outside all account/session locks.

After those waits, the backend rechecks current native identity, local account/session status, exact password hash, credential version and expiry. The transaction locks Golf user → local account → session, repeats the snapshot, compares expected version and increments the credential version under the account lock. A duplicate canonical alias or failed audit write rolls back credentials and session revocations. The captured caller expiry is checked with PostgreSQL wall-clock time immediately before commit, even though the successful self-change intentionally removes that caller.

A confirmed change atomically:

- updates the local password hash or canonical login alias;
- removes **all sessions bound to that local enrollment**, including the caller;
- appends `SELF_PASSWORD_CHANGED` or `SELF_EMAIL_CHANGED` with actor Golf user ID, actor session ID, operation ID, new credential version and revoked-session count;
- returns the new version/count/operation ID with `requires_login=true` and an expired HttpOnly session cookie.

Dependent Golf API credentials retain their immutable metadata/history but become unusable because their exact source session is gone. This is source-bound invalidation, not an invented `revoked_at` update. Independently authenticated native PAT/OAuth sessions, native credentials and other users' sessions are unaffected. This deliberately follows the same local-enrollment boundary as existing operator credential changes.

The response acknowledgment must be recognized by the narrowly typed current-session-revocation exception in the local postflight interceptor. Other successful private reads continue to require surviving caller authority. A lost response after a committed transaction can leave the browser unsure which password/alias is current; the UI clears secrets and requires manual fresh sign-in rather than replaying the change. No secret/password hash or native token appears in responses, actor history or logs.

This is a local security slice, not full email verification/delivery, recovery, session reauthentication for external IdPs, configurable enterprise password policy or global native credential revocation. Both infrastructure tracks use the same PostgreSQL transaction and authorization contract.

## Runnable evidence

`TestAccountSecurityBoundary` covers cookie/Origin/API bearer refusal and canonical IDs. Real PostgreSQL tests cover own/nonlocal/foreign/stale snapshots, current-password denial, duplicate canonical alias rollback, password/alias sign-in behavior, all local sessions and dependent source-bearer invalidation, preservation of independent PAT authority, exact actor audit and expired cookie. Additional groups cover concurrent single-success behavior, revocation during the second provider wait after both KDFs, durable shared throttling across server reconstruction and a delayed audit insertion that crosses caller expiry and must roll back every mutation.

The combined disposable native lifecycle proof in `scripts/account-lifecycle-smoke.py` is coordinated with administrator enrollment/reset/enable qualification. It must use an exact already-built image, ordinary disposable native/local users and scoped supported provider operations; retained administrator credentials are never changed. Completed evidence belongs in [IMPLEMENTATION_STATUS.md](IMPLEMENTATION_STATUS.md), with tested image and remaining scope stated explicitly. This contract itself does not claim a completed production deployment or whole-Golf recovery qualification.
