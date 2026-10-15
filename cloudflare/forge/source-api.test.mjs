// Source API routes (docs/SOURCE_API.md) over node:sqlite as D1 and a real bare Git repository as the provider: object reads are
// `git cat-file`/`ls-tree`, info/refs is `git upload-pack --advertise-refs` and pushes are `git receive-pack`, so every commit the
// handler builds is checked by Git itself.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { digest, handle, serialize, admission, withArtifact } from './src/core.mjs';
import { bodyLimit } from './src/common.mjs';
import { packetLine } from './src/git.mjs';
import { sourceAPI } from './src/source-api.mjs';
import { scopeAllows, requireScope } from './src/token-scope.mjs';
import { gitAvailable, gitFixture } from './git-cli-fixture.mjs';

const origin = 'https://golf.example.com', artifact = 'repo-' + 'b'.repeat(32), key = { owner: 'alice', name: 'project' };
const tokens = Object.fromEntries(['alice', 'bob', 'carol', 'dave'].map((name, index) => [name, 'golf_native_' + String.fromCharCode(97 + index).repeat(43)]));
const types = { '040000': 'tree', '100644': 'blob', '100755': 'exec', '120000': 'symlink', '160000': 'gitlink' };

async function fixture(t) {
  const g = gitFixture(t), sql = new DatabaseSync(':memory:');
  t.after(() => sql.close());
  sql.exec(await readFile(new URL('./schema.sql', import.meta.url), 'utf8'));
  sql.exec("INSERT INTO users(id,login,email,full_name) VALUES(1,'alice','alice@example.com','Alice Example'),(2,'bob',NULL,'Bob'),(3,'carol',NULL,''),(4,'dave',NULL,'')");
  for (const [index, token] of Object.values(tokens).entries()) sql.prepare('INSERT INTO credentials VALUES(?,?,?,0)').run(await digest(token), index + 1, Math.floor(Date.now() / 1000) + 300);
  sql.exec("INSERT INTO workspaces(slug,artifact_namespace) VALUES('alice','test-space')");
  sql.prepare("INSERT INTO repositories(id,name,description,artifact_name,creator_id,creation_key,input_hash,state,created_at) VALUES(1,'project','',?,1,'original','hash','ACTIVE',?)").run(artifact, new Date().toISOString());
  sql.exec("INSERT INTO grants VALUES(1,1,'admin'),(1,2,'write'),(1,3,'read')");
  const db = {
    withSession() { return this; },
    prepare(query) { let values = []; const statement = sql.prepare(query); return {
      bind(...args) { assert.ok(args.every(value => value !== undefined), 'D1 refuses undefined bindings'); values = args; return this; },
      async first() { return statement.get(...values) || null; },
      async all() { return { results: statement.all(...values) }; },
      async run() { return { meta: { changes: statement.run(...values).changes } }; },
    }; },
    async batch(statements) {
      sql.exec('BEGIN');
      try { const results = []; for (const statement of statements) results.push(await statement.run()); sql.exec('COMMIT'); return results; }
      catch (error) { sql.exec('ROLLBACK'); throw error; }
    },
  };
  const git = args => spawnSync('git', ['--git-dir', g.directory, ...args], { env: g.env, maxBuffer: 1 << 28 });
  const counts = { pushes: 0 }, hooks = { beforePush: null };
  const env = { DB: db, ACCOUNT_ID: 'c'.repeat(32), ARTIFACTS_NAMESPACE: 'test-space', WORKSPACE_SLUG: 'alice', PUBLIC_ORIGIN: origin,
    ARTIFACTS: { async get(name) { assert.equal(name, artifact); return {
      async info() { return { name, remote: `https://${env.ACCOUNT_ID}.artifacts.cloudflare.net/git/test-space/${name}.git` }; },
      async createToken() { return { plaintext: 'art_v1_local' }; }, async revokeToken() { return true; }, [Symbol.dispose]() {},
      async readCommit(hash) {
        const read = git(['cat-file', 'commit', hash]);
        if (read.status) return null;
        const body = read.stdout.toString(), headers = body.slice(0, body.indexOf('\n\n')).split('\n');
        return { hash, treeHash: headers[0].slice(5), parents: headers.filter(line => line.startsWith('parent ')).map(line => line.slice(7)), message: body.slice(body.indexOf('\n\n') + 2), author: { name: 'x' }, authoredAt: 1 };
      },
      async readTree(hash) {
        const listed = git(['ls-tree', '-z', hash]);
        if (listed.status) return null;
        return listed.stdout.toString().split('\0').filter(Boolean).map(line => { const [mode, , id] = line.slice(0, line.indexOf('\t')).split(' '); return { name: line.slice(line.indexOf('\t') + 1), type: types[mode], hash: id, mode }; });
      },
      async readBlob(hash) { const read = git(['cat-file', 'blob', hash]); return read.status ? null : new Blob([read.stdout]); },
    }; } } };
  const providerFetch = async (url, options) => {
    assert.ok(url.startsWith(`https://${env.ACCOUNT_ID}.artifacts.cloudflare.net/git/test-space/${artifact}.git/`));
    if (options.method === 'POST') {
      counts.pushes++;
      if (hooks.beforePush) { const hook = hooks.beforePush; hooks.beforePush = null; await hook(); }
      const received = spawnSync('git', ['receive-pack', '--stateless-rpc', g.directory], { env: g.env, input: Buffer.from(options.body) });
      return new Response(received.stdout, { headers: { 'Content-Type': 'application/x-git-receive-pack-result' } });
    }
    const advertised = spawnSync('git', ['upload-pack', '--stateless-rpc', '--advertise-refs', g.directory], { env: g.env }).stdout;
    return new Response(Buffer.concat([packetLine('# service=git-upload-pack\n'), Buffer.from('0000'), advertised]), { headers: { 'Content-Type': 'application/x-git-upload-pack-advertisement' } });
  };
  const dispatch = serialize(request => handle(request, env, providerFetch), admission);
  const call = async (action, body, token = tokens.alice) => {
    const response = await dispatch(new Request(origin + '/native/source/' + action, { method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json', 'Connect-Protocol-Version': '1' }, body: JSON.stringify(body) }));
    return { status: response.status, body: await response.json() };
  };
  const ok = async (action, body, token) => { const result = await call(action, body, token); assert.equal(result.status, 200, JSON.stringify(result.body)); return result.body; };
  const head = ref => git(['rev-parse', '--verify', '-q', 'refs/heads/' + ref]).stdout.toString().trim();
  // The authorized row as core.mjs passes it, for direct calls with a token scope.
  const row = () => ({ ...sql.prepare("SELECT r.*,g.role,COALESCE((SELECT version FROM repository_access_versions WHERE repository_id=r.id),0) AS access_version FROM repositories r JOIN grants g ON g.repository_id=r.id WHERE r.id=1 AND g.user_id=1").get() });
  const direct = (action, body, person) => sourceAPI(db, env, { ...sql.prepare('SELECT * FROM users WHERE id=1').get(), identity_version: 0, ...person }, row(), action, body,
    { withArtifact, providerFetch, literalPath: value => value, ciState: 'NONE' });
  return { g, sql, env, call, ok, head, counts, hooks, direct, git };
}
const seed = f => f.ok('commit', { repository: key, branch: 'main', expectedHead: '', message: 'Initial', changes: [
  { path: 'README.md', content: '# Project\n' }, { path: 'src/app.js', content: 'console.log(1);\n' }, { path: 'src/lib/util.js', content: 'export {};\n' }, { path: 'docs/guide.md', content: 'guide\n' }] });

test('scopeAllows narrows a token to its repositories, permission and branch pattern', () => {
  assert.equal(scopeAllows({}, 1, { write: true, ref: 'main' }), true);
  const scope = (repositories, permission, branchPattern = '') => ({ token_scope: { repositories, permission, branchPattern } });
  assert.equal(scopeAllows(scope(null, 'read'), 7), true);
  assert.equal(scopeAllows(scope(['7'], 'read'), 7), true);
  assert.equal(scopeAllows(scope(['7'], 'read'), '8'), false);
  assert.equal(scopeAllows(scope([], 'write'), 7), false);
  assert.equal(scopeAllows(scope(null, 'read'), 7, { write: true, ref: 'main' }), false);
  assert.equal(scopeAllows(scope(null, 'write'), 7, { write: true, ref: 'main' }), true);
  assert.equal(scopeAllows(scope(null, 'write', 'agent/*'), 7, { write: true, ref: 'agent/fix' }), true);
  assert.equal(scopeAllows(scope(null, 'write', 'agent/*'), 7, { write: true, ref: 'refs/heads/agent/fix' }), true);
  assert.equal(scopeAllows(scope(null, 'write', 'agent/*'), 7, { write: true, ref: 'agentx' }), false);
  assert.equal(scopeAllows(scope(null, 'write', 'agent/*'), 7, { write: true, ref: 'refs/tags/agent/v1' }), false);
  assert.equal(scopeAllows(scope(null, 'write', 'agent/*'), 7, { write: true, ref: '' }), false);
  assert.equal(scopeAllows(scope(null, 'write', 'release'), 7, { write: true, ref: 'release' }), true);
  assert.equal(scopeAllows(scope(null, 'write', 'release'), 7, { write: true, ref: 'release/1' }), false);
  // A read never consults the branch pattern; malformed scopes fail closed.
  assert.equal(scopeAllows(scope(null, 'write', 'agent/*'), 7), true);
  assert.equal(scopeAllows({ token_scope: { permission: 'write' } }, 7), false);
  assert.equal(scopeAllows({ token_scope: 'all' }, 7), false);
  assert.equal(scopeAllows({ token_scope: { repositories: null, permission: 'admin' } }, 7, { write: true, ref: 'main' }), false);
  assert.throws(() => requireScope(scope(null, 'write', 'agent/*'), 7, { write: true, ref: 'main' }), error => error.status === 403 && error.code === 'permission_denied' && /agent\/\*/.test(error.message));
  assert.throws(() => requireScope(scope(['8'], 'read'), 7), /does not include this repository/);
  assert.throws(() => requireScope(scope(null, 'read'), 7, { write: true, ref: 'x' }), /read-only/);
});

test('Source API writes are transfers and its reads overlap; only a commit takes the large body', () => {
  const at = (path, method = 'POST') => admission(new Request(origin + path, { method, ...(method === 'POST' ? { body: '' } : {}) }));
  assert.equal(at('/native/source/commit'), 'transfer'); assert.equal(at('/native/source/branch'), 'transfer');
  assert.equal(at('/native/source/files'), 'read'); assert.equal(at('/native/source/tree'), 'read');
  assert.equal(at('/native/source/commit', 'GET'), 'exclusive'); assert.equal(at('/native/source/other'), 'exclusive');
  assert.equal(bodyLimit('/native/source/commit'), 12 * 1024 * 1024); assert.equal(bodyLimit('/native/source/files'), 128 * 1024);
  assert.equal(bodyLimit('/native/source/tree'), 96 * 1024); assert.equal(bodyLimit('/native/source/branch'), 96 * 1024);
});

test('commits build the same trees Git does, with edits, deletes, moves and modes, under the caller identity', { skip: !gitAvailable }, async t => {
  const f = await fixture(t);
  const first = await seed(f);
  assert.equal(f.head('main'), first.commitId); assert.equal(first.previousHead, ''); assert.equal(first.merged, false);
  assert.deepEqual(first.changedPaths.map(change => change.path), ['README.md', 'docs/guide.md', 'src/app.js', 'src/lib/util.js']);
  assert.equal(f.g.text(['log', '-1', '--format=%an <%ae>|%cn <%ce>|%P|%B', 'main']), 'Alice Example <alice@example.com>|Alice Example <alice@example.com>||Initial');
  const binary = Buffer.from([0, 1, 2, 255, 254]);
  const second = await f.ok('commit', { repository: key, branch: 'main', expectedHead: first.commitId, message: 'Edit\n\nBody line.\n\n\n', changes: [
    { path: 'README.md', content: '# Project\n\nMore.\n' }, { path: 'src/lib/util.js', delete: true }, { path: 'docs/manual.md', from: 'docs/guide.md' },
    { path: 'bin/run', content: '#!/bin/sh\necho run\n', mode: 'executable' }, { path: 'assets/logo.bin', contentBase64: binary.toString('base64') },
    { path: 'latest', content: 'README.md', mode: 'symlink' }] });
  assert.equal(second.previousHead, first.commitId); assert.equal(f.head('main'), second.commitId);
  assert.equal(f.g.text(['log', '-1', '--format=%P|%B', 'main']), first.commitId + '|Edit\n\nBody line.');
  // Git's own index, given the same edits, writes the same tree.
  const expected = f.g.edit(first.commitId, [{ path: 'README.md', content: '# Project\n\nMore.\n' }, { path: 'src/lib/util.js', delete: true }, { path: 'docs/guide.md', delete: true },
    { path: 'docs/manual.md', content: 'guide\n' }, { path: 'bin/run', content: '#!/bin/sh\necho run\n', mode: 'executable' }, { path: 'assets/logo.bin', content: binary }, { path: 'latest', content: 'README.md', mode: 'symlink' }]);
  assert.equal(second.treeId, expected); assert.equal(f.g.text(['rev-parse', 'main^{tree}']), expected);
  assert.equal(f.g.text(['ls-tree', 'main', 'bin/run']).split(' ')[0], '100755');
  assert.deepEqual(f.g.run(['cat-file', 'blob', 'main:assets/logo.bin']), binary);
  assert.deepEqual(second.changedPaths, [{ path: 'README.md', change: 'modified' }, { path: 'assets/logo.bin', change: 'added' }, { path: 'bin/run', change: 'added' },
    { path: 'docs/guide.md', change: 'deleted' }, { path: 'docs/manual.md', change: 'added' }, { path: 'latest', change: 'added' }, { path: 'src/lib/util.js', change: 'deleted' }]);
  f.g.run(['fsck', '--strict', '--full', '--no-dangling']);
  // A new branch from a branch name, then from a commit.
  const feature = await f.ok('commit', { repository: key, branch: 'agent/one', expectedHead: '', base: 'main', message: 'Agent', changes: [{ path: 'agent.txt', content: 'hi\n' }] }, tokens.bob);
  assert.equal(f.g.text(['log', '-1', '--format=%an <%ae>|%P', 'agent/one']), `Bob <bob@users.noreply.golf.example.com>|${second.commitId}`);
  assert.equal(feature.branch, 'agent/one');
  const fromCommit = await f.ok('commit', { repository: key, branch: 'agent/two', expectedHead: '', base: first.commitId, message: 'Two', changes: [{ path: 'two.txt', content: '2' }] });
  assert.equal(f.g.text(['rev-parse', 'agent/two^']), first.commitId); assert.equal(fromCommit.previousHead, '');
  assert.deepEqual(f.sql.prepare("SELECT state,ref FROM git_operations ORDER BY created_at").all().map(row => [row.state, row.ref]), [['APPLIED', 'refs/heads/main'], ['APPLIED', 'refs/heads/main'], ['APPLIED', 'refs/heads/agent/one'], ['APPLIED', 'refs/heads/agent/two']]);
  assert.equal(f.sql.prepare('SELECT COUNT(*) n FROM git_ref_writes').get().n, 0);
});

test('commit input is validated before anything is sent, and every limit names itself', { skip: !gitAvailable }, async t => {
  const f = await fixture(t);
  const first = await seed(f), pushes = f.counts.pushes;
  const body = changes => ({ repository: key, branch: 'main', expectedHead: first.commitId, message: 'x', changes });
  const refused = async (input, status, pattern, token) => { const result = await f.call('commit', input, token); assert.equal(result.status, status, JSON.stringify(result.body)); assert.match(result.body.message, pattern); return result.body; };
  await refused({ ...body([{ path: 'a', content: 'a' }]), branch: 'refs/heads/main' }, 400, /short branch name/);
  await refused({ ...body([{ path: 'a', content: 'a' }]), branch: 'bad..name' }, 400, /short branch name/);
  await refused({ ...body([{ path: 'a', content: 'a' }]), expectedHead: 'main' }, 400, /expectedHead/);
  await refused({ ...body([{ path: 'a', content: 'a' }]), base: 'main' }, 400, /base/);
  await refused({ ...body([{ path: 'a', content: 'a' }]), message: '' }, 400, /message/);
  await refused({ ...body([{ path: 'a', content: 'a' }]), message: 'a\0b' }, 400, /message/);
  await refused({ ...body([{ path: 'a', content: 'a' }]), message: 'x'.repeat(65 * 1024) }, 413, /64 KiB/);
  await refused({ ...body([{ path: 'a', content: 'a' }]), onStale: 'rebase' }, 400, /onStale/);
  await refused({ ...body([{ path: 'a', content: 'a' }]), idempotencyKey: 'not-a-uuid' }, 400, /UUID/);
  await refused(body([]), 400, /at least one change/);
  await refused(body(Array.from({ length: 501 }, (_, i) => ({ path: 'f' + i, content: '' }))), 413, /500 changes/);
  await refused(body([{ path: 'big', content: 'x'.repeat(4 * 1024 * 1024 + 1) }]), 413, /4 MiB.*big/);
  await refused(body([1, 2, 3].map(i => ({ path: 'part' + i, content: 'z'.repeat(3 * 1024 * 1024) }))), 413, /8 MiB/);
  await refused(body([{ path: 'a', content: 'x'.repeat(12 * 1024 * 1024) }]), 429, /native limit/);
  await refused(body([{ path: 'a', contentBase64: 'not base64!' }]), 400, /base64/);
  await refused(body([{ path: 'a', content: 'a', delete: true }]), 400, /exactly one/);
  await refused(body([{ path: 'a', delete: true, mode: 'file' }]), 400, /mode applies/);
  await refused(body([{ path: 'a', content: 'a', extra: 1 }]), 400, /Unknown change field extra/);
  await refused(body([{ path: '../a', content: 'a' }]), 400, /literal repository path/);
  await refused(body([{ path: 'a\\b', content: 'a' }]), 400, /literal repository path/);
  await refused(body([{ path: 'a', content: '\ud800' }]), 400, /UTF-8/);
  // Tree-level refusals name the path and the reason.
  const tree = await refused(body([{ path: 'sub/.GIT/config', content: 'a' }]), 400, /\.git.*sub\/\.GIT\/config/);
  assert.equal(tree.reason, 'invalid_path');
  assert.deepEqual((({ reason, path }) => ({ reason, path }))(await refused(body([{ path: 'gone.txt', delete: true }]), 400, /does not exist/)), { reason: 'missing_path', path: 'gone.txt' });
  assert.equal((await refused(body([{ path: 'README.md/x', content: 'a' }]), 400, /file exists/)).reason, 'path_conflict');
  assert.equal((await refused(body([{ path: 'a', content: '1' }, { path: 'a', content: '2' }]), 400, /more than once/)).reason, 'duplicate_path');
  await refused(body([{ path: 'README.md', content: '# Project\n' }]), 400, /nothing was committed/);
  await refused({ ...body([{ path: 'a', content: 'a' }]), branch: 'missing' }, 404, /does not exist/);
  await refused({ ...body([{ path: 'a', content: 'a' }]), expectedHead: 'f'.repeat(40) }, 409, /moved past expectedHead/);
  await refused({ ...body([{ path: 'a', content: 'a' }]), expectedHead: '', base: '' }, 409, /already exists/);
  await refused({ ...body([{ path: 'a', content: 'a' }]), branch: 'new', expectedHead: '' }, 400, /Name a base/);
  await refused({ ...body([{ path: 'a', content: 'a' }]), branch: 'new', expectedHead: '', base: 'nope' }, 404, /Base branch nope/);
  await refused({ ...body([{ path: 'a', content: 'a' }]), branch: 'new', expectedHead: '', base: 'e'.repeat(40) }, 404, /base commit/);
  assert.equal(f.counts.pushes, pushes);
});

test('a moved branch fails by default, merges disjoint paths with onStale merge and lists overlapping paths', { skip: !gitAvailable }, async t => {
  const f = await fixture(t);
  const first = await seed(f);
  const other = await f.ok('commit', { repository: key, branch: 'main', expectedHead: first.commitId, message: 'Other', changes: [{ path: 'src/app.js', content: 'console.log(2);\n' }] }, tokens.bob);
  const stale = { repository: key, branch: 'main', expectedHead: first.commitId, message: 'Mine', changes: [{ path: 'docs/guide.md', content: 'better guide\n' }, { path: 'new.txt', content: 'new\n' }] };
  const failed = await f.call('commit', stale);
  assert.equal(failed.status, 409); assert.equal(failed.body.code, 'aborted'); assert.equal(failed.body.currentHead, other.commitId);
  const merged = await f.ok('commit', { ...stale, onStale: 'merge' });
  assert.equal(merged.merged, true); assert.equal(merged.previousHead, other.commitId);
  assert.equal(f.g.text(['rev-parse', 'main^']), other.commitId);
  assert.equal(f.g.text(['show', 'main:src/app.js']), 'console.log(2);'); assert.equal(f.g.text(['show', 'main:docs/guide.md']), 'better guide'); assert.equal(f.g.text(['show', 'main:new.txt']), 'new');
  assert.deepEqual(merged.changedPaths, [{ path: 'docs/guide.md', change: 'modified' }, { path: 'new.txt', change: 'added' }]);
  f.g.run(['fsck', '--strict', '--full', '--no-dangling']);
  const conflict = await f.call('commit', { repository: key, branch: 'main', expectedHead: first.commitId, message: 'Clash', onStale: 'merge', changes: [{ path: 'src/app.js', content: 'console.log(3);\n' }, { path: 'docs/guide.md', delete: true }] });
  assert.equal(conflict.status, 409); assert.equal(conflict.body.currentHead, merged.commitId);
  assert.deepEqual(conflict.body.conflicts, [{ path: 'docs/guide.md', reason: 'deleted_by_them' }, { path: 'src/app.js', reason: 'both_modified' }]);
  assert.equal(f.head('main'), merged.commitId);
  // The head moves again between the read and the push: the provider refuses, and the merge is retried on the newer head.
  f.hooks.beforePush = () => { f.g.run(['update-ref', 'refs/heads/main', f.g.text(['commit-tree', f.g.edit(merged.commitId, [{ path: 'race.txt', content: 'race\n' }]), '-p', merged.commitId, '-m', 'race'])]); };
  const raced = await f.ok('commit', { repository: key, branch: 'main', expectedHead: merged.commitId, message: 'After race', onStale: 'merge', changes: [{ path: 'mine.txt', content: 'mine\n' }] });
  assert.equal(raced.merged, true); assert.equal(f.g.text(['show', 'main:race.txt']), 'race'); assert.equal(f.g.text(['show', 'main:mine.txt']), 'mine');
  assert.equal(f.sql.prepare("SELECT COUNT(*) n FROM git_ref_writes WHERE outcome='NOT_APPLIED'").get().n, 1);
  assert.equal(f.sql.prepare('SELECT write_pending FROM repositories').get().write_pending, null);
  // With onStale fail the same race is a 409 after the refused attempt.
  const now = f.head('main');
  f.hooks.beforePush = () => { f.g.run(['update-ref', 'refs/heads/main', f.g.text(['commit-tree', f.g.edit(now, [{ path: 'race2.txt', content: 'r\n' }]), '-p', now, '-m', 'race2'])]); };
  const lost = await f.call('commit', { repository: key, branch: 'main', expectedHead: now, message: 'Lost', changes: [{ path: 'lost.txt', content: 'x' }] });
  assert.equal(lost.status, 409); assert.equal(lost.body.currentHead, f.head('main'));
});

test('onStale merge combines edits to different lines of one file and lists edits to the same lines', { skip: !gitAvailable }, async t => {
  const f = await fixture(t);
  const lines = Array.from({ length: 12 }, (_, i) => `line ${i + 1}\n`).join(''), at = (from, to) => lines.replace(from, to);
  const first = await seed(f), start = await f.ok('commit', { repository: key, branch: 'main', expectedHead: first.commitId, message: 'Notes', changes: [{ path: 'notes.txt', content: lines }] });
  await f.ok('commit', { repository: key, branch: 'main', expectedHead: start.commitId, message: 'Top', changes: [{ path: 'notes.txt', content: at('line 2\n', 'TWO\n') }] }, tokens.bob);
  const merged = await f.ok('commit', { repository: key, branch: 'main', expectedHead: start.commitId, message: 'Bottom', onStale: 'merge', changes: [{ path: 'notes.txt', content: at('line 11\n', 'ELEVEN\n') }] });
  assert.equal(merged.merged, true);
  assert.deepEqual(merged.changedPaths, [{ path: 'notes.txt', change: 'modified' }]);
  assert.equal(f.g.text(['show', 'main:notes.txt']) + '\n', at('line 2\n', 'TWO\n').replace('line 11\n', 'ELEVEN\n'));
  f.g.run(['fsck', '--strict', '--full', '--no-dangling']);
  const clash = await f.call('commit', { repository: key, branch: 'main', expectedHead: start.commitId, message: 'Clash', onStale: 'merge', changes: [{ path: 'notes.txt', content: at('line 2\n', 'two\n') }] });
  assert.equal(clash.status, 409); assert.deepEqual(clash.body.conflicts, [{ path: 'notes.txt', reason: 'both_modified' }]);
  assert.equal(f.head('main'), merged.commitId);
});

test('an idempotency key replays the original commit and refuses different inputs', { skip: !gitAvailable }, async t => {
  const f = await fixture(t);
  const first = await seed(f), idempotencyKey = crypto.randomUUID();
  const input = { repository: key, branch: 'main', expectedHead: first.commitId, message: 'Once', idempotencyKey, changes: [{ path: 'once.txt', content: 'once\n' }, { path: 'b.bin', contentBase64: 'AAEC' }] };
  const original = await f.ok('commit', input), pushes = f.counts.pushes;
  assert.deepEqual(await f.ok('commit', input), original); assert.equal(f.counts.pushes, pushes);
  const changed = await f.call('commit', { ...input, changes: [{ path: 'once.txt', content: 'twice\n' }] });
  assert.equal(changed.status, 409); assert.equal(changed.body.code, 'already_exists');
  // Another caller's key space is separate; a refusal before any write frees the key for a corrected request.
  const other = crypto.randomUUID(), stale = { ...input, idempotencyKey: other, expectedHead: first.commitId, changes: [{ path: 'x.txt', content: 'x' }] };
  assert.equal((await f.call('commit', stale)).status, 409);
  assert.equal(f.sql.prepare('SELECT COUNT(*) n FROM source_commits WHERE idempotency_key=?').get(other).n, 0);
  assert.equal((await f.call('commit', { ...stale, expectedHead: original.commitId })).status, 200);
  // An unknown outcome keeps the claim; the replay waits until maintenance settles it.
  const unknown = crypto.randomUUID();
  f.sql.prepare("INSERT INTO git_operations(id,repository_id,user_id,ref,old_sha,new_sha,state,created_at) VALUES('op-unknown',1,1,'refs/heads/main',?,?,'DISPATCHED',?)").run('1'.repeat(40), '2'.repeat(40), new Date().toISOString());
  f.sql.prepare("INSERT INTO source_commits VALUES(1,?,1,'h','op-unknown','{}',?)").run(unknown, new Date().toISOString());
  const replay = await f.call('commit', { ...input, idempotencyKey: unknown });
  assert.equal(replay.status, 409);
  const sameHash = f.sql.prepare('SELECT input_hash FROM source_commits WHERE idempotency_key=?').get(idempotencyKey).input_hash;
  f.sql.prepare('UPDATE source_commits SET input_hash=? WHERE idempotency_key=?').run(sameHash, unknown);
  const pending = await f.call('commit', { ...input, idempotencyKey: unknown });
  assert.equal(pending.status, 409); assert.match(pending.body.message, /unknown outcome/);
});

test('branches are created and deleted through the same fence with an expected head', { skip: !gitAvailable }, async t => {
  const f = await fixture(t);
  const first = await seed(f), pushes = f.counts.pushes;
  const created = await f.ok('branch', { repository: key, branch: 'feature/x', action: 'create', from: 'main' });
  assert.deepEqual(created, { repositoryId: '1', branch: 'feature/x', action: 'create', commitId: first.commitId });
  assert.equal(f.head('feature/x'), first.commitId); assert.equal(f.counts.pushes, pushes + 1);
  assert.equal((await f.ok('branch', { repository: key, branch: 'by-sha', action: 'create', from: first.commitId })).commitId, first.commitId);
  const exists = await f.call('branch', { repository: key, branch: 'feature/x', action: 'create', from: 'main' });
  assert.equal(exists.status, 409); assert.equal(exists.body.code, 'already_exists'); assert.equal(exists.body.currentHead, first.commitId);
  assert.equal((await f.call('branch', { repository: key, branch: 'y', action: 'create', from: 'nope' })).status, 404);
  assert.equal((await f.call('branch', { repository: key, branch: 'y', action: 'create', from: 'd'.repeat(40) })).status, 404);
  assert.equal((await f.call('branch', { repository: key, branch: 'y', action: 'rename', from: 'main' })).status, 400);
  const wrong = await f.call('branch', { repository: key, branch: 'feature/x', action: 'delete', expectedHead: 'd'.repeat(40) });
  assert.equal(wrong.status, 409); assert.equal(wrong.body.currentHead, first.commitId);
  assert.deepEqual(await f.ok('branch', { repository: key, branch: 'feature/x', action: 'delete', expectedHead: first.commitId }), { repositoryId: '1', branch: 'feature/x', action: 'delete', previousHead: first.commitId });
  assert.equal(f.head('feature/x'), '');
  assert.equal((await f.call('branch', { repository: key, branch: 'feature/x', action: 'delete', expectedHead: first.commitId })).status, 404);
  const main = await f.call('branch', { repository: key, branch: 'main', action: 'delete', expectedHead: first.commitId });
  assert.equal(main.status, 412); assert.match(main.body.message, /default branch/);
  assert.deepEqual(f.sql.prepare("SELECT new_sha FROM git_operations WHERE ref='refs/heads/feature/x' AND state='APPLIED' ORDER BY created_at").all().map(row => row.new_sha), [first.commitId, '0'.repeat(40)]);
  // A branch lock refuses API writes as it refuses pushes, also for administrators.
  f.sql.prepare("INSERT INTO repository_rules VALUES(1,?,1,?,'[]',1)").run(artifact, JSON.stringify([{ ruleName: 'locked/*', priority: 1 }]));
  const locked = await f.call('commit', { repository: key, branch: 'locked/a', expectedHead: '', base: 'main', message: 'x', changes: [{ path: 'a', content: 'a' }] });
  assert.equal(locked.status, 403); assert.equal(locked.body.code, 'permission_denied');
  assert.equal((await f.call('branch', { repository: key, branch: 'locked/b', action: 'create', from: 'main' })).status, 403);
  f.g.run(['fsck', '--strict', '--full', '--no-dangling']);
});

test('files and tree read a commit by branch, tag or ID within their bounds', { skip: !gitAvailable }, async t => {
  const f = await fixture(t);
  await seed(f);
  const large = 'x'.repeat(1024 * 1024 + 1), chunk = 'y'.repeat(1000 * 1024);
  const second = await f.ok('commit', { repository: key, branch: 'main', expectedHead: f.head('main'), message: 'More', changes: [
    { path: 'bin.dat', contentBase64: Buffer.from([1, 0, 2]).toString('base64') }, { path: 'latin1.txt', contentBase64: Buffer.from([0xe9]).toString('base64') },
    { path: 'large.txt', content: large }, { path: 'run.sh', content: 'echo\n', mode: 'executable' }, ...[1, 2, 3, 4, 5].map(i => ({ path: `chunks/${i}.txt`, content: chunk })) ] });
  f.g.run(['tag', 'v1', second.commitId]); f.g.run(['tag', '-a', 'v1-annotated', '-m', 'annotated', second.commitId]);
  const read = await f.ok('files', { repository: key, ref: 'main', paths: ['README.md', 'bin.dat', 'latin1.txt', 'large.txt', 'src', 'nope.txt', 'run.sh', 'src/lib/util.js/x'] });
  assert.equal(read.commitId, second.commitId);
  const [readme, bin, latin1, big, directory, missing, run, below] = read.files;
  assert.deepEqual({ ...readme, sha: undefined }, { path: 'README.md', type: 'file', mode: '100644', sha: undefined, size: 10, content: '# Project\n' });
  assert.equal(bin.contentBase64, 'AQAC'); assert.equal(latin1.contentBase64, '6Q=='); assert.equal(bin.content, undefined);
  assert.deepEqual([big.skipped, big.size], ['too_large', large.length]);
  assert.deepEqual([directory.type, directory.skipped], ['directory', 'directory']);
  assert.deepEqual(missing, { path: 'nope.txt', skipped: 'missing' }); assert.deepEqual(below, { path: 'src/lib/util.js/x', skipped: 'missing' });
  assert.deepEqual([run.type, run.mode, run.content], ['executable', '100755', 'echo\n']);
  assert.equal(readme.sha, f.g.text(['rev-parse', 'main:README.md']));
  // Five 1000 KiB files exceed the 4 MiB total: the fifth is named, not cut.
  const chunks = await f.ok('files', { repository: key, ref: 'v1', paths: [1, 2, 3, 4, 5].map(i => `chunks/${i}.txt`) });
  assert.deepEqual(chunks.files.map(file => file.skipped || file.content.length), [chunk.length, chunk.length, chunk.length, chunk.length, 'total_limit']);
  assert.equal((await f.ok('files', { repository: key, ref: 'v1-annotated', paths: ['README.md'] })).commitId, second.commitId);
  assert.equal((await f.ok('files', { repository: key, ref: 'refs/tags/v1-annotated', paths: ['README.md'] })).commitId, second.commitId);
  assert.equal((await f.ok('files', { repository: key, paths: ['README.md'] })).commitId, second.commitId);
  const old = await f.ok('files', { repository: key, ref: f.g.text(['rev-parse', 'main^']), paths: ['bin.dat'] });
  assert.deepEqual(old.files, [{ path: 'bin.dat', skipped: 'missing' }]);
  assert.equal((await f.call('files', { repository: key, ref: 'nope', paths: ['a'] })).status, 404);
  assert.equal((await f.call('files', { repository: key, ref: 'main', paths: [] })).status, 400);
  assert.equal((await f.call('files', { repository: key, ref: 'main', paths: Array.from({ length: 101 }, (_, i) => 'f' + i) })).status, 400);
  assert.equal((await f.call('files', { repository: key, ref: 'main', paths: ['a', 'a'] })).status, 400);
  assert.equal((await f.call('files', { repository: key, ref: 'main', paths: ['../etc'] })).status, 400);

  const listed = await f.ok('tree', { repository: key, ref: 'main' });
  assert.equal(listed.truncated, false);
  const expected = f.g.text(['ls-tree', '-r', '-t', '--format=%(path) %(objectmode) %(objectname)', 'main']).split('\n').sort();
  assert.deepEqual(listed.entries.map(entry => `${entry.path} ${entry.mode} ${entry.sha}`).sort(), expected);
  assert.deepEqual(listed.entries.find(entry => entry.path === 'src/lib'), { path: 'src/lib', type: 'directory', mode: '040000', sha: f.g.text(['rev-parse', 'main:src/lib']) });
  assert.deepEqual((await f.ok('tree', { repository: key, ref: 'main', path: 'src', recursive: false })).entries.map(entry => [entry.path, entry.type]), [['src/app.js', 'file'], ['src/lib', 'directory']]);
  assert.deepEqual((await f.ok('tree', { repository: key, ref: 'main', path: 'src' })).entries.map(entry => entry.path), ['src/app.js', 'src/lib', 'src/lib/util.js']);
  assert.equal((await f.call('tree', { repository: key, ref: 'main', path: 'README.md' })).status, 400);
  assert.equal((await f.call('tree', { repository: key, ref: 'main', path: 'nope' })).status, 404);
  assert.equal((await f.call('tree', { repository: key, ref: 'main', recursive: 'yes' })).status, 400);
});

test('a tree listing stops at 10,000 entries and says so', { skip: !gitAvailable }, async t => {
  const f = await fixture(t);
  const blob = f.g.blob('x'), entries = Array.from({ length: 10050 }, (_, i) => `100644 blob ${blob}\tf${String(i).padStart(5, '0')}\n`).join('');
  const commit = f.g.text(['commit-tree', f.g.text(['mktree'], entries), '-m', 'wide']);
  f.g.run(['update-ref', 'refs/heads/main', commit]);
  const listed = await f.ok('tree', { repository: key, ref: commit });
  assert.equal(listed.truncated, true); assert.equal(listed.entries.length, 10000); assert.equal(listed.limit, 10000);
});

test('grants, scopes and readers: reads need a grant, writes need write access, and a token scope narrows both', { skip: !gitAvailable }, async t => {
  const f = await fixture(t);
  const first = await seed(f);
  const write = { repository: key, branch: 'main', expectedHead: first.commitId, message: 'x', changes: [{ path: 'a', content: 'a' }] };
  assert.equal((await f.ok('files', { repository: key, ref: 'main', paths: ['README.md'] }, tokens.carol)).files[0].content, '# Project\n');
  const reader = await f.call('commit', write, tokens.carol);
  assert.equal(reader.status, 403); assert.match(reader.body.message, /write or admin grant/);
  assert.equal((await f.call('branch', { repository: key, branch: 'x', action: 'create', from: 'main' }, tokens.carol)).status, 403);
  for (const action of ['files', 'commit', 'tree']) assert.equal((await f.call(action, { repository: key, ref: 'main', paths: ['README.md'], ...write }, tokens.dave)).status, 404);
  assert.equal((await f.call('files', { repository: { owner: 'alice', name: 'other' }, paths: ['a'] })).status, 404);
  assert.equal((await f.call('files', { repository: key, repositoryId: '2', paths: ['a'] })).status, 404);
  // An unknown action is not implemented.
  const unknown = await f.call('rename', {}); assert.equal(unknown.status, 501);
  const scoped = (scope, action, body) => f.direct(action, body, { token_scope: scope });
  const pushes = f.counts.pushes;
  await assert.rejects(scoped({ repositories: ['9'], permission: 'write', branchPattern: '' }, 'files', { repository: key, paths: ['README.md'] }), error => error.status === 403 && /does not include this repository/.test(error.message));
  await assert.rejects(scoped({ repositories: null, permission: 'read', branchPattern: '' }, 'commit', write), error => error.status === 403 && /read-only/.test(error.message));
  await assert.rejects(scoped({ repositories: ['1'], permission: 'write', branchPattern: 'agent/*' }, 'commit', write), error => error.status === 403 && /agent\/\*/.test(error.message));
  await assert.rejects(scoped({ repositories: ['1'], permission: 'write', branchPattern: 'agent/*' }, 'branch', { branch: 'main2', action: 'create', from: 'main' }), error => error.status === 403);
  assert.equal(f.counts.pushes, pushes);
  // Within its scope a token writes and reads like its account.
  const allowed = await scoped({ repositories: ['1'], permission: 'write', branchPattern: 'agent/*' }, 'commit', { ...write, branch: 'agent/demo', expectedHead: '', base: 'main' });
  assert.equal(f.head('agent/demo'), allowed.commitId);
  assert.equal((await scoped({ repositories: ['1'], permission: 'read', branchPattern: '' }, 'files', { paths: ['README.md'] })).files[0].content, '# Project\n');
  // The token's own guard joins the fence: a revoked token reserves nothing.
  await assert.rejects(f.direct('commit', { ...write, branch: 'agent/demo', expectedHead: allowed.commitId, changes: [{ path: 'a', content: 'b' }] }, { token_guard: { sql: 'EXISTS(SELECT 1 WHERE ?=1)', values: [0] } }), error => error.status === 412);
  assert.equal(f.head('agent/demo'), allowed.commitId); assert.equal(f.sql.prepare('SELECT COUNT(*) n FROM git_ref_writes').get().n, 0);
});

test('Source API capability is ready on schema 38', { skip: !gitAvailable }, async t => {
  const f = await fixture(t);
  const response = await handle(new Request(origin + '/rpc/golf.v1.CapabilityService/ListCapabilities', { method: 'POST', headers: { Authorization: 'Bearer ' + tokens.alice, 'Content-Type': 'application/json', 'Connect-Protocol-Version': '1' }, body: '{}' }), f.env);
  const capability = (await response.json()).capabilities.find(item => item.id === 'repository.source-api');
  assert.equal(capability.state, 'CAPABILITY_STATE_READY');
  f.sql.exec('DROP TABLE source_commits');
  const after = await handle(new Request(origin + '/rpc/golf.v1.CapabilityService/ListCapabilities', { method: 'POST', headers: { Authorization: 'Bearer ' + tokens.alice, 'Content-Type': 'application/json', 'Connect-Protocol-Version': '1' }, body: '{}' }), f.env);
  assert.deepEqual((({ state, reason }) => ({ state, reason }))((await after.json()).capabilities.find(item => item.id === 'repository.source-api')), { state: 'CAPABILITY_STATE_DISABLED', reason: 'Apply the schema 38 migration to use the Source API.' });
});

test('concurrent commits: other branches proceed, the same branch is fenced and merged on retry, a held fence refuses', { skip: !gitAvailable }, async t => {
  const f = await fixture(t);
  const first = await seed(f);
  const change = (branch, path, extra = {}) => f.call('commit', { repository: key, branch, expectedHead: first.commitId, message: path, onStale: 'merge', changes: [{ path, content: path + '\n' }], ...extra });
  const results = await Promise.all([change('main', 'one.txt'), change('main', 'two.txt'), change('agent/x', 'three.txt', { expectedHead: '', base: first.commitId, onStale: undefined })]);
  assert.deepEqual(results.map(result => result.status), [200, 200, 200], JSON.stringify(results));
  assert.equal(results.filter(result => result.body.merged).length, 1);
  assert.equal(f.g.text(['show', 'main:one.txt']), 'one.txt'); assert.equal(f.g.text(['show', 'main:two.txt']), 'two.txt'); assert.equal(f.g.text(['show', 'agent/x:three.txt']), 'three.txt');
  assert.equal(f.g.text(['rev-list', '--count', 'main']), '3');
  // An unsettled write to the branch holds it: three attempts, then a refusal naming it; other branches still proceed.
  f.sql.prepare("INSERT INTO git_operations(id,repository_id,user_id,ref,old_sha,new_sha,state,created_at) VALUES('held',1,1,'refs/heads/main',?,?,'DISPATCHED',?)").run('1'.repeat(40), '2'.repeat(40), new Date().toISOString());
  f.sql.prepare("INSERT INTO git_ref_writes(operation_id,repository_id,ref) VALUES('held',1,'refs/heads/main')").run();
  const pushes = f.counts.pushes, held = await f.call('commit', { repository: key, branch: 'main', expectedHead: f.head('main'), message: 'x', changes: [{ path: 'held.txt', content: 'x' }] });
  assert.equal(held.status, 409); assert.match(held.body.message, /in flight.*3 attempts/); assert.equal(f.counts.pushes, pushes);
  assert.equal((await f.call('branch', { repository: key, branch: 'other', action: 'create', from: 'main' })).status, 200);
});
