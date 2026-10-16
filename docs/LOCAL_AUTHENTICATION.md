# Golf local authentication

This contract covers an operator-enrolled Golf email or username and password, separate from the connected Forgejo account's password. Isolated native API/browser and encrypted-restore qualification passed on the qualified image below in an earlier native qualification on a since-retired backend; it has not been repeated on Forgejo 15.0.9. The full real-PostgreSQL race regression passes. This increment does not complete the plan's enrollment, identity administration or account-recovery lifecycle.

## Identity and authority

Golf verifies the local password itself. An operator explicitly binds the local account to an existing Golf identity, which is keyed by the configured forge URL and immutable native user ID. The bound scoped Forgejo personal access token is encrypted for supported provider API calls. A matching display name, username or email never establishes this link.

The Golf password is not sent to Forgejo and is not a Git transport credential. Native repository, organization and issue permissions still govern provider operations. A local login does not create an unrestricted forge administrator token. Native Forgejo administrator status does not imply Golf instance-administrator authority; any Golf role is an explicit operator assignment and does not supply unimplemented administration screens or permissions.

Existing scoped PAT bootstrap and configured Forgejo browser OAuth remain separate sign-in methods. The read-only user CLI and local MCP adapter retain their existing PAT/API-credential inputs; this browser-login increment does not add password arguments, unattended password storage, a CLI OAuth flow or write tools.

## Password and credential storage

The implementation uses the maintained Go Argon2id implementation with a per-password random 16-byte salt, 32-byte output, 19 MiB memory, two iterations and parallelism one. Passwords require at least 15 Unicode code points, at most 1,024 UTF-8 bytes and are not trimmed or silently normalized. Password verifiers are distinct from recoverable provider credentials; the provider token is encrypted under the existing labeled keyring with a separate credential domain and immutable account binding. [Go Argon2 documentation](https://pkg.go.dev/golang.org/x/crypto/argon2), [OWASP password storage guidance](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html).

Local-account ciphertext remains in key inventory even when the account is disabled. Key activation, rotation and retirement must account for this third credential family in addition to sessions and pending PKCE attempts. A disabled credential is not zero stored use. Password hashes are not keyring ciphertext and must never be returned in operator JSON, public API, telemetry or screenshots.

## Session and sign-in boundary

Local sessions bind the local account and its credential version in addition to the immutable Golf/native identity. Password reset and disable invalidate dependent sessions; source-bound API credentials consequently lose authority. Every provider operation continues to use the actual mapped user's scoped credential and to check current native identity. A changed or inaccessible native account must fail closed rather than be relinked by name.

Local disable is specifically a password-login control: it does not suspend the entire Golf/native identity or revoke separate existing PAT/OAuth sessions, native browser sessions, Git keys or provider credentials. Revoke those authorities separately when the operational intent is a complete account suspension. Full unified identity blocking and the unmediated native-route boundary remain open work.

Version checks prevent a stale sign-in from publishing a session after reset/disable and withhold private successful RPC results after authority is lost. They do not undo a native mutation already dispatched by an in-flight request. Durable mutation journals retain the observed outcome; password/session revocation is not an atomic provider-write fence or completion of the protected-write gate.

`POST /rpc/golf.v1.SessionService/LoginWithPassword` accepts `{username,password}` and returns `{user}` with the standard protected Golf cookie. `GetAuthenticationOptions.localPasswordEnabled` advertises the sign-in choice. Local usernames are canonical lowercase ASCII, 3–64 characters, matching `[a-z0-9][a-z0-9._-]{2,63}`; they need not equal the native display/login name. The `username` protocol field accepts either the username or an operator-enrolled email. Login identifiers are trimmed and compared case-insensitively; passwords are untouched. Email aliases are unique lowercase ASCII mailboxes, at most 254 bytes with a local part at most 64 bytes; display names, whitespace, Unicode addresses and provider-specific dot/plus rewriting are not accepted. They are not inferred from provider profiles and do not establish a second identity or verified-email claim. Email ownership verification and self-service changes/recovery are planned. Both aliases charge the same canonical username bucket. The returned user retains the native immutable ID and provider profile, with a separately enrolled `isInstanceAdmin` flag for the local session. PAT/OAuth sessions do not acquire that flag merely by sharing the native identity.

The login endpoint requires the exact configured Origin and bounded input before password verification. Validly shaped wrong passwords, unknown accounts and disabled accounts perform the fixed-cost KDF and return generic unauthenticated failure; no credential detail appears in the response. HTTPS uses `__Host-golf_session` with Secure, HttpOnly, Path=/ and SameSite=Lax; explicitly permitted loopback development uses `golf_session`. The existing absolute 12-hour lifetime and session/API-credential revocation rules apply.

The HTTPS cookie-name change requires users with old unprefixed remote cookies to sign in again; stored session records are not converted into a second accepted cookie name. Loopback development retains its existing name. Ordinary server restart preserves unexpired authorized sessions. Idle timeouts, step-up assurance and MFA are separate unimplemented gates; the 12-hour absolute cap is not an idle-timeout claim.

PostgreSQL counters admit 120 attempts per global 60-second fixed window and 10 per 300-second fixed window in one of 1,024 deterministic username-hash buckets. Each window starts at its first attempt; these are not rolling limits, so bursts across a boundary are possible. Successful attempts also consume capacity. Buckets can collide, so an unrelated username may share a temporary restriction. Four concurrent 19 MiB KDFs are allowed per process; cancellation does not release a slot until the underlying hash computation returns. Saturation returns ResourceExhausted/429; shared counters persist across replicas/restart. Operator password reset/enable can clear the affected bucket, while ordinary successful login does not. Forwarded IP headers do not select buckets. This bounded implementation is not a production abuse-capacity or precise timing-resistance qualification. [OWASP authentication guidance](https://cheatsheetseries.owasp.org/cheatsheets/Authentication_Cheat_Sheet.html).

## Operator enrollment

Enrollment is a privileged server-operator action using `DATABASE_URL`, `GOLF_FORGE_URL` and the existing keyring configuration from the environment. The server binary is `./bin/golf-server` on the host or `/usr/local/bin/golf` in the container; this is separate from the read-only `bin/golf` user CLI. There is no public default password or open self-registration endpoint.

| Action | Exact JSON fields on standard input | Behavior |
| --- | --- | --- |
| `local-account create` | `username`, `password`, `forge_token`, `is_instance_admin` | Verify the scoped native credential and establish the immutable one-to-one mapping and explicit Golf role. An optional `email` enrolls the login alias; username/email/native identity conflicts fail. |
| `local-account set-email` | `username`, `email` | Change the operator-enrolled login alias, advance the version and revoke local sessions/dependent API authority. Preserve disabled state, password, immutable mapping and role. |
| `local-account reset-password` | `username`, `password` | Replace the verifier, advance the version and revoke local sessions. A disabled account stays disabled. |
| `local-account disable` | `username` | Disable the local account, advance the version and revoke its local sessions. Repeating an already-disabled operation is a no-op. |
| `local-account enable` | `username`, `password`, `forge_token` | Require a disabled account, a new password and currently valid provider credential matching its exact immutable forge/user ID. Preserve the enrolled role and mapping. |

Input is one UTF-8 JSON object bounded to 8 KiB. Unknown, duplicate, omitted, null or action-inapplicable fields fail. The timeout defaults to 60 seconds and accepts 1 second–5 minutes; cancellation of stdin is bounded. Database opening can apply migrations. The command records successful lifecycle events with the actual PostgreSQL role, operation ID and version/count metadata; it does not pretend that a database role identifies a human operator.

For a Compose installation, pipe a correctly shaped document directly from a trusted secret manager or a private operator process; `-T` preserves noninteractive stdin. This example contains no password or PAT in an argument:

```sh
# Standard input must contain the action's complete JSON document.
docker compose exec -T golf /usr/local/bin/golf local-account create --timeout 60s
```

Do not paste actual credentials into shell command text, an interactive history, tracked JSON or screenshots. Successful JSON has `schema_version: "golf.local-account.v1"`, the action, `state: "complete"` and a `result` with account ID, username, optional enrolled email, internal user ID, explicit role, disabled flag, exact decimal credential version and revoked-session count. It contains no password, verifier, token, ciphertext or encryption key. Failure JSON is sanitized. A lost commit response remains ambiguous; inspect operator records before retrying and do not infer rollback from interrupted output.

## Restore quarantine

Schema 202610020008 adds email aliases to the schema007 credential lifecycle. Schema 202610020007 adds a password verifier and persistent encrypted provider credential beyond session records. Deleting restored sessions alone cannot prevent a restored password from reviving an account disabled after backup. Recovery therefore disables every restored local account, including accounts already disabled, and advances its credential version in the same transaction that removes sessions and pending PKCE attempts. It preserves identity, ciphertext inventory and historical events, adds `RECOVERY_DISABLED` account events and reports `local_accounts_disabled_count` in the independent operator ledger and recovery JSON. The count includes every version-fenced local row, not only formerly enabled accounts.

Re-enablement requires an explicit operator decision based on current authority, a fresh password and a freshly validated credential for the same immutable native account. Restored passwords, PATs and provider membership decisions are not authoritative evidence of present access. Keep the installation quarantined while reconciling native post-backup revocations, external issuers, memberships, deletion and outbound work as required by the [recovery runbook](RECOVERY.md). The native schema007 encrypted restore proof passes; it is distinct from historical schema006 evidence.

## Qualification

| Check | Current evidence |
| --- | --- |
| Hash verification, generic denials, input limits and throttling | Pass: fixed-parameter KDF/input tests, generic-denial/no-reflection/origin/cookie boundaries and shared-replica PostgreSQL throttling; actual native429 survives restart. No production capacity or full timing-resistance claim. |
| Immutable enrollment, account version fences, session/API-credential revocation | Pass: real PostgreSQL lifecycle, login/read-disable races, atomic rollback, immutability/history guards, preserved authority on transient/corrupt-credential failures and native session/delegation revocation. |
| Actual provider source reads, repository creation and restart | Pass: isolated native `scripts/local-auth-smoke.py --image <IMAGE_ID> --browser`, including independent local/native role and password boundaries, generic failures, exact Origin, local reset/disable/enable/session/delegation revocation, separate PAT authority, native identity deletion and restart-persistent throttling. Browser password/error/role/cookie/logout/current-revocation/theme/mobile checks also pass. |
| Local-account key inventory, rotation and retirement | Native pass: active and disabled local-account ciphertext counted, drained activation/re-encryption of both rows, eligible old-key removal and subsequent real source access through password login. Real PostgreSQL domain/material binding, persistent-row retirement blocking, rollback and recovery guards pass. |
| Encrypted schema007 restore with local accounts disabled | Pass: both initially enabled and disabled accounts version-fenced/disabled, exact ciphertext/hash/mapping/history preservation and recovery events/counts; old sessions/passwords denied, password-only reset insufficient, wrong identity rejected and deliberate mapped enable succeeds. Existing Git/LFS/attachments/signatures/protection/new writes and whole-stack restart also pass. |

Both native commands passed on 2026-10-02 using qualified Docker image `sha256:44c422c7f61225cb963a8a4e8ec793ec04bb79ce821f739f144ef0c635910d18`. Disposable containers, volumes, networks and private configuration were independently confirmed removed; normal installation/accounts were untouched. This small backup fixture again skipped the minimum-cap negative case and does not qualify large recovery or production RPO/RTO. Final suite/image status is tracked in the [implementation ledger](IMPLEMENTATION_STATUS.md).

Open gates include self-service enrollment/invitations, password reset delivery and recovery, verified email, MFA/step-up, external OIDC, organization/role administration, complete audit/abuse operations and production capacity testing. Both infrastructure tracks share this identity boundary; Cloudflare is optional for the portable core.

### Email login qualification

Schema008 native API and real-browser checks pass on `sha256:58601e2d499e044634dc2c9e738ea08956cd5bd58afe8e1466e2c13c19dd902d`: operator-enrolled uppercase email sign-in creates the same immutable account/role and HttpOnly session, while username login remains supported. Real PostgreSQL race tests cover canonicalization, duplicate-address rejection, email-change session revocation, old-address denial and a shared email/username throttle bucket. The updated encrypted restore drill preserves email aliases and disables/fences restored local accounts before re-enablement. These are additional checks, separate from the schema007 runtime provenance above.

## Package publication scope

New native OAuth consent explicitly requests `write:package` for package publication. Existing consent and local account mappings are unchanged. Namespace ownership does not prove credential scopes: a retained read-only credential requires explicit native re-consent or operator rotation of the mapped PAT before publishing. Golf does not silently elevate those credentials or change native profile visibility.
