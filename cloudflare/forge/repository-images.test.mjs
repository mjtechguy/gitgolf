import { test } from 'node:test';
import assert from 'node:assert/strict';
import { externalImageURL, imageType, repositoryImage, repositoryImagePath } from './src/repository-images.mjs';
import { concurrentRead } from './src/core.mjs';

const hash = 'a'.repeat(40), tree = 'b'.repeat(40), documentHash = 'c'.repeat(40), imageHash = 'd'.repeat(40);
const svg = '<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0"/></svg>';
const literalPath = value => { assert.ok(value && !/[\x00-\x1f\\]/.test(value) && value.split('/').every(part => part && !['.','..'].includes(part))); return value; };
const input = { repositoryId:'7', commitId:hash, documentPath:'README.md', imageUrl:'logo.svg' };
function fixture(reference = input.imageUrl) {
  return {
    readCommit: async value => value === hash ? { hash, treeHash:tree } : null,
    readTree: async value => value === tree ? [{ name:'README.md',hash:documentHash,type:'blob' },{ name:'logo.svg',hash:imageHash,type:'blob' }] : null,
    readBlob: async value => value === documentHash ? new Blob([`<img src="${reference.replaceAll('&','&amp;')}">`]) : value === imageHash ? new Blob([svg]) : null,
  };
}
test('native relative image returns exact private snapshot and protobuf bytes', async () => {
  const result = await repositoryImage(fixture(), {id:7}, input, literalPath);
  assert.equal(result.mediaType,'image/svg+xml'); assert.equal(Buffer.from(result.content,'base64').toString(),svg);
  assert.deepEqual({...result, content:undefined, mediaType:undefined},{...input, content:undefined, mediaType:undefined});
  assert.equal(concurrentRead(new Request('https://golf.example/rpc/golf.v1.RepositoryService/GetRepositoryImage',{method:'POST'})),true);
});
test('native image binds repository, source commit, ordinary file and document reference', async () => {
  for (const change of [{repositoryId:'8'},{commitId:'e'.repeat(40)},{documentPath:'missing.md'},{imageUrl:'missing.svg'}]) await assert.rejects(repositoryImage(fixture(),{id:7},{...input,...change},literalPath));
  const link = fixture(); link.readTree = async () => [{name:'README.md',hash:documentHash,type:'blob'},{name:'logo.svg',hash:imageHash,type:'symlink'}];
  await assert.rejects(repositoryImage(link,{id:7},input,literalPath));
  const oversized = fixture(); oversized.readBlob = async () => new Blob(['x'.repeat(256*1024+1)]);
  await assert.rejects(repositoryImage(oversized,{id:7},input,literalPath));
});
test('image paths normalize inside this repository and reject traversal, schemes and encoded separators', () => {
  assert.equal(repositoryImagePath('docs/README.md','../images/logo.svg?raw=1#icon',literalPath),'images/logo.svg');
  assert.equal(repositoryImagePath('docs/README.md','/logo.svg',literalPath),'logo.svg');
  for (const reference of ['../../x','../%2e%2e/x','a%2fb','a%5cb','//evil.test/x','https://evil.test/x','data:image/svg+xml,x','a\n']) assert.throws(()=>repositoryImagePath('docs/README.md',reference,literalPath));
});
test('external images admit known HTTPS hosts without credentials, explicit ports or ambiguous authorities', () => {
  for (const reference of ['https://vite.dev/vite-dark.svg','https://sponsors.vite.dev/sponsors.svg','https://github.com/vitejs/vite/actions/workflows/ci.yml/badge.svg?branch=main','https://img.shields.io/npm/v/vite.svg']) assert.equal(externalImageURL(reference).href,reference);
  for (const reference of ['https://localhost/x','https://127.0.0.1/x','https://raw.githubusercontent.com:443/x','https://user:pass@raw.githubusercontent.com/x','https://raw.githubusercontent.com.evil.test/x','http://raw.githubusercontent.com/x','https:raw.githubusercontent.com/x','https://raw%2egithubusercontent.com/x','https://vite.dev/x#fragment']) assert.throws(()=>externalImageURL(reference));
});
test('external badge redirects recheck destinations, forward no credentials and preserve literal document receipt', async () => {
  const reference='https://github.com/old/project/actions/workflows/ci.yml/badge.svg?branch=main&event=push', calls=[];
  const fetcher=async (url,options)=>{calls.push(url);assert.equal(options.redirect,'manual');assert.equal(options.headers.Authorization,undefined);assert.equal(options.headers.Cookie,undefined);assert.deepEqual(options.cf.cacheTtlByStatus, { '200': 300, '201-599': -1 });return calls.length===1?new Response(null,{status:302,headers:{Location:'https://raw.githubusercontent.com/new/logo.svg'}}):new Response(svg);};
  const result=await repositoryImage(fixture(reference),{id:7},{...input,imageUrl:reference},literalPath,fetcher);
  assert.equal(result.imageUrl,reference);assert.equal(calls.length,2);
  for(const location of ['http://vite.dev/logo.svg','https://127.0.0.1/x','https://evil.test/x','https://u:p@vite.dev/x']) {
    let requests=0;await assert.rejects(repositoryImage(fixture(reference),{id:7},{...input,imageUrl:reference},literalPath,async()=>{requests++;return new Response(null,{status:302,headers:{Location:location}});}));assert.equal(requests,1);
  }
});
test('external reads reject unreferenced requests, HTML, over-limit bodies and redirect loops', async () => {
  const reference='https://img.shields.io/npm/v/vite.svg'; let calls=0;
  await assert.rejects(repositoryImage(fixture(),{id:7},{...input,imageUrl:reference},literalPath,async()=>{calls++;return new Response(svg);}));assert.equal(calls,0);
  for(const body of ['<html>Not an image</html>','x'.repeat(256*1024+1)]) await assert.rejects(repositoryImage(fixture(reference),{id:7},{...input,imageUrl:reference},literalPath,async()=>new Response(body)));
  calls=0;await assert.rejects(repositoryImage(fixture(reference),{id:7},{...input,imageUrl:reference},literalPath,async()=>{calls++;return new Response(null,{status:302,headers:{Location:reference}});}));assert.equal(calls,4);
});
test('image signatures and dimensions reject malformed, oversized and entity-bearing payloads', () => {
  const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aRfoAAAAASUVORK5CYII=','base64');assert.equal(imageType(png),'image/png');
  const huge=Buffer.from(png);huge.writeUInt32BE(20000,16);assert.throws(()=>imageType(huge));
  assert.equal(imageType(Buffer.from('GIF89a\x01\x00\x01\x00\0\0\0','binary')),'image/gif');
  assert.equal(imageType(Buffer.from(svg)),'image/svg+xml');
  assert.equal(imageType(Buffer.from('<?xml version="1.0"?>\n<!-- logo -->'+svg)),'image/svg+xml');
  for(const content of ['', '<svg/>','<!DOCTYPE svg [<!ENTITY x "test">]>'+svg,'<html><svg/></html>','\xff\xd8\xff\xff\xff']) assert.throws(()=>imageType(Buffer.from(content,'binary')));
});
