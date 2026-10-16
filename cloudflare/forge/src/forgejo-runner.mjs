// The stock Forgejo Runner's connect-rpc protocol (actions-proto v0.8.0: ping.v1.PingService, runner.v1.RunnerService)
// on /api/actions/*, plus the job-token Git source actions/checkout clones. Handled in the stateless Worker against
// D1/R2; every call re-checks runner → job → repository → `actions` feature authority.
import { parseDocument } from '../../agents/node_modules/yaml/browser/index.js';
import { Fault } from './common.mjs';
import { encode, decode, Struct, Timestamp, toStruct, timestampISO } from './protobuf.mjs';
import { bounded, gitRequest } from './git.mjs';
import { ownerSlug } from './owners.mjs';
import { defaultActionsURL } from './pipeline-policy.mjs';
import { RUNNER_LEGACY_CONTEXT, RUNNER_LEGACY_TOKEN_SECRET } from './forgejo-upstream.mjs';
import { registerPipelineRunner, runnerByToken, claimPipelineJob, jobByToken, appendJobLogLines, completeJobLog, updateJobSteps, finishPipelineJob,
  pipelineValues, pipelineAllowed, advancePipelineRun } from './pipelines.mjs';

const engine = 'forgejo-actions';
const RunnerSchema = { id: [1, 'int64'], uuid: [2, 'string'], token: [3, 'string'], name: [4, 'string'], status: [5, 'enum'], version: [8, 'string'], labels: [9, 'string', true], ephemeral: [10, 'bool'] };
const StepState = { id: [1, 'int64'], result: [2, 'enum'], started_at: [3, Timestamp], stopped_at: [4, Timestamp], log_index: [5, 'int64'], log_length: [6, 'int64'] };
const TaskState = { id: [1, 'int64'], result: [2, 'enum'], started_at: [3, Timestamp], stopped_at: [4, Timestamp], steps: [5, StepState, true] };
const TaskNeed = { outputs: [1, ['map', 'string', 'string']], result: [2, 'enum'] };
const Task = { id: [1, 'int64'], workflow_payload: [2, 'bytes'], context: [3, Struct], secrets: [4, ['map', 'string', 'string']], needs: [6, ['map', 'string', TaskNeed]], vars: [7, ['map', 'string', 'string']] };
const LogRow = { time: [1, Timestamp], content: [2, 'string'] };
const schemas = {
  Ping: [{ data: [1, 'string'] }, { data: [1, 'string'] }],
  Register: [{ name: [1, 'string'], token: [2, 'string'], agent_labels: [3, 'string', true], custom_labels: [4, 'string', true], version: [5, 'string'], labels: [6, 'string', true], ephemeral: [7, 'bool'] }, { runner: [1, RunnerSchema] }],
  Declare: [{ version: [1, 'string'], labels: [2, 'string', true] }, { runner: [1, RunnerSchema] }],
  FetchTask: [{ tasks_version: [1, 'int64'], task_capacity: [2, 'int64'] }, { task: [1, Task], tasks_version: [2, 'int64'], additional_tasks: [3, Task, true] }],
  FetchSingleTask: [{ tasks_version: [1, 'int64'], handle: [2, 'string'] }, { tasks_version: [1, 'int64'], task: [2, Task] }],
  UpdateTask: [{ state: [1, TaskState], outputs: [2, ['map', 'string', 'string']] }, { state: [1, TaskState], sent_outputs: [2, 'string', true] }],
  UpdateLog: [{ task_id: [1, 'int64'], index: [2, 'int64'], rows: [3, LogRow, true], no_more: [4, 'bool'] }, { ack_index: [1, 'int64'] }],
  UpdateStepSummary: [{ task_id: [1, 'int64'], summaries: [2, { step_number: [1, 'int64'], content: [2, 'string'] }, true] }, {}],
};
const RESULT = { 1: 'success', 2: 'failure', 3: 'cancelled', 4: 'skipped' }, RESULT_OF = { SUCCESS: 1, FAILURE: 2, CANCELLED: 3, SKIPPED: 4 };
const STEP = { 0: 'RUNNING', 1: 'SUCCESS', 2: 'FAILURE', 3: 'CANCELLED', 4: 'SKIPPED' };
const connectCodes = { 400: 'invalid_argument', 401: 'unauthenticated', 403: 'permission_denied', 404: 'not_found', 409: 'aborted', 412: 'failed_precondition', 416: 'out_of_range', 429: 'resource_exhausted', 501: 'unimplemented' };
const now = () => new Date().toISOString();
const parse = (value, fallback) => { try { return JSON.parse(value) ?? fallback; } catch { return fallback; } };

function connectError(error) {
  const fault = error instanceof Fault;
  const status = fault ? (error.status === 416 ? 400 : error.status) : 503;
  if (!fault) console.log(JSON.stringify({ event: 'golf.forgejo_runner_error', message: String(error?.message || error).slice(0, 300) }));
  return new Response(JSON.stringify({ code: fault ? connectCodes[error.status] || 'unknown' : 'unavailable', message: fault ? error.message : 'The runner operation could not be confirmed.' }),
    { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
}
const reply = (schema, message) => new Response(encode(schema, message), { headers: { 'Content-Type': 'application/proto', 'Cache-Control': 'no-store' } });

export function forgejoRunnerRoute(pathname) {
  return /^\/api\/actions\/(?:ping\.v1\.PingService\/Ping|runner\.v1\.RunnerService\/[A-Za-z]+)$/.test(pathname);
}

export async function forgejoRunner(request, env) {
  try {
    const url = new URL(request.url), method = url.pathname.split('/').at(-1);
    if (request.method !== 'POST' || url.search) throw new Fault('invalid_argument', 400, 'Use a Connect unary POST.');
    if (!schemas[method]) throw new Fault('unimplemented', 501, 'This runner method is not implemented.');
    if (request.headers.get('Content-Type')?.split(';')[0] !== 'application/proto' || request.headers.has('Content-Encoding') && request.headers.get('Content-Encoding') !== 'identity')
      throw new Fault('invalid_argument', 400, 'Use application/proto without request compression.');
    let body;
    try { body = decode(schemas[method][0], await bounded(request.body, method === 'UpdateLog' ? 6 * 1024 * 1024 : method === 'UpdateStepSummary' ? 2 * 1024 * 1024 : 256 * 1024)); }
    catch (error) { if (error instanceof Fault) throw error; throw new Fault('invalid_argument', 400, 'Invalid protobuf request.'); }
    const db = env.DB.withSession('first-primary');
    if (method === 'Ping') return reply(schemas.Ping[1], { data: 'Hello, ' + (body.data || '') + '!' });
    if (method === 'Register') {
      const labels = body.labels.length ? body.labels : [...body.agent_labels, ...body.custom_labels];
      const { runner, token } = await registerPipelineRunner(db, env, { engine, registrationToken: body.token, name: body.name, labels, version: body.version || '', ephemeral: body.ephemeral });
      return reply(schemas.Register[1], { runner: wireRunner(runner, token) });
    }
    const runner = await runnerByToken(db, env, engine, request.headers.get('x-runner-token') || '', request.headers.get('x-runner-uuid') || '');
    if (method === 'Declare') {
      if (body.labels.length > 32 || body.labels.some(label => typeof label !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}(?::[\x21-\x7e]{1,200})?$/.test(label)) || (body.version || '').length > 64)
        throw new Fault('invalid_argument', 400, 'Labels are up to 32 names of letters, digits, dot, dash and underscore.');
      await db.prepare('UPDATE pipeline_runners SET labels=?,version=?,last_seen_at=? WHERE id=?').bind(JSON.stringify(body.labels), body.version || '', now(), runner.id).run();
      return reply(schemas.Declare[1], { runner: wireRunner({ ...runner, labels: JSON.stringify(body.labels), version: body.version || '' }) });
    }
    if (method === 'FetchTask' || method === 'FetchSingleTask') {
      const capacity = method === 'FetchTask' ? Math.max(1, Math.min(4, body.task_capacity || 1)) : 1, tasks = [];
      const requestKey = request.headers.get('x-runner-request-key') || undefined;
      for (let i = 0; i < capacity; i++) {
        const claim = await claimPipelineJob(db, env, runner, { requestKey: requestKey && capacity > 1 ? undefined : requestKey });
        if (!claim) break;
        tasks.push(await buildTask(db, env, claim));
        if (claim.job.request_key && requestKey) break;
      }
      if (method === 'FetchSingleTask') return reply(schemas.FetchSingleTask[1], { tasks_version: 1, task: tasks[0] });
      return reply(schemas.FetchTask[1], { task: tasks[0], tasks_version: 1, additional_tasks: tasks.slice(1) });
    }
    const jobId = method === 'UpdateTask' ? body.state?.id : body.task_id;
    const job = await db.prepare('SELECT * FROM pipeline_jobs WHERE id=?').bind(Number(jobId || 0)).first();
    if (!job || job.runner_id !== runner.id || job.engine !== engine) throw new Fault('permission_denied', 403, 'This runner does not hold that task.');
    const run = await db.prepare('SELECT * FROM pipeline_runs WHERE id=?').bind(job.run_id).first();
    // Policy turned off mid-run: the run is cancelled and the runner is told to stop.
    if (!await pipelineAllowed(db, env, run.repository_id) && !run.cancel_requested) {
      await db.prepare('UPDATE pipeline_runs SET cancel_requested=1,updated_at=? WHERE id=?').bind(now(), run.id).run(); run.cancel_requested = 1;
    }
    if (job.state === 'RUNNING') await db.prepare('UPDATE pipeline_jobs SET updated_at=? WHERE id=? AND state=\'RUNNING\'').bind(now(), job.id).run();
    if (method === 'UpdateLog') {
      const { ack } = job.state === 'RUNNING' || !job.log_complete ? await appendJobLogLines(db, env, job, body.index, body.rows.map(row => row.content || '')) : { ack: job.log_lines };
      if (body.no_more && ack >= body.index + body.rows.length) await completeJobLog(db, job);
      return reply(schemas.UpdateLog[1], { ack_index: ack });
    }
    if (method === 'UpdateStepSummary') {
      for (const summary of body.summaries.slice(0, 256)) {
        if (summary.content.length > 1024 * 1024) continue;
        await env.PIPELINE_BUCKET.put(`pipelines/${job.run_id}/${job.id}/summary/${summary.step_number}.md`, summary.content, { httpMetadata: { contentType: 'text/markdown; charset=utf-8' } });
      }
      return reply(schemas.UpdateStepSummary[1], {});
    }
    // UpdateTask
    const state = body.state || {};
    const names = stepNames(job.payload);
    if (state.steps?.length) await updateJobSteps(db, job, state.steps.slice(0, 512).map(step => ({ number: step.id, name: names[step.id] || '', state: step.result ? STEP[step.result] : step.started_at ? 'RUNNING' : 'PENDING',
      startedAt: timestampISO(step.started_at), finishedAt: timestampISO(step.stopped_at), logIndex: step.log_index, logLength: step.log_length })));
    let outputs = parse(job.outputs, {});
    const incoming = Object.entries(body.outputs || {}).filter(([key, value]) => /^[A-Za-z_][A-Za-z0-9_-]{0,99}$/.test(key) && typeof value === 'string');
    if (incoming.length && job.state === 'RUNNING') {
      outputs = { ...outputs, ...Object.fromEntries(incoming) };
      if (new TextEncoder().encode(JSON.stringify(outputs)).length <= 65536) await db.prepare("UPDATE pipeline_jobs SET outputs=? WHERE id=? AND state='RUNNING'").bind(JSON.stringify(outputs), job.id).run();
      else outputs = parse(job.outputs, {});
    }
    let result = job.state === 'RUNNING' ? 0 : RESULT_OF[job.state] || 0;
    if (state.result && RESULT[state.result] && job.state === 'RUNNING') {
      const finished = await finishPipelineJob(db, env, job, { result: RESULT[state.result], outputs, failureReason: state.result === 2 ? 'job_failed' : '' });
      result = finished.state === 'QUEUED' ? state.result : RESULT_OF[finished.state] || state.result;
    } else if (job.state === 'RUNNING' && run.cancel_requested) {
      result = 3;
      env.waitUntil?.(advancePipelineRun(env, run.id));
    }
    return reply(schemas.UpdateTask[1], { state: { id: job.id, result }, sent_outputs: Object.keys(outputs) });
  } catch (error) { return connectError(error); }
}

function wireRunner(runner, token = '') {
  return { id: runner.id, uuid: runner.uuid, token, name: runner.name, status: 1, version: runner.version || '', labels: parse(runner.labels, []), ephemeral: Boolean(runner.ephemeral) };
}
// Step names as Forgejo shows them: name, else the action, else the first line of the script.
function stepNames(payload) {
  try {
    const root = parseDocument(payload, { maxAliasCount: 1000 }).toJS({ maxAliasCount: 1000 }), job = Object.values(root.jobs)[0];
    return (job.steps || []).map((step, index) => String(step.name || (step.uses ? 'Run ' + step.uses : step.run ? 'Run ' + String(step.run).trim().split('\n')[0] : 'Step ' + (index + 1))).slice(0, 200));
  } catch { return []; }
}

async function buildTask(db, env, { job, run, repository, token }) {
  const owner = ownerSlug(repository, env), full = owner + '/' + repository.name, origin = env.PUBLIC_ORIGIN;
  const names = stepNames(job.payload);
  if (names.length) await updateJobSteps(db, job, names.map((name, number) => ({ number, name, state: 'PENDING' })));
  const values = await pipelineValues(db, env, run, job);
  const event = parse(run.event_payload, {});
  const ref = run.ref, refName = ref.replace(/^refs\/(heads|tags)\//, '').replace(/^refs\/pull\/(\d+)\/head$/, '$1/merge');
  const actions = defaultActionsURL(env);
  const actor = await db.prepare('SELECT login FROM users WHERE id=?').bind(run.actor_id).first();
  const context = {
    action: '', action_path: '', action_ref: '', action_repository: '', action_status: '', actor: actor?.login || '', actor_id: String(run.actor_id),
    api_url: origin + '/api/v1', base_ref: run.base_ref, env: '', event, event_name: run.event, event_path: '', graphql_url: '', head_ref: run.head_ref,
    job: job.job_key, path: '', ref, ref_name: refName, ref_protected: false, ref_type: ref.startsWith('refs/tags/') ? 'tag' : 'branch', repository: full,
    repository_id: String(repository.id), repository_owner: owner, repository_owner_id: String(repository.owner_id || 0), repositoryUrl: origin + '/' + full + '.git', retention_days: '30',
    run_attempt: String(job.attempt), run_id: String(run.id), run_number: String(run.number), secret_source: 'Actions', server_url: origin, sha: run.commit_id,
    token, triggering_actor: actor?.login || '', workflow: run.workflow_name, workflow_ref: `${full}/${run.workflow_path}@${ref}`, workspace: '',
    forgejo_default_actions_url: actions, [RUNNER_LEGACY_CONTEXT.defaultActionsUrl]: actions, forgejo_runtime_token: token, [RUNNER_LEGACY_CONTEXT.runtimeToken]: token, forgejo_server_version: '1.0.0+golf-native',
  };
  const needs = {};
  for (const key of parse(job.needs, [])) {
    const { results } = await db.prepare('SELECT state,outputs FROM pipeline_jobs WHERE run_id=? AND attempt=? AND job_key=?').bind(run.id, job.attempt, key).all();
    const outputs = {};
    for (const row of results) for (const [name, value] of Object.entries(parse(row.outputs, {}))) if (value !== '' || !(name in outputs)) outputs[name] = value;
    const states = results.map(row => row.state);
    needs[key] = { outputs, result: states.includes('FAILURE') ? 2 : states.includes('CANCELLED') ? 3 : states.length && states.every(state => state === 'SKIPPED') ? 4 : 1 };
  }
  return { id: job.id, workflow_payload: new TextEncoder().encode(job.payload), context: toStruct(context),
    secrets: { ...values.secrets, GITHUB_TOKEN: token, [RUNNER_LEGACY_TOKEN_SECRET]: token, FORGEJO_TOKEN: token }, needs, vars: values.variables };
}

// actions/checkout: ${server_url}/${repository} with Basic x-access-token:<job token>. Read-only, exactly the run's repository.
export function actionsGitRoute(pathname) {
  return /^\/[a-z0-9][a-z0-9-]{0,99}\/[a-z0-9][a-z0-9._-]{0,99}?(?:\.git)?\/(?:info\/refs|git-upload-pack)$/.test(pathname);
}
export async function actionsGit(request, env, withArtifact) {
  const url = new URL(request.url), match = /^\/([^/]+)\/(.+?)(?:\.git)?\/(info\/refs|git-upload-pack)$/.exec(url.pathname);
  const header = request.headers.get('Authorization') || '';
  let token = '';
  if (/^basic /i.test(header)) { try { const pair = atob(header.slice(6)), at = pair.indexOf(':'); token = at >= 0 ? pair.slice(at + 1) : ''; } catch { token = ''; } }
  else if (/^bearer /i.test(header)) token = header.slice(7);
  const challenge = () => new Response('Job token required', { status: 401, headers: { 'WWW-Authenticate': 'Basic realm="Golf Actions"', 'Cache-Control': 'no-store' } });
  if (!token) return challenge();
  try {
    const db = env.DB.withSession('first-primary');
    const { repository } = await jobByToken(db, env, token);
    if (ownerSlug(repository, env) !== match[1] || repository.name !== match[2]) return new Response('Repository unavailable', { status: 404 });
    const advertisement = match[3] === 'info/refs';
    if (advertisement ? request.method !== 'GET' || url.search !== '?service=git-upload-pack' : request.method !== 'POST' || url.search ||
        request.headers.get('Content-Type') !== 'application/x-git-upload-pack-request') return new Response('Only read-only upload-pack is available to job tokens', { status: 403 });
    const protocol = request.headers.get('Git-Protocol') === 'version=2' ? 'version=2' : null;
    let body = null;
    if (!advertisement) {
      body = await bounded(request.body, 8 * 1024 * 1024);
      if (request.headers.get('Content-Encoding') === 'gzip') body = new Uint8Array(await new Response(new Response(body).body.pipeThrough(new DecompressionStream('gzip'))).arrayBuffer());
      else if (request.headers.has('Content-Encoding')) return new Response('Unsupported encoding', { status: 415 });
    }
    return await withArtifact(env, repository, async repo => {
      const result = await gitRequest(env, repo, repository.artifact_name, advertisement ? 'info/refs?service=git-upload-pack' : 'git-upload-pack', 'git-upload-pack', body, env.providerFetch || fetch, protocol);
      return new Response(result.bytes, { headers: { 'Content-Type': result.contentType, 'Cache-Control': 'no-store' } });
    });
  } catch (error) {
    if (error instanceof Fault && error.status === 401) return challenge();
    if (error instanceof Fault) return new Response(error.message, { status: error.status === 412 ? 403 : error.status, headers: { 'Cache-Control': 'no-store' } });
    console.log(JSON.stringify({ event: 'golf.actions_git_error', message: String(error?.message || error).slice(0, 300) }));
    return new Response('Source unavailable', { status: 503 });
  }
}
