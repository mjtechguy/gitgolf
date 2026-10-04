# Enrolled Docker runner controls

This bounded increment manages already operator-enrolled Docker worker identities. It does not create enrollments, rotate keys, authorize labels, schedule pools, autoscale, or qualify Kubernetes/Cloudflare runtimes. Full Runners settings remains Partial.

## Current observation and authority

`RunnerControlService.GetInstanceRunners` requires a current managed Golf password session with current local instance-administrator authority before and after reads. Neither native administrator status nor a delegated API credential grants this authority. The root HTTP integration must register all three methods behind the existing exact-Origin, managed-cookie, no-store boundary and keep them outside the read-only API allowlist.

The inventory is the bounded operator-configured map (maximum100 identities), sorted by worker ID. It returns only worker ID, control state, canonical signed64 control version, optional observed database `last_seen`, database-clock recent connection (15seconds), and whether a live unexpired assignment is observed. It returns no enrollment keys, attempt capabilities, private repository/user identities or source. Control, connection and assignment are independent observations, not health or capacity guarantees. Polling a revoked identity may still record its connection while admitting no work.

`GetRepositoryRunners` additionally requires exact native repository and owner IDs and a supported literal workflow path. Current native caller/repository access is checked before and after reads, and owner identity is checked again. It returns the canonical repository binding, selected workflow path, and inherited manual/push policy observations for that exact workflow. A missing policy denies execution. The response exposes neither higher-scope private repository selections nor a new execution grant. Engine, image, approval, source and dispatch authorization remain independent admission predicates.

All reads/mutations use a15second deadline. No cache, provider/native write, inference or new enrollment is introduced.

## Explicit control changes

`UpdateRunnerControl(worker_id, expected_version, state, current_password)` requires current local instance-admin password confirmation and repeats the managed user/account/session checks under SQL locks after waits. Passwords are neither retained nor returned. Versions are decimal strings, including initial`0`, without a JavaScript-number conversion. A configured identity with no control row starts ACTIVE/version0; accepted transitions advance exactly once.

| Current control | Accepted next controls | Effect |
| --- | --- | --- |
| ACTIVE | DRAINING, REVOKED | Stop new claims; revoke additionally cancels active attempts. |
| DRAINING | ACTIVE, REVOKED | Resume new claims, or permanently revoke. |
| REVOKED | None | Terminal for this identity. An operator must enroll a **new identity and key**. |

Unchanged states and stale versions are refused. An acknowledgement is metadata only. Lost acknowledgements require explicit current-state inspection; the client never automatically retries or attributes a later observed state to an earlier uncertain request. Subsequent explicit changes use the inspected current version.

Migration047 retains control state/version and actor-scoped transition metadata. A database trigger prevents deleting control rows, rewriting identity, restoring a revoked identity, repeated state changes or nonsequential versions. Startup key configuration never clears durable revocation.

## Transport and release fences

Claim, existing-attempt processing and control mutations serialize using the existing exact forge/worker advisory transaction lock. DRAINING rejects new claims with no assignment while existing heartbeat/source/log/graph/progress/finish paths retain all existing authorization, exact lease, source approval, policy and encrypted-output release fences.

REVOKED rejects new claims and atomically cancels matching running attempts, marks cancellation and clears lease token/expiry. Existing-attempt source/log/heartbeat/finish paths recheck revocation under the shared lock before accepting output or releasing source. An already authorized/committed response cannot be recalled. SQL cancellation is not proof that an execution daemon has physically cleaned its containers. The runner's existing refusal/cancellation cleanup path remains the consumer; cleanup must be independently qualified. Lost/cancelled attempts are never automatically replayed. Quarantined output remains withheld when revocation prevents successful final release.

## Evidence and remaining gates

Isolated pure/compile race checks pass1.523s; real-PostgreSQL cases are skipped because no source database is authorized in this worktree. TypeScript, web build, vet, Buf lint/generation drift and whitespace checks pass. The twelve standalone browser cases pass5.1s. Earlier harness attempts are preserved separately: incorrect HTML/React refresh handling, a temporary Vite CJS config loader, and one denial test/product feedback gap were corrected before the passing run.

The isolated source tests exercise transition/version/delegation guards and author real-PostgreSQL cases for admin/password/CAS/restart retention, inherited policy and exact native binding, claim-lock races, active work continuing while draining, and revoke cancellation/source/result fences. PostgreSQL cases require`GOLF_TEST_DATABASE_URL` and are **not qualified by a skipped run**. A standalone browser component harness covers compact explicit controls, exact receipts, lost response inspection, denial clearing and theme/mobile behavior; this is source-fixture evidence, not a served/native runner qualification.

Root integration still must register/mount the service/client/components, run the database suite and qualify actual controlled execution, cancellation/daemon cleanup and current authority/race/restart behavior on exact new runtime images. Capacity, trust classes, enrollment lifecycle, runner groups/labels, autoscaling, Kubernetes/Cloudflare runtime gates and latest-schema recovery remain open.

## Prepared fresh runtime qualification

The new `scripts/runner-controls-smoke.py` / `runner-controls-browser.mjs` pair is prepared, **not run**. Pure `--self-check`, Python AST, Node syntax and whitespace checks are preparation evidence only. Root executes it against explicitly supplied already-cached core and runner images:

```sh
python3 scripts/runner-controls-smoke.py --image sha256:CORE --runner-image sha256:RUNNER --output .tmp/runner-controls-served-attempt1 --ui
```

`--stack-root` optionally selects the actual Compose/client checkout. Image placeholders must be replaced with exact local identities; nothing is pulled or built. The core/native/PostgreSQL/DinD dependencies must already exist. Before runtime setup, the helper checks a 2GiB Docker VM reserve. It uses a fresh uniquely labeled Compose project and loopback ports, owner-only temporary credentials, ordinary supported native actors/APIs and managed Golf operator enrollment. No retained stack, provider inference, paid calls, notification destination or native database/repository write is used.

A bounded `seed-pending.json` advertises **only** the owned fresh daemon container ID, expiry and exact public Alpine/DinD references. Root must explicitly seed those already-approved cached images into that daemon during the window; the helper never pulls, builds or tags them. `seed-ready.json` records independently inspected exact local image identities. Compose image-init is explicitly replaced with `/bin/true`; there is no hidden pull path.

Evidence separates two scopes:

- A controlled `protocol-worker` obtains genuine server lease/capabilities and exercises source hash, draining heartbeat/log/finish acceptance, second-queue exclusion, resume, revoke source/log/heartbeat/finish refusal, stale CAS and terminal restart behavior. Its supplied completion is **not evidence of an executed job**. Capabilities and source/log bytes stay in transient memory.
- A distinct real `local-docker` worker runs owned bounded shell workflows in the seeded fresh daemon. The helper inspects actual managed/worker/attempt labels, proves heartbeat expiry renewal while draining, observes continuation logs and successful finish, proves the next queued run waits until Resume, then revokes a separate live attempt and independently waits for both its containers and source volumes to disappear. Existing configured identity remains blocked after core/worker restart. Cancellation does not substitute for these resource checks.

The optional browser helper uses canonical `/admin/settings/runners` and `/OWNER/REPO/settings/runners`, exact selected workflow metadata, shared explicit controls and password confirmation. It records twelve actual font-settled dark/light1440/390 inventory, requested-confirmation and repository-policy captures, plus once-only Drain/Resume/Revoke/reload checks against four fresh idle worker identities. No auto-retry or password-bearing capture is allowed. Each fixture account uses a distinct existing password-rate bucket; limits are not changed.

Finalization stops the actual consumer and independently checks owned attempt cleanup before revoking managed sessions, disabling only owned Golf accounts, supported native actor purging and exact fresh-project container/network/volume removal. Original failure stage/type/line metadata is preserved separately from cleanup failure categories. No raw subprocess/provider/worker logs, passwords, enrollment keys or capabilities are retained in artifacts. Final PASS requires the runtime identities to remain unchanged and every cleanup check to pass. This gate does not qualify production scale, hostile-tenant isolation, pools, labels, autoscaling, Kubernetes/Cloudflare runners or latest-schema recovery.
