// Source API (docs/SOURCE_API.md, AM-2): commit, branch, files and tree as JSON, without a clone. A commit is built from exact Git
// objects (git-objects.mjs), sent as one receive-pack ref update through the branch fence (ref-writes.mjs) under the caller's current
// authority, and confirmed by reading the branch back, like a brokered push. Web APIs only.
import { digest, uuidOK, reply, Fault, invalid, conflict } from './common.mjs';
import { advertisedRefs, gitRequest, receiveStatus, refusedRef, sha, validRef } from './git.mjs';
import { GitTreeError, commitObject, emptyTree, packObjects, planTreeEdit, treeReader, treeModes } from './git-objects.mjs';
import { mergeTrees, changedPaths } from './tree-merge.mjs';
import { reserveRefWrite, finishRefWrite, sendRefUpdate } from './ref-writes.mjs';
import { receiveRequest } from './pull-merge.mjs';
import { enforceGitRules } from './repository-rules.mjs';
import { gitCredentialSQL } from './git-credentials.mjs';
import { recordPipelineIntake, dispatchPipelineIntake } from './actions-intake.mjs';
import { pipelinePolicy } from './pipeline-policy.mjs';
import { requireScope } from './token-scope.mjs';

export const sourceActions = new Set(['commit', 'branch', 'files', 'tree']);
const MiB = 1024 * 1024, limits = { changes: 500, total: 8 * MiB, file: 4 * MiB, message: 64 * 1024, paths: 100, inline: MiB, read: 4 * MiB, entries: 10000, attempts: 3 };
const zero = '0'.repeat(40), encoder = new TextEncoder(), decoder = new TextDecoder();
const kinds = { __proto__: null, blob: 'file', exec: 'executable', symlink: 'symlink', tree: 'directory', gitlink: 'submodule' };
const modeTypes = Object.fromEntries(Object.entries(treeModes).map(([type, mode]) => [mode, type]));

// A refusal whose JSON body carries more than code and message (currentHead, conflicts).
class Refused extends Fault { constructor(code, status, message, detail = {}) { super(code, status, message); this.detail = detail; } }
const tooLarge = message => { throw new Fault('resource_exhausted', 413, message); };

export async function sourceCapability(db) {
  const ready = (await db.prepare('PRAGMA table_info(source_commits)').all()).results.length > 0;
  return { id: 'repository.source-api', label: 'Source API', state: ready ? 'CAPABILITY_STATE_READY' : 'CAPABILITY_STATE_DISABLED',
    reason: ready ? 'POST /native/source/commit, branch, files and tree: commit up to 500 changes (8 MiB) to a branch without a clone, with an expected head, optional path-level merge onto a moved branch and idempotency keys; read files and trees at a commit. Branch rules, the branch write fence and pipeline intake apply as for a push. Line-level merging is not available.'
      : 'Apply the schema 38 migration to use the Source API.' };
}

// row: authorizedRepository's row (grant role, access version). ctx: { withArtifact, providerFetch, literalPath, ciState }.
export async function sourceAPI(db, env, person, row, action, body, ctx) {
  if (!sourceActions.has(action)) invalid('Use commit, branch, files or tree.');
  try {
    if (action === 'files' || action === 'tree') {
      requireScope(person, row.id);
      return await ctx.withArtifact(env, row, repo => (action === 'files' ? files : tree)(env, repo, row, body, ctx));
    }
    return await (action === 'commit' ? commit : branch)(db, env, person, row, body, ctx);
  } catch (error) {
    if (error instanceof Refused) return reply({ code: error.code, message: error.message, ...error.detail }, error.status);
    if (error instanceof GitTreeError) return reply({ code: 'invalid_argument', message: `${error.message} Path: ${error.path}`, path: error.path, reason: error.code }, 400);
    throw error;
  }
}

const refsOf = async (env, repo, row, providerFetch) => advertisedRefs((await gitRequest(env, repo, row.artifact_name, 'info/refs?service=git-upload-pack', 'git-upload-pack', null, providerFetch)).bytes);
const branchName = (value, field = 'branch') => {
  if (typeof value !== 'string' || value.startsWith('refs/') || !validRef('refs/heads/' + value)) invalid(`Use a short branch name for ${field}, for example agent/fix-login.`);
  return value;
};
const writer = row => { if (!['write', 'admin'].includes(row.role)) throw new Fault('permission_denied', 403, 'Writing needs a write or admin grant on this repository.'); };

// ---------- reads ----------
async function commitAt(env, repo, row, ref, ctx) {
  const name = ref === undefined || ref === '' ? row.default_branch : ref;
  if (typeof name !== 'string' || !sha(name) && !validRef(name.startsWith('refs/') ? name : 'refs/heads/' + name)) invalid('Use a branch, a tag or a full 40-character commit ID for ref.');
  let hash = sha(name) ? name : null;
  if (!hash) {
    const refs = await refsOf(env, repo, row, ctx.providerFetch), peeled = ref => refs.get(ref + '^{}') || refs.get(ref);
    hash = name.startsWith('refs/') ? peeled(name) : refs.get('refs/heads/' + name) || peeled('refs/tags/' + name);
  }
  const value = hash && await repo.readCommit(hash);
  if (!value || value.hash !== hash || !sha(value.treeHash)) throw new Fault('not_found', 404, 'The ref does not name a commit in this repository.');
  return value;
}
async function entryAt(read, treeHash, path) {
  let entry = { type: 'tree', hash: treeHash };
  for (const part of path ? path.split('/') : []) {
    if (entry.type !== 'tree') return null;
    entry = (await read(entry.hash)).find(item => item.name === part);
    if (!entry) return null;
  }
  return entry;
}
const wireEntry = (entry, path) => ({ path, type: kinds[entry.type], mode: treeModes[entry.type].padStart(6, '0'), sha: entry.hash });
function base64(bytes) {
  let text = '';
  for (let i = 0; i < bytes.length; i += 0x8000) text += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(text);
}

async function files(env, repo, row, body, ctx) {
  if (!Array.isArray(body.paths) || !body.paths.length || body.paths.length > limits.paths) invalid('Ask for 1 to 100 paths (limit: 100 paths per call).');
  const paths = body.paths.map(path => { if (path === '') invalid('Name a file path, not the repository root.'); return ctx.literalPath(path); });
  if (new Set(paths).size !== paths.length) invalid('A path appears more than once.');
  const value = await commitAt(env, repo, row, body.ref, ctx), read = treeReader(repo), result = [];
  let budget = limits.read;
  // Eight paths are read at a time and settled in request order: the 4 MiB total is spent in that order, and a file that no longer
  // fits is named, not cut.
  for (let i = 0; i < paths.length; i += 8) {
    const found = await Promise.all(paths.slice(i, i + 8).map(async path => {
      const entry = await entryAt(read, value.treeHash, path);
      return { path, entry, blob: entry && ['blob', 'exec', 'symlink'].includes(entry.type) ? await repo.readBlob(entry.hash) : null };
    }));
    for (const { path, entry, blob } of found) {
      if (!entry) { result.push({ path, skipped: 'missing' }); continue; }
      const item = wireEntry(entry, path);
      result.push(item);
      if (entry.type === 'tree' || entry.type === 'gitlink') { item.skipped = entry.type === 'tree' ? 'directory' : 'submodule'; continue; }
      if (!blob || !Number.isSafeInteger(blob.size)) throw Error('Missing blob ' + entry.hash);
      item.size = blob.size;
      if (blob.size > limits.inline) { item.skipped = 'too_large'; continue; }
      if (blob.size > budget) { item.skipped = 'total_limit'; continue; }
      budget -= blob.size;
      const bytes = new Uint8Array(await blob.arrayBuffer());
      let text;
      if (!bytes.includes(0)) try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { /* binary */ }
      if (text === undefined) item.contentBase64 = base64(bytes); else item.content = text;
    }
  }
  return { repositoryId: String(row.id), commitId: value.hash, files: result, limits: { inlineBytes: limits.inline, totalBytes: limits.read } };
}

async function tree(env, repo, row, body, ctx) {
  const path = ctx.literalPath(body.path ?? ''), recursive = body.recursive ?? true;
  if (typeof recursive !== 'boolean') invalid('recursive is true or false.');
  const value = await commitAt(env, repo, row, body.ref, ctx), read = treeReader(repo);
  const root = await entryAt(read, value.treeHash, path);
  if (!root) throw new Fault('not_found', 404, 'The path does not exist at this commit.');
  if (root.type !== 'tree') invalid('The path is a file; list a directory.');
  const entries = []; let truncated = false, level = [[root.hash, path]];
  // Breadth first, eight directory reads at a time, stopping at 10,000 entries.
  walk: while (level.length) {
    const next = [];
    for (let i = 0; i < level.length; i += 8) {
      for (const [list, prefix] of await Promise.all(level.slice(i, i + 8).map(async ([hash, prefix]) => [await read(hash), prefix]))) for (const entry of list) {
        if (entries.length >= limits.entries) { truncated = true; break walk; }
        const child = prefix ? prefix + '/' + entry.name : entry.name;
        entries.push(wireEntry(entry, child));
        if (recursive && entry.type === 'tree') next.push([entry.hash, child]);
      }
    }
    level = next;
  }
  entries.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  return { repositoryId: String(row.id), commitId: value.hash, path, entries, truncated, limit: limits.entries };
}

// ---------- writes ----------
// The push fence's authority, as for /git/ pushes: current writer grant, access and identity generations, the rules version the request
// was checked against and a live credential. A token caller's own liveness and scope join through person.token_guard ({sql, values}).
function authority(person, row, rulesVersion) {
  const token = person.token_guard;
  return { sql: `EXISTS(SELECT 1 FROM repositories r JOIN grants g ON g.repository_id=r.id JOIN users u ON u.id=g.user_id
      LEFT JOIN repository_access_versions a ON a.repository_id=r.id LEFT JOIN native_identity_versions v ON v.user_id=u.id
      WHERE r.id=? AND r.artifact_name=? AND r.state='ACTIVE' AND g.user_id=? AND g.role IN ('write','admin') AND u.active=1
      AND COALESCE(a.version,0)=? AND COALESCE(v.version,0)=? AND COALESCE((SELECT version FROM repository_rules WHERE repository_id=r.id),0)=?
      AND (?='' OR EXISTS(SELECT 1 FROM credentials WHERE digest=? AND user_id=u.id AND revoked=0 AND expires_at>CAST(strftime('%s','now') AS INTEGER)))
      AND (?='' OR EXISTS(${gitCredentialSQL} AND c.repository_id=? AND c.mode=2)))${token ? ' AND ' + token.sql : ''}`,
    values: [row.id, row.artifact_name, person.id, row.access_version || 0, person.identity_version || 0, rulesVersion, person.credential_digest || '', person.credential_digest || '',
      person.git_credential_digest || '', person.git_credential_digest || '', row.id, ...(token?.values || [])] };
}

// One fenced ref update. 'applied' (read back), 'refused' (the provider kept the ref: a lost race) or 'busy' (another write to this ref is
// unsettled); an unknown outcome stays fenced for maintenance and is reported as unavailable.
async function write(db, env, person, row, repo, command, pack, rulesVersion, ctx, record, guard) {
  const id = crypto.randomUUID();
  if (!await reserveRefWrite(db, { id, repositoryId: row.id, userId: person.id, command, guard: guard || authority(person, row, rulesVersion) })) {
    const state = await db.prepare('SELECT write_pending,EXISTS(SELECT 1 FROM git_ref_writes WHERE repository_id=r.id AND ref=? AND outcome IS NULL) AS busy FROM repositories r WHERE id=?').bind(command.ref, row.id).first();
    if (state?.write_pending) conflict();
    if (state?.busy) return { outcome: 'busy' };
    throw new Fault('failed_precondition', 412, 'Your access to this repository or its branch rules changed during the request; nothing was sent.');
  }
  if (record) await record(id);
  let applied = false, refused = false, status = '';
  try {
    const sent = await sendRefUpdate({ command, send: () => gitRequest(env, repo, row.artifact_name, 'git-receive-pack', 'git-receive-pack', receiveRequest(command.old, command.next, command.ref, pack), ctx.providerFetch),
      read: async () => (await refsOf(env, repo, row, ctx.providerFetch)).get(command.ref) || zero });
    ({ applied, refused } = sent);
    status = sent.result ? receiveStatus(sent.result.bytes, command.ref) : '';
  } finally {
    await finishRefWrite(db, { id, repositoryId: row.id, applied, refused, ciState: ctx.ciState || 'NONE' });
  }
  if (refused) return { outcome: 'refused', status };
  if (!applied) throw new Fault('unavailable', 503, 'The update was sent but the branch did not read back as expected. Its outcome is unknown until maintenance reads it back (within minutes); writes to this branch wait until then.');
  // Actions/CI: the confirmed write is recorded before the response, as for a push.
  if (pipelinePolicy(env) && command.next !== zero) {
    try { await dispatchPipelineIntake(env, await recordPipelineIntake(db, env, row.id, 'push', { ref: command.ref, before: command.old, after: command.next, actorId: person.id, operationId: id }, 'push:' + id), ctx.withArtifact); }
    catch { console.log(JSON.stringify({ event: 'golf.pipeline_intake_record_failed' })); }
  }
  return { outcome: 'applied', id };
}

// A server-side commit of a prepared tree onto one branch, for Golf's own writes (agentic mode reverts, land-queue.mjs): the same exact
// objects, branch fence, provider readback and pipeline intake as a commit request. guard ({sql, values}) is the caller's authority,
// evaluated with the reservation; author is the commit identity ({name, email, time}); record(operationId) runs before anything is sent.
// Returns { outcome: 'applied' | 'refused' | 'busy', commitId }; an unknown outcome throws like a commit request (503).
export async function commitTree(db, env, person, row, repo, { ref, parent, treeId, objects = [], message, author, guard, record }, ctx) {
  const object = await commitObject({ tree: treeId, parents: [parent], author: { tz: '+0000', ...author }, message: message.replace(/\s+$/, '') + '\n' });
  const sent = await write(db, env, person, row, repo, { ref, old: parent, next: object.id }, await packObjects([...reachable(objects, treeId), object]), null, ctx,
    record && (id => record(id, object.id)), guard);
  return { ...sent, commitId: object.id };
}

function decodeBase64(value, path) {
  if (typeof value !== 'string' || value.length % 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) invalid(`contentBase64 must be padded standard base64. Path: ${path}`);
  if (value.length / 4 * 3 > limits.file + 2) tooLarge(`A file is limited to 4 MiB. Path: ${path}`);
  const text = atob(value), bytes = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) bytes[i] = text.charCodeAt(i);
  return bytes;
}

async function commitInput(body, literalPath) {
  const name = branchName(body.branch), expected = body.expectedHead, base = body.base ?? '', onStale = body.onStale ?? 'fail', key = body.idempotencyKey;
  if (expected !== '' && !sha(expected)) invalid('expectedHead is the 40-character head commit you edited, or "" to create the branch.');
  if (base !== '' && (expected !== '' || typeof base !== 'string' || !sha(base) && branchName(base, 'base') !== base)) invalid('base names the commit or branch a new branch starts from; it needs expectedHead "".');
  if (!['fail', 'merge'].includes(onStale)) invalid('onStale is fail or merge.');
  if (key !== undefined && !uuidOK(key)) invalid('idempotencyKey is a lowercase UUID v4.');
  const message = body.message;
  if (typeof message !== 'string' || !message.isWellFormed() || message.includes('\0') || !message.trim()) invalid('Write a commit message without NUL characters.');
  if (encoder.encode(message).length > limits.message) tooLarge('A commit message is limited to 64 KiB.');
  if (!Array.isArray(body.changes) || !body.changes.length) invalid('List at least one change.');
  if (body.changes.length > limits.changes) tooLarge('A commit is limited to 500 changes.');
  let total = 0;
  const changes = [], fingerprint = [];
  for (const change of body.changes) {
    if (!change || typeof change !== 'object' || Array.isArray(change)) invalid('Each change is an object with a path.');
    const path = literalPath(change.path);
    if (!path) invalid('A change needs a file path.');
    const unknown = Object.keys(change).find(field => !['path', 'content', 'contentBase64', 'mode', 'delete', 'from'].includes(field));
    if (unknown) invalid(`Unknown change field ${unknown.slice(0, 40)}. Path: ${path}`);
    const given = ['content', 'contentBase64', 'delete', 'from'].filter(field => change[field] !== undefined);
    if (given.length !== 1) invalid(`A change has exactly one of content, contentBase64, delete or from. Path: ${path}`);
    if (change.mode !== undefined && !['content', 'contentBase64'].includes(given[0])) invalid(`mode applies only to content changes. Path: ${path}`);
    if (given[0] === 'delete') {
      if (change.delete !== true) invalid(`Delete with delete: true. Path: ${path}`);
      changes.push({ path, delete: true }); fingerprint.push([path, 'delete']);
    } else if (given[0] === 'from') {
      changes.push({ path, from: literalPath(change.from) }); fingerprint.push([path, 'from', change.from]);
    } else {
      if (given[0] === 'content' && (typeof change.content !== 'string' || !change.content.isWellFormed())) invalid(`content is a UTF-8 string; send bytes as contentBase64. Path: ${path}`);
      const bytes = given[0] === 'content' ? encoder.encode(change.content) : decodeBase64(change.contentBase64, path);
      if (bytes.length > limits.file) tooLarge(`A file is limited to 4 MiB. Path: ${path}`);
      if ((total += bytes.length) > limits.total) tooLarge('A commit is limited to 8 MiB of file content in total.');
      changes.push({ path, content: bytes, ...(change.mode !== undefined ? { mode: change.mode } : {}) });
      if (key) fingerprint.push([path, 'content', change.mode ?? '', await digest(given[0] === 'content' ? change.content : change.contentBase64), given[0]]);
    }
  }
  // Like `git commit`: trailing whitespace is trimmed and the message ends with one newline.
  const text = message.replace(/\s+$/, '') + '\n';
  return { name, ref: 'refs/heads/' + name, expected, base, onStale, key, message: text, changes,
    hash: key && await digest(JSON.stringify(['golf.source.commit.v1', name, expected, base, onStale, text, fingerprint])) };
}

function identity(env, person, time) {
  const clean = value => String(value || '').replace(/[<>\p{Cc}]/gu, '').trim(), login = clean(person.login).replace(/[\s@]/g, '');
  const email = typeof person.email === 'string' && /^[^\s<>@]{1,64}@[^\s<>@]{1,190}$/.test(person.email) ? person.email : `${login}@users.noreply.${new URL(env.PUBLIC_ORIGIN).hostname}`;
  return { name: clean(person.full_name) || login, email, time, tz: '+0000' };
}

const parseTree = body => {
  const entries = [];
  for (let i = 0; i < body.length;) {
    const space = body.indexOf(32, i), nul = body.indexOf(0, space);
    entries.push({ name: decoder.decode(body.subarray(space + 1, nul)), type: modeTypes[decoder.decode(body.subarray(i, space))], hash: [...body.subarray(nul + 1, nul + 21)].map(b => b.toString(16).padStart(2, '0')).join('') });
    i = nul + 21;
  }
  return entries;
};
// Trees written by this request are read from memory; every other object comes from the repository.
function overlay(repo, objects) {
  const local = new Map(objects.filter(object => object.type === 'tree').map(object => [object.id, object]));
  return { readTree: hash => local.has(hash) ? Promise.resolve(parseTree(local.get(hash).body)) : repo.readTree(hash) };
}
// Only new objects the final tree reaches go into the pack; anything else it names is already in the repository.
function reachable(objects, root) {
  const byId = new Map(objects.map(object => [object.id, object])), out = [], seen = new Set(), stack = [root];
  while (stack.length) {
    const id = stack.pop(), object = byId.get(id);
    if (seen.has(id) || !object) continue;
    seen.add(id); out.push(object);
    if (object.type === 'tree') stack.push(...parseTree(object.body).map(entry => entry.hash));
  }
  return out;
}

// The idempotency claim: a fresh claim, the original response of an applied commit, or a refusal.
async function claim(db, person, row, input) {
  const key = [person.id, input.key];
  for (let round = 0; round < 2; round++) {
    const inserted = await db.prepare('INSERT INTO source_commits(user_id,idempotency_key,repository_id,input_hash,created_at) VALUES(?,?,?,?,?) ON CONFLICT DO NOTHING').bind(...key, row.id, input.hash, new Date().toISOString()).run();
    if (inserted.meta.changes === 1) return {};
    const saved = await db.prepare(`SELECT s.*,g.state AS write_state,w.outcome FROM source_commits s LEFT JOIN git_operations g ON g.id=s.operation_id LEFT JOIN git_ref_writes w ON w.operation_id=s.operation_id
      WHERE s.user_id=? AND s.idempotency_key=?`).bind(...key).first();
    if (!saved) continue;
    if (saved.repository_id !== row.id || saved.input_hash !== input.hash) throw new Fault('already_exists', 409, 'This idempotencyKey belongs to a different commit request.');
    if (saved.write_state === 'APPLIED' && saved.result) return { result: JSON.parse(saved.result) };
    // Refused or settled NOT_APPLIED, or abandoned before any write for five minutes: the key is free again.
    const free = saved.operation_id ? saved.outcome === 'NOT_APPLIED' : Date.parse(saved.created_at) < Date.now() - 300_000;
    if (!free) throw new Refused('aborted', 409, saved.operation_id ? 'The commit with this idempotencyKey has an unknown outcome until maintenance reads the branch back (within minutes). Replay it then.' : 'A commit with this idempotencyKey is in progress.');
    await db.prepare('DELETE FROM source_commits WHERE user_id=? AND idempotency_key=? AND created_at=? AND operation_id IS ?').bind(...key, saved.created_at, saved.operation_id).run();
  }
  throw new Refused('aborted', 409, 'A commit with this idempotencyKey is in progress.');
}

async function commit(db, env, person, row, body, ctx) {
  const input = await commitInput(body, ctx.literalPath);
  requireScope(person, row.id, { write: true, ref: input.ref });
  writer(row);
  if (row.repository_write_pending ?? row.write_pending) conflict();
  const rulesVersion = await enforceGitRules(db, row, person, input.ref);
  const saved = input.key ? await claim(db, person, row, input) : null;
  if (saved?.result) return saved.result;
  try {
    return await ctx.withArtifact(env, row, repo => commitAttempts(db, env, person, row, repo, input, rulesVersion, ctx));
  } catch (error) {
    // A claim stays only while its write's outcome is unknown.
    if (input.key) await db.prepare("DELETE FROM source_commits WHERE user_id=? AND idempotency_key=? AND (operation_id IS NULL OR operation_id IN (SELECT operation_id FROM git_ref_writes WHERE outcome='NOT_APPLIED'))").bind(person.id, input.key).run();
    throw error;
  }
}

async function commitAttempts(db, env, person, row, repo, input, rulesVersion, ctx) {
  const creating = input.expected === '';
  const stale = current => new Refused('aborted', 409, `Branch ${input.name} moved past expectedHead; nothing was committed. Read it again, or send onStale: merge.`, { currentHead: current });
  let refs = await refsOf(env, repo, row, ctx.providerFetch), current = refs.get(input.ref);
  if (creating && current) throw new Refused('already_exists', 409, `Branch ${input.name} already exists; pass its head as expectedHead.`, { currentHead: current });
  if (!creating && !current) throw new Fault('not_found', 404, `Branch ${input.name} does not exist.`);
  const parent = creating ? (sha(input.base) ? input.base : input.base ? refs.get('refs/heads/' + input.base) : null) : input.expected;
  // A stale head with onStale fail is refused before any object is read.
  if (!creating && current !== input.expected && input.onStale !== 'merge') throw stale(current);
  if (creating && input.base && !parent) throw new Fault('not_found', 404, `Base branch ${input.base} does not exist.`);
  if (creating && !parent && [...refs.keys()].some(ref => ref.startsWith('refs/heads/'))) invalid('Name a base commit or branch for the new branch; a root commit without base is only for an empty repository.');
  const start = parent && await repo.readCommit(parent);
  if (parent && (start?.hash !== parent || !sha(start.treeHash))) throw new Fault('not_found', 404, (creating ? 'The base' : 'The expectedHead') + ' commit does not exist in this repository.');
  const baseTree = start?.treeHash || null, edit = await planTreeEdit(repo, baseTree, input.changes);
  if (edit.treeId === (baseTree || emptyTree)) invalid('The changes leave every file as it is; nothing was committed.');
  const time = Math.floor(Date.now() / 1000), author = identity(env, person, time);
  for (let attempt = 1; ; attempt++) {
    // The new commit's parent: the base when creating, else the branch head (expectedHead, or the moved head being merged onto).
    let treeId = edit.treeId, objects = edit.objects, paths = edit.changedPaths, merged = false, head = creating ? parent : current;
    if (!creating && current !== input.expected) {
      if (input.onStale !== 'merge') throw stale(current);
      // Three-way by path: base is the edited commit's tree, ours the current head, theirs the edited tree.
      const ours = await repo.readCommit(current);
      if (ours?.hash !== current || !sha(ours.treeHash)) throw Error('Invalid branch head');
      const result = await mergeTrees(overlay(repo, edit.objects), baseTree, ours.treeHash, edit.treeId);
      if (result.conflicts.length) throw new Refused('aborted', 409, `Branch ${input.name} moved and changed the same paths; nothing was committed.`, { currentHead: current, conflicts: result.conflicts });
      if (result.treeId === ours.treeHash) invalid('The branch already holds these changes; nothing was committed.');
      treeId = result.treeId; objects = [...edit.objects, ...result.objects]; merged = true;
      paths = await changedPaths(overlay(repo, objects), ours.treeHash, treeId);
    }
    const object = await commitObject({ tree: treeId, parents: head ? [head] : [], author, message: input.message });
    const value = { repositoryId: String(row.id), branch: input.name, commitId: object.id, treeId, previousHead: creating ? '' : current, merged, changedPaths: paths };
    const record = input.key && (id => db.prepare('UPDATE source_commits SET operation_id=?,result=? WHERE user_id=? AND idempotency_key=?').bind(id, JSON.stringify(value), person.id, input.key).run());
    const sent = await write(db, env, person, row, repo, { ref: input.ref, old: creating ? zero : current, next: object.id }, await packObjects([...reachable(objects, treeId), object]), rulesVersion, ctx, record);
    if (sent.outcome === 'applied') return value;
    if (attempt >= limits.attempts) throw new Refused('aborted', 409, (sent.outcome === 'busy' ? `Another write to ${input.name} stayed in flight` : `Branch ${input.name} kept changing`) + `; nothing was committed after ${limits.attempts} attempts.` + (sent.status ? ' Last provider status: ' + sent.status : ''), { currentHead: current || '' });
    if (sent.outcome === 'busy') await new Promise(resolve => setTimeout(resolve, 200 * attempt));
    refs = await refsOf(env, repo, row, ctx.providerFetch); current = refs.get(input.ref);
    if (creating && current) throw new Refused('already_exists', 409, `Branch ${input.name} was created by another write.`, { currentHead: current });
    if (!creating && !current) throw new Fault('not_found', 404, `Branch ${input.name} was deleted.`);
  }
}

async function branch(db, env, person, row, body, ctx) {
  const name = branchName(body.branch), ref = 'refs/heads/' + name, create = body.action === 'create';
  if (!['create', 'delete'].includes(body.action)) invalid('action is create or delete.');
  if (create ? body.expectedHead !== undefined || typeof body.from !== 'string' || !sha(body.from) && branchName(body.from, 'from') !== body.from : body.from !== undefined || !sha(body.expectedHead))
    invalid(create ? 'Create a branch from a commit ID or an existing branch name (from).' : 'Delete a branch with its current head as expectedHead.');
  requireScope(person, row.id, { write: true, ref });
  writer(row);
  if (!create && name === row.default_branch) throw new Fault('failed_precondition', 412, 'The default branch cannot be deleted; choose another default branch first.');
  if (row.repository_write_pending ?? row.write_pending) conflict();
  const rulesVersion = await enforceGitRules(db, row, person, ref);
  return ctx.withArtifact(env, row, async repo => {
    const refs = await refsOf(env, repo, row, ctx.providerFetch), current = refs.get(ref);
    let command;
    if (create) {
      if (current) throw new Refused('already_exists', 409, `Branch ${name} already exists.`, { currentHead: current });
      const target = sha(body.from) ? body.from : refs.get('refs/heads/' + body.from);
      if (!target || (await repo.readCommit(target))?.hash !== target) throw new Fault('not_found', 404, 'from does not name a commit or branch in this repository.');
      command = { ref, old: zero, next: target };
    } else {
      if (!current) throw new Fault('not_found', 404, `Branch ${name} does not exist.`);
      if (current !== body.expectedHead) throw new Refused('aborted', 409, `Branch ${name} moved past expectedHead; it was not deleted.`, { currentHead: current });
      command = { ref, old: current, next: zero };
    }
    // A create points at objects the repository holds: an empty pack. A delete sends no pack.
    const sent = await write(db, env, person, row, repo, command, create ? await packObjects([]) : new Uint8Array(), rulesVersion, ctx);
    if (sent.outcome !== 'applied') throw new Refused('aborted', 409, sent.outcome === 'busy' ? `Another write to ${name} is in flight; retry.` : `Branch ${name} changed during the request.` + (sent.status ? ' Provider status: ' + sent.status : ''), { currentHead: current || '' });
    return create ? { repositoryId: String(row.id), branch: name, action: 'create', commitId: command.next } : { repositoryId: String(row.id), branch: name, action: 'delete', previousHead: current };
  });
}
