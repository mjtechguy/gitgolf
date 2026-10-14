import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { nativeTestContract, testResult } from './src/test-policy.mjs';
import { nativeWorkflow, nativeWorkflowContract } from './src/native-workflow.mjs';

const hooks = registerHooks({ resolve(specifier, context, next) {
  if (specifier === 'cloudflare:workers') return { url: 'data:text/javascript,' + encodeURIComponent('export class DurableObject {constructor(ctx,env){this.ctx=ctx;this.env=env}} export class WorkerEntrypoint extends DurableObject {}'), shortCircuit: true };
  if (specifier === '@cloudflare/sandbox') return { url: 'data:text/javascript,' + encodeURIComponent('export class Files {constructor(container){this.container=container} readFile(path){return new Response(this.container.files[path] || "")}}'), shortCircuit: true };
  return next(specifier, context);
} });
const { PRTestTask, TestOutbound } = await import('./src/test-worker.mjs');
hooks.deregister();

function fixture() {
  const store = new Map(), commands = [];
  let destroyed = 0, brokered = 0, authorized = true;
  const input = { contract: nativeTestContract, jobId: crypto.randomUUID(), commitId: 'a'.repeat(40), treeId: 'b'.repeat(40), branch: 'feature', module: 'test_calc',
    policySha256: 'e'.repeat(64),
    remote: `https://${'c'.repeat(32)}.artifacts.cloudflare.net/git/test-space/repo-${'d'.repeat(32)}.git`, deadline: Date.now() + 600000 };
  const container = { images: { agent: 'image' }, files: { '/workspace/task/stderr': 'Ran 2 tests\nOK\n' }, running: false,
    interceptAllOutboundHttp: async () => {}, interceptOutboundHttps: async () => {},
    start(options) { assert.equal(options.enableInternet, false); this.running = true; },
    monitor: () => new Promise(() => {}), setInactivityTimeout: async () => {},
    destroy: async () => { destroyed++; },
    exec: async (args, options) => {
      commands.push(args); assert.equal(options.user, '1000:1000'); assert.equal(options.env.GIT_CONFIG_VALUE_0, '');
      let output = '';
      if (args[0] === 'git' && args[1] === 'rev-parse') output = args[2] === 'HEAD' ? input.commitId : input.treeId;
      return { output: async () => ({ exitCode: 0, stdout: new TextEncoder().encode(output), stderr: new Uint8Array() }) };
    } };
  const owner = { evidence: async () => ({ state: authorized ? 'AUTHORIZED' : 'REFUSED' }), testGit: async () => { brokered++; return new Response('git'); } };
  const ctx = { container, storage: { kv: { get: k => store.get(k), put: (k, v) => store.set(k, v) }, setAlarm: async () => {}, deleteAlarm: async () => {} },
    waitUntil: () => {}, blockConcurrencyWhile: fn => fn(), exports: { Workspace: { getByName: () => owner }, TestOutbound: () => ({}) } };
  return { owner, task: new PRTestTask(ctx, { WORKSPACE_SLUG: 'team' }), input, commands, container, counters: () => ({ destroyed, brokered }), revoke: () => { authorized = false; } };
}

test('native test task executes once, checks exact source and destroys before publishing results', async () => {
  const f = fixture();
  await f.task.create(f.input); await f.task.create(f.input);
  await assert.rejects(f.task.create({ ...f.input, module: 'other' }), /identity conflict/);
  await f.task.alarm();
  const result = f.task.status();
  assert.equal(result.state, 'PASSED'); assert.equal(result.cleanup, 'destroyed'); assert.equal(f.counters().destroyed, 1);
  assert.equal(result.stderr, 'Ran 2 tests\nOK\n');
  assert.equal(f.commands.filter(args => args[0] === '/bin/sh').length, 1);
  assert.deepEqual(testResult(result, f.input.jobId, f.input), result);
  assert.throws(() => testResult({ ...result, contract: 'golf.native.pr-test.v2' }, f.input.jobId, f.input), /Invalid test execution/);
  await f.task.alarm(); await f.task.create(f.input); await f.task.cancel();
  assert.equal(f.commands.filter(args => args[0] === '/bin/sh').length, 1);
});

test('a restarted dispatch fails closed, and cancellation denies all later outbound requests', async () => {
  const f = fixture(); await f.task.create(f.input);
  f.task.record = { ...f.task.record, state: 'RUNNING', stage: 'clone' };
  assert.equal((await f.task.outbound(new Request(f.input.remote))).status, 200);
  await f.task.alarm();
  assert.equal(f.task.status().state, 'LOST'); assert.equal(f.commands.length, 0);
  assert.equal((await f.task.outbound(new Request(f.input.remote))).status, 403);
  assert.equal(f.counters().brokered, 1);
  const next = fixture(); await next.task.create(next.input); next.revoke(); await next.task.alarm();
  assert.equal(next.task.status().state, 'CANCELLED'); assert.equal(next.commands.length, 0);
});

test('cleanup failures cannot expose success, module injection is rejected before admission', async () => {
  const f = fixture();
  await assert.rejects(f.task.create({ ...f.input, contract: 'golf.native.pr-test.v2' }));
  await assert.rejects(f.task.create({ ...f.input, branch: undefined }));
  await assert.rejects(f.task.create({ ...f.input, shell: '/bin/sh' }));
  await assert.rejects(f.task.create({ ...f.input, module: 'test_calc;curl evil' }));
  await assert.rejects(f.task.create({ ...f.input, branch: '-option' }));
  assert.equal(f.task.record, undefined);
  await f.task.create(f.input); f.container.destroy = async () => { throw Error('unavailable'); };
  await assert.rejects(f.task.cancel(), /cleanup unconfirmed/); assert.equal(f.task.status().state, 'CLEANUP_FAILED');
  f.container.destroy = async () => {}; await f.task.cancel(); assert.equal(f.task.status().cleanup, 'destroyed');
  const outbound = new TestOutbound({ props: { jobId: 'foreign' } }, {});
  assert.equal((await outbound.fetch(new Request('https://example.com'))).status, 403);
});

test('an admitted pre-contract task can finish during rollout', async () => {
  const f = fixture();
  delete f.input.contract;
  await f.task.create(f.input); await f.task.alarm();
  assert.equal(f.task.status().state, 'PASSED');
  assert.deepEqual(testResult(f.task.status(), f.input.jobId, f.input), f.task.status());
});

test('changed clone identity and cancellation during execution cannot publish a passing result', async () => {
  const moved = fixture(), execute = moved.container.exec;
  moved.container.exec = async (args, options) => {
    if (args[0] === 'git' && args[2] === 'HEAD') return { output: async () => ({ exitCode: 0, stdout: new TextEncoder().encode('0'.repeat(40)), stderr: new Uint8Array() }) };
    return execute(args, options);
  };
  await moved.task.create(moved.input); await moved.task.alarm();
  assert.equal(moved.task.status().state, 'LOST'); assert.equal(moved.task.status().failureStage, 'clone');
  assert.equal(moved.commands.some(args => args[0] === '/bin/sh'), false); assert.equal(moved.counters().destroyed, 1);
  const cancelled = fixture(), native = cancelled.container.exec;
  let entered, release;
  const started = new Promise(resolve => { entered = resolve; }), blocked = new Promise(resolve => { release = resolve; });
  cancelled.container.exec = async (args, options) => {
    const process = await native(args, options);
    if (args[0] === '/bin/sh') return { output: async () => { entered(); await blocked; return process.output(); } };
    return process;
  };
  await cancelled.task.create(cancelled.input);
  const alarm = cancelled.task.alarm(); await started;
  await cancelled.task.cancel(); release(); await alarm;
  assert.equal(cancelled.task.status().state, 'CANCELLED'); assert.equal(cancelled.task.status().cleanup, 'destroyed');
});

test('registry-enabled tests expose only image coordinates and verify the published digest', async () => {
  const f=fixture(), manifest='{"schemaVersion":2}', bytes=new TextEncoder().encode(manifest);
  const digest='sha256:'+Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),b=>b.toString(16).padStart(2,'0')).join('');
  Object.assign(f.task.env,{REGISTRY_CI_ENABLED:'true',REGISTRY_ORIGIN:'https://registry.test'});
  f.input.registry={origin:'https://registry.test',name:'team/project'};
  const exec=f.container.exec;
  f.container.exec=async(args,options)=>{if(args[0]==='/bin/sh') {assert.equal(options.env.GOLF_REGISTRY,f.input.registry.origin);assert.equal(options.env.GOLF_IMAGE,'team/project:ci-'+f.input.jobId);assert.equal(Object.values(options.env).some(v=>String(v).includes('cfcr_')),false);}return exec(args,options);};
  f.owner.testRegistry=async(id,request)=>{assert.equal(id,f.input.jobId);assert.equal(new URL(request.url).origin,'https://registry.test');return new Response(manifest,{headers:{'Docker-Content-Digest':digest}});};
  await f.task.create(f.input);await f.task.alarm();
  const result=f.task.status();assert.equal(result.state,'PASSED');assert.equal(result.image.digest,digest);assert.deepEqual(testResult(result,f.input.jobId,f.input),result);
  assert.throws(()=>testResult({...result,image:{...result.image,commitId:'e'.repeat(40)}},f.input.jobId,f.input),/image receipt/);
  const mismatch=fixture();Object.assign(mismatch.task.env,f.task.env);mismatch.input.registry=f.input.registry;
  mismatch.owner.testRegistry=async()=>new Response(manifest,{headers:{'Docker-Content-Digest':'sha256:'+'f'.repeat(64)}});
  await mismatch.task.create(mismatch.input);await mismatch.task.alarm();assert.equal(mismatch.task.status().state,'LOST');assert.equal(mismatch.counters().destroyed,1);
});

test('registry broker exceptions are infrastructure failures, redact credentials, and stop the task', async () => {
  const f=fixture();
  Object.assign(f.task.env,{REGISTRY_CI_ENABLED:'true',REGISTRY_ORIGIN:'https://registry.test'});
  f.input.registry={origin:'https://registry.test',name:'team/project'};
  await f.task.create(f.input);
  f.task.record={...f.task.record,state:'RUNNING',stage:'test'};
  f.owner.testRegistry=async()=>{throw Error('RPC failed golf_native_secret art_v1_secret cfcr.dGVhbS9wcm9qZWN0.'+'a'.repeat(64)+' Bearer token https://registry.test/?token=secret');};
  assert.equal((await f.task.outbound(new Request('https://registry.test/v2/'))).status,503);
  const result=f.task.status();
  assert.equal(result.state,'LOST'); assert.equal(result.failureStage,'test'); assert.equal(result.cleanup,'destroyed');
  assert.equal(result.diagnostic,'RPC failed [private] [private] [private] [private] [private]');
  assert.deepEqual(testResult(result,f.input.jobId,f.input),result);
  assert.equal((await f.task.outbound(new Request('https://registry.test/v2/'))).status,403);
  assert.equal(f.counters().destroyed,1);
  const rpc=fixture();Object.assign(rpc.task.env,f.task.env);rpc.input.registry=f.input.registry;
  await rpc.task.create(rpc.input);rpc.task.record={...rpc.task.record,state:'RUNNING',stage:'test'};
  rpc.owner.testRegistry=async()=>new Response('Registry management: unavailable',{status:503,headers:{'X-Golf-Registry-Broker-Error':'1'}});
  assert.equal((await rpc.task.outbound(new Request('https://registry.test/v2/'))).status,503);
  assert.equal(rpc.task.status().state,'LOST');assert.equal(rpc.task.status().diagnostic,'Registry management: unavailable');
});

test('cancellation remains terminal when container destruction interrupts preparation', async () => {
  const f = fixture(), execute = f.container.exec;
  let entered, rejectClone, finishDestroy;
  const cloning = new Promise(resolve => { entered = resolve; });
  const destroying = new Promise(resolve => { finishDestroy = resolve; });
  f.container.exec = async (args, options) => args.includes('clone')
    ? { output: () => new Promise((_, reject) => { rejectClone = reject; entered(); }) }
    : execute(args, options);
  let destroyed = 0;
  f.container.destroy = async () => { destroyed++; rejectClone(Error('Clone interrupted by destruction')); await destroying; };
  await f.task.create(f.input);
  const alarm = f.task.alarm(); await cloning;
  const cancel = f.task.cancel();
  await new Promise(resolve => setImmediate(resolve));
  const during = { record: f.task.record.state, status: f.task.status().state, destroyed };
  finishDestroy(); await Promise.all([alarm, cancel]);
  assert.deepEqual(during, { record: 'CANCELLED', status: 'FINALIZING', destroyed: 1 });
  assert.equal(f.task.status().state, 'CANCELLED');
  assert.equal(f.task.status().cleanup, 'destroyed');
  await f.task.alarm(); await f.task.cancel();
  assert.equal(destroyed, 1);
});

test('cancellation during admission authorization cannot restart a destroyed task', async () => {
  const f = fixture(); let authorize, checks = 0;
  f.owner.evidence = () => ++checks === 1 ? new Promise(resolve => { authorize = resolve; }) : Promise.resolve({ state: 'AUTHORIZED' });
  await f.task.create(f.input);
  const alarm = f.task.alarm();
  await f.task.cancel(); authorize({ state: 'AUTHORIZED' }); await alarm;
  assert.equal(f.task.status().state, 'CANCELLED');
  assert.equal(f.container.running, false);
  assert.equal(f.commands.length, 0);
});

test('recreated task retries unfinished destruction without changing its terminal decision', async () => {
  const f = fixture(); await f.task.create(f.input);
  f.task.record = { ...f.task.record, state: 'CANCELLED', stage: 'terminal', finishedAt: Date.now() };
  const restarted = new PRTestTask(f.task.ctx, f.task.env);
  await restarted.alarm();
  assert.equal(restarted.status().state, 'CANCELLED');
  assert.equal(restarted.status().cleanup, 'destroyed');
  assert.equal(f.counters().destroyed, 1);
  assert.equal(f.commands.length, 0);
});

test('native Actions workflow checks its exact blob and runs isolated shell steps once', async () => {
  const f = fixture(), blobId = 'f'.repeat(40);
  const workflow = { path: '.github/workflows/check.yml', blobId, plan: nativeWorkflow('actions',
    'on: pull_request\njobs:\n  check:\n    runs-on: golf-native-linux\n    steps:\n      - run: echo first\n      - run: echo second\n        shell: sh\n') };
  const bytes = new TextEncoder().encode(JSON.stringify(workflow));
  f.input = { ...f.input, contract: nativeWorkflowContract, workflow, workflowSha256: Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), b => b.toString(16).padStart(2, '0')).join('') };
  delete f.input.module;
  const execute = f.container.exec;
  f.container.exec = (args, options) => args[0] === 'git' && args[2] === 'HEAD:' + workflow.path
    ? Promise.resolve({ output: async () => ({ exitCode: 0, stdout: new TextEncoder().encode(blobId), stderr: new Uint8Array() }) })
    : execute(args, options);
  await assert.rejects(f.task.create({ ...f.input, workflowSha256: '0'.repeat(64) }), /Invalid test admission/);
  await f.task.create(f.input); await f.task.alarm();
  assert.equal(f.task.status().state, 'PASSED');
  assert.equal(f.commands.filter(args => args[0] === '/bin/sh').length, 2);
  assert.deepEqual(testResult(f.task.status(), f.input.jobId, f.input), f.task.status());
  assert.throws(() => testResult({ ...f.task.status(), workflowSha256: '0'.repeat(64) }, f.input.jobId, f.input), /Invalid test execution/);
  await f.task.create(f.input); await f.task.alarm();
  assert.equal(f.commands.filter(args => args[0] === '/bin/sh').length, 2);
  const changed = fixture(); changed.input = f.input;
  await changed.task.create(changed.input); await changed.task.alarm();
  assert.equal(changed.task.status().state, 'LOST');
  assert.equal(changed.commands.some(args => args[0] === '/bin/sh'), false);
});

test('native GitLab after_script runs in a separate shell without masking main failure', async () => {
  const f = fixture(), blobId = 'f'.repeat(40);
  const workflow = { path: '.gitlab-ci.yml', blobId, plan: nativeWorkflow('gitlab',
    'check:\n  before_script: export VALUE=ready\n  script: test "$VALUE" = ready\n  after_script: echo cleanup\n') };
  const bytes = new TextEncoder().encode(JSON.stringify(workflow));
  f.input = { ...f.input, contract: nativeWorkflowContract, workflow, workflowSha256: Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), b => b.toString(16).padStart(2, '0')).join('') };
  delete f.input.module;
  const execute = f.container.exec;
  f.container.exec = async (args, options) => {
    if (args[0] === 'git' && args[2] === 'HEAD:' + workflow.path) return { output: async () => ({ exitCode: 0, stdout: new TextEncoder().encode(blobId), stderr: new Uint8Array() }) };
    if (args.includes('echo cleanup')) assert.equal(options.env.CI_JOB_STATUS, 'failed');
    const process = await execute(args, options);
    if (args[0] === '/bin/sh' && args.includes(workflow.plan.steps[0].run)) return { output: async () => ({ ...await process.output(), exitCode: 7 }) };
    return process;
  };
  await f.task.create(f.input); await f.task.alarm();
  assert.equal(f.task.status().state, 'FAILED');
  assert.equal(f.task.status().exitCode, 7);
  assert.equal(f.commands.filter(args => args[0] === '/bin/sh').length, 2);
  assert.equal(f.commands.some(args => args.includes('echo cleanup')), true);
  assert.deepEqual(testResult(f.task.status(), f.input.jobId, f.input), f.task.status());
});

test('native GitLab after_script failure does not change a successful main result', async () => {
  const f = fixture(), blobId = 'f'.repeat(40);
  const workflow = { path: '.gitlab-ci.yml', blobId, plan: nativeWorkflow('gitlab', 'check:\n  script: echo passed\n  after_script: exit 4\n') };
  const bytes = new TextEncoder().encode(JSON.stringify(workflow));
  f.input = { ...f.input, contract: nativeWorkflowContract, workflow,
    workflowSha256: Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), b => b.toString(16).padStart(2, '0')).join('') };
  delete f.input.module;
  const execute = f.container.exec;
  f.container.exec = async (args, options) => {
    if (args[0] === 'git' && args[2] === 'HEAD:' + workflow.path) return { output: async () => ({ exitCode: 0, stdout: new TextEncoder().encode(blobId), stderr: new Uint8Array() }) };
    const process = await execute(args, options);
    if (args.includes('exit 4')) { assert.equal(options.env.CI_JOB_STATUS, 'success'); return { output: async () => ({ ...await process.output(), exitCode: 4 }) }; }
    return process;
  };
  await f.task.create(f.input); await f.task.alarm();
  assert.equal(f.task.status().state, 'PASSED');
  assert.equal(f.task.status().exitCode, 0);
  assert.equal(f.commands.filter(args => args[0] === '/bin/sh').length, 2);
});

test('a shell that exits zero after the hard deadline cannot publish success', async () => {
  const f = fixture(), now = Date.now;
  let clock = now();
  f.input.deadline = clock + 10000;
  const execute = f.container.exec;
  f.container.exec = async (args, options) => {
    const process = await execute(args, options);
    if (args[0] !== '/bin/sh') return process;
    return { output: async () => { clock = f.input.deadline + 1; return process.output(); } };
  };
  Date.now = () => clock;
  try {
    await f.task.create(f.input); await f.task.alarm();
    assert.equal(f.commands.filter(args => args[0] === '/bin/sh').length, 1);
    assert.equal(f.task.status().state, 'TIMED_OUT');
    assert.equal(f.task.status().cleanup, 'destroyed');
    assert.equal(f.counters().destroyed, 1);
  } finally { Date.now = now; }
});

async function valueFixture(steps = '      - run: ./first.sh\n      - run: ./second.sh\n        shell: sh\n') {
  const f = fixture(), blobId = 'f'.repeat(40), secret = 'fixture-secret-value';
  const workflow = { path: '.github/workflows/check.yml', blobId, plan: nativeWorkflow('actions', 'on: pull_request\njobs:\n  check:\n    runs-on: golf-native-linux\n    steps:\n' + steps) };
  const sha256 = async value => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))), b => b.toString(16).padStart(2, '0')).join('');
  f.input = { ...f.input, contract: nativeWorkflowContract, workflow, workflowSha256: await sha256(JSON.stringify(workflow)), values: { bindingId: crypto.randomUUID(), bindingVersion: 1, refs: [{ id: crypto.randomUUID(), version: 2 }] } };
  delete f.input.module;
  const execute = f.container.exec, environments = [], releases = [];
  f.container.exec = async (args, options) => {
    environments.push({ shell: args[0] === '/bin/sh', env: options.env });
    if (args[0] === 'git' && args[2] === 'HEAD:' + workflow.path) return { output: async () => ({ exitCode: 0, stdout: new TextEncoder().encode(blobId), stderr: new Uint8Array() }) };
    return execute(args, options);
  };
  f.owner.testValues = async id => { releases.push({ id, commands: f.commands.length }); return { state: 'RELEASED', environment: { DEPLOY_TOKEN: secret, REGION: 'eu-central' }, secrets: [secret] }; };
  // Everything the Durable Object keeps: its stored record and its public status.
  const kept = () => JSON.stringify([f.task.record, f.task.status()]);
  return { ...f, secret, workflow, environments, releases, kept };
}

test('approved values reach every step beneath the trusted environment and never the stored record', async () => {
  const f = await valueFixture(), { executionValueName } = await import('./src/execution-values.mjs');
  // A release that tried to replace trusted keys still cannot: the task's own environment is applied last.
  const release = f.owner.testValues;
  f.owner.testValues = async id => { const released = await release(id); return { ...released, environment: { ...released.environment, PATH: '/attacker/bin', HOME: '/attacker', GIT_CONFIG_COUNT: '0', SSL_CERT_FILE: '/attacker/ca' } }; };
  Object.assign(f.container.files, { '/workspace/task/stdout0': 'first prints ' + f.secret.slice(0, 7), '/workspace/task/stdout1': f.secret.slice(7) + ' and again ' + f.secret + '\n',
    '/workspace/task/stderr0': 'region eu-central ', '/workspace/task/stderr1': 'warning: ' + f.secret + '\n' });
  await f.task.create(f.input);
  assert.equal(f.kept().includes(f.secret), false);
  await f.task.alarm();
  const result = f.task.status(), stars = '*'.repeat(f.secret.length);
  assert.equal(result.state, 'PASSED');
  assert.equal(result.stdout, 'first prints ' + stars + ' and again ' + stars + '\n');
  // Variables are plain configuration and are not masked.
  assert.equal(result.stderr, 'region eu-central warning: ' + stars + '\n');
  assert.equal(f.kept().includes(f.secret), false); assert.equal(f.kept().includes(f.secret.slice(0, 7)), false); assert.equal(f.kept().includes('DEPLOY_TOKEN'), false);
  assert.deepEqual(testResult(result, f.input.jobId, f.input), result);
  // One release, asked for after the exact commit and tree were verified and before any step.
  assert.deepEqual(f.releases.map(r => r.id), [f.input.jobId]);
  assert.equal(f.commands.slice(0, f.releases[0].commands).some(args => args[0] === '/bin/sh'), false);
  assert.equal(f.commands.slice(0, f.releases[0].commands).some(args => args[0] === 'git' && args[2] === 'HEAD^{tree}'), true);
  const steps = f.environments.filter(e => e.shell), trusted = f.environments.filter(e => !e.shell);
  assert.equal(steps.length, 2); assert.ok(trusted.length >= 4);
  for (const { env } of steps) assert.deepEqual([env.DEPLOY_TOKEN, env.REGION, env.PATH, env.HOME, env.GIT_CONFIG_COUNT, env.SSL_CERT_FILE],
    [f.secret, 'eu-central', '/usr/local/bin:/usr/bin:/bin', '/auth', '3', '/etc/cloudflare/certs/cloudflare-containers-ca.crt']);
  // Cloning and source verification never see a value, and no trusted key is a name a value may take.
  for (const { env } of trusted) { assert.equal(env.DEPLOY_TOKEN, undefined); assert.equal(env.REGION, undefined); for (const name of Object.keys(env)) assert.equal(executionValueName(name), false, name); }
  for (const name of ['GOLF_REGISTRY', 'GOLF_IMAGE', 'GOLF_COMMIT', 'CI_JOB_STATUS']) assert.equal(executionValueName(name), false, name);
  await f.task.alarm(); await f.task.create(f.input);
  assert.equal(f.releases.length, 1);
});

test('a refused or failed release runs no step, and a job without approved values never asks', async () => {
  for (const state of ['REFUSED', 'NONE', undefined]) {
    const f = await valueFixture(); f.owner.testValues = async () => state && { state, environment: { DEPLOY_TOKEN: f.secret }, secrets: [f.secret] };
    await f.task.create(f.input); await f.task.alarm();
    assert.equal(f.task.status().state, 'CANCELLED'); assert.equal(f.commands.some(args => args[0] === '/bin/sh'), false); assert.equal(f.counters().destroyed, 1);
  }
  const failed = await valueFixture(); failed.owner.testValues = async () => { throw Error('Repository value unavailable'); };
  await failed.task.create(failed.input); await failed.task.alarm();
  assert.deepEqual([failed.task.status().state, failed.task.status().diagnostic, failed.commands.some(args => args[0] === '/bin/sh')], ['LOST', 'Repository value unavailable', false]);
  // Cancelled while the release was in flight: the returned values are dropped unused.
  const late = await valueFixture(), release = late.owner.testValues;
  late.owner.testValues = async id => { await late.task.cancel(); return release(id); };
  await late.task.create(late.input); await late.task.alarm();
  assert.equal(late.task.status().state, 'CANCELLED'); assert.equal(late.commands.some(args => args[0] === '/bin/sh'), false);
  const plain = await valueFixture(); delete plain.input.values;
  await plain.task.create(plain.input); await plain.task.alarm();
  assert.equal(plain.task.status().state, 'PASSED'); assert.equal(plain.releases.length, 0);
  for (const { env } of plain.environments) assert.equal(env.DEPLOY_TOKEN, undefined);
});

test('value admission is bound to the task identity and refused outside the hosted Actions lane', async () => {
  const f = await valueFixture(), values = f.input.values;
  for (const invalid of [null, {}, { ...values, bindingVersion: 0 }, { ...values, bindingId: 'x' }, { ...values, refs: [] }, { ...values, refs: [{ id: 'x', version: 2 }] }, { ...values, refs: Array.from({ length: 65 }, () => ({ id: crypto.randomUUID(), version: 1 })) }, { ...values, refs: [{ id: values.refs[0].id, version: '2' }] }, { ...values, refs: [{ ...values.refs[0], name: 'DEPLOY_TOKEN' }] },
    { ...values, environment: { DEPLOY_TOKEN: f.secret } }, { ...values, refs: [{ ...values.refs[0], value: f.secret }] }])
    await assert.rejects(f.task.create({ ...f.input, values: invalid }), /Invalid value admission/);
  const module = fixture();
  await assert.rejects(module.task.create({ ...module.input, values }), /Invalid test admission/);
  const gitlab = { path: '.gitlab-ci.yml', blobId: 'f'.repeat(40), plan: nativeWorkflow('gitlab', 'check:\n  script: echo ok\n') };
  const digest = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(gitlab)))), b => b.toString(16).padStart(2, '0')).join('');
  await assert.rejects(f.task.create({ ...f.input, workflow: gitlab, workflowSha256: digest }), /Invalid value admission/);
  assert.equal(f.task.record, undefined);
  await f.task.create(f.input);
  // The same task cannot be re-admitted with another approval, other versions, or none.
  await assert.rejects(f.task.create({ ...f.input, values: { ...values, bindingVersion: 2 } }), /identity conflict/);
  await assert.rejects(f.task.create({ ...f.input, values: { ...values, refs: [{ ...values.refs[0], version: 3 }] } }), /identity conflict/);
  const { values: _, ...without } = f.input;
  await assert.rejects(f.task.create(without), /identity conflict/);
});

test('failures, timeouts and broker errors after a release cannot store or echo a secret', async () => {
  // A runtime error that quotes the environment is replaced by a fixed message.
  const echoed = await valueFixture(), execute = echoed.container.exec;
  echoed.container.exec = async (args, options) => { if (args[0] === '/bin/sh') throw Error('exec failed with env DEPLOY_TOKEN=' + echoed.secret); return execute(args, options); };
  await echoed.task.create(echoed.input); await echoed.task.alarm();
  assert.deepEqual([echoed.task.status().state, echoed.task.status().diagnostic], ['LOST', 'Execution failed after repository values were released; the runtime message is withheld.']);
  assert.equal(echoed.kept().includes(echoed.secret), false);
  // The task's own fixed messages stay readable.
  const large = await valueFixture(); large.container.files['/workspace/task/stdout0'] = echoed.secret.repeat(2000);
  await large.task.create(large.input); await large.task.alarm();
  assert.deepEqual([large.task.status().state, large.task.status().diagnostic, large.task.status().stdout], ['LOST', 'payload limit', '']);
  // A failing step keeps its masked output and the after-failure path stores nothing unmasked.
  const failing = await valueFixture(), run = failing.container.exec;
  failing.container.files['/workspace/task/stderr0'] = 'curl: (6) could not resolve host for token ' + failing.secret + '\n';
  failing.container.exec = async (args, options) => { const process = await run(args, options); return args[0] === '/bin/sh' ? { output: async () => ({ ...await process.output(), exitCode: 6 }) } : process; };
  await failing.task.create(failing.input); await failing.task.alarm();
  assert.deepEqual([failing.task.status().state, failing.task.status().exitCode, failing.task.status().stderr], ['FAILED', 6, 'curl: (6) could not resolve host for token ' + '*'.repeat(failing.secret.length) + '\n']);
  assert.equal(failing.commands.filter(args => args[0] === '/bin/sh').length, 1);
  // Output read before the deadline passed is masked on the timed-out path too.
  const slow = await valueFixture('      - run: ./only.sh\n'), now = Date.now, step = slow.container.exec;
  let clock = now(); slow.input.deadline = clock + 10000; slow.container.files['/workspace/task/stdout0'] = 'late ' + slow.secret;
  slow.container.exec = async (args, options) => { const process = await step(args, options); return args[0] === '/bin/sh' ? { output: async () => { clock = slow.input.deadline + 1; return process.output(); } } : process; };
  Date.now = () => clock;
  try { await slow.task.create(slow.input); await slow.task.alarm(); } finally { Date.now = now; }
  assert.deepEqual([slow.task.status().state, slow.task.status().stdout], ['TIMED_OUT', 'late ' + '*'.repeat(slow.secret.length)]);
  // A registry broker failure during the test stage could quote a request the step made.
  const broker = await valueFixture(); Object.assign(broker.task.env, { REGISTRY_CI_ENABLED: 'true', REGISTRY_ORIGIN: 'https://registry.test' }); broker.input.registry = { origin: 'https://registry.test', name: 'team/project' };
  await broker.task.create(broker.input); broker.task.record = { ...broker.task.record, state: 'RUNNING', stage: 'test' }; broker.task.secrets = [broker.secret];
  broker.owner.testRegistry = async () => { throw Error('Registry management: unknown blob /v2/team/project/blobs/' + broker.secret); };
  assert.equal((await broker.task.outbound(new Request('https://registry.test/v2/team/project/blobs/' + broker.secret))).status, 503);
  assert.deepEqual([broker.task.status().state, broker.task.status().diagnostic], ['LOST', 'Execution failed after repository values were released; the runtime message is withheld.']);
  for (const f of [large, failing, slow, broker]) assert.equal(f.kept().includes(f.secret), false);
});
