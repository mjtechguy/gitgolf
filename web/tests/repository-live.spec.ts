import { ListActionRunsResponseSchema, InspectWorkflowsResponseSchema, ListWorkflowRunsResponseSchema, WorkflowFormat, WorkflowInspectionState } from '../src/gen/golf/v1/golf_pb';
import {expect,test,type Page,type Route} from '@playwright/test';
import {create,toJson} from '@bufbuild/protobuf';
import {resolveSourceFixture,respond,reject,request} from './rpc';
import {GetPullRequestResponseSchema,ListPullRequestCommitsRequestSchema,ListPullRequestCommitsResponseSchema,ListPullRequestChecksRequestSchema,ListPullRequestChecksResponseSchema,ReportedCheckState} from '../src/gen/golf/v1/golf_pb';
import {GetSessionResponseSchema,GetRepositoryResponseSchema,ListRepositoriesResponseSchema,ListCapabilitiesResponseSchema,GetContentsResponseSchema,ListBranchesResponseSchema,ListIssuesResponseSchema,GetIssueResponseSchema,ListIssueCommentsResponseSchema,WatchRepositoryResponseSchema,IssueState,SourceEntryType} from '../src/gen/golf/v1/golf_pb';

const head='a'.repeat(40);
function envelope(flag:number,body:unknown){const text=Buffer.from(JSON.stringify(body));const size=Buffer.alloc(5);size[0]=flag;size.writeUInt32BE(text.length,1);return Buffer.concat([size,text]);}
async function fixture(page:Page){
 const state={workflowName:'Original CI',manualAllowed:true,inspections:0,dispatches:0,cursor:1,title:'Original issue',topics:[] as string[],denied:false,offline:false,cursors:[] as string[],sources:0,pullHead:head,pullReads:0,checkState:ReportedCheckState.PENDING,commitReads:0,checkReads:0,issuesEnabled:undefined as boolean|undefined,metadataReads:0,eventCursor:undefined as string|undefined};
 await page.route('**/rpc/**',async(route:Route)=>{
  const method=new URL(route.request().url()).pathname.split('/').at(-1)!;
  if(method==='WatchRepository'){
   const raw=route.request().postDataBuffer()!;const input=JSON.parse(raw.subarray(5).toString());state.cursors.push(input.cursor||'');
   await new Promise(r=>setTimeout(r,150));
   if(state.offline)return reject(route,'unavailable','Live updates unavailable.');
   if(state.denied)return route.fulfill({status:200,contentType:'application/connect+json',body:envelope(2,{error:{code:'permission_denied',message:'Repository access removed.'}})});
   const cursor=state.eventCursor??String(state.cursor);const kind=input.cursor ? input.cursor!==cursor?'change':'heartbeat' : 'reset';
   const message=toJson(WatchRepositoryResponseSchema,create(WatchRepositoryResponseSchema,{repositoryId:'11',cursor,kind,topics:kind==='change'?state.topics:[]}));
   const reconnect={repositoryId:'11',cursor,kind:'reconnect'};
   return route.fulfill({status:200,contentType:'application/connect+json',body:Buffer.concat([envelope(0,message),envelope(0,reconnect),envelope(2,{})])});
  }
  const user={id:'42',login:'alex'};const repository={id:'11',name:'demo',fullName:'alex/demo',defaultBranch:'main',private:true};
  if(method==='GetSession')return respond(route,GetSessionResponseSchema,{user});
  if(method==='ListCapabilities')return respond(route,ListCapabilitiesResponseSchema,{});
  if(method==='ListRepositories')return respond(route,ListRepositoriesResponseSchema,{repositories:[repository]});
  if(method==='GetRepository'){state.metadataReads++;return respond(route,GetRepositoryResponseSchema,{repository:{...repository,issuesEnabled:state.issuesEnabled}});}
  if(method==='ResolveRepositorySource')return resolveSourceFixture(route,'11',{owner:'alex',name:'demo'},'main',{main:head});
  if(method==='GetContents'){state.sources++;return respond(route,GetContentsResponseSchema,{repositoryId:'11',kind:SourceEntryType.DIRECTORY,commitId:head,entries:[{name:'src',path:'src',sha:head,type:SourceEntryType.DIRECTORY}]});}
  if(method==='InspectWorkflows'){state.inspections++;return respond(route,InspectWorkflowsResponseSchema,{repositoryId:'11',commitId:head,catalogVersion:'golf.workflow.shell.v1',executionAvailable:true,policyRevision:'d'.repeat(64),configurations:[{path:'.github/workflows/ci.yml',name:state.workflowName,blobId:'e'.repeat(40),byteSize:100n,format:WorkflowFormat.GITHUB_ACTIONS,state:WorkflowInspectionState.VALIDATED_SUBSET,events:['workflow_dispatch','push'],manualPolicyAllowed:state.manualAllowed,pushPolicyAllowed:true}]});}
  if(method==='ListActionRuns')return respond(route,ListActionRunsResponseSchema,{repositoryId:'11'});
  if(method==='ListWorkflowRuns')return respond(route,ListWorkflowRunsResponseSchema,{});
  if(method==='DispatchWorkflow'){state.dispatches++;return reject(route,'permission_denied','Unexpected dispatch.');}
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


test('Actions source and run events refresh workflow observations without dispatching or moving the URL',async({page})=>{
 const state=await fixture(page);
 await page.goto('/alex/demo/actions');
 const workflow=page.getByRole('link',{name:'Show runs for .github/workflows/ci.yml',exact:true});
 await expect(workflow).toHaveText('Original CI');
 await expect(page.getByText('Live',{exact:true})).toBeVisible();
 let url=page.url();const reads=state.inspections;
 state.workflowName='Updated CI';state.topics=['source'];state.cursor++;
 await expect(workflow).toHaveText('Updated CI');
 expect(state.inspections).toBeGreaterThan(reads);expect(page.url()).toBe(url);
 await workflow.click();url=page.url();
 await expect(page.locator('.workflow-selected-heading')).toContainText('Manual: Ceilings allow');
 state.manualAllowed=false;state.topics=['actions'];state.cursor++;
 await expect(page.locator('.workflow-selected-heading')).toContainText('Manual: Ceilings deny');
 expect(state.dispatches).toBe(0);
 expect(page.url()).toBe(url);
});


test('empty activity watermark resumes idle rotations without refetching or replacing source controls',async({page})=>{
 const state=await fixture(page);state.cursor=0;
 await page.goto('/alex/demo');
 await expect(page.getByText('Live',{exact:true})).toBeVisible();
 await expect(page.locator('.source-tree')).toBeVisible();
 await expect.poll(()=>state.cursors.length).toBeGreaterThanOrEqual(3);
 const metadata=state.metadataReads,source=state.sources,rotations=state.cursors.length;
 await page.getByLabel('Source actions',{exact:true}).click();
 await expect(page.locator('.source-action-options')).toBeVisible();
 await page.locator('.source-tree').evaluate(node=>{(window as unknown as {acceptedTree:Element}).acceptedTree=node;});
 await expect.poll(()=>state.cursors.length).toBeGreaterThanOrEqual(rotations+4);
 expect(state.cursors[0]).toBe('');expect(state.cursors.slice(1).every(cursor=>cursor==='0')).toBe(true);
 expect(state.metadataReads).toBe(metadata);expect(state.sources).toBe(source);
 expect(await page.locator('.source-tree').evaluate(node=>node===(window as unknown as {acceptedTree:Element}).acceptedTree)).toBe(true);
 await expect(page.locator('.source-action-options')).toBeVisible();
 state.topics=['source'];state.cursor=1;
 await expect(page.getByRole('status').filter({hasText:'This source snapshot stays pinned'})).toBeVisible();
 await expect.poll(()=>state.metadataReads).toBeGreaterThan(metadata);
 expect(state.sources).toBe(source);expect(state.cursors).toContain('0');
 state.denied=true;await expect(page.getByRole('alert')).toContainText('Repository access removed');
 await expect(page.locator('.source-tree')).toHaveCount(0);
});

for(const cursor of ['', '00','01','+0','-1','9223372036854775808']){
 test(`live cursor rejects noncanonical watermark ${cursor||'missing'}`,async({page})=>{
  const state=await fixture(page);state.eventCursor=cursor;
  await page.goto('/alex/demo');
  await expect(page.getByRole('button',{name:'Reconnect live updates',exact:true})).toBeVisible();
  expect(state.cursors.every(value=>value==='')).toBe(true);
 });
}

test('live cursor cannot regress a positive observation to zero',async({page})=>{
 const state=await fixture(page);await page.goto('/alex/demo');
 await expect(page.getByText('Live',{exact:true})).toBeVisible();
 await expect.poll(()=>state.cursors).toContain('1');state.eventCursor='0';
 await expect(page.getByRole('button',{name:'Reconnect live updates',exact:true})).toBeVisible();
 expect(state.cursors.slice(1).every(value=>value==='1')).toBe(true);
});
