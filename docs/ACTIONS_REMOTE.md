# Opt-in local public Node24 Actions

This profile uses maintained act v0.2.89 to execute the original public checkout and setup-python actions. Its catalog is `golf.workflow.act.v0.2.89.linux.remote-node24.v1`. It is separate from the existing archive, typed-input and agent catalogs. Native Actions scheduling remains disabled; Golf policy and an explicit current native sponsor grant govern push admission.

## Operator-owned dependencies and image

Acquire public actions without controller, forge or job credentials. The output directory must be new:

```sh
python3 scripts/compatibility/acquire-actions.py --output .tmp/actions-cache \
  actions/checkout@9c091bb21b7c1c1d1991bb908d89e4e9dddfe3e0 \
  actions/setup-python@5fda3b95a4ea91299a34e894583c3862153e4b97
```

Both core and worker receive the same read-only `bundles.json`. Admission reconstructs each action's Git tree and commit, checks its metadata and regular Node24 entry points, and freezes its identities into the graph. Execution independently checks the bundles against that graph. Source-selected resolution, private action credentials, nested remote dependencies and Docker/composite remote actions remain unsupported. Git metadata or a hash without the corresponding bytes is insufficient.

The [operator image recipe](../deploy/docker/actions/Dockerfile) pins Ubuntu24, Node24 and the public CPython3.14.8 archive. Build its Linux/amd64 context outside the source tree:

```sh
golf_ci_build=$(mktemp -d)
cp deploy/docker/actions/Dockerfile "$golf_ci_build/Dockerfile"
curl --fail --location --proto '=https' --proto-redir '=https' \
  --output "$golf_ci_build/python-3.14.8-linux-24.04-x64.tar.gz" \
  https://github.com/actions/python-versions/releases/download/3.14.8-36806082737/python-3.14.8-linux-24.04-x64.tar.gz
docker build --platform=linux/amd64 -t golf-ci:node24 "$golf_ci_build"
```

The recipe verifies archive SHA256 `fa74abc70a55c10f6631967784878704eef81bbde9b8ec27469534f6ba997cb3` before running its installer. Package acquisition is trusted operator work. Push the resulting image to an operator registry, use its immutable registry digest for the `ubuntu-24.04` label, approve that exact digest, and seed it into the owned daemon. The engine never builds or pulls a source-selected image.

Python lives in the image's read-only `AGENT_TOOLSDIRECTORY`. The genuine setup-python action selects this cache normally. The unchanged workflow still installs pre-commit and acquires its actual hooks over the controlled dependency path. The Python archive is 110,382,248 bytes and expands to 359,014,273 bytes, so downloading and installing it inside the existing 256MiB job memory ceiling is unsuitable. A cached toolchain does not imply an unrestricted hosted runner or support for every Python version.

## Configuration

Use `deploy/compose/compose.actions-remote.yaml` after `compose.yaml`, `deploy/compose/compose.ci.yaml`, `deploy/compose/compose.actions-engine.yaml` and `deploy/compose/compose.runner-tls.yaml`. Supply:

- `GOLF_REMOTE_ACTIONS_BUNDLES`: absolute path to the acquired `bundles.json`, readable by the core and worker's non-root users.
- `GOLF_RUNNER_GIT_PREPARATION_IMAGE`: approved immutable Git image, preserving the existing exact-H source-preparation contract.
- `GOLF_RUNNER_IMAGES` and `GOLF_RUNNER_APPROVED_IMAGES`: the Git image plus the operator CI image's immutable digest under `ubuntu-24.04`.
- `GOLF_PUBLIC_URL`: canonical HTTPS Git origin without a path prefix. Its certificate must authenticate that hostname and be trusted by the worker.
- Existing runner TLS certificate, key, CA and `GOLF_RUNNER_TLS_URL`. The authenticated control origin can differ from the public Git origin.
- `GOLF_RUNNER_ACTIONS_EGRESS_HOST`: the worker's reachable literal IPv4 address. The local Compose worker shares Golf's network namespace; use that namespace's address and recreate/rebind the worker after core recreation.

The overlay requires existing files and never creates placeholder bind sources. It advertises job Git capability only after actual verified TLS1.3 and refuses assignments that drop the configured Git or remote-action contract. The public Git origin must also reach the actual Golf Git routes; an HTTPS URL alone is not ingress qualification.

## Runtime boundaries

An authenticated CONNECT proxy allows HTTPS only to the selected GitHub and PyPI ecosystem hosts. It resolves and checks all dependency addresses before dialing a pinned literal address. Private, loopback, metadata and reserved dependency destinations are denied. The exact installation Git origin has a separately configured exception; every Git read still checks the job/repository/source capsule and current authority. Git/libcurl receives the standard 407 authentication challenge. Proxy credentials and headers are never forwarded upstream.

The owned attempt daemon's IPv4/IPv6 firewall permits source egress only to that proxy. The engine independently reads back the rules before job release. Jobs run as 1000:1000 with read-only roots, dropped capabilities, no Docker socket, one CPU, 256MiB memory with no swap, and 64 processes. Native tmpfs volumes enforce workspace 128MiB, action environment 256MiB, toolcache 256MiB, and temporary 32MiB limits. Legacy Git jobs retain their earlier 32MiB environment / 64MiB toolcache limits. This is a trusted local Docker worker boundary; it does not qualify hostile tenant isolation.

Job Git capsules last at most five minutes and are renewed before native pre/main/post phases. They allow only their repository's read-only Git discovery and exact admitted H/depth1 fetch. They are not provider API, push, controller or worker credentials. Revocation, lease, graph, namespace and source fences remain live at each read. The workflow-level `github`/`secrets` expression namespaces remain refused in this catalog; native action defaults can consume their scoped job token. Genuine checkout runs with its native token/context; the selected profile refuses alternate repository/ref/token/server, sparse/filter/LFS/submodule options and credential persistence.

All issued capsules, their Basic forms, and proxy credentials are masked across log-frame boundaries. The bounded transcript is released before the terminal completion acknowledgement; this opt-in currently delays log display until completion. Failure/cancellation can withhold an unconfirmed transcript. Native error annotations remain bounded text and cannot create graph progress.

## Qualification and remaining scope

Run the existing isolated native launcher with `--ordinary-actions-bundles` and `--ci-job-image`, its three independently verified binary hashes, exact core/worker image IDs, approved-image seeding, and a passing `--git-image-proof`. It requires a new owner-only output directory and the existing two-GiB reserve. It verifies the original Requests Git commit/tree/workflow independently, creates a private supported native repository and explicit sponsor grant, and delivers an actual signed push. Controlled later commits exercise denied/direct egress, a failed command, job timeout, running cancellation and exact-owned teardown.

Requests' declared `pull_request` trigger is preserved, but this increment executes its sponsor-authored push path only. PR/fork contexts, private remote actions, broad checkout options, provider artifact/cache APIs, services, full expression/event parity, long-step credential refresh, aggregate network quotas and retained deployment remain separate gates. The [compatibility register](compatibility/README.md) tracks evidence without marking the full compatibility plan complete.

[Actual local Requests receipt](compatibility/evidence/requests-local.json) records the passing original push and three controlled runtime outcomes. [Source and PostgreSQL checks](compatibility/evidence/m2-checks.json) record validation separately. The retained installation is not upgraded by this qualification.
