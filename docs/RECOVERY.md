# Offline recovery for the canonical Docker installation

Updated: 2026-10-17. This is bounded P1.6 recovery for the canonical Forgejo core and the optional local RustFS developer profile. It is not a completed production recovery gate. The [operator script](../scripts/recovery.py) creates an encrypted, coordinated backup, validates it and restores it into a fresh, quarantined Docker Compose project. It never starts the restored Golf, Forgejo or RustFS services.

**Qualification status.** Every native backup/restore drill before 2026-10-17 ran on the retired earlier topology and does not qualify Forgejo. On 2026-10-16 the tooling was ported to the Forgejo 15.0.9 topology in `compose.yaml`. On 2026-10-17 the first Forgejo drill ran. `scripts/recovery-smoke.py` **passes**, on three consecutive runs, on a Golf image built from source commit `976f8de` at Golf schema **202610110095**, with the local RustFS profile. The tooling needed three fixes before it passed; the [evidence ledger](IMPLEMENTATION_STATUS.md) lists them. The Access-core059 drill **does not pass**. It stops at its first schema check, because the profile is pinned to schema 202610040059 and every Forgejo-era Golf image migrates to 202610110095. The general core profile is therefore qualified on Forgejo for this small fixture; the Access-core059 profile is not.

The P1.6 exception covers privileged offline recovery only. It uses documented native PostgreSQL and Docker procedures into a fresh, stopped target, with every writer drained and traffic quarantined. It does not authorize application features to write Forgejo's database or repository files, schema surgery across products, or ad hoc edits to a live installation.

Cloudflare and AI are not required. The same origin-side procedure can apply to the canonical Docker core of either track. It does not back up Cloudflare resources or external deployment state. Kubernetes, external databases or object stores and modified topologies each need their own recovery qualification.

## Supported profile and trust boundary

| Requirement | Current contract |
| --- | --- |
| Services | Exactly one `golf`, one rootless `forgejo` and one `postgres` service, optionally one canonical `rustfs`, all in the named Compose project. Supply the complete ordered configuration with repeatable `--compose-file`. Each captured service's file list must be an ordered subset that starts with the same base file. Remove drained worker and daemon containers before capture. |
| Versions | PostgreSQL **18.4**, Forgejo **15.0.9** (`forgejo --version` must report `15.0.9+gitea-1.22.0`, which is Forgejo's own version string) and Golf schema **202610110095**, the schema of every Forgejo-era Golf image. The older labels **202610020021/019/008/009** stay allowlisted for historical archives only; no Forgejo installation produces them. Schema020 on its own and any other schema are rejected, so a new migration needs a passing drill before its backups are accepted. At 202610110095, backup and restore also refuse any managed agent harness connection (`golf_codex_connections`), because no drill has yet covered harness authentication and provider caches; the plan keeps that state outside qualified recovery. Schema **202610040059** is accepted only with explicit `--profile access-core059`, under the stricter closed requirements below. Restore uses the source's actual Docker image IDs with `pull_policy: never`, so every captured image must already exist locally. Images are not part of the backup. |
| Databases | Separate `golf` and `forgejo` databases and roles in the bundled PostgreSQL service, created by the byte-identical canonical [`deploy/postgres/forgejo-init.sh`](../deploy/postgres/forgejo-init.sh), with matching resolved credentials (`GOLF_DB_PASSWORD`, `FORGEJO_DB_PASSWORD`). No published PostgreSQL port. |
| Forgejo configuration | `FORGEJO__database__*` must name `postgres:5432`, database and user `forgejo`, and the PostgreSQL service's `FORGEJO_DB_PASSWORD`. The rootless image's own path variables must keep their defaults, so `app.ini` is `/var/lib/gitea/custom/conf/app.ini` inside the data volume. `FORGEJO_WORK_DIR`/`FORGEJO_CUSTOM` overrides, `__FILE` indirection and the legacy `GITEA__` environment prefix are refused. Forgejo reads both prefixes, so refusing the legacy one stops a second spelling from silently overriding a checked setting. Two variables that decode to the same setting are also refused. |
| Golf configuration | `GOLF_FORGE_URL=http://forgejo:3000`, `GOLF_FORGE_KIND=forgejo`, a lowercase UUIDv4 `GOLF_FORGE_INSTANCE_ID` and a `DATABASE_URL` that matches the bundled `golf` role. |
| Persistent state | A named PostgreSQL volume at `/var/lib/postgresql` and the single Forgejo volume `forgejo-data` at `/var/lib/gitea`. That path is the upstream rootless image's data directory; the service is Forgejo. The optional RustFS profile also captures its canonical `/data` named volume. No extra application mounts, privileged containers or host networking. |
| Runtime configuration | Image-default command, entrypoint, user and working directory. No restart policy, no custom resource, security, device or host overrides covered by the validator, and no extra networks. Named volumes must use the default local driver with no options and belong to this project. The optional RustFS service permits only its validated canonical security, resource and scratch configuration. Modified profiles are rejected; the script does not quietly simplify them during restore. |
| Exposure | Golf HTTP, Forgejo HTTP and Forgejo SSH bindings are loopback-only. Existing public URLs, origin settings and port bindings are kept as they are; the script does not change them for another hostname. |
| Writers | Golf, Forgejo and optional RustFS are stopped while PostgreSQL runs. No other active container may use the captured volumes, and there must be no ordinary client connections to either application database. The operator must also drain every external or direct writer. |
| Host tools | Python 3.11+ on a Unix host, Docker with Compose, and `age`. `age-keygen` is needed to provision a backup identity. The live drill also needs Git, Git LFS, GnuPG and `ssh-keyscan`. |

Restore accepts only archives that a trusted operator created from a trusted installation. Successful age decryption proves ciphertext integrity, **not who sent it**: anyone with the public recipient can encrypt a different archive. Archive checks do not make arbitrary Compose configuration, SQL or repository hooks safe input. PostgreSQL warns explicitly that restoring a dump can execute code controlled by the source. Keep backup provenance separately from the encrypted file and its checksum. See [age's public-recipient model](https://github.com/FiloSottile/age) and [PostgreSQL's restore trust warning](https://www.postgresql.org/docs/18/app-pgrestore.html).

## Explicit schema059 Access-core profile (not runnable on Forgejo-era images)

`backup --profile access-core059` is an additional closed profile. It does not extend the general schema allowlist. Older profiles keep their existing validation and command syntax. The archive records the exact profile, bounded admission observations and the complete thirteen-family key inventory from the supported operator. Verify refuses missing or unknown profile metadata, unsupported schemas and nonzero forbidden inventories. Restore verifies the authenticated archive before it creates a target. After restoring the databases into the stopped fresh target, it rechecks the actual schema, the closed inventories and the configured key fingerprints and counts independently. It does this **before** it copies the native volume or invalidates credentials. A semantic database mismatch can therefore leave a quarantined fresh PostgreSQL target that needs exact owned cleanup, but it never opens either application.

The profile requires exactly the canonical Golf, Forgejo and PostgreSQL services, with the existing image, mount, volume, port and writer fences. It refuses RustFS, extra workers, daemons, proxies, extra hosts, private TLS bind mounts, active external source storage, managed-Git transport, native mirrors, webhooks, Actions and mail, and any other enabled background consumer. Golf's canonical forge identity stays `http://forgejo:3000`. A qualification fault adapter must be removed, and Golf recreated without its transient DNS override, before capture. The only additional PostgreSQL command permitted and preserved is `postgres -c max_wal_size=64MB -c min_wal_size=32MB -c checkpoint_timeout=30s`, for bounded WAL. Arbitrary command overrides are still refused.

The native fence requires Actions and the native mailer to be disabled, and `cron.<task>.ENABLED=false` for every task in the closed inventory. Each must hold both in the decoded `FORGEJO__` environment (a literal `.` or the `_0X2E_` escape both work) and in the archived `app.ini`. Forgejo 15.0.9 has no global cron switch: each task reads its own `[cron.<task>]` section (see [`modules/setting/cron.go`](https://codeberg.org/forgejo/forgejo/src/tag/v15.0.9/modules/setting/cron.go)). The inventory is every task registered in v15.0.9 [`tasks_basic.go`](https://codeberg.org/forgejo/forgejo/src/tag/v15.0.9/services/cron/tasks_basic.go) and [`tasks_extended.go`](https://codeberg.org/forgejo/forgejo/src/tag/v15.0.9/services/cron/tasks_extended.go), including tasks registered only conditionally (for example `remove_resolved_reports`). The source was checked: a search of every Go file at that tag found no other registrations. The `tasks_actions.go` tasks register nothing while `[actions] ENABLED=false`, which this profile requires separately. The native mirror, push-mirror, webhook, hook-task and Actions-run tables must be empty. Excluded: custom receiver hook directories, hook delegates other than Forgejo's generated one, reference-transaction hooks, and any persistent `.gitconfig` (image home or `[git] HOME_PATH`) or repository `config` that sets a hook path or an include. These are operator recovery guards, not a production egress sandbox or protection from a hostile Docker or database administrator. All external Git, API and database writers must still be fenced and drained.

Golf must not have any of the following:

- enabled automation grants or intake connections
- active agents
- uncertain intents for review, publication, lifecycle, rules, Git, issues or repository creation
- active webhook or email subscriptions, transports or deliveries
- running workflows

At most **one** unclaimed, manually queued workflow with an exact retained typed-input row is permitted. Schema059's completeness constraints bind that row to the immutable run, source, schema and map metadata. Invalidation cancels the run and clears its attempt capability while keeping its authenticated encrypted content. Restoration never dispatches it or changes its original input digests.

Unresolved Access and invitation operations are the deliberate exception. The original Access generation, operation and event rows and the invitation operation and event rows stay exact. That includes UUIDs, request fingerprints, generations, native identities and `SUCCEEDED`/`DISPATCH_UNKNOWN` histories. The existing schema044 account-invalidation triggers deliberately move each original `PENDING` invitation to `EXPIRED`, with revision+1 and a new updated time, and append exactly one expiry event. The invitation's immutable issuer version, consent and target stay unchanged, and `GRANTING` and terminal invitation rows are not rewritten. Unknown work stays exclusionary: restore, status lookup, restart and re-enrollment do not replay, adopt or clear it. See the [Access contract](REPOSITORY_ACCESS_CONTRACT.md) and [invitation contract](REPOSITORY_INVITATION_CONTRACT.md).

Every local account stays disabled and its credential version advances. An invitation's original issuer version and persistent-consent record are unchanged. Even after explicit current-authority enrollment enables the issuer and recipient, inspecting or replaying a historical invitation operation is denied (403) while that captured issuer version is stale. A new accept against the now-expired pending invitation is refused as a state conflict (400); it does not grant access or refresh consent. Do not refresh consent or manufacture a successful historical receipt. Keep the offline history as evidence. A genuinely new invitation needs an explicit new authorized action, after any pending or unknown exclusion has been reconciled. Status lookup and replay of an original direct grant still require current native owner or direct-admin authority and the exact original target observation.

The key inventory covers these families:

- `sessions`, `oauth_attempts` and `local_accounts`
- `infrastructure_connections` and `automation_credentials`
- `review_contents`, `conversation_contents` and `notification_contents`
- `webhook_credentials`
- `repository_execution_values` and `organization_execution_values`
- `workflow_quarantined_outputs` and `workflow_dispatch_inputs`

If configured key material has been replaced, the operator fingerprint check fails. Missing retained-key material shows as `configured:false` in diagnostic status. This profile rejects that inventory, and ordinary core startup refuses the missing used key before it opens a listener. Registered-key `keys status` validates labels, material and counts; it does **not** decrypt every registered ciphertext. Zero counts are stated explicitly; they are not evidence that populated histories from every other feature family were restored.

Run the prepared drill only in an independently reviewed fresh fixture window, with existing exact cached images (including a Python 3 image for the bounded fault adapter) and the pinned Forgejo image already present locally:

```sh
python3 scripts/repository-access-recovery-smoke.py --self-check
python3 scripts/repository-access-recovery-smoke.py \
  --image 'sha256:<EXACT_CORE_IMAGE_ID>' \
  --proxy-image 'sha256:<EXACT_CACHED_PYTHON_IMAGE_ID>' \
  --source-revision '<EXACT_PRODUCT_SOURCE_COMMIT>' \
  --output /absolute/private/new-access-recovery-proof
```

The helper sets up real personal and organization grants, inherited team attachments, shared deploy-key associations, invitation histories in every state, and two distinct native 204 acknowledgement-loss cases. It also admits one typed run through the real prepare and dispatch RPCs; no job executes. It then performs encrypted backup and fresh restore. Its checks include:

- exact comparison of the original history and key registry; the only permitted changes are the required pending-invitation expiry transition and its events
- refusal of a wrong age identity before any target is created, and refusal of a wrong-key fingerprint
- diagnostic and profile refusal of a missing key, and ordinary core startup refusing both bad-key cases
- cancelled retained inputs authenticated by rotation
- denial of old cookies and passwords, and denial of stale issuer consent after re-enrollment
- unchanged native identities, memberships and key modes, and a restart without replay

The private manifest keeps only metadata, hashes and closed failure locations. Credentials, dumps and fixture source stay in owner-only temporary files, which are removed along with the fresh resources.

Earlier Access-core059 attempts, including the one that passed, ran on the retired earlier topology. They do not qualify Forgejo. The Forgejo attempt on 2026-10-17 **failed** at its first schema check (`repository-access-recovery-smoke.py` line 658, stage "fresh canonical core and ordinary supported native identities"). The fresh core migrated to 202610110095, not 202610040059. Owned cleanup passed and foreign containers were unchanged. Running this profile on Forgejo needs a new closed profile for the current schema, with its exclusion inventory re-derived for every consumer added since schema059. Changing the pinned schema label alone would not be qualification. Even when such a drill passes, it cannot complete production P1.6, whole-platform or latest-schema recovery, large-capacity recovery, reconciliation of native revocations made after the backup, protected integration, or the full Access/settings scope.

## What is captured

The restored-authority transaction (schema 083) also clears copied MFA setup and sign-in challenges and recovery digests. It resets enabled and pending local factors with an immutable operator audit record, and keeps every local account disabled until it is deliberately re-enrolled. Re-enroll an account with a fresh password and an independently verified matching native credential, then enroll a new authenticator before reopening its traffic. Old encrypted content remains historical at-rest data. This is revocation, not secure erasure or upstream provider revocation.

The same transaction also does the following:

- removes copied managed agent authentication and marks connected or pending connections as needing reauthentication
- cancels queued agent tasks and marks running attempts lost, keeping their original identities
- disables reviewers; reserved or unknown publication journals stay unresolved
- cancels pending email and webhook deliveries, recording that duplicates are possible
- removes email verification challenges
- suspends managed Git WRITE qualification profiles

Committed counts are part of the original append-only recovery event. Any storage, audit or commit failure rolls back the whole transaction.

The encrypted `golf.backup.v1` archive contains a manifest and these five core payloads, plus `rustfs-data.tar` when the validated local RustFS profile is selected:

| Payload | Purpose |
| --- | --- |
| `golf.dump` | The full Golf database schema and data. |
| `forgejo.dump` | The full native Forgejo database schema and data. |
| `forgejo-data.tar` | The entire Forgejo volume (`/var/lib/gitea` in the rootless image). It holds repositories, local LFS objects, attachments and releases, `custom/conf/app.ini` and its referenced secrets and keys, SSH and signing material, and other local persistent state. |
| `compose.json` | The resolved runtime environment and actual image IDs, mount and port mapping, and dependency configuration. It includes database passwords, all configured Golf encryption keys, configured worker and intake signing keys, and any configured OAuth client secret. It is private plaintext inside the encrypted archive. |
| `postgres-init.sh` | The byte-identical canonical `forgejo-init.sh`, which recreates the two database roles and databases. |

The archive layout changed with the Forgejo port. A bundle from the retired earlier topology fails verification on its payload inventory, versions and service names; it is never reinterpreted. The manifest records a random 32-character lowercase hexadecimal backup ID, the creation time, the source project, exact versions and image IDs, and each payload's size and SHA-256. It is an integrity inventory, not an independent signature.

Golf runs native `pg_dump -Fc` for each database and `pg_restore --single-transaction --exit-on-error` on a fresh target. `--no-owner --no-acl` together with the explicit target role recreates canonical Golf and Forgejo ownership. Forgejo documents stopping the service for a consistent backup. This is an offline operator restore procedure, not an application feature that writes into Forgejo's database. See [Forgejo upgrade and backup guidance](https://forgejo.org/docs/latest/admin/upgrade/), [PostgreSQL 18 pg_dump](https://www.postgresql.org/docs/18/app-pgdump.html) and [pg_restore](https://www.postgresql.org/docs/18/app-pgrestore.html).

The Forgejo volume is copied from the stopped container with an ownership-preserving tar stream and restored to the stopped target container using [Docker's native `cp -a`](https://docs.docker.com/reference/cli/docker/container/cp/). Archive validation rejects:

- duplicate or noncanonical paths, and path traversal
- special files, and ownership or modes outside the supported set
- unsafe links, and missing parent directories

Every persistent storage or configuration path in `app.ini` must stay inside the captured volume, and external storage is rejected. File URIs and explicit SSH host-key references must resolve to captured files. The only scratch exception is `repository.local.LOCAL_COPY_PATH` and `repository.upload.TEMP_PATH` inside the image's temporary directory (`/tmp/gitea`). In-flight local clones and uploads are not preserved or resumed.

## Storage and credential handling

Backup takes one classic native `age1…` public recipient; the backup host never needs the private identity. Verify and restore need an identity file owned by the invoking user, with no group or world permissions and no symlink (use mode `0600`). This wrapper does not qualify age plugins, SSH recipients, passphrase prompts, multiple recipients or post-quantum recipients.

The default `--max-bytes` is **8 GiB** of combined payload. The flag accepts 1 MiB to 1 TiB, and raising it does not establish tested capacity. This is not a constant-space stream: private temporary files hold the database dumps, the volume tar and the complete plaintext bundle. Allow several times the payload size for staging, ciphertext and the fresh target. Use a trusted encrypted local disk and a private `TMPDIR` where needed. Cleanup removes ordinary temporary files, but it does not guarantee secure erasure after a crash, snapshot or swap.

The ciphertext is written as a private temporary file next to the destination and published atomically, never overwriting an existing path. Restore's new directory is `0700`, and its `compose.json` and manifest are `0600`. The generated Compose file escapes literal dollar signs so that runtime secrets are not reinterpreted as host substitutions.

## Back up and verify

Run from this repository with the exact current recovery script and a matching built Golf image. `compose.yaml` names its project `golf-forgejo`. Choose fresh private paths outside the repository, and keep the private identity apart from the backup files.

```sh
umask 077
mkdir -m 700 /absolute/private/golf-backups
age-keygen -o /absolute/private/golf-backup-identity.txt
chmod 600 /absolute/private/golf-backup-identity.txt
```

Before the stop below, fence these writers:

- incoming HTTP and SSH
- scheduled or native automation
- other Golf replicas
- pending OAuth exchanges
- direct database clients

Wait for authorized in-flight operations to finish or resolve.

```sh
docker compose -p golf-forgejo -f compose.yaml stop golf forgejo
python3 scripts/recovery.py backup \
  --project golf-forgejo --compose-file compose.yaml --writers-drained \
  --recipient '<PUBLIC_CLASSIC_AGE_RECIPIENT>' \
  --output /absolute/private/golf-backups/recovery.age
python3 scripts/recovery.py verify \
  --input /absolute/private/golf-backups/recovery.age \
  --identity /absolute/private/golf-backup-identity.txt
```

Use `stop`, not `down`. PostgreSQL stays running. `--writers-drained` is a mandatory **operator assertion**, not an implemented distributed fence. The script checks container and connection state before and after capture, but another administrator or a direct database client can still race those checks. Verify waits for complete age authentication, then checks the payload inventory, the hashes and the archive and configuration boundaries before it touches any target.

## Restore into quarantine

Use an unused project name and a directory that does not exist yet. The script rejects existing project containers, existing volumes or networks (labeled or with canonical names), existing target directories, missing local image IDs and incompatible versions.

```sh
python3 scripts/recovery.py restore \
  --input /absolute/private/golf-backups/recovery.age \
  --identity /absolute/private/golf-backup-identity.txt \
  --project golf-recovery-20261016 \
  --directory /absolute/private/golf-recovery-20261016 \
  --writers-drained
```

Restore runs these steps in order:

1. Creates the captured three or four containers.
2. Starts only PostgreSQL and waits for its **TCP** health check.
3. Restores both databases and compares the restored Golf migration version with the manifest.
4. Copies the Forgejo volume (and RustFS data, if present) into the stopped containers.
5. Runs Golf's one-shot `recovery invalidate-sessions` command.

Golf, Forgejo and optional RustFS stay stopped. Success returns `state: "quarantined"`, which does not mean traffic may reopen. On failure the JSON reports `state: "failed"` with sanitized diagnostics, and no application startup is requested. A failed restore may leave a partial target behind for investigation. Never start it or retry over it.

## Restored-session invalidation

```sh
# DATABASE_URL is supplied securely through the environment, never as an argument.
./bin/golf-server recovery invalidate-sessions \
  --backup-id '<32_LOWERCASE_HEXADECIMAL_BACKUP_ID>' --timeout 60s
```

One transaction does all of the following:

- deletes **all** Golf sessions and pending OAuth attempts
- disables and version-fences every local password account
- cancels queued and running workflow runs
- revokes enabled automation grants
- blocks interrupted push materializations
- appends an independent `golf_recovery_events` record

Identities, account, crypto and mutation histories and the key registry are kept. Restoring mutation evidence does not dispatch a provider request or resolve an unknown outcome. Native Forgejo sessions and provider grants are a separate reconciliation problem.

## Required reconciliation before reopening

1. **Provider access and deletion:** Forgejo browser sessions, PATs, OAuth grants and applications, SSH and deploy keys, memberships and roles, visibility and protection changes, and deletion tombstones. Restoring the provider database can bring back access that was revoked after the backup. Apply the current authoritative decisions through supported Forgejo or operator procedures.
2. **External issuers and keys:** reconcile issuer state separately from Golf keyring restoration.
3. **Outbound work:** restored mirrors, webhook queues, scheduled jobs, runners and integrations may act as soon as Forgejo starts. Establish outbound quarantine before any validation startup. The script does not install an egress boundary.
4. **Data and identity:** verify repositories and refs, Git integrity, LFS objects, attachments, protections, IDs, SSH fingerprints and signing identity. Then verify fresh Golf login and denial of private cross-user access.
5. **Cutover:** validate public URLs, callbacks, cookies and TLS, DNS, ports and the fencing of the old source.

For local passwords, run the explicit [local-account enable operation](LOCAL_AUTHENTICATION.md#operator-enrollment) after reconciliation. Reset-password alone leaves a restored account disabled. If authoritative revocation or deletion evidence from after the backup is unavailable, keep the quarantine in place.

## Evidence and remaining work

Run the checks locally; there are no repository CI workflows:

```sh
python3 scripts/recovery-test.py
python3 scripts/repository-access-recovery-smoke.py --self-check
# Supply GOLF_TEST_DATABASE_URL through a private environment for a dedicated disposable PostgreSQL database.
make test-integration
# Supply an already-built Golf image and the pinned Forgejo, PostgreSQL and RustFS images locally. Needs git-lfs.
python3 scripts/recovery-smoke.py --image '<LOCAL_GOLF_IMAGE_TAG_OR_ID>'
```

| Evidence | Current result on the Forgejo topology |
| --- | --- |
| Offline archive and configuration checks (`recovery-test.py`) | **Pass (2026-10-16).** Covers the single-volume Forgejo archive (paths, duplicates, links, modes, owners and types; `app.ini` database, storage and reference checks), `FORGEJO__` decoding (literal and `_0X2E_` dots, conflict, legacy-prefix and `__FILE` refusal), image path and database environment checks, local RustFS checks, private-file and no-overwrite behavior, Compose dollar escaping and bounded subprocess output. Compose is parsed with `docker compose config`; no container is touched. |
| Access-core059 self-check | **Pass (2026-10-16).** Covers profile, history and key-family boundaries, the Forgejo actions, mailer and cron fences in the environment and `app.ini`, hook and `.gitconfig` exclusions, and fault-adapter guards. No runtime resources. |
| Real PostgreSQL invalidation tests | Golf-only and topology-independent; see the ledger. |
| Full native encrypted backup and fresh restore (`recovery-smoke.py`) | **Pass (2026-10-17), three consecutive runs.** Golf image `sha256:445160f727bfea6dfeeadd40833653131d680cd46b3ac76516ea3c319b0c38ec`, built from commit `976f8de`; schema 202610110095; Forgejo 15.0.9 rootless; PostgreSQL 18.4; local RustFS. Covers refusal of live writers, overwrite, the 1 MiB cap, a wrong identity, truncated ciphertext, a damaged payload, a mislabeled schema and existing or non-empty targets. Also covers quarantine, the invalidation ledger, Git refs and signatures, LFS, release attachments, branch protection, the SSH host key, the GnuPG signing key, a post-restore signed push, force-push denial and restart. Disposable resources removed. Small fixture only. |
| Access-core059 native drill | **Fail (2026-10-17).** Stops at its first schema check: the profile is pinned to schema 202610040059 and Forgejo-era images are at 202610110095. Cleanup passed. |

The 2026-10-17 drill settled the points that stayed open until a Forgejo drill passed:

- `forgejo --version` prints `forgejo version 15.0.9+gitea-1.22.0 (release name 15.0.9) …`, which the check accepts.
- `docker cp -a` round-trips the rootless volume, and the copy passes the archive checks.
- `app.ini` (mode 0600, owner 1000) passes the mode and ownership checks.
- Git, LFS, release attachments, branch protection, the SSH host key and the GnuPG signing key survive restore. The rootless image's built-in SSH server has a single RSA host key (`ssh/gitea.rsa`).

Still unverified on Forgejo: the Access-core059 profile (see above), a core-only backup without local RustFS, and anything larger than this small fixture. Earlier drills ran on the retired earlier topology and do not qualify Forgejo.

Still open: production recovery objectives, Kubernetes, external PostgreSQL/S3/R2, large-capacity recovery, all-repository inventory reconciliation, off-host image distribution, PITR, cross-version restoration, provider revocation and tombstone replay, and outbound-work reconciliation. P1.6 and the broader P1.3 and production release gates stay open.

## Optional local RustFS

Backups that include local RustFS keep the v1 envelope and add `storage_profile=local_rustfs`, a pinned fourth service and an integrity-checked `rustfs-data.tar`. Only the canonical local labeled `/data` volume and Golf's exact default storage binding are accepted. Remote environment S3, any profile-backed source and any active object profile are rejected. Remove worker, image-init and daemon containers first. The executor daemon state and certificates are not archived.

Repeat `--compose-file` for the selected base file and each overlay:

```sh
python3 scripts/recovery.py backup --project golf-forgejo \
  --compose-file compose.yaml --compose-file deploy/compose/compose.ci.yaml --compose-file deploy/compose/compose.storage.yaml \
  --recipient "$PUBLIC_AGE_RECIPIENT" --output /private/path/golf.age --writers-drained
```

Never start a restored worker just because a backup succeeded.
