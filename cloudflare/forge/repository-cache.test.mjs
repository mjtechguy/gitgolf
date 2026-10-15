import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cachedRepository } from './src/repository-cache.mjs';
const hash = n => n.toString(16).padStart(40,'0');
const cache = () => ({objects:new Map(),pending:new Map(),bytes:0});

test('immutable reads coalesce, return independent metadata and isolate repository namespaces', async () => {
  const state=cache();let reads=0;
  const repo={ async readCommit(id){reads++;await Promise.resolve();return {hash:id,parents:[]};}, info(){return this;} };
  const first=cachedRepository(repo,state,['account','namespace','one']);
  const [a,b]=await Promise.all([first.readCommit(hash(1)),first.readCommit(hash(1))]);
  assert.equal(reads,1);a.parents.push(hash(2));assert.deepEqual(b.parents,[]);assert.deepEqual((await first.readCommit(hash(1))).parents,[]);
  assert.equal(first.info(),repo);
  await cachedRepository(repo,state,['account','namespace','two']).readCommit(hash(1));assert.equal(reads,2);
});

test('cache bounds bytes and count, evicts least recently used data and skips oversized objects',async()=>{
  const state=cache();let reads=0;
  const small=cachedRepository({async readBlob(){reads++;return new Blob(['small']);}},state,'one');
  for(let i=1;i<=128;i++)await small.readBlob(hash(i));
  await small.readBlob(hash(1));await small.readBlob(hash(129));await small.readBlob(hash(1));assert.equal(reads,129);
  await small.readBlob(hash(2));assert.equal(reads,130);assert.equal(state.objects.size,128);
  const large=cachedRepository({async readBlob(){return new Blob([new Uint8Array(1024*1024)]);}},state,'two');
  for(let i=1;i<=6;i++)await large.readBlob(hash(i));assert.ok(state.bytes<=4*1024*1024);
  const oversized=cachedRepository({async readBlob(){return new Blob([new Uint8Array(1024*1024+1)]);}},state,'three');
  const bytes=state.bytes;await oversized.readBlob(hash(1));assert.equal(state.bytes,bytes);
});

test('missing objects and failed reads are not cached or left pending',async()=>{
 const state=cache();let reads=0;
 const repo=cachedRepository({async readTree(){reads++;if(reads===1)throw Error('failed');return null;}},state,'one');
 await assert.rejects(repo.readTree(hash(1)));assert.equal(state.pending.size,0);
 assert.equal(await repo.readTree(hash(1)),null);assert.equal(await repo.readTree(hash(1)),null);
 assert.equal(reads,3);assert.equal(state.objects.size,0);assert.equal(state.pending.size,0);
});

test('provider RPC functions delegate with their original receiver without invoking remote bind', async () => {
  const provider = { log: new Proxy(function(){assert.equal(this,provider);return [];},{get(target,key){if(key==='bind')throw Error('RPC bind is not a local Function method');return Reflect.get(target,key);}}) };
  assert.deepEqual(await cachedRepository(provider,cache(),'one').log(),[]);
});

test('only immutable commit history coalesces and pagination remains part of its key', async () => {
  const state = cache(); let calls = 0;
  const repo = cachedRepository({ async log(input) { calls++; await Promise.resolve(); return [{ hash: input.ref, message: String(calls) }]; } }, state, 'one');
  const input = { ref: hash(1), limit: 500 };
  const [a, b] = await Promise.all([repo.log(input), repo.log(input)]);
  assert.equal(calls, 1); a[0].message = 'changed'; assert.notEqual(b[0].message, 'changed');
  await repo.log({ ...input, offset: 1 }); assert.equal(calls, 2);
  await repo.log({ ref: 'main', limit: 500 }); await repo.log({ ref: 'main', limit: 500 }); assert.equal(calls, 4);
  await cachedRepository({ async log() { calls++; return []; } }, state, 'two').log(input); assert.equal(calls, 5);
});


test('immutable blob sizes survive body eviction without retaining oversized bodies or crossing repositories',async()=>{
 const state=cache();let reads=0;
 const provider={async readBlob(){reads++;return new Blob([new Uint8Array(1024*1024+1)])}};
 const repo=cachedRepository(provider,state,['account','namespace','one']);
 assert.equal(await repo.readBlobSize(hash(1)),1024*1024+1);assert.equal(state.objects.size,0);
 assert.equal(await repo.readBlobSize(hash(1)),1024*1024+1);assert.equal(reads,1);
 await repo.readBlob(hash(1));assert.equal(reads,2); // Actual content still requires its own read.
 await cachedRepository(provider,state,['account','namespace','two']).readBlobSize(hash(1));assert.equal(reads,3);
 const cheap=cachedRepository({async readBlob(){return new Blob([])}},state,'bounded');
 for(let i=1;i<=4100;i++)assert.equal(await cheap.readBlobSize(hash(i)),0);
 assert.equal(state.blobSizes.size,4096);await assert.rejects(repo.readBlobSize('main'));
});

test('a cache can set its own bounds (the stateless Worker keeps more objects per isolate)', async () => {
  const state = { ...cache(), maxEntries: 300, maxBytes: 64 * 1024 }; let reads = 0;
  const repo = cachedRepository({ async readCommit(id) { reads++; return { hash: id, parents: [] }; } }, state, 'one');
  for (let i = 1; i <= 300; i++) await repo.readCommit(hash(i));
  assert.equal(state.objects.size, 300); await repo.readCommit(hash(1)); assert.equal(reads, 300);
  await repo.readCommit(hash(301)); assert.equal(state.objects.size, 300); assert.ok(state.bytes <= 64 * 1024);
});
