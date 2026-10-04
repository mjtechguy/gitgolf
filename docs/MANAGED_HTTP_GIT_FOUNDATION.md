# Managed HTTP Git foundation (source packet, migration 051)

This is an opt-in foundation for Golf-issued, repository-scoped Git credentials and supported native smart HTTP transport. The default deployment and existing native Git qualification are separate. It does **not** close P0.8, certify a private native installation, enable protected writes, or make SSH/LFS/merge ready.

## Product contract

The browser-only `GitTransportService` exposes current transport state, own credential inventory, explicit creation/revocation, and metadata-only original receive outcome inspection. Requests carry the current canonical repository key plus exact native repository and owner IDs. Each request intersects current managed session/account and current native code permissions; an API read bearer never becomes a Git credential creation grant. Local password and managed OAuth sessions use the same session boundary.

`golf_git_` secrets contain 32 random bytes and are returned once. Only the full-secret SHA-256 is persisted, along with immutable own user/native actor/repository/owner/source session identity, name, mode, creation/expiry and revocation metadata. Expiry is at most one hour and never exceeds the issuing managed session. Browser secrets live only in component memory, outside query/mutation caches or persistent storage. Git uses username `golf` and the secret as the password in its credential manager; remote URLs never contain credentials or native passwords. Signing out, revoking the parent session, local account disable/password-version invalidation, credential expiry/revocation or loss of native authority deny new requests. An already accepted native operation is not thereby undone.

READ authorizes clone/fetch through only:

- `GET /git/OWNER/REPO.git/info/refs?service=git-upload-pack`
- `POST /git/OWNER/REPO.git/git-upload-pack`

Direct TLS is required. The explicit development exception additionally requires an actually loopback remote address; forwarded headers do not establish TLS. Cookies/Origin are rejected on Git routes. The browser RPCs retain their normal cookie/Origin requirements. Native forwarding sends only server-recovered upstream PAT/OAuth credentials and the classified Git headers, never the Golf capability or cookies. Redirects are refused.

Repository incarnation/owner/name and current native actor/permissions are checked before and after a fully bounded buffered read. Private bytes are withheld until final managed-session checks commit. This is an authorization boundary, not an atomic native read snapshot or revocation of an established TCP connection. Read buffering is at most 128 MiB per accepted operation, four buffered requests per Golf process; replicas have independent budgets. Request timeout is two minutes. Upload request compressed bytes are bounded to 16 MiB; no independent decompressed CPU/memory ceiling is claimed.

## WRITE remains unavailable without qualified enrollment

There is **no enrollment RPC, operator command, supplied JSON validator or environment-checkbox certification in this packet**. The immutable metadata table reserves a place for a reviewed fresh-private-native incarnation, native version, qualification receipt digest, qualifier source SHA, Golf/native image digests and native runtime ID. Merely inserting that row is not evidence of provider queue/process quiescence or production mediation. WRITE must not be enabled on an adopted native installation from those metadata fields alone.

A later operator consumer must admit only a independently qualified fresh profile, bind its actual immutable runtime identities, revalidate/requarantine replacement, and establish that native/public ports, SSH, alternate ingress, native background jobs, hooks, merges, identity and other supported mutation routes cannot bypass the declared scope. This packet's individual repository observations reject mirror/native Actions and require complete empty supported branch protections, tag protections and push-mirror responses. These observations do not independently establish installation-wide absence of native writers. The table/config UUID does not substitute for that proof.

The receive implementation is authored for later controlled qualification, but creation/advertisement/receive require the profile prerequisite. Its production admission is restricted to **one update of an existing ordinary branch**, with nonzero old/new objects. Creation, deletion, tags, multi-ref receive, wiki, AGit/proc-receive, push-options and report-status-v2 are refused. The framing inventory handles up to 32 ordinary commands for strict parsing/testing only; it is not the admitted write scope. Both 40/64 object syntax are recognized; actual SHA-256 native repositories remain unqualified.

## Durable outcome rules

A per-repository receive reservation is committed before native forwarding; `UNKNOWN` is durably committed before any potentially effective request is sent. The bounded command digest binds ordered old/new/ref values and canonical requested protocol semantics, including atomic/object format/reporting. Harmless client `agent` metadata is excluded. Pack/source bytes and credential secrets are never journaled.

The shared lifecycle blocked/active functions include unresolved receives. The application acquires managed user → managed session → capability → exclusive repository lifecycle locks. Existing queued/running Golf writers prevent receive admission; unresolved receive prevents scoped Golf admission/archive and replacement WRITE credential creation. Locks are per repository, with no instance-wide write serialization. Parent identity/team/org and external-native/native-background coverage are explicitly incomplete.

Only a complete native report-status, exactly one result per admitted ref, independent supported exact native ref readback, final current actor/repository/permission/background observations and a committed journal update produce `COMPLETED` plus accepted/rejected counts. Sideband progress is discarded and never treated as authority. Fully rejected native results can be `COMPLETED` with zero accepted; completed does not mean every command succeeded. Source repository activity is emitted only for a committed completed receipt with accepted commands.

Client disconnect, timeout, native error, malformed/incomplete receipt, changed authority, SQL/ack uncertainty or process loss retain `RESERVED`/`UNKNOWN`. There is no expiry, lease takeover, automatic resend, replacement-key adoption, public reset or outcome repair. A known duplicate returns the original operation ID for status-only inspection; completed duplicates are not resent either. The `Golf-Git-Operation` response header is a receipt key when one is known. A client that loses that response cannot invent a safe replacement intent. Future recovery requires supported provider/broker/publisher quiescence and independent inspection, not a wall-clock timeout.

## Source evidence and remaining qualification

Pure strict-route/protocol/report/digest tests, package race tests, TypeScript checks and generated descriptor/schema checks are runnable locally. The six authored PostgreSQL tests cover own scope/logout, late private denial, unavailable WRITE, durable UNKNOWN/new-key/restart exclusion, independent successful receipt and post-dispatch native failure. They use controlled native HTTP fixtures and are **not native qualification**; without a source test DSN they are explicitly skipped. The eight browser fixture cases cover requested forms, one-time secret, unconfirmed creation, confirmation, and late owner/target/sign-out fences; listing/compilation is not a browser PASS.

Before deployment qualification: run those PostgreSQL and browser cases, integrate the isolated service/config/clone/UI mount seams, then use supported disposable ordinary actors and actual Git against a fresh private-native topology. Verify clone/fetch, current authority loss, own/global boundaries, direct TLS/loopback denial, current target replacement, native bypass absence and cleanup. WRITE's separate acceptance additionally needs reviewed enrollment and actual receive/report/ref/outcome proof, response-loss/process restart exclusion and background quiescence. Full protected H/P/A/E/F, cross-resource identities/orgs/forks, SSH, LFS, hooks, multi-ref/tag/create/delete, production edge trust, recovery and complete Git parity remain open.

## Primary implementation references

- [Git smart HTTP protocol](https://git-scm.com/docs/http-protocol)
- [Pinned Git send-pack](https://github.com/git/git/blob/v2.39.5/send-pack.c)
- [Pinned native repository Git handler](https://github.com/go-gitea/gitea/blob/v1.27.3/routers/web/repo/githttp.go)
- [Pinned native Git authentication middleware](https://github.com/go-gitea/gitea/blob/v1.27.3/routers/web/githttp.go)
- [Pinned PAT Basic authentication](https://github.com/go-gitea/gitea/blob/v1.27.3/services/auth/basic.go)
- [Pinned OAuth authentication](https://github.com/go-gitea/gitea/blob/v1.27.3/services/auth/oauth2.go)

The private-native deployment overlay is a reversible topology configuration, not a certificate of production quiescence. Default Compose/Helm native ports are untouched until explicitly selected; the existing `compose.https.yaml` reverse proxy does not prove `r.TLS` at the Golf listener and is not sufficient for these Git routes by itself.
