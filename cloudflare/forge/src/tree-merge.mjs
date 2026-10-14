// Path-level three-way tree merge and tree comparison. Subtrees with equal hashes are never read.
import { emptyTree, treeObject, treeReader } from './git-objects.mjs';

const same = (a, b) => a ? Boolean(b) && a.type === b.type && a.hash === b.hash : !b;
const directory = entry => !entry || entry.type === 'tree';
const wrap = hash => hash && hash !== emptyTree ? { type: 'tree', hash } : null;
const child = (path, name) => path ? path + '/' + name : name;
const byPath = (a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
const named = async (read, hash) => new Map((await read(hash)).map(entry => [entry.name, entry]));

// One side changed: take it. Both changed identically: take it once. Both changed differently: conflict, with no
// line-level merging. Mode changes count as changes. Conflict reasons: both_modified, both_added, deleted_by_us,
// deleted_by_them, file_directory. With conflicts there is no tree and no objects.
export async function mergeTrees(repo, baseTree, oursTree, theirsTree) {
  const read = treeReader(repo), objects = new Map(), conflicts = [];
  const entry = async (path, base, ours, theirs) => {
    if (same(ours, theirs)) return ours;
    if (same(base, ours)) return theirs;
    if (same(base, theirs)) return ours;
    // Both sides hold a directory (or deleted one): merge inside it; a replaced base file merges as an empty directory.
    if (directory(ours) && directory(theirs)) {
      const hash = await merge(path, base?.type === 'tree' ? base.hash : null, ours?.hash, theirs?.hash);
      return hash && { type: 'tree', hash };
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
