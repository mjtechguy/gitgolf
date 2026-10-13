# Customer-hosted native PR runner

This is the outbound host process for the Cloudflare native **approved PR test** profile. It runs one exact-source job at a time in the existing Docker isolation executor. The shell profile accepts one bounded Actions or GitLab job; a GitLab `image` must be a digest-pinned reference matching the operator-approved image reference. The opt-in `actions-act` profile uses the pinned portable `act` v0.2.89 catalog for PR workflows, including its graph, matrix and admitted local actions. Unsupported forms are rejected by that engine on the host before job execution.

## Enroll and start

1. In the native workspace admin portal, open **Runners**, create an **Untrusted** pool, and enroll a named machine. Copy the one-time credential into a private host secret store. Select the pool in the repository **Actions** page.
2. Install the approved Linux image on a dedicated Docker daemon. Record its local `sha256:` image **ID** from `docker image inspect`, matching the pool's `image_id` from the runner inventory. The supervisor never pulls an image for a job.
3. Build the host binary with `go build -o golf-native-runner ./cmd/golf-native-runner`. Put this config in a private file:

   ```json
   {"origin":"https://YOUR_GOLF_ORIGIN","machineId":"ENROLLED_MACHINE_UUID","imageId":"sha256:APPROVED_LOCAL_IMAGE_ID","stateDirectory":"/var/lib/golf-native-runner"}
   ```

4. Provide `GOLF_NATIVE_RUNNER_CREDENTIAL` from the host secret store to the service process and run `golf-native-runner CONFIG_JSON`. Restrict the service to one process per enrolled machine. Do not pass the credential to repository jobs.

For the pinned Actions catalog, set `tests.workflow.format` to `actions-act` and its path to the selected `.github/workflows/*.yml` in the native deployment settings. Select an untrusted customer pool for each repository. Install the pinned `docker:29.8.1-dind` image and the approved job image reference on the host. Build the engine as a static Linux binary with `CGO_ENABLED=0 go -C engines/act build -o /ABSOLUTE/PATH/golf-actions-engine ./cmd/golf-actions-engine`, then add `"imageRef":"APPROVED_TAG@sha256:..."` and `"actionsEngineBinary":"/ABSOLUTE/PATH/golf-actions-engine"` to the private host config. `imageRef` must resolve to the same local `imageId`. The host advertises this catalog only when the engine is configured. This is the existing bounded catalog, including its exclusions; it does not claim GitHub-hosted runner parity.

To qualify an OCI build after a passing native Actions job, set `tests.build: true` in deployment settings and `"socketlessBuild":true` in the host config. The exact PR head must contain a root `Dockerfile` with one `FROM` using the approved pinned `imageRef`. Golf rejects remote `ADD`, external `COPY --from`, custom Dockerfile frontends and additional stages. The host requires a selected local Docker BuildKit builder and a rootless Docker daemon, runs build steps with `--network none`, bounds the OCI tar to 32 MiB, verifies every OCI blob, and records the manifest digest in the test result. The customer job receives no Docker socket. The OCI tar is removed with the attempt workspace after the receipt; registry publication and retained image artifacts need a separate scoped publication path.

## Stock GitLab Runner

The native coordinator also accepts the unchanged GitLab Runner **18.5.0** Docker executor. In the admin runner inventory, enroll a machine with protocol **Stock GitLab Runner**, then register the stock binary directly against Golf's public origin using the one-time `glrt-...` token. Configure a digest-pinned approved job image, `privileged = false`, no Docker socket volume, one concurrent job and a 48 KiB output limit. The coordinator accepts only the currently supported one-job GitLab shell workflow at `.gitlab-ci.yml`; registration, polling, leased Git clone, trace offsets, running/final state and cancellation fencing use GitLab's normal `/api/v4` requests. GitLab Runner itself remains unmodified. Its job Docker executor uses the host daemon; keep that daemon dedicated to this untrusted pool. Machine credentials expire within 24 hours and need administrator rotation and Runner re-registration.

Stock Runner does not send Golf's native heartbeat. Its job lease lasts to the bounded job deadline, including during a silent script; a dead Runner can therefore hold one pool slot until that deadline and will require cleanup reconciliation.

If Cloudflare Access protects the public hostname before the Worker runs, exempt the exact `/api/v4/*` machine routes or provide an Access service policy that the stock Runner can satisfy. Golf still checks the runner or job token, sponsor, lease and current PR authority on every exchange. Artifact, cache, service-container and ID-token exchanges are not advertised by this one-job contract.

The host state directory must be owned by the service user, mode `0700`, with no symlink in its path. The process checks for old labeled Docker resources before each claim. It verifies the selected Git commit, tree, and workflow blob through Golf's leased Git proxy, executes with network disabled and without the host credential, then sends a result only after Docker and local source cleanup. The evidence report labels customer-hosted cleanup as a host assertion.

For an approved image change, drain the pool and let active jobs finish. Install the new image on each host, save the draining pool against the new allocation, update each host config to the new image ID, then activate the pool and rebind repository placements to its new version.

## Interrupted attempts

The private `active.json` journal fences a host after a crash or uncertain outcome. A claim interrupted before assignment replays with the same claim ID; a result already cleaned up replays with the exact same payload. A journal in `claimed` state needs explicit local recovery:

1. Stop the host service. Run `golf-native-runner recover CONFIG_JSON` with the same host credential and Docker access. This removes only Docker resources labeled for that enrolled machine and its local `job-*` source directories, then leaves a `locally-cleaned` journal. If cleanup fails, inspect the named resources; capacity stays fenced.
2. Inspect the exact machine and job in the admin inventory. If the machine still has an active job, wait until that job is terminal and use **Reconcile cleanup**. This clears the server lease and leaves the machine draining. If the completion had already reached Golf, the inventory will already show no active job and confirmed cleanup. If the credential was revoked or expired, enroll a new machine after reconciliation.
3. Confirm the admin inventory shows no active job and cleanup `CONFIRMED`. Remove `active.json`, then restart the host service. Activate the machine if it is draining.

For a `cleanup-confirmed` journal whose completion receipt cannot be obtained before the lease expires, use the same recovery procedure. Never remove a journal or activate a quarantined machine merely because the host process exited.

## Qualification

`GOLF_RUNNER_TEST_IMAGE=sha256:LOCAL_IMAGE_ID go test ./cmd/golf-native-runner ./internal/runner -count=1` runs the real local Git proxy, Docker execution, completion, and recovery tests. Set `GOLF_RUNNER_TEST_ACTIONS_ENGINE` to the static engine path and `GOLF_RUNNER_TEST_SOCKETLESS_BUILD=true` to include pinned Actions and rootless BuildKit OCI execution. The Cloudflare control path has separate migration, authority, lease, capacity, Git proxy and build receipt tests in `cloudflare/forge/native-runners.test.mjs`. `GOLF_TEST_GITLAB_RUNNER=/ABSOLUTE/PATH/gitlab-runner node --test cloudflare/forge/gitlab-runner.test.mjs` registers and runs the stock pinned binary against a disposable local coordinator, including real Git clone and Docker execution.

### Hosted trial

Use a disposable native installation and a dedicated Linux host. Build and deploy schema20 with the guarded release steps in [CLOUDFLARE_NATIVE_SETUP.md](../../docs/CLOUDFLARE_NATIVE_SETUP.md#native-runners-and-stock-gitlab-runner-schema20). For a fresh installation, allocate an evidence bucket, queue and workflow, then pass their `--evidence-bucket`, `--evidence-queue` and `--evidence-workflow` flags plus `--test-workflow-format actions-act --test-workflow-path .github/workflows/pr.yml --test-image APPROVED_TAG@sha256:DIGEST --test-image-id sha256:LOCAL_IMAGE_ID --test-socketless-build` to `scripts/cloudflare_forge.py`; omit the build flag for an Actions-only trial. For a stock GitLab trial use `--test-workflow-format gitlab --test-workflow-path .gitlab-ci.yml` with the same approved image settings. The installation selects one approved workflow format at a time; use separate disposable installations or change the policy only after all old jobs finish.

1. In **Admin → Settings → Runners**, create an untrusted pool for the approved local image ID. Enroll one machine with **Golf native supervisor** or **Stock GitLab Runner** protocol. Keep its one-time credential private. In the repository **Actions** page, select that pool.
2. On the host, inspect the approved image reference and ID with `docker image inspect`. For `actions-act`, install the pinned DIND image and run the supervisor with `imageRef` and `actionsEngineBinary` as above. For a build trial, confirm the Docker daemon is rootless, select a local Docker BuildKit builder, and set `socketlessBuild` in the host config. For stock GitLab Runner, register version 18.5.0 directly with Golf's public origin using the enrolled `glrt-...` token and Docker executor; check `config.toml` for the approved image, `privileged = false`, no socket volume, `concurrent = 1`, and `output_limit = 48`, then run `gitlab-runner run --config /PRIVATE/PATH/config.toml`.
3. Open a same-repository PR whose exact head contains the approved workflow. For a build trial, include a root `Dockerfile` using the approved pinned base. On the PR page select **Run approved workflow** (or enable the installation's automatic CI setting), then watch the job and machine inventory. Open **Read report** after success: verify the source commit, runner machine and attempt, Actions catalog or GitLab job, test result, and any OCI digest.
4. Exercise a failing job, cancellation, runner stop/restart and credential revocation on disposable PRs. Check that stale or late results cannot pass, capacity is reconciled, and the dedicated host has no labeled job containers or source directories. Retain the private report and deployment/cleanup receipts before teardown. These are the hosted acceptance checks; the local qualification command above does not replace them.
