// Real workerd and D1: the audit log records a runner pool, a runner enrollment (credential issued), a repository runner placement and a refusal,
// reads them back by scope with GitHub-style descriptions, and never stores the one-time credential. No provider binding is used.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import * as esbuild from '../agents/node_modules/esbuild/lib/main.js';

const cli = dirname(dirname(realpathSync(process.argv[2])));
if (JSON.parse(await readFile(resolve(cli, 'package.json'), 'utf8')).version !== '1.0.0-beta.13') throw Error('Qualify native CLI');
const { Miniflare, convertV4MiniflareOptions } = await import(pathToFileURL(resolve(cli, 'node_modules/miniflare/dist/src/index.js')).href);
const bundle = await esbuild.build({ stdin: { resolveDir: resolve('cloudflare/forge'), sourcefile: 'audit-runtime-fixture.mjs', contents: `
import { handle } from './src/core.mjs';
// Allocation stand-ins: Actions and runner placement need an approved test profile; nothing here runs a job or reaches a provider.
export default { fetch(request, env) { return handle(request, { ...env, testTasks: {}, EVIDENCE_BUCKET: {}, EVIDENCE_QUEUE: { async send() {} } }); } };` },
  bundle: true, write: false, format: 'esm', platform: 'neutral' });
const script = bundle.outputFiles[0].text;
const origin = 'https://golf.example.com', image = 'sha256:' + 'a'.repeat(64);
const runtime = new Miniflare(convertV4MiniflareOptions({ modules: true, script, compatibilityDate: '2026-10-08', d1Databases: { DB: 'audit-proof' },
  bindings: { PUBLIC_ORIGIN: origin, WORKSPACE_SLUG: 'alice', ARTIFACTS_NAMESPACE: 'audit-proof', ACCOUNT_ID: 'a'.repeat(32), TEST_EXECUTION_ENABLED: 'true', TEST_IMAGE_ID: image,
    TEST_WORKFLOW_FORMAT: 'actions', TEST_WORKFLOW_PATH: '.github/workflows/check.yml', TEST_POLICY_SHA256: 'b'.repeat(64), EVIDENCE_QUEUE_NAME: 'evidence', EVIDENCE_WORKFLOW_NAME: 'evidence', EVIDENCE_DAILY_LIMIT: '5' } }));
try {
  const db = await runtime.getD1Database('DB');
  for (const sql of (await readFile(new URL('./schema.sql', import.meta.url), 'utf8')).replace(/--[^\n]*/g, '').split(/;\s*(?=CREATE\b)/).filter(s => s.trim())) await db.prepare(sql).run();
  await db.prepare("INSERT INTO users(id,login,email,can_create) VALUES(1,'alice','alice@example.com',1),(2,'bob','bob@example.com',0)").run();
  await db.prepare('INSERT INTO operations_admins(user_id) VALUES(1)').run();
  await db.prepare("INSERT INTO workspaces(slug,artifact_namespace) VALUES('alice','audit-proof')").run();
  await db.prepare("INSERT INTO repositories(id,name,description,artifact_name,creator_id,creation_key,input_hash,state,created_at) VALUES(1,'project','','repo-11111111111111111111111111111111',1,'original','hash','ACTIVE','2026-10-14T00:00:00Z')").run();
  await db.prepare("INSERT INTO grants VALUES(1,1,'admin'),(1,2,'write')").run();
  const call = async (path, body, person = 'alice', status = 200) => {
    const response = await runtime.dispatchFetch(origin + path, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Connect-Protocol-Version': '1', Origin: origin, 'X-Golf-Native-Access-Email': person + '@example.com',
      'X-Golf-Native-Access-Country': 'US', 'X-Golf-Native-Access-Colo': 'IAD', 'User-Agent': 'audit-runtime-check/1' }, body: JSON.stringify(body) });
    assert.equal(response.status, status, await response.clone().text());
    return response.json();
  };
  const poolId = crypto.randomUUID(), machineId = crypto.randomUUID(), repository = { owner: 'alice', name: 'project' };
  await call('/native/runner-admin', { action: 'savePool', id: poolId, expectedVersion: 0, name: 'mj-workstation', state: 'ACTIVE', trustClass: 'UNTRUSTED', maxParallel: 2 });
  const enrolled = await call('/native/runner-admin', { action: 'enroll', id: machineId, poolId, poolVersion: 1, name: 'mj-linux-docker', ttlHours: 8, trustExecution: true });
  assert.match(enrolled.credential, /^golf_runner_[a-f0-9-]{36}_[a-f0-9]{64}$/);
  await call('/native/runner-placement', { action: 'set', repository, repositoryId: '1', expectedVersion: 0, poolId, poolVersion: 1 });
  await call('/native/runner-admin', { action: 'enroll', id: crypto.randomUUID(), poolId, poolVersion: 1, name: 'rogue', ttlHours: 8, trustExecution: true }, 'bob', 403);

  const rows = (await db.prepare('SELECT * FROM installation_audit ORDER BY id').all()).results;
  assert.deepEqual(rows.map(row => [row.action, row.scope, row.subject]), [['runner_pool.create', 'installation', 'mj-workstation'], ['runner.enroll', 'installation', 'mj-linux-docker'],
    ['repo.update_runner_placement', 'repository', 'alice/project'], ['runner.enroll', 'installation', 'rogue']]);
  assert.deepEqual(JSON.parse(rows[1].after), { machine: 'mj-linux-docker', pool: 'mj-workstation', protocol: 'native', lifetimeHours: 8 });
  assert.deepEqual([JSON.parse(rows[2].before), JSON.parse(rows[2].after)], [{ pool: null }, { pool: 'mj-workstation' }]);
  assert.deepEqual([rows[3].actor_id, JSON.parse(rows[3].client).outcome, JSON.parse(rows[3].client).code], [2, 'denied', 'permission_denied']);
  assert.equal(JSON.parse(rows[1].client).country, 'US'); assert.equal(JSON.parse(rows[1].client).userAgent, 'audit-runtime-check/1');
  const stored = JSON.stringify(rows);
  assert.equal(stored.includes(enrolled.credential), false); assert.equal(stored.includes(enrolled.credential.split('_').at(-1)), false);

  const page = { page: 1, limit: 50 };
  const installation = await call('/native/audit/read', { scope: 'installation', page });
  assert.deepEqual(installation.entries.map(entry => [entry.actor, entry.outcome, entry.description]), [
    ['bob', 'denied', 'tried to enroll runner rogue'], ['alice', 'success', 'changed runner placement from no pool to pool mj-workstation'],
    ['alice', 'success', 'enrolled runner mj-linux-docker in pool mj-workstation'], ['alice', 'success', 'created runner pool mj-workstation']]);
  assert.equal(installation.entries[1].repository, 'alice/project'); assert.equal(installation.entries[2].client.country, 'US');
  const scoped = await call('/native/audit/read', { scope: 'repository', repository, repositoryId: '1', page });
  assert.deepEqual(scoped.entries.map(entry => entry.action), ['repo.update_runner_placement']);
  await call('/native/audit/read', { scope: 'repository', repository, repositoryId: '1', page }, 'bob', 403);
  await call('/native/audit/read', { scope: 'installation', page }, 'bob', 403);
  const denied = await call('/native/audit/read', { scope: 'installation', page, filters: { outcome: 'denied' } });
  assert.deepEqual(denied.entries.map(entry => entry.action), ['installation.access_denied', 'runner.enroll']);
  let blocked = 0;
  for (const sql of ["UPDATE installation_audit SET action='forged'", 'DELETE FROM installation_audit']) {
    try { await db.prepare(sql).run(); } catch (error) { if (/append-only/.test(String(error.message))) blocked++; }
  }
  assert.equal(blocked, 2);
  console.log('Real workerd/D1 audit log: runner pool, enrollment (credential never stored), placement change and a refused enrollment recorded; installation and repository reads, filters and append-only triggers passed');
} finally { await runtime.dispose(); }
