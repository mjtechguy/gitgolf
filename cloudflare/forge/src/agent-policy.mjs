import { sha, validRef } from './git.mjs';
import { uuidOK } from './common.mjs';
import { testPolicy, testModuleOK } from './test-policy.mjs';
import { filePolicy, model } from '../../agents/src/policy.mjs';

export const agentTerminal = new Set(['succeeded', 'failed', 'cancelled', 'timed_out', 'lost']);
export const agentPathOK = path => typeof path === 'string' && path.length <= 200 &&
  path.split('/').every(p => /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(p) && !p.includes('..'));
export function agentPolicy(env) {
  return Boolean(testPolicy(env) && env.AGENT_EXECUTION_ENABLED === 'true' && agentPathOK(env.AGENT_PATH) &&
    /^[a-f0-9]{64}$/.test(env.AGENT_POLICY_SHA256 || '') && env.agentTasks && env.AI && env.EVIDENCE_GATEWAY && env.EVIDENCE_ALLOW_AI === 'true');
}
export function agentInputOK(input) {
  return input && testModuleOK(input.module) && uuidOK(input.jobId) && sha(input.commitId) && sha(input.treeId) && validRef('refs/heads/' + input.branch) &&
    agentPathOK(input.allowedPath) && /^[a-f0-9]{64}$/.test(input.policySha256 || '') &&
    typeof input.prompt === 'string' && input.prompt.trim() && new TextEncoder().encode(input.prompt).length <= 16384 &&
    Number.isSafeInteger(input.deadline) && input.deadline > Date.now() && input.deadline <= Date.now() + 600000 &&
    /^https:\/\/[a-f0-9]{32}\.artifacts\.cloudflare\.net\/git\/[a-z0-9][a-z0-9-]{1,62}\/repo-[a-f0-9]{32}\.git$/.test(input.remote);
}
export function agentResult(value, jobId, source) {
  if (!value || value.role !== jobId || value.base_commit !== source.commitId || value.base_tree !== source.treeId ||
      value.allowed_path !== source.allowedPath || value.policy_sha256 !== source.policySha256 || !agentTerminal.has(value.state) ||
      value.cleanup !== 'destroyed' || !Number.isSafeInteger(value.finished_at) ||
      !Number.isSafeInteger(value.calls) || value.calls < 0 || value.calls > 16 ||
      !Number.isSafeInteger(value.denied) || value.denied < 0 || value.denied > 1000000) throw Error('Invalid native agent result');
  const result = { jobId, state: value.state, commitId: source.commitId, treeId: source.treeId,
    allowedPath: source.allowedPath, policySha256: source.policySha256, cleanup: value.cleanup,
    finishedAt: value.finished_at, calls: value.calls, deniedRequests: value.denied,
    harness: 'opencode@1.18.34', model, proposalOnly: true };
  if (value.state === 'succeeded') {
    if (!sha(value.proposal_commit) || !sha(value.proposal_tree) || value.proposal_commit === source.commitId ||
        typeof value.patch !== 'string' || !value.patch || !Array.isArray(value.events) ||
        !Number.isSafeInteger(value.tokens) || value.tokens < 1 || value.tokens > 200000 || value.calls < 1 ||
        !Number.isInteger(value.tests?.full?.exit_code) || value.tests.full.exit_code < 0 || value.tests.full.exit_code > 255 ||
        ['stdout', 'stderr'].some(k => typeof value.tests.full[k] !== 'string')) throw Error('Incomplete native agent proposal');
    if (![value.started_at, value.first_inference_at, value.agent_completed_at].every(Number.isSafeInteger) || value.started_at > value.first_inference_at || value.first_inference_at > value.agent_completed_at || value.agent_completed_at > value.finished_at) throw Error('Invalid native agent execution interval');
    Object.assign(result, { startedAt: value.started_at, firstInferenceAt: value.first_inference_at, completedAt: value.agent_completed_at, proposalCommitId: value.proposal_commit, proposalTreeId: value.proposal_tree,
      patch: value.patch, events: value.events, tokens: value.tokens,
      tests: { exitCode: value.tests.full.exit_code, stdout: value.tests.full.stdout, stderr: value.tests.full.stderr } });
  }
  if (value.state === 'lost') {
    result.failureStage = String(value.terminal_from || 'unknown').slice(0, 64);
    if (typeof value.failure === 'string') result.diagnostic = value.failure.slice(0, 512);
  }
  if (value.publication === 'unknown') result.publication = 'UNKNOWN';
  if (new TextEncoder().encode(JSON.stringify(result)).length > 96 * 1024) throw Error('Agent result exceeds its limit');
  return result;
}
export { filePolicy };
