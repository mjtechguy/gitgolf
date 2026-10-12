import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileIndex } from './src/file-index.mjs';
const hash='a'.repeat(40),child='b'.repeat(40);
const repo={readCommit:async()=>({treeHash:hash})};
const path=value=>{if(value.includes('..'))throw Error('unsafe path');return value;};
test('file finder traverses nested paths and shared subtrees without reading blobs',async()=>{
 let reads=0;
 const tree=async(_repo,id)=>{reads++;return id===hash?[{name:'one',type:'tree',hash:child},{name:'two',type:'tree',hash:child},{name:'module',type:'gitlink',hash:child}]:[{name:'雪.txt',type:'blob',hash:child},{name:'link',type:'symlink',hash:child}];};
 assert.deepEqual(await fileIndex(repo,hash,tree,path),['one/link','one/雪.txt','two/link','two/雪.txt']);
 assert.equal(reads,2);
});
test('file index never returns incomplete results on count, byte, depth or missing-object failures',async()=>{
 for(const tree of [async()=>Array.from({length:10001},(_,i)=>({name:String(i),type:'blob'})),async()=>Array.from({length:513},(_,i)=>({name:String(i),type:'tree',hash:child})),async()=>[{name:'cycle',type:'tree',hash}],async()=>Array.from({length:300},(_,i)=>({name:'x'.repeat(4096)+i,type:'blob'}))]) {
  await assert.rejects(fileIndex(repo,hash,tree,path),error=>error.code==='resource_exhausted');
 }
 await assert.rejects(fileIndex({readCommit:async()=>null},hash,async()=>[],path),error=>error.code==='not_found');
});
test('file index bounds provider concurrency and drains failed batches before returning',async()=>{
 let active=0,maximum=0,finished=0;
 const roots=Array.from({length:9},(_,i)=>({name:`dir${i}`,type:'tree',hash:String(i+1).repeat(40)}));
 const tree=async(_repo,id)=>{
  if(id===hash)return roots;
  active++;maximum=Math.max(maximum,active);
  try {await new Promise(resolve=>setTimeout(resolve,5));return [{name:'file',type:'blob',hash}];}
  finally {active--;finished++;}
 };
 assert.equal((await fileIndex(repo,hash,tree,path)).length,9);assert.equal(maximum,4);assert.equal(finished,9);
 let drained=false;
 const failing=async(_repo,id)=>{
  if(id===hash)return roots.slice(0,2);
  if(id===roots[0].hash)throw Error('Provider read failed');
  await new Promise(resolve=>setTimeout(resolve,5));drained=true;return [];
 };
 await assert.rejects(fileIndex(repo,hash,failing,path),/Provider read failed/);
 assert.equal(drained,true,'the Artifacts handle must remain alive until every pending read settles');
});
