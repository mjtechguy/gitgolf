import { ownerSlug } from './owners.mjs';
import { digest, Fault, invalid, reply } from './common.mjs';
import { bounded, remote } from './git.mjs';
import { machineIdentity, nativeRunnerComplete, nativeRunnerMachine } from './native-runners.mjs';
import { gitLabJobResponse, gitLabJobSpec, duration } from './gitlab-pipeline.mjs';
import { appendJobLogBytes, claimPipelineJob, finishPipelineJob, jobByToken, openArtifact, pipelinePolicy, pipelineValues, putJobArtifact, readJobLog, registerPipelineRunner, runnerByToken } from './pipelines.mjs';

const jobPath = /^\/api\/v4\/jobs\/([1-9][0-9]{0,15})(?:\/(trace|git\/info\/refs|git\/git-upload-pack))?$/;
const json = value => new Response(JSON.stringify(value), { status: 201, headers: { 'Content-Type': 'application/json' } });
const denied = () => { throw new Fault('permission_denied', 403, 'Runner job authority ended.'); };

export async function gitLabRunner(db, env, request, authorize, git) {
  // Stock runners registered for Golf pipelines (glrt-golf_ runner tokens, golfjob_ job tokens) use the pipeline protocol;
  // the evidence one-job coordinator below keeps its own glrt-<uuid> machine credentials.
  const routed = await gitLabPipelineRoute(request);
  if (routed.pipeline) return gitLabPipelineRunner(db, env, routed.request, routed.body);
  request = routed.request;
  const url = new URL(request.url), path = url.pathname;
  if (path === '/api/v4/runners/verify' || path === '/api/v4/jobs/request') {
    if (request.method !== 'POST' || url.search || request.headers.get('Content-Type')?.split(';')[0] !== 'application/json') invalid('Use a GitLab Runner JSON request.');
    const bytes = await bounded(request.body, 16384);
    let body;
    try { body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); } catch { invalid('Invalid runner request.'); }
    if (!body || typeof body.token !== 'string' || !/^glrt-[a-f0-9-]{36}_[a-f0-9]{64}$/.test(body.token)) denied();
    const identity = new Request(env.PUBLIC_ORIGIN+'/native/runner-machine/claim', { method: 'POST', headers: { Authorization: 'Bearer '+body.token } });
    const { machine } = await machineIdentity(db, identity);
    if (path.endsWith('/verify')) return reply({ id: 1 });
    if (body.info?.executor !== 'docker' || body.info?.version !== '18.5.0' || typeof body.system_id !== 'string' || !/^s_[A-Za-z0-9_-]{8,80}$/.test(body.system_id))
      throw new Fault('failed_precondition', 412, 'Golf requires the pinned GitLab Runner 18.5.0 Docker executor.');
    if (machine.active_job_id) return new Response(null, { status: 204 });
    const claimed = await nativeRunnerMachine(db, env, identity, { claimId: crypto.randomUUID() }, authorize, git);
    const { assignment: a } = await claimed.json();
    if (!a) return new Response(null, { status: 204 });
    if (a.workflow?.plan?.format !== 'gitlab') throw Error('GitLab Runner claim selected an incompatible workflow');
    const created = await db.prepare('INSERT INTO gitlab_runner_jobs(evidence_job_id,machine_id,token_digest) VALUES(?,?,?) RETURNING id').bind(a.jobId,machine.id,await digest(a.lease)).first();
    const row = await db.prepare('SELECT id,name FROM repositories WHERE id=(SELECT repository_id FROM evidence_jobs WHERE id=?)').bind(a.jobId).first();
    const seconds = Math.max(1, Math.floor((a.deadline-Date.now())/1000));
    return json({ id: created.id, token: a.lease, allow_git_fetch: true,
      job_info: { name: a.workflow.plan.jobId, stage: 'test', project_id: row.id, project_name: row.name, project_full_path: ownerSlug(row,env)+'/'+row.name },
      git_info: { repo_url: `${env.PUBLIC_ORIGIN.replace('://','://gitlab-ci-token:'+a.lease+'@')}/api/v4/jobs/${created.id}/git`,
        ref: a.branch, sha: a.commitId, before_sha: '0'.repeat(40), ref_type: 'branch', refspecs: [`+${a.commitId}:refs/remotes/origin/${a.branch}`], depth: 1 },
      runner_info: { timeout: seconds }, variables: [{ key: 'GIT_STRATEGY', value: 'clone', public: true }, { key: 'GIT_DEPTH', value: '1', public: true }],
      steps: [{ name: 'script', script: a.workflow.plan.steps[0].run.split('\n'), when: 'on_success', allow_failure: false },
        ...(a.workflow.plan.afterScript ? [{ name: 'after_script', script: a.workflow.plan.afterScript.split('\n'), when: 'always', allow_failure: true }] : [])],
      image: { name: a.workflow.plan.image || env.TEST_IMAGE_REF }, services: [], artifacts: [], cache: [], dependencies: [], features: {} });
  }
  const match = jobPath.exec(path);
  if (!match) throw new Fault('not_found', 404, 'GitLab Runner operation unavailable.');
  const id = Number(match[1]), operation = match[2] || '';
  const record = await db.prepare('SELECT * FROM gitlab_runner_jobs WHERE id=?').bind(id).first();
  if (!record) denied();
  const machine = await db.prepare('SELECT * FROM native_runner_machines WHERE id=?').bind(record.machine_id).first();
  const job = await db.prepare('SELECT * FROM evidence_jobs WHERE id=?').bind(record.evidence_job_id).first();
  const credential = operation.startsWith('git/') ? (() => {
    const header = request.headers.get('Authorization') || '';
    if (!header.startsWith('Basic ')) return '';
    try { const pair = atob(header.slice(6)); return pair.startsWith('gitlab-ci-token:') ? pair.slice(16) : ''; } catch { return ''; }
  })() : request.headers.get('Job-Token') || '';
  if (operation.startsWith('git/') && !credential) return new Response(null,{status:401,headers:{'WWW-Authenticate':'Basic realm="Golf job source"'}});
  if (record.completed_state && operation === '' && request.method === 'PUT' && await digest(credential) === record.token_digest) {
    const bytes = await bounded(request.body,16384);
    let body;
    try { body = JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes)); } catch { denied(); }
    if (body.token === credential && body.state === (record.completed_state === 'PASSED' ? 'success' : 'failed') &&
        (body.exit_code ?? 0) === record.completed_exit_code)
      return new Response(null,{status:200,headers:{'Job-Status':body.state}});
  }
  if (!machine || !job || job.state !== 'QUEUED' || job.test_state !== 'RUNNING' || machine.active_job_id !== job.id ||
      machine.state !== 'ACTIVE' && machine.state !== 'DRAINING' || machine.lease_expires_at <= Date.now() ||
      machine.expires_at <= Date.now() || Date.parse(job.expires_at) <= Date.now() || await digest(credential) !== machine.lease_digest ||
      !await authorize(job.id)) denied();
  if (!await db.prepare('SELECT 1 AS allowed FROM operations_admins a JOIN users u ON u.id=a.user_id WHERE a.user_id=? AND a.active=1 AND u.active=1').bind(machine.sponsor_id).first()) denied();
  const heartbeat = async () => {
    const expires = Math.min(machine.expires_at,Date.parse(job.expires_at));
    const changed = await db.prepare('UPDATE native_runner_machines SET lease_expires_at=?,last_seen_at=? WHERE id=? AND active_job_id=? AND lease_digest=?')
      .bind(expires,new Date().toISOString(),machine.id,job.id,machine.lease_digest).run();
    if (changed.meta.changes !== 1) denied();
  };
  if (operation.startsWith('git/')) {
    if (operation === 'git/info/refs' && (request.method !== 'GET' || url.search !== '?service=git-upload-pack') ||
        operation === 'git/git-upload-pack' && (request.method !== 'POST' || url.search)) invalid('Invalid Git upload-pack request.');
    const repo = await db.prepare('SELECT artifact_name FROM repositories WHERE id=?').bind(job.repository_id).first();
    const suffix = operation === 'git/info/refs' ? '/info/refs?service=git-upload-pack' : '/git-upload-pack';
    const headers = new Headers();
    for (const name of ['Git-Protocol','Content-Encoding','Content-Type']) if (request.headers.has(name)) headers.set(name,request.headers.get(name));
    const source = new Request(remote(env,repo.artifact_name)+suffix,{method:request.method,headers,
      ...(request.method === 'POST' ? { body: await bounded(request.body,1024*1024) } : {})});
    await heartbeat();
    return git(job.id,source);
  }
  if (operation === 'trace') {
    if (request.method !== 'PATCH' || !/^(?:\?debug_trace=(?:true|false))?$/.test(url.search)) invalid('Invalid trace request.');
    const bytes = await bounded(request.body,65536), range = /^(0|[1-9][0-9]*)-([1-9][0-9]*|0)$/.exec(request.headers.get('Content-Range') || '');
    if (!range || Number(range[2])-Number(range[1])+1 !== bytes.length || record.trace_bytes+bytes.length > 49152) invalid('Invalid bounded trace range.');
    if (Number(range[1]) !== record.trace_bytes) return new Response(null,{status:416,headers:{Range:`0-${record.trace_bytes-1}`}});
    const previous=Uint8Array.from(atob(record.trace),character=>character.charCodeAt(0));
    const combined=new Uint8Array(previous.length+bytes.length); combined.set(previous); combined.set(bytes,previous.length);
    const data=btoa(String.fromCharCode(...combined));
    if (new TextEncoder().encode(new TextDecoder().decode(combined)).length > 65536) invalid('Trace exceeds the execution result limit.');
    const changed = await db.prepare('UPDATE gitlab_runner_jobs SET trace=?,trace_bytes=? WHERE id=? AND trace_bytes=? AND completed_state IS NULL').bind(data,combined.length,id,record.trace_bytes).run();
    if (changed.meta.changes !== 1) return new Response(null,{status:416});
    await heartbeat();
    return new Response(null,{status:202,headers:{'Job-Status':'running'}});
  }
  if (request.method !== 'PUT' || url.search || request.headers.get('Content-Type')?.split(';')[0] !== 'application/json') invalid('Invalid job update.');
  const bytes = await bounded(request.body,16384);
  let body;
  try { body = JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes)); } catch { invalid('Invalid job update.'); }
  if (body?.token !== credential || !['running','success','failed'].includes(body.state) ||
      !Number.isInteger(body.exit_code ?? 0) || (body.exit_code ?? 0) < 0 || (body.exit_code ?? 0) > 255 ||
      body.state === 'success' && (body.exit_code ?? 0) !== 0) invalid('Invalid job update state.');
  if (body.state === 'running') { await heartbeat(); return new Response(null,{status:200,headers:{'Job-Status':'running'}}); }
  const state = body.state === 'success' ? 'PASSED' : 'FAILED', code = body.state === 'success' ? 0 : body.exit_code || 1;
  const finish = { state, exitCode: code, stdout: new TextDecoder().decode(Uint8Array.from(atob(record.trace),character=>character.charCodeAt(0))), stderr: '', cleanup: 'confirmed' };
  // GitLab Runner has completed its Docker executor cleanup before its terminal update.
  await nativeRunnerComplete(db,machine,job,finish,{id,state,exitCode:body.exit_code ?? 0});
  return new Response(null,{status:200,headers:{'Job-Status':body.state}});
}

// ---------- Golf pipelines on the stock GitLab Runner (docs/NATIVE_ACTIONS_PIPELINES.md, RUN-C) ----------
const pipelineRunnerToken = /^glrt-golf_[a-f0-9]{32}_[a-f0-9]{64}$/, pipelineJobToken = /^golfjob_[a-f0-9]{64}$/;
const pipelineJobPath = /^\/api\/v4\/jobs\/([1-9][0-9]{0,15})(?:\/(trace|artifacts))?$/;
const decoder = new TextDecoder();
const parseJSON = bytes => { try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); } catch { return null; } };
const status = (code, jobStatus, headers = {}) => new Response(null, { status: code, headers: { 'Cache-Control': 'no-store', ...(jobStatus ? { 'Job-Status': jobStatus } : {}), ...headers } });
const denial = (message, code = 403) => Response.json({ message: `${code} ${message}` }, { status: code, headers: { 'Cache-Control': 'no-store', 'Job-Status': 'failed' } });
const artifactLimit = env => Math.min(Math.max(Number(env.GITLAB_ARTIFACT_MAX_BYTES) || 64 * 1024 * 1024, 1024 * 1024), 96 * 1024 * 1024);

// Decides which coordinator owns a request without consuming a body the evidence path still needs.
export async function gitLabPipelineRoute(request) {
  const url = new URL(request.url), path = url.pathname;
  if (path === '/api/v4/runners') return { pipeline: true, request };
  const header = request.headers.get('Job-Token') || '';
  if (pipelineJobToken.test(header)) return { pipeline: true, request };
  const bodied = ['/api/v4/runners/verify', '/api/v4/jobs/request'].includes(path) || request.method === 'PUT' && /^\/api\/v4\/jobs\/\d+$/.test(path);
  if (!bodied || request.method === 'GET') return { pipeline: false, request };
  const bytes = await bounded(request.body, 65536).catch(() => invalid('Runner request exceeds its bound.'));
  const body = parseJSON(bytes), token = typeof body?.token === 'string' ? body.token : '';
  const copy = new Request(request, { body: bytes.length ? bytes : null });
  return token.startsWith('glrt-golf_') || pipelineJobToken.test(token) ? { pipeline: true, request: copy, body } : { pipeline: false, request: copy };
}

async function readBody(request, limit = 65536) {
  if (request.headers.get('Content-Type')?.split(';')[0] !== 'application/json') invalid('Use a GitLab Runner JSON request.');
  const body = parseJSON(await bounded(request.body, limit).catch(() => invalid('Runner request exceeds its bound.')));
  if (!body || typeof body !== 'object') invalid('Invalid runner request.');
  return body;
}
const runnerInfo = info => {
  const out = {};
  for (const key of ['name', 'version', 'revision', 'platform', 'architecture', 'executor', 'shell']) if (typeof info?.[key] === 'string') out[key] = info[key].slice(0, 64);
  return out;
};

export async function gitLabPipelineRunner(db, env, request, body) {
  if (!pipelinePolicy(env)) return denial('Golf pipelines are not allocated on this installation.', 404);
  const url = new URL(request.url), path = url.pathname;
  if (path === '/api/v4/runners') {
    if (request.method === 'DELETE') return denial('Delete Golf runners in the runner settings.');
    if (request.method !== 'POST') return denial('Unsupported runner operation.', 405);
    body ||= await readBody(request);
    // Legacy `gitlab-runner register --registration-token golfreg_…`: one-time scoped registration token → runner credential.
    const tags = typeof body.tag_list === 'string' ? body.tag_list.split(',').map(tag => tag.trim()).filter(Boolean) : Array.isArray(body.tag_list) ? body.tag_list : [];
    let registered;
    try {
      registered = await registerPipelineRunner(db, env, { engine: 'gitlab-ci', registrationToken: body.token, name: typeof body.description === 'string' && body.description.trim() ? body.description.slice(0, 128) : 'gitlab-runner',
        labels: tags, version: typeof body.info?.version === 'string' ? body.info.version.slice(0, 64) : '', info: runnerInfo(body.info) });
    } catch (error) { if (error instanceof Fault) return denial(error.message, error.status === 400 ? 400 : 403); throw error; }
    return Response.json({ id: registered.runner.id, token: registered.token, token_expires_at: null }, { status: 201, headers: { 'Cache-Control': 'no-store' } });
  }
  if (path === '/api/v4/runners/verify' || path === '/api/v4/jobs/request') {
    if (request.method !== 'POST') return denial('Unsupported runner operation.', 405);
    body ||= await readBody(request);
    if (!pipelineRunnerToken.test(body.token || '')) return denial('Runner credential unknown.');
    let runner;
    try { runner = await runnerByToken(db, env, 'gitlab-ci', body.token); }
    catch (error) { if (error instanceof Fault) return denial(error.message); throw error; }
    if (path.endsWith('/verify')) return Response.json({ id: runner.id, token: body.token, token_expires_at: null }, { headers: { 'Cache-Control': 'no-store' } });
    const info = runnerInfo(body.info), infoJSON = JSON.stringify(info);
    if (info.version && (info.version !== runner.version || infoJSON !== runner.info))
      await db.prepare('UPDATE pipeline_runners SET version=?,info=? WHERE id=?').bind(info.version, infoJSON, runner.id).run();
    const claim = await claimPipelineJob(db, env, runner);
    if (!claim) return status(204);
    try {
      return Response.json(await jobPayload(db, env, claim), { status: 201, headers: { 'Cache-Control': 'no-store' } });
    } catch (error) {
      // A job that cannot be described to the runner fails visibly instead of hanging RUNNING.
      await finishPipelineJob(db, env, claim.job, { result: 'failure', failureReason: 'runner_unsupported: ' + String(error?.message || error).slice(0, 200) }).catch(() => {});
      if (error instanceof Fault) return status(204);
      throw error;
    }
  }
  const match = pipelineJobPath.exec(path);
  if (!match) return denial('GitLab Runner operation unavailable.', 404);
  const id = Number(match[1]), operation = match[2] || '';
  if (operation === '' && request.method === 'PUT') body ||= await readBody(request);
  const token = request.headers.get('Job-Token') || body?.token || '';
  if (!pipelineJobToken.test(token)) return denial('Job token required.', 401);
  let held;
  try { held = await jobByToken(db, env, token); }
  catch (error) {
    if (error instanceof Fault && error.code === 'cancelled') return cancelled(operation, request);
    if (error instanceof Fault) return denial(error.message);
    throw error;
  }
  // Artifact downloads name the dependency's job id; everything else acts on the token's own job.
  if (operation === 'artifacts' && request.method === 'GET') return downloadArtifact(db, env, held, id);
  if (held.job.id !== id || held.job.engine !== 'gitlab-ci') return denial('The job token belongs to another job.');
  if (held.run.cancel_requested) {
    // The job stays RUNNING until the runner's terminal update (or the coordinator's lost-runner timeout) so its token still works.
    if (operation === '' && request.method === 'PUT' && !['running', 'pending'].includes(body.state)) {
      await finishPipelineJob(db, env, held.job, { result: 'cancelled', exitCode: Number.isInteger(body.exit_code) && body.exit_code >= 0 ? body.exit_code : null, failureReason: 'job_canceled' })
        .catch(error => { if (!(error instanceof Fault)) throw error; });
    }
    return cancelled(operation, request);
  }
  if (operation === 'trace') return appendTrace(db, env, held, request);
  if (operation === 'artifacts') return uploadArtifact(db, env, held, request, url);
  if (request.method !== 'PUT') return denial('Unsupported job operation.', 405);
  return updateJob(db, env, held, body);
}

function cancelled(operation, request) {
  // The stock runner aborts the job when an update reports `canceled`; a terminal update after that is acknowledged.
  if (operation === '' && request.method === 'PUT') return status(200, 'canceled');
  return status(operation === 'trace' ? 202 : 403, 'canceled');
}

async function jobPayload(db, env, { job, run, repository, token }) {
  const spec = gitLabJobSpec(job), projectPath = ownerSlug(repository, env) + '/' + repository.name;
  const values = await pipelineValues(db, env, run, job);
  const dependencies = [], inherited = {};
  for (const name of spec.dependencies || []) {
    // The newest attempt of that job that produced the artifact (re-runs reuse earlier successful jobs).
    const archive = await db.prepare(`SELECT a.id,a.size,a.job_id FROM pipeline_artifacts a JOIN pipeline_jobs j ON j.id=a.job_id
      WHERE j.run_id=? AND j.name=? AND j.attempt<=? AND a.kind='gitlab-archive' AND a.state='READY' ORDER BY j.attempt DESC,a.id DESC LIMIT 1`).bind(run.id, name, run.attempt).first();
    if (archive) dependencies.push({ id: archive.job_id, name, size: archive.size });
    const dotenv = await db.prepare(`SELECT a.id FROM pipeline_artifacts a JOIN pipeline_jobs j ON j.id=a.job_id
      WHERE j.run_id=? AND j.name=? AND j.attempt<=? AND a.kind='gitlab-report' AND a.name='dotenv' AND a.state='READY' ORDER BY j.attempt DESC,a.id DESC LIMIT 1`).bind(run.id, name, run.attempt).first();
    if (dotenv) Object.assign(inherited, await readDotenv(db, env, dotenv.id));
  }
  return gitLabJobResponse({ env, job, run, repository, token, values, dependencies, inherited, projectPath, gitURL: `${env.PUBLIC_ORIGIN}/${projectPath}.git` });
}

// artifacts:reports:dotenv → variables of the jobs that depend on it (at most 50 variables, 64 KiB).
async function readDotenv(db, env, artifactId) {
  try {
    const { body } = await openArtifact(db, env, artifactId);
    const bytes = await bounded(body.pipeThrough(new DecompressionStream('gzip')), 65536);
    const out = {};
    for (const line of decoder.decode(bytes).split(/\r?\n/)) {
      const m = /^([A-Za-z_][A-Za-z0-9_]{0,127})=(.*)$/.exec(line);
      if (m && Object.keys(out).length < 50) out[m[1]] = m[2].replace(/^(["'])(.*)\1$/, '$2');
    }
    return out;
  } catch { return {}; }
}

async function appendTrace(db, env, { job }, request) {
  if (request.method !== 'PATCH') return denial('Unsupported trace operation.', 405);
  const range = /^(\d{1,15})-(\d{1,15})$/.exec(request.headers.get('Content-Range') || '');
  const bytes = await bounded(request.body, 4 * 1024 * 1024).catch(() => invalid('Trace chunk exceeds 4 MiB.'));
  if (!range || Number(range[2]) - Number(range[1]) + 1 !== bytes.length) invalid('Invalid trace range.');
  let ack;
  try { ({ ack } = await appendJobLogBytes(db, env, job, Number(range[1]), bytes)); }
  catch (error) {
    if (error instanceof Fault && error.status === 416) return status(416, 'running', { Range: `0-${error.ack}` });
    if (error instanceof Fault) return denial(error.message);
    throw error;
  }
  return status(202, 'running', { Range: `0-${ack}`, 'X-GitLab-Trace-Update-Interval': '3' });
}

async function updateJob(db, env, held, body) {
  const states = { running: null, pending: null, success: 'success', failed: 'failure', canceled: 'cancelled' };
  if (!Object.hasOwn(states, body.state)) invalid('Invalid job update state.');
  const exitCode = body.exit_code ?? null;
  if (exitCode !== null && (!Number.isInteger(exitCode) || exitCode < -1 || exitCode > 255)) invalid('Invalid job exit code.');
  const result = states[body.state];
  if (!result) return status(200, 'running');
  const reason = typeof body.failure_reason === 'string' && /^[a-z_]{1,64}$/.test(body.failure_reason) ? body.failure_reason : result === 'failure' ? 'script_failure' : '';
  const outputs = {};
  const spec = gitLabJobSpec(held.job);
  if (spec.coverage) {
    // GitLab's coverage keyword: the last match of the job's regular expression in its log.
    const m = /^\/(.*)\/([a-z]*)$/s.exec(spec.coverage);
    const fresh = await db.prepare('SELECT log_bytes FROM pipeline_jobs WHERE id=?').bind(held.job.id).first();
    const tail = await readJobLog(db, env, held.job, { fromByte: Math.max(0, (fresh?.log_bytes || 0) - 1024 * 1024) });
    let found = null;
    try { for (const hit of tail.text.matchAll(new RegExp(m[1], [...new Set(m[2].replace(/[^ims]/g, '') + 'g')].join('')))) found = hit; } catch { found = null; }
    const value = found && /\d+(?:\.\d+)?/.exec(found[1] ?? found[0]);
    if (value) outputs.coverage = value[0];
  }
  let finished;
  try { finished = await finishPipelineJob(db, env, held.job, { result, exitCode: exitCode === -1 ? null : exitCode, failureReason: reason, outputs }); }
  catch (error) { if (error instanceof Fault) return denial(error.message); throw error; }
  return status(200, finished.state === 'QUEUED' ? 'failed' : body.state);
}

// Runner uploads are multipart (`file` part); one archive per job plus one artifact per report type.
async function uploadArtifact(db, env, { job }, request, url) {
  if (request.method !== 'POST') return denial('Unsupported artifact operation.', 405);
  const limit = artifactLimit(env), declared = Number(request.headers.get('Content-Length') || 0);
  const tooLarge = () => Response.json({ message: `413 Artifact larger than ${limit} bytes` }, { status: 413 });
  if (declared > limit + 65536) return tooLarge();
  const type = url.searchParams.get('artifact_type') || 'archive', format = url.searchParams.get('artifact_format') || 'zip';
  if (!/^[a-z_]{1,40}$/.test(type) || !['zip', 'gzip', 'raw'].includes(format) || type === 'archive' && format !== 'zip') invalid('Unsupported artifact type or format.');
  const contentType = request.headers.get('Content-Type') || '', boundary = /^multipart\/form-data;\s*boundary="?([^";]{1,200})"?/i.exec(contentType)?.[1];
  if (!boundary) invalid('Artifacts are uploaded as multipart form data.');
  let bytes;
  try { bytes = await bounded(request.body, limit + 65536); } catch { return tooLarge(); }
  const part = multipartFile(bytes, boundary);
  if (!part) invalid('The upload has no file part.');
  if (part.data.length > limit) return tooLarge();
  const expireIn = url.searchParams.get('expire_in') || '';
  let expiresAt;
  if (expireIn) {
    const seconds = expireIn === 'never' ? 90 * 86400 : Math.min(duration(expireIn, 'expire_in'), 90 * 86400);
    expiresAt = new Date(Date.now() + Math.max(seconds, 60) * 1000).toISOString();
  }
  const name = type === 'archive' ? (part.filename.replace(/[\x00-\x1f\x7f/\\]/g, '_').slice(0, 200) || 'artifacts.zip') : type;
  const row = await putJobArtifact(db, env, job, { name, kind: type === 'archive' ? 'gitlab-archive' : 'gitlab-report',
    contentType: format === 'zip' ? 'application/zip' : format === 'gzip' ? 'application/gzip' : 'application/octet-stream', expiresAt }, part.data, part.data.length);
  return Response.json({ id: row.id, size: row.size }, { status: 201, headers: { 'Cache-Control': 'no-store' } });
}
function multipartFile(bytes, boundary) {
  const encode = value => new TextEncoder().encode(value);
  const find = (from, pattern) => {
    for (let i = bytes.indexOf(pattern[0], from); i >= 0 && i + pattern.length <= bytes.length; i = bytes.indexOf(pattern[0], i + 1)) {
      let k = 1; while (k < pattern.length && bytes[i + k] === pattern[k]) k++;
      if (k === pattern.length) return i;
    }
    return -1;
  };
  const marker = encode('--' + boundary), blank = encode('\r\n\r\n'), next = encode('\r\n--' + boundary);
  for (let at = find(0, marker); at >= 0;) {
    const headerEnd = find(at, blank);
    if (headerEnd < 0) return null;
    const headers = decoder.decode(bytes.subarray(at + marker.length, headerEnd));
    const end = find(headerEnd + 4, next);
    if (end < 0) return null;
    const disposition = /content-disposition:\s*form-data;([^\r\n]*)/i.exec(headers)?.[1] || '';
    if (/\bname="file"/.test(disposition)) return { filename: /filename="([^"]*)"/.exec(disposition)?.[1] || '', data: bytes.subarray(headerEnd + 4, end) };
    at = end + 2;
  }
  return null;
}

async function downloadArtifact(db, env, { job, run }, id) {
  const spec = gitLabJobSpec(job);
  const source = await db.prepare('SELECT id,run_id,name FROM pipeline_jobs WHERE id=?').bind(id).first();
  if (!source || source.run_id !== run.id || !(spec.dependencies || []).includes(source.name)) return denial('That job is not a dependency of this job.');
  const row = await db.prepare("SELECT id FROM pipeline_artifacts WHERE job_id=? AND kind='gitlab-archive' AND state='READY' ORDER BY id DESC LIMIT 1").bind(id).first();
  if (!row) return Response.json({ message: '404 Not Found' }, { status: 404 });
  let opened;
  try { opened = await openArtifact(db, env, row.id); }
  catch (error) { if (error instanceof Fault) return Response.json({ message: '404 ' + error.message }, { status: 404 }); throw error; }
  return new Response(opened.body, { headers: { 'Content-Type': 'application/zip', 'Content-Length': String(opened.row.size), 'Content-Disposition': 'attachment; filename="artifacts.zip"', 'Cache-Control': 'no-store' } });
}
