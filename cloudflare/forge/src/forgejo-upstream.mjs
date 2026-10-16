// Names the stock Forgejo Runner still reads under its predecessor's prefix.
// They are Forgejo's upstream names, so they must be sent exactly as spelled.
export const RUNNER_LEGACY_CONTEXT = Object.freeze({
  defaultActionsUrl: 'gitea_default_actions_url', // Forgejo's upstream name
  runtimeToken: 'gitea_runtime_token', // Forgejo's upstream name
});
// Job token secret the runner exposes alongside GITHUB_TOKEN/FORGEJO_TOKEN.
export const RUNNER_LEGACY_TOKEN_SECRET = 'GITEA_TOKEN'; // Forgejo's upstream name
// The runner sets environment variables with this prefix; user values may not shadow them.
export const RUNNER_LEGACY_ENV_PREFIX = 'GITEA_'; // Forgejo's upstream name
