// Source API reads beyond files and tree (docs/SOURCE_API.md, AM-6): blame a file along its first-parent history, and search a commit for
// exact text or a regular expression. Both read immutable objects through the request's repository handle (repository-cache.mjs) and stop
// at named bounds, saying so. Web APIs only.
import { Fault, invalid } from './common.mjs';
import { sha } from './git.mjs';
import { treeReader } from './git-objects.mjs';
import { commitAt, entryAt, listTree, Refused } from './source-api.mjs';
import { lineMatches, splitLines } from './line-diff.mjs';

const KiB = 1024, MiB = 1024 * KiB;
export const readLimits = { blameFile: MiB, blameRead: 4 * MiB, blameCommits: 500, grepFile: MiB, grepRead: 32 * MiB, grepFiles: 5000, grepEntries: 50000,
  grepResults: 500, grepDefaultResults: 100, grepText: 400, grepTime: 10000, literal: 1000, globs: 20 };
const textTypes = new Set(['blob', 'exec', 'symlink']);

// One character per byte, so line ends and lengths are byte-exact whatever the encoding.
function byteString(bytes) {
  let text = '';
  for (let i = 0; i < bytes.length; i += 0x8000) text += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return text;
}
async function blobBytes(repo, hash) {
  const blob = await repo.readBlob(hash);
  if (!blob || !Number.isSafeInteger(blob.size)) throw Error('Missing blob ' + hash);
  return blob;
}
function lineArgument(value, field) {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || value < 1) invalid(`${field} is a line number from 1.`);
  return value;
}

// ---------- blame ----------
// Walks first parents from the ref. At each commit the file's lines are diffed against the parent's version (line-diff.mjs, as git blame
// does): unchanged lines pass to the parent, the rest belong to the commit. The walk ends when every line has its commit, at a root commit
// or where the file does not exist in the parent (renames are not followed), or at a bound: 500 commits compared, or 4 MiB of file
// versions read. Lines still open at a bound belong to the commit the walk stopped at, with complete: false and the reason.
export async function blame(env, repo, row, body, ctx) {
  const path = ctx.literalPath(body.path);
  if (!path) invalid('Name a file path to blame.');
  const startLine = lineArgument(body.startLine, 'startLine'), endLine = lineArgument(body.endLine, 'endLine');
  if (startLine && endLine && endLine < startLine) invalid('endLine comes before startLine.');
  const head = await commitAt(env, repo, row, body.ref, ctx), read = treeReader(repo);
  const entry = await entryAt(read, head.treeHash, path);
  if (!entry) throw new Fault('not_found', 404, 'The path does not exist at this commit.');
  if (!textTypes.has(entry.type)) invalid(entry.type === 'tree' ? 'The path is a directory; blame a file.' : 'The path is a submodule; blame a file.');
  const blob = await blobBytes(repo, entry.hash);
  if (blob.size > readLimits.blameFile) throw new Fault('resource_exhausted', 413, 'Blame is limited to files of 1 MiB.');
  const bytes = new Uint8Array(await blob.arrayBuffer());
  if (bytes.includes(0)) throw new Refused('invalid_argument', 400, 'The file is binary (it contains a NUL byte); blame reads text files.', { reason: 'binary' });
  let text = byteString(bytes);
  const count = splitLines(text).length, first = startLine || 1, last = Math.min(endLine || count, count);
  if (count && first > count) invalid(`startLine is past the end of the file (${count} lines).`);
  const owners = new Array(count ? last - first + 1 : 0);
  let pending = Array.from(owners, (_, index) => ({ index, at: first - 1 + index }));
  let current = head, hash = entry.hash, examined = 0, budget = readLimits.blameRead - bytes.length, reason;
  const known = new Map(), commitOf = async id => {
    if (!known.has(id)) {
      // First-parent history arrives in pages from the provider's log where it has one; otherwise commit by commit.
      try { for (const value of await repo.log({ ref: id, limit: 100 }) || []) if (value && sha(value.hash)) known.set(value.hash, value); } catch { /* read singly */ }
      if (!known.has(id)) known.set(id, await repo.readCommit(id));
    }
    const value = known.get(id);
    if (!value || value.hash !== id || !sha(value.treeHash) || !Array.isArray(value.parents) || value.parents.some(parent => !sha(parent))) throw Error('Invalid commit chain');
    return value;
  };
  const settle = owner => { for (const line of pending) owners[line.index] = owner; pending = []; };
  while (pending.length) {
    const parentId = current.parents[0];
    if (!parentId) { settle(current); break; }
    if (examined >= readLimits.blameCommits) { reason = 'history_bound'; settle(current); break; }
    const parent = await commitOf(parentId), before = await entryAt(read, parent.treeHash, path);
    // Not in the parent (added here, or renamed: renames are not followed), or not a file there.
    if (!before || !textTypes.has(before.type)) { examined++; settle(current); break; }
    if (before.hash !== hash) {
      const older = await blobBytes(repo, before.hash);
      if (older.size > budget) { reason = 'read_bound'; settle(current); break; }
      budget -= older.size; examined++;
      const olderText = byteString(new Uint8Array(await older.arrayBuffer())), { map } = lineMatches(olderText, text), still = [];
      for (const line of pending) { if (map[line.at] < 0) owners[line.index] = current; else { line.at = map[line.at]; still.push(line); } }
      pending = still; text = olderText; hash = before.hash;
    } else examined++;
    current = parent;
  }
  // Consecutive lines of one commit form a range; each commit is described once, in order of first appearance.
  const ranges = [], commits = new Map();
  owners.forEach((owner, index) => {
    const line = first + index, previous = ranges.at(-1);
    if (previous && previous.commitId === owner.hash && previous.end === line - 1) previous.end = line;
    else ranges.push({ start: line, end: line, commitId: owner.hash });
    if (!commits.has(owner.hash)) commits.set(owner.hash, { commitId: owner.hash, author: typeof owner.author?.name === 'string' ? owner.author.name : '',
      authoredAt: Number.isSafeInteger(owner.authoredAt) ? new Date(owner.authoredAt * 1000).toISOString() : null, summary: String(owner.message || '').split('\n')[0] });
  });
  return { repositoryId: String(row.id), commitId: head.hash, path, lineCount: count, startLine: count ? first : 0, endLine: count ? last : 0, ranges, commits: [...commits.values()],
    complete: !reason, examinedCommits: examined, ...(reason ? { reason } : {}), limits: { fileBytes: readLimits.blameFile, readBytes: readLimits.blameRead, commits: readLimits.blameCommits } };
}

// ---------- grep ----------
// Path globs: * within one path segment, ** across segments, ? one character; a pattern without wildcards names a file or a directory.
function globMatcher(globs) {
  if (globs === undefined) return () => true;
  if (!Array.isArray(globs) || !globs.length || globs.length > readLimits.globs) invalid('paths lists 1 to 20 path globs.');
  const tests = globs.map(glob => {
    if (typeof glob !== 'string' || !glob || glob.length > 300 || /[\x00-\x1f\\]/.test(glob)) invalid('A path glob is 1 to 300 characters without control characters or backslash.');
    const clean = glob.replace(/^\/+|\/+$/g, '');
    if (!clean) return () => true;
    if (!/[*?]/.test(clean)) return path => path === clean || path.startsWith(clean + '/');
    let source = '';
    for (let i = 0; i < clean.length; i++) {
      const c = clean[i];
      if (c === '*' && clean[i + 1] === '*') {
        const slashBefore = i === 0 || clean[i - 1] === '/', slashAfter = clean[i + 2] === '/' || i + 2 === clean.length;
        if (slashBefore && clean[i + 2] === '/') { source += '(?:.*/)?'; i += 2; continue; }
        if (slashBefore && slashAfter) { source += '.*'; i += 1; continue; }
        source += '[^/]*'; i += 1; continue;
      }
      source += c === '*' ? '[^/]*' : c === '?' ? '[^/]' : c.replace(/[.+^${}()|[\]]/g, '\\$&');
    }
    // A glob may also name a directory: everything under a matching directory matches.
    const pattern = new RegExp('^' + source + '(?:/.*)?$');
    return path => pattern.test(path);
  });
  return path => tests.some(test => test(path));
}

function matcher(body) {
  const { pattern } = body, regex = body.regex ?? false, caseSensitive = body.caseSensitive ?? true;
  if (typeof regex !== 'boolean' || typeof caseSensitive !== 'boolean') invalid('regex and caseSensitive are true or false.');
  const max = readLimits.literal;
  if (typeof pattern !== 'string' || !pattern || pattern.length > max) invalid(`pattern is 1 to ${max} characters.`);
  if (/[\n\0]/.test(pattern)) invalid('pattern matches within one line; it cannot contain a newline or NUL.');
  if (!regex && caseSensitive) return line => line.indexOf(pattern);
  let expression;
  // A regular expression would run inside the workspace that serves every request, and JavaScript's engine can backtrack for
  // seconds on a hostile pattern; until the scan runs outside it, only literal search (linear) is offered.
  if (regex) throw new Refused('invalid_argument', 400, 'Regular-expression search is not available yet: a slow pattern would stall the workspace that serves every request. Use a literal pattern, with caseSensitive: false if needed.', { reason: 'regex_unavailable' });
  expression = new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
  return line => { const found = expression.exec(line); return found ? found.index : -1; };
}

// Searches every regular and executable file at a commit (symlinks and submodules are not searched, as with git grep) in path order,
// one result per matching line. Binary files (a NUL in the first 8,000 bytes) and files over 1 MiB are skipped and counted. Stops at
// maxResults, 5,000 files read, 32 MiB read or 10 seconds, with truncated: true and the reason.
export async function grep(env, repo, row, body, ctx) {
  const find = matcher(body), selected = globMatcher(body.paths), maxResults = body.maxResults ?? readLimits.grepDefaultResults;
  if (!Number.isInteger(maxResults) || maxResults < 1 || maxResults > readLimits.grepResults) invalid('maxResults is a whole number from 1 to 500.');
  const head = await commitAt(env, repo, row, body.ref, ctx), started = Date.now();
  // A commit never changes, so the same search of it has the same answer: the isolate's object cache keeps the last 32 answers. The caller's
  // grant and token scope were checked before this point.
  const cache = env.gitObjectCache, key = JSON.stringify([env.ACCOUNT_ID, env.ARTIFACTS_NAMESPACE, row.artifact_name, head.hash, body.pattern, body.regex ?? false, body.caseSensitive ?? true, body.paths ?? null, maxResults]);
  if (cache) cache.grep ||= new Map();
  const saved = cache?.grep.get(key);
  if (saved) { cache.grep.delete(key); cache.grep.set(key, saved); return { repositoryId: String(row.id), ...JSON.parse(saved) }; }
  const listed = await listTree(treeReader(repo), head.treeHash, '', true, readLimits.grepEntries);
  const files = listed.entries.filter(([entry, path]) => (entry.type === 'blob' || entry.type === 'exec') && selected(path));
  const matches = [], skipped = { binary: 0, tooLarge: 0 };
  let searched = 0, read = 0, reason;
  // Eight files are read at a time and searched in path order, so results stay ordered by path and line whatever stops the search.
  scan: for (let index = 0; index < files.length; index += 8) {
    if (index >= readLimits.grepFiles) { reason = 'file_bound'; break; }
    // Workers clocks advance at I/O, so this is checked between reads.
    if (Date.now() - started > readLimits.grepTime) { reason = 'time_bound'; break; }
    const batch = files.slice(index, Math.min(index + 8, readLimits.grepFiles));
    const blobs = await Promise.all(batch.map(([entry]) => blobBytes(repo, entry.hash)));
    for (let b = 0; b < batch.length; b++) {
      const path = batch[b][1], blob = blobs[b];
      if (blob.size > readLimits.grepFile) { skipped.tooLarge++; continue; }
      if (read + blob.size > readLimits.grepRead) { reason = 'read_bound'; break scan; }
      read += blob.size;
      const bytes = new Uint8Array(await blob.arrayBuffer());
      if (bytes.subarray(0, 8000).includes(0)) { skipped.binary++; continue; }
      searched++;
      const lines = new TextDecoder('utf-8', { ignoreBOM: true }).decode(bytes).split('\n');
      if (lines.at(-1) === '') lines.pop();
      for (let l = 0; l < lines.length; l++) {
        const at = find(lines[l]);
        if (at < 0) continue;
        if (matches.length === maxResults) { reason = 'max_results'; break scan; }
        matches.push({ path, line: l + 1, column: at + 1, text: lines[l].slice(0, readLimits.grepText) });
      }
    }
  }
  reason ||= listed.truncated ? 'tree_bound' : undefined;
  const result = { commitId: head.hash, matches, filesSearched: searched, skipped, truncated: Boolean(reason), ...(reason ? { reason } : {}),
    limits: { maxResults, fileBytes: readLimits.grepFile, readBytes: readLimits.grepRead, files: readLimits.grepFiles } };
  const text = JSON.stringify(result);
  // A search cut short by time is not kept: another try may get further.
  if (cache && reason !== 'time_bound' && text.length <= 512 * KiB) {
    if (cache.grep.size >= 32) cache.grep.delete(cache.grep.keys().next().value);
    cache.grep.set(key, text);
  }
  return { repositoryId: String(row.id), ...result };
}
