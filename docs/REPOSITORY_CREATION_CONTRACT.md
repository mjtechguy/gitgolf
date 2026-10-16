# Durable repository creation

Updated: 2026-10-02. This P1.3/P2.2 increment adds durable own-account creation evidence to the existing supported Forgejo API path. Real PostgreSQL, native forge, production-served browser, counted provider-response-loss and coordinated restore checks passed in an earlier native qualification on a since-retired backend and have not been repeated on Forgejo 15.0.9; qualification is recorded in [the implementation ledger](IMPLEMENTATION_STATUS.md). It does not implement a general job scheduler, transactional outbox, tenant administration, protected publication or exactly-once external effects.

## API and retry boundary

`RepositoryService.CreateRepository` accepts `name`, `description`, explicit `private`, and optional `idempotency_key`. Supply a canonical lowercase UUID v4 for retryable clients. The key is scoped to the immutable Golf account and configured forge. Another account cannot read the operation or reuse its authority. Keys currently have no expiry or automatic deletion.

The fingerprint is SHA-256 of a fixed-field JSON encoding of the exact name, description and private boolean. Names follow the existing 1–100 character repository-name grammar; descriptions must be valid UTF-8 and at most 2,000 bytes, and visibility must be explicit. Inputs are validated before reservation. Reusing a key with different inputs fails with `failed_precondition`; changing whitespace or visibility is a different input. The description is sent to Forgejo but not retained as operation text. An operation key is correlation data, never authentication.

Every new create intent, including legacy unkeyed calls, reserves an `OUTCOME_UNKNOWN` operation and appends its initial event in one PostgreSQL transaction **before** the provider POST. Replays read the existing record without adding another initial event. Only the transaction that inserts the new operation may dispatch. A repeated key never sends another POST, including after restart, timeout, cancellation or a lost response. A failed reservation cannot dispatch. A lost reservation commit response may therefore leave an unknown operation that never reached Forgejo; this is an honest ambiguity, not a retry instruction.

| Recorded state | Meaning |
| --- | --- |
| `OUTCOME_UNKNOWN` | The dispatch was reserved. Work can still be in flight, may never have reached Forgejo, or may have completed without a usable/committed response. Inspect it; do not automatically create again. |
| `SUCCEEDED` | A valid native success response identified the requested owner/name/visibility and positive repository ID, and Golf committed that evidence and event together. It does not grant current access or prove the repository still exists. |
| `REJECTED` | Golf committed an observed native HTTP 400, 401, 403, 404, 409 or 422 rejection and a bounded `provider_http_<status>` category. A new user-authorized intent is separate from replaying this key. |

Other statuses, transport failures, invalid/oversized native responses and uncertain persistence remain unknown. Native response bodies, provider credentials and full request descriptions are not stored in the operation/event tables or returned as diagnostics. An observed native result gets a short bounded synchronous persistence attempt even if the requesting client disconnects; this never retries the external write.

Keyed callers receive a typed creation record for observed/replayed states. Check the state; an HTTP 200 containing `OUTCOME_UNKNOWN` or `REJECTED` is **not** creation success. Unkeyed callers retain previous safe RPC error behavior and receive a generated key with successful responses. A failed unkeyed response does not expose that generated key for client lookup. Repeating an unkeyed request allocates another operation; it does not provide retry deduplication. Different keys also represent different intents. Forgejo's name uniqueness is not proof of operation-level idempotency. The [upstream create handler](https://codeberg.org/forgejo/forgejo/src/tag/v15.0.9/routers/api/v1/repo/repo.go) calls native repository creation and returns a repository or error; it does not implement this client-key protocol. Golf's durable reservation provides the one-dispatch boundary for this endpoint, without a native exactly-once guarantee.

## Inspection and authorization

`RepositoryService.GetRepositoryCreation` looks up an exact key within the authenticated account/forge scope. Missing and foreign keys return `not_found`. Current native user identity, live Golf session, absolute expiry and revocation are checked through the same managed-session path used by account operations.

A successful create/replay/inspection returns repository metadata only after a current supported Forgejo read of the recorded path, with the same recorded repository ID. Deletion, rename, permission/scope loss or replacement at that path can leave the recorded state successful with no repository object. A replacement must never be adopted as this operation's result. Transient provider failures remain visible. Caller authorization is rechecked after provider waits; a revoked/expired caller cannot obtain the result.

These are scoped reads and admission checks, not an atomic distributed reservation of provider policy. A local session revocation or client cancellation cannot undo a native write already admitted/in flight, revoke its underlying provider grant, or fence a paused provider request. This mechanism does not close the [protected integration gate](decisions/0004-protected-integration-enforcement.md).

## Browser and CLI

The browser generates one cryptographically random UUID per explicit intent, freezes its submitted inputs, and reuses them on retry. A synchronous submission latch prevents duplicate form events in the same render batch from allocating two keys before the disabled UI renders. An unresolved transport/provider outcome keeps the same key and offers status inspection. Editing/new intent is not automatically enabled by an unknown outcome. A known rejection can allow an explicit new intent.

Browser session storage retains only the pending key, name and visibility, scoped by exact browser origin and the current native Forgejo user ID exposed by the session API; it does not use Golf's internal database identity and stores no description or credential. Closing/reopening the dialog or reloading the same tab resumes **inspection only**, never an automatic POST. Closing the browser tab may discard session storage; this is not a durable client-side operation index. Authentication changes clear private pending state alongside existing query caches. A resumed pending record cannot reconstruct an omitted description or automatically resubmit it. Browser state is convenience data and cannot authorize a server operation.

The read-only CLI adds:

```sh
golf --url http://localhost:8080 --token-stdin repo creation 12345678-1234-4234-8234-123456789abc
```

The command uses the existing ephemeral scoped PAT/session path, writes `golf.cli.v1` Protobuf JSON, and signs out before releasing the result. It only inspects; it cannot create, redispatch or resolve an operation. Unknown is valid recorded data, not a CLI execution-success claim.

## Storage, recovery and remaining work

`golf_repository_creations` owns request fingerprints, requested name/visibility, identity/key, timestamps, bounded state, native result ID/path and rejection category. `golf_repository_creation_events` records initial and terminal transitions independently of account session history. State and its event commit together; ordinary UPDATE/DELETE/TRUNCATE guards protect the event ledger. Database owners can alter guards. Application completion conditionally transitions only an unknown operation; no supported API edits/deletes history or redispatches it.

The coordinated Docker backup includes both tables and events. Restoring sessions still invalidates credentials; it does not remove captured operation evidence or launch operations. An older backup cannot include keys or terminal observations created after capture; the one-dispatch guarantee depends on retaining the authoritative operation record. Operators must reconcile post-backup changes, native revocations/deletions and ambiguous in-flight effects before reopening a restored installation. Neither backups nor a timeout prove that a previously accepted provider request cannot still complete.

Unknown outcomes need operator inspection through supported native interfaces and authoritative evidence. An existing repository name alone does not prove which operation created it. There is no automatic adoption, manual-resolution API, worker/outbox delivery, multi-operation workflow, retry lease, global account quota, retention/export policy or organization/tenant authorization supplied by this increment. Future issue/import/agent/deployment mutations need their own operation-specific contracts and evidence; this one must not be generalized into an exactly-once broker.

## Runnable evidence

Run locally; no repository CI is configured. Supply `GOLF_TEST_DATABASE_URL` through a private environment for a dedicated disposable PostgreSQL database, never the normal installation.

```sh
go test -race ./... -count=1 -timeout 120s
make check
npm --prefix web test
make build
# Real pinned Forgejo/current Golf, temporary supported-API fixtures.
python3 scripts/repository-creation-smoke.py --restart --cli bin/golf --browser
# See the dedicated-database preparation requirements below before this command.
python3 scripts/repository-creation-fault-smoke.py \
  --server-binary bin/golf-server \
  --database-url-file .tmp/creation-verification/database-url
# Current image, fresh coordinated restore including operation/event history.
python3 scripts/recovery-smoke.py --image '<LOCAL_GOLF_IMAGE_TAG_OR_ID>'
```

The fault proof requires a **fresh dedicated PostgreSQL 18.4 Docker container**, a loopback-only published port and an empty `public` schema in its `postgres` database. Before running, prepare two private, invoking-user-owned regular files with mode `0600` in the same private directory: `database-url` contains that container's DSN; `container-name` contains its exact `golf-…` Docker container name. The harness checks the version, empty schema and correspondence between the DSN port and Docker's loopback port binding. The DSN is read from the file and passed to the child through its environment; it is not a command argument or diagnostic. Coordinate exclusive use of this database. Random schemas used by unit tests are separate from its required empty `public` schema.

The fault harness starts a private Golf process and a fixed loopback proxy to the local Forgejo at port 3001. It creates and removes only its temporary native users/repositories; normal Golf configuration and database are not used. Child servers, private logs and native fixtures are cleaned up. The supplied PostgreSQL container and its resulting test data remain owned by the invoking operator: remove that specifically named disposable container afterward, or provision a new empty instance for another run. Do not repoint the command at normal data or erase a live schema to satisfy its precondition.

| Evidence | Observed outcome |
| --- | --- |
| Full real PostgreSQL race suite and `make check` | Pass: atomic reservation/events; concurrent deduplication and exact-input conflicts; rollback including deferred commit failure; PAT/OAuth identity/session gates; current native access/ID binding; cancellation and post-wait revocation; additive migration and history guards. |
| Browser fixtures | 72 Playwright checks pass (21.8s), including same-batch duplicate-submit prevention and Unicode/UTF-8 byte bounds; the final `failed_precondition` fixture target, TypeScript check and production build also pass. |
| Native creation, restart, CLI and browser | Pass: success/rejection and narrow-scope behavior, own-account/foreign-key privacy, deleted/same-name replacement denial, access loss, CLI output/ephemeral cleanup and restart. A real create response was dropped downstream of Golf; browser reload performed status inspection only. Dark/mobile/keyboard and revoked-session cleanup pass. |
| Counted native response loss | Pass: the actual native forge accepted creation with HTTP 201, then the proxy discarded the acknowledgment before Golf received it. Golf retained `OUTCOME_UNKNOWN` with no repository adoption; repeated create/lookup and actual backend restart left the proxy count at exactly one POST. Foreign-account and revoked-session access were denied; private/native fixtures were cleaned up. |
| Fresh coordinated schema 202610020004 restore | Pass: serialized operation and event rows were byte-equivalent before/after restore; authenticated own lookup and same-key replay retained the original result, foreign lookup returned 404, and neither journal changed. Native Git/LFS/attachment/protection/SSH/signature, new-write and whole-stack restart checks and cleanup also pass. The small fixture explicitly skipped its minimum-cap negative case. |

These proofs, gathered on the since-retired backend, qualify this bounded own-account path; they have not been repeated on Forgejo 15.0.9. They do not establish 8 GiB/load capacity, production recovery targets, a protected publisher, jobs/outbox, organization/tenant authorization or automatic unknown-outcome resolution.
