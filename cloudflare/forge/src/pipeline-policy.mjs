// Operator allocation for Actions/CI pipelines (docs/NATIVE_ACTIONS_PIPELINES.md). No import cycle: feature-policy reads this.
export const pipelinePolicy = env => env?.PIPELINES_ENABLED === 'true' && Boolean(env.PIPELINE_BUCKET);
// Where `uses: owner/action@ref` resolves for the stock Forgejo Runner; GitHub-compatible by default.
export const defaultActionsURL = env => /^https:\/\/[a-z0-9.-]+(?::\d+)?$/.test(env?.ACTIONS_DEFAULT_URL || '') ? env.ACTIONS_DEFAULT_URL : 'https://github.com';
export const forgejoRunnerVersion = 'v13.2.0';
export const forgejoRunnerSha256 = 'fadaec897f5e6641c363f87ecaf75f866f99c81b7097ec6b433e4c48123fcad1';
