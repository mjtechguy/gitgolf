// Exercise the cache against real workerd RPC targets, including non-cached methods.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
const cli = dirname(dirname(realpathSync(process.argv[2])));
const { Miniflare, convertV4MiniflareOptions } = await import(pathToFileURL(resolve(cli, 'node_modules/miniflare/dist/src/index.js')).href);
const runtime = new Miniflare(convertV4MiniflareOptions({ modules: [
  {type:'ESModule',path:'cache.mjs',contents:await readFile(new URL('./src/repository-cache.mjs',import.meta.url),'utf8')},
  {type:'ESModule',path:'git.mjs',contents:await readFile(new URL('./src/git.mjs',import.meta.url),'utf8')},
  {type:'ESModule',path:'main.mjs',contents:`import { WorkerEntrypoint, RpcTarget } from 'cloudflare:workers';
    import { cachedRepository } from './cache.mjs';
    class Repository extends RpcTarget {
      log(){return [{hash:'a'.repeat(40)}];}
      createToken(scope){return {plaintext:scope};}
      readCommit(hash){return {hash,parents:[]};}
      readBlob(){return new Blob(['Git object']);}
    }
    export class Provider extends WorkerEntrypoint { getRepo(){return new Repository();} }
    export default {async fetch(request,env,ctx){
      const original=await ctx.exports.Provider.getRepo();
      const observed=new Proxy(original,{get(target,key){const value=target[key];return typeof value==='function'&&typeof key==='string'? (...args)=>target[key](...args):value;}});
      const repo=cachedRepository(observed,{objects:new Map(),pending:new Map(),bytes:0},'fixture');
      const log=await repo.log({ref:'main'}), token=await repo.createToken('read');
      const [first,second]=await Promise.all([repo.readCommit('a'.repeat(40)),repo.readCommit('a'.repeat(40))]);
      const blob=await repo.readBlob('b'.repeat(40)); original[Symbol.dispose]();
      return Response.json({log,token,first,second,blob:await blob.text()});
    }};`},
].reverse(), compatibilityDate:'2026-10-08' }));
try {
  const response=await runtime.dispatchFetch('https://golf.example.com');
  assert.equal(response.status,200,await response.clone().text());
  const value=await response.json();assert.equal(value.token.plaintext,'read');assert.equal(value.log[0].hash,'a'.repeat(40));assert.deepEqual(value.first,value.second);assert.equal(value.blob,'Git object');
  console.log('Actual workerd RPC delegation, immutable coalescing and Blob reads passed');
} finally {await runtime.dispose();}
