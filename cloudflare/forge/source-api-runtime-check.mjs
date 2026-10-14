// The Source API (docs/SOURCE_API.md) in actual workerd with real D1 against a real local Git repository; only the Artifacts binding is
// a fixture. Objects are read with `git cat-file`/`ls-tree`, refs with `git upload-pack --advertise-refs`, and every commit, branch
// create and delete built inside workerd is received by `git receive-pack`, the program a smart-HTTP server runs.
//
//   node cloudflare/forge/source-api-runtime-check.mjs "$(command -v cf)"
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { realpathSync, mkdtempSync, rmSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { packetLine } from './src/git.mjs';
import * as esbuild from '../agents/node_modules/esbuild/lib/main.js';

const cli = dirname(dirname(realpathSync(process.argv[2])));
const { Miniflare, convertV4MiniflareOptions } = await import(pathToFileURL(resolve(cli, 'node_modules/miniflare/dist/src/index.js')).href);
// /fixture/scoped/<action> stands in for an API token caller (AM-3): the signed-in account with the X-Fixture-Scope token scope attached.
const bundle = await esbuild.build({ stdin: { resolveDir: resolve('cloudflare/forge'), sourcefile: 'source-api-runtime-fixture.mjs', contents: `
import { handle, serialize, admission, withArtifact } from './src/core.mjs';
import { sourceAPI } from './src/source-api.mjs';
import { reply, Fault } from './src/common.mjs';
import { remote } from './src/git.mjs';
const read = async (kind, hash) => { const response = await fetch('https://fixture.invalid/' + kind + '/' + hash); return response.ok ? response : null; };
const fixture = env => ({ ...env, ARTIFACTS: { async get(name) { return { async info() { return { name, remote: remote(env, name) }; },
  async createToken() { return { plaintext: 'local-only-token' }; }, async revokeToken() { return true; }, [Symbol.dispose]() {},
  async readCommit(hash) { return (await read('commit', hash))?.json() ?? null; }, async readTree(hash) { return (await read('tree', hash))?.json() ?? null; },
  async readBlob(hash) { const response = await read('blob', hash); return response ? new Blob([await response.arrayBuffer()]) : null; } }; } } });
let dispatch;
export default { async fetch(request, env) {
  const path = new URL(request.url).pathname;
  if (path.startsWith('/fixture/scoped/')) {
    const db = env.DB, configured = fixture(env), body = await request.json();
    const person = { ...await db.prepare('SELECT * FROM users WHERE id=1').first(), identity_version: 0, token_scope: JSON.parse(request.headers.get('X-Fixture-Scope')) };
    const row = await db.prepare("SELECT r.*,g.role,COALESCE((SELECT version FROM repository_access_versions WHERE repository_id=r.id),0) AS access_version FROM repositories r JOIN grants g ON g.repository_id=r.id WHERE r.id=1 AND g.user_id=1").first();
    try {
      const result = await sourceAPI(db, configured, person, row, path.split('/').at(-1), body, { withArtifact, providerFetch: fetch, literalPath: value => value, ciState: 'NONE' });
      return result instanceof Response ? result : reply(result);
    } catch (error) { if (error instanceof Fault) return reply({ code: error.code, message: error.message }, error.status); throw error; }
  }
  dispatch ||= serialize(request => handle(request, fixture(env)), admission);
  return dispatch(request);
} };` }, bundle: true, write: false, format: 'esm', platform: 'neutral' });

const root = mkdtempSync(join(tmpdir(), 'golf-source-runtime-')), directory = join(root, 'project.git'), origin = 'https://golf.example.com';
const gitEnv = { PATH: process.env.PATH, HOME: root, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid', GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid' };
const git = (args, input, extra = {}) => execFileSync('git', ['--git-dir', directory, ...args], { env: { ...gitEnv, ...extra }, input, stdio: ['pipe', 'pipe', 'pipe'], maxBuffer: 1 << 28 });
const text = (...args) => git(...args).toString().trim(), head = name => spawnSync('git', ['--git-dir', directory, 'rev-parse', '--verify', '-q', 'refs/heads/' + name], { env: gitEnv }).stdout.toString().trim();
execFileSync('git', ['init', '--bare', '--quiet', '--initial-branch=main', directory], { env: gitEnv });
// Git's own index applies the same edits: {path, content, mode} or {path, delete: true}.
let indexes = 0;
const gitTree = (base, ops) => {
  const index = { GIT_INDEX_FILE: join(root, `index-${indexes++}`) }, modes = { file: '100644', executable: '100755', symlink: '120000' };
  git(['read-tree', base], undefined, index);
  git(['update-index', '--index-info'], ops.map(op => op.delete ? `0 ${'0'.repeat(40)}\t${op.path}\n` : `${modes[op.mode || 'file']} ${text(['hash-object', '-w', '--stdin'], op.content)}\t${op.path}\n`).join(''), index);
  return text(['write-tree'], undefined, index);
};
const types = { '040000': 'tree', '100644': 'blob', '100755': 'exec', '120000': 'symlink', '160000': 'gitlink' };
let pushes = 0;
const runtime = new Miniflare(convertV4MiniflareOptions({ modules: true, script: bundle.outputFiles[0].text, compatibilityDate: '2026-10-08', d1Databases: { DB: 'source' },
  bindings: { PUBLIC_ORIGIN: origin, WORKSPACE_SLUG: 'alice', ARTIFACTS_NAMESPACE: 'source-proof', ACCOUNT_ID: 'a'.repeat(32) },
  outboundService: async request => {
    const url = new URL(request.url);
    if (url.hostname === 'fixture.invalid') {
      const [, kind, hash] = url.pathname.split('/'), run = args => spawnSync('git', ['--git-dir', directory, ...args], { env: gitEnv, maxBuffer: 1 << 28 });
      if (!/^[0-9a-f]{40}$/.test(hash)) return new Response('bad', { status: 400 });
      if (kind === 'blob') { const r = run(['cat-file', 'blob', hash]); return r.status ? new Response('missing', { status: 404 }) : new Response(r.stdout); }
      if (kind === 'tree') {
        const r = run(['ls-tree', '-z', hash]);
        if (r.status) return new Response('missing', { status: 404 });
        return Response.json(r.stdout.toString().split('\0').filter(Boolean).map(line => { const [mode, , id] = line.slice(0, line.indexOf('\t')).split(' '); return { name: line.slice(line.indexOf('\t') + 1), type: types[mode], hash: id, mode }; }));
      }
      const r = run(['cat-file', 'commit', hash]);
      if (r.status) return new Response('missing', { status: 404 });
      const body = r.stdout.toString(), split = body.indexOf('\n\n'), headers = body.slice(0, split).split('\n'), author = /^author (.*) <.*> (\d+) [+-]\d{4}$/.exec(headers.find(line => line.startsWith('author ')));
      return Response.json({ hash, treeHash: headers[0].slice(5), parents: headers.filter(line => line.startsWith('parent ')).map(line => line.slice(7)), message: body.slice(split + 2), author: { name: author[1] }, authoredAt: Number(author[2]) });
    }
    assert.equal(url.pathname.split('/').slice(0, 4).join('/'), '/git/source-proof/repo-11111111111111111111111111111111.git'); assert.equal(request.headers.get('Authorization'), 'Bearer local-only-token');
    if (request.method === 'GET' && url.pathname.endsWith('/info/refs') && url.search === '?service=git-upload-pack')
      return new Response(Buffer.concat([packetLine('# service=git-upload-pack\n'), Buffer.from('0000'), execFileSync('git', ['upload-pack', '--stateless-rpc', '--advertise-refs', directory], { env: gitEnv })]), { headers: { 'Content-Type': 'application/x-git-upload-pack-advertisement' } });
    assert.equal(request.method, 'POST'); assert.ok(url.pathname.endsWith('/git-receive-pack')); assert.equal(request.headers.get('Content-Type'), 'application/x-git-receive-pack-request'); pushes++;
    const received = spawnSync('git', ['receive-pack', '--stateless-rpc', directory], { env: gitEnv, input: Buffer.from(await request.arrayBuffer()) });
    return new Response(received.stdout, { headers: { 'Content-Type': 'application/x-git-receive-pack-result' } });
  } }));
try {
  const db = await runtime.getD1Database('DB');
  for (const sql of (await readFile(new URL('./schema.sql', import.meta.url), 'utf8')).replace(/--[^\n]*/g, '').split(/;\s*(?=CREATE\b)/).filter(s => s.trim())) await db.prepare(sql).run();
  await db.prepare("INSERT INTO users(id,login,email,full_name) VALUES(1,'alice','alice@example.com','Alice Example'),(2,'bob','bob@example.com','')").run();
  await db.prepare("INSERT INTO workspaces(slug,artifact_namespace) VALUES('alice','source-proof')").run();
  await db.prepare("INSERT INTO repositories(id,name,description,artifact_name,creator_id,creation_key,input_hash,state,created_at) VALUES(1,'project','','repo-11111111111111111111111111111111',1,'original','hash','ACTIVE','2026-10-14T00:00:00Z')").run();
  await db.prepare("INSERT INTO grants VALUES(1,1,'admin'),(1,2,'read')").run();
  const repository = { owner: 'alice', name: 'project' };
  const call = async (action, body, { person = 'alice', status = 200, scope } = {}) => {
    const response = await runtime.dispatchFetch(origin + (scope ? '/fixture/scoped/' : '/native/source/') + action, { method: 'POST', body: JSON.stringify({ repository, ...body }),
      headers: { 'Content-Type': 'application/json', 'Connect-Protocol-Version': '1', 'X-Golf-Native-Access-Email': person + '@example.com', Origin: origin, ...(scope ? { 'X-Fixture-Scope': JSON.stringify(scope) } : {}) } });
    const value = await response.json();
    assert.equal(response.status, status, JSON.stringify(value)); return value;
  };
  const fsck = () => git(['fsck', '--strict', '--full', '--no-dangling']);

  // A root commit in the empty repository, then edits, a delete, a move, an executable, a symlink and binary content.
  const first = await call('commit', { branch: 'main', expectedHead: '', message: 'Initial', changes: [{ path: 'README.md', content: '# Project\n' }, { path: 'src/app.js', content: 'one\n' }, { path: 'src/lib/util.js', content: 'util\n' }, { path: 'docs/guide.md', content: 'guide\n' }] });
  assert.equal(head('main'), first.commitId); assert.equal(text(['rev-parse', 'main^{tree}']), first.treeId); assert.equal(text(['rev-list', '--count', 'main']), '1');
  assert.equal(first.treeId, text(['mktree'], ''.concat(...[['README.md', '# Project\n']].map(([n, c]) => `100644 blob ${text(['hash-object', '--stdin'], c)}\t${n}\n`), `040000 tree ${text(['rev-parse', 'main:docs'])}\tdocs\n`, `040000 tree ${text(['rev-parse', 'main:src'])}\tsrc\n`)));
  const binary = Buffer.from([0, 159, 146, 150, 255]), edits = [{ path: 'README.md', content: '# Project\n\nMore.\n' }, { path: 'src/lib/util.js', delete: true }, { path: 'docs/manual.md', from: 'docs/guide.md' },
    { path: 'bin/run', content: '#!/bin/sh\necho run\n', mode: 'executable' }, { path: 'assets/logo.bin', contentBase64: binary.toString('base64') }, { path: 'latest', content: 'README.md', mode: 'symlink' }];
  const second = await call('commit', { branch: 'main', expectedHead: first.commitId, message: 'Edit everything\n\nWith a body.', changes: edits });
  const expected = gitTree(first.commitId, [{ path: 'README.md', content: '# Project\n\nMore.\n' }, { path: 'src/lib/util.js', delete: true }, { path: 'docs/guide.md', delete: true }, { path: 'docs/manual.md', content: 'guide\n' },
    { path: 'bin/run', content: '#!/bin/sh\necho run\n', mode: 'executable' }, { path: 'assets/logo.bin', content: binary }, { path: 'latest', content: 'README.md', mode: 'symlink' }]);
  assert.equal(second.treeId, expected); assert.equal(text(['rev-parse', 'main^{tree}']), expected); assert.equal(text(['rev-parse', 'main^']), first.commitId);
  assert.deepEqual(git(['cat-file', 'blob', 'main:assets/logo.bin']), binary); assert.equal(text(['ls-tree', 'main', 'bin/run']).split(' ')[0], '100755'); assert.equal(text(['ls-tree', 'main', 'latest']).split(' ')[0], '120000');
  assert.equal(text(['log', '-1', '--format=%an <%ae>|%cn <%ce>|%B', 'main']), 'Alice Example <alice@example.com>|Alice Example <alice@example.com>|Edit everything\n\nWith a body.');
  fsck();

  // Stale heads: fail by default; merge disjoint paths; overlapping paths list their conflicts.
  const moved = await call('commit', { branch: 'main', expectedHead: second.commitId, message: 'Moved', changes: [{ path: 'src/app.js', content: 'two\n' }] });
  const stale = { branch: 'main', expectedHead: second.commitId, message: 'Mine', changes: [{ path: 'docs/manual.md', content: 'manual\n' }] };
  assert.equal((await call('commit', stale, { status: 409 })).currentHead, moved.commitId);
  const merged = await call('commit', { ...stale, onStale: 'merge' });
  assert.equal(merged.merged, true); assert.equal(text(['rev-parse', 'main^']), moved.commitId);
  assert.equal(text(['show', 'main:src/app.js']), 'two'); assert.equal(text(['show', 'main:docs/manual.md']), 'manual');
  assert.equal(merged.treeId, gitTree(moved.commitId, [{ path: 'docs/manual.md', content: 'manual\n' }]));
  const clash = await call('commit', { branch: 'main', expectedHead: second.commitId, message: 'Clash', onStale: 'merge', changes: [{ path: 'src/app.js', content: 'three\n' }] }, { status: 409 });
  assert.deepEqual(clash.conflicts, [{ path: 'src/app.js', reason: 'both_modified' }]); assert.equal(clash.currentHead, merged.commitId); assert.equal(head('main'), merged.commitId);
  fsck();

  // Idempotent replay: one push, the original response; different inputs are refused.
  const idempotencyKey = crypto.randomUUID(), once = { branch: 'main', expectedHead: merged.commitId, message: 'Once', idempotencyKey, changes: [{ path: 'once.txt', content: 'once\n' }] };
  const original = await call('commit', once), sent = pushes;
  assert.deepEqual(await call('commit', once), original); assert.equal(pushes, sent);
  assert.equal((await call('commit', { ...once, message: 'Twice' }, { status: 409 })).code, 'already_exists');

  // Branches: from a branch name and a commit, through the same fence; create sends an empty pack, delete none.
  const feature = await call('commit', { branch: 'agent/demo', expectedHead: '', base: 'main', message: 'Agent work', changes: [{ path: 'agent.txt', content: 'agent\n' }] });
  assert.equal(text(['rev-parse', 'agent/demo^']), original.commitId);
  assert.equal((await call('branch', { branch: 'release', action: 'create', from: 'main' })).commitId, original.commitId); assert.equal(head('release'), original.commitId);
  assert.equal((await call('branch', { branch: 'old', action: 'create', from: first.commitId })).commitId, first.commitId); assert.equal(head('old'), first.commitId);
  assert.equal((await call('branch', { branch: 'old', action: 'delete', expectedHead: second.commitId }, { status: 409 })).currentHead, first.commitId);
  assert.equal((await call('branch', { branch: 'old', action: 'delete', expectedHead: first.commitId })).previousHead, first.commitId); assert.equal(head('old'), '');
  assert.equal((await call('branch', { branch: 'main', action: 'delete', expectedHead: original.commitId }, { status: 412 })).code, 'failed_precondition');
  fsck();

  // Reads: files by branch with text, binary, missing and directory results; trees equal git ls-tree.
  const files = await call('files', { ref: 'main', paths: ['README.md', 'assets/logo.bin', 'missing.txt', 'src', 'bin/run'] }, { person: 'bob' });
  assert.equal(files.commitId, original.commitId);
  assert.deepEqual(files.files.map(file => file.content ?? file.contentBase64 ?? file.skipped), ['# Project\n\nMore.\n', binary.toString('base64'), 'missing', 'directory', '#!/bin/sh\necho run\n']);
  assert.equal(files.files[4].mode, '100755');
  const listed = await call('tree', { ref: feature.commitId }, { person: 'bob' });
  assert.deepEqual(listed.entries.map(entry => `${entry.mode} ${entry.sha} ${entry.path}`), text(['ls-tree', '-r', '-t', '--format=%(objectmode) %(objectname) %(path)', 'agent/demo']).split('\n').sort((a, b) => a.split(' ')[2] < b.split(' ')[2] ? -1 : 1));
  assert.equal(listed.truncated, false);
  assert.equal((await call('commit', { branch: 'main', expectedHead: original.commitId, message: 'x', changes: [{ path: 'a', content: 'a' }] }, { person: 'bob', status: 403 })).code, 'permission_denied');

  // Token scope (AM-3 contract): repository list, read-only and branch pattern refuse before any write; inside the scope it commits.
  const before = pushes;
  assert.match((await call('files', { paths: ['README.md'] }, { scope: { repositories: ['2'], permission: 'write', branchPattern: '' }, status: 403 })).message, /does not include this repository/);
  assert.match((await call('commit', { branch: 'agent/demo', expectedHead: feature.commitId, message: 'x', changes: [{ path: 'a', content: 'a' }] }, { scope: { repositories: null, permission: 'read', branchPattern: '' }, status: 403 })).message, /read-only/);
  assert.match((await call('commit', { branch: 'main', expectedHead: original.commitId, message: 'x', changes: [{ path: 'a', content: 'a' }] }, { scope: { repositories: ['1'], permission: 'write', branchPattern: 'agent/*' }, status: 403 })).message, /agent\/\*/);
  assert.equal((await call('branch', { branch: 'main2', action: 'create', from: 'main' }, { scope: { repositories: ['1'], permission: 'write', branchPattern: 'agent/*' }, status: 403 })).code, 'permission_denied');
  assert.equal(pushes, before);
  const scoped = await call('commit', { branch: 'agent/demo', expectedHead: feature.commitId, message: 'Scoped', changes: [{ path: 'scoped.txt', content: 'ok\n' }] }, { scope: { repositories: ['1'], permission: 'write', branchPattern: 'agent/*' } });
  assert.equal(head('agent/demo'), scoped.commitId);
  assert.equal((await call('files', { ref: 'agent/demo', paths: ['scoped.txt'] }, { scope: { repositories: ['1'], permission: 'read', branchPattern: '' } })).files[0].content, 'ok\n');

  // Real D1 holds a settled journal: every write APPLIED, no fence or repository hold left.
  const operations = (await db.prepare('SELECT state,ref,new_sha FROM git_operations ORDER BY created_at').all()).results;
  assert.equal(operations.length, pushes); assert.ok(operations.every(row => row.state === 'APPLIED'));
  assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM git_ref_writes').first()).n, 0);
  assert.equal((await db.prepare('SELECT write_pending FROM repositories').first()).write_pending, null);
  assert.equal((await db.prepare('SELECT operation_id FROM source_commits WHERE idempotency_key=?').bind(idempotencyKey).first()).operation_id !== null, true);
  fsck();
  console.log(`Real workerd/D1 Source API: ${pushes} commits and branch updates built in workerd, received by git receive-pack and fsck-clean; trees equal Git's own index, stale/merge/conflict, idempotent replay, reads and scope refusals passed`);
} finally { await runtime.dispose(); rmSync(root, { recursive: true, force: true }); }
