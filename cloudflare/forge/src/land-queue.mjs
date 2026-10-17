// Landing at agent speed (docs/AGENTIC_MODE.md, docs/AGENTIC_MODE_PLAN.md AM-4 items 4 and 5). "Land" is the native merge
// (pull-merge.mjs standardPullMerge: the same journal, plan, reservation and readback) onto the base tip current at that moment.
// There is no global merge lock: each land is its own journaled operation (land_operations), different pull requests land side by
// side, and only the base update is ordered. A merge still reserves its repository briefly (repositories.write_pending); a land that
// meets a moved base or a busy repository waits its turn and re-plans, within 45 s, with jittered backoff. Conflicting paths end in
// NEEDS_REBASE. After landing, the base push starts pipelines; when a required check fails on the landed commit, a policy landing is
// reverted with a server-side commit (source-api.mjs commitTree), the pull request gets a comment and an issue is opened for the
// original requester. People land through POST /native/land; the policy lands from pipeline completions and the maintenance sweep.
import { Fault, deny, invalid, uuidOK, digest } from './common.mjs';
import { ownerSlug, ownerColumns, ownerJoin } from './owners.mjs';
import { featureColumns, featureOff } from './feature-policy.mjs';
import { sha } from './git.mjs';
import { inventory, pullReviewContext, collaboration } from './collaboration.mjs';
import { standardPullMerge, unknownMergeWrite } from './pull-merge.mjs';
import { commitTree, authority as writeAuthority, identity } from './source-api.mjs';
import { enforceGitRules } from './repository-rules.mjs';
import { mergeTrees } from './tree-merge.mjs';
import { GitTreeError } from './git-objects.mjs';
import { agenticSchema, agenticSettings, agenticFeature, landingEvaluation, headChecks } from './agentic-mode.mjs';
import { onlyApprovalNeeded, requiredCheckStates } from './land-policy.mjs';
import { recordPipelineIntake, dispatchPipelineIntake } from './actions-intake.mjs';
import { pipelinePolicy } from './pipeline-policy.mjs';
import { cleanUpAgentBranchSoon } from './agent-branches.mjs';

// Commits Golf writes on its own (policy merges and reverts) carry this identity, never a person's.
export const agenticIdentity = Object.freeze({ name: 'Golf (agentic mode)', email: 'agentic@golf.invalid' });
// Merges into one repository take turns (each holds it briefly), so a land waits for its turn within a time budget, not a few tries.
export const landLimits = Object.freeze({ attempts: 60, budgetMs: 45_000, list: 100, sweep: 20, revertAttempts: 3 });
const refuse = message => { throw new Fault('failed_precondition', 412, message); };
const forbidden = message => { throw new Fault('permission_denied', 403, message); };
const now = () => new Date().toISOString();
const parse = text => { try { const value = JSON.parse(text); return value && typeof value === 'object' && !Array.isArray(value) ? value : {}; } catch { return {}; } };
const busyMessage = 'An unresolved operation fences further changes.';
const phase = name => 'STANDARD_PULL_MERGE_PHASE_' + name;
// A request key derived from the land operation, so a replayed comment, issue or assignment is the same collaboration operation.
const keyFor = async text => { const h = await digest(text); return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`; };
// Jittered backoff between attempts: 200 ms first, doubling to at most 2 s, each wait between half and all of its cap (never under 200 ms).
export const backoff = (attempt, random = Math.random) => { const cap = Math.min(2000, 200 * 2 ** (attempt - 1)); return Math.max(200, Math.round(cap / 2 + random() * cap / 2)); };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const refusals = { target_locked: 'the base branch is locked by a branch rule', pull_request_draft: 'the pull request is a draft', pull_request_not_open: 'the pull request is not open',
  nothing_to_merge: 'the base branch already contains the head', ancestry_unproven: 'the history of the two branches could not be read', branch_unavailable: 'the base or head branch no longer exists',
  fork_source_unsupported: 'pull requests from forks cannot land natively', provider_refused: 'Git storage refused the merge with the base unchanged' };

// Schema 42: the land_operations table. Only a positive answer is remembered.
let migrated = false;
export async function landSchema(db) {
  if (!migrated) { try { migrated = Boolean((await db.prepare('PRAGMA table_info(land_operations)').all()).results.length); } catch { migrated = false; } }
  return migrated;
}

export function wireLand(op) {
  return { id: op.id, repositoryId: String(op.repository_id), pullRequestId: String(op.pull_request_id), number: op.number, trigger: op.trigger, actorId: String(op.actor_id),
    actor: op.trigger === 'policy' ? '' : op.actor_login || '', state: op.state, method: op.method, headCommitId: op.head_commit_id, baseCommitId: op.base_commit_id,
    landedCommitId: op.landed_commit_id, revertCommitId: op.revert_commit_id, attempts: op.attempts, detail: parse(op.detail), createdAt: op.created_at, updatedAt: op.updated_at };
}
const select = 'SELECT l.*,u.login AS actor_login FROM land_operations l LEFT JOIN users u ON u.id=l.actor_id AND l.actor_id>0';
const reread = (db, id) => db.prepare(`${select} WHERE l.id=?`).bind(id).first();
// Merges the given keys into detail (a JSON object). Transitions name the states they leave, so a late writer changes nothing.
async function transition(db, op, state, detail = {}, extra = {}, from = ['QUEUED', 'LANDING']) {
  const columns = Object.keys(extra), time = now();
  await db.prepare(`UPDATE land_operations SET state=?,detail=json_patch(detail,?),updated_at=?${columns.map(column => `,${column}=?`).join('')} WHERE id=? AND state IN (${from.map(() => '?').join(',')})`)
    .bind(state, JSON.stringify(detail), time, ...columns.map(column => extra[column]), op.id, ...from).run();
  return reread(db, op.id);
}
async function create(db, row, d, { trigger, actorId, method, headCommitId, detail, idempotencyKey = null }) {
  const id = crypto.randomUUID(), time = now();
  try {
    await db.prepare(`INSERT INTO land_operations(id,repository_id,pull_request_id,number,trigger,actor_id,state,method,head_commit_id,detail,idempotency_key,created_at,updated_at)
      VALUES(?,?,?,?,?,?,'QUEUED',?,?,?,?,?,?)`).bind(id, row.id, d.pull_id, d.number, trigger, actorId, method, headCommitId, JSON.stringify(detail || {}), idempotencyKey, time, time).run();
  } catch (error) { if (/UNIQUE constraint failed/.test(String(error?.message))) return null; throw error; }
  return reread(db, id);
}

// ---------- the policy's authority ----------
// The administrator whose saved agentic mode setting authorizes Golf's own writes is the accountable account in the journals
// (pull_merge_operations.actor_id, git_operations.user_id) and the author of Golf's comments and issues; commits carry agenticIdentity.
// The guard is evaluated with each reservation: the account still holds write or admin, the setting is still the one evaluated (version)
// and still allows this kind of write.
function policyGuard(principal, row, { version, kind, rulesVersion }) {
  return idle => ({ sql: `EXISTS(SELECT 1 FROM repositories r JOIN grants g ON g.repository_id=r.id JOIN users u ON u.id=g.user_id JOIN repository_agentic_settings s ON s.repository_id=r.id
      LEFT JOIN native_identity_versions v ON v.user_id=u.id
      WHERE r.id=? AND r.artifact_name=? AND r.state='ACTIVE' ${idle ? 'AND r.write_pending IS NULL' : ''} AND g.user_id=? AND g.role IN ('write','admin') AND u.active=1
      AND COALESCE(v.version,0)=? AND s.enabled=1 AND s.updated_by=u.id AND s.version=? AND ${kind === 'land' ? 's.land_without_person=1' : 's.revert_on_failure=1'}
      ${rulesVersion === undefined ? '' : 'AND COALESCE((SELECT version FROM repository_rules WHERE repository_id=r.id),0)=?'})`,
    values: [row.id, row.artifact_name, principal.id, principal.identity_version || 0, version, ...(rulesVersion === undefined ? [] : [rulesVersion])] });
}
// A repository row as authorizedRepository builds it, for one account's current grant, and that account; null without a grant.
export async function contextFor(db, env, repositoryId, userId) {
  if (!userId) return null;
  const row = await db.prepare(`SELECT r.*,g.role,${ownerColumns},COALESCE(o.id,w.id) AS workspace_id,COALESCE(v.version,0) AS access_version,
      (SELECT k.operation_id FROM git_ref_unknown k WHERE k.repository_id=r.id LIMIT 1) AS unknown_write,${featureColumns}
    FROM repositories r JOIN grants g ON g.repository_id=r.id JOIN users u ON u.id=g.user_id AND u.active=1 JOIN workspaces w ON w.artifact_namespace=? ${ownerJoin}
    LEFT JOIN repository_access_versions v ON v.repository_id=r.id WHERE r.id=? AND g.user_id=? AND r.state='ACTIVE'`).bind(env.ARTIFACTS_NAMESPACE, repositoryId, userId).first();
  if (!row) return null;
  row.repository_write_pending = row.write_pending; row.write_pending ||= row.unknown_write || null;
  const person = await db.prepare(`SELECT u.id,u.login,u.email,u.active,u.can_create,COALESCE(v.version,0) AS identity_version,COALESCE(p.full_name,u.full_name) AS full_name
    FROM users u LEFT JOIN profiles p ON p.user_id=u.id LEFT JOIN native_identity_versions v ON v.user_id=u.id WHERE u.id=? AND u.active=1`).bind(userId).first();
  return person ? { row, person } : null;
}
async function auditPolicy(db, env, row, action, subject, after, key, outcome = 'success') {
  try {
    await db.prepare(`INSERT OR IGNORE INTO installation_audit(at,actor_id,actor_email,scope,scope_id,subject,action,before,after,widening,operation_id,client)
      VALUES(?,0,'','repository',?,?,?,NULL,?,0,?,?)`).bind(now(), String(row.id), subject, action, JSON.stringify(after), `audit:${action}:0:${key}`,
      JSON.stringify({ via: 'agentic-mode', outcome, repository: `${ownerSlug(row, env)}/${row.name}`, route: 'agentic-mode' })).run();
  } catch { console.log(JSON.stringify({ event: 'golf.audit_write_failed', action })); }
}

// ---------- comments and issues, through the collaboration API under the given account ----------
async function comment(db, env, author, row, op, purpose, text, artifact) {
  try {
    const d = await db.prepare("SELECT id FROM discussions WHERE repository_id=? AND number=? AND kind='pull'").bind(row.id, op.number).first();
    if (!d) return false;
    await collaboration(db, env, author, 'CreateIssueComment', { repositoryId: String(row.id), idempotencyKey: await keyFor(`land:${op.id}:${purpose}`), number: op.number,
      issueId: String(d.id), pullRequest: true, body: text }, row, artifact);
    return true;
  } catch (error) { console.log(JSON.stringify({ event: 'golf.land_comment_failed', operation: op.id, message: String(error?.message || error).slice(0, 160) })); return false; }
}
// The person who asked for the change: the requester of the agent task that opened it, else the author of the pull request.
async function requester(db, row, op) {
  return db.prepare(`SELECT u.id,u.login FROM pull_requests p JOIN discussions d ON d.id=p.discussion_id LEFT JOIN pull_request_origins o ON o.pull_request_id=p.id
    LEFT JOIN agent_tasks t ON t.id=o.agent_task_id JOIN users u ON u.id=COALESCE(t.requested_by,d.author_id) JOIN grants g ON g.user_id=u.id AND g.repository_id=d.repository_id
    WHERE p.id=? AND u.active=1`).bind(op.pull_request_id).first();
}
async function openIssue(db, env, author, row, op, title, text, artifact) {
  if (await featureOff(db, env, row, 'issues')) return { skipped: 'issues are turned off for this repository' };
  try {
    const person = await requester(db, row, op);
    const created = await collaboration(db, env, author, 'CreateIssue', { repositoryId: String(row.id), idempotencyKey: await keyFor(`land:${op.id}:issue`), title,
      body: text + (person ? `\n\nRequested by @${person.login}.` : '') }, row, artifact);
    const number = created.mutation?.number, result = { number, assignee: '' };
    // Assigning needs an administrator, as in the issue sidebar; otherwise the requester is only mentioned.
    if (person && row.role === 'admin' && created.issue?.revision) {
      try {
        await collaboration(db, env, author, 'UpdateIssue', { repositoryId: String(row.id), idempotencyKey: await keyFor(`land:${op.id}:assign`), number, issueId: created.mutation.issueId,
          expectedRevision: created.issue.revision, assignees: { expectedAssigneeIds: [], assignees: [{ id: String(person.id), login: person.login }] } }, row, artifact);
        result.assignee = person.login;
      } catch (error) { if (!(error instanceof Fault)) throw error; }
    }
    return result;
  } catch (error) {
    console.log(JSON.stringify({ event: 'golf.land_issue_failed', operation: op.id, message: String(error?.message || error).slice(0, 160) }));
    return { skipped: 'the issue could not be opened' };
  }
}

// ---------- landing ----------
async function landed(db, env, row, op, receipt, principal, ctx) {
  const done = await transition(db, op, 'LANDED', { reasons: [] }, { landed_commit_id: receipt.mergeCommitId, base_commit_id: receipt.actualBaseCommitId });
  // The base push starts pipelines as a push does (the plain merge request records none): the landed commit is what the checks test.
  const journal = await db.prepare('SELECT g.id,g.ref,g.old_sha,g.new_sha FROM pull_merge_operations m JOIN git_operations g ON g.id=m.git_operation_id WHERE m.actor_id=? AND m.operation_id=?')
    .bind(principal.id, receipt.operationId).first();
  if (journal && pipelinePolicy(env)) {
    try { await dispatchPipelineIntake(env, await recordPipelineIntake(db, env, row.id, 'push', { ref: journal.ref, before: journal.old_sha, after: journal.new_sha, actorId: principal.id, operationId: journal.id }, 'push:' + journal.id), ctx.withArtifact); }
    catch { console.log(JSON.stringify({ event: 'golf.pipeline_intake_record_failed' })); }
  }
  env.notifyLanding?.(row.id);
  // An agent's head branch is deleted once its change landed (agent-branches.mjs decides whether it may be).
  if (done?.state === 'LANDED') await cleanUpAgentBranchSoon(env, { repositoryId: row.id, pullRequestId: op.pull_request_id, headCommitId: op.head_commit_id, why: 'landed' },
    { withArtifact: ctx.withArtifact, providerFetch: ctx.providerFetch });
  return done;
}

// Overlapping paths: NEEDS_REBASE with the conflicting paths. A pull request an agent task opened gets a comment naming them and offering a
// follow-up task; Golf never starts one by itself.
async function rebaseNeeded(db, env, principal, row, op, baseBranch, conflicts, conflictCount = conflicts.length, artifact) {
  const done = await transition(db, op, 'NEEDS_REBASE', { reasons: ['the change conflicts with the base branch'], conflicts, conflictCount });
  const origin = await db.prepare('SELECT kind FROM pull_request_origins WHERE pull_request_id=?').bind(op.pull_request_id).first();
  if (origin?.kind !== 'agent-task') return done;
  const paths = conflicts.map(conflict => `- \`${conflict.path}\` (${String(conflict.reason).replaceAll('_', ' ')})`).join('\n');
  const more = conflictCount > conflicts.length ? `\n- and ${conflictCount - conflicts.length} more` : '';
  const posted = await comment(db, env, principal, row, op, 'conflict', `**Golf agentic mode** could not land this pull request: it conflicts with \`${baseBranch}\` in these paths:\n\n${paths}${more}\n\n` +
    'A follow-up agent task can resolve the conflicts: assign this pull request to a coding agent and ask it to merge the base branch. Golf did not start one.', artifact);
  return posted ? transition(db, done, 'NEEDS_REBASE', { commented: true }, {}, ['NEEDS_REBASE']) : done;
}
// A conflict is the only thing blocking: the evaluation as if the change merged cleanly decides whether it would land.
const onlyConflict = value => value.mergeable.reason === 'merge_conflict' && value.evaluation.decision === 'blocked' && value.evaluation.reasons.length === 1;

// Lands op (QUEUED) now: re-reads the pull request, submits the native merge onto the current base tip and retries a moved base or a
// Whether the landing account still holds write or admin on the repository (a 404 from the merge path can also mean contention).
const stillWriter = async (db, principal, row) => Boolean(await db.prepare("SELECT 1 FROM grants g JOIN users u ON u.id=g.user_id WHERE g.repository_id=? AND g.user_id=? AND g.role IN ('write','admin') AND u.active=1")
  .bind(row.id, principal.id).first());
// busy repository. principal is the account the merge journal names; options ({guard, author}) is the policy's authority for policy lands.
async function land(db, env, principal, row, op, ctx, options = {}) {
  const key = { owner: ownerSlug(row, env), name: row.name }, pause = ctx.pause || (attempt => sleep(backoff(attempt)));
  let last = '', attempt = 0;
  const started = Date.now();
  while (++attempt <= landLimits.attempts) {
    if (attempt > 1) { if (Date.now() - started >= landLimits.budgetMs) break; await pause(attempt - 1); }
    await db.prepare("UPDATE land_operations SET state='LANDING',attempts=?,updated_at=? WHERE id=? AND state IN ('QUEUED','LANDING')").bind(attempt, now(), op.id).run();
    // The repository fence as it is now: an earlier attempt may have met another land's reservation.
    const fence = await db.prepare(`SELECT write_pending,${unknownMergeWrite} AS unknown_write FROM repositories r WHERE id=?`).bind(op.pull_request_id, row.id, row.id).first();
    const live = { ...row, write_pending: fence?.write_pending || fence?.unknown_write || null };
    // Another write holds the repository: wait for its turn instead of submitting a merge that could only record a refusal.
    if (live.write_pending) { last = 'the repository stayed busy with another write'; continue; }
    let d, current;
    try { ({ d, current } = await pullReviewContext(db, env, principal, live, { repositoryId: String(row.id), repository: key, number: op.number, pullRequestId: String(op.pull_request_id) }, ctx.artifact)); }
    catch (error) { if (error instanceof Fault) return transition(db, op, 'FAILED', { reasons: ['the pull request could not be read'] }); throw error; }
    if (d.state !== 'OPEN') return transition(db, op, 'BLOCKED', { reasons: ['the pull request is not open'] });
    if (current.head.retainedSnapshot || current.base.retainedSnapshot) return transition(db, op, 'BLOCKED', { reasons: [refusals.branch_unavailable] });
    if (current.head.commitId !== op.head_commit_id) return transition(db, op, 'BLOCKED', { reasons: [`the head moved to ${current.head.commitId.slice(0, 12)} after landing was requested`] });
    const operationId = crypto.randomUUID();
    // Recorded before the merge is submitted, so an interrupted land can be settled from the merge journal.
    await db.prepare("UPDATE land_operations SET detail=json_set(detail,'$.merge',json(?)),updated_at=? WHERE id=?").bind(JSON.stringify({ actorId: String(principal.id), operationId }), now(), op.id).run();
    let receipt;
    try {
      receipt = (await standardPullMerge(db, env, principal, live, 'SubmitStandardPullMerge', { operationId, ownerId: String(row.workspace_id),
        selection: { repository: key, repositoryId: String(row.id), pullRequestId: String(d.pull_id), number: d.number, headCommitId: current.head.commitId, baseCommitId: current.base.commitId },
        expectedPullRevision: current.revision, sourceRef: d.head_branch, targetRef: d.base_branch, method: op.method }, ctx.artifact, ctx.providerFetch, options)).operation;
    } catch (error) {
      if (error instanceof Fault && error.status === 412 && error.message === busyMessage) { last = 'the repository stayed busy with another write'; continue; }
      // A refusal journaled while another merge took the repository also answers 404; only a lost grant is a lost grant.
      if (error instanceof Fault && error.status === 404 && await stillWriter(db, principal, row)) { last = 'the repository stayed busy with another write'; continue; }
      if (error instanceof Fault) return transition(db, op, 'FAILED', { reasons: [error.status === 404 ? 'the landing account no longer has write access or the setting changed' : error.message] });
      throw error;
    }
    if (receipt.phase === phase('SUCCEEDED')) return landed(db, env, row, op, receipt, principal, ctx);
    if (receipt.phase === phase('DISPATCH_UNKNOWN')) return transition(db, op, 'LANDING', { reasons: ['the merge was sent but its outcome is not confirmed yet; maintenance reads the branch back'] });
    const code = receipt.refusalCode;
    if (code === 'merge_conflict') return rebaseNeeded(db, env, principal, row, op, d.base_branch, receipt.conflicts || [], receipt.conflictCount, ctx.artifact);
    // Git storage refusing with the base unchanged (busy, or a race it lost) is retried like a moved base, with the same backoff.
    if (code === 'pull_request_changed' || code === 'write_unresolved' || code === 'provider_refused') {
      last = code === 'write_unresolved' ? 'the repository stayed busy with another write' : code === 'provider_refused' ? refusals.provider_refused : 'the base branch kept moving'; continue;
    }
    return transition(db, op, 'BLOCKED', { reasons: [refusals[code] || code || 'the merge was refused'] });
  }
  return transition(db, op, 'FAILED', { reasons: [`${last || 'the base branch kept moving'}; gave up after ${attempt - 1} attempts in ${Math.round((Date.now() - started) / 1000)} s`] });
}

// ---------- POST /native/land and /native/land/read ----------
const landFields = ['action', 'repository', 'repositoryId', 'number', 'headCommitId', 'expectedHeadCommitId', 'method', 'idempotencyKey'];
const landPhase = op => op.state === 'LANDED' ? 'LANDED' : op.state === 'LANDING' || op.state === 'QUEUED' ? 'LANDING' : 'LAND_REFUSED';
// A replayed idempotency key: the original operation of this account, for the same repository and pull request; anything else is refused.
async function replayed(db, person, row, body) {
  if (body.idempotencyKey === undefined) return null;
  const op = await db.prepare(`${select} WHERE l.actor_id=? AND l.idempotency_key=? AND l.trigger='person'`).bind(person.id, body.idempotencyKey).first();
  if (!op) return null;
  if (op.repository_id !== row.id || op.number !== body.number || op.head_commit_id !== (body.headCommitId ?? body.expectedHeadCommitId) || op.method !== (body.method || 'merge'))
    throw new Fault('already_exists', 409, 'This idempotencyKey belongs to a different land request.');
  return { operation: wireLand(op), phase: landPhase(op) };
}
export async function landAPI(db, env, person, row, request, body, ctx) {
  if (request.headers.has('Authorization') || request.headers.has('CF-Access-Client-Id') || request.headers.has('CF-Access-Client-Secret') || !request.headers.get('X-Golf-Native-Access-Email') || request.headers.get('Origin') !== env.PUBLIC_ORIGIN)
    forbidden('Land pull requests from a signed-in browser session.');
  if (!await landSchema(db) || !await agenticSchema(db)) refuse('Landing needs the schema 42 migration on this installation.');
  if (body.action === 'list') {
    const limit = body.limit ?? 20;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > landLimits.list) invalid(`Ask for 1 to ${landLimits.list} land operations.`);
    if (body.number !== undefined && (!Number.isSafeInteger(body.number) || body.number < 1)) invalid('Filter by a pull request number.');
    // Most recently updated first (a revert or retry moves a landing up), the order of the (repository_id,updated_at) index;
    // one row past the limit says whether older ones exist.
    const { results } = await db.prepare(`${select} WHERE l.repository_id=?${body.number === undefined ? '' : ' AND l.number=?'} ORDER BY l.updated_at DESC,l.id DESC LIMIT ?`)
      .bind(row.id, ...(body.number === undefined ? [] : [body.number]), limit + 1).all();
    return { repositoryId: String(row.id), operations: results.slice(0, limit).map(wireLand), limit, more: results.length > limit };
  }
  if (body.action === 'get') {
    if (!uuidOK(body.id)) invalid('Name the land operation by its ID.');
    const op = await db.prepare(`${select} WHERE l.id=? AND l.repository_id=?`).bind(body.id, row.id).first();
    if (!op) throw new Fault('not_found', 404, 'Land operation not found.');
    return { operation: wireLand(op) };
  }
  if (body.action === 'revert') return personRevert(db, env, person, row, body, ctx);
  if (body.action !== 'land') invalid('Use land, revert, list or get.');
  if (Object.keys(body).some(field => !landFields.includes(field))) invalid('Send only repository, repositoryId, number, headCommitId, method and idempotencyKey.');
  if (!Number.isSafeInteger(body.number) || body.number < 1) invalid('Choose a pull request by its number.');
  // headCommitId and expectedHeadCommitId mean the same: the head the caller reviewed. Landing refuses a head that moved.
  if (body.headCommitId !== undefined && body.expectedHeadCommitId !== undefined && body.headCommitId !== body.expectedHeadCommitId) invalid('headCommitId and expectedHeadCommitId differ; send one.');
  const expectedHead = body.headCommitId ?? body.expectedHeadCommitId;
  if (!sha(expectedHead)) invalid('Send the full head commit you reviewed as headCommitId.');
  if (![undefined, 'merge', 'squash'].includes(body.method)) invalid('Land with merge or squash.');
  if (body.idempotencyKey !== undefined && !uuidOK(body.idempotencyKey)) invalid('idempotencyKey is a lowercase UUID v4.');
  if (!['write', 'admin'].includes(row.role)) forbidden('Landing needs a write or admin grant on this repository.');
  const again = await replayed(db, person, row, body);
  if (again) return again;
  const [settings, feature] = await Promise.all([agenticSettings(db, row), agenticFeature(db, env, row)]);
  if (!feature.allowed) refuse(feature.reason || 'Agentic mode is turned off for this repository by a policy.');
  if (!settings.enabled) refuse('Agentic mode is off for this repository; merge the pull request instead.');
  // The repository fence is the land's own concern (it retries); the policy decides on everything else.
  const value = await landingEvaluation(db, env, { ...row, write_pending: null }, body.number, ctx.artifact, settings, feature);
  const conflicted = onlyConflict(value), result = conflicted ? value.ifMergeable : value.evaluation;
  if (value.headCommitId !== expectedHead) refuse(`The pull request head moved to ${value.headCommitId.slice(0, 12)}. Review the new head before landing.`);
  // A writer who is not the author is the qualifying approval the policy asks for; pending checks, drafts and change requests still wait.
  if (result.decision !== 'land' && !(onlyApprovalNeeded(result) && value.d.author_id !== person.id)) {
    const why = result.reasons.join('; ');
    refuse(result.decision === 'blocked' ? `The landing policy blocks this pull request: ${why}.` : result.decision === 'waiting_checks' ? `Required checks have not passed yet: ${why}.`
      : onlyApprovalNeeded(result) ? `Another writer must land or approve this pull request: ${why}.` : `This pull request needs a person first: ${why}.`);
  }
  const op = await create(db, row, value.d, { trigger: 'person', actorId: person.id, method: body.method || 'merge', headCommitId: value.headCommitId,
    detail: { decision: result.decision, reasons: result.reasons }, idempotencyKey: body.idempotencyKey ?? null });
  if (!op) return await replayed(db, person, row, body) || refuse('This pull request is already landing.');
  const done = conflicted ? await rebaseNeeded(db, env, person, row, op, value.d.base_branch, value.mergeable.conflicts || [], value.mergeable.conflictCount, ctx.artifact) : await land(db, env, person, row, op, ctx);
  return { operation: wireLand(done), phase: landPhase(done) };
}

// ---------- policy landing ----------
// Evaluates open pull requests of one repository whose agentic mode lands without a person, and lands those the policy says 'land'.
// commitId narrows it to pull requests whose head is that commit (a finished pipeline run). At most `limit` evaluations.
export async function autoLand(env, repositoryId, { commitId, limit = landLimits.sweep, rotate = 0, withArtifact, providerFetch = env.providerFetch || fetch, pause } = {}) {
  const db = env.DB.withSession('first-primary');
  const stored = await db.prepare('SELECT updated_by FROM repository_agentic_settings WHERE repository_id=? AND enabled=1 AND land_without_person=1').bind(repositoryId).first();
  const context = stored && await contextFor(db, env, repositoryId, stored.updated_by);
  if (!context || !['write', 'admin'].includes(context.row.role)) return { evaluated: 0, landed: 0 };
  const { row, person: principal } = context, artifact = action => withArtifact(env, row, action);
  const [settings, feature] = await Promise.all([agenticSettings(db, row), agenticFeature(db, env, row)]);
  if (!feature.allowed || !settings.enabled || !settings.landWithoutPerson || await featureOff(db, env, row, 'pull-requests')) return { evaluated: 0, landed: 0 };
  // Open, non-draft pull requests without a land in progress. A sweep takes them in a rotating order so a long list is covered across
  // sweeps; a targeted pass (landSoon: a check reported, a pull request opened) takes exactly those whose head branch is now at its
  // commit, however many pull requests are open (a fixed 200 of a longer list never reached the others).
  const open = `SELECT d.number,p.id AS pull_id,p.head_branch FROM discussions d JOIN pull_requests p ON p.discussion_id=d.id
    WHERE d.repository_id=? AND d.kind='pull' AND d.state='OPEN' AND p.draft=0 AND NOT EXISTS(SELECT 1 FROM land_operations l WHERE l.pull_request_id=p.id AND l.state IN ('QUEUED','LANDING'))`;
  let refs, pulls;
  if (commitId) {
    refs = await artifact(repo => inventory(env, row, repo, providerFetch));
    const branches = [...refs].filter(([ref, hash]) => hash === commitId && ref.startsWith('refs/heads/')).map(([ref]) => ref.slice('refs/heads/'.length));
    if (!branches.length) return { evaluated: 0, landed: 0 };
    pulls = (await db.prepare(`${open} AND p.head_branch IN (SELECT value FROM json_each(?)) ORDER BY d.number LIMIT 20`).bind(row.id, JSON.stringify(branches.slice(0, 20))).all()).results;
  } else {
    pulls = (await db.prepare(`${open} ORDER BY (p.id*7919+?)%104729 LIMIT 200`).bind(row.id, rotate).all()).results;
    if (pulls.length) refs = await artifact(repo => inventory(env, row, repo, providerFetch));
  }
  if (!pulls.length) return { evaluated: 0, landed: 0 };
  let evaluated = 0, landedCount = 0;
  for (const pull of pulls) {
    if (evaluated >= limit) break;
    const head = refs.get('refs/heads/' + pull.head_branch);
    if (!head || commitId && head !== commitId) continue;
    // One attempt per head: a head that conflicted or was blocked waits for a new push; a failed attempt is retried after ten minutes.
    if (await db.prepare(`SELECT 1 FROM land_operations WHERE pull_request_id=? AND head_commit_id=? AND (state IN ('LANDED','REVERTED','NEEDS_REBASE','BLOCKED') OR state='FAILED' AND updated_at>?) LIMIT 1`)
      .bind(pull.pull_id, head, new Date(Date.now() - 600_000).toISOString()).first()) continue;
    evaluated++;
    let value;
    try { value = await landingEvaluation(db, env, { ...row, write_pending: null }, pull.number, artifact, settings, feature); }
    catch (error) { if (error instanceof Fault) continue; throw error; }
    const conflicted = onlyConflict(value) && value.ifMergeable.decision === 'land';
    if (value.evaluation.decision !== 'land' && !conflicted || value.headCommitId !== head) {
      // A targeted pass (landSoon: a check reported, a pull request opened) says why this head did not land; the sweep stays quiet.
      if (commitId) console.log(JSON.stringify({ event: 'golf.land_soon_skipped', repositoryId: String(row.id), number: pull.number, decision: value.evaluation.decision,
        reasons: (value.evaluation.reasons || []).slice(0, 5).map(reason => String(reason).slice(0, 160)), headMoved: value.headCommitId !== head }));
      continue;
    }
    const op = await create(db, row, value.d, { trigger: 'policy', actorId: 0, method: 'merge', headCommitId: head,
      detail: { decision: 'land', reasons: (conflicted ? value.ifMergeable : value.evaluation).reasons, principal: principal.login } });
    if (!op) continue;
    const done = conflicted ? await rebaseNeeded(db, env, principal, row, op, value.d.base_branch, value.mergeable.conflicts || [], value.mergeable.conflictCount, artifact) : await land(db, env, principal, row, op, { artifact, providerFetch, withArtifact, pause }, { guard: policyGuard(principal, row, { version: settings.version, kind: 'land' }), author: agenticIdentity });
    await auditPolicy(db, env, row, 'agentic_mode.auto_land', `#${op.number}`, { number: op.number, state: done.state, method: op.method, landedCommitId: done.landed_commit_id ? done.landed_commit_id.slice(0, 12) : undefined }, op.id,
      done.state === 'LANDED' || done.state === 'LANDING' ? 'success' : 'refused');
    if (done.state === 'LANDED') landedCount++;
  }
  return { evaluated, landed: landedCount };
}

// ---------- checks after landing, and the automatic revert ----------
// Required checks of the landed commit, by the same rules as landing: the named checks, or every pipeline run for that commit.
export async function checkLanded(env, op, { withArtifact, providerFetch = env.providerFetch || fetch } = {}) {
  const db = env.DB.withSession('first-primary');
  const settingsRow = await db.prepare('SELECT updated_by FROM repository_agentic_settings WHERE repository_id=?').bind(op.repository_id).first();
  const context = await contextFor(db, env, op.repository_id, op.trigger === 'policy' ? settingsRow?.updated_by : op.actor_id) || await contextFor(db, env, op.repository_id, settingsRow?.updated_by);
  if (!context) return 'no_authority';
  const { row, person: author } = context, artifact = action => withArtifact(env, row, action);
  const [settings, feature] = await Promise.all([agenticSettings(db, row), agenticFeature(db, env, row)]);
  const required = requiredCheckStates(settings.requiredChecks, await headChecks(db, row, op.landed_commit_id));
  const failed = required.filter(check => check.outcome === 'failed').map(check => check.name);
  if (!failed.length) {
    // Every required check passed: done. No check at all after six hours: nothing will decide it.
    const verdict = required.length && required.every(check => check.outcome === 'passed') ? 'passed' : !required.length && Date.parse(op.updated_at) < Date.now() - 6 * 3600_000 ? 'no_checks' : '';
    if (verdict) await db.prepare("UPDATE land_operations SET detail=json_set(detail,'$.postLand',json(?)),updated_at=? WHERE id=? AND state='LANDED' AND json_extract(detail,'$.postLand') IS NULL")
      .bind(JSON.stringify({ verdict, checks: required.map(check => check.name) }), now(), op.id).run();
    return verdict || 'pending';
  }
  const revert = op.trigger === 'policy' && settings.enabled && feature.allowed && settings.revertOnFailure;
  // The claim: one verdict, and at most one revert, per land operation.
  const claimed = await db.prepare("UPDATE land_operations SET detail=json_set(detail,'$.postLand',json(?)),updated_at=? WHERE id=? AND state='LANDED' AND json_extract(detail,'$.postLand') IS NULL")
    .bind(JSON.stringify({ verdict: 'failed', checks: failed, action: revert ? 'revert' : 'comment' }), now(), op.id).run();
  if (claimed.meta.changes !== 1) return 'claimed';
  const d = await db.prepare("SELECT d.title,d.number,p.base_branch FROM discussions d JOIN pull_requests p ON p.discussion_id=d.id WHERE p.id=?").bind(op.pull_request_id).first();
  const names = failed.map(name => `\`${name}\``).join(', ');
  if (!revert) {
    const why = op.trigger === 'person' ? 'it was landed by a person, so Golf leaves the decision to people' : !settings.revertOnFailure ? 'automatic reverts are off for this repository' : 'agentic mode is off for this repository';
    await comment(db, env, author, row, op, 'checks', `**Golf agentic mode:** required checks failed on \`${d.base_branch}\` after this pull request landed (${op.landed_commit_id.slice(0, 12)}): ${names}. Golf did not revert it: ${why}.`, artifact);
    return 'commented';
  }
  return revertLanded(env, db, op, d, failed, { withArtifact, providerFetch, artifact, settings });
}

// The inverse three-way merge of a landed commit onto the current tip of ref, as `git revert -m 1`, committed through the branch fence
// (source-api.mjs commitTree) under guard. author() is the commit identity at each attempt. Returns { commitId, operationId }, { noop },
// { conflicts, conflictCount } or { failed }; a Fault (a branch rule, an unconfirmed write) is thrown.
async function inverseCommit(env, db, row, principal, op, ref, { message, author, guard, record }, ctx) {
  return ctx.withArtifact(env, row, async repo => {
    const landedCommit = await repo.readCommit(op.landed_commit_id), parent = landedCommit?.parents?.[0] && await repo.readCommit(landedCommit.parents[0]);
    if (!landedCommit || !parent) return { failed: 'the landed commit could not be read' };
    for (let attempt = 1; attempt <= landLimits.revertAttempts; attempt++) {
      const tip = (await inventory(env, row, repo, ctx.providerFetch)).get(ref), tipCommit = tip && await repo.readCommit(tip);
      if (!tipCommit) return { failed: 'the base branch no longer exists' };
      // From the landed tree back to its first parent, applied to the current tip.
      let merged;
      try { merged = await mergeTrees(repo, landedCommit.treeHash, tipCommit.treeHash, parent.treeHash); }
      catch (error) { if (!(error instanceof GitTreeError)) throw error; merged = { treeId: null, conflicts: [{ path: error.path, reason: error.code }] }; }
      if (!merged.treeId) return { conflicts: merged.conflicts.slice(0, 50).map(({ path, reason }) => ({ path, reason })), conflictCount: merged.conflicts.length };
      if (merged.treeId === tipCommit.treeHash) return { noop: true };
      let sent;
      try {
        sent = await commitTree(db, env, principal, row, repo, { ref, parent: tip, treeId: merged.treeId, objects: merged.objects, message, author: author(), guard, record },
          { withArtifact: ctx.withArtifact, providerFetch: ctx.providerFetch, ciState: 'NONE' });
      } catch (error) {
        // A merge or an unknown write holding the repository: wait like a moved branch.
        if (!(error instanceof Fault && error.message === busyMessage)) throw error;
        sent = { outcome: 'busy' };
      }
      if (sent.outcome === 'applied') return { commitId: sent.commitId, operationId: sent.id };
      if (attempt < landLimits.revertAttempts) await sleep(backoff(attempt));
    }
    return { failed: 'the base branch kept moving' };
  });
}
// A Fault from a revert attempt, as an outcome.
const revertFault = error => ({ failed: error.code === 'permission_denied' ? 'the base branch is locked by a branch rule' : error.status === 503 ? 'the revert was sent but not confirmed; maintenance reads the branch back' : error.message, unknown: error.status === 503 });

async function revertLanded(env, db, op, d, failed, ctx) {
  const settingsRow = await db.prepare('SELECT updated_by,version FROM repository_agentic_settings WHERE repository_id=?').bind(op.repository_id).first();
  const context = await contextFor(db, env, op.repository_id, settingsRow?.updated_by);
  const record = async detail => db.prepare("UPDATE land_operations SET detail=json_set(detail,'$.revert',json(?)),updated_at=? WHERE id=?").bind(JSON.stringify(detail), now(), op.id).run();
  if (!context || !['write', 'admin'].includes(context.row.role)) { await record({ state: 'refused', reason: 'the administrator who saved agentic mode no longer has write access' }); return 'refused'; }
  const { row, person: principal } = context, ref = 'refs/heads/' + d.base_branch, names = failed.join(', ');
  const message = `Revert "${String(d.title).replace(/\p{Cc}+/gu, ' ').trim()}" (#${d.number})\n\nAutomatic revert: required checks failed after landing: ${names}.\n\nThis reverts commit ${op.landed_commit_id}.`;
  let outcome;
  try {
    const rulesVersion = await enforceGitRules(db, row, principal, ref);
    outcome = await inverseCommit(env, db, row, principal, op, ref, { message, author: () => ({ ...agenticIdentity, time: Math.floor(Date.now() / 1000) }),
      guard: policyGuard(principal, row, { version: settingsRow.version, kind: 'revert', rulesVersion })(true), record: (operationId, commitId) => record({ state: 'sending', operationId, commitId }) }, ctx);
  } catch (error) {
    if (!(error instanceof Fault)) throw error;
    outcome = revertFault(error);
  }
  return revertFollowUp(env, db, op, d, failed, outcome, context, ctx.artifact);
}

// ---------- a person reverts a landing from the agentic inbox ----------
// POST /native/land { action: 'revert', id, number, landedCommitId, reason?, idempotencyKey }: a writer reverts a landed change (a policy's or
// a person's) with the same inverse merge as the automatic revert, committed as that person under their current authority (the push fence's
// guard: grant, access and identity versions, branch rules). The claim (detail.revert, keyed by the request) admits one revert per landing;
// it also takes the post-landing check, so an automatic revert cannot run alongside, and gives it back when the revert does not apply.
const revertFields = ['action', 'repository', 'repositoryId', 'id', 'number', 'landedCommitId', 'reason', 'idempotencyKey'];
const inFlight = ['requested', 'sending', 'unknown'];
const revertPhase = op => op.state === 'REVERTED' ? 'REVERTED' : inFlight.includes(parse(op.detail).revert?.state) ? 'REVERTING' : 'REVERT_REFUSED';
const revertView = op => ({ operation: wireLand(op), phase: revertPhase(op), revert: parse(op.detail).revert || null });
async function personRevert(db, env, person, row, body, ctx) {
  if (Object.keys(body).some(field => !revertFields.includes(field))) invalid('Send only repository, repositoryId, id, number, landedCommitId, reason and idempotencyKey.');
  if (!uuidOK(body.id)) invalid('Name the land operation by its ID.');
  if (!Number.isSafeInteger(body.number) || body.number < 1) invalid('Name the pull request number of the landing.');
  if (!sha(body.landedCommitId)) invalid('Send the full landed commit you are reverting as landedCommitId.');
  if (!uuidOK(body.idempotencyKey)) invalid('idempotencyKey is a lowercase UUID v4.');
  const reason = body.reason ?? '';
  if (typeof reason !== 'string' || reason.length > 500 || /\p{Cc}/u.test(reason.replaceAll('\n', ''))) invalid('Write a reason of at most 500 characters, or none.');
  if (!['write', 'admin'].includes(row.role)) forbidden('Reverting needs a write or admin grant on this repository.');
  let op = await db.prepare(`${select} WHERE l.id=? AND l.repository_id=?`).bind(body.id, row.id).first();
  if (!op) throw new Fault('not_found', 404, 'Land operation not found.');
  if (op.number !== body.number || op.landed_commit_id !== body.landedCommitId) throw new Fault('aborted', 409, 'This land operation is a different landing; refresh the inbox.');
  const mine = value => value?.key === body.idempotencyKey && value.actorId === String(person.id);
  if (mine(parse(op.detail).revert)) return revertView(op);
  if (op.state === 'REVERTED') refuse(`This landing was already reverted with ${op.revert_commit_id.slice(0, 12)}.`);
  if (op.state !== 'LANDED') refuse('Only a landed change can be reverted.');
  const d = await db.prepare('SELECT d.title,d.number,p.base_branch FROM discussions d JOIN pull_requests p ON p.discussion_id=d.id WHERE p.id=?').bind(op.pull_request_id).first();
  if (!d) refuse('The pull request of this landing no longer exists.');
  const claim = { state: 'requested', trigger: 'person', actorId: String(person.id), actor: person.login, key: body.idempotencyKey, ...(reason.trim() ? { reason: reason.trim() } : {}), requestedAt: now() };
  // Refused while another revert of it is in flight, or while an automatic revert that claimed it in the last ten minutes has not recorded an attempt.
  const claimed = await db.prepare(`UPDATE land_operations SET detail=CASE WHEN json_extract(detail,'$.postLand') IS NULL THEN json_set(detail,'$.revert',json(?),'$.postLand',json(?))
      ELSE json_set(detail,'$.revert',json(?)) END,updated_at=?
    WHERE id=? AND state='LANDED' AND landed_commit_id=? AND COALESCE(json_extract(detail,'$.revert.state'),'') NOT IN ('requested','sending','unknown','applied')
      AND NOT (COALESCE(json_extract(detail,'$.postLand.action'),'')='revert' AND json_extract(detail,'$.revert') IS NULL AND updated_at>?)`)
    .bind(JSON.stringify(claim), JSON.stringify({ verdict: 'person_revert', checks: [] }), JSON.stringify(claim), now(), op.id, op.landed_commit_id, new Date(Date.now() - 600_000).toISOString()).run();
  if (claimed.meta.changes !== 1) {
    op = await reread(db, op.id);
    if (mine(parse(op.detail).revert)) return revertView(op);
    refuse(op.state === 'REVERTED' ? 'This landing was reverted meanwhile.' : 'A revert of this landing is already in progress.');
  }
  const ref = 'refs/heads/' + d.base_branch, title = String(d.title).replace(/\p{Cc}+/gu, ' ').trim();
  const message = `Revert "${title}" (#${d.number})\n\n${claim.reason ? claim.reason + '\n\n' : ''}Reverted by @${person.login} from the agentic inbox.\n\nThis reverts commit ${op.landed_commit_id}.`;
  const record = detail => db.prepare("UPDATE land_operations SET detail=json_set(detail,'$.revert',json(?)),updated_at=? WHERE id=?").bind(JSON.stringify({ ...claim, ...detail }), now(), op.id).run();
  let outcome;
  try {
    const rulesVersion = await enforceGitRules(db, row, person, ref);
    outcome = await inverseCommit(env, db, row, person, op, ref, { message, author: () => identity(env, person, Math.floor(Date.now() / 1000)), guard: writeAuthority(person, row, rulesVersion),
      record: (operationId, commitId) => record({ state: 'sending', operationId, commitId }) }, ctx);
  } catch (error) {
    if (!(error instanceof Fault)) throw error;
    outcome = revertFault(error);
  }
  return revertView(await personRevertFollowUp(env, db, op, d, outcome, claim, { row, person }, ctx.artifact));
}

// What happened to a person's revert: REVERTED with a comment on the pull request, or why it did not apply (and the post-landing check given
// back). context is null when the person no longer has access (maintenance settling it): the outcome is still recorded.
async function personRevertFollowUp(env, db, op, d, outcome, claim, context, artifact) {
  const record = detail => db.prepare("UPDATE land_operations SET detail=json_set(detail,'$.revert',json(?)),updated_at=? WHERE id=?").bind(JSON.stringify({ ...claim, ...detail }), now(), op.id).run();
  if (outcome.commitId) {
    await db.prepare("UPDATE land_operations SET state='REVERTED',revert_commit_id=?,detail=json_set(detail,'$.revert',json(?)),updated_at=? WHERE id=? AND state='LANDED'")
      .bind(outcome.commitId, JSON.stringify({ ...claim, state: 'applied', operationId: outcome.operationId, commitId: outcome.commitId }), now(), op.id).run();
    if (context) {
      await comment(db, env, context.person, context.row, op, 'person-revert', `@${claim.actor} reverted this pull request on \`${d.base_branch}\` with ${outcome.commitId.slice(0, 12)} from the agentic inbox.` +
        (claim.reason ? `\n\n> ${claim.reason.replaceAll('\n', '\n> ')}` : ''), artifact);
      env.notifyLanding?.(context.row.id);
    }
    return reread(db, op.id);
  }
  if (outcome.unknown) { await record({ state: 'unknown', reason: outcome.failed }); return reread(db, op.id); }
  await record(outcome.noop ? { state: 'noop', reason: 'the base branch no longer holds the change' } : outcome.conflicts ? { state: 'conflict', conflicts: outcome.conflicts, conflictCount: outcome.conflictCount } : { state: 'refused', reason: outcome.failed });
  // Not reverted: failing checks may still revert a policy landing automatically.
  await db.prepare("UPDATE land_operations SET detail=json_remove(detail,'$.postLand'),updated_at=? WHERE id=? AND json_extract(detail,'$.postLand.verdict')='person_revert'").bind(now(), op.id).run();
  return reread(db, op.id);
}

// What happened to the revert, told on the pull request and in an issue for the requester; also used when maintenance settles a revert.
async function revertFollowUp(env, db, op, d, failed, outcome, { row, person: principal }, artifact) {
  const title = `Automatic revert of #${d.number}: checks failed`, names = failed.join(', ');
  const record = async detail => db.prepare("UPDATE land_operations SET detail=json_set(detail,'$.revert',json(?)),updated_at=? WHERE id=?").bind(JSON.stringify(detail), now(), op.id).run();
  if (outcome.commitId) {
    await db.prepare("UPDATE land_operations SET state='REVERTED',revert_commit_id=?,detail=json_set(detail,'$.revert',json(?)),updated_at=? WHERE id=? AND state='LANDED'")
      .bind(outcome.commitId, JSON.stringify({ state: 'applied', operationId: outcome.operationId, commitId: outcome.commitId }), now(), op.id).run();
    await comment(db, env, principal, row, op, 'revert', `**Golf agentic mode** reverted this pull request on \`${d.base_branch}\` with ${outcome.commitId.slice(0, 12)}: required checks failed after landing: ${failed.map(name => `\`${name}\``).join(', ')}.`, artifact);
    const issue = await openIssue(db, env, principal, row, op, title, `Golf agentic mode landed #${d.number} (${op.landed_commit_id.slice(0, 12)}) on \`${d.base_branch}\`, and these required checks then failed there: ${names}.\n\n` +
      `It was reverted automatically with ${outcome.commitId}. Fix the change and open a new pull request.`, artifact);
    await db.prepare("UPDATE land_operations SET detail=json_set(detail,'$.issue',json(?)),updated_at=? WHERE id=?").bind(JSON.stringify(issue), now(), op.id).run();
    env.notifyLanding?.(row.id);
    await auditPolicy(db, env, row, 'agentic_mode.revert', `#${d.number}`, { number: d.number, landedCommitId: op.landed_commit_id.slice(0, 12), revertCommitId: outcome.commitId.slice(0, 12), checks: failed.slice(0, 20) }, op.id);
    return 'reverted';
  }
  if (outcome.unknown) { await record({ state: 'unknown', reason: outcome.failed }); return 'unknown'; }
  // Not reverted: the land stays LANDED with the reason, and an issue asks a person to act.
  const detail = outcome.noop ? { state: 'noop', reason: 'the base branch no longer holds the change' } : outcome.conflicts ? { state: 'conflict', conflicts: outcome.conflicts, conflictCount: outcome.conflictCount } : { state: 'refused', reason: outcome.failed };
  await record(detail);
  if (outcome.conflicts) await db.prepare("UPDATE land_operations SET detail=json_set(detail,'$.revertConflict',json(?)),updated_at=? WHERE id=?").bind(JSON.stringify(outcome.conflicts), now(), op.id).run();
  if (outcome.noop) return 'noop';
  const why = outcome.conflicts ? `Reverting it conflicts with later changes in:\n\n${outcome.conflicts.map(c => `- \`${c.path}\``).join('\n')}` : `It could not be reverted: ${outcome.failed}.`;
  await comment(db, env, principal, row, op, 'revert', `**Golf agentic mode:** required checks failed on \`${d.base_branch}\` after this pull request landed: ${failed.map(name => `\`${name}\``).join(', ')}. ${outcome.conflicts ? 'Reverting it conflicts with later changes, so Golf opened an issue instead.' : 'Golf could not revert it and opened an issue instead.'}`, artifact);
  const issue = await openIssue(db, env, principal, row, op, title, `Golf agentic mode landed #${d.number} (${op.landed_commit_id.slice(0, 12)}) on \`${d.base_branch}\`, and these required checks then failed there: ${names}.\n\n${why}\n\nRevert or fix it by hand.`, artifact);
  await db.prepare("UPDATE land_operations SET detail=json_set(detail,'$.issue',json(?)),updated_at=? WHERE id=?").bind(JSON.stringify(issue), now(), op.id).run();
  await auditPolicy(db, env, row, 'agentic_mode.revert', `#${d.number}`, { number: d.number, landedCommitId: op.landed_commit_id.slice(0, 12), reason: outcome.conflicts ? 'conflict' : 'refused', checks: failed.slice(0, 20) }, op.id, 'refused');
  return outcome.conflicts ? 'conflict' : 'refused';
}

// ---------- hooks: a finished pipeline run, and the maintenance sweep ----------
// A pipeline run finished: check landed changes at that commit, and (landing without a person) land pull requests whose head it is.
export async function afterPipelineRun(env, run, withArtifact) {
  const db = env.DB.withSession('first-primary');
  if (!run?.commit_id || !await landSchema(db)) return;
  const stored = await db.prepare('SELECT enabled,land_without_person FROM repository_agentic_settings WHERE repository_id=?').bind(run.repository_id).first();
  if (!stored?.enabled) return;
  const { results } = await db.prepare(`${select} WHERE l.repository_id=? AND l.landed_commit_id=? AND l.state='LANDED' AND json_extract(l.detail,'$.postLand') IS NULL LIMIT 5`).bind(run.repository_id, run.commit_id).all();
  for (const op of results) await checkLanded(env, op, { withArtifact });
  if (stored.land_without_person) await autoLand(env, run.repository_id, { commitId: run.commit_id, withArtifact });
}

// A reported check or a newly opened pull request can complete a landing decision now: land the open pull requests whose head is this
// commit after the response (env.waitUntil), instead of waiting for the maintenance sweep. Only where the repository lands without a
// person; autoLand evaluates every rule again, and a pull request it cannot land waits for the sweep as before.
export function landSoon(env, repositoryId, commitId, withArtifact) {
  if (!sha(commitId) || typeof env.waitUntil !== 'function') return;
  env.waitUntil((async () => {
    const db = env.DB.withSession('first-primary');
    if (!await landSchema(db) || !await agenticSchema(db)) return;
    if (!await db.prepare('SELECT 1 AS ok FROM repository_agentic_settings WHERE repository_id=? AND enabled=1 AND land_without_person=1').bind(repositoryId).first()) return;
    await autoLand(env, repositoryId, { commitId, limit: 5, withArtifact });
  })().catch(error => console.log(JSON.stringify({ event: 'golf.land_soon_failed', message: String(error?.message || error).slice(0, 160) }))));
}

// Settles lands interrupted after their merge was submitted, from the merge journal (inspecting an unknown merge reads the branch back).
async function settleLand(env, db, op, withArtifact) {
  const merge = parse(op.detail).merge, providerFetch = env.providerFetch || fetch;
  const journal = merge && await db.prepare('SELECT * FROM pull_merge_operations WHERE actor_id=? AND operation_id=?').bind(Number(merge.actorId), merge.operationId).first();
  if (!journal) return transition(db, op, 'FAILED', { reasons: ['the land was interrupted before its merge was sent'] });
  const context = await contextFor(db, env, op.repository_id, journal.actor_id);
  if (journal.phase === 'DISPATCH_UNKNOWN' && context) {
    const { row, person } = context;
    try {
      await standardPullMerge(db, env, person, row, 'GetStandardPullMergeOperation', { operationId: merge.operationId, ownerId: String(row.workspace_id), repository: { owner: ownerSlug(row, env), name: row.name },
        repositoryId: String(row.id), pullRequestId: String(op.pull_request_id), number: op.number }, action => withArtifact(env, row, action), providerFetch);
    } catch (error) { if (!(error instanceof Fault)) throw error; }
  }
  const settled = await db.prepare('SELECT * FROM pull_merge_operations WHERE actor_id=? AND operation_id=?').bind(journal.actor_id, journal.operation_id).first();
  if (settled.phase === 'SUCCEEDED' && context) return landed(db, env, context.row, op, { operationId: settled.operation_id, mergeCommitId: settled.merge_commit_id, actualBaseCommitId: settled.actual_base_commit_id }, context.person, { withArtifact });
  if (settled.phase === 'REJECTED') return transition(db, op, settled.detail === 'merge_conflict' ? 'NEEDS_REBASE' : 'FAILED', { reasons: [refusals[settled.detail] || settled.detail || 'the merge was refused'] });
  return op;
}

// A revert whose outcome was not confirmed: the branch fence settles its write (ref-writes.mjs settleRefWrites); then it is reported.
async function settleRevert(env, db, op, withArtifact) {
  const detail = parse(op.detail), revert = detail.revert || {};
  const write = revert.operationId && await db.prepare('SELECT g.state,w.outcome FROM git_operations g LEFT JOIN git_ref_writes w ON w.operation_id=g.id WHERE g.id=?').bind(revert.operationId).first();
  const outcome = write?.state === 'APPLIED' ? { commitId: revert.commitId, operationId: revert.operationId } : !write || write.outcome === 'NOT_APPLIED' ? { failed: 'the revert was not applied' } : null;
  if (!outcome) return 'unknown';
  if (revert.trigger === 'person') {
    const d = await db.prepare('SELECT d.title,d.number,p.base_branch FROM discussions d JOIN pull_requests p ON p.discussion_id=d.id WHERE p.id=?').bind(op.pull_request_id).first();
    const context = await contextFor(db, env, op.repository_id, Number(revert.actorId));
    await personRevertFollowUp(env, db, op, d || { base_branch: '' }, outcome, revert, d && context, context && (action => withArtifact(env, context.row, action)));
    return outcome.commitId ? 'reverted' : 'refused';
  }
  const settingsRow = await db.prepare('SELECT updated_by FROM repository_agentic_settings WHERE repository_id=?').bind(op.repository_id).first();
  const context = await contextFor(db, env, op.repository_id, settingsRow?.updated_by);
  const d = await db.prepare('SELECT d.title,d.number,p.base_branch FROM discussions d JOIN pull_requests p ON p.discussion_id=d.id WHERE p.id=?').bind(op.pull_request_id).first();
  if (!context || !d) return 'no_authority';
  return revertFollowUp(env, db, op, d, detail.postLand?.checks || [], outcome, context, action => withArtifact(env, context.row, action));
}

// Maintenance: interrupted lands and reverts, checks of recent landings, then policy landing for repositories that land without a person. Bounded.
export async function sweepLanding(env, withArtifact, limit = landLimits.sweep) {
  const db = env.DB.withSession('first-primary');
  if (!await landSchema(db) || !await agenticSchema(db)) return { processed: 0 };
  let processed = 0;
  const step = async action => { try { await action(); processed++; } catch (error) { console.log(JSON.stringify({ event: 'golf.land_sweep_failed', message: String(error?.message || error).slice(0, 160) })); } };
  const { results: stale } = await db.prepare(`${select} WHERE l.state IN ('QUEUED','LANDING') AND l.updated_at<? ORDER BY l.updated_at LIMIT ?`).bind(new Date(Date.now() - 120_000).toISOString(), limit).all();
  for (const op of stale) await step(() => settleLand(env, db, op, withArtifact));
  const { results: reverts } = await db.prepare(`${select} WHERE l.state='LANDED' AND json_extract(l.detail,'$.revert.state') IN ('sending','unknown') AND l.updated_at<? ORDER BY l.updated_at LIMIT ?`)
    .bind(new Date(Date.now() - 120_000).toISOString(), limit).all();
  for (const op of reverts) await step(() => settleRevert(env, db, op, withArtifact));
  const { results: recent } = await db.prepare(`${select} WHERE l.state='LANDED' AND l.updated_at>? AND json_extract(l.detail,'$.postLand') IS NULL ORDER BY l.updated_at LIMIT ?`)
    .bind(new Date(Date.now() - 24 * 3600_000).toISOString(), limit).all();
  for (const op of recent) await step(() => checkLanded(env, op, { withArtifact }));
  const { results: repositories } = await db.prepare("SELECT s.repository_id FROM repository_agentic_settings s JOIN repositories r ON r.id=s.repository_id WHERE s.enabled=1 AND s.land_without_person=1 AND r.state='ACTIVE' ORDER BY s.repository_id LIMIT 50").all();
  let budget = limit;
  const rotate = Math.floor(Date.now() / 300_000);
  for (const { repository_id: id } of repositories) {
    if (budget <= 0) break;
    await step(async () => { const result = await autoLand(env, id, { limit: budget, rotate, withArtifact }); budget -= result.evaluated; });
  }
  return { processed };
}
