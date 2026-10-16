# CI qualification — 2026-10-11

## Release decision

**Not enterprise-qualified across both runtimes.** Portable Golf has bounded
maintained Actions execution and a deliberately restricted GitLab-format shell
executor. Cloudflare native has approved exact-head container tests, not Actions
or GitLab pipeline execution. Storing YAML in Artifacts does not execute it.

This qualification uses fresh owned installations, actual Docker jobs and real
Cloudflare resources. Browser interception tests and parser tests are separate
supporting evidence; neither counts as a successful pipeline execution.
No retained installation or existing user repository is a test target.

## Reproducible packets

Run from the repository root. Build current Golf, runner and maintained engine
binaries; package the current `web/dist` into the core image. The advanced packets
require immutable Docker image IDs, the full source revision label and exact
binary SHA-256 values. Record the dirty source hashes too. A Git SHA alone does
not identify an uncommitted build. All ports bind loopback at allocated high ports.

| Packet | Actual acceptance exercised | Current scope |
| --- | --- | --- |
| `scripts/ci-compose-smoke.py --forge-kind forgejo` | Actions/GitLab execution, source and step receipts, restart queue recovery, failure, cancellation, policy revocation, log/history pagination, cleanup | Forgejo shell profile; not full Actions or GitLab Runner |
| `scripts/actions-two-job-smoke.py --with-push --ordinary-actions-bundles … --git-image-proof … --ci-job-image … --seed-approved-images` | Unchanged PSF Requests lint workflow, pinned checkout/setup-python actions, pre-commit, actual Git source, push admission and scoped dependency access | Maintained act on the portable profile (run on 2026-10-11 against the since-retired backend, then on Forgejo; see Results); not a hosted-native result |
| `scripts/workflow-artifacts-smoke.py --rustfs --proxy-binary …` | GitLab-format build, exact private artifact bytes, immutable source/run binding, current-reader and revocation fences, private object storage | Bounded shell artifacts; not GitHub artifact/cache protocol compatibility |
| `scripts/repository-execution-values-smoke.py` | Actions matrix/dependency jobs, explicitly approved secret/variable injection, output masking and credential authority changes | Pinned maintained engine; not arbitrary workflow secret access |
| `scripts/cloudflare-forge-smoke.py --account-id … --profile golf --workers-subdomain … --evidence --container-tests` | Canonical Artifacts YAML bytes, disabled workflow capability, typed 501 inspection/dispatch refusal, real PR container tests and private evidence | Native tests only; Actions/GitLab pipeline execution is **unsupported** |

Advanced Docker packets require `--image`, `--runner-image`, `--source-revision`,
`--expected-core-sha256`, `--expected-runner-sha256`, `--expected-engine-sha256`, and
`--output` where specified by `--help`. Public action archives are acquired with
`scripts/compatibility/acquire-actions.py`; never embed credentials in them.
Use the original private Git-image qualification receipt: its sanitized public
receipt deliberately omits local image acquisition fields.

The artifact and execution-value packets write an owner-only `seed.json`. Before
seeding, verify the exact Docker container ID, Compose project label and pinned
image; load/pull only that packet's declared job and daemon image into its fresh
daemon. Do not seed or reuse a user's running executor.

The Cloudflare packet has a 15-minute execution deadline and per-operation cleanup
deadlines. It uses scoped machine credentials, creates no login emails, and removes
its Worker, container application, D1, Artifacts namespace, queue, Workflow and R2
objects/bucket. A cleanup failure blocks completion and must be resolved from the
owned resource journal. There is no long-lived demo in this qualification.

### Deeper qualification profiles

The advanced Actions launcher now accepts `--forge-kind forgejo --forgejo-spec
PATH`. Use the frozen OpenAPI file produced by `scripts/forgejo-qualify.py`;
its digest must match `forgejo.spec_sha256` in `docs/compatibility/profile.json`. The launcher
uses the digest-pinned Forgejo image, a fresh installation identity, the separate
Forgejo Compose file and native Actions disabled. Forgejo is now the only accepted
`--forge-kind`, and `--forgejo-spec` is required. Run the unchanged Requests packet
with these additional flags.

For worker loss, use the same immutable core/runner binary arguments with
`--forge-kind forgejo --forgejo-spec PATH --workflow-directory .forgejo/workflows
--with-push --git-image-proof PATH --worker-death --seed-approved-images` and a
fresh `--output` directory. This packet uses the maintained Git-source executor;
do not add the Requests action-bundle or CI job-image options. It checks the
historical selected commit after the branch advances, workflow-directory
precedence, manual/push execution, isolated workspaces and scoped logs, then kills
the worker during a running step. Restart must refuse dirty executor reuse;
explicit recovery must fence the original attempt as lost, remove its containers
and volumes, and create no replacement run.

Add `--ci-resilience` to the standalone Cloudflare evidence/container packet.
It allocates at most three jobs: a passing test, a cancellable test on a separate
PR, and a failing test. Six identical concurrent requests must allocate one job;
different inputs under the same key must conflict. Six distinct requests compete
for the last daily slot; exactly one may be admitted. Once exhausted, fresh
requests are refused while original-key replay remains available. The packet
also checks cross-repository status/report/cancel denial, reader cancellation
denial, repeated owner cancellation, destroyed containers, unavailable cancelled
reports, and terminal cancellation after delayed workflow callbacks. Cancellation
is observed after task admission; it does not prove the untrusted command had
started. This profile excludes agents and a retained demo.

### Bugs exposed by the deeper tests

Forgejo's webhook contract differs from the earlier backend's contract. Its native and
compatibility delivery/event/signature headers must match; the installation-scope
header is absent in the pinned release. Golf now accepts that exact Forgejo
contract while retaining HMAC validation and immutable repository/owner binding.
Duplicate/mixed headers,
organization scope, invalid signatures and signed wrong-repository payloads
remain rejected. The Forgejo Compose callback allowlist also belongs under
`webhook`, not `security`. See the pinned provider's
[header implementation](https://codeberg.org/forgejo/forgejo/src/tag/v15.0.9/services/webhook/shared/payloader.go)
and [webhook settings](https://codeberg.org/forgejo/forgejo/src/tag/v15.0.9/modules/setting/webhook.go).

On Cloudflare, cancelling a task during clone interrupted preparation while
destruction was pending. The resulting exception could replace `CANCELLED` with
`LOST`. Cleanup now joins an in-flight destruction and preserves the first
terminal outcome, including across retries. Another regression test showed that
an authorization response arriving after cancellation could restart preparation;
the task now rechecks admission before starting. Both regression tests failed
before the fix and passed afterward. Cleanup failure remains an explicit
non-success state; a result is available only after destruction is confirmed.

The PostgreSQL packet ran twelve existing coordination-test families three times
under `-race`: competing dispatch/cancel, lease loss, recovery quarantine, SQL
faults, pool capacity/placement, permission changes and artifact privacy. All
36 executions passed against a fresh disposable PostgreSQL instance. These use
native HTTP fixtures; they are supporting coordination evidence, not native
forge execution or sustained production load. The exact names and source hashes
are in the [database receipt](compatibility/evidence/ci-database-races-20261011.json).

Failed attempts are retained in a
[separate record](compatibility/evidence/ci-deep-failed-attempts-20261011.json).
The first hosted Git push returned HTTP 500; later fresh attempts passed, but
the cause remains undiagnosed. An expanded-harness cleanup guard initially still
allowed only two jobs; all provider resources were removed, and the guard now
uses the same allocation limit as provisioning. Neither failure is a passing
qualification result.

## Shared fixtures

- `compatibility/fixtures/requests-lint.yml`: unchanged PSF Requests workflow at
  `414f0513c33883adf6f2b46901d4f0b38a455851`, SHA-256
  `2adbd62821e06ee622aff3e1e6e283a9cf3e2dcf694a04040b43fd4291d96f99`.
- `compatibility/fixtures/gitlab-shell.yml`: pinned Alpine image; job-level
  `before_script` and `script` share variables and the working directory. The
  portable Compose packet and hosted canonical-source check consume the same file.
- Other fixtures live in the existing qualification packets and
  `engines/act/testdata`; Golf's own repository has no installed CI workflows.

## Release-blocking gaps

1. Cloudflare-native needs a versioned workflow admission, source, policy, runner,
   durable job/log/artifact and cancellation contract before either YAML dialect
   can run there. Reusing an approved Python test container is not that contract.
2. GitLab includes, inheritance, rules, multi-job graphs and maintained Runner
   protocol are still open. The 50-command single-job shell subset cannot stand
   in for ordinary enterprise GitLab pipelines.
3. Extend the Forgejo qualification beyond the now-passing unchanged Requests
   profile to the remaining matrix, secret, artifact and compatibility packets.
   Preserve installation identity and source/permission fences; these results
   do not approve a production rollout.
4. GitHub-compatible artifacts/cache, reusable workflows, fork/PR trust boundaries,
   service containers, deployment approvals and concurrent tenant resource budgets
   need their own real positive and negative packets. Existing narrower evidence
   must not be relabeled as full compatibility.
5. Establish measured queue/dispatch/log-stream latency, concurrent tenant limits,
   worker-loss recovery, provider outage behavior and cost ceilings under sustained
   load. A small successful test is not an availability or scale qualification.

## Results

- Forgejo shell CI: passed; [receipt](compatibility/evidence/ci-review-20261011.json).
- Unchanged Requests Actions workflow plus network, timeout and cancellation
  boundaries: passed on the since-retired backend (receipt removed with it); the
  Forgejo result is listed below.
- Matrix jobs, secret masking, authority changes and encryption rotation: passed
  on the since-retired backend (receipt removed with it); not yet repeated on Forgejo.
- GitLab private artifacts, object-store outage refusal, restart and access
  revocation: passed on the since-retired backend (receipt removed with it); not
  yet repeated on Forgejo.
- Cloudflare exact-head Python test execution: passed; Actions/GitLab YAML
  execution: **unsupported**, not passed;
  [receipt](compatibility/evidence/ci-hosted-review-20261011.json).
- Forgejo unchanged Requests workflow, signed-push admission, dependency egress
  denial, timeout, running cancellation and cleanup: passed;
  [receipt](compatibility/evidence/requests-forgejo-deep-20261011.json).
- Forgejo workflow-directory precedence, historical source, two-job execution,
  signed push, restart without replay, actual worker death and explicit fenced
  recovery: passed;
  [receipt](compatibility/evidence/worker-loss-forgejo-deep-20261011.json).
- PostgreSQL coordination with `-race`, twelve families repeated three times:
  passed; [receipt](compatibility/evidence/ci-database-races-20261011.json).
- Cloudflare concurrent replay, competing final-slot allocation, admitted
  cancellation, repository isolation, failed tests, source/permission revocation
  and all eleven cleanup categories: passed;
  [receipt](compatibility/evidence/ci-hosted-resilience-20261011.json).

See the dated implementation status and sanitized evidence receipts. Failed
attempts remain failed; later passes identify the corrected source and image.
Never publish private command diagnostics, source archives or credentials.
