import {expect,test,type Page,type Route} from '@playwright/test';
import {create,toJson} from '@bufbuild/protobuf';
import {respond,reject} from './rpc';
import {GetSessionResponseSchema,GetRepositoryResponseSchema,ListRepositoriesResponseSchema,ListCapabilitiesResponseSchema,GetContentsResponseSchema,ListBranchesResponseSchema,ListIssuesResponseSchema,GetIssueResponseSchema,ListIssueCommentsResponseSchema,WatchRepositoryResponseSchema,IssueState,SourceEntryType} from '../src/gen/golf/v1/golf_pb';

const head='a'.repeat(40);
function envelope(flag:number,body:unknown){const text=Buffer.from(JSON.stringify(body));const size=Buffer.alloc(5);size[0]=flag;size.writeUInt32BE(text.length,1);return Buffer.concat([size,text]);}
async function fixture(page:Page){
 const state={cursor:1,title:'Original issue',topics:[] as string[],denied:false,offline:false,cursors:[] as string[],sources:0};
 await page.route('**/rpc/**',async(route:Route)=>{
  const method=new URL(route.request().url()).pathname.split('/').at(-1)!;
  if(method==='WatchRepository'){
   const raw=route.request().postDataBuffer()!;const input=JSON.parse(raw.subarray(5).toString());state.cursors.push(input.cursor||'');
   await new Promise(r=>setTimeout(r,150));
   if(state.offline)return reject(route,'unavailable','Live updates unavailable.');
   if(state.denied)return route.fulfill({status:200,contentType:'application/connect+json',body:envelope(2,{error:{code:'permission_denied',message:'Repository access removed.'}})});
   const cursor=String(state.cursor);const kind=input.cursor ? input.cursor!==cursor?'change':'heartbeat' : 'reset';
   const message=toJson(WatchRepositoryResponseSchema,create(WatchRepositoryResponseSchema,{repositoryId:'11',cursor,kind,topics:kind==='change'?state.topics:[]}));
   const reconnect={repositoryId:'11',cursor,kind:'reconnect'};
   return route.fulfill({status:200,contentType:'application/connect+json',body:Buffer.concat([envelope(0,message),envelope(0,reconnect),envelope(2,{})])});
  }
  const user={id:'42',login:'alex'};const repository={id:'11',name:'demo',fullName:'alex/demo',defaultBranch:'main',private:true};
  if(method==='GetSession')return respond(route,GetSessionResponseSchema,{user});
  if(method==='ListCapabilities')return respond(route,ListCapabilitiesResponseSchema,{});
  if(method==='ListRepositories')return respond(route,ListRepositoriesResponseSchema,{repositories:[repository]});
  if(method==='GetRepository')return respond(route,GetRepositoryResponseSchema,{repository});
  if(method==='GetContents'){state.sources++;return respond(route,GetContentsResponseSchema,{kind:SourceEntryType.DIRECTORY,commitId:head,entries:[{name:'src',path:'src',type:SourceEntryType.DIRECTORY}]});}
  if(method==='ListBranches')return respond(route,ListBranchesResponseSchema,{branches:[{name:'main',commitId:head}]});
  if(method==='GetIssue')return respond(route,GetIssueResponseSchema,{issue:{id:'3',number:1,title:state.title,state:IssueState.OPEN,user,createdAt:'2026-10-03T00:00:00Z'}});
  if(method==='ListIssueComments')return respond(route,ListIssueCommentsResponseSchema,{});
  if(method==='ListIssues')return respond(route,ListIssuesResponseSchema,{issues:[{id:'3',number:1,title:state.title,state:IssueState.OPEN,user,createdAt:'2026-10-03T00:00:00Z'}]});
  return reject(route,'not_found','Unimplemented fixture method.');
 });return state;
}

test('live invalidations resume the durable cursor and keep immutable source pinned',async({page})=>{
 const state=await fixture(page);await page.goto('/alex/demo');await expect(page.getByText('Live',{exact:true})).toBeVisible();await expect(page.locator('.source-tree')).toBeVisible();
 const url=page.url(),reads=state.sources;state.topics=['source'];state.cursor++;
 await expect(page.getByRole('status').filter({hasText:'This source snapshot stays pinned'})).toBeVisible();expect(page.url()).toBe(url);expect(state.sources).toBe(reads);expect(state.cursors).toContain('1');
 await expect(page.getByRole('button',{name:'Refresh source'})).toBeHidden();
});
test('issue rows update without refresh and a live permission denial removes private content',async({page})=>{
 const state=await fixture(page);await page.goto('/alex/demo/issues');await expect(page.locator('.issue-list')).toContainText('Original issue');await expect(page.getByText('Live',{exact:true})).toBeVisible();
 state.title='Changed externally';state.topics=['issues'];state.cursor++;
 await expect(page.locator('.issue-list')).toContainText('Changed externally');state.denied=true;
 await expect(page.getByRole('alert')).toContainText('Repository access removed');await expect(page.locator('.issue-list')).toHaveCount(0);
});
test('disconnection exposes reconnect and manual controls',async({page})=>{
 const state=await fixture(page);state.offline=true;await page.goto('/alex/demo/issues');
 await expect(page.getByRole('button',{name:'Reconnect live updates'})).toBeVisible();await expect(page.getByRole('button',{name:'Refresh issues'})).toBeVisible();
 state.offline=false;await page.getByRole('button',{name:'Reconnect live updates'}).click();await expect(page.getByText('Live',{exact:true})).toBeVisible();
});


test('live issue changes revalidate access without discarding an open private draft',async({page})=>{
 const state=await fixture(page);await page.goto('/alex/demo/issues/1');await expect(page.getByText('Live',{exact:true})).toBeVisible();
 await page.getByRole('button',{name:'Add a comment',exact:true}).click();await page.getByLabel('Comment, plain text',{exact:true}).fill('Unsent private draft');
 state.title='Updated issue title';state.topics=['issues'];state.cursor++;
 await expect(page.getByRole('heading',{name:'Updated issue title #1'})).toBeVisible();await expect(page.getByLabel('Comment, plain text',{exact:true})).toHaveValue('Unsent private draft');
 state.denied=true;await expect(page.getByRole('alert')).toBeVisible();await expect(page.getByLabel('Comment, plain text',{exact:true})).toHaveCount(0);
});
