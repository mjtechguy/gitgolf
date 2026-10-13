# Repeatable Cloudflare demo

`demo.json` is the reviewed public content manifest: the `mj` personal owner,
`mj-platform` and `mj-labs`, ten personal repositories and three repositories per
organization. Every GitHub snapshot is pinned to a full commit. The two original
CI/application playground repositories remain personal too.

The deployment uses native Workers, D1, Artifacts Git and Cloudflare's managed
container registry. Organization memberships are stored records; repository URLs,
Git transport, source reads and package receipts resolve the canonical owner.
The internal installation/DO partition remains stable when adopting `mj`.

## Build the reviewed CI image

From the repository root, with Docker and the qualified `cf` CLI available:

```sh
python3 scripts/cloudflare-demo-deploy.py build-image
```

The image extends `cloudflare/agents/Dockerfile` and installs the exact Python
versions in `requirements.txt`. The approved image config digest is recorded per
installation. Apt packages and the base build are not a byte-for-byte reproducible
OS snapshot; the image's actual digest is always reverified before deployment.

## Create a fresh retained installation

Select unused control and preview hostnames in the given zone and an existing
Cloudflare Access email seat. Keep credentials in the named `cf` profile:

```sh
python3 scripts/cloudflare-demo-deploy.py create \
  --account-id ACCOUNT_ID --profile golf --workers-subdomain WORKERS_SUBDOMAIN \
  --zone-id ZONE_ID --hostname demo.example.com \
  --preview-hostname demo-previews.example.com --email owner@example.com \
  --secrets-store-id EXISTING_STORE_ID
```

Omit `--secrets-store-id` only when the account has no store. An explicitly reused
store retains its other secrets; each installation creates uniquely prefixed
secrets and owns only those entries. Do not point a new deployment at an occupied
hostname. The command prints its private ownership receipt, then configures the
personal profile, organizations/memberships, Git snapshots, CI and metadata indexes.
A failed run leaves its receipt and original operation identities for inspection.

## Resume or reapply the saved content

```sh
python3 scripts/cloudflare-demo-deploy.py apply /PATH/TO/ownership.json
```

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

The default manifest publishes built Python wheels, source archives and JSON
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
