// Access-authenticated Actions tab and runner administration (POST /native/pipelines, /native/pipeline-runners).
// Reads need repository read access; cancel, re-run, play and dispatch need write; runner administration needs
// repository admin, organization owner or operations administrator for its scope. Mutations require `actions` on.
import { Fault, invalid, deny } from './common.mjs';
import { ownerSlug } from './owners.mjs';
import { sha } from './git.mjs';
import { operationsAdmin } from './operations.mjs';
import { pipelinePolicy, forgejoRunnerVersion, forgejoRunnerSha256 } from './pipeline-policy.mjs';
import { pipelineAllowed, cancelPipelineRun, rerunPipelineRun, playManualJob, readJobLog, listRunArtifacts, openArtifact, createRegistrationToken, pipelineEngines, approveEnvironmentJob, saveEnvironmentValue } from './pipelines.mjs';
import { dispatchWorkflow, listWorkflows, repositoryRefs } from './actions-intake.mjs';

const parse = (value, fallback) => { try { return JSON.parse(value) ?? fallback; } catch { return fallback; } };
const refuse = message => { throw new Fault('failed_precondition', 412, message); };
const writer = row => ['write', 'admin'].includes(row.role);
const fields = (body, allowed) => Object.keys(body).every(key => allowed.includes(key));
const states = ['QUEUED', 'RUNNING', 'WAITING', 'SUCCESS', 'FAILURE', 'CANCELLED', 'SKIPPED', 'REFUSED'];
const events = ['push', 'pull_request', 'workflow_dispatch', 'merge_request_event', 'web', 'schedule'];

const wireRun = (run, actor) => ({ id: String(run.id), number: run.number, engine: run.engine, workflowPath: run.workflow_path, workflowName: run.workflow_name, event: run.event, ref: run.ref,
  branch: run.ref.replace(/^refs\/(heads|tags)\//, ''), commitId: run.commit_id, pullNumber: run.pull_number, headRef: run.head_ref, baseRef: run.base_ref, actor: actor || '', trusted: Boolean(run.trusted),
  title: run.title, state: run.state, reason: run.reason, attempt: run.attempt, cancelRequested: Boolean(run.cancel_requested), concurrencyGroup: run.concurrency_group || '',
  inputs: parse(run.inputs, {}), createdAt: run.created_at, startedAt: run.started_at, finishedAt: run.finished_at, updatedAt: run.updated_at });
const wireJob = (job, runner) => ({ id: String(job.id), key: job.job_key, name: job.name, attempt: job.attempt, stage: job.stage, stageIndex: job.stage_index, needs: parse(job.needs, []), runsOn: parse(job.runs_on, []),
  state: job.state, when: job.when_mode, allowFailure: Boolean(job.allow_failure), exitCode: job.exit_code, failureReason: job.failure_reason, reusedFrom: job.failure_reason.startsWith('reused:') ? job.failure_reason.slice(7) : '',
  runner: runner || '', logLines: job.log_lines, logBytes: job.log_bytes, logComplete: Boolean(job.log_complete), outputs: Object.keys(parse(job.outputs, {})), retryCount: job.retry_count,
  createdAt: job.created_at, queuedAt: job.queued_at, startedAt: job.started_at, finishedAt: job.finished_at, timeoutSeconds: job.timeout_seconds });
const wireArtifact = row => ({ id: String(row.id), name: row.name, kind: row.kind, size: row.size, jobId: String(row.job_id), createdAt: row.created_at, expiresAt: row.expires_at, expired: Date.parse(row.expires_at) <= Date.now() });

export async function pipelineAPI(db, env, person, row, request, body, withArtifact) {
  if (!pipelinePolicy(env)) refuse('Actions pipelines are not allocated on this installation.');
  const action = body.action, run = async id => {
    if (!/^[1-9][0-9]{0,15}$/.test(String(id || ''))) invalid('Choose a run.');
    const value = await db.prepare('SELECT * FROM pipeline_runs WHERE id=? AND repository_id=? AND artifact_name=?').bind(Number(id), row.id, row.artifact_name).first();
    if (!value) deny();
    return value;
  };
  const job = async id => {
    if (!/^[1-9][0-9]{0,15}$/.test(String(id || ''))) invalid('Choose a job.');
    const value = await db.prepare('SELECT j.* FROM pipeline_jobs j JOIN pipeline_runs r ON r.id=j.run_id WHERE j.id=? AND r.repository_id=? AND r.artifact_name=?').bind(Number(id), row.id, row.artifact_name).first();
    if (!value) deny();
    return value;
  };
  const mutate = async () => {
    if (!writer(row) || row.write_pending) throw new Fault('permission_denied', 403, 'Write access to this repository is required.');
    if (!await pipelineAllowed(db, env, row.id)) refuse('Actions are turned off for this repository.');
  };
  if (action === 'listRuns') {
    if (!fields(body, ['action', 'repository', 'repositoryId', 'workflow', 'branch', 'event', 'status', 'actor', 'page'])) invalid('Unknown filter.');
    const filters = [], values = [row.id, row.artifact_name];
    if (body.workflow) { filters.push('r.workflow_path=?'); values.push(String(body.workflow)); }
    if (body.branch) { filters.push("(r.ref=? OR r.ref=? OR r.head_ref=?)"); values.push('refs/heads/' + body.branch, 'refs/tags/' + body.branch, String(body.branch)); }
    if (body.event) { if (!events.includes(body.event)) invalid('Unknown event.'); filters.push('r.event=?'); values.push(body.event); }
    if (body.status) {
      const chosen = body.status === 'in_progress' ? ['QUEUED', 'RUNNING', 'WAITING'] : body.status === 'completed' ? ['SUCCESS', 'FAILURE', 'CANCELLED', 'SKIPPED', 'REFUSED'] : [body.status];
      if (chosen.some(state => !states.includes(state))) invalid('Unknown status.');
      filters.push(`r.state IN (${chosen.map(() => '?').join(',')})`); values.push(...chosen);
    }
    if (body.actor) { filters.push('u.login=?'); values.push(String(body.actor)); }
    const page = Number.isInteger(body.page) && body.page >= 1 && body.page <= 1000 ? body.page : 1, limit = 25;
    const where = 'r.repository_id=? AND r.artifact_name=?' + filters.map(filter => ' AND ' + filter).join('');
    const { results } = await db.prepare(`SELECT r.*,u.login FROM pipeline_runs r LEFT JOIN users u ON u.id=r.actor_id WHERE ${where} ORDER BY r.id DESC LIMIT ? OFFSET ?`).bind(...values, limit + 1, (page - 1) * limit).all();
    const total = await db.prepare(`SELECT COUNT(*) AS n FROM pipeline_runs r LEFT JOIN users u ON u.id=r.actor_id WHERE ${where}`).bind(...values).first();
    const { results: workflows } = await db.prepare('SELECT workflow_path AS path,MAX(workflow_name) AS name,engine,COUNT(*) AS runs FROM pipeline_runs WHERE repository_id=? AND artifact_name=? GROUP BY workflow_path,engine ORDER BY workflow_path LIMIT 100').bind(row.id, row.artifact_name).all();
    return { runs: results.slice(0, limit).map(value => wireRun(value, value.login)), total: total.n, nextPage: results.length > limit ? page + 1 : 0, workflows,
      canWrite: writer(row), enabled: await pipelineAllowed(db, env, row.id) };
  }
  if (action === 'getRun') {
    const value = await run(body.runId), attempt = body.attempt === undefined ? value.attempt : Number(body.attempt);
    if (!Number.isInteger(attempt) || attempt < 1 || attempt > value.attempt) invalid('Choose an attempt.');
    const { results: jobs } = await db.prepare('SELECT j.*,n.name AS runner_name FROM pipeline_jobs j LEFT JOIN pipeline_runners n ON n.id=j.runner_id WHERE j.run_id=? AND j.attempt=? ORDER BY j.stage_index,j.id').bind(value.id, attempt).all();
    const { results: steps } = jobs.length ? await db.prepare(`SELECT * FROM pipeline_steps WHERE job_id IN (${jobs.map(() => '?').join(',')}) ORDER BY job_id,number`).bind(...jobs.map(item => item.id)).all() : { results: [] };
    const actor = await db.prepare('SELECT login FROM users WHERE id=?').bind(value.actor_id).first();
    // Queued jobs say what they wait for: a runner with these labels, which Golf can tell the user.
    const { results: runners } = await db.prepare("SELECT labels,scope,scope_id FROM pipeline_runners WHERE engine=? AND state='ACTIVE' AND deleted=0 AND last_seen_at>?").bind(value.engine, new Date(Date.now() - 5 * 60_000).toISOString()).all();
    const online = runners.filter(runner => runner.scope === 'installation' || runner.scope === 'repository' && Number(runner.scope_id) === row.id || runner.scope === 'organization' && Number(runner.scope_id) === row.owner_id)
      .map(runner => new Set(parse(runner.labels, []).map(label => String(label).split(':')[0])));
    return { run: wireRun(value, actor?.login), attempt, canWrite: writer(row),
      jobs: jobs.map(item => ({ ...wireJob(item, item.runner_name), steps: steps.filter(step => step.job_id === item.id).map(step => ({ number: step.number, name: step.name, state: step.state, startedAt: step.started_at, finishedAt: step.finished_at, logIndex: step.log_index, logLength: step.log_length })),
        waitingForLabels: item.state === 'QUEUED' && !online.some(labels => parse(item.runs_on, []).every(label => labels.has(label))) })),
      artifacts: (await listRunArtifacts(db, env, value.id)).map(wireArtifact) };
  }
  if (action === 'jobLog') {
    const value = await job(body.jobId), from = Number(body.fromLine || 0);
    if (!Number.isSafeInteger(from) || from < 0) invalid('Invalid log offset.');
    const log = await readJobLog(db, env, value, { fromLine: from, limit: 1024 * 1024 });
    return { jobId: String(value.id), state: value.state, text: log.text, nextLine: log.nextLine, totalLines: log.totalLines, complete: log.complete };
  }
  if (action === 'cancel') { await mutate(); const value = await run(body.runId); await cancelPipelineRun(db, env, person, value.id); return { ok: true }; }
  if (action === 'rerun') { await mutate(); const value = await run(body.runId); return rerunPipelineRun(db, env, person, value.id, { failedOnly: body.failedOnly === true }); }
  if (action === 'approve') {
    // Required reviewers need only read access, as on GitHub; approveEnvironmentJob checks the reviewer list and self-review.
    if (!await pipelineAllowed(db, env, row.id)) refuse('Actions are turned off for this repository.');
    const value = await job(body.jobId);
    await approveEnvironmentJob(db, env, person, value.id, { approve: body.approve === true, comment: typeof body.comment === 'string' ? body.comment : '' });
    return { ok: true };
  }
  if (action === 'environments') {
    const { results } = await db.prepare('SELECT * FROM pipeline_environments WHERE repository_id=? AND artifact_name=? AND deleted=0 ORDER BY name LIMIT 100').bind(row.id, row.artifact_name).all();
    const deployments = results.length ? (await db.prepare(`SELECT d.*,u.login FROM pipeline_deployments d LEFT JOIN users u ON u.id=d.actor_id WHERE d.environment_id IN (${results.map(() => '?').join(',')}) ORDER BY d.id DESC LIMIT 200`).bind(...results.map(item => item.id)).all()).results : [];
    const reviewers = new Map((await db.prepare('SELECT id,login FROM users').all()).results.map(user => [user.id, user.login]));
    return { canEdit: row.role === 'admin', environments: results.map(item => ({ id: String(item.id), name: item.name, url: item.url, branches: parse(item.branches, []), preventSelfReview: Boolean(item.prevent_self_review),
      reviewers: parse(item.reviewers, []).map(id => ({ id: String(id), login: reviewers.get(Number(id)) || '' })), version: item.version, updatedAt: item.updated_at,
      deployments: deployments.filter(d => d.environment_id === item.id).slice(0, 20).map(d => ({ id: String(d.id), runId: String(d.run_id), jobId: String(d.job_id), action: d.action, commitId: d.commit_id, ref: d.ref, url: d.url, state: d.state, actor: d.login || '', createdAt: d.created_at })) })) };
  }
  if (action === 'saveEnvironment') {
    if (row.role !== 'admin') throw new Fault('permission_denied', 403, 'Repository administrators manage environments.');
    const name = String(body.name || '');
    if (!/^[A-Za-z0-9 _./-]{1,255}$/.test(name) || name.trim() !== name || !Array.isArray(body.reviewers) || body.reviewers.length > 6 || !Array.isArray(body.branches) || body.branches.length > 20 ||
        body.branches.some(b => typeof b !== 'string' || !b || b.length > 255) || typeof body.url !== 'string' || body.url && !/^https?:\/\//.test(body.url)) invalid('Name the environment; up to 6 reviewers and 20 branch patterns; an http(s) URL or none.');
    const reviewerIds = [];
    for (const login of body.reviewers) {
      const user = await db.prepare('SELECT u.id FROM users u JOIN grants g ON g.user_id=u.id AND g.repository_id=? WHERE u.login=? AND u.active=1').bind(row.id, String(login)).first();
      if (!user) invalid(`${login} has no access to this repository.`);
      reviewerIds.push(user.id);
    }
    const time = new Date().toISOString(), existing = await db.prepare('SELECT * FROM pipeline_environments WHERE repository_id=? AND name=? AND deleted=0').bind(row.id, name).first();
    if (existing) {
      if (body.expectedVersion !== existing.version) refuse('The environment changed; refresh before saving.');
      await db.prepare('UPDATE pipeline_environments SET reviewers=?,branches=?,url=?,prevent_self_review=?,version=version+1,updated_at=? WHERE id=? AND version=?').bind(JSON.stringify(reviewerIds), JSON.stringify(body.branches), body.url, body.preventSelfReview === false ? 0 : 1, time, existing.id, existing.version).run();
    } else await db.prepare('INSERT INTO pipeline_environments(repository_id,artifact_name,name,reviewers,prevent_self_review,branches,url,created_by,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)')
      .bind(row.id, row.artifact_name, name, JSON.stringify(reviewerIds), body.preventSelfReview === false ? 0 : 1, JSON.stringify(body.branches), body.url, person.id, time, time).run();
    return { ok: true };
  }
  if (action === 'saveEnvironmentValue') {
    if (row.role !== 'admin') throw new Fault('permission_denied', 403, 'Repository administrators manage environment values.');
    const environment = await db.prepare('SELECT * FROM pipeline_environments WHERE id=? AND repository_id=? AND deleted=0').bind(Number(body.environmentId || 0), row.id).first();
    if (!environment) deny();
    await saveEnvironmentValue(db, env, person, environment, { name: body.name, kind: body.kind, value: body.value });
    return { ok: true };
  }
  if (action === 'play') { await mutate(); const value = await job(body.jobId); await playManualJob(db, env, person, value.id); return { ok: true }; }
  if (action === 'dispatch') {
    await mutate();
    if (!fields(body, ['action', 'repository', 'repositoryId', 'workflowPath', 'ref', 'inputs']) || body.inputs !== undefined && (typeof body.inputs !== 'object' || Array.isArray(body.inputs) || Object.values(body.inputs).some(value => typeof value !== 'string'))) invalid('Choose a workflow, branch and string inputs.');
    const created = await dispatchWorkflow(db, env, person, row, { workflowPath: body.workflowPath, ref: body.ref, inputs: body.inputs || {} }, withArtifact);
    return { runId: String(created.runId), number: created.number };
  }
  if (action === 'workflows') {
    return withArtifact(env, row, async repo => {
      const refs = await repositoryRefs(env, repo, row), branch = typeof body.ref === 'string' && body.ref ? body.ref : row.default_branch, commitId = refs.get('refs/heads/' + branch);
      const branches = [...refs.keys()].filter(ref => ref.startsWith('refs/heads/')).map(ref => ref.slice(11)).sort().slice(0, 200);
      return { branch, branches, workflows: sha(commitId) ? await listWorkflows(env, row, repo, commitId) : [] };
    });
  }
  if (action === 'downloadArtifact') {
    if (!/^[1-9][0-9]{0,15}$/.test(String(body.artifactId || ''))) invalid('Choose an artifact.');
    const artifact = await db.prepare('SELECT a.* FROM pipeline_artifacts a JOIN pipeline_runs r ON r.id=a.run_id WHERE a.id=? AND r.repository_id=? AND r.artifact_name=?').bind(Number(body.artifactId), row.id, row.artifact_name).first();
    if (!artifact) deny();
    const { row: stored, body: stream } = await openArtifact(db, env, artifact.id);
    return new Response(stream, { headers: { 'Content-Type': stored.content_type, 'Content-Length': String(stored.size), 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
      'Content-Disposition': `attachment; filename="${stored.name.replace(/[^A-Za-z0-9._-]/g, '_')}${stored.kind === 'actions-v4' ? '.zip' : ''}"` } });
  }
  invalid('Unknown Actions operation.');
}

// ---------- runner administration ----------
const wireRunner = (runner, online) => ({ id: String(runner.id), uuid: runner.uuid, engine: runner.engine, scope: runner.scope, scopeId: runner.scope_id, name: runner.name, labels: parse(runner.labels, []),
  state: runner.state, version: runner.version, ephemeral: Boolean(runner.ephemeral), createdAt: runner.created_at, lastSeenAt: runner.last_seen_at, online,
  busy: Boolean(runner.busy) });
const wireToken = token => ({ id: token.id, engine: token.engine, scope: token.scope, scopeId: token.scope_id, labels: parse(token.labels, []), expiresAt: new Date(token.expires_at).toISOString(), usesLeft: token.uses_left, revoked: Boolean(token.revoked), createdAt: token.created_at });
export function registerCommands(env, engine, token, labels) {
  const origin = env.PUBLIC_ORIGIN;
  if (engine === 'gitlab-ci') return [`gitlab-runner register --non-interactive --url ${origin} --token ${token} --executor docker --docker-image alpine:3.22 --description golf-runner`];
  const label = labels.length ? labels.join(',') : 'ubuntu-latest:docker://ghcr.io/catthehacker/ubuntu:act-24.04';
  return [`# Forgejo Runner ${forgejoRunnerVersion} (linux-amd64 sha256 ${forgejoRunnerSha256})`, `forgejo-runner register --no-interactive --instance ${origin} --token ${token} --name golf-runner --labels ${label}`, 'forgejo-runner daemon'];
}

// scope: { kind: 'installation' } | { kind: 'organization', organization } | { kind: 'repository', row }
export async function pipelineRunnerAPI(db, env, person, request, body, repositoryRow) {
  if (!pipelinePolicy(env)) refuse('Actions pipelines are not allocated on this installation.');
  let scope, scopeId;
  if (body.scope === 'installation') {
    if (!await operationsAdmin(db, person, request)) throw new Fault('permission_denied', 403, 'Current workspace operations administrator sign-in required.');
    scope = 'installation'; scopeId = '';
  } else if (body.scope === 'organization') {
    const org = await db.prepare("SELECT o.id FROM native_owners o JOIN native_owner_members m ON m.owner_id=o.id AND m.user_id=? AND m.role='owner' WHERE o.slug=? AND o.kind='ORGANIZATION'").bind(person.id, String(body.organization || '')).first();
    if (!org) throw new Fault('permission_denied', 403, 'Organization owners manage organization runners.');
    scope = 'organization'; scopeId = String(org.id);
  } else if (body.scope === 'repository') {
    const row = await repositoryRow();
    if (row.role !== 'admin') throw new Fault('permission_denied', 403, 'Repository administrators manage repository runners.');
    scope = 'repository'; scopeId = String(row.id);
  } else invalid('Choose installation, organization or repository scope.');
  const own = 'scope=? AND scope_id=?';
  if (body.action === 'list') {
    const { results: runners } = await db.prepare(`SELECT n.*,EXISTS(SELECT 1 FROM pipeline_jobs j WHERE j.runner_id=n.id AND j.state='RUNNING') AS busy FROM pipeline_runners n WHERE ${own} AND deleted=0 ORDER BY name,id LIMIT 201`).bind(scope, scopeId).all();
    // Repository and organization pages also show the broader runners that can take their jobs.
    const { results: inherited } = scope === 'installation' ? { results: [] } : await db.prepare(`SELECT n.*,0 AS busy FROM pipeline_runners n WHERE deleted=0 AND state='ACTIVE' AND (scope='installation' OR scope='organization' AND scope_id=(SELECT CAST(owner_id AS TEXT) FROM repository_owners WHERE repository_id=?)) AND NOT (${own}) ORDER BY scope,name LIMIT 100`).bind(scope === 'repository' ? Number(scopeId) : 0, scope, scopeId).all();
    const { results: tokens } = await db.prepare(`SELECT * FROM pipeline_registration_tokens WHERE ${own} AND revoked=0 AND expires_at>? AND uses_left>0 ORDER BY created_at DESC LIMIT 50`).bind(scope, scopeId, Date.now()).all();
    const online = runner => Boolean(runner.last_seen_at) && Date.parse(runner.last_seen_at) > Date.now() - 5 * 60_000;
    return { scope, scopeId, runners: runners.slice(0, 200).map(runner => wireRunner(runner, online(runner))), inherited: inherited.map(runner => wireRunner(runner, online(runner))), tokens: tokens.map(wireToken),
      engines: pipelineEngines, forgejoRunner: { version: forgejoRunnerVersion, sha256: forgejoRunnerSha256 }, instance: env.PUBLIC_ORIGIN };
  }
  if (body.action === 'createToken') {
    if (!fields(body, ['action', 'scope', 'organization', 'repository', 'repositoryId', 'engine', 'labels', 'ttlHours', 'uses'])) invalid('Unknown field.');
    const { token, row } = await createRegistrationToken(db, env, person, { engine: body.engine, scope, scopeId, labels: body.labels || [], ttlHours: body.ttlHours || 1, uses: body.uses || 1 });
    return { token, registration: wireToken(row), commands: registerCommands(env, body.engine, token, body.labels || []) };
  }
  if (body.action === 'revokeToken') {
    const changed = await db.prepare(`UPDATE pipeline_registration_tokens SET revoked=1 WHERE id=? AND ${own}`).bind(String(body.id || ''), scope, scopeId).run();
    if (changed.meta.changes !== 1) deny();
    return { ok: true };
  }
  const runner = /^[1-9][0-9]{0,15}$/.test(String(body.id || '')) ? await db.prepare(`SELECT * FROM pipeline_runners WHERE id=? AND ${own} AND deleted=0`).bind(Number(body.id), scope, scopeId).first() : null;
  if (body.action === 'update') {
    if (!runner) deny();
    if (!['ACTIVE', 'DISABLED'].includes(body.state) || body.labels !== undefined && (!Array.isArray(body.labels) || body.labels.length > 32 || body.labels.some(label => typeof label !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}(?::[\x21-\x7e]{1,200})?$/.test(label))) ||
        body.name !== undefined && (typeof body.name !== 'string' || !body.name.trim() || body.name.length > 128)) invalid('Choose a state, a name and up to 32 labels.');
    await db.prepare('UPDATE pipeline_runners SET state=?,labels=?,name=? WHERE id=?').bind(body.state, JSON.stringify(body.labels ?? parse(runner.labels, [])), (body.name ?? runner.name).trim(), runner.id).run();
    return { runner: wireRunner(await db.prepare('SELECT * FROM pipeline_runners WHERE id=?').bind(runner.id).first(), false) };
  }
  if (body.action === 'delete') {
    if (!runner) deny();
    // A deleted runner's credential stops working at once; its running job is failed by the coordinator when it stops reporting.
    await db.prepare("UPDATE pipeline_runners SET deleted=1,state='DISABLED',token_digest='deleted:'||id||':'||token_digest WHERE id=?").bind(runner.id).run();
    return { ok: true };
  }
  invalid('Unknown runner operation.');
}
