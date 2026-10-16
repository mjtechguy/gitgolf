// Agent branches (docs/AGENTIC_MODE.md "Agent branches"): coding agent task branches (golf-agent/…) and branches matching the write branch
// pattern of an API token scoped to the repository. The Worker names the patterns (POST /native/agent-inbox/read action branches); this
// matches them as the Worker does (agent-branches.mjs): exact, or a prefix ending in *; '*' alone and the default branch never match.
export const agentTaskPattern = 'golf-agent/*';
export const patternMatches = (pattern: string, name: string) => pattern !== '' && pattern !== '*' && (pattern.endsWith('*') ? name.startsWith(pattern.slice(0, -1)) : name === pattern);
export const isAgentBranch = (patterns: readonly string[], name: string, defaultBranch: string) => name !== defaultBranch && patterns.some(pattern => patternMatches(pattern, name));
