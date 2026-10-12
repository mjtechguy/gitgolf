// Uses workerd shipped in the qualified native CLI; no provider access or writes.
import assert from 'node:assert/strict';
import { realpathSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

if (process.argv.length !== 3) throw Error('Usage: node runtime-check.mjs CF_EXECUTABLE');
const cliRoot = dirname(dirname(realpathSync(process.argv[2])));
if (JSON.parse(await readFile(resolve(cliRoot, 'package.json'), 'utf8')).version !== '1.0.0-beta.13') {
  throw Error('Qualify the installed native cf runtime');
}
const { Miniflare, convertV4MiniflareOptions } = await import(pathToFileURL(resolve(cliRoot, 'node_modules/miniflare/dist/src/index.js')).href);
const runtime = new Miniflare(convertV4MiniflareOptions({
  compatibilityDate: '2026-10-08', port: 0,
  modules: [{ type: 'ESModule', path: 'entry.mjs', contents: `
    import { handle } from './worker.mjs';
    export default { fetch(request) {
      return handle(request, {
        GOLF_PUBLIC_ORIGIN: 'https://control.example.com', GOLF_BRIDGE_ORIGIN: 'https://origin.example.com',
        GOLF_ACCESS_CLIENT_ID: 'service-id', GOLF_ACCESS_CLIENT_SECRET: 'service-secret',
        ASSETS: { fetch() { return new Response('<html>Golf</html>', { headers: { 'Content-Type': 'text/html' } }); } },
      }, async (url, options) => {
        if (options.headers.get('Authorization') !== 'Bearer golf-user' || options.redirect !== 'manual') throw Error('transport changed');
        const headers = new Headers({ 'Content-Type': 'text/event-stream', 'Referrer-Policy': 'strict-origin' });
        headers.append('Set-Cookie', 'golf_session=one; Secure; HttpOnly; Expires=Wed, 09 Oct 2030 00:00:00 GMT');
        headers.append('Set-Cookie', 'golf_other=two; Secure; HttpOnly');
        headers.append('Set-Cookie', 'CF_Authorization=service-only');
        return new Response(options.body, { headers });
      });
    } };
  ` }, { type: 'ESModule', path: 'worker.mjs', contents: await readFile(new URL('./src/worker.mjs', import.meta.url), 'utf8') }],
}));
try {
  const result = await runtime.dispatchFetch('https://control.example.com/rpc/test', {
    method: 'POST', body: 'data: update\n\n', headers: { Authorization: 'Bearer golf-user' },
  });
  assert.equal(result.status, 200);
  assert.equal(await result.text(), 'data: update\n\n');
  assert.equal(result.headers.getSetCookie().length, 2);
  assert.ok(!result.headers.get('set-cookie').includes('service-only'));
  assert.equal(result.headers.get('cache-control'), 'no-store');
  assert.equal(result.headers.get('referrer-policy'), 'strict-origin');
  const ui = await runtime.dispatchFetch('https://control.example.com/');
  assert.equal(ui.status, 200);
  assert.equal(await ui.text(), '<html>Golf</html>');
  console.log('Native local workerd control routing/cookies/streaming passed; fixture origin only');
} finally { await runtime.dispose(); }
