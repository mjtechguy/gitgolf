import { digest, Fault, invalid, reply, uuidOK } from './common.mjs';
import { operationsAdmin } from './operations.mjs';
import { testResult } from './test-policy.mjs';
import { nativeActionsCatalog, nativeWorkflowPlanOK } from './native-workflow.mjs';
import { remote } from './git.mjs';
import { bounded } from './git.mjs';

const nameOK = value => typeof value === 'string' && value.length >= 1 && value.length <= 80 &&
  value.trim() === value && !/[\x00-\x1f\x7f]/.test(value);
const versionOK = value => Number.isSafeInteger(value) && value >= 0;
const imageOK = value => /^sha256:[a-f0-9]{64}$/.test(value || '');
const imageRefOK = value => /^[a-z0-9][a-z0-9._/-]{0,127}:[a-z0-9][a-z0-9._-]{0,63}@sha256:[a-f0-9]{64}$/.test(value || '');
const fields = (body, allowed) => Object.keys(body).every(key => allowed.includes(key));
const now = () => new Date().toISOString();
const refuse = message => { throw new Fault('failed_precondition', 412, message); };
const admin = async (db, person, request) => {
  if (!await operationsAdmin(db, person, request)) throw new Fault('permission_denied', 403, 'Current workspace administrator sign-in required.');
};
const publicMachine = ({ credential_digest, lease_digest, ...machine }) => machine;
const token = (id, protocol = 'native') => (protocol === 'gitlab' ? 'glrt-' : 'golf_runner_') + id + '_' + Array.from(crypto.getRandomValues(new Uint8Array(32)), b => b.toString(16).padStart(2, '0')).join('');
const hex = bytes => Array.from(new Uint8Array(bytes), b => b.toString(16).padStart(2, '0')).join('');
async function lease(credential, claimId, jobId, generation) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(credential), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return hex(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${claimId}:${jobId}:${generation}`)));
}

export async function nativeRunnerAdmission(db, env, repositoryId) {
  if (env.TEST_WORKFLOW_FORMAT === 'actions-act' && !imageRefOK(env.TEST_IMAGE_REF)) refuse('A pinned Actions image reference is required.');
  const placement = await db.prepare('SELECT * FROM native_runner_placements WHERE repository_id=?').bind(repositoryId).first();
  if (!placement?.pool_id) return null;
  const pool = await db.prepare('SELECT * FROM native_runner_pools WHERE id=?').bind(placement.pool_id).first();
  if (!pool || pool.version !== placement.pool_version || pool.state !== 'ACTIVE' || pool.trust_class !== 'UNTRUSTED' || pool.image_id !== env.TEST_IMAGE_ID)
    refuse('The selected native runner pool changed; rebind or clear repository placement.');
  return { poolId: pool.id, poolVersion: pool.version, placementVersion: placement.version, imageId: pool.image_id };
}

export async function nativeRunnerProgress(db, job, phase) {
  const settle = async state => {
    const changed = await db.prepare("UPDATE evidence_jobs SET test_state=?,updated_at=? WHERE id=? AND test_state IN ('REQUESTED','RUNNING')").bind(state,now(),job.id).run();
    const current = changed.meta.changes === 1 ? state : (await db.prepare('SELECT test_state FROM evidence_jobs WHERE id=?').bind(job.id).first())?.test_state;
    return { id: job.id, state: current || state };
  };
  const machine = await db.prepare('SELECT * FROM native_runner_machines WHERE active_job_id=?').bind(job.id).first();
  if (machine && (machine.lease_expires_at <= Date.now() || machine.state === 'REVOKED' || machine.expires_at <= Date.now())) {
    await db.prepare("UPDATE native_runner_machines SET state=CASE WHEN state='REVOKED' THEN state ELSE 'QUARANTINED' END,cleanup_state='UNKNOWN' WHERE id=? AND active_job_id=?")
      .bind(machine.id,job.id).run();
    const state = job.state === 'REFUSED' ? 'CANCELLED' : 'LOST';
    return settle(state);
  }
  if (phase !== 'finish-tests') {
    if (job.test_state === 'RUNNING' && !machine) {
      return settle('LOST');
    }
    return { id: job.id, state: 'RUNNING' };
  }
  if (machine) await db.prepare("UPDATE native_runner_machines SET state='QUARANTINED',cleanup_state='UNKNOWN' WHERE id=? AND active_job_id=? AND state!='REVOKED'").bind(machine.id,job.id).run();
  const state = job.state === 'REFUSED' ? 'CANCELLED' : 'TIMED_OUT';
  return settle(state);
}

export async function nativeRunnerStop(env, job) {
  const db = env.DB.withSession('first-primary');
  await nativeRunnerProgress(db,job,'finish-tests');
}

export async function nativeRunnerAdmin(db, env, person, request, body) {
  await admin(db, person, request);
  if (body.action === 'list') {
    if (!fields(body, ['action'])) invalid('Use a runner inventory request.');
    // The same bounds as savePool and enroll (20 pools, 100 machines, revoked ones included): pools by name, machines newest first,
    // with the totals and each pool's machine count read in SQL, so a cut list never miscounts or blocks what the bounds allow.
    const pools = (await db.prepare('SELECT p.*,(SELECT COUNT(*) FROM native_runner_machines m WHERE m.pool_id=p.id) AS machine_count FROM native_runner_pools p ORDER BY p.name LIMIT 20').all()).results;
    const machines = (await db.prepare('SELECT * FROM native_runner_machines ORDER BY created_at DESC,id DESC LIMIT 100').all()).results;
    const totals = await db.prepare('SELECT (SELECT COUNT(*) FROM native_runner_pools) AS pools,(SELECT COUNT(*) FROM native_runner_machines) AS machines').first();
    return reply({ pools, machines: machines.map(publicMachine), poolCount: totals.pools, machineCount: totals.machines, poolLimit: 20, machineLimit: 100,
      truncated: totals.pools > pools.length || totals.machines > machines.length });
  }
  if (body.action === 'savePool') {
    if (env.TEST_EXECUTION_ENABLED !== 'true' || !imageOK(env.TEST_IMAGE_ID)) refuse('An approved native runner image is required.');
    if (!fields(body, ['action','id','expectedVersion','name','state','trustClass','maxParallel']) || !uuidOK(body.id) || !versionOK(body.expectedVersion) ||
      !nameOK(body.name) || !['ACTIVE','DRAINING'].includes(body.state) || !['UNTRUSTED','TRUSTED'].includes(body.trustClass) ||
      !Number.isInteger(body.maxParallel) || body.maxParallel < 1 || body.maxParallel > 20) invalid('Use a bounded pool and current version.');
    if (body.expectedVersion === 0) {
      const count = await db.prepare('SELECT COUNT(*) AS total FROM native_runner_pools').first();
      if (count.total >= 20) refuse('Workspace runner pool limit reached.');
      const existing = await db.prepare('SELECT * FROM native_runner_pools WHERE id=?').bind(body.id).first();
      if (existing) refuse('Inspect the existing pool before retrying this ID.');
      await db.prepare('INSERT INTO native_runner_pools(id,name,version,state,trust_class,max_parallel,image_id,created_at) VALUES(?,?,1,?,?,?,?,?)')
        .bind(body.id,body.name,body.state,body.trustClass,body.maxParallel,env.TEST_IMAGE_ID,now()).run();
    } else {
      const current = await db.prepare('SELECT * FROM native_runner_pools WHERE id=?').bind(body.id).first();
      if (!current || current.version !== body.expectedVersion) refuse('Pool configuration changed; refresh before saving.');
      if (current.image_id !== env.TEST_IMAGE_ID && body.state !== 'DRAINING') refuse('Drain the pool before changing its approved image.');
      if (current.trust_class !== body.trustClass || current.image_id !== env.TEST_IMAGE_ID) {
        const active = await db.prepare('SELECT 1 AS busy FROM native_runner_machines WHERE pool_id=? AND active_job_id IS NOT NULL LIMIT 1').bind(body.id).first();
        if (active) refuse('Drain active attempts before changing pool trust or image.');
      }
      const changed = await db.prepare('UPDATE native_runner_pools SET name=?,state=?,trust_class=?,max_parallel=?,image_id=?,version=version+1 WHERE id=? AND version=?')
        .bind(body.name,body.state,body.trustClass,body.maxParallel,env.TEST_IMAGE_ID,body.id,body.expectedVersion).run();
      if (changed.meta.changes !== 1) refuse('Pool configuration changed; refresh before saving.');
    }
    return reply({ pool: await db.prepare('SELECT * FROM native_runner_pools WHERE id=?').bind(body.id).first() });
  }
  if (body.action === 'enroll' || body.action === 'enrollGitLab') {
    if (env.TEST_EXECUTION_ENABLED !== 'true' || !imageOK(env.TEST_IMAGE_ID)) refuse('An approved native runner image is required.');
    if (!fields(body, ['action','id','poolId','poolVersion','name','ttlHours','trustExecution']) || !uuidOK(body.id) || !uuidOK(body.poolId) ||
      !versionOK(body.poolVersion) || !nameOK(body.name) || !Number.isInteger(body.ttlHours) || body.ttlHours < 1 || body.ttlHours > 24 || body.trustExecution !== true)
      invalid('Use a named machine, current pool, 1–24 hour lifetime and explicit execution trust.');
    const pool = await db.prepare('SELECT * FROM native_runner_pools WHERE id=?').bind(body.poolId).first();
    if (!pool || pool.version !== body.poolVersion || pool.state !== 'ACTIVE' || pool.image_id !== env.TEST_IMAGE_ID) refuse('Pool changed or is draining.');
    const count = await db.prepare('SELECT COUNT(*) AS total FROM native_runner_machines').first();
    if (count.total >= 100) refuse('Workspace runner machine limit reached.');
    if (await db.prepare('SELECT 1 AS found FROM native_runner_machines WHERE id=?').bind(body.id).first()) refuse('Inspect the existing machine before retrying this ID.');
    const protocol = body.action === 'enrollGitLab' ? 'gitlab' : 'native';
    const credential = token(body.id, protocol);
    await db.prepare(`INSERT INTO native_runner_machines(id,pool_id,name,version,state,sponsor_id,credential_digest,expires_at,created_at,protocol)
      VALUES(?,?,?,1,'ACTIVE',?,?,?,?,?)`).bind(body.id,body.poolId,body.name,person.id,await digest(credential),Date.now()+body.ttlHours*3600000,now(),protocol).run();
    return reply({ machine: publicMachine(await db.prepare('SELECT * FROM native_runner_machines WHERE id=?').bind(body.id).first()), credential });
  }
  if (body.action === 'rotate') {
    if (env.TEST_EXECUTION_ENABLED !== 'true' || !imageOK(env.TEST_IMAGE_ID)) refuse('An approved native runner image is required.');
    if (!fields(body, ['action','id','expectedVersion','ttlHours']) || !uuidOK(body.id) || !versionOK(body.expectedVersion) ||
      !Number.isInteger(body.ttlHours) || body.ttlHours < 1 || body.ttlHours > 24) invalid('Use the current machine version and 1–24 hour lifetime.');
    const machine = await db.prepare('SELECT * FROM native_runner_machines WHERE id=?').bind(body.id).first();
    if (!machine || machine.version !== body.expectedVersion || machine.state === 'REVOKED' || machine.active_job_id || machine.cleanup_state !== 'CONFIRMED') refuse('Machine changed or cleanup is unconfirmed.');
    const credential = token(body.id, machine.protocol);
    const changed = await db.prepare('UPDATE native_runner_machines SET credential_digest=?,expires_at=?,sponsor_id=?,version=version+1 WHERE id=? AND version=? AND active_job_id IS NULL')
      .bind(await digest(credential),Date.now()+body.ttlHours*3600000,person.id,body.id,body.expectedVersion).run();
    if (changed.meta.changes !== 1) refuse('Machine changed; refresh before rotation.');
    return reply({ machine: publicMachine(await db.prepare('SELECT * FROM native_runner_machines WHERE id=?').bind(body.id).first()), credential });
  }
  if (body.action === 'control') {
    if (!fields(body, ['action','id','expectedVersion','state']) || !uuidOK(body.id) || !versionOK(body.expectedVersion) ||
      !['ACTIVE','DRAINING','REVOKED'].includes(body.state)) invalid('Use a current machine and explicit control state.');
    const machine = await db.prepare('SELECT * FROM native_runner_machines WHERE id=?').bind(body.id).first();
    if (!machine || machine.version !== body.expectedVersion || machine.state === 'REVOKED' ||
      body.state === 'ACTIVE' && machine.cleanup_state !== 'CONFIRMED') refuse('Machine changed or cleanup is unconfirmed.');
    const changed = await db.prepare('UPDATE native_runner_machines SET state=?,version=version+1,cleanup_state=CASE WHEN ?=\'REVOKED\' AND active_job_id IS NOT NULL THEN \'UNKNOWN\' ELSE cleanup_state END WHERE id=? AND version=?')
      .bind(body.state,body.state,body.id,body.expectedVersion).run();
    if (changed.meta.changes !== 1) refuse('Machine changed; refresh before control.');
    return reply({ machine: publicMachine(await db.prepare('SELECT * FROM native_runner_machines WHERE id=?').bind(body.id).first()) });
  }
  if (body.action === 'reconcile') {
    if (!fields(body, ['action','id','expectedVersion','jobId','cleanupConfirmed']) || !uuidOK(body.id) || !versionOK(body.expectedVersion) ||
        !uuidOK(body.jobId) || body.cleanupConfirmed !== true) invalid('Confirm physical cleanup of the exact machine attempt.');
    const machine = await db.prepare('SELECT * FROM native_runner_machines WHERE id=?').bind(body.id).first();
    if (!machine || machine.version !== body.expectedVersion || machine.active_job_id !== body.jobId || machine.cleanup_state !== 'UNKNOWN' ||
        !['QUARANTINED','REVOKED'].includes(machine.state)) refuse('Machine attempt changed or cleanup is already confirmed.');
    const job = await db.prepare('SELECT test_state FROM evidence_jobs WHERE id=?').bind(body.jobId).first();
    if (!job || ['REQUESTED','RUNNING'].includes(job.test_state)) refuse('The exact job is not terminal.');
    const changed = await db.prepare("UPDATE native_runner_machines SET state=CASE WHEN state='QUARANTINED' THEN 'DRAINING' ELSE state END,active_job_id=NULL,claim_id=NULL,lease_digest=NULL,lease_expires_at=NULL,cleanup_state='CONFIRMED',version=version+1 WHERE id=? AND version=? AND active_job_id=? AND cleanup_state='UNKNOWN'")
      .bind(body.id,body.expectedVersion,body.jobId).run();
    if (changed.meta.changes !== 1) refuse('Machine attempt changed; refresh before reconciling.');
    return reply({ machine: publicMachine(await db.prepare('SELECT * FROM native_runner_machines WHERE id=?').bind(body.id).first()) });
  }
  invalid('Unknown native runner operation.');
}

export async function nativeRunnerPlacement(db, env, row, body) {
  if (body.action === 'get') {
    if (!fields(body, ['action','repository','repositoryId'])) invalid('Use a repository placement request.');
    const placement = await db.prepare('SELECT * FROM native_runner_placements WHERE repository_id=?').bind(row.id).first();
    const pools = (await db.prepare("SELECT id,name,version,state,trust_class,max_parallel FROM native_runner_pools WHERE trust_class='UNTRUSTED' ORDER BY name LIMIT 20").all()).results;
    return reply({ placement: placement || { repository_id: row.id, pool_id: null, pool_version: null, version: 0 }, pools, canEdit: row.role === 'admin' });
  }
  if (body.action !== 'set' || !fields(body, ['action','repository','repositoryId','expectedVersion','poolId','poolVersion']) ||
      !versionOK(body.expectedVersion) || !(body.poolId === null || uuidOK(body.poolId)) ||
      (body.poolId === null ? body.poolVersion !== null : !versionOK(body.poolVersion))) invalid('Use a current repository placement and explicit pool selection.');
  if (row.role !== 'admin' || row.write_pending) throw new Fault('permission_denied', 403, 'Current repository administration is required.');
  if (body.poolId) {
    const pool = await db.prepare('SELECT * FROM native_runner_pools WHERE id=?').bind(body.poolId).first();
    if (!pool || pool.version !== body.poolVersion || pool.image_id !== env.TEST_IMAGE_ID) refuse('Selected pool changed; refresh before saving.');
    if (pool.state !== 'ACTIVE') refuse('Selected pool is draining.');
    if (pool.trust_class !== 'UNTRUSTED') refuse('Trusted pools cannot run PR jobs.');
  }
  const current = await db.prepare('SELECT * FROM native_runner_placements WHERE repository_id=?').bind(row.id).first();
  if ((current?.version || 0) !== body.expectedVersion) refuse('Repository placement changed; refresh before saving.');
  const stamp = now();
  const changed = current ? await db.prepare('UPDATE native_runner_placements SET pool_id=?,pool_version=?,version=version+1,updated_at=? WHERE repository_id=? AND version=?')
    .bind(body.poolId,body.poolVersion,stamp,row.id,body.expectedVersion).run() :
    await db.prepare('INSERT INTO native_runner_placements(repository_id,pool_id,pool_version,version,updated_at) VALUES(?,?,?,1,?)')
      .bind(row.id,body.poolId,body.poolVersion,stamp).run();
  if (changed.meta.changes !== 1) refuse('Repository placement changed; refresh before saving.');
  return reply({ placement: await db.prepare('SELECT * FROM native_runner_placements WHERE repository_id=?').bind(row.id).first() });
}

export async function machineIdentity(db, request) {
  const match = /^Bearer ((golf_runner_|glrt-)([a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12})_[a-f0-9]{64})$/.exec(request.headers.get('Authorization') || '');
  if (!match) throw new Fault('unauthenticated', 401, 'Runner credential required.');
  const machine = await db.prepare('SELECT * FROM native_runner_machines WHERE id=?').bind(match[3]).first();
  if (!machine || machine.protocol !== (match[2] === 'glrt-' ? 'gitlab' : 'native') || machine.credential_digest !== await digest(match[1]) || machine.expires_at <= Date.now() ||
      !['ACTIVE','DRAINING'].includes(machine.state)) throw new Fault('permission_denied', 403, 'Runner identity unavailable.');
  const sponsor = await db.prepare('SELECT 1 AS allowed FROM operations_admins a JOIN users u ON u.id=a.user_id WHERE a.user_id=? AND a.active=1 AND u.active=1').bind(machine.sponsor_id).first();
  if (!sponsor) throw new Fault('permission_denied', 403, 'Runner sponsor authorization ended.');
  return { machine, credential: match[1] };
}
async function assignment(db, env, machine, credential) {
  if (!machine.active_job_id || !machine.claim_id || !machine.lease_digest || machine.lease_expires_at <= Date.now()) return null;
  const job = await db.prepare('SELECT * FROM evidence_jobs WHERE id=?').bind(machine.active_job_id).first();
  if (!job || job.state !== 'QUEUED' || job.test_state !== 'RUNNING') return null;
  const execution = JSON.parse(job.snapshot).execution;
  const source = execution?.runner;
  if (!source || source.poolId !== machine.pool_id || source.imageId !== env.TEST_IMAGE_ID || execution.workflow && !nativeWorkflowPlanOK(execution.workflow.plan)) return null;
  const snapshot = JSON.parse(job.snapshot);
  const secret = await lease(credential,machine.claim_id,job.id,machine.attempt_generation);
  if (await digest(secret) !== machine.lease_digest) return null;
  return { contract: execution.contract, jobId: job.id, generation: machine.attempt_generation, lease: secret,
    leaseExpiresAt: machine.lease_expires_at, deadline: Date.parse(job.expires_at), commitId: execution.commitId,
    treeId: execution.treeId, branch: execution.branch, imageId: source.imageId, policySha256: execution.policySha256,
    ...(execution.workflow?.plan.format === 'actions-act' ? { imageRef: env.TEST_IMAGE_REF, pullRequestNumber: snapshot.selection.number, baseCommitId: snapshot.selection.baseCommitId, ...(execution.build ? { build: true } : {}) } : {}),
    ...(execution.workflow ? { workflow: execution.workflow, workflowSha256: execution.workflowSha256 } : { module: execution.module }),
    cloneUrl: `${env.PUBLIC_ORIGIN}/native/runner-machine/${job.id}/git` };
}
async function activeJob(db, machine, request, jobId, authorize) {
  if (!uuidOK(jobId) || machine.active_job_id !== jobId || !machine.lease_digest || machine.lease_expires_at <= Date.now() ||
      await digest(request.headers.get('X-Golf-Runner-Lease') || '') !== machine.lease_digest || !await authorize(jobId))
    throw new Fault('permission_denied', 403, 'Runner attempt is no longer authorized.');
  const job = await db.prepare('SELECT * FROM evidence_jobs WHERE id=?').bind(jobId).first();
  if (!job || job.state !== 'QUEUED' || job.test_state !== 'RUNNING' || Date.parse(job.expires_at) <= Date.now())
    throw new Fault('permission_denied', 403, 'Runner attempt is no longer active.');
  return job;
}

export async function nativeRunnerMachine(db, env, request, body, authorize, git) {
  const { machine, credential } = await machineIdentity(db, request);
  const url = new URL(request.url), prefix = '/native/runner-machine/';
  const suffix = url.pathname.slice(prefix.length);
  if (suffix === 'claim' && request.method === 'POST') {
    if (!body || !fields(body, ['claimId','actionsCatalog','socketlessBuild']) || !uuidOK(body.claimId) ||
        body.actionsCatalog !== undefined && body.actionsCatalog !== nativeActionsCatalog || body.socketlessBuild !== undefined && body.socketlessBuild !== true) invalid('Use one stable claim ID and pinned Actions catalog.');
    if (machine.active_job_id) {
      if (machine.claim_id !== body.claimId) return reply({ assignment: null });
      const interrupted = await db.prepare('SELECT state,test_state FROM evidence_jobs WHERE id=?').bind(machine.active_job_id).first();
      if (interrupted?.state === 'QUEUED' && interrupted.test_state === 'REQUESTED' && await authorize(machine.active_job_id))
        await db.prepare("UPDATE evidence_jobs SET test_state='RUNNING',updated_at=? WHERE id=? AND state='QUEUED' AND test_state='REQUESTED'").bind(now(),machine.active_job_id).run();
      const previous = await assignment(db, env, machine, credential);
      if (!previous) refuse('Prior claim needs cleanup reconciliation.');
      return reply({ assignment: previous });
    }
    if (machine.state !== 'ACTIVE' || machine.cleanup_state !== 'CONFIRMED') return reply({ assignment: null });
    const pool = await db.prepare('SELECT * FROM native_runner_pools WHERE id=?').bind(machine.pool_id).first();
    if (!pool || pool.state !== 'ACTIVE' || pool.trust_class !== 'UNTRUSTED' || pool.image_id !== env.TEST_IMAGE_ID) return reply({ assignment: null });
    const candidates = (await db.prepare("SELECT * FROM evidence_jobs WHERE state='QUEUED' AND test_state='REQUESTED' AND expires_at>? ORDER BY created_at,id LIMIT 20").bind(now()).all()).results;
    for (const job of candidates) {
      const execution = JSON.parse(job.snapshot).execution;
      if (execution?.runner?.poolId !== pool.id || machine.expires_at <= Date.parse(job.expires_at) ||
          machine.protocol === 'gitlab' && execution.workflow?.plan?.format !== 'gitlab' ||
          execution.workflow?.plan?.format === 'actions-act' && body.actionsCatalog !== nativeActionsCatalog ||
          execution.build && body.socketlessBuild !== true) continue;
      const placement = await db.prepare('SELECT * FROM native_runner_placements WHERE repository_id=?').bind(job.repository_id).first();
      if (!placement || placement.pool_id !== pool.id || placement.pool_version !== execution.runner.poolVersion ||
          placement.version !== execution.runner.placementVersion || pool.version !== execution.runner.poolVersion || execution.runner.imageId !== pool.image_id) {
        await db.prepare("UPDATE evidence_jobs SET state='REFUSED',updated_at=? WHERE id=? AND state='QUEUED' AND test_state='REQUESTED'").bind(now(),job.id).run();
        continue;
      }
      if (!await authorize(job.id)) continue;
      const generation = machine.attempt_generation + 1, secret = await lease(credential,body.claimId,job.id,generation);
      // shortcut: stock Runner has no Golf heartbeat, fence its lease at the job deadline.
      const expires = Math.min(machine.expires_at,Date.parse(job.expires_at),machine.protocol === 'gitlab' ? Date.parse(job.expires_at) : Date.now()+90000);
      const changed = await db.prepare(`UPDATE native_runner_machines SET active_job_id=?,attempt_generation=?,claim_id=?,lease_digest=?,lease_expires_at=?,cleanup_state='UNKNOWN',last_seen_at=?
        WHERE id=? AND active_job_id IS NULL AND state='ACTIVE' AND cleanup_state='CONFIRMED'
          AND (SELECT COUNT(*) FROM native_runner_machines WHERE pool_id=? AND active_job_id IS NOT NULL)<(SELECT max_parallel FROM native_runner_pools WHERE id=?)
          AND NOT EXISTS(SELECT 1 FROM native_runner_machines WHERE active_job_id=?)
          AND EXISTS(SELECT 1 FROM native_runner_pools WHERE id=? AND version=? AND state='ACTIVE' AND trust_class='UNTRUSTED' AND image_id=?)
          AND EXISTS(SELECT 1 FROM native_runner_placements WHERE repository_id=? AND pool_id=? AND pool_version=? AND version=?)
          AND EXISTS(SELECT 1 FROM evidence_jobs WHERE id=? AND state='QUEUED' AND test_state='REQUESTED' AND expires_at>?)`)
        .bind(job.id,generation,body.claimId,await digest(secret),expires,now(),machine.id,pool.id,pool.id,job.id,pool.id,execution.runner.poolVersion,pool.image_id,job.repository_id,pool.id,execution.runner.poolVersion,execution.runner.placementVersion,job.id,now()).run();
      if (changed.meta.changes !== 1) return reply({ assignment: null });
      const started = await db.prepare("UPDATE evidence_jobs SET test_state='RUNNING',updated_at=? WHERE id=? AND state='QUEUED' AND test_state='REQUESTED'").bind(now(),job.id).run();
      if (started.meta.changes !== 1) refuse('Runner claim needs reconciliation.');
      const current = await db.prepare('SELECT * FROM native_runner_machines WHERE id=?').bind(machine.id).first();
      const result = await assignment(db, env, current, credential);
      if (!result) refuse('Runner claim needs reconciliation.');
      return reply({ assignment: result });
    }
    return reply({ assignment: null });
  }
  const match = /^([a-f0-9-]{36})\/(heartbeat|finish|git(?:\/info\/refs|\/git-upload-pack)?)$/.exec(suffix);
  if (!match || !uuidOK(match[1])) throw new Fault('not_found', 404, 'Runner operation unavailable.');
  const [, jobId, operation] = match;
  if (operation === 'finish' && !machine.active_job_id && request.method === 'POST' && body) {
    const completed = await db.prepare('SELECT test_result FROM evidence_jobs WHERE id=?').bind(jobId).first();
    const result = completed?.test_result ? JSON.parse(completed.test_result) : null;
    if (result?.producer?.machineId === machine.id && result.producer.generation === machine.attempt_generation &&
        result.producer.resultHash === await digest(JSON.stringify(body))) return reply({ result });
  }
  if (operation.startsWith('git')) {
    if (!['GET','POST'].includes(request.method)) invalid('Use the Git upload-pack method.');
    await activeJob(db,machine,request,jobId,authorize);
    const job = await db.prepare('SELECT repository_id FROM evidence_jobs WHERE id=?').bind(jobId).first();
    const row = await db.prepare('SELECT artifact_name FROM repositories WHERE id=?').bind(job.repository_id).first();
    const base = remote(env,row.artifact_name), path = operation === 'git/info/refs' ? '/info/refs?service=git-upload-pack' : '/git-upload-pack';
    if (operation === 'git/info/refs' && (request.method !== 'GET' || url.search !== '?service=git-upload-pack') ||
        operation === 'git/git-upload-pack' && (request.method !== 'POST' || url.search) || operation === 'git') invalid('Invalid Git operation.');
    const headers = new Headers();
    if (request.headers.has('Git-Protocol')) headers.set('Git-Protocol',request.headers.get('Git-Protocol'));
    if (request.headers.has('Content-Encoding')) headers.set('Content-Encoding',request.headers.get('Content-Encoding'));
    const source = new Request(base+path,{method:request.method,headers,...(request.method==='POST'?{body:await bounded(request.body,1024*1024)}:{})});
    return git(jobId,source);
  }
  if (request.method !== 'POST' || !body) invalid('Use a bounded runner request.');
  const job = await activeJob(db,machine,request,jobId,authorize);
  if (operation === 'heartbeat') {
    if (!fields(body, [])) invalid('Use an empty heartbeat.');
    const expires = Math.min(machine.expires_at,Date.parse(job.expires_at),Date.now()+90000);
    const changed = await db.prepare('UPDATE native_runner_machines SET lease_expires_at=?,last_seen_at=? WHERE id=? AND active_job_id=? AND lease_digest=?')
      .bind(expires,now(),machine.id,jobId,machine.lease_digest).run();
    if (changed.meta.changes !== 1) refuse('Runner lease changed.');
    return reply({ leaseExpiresAt: expires, deadline: Date.parse(job.expires_at) });
  }
  if (!fields(body, ['state','exitCode','stdout','stderr','cleanup','build']) || body.cleanup !== 'confirmed' ||
      !['PASSED','FAILED','TIMED_OUT','LOST'].includes(body.state)) invalid('Confirm exact bounded runner result and local cleanup.');
  return nativeRunnerComplete(db, machine, job, body);
}

export async function nativeRunnerComplete(db, machine, job, body, completion = null) {
  if (!fields(body, ['state','exitCode','stdout','stderr','cleanup','build']) || body.cleanup !== 'confirmed' ||
      !['PASSED','FAILED','TIMED_OUT','LOST'].includes(body.state)) invalid('Confirm exact bounded runner result and local cleanup.');
  const jobId = job.id;
  const execution = JSON.parse(job.snapshot).execution;
  const value = { ...body, contract: execution.contract, jobId, commitId: execution.commitId, treeId: execution.treeId,
    policySha256: execution.policySha256, ...(execution.workflow ? { workflowSha256: execution.workflowSha256 } : { module: execution.module }),
    cleanup: 'destroyed', deniedRequests: 0, finishedAt: Date.now(), ...(body.state==='LOST'?{failureStage:'test',diagnostic:'Customer runner reported an infrastructure failure.'}:{}) };
  const safe = testResult(value,jobId,execution);
  safe.producer = { kind: 'customer-runner', machineId: machine.id, generation: machine.attempt_generation, cleanup: 'asserted', resultHash: await digest(JSON.stringify(body)) };
  const receipt = JSON.stringify(safe);
  const statements = [
    db.prepare("UPDATE evidence_jobs SET test_state=?,test_result=?,updated_at=? WHERE id=? AND state='QUEUED' AND test_state='RUNNING' AND EXISTS(SELECT 1 FROM native_runner_machines WHERE id=? AND active_job_id=? AND lease_digest=? AND state IN ('ACTIVE','DRAINING'))")
      .bind(safe.state,receipt,now(),jobId,machine.id,jobId,machine.lease_digest),
    db.prepare("UPDATE native_runner_machines SET active_job_id=NULL,claim_id=NULL,lease_digest=NULL,lease_expires_at=NULL,cleanup_state='CONFIRMED',last_seen_at=? WHERE id=? AND active_job_id=? AND lease_digest=? AND EXISTS(SELECT 1 FROM evidence_jobs WHERE id=? AND test_result=?)")
      .bind(now(),machine.id,jobId,machine.lease_digest,jobId,receipt),
  ];
  if (completion) statements.push(db.prepare('UPDATE gitlab_runner_jobs SET completed_state=?,completed_exit_code=? WHERE id=? AND completed_state IS NULL AND evidence_job_id=? AND machine_id=?')
    .bind(completion.state,completion.exitCode,completion.id,jobId,machine.id));
  const results = await db.batch(statements);
  if (results.some(result => result.meta.changes !== 1)) refuse('Runner completion changed; inspect the original result.');
  return reply({ result: safe });
}
