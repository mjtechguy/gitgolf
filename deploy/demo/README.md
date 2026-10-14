# Repeatable Cloudflare demo

Two paths deploy the same retained, Cloudflare-native Golf installation on your own
account: this Python/`cf` installer and the [Alchemy deployment](../alchemy/README.md).
Use one resource owner per installation. Alchemy also carries the optional services
(AI, semantic search, pipelines, email, webhooks...) and token renewal; a `cf`
installation reaches them by [handing off to Alchemy](#hand-off-to-alchemy-for-optional-services).

## What you provide

| Value | Flag | How to obtain |
| --- | --- | --- |
| Account ID | `--account-id` | Dashboard account home, or the `accounts` list in `cf --profile golf auth whoami` (32 hex). Workers Paid and Artifacts must be enabled. |
| `cf` CLI profile | `--profile` | `cf auth create golf` (OAuth login into a named profile). Do not export `CLOUDFLARE_API_TOKEN`/`CF_API_TOKEN`; the scripts refuse ambient tokens. |
| Workers subdomain | `--workers-subdomain` | Workers & Pages > Overview, the `NAME` in `NAME.workers.dev`. |
| Zone ID | `--zone-id` | The zone's Overview page (32 hex). Both hostnames must be in this zone. |
| Control hostname | `--hostname` | An unused name in that zone, such as `golf.example.com`. Must not have DNS records, Workers domains or Access apps yet. |
| Preview hostname | `--preview-hostname` | A second unused name, such as `golf-previews.example.com`; previews use it and its children. |
| Administrator email | `--email` | An email that can sign in through Cloudflare Access (an available Zero Trust seat). Golf creates an email-code login for it. |
| Secrets Store ID | `--secrets-store-id` (optional) | Required only if the account already has a store (one per account): its ID on the dashboard's Secrets Store page. Only installation-prefixed secrets are created and removed. |
| Admin login | `--admin-login` (optional) | Golf login for the administrator. Default: derived from the email's local part (`jane.doe@...` becomes `jane-doe`). |
| Content | `--manifest PATH` or `--no-seed` (one is required) | `deploy/demo/example.json` imports one neutral organization with two small public repositories. `--no-seed` imports nothing beyond the CI/preview playgrounds. Write your own manifest in the same schema for other content. |

Tools: Docker, Node 24, Python 3, Git and the qualified `cf` 1.0.0-beta.13 CLI.
Install the locked build dependencies once: `npm --prefix web ci` and
`npm --prefix cloudflare/agents ci`.

## First install (Python/`cf` path)

```sh
python3 scripts/cloudflare-demo-deploy.py build-image
python3 scripts/cloudflare-demo-deploy.py create \
  --account-id ACCOUNT_ID --profile golf --workers-subdomain WORKERS_SUBDOMAIN \
  --zone-id ZONE_ID --hostname golf.example.com \
  --preview-hostname golf-previews.example.com --email you@example.com \
  --manifest deploy/demo/example.json
# add --secrets-store-id STORE_ID if the account already has a Secrets Store,
# --admin-login LOGIN to choose the login, or replace --manifest with --no-seed
```

`create` runs the qualification launcher with a retained demo: fresh D1, Artifacts
namespace, Workers, Access applications and an email-code identity provider, two
CI/PR/preview playground repositories, managed CI and a seven-day deployment. It then
claims the administrator's personal owner and imports the manifest's organizations,
pinned GitHub snapshots, CI and metadata indexes. It prints the private ownership
receipt (`.tmp/cloudflare-forge/golf-native-*/ownership.json`). A failed run leaves
its receipt and original operation identities for inspection. Sign in at
`https://golf.example.com` with the administrator email.

An explicitly reused store retains its other secrets; each installation creates
uniquely prefixed secrets and owns only those entries. Do not point a new deployment
at an occupied hostname.

### Hand off to Alchemy for optional services

The `cf` installer does not implement the `enable-*` actions (AI, search, pipelines,
email, webhooks, analytics, rate limits, secrets) or provider-token renewal. To use
them, replace the `cf` installation with an Alchemy one built from its receipt:
`create` writes everything `prepare` reads (the retained `ownership.json`, its
`forge.json` and the administrator row in D1).

```sh
npm --prefix deploy/alchemy ci
python3 scripts/cloudflare_alchemy_demo.py prepare /PATH/TO/ownership.json   # prints NEW_DIRECTORY
python3 scripts/cloudflare_alchemy_demo.py plan NEW_DIRECTORY
python3 scripts/cloudflare-demo-deploy.py renew-authority /PATH/TO/ownership.json
python3 scripts/cloudflare_demo.py stop /PATH/TO/ownership.json
python3 scripts/cloudflare_alchemy_demo.py deploy NEW_DIRECTORY
python3 scripts/cloudflare_alchemy_demo.py seed NEW_DIRECTORY --manifest deploy/demo/example.json
# then any enable-* action, for example:
python3 scripts/cloudflare_alchemy_demo.py enable-ai NEW_DIRECTORY
python3 scripts/cloudflare_alchemy_demo.py renew-deploy NEW_DIRECTORY
python3 scripts/cloudflare_alchemy_demo.py deploy NEW_DIRECTORY
```

This is a replacement, not an in-place adoption: Alchemy creates fresh resources on
the same hostnames, so the `cf` installation is stopped first and its D1 history is
not carried over (content is reseeded from the manifest; back up D1 first if you
need it). `prepare` keeps the administrator's email and current login; pass
`--admin-login`, `--git-author-name` or `--git-author-email` to change them. If you
want the optional services from the start, use Alchemy's
[fresh install](../alchemy/README.md#fresh-install) instead.

## Content manifests

| File | Contents |
| --- | --- |
| `example.json` | Neutral sample: organization `example-org` with `click` and `itsdangerous`, pinned commits. No personal section, so the administrator keeps their own login and profile. |
| `example-public.json` | For Alchemy `seed-public`: publishes `example-org/click` and the `example-org` profile. |
| `mj.json` | The maintainer's hosted demo: personal owner `mj`, `mj-platform` and `mj-labs`, ten personal and six organization repositories. |
| `mj-public.json` | The hosted demo's public discovery fixture (`mj/fastapi` and the three profiles). |

A manifest may include a `personal` section (`login`, `fullName`, `bio`, `website`);
`apply` then renames the administrator's personal owner to that login and sets the
profile. Every GitHub snapshot is pinned to a full commit; the reviewed CI profile
supports the package names in `scripts/fixtures/demo_project_ci.py`.

The maintainer reproduces the current hosted demo with
`--manifest deploy/demo/mj.json --admin-login mike` on `create` (or Alchemy `init`
and `seed`), and `--manifest deploy/demo/mj-public.json` on `seed-public`. The admin
login starts as `mike` and `apply` renames it to `mj` from the manifest.

The deployment uses native Workers, D1, Artifacts Git and Cloudflare's managed
container registry. Organization memberships are stored records; repository URLs,
Git transport, source reads and package receipts resolve the canonical owner.
The internal installation/DO partition remains stable when a manifest renames the
personal owner.

## Build the reviewed CI image

```sh
python3 scripts/cloudflare-demo-deploy.py build-image
```

The image extends `cloudflare/agents/Dockerfile` and installs the exact Python
versions in `requirements.txt`. The approved image config digest is recorded per
installation. Apt packages and the base build are not a byte-for-byte reproducible
OS snapshot; the image's actual digest is always reverified before deployment.

## Resume or reapply the saved content

```sh
python3 scripts/cloudflare-demo-deploy.py apply /PATH/TO/ownership.json --manifest deploy/demo/example.json
```

Pass the same manifest the installation was created with (`--no-seed` claims only
the personal owner).

This uses the installation's private `retained-auth.json`, persisted organization
operation keys and seed receipt. It verifies already imported main commits and
owners, skips verified CI jobs, and resumes unfinished work. It refuses changed
manifest pins instead of silently replacing existing repositories. Keep `.tmp`
receipts and credentials private; the checked-in manifest contains no tokens.
The retained machine credential has a bounded lifetime; after expiry, renew its
operator authority before applying again:

```sh
python3 scripts/cloudflare-demo-deploy.py renew-authority /PATH/TO/ownership.json
```

This uses the recorded operator `cf` profile to renew only the owned service token
and a five-hour native machine credential, then revokes its predecessor. Human
Access login is independent.

The setup records the account's Access team origin as `access_team_domain` in
`forge.json`. Releases carry it into the Worker so requests missing the platform's
Access context can validate the signed `Cf-Access-Jwt-Assertion` against that
team's public keys and the installation's audience. Existing installations should
set this to their own `https://TEAM.cloudflareaccess.com` origin before releasing.
Unsigned identity headers and cookies alone never authorize this fallback.

Native PR conversations show a current-commit preview card. Ready deployments
publish a repository activity event immediately; an open conversation refreshes
its links without navigation. If streaming is unavailable, visible pages poll
every five seconds. Only current passing jobs and unexpired, unrevoked previews
produce links. This adopts the fast-feedback behavior of [Workers Builds preview
comments](https://developers.cloudflare.com/changelog/post/2026-10-12-faster-pull-request-comments/)
inside Golf; it does not require publishing comments to upstream GitHub projects.

Manifest imports publish built Python wheels, source archives and JSON
reports as OCI artifacts after real offline functional smoke tests. It does not
run the complete upstream workflow matrices or build runnable application images.
Each organization page shows its real owner membership and scoped repository list.
General native team administration and organization settings are still separate
features. Native repository names currently remain unique across this installation.

## Checks and lifecycle

```sh
node --test cloudflare/forge/*.test.mjs
python3 -m unittest discover -s scripts -p 'test_cloudflare_demo*.py'
python3 -m unittest discover -s scripts -p 'test_cloudflare_release.py'
npm --prefix web run build:native
```

Schema 0021 adds owner/membership/mapping tables without replacing Git data. Existing
installations deploy through the guarded native release/migration commands. An
older release must not be rolled back across the owner migration after adoption.

Provider tokens expire after seven days; previews retain four-hour leases. The
installation remains live until its explicit owned stop command runs:

```sh
python3 scripts/cloudflare_demo.py stop /PATH/TO/ownership.json
```

Stop recovery includes managed CI tags validated against recorded repository/job
identities. Shared Secrets Stores are preserved. The current retained deployment
has been upgraded and populated; a second fresh installation is not implied by
that evidence.
