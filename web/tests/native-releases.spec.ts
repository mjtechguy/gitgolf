import {test,expect,type Page,type Locator} from '@playwright/test';
import {readFile} from 'node:fs/promises';
import {writeHarness} from './harness-file';
import {resolve} from 'node:path';

// The release pages against the Cloudflare-native Worker itself (D1 on node:sqlite, in-memory R2), not a fixture of
// its replies: every RPC and the asset download reach the real handlers with the verified Access identity of alice.
const host=resolve(import.meta.dirname,'../.tmp/native-releases.html');
test.beforeAll(async()=>{await writeHarness(host,`<!doctype html><html><body><main id="root" class="app-main"></main><script type="module">
import React from'react';import{createRoot}from'react-dom/client';import{QueryClient,QueryClientProvider}from'@tanstack/react-query';import{createRootRoute,createRouter,RouterProvider}from'@tanstack/react-router';import{createClient}from'@connectrpc/connect';import{createConnectTransport}from'@connectrpc/connect-web';import{RepositoryService}from'/src/gen/golf/v1/golf_pb.ts';import{RepositoryReleases}from'/src/RepositoryReleases.tsx';import'/src/styles.css';
const cache=new QueryClient({defaultOptions:{queries:{retry:false}}}),client=createClient(RepositoryService,createConnectTransport({baseUrl:'/rpc',useBinaryFormat:false}));cache.setQueryData(['session'],{id:'1'});
function Host(){return React.createElement(RepositoryReleases,{client,userId:'1',repositoryId:'1',repository:{owner:'alice',name:'project'},releaseId:new URLSearchParams(location.search).get('release')||undefined,signingOut:false,revalidating:false});}
const route=createRootRoute({component:Host}),router=createRouter({routeTree:route});createRoot(document.getElementById('root')).render(React.createElement(QueryClientProvider,{client:cache},React.createElement(RouterProvider,{router})));
</script></body></html>`);});

type Forge={sql:{exec:(sql:string)=>void;prepare:(sql:string)=>{get:(...values:unknown[])=>Record<string,number|string>}};objects:Map<string,{bytes:Uint8Array}>;bucket:{puts:number};dispatch:(request:Request)=>Promise<Response>;browse:(path:string,token:string)=>Promise<Response>;value:(path:string,body:unknown)=>Promise<Record<string,unknown>>;access:()=>Promise<{revision:string}>};
async function native(page:Page){
 const module=await import(new URL('../../cloudflare/forge/object-fixture.mjs',import.meta.url).href),cleanups:(()=>void)[]=[];
 const f:Forge=await module.objectFixture({after:(cleanup:()=>void)=>cleanups.push(cleanup)});
 f.sql.exec("UPDATE users SET email='alice@example.invalid' WHERE id=1");
 const fulfill=async(route:Parameters<Parameters<Page['route']>[1]>[0],response:Response)=>route.fulfill({status:response.status,headers:Object.fromEntries(response.headers),body:Buffer.from(await response.arrayBuffer())});
 // The public Worker removes any client-supplied identity and adds the verified Access email; the bytes route takes the same path.
 await page.route('**/rpc/**',async route=>{const request=route.request(),headers=request.headers();await fulfill(route,await f.dispatch(new Request(module.origin+new URL(request.url()).pathname,{method:request.method(),headers:{'Content-Type':headers['content-type']??'','Connect-Protocol-Version':headers['connect-protocol-version']??'','X-Golf-Native-Access-Email':'alice@example.invalid'},body:request.postData()})));});
 await page.route('**/api/repositories/**',async route=>fulfill(route,await f.browse(new URL(route.request().url()).pathname,module.tokens.admin)));
 return {f,module,close:()=>cleanups.forEach(cleanup=>cleanup())};
}

test('a native administrator publishes a release for a pushed tag and inspects the original receipt',async({page})=>{
 const {f,close}=await native(page);
 try{
  await page.goto('/.tmp/native-releases.html');
  await expect(page.getByText('No releases reported.')).toBeVisible();
  await page.getByRole('button',{name:'New release',exact:true}).click();
  await expect(page.getByRole('table',{name:'Existing release tags'})).toContainText('v1.0');
  await page.getByRole('button',{name:'Select release tag v1.0',exact:true}).click();
  await expect(page.getByLabel('Release title',{exact:true})).toHaveValue('v1.0');
  await page.getByLabel('Release notes, Markdown',{exact:true}).fill('First **native** release');
  await page.getByRole('button',{name:'Review publication',exact:true}).click();
  await page.getByRole('button',{name:'Confirm publish release',exact:true}).click();
  await expect(page.getByText('Release publication confirmed.',{exact:true})).toBeVisible();
  await expect(page.getByRole('table',{name:'Repository releases'})).toContainText('v1.0');
  expect(f.sql.prepare('SELECT count(*) AS total FROM repository_releases').get().total).toBe(1);
  await page.getByRole('button',{name:'Inspect original publication',exact:true}).click();
  await expect(page.getByText('Release publication confirmed.',{exact:true})).toBeVisible();
  expect(f.sql.prepare('SELECT count(*) AS total FROM repository_release_operations').get().total).toBe(1);
 }finally{close();}
});

test('native release management uploads, downloads, renames and removes an asset and edits the release',async({page})=>{
 const {f,module,close}=await native(page);
 try{
  const published=await f.value('RepositoryReleasePublicationService/SubmitRepositoryReleasePublication',{repository:{owner:'alice',name:'project'},repositoryId:'1',ownerId:'1',accessRevision:(await f.access()).revision,operationId:crypto.randomUUID(),tagName:'v1.0',tagObjectId:module.tagObject,commitId:module.commit,title:'Native release',bodyMarkdown:'Notes'});
  const releaseId=(published.operation as {releaseId:string}).releaseId,content=Buffer.from(Array.from({length:4096},(_,index)=>index%251));
  await page.goto(`/.tmp/native-releases.html?release=${releaseId}`);
  await expect(page.getByRole('heading',{name:'Native release'})).toBeVisible();
  // The detail view reloads after a verified change and remounts the panel, which then shows the retained
  // original as unresolved until it is inspected; inspection reads the native receipt and never resends.
  const assets=page.getByRole('table',{name:'Release assets',exact:true}),confirm=async(changed:Locator)=>{
   await page.getByRole('button',{name:'Review change',exact:true}).click();
   await page.getByRole('button',{name:'Confirm change',exact:true}).click();
   await expect(changed).toBeVisible();
   const writes=f.bucket.puts;
   await page.getByRole('button',{name:'Inspect original release change',exact:true}).click();
   await expect(page.getByText('Release change confirmed.',{exact:true})).toBeVisible();
   expect(f.bucket.puts).toBe(writes);
  };
  await page.getByRole('button',{name:'Upload release asset',exact:true}).click();
  await page.locator('#release-upload').setInputFiles({name:'tool ✓.bin',mimeType:'application/octet-stream',buffer:content});
  await expect(page.getByLabel('Asset name',{exact:true})).toHaveValue('tool ✓.bin');
  await confirm(assets.getByText('tool ✓.bin',{exact:true}));
  expect(f.bucket.puts).toBe(1);
  const link=page.getByRole('link',{name:'Download asset tool ✓.bin'});
  const [download]=await Promise.all([page.waitForEvent('download'),link.click()]);
  expect(download.suggestedFilename()).toBe('tool ✓.bin');
  expect(Buffer.compare(await readFile(await download.path()),content)).toBe(0);
  await page.getByRole('button',{name:'Rename asset tool ✓.bin',exact:true}).click();
  await page.getByLabel('Asset name',{exact:true}).fill('tool.bin');
  await confirm(assets.getByText('tool.bin',{exact:true}));
  await page.getByRole('button',{name:'Edit release',exact:true}).click();
  await page.getByLabel('Title',{exact:true}).fill('Edited native release');
  await confirm(page.getByRole('heading',{name:'Edited native release',level:1}));
  await page.getByRole('button',{name:'Delete asset tool.bin',exact:true}).click();
  await page.getByRole('button',{name:'Review change',exact:true}).click();
  await page.getByRole('button',{name:'Confirm change',exact:true}).click();
  await expect(page.getByText('No assets reported.')).toBeVisible();
  expect(f.objects.size).toBe(0);
  await page.getByRole('button',{name:'Inspect original release change',exact:true}).click();
  await expect(page.getByText('Release change confirmed.',{exact:true})).toBeVisible();
  expect(f.sql.prepare("SELECT count(*) AS total FROM repository_release_operations WHERE phase='SUCCEEDED'").get().total).toBe(5);
 }finally{close();}
});
