# Runner capacity

Scale-out plan S5, slice 1 ([SCALE_OUT_PLAN.md](SCALE_OUT_PLAN.md)). Operations administrators see what runs work for this
installation and how much of it waits, give autoscalers a queue-depth metric, and raise capacity limits through requests that a
second administrator approves, with the estimated cost change.

Golf never starts machines. It reports capacity and queue depth; your autoscaler, cluster or deploy adds machines.

Code: `cloudflare/forge/src/capacity.mjs`. Page: `/admin/capacity` (Admin → Runner capacity). Schema 49
(`migrations/0049_capacity_requests.sql`) holds requests and metrics tokens; without it, the inventory still reads, and requests and
tokens say the migration is needed.

## The inventory

`POST /native/capacity/read` `{ "action": "read" }`, operations administrators signed in through Access only, checked before and after
the reads. It runs in the stateless Worker, not the Workspace queue.

| Source | Capacity | Online | Running | Queued |
| --- | --- | --- | --- | --- |
| Self-hosted Forgejo and GitLab runners, one row per pool | active and registered runners | active runners seen in the last 5 minutes | `RUNNING` jobs held by the pool's runners | `QUEUED` jobs the pool can take, and the oldest wait |
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
- At most 2,000 runners and 5,000 queued jobs are read; beyond that the page says the counts are partial.

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
  "queued": 5, "running": 2, "online": 2, "oldestWaitSeconds": 125, "registered": 3, "truncated": false, "at": "2026-10-15T20:00:00.000Z" }
```

- `engine` is `forgejo-actions` or `gitlab-ci`. `labels` are the labels your runners register with, comma-separated; images are
  ignored, as in matching. Any other parameter is refused.
- The pool is the one with exactly that label set. A label set with no runners yet answers with the jobs those labels would take in
  every repository, so a scaler can start a pool from zero.
- `queued`, `running` and `online` follow the inventory's rules. `oldestWaitSeconds` is 0 when nothing waits.

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
        valueLocation: "queued"
        targetValue: "1"            # one queued job per runner replica
        authMode: "bearer"
```

`maxReplicaCount` is your own ceiling for the pool. In this slice, a pool's concurrency cap is not a Golf policy (see below).
Persistent runners that register once fit a Deployment. Ephemeral runners (`--ephemeral`) fit a KEDA `ScaledJob` with the same
trigger.

This example has not been run against a cluster yet.

## Capacity requests

Requests raise one field of an installation policy (`installation.mjs` `installationPolicies`):

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

## Not in this slice

- Organization and repository shares of installation capacity (concurrency and daily runs within the installation value).
- A self-hosted pool's concurrency cap, or a native pool's `max_parallel`, as an installation policy that requests can raise.
- Container `max_instances` as a deploy setting bound into the Worker, so the inventory can show the allocation.
- Container cost per test run in the request estimate.
- Requests from organization owners.
- A bench run at a newly approved limit, with queue wait and cost per run recorded.
