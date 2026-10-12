import { sha, validRef } from './git.mjs';
import { deny, invalid, Fault, page } from './common.mjs';

export function wireCommit(value) {
  if (!value || !sha(value.hash) || typeof value.message !== 'string' || typeof value.author?.name !== 'string' || !Number.isSafeInteger(value.authoredAt) || !Number.isFinite(new Date(value.authoredAt * 1000).getTime())) throw Error('Invalid commit metadata');
  return { sha: value.hash, message: value.message, authorName: value.author.name, authoredAt: new Date(value.authoredAt * 1000).toISOString() };
}
async function pathObject(repo, commit, path) {
  let hash = commit.treeHash, object = { hash, type: 'tree', mode: '40000' };
  if (!sha(hash)) throw Error('Invalid tree');
  for (const name of path.split('/').filter(Boolean)) {
    if (object.type !== 'tree') return null;
    const entries = await repo.readTree(object.hash);
    if (!entries || entries.length > 1000) throw new Fault('resource_exhausted', 429, 'History tree exceeds its read bound.');
    object = entries.find(e => e.name === name);
    if (!object) return null;
    if (!sha(object.hash)) throw Error('Invalid object');
  }
  return JSON.stringify([object.hash, object.type, object.mode]);
}
export async function commits(repo, body, row, resolveRef, literalPath) {
  const paging = page(body), path = literalPath(body.path || ''), selected = body.ref || row.default_branch;
  if ((body.repositoryId || path) && (!sha(selected) || body.repositoryId !== String(row.id))) invalid('Select this repository identity and immutable commit for path history.');
  if (!sha(selected) && !validRef('refs/heads/' + selected)) invalid('Select a valid branch or immutable commit.');
  const hash = sha(selected) ? selected : await resolveRef(selected);
  if (!hash || !await repo.readCommit(hash)) deny();
  const receipt = body.repositoryId ? { repositoryId: String(row.id), commitId: hash, path } : {};
  if (!path) {
    const values = await repo.log({ ref: hash, limit: paging.limit + 1, offset: paging.offset });
    if (!Array.isArray(values) || values.length > paging.limit + 1) throw Error('Invalid commit inventory');
    return { ...receipt, commits: values.slice(0, paging.limit).map(wireCommit), page: { nextPage: values.length > paging.limit ? paging.number + 1 : 0 } };
  }
  // shortcut: bounded first-parent history; use a DAG index before wider path scans.
  const history = await repo.log({ ref: hash, limit: 500 });
  if (!Array.isArray(history) || history.length > 500 || history.some(value => !sha(value.hash))) throw Error('Invalid immutable history inventory');
  const known = new Map(history.map(value => [value.hash, value]));
  const readCommit = ref => known.get(ref) || repo.readCommit(ref);
  const found = []; let ref = hash, scanned = 0;
  while (ref && found.length <= paging.offset + paging.limit) {
    if (++scanned > 500) throw new Fault('resource_exhausted', 429, 'Path history exceeds its scan bound.');
    const current = await readCommit(ref);
    if (!current || current.hash !== ref || !Array.isArray(current.parents) || current.parents.some(p => !sha(p))) throw Error('Invalid commit chain');
    const parent = current.parents[0] ? await readCommit(current.parents[0]) : null;
    if (current.parents[0] && !parent) throw Error('Missing parent commit');
    const object = await pathObject(repo, current, path), previous = parent ? await pathObject(repo, parent, path) : null;
    if (object !== previous) found.push(wireCommit(current));
    ref = current.parents[0];
  }
  return { ...receipt, commits: found.slice(paging.offset, paging.offset + paging.limit), page: { nextPage: found.length > paging.offset + paging.limit ? paging.number + 1 : 0 } };
}

export async function resolveSource(repo, body, row, getRefs, literalPath) {
  const prefix = 'REPOSITORY_SOURCE_REF_KIND_', kinds = ['UNSPECIFIED', 'DEFAULT_BRANCH', 'BRANCH', 'TAG', 'COMMIT'];
  const make = async (kind, name, path, refs) => {
    const ref = (kind === 'TAG' ? 'refs/tags/' : 'refs/heads/') + name;
    const hash = kind === 'COMMIT' ? name : refs.get(ref + '^{}') || refs.get(ref);
    if (!sha(hash) || !await repo.readCommit(hash)) return null;
    return { selection: { kind: prefix + kind, name, commitId: hash, ...(kind === 'TAG' ? { tagObjectId: refs.get(ref) } : {}) }, path };
  };
  const receipt = { repository: body.repository, repositoryId: String(row.id) };
  if (body.suffix) {
    if (body.selector || body.path) invalid('Readable source suffix cannot be mixed with a selector or path.');
    const suffix = literalPath(body.suffix), refs = await getRefs(), candidates = [];
    const first = suffix.split('/')[0];
    if (sha(first)) { const candidate = await make('COMMIT', first, suffix.slice(first.length + 1), refs); if (candidate) candidates.push(candidate); }
    for (const [ref] of refs) {
      if (ref.endsWith('^{}') || !ref.startsWith('refs/heads/') && !ref.startsWith('refs/tags/')) continue;
      const name = ref.slice(ref.startsWith('refs/heads/') ? 11 : 10);
      if (suffix !== name && !suffix.startsWith(name + '/')) continue;
      if (candidates.length >= 32) throw new Fault('resource_exhausted', 429, 'Source address exceeds its ambiguity bound.');
      const candidate = await make(ref.startsWith('refs/tags/') ? 'TAG' : 'BRANCH', name, suffix.slice(name.length + 1), refs);
      if (candidate) candidates.push(candidate);
    }
    if (!candidates.length) deny();
    return candidates.length === 1 ? { ...receipt, suffix, resolution: 'REPOSITORY_SOURCE_RESOLUTION_RESOLVED', candidates, ...candidates[0] } :
      { ...receipt, suffix, resolution: 'REPOSITORY_SOURCE_RESOLUTION_AMBIGUOUS', candidates };
  }
  const requested = body.selector || { kind: prefix + 'DEFAULT_BRANCH' }, kind = typeof requested.kind === 'number' ? kinds[requested.kind] : requested.kind?.replace(prefix, '');
  if (!kinds.includes(kind) || kind === 'UNSPECIFIED') invalid('Select a branch, tag or immutable commit.');
  const name = kind === 'DEFAULT_BRANCH' ? row.default_branch : requested.name, path = literalPath(body.path || '');
  if (kind === 'COMMIT' ? !sha(name) : !validRef((kind === 'TAG' ? 'refs/tags/' : 'refs/heads/') + name)) invalid('Invalid source ref.');
  const selected = await make(kind, name, path, kind === 'COMMIT' ? new Map() : await getRefs());
  if (!selected) deny();
  return { ...receipt, ...selected, resolution: 'REPOSITORY_SOURCE_RESOLUTION_RESOLVED' };
}
