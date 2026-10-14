// RepositoryEnvironmentService on real workerd and D1 with a local Access dev identity; no provider writes.
// Run: node cloudflare/forge/environments-check.mjs "$(command -v cf)". Preview publication itself is covered by core.test.mjs.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import * as esbuild from '../agents/node_modules/esbuild/lib/main.js';
import { previewEnvironmentGuard } from './src/environments.mjs';
const cli = dirname(dirname(realpathSync(process.argv[2])));
if (JSON.parse(await readFile(resolve(cli, 'package.json'), 'utf8')).version !== '1.0.0-beta.13') throw Error('Qualify native CLI');
const { Miniflare, convertV4MiniflareOptions } = await import(pathToFileURL(resolve(cli, 'node_modules/miniflare/dist/src/index.js')).href);
// One bundle, built the way release.mjs builds the production Worker.
const built = await esbuild.build({ entryPoints: ['cloudflare/forge/src/worker.mjs'], bundle: true, write: false, format: 'esm', platform: 'neutral',
  define: { GOLF_NATIVE_ASSETS: '{}', GOLF_NATIVE_RELEASE: '"local"', GOLF_NATIVE_CONFIGURATION: '"local"' }, nodePaths: ['cloudflare/agents/node_modules'],
  conditions: ['workerd', 'worker', 'browser'], external: ['cloudflare:workers', 'node:*'] });
const origin = 'http://golf.local.invalid';
const runtime = new Miniflare(convertV4MiniflareOptions({
  host: '127.0.0.1', port: 0, modules: [{ type: 'ESModule', path: 'worker.mjs', contents: built.outputFiles[0].text }], compatibilityDate: '2026-10-08', compatibilityFlags: ['nodejs_compat'],
  bindings: { PUBLIC_ORIGIN: origin, WORKSPACE_SLUG: 'local-access-proof', ARTIFACTS_NAMESPACE: 'local-access-proof', ACCESS_AUD: 'local-access-proof',
    PREVIEW_ORIGIN: 'https://preview.example.net', PREVIEW_ACCESS_AUD: 'preview-aud', PREVIEW_PATH: 'public', PREVIEW_TTL: '900' },
  access: { aud: 'local-access-proof', identity: { email: 'owner@example.invalid' } },
  d1Databases: { DB: 'local-environment-proof' }, r2Buckets: { EVIDENCE_BUCKET: 'local-environment-proof' }, durableObjects: { WORKSPACE: { className: 'Workspace', useSQLite: true } },
}));
try {
  const db = await runtime.getD1Database('DB');
  for (const sql of (await readFile(new URL('./schema.sql', import.meta.url), 'utf8')).replace(/--[^\n]*/g, '').split(/;\s*(?=CREATE\b)/).filter(s => s.trim())) await db.prepare(sql).run();
  await db.prepare("INSERT INTO users(id,login,email,can_create) VALUES(1,'local-reviewer','owner@example.invalid',1)").run();
  await db.prepare("INSERT OR IGNORE INTO workspaces(slug,artifact_namespace) VALUES('local-access-proof','local-access-proof')").run();
  await db.prepare("INSERT INTO repositories(id,name,description,artifact_name,creator_id,creation_key,input_hash,state,created_at) VALUES(1,'env-proof','','env-proof',1,'original','hash','ACTIVE',?)").bind(new Date().toISOString()).run();
  await db.prepare("INSERT INTO grants VALUES(1,1,'admin')").run();
  const rpc = (path, body = {}, headers = {}) => runtime.dispatchFetch(origin + path, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Connect-Protocol-Version': '1', Origin: origin, ...headers }, body: JSON.stringify(body) });
  const call = async (method, body, status = 200) => { const response = await rpc('/rpc/golf.v1.RepositoryEnvironmentService/' + method, body); assert.equal(response.status, status, await response.clone().text()); return response.json(); };
  assert.equal((await (await rpc('/native/diagnostics')).json()).schema, 32);
  const capability = (await (await rpc('/rpc/golf.v1.CapabilityService/ListCapabilities')).json()).capabilities.find(c => c.id === 'settings.repository-environments');
  assert.equal(capability.state, 'CAPABILITY_STATE_READY'); assert.match(capability.reason, /^One environment named preview governs protected pull-request previews/);
  const repository = { owner: 'local-access-proof', name: 'env-proof' };
  const { access } = await (await rpc('/rpc/golf.v1.RepositoryAccessService/GetRepositoryAccess', { repository, repositoryId: '1', ownerId: '1' })).json();
  const target = { repository, repositoryId: '1', ownerId: '1', accessRevision: access.revision };
  assert.deepEqual(await call('ListRepositoryEnvironments', { target }), { target, environments: [], page: { nextPage: 0 }, totalCount: '0', capability: 'REPOSITORY_ENVIRONMENT_CAPABILITY_PREVIEW_POLICY', deploymentAvailable: false });
  const policy = { allowAllSources: true, preventSelfApproval: true, protectedPreviews: true, maxConcurrency: 2, previewTtlSeconds: 600 };
  const input = { target, environmentId: crypto.randomUUID(), expectedVersion: '0', operationId: crypto.randomUUID(), name: 'preview', policy };
  const counts = async () => Promise.all(['repository_environments', 'repository_environment_versions', 'repository_environment_operations'].map(async table => (await db.prepare(`SELECT count(*) AS n FROM ${table}`).first()).n));
  // Refusals leave real D1 untouched.
  assert.equal((await call('SaveRepositoryEnvironment', { ...input, name: 'production' }, 400)).code, 'invalid_argument');
  assert.match((await call('SaveRepositoryEnvironment', { ...input, policy: { ...policy, previewTtlSeconds: 901 } }, 400)).message, /between 60 and 900 seconds/);
  assert.equal((await call('SaveRepositoryEnvironment', { ...input, policy: { ...policy, waitSeconds: 5 } }, 400)).code, 'invalid_argument');
  assert.equal((await rpc('/rpc/golf.v1.RepositoryEnvironmentService/SaveRepositoryEnvironment', input, { 'CF-Access-Client-Id': 'service' })).status, 404);
  assert.deepEqual(await counts(), [0, 0, 0]);
  const saved = await call('SaveRepositoryEnvironment', input);
  assert.equal(saved.operation.state, 'SUCCEEDED'); assert.equal(saved.environment.version, '1'); assert.deepEqual(await counts(), [1, 1, 1]);
  assert.deepEqual(await call('SaveRepositoryEnvironment', input), saved);
  assert.deepEqual(await call('GetRepositoryEnvironmentOperation', { target, operationId: input.operationId }), saved);
  assert.equal((await call('SaveRepositoryEnvironment', { ...input, policy: { ...policy, maxConcurrency: 1 } }, 412)).code, 'failed_precondition');
  assert.equal((await call('SaveRepositoryEnvironment', { ...input, operationId: crypto.randomUUID(), expectedVersion: '2' }, 409)).code, 'aborted');
  assert.equal((await call('SaveRepositoryEnvironment', { ...input, operationId: crypto.randomUUID(), environmentId: crypto.randomUUID() }, 409)).code, 'aborted');
  assert.deepEqual(await counts(), [1, 1, 1]);
  const edited = await call('SaveRepositoryEnvironment', { ...input, operationId: crypto.randomUUID(), expectedVersion: '1', policy: { ...policy, allowAllSources: false, sources: [{ kind: 'REPOSITORY_SOURCE_REF_KIND_BRANCH', name: 'release/next' }] } });
  assert.equal(edited.environment.version, '2'); assert.equal(edited.environment.createdAt, saved.environment.createdAt); assert.deepEqual(await counts(), [1, 2, 2]);
  assert.deepEqual((await call('ListRepositoryEnvironments', { target })).environments, [edited.environment]);
  // The publication fence against real D1, in the shape delivery.mjs uses (exported guard, same-table count, RETURNING through first()):
  // a stand-in row is inserted only under the observed revision and below the limit.
  const probe = (revision, limit) => db.prepare(`INSERT INTO repository_environment_operations(operation_id,repository_id,actor_id,environment_id,version,action,expected_version,input_hash,created_at)
    SELECT ?,1,1,?,9,'save',8,'probe',? WHERE ${previewEnvironmentGuard} AND (SELECT count(*) FROM repository_environment_operations WHERE repository_id=? AND input_hash=?)<? RETURNING *`)
    .bind(crypto.randomUUID(), input.environmentId, new Date().toISOString(), 1, revision, 1, 'probe', limit).first();
  assert.equal(await probe(`${input.environmentId}:1`, 1), null); assert.equal(await probe('', 1), null);
  assert.equal((await probe(`${input.environmentId}:2`, 1)).input_hash, 'probe'); assert.equal(await probe(`${input.environmentId}:2`, 1), null);
  assert.equal((await db.prepare("DELETE FROM repository_environment_operations WHERE input_hash='probe'").run()).meta.changes, 1); assert.deepEqual(await counts(), [1, 2, 2]);
  const removal = { target, environmentId: input.environmentId, expectedVersion: '2', operationId: crypto.randomUUID() };
  const removed = await call('DeleteRepositoryEnvironment', removal);
  assert.equal(removed.environment.deleted, true); assert.equal(removed.environment.version, '3'); assert.deepEqual(await call('DeleteRepositoryEnvironment', removal), removed);
  assert.deepEqual((await call('ListRepositoryEnvironments', { target })).environments, []); assert.deepEqual(await counts(), [1, 3, 3]);
  assert.equal((await call('SaveRepositoryEnvironment', { ...input, operationId: crypto.randomUUID(), expectedVersion: '3' }, 409)).code, 'aborted');
  assert.equal((await call('SaveRepositoryEnvironment', { ...input, operationId: crypto.randomUUID(), environmentId: crypto.randomUUID() })).environment.version, '1');
  console.log('Real Access/workerd/D1 environments: refusals, atomic version/receipt, replay, stale refusals, edit, guarded insert, delete and recreate passed');
} finally { await runtime.dispose(); }
