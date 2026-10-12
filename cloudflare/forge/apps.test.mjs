import test from 'node:test';
import assert from 'node:assert/strict';
import { provider } from './src/apps.mjs';

test('provider accepts empty deletion acknowledgements while reads and malformed replies remain fenced', async () => {
  const env = { ACCOUNT_ID: 'a'.repeat(32), APP_PROVISIONER: { async get() { return 'scoped_test_token_123456789'; } },
    async appProviderFetch() { return new Response(null, { status: 200 }); } };
  assert.equal(await provider(env, '/workers/domains/owned', 'DELETE'), null);
  await assert.rejects(provider(env, '/workers/domains/owned'), /unconfirmed/);
  env.appProviderFetch = async () => new Response('invalid', { status: 200 });
  await assert.rejects(provider(env, '/workers/domains/owned', 'DELETE'), /unconfirmed/);
  env.appProviderFetch = async () => new Response(null, { status: 403 });
  await assert.rejects(provider(env, '/workers/domains/owned', 'DELETE'), /unconfirmed/);
  env.appProviderFetch = async () => Response.json({ success: true, result: { dispatch_namespace: 'owned', script: null } });
  assert.equal(await provider(env, '/workers/dispatch/namespaces/owned/scripts/missing'), null);
  assert.notEqual(await provider(env, '/workers/dispatch/namespaces/owned'), null);
});
