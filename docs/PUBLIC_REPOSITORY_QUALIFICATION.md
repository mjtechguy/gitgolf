# Public repository source-transfer qualification

Golf has passed a bounded, local source-transfer drill using real public GitHub and GitLab repositories. This does **not** implement a product import screen/API, provider connection, collaboration migration or CI engine. Pipeline execution remains disabled; imported workflow files are untrusted source text and were never executed.

## Runnable evidence

Run from the product root with Docker Compose, Git, Python 3 and a built Golf CLI. Public HTTPS access to the two fixed sources is required. The chosen Golf image must already exist locally; this script never builds or replaces the normal installation.

```sh
python3 scripts/public-repositories-smoke.py \
  --image sha256:011744dfa94cfabbfd978218afdc26585df4906448829854b14f2f12440a485e \
  --cli bin/golf
```

**2026-10-02: native drill passed** against that immutable local image in an earlier native qualification on a since-retired backend; it has not been repeated on Forgejo 15.0.9. The script emits public commit/file checksums and stage results, not credentials or source bodies. Each run creates a separate Compose project, fresh databases, random loopback ports and ordinary users; `finally` removes its containers, volumes, network and private temporary files and verifies resource absence. The normal local administrator and installation are untouched. No external repository, issue, hook, runner or pipeline is written.

| Public fixture | Immutable source commit | Qualified scope |
| --- | --- | --- |
| [GitHub Actions JavaScript example](https://github.com/actions/hello-world-javascript-action/tree/79ac0da13ee392da3fdd151813d5ce4658cb7e27) | `79ac0da13ee392da3fdd151813d5ce4658cb7e27` | 391 reachable commits, 6 Actions workflow files, README and license. |
| [GitLab Node.js example](https://gitlab.com/gitlab-examples/nodejs/-/tree/892a1f16725e56cc3a2cb0d677be42935c8fc262) | `892a1f16725e56cc3a2cb0d677be42935c8fc262` | 36 reachable commits, `.gitlab-ci.yml`, README and license. |

The local drill verifies:

1. Fetch each fixed commit into a bare repository with no checkout, client hooks, dependency installation, submodule recursion or LFS smudge. Reject redirects; ignore system/global Git configuration and credential helpers. Validate Git objects with `fsck` and bound the fixed fixture footprint.
2. Create private destination repositories through Golf's durable `CreateRepository` RPC using ordinary scoped credentials. Push through native Git HTTPS with credentials limited to the isolated destination origin. No native forge database/repository-file mutation occurs.
3. Confirm exactly two qualification refs: destination `main` and the locally created lightweight `qualification-source` tag both point to the source commit. GitLab's selected `master` is deliberately mapped to destination `main`. These are **selected-ref copies**, not all-branch/all-tag mirrors or imported upstream tag/signature verification.
4. Read the complete selected history through Golf's paginated commit API and compare every SHA with local Git. Read all detected workflow files, README and license at the exact commit; compare plain-text bytes and blob IDs. Workflow inventory reports byte counts and SHA256, not semantic validation.
5. Read the selected workflow through the real Golf CLI with a token supplied on stdin. Verify typed JSON and that its temporary sign-in leaves no additional active session. An unrelated account receives 404 for both destination repository and workflow reads.
6. Confirm the deployed topology contains only Golf/native forge/PostgreSQL, native Actions is configured off and Golf reports pipeline execution disabled. No runner is registered or launched.

The two repositories are examples, not a complete migration corpus. This proof omits private-source authentication, every upstream ref, LFS payloads, submodule repositories, issues/PRs/MRs, attachments, teams, policies, secrets, webhooks, cutover, resumability, source renames/deletions, large repositories and provider throttling. Upstream removal of a pinned object causes a visible failure; the script never silently advances its pin.

## Supported interfaces and the product-import boundary

Public Git transport provides the selected history and object identity used above. Provider metadata discovery is separate: GitHub's repository API exposes repository identity, default branch and clone URLs, including public reads without credentials; GitLab's Projects API supplies equivalent project discovery. Those endpoints do not copy repositories into Golf. See [GitHub repositories API](https://docs.github.com/en/rest/repos/repos#get-a-repository) and [GitLab Projects API](https://docs.gitlab.com/api/projects/).

Forgejo has a supported `POST /repos/migrate` endpoint. Its implementation accepts clone/source-service options and selected metadata, checks destination ownership and migration-URL policy, and uses a background context that continues after the caller disconnects. Mirror mode suppresses collaboration-data options. This makes a lost response a potentially completed migration, not permission to retry or adopt a similarly named repository. These implementation notes were characterized on the since-retired backend; Forgejo inherits this handler but it has not been re-qualified. The drill above does not call or qualify that endpoint. See the [Forgejo 15.0.9 migration handler source](https://codeberg.org/forgejo/forgejo/src/tag/v15.0.9/routers/api/v1/repo/migrate.go) and the pinned [API reference](compatibility/forgejo-15.0.9.swagger.json).

Before exposing public import in Golf, implement and prove:

- Exact source/destination identity and caller authorization; explicit source-ref mapping, bounded Git/object quotas and staged destination state.
- HTTPS host admission, redirect and DNS-rebinding handling, blocked private/link-local/metadata endpoints and local/file/ext protocols; isolated egress credentials. Fixed URLs in this qualification script are not a reusable SSRF defense.
- A durable request record, cancellation/outcome semantics and recovery after provider response loss. Do not recreate a destination or infer success from its name.
- An execution-disabled destination before importing source, with a separately approved exact-commit activation path. Schedules, webhooks, writable tokens and deploy credentials must not become active because files were copied.
- A fidelity report for omitted history/metadata/attachments/LFS/policies and a protected cutover gate. Source export formats are provider/version dependent; [GitLab project import/export](https://docs.gitlab.com/api/project_import_export/) is a separate contract to evaluate, not evidence of Git-only fidelity.

These preserve [plan §5](../GOLF_IMPLEMENTATION_PLAN.md#5-githubgitlab-connections-and-direct-import). A simple public-source UI may expose a narrower contract, but must label its exclusions before the user starts.

## CI engine bootstrap: exact first proposed subset

**No following execution capability is implemented or qualified by this drill.** File presence and successful YAML parsing cannot demonstrate correct jobs, credentials, isolation or results. [GitHub workflow syntax](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax) and [GitLab CI syntax](https://docs.gitlab.com/ci/yaml/) define different semantics.

Use a small explicitly authored conformance fixture before trying the imported examples. A proposed first shared-core execution slice is manual dispatch of an immutable Golf commit, one Linux job in an approved digest-pinned container, bounded shell steps, fixed time/resource limits, streamed redacted logs, cancel/timeout/exit-state handling and cleanup. Golf provides an exact-commit workspace; this is not yet support for `actions/checkout`, hosted runner images or arbitrary tool installers. A strict preflight must reject unsupported syntax with a path/reason before assignment.

| Track | First compiler/engine proof | Required negative and lifecycle proof |
| --- | --- | --- |
| Actions syntax | One explicitly cataloged dispatch event, one job, ordered shell steps and truthful documented environment. Pin the selected `act` component/runner version; separately test any JavaScript/composite/container action added later. | Reject reusable workflows, remote actions, expressions, matrices, services, caches/artifacts, secrets and OIDC until each is qualified. Prove nonzero exit, cancellation and an expired/replayed assignment cannot report success. |
| GitLab syntax | One stage/job with a pinned image and shell script. A pinned GitLab Runner requires a compatible coordinator protocol, job authentication/assignment, trace and status exchange; launching a binary is insufficient. | Reject includes, `rules`, inheritance, services, caches/artifacts, child pipelines and job-token endpoints until qualified. Prove coordinator restart, runner death, timeout, lost status acknowledgment and cleanup. |
| Shared execution | Persist run/job/attempt state and bounded leases before scheduling. Use per-attempt fetch credentials, isolated workspaces and an explicit network policy. Bind results to exact source, configuration, attempt and execution image. | Prove cross-job/tenant secret and filesystem isolation, duplicate dispatch, stale-worker writes, resource exhaustion and crash recovery. No host Docker socket or privileged deployment credentials in untrusted jobs. |

Connected GitHub execution is a separate easier-to-constrain path: its self-hosted runner still registers with and receives work from GitHub. GitHub recommends ephemeral runners for autoscaling and defines communication/update requirements; this is not a standalone GitHub coordinator implementation. See [self-hosted runner reference](https://docs.github.com/en/actions/reference/runners/self-hosted-runners).

GitLab likewise requires a runner authentication token and coordinator URL plus a supported executor. Start the portable proof with Docker/Kubernetes executor capabilities as appropriate. The current Custom executor is in maintenance mode, so the plan's Cloudflare custom-executor approach needs an explicit lifecycle/support ADR and a concrete adapter proof before commitment. It is not an automatic route to Cloudflare execution. See [registration](https://docs.gitlab.com/runner/register/), [executors](https://docs.gitlab.com/runner/executors/) and [Custom executor status](https://docs.gitlab.com/runner/executors/custom/).

The pinned GitHub example additionally needs checkout/setup-node actions, local-action execution, outputs, package tooling and cache behavior; its six workflows include separate security/licensing requirements. The GitLab example references old Node 4.2.2/PostgreSQL 9.5.0 images, a service container and caches. Neither is an approved execution fixture; require maintained, digest-pinned fixtures and qualified policy before any run. Imported source remains unchanged for fidelity inspection.

Broader [plan §§7–8](../GOLF_IMPLEMENTATION_PLAN.md#7-actions-and-gitlab-pipeline-compatibility), protected-check producer identity, runner autoscaling, Cloudflare execution and deployment gates remain open. This report makes no CI compatibility percentage, production readiness or enterprise certification claim.
