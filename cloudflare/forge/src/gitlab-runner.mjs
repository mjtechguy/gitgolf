import { digest, Fault, invalid, reply } from './common.mjs';
import { bounded, remote } from './git.mjs';
import { machineIdentity, nativeRunnerComplete, nativeRunnerMachine } from './native-runners.mjs';

const jobPath = /^\/api\/v4\/jobs\/([1-9][0-9]{0,15})(?:\/(trace|git\/info\/refs|git\/git-upload-pack))?$/;
const json = value => new Response(JSON.stringify(value), { status: 201, headers: { 'Content-Type': 'application/json' } });
const denied = () => { throw new Fault('permission_denied', 403, 'Runner job authority ended.'); };

export async function gitLabRunner(db, env, request, authorize, git) {
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
      job_info: { name: a.workflow.plan.jobId, stage: 'test', project_id: row.id, project_name: row.name, project_full_path: env.WORKSPACE_SLUG+'/'+row.name },
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
