import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handle, dynamicPath } from './src/worker.mjs';

const env = { GOLF_PUBLIC_ORIGIN: 'https://control.example.com', GOLF_BRIDGE_ORIGIN: 'https://origin.example.com',
  GOLF_ACCESS_CLIENT_ID: 'transport-id', GOLF_ACCESS_CLIENT_SECRET: 'transport-secret' };
const req = (path, init = {}) => new Request(env.GOLF_PUBLIC_ORIGIN + path, init);

test('all existing backend namespaces and Git protocol requests reach the bridge', () => {
  for (const path of ['/rpc/golf.v1.GolfService/GetSession', '/api/deployments/id/open', '/auth/access/token',
    '/hooks/forgejo/connection', '/internal/cloudflare/preview', '/internal/ci/poll', '/notifications/unsubscribe',
    '/healthz', '/readyz', '/git/a/repo.git/info/refs', '/a/repo.git/info/refs', '/a/repo/git-upload-pack']) assert.ok(dynamicPath(path), path);
  for (const path of ['/', '/a/repo/pulls/1', '/assets/app-12345678.js', '/git/repo', '/apiary']) assert.ok(!dynamicPath(path), path);
});

test('streams bytes; preserves Golf identity/Origin while replacing spoofed transport authority', async () => {
  const request = req('/rpc/golf.v1.GolfService/GetSession?x=1', { method: 'POST', body: 'payload', headers: {
    Authorization: 'Bearer golf-user', Origin: env.GOLF_PUBLIC_ORIGIN,
    Cookie: 'golf_session=private; CF_Authorization=do-not-forward',
    'CF-Access-Client-Secret': 'forged', 'CF-Access-Jwt-Assertion': 'forged', 'X-Forwarded-Host': 'evil.example',
  } });
  let calls = 0;
  const result = await handle(request, env, async (url, options) => {
    calls++;
    assert.equal(url, env.GOLF_BRIDGE_ORIGIN + '/rpc/golf.v1.GolfService/GetSession?x=1');
    assert.equal(options.body, request.body);
    assert.equal(options.headers.get('Authorization'), 'Bearer golf-user');
    assert.equal(options.headers.get('Origin'), env.GOLF_PUBLIC_ORIGIN);
    assert.equal(options.headers.get('CF-Access-Client-Secret'), 'transport-secret');
    assert.equal(options.headers.get('CF-Access-Jwt-Assertion'), null);
    assert.equal(options.headers.get('X-Forwarded-Host'), null);
    assert.equal(options.headers.get('Cookie'), 'golf_session=private');
    assert.equal(options.redirect, 'manual');
    const headers = new Headers({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'public', 'Referrer-Policy': 'strict-origin' });
    headers.append('Set-Cookie', 'golf_session=new; Secure; HttpOnly; SameSite=Lax');
    headers.append('Set-Cookie', 'golf_other=two; Secure; HttpOnly');
    headers.append('Set-Cookie', 'CF_Authorization=transport-only');
    return new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode('data: update\n\n')); c.close(); } }), { headers });
  });
  assert.equal(calls, 1);
  assert.equal(result.headers.getSetCookie().length, 2);
  assert.equal(result.headers.get('Referrer-Policy'), 'strict-origin');
  assert.equal(result.headers.get('Cache-Control'), 'no-store');
  assert.equal(await result.text(), 'data: update\n\n');
});

test('does not follow redirects with service secrets; maps only bridge locations', async () => {
  for (const [location, expected, status] of [
    ['/api/deployments/id/resume', env.GOLF_PUBLIC_ORIGIN + '/api/deployments/id/resume', 303],
    ['https://forge.example.com/login', 'https://forge.example.com/login', 303],
    ['https://team.cloudflareaccess.com/cdn-cgi/access/login', null, 502],
  ]) {
    const result = await handle(req('/auth/forgejo/callback'), env, async () => new Response(null, { status: 303, headers: { location } }));
    assert.equal(result.status, status);
    assert.equal(result.headers.get('location'), expected);
  }
});

test('serves public UI without forwarding user secrets; missing APIs never become SPA HTML', async () => {
  const assets = [];
  const configured = { ...env, ASSETS: { fetch: async request => {
    assets.push(request);
    assert.equal(request.headers.get('cookie'), null);
    assert.equal(request.headers.get('authorization'), null);
    return new Response('app', { status: new URL(request.url).pathname === '/index.html' ? 200 : 404 });
  } } };
  const ui = await handle(req('/a/repo/pulls/1', { headers: { accept: 'text/html', cookie: 'golf_session=secret' } }), configured);
  assert.equal(ui.status, 200);
  assert.equal(assets.length, 2);
  const api = await handle(req('/api/unknown', { headers: { accept: 'text/html' } }), configured, async () => new Response('not found', { status: 404 }));
  assert.equal(api.status, 404);
  assert.equal(assets.length, 2);
});

test('rejects alternate hosts, invalid origins, encoded separators and unavailable transports', async () => {
  const forbidden = () => { throw Error('must not call upstream'); };
  assert.equal((await handle(new Request('https://alternate.example.com/rpc'), env, forbidden)).status, 404);
  for (const origin of ['http://origin.example.com', env.GOLF_PUBLIC_ORIGIN, 'https://origin.example.com/path', 'https://user@origin.example.com']) {
    assert.equal((await handle(req('/rpc'), { ...env, GOLF_BRIDGE_ORIGIN: origin }, forbidden)).status, 503);
  }
  assert.equal((await handle(req('/api%2Fsecret'), env, forbidden)).status, 400);
  assert.equal((await handle(req('/rpc', { headers: { upgrade: 'websocket' } }), env, forbidden)).status, 400);
  assert.equal((await handle(req('/rpc'), env, async () => { throw Error('secret upstream URL'); })).status, 502);
});
