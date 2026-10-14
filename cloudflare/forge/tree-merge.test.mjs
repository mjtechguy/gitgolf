import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { gitAvailable, gitFixture } from './git-cli-fixture.mjs';
import { packObjects, emptyTree } from './src/git-objects.mjs';
import { mergeTrees, changedPaths } from './src/tree-merge.mjs';

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
