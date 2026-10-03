# Managed manual coding tasks

Golf can run a manual Codex ChatGPT task in a disposable Docker workspace and retain its final summary and proposed patch. This is the first managed execution path, separate from shell CI and from account authentication. It does not push, commit to the source repository, open a pull request, merge or deploy.

## Local setup and use

Run `make local-agents-up` after local Compose setup. This builds the pinned Codex0.160.0 task image, loads its exact SHA256 identity into Golf's dedicated Docker daemon, writes private `.env.agents` and starts the trusted agent worker. Later `make local-up`, `local-stop` and `local-status` include this optional profile when that file exists. The worker refuses availability until a native sandbox check passes. No host Docker socket or host agent login is mounted into a task.

1. Connect a personal Codex ChatGPT account in **Account settings → Coding agents**, or obtain explicit use permission for an instance connection. Refresh its native model catalog.
2. Enable manual usage and the exact selected model at the instance, personal, repository and applicable organization scopes. Defaults are disabled. Set bounded runtime, reported-token threshold and concurrency. Per-task account/model choices require overrides permitted at every required scope.
3. Open **Repository → Settings → Workflows → Coding tasks**. Use **New coding task**, choose the current connected account/model/effort and source branch or full commit, and describe the requested edits in the private workspace.
4. Inspect the queued/running/terminal state, final summary and proposed patch. Cancellation requires confirmation. Applying or publishing the patch is a separate human operation.

Status reports worker availability separately from account connection and policy eligibility. A ready worker does not guarantee provider entitlement or a successful model request. No silent model or API-billing fallback is allowed. Claude/OpenCode connections and catalogs remain available, but their managed task executors are not implemented.

## Admission and lifecycle

`AgentTaskService` provides browser-cookie/Origin-protected Create/List/Get/Cancel methods; existing delegated CLI/MCP credentials cannot call them. Tasks are private to their initiating user and require current native repository owner/direct-admin/organization-owner authority. Golf instance administration does not override repository authority.

Admission binds the observed native repository authority, current connected/use-permitted account UUID/version, selected native catalog model/effort and every effective policy ceiling. It captures a supported native archive at the immutable commit, reconstructs ordinary files and rejects links, submodules, unsafe paths and oversized archives. Source is capped at16MiB/4096 entries and stored in PostgreSQL for this initial path. RustFS/R2 task snapshot storage is not yet implemented.

A unique user/request key records a durable receipt. Repeating the exact request returns that receipt after current read authorization; changing its input conflicts. A lost response does not trigger automatic browser retry. Only a live qualified exact-image worker admits new tasks. Workers acquire exclusive PostgreSQL worker and account ownership, lease each unique attempt, and recheck session, native authority, account/grants and policy during execution and before retaining results. A policy revision conservatively cancels a running attempt even if the edit seems harmless.

Worker loss or expired leases are terminal `lost` outcomes with no automatic replay. Native work may already have consumed subscription quota. Cancellation stops on the next worker observation, not atomically at the UI click. Logging out the initiating session also revokes that task. Private source preparation and cleanup failures fail closed. Worker startup cleans only its exact labeled resources after exclusive enrollment ownership.

The first worker runs one task at a time. Exclusive account ownership serializes rotating credentials. Multiple workers/accounts can run concurrently, under a conservative installation-wide minimum concurrency ceiling. This is not a scalable fair scheduler or complete per-scope aggregate accounting; an occupied oldest account can delay later queued accounts.

## Isolation and credentials

The trusted worker owns database/keyring access; task containers receive only normalized source and the selected native credential cache. Native credentials stream over Docker stdin into a0600 private tmpfs, never task arguments, environment, artifacts or browser receipts. No forge credential, object-store credential, database credential or host configuration enters the task. The returned cache is encrypted back only to the original still-current account; it cannot replace a newer login or resurrect a revoked connection.

Containers use a pinned local image, non-root UID, read-only root, dropped capabilities, no-new-privileges, qualified seccomp, resource limits and private workspace/auth/tmp tmpfs. Native command permissions deny credential/root/source writes, credential reads and command network access, while allowing workspace changes. Repository `.codex` configuration is removed; the synthetic `.git` baseline is read-only to native commands, hooks are disabled, and web search/apps/plugins are disabled. Only trusted harness provider traffic has network access; a provider egress firewall is not implemented. This is a qualified local trusted-harness boundary, not a hostile multi-tenant VM isolation claim.

Only bounded final assistant text and a trusted Git diff enter the result; command logs, reasoning, provider errors and raw native protocol events are discarded. Summary and patch are capped at64KiB each. Fixed-stage diagnostic labels contain no native output. Results are rejected if they accidentally echo retained credentials; that guard supplements the tested read-denial boundary.

## Budgets and remaining work

Only Codex ChatGPT device-auth connections execute. API-billed connections are blocked, including fallback. Runtime is bounded by the effective policy and the initial15-minute qualified ceiling. Token usage interrupts at the next native report above the configured threshold: a provider request can already have exceeded it. This is not a prepaid hard billing cap. Aggregate subscription quotas, prepaid resets and aggregate dollar accounting are separate provider/qualification work.

Automatic push/PR-comment tasks, Claude/OpenCode/Grok/Pi executors, API-billed tasks, delegated API/MCP/ACP task dispatch, streaming logs, fair scheduling, crash-safe mid-turn credential checkpoints, resume, proposal publication, Kubernetes/Cloudflare executors and schema026 canonical recovery remain open. Disconnecting or refreshing an account can be unavailable while its worker owns it; cancel the task and wait for the worker to stop before managing that account. Canonical recovery remains refused above the existing qualified schema021 allowlist.

Protocol sources: [Codex app server](https://learn.chatgpt.com/docs/app-server), [native permissions](https://learn.chatgpt.com/docs/permissions). The actual0.160.0 flat absolute-path permission configuration is qualified locally; newer documentation examples must not replace it without rerunning native isolation checks.
