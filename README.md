# Golf

Golf is an agent-ready Git and developer-workflow platform with two infrastructure tracks:

- **Cloudflare-focused:** first-class Workers, Artifacts and useful Cloudflare integrations for execution, storage, previews, delivery, email and operations.
- **Self-hosted:** Docker Compose and Kubernetes without a Cloudflare requirement. Operators can mix local/other providers with individual optional Cloudflare backends.

These are infrastructure choices, not editions. AI is optional in Golf's core workflows. The Cloudflare competition demonstration separately requires real concurrent agents, Workers and Artifacts. The initial shared forge backend is Gitea, with an origin Go/PostgreSQL core; native forge replacement is deferred.

## What works now

This is an initial developer slice: per-user Gitea-token sign-in, encrypted PostgreSQL-backed sessions, real repository listing and creation, black/charcoal and light/system themes, capability reporting, and a persistent local Compose stack. Git operations use Gitea directly.

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

The browser receives an opaque HttpOnly session cookie, not the upstream credential. The server stores only the session identifier's hash and an AES-GCM-encrypted Gitea token. Sessions expire after 12 hours. Token revocation is enforced by Gitea on subsequent calls. Local insecure cookies are explicitly allowed only on loopback origins; remote use requires HTTPS and secure cookies.

Secrets are generated once into ignored `.env`. Keep that file and `GOLF_ENCRYPTION_KEY` secure. The database initializes two independent databases/roles, one for Golf and one for Gitea. Changing `.env` passwords later does not rotate existing PostgreSQL roles. Do not delete `.env` while retaining volumes and expect a fresh credential set to work.

```sh
docker compose stop      # stop; retain all data
docker compose start     # resume
docker compose down      # remove containers/network; retain named volumes
```

Do not add `--volumes` unless intentionally erasing this installation. Backup/recovery automation and a production deployment profile are not yet qualified. Preserve both databases, Gitea repository/configuration volumes and encryption keys together. Local ports bind only to loopback; this Compose file is a development installation.

## Local checks

```sh
npm --prefix web ci
npm --prefix web exec -- playwright install chromium
make check
go test -race ./...
npm --prefix web test
python3 scripts/smoke.py --restart
```

The browser checks use contract fixtures. `scripts/smoke.py` exercises the real running Compose stack: creates isolated users and a private repository, checks cross-user denial and CSRF rejection, pushes a real Git commit, checks restart/outage behavior, revokes a token, signs out, then removes its test Gitea users/repositories. `--restart` briefly interrupts local Golf/Gitea; omit it to skip those service operations. Python 3 and Git are required.

The backend's database integration test runs when `GOLF_TEST_DATABASE_URL` points to a dedicated test PostgreSQL database. `make test-integration` requires it; without it, ordinary Go tests explicitly skip that integration case. Do not use a production database.

To develop the browser separately, use `npm --prefix web run dev` and `GOLF_PUBLIC_URL=http://127.0.0.1:5173 docker compose up -d golf`. The default Vite origin must exactly match that configured value. Vite proxies the API to port 8080; local Compose keeps loopback-only insecure cookies enabled. Run `docker compose up -d golf` without that override to return to the normal app origin at port 8080.

## Repositories and delivery plan

- [Product plan](GOLF_IMPLEMENTATION_PLAN.md), [evidence ledger](docs/IMPLEMENTATION_STATUS.md) and [initial architecture decision](docs/decisions/0001-initial-forge-and-vertical-slice.md).
- [Cloudflare competition requirements and gaps](docs/COMPETITION_READINESS.md), exclusively for the Cloudflare track.
- [Marketing site](https://github.com/mjtechguy/golf-website): Victor-inspired Astro site, independently deployable to Cloudflare/static hosting.
- [Versioned docs site](https://github.com/mjtechguy/golf-docs): Docusaurus/MDX, current development guides, manual release snapshots and agent-readable exports. Forge is a generator to qualify later.
- [Archived planning conversation](docs/archive/plan-conversation-2026-10-01.md), retained unchanged for reference.

All repositories currently require access. Website/docs builds and Cloudflare dry-runs do not imply live deployment. Public release/licensing and competition submission remain separate decisions. Run local checks; do not add or enable repository CI until requested.
