# Named repository environments: configuration foundation

This source packet adds local, named repository environment configuration. Every
returned environment and inventory says `CONFIGURATION_ONLY` and
`deploymentAvailable=false`. Saving configuration does not create a deployment,
preview URL, provider connection, approval, timer or queued job. The complete
Environments/previews acceptance criteria in
[the settings implementation plan](REPOSITORY_SETTINGS_IMPLEMENTATION.md) remain
open, including real deployment and preview consumers.

## API and authority

`RepositoryEnvironmentService` has four managed-browser-only procedures:

| Procedure | Purpose |
| --- | --- |
| `ListRepositoryEnvironments` | Current nondeleted inventory; pages of at most 20, exact total and next page. |
| `SaveRepositoryEnvironment` | Explicit creation or version-CAS edit, with a current local Golf password. |
| `DeleteRepositoryEnvironment` | Explicit version-CAS tombstone, with a current local Golf password. |
| `GetRepositoryEnvironmentOperation` | Inspect the caller's original accepted operation and historical version. |

All requests bind the current route, immutable native repository and owner IDs,
and access revision. Reads require current positive ordinary native repository
administration; they may inspect archived or mirror configuration. New writes
require a writable repository and the existing shared Golf lifecycle gate.
Personal owner/direct administrator and positively established organization
owner/member direct administrator paths reuse existing Access/Rules authority.
Golf instance administration, native site administration and an effective team
role alone do not supply exceptional authority.

The direct service methods reject wrong Origin, cross-site and delegated
Authorization/PAT contexts. Root integration must also register all four under
the existing managed-cookie pre-decode boundary and `no-store`; there is no new
bearer/CLI/MCP grant. A bounded 64 KiB JSON request cap is appropriate for Save,
whose encoded policy is at most 16 KiB plus password and target framing.

Current local password verification uses the existing login rate bucket and own
security snapshot before SQL waits. The same account/session/credential version
is checked again after lock waits and before commit. The managed user/session
locks remain held through the configuration transaction. Current native target,
ordinary authority, access revision and configured identities are checked after
waits and before commit. A final native authority observation after commit can
withhold an acknowledgement of an already durable operation. These observations
do not create an atomic native permission fence against external administrators.

## Configuration limits

Names are trimmed, control-free UTF-8, at most 128 bytes. PostgreSQL `lower(name)`
provides the active-name uniqueness key consistently; native IDs, not names,
bind target ownership. At most 100 active environments are retained per native
repository/owner. Pages search neither other repositories nor deleted rows.

Policy is a closed, bounded schema:

- Either all sources or at most 20 unique exact typed BRANCH, TAG or COMMIT
  selectors. Branch/tag names are literal restrictions, may refer to future
  names, and do not assert a current head or glob match. COMMIT requires a full
  lowercase 40/64-character ID independently verified through the existing exact
  native object source API. Default-branch guesses and globs are refused.
- At most six unique native reviewer ID/canonical-login pairs, independently read
  from supported native user APIs. Required approvals cannot exceed that list;
  zero approvals requires an empty reviewer list. Configuring a reviewer does
  not grant current approval authority or record an approval.
- Independent approval separation is always enabled; administrator bypass is
  false-only until a real deployment consumer qualifies another policy.
- Wait 0–86400 seconds, concurrency 1–10, protected previews required, preview TTL
  60–604800 seconds.
- Unknown fields and oversized encoded policies are refused; destination
  credentials and arbitrary provider configuration are absent.

Delete does not require a historical reviewer or commit still to exist; current
repository authority and the exact saved version are required to remove stale
configuration safely. The tombstone retains the original policy as history.

## CAS, original receipts and retention

The client supplies canonical UUIDv4 environment and operation IDs and a
canonical decimal expected version (`0` creates, positive values edit/delete).
Every accepted change advances exactly one version. Deleted IDs are permanently
immutable; reusing the released name requires a new environment UUID.

The transaction atomically writes current selection, immutable version and one
original operation receipt. Per-repository serialization covers name uniqueness
and quotas across different issuers. User/session locks precede the shared
lifecycle lock, then the environment repository lock. Inventory reads take the
matching shared environment lock so count and page describe a coherent local
inventory. No new deployment reservation or lifecycle active-work count is
invented for configuration.

Original intent fingerprints preserve the typed target, action, expected version,
name and ordered policy presence/content. Passwords and password hashes are
excluded. The journal stores no credentials and performs no native mutation.
Same-key changed intent is refused. An exact replay only returns the accepted
historical version under current ordinary authority; it never applies another
edit. Status lookup is issuer-scoped and target-ID-bound. A current operation
lookup target may carry a new current revision; the returned environment target
and operation target remain the original accepted observation and route.
Inventory's top-level target is the current authority observation; each saved
version retains its accepted target, including a prior access revision or route.
Consumers must use the fresh inventory target for a new reviewed edit.

`SUCCEEDED` describes the local SQL transaction only. Lost acknowledgement,
storage or transport failure is not permission for an automatic retry or a fresh
operation ID. Inspect the original operation after authority is restored.
`ABORTED` describes a stale version. There is no synthetic native dispatch phase
or background resumption. No shared repository activity, email or webhook event
is emitted by private configuration changes or original status/replay reads.

A repository permits up to 900 save-operation receipts, with a separate reserve
through 1000 total operations for tombstoning the at most 100 remaining active
environments. History is append-only; name/identity/tombstone and creator
metadata are enforced by SQL guards. No online purge is provided. Retention
exhaustion refuses changes; an offline retention/recovery policy needs separate
qualification. Existing logical backups include these ordinary Golf tables; no
new credential crypto family or key retirement behavior is introduced.

## Root integration and evidence

The isolated packet owns migration 055, its sqlc queries/generated model,
additive proto/generated descriptors, new environment service and tests. It does
not register shared RPCs, API clients, routes or UI. Root must merge additive
proto changes, regenerate combined models, register managed procedures, apply the
migration to a disposable test database and run `TestEnvironment.*Postgres`.

Pure source tests exercise policy bounds, literal namespaces, intent ordering and
password exclusion, historical receipt identity, and browser boundary rejection.
Authored PostgreSQL cases cover version/replay/edit/delete and tombstone ABA,
current authority and password, unique names and bounded pagination, competing
CAS, authority revocation after lock wait, immutable SQL creator binding,
committed-but-withheld receipt inspection, and independently bound source/reviewer
references. They are not actual PostgreSQL/native/served evidence until run by
root. No native writes, live fixture, Docker, provider inference or deployment was
performed for this packet.

Before enabling deployment, a genuine consumer must freeze an environment ID and
version with exact native repo/owner/source/destination identities, recheck current
source and approval authority, enforce independent approval and waits, claim
concurrency under the shared lifecycle gate, enforce protected preview TTL and
revocation, and retain honest once-only provider effect receipts. Environment
secrets, deployment destinations, temporary links, live deployment/DNS and both
infrastructure tracks remain implementation work; this foundation does not close
those requirements.
