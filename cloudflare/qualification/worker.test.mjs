import assert from 'node:assert/strict';
import test from 'node:test';
import worker from './src/worker.mjs';

const secret = 'qualification-private-token-0123456789';
function request(path = '/inspect', token = secret, method = 'GET') {
  return new Request(`https://golf.invalid${path}`, { method, headers: { Authorization: `Bearer ${token}` } });
}
function environment() {
  return {
    GOLF_PROBE_TOKEN: secret,
    GOLF_PROBE_OBJECT_KEY: 'operator-selected-private-key',
    EVIDENCE: { async head(key) { assert.equal(key, 'operator-selected-private-key'); return { size: 12, name: 'private-data' }; } },
    ARTIFACTS: { async list(options) { assert.deepEqual(options, { limit: 1 }); return { repos: [{ name: 'private-repo' }], cursor: 'private-cursor' }; } },
  };
}

test('private binding inspection and failure boundaries', async t => {
  await t.test('unauthorized requests never reach bindings', async () => {
    const env = environment();
    env.EVIDENCE.head = env.ARTIFACTS.list = () => assert.fail('denied request reached provider');
    for (const token of ['', 'different-private-token-0123456789', 'invalid token-with-spaces-0123456789', secret + 'x']) {
      const response = await worker.fetch(request('/inspect', token), env);
      assert.equal(response.status, 401);
      assert.equal(response.headers.get('cache-control'), 'no-store');
    }
  });
  await t.test('missing secret fails closed', async () => {
    const env = environment(); delete env.GOLF_PROBE_TOKEN;
    assert.equal((await worker.fetch(request(), env)).status, 503);
  });
  await t.test('metadata observation excludes private content and credentials', async () => {
    const response = await worker.fetch(request(), environment());
    assert.equal(response.status, 200);
    const body = await response.text();
    for (const value of [secret, 'private-data', 'private-repo', 'private-cursor', 'operator-selected-private-key']) assert.ok(!body.includes(value));
    assert.deepEqual(JSON.parse(body).observations.map(o => o.state), ['accessible', 'accessible']);
  });
  await t.test('missing objects and provider errors are independent', async () => {
    const env = environment();
    env.EVIDENCE.head = async () => null;
    let response = await worker.fetch(request(), env);
    assert.equal(response.status, 503);
    assert.deepEqual((await response.json()).observations.map(o => o.state), ['not_found', 'accessible']);
    env.EVIDENCE.head = async () => { throw new Error(secret); };
    response = await worker.fetch(request(), env);
    const body = await response.text();
    assert.ok(!body.includes(secret));
    assert.deepEqual(JSON.parse(body).observations.map(o => o.state), ['unavailable', 'accessible']);
  });
  await t.test('malformed binding responses and missing bindings never report success', async () => {
    const env = environment();
    env.EVIDENCE.head = async () => ({ size: -1 });
    env.ARTIFACTS.list = async () => ({ repos: null });
    let response = await worker.fetch(request(), env);
    assert.equal(response.status, 503);
    assert.deepEqual((await response.json()).observations.map(o => o.state), ['invalid_response', 'invalid_response']);
    delete env.EVIDENCE; delete env.ARTIFACTS;
    response = await worker.fetch(request(), env);
    assert.deepEqual((await response.json()).observations.map(o => o.state), ['unconfigured', 'unconfigured']);
  });
  await t.test('route, query, method and public HTTP cannot broaden inspection', async () => {
    const env = environment();
    env.EVIDENCE.head = env.ARTIFACTS.list = () => assert.fail('invalid route reached provider');
    assert.equal((await worker.fetch(request('/inspect?key=another-key'), env)).status, 404);
    assert.equal((await worker.fetch(request('/repos'), env)).status, 404);
    assert.equal((await worker.fetch(request('/inspect', secret, 'POST'), env)).status, 405);
    const insecure = new Request('http://public.invalid/inspect', { headers: { Authorization: `Bearer ${secret}` } });
    assert.equal((await worker.fetch(insecure, env)).status, 400);
  });
  await t.test('hung binding is reported as timeout', async () => {
    const env = environment();
    env.ARTIFACTS.list = () => new Promise(() => {});
    const response = await worker.fetch(request(), env);
    assert.equal(response.status, 503);
    assert.deepEqual((await response.json()).observations.map(o => o.state), ['accessible', 'timeout']);
  });
});
