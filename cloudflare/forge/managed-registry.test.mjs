import test from 'node:test';
import assert from 'node:assert/strict';
import { managedOrigin, registryBindings, registryRepository, registryNameOK, managedRegistry, managedJobRequest } from './src/managed-registry.mjs';

const account = 'a'.repeat(32), jobId = '12345678-1234-4234-8234-123456789abc', otherJob = '22345678-1234-4234-8234-123456789abc';
const digest = 'sha256:' + 'b'.repeat(64), name = account + '/golf-demo-r1';
const image = { schemaVersion: 2, mediaType: 'application/vnd.oci.image.manifest.v1+json', config: { mediaType: 'application/vnd.oci.image.config.v1+json', digest, size: 2 }, layers: [] };
const execution = { jobId, expiresAt: Date.now() + 600000 };
function fixture() {
  const entries = new Map(), calls = [];
  const env = { REGISTRY_PROVIDER: 'cloudflare', REGISTRY_ORIGIN: managedOrigin, REGISTRY_ACCOUNT: account, REGISTRY_REPOSITORY_PREFIX: account + '/golf-demo-r',
    REGISTRY_API_TOKEN: { get: async () => 'private-api-token' }, registryUploadStore: { get: async k => entries.get(k), put: async (k, v) => entries.set(k, v), delete: async k => entries.delete(k), list: async () => new Map(entries) } };
  let next = () => new Response(null, { status: 404 });
  const provider = async (url, options) => {
    calls.push({ url, options });
    if (url.startsWith('https://api.cloudflare.com/')) {
      assert.equal(options.headers.Authorization, 'Bearer private-api-token');
      return Response.json({ success: true, result: { account_id: account, registry_host: 'registry.cloudflare.com', username: 'operator', password: 'private-registry-token' } });
    }
    assert.equal(options.redirect, 'manual');
    assert.equal(options.headers.get('Authorization'), 'Basic ' + btoa('operator:private-registry-token'));
    assert.equal(options.headers.get('Cookie'), null); assert.equal(options.headers.get('X-Secret'), null);
    return next(url, options);
  };
  const request = (suffix, method = 'GET', body) => new Request(managedOrigin + '/v2/' + name + '/' + suffix, { method, headers: { Authorization: 'Bearer caller', Cookie: 'caller-secret', 'X-Secret': 'caller-secret', 'Content-Type': 'application/vnd.oci.image.manifest.v1+json' }, body });
  return { env, entries, calls, provider, request, respond: fn => { next = fn; }, run: (request, job = execution, authorize) => managedJobRequest(env, name, job, request, provider, authorize) };
}

test('managed preparation uses Secrets Store and immutable installation/repository coordinates', () => {
  const settings = { account, worker: 'golf-demo', tests: {}, registry: { provider: 'cloudflare', ci: true, apiToken: { store: account, name: 'registry-operator' } } };
  const bindings = registryBindings(settings);
  assert.equal(bindings.REGISTRY, undefined); assert.equal(bindings.REGISTRY_API_TOKEN.type, 'secrets-store-secret');
  assert.equal(bindings.REGISTRY_ORIGIN.value, managedOrigin);
  const env = Object.fromEntries(Object.entries(bindings).map(([k, v]) => [k, v.value]));
  assert.equal(registryRepository(env, { id: 1, name: 'renamed' }), name);
  assert.equal(registryNameOK(env, name), true); assert.equal(registryNameOK(env, account + '/other-r1'), false);
  assert.throws(() => registryBindings({ ...settings, tests: undefined }), /approved test/);
  for (const registry of [{ ...settings.registry, apiToken: { store: 'raw-token', name: 'token' } }, { ...settings.registry, worker: 'custom-registry' }, { ...settings.registry, ci: 'true' }]) assert.throws(() => registryBindings({ ...settings, registry }));
  assert.equal(registryBindings({ ...settings, registry: { worker: 'legacy-cfcr', origin: 'https://registry.example.com' } }).REGISTRY.worker, 'legacy-cfcr');
});

test('jobs cannot access foreign repositories, tags, mounts, catalog, token endpoints or encoded paths', async () => {
  const f = fixture();
  for (const request of [
    f.request('manifests/latest', 'PUT', JSON.stringify(image)), f.request('manifests/ci-' + otherJob),
    f.request('blobs/uploads/?mount=' + digest + '&from=other', 'POST'), f.request('blobs/uploads/?digest=' + digest + '&digest=' + digest, 'POST'),
    f.request('tags/list'), f.request('manifests/%63i-' + jobId),
    new Request(managedOrigin + '/v2/' + account + '/other-r1/manifests/' + digest), new Request(managedOrigin + '/v2/_catalog'), new Request(managedOrigin + '/token'),
    new Request('https://other.example.com/v2/' + name + '/manifests/' + digest),
  ]) await assert.rejects(f.run(request));
  assert.equal(f.calls.length, 0);
});

test('upload continuation is persisted, job-bound and hides provider continuation state', async () => {
  const f = fixture(), path = '/v2/' + name + '/blobs/uploads/upload-123';
  f.respond(() => new Response(null, { status: 202, headers: { Location: managedOrigin + path + '?_state=private-upload-state', 'Docker-Upload-UUID': 'upload-123' } }));
  const started = await f.run(f.request('blobs/uploads/', 'POST'));
  assert.equal(started.headers.get('Location'), managedOrigin + path);
  assert.equal(f.entries.get('managed-upload:' + path).jobId, jobId);
  await assert.rejects(f.run(f.request('blobs/uploads/upload-123', 'PATCH', 'part'), { ...execution, jobId: otherJob }));
  f.respond((url, options) => { assert.equal(url, managedOrigin + path + '?_state=private-upload-state'); assert.equal(new TextDecoder().decode(options.body), 'part'); return new Response(null, { status: 202, headers: { Location: managedOrigin + path + '?_state=next-state' } }); });
  await f.run(f.request('blobs/uploads/upload-123', 'PATCH', 'part'));
  f.respond(url => { assert.equal(url, managedOrigin + path + '?_state=next-state&digest=' + encodeURIComponent(digest)); return new Response(null, { status: 201, headers: { 'Docker-Content-Digest': digest } }); });
  await f.run(f.request('blobs/uploads/upload-123?digest=' + encodeURIComponent(digest), 'PUT'));
  assert.equal(f.entries.size, 0);
});

test('immutable job tags refuse different bytes and replay identical publications', async () => {
  const f = fixture(), bytes = JSON.stringify(image), published = 'sha256:' + Buffer.from(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(bytes))).toString('hex');
  f.respond(() => new Response(bytes, { headers: { 'Docker-Content-Digest': published } }));
  assert.equal((await f.run(f.request('manifests/ci-' + jobId, 'PUT', bytes))).status, 201);
  await assert.rejects(f.run(f.request('manifests/ci-' + jobId, 'PUT', JSON.stringify({ ...image, annotations: { changed: 'true' } }))));
  assert.equal(f.calls.filter(c => c.url.startsWith(managedOrigin) && c.options.method === 'PUT').length, 0);
});

test('authority is rechecked after credential minting and provider error bodies never escape', async () => {
  const f = fixture(); let authorized = true;
  f.env.REGISTRY_API_TOKEN.get = async () => { authorized = false; return 'private-api-token'; };
  await assert.rejects(f.run(f.request('blobs/' + digest), execution, async () => { if (!authorized) throw Error('revoked'); }), /revoked/);
  assert.equal(f.calls.filter(c => c.url.startsWith(managedOrigin)).length, 0);
  const error = fixture(); error.respond(() => new Response('private-registry-token', { status: 503 }));
  await assert.rejects(error.run(error.request('blobs/' + digest)), e => !e.message.includes('private-registry-token'));
});

test('inventory hashes actual manifests, remains repository-bound and checks current access after reads', async () => {
  const f = fixture(), bytes = JSON.stringify(image), published = 'sha256:' + Buffer.from(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(bytes))).toString('hex');
  let permitted = true;
  f.respond(url => url.includes('/tags/list') ? Response.json({ name, tags: ['ci-' + jobId, published] }) : new Response(bytes, { headers: { 'Docker-Content-Digest': published } }));
  const registry = managedRegistry(f.env, async () => ({ read: permitted }), f.provider), input = { action: 'status', actorId: '1', binding: { repositoryId: '1', name: 'team/project' } };
  const result = await registry.manage(input);
  assert.equal(result.imageRepository, name); assert.equal(result.artifacts[0].digest, published); assert.equal(result.provider, 'cloudflare');
  assert.equal(result.artifacts.length, 1);
  await assert.rejects(registry.manage({ ...input, action: 'credential' }));
  f.respond(() => { permitted = false; return Response.json({ name, tags: [] }); });
  await assert.rejects(registry.manage(input));
});
