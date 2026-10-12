// Real local workerd/D1/R2; the signing key is a local test value, not a hosted Secrets Store proof.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
const cli = dirname(dirname(realpathSync(process.argv[2])));
const { Miniflare, convertV4MiniflareOptions } = await import(pathToFileURL(resolve(cli, 'node_modules/miniflare/dist/src/index.js')).href);
const source = await readFile(new URL('./demo/worker.mjs', import.meta.url), 'utf8');
const runtime = new Miniflare(convertV4MiniflareOptions({ port: 0, compatibilityDate: '2026-10-09',
  modules: [{ type: 'ESModule', path: 'entry.mjs', contents: "import demo from './demo.mjs'; export default {fetch(request,env){return demo.fetch(request,{...env,APP_SECRET:{get:async()=> 'local-demo-key'}})}}" }, { type: 'ESModule', path: 'demo.mjs', contents: source }],
  bindings: { GOLF_COMMIT: 'a'.repeat(40) }, d1Databases: { DB: 'demo-local-db' }, r2Buckets: { FILES: 'demo-local-files' },
}));
try {
  const db = await runtime.getD1Database('DB'), bucket = await runtime.getR2Bucket('FILES');
  await db.prepare(await readFile(new URL('./demo/schema.sql', import.meta.url), 'utf8')).run();
  assert.equal((await runtime.dispatchFetch('https://demo.invalid/')).status, 200);
  const posted = await runtime.dispatchFetch('https://demo.invalid/api/messages', { method: 'POST', body: 'Real local D1/R2 demo note' });
  assert.equal(posted.status, 201); const { id } = await posted.json();
  const state = await (await runtime.dispatchFetch('https://demo.invalid/api/messages')).json();
  assert.equal(state.messages.length, 1); assert.equal(state.messages[0].body, 'Real local D1/R2 demo note'); assert.equal(state.files, 1);
  const receipt = await bucket.get(id + '.json'), data = await receipt.text();
  assert.equal(JSON.parse(data).commit, 'a'.repeat(40)); assert.equal(receipt.customMetadata.signature.length, 64);
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode('local-demo-key'), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
  assert.equal(await crypto.subtle.verify('HMAC', key, Buffer.from(receipt.customMetadata.signature, 'hex'), new TextEncoder().encode(data)), true);
  assert.equal((await runtime.dispatchFetch('https://demo.invalid/api/messages', { method: 'POST', body: 'x'.repeat(501) })).status, 400);
  assert.equal((await bucket.list()).objects.length, 1);
  console.log('Demo Worker executed with real local D1/R2, signed receipt verification and input rejection');
} finally { await runtime.dispose(); }
