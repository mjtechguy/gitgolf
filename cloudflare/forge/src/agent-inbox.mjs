// The agentic inbox (docs/AGENTIC_MODE.md "Inbox and intent summaries", docs/AGENTIC_MODE_PLAN.md AM-5). One read assembles what a
// repository's agents are doing and what needs a person: agent tasks in progress, open pull requests the landing policy would land or is
// waiting on, open pull requests that need a person or are blocked, and recent landings when the land queue (land_operations) exists.
// It evaluates a bounded page of open pull requests with agentic-mode.mjs `evaluate` (newest first) and says when it stopped early.
// The one write asks Workers AI for an intent summary of a pull request head through the ai-workflow.mjs runs (ai-intent.mjs).
import { Fault, invalid, uuidOK } from './common.mjs';
import { repositoryFeatures } from './feature-policy.mjs';
import { agenticSchema, current, evaluate, featureState } from './agentic-mode.mjs';
import { agentSchema } from './agent-hosts.mjs';
import { intentInFlight, intentLimits, intentSchema, intentView, storedIntent } from './ai-intent.mjs';
import { aiAllocation } from './ai.mjs';
import { aiGate, aiKinds, createAiRun } from './ai-workflow.mjs';
import { inventory } from './collaboration.mjs';
import { agentBranchPatterns } from './agent-branches.mjs';

export const inboxLimits = Object.freeze({ evaluate: 25, rows: 100, defaultRows: 50 });
const refuse = message => { throw new Fault('failed_precondition', 412, message); };
const forbidden = message => { throw new Fault('permission_denied', 403, message); };
const writer = row => ['write', 'admin'].includes(row.role);

// The land queue's table (AM-4 item 4, another migration). Read only when it exists with the columns this module selects; cached once found.
const landColumns = ['id', 'repository_id', 'pull_request_id', 'number', 'trigger', 'actor_id', 'state', 'method', 'head_commit_id', 'landed_commit_id', 'revert_commit_id', 'detail', 'created_at', 'updated_at'];
let landing = false;
export async function landingSchema(db) {
  if (!landing) {
    try { const names = new Set((await db.prepare('PRAGMA table_info(land_operations)').all()).results.map(column => column.name)); landing = landColumns.every(name => names.has(name)); }
    catch { landing = false; }
  }
  return landing;
}

export async function inboxCapability(db, env) {
  const ready = await agenticSchema(db) && await intentSchema(db);
  return { id: 'repository.agent-inbox', label: 'Agentic inbox', state: ready ? 'CAPABILITY_STATE_READY' : 'CAPABILITY_STATE_DISABLED',
    reason: !ready ? 'Apply the schema 43 migration to use the agentic inbox and intent summaries.'
      : `While agentic mode is on, the Agent workspace is an inbox: agent tasks in progress, open pull requests ready to land or needing a person (at most ${inboxLimits.evaluate} evaluated per read) and recent landings. ` +
        (aiAllocation(env) ? 'Writers can ask Workers AI for an intent summary of a pull request head; it is marked AI-written and never replaces the diff.' : 'Intent summaries need Workers AI, which this installation has not enabled.') };
}

function browserOnly(env, request) {
  if (request.headers.has('Authorization') || request.headers.has('CF-Access-Client-Id') || request.headers.has('CF-Access-Client-Secret') || !request.headers.get('X-Golf-Native-Access-Email') || request.headers.get('Origin') !== env.PUBLIC_ORIGIN)
    forbidden('Use the agentic inbox from a signed-in browser session.');
}

// Whether the caller may ask for intent summaries here, and if not, why.
async function summaries(db, env, row) {
  if (!await intentSchema(db)) return { available: false, reason: 'Intent summaries need the schema 43 migration on this installation.' };
  const gate = await aiGate(db, env, aiKinds['intent-summary'], row.id);
  if (gate) return { available: false, reason: gate };
  if (!writer(row)) return { available: false, reason: 'Asking for an intent summary needs write or admin access to this repository.' };
  return { available: true, reason: '' };
}

const task = value => ({ id: value.id, state: value.state, tool: value.tool, model: value.model, host: value.host_name || '', requestedBy: value.requester || '',
  target: { kind: value.target_kind, number: value.target_number, title: value.target_title || '' }, branch: value.branch, createdAt: value.created_at, startedAt: value.started_at || '' });
const parse = text => { try { const value = JSON.parse(text); return value && typeof value === 'object' && !Array.isArray(value) ? value : {}; } catch { return {}; } };
// The revert of a landing as the inbox shows it: who asked (a person or the automatic revert after failed checks), its state and why it
// did not apply. Never the request key.
function revertSummary(detail) {
  const revert = detail.revert;
  if (!revert || typeof revert !== 'object') return null;
  return { state: String(revert.state || ''), trigger: revert.trigger === 'person' ? 'person' : 'policy', actor: revert.trigger === 'person' ? String(revert.actor || '') : '',
    reason: typeof revert.reason === 'string' ? revert.reason.slice(0, 500) : '', conflicts: Array.isArray(revert.conflicts) ? revert.conflicts.slice(0, 20).map(c => String(c?.path || '')) : [] };
}
const landed = value => ({ id: String(value.id), pullRequestId: String(value.pull_request_id), number: value.number, title: value.title || '', trigger: value.trigger, actor: value.actor || '',
  state: value.state, method: value.method || '', headCommitId: value.head_commit_id || '', landedCommitId: value.landed_commit_id || '', revertCommitId: value.revert_commit_id || '',
  revert: revertSummary(parse(value.detail)), createdAt: value.created_at, updatedAt: value.updated_at });

async function inbox(db, env, row, body, artifact, person) {
  const limit = body.limit === undefined ? inboxLimits.defaultRows : body.limit;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > inboxLimits.rows) invalid(`Ask for 1 to ${inboxLimits.rows} rows.`);
  const [settings, feature, features, ai, landingReady] = await Promise.all([current(db, row), featureState(db, env, row), repositoryFeatures(db, env, row), summaries(db, env, row), landingSchema(db)]);
  const enabled = settings.enabled && feature.allowed, pullsOn = Boolean(features.get('pull-requests')?.effective);

  // In progress: this repository's agent tasks that have not finished (queued, claimed by a host or running).
  let tasks = [];
  if (await agentSchema(db)) tasks = (await db.prepare(`SELECT t.id,t.state,t.tool,t.model,t.target_kind,t.target_number,t.target_title,t.branch,t.created_at,t.started_at,h.name AS host_name,u.login AS requester
    FROM agent_tasks t LEFT JOIN agent_hosts h ON h.id=t.host_id LEFT JOIN users u ON u.id=t.requested_by
    WHERE t.repository_id=? AND t.artifact_name=? AND t.state IN ('QUEUED','CLAIMED','RUNNING') ORDER BY t.created_at DESC,t.id LIMIT ?`).bind(row.id, row.artifact_name, limit + 1).all()).results;

  // Open pull requests, newest first; at most `evaluate` of them are evaluated in this read.
  const page = Math.min(limit, inboxLimits.evaluate), readyToLand = [], needsPerson = [];
  let open = 0, evaluated = [], pulls = { state: 'evaluated', reason: '' };
  if (!enabled) pulls = { state: 'agentic_mode_off', reason: settings.enabled ? feature.reason : 'Agentic mode is off for this repository; pull requests are not evaluated.' };
  else if (!pullsOn) pulls = { state: 'pull_requests_off', reason: features.get('pull-requests')?.reason || 'Pull requests are turned off for this repository.' };
  else {
    const openSQL = `FROM discussions d JOIN pull_requests p ON p.discussion_id=d.id WHERE d.repository_id=? AND d.kind='pull' AND d.state='OPEN'
      AND NOT EXISTS(SELECT 1 FROM pull_merge_operations m WHERE m.pull_request_id=p.id AND m.phase='SUCCEEDED')`;
    open = (await db.prepare('SELECT count(*) AS total ' + openSQL).bind(row.id).first()).total;
    evaluated = (await db.prepare(`SELECT d.number,d.title,p.id AS pull_id,u.login AS author ${openSQL.replace('FROM discussions d', 'FROM discussions d LEFT JOIN users u ON u.id=d.author_id')} ORDER BY d.number DESC LIMIT ?`)
      .bind(row.id, page).all()).results;
  }
  if (evaluated.length) {
    const ids = JSON.stringify(evaluated.map(pull => pull.pull_id));
    const [stored, operations] = await Promise.all([
      await intentSchema(db) ? db.prepare('SELECT pull_request_id,head_commit_id,model,summary,created_at FROM pull_intent_summaries WHERE pull_request_id IN (SELECT value FROM json_each(?))').bind(ids).all().then(result => result.results) : [],
      // The latest land operation of each pull request, when the land queue exists.
      landingReady ? (async () => { try { return (await db.prepare(`SELECT o.pull_request_id,o.state,o.updated_at FROM land_operations o WHERE o.repository_id=? AND o.pull_request_id IN (SELECT value FROM json_each(?))
        AND o.id=(SELECT x.id FROM land_operations x WHERE x.pull_request_id=o.pull_request_id ORDER BY x.created_at DESC, x.id DESC LIMIT 1)`).bind(row.id, ids).all()).results; } catch { return []; } })() : [],
    ]);
    const intents = new Map(stored.map(summary => [`${summary.pull_request_id}:${summary.head_commit_id}`, summary]));
    const queue = new Map(operations.map(operation => [operation.pull_request_id, { state: operation.state, updatedAt: operation.updated_at }]));
    // One artifact handle for the page; each evaluation reads its own refs, merge base and changed paths.
    const results = await artifact(async repo => {
      const out = [];
      for (const pull of evaluated) {
        try { out.push({ pull, value: await evaluate(db, env, person, row, { number: pull.number }, action => action(repo), settings, feature) }); }
        catch (error) { if (!(error instanceof Fault)) throw error; out.push({ pull, error: error.message }); }
      }
      return out;
    });
    for (const { pull, value, error } of results) {
      const base = { number: pull.number, title: pull.title, author: pull.author || '', pullRequestId: String(pull.pull_id), landing: queue.get(pull.pull_id) || null };
      if (error) { needsPerson.push({ ...base, origin: '', headCommitId: '', baseCommitId: '', decision: 'unavailable', risk: '', reasons: [error], sensitivePaths: [], conflicts: [], changedPathCount: 0, checks: { passed: 0, pending: 0, failed: 0 }, intent: null, canLand: false }); continue; }
      const summary = intents.get(`${pull.pull_id}:${value.headCommitId}`), checks = { passed: 0, pending: 0, failed: 0 };
      for (const check of value.checks) checks[['success', 'neutral', 'skipped'].includes(check.state) ? 'passed' : check.state === 'pending' ? 'pending' : 'failed']++;
      const item = { ...base, origin: value.origin, headCommitId: value.headCommitId, baseCommitId: value.baseCommitId, decision: value.evaluation.decision, risk: value.evaluation.risk,
        reasons: value.evaluation.reasons, sensitivePaths: value.evaluation.matched.sensitive, conflicts: (value.mergeable.conflicts || []).map(({ path, reason }) => ({ path, reason })),
        mergeable: value.mergeable.ok, changedPathCount: value.changedPathCount, checks, intent: summary ? intentView(summary) : null,
        // Whether this caller may land it now through the land queue: the policy says land, or it asks only for a writer who is not the
        // author, which this caller's land request is (land-queue.mjs decides again).
        canLand: Boolean(landingReady && value.canLand) };
      (['land', 'waiting_checks'].includes(item.decision) ? readyToLand : needsPerson).push(item);
    }
  }

  // Landed: recent landings and reverts, when the land queue exists.
  let history = [], landingHistory = landingReady ? 'available' : 'unavailable';
  if (landingReady) {
    try {
      history = (await db.prepare(`SELECT o.id,o.pull_request_id,o.number,o.trigger,o.state,o.method,o.head_commit_id,o.landed_commit_id,o.revert_commit_id,o.detail,o.created_at,o.updated_at,d.title,u.login AS actor
        FROM land_operations o LEFT JOIN pull_requests p ON p.id=o.pull_request_id LEFT JOIN discussions d ON d.id=p.discussion_id LEFT JOIN users u ON u.id=o.actor_id
        WHERE o.repository_id=? AND o.state IN ('LANDED','REVERTED') ORDER BY o.updated_at DESC,o.id DESC LIMIT ?`).bind(row.id, limit + 1).all()).results;
    } catch { history = []; landingHistory = 'unavailable'; }
  }
  return { repositoryId: String(row.id), enabled, feature, generatedAt: new Date().toISOString(), limit,
    inProgress: tasks.slice(0, limit).map(task), readyToLand, needsPerson, landed: history.slice(0, limit).map(landed), landingHistory,
    pulls: { ...pulls, open, evaluated: evaluated.length, evaluateLimit: inboxLimits.evaluate },
    truncated: { inProgress: tasks.length > limit, pulls: open > evaluated.length, landed: history.length > limit },
    summaries: ai,
    // Writers land selected pull requests and revert landings through the land queue (POST /native/land), where it exists.
    actions: { land: Boolean(landingReady && enabled && writer(row)), revert: Boolean(landingReady && writer(row)),
      reason: !landingReady ? 'This installation has no land queue yet.' : !writer(row) ? 'Landing and reverting need write or admin access to this repository.' : !enabled ? 'Agentic mode is off for this repository.' : '' } };
}

// The branch list's agent branches (agent-branches.mjs): the patterns, and whether Golf deletes them after their pull request lands or closes.
async function branches(db, env, row) {
  const [settings, feature] = await Promise.all([current(db, row), featureState(db, env, row)]);
  return { repositoryId: String(row.id), defaultBranch: row.default_branch, patterns: await agentBranchPatterns(db, row), cleanup: Boolean(settings.enabled && feature.allowed) };
}

// The open pull request by number and its current base and head tips; refused when it is not open or a branch is gone.
async function openPull(db, env, row, number, artifact) {
  if (!Number.isSafeInteger(number) || number < 1) invalid('Choose a pull request by its number.');
  const d = await db.prepare(`SELECT d.number,d.state,p.id AS pull_id,p.base_branch,p.head_branch,p.head_commit,
    (SELECT 1 FROM pull_merge_operations m WHERE m.pull_request_id=p.id AND m.phase='SUCCEEDED') AS merged
    FROM discussions d JOIN pull_requests p ON p.discussion_id=d.id WHERE d.repository_id=? AND d.number=? AND d.kind='pull'`).bind(row.id, number).first();
  if (!d) throw new Fault('not_found', 404, 'Pull request not found.');
  if (d.state !== 'OPEN' || d.merged) refuse('Only open pull requests have intent summaries for their current head.');
  const tips = await artifact(async repo => { const refs = await inventory(env, row, repo); return { base: refs.get('refs/heads/' + d.base_branch), head: refs.get('refs/heads/' + d.head_branch) }; });
  if (!tips.base || !tips.head) refuse('The base or head branch of this pull request no longer exists.');
  return { number: d.number, pullRequestId: String(d.pull_id), baseCommitId: tips.base, headCommitId: tips.head };
}
const runView = run => run && { id: run.id, state: run.state, ...(run.refusal ? { refusal: run.refusal } : {}) };

// POST /native/agent-inbox/read (inbox, summary) and /native/agent-inbox (summarize). A signed-in browser session only; row is the
// caller's authorized repository (public visitors are refused before).
export async function agentInboxAPI(db, env, person, row, request, body, artifact) {
  browserOnly(env, request);
  if (!await agenticSchema(db)) refuse('The agentic inbox needs the schema 41 migration on this installation.');
  if (body.action === 'inbox') return inbox(db, env, row, body, artifact, person);
  if (body.action === 'branches') return branches(db, env, row);
  if (!await intentSchema(db)) refuse('Intent summaries need the schema 43 migration on this installation.');
  if (body.action === 'summary') {
    const pull = await openPull(db, env, row, body.number, artifact);
    const target = { number: pull.number, pullRequestId: pull.pullRequestId, baseCommitId: pull.baseCommitId, headCommitId: pull.headCommitId };
    const mine = await db.prepare("SELECT id,state,refusal FROM ai_runs WHERE kind='intent-summary' AND repository_id=? AND user_id=? AND json_extract(target,'$.pullRequestId')=? AND json_extract(target,'$.headCommitId')=? ORDER BY created_at DESC,id DESC LIMIT 1")
      .bind(row.id, person.id, pull.pullRequestId, pull.headCommitId).first();
    return { ...pull, summary: await storedIntent(db, pull.pullRequestId, pull.headCommitId), run: runView(mine), inFlight: Boolean(await intentInFlight(db, row.id, target)), summaries: await summaries(db, env, row) };
  }
  if (body.action !== 'summarize') invalid('Use inbox, summary or summarize.');
  if (!writer(row)) forbidden('Asking for an intent summary needs write or admin access to this repository.');
  if (!uuidOK(body.idempotencyKey)) invalid('Use a UUID v4 operation key.');
  const gate = await aiGate(db, env, aiKinds['intent-summary'], row.id);
  if (gate) refuse(gate);
  const pull = await openPull(db, env, row, body.number, artifact);
  const target = { number: pull.number, pullRequestId: pull.pullRequestId, baseCommitId: pull.baseCommitId, headCommitId: pull.headCommitId };
  // Regenerated only for a new head: a stored summary is returned as it is, and a run in flight is not doubled.
  const stored = await storedIntent(db, pull.pullRequestId, pull.headCommitId);
  if (stored) return { ...pull, state: 'STORED', summary: stored, run: null };
  const replay = await db.prepare("SELECT * FROM ai_runs WHERE user_id=? AND operation_key=? AND kind='intent-summary'").bind(person.id, body.idempotencyKey).first();
  const flight = !replay && await intentInFlight(db, row.id, target);
  if (flight) return { ...pull, state: 'RUNNING', summary: null, run: flight.user_id === person.id ? runView(flight) : null };
  const run = await createAiRun(db, env, person, row, { kind: 'intent-summary', idempotencyKey: body.idempotencyKey, target });
  return { ...pull, state: run.state === 'REFUSED' ? 'REFUSED' : run.state === 'SUCCEEDED' ? 'STORED' : 'RUNNING', summary: run.state === 'SUCCEEDED' ? await storedIntent(db, pull.pullRequestId, pull.headCommitId) : null,
    run: runView(run), limits: { diffBytes: intentLimits.diffBytes } };
}
