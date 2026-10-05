import {expect,test,type Page} from '@playwright/test';
import {create,clone} from '@bufbuild/protobuf';
import {GetSessionResponseSchema,GetAuthenticationOptionsResponseSchema,ListCapabilitiesResponseSchema,ListRepositoriesResponseSchema,GetRepositoryResponseSchema,GetPullRequestResponseSchema,ListPullRequestReviewsResponseSchema,ListReviewerRunsResponseSchema,GetPullRequestDiscussionResponseSchema,ListIssueCommentsResponseSchema,GetPullRequestMergeObservationRequestSchema,GetPullRequestMergeObservationResponseSchema,PullRequestSchema,PullRequestMergeObservationSchema,RepositorySchema,UserSchema,IssueState,PullMergeTargetProtection,PullMergeSourceState,RepositorySourceRefKind,type PullRequestMergeObservation} from '../src/gen/golf/v1/golf_pb';
import {respond,request,reject,disabledAgentTasks} from './rpc';

const key={owner:'alex',name:'private'},H='a'.repeat(40),B='b'.repeat(40),R='e'.repeat(64);
const user=create(UserSchema,{id:'42',login:'alex'});
const repository=create(RepositorySchema,{id:'11',name:key.name,fullName:'alex/private',private:true,defaultBranch:'main',htmlUrl:'https://forge.example/alex/private'});
const original=create(PullRequestSchema,{id:'9007199254740993',number:7,title:'Private comparison title',body:'PRIVATE PR BODY',revision:R,state:IssueState.OPEN,mergeBaseCommitId:B,base:{repositoryId:'11',ref:'main',commitId:B},head:{repositoryId:'23',ref:'feature/topic',commitId:H},user});
function observation(p=original){return create(PullRequestMergeObservationSchema,{selection:{repository:key,repositoryId:'11',pullRequestId:p.id,number:p.number,headCommitId:p.head!.commitId,baseCommitId:p.base!.commitId},pullRevision:p.revision,targetOwnerId:'42',sourceRepository:{owner:'contributor',name:'fork'},sourceRepositoryId:'23',source:{kind:RepositorySourceRefKind.BRANCH,name:'feature/topic',commitId:p.head!.commitId},base:{kind:RepositorySourceRefKind.BRANCH,name:'main',commitId:p.base!.commitId},targetProtection:PullMergeTargetProtection.UNPROTECTED,nativeCallerCanMerge:false,currentTargetWriter:false,sourceState:PullMergeSourceState.CURRENT,mergeConfiguration:{allowMergeCommits:true,allowSquashMerge:true,defaultMergeStyle:'merge',defaultUpdateStyle:'merge'},fingerprint:'f'.repeat(64),observedAt:'2026-10-04T18:00:00.123Z',unavailableReason:'protected_integration_unqualified'});}
async function backend(page:Page){
 const state={pull:clone(PullRequestSchema,original),count:0,methods:[] as string[],denial:0,wait:undefined as Promise<void>|undefined,change:undefined as ((v:PullRequestMergeObservation)=>void)|undefined};
 await page.route('**/rpc/**',async route=>{
  const method=new URL(route.request().url()).pathname.split('/').at(-1)!;state.methods.push(method);
  if(method==='GetSession')return respond(route,GetSessionResponseSchema,{user});
  if(method==='GetAuthenticationOptions')return respond(route,GetAuthenticationOptionsResponseSchema,{localPasswordEnabled:true});
  if(method==='ListCapabilities')return respond(route,ListCapabilitiesResponseSchema,{});
  if(method==='ListRepositories')return respond(route,ListRepositoriesResponseSchema,{repositories:[repository]});
  if(method==='GetRepository')return respond(route,GetRepositoryResponseSchema,{repository});
  if(method==='GetPullRequest')return respond(route,GetPullRequestResponseSchema,{pullRequest:state.pull});
  if(method==='ListPullRequestReviews')return respond(route,ListPullRequestReviewsResponseSchema,{});
  if(method==='ListReviewerRuns')return respond(route,ListReviewerRunsResponseSchema,{});
  if(method==='ListAgentTasks')return disabledAgentTasks(route);
  if(method==='GetPullRequestDiscussion')return respond(route,GetPullRequestDiscussionResponseSchema,{issue:{id:'101',number:7,title:original.title,state:IssueState.OPEN}});
  if(method==='ListIssueComments')return respond(route,ListIssueCommentsResponseSchema,{});
  if(method==='GetPullRequestMergeObservation'){
   state.count++;const input=request(route,GetPullRequestMergeObservationRequestSchema);
   expect(route.request().headers()['connect-protocol-version']).toBe('1');
   const pull=clone(PullRequestSchema,state.pull),v=observation(pull);state.change?.(v);
   expect(input).toMatchObject({selection:{repository:key,repositoryId:'11',pullRequestId:pull.id,number:7,headCommitId:pull.head!.commitId,baseCommitId:pull.base!.commitId},expectedPullRevision:pull.revision});
   if(state.wait)await state.wait;
   if(state.denial)return reject(route,state.denial===401?'unauthenticated':state.denial===403?'permission_denied':'not_found','Current private authority is unavailable.');
   return respond(route,GetPullRequestMergeObservationResponseSchema,{observation:v});
  }
  return reject(route,'unimplemented','Fixture procedure not supplied.');
 });return state;
}
async function open(page:Page){await page.goto('/alex/private/pull/7');await expect(page.getByRole('heading',{name:'Private comparison title #7'})).toBeVisible();}
const panel=(page:Page)=>page.getByRole('region',{name:'Pull request merge observation'});
async function inspect(page:Page){await page.getByRole('button',{name:'Inspect merge observations'}).click();}

test('explicit read preserves false observations and never starts native publication',async({page})=>{
 const state=await backend(page);await open(page);expect(state.count).toBe(0);await inspect(page);
 await expect(panel(page)).toContainText('Live source matches the selected head.');
 await panel(page).getByText('Native merge observations',{exact:true}).click();
 await expect(panel(page)).toContainText('Not allowed by native branch policy');await expect(panel(page)).toContainText('Merge commit, Squash');
 await expect(panel(page).getByRole('button',{name:/^Merge/})).toHaveCount(0);expect(state.count).toBe(1);
 expect(state.methods.filter(m=>/Create|Update|Publish|MergePull|Dispatch/.test(m))).toEqual([]);
});
for(const kind of ['protected','changed','unavailable','retained','unknown','writer-unknown'] as const)test(`honest ${kind} observation`,async({page})=>{
 const state=await backend(page);state.change=v=>{
  if(kind==='protected'){v.targetProtection=PullMergeTargetProtection.PROTECTED;v.nativeCallerCanMerge=true;}
  if(kind==='changed'){v.sourceState=PullMergeSourceState.CHANGED;v.source!.commitId='c'.repeat(40);v.base!.commitId='d'.repeat(40);}
  if(kind==='unavailable'||kind==='retained'){v.sourceState=kind==='unavailable'?PullMergeSourceState.UNAVAILABLE:PullMergeSourceState.RETAINED_ONLY;v.source=undefined;v.sourceRepository=undefined;v.sourceRepositoryId='';}
  if(kind==='unknown'){v.targetProtection=PullMergeTargetProtection.UNKNOWN;v.base=undefined;v.nativeCallerCanMerge=undefined;}
  if(kind==='writer-unknown')v.currentTargetWriter=undefined;
 };await open(page);await inspect(page);await expect(panel(page)).toContainText('Merge unavailable');await panel(page).getByText('Native merge observations',{exact:true}).click();
 await expect(panel(page)).toContainText(kind==='protected'?'Target branch is protected.':kind==='changed'?'Live target differs from the selected base.':kind==='unavailable'?'Live source could not be read':kind==='retained'?'Only a retained':kind==='unknown'?'Target protection is unknown.':'Unknown');
 if(kind==='unavailable'||kind==='retained')await expect(panel(page)).not.toContainText('contributor');
});
for(const tamper of ['repository','pull','head','revision','source-id','source-kind','source-state','base-name','missing-caller','fingerprint','strategy','time'] as const)test(`reject mismatched ${tamper} receipt`,async({page})=>{
 const state=await backend(page);state.change=v=>{
  switch(tamper){case'repository':v.selection!.repositoryId='12';break;case'pull':v.selection!.pullRequestId='4';break;case'head':v.selection!.headCommitId=B;break;case'revision':v.pullRevision='d'.repeat(64);break;case'source-id':v.sourceRepositoryId='24';break;case'source-kind':v.source!.kind=RepositorySourceRefKind.TAG;break;case'source-state':v.sourceState=PullMergeSourceState.CHANGED;break;case'base-name':v.base!.name='other';break;case'missing-caller':v.nativeCallerCanMerge=undefined;break;case'fingerprint':v.fingerprint='broken';break;case'strategy':v.mergeConfiguration!.defaultMergeStyle='invented';break;case'time':v.observedAt='2026-10-04T18:00:00Z PRIVATE';break;}
 };await open(page);await inspect(page);await expect(panel(page)).toContainText('does not match');await expect(panel(page).getByText('Native merge observations',{exact:true})).toHaveCount(0);await expect(page.getByText('PRIVATE PR BODY',{exact:true})).toBeVisible();
});
for(const status of [401,403,404])test(`private parent content clears on observation ${status}`,async({page})=>{
 const state=await backend(page);state.denial=status;await open(page);await inspect(page);
 await expect(page.getByText('PRIVATE PR BODY',{exact:true})).toHaveCount(0);await expect(page.getByRole('heading',{name:'Private comparison title #7'})).toHaveCount(0);
 if(status===401)await expect(page.getByRole('form',{name:'Golf account sign-in'})).toBeVisible();else await expect(page.getByText('Current private authority is unavailable.',{exact:false})).toBeVisible();
});
test('refresh masks observations and a changed comparison requires new explicit activation',async({page})=>{
 const state=await backend(page);await open(page);await inspect(page);await expect(panel(page)).toContainText('matches the selected head');
 let release!:()=>void;state.wait=new Promise<void>(r=>release=r);await page.getByRole('button',{name:'Refresh merge observation'}).click();await expect(panel(page)).not.toContainText('matches the selected head');
 state.pull.revision='d'.repeat(64);state.pull.head!.commitId='c'.repeat(40);await page.getByRole('button',{name:'Refresh pull request',exact:true}).click();
 await expect(page.getByRole('button',{name:'Inspect merge observations'})).toBeVisible();release();state.wait=undefined;
 await expect(panel(page)).not.toContainText('matches the selected head');expect(state.count).toBe(2);await inspect(page);await expect(panel(page)).toContainText('matches the selected head');expect(state.count).toBe(3);
});
test('navigation drops a held observation and reload requires explicit inspection',async({page})=>{
 const state=await backend(page);let release!:()=>void;state.wait=new Promise<void>(r=>release=r);await open(page);await inspect(page);await expect.poll(()=>state.count).toBe(1);
 await page.goto('/');release();state.wait=undefined;await open(page);await expect(page.getByRole('button',{name:'Inspect merge observations'})).toBeVisible();expect(state.count).toBe(1);
 await inspect(page);await expect(panel(page)).toContainText('matches the selected head');await page.reload();await expect(page.getByRole('button',{name:'Inspect merge observations'})).toBeVisible();expect(state.count).toBe(2);
});
for(const width of [390,1440])for(const theme of ['dark','light'])test(`shared layout ${width} ${theme}`,async({page})=>{
 await page.setViewportSize({width,height:1000});await page.addInitScript(t=>localStorage.setItem('golf.theme',t),theme);await backend(page);await open(page);await inspect(page);await expect(panel(page)).toContainText('matches the selected head');await panel(page).getByText('Native merge observations',{exact:true}).click();await page.evaluate(()=>document.fonts.ready);
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);await expect(page.locator('html')).toHaveAttribute('data-theme',theme);
});

test('an old denied inspection cannot clear a newly selected comparison',async({page})=>{
 const state=await backend(page);let release!:()=>void;state.wait=new Promise<void>(r=>release=r);await open(page);await inspect(page);await expect.poll(()=>state.count).toBe(1);
 state.pull.revision='d'.repeat(64);state.pull.head!.commitId='c'.repeat(40);await page.getByRole('button',{name:'Refresh pull request',exact:true}).click();await expect(page.getByRole('button',{name:'Inspect merge observations'})).toBeVisible();
 state.denial=403;release();state.wait=undefined;await expect(page.getByText('PRIVATE PR BODY',{exact:true})).toBeVisible();state.denial=0;await inspect(page);await expect(panel(page)).toContainText('matches the selected head');
});

test('fork merge availability needs separately observed source owner identity',async({page})=>{
 const state=await backend(page);state.change=v=>{v.nativeCallerCanMerge=true;v.currentTargetWriter=true;};await open(page);await inspect(page);await expect(panel(page)).toContainText('Merge unavailable');
 state.change=v=>{v.nativeCallerCanMerge=true;v.currentTargetWriter=true;v.sourceOwnerId='7';};await page.getByRole('button',{name:'Refresh merge observation',exact:true}).click();await expect(panel(page)).toContainText('Standard native merge scope observed');await expect(page.getByRole('button',{name:'Merge pull request',exact:true})).toBeEnabled();
 expect(state.methods).not.toContain('SubmitStandardPullMerge');
});
for(const fault of ['invalid-owner','retained-owner'] as const)test(`invalid fork observation ${fault} never enables merge`,async({page})=>{
 const state=await backend(page);state.change=v=>{v.nativeCallerCanMerge=true;v.currentTargetWriter=true;v.sourceOwnerId='0';if(fault==='retained-owner'){v.sourceState=PullMergeSourceState.UNAVAILABLE;v.source=undefined;v.sourceRepository=undefined;v.sourceRepositoryId='';v.sourceOwnerId='7';}};
 await open(page);await inspect(page);await expect(panel(page).getByRole('alert')).toContainText('does not match');await expect(page.getByRole('button',{name:'Merge pull request',exact:true})).toHaveCount(0);expect(state.methods).not.toContain('SubmitStandardPullMerge');
});
