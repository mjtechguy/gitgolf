import { digest, uuidOK, Fault, deny, invalid, reply } from './common.mjs';
import { aiAllocation, aiDailyLimit, aiLimits, aiRun, aiUsage } from './ai.mjs';
import { featureOff } from './feature-policy.mjs';
import { reviewDraft } from './ai-review.mjs';

// One entry per kind; each AI track adds one line here. A kind is
// { feature (a feature-policy id, such as 'advice'), model, roles, target(value, row) → bounded JSON target or invalid(),
//   prepare({ db, env, person, row, artifact, target }) → JSON input (in the workspace write queue: authority and exact bounded input only),
//   infer({ env, input, model, run }) → JSON output (in the Workflow; `run(input, options)` makes the one gateway call),
//   stale?({ db, env, person, row, artifact, target, input }) → boolean on status reads }.
export const aiKinds = {
  'review-draft': reviewDraft,
};

const time = () => new Date().toISOString();
const bytes = value => new TextEncoder().encode(value).length;
const refusals = { unclaimed: 'Inference never started; nothing was billed.', access: 'Your repository access changed before the run started; nothing was billed.',
  expired: 'The run expired before inference; nothing was billed.', input: 'The input for this run exceeds its limit; nothing was billed.',
  start: 'The AI workflow could not be started; nothing was billed.', kind: 'This kind of AI run is no longer offered; nothing was billed.' };

// AI gating hook, asked at admission, at prepare and again at infer; '' allows, anything else is the reason it is refused.
// Each caller passes the env with the installation policy in force at that moment: the editable `advice` key overlays EVIDENCE_ALLOW_AI,
// so turning AI advice off refuses every kind. Then the kind's feature policy for this repository (installation, organization, repository).
export async function aiGate(db, env, kind, repositoryId) {
  if (!aiAllocation(env) || !kind) return 'Workers AI is not enabled on this installation.';
  return (await featureOff(db, env, repositoryId, kind.feature))?.reason || '';
}
const unbilled = reason => reason.replace(/\.$/, '') + '; nothing was billed.';

function view(run) {
  return { id: run.id, kind: run.kind, idempotencyKey: run.operation_key, state: run.state, target: JSON.parse(run.target), model: run.model,
    ...(run.state === 'SUCCEEDED' ? { output: JSON.parse(run.output), usage: JSON.parse(run.usage || '{}') } : {}),
    ...(run.refusal ? { refusal: run.refusal } : {}), inputSha256: run.snapshot_hash || '',
    createdAt: run.created_at, updatedAt: run.updated_at, expiresAt: run.expires_at, advisoryOnly: true };
}

// Runs that never reserved were never billed; a reservation without a settle has an unknown outcome. Snapshots go after 7 days; hashes stay.
export async function reconcileAi(db) {
  const now = time();
  const refused = await db.prepare("UPDATE ai_runs SET state='REFUSED',refusal=?,updated_at=? WHERE state='REQUESTED' AND expires_at<=?").bind(refusals.expired, now, now).run();
  const unknown = await db.prepare("UPDATE ai_runs SET state=CASE WHEN infer_started_at IS NULL THEN 'REFUSED' ELSE 'UNKNOWN' END,refusal=CASE WHEN infer_started_at IS NULL THEN ? ELSE NULL END,output=NULL,updated_at=? WHERE state='RESERVED' AND expires_at<=?").bind(refusals.expired, now, now).run();
  const purged = await db.prepare('UPDATE ai_runs SET input_snapshot=NULL WHERE input_snapshot IS NOT NULL AND created_at<=?').bind(new Date(Date.now() - aiLimits.snapshotDays * 86400_000).toISOString()).run();
  return { expired: refused.meta.changes + unknown.meta.changes, purged: purged.meta.changes };
}

// `/native/ai` (create) and `/native/ai/read` (status, list). A run belongs to the person who asked for it.
export async function aiAPI(db, env, person, row, artifact, body) {
  if (body.action === 'create') {
    const kind = Object.hasOwn(aiKinds, body.kind) ? aiKinds[body.kind] : null;
    if (!kind) invalid('Use an offered AI kind.');
    if (!kind.roles.includes(row.role)) deny();
    if (!uuidOK(body.idempotencyKey)) invalid('Use a UUID v4 operation key.');
    const target = JSON.stringify(kind.target(body.target, row)), hash = await digest(JSON.stringify([body.kind, target]));
    if (bytes(target) > 4096) invalid('The AI target exceeds its limit.');
    let run = await db.prepare('SELECT * FROM ai_runs WHERE user_id=? AND operation_key=?').bind(person.id, body.idempotencyKey).first();
    if (run && (run.repository_id !== row.id || run.input_hash !== hash)) throw new Fault('already_exists', 409, 'Operation key belongs to different inputs.');
    if (run) return reply({ run: view(run) });
    const gate = await aiGate(db, env, kind, row.id);
    if (gate) throw new Fault('failed_precondition', 412, gate);
    await reconcileAi(db);
    const day = await db.prepare('SELECT count(*) AS total FROM ai_runs WHERE created_at>=?').bind(time().slice(0, 10)).first();
    if (day.total >= aiDailyLimit(env)) throw new Fault('resource_exhausted', 429, "The installation's daily AI allocation is used.");
    const hour = await db.prepare('SELECT count(*) AS total FROM ai_runs WHERE user_id=? AND created_at>=?').bind(person.id, new Date(Date.now() - 3600_000).toISOString()).first();
    if (hour.total >= aiLimits.hourlyPerUser) throw new Fault('resource_exhausted', 429, `You can start ${aiLimits.hourlyPerUser} AI runs an hour.`);
    run = await db.prepare(`INSERT INTO ai_runs(id,kind,repository_id,user_id,operation_key,input_hash,target,model,state,created_at,updated_at,expires_at)
      VALUES(?,?,?,?,?,?,?,?,'REQUESTED',?,?,?) RETURNING *`).bind(crypto.randomUUID(), body.kind, row.id, person.id, body.idempotencyKey, hash, target, kind.model,
      time(), time(), new Date(Date.now() + aiLimits.runMinutes * 60_000).toISOString()).first();
    try { await env.AiWorkflow.create({ id: run.id, params: { runId: run.id } }); }
    catch {
      // A lost create response is reconciled by exact instance ID, never restarted. Prepare refuses any run that is no longer REQUESTED.
      try { await (await env.AiWorkflow.get(run.id)).status(); }
      catch { run = await db.prepare("UPDATE ai_runs SET state='REFUSED',refusal=?,updated_at=? WHERE id=? AND state='REQUESTED' RETURNING *").bind(refusals.start, time(), run.id).first() || run; }
    }
    return reply({ run: view(run) });
  }
  if (body.action === 'list') {
    if (body.kind !== undefined && !Object.hasOwn(aiKinds, body.kind) || body.target !== undefined && body.kind === undefined) invalid('Filter by an offered AI kind, and by a target only within a kind.');
    const kind = body.kind ?? null, target = body.target === undefined ? null : JSON.stringify(aiKinds[kind].target(body.target, row));
    const { results } = await db.prepare(`SELECT * FROM ai_runs WHERE repository_id=? AND user_id=? AND (? IS NULL OR kind=?) AND (? IS NULL OR target=?)
      ORDER BY created_at DESC,id DESC LIMIT 51`).bind(row.id, person.id, kind, kind, target, target).all();
    // Stored rows only: no repository read, so no current or out-of-date claim.
    return reply({ runs: results.slice(0, 50).map(view), truncated: results.length > 50 });
  }
  if (body.action !== 'status' || !uuidOK(body.runId)) invalid('Use create, status or list with a canonical run ID.');
  const run = await db.prepare('SELECT * FROM ai_runs WHERE id=? AND repository_id=? AND user_id=?').bind(body.runId, row.id, person.id).first();
  if (!run) deny();
  // Only kinds that define `stale` compare a succeeded run with the current source; the others make no claim.
  const kind = aiKinds[run.kind], stale = run.state === 'SUCCEEDED' && kind?.stale && run.input_snapshot
    ? Boolean(await kind.stale({ db, env, person, row, artifact, target: JSON.parse(run.target), input: JSON.parse(run.input_snapshot) })) : undefined;
  return reply({ run: { ...view(run), ...(stale === undefined ? {} : { stale }) } });
}

// Workspace write queue: prepare (authority, exact bounded input, reservation) and settle (publish the outcome, conditional on the reservation).
export async function aiStep(db, env, run, context, phase, result) {
  if (!run) return { state: 'ABSENT' };
  const refuse = async (reason, from = 'REQUESTED') => {
    await db.prepare("UPDATE ai_runs SET state='REFUSED',refusal=?,updated_at=? WHERE id=? AND state=?").bind(reason, time(), run.id, from).run();
    return { id: run.id, state: (await db.prepare('SELECT state FROM ai_runs WHERE id=?').bind(run.id).first()).state };
  };
  if (phase === 'prepare') {
    if (run.state !== 'REQUESTED') return { id: run.id, state: run.state };
    const kind = Object.hasOwn(aiKinds, run.kind) ? aiKinds[run.kind] : null;
    if (!kind) return refuse(refusals.kind);
    if (run.expires_at <= time()) return refuse(refusals.expired);
    if (!context || !kind.roles.includes(context.row.role)) return refuse(refusals.access);
    const gate = await aiGate(db, env, kind, run.repository_id);
    if (gate) return refuse(unbilled(gate));
    let input;
    try { input = JSON.stringify(await kind.prepare({ db, env, ...context, target: JSON.parse(run.target) })); }
    catch (error) { if (error instanceof Fault) return refuse(error.message.slice(0, 300)); throw error; }
    if (typeof input !== 'string' || bytes(input) > aiLimits.inputBytes) return refuse(refusals.input);
    await db.prepare("UPDATE ai_runs SET state='RESERVED',input_snapshot=?,snapshot_hash=?,updated_at=? WHERE id=? AND state='REQUESTED'").bind(input, await digest(input), time(), run.id).run();
    return { id: run.id, state: (await db.prepare('SELECT state FROM ai_runs WHERE id=?').bind(run.id).first()).state };
  }
  if (phase !== 'settle') throw Error('Invalid AI phase');
  // A reservation never claimed by inference was never billed; once claimed, only a stored answer settles as success.
  const reason = result?.state === 'REFUSED' && typeof result.refusal === 'string' && result.refusal.endsWith('nothing was billed.') ? result.refusal.slice(0, 400) : '';
  if (run.state === 'REQUESTED') return refuse(reason || refusals.start);
  if (run.state !== 'RESERVED') return { id: run.id, state: run.state };
  if (!run.infer_started_at) return refuse(reason || refusals.unclaimed, 'RESERVED');
  const state = result?.state === 'INFERRED' && run.output !== null ? 'SUCCEEDED' : 'UNKNOWN';
  await db.prepare(`UPDATE ai_runs SET state=?,output=CASE WHEN ?='SUCCEEDED' THEN output ELSE NULL END,updated_at=? WHERE id=? AND state='RESERVED'`).bind(state, state, time(), run.id).run();
  return { id: run.id, state: (await db.prepare('SELECT state FROM ai_runs WHERE id=?').bind(run.id).first()).state };
}

// Workflow step, outside the workspace: one claimed gateway call, its answer stored only while the reservation stands.
export async function aiInfer(env, id) {
  const db = env.DB.withSession('first-primary');
  const run = await db.prepare('SELECT * FROM ai_runs WHERE id=?').bind(id).first();
  if (run?.state !== 'RESERVED') return { state: run?.state || 'ABSENT' };
  const kind = Object.hasOwn(aiKinds, run.kind) ? aiKinds[run.kind] : null;
  if (!kind) return { state: 'REFUSED', refusal: refusals.kind };
  const gate = await aiGate(db, env, kind, run.repository_id);
  if (gate) return { state: 'REFUSED', refusal: unbilled(gate) };
  if (run.expires_at <= time()) return { state: 'REFUSED', refusal: refusals.expired };
  const claimed = await db.prepare('UPDATE ai_runs SET infer_started_at=? WHERE id=? AND state=? AND infer_started_at IS NULL').bind(time(), id, 'RESERVED').run();
  // A retried or replayed step never bills a second call.
  if (claimed.meta.changes !== 1) return { state: 'UNKNOWN' };
  let calls = 0, usage = {};
  try {
    const output = JSON.stringify(await kind.infer({ env, input: JSON.parse(run.input_snapshot), model: run.model,
      run: async (input, options) => { if (calls++) throw Error('One model call per run'); const answer = await aiRun(env, run.model, input, options); usage = aiUsage(answer); return answer; } }));
    if (typeof output !== 'string' || bytes(output) > aiLimits.outputBytes) throw Error('AI output exceeds its limit');
    const stored = await db.prepare("UPDATE ai_runs SET output=?,usage=?,updated_at=? WHERE id=? AND state='RESERVED'").bind(output, JSON.stringify(usage), time(), id).run();
    return { state: stored.meta.changes === 1 ? 'INFERRED' : 'UNKNOWN' };
  } catch { return { state: 'UNKNOWN' }; }
}

// prepare (workspace, 45 s) → infer (this Workflow, no retries, 150 s) → settle (workspace, two retries). Repository text stays in D1, not in Workflow state.
// `effective(env)` reads the installation policy at infer time; the workspace applies it itself for prepare and settle.
export async function runAiWorkflow(event, step, env, owner, effective = async value => value) {
  if (event.payload?.runId !== event.instanceId || !uuidOK(event.instanceId)) throw Error('AI workflow identity mismatch');
  const id = event.instanceId, settle = result => step.do('settle', { retries: { limit: 2, delay: '1 second' }, timeout: '45 seconds' }, () => owner.ai(id, 'settle', result));
  let inferred;
  try {
    const prepared = await step.do('prepare', { retries: { limit: 2, delay: '1 second' }, timeout: '45 seconds' }, () => owner.ai(id, 'prepare'));
    if (prepared.state !== 'RESERVED') return prepared;
    inferred = await step.do('infer', { retries: { limit: 0, delay: '1 second' }, timeout: '150 seconds' }, async () => aiInfer(await effective(env), id));
  } catch { inferred = { state: 'UNKNOWN' }; }
  return settle(inferred);
}
