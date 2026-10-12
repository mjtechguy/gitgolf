import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { renewPreview, previewPolicy } from './src/delivery.mjs';

function fixture(t) {
  const sql=new DatabaseSync(':memory:');t.after(()=>sql.close());
  sql.exec("CREATE TABLE users(id INTEGER PRIMARY KEY,active INTEGER); CREATE TABLE grants(user_id INTEGER,repository_id INTEGER,role TEXT); CREATE TABLE previews(id TEXT,repository_id INTEGER,expires_at TEXT,state TEXT,purged INTEGER); INSERT INTO users VALUES(1,1); INSERT INTO grants VALUES(1,1,'write')");
  const preview={id:'12345678-1234-4234-8234-123456789012',repository_id:1,kind:'STATIC',state:'READY',purged:0,expires_at:new Date(Date.now()+60000).toISOString()};
  sql.prepare('INSERT INTO previews VALUES(?,?,?,?,0)').run(preview.id,1,preview.expires_at,'READY');
  const db={prepare(query){let args=[];return{bind(...values){args=values;return this},async run(){return{meta:{changes:sql.prepare(query).run(...args).changes}}}}}};
  const env={PREVIEW_TTL:'14400',PREVIEW_ORIGIN:'https://preview.example.invalid',PUBLIC_ORIGIN:'https://golf.example.invalid',PREVIEW_PATH:'public',PREVIEW_ACCESS_AUD:'approved',EVIDENCE_BUCKET:new Proxy({},{get(){assert.fail('Renewal must not read, delete or reallocate outputs')}})};
  return{sql,db,env,preview,person:{id:1},row:{id:1,role:'write'}};
}

test('renewal extends only the original current preview with no provider effects; replay is fenced',async t=>{
  const f=fixture(t),checked=[];
  const result=await renewPreview(f.db,f.env,f.person,f.row,f.preview,{expectedExpiresAt:f.preview.expires_at},async preview=>checked.push(preview.expires_at));
  assert.equal(result.id,f.preview.id);assert.equal(checked.length,2);assert.equal(checked[1],result.expiresAt);
  assert.ok(Date.parse(result.expiresAt)-Date.now()>14390000);
  const saved=f.sql.prepare('SELECT * FROM previews').get();assert.equal(saved.expires_at,result.expiresAt);assert.equal(saved.state,'READY');assert.equal(saved.purged,0);
  await assert.rejects(renewPreview(f.db,f.env,f.person,f.row,f.preview,{expectedExpiresAt:f.preview.expires_at},async()=>{}),error=>error.status===412);
  assert.equal(f.sql.prepare('SELECT expires_at FROM previews').get().expires_at,result.expiresAt);
});

test('renewal refuses readers, changed source, expired policy and writer revocation during authorization',async t=>{
  const f=fixture(t),body={expectedExpiresAt:f.preview.expires_at};
  await assert.rejects(renewPreview(f.db,f.env,f.person,{...f.row,role:'read'},f.preview,body,async()=>assert.fail('Reader must not reach source')));
  await assert.rejects(renewPreview(f.db,f.env,f.person,f.row,f.preview,body,async()=>{throw Error('Current source changed')}),/Current source changed/);
  await assert.rejects(renewPreview(f.db,{...f.env,DEMO_STOP_AT:'2000-01-01T00:00:00Z'},f.person,f.row,f.preview,body,async()=>{}));
  await assert.rejects(renewPreview(f.db,f.env,f.person,f.row,f.preview,body,async()=>{f.sql.exec('UPDATE users SET active=0')}),error=>error.status===412);
  assert.equal(f.sql.prepare('SELECT expires_at FROM previews').get().expires_at,f.preview.expires_at);
});

test('renewal respects the approved demo deadline and rechecks current authority after its write',async t=>{
  const f=fixture(t),deadline=new Date(Date.now()+120000).toISOString();let checks=0;
  await assert.rejects(renewPreview(f.db,{...f.env,DEMO_STOP_AT:deadline},f.person,f.row,f.preview,{expectedExpiresAt:f.preview.expires_at},async()=>{if(++checks===2)throw Error('Revoked during write')}),/Revoked during write/);
  assert.equal(f.sql.prepare('SELECT expires_at FROM previews').get().expires_at,deadline);
});

test('four-hour static retention requires explicit valid operator configuration',t=>{
  const f=fixture(t);assert.equal(previewPolicy(f.env),true);
  for(const ttl of ['14401','0','1.5','unknown'])assert.equal(previewPolicy({...f.env,PREVIEW_TTL:ttl}),false);
});
