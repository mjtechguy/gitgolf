// Source API blame and grep (docs/SOURCE_API.md, AM-6) over node:sqlite as D1 and a real bare Git repository as the provider. History is
// written by git itself (commit-tree, fast-import) with real authors and dates, and every answer is compared with Git's own:
// `git blame --first-parent` (as --line-porcelain, which is -s -l with full boundary IDs) and `git grep -n --column -I`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { digest, handle, serialize, admission, withArtifact } from './src/core.mjs';
import { packetLine } from './src/git.mjs';
import { sourceAPI } from './src/source-api.mjs';
import { readLimits } from './src/source-reads.mjs';
import { lineMatches, splitLines } from './src/line-diff.mjs';
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
      bind(...args) { values = args; return this; },
      async first() { return statement.get(...values) || null; },
      async all() { return { results: statement.all(...values) }; },
      async run() { return { meta: { changes: statement.run(...values).changes } }; },
    }; },
    async batch(statements) { const results = []; for (const statement of statements) results.push(await statement.run()); return results; },
  };
  const git = (args, input) => spawnSync('git', ['--git-dir', g.directory, ...args], { env: g.env, input, maxBuffer: 1 << 28 });
  const reads = { blob: 0, commit: 0, log: 0 };
  const readCommit = hash => {
    const read = git(['cat-file', 'commit', hash]);
    if (read.status) return null;
    const body = read.stdout.toString(), split = body.indexOf('\n\n'), headers = body.slice(0, split).split('\n'), author = /^author (.*) <.*> (\d+) [+-]\d{4}$/.exec(headers.find(line => line.startsWith('author ')));
    return { hash, treeHash: headers[0].slice(5), parents: headers.filter(line => line.startsWith('parent ')).map(line => line.slice(7)), message: body.slice(split + 2), author: { name: author[1] }, authoredAt: Number(author[2]) };
  };
  const env = { DB: db, ACCOUNT_ID: 'c'.repeat(32), ARTIFACTS_NAMESPACE: 'test-space', WORKSPACE_SLUG: 'alice', PUBLIC_ORIGIN: origin, gitObjectCache: { objects: new Map(), pending: new Map(), bytes: 0 },
    ARTIFACTS: { async get(name) { assert.equal(name, artifact); return {
      async info() { return { name, remote: `https://${env.ACCOUNT_ID}.artifacts.cloudflare.net/git/test-space/${name}.git` }; },
      async createToken() { return { plaintext: 'art_v1_local' }; }, async revokeToken() { return true; }, [Symbol.dispose]() {},
      async readCommit(hash) { reads.commit++; return readCommit(hash); },
      async log({ ref, limit = 50 }) {
        reads.log++;
        const listed = git(['rev-list', '--first-parent', `--max-count=${limit}`, ref]);
        return listed.status ? [] : listed.stdout.toString().trim().split('\n').filter(Boolean).map(readCommit);
      },
      async readTree(hash) {
        const listed = git(['ls-tree', '-z', hash]);
        if (listed.status) return null;
        return listed.stdout.toString().split('\0').filter(Boolean).map(line => { const [mode, , id] = line.slice(0, line.indexOf('\t')).split(' '); return { name: line.slice(line.indexOf('\t') + 1), type: types[mode], hash: id, mode }; });
      },
      async readBlob(hash) { reads.blob++; const read = git(['cat-file', 'blob', hash]); return read.status ? null : new Blob([read.stdout]); },
    }; } } };
  const providerFetch = async url => {
    assert.ok(url.startsWith(`https://${env.ACCOUNT_ID}.artifacts.cloudflare.net/git/test-space/${artifact}.git/`));
    const advertised = spawnSync('git', ['upload-pack', '--stateless-rpc', '--advertise-refs', g.directory], { env: g.env }).stdout;
    return new Response(Buffer.concat([packetLine('# service=git-upload-pack\n'), Buffer.from('0000'), advertised]), { headers: { 'Content-Type': 'application/x-git-upload-pack-advertisement' } });
  };
  const dispatch = serialize(request => handle(request, env, providerFetch), admission);
  const call = async (action, body, token = tokens.alice) => {
    const response = await dispatch(new Request(origin + '/native/source/' + action, { method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json', 'Connect-Protocol-Version': '1' }, body: JSON.stringify({ repository: key, ...body }) }));
    return { status: response.status, body: await response.json() };
  };
  const ok = async (action, body, token) => { const result = await call(action, body, token); assert.equal(result.status, 200, JSON.stringify(result.body)); return result.body; };
  const mcp = async (name, args, token = tokens.alice) => {
    const response = await dispatch(new Request(origin + '/mcp', { method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: { ...key, ...args } } }) }));
    return (await response.json()).result;
  };
  const row = () => ({ ...sql.prepare("SELECT r.*,g.role,COALESCE((SELECT version FROM repository_access_versions WHERE repository_id=r.id),0) AS access_version FROM repositories r JOIN grants g ON g.repository_id=r.id WHERE r.id=1 AND g.user_id=1").get() });
  const direct = (action, body, person) => sourceAPI(db, env, { ...sql.prepare('SELECT * FROM users WHERE id=1').get(), identity_version: 0, ...person }, row(), action, { repository: key, ...body },
    { withArtifact, providerFetch, literalPath: value => value, ciState: 'NONE' });
  // A commit written by git: files {path: content | null (delete) | {content, mode}} applied to the parent's tree by git's own index.
  let clock = 1700000000;
  const commit = (parents, files, { author = 'Alice', message = 'Change', ref } = {}) => {
    const ops = Object.entries(files).map(([path, value]) => value === null ? { path, delete: true } : typeof value === 'string' ? { path, content: value } : { path, ...value });
    const tree = g.edit(parents[0] || null, ops), time = `${clock += 3600} +0000`;
    const id = g.text(['commit-tree', tree, ...parents.flatMap(parent => ['-p', parent]), '-m', message], undefined, { GIT_AUTHOR_NAME: author, GIT_AUTHOR_EMAIL: author.toLowerCase() + '@example.invalid', GIT_AUTHOR_DATE: time, GIT_COMMITTER_DATE: time });
    if (ref) g.run(['update-ref', 'refs/heads/' + ref, id]);
    return id;
  };
  return { g, git, env, reads, call, ok, mcp, direct, commit, dispatch };
}

// Git's blame as one commit ID per line (porcelain carries full IDs, including boundary commits).
const gitBlame = (f, rev, path, range = []) => {
  const out = f.git(['blame', '--first-parent', '--line-porcelain', ...range, rev, '--', path]);
  assert.equal(out.status, 0, out.stderr.toString());
  return out.stdout.toString().split('\n').filter(line => /^[0-9a-f]{40} \d+ \d+/.test(line)).map(line => line.slice(0, 40));
};
const perLine = result => result.ranges.flatMap(range => Array.from({ length: range.end - range.start + 1 }, () => range.commitId));
// Git's grep as {path, line, column, text}; files over 1 MiB are dropped (Golf skips them; git searches them).
const gitGrep = (f, rev, args, pathspec = [], large = []) => {
  const out = f.git(['grep', '-n', '--column', '-I', ...args, rev, '--', ...pathspec]);
  assert.ok(out.status === 0 || out.status === 1, out.stderr.toString());
  return out.stdout.toString().split('\n').filter(Boolean).map(line => {
    const [, path, number, column, text] = /^[^:]+:([^:]+):(\d+):(\d+):(.*)$/s.exec(line);
    return { path, line: Number(number), column: Number(column), text: text.slice(0, 400) };
  }).filter(match => !large.includes(match.path));
};

const program = lines => lines.join('\n') + '\n';
const base = ['import { start } from "./start.js";', '', 'export function main(options) {', '  const value = options.value;', '  if (!value) {', '    return null;', '  }', '  return start(value);', '}', '', 'export const version = 1;', 'export default main;'];

test('blame equals git blame --first-parent across edits, inserts, deletes, a merge, repeated lines and a missing final newline', { skip: !gitAvailable }, async t => {
  const f = await fixture(t);
  const c1 = f.commit([], { 'src/app.js': program(base), 'README.md': '# Project\n' }, { author: 'Alice', message: 'Initial\n\nBody.' });
  const v2 = base.slice(); v2[3] = '  const value = options.value ?? options.fallback;'; v2.splice(6, 0, '    // nothing to start', '    // without a value');
  const c2 = f.commit([c1], { 'src/app.js': program(v2) }, { author: 'Bob', message: 'Fallback value' });
  const c3 = f.commit([c2], { 'README.md': '# Project\n\nUsage.\n' }, { author: 'Carol', message: 'Docs only' });
  const v4 = v2.slice(); v4.splice(9, 1); v4[0] = 'import { start, stop } from "./start.js";';
  const c4 = f.commit([c3], { 'src/app.js': program(v4) }, { author: 'Alice', message: 'Import stop' });
  // A side branch changes the last line; the merge brings it to main (blamed on the merge: first parent only).
  const side = v2.slice(); side[side.length - 1] = 'export default { main };';
  const s1 = f.commit([c3], { 'src/app.js': program(side) }, { author: 'Dana', message: 'Default object', ref: 'side' });
  const merged = v4.slice(); merged[merged.length - 1] = 'export default { main };';
  const m = f.commit([c4, s1], { 'src/app.js': program(merged) }, { author: 'Alice', message: 'Merge side' });
  // A new function between existing ones: the inserted braces and blank lines are ambiguous; Git's indent heuristic places them.
  const v6 = merged.slice(); v6.splice(9, 0, '', 'export function stopAll() {', '  return stop();', '}');
  const c6 = f.commit([m], { 'src/app.js': program(v6) }, { author: 'Erin', message: 'Stop all' });
  const c7 = f.commit([c6], { 'src/app.js': program(v6).slice(0, -1) + ' // end' }, { author: 'Bob', message: 'No final newline', ref: 'main' });

  const whole = await f.ok('blame', { path: 'src/app.js' });
  assert.equal(whole.commitId, c7); assert.equal(whole.complete, true); assert.equal(whole.reason, undefined);
  assert.deepEqual(perLine(whole), gitBlame(f, 'main', 'src/app.js'));
  assert.equal(whole.lineCount, v6.length); assert.deepEqual([whole.startLine, whole.endLine], [1, v6.length]);
  // Every commit that owns a line is described once, with its author, date and summary.
  const described = new Map(whole.commits.map(c => [c.commitId, c]));
  assert.deepEqual([...described.keys()].sort(), [...new Set(perLine(whole))].sort());
  assert.deepEqual(described.get(c1), { commitId: c1, author: 'Alice', authoredAt: new Date((1700000000 + 3600) * 1000).toISOString(), summary: 'Initial' });
  assert.ok(!described.has(s1));
  // At the merge, the side branch's line belongs to the merge commit, not to the side commit that wrote it.
  const atMerge = await f.ok('blame', { path: 'src/app.js', ref: m });
  assert.deepEqual(perLine(atMerge), gitBlame(f, m, 'src/app.js'));
  assert.deepEqual([atMerge.ranges.at(-1), atMerge.commits.find(c => c.commitId === m).summary], [{ start: merged.length, end: merged.length, commitId: m }, 'Merge side']);
  // Ranges are maximal runs of one commit.
  for (let i = 1; i < whole.ranges.length; i++) assert.ok(whole.ranges[i].commitId !== whole.ranges[i - 1].commitId || whole.ranges[i].start !== whole.ranges[i - 1].end + 1);
  // Line ranges, an older commit by ID, a branch and the README.
  const part = await f.ok('blame', { path: 'src/app.js', startLine: 3, endLine: 9 });
  assert.deepEqual(perLine(part), gitBlame(f, 'main', 'src/app.js', ['-L', '3,9'])); assert.deepEqual([part.startLine, part.endLine], [3, 9]);
  assert.deepEqual(perLine(await f.ok('blame', { path: 'src/app.js', startLine: 12, endLine: 999 })), gitBlame(f, 'main', 'src/app.js', ['-L', '12,' + v6.length]));
  assert.deepEqual(perLine(await f.ok('blame', { path: 'src/app.js', ref: c2 })), gitBlame(f, c2, 'src/app.js'));
  assert.deepEqual(perLine(await f.ok('blame', { path: 'src/app.js', ref: 'side' })), gitBlame(f, 'side', 'src/app.js'));
  assert.deepEqual(perLine(await f.ok('blame', { path: 'README.md' })), gitBlame(f, 'main', 'README.md'));
  // Readers blame too.
  assert.deepEqual((await f.ok('blame', { path: 'README.md' }, tokens.carol)).ranges, (await f.ok('blame', { path: 'README.md' })).ranges);

  // A rename is not followed: every line belongs to the renaming commit (git blame follows the rename to its history).
  const c8 = f.commit([c7], { 'src/app.js': null, 'src/main.js': program(v6).slice(0, -1) + ' // end' }, { author: 'Bob', message: 'Rename', ref: 'main' });
  const renamed = await f.ok('blame', { path: 'src/main.js' });
  assert.deepEqual(renamed.ranges, [{ start: 1, end: v6.length, commitId: c8 }]); assert.equal(renamed.complete, true); assert.equal(renamed.examinedCommits, 1);
  assert.notDeepEqual(gitBlame(f, 'main', 'src/main.js'), perLine(renamed));
});

test('the line diff marks the same lines unchanged as git blame on ambiguous edits, a long common tail and large rewrites', { skip: !gitAvailable }, async t => {
  const f = await fixture(t);
  let seed = 11;
  const random = n => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };
  const words = ['a\n', 'b\n', '\n', '}\n', '  x\n', '\tdef\n', 'c'], cases = [];
  for (let i = 0; i < 60; i++) {
    const older = Array.from({ length: random(16) }, () => words[random(words.length - 1)]), newer = older.slice();
    for (let e = random(5); e >= 0; e--) { const at = random(newer.length + 1), op = random(3); if (op === 0) newer.splice(at, 0, words[random(words.length - 1)]); else if (op === 1) newer.splice(at, 1); else newer[at] = words[random(words.length - 1)]; }
    cases.push([older.join(''), newer.join('') + (i % 7 === 0 ? 'c' : '')]);
  }
  // Over 1 KiB of identical tail (Git trims it before diffing), and a 3,000-line rewrite that crosses xdiff's cost cut-offs.
  const tail = Array.from({ length: 200 }, (_, i) => `tail line ${i}\n`).join('');
  cases.push(['x\n}\n\ny\n}\n' + tail, 'x\n}\n\nz\n}\n\ny\n}\n' + tail]);
  const lines = n => Array.from({ length: n }, () => random(3) ? `line ${random(4000)}\n` : words[random(5)]).join('');
  cases.push([lines(3000), lines(3000)]);
  for (const [older, newer] of cases) {
    const parent = f.commit([], { f: older }), child = f.commit([parent], { f: newer });
    const expected = splitLines(newer).length ? gitBlame(f, `${parent}..${child}`, 'f').map(id => id === child ? -1 : 0) : [];
    assert.deepEqual([...lineMatches(older, newer).map].map(i => i < 0 ? -1 : 0), expected, JSON.stringify([older, newer]).slice(0, 300));
  }
});

test('blame stops at 500 commits or 4 MiB of versions with complete: false, as git blame does at that boundary', { skip: !gitAvailable }, async t => {
  const f = await fixture(t);
  // 505 commits by fast-import: lines 1-9 never change after the first commit; line 10 changes in every commit.
  const head = Array.from({ length: 9 }, (_, i) => `stable ${i}`), stream = [];
  for (let i = 1; i <= 505; i++) {
    const content = [...head, `changed in ${i}`].join('\n') + '\n';
    stream.push(`commit refs/heads/long\nmark :${i}\nauthor Fixture <f@example.invalid> ${1700000000 + i} +0000\ncommitter Fixture <f@example.invalid> ${1700000000 + i} +0000\ndata ${`Commit ${i}`.length}\nCommit ${i}\n`,
      ...(i > 1 ? [`from :${i - 1}\n`] : []), `M 100644 inline f.txt\ndata ${Buffer.byteLength(content)}\n${content}\n`);
  }
  assert.equal(f.git(['fast-import', '--quiet'], stream.join('')).status, 0);
  const tip = f.git(['rev-parse', 'long']).stdout.toString().trim(), boundary = f.git(['rev-parse', 'long~500']).stdout.toString().trim();
  const bounded = await f.ok('blame', { path: 'f.txt', ref: 'long' });
  assert.deepEqual([bounded.complete, bounded.reason, bounded.examinedCommits], [false, 'history_bound', 500]);
  assert.deepEqual(bounded.ranges, [{ start: 1, end: 9, commitId: boundary }, { start: 10, end: 10, commitId: tip }]);
  assert.deepEqual(perLine(bounded), gitBlame(f, `${boundary}..long`, 'f.txt'));
  // Only the last line: resolved by the first comparison.
  const last = await f.ok('blame', { path: 'f.txt', ref: 'long', startLine: 10 });
  assert.deepEqual([last.complete, last.examinedCommits, last.ranges], [true, 1, [{ start: 10, end: 10, commitId: tip }]]);
  // The provider's log pages history: 500 commits took a handful of log calls, not one read per commit.
  assert.ok(f.reads.log <= 10, String(f.reads.log));

  // A 900 KiB file changed in five commits: the head and three older versions fit in 4 MiB; the fourth does not.
  const big = Array.from({ length: 9000 }, (_, i) => `row ${String(i).padStart(5, '0')} ${'.'.repeat(88)}`);
  let id = f.commit([], { 'big.txt': big.join('\n') + '\n' }, { message: 'Big' });
  const chain = [id];
  for (let i = 1; i <= 5; i++) { big[i * 100] = `edited ${i}`; chain.push(id = f.commit([id], { 'big.txt': big.join('\n') + '\n' }, { message: 'Edit ' + i, ref: 'big' })); }
  const read = await f.ok('blame', { path: 'big.txt', ref: 'big' });
  assert.deepEqual([read.complete, read.reason, read.examinedCommits], [false, 'read_bound', 3]);
  assert.deepEqual(perLine(read), gitBlame(f, `${chain[2]}..big`, 'big.txt'));
});

test('blame refuses binary, oversized, directory and missing paths, and bad line ranges', { skip: !gitAvailable }, async t => {
  const f = await fixture(t);
  f.commit([], { 'bin.dat': { content: Buffer.from([1, 2, 0, 3]) }, 'huge.txt': 'x'.repeat(1024 * 1024 + 1), 'src/a.js': 'a\nb\n', 'empty.txt': '' }, { ref: 'main' });
  const refused = async (body, status, pattern) => { const result = await f.call('blame', body); assert.equal(result.status, status, JSON.stringify(result.body)); assert.match(result.body.message, pattern); return result.body; };
  assert.equal((await refused({ path: 'bin.dat' }, 400, /binary/)).reason, 'binary');
  assert.equal((await refused({ path: 'huge.txt' }, 413, /1 MiB/)).code, 'resource_exhausted');
  await refused({ path: 'src' }, 400, /directory/);
  await refused({ path: 'nope.txt' }, 404, /does not exist/);
  await refused({ path: 'src/a.js', startLine: 3 }, 400, /past the end of the file \(2 lines\)/);
  await refused({ path: 'src/a.js', startLine: 2, endLine: 1 }, 400, /before startLine/);
  await refused({ path: 'src/a.js', startLine: 0 }, 400, /line number/);
  await refused({ path: 'src/a.js', ref: 'nope' }, 404, /ref/);
  const empty = await f.ok('blame', { path: 'empty.txt' });
  assert.deepEqual([empty.lineCount, empty.ranges, empty.complete], [0, [], true]);
});

// A tree with text, executable, binary, oversized, symlink, CRLF, no-final-newline and long-line files.
function grepTree(f) {
  return f.commit([], {
    'README.md': '# Project\nTODO: write the docs\n', 'docs/guide.md': 'Guide\ntodo later\nfoo foooo\n', 'docs/notes.txt': 'TODO one\nTODO two\n',
    'src/app.js': 'export function main() {\n  // TODO handle errors\n  return foo(1);\n}\nexport async function other() {}\n', 'src/lib/util.js': 'export const fooo = 1; // Todo\n',
    'src/lib/deep/x.ts': 'const a = "TODO";\n', 'bin/run': { content: '#!/bin/sh\necho TODO\n', mode: 'executable' }, 'assets/blob.bin': { content: Buffer.concat([Buffer.from('TODO'), Buffer.from([0, 1, 2])]) },
    'big.txt': 'TODO\n' + 'y'.repeat(1024 * 1024), 'link': { content: 'TODO.md', mode: 'symlink' }, 'crlf.txt': 'one\r\nTODO two\r\n', 'nonl.txt': 'last TODO',
    'long.txt': 'x'.repeat(500) + ' TODO ' + 'z'.repeat(100) + '\n',
  }, { ref: 'main' });
}

test('grep equals git grep for literal, case-insensitive and regular-expression searches, path globs and result limits', { skip: !gitAvailable }, async t => {
  const f = await fixture(t), id = grepTree(f), large = ['big.txt'];
  const same = async (body, args, pathspec = []) => {
    const result = await f.ok('grep', body), expected = gitGrep(f, 'main', args, pathspec, large);
    assert.deepEqual(result.matches, expected, JSON.stringify(body)); assert.ok(expected.length > 0 || body.expectNone, JSON.stringify(body));
    return result;
  };
  const literal = await same({ pattern: 'TODO' }, ['-F', '-e', 'TODO']);
  assert.equal(literal.commitId, id); assert.equal(literal.truncated, false); assert.equal(literal.reason, undefined);
  assert.deepEqual(literal.skipped, { binary: 1, tooLarge: 1 }); assert.equal(literal.filesSearched, 10);
  // Symlinks are not searched; long lines are cut to 400 characters; CRLF lines keep their \r as git prints them.
  assert.ok(!literal.matches.some(m => m.path === 'link')); assert.equal(literal.matches.find(m => m.path === 'long.txt').text.length, 400);
  assert.equal(literal.matches.find(m => m.path === 'crlf.txt').text, 'TODO two\r');
  await same({ pattern: 'todo', caseSensitive: false }, ['-i', '-F', '-e', 'todo']);
  await same({ pattern: 'fo+\\b', regex: true }, ['-P', '-e', 'fo+\\b']);
  await same({ pattern: '^export (async )?function', regex: true }, ['-P', '-e', '^export (async )?function']);
  await same({ pattern: 'TODO|todo', regex: true, caseSensitive: true }, ['-P', '-e', 'TODO|todo']);
  await same({ pattern: 'T.D[O]', regex: true, caseSensitive: false }, ['-P', '-i', '-e', 'T.D[O]']);
  await same({ pattern: 'TODO', paths: ['src/**/*.js'] }, ['-F', '-e', 'TODO'], [':(glob)src/**/*.js']);
  await same({ pattern: 'TODO', paths: ['docs'] }, ['-F', '-e', 'TODO'], ['docs']);
  await same({ pattern: 'TODO', paths: ['*.md', 'src/lib/**'] }, ['-F', '-e', 'TODO'], [':(glob)*.md', ':(glob)src/lib/**']);
  await same({ pattern: 'TODO', paths: ['src/*/*.js', 'bin/ru?'] }, ['-F', '-e', 'TODO'], [':(glob)src/*/*.js', ':(glob)bin/ru?']);
  await same({ pattern: 'TODO', ref: id }, ['-F', '-e', 'TODO']);
  assert.deepEqual((await f.ok('grep', { pattern: 'no such text anywhere' })).matches, []);
  // maxResults: the first results in path and line order, and truncated only when more exist.
  const all = gitGrep(f, 'main', ['-F', '-e', 'TODO'], [], large);
  const two = await f.ok('grep', { pattern: 'TODO', maxResults: 2 });
  assert.deepEqual([two.matches, two.truncated, two.reason], [all.slice(0, 2), true, 'max_results']);
  const exact = await f.ok('grep', { pattern: 'TODO', maxResults: all.length });
  assert.deepEqual([exact.matches.length, exact.truncated], [all.length, false]);
  // Readers search too; MCP and the route agree.
  assert.deepEqual((await f.ok('grep', { pattern: 'TODO' }, tokens.carol)).matches, all);
});

test('grep refuses unsafe or invalid patterns and bad arguments before reading', { skip: !gitAvailable }, async t => {
  const f = await fixture(t);
  grepTree(f);
  const refused = async (body, pattern) => { const result = await f.call('grep', body); assert.equal(result.status, 400, JSON.stringify(result.body)); assert.match(result.body.message, pattern); return result.body; };
  for (const pattern of ['(a+)+$', '(\\w*x)*', '((ab)+c)+', '(a{2,})*', '(x+){3}', '(?:a|b+)+'])
    assert.equal((await refused({ pattern, regex: true }, /nested quantifier/)).reason, 'unsafe_regex', pattern);
  for (const pattern of ['(a)\\1', '(?<x>a)\\k<x>']) assert.equal((await refused({ pattern, regex: true }, /backreference/)).reason, 'unsafe_regex', pattern);
  // Quantified groups without an inner quantifier, optional groups and escaped parentheses are allowed.
  for (const pattern of ['(ab)+', '(a+)?', '\\(a+\\)+', '[(a+)]+', '(foo|bar)+', '(a{1})*']) assert.equal((await f.call('grep', { pattern, regex: true })).status, 200, pattern);
  await refused({ pattern: '(', regex: true }, /not valid/);
  await refused({ pattern: 'x'.repeat(201), regex: true }, /1 to 200 characters/);
  await refused({ pattern: 'x'.repeat(1001) }, /1 to 1000 characters/);
  await refused({ pattern: '' }, /1 to 1000/);
  await refused({ pattern: 'a\nb' }, /newline/);
  await refused({ pattern: 'a', regex: 'yes' }, /true or false/);
  await refused({ pattern: 'a', maxResults: 501 }, /1 to 500/);
  await refused({ pattern: 'a', paths: [] }, /1 to 20/);
  await refused({ pattern: 'a', paths: ['a\\b'] }, /backslash/);
});

test('grep stops at 5,000 files, 32 MiB, its tree bound and its time bound, says why, and answers a repeated search from the cache', { skip: !gitAvailable }, async t => {
  const f = await fixture(t);
  // 5,010 entries share one small blob; 40 share one blob just under 1 MiB. git's index writes them cheaply.
  const small = f.g.blob('small\n'), large = f.g.blob('L'.repeat(1_000_000) + '\n');
  const ops = [...Array.from({ length: 5010 }, (_, i) => ({ path: `many/f${String(i).padStart(4, '0')}.txt`, hash: small })), ...Array.from({ length: 40 }, (_, i) => ({ path: `heavy/h${String(i).padStart(2, '0')}.txt`, hash: large }))];
  const tree = f.g.edit(null, ops), id = f.g.text(['commit-tree', tree, '-m', 'many']);
  f.g.run(['update-ref', 'refs/heads/main', id]);
  const files = await f.ok('grep', { pattern: 'nothing', paths: ['many'] });
  assert.deepEqual([files.filesSearched, files.truncated, files.reason, files.matches], [5000, true, 'file_bound', []]);
  const before = f.reads.blob;
  const bytes = await f.ok('grep', { pattern: 'nothing', paths: ['heavy'] });
  assert.deepEqual([bytes.filesSearched, bytes.truncated, bytes.reason], [33, true, 'read_bound']);
  // The object cache served the shared blob: one provider read for 33 files.
  assert.ok(f.reads.blob - before <= 8, String(f.reads.blob - before));
  // The same search again is answered from the cache without reading a blob.
  const reads = f.reads.blob;
  assert.deepEqual(await f.ok('grep', { pattern: 'nothing', paths: ['heavy'] }), bytes); assert.equal(f.reads.blob, reads);
  const saved = { ...readLimits };
  t.after(() => Object.assign(readLimits, saved));
  readLimits.grepEntries = 10;
  assert.deepEqual(await f.ok('grep', { pattern: 'small', paths: ['many'], maxResults: 500 }).then(r => [r.truncated, r.reason, r.matches.length]), [true, 'tree_bound', 0]);
  Object.assign(readLimits, saved); readLimits.grepTime = -1;
  const timed = await f.ok('grep', { pattern: 'small again', paths: ['many'] });
  assert.deepEqual([timed.truncated, timed.reason, timed.filesSearched], [true, 'time_bound', 0]);
});

test('blame and grep are reads: admitted alongside reads, refused outside a token scope, and served to MCP read tools', { skip: !gitAvailable }, async t => {
  const f = await fixture(t);
  const at = (path, method = 'POST') => admission(new Request(origin + path, { method, ...(method === 'POST' ? { body: '' } : {}) }));
  assert.equal(at('/native/source/blame'), 'read'); assert.equal(at('/native/source/grep'), 'read');
  assert.equal(at('/native/source/grep', 'GET'), 'exclusive');
  const id = f.commit([], { 'src/app.js': 'one\nTODO two\n' }, { ref: 'main' });
  // A token scope that does not cover the repository refuses both before reading; one that covers it reads.
  for (const action of ['blame', 'grep']) {
    const body = action === 'blame' ? { path: 'src/app.js' } : { pattern: 'TODO' };
    await assert.rejects(f.direct(action, body, { token_scope: { repositories: ['2'], permission: 'read', branchPattern: '' } }), error => error.status === 403 && /does not include this repository/.test(error.message));
    assert.equal((await f.direct(action, body, { token_scope: { repositories: ['1'], permission: 'read', branchPattern: '' } })).commitId, id);
  }
  // No grant: the repository is not visible.
  assert.equal((await f.call('grep', { pattern: 'TODO' }, tokens.dave)).status, 404);
  // MCP read tools call the same routes.
  const grep = await f.mcp('grep', { pattern: 'todo', caseSensitive: false, paths: ['src'], ref: 'main' });
  assert.equal(grep.isError, undefined, JSON.stringify(grep));
  assert.deepEqual(JSON.parse(grep.content[0].text).matches, [{ path: 'src/app.js', line: 2, column: 1, text: 'TODO two' }]);
  const blamed = await f.mcp('blame', { path: 'src/app.js', startLine: 2, endLine: 2 });
  assert.equal(blamed.isError, undefined, JSON.stringify(blamed));
  assert.deepEqual(JSON.parse(blamed.content[0].text).ranges, [{ start: 2, end: 2, commitId: id }]);
  const unsafe = await f.mcp('grep', { pattern: '(a+)+', regex: true, ref: 'main' });
  assert.equal(unsafe.isError, true); assert.match(unsafe.content[0].text, /nested quantifier/);
  assert.match((await f.mcp('blame', { path: 'src/app.js', startLine: 0, ref: 'main' })).content[0].text, /startLine must be a whole number/);
});
