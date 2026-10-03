# Agent usage defaults, model discovery and task preview

This is saved configuration and a read-only policy preview. The managed coding-task executor is not implemented. Saving a push/comment trigger does not enqueue a task or spend provider credits. Existing shell CI policies and execution remain separate.

## Configuration surfaces

- Personal: Account settings → Coding agents (`/account/agents`). Own personal or explicitly permitted instance account defaults.
- Instance: Admin portal → Coding agents (`/admin/agents`). Current enrolled local-password administrators manage installation-wide ceilings and optional instance-account defaults.
- Organization: organization settings. Current native organization owners manage ceilings and optional instance-account defaults.
- Repository: repository workflow settings. Current owner/direct administrator/organization owner authority is required; global Golf administration does not override native repository permissions.

Each surface leads with a shared searchable/sortable table. The pencil opens a TanStack Form editor; the flask previews task choices. Read-only detail modals remain separate from settings edits. Initial policy is disabled, with no models/triggers allowed and no task overrides. Account authentication alone cannot enable it.

Settings include enabled policy, account/model default, supported reasoning/variant, instructions, allowed trigger set, all-supported/exact-model allowlist, maximum task runtime, token cap, API-spend cap in USD cents, concurrency cap and explicit permission for per-task choices. Empty account/model means inherit a higher default. Instance/organization/repository saved defaults can select only explicitly use-permitted instance accounts; personal defaults can select own personal accounts. A task preview can select a currently permitted personal account as well; this does not sponsor automatic runs.

## Model discovery

`AgentUsageService.ListAgentModels` accepts an authorized connection UUID and explicit refresh flag. Only connected accounts with current use access are eligible. Authentication managers perform native discovery under the connection's existing account owner/serialization. Use-only shared users read the sanitized version-bound catalog; if it is absent/stale they ask an authentication manager to refresh. Management never implies use permission.

- Codex: native `model/list` with bounded pagination, preserving returned model IDs and supported reasoning effort order.
- OpenCode: native `models <provider> --verbose` in that connection's isolated HOME. Golf extracts only bounded model ID/name and enabled variant names, ignoring runtime URLs, headers, options and raw output. Go uses native provider ID `opencode-go`, separately from Zen (`opencode`), Anthropic and OpenAI. Its credential is the API key obtained after signing into the OpenCode console/subscribing; Golf does not implement a separate Go OAuth flow.
- Claude Code: documented `default`, `sonnet`, `opus`, `haiku` aliases, explicitly marked as documented support rather than account-entitlement discovery. Sonnet/Opus effort choices are documented candidates; exact model/effort support must be verified by the future native executor. No universal unsupported reasoning option is supplied for Haiku.

Every result has `access_verified=false`. Catalog visibility is not a successful model request, subscription validity, model seat or licensing promise. A future executor must verify the exact selected model, effort, account and native/provider restrictions before inference. No silent fallback or switch to API billing is permitted.

Native credential refresh writes are preserved through the existing encrypted cache lifecycle. Sanitized catalogs are stored against connection UUID/version; changing account state invalidates old catalogs. A save validates the selected model/variant and atomically checks the current connected/use-permitted account and version-bound catalog. No host auth, arbitrary command/argument, plugin or base URL is accepted.

## Scope resolution and task overrides

Repository configuration resolves the nearest default (repository, then organization if owned by one, then instance). Personal configuration resolves its own default then instance. Explicit higher-scope instructions are prepended and retained. All required model allowlists and enabled ceilings must permit the chosen model; missing higher configuration denies use. Trigger sets intersect. Runtime, token, spend and concurrency limits take the minimum, including a known zero spend cap. Per-task overrides require permission at every required scope. A lower configuration cannot increase a higher ceiling.

`PreviewAgentTask` supports an explicit connected account/model/variant, appended task instructions, trigger and optional bounded budget values. It validates catalog support and current use access and returns resolved limits/denial reasons. Unsupported models/variants and unknown triggers fail. A denied trigger remains denied. A requested larger budget is clamped by each scope. Preview leaves saved configuration/revision unchanged, queues no work, runs no model and always reports execution unavailable. It is advisory inspection, not atomic execution admission or authorization evidence.

Limits currently describe per-task policy. They do not yet implement aggregate spend accounting, concurrent task admission, cancellation, automatic trigger assignment, comment command parsing, tool/egress policy, execution pools, proposal publication or protected merge. Those belong to the managed executor and must consume current ceilings, account grants and native repository authority at admission and during execution. Personal preference is not an automation credential grant. The initial native-authorization read/save pattern has bounded external permission preflight races; it is not native atomic CAS.

## Persistence, API and recovery

Schema025 adds immutable harness/provider support for Go, scope-keyed JSON settings, optimistic revisions, metadata-only actor events and sanitized version-bound model catalogs. Settings scope/owner are derived from current Golf/native authority and checked against supplied original scope/revision/authority fingerprint. Personal state is caller-scoped, shared settings are restricted to current managers and native owners/admins, and browser-only cookie/Origin controls apply. Revoked/disabled sessions fail current transaction guards. Secrets are kept out of usage settings/events; instructions are plain authenticated configuration, so never put credentials there.

Generated Connect methods are `GetAgentUsage`, `SaveAgentUsage`, `ListAgentModels` and `PreviewAgentTask`. They are excluded from existing delegated read-only CLI/MCP allowlists. uint64-style identity/revision strings remain strings. Mutations bind the original observation; an unconfirmed save requires inspection, with no automatic retry. Page hide/sign-out/access loss clear drafts, cached models and private configuration.

Schema025 is outside the qualified canonical recovery allowlist. A native cache restart check is not a whole-stack restore drill. Preserve PostgreSQL/keyring state; full expanded recovery remains a separate gate.

Sources: [Codex model discovery](https://learn.chatgpt.com/docs/app-server#list-models-modellist), [OpenCode Go](https://opencode.ai/docs/go/), [OpenCode models/variants](https://opencode.ai/docs/models/), [Claude model configuration](https://code.claude.com/docs/en/model-config).
