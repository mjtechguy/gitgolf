import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPair, exportJWK, SignJWT, createLocalJWKSet } from '../agents/node_modules/jose/dist/webapi/index.js';
import { accessContext, accessBindings } from './src/access.mjs';
import { publicFetch } from './src/public.mjs';

const pair = await generateKeyPair('RS256');
const jwk = { ...await exportJWK(pair.publicKey), kid: 'test', alg: 'RS256', use: 'sig' };
const jwks = { keys: [jwk] }, resolve = createLocalJWKSet(jwks);
const env = { ACCESS_TEAM_DOMAIN: 'https://test.cloudflareaccess.com', ACCESS_AUD: 'expected', PUBLIC_ORIGIN: 'https://golf.example.com', WORKSPACE_SLUG: 'team' };
const claims = { iss: env.ACCESS_TEAM_DOMAIN, aud: [env.ACCESS_AUD], sub: 'person', type: 'app', email: 'owner@example.com', iat: Math.floor(Date.now()/1000), exp: Math.floor(Date.now()/1000)+300 };
const sign = (changes = {}, key = pair.privateKey) => new SignJWT({ ...claims, ...changes }).setProtectedHeader({ alg: 'RS256', kid: 'test' }).sign(key);
const request = token => new Request(env.PUBLIC_ORIGIN+'/', { headers: { 'Cf-Access-Jwt-Assertion': token, 'X-Golf-Native-Access-Email': 'forged@example.com' } });

test('runtime context and signed assertion both preserve the exact Access audience', async () => {
  const context = { aud: env.ACCESS_AUD, getIdentity: async () => ({ email: claims.email }) };
  assert.equal(await accessContext(request('forged'), env, { access: context }), context);
  const token = await sign();
  assert.equal(await accessContext(request(token), env, { access: { aud: 'other' } }, resolve), null);
  const verified = await accessContext(request(token), env, {}, resolve);
  assert.equal(verified.aud, env.ACCESS_AUD);
  assert.deepEqual(await verified.getIdentity(), { email: claims.email });
  assert.equal(await accessContext(request(token), { ...env, ACCESS_TEAM_DOMAIN: undefined }, {}, resolve), null);
});

test('fallback rejects forged, expired, future, wrong-issuer and wrong-audience assertions', async () => {
  const wrong = await generateKeyPair('RS256');
  for (const token of ['forged', await sign({}, wrong.privateKey), await sign({ exp: claims.iat-1 }), await sign({ nbf: claims.iat+600 }),
    await sign({ iss: 'https://other.cloudflareaccess.com' }), await sign({ aud: ['other'] }), await sign({ exp: undefined }), await sign({ sub: undefined })]) {
    assert.equal(await accessContext(request(token), env, {}, resolve), null);
  }
  const unsigned = btoa(JSON.stringify({alg:'none'}))+'.'+btoa(JSON.stringify(claims))+'.';
  assert.equal(await accessContext(request(unsigned), env, {}, resolve), null);
  assert.equal(await accessContext(new Request(env.PUBLIC_ORIGIN, { headers: { 'X-Golf-Native-Access-Email': claims.email, Cookie: 'CF_Authorization='+await sign() } }), env, {}, resolve), null);
});

test('machine assertions never become human identities and key failures stay unavailable', async () => {
  const machine = await accessContext(request(await sign({ type: 'service' })), env, {}, resolve);
  assert.equal((await machine.getIdentity()).email, undefined);
  await assert.rejects(accessContext(request(await sign()), env, {}, () => { throw Error('Key service unavailable'); }), /Key service unavailable/);
});

test('missing runtime context still serves assets and forwards only verified identity to session authority', async t => {
  let keysFetched = 0, sessions = 0;
  t.mock.method(globalThis, 'fetch', async url => { keysFetched++; assert.equal(String(url), env.ACCESS_TEAM_DOMAIN+'/cdn-cgi/access/certs'); return Response.json(jwks); });
  const context = { exports: { Workspace: { idFromName: id => id, get: () => ({ fetch: async r => {
    sessions++; assert.equal(r.headers.get('X-Golf-Native-Access-Email'), claims.email);
    return Response.json({ user: { id: '1' } });
  } }) } } };
  const settings = { ...env, ASSETS: { fetch: async () => new Response('<script id="golf-session" type="application/json">null</script>') },
    EVIDENCE_BUCKET: { get: async () => ({ size: 2, body: 'ok', httpMetadata: { contentType: 'text/javascript; charset=utf-8' } }) } };
  const token = await sign();
  const results = await Promise.all(['/', '/assets/script-abcd1234.js', '/rpc/golf.v1.SessionService/GetSession'].map(path => publicFetch(new Request(env.PUBLIC_ORIGIN+path, { headers: request(token).headers }), settings, context)));
  assert.deepEqual(results.map(r => r.status), [200,200,200]);
  assert.equal(keysFetched, 1); assert.equal(sessions, 2);
});

test('issuer binding only accepts an explicit Cloudflare team origin with an audience', () => {
  assert.deepEqual(accessBindings({}), {});
  assert.throws(() => accessBindings({public_repositories:true}));
  assert.throws(() => accessBindings({public_repositories:'true'}));
  assert.equal(accessBindings({public_repositories:true,access_aud:'expected',access_team_domain:env.ACCESS_TEAM_DOMAIN}).PUBLIC_REPOSITORIES.value,'true');
  assert.equal(accessBindings({ access_aud: 'expected', access_team_domain: env.ACCESS_TEAM_DOMAIN }).ACCESS_TEAM_DOMAIN.value, env.ACCESS_TEAM_DOMAIN);
  for (const value of ['http://test.cloudflareaccess.com', 'https://attacker.example', 'https://test.cloudflareaccess.com/anything', 'https://test.cloudflareaccess.com@attacker.example'])
    assert.throws(() => accessBindings({ access_aud: 'expected', access_team_domain: value }));
});

test('public-site login cookies require opt-in and the exact signed application claims', async () => {
  const cookie = token => new Request(env.PUBLIC_ORIGIN, { headers: { Cookie: 'CF_Authorization='+token } });
  const publicEnv = { ...env, PUBLIC_REPOSITORIES: 'true' };
  const token = await sign();
  assert.equal(await accessContext(cookie(token), env, {}, resolve), null);
  assert.deepEqual(await (await accessContext(cookie(token), publicEnv, {}, resolve)).getIdentity(), { email: claims.email });
  for (const value of ['forged', await sign({ aud: ['other'] }), await sign({ iss: 'https://other.cloudflareaccess.com' }), await sign({ exp: claims.iat-1 })])
    assert.equal(await accessContext(cookie(value), publicEnv, {}, resolve), null);
  assert.equal(await accessContext(new Request(env.PUBLIC_ORIGIN, { headers: { Cookie: 'CF_Authorization='+token+'; CF_Authorization='+token } }), publicEnv, {}, resolve), null);
});

test('public HTML admits anonymous sessions while login redirects stay on the configured origin', async () => {
  const publicEnv = { ...env, PUBLIC_REPOSITORIES:'true', ASSETS:{fetch:async()=>new Response('<html><script id="golf-session" type="application/json">null</script></html>',{headers:{'Content-Type':'text/html'}})} };
  const context = { exports:{Workspace:{idFromName:value=>value,get:()=>({fetch:async()=>Response.json({})})}} };
  const page = await publicFetch(new Request(env.PUBLIC_ORIGIN+'/alice'),publicEnv,context);
  assert.equal(page.status,200); assert.equal(page.headers.get('Cache-Control'),'no-store');
  assert.match(await page.text(),/data-golf-public="true"/);
  assert.equal((await publicFetch(new Request(env.PUBLIC_ORIGIN+'/auth/login'),publicEnv,context)).status,401);
  context.access={aud:env.ACCESS_AUD,getIdentity:async()=>({email:claims.email})};
  for (const target of ['https://evil.example/','//evil.example/','/\\evil.example/']) {
    const result=await publicFetch(new Request(env.PUBLIC_ORIGIN+'/auth/login?returnTo='+encodeURIComponent(target)),publicEnv,context);
    assert.equal(result.status,303); assert.equal(result.headers.get('Location'),'/');
  }
});

test('installation policy writes receive the verified sign-in time and location; forged headers never pass', async t => {
  t.mock.method(globalThis, 'fetch', async () => Response.json(jwks));
  const seen = [];
  const context = { exports: { Workspace: { idFromName: id => id, get: () => ({ fetch: async r => { seen.push(Object.fromEntries([...r.headers].filter(([name]) => name.startsWith('x-golf-native-access')))); return Response.json({}); } }) } } };
  const issued = Math.floor(Date.now() / 1000) - 120, token = await sign({ iat: issued });
  const forged = { 'Cf-Access-Jwt-Assertion': token, 'Content-Type': 'application/json', 'X-Golf-Native-Access-Issued-At': String(Math.floor(Date.now() / 1000)), 'X-Golf-Native-Access-Colo': 'XXX', 'X-Golf-Native-Access-Country': 'ZZ' };
  const post = (path, ctx, cf) => { const r = new Request(env.PUBLIC_ORIGIN + path, { method: 'POST', headers: forged, body: '{}' }); if (cf) Object.defineProperty(r, 'cf', { value: cf }); return publicFetch(r, env, { ...context, ...ctx }); };
  await post('/native/installation', {}, { colo: 'LHR', country: 'GB' });
  assert.deepEqual(seen.pop(), { 'x-golf-native-access-email': claims.email, 'x-golf-native-access-issued-at': String(issued), 'x-golf-native-access-colo': 'LHR', 'x-golf-native-access-country': 'GB' });
  // Cloudflare's runtime context has no iat, so the application token is verified for this route.
  await post('/native/installation', { access: { aud: env.ACCESS_AUD, getIdentity: async () => ({ email: claims.email }) } });
  assert.deepEqual(seen.pop(), { 'x-golf-native-access-email': claims.email, 'x-golf-native-access-issued-at': String(issued) });
  // Every route receives Cloudflare's location for audit rows; the sign-in time stays specific to policy writes.
  await post('/native/installation/read', {}, { colo: 'LHR', country: 'GB' });
  assert.deepEqual(seen.pop(), { 'x-golf-native-access-email': claims.email, 'x-golf-native-access-colo': 'LHR', 'x-golf-native-access-country': 'GB' });
  await post('/native/runner-admin', {});
  assert.deepEqual(seen.pop(), { 'x-golf-native-access-email': claims.email });
});
