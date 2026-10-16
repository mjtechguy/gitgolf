# Forgejo setup

Forgejo 15.0.9 is the default Git backend for fresh portable Golf installs. The default Compose project is `golf-forgejo`; Helm also renders the pinned Forgejo image by default. Cloudflare-native Golf keeps its separate Artifacts/D1/Workers Git backend.

## Backend history

Forgejo was selected as the portable backend on 2026-10-11 ([ADR 0009](decisions/0009-forgejo-portable-backend.md)). The earlier backend was retired on 2026-10-16; no installations used it, so there was nothing to migrate. ADR 0009 records what is qualified and what remains open.

## Local Compose

### One command

```sh
./scripts/install.sh          # or: make install INSTALL_ARGS='--username me --email me@example.com'
./scripts/install.sh --dry-run --yes   # checks and plan only
```

The installer preflights Docker, Compose v2, BuildKit, the host architecture, Python 3, curl, free ports and disk space; runs `init-env.sh` only when `.env` is missing; runs `docker compose up -d --build` and waits on `/readyz`. It then creates the Forgejo administrator with `forgejo admin user create --random-password` (the native password is not shown; Golf has its own), generates a token with `forgejo admin user generate-access-token --scopes write:user,write:repository,read:issue,read:organization --raw`, writes a temporary mode-0600 enrollment JSON under `.tmp/local-account/`, pipes it to `golf local-account create` and deletes it. A generated Golf password is saved to `.tmp/local-account/<project>-<user>-password.txt` (mode 0600); `--prompt-password` asks for one instead and saves nothing. Re-running is idempotent: an existing `.env`, Forgejo user and Golf account are kept, and an existing Golf account skips enrollment. Forgejo reserves `admin`, so the offered default username is `golf-admin`.

For a second stack on one host, give a fresh checkout its own project and ports before `.env` exists: `--project NAME --http-port P --forge-port P --ssh-port P`. These are written to `.env` as `COMPOSE_PROJECT_NAME`, `GOLF_HTTP_PORT`, `GOLF_FORGE_HTTP_PORT` and `GOLF_FORGE_SSH_PORT`; `compose.yaml` derives the loopback Golf origin and Forgejo `ROOT_URL` from those ports unless `GOLF_PUBLIC_URL`/`GOLF_FORGE_PUBLIC_URL` are set. (Setting `GOLF_FORGE_PUBLIC_URL` also signals Forgejo OAuth to Golf, which then requires the OAuth client settings.) The installer refuses to reuse a project name that is running from another directory.

`./scripts/install.sh --uninstall` (or `make uninstall`) only runs `docker compose down`: volumes, `.env` and saved files stay. Deleting data is deliberately not automated. After a backup, `docker compose -p <project> down --volumes && rm .env` destroys every Golf, Forgejo and PostgreSQL record permanently.

### Step by step

```sh
make setup
make up
# Or include the local CI daemon and RustFS:
make local-up
make local-status
make local-stop
```

`make setup` creates a private, owner-only `.env` with separate Golf and Forgejo database passwords, an encryption key and a stable Forgejo installation UUID. It preserves an existing file. The default stack uses `compose.yaml`, loopback ports 8080 (Golf), 3001 (Forgejo HTTP) and 2222 (Forgejo SSH), and named PostgreSQL/Forgejo volumes. Back up `.env` with the volumes. Configure HTTPS and secure cookies before remote access.

Create the first Forgejo administrator through its native CLI, then enroll a scoped provider credential through Golf's `local-account` command. The upstream rootless Forgejo image stores its files under `/var/lib/gitea` and reads `/var/lib/gitea/custom/conf/app.ini`; these are the upstream image's own filesystem paths (Forgejo's upstream names).

```sh
docker compose exec forgejo forgejo --config /var/lib/gitea/custom/conf/app.ini admin user create --help
```

Golf owns scheduling. Forgejo's own Actions runner is disabled. `make local-up` adds Golf's optional Docker CI worker; policy remains default deny. The default workflow search order is `.forgejo/workflows`, then `.github/workflows`. Exact source, approval, permission and revocation checks still apply.

## Configuration

Set `GOLF_FORGE_KIND=forgejo`, `GOLF_FORGE_URL`, and a stable lowercase UUID v4 `GOLF_FORGE_INSTANCE_ID` for a host-run Golf binary. Optional settings are `GOLF_FORGE_PUBLIC_URL`, `GOLF_FORGE_OAUTH_CLIENT_ID`, `GOLF_FORGE_OAUTH_CLIENT_SECRET`, and `GOLF_FORGE_WORKFLOW_DIRS`. The Compose initializer supplies the instance ID. Register `/auth/forgejo/callback` as the public OAuth callback in Forgejo.

The qualified image is `codeberg.org/forgejo/forgejo:15.0.9-rootless@sha256:caf1bca332f95cdcf124227a4bfa3b49bbbfbbc8a5e4a97406921cb581165413` on Linux amd64. A newer version needs its own API and behavior qualification. Forgejo is separately operated GPLv3+ software; preserve upstream license and source obligations if distributing its image or modifications.

## Kubernetes

The [Helm chart](../deploy/helm/golf/README.md) defaults to the same pinned Forgejo image. Supply a built Golf image, two public origins, an existing Secret, and a stable `forge.instanceID` in a fresh release. The chart creates separate Forgejo/PostgreSQL claims and does not create Secrets. `python3 deploy/helm/golf/check.py` checks offline rendering and invalid configurations. A live Kubernetes rollout and recovery trial remain to be run.

## Qualification

`make forgejo-qualify` starts a disposable pinned Forgejo/PostgreSQL stack, runs Golf against it, checks private Git/source/PR/workflow behavior and removes its owned containers. `python3 scripts/forgejo-qualify.py --integration --output .tmp/forgejo-proof/receipt.json` adds the focused Go race/integration selection. A full retained rollout and performance trial are separate from this disposable qualification.
