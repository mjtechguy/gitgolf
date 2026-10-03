# Codex CLI local runtime foundation

For ordinary account setup, use [Coding agents inside Golf](CODEX_ACCOUNTS.md). This opt-in operator runtime is a separate Codex-first N5 execution experiment. It is separate
from the network-disabled CI executor and is not yet Golf's managed connection,
task, repository permission, or browser setup service. The coding-agent capability
must remain unavailable until those consumers are implemented and qualified.

Build `docker build -t golf-codex:development -f Dockerfile.codex .`, then obtain
its actual local ID with `docker image inspect golf-codex:development --format
'{{.Id}}'`. The image installs Codex CLI0.160.0 and Git on a digest-pinned Node
base. Every connection pins that actual ID; a mutable tag or a different image is
refused. The fixed [container security profile](../deploy/docker/codex/README.md)
keeps Codex's workspace sandbox enabled. Local arm64 qualification does not
establish amd64, Kubernetes, Cloudflare or hostile-tenant isolation.

Use a fresh owner-only directory outside the checkout, with an existing private
parent directory. The helper creates the connection directory with mode0700 and
stores a random connection identity/image/volume binding; it never reads the
operator's existing `~/.codex` login. For example:

```sh
python3 scripts/codex-local.py --image '<LOCAL_SHA256_IMAGE_ID>' \
  --state-directory /absolute/private/golf-codex login-device
python3 scripts/codex-local.py --image '<LOCAL_SHA256_IMAGE_ID>' \
  --state-directory /absolute/private/golf-codex status
```

Device login prints only the official browser URL and one-time code. A human
must authorize it; device login availability depends on account/workspace
settings. Alternatively, `login-api --key-file /absolute/private/openai-key`
requires an owned0600 regular file and passes its contents to native Codex login
through stdin, never Docker environment or command arguments. Native cached
login success is **not** proof of model entitlement or successful inference.
See [official authentication](https://learn.chatgpt.com/docs/auth).

The named auth volume is private operator-managed native credential state;
it is not encrypted by Golf's keyring and is not covered by the canonical Golf
recovery archive. Protect the Docker host/storage accordingly. A local file lock
serializes the complete login/status/run/disconnect lifecycle. Native Codex owns
refresh writes in that volume. Existing attempt containers cause refusal until
explicit `disconnect` confirms their ownership, stops/removes them and removes
the auth volume. Expired locks do not imply a remote process stopped. The lock
directory remains after disconnect to prevent unlink/recreate locking races.
This is single-host ownership, not a distributed OAuth refresh service.

Only explicitly trusted source is admitted. Account-auth automation is limited
to trusted private workflows under [OpenAI's advanced account-auth
guidance](https://learn.chatgpt.com/docs/auth/ci-cd-auth). The operator supplies
and authorizes source; the helper does not establish native repository access
or independently verify the supplied commit label. Canonical source SHA256 is
recorded. The ordinary tar snapshot rejects Git/Codex configuration, links,
special files, traversal, duplicates and file-parent collisions, with16MiB total,
4096 entries and8MiB per-file bounds. LFS hydration, submodules, full Git history
and existing harness sessions are unsupported.

```sh
python3 scripts/codex-local.py --image '<LOCAL_SHA256_IMAGE_ID>' \
  --state-directory /absolute/private/golf-codex run --trusted-source \
  --source /absolute/private/source.tar --commit '<40_OR_64_HEX_COMMIT>' \
  --prompt-file /absolute/private/task.txt \
  --output-directory /absolute/private/new-result --timeout 300
```

The prompt must be an owned0600 file. Each task has a fresh bounded tmpfs
workspace and synthetic Git baseline, UID1000, read-only root, no capabilities,
no-new-privileges and no Docker socket, host workspace, forge/admin or deployment
credential. Native `codex exec --json` uses workspace-write, no approvals,
ignored user config/rules and ephemeral sessions. Actual model/auth traffic
needs network access outside the shell sandbox; there is no qualified provider
egress firewall. Credentials required by the harness reside in its runtime;
shell write denial does not establish read confidentiality from every agent
tool. This trusted local profile must not be advertised as multi-tenant isolation.

Only an ordered native thread/turn terminal stream plus successful process exit
can mark inference complete. Agent prose cannot. Completion is separate from
independent tests and publication. The container is paused before collecting a
bounded regular-file checkpoint; no agent-modified Git hooks/config execute during
collection. Private0600 JSONL/stderr, canonical checkpoint, text diff preview and
binary hash transitions stay in the fresh result directory. Nothing is applied
or pushed. Timeout/cancellation stops and removes the attempt before releasing
the credential lock; interrupted work is not automatically resumed or replayed
and may have only partial event evidence, without a checkpoint.

Runnable checks: `python3 scripts/codex-local-test.py`,
`python3 scripts/codex-sandbox-smoke.py --image <ID>`, and
`python3 scripts/codex-local-smoke.py --image <ID>`. The last deliberately uses
an invalid API key to prove cache persistence, failed/cancelled native execution,
private artifacts and cleanup; it cannot qualify paid model execution or OAuth
renewal. Real device login, authorized successful repository work, token renewal,
revocation and managed Golf integration remain distinct acceptance evidence.
