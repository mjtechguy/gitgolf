import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { gitAvailable, gitFixture } from './git-cli-fixture.mjs';
import { packObjects, emptyTree } from './src/git-objects.mjs';
import { mergeTrees, changedPaths, mergeBudget } from './src/tree-merge.mjs';

const skip = !gitAvailable && 'git is not installed';
const baseFiles = {
  'README.md': 'readme\n', 'src/app.js': 'app\n', 'src/lib/util.js': 'util\n', 'src/lib/deep/x.js': 'x\n', 'docs/guide.md': 'guide\n', 'docs/api.md': 'api\n',
  'bin/tool': { content: '#!/bin/sh\n', mode: 'executable' }, conf: 'conf\n', 'link': { content: 'README.md', mode: 'symlink' },
  ...Object.fromEntries(Array.from({ length: 100 }, (_, index) => [`wide/d${index}/f.txt`, `wide ${index}\n`])),
};
const del = path => ({ path, delete: true });

// [name, ours ops, theirs ops, expected conflicts, why git differs]; clean merges must equal both ops applied together and git's own merge.
// Path-level merging is stricter than git: it never combines a mode change with a content change in one path.
const cases = [
  ['disjoint edits in sibling directories', [{ path: 'src/lib/util.js', content: 'UTIL\n' }], [{ path: 'docs/guide.md', content: 'GUIDE\n' }, { path: 'wide/d50/new.txt', content: 'n\n' }], []],
  ['identical edits are taken once', [{ path: 'README.md', content: 'same\n' }, { path: 'src/app.js', content: 'APP\n' }], [{ path: 'README.md', content: 'same\n' }], []],
  ['both sides delete the same file', [del('docs/api.md')], [del('docs/api.md'), { path: 'conf', content: 'CONF\n' }], []],
  ['conflicting edits', [{ path: 'README.md', content: 'ours\n' }, { path: 'src/app.js', content: 'APP\n' }], [{ path: 'README.md', content: 'theirs\n' }], [{ path: 'README.md', reason: 'both_modified' }]],
  ['modify on ours, delete on theirs', [{ path: 'docs/api.md', content: 'API\n' }], [del('docs/api.md')], [{ path: 'docs/api.md', reason: 'deleted_by_them' }]],
  ['delete on ours, modify on theirs', [del('docs/api.md')], [{ path: 'docs/api.md', content: 'API\n' }], [{ path: 'docs/api.md', reason: 'deleted_by_us' }]],
  ['identical adds', [{ path: 'new/file.txt', content: 'n\n' }], [{ path: 'new/file.txt', content: 'n\n' }, { path: 'other.txt', content: 'o\n' }], []],
  ['different adds', [{ path: 'new/file.txt', content: 'one\n' }], [{ path: 'new/file.txt', content: 'two\n' }], [{ path: 'new/file.txt', reason: 'both_added' }]],
  ['file replaced by a directory on one side only', [del('conf'), { path: 'conf/inner', content: 'i\n' }], [{ path: 'README.md', content: 'R\n' }], []],
  ['file replaced by a directory against a modified file', [del('conf'), { path: 'conf/inner', content: 'i\n' }], [{ path: 'conf', content: 'CONF\n' }], [{ path: 'conf', reason: 'file_directory' }]],
  ['added file against added directory', [{ path: 'fresh', content: 'f\n' }], [{ path: 'fresh/a', content: 'a\n' }], [{ path: 'fresh', reason: 'file_directory' }]],
  ['mode-only change on one side', [{ path: 'README.md', content: 'readme\n', mode: 'executable' }], [{ path: 'src/app.js', content: 'APP\n' }], []],
  ['mode change against a content change', [{ path: 'README.md', content: 'readme\n', mode: 'executable' }], [{ path: 'README.md', content: 'R\n' }], [{ path: 'README.md', reason: 'both_modified' }], 'git combines mode and content'],
  ['directory deleted on ours, file added in it on theirs', [del('docs/guide.md'), del('docs/api.md')], [{ path: 'docs/new.md', content: 'brand new\n' }], []],
  ['directory deleted on ours, file modified in it on theirs', [del('docs/guide.md'), del('docs/api.md')], [{ path: 'docs/guide.md', content: 'GUIDE\n' }], [{ path: 'docs/guide.md', reason: 'deleted_by_us' }]],
  ['several conflicts are all listed', [{ path: 'README.md', content: 'o\n' }, { path: 'src/lib/deep/x.js', content: 'o\n' }, del('conf')], [{ path: 'README.md', content: 't\n' }, { path: 'src/lib/deep/x.js', content: 't\n' }, { path: 'conf', content: 't\n' }],
    [{ path: 'README.md', reason: 'both_modified' }, { path: 'conf', reason: 'deleted_by_us' }, { path: 'src/lib/deep/x.js', reason: 'both_modified' }]],
];

test('mergeTrees agrees with git on clean merges and lists path conflicts', { skip }, async t => {
  const git = gitFixture(t), base = git.tree(baseFiles), baseCommit = git.text(['commit-tree', base, '-m', 'base']);
  for (const [name, oursOps, theirsOps, conflicts, stricter] of cases) {
    const ours = git.edit(base, oursOps), theirs = git.edit(base, theirsOps);
    const result = await mergeTrees(git.repo, base, ours, theirs);
    assert.deepEqual(result.conflicts, conflicts, name);
    const commit = tree => git.text(['commit-tree', tree, '-p', baseCommit, '-m', name]);
    const native = spawnSync('git', ['--git-dir', git.directory, 'merge-tree', '--write-tree', '-X', 'no-renames', '--merge-base', baseCommit, commit(ours), commit(theirs)], { env: git.env });
    if (conflicts.length) {
      assert.equal(result.treeId, null, name); assert.deepEqual(result.objects, [], name);
      assert.equal(native.status, stricter ? 0 : 1, name);
      continue;
    }
    assert.equal(native.status, 0, name);
    const together = oursOps.filter(op => !theirsOps.some(other => other.path === op.path)).concat(theirsOps);
    assert.equal(result.treeId, git.edit(base, together), name);
    assert.equal(result.treeId, native.stdout.toString().trim(), name);
    if (result.objects.length) git.store(await packObjects(result.objects));
    git.verify(result.treeId);
  }
});

// Text files both sides changed: [name, base files, ours ops, theirs ops, expected conflicts, why git differs].
const numbered = (n, prefix = 'line', ending = '\n') => Array.from({ length: n }, (_, i) => `${prefix} ${i + 1}${ending}`).join('');
const swap = (content, from, to) => { assert.ok(content.includes(from)); return content.replace(from, to); };
const app = numbered(20), crlf = numbered(12, 'row', '\r\n'), tool = { content: '#!/bin/sh\n' + numbered(8, 'echo'), mode: 'executable' };
const textBase = { 'src/app.js': app, 'src/deep/er/x.txt': app, 'win.txt': crlf, 'bin/tool': tool, 'other.md': 'other\n', 'pic.bin': 'a\0b\nc\n', link: { content: 'other.md', mode: 'symlink' } };
const textCases = [
  ['different lines of one file', [{ path: 'src/app.js', content: swap(app, 'line 2\n', 'LINE 2\n') }], [{ path: 'src/app.js', content: swap(app, 'line 18\n', 'LINE 18\n') }], []],
  ['different lines in a deep file, plus one-sided edits', [{ path: 'src/deep/er/x.txt', content: swap(app, 'line 5\n', 'five\nand more\n') }, { path: 'other.md', content: 'OTHER\n' }],
    [{ path: 'src/deep/er/x.txt', content: swap(app, 'line 9\n', '') }, { path: 'src/new.txt', content: 'new\n' }], []],
  ['the same line edit plus different lines', [{ path: 'src/app.js', content: swap(swap(app, 'line 1\n', 'one\n'), 'line 10\n', 'ten\n') }], [{ path: 'src/app.js', content: swap(swap(app, 'line 1\n', 'one\n'), 'line 20\n', 'twenty\n') }], []],
  ['CRLF lines', [{ path: 'win.txt', content: swap(crlf, 'row 1\r\n', 'ROW 1\r\n') }], [{ path: 'win.txt', content: swap(crlf, 'row 12\r\n', 'ROW 12\r\n') }], []],
  ['an executable file keeps its mode', [{ path: 'bin/tool', content: swap(tool.content, 'echo 1\n', 'echo one\n'), mode: 'executable' }], [{ path: 'bin/tool', content: swap(tool.content, 'echo 8\n', 'echo eight\n'), mode: 'executable' }], []],
  ['a final newline removed against an edit at the start', [{ path: 'src/app.js', content: app.slice(0, -1) }], [{ path: 'src/app.js', content: swap(app, 'line 1\n', 'one\n') }], []],
  ['the same line edited differently', [{ path: 'src/app.js', content: swap(app, 'line 7\n', 'ours\n') }], [{ path: 'src/app.js', content: swap(app, 'line 7\n', 'theirs\n') }], [{ path: 'src/app.js', reason: 'both_modified' }]],
  ['adjacent lines (git conflicts too)', [{ path: 'src/app.js', content: swap(app, 'line 7\n', 'ours\n') }], [{ path: 'src/app.js', content: swap(app, 'line 8\n', 'theirs\n') }], [{ path: 'src/app.js', reason: 'both_modified' }]],
  ['one file merges, another conflicts', [{ path: 'src/app.js', content: swap(app, 'line 2\n', 'two\n') }, { path: 'win.txt', content: swap(crlf, 'row 3\r\n', 'ours\r\n') }],
    [{ path: 'src/app.js', content: swap(app, 'line 19\n', 'nineteen\n') }, { path: 'win.txt', content: swap(crlf, 'row 3\r\n', 'theirs\r\n') }], [{ path: 'win.txt', reason: 'both_modified' }]],
  ['binary files', [{ path: 'pic.bin', content: 'a\0b\nC\n' }], [{ path: 'pic.bin', content: 'A\0b\nc\n' }], [{ path: 'pic.bin', reason: 'binary' }]],
  ['added on both sides with different lines', [{ path: 'fresh.txt', content: 'a\nb\nc\n' }], [{ path: 'fresh.txt', content: 'a\nB\nc\n' }], [{ path: 'fresh.txt', reason: 'both_added' }]],
  ['added on both sides, one empty (git takes the other)', [{ path: 'fresh.txt', content: '' }], [{ path: 'fresh.txt', content: 'b\n' }], []],
  ['symlinks are not merged as text', [{ path: 'link', content: 'other.md\nx', mode: 'symlink' }], [{ path: 'link', content: 'y\nother.md', mode: 'symlink' }], [{ path: 'link', reason: 'both_modified' }]],
  ['a mode change with disjoint line edits', [{ path: 'src/app.js', content: swap(app, 'line 2\n', 'two\n'), mode: 'executable' }], [{ path: 'src/app.js', content: swap(app, 'line 19\n', 'nineteen\n') }],
    [{ path: 'src/app.js', reason: 'both_modified' }], 'git combines the mode and the lines'],
];

test('mergeTrees merges text files line by line like git merge-tree and packs the merged blobs', { skip }, async t => {
  const git = gitFixture(t), base = git.tree(textBase), baseCommit = git.text(['commit-tree', base, '-m', 'base']);
  for (const [name, oursOps, theirsOps, conflicts, stricter] of textCases) {
    const ours = git.edit(base, oursOps), theirs = git.edit(base, theirsOps);
    const result = await mergeTrees(git.repo, base, ours, theirs);
    assert.deepEqual(result.conflicts, conflicts, name);
    const commit = tree => git.text(['commit-tree', tree, '-p', baseCommit, '-m', name]);
    const native = spawnSync('git', ['--git-dir', git.directory, 'merge-tree', '--write-tree', '-X', 'no-renames', '--merge-base', baseCommit, commit(ours), commit(theirs)], { env: git.env });
    if (conflicts.length) {
      assert.equal(result.treeId, null, name); assert.deepEqual(result.objects, [], name);
      assert.equal(native.status, stricter ? 0 : 1, name);
      continue;
    }
    assert.equal(native.status, 0, name);
    assert.equal(result.treeId, native.stdout.toString().trim(), name);
    // New blobs are in objects: a fresh repository holding only the three inputs accepts the pack and verifies the tree.
    const fresh = gitFixture(t);
    fresh.run(['fetch', '--quiet', '--no-write-fetch-head', git.directory, ...[ours, theirs, base].map((tree, i) => `+${commit(tree)}:refs/inputs/${i}`)]);
    if (result.objects.length) fresh.store(await packObjects(result.objects));
    fresh.verify(result.treeId);
  }
  // A merged file that differs from both sides is a new blob object; the pack carries it with the new trees.
  const merged = await mergeTrees(git.repo, base, git.edit(base, textCases[0][1]), git.edit(base, textCases[0][2]));
  assert.deepEqual(merged.objects.map(object => object.type).sort(), ['blob', 'tree', 'tree']);
  assert.equal(new TextDecoder().decode(merged.objects.find(object => object.type === 'blob').body), swap(swap(app, 'line 2\n', 'LINE 2\n'), 'line 18\n', 'LINE 18\n'));
});

test('mergeTrees line merges read blobs as bytes or Blobs, and without readBlob conflict by path', { skip }, async t => {
  const git = gitFixture(t), base = git.tree(textBase);
  const ours = git.edit(base, textCases[0][1]), theirs = git.edit(base, textCases[0][2]);
  const expected = (await mergeTrees(git.repo, base, ours, theirs)).treeId;
  const bytes = { readTree: git.repo.readTree, readBlob: async hash => new Uint8Array(await (await git.repo.readBlob(hash)).arrayBuffer()) };
  assert.equal((await mergeTrees(bytes, base, ours, theirs)).treeId, expected);
  assert.deepEqual((await mergeTrees({ readTree: git.repo.readTree }, base, ours, theirs)).conflicts, [{ path: 'src/app.js', reason: 'both_modified' }]);
  await assert.rejects(mergeTrees({ readTree: git.repo.readTree, readBlob: async () => null }, base, ours, theirs), /Missing blob/);
  // Over 1 MiB a file is not read and conflicts by path (git would merge it).
  const big = numbered(70_000);
  const large = git.tree({ 'big.txt': big }), bigOurs = git.edit(large, [{ path: 'big.txt', content: 'top\n' + big }]), bigTheirs = git.edit(large, [{ path: 'big.txt', content: big + 'end\n' }]);
  assert.deepEqual((await mergeTrees(git.repo, large, bigOurs, bigTheirs)).conflicts, [{ path: 'big.txt', reason: 'too_large_to_merge' }]);
});

test('mergeTrees stops merging lines beyond the per-merge budget', { skip }, async t => {
  const git = gitFixture(t), count = mergeBudget.files + 3, file = numbered(10);
  const base = git.tree(Object.fromEntries(Array.from({ length: count }, (_, i) => [`many/f${i}.txt`, file])));
  const side = content => git.edit(base, Array.from({ length: count }, (_, i) => ({ path: `many/f${i}.txt`, content })));
  const result = await mergeTrees(git.repo, base, side(swap(file, 'line 1\n', 'one\n')), side(swap(file, 'line 10\n', 'ten\n')));
  assert.equal(result.treeId, null);
  assert.deepEqual(result.conflicts.map(conflict => conflict.reason), Array(3).fill('merge_budget'));
  // Bytes: 1 MiB files, three versions each, reach 16 MiB before the sixth file.
  const row = 'y'.repeat(1023) + '\n', big = row.repeat(1023), heavy = git.tree(Object.fromEntries(Array.from({ length: 7 }, (_, i) => [`big${i}.txt`, big])));
  const heavySide = content => git.edit(heavy, Array.from({ length: 7 }, (_, i) => ({ path: `big${i}.txt`, content })));
  let read = 0;
  const counting = { readTree: git.repo.readTree, async readBlob(hash) { const blob = await git.repo.readBlob(hash); return { size: blob.size, arrayBuffer: () => { read += blob.size; return blob.arrayBuffer(); } }; } };
  const spent = await mergeTrees(counting, heavy, heavySide('a\n' + big), heavySide(big + 'z\n'));
  const fit = Math.floor(mergeBudget.bytes / (3 * big.length + 4));
  assert.equal(fit, 5);
  assert.deepEqual(spent.conflicts.map(conflict => conflict.reason), Array(7 - fit).fill('merge_budget'));
  assert.equal(read, fit * (3 * big.length + 4));
});

test('mergeTrees takes unchanged and one-sided subtrees wholesale without reading them', { skip }, async t => {
  const git = gitFixture(t), base = git.tree(baseFiles);
  const ours = git.edit(base, [{ path: 'wide/d7/f.txt', content: 'seven\n' }, { path: 'src/lib/deep/x.js', content: 'X\n' }]), theirs = git.edit(base, [{ path: 'wide/d93/f.txt', content: 'ninety-three\n' }]);
  git.reads.length = 0;
  const result = await mergeTrees(git.repo, base, ours, theirs);
  assert.equal(result.treeId, git.edit(base, [{ path: 'wide/d7/f.txt', content: 'seven\n' }, { path: 'src/lib/deep/x.js', content: 'X\n' }, { path: 'wide/d93/f.txt', content: 'ninety-three\n' }]));
  // Three roots and three wide/ directories; src/ and every wide/dN are taken by hash.
  assert.equal(git.reads.length, 6);
  assert.deepEqual(result.objects.map(object => object.type), ['tree', 'tree']);
  git.store(await packObjects(result.objects)); git.verify(result.treeId);
  git.reads.length = 0;
  for (const [b, o, th, expected] of [[base, ours, base, ours], [base, base, theirs, theirs], [base, ours, ours, ours], [ours, base, ours, base]]) {
    const same = await mergeTrees(git.repo, b, o, th);
    assert.deepEqual([same.treeId, same.objects], [expected, []]);
  }
  assert.equal(git.reads.length, 0);
  const cleared = await mergeTrees(git.repo, git.tree({ a: 'a\n' }), emptyTree, git.tree({ a: 'a\n' }));
  assert.equal(cleared.treeId, emptyTree);
  const fresh = await mergeTrees(git.repo, null, git.tree({ a: 'a\n' }), git.tree({ b: 'b\n' }));
  assert.equal(fresh.treeId, git.tree({ a: 'a\n', b: 'b\n' }));
});

test('changedPaths matches git diff-tree and skips identical subtrees', { skip }, async t => {
  const git = gitFixture(t), base = git.tree(baseFiles), letters = { M: 'modified', A: 'added', D: 'deleted', T: 'modified' };
  for (const [name, ops] of cases.flatMap(([name, ours, theirs]) => [[name, ours], [name, theirs]])) {
    const other = git.edit(base, ops);
    for (const [a, b] of [[base, other], [other, base]]) {
      const expected = git.text(['diff-tree', '-r', '--no-renames', '--name-status', '-z', a, b]).split('\0').filter(Boolean)
        .reduce((rows, item, index, items) => index % 2 ? rows : [...rows, { path: items[index + 1], change: letters[item] }], []).sort((x, y) => x.path < y.path ? -1 : 1);
      assert.deepEqual(await changedPaths(git.repo, a, b), expected, name);
    }
  }
  git.reads.length = 0;
  const wide = git.edit(base, [{ path: 'wide/d42/f.txt', content: 'changed\n' }]);
  assert.deepEqual(await changedPaths(git.repo, base, wide), [{ path: 'wide/d42/f.txt', change: 'modified' }]);
  assert.equal(git.reads.length, 6);
  assert.deepEqual(await changedPaths(git.repo, null, git.tree({ 'a/b': 'x\n' })), [{ path: 'a/b', change: 'added' }]);
});
