import { test } from 'node:test';
import assert from 'node:assert/strict';
import { benchmarkRepositoryReads } from './browser-benchmark.mjs';
const repositories = [{ owner: 'alice', name: 'one', id: '1', ref: 'a'.repeat(40) }, { owner: 'alice', name: 'two', id: '2', ref: 'b'.repeat(40) }];

test('benchmark bounds concurrency, reports failed bindings and measures actual payload bytes', async t => {
  const original = globalThis.fetch; t.after(() => { globalThis.fetch = original; });
  let active = 0, maximum = 0, calls = 0;
  globalThis.fetch = async (url, request) => {
    calls++; active++; maximum = Math.max(maximum, active);
    assert.equal(request.redirect, 'error'); assert.equal(request.credentials, 'same-origin'); assert.equal(request.headers.Authorization, undefined);
    const body = JSON.parse(request.body);
    await Promise.resolve(); active--;
    const failed = calls === 4;
    const response = { repositoryId: body.repositoryId, commitId: body.ref, indexedCommitId: body.ref, path: '', languagesState: 'REPOSITORY_OVERVIEW_SECTION_STATE_AVAILABLE', licensesState: 'REPOSITORY_OVERVIEW_SECTION_STATE_AVAILABLE' };
    if (failed) response.repositoryId = 'different';
    return Response.json(response, { headers: { 'CF-Ray': 'id-IAD' } });
  };
  const result = await benchmarkRepositoryReads(repositories, { iterations: 3, concurrency: 2 });
  assert.equal(calls, 12); assert.equal(maximum, 2); assert.equal(result.cold.samples, 4); assert.equal(result.warm.samples, 8);
  assert.ok(result.cold.failures > 0); assert.ok(result.warm.bytes > 0); assert.ok(result.samples.every(value => value.region === 'IAD'));
  assert.match(result.scope, /not global/);
});
test('invalid source identities or oversized loads fail before any network call', async t => {
  const original = globalThis.fetch; t.after(() => { globalThis.fetch = original; });
  globalThis.fetch = async () => assert.fail('Invalid benchmark must not send traffic');
  await assert.rejects(benchmarkRepositoryReads([{ ...repositories[0], ref: 'main' }]));
  await assert.rejects(benchmarkRepositoryReads(repositories, { concurrency: 17 }));
  await assert.rejects(benchmarkRepositoryReads(repositories, { iterations: 100 }));
  await assert.rejects(benchmarkRepositoryReads([{...repositories[0],path:'../private'}]));
});

test('file reads and transport/non-JSON failures retain bounded observations without response bodies',async t=>{
 const original=globalThis.fetch;t.after(()=>{globalThis.fetch=original});let calls=0;
 globalThis.fetch=async (url,request)=>{
  assert.ok(request.signal);const body=JSON.parse(request.body);calls++;
  if(calls===1)throw Error('Private upstream details');
  if(calls===2)return new Response('Private upstream details',{status:503});
  assert.equal(body.path,'README.md');
  return Response.json({repositoryId:body.repositoryId,commitId:body.ref,path:body.path});
 };
 const result=await benchmarkRepositoryReads([{...repositories[0],path:'README.md'}],{iterations:1,concurrency:1});
 assert.equal(result.cold.samples,3);assert.equal(result.cold.failures,2);assert.equal(result.samples.at(-1).exact,true);
 assert.ok(!JSON.stringify(result).includes('Private upstream details'));
});

test('extended reads verify metadata, folder, history, diff and image identities', async t => {
  const original = globalThis.fetch; t.after(() => { globalThis.fetch = original; });
  const seen = [];
  globalThis.fetch = async (url, request) => {
    const method = url.split('/').at(-1), body = JSON.parse(request.body); seen.push(method);
    const identity = { repositoryId: body.repositoryId, commitId: body.ref };
    if (method === 'GetRepository') return Response.json({ repository: { id: body.repositoryId }, sourceSelection: { commitId: body.ref } });
    if (method === 'GetRepositoryOverview') return Response.json({ ...identity, indexedCommitId: body.ref, languagesState: 'REPOSITORY_OVERVIEW_SECTION_STATE_AVAILABLE', licensesState: 'REPOSITORY_OVERVIEW_SECTION_STATE_AVAILABLE' });
    if (method === 'ListCommits') return Response.json({ ...identity, commits: [{ sha: body.ref }] });
    if (method === 'GetCommitDiff') return Response.json({ commit: { sha: body.commitId }, rawDiff: '' });
    if (method === 'GetRepositoryImage') return Response.json({ ...identity, documentPath: body.documentPath, imageUrl: body.imageUrl, content: 'bytes' });
    return Response.json({ ...identity, path: body.path });
  };
  const selected = [{ ...repositories[0], path: 'README.md', folder: 'src', image: 'logo.svg' }];
  const result = await benchmarkRepositoryReads(selected, { extended: true, iterations: 1 });
  assert.equal(result.cold.samples, 8); assert.equal(result.cold.failures, 0);
  assert.equal(seen.filter(method => method === 'GetContents').length, 3);
  await assert.rejects(benchmarkRepositoryReads([{ ...selected[0], folder: '../private' }], { extended: true }));
  await assert.rejects(benchmarkRepositoryReads(selected, { extended: 'true' }));
});


test('sixteen concurrent source reads stay within the explicit load bound', async t => {
  const original=globalThis.fetch; t.after(()=>{globalThis.fetch=original;});
  let active=0, maximum=0;
  globalThis.fetch=async(url,request)=>{
    active++; maximum=Math.max(maximum,active);
    await new Promise(resolve=>setTimeout(resolve,1)); active--;
    const body=JSON.parse(request.body);
    return Response.json({repositoryId:body.repositoryId,commitId:body.ref,indexedCommitId:body.ref,path:'',languagesState:'REPOSITORY_OVERVIEW_SECTION_STATE_AVAILABLE',licensesState:'REPOSITORY_OVERVIEW_SECTION_STATE_AVAILABLE'});
  };
  const result=await benchmarkRepositoryReads(Array.from({length:8},(_,i)=>({...repositories[0],id:String(i+1),name:'repo'+i})),{iterations:1,concurrency:16});
  assert.equal(maximum,16); assert.equal(result.cold.samples,16); assert.equal(result.cold.failures,0);
});
