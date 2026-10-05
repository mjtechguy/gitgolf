# Portable static preview consumer

Source contract `golf.repository.local-static.v1`, migration067. This is a real
local SQL activation and protected file-serving adapter. Its source tests are not
runtime, DNS/TLS/browser or deployment qualification. All incomplete environment
requirements remain open.

## What is promoted

Only an existing successful qualified shell GitLab artifact is eligible: no
manual typed inputs, execution values or maintained Actions artifact outputs.
Prepare reads the original verified PG/object bytes and returns actual static
roots containing `index.html`. Create independently repeats every receipt:
run/attempt/native repository and owner/H/workflow blob/source SHA/archive SHA,
manifest/root, original storage kind/address fingerprint or saved profile/version,
exact environment/version/policy and operator target fingerprint. Active storage
selection never redirects a retained artifact. Archive parsing extracts nothing.
The existing bounds are10MiB archive,128 regular files and8MiB file bodies.
Unsupported active extensions, links, hidden/control/reserved paths and ambiguous
URL encodings are refused. Existing attachment downloads remain unchanged.

A typed COMMIT H is the usual source selection. BRANCH/TAG is explicit, must be
allowed by the saved policy and independently resolve to artifact H at request
and activation. It is not inferred from a manual run or default branch. A later
branch advance does not alter an already activated immutable preview.

## Authority and outcome

Create requires current positive ordinary native repository administration and
local password confirmation. Native/Golf instance administration supplies no
exception. Each configured reviewer signs in independently, has current native
read access, matches the configured native ID/login and cannot be the deployer.
Affirmative decisions bind an existing managed session/CV and its expiry. Review
keys are issuer/decision/deployment scoped; replay reports the current deployment,
not historical effect attribution. All recorded affirmative approvals must remain
live (a deliberately conservative quorum rule); no administrator bypass exists.

Explicit activation repeats artifact verification and source/current policy,
issuer and approval proofs under ordered user/session and environment locks.
Wait and live-preview concurrency are enforced there. The concurrency limit
counts static previews, not job CPU. There is no deployment execution worker or
automatic activation. READY means activated, not merely eligible. TTL starts at
activation and is capped by the authorizing sessions. Environment edits/deletion,
issuer/reviewer session or CV revocation, native authority loss, profile drift,
revocation and expiry withhold future access.

The deployment UUID is the original Create key. Its nonpassword input hash and
receipt are immutable. Acknowledgement loss requires original Get, never a fresh
key or automatic redispatch. SQL-only activation has no invented provider effect
or UNKNOWN state. Events commit with each state change; lazy expiry records the
terminal event and deletes only this deployment's access records. Revocation also
removes its access records. History and original artifacts are retained. A rollback
uses a new explicit request for an earlier qualified artifact with current policy
and fresh approvals; it never resurrects an old approval or hostname.

Managed-browser RPCs are Prepare/Create/Get/List/Review/Activate/Revoke. Read
receipts retain the original target revision; fresh request targets and current
native identities authorize inspection. Reviewer detail uses current read rather
than the admin-only environment configuration inventory. Eligibility is a current
observation, not an executable authority token.

State events and independent reviewer decisions append a repository `actions`
invalidation in the same PostgreSQL transaction. Replay, refusal and rollback
produce no extra committed activity. Existing authorized repository streams
revalidate deployment inventories, detail and current access without browser
refresh or automatic writes. The live payload contains no deployment receipt,
review decision, preview grant or artifact bytes. Current denial remains masked
until an explicit authorized read; immutable source comparisons stay pinned.

## Isolated origin and access

Disabled by default. All four operator variables must be supplied together:
`GOLF_PREVIEW_TLS_LISTEN_ADDR`, `GOLF_PREVIEW_TLS_CERT_FILE`,
`GOLF_PREVIEW_TLS_KEY_FILE`, `GOLF_PREVIEW_BASE_URL`.
The base is `https://preview.localhost[:PORT]`, canonical Golf must use HTTPS and
secure host-only `__Host-golf_session`, and preview TLS must cover
`*.preview.localhost`, be current and require TLS1.3. No host file/DNS edits occur.
Every deployment gets its own UUID hostname. Target identity includes configured
origin/namespace and certificate public-key identity; changed identity cannot
silently retarget old previews. All enabled listeners bind before any serve.
Browser reachability and operator trust remain actual qualification requirements.

POST `/api/deployments/UUID/open` is the managed-cookie, exact-Origin Golf gate.
It emits a transient trusted form which POSTs a60-second, hashed-only, single-use
launch grant to that preview's `/__golf/auth`. No token is in a URL, ordinary
receipt, browser storage or provider request. Redemption is atomic and sets a new
Secure/HttpOnly/host-only `__Host-golf_preview` cookie bound to the existing managed
parent session and deployment. It redirects only to `/`. The preview listener
contains no Golf/native routes, accepts only exact configured deployment Hosts,
and refuses Golf cookies, authorization headers, wrong origins and redirects.

Static HTML/JS/CSS executes on the separate project origin. Responses are
no-store/no-referrer/nosniff, deny framing, service workers and forms, and restrict
subresource loads and script fetches to the project origin. This is not a general
browser navigation or data-exfiltration guarantee for arbitrary project code.
Scripts and ordinary static assets are same-origin.
No SPA fallback, runtime server, external API or public URL grant is supplied.
Each file is buffered from the original verified archive before two current native
observations and local/session/CV/expiry checks complete. Serving has an8-request
bound,15-second request context and at most5-second write deadline capped by grant
expiry. Already delivered bytes cannot be recalled. Native authorization checks
are before/after observations, not an atomic fence against external native actors.

## Required actual proof

Root must run authored PostgreSQL tests and then a fresh cached-image profile with
private CA/direct TLS, wildcard browser resolution and an actual produced artifact.
Prove independent approvals/wait/capacity, wrong viewer/host/credential/path,
single-use redemption, policy/role/logout/CV/approval/expiry denial, original
PG/object profile/version after active-profile switch, no private bytes on failed
final proof, cookie/service-worker isolation, restart/original inspection and new
rollback request. Record exact images/source and owned cleanup. Custom DNS,
production runtimes/resources/secrets/data, PR-close cleanup, machine preview
access, provider deployment/R2 runtime qualification, Cloudflare/Kubernetes and
latest-schema recovery remain separate acceptance. The source packet alone does
not mark Environments Ready.
