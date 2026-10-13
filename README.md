# Golf

New Cloudflare demos use the [managed container image registry](docs/CLOUDFLARE_MANAGED_REGISTRY.md),
with Golf-scoped CI publishing and digest-verified image inventories.
The [repeatable demo recipe](deploy/demo/README.md) provisions `mj`, two organizations,
pinned GitHub repositories, hosted CI and registry artifacts.

Forgejo is the default Git backend for new portable installs. See [Forgejo setup](docs/FORGEJO_SETUP.md).

Golf is an agent-ready Git and developer-workflow platform with two infrastructure tracks:

- **Cloudflare-focused:** first-class Workers, Artifacts and useful Cloudflare integrations for execution, storage, previews, delivery, email and operations.
- **Self-hosted:** Docker Compose and Kubernetes without a Cloudflare requirement. Operators can mix local/other providers with individual optional Cloudflare backends.

These are infrastructure choices, not editions. AI is optional in Golf's core workflows. The Cloudflare competition demonstration separately requires real concurrent agents, Workers and Artifacts. The portable Forgejo/Go/PostgreSQL core is an origin-backed bridge toward the selected Cloudflare-native managed SaaS destination; portable hosting remains independent. Cloudflare-native Golf keeps its separate Artifacts/D1/Workers Git backend.

## What works now

Golf is a developer preview with a custom Golf UI, black/charcoal and light themes, local email-or-username/password sign-in, optional browser OAuth, and PostgreSQL-backed sessions that survive backend restarts. The browser receives an opaque HttpOnly cookie; upstream credentials stay encrypted on the server. Repository work includes exact source/history/diff browsing, issues, PRs, human reviews and saved private inline-review drafts/publication, alongside scoped JSON CLI and stdio MCP interfaces. Explicit repository grants enable collaboration/source writes and Actions/private-task inspection; see [machine delegation](docs/SCOPED_COLLABORATION_DELEGATION.md).

Actions supports bounded manual workflows and explicitly configured automatic push CI, with granular execution policies, durable attempts and enrolled Docker workers. Managed coding-agent connections support qualified, bounded task and PR-review flows; optional workers perform real signed HTTP webhook delivery and verified-mailbox SMTP notices. These capabilities require their own configuration and consent. See the [implementation ledger](docs/IMPLEMENTATION_STATUS.md) for exact source/runtime evidence and remaining gates; saved configuration alone is not an operational integration.

Source ahead of the retained installation adds encrypted Cloudflare account profiles and an explicit operator D1/R2 storage allocation in repository environments. Real provider create/replay/readback/owned cleanup and controlled-native browser checks pass. This allocates empty storage. Migration094 adds a separate [operator-configured protected static preview](docs/CLOUDFLARE_FOUNDATION_CONTRACT.md#operator-configured-protected-static-preview) with Golf/Access sign-in and current reader checks. Actual Access email-code sign-in, immutable content/D1/R2 reads and repository revocation pass using an explicitly mapped existing reviewer seat; temporary resources are removed. Automatic PR delivery and tenant-authorized agents remain open. Run `make qualify-cloudflare-product` for disposable database-backed checks; see the [operator contract](docs/CLOUDFLARE_FOUNDATION_CONTRACT.md#product-account-profiles-and-operator-storage) for bounded live/browser modes and teardown.

The opt-in [public Node24 Actions profile](docs/ACTIONS_REMOTE.md) now passes the unchanged pinned Requests lint workflow through an actual private native repository and signed push, including genuine checkout/setup-python and dependency downloads. [Qualification evidence](docs/compatibility/evidence/requests-local.json) also covers failed commands, denied/direct egress, timeout, running cancellation and cleanup. This profile is implemented and locally qualified; the retained development installation has not been upgraded. PR/fork execution and wider compatibility remain open.

Full GitHub Actions/GitLab compatibility, all coding harnesses and interactive agent conversations, protected merge/write enforcement, automated imports, protected previews/production CD, Cloudflare deployment integrations, production scale and latest-schema disaster recovery remain open. This is not complete v1 or a competition-ready entry. No repository CI workflows are configured in this source repository.

Manage Git SSH access under **Your account → User settings → SSH keys**. Add the public `.pub` file from your machine, then use the repository's SSH clone URL. Account keys follow your repository permissions and stay active until removed. Golf passwords and read-only Golf API credentials are not direct HTTP Git credentials. See the [Git access contract](docs/GIT_ACCESS_CONTRACT.md); `make qualify-git` runs the current real Git/API/CLI/browser acceptance checks against the local Compose stack.

Navigation is contextual: the compact header has an on-demand personal/organization switcher and repository/organization links. Repository pages keep their work tabs; account, repository and global administration show a local settings sidebar only within that task. Personal sessions, SSH/API credentials and activity live under **Your account → User settings**. **System status** is separate from repository work. The repository ownership filter searches the loaded accessible rows for repositories owned by your account.

Settings use contextual personal, organization, repository and instance pages with current inventories and explicit Add/Edit actions. Own password and login-alias changes confirm the current password and revoke local sessions; a login alias does not verify mailbox ownership. Explicitly enrolled Golf instance administrators manage ordinary local accounts and infrastructure/worker controls. Qualified repository owners/direct administrators manage bounded collaborator, existing-account invitation, team association and deploy-key controls; an instance role never overrides repository authority. Broader settings sections remain Partial. See the [account security](docs/ACCOUNT_SECURITY_CONTRACT.md), [repository settings](docs/REPOSITORY_SETTINGS_CONTRACT.md), [repository access](docs/REPOSITORY_ACCESS_CONTRACT.md) and [invitation](docs/REPOSITORY_INVITATION_CONTRACT.md) contracts, with current qualification in the ledger.

Pinned public GitHub/GitLab examples passed actual source/history/CLI/private-clone qualification. That source-transfer qualification preserves workflow files without executing them and is not a product importer. **Repository settings → Workflow configuration** performs bounded, commit-pinned inspection of direct `*.yml`/`*.yaml` in the first existing Forgejo workflow directory (default `.forgejo/workflows`, then `.github/workflows`), plus root `.gitlab-ci.yml`, verifies exact blob bytes and reports unsupported features. Execution is a separate explicit action under the supported catalog and policies; inspection is not full compatibility. See the [workflow inspection contract](docs/WORKFLOW_CONFIGURATION_CONTRACT.md), [versioned compatibility register and evidence](docs/compatibility/README.md), and [public repository qualification](docs/PUBLIC_REPOSITORY_QUALIFICATION.md).

## Run locally

For the independent Cloudflare migration-bridge installation, use [Cloudflare setup](docs/CLOUDFLARE_SETUP.md). It has separate configuration/volumes, a Workers frontend and protected origin/R2 wiring. Canonical Artifacts Git and the native forge are still implementation gates; this setup is not the completed Cloudflare-native SaaS.

Requires Docker with Compose, Git and OpenSSL. Node and Go are needed only for development outside the container.

```sh
git clone git@github.com:mjtechguy/golf-git.git
cd golf-git
./scripts/init-env.sh
docker compose up -d --build
curl --fail http://localhost:8080/readyz
```

Open **http://localhost:8080** for Golf and **http://localhost:3001** for Forgejo. Use `localhost` consistently: all RPC calls check the exact configured origin. Readiness returns 503 until PostgreSQL and Forgejo are ready; retry after first startup.

Registration is disabled. Create your local account with Forgejo's supported command (replace the example identity):

```sh
docker compose exec forgejo forgejo --config /var/lib/gitea/custom/conf/app.ini admin user create \
  --username golf-owner --email owner@example.com --admin \
  --random-password --must-change-password=false
```

Store the printed **native Forgejo** password securely. Sign into Forgejo and create a dedicated scoped token under **Settings → Applications**, using the scopes below. This is the forge identity/credential setup; it is not your Golf password.

Enroll the corresponding **Golf account** with the server operator command. Create a private, ignored JSON file through your editor or secret manager; never put real credentials in shell arguments or committed examples. Its exact create shape is:

```json
{
  "username": "golf-owner",
  "email": "owner@example.com",
  "password": "REPLACE_WITH_A_UNIQUE_GOLF_PASSWORD",
  "forge_token": "REPLACE_WITH_THIS_USERS_SCOPED_FORGEJO_TOKEN",
  "is_instance_admin": true
}
```

Use a unique password of at least 15 characters. Restrict the input file to mode0600, then pipe it to the container:

```sh
docker compose exec -T golf golf local-account create < .tmp/local-account/enrollment.json
```

Open Golf and sign in with **Email or username** and **Password**. Golf hashes its own password and keeps the mapped forge token encrypted on the server; the Golf password is never sent to Forgejo. Local administrator enrollment records a Golf instance role; the admin portal offers ordinary local-account lifecycle and organization-creation/execution policies. Public registration is unavailable. Operators can explicitly reset, disable or re-enable accounts; see [local authentication](docs/LOCAL_AUTHENTICATION.md). Individual users need their own mapping and scopes; never share an administrator token across users. Bearer credentials remain available for API tooling, and OAuth is optional.

Open **Your account → User settings → Sessions** to list your active Golf sessions and revoke one, the current session, or all other sessions. Confirmation is required. Revocation removes Golf access on subsequent requests; provider PATs, OAuth consent and Git credentials remain separately managed. Settings and sessions use full pages; revocations require a confirmation dialog. See [session management](docs/SESSION_MANAGEMENT.md).

Open **Account activity** to inspect your recorded successful sign-ins, sign-outs and session revocations/replacements. Load more retains one history snapshot; Refresh starts a new one. Reads require only `read:user`. History starts with recording, has no invented pre-migration events, and excludes automatic expiry cleanup, OAuth refresh and failed attempts. See the [account audit contract](docs/ACCOUNT_AUDIT_CONTRACT.md) for event, migration and operator limits.

### Optional browser OAuth

Register a **confidential** OAuth application in Forgejo Settings → Applications with the exact callback `http://localhost:8080/auth/forgejo/callback` (use your Golf HTTPS origin remotely). Leave consent enabled. Save its client secret in ignored `.env` or an operator-managed secret source and set all three variables:

```dotenv
GOLF_FORGE_PUBLIC_URL=http://localhost:3001
GOLF_FORGE_OAUTH_CLIENT_ID=your-registered-client-id
GOLF_FORGE_OAUTH_CLIENT_SECRET=your-registered-client-secret
```

Run `docker compose up -d golf` to apply the configuration. Golf then offers **Continue with Forgejo**; login and consent occur at your configured forge. Golf requests `write:user`, `write:repository`, `write:issue`, `write:organization`, `read:package` and `write:notification`, including broader upstream repository/user write authority for repository creation. Use a restricted personal token when read-only access is desired. The browser receives only a Golf session cookie; access and refresh credentials remain encrypted on the server. OAuth configuration is optional, not a Cloudflare requirement.

The fixed callback uses single-use ten-minute state, a separate HttpOnly browser binding and S256 PKCE. Sessions retain their absolute twelve-hour expiry despite access-token refresh. Logout removes the Golf session; manage provider consent in Forgejo. This is Forgejo OAuth, not complete self-service account management or external OIDC, organization policy or CLI OAuth login. See [ADR 0003](docs/decisions/0003-gitea-oauth-and-session-refresh.md).

**Token scopes for the pinned Forgejo profile:** use `read:user` plus `read:repository` to sign in and browse. Creating repositories additionally requires `write:user` plus `write:repository` (write includes read). Forgejo applies both user and repository scopes to its `/user/repos` route; Golf preserves that authorization. Read-only tokens can browse but creation is rejected; explicit-key requests return recorded rejection evidence, while legacy unkeyed calls retain permission errors.

Add `read:organization` to browse your organizations and provider-visible teams; this scope does not grant membership. For an existing OAuth grant without it, revoke Golf’s grant in Forgejo **Settings → Applications**, then sign in through Golf and approve the new scopes. Signing in again alone can reuse the narrower grant. Add `read:issue` to browse issues. Code browsing continues to work without issue scope; the issue panel reports the missing permission. Scopes never grant repository access the user does not already have.

The browser receives an opaque HttpOnly session cookie, not the upstream credential. The server stores only the session identifier's hash and an AES-GCM-encrypted Forgejo token. Sessions persist across backend restarts and expire after 12 hours. HTTPS uses a host-only `__Host-golf_session` cookie with Secure, HttpOnly and SameSite=Lax; loopback development uses `golf_session`. Password reset/disable invalidates local-password sessions; saved cookies and their delegated API credentials then fail. Token revocation is enforced by Forgejo on subsequent calls. Local insecure cookies are explicitly allowed only on loopback origins; remote use requires HTTPS and secure cookies.

Secrets are generated once into ignored `.env`. Keep that file and all configured encryption keys secure. The original `GOLF_ENCRYPTION_KEY` remains supported as the `legacy` key; do not replace its bytes under the same label. The database initializes two independent databases/roles, one for Golf and one for Forgejo. Changing `.env` passwords later does not rotate existing PostgreSQL roles. Do not delete `.env` while retaining volumes and expect a fresh credential set to work.

```sh
docker compose stop      # stop; retain all data
docker compose start     # resume
docker compose down      # remove containers/network; retain named volumes
```

Do not add `--volumes` unless intentionally erasing this installation. Preserve both databases, Forgejo repository/configuration volumes and encryption keys together. A Forgejo backup and restore drill remains open. Local ports bind only to loopback; this Compose file is a development installation.

## Credential key operations

The [keyring contract](docs/CREDENTIAL_KEYRING.md) documents `GOLF_ENCRYPTION_KEYS` (a JSON map of labels to base64 32-byte keys) and `GOLF_ACTIVE_ENCRYPTION_KEY`, alongside the compatible single-key variable. Registered labels are permanently bound to their material. Every stored session, pending OAuth verifier and persistent local-account forge credential must retain its read key, including expired records and disabled accounts.

Operator commands live in the server binary, separately from the scoped user CLI. Supply the Golf database/key environment securely, then use `./bin/golf-server keys status`, `keys activate`, `keys rotate --batch-size 100 --max-batches 10`, or `keys retirement-check --key-id legacy`. The container equivalent is `docker compose run --rm --no-deps golf keys status` with an already-built image and available database. Even status can apply migrations and register legacy metadata; partial rotation can exit zero, so inspect its JSON state/counts.

Before activation, drain all old Golf writers and in-flight OAuth exchanges. Database fencing cannot reverse an issuer's completed refresh, and transparent rolling cutover is not supported. Retirement requires zero uses across all three credential families and does not erase secrets or old backup keys. Targeted database and old-binary PAT/pending-verifier checks pass; live OAuth exchange across activation and wider rollout/recovery qualification remain open. This does not complete P1.3 or add KMS/age/FIPS support.

## Offline backup and quarantined restore

The historical [recovery guide](docs/RECOVERY.md) and `scripts/recovery.py` target the retired Gitea installation and do not qualify Forgejo backups or restore. For a new Forgejo installation, preserve `.env`, PostgreSQL data and Forgejo data together. A verified Forgejo restore drill is still required before production use.

## Run on Kubernetes

The [Helm chart](deploy/helm/golf/README.md) installs the same core with existing Secret references, persistent volumes, probes, resource/security bounds and native ingress/network policies. It supports external PostgreSQL and the pinned Forgejo profile. Supply an explicitly built Golf image; no public release image is available yet. Cloudflare and AI are optional.

The [Kubernetes guide](docs/KUBERNETES.md) contains historical Gitea qualification. Forgejo Helm rendering and validation pass, but a live Kubernetes rollout and restore trial are still open. Workers/runners and object-storage adapters are not installed by this chart.

## Browse code, issues and pull requests

Open a repository in Golf to explore its branches, commit history and source tree. File/folder navigation stays at an exact commit, so a concurrent push cannot silently change the snapshot you are inspecting. Refresh or select a branch again to observe a new head. The commit view can open historical snapshots. Empty repositories display push guidance; after the first push, Forgejo may need a moment to finish processing before refresh shows the source.

Files are rendered as plain text up to 256 KiB. Binary/control content, large files, symlinks, submodules and LFS objects show metadata and an explanation instead. Golf does not execute source HTML, follow source links or fetch submodule targets. Directories above 1,000 entries or upstream responses above 2 MiB fail visibly; this preview does not claim unlimited monorepo browsing.

The Issues tab lists open/closed issues and reads issue bodies as plain text. Issue editing, comments, rendered Markdown, PR comparisons, blame and review submission remain future work. Forgejo remains the sole source of collaboration data. See the [browser contract](docs/REPOSITORY_BROWSER_CONTRACT.md) for procedures and bounds.

In **Commits**, choose **View diff** to inspect an exact object and its first-parent comparison (or root output). Merge diffs show only the first parent. Native text is limited to 512 KiB and stays plain text; binary notices and root commit metadata, including author email, remain as supplied by Forgejo. Oversized/invalid text fails visibly. **Browse this commit** opens that object’s source. This is unparsed provider output, not independently verified patch completeness or merge readiness. See the [commit-diff contract](docs/COMMIT_DIFF_CONTRACT.md).

The **Pull requests** tab lists open/closed/all PRs and opens plain-text detail with native Forgejo reviews. List heads are labeled retained snapshots; detail refs are provider observations or explicit retained fallbacks. These labels, native merge records and review flags do not establish a live source branch, Golf approval eligibility or merge readiness. Pagination can advance from an empty review page because the provider filters hidden pending reviews after counting. PR and review reads require `read:user` plus `read:repository`, without issue scope. See the [PR read contract](docs/PULL_REQUEST_READ_CONTRACT.md).

## Durable repository creation

The browser gives each creation request a stable key, immediately blocks duplicate submission events, and freezes its submitted details. It retains only the key, name and visibility in tab session storage scoped by browser origin and native Forgejo user ID. Unresolved requests remain available for status inspection after closing the dialog or reloading the tab; they are never automatically recreated. Golf commits the operation before the native POST and never dispatches a repeated account/key again. A known rejection permits an explicit new request.

The API adds optional `CreateRepository.idempotency_key` (a canonical lowercase UUID v4) and `GetRepositoryCreation`. Keyed responses carry explicit `SUCCEEDED`, `REJECTED` or `OUTCOME_UNKNOWN` evidence; HTTP 200 alone does not mean creation succeeded. Reusing a key with changed inputs fails. Current native access and repository ID are checked before returning repository metadata. Unkeyed callers retain legacy error behavior, with no deduplication across separate invocations. See [the operation contract](docs/REPOSITORY_CREATION_CONTRACT.md) for scope, ambiguity, storage and verification boundaries. Native success/rejection/restart, real browser acknowledgment loss and counted Forgejo-response-loss checks pass; the latter stays unknown after retries and restart with exactly one observed provider POST. This is not a general outbox/job engine or exactly-once provider contract.

## Read-only CLI

Requires the Go version in `go.mod`. `make cli` produces `bin/golf`; `make build` additionally produces the server as `bin/golf-server`.

```sh
make cli
./bin/golf --help
# Supply GOLF_FORGE_TOKEN through your shell's secret manager, not a literal in history.
./bin/golf repo list
./bin/golf repo view owner/repository
./bin/golf repo overview owner/repository
./bin/golf repo creation 12345678-1234-4234-8234-123456789abc
./bin/golf repo branches owner/repository
./bin/golf repo commits owner/repository --ref feature/example
./bin/golf repo contents owner/repository --ref COMMIT_ID --path README.md
./bin/golf repo contents owner/repository --ref v1.2 --ref-kind tag --path README.md
./bin/golf commit diff owner/repository FULL_LOWERCASE_COMMIT_SHA
./bin/golf issue list owner/repository --state open
./bin/golf issue view owner/repository 1
./bin/golf pr list owner/repository --state all --page 1 --limit 20
./bin/golf pr view owner/repository 12
./bin/golf pr reviews owner/repository 12 --page 1 --limit 20
./bin/golf org list --limit 20
./bin/golf org view ORGANIZATION
./bin/golf org teams ORGANIZATION
./bin/golf team view ORGANIZATION TEAM_ID
./bin/golf team members ORGANIZATION TEAM_ID
./bin/golf team repos ORGANIZATION TEAM_ID --page 1 --limit 20
./bin/golf audit list --limit 20
```

Alternatively pipe one token from your secret manager to `./bin/golf --token-stdin repo list`. For owner-issued read-only Golf credentials, set `GOLF_API_TOKEN` or use `--api-token-stdin`. API and Forgejo token sources cannot be mixed. Secrets are never accepted as command-line arguments. Set `GOLF_URL` or global `--url` for another installation; remote origins require HTTPS. The CLI does not follow redirects or save credentials/cookies. Forgejo PAT mode creates and deletes a temporary Golf session per command, including after an operation fails. Golf API credential mode delegates the issuing browser session without login/logout or a cookie jar; ending that session invalidates the credential. See the [API credential contract](docs/API_CREDENTIAL_CONTRACT.md). Abrupt termination can leave that session until its normal server expiry.

`repo overview` returns current authorized About metadata, topics, website, optional counts, and explicitly available/unavailable/error language and license indexes. It validates the native repository ID and canonical key; indexes are not bound to a selected commit and website links are never fetched.

`repo contents` resolves current repository identity and a typed source selection before reading the exact commit/path. Omitted `--ref` selects the default branch; a bare full lowercase SHA selects a commit; other bare names select branches only. Use `--ref-kind tag` for tags or `--ref-kind branch` for a SHA-looking branch name. There is no namespace fallback. Successful source output includes the validated `repositoryId`, `commitId` and literal `path`. See the [source URL design](docs/READABLE_SOURCE_URL_DESIGN.md) and [qualification ledger](docs/IMPLEMENTATION_STATUS.md) for implementation/runtime scope.

`commit diff` requires an exact lowercase 40- or 64-character hexadecimal SHA, accepts no branch/revision expressions or pagination, and returns JSON-escaped `data.rawDiff` plus commit/parent/base metadata and numeric `data.byteSize`. It uses the same `read:user,read:repository` scopes as source browsing; syntax acceptance does not qualify every forge object format.

`repo creation` inspects your existing request key through the same scoped API. It only reads operation evidence, never creates/retries a repository. A successful historical record can lack repository metadata after access loss, rename, deletion or replacement. `OUTCOME_UNKNOWN` may include work still in flight.

PR/review commands require `read:user` and `read:repository`; review flags remain provider observations. Organization/team commands require `read:user` and `read:organization`; repository source separately requires `read:repository`. Team IDs are canonical positive decimal strings, obtained from `org teams`. Empty collection pages can still have a `nextPage`.

Account activity uses a separate keyset contract: `audit list --limit 20`, then `audit list --limit 20 --before-id BEFORE_ID --snapshot-id SNAPSHOT_ID` using exact `data.nextBeforeId` and `data.snapshotId` strings. Each CLI invocation records its own temporary sign-in/sign-out, so retain the first captured snapshot across continuation calls. These reads need only `read:user`; managed CLI OAuth remains unavailable.

Success writes JSON with `schema_version: "golf.cli.v1"` and the API response in `data`. Repository, issue, PR, organization and team collection pagination is explicit; follow `data.page.nextPage` with `--page`, up to `--limit 100`. Activity uses the keyset cursors described above. Exit codes are 0 for success/help, 1 for operation/authentication/session-cleanup failure, and 2 for usage errors. Diagnostics go to stderr. Go and TypeScript clients now share the Protobuf/Connect contract. Managed CLI OAuth/device login and ACP remain future work.

## Local MCP tools

`./bin/golf mcp` exposes 21 existing repository/source/commit-diff/issue/PR/organization/activity reads over stdin/stdout using the official Go MCP SDK. Configure an owner-controlled client to launch that binary and provide exactly one of `GOLF_API_TOKEN` or `GOLF_FORGE_TOKEN` through its environment from a secret manager; `GOLF_URL` selects the installation. MCP reserves stdin for JSON-RPC, so both token-stdin flags are unavailable. Tool arguments cannot choose credentials, destinations or arbitrary commands.

Each call shares the CLI's scoped API path. PAT mode uses temporary sign-in/sign-out with session activity; API credential mode uses its existing source session and creates no login/logout events. Results use the `golf.mcp.v1` envelope in structured and text content; pagination is explicit, and source/review text remains untrusted data. Four concurrent calls, bounded input/output and cancellation cleanup limit this local adapter. Native checks cover all 21 tools under both `2026-07-28` and legacy `2025-11-25`; separate raw-wire cancellation checks also cover both versions. See the [MCP contract](docs/MCP_CONTRACT.md). This does not provide remote MCP, ACP, mutations, managed authentication or qualified coding-agent execution.

## Local checks

```sh
make check                 # Go, web, generated output and static checks
make helm-check            # Forgejo chart rendering; requires Helm
python3 scripts/forgejo-qualify.py --output .tmp/forgejo-qualification/receipt.json
python3 scripts/smoke.py --restart   # against the running local Compose stack
```

The isolated Forgejo qualification uses disposable PostgreSQL and Forgejo containers, checks source, Git, PR and workflow behavior, then removes its fixtures. The local smoke checks authentication, private source, Git push, access denial and restart persistence. Browser fixture tests can be run with `npm --prefix web test`. The old Gitea specific smoke and recovery scripts are historical evidence and do not qualify this Forgejo installation. A dedicated database is required for `make test-integration`; never point it at the installed database.

## Repositories and delivery plan

- [Product plan](GOLF_IMPLEMENTATION_PLAN.md), [evidence ledger](docs/IMPLEMENTATION_STATUS.md), [guide adoption register](docs/TECHNOLOGY_GUIDE_REGISTER.md) and [initial architecture decision](docs/decisions/0001-initial-forge-and-vertical-slice.md).
- [Cloudflare competition requirements and gaps](docs/COMPETITION_READINESS.md), exclusively for the Cloudflare track.
- [Cloudflare build plan](docs/CLOUDFLARE_BUILD_PLAN.md), [foundation contract](docs/CLOUDFLARE_FOUNDATION_CONTRACT.md) and [agent contract](docs/CLOUDFLARE_AGENT_CONTRACT.md): live Worker/private R2/Artifacts foundations and an operator-controlled concurrent-agent/Clef/conflict/fresh-test proof pass with cleanup. Golf task/UI integration and protected previews follow.
- [Marketing site](https://github.com/mjtechguy/golf-website): Victor-inspired Astro site, independently deployable to Cloudflare/static hosting.
- [Versioned docs site](https://github.com/mjtechguy/golf-docs): Docusaurus/MDX, current development guides, manual release snapshots and agent-readable exports. Forge is a generator to qualify later.
- [Archived planning conversation](docs/archive/plan-conversation-2026-10-01.md), retained unchanged for reference.

All repositories currently require access. Website/docs builds and Cloudflare dry-runs do not imply live deployment. Public release/licensing and competition submission remain separate decisions. Run local checks; do not add or enable repository CI until requested.

The historical [provider role qualification](docs/GITEA_IDENTITY_ROLE_QUALIFICATION.md) does not establish Forgejo role behavior. Golf organization role administration remains unimplemented; qualify Forgejo grants before relying on strict viewer or constrained maintainer roles.

Open **Organizations** to browse memberships, native team/unit settings, members and assigned repositories with typed deep links. See the [organization browser contract](docs/ORGANIZATION_BROWSER_CONTRACT.md). Protected integration remains gated by the [actual write/merge qualification](docs/GITEA_PROTECTED_WRITE_QUALIFICATION.md); native status names, review counts and a Golf queue mutex cannot substitute for exact authorized candidate evidence.

## Optional observability

Golf records correlated JSON request logs and can export bounded API/Forgejo/PostgreSQL traces and private Prometheus metrics. Metrics use a separate authenticated listener; export is disabled by default. See the [configuration and privacy contract](docs/OBSERVABILITY.md) and [local monitoring overlay](deploy/observability/README.md). Job/runner instrumentation and production operational qualification remain open.

Issue discussion creation uses `write:issue` with current user/repository scopes and UUID-backed intents. An unknown result is inspected rather than resent; native address races remain a qualification limit. CLI/MCP provide reads and explicitly granted journaled writes, including comment pages and own-operation status. See [discussion boundaries](docs/ISSUE_DISCUSSION_CONTRACT.md).

### Local CI and RustFS development profile

Run `make dev` (or `make local-up`) for the local development profile: Golf, the Git backend, PostgreSQL, RustFS and the Docker CI worker/daemon. It preserves existing private credentials and volumes, initializes the source bucket, and refreshes the worker network namespace after a Golf replacement. `make local-status` lists the services; `make local-stop` stops them without removing volumes. Execution policies remain default-deny. `make up` retains the smaller three-service core profile.

The opt-in [portable HTTPS edge](docs/HTTPS.md) adds Caddy, verified local TLS and secure persistent cookies: copy `.env.https.example` to `.env.https`, then `make local-https-up`. It switches Golf UI/API to `https://localhost:8443` and removes the published 8080 backend port. Local CA trust is explicit; host trust is never installed automatically. Public Git ingress and production deployment qualification remain separate gates.

The development stack runs bounded workflow catalogs with local PostgreSQL, RustFS and isolated Docker workers. Manual execution and automatic branch-push CI have independent default-deny policies; push CI also requires an explicit persistent automation grant. The maintained Actions catalog is opt-in and has a published supported subset, not full Actions/GitLab compatibility. Coding-agent execution and HTTP/SMTP delivery use separately configured connections and optional workers; installing the core does not authenticate an agent or activate a notification destination. Deployment adapters remain unfinished. See the [Actions compatibility plan](docs/ACTIONS_COMPATIBILITY_IMPLEMENTATION.md), [push CI contract](docs/PUSH_AUTOMATION_CONTRACT.md), [agent tasks](docs/AGENT_TASKS.md), [managed PR reviewers](docs/PR_REVIEWERS.md), [outbound webhooks](docs/OUTBOUND_WEBHOOK_DELIVERY_CONTRACT.md) and [email delivery](docs/EMAIL_NOTIFICATION_DELIVERY_CONTRACT.md). Current evidence is recorded in the ledger. The equivalent explicit Compose commands are:

```sh
python3 scripts/init-ci-env.py
python3 scripts/init-storage-env.py
docker compose --env-file .env --env-file .env.ci --env-file .env.storage \
  -f compose.yaml -f compose.ci.yaml -f compose.storage.yaml up -d --build rustfs golf
docker compose --env-file .env --env-file .env.ci --env-file .env.storage \
  -f compose.yaml -f compose.ci.yaml -f compose.storage.yaml exec -T golf golf objectstore initialize
docker compose --env-file .env --env-file .env.ci --env-file .env.storage \
  -f compose.yaml -f compose.ci.yaml -f compose.storage.yaml up -d --build runner
```

Use **Admin portal → Infrastructure** for encrypted connection profiles and storage activation. Database profiles can be saved/tested; switching live databases remains an operator cutover. Development data is disposable. **Execution policy** defaults to deny: enable only the repositories and literal workflow paths you intend to run, at every required scope. The local worker daemon is privileged trusted infrastructure; untrusted jobs do not receive its socket or credentials. See the [runner contract](docs/RUNNER_ISOLATION_CONTRACT.md) and [pipeline compatibility](docs/PIPELINE_EXECUTION_COMPATIBILITY.md).

### Native push event intake (local foundation)

Golf records authenticated native push webhooks without Cloudflare or AI. When separately enabled and authorized, automatic shell CI consumes eligible sponsor-authored branch pushes at their exact commit; intake alone never grants execution. The [event contract](docs/REPOSITORY_EVENTS_CONTRACT.md) explains bounded input, immutable repository binding, durable deduplication and the native unsigned-header replay limitation. The [push CI contract](docs/PUSH_AUTOMATION_CONTRACT.md) specifies current grants, policy ceilings and supported triggers. Outbound HTTP/SMTP consumers are separate opt-in services; this does not imply a complete Slack integration or every planned agent trigger.

An operator supplies `GOLF_REPOSITORY_EVENT_CONNECTIONS` as a JSON array of explicit connection ID, native repository ID, owner ID, exact `owner/name` and a distinct random signing secret per repository. Keep this in an ignored mode0600 environment file or the deployment Secret, never the repository. Configure the native repository webhook through supported APIs to POST push events to `/hooks/forgejo/<connectionID>` with that secret. Compose passes the variable to Golf; Helm accepts the optional key in its existing Secret. Unset or `[]` disables intake. Secret changes require draining/restarting every serving replica; this slice has no live configuration epoch.

`/status` separates shared platform capabilities, portable coding-agent adapters and individual Cloudflare integrations using the common searchable, sortable table without pagination. Planned integrations remain unavailable; operator configuration or an installed harness alone is not a verified connection.
