# Ordinary Golf account enrollment, reset and re-enable

`InstanceAdminService` provides three password-confirmed mutations for **ordinary Golf local accounts**. They map existing native identities; they do not create native users, change native passwords or grant native permissions. Golf instance-administrator targets, including the caller, are excluded. Creating or recovering administrator accounts remains an operator action.

The account [inventory](INSTANCE_ADMIN_CONTRACT.md) supplies immutable IDs and credential versions. [DisableLocalAccount](INSTANCE_ACCOUNT_DISABLE_CONTRACT.md) remains a separate operation. Users change their own password or login email through [account security](ACCOUNT_SECURITY_CONTRACT.md).

## API

All methods are POST Connect procedures below `/rpc/golf.v1.InstanceAdminService/`. They require the exact configured Origin, a current HttpOnly local-password session, the current Golf instance-administrator role and the caller's own `passwordConfirmation`. PAT, OAuth and delegated API-credential sessions cannot acquire this authority, even if they share an enrolled administrator's native identity. Responses are `no-store`.

| Method | Request fields | Committed change |
| --- | --- | --- |
| `EnrollRegularLocalAccount` | `username`, optional `email`, `password`, `forgeToken`, `expectedNativeUserId`, `passwordConfirmation` | Creates an ordinary account bound to the verified native ID, with credential version 1. There is no role input. |
| `ResetRegularLocalPassword` | `accountId`, `expectedCredentialVersion`, `password`, `passwordConfirmation` | Replaces the Golf password hash and increments the version. Preserves enabled/disabled state and the mapped provider credential. |
| `EnableRegularLocalAccount` | `accountId`, `expectedCredentialVersion`, `password`, `forgeToken`, `passwordConfirmation` | Requires a disabled ordinary account. Verifies a freshly supplied credential for the existing immutable native ID, stores a new password and encrypted source credential, clears `disabledAt`, and increments the version. |

Each response contains `account: LocalAccountInfo`, `sessionsRevoked` and `operationId`. IDs and credential versions are opaque canonical positive decimal strings; `sessionsRevoked` uses the protobuf uint64 JSON representation. No password hash, provider token, encrypted credential or cryptographic binding is returned. The account projection is the same as the inventory, including optional `disabledAt` only when disabled.

Usernames must match `^[a-z0-9][a-z0-9._-]{2,63}$`. Passwords must contain at least 15 Unicode characters, be valid UTF-8 and occupy at most 1,024 bytes. Optional login emails use the existing canonical lowercase ASCII mailbox validation and instance-wide uniqueness. They are **unverified Golf login aliases**, not native email updates or proof of mailbox control. The existing source-token input bound is 8–512 bytes without spaces, tabs or line breaks; the native provider must accept it and return the exact expected user ID.

## Authority, locking and atomicity

Password confirmation uses the same fixed-cost Argon2id verifier, bounded KDF concurrency and persisted login-attempt limiter as local authentication. It captures the caller's local account, immutable Golf identity, session ID, password hash and credential version. It checks the caller's mapped native identity and local authority again after password verification and after target-provider verification/password hashing. Provider requests and KDF work finish before acquiring transactional account locks.

The transaction locks the caller and target Golf identities in ascending immutable-ID order, followed by local accounts and the caller's session. It checks the original password-confirmation snapshot again under those locks and immediately before commit, using database-time expiry. Reset and enable compare the target's expected credential version; they cannot silently adopt a newer target state. The native identity, local username, administrator role and AEAD binding remain immutable.

Enrollment uses the verified native ID to establish or locate a Golf identity, then locks it with the actor before checking for an existing local enrollment. Duplicate native identities, usernames or email aliases fail without a partially enrolled account. Re-enabling uses the historical encryption binding and the currently accepted keyring policy; it cannot replace the identity with a same-named or different native user. Existing keyring write fences still apply.

Reset and enable delete all sessions bound to the affected local account in the same transaction. API credentials sourced from those sessions consequently stop working. Independent PAT/OAuth sessions, native sessions, provider tokens and Git/SSH keys are separate authorities and are not revoked by these operations. Resetting a disabled account deliberately leaves it disabled; re-enabling requires the full new-password and verified-source-credential boundary, including after recovery quarantine.

The same transaction appends `ADMIN_CREATED`, `ADMIN_PASSWORD_RESET` or `ADMIN_ENABLED` to `golf_local_account_events`, including target account, resulting credential version, revoked-session count, nonsecret operation ID and exact actor Golf-user/session IDs. An audit insertion failure rolls back the credential change and session deletion. Append-only SQL guards do not prevent a privileged database owner from altering the guards or data; this is not WORM or cryptographic audit assurance.

## Failure and scope boundaries

- Invalid input or an unverifiable/mismatched target source credential fails before enrollment/enable. A target credential failure does not pretend the administrator's own session expired.
- A stale version, duplicate enrollment or already-enabled target produces a failed-precondition response. An inaccessible or foreign-forge local-account ID produces not found. Administrator/self targets are permission denied.
- Actor logout, disable, password reset, expiry or native identity changes observed during waits prevent the mutation. Native token verification remains an observation through the supported provider API, not an atomic cross-system revocation transaction; later provider revocation is enforced by normal authentication checks.
- Responses may be lost after a successful commit. Clients must inspect current inventory/version before a new attempt; no exactly-once transport, secret recovery or automatic retry is promised. These methods have no CLI/MCP mutation exposure.
- Browser administrator-role changes, deletion, invitations, native user provisioning, password recovery mail, MFA and organization administration are not part of this contract. Excluding every administrator target prevents this slice from disabling/resetting the last administrator; it is not a general last-administrator mutation protocol.

## Qualification

`go test -race ./internal/server -run '^TestInstanceLifecycle' -count=1 -timeout 120s` uses isolated real-PostgreSQL schemas when `GOLF_TEST_DATABASE_URL` is provided. It covers transport and role boundaries, immutable mapping/encryption, reset/enable state, local-session/delegation revocation, concurrent version-fenced resets, audit-insertion rollback for all three actions, post-wait actor revocation, input validation and foreign-forge targets. Without that DSN, database cases skip.

`python3 scripts/account-lifecycle-smoke.py --image <current-Golf-image>` creates one disposable Compose core with pinned Forgejo and PostgreSQL, uses supported native administration only for fixture setup, and removes all project containers, volumes, network and private configuration in `finally`. It combines the three administrator methods with the two self-service account-security changes.

The native drill passed against Golf image `sha256:a26132c709660b91c794be9e12f0f2f128bb80b1a3c80807ed2314a2b1b0d5ad` and PostgreSQL 18.4 in an earlier native qualification on a since-retired backend; it has not been repeated on Forgejo 15.0.9. It verified:

- All three administrator operations, two own-account credential changes, password/Origin/PAT/delegated/ordinary-account denials, administrator-target protection and stale-version rejection.
- Expected-native-ID mismatch rejection; ordinary enrollment even with an ignored, forged administrator-role JSON field; encrypted source credentials; and a newly issued matching provider token on enable while retaining the historical AEAD binding.
- Exact local-session deletion and source-dependent delegated credential denial; disabled-state preservation across reset; old Golf password/alias rejection and successful new-password/new-alias/username sign-in.
- Duplicate-email failure retaining the prior version and usable session/delegation, exact actor/account/operation audit fields, restart persistence, and unchanged native identity/email/administrator flag with original provider tokens still accepted.
- Removal of every isolated project container, volume and network. The retained local development installation was not used or modified.

The final serialized real-PostgreSQL race suite also passed, including forced account-event insertion failures that roll back each administrator mutation and session deletion. The native fixture's initial unknown-field expectation was corrected: Connect accepts unknown JSON fields, while the server always persists an ordinary role. No runtime relaxation was made. The [implementation ledger](IMPLEMENTATION_STATUS.md) records wider checks and remaining product gates.
