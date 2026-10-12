import { Fault, deny } from './common.mjs';
import { sha } from './git.mjs';

export async function fileIndex(repo, commitId, readTree, literalPath) {
  const commit = await repo.readCommit(commitId);
  if (!commit) deny();
  if (!sha(commit.treeHash)) throw Error('Invalid file index commit');
  const pending = [{ hash: commit.treeHash, prefix: '', depth: 0 }], paths = [], cache = new Map();
  let directories = 0, bytes = 0;
  const exhausted = () => { throw new Fault('resource_exhausted', 429, 'File finder supports up to 10,000 files, 512 folders and 1 MiB of paths. Browse folders for this larger snapshot.'); };
  while (pending.length) {
    const batch = pending.splice(0, 4);
    directories += batch.length;
    // shortcut: bounded on-demand index; use a durable background index for larger trees.
    if (directories > 512 || batch.some(item => item.depth > 64)) exhausted();
    const results = await Promise.allSettled(batch.map(item => {
      if (!cache.has(item.hash)) cache.set(item.hash, readTree(repo, item.hash));
      return cache.get(item.hash);
    }));
    for (const result of results) if (result.status === 'rejected') throw result.reason;
    for (const [i, result] of results.entries()) for (const entry of result.value) {
      const path = literalPath(batch[i].prefix + entry.name);
      if (entry.type === 'tree') {
        if (directories + pending.length >= 512) exhausted();
        pending.push({ hash: entry.hash, prefix: path + '/', depth: batch[i].depth + 1 });
      } else if (entry.type !== 'gitlink') {
        bytes += new TextEncoder().encode(path).length;
        if (paths.length >= 10000 || bytes > 1024 * 1024) exhausted();
        paths.push(path);
      }
    }
  }
  return paths.sort();
}
