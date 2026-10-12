import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
const shim = `export class DurableObject { constructor(ctx,env){this.ctx=ctx;this.env=env} } export class WorkerEntrypoint extends DurableObject {}`;
const hooks = registerHooks({ resolve(specifier, context, next) {
  if (specifier === 'cloudflare:workers' || specifier === '@cloudflare/sandbox') return {
    url: 'data:text/javascript,' + encodeURIComponent(specifier === 'cloudflare:workers' ? shim : 'export class Files {constructor(){}} export class SandboxFileError {static is(){return false}}'), shortCircuit: true,
  };
  return next(specifier, context);
} });
const { AgentTask, default: worker } = await import('./src/worker.mjs');
hooks.deregister();

test('controller admission, cancellation, evidence failure and inference reservations', async () => {
  let destroyed = 0, calls = 0, payload;
  const data = new Map();
  const ctx = { container: { destroy: async () => { destroyed++; } }, storage: {
    kv: { get: k => data.get(k), put: (k, v) => data.set(k, v) },
    setAlarm: async () => {}, deleteAlarm: async () => {},
  }, blockConcurrencyWhile: f => f() };
  const env = { GOLF_PROBE_TOKEN: 'a'.repeat(43), GOLF_NAMESPACE: 'owned',
    GOLF_BASE_COMMIT: '1'.repeat(40), GOLF_BASE_TREE: '2'.repeat(40),
    EVIDENCE: { put: async (key, value) => { payload = JSON.parse(value); return {}; } },
    AI: { run: async () => { calls++; return { choices: [] }; } } };
  const task = new AgentTask(ctx, env);
  assert.equal((await task.create('agent-a', { prompt: 'Fix arithmetic.', timeout_ms: 1000 })).state, 'preparing');
  assert.equal((await task.create('agent-a', { prompt: 'Again.', timeout_ms: 1000 })).state, 'conflict');
  task.record = { ...task.record, state: 'running', stage: 'agent', deadline: Date.now() + 10000, calls: 15 };
  const request = () => new Request('https://golf-ai.internal/v1/chat/completions', { method: 'POST', body: JSON.stringify({ messages: [] }) });
  const results = await Promise.all([task.outbound(request()), task.outbound(request())]);
  assert.deepEqual(results.map(r => r.status).sort(), [200, 429]);
  assert.equal(calls, 1);
  assert.equal(task.record.calls, 16);
  await task.cancel();
  assert.equal(task.record.state, 'cancelled');
  assert.equal(destroyed, 1);
  assert.equal(payload.context.prompt, 'Fix arithmetic.');
  assert.equal((await task.outbound(request())).status, 403);
  assert.equal(calls, 1);
  task.record = { ...task.record, state: 'running', stage: 'test', evidence: undefined };
  env.EVIDENCE.put = async () => { throw new Error('storage unavailable'); };
  await task.finish('succeeded');
  assert.equal((await task.status()).state, 'lost');
  assert.equal(task.record.cleanup, 'destroyed');
  assert.equal(task.record.evidence.state, 'failed');
  task.record = { ...task.record, state: 'succeeded', evidence: undefined };
  assert.equal((await task.status()).state, 'finalizing');
  const denied = await worker.fetch(new Request('https://worker/tasks/agent-a'), env, {});
  assert.equal(denied.status, 401);
  assert.equal(denied.headers.get('Cache-Control'), 'no-store');
});

test('native startup readiness precedes the inactivity timer and candidate tests', async () => {
  let ready = false;
  const operations = [], data = new Map();
  const container = { images: { agent: 'fixture' }, running: false,
    interceptAllOutboundHttp: async () => {}, interceptOutboundHttps: async () => {},
    start() { this.running = true; }, monitor: () => new Promise(() => {}),
    setInactivityTimeout: async () => { assert.equal(ready, true); operations.push('timer'); },
    destroy: async () => {},
    exec: async args => {
      if (args[0] === '/bin/true') { ready = true; operations.push('ready'); }
      let stdout = '';
      if (args[0] === 'git' && args[1] === 'rev-parse') stdout = args[2] === 'HEAD' ? '1'.repeat(40) : '2'.repeat(40);
      if (args[0] === 'opencode') stdout = '1.18.34';
      if (args[0] === 'python3') operations.push('tests');
      return { output: async () => ({ exitCode: 0, stdout: new TextEncoder().encode(stdout), stderr: new Uint8Array() }) };
    },
  };
  const ctx = { container, exports: { Outbound: () => ({}) }, waitUntil: () => {},
    storage: { kv: { get: k => data.get(k), put: (k, v) => data.set(k, v) }, setAlarm: async () => {}, deleteAlarm: async () => {} } };
  const env = { GOLF_PROBE_TOKEN: 'a'.repeat(43), GOLF_NAMESPACE: 'owned', GOLF_ACCOUNT_ID: 'account', EVIDENCE: { put: async () => ({}) } };
  const task = new AgentTask(ctx, env);
  await task.create('integration', { prompt: 'Test candidate.', timeout_ms: 1000, commit: '1'.repeat(40), tree: '2'.repeat(40) });
  await task.alarm();
  assert.equal(task.record.state, 'succeeded');
  assert.deepEqual(operations, ['ready', 'timer', 'tests']);
  assert.equal(task.record.cleanup, 'destroyed');
});
