# Repository automation grants

This increment stores explicit personal delegation for future unattended work. A grant does **not** execute pushes: materialization and native push-to-executor qualification remain unavailable. Schema020 implements explicit run origins and shared grant-bound worker/result fences; that prerequisite does not turn a saved grant into an executing pipeline. [Implementation status](IMPLEMENTATION_STATUS.md) records exact qualified revisions.

## Authority and scope

All three Connect methods require a current browser cookie and matching Origin. Read-only API bearer credentials cannot list, create or revoke grants. Current native repository owner/admin permission is checked before and after the operation, with an additional fresh observation immediately before mutation. Immutable repository/owner IDs and organization kind must agree. Instance administration is not native repository impersonation. Independent native permission edits can race Golf SQL; this is not atomic cross-provider authorization.

Create requires an explicitly supplied personal native PAT independently resolving to the current human's immutable native user ID, current repository write/admin/owner access, a nonarchived/nonmirror repository and readable selected workflow files at the independently resolved immutable default-branch commit. The native contents API does not accept `HEAD` as that reference. The browser's existing native credential is never copied implicitly. Dedicated-account enrollment and OAuth credential refresh are not supported by this grant slice. The native token retains its provider-issued scopes; Golf's grant does not reduce that token's authority outside Golf.

Each grant permits only `push` on 1–20 unique exact branch names and 1–20 exact supported workflow paths. No patterns, tags, source-selected URLs, arbitrary commands, merge or deployment authority are admitted. Expiry is more than one minute and at most 30 days away at creation. At most eight unexpired enabled grants per sponsor/repository are accepted. These bounds do not implement aggregate queue quotas, concurrency budgets or automatic fan-out.

The repository workflow settings page shows a shared searchable/sortable/paginated inventory. Editors open through New; Revoke uses a confirmation dialog. Private tokens clear immediately on submission, cancellation, pagehide and permission loss and never appear in inventory or receipts. Metadata/revocation remain available to current admins for archived repositories; creation remains separately denied there. Pagination is a live UUID keyset inventory (25 records/server page), not a frozen snapshot; loaded-page search/sort does not search unloaded records.

## Persistence, revocation and ambiguous outcomes

Schema `202610020019` separates immutable encrypted credential identity from grant lifecycle and append-only actor history. The current credential version is fixed at1; token replacement requires revoking the old grant and explicitly creating another. No plaintext token, raw webhook body or browser session hash is stored in a grant. Stable sponsor identity is attribution; future execution cannot treat it as a live browser session.

Create carries a canonical UUIDv4 idempotency key. The exact request digest (including the secret only inside the digest) is stored under the canonical forge/sponsor/key. Same request replay returns the same current grant; changed inputs return failed_precondition. Current access and valid creation inputs are required even for replay, so expired historical requests are not an indefinite lookup API. List provides current inspection instead. A lost response is unknown until explicit inspection; the UI never automatically resends a credential-bearing mutation.

Creation/revocation lock the current Golf caller/session and require a current source session before commit. Source browser logout does not revoke an already committed grant. Revoke requires exact current revision, increments revision/revocation epoch and appends the actor event in the same transaction. Repeated revoke at the current disabled revision is a no-op; a stale revision fails. Audit insertion failure rolls back the lifecycle change. The supplied native PAT itself is not revoked by Golf grant revocation.

Local sponsor disable permanently revokes enabled grants and records SPONSOR_DISABLED in the same local transaction. A PAT session cannot create new grants for a disabled local sponsor. Re-enable never resurrects old grants. Password changes and ordinary logout affect sessions independently. The explicit stopped-writer recovery primitive revokes **all** restored enabled grants, including PAT/OAuth-only sponsors, and records RECOVERY_REVOKED; canonical schema019 three-service backup/fresh restore is qualified separately. Schema020 automatic-origin recovery and RustFS/worker topology recovery remain unqualified; the recovery script deliberately rejects schema020 until its full drill passes.

## Encryption and key lifecycle

AES-256-GCM uses the distinct `automation_repository` domain and an encoded SHA-256 binding over grant UUID, credential version, canonical forge and native user ID. Ciphertext transplantation across grant, user, provider or domain fails. Credential identity/version/binding/timestamp are immutable; operator rotation may rewrite only ciphertext/key label. Retained revoked/expired credentials remain stored key uses.

Key status, missing-key startup denial, permanent material binding, bounded legacy validation, total cross-family SKIP LOCKED rotation, crypto audit and retirement refusal include this fifth credential family. Rotating encryption does not rotate the native token or change logical authority. See [credential keyring](CREDENTIAL_KEYRING.md).

## Verification and remaining work

Real PostgreSQL tests cover concurrent idempotency, changed input, admin/foreign-token denial, encrypted binding, logout/restart persistence, audit rollback, revision fencing, recovery quarantine and local sponsor disable/re-enable. HTTP-boundary tests cover actual procedure registration, unauthenticated and Origin denial. Browser tests use typed protocol fixtures, not a native provider. The disposable native qualification command is:

```sh
python3 scripts/automation-grants-smoke.py --image <qualified-local-image-sha>
```

It must prove actual native create/read/logout/restart/revoke and denial behavior before native compatibility is claimed. Neither this grant nor the push compiler/policy switch closes automatic execution, five agent integrations, notification delivery, protected merge, engine parity, scaling or recovery gates. The next integration is [automatic shell CI](LOCAL_AUTOMATION_IMPLEMENTATION.md).

Native qualification passes on image `sha256:920308a328afaffbb4ef9ffb992691449a8fe19b509840dccd2d513ef4858557`. The fixture uses actual native ordinary owner/reader/outsider accounts and immutable-SHA workflow reads; actual grant create/list, same-intent replay/collision, encrypted projection, logout independence/restart, revoke/current-revoked replay and actor audit pass. Origin, anonymous, bearer, nonadmin, foreign identity/scope, wrong resource IDs and bounds deny. Source is unchanged and no automatic run is created. All disposable containers, volumes, network and private configuration are removed. This proves native grant lifecycle rather than unattended execution or whole-stack restoration.
