# Bounded shell build artifacts

This is the source contract for migration062 and `golf.workflow.shell.artifacts.v1`. It adds a real producer, private retained output and authenticated attachment download. It does not implement previews, deployment, environment approvals, public links or maintained Actions artifact/cache services. The implementation ledger remains authoritative for actual deployment and runtime qualification.

## Declared output and collection

The existing one-job GitLab shell catalog accepts only `artifacts: {paths: [...]}`. Paths are one to eight distinct canonical workspace-relative literal file/directory names, without globs, variables, overlaps, traversal or trailing slashes. `when`, reports, exclusions, expiry and other artifact options refuse during inspection/compilation. Collection is on success only. GitHub shell uploads and the maintained Actions engine are unchanged.

The immutable saved execution plan contains these paths. A worker must advertise the artifact capability after observing an actual certificate/hostname-verified TLS1.3 response. The server requires TLS1.3 at claim/upload; old or HTTP workers skip artifact admissions. The worker independently rejects artifact assignments with manual inputs, Actions plans or execution environments. The server refuses execution-value bindings and typed input contracts, including at upload and read. This first profile never forwards worker/coordinator credentials into the job and does not publish outputs from approved secret/value environments. It cannot detect arbitrary application secrets deliberately embedded in source or an operator-approved image; repository administrators must choose the output declaration accordingly.

After all maintained shell-step receipts succeed, the worker verifies its exact labeled running job and captures the live tmpfs workspace through a fixed Docker exec of `/usr/bin/env -i` and `/bin/tar -C /workspace -cf - .` in the approved image as the ordinary job user. No worker environment or credentials enter that command, and tar does not dereference links. The worker then pauses the job and verifies the exact owned/running/paused receipt before normalization and upload. Capture is not an atomic filesystem snapshot: background job writes can race it; the accepted archive proves the exact validated captured bytes, not a point-in-time filesystem state. The persistent idle process keeps the tmpfs alive, and forced owned cleanup removes the paused container. There is no resume/replay operation. All collection/upload work remains within the original whole-attempt deadline. The actual Docker29.8.1 diagnostic returned only tar root `./` from `docker container cp ID:/workspace/. -` for this paused tmpfs despite the files existing; the normalizer correctly refused that incomplete archive. Actual revised collection, timeout and cleanup still require runtime qualification.

No archive is extracted on the Golf server or worker host. The complete streamed workspace is bounded to32MiB/4096 entries and rejects symlinks, hardlinks, devices, FIFOs, traversal, duplicate identities and file/directory collisions, even outside selected paths. Selected files are bounded to128 regular files/8MiB of content and a10MiB canonical tar. Every requested path must contribute a regular file. A deterministic sorted archive removes ownership, executable modes and timestamps; UTF-8 path records are validated. The server independently normalizes and compares canonical bytes against the frozen path declaration. Missing/unsafe/oversized output fails the attempt; it is never silently omitted.

## Upload, publication and retained budget

`POST /internal/ci/attempt/{id}/artifact` accepts a raw tar under an exact10MiB route cap. It uses the existing enrolled-worker, attempt capability, current native/session authority, lifecycle, policy, placement, resource generation and running lease fences. Other RPC and runner body limits stay unchanged. All maintained step events must exist with successful completion before upload. The producer never accepts client-supplied run/repository/source identity: those come from the locked original run.

Migration062 retains one immutable archive per original run/attempt, its native repository/owner, full commit, workflow path/blob, source archive digest, output digest and file/byte counts. The explicit PostgreSQL fallback profile admits at most20 retained artifacts per repository and200 across the instance. A short count/insert admission lock serializes this deliberately small profile; it is not a scalable object-store design. No artifact purge, TTL or retention editor is implemented. Cancelled/lost/uncertain uploads count toward the budget and remain private. PostgreSQL/object-storage migration and coordinated latest-schema recovery remain separate acceptance.

Identical upload replay under the still-current original lease is idempotent; changed bytes refuse. The maintained worker sends one upload only and does not retry an uncertain acknowledgement. Upload alone never publishes anything. A successful fenced shell finish must find the exact retained artifact. Lost, cancelled, timed-out, failed or otherwise unconfirmed results do not become downloadable, even if upload bytes were accepted. No lost attempt is automatically redispatched.

## Current authorized reads and UI

`WorkflowArtifactService.GetWorkflowArtifact` takes only a canonical run UUID. A current managed-browser read checks the original native repository/owner before and after loading output. The response has optional metadata, never source/output bytes. It is absent until the exact run succeeds. Metadata echoes run/attempt/repository/owner/commit/path/blob/source digest and provides bounded archive digest/counts plus one fixed relative download path.

`GET /api/workflow-runs/{id}/artifact` independently authenticates the current managed cookie and rechecks native repository/owner read authority before writing response headers/body. Bearer credentials, query credentials, cross-site requests and foreign Origin are refused. The response uses `application/octet-stream`, a fixed attachment filename, `nosniff`, CSP sandbox and `no-store`. Executable project HTML is never rendered inline on Golf's authenticated origin. Reads retain the existing non-atomic native before/after authority observation limits; they do not grant protected publication or deployment authority.

The shared run workspace reads metadata for successful ordinary GitLab runs, verifies every original identity/digest/count/download path and displays a shared DataTable download control. Refresh masks prior data; child authority denial clears the exact parent run/log observation and401 clears the managed session. Nothing is written or uploaded by metadata lookup, reload or status inspection. No private output body is persisted in browser storage.

## Source checks and integration

Source runner/cmd race checks pass3.358s/1.288s; final focused artifact/compiler/server checks pass1.477s/1.753s/1.231s. Vet, protobuf lint, TypeScript, production build and whitespace checks pass. The61 affected source-browser cases pass45.8s on isolated4193, including legacy/typed run regressions and four artifact theme/size variants. The final16 artifact browser cases pass20.2s, including held-read sign-out and late-response privacy. These mocked browser responses and fake Docker command receipts are source tests, not actual native/Docker delivery proof. The initial browser run had59 passes and one overly exact metadata-read-count assertion failure; the test now requires a fresh bounded read after reload and zero writes, without implying a single read across parent authority revalidation.

`TestWorkflowArtifactsUploadFinishDownloadAndPrivacyPostgres` authors genuine RPC GitLab admission and protocol claim/progress/upload/finish/read scenarios, immutable/replayed bytes, old/HTTP refusal, pre-finish withholding and cancelled/revoked privacy. It has three outcome subcases and is unrun here. The parent integrates/regenerates the append-only protocol, adds the metadata client/browser-only service registration/allowlist, mounts the two routes and runs the real PostgreSQL and disposable Docker GitLab qualification. Current retained services are not modified by this source packet.

## Prepared disposable runtime recipe

`scripts/workflow-artifacts-smoke.py --self-check` and the paired browser helper self-check are source-only guards. The actual helper is prepared, unrun. An operator supplies exact cached core/runner image IDs, their common source revision, independent core/runner/engine binary SHA-256 receipts, the existing native proxy binary and a fresh output directory:

```sh
python3 scripts/workflow-artifacts-smoke.py \
  --image "$CORE_IMAGE_ID" --runner-image "$RUNNER_IMAGE_ID" \
  --source-revision "$SOURCE_COMMIT" \
  --expected-core-sha256 "$CORE_BINARY_SHA256" \
  --expected-runner-sha256 "$RUNNER_BINARY_SHA256" \
  --expected-engine-sha256 "$ENGINE_BINARY_SHA256" \
  --proxy-binary "$NATIVE_PROXY_BINARY" --stack-root "$STACK_ROOT" \
  --output "$FRESH_PRIVATE_OUTPUT" --ui
```

The helper never builds or pulls. Its `seed.json` uses `golf.workflow-artifacts.seed.v1` and a fresh `golf-artifacts62-` project, binding the exact owned daemon ID/image plus approved Alpine/DinD registry digests. Only the operator seeds that daemon. The recipe uses verified TLS1.3 with strict CA/hostname checks, ordinary native owner/reader accounts and one actual GitLab job writing two literal files under `dist`. It requires a successful original attempt, maintained completion marker, independently empty attempt container/volume inventory, exact tar bodies/hash/metadata, reader read followed by native permission removal, Origin/bearer refusal and restart-stable original output without a replacement attempt. Missing-capability/HTTP exclusions are authenticated protocol observations, not a claim to exercise an old worker binary.

Optional `--ui` captures four actual read-only run/receipt views in dark/light at1440/390, without RPC interception or dispatch. Private cookies arrive on stdin, fonts/theme/overflow and browser-storage guards are checked, and artifacts remain downloadable attachments. Exact owned actor/session/project cleanup and foreign identity observations run even after an original failure; diagnostics are bounded and private. A passing controlled fixture would qualify this bounded producer only, not previews/CD, secrets-bearing output, general Actions artifacts, recovery or full repository readiness.
