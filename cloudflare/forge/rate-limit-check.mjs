// Anonymous read throttling on real workerd, D1 and the local Workers rate limiting simulator; no provider writes.
// Run: node cloudflare/forge/rate-limit-check.mjs "$(command -v cf)". The simulator is one location: per-location drift is not exercised.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import * as esbuild from '../agents/node_modules/esbuild/lib/main.js';
import { digest } from './src/common.mjs';
const cli = dirname(dirname(realpathSync(process.argv[2])));
if (JSON.parse(await readFile(resolve(cli, 'package.json'), 'utf8')).version !== '1.0.0-beta.13') throw Error('Qualify native CLI');
const { Miniflare, convertV4MiniflareOptions } = await import(pathToFileURL(resolve(cli, 'node_modules/miniflare/dist/src/index.js')).href);
// One bundle, built the way release.mjs builds the production Worker.
const built = await esbuild.build({ entryPoints: ['cloudflare/forge/src/worker.mjs'], bundle: true, write: false, format: 'esm', platform: 'neutral',
  define: { GOLF_NATIVE_ASSETS: 'null', GOLF_NATIVE_RELEASE: '"local"', GOLF_NATIVE_CONFIGURATION: '"local"' }, nodePaths: ['cloudflare/agents/node_modules'],
  conditions: ['workerd', 'worker', 'browser'], external: ['cloudflare:workers', 'node:*'] });
const origin = 'https://golf.example.com', token = 'golf_native_' + 'a'.repeat(43);
const start = limited => new Miniflare(convertV4MiniflareOptions({
  host: '127.0.0.1', port: 0, modules: [{ type: 'ESModule', path: 'worker.mjs', contents: built.outputFiles[0].text }], compatibilityDate: '2026-10-08', compatibilityFlags: ['nodejs_compat'],
  bindings: { PUBLIC_ORIGIN: origin, WORKSPACE_SLUG: 'alice', ARTIFACTS_NAMESPACE: 'local-limit-proof', ACCOUNT_ID: 'a'.repeat(32), ACCESS_AUD: 'local-limit-proof', ACCESS_TEAM_DOMAIN: 'https://local-limit-proof.cloudflareaccess.com',
    PUBLIC_REPOSITORIES: 'true', ...(limited ? { ANONYMOUS_READ_LIMIT: '10/60' } : {}) },
  ...(limited ? { ratelimits: { ANONYMOUS_READS: { namespace_id: '1001', simple: { limit: 10, period: 60 } } } } : {}),
  d1Databases: { DB: 'local-limit-proof' }, durableObjects: { WORKSPACE: { className: 'Workspace', useSQLite: true } },
}));
for (const limited of [true, false]) {
  const runtime = start(limited);
  try {
    const db = await runtime.getD1Database('DB');
    for (const sql of (await readFile(new URL('./schema.sql', import.meta.url), 'utf8')).replace(/--[^\n]*/g, '').split(/;\s*(?=CREATE\b)/).filter(s => s.trim())) await db.prepare(sql).run();
    await db.prepare("INSERT INTO users(id,login,can_create) VALUES(1,'alice',1)").run();
    await db.prepare("INSERT INTO workspaces(slug,artifact_namespace) VALUES('alice','local-limit-proof')").run();
    await db.prepare('INSERT INTO credentials VALUES(?,?,?,0)').bind(await digest(token), 1, Math.floor(Date.now() / 1000) + 300).run();
    const discover = (headers = {}) => runtime.dispatchFetch(origin + '/native/discover', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Connect-Protocol-Version': '1', ...headers }, body: '{}' });
    const clone = (headers = {}) => runtime.dispatchFetch(origin + '/git/alice/missing.git/info/refs?service=git-upload-pack', { headers });
    for (let i = 0; i < 10; i++) { const response = await discover(); assert.equal(response.status, 200, await response.clone().text()); assert.deepEqual((await response.json()).repositories, []); }
    const over = await discover(), git = await clone();
    if (!limited) {
      // Without the binding the same burst reaches the workspace, which answers as it always has.
      assert.equal(over.status, 200); assert.equal(git.status, 404);
      for (let i = 0; i < 20; i++) assert.equal((await discover()).status, 200);
      console.log('Real workerd/D1 without the binding: 31 anonymous public reads and one clone reached the workspace unchanged');
      continue;
    }
    assert.equal(over.status, 429); assert.equal(over.headers.get('Retry-After'), '60'); assert.equal((await over.json()).code, 'resource_exhausted');
    assert.equal(git.status, 429); assert.match(await git.text(), /^Too many anonymous requests from this network\./);
    // A presented credential is never counted: valid ones are served, invalid ones are refused by authentication, not by the limiter.
    for (let i = 0; i < 15; i++) assert.equal((await discover({ Authorization: 'Bearer ' + token })).status, 200);
    assert.equal((await discover({ Authorization: 'Bearer golf_native_' + 'b'.repeat(43) })).status, 401);
    assert.equal((await clone({ Authorization: 'Bearer ' + token })).status, 404);
    // Anonymous requests outside the public read contract are not counted either; the workspace refuses them itself.
    const session = await runtime.dispatchFetch(origin + '/rpc/golf.v1.SessionService/GetSession', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Connect-Protocol-Version': '1' }, body: '{}' });
    assert.equal(session.status, 200); assert.deepEqual(await session.json(), {});
    assert.equal((await discover()).status, 429);
    console.log('Real workerd/D1/local rate limiting: 10 anonymous public reads admitted, the next read and clone refused with 429, credentialed requests never limited');
  } finally { await runtime.dispose(); }
}
