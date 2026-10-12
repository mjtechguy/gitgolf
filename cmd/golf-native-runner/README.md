# Customer-hosted native PR runner

This is the outbound host process for the Cloudflare native **approved PR test** profile. It runs one exact-source job at a time in the existing Docker isolation executor. The current Actions/GitLab profile accepts one bounded shell job; a GitLab `image` must be a digest-pinned reference matching the operator-approved image reference. Unsupported workflow keys are refused at admission. It is not an unmodified GitHub Actions or GitLab Runner coordinator.

## Enroll and start

1. In the native workspace admin portal, open **Runners**, create an **Untrusted** pool, and enroll a named machine. Copy the one-time credential into a private host secret store. Select the pool in the repository **Actions** page.
2. Install the approved Linux image on a dedicated Docker daemon. Record its local `sha256:` image **ID** from `docker image inspect`, matching the pool's `image_id` from the runner inventory. The supervisor never pulls an image for a job.
3. Build the host binary with `go build -o golf-native-runner ./cmd/golf-native-runner`. Put this config in a private file:

   ```json
   {"origin":"https://YOUR_GOLF_ORIGIN","machineId":"ENROLLED_MACHINE_UUID","imageId":"sha256:APPROVED_LOCAL_IMAGE_ID","stateDirectory":"/var/lib/golf-native-runner"}
   ```

4. Provide `GOLF_NATIVE_RUNNER_CREDENTIAL` from the host secret store to the service process and run `golf-native-runner CONFIG_JSON`. Restrict the service to one process per enrolled machine. Do not pass the credential to repository jobs.

The host state directory must be owned by the service user, mode `0700`, with no symlink in its path. The process checks for old labeled Docker resources before each claim. It verifies the selected Git commit, tree, and workflow blob through Golf's leased Git proxy, executes with network disabled and without the host credential, then sends a result only after Docker and local source cleanup. The evidence report labels customer-hosted cleanup as a host assertion.

For an approved image change, drain the pool and let active jobs finish. Install the new image on each host, save the draining pool against the new allocation, update each host config to the new image ID, then activate the pool and rebind repository placements to its new version.

## Interrupted attempts

The private `active.json` journal fences a host after a crash or uncertain outcome. A claim interrupted before assignment replays with the same claim ID; a result already cleaned up replays with the exact same payload. A journal in `claimed` state needs explicit local recovery:

1. Stop the host service. Run `golf-native-runner recover CONFIG_JSON` with the same host credential and Docker access. This removes only Docker resources labeled for that enrolled machine and its local `job-*` source directories, then leaves a `locally-cleaned` journal. If cleanup fails, inspect the named resources; capacity stays fenced.
2. Inspect the exact machine and job in the admin inventory. If the machine still has an active job, wait until that job is terminal and use **Reconcile cleanup**. This clears the server lease and leaves the machine draining. If the completion had already reached Golf, the inventory will already show no active job and confirmed cleanup. If the credential was revoked or expired, enroll a new machine after reconciliation.
3. Confirm the admin inventory shows no active job and cleanup `CONFIRMED`. Remove `active.json`, then restart the host service. Activate the machine if it is draining.

For a `cleanup-confirmed` journal whose completion receipt cannot be obtained before the lease expires, use the same recovery procedure. Never remove a journal or activate a quarantined machine merely because the host process exited.

## Qualification

`GOLF_RUNNER_TEST_IMAGE=sha256:LOCAL_IMAGE_ID go test ./cmd/golf-native-runner ./internal/runner -count=1` runs the real local Git proxy, Docker execution, completion, and recovery tests. The Cloudflare control path has separate migration, authority, lease, capacity, and Git proxy tests in `cloudflare/forge/native-runners.test.mjs`.
