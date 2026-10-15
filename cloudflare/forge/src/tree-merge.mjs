// Three-way tree merge (by path, then line by line for text files both sides changed) and tree comparison.
// Subtrees with equal hashes are never read.
import { blobObject, emptyTree, treeObject, treeReader } from './git-objects.mjs';
import { mergeText, textMergeLimits } from './text-merge.mjs';

const same = (a, b) => a ? Boolean(b) && a.type === b.type && a.hash === b.hash : !b;
const directory = entry => !entry || entry.type === 'tree';
const wrap = hash => hash && hash !== emptyTree ? { type: 'tree', hash } : null;
const child = (path, name) => path ? path + '/' + name : name;
const byPath = (a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
const named = async (read, hash) => new Map((await read(hash)).map(entry => [entry.name, entry]));
const regular = entry => entry?.type === 'blob' || entry?.type === 'exec';
// Per merge: at most this many files are merged line by line, reading at most this many bytes of their three versions.
// lines bounds the diff work of one merge across files (each file's diff is already bounded by xdiff's cost cut-offs), so hostile
// inputs cannot exhaust a Worker's CPU: about 200,000 lines is a few seconds at worst.
export const mergeBudget = Object.freeze({ files: 200, bytes: 16 << 20, lines: 200_000 });

// One side changed: take it. Both changed identically: take it once. Both changed a regular file differently with the
// same mode on every side that has it: merge its text line by line like `git merge-file` (text-merge.mjs; an add/add
// merges against an empty base, as git does); a clean result is a new blob in objects. Anything else both sides changed
// differently is a conflict, and mode changes count as changes. Conflict reasons: both_modified and both_added (lines
// both sides changed, or a change that is not a text edit), binary, too_large_to_merge, merge_budget (beyond
// mergeBudget), deleted_by_us, deleted_by_them, file_directory. With conflicts there is no tree and no objects.
// A repo without readBlob gets no line-level merging. Line merges run one file at a time, so the budget bounds memory.
export async function mergeTrees(repo, baseTree, oursTree, theirsTree) {
  const read = treeReader(repo), objects = new Map(), conflicts = [], spent = { files: 0, bytes: 0 };
  // readBlob returns a Blob, or bytes for objects not stored yet; contents are read only once their sizes fit.
  const handle = async hash => {
    const value = await repo.readBlob(hash);
    if (value instanceof Uint8Array) return { size: value.length, bytes: async () => value };
    if (!value || typeof value.arrayBuffer !== 'function' || !Number.isSafeInteger(value.size)) throw Error('Missing blob ' + hash);
    return { size: value.size, bytes: async () => {
      const bytes = new Uint8Array(await value.arrayBuffer());
      if (bytes.length !== value.size) throw Error('Blob size changed ' + hash);
      return bytes;
    } };
  };
  const empty = { size: 0, bytes: async () => new Uint8Array() };
  const merge3 = async (base, ours, theirs) => {
    if (++spent.files > mergeBudget.files || spent.bytes >= mergeBudget.bytes) return 'merge_budget';
    const sides = await Promise.all([base, ours, theirs].map(side => side ? handle(side.hash) : empty));
    if (sides.some(side => side.size > textMergeLimits.bytes)) return 'too_large_to_merge';
    const size = sides.reduce((sum, side) => sum + side.size, 0);
    // The first file that does not fit uses up the budget, so later files are not read either.
    if (spent.bytes + size > mergeBudget.bytes) { spent.bytes = mergeBudget.bytes; return 'merge_budget'; }
    spent.bytes += size;
    const contents = await Promise.all(sides.map(side => side.bytes()));
    const counts = contents.map(bytes => { let n = 0; for (const byte of bytes) if (byte === 10) n++; return n; });
    // One file over the line limit is reported as such; only files that could merge spend the shared line budget.
    if (counts.some(n => n > textMergeLimits.lines)) return 'too_large_to_merge';
    if ((spent.lines = (spent.lines || 0) + counts[0] + counts[1] + counts[2]) > mergeBudget.lines) return 'merge_budget';
    const result = mergeText(...contents);
    if (result.conflict) return result.reason === 'both_modified' && !base ? 'both_added' : result.reason;
    const blob = await blobObject(result.merged);
    if (![base?.hash, ours.hash, theirs.hash].includes(blob.id)) objects.set(blob.id, blob);
    return { type: ours.type, hash: blob.id };
  };
  let lane = Promise.resolve();
  const text = (base, ours, theirs) => {
    if (typeof repo.readBlob !== 'function') return base ? 'both_modified' : 'both_added';
    const run = lane.then(() => merge3(base, ours, theirs));
    lane = run.catch(() => {});
    return run;
  };
  const entry = async (path, base, ours, theirs) => {
    if (same(ours, theirs)) return ours;
    if (same(base, ours)) return theirs;
    if (same(base, theirs)) return ours;
    // Both sides hold a directory (or deleted one): merge inside it; a replaced base file merges as an empty directory.
    if (directory(ours) && directory(theirs)) {
      const hash = await merge(path, base?.type === 'tree' ? base.hash : null, ours?.hash, theirs?.hash);
      return hash && { type: 'tree', hash };
    }
    if (regular(ours) && ours.type === theirs?.type && (!base || base.type === ours.type)) {
      const merged = await text(base, ours, theirs);
      if (typeof merged === 'object') return merged;
      conflicts.push({ path, reason: merged });
      return null;
    }
    conflicts.push({ path, reason: ours && theirs && directory(ours) !== directory(theirs) ? 'file_directory' : !base ? 'both_added' : !ours ? 'deleted_by_us' : !theirs ? 'deleted_by_them' : 'both_modified' });
    return null;
  };
  const merge = async (path, base, ours, theirs) => {
    const [b, o, t] = await Promise.all([base, ours, theirs].map(hash => named(read, hash)));
    const result = [];
    await Promise.all([...new Set([...b.keys(), ...o.keys(), ...t.keys()])].map(async name => {
      const merged = await entry(child(path, name), b.get(name), o.get(name), t.get(name));
      if (merged) result.push({ name, type: merged.type, hash: merged.hash });
    }));
    if (conflicts.length || !result.length) return null;
    const tree = await treeObject(result);
    if (![base, ours, theirs].includes(tree.id)) objects.set(tree.id, tree);
    return tree.id;
  };
  const merged = await entry('', wrap(baseTree), wrap(oursTree), wrap(theirsTree));
  if (conflicts.length) return { treeId: null, objects: [], conflicts: conflicts.sort(byPath) };
  if (merged) return { treeId: merged.hash, objects: [...objects.values()], conflicts: [] };
  const tree = await treeObject([]);
  return { treeId: tree.id, objects: [tree], conflicts: [] };
}

// File-level changes from treeA to treeB ({path, change: added|modified|deleted}); a file↔directory swap lists both sides.
export async function changedPaths(repo, treeA, treeB) {
  const read = treeReader(repo), changes = [];
  const walk = async (path, a, b) => {
    if (same(a, b)) return;
    const aTree = a?.type === 'tree', bTree = b?.type === 'tree';
    if (a && b && !aTree && !bTree) return changes.push({ path, change: 'modified' });
    if (a && !aTree) changes.push({ path, change: 'deleted' });
    if (b && !bTree) changes.push({ path, change: 'added' });
    if (!aTree && !bTree) return;
    const [before, after] = await Promise.all([named(read, aTree ? a.hash : null), named(read, bTree ? b.hash : null)]);
    await Promise.all([...new Set([...before.keys(), ...after.keys()])].map(name => walk(child(path, name), before.get(name), after.get(name))));
  };
  await walk('', wrap(treeA), wrap(treeB));
  return changes.sort(byPath);
}
