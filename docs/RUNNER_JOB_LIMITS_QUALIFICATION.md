# Prepared local Docker resource qualification

This recipe and `scripts/runner-resource-limits-smoke.py` are source-only preparation for schema053. No Docker, native, PostgreSQL, SMTP, inference or browser operation was performed while preparing the helper. A pure self-check is not runtime qualification. Full Runners remains Partial.

## Invocation and ownership

Run from an approved resource window. The root operator owns the actual run, image provenance, fresh daemon seeding and original/cleanup evidence. Every image must already exist locally; the helper never builds, pulls, tags, prunes or changes the retained stack. It creates an unpredictable `golf-limits-*` Compose project with fresh native users, managed accounts, PostgreSQL/native volumes, two upgraded worker processes, one separately pinned legacy worker and one trusted privileged DinD host. The daemon has no published port. Job containers retain network-none, nonroot, readonly, capability-drop and no-new-privileges isolation.

```sh
python3 -B scripts/runner-resource-limits-smoke.py --self-check

python3 -B scripts/runner-resource-limits-smoke.py \
  --stack-root /absolute/path/to/golf-git \
  --image sha256:EXACT_CORE_IMAGE \
  --runner-image sha256:EXACT_NEW_RUNNER_IMAGE \
  --old-runner-image sha256:EXACT_OLD_022_RUNNER_IMAGE \
  --expected-source FULL_40_CHARACTER_SOURCE_COMMIT \
  --expected-runner-sha256 EXACT_64_CHARACTER_RUNNER_BINARY_SHA256 \
  --expected-engine-sha256 EXACT_64_CHARACTER_ENGINE_BINARY_SHA256 \
  --output /absolute/path/to/new-owner-only-output \
  --seed-timeout 300
```

The placeholders must be replaced with independently recorded immutable receipts. Both upgraded images must declare the requested source revision. Public binary hashes are checked independently: runner executable in the runner image, maintained engine executable in both upgraded images. Working-tree HEAD is recorded separately and is not served-source evidence. The old schema022 image is a distinct immutable negative fixture, never relabeled as an upgraded worker. Its exact original source is recorded when a valid image label exists.

The current b451 source artifact receipt in the root workspace is `.tmp/settings-053-first-host-artifact-receipt.json`; its core image is `sha256:c0f752c8c2c1d3126958d465800c6309c5ed962066a4f90bf44aec7f50dc56d9`. The public runner executable hash is `3229bea85353b2642c08e814bcb1a852d4d6ffc072390e4b65dca829897470c6`, and the maintained engine hash is `f24c42dd5404e536698215ecfef703940134d926407560641b7f509e54978f96`. These are build provenance, not an actual053 execution receipt. The matching runner image must be built and independently pinned by root before invocation; this document invents no image ID.

At `seed-pending.json`, root uses its existing exact-image seeder to transfer the approved cached Alpine and DinD into **only the announced fresh daemon**. The helper polls for their native immutable identities within the selected deadline and writes `seed-ready.json`. It does not seed or inspect retained jobs. A 2-GiB free-space guard remains mandatory; insufficient space fails before the fresh stack starts.

TLS uses a fresh CA with critical CA/key-signing extensions and a server certificate with critical non-CA/digital-signature extensions, loopback-IP SAN and serverAuth usage. Only individual readonly certificate files are mounted. Actual trusted TLS1.3, unknown CA refusal and wrong-hostname refusal are required; verification is never disabled. Browser management RPCs use managed cookies, exact Origin, Connect protocol headers and no-store receipts. The HTTP cookie transport is confined to the owned loopback test endpoint. Worker transport is verified HTTPS.

## First actual acceptance group

| Group | Required observation |
| --- | --- |
| Startup and hierarchy | Fresh instance explicitly reports version `0` defaults: 1000 CPU millis, 268435456 bytes, 64 PIDs, 900 seconds. Current local instance admin CAS sets a 60-second instance ceiling; a second independently authorized instance/repository admin creates a 500-millis/128-MiB/32-PID/45-second pool. Repository admin requests 250 millis/96 MiB/24 PIDs/30 seconds. Exact configured/effective receipts and an independent component minimum agree. |
| Role and request boundary | Reader denied Get/Set instance limits; stale instance version denied; wrong Origin and delegated bearer denied. Normal password verification buckets are preserved; administrator edits are divided between two current authorized accounts. These checks supplement, rather than replace, the broader authored server authority/fault cases. |
| Old consumer refusal | Only the exact old schema022 process is started for twelve bounded observations. It stays alive while the resource-bound run stays queued with no runner/attempt and no managed job container or volume. This is actual polling by the old process, not a mock claim or an invented healthy signal. |
| Two upgraded consumers | Two queued jobs execute under separate enrolled keys/processes in the same owned daemon. Each run returns its original repository/owner/source/placement/resource binding. No credentials from the control plane occur in job environment or logs. |
| Docker enforcement | Independently inspect each running ordinary inner job's exact image and managed worker/attempt labels, readonly root, nonroot identity, no host binds/device/capability additions, no-new-privileges and network-none. HostConfig memory and memory-swap both equal 96 MiB, NanoCPUs equals 250000000 and PidsLimit equals 24. |
| Kernel observation | Actual cgroup-v2 CPU quota/period gives 250 millis, memory.max gives 100663296, memory.swap.max gives 0, and pids.max gives 24. The owned workload checks the same controllers before reading its README and emits fixed completion markers. Missing/unsupported controller observations fail; configured numbers alone cannot pass. |
| Completion and output | Both actual jobs succeed. Log pages are bounded and have exact run/attempt/repository/source receipts with ordered sequences; fixed controller/completion markers are present. Raw logs, environment and inspection JSON remain in memory and are not artifacts. Independent daemon queries find no attempt containers or volumes afterward. |
| Whole-attempt budget | A new explicit placement version requests 3 seconds. An owned job that would sleep 10 seconds ends TIMED_OUT within the bounded source-to-finish window, retains that exact admitted budget, never emits the late completion marker and leaves no attempt containers or volumes. This proves the observed wall budget/cleanup, not instantaneous hardware quiescence. |
| Restart and known intent | Core restarts with the same image/config. Completed and timed-out attempts retain original source/resource/worker/attempt observations. Reposting the first exact known operation returns its historical original receipt despite changed current placement; no replacement attempt or job appears during the bounded idle observations. |
| Cleanup | Stop all owned consumers; independently verify all managed job containers and volumes are absent. Revoke/logout managed sessions, disable fixture accounts, purge only owned native users, remove only the exact fresh Compose project and verify its containers, volumes and networks are absent. Original failure and cleanup failure are separate; cleanup cannot turn a failed run into PASS. |

External HostConfig/controller inspection occurs **after the inner job starts**. Production's exact pre-copy inspection is separately source-backed. This helper does not claim its external inspector observed the byte-transfer boundary atomically, nor does its owned nonsecret README qualify secret release.

## Remaining acceptance

The manifest explicitly leaves actual default-max job execution (only startup defaults are read), CPU saturation, OOM/PID-exhaustion stress, act-engine graph enforcement, active/queued tightening, source/private-environment/output/result revocation, measured cancellation latency under policy tightening, requested settings captures, larger approved profiles, aggregate accounting, hostile tenant isolation, Kubernetes, Cloudflare and recovery open. Ordinary container timeout/cleanup is distinct from host/daemon failure or SIGKILL orphan remediation. The fixed outer act-daemon envelope is not exercised by this shell packet.

Per-container ceilings do not reserve aggregate memory or CPU across jobs or pools. No million-repository/worker scale claim follows from two consumers. Core, runner and maintained engine must agree on the current capability/profile; old-runner admission refusal is intentional and does not make older qualified schema047/050 image evidence false.

Only a terminal actual invocation with complete scope-specific receipts and cleanup establishes this bounded group. Failed attempts retain their original artifacts; no old image/capture is relabeled as a new resource qualification.
