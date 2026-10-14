import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { digest, handle, advanceSearch, concurrentRead } from './src/core.mjs';
import { chunkRanges, excerpt, sourceLines, searchModels } from './src/search.mjs';
import { indexablePath } from './src/search-index.mjs';

const tokens = { alice: 'golf_native_' + 'a'.repeat(43), bob: 'golf_native_' + 'b'.repeat(43), carol: 'golf_native_' + 'c'.repeat(43) };
const origin = 'https://golf.example.com', artifact = 'repo-' + 'd'.repeat(32), DIMENSIONS = 32;
const sha = value => createHash('sha1').update(value).digest('hex');

// Bag-of-words vectors: deterministic, and close for texts that share words.
function embedding(text, width = DIMENSIONS) {
  const vector = new Array(width).fill(0);
  for (const word of text.toLowerCase().match(/[a-z]{3,}/g) || []) vector[parseInt(createHash('sha256').update(word).digest('hex').slice(0, 8), 16) % width] += 1;
  const norm = Math.hypot(...vector) || 1;
  return vector.map(value => value / norm);
}

// An in-memory Git object store shaped like the Artifacts binding: commits, trees and blobs addressed by SHA-1.
function repository() {
  const objects = new Map(), refs = { main: '' };
  const blob = text => { const bytes = typeof text === 'string' ? new TextEncoder().encode(text) : text, hash = sha('blob' + Buffer.from(bytes).toString('base64')); objects.set(hash, { blob: bytes }); return hash; };
  const tree = files => {
    const children = new Map();
    for (const [path, content] of Object.entries(files)) {
      const [head, ...rest] = path.split('/');
      if (rest.length) { if (!children.has(head)) children.set(head, {}); children.get(head)[rest.join('/')] = content; }
      else children.set(head, content);
    }
    const entries = [...children].map(([name, value]) => typeof value === 'object' && !(value instanceof Uint8Array) ? { name, type: 'tree', mode: '40000', hash: tree(value) } : { name, type: 'blob', mode: '100644', hash: blob(value) });
    const hash = sha('tree' + JSON.stringify(entries)); objects.set(hash, { tree: entries }); return hash;
  };
  const commit = files => { const hash = sha('commit' + Math.random()); objects.set(hash, { commit: { hash, treeHash: tree(files), parents: [], message: 'c', author: { name: 'A' }, authoredAt: 1700000000 } }); refs.main = hash; return hash; };
  const reads = { blobs: 0 };
  const handle = env => ({
    async info() { return { name: artifact, remote: `https://${env.ACCOUNT_ID}.artifacts.cloudflare.net/git/${env.ARTIFACTS_NAMESPACE}/${artifact}.git` }; },
    async log({ ref }) { return refs[ref] ? [objects.get(refs[ref]).commit] : []; },
    async readCommit(hash) { return objects.get(hash)?.commit || null; },
    async readTree(hash) { return objects.get(hash)?.tree || null; },
    async readBlob(hash) { reads.blobs++; const bytes = objects.get(hash)?.blob; return bytes ? { size: bytes.length, arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length) } : null; },
    [Symbol.dispose]() {},
  });
  return { commit, refs, handle, reads };
}

// Vectorize with delayed visibility: upserts and deletes apply only when flushed, like the asynchronous mutation queue.
function vectorIndex() {
  const index = { stored: new Map(), queued: [], upserts: [], deletes: [], queries: [], onQuery: null,
    async upsert(vectors) { index.upserts.push(vectors); index.queued.push(() => { for (const vector of vectors) index.stored.set(vector.id, vector); }); return { mutationId: 'm' + index.upserts.length }; },
    async deleteByIds(ids) { index.deletes.push(ids); index.queued.push(() => { for (const id of ids) index.stored.delete(id); }); return { mutationId: 'd' }; },
    async getByIds(ids) { return ids.filter(id => index.stored.has(id)).map(id => index.stored.get(id)); },
    async query(vector, options) {
      index.queries.push(options); await index.onQuery?.();
      const matches = [...index.stored.values()].filter(item => item.metadata.repository === options.filter.repository)
        .map(item => ({ id: item.id, score: item.values.reduce((sum, value, i) => sum + value * vector[i], 0) })).sort((a, b) => b.score - a.score).slice(0, options.topK);
      return { matches, count: matches.length };
    },
    flush() { for (const apply of index.queued.splice(0)) apply(); },
  };
  return index;
}

async function fixture(t, { width = DIMENSIONS } = {}) {
  const sql = new DatabaseSync(':memory:'); t.after(() => sql.close());
  sql.exec(await readFile(new URL('./schema.sql', import.meta.url), 'utf8'));
  sql.exec("INSERT INTO users(id,login) VALUES(1,'alice'),(2,'bob'),(3,'carol'); INSERT INTO workspaces(slug,artifact_namespace) VALUES('alice','search-space')");
  sql.prepare("INSERT INTO repositories(id,name,description,artifact_name,creator_id,creation_key,input_hash,state,created_at) VALUES(1,'project','',?,1,'key','hash','ACTIVE','2026-10-14T00:00:00Z')").run(artifact);
  sql.exec("INSERT INTO grants VALUES(1,1,'admin'),(1,2,'read')");
  for (const [login, token] of Object.entries(tokens)) sql.prepare('INSERT INTO credentials SELECT ?,id,?,0 FROM users WHERE login=?').run(await digest(token), Math.floor(Date.now() / 1000) + 300, login);
  sql.exec(`INSERT INTO discussions(id,repository_id,number,kind,author_id,title,body,state,created_at,updated_at) VALUES
    (1,1,1,'issue',2,'Cache eviction drops warm entries','The cache eviction policy removes entries that were read a moment ago.','OPEN','t','t'),
    (2,1,2,'pull',1,'Document the deploy command','Adds a deploy section to the readme.','OPEN','t','t')`);
  const statement = (query, values = []) => sql.prepare(query);
  const db = { withSession() { return this; }, prepare(query) { let values = []; const prepared = statement(query); return {
    bind(...args) { assert.ok(args.every(value => value !== undefined), 'D1 refuses undefined bindings'); assert.ok(args.length <= 100, 'D1 binds at most 100 values'); values = args; return this; },
    async first() { return prepared.get(...values) || null; }, async all() { return { results: prepared.all(...values) }; },
    async run() { return { meta: { changes: prepared.run(...values).changes } }; } }; },
    async batch(statements) { sql.exec('BEGIN'); try { const results = []; for (const item of statements) results.push(await item.run()); sql.exec('COMMIT'); return results; } catch (error) { sql.exec('ROLLBACK'); throw error; } } };
  const git = repository(), index = vectorIndex(), calls = [];
  const env = { DB: db, ACCOUNT_ID: 'c'.repeat(32), ARTIFACTS_NAMESPACE: 'search-space', WORKSPACE_SLUG: 'alice', PUBLIC_ORIGIN: origin,
    EVIDENCE_ALLOW_AI: 'true', EVIDENCE_GATEWAY: 'golf-gateway', SEARCH_DIMENSIONS: String(DIMENSIONS), SEARCH_INDEX: index,
    AI: { width, async run(model, input, options) { calls.push({ model, input, options }); const texts = input.documents || input.queries || input.text;
      return { shape: [texts.length, this.width], data: texts.map(text => embedding(text, this.width)) }; } },
    ARTIFACTS: { async get(name) { assert.equal(name, artifact); return git.handle(env); } } };
  const call = async (path, body, who = 'bob') => {
    const response = await handle(new Request(origin + path, { method: 'POST', headers: { Authorization: 'Bearer ' + tokens[who], 'Content-Type': 'application/json', 'Connect-Protocol-Version': '1' },
      body: JSON.stringify({ repository: { owner: 'alice', name: 'project' }, repositoryId: '1', ...body }) }), env);
    return { status: response.status, value: await response.json() };
  };
  const search = (query, who = 'bob') => call('/native/search/read', { action: 'query', query }, who);
  const status = (who = 'bob') => call('/native/search/read', { action: 'status' }, who);
  const capability = async () => (await call('/rpc/golf.v1.CapabilityService/ListCapabilities', {})).value.capabilities.find(item => item.id === 'repository.semantic-search');
  const state = () => sql.prepare('SELECT * FROM search_state WHERE repository_id=1').get();
  return { sql, env, git, index, calls, call, search, status, capability, state, maintain: () => advanceSearch(env) };
}

const sources = {
  'src/cache.mjs': 'export class Cache {\n  // Eviction removes the least recently read entry.\n  evict() { return this.entries.shift(); }\n}\n',
  'README.md': '# Project\n\nRun the deploy command to publish.\n',
  'node_modules/dep/index.js': 'cache eviction in a dependency',
  'package-lock.json': '{"cache": "eviction"}',
  'logo.png': 'not really an image but named like one',
  'big.txt': 'cache eviction '.repeat(5000),
  'binary.dat': new Uint8Array([0, 1, 2, 0]),
};

test('search helpers chunk, skip and excerpt within their bounds', () => {
  assert.deepEqual(chunkRanges(130), [[1, 60], [51, 110], [101, 130]]);
  assert.deepEqual(chunkRanges(10), [[1, 10]]);
  assert.equal(chunkRanges(100000).length, 32);
  for (const path of ['node_modules/a.js', 'vendor/x.go', 'package-lock.json', 'Cargo.lock', 'app.min.js', 'logo.png', 'dist/app.js']) assert.equal(indexablePath(path), false, path);
  for (const path of ['src/index.ts', 'README.md', 'docs/build-notes.md', 'distance.py']) assert.equal(indexablePath(path), true, path);
  assert.equal(sourceLines(new Uint8Array(70 * 1024)), null);
  assert.equal(sourceLines(new Uint8Array([0xff, 0xfe])), null);
  assert.equal(sourceLines(new TextEncoder().encode('a\0b')), null);
  assert.equal(sourceLines(new TextEncoder().encode('x'.repeat(5000))), null, 'one long minified line');
  const lines = Array.from({ length: 60 }, (_, i) => i === 40 ? 'the cache evicts here' : 'line ' + i);
  const shown = excerpt(lines, 1, 60, ['cache']);
  assert.equal(shown.lines.length, 12); assert.ok(shown.lines.includes('the cache evicts here')); assert.ok(shown.startLine <= 41 && shown.startLine + 11 >= 41);
});

test('an administrator builds an index; readers search it by meaning and every excerpt is read live after the access check', async t => {
  const f = await fixture(t);
  assert.equal(concurrentRead(new Request(origin + '/native/search/read', { method: 'POST' })), true);
  assert.equal(concurrentRead(new Request(origin + '/native/search', { method: 'POST' })), false);
  f.git.commit(sources);
  // Without the Vectorize binding the capability is disabled and nothing can start.
  const index = f.env.SEARCH_INDEX; delete f.env.SEARCH_INDEX;
  assert.equal((await f.capability()).state, 'CAPABILITY_STATE_DISABLED');
  assert.equal((await f.call('/native/search', { action: 'index' }, 'alice')).status, 412);
  f.env.SEARCH_INDEX = index;
  assert.equal((await f.capability()).state, 'CAPABILITY_STATE_DEGRADED');
  const before = await f.status();
  assert.equal(before.status, 200); assert.equal(before.value.index, null); assert.equal(before.value.canManage, false);
  assert.equal(before.value.notice, 'Semantic matches by meaning; exact text search is not available.');
  // Not indexed: a search makes no model call and says so.
  assert.deepEqual((await f.search('cache eviction')).value.results, []); assert.equal(f.calls.length, 0);
  assert.equal((await f.call('/native/search', { action: 'index' })).status, 403);
  assert.equal((await f.call('/native/search/read', { action: 'index' }, 'alice')).status, 400);
  assert.equal((await f.call('/native/search', { action: 'index' }, 'carol')).status, 404);
  const queued = await f.call('/native/search', { action: 'index' }, 'alice');
  assert.equal(queued.status, 200); assert.equal(queued.value.index.state, 'PENDING'); assert.equal(queued.value.canManage, true);
  assert.equal(f.calls.length, 0, 'the request only queues the build');

  assert.deepEqual(await f.maintain(), { processed: 6 }, 'four embedded and two skipped');
  assert.equal(f.state().state, 'READY'); assert.equal(f.state().commit_id, f.git.refs.main);
  // Only the source file, the readme and the two discussions were embedded, in one call through the private gateway.
  assert.equal(f.calls.length, 1);
  assert.deepEqual(f.calls[0].options, { gateway: { id: 'golf-gateway', skipCache: true, collectLog: false } });
  assert.equal(f.calls[0].model, '@cf/qwen/qwen3-embedding-0.6b');
  assert.equal(f.calls[0].input.documents.length, 4);
  assert.equal(f.state().files, 4, 'indexable files include the skipped big and binary ones'); assert.equal(f.state().skipped, 2); assert.equal(f.state().chunks, 4);
  // Vectorize receives ids, vectors and { repository, kind } only: no path, no text.
  const upserted = f.index.upserts.flat();
  for (const vector of upserted) { assert.deepEqual(Object.keys(vector).sort(), ['id', 'metadata', 'values']); assert.deepEqual(Object.keys(vector.metadata).sort(), ['kind', 'repository']); assert.equal(vector.metadata.repository, '1'); }
  assert.ok(!JSON.stringify(upserted).includes('Eviction')); assert.ok(!JSON.stringify(upserted).includes('cache.mjs'));
  assert.deepEqual(upserted.map(vector => vector.metadata.kind).sort(), ['code', 'code', 'issue', 'pull']);

  // Writes are not visible yet: the index is served but not verified, so the capability stays degraded.
  assert.equal((await f.status()).value.index.verified, false);
  await f.maintain();
  assert.equal(f.calls.length, 1, 'an unchanged index makes no model call');
  assert.equal((await f.capability()).state, 'CAPABILITY_STATE_DEGRADED');
  f.index.flush();
  await f.maintain();
  assert.equal((await f.status()).value.index.verified, true);
  assert.equal((await f.capability()).state, 'CAPABILITY_STATE_READY');

  const found = await f.search('cache eviction removes entries');
  assert.equal(found.status, 200, JSON.stringify(found.value));
  assert.equal(f.calls.at(-1).input.queries[0], 'cache eviction removes entries'); assert.match(f.calls.at(-1).input.instruction, /software repository/);
  assert.deepEqual(f.index.queries.at(-1), { topK: 50, filter: { repository: '1' }, returnMetadata: 'none', returnValues: false });
  assert.equal(found.value.index.commitId, f.git.refs.main);
  const [code] = found.value.results.filter(result => result.kind === 'code' && result.path === 'src/cache.mjs');
  assert.deepEqual(code.excerpt.lines.slice(0, 2), ['export class Cache {', '  // Eviction removes the least recently read entry.']);
  assert.equal(code.startLine, 1);
  const [issue] = found.value.results.filter(result => result.kind === 'issue');
  assert.equal(issue.number, 1); assert.equal(issue.title, 'Cache eviction drops warm entries'); assert.equal(found.value.filtered, 0);
  assert.equal(found.value.results.length, 4);
  // A search shorter than two characters is refused before any call.
  assert.equal((await f.search('a')).status, 400);
});

test('revocations, removed grants and edits take effect on the next search', async t => {
  const f = await fixture(t);
  f.git.commit(sources);
  await f.call('/native/search', { action: 'index' }, 'alice'); await f.maintain(); f.index.flush();
  assert.equal((await f.search('cache eviction')).value.results.length, 4);
  // An edited issue is filtered until it is embedded again; its stored text is never shown.
  f.sql.exec("UPDATE discussions SET body='Unrelated now: the logo colour.' WHERE id=1");
  assert.equal(f.sql.prepare("SELECT count(*) AS n FROM search_outbox WHERE kind='discussion'").get().n, 1);
  const edited = await f.search('cache eviction');
  assert.equal(edited.value.results.some(result => result.kind === 'issue'), false); assert.equal(edited.value.filtered, 1);
  await f.maintain(); f.index.flush();
  const reindexed = await f.search('logo colour');
  assert.deepEqual(reindexed.value.results.find(result => result.kind === 'issue').excerpt.lines, ['Cache eviction drops warm entries', '', 'Unrelated now: the logo colour.']);
  assert.equal(f.index.deletes.flat().length, 1, 'the old issue vector is deleted');
  // A new issue is queued by the trigger and appears after the next maintenance run.
  f.sql.exec("INSERT INTO discussions(id,repository_id,number,kind,author_id,title,body,state,created_at,updated_at) VALUES(3,1,3,'issue',2,'Flaky deploy','Deploy fails on retry.','OPEN','t','t')");
  await f.maintain(); f.index.flush();
  assert.ok((await f.search('flaky deploy retry')).value.results.some(result => result.number === 3));
  // A grant removed while the excerpts are read returns nothing.
  f.index.onQuery = () => { f.sql.exec('DELETE FROM grants WHERE user_id=2'); };
  assert.equal((await f.search('cache eviction')).status, 404);
  f.index.onQuery = null;
  // Revoked: refused at the access check, before any model call.
  const before = f.calls.length;
  assert.equal((await f.search('cache eviction')).status, 404);
  assert.equal(f.calls.length, before);
  // Issues turned off for the repository: issue results are hidden and counted.
  f.sql.exec("INSERT INTO grants VALUES(1,2,'read')");
  f.sql.prepare("INSERT INTO repository_features(repository_id,artifact_name,feature,enabled,version,updated_by,updated_at) VALUES(1,?,'issues',0,1,1,'t')").run(artifact);
  const hidden = await f.search('cache eviction');
  assert.equal(hidden.value.results.some(result => result.kind === 'issue'), false); assert.ok(hidden.value.filtered >= 1);
});

test('a model that answers with another dimension is refused before anything is stored', async t => {
  const f = await fixture(t, { width: 64 });
  f.git.commit(sources);
  await f.call('/native/search', { action: 'index' }, 'alice');
  await f.maintain();
  assert.equal(f.state().state, 'FAILED');
  assert.match(f.state().error, /returns 64-dimension vectors but this installation's Vectorize index has 32\. Re-create the index with enable-search --dimensions 64/);
  assert.equal(f.index.upserts.length, 0);
  assert.match((await f.capability()).reason, /Last failure: .*64-dimension/);
  assert.equal((await f.capability()).state, 'CAPABILITY_STATE_DEGRADED');
  // It waits for an administrator or a new configuration instead of calling again every run.
  const calls = f.calls.length;
  await f.maintain(); assert.equal(f.calls.length, calls);
  f.env.AI.width = 32;
  assert.equal((await f.call('/native/search', { action: 'index' }, 'alice')).value.index.state, 'PENDING');
  await f.maintain();
  assert.equal(f.state().state, 'READY'); assert.equal(f.state().error, null);
});

test('indexing is paced, incremental after a push, rebuilt for a new model and refused when the feature is off', async t => {
  const f = await fixture(t);
  const many = Object.fromEntries(Array.from({ length: 400 }, (_, i) => [`src/file${String(i).padStart(3, '0')}.js`, `export const value${i} = 'module number ${i}';\n`]));
  f.git.commit(many);
  await f.call('/native/search', { action: 'index' }, 'alice');
  await f.maintain();
  // 402 chunks need 13 calls of 32; one maintenance run makes at most 10.
  assert.equal(f.calls.length, 10); assert.equal(f.state().state, 'INDEXING');
  const progress = (await f.status()).value.index;
  assert.ok(progress.progress > 70 && progress.progress < 100, JSON.stringify(progress)); assert.equal(progress.served, false);
  await f.maintain();
  assert.equal(f.calls.length, 13); assert.equal(f.state().state, 'READY'); assert.equal(f.state().chunks, 402);
  f.index.flush(); await f.maintain();
  // A push that changes one file embeds only that file; its previous vector is deleted when the build completes.
  const old = f.state().commit_id;
  f.git.commit({ ...many, 'src/file007.js': 'export const value7 = "changed";\n' });
  await f.maintain();
  assert.equal(f.calls.length, 14); assert.equal(f.calls.at(-1).input.documents.length, 1);
  assert.equal(f.state().state, 'READY'); assert.notEqual(f.state().commit_id, old);
  assert.equal(f.index.deletes.flat().length, 1); assert.equal(f.state().chunks, 402);
  // A different model rebuilds; the old index keeps serving with the old model until the new one completes.
  f.index.flush();
  f.env.SEARCH_MODEL = '@cf/baai/bge-m3';
  await f.maintain();
  assert.equal(f.state().state, 'INDEXING'); assert.equal(f.state().target_model, '@cf/baai/bge-m3'); assert.equal(f.calls.at(-1).model, '@cf/baai/bge-m3'); assert.ok(f.calls.at(-1).input.text);
  const during = await f.search('module number seven');
  assert.equal(during.status, 200); assert.equal(f.calls.at(-1).model, '@cf/qwen/qwen3-embedding-0.6b');
  assert.ok(during.value.results.length > 0);
  await f.maintain();
  assert.equal(f.state().state, 'READY'); assert.equal(f.state().model, '@cf/baai/bge-m3');
  // The daily indexing allowance stops calls and says when they continue.
  f.git.commit({ ...many, 'src/file008.js': 'changed again' });
  f.sql.prepare('INSERT INTO search_usage VALUES(?,0,1000) ON CONFLICT(day,user_id) DO UPDATE SET calls=1000').run(new Date().toISOString().slice(0, 10));
  const calls = f.calls.length;
  await f.maintain();
  assert.equal(f.calls.length, calls); assert.match(f.state().error, /daily allowance of 1000 indexing calls/);
  // Off by repository policy: no queries or builds, nothing read or embedded, and the vectors are kept.
  f.sql.prepare("INSERT INTO repository_features(repository_id,artifact_name,feature,enabled,version,updated_by,updated_at) VALUES(1,?,'semantic-search',0,1,1,'t')").run(artifact);
  f.sql.exec('DELETE FROM search_usage');
  assert.equal((await f.search('module')).status, 412);
  assert.equal((await f.call('/native/search', { action: 'index' }, 'alice')).status, 412);
  assert.match((await f.status()).value.reason, /Semantic search is turned off for this repository/);
  await f.maintain(); assert.equal(f.calls.length, calls);
  // Removal works while off: searches stop at once, then maintenance deletes every vector and row.
  f.index.flush();
  const kept = f.index.stored.size;
  assert.ok(kept >= 402);
  assert.equal((await f.call('/native/search', { action: 'remove' }, 'bob')).status, 403);
  assert.equal((await f.call('/native/search', { action: 'remove' }, 'alice')).value.index.state, 'REMOVING');
  for (let i = 0; i < 3; i++) await f.maintain();
  f.index.flush();
  assert.equal(f.index.stored.size, 0);
  assert.equal(f.state(), undefined);
  for (const table of ['search_chunks', 'search_files', 'search_outbox']) assert.equal(f.sql.prepare(`SELECT count(*) AS n FROM ${table}`).get().n, 0, table);
});

test('each reader has a daily search allowance', async t => {
  const f = await fixture(t);
  f.git.commit(sources);
  await f.call('/native/search', { action: 'index' }, 'alice'); await f.maintain();
  f.sql.prepare('INSERT INTO search_usage VALUES(?,2,200)').run(new Date().toISOString().slice(0, 10));
  assert.equal((await f.search('cache')).status, 429);
  assert.equal((await f.search('cache', 'alice')).status, 200);
});

test('the per-repository model comes from model selection; a different stored model rebuilds, and no usable model fails the build', async t => {
  const f = await fixture(t), original = searchModels.resolve;
  t.after(() => { searchModels.resolve = original; });
  f.git.commit(sources);
  await f.call('/native/search', { action: 'index' }, 'alice'); await f.maintain();
  assert.equal(f.state().model, '@cf/qwen/qwen3-embedding-0.6b');
  searchModels.resolve = async (_db, _env, repositoryId) => { assert.equal(repositoryId, 1); return '@cf/baai/bge-m3'; };
  await f.maintain();
  assert.equal(f.state().model, '@cf/baai/bge-m3'); assert.equal(f.calls.at(-1).model, '@cf/baai/bge-m3');
  searchModels.resolve = async () => { throw Error('Search embeddings: no allowed Workers AI model is available.'); };
  assert.equal((await f.call('/native/search', { action: 'index' }, 'alice')).status, 412);
  f.sql.exec("UPDATE search_state SET state='PENDING'");
  await f.maintain();
  assert.equal(f.state().state, 'FAILED'); assert.match(f.state().error, /no allowed Workers AI model/);
});
