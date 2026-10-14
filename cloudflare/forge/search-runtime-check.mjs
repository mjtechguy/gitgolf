// Semantic search on real workerd, D1, the workspace Durable Object and the scheduled handler; no provider calls.
// Run: node cloudflare/forge/search-runtime-check.mjs "$(command -v cf)". Workers AI, Vectorize and Artifacts are local stubs:
// the embedding is a word-hash vector and the vector store is a D1 table, so no inference or Vectorize behaviour is claimed.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import * as esbuild from '../agents/node_modules/esbuild/lib/main.js';
import { digest } from './src/common.mjs';
const cli = dirname(dirname(realpathSync(process.argv[2])));
if (JSON.parse(await readFile(resolve(cli, 'package.json'), 'utf8')).version !== '1.0.0-beta.13') throw Error('Qualify native CLI');
const { Miniflare, convertV4MiniflareOptions } = await import(pathToFileURL(resolve(cli, 'node_modules/miniflare/dist/src/index.js')).href);
// The production Worker; the workspace and the scheduled handler receive the stub bindings. State lives in D1 so both share it.
const built = await esbuild.build({ stdin: { resolveDir: resolve('cloudflare/forge'), sourcefile: 'search-runtime-fixture.mjs', contents: `
import production, { Workspace as ProductionWorkspace } from './src/worker.mjs';
export { RepositoryReads } from './src/worker.mjs';
const hex = async value => [...new Uint8Array(await crypto.subtle.digest('SHA-1', new TextEncoder().encode(value)))].map(b => b.toString(16).padStart(2, '0')).join('');
const files = { 'src/cache.mjs': 'export class Cache {\\n  // Eviction removes the least recently read entry.\\n  evict() { return this.entries.shift(); }\\n}\\n', 'README.md': '# Project\\n\\nRun the deploy command to publish.\\n' };
async function objects() {
  const blobs = {}, entries = [];
  for (const [path, text] of Object.entries(files)) { const hash = await hex('blob' + text); blobs[hash] = new TextEncoder().encode(text); entries.push({ path, hash }); }
  const src = await hex('tree src'), root = await hex('tree root'), commit = await hex('commit');
  const trees = { [src]: [{ name: 'cache.mjs', type: 'blob', mode: '100644', hash: entries[0].hash }], [root]: [{ name: 'README.md', type: 'blob', mode: '100644', hash: entries[1].hash }, { name: 'src', type: 'tree', mode: '40000', hash: src }] };
  return { blobs, trees, commit: { hash: commit, treeHash: root, parents: [], message: 'c', author: { name: 'A' }, authoredAt: 1700000000 } };
}
const vector = text => { const v = new Array(32).fill(0); for (const w of text.toLowerCase().match(/[a-z]{3,}/g) || []) { let h = 0; for (const c of w) h = (h * 31 + c.charCodeAt(0)) >>> 0; v[h % 32] += 1; } const n = Math.hypot(...v) || 1; return v.map(x => x / n); };
function stubs(env) {
  const db = env.DB;
  return { ...env,
    AI: { async run(model, input, options) {
      if (options?.gateway?.id !== 'local-gateway' || options.gateway.collectLog !== false) throw Error('Gateway options missing');
      await db.prepare('INSERT INTO stub_calls(model,kind) VALUES(?,?)').bind(model, input.queries ? 'query' : 'documents').run();
      const texts = input.documents || input.queries; return { shape: [texts.length, 32], data: texts.map(vector) }; } },
    SEARCH_INDEX: {
      async upsert(list) { for (const item of list) await db.prepare('INSERT INTO stub_vectors(id,body) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body').bind(item.id, JSON.stringify(item)).run(); return { mutationId: 'm' }; },
      async deleteByIds(ids) { for (const id of ids) await db.prepare('DELETE FROM stub_vectors WHERE id=?').bind(id).run(); return { mutationId: 'd' }; },
      async getByIds(ids) { const out = []; for (const id of ids) { const row = await db.prepare('SELECT body FROM stub_vectors WHERE id=?').bind(id).first(); if (row) out.push(JSON.parse(row.body)); } return out; },
      async query(q, options) { const { results } = await db.prepare('SELECT body FROM stub_vectors').all(); return { matches: results.map(r => JSON.parse(r.body)).filter(v => v.metadata.repository === options.filter.repository)
        .map(v => ({ id: v.id, score: v.values.reduce((s, x, i) => s + x * q[i], 0) })).sort((a, b) => b.score - a.score).slice(0, options.topK) }; } },
    ARTIFACTS: { async get(name) { const o = await objects(); return {
      async info() { return { name, remote: 'https://' + env.ACCOUNT_ID + '.artifacts.cloudflare.net/git/' + env.ARTIFACTS_NAMESPACE + '/' + name + '.git' }; },
      async log() { return [o.commit]; }, async readCommit(hash) { return hash === o.commit.hash ? o.commit : null; }, async readTree(hash) { return o.trees[hash] || null; },
      async readBlob(hash) { const b = o.blobs[hash]; return b ? { size: b.length, arrayBuffer: async () => b.buffer } : null; }, [Symbol.dispose]() {} }; } } };
}
export class Workspace extends ProductionWorkspace { constructor(ctx, env) { super(ctx, stubs(env)); } }
export default { ...production, scheduled(event, env, ctx) { return production.scheduled(event, stubs(env), ctx); } };
` }, bundle: true, write: false, format: 'esm', platform: 'neutral',
  define: { GOLF_NATIVE_ASSETS: 'null', GOLF_NATIVE_RELEASE: '"local"', GOLF_NATIVE_CONFIGURATION: '"local"' }, nodePaths: ['cloudflare/agents/node_modules'],
  conditions: ['workerd', 'worker', 'browser'], external: ['cloudflare:workers', 'node:*'] });
const origin = 'https://golf.example.com', tokens = ['a', 'b'].map(c => 'golf_native_' + c.repeat(43));
const runtime = new Miniflare(convertV4MiniflareOptions({
  host: '127.0.0.1', port: 0, modules: [{ type: 'ESModule', path: 'worker.mjs', contents: built.outputFiles[0].text }], compatibilityDate: '2026-10-08', compatibilityFlags: ['nodejs_compat'],
  bindings: { PUBLIC_ORIGIN: origin, WORKSPACE_SLUG: 'alice', ARTIFACTS_NAMESPACE: 'local-search-proof', ACCOUNT_ID: 'a'.repeat(32),
    EVIDENCE_ALLOW_AI: 'true', EVIDENCE_GATEWAY: 'local-gateway', SEARCH_DIMENSIONS: '32' },
  d1Databases: { DB: 'local-search-proof' }, durableObjects: { WORKSPACE: { className: 'Workspace', useSQLite: true }, READS: { className: 'RepositoryReads', useSQLite: true } },
}));
try {
  const db = await runtime.getD1Database('DB');
  for (const sql of (await readFile(new URL('./schema.sql', import.meta.url), 'utf8')).replace(/--[^\n]*/g, '').split(/;\s*(?=CREATE\b)/).filter(s => s.trim())) await db.prepare(sql).run();
  await db.prepare('CREATE TABLE stub_vectors(id TEXT PRIMARY KEY, body TEXT NOT NULL)').run();
  await db.prepare('CREATE TABLE stub_calls(model TEXT, kind TEXT)').run();
  await db.prepare("INSERT INTO users(id,login,can_create) VALUES(1,'alice',1),(2,'bob',0)").run();
  await db.prepare("INSERT INTO workspaces(slug,artifact_namespace) VALUES('alice','local-search-proof')").run();
  for (const [i, token] of tokens.entries()) await db.prepare('INSERT INTO credentials VALUES(?,?,?,0)').bind(await digest(token), i + 1, Math.floor(Date.now() / 1000) + 300).run();
  await db.prepare("INSERT INTO repositories(id,name,description,artifact_name,creator_id,creation_key,input_hash,state,created_at) VALUES(1,'project','',?,1,'key','hash','ACTIVE','2026-10-14T00:00:00Z')").bind('repo-' + 'e'.repeat(32)).run();
  await db.prepare("INSERT INTO grants VALUES(1,1,'admin'),(1,2,'read')").run();
  await db.prepare("INSERT INTO discussions(id,repository_id,number,kind,author_id,title,body,state,created_at,updated_at) VALUES(1,1,1,'issue',2,'Cache eviction drops warm entries','Eviction removes entries read a moment ago.','OPEN','t','t')").run();
  const call = async (path, body, who = 1) => {
    const response = await runtime.dispatchFetch(origin + path, { method: 'POST', headers: { Authorization: 'Bearer ' + tokens[who], 'Content-Type': 'application/json', 'Connect-Protocol-Version': '1' },
      body: JSON.stringify({ repository: { owner: 'alice', name: 'project' }, repositoryId: '1', ...body }) });
    return { status: response.status, value: await response.json() };
  };
  assert.equal((await call('/native/diagnostics', {})).value.schema, 40);
  const capability = async () => (await call('/rpc/golf.v1.CapabilityService/ListCapabilities', {})).value.capabilities.find(item => item.id === 'repository.semantic-search');
  assert.equal((await capability()).state, 'CAPABILITY_STATE_DEGRADED');
  assert.equal((await call('/native/search', { action: 'index' }, 1)).status, 403);
  const queued = await call('/native/search', { action: 'index' }, 0);
  assert.equal(queued.status, 200, JSON.stringify(queued.value)); assert.equal(queued.value.index.state, 'PENDING');
  // The scheduled handler builds the index outside the workspace queue, then a second run reads a vector back.
  for (let i = 0; i < 2; i++) assert.equal((await (await runtime.getWorker()).scheduled({ cron: '*/5 * * * *', scheduledTime: Date.now() })).outcome, 'ok');
  assert.equal((await db.prepare("SELECT outcome FROM operations_maintenance WHERE stage='indexes'").first()).outcome, 'succeeded');
  const status = await call('/native/search/read', { action: 'status' });
  assert.equal(status.value.index.state, 'READY', JSON.stringify(status.value)); assert.equal(status.value.index.verified, true); assert.equal(status.value.index.chunks, 3);
  assert.equal((await capability()).state, 'CAPABILITY_STATE_READY');
  const stored = (await db.prepare('SELECT body FROM stub_vectors').all()).results.map(row => JSON.parse(row.body));
  for (const vector of stored) assert.deepEqual(Object.keys(vector.metadata).sort(), ['kind', 'repository']);
  assert.ok(!JSON.stringify(stored).includes('Eviction'));
  const found = await call('/native/search/read', { action: 'query', query: 'cache eviction removes entries' });
  assert.equal(found.status, 200, JSON.stringify(found.value));
  assert.deepEqual(found.value.results.map(result => result.path || '#' + result.number).sort(), ['#1', 'README.md', 'src/cache.mjs']);
  assert.equal(found.value.results.find(result => result.path === 'src/cache.mjs').excerpt.lines[1], '  // Eviction removes the least recently read entry.');
  assert.deepEqual((await db.prepare('SELECT kind,count(*) AS n FROM stub_calls GROUP BY kind ORDER BY kind').all()).results, [{ kind: 'documents', n: 1 }, { kind: 'query', n: 1 }]);
  await db.prepare('DELETE FROM grants WHERE user_id=2').run();
  assert.equal((await call('/native/search/read', { action: 'query', query: 'cache eviction' })).status, 404);
  console.log('Real workerd/D1/DO semantic search: admin build request, scheduled indexing through stub Workers AI and a D1-backed stub vector store, readback, live excerpts and revocation passed');
} finally { await runtime.dispose(); }
