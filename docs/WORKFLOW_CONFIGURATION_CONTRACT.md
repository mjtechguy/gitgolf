# Workflow configuration inspection

`WorkflowService.InspectWorkflows` discovers and inspects repository workflow source at a resolved immutable commit. It supports the GitHub Actions configuration location and GitLab's root configuration location as distinct formats. **No CI execution engine, trigger, runner, check result or job dispatch is implemented by this endpoint.** `executionAvailable` is always false, including when a file passes the inspection subset.

## Source and authorization

The browser-only request is `{repository:{owner,name},ref}`. An omitted ref selects the native default; a branch/tag is resolved once to a full commit object. The response returns decimal `repositoryId`, `commitId`, catalog version `golf.workflow.inspect.v1`, configurations and discovery diagnostics. A later branch movement does not change reads explicitly addressed to the returned commit. Empty repositories fail precondition. A repository with no matching files returns an empty successful inventory.

Supported discovery locations are direct children `.github/workflows/*.yml` and `*.yaml`, plus root `.gitlab-ci.yml`. Discovery is not recursive. A non-directory `.github` or `workflows` location is diagnosed, not followed. GitLab custom configuration paths, external configurations and `.gitlab-ci.yaml` are outside this catalog. Includes, actions, symlinks, submodules and LFS targets are never fetched or executed.

The existing browser cookie/exact-Origin/Connect boundary and current native repository permissions apply. Native identity, session authority, repository ID/name and access are checked around provider work; stale private output is withheld after observed denial. `read:user` and repository-read authority are required. Read-only delegated API credentials cannot call this browser procedure; CLI/MCP catalogs are unchanged. No alternate privileged forge credential is used.

Gitea's supported contents API supplies metadata before file content. Every content request uses the resolved commit. Returned metadata must match the selected path/type/size/blob ID, and Golf recomputes the Git blob hash over the decoded bytes (SHA-1 or SHA-256 object format). This binds inspected bytes to the reported object, not to a future branch head or a trusted CI producer.

## Output and limits

Each `WorkflowConfiguration` returns path, blob ID, `byteSize` (uint64; a decimal string in protobuf JSON), format, state, optional display name, bounded job summaries/event names and diagnostics. Job summaries contain ID/name/stage/step count. Commands, variables, secret values and raw YAML are not returned; the existing source browser is the separately authorized way to read the file. Diagnostics have fixed codes/messages and available one-based line/column locations. Parser errors do not echo source excerpts.

| Bound | Behavior |
| --- | --- |
| 20 discovered configuration entries | Whole request fails resource-exhausted above the cap; no partial success. |
| 64 KiB per ordinary source file | Larger files remain metadata-only with an unsupported reason and are not downloaded. |
| 512 KiB aggregate eligible file bytes | Whole request fails before fetching content when the metadata sum exceeds the cap. |
| 1,000 entries per discovery directory | Existing source-directory bound; overfull results fail. |
| YAML depth 32 / 4,096 nodes | Invalid inspection result when bounded-node traversal exceeds either limit. |
| 50 jobs / 50 event names | Explicit limit diagnostics; no implied complete graph beyond the bound. |
| 32 diagnostics per configuration | A final limit notice reports omitted additional findings; state never becomes accepted because diagnostics were capped. |

The maintained `go.yaml.in/yaml/v3` parser is pinned to v3.0.5, already used by Golf's tooling. Golf decodes a size-bounded document to `yaml.Node`, preserving locations; it never decodes aliases into expanded application values. A bounded traversal rejects aliases/anchors, explicit tags, merge keys, duplicate/non-string mapping keys and unsupported controls. Multiple documents and malformed/invalid UTF-8 fail inspection. Depth/node limits are checked on the parsed tree, not advertised as a streaming parser limit. No YAML scalar invokes a constructor, shell, expression evaluator or network resolver. [Parser API and compatibility](https://pkg.go.dev/go.yaml.in/yaml/v3@v3.0.5).

## Versioned static subset

`VALIDATED_SUBSET` means **“Inspection subset checked.”** It does not mean “valid on every provider,” “engine supported,” “safe script,” or “ready to run.” `UNSUPPORTED` reports valid or potentially valid provider constructs Golf does not interpret. `INVALID` reports malformed text/structure or an inspection safety bound. The diagnostic identifies the applicable limitation. Unknown fields never silently disappear into a successful subset result.

| Format | Inspected shape | Outside the subset |
| --- | --- | --- |
| GitHub Actions | Optional literal name; input-free `workflow_dispatch` as a scalar or mapping; exactly one job with a literal `runs-on` label; ordered nonempty shell steps with optional name and `sh`/`bash`, each containing `run`. | Other events/filters/inputs, expressions, actions/reusable workflows, permissions, environment/variables/secrets, conditions, defaults, dependencies/matrices, services, artifacts/caches and all other fields. A runner label does not identify an installed or equivalent hosted image. |
| GitLab CI | Optional one-stage list; exactly one visible job; optional matching stage (default `test`); literal image reference with lowercase SHA-256 digest; nonempty script string or flat string list. | Global defaults/variables, includes/templates/components, hidden jobs/inheritance, rules, services, artifacts/caches, dependencies/parallel graphs, downstream triggers and other job fields. A digest-shaped reference is not a pulled, trusted or approved image. |

GitLab and Actions are not normalized into one pretend execution semantics. In particular, no event matching, variable precedence, expression coercion, manual-gate handling, failure propagation or scheduling is performed. Shell script text remains untrusted even if its YAML shape is inspected. Source contracts: [GitHub workflow syntax](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax), [GitLab CI syntax](https://docs.gitlab.com/ci/yaml/), [GitLab YAML reuse](https://docs.gitlab.com/ci/yaml/yaml_optimization/).

## Qualification

Run `go test -race ./internal/server -run '^TestWorkflow' -count=1` with an isolated `GOLF_TEST_DATABASE_URL` for real PostgreSQL authorization tests. Parser fixtures cover safe/unsupported/invalid shapes, duplicate keys, aliases/cycles/tags, raw and decoded controls, depth/nodes and bounded diagnostics. Controlled-provider tests cover commit pinning, blob corruption, metadata-first limits, missing/symlink locations, native scopes and withholding output after authority/repository changes during a source read. Without the DSN, database-backed tests explicitly skip.

`python3 scripts/workflow-config-smoke.py` uses the running local Compose stack, requires pinned Gitea 1.27.3 with native Actions disabled, and creates only disposable ordinary users/private repository content. It exercises real Git-pushed configurations, exact object IDs, old-commit inspection after branch advancement, unsupported/invalid source, access/scope/revocation, Origin/delegation denial and count/aggregate bounds. It removes native fixture resources and sessions; immutable Golf identity/operation/audit history follows existing retention behavior. It does not start/restart services, execute workflows or mutate retained administrator accounts. Terminal results and the exact qualified image belong in the [implementation ledger](IMPLEMENTATION_STATUS.md); a script's presence is not a passing run.

## Critical path to the first real CI job

This inspection is an initial source-integration slice of [plan §7](../GOLF_IMPLEMENTATION_PLAN.md#7-actions-and-gitlab-pipeline-compatibility), not completion of the parser/compiler or engine contract. Next deliver a single explicitly authorized manual job against an exact commit:

1. Persist disabled-by-default repository/workflow eligibility, immutable repository selection and effective policy revision. Bind actor, source/configuration objects and selected engine/image to admission; deny before assignment or credentials when policy fails. Imported schedules remain inactive.
2. Persist run/job/attempt state, leases and fencing epochs; define duplicate dispatch, restart, cancellation and unknown-result recovery. Only the authorized current attempt can publish a result. Add per-attempt least-privilege source credentials and an isolated workspace/network/resource budget.
3. For Actions, pin a maintained `act` component and qualify the declared one-job shell subset with a truthful Linux environment; no hosted-image equivalence or `actions/checkout` claim. For GitLab, pin GitLab Runner and implement/qualify its actual coordinator authentication, job request, trace and status exchanges with the maintained Docker executor. A generic Docker shell process is not GitLab Runner compatibility. [act source](https://github.com/nektos/act), [GitLab Docker executor](https://docs.gitlab.com/runner/executors/docker/).
4. Prove success/nonzero exit, bounded logs, timeout/cancel, worker death, lost status acknowledgment, restart recovery, stale attempt rejection and cleanup on actual isolated Docker jobs. Untrusted jobs receive no host Docker socket, privileged host mounts or production credentials. Prove cross-job filesystem/credential isolation before shared runner pools.
5. Add Kubernetes assignment/isolation and scalable pools only after that portable slice is qualified; Cloudflare execution requires its own adapter/resource/network proof. Expand actions, includes, caches/artifacts, secrets/OIDC and reusable graphs one catalog entry at a time with conformance fixtures.

Those proofs must precede any enabled pipeline capability, required-check producer claim or execution setting. GitLab Custom executor is maintenance-only and remains a conditional adapter investigation, not an assumed Cloudflare engine. The [public repository qualification](PUBLIC_REPOSITORY_QUALIFICATION.md) records the related import and runner prerequisites. No CI workflow is added to Golf's own repository by this increment.
