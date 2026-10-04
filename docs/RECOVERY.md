# Offline recovery for the canonical Docker installation

Updated: 2026-10-04. This is bounded P1.6 recovery for the canonical core and optional local RustFS developer profile, not a completed production recovery gate. The [operator script](../scripts/recovery.py) creates an encrypted coordinated backup, validates it and restores it into a fresh, quarantined Docker Compose project. It never starts restored Golf, Gitea or RustFS. Historical real PostgreSQL invalidation tests, offline archive checks and bounded native recovery drills **pass**, including their recorded core restart and local RustFS cases. The new explicit schema059 Access profile below is source-prepared; its first actual attempt failed before fixture actors or recovery operations. See the [evidence ledger](IMPLEMENTATION_STATUS.md).

Cloudflare and AI are not required. The same origin-side procedure can apply to the canonical Docker core of either track; it does not back up Cloudflare resources or external deployment state. Kubernetes, external databases/object stores and modified topologies require separate recovery qualification.

## Supported profile and trust boundary

| Requirement | Current contract |
| --- | --- |
| Services | Exactly one `golf`, one rootless `gitea` and one `postgres`, optionally one canonical `rustfs`, belonging to the named Compose project. Supply the complete ordered configuration with repeatable `--compose-file`; captured service file lists must be ordered subsets with the same base file. Remove drained worker/daemon containers before capture. |
| Versions | PostgreSQL **18.4**, Gitea **1.27.3**, Golf schema **202610020021** or historically qualified **202610020019/008/009**. Schema020 alone and other schemas are rejected. Schema **202610040059** is accepted only with explicit `--profile access-core059` under the stricter closed requirements below; this is not whole-platform recovery qualification. Restore uses the source's actual Docker image IDs with `pull_policy: never`; all captured images must already exist locally. Images are not included in the backup. |
| Databases | Separate `golf` and `gitea` databases/roles in the bundled PostgreSQL service; canonical initialization script and matching resolved application credentials. No published PostgreSQL port. |
| Persistent state | Named PostgreSQL volume at `/var/lib/postgresql`; Gitea volumes at `/var/lib/gitea` and `/etc/gitea`. The optional RustFS profile also captures its canonical `/data` named volume. No extra application mounts, privileged containers or host networking. |
| Runtime configuration | Image-default command, entrypoint, user and working directory; no restart policy, custom resource/security/device/host overrides covered by the validator, or extra networks. Named volumes use the default local driver without options and belong to this project. The optional RustFS service permits only its validated canonical security/resource/scratch configuration. Modified profiles are rejected rather than silently simplified during restore. |
| Exposure | Golf HTTP, Gitea HTTP and Gitea SSH bindings are loopback-only. Existing public URLs, origin settings and port bindings are preserved, not automatically changed for another hostname. |
| Writers | Golf, Gitea and optional RustFS stopped, PostgreSQL running, no other active container using the captured volumes, and no ordinary client connections to either application database. The operator must also drain every external/direct writer. |
| Host tools | Python 3.11+ on a Unix host, Docker with Compose, and `age`. `age-keygen` is needed when provisioning a backup identity. The live drill additionally needs Git, Git LFS, GnuPG and `ssh-keyscan`. |

Restore accepts only archives created by a trusted operator from a trusted installation. Successful age decryption establishes ciphertext integrity, **not the sender's identity**: anyone with the public recipient can encrypt another archive. Archive checks do not turn arbitrary Compose configuration, SQL or repository hooks into safe input. PostgreSQL explicitly warns that restoring a database dump can execute source-controlled code. Maintain backup provenance separately from the encrypted file and its checksum. See [age's public-recipient model](https://github.com/FiloSottile/age) and [PostgreSQL's restore trust warning](https://www.postgresql.org/docs/18/app-pgrestore.html).

## Explicit schema059 Access-core profile (prepared, actual drill pending)

`backup --profile access-core059` is an additional closed profile, not a general schema allowlist extension. Older profiles keep their existing validation and command syntax. Its archive records the exact profile, bounded admission observations and the supported operator's complete thirteen-family key inventory. Verify refuses missing/unknown profile metadata, unsupported schemas or nonzero forbidden inventories. Restore verifies the authenticated archive before creating a target; after restoring the databases into that stopped fresh target, it independently rechecks the actual schema/closed inventories and configured key fingerprints/counts **before** copying native volumes or invalidating credentials. A semantic database mismatch may therefore leave a quarantined fresh PostgreSQL target requiring exact owned cleanup; it never opens either application.

This profile requires exactly canonical Golf, Gitea and PostgreSQL services, with the existing image/mount/volume/port/writer fences. RustFS, extra workers, daemons, proxies, extra hosts, private TLS bind mounts, active external source storage, managed-Git transport, native mirrors/webhooks/Actions/mail and other enabled background consumers are refused. Golf's canonical forge identity remains `http://gitea:3000`; a qualification fault adapter is removed and Golf recreated without its transient DNS override before capture. Only the precise PostgreSQL command `postgres -c max_wal_size=64MB -c min_wal_size=32MB -c checkpoint_timeout=30s` is additionally permitted and preserved for bounded WAL; arbitrary command overrides remain refused.

The native profile requires Actions and the native mailer disabled and every pinned basic/extended `cron.<task>.ENABLED=false` in both environment and archived `app.ini`. Gitea1.27.3 maps each task's configuration individually; a global `cron.ENABLED=false` does not establish this fence. The closed task inventory follows the pinned [basic](https://raw.githubusercontent.com/go-gitea/gitea/v1.27.3/services/cron/tasks_basic.go), [extended](https://raw.githubusercontent.com/go-gitea/gitea/v1.27.3/services/cron/tasks_extended.go) and [configuration mapping](https://raw.githubusercontent.com/go-gitea/gitea/v1.27.3/modules/setting/cron.go) sources. Native mirror, push-mirror, webhook, hook-task and Actions-run tables must be empty. Custom receiver hook directories, extra hook delegates, reference-transaction hooks and persistent global/repository Git hook-path or include overrides are excluded. These are operator recovery guards, not a production egress sandbox or protection from a hostile Docker/database administrator; all external Git/API/database writers must still be fenced and drained.

Golf must have no enabled automation grants/intake connections, active agents, uncertain review/publication/lifecycle/rules/Git/issue/repository-creation intents, active webhook/email subscriptions/transport/deliveries or running workflows. At most **one** unclaimed manual queued workflow with an exact retained typed-input row is permitted. Schema059's completeness constraints bind that row to the immutable run/source/schema/map metadata. Invalidation cancels it and clears its attempt capability, retaining its authenticated encrypted content; restoration never dispatches it or changes its original input digests.

Access and invitation unresolved operations are the deliberate exception. The original Access generation/operation/event and invitation operation/event rows remain exact, including UUIDs, request fingerprints, generations, native identities and `SUCCEEDED`/`DISPATCH_UNKNOWN` histories. Existing schema044 account-invalidation triggers intentionally advance each original `PENDING` invitation to `EXPIRED` with revision+1/updated time and append exactly one expiry event. Its immutable issuer version, consent and target remain unchanged; `GRANTING` and terminal invitation rows are not rewritten. Unknown work stays exclusionary; restore, status lookup, restart and re-enrollment do not replay, adopt or clear it. See the [Access contract](REPOSITORY_ACCESS_CONTRACT.md) and [invitation contract](REPOSITORY_INVITATION_CONTRACT.md).

All local accounts remain disabled and advance credential versions. An invitation's original issuer version and persistent-consent record remain unchanged. Even after explicit current-authority enrollment enables the issuer and recipient, historical invitation operation inspection/replay remains denied (403) when that captured issuer version is stale. A new accept against the now-expired pending invitation is a state-conflict refusal (400), not a successful grant or refreshed consent. Do not refresh consent or manufacture a successful historical receipt. Keep its offline history as evidence; a genuinely new invitation requires an explicit new authorized action after any pending/unknown exclusion has been reconciled. Original direct-grant status/replay still requires current native owner/direct-admin authority and the exact original target observation.

The key inventory accounts for `sessions`, `oauth_attempts`, `local_accounts`, `infrastructure_connections`, `automation_credentials`, `review_contents`, `conversation_contents`, `webhook_credentials`, `repository_execution_values`, `organization_execution_values`, `workflow_quarantined_outputs`, `notification_contents` and `workflow_dispatch_inputs`. Replaced configured key material fails the operator fingerprint check. Missing retained-key material is visible as `configured:false` in diagnostic status; this profile rejects that inventory and ordinary core startup refuses the missing used key before opening a listener. Registered-key `keys status` validates labels/material and counts; it does **not** decrypt every registered ciphertext. The prepared drill deliberately retains the real admitted typed payload under an inactive key, then uses bounded supported `keys rotate` to authenticate retained account/input content, compares all noncipher identity fields and verifies inactive retirement eligibility. Zero counts are explicit, not evidence that populated histories from all other feature families have been restored successfully.

Run the prepared drill only in the independently reviewed fresh fixture window, using existing exact cached images (including a Python3 image for its bounded fault adapter):

```sh
python3 scripts/repository-access-recovery-smoke.py --self-check
python3 scripts/repository-access-recovery-smoke.py \
  --image 'sha256:<EXACT_CORE_IMAGE_ID>' \
  --proxy-image 'sha256:<EXACT_CACHED_PYTHON_IMAGE_ID>' \
  --source-revision '<EXACT_PRODUCT_SOURCE_COMMIT>' \
  --output /absolute/private/new-access-recovery-proof
```

The helper prepares real supported personal/organization grants, inherited team attachments, separate shared deploy-key associations, accepted/rejected/revoked/pending/uncertain invitation histories and two distinct actual native204 acknowledgement-loss cases. It admits one typed run through the real prepare/dispatch RPCs; no worker/job executes. It requires encrypted backup/fresh restore, exact original history/key-registry comparisons with only the required pending-invitation expiry transition/events, wrong age identity refusal before target creation, wrong-key fingerprint refusal, missing-key diagnostic/profile refusal and ordinary core startup denial for both, cancelled retained inputs authenticated by rotation and original-key status after current-account enrollment, old cookies/password denial, unchanged native identities/memberships/key modes, stale issuer consent denial after re-enrollment, unknown/new-key/archive exclusion and restart without replay. Its private manifest retains only metadata/hashes/closed failure locations; credentials, submitted values, dumps and fixture source stay in owner-only temporary files and are removed with the fresh resources. Existing failed/qualified historical fixtures are not relabeled.

The first actual attempt failed at initial readiness before actors, typed admission or recovery, with complete owned cleanup and unchanged foreign resource identities ([private receipt](../.tmp/repository-access059-recovery-attempt1/manifest.json)). Source inspection found that the fresh database starts with active key `legacy`, while the fixture immediately configured `a`; this is a source diagnosis, not a retained startup-log observation. The corrected helper starts only PostgreSQL, activates `a` with the supported operator CLI before application/native writers exist, and checks the real thirteen-family inventory has only configured `a`/`b` with zero uses. It then starts the applications without extending the readiness deadline. Failure collection reads only the owned service states and bounded logs before teardown, redacts known fixture credentials, and retains a mode-0600 private diagnostic file; the manifest exposes only closed states, command outcomes and the file hash/size. It never prints service logs or environments.

The second actual attempt passed the operator key bootstrap but failed before actors at application startup, with complete cleanup and unchanged foreign identities ([private receipt](../.tmp/repository-access059-recovery-attempt2/manifest.json)). Its bounded private diagnostics observed Golf exit1 because `GITEA_PUBLIC_URL` was set without the required OAuth client ID/secret. The fixture now omits all three optional OAuth settings; native `ROOT_URL` still supplies native external URLs and canonical `GITEA_URL` is unchanged. Pure checks reject accidental OAuth configuration, and actual startup must report local-password authentication available with OAuth disabled. No artificial OAuth credentials or application validation exceptions are introduced.

The corrected actual drill is **pending**. It cannot complete production P1.6, whole-platform/latest-schema recovery, large-capacity recovery, post-backup native revocation reconciliation, protected integration or the entire Access/settings scope.

## What is captured

The encrypted `golf.backup.v1` archive contains a manifest plus these six core payloads, and `rustfs-data.tar` when the validated local RustFS profile is selected:

| Payload | Purpose |
| --- | --- |
| `golf.dump` | Full Golf database schema/data, including identities, session/account history, repository-creation operations/events, API credential metadata/events, encryption policy/registry and operator history, execution/organization policy, immutable infrastructure profiles, native event receipts, workflow runs/logs and automation grants/credential history. |
| `gitea.dump` | Full native Gitea database schema/data. |
| `gitea-data.tar` | Entire `/var/lib/gitea` volume: canonical repositories, local LFS/attachments/releases and other local persistent state, including SSH/signing material stored there. |
| `gitea-config.tar` | Entire `/etc/gitea` volume, including `app.ini` and captured configuration/key files. |
| `compose.json` | Resolved runtime environment and actual image IDs, mount/port mapping and dependency configuration. This includes database passwords, all configured Golf encryption keys, configured worker/intake signing keys and any configured OAuth client secret. It is private plaintext inside the encrypted archive. |
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

Successful backup/verify return exit 0, `schema_version: "golf.backup.v1"`, `state: "complete"` and non-credential result metadata. Backup includes the ciphertext checksum; verify includes recorded image IDs and payload bytes. Verify waits for complete age authentication, checks the payload inventory/hashes and validates archive/configuration boundaries before any target mutation. Restore also compares the actual restored Golf migration version with the manifest before invalidation; a mismatch leaves applications stopped and requires operator inspection of the partial fresh target. It does not restore data or establish functional recovery. These operations do not restart the source; source resumption after a backup is a separate operator decision. During a cutover, keep the old source fenced throughout validation and traffic transfer.

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

Restore creates the captured three or four containers, starts only PostgreSQL and waits for its **TCP** health check so the temporary initialization server cannot be mistaken for the final server. It restores both databases and both Gitea volumes, then runs Golf's one-shot recovery invalidation command. Golf, Gitea and optional RustFS stay stopped. Success returns exit 0 and `state: "quarantined"` with the backup ID, generated Compose path and exact invalidated session/attempt counts. It does not mean traffic may reopen.

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

One transaction locks the session, OAuth-attempt and local-account credential tables, deletes **all** Golf sessions and pending OAuth attempts, including expired records, and appends an independent `golf_recovery_events` record. Schema007 also disables **every local password account** and advances its credential version, including accounts already disabled. It retains the local password verifier, encrypted native credential, immutable mapping, role and previous operator events; it adds one `RECOVERY_DISABLED` event per account. A stored password cannot silently reopen restored access. Disabled local-account ciphertext still counts as stored key use.

Schema019 additionally cancels every queued/running workflow run, clears its attempt capability and records a quarantine reason without replay. Every enabled automation grant is revoked with a revision/epoch increment and a RECOVERY_REVOKED event, including sponsors without a local password account. Already-revoked grants remain unchanged; all delegated ciphertext and credential-version/key references are retained. Fresh sign-in or local-account re-enablement does not restore old grants. Policy values and historical event receipts are preserved, not an authorization to replay them. Reconcile current provider permissions, runner/intake enrollment, policies and external effects before reopening traffic.

The transaction retains Golf identities, previous account session history, repository-creation and issue-mutation operations/events, API credential metadata/events, encryption operation history, key-label/material registry and active policy. Restoring mutation evidence does not dispatch a provider request or resolve an unknown outcome. The invalidator neither decrypts credentials nor invents per-account sign-outs. Retained read-only API credentials lose authority because their exact issuing session is absent; a fresh sign-in does not revive them. Thus pre-backup Golf cookies and pending PKCE callbacks cannot authenticate against the successfully invalidated restored database. Native Gitea sessions and provider grants are a separate reconciliation problem.

The `golf.recovery.v1` JSON contains `action: "invalidate-sessions"`, `state: "complete"` and committed `result` metadata: `backup_id`, random `operation_id`, UTC `occurred_at`, PostgreSQL `current_user` as `actor`, `sessions_count`, `oauth_attempts_count` and `local_accounts_disabled_count`. The local count includes every version-fenced local account, not only previously enabled rows. Counts are JSON integers; consumers must preserve exact integer values. The actor is a database role, not a claimed human identity. Failed/interrupted operations emit sanitized errors and no successful counts, credential IDs, ciphertext, hashes, key material or DSN. A lost commit response is ambiguous: keep quarantine and inspect the operator ledger before retrying. Repeating an ID creates a new record; session/PKCE counts may be zero, but retained local accounts are disabled and version-fenced again. It does not erase the first event.

For the example restored project, inspect the latest operator records without starting either application:

```sh
docker compose -p golf-recovery-20261002 \
  -f /absolute/private/golf-recovery-20261002/compose.json \
  exec -T postgres psql -U golf -d golf -c \
  'SELECT backup_id, operation_id, occurred_at, actor, sessions_count, oauth_attempts_count, local_accounts_disabled_count FROM golf_recovery_events ORDER BY id DESC LIMIT 20;'
```

Ordinary UPDATE/DELETE/TRUNCATE guards protect this independent ledger. As with the existing audit tables, a database owner can alter guards; this is not externally tamper-proof history. Transactional table locks also do not fence a stale writer after commit. Drain remains a precondition.

## Required reconciliation before reopening

Golf credential invalidation is intentionally narrower than complete restore authorization. Maintain authoritative evidence outside the backup recovery point for post-backup changes, then resolve at least:

1. **Provider access and deletion:** Gitea/native browser sessions, PATs, OAuth grants/applications, SSH/deploy keys, memberships/roles, repository visibility/protection changes and deletion tombstones. Restoring the provider database can resurrect access that was revoked after the backup. Apply the authoritative current decisions through supported provider/operator procedures; this script does not replay a revocation ledger.
2. **External issuers and keys:** an OAuth issuer may already have rotated or revoked a refresh token after capture. Restoring bytes cannot reverse that event. Keep issuer reconciliation distinct from Golf keyring restoration; reauthentication or revocation may be required. Preserve the age identity and historical encryption material needed for older retained backups even after live key retirement.
3. **Outbound work:** restored mirrors, webhook queues, scheduled jobs, runners and integrations may perform effects as soon as Gitea starts. Establish outbound/network quarantine and resolve pending work before even a validation startup. The script does not install such an egress boundary or disable native background writers.
4. **Data and identity:** verify expected repositories/refs and ordinary Git integrity, reachable LFS content, attachments/releases, native protections, account/repository IDs, SSH fingerprints and signing identity; then verify fresh Golf login, exact origin handling and private cross-user denial. A checksum alone does not satisfy these checks.
5. **Cutover:** validate preserved public URLs, callbacks, cookies/TLS, DNS, ports and old-source fencing. Reopen one deliberate authoritative writer only after recording the reconciliation outcome. A changed topology or version requires its own qualification rather than editing this profile into a production migration.

For local passwords, reconcile the present account decision before running the explicit [local-account enable operation](LOCAL_AUTHENTICATION.md#operator-enrollment). It requires a new Golf password and a currently validated provider credential matching the original immutable forge/user ID; reset-password alone leaves a restored account disabled. Historical hash/token bytes are preserved for inventory, not accepted as evidence that access remains authorized. Local disable does not revoke separate PAT/OAuth/native identities; those remain subject to the provider reconciliation above.

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

The previous schema005 recovery tool required schema **202610020005**, adding the [API credential metadata/event boundary](API_CREDENTIAL_CONTRACT.md). The schema005 native drill passed on image `sha256:4dbc64b946d0de111cf8abf1c923c197dc5ebc46e0c207b39452883846af8632`, including byte-equivalent API credential metadata/events, denial of all old bearer tokens after fresh same-user login and a new credential surviving whole-stack restart. The historical schema004 image above is separate provenance.

The schema006 recovery qualification includes both issue mutation and phase-event tables, preserving provisional receipt observations as well as terminal outcomes. Its final image is recorded separately in the implementation ledger; historical schema004/005 image evidence is unchanged.

The historical schema008 recovery profile added operator-enrolled email aliases. The prior schema007 qualification added local password accounts, encrypted native-credential inventory and local operator events. The updated native drill passes on qualified image `sha256:44c422c7f61225cb963a8a4e8ec793ec04bb79ce821f739f144ef0c635910d18`: five sessions and one pending PKCE attempt are removed, while both an enabled and an already-disabled local account remain disabled/version-fenced after restore. Exact ciphertext/hash/mapping and previous history are preserved; matching recovery events and count2 are recorded; password-only reset and wrong-identity enable fail; deliberate current-authority enable permits a fresh local login and native read. Full signed Git/LFS/attachment/protection/SSH/new-write/restart regression and cleanup also pass. The final real-PostgreSQL race suite and frozen-runtime checks also pass, as recorded in the implementation ledger. Earlier encrypted-restore passes are separate provenance and do not imply full account/provider revocation reconciliation.

Schema008 native encrypted-backup/restore qualification passes on `sha256:58601e2d499e044634dc2c9e738ea08956cd5bd58afe8e1466e2c13c19dd902d`, preserving email aliases alongside exact password/ciphertext/mapping/history records. Local accounts are disabled/version-fenced before explicit mapped re-enablement. Signed Git/LFS/attachments/protection/SSH/new writes and restart pass. The below-minimum 1 MiB payload fixture still explicitly skips that cap-negative case.

Schema019 canonical-core recovery qualification passes on Docker image ID `sha256:1ff8978ebcb6bba7ef8be14cdfa92451cc90862bcd861c5216677f09d5b2cb2b`. The drill creates actual native signed Git pushes and receipts, two owner-sponsored grants (one already revoked), a third token-only sponsor, a tested encrypted PostgreSQL connection profile, and queued/leased manual runs. Encrypted backup/fresh restore preserves immutable profile/event/policy/credential history, revokes both enabled grants, preserves the prior revocation, cancels both runs and denies old attempt capabilities before any new work. After explicit local-account reconciliation, the saved profile decrypts and tests; three retained automation credentials and one profile rotate to the active key, the inactive key is retirement-eligible, and no old grant/run reactivates. A manifest/dump schema mismatch fails before invalidation with both applications stopped. Signed Git/LFS/attachments/protection/SSH/new writes, whole-core restart and full disposable cleanup pass. The fixture remains below the 1 MiB negative size-cap threshold, so that case explicitly skips.

This qualifies the canonical three-service schema019 core. It does not cover RustFS object restoration, external database/provider resources, the live worker-daemon topology, an executing/orphan Docker process, automatic-run authority, Kubernetes or production failover. The leased-run fixture exercises control-plane capability quarantine; it does not claim a Docker job ran. Run the matching topology's complete recovery drill before production release.

Source schema020 adds automatic run origins and changes the manual intent uniqueness target. It requires a coordinated stopped-writer upgrade; mixed old/new serving binaries are unsupported. Schema020 remains outside the recovery allowlist. The subsequent schema021 drill qualifies its complete automatic-origin/materialization schema; a schema019 proof alone does not.

Schema021 adds canonical payload and push-materialization history. Source recovery quarantines pending/preparing leases as terminal blocked decisions, clears preparation capabilities and revokes restored grants. Schema021 now passes the expanded native/RustFS/automatic-run drill below; schema020 alone remains outside the allowlist.


## Schema021 and optional local RustFS qualification

The full native encrypted backup/fresh-restore drill passes on image `sha256:27f9e813321169f851c6f281f9855611c5bc6fc7bb9c4830c40fb3e5117d9583`, with the same qualified backend binary `a3f234c3aa0e92436d01fc7b51c9fcd613f8f2e7e59f1ba8c4e3dd4ac5e11eef`. It admits two actual signed automatic pushes, retains exact source/provenance, and snapshots one queued and one HTTP-leased run of each origin. Interrupted pending/preparing materializations are additional explicit Golf-owned fixtures, not claimed executions. Fresh restore preserves every stopped RustFS file SHA-256 and native Git/LFS/attachment/signature/protection/SSH evidence, revokes restored grants, cancels four runs, blocks interrupted materializations, clears leases and denies both old attempt capabilities. Fresh login and fifth-family key rotation never reactivate work. Ciphertext/checksum/schema mismatch, live-writer/no-overwrite and size-cap negatives pass. All disposable projects/private files are removed.

Backups with local RustFS retain the v1 envelope plus `storage_profile=local_rustfs`, a pinned fourth service and integrity-checked `rustfs-data.tar`. Only the canonical `/data` local labeled volume and exact Golf default storage binding are admitted. Source Golf/Gitea/RustFS must be stopped and all writers drained. Worker/image-init/daemon containers must be removed; dedicated executor jobs/volumes must first be reconciled. The executor daemon state and certificates are not archived or restored. Fresh restore leaves RustFS stopped until the operator explicitly starts it after quarantine.

Remote environment S3, any profile-backed source or active object profile is rejected by this local-only tool. Dormant encrypted connection profiles are configuration history, not proof that their external resource data is backed up. External databases/storage, TLS edge volumes, live/orphan executable processes, Kubernetes, HA and production multi-tenant recovery remain separate gates.

Repeat `--compose-file` for the selected base/overlays. Containers created before an overlay was selected may legitimately retain an ordered subset of those file labels; foreign/reordered/duplicate paths are rejected. Structural image, entrypoint, local volume, security, service and storage-binding checks remain mandatory.

```sh
python3 scripts/recovery.py backup --project golf \
  --compose-file compose.yaml --compose-file compose.ci.yaml --compose-file compose.storage.yaml \
  --recipient "$PUBLIC_AGE_RECIPIENT" --output /private/path/golf.age --writers-drained
```

Use the full restored profile's generated private Compose file and explicit operator reconciliation; never start a restored worker merely because a backup succeeded. For retained development, the pre-schema021 encrypted rollback snapshot and its private identity/configuration are under the ignored `.tmp/local-upgrade-*` directory. Protect/copy that directory separately; the same-host development copy is not an offsite recovery claim.
