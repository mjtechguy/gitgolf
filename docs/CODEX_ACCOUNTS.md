# Personal Codex accounts in Golf

Open **Account settings → Coding agents** (`/account/agents`). Choose **Connect Codex**, then ChatGPT account or OpenAI API key. ChatGPT device login displays the official browser link, a temporary code, and Golf’s 15-minute completion deadline. This is a Golf acceptance deadline, not a provider-reported token expiry. Approve with your own account and return to Golf; the open page checks for completion. No operator terminal login or host Codex credential import is required.

The inventory shows provider-reported email/plan when available, authentication method, last check, and connection/reconnect state. API-key accounts do not report an email or ChatGPT plan. **Check provider status** requests native token refresh; **Reconnect Codex** starts a new explicit login. **Disconnect** requires confirmation and removes the Golf-owned cache; it does not revoke a provider account or API key. Provider-managed refresh does not expose a reliable token-expiry countdown. Authentication, API-key acceptance, model entitlement, and successful task execution are separate evidence.

## Implementation boundary

The packaged backend contains pinned native Codex CLI **0.160.0** and starts only its account app-server protocol. This is a trusted authentication broker, separate from the untrusted task executor: Golf exposes no arbitrary native RPC proxy or model/task methods through this connection service. An operator can disable the packaged broker with an empty `GOLF_CODEX_BINARY`; host development requires an explicit trusted absolute executable path.

Each Golf user has one personal, versioned connection. Browser password/OAuth sessions manage only their own connection; bootstrap forge tokens and delegated API credentials are denied. Writes use the existing Origin protections, optimistic version checks, and current account/session authority checks after provider waits. The frontend clears sensitive editor/challenge state after access denial, logout, or page hide, and inspects unknown outcomes before another change.

Native credentials exist in a private temporary `CODEX_HOME` while the broker owns the connection. The owned regular auth file is bounded and private; serialized snapshots are encrypted in PostgreSQL under Golf's existing keyring with a distinct connection binding. Key usage, rotation, startup checks, and retirement include those blobs; their counts are aggregated under the existing infrastructure-connections credential family. No host cache, Docker socket, administrator forge credential, repository, or task workspace is mounted into the broker. A native account cache can survive backend restart through encrypted restoration; unfinished device authorization requires a fresh login after its owner is lost.

Broker ownership uses a held PostgreSQL session advisory lock, bounded process count/lifetime, serialized native operations, and cleanup on shutdown. Database-connection failure handling must stop the local broker; partition/failover behavior across replicas remains a separate qualification. This initial personal account flow does not establish enterprise-scale distributed OAuth ownership or successful agent execution.

## Qualification and recovery

Run `make check helm-check`, the Codex browser tests, and PostgreSQL account/key lifecycle tests. The opt-in native check uses `GOLF_TEST_CODEX_BINARY` with `TestPinnedNativeAccount`: isolated home, exact CLI version, deliberately invalid API-key cache, private snapshot/restore, logout, and real device issue/cancel, without inference or host account access.

Schema **202610020022** adds managed Codex state. The previously qualified schema021 canonical recovery archive is not qualification for this schema; the recovery tool must continue to refuse unsupported schemas until a new full restore drill includes managed account state. Protect development databases and key material; do not claim production recovery completion from an account restart test.

The [local operator task runtime](CODEX_LOCAL_RUNTIME.md) is a separate execution experiment. Managed task admission, execution/publishing, agent triggers, additional harnesses, amd64/Kubernetes/Cloudflare qualification, provider-approved successful login, and paid model execution require their own evidence.

Sources: [official app-server account protocol](https://learn.chatgpt.com/docs/app-server), [Codex authentication](https://learn.chatgpt.com/docs/auth).
