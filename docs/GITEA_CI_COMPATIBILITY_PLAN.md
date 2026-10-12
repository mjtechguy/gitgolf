# Gitea API completion and GitHub Actions / GitLab CI compatibility plan

Direction update (2026-10-11): the [Forgejo transition plan](FORGEJO_MIGRATION_PLAN.md)
supersedes Gitea as the destination backend. Retarget remaining native-operation
work to the qualified Forgejo profile; preserve this plan's GitHub Actions/GitLab
goals, trust boundaries and historical Gitea evidence. The transition is planned,
not yet implemented, and existing installations still use their current backend.

Date: 2026-10-07. Status: implementation underway. The [versioned register and evidence](compatibility/README.md) records F0 baseline, bounded F1 native workflow paths and initial F2 checks. Exhaustive API assessment and the later execution/forge/protection/operations packets remain incomplete; no retained deployment is implied.

Review baseline: `6e35c3d` in `golf-git`. The implementation ledger records the latest bounded deployment on frozen `f548567`, schema091. That is recorded historical evidence, not a runtime independently reverified during this review. The local Gitea HTTP endpoint was unavailable to the review session.

## 1. Objective and relationship to existing plans

Make Golf fully capable of the supported APIs offered by its selected Gitea version, and make GitHub Actions workflows and GitLab pipelines work with faithful behavior. Support both execution inside Golf and integrations with repositories whose canonical origin remains GitHub or GitLab.

This is an execution backlog for that objective, extending the [product plan](../GOLF_IMPLEMENTATION_PLAN.md), [Actions expansion packet](ACTIONS_COMPATIBILITY_IMPLEMENTATION.md), and [local completion queue](LOCAL_COMPLETION_NEXT.md). Existing implemented contracts remain authoritative for current behavior; the [implementation ledger](IMPLEMENTATION_STATUS.md) remains authoritative for recorded qualification and deployment. This plan does not mark any existing phase complete.

The older v1 plan deliberately targets Linux and bounded CI catalogs, with broader API/runner parity deferred. Those are intermediate milestones here, not a redefinition of the user's full-compatibility goal. Features outside the first milestone stay in the backlog with explicit blockers and acceptance criteria.

Recommended starting work:

1. Build the versioned Gitea operation inventory and compatibility corpus.
2. Add correct `.gitea/workflows` discovery and admission.
3. Finish the existing Git preparation/job-credential work, remote Actions execution, and controlled dependency access; run the unchanged Requests `lint.yml` selected by the existing roadmap.
4. Prove a pinned GitLab Runner against Golf's coordinator boundary before expanding GitLab syntax.
5. Advance protected publication as a separate release-critical workstream; CI execution can improve before it is eligible to authorize protected writes.

### 1.1 Define the compatibility promises separately

| Promise | Completion means | Insufficient evidence |
| --- | --- | --- |
| Gitea API feature coverage | Every supported operation in the pinned REST inventory has an implemented, permission-correct Golf consumer or an explicit disposition; registry/Git protocols have separate inventories. | A matching screen, an endpoint count, or a generic authenticated proxy. |
| GitHub Actions execution in Golf | Unchanged source has the declared event, graph, expression, runtime, token, service, failure, and cancellation behavior for the selected compatibility profile. | YAML acceptance, a shell command succeeding, or installation of `act`. |
| GitLab CI execution in Golf | Configuration resolution and pipeline decisions follow GitLab semantics, with actual Runner/coordinator interoperability and required services. | Running `script` through Docker or translating GitLab into approximate Actions semantics. |
| Connected-provider CI | Golf can discover, dispatch where supported, observe, cancel/retry where supported, retrieve logs/artifacts, and reconcile native runs with correct source and authority. | An encrypted import token or a successful repository migration. |
| Runner protocol compatibility | Specific runner versions authenticate and exchange real jobs, logs, artifacts, and outcomes with the declared coordinator. | Similar internal JSON or support for the same executor technology. |
| Protected CI-to-merge behavior | Trusted results and eligible approvals authorize the exact candidate under current policy, with effective publication fencing. | A green status name, a review count, or a Golf-only mutex. |

“Full” must be attached to a dated provider/version/feature profile. Do not claim universal compatibility with every future provider release, proprietary service, action, or runner binary. Conversely, do not label a selected passing subset as full: missing behavior remains visible. Workflows depending on provider-exclusive services require native connected execution or a separately implemented service contract.

### 1.2 Completion states

For each capability record these states separately: `unassessed`, `missing`, `source-tested`, `native-tested`, `runtime-tested`, `deployed`, and `blocked-upstream`. An operation can be implemented but unavailable in the installed profile. Record platform, role, size, and configuration limitations as fields, not footnotes hidden behind a Ready badge.

An intentional exclusion must state whether it is operator-only, outside the pinned provider API, or still missing from the requested goal. Excluding a real product capability does not count it as implemented. Report assessed/implemented/qualified/deployed counts separately, with a stable denominator and no unmeasured compatibility percentage.

## 2. Current foundation and verified gaps

This table records the original review baseline; the [current register](compatibility/README.md) and dated evidence above/below record shipped increments. The repo already has the Go/PostgreSQL control plane, supported Gitea API access, encrypted credentials, operation journals, repository/source/issue/PR consumers, reviews, organization and access controls, bounded packages/wiki/imports, isolated Docker execution, durable attempts, logs, and private artifact storage. Extend those systems first.

| Area | Existing foundation | Gap relevant to this goal | Starting source/contract |
| --- | --- | --- | --- |
| Native forge transport | Caller-scoped Gitea requests and shared mutation boundaries | Complete operation/field/role coverage is not inventoried in one executable register | [`forge.go`](../internal/server/forge.go), [forge086](contracts/PORTABLE_FORGE086.md), [forge089](FORGE089_CONTRACT.md) |
| Workflow discovery | Exact-commit `.github/workflows` and root `.gitlab-ci.yml` inspection | Native `.gitea/workflows` is missed; policy paths also reject it | [`workflows.go`](../internal/server/workflows.go), [`execution_policy.go`](../internal/server/execution_policy.go) |
| Actions engine | Pinned `act` v0.2.89; bounded jobs/needs/static matrices/conditions/local composites; typed manual input catalog | Opt-in public cached Node24 actions now qualify Requests push; private/Docker actions, services, reuse, dynamic behavior and wider contexts/controls remain refused | [`profile.go`](../engines/act/profile.go), [engine contract](ACTIONS_ENGINE.md) |
| Git workspaces | Trusted preparation, metadata validation, and job Git credentials have source and narrower native proofs | Actual enrolled Golf/Gitea checkout, worker/job delivery, broader Git semantics and current runtime qualification remain open | [Git preparation](RUNNER_GIT_PREPARATION_CONTRACT.md), [`actions_git_source.go`](../internal/runner/actions_git_source.go) |
| Execution/network | Pinned images, controlled Docker execution, attempt fences, bounded resources | Current jobs use network-none; ordinary dependency installation and many actions cannot work | [`execute.go`](../internal/runner/execute.go), [`actions.go`](../internal/runner/actions.go) |
| GitLab | One visible job/stage, digest-qualified image, shared shell, bounded literal artifacts | Includes, rules, inheritance, variables, graphs and real Runner protocol support remain open | [`workflows.go`](../internal/server/workflows.go), [`workflow_execution.go`](../internal/server/workflow_execution.go) |
| Artifacts and values | Golf-owned bounded objects and scoped execution values exist | Does not establish compatibility with upstream artifact/cache action protocols, GitLab reports, or every variable context | [pipeline catalog](PIPELINE_EXECUTION_COMPATIBILITY.md), [engine contract](ACTIONS_ENGINE.md) |
| Protected merge | Ordinary merge/squash, review observations, policy/write journals | Standard merge explicitly refuses protected targets; every-ingress candidate/check/approval enforcement is incomplete | [`standard_pull_merge.go`](../internal/server/standard_pull_merge.go), [ADR0004](decisions/0004-protected-integration-enforcement.md) |
| Provider connections | Personal selected GitHub/GitLab.com credentials and bounded imports | Not connected CI management; self-managed GitLab and complete private migration need separate work | [`provider_import086.go`](../internal/server/provider_import086.go) |

The pinned engine identity is defined in [`actions_protocol.go`](../internal/runner/actions_protocol.go). Existing input-free, typed-input, and first-party-agent catalogs are distinct; recognizing a catalog does not authorize it or prove it deployed. Do not enable the agent catalog as a side effect of compatibility work.

Earlier prose in the README and historical design packets can describe smaller capabilities than current source. Resolve contradictions using source plus the latest matching evidence, and update the current catalog documentation when shipping a change. Preserve dated failed receipts.

## 3. Engineering decisions and constraints

### 3.1 Reuse the current architecture

- Keep Gitea authoritative for Golf-hosted forge objects. Use supported APIs, Git protocols, and documented operator configuration. Do not edit its database or managed repository files from application features.
- Keep Golf/PostgreSQL authoritative for Golf-owned policies, operation intents, run attempts, credentials, and execution evidence. Reuse existing object storage, worker enrollment, live updates, and UI components.
- Keep the maintained Actions engine for Actions semantics. Extend its versioned wrapper and qualification corpus; do not grow the one-job shell compiler into a second general Actions engine.
- Keep GitLab configuration semantics separate. Share execution transport, authorization, object storage, and UI only where the contracts actually agree. Do not introduce a generic provider framework ahead of concrete consumers.
- Assign one execution owner per workflow/run. A native Gitea/GitHub/GitLab run and a Golf-owned run must remain distinguishable; a webhook must not accidentally start both.
- Use portable Docker first. Kubernetes and optional Cloudflare backends must pass the same contracts before advertising equivalent support. No AI dependency is needed for this work.

### 3.2 Record decisions before dependent implementation

| Decision | Recommended direction | Proof required / fallback |
| --- | --- | --- |
| D1: Gitea version profile | Start from the repo's pinned 1.27.3 baseline; inventory before upgrading | Fetch the installed version/spec, preserve digest, compare supported fields. A newer API is a separate upgrade packet. |
| D2: Actions execution owner | Extend existing Golf-owned `act` integration | Reassess native Gitea Actions only if it demonstrably lowers total work while preserving exact source, admission, cancellation, and uncertain-outcome contracts. Do not silently switch schedulers. |
| D3: GitLab semantics and Runner | Prove a maintained pinned Runner/coordinator slice; separately choose the configuration resolver strategy | Evaluate reuse against real GitLab outputs. If no maintained resolver meets semantics/licensing needs, document the cost of a bounded Golf frontend and native connected execution. Runner alone is not the resolver. |
| D4: Connected native execution | Offer an explicit native-provider execution mode | Use provider run IDs and current permissions; retain origin ownership. This can preserve provider-exclusive behavior but does not complete execution inside Golf. |
| D5: Protected publication | Continue ADR0004 supported mediation/extension feasibility | If a supported effective-write boundary cannot be proved, keep protected publication unavailable and document the upstream change required. |
| D6: Runtime platforms | Linux is the first complete profile | Inventory Windows/macOS/architectures and hosted toolchain dependencies now; add qualified pools or explicit native-provider execution later. They remain part of broader compatibility work. |

### 3.3 Preserve these contracts in every packet

Admission binds immutable repository/owner identity, exact source and dependencies, event, actor or automation grant, policy revisions, runtime images, attempt, and operation identity. Recheck current authority before credential release and result acceptance. Source-defined expressions and commands cannot select controller credentials or bypass runtime policy.

Keep unknown effects unknown. A lost dispatch response, worker lease, merge response, or artifact finalize acknowledgement is not permission to replay. Explicit retry/rerun creates a separately authorized attempt with its causal link. Preserve existing original-key inspection behavior.

Use the shared TanStack Form/DataTable and global styles for UI changes. Inventory first, requested forms second. Extend scoped CLI/MCP consumers deliberately; browser write authority does not automatically become delegated machine authority.

Run local checks. Do not add CI workflows to Golf's own source repository as part of this plan. Preserve the existing 2-GiB execution reserve and current resource limits; run heavy proofs serially and report a resource blocker rather than weakening the gate. Any necessary capacity change is an explicit operational task with measured requirements.

## 4. Foundation packets

### F0 — Operation inventory and compatibility baseline

**Priority:** first. **Depends on:** none. **Reason:** “fully capable” needs a complete, versioned denominator; otherwise feature work follows visible screens while missing provider operations and semantics.

- [x] Capture the installed Gitea version and public Swagger document, SHA-256, retrieval date, and enabled feature configuration. If the instance is unavailable, use a clearly labeled versioned official spec for planning and require installed-spec comparison before acceptance.
- [x] Generate a small operation inventory from that spec using existing tooling or the standard library. Keep any reviewed annotations separate from generated rows so regeneration preserves decisions.
- [ ] Map every operation ID and method/path to Golf handler, request/response fields, UI route, CLI/MCP command where appropriate, native token scope, unit permission, pagination, limits, and tests.
- [x] Inventory package registry protocols, Git HTTP/SSH/LFS, and webhook payloads separately; Swagger is not a complete protocol inventory.
- [x] Create separate Actions, GitLab, and connected-provider feature catalogs. Record syntax/behavior, provider version, engine/Runner version, OS/architecture, image digest, dependency commits, and test IDs.
- [x] Choose and pin the unchanged Requests `lint.yml` fixture already named by the roadmap. Record repository URL, commit, path, bytes/hash, required events/actions/toolchains, and baseline upstream results. Do not invent a commit or assume the fixture fits today's profile.
- [x] Inventory the blockers actually encountered by that workflow before estimating its implementation. Add small owned fixtures for individual semantics; do not edit the upstream file to make the acceptance pass.
- [x] Define a stable local evidence manifest and release report using the existing qualification conventions.

**2026-10-07 evidence:** [register](compatibility/README.md), [generated report](compatibility/report.json). The owned qualification Gitea 1.27.3 spec was compared; the retained installation was not inspected. All 482 REST operations have explicit rows, but 477 are unassessed. Protocol/event names are inventoried; full payload/client/role proof remains separate. GitLab/Runner selection stays explicitly unknown until L0. The original legacy-catalog Requests refusal remains a valid historical baseline; the later remote-profile push receipt separately qualifies actual Golf execution.

**Deliverables:** Gitea operation register, three compatibility catalogs, pinned fixture manifest, dependency/gap report. The initial files now exist under `docs/compatibility`; exhaustive mapping and later profile qualification remain open.

**Exit:** every pinned REST operation is classified; unassessed rows are visible; the first upstream workflow is reproducibly identified; baseline refusals are recorded without execution side effects. No percentage is presented as semantic compatibility.

### F1 — Native Gitea workflow paths

**Priority:** first small product change. **Depends on:** F0's selected Gitea profile. **Reason:** native Gitea repositories can currently have valid workflows that Golf never discovers.

- [x] Centralize supported workflow path recognition using the existing validators; find all callers across discovery, settings, policy, grants, dispatch, source verification, worker/engine validation, and UI.
- [x] Implement the pinned Gitea directory selection semantics. The documented default is `.gitea/workflows` followed by `.github/workflows`, using the first existing directory. Do not merge both inventories and accidentally duplicate execution.
- [x] Decide how supported operator `WORKFLOW_DIRS` settings are represented. Qualify configured paths or report an unsupported configuration; do not claim parity while silently ignoring them.
- [x] Preserve exact commit/blob reads, literal path bounds, YAML validation, and separate manual/push authority. Existing policy entries and original journal fingerprints must remain meaningful.
- [ ] Add cases for only either directory, both directories, an empty first directory, invalid file/symlink locations, renamed/deleted directories, malformed YAML, permission denial, and no automatic activation after import.
- [x] Qualify one real `.gitea/workflows` manual run and one authorized push run after the current engine's supported fixture is admitted.

**2026-10-07 evidence:** [native manual/signed-push receipt](compatibility/evidence/native-gitea-paths.json), [source/database/browser receipts](compatibility/evidence/local-checks.json), and [current bounds](WORKFLOW_CONFIGURATION_CONTRACT.md). Only the two known directories/direct literal files are admitted; native nested discovery remains an explicit gap. Directory/error/malformed-source cases and discovery without grant/run creation pass. A new actual import-to-discovery integration case remains required, so its encompassing checklist entry stays open. No historical policy paths or operation fingerprints were rewritten.

**Exit:** Golf and the pinned Gitea profile choose the same directory; explicit policy can admit its exact files; unsupported configurations explain the blocker; no duplicate trigger or policy expansion occurs. Reference: [Gitea workflow directories](https://docs.gitea.com/1.27/administration/config-cheat-sheet/).

### F2 — Conformance harness and diagnostics

**Priority:** begin with F0 and extend with every packet. **Depends on:** pinned profiles. **Reason:** compatibility is observable behavior, including rejection and failure, not just parser acceptance.

- [x] Reuse `scripts/actions-engine-qualification`, existing smoke helpers, engine tests, and source fixtures. Add the smallest harness required to compare declared behavior; do not create a second scheduler or general test platform.
- [x] Separate parser/resolver, engine, database, native-provider, actual Docker, browser, and retained-deployment evidence in results.
- [ ] Give unsupported diagnostics a feature code, file/location where available, provider profile, reason, and remediation. Never include secret values or private script excerpts in broadly visible metadata.
- [ ] Record original and resolved workflow/dependency identities and exact runner/image versions for both Golf and reference runs. Normalize nondeterministic timing/IDs for comparisons while preserving semantically relevant ordering and status.
- [x] Capture negative and fault outcomes as first-class cases; do not replace a failed receipt with a later passing receipt under the same identity.
- [x] Make local upgrade checks compare catalogs and fixtures before changing Gitea, `act`, Runner, action versions, or runtime images.

**Exit:** a maintainer can rerun a named capability's proof, distinguish unavailable infrastructure from semantic failure, and see exactly which profiles passed.

## 5. Actions execution packets

### A1 — Complete real Git workspaces and job credentials

**Priority:** first major execution packet. **Depends on:** F0/F2. **Reason:** archive extraction cannot satisfy normal checkout/history behavior, and the existing preparation work is already close enough to reuse.

- [x] Finish the existing `runner_git_source`, worker composition, fixed-file staging, manifest validation, and engine materialization path. Keep controller/worker credentials outside jobs.
- [x] Qualify an approved registry-digest-pinned Git job image, including platform/config/layer linkage and actual installed Git/TLS/runtime behavior within the exact-H preparation profile.
- [x] Fetch and materialize an actual historical admitted commit from Golf/Gitea after its branch has advanced; independently verify commit, tree, workflow, executable modes, and intended Git metadata.
- [ ] Complete separate job-token issuer reachability, delivery, expiry/rotation, masking, and cleanup with independently configured control-plane and public Git origins. Preserve exact repository/attempt/job scope.
- [ ] Specify supported Git protocol/fetch options. Current exact-H/depth1 preparation does not imply full history, tags, protocol-v2 negotiation, sparse checkout, submodules, or LFS support; implement and qualify each required checkout option.
- [ ] Test archive export attributes, symlinks, nested paths, malicious Git configuration, credential helpers, hooks, submodule URLs, LFS endpoints, and private cross-repository denial. No source-controlled option may redirect controller credentials.
- [x] Add a real job-workspace disk bound. Existing preparation tmpfs bounds are not job-volume quotas. Test resource exhaustion, lost container-create acknowledgement, cancellation, worker death, and cleanup with unrelated resources preserved.

**2026-10-07 historical preparation milestone:** [enrolled historical-source/worker-death proof](compatibility/evidence/native-historical-git.json) and [actual Git engine/image/exhaustion proof](compatibility/evidence/actual-git-engine.json). The opt-in `GOLF_RUNNER_GIT_PREPARATION_IMAGE` negotiates exact-H/depth1/v0 over verified TLS1.3. Git jobs use a read-only root and native tmpfs-backed byte/inode limits; the legacy archive profile is unchanged. Native Git independently verifies the actual tree because Gitea's REST commit tree field aliases H. Separate job credentials, broader checkout options and the complete adversarial Git corpus remain open, so **A1's full exit is not achieved**. No retained rollout or unchanged Requests run is claimed.

The historical separate job-token candidate has bounded v2 ls-refs/exact-H/depth1 handling. [Native Git and real PostgreSQL/race source proof](compatibility/evidence/job-git-v2.json) covers fresh/repeated fetches, narrowed capabilities, private cross-repository/foreign-H refusal and late authority changes. Trusted preparation stays v0. Eight native source-boundary cases additionally exercise export attributes, links/submodules, LFS pointers and malicious local configuration; their [receipt](compatibility/evidence/a1-checks.json) does not imply private job-token runtime qualification.

**Exit:** an enrolled worker prepares and executes the original historical source through the actual product path, with correct private Git behavior and no credential or resource leakage. Initial depth1 success remains a narrower milestone than complete checkout compatibility.

**Later 2026-10-07 local push increment:** [actual unchanged Requests](compatibility/evidence/requests-local.json) qualifies scoped job credential delivery against independently configured TLS control/public origins, genuine exact-H/depth1 private checkout over bounded v2, pinned public Node24 actions, authentic image toolcache selection and unchanged dependency commands. Failed command/denied-direct egress, one-minute timeout, running cancellation and cleanup pass. [Source/real PostgreSQL checks](compatibility/evidence/m2-checks.json) cover live revocation and masking separately. [Operator contract](ACTIONS_REMOTE.md) documents the opt-in deployment inputs. This supersedes the historical candidate's undelivered status for this profile only. Long-step token refresh, broader Git options, private actions, full lifecycle/command-file parity and actual PR/fork events remain open; **A1/A2's full exits are not achieved** and retained rollout is not claimed.

### A2 — Remote actions, JavaScript runtimes, and dependency access

**Priority:** next on the unchanged-workflow path. **Depends on:** A1; F0 determines the exact action/runtime list. **Reason:** the current local-composite-only admission and network-none runtime reject ordinary upstream workflows.

- [ ] Resolve supported remote action references to immutable commits before execution, retaining original source bytes and recording both requested ref and resolved identity. Bound recursion, downloads, redirects, repository size, and private-source authorization.
- [ ] Extend the existing dependency manifest to cover remote metadata and execution bytes. Verify cache contents against admitted identities. Resolve nested composite dependencies under the same policy and detect cycles.
- [ ] Add the JavaScript runtime required by selected action versions, including Node24 where required by the pinned fixture. Qualify entrypoint, pre/main/post behavior, action inputs, file commands, outputs, and cleanup.
- [ ] Make real `actions/checkout` work with truthful repository/server/token context. Do not silently replace it with a no-op because Golf prepared files earlier; action options and effects must actually hold.
- [ ] Add controlled dependency access for the selected ecosystem. Separate trusted action/image acquisition from source job egress. Define DNS, redirect, TLS, proxy, private-address, cloud-metadata, and cross-tenant boundaries.
- [ ] Keep normal dependency installation usable within approved policy. Record denied destinations and a clear remediation; do not claim that pinning an action makes arbitrary shell network activity safe or reproducible.
- [ ] Validate private actions and cross-project access with current producer/consumer authority. No fallback to an administrator PAT; no provider credential in a URL, log, image layer, cache, or artifact.
- [ ] Qualify required tool setup actions and dependency commands with actual downloads, failures, denied destinations, cancellation, and post-step cleanup.

**Exit:** the pinned unchanged Requests workflow runs to its expected result with genuine checkout, required actions/toolchain, and dependency access. If its declared events or other features require A3/A5, finish those exact dependencies before claiming this exit. A manually rewritten or synthetic substitute does not satisfy it.

### A3 — Complete graph, expression, and control behavior

**Priority:** follow the first upstream workflow's blockers, then broaden systematically. **Depends on:** F2 and the maintained engine. **Reason:** currently denied or upstream-ignored controls cannot become silently accepted.

- [ ] Inventory all target workflow/job/step keys and expression contexts against the pinned upstream reference, including YAML anchors/aliases, defaults, working directories, runner labels, and input types. Preserve safe expansion bounds while supporting valid syntax.
- [ ] Add dynamic matrices, matrix outputs, default fail-fast behavior, max-parallel, conditional dependencies, and job/step `continue-on-error` with matching outcome/conclusion propagation.
- [ ] Qualify coercion, null/missing properties, object filters, status functions, `hashFiles`, JSON functions, inputs, env/vars/secrets, `github`, `runner`, `job`, `steps`, `needs`, `strategy`, and `matrix` availability in each legal position.
- [ ] Implement timeout/cancellation and concurrency groups at the authoritative coordinator boundary where the engine does not enforce them; cover pending/running cancellation and cleanup. Define exact expression/group scope and do not confuse an explicit rerun with automatic recovery.
- [ ] Preserve independent job workspaces and trusted structured events. Source stdout, workflow command files, and action-reported annotations cannot manufacture completion evidence.
- [ ] Keep ignored or unfinished constructs rejected until both semantic and actual execution tests pass. Do not remove profile guards merely because upstream `act` parses a field.

**Exit:** the declared feature matrix matches reference outcomes for success, failure, skipped dependencies, matrix aggregation, cancellation, and timeout. Upgrade tests cover the narrow local `act` changes separately from upstream behavior. Reference: [GitHub workflow syntax](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax), [act limitations](https://nektosact.com/not_supported.html).

### A4 — Actions services, tokens, artifacts, and caches

**Priority:** required for broad real-world workflows. **Depends on:** A1/A2 and current storage/value boundaries.

- [ ] Qualify job containers, service containers, health checks, networking, volumes, ports, and Docker actions on explicit capable pools. Do not expose the controller daemon socket or permit privileged execution through YAML options.
- [ ] Implement versioned runtime service endpoints required by selected artifact/cache actions; qualify genuine upload/download/finalize, compression, chunking, limits, retention, expiry, retries, and dropped acknowledgements.
- [ ] Reuse current private object storage and immutable object identities. Distinguish miss, denial, expired data, and service outage. Prevent cross-repo/tenant reads and untrusted-fork cache poisoning.
- [ ] Complete variable/secret precedence and source contexts, masked streaming logs, secret-derived outputs, and fork/private dependency rules. A saved value or environment injection is not proof of full `secrets`/`vars` semantics.
- [ ] Define the supported job API token endpoints and permission intersection. Inventory actions that call GitHub REST/GraphQL or hardcoded services; implement required compatible services or use explicit native execution. Do not pretend Gitea's API is GitHub's API by changing a base URL.
- [ ] Implement truthful Golf-issued OIDC, scoped audiences/subjects/claims, expiry, and relying-party configuration. Never impersonate GitHub or GitLab's issuer.
- [ ] Connect protected environments, required approvals, concurrency, and deployment records to exact source/artifact/config identities before enabling deployment workflows.

**Exit:** real selected artifact/cache/service actions work, negative access and poisoning tests pass, and deployment authority is enforced independently of source claims. Broader provider API coverage remains an explicit catalog, not an arbitrary URL rewriting layer.

### A5 — Events, reusable workflows, and remaining platform coverage

**Priority:** staged after the initial execution path; bring forward any first-fixture dependency. **Depends on:** A3/A4 as applicable.

- [ ] Support branch/tag/path filters with actual provider matching behavior; do not substitute today's exact literal branch list for glob/negation semantics.
- [ ] Add PR events and fork trust, schedules/timezones/missed-run policy for the selected provider profile, reusable workflow calls, and supported workflow chaining. Model each event's source/base/merge commit and payload correctly.
- [ ] Resolve local and remote reusable workflows with pinned identity, inputs/outputs/secrets, nested calls, permission narrowing, and cross-project authorization.
- [ ] Add `merge_group` and connected-provider merge candidate events with exact tested candidates. Qualify privileged `pull_request_target`/`workflow_run` separately; they must not inherit ordinary untrusted-PR token rules accidentally.
- [ ] Resolve the current typed-input/manual versus push catalog gap for workflows declaring both triggers. Reuse the distinct admission/grant paths while evaluating each event's input semantics correctly.
- [ ] Inventory every remaining event, runner label/image/toolchain, architecture, Windows/macOS requirement, annotations/problem matchers, summaries, and other declared compatibility feature. Add qualified native pools or connected execution where appropriate.
- [ ] Add actual rerun/failed-job rerun semantics and immutable attempt history without replaying unknown previous attempts.

**Exit:** unchanged fixtures for every advertised event/reuse/platform class pass. Anything still unavailable remains a visible full-compatibility gap; a complete Linux subset is not universal hosted-runner equivalence.

## 6. GitLab execution packets

### L0 — Runner/coordinator feasibility and ownership

**Priority:** start during the first Actions milestone; serialize heavy runtime proofs. **Depends on:** F0/F2. **Reason:** GitLab compatibility is the largest architectural gap, and proving the protocol late would risk building unusable configuration support.

- [ ] Select a maintained GitLab Runner release and Docker executor profile, with exact binary/image/source identities, license obligations, and an upgrade test policy. Do not assume arbitrary Runner versions are interchangeable.
- [ ] Capture the real Runner exchange against an owned reference GitLab installation using non-secret protocol fixtures. Record creation/authentication, verification, job request, response payload, trace offsets, state updates, cancellation, artifacts, and session behavior required by the selected profile.
- [ ] Implement the minimal coordinator adapter into Golf's existing attempts/leases/policy. Do not introduce a second durable job owner or reinterpret an ambiguous assignment as safe to reissue.
- [ ] Give runner authentication, job tokens, Git transport, and artifact credentials distinct scopes and lifetimes. Validate unregistered/revoked workers and cross-attempt/cross-project access.
- [ ] Make one actual Runner execute a Golf-admitted job, return ordered logs and exact status, and upload/download a bounded artifact through the intended interfaces.
- [ ] Prove cancellation, expired credentials, worker restart/death, lost assignment/trace/status acknowledgements, duplicate requests, cleanup, and an uncertain outcome that stays non-green.
- [ ] Record D3 with protocol support, resolver strategy, ongoing maintenance cost, and native-connected fallback. If the protocol proof fails, leave Golf-native GitLab execution unavailable beyond the existing shell catalog.

**Exit:** an unmodified pinned Runner, not a simulated client, completes a real admitted job through Golf and passes the core failure/authority matrix. This proves transport/execution feasibility only. Reference: [GitLab Runner](https://docs.gitlab.com/runner/), [Runner registration](https://docs.gitlab.com/runner/register/).

### L1 — GitLab configuration resolver and immutable pipeline plan

**Priority:** immediately after or alongside L0's interface definition. **Depends on:** D3, F2. **Reason:** the GitLab server resolves configuration and decides jobs; Runner does not turn raw `.gitlab-ci.yml` into the pipeline.

- [ ] Implement/reuse supported YAML parsing with anchors, aliases, merge/inheritance behavior, hidden jobs, `default`, `inherit`, `extends`, and nested script forms, under explicit input/expansion bounds.
- [ ] Resolve local/project/remote/template/component includes and configuration inputs in stages, preserving GitLab merge order and semantics. Pin resolved source identities; authenticate private dependencies; bound recursion/size and detect cycles.
- [ ] Cover custom CI configuration paths and project/ref context where the selected provider version supports them. Root `.gitlab-ci.yml` alone is an initial location profile.
- [ ] Evaluate ordered `workflow:rules` and job `rules`, including `if`, regex, `changes`, `exists`, `when`, defaults, and pipeline-source/predefined-variable availability. Inventory legacy `only`/`except` if included in the target version.
- [ ] Freeze the resolved configuration, dependency identities, variable provenance, admitted job graph, and relevant policy. Preserve runtime-deferred decisions where GitLab actually defers them; do not incorrectly freeze dynamic child pipelines as static jobs.
- [ ] Differentially compare merged configuration and job selection with the pinned GitLab reference, using supported CI lint/config APIs where suitable and real pipelines for behavior those APIs do not prove.
- [ ] Fail the whole unsupported pipeline before source execution with useful diagnostics; do not execute only the jobs that happened to parse.

**Exit:** reference fixtures produce matching resolved configuration and job eligibility across push, MR, schedule, and manual contexts. Unsupported include/rule classes stay explicit. Reference: [GitLab YAML reference](https://docs.gitlab.com/ci/yaml/), [include semantics](https://docs.gitlab.com/ci/yaml/includes/).

### L2 — Graph, lifecycle, variables, and shell semantics

**Priority:** first usable GitLab pipeline milestone. **Depends on:** L0/L1; reuse A1's transport primitives where semantics agree.

- [ ] Add stages, `needs`/optional needs, dependencies, parallel/matrix jobs, stage defaults, and proper scheduling/failure propagation.
- [ ] Implement variable precedence, expansion timing, predefined variables, protected/masked/file variables, job overrides, and dotenv propagation. Do not translate them into Actions input semantics.
- [ ] Qualify `before_script`, `script`, `after_script`, shell selection, working directory/environment lifetimes, exit behavior, and cancellation with the actual Runner.
- [ ] Support manual/blocking jobs, delayed jobs, retries by failure class, `allow_failure`, `interruptible`, `resource_group`, timeout, and auto-cancel as separate tested catalog entries.
- [ ] Persist original pipeline/job/attempt identities and explicit user play/retry/cancel intents. Preserve upstream status distinctions in the UI and machine API.
- [ ] Run an unchanged two-stage pipeline using an include, variables, `needs`, and an artifact handoff; compare jobs, outputs, states, and failure variants with GitLab.

**Exit:** the first real multi-job pipeline and its failed/skipped/manual/cancelled variants behave as declared through the actual product and Runner. Shared shell success alone does not satisfy this gate.

### L3 — Artifacts, caches, services, registry access, and delivery

**Priority:** broad GitLab usability. **Depends on:** L2 and qualified shared object/network infrastructure.

- [ ] Implement artifact path/glob/exclusion behavior, upload timing, expiry, download/dependency access, reports, and dotenv with independent object verification. Add selected report consumers only when report semantics are supported.
- [ ] Implement cache keys/fallbacks/policies, protected/ref/trust separation, quotas, concurrent writers, eviction, poisoning protection, and correct outage versus miss handling.
- [ ] Qualify image acquisition, registry authentication, services/aliases/health checks, and build-container use on explicitly capable isolated pools.
- [ ] Implement the selected job-token API/registry/package endpoints and cross-project allowlist/actor checks; never expose a general PAT as `CI_JOB_TOKEN`.
- [ ] Support environments, protected deployment approval, stop actions, exact artifact/source promotion, and ID-token federation with truthful Golf issuer semantics and explicit relying-party setup.
- [ ] Qualify actual native Runner upload/download and registry clients; generic Golf object upload is not GitLab protocol proof.

**Exit:** representative test/build/package/deploy pipelines pass with real services and object exchange; untrusted jobs cannot poison privileged caches or obtain deployment/foreign-project credentials.

### L4 — Child/downstream pipelines and remaining GitLab compatibility

**Priority:** full-compatibility completion after L0–L3. **Depends on:** qualified core semantics and connected-provider boundaries.

- [ ] Implement parent/child, generated dynamic-child, multi-project, and triggered pipelines with configuration provenance, variable forwarding, permission checks, cancellation, and status propagation.
- [ ] Qualify merged-result pipelines and merge trains against their actual candidate commits and provider version/tier. Ordinary MR head execution is not equivalent.
- [ ] Inventory components/inputs, schedules, releases, Pages, security reports, external secrets, environments, and other selected version/tier features not yet covered. Assign each a Golf-native implementation or explicit connected-native requirement.
- [ ] Add self-managed GitLab version profiles and qualified executor/OS/architecture combinations. Differences in tier and instance configuration remain visible.
- [ ] Run owned real reference projects that exercise the completed feature classes, including permission removal and recovery.

**Exit:** every feature in the selected full profile has proof or an explicitly unresolved blocker. Native-connected execution must be labeled as such; it does not silently become Golf-native parity.

## 7. Gitea feature completion packets

F0 determines the exhaustive endpoint backlog. The groups below prioritize it and capture already known limits; examples in the inventory lists are obligations to assess, not assertions that every listed feature is absent today. Each endpoint task must implement request fields, response fields, pagination, token scope, per-unit authority, errors, current read/write access, unknown-outcome handling, and applicable UI/CLI/MCP consumers together.

### G1 — Repository, organization, identity, and collaboration coverage

**Priority:** close high-use gaps after F0; release-critical permissions work can run alongside execution. **Depends on:** F0 and current mutation journals.

- [ ] Audit all repository creation/fork/template/lifecycle/settings, source/content/batch/ref, branch/tag protection, collaborator/team/deploy-key, topic/watch/star, search and notification operations against the pinned inventory.
- [ ] Audit organization creation/edit/rename/delete, teams, members, repositories, per-unit permissions, invitations and supported organization hooks. Preserve owner/team authority; instance administration never substitutes for repository authorization.
- [ ] Audit issues/PRs/comments/reviews and their attachments, labels, milestones, assignees, reviewer requests, reactions, subscriptions, locking/pinning, deadlines, dependencies/blockers, tracked time and stopwatch operations.
- [ ] Audit user profile, keys/signing keys, token/application and administrative operations. Separate Golf-local identity from provider identity; avoid creating a second source of truth or exposing provider administrative actions to ordinary users.
- [ ] Complete the recorded pending-review/rebase/thread/coordinate gaps only where supported. For ranged suggestions or apply-as-commit, establish API support and effective source-write authority before adding a UI promise.
- [ ] Add role-matrix native tests using independent owner, admin, writer, unit-limited team member, reader, outsider and revoked actors. Include pagination, renames, deletion/recreation, archived/mirror/disabled units, and nullable fields.

**Exit:** every operation in the selected group has an exact disposition and proof; end-user workflows no longer stop at a read-only inventory when the supported mutation is in scope. Operations with true upstream gaps stay labeled blocked rather than implemented through private APIs.

### G2 — Packages, releases, attachments, and wiki completeness

**Priority:** useful CI outputs and everyday forge completion. **Depends on:** F0, current forge086/089 consumers, object/streaming limits.

- [ ] Extend generic packages beyond fresh personal-owner one-file publication: organization namespaces, versions, multiple files, replacement/deletion, linking/unlinking, and exact current read authority.
- [ ] Keep namespace privacy distinct from linked repository ACLs. Prove private/public/limited owner and organization cases before widening publishing.
- [ ] Implement documented registry protocols in a prioritized sequence driven by actual CI needs, such as OCI, npm, Python, and Maven. Inventory all remaining supported registry types; do not equate metadata REST coverage with registry-client compatibility.
- [ ] Provide least-privilege native client/job credentials and qualify real push/install/pull/delete clients. Include cross-namespace denial, revocation, immutable version rules and partial upload recovery.
- [ ] Complete release/asset and discussion attachment operations, including current 256-KiB upload limits where insufficient, bounded streaming, interrupted transfers, checksums, retention, replacement/deletion, and private downloads.
- [ ] Complete supported wiki title/navigation/history/assets behavior. Distinguish a history list from historical content. If a feature is only available through supported wiki Git, qualify that protocol explicitly; never read managed files directly.

**Exit:** an actual CI job can publish and consume the selected private package/artifact/release flow, ordinary authorized users can manage it, and native client behavior/privacy survives restart and revocation. Full registry completion is measured separately from the first client ecosystem.

### G3 — Imports, mirrors, hooks, and native Actions API consumers

**Priority:** integration completeness. **Depends on:** F0 and selected-provider imports.

- [ ] Complete pull/push mirror configuration and observed synchronization with exact remote/ref/error state. Do not claim a queue acceptance or later timestamp proves original-request causation or all-ref equality.
- [ ] Qualify owned private GitHub/GitLab imports: refs/history/tags/LFS/submodules as applicable; issues/PRs/reviews/comments/labels/milestones/releases/wiki/assets; identity mapping, protections, permissions, and CI files. Report loss per object category.
- [ ] Add restart/rate-limit/pagination/partial-import recovery and cutover validation. Preserve one canonical writer; do not silently enable imported schedules or executions.
- [ ] Inventory and implement supported repository/organization/system webhook operations and event payload coverage with correct administrative boundaries. Outbound Golf notification webhooks are a separate feature from native Gitea hook administration.
- [ ] Cover native Gitea Actions workflow/run/job/log/artifact/secret/variable/runner APIs as an explicit native execution profile. Keep native run identities distinct from Golf-owned runs and avoid two schedulers for one workflow.
- [ ] Recheck missing native operations against the pinned spec. The earlier 1.27.3 inventory reported no run-cancel endpoint; do not invent one or use undocumented web mutations. Record native-profile limitations and choose a qualified execution owner accordingly.
- [ ] Assess projects/boards against the selected supported API. The current pinned inventory reports no supported REST contract. Request an upstream supported capability or explicitly scope a Golf-owned board system; do not hide a new subsystem inside “API coverage.”

**Exit:** import/mirror receipts accurately describe preserved data and unresolved differences; native APIs are exposed with their real permissions and semantics; unsupported provider operations remain explicit blockers.

### G4 — Machine access and complete product usability

**Priority:** finish each G1–G3 slice with its consumers. **Depends on:** underlying qualified operation.

- [ ] Map API coverage to actual user journeys: browse/create/edit/manage/recover, not just route presence. Use shared forms, inventories, live invalidation, deep links, and accessible loading/error states.
- [ ] Extend typed protobuf/Connect interfaces and generated clients through existing generation. Avoid raw pass-through APIs that bypass identity or intent validation.
- [ ] Extend CLI/MCP reads and mutations where intended, with explicit per-operation grants and immutable repository binding. Review dispatch/cancel/merge/admin authority separately from current inspection grants.
- [ ] Test logout/revocation, stale async responses, direct links, pagination/search limits, mobile/theme/accessibility, and original-operation recovery against served routes.
- [ ] Maintain one capability view that distinguishes provider support, Golf implementation, policy permission, worker/storage availability, and runtime qualification.

**Exit:** an authorized user or explicitly delegated tool can finish the advertised workflow without native-admin workarounds; unavailable behavior has an accurate reason and does not produce mock success.

## 8. Protected publication packet

### P1 — Trusted CI results, approvals, and the effective write boundary

**Priority:** release blocker, begun early. **Depends on:** existing ADR0004 work; trusted CI evidence for final end-to-end acceptance. **Reason:** expanding CI while treating arbitrary green statuses as merge authority would leave the central trust requirement unsolved.

- [ ] Define the exact source head, target base, merge candidate, policy revision, effective reviewer identity/eligibility, producer identity, workflow/test revision, attempt and publication principal required for approval.
- [ ] Bind successful results to the candidate actually checked. Qualify same-repository and private-fork cases, base/head movement, changed workflow definitions, stale approvals, dismissed reviews and author/agent independence.
- [ ] Complete the supported publication mechanism from [ADR0004](decisions/0004-protected-integration-enforcement.md). A preflight read followed by an unguarded native write is insufficient; post-write detection cannot retract an invalid merge.
- [ ] Account for native HTTP API/web, Git HTTP/SSH, editor/batch writes, merges/auto-merge, mirrors, policy/review/identity changes and in-flight/background writers. Enforce the declared managed profile at every relevant path, or explicitly restrict/disable unqualified paths in that profile.
- [ ] Preserve provider-native authentication and recovery routes deliberately; do not accidentally expose an unrestricted native write path while making OAuth work.
- [ ] Prove conflicting intent exclusion, lost response, accepted native work after caller timeout, process death, restart, credential revocation, and uncertain outcome reconciliation without duplicate publication.
- [ ] Qualify an upstream-supported extension if mediation cannot provide the required transaction boundary. Do not substitute direct Gitea database/repository mutation.
- [ ] Only then connect protected merge/queue controls and deployment promotion to trusted CI/approval evidence. Ordinary native merge/squash remains its separate already-bounded feature.

**Exit:** independent race/fault tests show that stale, forged, revoked, wrong-candidate, and unqualified-ingress operations cannot publish. If this cannot be proved, protected integration remains blocked regardless of the number of successful CI runs.

## 9. Connected GitHub/GitLab CI packets

### C1 — Native-provider execution and run management

**Priority:** a useful independent route to broad provider behavior. **Depends on:** explicit execution-owner model and selected provider credentials. **Reason:** native execution preserves provider-specific behavior while Golf-native compatibility is built, and serves repositories that never migrate.

- [ ] Add separate connection purpose and grants for CI. Existing personal import PATs must not silently gain repository-wide discovery, workflow dispatch, checks, or administrative authority.
- [ ] Use scoped GitHub App/OAuth and suitable GitLab OAuth/project/group credentials according to the selected deployment. Handle renewal, revocation, account/installation removal and current project permissions.
- [ ] Implement supported workflow/pipeline discovery, dispatch, run/job detail, logs, artifacts, cancel, retry/rerun and manual-job actions. Bind native IDs to provider/connection/project/source and exact original intents.
- [ ] Determine each endpoint's actual dispatch source semantics and receipt behavior. A branch-name dispatch is not an exact-commit guarantee; an ambiguous response is not safely deduplicated by searching similar run titles/times.
- [ ] Add explicit UI selection between provider-owned execution and Golf-owned execution. Preserve origin CI unless deliberately reconfigured; report possible duplicate triggers and required-check mappings.
- [ ] Qualify GitHub.com and GitLab.com first, then configured self-managed/enterprise endpoints with validated origins, TLS, redirects, pagination, API versions, rate limits and tier differences.

**Exit:** Golf can operate and observe owned real native workflows/pipelines with accurate authority and status. Native execution is clearly labeled and does not masquerade as a successful Golf engine run. References: [GitHub workflows](https://docs.github.com/en/rest/actions/workflows), [GitHub runs](https://docs.github.com/en/rest/actions/workflow-runs), [GitLab pipelines](https://docs.gitlab.com/api/pipelines/), [GitLab jobs](https://docs.gitlab.com/api/jobs/).

### C2 — Events, reconciliation, and results returned to origins

**Priority:** required before unattended connected operation. **Depends on:** C1 and trusted Golf execution evidence.

- [ ] Add signed webhook intake with durable deduplication and exact provider/project binding; handle duplicate, missing, truncated, out-of-order and replayed deliveries.
- [ ] Reconcile native state with bounded cursors/rate budgets; retain recovery independent of webhook delivery. Do not assume identical delivery/retry behavior across providers or installations.
- [ ] Report Golf-owned results through supported checks/status mechanisms with stable producer identity and exact source/candidate/attempt mapping. Keep source-controlled status text separate from required-check authority.
- [ ] Handle PR/MR/fork permissions, merge groups/trains, permission removal, installation suspension, deleted repositories and credential expiry while work is queued or running.
- [ ] Prevent event feedback loops with recorded causality and bounded automation depth, preserving legitimate follow-up CI.

**Exit:** delayed/missing events recover, revocation stops new authority, duplicate delivery does not duplicate execution, and each required result is traceable to the original authorized candidate and execution owner.

## 10. Operations, recovery, and portability packet

### O1 — Release-grade lifecycle and deployment proof

**Priority:** incremental throughout; required before broad production claims. **Depends on:** each newly enabled execution/storage/credential feature.

- [ ] Add migration/upgrade/rollback procedures for new catalogs, plans, tokens, and object metadata. Drain or fence incompatible active attempts; do not leave old workers interpreting new assignments.
- [ ] Complete a current-schema coordinated fresh-target recovery of Golf, Gitea database/volumes, object storage and worker/outbound/control state. The recorded Golf-only schema091 restore is not this proof.
- [ ] Quarantine restored credentials, permissions, leases and pending external effects according to current recovery contracts; verify external revocations and preserve unknown operations.
- [ ] Implement source/log/artifact/cache/image retention, orphan accounting, quotas, bounded streaming and cleanup. Measure real workload disk/memory/CPU needs before changing capacity.
- [ ] Qualify queue fairness, per-tenant/repo concurrency, worker health/draining, cancellation latency, log backpressure, storage outage, sustained parallelism and resource exhaustion. Set numerical SLOs from measured requirements, not invented estimates.
- [ ] Validate dedicated Docker isolation for the declared trust class. Hostile multi-tenant execution may require a stronger VM/microVM boundary; a privileged trusted child daemon is not automatically that guarantee.
- [ ] Run the same capability corpus on Kubernetes and each optional Cloudflare execution/storage adapter before marking that profile ready. Pure Workers execution is not Linux/container compatibility.
- [ ] Bind rollout evidence to exact source, schema, engine, worker, image, action dependencies and served frontend. Perform independent post-deploy runs, preserve existing accounts/settings, and record rollback/failure evidence.

**Exit:** the advertised profile can be deployed, operated, revoked, upgraded, cancelled and recovered with preserved authority/data and demonstrable resource limits. A local happy-path workflow does not complete this gate.

## 11. Dependency order and delivery milestones

These are dependency milestones, not promised calendar dates. Estimate each packet after its baseline proof identifies the actual blockers. A single developer can execute them sequentially; separate owners can take independent packets only with agreed protocol/contracts and disjoint edits. Heavy native/Docker proofs share the existing capacity budget and must be coordinated.

| Milestone | Packets | Reviewable outcome | Must remain explicit |
| --- | --- | --- | --- |
| M0: measurable baseline | F0, initial F2 | Operation register, pinned upstream fixture, compatibility catalogs, current refusal report | No new execution support yet |
| M1: native discovery | F1 | Correct Gitea workflow path selection, policy, and actual bounded execution | Does not add remote actions |
| M2: ordinary unchanged Actions | A1, A2, fixture-required A3/A5 | Original Requests workflow with real checkout/actions/dependencies and independent source/result proof | Other Actions features/platforms remain cataloged gaps |
| M3: real GitLab foundation | L0, L1, L2 | Actual pinned Runner and unchanged multi-job configuration with include/variables/artifact handoff | Does not complete child pipelines, all reports or all GitLab features |
| M4: practical CI breadth | A3–A5, L3, C1/C2 | Reuse/events/services/cache/tokens and explicit native connected execution | Scope tied to actual qualified profiles |
| M5: forge coverage | G1–G4 | Exhaustive supported-operation dispositions and qualified end-user/machine workflows | Provider API gaps remain distinguishable |
| M6: protected publication | P1 plus relevant CI evidence | Exact candidate/check/approval enforcement and qualified publication | Starts early; must not wait for cosmetic forge completion |
| M7: full-profile release | L4, remaining Actions/forge gaps, O1 | Complete declared profile, recovery/upgrade/scale proof and published compatibility report | No universal/future-version claim |

Dependency rules:

- F0 drives every inventory and acceptance claim. F2 grows with each implementation; it is not a final testing phase.
- A1 enables real checkout; A2 depends on its credential/runtime boundaries. Bring forward only the A3/A5 behavior actually needed by the first unchanged workflow, then finish the rest.
- L0 establishes Runner interoperability; L1 establishes configuration meaning; L2 requires both. Shared Git/network/object services can be reused after their contracts are qualified.
- G1–G4 and C1 can proceed independently of most engine work. C2 result publication depends on trusted evidence and exact candidate mapping.
- P1 feasibility begins at M0. Its final acceptance consumes real CI evidence; failure remains a release blocker even if M2–M5 pass.
- O1 recovery/resource work accompanies each new durable state or execution capability. Do not defer every operational constraint until M7.

### 11.1 First implementation backlog

| Order | Task | Primary code/area | Definition of done |
| --- | --- | --- | --- |
| 1 | Pin baseline and produce operation/feature registers | Official/installed Swagger, docs, existing qualification helpers | Reproducible inventory with version/digest and explicit unknown rows |
| 2 | Pin Requests source and classify blockers | Existing public-repository/Actions qualification fixtures | Original workflow bytes and reference outcome; no edited substitute |
| 3 | Add `.gitea/workflows` end to end | `workflows.go`, `execution_policy.go`, dispatch/worker validators, existing UI | Discovery precedence, policy, source identity, manual/push tests and native proof |
| 4 | Finish prepared Git worker/job integration | `runner_git_source.go`, `internal/runner/actions_git_source.go`, engine Git consumer | Real historical-H job, approved image, job credentials, resource/loss cleanup |
| 5 | Admit and execute first required remote action | Engine profile/dependency manifest/runtime, existing broker | Immutable action bytes, correct JS runtime and pre/post behavior |
| 6 | Enable qualified dependency access | Existing runner transport/runtime policy | Actual package install plus denied-destination and credential isolation proof |
| 7 | Run unchanged Requests workflow | Product dispatch/push path and conformance harness | Correct original source, intended result, logs, cancel/failure variant and cleanup |
| 8 | Prove GitLab Runner/coordinator | Small adapter into existing attempts; owned reference fixture | Real Runner assignment/trace/status/artifact exchange and lost-ack behavior |
| 9 | Resolve first real GitLab pipeline | GitLab-specific resolver and current execution admission | Matching reference job selection, stages/needs/variables/include semantics |
| 10 | Close highest-use Gitea operations and protected-write feasibility | F0 register, existing forge journals, ADR0004 | Endpoint-specific native role proofs and explicit effective-write decision |

The table's order expresses the immediate product path, not a prohibition on starting L0 or P1 research earlier. Do not begin with another settings shell, a new queue/cache service, a broad rewrite of the forge client, or a general provider abstraction. Those do not remove the current execution blockers.

## 12. Acceptance corpus and evidence requirements

### 12.1 Minimum scenario families

| Family | Required cases |
| --- | --- |
| Unchanged source | Pinned public upstream workflow plus owned private repository; exact source bytes and dependency identities; historical commit after branch movement |
| Actions graph | Independent/dependent jobs, skipped/failed needs, matrix include/exclude/dynamic/fail-fast, outputs, expression coercions, continue-on-error |
| Actions integrations | Checkout options, JS/composite/Docker actions, pre/post, services, env/secret/input precedence, artifacts/cache, reusable workflows and selected event payloads |
| GitLab config | Includes/inheritance/defaults, variable expansion/precedence, ordered rules, stages/needs/matrix, before/after scripts, manual/retry/allow-failure, child/downstream pipelines |
| Provider roles | Personal owner, repository admin/writer/reader, unit-limited team member, organization role, outsider, revoked actor; original and connected identities |
| Trust boundaries | Fork PR/MR, private dependency, cross-repository token, hostile archive/config/action, poisoned cache, forged logs/status, secret-derived output, denied egress |
| Failure lifecycle | Nonzero exit, timeout, user cancellation, policy/credential revocation, worker death, service restart, lease loss, duplicate/out-of-order messages, lost acknowledgements, storage/network outage |
| Forge operations | Complete fields/pagination, null/missing values, disabled units, renamed/replaced/deleted resource, optimistic revision drift, partial accepted effects and original-only inspection |
| Protected publication | Wrong producer/candidate, stale source/base/review/policy, concurrent native writer, private fork movement, accepted work surviving caller timeout, crash/restart |
| Product/operations | Real served UI and explicit machine grants, authentication transitions, upgrade/rollback, restore quarantine, retention, quotas, resource exhaustion and owned cleanup |

A refused unsupported workflow should produce no partial execution or credentials. A supported runtime failure should produce the correct failed/cancelled/unknown state, not an unsupported diagnostic or invented success.

### 12.2 Evidence manifest

Use the existing receipt conventions to record: packet/test ID; source commit and dirty state; schema; Gitea/GitHub/GitLab profile; engine/Runner versions; host/pool/platform/image identities; workflow/dependency commits and hashes; actor/grant/policy identifiers without secrets; original operation/run/attempt/job IDs; expected and observed behavior; fixture ownership; cleanup; failure/unknown outcomes; and whether the evidence is source, native, actual runtime, browser, or deployed.

Keep private logs and source in authorized storage. A checked-in public manifest must not contain credentials, private source, mailbox addresses, private URLs, or sensitive fixture data. Store reproducible fixture definitions and sanitized summaries in the repository; private `.tmp` receipts alone are not a durable public compatibility corpus.

### 12.3 Local checks

For implementation changes, select relevant focused tests first, then the repository's required checks. The maintained engine is a separate Go module and is not covered by root `go test ./...`.

```sh
go test -p 1 ./internal/server -run '^(TestCompileWorkflowExecution|TestWorkflowInspectionGrammar|TestWorkflowBoundary|TestActionsManualPlanBinding|TestActionsLocalMetadataUsesExactNativeObjects)' -count=1
python3 engines/act/verify_upstream_source.py
go -C engines/act test -p 1 ./... -count=1
make check
```

These are existing commands, not proof of native execution. `make check` includes API generation verification, web checks, and engine checks. Database/race tests require `GOLF_TEST_DATABASE_URL` configured privately for an owned isolated database; tests skipped because it is missing do not count as integration proof. Use the corresponding existing browser/native/Docker qualifiers for each changed consumer, inspect their ownership/resource preconditions, and record actual evidence. Do not run destructive or capacity-heavy qualifiers against retained user state by default.

The preceding review ran focused server compiler/inspection/source-binding/manual-plan tests and four focused Actions admission tests successfully, plus the local engine source verifier. It did not run the full suite, a live provider pipeline, or a new Docker qualification. Documentation-only changes to this plan require link/structure/diff checks, not a product deployment.

## 13. Risks, unresolved decisions, and stop conditions

| Risk/decision | Why it matters | Required treatment |
| --- | --- | --- |
| Full compatibility exceeds older v1 | Existing defaults exclude real requested behavior | Retain phased delivery but explicitly track every deferred full-profile feature; never silently narrow the goal |
| Native Gitea API lacks a feature | A UI feature may exist without a supported public operation | Mark upstream blocker, choose supported protocol/extension where available, or separately scope a Golf-owned feature |
| `act` accepts but ignores a control | A workflow can look successful with altered semantics | Enforce through qualified Golf boundaries or reject before execution; keep upgrade corpus |
| GitLab server semantics are underestimated | Runner reuse alone does not implement pipeline selection | Complete L0 and resolver decision early, with real reference comparisons |
| Provider-specific actions/services | Same YAML does not imply same REST/GraphQL/OIDC service | Inventory endpoints and semantics; explicit native execution or separately supported service implementation |
| Strict policy conflicts with valid upstream workflow | A valid workflow may need privileges/network the installation denies | Report policy denial separately from unsupported syntax; full semantic support does not grant execution authority |
| Secrets/network/cache broaden attack surface | Supporting ordinary builds exposes new trust paths | Qualify attempt scopes, fork rules, egress and poisoning boundaries with actual negative tests |
| Protected merge lacks atomic/equivalent enforcement | Preflight observations race with independent writers | Keep P1 blocked until effective-write proof; do not treat native settings as stronger Golf guarantees |
| Disk/resource reserve blocks runtime proof | Current historical qualifications have stopped for capacity | Preserve the reserve, clean only proven owned disposable resources, measure and plan capacity explicitly |
| Stale docs and scattered receipts | Historical limits can misdirect new work | One current catalog per provider/profile, linked evidence and dated superseded scopes |
| Private-provider test credentials unavailable | Public/mock proof cannot establish private fidelity | Use explicitly owned fixtures and authorized credentials; record the exact missing native proof |
| API/version/tier drift | Current docs may differ from selected deployments | Pin versions, diff schemas/catalogs, and rerun relevant conformance before upgrade |
| Apparent no-effect after timeout | Upstream or job may have acted already | Preserve unknown outcome and inspect original identity; never blind retry or adopt a similar object |

No fixed delivery date or compatibility percentage is justified by the current review. Size packets after F0, A1/A2's actual fixture blockers, L0's Runner proof, and P1's boundary decision. A blocked packet should identify the failed contract, preserved evidence, and smallest next experiment, rather than accumulating unexercised UI/configuration.

## 14. Final definition of done

- [ ] The selected Gitea API/profile has an exhaustive operation and protocol register with no unassessed rows; implemented coverage and explicit upstream/out-of-scope dispositions are separately reported.
- [ ] Supported end-user/admin/machine workflows are complete with field, pagination, role, current-authority, uncertainty and native evidence; excluded product capabilities remain visible gaps.
- [ ] The selected Actions and GitLab full profiles pass unchanged source and differential semantics/runtime corpora, including failures, cancellation, tokens, services and declared platforms.
- [ ] GitLab Runner interoperability and any other claimed runner protocol are verified with exact real binaries, not substitute clients.
- [ ] Native-connected execution is independently qualified and visibly distinguished from Golf-owned execution; event recovery and result ownership are correct.
- [ ] Protected publication passes exact candidate/approval/producer/current-policy and every-relevant-ingress race/fault tests, or the release explicitly remains incomplete for that requirement.
- [ ] Current-schema coordinated recovery, upgrades, retention, quotas, worker loss and deployment rollback are qualified for each advertised infrastructure profile.
- [ ] The current capability catalog, user documentation, product plan and implementation ledger agree with the actual deployed binaries/configuration and identify remaining limitations.

## 15. Source references and maintenance

Primary references were consulted during the 2026-10-07 review. They describe upstream contracts, not evidence that Golf already implements them. Recheck exact versions when starting each packet.

- [Gitea 1.27 API](https://docs.gitea.com/api/1.27/) and [API usage/spec discovery](https://docs.gitea.com/1.27/development/api-usage/).
- [Gitea configuration](https://docs.gitea.com/1.27/administration/config-cheat-sheet/) and [Actions differences](https://docs.gitea.com/1.27/usage/actions/comparison/).
- [GitHub Actions syntax](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax), [reusable workflows](https://docs.github.com/en/actions/how-tos/reuse-automations/reuse-workflows), and [act limitations](https://nektosact.com/not_supported.html).
- [GitLab CI syntax](https://docs.gitlab.com/ci/yaml/), [includes](https://docs.gitlab.com/ci/yaml/includes/), and [Runner](https://docs.gitlab.com/runner/).
- [GitHub workflow APIs](https://docs.github.com/en/rest/actions/workflows), [run APIs](https://docs.github.com/en/rest/actions/workflow-runs), [GitLab pipelines](https://docs.gitlab.com/api/pipelines/), and [jobs](https://docs.gitlab.com/api/jobs/).

Maintain this backlog at each completed packet: update only its precise status, link reproducible evidence, enumerate new limits, and revise dependent tasks. Move actual qualification/deployment receipts into the implementation ledger without relabeling historical results. Keep the original workflow corpus unchanged; add new fixtures and version profiles deliberately.
