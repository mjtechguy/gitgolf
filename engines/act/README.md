# Opt-in pinned Actions engine product adapter

This module builds the actual `golf-actions-engine` consumer for
`golf.workflow.act.v0.2.89.linux.v1`, using maintained nektos/act v0.2.89
(peeled source `4f411281417e88660bea1c1a1749aa71ae0bd60f`). It is separate from
the backend module. The default catalog remains `golf.workflow.shell.v1`.
No runtime execution qualification is implied by these source files.

## Product path

Explicit operator configuration admits an exact native Git workflow into an
immutable source archive and typed job/matrix/needs/step inventory. Native tree
and blob reads independently verify selected workflow and local composite
metadata. Inspect mode uses the same pinned planner without executing source.
Manual and automatic push use independent existing policy/session or sponsor
grant fences. Push additionally retains signed delivery/native activity checks.
No new user write authority or API bearer grants are added.

Only explicitly capable enrolled workers can claim this catalog. A whole run
executes inside a fresh, owned Unix-only Docker daemon/data volume. Approved
manifest digests are verified on the enrolled daemon, copied by exact image ID,
and independently inspected inside the child. No registry pulls occur during
source execution. Source runs under UID1000, network none, cap drop ALL,
no-new-privileges, PID64, CPU1 and memory/swap256MiB per job; at most two
independent stage jobs concurrently. Matrix variants run serially, within the
configured max-parallel ceiling, to avoid native shared-result/output races.
The trusted daemon itself needs privilege, CPU2/PID512 and memory/swap1GiB.
This is an operator-isolated Docker boundary, not a hostile-tenant VM guarantee.

Known local-action directories are immutable read-only mounts from the owned
child helper workspace. Their source copy is excluded from the writable job
volume; root-owned sticky ancestors prohibit replacing a mounted path while
allowing ordinary build output. First-catalog local-action directory names use
literal ASCII paths, up to eight definitions, recursive depth four. Ordinary
source paths retain bounded UTF-8 support. No outer host path/socket is exposed.

Trusted pinned logger fields drive step frames separately from raw source
log frames. Public native Plan/Stages/GetMatrixes/RunContext.Executor facilities
execute actual jobs. Each instance owns its JobError context; completion uses
returned executor error plus that own error, with actual native skip receipts.
Shared native matrix Job.Result headers never determine individual completion.
Completed per-instance results form the dependency aggregate before next stage.
This avoids propagating one failed variant's header to a successful sibling.
Per-frame duplex ACK follows durable server commit; forged raw JSON remains
only log text. Missing/gapped/duplicate-changed/unadmitted conclusions cannot
become success. No invented per-step exit codes are projected. Job/step log
selection binds original run/attempt/repository/commit and immutable coordinates.

Cleanup destroys the entire child daemon and its data/anonymous volumes.
Restart refuses any residual owned resource; operator recovery first fences
backend attempts, then removes only verified enrollment/attempt/owner resources.
No automatic retry/resume is permitted after owner loss or unknown completion.

## Bounded implemented source catalog

Linux, explicit image labels; manual/push declarations and literal push branch
lists; static matrix include/exclude (12 expanded instances), DAG needs,
conditions, env, non-matrix job outputs and local composite actions. Matrices
require explicit fail-fast:false; native cancellation-faithful fail-fast and
matrix aggregate outputs remain refused until their own execution contract
is qualified. Jobs eight declared,
32 top-level steps per job,128 expanded executable steps, source16MiB/4096
ordinary entries, individual8MiB, workflow/action metadata64KiB. Dynamic matrix,
continue-on-error, services/job containers, remote/JavaScript/Docker actions,
reusable workflows, arbitrary GitHub API/runner/secret contexts and ignored
controls are refused. Full promised Actions catalog, GitLab execution parity,
network/action pin policy, artifact/cache/checkouts, distributed scheduling,
per-repository engine selection and latest-schema recovery remain open.
Whole-workspace byte identity beyond the independently verified selected
workflow/local definitions remains the existing normalized archive contract;
Git export-ignore/export-subst are not claimed to be an exact tree manifest.

## Root-controlled runtime qualification (not yet run)

1. Preserve source-only checks/logs; merge generated API with parallel additive
   fields. Build both Golf and runner Dockerfiles on the frozen combined source;
   record exact image/config/source revisions. Existing images lack this helper.
2. Fresh isolated Compose stack only. Include `compose.yaml`, `compose.ci.yaml`
   and `compose.actions-engine.yaml`; optionally the existing storage overlay.
   Never enable this profile on retained local policies during qualification.
   Private enrollment/image env still comes from the existing initializer.
   Golf settings: `GOLF_ACTIONS_ENGINE_CATALOG` equals the catalog and
   `GOLF_ACTIONS_ENGINE_BINARY=/usr/local/bin/golf-actions-engine`.
   Worker: matching binary and `GOLF_RUNNER_ACTIONS_PLATFORMS` exact image map.
   Opt-in image-init supplies pinned Docker29.8.1 child daemon image
   `docker:29.8.1-dind@sha256:3f3c01aaaebf7cce837356b688b7c059a4749f10bd7660dec7c58fc454a283f0`
   on the dedicated runner daemon before jobs. No runtime pull fallback.
3. Enroll disposable ordinary managed actors through supported native/Golf APIs.
   Commit `testdata/production-graph.yml` as `.github/workflows/graph.yml` and
   `testdata/actions/owned/action.yml` unchanged. Actual source contains no
   remote actions/provider calls/secrets. Verify native M/H/blob/archive receipts.
4. Inspect through product API, set independent fresh-stack manual policy, and
   dispatch through Golf. Prove old worker receives204; upgraded real runner
   receives typed five-instance graph, actual immutable composite tamper checks,
   non-matrix producer outputs, skipped step, needs order, complete trusted receipts. Native
   manifest→image-ID verification, outer/inner inspected constraints and cleanup
   must be independently inspected before declaring this runtime qualified.
5. Read product run/detail/log APIs and both-theme desktop/mobile UI. Compare
   exact job+step filtered output, echoed run/attempt/repo/H, and known graph
   conclusions. No metadata inferred from source JSON or raw log phrases.
6. Set independent push policy+active sponsor grant and controlled signed push
   under existing supported fixture helpers. Prove a distinct push-origin run,
   fresh native activity, exact pushed H and same actual graph. A policy flag is
   not a sponsor grant or universal dispatchability guarantee.
7. Run `testdata/mixed-matrix.yml` unchanged as a separate workflow: actual
   cell a failure/cell b success, own success()/failure() handlers, failure
   dependency aggregate, always() aftermath and default-skipped dependency.
   Overall outcome must remain failure, not LOST or all green. These actual
   Docker outcomes remain unqualified by substituted source test callbacks.
   Separately prove cancellation, revoked
   session/native authority/grant and lost durable ACK must remain non-green.
   Force-kill an owner during a long source step; observe residual child/data,
   expired lease LOST/no reassignment; restart refuses residual resources. Run
   supported worker `recover` only after all owners stopped, verify old token
   fenced and complete owned-domain deletion while another-worker fixture stays.
8. Finally disable managed actors/revoke sessions, purge supported native repos/
   actors, remove only fresh owned Compose volumes/daemons, report retained Golf
   evidence honestly, queues/resources empty. Root owns fixture serialization.

Source tests use the pinned host planner and real isolated PostgreSQL with a
substituted external provider boundary. They are not Docker execution, public
native feature, full catalog or deployment qualification.
