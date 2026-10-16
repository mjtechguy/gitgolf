# Repository deletion source contract

This is a bounded owner-only source consumer, not qualified deletion readiness.
Migration054 and the PostgreSQL fault/concurrency consumer cases pass the root's
managed test run (54.113s), including positive requests through Server.ServeHTTP.
These use an owned controlled native provider and synthetic profile, not actual
native deletion, deployment or bootstrap enrollment.

## Native boundary and availability

Pinned native1.27.3 provides owner/name-addressed
`DELETE /api/v1/repos/{owner}/{repo}` and reports successful completion with204.
The immutable-ID `/repositories/{id}` route is GET-only. The deletion handler
has no expected repository ID, revision or native conditional-write receipt.
Its supported admin command inventory does not provide a repository deletion
command. These are primary-source observations, not live native proof:
[API routes](https://codeberg.org/forgejo/forgejo/src/tag/v15.0.9/routers/api/v1/api.go),
[delete handler](https://codeberg.org/forgejo/forgejo/src/tag/v15.0.9/routers/api/v1/repo/repo.go),
[admin commands](https://codeberg.org/forgejo/forgejo/src/tag/v15.0.9/cmd/admin.go).

Address replacement or rename between Golf's observation and native dispatch
cannot be closed by a Golf revision, UUID, typed name or header. Consequently
`deleteAvailable` defaults false. Dispatch requires the existing, independently
enrolled managed-Git private-native incarnation profile, with positive native
version/source/image/runtime/receipt metadata, current unsuspended state and
known-disabled native Actions. The source foundation conservatively also
requires no mirrors, branch protections or tag protections. A managed archive
latch, active work or unresolved operation prevents new deletion. No environment
checkbox, public enrollment RPC or operator enrollment command is added here.
The trusted fresh-bootstrap producer/ingress qualification remains unimplemented;
ordinary and adopted installations cannot turn deletion on through this API.

A synthetic profile inserted only into an owned Golf test database exercises
the consumer. Such a row is not evidence of actual native quiescence, private
ingress or qualified production enrollment. Root must not use a synthetic row
to enable deletion on the retained developer installation.

## Browser contract

The existing `RepositoryLifecycleService` gains two managed-browser procedures;
no API bearer, CLI or MCP write authority is added.

| Procedure | Request | Response |
|---|---|---|
| `DeleteRepository` | canonical repository key, exact positive-decimal repository/owner IDs, displayed lifecycle revision, exact full-name confirmation, current local password, original UUIDv4 operation key | retained lifecycle operation |
| `GetRepositoryDeletionOperation` | original canonical key, original repository/owner IDs, original UUIDv4 key | retained lifecycle operation only |

`RepositoryLifecycle` adds `deleteAvailable` and `deleteNotice`;
`RepositoryLifecycleOperation.action` distinguishes `archive_state` from
`delete`. The deletion receipt preserves the original archived snapshot in both
archive fields; it never invents an archive transition. Existing archive intent
fingerprints and their phase semantics are unchanged.

Origin, managed cookie, current native actor, ordinary actual personal ownership
or independently proved current organization ownership, native administration,
current local password and password/session credential version are mandatory.
Golf instance administration and native effective administration do not replace
ordinary ownership. Unsupported OAuth password step-up remains unavailable.

## Once-only effect and retention

The same lifecycle journal holds immutable action, owner-kind, actor, native
target, canonical historical address, displayed revision and fingerprint. It
never retains passwords, provider credentials or response bodies. Account and
session locks precede the repository lifecycle gate. Reservation is serialized
against the existing workflow, agent, reviewer, Git, invitation, access and rules
admission families; prior active-count wrappers remain installed.

`RESERVED` is durable before `DISPATCH_UNKNOWN` is committed. Exactly one native
DELETE may follow. Its dispatch transaction holds current account/session and
the shared repository gate, rechecks the exact native target/revision and actual
owner, and holds the positively qualified incarnation row against suspension.
The private forge permit is bound to that exact retained deletion row; it cannot
authorize other methods, subpaths, targets, revisions or archive intents.

Only the actual native204 followed by current actor/organization ownership and
password/session checks and a durable `SUCCEEDED` commit confirms this operation.
Neither404 nor an unexpected200 confirms deletion. Native errors, cancellation,
missing response, authority loss or storage/commit uncertainty remain
`DISPATCH_UNKNOWN`. Even a known refusal after that uncertainty marker remains
inspection-only; there is no automatic retry, lease expiry, recovery worker or
replacement-key bypass. A stale displayed revision refused before dispatch is
durably `REJECTED` with `preflight_refused`.

Exact-key replay reads the retained result without native mutation or renewed
password confirmation. Changed target/revision/action with that key is refused.
After deletion, status verifies the original actor and, for organizations, the
current exact original organization identity, membership and actual ownership.
It does not GET a repository at the historical address, adopt a replacement or
grant current repository access. A successful original-ID deletion remains a
permanent managed admission fence. One verified success emits one metadata-only
source activity; rejected/unknown operations do not emit success activity.
Journal history, phase events and owner-kind are retained and immutable;
automatic downgrade, truncation and journal deletion are refused.

## Evidence and remaining acceptance

Three pure/browser-caller source guards pass under race; package compilation,
vet, protobuf lint, generated-query drift and whitespace checks pass. Authored
PostgreSQL cases pass in the root's disposable database: default unavailable/no
reservation, personal and current-org owner204, wrong password, exact replay,
replacement non-adoption, non204/lost receipt, actor/org/owner drift, stale
revision rejection, prior-family active work, suspended qualification,
concurrent replay, held logout and canceled response.

Full deletion readiness still requires independently supported fresh private-
native bootstrap/enrollment and all applicable producer, identity, namespace
and protected-write exclusions; actual native API/response-loss/role/replacement
qualification; served UI confirmation/status/denied states; recovery/retention
qualification; and qualified immutable-target CAS or complete managed ingress
mediation. Transfer/acceptance, retained content purge, external native ingress,
SSH/LFS and P0.8 protected operations remain separate open requirements.
