import { digest, Fault } from './common.mjs';
import { sha, remote } from './git.mjs';
import { indexKey, indexedRead } from './repository-indexes.mjs';
import { classifierVersion, language, rootMetadata, excludedDirectory, textBlob } from './repository-metadata.mjs';

const rows = cursor => [...cursor];
const now = () => new Date().toISOString();
const available = 'REPOSITORY_OVERVIEW_SECTION_STATE_AVAILABLE';
const indexing = 'REPOSITORY_OVERVIEW_SECTION_STATE_INDEXING';
const failed = 'REPOSITORY_OVERVIEW_SECTION_STATE_ERROR';
async function reserveOperations(db, count) {
  const result = await db.prepare(`INSERT INTO repository_index_budget(day,operations) SELECT ?,?
    ON CONFLICT(day) DO UPDATE SET operations=operations+excluded.operations WHERE operations+excluded.operations<=60000 RETURNING operations`).bind(now().slice(0, 10), count).first();
  if (!result) throw new Fault('resource_exhausted', 429, 'The workspace daily indexing allocation is used.');
}
export function initializeMetadataJobs(ctx) {
  ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS metadata_jobs(key TEXT PRIMARY KEY, repository_id INTEGER, name TEXT, artifact_name TEXT, user_id INTEGER, commit_id TEXT, state TEXT, result TEXT, attempts INTEGER DEFAULT 0, expires_at TEXT)`);
  ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS metadata_items(job_key TEXT, path TEXT, hash TEXT, type TEXT, cursor INTEGER DEFAULT 0, done INTEGER DEFAULT 0, PRIMARY KEY(job_key,path))`);
  ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS metadata_blob_sizes(scope TEXT, hash TEXT, size INTEGER, PRIMARY KEY(scope,hash))`);
}
function wire(job) {
  const value = JSON.parse(job.result);
  return { licenseIds: value.licenseIds, licensePaths: value.licensePaths, languages: job.state === 'READY' ? Object.entries(value.languages).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([name, bytes]) => ({ name, byteCount: String(bytes) })) : [],
    languagesState: job.state === 'READY' ? available : job.state === 'FAILED' ? failed : indexing, licensesState: available,
    indexedCommitId: job.commit_id, indexedFiles: job.state === 'READY' ? value.processed : 0, indexingProcessed: value.processed, languageClassifier: 'Linguist filename map with root attributes and generated/vendor exclusions' };
}

export async function metadataJob(ctx, env, row, person, repo, commitId) {
  const { key } = await indexKey(env, row, { kind: 'overview', ref: commitId });
  ctx.storage.transactionSync(() => {
    ctx.storage.sql.exec('DELETE FROM metadata_items WHERE job_key IN (SELECT key FROM metadata_jobs WHERE expires_at<=?)', now());
    ctx.storage.sql.exec('DELETE FROM metadata_jobs WHERE expires_at<=?', now());
  });
  let job = rows(ctx.storage.sql.exec('SELECT * FROM metadata_jobs WHERE key=?', key))[0];
  if (job?.state === 'FAILED' && Date.parse(job.expires_at) - Date.now() < 540000) {
    ctx.storage.transactionSync(() => {
      ctx.storage.sql.exec('DELETE FROM metadata_items WHERE job_key=?', key);
      ctx.storage.sql.exec('DELETE FROM metadata_jobs WHERE key=?', key);
    });
    job = undefined;
  }
  if (!job) {
    if (env.DEMO_STOP_AT && Date.parse(env.DEMO_STOP_AT) <= Date.now()) throw Error('Metadata session ended');
    const total = rows(ctx.storage.sql.exec('SELECT count(*) AS total FROM metadata_jobs'))[0].total;
    const live = rows(ctx.storage.sql.exec("SELECT count(*) AS total FROM metadata_jobs WHERE state='RUNNING'"))[0].total;
    if (live >= 2 || total >= 64) return { languages: [], licenseIds: [], licensePaths: [], languagesState: indexing, licensesState: indexing, indexedCommitId: commitId };
    await reserveOperations(env.DB.withSession('first-primary'), 32);
    const root = await rootMetadata(repo, commitId);
    const result = JSON.stringify({ ...root, classifierVersion, generation: crypto.randomUUID(), languages: {}, processed: 0 });
    ctx.storage.transactionSync(() => {
      ctx.storage.sql.exec("INSERT OR IGNORE INTO metadata_jobs(key,repository_id,name,artifact_name,user_id,commit_id,state,result,expires_at) VALUES(?,?,?,?,?,?,'RUNNING',?,?)", key, row.id, row.name, row.artifact_name, person.id, commitId, result, new Date(Date.now() + 600000).toISOString());
      ctx.storage.sql.exec("INSERT OR IGNORE INTO metadata_items(job_key,path,hash,type) VALUES(?,'',?,'tree')", key, root.treeHash);
    });
    job = rows(ctx.storage.sql.exec('SELECT * FROM metadata_jobs WHERE key=?', key))[0];
  }
  if (job.state === 'RUNNING') await ctx.storage.setAlarm(Date.now() + 100);
  return wire(job);
}

export async function advanceMetadataJobs(ctx, env) {
  const jobs = rows(ctx.storage.sql.exec("SELECT * FROM metadata_jobs WHERE state='RUNNING' ORDER BY expires_at LIMIT 2"));
  for (const job of jobs) {
    const db = env.DB.withSession('first-primary');
    let repo;
    try {
      const result = JSON.parse(job.result);
      if (result.classifierVersion !== classifierVersion) {
        // A rollout cannot publish partial totals produced by another classifier.
        ctx.storage.transactionSync(() => {
          ctx.storage.sql.exec("UPDATE metadata_jobs SET state='FAILED' WHERE key=?", job.key);
          ctx.storage.sql.exec('DELETE FROM metadata_items WHERE job_key=?', job.key);
        });
        continue;
      }
      const owner = await db.prepare(`SELECT r.* FROM repositories r JOIN grants g ON g.repository_id=r.id JOIN users u ON u.id=g.user_id
        WHERE r.id=? AND r.artifact_name=? AND r.state='ACTIVE' AND g.user_id=? AND u.active=1`).bind(job.repository_id, job.artifact_name, job.user_id).first();
      if (!owner || job.expires_at <= now() || env.DEMO_STOP_AT && Date.parse(env.DEMO_STOP_AT) <= Date.now()) throw Error('Metadata authority ended');
      const cached = env.READ_INDEXES === 'true' && await db.prepare('SELECT payload,payload_hash,commit_id FROM repository_indexes WHERE key=? AND repository_id=? AND expires_at>?').bind(job.key, job.repository_id, now()).first();
      if (cached && cached.commit_id === job.commit_id && await digest(cached.payload) === cached.payload_hash) {
        const value = JSON.parse(cached.payload);
        if (value.indexedCommitId === job.commit_id && value.languagesState === available && value.licensesState === available) {
          // An independently qualified Git snapshot can finish the same immutable index.
          result.languages = Object.fromEntries(value.languages.map(item => [item.name, Number(item.byteCount)])); result.processed = value.indexedFiles;
          result.licenseIds = value.licenseIds; result.licensePaths = value.licensePaths;
          ctx.storage.transactionSync(() => {
            const updated = rows(ctx.storage.sql.exec("UPDATE metadata_jobs SET state='READY',result=? WHERE key=? AND expires_at=? AND result=? AND state='RUNNING' RETURNING key", JSON.stringify(result), job.key, job.expires_at, job.result));
            if (updated.length) ctx.storage.sql.exec('DELETE FROM metadata_items WHERE job_key=?', job.key);
          });
          continue;
        }
      }
      const items = rows(ctx.storage.sql.exec('SELECT * FROM metadata_items WHERE job_key=? AND done=0 LIMIT 128', job.key));
      await reserveOperations(db, items.length + 2);
      repo = await env.ARTIFACTS.get(job.artifact_name);
      const info = await repo.info();
      if (info.name !== job.artifact_name || info.remote !== remote(env, job.artifact_name)) throw Error('Metadata provider identity differs');
      const changes = [];
      for (let offset = 0; offset < items.length; offset += 2) await Promise.all(items.slice(offset, offset + 2).map(async item => {
        if (item.type === 'tree') {
          const tree = await repo.readTree(item.hash);
          if (!tree || tree.length > 10000) throw Error('Metadata directory exceeds its bound');
          const selected = tree.slice(item.cursor, item.cursor + 64);
          const children = selected.map(child => {
            const path = item.path ? item.path + '/' + child.name : child.name;
            if (!sha(child.hash) || !child.name || child.name.includes('/') || path.split('/').length > 48) throw Error('Invalid metadata tree');
            language(path, result.rules);
            return { path, ...child };
          }).filter(child => child.type !== 'tree' || !excludedDirectory(child.path, result.rules));
          changes.push({ item, children, cursor: item.cursor + selected.length, done: item.cursor + selected.length >= tree.length });
        } else {
          const name = ['blob', 'exec'].includes(item.type) ? language(item.path, result.rules) : undefined;
          let size;
          if (name) {
            const scope = await digest(JSON.stringify([env.ACCOUNT_ID, env.ARTIFACTS_NAMESPACE, job.artifact_name]));
            const known = rows(ctx.storage.sql.exec('SELECT size FROM metadata_blob_sizes WHERE scope=? AND hash=?', scope, item.hash))[0];
            if (known) size = known.size;
            else {
              const blob = await repo.readBlob(item.hash);
              if (!blob || !Number.isSafeInteger(blob.size) || blob.size > 32 * 1024 * 1024) throw Error('Invalid indexed blob size');
              // Negative sizes mark immutable binary objects without counting their bytes.
              size = await textBlob(blob) ? blob.size : -1;
              ctx.storage.sql.exec('INSERT OR IGNORE INTO metadata_blob_sizes SELECT ?,?,? WHERE (SELECT count(*) FROM metadata_blob_sizes)<100000', scope, item.hash, size);
            }
            if (size > 0) result.languages[name] = (result.languages[name] || 0) + size;
          }
          result.processed++; changes.push({ item, done: true });
        }
      }));
      const queued = rows(ctx.storage.sql.exec('SELECT count(*) AS total FROM metadata_items WHERE job_key=?', job.key))[0].total;
      if (queued + changes.reduce((sum, change) => sum + (change.children?.length || 0), 0) > 100000) throw Error('Metadata inventory exceeds its bound');
      const applied = ctx.storage.transactionSync(() => {
        // Foreground expiry/retry can replace a job while provider reads are pending.
        const current = rows(ctx.storage.sql.exec("SELECT 1 FROM metadata_jobs WHERE key=? AND expires_at=? AND result=? AND state='RUNNING'", job.key, job.expires_at, job.result))[0];
        if (!current || job.expires_at <= now()) return false;
        for (const change of changes) {
          for (const child of change.children || []) ctx.storage.sql.exec('INSERT OR IGNORE INTO metadata_items(job_key,path,hash,type) VALUES(?,?,?,?)', job.key, child.path, child.hash, child.type);
          ctx.storage.sql.exec('UPDATE metadata_items SET cursor=?,done=? WHERE job_key=? AND path=?', change.cursor || 0, Number(change.done), job.key, change.item.path);
        }
        ctx.storage.sql.exec('UPDATE metadata_jobs SET result=? WHERE key=?', JSON.stringify(result), job.key);
        return true;
      });
      if (!applied) continue;
      const remaining = rows(ctx.storage.sql.exec('SELECT count(*) AS total FROM metadata_items WHERE job_key=? AND done=0', job.key))[0].total;
      if (!remaining) {
        ctx.storage.sql.exec("UPDATE metadata_jobs SET state='READY' WHERE key=?", job.key); job.state = 'READY'; job.result = JSON.stringify(result);
        ctx.storage.sql.exec('DELETE FROM metadata_items WHERE job_key=?', job.key);
        await indexedRead(db, env, owner, { kind: 'overview', ref: job.commit_id }, async () => wire(job));
        if (env.notifyMetadata) await env.notifyMetadata(job.repository_id);
      }
    } catch {
      ctx.storage.sql.exec("UPDATE metadata_jobs SET attempts=attempts+1,state=CASE WHEN attempts>=2 OR expires_at<=? THEN 'FAILED' ELSE state END WHERE key=? AND expires_at=? AND result=?", now(), job.key, job.expires_at, job.result);
    } finally { repo?.[Symbol.dispose](); }
  }
  const pending = rows(ctx.storage.sql.exec("SELECT count(*) AS total FROM metadata_jobs WHERE state='RUNNING'"))[0].total;
  if (pending) await ctx.storage.setAlarm(Date.now() + 1000);
  return { pending };
}
