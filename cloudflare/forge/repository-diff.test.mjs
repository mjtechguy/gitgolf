import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { comparison, diff } from './src/repository-diff.mjs';

const hash = n => n.toString(16).padStart(40, '0');
test('paired diff reads overlap and settle before a provider failure escapes', async () => {
  let release, entered = [], finished = false;
  const pending = new Promise(resolve => { release = resolve; });
  const repo = { async readCommit(id) { entered.push(id); if (id === hash(1)) throw Error('read failed'); await pending; return null; } };
  const result = diff(repo, hash(1), hash(2)).finally(() => { finished = true; });
  const rejected = assert.rejects(result, /read failed/);
  await Promise.resolve(); await Promise.resolve();
  assert.deepEqual(entered, [hash(1), hash(2)]); assert.equal(finished, false);
  release(); await rejected; assert.equal(finished, true);
});
function fixture() {
  const commits = new Map(), trees = new Map(), blobs = new Map(); let sequence = 10;
  function commit(id, parents, files) {
    const treeHash = hash(sequence++), tree = [];
    for (const [name, text, type = 'blob', mode = '100644'] of files) {
      const blob = createHash('sha1').update(`blob ${Buffer.byteLength(text)}\0`).update(text).digest('hex'); blobs.set(blob, new Blob([text])); tree.push({ name, hash: blob, type, mode });
    }
    trees.set(treeHash, tree); commits.set(hash(id), { hash: hash(id), parents: parents.map(hash), treeHash });
  }
  return { commit, commits, trees, blobs, repo: {
    readCommit: async id => commits.get(id), readTree: async id => trees.get(id), readBlob: async id => blobs.get(id),
  } };
}
test('merge base follows the complete DAG and excludes commits reachable from the base tip', async () => {
  const f = fixture(); f.commit(1, [], []); f.commit(2, [1], []); f.commit(3, [1], []); f.commit(4, [2, 3], []);
  const result = await comparison(f.repo, hash(2), hash(4));
  assert.equal(result.mergeBase, hash(2)); assert.deepEqual(new Set(result.commits.map(c => c.hash)), new Set([hash(3), hash(4)]));
  assert.equal((await comparison(f.repo, hash(2), hash(3))).mergeBase, hash(1));
  f.commit(5, [2, 3], []); f.commit(6, [3, 2], []);
  await assert.rejects(comparison(f.repo, hash(5), hash(6)), error => error.code === 'unimplemented');
  f.commit(7, [], []); await assert.rejects(comparison(f.repo, hash(1), hash(7)), error => error.code === 'failed_precondition');
});
test('generated unified patch applies through real Git, including missing newlines, quoted names and file modes', async t => {
  const f = fixture(), root = await mkdtemp(join(tmpdir(), 'golf-native-diff-')); t.after(() => rm(root, { recursive: true, force: true }));
  const initial = [['hello.txt', 'one\ntwo\nthree'], ['empty', ''], ['a space.txt', 'before\n'], ['delete.txt', 'gone\n'], ['mode', 'run\n']];
  const final = [['hello.txt', 'one\nTWO\nthree\n'], ['empty', ''], ['a space.txt', 'after\n'], ['new.txt', 'new'], ['mode', 'run\n', 'exec', '100755']];
  f.commit(1, [], initial); f.commit(2, [1], final);
  await mkdir(join(root, 'work')); const cwd = join(root, 'work');
  execFileSync('git', ['init', '-q'], { cwd });
  for (const [name, text] of initial) await writeFile(join(cwd, name), text);
  const patch = await diff(f.repo, hash(1), hash(2)); assert.equal(patch.byteSize, Buffer.byteLength(patch.rawDiff));
  execFileSync('git', ['apply', '--check', '-'], { cwd, input: patch.rawDiff });
  execFileSync('git', ['apply', '-'], { cwd, input: patch.rawDiff });
  for (const [name, text] of final) assert.equal(await readFile(join(cwd, name), 'utf8'), text);
  await assert.rejects(readFile(join(cwd, 'delete.txt')), { code: 'ENOENT' });
  const rootPatch = await diff(f.repo, '', hash(1)); assert.match(rootPatch.rawDiff, /new file mode/);
  assert.deepEqual(await diff(f.repo, hash(1), hash(1)), { rawDiff: '', byteSize: 0 });
});
test('binary changes retain metadata; corrupt or oversized objects never become a partial patch', async () => {
  const f = fixture(); f.commit(1, [], [['binary', '\0before']]); f.commit(2, [1], [['binary', '\0after']]);
  assert.match((await diff(f.repo, hash(1), hash(2))).rawDiff, /Binary files a\/binary and b\/binary differ/);
  f.commit(3, [2], [['large', 'a'.repeat(512 * 1024 + 1)]]);
  await assert.rejects(diff(f.repo, hash(2), hash(3)), error => error.code === 'resource_exhausted');
  f.commit(4, [2], [['../escape', 'bad']]); await assert.rejects(diff(f.repo, hash(2), hash(4)), /Invalid comparison entry/);
});

test('short comparisons on old histories read only their divergent linear segments', async () => {
  const reads = [];
  const repo = { async readCommit(id) {
    reads.push(id);
    const n = parseInt(id, 16);
    return { hash: id, treeHash: hash(999999), parents: n > 1 ? [hash(n - 1)] : [] };
  } };
  const forward = await comparison(repo, hash(10000), hash(10003));
  assert.equal(forward.mergeBase, hash(10000));
  assert.deepEqual(forward.commits.map(c => c.hash), [10003, 10002, 10001].map(hash));
  assert.equal(reads.length, 4);
  reads.length = 0;
  const behind = await comparison(repo, hash(10003), hash(10000));
  assert.equal(behind.mergeBase, hash(10000)); assert.deepEqual(behind.commits, []);
  assert.ok(reads.length <= 67); assert.equal(new Set(reads).size, reads.length);
  await assert.rejects(comparison({readCommit: async () => null}, hash(1), hash(1)), error => error.code === 'not_found');
});

test('linear optimization agrees with exhaustive DAG comparison on generated histories', async () => {
  let seed = 42;
  const random = n => { seed = (Math.imul(seed,1664525) + 1013904223) >>> 0; return seed % n; };
  for (let round = 0; round < 60; round++) {
    const f = fixture(); f.commit(1, [], []);
    for (let n = 2; n <= 24; n++) f.commit(n, [...new Set([1 + random(n - 1), ...(random(3) === 0 ? [1 + random(n - 1)] : [])])], []);
    const reachable = start => { const seen = new Set(), pending = [start]; while(pending.length) { const id=pending.pop(); if(seen.has(id)) continue;seen.add(id);pending.push(...f.commits.get(id).parents); } return seen; };
    const base=hash(1+random(24)), head=hash(1+random(24)), older=reachable(base), newer=reachable(head);
    const common=new Set([...older].filter(id=>newer.has(id))), best=new Set(common);
    for(const id of common) for(const parent of f.commits.get(id).parents) for(const ancestor of reachable(parent)) best.delete(ancestor);
    if(best.size!==1) await assert.rejects(comparison(f.repo,base,head), error=>error.code==='unimplemented');
    else { const result=await comparison(f.repo,base,head);assert.equal(result.mergeBase,[...best][0]);assert.deepEqual(new Set(result.commits.map(c=>c.hash)),new Set([...newer].filter(id=>!older.has(id)))); }
  }
});

test('merge bases with commit times, in order or skewed, match the exhaustive answer', async () => {
  let seed = 7;
  const random = n => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed % n; };
  for (const skew of [false, true]) for (let round = 0; round < 80; round++) {
    const commits = new Map(), at = new Map();
    const add = (n, parents) => { at.set(n, skew ? random(1000) : Math.max(0, ...parents.map(p => at.get(p))) + 1 + random(5)); commits.set(hash(n), { hash: hash(n), treeHash: hash(999999), parents: parents.map(hash), authoredAt: at.get(n) }); };
    add(1, []);
    for (let n = 2; n <= 30; n++) add(n, [...new Set([1 + random(n - 1), ...(random(3) === 0 ? [1 + random(n - 1)] : [])])]);
    const repo = { readCommit: async id => commits.get(id) };
    const reachable = start => { const seen = new Set(), pending = [start]; while (pending.length) { const id = pending.pop(); if (seen.has(id)) continue; seen.add(id); pending.push(...commits.get(id).parents); } return seen; };
    const base = hash(1 + random(30)), head = hash(1 + random(30)), older = reachable(base), newer = reachable(head);
    const common = new Set([...older].filter(id => newer.has(id))), best = new Set(common);
    for (const id of common) for (const parent of commits.get(id).parents) for (const ancestor of reachable(parent)) best.delete(ancestor);
    if (best.size !== 1) { await assert.rejects(comparison(repo, base, head), error => error.code === 'unimplemented'); continue; }
    const result = await comparison(repo, base, head);
    assert.equal(result.mergeBase, [...best][0], `skew ${skew} round ${round}`);
    // Without skew the commit list is exact; with it, the merge base still is.
    if (!skew) assert.deepEqual(new Set(result.commits.map(c => c.hash)), new Set([...newer].filter(id => !older.has(id))));
  }
});

test('a pull request whose base moved by merges resolves on a long merge history with few reads', async () => {
  // main: 3,000 landed pull requests, each a merge commit of a one-commit branch; then a pull request opened from main and ten more
  // landings. The merge base is where the pull request started, whatever the age of the repository.
  const commits = new Map(); let n = 1, time = 1;
  const add = parents => { const id = hash(n++); commits.set(id, { hash: id, treeHash: hash(999999), parents, authoredAt: time++ }); return id; };
  let main = add([]);
  const land = () => { const branch = add([main]); main = add([main, branch]); };
  for (let i = 0; i < 3000; i++) land();
  const start = main, head = add([start]);
  for (let i = 0; i < 10; i++) land();
  const reads = [], repo = { readCommit: async id => { reads.push(id); return commits.get(id); } };
  const result = await comparison(repo, main, head);
  assert.equal(result.mergeBase, start); assert.deepEqual(result.commits.map(c => c.hash), [head]);
  assert.ok(new Set(reads).size < 100, `${new Set(reads).size} commits read`);
});
