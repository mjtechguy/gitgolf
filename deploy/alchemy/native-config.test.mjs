import assert from 'node:assert/strict';
import test from 'node:test';
import { bindings, ownedDomain } from './native-config.mjs';

test('gateway domain ownership excludes runtime preview domains and rejects foreign owners', () => {
  const expected = { hostname: 'preview.example.com', service: 'gateway', zoneId: 'zone' };
  const domain = { ...expected, id: 'domain' };
  const runtime = { ...domain, id: 'app', hostname: 'app.preview.example.com' };
  assert.equal(ownedDomain([runtime, domain], expected), domain);
  assert.equal(ownedDomain([runtime], expected), undefined);
  for (const patch of [{ service: 'other' }, { zoneId: 'other' }, { id: '' }])
    assert.throws(() => ownedDomain([{ ...domain, ...patch }], expected), /ownership/);
  assert.throws(() => ownedDomain([domain, domain], expected), /ownership/);
});

test('the native build keeps credentials as secret references and restricts app egress', () => {
  assert.deepEqual(bindings({ env: {
    DB: { type: 'd1', id: 'db-id' },
    SIGNING: { type: 'secrets-store-secret', storeId: 'store-id', secretName: 'signing' },
    APP_DISPATCH: { type: 'dispatch-namespace', namespace: 'demo', outbound: { worker: 'demo-outbound' } },
    FORGE: { type: 'worker', worker: 'demo', exportName: 'PreviewBroker' },
    USAGE_ANALYTICS: { type: 'analytics-engine-dataset', name: 'demo_evidence' },
    AI: { type: 'ai' },
  } }), [
    { name: 'DB', type: 'd1', id: 'db-id', databaseId: 'db-id' },
    { name: 'SIGNING', type: 'secrets_store_secret', storeId: 'store-id', secretName: 'signing' },
    { name: 'APP_DISPATCH', type: 'dispatch_namespace', namespace: 'demo', outbound: { worker: { service: 'demo-outbound' } } },
    { name: 'FORGE', type: 'service', service: 'demo', entrypoint: 'PreviewBroker' },
    { name: 'USAGE_ANALYTICS', type: 'analytics_engine', dataset: 'demo_evidence' },
    { name: 'AI', type: 'ai' },
  ]);
  assert.throws(() => bindings({ env: { FUTURE: { type: 'unknown' } } }), /Unqualified/);
});

test('the anonymous read limiter keeps its namespace, limit and period', () => {
  assert.deepEqual(bindings({ env: {
    ANONYMOUS_READS: { type: 'rate-limit', namespace: '1001', simple: { limit: 300, period: 60 } },
    ANONYMOUS_READ_LIMIT: { type: 'text', value: '300/60' },
  } }), [
    { name: 'ANONYMOUS_READS', type: 'ratelimit', namespaceId: '1001', simple: { limit: 300, period: 60 } },
    { name: 'ANONYMOUS_READ_LIMIT', type: 'plain_text', text: '300/60' },
  ]);
});

test('the email binding is restricted to one sender and refuses any other shape', () => {
  const sender = 'golf@mail.golf.example.com';
  assert.deepEqual(bindings({ env: { EMAIL: { type: 'send-email', allowedSenderAddresses: [sender] }, EMAIL_POLICY: { type: 'text', value: '{}' } } }), [
    { name: 'EMAIL', type: 'send_email', allowedSenderAddresses: [sender] },
    { name: 'EMAIL_POLICY', type: 'plain_text', text: '{}' },
  ]);
  for (const value of [{}, { allowedSenderAddresses: [] }, { allowedSenderAddresses: [sender, 'other@example.com'] }, { allowedSenderAddresses: sender },
    { allowedSenderAddresses: [sender], destinationAddress: 'someone@example.com' }, { allowedSenderAddresses: [sender], allowedDestinationAddresses: ['someone@example.com'] }, { allowedSenderAddresses: [sender], dev: {} }])
    assert.throws(() => bindings({ env: { EMAIL: { type: 'send-email', ...value } } }), /Unqualified Alchemy email binding/, JSON.stringify(value));
});

test('the search binding names one Vectorize index and refuses any other shape', () => {
  assert.deepEqual(bindings({ env: { SEARCH_INDEX: { type: 'vectorize', name: 'demo-search' }, SEARCH_DIMENSIONS: { type: 'text', value: '1024' } } }), [
    { name: 'SEARCH_INDEX', type: 'vectorize', indexName: 'demo-search' },
    { name: 'SEARCH_DIMENSIONS', type: 'plain_text', text: '1024' },
  ]);
  for (const value of [{}, { name: '' }, { name: 'Demo_Search' }, { name: 'demo-search', dev: { remote: true } }, { name: 7 }])
    assert.throws(() => bindings({ env: { SEARCH_INDEX: { type: 'vectorize', ...value } } }), /Unqualified Alchemy Vectorize binding/, JSON.stringify(value));
});

test('the SSH hosts VPC binding names one tunnel or the Mesh network and refuses any other shape', () => {
  const tunnelId = 'd44bf2a4-2cb5-4004-911f-0d90569674f1';
  assert.deepEqual(bindings({ env: { SSH_VPC_NETWORK: { type: 'vpc-network', tunnelId } } }), [{ name: 'SSH_VPC_NETWORK', type: 'vpc_network', tunnelId }]);
  assert.deepEqual(bindings({ env: { SSH_VPC_NETWORK: { type: 'vpc-network', networkId: 'cf1:network' } } }), [{ name: 'SSH_VPC_NETWORK', type: 'vpc_network', networkId: 'cf1:network' }]);
  for (const value of [{}, { tunnelId, networkId: 'cf1:network' }, { tunnelId: 'not-a-uuid' }, { networkId: 'other' }, { tunnelId, extra: 1 }])
    assert.throws(() => bindings({ env: { SSH_VPC_NETWORK: { type: 'vpc-network', ...value } } }), /Unqualified/);
});
