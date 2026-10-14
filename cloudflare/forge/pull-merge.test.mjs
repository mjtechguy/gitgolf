import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { inflateSync } from 'node:zlib';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mergeCommit, commitPack, receiveRequest, mergePlan } from './src/pull-merge.mjs';
import { packObjects } from './src/git-objects.mjs';
import { receiveCommand, receiveStatus, packetLine } from './src/git.mjs';

const identity = { name: 'Alice Example', email: 'alice@users.noreply.golf.example.com', time: 1700000000 };

test('merge commit bytes and identity match a fixed Git vector', async () => {
  // ID recorded from `git hash-object -t commit --stdin` over these exact bytes.
  const commit = await mergeCommit({ ...identity, tree: '4b825dc642cb6eb9a060e54bf8d69288fbee4904', parents: ['a'.repeat(40), 'b'.repeat(40)], message: 'Merge pull request #7 from feature into main\n' });
  assert.equal(new TextDecoder().decode(commit.body), `tree 4b825dc642cb6eb9a060e54bf8d69288fbee4904\nparent ${'a'.repeat(40)}\nparent ${'b'.repeat(40)}\n` +
    'author Alice Example <alice@users.noreply.golf.example.com> 1700000000 +0000\ncommitter Alice Example <alice@users.noreply.golf.example.com> 1700000000 +0000\n\nMerge pull request #7 from feature into main\n');
  assert.equal(commit.id, '8e102f262f382849b169aca65db9989992a7cd1c');
  assert.equal(commit.id, createHash('sha1').update(`commit ${commit.body.length}\0`).update(commit.body).digest('hex'));
});

test('one-commit pack has a v2 header, exact size varint, zlib body and SHA-1 trailer at every size class', async () => {
  for (const message of ['x\n', 'Merge\n', 'é'.repeat(900) + '\n', 'm'.repeat(6000) + '\n', 'z'.repeat(40000) + '\n']) {
    const commit = await mergeCommit({ ...identity, tree: 'f'.repeat(40), parents: ['a'.repeat(40), 'b'.repeat(40)], message });
    const pack = Buffer.from(await commitPack(commit.body));
    assert.equal(pack.subarray(0, 12).toString('hex'), '5041434b0000000200000001');
    assert.deepEqual(pack.subarray(-20), createHash('sha1').update(pack.subarray(0, -20)).digest());
    let offset = 12, byte = pack[offset++], size = byte & 15, shift = 4;
    assert.equal(byte >> 4 & 7, 1);
    while (byte & 0x80) { byte = pack[offset++]; size += (byte & 0x7f) * 2 ** shift; shift += 7; }
    assert.equal(size, commit.body.length);
    assert.deepEqual(inflateSync(pack.subarray(offset, -20)), Buffer.from(commit.body));
    const request = receiveRequest('a'.repeat(40), commit.id, 'refs/heads/main', pack);
    assert.deepEqual(receiveCommand(request), { old: 'a'.repeat(40), next: commit.id, ref: 'refs/heads/main', sideband: false });
  }
});

test('report-status is acknowledged only for an unpacked pack and this ref', () => {
  const reply = (...lines) => Buffer.concat([...lines.map(line => packetLine(line)), Buffer.from('0000')]);
  assert.equal(receiveStatus(reply('unpack ok\n', 'ok refs/heads/main\n'), 'refs/heads/main'), '');
  assert.equal(receiveStatus(reply('unpack ok\n', 'ok refs/heads/other\n'), 'refs/heads/main'), 'ok refs/heads/other');
  assert.equal(receiveStatus(reply('unpack ok\n', 'ng refs/heads/main non-fast-forward\n'), 'refs/heads/main'), 'ng refs/heads/main non-fast-forward');
  assert.equal(receiveStatus(reply('unpack index-pack abnormal exit\n', 'ng refs/heads/main unpacker error\n'), 'refs/heads/main'), 'unpack index-pack abnormal exit');
  assert.equal(receiveStatus(reply('unpack ok\n'), 'refs/heads/main'), 'no ref status');
  assert.equal(receiveStatus(Buffer.from('not a packet'), 'refs/heads/main'), 'unreadable status');
  assert.equal(receiveStatus(reply('unpack ok\n', 'ng refs/heads/main \x1b[31m' + 'x'.repeat(400) + '\n'), 'refs/heads/main').length, 160);
});

const available = spawnSync('git', ['--version']).status === 0;
test('real Git indexes, unpacks, verifies and receives the generated merge', { skip: !available && 'git is not installed' }, async t => {
  const root = mkdtempSync(join(tmpdir(), 'golf-native-merge-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const env = { PATH: process.env.PATH, HOME: root, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
    GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid', GIT_AUTHOR_DATE: '1699990000 +0000', GIT_COMMITTER_DATE: '1699990000 +0000' };
  const run = (directory, args, input) => execFileSync('git', ['--git-dir', directory, ...args], { env, input, stdio: ['pipe', 'pipe', 'pipe'] });
  const text = (...args) => run(...args).toString().trim();
  const repository = name => { const directory = join(root, name); execFileSync('git', ['init', '--bare', '--quiet', '--initial-branch=main', directory], { env }); return directory; };
  const origin = repository('origin.git');
  const tree = files => text(origin, ['mktree'], Object.entries(files).map(([name, content]) => `100644 blob ${text(origin, ['hash-object', '-w', '--stdin'], content)}\t${name}\n`).join(''));
  const base = text(origin, ['commit-tree', tree({ 'readme.txt': 'base\n' }), '-m', 'Base']);
  const headTree = tree({ 'readme.txt': 'base\n', 'feature.txt': 'change\n' });
  const head = text(origin, ['commit-tree', headTree, '-p', base, '-m', 'Feature']);
  run(origin, ['update-ref', 'refs/heads/main', base]); run(origin, ['update-ref', 'refs/heads/feature', head]);

  const commit = await mergeCommit({ ...identity, name: 'Zoë Example', tree: headTree, parents: [base, head], message: 'Merge pull request #1 from feature into main\n\nReviewed.\n' });
  const pack = await commitPack(commit.body);

  // The pack alone: indexed strictly and unpacked loose in two fresh copies of the repository.
  for (const [name, args] of [['indexed.git', ['index-pack', '--stdin', '--strict']], ['loose.git', ['unpack-objects', '--strict']]]) {
    const copy = repository(name);
    run(copy, ['fetch', '--quiet', origin, 'refs/heads/*:refs/heads/*']);
    run(copy, args, pack);
    assert.equal(text(copy, ['cat-file', '-t', commit.id]), 'commit');
    assert.deepEqual(run(copy, ['cat-file', 'commit', commit.id]), Buffer.from(commit.body));
    assert.equal(text(copy, ['rev-parse', commit.id + '^{tree}']), headTree);
    assert.equal(text(copy, ['rev-parse', commit.id + '^1', commit.id + '^2']), base + '\n' + head);
    run(copy, ['update-ref', 'refs/heads/main', commit.id, base]);
    run(copy, ['fsck', '--strict', '--full', '--no-dangling']);
  }

  // The exact HTTP request body, read by the program a smart-HTTP server runs for POST git-receive-pack.
  const receive = old => spawnSync('git', ['receive-pack', '--stateless-rpc', origin], { env, input: receiveRequest(old, commit.id, 'refs/heads/main', pack) });
  // A stale expected base is refused by the server's compare-and-swap and reported as such.
  assert.match(receiveStatus(receive(head).stdout, 'refs/heads/main'), /^ng refs\/heads\/main /);
  assert.equal(text(origin, ['rev-parse', 'refs/heads/main']), base);
  const reply = receive(base);
  assert.equal(reply.status, 0, reply.stderr.toString());
  assert.equal(receiveStatus(reply.stdout, 'refs/heads/main'), '', reply.stdout.toString());
  assert.equal(text(origin, ['rev-parse', 'refs/heads/main']), commit.id);
  assert.equal(text(origin, ['rev-parse', 'refs/heads/main^{tree}']), text(origin, ['rev-parse', 'refs/heads/feature^{tree}']));
  assert.equal(text(origin, ['log', '-1', '--format=%an <%ae> %at%n%cn <%ce> %ct%n%P%n%B', 'refs/heads/main']),
    `Zoë Example <${identity.email}> ${identity.time}\nZoë Example <${identity.email}> ${identity.time}\n${base} ${head}\nMerge pull request #1 from feature into main\n\nReviewed.`);
  run(origin, ['merge-base', '--is-ancestor', base, 'refs/heads/main']); run(origin, ['merge-base', '--is-ancestor', head, 'refs/heads/main']);
  run(origin, ['fsck', '--strict', '--full', '--no-dangling']);
});

test('three-way merge plans match real Git: merged tree, strict pack, squash parents and conflicting paths', { skip: !available && 'git is not installed' }, async t => {
  const root = mkdtempSync(join(tmpdir(), 'golf-native-plan-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const env = { PATH: process.env.PATH, HOME: root, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
    GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid', GIT_AUTHOR_DATE: '1699990000 +0000', GIT_COMMITTER_DATE: '1699990000 +0000' };
  const spawn = (directory, args, input, extra = {}) => spawnSync('git', ['--git-dir', directory, ...args], { env: { ...env, ...extra }, input });
  const run = (directory, args, input, extra) => { const result = spawn(directory, args, input, extra); assert.equal(result.status, 0, result.stderr.toString()); return result.stdout; };
  const text = (...args) => run(...args).toString().trim();
  const repository = name => { const directory = join(root, name); execFileSync('git', ['init', '--bare', '--quiet', '--initial-branch=main', directory], { env }); return directory; };
  const origin = repository('origin.git');
  let indexes = 0;
  const commit = (files, parents, message) => {
    const index = { GIT_INDEX_FILE: join(root, `index-${indexes++}`) };
    run(origin, ['update-index', '--add', '--index-info'], Object.entries(files).map(([path, content]) => `100644 ${text(origin, ['hash-object', '-w', '--stdin'], content)}\t${path}\n`).join(''), index);
    return text(origin, ['commit-tree', text(origin, ['write-tree'], undefined, index), ...parents.flatMap(parent => ['-p', parent]), '-m', message]);
  };
  // Only the Git object reads a Worker repository handle offers.
  const types = { '040000': 'tree', '100644': 'blob', '100755': 'exec', '120000': 'symlink', '160000': 'gitlink' };
  const repo = { async readCommit(hash) {
    const result = spawn(origin, ['cat-file', 'commit', hash]); if (result.status) return null;
    const headers = result.stdout.toString().split('\n\n')[0].split('\n');
    return { hash, treeHash: headers[0].slice(5), parents: headers.filter(line => line.startsWith('parent ')).map(line => line.slice(7)) };
  }, async readTree(hash) {
    return run(origin, ['ls-tree', '-z', hash]).toString().split('\0').filter(Boolean).map(line => { const [meta, name] = line.split('\t'), [mode, , id] = meta.split(' '); return { name, hash: id, type: types[mode], mode }; });
  } };
  const start = { 'readme.txt': 'one\ntwo\n', 'src/a.txt': 'a\n', 'src/b.txt': 'b\n', 'docs/x.md': 'x\n' };
  const base0 = commit(start, [], 'Start');
  const main = commit({ ...start, 'src/a.txt': 'a changed on main\n', 'docs/y.md': 'y\n', 'same.txt': 'same\n' }, [base0], 'Main');
  const { 'docs/x.md': removed, ...rest } = start;
  const feature = commit({ ...rest, 'src/b.txt': 'b changed on feature\n', 'new/dir/z.txt': 'z\n', 'same.txt': 'same\n' }, [base0], 'Feature');
  assert.equal(removed, 'x\n');
  const witness = repository('witness.git');
  run(witness, ['fetch', '--quiet', origin, `${main}:refs/heads/main`, `${feature}:refs/heads/feature`]);
  const gitTree = text(witness, ['merge-tree', '--write-tree', main, feature]);

  // A head that already contains the base keeps the head tree and needs no new objects.
  assert.deepEqual(await mergePlan(repo, base0, feature), { blocker: '', mergeBase: base0, tree: text(origin, ['rev-parse', feature + '^{tree}']), objects: [], parents: [base0, feature] });
  assert.equal((await mergePlan(repo, feature, feature)).blocker, 'nothing_to_merge');
  assert.equal((await mergePlan(repo, feature, base0)).blocker, 'nothing_to_merge');

  const plan = await mergePlan(repo, main, feature);
  assert.equal(plan.blocker, ''); assert.equal(plan.mergeBase, base0); assert.deepEqual(plan.parents, [main, feature]);
  assert.equal(plan.tree, gitTree);
  assert.ok(plan.objects.length >= 2 && plan.objects.every(object => object.type === 'tree'));
  assert.deepEqual((await mergePlan(repo, main, feature, 'squash')).parents, [main]);

  // The commit and only the new trees. The receivers lack every merged tree, so receive-pack's connectivity check proves the pack complete.
  for (const object of plan.objects) assert.notEqual(spawn(origin, ['cat-file', '-e', object.id]).status, 0);
  for (const [method, parents] of [['merge', [main, feature]], ['squash', [main]]]) {
    const target = repository(method + '.git'), copy = repository(method + '-indexed.git');
    for (const directory of [target, copy]) run(directory, ['fetch', '--quiet', origin, `${main}:refs/heads/main`, `${feature}:refs/heads/feature`]);
    const merged = await mergeCommit({ ...identity, tree: plan.tree, parents, message: 'Merged\n' });
    const pack = await packObjects([merged, ...plan.objects]);
    run(copy, ['index-pack', '--stdin', '--strict'], pack);
    const reply = spawnSync('git', ['receive-pack', '--stateless-rpc', target], { env, input: receiveRequest(main, merged.id, 'refs/heads/main', pack) });
    assert.equal(receiveStatus(reply.stdout, 'refs/heads/main'), '', reply.stderr.toString());
    assert.equal(text(target, ['rev-parse', 'refs/heads/main^{tree}']), gitTree);
    assert.equal(text(target, ['log', '-1', '--format=%P', 'refs/heads/main']), parents.join(' '));
    run(target, ['fsck', '--strict', '--full', '--no-dangling']);
  }

  // Conflicts: the same line changed differently and a file added differently; identical additions and other paths merge.
  const left = commit({ ...start, 'readme.txt': 'one\nleft\n', 'clash.txt': 'left\n', 'same.txt': 'same\n', 'src/a.txt': 'a left\n' }, [base0], 'Left');
  const right = commit({ ...start, 'readme.txt': 'one\nright\n', 'clash.txt': 'right\n', 'same.txt': 'same\n', 'src/b.txt': 'b right\n' }, [base0], 'Right');
  run(witness, ['fetch', '--quiet', origin, `${left}:refs/heads/left`, `${right}:refs/heads/right`]);
  const report = spawn(witness, ['merge-tree', '--write-tree', '--name-only', '--no-messages', left, right]);
  assert.equal(report.status, 1);
  const refused = await mergePlan(repo, left, right);
  assert.deepEqual(refused, { blocker: 'merge_conflict', conflicts: [{ path: 'clash.txt', reason: 'both_added' }, { path: 'readme.txt', reason: 'both_modified' }], conflictCount: 2 });
  assert.deepEqual(refused.conflicts.map(conflict => conflict.path), report.stdout.toString().trim().split('\n').slice(1));
});
