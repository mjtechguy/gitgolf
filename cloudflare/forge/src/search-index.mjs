import { digest } from './common.mjs';
import { featureOff } from './feature-policy.mjs';
import { searchLimits as limits, searchConfiguration, searchUnallocated, searchFeature, embed, spend, SearchRefusal, sourceLines, chunkRanges, discussionText } from './search.mjs';

// Background indexing from the maintenance schedule, outside the workspace write queue: at most 10 embedding calls of up to 32 chunks
// per run (one run every few minutes), at most 1,000 calls a day. Vectorize receives ids, vectors and { repository, kind } only.
const now = () => new Date().toISOString();
const skippedDirectory = /(^|\/)(node_modules|vendor|vendors|third_party|third-party|bower_components|dist|build|out|target|\.git|\.next|\.cache|coverage|__pycache__)\//i;
const skippedName = /(^|\/)(package-lock\.json|npm-shrinkwrap\.json|pnpm-lock\.yaml|bun\.lockb|go\.sum|[^/]+\.lock)$|\.min\.(js|mjs|css)$|\.map$/i;
const binary = /\.(png|jpe?g|gif|webp|bmp|ico|icns|pdf|zip|gz|tgz|bz2|xz|7z|rar|jar|war|class|o|a|so|dylib|dll|exe|bin|wasm|woff2?|ttf|otf|eot|mp3|mp4|mov|avi|webm|ogg|wav|flac|psd|sqlite|db|pyc)$/i;
export const indexablePath = path => !skippedDirectory.test(path) && !skippedName.test(path) && !binary.test(path);
const vectorId = (...parts) => digest(JSON.stringify(parts));
const groups = (values, size) => Array.from({ length: Math.ceil(values.length / size) }, (_, i) => values.slice(i * size, i * size + size));

// Indexable default-branch files, sorted, at most 2,000; tree reads are bounded like the file finder's.
export async function indexableFiles(repo, commitId, readTree) {
  const commit = await repo.readCommit(commitId);
  if (!commit?.treeHash) throw Error('Indexed commit unavailable');
  const pending = [{ hash: commit.treeHash, prefix: '', depth: 0 }], files = [];
  let directories = 0;
  while (pending.length) {
    const item = pending.shift();
    if (++directories > 512 || item.depth > 64) throw new SearchRefusal('The default branch has more than 512 folders; semantic search indexes smaller trees.');
    for (const entry of await readTree(repo, item.hash)) {
      const path = item.prefix + entry.name;
      if (entry.type === 'tree') pending.push({ hash: entry.hash, prefix: path + '/', depth: item.depth + 1 });
      else if (['blob', 'exec'].includes(entry.type) && indexablePath(path)) files.push({ path, blob: entry.hash });
    }
  }
  files.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  return { files: files.slice(0, limits.files), skipped: Math.max(0, files.length - limits.files) };
}

// A new head, model or dimension starts a build: changed files only when at most 256 differ, otherwise everything again.
async function plan(db, state, repo, head, wanted, readTree) {
  const id = state.repository_id, listing = head ? await indexableFiles(repo, head, readTree) : { files: [], skipped: 0 };
  let rebuild = !state.indexed_at || ['PENDING', 'FAILED'].includes(state.state) || state.model !== wanted.model || state.dimensions !== wanted.dimensions;
  let changed = listing.files, retire = [];
  if (!rebuild) {
    const { results: served } = await db.prepare('SELECT path,blob FROM search_files WHERE repository_id=? AND served=1').bind(id).all();
    const old = new Map(served.map(file => [file.path, file.blob])), fresh = new Set(listing.files.map(file => file.path));
    changed = listing.files.filter(file => old.get(file.path) !== file.blob);
    retire = [...changed.map(file => file.path), ...served.filter(file => !fresh.has(file.path)).map(file => file.path)];
    if (retire.length > limits.changed) { rebuild = true; changed = listing.files; }
  }
  const time = now(), statements = [db.prepare('DELETE FROM search_files WHERE repository_id=? AND served=0').bind(id), db.prepare("DELETE FROM search_outbox WHERE repository_id=? AND kind='code'").bind(id)];
  for (const group of groups(listing.files, 30)) statements.push(db.prepare(`INSERT INTO search_files(repository_id,served,path,blob) VALUES${group.map(() => '(?,0,?,?)').join(',')}`).bind(...group.flatMap(file => [id, file.path, file.blob])));
  for (const group of groups(changed, 24)) statements.push(db.prepare(`INSERT INTO search_outbox(repository_id,kind,source,version,queued_at) VALUES${group.map(() => "(?,'code',?,?,?)").join(',')}`).bind(...group.flatMap(file => [id, file.path, file.blob, time])));
  if (rebuild) {
    // Everything is embedded again; the served chunks stay searchable until the new ones replace them.
    statements.push(db.prepare("UPDATE search_chunks SET state='RETIRING' WHERE repository_id=? AND state IN ('LIVE','PENDING')").bind(id));
    statements.push(db.prepare(`INSERT INTO search_outbox(repository_id,kind,source,version,queued_at) SELECT repository_id,'discussion',CAST(id AS TEXT),'',? FROM discussions WHERE repository_id=? ORDER BY id DESC LIMIT ${limits.discussions}
      ON CONFLICT(repository_id,kind,source) DO NOTHING`).bind(time, id));
  } else for (const group of groups(retire, 90)) statements.push(db.prepare(`UPDATE search_chunks SET state='RETIRING' WHERE repository_id=? AND kind='code' AND state IN ('LIVE','PENDING') AND path IN (${group.map(() => '?').join(',')})`).bind(id, ...group));
  statements.push(db.prepare(`UPDATE search_state SET state='INDEXING',target_commit=?,target_model=?,target_dimensions=?,generation=generation+1,skipped=?,error=NULL,
    total=(SELECT count(*) FROM search_outbox WHERE repository_id=?),updated_at=? WHERE repository_id=? AND state=?`).bind(head || '', wanted.model, wanted.dimensions, listing.skipped, id, time, id, state.state));
  await db.batch(statements);
  return db.prepare('SELECT * FROM search_state WHERE repository_id=?').bind(id).first();
}

// The chunks of one outbox item, read from the exact blob or the current issue text. An item with no chunks was skipped.
async function itemChunks(db, state, repo, item, model, room) {
  const id = state.repository_id;
  if (item.kind === 'code') {
    const blob = await repo.readBlob(item.version);
    const lines = blob && blob.size <= limits.fileBytes ? sourceLines(new Uint8Array(await blob.arrayBuffer())) : null;
    if (!lines) return { item, chunks: [], skipped: true };
    const chunks = [];
    for (const [start, end] of chunkRanges(lines.length)) {
      const text = lines.slice(start - 1, end).join('\n');
      if (!text.trim()) continue;
      chunks.push({ id: await vectorId(id, model, 'code', item.source, item.version, start), kind: 'code', source: item.version, path: item.source, start, end, version: item.version,
        text: `File ${item.source}\n${text}`.slice(0, limits.chunkChars) });
    }
    return chunks.length > room ? { item, chunks: [], skipped: true } : { item, chunks };
  }
  const discussion = await db.prepare('SELECT id,number,kind,title,body FROM discussions WHERE id=? AND repository_id=?').bind(Number(item.source), id).first();
  if (!discussion) return { item, chunks: [] };
  const text = discussionText(discussion), version = await digest(text), lines = text.split('\n'), chunks = [];
  for (const [start, end] of chunkRanges(lines.length, limits.discussionChunks)) {
    const part = lines.slice(start - 1, end).join('\n');
    if (!part.trim()) continue;
    chunks.push({ id: await vectorId(id, model, discussion.kind, item.source, version, start), kind: discussion.kind, source: item.source, path: '', start, end, version,
      text: `${discussion.kind === 'pull' ? 'Pull request' : 'Issue'} #${discussion.number}\n${part}`.slice(0, limits.chunkChars) });
  }
  return chunks.length > room ? { item, chunks: [], skipped: true } : { item, chunks };
}

// One embedding call, one Vectorize upsert, then the D1 rows. Rows are written only while the index is still wanted, and an
// outbox item queued again meanwhile (an issue edited twice) stays queued.
async function flush(db, env, state, model, dimensions, batch, done, budget) {
  const id = state.repository_id, chunkState = state.state === 'INDEXING' ? 'PENDING' : 'LIVE';
  if (batch.length) {
    if (!await spend(db, 0, limits.indexerDaily)) {
      await db.prepare('UPDATE search_state SET error=?,updated_at=? WHERE repository_id=?').bind(`The daily allowance of ${limits.indexerDaily} indexing calls is used; indexing continues tomorrow.`, now(), id).run();
      return false;
    }
    budget.calls--;
    const vectors = await embed(env, model, dimensions, batch.map(chunk => chunk.text));
    await env.SEARCH_INDEX.upsert(batch.map((chunk, i) => ({ id: chunk.id, values: vectors[i], metadata: { repository: String(id), kind: chunk.kind } })));
  }
  const wanted = "EXISTS(SELECT 1 FROM search_state WHERE repository_id=? AND state IN ('INDEXING','READY'))", statements = [], stale = [];
  for (const chunk of batch) statements.push(db.prepare(`INSERT INTO search_chunks(id,repository_id,kind,source_id,path,start_line,end_line,source_version,state) SELECT ?,?,?,?,?,?,?,?,? WHERE ${wanted}
    ON CONFLICT(id) DO UPDATE SET state=excluded.state`).bind(chunk.id, id, chunk.kind, chunk.source, chunk.path, chunk.start, chunk.end, chunk.version, chunkState, id));
  for (const { item, chunks } of done) {
    if (item.kind === 'discussion') {
      // The issue's earlier chunks: replaced now when the index is ready, at the end of the build otherwise.
      const keep = chunks.map(chunk => chunk.id);
      const { results } = await db.prepare(`SELECT id FROM search_chunks WHERE repository_id=? AND source_id=? AND kind IN ('issue','pull') AND state='LIVE'${keep.length ? ` AND id NOT IN (${keep.map(() => '?').join(',')})` : ''}`).bind(id, item.source, ...keep).all();
      if (chunkState === 'LIVE') stale.push(...results.map(row => row.id));
      else for (const group of groups(results.map(row => row.id), 90)) statements.push(db.prepare(`UPDATE search_chunks SET state='RETIRING' WHERE id IN (${group.map(() => '?').join(',')})`).bind(...group));
    }
    statements.push(db.prepare('DELETE FROM search_outbox WHERE repository_id=? AND kind=? AND source=? AND queued_at=?').bind(id, item.kind, item.source, item.queued_at));
  }
  const skipped = done.filter(entry => entry.skipped).length;
  statements.push(db.prepare('UPDATE search_state SET calls=calls+?,skipped=skipped+?,updated_at=? WHERE repository_id=?').bind(batch.length ? 1 : 0, skipped, now(), id));
  await db.batch(statements);
  if (stale.length) await retire(db, env, stale);
  return true;
}

async function retire(db, env, ids) {
  for (const group of groups(ids, 100)) {
    await env.SEARCH_INDEX.deleteByIds(group);
    await db.prepare(`DELETE FROM search_chunks WHERE id IN (${group.map(() => '?').join(',')})`).bind(...group).run();
  }
}

async function work(db, env, state, repo, budget) {
  const id = state.repository_id, building = state.state === 'INDEXING';
  const model = building ? state.target_model : state.model, dimensions = building ? state.target_dimensions : state.dimensions;
  let processed = 0;
  while (budget.calls > 0) {
    const { results: items } = await db.prepare('SELECT * FROM search_outbox WHERE repository_id=? ORDER BY queued_at,kind,source LIMIT 40').bind(id).all();
    if (!items.length) break;
    const used = (await db.prepare("SELECT count(*) AS n FROM search_chunks WHERE repository_id=? AND state IN ('LIVE','PENDING')").bind(id).first()).n;
    const batch = [], done = [];
    for (const item of items) {
      const prepared = await itemChunks(db, state, repo, item, model, limits.chunks - used - batch.length);
      if (batch.length && batch.length + prepared.chunks.length > limits.batch) break;
      batch.push(...prepared.chunks); done.push(prepared);
    }
    if (!await flush(db, env, state, model, dimensions, batch, done, budget)) break;
    processed += done.length;
  }
  return processed;
}

// The build replaces the served index in one D1 batch, after the vectors it retires are deleted from Vectorize.
async function finalize(db, env, state) {
  const id = state.repository_id, { results } = await db.prepare("SELECT id FROM search_chunks WHERE repository_id=? AND state='RETIRING'").bind(id).all();
  for (const group of groups(results.map(row => row.id), 100)) await env.SEARCH_INDEX.deleteByIds(group);
  const time = now();
  await db.batch([
    db.prepare("DELETE FROM search_chunks WHERE repository_id=? AND state='RETIRING'").bind(id),
    db.prepare("UPDATE search_chunks SET state='LIVE' WHERE repository_id=? AND state='PENDING'").bind(id),
    db.prepare('DELETE FROM search_files WHERE repository_id=? AND served=1').bind(id),
    db.prepare('UPDATE search_files SET served=1 WHERE repository_id=? AND served=0').bind(id),
    db.prepare(`UPDATE search_state SET state='READY',model=target_model,dimensions=target_dimensions,commit_id=target_commit,
      files=(SELECT count(*) FROM search_files WHERE repository_id=? AND served=1),chunks=(SELECT count(*) FROM search_chunks WHERE repository_id=? AND state='LIVE'),
      indexed_at=?,verified_at=NULL,error=NULL,updated_at=? WHERE repository_id=? AND state='INDEXING'`).bind(id, id, time, time, id),
  ]);
  return db.prepare('SELECT * FROM search_state WHERE repository_id=?').bind(id).first();
}

// Vectorize applies writes asynchronously; an index counts as working only once one of its vectors reads back.
async function verify(db, env, state) {
  const sample = await db.prepare("SELECT id FROM search_chunks WHERE repository_id=? AND state='LIVE' ORDER BY id LIMIT 1").bind(state.repository_id).first();
  if (!sample) return;
  const found = await env.SEARCH_INDEX.getByIds([sample.id]);
  if (Array.isArray(found) && found.some(vector => vector?.id === sample.id))
    await db.prepare("UPDATE search_state SET verified_at=? WHERE repository_id=? AND state='READY'").bind(now(), state.repository_id).run();
}

async function remove(db, env, id) {
  const { results } = await db.prepare('SELECT id FROM search_chunks WHERE repository_id=? LIMIT 1000').bind(id).all();
  if (results.length) await retire(db, env, results.map(row => row.id));
  else await db.batch([db.prepare('DELETE FROM search_outbox WHERE repository_id=?').bind(id), db.prepare('DELETE FROM search_files WHERE repository_id=?').bind(id),
    db.prepare("DELETE FROM search_state WHERE repository_id=? AND state='REMOVING'").bind(id)]);
  return results.length;
}

async function advance(db, env, state, open, readTree, budget) {
  const wanted = searchConfiguration(env), row = { id: state.repository_id, artifact_name: state.artifact_name, default_branch: state.default_branch };
  return open(row, async (repo, _info, log) => {
    const head = log?.[0]?.hash || '';
    let current = state;
    const moved = current.commit_id !== head || current.model !== wanted.model || current.dimensions !== wanted.dimensions;
    // A failed build waits for an administrator, or for a different model or dimension, instead of failing again every run.
    if (current.state === 'PENDING' || current.state === 'READY' && moved || current.state === 'FAILED' && (current.target_model !== wanted.model || current.target_dimensions !== wanted.dimensions))
      current = await plan(db, current, repo, head, wanted, readTree);
    if (!['INDEXING', 'READY'].includes(current?.state)) return 0;
    const processed = await work(db, env, current, repo, budget);
    if (current.state === 'INDEXING' && !(await db.prepare('SELECT count(*) AS n FROM search_outbox WHERE repository_id=?').bind(current.repository_id).first()).n) current = await finalize(db, env, current);
    if (current?.state === 'READY' && !current.verified_at) await verify(db, env, current);
    return processed;
  });
}

// One maintenance run: removals first (no model calls), then up to four repositories by least recently checked.
export async function searchMaintenance(env, open, readTree) {
  if (searchUnallocated(env)) return { processed: 0 };
  const db = env.DB.withSession('first-primary'), budget = { calls: limits.tickCalls };
  let processed = 0, failures = 0;
  for (const { repository_id } of (await db.prepare("SELECT repository_id FROM search_state WHERE state='REMOVING' ORDER BY updated_at LIMIT 2").all()).results) processed += await remove(db, env, repository_id);
  const { results } = await db.prepare(`SELECT s.*,r.artifact_name,r.default_branch FROM search_state s JOIN repositories r ON r.id=s.repository_id
    WHERE s.state!='REMOVING' AND r.state='ACTIVE' ORDER BY s.checked_at,s.repository_id LIMIT 4`).all();
  for (const state of results) {
    if (budget.calls <= 0) break;
    await db.prepare('UPDATE search_state SET checked_at=? WHERE repository_id=?').bind(now(), state.repository_id).run();
    // Turned off by a policy: nothing is read or embedded and the vectors are kept.
    if (await featureOff(db, env, state.repository_id, searchFeature)) continue;
    try { processed += await advance(db, env, state, open, readTree, budget); }
    catch (error) {
      if (error instanceof SearchRefusal) {
        await db.prepare("UPDATE search_state SET state='FAILED',error=?,target_model=COALESCE(target_model,model),target_dimensions=COALESCE(target_dimensions,dimensions),updated_at=? WHERE repository_id=? AND state!='REMOVING'").bind(error.message.slice(0, 400), now(), state.repository_id).run();
      } else {
        failures++;
        await db.prepare('UPDATE search_state SET error=?,updated_at=? WHERE repository_id=?').bind('Indexing was interrupted and continues on the next maintenance run.', now(), state.repository_id).run();
      }
    }
  }
  if (failures) throw Error('Semantic search indexing was interrupted');
  return { processed };
}
