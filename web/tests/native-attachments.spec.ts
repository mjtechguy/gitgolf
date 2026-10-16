import {test,expect,type Page} from '@playwright/test';
import {readFile} from 'node:fs/promises';
import {writeHarness} from './harness-file';
import {resolve} from 'node:path';

// Discussion attachments against the Cloudflare-native Worker itself (D1 on node:sqlite, in-memory R2). Carol only reads
// the repository but opened issue 1, so she may attach to its description; the public Worker supplies her Access email.
const host=resolve(import.meta.dirname,'../.tmp/native-attachments.html');
test.beforeAll(async()=>{await writeHarness(host,`<!doctype html><html><body><main id="root" class="app-main"></main><script type="module">
import React from'react';import{createRoot}from'react-dom/client';import{QueryClient,QueryClientProvider}from'@tanstack/react-query';import{create}from'@bufbuild/protobuf';import{DiscussionTargetSchema}from'/src/gen/golf/v1/golf_pb.ts';import{DiscussionAttachments}from'/src/DiscussionAttachments.tsx';import'/src/styles.css';
const cache=new QueryClient({defaultOptions:{queries:{retry:false}}});cache.setQueryData(['session'],{id:'3'});
createRoot(document.getElementById('root')).render(React.createElement(QueryClientProvider,{client:cache},React.createElement(DiscussionAttachments,{userId:'3',target:create(DiscussionTargetSchema,{repository:{owner:'alice',name:'project'},repositoryId:'1',issueId:'1',number:1})})));
</script></body></html>`);});

type Forge={sql:{exec:(sql:string)=>void;prepare:(sql:string)=>{get:(...values:unknown[])=>Record<string,number|string>}};objects:Map<string,{bytes:Uint8Array}>;bucket:{puts:number};dispatch:(request:Request)=>Promise<Response>};
test('an issue author with read access attaches a file and downloads the verified bytes from the native Worker',async({page}:{page:Page})=>{
 const module=await import(new URL('../../cloudflare/forge/object-fixture.mjs',import.meta.url).href),cleanups:(()=>void)[]=[];
 const f:Forge=await module.objectFixture({after:(cleanup:()=>void)=>cleanups.push(cleanup)});
 try{
  const time=new Date().toISOString();
  f.sql.exec(`UPDATE users SET email='carol@example.invalid' WHERE id=3;INSERT INTO discussions(id,repository_id,number,kind,author_id,title,body,state,created_at,updated_at) VALUES(1,1,1,'issue',3,'Issue','','OPEN','${time}','${time}')`);
  await page.route('**/rpc/**',async route=>{const request=route.request(),headers=request.headers();const response=await f.dispatch(new Request(module.origin+new URL(request.url()).pathname,{method:request.method(),headers:{'Content-Type':headers['content-type']??'','Connect-Protocol-Version':headers['connect-protocol-version']??'','X-Golf-Native-Access-Email':'carol@example.invalid'},body:request.postData()}));await route.fulfill({status:response.status,headers:Object.fromEntries(response.headers),body:Buffer.from(await response.arrayBuffer())});});
  await page.goto('/.tmp/native-attachments.html');
  await expect(page.getByText('No attachments on this discussion body.')).toBeVisible();
  await page.getByRole('button',{name:'Add attachment',exact:true}).click();
  const content=Buffer.from(Array.from({length:70000},(_,index)=>(index*7)%256));
  await page.getByLabel('File',{exact:true}).setInputFiles({name:'trace ✓.bin',mimeType:'application/octet-stream',buffer:content});
  await expect(page.getByLabel('Filename',{exact:true})).toHaveValue('trace ✓.bin');
  await page.getByRole('button',{name:'Review upload',exact:true}).click();
  await page.getByRole('button',{name:'Upload attachment',exact:true}).click();
  await expect(page.getByText('Attachment upload confirmed.',{exact:true})).toBeVisible();
  await expect(page.getByRole('table',{name:'discussion attachments'})).toContainText('trace ✓.bin');
  expect(f.bucket.puts).toBe(1);
  await page.getByRole('button',{name:'Inspect original attachment upload',exact:true}).click();
  await expect(page.getByText('Attachment upload confirmed.',{exact:true})).toBeVisible();
  expect(f.bucket.puts).toBe(1);
  const [download]=await Promise.all([page.waitForEvent('download'),page.getByRole('button',{name:'Download trace ✓.bin',exact:true}).click()]);
  expect(download.suggestedFilename()).toBe('trace ✓.bin');
  expect(Buffer.compare(await readFile(await download.path()),content)).toBe(0);
 }finally{cleanups.forEach(cleanup=>cleanup());}
});
