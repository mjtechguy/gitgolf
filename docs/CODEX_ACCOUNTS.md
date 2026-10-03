# Codex accounts in Golf

Open **Account settings → Coding agents** (`/account/agents`). Choose **Connect Codex**, then ChatGPT account or OpenAI API key. ChatGPT device login displays the official browser link, a temporary code, and Golf’s 15-minute completion deadline. This is a Golf acceptance deadline, not a provider-reported token expiry. Approve with your own account and return to Golf; the open page checks for completion. No operator terminal login or host Codex credential import is required.

The inventory shows provider-reported email/plan when available, authentication method, last check, and connection/reconnect state. API-key accounts do not report an email or ChatGPT plan. **Check provider status** requests native token refresh; **Reconnect Codex** starts a new explicit login. **Disconnect** requires confirmation and removes the Golf-owned cache; it does not revoke a provider account or API key. Provider-managed refresh does not expose a reliable token-expiry countdown. Authentication, API-key acceptance, model entitlement, and successful task execution are separate evidence.

## Plan, quota windows and resets

For a connected account, choose **Refresh plan and usage**. Golf refreshes the native account and reads `account/rateLimits/read` through the same serialized, version-fenced connection owner. It shows the provider-reported plan, remaining/used percentages, actual quota-window duration, absolute reset time and a local countdown, plus the banked earned-reset count when reported. Multiple metered buckets and primary/secondary windows are separate. Missing values remain “Not reported”; known zero resets are shown as zero. Reading does not redeem a reset or run inference.

Usage is a private in-page provider snapshot, cleared on disconnect, reconnect, page hide or access loss. Reload or refresh explicitly to obtain a new snapshot; the countdown does not infer that the quota has actually renewed. Unsupported/error quota reads leave account authentication separate from quota availability. API-key connections do not expose ChatGPT plan quotas. Managers inspect instance-account usage in its authentication details; permitted users retain the existing metadata-only projection. Credential snapshots after the provider wait use the same current session, role and version checks as connection refresh.

## Instance-managed accounts and access

Open **Admin portal → Coding agents** (`/admin/agents`) to add named instance connections. Each connection has its own authentication state and encrypted cache. Use **Edit access** to choose enabled Golf users by immutable identity. New connections allow no users; management authority does not automatically grant use. Administrators may explicitly select themselves.

Personal connections remain private under account settings. A user also sees safe account metadata for instance connections explicitly assigned to them. Permission to use a connection is separate from permission to manage it: selected users cannot read its device challenge, credentials, access list, or initiate reconnect, refresh, cancellation or disconnect. Only currently operator-enrolled local-password Golf administrators can manage instance accounts; native forge administrator status, API tokens and delegated credentials confer no such authority. Disabled users cannot use their former grants, and changes are version fenced with current session/role rechecks.

Golf access controls do not expand provider licensing, account seats, plan limits or model entitlements. Managed task execution is still a separate implementation step; an allowed account is not evidence of a working task executor.

## Implementation boundary

The packaged backend contains pinned native Codex CLI **0.160.0** and starts only its account app-server protocol. This is a trusted authentication broker, separate from the untrusted task executor: Golf exposes no arbitrary native RPC proxy or model/task methods through this connection service. An operator can disable the packaged broker with an empty `GOLF_CODEX_BINARY`; host development requires an explicit trusted absolute executable path.

Each Golf user has one personal, versioned connection, alongside separately named instance connections. Browser password/OAuth sessions manage their own personal connection; instance connections use the administrator boundary above; bootstrap forge tokens and delegated API credentials are denied. Writes use the existing Origin protections, optimistic version checks, and current account/session authority checks after provider waits. The frontend clears sensitive editor/challenge state after access denial, logout, or page hide, and inspects unknown outcomes before another change.

Native credentials exist in a private temporary `CODEX_HOME` while the broker owns the connection. The owned regular auth file is bounded and private; serialized snapshots are encrypted in PostgreSQL under Golf's existing keyring with a distinct connection binding. Key usage, rotation, startup checks, and retirement include those blobs; their counts are aggregated under the existing infrastructure-connections credential family. No host cache, Docker socket, administrator forge credential, repository, or task workspace is mounted into the broker. A native account cache can survive backend restart through encrypted restoration; unfinished device authorization requires a fresh login after its owner is lost.

Broker ownership is keyed by connection UUID, rather than user, and uses a held PostgreSQL session advisory lock, bounded process count/lifetime, serialized native operations, and cleanup on shutdown. Database-connection failure handling must stop the local broker; partition/failover behavior across replicas remains a separate qualification. These managed account flows do not establish enterprise-scale distributed OAuth ownership or successful agent execution.

## Qualification and recovery

Run `make check helm-check`, the Codex browser tests, and PostgreSQL account/key lifecycle tests. The opt-in native check uses `GOLF_TEST_CODEX_BINARY` with `TestPinnedNativeAccount`: isolated home, exact CLI version, deliberately invalid API-key cache, private snapshot/restore, logout, and real device issue/cancel, without inference or host account access.

Schema **202610020022** adds managed Codex state; **202610020023** adds instance ownership, names and explicit user access while retaining existing personal state. The previously qualified schema021 canonical recovery archive is not qualification for this schema; the recovery tool must continue to refuse unsupported schemas until a new full restore drill includes managed account state. Protect development databases and key material; do not claim production recovery completion from an account restart test.

The [local operator task runtime](CODEX_LOCAL_RUNTIME.md) is a separate execution experiment. Managed task admission, execution/publishing, agent triggers, additional harnesses, amd64/Kubernetes/Cloudflare qualification, provider-approved successful login, and paid model execution require their own evidence.

Sources: [official app-server account protocol](https://learn.chatgpt.com/docs/app-server), [Codex authentication](https://learn.chatgpt.com/docs/auth).

## Connection inventory and details

Inventory rows use Lucide icon actions with accessible names and hover titles. Details open in a bounded, keyboard-dismissable modal with focus returned to its launcher; provider plan and usage are shown there rather than expanding the inventory. Personal connections support an explicit Rename editor after initial connection; renaming preserves connection identity and encrypted login state and cannot grant shared access. Complete or cancel pending device approval before renaming. Instance administrators edit names and allowed users through the existing explicit editor and manage authentication separately. Disconnect remains a confirmation. Users granted shared use see safe metadata details only.

`SetCodexConnectionAccess` also accepts owner-only personal renaming with an empty allowed-user list. Every update uses expected-version checks, current session/management authority and the existing audited connection-configuration transaction; unknown results require inspection rather than resubmission.
