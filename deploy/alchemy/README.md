# Alchemy deployment of the retained Golf demo

This parallel deployment path keeps the Python/`cf` installer available. Alchemy
owns the Cloudflare infrastructure; it uses the same native Worker build, Flare
UI, approved Python CI image and pinned [demo content](../demo/README.md).
It does not add Alchemy or Effect to the application bundle.

The stack provisions Workers and custom domains, Durable Objects, D1, R2, a queue
and consumer, a Workflow, Workers for Platforms, Access applications/policies,
an operator service token, account API tokens, Secrets Store entries, and the
managed registry runner image. Artifacts creates the namespace through its Worker
binding. Application preview resources and per-job OCI artifacts remain owned by
Golf's existing runtime and cleanup journal.

## Replace a retained demo

Use Node 24, Docker, Python 3, the authenticated `cf` profile and the qualified
`cf` 1.0.0-beta.13 CLI. Install the existing web/agent build dependencies, then:

```sh
npm --prefix deploy/alchemy ci
python3 scripts/cloudflare-demo-deploy.py build-image
python3 scripts/cloudflare_alchemy_demo.py prepare /PATH/TO/OLD/ownership.json
```

`prepare` reads the current retained installation's configuration and administrator
email. It allocates a fresh private directory and an eight-hour deployment token
scoped to that account and zone. It does not replace the running installation.
Use the printed directory as `NEW_DIRECTORY` below. Back up the old D1 database
before destruction if its contents need retaining; this procedure reseeds reviewed
content, not user-created history.

```sh
python3 scripts/cloudflare_alchemy_demo.py plan NEW_DIRECTORY
python3 scripts/cloudflare-demo-deploy.py renew-authority /PATH/TO/OLD/ownership.json
python3 scripts/cloudflare_demo.py stop /PATH/TO/OLD/ownership.json
python3 scripts/cloudflare_alchemy_demo.py deploy NEW_DIRECTORY
python3 scripts/cloudflare_alchemy_demo.py seed NEW_DIRECTORY
```

For a previous Alchemy installation, use its `destroy` command below instead of
the Python installer's `stop`. The plan is read-only; its adoption flag allows
inspection while the old single-instance Access provider/store still exists.
Actual deployment never uses adoption. Stop the old installation before deploying
to the same hostnames. Deleting custom domains also creates a DNS gap: recursive resolvers may cache
the missing names for the zone’s negative TTL (30 minutes in this trial).
The fresh Access applications require a fresh human login.
The supplied administrator retains instance administration; ordinary machine Git
credentials intentionally cannot acquire that authority.

`seed` creates the two Git/PR/preview playgrounds, ten pinned personal GitHub
imports under `mj`, and three imports each under `mj-platform` and `mj-labs`.
It executes the same reviewed CI profile, publishes artifacts to Cloudflare's
managed registry, and builds metadata indexes. Playground source and operation
identities are journaled before provider writes; rerunning resumes the same jobs.
A failed terminal job is retained and requires inspection before explicitly
admitting a replacement. The imported repository seeder has its existing resume
journal. Neither path runs arbitrary upstream workflow matrices.

## Update and inspect

```sh
python3 scripts/cloudflare_alchemy_demo.py plan NEW_DIRECTORY
python3 scripts/cloudflare_alchemy_demo.py deploy NEW_DIRECTORY
python3 scripts/cloudflare_alchemy_demo.py seed NEW_DIRECTORY
npm --prefix deploy/alchemy run check
python3 -m unittest discover -s scripts -p 'test_cloudflare_alchemy_demo.py'
python3 -m unittest discover -s scripts -p 'test_cloudflare_retained_demo.py'
node --test cloudflare/forge/workspace-admission.test.mjs
```

The database schema is initialized once. A saved database/schema digest prevents
an update from replaying bootstrap SQL or silently applying schema changes; use
the existing guarded native migration procedure when the schema changes.
The approved local runner image is checked by the shared build. Its digest is
included in Alchemy's Docker context to invalidate the image cache when that
source changes. Docker provenance indexes are disabled for this native runner.

Private installation files, including `.alchemy/`, must be kept together and
backed up securely. Alchemy's local state contains credentials despite their
`Redacted` labels; it is protected by directory permissions, not encryption.
Nothing under the installation directory belongs in Git. Do not run Alchemy
from the repository root or share its state files in issues.

The operator token lasts eight hours, the native/service credentials five hours,
the runtime provider tokens seven days, and previews four hours. Human Access
login is independent. The shared `renew-authority` command renews the owned
native/service credentials. Use `python3 scripts/cloudflare_alchemy_demo.py renew-deploy NEW_DIRECTORY` to
replace the deployment token through the recorded `cf` profile. Runtime provider
authority must be renewed before its seven-day expiry; this experiment is not a
permanent unattended deployment service.

## Destroy an Alchemy installation

```sh
python3 scripts/cloudflare_alchemy_demo.py destroy NEW_DIRECTORY
```

Use this wrapper rather than bare `alchemy destroy`: it checks installation
ownership, refuses active jobs, revokes private previews, removes owned Git
repositories and CI registry tags, then destroys Alchemy resources and its runner
image cache. The account's singleton Secrets Store is preserved; the installation's
prefixed secrets are removed. The private journals remain for inspection. A
partially failed destroy needs inspection before retry; this is not the mature
Python installer's recovery implementation.

Alchemy 2.0.0-beta.83 is pinned. Its Workflow resource currently omits concurrency
and retention settings, so a small provider applies the same two-run/one-day
limits to the Workflow Alchemy owns. Golf accepts either the explicit Alchemy
workflow binding or the `cf` export binding. The two deployers must not manage the
same installation concurrently.

The preview gateway uses a resource for its exact custom domain rather than
`Worker.domain`: that Alchemy property reconciles every attached domain and would
delete the per-preview hostnames Golf creates. The adapter checks the gateway
Worker and zone before any change; Golf retains ownership of each application
hostname, certificate and cleanup receipt. An update with live previews was
verified to preserve those domains.

The [retained deployment evidence](../../docs/compatibility/evidence/alchemy-demo-20261013.json)
records the actual replacement, CI and signed-in browser checks. The old Python
installation was removed successfully. The new Alchemy destroy wrapper has not
been exercised against this retained installation.

## Public source and discovery demo

Public access is opt-in. Upgrade the retained schema without recreating any
resources, deploy the path-scoped Access login, then explicitly publish the
reviewed discovery fixture:

```sh
python3 scripts/cloudflare_alchemy_demo.py enable-public NEW_DIRECTORY
python3 scripts/cloudflare_alchemy_demo.py deploy NEW_DIRECTORY
python3 scripts/cloudflare_alchemy_demo.py seed-public NEW_DIRECTORY
```

`enable-public` accepts only the recorded schema or its reviewed predecessor and
adds migration 0022. It does not publish repositories. `seed-public` uses
[`deploy/demo/public.json`](../demo/public.json) to publish only `mj/fastapi` and
the public profiles for `mj`, `mj-platform`, and `mj-labs`. Other repositories,
organization membership and account emails remain private. A private seed receipt
prevents silently republishing a repository made private later; customized public
profiles are never overwritten. Ordinary redeployment does not rerun this seed. Before publishing, the command
waits up to ten minutes for the Worker and existing workspace Durable Object to
report matching source/configuration fingerprints and schema 22. A successful
Worker upload alone does not mean every existing object has adopted the release.

The Access application protects `/auth/login`; its signed cookie applies across
the hostname. The Worker verifies issuer, audience, signature and expiry before
resolving enrolled Golf users. Only explicitly published source/history and HTTPS
clone reads admit anonymous visitors. Settings, writes, issues, PRs, CI artifacts
and previews retain existing grants. The Python/`cf` release path supports schema
22 and the same `public_repositories` binding; a Python-owned installation also
needs its owned Access application's domain changed to `HOST/auth/login` with
`pathCookieAttribute=false`. Never have both deployers manage the same resources.

Profile README content is edited in Golf, not synchronized from a special Git
repository. Pins are limited to six currently public repositories owned by that
profile. Search covers names, descriptions and topics, not file contents.

## Agent workspace and retained performance

The read-only Agent workspace is at `/:owner/:repo/agents`, with a selected PR
at `/agents/:number`. It assembles existing evidence and previews without
starting agents or changing merge policy. An installation without agent
execution still shows existing CI and review evidence with an explicit notice.

PR, Actions and Agent workspace inventories use bounded concurrent read routes.
During Worker/DO propagation, the UI retries an unsupported read route once on
the existing API. Permission failures and mutations are never retried this way.
This ships through the ordinary build/deploy command in both deployment paths;
there is no new binding, migration or seed operation.

Enable bounded performance observations on a retained installation with:

```sh
python3 scripts/cloudflare_alchemy_demo.py enable-observability NEW_DIRECTORY
python3 scripts/cloudflare_alchemy_demo.py deploy NEW_DIRECTORY
```

The saved input enables the existing 2048-request/30-minute workspace history
and 1% Cloudflare request-log sampling. Query strings are redacted, invocation
logs and tracing stay off, and Golf's structured events omit request bodies and
authorization. The Alchemy control Worker uses the shared build's observability
policy. No analytics credential or provider billing collection is implied.
Operations shows source, evidence and preview latency, including p50/p95, beside
existing database, authority and cache observations. Empty families are unknown.

Use `cloudflare/forge/browser-benchmark.mjs` in an authenticated browser for
bounded source-read comparisons (up to eight fixed repositories, eight passes,
and 16 concurrent requests). First pass is not proof of an empty cache. Preserve
raw scope, exact commits, errors, payload bytes and cache state when comparing.
