import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { reserveRefWrite, refWriteBlocker, finishRefWrite } from './src/ref-writes.mjs';

const zero = '0'.repeat(40), a = 'a'.repeat(40), b = 'b'.repeat(40);
async function fixture(t) {
  const sql = new DatabaseSync(':memory:'); t.after(() => sql.close());
  sql.exec(await readFile(new URL('./schema.sql', import.meta.url), 'utf8'));
  sql.exec(`INSERT INTO users(id,login,email,full_name) VALUES(1,'alice','alice@example.com','Alice');
    INSERT INTO repositories(id,name,description,artifact_name,creator_id,creation_key,input_hash,state,created_at) VALUES(1,'project','','repo-${'c'.repeat(32)}',1,'k','h','ACTIVE','2026-10-17T00:00:00Z');
    INSERT INTO grants VALUES(1,1,'admin');
    INSERT INTO discussions(id,repository_id,number,kind,author_id,title,body,state,created_at,updated_at) VALUES(1,1,1,'pull',1,'Land','','OPEN','t','t');
    INSERT INTO pull_requests(id,discussion_id,base_branch,head_branch,base_commit,head_commit,draft) VALUES(1,1,'main','agent/one','${a}','${b}',0);`);
  const db = {
    prepare(query) { let values = []; const statement = sql.prepare(query); return {
      bind(...args) { assert.ok(args.every(value => value !== undefined), 'D1 refuses undefined bindings'); values = args; return this; },
      async first() { return statement.get(...values) || null; },
      async run() { return { meta: { changes: statement.run(...values).changes } }; },
    }; },
    async batch(statements) {
      sql.exec('BEGIN');
      try { const results = []; for (const statement of statements) results.push(await statement.run()); sql.exec('COMMIT'); return results; }
      catch (error) { sql.exec('ROLLBACK'); throw error; }
    },
  };
  const guard = { sql: 'EXISTS(SELECT 1 FROM grants WHERE repository_id=? AND user_id=?)', values: [1, 1] };
  const reserve = ref => reserveRefWrite(db, { id: crypto.randomUUID(), repositoryId: 1, userId: 1, command: { ref, old: zero, next: a }, guard });
  // A merge of pull request 1 (agent/one into main) holding the repository, as standardPullMerge reserves it.
  const merge = () => sql.exec(`INSERT INTO git_operations(id,repository_id,user_id,ref,old_sha,new_sha,state,created_at) VALUES('merge',1,1,'refs/heads/main','${a}','${b}','DISPATCHED','t');
    UPDATE repositories SET write_pending='merge' WHERE id=1;
    INSERT INTO pull_merge_operations(actor_id,operation_id,repository_id,pull_request_id,input_hash,original,phase,git_operation_id,created_at,updated_at)
      VALUES(1,'op',1,1,'h','{}','DISPATCH_UNKNOWN','merge','t','t');`);
  return { sql, db, reserve, merge };
}

test('a merge holds its base and its head branch; writes to other branches proceed', async t => {
  const f = await fixture(t);
  f.merge();
  assert.equal(await f.reserve('refs/heads/main'), false);
  assert.equal(await refWriteBlocker(f.db, 1, 'refs/heads/main'), 'repository');
  assert.equal(await f.reserve('refs/heads/agent/one'), false);
  assert.equal(await refWriteBlocker(f.db, 1, 'refs/heads/agent/one'), 'repository');
  assert.equal(await refWriteBlocker(f.db, 1, 'refs/heads/agent/two'), '');
  assert.equal(await f.reserve('refs/heads/agent/two'), true);
  // The other branch's own fence still holds it until it settles.
  assert.equal(await f.reserve('refs/heads/agent/two'), false);
  assert.equal(await refWriteBlocker(f.db, 1, 'refs/heads/agent/two'), 'branch');
  // Once the merge releases the repository, its base is writable again.
  f.sql.exec("UPDATE repositories SET write_pending=NULL WHERE id=1");
  assert.equal(await f.reserve('refs/heads/main'), true);
});

test('a repository hold that is not a known merge still holds every branch', async t => {
  const f = await fixture(t);
  f.sql.exec("UPDATE repositories SET write_pending='legacy' WHERE id=1");
  assert.equal(await f.reserve('refs/heads/agent/two'), false);
  assert.equal(await refWriteBlocker(f.db, 1, 'refs/heads/agent/two'), 'repository');
  // A merge's own push journal (no merge operation row) is not mistaken for a merge either.
  f.sql.exec(`INSERT INTO git_operations(id,repository_id,user_id,ref,old_sha,new_sha,state,created_at) VALUES('push',1,1,'refs/heads/main','${a}','${b}','DISPATCHED','t');
    UPDATE repositories SET write_pending='push' WHERE id=1`);
  assert.equal(await f.reserve('refs/heads/agent/two'), false);
});

test('a branch write admitted beside a merge settles without touching the merge hold', async t => {
  const f = await fixture(t);
  f.merge();
  const id = crypto.randomUUID();
  assert.equal(await reserveRefWrite(f.db, { id, repositoryId: 1, userId: 1, command: { ref: 'refs/heads/agent/two', old: zero, next: a },
    guard: { sql: '1', values: [] } }), true);
  await finishRefWrite(f.db, { id, repositoryId: 1, applied: true });
  assert.equal(f.sql.prepare('SELECT write_pending FROM repositories WHERE id=1').get().write_pending, 'merge');
  assert.equal(f.sql.prepare('SELECT state FROM git_operations WHERE id=?').get(id).state, 'APPLIED');
});
