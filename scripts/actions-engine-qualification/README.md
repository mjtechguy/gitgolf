# Pinned Actions engine qualification

AC-0 candidate: `nektos/act v0.2.89`, peeled source commit
`4f411281417e88660bea1c1a1749aa71ae0bd60f` (annotated tag object
`434d69682c7a8db2ac913e5dc3e80ba68055d50d`). Release/tag observed 2026-10-03:
[upstream release](https://github.com/nektos/act/releases/tag/v0.2.89).
`engine-pin.json` records the exact tag/commit, Go checksum-database identities
and downloaded module ZIP/go.mod SHA-256 values. The public source was fetched
through Go modules; no external action or repository CI workflow was executed.

This isolated nested Go module imports the real pinned engine without adding a
dependency to Golf's production `go.mod`. Ordinary tests exercise the model,
refusal gate and receipt validators without invoking Docker or source commands.
Owned YAML fixtures live in test strings, outside `.github/workflows`. Run:

```sh
cd scripts/actions-engine-qualification
go mod verify
go test -race -count=1 ./...
```

The cases characterize event membership, independent manual/push declarations,
dependency ordering/refusal, static matrix include/exclude and strict schema.
They deliberately expose the distinction between planning a job and expanding
its matrix, accepting an event name versus applying a branch filter, an engine
matrix expansion versus a Golf resource budget, and accepting policy keys versus
enforcing policy. Ordinary tests do not run source commands, Docker, an
external action, a native forge mutation or a paid provider. No fake
worker/result is returned to Golf.

Planner PASS does not prove branch/path filtering, conditions/runtime contexts,
dynamic matrices, secrets/permissions/concurrency/timeout, artifact/cache APIs,
trusted progress, full checkout, native admission, cancellation or recovery.
[Documented engine limitations](https://nektosact.com/not_supported.html) remain
gates. Do not install this module into the product or mark compatibility ready.

The explicit offline runtime packet below qualifies owned shell/composite
mechanics. Main Golf policy/source/attempt fences must remain in force before
that can become a product engine adapter.

The production seam is the operator `cmd/golf-runner` control process and
`internal/server/runner_transport.go`: existing enrollment/attempt capabilities
stay outside untrusted jobs. `internal/runner/execute.go` currently verifies
source, enforces preinstalled approved images, uses `--network=none`, drops
capabilities and owns cleanup. This qualification does not replace those
controls or introduce an alternate dispatch path. An engine adapter needs an
explicit versioned plan/assignment type instead of interpreting the existing
single-job `steps` payload as arbitrary Actions YAML.

The owned runtime uses a fresh trusted engine process with an
ephemeral dedicated daemon; pass only owned fixed source/action fixtures and
preinstalled digests, deny dependency fetch/host/socket mounts, and compare
engine-generated structured events with independent effect files. The pinned
source has a JobLoggerFactory hook and marks raw source output separately;
start/finish/result semantics still need actual qualification before these
become durable Golf worker progress. Hard deadlines must stop/clean all attempt
resources, not only cancel a local engine process.

## Offline runtime packet

`runtime_guard.go` rejects unsafe/unqualified executor features and caps YAML
complexity, graph/steps and static matrix cardinality before expansion. This is
a narrow qualification gate, not production policy. `runtime.go` executes only
compiled owned fixtures, distinguishes raw output from trusted engine fields,
inspects actual containers and effect files, and checks cleanup.
`run-offline.py` owns the complete fresh daemon and final resource cleanup.

After reserving a Docker resource window, opt in explicitly:

```sh
python3 run-offline.py --source-daemon golf-runner-daemon-1 \
  --artifacts /absolute/owner-only/new-artifact-directory
```

Actual terminal PASS on 2026-10-03 is recorded locally in
`.tmp/actions-engine-offline-runtime-qualified/manifest.json` and
`.tmp/actions-engine-offline-runtime-qualified.log` at the product root. Both manual
and push cases observe the five exact DAG/matrix effect files, five inspected
containers, two skipped steps, composite inputs/outputs and environment values.
The build step independently checks the event name, UID1000, missing socket and
missing daemon environment. The source/action and event SHA256 receipts remain
separate from the engine pin and opaque native image ID.

Failure produces no later effect. Four-second deadline cancellation observes
the started fixture, reports deadline failure and removes the native jobs.
Abrupt engine termination deliberately leaves one running job; the trusted
owner then removes the entire fresh daemon and anonymous volumes. This is
cleanup proof, never a successful job or retry/adoption permission. Earlier
failed manifests remain distinct: bypassing the image's DinD entrypoint failed
nested cgroups, and missing fixture transfer failed the local composite.

The trusted outer daemon uses the pinned image's `dockerd-entrypoint.sh` nesting
wrapper, an explicit Unix-only listener and no ports/network/host bind. Its
outer cgroups are unbounded like the local qualification daemon; each untrusted
job retains inspected256MiB/1CPU/64PIDs/user1000/capdropALL/networknone limits.
Before source steps, the trusted engine initializes only its fresh volume
ownership and transfers/readbacks the exact compiled local action. This setup
is explicit and distinct from untrusted job privileges. The launcher requires
at least2GiB disk reserve and hard-bounds execution/cleanup. Privileged local
DinD is not a production hostile-tenant VM boundary.

### Transport and corpus

Keep this a nested qualification module, not a second Golf dispatch subsystem.
Use one fresh engine process and an ephemeral, separately owned Docker daemon
with the currently approved Alpine shell image digest. Its existence in a
retained runner daemon does not establish availability in the new daemon: verify
the exact digest there before execution, using an explicitly authorized local
image transfer if needed. The operator supplies that digest; no image is selected by a
workflow or downloaded by the test. No Golf credentials, native token,
enrollment token or attempt capability enters the engine job environment.

The pinned engine's container defaults need explicit overrides and admission:

| Pinned source behavior | First runtime boundary |
| --- | --- |
| Empty `ContainerDaemonSocket` binds `/var/run/docker.sock` into jobs | Set `ContainerDaemonSocket="-"`; trusted engine `DOCKER_HOST` points only to the ephemeral daemon; inspect actual job mounts |
| Empty network mode uses host networking | Set `ContainerNetworkMode="none"`; reject services in this packet |
| Job `container.options` overrides operator options; volumes are accepted | Reject job `container`, services and Docker-action `uses` before constructing the executor |
| `ForcePull=false` still permits pulling a missing image | Independently require the image already exists and inspect each job's exact native image ID; daemon egress remains blocked |
| Missing platform labels can select host execution | Fixed owned `runs-on: golf-qualification` mapped to the exact image digest; reject every other label, including dynamic labels |
| Named toolcache volume is shared within a daemon | Fresh daemon per qualification; remove owned containers, volumes and networks even on timeout |

These observations come from pinned
[container configuration](https://github.com/nektos/act/blob/4f411281417e88660bea1c1a1749aa71ae0bd60f/pkg/runner/run_context.go)
and [image pull logic](https://github.com/nektos/act/blob/4f411281417e88660bea1c1a1749aa71ae0bd60f/pkg/container/docker_pull.go);
options alone are not a sandbox qualification.
Set `BindWorkdir=false`, `Privileged=false`, `ReuseContainers=false`,
`ConcurrentJobs=2`, `ContainerCapDrop=["ALL"]`, and fixed operator options for
non-root user, no-new-privileges, CPU/memory/PID limits. Block workflow-controlled
overrides. Separately inspect the resulting native container configuration,
because successful configuration parsing is not proof of enforced limits.

The owned corpus should use only local actions from the exact fixture tree:

1. A dependency diamond, two matrix cells, explicit `if`, job outputs and
   environment values; independently read expected effect files in each job
   volume before cleanup. Manual and push events are separate cases with
   deterministic owned event payloads.
2. One local composite action using explicit `shell: sh` steps; test inputs,
   output-file commands, propagated outputs, failure and cleanup on Alpine.
   No toolkit npm install, checkout download, remote action or repository
   network request. A separate later JavaScript packet needs a declared,
   preinstalled Node/toolcache image and pre/main/post lifecycle checks;
   composite success does not qualify JavaScript actions.
3. Raw source output that resembles engine progress; compare the trusted
   JobLoggerFactory event fields with independently observed step effects.
   Raw stdout must never create a Golf job/step transition. Qualify skipped,
   failed and matrix-instance identities before proposing an event adapter.
4. An owned long-running step canceled at a hard deadline, plus engine-process
   termination. Independently confirm no owned running container remains;
   failed cleanup makes the qualification fail, not a successful canceled run.
5. Predispatch refusals for remote/Docker actions, services, host labels,
   container options/volumes, unsupported schema and resource-exceeding graph
   or matrix input. These refusals currently have source-unit proof; no Docker
   execution/fetch is called by their tests. They are not a served Golf admission proof.

The wrapper must cap source/YAML bytes, alias/depth complexity, graph size,
matrix cardinality *before* unbounded expansion, command/output bytes and total
time. A source-only planner PASS is not that guard. Capture immutable engine,
image, fixture-tree and event digests separately from the observed effect and
cleanup receipts. Initially qualify engine mechanics only; no Golf run should
be created until the versioned assignment adapter preserves current exact-SHA,
push-sponsor, policy, authority, lease/progress fences and unknown-result rules.

Cloudflare's first engine placement can be the same external dedicated runner
while Cloudflare handles the control plane. A Cloudflare Sandbox/Container
placement needs its own daemon/process, mount, resource, cancellation and
cleanup evidence; this portable qualification does not establish that support.

Future coding-task or agent steps belong to the versioned Actions plan with an
explicit kind and durable drilldown. They must delegate to an authorized agent
execution capability; provider/account credentials must not automatically be
injected into ordinary engine job environments. This packet has no agent step,
provider execution or automatic credential grant. JavaScript, Docker actions,
remote action resolution, artifact/cache APIs, full checkout, dynamic matrices,
Golf progress/storage/recovery and Cloudflare execution remain separately open.
