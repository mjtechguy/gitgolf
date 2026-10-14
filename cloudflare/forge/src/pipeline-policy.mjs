// Operator allocation for Actions/CI pipelines (docs/NATIVE_ACTIONS_PIPELINES.md). No import cycle: feature-policy reads this.
export const pipelinePolicy = env => env?.PIPELINES_ENABLED === 'true' && Boolean(env.PIPELINE_BUCKET);
// Where `uses: owner/action@ref` resolves for the stock Forgejo Runner; GitHub-compatible by default.
export const defaultActionsURL = env => /^https:\/\/[a-z0-9.-]+(?::\d+)?$/.test(env?.ACTIONS_DEFAULT_URL || '') ? env.ACTIONS_DEFAULT_URL : 'https://github.com';
// Honest capability states: READY only with the allocation (R2 bucket + enable flag) and the run coordinator bound.
export function pipelineCapabilities(env) {
  const ready = pipelinePolicy(env) && Boolean(env.pipelineCoordinator), state = ready ? 'CAPABILITY_STATE_READY' : 'CAPABILITY_STATE_DISABLED';
  const missing = 'Actions pipelines need the operator allocation: an R2 bucket for logs and artifacts and the PipelineRun coordinator (forge.json pipelines).';
  return [
    { id: 'actions.pipelines', label: 'Actions workflows and pipelines', state, reason: ready ? 'Workflows from .github/workflows and .forgejo/workflows run on push, same-repository pull requests (opened, synchronize, reopened) and workflow_dispatch, on runners you register. Matrix, needs, services, concurrency groups, re-run and cancel; reusable workflows, schedules and fork pull requests are refused with a reason.' : missing },
    { id: 'actions.forgejo-runner', label: 'Stock Forgejo Runner', state, reason: ready ? `Unmodified forgejo-runner ${forgejoRunnerVersion} over its connect-rpc protocol; uses: actions resolve from ${defaultActionsURL(env)}. Secrets reach same-repository runs only and are redacted from stored logs.` : missing },
    { id: 'actions.artifacts', label: 'Workflow artifacts', state, reason: ready ? 'Artifacts v4 (the Twirp ArtifactService) stored in R2 for 30 days. The unmodified actions/upload-artifact@v4 refuses non-GitHub servers (its GHES check); use code.forgejo.org/forgejo/upload-artifact@v4 and download-artifact@v4, as on Forgejo. Cache is the runner’s own cache server.' : missing },
    { id: 'actions.environments', label: 'Deployment environments', state, reason: ready ? 'jobs.<id>.environment with required reviewers, branch rules, environment-scoped secrets released after approval, and deployment history.' : missing },
    { id: 'settings.pipeline-runners', label: 'Self-hosted runners', state, reason: ready ? 'Registration tokens, labels, disable and delete at installation and repository scope (organization scope through the API).' : missing },
  ];
}
export const forgejoRunnerVersion = 'v13.2.0';
export const forgejoRunnerSha256 = 'fadaec897f5e6641c363f87ecaf75f866f99c81b7097ec6b433e4c48123fcad1';
