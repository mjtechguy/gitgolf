# Versioned Forgejo and CI compatibility register

Date: 2026-10-16. This register measures Golf's portable backend, Forgejo 15.0.9, and Golf's Actions profiles against the [implementation plan's Actions and pipeline target](../GOLF_IMPLEMENTATION_PLAN.md#7-actions-and-gitlab-pipeline-compatibility). Forgejo is the only portable (self-hosted) backend ([ADR 0009](../decisions/0009-forgejo-portable-backend.md), [setup](../FORGEJO_SETUP.md)). Cloudflare-native Golf keeps Artifacts/D1/Workers and is not measured here.

**Full compatibility is not claimed.** The unchanged Requests push workflow passes on a fresh pinned Forgejo with genuine checkout/actions/dependencies. PR/fork execution, broader Actions, actual GitLab Runner interoperability, connected CI, complete forge coverage, protected publication and release recovery remain open. Local qualification does not advance any retained deployment.

## Registers and identities

| File | Contract |
| --- | --- |
| [profile.json](profile.json) | Immutable Forgejo/act/image/source identities, dependency hashes, selected platforms and explicit unselected GitLab/Runner profile. |
| [forgejo-15.0.9.swagger.json](forgejo-15.0.9.swagger.json) | The Swagger document actually served at `/swagger.v1.json` by a disposable container of the pinned image `codeberg.org/forgejo/forgejo:15.0.9-rootless@sha256:caf1bca332f95cdcf124227a4bfa3b49bbbfbbc8a5e4a97406921cb581165413`, captured 2026-10-16 by `make forgejo-qualify`. The JSON was re-serialized with sorted keys, so the bytes are not the server's original bytes; the content is unchanged. `profile.json` records its file hash and the qualifier's canonical hash, which `make compatibility-check` re-verifies. |
| [forgejo-operations.json](forgejo-operations.json) | Generated. All 491 method/path/operation IDs, parameters, responses, security, content types and references to frozen definitions. |
| [forgejo-annotations.json](forgejo-annotations.json) | Separate reviewed consumer/field/scope/permission/pagination/limit/test assessments. Regeneration preserves them and fails if a reviewed operation's method or path changes. Unreviewed operations remain explicitly unassessed. |
| [protocols.json](protocols.json) | Four Git protocols, the 23 registry types Forgejo 15 documents and all 28 webhook/event constants at Forgejo tag `v15.0.9`. Actions-only events are distinguished from native hook configuration. Upstream source is referenced by URL, commit and SHA-256, not copied into this repository; payload/client qualification is still open. |
| [actions.json](actions.json), [gitlab.json](gitlab.json), [connected.json](connected.json) | Independent feature catalogs; source, native, actual runtime and deployment evidence remain distinct. |
| [report.json](report.json) | Generated. Stable denominators and assessed/complete/qualified/deployed counts. No compatibility percentage. |
| [evidence/forgejo-qualify-20261016.json](evidence/forgejo-qualify-20261016.json) | 2026-10-16 `make forgejo-qualify` on a disposable pinned Forgejo 15.0.9/PostgreSQL stack: `smoke.py`, `workflow-config-smoke.py` and `forgejo-native-smoke.py` passed, cleanup true, served version `15.0.9+gitea-1.22.0` (Forgejo's own version string). |
| [evidence/forgejo-qualify-20261016-after-retirement.json](evidence/forgejo-qualify-20261016-after-retirement.json) | The same disposable qualification rerun on 2026-10-16 after the earlier backend was removed and the session RPCs, configuration fields, metrics and webhook headers were renamed; all three suites passed, cleanup true. |
| [evidence/forgejo-local.json](evidence/forgejo-local.json) | 2026-10-11 bounded Forgejo runtime, shadow-diagnostic, CI and check aggregate. |
| [evidence/worker-loss-forgejo-deep-20261011.json](evidence/worker-loss-forgejo-deep-20261011.json) | Owned two-job manual/signed-push fixture on fresh Forgejo with `.forgejo/workflows` precedence, historical exact Git source, worker death and fenced recovery. |
| [evidence/requests-forgejo-deep-20261011.json](evidence/requests-forgejo-deep-20261011.json) | Unchanged Requests push on fresh Forgejo with failure/egress denial, timeout and running cancellation. |
| [evidence/actual-git-engine.json](evidence/actual-git-engine.json), [evidence/job-git-v2.json](evidence/job-git-v2.json), [evidence/a1-checks.json](evidence/a1-checks.json) | 2026-10-07 forge-independent engine, native-Git-fixture, source and PostgreSQL evidence for the Git workspace milestone. They did not run against a forge server. |

Every REST operation has a row. Only four have reviewed assessments; 487 require the complete field/role/consumer audit. The source-tested merge consumer is explicitly incomplete, and the missing scheduled auto-merge cancellation consumer does not become implemented because it appears in Swagger. Neither an arbitrary proxy nor a matching route completes an operation; a route that exists in Forgejo is not parity with any other forge.

The served document is the denominator. A retained installation still needs its own version/configuration/spec comparison before deployment acceptance.

### 2026-10-16 rebase onto Forgejo

On 2026-10-16 the owner retired the previous provider entirely. There were no existing installations of it behind Golf, so no data migration was performed. This register was rebased from that provider's 1.27.3 source template onto the served Forgejo 15.0.9 document:

- Four of the five reviewed annotations carried over unchanged in method/path. `ActionsListRepositoryWorkflows` (`GET /repos/{owner}/{repo}/actions/workflows`) does not exist in Forgejo 15.0.9 and was dropped; it was a `missing` assessment, so no implemented coverage was lost. The two `native-tested` source reads now cite the Forgejo worker-loss receipt.
- Webhook constants follow Forgejo: `status`, `pull_request_review`, `workflow_run` and `workflow_job` are gone; `workflow_dispatch`, `action_run_failure`, `action_run_recover` and `action_run_success` are new. Registries follow Forgejo's documentation: `alt` is added and `terraform` is gone.
- Receipts collected on the retired provider were removed (they remain in Git history and are not Forgejo results). Features that cited them now cite only the Forgejo receipts above. The identity of the qualified CI job image in `profile.json` was recorded by one of the removed receipts; the Forgejo Requests receipt does not bind the job image digest.
- The `staging` section of `evidence/forgejo-local.json`, which recorded a data import from the retired provider, was removed. The rest of that receipt is unchanged, so its `limits` and `checks.transferBoundaries` still describe that import.
- The 2026-10-11 Forgejo receipts record the webhook dialect name and three-directory workflow order configured at the time (`nativeWebhookDialect`, `installedSpec.workflowDirs`). They are left as recorded. Golf now uses Forgejo's `X-Forgejo-*` headers and the two-directory default below.

## Native workflow locations

Inspection v3 and every new Actions source admission select the first existing configured directory, even when empty, malformed or containing only nested entries. Forgejo's default order is `.forgejo/workflows`, then `.github/workflows`. Both inventories are never merged, and direct dispatch from a suppressed directory is refused before source execution. Root `.gitlab-ci.yml` remains separate.

`GOLF_FORGE_WORKFLOW_DIRS` represents either known directory alone or both in either order. Helm uses `forgejo.workflowDirs`. Unsupported custom, duplicate or empty members fail explicitly. An externally configured Forgejo must match Golf's order. Forgejo's scheduler remains disabled in the managed profile.

Go settings/policy/grant/dispatch/source approval boundaries and their browser editors share the literal path contract. Exact commit/tree/blob reads, source limits, original operation keys, current authority and separate manual/push policies are preserved. Import/discovery cannot create an automation grant or enable execution. Source tests cover directory precedence, empty inventories, deletion/rename, symlink/file/submodule locations, malformed source and permission denial. [Detailed inspection contract](../WORKFLOW_CONFIGURATION_CONTRACT.md).

This remains a **direct-file profile**. Forgejo can discover nested workflow files; Golf reports that limitation instead of accepting or ignoring nested source as full parity. Custom directories, Unicode filenames, scoped workflows and broader event/runtime behavior need separate implementation and qualification.

Runtime evidence: the 2026-10-11 worker-loss receipt selected `.forgejo/workflows` first under the earlier three-directory order; the 2026-10-16 qualification's workflow-configuration smoke inspected `.github/workflows` sources on the pinned image. The two-directory default itself has source tests, not a dedicated runtime receipt.

## Opt-in historical Git workspaces

`GOLF_RUNNER_GIT_PREPARATION_IMAGE` selects an explicitly approved registry-digest-pinned Git image. The worker advertises `golf.runner.git-source.exact-h.v1` only after an actually verified TLS1.3 response, and refuses an Actions assignment that drops its configured Git profile. The controller negotiates that profile without changing the admitted workflow/archive identity. No control-plane or provider credentials enter jobs.

The [Forgejo worker-loss receipt](evidence/worker-loss-forgejo-deep-20261011.json) executes two fresh jobs at historical H after the native branch advances. Independent native Git fetch/readback confirms commit, tree, workflow blob and executable mode. The same qualifier kills the worker during a real running step: residue blocks normal startup, explicit recovery fences the original attempt as lost, removes only owned resources and creates no replacement run.

Git jobs have read-only roots and native local-driver tmpfs volumes: workspace 128 MiB, act environment 32 MiB, tool cache 64 MiB and temporary 32 MiB, each limited to 8192 inodes. The [engine receipt](evidence/actual-git-engine.json) records actual byte/inode exhaustion, wrong-tree refusal before any acknowledgement, cancellation and lost-create acknowledgement recovery against an owned TLS Git fixture. The five small vendored act adaptations preserve upstream defaults and have a reproducible hash-checked patch. [Preparation contract](../RUNNER_GIT_PREPARATION_CONTRACT.md).

These receipts do not complete A1. The [remote profile](../ACTIONS_REMOTE.md) separately qualifies scoped job-token delivery and genuine exact-H/depth1 checkout, with controlled dependency egress. Broader checkout options, long-step token refresh and the complete adversarial Git corpus remain open. Legacy catalogs retain network-none.

## Unchanged Requests baseline

The selected fixture is Requests `.github/workflows/lint.yml` at `414f0513c33883adf6f2b46901d4f0b38a455851`, SHA-256 `2adbd62821e06ee622aff3e1e6e283a9cf3e2dcf694a04040b43fd4291d96f99`. The earlier roadmap pin at `611c6162cbc4ac2020a2f91c7cfa4f3abf9bbb60` is preserved separately; its workflow bytes are identical. No source was rewritten to fit Golf.

The public [upstream baseline run](https://github.com/psf/requests/actions/runs/30289152821) is a separate GitHub observation. The [Forgejo Requests receipt](evidence/requests-forgejo-deep-20261011.json) records a private native repository on fresh pinned Forgejo, independent native Git readback of commit/tree/workflow, explicit sponsor grant and signed push under `golf.workflow.act.v0.2.89.linux.remote-node24.v1`. The original checkout and setup-python actions execute with Node24 and the unchanged dependency commands pass.

Separate controlled commits in the same receipt prove failed-command/denied-egress behavior, a one-minute job timeout and cancellation after a step is running; owned resources are removed and unrelated identities remain unchanged. [Operator setup and boundaries](../ACTIONS_REMOTE.md) documents the approved image, immutable public action bundles, TLS origins, scoped credentials and dependency proxy.

The workflow's `pull_request` declaration remains byte-identical, but only the sponsor-authored push path is qualified. Actual PR events are refused. Private remote actions, broad checkout options, workflow-level `github`/`secrets` expressions, services, provider artifact/cache APIs and full hosted-runner equivalence remain unsupported. Legacy catalogs continue to refuse the Requests fixture; their refusal test is still valid. Floating dependency versions are observed runtime resolutions, not a reproducible lockfile.

## Local checks and repeatable proofs

```sh
make compatibility-check
make forgejo-qualify
python3 scripts/compatibility/check.py --output .tmp/compatibility/new-source-attempt
# Privately configure an OWNED isolated PostgreSQL test database first:
python3 scripts/compatibility/check.py --layer database --output .tmp/compatibility/new-database-attempt
make check
python3 deploy/helm/golf/check.py
```

`make compatibility-check` verifies pinned bytes, the served specification's canonical hash, reviewed annotations, declared Forgejo webhook constants, evidence references and generated-output drift. It never fetches or executes upstream source; the webhook constants are checked against the list declared in `protocols.json`, which was compared with the upstream file at the recorded hash on 2026-10-16. The harness requires a new receipt directory, uses owner-only logs, records source/fixture/schema/profile hashes and preserves failed outcomes. Missing database configuration returns `infrastructure-unavailable` (exit 2); skipped database tests are not database proof. No repository CI workflow is added.

The actual native proof extends the existing launcher rather than introducing another scheduler:

```sh
python3 scripts/actions-two-job-smoke.py \
  --image sha256:YOUR_VERIFIED_CORE_IMAGE \
  --runner-image sha256:YOUR_VERIFIED_RUNNER_IMAGE \
  --source-revision YOUR_FULL_SOURCE_COMMIT \
  --expected-core-sha256 YOUR_CORE_BINARY_SHA256 \
  --expected-runner-sha256 YOUR_RUNNER_BINARY_SHA256 \
  --expected-engine-sha256 YOUR_ENGINE_BINARY_SHA256 \
  --forgejo-spec docs/compatibility/forgejo-15.0.9.swagger.json \
  --workflow-directory .forgejo/workflows --with-push --seed-approved-images \
  --output .tmp/compatibility/new-native-attempt
```

Supply actual built identities, never these placeholders. This creates a disposable uniquely named Compose project with high loopback ports, fresh native actors/data, the pinned Forgejo image, verified TLS1.3, the existing two-GiB reserve and existing execution resource limits. Optional seeding acquires only the two operator-approved digest-pinned images into the fresh owned daemon before source execution; it does not permit job egress. All project containers/volumes/networks are removed; foreign identities are compared and independent lifecycle changes remain observations, not attributed effects.

For the Git milestone, first run `scripts/actions-git-source-smoke.py --source-image YOUR_OWNED_GIT_IMAGE --registry-image registry:2 --go-binary YOUR_INSTALLED_GO_BINARY --output .tmp/compatibility/new-git-engine-attempt`. Pass that successful receipt to the same native launcher with `--git-image-proof RECEIPT_PATH --worker-death` and a fresh output directory. For the ordinary Actions profile, use `--ordinary-actions-bundles` and `--ci-job-image` as described in [operator setup](../ACTIONS_REMOTE.md).

The two-job fixture is owned test source. It is not Requests, full Git checkout, real GitLab Runner, hostile multitenant isolation, a failure/cancel conformance suite or retained deployment proof.

## Remaining packet gates

| Packet | Current progress; remaining exit |
| --- | --- |
| F0 | Executable pinned Forgejo 15.0.9 baseline exists; exhaustive consumer/field/role assessment remains open for 487 REST operations. GitLab/reference Runner profile remains unselected. |
| F1 | Direct native-directory selection/admission and bounded real manual/push proof on Forgejo; nested/custom location parity stays explicitly unavailable. |
| F2 | Named source/database checks, drift gates and distinct native/Docker receipts; complete reference differential/fault corpus remains open. |
| A1 | Opt-in exact-H Git workspaces, immutable image linkage, byte/inode quotas and actual fault/recovery proof pass. Scoped job credentials and genuine checkout pass separately; broader Git options, long-step refresh and the complete adversarial corpus still block the full exit. |
| A2 | Unchanged Requests push with pinned public Node24 actions, genuine checkout/toolchain and controlled dependency egress passes on Forgejo. Private actions, broader lifecycle/runtime behavior and full A2 exit remain open. |
| A3–A5 | Existing bounded graph/input/event profile retained; dynamic controls, services, action artifact/cache protocols, tokens/OIDC, reusable workflows, broader events/platforms and reruns remain open. |
| L0–L4 | Runner/coordinator/resolver/reference decision and all broader GitLab semantics/protocol/runtime gates remain open. A bounded shell script is not Runner interoperability. |
| G1–G4 | Use the complete Forgejo denominator to audit and implement fields, operations, registries and all product/machine consumers. Native role matrices remain required. |
| P1 | Effective every-ingress publication boundary, exact candidate/check/approval trust and race/fault proofs remain open; protected writes remain refused. |
| C1–C2 | Distinct CI-purpose connections/native run management and reconciliation/result publication remain missing; import credentials have not gained CI authority. |
| O1 | Owned cleanup/source identity evidence only; retained rollout, coordinated recovery, retention/quotas/scale and Kubernetes/Cloudflare corpus remain open. |

All broader obligations remain in scope. These registers make the remaining work measurable; they do not redefine this foundation as full compatibility.
