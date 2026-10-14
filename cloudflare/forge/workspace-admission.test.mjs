import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { serialize, admission, concurrentRead } from './src/core.mjs';

globalThis.golfAdmissionTest = { serialize, admission, concurrentRead };
const hooks = registerHooks({ resolve(specifier, context, next) {
  let source;
  if (specifier === 'cloudflare:workers') source = 'export class DurableObject {constructor(ctx,env){this.ctx=ctx;this.env=env}} export class WorkerEntrypoint extends DurableObject{} export class WorkflowEntrypoint extends DurableObject{}';
  if (specifier === './core.mjs' && context.parentURL.endsWith('/src/worker.mjs')) source = `
    export const {serialize,admission,concurrentRead}=globalThis.golfAdmissionTest;
    export const handle=(request,env)=>env.handle(request);
    export const advanceEvidence=(env,id,phase,workflows)=>env.background(id,phase,workflows);
    export const advanceAi=()=>{};
    export const advanceSearch=()=>{};
    export const activityAuthority=(request,env,input)=>env.handle(request);
    export const testGit=()=>{},testRegistry=()=>{},registryExecution=()=>{},agentGit=()=>{},servePreview=()=>{},cleanupPreviews=()=>{},runCI=env=>env.ci?.();`;
  return source ? { url: 'data:text/javascript,' + encodeURIComponent(source), shortCircuit: true } : next(specifier, context);
} });
const { Workspace } = await import('./src/worker.mjs');
hooks.deregister(); delete globalThis.golfAdmissionTest;
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const tick = () => new Promise(r => setImmediate(r));
const request = method => new Request('https://golf.test/rpc/golf.v1.RepositoryAccessService/' + method, { method: 'POST', body: '{}' });
function fixture() {
  const background = deferred(), started = deferred(), events = [];
  let allowed = true;
  const env = { DB: { withSession: () => ({ prepare: () => ({ bind() { return this; }, all: async () => ({results:[]}) }) }) },
    background: async () => { events.push('background'); started.resolve(); await background.promise; return {}; },
    handle: async req => { const method = new URL(req.url).pathname.split('/').at(-1); events.push(method); if (method === 'RevokeRepositoryCollaborator') allowed = false; return new Response(allowed ? 'allowed' : 'denied'); } };
  const workspace = new Workspace({ storage: { sql: { exec() {} }, getAlarm: async () => 1, setAlarm: async () => {} }, exports: {}, waitUntil() {} }, env);
  return { workspace, env, background, started, events };
}

test('current authority reads bypass blocked background work but cannot overtake a queued client revocation', async () => {
  const f = fixture(), work = f.workspace.evidence('job', 'advice'); await f.started.promise;
  const before = f.workspace.fetch(request('GetRepositoryAccess'));
  await tick(); assert.deepEqual(f.events, ['background','GetRepositoryAccess']); assert.equal(await (await before).text(), 'allowed');
  const revoke = f.workspace.fetch(request('RevokeRepositoryCollaborator'));
  let finished = false;
  const after = f.workspace.fetch(request('GetRepositoryAccess')).then(r => { finished = true; return r; });
  await tick(); assert.equal(finished, false); assert.equal(f.events.includes('RevokeRepositoryCollaborator'), false);
  f.background.resolve(); await work; await revoke;
  assert.equal(await (await after).text(), 'denied');
  assert.deepEqual(f.events, ['background','GetRepositoryAccess','RevokeRepositoryCollaborator','GetRepositoryAccess']);
});

test('unknown client writes also fence authority and failed writes release the admission queue', async () => {
  const f = fixture(), work = f.workspace.evidence('job','publish-app'); await f.started.promise;
  const original = f.env.handle;
  // The configured environment captures the handler when the Workspace is constructed.
  f.workspace.configured.handle = async req => { if (new URL(req.url).pathname.endsWith('/UnknownWrite')) throw Error('failed write'); return original(req); };
  const write = f.workspace.fetch(request('UnknownWrite')).catch(e => e.message);
  let finished = false;
  const read = f.workspace.fetch(request('GetRepositoryAccess')).then(r => { finished = true; return r; });
  await tick(); assert.equal(finished, false);
  f.background.resolve(); await work; assert.equal(await write, 'failed write'); assert.equal(await (await read).text(), 'allowed');
});

test('native evidence and preview reads overlap without passing pending revocations', async () => {
  const f = fixture(), hold = deferred(), entered = [];
  const original = f.workspace.configured.handle;
  f.workspace.configured.handle = async req => {
    if (new URL(req.url).pathname.endsWith('/read')) { entered.push(req.url); await hold.promise; }
    return original(req);
  };
  const read = path => new Request('https://golf.test/native/' + path, { method: 'POST', body: '{}' });
  const before = ['pr-evidence/read','pr-preview/read'].map(path => f.workspace.fetch(read(path)));
  await tick(); assert.equal(entered.length, 2);
  const revoke = f.workspace.fetch(request('RevokeRepositoryCollaborator'));
  const after = f.workspace.fetch(read('pr-preview/read'));
  await tick(); assert.equal(entered.length, 2);
  hold.resolve();
  assert.deepEqual(await Promise.all(before.map(async r => (await r).text())), ['allowed','allowed']);
  await revoke; assert.equal(await (await after).text(), 'denied');
  // Mixed-action routes remain exclusive, even when the caller claims a read.
  for (const path of ['pr-evidence','pr-preview','pr-evidence/read/','pr-preview/read-extra']) assert.equal(concurrentRead(read(path)), false);
  assert.equal(concurrentRead(new Request('https://golf.test/native/pr-evidence/read')), false);
});

test('native reads cannot slip past a revocation waiting in the authority queue', async () => {
  const f = fixture(), hold = deferred();
  const original = f.workspace.configured.handle;
  f.workspace.configured.handle = async req => {
    if (new URL(req.url).pathname.endsWith('/GetRepositoryAccess')) await hold.promise;
    return original(req);
  };
  const authority = f.workspace.fetch(request('GetRepositoryAccess'));
  await tick();
  const revoke = f.workspace.fetch(request('RevokeRepositoryCollaborator'));
  let completed = false;
  const after = f.workspace.fetch(new Request('https://golf.test/native/pr-evidence/read', { method: 'POST', body: '{}' })).then(r => { completed = true; return r; });
  await tick(); assert.equal(completed, false); assert.deepEqual(f.events, []);
  hold.resolve(); await authority; await revoke;
  assert.equal(await (await after).text(), 'denied');
});

test('authority admission remains bounded under slow readers and preserves write ordering', async () => {
  const f = fixture(), hold = deferred(); let reads = 0;
  const original = f.workspace.configured.handle;
  f.workspace.configured.handle = async req => { if (new URL(req.url).pathname.endsWith('/GetRepositoryAccess')) { reads++; await hold.promise; } return original(req); };
  const active = Array.from({length:8},()=>f.workspace.fetch(request('GetRepositoryAccess'))); await tick(); assert.equal(reads,8);
  const write = f.workspace.fetch(request('RevokeRepositoryCollaborator'));
  const queued = Array.from({length:511},()=>f.workspace.fetch(request('GetRepositoryAccess')));
  assert.equal((await f.workspace.fetch(request('GetRepositoryAccess'))).status,429);
  hold.resolve(); await Promise.all(active); await write;
  assert.ok((await Promise.all(queued)).every(r=>r.status===200));
  assert.equal(await (await f.workspace.fetch(request('GetRepositoryAccess'))).text(),'denied');
});

test('admission classes: transfers overlap reads and each other within their limits; an exclusive waits for all and fences later ones', async () => {
  const hold = deferred(), started = [], active = { read: 0, transfer: 0, exclusive: 0 }, peak = { read: 0, transfer: 0 };
  let alone;
  const run = serialize(async item => {
    started.push(item.name); active[item.kind]++;
    if (item.kind === 'exclusive') alone = active.read + active.transfer === 0;
    else peak[item.kind] = Math.max(peak[item.kind], active[item.kind]);
    if (item.name.startsWith('held')) await hold.promise;
    active[item.kind]--; return item.name;
  }, item => item.kind);
  const held = [...Array.from({ length: 25 }, (_, i) => ({ kind: 'transfer', name: 'held-t' + i })), ...Array.from({ length: 9 }, (_, i) => ({ kind: 'read', name: 'held-r' + i }))].map(run);
  await tick(); assert.equal(started.length, 32); assert.deepEqual([active.transfer, active.read], [24, 8]);
  const exclusive = run({ kind: 'exclusive', name: 'revoke' }), later = [run({ kind: 'transfer', name: 'push' }), run({ kind: 'read', name: 'read' })];
  await tick(); assert.equal(started.length, 32);
  hold.resolve(); await Promise.all([...held, exclusive, ...later]);
  assert.equal(alone, true); assert.deepEqual(peak, { read: 8, transfer: 24 });
  assert.deepEqual(started.slice(-3).sort(), ['push', 'read', 'revoke'].sort()); assert.equal(started.at(-3), 'revoke');
  // A boolean classifier still means read or exclusive; the queue holds 512 before refusing.
  const gate = deferred(), legacy = serialize(async () => { await gate.promise; }, item => item === 'read');
  const first = Array.from({ length: 9 }, () => legacy('read')), blocked = legacy('write');
  const queued = Array.from({ length: 510 }, () => legacy('read'));
  await assert.rejects(legacy('read'), /busy/);
  gate.resolve(); await Promise.all([...first, blocked, ...queued]);
});

test('admission classifies Smart HTTP Git as a transfer and nothing else', () => {
  const git = (path, method = 'POST') => admission(new Request('https://golf.test' + path, { method, ...(method === 'POST' ? { body: '' } : {}) }));
  assert.equal(git('/git/alice/project.git/info/refs?service=git-upload-pack', 'GET'), 'transfer');
  assert.equal(git('/git/alice/project.git/git-upload-pack'), 'transfer');
  assert.equal(git('/git/alice/project.git/git-receive-pack'), 'transfer');
  assert.equal(git('/native/agent-host/tasks/' + crypto.randomUUID() + '/git/git-receive-pack'), 'transfer');
  assert.equal(git('/git/alice/project.git/info/refs'), 'exclusive');
  assert.equal(git('/git/alice/project.git/git-receive-pack', 'GET'), 'exclusive');
  assert.equal(git('/git/alice/project.git/other'), 'exclusive');
  assert.equal(admission(request('GetRepositoryAccess')), 'read');
  assert.equal(admission(request('RevokeRepositoryCollaborator')), 'exclusive');
  assert.equal(admission({ ci: true }), 'exclusive');
});

test('pushes overlap each other and reads in both workspace queues; revocations and background work never overlap a push', async () => {
  const f = fixture(), hold = deferred(), entered = [], waits = [];
  let ci = 0;
  f.workspace.env.CI_AUTO = 'true'; f.workspace.ctx.waitUntil = promise => waits.push(promise); f.workspace.configured.ci = () => { ci++; };
  const original = f.workspace.configured.handle;
  f.workspace.configured.handle = async req => {
    if (new URL(req.url).pathname.startsWith('/git/')) { entered.push(new URL(req.url).pathname.split('/')[3]); f.events.push('push'); await hold.promise; f.events.push('pushed'); return new Response('ok'); }
    return original(req);
  };
  const push = name => f.workspace.fetch(new Request(`https://golf.test/git/alice/${name}.git/git-receive-pack`, { method: 'POST', body: 'x' }));
  const pushes = [push('one'), push('two'), f.workspace.fetch(new Request('https://golf.test/git/alice/three.git/info/refs?service=git-upload-pack'))];
  await tick(); assert.deepEqual(entered, ['one.git', 'two.git', 'three.git']);
  assert.equal(await (await f.workspace.fetch(request('GetRepositoryAccess'))).text(), 'allowed');
  const revoke = f.workspace.fetch(request('RevokeRepositoryCollaborator')), background = f.workspace.evidence('job', 'advice'), late = push('four');
  await tick(); assert.equal(entered.length, 3); assert.equal(f.events.includes('RevokeRepositoryCollaborator'), false); assert.equal(f.events.includes('background'), false);
  hold.resolve(); f.background.resolve(); await Promise.all([...pushes, revoke, background, late]);
  assert.deepEqual(f.events, ['push', 'push', 'push', 'GetRepositoryAccess', 'pushed', 'pushed', 'pushed', 'background', 'RevokeRepositoryCollaborator', 'push', 'pushed']);
  // CI_AUTO still runs CI after every receive-pack response.
  await Promise.all(waits); assert.equal(ci, 3);
});

// cf exposes workflows through ctx.exports; Alchemy emits an environment binding.
test('both deployment paths pass the real workflow binding to evidence admission', async () => {
  const exported = { create() {} }, bound = { create() {} };
  for (const [exports, binding, expected] of [[{ EvidenceWorkflow: exported }, undefined, exported], [{}, bound, bound], [{ EvidenceWorkflow: exported }, bound, bound]]) {
    let observed;
    const workspace = new Workspace({ storage: { sql: { exec() {} }, getAlarm: async () => 1, setAlarm: async () => {} }, exports, waitUntil() {} }, {
      EvidenceWorkflow: binding, background: async (id, phase, workflows) => { observed = workflows; return {}; },
    });
    await workspace.evidence('job', 'start');
    assert.equal(observed, expected);
  }
});

function heartbeatFixture(existingAlarm, extra = {}) {
  const statements = [], alarms = [], kv = new Map(), waits = [];
  const statement = sql => ({ bind(...values) { statements.push([sql, values]); return this; }, run: async () => ({ meta: { changes: 1 } }), first: async () => null, all: async () => ({ results: [] }) });
  const db = { prepare: statement, batch: async () => [] };
  const storage = { sql: { exec() {} }, kv: { get: key => kv.get(key), put: (key, value) => kv.set(key, value) }, getAlarm: async () => existingAlarm, setAlarm: async at => { alarms.push(at); } };
  const workspace = new Workspace({ storage, exports: {}, waitUntil: promise => waits.push(promise) }, { DB: { ...db, withSession: () => db }, handle: async () => new Response('ok'), background: async () => ({}), ...extra });
  const stages = () => statements.filter(([sql]) => sql.startsWith('INSERT INTO operations_maintenance')).map(([, values]) => values[0]);
  return { workspace, alarms, waits, stages, statements };
}

test('the workspace arms one maintenance alarm and keeps an existing one', async () => {
  const fresh = heartbeatFixture(null); await Promise.all(fresh.waits);
  assert.equal(fresh.alarms.length, 1); assert.ok(Math.abs(fresh.alarms[0] - Date.now() - 300000) < 5000);
  const armed = heartbeatFixture(12345); await Promise.all(armed.waits);
  assert.deepEqual(armed.alarms, []);
});

test('the alarm repeats maintenance only while no scheduled run has reported in', async () => {
  const f = heartbeatFixture(1);
  await f.workspace.alarm();
  assert.deepEqual(f.stages(), ['ci', 'previews', 'evidence', 'indexes']);
  assert.equal(f.alarms.length, 1); assert.ok(Math.abs(f.alarms[0] - Date.now() - 300000) < 5000);
  f.workspace.scheduleRan();
  await f.workspace.alarm();
  assert.equal(f.stages().length, 4);
  assert.equal(f.alarms.length, 2);
  const realNow = Date.now;
  try { Date.now = () => realNow() + 11 * 60_000; await f.workspace.alarm(); } finally { Date.now = realNow; }
  assert.equal(f.stages().length, 8);
});

test('the alarm also drains configured email, journalled apart from the fixed stages', async () => {
  const f = heartbeatFixture(1, { ACCESS_AUD: 'aud', EMAIL: { send() {} }, EMAIL_POLICY: JSON.stringify({ sender: 'golf@mail.golf.example.com', dailyLimit: 5 }) });
  await f.workspace.alarm();
  assert.deepEqual(f.stages(), ['ci', 'previews', 'evidence', 'indexes']);
  assert.ok(f.statements.some(([sql, values]) => sql.startsWith('INSERT INTO email_maintenance') && values[0] === 'email'));
});

test('a value release never overlaps a client revocation and asks the job authorization first', async () => {
  const f = fixture(), phases = [], id = crypto.randomUUID();
  let hold = deferred();
  f.workspace.configured.handle = async () => { f.events.push('revoke'); await hold.promise; f.events.push('revoked'); return new Response('revoked'); };
  f.workspace.configured.background = async (job, phase) => { f.events.push('authorize'); phases.push([job, phase]); await hold.promise; f.events.push('answered'); return { state: 'REFUSED' }; };
  // A revocation that is being applied finishes before the release looks at anything.
  let revoke = f.workspace.fetch(request('RevokeRepositoryCollaborator')); await tick();
  let release = f.workspace.testValues(id); await tick();
  assert.deepEqual(f.events, ['revoke']);
  hold.resolve(); await revoke; assert.deepEqual(await release, { state: 'REFUSED' });
  assert.deepEqual(f.events, ['revoke', 'revoked', 'authorize', 'answered']); assert.deepEqual(phases, [[id, 'authorize-test']]);
  // And a release in progress finishes before a revocation starts: the two never interleave.
  f.events.length = 0; hold = deferred();
  release = f.workspace.testValues(id); await tick();
  revoke = f.workspace.fetch(request('RevokeRepositoryCollaborator')); await tick();
  assert.deepEqual(f.events, ['authorize']);
  hold.resolve(); await release; await revoke;
  assert.deepEqual(f.events, ['authorize', 'answered', 'revoke', 'revoked']);
  await assert.rejects(f.workspace.testValues('not-a-job'), /Invalid value release/);
});

test('a workspace object left behind by a rename stops its own maintenance alarm', async () => {
  let deleted = 0; const statements = [];
  const db = { prepare: sql => ({ bind() { statements.push(sql); return this; }, run: async () => ({ meta: { changes: 1 } }), first: async () => null, all: async () => ({ results: [] }) }), batch: async () => [] };
  const storage = { sql: { exec() {} }, kv: { get: () => undefined, put() {} }, getAlarm: async () => 1, setAlarm: async () => {}, deleteAlarm: async () => { deleted++; } };
  const workspace = new Workspace({ id: { name: 'alice' }, storage, exports: {}, waitUntil() {} }, { WORKSPACE_SLUG: 'mj', DB: { ...db, withSession: () => db } });
  await workspace.alarm();
  assert.equal(deleted, 1); assert.equal(statements.length, 0);
});
