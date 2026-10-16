import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFile } from 'node:fs/promises';
import { nativeRunnerAdmin, nativeRunnerPlacement, nativeRunnerMachine, nativeRunnerProgress } from './src/native-runners.mjs';
import { digest } from './src/common.mjs';
import { nativeActionsBuildContract, nativeActionsCatalog, nativeActionsContract, nativeWorkflow, nativeWorkflowContract } from './src/native-workflow.mjs';
import { publicEvidenceExecution } from './src/evidence.mjs';

test('native evidence reports identify the pinned Actions catalog without exposing a shell plan', () => {
  const source = { contract: nativeActionsBuildContract, workflow: { path: '.github/workflows/pr.yml', blobId: 'a'.repeat(40), plan: { format: 'actions-act', catalog: nativeActionsCatalog } } };
  assert.deepEqual(publicEvidenceExecution(source).workflow, { path: source.workflow.path, blobId: source.workflow.blobId, format: 'actions-act', catalog: nativeActionsCatalog });
  assert.deepEqual(publicEvidenceExecution({ contract: nativeWorkflowContract, workflow: { path: '.gitlab-ci.yml', blobId: 'b'.repeat(40), plan: { format: 'gitlab', jobId: 'check', steps: [{ run: 'private script' }] } } }).workflow,
    { path: '.gitlab-ci.yml', blobId: 'b'.repeat(40), format: 'gitlab', jobId: 'check' });
});

async function fixture(t) {
  const sql = new DatabaseSync(':memory:'); t.after(() => sql.close());
  sql.exec(await readFile(new URL('./schema.sql', import.meta.url), 'utf8'));
  sql.exec("INSERT INTO users(id,login,email) VALUES(1,'admin','admin@example.invalid'),(2,'writer','writer@example.invalid'); INSERT INTO operations_admins(user_id) VALUES(1); INSERT INTO repositories(id,name,description,artifact_name,creator_id,creation_key,input_hash,state,created_at) VALUES(1,'project','','repo',1,'key','hash','ACTIVE','2026-10-12T00:00:00Z'); INSERT INTO grants VALUES(1,1,'admin'),(1,2,'write')");
  const db = { prepare(query) { const statement = sql.prepare(query); let values = []; return {
    bind(...input) { values = input; return this; }, async first() { return statement.get(...values) || null; },
    async all() { return { results: statement.all(...values) }; }, async run() { return { meta: { changes: statement.run(...values).changes } }; },
  }; }, async batch(statements) { sql.exec('BEGIN'); try { const results = []; for (const statement of statements) results.push(await statement.run()); sql.exec('COMMIT'); return results; } catch (error) { sql.exec('ROLLBACK'); throw error; } } };
  const env = { TEST_EXECUTION_ENABLED: 'true', TEST_IMAGE_ID: 'sha256:' + 'a'.repeat(64) };
  const person = { id: 1, email: 'admin@example.invalid' };
  const request = new Request('https://golf.example.invalid/native/runner-admin', { headers: { 'X-Golf-Native-Access-Email': person.email } });
  const call = async body => (await nativeRunnerAdmin(db, env, person, request, body)).json();
  return { sql, db, env, person, request, call };
}

test('native pools and machines use versioned controls and one-time credentials', async t => {
  const f = await fixture(t), poolId = crypto.randomUUID(), machineId = crypto.randomUUID();
  const saved = await f.call({ action: 'savePool', id: poolId, expectedVersion: 0, name: 'linux', state: 'ACTIVE', trustClass: 'UNTRUSTED', maxParallel: 2 });
  assert.equal(saved.pool.version, 1); assert.equal(saved.pool.image_id, f.env.TEST_IMAGE_ID);
  await assert.rejects(f.call({ action: 'savePool', id: poolId, expectedVersion: 0, name: 'linux', state: 'ACTIVE', trustClass: 'UNTRUSTED', maxParallel: 2 }), /existing pool/);
  const enrolled = await f.call({ action: 'enroll', id: machineId, poolId, poolVersion: 1, name: 'box-1', ttlHours: 4, trustExecution: true });
  assert.match(enrolled.credential, /^golf_runner_[a-f0-9-]{36}_[a-f0-9]{64}$/);
  assert.equal(f.sql.prepare('SELECT credential_digest FROM native_runner_machines WHERE id=?').get(machineId).credential_digest, await digest(enrolled.credential));
  const inventory = await f.call({ action: 'list' });
  assert.equal(inventory.pools.length, 1); assert.equal(inventory.machines.length, 1);
  assert.equal(JSON.stringify(inventory).includes(enrolled.credential), false);
  assert.equal(JSON.stringify(inventory).includes(await digest(enrolled.credential)), false);
  const rotated = await f.call({ action: 'rotate', id: machineId, expectedVersion: 1, ttlHours: 8 });
  assert.notEqual(rotated.credential, enrolled.credential);
  assert.equal(rotated.machine.version, 2);
  await assert.rejects(f.call({ action: 'rotate', id: machineId, expectedVersion: 1, ttlHours: 8 }), /changed/);
  const draining = await f.call({ action: 'control', id: machineId, expectedVersion: 2, state: 'DRAINING' });
  assert.equal(draining.machine.state, 'DRAINING');
  const revoked = await f.call({ action: 'control', id: machineId, expectedVersion: 3, state: 'REVOKED' });
  assert.equal(revoked.machine.state, 'REVOKED');
  await assert.rejects(f.call({ action: 'control', id: machineId, expectedVersion: 4, state: 'ACTIVE' }), /changed/);
  f.env.TEST_IMAGE_ID = 'sha256:'+'d'.repeat(64);
  await assert.rejects(f.call({ action:'savePool', id:poolId, expectedVersion:1, name:'linux', state:'ACTIVE', trustClass:'UNTRUSTED', maxParallel:2 }),/Drain/);
  const reimaged = await f.call({ action:'savePool', id:poolId, expectedVersion:1, name:'linux', state:'DRAINING', trustClass:'UNTRUSTED', maxParallel:2 });
  assert.equal(reimaged.pool.image_id,f.env.TEST_IMAGE_ID); assert.equal(reimaged.pool.version,2);
  const bearer = new Request(f.request.url, { headers: { Authorization: 'Bearer golf_native_fake', 'X-Golf-Native-Access-Email': f.person.email } });
  await assert.rejects(nativeRunnerAdmin(f.db, f.env, f.person, bearer, { action: 'list' }), /administrator sign-in/);
});

test('the runner inventory returns at most its bounds, newest machines first, with totals and per-pool counts read in SQL', async t => {
  const f = await fixture(t), pool = f.sql.prepare("INSERT INTO native_runner_pools(id,name,version,state,trust_class,max_parallel,image_id,created_at) VALUES(?,?,1,'ACTIVE','UNTRUSTED',1,'img','t')");
  for (let i = 0; i < 3; i++) pool.run('p' + i, 'pool-' + i);
  const machine = f.sql.prepare("INSERT INTO native_runner_machines(id,pool_id,name,version,state,sponsor_id,credential_digest,expires_at,created_at) VALUES(?,?,?,1,'ACTIVE',1,?,9999999999,?)");
  for (let i = 0; i < 101; i++) machine.run('m' + String(i).padStart(3, '0'), i === 0 ? 'p1' : 'p0', 'host-' + i, 'c' + i, new Date(Date.UTC(2026, 9, 1) + i * 60_000).toISOString());
  const inventory = await f.call({ action: 'list' });
  assert.deepEqual([inventory.pools.length, inventory.machines.length, inventory.poolCount, inventory.machineCount, inventory.truncated], [3, 100, 3, 101, true]);
  // The oldest host is the one left out, and the pool table still counts it.
  assert.equal(inventory.machines[0].name, 'host-100');
  assert.equal(inventory.machines.some(m => m.name === 'host-0'), false);
  assert.deepEqual(inventory.pools.map(p => [p.name, p.machine_count]), [['pool-0', 100], ['pool-1', 1], ['pool-2', 0]]);
});

test('native machine claim, heartbeat and result bind one source and one cleanup receipt', async t => {
  const f = await fixture(t), poolId = crypto.randomUUID(), machineId = crypto.randomUUID(), jobId = crypto.randomUUID();
  await f.call({ action: 'savePool', id: poolId, expectedVersion: 0, name: 'native', state: 'ACTIVE', trustClass: 'UNTRUSTED', maxParallel: 1 });
  const machine = await f.call({ action: 'enroll', id: machineId, poolId, poolVersion: 1, name: 'host', ttlHours: 1, trustExecution: true });
  const spare = await f.call({ action: 'enroll', id: crypto.randomUUID(), poolId, poolVersion: 1, name: 'spare', ttlHours: 1, trustExecution: true });
  await nativeRunnerPlacement(f.db,f.env,{ id: 1, role: 'admin' },{ action: 'set', repository: { owner: 'workspace', name: 'project' }, repositoryId: '1', expectedVersion: 0, poolId, poolVersion: 1 });
  const workflow = { path: '.github/workflows/verify.yml', blobId: 'f'.repeat(40), plan: nativeWorkflow('actions','on: pull_request\njobs:\n  check:\n    runs-on: golf-native-linux\n    steps:\n      - run: echo ok\n') };
  const execution = { contract: nativeWorkflowContract, commitId: 'a'.repeat(40), treeId: 'b'.repeat(40), branch: 'feature',
    workflow, workflowSha256: await digest(JSON.stringify(workflow)), policySha256: 'c'.repeat(64),
    runner: { poolId, poolVersion: 1, placementVersion: 1, imageId: f.env.TEST_IMAGE_ID } };
  const stamp = new Date().toISOString(), expires = new Date(Date.now()+600000).toISOString();
  f.sql.prepare("INSERT INTO evidence_jobs(id,repository_id,user_id,operation_key,input_hash,snapshot,advice_state,created_at,updated_at,expires_at,test_state) VALUES(?,1,1,'job','hash',?,'NONE',?,?,?,'REQUESTED')")
    .run(jobId,JSON.stringify({ execution }),stamp,stamp,expires);
  const origin = 'https://golf.example.invalid/native/runner-machine/';
  const call = async (path, body, lease, credential = machine.credential) => nativeRunnerMachine(f.db,{ ...f.env, PUBLIC_ORIGIN: 'https://golf.example.invalid' },
    new Request(origin+path,{method:'POST',headers:{Authorization:'Bearer '+credential, ...(lease?{'X-Golf-Runner-Lease':lease}:{})}}),body,async()=>true,()=>assert.fail('No Git request expected'));
  const claimId = crypto.randomUUID();
  const claimed = await (await call('claim',{ claimId })).json();
  assert.equal(claimed.assignment.jobId,jobId); assert.equal(claimed.assignment.contract,nativeWorkflowContract);
  assert.equal(claimed.assignment.workflowSha256,execution.workflowSha256);
  assert.equal(claimed.assignment.imageId,f.env.TEST_IMAGE_ID);
  assert.equal((await (await call('claim',{ claimId })).json()).assignment.lease,claimed.assignment.lease);
  assert.equal((await (await call('claim',{ claimId: crypto.randomUUID() })).json()).assignment,null);
  assert.equal((await (await call('claim',{ claimId: crypto.randomUUID() },'',spare.credential)).json()).assignment,null);
  const renewed = await (await call(jobId+'/heartbeat',{},claimed.assignment.lease)).json();
  assert.ok(renewed.leaseExpiresAt > Date.now());
  const pendingJob = f.sql.prepare('SELECT * FROM evidence_jobs WHERE id=?').get(jobId);
  const completed = {state:'PASSED',exitCode:0,stdout:'ok\n',stderr:'',cleanup:'confirmed'};
  const result = await (await call(jobId+'/finish',completed,claimed.assignment.lease)).json();
  assert.equal(result.result.state,'PASSED'); assert.equal(result.result.producer.machineId,machineId);
  assert.equal(result.result.producer.cleanup,'asserted');
  assert.equal(f.sql.prepare('SELECT test_state FROM evidence_jobs WHERE id=?').get(jobId).test_state,'PASSED');
  assert.equal(f.sql.prepare('SELECT active_job_id FROM native_runner_machines WHERE id=?').get(machineId).active_job_id,null);
  assert.deepEqual(await nativeRunnerProgress(f.db,pendingJob,'tests'),{id:jobId,state:'PASSED'});
  assert.deepEqual(await nativeRunnerProgress(f.db,pendingJob,'finish-tests'),{id:jobId,state:'PASSED'});
  assert.deepEqual((await (await call(jobId+'/finish',completed,claimed.assignment.lease)).json()).result,result.result);
  await assert.rejects(call(jobId+'/finish',{...completed,stdout:'changed'},claimed.assignment.lease),/no longer authorized/);
  await assert.rejects(call(jobId+'/heartbeat',{},claimed.assignment.lease),/no longer authorized/);
  await assert.rejects(call('claim',{claimId:crypto.randomUUID()},'','golf_runner_'+machineId+'_'+'0'.repeat(64)),/identity unavailable/);
  const waiting = [crypto.randomUUID(),crypto.randomUUID()];
  for (const [index,id] of waiting.entries()) f.sql.prepare("INSERT INTO evidence_jobs(id,repository_id,user_id,operation_key,input_hash,snapshot,advice_state,created_at,updated_at,expires_at,test_state) VALUES(?,1,1,?,'hash',?,'NONE',?,?,?,'REQUESTED')")
    .run(id,'parallel-'+index,JSON.stringify({execution}),stamp,stamp,expires);
  const claims = await Promise.all([call('claim',{claimId:crypto.randomUUID()}),call('claim',{claimId:crypto.randomUUID()},'',spare.credential)]);
  const assignments = await Promise.all(claims.map(response => response.json()));
  assert.equal(assignments.filter(value => value.assignment).length,1);
  assert.equal(f.sql.prepare('SELECT COUNT(*) AS total FROM native_runner_machines WHERE active_job_id IS NOT NULL').get().total,1);
  assert.equal(f.sql.prepare("SELECT COUNT(*) AS total FROM evidence_jobs WHERE id IN (?,?) AND test_state='RUNNING'").get(...waiting).total,1);
});

test('pinned act PR jobs require a catalog-capable native machine', async t => {
  const f=await fixture(t),poolId=crypto.randomUUID(),machineId=crypto.randomUUID(),jobId=crypto.randomUUID();
  f.env.PUBLIC_ORIGIN='https://golf.example.invalid';
  f.env.TEST_IMAGE_REF='alpine:3.23@sha256:85fe1e81d6758c208f3e1eed4338a1997e19d4be002d4dd32d3100c9a8c010a0';
  await f.call({action:'savePool',id:poolId,expectedVersion:0,name:'act',state:'ACTIVE',trustClass:'UNTRUSTED',maxParallel:1});
  const enrolled=await f.call({action:'enroll',id:machineId,poolId,poolVersion:1,name:'act-host',ttlHours:1,trustExecution:true});
  await nativeRunnerPlacement(f.db,f.env,{id:1,role:'admin'},{action:'set',repository:{owner:'workspace',name:'project'},repositoryId:'1',expectedVersion:0,poolId,poolVersion:1});
  const workflow={path:'.github/workflows/verify.yml',blobId:'f'.repeat(40),plan:{format:'actions-act',catalog:nativeActionsCatalog}};
  const execution={contract:nativeActionsContract,commitId:'a'.repeat(40),treeId:'b'.repeat(40),branch:'feature',workflow,
    workflowSha256:await digest(JSON.stringify(workflow)),policySha256:'c'.repeat(64),runner:{poolId,poolVersion:1,placementVersion:1,imageId:f.env.TEST_IMAGE_ID}};
  const stamp=new Date().toISOString();
  f.sql.prepare("INSERT INTO evidence_jobs(id,repository_id,user_id,operation_key,input_hash,snapshot,advice_state,created_at,updated_at,expires_at,test_state) VALUES(?,1,1,'act-job','hash',?,'NONE',?,?,?,'REQUESTED')")
    .run(jobId,JSON.stringify({execution,selection:{number:7,baseCommitId:'d'.repeat(40)}}),stamp,stamp,new Date(Date.now()+600000).toISOString());
  const request=new Request(f.env.PUBLIC_ORIGIN+'/native/runner-machine/claim',{method:'POST',headers:{Authorization:'Bearer '+enrolled.credential}});
  const call=async body=>(await nativeRunnerMachine(f.db,f.env,request,body,async()=>true,()=>assert.fail())).json();
  assert.equal((await call({claimId:crypto.randomUUID()})).assignment,null);
  const claimed=await call({claimId:crypto.randomUUID(),actionsCatalog:nativeActionsCatalog});
  assert.equal(claimed.assignment.contract,nativeActionsContract);
  assert.equal(claimed.assignment.imageRef,f.env.TEST_IMAGE_REF);
  assert.equal(claimed.assignment.pullRequestNumber,7);
  assert.equal(claimed.assignment.baseCommitId,'d'.repeat(40));
  await assert.rejects(call({claimId:crypto.randomUUID(),actionsCatalog:'other'}),/pinned Actions catalog/);
  const finish=new Request(f.env.PUBLIC_ORIGIN+'/native/runner-machine/'+jobId+'/finish',{method:'POST',headers:{Authorization:'Bearer '+enrolled.credential,'X-Golf-Runner-Lease':claimed.assignment.lease}});
  assert.equal((await (await nativeRunnerMachine(f.db,f.env,finish,{state:'PASSED',exitCode:0,stdout:'ok',stderr:'',cleanup:'confirmed'},async()=>true,()=>assert.fail())).json()).result.state,'PASSED');
  const buildId=crypto.randomUUID(),withBuild={...execution,contract:nativeActionsBuildContract,build:true};
  f.sql.prepare("INSERT INTO evidence_jobs(id,repository_id,user_id,operation_key,input_hash,snapshot,advice_state,created_at,updated_at,expires_at,test_state) VALUES(?,1,1,'build-job','hash',?,'NONE',?,?,?,'REQUESTED')")
    .run(buildId,JSON.stringify({execution:withBuild,selection:{number:7,baseCommitId:'d'.repeat(40)}}),stamp,stamp,new Date(Date.now()+600000).toISOString());
  assert.equal((await call({claimId:crypto.randomUUID(),actionsCatalog:nativeActionsCatalog})).assignment,null);
  const buildClaim=await call({claimId:crypto.randomUUID(),actionsCatalog:nativeActionsCatalog,socketlessBuild:true});
  assert.equal(buildClaim.assignment.build,true);
  const buildFinish=new Request(f.env.PUBLIC_ORIGIN+'/native/runner-machine/'+buildId+'/finish',{method:'POST',headers:{Authorization:'Bearer '+enrolled.credential,'X-Golf-Runner-Lease':buildClaim.assignment.lease}});
  const receipt={digest:'sha256:'+'e'.repeat(64),bytes:1024,dockerfile:'Dockerfile',sourceCommit:execution.commitId};
  const built=await (await nativeRunnerMachine(f.db,f.env,buildFinish,{state:'PASSED',exitCode:0,stdout:'ok',stderr:'',cleanup:'confirmed',build:receipt},async()=>true,()=>assert.fail())).json();
  assert.deepEqual(built.result.build,receipt);
});

test('lost heartbeat quarantines capacity and prevents late success', async t => {
  const f = await fixture(t), poolId = crypto.randomUUID(), machineId = crypto.randomUUID(), jobId = crypto.randomUUID();
  await f.call({ action: 'savePool', id: poolId, expectedVersion: 0, name: 'lost', state: 'ACTIVE', trustClass: 'UNTRUSTED', maxParallel: 1 });
  const enrolled = await f.call({ action: 'enroll', id: machineId, poolId, poolVersion: 1, name: 'lost-host', ttlHours: 1, trustExecution: true });
  await nativeRunnerPlacement(f.db,f.env,{ id: 1, role: 'admin' },{ action: 'set', repository: { owner: 'workspace', name: 'project' }, repositoryId: '1', expectedVersion: 0, poolId, poolVersion: 1 });
  const workflow = { path: '.gitlab-ci.yml', blobId: 'f'.repeat(40), plan: nativeWorkflow('gitlab','check:\n  script: echo ok\n') };
  const execution = { contract: nativeWorkflowContract, commitId: 'a'.repeat(40), treeId: 'b'.repeat(40), branch: 'feature', workflow,
    workflowSha256: await digest(JSON.stringify(workflow)), policySha256: 'c'.repeat(64),
    runner: { poolId, poolVersion: 1, placementVersion: 1, imageId: f.env.TEST_IMAGE_ID } };
  const stamp = new Date().toISOString();
  f.sql.prepare("INSERT INTO evidence_jobs(id,repository_id,user_id,operation_key,input_hash,snapshot,advice_state,created_at,updated_at,expires_at,test_state) VALUES(?,1,1,'lost-job','hash',?,'NONE',?,?,?,'REQUESTED')")
    .run(jobId,JSON.stringify({ execution }),stamp,stamp,new Date(Date.now()+600000).toISOString());
  const request = new Request('https://golf.example.invalid/native/runner-machine/claim',{method:'POST',headers:{Authorization:'Bearer '+enrolled.credential}});
  const claimed = await (await nativeRunnerMachine(f.db,{...f.env,PUBLIC_ORIGIN:'https://golf.example.invalid'},request,{claimId:crypto.randomUUID()},async()=>true,()=>assert.fail())).json();
  assert.equal(claimed.assignment.jobId,jobId);
  f.sql.prepare('UPDATE native_runner_machines SET lease_expires_at=? WHERE id=?').run(Date.now()-1,machineId);
  const job = f.sql.prepare('SELECT * FROM evidence_jobs WHERE id=?').get(jobId);
  assert.deepEqual(await nativeRunnerProgress(f.db,job,'tests'),{id:jobId,state:'LOST'});
  const quarantined = f.sql.prepare('SELECT state,cleanup_state,active_job_id FROM native_runner_machines WHERE id=?').get(machineId);
  assert.equal(quarantined.state,'QUARANTINED'); assert.equal(quarantined.cleanup_state,'UNKNOWN'); assert.equal(quarantined.active_job_id,jobId);
  assert.equal(f.sql.prepare('SELECT test_state FROM evidence_jobs WHERE id=?').get(jobId).test_state,'LOST');
  await assert.rejects(nativeRunnerMachine(f.db,f.env,request,{claimId:crypto.randomUUID()},async()=>true,()=>assert.fail()),/identity unavailable/);
  const reconciled = await f.call({ action:'reconcile',id:machineId,expectedVersion:1,jobId,cleanupConfirmed:true });
  assert.equal(reconciled.machine.state,'DRAINING'); assert.equal(reconciled.machine.cleanup_state,'CONFIRMED');
  assert.equal(reconciled.machine.active_job_id,null);
});

test('repository placement pins an active untrusted pool and refuses stale edits', async t => {
  const f = await fixture(t), poolId = crypto.randomUUID(), trustedId = crypto.randomUUID();
  await f.call({ action: 'savePool', id: poolId, expectedVersion: 0, name: 'pr-linux', state: 'ACTIVE', trustClass: 'UNTRUSTED', maxParallel: 1 });
  await f.call({ action: 'savePool', id: trustedId, expectedVersion: 0, name: 'protected', state: 'ACTIVE', trustClass: 'TRUSTED', maxParallel: 1 });
  const row = { id: 1, role: 'admin', write_pending: null };
  const get = () => nativeRunnerPlacement(f.db, f.env, row, { action: 'get', repository: { owner: 'workspace', name: 'project' }, repositoryId: '1' });
  const initial = await (await get()).json();
  assert.equal(initial.placement.version, 0); assert.equal(initial.pools.length, 1);
  const base = { action: 'set', repository: { owner: 'workspace', name: 'project' }, repositoryId: '1', expectedVersion: 0 };
  await assert.rejects(nativeRunnerPlacement(f.db, f.env, row, { ...base, poolId: trustedId, poolVersion: 1 }), /Trusted pools/);
  const selected = await (await nativeRunnerPlacement(f.db, f.env, row, { ...base, poolId, poolVersion: 1 })).json();
  assert.equal(selected.placement.pool_id, poolId); assert.equal(selected.placement.pool_version, 1);
  await assert.rejects(nativeRunnerPlacement(f.db, f.env, row, { ...base, poolId, poolVersion: 1 }), /changed/);
  await assert.rejects(nativeRunnerPlacement(f.db, f.env, { ...row, role: 'write' }, { ...base, expectedVersion: 1, poolId: null, poolVersion: null }), /administration/);
  const edited = await f.call({ action: 'savePool', id: poolId, expectedVersion: 1, name: 'pr-linux', state: 'DRAINING', trustClass: 'UNTRUSTED', maxParallel: 1 });
  assert.equal(edited.pool.version, 2);
  await assert.rejects(nativeRunnerPlacement(f.db, f.env, row, { ...base, expectedVersion: 1, poolId, poolVersion: 2 }), /draining/);
  const cleared = await (await nativeRunnerPlacement(f.db, f.env, row, { ...base, expectedVersion: 1, poolId: null, poolVersion: null })).json();
  assert.equal(cleared.placement.pool_id, null); assert.equal(cleared.placement.version, 2);
});

test('leased Git proxy strips machine authority and only permits exact upload-pack reads', async t => {
  const f = await fixture(t), poolId = crypto.randomUUID(), machineId = crypto.randomUUID(), jobId = crypto.randomUUID();
  f.env.PUBLIC_ORIGIN = 'https://golf.example.invalid'; f.env.ACCOUNT_ID = 'a'.repeat(32); f.env.ARTIFACTS_NAMESPACE = 'golf-tests';
  f.sql.prepare('UPDATE repositories SET artifact_name=? WHERE id=1').run('repo-'+'b'.repeat(32));
  await f.call({ action:'savePool', id:poolId, expectedVersion:0, name:'git-pool', state:'ACTIVE', trustClass:'UNTRUSTED', maxParallel:1 });
  const enrolled = await f.call({ action:'enroll', id:machineId, poolId, poolVersion:1, name:'git-host', ttlHours:1, trustExecution:true });
  await nativeRunnerPlacement(f.db,f.env,{ id:1,role:'admin' },{action:'set',repository:{owner:'workspace',name:'project'},repositoryId:'1',expectedVersion:0,poolId,poolVersion:1});
  const workflow = { path:'.gitlab-ci.yml', blobId:'f'.repeat(40), plan:nativeWorkflow('gitlab','check:\n  script: echo ok\n') };
  const execution = { contract:nativeWorkflowContract, commitId:'a'.repeat(40),treeId:'b'.repeat(40),branch:'feature',workflow,
    workflowSha256:await digest(JSON.stringify(workflow)),policySha256:'c'.repeat(64),runner:{poolId,poolVersion:1,placementVersion:1,imageId:f.env.TEST_IMAGE_ID} };
  const stamp = new Date().toISOString();
  f.sql.prepare("INSERT INTO evidence_jobs(id,repository_id,user_id,operation_key,input_hash,snapshot,advice_state,created_at,updated_at,expires_at,test_state) VALUES(?,1,1,'git-job','hash',?,'NONE',?,?,?,'REQUESTED')")
    .run(jobId,JSON.stringify({execution}),stamp,stamp,new Date(Date.now()+600000).toISOString());
  const base = `${f.env.PUBLIC_ORIGIN}/native/runner-machine/`;
  const invoke = (path, request, body, git) => nativeRunnerMachine(f.db,f.env,request,body,async()=>true,git);
  const claimed = await (await invoke('claim',new Request(base+'claim',{method:'POST',headers:{Authorization:'Bearer '+enrolled.credential}}),{claimId:crypto.randomUUID()},()=>assert.fail())).json();
  const headers = { Authorization:'Bearer '+enrolled.credential,'X-Golf-Runner-Lease':claimed.assignment.lease };
  let seen = 0;
  const git = async (id, source) => { seen++; assert.equal(id,jobId); assert.equal(source.headers.has('Authorization'),false); assert.equal(source.headers.has('X-Golf-Runner-Lease'),false);
    assert.equal(source.url, `https://${f.env.ACCOUNT_ID}.artifacts.cloudflare.net/git/golf-tests/repo-${'b'.repeat(32)}.git/info/refs?service=git-upload-pack`); return new Response('git-ok'); };
  const read = new Request(base+jobId+'/git/info/refs?service=git-upload-pack',{headers});
  assert.equal(await (await invoke('',read,null,git)).text(),'git-ok'); assert.equal(seen,1);
  await assert.rejects(invoke('',new Request(base+jobId+'/git/info/refs?service=receive-pack',{headers}),null,git),/Invalid Git operation/);
  await assert.rejects(invoke('',new Request(base+jobId+'/git/info/refs?service=git-upload-pack',{headers:{...headers,'X-Golf-Runner-Lease':'0'.repeat(64)}}),null,git),/no longer authorized/);
  assert.equal(seen,1);
});

test('cancel before claim records cancellation without starting a managed container', async t => {
  const f = await fixture(t), jobId = crypto.randomUUID(), stamp = new Date().toISOString();
  f.sql.prepare("INSERT INTO evidence_jobs(id,repository_id,user_id,operation_key,input_hash,snapshot,advice_state,state,created_at,updated_at,expires_at,test_state) VALUES(?,1,1,'cancel-job','hash','{}','NONE','REFUSED',?,?,?,'REQUESTED')")
    .run(jobId,stamp,stamp,new Date(Date.now()+600000).toISOString());
  const job = f.sql.prepare('SELECT * FROM evidence_jobs WHERE id=?').get(jobId);
  assert.deepEqual(await nativeRunnerProgress(f.db,job,'finish-tests'),{id:jobId,state:'CANCELLED'});
  assert.equal(f.sql.prepare('SELECT test_state FROM evidence_jobs WHERE id=?').get(jobId).test_state,'CANCELLED');
});

test('cancelling an active machine attempt fences its lease and quarantine remains until cleanup', async t => {
  const f = await fixture(t), poolId = crypto.randomUUID(), machineId = crypto.randomUUID(), jobId = crypto.randomUUID();
  await f.call({action:'savePool',id:poolId,expectedVersion:0,name:'cancel-pool',state:'ACTIVE',trustClass:'UNTRUSTED',maxParallel:1});
  const enrolled = await f.call({action:'enroll',id:machineId,poolId,poolVersion:1,name:'cancel-host',ttlHours:1,trustExecution:true});
  await nativeRunnerPlacement(f.db,f.env,{id:1,role:'admin'},{action:'set',repository:{owner:'workspace',name:'project'},repositoryId:'1',expectedVersion:0,poolId,poolVersion:1});
  const workflow = {path:'.gitlab-ci.yml',blobId:'f'.repeat(40),plan:nativeWorkflow('gitlab','verify:\n  script: echo ok\n')};
  const execution = {contract:nativeWorkflowContract,commitId:'a'.repeat(40),treeId:'b'.repeat(40),branch:'feature',workflow,workflowSha256:await digest(JSON.stringify(workflow)),policySha256:'c'.repeat(64),runner:{poolId,poolVersion:1,placementVersion:1,imageId:f.env.TEST_IMAGE_ID}};
  const stamp = new Date().toISOString();
  f.sql.prepare("INSERT INTO evidence_jobs(id,repository_id,user_id,operation_key,input_hash,snapshot,advice_state,created_at,updated_at,expires_at,test_state) VALUES(?,1,1,'cancel-active','hash',?,'NONE',?,?,?,'REQUESTED')")
    .run(jobId,JSON.stringify({execution}),stamp,stamp,new Date(Date.now()+600000).toISOString());
  const origin = 'https://golf.example.invalid/native/runner-machine/';
  const request = (path,lease) => new Request(origin+path,{method:'POST',headers:{Authorization:'Bearer '+enrolled.credential,...(lease?{'X-Golf-Runner-Lease':lease}:{})}});
  const claimed = await (await nativeRunnerMachine(f.db,{...f.env,PUBLIC_ORIGIN:'https://golf.example.invalid'},request('claim'),{claimId:crypto.randomUUID()},async()=>true,()=>assert.fail())).json();
  f.sql.prepare("UPDATE evidence_jobs SET state='REFUSED' WHERE id=?").run(jobId);
  const job = f.sql.prepare('SELECT * FROM evidence_jobs WHERE id=?').get(jobId);
  assert.deepEqual(await nativeRunnerProgress(f.db,job,'finish-tests'),{id:jobId,state:'CANCELLED'});
  const fenced = f.sql.prepare('SELECT state,cleanup_state FROM native_runner_machines WHERE id=?').get(machineId);
  assert.equal(fenced.state,'QUARANTINED'); assert.equal(fenced.cleanup_state,'UNKNOWN');
  await assert.rejects(nativeRunnerMachine(f.db,f.env,request(jobId+'/finish',claimed.assignment.lease),{state:'PASSED',exitCode:0,stdout:'',stderr:'',cleanup:'confirmed'},async()=>true,()=>assert.fail()),/identity unavailable/);
  const recovered = await f.call({action:'reconcile',id:machineId,expectedVersion:1,jobId,cleanupConfirmed:true});
  assert.equal(recovered.machine.cleanup_state,'CONFIRMED'); assert.equal(recovered.machine.state,'DRAINING');
});
