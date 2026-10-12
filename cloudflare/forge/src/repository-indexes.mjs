import { digest } from './common.mjs';
import { sha } from './git.mjs';
import { classifierVersion } from './repository-metadata.mjs';

const now = () => new Date().toISOString();
export async function indexKey(env, row, input) {
  const scope = await digest(JSON.stringify([1, env.ACCOUNT_ID, env.ARTIFACTS_NAMESPACE, env.WORKSPACE_SLUG, row.id, row.artifact_name]));
  const inputHash = await digest(JSON.stringify(input.kind === 'overview' ? { ...input, classifierVersion } : input));
  return { key: `repository-indexes/v1/${scope}/${input.ref}/${inputHash}.json`, inputHash };
}

async function publish(db, env, index) {
  if (index.expires_at <= now() || env.DEMO_STOP_AT && Date.parse(env.DEMO_STOP_AT) <= Date.now()) return;
  await env.EVIDENCE_BUCKET.put(index.key, index.payload, { onlyIf: { etagDoesNotMatch: '*' }, httpMetadata: { contentType: 'application/json' }, customMetadata: { sha256: index.payload_hash } });
  const object = await env.EVIDENCE_BUCKET.get(index.key);
  if (!object || object.size !== index.payload_bytes || await digest(await object.text()) !== index.payload_hash) throw Error('Index readback differs');
  await db.prepare("UPDATE repository_indexes SET state='READY' WHERE key=? AND payload_hash=?").bind(index.key, index.payload_hash).run();
}

export async function indexedRead(db, env, row, input, read) {
  if (env.READ_INDEXES !== 'true' || !env.EVIDENCE_BUCKET || !sha(input.ref)) return read();
  const identity = await indexKey(env, row, input);
  const saved = await db.prepare('SELECT * FROM repository_indexes WHERE key=? AND repository_id=? AND expires_at>?').bind(identity.key, row.id, now()).first();
  if (saved) {
    if (saved.input_hash !== identity.inputHash || saved.commit_id !== input.ref || saved.payload_bytes > 256 * 1024 || await digest(saved.payload) !== saved.payload_hash) throw Error('Invalid immutable index');
    env.timings?.count('index_hit');
    return JSON.parse(saved.payload);
  }
  env.timings?.count('index_miss');
  const value = await read(), payload = JSON.stringify(value), bytes = new TextEncoder().encode(payload).length;
  if (value.languagesState === 'REPOSITORY_OVERVIEW_SECTION_STATE_INDEXING' || value.languagesState === 'REPOSITORY_OVERVIEW_SECTION_STATE_ERROR' || value.languagesState === 'REPOSITORY_OVERVIEW_SECTION_STATE_UNAVAILABLE') return value;
  if (bytes > 256 * 1024 || env.DEMO_STOP_AT && Date.parse(env.DEMO_STOP_AT) <= Date.now()) return value;
  // D1 first makes a lost R2 response recoverable with the same immutable key.
  const index = await db.prepare(`INSERT INTO repository_indexes(key,repository_id,commit_id,input_hash,payload,payload_hash,payload_bytes,created_at,expires_at)
    SELECT ?,?,?,?,?,?,?,?,? WHERE (SELECT count(*) FROM repository_indexes)<256
      AND (SELECT count(*) FROM repository_indexes WHERE repository_id=?)<64
    ON CONFLICT(key) DO NOTHING RETURNING *`).bind(identity.key, row.id, input.ref, identity.inputHash, payload, await digest(payload), bytes, now(), new Date(Date.now() + 86400000).toISOString(), row.id).first();
  if (index) {
    const pending = publish(db, env, index).catch(() => {});
    if (env.waitUntil) env.waitUntil(pending); else await pending;
  }
  return value;
}

export async function reconcileIndexes(env) {
  if (env.READ_INDEXES !== 'true' || !env.EVIDENCE_BUCKET) return { published: 0, expired: 0 };
  const db = env.DB.withSession('first-primary');
  const { results } = await db.prepare("SELECT * FROM repository_indexes WHERE state='PENDING' OR expires_at<=? ORDER BY created_at LIMIT 20").bind(now()).all();
  let published = 0, expired = 0, pending = 0;
  for (const index of results) {
    try {
      if (index.expires_at <= now()) { await env.EVIDENCE_BUCKET.delete(index.key); await db.prepare('DELETE FROM repository_indexes WHERE key=? AND expires_at<=?').bind(index.key, now()).run(); expired++; }
      else { await publish(db, env, index); published++; }
    } catch { pending++; }
  }
  return { published, expired, pending };
}
