// Shared Actions/CI pipeline core (docs/NATIVE_ACTIONS_PIPELINES.md). Used by the Forgejo Runner protocol (RUN-B),
// the GitHub Actions intake (RUN-A) and GitLab CI (RUN-C). Every function re-reads D1; nothing is trusted from callers
// beyond the identities they pass. Refusals are Faults; anything else is an unconfirmed outcome.
import { digest, Fault, invalid } from './common.mjs';
import { repositoryFeatures } from './feature-policy.mjs';
import { openRepositoryValues } from './execution-values.mjs';
import { pipelinePolicy } from './pipeline-policy.mjs';
import { claimPlan, poolFull, claimFilter, claimSkipped, claimGuard, claimMissed, dailyRunGuard } from './capacity-shares.mjs';

export { pipelinePolicy };
export const pipelineEngines = ['forgejo-actions', 'gitlab-ci'];
const events = ['push', 'pull_request', 'workflow_dispatch', 'merge_request_event', 'web', 'schedule'];
const whens = ['on_success', 'on_failure', 'always', 'manual', 'conditional'];
const terminal = new Set(['SUCCESS', 'FAILURE', 'CANCELLED', 'SKIPPED']);
const now = () => new Date().toISOString();
const text = new TextEncoder();
const hex = bytes => Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
const random = (n = 32) => hex(crypto.getRandomValues(new Uint8Array(n)));
const b64url = value => btoa(typeof value === 'string' ? value : String.fromCharCode(...value)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const parse = (value, fallback) => { try { return JSON.parse(value) ?? fallback; } catch { return fallback; } };
const refuse = message => { throw new Fault('failed_precondition', 412, message); };
const denied = (message = 'Runner or job authority ended.') => { throw new Fault('permission_denied', 403, message); };
const labelName = label => String(label).split(':')[0];
export const logKey = (runId, jobId, seq) => `pipelines/${runId}/${jobId}/log/${String(seq).padStart(8, '0')}`;
export const artifactPrefix = (runId, artifactId) => `pipelines/${runId}/artifacts/${artifactId}/`;
const maxLogBytes = 64 * 1024 * 1024, maxChunkBytes = 4 * 1024 * 1024, tokenGrace = 10 * 60_000, lostAfter = 10 * 60_000, queueLimit = 24 * 3600_000;

const bucket = env => {
  if (!pipelinePolicy(env)) refuse('Actions pipelines are not allocated on this installation.');
  return env.PIPELINE_BUCKET;
};

// The `actions` feature as the repository sees it now: operator allocation, installation/organization policy and the repository switch.
export async function pipelineAllowed(db, env, repositoryId) {
  if (!pipelinePolicy(env)) return false;
  const feature = (await repositoryFeatures(db, env, Number(repositoryId))).get('actions');
  return Boolean(feature?.effective);
}
async function requireAllowed(db, env, repositoryId) {
  if (!pipelinePolicy(env)) refuse('Actions pipelines are not allocated on this installation.');
  const feature = (await repositoryFeatures(db, env, Number(repositoryId))).get('actions');
  if (!feature?.effective) refuse(feature?.reason || 'Actions are turned off for this repository.');
}

// ---------- runs and jobs ----------
function checkRun(run) {
  if (!run || !Number.isSafeInteger(Number(run.repositoryId)) || !pipelineEngines.includes(run.engine) || typeof run.workflowPath !== 'string' || !run.workflowPath || run.workflowPath.length > 256 ||
      typeof run.workflowName !== 'string' || run.workflowName.length > 256 || !events.includes(run.event) || typeof run.ref !== 'string' || !/^refs\/(heads|tags|pull)\/./.test(run.ref) ||
      !/^[a-f0-9]{40}$/.test(run.commitId || '') || !Number.isSafeInteger(Number(run.actorId)) || typeof run.trusted !== 'boolean')
    invalid('Invalid pipeline run identity.');
  const payload = JSON.stringify(run.eventPayload || {}), inputs = JSON.stringify(run.inputs || {});
  if (text.encode(payload).length > 32768 || text.encode(inputs).length > 16384) invalid('Pipeline event payload exceeds its bound.');
  return { payload, inputs };
}
function checkJobs(jobs) {
  if (!Array.isArray(jobs) || jobs.length < 1 || jobs.length > 256) invalid('A pipeline run needs 1 to 256 jobs.');
  const keys = new Set(jobs.map(job => job.key)), names = new Set();
  for (const job of jobs) {
    if (typeof job.key !== 'string' || !job.key || job.key.length > 255 || typeof job.name !== 'string' || !job.name || job.name.length > 255 || names.has(job.name) ||
        !Array.isArray(job.needs) || job.needs.some(need => !keys.has(need) || need === job.key) || !Array.isArray(job.runsOn) || job.runsOn.length > 16 ||
        job.runsOn.some(label => typeof label !== 'string' || !label || label.length > 128) || typeof job.payload !== 'string' || text.encode(job.payload).length > 256 * 1024 ||
        job.when !== undefined && !whens.includes(job.when) || job.timeoutSeconds !== undefined && !(Number.isInteger(job.timeoutSeconds) && job.timeoutSeconds >= 60 && job.timeoutSeconds <= 21600) ||
        job.retryMax !== undefined && !(Number.isInteger(job.retryMax) && job.retryMax >= 0 && job.retryMax <= 2) || job.environment !== undefined && job.environment !== null && !environmentOK(job.environment))
      invalid('Invalid pipeline job: ' + String(job?.name || job?.key || '').slice(0, 80));
    names.add(job.name);
  }
}
export const environmentActions = ['start', 'prepare', 'stop', 'verify', 'access'];
const environmentNameOK = name => typeof name === 'string' && /^[A-Za-z0-9 _./-]{1,255}$/.test(name) && name.trim() === name;
const environmentOK = e => e && typeof e === 'object' && environmentNameOK(e.name) && (e.url === undefined || typeof e.url === 'string' && e.url.length <= 2048) && (e.action === undefined || environmentActions.includes(e.action));
const environmentJSON = e => e ? JSON.stringify({ name: e.name, url: typeof e.url === 'string' && !e.url.includes('${{') ? e.url : '', action: e.action || 'start' }) : null;
const runColumns = 'repository_id,artifact_name,engine,number,workflow_path,workflow_name,workflow_blob,event,ref,commit_id,before_sha,pull_number,head_ref,base_ref,actor_id,trusted,inputs,event_payload,title,state,reason,attempt,concurrency_group,concurrency_cancel,intake_id,created_at,updated_at';
// guard: { sql, values } ANDed into the INSERT (the daily runner share); null is returned when it does not hold.
async function insertRun(db, run, state, reason, guard = null) {
  const { payload, inputs } = checkRun(run), time = now();
  const repository = await db.prepare("SELECT id,artifact_name FROM repositories WHERE id=? AND state='ACTIVE'").bind(Number(run.repositoryId)).first();
  if (!repository) refuse('Repository unavailable.');
  if (run.intakeId) {
    const existing = await db.prepare('SELECT id,number FROM pipeline_runs WHERE intake_id=? AND workflow_path=?').bind(run.intakeId, run.workflowPath).first();
    if (existing) return { runId: existing.id, number: existing.number, replayed: true };
  }
  const created = await db.prepare(`INSERT INTO pipeline_runs(${runColumns})
    SELECT ?,?,?,COALESCE((SELECT MAX(number) FROM pipeline_runs WHERE repository_id=? AND engine=?),0)+1,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,1,?,?,?,?,?${guard ? ' WHERE ' + guard.sql : ''} RETURNING id,number`)
    .bind(repository.id, repository.artifact_name, run.engine, repository.id, run.engine, run.workflowPath, run.workflowName || run.workflowPath, run.workflowBlob || '', run.event, run.ref, run.commitId,
      run.beforeSha || '', run.pullNumber ?? null, run.headRef || '', run.baseRef || '', Number(run.actorId), run.trusted ? 1 : 0, inputs, payload, String(run.title || '').slice(0, 512), state,
      String(reason || run.reason || '').slice(0, 2000), run.concurrency?.group ? String(run.concurrency.group).slice(0, 400) : null, run.concurrency?.cancelInProgress ? 1 : 0, run.intakeId || null, time, time, ...(guard?.values || [])).first();
  return created ? { runId: created.id, number: created.number, replayed: false } : null;
}

export async function createPipelineRun(db, env, run, jobs) {
  checkJobs(jobs);
  await requireAllowed(db, env, run?.repositoryId);
  // The daily runner share (capacity-shares.mjs) is a count in the run's own INSERT; a run over it is recorded refused, with the reason.
  const daily = await dailyRunGuard(db, env, Number(run.repositoryId));
  const created = await insertRun(db, run, 'QUEUED', undefined, daily);
  if (!created) return { ...await refusePipelineRun(db, env, run, await daily.reason()), replayed: false, refused: true, jobs: [] };
  if (created.replayed) {
    const { results } = await db.prepare('SELECT id,job_key AS key,name FROM pipeline_jobs WHERE run_id=? ORDER BY id').bind(created.runId).all();
    return { ...created, jobs: results };
  }
  const time = now();
  const statements = jobs.map(job => db.prepare(`INSERT INTO pipeline_jobs(run_id,attempt,engine,job_key,name,stage,stage_index,needs,runs_on,payload,state,when_mode,allow_failure,timeout_seconds,retry_max,environment,created_at,updated_at)
    VALUES(?,1,?,?,?,?,?,?,?,?,'BLOCKED',?,?,?,?,?,?,?)`).bind(created.runId, run.engine, job.key, job.name, job.stage || '', job.stageIndex || 0, JSON.stringify(job.needs), JSON.stringify(job.runsOn),
    job.payload, job.when || 'on_success', job.allowFailure ? 1 : 0, job.timeoutSeconds || 3600, job.retryMax || 0, environmentJSON(job.environment), time, time));
  try { await db.batch(statements); }
  catch (error) {
    await db.prepare("UPDATE pipeline_runs SET state='REFUSED',reason=?,updated_at=?,finished_at=? WHERE id=?").bind('The run could not record its jobs.', now(), now(), created.runId).run();
    throw error;
  }
  const { results } = await db.prepare('SELECT id,job_key AS key,name FROM pipeline_jobs WHERE run_id=? ORDER BY id').bind(created.runId).all();
  if (run.concurrency?.group) {
    // A new run in a group cancels earlier runs that have not started, and running ones with cancel-in-progress.
    const { results: others } = await db.prepare(`SELECT id FROM pipeline_runs WHERE repository_id=? AND concurrency_group=? AND id<? AND state IN ('QUEUED','RUNNING','WAITING')
      AND (started_at IS NULL OR ?=1) AND cancel_requested=0`).bind(Number(run.repositoryId), String(run.concurrency.group).slice(0, 400), created.runId, run.concurrency.cancelInProgress ? 1 : 0).all();
    for (const other of others) {
      await db.prepare('UPDATE pipeline_runs SET cancel_requested=1,reason=CASE WHEN reason=\'\' THEN ? ELSE reason END,updated_at=? WHERE id=?').bind(`Cancelled by run #${created.number} in concurrency group.`, now(), other.id).run();
      await advancePipelineRun(env, other.id);
    }
  }
  await advancePipelineRun(env, created.runId);
  return { ...created, jobs: results };
}

export async function refusePipelineRun(db, env, run, reason) {
  if (typeof reason !== 'string' || !reason) invalid('A refused run names its reason.');
  const created = await insertRun(db, run, 'REFUSED', reason);
  if (!created.replayed) await db.prepare('UPDATE pipeline_runs SET finished_at=? WHERE id=?').bind(now(), created.runId).run();
  return { runId: created.runId, number: created.number };
}

// ---------- runner identity ----------
const scopes = ['installation', 'organization', 'repository'];
function checkLabels(labels) {
  if (!Array.isArray(labels) || labels.length > 32 || labels.some(label => typeof label !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}(?::[\x21-\x7e]{1,200})?$/.test(label))) invalid('Labels are up to 32 names of letters, digits, dot, dash and underscore.');
  return labels;
}
export async function createRegistrationToken(db, env, person, { engine, scope, scopeId, labels = [], ttlHours = 1, uses = 1 }) {
  if (!pipelineEngines.includes(engine) || !scopes.includes(scope) || typeof scopeId !== 'string' || (scope === 'installation') !== (scopeId === '') ||
      !Number.isInteger(ttlHours) || ttlHours < 1 || ttlHours > 24 || !Number.isInteger(uses) || uses < 1 || uses > 100) invalid('Choose an engine, scope, 1–24 hour lifetime and 1–100 uses.');
  checkLabels(labels);
  const count = await db.prepare('SELECT COUNT(*) AS n FROM pipeline_registration_tokens WHERE revoked=0 AND expires_at>? AND uses_left>0').bind(Date.now()).first();
  if (count.n >= 50) refuse('Too many open registration tokens; revoke or let some expire.');
  const token = 'golfreg_' + random(), id = crypto.randomUUID(), time = now();
  await db.prepare('INSERT INTO pipeline_registration_tokens(id,engine,scope,scope_id,labels,token_digest,expires_at,uses_left,revoked,created_by,created_at) VALUES(?,?,?,?,?,?,?,?,0,?,?)')
    .bind(id, engine, scope, scopeId, JSON.stringify(labels), await digest(token), Date.now() + ttlHours * 3600_000, uses, person.id, time).run();
  return { token, row: await db.prepare('SELECT id,engine,scope,scope_id,labels,expires_at,uses_left,revoked,created_by,created_at FROM pipeline_registration_tokens WHERE id=?').bind(id).first() };
}

export async function registerPipelineRunner(db, env, { engine, registrationToken, name, labels, version = '', info = {}, ephemeral = false }) {
  if (!pipelinePolicy(env)) refuse('Actions pipelines are not allocated on this installation.');
  if (typeof registrationToken !== 'string' || !/^golfreg_[a-f0-9]{64}$/.test(registrationToken)) denied('Registration token invalid.');
  if (typeof name !== 'string' || !name.trim() || name.length > 128 || /[\x00-\x1f\x7f]/.test(name) || typeof version !== 'string' || version.length > 64) invalid('Name the runner (at most 128 characters).');
  const infoJSON = JSON.stringify(info || {});
  if (infoJSON.length > 4096) invalid('Runner information exceeds its bound.');
  const row = await db.prepare('SELECT * FROM pipeline_registration_tokens WHERE token_digest=?').bind(await digest(registrationToken)).first();
  if (!row || row.engine !== engine || row.revoked || row.expires_at <= Date.now() || row.uses_left < 1) denied('Registration token invalid, used or expired.');
  const chosen = checkLabels(labels?.length ? labels : parse(row.labels, []));
  const count = await db.prepare('SELECT COUNT(*) AS n FROM pipeline_runners WHERE deleted=0').first();
  if (count.n >= 200) refuse('Runner limit reached.');
  const uuid = crypto.randomUUID(), secret = random();
  const token = engine === 'gitlab-ci' ? `glrt-golf_${uuid.replaceAll('-', '')}_${secret}` : secret;
  const time = now();
  const results = await db.batch([
    db.prepare('UPDATE pipeline_registration_tokens SET uses_left=uses_left-1 WHERE id=? AND uses_left>0 AND revoked=0 AND expires_at>?').bind(row.id, Date.now()),
    db.prepare(`INSERT INTO pipeline_runners(uuid,engine,scope,scope_id,name,labels,token_digest,state,version,info,ephemeral,registration_id,created_by,created_at,last_seen_at)
      SELECT ?,?,?,?,?,?,?,'ACTIVE',?,?,?,?,?,?,? WHERE changes()=1`).bind(uuid, engine, row.scope, row.scope_id, name.trim(), JSON.stringify(chosen), await digest(token), version, infoJSON, ephemeral ? 1 : 0, row.id, row.created_by, time, time),
  ]);
  if (results[1].meta.changes !== 1) denied('Registration token invalid, used or expired.');
  return { runner: await db.prepare('SELECT * FROM pipeline_runners WHERE uuid=?').bind(uuid).first(), token };
}

export async function runnerByToken(db, env, engine, token, uuid) {
  if (!pipelinePolicy(env)) refuse('Actions pipelines are not allocated on this installation.');
  if (typeof token !== 'string' || token.length < 16 || token.length > 256) throw new Fault('unauthenticated', 401, 'Runner credential required.');
  const runner = await db.prepare('SELECT * FROM pipeline_runners WHERE token_digest=?').bind(await digest(token)).first();
  if (!runner || runner.engine !== engine || runner.deleted || uuid !== undefined && runner.uuid !== uuid) throw new Fault('unauthenticated', 401, 'Runner credential unknown.');
  if (runner.state !== 'ACTIVE') denied('This runner is disabled.');
  // Organization and repository runners lose authority with their scope.
  if (runner.scope === 'repository' && !await db.prepare("SELECT 1 AS ok FROM repositories WHERE id=? AND state='ACTIVE'").bind(Number(runner.scope_id)).first()) denied('The runner’s repository is unavailable.');
  if (runner.scope === 'organization' && !await db.prepare("SELECT 1 AS ok FROM native_owners WHERE id=? AND kind='ORGANIZATION'").bind(Number(runner.scope_id)).first()) denied('The runner’s organization is unavailable.');
  if (!runner.last_seen_at || Date.parse(runner.last_seen_at) < Date.now() - 30_000) {
    runner.last_seen_at = now();
    await db.prepare('UPDATE pipeline_runners SET last_seen_at=? WHERE id=?').bind(runner.last_seen_at, runner.id).run();
  }
  return runner;
}

// ---------- claims and job authority ----------
async function mintToken(job, run) {
  if (job.engine === 'gitlab-ci') return 'golfjob_' + random();
  // @actions/artifact reads the backend IDs from this claim without verifying it; Golf only stores the digest.
  const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const iat = Math.floor(Date.now() / 1000), exp = iat + job.timeout_seconds + tokenGrace / 1000;
  const payload = b64url(JSON.stringify({ scp: `Actions.Results:${run.id}:${job.id} Actions.UploadArtifacts:${run.id}:${job.id} Actions.GenericRead:${run.id}`, TaskID: job.id, RunID: run.id, JobID: job.id, ac: '[]', iat, nbf: iat, exp }));
  return header + '.' + payload + '.' + b64url(crypto.getRandomValues(new Uint8Array(32)));
}
function scopeClause(runner) {
  if (runner.scope === 'repository') return { sql: ' AND r.repository_id=?', values: [Number(runner.scope_id)] };
  if (runner.scope === 'organization') return { sql: ' AND r.repository_id IN (SELECT repository_id FROM repository_owners WHERE owner_id=?)', values: [Number(runner.scope_id)] };
  return { sql: '', values: [] };
}
async function claimed(db, job, run, token) {
  const repository = await db.prepare('SELECT r.*,o.slug AS owner_slug,o.kind AS owner_kind,o.id AS owner_id FROM repositories r LEFT JOIN repository_owners ro ON ro.repository_id=r.id LEFT JOIN native_owners o ON o.id=ro.owner_id WHERE r.id=?').bind(run.repository_id).first();
  return { job, run, repository, token, tokenExpiresAt: job.token_expires_at };
}
export async function claimPipelineJob(db, env, runner, { requestKey } = {}) {
  if (!runner || runner.state !== 'ACTIVE' || runner.deleted) denied();
  if (requestKey !== undefined && (typeof requestKey !== 'string' || !/^[A-Za-z0-9-]{8,64}$/.test(requestKey))) invalid('Invalid request key.');
  if (requestKey) {
    // A repeated request (lost response) returns the same job with a fresh token; the earlier token stops working.
    const job = await db.prepare("SELECT * FROM pipeline_jobs WHERE runner_id=? AND request_key=? AND state='RUNNING'").bind(runner.id, requestKey).first();
    if (job) {
      const run = await db.prepare('SELECT * FROM pipeline_runs WHERE id=?').bind(job.run_id).first(), token = await mintToken(job, run);
      const changed = await db.prepare("UPDATE pipeline_jobs SET token_digest=?,updated_at=? WHERE id=? AND runner_id=? AND state='RUNNING'").bind(await digest(token), now(), job.id, runner.id).run();
      if (changed.meta.changes === 1) return claimed(db, job, run, token);
    }
  }
  const labels = new Set(parse(runner.labels, []).map(labelName)), scope = scopeClause(runner);
  // Runner capacity (capacity-shares.mjs): a pool at its cap gets no job, exactly as an empty queue; repositories and organizations at
  // their running share are left out of the candidates, so the runner takes the next eligible job. Both are rechecked inside the UPDATE.
  const plan = await claimPlan(db, env, runner);
  if (await poolFull(db, plan)) return null;
  const allowed = new Map();
  // A share reached by a concurrent claim during this one is excluded on a second read, so the claim does not stop behind a page of its jobs.
  for (let pass = 0, again = true; again && pass < 3; pass++) {
    again = false;
    const filter = claimFilter(plan);
    const { results } = await db.prepare(`SELECT j.*,r.repository_id${filter.columns} FROM pipeline_jobs j JOIN pipeline_runs r ON r.id=j.run_id AND r.attempt=j.attempt
      WHERE j.engine=? AND j.state='QUEUED' AND r.cancel_requested=0 AND r.state IN ('QUEUED','RUNNING','WAITING')${scope.sql}${filter.sql} ORDER BY j.id LIMIT 50`).bind(runner.engine, ...scope.values, ...filter.values).all();
    for (const candidate of results) {
      if (!parse(candidate.runs_on, []).every(label => labels.has(labelName(label)))) continue;
      if (claimSkipped(plan, candidate)) continue;
      if (!allowed.has(candidate.repository_id)) allowed.set(candidate.repository_id, await pipelineAllowed(db, env, candidate.repository_id));
      if (!allowed.get(candidate.repository_id)) continue;
      const run = await db.prepare('SELECT * FROM pipeline_runs WHERE id=?').bind(candidate.run_id).first();
      const token = await mintToken(candidate, run), time = now(), expires = Date.now() + candidate.timeout_seconds * 1000 + tokenGrace, guard = await claimGuard(db, plan, candidate);
      const changed = await db.prepare(`UPDATE pipeline_jobs SET state='RUNNING',runner_id=?,request_key=?,token_digest=?,token_expires_at=?,started_at=?,updated_at=? WHERE id=? AND state='QUEUED'${guard.sql}`)
        .bind(runner.id, requestKey || null, await digest(token), expires, time, time, candidate.id, ...guard.values).run();
      if (changed.meta.changes !== 1) {
        const missed = guard.sql ? await claimMissed(db, plan, candidate) : null;
        if (missed === 'pool') return null;
        if (missed === 'share') again = true;
        continue;
      }
      await db.prepare("UPDATE pipeline_runs SET state='RUNNING',started_at=COALESCE(started_at,?),updated_at=? WHERE id=? AND state IN ('QUEUED','WAITING')").bind(time, time, run.id).run();
      if (runner.ephemeral) await db.prepare("UPDATE pipeline_runners SET state='DISABLED' WHERE id=?").bind(runner.id).run();
      const job = await db.prepare('SELECT * FROM pipeline_jobs WHERE id=?').bind(candidate.id).first();
      return claimed(db, job, { ...run, state: 'RUNNING' }, token);
    }
  }
  return null;
}

async function current(db, env, job) {
  const run = await db.prepare('SELECT * FROM pipeline_runs WHERE id=?').bind(job.run_id).first();
  const repository = run && await db.prepare("SELECT r.*,o.slug AS owner_slug,o.kind AS owner_kind,o.id AS owner_id FROM repositories r LEFT JOIN repository_owners ro ON ro.repository_id=r.id LEFT JOIN native_owners o ON o.id=ro.owner_id WHERE r.id=? AND r.state='ACTIVE'").bind(run.repository_id).first();
  if (!run || !repository || repository.artifact_name !== run.artifact_name) denied('The run’s repository changed.');
  if (!await pipelineAllowed(db, env, repository.id)) denied('Actions are turned off for this repository.');
  return { job, run, repository };
}
export async function jobByToken(db, env, token) {
  if (typeof token !== 'string' || token.length < 16 || token.length > 4096) throw new Fault('unauthenticated', 401, 'Job token required.');
  const job = await db.prepare('SELECT * FROM pipeline_jobs WHERE token_digest=?').bind(await digest(token)).first();
  if (job?.state === 'CANCELLED' && job.token_expires_at > Date.now()) throw new Fault('cancelled', 409, 'The job was cancelled.');
  if (!job || job.state !== 'RUNNING' || !(job.token_expires_at > Date.now())) throw new Fault('unauthenticated', 401, 'Job token expired or unknown.');
  return current(db, env, job);
}
export async function runnerJob(db, env, runner, jobId) {
  const job = await db.prepare('SELECT * FROM pipeline_jobs WHERE id=?').bind(Number(jobId)).first();
  if (!job || job.runner_id !== runner.id) denied('This runner does not hold that job.');
  return current(db, env, job);
}

// ---------- values and redaction ----------
const valueCache = new Map();
export async function pipelineValues(db, env, run, job) {
  const scoped = job?.environment ? await environmentValues(db, env, run, job) : null;
  const base = await repositoryValues(db, env, run);
  return scoped ? { secrets: { ...base.secrets, ...scoped.secrets }, variables: { ...base.variables, ...scoped.variables } } : base;
}
async function repositoryValues(db, env, run) {
  const key = run.id + ':' + run.attempt, cached = valueCache.get(key);
  if (cached && cached.at > Date.now() - 60_000) return cached.value;
  const repository = await db.prepare("SELECT id,artifact_name FROM repositories WHERE id=? AND state='ACTIVE'").bind(run.repository_id).first();
  let value = { secrets: {}, variables: {} };
  if (repository && repository.artifact_name === run.artifact_name) {
    const features = await repositoryFeatures(db, env, repository.id);
    if (features.get('secrets')?.effective) {
      const opened = await openRepositoryValues(db, env, repository);
      value = { secrets: run.trusted ? opened.secrets : {}, variables: opened.variables };
    }
  }
  if (valueCache.size > 200) valueCache.clear();
  valueCache.set(key, { at: Date.now(), value });
  return value;
}
function redactor(secrets) {
  const patterns = [...new Set(Object.values(secrets).flatMap(value => [value, ...value.split(/\r?\n/)]).filter(value => value.length >= 4))].sort((a, b) => b.length - a.length);
  return line => patterns.reduce((out, secret) => out.split(secret).join('***'), line);
}

// ---------- logs ----------
async function storeChunk(db, env, job, body, lines, bytes, expect) {
  const seq = job.log_chunks, time = now();
  await bucket(env).put(logKey(job.run_id, job.id, seq), body, { httpMetadata: { contentType: 'text/plain; charset=utf-8' } });
  const results = await db.batch([
    db.prepare('UPDATE pipeline_jobs SET log_lines=log_lines+?,log_bytes=log_bytes+?,log_chunks=log_chunks+1,updated_at=? WHERE id=? AND log_chunks=? AND log_lines=? AND log_bytes=?')
      .bind(lines, bytes, time, job.id, seq, expect.lines, expect.bytes),
    db.prepare('INSERT INTO pipeline_log_chunks(job_id,seq,first_line,lines,first_byte,bytes,created_at) SELECT ?,?,?,?,?,?,? WHERE changes()=1').bind(job.id, seq, expect.lines, lines, expect.bytes, bytes, time),
  ]);
  return results[0].meta.changes === 1;
}
export async function appendJobLogLines(db, env, job, index, lines) {
  const fresh = await db.prepare('SELECT * FROM pipeline_jobs WHERE id=?').bind(job.id).first();
  const ack = fresh.log_lines;
  if (!Number.isSafeInteger(index) || index < 0 || !Array.isArray(lines)) invalid('Invalid log rows.');
  if (!lines.length || index > ack || index + lines.length <= ack) return { ack };
  if (fresh.log_complete) return { ack };
  const run = await db.prepare('SELECT * FROM pipeline_runs WHERE id=?').bind(fresh.run_id).first();
  const redact = redactor((await pipelineValues(db, env, run, fresh)).secrets);
  const body = lines.slice(ack - index).map(line => redact(String(line).replace(/\r?\n$/, '')) + '\n').join(''), bytes = text.encode(body).length;
  if (bytes > maxChunkBytes || fresh.log_bytes + bytes > maxLogBytes) refuse('Job log exceeds the 64 MiB bound.');
  const count = lines.length - (ack - index);
  if (!await storeChunk(db, env, fresh, body, count, bytes, { lines: fresh.log_lines, bytes: fresh.log_bytes })) return { ack: (await db.prepare('SELECT log_lines FROM pipeline_jobs WHERE id=?').bind(job.id).first()).log_lines };
  return { ack: ack + count };
}
export async function appendJobLogBytes(db, env, job, offset, bytes) {
  const fresh = await db.prepare('SELECT * FROM pipeline_jobs WHERE id=?').bind(job.id).first();
  if (!Number.isSafeInteger(offset) || offset < 0 || !(bytes instanceof Uint8Array)) invalid('Invalid trace range.');
  if (offset !== fresh.log_bytes) throw Object.assign(new Fault('out_of_range', 416, 'Trace offset differs.'), { ack: fresh.log_bytes });
  if (!bytes.length) return { ack: fresh.log_bytes };
  if (bytes.length > maxChunkBytes || fresh.log_bytes + bytes.length > maxLogBytes) refuse('Job log exceeds the 64 MiB bound.');
  const run = await db.prepare('SELECT * FROM pipeline_runs WHERE id=?').bind(fresh.run_id).first();
  const secrets = (await pipelineValues(db, env, run, fresh)).secrets;
  let body = bytes;
  // Redaction keeps the stored byte count equal to the runner's offsets: each secret byte becomes '*'.
  if (Object.keys(secrets).length) {
    const decoded = new TextDecoder().decode(bytes), redact = redactor(secrets);
    const masked = text.encode(redact(decoded));
    body = masked.length === bytes.length ? masked : text.encode(decoded.replace(/[^\n]/g, c => c)).slice(0, bytes.length);
    if (masked.length !== bytes.length) {
      const stars = Uint8Array.from(bytes);
      for (const secret of Object.values(secrets).filter(value => value.length >= 4)) {
        const pattern = text.encode(secret);
        for (let i = 0; i + pattern.length <= stars.length; i++) if (pattern.every((b, k) => bytes[i + k] === b)) stars.fill(42, i, i + pattern.length);
      }
      body = stars;
    }
  }
  const newlines = body.reduce((n, b) => n + (b === 10), 0);
  if (!await storeChunk(db, env, fresh, body, newlines, body.length, { lines: fresh.log_lines, bytes: fresh.log_bytes }))
    throw Object.assign(new Fault('out_of_range', 416, 'Trace offset differs.'), { ack: (await db.prepare('SELECT log_bytes FROM pipeline_jobs WHERE id=?').bind(job.id).first()).log_bytes });
  return { ack: fresh.log_bytes + body.length };
}
export async function readJobLog(db, env, job, { fromLine = 0, fromByte, limit = 2 * 1024 * 1024 } = {}) {
  const fresh = await db.prepare('SELECT * FROM pipeline_jobs WHERE id=?').bind(job.id).first();
  const { results } = fromByte !== undefined
    ? await db.prepare('SELECT * FROM pipeline_log_chunks WHERE job_id=? AND first_byte+bytes>? ORDER BY seq LIMIT 256').bind(job.id, fromByte).all()
    : await db.prepare('SELECT * FROM pipeline_log_chunks WHERE job_id=? AND first_line+lines>? ORDER BY seq LIMIT 256').bind(job.id, fromLine).all();
  let out = '', nextLine = fromByte !== undefined ? 0 : fromLine, nextByte = fromByte ?? 0, total = 0;
  for (const chunk of results) {
    const object = await bucket(env).get(logKey(fresh.run_id, job.id, chunk.seq));
    if (!object) break;
    let data = new Uint8Array(await object.arrayBuffer());
    if (fromByte !== undefined) {
      data = data.subarray(Math.max(0, nextByte - chunk.first_byte));
      out += new TextDecoder().decode(data); nextByte = chunk.first_byte + chunk.bytes;
    } else {
      const lines = new TextDecoder().decode(data).split('\n'); lines.pop();
      out += lines.slice(Math.max(0, nextLine - chunk.first_line)).map(line => line + '\n').join('');
      nextLine = chunk.first_line + chunk.lines; nextByte = chunk.first_byte + chunk.bytes;
    }
    total += data.length;
    if (total >= limit) break;
  }
  const complete = Boolean(fresh.log_complete) && nextByte >= fresh.log_bytes;
  return { text: out, nextLine, nextByte, complete, totalLines: fresh.log_lines, totalBytes: fresh.log_bytes };
}
export async function completeJobLog(db, job) {
  await db.prepare('UPDATE pipeline_jobs SET log_complete=1,updated_at=? WHERE id=?').bind(now(), job.id).run();
}
const stepStates = ['PENDING', 'RUNNING', 'SUCCESS', 'FAILURE', 'CANCELLED', 'SKIPPED'];
export async function updateJobSteps(db, job, steps) {
  if (!Array.isArray(steps) || steps.length > 512) invalid('Invalid steps.');
  const statements = steps.map(step => {
    if (!Number.isInteger(step.number) || step.number < 0 || !stepStates.includes(step.state) || typeof step.name !== 'string') invalid('Invalid step.');
    return db.prepare(`INSERT INTO pipeline_steps(job_id,number,name,state,started_at,finished_at,log_index,log_length) VALUES(?,?,?,?,?,?,?,?)
      ON CONFLICT(job_id,number) DO UPDATE SET name=CASE WHEN excluded.name='' THEN pipeline_steps.name ELSE excluded.name END,state=excluded.state,started_at=excluded.started_at,finished_at=excluded.finished_at,log_index=excluded.log_index,log_length=excluded.log_length`)
      .bind(job.id, step.number, step.name.slice(0, 255), step.state, step.startedAt || null, step.finishedAt || null, step.logIndex || 0, step.logLength || 0);
  });
  if (statements.length) await db.batch(statements);
}

// ---------- completion and the run DAG ----------
const results = { success: 'SUCCESS', failure: 'FAILURE', cancelled: 'CANCELLED', skipped: 'SKIPPED' };
export async function finishPipelineJob(db, env, job, { result, exitCode = null, outputs = {}, failureReason = '', url }) {
  const state = results[result];
  if (!state || exitCode !== null && !Number.isInteger(exitCode) || !outputs || typeof outputs !== 'object' || typeof failureReason !== 'string') invalid('Invalid job result.');
  const outputJSON = JSON.stringify(outputs);
  if (text.encode(outputJSON).length > 65536) invalid('Job outputs exceed 64 KiB.');
  const fresh = await db.prepare('SELECT * FROM pipeline_jobs WHERE id=?').bind(job.id).first();
  if (fresh.state === state) return { state, replayed: true };
  if (fresh.state !== 'RUNNING') refuse('The job is no longer running.');
  const time = now();
  if (state === 'FAILURE' && fresh.retry_count < fresh.retry_max) {
    const { results: chunks } = await db.prepare('SELECT seq FROM pipeline_log_chunks WHERE job_id=?').bind(job.id).all();
    await db.batch([
      db.prepare("UPDATE pipeline_jobs SET state='QUEUED',retry_count=retry_count+1,runner_id=NULL,request_key=NULL,token_digest=NULL,token_expires_at=NULL,log_lines=0,log_bytes=0,log_chunks=0,log_complete=0,queued_at=?,started_at=NULL,updated_at=? WHERE id=? AND state='RUNNING'").bind(time, time, job.id),
      db.prepare('DELETE FROM pipeline_log_chunks WHERE job_id=?').bind(job.id),
      db.prepare('DELETE FROM pipeline_steps WHERE job_id=?').bind(job.id),
    ]);
    if (chunks.length) await env.PIPELINE_BUCKET.delete(chunks.map(chunk => logKey(fresh.run_id, job.id, chunk.seq)));
    return { state: 'QUEUED', retried: true };
  }
  const changed = await db.prepare("UPDATE pipeline_jobs SET state=?,exit_code=?,outputs=?,failure_reason=?,token_digest=NULL,token_expires_at=NULL,log_complete=1,finished_at=?,updated_at=? WHERE id=? AND state='RUNNING'")
    .bind(state, exitCode, outputJSON, failureReason.slice(0, 500), time, time, job.id).run();
  if (changed.meta.changes !== 1) refuse('The job changed; refresh.');
  await recordDeployment(db, fresh, state, url);
  await advancePipelineRun(env, fresh.run_id);
  return { state, replayed: false };
}

export async function advancePipelineRun(env, runId) {
  const coordinator = env.pipelineCoordinator;
  if (coordinator) return coordinator.get(coordinator.idFromName('run:' + runId)).advance(runId);
  return advanceRunNow(env, runId);
}

// Serialized per run by the PipelineRun Durable Object; safe to repeat. Returns the run state and the time of the next check.
export async function advanceRunNow(env, runId) {
  const db = env.DB.withSession('first-primary');
  const run = await db.prepare('SELECT * FROM pipeline_runs WHERE id=?').bind(runId).first();
  if (!run || ['SUCCESS', 'FAILURE', 'CANCELLED', 'SKIPPED', 'REFUSED'].includes(run.state)) return { state: run?.state || 'MISSING' };
  const { results: jobs } = await db.prepare('SELECT * FROM pipeline_jobs WHERE run_id=? AND attempt=? ORDER BY id').bind(runId, run.attempt).all();
  const time = now(), updates = [];
  const set = (job, state, reason = '') => { job.state = state; updates.push(db.prepare(`UPDATE pipeline_jobs SET state=?,failure_reason=CASE WHEN ?='' THEN failure_reason ELSE ? END,token_digest=CASE WHEN ? IN ('SUCCESS','FAILURE','SKIPPED') THEN NULL ELSE token_digest END,
    queued_at=CASE WHEN ?='QUEUED' THEN ? ELSE queued_at END,finished_at=CASE WHEN ? IN ('SUCCESS','FAILURE','CANCELLED','SKIPPED') THEN ? ELSE finished_at END,updated_at=? WHERE id=? AND state=?`)
    .bind(state, reason, reason, state, state, time, state, time, time, job.id, job.previous || job.state)); };
  for (const job of jobs) job.previous = job.state;
  const allowed = await pipelineAllowed(db, env, run.repository_id);
  if (run.cancel_requested || !allowed) {
    for (const job of jobs) if (['BLOCKED', 'QUEUED', 'MANUAL', 'APPROVAL'].includes(job.state)) set(job, 'CANCELLED', allowed ? '' : 'actions_disabled');
  } else {
    // Concurrency: an earlier unfinished run in the group holds the jobs of this one.
    const waiting = run.concurrency_group && await db.prepare("SELECT 1 AS busy FROM pipeline_runs WHERE repository_id=? AND concurrency_group=? AND id<? AND state IN ('QUEUED','RUNNING','WAITING') LIMIT 1").bind(run.repository_id, run.concurrency_group, run.id).first();
    for (const job of jobs) {
      if (job.state === 'RUNNING') {
        if (Date.parse(job.started_at) + job.timeout_seconds * 1000 < Date.now()) set(job, 'FAILURE', 'timeout');
        else if (Date.parse(job.updated_at) < Date.now() - lostAfter) set(job, 'FAILURE', 'runner_lost');
      } else if (job.state === 'QUEUED' && Date.parse(job.queued_at || job.created_at) < Date.now() - queueLimit) set(job, 'CANCELLED', 'no_runner');
    }
    const byKey = new Map();
    for (const job of jobs) (byKey.get(job.job_key) || byKey.set(job.job_key, []).get(job.job_key)).push(job);
    for (let changed = true; changed && !waiting;) {
      changed = false;
      for (const job of jobs) {
        if (job.state !== 'BLOCKED') continue;
        const predecessors = parse(job.needs, []).flatMap(key => byKey.get(key) || []);
        const done = p => terminal.has(p.state) || p.state === 'MANUAL' && p.allow_failure;
        if (!predecessors.every(done)) continue;
        const ok = p => p.state === 'SUCCESS' || p.state === 'FAILURE' && p.allow_failure || p.state === 'MANUAL' && p.allow_failure || p.state === 'SKIPPED' && p.engine === 'gitlab-ci';
        const failed = predecessors.some(p => !ok(p));
        const next = job.when_mode === 'always' || job.when_mode === 'conditional' ? 'QUEUED'
          : job.when_mode === 'on_failure' ? (failed ? 'QUEUED' : 'SKIPPED')
          : job.when_mode === 'manual' ? (failed ? 'SKIPPED' : 'MANUAL') : (failed ? 'SKIPPED' : 'QUEUED');
        if (next === 'QUEUED' && job.environment) {
          const gate = await environmentGate(db, run, job);
          if (gate.state !== 'QUEUED') { set(job, gate.state, gate.reason); changed = true; continue; }
        }
        set(job, next); changed = true;
      }
    }
  }
  if (updates.length) await db.batch(updates);
  const settled = job => terminal.has(job.state) || job.state === 'MANUAL' && job.allow_failure;
  let state = run.state, finished = null;
  if (jobs.every(settled)) {
    state = run.cancel_requested || jobs.some(job => job.state === 'CANCELLED' && job.failure_reason !== 'no_runner') && !jobs.some(job => job.state === 'FAILURE' && !job.allow_failure) ? 'CANCELLED'
      : jobs.some(job => (job.state === 'FAILURE' || job.state === 'CANCELLED') && !job.allow_failure) ? 'FAILURE'
      : jobs.length && jobs.every(job => job.state === 'SKIPPED') ? 'SKIPPED' : 'SUCCESS';
    finished = time;
  } else if (jobs.some(job => job.state === 'RUNNING')) state = 'RUNNING';
  else if (!jobs.some(job => job.state === 'QUEUED' || job.state === 'BLOCKED')) state = 'WAITING';
  else state = run.started_at ? 'RUNNING' : 'QUEUED';
  if (state !== run.state || finished) await db.prepare('UPDATE pipeline_runs SET state=?,finished_at=COALESCE(?,finished_at),updated_at=? WHERE id=?').bind(state, finished, time, runId).run();
  if (finished && run.concurrency_group) {
    const { results: next } = await db.prepare("SELECT id FROM pipeline_runs WHERE repository_id=? AND concurrency_group=? AND id>? AND state='QUEUED' ORDER BY id LIMIT 5").bind(run.repository_id, run.concurrency_group, run.id).all();
    for (const other of next) env.waitUntil ? env.waitUntil(advancePipelineRun(env, other.id)) : await advancePipelineRun(env, other.id);
  }
  if (env.notifyPipeline) env.notifyPipeline(run.repository_id);
  // Agentic mode (land-queue.mjs): a finished run can decide a landing or the checks of a landed change. Never awaited here.
  if (finished && env.pipelineFinished) env.pipelineFinished({ ...run, state });
  // Automations (automations.mjs, loaded on use): a failed run is the pipeline.failed event.
  if (finished && state === 'FAILURE') await import('./automations.mjs').then(module => module.automationEvent(env, { type: 'pipeline.failed', repositoryId: run.repository_id, runId: run.id, ref: run.ref, commit: run.commit_id })).catch(() => {});
  return { state, nextCheck: finished ? null : Date.now() + 60_000 };
}

export async function cancelPipelineRun(db, env, person, runId) {
  const run = await db.prepare('SELECT * FROM pipeline_runs WHERE id=?').bind(runId).first();
  if (!run) refuse('Run unavailable.');
  if (['SUCCESS', 'FAILURE', 'CANCELLED', 'SKIPPED', 'REFUSED'].includes(run.state)) refuse('The run already finished.');
  await db.prepare('UPDATE pipeline_runs SET cancel_requested=1,updated_at=? WHERE id=?').bind(now(), runId).run();
  // Running jobs learn of it on their next runner call; a runner that never calls is timed out by the coordinator.
  await db.prepare("UPDATE pipeline_jobs SET updated_at=? WHERE run_id=? AND state='RUNNING' AND updated_at<?").bind(new Date(Date.now() - lostAfter + 120_000).toISOString(), runId, new Date(Date.now() - lostAfter + 120_000).toISOString()).run();
  return advancePipelineRun(env, runId);
}

export async function rerunPipelineRun(db, env, person, runId, { failedOnly = false } = {}) {
  const run = await db.prepare('SELECT * FROM pipeline_runs WHERE id=?').bind(runId).first();
  if (!run || !['SUCCESS', 'FAILURE', 'CANCELLED', 'SKIPPED'].includes(run.state)) refuse('Only a finished run can be re-run.');
  if (run.attempt >= 20) refuse('A run can be attempted at most 20 times.');
  await requireAllowed(db, env, run.repository_id);
  const { results: jobs } = await db.prepare('SELECT * FROM pipeline_jobs WHERE run_id=? AND attempt=? ORDER BY id').bind(runId, run.attempt).all();
  const rerun = new Set(jobs.filter(job => !failedOnly || job.state !== 'SUCCESS').map(job => job.job_key));
  // Dependents of a re-run job run again too.
  for (let grew = true; grew;) { grew = false; for (const job of jobs) if (!rerun.has(job.job_key) && parse(job.needs, []).some(key => rerun.has(key))) { rerun.add(job.job_key); grew = true; } }
  if (!rerun.size) refuse('No failed jobs to re-run.');
  const attempt = run.attempt + 1, time = now();
  const statements = [db.prepare("UPDATE pipeline_runs SET attempt=?,state='QUEUED',cancel_requested=0,actor_id=?,finished_at=NULL,started_at=NULL,updated_at=? WHERE id=? AND attempt=?").bind(attempt, person.id, time, runId, run.attempt)];
  for (const job of jobs) {
    const again = rerun.has(job.job_key);
    statements.push(db.prepare(`INSERT INTO pipeline_jobs(run_id,attempt,engine,job_key,name,stage,stage_index,needs,runs_on,payload,environment,state,when_mode,allow_failure,timeout_seconds,retry_max,outputs,exit_code,log_lines,log_bytes,log_chunks,log_complete,failure_reason,created_at,updated_at,started_at,finished_at)
      SELECT run_id,?,engine,job_key,name,stage,stage_index,needs,runs_on,payload,environment,?,when_mode,allow_failure,timeout_seconds,retry_max,?,?,0,0,0,?,?,?,?,?,? FROM pipeline_jobs WHERE id=? AND changes()=1`)
      .bind(attempt, again ? 'BLOCKED' : 'SUCCESS', again ? '{}' : job.outputs, again ? null : job.exit_code, again ? 0 : 1, again ? '' : 'reused:' + job.id, time, time, again ? null : job.started_at, again ? null : job.finished_at, job.id));
  }
  const saved = await db.batch(statements);
  if (saved[0].meta.changes !== 1) refuse('The run changed; refresh.');
  await advancePipelineRun(env, runId);
  return { runId, attempt };
}

export async function playManualJob(db, env, person, jobId) {
  const job = await db.prepare('SELECT * FROM pipeline_jobs WHERE id=?').bind(Number(jobId)).first();
  if (!job || job.state !== 'MANUAL') refuse('Only a manual job waiting to be played can start.');
  const run = await db.prepare('SELECT * FROM pipeline_runs WHERE id=?').bind(job.run_id).first();
  if (run.attempt !== job.attempt || run.cancel_requested) refuse('The run changed; refresh.');
  await requireAllowed(db, env, run.repository_id);
  const time = now();
  // A played job is no longer manual: it goes through its environment gate (protected → APPROVAL) like any other job.
  const gate = job.environment ? await environmentGate(db, run, job) : { state: 'QUEUED', reason: '' };
  const played = await db.prepare("UPDATE pipeline_jobs SET state=?,when_mode='on_success',allow_failure=0,failure_reason=?,queued_at=?,updated_at=?,finished_at=CASE WHEN ?='FAILURE' THEN ? ELSE finished_at END WHERE id=? AND state='MANUAL'")
    .bind(gate.state, gate.reason || '', time, time, gate.state, time, job.id).run();
  if (played.meta.changes !== 1) refuse('The job changed; refresh.');
  await db.prepare("UPDATE pipeline_runs SET state='RUNNING',finished_at=NULL,updated_at=? WHERE id=?").bind(time, run.id).run();
  return advancePipelineRun(env, run.id);
}

// ---------- artifacts ----------
export async function putJobArtifact(db, env, job, { name, kind, contentType = 'application/zip', expiresAt }, body, size) {
  if (typeof name !== 'string' || !/^[^\x00-\x1f\x7f/\\]{1,255}$/.test(name) || !['actions-v4', 'gitlab-archive', 'gitlab-report'].includes(kind) || !Number.isSafeInteger(size) || size < 0 || size > 1024 * 1024 * 1024) invalid('Invalid artifact.');
  const time = now(), expires = expiresAt || new Date(Date.now() + 30 * 86400_000).toISOString();
  const created = await db.prepare(`INSERT INTO pipeline_artifacts(run_id,job_id,name,kind,state,size,content_type,created_at,expires_at) VALUES(?,?,?,?,'UPLOADING',0,?,?,?)
    ON CONFLICT(job_id,name) DO UPDATE SET state='UPLOADING',size=0,blocks='[]',sha256='',created_at=excluded.created_at RETURNING id`).bind(job.run_id, job.id, name, kind, contentType, time, expires).first();
  const key = artifactPrefix(job.run_id, created.id) + 'blob';
  const stored = await bucket(env).put(key, body, { httpMetadata: { contentType }, sha256: undefined });
  const sha = stored?.checksums?.sha256 ? hex(new Uint8Array(stored.checksums.sha256)) : '';
  await db.prepare("UPDATE pipeline_artifacts SET state='READY',size=?,blocks=?,sha256=?,finalized_at=? WHERE id=?").bind(stored?.size ?? size, JSON.stringify([key]), sha, now(), created.id).run();
  return db.prepare('SELECT * FROM pipeline_artifacts WHERE id=?').bind(created.id).first();
}
export async function listRunArtifacts(db, env, runId) {
  return (await db.prepare("SELECT * FROM pipeline_artifacts WHERE run_id=? AND state='READY' ORDER BY name,id LIMIT 500").bind(runId).all()).results;
}
export async function openArtifact(db, env, artifactId) {
  const row = await db.prepare("SELECT * FROM pipeline_artifacts WHERE id=? AND state='READY'").bind(Number(artifactId)).first();
  if (!row) refuse('Artifact unavailable.');
  if (Date.parse(row.expires_at) <= Date.now()) refuse('Artifact expired.');
  const keys = parse(row.blocks, []), store = bucket(env);
  let index = 0, reader = null;
  const body = new ReadableStream({
    async pull(controller) {
      for (;;) {
        if (!reader) {
          if (index >= keys.length) { controller.close(); return; }
          const object = await store.get(keys[index++]);
          if (!object) { controller.error(Error('Artifact block missing')); return; }
          reader = object.body.getReader();
        }
        const { value, done } = await reader.read();
        if (done) { reader = null; continue; }
        controller.enqueue(value); return;
      }
    },
  });
  return { row, body };
}

// ---------- deployment environments ----------
const environmentRow = async (db, repositoryId, name) => db.prepare('SELECT * FROM pipeline_environments WHERE repository_id=? AND name=? AND deleted=0').bind(repositoryId, name).first();
// A job reaching its turn: auto-create the environment unprotected (GitHub), refuse a disallowed ref, wait for a reviewer when protected.
async function environmentGate(db, run, job) {
  const target = parse(job.environment, null);
  if (!target) return { state: 'QUEUED' };
  let row = await environmentRow(db, run.repository_id, target.name);
  if (!row) {
    const time = now();
    await db.prepare('INSERT INTO pipeline_environments(repository_id,artifact_name,name,created_by,created_at,updated_at) VALUES(?,?,?,?,?,?) ON CONFLICT DO NOTHING').bind(run.repository_id, run.artifact_name, target.name, run.actor_id, time, time).run();
    row = await environmentRow(db, run.repository_id, target.name);
  }
  const branches = parse(row.branches, []), refName = run.ref.replace(/^refs\/(heads|tags)\//, '');
  if (branches.length && !branches.some(pattern => new RegExp('^' + pattern.replace(/[.+^$|(){}[\]\\]/g, '\\$&').replace(/\*\*/g, '\u0000').replace(/\*/g, '[^/]*').replace(/\u0000/g, '.*') + '$').test(refName)))
    return { state: 'FAILURE', reason: 'environment_branch' };
  if (!['start', 'stop', 'prepare'].includes(target.action) || !parse(row.reviewers, []).length) return { state: 'QUEUED' };
  const decision = await db.prepare('SELECT decision FROM pipeline_approvals WHERE job_id=?').bind(job.id).first();
  if (decision?.decision === 'APPROVED') return { state: 'QUEUED' };
  if (decision?.decision === 'REJECTED') return { state: 'FAILURE', reason: 'environment_rejected' };
  return { state: 'APPROVAL' };
}
async function approvalHolds(db, run, job) {
  const target = parse(job.environment, null), row = target && await environmentRow(db, run.repository_id, target.name);
  if (!row) return false;
  if (!['start', 'stop', 'prepare'].includes(target.action) || !parse(row.reviewers, []).length) return row;
  return (await db.prepare("SELECT 1 AS ok FROM pipeline_approvals WHERE job_id=? AND decision='APPROVED'").bind(job.id).first()) ? row : false;
}
const environmentKey = env => import('./sealed.mjs').then(({ sealingKey }) => sealingKey(env.EXECUTION_VALUE_KEY, 'Environment value'));
const environmentAD = (env, row, name, kind, version, bytes) => ['golf.native.pipeline-environment-value.v1', env.PUBLIC_ORIGIN, row.repository_id, row.artifact_name, row.id, name, kind, version, bytes];
async function environmentValues(db, env, run, job) {
  const row = await approvalHolds(db, run, job);
  if (!row || !env.EXECUTION_VALUE_KEY?.get || row.artifact_name !== run.artifact_name) return null;
  if (!(await repositoryFeatures(db, env, run.repository_id)).get('secrets')?.effective) return null;
  const { open } = await import('./sealed.mjs'), { key, id } = await environmentKey(env);
  const { results } = await db.prepare('SELECT * FROM pipeline_environment_values WHERE environment_id=? ORDER BY name LIMIT 100').bind(row.id).all();
  const secrets = {}, variables = {};
  for (const value of results) {
    if (value.key_id !== id) continue;
    const plain = await open(key, environmentAD(env, row, value.name, value.kind, value.version, value.value_bytes), value.encrypted);
    if (value.kind === 'variable') variables[value.name] = plain; else if (run.trusted) secrets[value.name] = plain;
  }
  return { secrets, variables };
}
export async function saveEnvironmentValue(db, env, person, environment, { name, kind, value }) {
  if (!/^[A-Z][A-Z0-9_]{0,63}$/.test(name || '') || /^(GITHUB_|ACTIONS_|RUNNER_|FORGEJO_|GITEA_|CI_|GITLAB_)/.test(name) || !['secret', 'variable'].includes(kind) || typeof value !== 'string' || !value || new TextEncoder().encode(value).length > 65536) invalid('Use an uppercase name and a value up to 64 KiB.');
  if (!env.EXECUTION_VALUE_KEY?.get) refuse('Configure the repository value encryption key to store environment values.');
  const { seal } = await import('./sealed.mjs'), { key, id } = await environmentKey(env);
  const current = await db.prepare('SELECT version FROM pipeline_environment_values WHERE environment_id=? AND name=?').bind(environment.id, name).first();
  const version = (current?.version || 0) + 1, bytes = new TextEncoder().encode(value).length, time = now();
  const encrypted = await seal(key, environmentAD(env, environment, name, kind, version, bytes), value);
  await db.prepare(`INSERT INTO pipeline_environment_values(environment_id,name,kind,version,value_bytes,encrypted,key_id,updated_by,updated_at) VALUES(?,?,?,?,?,?,?,?,?)
    ON CONFLICT(environment_id,name) DO UPDATE SET kind=excluded.kind,version=excluded.version,value_bytes=excluded.value_bytes,encrypted=excluded.encrypted,key_id=excluded.key_id,updated_by=excluded.updated_by,updated_at=excluded.updated_at`)
    .bind(environment.id, name, kind, version, bytes, encrypted, id, person.id, time).run();
  valueCache.clear();
}
export async function approveEnvironmentJob(db, env, person, jobId, { approve, comment = '' }) {
  const job = await db.prepare('SELECT * FROM pipeline_jobs WHERE id=?').bind(Number(jobId)).first();
  if (!job || job.state !== 'APPROVAL') refuse('This job is not waiting for approval.');
  const run = await db.prepare('SELECT * FROM pipeline_runs WHERE id=?').bind(job.run_id).first(), target = parse(job.environment, null);
  const row = await environmentRow(db, run.repository_id, target?.name);
  if (!row) refuse('The environment no longer exists.');
  if (!parse(row.reviewers, []).map(Number).includes(Number(person.id))) throw new Fault('permission_denied', 403, `Only a required reviewer of ${row.name} can review this deployment.`);
  if (row.prevent_self_review && Number(run.actor_id) === Number(person.id)) throw new Fault('permission_denied', 403, 'The person who triggered this run cannot approve its deployment.');
  if (typeof approve !== 'boolean' || typeof comment !== 'string' || comment.length > 1000) invalid('Approve or reject, with an optional comment.');
  const saved = await db.prepare('INSERT INTO pipeline_approvals(job_id,environment_id,reviewer_id,decision,comment,created_at) VALUES(?,?,?,?,?,?) ON CONFLICT(job_id) DO NOTHING')
    .bind(job.id, row.id, person.id, approve ? 'APPROVED' : 'REJECTED', comment, now()).run();
  if (saved.meta.changes !== 1) refuse('This deployment was already reviewed.');
  await db.prepare("UPDATE pipeline_jobs SET state='BLOCKED',updated_at=? WHERE id=? AND state='APPROVAL'").bind(now(), job.id).run();
  return advancePipelineRun(env, run.id);
}
async function recordDeployment(db, job, state, url) {
  const target = parse(job.environment, null);
  if (!target || !['start', 'stop'].includes(target.action) || !['SUCCESS', 'FAILURE', 'CANCELLED'].includes(state)) return;
  const run = await db.prepare('SELECT * FROM pipeline_runs WHERE id=?').bind(job.run_id).first(), row = await environmentRow(db, run.repository_id, target.name);
  if (!row) return;
  const chosen = typeof url === 'string' && /^https?:\/\//.test(url) && url.length <= 2048 ? url : target.url || row.url || '';
  await db.prepare('INSERT INTO pipeline_deployments(environment_id,run_id,job_id,action,commit_id,ref,url,state,actor_id,created_at) VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(job_id) DO NOTHING')
    .bind(row.id, run.id, job.id, target.action, run.commit_id, run.ref, chosen, state, run.actor_id, now()).run();
}
