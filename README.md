# Golf

Golf is an agent-ready Git and developer-workflow platform with two infrastructure tracks:

- **Cloudflare-focused:** first-class Workers, Artifacts and useful Cloudflare integrations for execution, storage, previews, delivery, email and operations.
- **Self-hosted:** Docker Compose and Kubernetes without a Cloudflare requirement. Operators can mix local/other providers with individual optional Cloudflare backends.

These are infrastructure choices, not editions. AI is optional in Golf's core workflows. The Cloudflare competition demonstration separately requires real concurrent agents, Workers and Artifacts. The initial shared forge backend is Gitea, with an origin Go/PostgreSQL core; native forge replacement is deferred.

## What works now

This is a developer preview: Golf-owned local email-or-username/password sign-in, optional scoped Gitea browser OAuth and advanced per-user token bootstrap, encrypted PostgreSQL-backed sessions with account listing/revocation and own-account activity, member-scoped organization/team browsing and owner-managed ordinary team membership, repository listing/creation, in-app source, commit history and native commit-diff browsing, ordinary issue creation/plain-text comments and pull-request/native-review reads, a JSON CLI and local stdio MCP tools, black/charcoal and light themes with a single toggle, capability reporting, and persistent Compose/Helm installations. Git writes use the native backend directly; own-account SSH keys can now be listed, added and removed in Golf. Repository administrators can edit description, an existing default branch and issues/wiki/pull-request feature flags through an explicit full-page settings editor.

Self-service local account lifecycle, external OIDC, organization invitations/team grant editors/delegated roles, import/connections, PR/review mutations and merge policy, pipelines/runners, agent execution, Cloudflare integrations and protected previews/CD remain roadmap work. This is not complete v1 or a competition-ready entry. No repository CI is configured.

Manage Git SSH access under **Your account → User settings → SSH keys**. Add the public `.pub` file from your machine, then use the repository's SSH clone URL. Account keys follow your repository permissions and stay active until removed. Golf passwords and read-only Golf API credentials are not direct HTTP Git credentials. See the [Git access contract](docs/GIT_ACCESS_CONTRACT.md); `make qualify-git` runs the current real Git/API/CLI/browser acceptance checks against the local Compose stack.

Settings inventories cover personal, organization, repository and instance scopes, with explicit ready/read-only/planned states. **Your account → Instance settings** is visible only to explicitly enrolled Golf instance administrators; it now lists actual enrolled local accounts, while editable global configuration and account lifecycle controls remain operator-managed. Organization owners can add/remove existing accounts through **Team settings** on non-owner teams; invitations, team/role editors and ownership changes remain unimplemented. See the [repository settings contract](docs/REPOSITORY_SETTINGS_CONTRACT.md).

Pinned public GitHub/GitLab examples passed actual source/history/CLI/private-clone qualification; workflow files are preserved but not executed. The repeatable [qualification](docs/PUBLIC_REPOSITORY_QUALIFICATION.md) is source transfer into disposable repositories, not a product importer.

## Run locally

Requires Docker with Compose, Git and OpenSSL. Node and Go are needed only for development outside the container.

```sh
git clone git@github.com:mjtechguy/golf-git.git
cd golf-git
./scripts/init-env.sh
docker compose up -d --build
curl --fail http://localhost:8080/readyz
```

Open **http://localhost:8080** for Golf and **http://localhost:3001** for Gitea. Use `localhost` consistently: all RPC calls check the exact configured origin. Readiness returns 503 until PostgreSQL and Gitea are ready; retry after first startup.

Registration is disabled. Create your local account with Gitea's supported command (replace the example identity):

```sh
docker compose exec gitea gitea --config /etc/gitea/app.ini admin user create \
  --username golf-owner --email owner@example.com --admin \
  --random-password --must-change-password=false
```

Store the printed **native Gitea** password securely. Sign into Gitea and create a dedicated scoped token under **Settings → Applications**, using the scopes below. This is the forge identity/credential setup; it is not your Golf password.

Enroll the corresponding **Golf account** with the server operator command. Create a private, ignored JSON file through your editor or secret manager; never put real credentials in shell arguments or committed examples. Its exact create shape is:

```json
{
  "username": "golf-owner",
  "email": "owner@example.com",
  "password": "REPLACE_WITH_A_UNIQUE_GOLF_PASSWORD",
  "forge_token": "REPLACE_WITH_THIS_USERS_SCOPED_GITEA_TOKEN",
  "is_instance_admin": true
}
```

Use a unique password of at least 15 characters. Restrict the input file to mode0600, then pipe it to the container:

```sh
docker compose exec -T golf golf local-account create < .tmp/local-account/enrollment.json
```

Open Golf and sign in with **Email or username** and **Password**. Golf hashes its own password and keeps the mapped forge token encrypted on the server; the Golf password is never sent to Gitea. Local administrator enrollment records a Golf instance role; the broader administration UI and organization policy are still planned. Public registration is unavailable. Operators can explicitly reset, disable or re-enable accounts; see [local authentication](docs/LOCAL_AUTHENTICATION.md). Individual users need their own mapping and scopes; never share an administrator token across users. **Advanced token sign-in** remains available for development tooling, and OAuth is optional.

Open **Your account → User settings → Sessions** to list your active Golf sessions and revoke one, the current session, or all other sessions. Confirmation is required. Revocation removes Golf access on subsequent requests; provider PATs, OAuth consent and Git credentials remain separately managed. Settings and sessions use full pages; revocations require a confirmation dialog. See [session management](docs/SESSION_MANAGEMENT.md).

Open **Account activity** to inspect your recorded successful sign-ins, sign-outs and session revocations/replacements. Load more retains one history snapshot; Refresh starts a new one. Reads require only `read:user`. History starts with recording, has no invented pre-migration events, and excludes automatic expiry cleanup, OAuth refresh and failed attempts. See the [account audit contract](docs/ACCOUNT_AUDIT_CONTRACT.md) for event, migration and operator limits.

### Optional browser OAuth

Register a **confidential** OAuth application in Gitea Settings → Applications with the exact callback `http://localhost:8080/auth/gitea/callback` (use your Golf HTTPS origin remotely). Leave consent enabled. Save its client secret in ignored `.env` or an operator-managed secret source and set all three variables:

```dotenv
GITEA_PUBLIC_URL=http://localhost:3001
GITEA_OAUTH_CLIENT_ID=your-registered-client-id
GITEA_OAUTH_CLIENT_SECRET=your-registered-client-secret
```

Run `docker compose up -d golf` to apply the configuration. Golf then offers **Continue with Gitea**; login and consent occur at your configured forge. Golf requests `write:user`, `write:repository`, `write:issue` and `read:organization`, including broader upstream repository/user write authority for repository creation. Use a restricted personal token when read-only access is desired. The browser receives only a Golf session cookie; access and refresh credentials remain encrypted on the server. OAuth configuration is optional, not a Cloudflare requirement.

The fixed callback uses single-use ten-minute state, a separate HttpOnly browser binding and S256 PKCE. Sessions retain their absolute twelve-hour expiry despite access-token refresh. Logout removes the Golf session; manage provider consent in Gitea. This is Gitea OAuth, not complete self-service account management or external OIDC, organization policy or CLI OAuth login. See [ADR 0003](docs/decisions/0003-gitea-oauth-and-session-refresh.md).

**Token scopes (verified on Gitea 1.27.3):** use `read:user` plus `read:repository` to sign in and browse. Creating repositories additionally requires `write:user` plus `write:repository` (write includes read). Gitea applies both user and repository scopes to its `/user/repos` route; Golf preserves that authorization. Read-only tokens can browse but creation is rejected; explicit-key requests return recorded rejection evidence, while legacy unkeyed calls retain permission errors.

Add `read:organization` to browse your organizations and provider-visible teams; this scope does not grant membership. For an existing OAuth grant without it, revoke Golf’s grant in Gitea **Settings → Applications**, then sign in through Golf and approve the new scopes. Signing in again alone can reuse the narrower grant. Add `read:issue` to browse issues. Code browsing continues to work without issue scope; the issue panel reports the missing permission. Scopes never grant repository access the user does not already have.

The browser receives an opaque HttpOnly session cookie, not the upstream credential. The server stores only the session identifier's hash and an AES-GCM-encrypted Gitea token. Sessions persist across backend restarts and expire after 12 hours. HTTPS uses a host-only `__Host-golf_session` cookie with Secure, HttpOnly and SameSite=Lax; loopback development uses `golf_session`. Password reset/disable invalidates local-password sessions; saved cookies and their delegated API credentials then fail. Token revocation is enforced by Gitea on subsequent calls. Local insecure cookies are explicitly allowed only on loopback origins; remote use requires HTTPS and secure cookies.

Secrets are generated once into ignored `.env`. Keep that file and all configured encryption keys secure. The original `GOLF_ENCRYPTION_KEY` remains supported as the `legacy` key; do not replace its bytes under the same label. The database initializes two independent databases/roles, one for Golf and one for Gitea. Changing `.env` passwords later does not rotate existing PostgreSQL roles. Do not delete `.env` while retaining volumes and expect a fresh credential set to work.

```sh
docker compose stop      # stop; retain all data
docker compose start     # resume
docker compose down      # remove containers/network; retain named volumes
```

Do not add `--volumes` unless intentionally erasing this installation. Preserve both databases, Gitea repository/configuration volumes and encryption keys together. The bounded [offline recovery workflow](docs/RECOVERY.md) below passes the native fresh-restore and whole-stack restart drill; production recovery remains open. Local ports bind only to loopback; this Compose file is a development installation.

## Credential key operations

The [keyring contract](docs/CREDENTIAL_KEYRING.md) documents `GOLF_ENCRYPTION_KEYS` (a JSON map of labels to base64 32-byte keys) and `GOLF_ACTIVE_ENCRYPTION_KEY`, alongside the compatible single-key variable. Registered labels are permanently bound to their material. Every stored session, pending OAuth verifier and persistent local-account forge credential must retain its read key, including expired records and disabled accounts.

Operator commands live in the server binary, separately from the read-only user CLI. Supply the Golf database/key environment securely, then use `./bin/golf-server keys status`, `keys activate`, `keys rotate --batch-size 100 --max-batches 10`, or `keys retirement-check --key-id legacy`. The container equivalent is `docker compose run --rm --no-deps golf keys status` with an already-built image and available database. Even status can apply migrations and register legacy metadata; partial rotation can exit zero, so inspect its JSON state/counts.

Before activation, drain all old Golf writers and in-flight OAuth exchanges. Database fencing cannot reverse an issuer's completed refresh, and transparent rolling cutover is not supported. Retirement requires zero uses across all three credential families and does not erase secrets or old backup keys. Targeted database and old-binary PAT/pending-verifier checks pass; live OAuth exchange across activation and wider rollout/recovery qualification remain open. This does not complete P1.3 or add KMS/age/FIPS support.

## Offline backup and quarantined restore

The [recovery guide](docs/RECOVERY.md) documents `scripts/recovery.py backup|verify|restore` for the canonical three-service Docker installation: PostgreSQL 18.4, Gitea 1.27.3 and Golf schema 202610020007. It captures native database dumps, both complete Gitea volumes and resolved runtime credentials/configuration into a private age-encrypted archive. A fresh restore requires the exact local image IDs, invalidates every restored Golf session/pending PKCE attempt and disables all restored local accounts and leaves Golf/Gitea stopped. Images are not included.

All writers must be stopped and drained before capture or restore; `--writers-drained` asserts that operator precondition and does not fence administrators. Accept only trusted operator backups, protect plaintext staging and restore configuration, and reconcile native/provider revocations, deletion decisions and outbound work before reopening. Real PostgreSQL safeguards, offline archive checks and the full native fresh-restore drill pass, including preserved creation-operation/event history, same-key inspection/replay without another create, signed Git, hydrated LFS, attachments, protections, SSH/signing identity, fresh access and simultaneous whole-stack restart. The small fixture skips the minimum-size-cap negative case; this is not an 8 GiB or load qualification. This does not complete P1.6, qualify Kubernetes/external object stores or establish RPO/RTO targets. Backup age encryption does not change the application credential cipher.

## Run on Kubernetes

The [Helm chart](deploy/helm/golf/README.md) installs the same core with existing Secret references, persistent volumes, probes, resource/security bounds and native ingress/network policies. It supports external PostgreSQL and an existing qualified Gitea. Supply an explicitly built Golf image; no public release image is available yet. Cloudflare and AI are optional.

The [Kubernetes guide](docs/KUBERNETES.md) includes an isolated k3d qualification command. The verified developer profile scales Golf to two replicas and retains one canonical Git writer. Single-node restart evidence does not establish storage fencing, multi-node failover, HA or production readiness. Workers/runners and object-storage adapters are not installed by this chart.

## Browse code, issues and pull requests

Open a repository in Golf to explore its branches, commit history and source tree. File/folder navigation stays at an exact commit, so a concurrent push cannot silently change the snapshot you are inspecting. Refresh or select a branch again to observe a new head. The commit view can open historical snapshots. Empty repositories display push guidance; after the first push, Gitea may need a moment to finish processing before refresh shows the source.

Files are rendered as plain text up to 256 KiB. Binary/control content, large files, symlinks, submodules and LFS objects show metadata and an explanation instead. Golf does not execute source HTML, follow source links or fetch submodule targets. Directories above 1,000 entries or upstream responses above 2 MiB fail visibly; this preview does not claim unlimited monorepo browsing.

The Issues tab lists open/closed issues and reads issue bodies as plain text. Issue editing, comments, rendered Markdown, PR comparisons, blame and review submission remain future work. Gitea remains the sole source of collaboration data. See the [browser contract](docs/REPOSITORY_BROWSER_CONTRACT.md) for procedures and bounds.

In **Commits**, choose **View diff** to inspect an exact object and its first-parent comparison (or root output). Merge diffs show only the first parent. Native text is limited to 512 KiB and stays plain text; binary notices and root commit metadata, including author email, remain as supplied by Gitea. Oversized/invalid text fails visibly. **Browse this commit** opens that object’s source. This is unparsed provider output, not independently verified patch completeness or merge readiness. See the [commit-diff contract](docs/COMMIT_DIFF_CONTRACT.md).

The **Pull requests** tab lists open/closed/all PRs and opens plain-text detail with native Gitea reviews. List heads are labeled retained snapshots; detail refs are provider observations or explicit retained fallbacks. These labels, native merge records and review flags do not establish a live source branch, Golf approval eligibility or merge readiness. Pagination can advance from an empty review page because Gitea filters hidden pending reviews after counting. PR and review reads require `read:user` plus `read:repository`, without issue scope. See the [PR read contract](docs/PULL_REQUEST_READ_CONTRACT.md).

## Durable repository creation

The browser gives each creation request a stable key, immediately blocks duplicate submission events, and freezes its submitted details. It retains only the key, name and visibility in tab session storage scoped by browser origin and native Gitea user ID. Unresolved requests remain available for status inspection after closing the dialog or reloading the tab; they are never automatically recreated. Golf commits the operation before the native POST and never dispatches a repeated account/key again. A known rejection permits an explicit new request.

The API adds optional `CreateRepository.idempotency_key` (a canonical lowercase UUID v4) and `GetRepositoryCreation`. Keyed responses carry explicit `SUCCEEDED`, `REJECTED` or `OUTCOME_UNKNOWN` evidence; HTTP 200 alone does not mean creation succeeded. Reusing a key with changed inputs fails. Current native access and repository ID are checked before returning repository metadata. Unkeyed callers retain legacy error behavior, with no deduplication across separate invocations. See [the operation contract](docs/REPOSITORY_CREATION_CONTRACT.md) for scope, ambiguity, storage and verification boundaries. Native success/rejection/restart, real browser acknowledgment loss and counted Gitea-response-loss checks pass; the latter stays unknown after retries and restart with exactly one observed provider POST. This is not a general outbox/job engine or exactly-once provider contract.

## Read-only CLI

Requires the Go version in `go.mod`. `make cli` produces `bin/golf`; `make build` additionally produces the server as `bin/golf-server`.

```sh
make cli
./bin/golf --help
# Supply GOLF_GITEA_TOKEN through your shell's secret manager, not a literal in history.
./bin/golf repo list
./bin/golf repo view owner/repository
./bin/golf repo creation 12345678-1234-4234-8234-123456789abc
./bin/golf repo branches owner/repository
./bin/golf repo commits owner/repository --ref feature/example
./bin/golf repo contents owner/repository --ref COMMIT_ID --path README.md
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

Alternatively pipe one token from your secret manager to `./bin/golf --token-stdin repo list`. For owner-issued read-only Golf credentials, set `GOLF_API_TOKEN` or use `--api-token-stdin`. API and Gitea token sources cannot be mixed. Secrets are never accepted as command-line arguments. Set `GOLF_URL` or global `--url` for another installation; remote origins require HTTPS. The CLI does not follow redirects or save credentials/cookies. Gitea PAT mode creates and deletes a temporary Golf session per command, including after an operation fails. Golf API credential mode delegates the issuing browser session without login/logout or a cookie jar; ending that session invalidates the credential. See the [API credential contract](docs/API_CREDENTIAL_CONTRACT.md). Abrupt termination can leave that session until its normal server expiry.

`commit diff` requires an exact lowercase 40- or 64-character hexadecimal SHA, accepts no branch/revision expressions or pagination, and returns JSON-escaped `data.rawDiff` plus commit/parent/base metadata and numeric `data.byteSize`. It uses the same `read:user,read:repository` scopes as source browsing; syntax acceptance does not qualify every forge object format.

`repo creation` inspects your existing request key through the same scoped API. It only reads operation evidence, never creates/retries a repository. A successful historical record can lack repository metadata after access loss, rename, deletion or replacement. `OUTCOME_UNKNOWN` may include work still in flight.

PR/review commands require `read:user` and `read:repository`; review flags remain provider observations. Organization/team commands require `read:user` and `read:organization`; repository source separately requires `read:repository`. Team IDs are canonical positive decimal strings, obtained from `org teams`. Empty collection pages can still have a `nextPage`.

Account activity uses a separate keyset contract: `audit list --limit 20`, then `audit list --limit 20 --before-id BEFORE_ID --snapshot-id SNAPSHOT_ID` using exact `data.nextBeforeId` and `data.snapshotId` strings. Each CLI invocation records its own temporary sign-in/sign-out, so retain the first captured snapshot across continuation calls. These reads need only `read:user`; managed CLI OAuth remains unavailable.

Success writes JSON with `schema_version: "golf.cli.v1"` and the API response in `data`. Repository, issue, PR, organization and team collection pagination is explicit; follow `data.page.nextPage` with `--page`, up to `--limit 100`. Activity uses the keyset cursors described above. Exit codes are 0 for success/help, 1 for operation/authentication/session-cleanup failure, and 2 for usage errors. Diagnostics go to stderr. Go and TypeScript clients now share the Protobuf/Connect contract. Managed CLI OAuth/device login and ACP remain future work.

## Local MCP tools

`./bin/golf mcp` exposes 21 existing repository/source/commit-diff/issue/PR/organization/activity reads over stdin/stdout using the official Go MCP SDK. Configure an owner-controlled client to launch that binary and provide exactly one of `GOLF_API_TOKEN` or `GOLF_GITEA_TOKEN` through its environment from a secret manager; `GOLF_URL` selects the installation. MCP reserves stdin for JSON-RPC, so both token-stdin flags are unavailable. Tool arguments cannot choose credentials, destinations or arbitrary commands.

Each call shares the CLI's scoped API path. PAT mode uses temporary sign-in/sign-out with session activity; API credential mode uses its existing source session and creates no login/logout events. Results use the `golf.mcp.v1` envelope in structured and text content; pagination is explicit, and source/review text remains untrusted data. Four concurrent calls, bounded input/output and cancellation cleanup limit this local adapter. Native checks cover all 21 tools under both `2026-07-28` and legacy `2025-11-25`; separate raw-wire cancellation checks also cover both versions. See the [MCP contract](docs/MCP_CONTRACT.md). This does not provide remote MCP, ACP, mutations, managed authentication or qualified coding-agent execution.

## Local checks

```sh
npm --prefix web ci
npm --prefix web exec -- playwright install chromium
make check  # includes generated-output drift checks
make helm-check # requires Helm; no cluster or credentials
make generate # after editing Protobuf or SQL queries
go test -race ./...
npm --prefix web test
python3 scripts/smoke.py --restart
# Optional: include real CLI checks against the same stack.
make cli
python3 scripts/smoke.py --cli bin/golf
# Native stdio MCP discovery, all 21 reads, scope and lifecycle checks.
python3 scripts/mcp-smoke/run.py --cli bin/golf
# Raw-wire cancellation, request-ID and input-framing checks.
python3 scripts/mcp-cancellation-check.py --cli bin/golf
# Own-account activity API/CLI and production-served browser checks.
python3 scripts/audit-smoke.py --cli bin/golf
# Isolated DB/real PAT keyring checks; build bin/golf-server first.
python3 scripts/keyring-smoke.py
# Offline recovery archive/configuration validation, without data mutations.
python3 scripts/recovery-test.py
# Isolated native backup/restore drill; supply a current locally built image.
python3 scripts/recovery-smoke.py --image '<LOCAL_GOLF_IMAGE_TAG_OR_ID>'
# Durable creation, native replay/privacy/restart and real browser response loss.
python3 scripts/repository-creation-smoke.py --restart --cli bin/golf --browser
# Provider-response loss uses a separate fresh database; preparation is in
# docs/REPOSITORY_CREATION_CONTRACT.md, not the normal installation.
python3 scripts/repository-creation-fault-smoke.py --server-binary bin/golf-server \
  --database-url-file .tmp/creation-verification/database-url
# Actual PAT session management and production-served dialog checks.
python3 scripts/sessions-smoke.py
# Real membership-scoped organizations/teams and production browser checks.
python3 scripts/organizations-smoke.py --cli bin/golf
# Native Git commit diffs, bounded plain text, CLI and production browser checks.
python3 scripts/commit-diff-smoke.py --cli bin/golf
# Real private-fork PR/native-review reads and production browser checks.
python3 scripts/pulls-smoke.py --cli bin/golf
# Isolated provider role contract; uses disposable PostgreSQL/Gitea on port 3016.
python3 scripts/gitea-role-smoke.py
# Characterize protected writes on disposable port 3018; exit 0 also records limitations.
python3 scripts/gitea-protection-smoke.py
# Docker Desktop: publication faults/private-fork races on disposable port 3020.
python3 scripts/gitea-publisher-smoke.py
# Deterministic local Git source race; disposable local hook, no provider changes.
python3 scripts/git-atomic-verify-smoke.py
# Optional browser OAuth and real rotating-refresh checks; briefly recreates services.
python3 scripts/oauth-smoke.py --refresh
```

The browser checks use contract fixtures. `scripts/smoke.py` exercises the real running Compose stack: isolated users/private repositories, cross-user denial, CSRF, real Git pushes, source snapshots/preview boundaries, issues/scope denial, optional CLI/restart/outage checks, revocation and logout. It removes its test Gitea users/repositories afterward. `--restart` briefly interrupts local Golf/Gitea; omit it to skip those service operations. Python 3 and Git are required; `--cli` accepts an already-built CLI executable.

`scripts/recovery-smoke.py` creates and removes two isolated Docker installations with native Git, LFS, attachment and key fixtures. Its small archive does not qualify large backups, an 8 GiB payload, or RPO/RTO targets. The size-cap check prints `SKIP` when the actual plaintext payload is at or below the minimum 1 MiB bound; a skipped check or offline file-limit check is not evidence of a successful large restore.

`scripts/audit-smoke.py` checks recorded session events, account privacy, cursor snapshots, ephemeral CLI cleanup and the production activity screen. Its optional `--upgrade` expects a running pre-audit service and an already-built new image; `--restart` briefly interrupts Golf. Provider users and active sessions are removed afterward, while immutable Golf identities/history remain. Drain all old writers before claiming an audited operating window; a mixed-version rolling fleet is not qualified. Automatic cleanup and provider changes are not a complete audit trail.

`scripts/oauth-smoke.py` creates disposable users and a confidential provider application, enables OAuth with a private temporary override, and exercises actual browser login/consent. `--refresh` uses two real short-lived token cycles with concurrent requests and revocation. It restores the original Gitea token settings and disabled Golf OAuth, then purges its fixtures. It also checks all six member-scoped organization/team reads and OAuth session listing/current/bulk revocation using a separate account. It also obtains a real narrower legacy-equivalent grant, verifies that refresh and a new sign-in cannot expand it, then revokes that provider grant and verifies fresh consent enables organization access. This does not test a complete old-release binary upgrade. It requires OAuth to be disabled initially; it never edits `.env` or deletes volumes.

The [publisher qualification](docs/GITEA_PUBLISHER_QUALIFICATION.md) tests real lost responses, delayed writes, exact private-fork candidate publication and supported PR bookkeeping. Its experimental journal is not a Golf publisher. It reproduces old-authority and private-source races; protected integration remains unavailable. Custom hooks are enabled only in its disposable provider for a bounded callback barrier. This proof currently requires Docker Desktop host callbacks, not a qualified Linux/Kubernetes managed profile.

The backend's database integration test runs when `GOLF_TEST_DATABASE_URL` points to a dedicated test PostgreSQL database. `make test-integration` requires it; without it, ordinary Go tests explicitly skip that integration case. Do not use a production database.

To develop the browser separately, use `npm --prefix web run dev` and `GOLF_PUBLIC_URL=http://127.0.0.1:5173 docker compose up -d golf`. The default Vite origin must exactly match that configured value. Vite proxies the API to port 8080; local Compose keeps loopback-only insecure cookies enabled. Run `docker compose up -d golf` without that override to return to the normal app origin at port 8080.

## Repositories and delivery plan

- [Product plan](GOLF_IMPLEMENTATION_PLAN.md), [evidence ledger](docs/IMPLEMENTATION_STATUS.md), [guide adoption register](docs/TECHNOLOGY_GUIDE_REGISTER.md) and [initial architecture decision](docs/decisions/0001-initial-forge-and-vertical-slice.md).
- [Cloudflare competition requirements and gaps](docs/COMPETITION_READINESS.md), exclusively for the Cloudflare track.
- [Marketing site](https://github.com/mjtechguy/golf-website): Victor-inspired Astro site, independently deployable to Cloudflare/static hosting.
- [Versioned docs site](https://github.com/mjtechguy/golf-docs): Docusaurus/MDX, current development guides, manual release snapshots and agent-readable exports. Forge is a generator to qualify later.
- [Archived planning conversation](docs/archive/plan-conversation-2026-10-01.md), retained unchanged for reference.

All repositories currently require access. Website/docs builds and Cloudflare dry-runs do not imply live deployment. Public release/licensing and competition submission remain separate decisions. Run local checks; do not add or enable repository CI until requested.

The [Gitea identity/role qualification](docs/GITEA_IDENTITY_ROLE_QUALIFICATION.md) records actual per-unit grants and alternate-path limitations. Golf organization role administration is still unimplemented; Gitea issue-read allows reporting/commenting, and repository admin includes deletion. Those grants cannot silently stand in for strict viewer or constrained maintainer roles.

Open **Organizations** to browse memberships, native team/unit settings, members and assigned repositories with typed deep links. See the [organization browser contract](docs/ORGANIZATION_BROWSER_CONTRACT.md). Protected integration remains gated by the [actual write/merge qualification](docs/GITEA_PROTECTED_WRITE_QUALIFICATION.md); native status names, review counts and a Golf queue mutex cannot substitute for exact authorized candidate evidence.

## Optional observability

Golf records correlated JSON request logs and can export bounded API/Gitea/PostgreSQL traces and private Prometheus metrics. Metrics use a separate authenticated listener; export is disabled by default. See the [configuration and privacy contract](docs/OBSERVABILITY.md) and [local monitoring overlay](deploy/observability/README.md). Job/runner instrumentation and production operational qualification remain open.

Issue discussion creation uses `write:issue` with current user/repository scopes and UUID-backed intents. An unknown result is inspected rather than resent; native address races remain a qualification limit. CLI/MCP expose21 read tools, including comment pages and own-operation status, with no new write commands. See [discussion boundaries](docs/ISSUE_DISCUSSION_CONTRACT.md).
