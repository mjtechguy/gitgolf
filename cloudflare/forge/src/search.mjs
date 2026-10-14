import { Fault, deny, invalid, reply, digest } from './common.mjs';
import { aiRun } from './ai.mjs';
import { featureOff } from './feature-policy.mjs';
import { aiModel } from './ai-models.mjs';

// Semantic search over one repository. Vectorize keeps only vectors with repository and kind metadata; every excerpt is read live
// from Artifacts or D1 after the reader's grant is checked, so revocations, deletions and edits apply to the next search.
export const searchFeature = 'semantic-search';
export const searchLimits = { files: 2000, chunks: 5000, fileBytes: 64 * 1024, lines: 60, overlap: 10, fileChunks: 32, batch: 32, changed: 256,
  tickCalls: 10, indexerDaily: 1000, userDaily: 200, topK: 50, results: 20, query: 500, discussionBytes: 8 * 1024, discussionChunks: 4,
  discussions: 2000, chunkChars: 4000, excerptLines: 12, lineChars: 400 };
export const searchNotice = 'Semantic matches by meaning; exact text search is not available.';
const searchInstruction = 'Given a question about a software repository, find the source code, issues and pull requests that answer it';
const capabilityReason = 'Signed-in readers can search one repository by meaning: default-branch code (up to 2,000 files) and issue and pull request titles and descriptions. Access is checked on every search; results show the indexed commit, and newer pushes appear after reindexing.';
const now = () => new Date().toISOString();

// The deploy fixes the Vectorize index dimension; model selection picks the embedding model. A change to either rebuilds the index.
export function searchConfiguration(env) {
  const dimensions = Number(env.SEARCH_DIMENSIONS);
  return { dimensions: Number.isInteger(dimensions) && dimensions >= 32 && dimensions <= 4096 ? dimensions : 0 };
}
// '' when allocated, otherwise what the operator has not provided. The installation AI switch overlays EVIDENCE_ALLOW_AI.
export function searchUnallocated(env) {
  if (!(env.EVIDENCE_ALLOW_AI === 'true' && env.AI && env.EVIDENCE_GATEWAY)) return 'Semantic search needs Workers AI through this installation\'s private AI Gateway, which the operator has not allocated or has turned off.';
  if (!env.SEARCH_INDEX) return 'Semantic search needs a Vectorize index, which the operator has not bound to this installation.';
  if (!searchConfiguration(env).dimensions) return 'Semantic search needs the deployed Vectorize index dimension.';
  return '';
}
export const searchAllocation = env => !searchUnallocated(env);
// The embedding model for one repository's index, from model selection (installation default, or the repository's allowed choice).
// An index whose stored search_state.model differs from it is stale and is rebuilt; the old one serves until the new one completes.
// `resolve` is replaceable only so tests can choose a model without installation settings.
export const searchModels = { resolve: async (db, env, repositoryId) => (await aiModel(db, env, 'search', repositoryId)).model };
export async function searchModel(db, env, repositoryId) {
  let model;
  try { model = await searchModels.resolve(db, env, repositoryId); } catch (error) { throw new SearchRefusal(error?.message || 'No embedding model is available for semantic search.'); }
  if (typeof model !== 'string' || !/^@(?:cf|hf)\/[a-z0-9][a-z0-9._-]{0,63}\/[a-z0-9][a-z0-9._-]{0,95}$/i.test(model)) throw new SearchRefusal('No embedding model is available for semantic search.');
  return model;
}

// A reason that stops this index, as opposed to a transient failure that the next maintenance run retries.
export class SearchRefusal extends Error {}

// One gateway call for up to 32 texts. A vector of any other width than the index's is refused, never upserted.
export async function embed(env, model, dimensions, texts, query = false) {
  const input = /qwen3-embedding/.test(model) ? query ? { queries: texts, instruction: searchInstruction } : { documents: texts } : { text: texts };
  const answer = await aiRun(env, model, input, { deadlineMs: query ? 15_000 : 60_000 });
  const data = answer?.data, width = Array.isArray(answer?.shape) && answer.shape.length === 2 ? answer.shape[1] : data?.[0]?.length;
  if (!Array.isArray(data) || data.length !== texts.length || !Number.isInteger(width)) throw new SearchRefusal('The embedding model returned an answer Golf could not read.');
  if (width !== dimensions) throw new SearchRefusal(`${model} returns ${width}-dimension vectors but this installation's Vectorize index has ${dimensions}. Re-create the index with enable-search --dimensions ${width}, deploy, then build the index again.`);
  for (const vector of data) if (!Array.isArray(vector) || vector.length !== dimensions || vector.some(value => typeof value !== 'number' || !Number.isFinite(value))) throw new SearchRefusal('The embedding model returned an answer Golf could not read.');
  return data;
}

// Counts embedding calls per UTC day; false once the limit is reached. User 0 is the background indexer.
export async function spend(db, userId, limit) {
  const result = await db.prepare('INSERT INTO search_usage(day,user_id,calls) VALUES(?,?,1) ON CONFLICT(day,user_id) DO UPDATE SET calls=calls+1 WHERE calls<?')
    .bind(now().slice(0, 10), userId, limit).run();
  return result.meta.changes === 1;
}

// Text files only: at most 64 KiB, UTF-8, no NUL bytes and not minified. null means skipped.
export function sourceLines(bytes) {
  if (bytes.length > searchLimits.fileBytes) return null;
  let text;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { return null; }
  if (text.includes('\0')) return null;
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  if (lines.some(line => line.length > 1000) && text.length / lines.length > 200) return null;
  return lines;
}
// About 60-line windows that overlap by 10 lines, 1-based and inclusive.
export function chunkRanges(count, max = searchLimits.fileChunks) {
  const ranges = [], step = searchLimits.lines - searchLimits.overlap;
  for (let start = 1; start <= count && ranges.length < max; start += step) {
    const end = Math.min(count, start + searchLimits.lines - 1);
    ranges.push([start, end]);
    if (end === count) break;
  }
  return ranges;
}
// The indexed text of an issue or pull request: its title and the start of its description.
export function discussionText(discussion) {
  const body = String(discussion.body || '');
  return `${discussion.title}\n\n${body.length > searchLimits.discussionBytes ? body.slice(0, searchLimits.discussionBytes) : body}`.replace(/\r\n/g, '\n');
}
export const discussionVersion = discussion => digest(discussionText(discussion));

// Lowercase words of three or more letters, for choosing and highlighting the excerpt lines.
export function queryTerms(query) {
  return [...new Set(query.toLowerCase().match(/[\p{L}\p{N}_]{3,}/gu) || [])].slice(0, 12);
}
// Up to 12 lines inside the matched chunk: the window that mentions the query's words most, else its start.
export function excerpt(lines, start, end, terms) {
  const size = Math.min(searchLimits.excerptLines, end - start + 1);
  let best = start, bestHits = -1;
  for (let first = start; first + size - 1 <= end; first++) {
    let hits = 0;
    for (let line = first; line < first + size; line++) for (const term of terms) if ((lines[line - 1] || '').toLowerCase().includes(term)) hits++;
    if (hits > bestHits) { best = first; bestHits = hits; }
  }
  return { startLine: best, lines: lines.slice(best - 1, best - 1 + size).map(line => line.length > searchLimits.lineChars ? line.slice(0, searchLimits.lineChars) + '…' : line) };
}

export async function searchCapability(db, env) {
  const capability = { id: 'repository.semantic-search', label: 'Semantic search' }, unavailable = searchUnallocated(env);
  if (unavailable) return { ...capability, state: 'CAPABILITY_STATE_DISABLED', reason: unavailable };
  let verified, failure;
  try {
    verified = await db.prepare('SELECT 1 AS ok FROM search_state WHERE verified_at IS NOT NULL LIMIT 1').first();
    failure = await db.prepare("SELECT error FROM search_state WHERE state='FAILED' AND error IS NOT NULL ORDER BY updated_at DESC LIMIT 1").first();
  } catch { return { ...capability, state: 'CAPABILITY_STATE_DEGRADED', reason: 'Apply the schema 34 migration to keep search indexes. ' + capabilityReason }; }
  if (verified) return { ...capability, state: 'CAPABILITY_STATE_READY', reason: capabilityReason };
  return { ...capability, state: 'CAPABILITY_STATE_DEGRADED', reason: capabilityReason + ' Degraded until a first index completes and its vectors read back from Vectorize.' + (failure ? ' Last failure: ' + failure.error : '') };
}

async function status(db, env, row) {
  const state = await db.prepare('SELECT * FROM search_state WHERE repository_id=?').bind(row.id).first();
  const reason = searchUnallocated(env) || (await featureOff(db, env, row, searchFeature))?.reason || '';
  const pending = state ? (await db.prepare('SELECT count(*) AS n FROM search_outbox WHERE repository_id=?').bind(row.id).first()).n : 0;
  const building = state?.state === 'INDEXING' || state?.state === 'PENDING';
  return { repositoryId: String(row.id), available: !reason, reason, notice: searchNotice, canManage: row.role === 'admin',
    index: state ? { state: state.state, served: Boolean(state.indexed_at) && state.state !== 'REMOVING', model: state.model, dimensions: state.dimensions,
      commitId: state.commit_id || '', indexedAt: state.indexed_at || '', files: state.files, chunks: state.chunks, skipped: state.skipped,
      ...(building ? { targetCommitId: state.target_commit || '', targetModel: state.target_model || '', pending, total: state.total,
        progress: state.state === 'INDEXING' && state.total ? Math.round(Math.max(0, Math.min(1, (state.total - pending) / state.total)) * 100) : 0 } : {}),
      verified: Boolean(state.verified_at), error: state.error || '', updatedAt: state.updated_at } : null };
}

// Each result is resolved from D1 and read live: a chunk whose file changed at the indexed commit, an edited or deleted issue,
// or a kind turned off by policy is filtered out and counted, never shown from stored text.
async function query(db, env, person, row, artifact, body, readTree) {
  const text = typeof body.query === 'string' ? body.query.trim() : '';
  if (text.length < 2 || text.length > searchLimits.query) invalid('Search for 2 to 500 characters.');
  const unavailable = searchUnallocated(env);
  if (unavailable) throw new Fault('failed_precondition', 412, unavailable);
  const current = await status(db, env, row);
  if (!current.index?.served) return { ...current, query: text, results: [], filtered: 0 };
  const state = await db.prepare('SELECT * FROM search_state WHERE repository_id=?').bind(row.id).first();
  if (!await spend(db, person.id, searchLimits.userDaily)) throw new Fault('resource_exhausted', 429, `You can run ${searchLimits.userDaily} semantic searches a day on this installation.`);
  let vector;
  try { [vector] = await embed(env, state.model, state.dimensions, [text], true); }
  catch (error) { throw error instanceof SearchRefusal ? new Fault('failed_precondition', 412, error.message) : new Fault('unavailable', 503, 'Workers AI could not read this search. Try again.'); }
  const found = await env.SEARCH_INDEX.query(vector, { topK: searchLimits.topK, filter: { repository: String(row.id) }, returnMetadata: 'none', returnValues: false });
  const scores = new Map((found?.matches || []).filter(match => /^[a-f0-9]{64}$/.test(match.id) && Number.isFinite(match.score)).map(match => [match.id, match.score]));
  const ids = [...scores.keys()].slice(0, searchLimits.topK);
  const chunks = ids.length ? (await db.prepare(`SELECT * FROM search_chunks WHERE repository_id=? AND state IN ('LIVE','RETIRING') AND id IN (${ids.map(() => '?').join(',')})`).bind(row.id, ...ids).all()).results : [];
  chunks.sort((a, b) => scores.get(b.id) - scores.get(a.id) || (a.id < b.id ? -1 : 1));
  const shown = { code: true, issue: !await featureOff(db, env, row, 'issues'), pull: !await featureOff(db, env, row, 'pull-requests') };
  const terms = queryTerms(text), results = [];
  let filtered = ids.length - chunks.length;
  const discussions = new Map();
  const resolve = async (chunk, repo) => {
    if (chunk.kind === 'code') {
      const blob = await blobAt(repo, state.commit_id, chunk.path, readTree);
      if (blob !== chunk.source_id) return null;
      const file = await repo.readBlob(blob), lines = file && file.size <= searchLimits.fileBytes ? sourceLines(new Uint8Array(await file.arrayBuffer())) : null;
      if (!lines || chunk.end_line > lines.length) return null;
      return { kind: 'code', path: chunk.path, startLine: chunk.start_line, endLine: chunk.end_line, excerpt: excerpt(lines, chunk.start_line, chunk.end_line, terms) };
    }
    if (!discussions.has(chunk.source_id)) discussions.set(chunk.source_id, await db.prepare('SELECT id,number,kind,title,body,state FROM discussions WHERE id=? AND repository_id=?').bind(Number(chunk.source_id), row.id).first());
    const discussion = discussions.get(chunk.source_id);
    if (!discussion || discussion.kind !== chunk.kind || await discussionVersion(discussion) !== chunk.source_version) return null;
    const lines = discussionText(discussion).split('\n');
    if (chunk.end_line > lines.length) return null;
    return { kind: chunk.kind, number: discussion.number, title: discussion.title, state: discussion.state, startLine: chunk.start_line, endLine: chunk.end_line, excerpt: excerpt(lines, chunk.start_line, chunk.end_line, terms) };
  };
  const collect = async repo => {
    for (const chunk of chunks) {
      if (results.length >= searchLimits.results) break;
      if (!shown[chunk.kind]) { filtered++; continue; }
      const result = await resolve(chunk, repo);
      if (result) results.push({ ...result, score: Math.round(scores.get(chunk.id) * 1000) / 1000 }); else filtered++;
    }
  };
  if (chunks.some(chunk => chunk.kind === 'code')) await artifact(collect); else await collect(null);
  // The grant is read again after the excerpts: access removed while they were read returns nothing.
  if (!await db.prepare("SELECT 1 AS ok FROM grants g JOIN repositories r ON r.id=g.repository_id JOIN users u ON u.id=g.user_id WHERE g.repository_id=? AND g.user_id=? AND r.state='ACTIVE' AND u.active=1").bind(row.id, person.id).first()) deny();
  return { ...current, query: text, results, filtered };
}

const trees = new WeakMap();
async function blobAt(repo, commitId, path, readTree) {
  if (!trees.has(repo)) trees.set(repo, new Map());
  const cache = trees.get(repo), read = hash => { if (!cache.has(hash)) cache.set(hash, readTree(repo, hash)); return cache.get(hash); };
  if (!cache.has('commit:' + commitId)) cache.set('commit:' + commitId, repo.readCommit(commitId));
  let entry = { type: 'tree', hash: (await cache.get('commit:' + commitId))?.treeHash };
  if (!entry.hash) return null;
  for (const name of path.split('/')) {
    if (entry?.type !== 'tree') return null;
    entry = (await read(entry.hash)).find(child => child.name === name);
  }
  return entry && ['blob', 'exec'].includes(entry.type) ? entry.hash : null;
}

// `/native/search` (index, remove: repository administrators) and `/native/search/read` (status, query: signed-in readers).
export async function searchAPI(db, env, person, row, artifact, body, readTree) {
  if (person.anonymous || !['read', 'write', 'admin'].includes(row.role)) deny();
  if (body.repositoryId !== undefined && body.repositoryId !== String(row.id)) deny();
  if (body.action === 'status') return reply(await status(db, env, row));
  if (body.action === 'query') return reply(await query(db, env, person, row, artifact, body, readTree));
  if (!['index', 'remove'].includes(body.action)) invalid('Use status, query, index or remove.');
  if (row.role !== 'admin') throw new Fault('permission_denied', 403, 'Only repository administrators can build or remove the search index.');
  if (body.action === 'index') {
    const unavailable = searchUnallocated(env);
    if (unavailable) throw new Fault('failed_precondition', 412, unavailable);
    let model;
    try { model = await searchModel(db, env, row.id); } catch (error) { throw new Fault('failed_precondition', 412, error.message); }
    const { dimensions } = searchConfiguration(env), existing = await db.prepare('SELECT state FROM search_state WHERE repository_id=?').bind(row.id).first();
    if (existing?.state === 'REMOVING') throw new Fault('failed_precondition', 412, 'This index is still being removed. Build it again once removal completes.');
    // A first build, a retry after a failure or a full rebuild; a build already queued or running is left as it is.
    if (!existing || ['READY', 'FAILED'].includes(existing.state))
      await db.prepare(`INSERT INTO search_state(repository_id,state,model,dimensions,requested_by,checked_at,updated_at) VALUES(?,'PENDING',?,?,?,'',?)
        ON CONFLICT(repository_id) DO UPDATE SET state='PENDING',error=NULL,requested_by=excluded.requested_by,checked_at='',updated_at=excluded.updated_at WHERE search_state.state IN ('READY','FAILED')`)
        .bind(row.id, model, dimensions, person.id, now()).run();
    return reply(await status(db, env, row));
  }
  // Searches stop now; maintenance deletes the vectors, then the rows. Works while the feature is off, and keeps nothing.
  await db.batch([
    db.prepare("UPDATE search_state SET state='REMOVING',error=NULL,updated_at=? WHERE repository_id=?").bind(now(), row.id),
    db.prepare('DELETE FROM search_outbox WHERE repository_id=?').bind(row.id),
  ]);
  return reply(await status(db, env, row));
}
