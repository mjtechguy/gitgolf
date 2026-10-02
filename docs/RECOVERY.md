# Offline recovery for the canonical Docker installation

Updated: 2026-10-02. This is a bounded P1.6 foundation for the three-service developer installation, not a completed production recovery gate. The [operator script](../scripts/recovery.py) creates an encrypted coordinated backup, validates it and restores it into a fresh, quarantined Docker Compose project. It never starts the restored Golf or Gitea application. Real PostgreSQL invalidation tests, offline archive checks and the full native recovery drill **pass**, including simultaneous restart of all three restored services. See the [evidence ledger](IMPLEMENTATION_STATUS.md).

Cloudflare and AI are not required. The same origin-side procedure can apply to the canonical Docker core of either track; it does not back up Cloudflare resources or external deployment state. Kubernetes, external databases/object stores and modified topologies require separate recovery qualification.

## Supported profile and trust boundary

| Requirement | Current contract |
| --- | --- |
| Services | Exactly one `golf`, one rootless `gitea` and one `postgres` container belonging to the named Compose project and the specified single Compose configuration file. |
| Versions | PostgreSQL **18.4**, Gitea **1.27.3**, Golf schema **202610020005**. Restore uses the source's actual Docker image IDs with `pull_policy: never`; all three images must already exist locally. Images are not included in the backup. |
| Databases | Separate `golf` and `gitea` databases/roles in the bundled PostgreSQL service; canonical initialization script and matching resolved application credentials. No published PostgreSQL port. |
| Persistent state | Named PostgreSQL volume at `/var/lib/postgresql`; Gitea volumes at `/var/lib/gitea` and `/etc/gitea`. No extra application mounts, privileged containers or host networking. |
| Runtime configuration | Image-default command, entrypoint, user and working directory; no restart policy, custom resource/security/device/host overrides covered by the validator, or extra networks. Named volumes use the default local driver without options and belong to this project. Modified profiles are rejected rather than silently simplified during restore. |
| Exposure | Golf HTTP, Gitea HTTP and Gitea SSH bindings are loopback-only. Existing public URLs, origin settings and port bindings are preserved, not automatically changed for another hostname. |
| Writers | Golf and Gitea stopped, PostgreSQL running, no other active container using the captured volumes, and no ordinary client connections to either application database. The operator must also drain every external/direct writer. |
| Host tools | Python 3.11+ on a Unix host, Docker with Compose, and `age`. `age-keygen` is needed when provisioning a backup identity. The live drill additionally needs Git, Git LFS, GnuPG and `ssh-keyscan`. |

Restore accepts only archives created by a trusted operator from a trusted installation. Successful age decryption establishes ciphertext integrity, **not the sender's identity**: anyone with the public recipient can encrypt another archive. Archive checks do not turn arbitrary Compose configuration, SQL or repository hooks into safe input. PostgreSQL explicitly warns that restoring a database dump can execute source-controlled code. Maintain backup provenance separately from the encrypted file and its checksum. See [age's public-recipient model](https://github.com/FiloSottile/age) and [PostgreSQL's restore trust warning](https://www.postgresql.org/docs/18/app-pgrestore.html).

## What is captured

The encrypted `golf.backup.v1` archive contains a manifest plus these six payloads:

| Payload | Purpose |
| --- | --- |
| `golf.dump` | Full Golf database schema/data, including identities, session/account history, repository-creation operations/events, API credential metadata/events, encryption policy/registry and operator history. |
| `gitea.dump` | Full native Gitea database schema/data. |
| `gitea-data.tar` | Entire `/var/lib/gitea` volume: canonical repositories, local LFS/attachments/releases and other local persistent state, including SSH/signing material stored there. |
| `gitea-config.tar` | Entire `/etc/gitea` volume, including `app.ini` and captured configuration/key files. |
| `compose.json` | Resolved runtime environment and actual image IDs, mount/port mapping and dependency configuration. This includes database passwords, all configured Golf encryption keys and any configured OAuth client secret. It is private plaintext inside the encrypted archive. |
| `postgres-init.sh` | The byte-identical canonical initialization script that recreates the two database roles/databases. |

The manifest records a random 32-character lowercase hexadecimal backup ID, creation time, source project, exact versions/image IDs and each payload's size/SHA-256. It is an integrity inventory, not an independent signature or a list proving every repository/object is usable.

Golf uses native `pg_dump -Fc` for each database and `pg_restore --single-transaction --exit-on-error` on a fresh target. `--no-owner --no-acl` with the explicit target role recreates canonical Golf/Gitea ownership; this does **not** export arbitrary cluster roles, extensions outside the supported profile or custom ACLs. Schema functions/triggers are restored with the data, including the append-only history guards. Gitea documents stopping the service for consistency and using native PostgreSQL dumps. This is an offline operator restore procedure, not an application feature writing into Gitea's database. See [Gitea backup/restore](https://docs.gitea.com/administration/backup-and-restore/#backup-consistency), [PostgreSQL 18 pg_dump](https://www.postgresql.org/docs/18/app-pgdump.html) and [pg_restore](https://www.postgresql.org/docs/18/app-pgrestore.html).

Both Gitea volumes are copied from stopped containers with ownership-preserving tar streams, then restored to stopped containers using [Docker's native `cp -a` interface](https://docs.docker.com/reference/cli/docker/container/cp/). Archive validation rejects duplicate/noncanonical paths, traversal, special files, unsupported ownership/modes, unsafe links and missing parents. Persistent storage/configuration paths must remain within the two captured volumes; external storage is rejected. File URI and explicit SSH host-key references must resolve to captured files. The sole scratch exception is native `repository.local.LOCAL_COPY_PATH` and `repository.upload.TEMP_PATH` within `/tmp/gitea`; in-flight local clones/uploads are not preserved or resumed. Runtime sockets are not backup payloads; stop/drain relevant processes rather than weakening archive validation.

## Storage and credential handling

Backup takes one classic native `age1…` public recipient. The private identity is not needed on the backup host. Verify/restore require an identity file owned by the invoking user, with no group/world permissions and no symlink; use mode `0600`. This wrapper does not qualify age plugins, SSH recipients, passphrase prompts, multiple recipients or post-quantum recipients. See [age key generation and usage](https://github.com/FiloSottile/age#usage).

The default `--max-bytes` is **8 GiB** of combined payload bytes. The accepted flag range is 1 MiB–1 TiB; raising it does not establish tested capacity. Separate bounded headroom covers outer-tar headers and age authentication overhead; it does not increase the permitted payload. Child output is bounded and native commands have timeouts, but this is not a constant-space stream: private temporary files hold database dumps, volume tars and the complete plaintext bundle. Allow several times the payload size for staging, ciphertext and fresh target storage. Use a trusted encrypted local disk and a private `TMPDIR` when necessary. Cleanup removes ordinary temporary files; it does not guarantee secure erasure after a crash, snapshots or swap.

The ciphertext is written as a private temporary file next to the destination and published atomically without overwriting an existing path. Restore's new directory is `0700`; its `compose.json` and manifest are `0600`. The copied initialization script is executable/readable because the PostgreSQL OS user needs it; it contains no literal secrets. The restored configuration remains sensitive after completion. The generated Compose file escapes literal dollar signs so runtime secrets are not reinterpreted as host substitutions; see [Compose interpolation](https://docs.docker.com/reference/compose-file/interpolation/).

## Back up and verify

Run from this repository with the exact current recovery script and a matching built Golf image. The example assumes the default project `golf` and `compose.yaml`. Choose fresh private paths outside the repository and retain the private identity separately from backup files.

```sh
umask 077
mkdir -m 700 /absolute/private/golf-backups
age-keygen -o /absolute/private/golf-backup-identity.txt
chmod 600 /absolute/private/golf-backup-identity.txt
```

Record the public recipient produced by `age-keygen`; only that public value goes in `--recipient`. Before the following stop, fence incoming HTTP/SSH, scheduled/native automation, other Golf replicas, pending OAuth exchanges and direct database clients. Wait for authorized in-flight operations to finish or resolve their outcome. Coordinate with every administrator that could restart a writer.

```sh
docker compose -p golf -f compose.yaml stop golf gitea
python3 scripts/recovery.py backup \
  --project golf --compose-file compose.yaml --writers-drained \
  --recipient '<PUBLIC_CLASSIC_AGE_RECIPIENT>' \
  --output /absolute/private/golf-backups/recovery-2026-10-02.age
python3 scripts/recovery.py verify \
  --input /absolute/private/golf-backups/recovery-2026-10-02.age \
  --identity /absolute/private/golf-backup-identity.txt
```

Use `stop`, not `down`: backup needs the stopped containers and their resolved runtime configuration. PostgreSQL remains running. `--writers-drained` is a mandatory **operator assertion**, not an implemented distributed/admin fence. The script checks ordinary container/connection state before and after capture and rejects mismatches; another administrator or direct database client can still race these checks. If all writers cannot be reliably drained, this profile cannot provide a coordinated recovery point.

Successful backup/verify return exit 0, `schema_version: "golf.backup.v1"`, `state: "complete"` and non-credential result metadata. Backup includes the ciphertext checksum; verify includes recorded image IDs and payload bytes. Verify waits for complete age authentication, checks the payload inventory/hashes and validates archive/configuration boundaries before any target mutation. It does not restore data or establish functional recovery. These operations do not restart the source; source resumption after a backup is a separate operator decision. During a cutover, keep the old source fenced throughout validation and traffic transfer.

## Restore into quarantine

Use an unused project name and a nonexistent directory. The script rejects existing project containers, labeled or canonical-name volumes/networks, existing target directories, missing local image IDs and incompatible versions. It neither overwrites a live installation nor downloads images.

```sh
python3 scripts/recovery.py restore \
  --input /absolute/private/golf-backups/recovery-2026-10-02.age \
  --identity /absolute/private/golf-backup-identity.txt \
  --project golf-recovery-20261002 \
  --directory /absolute/private/golf-recovery-20261002 \
  --writers-drained
```

Restore creates the three containers, starts only PostgreSQL and waits for its **TCP** health check so the temporary initialization server cannot be mistaken for the final server. It restores both databases and both Gitea volumes, then runs Golf's one-shot recovery invalidation command. Golf and Gitea stay stopped. Success returns exit 0 and `state: "quarantined"` with the backup ID, generated Compose path and exact invalidated session/attempt counts. It does not mean traffic may reopen.

The native whole-stack restart drill passes with bounded database readiness retries. Docker can temporarily withdraw the `postgres` DNS name while restarting PostgreSQL; Golf retries connection readiness at 250ms intervals before migrations, under the caller's deadline or a 60s readiness limit when no deadline exists. Retryable cases include transport refusal/reset/timeouts, temporary or not-found DNS answers, PostgreSQL startup/recovery and temporary connection-slot exhaustion. A syntactically valid but misspelled hostname also waits until the deadline; unresolved DNS is not promised to fail immediately. Malformed DSNs, authentication failures, missing databases and migration errors are not retried. Migration execution itself is not wrapped in a retry loop, and cancellation remains effective.

On failure, the JSON is `state: "failed"` with sanitized diagnostics; no application startup is requested. A failed restore can leave a partial private directory, database and project resources for investigation. Do not start those applications or retry over the same target. Inspect only that explicitly named recovery project, preserve needed evidence and remove or replace that failed target deliberately. This command never erases it automatically.

## Restored-session invalidation and its ledger

The server operator command is separate from the read-only user CLI:

```sh
# DATABASE_URL is supplied securely through the environment, never an argument.
./bin/golf-server recovery invalidate-sessions \
  --backup-id '<32_LOWERCASE_HEXADECIMAL_BACKUP_ID>' --timeout 60s
```

The container binary is `/usr/local/bin/golf`; `recovery.py restore` invokes it automatically using the restored private Compose environment. This operation requires only the Golf `DATABASE_URL`, not an HTTP login or encryption key. Opening the database can apply Golf migrations. The timeout defaults to 60s and permits 1s–5m. All Golf writers must already be drained; there is no preserve-sessions flag, automatic startup invalidation or admin HTTP endpoint.

One transaction locks the two credential tables, deletes **all** Golf sessions and pending OAuth attempts, including expired records, and appends an independent `golf_recovery_events` record. It retains Golf identities, previous account session history, repository-creation operations/events, API credential metadata/events, encryption operation history, key-label/material registry and active policy. Restoring that creation evidence does not dispatch a provider request or resolve an unknown outcome. It neither decrypts credentials nor invents per-account sign-outs. Retained read-only API credentials also lose authority because their exact issuing session is absent; a fresh sign-in does not revive them. Thus pre-backup Golf cookies and pending PKCE callbacks cannot authenticate against the successfully invalidated restored database. Native Gitea sessions and provider grants are a separate reconciliation problem.

The `golf.recovery.v1` JSON contains `action: "invalidate-sessions"`, `state: "complete"` and committed `result` metadata: `backup_id`, random `operation_id`, UTC `occurred_at`, PostgreSQL `current_user` as `actor`, `sessions_count` and `oauth_attempts_count`. Counts are JSON integers; consumers must preserve exact integer values. The actor is a database role, not a claimed human identity. Failed/interrupted operations emit sanitized errors and no successful counts, credential IDs, ciphertext, hashes, key material or DSN. A lost commit response is ambiguous: keep quarantine and inspect the operator ledger before retrying. Repeating an ID creates a new operation record, often with zero counts; it does not erase the first event.

For the example restored project, inspect the latest operator records without starting either application:

```sh
docker compose -p golf-recovery-20261002 \
  -f /absolute/private/golf-recovery-20261002/compose.json \
  exec -T postgres psql -U golf -d golf -c \
  'SELECT backup_id, operation_id, occurred_at, actor, sessions_count, oauth_attempts_count FROM golf_recovery_events ORDER BY id DESC LIMIT 20;'
```

Ordinary UPDATE/DELETE/TRUNCATE guards protect this independent ledger. As with the existing audit tables, a database owner can alter guards; this is not externally tamper-proof history. Transactional table locks also do not fence a stale writer after commit. Drain remains a precondition.

## Required reconciliation before reopening

Golf credential invalidation is intentionally narrower than complete restore authorization. Maintain authoritative evidence outside the backup recovery point for post-backup changes, then resolve at least:

1. **Provider access and deletion:** Gitea/native browser sessions, PATs, OAuth grants/applications, SSH/deploy keys, memberships/roles, repository visibility/protection changes and deletion tombstones. Restoring the provider database can resurrect access that was revoked after the backup. Apply the authoritative current decisions through supported provider/operator procedures; this script does not replay a revocation ledger.
2. **External issuers and keys:** an OAuth issuer may already have rotated or revoked a refresh token after capture. Restoring bytes cannot reverse that event. Keep issuer reconciliation distinct from Golf keyring restoration; reauthentication or revocation may be required. Preserve the age identity and historical encryption material needed for older retained backups even after live key retirement.
3. **Outbound work:** restored mirrors, webhook queues, scheduled jobs, runners and integrations may perform effects as soon as Gitea starts. Establish outbound/network quarantine and resolve pending work before even a validation startup. The script does not install such an egress boundary or disable native background writers.
4. **Data and identity:** verify expected repositories/refs and ordinary Git integrity, reachable LFS content, attachments/releases, native protections, account/repository IDs, SSH fingerprints and signing identity; then verify fresh Golf login, exact origin handling and private cross-user denial. A checksum alone does not satisfy these checks.
5. **Cutover:** validate preserved public URLs, callbacks, cookies/TLS, DNS, ports and old-source fencing. Reopen one deliberate authoritative writer only after recording the reconciliation outcome. A changed topology or version requires its own qualification rather than editing this profile into a production migration.

There is no universal safe `start` command for an arbitrary restored provider. The disposable smoke fixture has no outbound automation and deliberately starts its isolated target for qualification; that controlled action is not evidence that a real customer's restored queues/grants are reconciled. If authoritative post-backup revocation/deletion evidence is unavailable, keep quarantine rather than treating the backup as current authorization.

## Evidence and remaining work

Run checks locally; there are no repository CI workflows:

```sh
python3 scripts/recovery-test.py
# Supply GOLF_TEST_DATABASE_URL through a private environment for a dedicated disposable PostgreSQL database.
make test-integration
# Supply an already-built, locally available current Golf image.
python3 scripts/recovery-smoke.py --image '<LOCAL_GOLF_IMAGE_TAG_OR_ID>'
```

| Evidence | Current result |
| --- | --- |
| Real PostgreSQL/server-operator tests | Pass: mixed PAT/OAuth and expired-record removal; exact independent ledger metadata; preserved identities/account/crypto history and key registry/policy; append-only guards; insert/deferred-commit rollback; deadline/lock handling; argument/output privacy. Full race suite also passes. |
| Offline archive/configuration checks | Pass: paths, duplicates, links, modes/owners/types, external storage/key-file references, private-file/no-overwrite behavior, Compose dollar escaping, kernel-enforced subprocess output limits and ciphertext-headroom arithmetic. These checks need Docker Compose parsing but do not mutate containers/data. |
| Full native encrypted backup/fresh restore | **Pass, exit 0:** live-writer/no-overwrite rejection; age authentication and manifest-checksum rejection before target mutation; fresh database/volume restoration; stopped-application quarantine and exact session/PKCE invalidation; preserved identity/account/crypto history, key policy/registry and captured key configuration after partial rotation; byte-equivalent repository-creation operations/events with own lookup/same-key replay and foreign-key denial; private refs/signatures, hydrated LFS, attachments, protections, SSH/signing identity, fresh login/cross-user denial, new signed writes/force-push denial, simultaneous whole-stack restart persistence and complete disposable-resource cleanup. |

The previous native run on 2026-10-02 qualified schema **202610020004**, including the [repository-creation journal](REPOSITORY_CREATION_CONTRACT.md), and used `python3 scripts/recovery-smoke.py --image golf-golf:latest`, resolved to Docker image ID `sha256:2cb73e4238034ec564cc9e8696a30b850e1ab7d0f265df05fa87a7005b02f9ad`. This is the local image ID recorded by the manifest, not a registry manifest digest or an immutable promise about the `latest` tag. Final `make check` and real-PostgreSQL `go test -race ./... -count=1 -timeout 120s` pass for this increment; existing Helm checks (including 21 rejected configurations) and `scripts/recovery-test.py` also pass.

The final native fixture was smaller than 1 MiB, so the harness explicitly reported **SKIP** for its payload-exceeds-minimum-cap case. The separate offline check proves bounded subprocess output and overhead arithmetic; neither check is an actual 8 GiB backup, capacity/load test or full inventory proof.

The pending-verifier fixture represents stored PKCE state, not a real issuer callback or OAuth exchange across recovery. The passing native fixture qualifies only the bounded canonical Docker profile. Production recovery objectives, Kubernetes/external PostgreSQL/S3/R2, large repositories/LFS capacity, all-repository inventory reconciliation, off-host image distribution, PITR, cross-version restoration, comprehensive provider revocation/tombstone replay and outbound-work reconciliation remain open. P1.6 and the broader P1.3/production release gates stay open.

The current recovery tool requires schema **202610020005**, adding the [API credential metadata/event boundary](API_CREDENTIAL_CONTRACT.md). The schema005 native drill passed on image `sha256:4dbc64b946d0de111cf8abf1c923c197dc5ebc46e0c207b39452883846af8632`, including byte-equivalent API credential metadata/events, denial of all old bearer tokens after fresh same-user login and a new credential surviving whole-stack restart. The historical schema004 image above is separate provenance.
