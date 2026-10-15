// Agentic mode (docs/AGENTIC_MODE.md, docs/AGENTIC_MODE_PLAN.md AM-4): the per-repository setting, the record of how each pull
// request was opened, and the landing evaluation of an open pull request. The decision itself is land-policy.mjs, a pure function;
// this module gathers its inputs (changed paths, checks, reviews, author kind, draft, merge observation) from D1 and the repository.
// Evaluation never lands anything: it reports what the policy would decide now.
import { Fault, deny, invalid, uuidOK } from './common.mjs';
import { repositoryFeatures, requireFeature } from './feature-policy.mjs';
import { settingsAuthority } from './repository-settings.mjs';
import { branchLockObservation } from './repository-rules.mjs';
import { mergeBlocker } from './pull-merge.mjs';
import { comparison } from './repository-diff.mjs';
import { changedPaths } from './tree-merge.mjs';
import { inventory } from './collaboration.mjs';
import { defaultAgenticSettings, evaluateLanding, globError, limits, onlyApprovalNeeded } from './land-policy.mjs';

const refuse = message => { throw new Fault('failed_precondition', 412, message); };
const forbidden = message => { throw new Fault('permission_denied', 403, message); };
const parse = (value, fallback) => { try { const parsed = JSON.parse(value); return Array.isArray(parsed) ? parsed.filter(item => typeof item === 'string') : fallback; } catch { return fallback; } };

// The schema 41 tables; an installation that has not migrated says so instead of failing a query.
let migrated = false;
export async function agenticSchema(db) {
  if (!migrated) { try { migrated = Boolean((await db.prepare('PRAGMA table_info(repository_agentic_settings)').all()).results.length); } catch { migrated = false; } }
  return migrated;
}
// Landing (land-queue.mjs, schema 42): POST /native/land and /native/land/read, policy landing and automatic reverts.
export async function landingCapability(db) {
  let ready = false;
  try { ready = Boolean((await db.prepare('PRAGMA table_info(land_operations)').all()).results.length); } catch { ready = false; }
  return { id: 'repository.agentic-landing', label: 'Agentic landing', state: ready ? 'CAPABILITY_STATE_READY' : 'CAPABILITY_STATE_DISABLED',
    reason: ready ? 'Writers land pull requests the agentic mode policy allows (POST /native/land) onto the current base without a global lock; low-risk changes land on their own when the repository allows it, and a policy landing whose required checks fail on the base branch is reverted.'
      : 'Apply the schema 42 migration to land pull requests through agentic mode.' };
}
export async function agenticCapability(db) {
  const ready = await agenticSchema(db);
  return { id: 'repository.agentic-mode', label: 'Agentic mode', state: ready ? 'CAPABILITY_STATE_READY' : 'CAPABILITY_STATE_DISABLED',
    reason: ready ? 'Repository administrators can turn on agentic mode: low-risk and sensitive path patterns, required checks and whether low-risk changes may land without a person. Pull requests show what the landing policy would decide. At schema 42 writers can land a pull request the policy allows, low-risk changes can land on their own, and a policy landing whose required checks fail on the base branch is reverted.'
      : 'Apply the schema 41 migration to use agentic mode.' };
}

// How a pull request was opened, recorded in the CreatePullRequest batch. null before schema 41 (nothing is recorded then).
// An agentTaskId must name a finished (SUCCEEDED) agent task of this repository whose proposal branch is the head branch.
export async function pullOrigin(db, person, row, body) {
  if (!await agenticSchema(db)) return null;
  // A running agent task's own token (MCP open_pull_request): the task is the origin, and only its branch may be the head.
  if (person.agent_task_id) {
    if (body.headBranch !== person.agent_task?.branch) refuse('An agent task opens pull requests only from its own branch.');
    return { kind: 'agent-task', apiTokenId: null, agentTaskId: person.agent_task_id };
  }
  let agentTaskId = null;
  if (body.agentTaskId !== undefined && body.agentTaskId !== '') {
    if (!uuidOK(body.agentTaskId)) invalid('Name the agent task by its ID.');
    const task = await db.prepare('SELECT id,state,branch FROM agent_tasks WHERE id=? AND repository_id=? AND artifact_name=?').bind(body.agentTaskId, row.id, row.artifact_name).first();
    if (!task || task.state !== 'SUCCEEDED' || task.branch !== body.headBranch) refuse('The agent task is not a finished task of this repository whose proposal branch is the head branch.');
    agentTaskId = task.id;
  }
  const apiTokenId = Number.isSafeInteger(person.api_token_id) ? person.api_token_id : null;
  return { kind: agentTaskId ? 'agent-task' : apiTokenId ? 'api-token' : 'person', apiTokenId, agentTaskId };
}

function wire(stored, login) {
  if (!stored) return { ...defaultAgenticSettings, lowRiskPaths: [...defaultAgenticSettings.lowRiskPaths], sensitivePaths: [...defaultAgenticSettings.sensitivePaths], requiredChecks: [], version: 0, updatedBy: '', updatedAt: '' };
  return { enabled: stored.enabled === 1, lowRiskPaths: parse(stored.low_risk_paths, [...defaultAgenticSettings.lowRiskPaths]), sensitivePaths: parse(stored.sensitive_paths, [...defaultAgenticSettings.sensitivePaths]),
    landWithoutPerson: stored.land_without_person === 1, requiredChecks: parse(stored.required_checks, []), revertOnFailure: stored.revert_on_failure === 1,
    version: stored.version, updatedBy: login || '', updatedAt: stored.updated_at };
}
export async function agenticSettings(db, row) { return current(db, row); }
export async function agenticFeature(db, env, row) { return featureState(db, env, row); }
export async function current(db, row) {
  const stored = await db.prepare('SELECT s.*,u.login FROM repository_agentic_settings s LEFT JOIN users u ON u.id=s.updated_by WHERE s.repository_id=?').bind(row.id).first();
  return wire(stored, stored?.login);
}
export async function featureState(db, env, row) {
  const feature = (await repositoryFeatures(db, env, row)).get('agentic-mode');
  return { allowed: Boolean(feature?.effective), reason: feature?.reason || '', decidedBy: feature?.decidedBy || '' };
}

function patterns(value, what) {
  if (!Array.isArray(value) || value.length > limits.patterns) invalid(`List at most ${limits.patterns} ${what}.`);
  for (const pattern of value) { const error = globError(pattern); if (error) invalid(`${what[0].toUpperCase() + what.slice(1)}: ${typeof pattern === 'string' ? pattern.slice(0, 60) + ' — ' : ''}${error}`); }
  if (new Set(value).size !== value.length) invalid(`List each of the ${what} once.`);
  return value;
}
function checkNames(value) {
  if (!Array.isArray(value) || value.length > limits.checks) invalid(`List at most ${limits.checks} required checks.`);
  if (value.some(name => typeof name !== 'string' || !name || name.trim() !== name || name.length > limits.checkLength || /[\x00-\x1f\x7f]/.test(name))) invalid(`Name each required check in at most ${limits.checkLength} characters, without surrounding spaces.`);
  if (new Set(value).size !== value.length) invalid('List each required check once.');
  return value;
}
const fields = ['action', 'repository', 'repositoryId', 'expectedVersion', 'enabled', 'lowRiskPaths', 'sensitivePaths', 'landWithoutPerson', 'requiredChecks', 'revertOnFailure'];

// ---------- checks for the head commit: pipeline runs and their jobs, and reported checks ----------
const runStates = { QUEUED: 'pending', RUNNING: 'pending', WAITING: 'pending', SUCCESS: 'success', FAILURE: 'failure', CANCELLED: 'cancelled', SKIPPED: 'skipped', REFUSED: 'refused' };
const jobStates = { BLOCKED: 'pending', QUEUED: 'pending', RUNNING: 'pending', MANUAL: 'pending', APPROVAL: 'pending', SUCCESS: 'success', FAILURE: 'failure', CANCELLED: 'cancelled', SKIPPED: 'skipped' };
const reportedStates = { PENDING: 'pending', SUCCESS: 'success', FAILURE: 'failure', ERROR: 'error', WARNING: 'neutral', SKIPPED: 'skipped' };
export async function headChecks(db, row, commitId) {
  // The latest run of each workflow and event for the commit; a rerun updates its row in place (attempt).
  const { results: runs } = await db.prepare(`SELECT r.id,r.workflow_path,r.workflow_name,r.event,r.state,r.attempt FROM pipeline_runs r WHERE r.repository_id=? AND r.artifact_name=? AND r.commit_id=?
    AND r.id=(SELECT max(x.id) FROM pipeline_runs x WHERE x.repository_id=r.repository_id AND x.artifact_name=r.artifact_name AND x.commit_id=r.commit_id AND x.workflow_path=r.workflow_path AND x.event=r.event)
    ORDER BY r.id LIMIT 100`).bind(row.id, row.artifact_name, commitId).all();
  const names = new Map(runs.map(run => [run.id, run.workflow_name || run.workflow_path]));
  const { results: jobs } = runs.length ? await db.prepare(`SELECT j.run_id,j.name,j.state,j.allow_failure FROM pipeline_jobs j JOIN pipeline_runs r ON r.id=j.run_id AND j.attempt=r.attempt
    WHERE j.run_id IN (SELECT value FROM json_each(?)) ORDER BY j.id LIMIT 500`).bind(JSON.stringify(runs.map(run => run.id))).all() : { results: [] };
  const { results: reported } = await db.prepare(`SELECT c.context,c.state FROM reported_checks c WHERE c.repository_id=? AND c.commit_id=?
    AND c.id=(SELECT max(latest.id) FROM reported_checks latest WHERE latest.repository_id=c.repository_id AND latest.commit_id=c.commit_id AND latest.context=c.context) ORDER BY c.context LIMIT 100`).bind(row.id, commitId).all();
  return [
    ...runs.map(run => ({ name: names.get(run.id), kind: 'pipeline', state: runStates[run.state] || 'pending' })),
    ...jobs.map(job => ({ name: `${names.get(job.run_id)} / ${job.name}`, kind: 'job', state: job.state === 'FAILURE' && job.allow_failure ? 'neutral' : jobStates[job.state] || 'pending' })),
    ...reported.map(check => ({ name: check.context, kind: 'reported', state: reportedStates[check.state] || 'pending' })),
  ];
}

// The latest published, undismissed review of each reviewer that is not a comment. An approval counts only for the current head;
// a change request stays outstanding until that reviewer reviews again or it is dismissed. Reviews come only from people's own
// sign-ins: API tokens and agent hosts cannot reach CreatePullRequestReview, so no review is an agent's.
export async function currentReviews(db, row, d, headCommitId) {
  const { results } = await db.prepare(`SELECT r.id,r.author_id,r.state,r.head_commit,COALESCE(l.dismissed,0) AS dismissed,
    (SELECT g.role FROM grants g JOIN users u ON u.id=g.user_id WHERE g.repository_id=? AND g.user_id=r.author_id AND u.active=1) AS role
    FROM pull_reviews r LEFT JOIN pull_review_lifecycle l ON l.review_id=r.id LEFT JOIN pull_review_drafts a ON a.review_id=r.id
    WHERE r.pull_request_id=? AND (a.status IS NULL OR a.status='PUBLISHED') ORDER BY r.id LIMIT 1000`).bind(row.id, d.pull_id).all();
  const latest = new Map();
  for (const review of results) if (!review.dismissed && review.state !== 'COMMENT') latest.set(review.author_id, review);
  return [...latest.values()].filter(review => review.state !== 'APPROVED' || review.head_commit === headCommitId).map(review => ({
    state: review.state === 'REQUEST_CHANGES' ? 'CHANGES_REQUESTED' : review.state, reviewerIsWriter: ['write', 'admin'].includes(review.role),
    reviewerIsAuthor: review.author_id === d.author_id, reviewerIsAgent: false }));
}

// Exported for the agentic inbox (agent-inbox.mjs) too.
export async function evaluate(db, env, person, row, body, artifact, settings, feature) {
  const { d, ifMergeable, ...value } = await landingEvaluation(db, env, row, body.number, artifact, settings, feature);
  // Whether this caller may land it now (land-queue.mjs decides again when asked): a writer, with the policy saying land, or saying only
  // that a writer who is not the author must approve and the caller is not the author.
  const result = value.evaluation;
  return { ...value, canLand: value.enabled && ['write', 'admin'].includes(row.role) && (result.decision === 'land' || onlyApprovalNeeded(result) && d.author_id !== person.id) };
}

// The evaluation of one open pull request now, with its discussion row (d) for callers that act on it (land-queue.mjs).
export async function landingEvaluation(db, env, row, number, artifact, settings, feature) {
  if (!Number.isSafeInteger(number) || number < 1) invalid('Choose a pull request by its number.');
  await requireFeature(db, env, row, 'pull-requests');
  const d = await db.prepare(`SELECT d.*,p.id AS pull_id,p.base_branch,p.head_branch,p.draft,
    (SELECT 1 FROM pull_merge_operations m WHERE m.pull_request_id=p.id AND m.phase='SUCCEEDED') AS merged
    FROM discussions d JOIN pull_requests p ON p.discussion_id=d.id WHERE d.repository_id=? AND d.number=? AND d.kind='pull'`).bind(row.id, number).first();
  if (!d) deny();
  if (d.state !== 'OPEN' || d.merged) refuse('Only open pull requests are evaluated for landing.');
  const observed = await artifact(async repo => {
    const refs = await inventory(env, row, repo), baseCommitId = refs.get('refs/heads/' + d.base_branch), headCommitId = refs.get('refs/heads/' + d.head_branch);
    if (!baseCommitId || !headCommitId) refuse('The base or head branch of this pull request no longer exists.');
    const { mergeBase } = await comparison(repo, baseCommitId, headCommitId);
    const [baseTree, headTree] = await Promise.all([mergeBase, headCommitId].map(async hash => { const commit = await repo.readCommit(hash); if (!commit) deny(); return commit.treeHash; }));
    const paths = await changedPaths(repo, baseTree, headTree);
    // The existing merge observation: what a native merge request would refuse now. A draft is reported by the policy itself.
    const current = { base: { commitId: baseCommitId, retainedSnapshot: false }, head: { commitId: headCommitId, retainedSnapshot: false } };
    // mergeBlocker plans the native merge (three-way for diverged branches) and names what would refuse it, with conflicting paths.
    const plan = await mergeBlocker(db, row, d, current, repo), blocker = plan.blocker, rule = await branchLockObservation(db, row, d.base_branch);
    const reason = blocker === 'pull_request_draft' ? '' : blocker || (rule.locked ? 'base_branch_locked' : '');
    return { baseCommitId, headCommitId, mergeBase, paths, mergeable: { ok: !reason, reason, ...(plan.conflicts ? { conflicts: plan.conflicts.slice(0, 50), conflictCount: plan.conflictCount } : {}) } };
  });
  const [checks, reviews, origin] = await Promise.all([headChecks(db, row, observed.headCommitId), currentReviews(db, row, d, observed.headCommitId),
    db.prepare('SELECT kind FROM pull_request_origins WHERE pull_request_id=?').bind(d.pull_id).first()]);
  const kind = origin?.kind || 'person', enabled = settings.enabled && feature.allowed;
  const inputs = { settings: { ...settings, enabled }, changedPaths: observed.paths, authorKind: kind === 'person' ? 'person' : 'agent', checks, reviews, draft: Boolean(d.draft) };
  const evaluation = evaluateLanding({ ...inputs, mergeable: observed.mergeable });
  if (settings.enabled && !feature.allowed) evaluation.reasons.push(feature.reason);
  // For land-queue.mjs: what the policy would decide without the conflict, so a conflicting change it would land is recorded as needing a rebase.
  const ifMergeable = observed.mergeable.reason === 'merge_conflict' ? evaluateLanding({ ...inputs, mergeable: { ok: true } }) : evaluation;
  return { d, ifMergeable, repositoryId: String(row.id), number: d.number, pullRequestId: String(d.pull_id), baseCommitId: observed.baseCommitId, headCommitId: observed.headCommitId, mergeBaseCommitId: observed.mergeBase,
    enabled, origin: kind, evaluation, changedPathCount: observed.paths.length, checks: checks.map(({ name, kind: source, state }) => ({ name, kind: source, state })), mergeable: observed.mergeable, evaluatedAt: new Date().toISOString() };
}

// POST /native/agentic-mode (set) and /native/agentic-mode/read (get, evaluate). A signed-in browser session only: bearer, service
// and API tokens never read or change the setting. row is the caller's authorized repository (public visitors are refused before).
export async function agenticModeAPI(db, env, person, row, request, body, artifact) {
  if (request.headers.has('Authorization') || request.headers.has('CF-Access-Client-Id') || request.headers.has('CF-Access-Client-Secret') || !request.headers.get('X-Golf-Native-Access-Email') || request.headers.get('Origin') !== env.PUBLIC_ORIGIN)
    forbidden('Use agentic mode from a signed-in browser session.');
  if (!await agenticSchema(db)) refuse('Agentic mode needs the schema 41 migration on this installation.');
  const [settings, feature] = await Promise.all([current(db, row), featureState(db, env, row)]);
  if (body.action === 'get') return { repositoryId: String(row.id), settings, feature, canEdit: row.role === 'admin', limits };
  if (body.action === 'evaluate') return evaluate(db, env, person, row, body, artifact, settings, feature);
  if (body.action !== 'set') invalid('Use get, set or evaluate.');
  if (Object.keys(body).some(key => !fields.includes(key)) || fields.some(key => body[key] === undefined)) invalid('Send every agentic mode field with the observed version.');
  if (row.role !== 'admin') forbidden('Only a current repository administrator changes agentic mode.');
  if (!Number.isSafeInteger(body.expectedVersion) || body.expectedVersion < 0) invalid('Send the observed version.');
  for (const key of ['enabled', 'landWithoutPerson', 'revertOnFailure']) if (typeof body[key] !== 'boolean') invalid(`Choose ${key} as true or false.`);
  const lowRiskPaths = patterns(body.lowRiskPaths, 'low-risk paths'), sensitivePaths = patterns(body.sensitivePaths, 'sensitive paths'), requiredChecks = checkNames(body.requiredChecks);
  if (body.enabled && !feature.allowed) refuse(feature.reason || 'Agentic mode is turned off for this repository by a policy.');
  if (body.expectedVersion !== settings.version) refuse('Agentic mode settings changed. Refresh before editing.');
  const authority = settingsAuthority(person, row), time = new Date().toISOString();
  const saved = await db.prepare(`INSERT INTO repository_agentic_settings(repository_id,enabled,low_risk_paths,sensitive_paths,land_without_person,required_checks,revert_on_failure,version,updated_by,updated_at)
    SELECT ?,?,?,?,?,?,?,?,?,? WHERE ${authority.sql} AND COALESCE((SELECT version FROM repository_agentic_settings WHERE repository_id=?),0)=?
    ON CONFLICT(repository_id) DO UPDATE SET enabled=excluded.enabled,low_risk_paths=excluded.low_risk_paths,sensitive_paths=excluded.sensitive_paths,land_without_person=excluded.land_without_person,
      required_checks=excluded.required_checks,revert_on_failure=excluded.revert_on_failure,version=excluded.version,updated_by=excluded.updated_by,updated_at=excluded.updated_at
    WHERE repository_agentic_settings.version=?`)
    .bind(row.id, Number(body.enabled), JSON.stringify(lowRiskPaths), JSON.stringify(sensitivePaths), Number(body.landWithoutPerson), JSON.stringify(requiredChecks), Number(body.revertOnFailure),
      body.expectedVersion + 1, person.id, time, ...authority.values, row.id, body.expectedVersion, body.expectedVersion).run();
  if (saved.meta.changes !== 1) refuse('Agentic mode settings or your repository access changed. Refresh before editing.');
  return { repositoryId: String(row.id), settings: await current(db, row), feature, canEdit: true, limits };
}
