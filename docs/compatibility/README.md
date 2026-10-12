# Versioned Gitea and CI compatibility register

Date: 2026-10-07. This register records the executable baseline, native workflow locations and the opt-in local public Node24 Actions milestone of the [full compatibility plan](../GITEA_CI_COMPATIBILITY_PLAN.md). **The full plan is incomplete.** The unchanged Requests push workflow now passes with genuine checkout/actions/dependencies. PR/fork execution, broader Actions, actual GitLab Runner interoperability, connected CI, complete forge coverage, protected publication and release recovery remain open. Local qualification does not advance the retained deployment.

## Registers and identities

| File | Contract |
| --- | --- |
| [profile.json](profile.json) | Immutable Gitea/act/image/source identities, dependency hashes, selected platforms and explicit unselected GitLab/Runner profile. |
| [gitea-1.27.3.swagger.json](gitea-1.27.3.swagger.json) | Verbatim official Swagger source template at the peeled Gitea 1.27.3 commit. Its version placeholder is preserved. |
| [gitea-operations.json](gitea-operations.json) | All 482 method/path/operation IDs, parameters, responses, security, content types and references to frozen definitions. |
| [gitea-annotations.json](gitea-annotations.json) | Separate reviewed consumer/field/scope/permission/pagination/limit/test assessments. Regeneration preserves these. Unreviewed operations remain explicitly unassessed. |
| [protocols.json](protocols.json) | Four Git protocols, 23 documented registry types and all 28 pinned Gitea webhook/event constants. Actions-only events and the review group are distinguished from native hook configuration. Pinned public payload structs/JSON tags are referenced separately; payload/client qualification is still open. |
| [actions.json](actions.json), [gitlab.json](gitlab.json), [connected.json](connected.json) | Independent feature catalogs; source, native, actual runtime and deployment evidence remain distinct. |
| [report.json](report.json) | Stable denominators and assessed/complete/qualified/deployed counts. No compatibility percentage. |
| [evidence/native-gitea-paths.json](evidence/native-gitea-paths.json) | Sanitized owned-instance native/Docker proof, exact source/binaries/images/schema and limitations. |
| [evidence/local-checks.json](evidence/local-checks.json) | Named source/database/race/browser/build checks and preserved failure outcomes. |
| [evidence/native-historical-git.json](evidence/native-historical-git.json), [evidence/actual-git-engine.json](evidence/actual-git-engine.json) | Opt-in enrolled historical Git execution, worker-death recovery and actual disk/inode exhaustion; exact-H/depth1 only. |
| [evidence/job-git-v2.json](evidence/job-git-v2.json), [evidence/a1-checks.json](evidence/a1-checks.json) | Historical v2 candidate/native Git/source/database evidence, superseded for the bounded remote profile by the Requests receipt below. |

| [evidence/requests-local.json](evidence/requests-local.json), [evidence/m2-checks.json](evidence/m2-checks.json) | Original Requests push, actual failure/egress denial/timeout/running cancellation/cleanup; separate source and real PostgreSQL authority/race checks. |

Every REST operation has a row. Only five have reviewed assessments in this increment; 477 require the complete field/role/consumer audit. The three existing source-tested consumers are explicitly incomplete. Missing native Actions and scheduled auto-merge consumers do not become implemented because they appear in Swagger. Neither an arbitrary proxy nor a matching route completes an operation.

The official source is the planning baseline. The fresh qualification Gitea's actual public Swagger is compared against its `paths`, `definitions` and `securityDefinitions`; its canonical full-document hash is recorded separately. A retained installation still needs its own version/configuration/spec comparison before deployment acceptance. The qualifier does not modify the retained installation.

## Native workflow locations

Inspection v3 and every new Actions source admission select the first existing configured directory, even when empty, malformed or containing only nested entries. Default order is `.gitea/workflows`, then `.github/workflows`. Both inventories are never merged, and direct dispatch from a suppressed directory is refused before source execution. Root `.gitlab-ci.yml` remains separate.

`GOLF_GITEA_WORKFLOW_DIRS` represents either known directory alone or both in either order. Compose supplies the same value to Golf and native Gitea's `WORKFLOW_DIRS`; Helm uses `gitea.workflowDirs`. Unsupported custom, duplicate or empty members fail explicitly. Externally configured Gitea must match Golf's order. Gitea's scheduler remains disabled in the managed profile.

Go settings/policy/grant/dispatch/source approval boundaries and their browser editors share the literal path contract. Exact commit/tree/blob reads, source limits, original operation keys, current authority and separate manual/push policies are preserved. Import/discovery cannot create an automation grant or enable execution. Source tests cover directory precedence, empty inventories, deletion/rename, symlink/file/submodule locations, malformed source and permission denial. [Detailed inspection contract](../WORKFLOW_CONFIGURATION_CONTRACT.md).

This remains a **direct-file profile**. Native Gitea can discover nested workflow files; Golf reports that limitation instead of accepting or ignoring nested source as full parity. Custom directories, Unicode filenames, scoped workflows and broader event/runtime behavior need separate implementation and qualification.

## Opt-in historical Git workspaces

`GOLF_RUNNER_GIT_PREPARATION_IMAGE` selects an explicitly approved registry-digest-pinned Git image. The worker advertises `golf.runner.git-source.exact-h.v1` only after an actually verified TLS1.3 response, and refuses an Actions assignment that drops its configured Git profile. The controller negotiates that profile without changing the admitted workflow/archive identity. No control-plane or provider credentials enter jobs.

The actual enrolled-worker proof executes two fresh jobs at historical H after the native branch advances. Independent native Git fetch/readback confirms commit, tree, workflow blob and executable mode in each job. The same qualifier kills the worker during a real running step: residue blocks normal startup, explicit recovery fences the original attempt as lost, removes only owned resources and creates no replacement run. All owned stacks are removed; unrelated identities remain unchanged.

Git jobs have read-only roots and native local-driver tmpfs volumes: workspace128MiB, act environment32MiB, tool cache64MiB and temporary32MiB, each limited to8192 inodes. Actual byte/inode exhaustion, wrong-tree refusal before any acknowledgement, cancellation and lost-create acknowledgement recovery pass. The five small vendored act adaptations preserve upstream defaults and have a reproducible hash-checked patch. [Preparation contract](../RUNNER_GIT_PREPARATION_CONTRACT.md).

These historical preparation receipts do not complete A1. The later [remote profile](../ACTIONS_REMOTE.md) separately qualifies scoped job-token delivery and genuine exact-H/depth1 checkout, with controlled dependency egress. Broader checkout options, long-step token refresh and the complete adversarial Git corpus remain open. Legacy catalogs retain network-none; the retained installation is unchanged.

The historical job-token candidate supports bounded v2 discovery and exact-H/depth1 fetches, with native Git clients and v0/v2 PostgreSQL revocation fences. The later actual Requests receipt qualifies delivery against the native smart-HTTP service preamble. Trusted preparation stays v0. Contained ordinary source links are permitted only in the remote profile; unsafe links, export transformations and source-selected endpoint/helper/hook configuration remain refused.

## Unchanged Requests baseline

The selected fixture is Requests `.github/workflows/lint.yml` at `414f0513c33883adf6f2b46901d4f0b38a455851`, SHA-256 `2adbd62821e06ee622aff3e1e6e283a9cf3e2dcf694a04040b43fd4291d96f99`. The earlier roadmap pin at `611c6162cbc4ac2020a2f91c7cfa4f3abf9bbb60` is preserved separately; its workflow bytes are identical. No source was rewritten to fit Golf.

The public [upstream baseline run](https://github.com/psf/requests/actions/runs/30289152821) is a separate GitHub observation. [Actual local Requests proof](evidence/requests-local.json) records a private native repository, independent empty-reader commit/tree/workflow verification, explicit sponsor grant and signed push under `golf.workflow.act.v0.2.89.linux.remote-node24.v1`. The original checkout and setup-python actions execute with Node24; genuine setup-python selects the image's CPython3.14.8 toolcache. The unchanged final command installs pre-commit4.6.0, fetches public hooks and passes all nine checks.

Separate controlled commits prove failed-command/denied-egress behavior, a one-minute job timeout and cancellation after a step is running. The receipt binds exact binaries, images, source files, native schema and all four run identities; owned resources are removed and unrelated identities remain unchanged. [Operator setup and boundaries](../ACTIONS_REMOTE.md) documents the approved image, immutable public action bundles, TLS origins, scoped credentials and dependency proxy.

The workflow's `pull_request` declaration remains byte-identical, but only the sponsor-authored push path is qualified. Actual PR events are refused. Private remote actions, broad checkout options, workflow-level `github`/`secrets` expressions, services, provider artifact/cache APIs and full hosted-runner equivalence remain unsupported. Legacy catalogs continue to refuse the Requests fixture; their refusal test is still valid. Floating dependency versions are observed runtime resolutions, not a reproducible lockfile.

## Local checks and repeatable proofs

```sh
make compatibility-check
python3 scripts/compatibility/check.py --output .tmp/compatibility/new-source-attempt
# Privately configure an OWNED isolated PostgreSQL test database first:
python3 scripts/compatibility/check.py --layer database --output .tmp/compatibility/new-database-attempt
make check
python3 deploy/helm/golf/check.py
npm --prefix web test -- --workers=1 workflow-paths.spec.ts workflow-configurations.spec.ts execution-policy.spec.ts automation-grants.spec.ts repository-execution-values.spec.ts repository-runner-settings.spec.ts runner-controls.spec.ts
```

The harness requires a new receipt directory, uses owner-only logs, records source/fixture/schema/profile hashes and preserves failed outcomes. Missing database configuration returns `infrastructure-unavailable` (exit 2); skipped database tests are not database proof. `make check` checks the pinned corpus and generated inventory in addition to existing generation, Go, browser type and separate engine checks. It adds no repository CI workflow.

The actual native proof extends the existing launcher rather than introducing another scheduler:

```sh
python3 scripts/actions-two-job-smoke.py \
  --image sha256:YOUR_VERIFIED_CORE_IMAGE \
  --runner-image sha256:YOUR_VERIFIED_RUNNER_IMAGE \
  --source-revision YOUR_FULL_SOURCE_COMMIT \
  --expected-core-sha256 YOUR_CORE_BINARY_SHA256 \
  --expected-runner-sha256 YOUR_RUNNER_BINARY_SHA256 \
  --expected-engine-sha256 YOUR_ENGINE_BINARY_SHA256 \
  --workflow-directory .gitea/workflows --with-push --seed-approved-images \
  --output .tmp/compatibility/new-native-attempt
```

Supply actual built identities, never these placeholders. This creates a disposable uniquely named Compose project with high loopback ports, fresh native actors/data, pinned images, verified TLS1.3, the existing two-GiB reserve and existing execution resource limits. Optional seeding acquires only the two operator-approved digest-pinned images into the fresh owned daemon before source execution; it does not permit job egress. The owned two-job fixture runs manually and through a native HMAC-signed push, checks exact source/jobs/order/fresh workspaces/log scopes, original-key replay/restart, suppressed-directory refusal and exactly two total runs. All project containers/volumes/networks are removed; foreign identities are compared and independent lifecycle changes remain observations, not attributed effects.

For the Git milestone, first run `scripts/actions-git-source-smoke.py --source-image YOUR_OWNED_GIT_IMAGE --registry-image registry:2 --go-binary YOUR_INSTALLED_GO_BINARY --output .tmp/compatibility/new-git-engine-attempt`. It verifies immutable OCI bytes through an owned bounded registry and runs six actual engine/fault cases. Pass that successful receipt to the same native launcher with `--git-image-proof RECEIPT_PATH --worker-death` and a fresh output directory. The supplied core/worker/engine images must contain the matching current binaries. Both historical launchers preserve failed receipts and keep source execution network-none. For the separate ordinary Actions profile, use the same launcher with `--ordinary-actions-bundles` and `--ci-job-image` as described in [operator setup](../ACTIONS_REMOTE.md).

The fixture is the existing owned two-job source with its path/event declaration adapted for this test. It is not Requests, full Git checkout, remote Actions, real GitLab Runner, hostile multitenant isolation, failure/cancel conformance or retained deployment proof.

## Remaining packet gates

| Packet | Current progress; remaining exit |
| --- | --- |
| F0 | Executable pinned baseline exists; exhaustive consumer/field/role assessment remains open for 477 REST operations. GitLab/reference Runner profile remains unselected. |
| F1 | Direct native-directory selection/admission and bounded real manual/push proof; nested/custom location parity stays explicitly unavailable. |
| F2 | Named source/database checks, drift gates and distinct native/Docker/browser receipts; complete reference differential/fault corpus remains open. |
| A1 | Opt-in enrolled exact-H Git workspaces, immutable image linkage, byte/inode quotas and actual fault/recovery proof pass. Bounded scoped job credentials and genuine checkout now pass separately; broader Git options, long-step refresh and the complete adversarial corpus still block the full exit. |
| A2 | Unchanged Requests push with pinned public Node24 actions, genuine checkout/toolchain and controlled dependency egress passes. Private actions, broader lifecycle/runtime behavior and full A2 exit remain open. |
| A3–A5 | Existing bounded graph/input/event profile retained; dynamic controls, services, action artifact/cache protocols, tokens/OIDC, reusable workflows, broader events/platforms and reruns remain open. |
| L0–L4 | Runner/coordinator/resolver/reference decision and all broader GitLab semantics/protocol/runtime gates remain open. A bounded shell script is not Runner interoperability. |
| G1–G4 | Use the complete denominator to audit and implement fields, operations, registries and all product/machine consumers. Native role matrices remain required. |
| P1 | Effective every-ingress publication boundary, exact candidate/check/approval trust and race/fault proofs remain open; protected writes remain refused. |
| C1–C2 | Distinct CI-purpose connections/native run management and reconciliation/result publication remain missing; import credentials have not gained CI authority. |
| O1 | Owned cleanup/source identity evidence only; retained rollout, coordinated recovery, retention/quotas/scale and Kubernetes/Cloudflare corpus remain open. |

All broader obligations in the original plan remain in scope. These registers make the remaining work measurable; they do not redefine this foundation as full compatibility.
