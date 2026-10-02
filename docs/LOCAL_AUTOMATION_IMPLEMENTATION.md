# Durable push automation and local coding agents

Design review: 2026-10-02. This document specifies the next portable implementation; it does not claim automatic dispatch or any Golf coding-harness adapter is implemented. [Implementation status](IMPLEMENTATION_STATUS.md) remains the qualification ledger. The in-progress native HMAC webhook intake and durable delivery deduplication are separate work: accepting an event must never imply permission to execute it.

## Current boundary and reuse

The reviewed paths are `internal/server/workflow_runs.go`, `runner_transport.go`, `execution_policy.go`, `workflow_execution.go`, `workflows.go`, `keyring.go`, `key_operations.go`, `database/queries/keyring.sql`, `database/migrations/202610020011_workflow_runs.sql`, `internal/runner/execute.go`, and `cmd/golf-runner/main.go`.

| Existing behavior | Consequence for the next increment |
| --- | --- |
| `DispatchWorkflow`, `withWorkflowRepository`, and `workflowTransaction` authenticate a current browser cookie and lock its Golf user/session. | Preserve manual dispatch; never manufacture a browser session for a push event. |
| Run rows require `user_id` and a 32-byte `session_hash`; idempotency is user/key scoped. | Add an explicit automatic authority origin, rather than putting a service token digest into `session_hash`. |
| `runnerRunAuthority` opens that source session, verifies current native identity and repository write/admin authority. `runnerPolicyFence` locks the source session and compares policy epochs. | Both checks need a narrowly typed automation variant; changing enqueue alone will fail or bypass necessary revocation fences. |
| Policy ceilings now have independent default-disabled manual/push switches and an explicit event-aware helper; every required scope must allow the event. | Automatic scheduler integration must use the push helper and pinned stamps. A switch alone does not implement automatic work. See [execution policy contract](EXECUTION_POLICY_CONTRACT.md). |
| Actions inspection admits input-free `workflow_dispatch`; GitLab execution is a bounded script subset. | Add a documented push trigger subset to inspection and compilation. Unsupported syntax must stay blocked. |
| Normalized source is bound to exact commit/blob/SHA-256 and optionally an immutable object-store profile version. Jobs receive no forge credential. | Reuse for initial automatic shell CI without introducing Git or model access. |
| Docker jobs have no network, no `.git`, a writable copy, fixed resource bounds and an approved image digest. | Real coding agents and dependency downloads need a separately qualified execution profile. Do not relax all shell jobs globally. |
| Worker enrollment and attempt capabilities control polling, source, heartbeat, logs and finish. Expired attempts become lost, without replay. | Reuse these transport/lifecycle primitives; runner identity is not repository or inference authority. |
| Keyring permits four concrete credential domains; rotation counts and traverses their SQL rows. | Any automation credential domain requires counting, rotation, retirement and recovery coverage in the same increment. |

The smallest useful sequence is automatic **existing shell jobs first**, followed by one real local harness adapter and then the other four. This avoids coupling push CI to model access or changing the isolation guarantees of existing jobs. AI and Cloudflare remain optional.

## A repository-bound automation grant

Use a first-class repository grant with a server-generated principal ID and an immutable versioned native credential. No synthetic local account, Golf password, cookie, or source-session clone is needed. A human currently authorized to administer the repository explicitly creates/enables the grant through cookie/Origin-protected settings. The caller's session authorizes configuration changes, not future execution.

The initial grant covers one canonical forge, one immutable repository ID and owner ID, `push` only, explicit branch names, exact workflow paths, approved executor/image choices, runtime/concurrency limits, and a bounded expiry. Give it no repository mutation, merge, organization administration, secret-management or deployment rights. A grant may name several exact workflows, but every admitted run still binds one path and blob. Avoid a generic JSON policy language.

Suggested durable records, with typed columns and foreign keys:

| Record | Required binding |
| --- | --- |
| Automation grant | ID; forge; repository/owner IDs; owner kind; sponsor Golf/native user IDs; revision; revocation epoch; enabled/expiry; event kind; exact selected branches/workflow paths; limit settings; current credential-version ID. |
| Credential version | Grant ID; immutable version; native credential kind/user ID; permitted purpose; random binding; encrypted token; key ID; nonsecret fingerprint; expiry/revocation. |
| Grant event | Grant/version/epoch; action; actor Golf user/session IDs for human edits; timestamp; no secret. |
| Event materialization | Authenticated delivery ID; grant/version; exact after-commit/ref/workflow path; payload/input digest; processing state/lease; outcome and run ID. Unique delivery/grant/path; snapshot grant version in the row, not in the uniqueness namespace. |
| Automatic run authority | Grant ID/version/epoch; exact credential version; originating event ID; explicit `push` origin. Sponsor identity is attribution, not an asserted live session. |

Run schema must enforce mutually exclusive manual and automatic origins. Manual rows retain their required live user/session binding. Automatic rows require the grant/event/credential references and no `session_hash`. Do not assign an arbitrary session to satisfy the old NOT NULL constraint. Keep a stable sponsor/audit subject separately if the existing `user_id` is retained; authorization must branch on the origin, never on whether this field happens to be populated.

Explicitly qualify which supported native Gitea credential/scopes can read exact commits/configuration/archives and observe the sponsor's repository permission. Prefer a dedicated native account supplied by the operator for shared automation, with only the needed repository access. A personal owner may explicitly delegate their own supported native token; show that this is a durable delegation independent of browser logout. Neither mode creates a native account or grants native permissions automatically. No global-admin token fallback, impersonation, token extraction from existing browser rows, or use of the local-account sign-in token as an implicit grant.

Admission requires the sponsor/native credential to retain the qualified repository authority for the grant, and the repository to retain its immutable owner binding, nonarchived/nonmirror status and owner kind. Reject missing/ambiguous native observations. An independent native permission edit can race a Golf transaction; document this bounded race, recheck before dispatch and at heartbeats, and never claim cross-provider atomic authorization.

Local account disabling must explicitly revoke grants sponsored by that disabled local identity if that is the configured governance contract. Ordinary logout or own password change continues to revoke session-bound manual runs/delegations; it must not silently revoke or preserve automation grants by accident. Settings must describe the separate grant lifecycle and expose explicit revoke/expiry. Native credential revocation still disables work regardless of a healthy Golf grant.

### Credential storage and locking

Add a distinct `automation_repository` keyring domain. Bind AEAD associated data to the grant, credential version, canonical forge and native user identity using an unambiguous encoded binding digest. Pin a run to an exact credential version; replacing a token increments grant revision/epoch and cannot silently retarget queued or running attempts. Old versions remain auditable and cannot become a fallback. Rotation changes encryption keys, not logical credential versions or run authority.

Extend key status/counting, bounded `SKIP LOCKED` rotation, key-retirement refusal, operator audit, backup manifests and fresh restore checks. Deleting the only reference from a key count while retaining encrypted credential history would make retirement unsafe. Never store plaintext secrets in event payloads, ordinary status/log output, worker assignments or object archives.

Resolve native identity/permissions and prepare source outside SQL locks. Inside a transaction, use a single documented order compatible with existing lifecycle operations: sponsor Golf user, grant, credential version, required scope policies in fixed order, materialization/run. Check enabled/expiry/revocation/current credential and immutable identities again before commit using the database clock. The disable/revoke path uses the same order. No native network request, KDF, Git operation or model call while holding these locks.

## From authenticated push to execution

1. Native webhook ingress authenticates raw bounded bytes, supported event type and configured immutable forge/repository binding before persisting anything. Use documented Gitea headers/signatures for the pinned native version; account for delivery redelivery. Do not accept a payload-selected forge URL, download URL, runner label or callback destination. [Gitea webhook documentation](https://docs.gitea.com/usage/repository/webhooks/).
2. Durable delivery deduplication verifies that a repeated delivery ID has the same bound body digest. A conflicting reused ID is rejected/audited. Headers that are not covered by the native body signature cannot establish a cryptographic replay identity by themselves; bound repeated-body handling and record that limitation. Return an acknowledgment only after commit. Keep unauthenticated request bodies and credential-bearing headers out of logs.
3. A PostgreSQL-backed materializer leases pending deliveries. It resolves registered grants, exact event branch and commit through supported native APIs. Only deliveries after the explicit grant activation cutoff are eligible; enabling a grant never silently drains historical events. Treat webhook pusher/author names as descriptive data, never as the execution principal.
4. First supported trigger: a nondeleted push to an exact allowlisted `refs/heads/<branch>`, with a canonical complete after-commit ID. Skip deletion/zero-after and tags explicitly. Resolve exactly that commit, not the branch's latest tip. Verify commit/config/archive bindings even if a later push moves the ref.
5. Every required ceiling permits `push`: instance + repository for personal repositories; instance + organization + repository for organization-owned repositories. Missing scope denies. Repository/organization settings cannot expand an instance ceiling. Preserve selected immutable repository/owner IDs and exact workflow paths. Add push separately to policy wire/SQL/audit/UI and include it in revision/epoch changes.
6. Initial Actions syntax can admit `on: push` and one explicitly documented exact-branch form; no paths/globs/expressions/PRs/schedules until implemented and tested. Do not reinterpret `workflow_dispatch` as a native push trigger. Initial GitLab behavior must state Golf's supported push/script mapping; do not pretend to evaluate unsupported `rules`, `only/except`, includes or workflow expressions. Extend the inspector and compiler together.
7. Snapshot event/grant/configuration/commit/blob/compiled plan/image/source hash/storage version/policy epochs. Create the run and mark materialization outcome atomically. Uniqueness prevents a crash between enqueue and intake acknowledgment from adding a second run. Changing a grant version cannot create a second execution for an already materialized delivery/grant/path; explicit human replay is a separately audited request, never a new inferred version namespace. Authenticated duplicate ingestion is not a second dispatch.
8. Poll admission, each heartbeat, source download and result acceptance check automatic grant/credential/policy fences, using the shared attempt lease and immutable run binding. Native denial rejects queued work or cancels current work; temporary provider failure blocks progress without converting it into success.
9. Reuse the current Docker shell execution unchanged. Policy/grant revocation fences results, revokes capabilities and requests cancellation; worker observation/cleanup is bounded, not instantaneous physical termination. Worker host loss can leave an orphan. Expired/lost attempts never automatically rerun commands.

The initial intake signing secret is operator process configuration, not a durable globally active secret epoch. Rotate by coordinated replacement/draining of all processes that hold the old configuration, including in-flight request handling; removing a connection from one replica does not disable it in another. A mixed old/new deployment can accept either configured secret until the old processes stop. Binding rows remain immutable history, not active secret/revocation state. Automatic dispatch must still perform its independent current durable grant/policy checks. A future UI-managed webhook-secret lifecycle requires an explicit durable active-config/version fence; this intake slice does not provide immediate cluster-wide secret revocation.

The materializer may safely retry read-only native/source preparation within a bound before a run is leased, with pinned input and backoff. It may not automatically retry an executed/lost attempt or repeat external effects. Corrupt source, denied policy and unsupported configuration need distinct durable blocked outcomes. Bound pending deliveries, per-repository workflow fan-out, bytes, concurrent preparations/runs and retention. A malicious authorized push must not create an unbounded queue. First implement fixed limits; fairness/autoscaling is a later explicit gate.

Current status/list/log APIs continue to authorize fresh human repository access. Automatic runs are not private to the sponsor's browser session. Run cancellation requires current repository write/admin authority and an actor event; grant creation/revocation requires repository admin authority. Global execution disable is an instance administrator action, not a general native repository impersonation right.

## Real local coding-agent execution

A browser must not launch or discover arbitrary local binaries, scrape auth files, expose an unauthenticated localhost service, or require a fake Golf browser login for a daemon. Add a separate trusted local connector process to the existing outbound runner model. Start with an explicit operator command and one harness. Use a one-time, short-lived enrollment capability approved by the owner; exchange it for a revocable connector identity bound to Golf origin, owner, pool/trust class and allowed harnesses. Current static runner enrollment can be reused for a narrow operator-managed prototype, but does not satisfy the planned personal enrollment/rotation lifecycle by itself.

Store connector and harness credentials in the owner's private OS/user store. Only redacted capability/version/auth-method observations reach Golf. Browser registration requires current account consent; subsequent daemon transport uses its own credential and attempt capability. A connector is capacity, not implicit access to every repository or arbitrary host commands. Do not share one owner's home/authentication directory with another tenant or job.

### Adapter-first task contract

Define a versioned concrete `golf.agent.task.v1` assignment, initially implemented by one process adapter. Do not create a broad plugin framework, new message broker or universal ACP requirement.

| Input | Contract |
| --- | --- |
| Identity | Task/run/attempt IDs, lease epoch, authority origin and immutable repository/owner IDs. |
| Code | Exact base commit, source checksum; workspace mode `snapshot` or explicitly qualified `git`; no caller-selected host path. |
| Task | Bounded instruction and acceptance criteria snapshot; classified repository data, never executable trusted control instructions. |
| Harness | Exact adapter name/version, approved binary/image identity, selected supported model/provider and auth mode, immutable credential reference/fingerprint. |
| Permissions | Read/edit task workspace; exact allowed tool/test policy; provider/dependency network profile; no merge/deploy/policy grants. |
| Limits | Deadline, process/output/disk/memory limits, concurrency reservation and bounded spend/usage policy. |
| Completion | Proposal-only: summary, changed-file inventory/patch, explicit check evidence and unresolved failures. No automatic protected-branch writes. |

Normalized adapter events contain attempt ID, monotonic sequence, type (`started`, text/tool observation, permission request/denial, usage, evidence, terminal), and bounded sanitized fields. Keep raw provider protocol private and bounded. A permission request is not permission; unattended behavior denies unsupported requests or suspends through an explicit approval contract. Exit 0 or a model's final prose cannot certify repository checks. Final outcome distinguishes proposal produced, independent checks passed/failed, cancelled, provider/auth denied and unknown/lost.

Each concrete adapter implements start, consume structured events, status, cancel and collect evidence. Spawn a fixed trusted executable with argument arrays, validated configuration and stdin task input. Never interpolate task/prompt/model into a host shell. Process startup, unsupported protocol/version, expired credentials, refusal and malformed/truncated output fail visibly. Persist task/attempt metadata and normalized events; on crash do not resend the prompt unless an explicitly qualified resume contract proves the same native session/attempt semantics.

### Five harnesses and auth qualification

The following interfaces are candidate documented integration paths, not runnable Golf support. Exact flags and terminal/event semantics must be tested against the pinned installed version before enabling an adapter.

| Harness | Initial path | Required qualification |
| --- | --- | --- |
| Claude Code | Headless `claude -p` with structured JSON/stream output. | Pin permission/config discovery. Native `--bare` avoids automatic workspace/user hooks but uses explicit supported credentials rather than subscription keychain login; account and API modes need separate eligibility and isolation proofs. Never silently choose skip-permission flags. [Official headless documentation](https://code.claude.com/docs/en/headless). |
| Codex | `codex exec --json`; consider app-server only when interactive approval/session control needs it. | Parse turn failure/terminal events as well as process exit. Isolate saved ChatGPT authentication versus API billing; permitted automation credentials are their own supported mode. Do not expose a model key to repository-controlled test processes. [Noninteractive execution](https://learn.chatgpt.com/docs/non-interactive-mode), [authentication](https://learn.chatgpt.com/docs/auth). |
| OpenCode | `opencode run --format json`; SDK/server or ACP later if necessary. | Pin provider/model, permission configuration, plugin discovery and session ownership. If a server is used, explicit authentication and private binding are required; no public attach URL from repository data. [Official CLI](https://opencode.ai/docs/cli/). |
| Grok Build | Documented headless path or `grok agent stdio` ACP. | Qualify its actual structured event format, permission prompts, cancellation and native login/device/API modes against the installed release. Do not assume Claude-compatible flags. [Headless scripting](https://docs.x.ai/build/cli/headless-scripting), [CLI reference](https://docs.x.ai/build/cli/reference). |
| Pi | Pinned `pi --mode rpc --no-session`, or its supported SDK. | Correlate command IDs; prompt acknowledgment is not completion. For the current upstream protocol, `agent_settled` differs from `agent_end`; validate the pinned release's lifecycle and abort protocol. Isolate auth/extensions/session state. [Upstream RPC documentation](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/rpc.md). |

Read-only PATH/version probes on 2026-10-02 found Claude Code 2.1.287, Codex CLI 0.159.3, OpenCode 2.0.16 and Grok 1.0.41; Pi was not on PATH. No credential files were opened, account/login status queried, model invocation made, or Golf adapter proved by these observations. Keep capability states distinct: installed, compatible protocol detected, auth configured, authorized for this task, runtime qualified. A UI tile may not report “ready” from `command -v` alone.

Golf account login, harness-native account login, model API credentials and repository/infrastructure authority remain four separate domains. OAuth/device flows run through the harness's supported native flow or a specifically qualified registered integration; Golf does not collect passwords or turn a subscription token into a general API key. Token refresh is owner/version bound, never silently shared. Test personal owner-controlled login and managed API use independently. Unsupported provider/auth/harness combinations are blocked without disabling Git or unrelated adapters.

### Workspace, network and credential boundary

Start with isolated snapshot edits and patch evidence if the task needs no Git history. Real Git operations require an independent task-owned clone/volume fetched by a trusted broker at an exact authorized commit. Do not mount Gitea repository files or a shared canonical `.git` directory. Strip credential-bearing remote URLs/config, deny uncontrolled Git config/include paths/hooks/credential helpers, and initially reject submodules and LFS unless separately authorized. Preserve Git object format and commit validation; don't promise full-history functionality from the current tar snapshot. Same-repository worktrees are an optional trusted performance optimization, not isolation. [Git worktree documentation](https://git-scm.com/docs/git-worktree).

Provider network is necessary for most model modes; current `--network=none` is an intentional blocker. Add a dedicated agent profile with a qualified egress proxy/allowlist and fixed broker/provider endpoints. Dependency network is a separate policy, not implied by model access. Reject redirects to unauthorized destinations and block metadata/private control-plane addresses except explicitly intended services. A Docker network alone is not a domain allowlist.

Repository code can execute tools and read its own process environment. A private HOME or per-invocation environment key prevents cross-user leakage but does not protect a key from hostile code running in that same boundary. Prefer a trusted external provider broker with attempt-scoped proxy access, exact model/provider/budget binding, and no raw upstream key available to the code/tool subprocesses. Such scoped access can still be abused within its allowed model budget; enforce limits at the broker. Where native account auth cannot be brokered safely, restrict the first integration to explicitly trusted owner-controlled workspaces and describe that boundary, rather than claiming a hostile-tenant sandbox.

Inference credentials and forge credentials are separate pinned references. Initial jobs have no write token. To publish a later PR/MR, a trusted broker must reauthorize current grant/native permission, validate the output/base commit and branch namespace, and journal the external effect with readback/unknown-outcome behavior. Add branch/PR writes only in that later slice; no token-bearing Git remote inside the model workspace. Evidence upload/download must be attempt/tenant scoped, content-hashed, size bounded, redacted and authorized before any sharing.

## Delivery phases and required evidence

| Phase | Implementation tasks | Acceptance proof |
| --- | --- | --- |
| A: intake only | Native HMAC route, immutable repository registration, durable delivery/digest uniqueness, bounded event inspection/status. | Real supported native push and redelivery, invalid signatures/header/body/bindings denied, restart preserves event, no run/executor/model side effect. |
| B: automatic shell CI | Grant/credential records; key lifecycle; explicit push policy and trigger subset; materializer; automatic run authority; shared runner fences/cancellation; settings explicit enable/revoke. | Disposable native private repository push executes exactly once through existing real Docker executor, exact commit/blob/source; duplicate and restart; archived/transferred/permission-revoked cases; disabled/missing ceiling; grant/policy/credential revocation at queue and heartbeat; stale finish denied; cleanup. |
| C: one real local harness | Owner-bound connector enrollment; concrete task/events; isolated snapshot workspace; trusted provider access; pinned harness/model/auth; cancellation and patch evidence. | Actual authorized model/harness task edits a disposable source fixture; independent check succeeds/fails as intended; auth denial/malformed output/output cap/deadline/cancel; no host/other-user credentials; late result denied; no write to canonical repository. Record billed calls separately. |
| D: remaining four adapters | Add one concrete adapter at a time with its own current native interface/auth tests. | Five individually runnable real harness proofs; Pi installed/pinned explicitly; provider/auth/version matrix published. Unavailable auth is blocked, never replaced with another adapter or canned output. |
| E: full Git/proposals and richer events | Trusted clone broker, check/evidence artifact contract, permissioned journaled PR writes, self-event loop suppression, exact schedules/filters with bounds. | Native branch/PR persistence, protected-branch denial, permission revoked between proposal/publish, acknowledgment loss no duplicate write, agent-trigger loop bounded, source/evidence/credential restore proof. |

Before B, extend migration/recovery compatibility and encrypted-credential restoration tests; don't inherit schema016 recovery qualification for a new authority table. Before C, qualify the actual chosen OS/isolation/egress/credential topology. None of these phases certifies GitHub-hosted/GitLab Runner parity, hostile shared tenancy, enterprise load/fairness, production CD or all provider terms.

CLI/MCP/API/ACP can inspect and manage the same authorized domain records as their scopes permit. Existing read-only session-delegated API credentials stay read-only; an automatic principal is not a reason to widen their allowlist. Write-capable machine access requires its own explicit scoped credential contract and evidence.

## Portable and Cloudflare tracks

PostgreSQL remains authoritative for event deduplication, grants, epochs, materialization, leases and audit. Docker Compose needs no Cloudflare, Valkey, external queue or model for phases A/B. Kubernetes execution can follow through a separately qualified Jobs adapter; do not label the Docker worker a Kubernetes executor merely because its control process runs in a pod.

Cloudflare is an optional executor/provider/storage track using the same origin, grants and attempt semantics. R2 can hold the existing pinned source/evidence objects after actual compatibility qualification; Workers/Queues may authenticate and deliver events only through a bound transport that preserves core deduplication and authority; Sandbox/Containers may implement a qualified executor. Workers AI or AI Gateway can be a configured provider route only for a supported harness/protocol and tested auth path. No automatic fallback across provider, region or data-trust boundary. Edge acknowledgment alone cannot claim a committed Golf run. Cloudflare services must add a useful, qualified capability, not make the portable principal depend on edge infrastructure.
