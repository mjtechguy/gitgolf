# Initial Docker runner isolation contract

Golf's first runner executes a **bounded manual shell subset** compiled from a pinned Actions or GitLab configuration. It is Golf's Docker executor, not a GitHub hosted runner, `act` compatibility certification, or a GitLab Runner coordinator implementation. Configuration inspection and source admission remain separate; see [workflow configuration](WORKFLOW_CONFIGURATION_CONTRACT.md). Broad engine compatibility, autoscaling, Kubernetes job execution and Cloudflare execution remain open.

## Trust and deployment

`cmd/golf-runner` is a trusted operator process on a **dedicated Docker host**. Docker daemon access is host-level authority: keep its socket, enrollment key and attempt tokens out of the Golf web/core process and every job. A containerized runner may receive only that dedicated daemon socket with the necessary group permission; this is a control-plane privilege, never a job mount. Do not share the host with unrelated applications or higher-trust workloads. Nonprivileged containers still share the host kernel; this is not a VM/microVM boundary or a qualification for hostile multi-tenant production pools. [Docker runtime privilege](https://docs.docker.com/reference/cli/docker/container/run/), [GitLab runner security](https://docs.gitlab.com/runner/security/).

Operator configuration:

| Environment | Meaning |
| --- | --- |
| `GOLF_RUNNER_URL` | Fixed Golf origin. HTTPS, or HTTP only for literal localhost/127.0.0.1/::1. No user information, subpath, query or fragment. Redirects and environment proxy routing are disabled. |
| `GOLF_RUNNER_ID` | Unique enrolled worker ID. Only one live operator process may use an ID/key. |
| `GOLF_RUNNER_KEY` | Enrollment secret; supplied privately by the operator. Never passed to jobs or printed. |
| `GOLF_RUNNER_APPROVED_IMAGES` | JSON array of exact `repository@sha256:<64 lowercase hex>` references, also approved by the coordinator. Images must already exist on the dedicated daemon. Jobs cannot pull images. |
| `GOLF_RUNNER_DOCKER_BINARY` | Optional trusted Docker executable path; defaults to `docker`. Docker context/daemon configuration belongs to the operator. |

`Dockerfile.runner` builds the separate binary and pins Alpine 3.23's base digest plus Docker CLI 29.5.2-r0. The final process runs as UID/GID 1000; the operator must grant access to the dedicated socket explicitly. It has no Docker daemon or automatic Docker-in-Docker setup. The image must be built and qualified for the chosen host; a successful image build alone is not a deployed runner proof. [Pinned Alpine package](https://pkgs.alpinelinux.org/packages?branch=v3.23&name=docker-cli).

## Assignment and control traffic

A worker handles one assignment at a time. `POST /internal/ci/poll` uses `Golf-Runner-ID` and `Authorization: Bearer <enrollment key>` with `{}`. HTTP 204 means no assignment; the worker waits two seconds. An assignment contains run/attempt IDs, an attempt capability, exact image/source commit/source SHA-256, job ID, bounded steps and timeout/lease metadata. A lost poll response is not permission to execute a guessed assignment or repeat a run.

Attempt operations use the same enrollment headers plus `Golf-Attempt-Token` at `/internal/ci/attempt/<attemptId>/…`:

- `source` GET downloads at most 16 MiB of normalized uncompressed tar. The worker verifies the advertised SHA-256 and writes only a private 0600 file inside its own 0700 temporary directory.
- `heartbeat` POST runs every ten seconds during preparation/execution. Denial, network failure or unavailable coordinator cancels local execution. This is bounded observation, not instantaneous remote process revocation.
- `logs` POST sends monotonically numbered `{sequence,text}` records. No automatic log/write retries are performed by this worker. Failure cancels the attempt.
- `finish` POST sends exit code and timeout/cancellation/infrastructure/log-bound flags after cleanup. An unacknowledged report is printed as `result_unconfirmed`; the worker does not rerun the job. Coordinator lease fencing determines acceptance.

The worker emits only run/attempt IDs and state to its own stdout. API error bodies and credentials are not printed. Job stdout/stderr are private, untrusted repository output; they can contain information the source itself prints. No blanket secret-redaction guarantee is made. Enrollment/attempt tokens, provider credentials and operator environment variables are never injected into the job.

## Source and execution

The executor accepts only normalized uncompressed tar from the broker. It revalidates canonical relative paths, UTF-8 filenames without controls/backslashes, unique paths, ordinary files/directories and ancestor consistency. Symlinks, hardlinks, devices and other entry types are rejected. Bounds are 4,096 entries, 8 MiB per file and 16 MiB file bytes, with a bounded archive envelope. It never extracts paths onto the host. A new archive discards source ownership/metadata and separates `source/` from executor-owned `steps/`, so repository files cannot replace the control scripts.

A fresh labeled Docker volume is populated through native `docker cp` into a **stopped materializer container**. That container is nonprivileged and never started. It is removed before the actual job starts. The job mounts the volume read-only at `/golf`; source/control files are root-owned and non-writable. Its bootstrap copies the snapshot to writable `/workspace` inside the container. There is no `.git` database, submodule checkout, LFS fetch, dependency download or automatic credential helper. [Native Docker archive copying](https://docs.docker.com/reference/cli/docker/container/cp/).

Every actual job uses:

| Boundary | Enforced initial value |
| --- | --- |
| Identity | UID/GID 1000:1000; all Linux capabilities dropped; no-new-privileges; Docker init. |
| Image | Explicit operator-approved digest resolved locally to its immutable image ID; no pulls; image-declared volumes rejected; entrypoint and healthcheck overridden. |
| Root and source | Read-only root filesystem and source volume. No host binds, sockets, host PID/IPC namespace or privileged mode. |
| Working storage | Fresh tmpfs `/workspace` 128 MiB and `/tmp` 32 MiB. `/tmp` is noexec; both nosuid/nodev. No cache/artifact persistence. |
| Resource limits | One CPU, 256 MiB memory with memory-swap equal to memory, 64 PIDs. Job deadline at most 15 minutes. |
| Network | Docker `none`; only loopback inside the job. No services or outbound dependency access. |
| Environment | `env -i` with fixed PATH/HOME and nonsecret `GOLF_SOURCE_COMMIT`/`GOLF_JOB_ID`. No caller environment passthrough. |
| Logs | No Docker log-driver persistence; attached stdout/stderr callbacks, combined raw limit 256 KiB by default. Exceeding the bound kills the attempt and cannot yield success. |

Docker memory/CPU controls require an appropriately configured host; the native qualification inspects the applied values. Tmpfs counts toward memory and may otherwise be swapped by the host; job memory-swap equals memory, but deletion is not a secure-erasure claim. [Resource constraints](https://docs.docker.com/engine/containers/resource_constraints/), [tmpfs behavior](https://docs.docker.com/engine/storage/tmpfs/).

Actions `run` steps execute in separate shell processes in the same working directory. Explicit `sh` uses `sh -e`; explicit `bash` uses `--noprofile --norc -e -o pipefail`; the default uses bash `-e` if present, otherwise sh `-e`. The first failing step stops later steps. GitLab's admitted script list is compiled as one shared sh script. This preserves the declared narrow shell distinction; it does not implement provider contexts, events, variables, matrices, actions/includes, artifacts, caches, services or hosted image contents. Approved images must contain the declared shell and basic `env`, `cp` and `chmod` tools. [Actions shell semantics](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax#jobsjob_idstepsshell), [GitLab script](https://docs.gitlab.com/ci/yaml/#script), [act image limitations](https://nektosact.com/usage/runners.html).

Output forwarding preserves complete UTF-8 across raw chunk boundaries, replaces invalid bytes/NUL, and sends at most 4 KiB text per request so JSON escaping stays within the coordinator body limit. A separate 256 KiB normalized-text ceiling prevents encoding expansion from bypassing storage bounds. Source code is never executed through a host shell; all Docker CLI invocations use fixed executable/argument arrays.

## Manual and automatic authority origins

Schema020 retains the current live browser-session binding for `manual` runs and adds a mutually exclusive `push` origin with no session hash. A push row binds an immutable grant/revision/revocation epoch/credential version, authenticated event, exact ref/commit/workflow and sponsor audit subject. Database checks/triggers reject mixed or mismatched origins, pre-grant receipts and deleted commits; event/grant/path uniqueness does not include the grant revision. Manual intent replay queries use only the manual namespace.

Polling, source, heartbeat, logs and finish share current native identity/repository checks and a transaction fence. Push fencing locks sponsor user → grant → credential → instance/organization/repository policies → run, using database-clock expiry and pinned push policy epochs. Browser logout does not revoke the separately delegated grant. Grant revoke/expiry, local sponsor disable, native denial/owner change and policy changes deny queued work or cancel a leased attempt and reject its result. Temporary database/provider failure reports unavailable without falsely converting it into revocation or success; the normal lease/worker shutdown rules still bound an outage. No credential is added to the assignment or source.

These origin/fence paths are PostgreSQL-qualified prerequisites. No event materializer or public automatic enqueue path is present, and automatic capability/grant execution stays unavailable. The actual Docker executor's manual qualification does not certify a native push-to-Docker flow. Source schema020 requires a coordinated stopped-writer upgrade; older binaries' manual conflict target is incompatible with the new origin namespace. Do not mix serving versions or enable automatic dispatch during an old/new rollout. Schema020 automatic-origin backup/fresh restore remains a separate gate; the current recovery allowlist deliberately refuses it.

## Cancellation, cleanup and explicit crash recovery

Normal completion, context cancellation, SIGTERM, timeout, output overflow and log-delivery failure remove the job container and fresh volume with a bounded independent cleanup context. Cleanup validates Golf managed, worker, attempt and random ownership labels before deletion; container IDs are immutable. **Cleanup failure stops the worker**, even if the job itself finished. Inspect and recover before reusing that enrollment/host.

SIGKILL, host loss and daemon unavailability bypass process cleanup. A still-running orphan can outlive the worker's local deadline. An expired or revoked lease prevents accepting its result; it does not physically stop its container. Automatic restart/reaping and hardened per-job VM lifetime enforcement remain open.

Before `golf-runner recover`, stop all processes sharing the worker ID/key and ensure exclusive operator control. The explicit command first calls authenticated `POST /internal/ci/recover` to fence the worker's prior assignments, then removes only resources whose managed/worker/attempt/owner labels validate. It does not automatically run during startup or claim safety against two simultaneously operated copies of the same enrollment. If coordinator fencing or local cleanup fails, recovery fails visibly; do not resume polling until resolved. Other workers' resources are outside its filter.

## Runnable qualification

Run parser/transport checks without Docker:

```sh
go test -race ./internal/runner ./cmd/golf-runner -count=1
```

Native synthetic-job qualification requires the exact image already available on the daemon. It executes only fixture scripts inside containers and cleans their labels/resources:

```sh
docker pull alpine@sha256:85fe1e81d6758c208f3e1eed4338a1997e19d4be002d4dd32d3100c9a8c010a0
GOLF_RUNNER_TEST_IMAGE=alpine@sha256:85fe1e81d6758c208f3e1eed4338a1997e19d4be002d4dd32d3100c9a8c010a0 \
  go test -race ./internal/runner -count=1 -timeout=120s
```

The native fixture checks nonroot identity, readonly source/root, writable isolated workcopy, absent socket/ambient secret, loopback-only network, applied resource/capability policy, shell-step state, exit handling, timeout/cancel/output bounds and cleanup. A separate SIGKILL subprocess fixture observes an orphan and qualifies explicit worker-local cleanup. That local cleanup check is not proof of the live coordinator's database fence; record complete API/broker/runner qualification separately in [implementation status](IMPLEMENTATION_STATUS.md). Neither fixtures nor this file close all P4 policy, engine, shared-pool, recovery or scaling gates.
