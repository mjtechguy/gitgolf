# Credential encryption keyring

Status: implemented developer-preview contract. Final real-PostgreSQL and old-binary PAT/pending-verifier qualification is recorded below. Live OAuth exchange across a key change remains unqualified. Consult the [implementation ledger](IMPLEMENTATION_STATUS.md) before treating a scenario as verified. [ADR 0005](decisions/0005-credential-keyring-and-drained-rotation.md) records the bounded design and remaining guide disposition.

## Scope

The keyring covers encrypted Golf PAT/OAuth session credentials and pending OAuth PKCE verifiers. It uses the existing concrete AES-256-GCM codec on both infrastructure tracks, without Cloudflare, AI, KMS or a new encryption service. It does not rotate provider tokens, the OAuth client secret, database passwords, signing keys or Git credentials.

Migration `202610020002_credential_keyring.sql` adds a `credential_key_id` to both `golf_sessions` and `golf_oauth_attempts`; existing ciphertext bytes remain unchanged under label `legacy`. Existing session/callback bindings, absolute expiry and credential kind remain intact. Nonlegacy encryption authenticates its format/domain, key label and existing 32-byte session/state binding as associated data. Legacy decryption preserves its original associated data. Callback consumption decrypts using the exact persisted label before deletion, then rechecks state, browser binding and expiry using database time after a row-lock wait. A verifier that expires while waiting is retained rather than consumed; unknown-key/authentication failures also preserve its row. An explicit algorithm column, age migration and envelope/KMS design are not added by this increment.

## Configuration

Supply secrets through the operator environment or deployment Secret, never command arguments or committed files.

| Variable | Contract |
| --- | --- |
| `DATABASE_URL` | Golf's database connection, including schema/migration permissions for operator commands. Never point it at Gitea's database. |
| `GOLF_ENCRYPTION_KEY` | Existing canonical padded base64 encoding of exactly 32 random bytes. When supplied, this configures the reserved `legacy` label. |
| `GOLF_ENCRYPTION_KEYS` | JSON object mapping labels to canonical padded base64 32-byte keys. Maximum 16 total keys, including legacy, and 16 KiB JSON. Duplicate labels and non-string values are rejected. |
| `GOLF_ACTIVE_ENCRYPTION_KEY` | Configured write label, which must exist in the effective keyring. Required when the JSON keyring is supplied. With only the old single-key configuration it defaults to `legacy`. |

Labels contain 1–64 ASCII characters: the first is alphanumeric; remaining characters may also contain `.`, `_` or `-`. Supplying `legacy` in both the JSON keyring and the old variable is allowed only when the bytes match. Retain every key whose label still appears in either credential table, including expired rows.

The database stores one active write label and a permanent SHA-256 material binding for each registered label. Legacy material is authenticated and registered during upgrade bootstrap; standby labels are bound when explicitly activated. A registered label cannot be reused for different material. Removing its environment entry does not remove its binding. Ordinary updates/deletes/truncation of registered bindings are rejected; a sufficiently privileged database owner can alter the guards. No key material or fingerprints appear in operator results.

Runtime startup requires the configured active label to match database policy, all labels with stored uses to be configured, and their registered material bindings to match. A configured unused standby key need not be registered yet. On a fresh JSON-only installation, run the explicit activation command before starting Golf with a nonlegacy active label; the migration initially creates policy `legacy` even when the credential tables are empty.

Compose forwards all three encryption variables. Helm reads them from its existing Secret as individually optional entries; a valid complete encryption configuration is still required at runtime. Changing a Secret or environment source does not update an already running process. Deployment-specific restart/rollout qualification remains separate from this contract.

## Operator commands

These commands run in the **server/operator binary**, connect directly to Golf's database and do not start the HTTP server. They are not commands in the user-facing `bin/golf` read-only CLI and do not authenticate using a browser session or provider token. Build the server with `make build`, then use:

```sh
./bin/golf-server keys status
./bin/golf-server keys activate
./bin/golf-server keys rotate --batch-size 100 --max-batches 10
./bin/golf-server keys retirement-check --key-id legacy
```

Each assumes the database and encryption environment has already been supplied securely. The container binary is `/usr/local/bin/golf`; a one-off Compose command uses the configured service environment without starting its web listener:

```sh
docker compose run --rm --no-deps golf keys status
```

Use the same form for other key commands only within the drained activation procedure below. `--no-deps` assumes the configured database is already available. A container built from the new source is required; these examples do not build or deploy an image.

| Command | Behavior |
| --- | --- |
| `status` | Report database/configured active labels and configured/per-table use counts, including expired rows. It can apply migrations and perform the initial legacy-material bootstrap; it is not a strictly read-only command. |
| `activate` | Register/verify the configured active label's material, then atomically change database policy and record `ACTIVE_KEY_CHANGED`. Existing ciphertext is unchanged. Selecting the already-active label succeeds without inventing a change event. |
| `rotate` | Re-encrypt nonactive credentials to the configured/database active key in bounded transactions. Defaults: 100 total rows per batch, at most 10 batches. Limits: 1–1,000 rows and 1–100 batches. |
| `retirement-check` | Require a configured, registered, inactive label with zero stored session **and** OAuth-attempt uses, then record `RETIREMENT_CHECKED`. No secret or database binding is erased; the label is not permanently disabled. |

All commands accept an overall `--timeout` between `1s` and `5m`, default `60s`. Parse errors use a safe usage message. Completed operation output uses a separate JSON envelope, `schema_version: "golf.keys.v1"`, with `action`, `state`, optional `key_id`, `result` and safe `error`. States are `complete`, `partial`, `eligible`, `failed` or `interrupted`. A bounded successful rotate can exit zero with `state: "partial"`; inspect state and remaining counts, not exit code alone. Failures return nonzero. Credential/key/DSN values are not output.

The `result` for mutations includes an operation ID, committed batch/row counters, completion flag and status. Status carries `active_key_id`, `configured_active_key_id` and sorted `keys` entries with `key_id`, `sessions`, `oauth_attempts` and `configured`. These operator counts are JSON integers, not the generated API's decimal-string uint64 contract; avoid lossy number handling. A lost output or interrupted process is an unknown client outcome: inspect current status before retrying. Earlier committed batches survive a later failure; there is no whole-command rollback or retry-idempotency token.

## First upgraded start and status

The first operation authenticates **every existing legacy session and OAuth-attempt ciphertext**, including expired entries, before registering legacy material. It holds the operator and exclusive policy locks in one transaction, reading at most 500 rows per query. This is bounded memory per page, not a bounded total scan or resumable bootstrap; a large installation may exceed the deadline. Runtime bootstrap has its own 60-second deadline. No ciphertext is rewritten or deleted by bootstrap.

Wrong legacy material, corrupted ciphertext, missing required keys or a binding mismatch fail visibly rather than purging credentials. Preserve the database and original keys while investigating; substituting a new random key under the old label cannot recover data. Later status calls verify configured registered bindings without repeating the full legacy scan. Status does not perform a full integrity scan of nonlegacy ciphertext.

## Drained activation and resumable re-encryption

1. Preserve a coherent backup/recovery path for the database and all current key material. Prepare a new label and independently generated 32-byte secret. Keep old keys available, and ensure every intended new process/operator uses the same material for each label.
2. Stop admission and drain **all old Golf writers**, including background/operator processes and in-flight OAuth exchanges. Stop the old application instances before activating. This is a maintenance operation, not a transparent rolling cutover. The command cannot discover or drain a fleet for the operator.
3. Supply the complete keyring with the new configured active label to the one-off operator process. `status` can show the intended label while database policy still uses the old label. Run `activate` and inspect its result. Do not attempt to start normal Golf with a configured active label that differs from database policy.
4. Start only instances configured with the new active label and all still-required read keys. Validate their availability and existing authenticated workflows. New ciphertext uses the active label; old labeled ciphertext remains readable while its key is retained.
5. Run bounded `rotate` invocations and inspect status after each. Each transaction locks/skips busy rows, processes sessions first and then OAuth attempts within the same row limit, rewrites ciphertext/key label, and appends one operator event atomically. Busy rows can yield a partial result with no progress; resume later. Do not remove old keys while either table still refers to them.
6. Once both counts for the old label are zero, run `retirement-check`. Its eligible result concerns the current database only. Separately review backups, other installations, external secret stores and stopped process environments before removing an old key from active configuration. Preserve recovery material required by older backups under the operator's retention policy.

The database write trigger takes a shared policy lock and rejects a credential insert/update whose label differs from active policy. Activation takes the exclusive policy lock; rotation operators serialize per transaction. These mechanisms order database writes and prevent stale nonactive-label ciphertext from being committed. They cannot undo a provider refresh token rotation that already occurred before a rejected database write. Failure can therefore still require user sign-in if old in-flight issuers were not drained. A database owner can alter this fence; it is not an external trust boundary.

Rotation does not change session IDs/cookies, identity, expiry or provider credentials and does not itself create a user Account activity event. Its operator event is separate from user lifecycle history. The initial live proof below covers PAT sessions and a pending verifier; full OAuth exchange/refresh qualification remains pending in the ledger.

## Metadata, retirement and recovery limits

`golf_crypto_events` records `ACTIVE_KEY_CHANGED`, `CREDENTIAL_BATCH_REENCRYPTED` and `RETIREMENT_CHECKED` with time, operation ID, label, per-table counts and PostgreSQL `current_user` as actor. It does not identify the individual human behind a shared database role. Policy changes and nonempty re-encryption batches commit with their corresponding event; no event is created for an unchanged active policy or an empty batch. The table rejects ordinary update/delete/truncate, subject to the same database-owner limitation. There is no public operator-event API/UI, external sink, retention/export workflow or credential-key audit claim beyond these recorded operations. Bootstrap registration is metadata, not a fabricated activation event.

Retirement counts include expired sessions and expired OAuth attempts; deleting or overlooking expired rows is not an implicit retirement shortcut. An eligible check never erases keys from environment files, memory, backups, logs or an external secret manager. It does not revoke provider access or make a previously exposed credential safe. The same registered material can be explicitly activated again; retirement-check is evidence, not a permanent retired-state policy.

The migration's down path refuses while policy or any stored credential uses a nonlegacy label. Returning to legacy would require a deliberate drained activation and complete re-encryption with the original retained legacy key. An allowed down migration removes key metadata and crypto-event history; it is not automatically run by binary rollback. An old binary after nonlegacy activation cannot read the new format or safely write credentials. Recovery into a fresh installation, restored backups, Kubernetes cutovers, multi-replica rolling activation, emergency key compromise, envelope/KMS/age migration and FIPS assurance remain separate qualification work.

## Evidence and remaining qualification

`python3 scripts/keyring-smoke.py --legacy-server .tmp/key-verification/pre-key-server` passes against isolated PostgreSQL 18.4 and an ordinary user on the actual local Gitea. The old binary was built from exact commit `f79bf6f6645dbe5eaf01b4d613a2d277e7eb212e`. It creates PAT sessions and a pending PKCE attempt before draining; the new operator migrates and bootstraps while preserving ciphertext, session IDs, binding hashes, expiry and credential kind byte-for-byte. Existing cookies then work on the new server. Three PAT cookies retain exact session metadata through drained activation, a new-key login, one-row partial rotation, restart/resume and removal of legacy material. A pending PKCE verifier rotates and is authenticated/consumed by a denied callback. Stale legacy ciphertext updates fail at the database fence; startup with different material under the same registered label fails without deleting session rows. The harness removes its database/container, provider user and temporary process and leaves normal Golf configuration unchanged. This proves that specific old-to-new schema transition, but performs no actual OAuth token exchange or refresh across activation. `make check` also passes. The final normal-image `python3 scripts/oauth-smoke.py --refresh` regression passes actual consent, scoped reads, session controls, two concurrent refresh cycles, grant/client rejection and cleanup using the legacy-key configuration. That regression is separate from live OAuth across key activation; provider settings and disabled Golf OAuth were restored.

Targeted real PostgreSQL race tests also pass for parsing/material/domain binding, a full legacy scan exceeding 500 records, migration/bootstrap preservation, activation-event rollback, expired records in both credential families, busy-row partial rotation/resume, zero-use removal, changed material denial, fresh JSON-only configuration, concurrent OAuth refresh and metadata/history guards. Those OAuth provider responses are fixtures, not live issuer qualification. The full `go test -race ./... -count=1 -timeout 120s` run with isolated PostgreSQL also passes. Actual OAuth token exchange/refresh across a drained key change, deployment-specific cutovers and fresh-backup restoration remain separate evidence requirements. Record exact completed tests and remaining gaps in the ledger. No CI workflows or provider deployments are added by this documentation.
