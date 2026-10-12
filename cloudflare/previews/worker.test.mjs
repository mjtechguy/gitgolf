import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, webcrypto } from 'node:crypto';
globalThis.crypto ??= webcrypto;
const archive = createHash('sha256').update('archive').digest('hex');
import worker from './src/worker.mjs';

const origin = 'https://id.previews.example.com';
const secret = 'broker-secret';
const env = { PREVIEW_ORIGIN: origin, GOLF_ORIGIN: 'https://golf.example.com', ACCESS_AUD: 'aud', DEPLOYMENT_ID: 'id', GOLF_BROKER_SECRET: secret, ARCHIVE_SHA256: archive, TARGET_FINGERPRINT: 'fingerprint', COMMIT_ID: 'commit', D1_ID: 'd1', R2_BUCKET: 'r2', PREVIEW_DB: { prepare: () => ({ first: async () => ({ ok: 1 }) }) }, PREVIEW_R2: { get: async () => ({ size: 7, arrayBuffer: async () => new TextEncoder().encode('archive') }) } };
const ctx = { access: { aud: 'aud', getIdentity: async () => ({ email: 'golf-42@reviewer.invalid' }) } };
const credential = 'a'.repeat(43);

test('no Access context, wrong audience, alternate host and credentials fail before broker', async () => {
  const previous = globalThis.fetch; let calls = 0; globalThis.fetch = async () => { calls++; throw new Error('Unexpected broker'); };
  try {
    for (const [url, context, headers] of [[origin, {}, {}], [origin, { access: { ...ctx.access, aud: 'wrong' } }, {}], ['https://alternate.workers.dev', ctx, {}], [origin + '/?grant=secret', ctx, {}], [origin, ctx, { Cookie: '__Host-golf_session=secret' }], [origin + '/__golf/enter', ctx, { Cookie: 'golf_session=secret' }], [origin + '/__golf/auth', ctx, { Cookie: '__Host-golf_session=secret' }], [origin, ctx, { Authorization: 'Bearer secret' }], [origin, ctx, { Cookie: `__Host-golf_preview=${credential}; __Host-golf_preview=${credential}` }]]) {
      assert.equal((await worker.fetch(new Request(url, { headers }), env, context)).status, 404);
    }
    assert.equal(calls, 0);
  } finally { globalThis.fetch = previous; }
});

test('Access enter is a fixed credential-free return to Golf', async () => {
 const response = await worker.fetch(new Request(origin + '/__golf/enter'), env, ctx);
 assert.equal(response.status, 303); assert.equal(response.headers.get('Location'), env.GOLF_ORIGIN + '/api/deployments/id/resume');
});

test('bound human broker request strips Access and control credentials', async () => {
 const previous = globalThis.fetch; let seen;
 globalThis.fetch = async (url, options) => { seen = { url, options, input: JSON.parse(options.body) }; return new Response('immutable project', { headers: { 'Cache-Control': 'no-store' } }); };
 try {
  const response = await worker.fetch(new Request(origin + '/', { headers: { Cookie: `CF_Authorization=private; __Host-golf_preview=${credential}`, 'Cf-Access-Jwt-Assertion': 'untrusted-header' } }), env, ctx);
  assert.equal(await response.text(), 'immutable project'); assert.equal(seen.input.email, 'golf-42@reviewer.invalid'); assert.equal(seen.input.credential, credential); assert.equal(seen.input.path, '/'); assert.equal(seen.options.headers.Authorization, `Bearer ${secret}`); assert.ok(!JSON.stringify(seen).includes('untrusted-header')); assert.ok(!JSON.stringify(seen).includes('CF_Authorization'));
 } finally { globalThis.fetch = previous; }
});

test('storage result withheld when authority is revoked during binding read', async () => {
 const previous = globalThis.fetch; let calls = 0;
 globalThis.fetch = async () => new Response('', { status: ++calls === 1 ? 200 : 404 });
 try { const response = await worker.fetch(new Request(origin + '/api/storage', { headers: { Cookie: `__Host-golf_preview=${credential}` } }), env, ctx); assert.equal(response.status, 404); assert.equal(calls, 2); assert.ok(!(await response.text()).includes('archive')); } finally { globalThis.fetch = previous; }
});

test('machine health needs Access plus a distinct broker secret and exact R2 marker', async () => {
 assert.equal((await worker.fetch(new Request(origin + '/__golf/health'), env, ctx)).status,404);
 const request = new Request(origin + '/__golf/health', {headers: {Authorization: `Bearer ${secret}`}});
 assert.equal((await worker.fetch(request,env,{})).status,404);
 const response=await worker.fetch(request,env,ctx);assert.equal(response.status,200);assert.equal((await response.json()).archive,archive);
 assert.equal((await worker.fetch(request,{...env,PREVIEW_R2:{get:async()=>null}},ctx)).status,404);
});

test('launch grant accepts only bounded exact-origin form POST', async()=>{
 const previous=globalThis.fetch;let calls=0;
 globalThis.fetch=async(_url,options)=>{calls++;const input=JSON.parse(options.body);assert.equal(input.grant,credential);assert.equal(input.credential,'');return new Response(null,{status:303,headers:{Location:'/'}})};
 try {
  const request=(body,control=env.GOLF_ORIGIN)=>new Request(origin+'/__golf/auth',{method:'POST',headers:{Origin:control,'Content-Type':'application/x-www-form-urlencoded'},body});
  for(const req of [request('grant='+credential,'https://evil.invalid'),request('grant='+credential+'&grant='+credential),request('grant='+credential+'&extra=x'),request('grant='+'x'.repeat(300))])assert.equal((await worker.fetch(req,env,ctx)).status,404);
  assert.equal(calls,0);assert.equal((await worker.fetch(request('grant='+credential),env,ctx)).status,303);assert.equal(calls,1);
 }finally{globalThis.fetch=previous}
});

 test('existing external Access email reaches only the Golf reviewer binding', async()=>{
 const previous=globalThis.fetch;let seen;
 globalThis.fetch=async(_url,options)=>{seen=JSON.parse(options.body);return new Response('',{status:404})};
 try{const response=await worker.fetch(new Request(origin+'/',{headers:{Cookie:`__Host-golf_preview=${credential}`}}),env,{access:{...ctx.access,getIdentity:async()=>({email:'existing@example.com'})}});assert.equal(seen.email,'existing@example.com');assert.equal(response.status,404)}finally{globalThis.fetch=previous}
 });
