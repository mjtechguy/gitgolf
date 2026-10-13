import test from 'node:test';
import assert from 'node:assert/strict';
import { Code, ConnectError } from '@connectrpc/connect';
import { nativeAPI } from '../src/nativeAPI.ts';

test('native read rolling-update fallback preserves the request and retries only the older endpoint once', async t => {
  for (const path of ['/native/pr-evidence/read', '/native/pr-preview/read']) {
    const calls: string[] = [], body = { action: 'list', repositoryId: '1' }, signal = new AbortController().signal;
    t.mock.method(globalThis, 'fetch', async (url: RequestInfo | URL, init?: RequestInit) => {
      calls.push(String(url)); assert.equal(init?.signal, signal); assert.equal(init?.body, JSON.stringify(body));
      assert.equal(init?.credentials, 'same-origin'); assert.equal(init?.redirect, 'error');
      return Response.json(calls.length === 1 ? { code: 'unimplemented' } : { jobs: [] }, { status: calls.length === 1 ? 501 : 200 });
    });
    assert.deepEqual(await nativeAPI(path, body, signal), { jobs: [] });
    assert.deepEqual(calls, [path, path.slice(0, -5)]);
  }
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => { calls++; return Response.json({}, { status: 501 }); });
  await assert.rejects(nativeAPI('/native/pr-evidence/read', { action: 'list' }), e => e instanceof ConnectError && e.code === Code.Unimplemented);
  assert.equal(calls, 2);
});

test('native transport never retries permission failures, unavailable backends or mutations', async t => {
  for (const [status, code] of [[401, Code.Unauthenticated], [403, Code.PermissionDenied], [404, Code.NotFound], [412, Code.FailedPrecondition], [503, Code.Unavailable]]) {
    let calls = 0;
    t.mock.method(globalThis, 'fetch', async () => { calls++; return Response.json({ message: 'denied' }, { status }); });
    await assert.rejects(nativeAPI('/native/pr-evidence/read', { action: 'list' }), e => e instanceof ConnectError && e.code === code);
    assert.equal(calls, 1);
  }
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => { calls++; return Response.json({}, { status: 501 }); });
  await assert.rejects(nativeAPI('/native/pr-evidence', { action: 'create' })); assert.equal(calls, 1);
  await assert.rejects(nativeAPI('/native/pr-evidence/read', { action: 'create' })); assert.equal(calls, 2);
  await assert.rejects(nativeAPI('/native/pr-preview/read', { action: 'grant' })); assert.equal(calls, 3);
  t.mock.method(globalThis, 'fetch', async () => new Response('Sign in', { headers: { 'Content-Type': 'text/html' } }));
  await assert.rejects(nativeAPI('/native/pr-preview/read'), /Access sign-in/);
});
