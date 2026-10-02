# Golf

Golf is an agent-ready Git and developer-workflow platform with two infrastructure tracks:

- **Cloudflare-focused:** first-class Workers, Artifacts and useful Cloudflare integrations for execution, storage, previews, delivery, email and operations.
- **Self-hosted:** Docker Compose and Kubernetes without a Cloudflare requirement. Operators can mix local/other providers with individual optional Cloudflare backends.

These are infrastructure choices, not editions. AI is optional in Golf's core workflows. The Cloudflare competition demonstration separately requires real concurrent agents, Workers and Artifacts. The initial shared forge backend is Gitea, with an origin Go/PostgreSQL core; native forge replacement is deferred.

## What works now

This is a developer preview: optional scoped Gitea browser OAuth and per-user token bootstrap, encrypted PostgreSQL-backed sessions with account listing/revocation, member-scoped organization/team browsing, repository listing/creation, in-app source and commit browsing, read-only issues and pull requests/native reviews, a JSON CLI, black/charcoal and light/system themes, capability reporting, and persistent Compose/Helm installations. Git writes use Gitea directly.

Golf local/external OIDC identity, organization/role administration, import/connections, PR/review mutations and merge policy, pipelines/runners, agent execution, Cloudflare integrations and protected previews/CD remain roadmap work. This is not complete v1 or a competition-ready entry. No repository CI is configured.

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

Store the printed password securely. Sign into Gitea and create a dedicated token under **Settings → Applications**, using the scopes described below. Paste that token into Golf, or configure browser OAuth below. Individual team members use their own accounts/tokens; never share a site administrator's token across users.

Open **Sessions** in the workspace sidebar to list your active Golf sessions and revoke one, the current session, or all other sessions. Confirmation is required. Revocation removes Golf access on subsequent requests; provider PATs, OAuth consent and Git credentials remain separately managed. See [session management](docs/SESSION_MANAGEMENT.md).

### Optional browser OAuth

Register a **confidential** OAuth application in Gitea Settings → Applications with the exact callback `http://localhost:8080/auth/gitea/callback` (use your Golf HTTPS origin remotely). Leave consent enabled. Save its client secret in ignored `.env` or an operator-managed secret source and set all three variables:

```dotenv
GITEA_PUBLIC_URL=http://localhost:3001
GITEA_OAUTH_CLIENT_ID=your-registered-client-id
GITEA_OAUTH_CLIENT_SECRET=your-registered-client-secret
```

Run `docker compose up -d golf` to apply the configuration. Golf then offers **Continue with Gitea**; login and consent occur at your configured forge. Golf requests `write:user`, `write:repository`, `read:issue` and `read:organization`, including broader upstream repository/user write authority for repository creation. Use a restricted personal token when read-only access is desired. The browser receives only a Golf session cookie; access and refresh credentials remain encrypted on the server. OAuth configuration is optional, not a Cloudflare requirement.

The fixed callback uses single-use ten-minute state, a separate HttpOnly browser binding and S256 PKCE. Sessions retain their absolute twelve-hour expiry despite access-token refresh. Logout removes the Golf session; manage provider consent in Gitea. This is Gitea OAuth, not complete Golf local/OIDC account management, organization policy or CLI OAuth login. See [ADR 0003](docs/decisions/0003-gitea-oauth-and-session-refresh.md).

**Token scopes (verified on Gitea 1.27.3):** use `read:user` plus `read:repository` to sign in and browse. Creating repositories additionally requires `write:user` plus `write:repository` (write includes read). Gitea applies both user and repository scopes to its `/user/repos` route; Golf preserves that authorization. Read-only tokens can browse but creation correctly returns a permission error.

Add `read:organization` to browse your organizations and provider-visible teams; this scope does not grant membership. For an existing OAuth grant without it, revoke Golf’s grant in Gitea **Settings → Applications**, then sign in through Golf and approve the new scopes. Signing in again alone can reuse the narrower grant. Add `read:issue` to browse issues. Code browsing continues to work without issue scope; the issue panel reports the missing permission. Scopes never grant repository access the user does not already have.

The browser receives an opaque HttpOnly session cookie, not the upstream credential. The server stores only the session identifier's hash and an AES-GCM-encrypted Gitea token. Sessions expire after 12 hours. Token revocation is enforced by Gitea on subsequent calls. Local insecure cookies are explicitly allowed only on loopback origins; remote use requires HTTPS and secure cookies.

Secrets are generated once into ignored `.env`. Keep that file and `GOLF_ENCRYPTION_KEY` secure. The database initializes two independent databases/roles, one for Golf and one for Gitea. Changing `.env` passwords later does not rotate existing PostgreSQL roles. Do not delete `.env` while retaining volumes and expect a fresh credential set to work.

```sh
docker compose stop      # stop; retain all data
docker compose start     # resume
docker compose down      # remove containers/network; retain named volumes
```

Do not add `--volumes` unless intentionally erasing this installation. Backup/recovery automation and a production deployment profile are not yet qualified. Preserve both databases, Gitea repository/configuration volumes and encryption keys together. Local ports bind only to loopback; this Compose file is a development installation.

## Run on Kubernetes

The [Helm chart](deploy/helm/golf/README.md) installs the same core with existing Secret references, persistent volumes, probes, resource/security bounds and native ingress/network policies. It supports external PostgreSQL and an existing qualified Gitea. Supply an explicitly built Golf image; no public release image is available yet. Cloudflare and AI are optional.

The [Kubernetes guide](docs/KUBERNETES.md) includes an isolated k3d qualification command. The verified developer profile scales Golf to two replicas and retains one canonical Git writer. Single-node restart evidence does not establish storage fencing, multi-node failover, HA or production readiness. Workers/runners and object-storage adapters are not installed by this chart.

## Browse code, issues and pull requests

Open a repository in Golf to explore its branches, commit history and source tree. File/folder navigation stays at an exact commit, so a concurrent push cannot silently change the snapshot you are inspecting. Refresh or select a branch again to observe a new head. The commit view can open historical snapshots. Empty repositories display push guidance; after the first push, Gitea may need a moment to finish processing before refresh shows the source.

Files are rendered as plain text up to 256 KiB. Binary/control content, large files, symlinks, submodules and LFS objects show metadata and an explanation instead. Golf does not execute source HTML, follow source links or fetch submodule targets. Directories above 1,000 entries or upstream responses above 2 MiB fail visibly; this preview does not claim unlimited monorepo browsing.

The Issues tab lists open/closed issues and reads issue bodies as plain text. Issue editing, comments, rendered Markdown, diffs, blame and review submission remain future work. Gitea remains the sole source of collaboration data. See the [browser contract](docs/REPOSITORY_BROWSER_CONTRACT.md) for procedures and bounds.

The **Pull requests** tab lists open/closed/all PRs and opens plain-text detail with native Gitea reviews. List heads are labeled retained snapshots; detail refs are provider observations or explicit retained fallbacks. These labels, native merge records and review flags do not establish a live source branch, Golf approval eligibility or merge readiness. Pagination can advance from an empty review page because Gitea filters hidden pending reviews after counting. PR and review reads require `read:user` plus `read:repository`, without issue scope. See the [PR read contract](docs/PULL_REQUEST_READ_CONTRACT.md).

## Read-only CLI

Requires the Go version in `go.mod`. `make cli` produces `bin/golf`; `make build` additionally produces the server as `bin/golf-server`.

```sh
make cli
./bin/golf --help
# Supply GOLF_GITEA_TOKEN through your shell's secret manager, not a literal in history.
./bin/golf repo list
./bin/golf repo view owner/repository
./bin/golf repo branches owner/repository
./bin/golf repo commits owner/repository --ref feature/example
./bin/golf repo contents owner/repository --ref COMMIT_ID --path README.md
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
```

Alternatively pipe one token from your secret manager to `./bin/golf --token-stdin repo list`. Credentials are accepted only through stdin or `GOLF_GITEA_TOKEN`, never a command-line token flag. Set `GOLF_URL` or global `--url` for another installation; remote origins require HTTPS. The CLI does not follow redirects or save credentials/cookies. It creates and deletes a temporary Golf session per command, including after an operation fails. Abrupt termination can leave that session until its normal server expiry.

PR/review commands require `read:user` and `read:repository`; review flags remain provider observations. Organization/team commands require `read:user` and `read:organization`; repository source separately requires `read:repository`. Team IDs are canonical positive decimal strings, obtained from `org teams`. Empty collection pages can still have a `nextPage`.

Success writes JSON with `schema_version: "golf.cli.v1"` and the API response in `data`. Pagination is explicit; follow `data.page.nextPage` with `--page`, up to `--limit 100`. Exit codes are 0 for success/help, 1 for operation/authentication/session-cleanup failure, and 2 for usage errors. Diagnostics go to stderr. Go and TypeScript clients now share the Protobuf/Connect contract. OAuth/device login, MCP and ACP remain future work.

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
# Actual PAT session management and production-served dialog checks.
python3 scripts/sessions-smoke.py
# Real membership-scoped organizations/teams and production browser checks.
python3 scripts/organizations-smoke.py --cli bin/golf
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
