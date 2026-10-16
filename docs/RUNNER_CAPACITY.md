# Runner capacity

Scale-out plan S5, slices 1 and 2 ([SCALE_OUT_PLAN.md](SCALE_OUT_PLAN.md)). Operations administrators see what runs work for this
installation and how much of it waits, give autoscalers a queue-depth metric, and raise capacity limits through requests that a
second administrator approves, with the estimated cost change. Slice 2 adds a concurrency cap per self-hosted pool and organization
and repository shares of runner capacity, enforced where work starts ([Pool caps](#pool-caps), [Runner shares](#runner-shares)).

Golf never starts machines. It reports capacity and queue depth; your autoscaler, cluster or deploy adds machines.

Code: `cloudflare/forge/src/capacity.mjs`; slice 2 in `capacity-policy.mjs` (the two installation policies) and `capacity-shares.mjs`
(enforcement, the shares API, grants). Page: `/admin/capacity` (Admin → Runner capacity). Schema 49
(`migrations/0049_capacity_requests.sql`) holds requests and metrics tokens; without it, the inventory still reads, and requests and
tokens say the migration is needed. Schema 52 (`migrations/0052_capacity_shares.sql`) holds organization and repository shares; without
it, the installation's share and pool caps still apply, and organization and repository settings say the migration is needed.

## The inventory

`POST /native/capacity/read` `{ "action": "read" }`, operations administrators signed in through Access only, checked before and after
the reads. It runs in the stateless Worker, not the Workspace queue.

| Source | Capacity | Online | Running | Queued |
| --- | --- | --- | --- | --- |
| Self-hosted Forgejo and GitLab runners, one row per pool | active and registered runners, and the pool's cap | active runners seen in the last 5 minutes | `RUNNING` jobs held by the pool's runners | `QUEUED` jobs the pool can take, the oldest wait, and how many of them a cap or share holds |
| Queued with no runner | — | — | — | `QUEUED` jobs no active runner can take |
| Native runner pools | `max_parallel`, active machines | — | machines holding a job | evidence tests placed on the pool and waiting |
| Cloudflare containers (PR tests, agent proposals, SSH tasks) | not known to the Worker (see below) | — | running tasks | requested tasks |
| Agent hosts and SSH hosts | summed `max_concurrent` of active hosts | agent hosts seen in the last minute | claimed and running tasks | queued tasks |

**Pools.** A pool is an engine plus a set of label names. Golf matches labels the way its claim does
(`pipelines.mjs` `claimPipelineJob`):
- a job's `runs-on` labels (GitLab: tags) must all be on the runner;
- labels match by name: Forgejo's `ubuntu-latest:docker://node:20` is `ubuntu-latest`, so runners with different images are one pool;
- an installation runner takes every repository, an organization runner its organization's repositories, a repository runner its own.

Counting rules:
- A pool's queue is the jobs its labels take, in repositories that any of its registered runners' scope covers. Disabled runners
  count for scope: an ephemeral runner is disabled after its one job, and a pool scaled to zero still has a queue.
- A job that several pools can take is counted in each.
- **Unmatched** is the jobs no *active* runner can take, by labels and scope.
- Repository feature policy (Actions turned off for a repository) is not applied here: such a job counts as queued until Golf's
  24-hour sweep cancels it.
- At most 2,000 runners (the newest) and 5,000 queued jobs (the longest waiting, by `queued_at`: a retry re-queues the same job
  with a new time) are read; beyond that the page says which read was cut and that its counts are partial.
- **Held** (slice 2): of a pool's queued jobs, those whose organization or repository runs its share, and, while the pool runs as many
  jobs as its cap, all the others. A job held by both is counted once, under the share.

**Cloudflare containers.** The deploy sets no Containers `max_instances` and binds no instance limit into the Worker, so the
allocation is shown as not known, never as a number. What Golf does know is shown as Golf's own limit:
- PR test and agent proposal containers: at most 2 running together (`evidence.mjs`); another is refused, not queued.
- SSH task containers: one per running SSH task, at most each SSH host's concurrent-task limit.

## Queue depth for autoscalers

```
GET /native/capacity/metrics?engine=forgejo-actions&labels=ubuntu-latest,docker
Authorization: Bearer golf_capacity_…
```

```json
{ "pool": "forgejo-actions:docker,ubuntu-latest", "engine": "forgejo-actions", "labels": ["docker", "ubuntu-latest"],
  "queued": 5, "running": 2, "online": 2, "oldestWaitSeconds": 125, "registered": 3, "truncated": false, "runnersTruncated": false, "jobsTruncated": false,
  "held": 2, "claimable": 3, "cap": 4, "at": "2026-10-15T20:00:00.000Z" }
```

- `engine` is `forgejo-actions` or `gitlab-ci`. `labels` are the labels your runners register with, comma-separated; images are
  ignored, as in matching. Any other parameter is refused.
- The pool is the one with exactly that label set. A label set with no runners yet answers with the jobs those labels would take in
  every repository, so a scaler can start a pool from zero.
- `queued`, `running` and `online` follow the inventory's rules. `oldestWaitSeconds` is 0 when nothing waits. `truncated` is either
  bound reached; `runnersTruncated` and `jobsTruncated` say which.
- Slice 2 adds these fields; the ones above keep their meaning:
  - `held`: queued jobs that cannot start now, because the pool runs as many jobs as its cap or their organization or repository runs
    its share;
  - `claimable`: `queued` − `held`, what more runners in this pool could start now;
  - `cap`: the pool's cap, or `null`.

  Scale on `claimable`: scaling up for held jobs adds runners that get no work.

**The token.**
- An operations administrator creates one on the capacity page ("New metrics token") with a name and a lifetime of 30, 90 or 365
  days. At most 20 can be active.
- The secret (`golf_capacity_` and 43 characters) is shown once. Golf stores its SHA-256 digest.
- It is accepted on this route only. Every other route, including `/native/capacity/read`, treats it as no credential.
- Revoke it on the same page. Creating and revoking are in the audit log (Runner capacity); the secret never is. Golf records when
  it was last used, at most once a minute.

**Access.** The public Worker treats this route as a machine route when a capacity token is presented: it skips the Access check,
drops cookies and adds no identity. Without a token, the route still needs Access. If your Access application covers the whole
hostname, add a bypass or service-auth policy for `/native/capacity/metrics`, as for runner routes.

### Example: KEDA `metrics-api` for Forgejo runners in Kubernetes

Store the token as a Secret. Create it from your shell or secret manager; never commit it.

```sh
kubectl -n golf-ci create secret generic golf-capacity --from-literal=token="$GOLF_CAPACITY_TOKEN"
```

```yaml
apiVersion: keda.sh/v1alpha1
kind: TriggerAuthentication
metadata:
  name: golf-capacity
  namespace: golf-ci
spec:
  secretTargetRef:
    - parameter: token
      name: golf-capacity
      key: token
---
apiVersion: keda.sh/v1alpha1
kind: ScaledObject
metadata:
  name: forgejo-runner
  namespace: golf-ci
spec:
  scaleTargetRef:
    name: forgejo-runner            # the Deployment running forgejo-runner daemon
  minReplicaCount: 0
  maxReplicaCount: 10               # your approved ceiling for this pool
  pollingInterval: 15
  cooldownPeriod: 300
  triggers:
    - type: metrics-api
      authenticationRef:
        name: golf-capacity
      metadata:
        url: "https://golf.example.com/native/capacity/metrics?engine=forgejo-actions&labels=ubuntu-latest,docker"
        valueLocation: "claimable"        # queued minus the jobs held by the pool's cap or a share
        targetValue: "1"            # one queued job per runner replica
        authMode: "bearer"
```

`maxReplicaCount` is your own ceiling for the pool. Golf's pool cap ([Pool caps](#pool-caps)) limits how many jobs the pool runs at
once, whatever the replica count; set `maxReplicaCount` at or below it, or runners beyond the cap sit idle.
Persistent runners that register once fit a Deployment. Ephemeral runners (`--ephemeral`) fit a KEDA `ScaledJob` with the same
trigger.

This example has not been run against a cluster yet.

## Capacity requests

Requests raise one field of an installation policy (`installation.mjs` `installationPolicies`). Organization owners also request a
higher runner share for their organization; those requests appear in the same list and are described under
[Runner shares](#runner-shares).

| Setting | Ceiling without a deploy | With a deploy | Cost change |
| --- | --- | --- | --- |
| `evidence.dailyLimit`: daily evidence admissions | the deploy value | up to 50 (`settings.evidence.daily_limit`) | per measured CI run |
| `previews.lifetimeSeconds` | the deploy lifetime | up to 14,400 (`settings.previews.ttl`) | no cost model |
| `previews.concurrency` | 4 preview slots | fixed in code | no cost model |
| `agent-budgets.*PerMinute` (four fields) | 100,000 | fixed in code | no cost model |

**Request:** `POST /native/capacity` `{ "action": "request", "key", "field", "value", "reason" }`. Any operations administrator can
make one.
- The value must be a whole number above the current value. Lowering a value needs no request: change it on the Installation page.
- Up to the ceiling, the policy's own `validate` checks it.
- Above the ceiling and up to what a deploy can allocate, it is accepted and marked **needs a deploy**. Above that, it is refused.
- One open (pending or approved) request per setting.
- `{ "action": "preview", … }` on `/native/capacity/read` returns the same assessment and cost change without recording anything.

**Cost change.** Daily admissions map to CI runs a day: each admission is at most one CI run.
- The change is an upper bound: every added admission used every day, times 30.4 days.
- Each run is priced at this installation's measured cost per CI run from `costs.mjs`: R2 Class A and B operations and Queues over
  the last 7 days, at the list prices in `costs.mjs`, against the monthly allowances as if this installation were the only user of
  the account.
- Container time per test run is not measured, so it is left out and named in the basis.
- If no cost per CI run is measured (no Account Analytics Read token, or no CI runs in the window), the estimate is empty and says
  why.
- Other settings record "No cost model for this setting."
- Reading the measured units sends the same GraphQL requests as the Estimated costs page, up to 5 s.

**Decide:**
- Approve or decline: `{ "action": "approve" | "decline", "id", "note"? }`. Only a *different* operations administrator, never the
  requester.
- Withdraw: `{ "action": "withdraw", "id" }`. Only the requester.
- Approval needs the setting name typed (`confirmation`), plus `operationId` and the policy `expectedVersion` from the read.
- Within the ceiling, approval applies the value through `applyInstallationChange`, the code `/native/installation` uses: the same
  validation, revision fence, typed confirmation, an Access sign-in from the last 10 minutes when the value widens, and the
  installation policy audit row. The request becomes `APPLIED` in the same D1 batch, and only while it is still undecided.
- Above the ceiling, nothing can be applied in the product. Approval records `APPROVED` with the deploy step:

  ```
  Set settings.evidence.daily_limit to N in DIR/alchemy-input.json, then run
  python3 scripts/golf_cloudflare.py update DIR    # shows the plan before it deploys
  ```

  The request stays `APPROVED`. Once a deploy has raised the ceiling, a second administrator chooses **Apply**, which runs the same
  approval path.
- If the setting can no longer be applied (for example, a deploy removed its allocation), the request becomes `FAILED` with the
  reason.
- When installation policy is locked at deploy (`policy_editing: false`), approved requests cannot be applied in the product.

Every action is audited in the installation audit log under Runner capacity: `capacity_request.create`, `.approve`, `.apply`,
`.decline` and `.withdraw`, and `capacity_metrics_token.create` and `.revoke`. Refused attempts are recorded as denied.

## Pool caps

The installation policy `runner-pools` (`capacity-policy.mjs`) lists caps: `{ "pools": [{ "engine", "labels": [...], "maxConcurrent" }] }`.

- The pool is slice 1's: the engine plus the sorted runner label names (an image part is dropped). At most 100 caps, each 1–1000
  running jobs.
- Self-hosted machines have no deploy allocation, so the deploy value is "no caps". The policy exists where Actions pipelines are
  allocated.
- On the Runner capacity page, **Pool caps** lists each cap with the pool's running jobs and the jobs waiting for the cap, then offers
  **Add pool cap**, **Edit** and **Remove**. Saving goes through `/native/installation` (`applyInstallationChange`), like every
  installation policy:
  - a new or lower cap narrows and saves at once;
  - a higher cap, or removing one, widens: type `runner-pools`, with an Access sign-in from the last 10 minutes;
  - every change is an `update` row (subject `runner-pools`) in the installation audit log.
- **Enforcement** (`pipelines.mjs` `claimPipelineJob`):
  - A runner of a pool that runs as many jobs as its cap gets no job. The protocols answer as for an empty queue: GitLab
    `/api/v4/jobs/request` answers 204, Forgejo `FetchTask` an empty task.
  - The claim's conditional `UPDATE` carries the count: "fewer than N `RUNNING` jobs held by runners of this pool". D1 runs one
    statement at a time, so concurrent claims cannot overshoot.
  - The pool is matched in SQL by the runner's label names (`json_each`), so a runner registered or relabelled (Forgejo `Declare`)
    meanwhile is counted.
  - A cap counts and limits **installation runners only**. Runners a repository or organization registers itself never use up the
    installation's pool, and are not capped by it; shares still apply to their jobs.
  - **Caps hold against cooperating runners.** A runner chooses its labels when it registers and can change them (Forgejo
    `Declare`). A runner that relabels itself leaves the pool, and its jobs leave the pool's count. Caps limit capacity you operate;
    they are not a security boundary against a runner's own configuration.
  - Running jobs are not stopped; a lower cap applies as they finish.

## Runner shares

How much self-hosted runner capacity each organization and repository may use: **running pipeline jobs** at once, and **pipeline
runs started per UTC day**. They follow the admin → organization → repository policy hierarchy:

| Level | Who sets it | Where | Bound |
| --- | --- | --- | --- |
| Installation | operations administrators | installation policy `runner-shares` (`{ maxRunning, maxRunsPerDay, enforced }`): Runner capacity page → **Runner shares** → **Edit** | 1–1000 running jobs, 1–100,000 runs a day, or none |
| Organization | its owners | a `capacity_shares` row: organization settings → **Runner share** → **Edit** | at or below the installation's value, or its grant |
| Repository | its administrators | a `capacity_shares` row: repository Settings → Runners → **Runner share** → **Edit** | at or below its organization's limit (the installation's for a personal repository) |

- The installation value applies to each organization (all its repositories together) and to each personal repository. Empty means
  no limit, which is the deploy value.
- Without a value of its own, an organization or repository inherits its parent's. A value saved above a parent that is later lowered
  is narrowed when read.
- **Enforced**: the installation's value applies everywhere, and organizations and repositories cannot set their own. Their saved
  values are kept and apply again when enforcement is turned off.
- Installation changes follow the policy model. Lowering saves at once. Raising, removing a limit, or enforcing (which replaces
  narrower values) needs `runner-shares` typed and a recent Access sign-in. Each change is audited as `update`.
- Organization and repository changes:
  - need a verified Access sign-in by a current organization owner or repository administrator, never a token;
  - carry the version read;
  - are audited at their own scope as `capacity_share.update`.

  Members and repository readers see the share, read-only.

**Storage.** The installation's value is an installation policy, so it gets the existing validation, revision fence, widening rule and
audit. Organization and repository values are a new table, `capacity_shares` (schema 52), not `feature_policies` rows:
- `feature_policies.mode` is a CHECKed enum (`DISABLED`, `ALLOWED`, `ENFORCED`), and its scope excludes repositories. A migration after
  0025 must replay safely, so it cannot relax a CHECK.
- The claim reads shares by primary key `(scope, scope_id)`.

**Enforcement.**
- **Claim** (`claimPipelineJob`):
  - Repositories and organizations at their running share are excluded from the candidate query, so a runner takes the next eligible
    job. A held job is skipped; it never stalls the queue.
  - The claim's conditional `UPDATE` also carries "fewer than N `RUNNING` jobs in this repository" and "… in this organization's
    repositories", so concurrent claims cannot overshoot.
  - A share reached by a concurrent claim during this one is excluded on a second read (up to three reads), so a claim does not stop
    behind a page of held jobs.
- **Run creation** (`createPipelineRun`):
  - The daily share is a count in the run's conditional `INSERT`: runs created since 00:00 UTC, refused ones not counted.
  - A run over it is recorded `REFUSED` with the reason, like other refused runs. For example: "Daily run share reached: The
    organization acme may start 50 pipeline runs a day (UTC) and 50 started today".
  - A re-run is the same run and is not counted again.
- With no installation value and no organization or repository value, the claim and run creation are as before.

**Requests from organization owners.** An organization owner asks for more than the installation's value from the organization's
settings (**Request more**): `POST /native/capacity/shares` `{ "action": "request", "organization", "field": "maxRunning" | "maxRunsPerDay", "value", "reason" }`.
- It is a `capacity_requests` row (schema 49) with `policy_key` `organization:<id>`. Schema 49 has no scope column, and a migration
  after 0025 must replay safely, so the table gains none. Its unique open-request index then allows one open request per organization
  and field.
- The value must be above the organization's ceiling. With no installation limit there is nothing to request.
- No cost is estimated: self-hosted machines are not billed through Cloudflare, and the request says so.
- Operations administrators see it in **Capacity requests** on the Runner capacity page as "Runner share of acme: …".
- A *different* administrator approves it by typing the organization's name, with an Access sign-in from the last 10 minutes. One
  batch:
  - the request becomes `APPLIED` only while still pending and not the approver's own;
  - the organization's grant (`granted_running` or `granted_runs_per_day`) is written;
  - the audit row (`capacity_request.approve` at organization scope) is written.
- A grant only raises: once the installation value reaches it, the installation value applies.
- The requester withdraws (`withdraw`); any other administrator may decline.

**On the Runner capacity page**, **Runner shares** shows the installation's value with **Edit**. Below it, a table lists the
organizations and repositories with a share of their own or a grant, or with running, queued or started work under a share (at most
200 rows): running against the share, queued, held, and runs today against the daily share.

`POST /native/capacity/shares/read` (`{ "action": "read", "organization" }` or `{ "action": "read", "repository", "repositoryId" }`)
is read in the stateless Worker.

## Not in these slices

- A request that raises a pool cap: an administrator raises it on the page (widening, confirmed). Pool caps have no requests or cost
  model.
- A native pool's `max_parallel` as an installation policy.
- Shares for anything but Actions pipeline jobs and runs: PR test containers, agent proposals, agent and SSH host tasks.
- Organization and repository shares on the portable (Forgejo) backend.
- Container `max_instances` as a deploy setting bound into the Worker, so the inventory can show the allocation.
- Container cost per test run in the request estimate.
- A bench run at a newly approved limit, with queue wait and cost per run recorded.
- Hosted: schema 52 is not applied and slice 2 is not deployed. The organization settings panel has no browser test of its own (the
  repository panel, the same component, has one). The KEDA example has not been run against a cluster.
