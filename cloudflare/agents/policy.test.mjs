import test from 'node:test';
import assert from 'node:assert/strict';
import { authorized, boundedBody, gitOperation, inference, projectedEvents, policy, nativePolicy, openAIStream } from './src/policy.mjs';

test('credential, body, egress and native outcome boundaries', async () => {
  const secret = 'a'.repeat(43), remote = 'https://account.artifacts.cloudflare.net/git/owned/agent-a.git';
  assert.equal(await authorized(new Request('https://worker/'), secret), false);
  assert.equal(await authorized(new Request('https://worker/', { headers: { Authorization: 'Bearer ' + secret } }), secret), true);
  assert.equal(await authorized(new Request('https://worker/', { headers: { Authorization: 'Bearer ' + 'b'.repeat(43) } }), secret), false);
  await assert.rejects(boundedBody(new Request('https://worker/', { method: 'POST', body: 'abcd' }), 3));
  assert.equal(await boundedBody(new Request('https://worker/', { method: 'POST', body: 'abc' }), 3), 'abc');
  const read = new Request(remote + '/info/refs?service=git-upload-pack');
  assert.equal(gitOperation(read, remote, 'clone'), true);
  assert.equal(gitOperation(read, remote, 'agent'), false);
  assert.equal(gitOperation(new Request(remote.replace('agent-a', 'agent-b') + '/info/refs?service=git-upload-pack'), remote, 'clone'), false);
  assert.equal(gitOperation(new Request(remote + '/info/refs?service=git-receive-pack'), remote, 'publish'), true);
  assert.equal(gitOperation(new Request(remote + '/info/refs?service=git-receive-pack'), remote, 'clone'), false);
  assert.equal(inference(new Request('https://golf-ai.internal/v1/chat/completions', { method: 'POST' })), true);
  for (const path of ['http://golf-ai.internal/v1/chat/completions', 'https://evil/v1/chat/completions', 'https://golf-ai.internal/v1/chat/completions?extra=1']) {
    assert.equal(inference(new Request(path, { method: 'POST' })), false);
  }
  const finish = JSON.stringify({ type: 'step_finish', part: { reason: 'stop', tokens: { input: 3, output: 2, reasoning: 0 } } });
  assert.equal(projectedEvents(finish).complete, true);
  assert.equal(projectedEvents(finish).tokens, 5);
  assert.equal(projectedEvents(finish + '\n' + JSON.stringify({ type: 'error', error: { secret: 'withheld' } })).complete, false);
  assert.deepEqual(projectedEvents(JSON.stringify({ type: 'error', error: { name: 'APIError', data: { message: 'Invalid model response' } } })).events,
    [{ kind: 'error', name: 'APIError', message: 'Invalid model response' }]);
  assert.equal(projectedEvents('').complete, false);
  assert.equal(projectedEvents('{\"type\":', false).complete, false);
  assert.throws(() => projectedEvents('{\"type\":', true));
  assert.throws(() => projectedEvents(JSON.stringify({ type: 'step_finish', part: { reason: 'stop' } })));
  assert.equal(policy.tools.bash, undefined);
  assert.equal(policy.permission.external_directory, 'deny');
  assert.equal(policy.permission.edit['calc.py'], 'allow');
  const resolved = { name: 'golf-workspace', tools: { read: true, edit: true, write: true, bash: false }, permission: [
    ['*', '*', 'allow'], ['*', '*', 'deny'], ['read', '*', 'deny'], ['read', 'calc.py', 'allow'],
    ['edit', '*', 'deny'], ['edit', 'calc.py', 'allow'],
    ['apply_patch', '*', 'deny'], ['external_directory', '*', 'deny'], ['external_directory', '/auth/data/opencode/tool-output/*', 'allow'],
  ].map(([permission, pattern, action]) => ({ permission, pattern, action })) };
  assert.equal(nativePolicy(resolved), true);
  assert.equal(nativePolicy({ ...resolved, tools: { ...resolved.tools, bash: true } }), false);
  assert.equal(nativePolicy({ ...resolved, permission: [...resolved.permission, { permission: 'edit', pattern: '*', action: 'allow' }] }), false);
  assert.equal(nativePolicy({ ...resolved, permission: [] }), false);
  const source = 'data: {"choices":[{"delta":{"content":"hi"}}]}\n\ndata: {"response":"","usage":{"prompt_tokens":1423,"completion_tokens":107,"total_tokens":1530}}\n\ndata: [DONE]\n\n';
  const bytes = new TextEncoder().encode(source);
  const fragmented = new ReadableStream({ start(controller) {
    for (let i = 0; i < bytes.length; i += 7) controller.enqueue(bytes.slice(i, i + 7));
    controller.close();
  } });
  assert.equal(await new Response(openAIStream(fragmented)).text(), source.replace('{"response":"",', '{"choices":[],'));
  await assert.rejects(new Response(openAIStream(new Response('data: {"response":"","usage":{}}\n').body)).text());
  await assert.rejects(new Response(openAIStream(new Response('data: ' + 'x'.repeat(65536)).body)).text());
});

test('the agent model is part of the policy identity, and the deploy policy carries none', async () => {
  const { filePolicy, policyIdentity, model } = await import('./src/policy.mjs');
  assert.equal(filePolicy('calc.py').provider.golf.models.coder.name, model);
  assert.equal(filePolicy('calc.py', '@cf/zai-org/glm-5.3').provider.golf.models.coder.name, '@cf/zai-org/glm-5.3');
  assert.equal(JSON.stringify(filePolicy('calc.py', null)).includes(model), false);
  const deploy = 'a'.repeat(64);
  assert.match(await policyIdentity(deploy, model), /^[a-f0-9]{64}$/);
  assert.notEqual(await policyIdentity(deploy, model), await policyIdentity(deploy, '@cf/zai-org/glm-5.3'));
});
