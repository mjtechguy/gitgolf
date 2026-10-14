import { DatabaseSync } from 'node:sqlite';
import { readFile } from 'node:fs/promises';

// Shared by the pipeline tests (and RUN-C's GitLab tests): an in-memory D1 shim over the real schema and an R2-like bucket.
export function memoryBucket() {
  const objects = new Map();
  return { objects,
    async put(key, value) { const bytes = typeof value === 'string' ? new TextEncoder().encode(value) : value instanceof Uint8Array ? value : new Uint8Array(await new Response(value).arrayBuffer()); objects.set(key, bytes); return { key, size: bytes.length, checksums: {} }; },
    async get(key) { const bytes = objects.get(key); return bytes ? { size: bytes.length, body: new Response(bytes).body, arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length), text: async () => new TextDecoder().decode(bytes) } : null; },
    async delete(keys) { for (const key of [keys].flat()) objects.delete(key); },
    async list({ prefix }) { return { objects: [...objects.keys()].filter(key => key.startsWith(prefix)).map(key => ({ key })) }; } };
}
export async function pipelineFixture(t, extra = {}) {
  const sql = new DatabaseSync(':memory:'); t.after(() => sql.close());
  sql.exec(await readFile(new URL('./schema.sql', import.meta.url), 'utf8'));
  sql.exec(`INSERT INTO users(id,login,email) VALUES(1,'alice','alice@example.invalid'),(2,'bob','bob@example.invalid'); INSERT INTO operations_admins(user_id) VALUES(1);
    INSERT INTO repositories(id,name,description,artifact_name,creator_id,creation_key,input_hash,state,created_at,default_branch) VALUES(1,'project','','repo-${'b'.repeat(32)}',1,'key','hash','ACTIVE','2026-10-12T00:00:00Z','main');
    INSERT INTO grants(repository_id,user_id,role) VALUES(1,1,'admin');`);
  const prepare = query => { const statement = sql.prepare(query); let values = []; return {
    bind(...input) { values = input; return this; }, async first() { return statement.get(...values) || null; },
    async all() { return { results: statement.all(...values) }; }, async run() { return { meta: { changes: statement.run(...values).changes } }; } }; };
  const db = { prepare, async batch(statements) { sql.exec('BEGIN'); try { const values = []; for (const statement of statements) values.push(await statement.run()); sql.exec('COMMIT'); return values; } catch (error) { sql.exec('ROLLBACK'); throw error; } },
    withSession() { return db; } };
  const env = { DB: db, PIPELINES_ENABLED: 'true', PIPELINE_BUCKET: memoryBucket(), PUBLIC_ORIGIN: 'https://golf.example.invalid', WORKSPACE_SLUG: 'alice', ACCOUNT_ID: 'a'.repeat(32), ARTIFACTS_NAMESPACE: 'golf-tests', ...extra };
  return { sql, db, env };
}
