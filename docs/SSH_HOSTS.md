# SSH hosts (agents plan phase 1b and the private-network reach of phase 5)

Contract for SSH hosts on the Cloudflare-native runtime. An SSH host is a machine Golf
connects to over SSH. Codex, Claude Code, OpenCode or Grok are installed and signed in
there, and no Golf software runs on it. "Assign to agent" on an issue or pull request
can choose an SSH host. The result is what an outbound agent host produces
([AGENT_HOSTS.md](AGENT_HOSTS.md)): a proposal branch `golf-agent/<id8>`, a live log
and a finish that Golf verifies.

Status: built and verified locally (see the dated entry in
[IMPLEMENTATION_STATUS.md](IMPLEMENTATION_STATUS.md)). Nothing runs on a hosted
installation until the deploy changes at the end of this document are made.

## Model: an agent host Golf reaches itself

An SSH host is an `agent_hosts` row plus an `ssh_hosts` row (schema 47, migration
`0047_ssh_hosts.sql`). The migration may only `CREATE … IF NOT EXISTS`, so a `kind`
column cannot be added to `agent_hosts`. The two rows are told apart as follows:

- `agent_hosts.credential_digest` is `ssh:<uuid>`, never a SHA-256, so no host
  credential can match it;
- `host_version` is `ssh`.

Reusing the agent host row means these work without change:

- scope (personal, organization or installation) and who manages it;
- sharing (`shareSignins`, allowed users and repositories);
- enabled tools and `maxConcurrent`;
- the six admission rules, task states, deadlines, cancel and the LOST sweep;
- the task protocol and the task Git route;
- the agentic inbox and `pull_request_origins`.

`ssh_hosts` holds what only SSH needs:

- the address, port, account and an optional work directory;
- the reach and its non-secret settings (Tailscale tags, Access service token id);
- Golf's public key and its fingerprint;
- the sealed private key and the sealed reach secrets, with the key id;
- the pinned host key, who pinned it and when;
- the latest connection test.

`/native/agent-hosts list` no longer returns SSH hosts, and `/native/agent-hosts delete`
refuses them, because deleting through `/native/ssh-hosts` also erases the key.
`/native/agent-hosts update` still edits their sharing, tools, state and concurrency
(the Edit form). Task views carry `host.kind` (`agent` or `ssh`). `available` lists SSH
hosts with `kind: 'ssh'` and `online: true`: Golf connects when a task starts.

Admission rule 3 adds one check for SSH hosts. A task is refused (`host_unavailable`,
"Rule 3 (host): …") when:

- the host has no confirmed host key;
- or its reach is unavailable on this installation.

The check runs at create, at Golf's claim and on every task Git request. Rule 6 (tools)
uses the tools the last proven connection test reported.

## Security

- **Golf's key.** Golf generates one Ed25519 key pair per host with WebCrypto.
  - The public key (`ssh-ed25519 … golf-ssh-host-<id8>`) is shown after create and
    under Key. It is not secret.
  - The suggested `authorized_keys` line is `restrict <key>`: no forwarding, no
    terminal.
  - The PKCS#8 private key is sealed with the credential vault's envelope
    (`sealSecret` / `openSecret` in `vault.mjs`), with context
    `ssh-host:<uuid>:key`, under the installation key `EXECUTION_VALUE_KEY`.
  - The private key is never in a view, log, audit row or error. It leaves the Worker
    only in the job a task's own container receives on standard input. It is held in
    memory there and never written to disk.
  - Rotate key replaces the pair.
- **Reach secrets** (the Tailscale auth key, the Access service token secret) are sealed
  the same way, with context `ssh-host:<uuid>:reach`. Views say only that one is set.
- **Host key pinning: trust on first use, but only explicitly.**
  1. A connection test without a pinned key only reads the key the host offers. It does
     not authenticate.
  2. Golf computes the SHA256 fingerprint itself; it never takes one from the report.
  3. A manager compares it with `ssh-keygen -lf /etc/ssh/ssh_host_…_key.pub` on the
     machine and confirms. `trustHostKey` accepts only the fingerprint the latest test
     was offered.
  4. From then on every connection must present exactly that key. Golf asks the server
     for that key type, and a different key fails before authentication and before
     anything is sent.
  5. Changing the address, port or reach forgets the pin and the test. A confirm is
     fenced on the host version and on the test result it read, so a confirm that
     started before a move, a rotation or a new test pins nothing.
- **The task token never reaches the SSH host.**
  - The container clones with the token over HTTPS, exactly as the outbound host does.
  - It sends the host a working copy with `.git` but no remote, plus the prompt.
  - It runs the tool there, brings back the working tree (never `.git`), then commits,
    pushes and finishes itself.
  - The SSH host needs no route to Golf.
  - Golf MCP (the `mcp` claim field) is therefore not connected for SSH host tasks, so
    the token is never placed in the remote tool's environment.
- **Untrusted output.** The returned tree is extracted with every member checked:
  - paths must be relative, with no `..`;
  - nothing is written through a symlink;
  - only regular files, directories and symlinks are taken;
  - at most 1 GiB and 200,000 entries.

  The proposal is one commit by `Golf agent (<tool>) <agent@golf.invalid>` with the
  `Golf-Agent-Task: <id>` trailer. Any commits the tool made are folded in.
- **The tool on the host.**
  - It runs as the SSH account in the account's login shell, so it finds tools on the
    profile's PATH.
  - It uses the outbound host's fixed argument table (`tools.go`), with the prompt on
    standard input from a file. Grok uses `--prompt-file`. The prompt is never in argv.
  - Its working directory is `<work directory or ~/.golf-agent/work>/<task id>`, mode
    0700, and is removed whatever happens.
  - A dedicated account on the machine is recommended. Codex is reported only when its
    `workspace-write` sandbox works there, as on outbound hosts.
- **Audit:**
  - `ssh_host.create`, `ssh_host.update`, `ssh_host.delete`, `ssh_host.test`,
    `ssh_host.trust_host_key` (with the fingerprint) and `ssh_host.rotate_key`, in the
    Coding agents category;
  - scope as for agent hosts;
  - secrets appear only as `set` or `cleared`.

## Reach

| Reach | How the container reaches the SSH port | Needs |
| --- | --- | --- |
| `direct` | TCP to `address:port` (the container has Internet egress) | The port is reachable from Cloudflare's network |
| `tailscale` | `tailscaled --tun=userspace-networking --state=mem:` (an ephemeral node, no root, no device), then `tailscale up --auth-key=file:… --hostname=golf-<id8> --advertise-tags=…`, then `tailscale nc address port`. At the end it runs `tailscale logout` | A reusable, ephemeral, pre-approved auth key tagged for the tags, and tailnet ACLs that let those tags reach the SSH port |
| `cloudflare-tunnel` | `cloudflared access ssh --hostname <address>`, with `TUNNEL_SERVICE_TOKEN_ID` / `_SECRET` in its environment when an Access service token is set | cloudflared on the machine's side with a public hostname for SSH, behind Access |
| `workers-vpc` | The container listens on TCP 2222. The Durable Object connects to it (`ctx.container.getTcpPort(2222).connect()`) and to `env.SSH_VPC_NETWORK.connect("address:port")`, and pipes the two | A `vpc_networks` binding named `SSH_VPC_NETWORK` (a Tunnel or Cloudflare Mesh) |

Each reach reports itself as available or unavailable with its reason (`reaches` in
`list`). Creating a host or testing it with an unavailable reach is refused with that
reason.

### Decision: SSH runs inside a Container, not in the Worker

Evidence gathered on 2026-10-15:

- **(b) Workers TCP sockets and SSH in JavaScript, rejected.**
  - `cloudflare:sockets` gives raw TCP, but SSH needs a full transport: key exchange
    (curve25519 / ECDH), host key and signature verification, AES-GCM or ChaCha20
    framing, channels and flow control.
  - There is no SSH library in the Worker bundle, and writing one is a large
    security-sensitive surface.
  - The task also needs Git (a clone, a commit tree, a push) and tar, and runs up to
    two hours. That does not fit a Worker request or a Durable Object alarm doing CPU
    work.
- **(a) A Container driven by a Durable Object, chosen.** It follows the
  `PRAgentTask` / `PRTestTask` pattern (`ctx.container`). The binary is
  `cmd/golf-agent-host` in two new modes, `ssh-run` and `ssh-probe`:
  - SSH comes from `golang.org/x/crypto/ssh`, already a Golf dependency (no new module);
  - the tool table, output parsers, log stream, Git runner and task protocol client are
    the outbound host's own code, unchanged;
  - SSH-only code is in new files: `ssh_conn.go`, `ssh_run.go`, `ssh_tar.go`,
    `ssh_test.go`.

  `main.go` only gains the two subcommands.
- **Workers VPC from a Container.** Checked against the Cloudflare docs on 2026-10-15:
  - Workers VPC networks (`vpc_networks`, `network_id: "cf1:network"` or a
    `tunnel_id`) give a Worker `connect()` for raw TCP, plaintext only. SSH is
    encrypted end to end, so that is enough.
  - The Workers VPC pages say nothing about Containers.
  - Container outbound interception (`interceptOutboundHttp(s)`) covers HTTP and HTTPS
    only; there is no TCP interception.
  - What is documented and composes: `ctx.container.getTcpPort(port).connect()` from
    the Durable Object, and `env.SSH_VPC_NETWORK.connect()`.
  - So the `workers-vpc` reach is a Durable Object bridge. It is implemented and tested
    locally with a socket standing in for the VPC network.
  - It is not verified against a real VPC network. Durable Object lifetime while it
    only pipes bytes is also not documented. The alarm keeps the object busy every
    15 seconds.
  - The reach stays unavailable, with that reason, until the binding exists. Tailscale
    and Cloudflare Tunnel inside the container are the documented alternatives for
    private machines.

## Execution

`SSHAgentTask` (`cloudflare/forge/src/ssh-task.mjs`) is a SQLite Durable Object with a
container, used as one object per task (`task:<id>`) or per test (`probe:<id>`).

1. **Dispatch, with no polling.** `create` on `/native/agent-tasks` for an SSH host
   inserts the task as usual, then Golf claims it at once with the claim's rules:
   - admission is re-checked; a refusal is `FAILED` `refused_<code>`;
   - the token `golf_agent_task_<id>_<64 hex>` is stored as SHA-256;
   - the deadline counts from the claim;
   - `last_seen_at` of the host is set;
   - `maxConcurrent` is respected; further tasks stay `QUEUED`.

   Golf then calls `SSHAgentTask.run({ taskId, hostId, token })`. If that call fails,
   the task becomes `FAILED` `ssh_dispatch_failed`. Queued SSH tasks are also dispatched
   by the maintenance sweep (the indexes stage), and by the object of a task that just
   ended.
2. **Launch** (alarm):
   - the object builds the job: the claimed task in the protocol's shape, and the
     connection with the opened private key and reach secrets;
   - it starts the container (`images.ssh`, `standard-1`, `sleep infinity`,
     `enableInternet: true`);
   - it runs `golf-agent-host ssh-run` with the job on standard input;
   - it forgets the token.
3. **Watch** (every 15 seconds):
   - it calls in for the host (`last_seen_at`; the LOST sweep reads it);
   - when the task is terminal, it destroys the container and dispatches the next
     queued task;
   - when the container stops early, the task becomes `LOST` `ssh_runner_lost`;
   - on a cancel request, `ssh-run` normally finishes `cancelled` within seconds. After
     60 seconds the object destroys the container and marks the task `CANCELLED`;
   - 60 seconds past the deadline the task becomes `TIMED_OUT`.
4. **`ssh-run`:**
   - it validates the task as the host does;
   - calls `start`;
   - streams the log (1-second chunks), and polls for a cancel with an empty log chunk
     every 10 seconds while nothing is pending;
   - clones; connects (reach, pinned key, Golf's key);
   - creates the remote working directory and sends the tar;
   - runs the tool and records the process group. On cancel or deadline it sends the
     session `SIGTERM`, kills the group, then `SIGKILL` after 5 seconds;
   - brings back the tree; commits, pushes and finishes;
   - removes the remote directory.

   Failure reasons it reports, with credentials redacted:
   - `connect_failed: …`, `prepare_failed`, `upload_failed`, `download_failed`;
   - `tool_unavailable: … not installed for <account>`, exit 127;
   - the outbound host's `clone_failed`, `commit_failed` and `push_failed`.
5. **Connection test** (`test`):
   - `SSHAgentTask.probe` runs `golf-agent-host ssh-probe` with `{ ssh }` on standard
     input and reads one JSON report from standard output:
     `{ hostKey, fingerprint, matched, authenticated, os, arch, tools, error }`.
   - Golf records it only for the latest test id. Tools, OS and `last_seen_at` are
     updated only when the pinned key was proven and Golf's key accepted.
   - A test that never reports fails after 5 minutes (sweep).

## User API: `POST /native/ssh-hosts`

This uses a browser session (Cloudflare Access), as `/native/agent-hosts` does; API
tokens are refused. Managers are the same as for agent hosts: personal → the owner,
organization → its owners, installation → operations administrators. Organization
members may `list` without the public keys.

- `list` `{ scope, organization? }` → `{ hosts, canManage, capability, reaches }`.
  - Each host is the agent host view plus `kind: 'ssh'`, `address`, `port`, `user`,
    `workDirectory`, `reach`, `reachAvailable`, `reachReason`.
  - Then `tailscale: { tags, ephemeral: true, authKeySet }` or
    `tunnel: { clientId, clientSecretSet }`.
  - Then `publicKey` (managers only) and `keyFingerprint`.
  - Then `hostKey: { pinned, fingerprint, type, pinnedAt, pinnedBy }`.
  - Then `probe: { state, startedAt, finishedAt, offered: { key, type, fingerprint }, matched, authenticated, os, arch, toolCount, error }`,
    and `ready` and `readyReason`.
- `create` `{ scope, organization?, name, address, port?, user, workDirectory?, reach, tailscale?: { authKey, tags }, tunnel?: { clientId, clientSecret }, enabledTools? }`
  → `{ host, publicKey, authorizedKey, installCommand }`.
  - It needs the sealing key and an available reach.
  - It is limited to 100 agent hosts per scope.
  - `tailscale.authKey` is required for the tailscale reach. An Access token id and
    secret go together or not at all.
- `update` `{ id, expectedVersion, name?, address?, port?, user?, workDirectory?, reach?, tailscale?, tunnel? }`
  → `{ host }`. This is for connection settings only.
  - Omitted secrets are kept. A changed reach clears that reach's settings.
  - A new address, port or reach clears the pin. A new address, port, reach or account
    clears the reported tools and the test.
- `test` `{ id }` → `{ host }` with `probe.state` `RUNNING`. Only one test runs at a
  time (409).
- `trustHostKey` `{ id, expectedVersion, fingerprint }` → `{ host }`. It is refused (412) when the version or the
  latest test result changed after the review.
- `rotateKey` `{ id, expectedVersion }` → `{ host, publicKey, authorizedKey, installCommand }`.
- `delete` `{ id }`: erases the `ssh_hosts` row (key and secrets), marks the agent host
  deleted, cancels queued tasks, and tells running tasks to stop.

Limits: `address` is a host name, IPv4 or IPv6 (for `cloudflare-tunnel`, the Access
hostname); `port` 1–65535; `user` `^[A-Za-z_][A-Za-z0-9_.-]{0,31}$`; `workDirectory`
absolute, no `.` or `..`; Tailscale tags `tag:[a-z0-9-]`, up to 8.

## Capability

`agents.ssh-hosts`:

- **READY** with schema 47, `SSH_HOSTS_EXECUTION=true`, the `SSHAgentTask` export and
  `EXECUTION_VALUE_KEY`.
- **UNCONFIGURED** otherwise, with the reason naming what is missing, for example
  "SSH hosts are unavailable on this installation: it needs the SSHAgentTask Durable
  Object with its SSH container (SSH_HOSTS_EXECUTION)…".
- **DISABLED** before schema 47.
- Under the `agent-hosts` feature policy, as `agents.hosts` is.

The settings page shows the SSH section whenever the capability is listed. It shows the
reason and turns Add off when the capability is not READY.

## UI

Settings → Agent hosts (personal, organization and admin) has an **SSH hosts** section
under the agent host inventory:

- the shared DataTable with host, reach, status, host key (shortened, full in the
  title), tools, active tasks and state;
- **Add SSH host** (TanStack Form): name, reach and its fields, address, port, account,
  work directory, tools;
- **Install Golf's key**: the `authorized_keys` line and a one-line command, then Test
  connection;
- **Review host key**: the offered fingerprint and the `ssh-keygen -lf` command to
  compare it with, then Trust this host key, followed by a second test;
- row actions: Test connection, Edit (the agent host sharing form), Connection, Key and
  Delete.

The assign dialog labels SSH hosts "SSH host, Golf connects when the task starts".

## Container image

`cloudflare/ssh-hosts/Dockerfile`, built from the repository root:

```
docker build --platform linux/amd64 -f cloudflare/ssh-hosts/Dockerfile -t <repository>:<tag> .
```

- **Build stage:** golang 1.27 builds `golf-agent-host` (CGO off).
- **Runtime stage:** debian bookworm-slim with ca-certificates and git, plus:
  - Tailscale 1.104.1, static tarball, SHA-256 checked;
  - cloudflared 2026.10.0, SHA-256 checked;
  - user 1000;
  - `CMD sleep infinity`.

## Deploy

**One-command installer:** add the `ssh-hosts` service. It brings `secrets` with it, applies
schema 47 and deploys. With `--ssh-vpc-tunnel-id`, it also renews the deployment token so the
token may bind the Tunnel:

```sh
python3 scripts/golf_cloudflare.py install ... --with ssh-hosts [--ssh-vpc-tunnel-id TUNNEL_UUID]
python3 scripts/golf_cloudflare.py update DIR --with ssh-hosts [--ssh-vpc-tunnel-id TUNNEL_UUID]
```

**Alchemy actions:** run `enable-secrets` first if the installation has no repository value
key, then:

```sh
python3 scripts/cloudflare_alchemy_demo.py migrate DIRECTORY
python3 scripts/cloudflare_alchemy_demo.py enable-ssh-hosts DIRECTORY [--vpc-tunnel-id TUNNEL_UUID]
python3 scripts/cloudflare_alchemy_demo.py renew-deploy DIRECTORY   # only with --vpc-tunnel-id
python3 scripts/cloudflare_alchemy_demo.py plan DIRECTORY
python3 scripts/cloudflare_alchemy_demo.py deploy DIRECTORY
```

`--vpc-tunnel-id` binds that Cloudflare Tunnel as the `vpc_networks` binding `SSH_VPC_NETWORK`,
which turns on the `workers-vpc` reach. The deployment token then also carries **Connectivity
Directory Admin** and **Cloudflare Tunnel Read**. Without the Admin role, Cloudflare refuses the
binding with "Workers VPC binding configuration failed because your credentials are not authorized";
**Connectivity Directory Bind** alone was not enough on the hosted account.

The stack then stages a build context in `DIRECTORY/ssh-image` holding only `go.mod`, `go.sum`,
`cmd/golf-agent-host` (without tests) and the Dockerfile, never the repository root. From it, it:
- builds the image as the container application `ssh` (repository `<worker>-ssh`, scheduling
  `durable_object`, logs off);
- binds `SSHAgentTask` to it;
- sets `SSH_HOSTS_EXECUTION=true`.

Alchemy adds the `new_sqlite_classes` migration itself.

The first deploy that adds the class can stop with "requires a resolved Durable Object namespace"
after the Worker upload. The container application is reconciled before the Worker has created the
new namespace. Run `plan` and `deploy` again; the second run creates only the container
application.

**Other deploy tools need the same pieces:**

1. **Container application:**
   - image built from `cloudflare/ssh-hosts/Dockerfile`, linux/amd64;
   - scheduling policy `durable_object`;
   - the image key must be **`ssh`**: the class starts `this.container.images.ssh` as `standard-1`
     with Internet egress.

   Each task and each connection test holds one instance while it runs; a test takes under a minute.
2. **Durable Object:**
   - `SSHAgentTask`, SQLite storage, bound to that container;
   - its `new_sqlite_classes` migration.

   It is exported from `worker.mjs`, `test-entry.mjs` and `agent-entry.mjs`.
3. **Text binding** `SSH_HOSTS_EXECUTION = "true"`. The Workspace only hands
   `ctx.exports.SSHAgentTask` to the code when this is set, so the capability stays
   UNCONFIGURED until both exist.
4. **`EXECUTION_VALUE_KEY`** (the existing Secrets Store binding used by repository
   values and the vault) must be bound. Without it, keys cannot be sealed.
5. **Optional, Workers VPC:** a `vpc_networks` binding named `SSH_VPC_NETWORK` with
   either `tunnel_id` or `network_id: "cf1:network"` (Mesh). Binding a tunnel needs the
   Connectivity Directory Admin role. Without it the `workers-vpc` reach reports itself
   unavailable. The Alchemy stack binds one with `--vpc-tunnel-id`.
6. **Schema 47:** apply `0047_ssh_hosts.sql`.
7. **Nothing else.** No new secrets: Golf generates the SSH keys. `PUBLIC_ORIGIN` must be
   the origin the container reaches, because the clone, log and finish go there over
   HTTPS from the container.

## Setting up reach

Every reach ends at an ordinary `sshd`. On the machine:
1. Create a dedicated account for Golf (no sudo).
2. Sign the coding tools in as that account, for example `sudo -iu golf-agent claude`, then `/login`.
3. Install the `restrict` line Golf shows after **Add SSH host** in that account's
   `~/.ssh/authorized_keys`. Each host entry in Golf has its own key.
4. Run **Test connection**.
5. Compare the offered fingerprint with `ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub` on the
   machine, then **Trust this host key**.

- **Direct:** the SSH port must be reachable from Cloudflare's network. Most machines behind NAT
  are not; use one of the reaches below.
- **Tailscale:**
  1. Add a tag owner to the tailnet policy, for example `"tagOwners": {"tag:golf-ssh": ["autogroup:admin"]}`.
     A tagged node is not one of your own devices, so `autogroup:self` SSH rules do not cover it.
  2. If the policy is not allow-all, let the tag reach the machine's port 22.
  3. Generate an auth key that is **reusable** and **ephemeral**, tagged with that tag. Use a short
     expiry and replace it under **Connection** when it expires.
  4. In Golf, choose reach **Tailscale**, the machine's tailnet address, the key and the same tag.

  Each task joins as an ephemeral node `golf-<id8>` and logs out at the end.
- **Cloudflare Tunnel:**
  1. Create a remotely managed tunnel with one ingress rule, `<hostname> → ssh://localhost:22`,
     and a proxied CNAME `<hostname> → <tunnel id>.cfargotunnel.com`.
  2. Run `cloudflared tunnel run --token-file …` on the machine.
  3. Protect the hostname with an Access application of type `self_hosted`, whose only policy is
     **Service Auth** (`non_identity`) for a dedicated Access service token.
  4. In Golf, choose reach **Cloudflare Tunnel** with that hostname and the token's client ID and
     secret. Golf seals the secret.

  Without the token, Access refuses the WebSocket ("bad handshake"), so `sshd` (which may still
  accept passwords) is never exposed publicly.
- **Workers VPC:** the same tunnel can serve. Deploy with `--vpc-tunnel-id <tunnel id>`, then use the
  machine's private address as Golf sees it from the connector, for example its LAN address with
  port 22. The Worker connects through the tunnel's connector, so `sshd` sees the connector's
  address.

## Not done, and what remains to verify

- **Hosted run (2026-10-15):** every reach is verified from the hosted container. Details are in
  [IMPLEMENTATION_STATUS.md](IMPLEMENTATION_STATUS.md).
  - **Direct:** a probe of `github.com:22` pinned GitHub's published host key and reported the
    refused key.
  - **Tailscale, Cloudflare Tunnel and Workers VPC:** each ran a Claude Code task end to end on the
    same machine.
  - **The first Workers VPC test failed:** the container's TCP port reports a connection opened before
    anything listens. The bridge now waits for a listening socket in `/proc/net/tcp` before it
    connects.

  Still to verify:
  - an agent that may run the repository's tests on the host. Claude Code asked for approval to
    run `npm test` and was refused, as on outbound hosts;
  - Durable Object lifetime while a long Workers VPC task only bridges (tasks of about a minute
    are verified).
- **Golf MCP** for SSH host tasks. That would need the task token on the remote host,
  or a relay through the container, which is a deliberate follow-up.
- **Login shells.** Remote commands assume a POSIX-compatible login shell: bash, zsh,
  sh, dash or ksh. fish and other non-POSIX shells read the outer command but are not
  tested. The account needs `tar`.
- **Codex** is reported only when its sandbox works on the host. There is no per-SSH-host
  `danger-full-access` switch yet.
- **One SSH connection per task.** There is no connection reuse across tasks, and no
  agent forwarding or jump hosts. A `ProxyJump` chain is not supported. Use Tailscale or
  Cloudflare Tunnel instead.
