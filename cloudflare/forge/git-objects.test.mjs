import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { gitAvailable, gitFixture } from './git-cli-fixture.mjs';
import { blobObject, treeObject, commitObject, packObjects, planTreeEdit, emptyTree, GitTreeError } from './src/git-objects.mjs';
import { mergeCommit, commitPack } from './src/pull-merge.mjs';

const skip = !gitAvailable && 'git is not installed';
const bytes = text => new TextEncoder().encode(text);
const refusal = code => error => error instanceof GitTreeError && error.code === code;

test('commitPack and mergeCommit stay byte-identical to the pre-refactor encoder', async () => {
  // The pre-refactor single-commit writer, kept here as the reference.
  const join = (...chunks) => Buffer.concat(chunks.map(chunk => Buffer.from(chunk)));
  const reference = async body => {
    const entry = []; let size = body.length, byte = 0x10 | size & 15;
    for (size >>>= 4; size; size >>>= 7) { entry.push(byte | 0x80); byte = size & 0x7f; }
    entry.push(byte);
    const deflated = new Uint8Array(await new Response(new Blob([body]).stream().pipeThrough(new CompressionStream('deflate'))).arrayBuffer());
    const pack = join(Uint8Array.of(0x50, 0x41, 0x43, 0x4b, 0, 0, 0, 2, 0, 0, 0, 1), Uint8Array.from(entry), deflated);
    return join(pack, createHash('sha1').update(pack).digest());
  };
  for (const message of ['x\n', 'é'.repeat(900) + '\n', 'z'.repeat(40000) + '\n']) {
    const who = { name: 'Zoë Example', email: 'zoe@users.noreply.golf.example.com', time: 1700000000 };
    const commit = await mergeCommit({ ...who, tree: 'f'.repeat(40), parents: ['a'.repeat(40), 'b'.repeat(40)], message });
    const body = bytes(`tree ${'f'.repeat(40)}\nparent ${'a'.repeat(40)}\nparent ${'b'.repeat(40)}\nauthor Zoë Example <${who.email}> 1700000000 +0000\ncommitter Zoë Example <${who.email}> 1700000000 +0000\n\n${message}`);
    assert.deepEqual(Buffer.from(commit.body), Buffer.from(body));
    assert.deepEqual(Buffer.from(await commitPack(commit.body)), await reference(body));
  }
});

test('blob, tree and commit IDs equal git for sort-order, mode and identity edge cases', { skip }, async t => {
  const git = gitFixture(t);
  for (const content of ['', 'hello\n', '\0binary\xff', 'é'.repeat(5000)]) assert.equal((await blobObject(Buffer.from(content))).id, git.blob(Buffer.from(content)));
  const file = git.blob('file\n'), script = git.blob('#!/bin/sh\n'), link = git.blob('target/path'), sub = git.tree({ 'inner.txt': 'x\n' });
  // 'a' as a directory sorts as 'a/', after 'a.b' and 'a-b' but before 'a0'; files named 'b' sort before 'b.c'.
  const entries = [
    { name: 'a0', type: 'blob', hash: file }, { name: 'a', type: 'tree', hash: sub }, { name: 'a.b', type: 'blob', hash: file }, { name: 'a-b', type: 'exec', hash: script },
    { name: 'b.c', type: 'tree', hash: sub }, { name: 'b', type: 'symlink', hash: link }, { name: 'Zed', type: 'blob', hash: file }, { name: 'ünï', type: 'blob', hash: file },
    { name: 'mod', type: 'gitlink', hash: 'c'.repeat(40) },
  ];
  const mode = { tree: '040000 tree', blob: '100644 blob', exec: '100755 blob', symlink: '120000 blob', gitlink: '160000 commit' };
  const expected = git.text(['mktree'], entries.map(entry => `${mode[entry.type]} ${entry.hash}\t${entry.name}\n`).join(''));
  const tree = await treeObject(entries);
  assert.equal(tree.id, expected);
  assert.deepEqual(Buffer.from(tree.body), git.run(['cat-file', 'tree', expected]));
  assert.equal((await treeObject([])).id, emptyTree);
  await assert.rejects(treeObject([{ name: 'x', type: 'blob', hash: file }, { name: 'x', type: 'tree', hash: sub }]), TypeError);
  await assert.rejects(treeObject([{ name: 'a/b', type: 'blob', hash: file }]), TypeError);
  await assert.rejects(treeObject([{ name: 'bad\uFFFD', type: 'blob', hash: file }]), refusal('unrepresentable_name'));

  const commit = await commitObject({ tree: expected, parents: [], author: { name: 'Ann Author', email: 'ann@example.invalid', time: 1700000000, tz: '-0730' },
    committer: { name: 'Cy Committer', email: 'cy@example.invalid', time: 1700000100, tz: '+0200' }, message: 'Subject\n\nBody line.\n' });
  const made = git.text(['commit-tree', expected, '-m', 'Subject\n\nBody line.'], undefined, { GIT_AUTHOR_NAME: 'Ann Author', GIT_AUTHOR_EMAIL: 'ann@example.invalid', GIT_AUTHOR_DATE: '1700000000 -0730',
    GIT_COMMITTER_NAME: 'Cy Committer', GIT_COMMITTER_EMAIL: 'cy@example.invalid', GIT_COMMITTER_DATE: '1700000100 +0200' });
  assert.equal(commit.id, made);
  const child = await commitObject({ tree: emptyTree, parents: [made, made.replace(/^./, '0')], author: { name: 'A', email: 'a@x', time: 1 }, message: 'm\n' });
  assert.equal(child.id, git.text(['hash-object', '-t', 'commit', '--stdin'], Buffer.from(child.body)));
  await assert.rejects(commitObject({ tree: emptyTree, author: { name: 'A <x>', email: 'a@x', time: 1 }, message: '' }), TypeError);
});

test('a pack of many objects is indexed strictly, unpacked loose and passes fsck', { skip }, async t => {
  const git = gitFixture(t), other = gitFixture(t);
  const blobs = await Promise.all(['', 'small\n', 'x'.repeat(15), 'y'.repeat(16), 'z'.repeat(2047), 'w'.repeat(2048), 'v'.repeat(300000)].map(text => blobObject(bytes(text))));
  const inner = await treeObject(blobs.slice(0, 4).map((blob, index) => ({ name: 'f' + index, type: index % 2 ? 'exec' : 'blob', hash: blob.id })));
  const tree = await treeObject([...blobs.slice(4).map((blob, index) => ({ name: 'g' + index, type: 'blob', hash: blob.id })), { name: 'dir', type: 'tree', hash: inner.id }]);
  const commit = await commitObject({ tree: tree.id, author: { name: 'A', email: 'a@example.invalid', time: 1700000000 }, message: 'Many\n' });
  // Duplicates are written once.
  const pack = await packObjects([commit, tree, inner, ...blobs, blobs[1]]);
  assert.equal(Buffer.from(pack.subarray(0, 12)).toString('hex'), '5041434b00000002' + (blobs.length + 3).toString(16).padStart(8, '0'));
  git.store(pack);
  other.run(['unpack-objects', '--strict'], pack);
  for (const fixture of [git, other]) {
    assert.equal(fixture.text(['rev-parse', commit.id + '^{tree}']), tree.id);
    assert.deepEqual(fixture.run(['cat-file', 'blob', blobs.at(-1).id]), Buffer.from(blobs.at(-1).body));
    fixture.run(['update-ref', 'refs/heads/main', commit.id]);
    fixture.run(['fsck', '--strict', '--full', '--no-dangling']);
  }
});

const baseFiles = {
  'README.md': 'readme\n', 'a.b': 'dot\n', 'a/one.txt': 'one\n', 'a/b/two.txt': 'two\n', 'a/b/c/three.txt': 'three\n', 'bin/run': { content: '#!/bin/sh\n', mode: 'executable' },
  'link': { content: 'README.md', mode: 'symlink' }, 'vendor/lib': { mode: 'gitlink', hash: 'd'.repeat(40) },
  ...Object.fromEntries(Array.from({ length: 60 }, (_, index) => [`wide/d${index}/file.txt`, `wide ${index}\n`])),
};

test('planTreeEdit produces the tree git writes for the same edits and reads only changed directories', { skip }, async t => {
  const git = gitFixture(t), base = git.tree(baseFiles);
  const cases = [
    [[{ path: 'a/b/c/three.txt', content: 'THREE\n' }], [{ path: 'a/b/c/three.txt', content: 'THREE\n' }]],
    [[{ path: 'new/deep/dir/file.txt', content: 'new\n' }], [{ path: 'new/deep/dir/file.txt', content: 'new\n' }]],
    [[{ path: 'a/b/c/three.txt', delete: true }], [{ path: 'a/b/c/three.txt', delete: true }]],
    [[{ path: 'a/b/c/three.txt', delete: true }, { path: 'a/b/two.txt', delete: true }], [{ path: 'a/b/c/three.txt', delete: true }, { path: 'a/b/two.txt', delete: true }]],
    [[{ path: 'moved/three.txt', from: 'a/b/c/three.txt' }, { path: 'bin/run2', from: 'bin/run' }],
      [{ path: 'a/b/c/three.txt', delete: true }, { path: 'moved/three.txt', content: 'three\n' }, { path: 'bin/run', delete: true }, { path: 'bin/run2', content: '#!/bin/sh\n', mode: 'executable' }]],
    [[{ path: 'bin/run', content: 'changed\n' }], [{ path: 'bin/run', content: 'changed\n', mode: 'executable' }]],
    [[{ path: 'README.md', content: 'readme\n', mode: 'executable' }, { path: 'link', content: 'a.b', mode: 'symlink' }, { path: 'a/new', content: 'é\n', mode: 'file' }],
      [{ path: 'README.md', content: 'readme\n', mode: 'executable' }, { path: 'link', content: 'a.b', mode: 'symlink' }, { path: 'a/new', content: 'é\n' }]],
    [[{ path: 'a/b/two.txt', content: 'two\n' }], []],
  ];
  for (const [changes, ops] of cases) {
    git.reads.length = 0;
    const plan = await planTreeEdit(git.repo, base, changes.map(change => change.content === undefined ? change : { ...change, content: bytes(change.content) }));
    assert.equal(plan.treeId, git.edit(base, ops), JSON.stringify(changes));
    // Only the root, the changed directories and their ancestors are read; the 60 wide directories never are.
    assert.ok(git.reads.length <= 6, `${git.reads.length} reads for ${JSON.stringify(changes)}`);
    if (plan.objects.length) git.store(await packObjects(plan.objects));
    git.verify(plan.treeId);
  }
  const unchanged = await planTreeEdit(git.repo, base, [{ path: 'a/b/two.txt', content: bytes('two\n') }]);
  assert.deepEqual([unchanged.treeId, unchanged.objects, unchanged.changedPaths], [base, [], []]);
  const edit = await planTreeEdit(git.repo, base, [{ path: 'a/one.txt', content: bytes('ONE\n') }, { path: 'x/y', content: bytes('y\n') }, { path: 'a.b', delete: true }, { path: 'a/to', from: 'README.md' }]);
  assert.deepEqual(edit.changedPaths, [{ path: 'README.md', change: 'deleted' }, { path: 'a.b', change: 'deleted' }, { path: 'a/one.txt', change: 'modified' }, { path: 'a/to', change: 'added' }, { path: 'x/y', change: 'added' }]);
  // New blobs and rewritten trees only: two blobs, then root, a/ and x/.
  assert.deepEqual(edit.objects.map(object => object.type).sort(), ['blob', 'blob', 'tree', 'tree', 'tree']);
});

test('planTreeEdit removes emptied directories and builds from an empty base', { skip }, async t => {
  const git = gitFixture(t), base = git.tree({ 'only/deep/file': 'x\n', top: 't\n' });
  const emptied = await planTreeEdit(git.repo, base, [{ path: 'only/deep/file', delete: true }]);
  assert.equal(emptied.treeId, git.tree({ top: 't\n' }));
  const nothing = await planTreeEdit(git.repo, emptied.treeId, [{ path: 'top', delete: true }]);
  assert.equal(nothing.treeId, emptyTree);
  git.store(await packObjects(nothing.objects)); git.verify(nothing.treeId);
  for (const start of [null, emptyTree]) {
    const fresh = await planTreeEdit(git.repo, start, [{ path: 'src/main.js', content: bytes('main\n') }, { path: 'README', content: bytes('r\n') }]);
    assert.equal(fresh.treeId, git.tree({ 'src/main.js': 'main\n', README: 'r\n' }));
    git.store(await packObjects(fresh.objects)); git.verify(fresh.treeId);
  }
});

test('planTreeEdit refuses conflicts, missing paths, duplicates, gitlinks and .git with typed codes', { skip }, async t => {
  const git = gitFixture(t), base = git.tree(baseFiles), content = bytes('x');
  const refused = [
    ['path_conflict', [{ path: 'README.md/inside', content }]],
    ['path_conflict', [{ path: 'a/b', content }]],
    ['path_conflict', [{ path: 'a', delete: true }]],
    ['path_conflict', [{ path: 'z', from: 'a/b' }]],
    ['path_conflict', [{ path: 'n/file', content }, { path: 'n/file/deeper', content }]],
    ['path_conflict', [{ path: 'n/file/deeper', content }, { path: 'n/file', content }]],
    ['missing_path', [{ path: 'nope.txt', delete: true }]],
    ['missing_path', [{ path: 'a/nope/x', delete: true }]],
    ['missing_path', [{ path: 'to', from: 'a/missing.txt' }]],
    ['missing_path', [{ path: 'to', from: 'README.md/x' }]],
    ['duplicate_path', [{ path: 'a/one.txt', content }, { path: 'a/one.txt', delete: true }]],
    ['duplicate_path', [{ path: 'to', from: 'a/one.txt' }, { path: 'a/one.txt', content }]],
    ['gitlink_edit', [{ path: 'vendor/lib', content }]],
    ['gitlink_edit', [{ path: 'vendor/lib', delete: true }]],
    ['gitlink_edit', [{ path: 'vendor/lib/inner', content }]],
    ['gitlink_edit', [{ path: 'x', from: 'vendor/lib' }]],
    ['invalid_path', [{ path: '.git/config', content }]],
    ['invalid_path', [{ path: 'a/.GIT', content }]],
    ['invalid_path', [{ path: 'a//b', content }]],
    ['invalid_path', [{ path: '../up', content }]],
    ['invalid_path', [{ path: '', content }]],
    ['invalid_path', [{ path: 'ok', from: 'x/./y' }]],
    ['invalid_change', [{ path: 'a', content, delete: true }]],
    ['invalid_change', [{ path: 'a', content: 'text' }]],
    ['invalid_change', [{ path: 'a', content, mode: 'toString' }]],
    ['invalid_change', [{ path: 'a', delete: true, mode: 'file' }]],
    ['invalid_change', [{ path: 'a', from: 'a' }]],
  ];
  for (const [code, changes] of refused) await assert.rejects(planTreeEdit(git.repo, base, changes), refusal(code), JSON.stringify(changes));
  // A non-UTF-8 name reaches JavaScript lossily decoded: its directory is never rewritten; other directories still are.
  const legacy = git.text(['mktree'], Buffer.concat([Buffer.from(`100644 blob ${git.blob('x')}\tcaf`), Buffer.from([0xe9]), Buffer.from('\n')]));
  const root = git.text(['mktree'], `040000 tree ${legacy}\tlegacy\n100644 blob ${git.blob('r')}\treadme\n`);
  await assert.rejects(planTreeEdit(git.repo, root, [{ path: 'legacy/new', content }]), refusal('unrepresentable_name'));
  const beside = await planTreeEdit(git.repo, root, [{ path: 'readme', content }]);
  git.store(await packObjects(beside.objects));
  assert.equal(git.text(['rev-parse', beside.treeId + ':legacy']), legacy);
});
