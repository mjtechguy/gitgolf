// Agent branches (docs/AGENTIC_MODE.md "Agent branches", docs/AGENTIC_MODE_PLAN.md AM-5 item 3). An agent branch is a coding agent task's
// proposal branch (golf-agent/…) or a branch matching the write branch pattern of an API token scoped to the repository (for example
// agent/*). The branch list hides them by default; while agentic mode is on, Golf deletes the head branch of a pull request that landed,
// merged or closed, through the branch fence (ref-writes.mjs) like any branch delete, never by writing refs directly. It deletes only:
// an agent branch that is not the default branch and no branch rule covers; whose head is still the pull request's head; that no open pull
// request uses as head or base and no unfinished agent task writes to. Each deletion is audited; each skip is logged with its reason.
import { Fault } from './common.mjs';
import { sha } from './git.mjs';
import { agenticSchema, agenticSettings, agenticFeature } from './agentic-mode.mjs';
import { contextFor } from './land-queue.mjs';
import { inventory } from './collaboration.mjs';
import { enforceGitRules } from './repository-rules.mjs';
import { deleteBranchAt } from './source-api.mjs';
import { ownerSlug } from './owners.mjs';

export const agentTaskPattern = 'golf-agent/*';
export const branchLimits = Object.freeze({ patterns: 50, attempts: 3 });
const now = () => new Date().toISOString();

// Whether a branch name matches one pattern: exact, or a prefix ending in * (token-scope.mjs). '*' alone matches every branch, so it never
// marks agent branches (agentBranchPatterns leaves it out).
export const patternMatches = (pattern, name) => typeof pattern === 'string' && pattern !== '' && pattern !== '*' && (pattern.endsWith('*') ? name.startsWith(pattern.slice(0, -1)) : name === pattern);
export const isAgentBranch = (patterns, name, defaultBranch) => typeof name === 'string' && name !== defaultBranch && patterns.some(pattern => patternMatches(pattern, name));

// golf-agent/* and the distinct branch patterns of write API tokens whose scope includes this repository and whose owner holds a grant here
// (revoked and expired tokens too: the branches they pushed stay agent branches). At most `patterns`, sorted.
export async function agentBranchPatterns(db, row) {
  let tokens = [];
  try {
    tokens = (await db.prepare(`SELECT DISTINCT t.branch_pattern AS pattern FROM api_tokens t JOIN grants g ON g.user_id=t.user_id AND g.repository_id=?
      WHERE t.permission='write' AND t.branch_pattern<>'' AND t.branch_pattern<>'*' AND (t.repositories IS NULL OR EXISTS(SELECT 1 FROM json_each(t.repositories) WHERE value=?))
      ORDER BY t.branch_pattern LIMIT ?`).bind(row.id, String(row.id), branchLimits.patterns).all()).results.map(token => token.pattern);
  } catch { tokens = []; }
  return [agentTaskPattern, ...tokens.filter(pattern => pattern !== agentTaskPattern)];
}

// The guard evaluated with the delete's reservation: the administrator whose saved agentic mode setting authorizes Golf's own writes still
// holds write or admin, at the same identity, setting and rules versions, and still no open pull request or unfinished agent task uses the branch.
function cleanupGuard(principal, row, { version, rulesVersion, branch }) {
  return { sql: `EXISTS(SELECT 1 FROM repositories r JOIN grants g ON g.repository_id=r.id JOIN users u ON u.id=g.user_id JOIN repository_agentic_settings s ON s.repository_id=r.id
      LEFT JOIN native_identity_versions v ON v.user_id=u.id
      WHERE r.id=? AND r.artifact_name=? AND r.state='ACTIVE' AND g.user_id=? AND g.role IN ('write','admin') AND u.active=1 AND COALESCE(v.version,0)=?
      AND s.enabled=1 AND s.updated_by=u.id AND s.version=? AND COALESCE((SELECT version FROM repository_rules WHERE repository_id=r.id),0)=?
      AND NOT EXISTS(SELECT 1 FROM discussions d JOIN pull_requests p ON p.discussion_id=d.id WHERE d.repository_id=r.id AND d.kind='pull' AND d.state='OPEN' AND (p.head_branch=? OR p.base_branch=?))
      AND NOT EXISTS(SELECT 1 FROM agent_tasks t WHERE t.repository_id=r.id AND t.branch=? AND t.state IN ('QUEUED','CLAIMED','RUNNING')))`,
    values: [row.id, row.artifact_name, principal.id, principal.identity_version || 0, version, rulesVersion, branch, branch, branch] };
}

const skip = (detail, reason) => { console.log(JSON.stringify({ event: 'golf.agent_branch_kept', ...detail, reason })); return { deleted: false, reason }; };

// Deletes the head branch of a pull request that is no longer open, when it is an agent branch still at headCommitId. why: 'landed',
// 'merged' or 'closed'. Returns { deleted, reason }; never throws for an expected refusal.
export async function cleanUpAgentBranch(env, { repositoryId, pullRequestId, headCommitId, why }, { withArtifact, providerFetch = env.providerFetch || fetch, pause } = {}) {
  const db = env.DB.withSession('first-primary'), detail = { repositoryId: String(repositoryId), pullRequestId: String(pullRequestId), why };
  if (!sha(headCommitId)) return skip(detail, 'no head commit was observed');
  if (!await agenticSchema(db)) return skip(detail, 'agentic mode is not migrated');
  const stored = await db.prepare('SELECT updated_by FROM repository_agentic_settings WHERE repository_id=? AND enabled=1').bind(repositoryId).first();
  if (!stored) return { deleted: false, reason: 'agentic mode is off for this repository' };
  const context = await contextFor(db, env, repositoryId, stored.updated_by);
  if (!context || !['write', 'admin'].includes(context.row.role)) return skip(detail, 'the administrator who saved agentic mode no longer has write access');
  const { row, person: principal } = context;
  const [settings, feature] = await Promise.all([agenticSettings(db, row), agenticFeature(db, env, row)]);
  if (!settings.enabled || !feature.allowed) return { deleted: false, reason: 'agentic mode is off for this repository' };
  const pull = await db.prepare(`SELECT d.number,d.state,p.head_branch,p.base_branch FROM pull_requests p JOIN discussions d ON d.id=p.discussion_id WHERE p.id=? AND d.repository_id=? AND d.kind='pull'`)
    .bind(pullRequestId, repositoryId).first();
  if (!pull) return skip(detail, 'the pull request was not found');
  const branch = pull.head_branch, ref = 'refs/heads/' + branch;
  Object.assign(detail, { number: pull.number, branch });
  if (pull.state === 'OPEN') return skip(detail, 'the pull request is open');
  if (!isAgentBranch(await agentBranchPatterns(db, row), branch, row.default_branch)) return { deleted: false, reason: 'not an agent branch' };
  if (branch === pull.base_branch) return skip(detail, 'the head branch is the base branch');
  if (await db.prepare(`SELECT 1 FROM discussions d JOIN pull_requests p ON p.discussion_id=d.id WHERE d.repository_id=? AND d.kind='pull' AND d.state='OPEN' AND (p.head_branch=? OR p.base_branch=?) LIMIT 1`)
    .bind(repositoryId, branch, branch).first()) return skip(detail, 'another open pull request uses the branch');
  if (await db.prepare("SELECT 1 FROM agent_tasks WHERE repository_id=? AND branch=? AND state IN ('QUEUED','CLAIMED','RUNNING') LIMIT 1").bind(repositoryId, branch).first())
    return skip(detail, 'an unfinished agent task writes to the branch');
  let rulesVersion;
  try { rulesVersion = await enforceGitRules(db, row, principal, ref); }
  catch (error) { if (error instanceof Fault) return skip(detail, 'a branch rule covers the branch'); throw error; }
  const guard = cleanupGuard(principal, row, { version: settings.version, rulesVersion, branch });
  let outcome;
  try {
    outcome = await withArtifact(env, row, async repo => {
      for (let attempt = 1; ; attempt++) {
        const current = (await inventory(env, row, repo, providerFetch)).get(ref);
        if (!current) return { reason: 'the branch no longer exists' };
        if (current !== headCommitId) return { reason: `the branch moved to ${current.slice(0, 12)} after the pull request ${why === 'closed' ? 'was closed' : why}` };
        const sent = await deleteBranchAt(db, env, principal, row, repo, { ref, head: headCommitId, guard }, { withArtifact, providerFetch, ciState: 'NONE' });
        if (sent.outcome === 'applied') return { id: sent.id };
        if (sent.outcome === 'guard_refused') return { reason: 'the branch came into use, or agentic mode or its administrator\'s access changed' };
        if (attempt >= branchLimits.attempts) return { reason: sent.outcome === 'busy' ? 'the repository stayed busy with other writes' : 'Git storage refused the delete' };
        // Busy: wait for the branch's turn. Refused: read the branch again (it may have moved).
        if (sent.outcome === 'busy') await (pause ? pause(attempt) : new Promise(resolve => setTimeout(resolve, 250 * 2 ** attempt)));
      }
    });
  } catch (error) {
    if (!(error instanceof Fault)) throw error;
    return skip(detail, error.status === 503 ? 'the delete was sent but not confirmed; maintenance reads the branch back' : error.message);
  }
  if (!outcome.id) return skip(detail, outcome.reason);
  try {
    await db.prepare(`INSERT OR IGNORE INTO installation_audit(at,actor_id,actor_email,scope,scope_id,subject,action,before,after,widening,operation_id,client)
      VALUES(?,0,'','repository',?,?,'agentic_mode.branch_delete',NULL,?,0,?,?)`).bind(now(), String(row.id), branch,
      JSON.stringify({ branch, number: pull.number, why, headCommitId, principal: principal.login }), `audit:agentic_mode.branch_delete:0:${outcome.id}`,
      JSON.stringify({ via: 'agentic-mode', outcome: 'success', repository: `${ownerSlug(row, env)}/${row.name}`, route: 'agentic-mode' })).run();
  } catch { console.log(JSON.stringify({ event: 'golf.audit_write_failed', action: 'agentic_mode.branch_delete' })); }
  console.log(JSON.stringify({ event: 'golf.agent_branch_deleted', ...detail, operation: outcome.id }));
  env.notifyLanding?.(row.id);
  return { deleted: true, reason: '', operationId: outcome.id };
}

// After the response where the runtime offers it (env.waitUntil), else inline; a failure is logged, never thrown into the caller's write.
export function cleanUpAgentBranchSoon(env, target, options) {
  const work = cleanUpAgentBranch(env, target, options).catch(error => {
    console.log(JSON.stringify({ event: 'golf.agent_branch_cleanup_failed', message: String(error?.message || error).slice(0, 160) }));
    return { deleted: false, reason: 'cleanup failed' };
  });
  if (typeof env.waitUntil === 'function') { env.waitUntil(work); return Promise.resolve({ deleted: false, reason: 'scheduled' }); }
  return work;
}
