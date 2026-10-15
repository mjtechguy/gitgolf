// Shared by the release and attachment tests: node:sqlite as D1, advertised Git refs and an in-memory
// R2 bucket that honours conditional create and the declared SHA-256, with switchable failures.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { digest, handle, serialize, concurrentRead } from './src/core.mjs';
import { packetLine } from './src/git.mjs';
import { publicFetch } from './src/public.mjs';
import * as esbuild from '../agents/node_modules/esbuild/lib/main.js';

// The generated descriptors the browser uses: responses must parse strictly and hash identically.
const generated = await esbuild.build({ stdin: { contents: "export * from './web/src/gen/golf/v1/golf_pb.ts'; export * from './web/src/gen/golf/v1/forge089_pb.ts'; export { create, toBinary, toJson, fromJson, equals } from './web/node_modules/@bufbuild/protobuf/dist/esm/index.js'", resolveDir: fileURLToPath(new URL('../../', import.meta.url)) }, bundle: true, write: false, format: 'esm', platform: 'neutral' });
export const proto = await import('data:text/javascript;base64,' + Buffer.from(generated.outputFiles[0].text).toString('base64'));
export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
export const tokens = Object.fromEntries(['admin', 'writer', 'reader', 'outsider'].map((name, index) => [name, 'golf_native_' + String.fromCharCode(97 + index).repeat(43)]));
export const commit = 'a'.repeat(40), tagObject = 'c'.repeat(40), origin = 'https://golf.example.com', repository = { owner: 'alice', name: 'project' };

export async function objectFixture(t) {
  const sql = new DatabaseSync(':memory:');
  t.after(() => sql.close());
  sql.exec(await readFile(new URL('./schema.sql', import.meta.url), 'utf8'));
  sql.exec("INSERT INTO users(id,login,full_name) VALUES(1,'alice','Alice A'),(2,'bob',''),(3,'carol',''),(4,'dave','')");
  for (const [index, token] of Object.values(tokens).entries()) sql.prepare('INSERT INTO credentials VALUES(?,?,?,0)').run(await digest(token), index + 1, Math.floor(Date.now() / 1000) + 300);
  sql.exec("INSERT INTO workspaces(slug,artifact_namespace) VALUES('alice','test-space')");
  sql.prepare("INSERT INTO repositories(id,name,description,artifact_name,creator_id,creation_key,input_hash,state,created_at) VALUES(1,'project','',?,1,'original','hash','ACTIVE',?)").run('repo-' + 'b'.repeat(32), new Date().toISOString());
  sql.exec("INSERT INTO grants VALUES(1,1,'admin'),(1,2,'write'),(1,3,'read')");
  const db = {
    withSession(mode) { assert.equal(mode, 'first-primary'); return this; },
    prepare(query) { let values = []; const statement = sql.prepare(query); return {
      bind(...args) { assert.ok(args.every(value => value !== undefined), 'D1 refuses undefined bindings'); values = args; return this; },
      async first() { return statement.get(...values) || null; },
      async all() { return { results: statement.all(...values) }; },
      async run() { return { meta: { changes: statement.run(...values).changes } }; },
    }; },
    async batch(statements) {
      sql.exec('BEGIN');
      try { const results = []; for (const statement of statements) results.push(await statement.run()); sql.exec('COMMIT'); return results; }
      catch (error) { sql.exec('ROLLBACK'); throw error; }
    },
  };
  const refs = new Map([['refs/heads/main', commit], ['refs/tags/light', commit], ['refs/tags/v1.0', tagObject], ['refs/tags/v1.0^{}', commit]]);
  const objects = new Map(), bucket = { puts: 0, losePut: false, loseAcknowledgement: false, failHead: false, failDelete: false };
  const view = key => { const object = objects.get(key); return object ? { key, size: object.bytes.length, customMetadata: object.customMetadata, httpMetadata: object.httpMetadata } : null; };
  const env = { DB: db, pushWaitMs: 100, ACCOUNT_ID: 'c'.repeat(32), ARTIFACTS_NAMESPACE: 'test-space', WORKSPACE_SLUG: 'alice', PUBLIC_ORIGIN: origin,
    ARTIFACTS: { async get(name) { return {
      async info() { return { name, remote: `https://${env.ACCOUNT_ID}.artifacts.cloudflare.net/git/test-space/${name}.git` }; },
      async createToken() { return { plaintext: 'art_v1_read' }; }, async revokeToken() { return true; }, [Symbol.dispose]() {},
      async readCommit(hash) { return hash === commit ? { hash, treeHash: 'f'.repeat(40), parents: [], message: 'Tagged commit', author: { name: 'Alice' }, authoredAt: 1700000000 } : null; },
    }; } },
    EVIDENCE_BUCKET: {
      async put(key, value, options = {}) {
        bucket.puts++;
        if (bucket.losePut) throw Error('R2 write did not arrive');
        const bytes = new Uint8Array(value);
        if (options.sha256 && options.sha256 !== sha256(bytes)) throw Error('R2 checksum mismatch');
        const created = !(options.onlyIf?.etagDoesNotMatch === '*' && objects.has(key));
        if (created) objects.set(key, { bytes, customMetadata: options.customMetadata, httpMetadata: options.httpMetadata });
        if (bucket.loseAcknowledgement) throw Error('R2 acknowledgement lost');
        return created ? view(key) : null;
      },
      async head(key) { if (bucket.failHead) throw Error('R2 read unavailable'); return view(key); },
      async get(key) { const object = objects.get(key); return object ? { ...view(key), body: object.bytes, async arrayBuffer() { return object.bytes.buffer.slice(object.bytes.byteOffset, object.bytes.byteOffset + object.bytes.byteLength); } } : null; },
      async delete(keys) { if (bucket.failDelete) throw Error('R2 delete unavailable'); for (const key of [keys].flat()) objects.delete(key); },
    } };
  const providerFetch = async () => new Response(Buffer.concat([packetLine('# service=git-upload-pack\n'), Buffer.from('0000'),
    ...[...refs].map(([name, hash], index) => packetLine(`${hash} ${name}${index === 0 ? '\0report-status' : ''}\n`)), Buffer.from('0000')]), { headers: { 'Content-Type': 'application/x-git-upload-pack-advertisement' } });
  const dispatch = serialize(request => handle(request, env, providerFetch), concurrentRead);
  const call = (path, body = {}, token = tokens.admin) => dispatch(new Request(origin + (path.startsWith('/') ? path : '/rpc/golf.v1.' + path), {
    method: 'POST', headers: { ...(token ? { Authorization: 'Bearer ' + token } : {}), 'Content-Type': 'application/json', 'Connect-Protocol-Version': '1' }, body: JSON.stringify(body) }));
  // 200 with the JSON value, or the refusal status and code.
  const value = async (path, body, token) => { const response = await call(path, body, token), json = await response.json(); return response.ok ? json : { status: response.status, code: json.code }; };
  // The public Worker in front of the workspace, as a browser GET reaches it.
  const browse = (path, token = tokens.admin, headers = {}, method = 'GET') => publicFetch(new Request(origin + path, { method, headers: { ...(token ? { Authorization: 'Bearer ' + token } : {}), ...headers } }), env,
    { exports: { Workspace: { idFromName: key => key, get: () => ({ fetch: request => dispatch(request) }) } } });
  const target = { repository, repositoryId: '1', ownerId: '1' };
  const access = async (token = tokens.admin) => (await value('RepositoryAccessService/GetRepositoryAccess', target, token)).access;
  return { sql, env, refs, objects, bucket, dispatch, call, value, browse, target, access };
}
