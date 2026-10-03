import {expect,test,type Page,type Route} from '@playwright/test';
import {create,toJson} from '@bufbuild/protobuf';
import {respond,reject,request} from './rpc';
import {GetPullRequestResponseSchema,ListPullRequestCommitsRequestSchema,ListPullRequestCommitsResponseSchema,ListPullRequestChecksRequestSchema,ListPullRequestChecksResponseSchema,ReportedCheckState} from '../src/gen/golf/v1/golf_pb';
import {GetSessionResponseSchema,GetRepositoryResponseSchema,ListRepositoriesResponseSchema,ListCapabilitiesResponseSchema,GetContentsResponseSchema,ListBranchesResponseSchema,ListIssuesResponseSchema,GetIssueResponseSchema,ListIssueCommentsResponseSchema,WatchRepositoryResponseSchema,IssueState,SourceEntryType} from '../src/gen/golf/v1/golf_pb';

const head='a'.repeat(40);
function envelope(flag:number,body:unknown){const text=Buffer.from(JSON.stringify(body));const size=Buffer.alloc(5);size[0]=flag;size.writeUInt32BE(text.length,1);return Buffer.concat([size,text]);}
async function fixture(page:Page){
 const state={cursor:1,title:'Original issue',topics:[] as string[],denied:false,offline:false,cursors:[] as string[],sources:0,pullHead:head,pullReads:0,checkState:ReportedCheckState.PENDING,commitReads:0,checkReads:0,issuesEnabled:undefined as boolean|undefined,metadataReads:0};
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
  if(method==='GetRepository'){state.metadataReads++;return respond(route,GetRepositoryResponseSchema,{repository:{...repository,issuesEnabled:state.issuesEnabled}});}
  if(method==='GetContents'){state.sources++;return respond(route,GetContentsResponseSchema,{kind:SourceEntryType.DIRECTORY,commitId:head,entries:[{name:'src',path:'src',type:SourceEntryType.DIRECTORY}]});}
  if(method==='ListBranches')return respond(route,ListBranchesResponseSchema,{branches:[{name:'main',commitId:head}]});
  if(method==='GetPullRequest'){state.pullReads++;return respond(route,GetPullRequestResponseSchema,{pullRequest:{id:'4',number:1,title:'Live contribution',state:IssueState.OPEN,user,base:{repositoryId:'11',ref:'main',commitId:'b'.repeat(40)},head:{repositoryId:'11',ref:'feature',commitId:state.pullHead}}});}
  if(method==='ListPullRequestCommits'){state.commitReads++;const input=request(route,ListPullRequestCommitsRequestSchema);return respond(route,ListPullRequestCommitsResponseSchema,{selection:input.selection,commits:[{sha:input.selection!.headCommitId,message:'Pinned private commit',authorName:'Alex',authoredAt:'2026-10-03T00:00:00Z'}]});}
  if(method==='ListPullRequestChecks'){state.checkReads++;const input=request(route,ListPullRequestChecksRequestSchema);return respond(route,ListPullRequestChecksResponseSchema,{selection:input.selection,checks:[{id:'5',context:'ci/build',state:state.checkState,description:'Live private status',updatedAt:'2026-10-03T00:00:00Z'}]});}
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


test('PR check events update reported rows while source changes keep selected commits pinned until explicit refresh',async({page})=>{
 const state=await fixture(page);await page.goto('/alex/demo/pull/1/checks');
 await expect(page.getByText('Live',{exact:true})).toBeVisible();await expect(page.getByRole('cell',{name:'Pending',exact:true})).toBeVisible();
 const reads=state.pullReads;state.checkState=ReportedCheckState.SUCCESS;state.topics=['actions'];state.cursor++;
 await expect(page.getByRole('cell',{name:'Success',exact:true})).toBeVisible();expect(state.pullReads).toBe(reads);
 state.pullHead='c'.repeat(40);state.topics=['source'];state.cursor++;
 await expect(page.getByRole('button',{name:'Refresh comparison',exact:true})).toBeVisible();
 expect(state.pullReads).toBe(reads);await expect(page.getByRole('button',{name:'Copy checked commit SHA',exact:true})).toBeVisible();
 await page.getByRole('button',{name:'Refresh comparison',exact:true}).click();
 await expect(page.locator('.panel-actions code')).toHaveAttribute('title',state.pullHead);expect(state.pullReads).toBeGreaterThan(reads);
 state.denied=true;await expect(page.getByRole('alert')).toContainText('Repository access removed');
 await expect(page.getByRole('cell',{name:'Success',exact:true})).toHaveCount(0);
});

test('PR commit pages remain pinned across pull activity and only move after explicit comparison refresh',async({page})=>{
 const state=await fixture(page);await page.goto('/alex/demo/pull/1/commits');
 await expect(page.getByText('Live',{exact:true})).toBeVisible();await expect(page.getByRole('link',{name:'Pinned private commit',exact:true})).toHaveAttribute('href',`/alex/demo/commit/${head}`);
 const reads=state.commitReads;state.pullHead='c'.repeat(40);state.topics=['pulls'];state.cursor++;
 await expect(page.getByRole('button',{name:'Refresh comparison',exact:true})).toBeVisible();expect(state.commitReads).toBe(reads);
 await expect(page.getByRole('link',{name:'Pinned private commit',exact:true})).toHaveAttribute('href',`/alex/demo/commit/${head}`);
 await page.getByRole('button',{name:'Refresh comparison',exact:true}).click();
 await expect(page.getByRole('link',{name:'Pinned private commit',exact:true})).toHaveAttribute('href',`/alex/demo/commit/${state.pullHead}`);
 state.denied=true;await expect(page.getByRole('alert')).toContainText('Repository access removed');
 await expect(page.getByRole('link',{name:'Pinned private commit',exact:true})).toHaveCount(0);
});


test('live repository revalidation hides a disabled unit and removes its private editor', async ({ page }) => {
 const state=await fixture(page);await page.goto('/alex/demo/issues/1');
 await expect(page.getByText('Live',{exact:true})).toBeVisible();
 await page.getByRole('button',{name:'Add a comment',exact:true}).click();
 await page.getByLabel('Comment, plain text',{exact:true}).fill('Private editor before configuration change');
 const reads=state.metadataReads;state.issuesEnabled=false;state.topics=['issues'];state.cursor++;
 await expect(page.getByRole('heading',{name:'Issues are disabled',exact:true})).toBeVisible();
 await expect(page.getByLabel('Comment, plain text',{exact:true})).toHaveCount(0);
 await expect(page.getByRole('navigation',{name:'Repository',exact:true}).getByRole('link',{name:'Issues',exact:true})).toHaveCount(0);
 expect(state.metadataReads).toBeGreaterThan(reads);
 state.issuesEnabled=true;state.cursor++;
 await expect(page.getByRole('heading',{name:'Original issue #1',exact:true})).toBeVisible();
 await expect(page.getByLabel('Comment, plain text',{exact:true})).toHaveCount(0);
});


test('offline reconnect attempts keep source controls stable without repeated metadata hiding', async ({ page }) => {
 const state=await fixture(page);state.offline=true;await page.goto('/alex/demo');
 await expect(page.locator('.source-tree')).toBeVisible();
 await expect(page.getByRole('button',{name:'Reconnect live updates',exact:true})).toBeVisible();
 const reads=state.metadataReads;
 await page.getByLabel('Source actions',{exact:true}).click();
 await expect(page.locator('.source-action-options')).toBeVisible();
 await expect.poll(()=>state.cursors.length).toBeGreaterThanOrEqual(3);
 expect(state.metadataReads).toBe(reads);
 await expect(page.locator('.source-action-options')).toBeVisible();
 await expect(page.locator('.source-tree')).toBeVisible();
});
