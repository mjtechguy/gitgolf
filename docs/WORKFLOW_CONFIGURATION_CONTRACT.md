# Workflow configuration inspection

`WorkflowService.InspectWorkflows` discovers and inspects repository workflow source at a resolved immutable commit. It supports configured Forgejo/GitHub Actions configuration locations and GitLab's root configuration location as distinct formats. **Inspection does not dispatch a job or activate a trigger.** `executionAvailable` reports whether this process has configured worker enrollment and approved images. It does not grant current policy permission or mean that every inspected file supports manual execution; the separate dispatch path revalidates those requirements.

## Source and authorization

The browser-only request is `{repository:{owner,name},ref}`. An omitted ref selects the native default; a branch/tag is resolved once to a full commit object. The response returns decimal `repositoryId`, `commitId`, catalog version `golf.workflow.inspect.v3`, configurations and discovery diagnostics. A later branch movement does not change reads explicitly addressed to the returned commit. Empty repositories fail precondition. A repository with no matching files returns an empty successful inventory.

Actions selects the first existing directory in the configured Forgejo `WORKFLOW_DIRS` order: by default `.forgejo/workflows`, then `.github/workflows`. An empty first directory, a directory containing only nested entries, or malformed YAML does not activate the fallback. Inventories are never merged. Direct `*.yml`/`*.yaml` files and root `.gitlab-ci.yml` are inspected. Nested workflow discovery is explicitly unsupported by this Golf profile, regardless of native discovery behavior. Non-directory, symlink and submodule locations are diagnosed without following them; permission errors are never interpreted as absence. GitLab custom configuration paths, external configurations and `.gitlab-ci.yaml` are outside this catalog. Includes, actions, symlinks, submodules and LFS targets are never fetched or executed.

The existing browser cookie/exact-Origin/Connect boundary and current native repository permissions apply. Native identity, session authority, repository ID/name and access are checked around provider work; stale private output is withheld after observed denial. `read:user` and repository-read authority are required. Read-only delegated API credentials cannot call this browser procedure; CLI/MCP catalogs are unchanged. No alternate privileged forge credential is used.

Forgejo's supported Git commit/tree/blob APIs supply immutable metadata before file content. Every object request is bound to the resolved commit, its tree and the selected blob; a mutable ref is not reused for file reads. Returned metadata must match the selected path/type/size/blob ID, and Golf recomputes the Git blob hash over the decoded bytes (SHA-1 or SHA-256 object format). This binds inspected bytes to the reported object, not to a future branch head or a trusted CI producer.

## Operator selection and admission

`GOLF_FORGE_WORKFLOW_DIRS` accepts either known directory (`.forgejo/workflows`, `.github/workflows`) alone or both in either order. Compose sets Forgejo's `FORGEJO__actions__WORKFLOW_DIRS` and Golf from this same value. Helm uses `forgejo.workflowDirs` for both processes. Unknown, duplicate or empty list members fail startup/rendering with an explicit unsupported-configuration error; custom directories need a separately qualified profile. Externally managed Forgejo must use the same order. Native Forgejo Actions remains disabled in this managed profile, so Golf owns execution.

The shared Go and browser validators accept direct ASCII filenames (`A–Z`, `a–z`, digits, `_`, `-`, `.`), a lowercase `.yml`/`.yaml` suffix, no `..`, and at most 255 bytes for the whole path. Existing root `.gitlab-ci.yml` policy entries remain valid. Settings, policies, grants, source approvals and runner controls share this boundary; arbitrary catalog-visible filenames can still report an unsupported diagnostic.

Every new dispatch/preparation/push source read also checks directory selection at the exact admitted commit. Knowing a blob ID or explicitly allowing a path cannot dispatch from the suppressed directory. Adding a file, inspecting or importing a repository does not enable policies, runner enrollment or automatic grants. Manual and push authority remain separate. Saved policy paths and original operation fingerprints are not rewritten.

A planner profile refusal produces bounded structural diagnostics and the selected engine catalog with remediation. Planner failure or native permission/availability failure remains an error, rather than being mislabeled as unsupported syntax. No source excerpts enter these messages. [Qualification and remaining compatibility](compatibility/README.md).

## Output and limits

Each `WorkflowConfiguration` returns path, blob ID, `byteSize` (uint64; a decimal string in protobuf JSON), format, state, optional display name, bounded job summaries/event names and diagnostics. Job summaries contain ID/name/stage/step count. Commands, variables, secret values and raw YAML are not returned; the existing source browser is the separately authorized way to read the file. Diagnostics have fixed codes/messages and available one-based line/column locations. Parser errors do not echo source excerpts.

| Bound | Behavior |
| --- | --- |
| 20 discovered configuration entries | Whole request fails resource-exhausted above the cap; no partial success. |
| 64 KiB per ordinary source file | Larger files remain metadata-only with an unsupported reason and are not downloaded. |
| 512 KiB aggregate eligible file bytes | Whole request fails before fetching content when the metadata sum exceeds the cap. |
| 1,000 entries per discovery directory | Existing source-directory bound; overfull results fail. |
| YAML depth 32 / 4,096 nodes | Invalid inspection result when bounded-node traversal exceeds either limit. |
| 50 jobs / 50 event names / 50 exact push branches | Explicit limit diagnostics; no implied complete graph beyond the bound. |
| 32 diagnostics per configuration; one discovery diagnostic for nested directories | A final limit notice reports omitted additional findings; state never becomes accepted because diagnostics were capped. |

The maintained `go.yaml.in/yaml/v3` parser is pinned to v3.0.5, already used by Golf's tooling. Golf decodes a size-bounded document to `yaml.Node`, preserving locations; it never decodes aliases into expanded application values. A bounded traversal rejects aliases/anchors, explicit tags, merge keys, duplicate/non-string mapping keys and unsupported controls. Multiple documents and malformed/invalid UTF-8 fail inspection. Depth/node limits are checked on the parsed tree, not advertised as a streaming parser limit. No YAML scalar invokes a constructor, shell, expression evaluator or network resolver. [Parser API and compatibility](https://pkg.go.dev/go.yaml.in/yaml/v3@v3.0.5).

## Versioned static subset

`VALIDATED_SUBSET` means **“Inspection subset checked.”** It does not mean “valid on every provider,” “engine supported,” “safe script,” or “ready to run.” `UNSUPPORTED` reports valid or potentially valid provider constructs Golf does not interpret. `INVALID` reports malformed text/structure or an inspection safety bound. The diagnostic identifies the applicable limitation. Unknown fields never silently disappear into a successful subset result.

| Format | Inspected shape | Outside the subset |
| --- | --- | --- |
| GitHub Actions | Optional literal name; input-free `workflow_dispatch` or `push` as a scalar/mapping; optional exact push branch list; exactly one job with a literal `runs-on` label; ordered nonempty shell steps with optional name and `sh`/`bash`, each containing `run`. | Other events, event sequences, glob/path/tag/ignore filters, inputs, expressions, actions/reusable workflows, permissions, environment/variables/secrets, conditions, defaults, dependencies/matrices, services, artifacts/caches and all other fields. A runner label does not identify an installed or equivalent hosted image. |
| GitLab CI | Optional one-stage list; exactly one visible job; optional matching stage (default `test`); literal image reference with lowercase SHA-256 digest; nonempty script string or flat string list; optional job-level `before_script` string or flat list (including `[]`); at most 50 combined setup/script entries. | Global defaults/variables, includes/templates/components, hidden jobs/inheritance, rules, services, artifacts/caches, dependencies/parallel graphs, downstream triggers and other job fields. A digest-shaped reference is not a pulled, trusted or approved image. |

GitLab and Actions are not normalized into one pretend execution semantics. The inspector checks declarations without selecting an event. It does not evaluate variable precedence, expressions, manual gates or scheduling. The separate compiler has only the explicit manual/branch-push selection described below. Shell script text remains untrusted even if its YAML shape is inspected. Source contracts: [GitHub workflow syntax](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax), [GitLab CI syntax](https://docs.gitlab.com/ci/yaml/), [GitLab YAML reuse](https://docs.gitlab.com/ci/yaml/yaml_optimization/).

## Qualification

Run `go test -race ./internal/server -run '^TestWorkflow' -count=1` with an isolated `GOLF_TEST_DATABASE_URL` for real PostgreSQL authorization tests. Parser fixtures cover safe/unsupported/invalid shapes, duplicate keys, aliases/cycles/tags, raw and decoded controls, depth/nodes and bounded diagnostics. Controlled-provider tests cover commit pinning, blob corruption, metadata-first limits, missing/symlink locations, native scopes and withholding output after authority/repository changes during a source read. Without the DSN, database-backed tests explicitly skip.

`python3 scripts/workflow-config-smoke.py` uses the running local Compose stack, requires pinned Forgejo 15.0.9 (reported version `15.0.9+gitea-1.22.0`, Forgejo's upstream version string) with native Actions disabled, and creates only disposable ordinary users/private repository content. It exercises real Git-pushed configurations, exact object IDs, old-commit inspection after branch advancement, unsupported/invalid source, access/scope/revocation, Origin/delegation denial and count/aggregate bounds. It removes native fixture resources and sessions; immutable Golf identity/operation/audit history follows existing retention behavior. It does not start/restart services, execute workflows or mutate retained administrator accounts. Terminal results and the exact qualified image belong in the [implementation ledger](IMPLEMENTATION_STATUS.md); a script's presence is not a passing run.

## Trigger-aware shell compilation

The existing manual compiler retains its eligibility boundary: an Actions workflow must explicitly declare input-free `workflow_dispatch`. A push-only file is not manually executable merely because inspection passes. A mapping may declare both supported events; push branch filters apply to push selection, not manual selection. The existing single-job GitLab script subset remains manually selectable. Compiled Actions steps remain separate shell processes; GitLab job-level `before_script` followed by `script` entries remain one shared shell script. Variables, functions and working directory persist from setup into the script; failure under the existing `sh -e` profile stops the job. Global/default setup inheritance and `after_script` remain refused, since the latter requires a separate lifecycle and shell. Linux runner-label and 50-step execution limits are unchanged.

`compileWorkflowPushExecution(format, data, ref)` is the internal push compiler. It returns an executable plan with `matched=true`, `(nil, false, nil)` for an inspected but nonmatching trigger/ref, or a generic failed-precondition error for unsupported/invalid configuration. Unsupported fields reject the **whole** configuration even when the requested ref would not match. No commands or private source excerpts enter compiler errors.

Supported Actions declarations are:

```yaml
on: push
```

```yaml
on:
  push:
    branches: [main, release/stable]
  workflow_dispatch:
```

An empty/null `push` mapping also matches branches. Branch lists contain 1–50 distinct literal Git branch names, compared case-sensitively against the suffix of a full `refs/heads/...` ref. No prefix, suffix, glob, negation or escape-pattern matching occurs. Duplicate names, malformed refs, scalar/empty lists and pattern characters (`*`, `?`, `[`, `]`, `+`, `!`, `\`) are outside the subset. `paths`, `paths-ignore`, `branches-ignore`, tag filters, event lists, expressions and every other event/filter remain unsupported.

Golf's initial automatic compiler admits **branch pushes only**, including when `on: push` is unfiltered. Tag and other ref namespaces do not match. Native GitHub supports additional tag/filter semantics; this narrower mapping does not implement them. The caller must independently reject branch deletion/zero-after events, verify the exact after-commit and configuration/source objects, and authorize a current durable grant and all execution-policy ceilings. A syntax match is not execution authority. [GitHub push filters](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax#onpushbranchestagsbranches-ignoretags-ignore).

For GitLab, Golf maps the existing one-visible-job, pinned-image, plain-script configuration to branch push selection when no `rules`, `only`, `except`, `workflow`, includes or other unsupported fields are present. GitLab documents branch-pipeline behavior for jobs without rules, but Golf does not evaluate GitLab's pipeline-source/rules engine or claim its other default cases. Tags, schedules, merge-request pipelines and GitLab predefined variables remain outside this mapping. Inspection event names stay empty for GitLab because the accepted source has no explicit event declaration. [GitLab jobs without rules](https://docs.gitlab.com/ci/jobs/job_rules/#avoid-duplicate-pipelines).

Run the focused compiler and grammar checks with:

```sh
go test -race ./internal/server -run '^Test(CompileWorkflow|WorkflowInspectionGrammar)' -count=1
```

They cover exact/case-sensitive matching, tags and invalid refs, the 50/51 branch boundary, combined/manual-only/push-only eligibility, preserved shell commands and rejection of unsupported Actions/GitLab filters. This is a pure compiler proof; it performs no provider writes or Docker execution. Actual automatic dispatch remains subject to the durable grant, policy, materialization and runner-fence qualification in [local automation](LOCAL_AUTOMATION_IMPLEMENTATION.md).

## Execution and remaining compatibility gates

Golf already has a separately qualified, explicitly authorized manual Docker shell executor; see the [runner isolation contract](RUNNER_ISOLATION_CONTRACT.md) and [implementation ledger](IMPLEMENTATION_STATUS.md) for exact evidence and deployment boundaries. Inspection and this trigger compiler do not by themselves enable push execution. No `act`, GitHub-hosted image equivalence or GitLab Runner coordinator compatibility is claimed by Golf's shell executor.

The wider [plan §7](../GOLF_IMPLEMENTATION_PLAN.md#7-actions-and-gitlab-pipeline-compatibility) still requires qualified engine adapters, richer graphs/actions/includes, artifact/cache and credential handling, scalable pools, Kubernetes assignment and a separate Cloudflare executor proof. Provider-specific conformance must be demonstrated one supported catalog entry at a time. The [public repository qualification](PUBLIC_REPOSITORY_QUALIFICATION.md) records related import/runner prerequisites; no CI workflow is added to Golf's own repository by this increment.
