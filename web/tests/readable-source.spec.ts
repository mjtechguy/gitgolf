import { portableRuntimeFixture } from './runtime-fixture';
import { test, expect, type Page } from '@playwright/test';
import { create, toJson } from '@bufbuild/protobuf';
import { GetSessionResponseSchema, GetAuthenticationOptionsResponseSchema, LogoutResponseSchema, ListRepositoriesResponseSchema,
 GetRepositoryResponseSchema, ListCapabilitiesResponseSchema, ListBranchesResponseSchema, ListTagsResponseSchema,
 ResolveRepositorySourceRequestSchema, ResolveRepositorySourceResponseSchema, RepositorySourceResolution as Resolution,
 RepositorySourceRefKind as Kind, GetContentsRequestSchema, GetContentsResponseSchema, GetRepositoryImageRequestSchema,
 GetRepositoryImageResponseSchema, ListCommitsRequestSchema, ListCommitsResponseSchema, SourceEntryType, WatchRepositoryResponseSchema } from '../src/gen/golf/v1/golf_pb';
import { request, respond, reject } from './rpc';
const repositoryId='11', original='a'.repeat(40), next='b'.repeat(40), old='c'.repeat(40), blob='d'.repeat(40);
const repository={id:repositoryId,name:'readable',fullName:'alex/readable',description:'Private readable repository',private:true,defaultBranch:'main',cloneUrl:'https://forge.example/alex/readable.git'};
async function fixture(page:Page){
 const state={signedIn:true,defaultBranch:'main',head:original,live:false,denied:false,resolverError:'',bad:'',contentHeld:undefined as Promise<void>|undefined,held:undefined as Promise<void>|undefined,
  resolvers:[] as ReturnType<typeof request<typeof ResolveRepositorySourceRequestSchema>>[],reads:[] as ReturnType<typeof request<typeof GetContentsRequestSchema>>[],images:[] as ReturnType<typeof request<typeof GetRepositoryImageRequestSchema>>[]};
 await page.route('**/rpc/**',async route=>{
  const method=route.request().url().split('/').at(-1);
  if(method==='GetSession')return state.signedIn?respond(route,GetSessionResponseSchema,{user:{id:'17',login:'alex'}}):reject(route,'unauthenticated','Session expired.');
  if(method==='GetAuthenticationOptions')return respond(route,GetAuthenticationOptionsResponseSchema,{localPasswordEnabled:true});
  if(method==='Logout'){state.signedIn=false;return respond(route,LogoutResponseSchema,{});}
  if(!state.signedIn)return reject(route,'unauthenticated','Session expired.');
  if(method==='GetRepository')return state.denied?reject(route,'permission_denied','Private repository inaccessible.'):respond(route,GetRepositoryResponseSchema,{repository:{...repository,defaultBranch:state.defaultBranch}});
  if(method==='ListRepositories')return respond(route,ListRepositoriesResponseSchema,{repositories:[repository]});
  if(method==='ListCapabilities')return respond(route,ListCapabilitiesResponseSchema, portableRuntimeFixture);
  if(method==='WatchRepository'&&state.live){
   const frame=(flag:number,value:unknown)=>{const body=Buffer.from(JSON.stringify(value)),header=Buffer.alloc(5);header[0]=flag;header.writeUInt32BE(body.length,1);return Buffer.concat([header,body]);};
   await new Promise(resolve=>setTimeout(resolve,120));
   if(state.denied)return route.fulfill({status:200,contentType:'application/connect+json',body:frame(2,{error:{code:'permission_denied',message:'Live access removed.'}})});
   const input=JSON.parse(route.request().postDataBuffer()!.subarray(5).toString()),cursor=state.head===original?'1':'2';
   const value=toJson(WatchRepositoryResponseSchema,create(WatchRepositoryResponseSchema,{repositoryId,cursor,kind:!input.cursor?'reset':input.cursor!==cursor?'change':'heartbeat',topics:input.cursor&&input.cursor!==cursor?['source']:[]}));
   return route.fulfill({status:200,contentType:'application/connect+json',body:Buffer.concat([frame(0,value),frame(0,{repositoryId,cursor,kind:'reconnect'}),frame(2,{})])});
  }
  const branches:Record<string,string>={main:state.head,other:old,'review/topic':state.head,boundary:state.head,'topic/über%25':state.head,[original]:next};
  const tags:Record<string,string>={'review/topic':old,'boundary/nested':old,release:old,[original]:old};
  if(method==='ListBranches')return respond(route,ListBranchesResponseSchema,{repositoryId,branches:Object.entries(branches).map(([name,commitId])=>({name,commitId}))});
  if(method==='ListTags')return respond(route,ListTagsResponseSchema,{repositoryId,tags:Object.entries(tags).map(([name,commitId])=>({name,commitId}))});
  if(method==='ResolveRepositorySource'){
   const input=request(route,ResolveRepositorySourceRequestSchema);state.resolvers.push(input);expect(input.repositoryId).toBe(repositoryId);expect(input.repository).toMatchObject({owner:'alex',name:'readable'});
   if(state.held)await state.held;
   if(state.resolverError)return reject(route,state.resolverError as 'permission_denied','Ref resolution unavailable.');
   const selection=(kind:Kind,name:string,commitId:string)=>({kind,name,commitId,tagObjectId:kind===Kind.TAG?blob:undefined});
   let candidates=input.suffix?[Kind.BRANCH,Kind.TAG].flatMap(kind=>Object.entries(kind===Kind.BRANCH?branches:tags).filter(([name])=>input.suffix===name||input.suffix.startsWith(`${name}/`)).map(([name,commitId])=>({selection:selection(kind,name,commitId),path:input.suffix===name?'':input.suffix.slice(name.length+1)}))):[];
   const kind=input.selector?.kind,name=kind===Kind.DEFAULT_BRANCH?state.defaultBranch:input.selector?.name||'';
   const commit=kind===Kind.TAG?tags[name]:kind===Kind.COMMIT?name:branches[name];
   if(!input.suffix&&!commit||input.suffix&&!candidates.length)return reject(route,'not_found','Ref not found.');
   const chosen=input.suffix?candidates.length===1?candidates[0]!.selection:undefined:selection(kind!,name,commit!);
   const data={repositoryId,repository:{owner:'alex',name:'readable'},suffix:input.suffix,path:input.suffix?candidates.length===1?candidates[0]!.path:'':input.path,selection:chosen,candidates,resolution:input.suffix&&candidates.length>1?Resolution.AMBIGUOUS:Resolution.RESOLVED};
   if(state.bad==='id')data.repositoryId='12';if(state.bad==='suffix')data.suffix='other';if(state.bad==='duplicate')data.candidates=[...candidates,...candidates];if(state.bad==='mirror')data.path='different';if(state.bad==='namespace'&&data.selection)data.selection.kind=Kind.COMMIT;if(state.bad==='missingtag'&&data.selection)data.selection.tagObjectId=undefined;
   return respond(route,ResolveRepositorySourceResponseSchema,data);
  }
  if(method==='GetContents'){
   const input=request(route,GetContentsRequestSchema);state.reads.push(input);if(state.contentHeld)await state.contentHeld;expect(input.repositoryId).toBe(repositoryId);expect([original,next,old]).toContain(input.ref);
   if(state.denied)return reject(route,'permission_denied','Private source inaccessible.');
   const path=input.path,entry=(name:string,type=SourceEntryType.FILE)=>({name:path?name.split('/').at(-1):name,path:path?`${path}/${name}`:name,sha:blob,type,size:20n});
   if(!path||path==='docs')return respond(route,GetContentsResponseSchema,{repositoryId,commitId:input.ref,path,kind:SourceEntryType.DIRECTORY,entries:!path?[entry('docs',SourceEntryType.DIRECTORY),entry('README.md')]:[entry('README.md'),entry('file.ts')]});
   const text=path.endsWith('.md')?`# PRIVATE ${input.ref}\n[Code](docs/file.ts)\n![Badge](./badge.svg)`: `const PRIVATE_SNAPSHOT = '${input.ref}';\n`;
   return respond(route,GetContentsResponseSchema,{repositoryId,commitId:input.ref,path,kind:SourceEntryType.FILE,file:{entry:{name:path.split('/').at(-1),path,sha:blob,type:SourceEntryType.FILE,size:BigInt(text.length)},content:text}});
  }
  if(method==='GetRepositoryImage'){const input=request(route,GetRepositoryImageRequestSchema);state.images.push(input);return respond(route,GetRepositoryImageResponseSchema,{repositoryId,commitId:input.commitId,documentPath:input.documentPath,imageUrl:input.imageUrl,mediaType:'image/svg+xml',content:new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 8 8"><path d="M0 0h8v8H0z"/></svg>')});}
  if(method==='ListCommits'){const input=request(route,ListCommitsRequestSchema);return respond(route,ListCommitsResponseSchema,{repositoryId,commitId:input.ref,path:input.path,commits:[{sha:input.ref,message:`Snapshot ${input.ref}`,authorName:'Alex',authoredAt:'2026-10-03T12:00:00Z'}]});}
  return reject(route,'unimplemented','Procedure unavailable.');
 });return state;
}
const preview=(page:Page)=>page.getByLabel('Plain text preview of file.ts');
const typed=(kind:string,name:string,path='docs/file.ts')=>`/alex/readable/blob/${name.split('/').map(encodeURIComponent).join('/')}/${path}?${new URLSearchParams({refKind:kind,refName:name})}`;

test('unique readable source stays named; dependent navigation pins the original snapshot',async({page})=>{
 const state=await fixture(page);await page.goto('/alex/readable/tree/main');await expect(page.locator('.source-tree')).toBeVisible();expect(new URL(page.url()).pathname).toBe('/alex/readable/tree/main');
 await expect(page.getByLabel('Rendered README.md').getByRole('link',{name:'Code'})).toHaveAttribute('href',/tree\/main\/docs\/file.ts\?refKind=branch&refName=main/);
 state.head=next;const count=state.resolvers.length;
 await page.locator('.source-tree a[title="docs"]').click();await expect(page.locator('.source-tree')).toBeVisible();await page.locator('.source-tree a[title="docs/file.ts"]').click();await expect(preview(page)).toContainText(original);
 expect(state.resolvers.length).toBe(count);expect(new URL(page.url()).pathname).toBe('/alex/readable/blob/main/docs/file.ts');expect(state.reads.every(input=>input.ref===original)).toBe(true);
 await expect(page.getByRole('link',{name:'History',exact:true})).toHaveAttribute('href',new RegExp(`/commits/${original}/docs/file.ts`));
 await page.getByRole('navigation',{name:'Repository',exact:true}).getByRole('link',{name:'Commits',exact:true}).click();await expect(page.getByRole('link',{name:`Snapshot ${original}`,exact:true})).toBeVisible();
});

test('README source links use readable SPA navigation and preserve the accepted snapshot after ref movement',async({page})=>{
 const state=await fixture(page);await page.goto('/alex/readable');await expect(page.getByLabel('Rendered README.md')).toContainText(original);state.head=next;const reads=state.resolvers.length;
 await page.getByLabel('Rendered README.md').getByRole('link',{name:'Code',exact:true}).click();await expect(preview(page)).toContainText(original);expect(state.resolvers.length).toBe(reads);expect(new URL(page.url()).pathname).toBe('/alex/readable/blob/main/docs/file.ts');
});

test('root/default stays root and Latest re-resolves the accepted branch rather than a changed default',async({page})=>{
 const state=await fixture(page);await page.goto('/alex/readable');await expect(page.getByLabel('Rendered README.md')).toContainText(original);expect(new URL(page.url()).pathname).toBe('/alex/readable');
 state.defaultBranch='other';state.head=next;await page.getByRole('button',{name:'Refresh repository access',exact:true}).click();await expect(page.getByLabel('Rendered README.md')).toContainText(original);
 await page.getByRole('button',{name:'Latest branch head',exact:true}).click();await expect(page.getByLabel('Rendered README.md')).toContainText(next);
 expect(state.resolvers.at(-1)?.selector).toMatchObject({kind:Kind.BRANCH,name:'main'});expect(new URL(page.url()).pathname).toBe('/alex/readable');
});

test('Latest on an untyped nested address retains its path and atomically swaps all displayed source consumers',async({page})=>{
 const state=await fixture(page);await page.goto('/alex/readable/blob/main/docs/README.md');await expect(page.getByLabel('Rendered docs/README.md')).toContainText(original);
 let release!:()=>void;state.held=new Promise(resolve=>release=resolve);state.head=next;
 await page.getByRole('button',{name:'Latest branch head',exact:true}).click();await expect(page.getByLabel('Rendered docs/README.md')).toHaveCount(0);
 release();await expect(page.getByLabel('Rendered docs/README.md')).toContainText(next);expect(new URL(page.url()).pathname).toBe('/alex/readable/blob/main/docs/README.md');
 expect(state.images.at(-1)).toMatchObject({commitId:next,documentPath:'docs/README.md',imageUrl:'./badge.svg'});
});

for(const name of ['review/topic','boundary/nested'])test(`ambiguous ${name} offers exact candidates without probing their paths`,async({page})=>{
 const state=await fixture(page);await page.goto(`/alex/readable/blob/${name}/docs/file.ts`);
 await expect(page.getByRole('list',{name:'Source address candidates'})).toBeVisible();expect(state.reads).toHaveLength(0);expect(state.images).toHaveLength(0);
 const choice=page.getByRole('link',{name:`Use tag ${name}`,exact:false});await choice.focus();await page.keyboard.press('Enter');await expect(preview(page)).toContainText(old);
 expect(new URL(page.url()).searchParams.get('refKind')).toBe('tag');expect(new URL(page.url()).searchParams.get('refName')).toBe(name);
});

test('same-SHA branch and tag remain ambiguous',async({page})=>{
 const state=await fixture(page);state.head=old;await page.goto('/alex/readable/tree/review/topic');await expect(page.getByRole('list',{name:'Source address candidates'}).getByRole('link')).toHaveCount(2);expect(state.reads).toHaveLength(0);
});

for(const kind of ['branch','tag'])test(`SHA-looking ${kind} is named only with explicit selectors`,async({page})=>{
 const state=await fixture(page);await page.goto(typed(kind,original));await expect(preview(page)).toContainText(kind==='branch'?next:old);
 expect(new URL(page.url()).searchParams.get('refName')).toBe(original);expect(state.resolvers[0]?.selector?.kind).toBe(kind==='tag'?Kind.TAG:Kind.BRANCH);
});

test('full SHA permalink cannot be shadowed by branch/tag query labels',async({page})=>{
 const state=await fixture(page);await page.goto(`/alex/readable/blob/${original}/docs/file.ts?branch=${original}`);await expect(preview(page)).toContainText(original);expect(state.resolvers).toHaveLength(0);
});

test('literal percent-looking slash ref is decoded once and never inferred from a prefix neighbor',async({page})=>{
 const state=await fixture(page);await page.goto(typed('branch','topic/über%25'));await expect(preview(page)).toContainText(original);
 expect(state.resolvers[0]?.selector?.name).toBe('topic/über%25');expect(new URL(page.url()).searchParams.get('refName')).toBe('topic/über%25');
});

for(const bad of ['id','suffix','duplicate','mirror','namespace'])test(`bad ${bad} suffix receipt cannot authorize any source`,async({page})=>{
 const state=await fixture(page);state.bad=bad;await page.goto('/alex/readable/blob/main/docs/file.ts');await expect(page.getByRole('alert')).toContainText('resolved source');expect(state.reads).toHaveLength(0);
});

test('missing tag object identity refuses typed tag output',async({page})=>{
 const state=await fixture(page);state.bad='missingtag';await page.goto(typed('tag','release'));await expect(page.getByRole('alert')).toContainText('resolved source');expect(state.reads).toHaveLength(0);
});

for(const query of ['refKind=branch&refKind=tag&refName=main','refKind=branch&refName=main&refName=other','refKind=branch&refName=%FF','refKind=branch&refName=%ZZ','refKind=branch&refName=other','refKind=branch&refName=main&tag=main'])test(`invalid explicit address ${query} performs no source resolution`,async({page})=>{
 const state=await fixture(page);await page.goto(`/alex/readable/blob/main/docs/file.ts?${query}`);await expect(page.getByRole('heading',{name:'Page not found'})).toBeVisible();expect(state.resolvers).toHaveLength(0);expect(state.reads).toHaveLength(0);
});

test('manual typed selection is explicit and avoids inventory guesses after bounded resolution failure',async({page})=>{
 const state=await fixture(page);state.resolverError='resource_exhausted';await page.goto('/alex/readable/tree/main');await expect(page.getByRole('alert')).toBeVisible();await expect(page.getByRole('form',{name:'Explicit source selection'})).toHaveCount(0);
 await page.getByRole('button',{name:'Choose ref and path'}).click();await page.getByLabel('Ref name', {exact:true}).fill('review/topic');await page.getByLabel('Ref type',{exact:true}).selectOption('tag');await page.getByLabel('Repository path',{exact:true}).fill('docs/file.ts');state.resolverError='';await page.getByRole('button',{name:'Open source'}).click();await expect(preview(page)).toContainText(old);
});

test('focus, reconnect and live source activity leave named source pinned until Latest',async({page})=>{
 const state=await fixture(page);state.live=true;await page.goto(typed('branch','main'));await expect(preview(page)).toContainText(original);await expect(page.locator('.repository-browser')).toHaveClass(/live-connected/);const reads=state.resolvers.length;
 state.head=next;await page.evaluate(()=>{window.dispatchEvent(new Event('focus'));window.dispatchEvent(new Event('online'));});await expect(page.getByRole('status').filter({hasText:'This source snapshot stays pinned'})).toBeVisible();await expect(preview(page)).toContainText(original);expect(state.resolvers.length).toBe(reads);
 await page.getByRole('button',{name:'Latest branch head',exact:true}).click();await expect(preview(page)).toContainText(next);
});

test('held resolution cannot populate private content after switching away',async({page})=>{
 const state=await fixture(page);let release!:()=>void;state.held=new Promise(resolve=>release=resolve);await page.goto('/alex/readable/tree/main');await expect.poll(()=>state.resolvers.length).toBe(1);await page.getByRole('navigation',{name:'Repository',exact:true}).getByRole('link',{name:'Issues',exact:true}).click();release();await expect(preview(page)).toHaveCount(0);expect(state.reads).toHaveLength(0);
});

test('private live denial clears a pinned readable workspace and fences a held Latest result',async({page})=>{
 const state=await fixture(page);state.live=true;await page.goto(typed('branch','main'));await expect(preview(page)).toContainText(original);await expect(page.locator('.repository-browser')).toHaveClass(/live-connected/);
 let release!:()=>void;state.held=new Promise(resolve=>release=resolve);await page.getByRole('button',{name:'Latest branch head',exact:true}).click();state.denied=true;await expect(page.getByRole('alert')).toContainText('Live access removed.');release();await expect(preview(page)).toHaveCount(0);await expect(page.getByRole('list',{name:'Source address candidates'})).toHaveCount(0);
});

for(const theme of ['dark','light'])for(const width of [390,1280])test(`readable selector and permalink work with fragments/back/reload at ${width}px ${theme}`,async({page,context})=>{
 await context.grantPermissions(['clipboard-read','clipboard-write']);const state=await fixture(page);await page.setViewportSize({width,height:1000});await page.goto(`${typed('branch','main')}#L1`);await page.evaluate(value=>document.documentElement.dataset.theme=value,theme);await expect(preview(page)).toContainText(original);
 await page.getByLabel('Source actions',{exact:true}).click();await page.getByRole('button',{name:'Copy source permalink',exact:true}).click();expect(await page.evaluate(()=>navigator.clipboard.readText())).toBe(`${new URL(page.url()).origin}/alex/readable/blob/${original}/docs/file.ts#L1`);await page.keyboard.press('Escape');await expect(page.locator('.source-action-options')).toBeHidden();
 await page.getByRole('navigation',{name:'Source path'}).getByRole('link',{name:'docs',exact:true}).click();await expect(page.locator('.source-tree')).toBeVisible();await page.goBack();await expect(preview(page)).toContainText(original);expect(new URL(page.url()).hash).toBe('#L1');
 state.head=next;await page.reload();await expect(preview(page)).toContainText(next);expect(new URL(page.url()).pathname).toBe('/alex/readable/blob/main/docs/file.ts');expect(await page.evaluate(()=>document.documentElement.scrollWidth)).toBe(width);
});


test('source refresh keeps the current immutable file painted until a denial clears it',async({page})=>{
 const state=await fixture(page);await page.goto(typed('branch','main'));await expect(preview(page)).toContainText(original);
 let release!:()=>void;state.contentHeld=new Promise(resolve=>release=resolve);
 const before=state.reads.length;await page.getByRole('button',{name:'Refresh source',exact:true}).click();
 await expect.poll(()=>state.reads.length).toBeGreaterThan(before);
 await expect(preview(page)).toContainText(original);await expect(page.getByText('Reading source…',{exact:true})).toHaveCount(0);
 state.denied=true;release();await expect(preview(page)).toHaveCount(0);await expect(page.getByRole('alert')).toContainText('Private source inaccessible.');
});
