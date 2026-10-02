# Golf

Golf is an agent-ready Git and developer-workflow platform with two infrastructure tracks:

- **Cloudflare-focused:** first-class Workers, Artifacts and useful Cloudflare integrations for execution, storage, previews, delivery, email and operations.
- **Self-hosted:** Docker Compose and Kubernetes without a Cloudflare requirement. Operators can mix local/other providers with individual optional Cloudflare backends.

These are infrastructure choices, not editions. AI is optional in Golf's core workflows. The Cloudflare competition demonstration separately requires real concurrent agents, Workers and Artifacts. The initial shared forge backend is Gitea, with an origin Go/PostgreSQL core; native forge replacement is deferred.

## What works now

This is a developer preview: per-user Gitea-token sign-in, encrypted PostgreSQL-backed sessions, repository listing/creation, in-app source and commit browsing, read-only issues, a JSON CLI, black/charcoal and light/system themes, capability reporting, and a persistent local Compose stack. Git writes use Gitea directly.

OAuth, organizations/roles, import/connections, review/merge policy, pipelines/runners, agent execution, Cloudflare integrations, protected previews/CD and Kubernetes packaging remain roadmap work. This is not complete v1 or a competition-ready entry. No repository CI is configured.

## Run locally

Requires Docker with Compose, Git and OpenSSL. Node and Go are needed only for development outside the container.

```sh
git clone git@github.com:mjtechguy/golf-git.git
cd golf-git
./scripts/init-env.sh
docker compose up -d --build
curl --fail http://localhost:8080/readyz
```

Open **http://localhost:8080** for Golf and **http://localhost:3001** for Gitea. Use `localhost` consistently: browser writes check the exact configured origin. Readiness returns 503 until PostgreSQL and Gitea are ready; retry after first startup.

Registration is disabled. Create your local account with Gitea's supported command (replace the example identity):

```sh
docker compose exec gitea gitea --config /etc/gitea/app.ini admin user create \
  --username golf-owner --email owner@example.com --admin \
  --random-password --must-change-password=false
```

Store the printed password securely. Sign into Gitea and create a dedicated token under **Settings → Applications**, using the scopes described below. Paste that token into Golf. Individual team members use their own accounts/tokens; never share a site administrator's token across users.

**Token scopes (verified on Gitea 1.27.3):** use `read:user` plus `read:repository` to sign in and browse. Creating repositories additionally requires `write:user` plus `write:repository` (write includes read). Gitea applies both user and repository scopes to its `/user/repos` route; Golf preserves that authorization. Read-only tokens can browse but creation correctly returns a permission error.

Add `read:issue` to browse issues. Code browsing continues to work without issue scope; the issue panel reports the missing permission. Scopes never grant repository access the user does not already have.

The browser receives an opaque HttpOnly session cookie, not the upstream credential. The server stores only the session identifier's hash and an AES-GCM-encrypted Gitea token. Sessions expire after 12 hours. Token revocation is enforced by Gitea on subsequent calls. Local insecure cookies are explicitly allowed only on loopback origins; remote use requires HTTPS and secure cookies.

Secrets are generated once into ignored `.env`. Keep that file and `GOLF_ENCRYPTION_KEY` secure. The database initializes two independent databases/roles, one for Golf and one for Gitea. Changing `.env` passwords later does not rotate existing PostgreSQL roles. Do not delete `.env` while retaining volumes and expect a fresh credential set to work.

```sh
docker compose stop      # stop; retain all data
docker compose start     # resume
docker compose down      # remove containers/network; retain named volumes
```

Do not add `--volumes` unless intentionally erasing this installation. Backup/recovery automation and a production deployment profile are not yet qualified. Preserve both databases, Gitea repository/configuration volumes and encryption keys together. Local ports bind only to loopback; this Compose file is a development installation.

## Browse code and issues

Open a repository in Golf to explore its branches, commit history and source tree. File/folder navigation stays at an exact commit, so a concurrent push cannot silently change the snapshot you are inspecting. Refresh or select a branch again to observe a new head. The commit view can open historical snapshots. Empty repositories display push guidance; after the first push, Gitea may need a moment to finish processing before refresh shows the source.

Files are rendered as plain text up to 256 KiB. Binary/control content, large files, symlinks, submodules and LFS objects show metadata and an explanation instead. Golf does not execute source HTML, follow source links or fetch submodule targets. Directories above 1,000 entries or upstream responses above 2 MiB fail visibly; this preview does not claim unlimited monorepo browsing.

The Issues tab lists open/closed issues and reads issue bodies as plain text. Issue editing, comments, rendered Markdown, diffs, blame and reviews remain future work. Gitea remains the sole source of collaboration data. See the [browser contract](docs/REPOSITORY_BROWSER_CONTRACT.md) for endpoints and bounds.

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
```

Alternatively pipe one token from your secret manager to `./bin/golf --token-stdin repo list`. Credentials are accepted only through stdin or `GOLF_GITEA_TOKEN`, never a command-line token flag. Set `GOLF_URL` or global `--url` for another installation; remote origins require HTTPS. The CLI does not follow redirects or save credentials/cookies. It creates and deletes a temporary Golf session per command, including after an operation fails. Abrupt termination can leave that session until its normal server expiry.

Success writes JSON with `schema_version: "golf.cli.v0"` and the API response in `data`. Pagination is explicit; follow `data.next_page` with `--page`, up to `--limit 100`. Exit codes are 0 for success/help, 1 for operation/authentication/session-cleanup failure, and 2 for usage errors. Diagnostics go to stderr. This bootstrap interface is not the planned stable generated API, OAuth/device login, MCP or ACP.

## Local checks

```sh
npm --prefix web ci
npm --prefix web exec -- playwright install chromium
make check
go test -race ./...
npm --prefix web test
python3 scripts/smoke.py --restart
# Optional: include real CLI checks against the same stack.
make cli
python3 scripts/smoke.py --cli bin/golf
```

The browser checks use contract fixtures. `scripts/smoke.py` exercises the real running Compose stack: isolated users/private repositories, cross-user denial, CSRF, real Git pushes, source snapshots/preview boundaries, issues/scope denial, optional CLI/restart/outage checks, revocation and logout. It removes its test Gitea users/repositories afterward. `--restart` briefly interrupts local Golf/Gitea; omit it to skip those service operations. Python 3 and Git are required; `--cli` accepts an already-built CLI executable.

The backend's database integration test runs when `GOLF_TEST_DATABASE_URL` points to a dedicated test PostgreSQL database. `make test-integration` requires it; without it, ordinary Go tests explicitly skip that integration case. Do not use a production database.

To develop the browser separately, use `npm --prefix web run dev` and `GOLF_PUBLIC_URL=http://127.0.0.1:5173 docker compose up -d golf`. The default Vite origin must exactly match that configured value. Vite proxies the API to port 8080; local Compose keeps loopback-only insecure cookies enabled. Run `docker compose up -d golf` without that override to return to the normal app origin at port 8080.

## Repositories and delivery plan

- [Product plan](GOLF_IMPLEMENTATION_PLAN.md), [evidence ledger](docs/IMPLEMENTATION_STATUS.md), [guide adoption register](docs/TECHNOLOGY_GUIDE_REGISTER.md) and [initial architecture decision](docs/decisions/0001-initial-forge-and-vertical-slice.md).
- [Cloudflare competition requirements and gaps](docs/COMPETITION_READINESS.md), exclusively for the Cloudflare track.
- [Marketing site](https://github.com/mjtechguy/golf-website): Victor-inspired Astro site, independently deployable to Cloudflare/static hosting.
- [Versioned docs site](https://github.com/mjtechguy/golf-docs): Docusaurus/MDX, current development guides, manual release snapshots and agent-readable exports. Forge is a generator to qualify later.
- [Archived planning conversation](docs/archive/plan-conversation-2026-10-01.md), retained unchanged for reference.

All repositories currently require access. Website/docs builds and Cloudflare dry-runs do not imply live deployment. Public release/licensing and competition submission remain separate decisions. Run local checks; do not add or enable repository CI until requested.
