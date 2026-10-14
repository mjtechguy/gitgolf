# Cloudflare setup

The selected public control hostname is **`gitgolf.mjtechguy.com`**. Protected applications use separate hostnames under **`previews.mjtechguy.com`**. The user suggested `gitgolf` after selecting `golf.mjtechguy.com`; no DNS change is implied by these source defaults.

## Choose the installation path

| Path | Setup | Current authority |
| --- | --- | --- |
| Portable local | Existing `make local-up`; [README](../README.md). | Go/PostgreSQL/Forgejo, portable storage and runners; Cloudflare optional. |
| Cloudflare migration bridge | This document and `scripts/cloudflare_setup.py`. | Workers serves the existing frontend; protected Tunnel reaches the existing Go/PostgreSQL/Forgejo core; R2 stores supported immutable objects. |
| Cloudflare-native SaaS | [Native repository setup](CLOUDFLARE_NATIVE_SETUP.md), [ADR0008](decisions/0008-cloudflare-native-saas-ownership.md) and [build plan](CLOUDFLARE_BUILD_PLAN.md). | Target: Artifacts canonical Git, partitioned D1 collaboration/authority, Durable Objects coordination, Workers APIs, R2 retained objects. **Not yet an installable forge replacement.** |

The bridge is an explicit migration stage. It does not put canonical repositories in Artifacts, convert PostgreSQL to D1, or execute ordinary product agent tasks in Sandbox. The independently qualified Artifacts agent forks remain an operator prototype until connected to product task admission/results. Do not advertise native parity from a successful bridge installation.

## Prepare a fresh bridge

Prerequisites: Docker with Compose supporting `!reset`, Python 3, OpenSSL, the qualified native `cf` CLI1.0.0-beta.13, and the normal frontend build toolchain. Use a persistent host for PostgreSQL/Forgejo and trusted execution. Container disks in Cloudflare are not a replacement for canonical database/Git volumes.

```sh
python3 scripts/cloudflare_setup.py init \
  --account-id YOUR_ACCOUNT_ID \
  --hostname golf.example.com \
  --bridge-hostname origin.golf.example.com \
  --bucket YOUR_PRIVATE_R2_BUCKET
```

Both hostnames are required. The bridge hostname (here `origin.golf.example.com`) is a service-only origin, distinct from the public control hostname. Create it only as part of the protected origin procedure below. The initializer creates no Cloudflare resources and starts no containers. An existing installation directory is refused; credentials are never rotated on retry.

Private configuration lives in `.cloudflare/install` (0700, Git-ignored), separate from every local `.env*` file. The Compose project is always `golf-cloudflare`; database, native forge and runner volumes have that project prefix. Inherited Golf/Forgejo/Compose/storage variables are stripped before invoking Compose. No host ports are published, and no local RustFS service is included.

The initializer generates new database passwords, encryption and runner keys, a private configuration file, and an origin certificate valid for365days. The certificate covers `golf`, `localhost` and127.0.0.1. Golf and the trusted runner communicate with real TLS; Cloudflare Tunnel must verify the certificate too. The key is readable by the non-root container through its individual read-only mount; its0700 parent restricts host access. Back up this entire directory privately. Certificate rotation requires replacing the matching certificate/key, restarting the bridge and checking both the runner and Tunnel; never disable verification to bypass expiry.

Optional existing consumers are selected at initialization with repeated `--with` flags: `agents`, `email`, `webhooks`, `remote-actions`, `managed-git`. These reuse the existing implementations and preserve their approval/credential requirements. Set their required fields in `bridge.env` before starting:

- `agents`: build the pinned task image, set `GOLF_AGENT_IMAGE` to its digest, and load it into **this** project's dedicated runner daemon. Do not use the old helper's hardcoded `golf-runner-1` destination. For example, after the runner starts, pipe `docker image save IMAGE` to `python3 scripts/cloudflare_setup.py compose exec -T runner docker image load`; configure the digest and start `agent-worker` only after loading it. Existing native harness account selection and permissions still apply.
- `remote-actions`: follow [Actions remote setup](ACTIONS_REMOTE.md), supplying the acquired absolute bundle catalog and this worker's reachable egress address. Existing native execution qualifications do not establish Cloudflare Sandbox parity.
- `managed-git`: set `GOLF_MANAGED_HTTP_GIT_PUBLIC_URL` to the control origin. This retains the existing **read foundation**, not a new protected-write certification. Actual TLS comes from the Tunnel-to-Golf connection. Ordinary native Git/SSH, native OAuth and package routes require separately configured forge ingress; they are not automatically published on the control hostname.
- `email`/`webhooks`: configure the existing transports, subscriptions and egress policies. This does not silently send notifications or replace SMTP with Cloudflare Email Service.

To load an agent image before starting the consumer, use `compose up -d --build runner` after the core is configured. The `compose` subcommand accepts ordinary Compose subcommands and targets this installation; global project/configuration overrides are rejected. It is an operator interface, not a tenant API. Drain work before `up`, which stops the selected project before rebuilding/migrating; `stop` preserves all durable volumes.

## Configure real provider resources

1. Create a dedicated private R2 bucket with public access disabled. Supply bucket-scoped S3 credentials in `bridge.env` as `GOLF_OBJECT_ACCESS_KEY_ID` and `GOLF_OBJECT_SECRET_ACCESS_KEY`. The generated endpoint pins the selected account and uses HTTPS/region `auto`. Do not substitute a Cloudflare management token for S3 credentials. Existing immutable object authorization, conditional writes and digest checks still apply. This moves supported CI sources/artifacts and attachment consumers; it does not move native Forgejo Git/LFS/packages or PostgreSQL records. See [R2 authentication](https://developers.cloudflare.com/r2/api/tokens/).
2. Create an Access application for the **exact bridge hostname**, with a Service Auth policy allowing only a dedicated service token. Record its audience. Do this **before** publishing any DNS/tunnel route. Put the token's client ID/secret in the owner-only `worker-secrets.json`; never put them in a browser bundle or ordinary variables. This transport identity is distinct from Golf user sessions and preview reviewer identity. See [Access service tokens](https://developers.cloudflare.com/cloudflare-one/access-controls/service-credentials/service-tokens/).
3. Create a dedicated remotely managed Tunnel and put its token in `tunnel-token` (0600). Configure its only ingress as the exact bridge hostname, service `https://golf:8443`, origin TLS server name `golf`, CA pool `/run/golf/origin-ca.crt`, and HTTP Host header equal to the public control hostname. Require Access validation with the exact team name and application audience. Finish ingress with `http_status:404`. Keep TLS verification enabled. Publish the bridge DNS record to this exact tunnel only after checking this configuration. See [Tunnel setup](https://developers.cloudflare.com/tunnel/get-started/) and [origin parameters](https://developers.cloudflare.com/tunnel/configuration/origin-configuration/).
4. Check the dedicated namespace for collisions before publishing the public Worker/custom domain. Preserve existing records and services; the initializer does not adopt or delete anything. Build the current frontend and prepare the native CLI bundle:

```sh
npm --prefix web ci
npm --prefix web run build
node cloudflare/control/prepare.mjs .cloudflare/install "$(command -v cf)" web/dist
python3 scripts/cloudflare_setup.py check
python3 scripts/cloudflare_setup.py up
```

The bundle contains the production static UI and the control router; API requests stream to one configured HTTPS bridge with redirects disabled. The router preserves Golf Authorization/Origin, replaces untrusted Access transport headers, withholds transport cookies, and disables caching for every dynamic response. It preserves the origin's preview handoff policy and separate session cookies. Static assets receive no browser credentials. Alternate hostnames and unsupported WebSocket upgrades fail closed; current product live updates use HTTP streaming.

Run the native CLI deployment from `.cloudflare/install` with the selected profile, `--prebuilt`, `--provision false` and `--secrets-file worker-secrets.json`. Do not use automatic provisioning or workers.dev as a bypass around the protected origin. The native build helper disables workers.dev and alternate preview URLs. Inspect the selected profile/account and exact custom-domain target before the first publish.

Bootstrap accounts using the existing [local account procedure](LOCAL_AUTHENTICATION.md), invoking `python3 scripts/cloudflare_setup.py compose exec -T golf ...` for this project. Native forge administration is private; access it from the host or a separately approved private network path. No existing local accounts, encrypted secrets or canonical repositories are imported by this initializer.

## Verify and stop

Source checks: `make cloudflare-check`. The setup test renders actual Compose configuration with every supported optional overlay, verifies private key/config separation and origin TLS names, and checks that inherited local variables cannot select a different project or expose host ports. Worker tests check routes, streaming, authorization preservation, service credential isolation, redirects, multiple session cookies, no-store responses and SPA/API separation. Native build-output validation checks the actual CLI format. None of these constitutes a deployed control-plane proof.

`node cloudflare/control/runtime-check.mjs "$(command -v cf)"` additionally runs the router in the local workerd shipped with the qualified CLI, using a fixture upstream. It checks actual runtime cookie handling and request/response streams, then disposes the runtime. This uses no provider resources. A native `cf deploy --prebuilt --dry-run --provision false` also passes for the116-file production frontend bundle; no upload or resource creation occurs.

After publication, qualify ordinary login/logout, current repository permission loss, source/history, issues/PRs/reviews, CLI/API credentials, live updates, exact artifact upload/download, runner TLS and the separately configured native Git path. Verify the bridge hostname denies anonymous requests and wrong service tokens; the public control hostname must still require Golf authorization for private data. Then test existing Cloudflare D1/R2 allocation and protected-preview consumers independently. Keep provider resource IDs and exact source/runtime receipts; readiness of the static UI alone is insufficient.

```sh
python3 scripts/cloudflare_setup.py status
python3 scripts/cloudflare_setup.py stop
```

Stop test runtimes as soon as verification finishes. `stop` stops bridge containers and retains data; it does not delete the Worker, Tunnel, Access application, R2 bucket, DNS or database/native volumes. Delete only explicitly owned disposable provider resources, in dependency order, with independent absence checks. Persistent installations need coordinated database/Forgejo/R2 backup and restore qualification before production use. The approved test planning envelope remains $10/day, including AI; it is not a Cloudflare billing cap.

## Native work still required

Artifacts canonical repository admission/import/export and current authority; D1 repositories/issues/PRs/reviews/checks; tenant-authorized Sandbox/Artifacts task execution; Workflows/Queues lifecycle and cleanup; automatic protected PR deployment/publication; native recovery; and measured tenancy/cost/scale remain delivery gates. Existing proofs for provider bindings or concurrent fixture agents do not close these product contracts. Follow the [capability map](CLOUDFLARE_BUILD_PLAN.md#service-adoption-map) rather than equating configured service names with implemented integrations.
