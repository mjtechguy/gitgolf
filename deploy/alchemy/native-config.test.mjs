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
  } }), [
    { name: 'DB', type: 'd1', id: 'db-id', databaseId: 'db-id' },
    { name: 'SIGNING', type: 'secrets_store_secret', storeId: 'store-id', secretName: 'signing' },
    { name: 'APP_DISPATCH', type: 'dispatch_namespace', namespace: 'demo', outbound: { worker: { service: 'demo-outbound' } } },
    { name: 'FORGE', type: 'service', service: 'demo', entrypoint: 'PreviewBroker' },
    { name: 'USAGE_ANALYTICS', type: 'analytics_engine', dataset: 'demo_evidence' },
  ]);
  assert.throws(() => bindings({ env: { FUTURE: { type: 'unknown' } } }), /Unqualified/);
});
