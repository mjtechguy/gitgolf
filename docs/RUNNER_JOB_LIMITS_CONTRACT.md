# Runner job limits: bounded local Docker contract

This is the source contract for schema053, integrated with the organization-sharing descriptor in `b451ead63266c2b0b9e1b3f71a135590587067ed`. Wire source is `16f17c4d33b530d5f2cdf0bfa4cd96f09dcb63d1`; the controller/executor packet is `1b4c713206a5680e3f1fc472b2d6b6ccf688128d`. It adds enforced limits to the existing workflow admission, pool placement and Docker consumers. It does not qualify a deployed image, expand supported workflow syntax, or complete the Runners settings section.

The profile is `golf.local-docker.restrict.v1`. It only restricts the previous fixed Docker maxima. AI and Cloudflare are unnecessary for this portable capability. Kubernetes, Cloudflare execution, coding-agent processes, larger build profiles and capacity orchestration need separate consumers and qualification.

## Values and authority

| Value | Accepted range | Meaning |
| --- | --- | --- |
| `cpuMillis` | 100–1000 | Per job container CPU quota, in thousandths of one CPU. |
| `memoryBytes` | 67108864–268435456 | Per job container memory ceiling; canonical decimal string. Docker memory and memory-swap are both this value. |
| `pids` | 16–64 | Per job container process ceiling. |
| `timeoutSeconds` | 1–900 | One execution deadline shared by source retrieval and execution for the attempt. Cleanup and final reporting have separate bounded contexts. |

The defaults are 1000 millis, 268435456 bytes, 64 PIDs and 900 seconds. Zero, omitted individual values, alternate memory notation, leading zeroes, signs, overflow and values outside the profile are refused. Limits cannot be supplied through runner labels, workflow options or a network-class field.

- **Instance:** `GetInstanceRunnerLimits` and `SetInstanceRunnerLimits` require a current managed local instance administrator. Set requires current-password confirmation and exact canonical `expectedVersion`. It has no native repository grant. Other origins, anonymous callers and delegated API/PAT/bearer access cannot administer the policy.
- **Pool:** the existing password-confirmed instance-admin `SaveRunnerPool` accepts an optional `jobLimits`. An explicit value cannot exceed the current instance ceiling.
- **Repository:** the existing native owner/direct-admin, managed local password-confirmed `SetRepositoryRunnerPlacement` accepts optional `jobLimits`. Repository identity, owner, access revision, placement version and selected pool version remain exact. An explicit value cannot exceed the current instance/selected-pool parent.

The effective limit is the component-wise minimum of instance, selected pool and repository configuration. Tightening the instance policy remains possible even when previously configured children are higher: their effective limits decrease; their saved configuration is retained. Omission on an existing pool/placement update preserves its configured limits. New omitted configurations use the current parent minimum. These configuration observations do not themselves prove worker availability or successful enforcement.

## Wire and retained state

`RunnerJobLimits` carries the four values above. Instance policy returns its exact version and update time. Pool and placement inventories return both configured `jobLimits` and independently observed `effectiveJobLimits`.

`WorkflowRun.jobResources` records `profile`, `limits`, `instanceVersion`, `poolId`, `poolVersion`, `placementVersion` and `bound`. Native repository/source identity, authority, engine catalog, workflow input and attempt identity remain in their existing records; the resource object cannot replace them.

Startup initializes an explicit instance version-zero/default row before traffic. Every new manual or configured-push workflow admission freezes the actual effective limit and current instance generation. The existing pool/placement admission trigger runs first; the resource trigger binds that selection. The snapshot cannot be edited afterward.

Historical runs receive `resource_bound=false` during migration. Their wire response has no invented profile, limits or instance generation. They remain inspectable, but cannot claim a worker or release source/credentials/results. The controller never converts them to version-zero admissions or automatically dispatches replacements. A user must explicitly request new work under current policy.

Instance edits compare the expected version, increment generation and retain metadata-only audit values in one current transaction. A lost acknowledgement does not authorize a fresh-version retry: inspect current values first; retrying the original stale expected version is refused. Pool and placement updates retain their existing CAS and audit behavior, now including configured limits. Limits have no secret content or new encryption family. Forward recovery for053 remains unqualified; retained resource snapshots/audits cannot be discarded through an ordinary down migration.

## Admission and release fences

The current controller requires `golf.runner.job-limits.v1` from an operator-enrolled worker's poll. The older qualified047 runner image `sha256:0222090d296cbda3725e60329a14b624c33c7d5b94711a617d8623d3e461fed5` does not declare it and receives no assignment. A declaration is a trusted enrolled worker's capability claim, not cryptographic image attestation. Matching controller, runner and pinned act-engine image bytes require actual qualification together.

| Consumer | Required observation |
| --- | --- |
| New admission | Current instance row; exact admitted pool/placement; effective values retained in the new run. |
| Claim | Current native/dispatch/policy/secret fences, worker placement/capacity, original resource snapshot, current instance/pool/placement generations and effective values. |
| Assignment response | A second current resource observation after any post-claim native approval check, before returning the attempt/environment. |
| Source | Existing current native/dispatch authority, original resource snapshot and current generations before committing source release. |
| Heartbeat | Current original binding and generations; a stale attempt cannot renew its lease. |
| Logs, shell progress and act graph | The same shared active-attempt fence before durable acknowledgement. Existing exact sequence/job/step and output-quarantine rules remain. |
| Finish / output release | The same fence before completion and SQL-only verified-redaction release. Stale output cannot become a successful result. |

A missing or stale binding cancels/refuses the original queued or running attempt with a readable reason and no automatic replay. Resource cancellation retains the original values, marks cancellation requested and removes the active result credential. Storage/observation failures are unavailable; they do not fabricate a newer binding or a known successful result. Existing lease expiry/lost-result behavior remains unchanged.

### Lock order and timing

Native identity and permission proofs occur before the new short instance read lock. Admission, claim and active consumers use the existing repository/user/lifecycle/execution/broker coordination and placement/worker/pool/run ordering; the final instance row is read `FOR SHARE`. Multiple resource readers are compatible. Instance Set edits only the instance generation row and audit, taking no active-run, pool or placement lock. This avoids an instance-edit→run inverse lock dependency. Repository placement takes its final instance check after its native re-observation; pool Save performs only database work after obtaining that read lock. Current checks use current Read Committed transactions, not a retained Repeatable Read generation.

A resource release is authorized at its final transaction. Committing that transaction and the remote client receiving its HTTP bytes are not one atomic event. A later policy edit cannot retract bytes already admitted for release. Policy changes fence subsequent requests and cancellation is observed by the maintained worker; they do not instantly alter cgroups of an already running process. The worker currently heartbeats every 10 seconds and cancels execution on refused acknowledgement. Actual observation latency, stopped descendants and cleanup latency must be measured before making a runtime guarantee. Worker SIGKILL, host loss or an unavailable Docker daemon can leave an orphan running; removing its lease/result credential does not physically stop it. Hardened orphan lifetime enforcement remains open under the isolation contract.

## Docker enforcement

The shell executor validates admitted values, creates helper/job containers with explicit `--cpus`, `--memory`, `--memory-swap` and `--pids-limit`, and independently inspects the exact container ID and HostConfig values before source copy and executable startup. Missing, zero, different-container or differing resource receipts stop execution. Existing non-root/capability-drop/read-only/approved-image/network-none/owned-cleanup controls remain.

The maintained act engine receives the same immutable binding and whole-attempt timeout. Its job options use the admitted values, and its existing exact job-container shape inspection compares CPU, memory, swap and PIDs before source transfer. It does not infer job limits from workflow labels or caller Docker options.

The act outer daemon remains a separately owned fixed 2-CPU/1-GiB/512-PID envelope and concurrency remains two. A per-job ceiling is not an aggregate attempt or pool CPU/memory reservation. Two concurrent matrix instances can each consume their job allowance. Lowering the inner ceiling does not lower the outer daemon envelope. Larger profiles, aggregate accounting and configurable outer envelopes remain open.

The trusted direct local executor API can omit limits and retain the former fixed defaults for its isolated qualification fixtures. Production coordinator assignments cannot: missing `jobResources`, wrong profile, malformed versions/UUIDs or a timeout differing from the snapshot are refused before executing source. This local API compatibility is not controller admission authority.

## Source checks and pending actual acceptance

Pure race tests pass for runner 2.988s, runner command 1.334s and the full pinned act module 3.700s. Affected pure server tests pass 1.610s; database-dependent cases were skipped without `GOLF_TEST_DATABASE_URL`. Go vet, Buf lint, generated local sqlc drift and whitespace checks pass. Earlier compile/test failures were corrected before the frozen consumer commit; they are not runtime proofs. Root's real PostgreSQL and combined-main checks are pending in this source snapshot.

Authored database cases cover instance CAS and restart, parent tightening while children remain higher, immutable effective admission, zero source/heartbeat/log/finish release after tightening, original intent receipt/no replay, and a real blocked UPDATE proving the final shared generation fence. Existing pool/control/lease/source/automation/act/secret-consumer fixtures explicitly declare the new resource capability. Additional fault/race coverage and the actual acceptance below remain necessary.

### Required matching-image qualification

1. Record exact core, runner, act-engine and approved shell-image bytes, schema053 and readiness before/after; use only fresh owned execution resources. Keep older047/pool evidence attributed to its original images.
2. Run shell and maintained-act jobs at default and lower intersected ceilings. Independently inspect every owned helper/job container and confirm literal HostConfig CPU/memory/swap/PID values match the admitted receipt before source transfer. Record cgroup controller values or equivalent supported evidence; configuration inspection alone does not prove kernel enforcement.
3. Exercise bounded CPU work, allocation beyond the memory limit, process creation beyond the PID limit and a sleeping job beyond the execution deadline. Record actual outcomes and cleanup; no success inferred solely from a configured value or a generic failed exit.
4. Show that the exact old022 image cannot claim, receive source or receive private execution values. Missing/unsupported/malformed/duplicate capabilities and missing/changed bindings must not start a job.
5. Prove instance admin/password/Origin/CAS and pool/repository parent restrictions. A global administrator without native repository management cannot use that role to edit a repository placement. Unsupported/over-parent values must produce no new configuration/audit/admission.
6. Tighten instance, selected pool and repository limits while work is queued and active. Independently prove stale claims/source/results are denied, private source/environment bytes are withheld, and the original snapshot stays readable. Measure cancellation/descendant-stop/owned cleanup latency; preserve UNKNOWN/lost outcomes without retry.
7. Hold source/storage and final-admission/claim waits, then change policy/native authority/session. Test both orderings around the final short generation transaction, including a change between initial proof and the final release fence. A stale cached generation cannot admit work.
8. Exercise manual and configured push, unbound and pooled work, two workers/capacity backpressure, restart with queued/active/completed/missing-binding histories, lost acknowledgements and exact original intent replay. No run may silently adopt a new snapshot or resurrect after cancellation/loss.
9. For secret-bearing act work, retain verified TLS/approval/value-version fences; prove stale policy leaves quarantined output withheld and prevents final release. Use an owned controlled fixture, no paid provider or external destination.
10. Once settings consumers are integrated, inspect requested editors/current configured/effective values and original run receipts in both themes at 1440/390, including readonly/denied/stale-CAS states. Saved configuration is not Healthy/Ready evidence. Full Runners and latest053 recovery stay open until their broader acceptance gates pass.

See [runner controls](RUNNER_CONTROL_CONTRACT.md), [pool placement](RUNNER_POOLS_CONTRACT.md), [runner isolation](RUNNER_ISOLATION_CONTRACT.md), [implementation status](IMPLEMENTATION_STATUS.md) and the [implementation plan](../GOLF_IMPLEMENTATION_PLAN.md).
