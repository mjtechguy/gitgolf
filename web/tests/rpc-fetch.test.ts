import test from 'node:test';
import assert from 'node:assert/strict';
import { Code, ConnectError } from '@connectrpc/connect';
import { rpcFetch } from '../src/rpcFetch.ts';

test('RPC transport refuses redirect bodies and expires private authority', async () => {
  const original = globalThis.fetch;
  try {
    for (const response of [new Response(null, { status: 302 }), Object.defineProperty(new Response(), 'type', { value: 'opaqueredirect' })]) {
      globalThis.fetch = async (_input, init) => {
        assert.equal(init?.redirect, 'manual'); assert.equal(init?.credentials, 'same-origin'); assert.equal(init?.cache, 'no-store');
        return response;
      };
      await assert.rejects(rpcFetch('/rpc/test'), error => error instanceof ConnectError && error.code === Code.Unauthenticated);
    }
    const response = new Response('{}', { headers: { 'Content-Type': 'application/json' } });
    globalThis.fetch = async () => response;
    assert.equal(await rpcFetch('/rpc/test'), response);
    globalThis.fetch = async () => { throw new TypeError('network unavailable'); };
    await assert.rejects(rpcFetch('/rpc/test'), TypeError);
  } finally { globalThis.fetch = original; }
});
