import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { agentResult, agentPathOK, filePolicy } from './src/agent-policy.mjs';
import { nativePolicy, policyIdentity } from '../agents/src/policy.mjs';

const hooks = registerHooks({ resolve(specifier, context, next) {
  if (specifier === 'cloudflare:workers') return { url: 'data:text/javascript,' + encodeURIComponent('export class DurableObject {constructor(ctx,env){this.ctx=ctx;this.env=env}} export class WorkerEntrypoint extends DurableObject {}'), shortCircuit: true };
  if (specifier === '@cloudflare/sandbox') return { url: 'data:text/javascript,' + encodeURIComponent('export class Files {constructor(container){this.container=container} readFile(path){return new Response(this.container.files[path] || "")} writeFile(path,value){this.container.files[path]=value}} export class SandboxFileError {static is(){return false}}'), shortCircuit: true };
  return next(specifier, context);
} });
const { PRAgentTask, AgentOutbound } = await import('./src/agent-worker.mjs');
hooks.deregister();

function fixture() {
  const store = new Map(), commands = [];
  let destroyed = 0, calls = 0, brokered = 0, authorized = true, proposed = false;
  const input = { jobId: crypto.randomUUID(), commitId: 'b'.repeat(40), treeId: 'f'.repeat(40), branch: 'feature', module: 'test_calc',
    policySha256: 'e'.repeat(64), allowedPath: 'calc.py', prompt: 'Improve the approved source file.',
    remote: `https://${'c'.repeat(32)}.artifacts.cloudflare.net/git/test-space/repo-${'d'.repeat(32)}.git`, deadline: Date.now() + 600000 };
  const resolved = { name: 'golf-workspace', tools: { read: true, edit: true, write: true }, permission: [
    ['*', '*', 'deny'], ['read', '*', 'deny'], ['read', 'calc.py', 'allow'], ['edit', '*', 'deny'], ['edit', 'calc.py', 'allow'],
    ['apply_patch', '*', 'deny'], ['external_directory', '*', 'deny'], ['external_directory', '/auth/data/opencode/tool-output/*', 'allow'],
  ].map(([permission, pattern, action]) => ({ permission, pattern, action })) };
  const container = { images: { agent: 'image' }, files: {
    '/workspace/task/exit': '0', '/workspace/task/events.jsonl': JSON.stringify({ type: 'step_finish', part: { reason: 'stop', tokens: { input: 10, output: 5, reasoning: 0 } } }),
  }, running: false,
    interceptAllOutboundHttp: async () => {}, interceptOutboundHttps: async () => {},
    start(options) { assert.equal(options.enableInternet, false); this.running = true; }, monitor: () => new Promise(() => {}), setInactivityTimeout: async () => {},
    destroy: async () => { destroyed++; },
    exec: async (args, options) => {
      commands.push(args); assert.equal(options.env.GIT_CONFIG_VALUE_0, '');
      let stdout = '';
      if (args[0] === 'git' && args[1] === 'rev-parse') stdout = args[2] === 'HEAD' ? proposed ? 'c'.repeat(40) : input.commitId : input.treeId;
      if (args[0] === 'git' && args[1] === 'commit') proposed = true;
      if (args[0] === 'git' && args[1] === 'ls-files' && args[2] === '-s') stdout = '100644 ' + '1'.repeat(40) + ' 0\tcalc.py';
      if (args[0] === 'git' && args.includes('diff')) stdout = args.includes('--name-only') ? 'calc.py' : args.includes('--binary') ? 'source diff' : '';
      if (args[0] === 'opencode') stdout = args[1] === '--version' ? '1.18.34' : JSON.stringify(resolved);
      return { output: async () => ({ exitCode: 0, stdout: new TextEncoder().encode(stdout), stderr: new Uint8Array() }) };
    } };
  const owner = { evidence: async () => ({ state: authorized ? 'AUTHORIZED' : 'REFUSED' }), agentGit: async () => { brokered++; return new Response('git'); } };
  const ctx = { container, storage: { kv: { get: k => store.get(k), put: (k, v) => store.set(k, v) }, setAlarm: async () => {}, deleteAlarm: async () => {} },
    waitUntil: () => {}, exports: { Workspace: { getByName: () => owner }, AgentOutbound: () => ({}) } };
  const env = { WORKSPACE_SLUG: 'team', EVIDENCE_GATEWAY: 'private', AI: { async run() { calls++; return { choices: [] }; } } };
  return { task: new PRAgentTask(ctx, env), input, commands, container, resolved, counters: () => ({ destroyed, calls, brokered }), revoke: () => { authorized = false; } };
}
const inference = () => new Request('https://golf-ai.internal/v1/chat/completions', { method: 'POST', body: JSON.stringify({ messages: [] }) });

test('native agent uses the qualified controller once, with exact source and separate fork publication', async () => {
  const f = fixture(); await f.task.create(f.input); await f.task.create(f.input);
  await assert.rejects(f.task.create({ ...f.input, prompt: 'Different input' }), /admission changed/);
  await f.task.alarm(); assert.equal((await f.task.status()).state, 'running');
  assert.equal(JSON.parse(f.container.files['/auth/opencode.json']).permission.edit['calc.py'], 'allow');
  assert.equal((await f.task.outbound(inference())).status, 200);
  await f.task.alarm();
  const result = await f.task.status();
  assert.equal(result.state, 'succeeded'); assert.equal(result.cleanup, 'destroyed');
  assert.equal(result.proposal_commit, 'c'.repeat(40)); assert.equal(f.counters().destroyed, 1);
  assert.equal(agentResult(result, f.input.jobId, f.input).proposalOnly, true);
  const clone = f.commands.find(args => args.includes('clone'));
  assert.equal(clone.includes('--depth'), false); assert.equal(clone.includes('--single-branch'), true);
  const publication = f.commands.find(args => args.includes('push'));
  assert.deepEqual(publication.slice(-2), [f.input.remote, 'HEAD:refs/heads/feature']);
  await f.task.alarm(); await f.task.cancel(); assert.equal(f.counters().destroyed, 1);
  assert.equal((await f.task.outbound(inference())).status, 403);
});

test('native agent revocation, interrupted dispatch and cancellation stop inference without replay', async () => {
  const f = fixture(); await f.task.create(f.input); await f.task.alarm(); f.revoke();
  assert.equal((await f.task.outbound(inference())).status, 403); await f.task.alarm();
  assert.equal((await f.task.status()).state, 'lost'); assert.equal(f.counters().calls, 0);
  const interrupted = fixture(); await interrupted.task.create(interrupted.input);
  interrupted.task.record = { ...interrupted.task.record, stage: 'container_dispatch' };
  await interrupted.task.alarm(); assert.equal(interrupted.commands.length, 0); assert.equal((await interrupted.task.status()).cleanup, 'destroyed');
  const cancelled = fixture(); await cancelled.task.create(cancelled.input); await cancelled.task.cancel(); await cancelled.task.alarm();
  assert.equal(cancelled.commands.length, 0); assert.equal((await cancelled.task.status()).state, 'cancelled');
});

test('native agent cleanup is retryable and ambiguous publication remains unknown', async () => {
  const f = fixture(); await f.task.create(f.input);
  f.task.record = { ...f.task.record, stage: 'publish' };
  f.container.destroy = async () => { throw Error('Unavailable'); };
  await assert.rejects(f.task.cancel(), /cleanup unconfirmed/); assert.equal((await f.task.status()).state, 'CLEANUP_FAILED');
  f.container.destroy = async () => {}; await f.task.cancel();
  const result = agentResult(await f.task.status(), f.input.jobId, f.input);
  assert.equal(result.state, 'lost'); assert.equal(result.publication, 'UNKNOWN');
});

test('native agent file boundary rejects traversal, symlinks, policy widening and changed test output', async () => {
  for (const path of ['../calc.py', '.git/config', 'src/*.py', 'src//calc.py', 'calc.py\n']) assert.equal(agentPathOK(path), false);
  const f = fixture(); await assert.rejects(f.task.create({ ...f.input, module: 'test;curl' }));
  assert.equal(f.task.record, undefined);
  const policy = filePolicy('src/math.py'); assert.equal(policy.permission.read['src/math.py'], 'allow'); assert.equal(policy.permission.edit['calc.py'], undefined);
  const dynamic = { ...f.resolved, permission: f.resolved.permission.map(v => ({ ...v, pattern: v.pattern === 'calc.py' ? 'src/math.py' : v.pattern })) };
  assert.equal(nativePolicy(dynamic, 'src/math.py'), true); assert.equal(nativePolicy(dynamic), false);
  await f.task.create(f.input); await f.task.alarm(); await f.task.outbound(inference());
  const execute = f.container.exec;
  f.container.exec = async (args, options) => {
    if (args[0] === 'git' && args[1] === 'ls-files' && args[2] === '-s') return { output: async () => ({ exitCode: 0, stdout: new TextEncoder().encode('120000 ' + '1'.repeat(40) + ' 0\tcalc.py'), stderr: new Uint8Array() }) };
    return execute(args, options);
  };
  await f.task.alarm(); assert.equal((await f.task.status()).state, 'lost'); assert.equal(f.commands.some(args => args.includes('push')), false);
  const outbound = new AgentOutbound({ props: { jobId: 'foreign' } }, {});
  assert.equal((await outbound.fetch(inference())).status, 403);
});


test('repository tests cannot move a proposal before the controller publishes', async () => {
  const f = fixture(); await f.task.create(f.input); await f.task.alarm(); await f.task.outbound(inference());
  const execute = f.container.exec; let tested = false;
  f.container.exec = async (args, options) => {
    if (args.includes('python3')) tested = true;
    if (tested && args[0] === 'git' && args[1] === 'rev-parse' && args[2] === 'HEAD') return { output: async () => ({ exitCode: 0, stdout: new TextEncoder().encode('d'.repeat(40)), stderr: new Uint8Array() }) };
    return execute(args, options);
  };
  await f.task.alarm(); assert.equal((await f.task.status()).state, 'lost'); assert.equal(f.commands.some(args => args.includes('push')), false);
});


test('oversized or unbound native results cannot become review evidence', async () => {
  const f = fixture();
  await f.task.create(f.input); await f.task.alarm(); await f.task.outbound(inference()); await f.task.alarm();
  const result = await f.task.status();
  assert.throws(() => agentResult({ ...result, base_commit: 'd'.repeat(40) }, f.input.jobId, f.input));
  assert.throws(() => agentResult({ ...result, first_inference_at: result.finished_at + 1 }, f.input.jobId, f.input));
  assert.throws(() => agentResult({ ...result, patch: 'a'.repeat(100 * 1024) }, f.input.jobId, f.input));
  assert.throws(() => f.task.validateProposal('a'.repeat(81 * 1024), {}));
});

test('a native agent runs exactly the admitted model, bound into its policy identity', async () => {
  const f = fixture(), deploy = 'a'.repeat(64), chosen = '@cf/zai-org/glm-5.3', used = [];
  Object.assign(f.task.env, { AGENT_POLICY_SHA256: deploy, AI_MODELS: JSON.stringify({ agents: { default: '@cf/zai-org/glm-5.3-flash', allowed: ['@cf/zai-org/glm-5.3-flash', chosen] } }) });
  f.task.env.AI = { async run(model, body) { used.push([model, body.model]); return { choices: [] }; } };
  // The identity must be the deploy hash bound to this model, and the model must be on the deploy list.
  await assert.rejects(f.task.create({ ...f.input, model: chosen, policySha256: await policyIdentity(deploy, '@cf/zai-org/glm-5.3-flash') }), /admission/);
  await assert.rejects(f.task.create({ ...f.input, model: '@cf/meta/llama-4', policySha256: await policyIdentity(deploy, '@cf/meta/llama-4') }), /admission/);
  assert.equal(f.task.record, undefined);
  const input = { ...f.input, model: chosen, policySha256: await policyIdentity(deploy, chosen) };
  await f.task.create(input); await f.task.alarm();
  assert.equal(JSON.parse(f.container.files['/auth/opencode.json']).provider.golf.models.coder.name, chosen);
  // The proxy forces the admitted model whatever the harness sends.
  await f.task.outbound(new Request('https://golf-ai.internal/v1/chat/completions', { method: 'POST', body: JSON.stringify({ model: 'golf/coder', messages: [] }) }));
  assert.deepEqual(used, [[chosen, chosen]]);
  await f.task.alarm();
  const result = await f.task.status();
  assert.equal(agentResult(result, input.jobId, input, chosen).model, chosen);
  assert.throws(() => agentResult(result, input.jobId, input, '@cf/zai-org/glm-5.3-flash'), /different model/);
  // The deploy hash covers the policy without a model; the default policy file is unchanged for the fixture roles.
  assert.equal(filePolicy('calc.py', null).provider.golf.models.coder.name, undefined);
  assert.equal(JSON.stringify(filePolicy('calc.py')), JSON.stringify(filePolicy('calc.py', '@cf/zai-org/glm-5.3-flash')));
});
