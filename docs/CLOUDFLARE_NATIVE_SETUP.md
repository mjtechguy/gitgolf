# Native Artifacts repository setup

The integrated [Operations dashboard](OPERATIONS.md) at `/admin/operations` uses current Access identity and an explicitly enrolled native operations role. Fresh setup enrolls the configured owner; existing installations apply additive migration0010 and deliberately enroll administrators. Optional read-only analytics/probes, safe managed logs and a separate operator-owned dead-letter queue have their own setup flags and qualification gates. See the [robustness execution plan](CLOUDFLARE_ROBUSTNESS_OPERATIONS_PLAN.md). No Grafana is deployed in Cloudflare.

Repository **Settings → Access** uses the shared collaborator and invitation
editors for enrolled workspace accounts. Direct read/write/admin grants and removals
have atomic historical receipts. Invitations require Cloudflare Access sign-in,
explicit expiring consent and recipient acceptance; they send no email and do not
enroll users or add workspace membership. Issuer identity or administrator-grant
changes invalidate pending authority. Teams and SSH deploy keys remain unavailable.

Issues and PRs now share native repository labels, milestones, assignees and
metadata filters. Authors and administrators can edit/delete comments. Mutations
use current permissions, revision checks and durable original receipts. Label or
milestone changes invalidate linked discussion revisions; deletion clears links.
Organization labels, reactions, notifications and attachments remain separate gaps.

Existing installations must apply additive migrations 0011 (access), 0012
(invitations/identity versions) and 0013 (discussion resources), in that order,
before deploying schema13. The guarded release helper's `migrate` command applies
and checks their tables, indexes and triggers. Fresh setup includes them. These
migrations preserve current accounts, grants and discussions and promote no users.
See the [repository parity plan](REPOSITORY_PARITY_PLAN.md) for qualification and
remaining work. These adapters have local qualification; hosted rollout is pending.

This is the separate **native repository foundation**, independent of the portable installation and the Cloudflare migration bridge. Git objects and refs live in Artifacts. D1 stores workspace users, hashed credentials, repository identities, grants and operation records. A workspace Durable Object admits at most eight concurrent supported reads and serializes authorization changes and provider effects. Queued writes fence later reads. There is no Gitea, PostgreSQL, Tunnel or Docker dependency in this path.

This is not yet a replacement for the complete Golf application. The native path supports issues/comments, same-repository PRs, overall reviews, bounded container tests and concurrent agent proposals. The native deployment uses the same frontend, route tree, fonts, themes and repository/PR components as the portable installation. Native adapters supply source browsing, commit/PR diffs, issues, overall reviews, stars, repository description/website/topics, own profile and the enrolled workspace. Cloudflare allocation, test/agent evidence and preview controls sit inside those shared screens. Protected merge, general Actions, releases, packages, account administration, application build pipelines and complete recovery remain open. The [migration bridge](CLOUDFLARE_SETUP.md) retains existing product capabilities while that work proceeds. Existing repositories are not automatically migrated. Optional execution requires the separately approved container image and Docker during preparation.

## Repository navigation and live updates

The native metadata read includes an optional current default-branch selection, avoiding a second ref-resolution request on first entry. The shared UI deduplicates exact repository/commit/path reads across the source panel, navigator and README. Hover and keyboard focus prefetch at most two directories or files up to 256 KiB. Private observations remain in the bounded authenticated in-memory cache (64 entries, 8 MiB, ten minutes); no browser persistent storage holds private source. Retained or prefetched bytes require a fresh repository-access check before display. Fresh native source reads retain current authorization before and after provider waits. Current source snapshots stay pinned until an explicit Latest action; events never become merge authority.

`RepositoryActivityService/WatchRepository` now uses the existing Connect server-streaming contract, with both JSON and protobuf transport. A workspace Durable Object retains at most 1024 activity records plus one watermark per repository. Streams resume scoped cursors, reset after history compaction, recheck current identity and repository access before every frame, heartbeat every five seconds and rotate after ten seconds. Admission allows 32 streams per workspace and four per current actor. Backpressure coalesces topic invalidations; cancellation, permission loss and a hard lease release connections. Streams do not hold the workspace mutation gate while waiting. Hidden tabs abort streams and resume their cursor when visible; visible offline clients retain bounded polling fallback. No separate Redis, KV or event service is required.

Events cover writes through Golf's native Git/control ingress and its metadata/job workers. Direct privileged Artifacts-management writes bypass this journal and require a qualified provider notifier before equivalent freshness can be promised. These connection bounds are prototype admission limits, not global load qualification. The generated [capability inventory](CLOUDFLARE_CAPABILITY_INVENTORY.md) records 46 bounded adapters out of 297 shared RPCs; complete native parity remains open.

## Runtime-specific settings

`ListCapabilities` reports `runtimeProfile` and explicit settings capabilities. Portable server profiles are `portable` (unspecified deployment), `local`, `docker`, `kubernetes` and `cloudflare-bridge`; native Workers report `cloudflare-native`. Direct launches set `GOLF_DEPLOYMENT_RUNTIME` explicitly. Compose reports Docker, the isolated Cloudflare bridge overlay reports Cloudflare with a portable origin, and the Helm control plane reports Kubernetes. The profile describes hosting, rather than qualifying an execution adapter: the portable runner implementation remains Docker.

The portable frontend checks these capabilities for settings links, inventory actions, direct settings URLs and optional Cloudflare allocation controls. Missing, unknown, disabled or failed capability responses hide those actions and deny entry to the affected editors. Current user/admin/repository checks remain separate and authoritative. An older API lacking this metadata requires a coordinated server/frontend upgrade; the UI does not infer support from its hostname.

The shared account settings include a native **Settings and capabilities** section showing identity mode, approved tests, automatic CI, daily admissions, agent path, static/app allocations and expiry. These operator allocations are read-only in the UI; changing them requires the native setup below. Portable PostgreSQL/storage profiles, Docker pool enrollment, Golf passwords/MFA/SSH editors and SMTP settings are unavailable on this frontend. An enabled binding is configuration evidence, rather than proof of provider availability or successful execution.

## Managed Worker applications (bounded hosted API qualified)

This opt-in consumer deploys one approved, prebundled `.mjs` module and `.sql` schema from the exact passing canonical PR test source in Artifacts. Each preview receives a private D1 database, private R2 bucket, private Workers for Platforms script and dedicated child hostname under the existing preview namespace. A separate private cleanup script empties only that bucket. An outbound Worker rejects Internet fetches; no Durable Object, service, socket, control-plane credential or arbitrary provider binding is granted to application code. One optional, distinct Secrets Store reference is exposed as `APP_SECRET`; the provisioner token is kept in the control Worker's `APP_PROVISIONER` Secrets Store binding.

Prerequisites:

1. Enable [Workers for Platforms](https://developers.cloudflare.com/cloudflare-for-platforms/workers-for-platforms/reference/pricing/) in the selected account. Its subscription is separate from Workers Paid. After the operator's2026-10-09 upgrade, dispatch discovery and actual hosted application qualification succeed in the selected `golf` account.
2. Allocate a dispatch namespace using the selected profile after CLI command discovery. Create a Secrets Store and a short-lived, selected-account management token with Workers Scripts write, D1 write, R2 write and Secrets Store write authority. Store its value directly in Secrets Store with `workers` scope; installation files contain only the store ID and secret name. CLI OAuth cannot create account API tokens (403/error9109), but supported `cf user tokens create` accepts selected-account permission policies. The disposable launcher uses that path, keeps token values in memory and revokes them during cleanup. Do not copy OAuth credentials into a Worker or paste tokens into chat.
3. Configure the preview Access application to cover both `previews.mjtechguy.com` and `*.previews.mjtechguy.com` under the configured audience and approved identity policy. A child hostname without the expected runtime Access context is denied by the gateway. Preserve existing account users/providers/subscriptions.
4. Keep the existing approved evidence/test/preview options and add these initializer options, replacing identifiers with the operator's actual allocations:

```sh
--automatic-ci \
--app-namespace gitgolf-apps \
--app-entry worker.mjs --app-migration schema.sql \
--app-zone YOUR_PREVIEW_ZONE_ID --app-ttl 14400 \
--app-provisioner-store YOUR_SECRET_STORE_ID \
--app-provisioner-name golf-management \
--app-secret-store YOUR_APP_SECRET_STORE_ID \
--app-secret-name demo-signing
```

The last two options are optional and must reference a different secret from management authority. `--app-manual` disables automatic app publication; `--preview-manual` independently disables automatic static publication. `--automatic-ci` admits approved tests for open same-repository PRs after a confirmed eligible head/base branch push. The Git acknowledgement batch durably records pending CI; restart/scheduled processing rechecks current writers and exact source. Tags, branch deletion, stale pushes, unresolved Git writes, revoked users and exhausted allocations do not authorize execution. The push callback runs admission independently of the Git response; the five-minute scheduled trigger also recovers pending intake.

Run native preparation as usual, then review/deploy the generated `app-outbound` Worker first, the control Worker with `APP_DISPATCH`/Secrets Store bindings, and the existing `preview-worker` with application-host routing enabled. Use the native CLI's `--prebuilt --provision false` path from each prepared directory. These builds allocate nothing. Apply additive D1 migration `cloudflare/forge/migrations/0004_pr_apps.sql` once to an existing native database after migrations0001–0003; fresh bootstrap includes it. Never apply it to PostgreSQL, Gitea or the bridge database.

`/native/pr-preview` accepts `kind: "WORKER"` on `create`, using the same passing test job, exact repository IDs and original UUID operation key. The UI offers **Deploy Worker application** only for allocated app hosting and current writable passing-source rows. Automatic app and static publications use distinct durable operation keys. Lists, grant exchange, revocation and expiry retain current reader/active-user/PR-ref checks. App host grants redirect to that host's root. App HTTP requests allow bounded GET/HEAD/same-origin POST, with no forwarded cookies, Access assertions, authorization or user identity headers. Dispatch limits are50CPU milliseconds/eight subrequests; request/response bounds are64KiB/1MiB and the gateway reserves at most2000 app requests per workspace/day. Four unpurged previews and the existing daily publication/evidence limits also apply. These are prototype admission limits, not a provider billing cap or a hostile-application storage quota.

Every provider mutation is preceded by an `app_resources` journal record. Upload acknowledgement plus version/tag/binding readback, D1 identity and bucket/domain identities establish readiness. Replaying an uncertain preview does not allocate again. Revocation removes reviewer authority before deleting its owned domain, script, bucket contents/bucket, cleaner and database. Known resource cleanup can retry after a lost delete acknowledgement; identity changes refuse deletion. Lost create acknowledgements remain fenced and require operator reconciliation of that original journal entry; resources are never adopted by name. Scheduled cleanup reports pending peers and continues cleaning other previews. Policy changes require restoring the original allocation for cleanup. Application expiry is60–14400seconds; static preview expiry remains60–3600seconds.

`cloudflare/forge/demo/` contains actual Python tests, static assets and a Worker app that writes private D1 notes and signed R2 receipts using an optional Secrets Store HMAC key. `node cloudflare/forge/demo-check.mjs "$(command -v cf)"` executes the app against real local workerd/D1/R2 and verifies its receipt using a local test key. It does not qualify hosted Secrets Store or Workers for Platforms.

The execution Workflow stores its immutable report before separate `publish-static` and `publish-app` steps. Each publication has fresh invocation limits and rechecks current authority/source. Replay retains the original publication key and resource identities, including an uncertain allocation; it never repeats a create to repair missing acknowledgement. Delivery refusal leaves the completed test report intact. The private Workflow outcome distinguishes provider HTTP failure, script readback and binding readback without exposing provider bodies or credentials.

The [2026-10-09 hosted receipt](../.tmp/cloudflare-forge/golf-native-20261009-f8536cfa/ownership.json) passes real managed dispatch, custom-domain TLS/Access machine admission, private app D1/R2 writes, a verified Secrets Store HMAC, Internet egress denial, grant replay denial and current-reader revocation. All21 owned cleanup categories are absent. Its operator-only synthetic reviewer wrapper does **not** qualify human Access login or browser cookies. Missing dispatch scripts return HTTP200 with `script:null`; custom-domain IDs can contain40 hexadecimal characters; successful deletes can return an empty body or202. Readback checks still establish resource identity and absence.

For a populated demo, add `--evidence --evidence-ai --container-tests --agents --delivery --apps`, the selected `--app-zone`/`--app-host`, and `--demo-host gitgolf.mjtechguy.com --demo-email YOUR_EXISTING_ACCESS_EMAIL` to the qualification command below. The launcher seeds two private Artifacts repositories/PRs, actual passing CI, private evidence, two independent agent proposals and protected static/Worker previews. It adds owned email-code Access applications and an owned temporary identity provider without modifying existing account users/providers. Email-code dispatch requires the operator's approval.

The supervisor first reports `awaiting_login`. Verify the human Access login and UI before running `python3 scripts/cloudflare_demo.py begin PATH_TO_OWNERSHIP_JSON`. It renews the original static and Worker preview leases, reports `ready`, records `ready_at`/`stop_at` and starts the agreed **four-hour** window. Renewal retains preview identities/source/bundles, requires current writer authority and canonical open PR source, and atomically fences changed expiry. Both lifetimes require explicit operator policy and are capped at four hours or any earlier configured demo deadline. Activation failure retains the prepared UI for a bounded thirty-minute repair window and requires a new begin request. `python3 scripts/cloudflare_demo.py stop PATH_TO_OWNERSHIP_JSON` requests owned-resource teardown immediately; inspect each cleanup result in the receipt. An unstarted login window stops after30minutes. An independent recorded host timer protects against supervisor loss; the operator host and credentials must remain available. A deployed binding is not proof that the demo is ready; consult its current receipt.

General dependency builds, arbitrary application bindings, app cookies/WebSockets, application Browser Run tests, automatic PR comment links and global SaaS scaling remain outside this bounded consumer.

## Run the disposable qualification

The demo uses its final control hostname and Access audience from the first deployment. Do not seed under workers.dev and change the public origin while the same workspace Durable Object is active: that cutover failed hosted validation with an origin mismatch. Machine Git and Golf CLI requests require their separate approved Access service credentials as well as current Golf repository credentials. Golf CLI reads `GOLF_ACCESS_CLIENT_ID` and `GOLF_ACCESS_CLIENT_SECRET` only in native credential mode, rejects incomplete/control-character values and never follows redirects. Keep those values in the owner-controlled process environment, never Git config files or command arguments. Ordinary reviewers use their Access browser session.

Cleanup checks the owned control domain separately from the preview domain, before deleting the Workers and temporary Access configuration. Cloudflare documents that [custom-domain certificates can remain after domain removal](https://developers.cloudflare.com/workers/configuration/routing/custom-domains/); this prototype's receipts cover routing/resources, rather than a complete certificate inventory or automatic certificate retirement.

Use Node24, Python3, Git and the qualified native `cf` CLI1.0.0-beta.13. The bundle reuses the existing pinned esbuild installation under `cloudflare/agents`; install that directory's locked dependencies with `npm ci` if absent. Install the shared frontend's locked dependencies with `npm --prefix web ci` as well: the native Connect stream reuses its pinned protobuf wire codec, including for a CLI-only preparation. The account must already support Artifacts.

```sh
make cloudflare-check
node cloudflare/forge/runtime-check.mjs "$(command -v cf)"
python3 scripts/cloudflare-forge-smoke.py \
  --profile golf --account-id YOUR_ACCOUNT_ID \
  --workers-subdomain YOUR_EXISTING_WORKERS_SUBDOMAIN
```

The script verifies the selected OAuth profile/account and starts a fresh, isolated Artifacts namespace, D1 database and Worker. It creates a private repository through Golf, checks creation replay, pushes and clones real Git through Golf's authorization broker, compares commit and file bytes, and verifies reader access, write denial and revocation. Provider Git credentials stay inside the Worker and are revoked after each request. Only the one-hour operator bootstrap described below writes a Golf credential to disk; qualification credentials stay in process memory and expire after15minutes.

Each run has a 15-minute deadline and owner-only receipts under `.tmp/cloudflare-forge/`. Cleanup retires the owned Durable Object class, removes the Worker, removes the owned Artifacts repositories/namespace and deletes D1, then checks their absence. The [2026-10-08 native collaboration receipt](../.tmp/cloudflare-forge/golf-native-20261008-690ef349/ownership.json) passes this bounded proof, including directory/symlink/binary/source-selection reads, actual Golf CLI issue create/read, D1 issue/comment replay, revision edits, real PR branches, review staleness after a new push, commit-bound reported checks and collaboration revocation. Read the final `state` and **each cleanup result**; a failed or partial run is not acceptance. Cleanup errors require operator attention. Neither the script nor its deadline implements a provider-wide billing cap.

## Prepare an operator installation

Use a fresh D1 database and Artifacts namespace, not the bridge database or an existing tenant. Create them with the selected profile's native CLI after anonymous command discovery:

```sh
cf cli search 'create database'
cf cli search 'create artifacts namespace'
cf --profile golf d1 create --name gitgolf-native
cf --profile golf artifacts namespaces create --namespace gitgolf-native
```

Record the returned database UUID, then prepare private files locally:

```sh
python3 scripts/cloudflare_forge.py \
  --account-id YOUR_ACCOUNT_ID \
  --hostname gitgolf.mjtechguy.com \
  --workspace YOUR_WORKSPACE --owner YOUR_LOGIN \
  --namespace gitgolf-native \
  --database-id YOUR_D1_UUID --database-name gitgolf-native
```

The initializer provisions nothing. It writes `.cloudflare/native/` mode0700, independently of `.cloudflare/install/` and all local `.env*` files. Files are mode0600. It refuses an existing destination instead of rotating authority. `forge.json` holds resource identities and the exact public origin; `bootstrap.json` holds schema/user inserts and a SHA256 credential digest; `credential.json` holds the corresponding bearer credential, expiring in one hour. Keep the latter private and never commit, paste into chat or put it on a command line. This initial operator credential is not a tenant login or a production credential lifecycle.

Apply bootstrap once to the **fresh** database and prepare the Worker:

```sh
cf --profile golf d1 query YOUR_D1_UUID --batch @.cloudflare/native/bootstrap.json
node cloudflare/forge/prepare.mjs .cloudflare/native "$(command -v cf)"
```

Review the generated configuration, domain ownership and existing routes before publishing. This installation and the bridge cannot both own `gitgolf.mjtechguy.com`. Native `cf deploy --prebuilt --provision false`, run from `.cloudflare/native/`, publishes the prepared Worker and custom domain using its configured existing resources. The native custom-domain/operator-bootstrap path has not been qualified end to end; the disposable proof uses an independently verified Workers subdomain instead. Do not switch existing users onto it based on source or disposable proof alone.

The default disables Workers subdomain and alternate preview URLs. An API-only installation uses a short-lived Golf bearer credential. The native control UI requires Cloudflare Access as its default sign-in: when `access_aud` is configured, every HTTP caller must pass that exact Access application, including callers using a Golf bearer. Golf accepts human identity only from runtime-authenticated `ctx.access.getIdentity()`, strips caller-supplied identity headers and requires an active, already mapped D1 user. Access authentication never supplies repository grants or auto-enrolls a user. Real local workerd checks cover this mapping and disabled-user denial; the disposable populated demo also verifies actual human Access sign-in, shared repository/PR browsing and a protected Worker application D1/R2 write/read. The earlier bridge browser proof is separate.

## Access login and native reviewer UI

Create a dedicated Access application/policy for the control hostname and record its audience. Use an actual enrolled identity provider or approved email-code login; keep machine Service Auth policies separate. Apply this to the exact Worker or hostname, with alternate endpoints disabled. Do not change account-wide Access policy to enable Golf. Build the native entry of the shared frontend:

```sh
cd web
npm run build:native
```

Append `--access-aud YOUR_CONTROL_AUDIENCE --owner-email YOUR_VERIFIED_EMAIL --web-assets /ABSOLUTE/PATH/web/dist-native` to the fresh initializer command. This maps the bootstrap owner explicitly. Grant other users through native authority, preserving their independent repository roles. The portable frontend/login and PostgreSQL deployment remain separate.

The control Worker embeds the shared built UI, including exact Archivo/Geist Mono font bytes, with a 192-file/4MiB limit. The current build is approximately 3.7MiB. Both entries import the same application and route tree; native setup does not introduce another visual implementation. It deliberately does not use the Static Assets router: that router currently does not propagate `ctx.access` to the user Worker ([provider limitation](https://developers.cloudflare.com/workers/configuration/cloudflare-access/#ctxaccess-limitations)). UI assets require a current active Golf session and receive no-cache/CSP headers. Direct identity headers and unverified JWT strings are rejected. For large-scale public SaaS, qualify customer IdPs, onboarding, identity changes, MFA requirements and Access seat economics before adopting this as universal customer authentication.

The UI displays private repository and PR inventories, overall reviews, test/agent admission, retained evidence, two-proposal comparison and preview operations. Inventories explicitly cover only the loaded first 100 entries. Uncertain admissions preserve their original operation keys. Comparisons require two completed, current reports with the same exact source/revision; overlapping changes require human resolution, and separate-file changes still require integration tests. Comparison never merges or publishes canonical Git. Shared issue/source/file/commit/PR browsing, same-repository comparisons, overall review, stars and own profile use native adapters. Account administration, source editing, inline/pending review, review requests, streaming activity, labels/assignees/milestones, releases/packages/wiki and general workflow controls remain unimplemented native capabilities. Their errors/disabled controls must not be mistaken for empty inventories or successful operations.

Machines need Access service credentials plus a separate scoped Golf credential. The Golf CLI native mode reads the paired `GOLF_ACCESS_CLIENT_ID` and `GOLF_ACCESS_CLIENT_SECRET` environment variables and refuses redirects or incomplete pairs; Git requires its independently configured Access transport. The UI stores no Golf bearer in browser storage.

### Existing native installation: shared UI migration

Fresh bootstrap includes migration `0005_shared_ui.sql` and enrolls the configured workspace. Existing installations must first apply their missing additive migrations0001–0004, then apply `cloudflare/forge/migrations/0005_shared_ui.sql` once through the supported D1 query API. Record the migration result privately; do not rerun fresh bootstrap or rotate existing users/credentials. Enroll the installation's exact configured workspace slug and Artifacts namespace in `workspaces`, preserving any existing entry. Prepare and deploy the shared native build with the same public origin, Access audience, resource identities and ownership receipt. This does not migrate portable PostgreSQL or Gitea data.

Worker upload and active Durable Object code can briefly serve different versions during rollout. The current native CLI deployment took approximately five minutes before the existing workspace served the new comparison/stream-refusal contracts; verify the hosted methods after upload rather than relying on a deployment acknowledgement. Keep additive API/schema changes compatible through that interval.

The new tables hold enrolled workspace identity, user/repository stars and revision-fenced own profiles. Organization lists reflect this one enrolled private partition, rather than fabricated team inventories. Profile updates cannot change login/email/Access identity, and repository stars always recheck current repository access. Core reads continue to require current users/grants even for immutable commit IDs.

## Protected native static PR previews

Enable the existing evidence/container-test allocation, then append these initializer flags:

```sh
--preview-hostname previews.mjtechguy.com \
--preview-worker gitgolf-native-previews \
--preview-access-aud YOUR_PREVIEW_AUDIENCE \
--preview-path public --preview-ttl 900
```

The initializer provisions nothing. Allocate a separate Access application for the preview hostname before publication. Preparation builds a second Worker under `INSTALL_DIRECTORY/preview-worker`, with only a scoped `PreviewBroker` service binding to the control Worker; it has no direct D1/R2/Artifacts or provider-secret binding. Publish the control Worker first and the preview Worker second, each from its own prepared directory with `cf --profile golf deploy --prebuilt --provision false`. Existing native databases must apply `0001_pr_tests.sql`, `0002_pr_agents.sql` and `0003_pr_previews.sql` once, in order, before serving this code. Fresh bootstrap already includes them; do not reapply migrations or bootstrap an existing database.

Passing canonical PR tests automatically publish the approved static directory from the exact Artifacts commit/tree into a private, digest-verified R2 bundle. `--preview-manual` disables that automatic publication. This starts after admitted tests complete, not automatically on every PR push; automatic CI intake and PR comment/link publication remain open. Agent proposals and failed/stale tests cannot publish previews. Only regular UTF-8 HTML/CSS/JS/SVG/JSON/text files are allowed, with 64 entries, depth 8, 256KiB/file and 1MiB content bounds. `index.html` is required. Use relative asset links. This slice performs no arbitrary build, API deployment, app D1/R2 provisioning or SPA rewriting.

Current repository readers follow the preview link through Access, return to Golf for a 60-second single-use reviewer grant, and exchange it in a bounded POST for an HttpOnly/Secure session lasting at most five minutes. Every content read rechecks active user, current grant/session, open PR/revision/refs and preview expiry; a revocation, push or PR closure denies access. Credentials are hashed in D1 and never placed in a URL. The initial implementation uses UUID paths on one dedicated preview hostname and a CSP sandbox without `allow-same-origin`, rather than the planned per-preview hostname/application isolation.

Preview TTL is 60–3600 seconds. D1 limits four unpurged allocations and the configured evidence daily limit (1–20) per workspace, counting failed/uncertain/revoked reservations. A lost publishing response retains `PUBLISHING` and never rebuilds or republishes on replay; inspect/revoke the original operation. Revocation fences access before purging private objects and credentials. A five-minute cleanup schedule purges expired/revoked storage; expiry denies content immediately. Retire/delete the separate preview Worker when removing an installation; retiring the control Worker alone does not delete it.

`--preview-browser-snapshots` optionally enables one Browser Run screenshot per preview. Current writers request it explicitly; D1 reserves the single paid dispatch before execution. It renders the stored index HTML with JavaScript and all network requests disabled, retains an integrity-checked private PNG and projects observed Browser Run milliseconds when available. External assets and interactive behavior are not tested. A timeout/lost response remains `UNKNOWN` and is never automatically retried. The daily envelope is an admission policy, not a provider-enforced dollar ceiling.

POST `/native/pr-preview` with exact `repository`, `repositoryId` and an action: `list`, `create` (passing `jobId`/original UUID key), `grant`, `revoke`, `capture` or `screenshot` (exact `previewId`). Grant/list/private screenshot reads require current reader authority; other mutations require current writer/admin authority. POST `/native/preview-resume` uses only the exact preview UUID and current human identity. POST `/native/pr-evidence` also supports `list` for an exact PR number and `compare` for exactly two distinct job IDs; the UI uses these same current-authority endpoints.

Disposable hosted qualification uses `--evidence --container-tests --delivery`. Its operator-only wrapper checks actual Access plus a separate nonce before invoking real preview RPC with a synthetic mapped reviewer; this does not establish human reviewer login. Product builds contain no qualification route. Read the current [status ledger](IMPLEMENTATION_STATUS.md) for actual hosted outcomes and cleanup, rather than treating a generated bundle or unit interface as provider acceptance.

## Supported contracts and limits

The Worker implements JSON Connect requests at the existing `/rpc/golf.v1.*` paths. Use `Content-Type: application/json`, `Connect-Protocol-Version: 1`, and `Authorization: Bearer <credential>` supplied from a private client environment or credential helper.

- Session lookup, capability inventory, private repository creation and creation status, repository list/get, branch/tag lists, explicit immutable source selection, directory/file reads, commit lists/diffs, current same-repository merge-base comparison, repository stars/overview, own profile and the explicitly enrolled private workspace, plus the collaboration contracts below.
- Creation requires an operation UUIDv4 and `private: true`. Reusing the key with different inputs fails. A provider outcome that cannot be confirmed remains `CREATING`; repeating the request does not redispatch creation.
- Canonical Git is served at `/git/WORKSPACE/REPOSITORY.git`. Credentials authorize through current per-repository read/write/admin grants; workspace membership alone gives no private repository access. Artifacts tokens and remotes are never returned as user clone credentials.
- `/native/repository-grant` is an administrator-only JSON POST with `repository`, `repositoryId`, `userId` and `role` (`read`, `write` or `none`). Users must already be enrolled in this workspace's D1 database. The current administrator cannot remove their own grant through this endpoint.
- Git writes support one ordinary SHA1 branch/tag update with an ASCII ref name per push, with an8MiB request limit; fetch output is bounded at16MiB. Atomic multi-ref writes, protected branches, push options, SSH and LFS are not implemented. These are Golf's current bounds, not claims about the provider's maximum capacity.
- Directories paginate at100 entries per response with at most10,000 immediate entries; paths remain bounded at32 components/1024 characters. File previews expose at most256KiB of UTF8 text; binary/oversized files retain metadata. Symlinks expose their own contents without traversal; submodules expose the referenced commit. Readable suffix selection resolves literal branch/tag/full-commit identities and rejects ambiguity. Commit lists/path history read actual Artifacts metadata. Native commit/PR/comparison diffs traverse actual Git trees, preserve modes, symlinks, submodules, binary metadata and missing newlines, and fail rather than truncate. History/ancestry is bounded at500 commits, changed files at256, blob reads at512KiB each/2MiB total and returned diffs at512KiB. Multiple best merge bases and cross-repository comparisons remain unsupported.
- This initial partition has one D1 database and Artifacts namespace per workspace, repository read/index Durable Objects and a workspace authority/mutation Durable Object. It is not yet the scalable global tenant router or a production throughput qualification.

## Native collaboration and CLI

Issues and PRs share repository discussion numbers but retain separate issue and PR identities. Existing repository readers can create issues and comments. Authors can edit their own discussions; current writers/admins can manage discussions. PR creation requires current write/admin access and two different branches in the same repository, with exact displayed repository IDs and base/head commits. Cross-repository/fork proposals remain unsupported. Do not infer source access from target repository access.

The shared `RepositoryService` JSON contracts support `CreateIssue`, `GetIssue`, `ListIssues`, `UpdateIssue`, `CreateIssueComment`, `ListIssueComments`, `CreatePullRequest`, `GetPullRequest`, `ListPullRequests`, `UpdatePullRequest`, `ListPullRequestCommits`, `GetPullRequestDiff`, `GetPullRequestDiscussion` and `GetIssueMutation`. Title/body/state updates require the current displayed revision and exactly one changed field. PRs also support one draft change. Native lists support state, author and literal text search; PR lists additionally support base-branch filters and newest/oldest/updated/least-updated sorting. Unsupported label/assignee/milestone filters are refused. Those metadata inventories remain unknown, not fabricated empty lists. Comments currently expose no edit/delete controls.

Every successful create/update/comment/review/check commits its effect and owner-scoped operation key together in a D1 transaction. Repeating the same admitted inputs returns the recorded operation and a current authorized resource read. Changed inputs on a committed key fail. A lost response after commit can be inspected with the original key; it never requires guessing another key or reposting blindly. Revoking repository access also denies the user's operation-resource reads. Failed preconditions do not establish a successful operation.

`CreatePullRequestReview`, `ListPullRequestReviews` and `GetPullRequestReviewMutation` support immediate overall approval, comment and change-request reviews. The exact PR identity, metadata revision and live base/head commits are required. Authors cannot approve/request changes on their own PR. Draft/closed PRs, unresolved Git writes and unavailable live refs reject review admission. New pushes invalidate older review observations; a later read marks the retained review stale. Inline/pending reviews, reviewer requests and protected approval eligibility remain unimplemented. Reviews have `official: false`; they are not trusted merge decisions.

Administrators can report a status at `/native/repository-check` using `repository`, `repositoryId`, full `commitId`, `context`, explicit `REPORTED_CHECK_STATE_*`, optional `description`/HTTPS `targetUrl`, and an operation UUIDv4 in `idempotencyKey`. `ListPullRequestChecks` uses the existing complete PR `selection` contract and returns the latest report per context on that selected head commit. Old selections are refused after a push; old success reports are never moved to the new commit. These are **reported status observations**, not evidence that Golf executed CI and not merge eligibility. Actions runner attestations remain separate work.

The existing Golf CLI now has an explicit native credential mode. Build it using `go build -o .cloudflare/native/golfctl ./cmd/golfctl`, then supply the native credential through `--native-token-stdin` or `GOLF_NATIVE_TOKEN`. Do not mix it with Gitea or portable Golf API credentials. Native issue/PR write commands require explicit request files with the existing Protobuf JSON fields, exact IDs, revisions and original operation key. For example, after privately preparing `issue.json`:

```sh
python3 -c 'import json; print(json.load(open(".cloudflare/native/credential.json"))["token"])' | \
  .cloudflare/native/golfctl --url https://gitgolf.mjtechguy.com \
  --native-token-stdin issue create --input issue.json
```

The credential travels through the pipe, not command arguments. `issue view`, `issue comments`, `issue operation`, `pr view`, `pr reviews`, `pr checks` and `pr review-operation` use the corresponding native read endpoints. The same native mode supports `issue comment`, `issue update`, `pr create`, `pr update` and `pr review`. Native MCP enrollment and source-write commands are refused. Portable credentials retain their existing repository-scoped write requirements. There is no automatic CLI write retry, credential saving or native login/logout call.

A Git operation is journaled before dispatch. A lost/failed provider response or mismatched observed ref leaves `write_pending` set; further writes are refused, while grants can still be revoked. Do not clear that field or mark an operation applied merely to unblock a client. Reconciliation must independently verify the operation, provider tokens and final ref after in-flight work has stopped; an automated recovery workflow remains required before production. Never route protected repositories onto this unprotected write implementation.

There is no native backup/restore, canonical import/cutover or durable retention qualification yet. Preserve existing bridge ownership until those acceptance gates and the tenant's required capabilities pass.

## Optional queued PR evidence

### Operator-approved container tests

Tests are disabled by default and require the evidence allocation below. Build the existing maintained Linux image, inspect its immutable Docker ID, and add these flags to the fresh native initializer:

```sh
docker build --platform linux/amd64 --provenance=false \
  -f cloudflare/agents/Dockerfile -t golf-cf-agent:qualification .
docker image inspect golf-cf-agent:qualification --format '{{.Id}}'

# Additional scripts/cloudflare_forge.py flags:
--test-module test_calc \
--test-image golf-cf-agent:qualification \
--test-image-id sha256:YOUR_APPROVED_IMAGE_ID
```

The approved module must exist in each selected repository; `test_calc` is the qualification fixture, not a universal project test command. The initializer provisions nothing. Preparation refuses an image tag whose current Docker ID differs from the approved ID, then declares one container application, the `PRTestTask` SQLite Durable Object and the private `TestOutbound` broker. The policy digest binds the module and approved image ID. Queued work is refused after policy rotation. For an existing native D1 installation, apply `cloudflare/forge/migrations/0001_pr_tests.sql` once before deploying the new code; fresh schema bootstrap already includes those columns. This migration does not touch the portable PostgreSQL installation.

Add `"runTests": true` to the evidence creation body. The client cannot choose an image, module, shell command, duration or network policy. Admission requires current repository write/admin access, exact open PR commits, an approved policy and the existing daily allocation. The metadata snapshot is capped at128KiB when requesting tests, reserving space for at most64KiB of execution output. Up to two CI or agent containers share the workspace allocation; admission beyond that allocation is refused, rather than silently provisioning a larger fleet.

One task ID admits one process. Workflows poll boundedly and destroy the container in a final cleanup step. An ambiguous/restarted container dispatch records `LOST` and never reruns the process. The controller clones the PR's named head branch and verifies both recorded commit and tree before execution. A moved branch is refused. Repository-scoped read tokens are minted/revoked for each upload-pack request in the Worker and never enter the container. Receive-pack, redirects, unrelated Git URLs and other outbound destinations are denied. After clone, all test-stage network traffic is denied. Authority, PR selection and policy are rechecked before clone requests, before running tests and before storing the report.

The trusted controller runs `python3 -m unittest -v APPROVED_MODULE` with a60-second process timeout and a5-second kill grace, bounded file output, no Git hooks/credential helpers and no shell interpolation of user input. Python test code is untrusted code inside a separate Cloudflare container; changing the Unix user is not an extra security boundary. See [Sandbox security](https://developers.cloudflare.com/sandbox/concepts/security/) and [native container execution and outbound interception](https://developers.cloudflare.com/containers/api/durable-object-container/). This first profile has no dependency downloads, arbitrary workflow commands, secrets, agent editing or canonical Git writes.

`testState` is `NONE`, `REQUESTED`, `RUNNING`, `PASSED`, `FAILED`, `TIMED_OUT`, `CANCELLED` or `LOST`. A report's `tests` binds the task ID, commit/tree, module, policy digest, exit code, bounded output, broker denial count and confirmed destruction. `LOST` includes a bounded private preparation diagnostic and stage. `SUCCEEDED` means evidence storage completed; tests may still have `FAILED`. Results are untrusted execution observations and do not become protected checks or merge authority. Clef receives only the execution state/module/commit when tests exist, never their output. A queued job can be refused after a push even if its earlier test process exited successfully.

Qualify the hosted consumer with `scripts/cloudflare-forge-smoke.py --evidence --container-tests` plus the existing profile/account/subdomain flags. This runs the module on both a passing commit and a deliberately failing successor, verifies an actual brokered403 network denial, and retains both exact private results before removing the Worker, container application, registry image tag, queue, workflow, R2 bucket, Artifacts namespace and D1 database. Add `--evidence-ai` only when intentionally testing the separately approved inference path. All proof resources are temporary. The60-second test timeout, bounded Workflow polling and daily admission allocation do not enforce a provider-wide billing cap. The [final hosted receipt](../.tmp/cloudflare-forge/golf-native-20261008-41c3d38b/ownership.json) qualifies that consumer and complete owned teardown.

### Operator-approved native PR agents

Agent admission is separate from portable Go/PostgreSQL and from the fixed-role operator qualification. Enable it in a fresh native initializer with `--agent-path src/math.py`, the complete container-test flags above, and the private `--evidence-ai --evidence-gateway` allocation below. Choose one existing regular source file and the repository's Python unittest module. The source path cannot traverse hidden directories, use glob patterns or name the approved test module itself. The initializer provisions nothing; prepared configuration declares a separate agent container application, `PRAgentTask` SQLite Durable Object and `AgentOutbound` interception export. The policy digest binds the approved image/module and effective file policy. Existing native D1 installations apply `0001_pr_tests.sql`, then `0002_pr_agents.sql`, once each as needed; fresh schema already includes both. Never apply these migrations to PostgreSQL.

Use the same `POST /native/pr-evidence` admission with `"agent": {"prompt": "Make the requested change in the approved source file."}` and explicit `advice: false` or `true`. An agent job includes its own approved tests, so omit `runTests`. Prompts are limited to16KiB. Current repository writers/admins select exact open PR base/head commits and a UUID operation key. Replaying that key inspects the same task; changing the prompt or selection conflicts. Daily evidence admission includes agent jobs and failed/unknown operations. Two CI/agent containers share the workspace limit; additional admission is refused. This is a planning envelope, not a Cloudflare billing cap.

The workspace journals a unique private Artifacts fork name before dispatch, copies all branches, verifies fork lineage and the selected commit/tree, and revokes its initial active tokens. A lost fork response is inspected using that name without another fork dispatch. Only the trusted Worker mints60-second read/write tokens, one request at a time, and revokes them; tokens never enter the container. Read access is limited to that fork's upload-pack during a full single-branch clone; the returned pack must fit the existing16MiB Git response bound. Shallow clients' additional update preambles remain outside the supported publication grammar. Write access is limited to one controller-issued update of its selected branch from the recorded head. The publication journal is fenced before receive-pack; a lost write response is never automatically resent. Provider ref readback and exact proposal commit/tree/parent checks are required before publishing evidence. Canonical repository writes and protected merges are unavailable to agents. See the [Artifacts Workers binding contract](https://developers.cloudflare.com/artifacts/api/workers-binding/).

The runtime reuses the maintained OpenCode1.18.34 controller and Workers AI `@cf/zai-org/glm-5.3-flash` through the approved private gateway. Effective native read/edit/write tools are restricted to the one approved source path; shell, plugins, MCP, LSP, external files and other source/test paths are denied by that profile. The controller verifies the resolved native permissions, exact clone identity, changed-file inventory and regular-file mode. It commits the proposal, runs the approved module with a60-second timeout, and checks that tests did not move the commit/tree or alter tracked files before publication. Failing tests remain review observations; they do not become a passing check. This profile is not general hostile-repository isolation, arbitrary commands/dependencies or all-harness acceptance.

Each task has at most120seconds of agent execution,16 reserved inference calls,64KiB request bodies and2,048 output tokens per call. Reservations precede dispatch and are not refunded or retried after uncertainty. Ambiguous startup is not rerun. Outbound traffic is intercepted; only the task fork's stage-specific Git route and the one Workers AI endpoint are allowed. Current original-writer authority, PR selection, policy and expiry are checked before execution, inference, publication and report storage. Cancellation fences authority before destroying the container; an already dispatched Git push or inference cannot be claimed undone. The prepared execution Workflow allows two concurrent instances; D1 still fences two total CI/agent containers. Failed workflows durably refuse further work. Workflows poll boundedly and destroy both test/agent task containers in their final cleanup steps, including refused or failed work.

`agentState` is `NONE`, `REQUESTED`, `FORK_PENDING`, `RUNNING`, `succeeded`, `failed`, `cancelled`, `timed_out` or `lost`. Private reports retain the prompt, selection and bounded `agentResult`: exact source/proposal identities, patch, projected native events, observed tokens/calls, execution interval, observed tests, policy digest and confirmed destruction. Agent result data is limited to96KiB; the complete report remains limited to224KiB. `SUCCEEDED` describes completed report storage, not passing tests or merge approval. All current repository readers may inspect the retained prompt, patch and execution context; do not submit unrelated personal credentials in prompts. A moved PR marks retained results stale; revocation denies later reads. Native browser/CLI agent controls, multi-file policies, integration/comparison UI, recovery/retention and fleet-scale acceptance remain open.

Run `scripts/cloudflare-forge-smoke.py --evidence --evidence-ai --container-tests --agents` with the explicit profile/account/subdomain arguments to qualify two actual concurrent native-authorized agents. The launcher requires distinct forks/proposals, real inference/completion intervals, unchanged canonical Git, private reader access, stale results and revocation; it retains owner-only receipts and removes all owned test resources. Source/unit and native build checks are separate from a successful hosted receipt. The [final hosted receipt](../.tmp/cloudflare-forge/golf-native-20261009-aacad957/ownership.json) and [source/cleanup manifest](../.tmp/cloudflare-native-agents-final.json) qualify this consumer: two distinct proposals,13,021ms of overlapping native execution, unchanged canonical Git, stale/revoked-reader behavior and complete teardown.

### Evidence allocation and API

An optional initializer flag `--analytics-dataset golf_pr_metrics` configures **Analytics Engine** completion measurements. The default leaves it disabled. This integration is source/unit qualified; hosted writes and SQL readback are not claimed by the disposable launcher. The first actual write creates the provider dataset, and provider retention remains separate from retiring a Worker. No analytics dataset was created by these tests.

After durable report success, Golf emits a best-effort point with one hashed account/workspace index; blobs are schema, repository ID, test state and advice state. Doubles are completion count, serialized report bytes, elapsed milliseconds and observed input/output tokens. A missing token observation is `-1`, including potentially billable unknown inference. No prompt, title/body, source, output, email, credential, workspace name or task ID is sent. Sampling, dropped writes and provider retention mean this is operational telemetry, never authoritative quota or billing. D1 admission continues to enforce the daily allocation if telemetry is unavailable. Operators can aggregate their dataset with Cloudflare's account-scoped SQL API, filtering token observations to values at least zero and using `_sample_interval` for sampled counts. See [Analytics Engine write semantics](https://developers.cloudflare.com/analytics/analytics-engine/get-started/) and [SQL authentication and queries](https://developers.cloudflare.com/analytics/analytics-engine/sql-api/).

The native API can capture a private, immutable PR report through **Queues → Workflows → R2**, with optional **Workers AI Clef through AI Gateway** and **Containers/Sandbox tests or isolated agent proposals**. D1 retains the admitted job, original owner/input key, snapshot, inference reservation and report digest. The workspace Durable Object serializes these steps with Git and permission changes. This is an API consumer; the browser and generated CLI do not yet expose evidence-job controls.

Allocate fresh, private resources in the same selected account before enabling it. The default native setup leaves this capability disabled. Supply these additional initializer flags when preparing a new installation:

```sh
--evidence-bucket gitgolf-evidence \
--evidence-queue gitgolf-evidence \
--evidence-workflow gitgolf-evidence \
--evidence-daily-limit 2
```

The bucket and queue must already exist; the prepared Worker declares the named `EvidenceWorkflow` export and queue consumer. The initializer still provisions nothing. Create the bucket with `cf --profile golf r2 buckets create --name gitgolf-evidence` and the queue with `cf --profile golf queues create --queue-name gitgolf-evidence`, following anonymous CLI discovery and explicit account selection. Verify that the bucket has neither an enabled r2.dev domain nor custom public domains. Worker publication uses these allocated resources with `--provision false`.

AI is a separate operator decision: add `--evidence-ai --evidence-gateway gitgolf-evidence` only after allocating that gateway. Require authentication, disable prompt/response logging and caching, and keep its retry/rate settings bounded. Native calls additionally use `collectLog: false` and `skipCache: true`. Metadata advice uses only `@cf/cloudflare/clef`; the separately enabled agent profile fixes its coding model as described above. Clients cannot select another model or provider. The prompt contains at most the PR title, 4,000 body characters and 20 review/check status observations each, No repository files, Golf/Artifacts credentials, account email fields or tool access are added. The selected PR title/body are private content and are sent only under the enabled operator policy and explicit `advice: true` request. Repository text and the resulting answer remain untrusted advisory data. Gateway/operator access and any provider-side retry configuration remain separate from Golf's one-call reservation.

Use the same private bearer, exact Origin and JSON/Connect headers as other native API calls. POST `/native/pr-evidence` with one of these bodies, supplied from a private request file/client rather than token-bearing command arguments:

```json
{
  "action": "create",
  "idempotencyKey": "YOUR_ORIGINAL_UUID_V4",
  "advice": false,
  "selection": {
    "repository": { "owner": "YOUR_WORKSPACE", "name": "YOUR_REPOSITORY" },
    "repositoryId": "1",
    "pullRequestId": "1",
    "number": 1,
    "baseCommitId": "EXACT_DISPLAYED_BASE_SHA1",
    "headCommitId": "EXACT_DISPLAYED_HEAD_SHA1"
  }
}
```

Creation requires current write/admin access, an open PR, live matching refs and no unresolved Git write. Successful admission snapshots the displayed PR plus at most 100 overall reviews and 100 reported check contexts, with explicit truncation flags and a 192KiB snapshot bound. Every admitted job consumes that workspace's UTC-day allocation, even if dispatch or inference later fails; the explicit limit is 1–20 jobs/day. Expiry is ten minutes after admission. Queue payloads and Workflow step outputs carry only opaque job IDs and states.

Status/report bodies use `action: "status"` or `action: "report"`, `jobId`, `repository` and exact `repositoryId`. Current repository readers may inspect/download a known job; revoked users are denied. Report downloads re-read private R2 bytes, verify their stored size/SHA256 and return JSON with no-store headers. The retained report binds the selected base/head, metadata revision, review observations, reported checks and optional advice/tests. Later pushes/metadata changes mark it `stale`; retained bytes never acquire a new source selection. The default metadata-only job executes no code or tests. No report authorizes merge.

Current writers/admins may use `action: "cancel"` with those same job/repository identifiers. Cancellation durably refuses subsequent provider work before stopping an admitted container. Cleanup failure returns an error and the same cancel request can be repeated; cancellation does not claim to undo an already dispatched AI call. Completed reports remain immutable.

States are `QUEUED`, `SUCCEEDED`, `REFUSED` and `EXPIRED`. `delivery` distinguishes `PENDING`, `SENT` and `STARTED`; `adviceState` distinguishes `NONE`, `REQUESTED`, `RESERVED`, `SUCCEEDED` and `UNKNOWN`. Repeating the original creation inputs returns the original job. A lost queue acknowledgement leaves a durable pending outbox; original replay may dispatch the same job ID at most three times. A confirmed delivery is not automatically redispatched. Exhausted delivery or a dead queue needs operator inspection of that original job; do not blindly create another key. There is no scheduled outbox reconciler yet.

Queue redelivery starts/reconciles the same Workflow instance ID and never restarts an uncertain instance. The advisory step has no Workflow retries; a durable `RESERVED` record prevents another model dispatch after restart. Failure, malformed output or the 25-second wait deadline retains `UNKNOWN`, and a metadata report can still complete with that explicit uncertainty. The timeout does not prove provider cancellation or absence of billing. R2 writes use a digest-bound key, a create-only conditional PUT and exact readback; a lost PUT acknowledgement can safely retry those same bytes. Current actor/write grants, enabled policy, deadline and PR selection are rechecked before provider work and report publication.

Qualify the optional allocation using:

```sh
node cloudflare/forge/runtime-check.mjs "$(command -v cf)"
python3 scripts/cloudflare-forge-smoke.py \
  --profile golf --account-id YOUR_ACCOUNT_ID \
  --workers-subdomain YOUR_EXISTING_WORKERS_SUBDOMAIN \
  --evidence --evidence-ai
```

Omit `--evidence-ai` for a no-inference proof. The launcher retains a private local report, verifies actual queued Workflow/R2 completion, replay, exact source binding, later-push staleness and reader revocation, then removes its owned resources. Cleanup detaches the queue consumer, stops/deletes owned Workflow instances and definition, retires/deletes the Worker, deletes the unbound queue/gateway and exact report/bucket, and removes Artifacts/D1. All identities and independent absence checks are recorded. This bounded allocation and launcher deadline are not a provider-wide dollar cap or a global SaaS throughput proof.

Provider contracts: [Queues delivery and acknowledgement](https://developers.cloudflare.com/queues/configuration/javascript-apis/), [Workflows bindings and durable steps](https://developers.cloudflare.com/workflows/build/workers-api/), [R2 conditional writes](https://developers.cloudflare.com/r2/api/workers/workers-api-reference/), [Clef typed decisions](https://developers.cloudflare.com/workers-ai/models/clef/), [AI Gateway request handling](https://developers.cloudflare.com/ai-gateway/configuration/request-handling/).

The [final live evidence receipt](../.tmp/cloudflare-forge/golf-native-20261008-0e80dbdd/ownership.json) passes this bounded pipeline with real Clef usage and all owned resources absent. The [status ledger](IMPLEMENTATION_STATUS.md#native-queued-pr-evidence-2026-10-08-bounded-live-api-qualified) retains earlier failures and the exact source/platform boundaries.

### Existing native installation: repository settings and read performance

Apply the additive native D1 migration `cloudflare/forge/migrations/0006_repository_settings.sql` after the existing migrations, before deploying this adapter. Fresh bootstrap includes it. Description, website and topics use current administrator grants, enrolled workspace/repository identities, an opaque revision and atomic version checks. Topic clearing follows protobuf JSON's omitted-empty-list behavior. Default branch and issue/wiki/PR policies remain operator-managed; the UI offers only the qualified native editors. Unsupported native settings URLs and optional review/file-write controls are capability-gated before mounting, so they do not issue unsupported RPCs. The portable installation retains its existing editors.

Apply `cloudflare/forge/migrations/0007_repository_default_branch.sql` once to existing native D1 installations before deploying the default-branch adapter; fresh schema includes the column. Existing repositories retain `main`. Operator imports must independently verify the imported upstream branch and commit through Git before recording that branch in Golf's repository row and activating its grants. Artifacts import metadata can report `main` even when the imported branch is `master` or `dev`; it must not be used to rename or fabricate an upstream branch. Repository metadata, empty-state detection, default source resolution, default history and settings all use Golf's recorded branch. The settings revision includes it so a concurrent operator branch change invalidates a stale edit. Browser default-branch editing remains unavailable.

During public-repository qualification, the Artifacts import endpoint refused OpenCode with an explicit 40 MB import limit even at depth one; this is separate from the [documented repository/blob storage limits](https://developers.cloudflare.com/artifacts/platform/limits/). A verified bare depth-one Git snapshot was uploaded to a newly created, owned Artifacts repository through its supported Git transport instead. The operator verified the exact upstream commit/tree, blob sizes, remote identity and resulting branch head, revoked all temporary tokens, and activated the native row only after readback. Kubernetes also used this path after import failures. These transfers do not raise Golf's user-facing Git broker bounds or qualify large CI clones. A shallow snapshot remains browsable when its parent object is absent: optional folder change projections are omitted rather than inventing history or failing the source listing. Explicit history/diff operations retain their existing completeness requirements. No upstream workflows are executed during demo import.

The workspace admits up to eight allowlisted reads concurrently. A queued write or revocation waits for admitted reads and fences later admissions; unknown requests, native execution and provider effects retain exclusive dispatch. The in-memory cache contains only full-SHA commits, trees and blobs, scoped to account/namespace/repository, with 128 objects and 4 MiB total bounds. Every private request still checks current Golf authority. Canonical reads validate Artifacts repository identity; previously verified immutable index hits bind the current enrolled provider/repository identity and exact commit without reopening Artifacts. A repository read shard performs its final authorization check through the workspace authority object before returning private data. Mutable refs, credentials and permission observations are never cached there. Directory size reads run in batches of eight; entries changed in the selected head receive a verified head-change projection, while other entries use the bounded existing first-parent history read.

Hashed, generic JS/CSS/font assets can use the browser's private immutable cache. HTML, repository responses, identities and preview assets retain `no-store`; this is not a repository-content or authorization cache. The configured Cloudflare Access policy remains required on network asset requests. Generic immutable assets avoid Golf identity/database work; HTML and private RPCs retain current Golf authority. Old hashes are retained in the private R2 release journal, and unknown hashes return404 rather than HTML. An unavailable Connect activity stream returns a proper end-stream error, and native pages show manual updates without retry loops. A workspace may briefly continue using the previous Worker code after deployment; qualify the live APIs after the rollout settles.

Native README images use the shared `GetRepositoryImage` contract: current repository grants and provider identity, a referenced immutable document, bounded ordinary repository files or approved HTTPS hosts, at most three revalidated redirects, and no forwarded credentials. PNG/JPEG/GIF headers and dimensions are checked; SVGs go through the shared DOMPurify renderer. Vite's logo/sponsor hosts and GitHub workflow badges are supported in both installations. Embedded raster sponsor logos survive SVG sanitization; active content and external SVG references are removed. HTML picture/theme/density variants use the same private image RPC and do not expose external srcset URLs to the browser. Images remain private RPC responses with `no-store`, rather than direct external browser loads.

Returning to a source tab rechecks repository authority in the background while retaining the mounted source and images. Explicit access refreshes still suspend the view, and any denied check removes the private panels. Mounted branch/tag observations are refreshed through navigation, explicit Latest, or invalidation instead of every focus event; choosing a ref still resolves it against current provider state. These changes do not qualify unrestricted large-directory browsing or complete GitHub history imports.

Run `make cloudflare-check`, both frontend builds, and the actual runtime checks:

```sh
node cloudflare/forge/ui-check.mjs "$(command -v cf)"
node cloudflare/forge/runtime-check.mjs "$(command -v cf)"
node cloudflare/forge/repository-rpc-check.mjs "$(command -v cf)"
```

### Commit-bound repository metadata and repeatable releases

Existing native D1 installations apply the additive `0008_repository_indexes.sql` and `0009_repository_index_budget.sql` migrations after0007. Fresh bootstrap includes both. The separate native preparation declares repository read/index Durable Objects. With the private evidence R2 allocation enabled, immutable directory, history and overview indexes persist in D1/R2; without it, metadata still indexes inside the repository Durable Object but does not receive the persistent R2 read cache.

`GetRepositoryOverview` accepts an immutable `ref` and returns its indexed commit, actual root license paths, observed license identifiers, language byte counts and indexing progress. The sidebar polls while indexing rather than calling pending work unavailable. The classifier uses the pinned Linguist filename map, common ambiguous-extension defaults, root `.gitattributes` overrides and generated/vendor/binary exclusions. It does not implement all Linguist content heuristics or nested attribute rules. Root licenses are inspected conservatively; unknown identifiers retain links to the actual files. Symlinks/submodules are not followed or counted as ordinary language blobs.

Metadata work is durable, resumes through alarms, rechecks current identity/grants/provider scope, and stops at a recorded demo deadline. It is bounded to two live jobs per repository shard,100,000 inventoried paths,10-minute jobs and60,000 reserved metadata operations per workspace/day. This operation ceiling is a workload guard, not a total provider billing cap. Immutable blob sizes are reusable; failures and pending statistics never become successful zero-byte indexes. Index payloads are digest-checked and expire after24 hours.

The operator can prime exact canonical default-branch snapshots through supported, read-only Artifacts Git using `python3 scripts/cloudflare_repository_metadata.py INSTALL_DIRECTORY --profile golf --repository NAME`. The tool verifies provider identity and current administrator ownership, uses a short-lived read token, removes temporary clones and revokes the token in `finally`. It does not import GitHub statistics or execute repository code. The hosted reconciler publishes the original private index key from its durable D1 record.

For subsequent releases, build the shared native UI, stage the immutable release and use its guarded deployment wrapper:

```sh
npm --prefix web run build:native
node cloudflare/forge/release.mjs INSTALL_DIRECTORY "$(command -v cf)"
python3 scripts/cloudflare_release.py migrate INSTALL_DIRECTORY --profile golf
python3 scripts/cloudflare_release.py check INSTALL_DIRECTORY --profile golf
python3 scripts/cloudflare_release.py deploy INSTALL_DIRECTORY --profile golf
```

The manifest binds account/workspace/resource/origin identities, source/UI digests and schema14. Older schema10–13 manifests remain readable for their original guarded operations; new releases require the access, invitation, discussion resource and engagement tables, indexes and revision triggers. Deployment retains the previous and current hashed asset bytes in private R2 before dispatch, verifies readback, checks the exact live predecessor and journals its original dispatch. An uncertain response requires provider inspection rather than blind redeployment. `rollback` selects only the recorded predecessor of the exact current release; it never rolls back D1. `promote` reuses the recorded reviewed version after rollback, verifying its module bytes and exact predecessor before dispatch. Both actions journal uncertainty before the provider effect; a lost response fences automatic replay. Confirm `/native/diagnostics` reports the expected release and schema after every transition. Actual staging/canary and quarantine restore qualification remain required; hosted rehearsal evidence is recorded separately in IMPLEMENTATION_STATUS.md. Review [every shared native RPC](CLOUDFLARE_CAPABILITY_INVENTORY.md) before treating frontend parity as backend parity.

### Recovering a disposable demo after supervisor exit

`python3 scripts/cloudflare_demo.py stop OWNERSHIP_RECEIPT` signals the exact original process when it is still running. If it has exited, the command uses `cloudflare_demo_cleanup.py` to validate the private receipt, prepared account/resource identities, purged application journal and bounded owned storage inventories before retiring the owned Worker classes and removing disposable resources. Run `python3 scripts/cloudflare_demo_cleanup.py OWNERSHIP_RECEIPT --check` for a read-only preflight. Recovery refuses changed identities or pending managed application cleanup. Its provider credential is created through the named CLI profile, held only in memory, short-lived and revoked after cleanup. Preserve existing account users, subscriptions and unrelated providers/resources.

The human demo's process-based deadline is not sufficient if that supervisor exits. The current launcher requires an independently confirmed user-systemd timer before reporting awaiting-login/readiness, with thirty minutes for login and the approved four hours after readiness. `begin` also arms a bounded preparation deadline before requesting original preview lease renewal. Inspect `cleanup-recovery.json` and provider absence after the timer fires; a timer being scheduled is not proof that teardown completed. This timer survives the coding process exiting but depends on the operator host remaining available.

The launcher preserves the exact installed CLI/Node path in the timer environment; the user service manager does not inherit an interactive NVM shell. Recovery refuses a missing CLI before provider effects. It records deletion intent, confirms absence, resumes already-removed resources without recreating them, deletes the preview binding before its control Worker, and removes ownership-checked R2 keys after writers retire. Retained release assets and repository indexes are included, and a failed bucket cleanup preserves D1. If D1 is already absent, recovery requires the earlier saved storage inventory. Recovery tokens are recorded by ID, expire after twenty minutes, and are explicitly revoked with readback. Unknown managed app effects or changed identities still require operator reconciliation; this is not complete automatic recovery from every interrupted deletion.


Existing schema13 installations additionally apply reviewed additive
`0014_discussion_engagement.sql` through the release migration helper before
schema14 deployment. It preserves all discussions/resources; activity history is
recorded from this release onward. Native subscriptions deliver to Golf's inbox,
not external email. Reaction/subscription generations reject stale observations,
and all inbox reads filter current repository grants. Historical migration state
and original operation receipts survive deployment and are not database rollback
candidates.

### Repository webhooks on the native path (schema15)

Native installations use the same repository Webhooks editor and five RPCs as
portable Golf. Enable it only after allocating a dedicated Secrets Store secret
containing a base64-encoded random 32-byte encryption key. Never put its value in
`forge.json`, checked-in configuration, logs or API responses. Existing encrypted
subscriptions depend on this key: preserve it through releases and recovery.
Changing it is not a supported bulk key-rotation procedure. Per-subscription
signing keys can be replaced through the editor.

Pass `--webhooks-config /private/webhooks.json` to `cloudflare_forge.py`, or add
this `webhooks` object to an existing installation's private `forge.json` before
building a release:

```json
{
  "origins": ["https://hooks.example.com"],
  "dailyLimit": 100,
  "key": {"store": "YOUR_32_HEX_STORE_ID", "name": "webhook-encryption"}
}
```

The policy requires 1–32 distinct exact public HTTPS origins and 1–5000 daily
attempts across the installation. Only approve receivers whose operator and
network destination you trust. Subscriber input cannot expand the allowlist;
custom ports, URL credentials and redirects are rejected. This native boundary
uses approved origins and normal Worker public egress, not portable Golf's DNS
pinning implementation. Do not attach private-network routing to this delivery
Worker. Setup validates the policy before creating installation files.

Apply `cloudflare_release.py migrate INSTALL_DIRECTORY` before deploying schema15.
Migration0015 only adds subscription/outbox/budget/maintenance tables, indexes and
four event triggers. Existing repositories, receipts and the older maintenance
journal survive. Interrupted migrations recheck the required objects; changed
recorded migration digests refuse automatic replay. A missing key/policy keeps
the native editor unavailable; it does not call the portable server.

Repository administrators create named subscriptions, choose source/issues/pulls/
actions topics and explicitly authorize background delivery. Endpoint paths,
query strings and signing keys are AES-GCM encrypted with repository,
subscription and credential-version binding. Inventory exposes only the host.
Disabling an existing subscription works when its key binding is temporarily
unreadable. Enabled delivery rechecks the sponsoring administrator's current
identity and grant generation; removing/regranting access does not silently
reactivate old authorization.

Source confirmation, discussion changes and native test transitions append small
`golf.webhook.v1` change notifications in the mutation transaction. Actions
notifications currently cover native test jobs, not all portable Actions runs.
They carry identifiers/topics rather than private source or discussion bodies.
Read the current authorized API state when detailed data is needed. This starts
with new events after installation; existing history is not backfilled.

Slack incoming webhooks refuse any body without their own message fields. When
`https://hooks.slack.com` is an approved origin, deliveries to that host carry a
one-line `text` summary instead of the `golf.webhook.v1` document: what changed,
the repository's name and a link to the matching page. That discloses the
repository name to the Slack workspace; nothing else is added. The signature
headers are still sent and cover the body as delivered. Every other destination
receives the unchanged Golf payload. Portable Golf has no such adapter.

Delivery runs after mutations and on the existing maintenance schedule (one minute
is installed when no schedule exists). D1 leases coordinate parallel drains;
work is limited to eight deliveries per drain, six attempts per delivery, ten
seconds per request and bounded exponential backoff. HTTP429/5xx and uncertain
transport failures retry. The daily attempt budget reserves conservatively,
including a claim that subsequently loses a race. Operations exposes queued
count, oldest age, failures and the maintenance journal.

Verify `X-Golf-Signature-256` as `sha256=` plus lowercase HMAC-SHA256 over
`timestamp + "\n" + eventID + "\n" + exactBody`, using `X-Golf-Timestamp` and
`X-Golf-Event-ID`. Enforce a timestamp tolerance and deduplicate event IDs at the
receiver. Retries keep the delivery/event IDs; explicit redelivery creates a new
delivery ID for the same event. Delivery is at least once: loss of a response can
mean the receiver already accepted it. The UI marks possible duplicates and
never reads back secrets or response bodies. Authorization is checked immediately
before sending; already transmitted bytes cannot be recalled.

Delivery receipts are retained in D1, including idempotency records. There is no
automatic receipt pruning or infinite-scale retention claim yet. Keep testing
within the approved event/attempt envelope; add a reviewed archive/tombstone
policy before sustained high-volume use. Email notifications remain separately
disabled on the native path.

### Repository rules on the native path (schema16)

The shared **Settings → Rules and merge policy** page supports native branch
locks and tag account restrictions. Apply the additive
`0016_repository_rules.sql` migration through
`python3 scripts/cloudflare_release.py migrate INSTALL_DIRECTORY` before releasing
schema16; new installations receive the same tables from `schema.sql`. Complete
the Worker/workspace rollout before opening rule administration or Git traffic;
older code does not enforce these policies. The release helper refuses rollback
to an unknown or pre-schema16 predecessor and verifies the recorded compatible
predecessor bytes. Use a compatible fix forward for the initial upgrade. The
migration preserves existing Git, grants and receipts. No additional provider
service or secret is required. Administration requires an Access-authenticated,
enrolled Golf account with current repository administration; service tokens and
Git bearer credentials cannot edit rules.

- A branch lock denies creation, update (including force pushes), and deletion of
  matching branches for every writer, including administrators. An administrator
  can explicitly remove the lock in settings. This is a freeze, not a reviewed-PR
  merge policy.
- A tag rule allows matching writes only by its selected enrolled accounts. An
  empty list locks the matching tags. Every matching rule must allow the writer;
  overlapping rules do not grant additional access. Normal repository write
  permission is still required. Account IDs bind the allowlist, so a reused login
  name does not inherit the original account's authorization.
- Patterns are literal names or one trailing `*` prefix: `main`, `release/*`,
  `v*`, or `*`. General glob/regex patterns and teams are rejected. Inventories are
  bounded at 100 branch rules, 100 tag rules and 100 accounts per tag rule.

Each edit uses current access and rules revisions plus one original UUID. D1
commits the policy and original receipt in one transaction. Inspect or retry the
same original request after an uncertain response; replay returns the historical
receipt and never reapplies an old policy. An unresolved Git write prevents rule
edits. Git admission rechecks the policy generation, repository access, identity
and credential before reserving a canonical write, then forwards only allowed
commands to Artifacts. Denied commands create no provider effect or Git operation.

The boundary covers Golf's canonical Git broker, with its existing single-ref,
SHA-1 and 8-MiB push bounds. It does not install provider-side Artifacts rules:
keep direct write credentials operator-only. Protected PR merge, trusted
review/check requirements, signing, fast-forward-only policy and exceptions are
not implemented by this increment and are unavailable in the native editor.
Portable Gitea retains its existing settings behavior. Rule receipts have no
automatic retention/pruning yet; preserve them with the D1 authority during
backup and recovery. Hosted schema16 qualification remains pending; the prior
four-hour demo was removed, not extended.

### Repository Git credentials on the native path (schema17)

**Settings → Git credentials** now uses the shared transport/creation/inventory/
revocation UI. Apply `python3 scripts/cloudflare_release.py migrate INSTALL_DIRECTORY`
before deploying schema17. Migration0017 adds a separate Golf D1 credential table
and inventory index; existing operator credentials, Git objects and rules are
preserved. Fresh installs include the same schema. A rollback to schema16 retains
the table but makes these new credentials unavailable; the older actor rejects
their distinct token prefix rather than treating them as operator credentials.

A human signed in through Access can create credentials for their own account:
read for any current repository reader, or write for a current writer/admin.
Choose a name and a 5–60 minute lifetime. Only the initial response contains the
secret. Save it in your Git credential manager with username `golf`; use the
credential as the password and the displayed `/git/WORKSPACE/REPOSITORY.git`
clone address. Do not put secrets in the remote URL, logs or shell history.
The broker accepts HTTP Basic and Bearer transport for these credentials, but
only on the exact repository's Git routes. They cannot call application RPCs,
create more credentials, access another repository or become Artifacts tokens.

Cloudflare Access remains the outer gate. Git clients must separately satisfy
an approved Access session or machine-admission policy. Creating a Golf Git
credential does not create an Access service token or bypass the Access app;
this increment does not modify that account policy. Credential administration
rejects machine/service-token callers. The shared setup path remains HTTPS-only;
SSH/deploy keys are separate and unavailable on native.

Native credentials bind to immutable Golf account and repository identities and
their current identity/grant generations. Disabling the account, changing its
repository grant, replacing canonical repository identity, explicit revocation
or expiry denies subsequent Git requests. Restoring the old grant or re-enabling
the account does not restore these credentials. Access browser sign-out by itself
**does not revoke them**: revoke them in Git settings when finished, or let their
short lifetime expire. The API identifies this binding explicitly instead of
inventing a browser session ID; portable Golf keeps its source-session semantics.

Write credentials obey the current branch locks and tag restrictions. Admission
checks credential authority again inside canonical write reservation, and read
responses check it again before release. An already accepted push is not undone
by later revocation. Existing single-ref SHA-1/8-MiB limits and unresolved-write
fencing still apply. The receive-outcome RPC and protected PR publication remain
unimplemented on native.

At most 100 unrevoked, unexpired credentials may exist per account in this workspace.
Lists expose only own-account metadata, bounded/paginated within the selected
repository. After a lost creation response, refresh the list and revoke the
original credential before replacing it: secrets cannot be recovered and creation
is not automatically retried. Revocation is idempotent against the original ID.
Expired/revoked metadata is retained without automatic pruning in this increment.

Local evidence includes an actual Git client answering the Basic challenge and
running `ls-remote` against the fixture broker, plus actual workerd/Access/D1
credential issuance/revocation and blocked writes. This is not a new hosted
Artifacts clone/push qualification. The previous hosted installation is removed;
recreate a separately bounded environment for that acceptance gate.


### Review collaboration and default branch (schema18)

Run the guarded additive migration/release path before serving schema18. Migration
0018 adds review assignments, draft/lifecycle state and original-operation receipts.
No extra provider subscription or binding is required. The shared PR page exposes
review requests, pending overall summaries and administrative dismissal/restoration;
inline/saved-diff authoring and protected merge remain unavailable.

Review management uses verified human Access identity and current Golf repository
authority. Repository Git credentials and operator bearer tokens cannot impersonate
these human decisions. Draft summaries are private to their author; source changes
block submission while allowing discard. A request alerts its recipient through
the in-app inbox and is completed by their published review. Teams and automatic
CODEOWNERS requests remain separate. CODEOWNERS suggestions inspect at most16KiB,
200 supported rules and256 changed files; unsupported input is reported, not used
as protected-merge policy.

General now accepts an existing default branch. Its current Artifacts ref is
verified before the atomic Golf settings update. Clients using Golf's Git URL see
that branch as advertised HEAD. Direct provider URL/default-branch metadata is not
changed; ordinary users should continue using the Golf URL and scoped credentials.
Feature switches, visibility and other repository lifecycle controls remain open.

Do not roll schema18 back to earlier code: older review lists do not understand
private drafts. The release tool refuses that downgrade and verifies compatible
predecessor bytes. Use a compatible fix forward when no schema18 predecessor exists.
The previous demo is still removed; these changes have local source/browser/Git/
workerd/D1/Access evidence, with hosted acceptance pending.

Local review runtime check (uses fixture Artifacts reads, actual workerd/D1):

```sh
node cloudflare/forge/review-runtime-check.mjs "$(command -v cf)"
```

### Native pull request merge, first slice (schema24)

Apply additive migration 0024 before serving schema24: every pull request read
joins `pull_merge_operations`. The Python/`cf` release path applies and verifies
it, including both partial unique indexes; on the Alchemy path run
`cloudflare_alchemy_demo.py migrate DIRECTORY` before `deploy`. `pull.merge`
then reports ready.

The slice merges a same-repository pull request with a merge commit only when
the base branch tip is already contained in the head branch. The merge commit
then has the head's tree and parents `[base tip, head tip]`; no tree merge is
computed. The Worker builds that one commit, sends it as a one-object pack
through the same single-ref reservation, Git rules and `git_operations` journal
as a brokered push, and confirms it by reading the branch and the commit back.
Author and committer are the acting account's display name with
`<login>@users.noreply.<public host>`. Commit title and message are bound in the
request fingerprint and written into the commit; D1 does not store them.

Squash, rebase, a base with commits the head lacks, fork sources, drafts, closed
or changed pull requests and locked targets are recorded as `REJECTED` /
`preflight_refused` with a plain `detail` in `pull_merge_operations`, and nothing
is sent. The merge observation names the same reason before a request is made.
Protected merge, review/check requirements and CODEOWNERS policy are not part of
this slice. A merge does not start automatic PR tests; its journal row is
recorded with `ci_state` `NONE`.

Any failure after the reservation is `DISPATCH_UNKNOWN`: the operation, its pull
request and the repository's `write_pending` fence stay as they are, exactly like
an unconfirmed push. Inspecting the original operation settles it only when the
branch names the dispatched commit and that commit reads back with the expected
parents. The pack is never sent again and there is no automatic conclusion that
a write did not land; that case needs the same operator reconciliation as an
unconfirmed push, and must also resolve the `pull_merge_operations` row.

Local source tests feed the generated pack to real Git, and this check runs the
whole merge in actual workerd/D1 against a real local repository (the Artifacts
binding is a fixture). Cloudflare Artifacts accepting this pack is not proven
until a hosted merge is observed; probe it on a scratch repository first.

```sh
node cloudflare/forge/merge-runtime-check.mjs "$(command -v cf)"
```

### Native runners and stock GitLab Runner (schema20)

Fresh installations include native runner tables and the GitLab coordinator job
ledger in `schema.sql`. Existing native D1 installations must apply additive
`0019_native_runners.sql` and then `0020_gitlab_runner.sql` before serving the
schema20 Worker. Use the guarded `scripts/cloudflare_release.py migrate`, `check`,
and `deploy` sequence. The migration records source digests and checks tables,
columns and indexes after a lost acknowledgement. A rollback to code below the
active runner schema is refused because it would abandon leased jobs. Stock
GitLab Runner registration and the pinned Actions/BuildKit host setup are in
`cmd/golf-native-runner/README.md`; hosted execution remains to be qualified.

### Unattended hosted qualification

Use `--unattended` with the existing populated-demo command and omit
`--demo-email`. For the authorized test account/hostnames:

```sh
python3 scripts/cloudflare-forge-smoke.py \
  --profile golf --account-id 530bd01e3d3b298bac1f172ec1868f5a \
  --workers-subdomain mikejohnsonit \
  --evidence --evidence-ai --container-tests --agents --delivery --apps \
  --app-zone 8804ea6a239cf8a1cd0994d1624f3939 \
  --app-host previews.mjtechguy.com --demo-host gitgolf.mjtechguy.com \
  --unattended --operations-rehearsal
```

This creates fresh owned resources and refuses occupied hostnames. Access admits
only the run's temporary service token; Golf separately requires its scoped test
credentials. No email provider or human login is created. The supervisor arms an
independent 45-minute host cleanup timer before allocating resources, continues
through negative tests, and removes owned resources when finished. The operator
host and provider credentials must remain available for cleanup. The existing
human demo's four-hour begin workflow is unchanged.

A private `qualification-auth.json` is written after the initial service session
is verified and removed on exit. The runner offers a maximum 120-second browser
inspection window after API/release checks. Creating an
`unattended.continue` file in that same owned installation ends this window early.
It must never be copied into a URL, frontend bundle, Git config or public log.
A deadline-bound, authenticated private test proxy can inject these credentials
for the shared browser without exposing them to frontend JavaScript. The October11
check used the host's private Tailscale interface and a short-lived HttpOnly entry
cookie. Its browser-facing HTTP transport does not qualify secure-context features
or human Access cookies, and does not make service credentials human.

`cloudflare_hosted_check.py` checks the exact schema, CODEOWNERS from actual
Artifacts, default-branch/Git HEAD consistency, stale revisions and warm metadata
reads. Explicit disposable D1 fixtures test branch-lock enforcement, repository
Git credential scope/revocation, and private/discarded review visibility. Human-only
Rules, credential-management, review-authoring and review-administration procedures
must reject service credentials. These denial/fixture tests do not establish
hosted positive human mutation coverage; the real local workerd/D1 tests cover
those workflows separately.

The release rehearsal first deploys a journaled baseline with a harmless
HTML comment, verifies rollback to the unrecorded predecessor is refused, then
deploys the original built frontend. It checks every served retained asset,
rolls back to the compatible recorded baseline, and promotes the reviewed release
again. Readiness requires the edge `X-Golf-Worker-Release` header and workspace
diagnostics to agree; a deployment API acknowledgment alone is insufficient.
Each convergence wait is bounded at six minutes within the overall cleanup
deadline. Unattended runs do not renew previews for four hours. Inspect each cleanup
result in the private ownership receipt; a successful deployment alone is not a
successful qualification or teardown.
