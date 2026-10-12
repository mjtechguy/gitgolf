import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFile } from 'node:fs/promises';
import { attributes, language, licenseIdentifiers, rootMetadata, textBlob } from './src/repository-metadata.mjs';
import { initializeMetadataJobs, metadataJob, advanceMetadataJobs } from './src/metadata-jobs.mjs';
import { digest } from './src/common.mjs';

const commitId = 'a'.repeat(40), root = 'b'.repeat(40), folder = 'c'.repeat(40);
const available = 'REPOSITORY_OVERVIEW_SECTION_STATE_AVAILABLE', indexing = 'REPOSITORY_OVERVIEW_SECTION_STATE_INDEXING';
const artifact = 'repo-' + '1'.repeat(32);
const blob = 'd'.repeat(40), license = 'e'.repeat(40), ignored = 'f'.repeat(40);
const mit = await readFile(new URL('./data/LINGUIST_LICENSE', import.meta.url), 'utf8');

test('languages use pinned names, compound extensions, filenames and explicit root attributes', () => {
  assert.equal(language('app/component.tsx'), 'TSX'); assert.equal(language('main.rs'), 'Rust');
  assert.equal(language('Dockerfile'), 'Dockerfile'); assert.equal(language('lib.phtml'), 'HTML+PHP');
  assert.equal(language('vendor/main.go'), undefined); assert.equal(language('out.min.js'), undefined);
  assert.equal(language('README.md'), undefined); assert.equal(language('config.yml'), undefined);
  assert.equal(language('custom.foo', attributes('*.foo linguist-language=TypeScript')), 'TypeScript');
  assert.equal(language('generated/file.go', attributes('generated/** linguist-generated')), undefined);
  assert.equal(language('vendor/file.go', attributes('vendor/** -linguist-vendored')), 'Go');
  assert.throws(() => language('../secret.go')); assert.throws(() => attributes('x'.repeat(65537)));
});
test('binary objects and partial UTF-8 prefixes do not corrupt language byte totals', async () => {
  assert.equal(await textBlob(new Blob(['hello\0world'])), false);
  assert.equal(await textBlob(new Blob([new Uint8Array([0xff, 0x80])])), false);
  assert.equal(await textBlob(new Blob(['a'.repeat(8191) + 'é'])), true);
  assert.equal(await textBlob(new Blob(['plain source\n'])), true);
});
test('licenses detect actual text, preserve unknown license paths, and bound inspection', async () => {
  assert.deepEqual(licenseIdentifiers(mit), ['MIT']);
  assert.deepEqual(licenseIdentifiers('SPDX-License-Identifier: GPL-3.0-only OR MIT'), ['GPL-3.0-only OR MIT']);
  assert.deepEqual(licenseIdentifiers('This project has no license. MIT is a word.'), []);
  const repo = { readCommit: async () => ({ treeHash: root }), readTree: async () => [{ name: 'LICENSE.custom', type: 'blob', hash: license }], readBlob: async () => new Blob(['An unrecognized license']) };
  const value = await rootMetadata(repo, commitId); assert.deepEqual(value.licenseIds, []); assert.deepEqual(value.licensePaths, ['LICENSE.custom']);
  repo.readTree = async () => Array.from({ length: 18 }, (_, i) => ({ name: `LICENSE.${i}`, type: 'blob', hash: license }));
  await assert.rejects(rootMetadata(repo, commitId), /Too many/);
});

async function fixture(t) {
  const local = new DatabaseSync(':memory:'), primary = new DatabaseSync(':memory:');
  t.after(() => { local.close(); primary.close(); });
  primary.exec(await readFile(new URL('./schema.sql', import.meta.url), 'utf8'));
  primary.exec("INSERT INTO users(id,login) VALUES(1,'alice'); INSERT INTO repositories(id,name,description,artifact_name,creator_id,creation_key,input_hash,state,created_at) VALUES(1,'project','','repo-11111111111111111111111111111111',1,'creation','input','ACTIVE','2026-01-01'); INSERT INTO grants VALUES(1,1,'admin')");
  let alarm, reads = 0, lose = false;
  const sql = { exec(query, ...values) { const statement = local.prepare(query); return statement.columns().length ? statement.all(...values) : (statement.run(...values), []); } };
  const ctx = { storage: { sql, setAlarm: async value => { alarm = value; }, transactionSync(action) { local.exec('BEGIN'); try { const result = action(); local.exec('COMMIT'); return result; } catch (error) { local.exec('ROLLBACK'); throw error; } } } };
  initializeMetadataJobs(ctx);
  const db = { withSession(mode) { assert.equal(mode, 'first-primary'); return this; }, prepare(query) { const statement = primary.prepare(query); let values = []; return { bind(...args) { values = args; return this; }, async first() { return statement.get(...values); }, async all() { return { results: statement.all(...values) }; }, async run() { return statement.run(...values); } }; } };
  const env = { DB: db, ACCOUNT_ID: '1'.repeat(32), ARTIFACTS_NAMESPACE: 'fixture', WORKSPACE_SLUG: 'alice' };
  const repo = { info: async () => ({ name: artifact, remote: `https://${env.ACCOUNT_ID}.artifacts.cloudflare.net/git/fixture/${artifact}.git` }),
    readCommit: async () => ({ treeHash: root }),
    readTree: async hash => hash === root ? [{ name: 'LICENSE', type: 'blob', hash: license }, { name: 'src', type: 'tree', hash: folder }, { name: 'vendor', type: 'tree', hash: ignored }, { name: 'link', type: 'symlink', hash: blob }] : hash === folder ? [{ name: 'a.ts', type: 'blob', hash: blob }, { name: 'b.ts', type: 'blob', hash: blob }, { name: 'a.go', type: 'exec', hash: ignored }] : (assert.fail('Vendored tree must not be scanned'), []),
    readBlob: async hash => { reads++; if (lose && hash === blob) { lose = false; throw Error('Temporary outage'); } return new Blob([hash === license ? mit : hash === blob ? 'typescript' : 'golang']); }, [Symbol.dispose]() {} };
  env.ARTIFACTS = { get: async () => repo };
  const row = { id: 1, name: 'project', artifact_name: artifact }, person = { id: 1 };
  return { local, primary, ctx, env, repo, start: () => metadataJob(ctx, env, row, person, repo, commitId), advance: () => advanceMetadataJobs(ctx, env), reads: () => reads, alarm: () => alarm, lose: () => { lose = true; } };
}

test('durable metadata resumes with exact totals and immutable shared-blob sizes', async t => {
  const f = await fixture(t); const pending = await f.start();
  assert.equal(pending.languagesState, indexing); assert.deepEqual(pending.licenseIds, ['MIT']); assert.equal(pending.indexedCommitId, commitId); assert.ok(f.alarm());
  initializeMetadataJobs(f.ctx);
  for (let i = 0; i < 10 && (await f.start()).languagesState === indexing; i++) await f.advance();
  const result = await f.start(); assert.equal(result.languagesState, available);
  assert.deepEqual(result.languages, [{ name: 'Go', byteCount: '6' }, { name: 'TypeScript', byteCount: '20' }]);
  assert.equal(result.indexedFiles, 5); assert.equal(f.local.prepare('SELECT count(*) n FROM metadata_items').get().n, 0);
  assert.ok(f.primary.prepare('SELECT operations FROM repository_index_budget').get().operations > 0);
});
test('lost reads retry without counting bytes twice and revoked readers halt work', async t => {
  const f = await fixture(t); await f.start(); await f.advance(); f.lose();
  for (let i = 0; i < 10 && (await f.start()).languagesState === indexing; i++) await f.advance();
  assert.equal((await f.start()).languages.find(v => v.name === 'TypeScript').byteCount, '20');
  f.local.exec("UPDATE metadata_jobs SET state='RUNNING'"); f.primary.exec('DELETE FROM grants');
  const before = f.reads(); for (let i = 0; i < 3; i++) await f.advance();
  assert.equal(f.reads(), before); assert.equal(f.local.prepare('SELECT state FROM metadata_jobs').get().state, 'FAILED');
});
test('daily allocation and demo deadline stop scanning before provider effects', async t => {
  const f = await fixture(t); await f.start();
  f.primary.exec('UPDATE repository_index_budget SET operations=60000');
  const before = f.reads(); await f.advance(); assert.equal(f.reads(), before);
  f.env.DEMO_STOP_AT = '2020-01-01T00:00:00Z'; await f.advance(); assert.equal(f.reads(), before);
});

test('a classifier rollout cannot resume or publish incompatible partial totals', async t => {
  const f = await fixture(t); await f.start();
  const row = f.local.prepare('SELECT key,result FROM metadata_jobs').get();
  const value = JSON.parse(row.result); value.classifierVersion = 'old-classifier'; value.languages = { Wrong: 999 };
  f.local.prepare('UPDATE metadata_jobs SET result=? WHERE key=?').run(JSON.stringify(value), row.key);
  const before = f.reads(); f.env.ARTIFACTS.get = () => assert.fail('Incompatible job must not open canonical Git');
  assert.deepEqual(await f.advance(), { pending: 0 });
  assert.equal(f.reads(), before); assert.equal(f.local.prepare('SELECT state FROM metadata_jobs').get().state, 'FAILED');
  assert.equal(f.local.prepare('SELECT count(*) n FROM metadata_items').get().n, 0);
  assert.equal(f.primary.prepare('SELECT count(*) n FROM repository_indexes').get().n, 0);
});

for (const reject of [false, true]) test(`foreground reads and replacement jobs survive a pending index batch (${reject ? 'failure' : 'success'})`, async t => {
  const f = await fixture(t); await f.start();
  const original = f.repo.readTree;
  let release, started;
  const entered = new Promise(resolve => { started = resolve; });
  const held = new Promise(resolve => { release = resolve; });
  let first = true;
  f.repo.readTree = async hash => {
    if (first) { first = false; started(); await held; if (reject) throw Error('Old provider read failed'); }
    return original(hash);
  };
  const running = f.advance(); await entered;
  assert.equal((await f.start()).languagesState, indexing);
  f.local.exec("UPDATE metadata_jobs SET expires_at='2020-01-01T00:00:00Z'");
  await f.start();
  const replacement = f.local.prepare('SELECT * FROM metadata_jobs').get();
  release(); await running;
  assert.deepEqual(f.local.prepare('SELECT * FROM metadata_jobs').get(), replacement);
  assert.equal(f.local.prepare('SELECT count(*) n FROM metadata_items').get().n, 1);
});

test('a verified immutable index ends redundant background scanning before Git opens', async t => {
  const f = await fixture(t); await f.start(); f.env.READ_INDEXES = 'true';
  const job = f.local.prepare('SELECT * FROM metadata_jobs').get();
  const payload = JSON.stringify({ indexedCommitId: commitId, indexedFiles: 100, languagesState: available, licensesState: available, languages: [{ name: 'Go', byteCount: '1234' }], licenseIds: ['MIT'], licensePaths: ['LICENSE'] });
  f.primary.prepare('INSERT INTO repository_indexes(key,repository_id,commit_id,input_hash,payload,payload_hash,payload_bytes,created_at,expires_at) VALUES(?,?,?,?,?,?,?,?,?)').run(job.key, 1, commitId, 'input', payload, await digest(payload), Buffer.byteLength(payload), new Date().toISOString(), job.expires_at);
  f.env.ARTIFACTS.get = () => assert.fail('Completed immutable index must stop provider scans');
  assert.deepEqual(await f.advance(), { pending: 0 });
  assert.deepEqual((await f.start()).languages, [{ name: 'Go', byteCount: '1234' }]);
  assert.equal(f.local.prepare('SELECT count(*) n FROM metadata_items').get().n, 0);
});
