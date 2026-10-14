import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { embeddedAssets } from './release.mjs';

test('release retention parses only bounded embedded static manifests without executing bundle code', () => {
  const bundle = 'var define_GOLF_NATIVE_ASSETS_default = { "/native.html": { type: "text/html", content: "aGk=" }, "/assets/old-abcd1234.js": { type: "text/javascript", content: "aGk=" } };';
  assert.equal(embeddedAssets(bundle)['/assets/old-abcd1234.js'].content, 'aGk=');
  for (const invalid of [bundle.replace('old-abcd1234.js', '../private-abcd1234.js'), bundle.replace('"aGk="', 'process.exit()'), bundle.replace('"aGk="', '"not base64!"'), 'no manifest']) assert.throws(() => embeddedAssets(invalid));
});

test('the release migration ends schema.sql after every earlier migration; schema 24 bounds merge operations', async t => {
  const migrations = (await readdir(new URL('./migrations/', import.meta.url))).filter(name => /^\d{4}_.+\.sql$/.test(name)).sort();
  assert.equal(migrations.at(-1), '0043_intent_summaries.sql');
  const latest = (await Promise.all(migrations.filter(name => name >= '0025').map(name => readFile(new URL('./migrations/' + name, import.meta.url), 'utf8')))).join('\n');
  const migration = await readFile(new URL('./migrations/0024_pull_merges.sql', import.meta.url), 'utf8'), schema = await readFile(new URL('./schema.sql', import.meta.url), 'utf8');
  assert.match(await readFile(new URL('./release.mjs', import.meta.url), 'utf8'), /contract: 1, schema: 43, /);
  // Tail migrations are appended after one blank line; the Alchemy migrate step peels exactly that.
  assert.ok(schema.endsWith(';\n\n' + migration + '\n' + latest));
  const sql = new DatabaseSync(':memory:'); t.after(() => sql.close());
  // The migration applies to its reviewed predecessor and is safe to replay after a lost response.
  sql.exec(schema.slice(0, -(migration.length + latest.length + 2))); sql.exec(migration); sql.exec(migration); sql.exec(latest); sql.exec(latest);
  sql.exec(`INSERT INTO users(id,login) VALUES(1,'alice'),(2,'bob');
    INSERT INTO repositories(id,name,description,artifact_name,creator_id,creation_key,input_hash,state,created_at) VALUES(1,'project','','repo-1',1,'key','hash','ACTIVE','2026-10-14T00:00:00Z');
    INSERT INTO discussions(id,repository_id,number,kind,author_id,title,body,state,created_at,updated_at) VALUES(1,1,1,'pull',1,'One','','OPEN','t','t'),(2,1,2,'pull',1,'Two','','OPEN','t','t');
    INSERT INTO pull_requests(id,discussion_id,base_branch,head_branch,base_commit,head_commit,draft) VALUES(1,1,'main','one','a','b',0),(2,2,'main','two','a','c',0)`);
  const add = sql.prepare("INSERT INTO pull_merge_operations(actor_id,operation_id,repository_id,pull_request_id,input_hash,original,phase,created_at,updated_at) VALUES(?,?,1,?,'hash','{}',?,'t','t')");
  add.run(1, 'first', 1, 'DISPATCH_UNKNOWN');
  // One journal row per (account, operation ID); the same ID belongs to another account independently.
  assert.throws(() => add.run(1, 'first', 2, 'REJECTED'), /UNIQUE/); add.run(2, 'first', 2, 'REJECTED');
  // At most one unresolved operation per pull request, in either unresolved phase and for any account.
  for (const phase of ['RESERVED', 'DISPATCH_UNKNOWN']) for (const actor of [1, 2]) assert.throws(() => add.run(actor, 'second-' + phase, 1, phase), /UNIQUE/);
  add.run(1, 'other-pull', 2, 'RESERVED');
  for (let i = 0; i < 3; i++) add.run(1, 'refused-' + i, 1, 'REJECTED');
  // Settling frees the unresolved slot; a pull request is merged at most once.
  sql.exec("UPDATE pull_merge_operations SET phase='SUCCEEDED' WHERE operation_id='first' AND actor_id=1");
  add.run(1, 'later', 1, 'DISPATCH_UNKNOWN');
  assert.throws(() => sql.exec("UPDATE pull_merge_operations SET phase='SUCCEEDED' WHERE operation_id='later'"), /UNIQUE/);
  assert.throws(() => add.run(1, 'invalid', 2, 'APPLIED'), /CHECK/);
});
