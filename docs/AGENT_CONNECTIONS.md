# Managed coding-agent connections

Golf account settings (`/account/agents`) manage personal accounts. Instance administrators create named accounts under `/admin/agents`, select allowed Golf users, and manage authentication separately. All supported harnesses share compact Lucide inventory actions, details dialogs, explicit rename/edit/reconnect flows and confirmed disconnect. Personal identity and shared-use grants are separate from provider accounts and repository/task authority.

| Harness | Packaged version | Current authentication | Account evidence |
| --- | --- | --- | --- |
| Codex | 0.160.0 | Native ChatGPT device login or OpenAI API key | Native account read; provider-reported plan/quota when available |
| Claude Code | 2.1.288 | Native `claude auth login --claudeai`, returned authorization code, or Anthropic API key | Native `claude auth status`; email/plan only when reported. No usage endpoint is invented. |
| OpenCode | 1.18.34 | OpenCode Zen, Go, Anthropic or OpenAI API key, with a distinct connection per provider | Native `opencode auth list` confirms credential-store configuration; no account identity, subscription validity or model access is inferred. |

`opencode auth login --provider opencode` in the pinned CLI prompts for an API key. Go uses its separate `opencode-go` provider and the documented console/API-key setup; the existence of an auth command does not imply browser OAuth. OpenCode provider OAuth, Claude Console/cloud/gateway sign-in and additional providers remain separate qualification steps. Golf never imports a host `~/.claude`, `~/.codex`, OpenCode directory or macOS Keychain. Saving an API key is configuration evidence, not proof that the key works or a paid model request succeeded. Native account status is the CLI's report; it is not a promise that every token has been remotely revalidated or renewed.

## Native authentication and persistence

Claude browser login uses the installed native CLI's PKCE state and local callback/code flow. Only its allowlisted official authorization URL is exposed; a human signs in there and pastes the returned code into Golf. Code input is bounded, secret, cleared after submit, never returned in receipts or stored in the connection row. The exact pending connection, login ID, observed version and current session/owner authority are checked. Native process exit plus a native account read establish completion; a pasted code alone cannot mark success. Cancellation stops and waits for the owned process before cache cleanup. An interrupted owner requires reconnect, with no automatic login replay.

Each connection has an immutable UUID, scope, owner, harness and provider. Schema024 preserves existing Codex UUIDs/encrypted bindings and permits one personal connection per user/harness/provider. Instance names and default-deny Golf user grants retain their existing transaction and audit boundaries. Personal connections cannot be shared or renamed into another harness/provider. Create another connection to select a different provider.

Account-only native commands run with a fresh private HOME, fixed executable/arguments and an environment that excludes host provider credentials. OpenCode receives only the selected provider's native API-key record. Claude snapshots only bounded, private allowlisted credential/account JSON. Serialized state is encrypted in PostgreSQL using the existing connection binding/key lifecycle; temporary homes are removed after their native process stops. Existing connection-scoped advisory ownership, session/role/CAS checks, post-provider persistence and key rotation cover all harnesses. The initial process limit is eight active account brokers and a 15-minute broker lifetime; distributed partition fencing remains unqualified.

The existing `CodexAccountService` RPC name and legacy `CODEX_*` audit identifiers remain compatibility names for this shared account substrate. Additive `harness`/`provider` selectors default to Codex/OpenAI. `CompleteAgentLogin` is a browser-only, Origin-protected native code-completion operation. No arbitrary native RPC proxy, model prompt, shell command, base URL or untrusted plugin configuration is accepted.

## Docker, Kubernetes and Cloudflare boundaries

**Compose account setup runs inside Golf's service container**, which packages all three pinned account CLIs. It does not connect to host-installed agents or receive the Docker socket. Host development requires explicit trusted binary paths: `GOLF_CODEX_BINARY`, `GOLF_CLAUDE_BINARY`, `GOLF_OPENCODE_BINARY`; an empty value disables that adapter. Credentials are runtime data, never image layers.

**Coding tasks are a separate workload.** [Manual Codex ChatGPT tasks](AGENT_TASKS.md) now execute in the portable Docker track. Other harness executors remain unimplemented. The intended Docker execution model is a fresh container/workspace per admitted task; Kubernetes uses task Pods/Jobs, and Cloudflare requires a qualified Sandbox/Containers pool. Workers coordinate and do not execute arbitrary native CLIs. The optional `Dockerfile.codex`, `Dockerfile.claude` and `Dockerfile.opencode` pin native task images with Git and a nonroot user. Packaging alone does not qualify an executor; only the separately tested managed Codex path has task admission/isolation/cancellation evidence. The existing Codex operator experiment remains separately documented in [CODEX_LOCAL_RUNTIME.md](CODEX_LOCAL_RUNTIME.md); it is not generalized by these account connections.

A future executor must serialize native credential ownership through the connection lifecycle, capture provider-owned refresh writes, admit only current repository authority, withhold forge/admin/deployment credentials, enforce resources/egress/tool policy and return a proposal before publication. Do not copy a shared writable rotating cache into several task replicas. Connection sharing does not expand provider seats or licensing. All of this is portable; Cloudflare is an optional execution/model/backend adapter.

Schema024 is **not** covered by the previously qualified canonical recovery archive. Recovery remains refusal-gated until a full restore drill covers the new account state.

## Qualification

Run `make check helm-check`, browser account/capability/audit tests, `go test -race ./internal/codexaccount`, and the real-PostgreSQL Codex/additional-harness tests with a private `GOLF_TEST_DATABASE_URL`. `TestPinnedAdditionalNativeAccounts` accepts explicit `GOLF_TEST_CLAUDE_BINARY`/`GOLF_TEST_OPENCODE_BINARY`; invalid keys prove isolated native cache transport/restoration, without inference. Opt-in `TestPinnedClaudeBrowserIssueCancel` additionally requires `GOLF_TEST_NATIVE_BROWSER=1` and only issues/cancels a real authorization link. Human-approved Claude login, refresh/revocation during actual model use, successful repository tasks and managed execution require separate evidence.

Sources: [Claude CLI reference](https://code.claude.com/docs/en/cli-reference), [Claude authentication](https://code.claude.com/docs/en/authentication), [OpenCode providers](https://opencode.ai/docs/providers/), [OpenCode CLI](https://opencode.ai/docs/cli/), [OpenCode server](https://opencode.ai/docs/server/).

Scoped defaults, model/variant discovery, budgets, trigger ceilings and no-dispatch task preview are specified in [AGENT_USAGE.md](AGENT_USAGE.md).
