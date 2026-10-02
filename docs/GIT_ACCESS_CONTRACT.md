# Git access in the local developer preview

Golf provides an own-account SSH key page at `/account/ssh-keys`, available through **Your account → User settings → SSH keys**. Choose **New SSH key** to open its editor; Cancel clears the draft. Key inventories use the shared compact TanStack Table, with search/sort of loaded rows, and the editor uses TanStack Form with global styles. Git repositories and transports remain native backend operations. This increment does not implement a Golf HTTP credential gateway, protected merge enforcement or scoped agent Git credentials.

## Public API and authority

The generated `golf.v1.GitAccessService` offers `ListSSHKeys`, `AddSSHKey` and `DeleteSSHKey`. All require a live browser session and the existing exact-origin/no-store boundary. Read-only Golf API credentials cannot invoke any of these procedures; CLI/MCP tools remain unchanged. The server uses the caller's encrypted provider credential and the supported `/user/keys` API. It never uses administrator impersonation or direct database/ref writes.

Listing requires native `read:user`; adding/deleting requires `write:user`. Responses must bind to the caller's immutable native user ID. Deletion first checks that the returned key belongs to that user, requires HTTP 204, then confirms native absence. A public key readable through the native API is not proof of ownership. IDs stay decimal strings through the browser and API; clients must not convert them to JavaScript numbers.

Added titles are trimmed nonempty UTF-8, up to 64 bytes, without control characters. Public keys are one OpenSSH authentication key, up to 8192 bytes. The existing SSH parser validates the binary key, discards comments and computes its SHA256 fingerprint. Authorized-key options, multiple lines/keys, certificates, private keys, DSA and RSA below 2048 bits are rejected. Ed25519, ECDSA, supported security keys and RSA are accepted by the input boundary; the native backend may impose further restrictions. The real transport qualification uses Ed25519; other algorithms are not transport-qualified by this increment.

Account keys use the native account's effective repository permissions. They are persistent, broad account credentials: they survive Golf logout, source-session expiry, password reset and local-only account disable. Removing a key denies new SSH connections; it does not promise cancellation of already accepted connections. Unified native/Golf suspension, MFA/step-up, key-use audit, short-lived/repository-scoped agent credentials and concurrent revocation fencing remain release gates.

Do not offer a read-only account-key selector. The pinned 1.27.3 API advertises `read_only`, but a disposable native proof on 2026-10-02 observed POST with `read_only:true` returning a stored user key with `read_only:false`. Golf does not accept that flag in its public add contract. Repository-scoped deploy keys or a managed Git ingress need separate qualification before read-only agent access is claimed. [Native key API](https://docs.gitea.com/api/operations/user-current-post-key/).

Writes are not automatically retried. A connection loss, rejected response or failed postflight can occur after a native mutation. The UI blocks another write until the user refreshes and inspects the current key list. The key service has no durable mutation journal or exactly-once guarantee; list inspection is not an authoritative proof of which concurrent request created an object. Keys remain native recovery inventory.

## Public clone URLs

The bundled Compose/Helm native service sets `PUBLIC_URL_DETECTION=never` and an explicit `ROOT_URL`. This prevents Golf's internal API connection hostname from becoming a user-facing clone/repository link. External backend operators must apply equivalent public-origin configuration; Golf does not rewrite arbitrary URLs. [Native public URL configuration](https://docs.gitea.com/administration/config-cheat-sheet/).

The local HTTP Git origin is `http://localhost:3001`; SSH uses `ssh://git@localhost:2222/OWNER/REPOSITORY.git`. Golf passwords authenticate Golf, not direct native HTTP Git. Add a public SSH key through Golf to use SSH without a separate native password. Native personal tokens are the currently qualified HTTP credential path; Golf's `golf_ro_` API credentials are not Git credentials.

## Repeatable local qualification

With the Compose stack running, Go/Node dependencies installed, and OpenSSH/Git available:

```sh
make qualify-git
```

This creates/purges only disposable users, repositories and keys. It does not restart services or alter retained accounts. Private keys are generated inside a temporary 0700 directory and removed on exit; tokens stay in process memory/environment. The fixture pins the current controlled loopback server host key in its own temporary known-hosts file, uses strict checking, disables SSH-agent/connection reuse and never changes the user's SSH/Git configuration.

The command combines existing Git/API/CLI smoke checks with real SSH clone/fetch/push, private cross-user denial, branch creation/deletion, amended history with successful and stale-rejected force-with-lease, annotated tags, transport of a locally merged history, private HTTP clone/fetch, owner-only removal and new-connection denial after key deletion. The actual served browser checks settings navigation, public/private-key validation, add/reload/mobile, cancel and confirmed removal. Separate browser fixtures cover lost-response/no-retry and permission-failure cleanup.

This is bounded developer-preview evidence. LFS/signature/recovery tests remain in the existing recovery drill; complete fork/PR/review/protected-merge/release workflows, agent execution, Actions/GitLab CI, Cloudflare execution and load qualification remain open. A passed command must never be interpreted as complete GitHub parity.
