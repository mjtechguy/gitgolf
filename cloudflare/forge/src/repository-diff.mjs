import { Fault, deny } from './common.mjs';
import { sha } from './git.mjs';

const exhausted = () => { throw new Fault('resource_exhausted', 429, 'Comparison exceeds its native read limit.'); };
async function pair(left, right) {
  // Provider handles stay alive until both independent reads finish, including failures.
  const results = await Promise.allSettled([left, right]);
  for (const result of results) if (result.status === 'rejected') throw result.reason;
  return results.map(result => result.value);
}
export async function ancestry(repo, tip) {
  const found = new Map(), pending = [tip];
  while (pending.length) {
    const hash = pending.pop();
    if (found.has(hash)) continue;
    // shortcut: bounded Git DAG reads; add an indexed graph before widening history.
    if (found.size >= 500) exhausted();
    const commit = await repo.readCommit(hash);
    if (!commit) deny();
    if (commit.hash !== hash || !sha(commit.treeHash) || !Array.isArray(commit.parents) || commit.parents.some(p => !sha(p))) throw Error('Invalid commit graph');
    found.set(hash, commit); pending.push(...commit.parents);
  }
  return found;
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
  const [older, newer] = await pair(ancestry(cached, base), ancestry(cached, head));
  const common = new Set([...older.keys()].filter(hash => newer.has(hash)));
  if (!common.size) throw new Fault('failed_precondition', 412, 'The selected commits have no common ancestor.');
  const best = new Set(common), visited = new Set(), pending = [...common].flatMap(hash => older.get(hash).parents);
  while (pending.length) {
    const hash = pending.pop(); if (visited.has(hash)) continue;
    visited.add(hash); best.delete(hash); pending.push(...older.get(hash).parents);
  }
  if (best.size !== 1) throw new Fault('unimplemented', 501, 'This comparison requires multiple merge bases.');
  return { mergeBase: [...best][0], commits: [...newer.values()].filter(c => !older.has(c.hash)) };
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
