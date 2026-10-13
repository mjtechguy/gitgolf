import { test } from 'node:test';
import assert from 'node:assert/strict';
import { publicFetch, embeddedAsset } from './src/public.mjs';
import { readUIAssets } from './ui-assets.mjs';
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import gateway from './src/preview-gateway.mjs';

test('native UI assets embed exact font bytes without an Access-dropping Static Assets router', async () => {
  const root = await mkdtemp(join(tmpdir(), 'golf-native-ui-'));
  try {
    await mkdir(join(root, 'assets'));
    await writeFile(join(root, 'native.html'), '<html>Golf</html>');
    const bytes = Uint8Array.of(0, 255, 128, 42);
    await writeFile(join(root, 'assets', 'font.woff2'), bytes);
    const assets = await readUIAssets(root);
    const response = embeddedAsset(new Request('https://golf.example/assets/font.woff2'), assets);
    assert.equal(response.headers.get('Content-Type'), 'font/woff2'); assert.equal(response.headers.get('Cache-Control'),'no-store');
    const immutable = embeddedAsset(new Request('https://golf.example/assets/font-abcd1234.woff2'), {'/assets/font-abcd1234.woff2':assets['/assets/font.woff2']});
    assert.equal(immutable.headers.get('Cache-Control'),'private, max-age=31536000, immutable');
    assert.deepEqual(new Uint8Array(await response.arrayBuffer()), bytes);
    assert.equal(await embeddedAsset(new Request('https://golf.example/native.html', { method: 'HEAD' }), assets).text(), '');
    assert.equal(embeddedAsset(new Request('https://golf.example/toString'), assets).status, 404);
    await symlink(join(root, 'native.html'), join(root, 'linked.html'));
    await assert.rejects(readUIAssets(root), /Unsupported/);
    await rm(join(root, 'linked.html'));
    await writeFile(join(root, 'large.js'), new Uint8Array(4 * 1024 * 1024));
    await assert.rejects(readUIAssets(root), /Unsupported|exceeds/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('configured Access fails closed before native assets, bearer or spoofed identity can enter', async () => {
  let calls = 0;
  const env = { PUBLIC_ORIGIN: 'https://golf.example.com', ACCESS_AUD: 'a'.repeat(64), ASSETS: { fetch() { calls++; throw Error('No asset dispatch'); } } };
  const request = new Request(env.PUBLIC_ORIGIN + '/', { headers: { Authorization: 'Bearer golf_native_' + 'a'.repeat(43), 'X-Golf-Native-Access-Email': 'owner@example.com', 'Cf-Access-Jwt-Assertion': 'forged' } });
  assert.equal((await publicFetch(request, env, {})).status, 401);
  assert.equal((await publicFetch(request, env, { access: { aud: 'other' } })).status, 401);
  assert.equal((await publicFetch(new Request('https://other.example.com/'), env, {})).status, 404);
  assert.equal(calls, 0);
});

test('machine protocol routes reach the coordinator without a browser Access identity',async()=>{
  const forwarded=[];
  const env={PUBLIC_ORIGIN:'https://golf.example.com',ACCESS_AUD:'aud',WORKSPACE_SLUG:'team'};
  const ctx={exports:{Workspace:{idFromName:key=>key,get:()=>({fetch:async request=>{
    forwarded.push([new URL(request.url).pathname,request.headers.get('Authorization'),request.headers.get('X-Golf-Native-Access-Email')]);
    return new Response('coordinator denied',{status:403});
  }})}}};
  for(const [path,authorization] of [['/api/v4/runners/verify',''],['/api/v4/jobs/1/git/info/refs','Basic dGVzdA=='],['/native/runner-machine/claim','Bearer golf_runner_invalid']]) {
    const response=await publicFetch(new Request(env.PUBLIC_ORIGIN+path,{method:'POST',headers:{...(authorization?{Authorization:authorization}:{})}}),env,ctx);
    assert.equal(response.status,403);
  }
  assert.deepEqual(forwarded.map(row=>row[0]),['/api/v4/runners/verify','/api/v4/jobs/1/git/info/refs','/native/runner-machine/claim']);
  assert.ok(forwarded.every(row=>row[2]===null));
  assert.equal((await publicFetch(new Request(env.PUBLIC_ORIGIN+'/native/runner-admin'),env,ctx)).status,401);
});

test('retained generic assets require Access but no Golf session or repository lookup', async () => {
  let reads = 0;
  const env = { PUBLIC_ORIGIN: 'https://golf.example.com', ACCESS_AUD: 'aud', EVIDENCE_BUCKET: { async get(key) {
    reads++; assert.equal(key, 'ui-assets/assets/old-abcd1234.js');
    return { size: 9, body: 'old build', httpMetadata: { contentType: 'text/javascript; charset=utf-8' } };
  } } };
  const request = new Request(env.PUBLIC_ORIGIN + '/assets/old-abcd1234.js', { headers: { 'X-Request-ID': 'secret-client-value' } });
  assert.equal((await publicFetch(request, env, {})).status, 401); assert.equal(reads, 0);
  const response = await publicFetch(request, env, { access: { aud: 'aud', getIdentity() { throw Error('No identity lookup for generic assets'); } } });
  assert.equal(response.status, 200); assert.equal(await response.text(), 'old build');
  assert.equal(response.headers.get('Cache-Control'), 'private, max-age=31536000, immutable');
  assert.match(response.headers.get('X-Request-ID'), /^[a-f0-9-]{36}$/); assert.match(response.headers.get('Server-Timing'), /worker;dur=/);
  assert.equal(reads, 1);
  for (const path of ['/assets/old-abcd1234.js?credential=secret', '/assets/old-abcd1234.js/extra', '/assets/private.json']) {
    assert.equal((await publicFetch(new Request(env.PUBLIC_ORIGIN + path), env, { access: { aud: 'aud' } })).status, 503);
    assert.equal(reads, 1);
  }
});

test('native UI requires an active Golf identity and strips all credentials from asset reads', async () => {
  const env = { PUBLIC_ORIGIN: 'https://golf.example.com', ACCESS_AUD: 'a'.repeat(64), PREVIEW_ORIGIN: 'https://preview.example.net' };
  let received, assets = 0, authorized = true;
  env.ASSETS = { async fetch(request) { assets++; assert.equal([...request.headers].length, 0); return new Response('<html><script id="golf-session" type="application/json">null</script>Golf</html>', { headers: { 'Content-Type': 'text/html' } }); } };
  const ctx = { access: { aud: env.ACCESS_AUD, async getIdentity() { return { email: 'owner@example.com' }; } }, exports: { Workspace: {
    idFromName(value) { return value; }, get() { return { async fetch(request) { received = request; return authorized ? Response.json({ user: { id: '1', fullName: '</script><script>bad()</script>' } }) : Response.json({ code: 'unauthenticated' }, { status: 401 }); } }; },
  } } };
  const response = await publicFetch(new Request(env.PUBLIC_ORIGIN + '/', { headers: { 'X-Golf-Native-Access-Email': 'forged@example.com', Cookie: 'CF_Authorization=secret' } }), env, ctx);
  assert.equal(response.status, 200); assert.equal(assets, 1); assert.equal(received.headers.get('X-Golf-Native-Access-Email'), 'owner@example.com');
  const html = await response.text(); assert.ok(html.includes('"id":"1"')); assert.ok(html.includes('\\u003c/script>')); assert.ok(!html.includes('<script>bad()'));
  assert.equal(response.headers.get('Referrer-Policy'), 'strict-origin'); assert.equal(response.headers.get('Cache-Control'), 'no-store'); assert.ok(response.headers.get('Content-Security-Policy').includes("form-action 'self' https://preview.example.net"));
  assert.equal((await publicFetch(new Request(env.PUBLIC_ORIGIN + '/alice/repo/blob/' + 'a'.repeat(40) + '/hello%20world.py?view=source'), env, ctx)).status, 200);
  assert.equal(assets, 2);
  assert.ok(!html.includes('data-golf-default-appearance'));
  for (const [value, served] of [['flare/kumo', true], ['classic', true], ['flare/tiles', false], ['golf"><script>', false]]) {
    const document = await (await publicFetch(new Request(env.PUBLIC_ORIGIN + '/'), { ...env, DEFAULT_APPEARANCE: value }, ctx)).text();
    assert.equal(document.includes(`<html data-golf-default-appearance="${value}">`), served, value); assert.equal(document.includes('data-golf-default-appearance'), served, value);
  }
  assets = 2;
  authorized = false; assert.equal((await publicFetch(new Request(env.PUBLIC_ORIGIN + '/alice/repo/issues/1'), env, ctx)).status, 401); assert.equal(assets, 2);
});

test('read routing is repository-scoped and compatible with a previous workspace export', async () => {
  const env = { PUBLIC_ORIGIN: 'https://golf.example.com', WORKSPACE_SLUG: 'alice', ACCESS_AUD: 'aud' };
  const keys = [], requests = [];
  const namespace = label => ({ idFromName(key) { keys.push([label, key]); return key; }, get() { return { async fetch(request) { requests.push([label, await request.json(), request.headers.get('X-Golf-Native-Access-Email')]); return new Response(label); } }; } });
  const ctx = { access: { aud: 'aud', async getIdentity() { return { email: 'reader@example.com' }; } }, exports: { Workspace: namespace('workspace'), RepositoryReads: namespace('repository') } };
  const request = (owner = 'alice', method = 'GetContents') => new Request(env.PUBLIC_ORIGIN + '/rpc/golf.v1.RepositoryService/' + method, { method: 'POST', headers: { 'X-Golf-Native-Access-Email': 'forged', 'Content-Type': 'application/json' }, body: JSON.stringify({ repository: { owner, name: 'project' }, repositoryId: '1', ref: 'a'.repeat(40) }) });
  assert.equal(await (await publicFetch(request(), env, ctx)).text(), 'repository');
  assert.deepEqual(keys.at(-1), ['repository', 'alice/project']); assert.equal(requests.at(-1)[2], 'reader@example.com');
  assert.equal(await (await publicFetch(request('alice','GetRepositoryFileIndex'), env, ctx)).text(), 'repository');
  assert.equal(await (await publicFetch(request('other'), env, ctx)).text(), 'repository');
  assert.equal(await (await publicFetch(request('alice', 'CreateRepository'), env, ctx)).text(), 'workspace');
  delete ctx.exports.RepositoryReads;
  assert.equal(await (await publicFetch(request(), env, ctx)).text(), 'workspace');
});

test('preview gateway requires runtime Access and exact scoped cookies, with no shared control session', async () => {
  const id = crypto.randomUUID(), origin = 'https://preview.example.net', credential = 'c'.repeat(43);
  const ctx = { access: { aud: 'aud', async getIdentity() { return { email: 'reader@example.com' }; } } };
  let calls = 0;
  const env = { PREVIEW_ORIGIN: origin, ACCESS_AUD: 'aud', FORGE: { async preview(input) {
    calls++; assert.equal(input.previewId, id); assert.equal(input.credential, credential); assert.equal(input.email, 'reader@example.com');
    return { content: '<h1>private preview</h1>', contentType: 'text/html; charset=utf-8', commitId: 'a'.repeat(40) };
  } } };
  const headers = { Cookie: `__Host-golf_preview_${id}=${credential}` };
  assert.equal((await gateway.fetch(new Request(`${origin}/${id}/`, { headers }), env, {})).status, 404);
  assert.equal((await gateway.fetch(new Request(`${origin}/${id}/`, { headers: { ...headers, 'Cf-Access-Jwt-Assertion': 'forged' } }), env, { access: { ...ctx.access, aud: 'wrong' } })).status, 404);
  const response = await gateway.fetch(new Request(`${origin}/${id}/`, { headers }), env, ctx);
  assert.equal(await response.text(), '<h1>private preview</h1>'); assert.equal(response.headers.get('Cache-Control'), 'no-store');
  assert.ok(response.headers.get('Content-Security-Policy').includes('sandbox allow-scripts;')); assert.ok(!response.headers.get('Content-Security-Policy').includes('allow-same-origin'));
  assert.equal(calls, 1);
  for (const extra of [{ Cookie: headers.Cookie + '; golf_session=control' }, { Authorization: 'Bearer secret' }, { 'Sec-Fetch-Dest': 'serviceworker' }, { Cookie: headers.Cookie + '; ' + headers.Cookie }]) {
    assert.equal((await gateway.fetch(new Request(`${origin}/${id}/`, { headers: { ...headers, ...extra } }), env, ctx)).status, 404);
  }
  assert.equal(calls, 1);
});

test('preview grant exchange carries its secret in a bounded POST and sets a short HttpOnly cookie', async () => {
  const id = crypto.randomUUID(), origin = 'https://preview.example.net', grant = 'g'.repeat(43), session = 's'.repeat(43);
  const env = { PREVIEW_ORIGIN: origin, ACCESS_AUD: 'aud', FORGE: { async preview(input) { assert.equal(input.grant, grant); assert.equal(input.origin, 'https://golf.example.com'); return { session, maxAge: 299 }; } } };
  const ctx = { access: { aud: 'aud', async getIdentity() { return { email: 'reader@example.com' }; } } };
  const response = await gateway.fetch(new Request(`${origin}/${id}/__golf/auth`, { method: 'POST', headers: { Origin: 'https://golf.example.com', 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant }) }), env, ctx);
  assert.equal(response.status, 303); assert.equal(response.headers.get('Location'), `/${id}/`);
  assert.equal(response.headers.get('Set-Cookie'), `__Host-golf_preview_${id}=${session}; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=299`);
  for (const body of ['grant=' + 'g'.repeat(300), new URLSearchParams([['grant', grant], ['grant', grant]])]) {
    assert.equal((await gateway.fetch(new Request(`${origin}/${id}/__golf/auth`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body }), env, ctx)).status, 404);
  }
});

test('a first preview visit completes Access before returning to Golf for a current reviewer grant', async () => {
  const id = crypto.randomUUID(), env = { PREVIEW_ORIGIN: 'https://preview.example.net', PUBLIC_ORIGIN: 'https://golf.example.com', ACCESS_AUD: 'aud' };
  const ctx = { access: { aud: 'aud', async getIdentity() { return { email: 'reader@example.com' }; } } };
  const response = await gateway.fetch(new Request(`${env.PREVIEW_ORIGIN}/${id}/__golf/enter`), env, ctx);
  assert.equal(response.status, 303); assert.equal(response.headers.get('Location'), `${env.PUBLIC_ORIGIN}/?preview=${id}`);
  assert.equal(response.headers.has('Set-Cookie'), false);
  assert.equal((await gateway.fetch(new Request(`${env.PREVIEW_ORIGIN}/${id}/__golf/enter`), env, {})).status, 404);
});

test('application preview hosts retain Access and Golf gates, isolate routing, and bound same-origin writes', async () => {
  const id = crypto.randomUUID(), origin = `https://${id}.preview.example.net`, session = 's'.repeat(43); let calls = 0;
  const env = { PREVIEW_ORIGIN: 'https://preview.example.net', PUBLIC_ORIGIN: 'https://golf.example.com', ACCESS_AUD: 'aud', APP_HOSTS: 'true',
    FORGE: { async preview(input) {
      calls++; assert.equal(input.previewId, id); assert.equal(input.app, true); assert.equal(input.email, 'reader@example.com');
      assert.equal(input.credential, session); assert.equal(input.headers.Authorization, undefined); assert.equal(input.headers.Cookie, undefined);
      return { app: true, status: 201, content: new TextEncoder().encode('private app response'), contentType: 'text/plain', commitId: 'a'.repeat(40) };
    } } };
  const ctx = { access: { aud: 'aud', async getIdentity() { return { email: 'reader@example.com' }; } } };
  const headers = { Cookie: `CF_Authorization=private-access; __Host-golf_preview_${id}=${session}`, Origin: origin, 'Content-Type': 'text/plain', 'Cf-Access-Jwt-Assertion': 'private-access' };
  const request = body => new Request(origin + '/api?mode=demo', { method: 'POST', headers, body });
  const response = await gateway.fetch(request('note'), env, ctx);
  assert.equal(response.status, 201); assert.equal(await response.text(), 'private app response');
  assert.ok(response.headers.get('Content-Security-Policy').includes("connect-src 'self'")); assert.equal(response.headers.has('Set-Cookie'), false);
  for (const [r, bindings, context] of [
    [request('x'.repeat(65537)), env, ctx], [request('note'), env, {}], [request('note'), { ...env, APP_HOSTS: 'false' }, ctx],
    [new Request(origin + '/api', { method: 'POST', headers: { ...headers, Origin: 'https://evil.example' }, body: 'note' }), env, ctx],
    [new Request(origin + '/__golf/enter?grant=private'), env, ctx],
  ]) assert.equal((await gateway.fetch(r, bindings, context)).status, 404);
  assert.equal(calls, 1);
});

test('app host grant redirects to its own root and shares no preview identity with sibling hosts', async () => {
  const id = crypto.randomUUID(), origin = `https://${id}.preview.example.net`, grant = 'g'.repeat(43), session = 's'.repeat(43);
  const env = { PREVIEW_ORIGIN: 'https://preview.example.net', PUBLIC_ORIGIN: 'https://golf.example.com', ACCESS_AUD: 'aud', APP_HOSTS: 'true',
    FORGE: { async preview(input) { assert.equal(input.previewId, id); assert.equal(input.url, origin + '/__golf/auth'); return { session, maxAge: 300 }; } } };
  const ctx = { access: { aud: 'aud', async getIdentity() { return { email: 'reader@example.com' }; } } };
  const response = await gateway.fetch(new Request(origin + '/__golf/auth', { method: 'POST', headers: { Origin: env.PUBLIC_ORIGIN, 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant }) }), env, ctx);
  assert.equal(response.status, 303); assert.equal(response.headers.get('Location'), '/');
  assert.equal(response.headers.get('Set-Cookie'), `__Host-golf_preview_${id}=${session}; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=300`);
  const sibling = crypto.randomUUID();
  assert.equal((await gateway.fetch(new Request(`https://${sibling}.preview.example.net/`, { headers: { Cookie: response.headers.get('Set-Cookie') } }), env, ctx)).status, 404);
});
