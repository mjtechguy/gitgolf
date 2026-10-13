# Forgejo setup

Forgejo 15.0.9 is the default Git backend for fresh portable Golf installs. The default Compose project is `golf-forgejo`; Helm also renders the pinned Forgejo image by default. Cloudflare-native Golf keeps its separate Artifacts/D1/Workers Git backend.

## Local Compose

```sh
make setup
make up
# Or include the local CI daemon and RustFS:
make local-up
make local-status
make local-stop
```

`make setup` creates a private, owner-only `.env` with separate Golf and Forgejo database passwords, an encryption key and a stable Forgejo installation UUID. It preserves an existing file. The default stack uses `compose.yaml`, loopback ports 8080 (Golf), 3001 (Forgejo HTTP) and 2222 (Forgejo SSH), and named PostgreSQL/Forgejo volumes. Back up `.env` with the volumes. Configure HTTPS and secure cookies before remote access.

Create the first Forgejo administrator through its native CLI, then enroll a scoped provider credential through Golf's `local-account` command. The upstream rootless Forgejo image still stores its files under `/var/lib/gitea` and uses `/var/lib/gitea/custom/conf/app.ini`; those are upstream filesystem names, not a Gitea service.

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
