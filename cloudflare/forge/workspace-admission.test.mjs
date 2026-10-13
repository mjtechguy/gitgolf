import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { serialize, concurrentRead } from './src/core.mjs';

globalThis.golfAdmissionTest = { serialize, concurrentRead };
const hooks = registerHooks({ resolve(specifier, context, next) {
  let source;
  if (specifier === 'cloudflare:workers') source = 'export class DurableObject {constructor(ctx,env){this.ctx=ctx;this.env=env}} export class WorkerEntrypoint extends DurableObject{} export class WorkflowEntrypoint extends DurableObject{}';
  if (specifier === './core.mjs' && context.parentURL.endsWith('/src/worker.mjs')) source = `
    export const {serialize,concurrentRead}=globalThis.golfAdmissionTest;
    export const handle=(request,env)=>env.handle(request);
    export const advanceEvidence=(env,id,phase,workflows)=>env.background(id,phase,workflows);
    export const activityAuthority=(request,env,input)=>env.handle(request);
    export const testGit=()=>{},testRegistry=()=>{},registryExecution=()=>{},agentGit=()=>{},servePreview=()=>{},cleanupPreviews=()=>{},runCI=()=>{};`;
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
  const workspace = new Workspace({ storage: { sql: { exec() {} } }, exports: {}, waitUntil() {} }, env);
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

test('authority admission remains bounded under slow readers and preserves write ordering', async () => {
  const f = fixture(), hold = deferred(); let reads = 0;
  const original = f.workspace.configured.handle;
  f.workspace.configured.handle = async req => { if (new URL(req.url).pathname.endsWith('/GetRepositoryAccess')) { reads++; await hold.promise; } return original(req); };
  const active = Array.from({length:8},()=>f.workspace.fetch(request('GetRepositoryAccess'))); await tick(); assert.equal(reads,8);
  const write = f.workspace.fetch(request('RevokeRepositoryCollaborator'));
  const queued = Array.from({length:127},()=>f.workspace.fetch(request('GetRepositoryAccess')));
  assert.equal((await f.workspace.fetch(request('GetRepositoryAccess'))).status,429);
  hold.resolve(); await Promise.all(active); await write;
  assert.ok((await Promise.all(queued)).every(r=>r.status===200));
  assert.equal(await (await f.workspace.fetch(request('GetRepositoryAccess'))).text(),'denied');
});

// cf exposes workflows through ctx.exports; Alchemy emits an environment binding.
test('both deployment paths pass the real workflow binding to evidence admission', async () => {
  const exported = { create() {} }, bound = { create() {} };
  for (const [exports, binding, expected] of [[{ EvidenceWorkflow: exported }, undefined, exported], [{}, bound, bound], [{ EvidenceWorkflow: exported }, bound, bound]]) {
    let observed;
    const workspace = new Workspace({ storage: { sql: { exec() {} } }, exports, waitUntil() {} }, {
      EvidenceWorkflow: binding, background: async (id, phase, workflows) => { observed = workflows; return {}; },
    });
    await workspace.evidence('job', 'start');
    assert.equal(observed, expected);
  }
});
