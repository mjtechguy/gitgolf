import { Fault, deny } from './common.mjs';
import { sha } from './git.mjs';

const exhausted = () => { throw new Fault('resource_exhausted', 429, 'Comparison exceeds its native read limit.'); };
async function pair(left, right) {
  // Provider handles stay alive until both independent reads finish, including failures.
  const results = await Promise.allSettled([left, right]);
  for (const result of results) if (result.status === 'rejected') throw result.reason;
  return results.map(result => result.value);
}
export async function comparison(repo, base, head) {
  // A linear proposal needs only the divergent segment, even on a very old repository.
  // Stop at merges; guessing through one parent would omit changes on another parent.
  const objects = new Map();
  const cached = { readCommit(hash) {
    if (!objects.has(hash)) objects.set(hash, Promise.resolve().then(async () => {
      const commit = await repo.readCommit(hash);
      if (!commit) deny();
      if (commit.hash !== hash || !sha(commit.treeHash) || !Array.isArray(commit.parents) || commit.parents.some(p => !sha(p))) throw Error('Invalid commit graph');
      return commit;
    }));
    return objects.get(hash);
  } };
  const headPath = new Map();
  let cursor = head;
  for (let count = 0; count < 64; count++) {
    if (cursor === base) { await cached.readCommit(base); return { mergeBase: base, commits: [...headPath.values()] }; }
    if (headPath.has(cursor)) throw Error('Invalid cyclic commit graph');
    const commit = await cached.readCommit(cursor);
    headPath.set(cursor, commit);
    if (commit.parents.length !== 1) break;
    cursor = commit.parents[0];
  }
  const basePath = new Set();
  cursor = base;
  for (let count = 0; count < 64; count++) {
    if (headPath.has(cursor)) {
      const commits = [];
      for (const [hash, commit] of headPath) { if (hash === cursor) break; commits.push(commit); }
      return { mergeBase: cursor, commits };
    }
    if (basePath.has(cursor)) throw Error('Invalid cyclic commit graph');
    basePath.add(cursor);
    const commit = await cached.readCommit(cursor);
    if (commit.parents.length !== 1) break;
    cursor = commit.parents[0];
  }
  const { bases, commits } = await paintDown(cached, base, head);
  if (!bases.length) throw new Fault('failed_precondition', 412, 'The selected commits have no common ancestor.');
  // A candidate below another candidate is not a merge base (Git's remove_redundant).
  const best = [];
  for (const candidate of bases) {
    let redundant = false;
    for (const other of bases) if (other !== candidate && (await paintDown(cached, candidate, other)).bases.includes(candidate)) { redundant = true; break; }
    if (!redundant) best.push(candidate);
  }
  if (best.length !== 1) throw new Fault('unimplemented', 501, 'This comparison requires multiple merge bases.');
  return { mergeBase: best[0], commits };
}

// Merge bases by Git's own walk (paint_down_to_common): newest first by commit time, the ancestors of each tip painted with its
// side. A commit both sides reach is a candidate, and everything below it is stale. The walk ends when only stale commits are queued,
// so it reads the history between the tips and their merge bases, not the whole repository. Commit times only order the walk; a
// skewed clock costs reads, not correctness. The commits painted only from the head are the ones the head adds.
const fromHead = 1, fromBase = 2, stale = 4, result = 8, walkLimit = 2000;
async function paintDown(cached, base, head) {
  const flags = new Map(), queue = [], read = new Set();
  const load = hash => { if (!read.has(hash)) { if (read.size >= walkLimit) exhausted(); read.add(hash); } return cached.readCommit(hash); };
  const put = commit => {
    // Newest first; equal times keep arrival order.
    const time = Number(commit.authoredAt) || 0;
    let at = queue.length;
    while (at > 0 && queue[at - 1].time < time) at--;
    queue.splice(at, 0, { commit, time });
  };
  const paint = async (hashes, flag) => {
    const next = hashes.filter(hash => ((flags.get(hash) || 0) & flag) !== flag);
    const commits = await Promise.all(next.map(load));
    next.forEach((hash, i) => { flags.set(hash, (flags.get(hash) || 0) | flag); put(commits[i]); });
  };
  await paint([head], fromHead); await paint([base], fromBase);
  const bases = [];
  while (queue.some(entry => !(flags.get(entry.commit.hash) & stale))) {
    const { commit } = queue.shift();
    let flag = flags.get(commit.hash) & (fromHead | fromBase | stale);
    if (flag === (fromHead | fromBase)) {
      if (!(flags.get(commit.hash) & result)) { flags.set(commit.hash, flags.get(commit.hash) | result); bases.push(commit.hash); }
      flag |= stale;
    }
    await paint(commit.parents, flag);
  }
  // A commit painted only from the head may still lie below a candidate the walk stopped short of. Stale commits keep painting while
  // they are not older than the oldest such commit: a parent is not newer than its child, so an older one cannot reach it.
  const headOnly = () => [...flags].filter(([, flag]) => (flag & (fromHead | fromBase)) === fromHead).map(([hash]) => hash);
  const times = new Map();
  for (let pending = headOnly(); pending.length && queue.length; pending = headOnly()) {
    for (const hash of pending) if (!times.has(hash)) times.set(hash, Number((await cached.readCommit(hash)).authoredAt) || 0);
    const { commit, time } = queue.shift();
    if (time < Math.min(...pending.map(hash => times.get(hash)))) break;
    await paint(commit.parents, flags.get(commit.hash) & (fromHead | fromBase | stale));
  }
  const commits = await Promise.all(headOnly().map(hash => cached.readCommit(hash)));
  return { bases: bases.filter(hash => !(flags.get(hash) & stale)), commits };
}

// Git C quoting keeps unusual UTF-8 filenames out of patch header syntax.
function quote(value) {
  if (/^[\x21-\x7e]+$/.test(value) && !/["\\]/.test(value)) return value;
  return '"' + [...new TextEncoder().encode(value)].map(b => b === 34 ? '\\"' : b === 92 ? '\\\\' : b >= 32 && b < 127 ? String.fromCharCode(b) : '\\' + b.toString(8).padStart(3, '0')).join('') + '"';
}
function lines(text) {
  if (!text) return [];
  const values = text.split('\n'); if (text.endsWith('\n')) values.pop();
  return values;
}
function hunk(oldText, newText) {
  const old = lines(oldText), next = lines(newText); let prefix = 0, suffix = 0;
  const same = (a, b) => old[a] === next[b] && (a < old.length - 1 || oldText.endsWith('\n')) === (b < next.length - 1 || newText.endsWith('\n'));
  while (prefix < old.length && prefix < next.length && same(prefix, prefix)) prefix++;
  while (suffix < old.length - prefix && suffix < next.length - prefix && same(old.length - suffix - 1, next.length - suffix - 1)) suffix++;
  const start = Math.max(0, prefix - 3), context = Math.min(3, suffix), oldEnd = old.length - suffix + context, newEnd = next.length - suffix + context;
  const oldCount = oldEnd - start, newCount = newEnd - start;
  let patch = `@@ -${oldCount ? start + 1 : start},${oldCount} +${newCount ? start + 1 : start},${newCount} @@\n`;
  const add = (sign, values, i, text) => { patch += sign + values[i] + '\n'; if (i === values.length - 1 && !text.endsWith('\n')) patch += '\\ No newline at end of file\n'; };
  for (let i = start; i < prefix; i++) add(' ', old, i, oldText);
  for (let i = prefix; i < old.length - suffix; i++) add('-', old, i, oldText);
  for (let i = prefix; i < next.length - suffix; i++) add('+', next, i, newText);
  for (let i = 0; i < context; i++) add(' ', next, next.length - suffix + i, newText);
  return patch;
}
export async function changedFiles(repo, base, head) {
  const [left, right] = await pair(base ? repo.readCommit(base) : null, repo.readCommit(head));
  if (!right || base && !left) deny();
  if (!sha(right.treeHash) || left && !sha(left.treeHash)) throw Error('Invalid comparison trees');
  const changes = []; let trees = 0, entries = 0;
  async function tree(hash) {
    if (!hash) return new Map();
    if (++trees > 1000) exhausted();
    const values = await repo.readTree(hash);
    if (!Array.isArray(values) || (entries += values.length) > 5000) exhausted();
    const result = new Map();
    for (const entry of values) {
      if (typeof entry.name !== 'string' || !entry.name || /[\0/\\]/.test(entry.name) || ['.', '..'].includes(entry.name) || !sha(entry.hash) || !['tree', 'blob', 'exec', 'symlink', 'gitlink'].includes(entry.type) || !/^[0-7]{5,6}$/.test(entry.mode) || result.has(entry.name)) throw Error('Invalid comparison entry');
      result.set(entry.name, entry);
    }
    return result;
  }
  async function walk(a, b, path = '', depth = 0) {
    if (a === b) return;
    if (depth > 32) exhausted();
    const [old, next] = await pair(tree(a), tree(b));
    for (const name of [...new Set([...old.keys(), ...next.keys()])].sort()) {
      const l = old.get(name), r = next.get(name), file = path + name;
      if (l?.hash === r?.hash && l?.mode === r?.mode) continue;
      if (l?.type === 'tree' || r?.type === 'tree') {
        if (l && l.type !== 'tree') changes.push({ file, l });
        await walk(l?.type === 'tree' ? l.hash : null, r?.type === 'tree' ? r.hash : null, file + '/', depth + 1);
        if (r && r.type !== 'tree') changes.push({ file, r });
      } else changes.push({ file, l, r });
      if (changes.length > 256) exhausted();
    }
  }
  await walk(left?.treeHash, right.treeHash);
  return changes;
}
export async function diff(repo, base, head) {
  const changes = await changedFiles(repo, base, head); let blobBytes = 0;
  async function content(entry) {
    if (!entry) return '';
    if (entry.type === 'gitlink') return `Subproject commit ${entry.hash}\n`;
    const blob = await repo.readBlob(entry.hash);
    if (!blob || !Number.isSafeInteger(blob.size) || blob.size < 0) throw Error('Invalid comparison blob');
    if (blob.size > 512 * 1024 || (blobBytes += blob.size) > 2 * 1024 * 1024) exhausted();
    const bytes = new Uint8Array(await blob.arrayBuffer());
    if (bytes.length !== blob.size) throw Error('Invalid comparison size');
    if (bytes.includes(0)) return null;
    try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { return null; }
  }
  let rawDiff = '', byteSize = 0;
  for (const { file, l, r } of changes) {
    const a = quote('a/' + file), b = quote('b/' + file);
    let patch = `diff --git ${a} ${b}\n`;
    if (!l) patch += `new file mode ${r.mode}\n`;
    else if (!r) patch += `deleted file mode ${l.mode}\n`;
    else if (l.mode !== r.mode) patch += `old mode ${l.mode}\nnew mode ${r.mode}\n`;
    patch += `index ${l?.hash || '0'.repeat(40)}..${r?.hash || '0'.repeat(40)}${l && r && l.mode === r.mode ? ' ' + r.mode : ''}\n`;
    if (l?.hash !== r?.hash) {
      const [old, next] = await pair(content(l), content(r));
      patch += old === '' && next === '' ? '' : old === null || next === null ? `Binary files ${l ? a : '/dev/null'} and ${r ? b : '/dev/null'} differ\n` :
        `--- ${l ? a : '/dev/null'}\n+++ ${r ? b : '/dev/null'}\n` + hunk(old, next);
    }
    byteSize += new TextEncoder().encode(patch).length; if (byteSize > 512 * 1024) exhausted();
    rawDiff += patch;
  }
  return { rawDiff, byteSize };
}
