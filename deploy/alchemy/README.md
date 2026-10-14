# Alchemy deployment of the retained Golf demo

This parallel deployment path keeps the Python/`cf` installer available. Alchemy
owns the Cloudflare infrastructure; it uses the same native Worker build, Flare
UI, approved Python CI image and explicit [content manifests](../demo/README.md#content-manifests).
It does not add Alchemy or Effect to the application bundle.

The stack provisions Workers and custom domains, Durable Objects, D1, R2, a queue
and consumer, a Workflow, Workers for Platforms, Access applications/policies,
an operator service token, account API tokens, Secrets Store entries, and the
managed registry runner image. Artifacts creates the namespace through its Worker
binding. Application preview resources and per-job OCI artifacts remain owned by
Golf's existing runtime and cleanup journal.

## What you provide

| Value | Flag (`init`) | How to obtain |
| --- | --- | --- |
| Account ID | `--account-id` | Dashboard account home, or the `accounts` list in `cf --profile golf auth whoami` (32 hex). Workers Paid and Artifacts must be enabled. |
| `cf` CLI profile | `--profile` | `cf auth create golf` (OAuth login into a named profile). It must be able to create API tokens; `init` mints an eight-hour, account- and zone-scoped deployment token from it. Do not export `CLOUDFLARE_API_TOKEN`/`CF_API_TOKEN`. |
| Zone ID | `--zone-id` | The zone's Overview page (32 hex). Both hostnames must be in this zone. |
| Control hostname | `--hostname` | An unused name in that zone, such as `golf.example.com`. |
| Preview hostname | `--preview-hostname` | A second unused name, such as `golf-previews.example.com`; previews use it and its children. |
| Administrator email | `--email` | An email that can sign in through Cloudflare Access (an available Zero Trust seat). |
| Secrets Store ID | `--secrets-store-id` (optional) | Required if the account already has a store (one per account): its ID on the dashboard's Secrets Store page. Omit it on an account without one and the stack creates it. |
| Access team domain | `--access-team-domain` (optional) | `https://TEAM.cloudflareaccess.com`. Default: read from the account's Access organization during `init`. |
| Admin login | `--admin-login` (optional) | Default: derived from the email's local part (`jane.doe@...` becomes `jane-doe`). |
| Git author | `--git-author-name`, `--git-author-email` (optional) | Author of the playground commits. Default: the admin login and the administrator email. |
| CI admissions | `--evidence-daily-limit` (optional) | Default 40 a day, 1 to 50. |
| Content | `seed --manifest PATH` or `seed --no-seed` | `deploy/demo/example.json` is a neutral sample; see [content manifests](../demo/README.md#content-manifests). |

The administrator identity is saved in the private `alchemy-input.json`; later
`build` and `seed` runs reuse it. A Workers subdomain is not needed: the stack uses
custom domains only.

Tools: Node 24, Docker, Python 3, Git and the qualified `cf` 1.0.0-beta.13 CLI.
Install the locked build dependencies once: `npm --prefix web ci`,
`npm --prefix cloudflare/agents ci` and `npm --prefix deploy/alchemy ci`.

## Fresh install

On an account with no previous Golf installation:

```sh
python3 scripts/cloudflare-demo-deploy.py build-image
python3 scripts/cloudflare_alchemy_demo.py init \
  --account-id ACCOUNT_ID --profile golf --zone-id ZONE_ID \
  --hostname golf.example.com --preview-hostname golf-previews.example.com \
  --email you@example.com
# prints NEW_DIRECTORY (.tmp/cloudflare-forge/golf-alchemy-*); add --secrets-store-id STORE_ID
# if the account already has a Secrets Store, --admin-login LOGIN to choose the login
python3 scripts/cloudflare_alchemy_demo.py plan NEW_DIRECTORY
python3 scripts/cloudflare_alchemy_demo.py deploy NEW_DIRECTORY
python3 scripts/cloudflare_alchemy_demo.py seed NEW_DIRECTORY --manifest deploy/demo/example.json
```

`init` reads nothing from a previous installation. It checks the inputs, records
the approved local runner image, reads the Access team domain unless given, and
writes the private input in a new mode-0700 directory with fresh signing and
bootstrap secrets; then it mints the deployment token. `deploy` creates every
resource, bootstraps the schema, enrolls the administrator and records
`ownership.json`. Sign in at `https://golf.example.com` with the administrator
email. Continue with any optional service below (`enable-ai`, `enable-search`,
`enable-pipelines`, `enable-email`...), and renew the seven-day provider tokens
with `renew-credentials` before they expire.

`seed --no-seed` creates only the two CI/preview playgrounds and claims the
administrator's personal owner. The maintainer's hosted demo is
`init ... --admin-login mike` and `seed NEW_DIRECTORY --manifest deploy/demo/mj.json`.

## Replace a retained demo (existing installation handoff)

`prepare` builds a new Alchemy installation from the receipt of a running retained
installation, either an earlier Alchemy one or one made by
`cloudflare-demo-deploy.py create`:

```sh
python3 scripts/cloudflare-demo-deploy.py build-image
python3 scripts/cloudflare_alchemy_demo.py prepare /PATH/TO/OLD/ownership.json
```

`prepare` reads the current retained installation's configuration, administrator
email and current login (pass `--admin-login`, `--git-author-name` or
`--git-author-email` to change them). It allocates a fresh private directory and
an eight-hour deployment token scoped to that account and zone. It does not
replace the running installation. Use the printed directory as `NEW_DIRECTORY`
below. Back up the old D1 database before destruction if its contents need
retaining; this procedure reseeds reviewed content, not user-created history.

```sh
python3 scripts/cloudflare_alchemy_demo.py plan NEW_DIRECTORY
python3 scripts/cloudflare-demo-deploy.py renew-authority /PATH/TO/OLD/ownership.json
python3 scripts/cloudflare_demo.py stop /PATH/TO/OLD/ownership.json
python3 scripts/cloudflare_alchemy_demo.py deploy NEW_DIRECTORY
python3 scripts/cloudflare_alchemy_demo.py seed NEW_DIRECTORY --manifest deploy/demo/example.json
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

`seed` creates the two Git/PR/preview playgrounds, then imports the manifest's
pinned GitHub snapshots under its owners (with `deploy/demo/mj.json`: ten under
`mj` and three each under `mj-platform` and `mj-labs`). It executes the same
reviewed CI profile, publishes artifacts to Cloudflare's
managed registry, and builds metadata indexes. Playground source and operation
identities are journaled before provider writes; rerunning resumes the same jobs.
A failed terminal job is retained and requires inspection before explicitly
admitting a replacement. The imported repository seeder has its existing resume
journal. Neither path runs arbitrary upstream workflow matrices. Rerun `seed` with
the same manifest: a changed manifest is refused.

## Update and inspect

```sh
python3 scripts/cloudflare_alchemy_demo.py plan NEW_DIRECTORY
python3 scripts/cloudflare_alchemy_demo.py deploy NEW_DIRECTORY
python3 scripts/cloudflare_alchemy_demo.py seed NEW_DIRECTORY --manifest SAME_MANIFEST   # or --no-seed
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
python3 scripts/cloudflare_alchemy_demo.py migrate NEW_DIRECTORY
python3 scripts/cloudflare_alchemy_demo.py enable-public NEW_DIRECTORY
python3 scripts/cloudflare_alchemy_demo.py deploy NEW_DIRECTORY
python3 scripts/cloudflare_alchemy_demo.py seed-public NEW_DIRECTORY --manifest deploy/demo/example-public.json
```

`enable-public` requires the current schema (`migrate` adds what is missing) and
reads the public tables back. It does not publish repositories. `seed-public` publishes
exactly what its `--manifest` names: [`example-public.json`](../demo/example-public.json) publishes `example-org/click` and the `example-org` profile; the hosted demo uses [`mj-public.json`](../demo/mj-public.json) (`mj/fastapi` and
the public profiles for `mj`, `mj-platform`, and `mj-labs`). Other repositories,
organization membership and account emails remain private. A private seed receipt
prevents silently republishing a repository made private later; customized public
profiles are never overwritten. Ordinary redeployment does not rerun this seed. Before publishing, the command
waits up to ten minutes for the Worker and existing workspace Durable Object to
report matching source/configuration fingerprints and at least schema 22. A successful
Worker upload alone does not mean every existing object has adopted the release.

The Access application protects `/auth/login`; its signed cookie applies across
the hostname. The Worker verifies issuer, audience, signature and expiry before
resolving enrolled Golf users. Only explicitly published source/history and HTTPS
clone reads admit anonymous visitors. Settings, writes, issues, PRs, CI artifacts
and previews retain existing grants. The Python/`cf` release path supports schema
22 and the same `public_repositories` binding; a Python-owned installation also
needs its owned Access application's domain changed to `HOST/auth/login` with
`pathCookieAttribute=false`. Never have both deployers manage the same resources.

Throttle anonymous readers so a burst of public reads or clones does not fill the
single workspace queue:

```sh
python3 scripts/cloudflare_alchemy_demo.py enable-rate-limit NEW_DIRECTORY --limit 300 --period 60
python3 scripts/cloudflare_alchemy_demo.py deploy NEW_DIRECTORY
```

The Workers rate limiting binding counts requests that present no credential and
match the public read contract (source RPCs, discovery, profiles and HTTPS clone)
for each client network (an IPv4 address or an IPv6 /64) at each Cloudflare
location. Counts are approximate: this is a throttle, not a quota. Over the limit
the Worker answers 429 with `Retry-After` before the request reaches the
workspace. Signed-in sessions, Git or API credentials and runner routes are never
counted, including invalid credentials, which authentication refuses instead.
Operations lists the installed limit. The period is 10 or 60 seconds and the
limit 10 to 10,000. Not yet exercised on a hosted installation.

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

Enable repository webhooks on a retained installation by approving each
receiver origin, then deploying:

```sh
python3 scripts/cloudflare_alchemy_demo.py enable-webhooks NEW_DIRECTORY --origin https://hooks.example.com
python3 scripts/cloudflare_alchemy_demo.py deploy NEW_DIRECTORY
```

The first run generates a 32-byte encryption key in the private input; the stack
stores it as a Secrets Store secret and binds it with the policy (the approved
origins and 500 delivery attempts a day). Later runs replace the origin list and
keep the key, because saved subscriptions are encrypted with it. Receiver URLs
and signing secrets are entered in the repository's Webhooks settings, never in
this directory. Retries ride the stack's five-minute schedule.

Enable repository email on a retained installation, after `migrate`:

```sh
python3 scripts/cloudflare_alchemy_demo.py enable-email NEW_DIRECTORY --email-limit 200
python3 scripts/cloudflare_alchemy_demo.py renew-deploy NEW_DIRECTORY
python3 scripts/cloudflare_alchemy_demo.py deploy NEW_DIRECTORY
```

`enable-email` writes one sender, `golf@mail.HOSTNAME`, and a daily attempt
limit to the private input; no key, token or recipient. The stack registers
`mail.HOSTNAME` as a Cloudflare Email Service sending subdomain with message
previews off, and binds `send_email` restricted to that sender. `renew-deploy`
is needed once because the deployment token gains `Email Sending Write` only
when email is enabled; it stops if the account does not offer that permission.
Mail goes only to each subscriber's own Access sign-in address, after they
enable it under Profile and subscribe on a repository's Webhooks page. The
capability reads degraded until Cloudflare accepts a first message from the
sender, and ready after that. A message's first attempt follows the request
that caused it; retries and mail held by the daily limit ride the five-minute
maintenance, from the Cron Trigger or, when none reports in, the workspace
alarm. Not qualified live:
whether the account may use Email Service, whether `Email Sending Write` covers
the zone's subdomain endpoint, DNS validation of the subdomain, and whether an
upload is refused while the subdomain is unverified.

The stack's own API tokens (management, registry and, when enabled, analytics)
expire seven days after `init` or `prepare`. When they lapse, app previews, registry
publishing and the analytics feed stop. Extend them before that:

```sh
python3 scripts/cloudflare_alchemy_demo.py renew-credentials NEW_DIRECTORY --days 7
python3 scripts/cloudflare_alchemy_demo.py renew-deploy NEW_DIRECTORY
python3 scripts/cloudflare_alchemy_demo.py deploy NEW_DIRECTORY
```

`renew-credentials` only moves the expiry in the private input, 1 to 30 days
ahead. The deploy updates each token in place, so token values and the Secrets
Store entries that hold them do not change. Nothing renews them automatically;
the current expiry is `credentials_expire_at` in `ownership.json`. `renew-deploy`
is the separate eight-hour deployment token and is needed only when it has
expired.

When a checkout adds schema migrations, `deploy` refuses until they are applied:

```sh
python3 scripts/cloudflare_alchemy_demo.py migrate NEW_DIRECTORY
python3 scripts/cloudflare_alchemy_demo.py deploy NEW_DIRECTORY
```

`migrate` works back from the tail of `cloudflare/forge/schema.sql` through the
files in `cloudflare/forge/migrations/` until it reaches the schema recorded in
the private `schema-receipt.json`, then applies the missing ones oldest first.
It applies only migrations made of `CREATE TABLE`, `CREATE INDEX` and `CREATE
TRIGGER` statements with `IF NOT EXISTS`, so an interrupted run can be repeated;
anything else needs its own reviewed step. After each migration it reads the
created objects back from D1 and only then advances the receipt. Migrate before
deploying: the new tables are unused by the running Worker.

Prepare repository secrets and variables on a retained installation:

```sh
python3 scripts/cloudflare_alchemy_demo.py enable-secrets NEW_DIRECTORY
python3 scripts/cloudflare_alchemy_demo.py deploy NEW_DIRECTORY
```

The first run generates a separate 32-byte key in the private input; the stack
stores it as its own Secrets Store secret and binds it as `EXECUTION_VALUE_KEY`.
Later runs keep it, because stored values are encrypted with it; it is never the
webhook key, and losing it makes stored values unreadable. Run `migrate` first:
the database needs the execution value tables. The key alone does not turn the
feature on:
the settings page stays unavailable until the installation's test profile is an
approved Actions workflow, since values are released only to that hosted lane.

Enable Workers AI, and optionally agent proposals, on a retained installation:

```sh
python3 scripts/cloudflare_alchemy_demo.py enable-ai NEW_DIRECTORY --agent-path calc.py
python3 scripts/cloudflare_alchemy_demo.py renew-deploy NEW_DIRECTORY
python3 scripts/cloudflare_alchemy_demo.py deploy NEW_DIRECTORY
```

`enable-ai` admits inference through one private AI Gateway named after the
installation; the stack creates it with authentication required, prompt and
response logging off, no cache, 60 requests a minute and a spend limit of 500
cents a day. Inference is billed by Cloudflare. `renew-deploy` is needed once
because the deployment token gains `AI Gateway Write` only when AI is enabled.
`--agent-path` names the one source file agents may change, for the whole
installation; without it only review advice uses AI. It adds a second container
application running the same image, the `PRAgentTask` Durable Object and the
`AgentOutbound` export,
and raises the evidence workflow to 100 steps. The approved test image must
contain the maintained OpenCode controller. Alchemy beta.83 cannot create a
container application for a Durable Object class in the same run that creates
the class: the first deploy stops with `requires a resolved Durable Object
namespace` after updating the Worker, and a second `deploy` completes it.
Enabling AI also creates the `<name>-ai` Workflow (`AiWorkflow`) for Workers AI
runs. Its settings are applied before the Worker creates that Workflow, so the
first deploy after upgrading stops with `WorkflowNotFound` once the Worker is
updated, and a second `deploy` completes it (seen 2026-10-14).

Run pull-request tests from a workflow file while agent proposals keep the
approved Python module:

```sh
python3 scripts/cloudflare_alchemy_demo.py enable-workflow NEW_DIRECTORY --workflow-path .github/workflows/ci.yml
python3 scripts/cloudflare_alchemy_demo.py deploy NEW_DIRECTORY
```

`enable-workflow` records one approved Actions path for the whole installation
beside the existing test module; it accepts only `.github/workflows/NAME.yml`
or `NAME.yaml`, the form the build accepts, and a later run replaces the path.
After the deploy, pull-request runs and automatic push tests execute that file
and nothing else; the module only tests agent proposals. Two consequences:

- The test and agent policy hashes change, so a job queued before the deploy is
  refused after it. Jobs last at most ten minutes; start them again afterwards.
- Every repository needs the file at each pull-request head, in the hosted
  subset: `on: pull_request`, one job with `runs-on: golf-native-linux` and one
  to ten `run` steps. A pull request without it is refused with "The selected PR
  head needs a supported workflow at the approved path", and its automatic push
  intake is marked refused. Add the file to the demo repositories, and to their
  open pull-request branches, before or with the deploy.

The repository's Workflows settings page lists the files on the default branch
and marks this path. Jobs still have no Internet access.

Add service probes and the Workers analytics feed to Operations:

```sh
python3 scripts/cloudflare_alchemy_demo.py enable-operations NEW_DIRECTORY
python3 scripts/cloudflare_alchemy_demo.py renew-deploy NEW_DIRECTORY
python3 scripts/cloudflare_alchemy_demo.py deploy NEW_DIRECTORY
```

Probes use the existing Artifacts and R2 bindings. The feed reads Worker
analytics with a separate account token that holds only `Account Analytics
Read`, stored in Secrets Store; the management token is not reused.

Retain failed evidence deliveries with a dead-letter queue:

```sh
python3 scripts/cloudflare_alchemy_demo.py enable-dead-letter NEW_DIRECTORY
python3 scripts/cloudflare_alchemy_demo.py deploy NEW_DIRECTORY
```

Use `cloudflare/forge/browser-benchmark.mjs` in an authenticated browser for
bounded source-read comparisons (up to eight fixed repositories, eight passes,
and 16 concurrent requests). First pass is not proof of an empty cache. Preserve
raw scope, exact commits, errors, payload bytes and cache state when comparing.

## Actions and CI pipelines

`enable-pipelines [--actions-url https://code.forgejo.org]` requires the evidence
allocation. After `migrate`, `deploy` creates the `<name>-pipelines` bucket (logs and
artifacts), the `<name>-pipeline-intake` queue with its dead-letter queue and consumer,
and the `PipelineRun` coordinator class; a second `deploy` may be needed because
Alchemy cannot resolve a new Durable Object class in the run that creates it. Runners
register from Settings > Runners; the page shows the exact `forgejo-runner` or
`gitlab-runner` commands. Pipelines follow the `actions` feature policy. The sweep
that retries lost intakes runs in maintenance, driven by the Durable Object alarm, so
it does not depend on Cron Triggers.


## Verifying a deploy

The edge Worker serves a new version as soon as `deploy` finishes
(`X-Golf-Worker-Release` changes), but the `Workspace` Durable Object, where every
`/native/*` and `/git/*` handler runs, keeps its running instance until it is
evicted. An open signed-in tab holds long-lived `WatchRepository` streams, and
frequent requests keep the object warm, so a probe sent right after `deploy` can
still reach the old code for many minutes. Close or navigate away from hosted tabs,
leave the installation idle for about two minutes (the maintenance alarm then
starts a fresh instance), and probe once. `X-Golf-Release` comes from the edge
Worker and does not prove the object's code. This also explains why capability
states can lag a deploy.
