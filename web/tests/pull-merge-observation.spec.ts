import { portableRuntimeFixture } from './runtime-fixture';
import {expect,test,type Page} from '@playwright/test';
import {create,clone,toJson} from '@bufbuild/protobuf';
import {GetPullReviewRequestsRequestSchema,GetPullReviewRequestsResponseSchema,GetSessionResponseSchema,GetAuthenticationOptionsResponseSchema,ListCapabilitiesResponseSchema,ListRepositoriesResponseSchema,GetRepositoryResponseSchema,GetPullRequestResponseSchema,ListPullRequestReviewsResponseSchema,ListReviewerRunsResponseSchema,GetPullRequestDiscussionResponseSchema,ListIssueCommentsResponseSchema,GetPullRequestMergeObservationRequestSchema,GetPullRequestMergeObservationResponseSchema,PullRequestSchema,PullRequestMergeObservationSchema,PullMergeConflictSchema,ProtectedReviewObservationSchema,RepositorySchema,UserSchema,IssueState,PullMergeTargetProtection,PullMergeSourceState,RepositorySourceRefKind,WatchRepositoryResponseSchema,type PullRequestMergeObservation} from '../src/gen/golf/v1/golf_pb';
import {respond,request,reject,disabledAgentTasks} from './rpc';

const key={owner:'alex',name:'private'},H='a'.repeat(40),B='b'.repeat(40),R='e'.repeat(64);
const user=create(UserSchema,{id:'42',login:'alex'});
const repository=create(RepositorySchema,{id:'11',name:key.name,fullName:'alex/private',private:true,defaultBranch:'main',htmlUrl:'https://forge.example/alex/private'});
const original=create(PullRequestSchema,{id:'9007199254740993',number:7,title:'Private comparison title',body:'PRIVATE PR BODY',revision:R,state:IssueState.OPEN,mergeBaseCommitId:B,base:{repositoryId:'11',ref:'main',commitId:B},head:{repositoryId:'23',ref:'feature/topic',commitId:H},user});
function streamFrame(flag:number,value:unknown){const body=Buffer.from(JSON.stringify(value)),header=Buffer.alloc(5);header[0]=flag;header.writeUInt32BE(body.length,1);return Buffer.concat([header,body]);}
function observation(p=original){return create(PullRequestMergeObservationSchema,{selection:{repository:key,repositoryId:'11',pullRequestId:p.id,number:p.number,headCommitId:p.head!.commitId,baseCommitId:p.base!.commitId},pullRevision:p.revision,targetOwnerId:'42',sourceRepository:{owner:'contributor',name:'fork'},sourceRepositoryId:'23',source:{kind:RepositorySourceRefKind.BRANCH,name:'feature/topic',commitId:p.head!.commitId},base:{kind:RepositorySourceRefKind.BRANCH,name:'main',commitId:p.base!.commitId},targetProtection:PullMergeTargetProtection.UNPROTECTED,nativeCallerCanMerge:false,currentTargetWriter:false,sourceState:PullMergeSourceState.CURRENT,mergeConfiguration:{allowMergeCommits:true,allowSquashMerge:true,defaultMergeStyle:'merge',defaultUpdateStyle:'merge'},fingerprint:'f'.repeat(64),observedAt:'2026-10-04T18:00:00.123Z',unavailableReason:'protected_integration_unqualified'});}
async function backend(page:Page,native=false,merge=false){
 const state={liveEnded:false,pullWait:undefined as Promise<void>|undefined,liveWait:undefined as Promise<void>|undefined,pull:clone(PullRequestSchema,original),count:0,methods:[] as string[],denial:0,wait:undefined as Promise<void>|undefined,change:undefined as ((v:PullRequestMergeObservation)=>void)|undefined};
 await page.route('**/rpc/**',async route=>{
  const method=new URL(route.request().url()).pathname.split('/').at(-1)!;state.methods.push(method);
  if(method==='WatchRepository'&&state.liveEnded)return route.fulfill({status:200,contentType:'application/connect+json',body:streamFrame(2,{error:{code:'unimplemented',message:'No more fixture events.'}})});
  if(method==='WatchRepository'&&state.liveWait){await state.liveWait;state.liveEnded=true;return route.fulfill({status:200,contentType:'application/connect+json',body:Buffer.concat([streamFrame(0,toJson(WatchRepositoryResponseSchema,create(WatchRepositoryResponseSchema,{repositoryId:'11',cursor:'1',kind:'reset',topics:[]}))),streamFrame(0,{repositoryId:'11',cursor:'1',kind:'reconnect'}),streamFrame(2,{})])});}
  if(method==='GetSession')return respond(route,GetSessionResponseSchema,{user});
  if(method==='GetAuthenticationOptions')return respond(route,GetAuthenticationOptionsResponseSchema,{localPasswordEnabled:true});
  if(method==='ListCapabilities')return respond(route,ListCapabilitiesResponseSchema, native?{...portableRuntimeFixture,runtimeProfile:'cloudflare-native',capabilities:[{id:'pull.merge-observation',state:3},...(merge?[{id:'pull.merge',state:3}]:[])]}:portableRuntimeFixture);
  if(method==='ListRepositories')return respond(route,ListRepositoriesResponseSchema,{repositories:[repository]});
  if(method==='GetRepository')return respond(route,GetRepositoryResponseSchema,{repository});
  if(method==='GetPullRequest'){if(state.pullWait)await state.pullWait;return respond(route,GetPullRequestResponseSchema,{pullRequest:state.pull});}
  if(method==='ListPullRequestReviews')return respond(route,ListPullRequestReviewsResponseSchema,{});
  if(method==='ListReviewerRuns')return respond(route,ListReviewerRunsResponseSchema,{});
  if(method==='ListAgentTasks')return disabledAgentTasks(route);
  if(method==='GetPullRequestDiscussion')return respond(route,GetPullRequestDiscussionResponseSchema,{issue:{id:'101',number:7,title:original.title,state:IssueState.OPEN}});
  if(method==='ListIssueComments')return respond(route,ListIssueCommentsResponseSchema,{});
  // An unanswered read renders its own alert, which made the single-alert assertions racy.
  if(method==='GetPullReviewRequests'){const input=request(route,GetPullReviewRequestsRequestSchema);return respond(route,GetPullReviewRequestsResponseSchema,{repositoryId:input.repositoryId,pullRequestId:input.pullRequestId,number:input.number,pullRevision:state.pull.revision,requestsRevision:'f'.repeat(64),canManage:false,reviewers:[],teams:[]});}
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

for(const status of [403,404])test(`observation ${status} stays masked through live reset until explicit reauthorization`,async({page})=>{
 const state=await backend(page);let release!:()=>void;state.liveWait=new Promise<void>(resolve=>release=resolve);state.denial=status;
 await open(page);await inspect(page);await expect(page.getByRole('alert')).toContainText('Current private authority is unavailable.');
 const reads=state.methods.filter(method=>method==='GetPullRequest').length,metadataReads=state.methods.filter(method=>method==='GetRepository').length;
 state.liveWait=new Promise<void>(()=>{});release();
 await expect.poll(()=>state.methods.filter(method=>method==='GetRepository').length).toBeGreaterThan(metadataReads);
 await expect(page.getByRole('alert')).toContainText('Current private authority is unavailable.');
 await expect(page.getByText('PRIVATE PR BODY',{exact:true})).toHaveCount(0);await expect(page.getByRole('heading',{name:'Private comparison title #7'})).toHaveCount(0);
 expect(state.methods.filter(method=>method==='GetPullRequest')).toHaveLength(reads);
 state.denial=0;
 await page.getByRole('button',{name:status===403?'Refresh pull request':'Try again',exact:true}).click();
 await expect(page.getByText('PRIVATE PR BODY',{exact:true})).toBeVisible();await expect(page.getByRole('heading',{name:'Private comparison title #7'})).toBeVisible();
 expect(state.methods.filter(method=>method==='GetPullRequest')).toHaveLength(reads+1);expect(state.count).toBe(1);
 await expect(page.getByRole('button',{name:'Inspect merge observations',exact:true})).toBeVisible();
 expect(state.methods.filter(method=>/Submit|MergePull|Publish|Dispatch/.test(method))).toEqual([]);
});


test('denial arriving during a held background pull read cancels its private result',async({page})=>{
 const state=await backend(page);let releaseLive!:()=>void,releasePull!:()=>void,releaseObservation!:()=>void;
 state.liveWait=new Promise<void>(resolve=>releaseLive=resolve);await open(page);
 state.wait=new Promise<void>(resolve=>releaseObservation=resolve);state.denial=403;await inspect(page);await expect.poll(()=>state.count).toBe(1);
 const reads=state.methods.filter(method=>method==='GetPullRequest').length;
 state.pullWait=new Promise<void>(resolve=>releasePull=resolve);state.liveWait=new Promise<void>(()=>{});releaseLive();
 await expect.poll(()=>state.methods.filter(method=>method==='GetPullRequest').length).toBe(reads+1);
 await expect(page.getByText('Checking pull request access…',{exact:true})).toBeVisible();
 releaseObservation();state.wait=undefined;
 await expect(page.getByRole('alert')).toContainText('Current private authority is unavailable.');
 state.pull.body='LATE PRIVATE BODY';state.pullWait=undefined;releasePull();
 await expect(page.getByText('LATE PRIVATE BODY',{exact:true})).toHaveCount(0);await expect(page.getByText('PRIVATE PR BODY',{exact:true})).toHaveCount(0);
 await expect(page.getByRole('alert')).toContainText('Current private authority is unavailable.');
 await page.getByRole('button',{name:'Refresh pull request',exact:true}).click();
 await expect(page.getByText('LATE PRIVATE BODY',{exact:true})).toBeVisible();
 expect(state.methods.filter(method=>/Submit|MergePull|Publish|Dispatch/.test(method))).toEqual([]);
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


test('protected exact-head exclusions remain diagnostic and never enable publication087',async({page})=>{
 const state=await backend(page);state.change=v=>{v.targetProtection=PullMergeTargetProtection.PROTECTED;v.nativeCallerCanMerge=true;v.currentTargetWriter=true;v.sourceOwnerId='7';v.protectedReviews=create(ProtectedReviewObservationSchema,{selectedHeadCommitId:H,exactHeadOfficialApprovals:1,observedReviews:2,exclusions:[{reviewId:'99',reviewerId:'53',reviewedCommitId:B,reason:'stale_head'}]});};
 await open(page);await inspect(page);await panel(page).getByText('Native merge observations',{exact:true}).click();
 await expect(panel(page)).toContainText('Exact-head official approvals observed');await expect(panel(page)).toContainText('including 1 on another head');await expect(panel(page)).toContainText('do not prove current reviewer eligibility');
 await expect(page.getByRole('button',{name:'Merge pull request',exact:true})).toHaveCount(0);expect(state.methods).not.toContain('SubmitStandardPullMerge');
});
for(const fault of ['head','count','reason','duplicate'] as const)test(`protected review ${fault} receipt rejected087`,async({page})=>{
 const state=await backend(page);state.change=v=>{v.targetProtection=PullMergeTargetProtection.PROTECTED;v.protectedReviews=create(ProtectedReviewObservationSchema,{selectedHeadCommitId:H,observedReviews:1,exclusions:[{reviewId:'99',reviewedCommitId:B,reason:'stale_head'}]});const reviews=v.protectedReviews;if(fault==='head')reviews.selectedHeadCommitId=B;if(fault==='count')reviews.observedReviews=2;if(fault==='reason')reviews.exclusions[0]!.reason='eligible';if(fault==='duplicate'){reviews.exclusions.push(reviews.exclusions[0]!);reviews.observedReviews=2;}};
 await open(page);await inspect(page);await expect(panel(page).getByRole('alert')).toContainText('does not match');await expect(page.getByRole('button',{name:'Merge pull request',exact:true})).toHaveCount(0);
});

for(const width of [390,1440])test(`native merge diagnostics are available without enabling publication at ${width}px`,async({page})=>{
 await page.setViewportSize({width,height:900});const state=await backend(page,true);
 state.change=v=>{v.mergeConfiguration!.allowMergeCommits=false;v.mergeConfiguration!.allowSquashMerge=false;};
 await open(page);await inspect(page);await expect(panel(page)).toContainText('Live source matches');
 await panel(page).getByText('Native merge observations',{exact:true}).click();await expect(panel(page)).toContainText('None');
 await expect(page.getByRole('button',{name:/^Merge pull request/})).toHaveCount(0);
 expect(state.methods).not.toContain('SubmitStandardPullMerge');
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBe(true);
});

for(const width of [390,1440])test(`native image receipt stays private and fits at ${width}px`,async({page})=>{
 await page.setViewportSize({width,height:900});await backend(page,true);
 let denied=false;
 const job={id:'72b855f6-2fe7-42ca-8a83-9a4a65d87f2b',state:'SUCCEEDED',agentState:'NONE',testState:'PASSED',adviceState:'NONE',stale:false,selection:{headCommitId:H}};
 const image={registry:'https://registry.example.com',repository:'alex/private',tag:'ci-'+job.id,digest:'sha256:'+'d'.repeat(64),commitId:H};
 await page.route('**/native/**',async route=>{
  const path=new URL(route.request().url()).pathname;
  if(path==='/native/config')return route.fulfill({json:{workspace:'alex',evidence:true,tests:true,previews:false}});
  if(path==='/native/repository-access')return route.fulfill({json:{role:'read'}});
  // Since b8e5e85 list and report reads use /native/pr-evidence/read; the bare path is for writes.
  if(path==='/native/pr-evidence/read'){
   if(denied)return route.fulfill({status:403,json:{message:'Repository access revoked'}});
   const input=route.request().postDataJSON();
   return route.fulfill({json:input.action==='report'?{job,report:{agentResult:{state:'NONE'},tests:{state:'PASSED',image},advice:{state:'NONE'},limitations:[]}}:{jobs:[job],truncated:false}});
  }
  return route.fulfill({status:404,json:{message:'Fixture route unavailable'}});
 });
 await open(page);await page.getByRole('button',{name:'Read report',exact:true}).click();
 await expect(page.getByRole('heading',{name:'Published container image'})).toBeVisible();
 await expect(page.getByText('registry.example.com/alex/private@'+image.digest,{exact:true})).toBeVisible();
 // Since ffc79ac the receipt links to the package's scan, SBOM and policy instead of a note about attestation.
 await expect(page.getByRole('link',{name:'Inspect scan, SBOM and policy',exact:true})).toBeVisible();
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
 expect(await page.evaluate(()=>JSON.stringify({...localStorage,...sessionStorage}))).not.toContain(image.digest);
 denied=true;await page.getByRole('button',{name:'Refresh PR',exact:true}).click();
 await expect(page.getByText(/Repository access revoked/)).toBeVisible();
 await expect(page.getByRole('heading',{name:'Published container image'})).toHaveCount(0);
});

for (const view of ['conversation', 'checks']) test(`native ${view} connects each run to its protected preview and removes expired links`, async ({ page }) => {
 await page.setViewportSize({ width: 390, height: 900 });
 await page.clock.install({ time: new Date('2026-10-12T01:30:00Z') });
 await backend(page, true);
 let denied = false;
 const job = { id: '72b855f6-2fe7-42ca-8a83-9a4a65d87f2b', state: 'SUCCEEDED', agentState: 'NONE', testState: 'PASSED', adviceState: 'NONE', stale: false, selection: { headCommitId: H } };
 const preview = { id: 'preview-owned', kind: 'WORKER', jobId: job.id, commitId: H, state: 'READY', expiresAt: '2026-10-12T01:31:00Z', purged: false, captureState: 'NONE', url: 'https://4b1a5b0c-4aa2-42ba-be6f-f705ba949bed.qual-1012b-preview.mjtechguy.com/' };
 await page.route('**/native/**', async route => {
  const path = new URL(route.request().url()).pathname;
  if (denied) return route.fulfill({ status: 403, json: { message: 'Repository access revoked' } });
  if (path === '/native/config') return route.fulfill({ json: { workspace: 'alex', evidence: true, tests: true, previews: true, apps: true } });
  if (path === '/native/repository-access') return route.fulfill({ json: { role: 'read' } });
  // Since b8e5e85 run and preview inventories are read from the /read paths.
  if (path === '/native/pr-evidence/read') return route.fulfill({ json: { jobs: [job], truncated: false } });
  if (path === '/native/pr-preview/read') return route.fulfill({ json: { previews: [preview, { ...preview, id: 'other-pr', jobId: 'foreign', url: 'https://foreign.example.com/' }, { ...preview, id: 'wrong-source', commitId: B, url: 'https://wrong-source.example.com/' }], truncated: false } });
  return route.fulfill({ status: 404, json: { message: 'Fixture route unavailable' } });
 });
 await page.goto('/alex/private/pull/7' + (view === 'checks' ? '/checks' : ''));
 const runs = page.getByRole('table', { name: 'PR runs', exact: true });
 await expect(runs.getByRole('link', { name: 'Open protected preview' })).toHaveAttribute('href', preview.url + '__golf/enter');
 await expect(runs.getByRole('button', { name: 'Copy protected preview URL' })).toBeVisible();
 await expect(runs).toContainText('4b1a5b0c-4aa2-42ba-be6f-f705ba949bed.qual-1012b-preview.mjtechguy.com/');
 await expect(runs).toContainText('expires');
 await expect(page.locator('a[href*="foreign.example.com"], a[href*="wrong-source.example.com"]')).toHaveCount(0);
 expect(await page.evaluate(() => ({ viewport: innerWidth, width: document.documentElement.scrollWidth }))).toEqual({ viewport: 390, width: 390 });
 await page.clock.fastForward(61_000);
 await expect(page.getByRole('link', { name: 'Open protected preview' })).toHaveCount(0);
 await expect(runs).toContainText('Preview expired');
 denied = true;
 await page.getByRole('button', { name: 'Refresh PR', exact: true }).click();
 await expect(page.getByText(/Repository access revoked/).first()).toBeVisible();
 await expect(page.getByRole('link', { name: 'Open protected preview' })).toHaveCount(0);
});

// Cloudflare-native merge slice: same repository, merge commits and squash, and a named reason when the slice does not admit the pull request.
const nativeReasons={native_nothing_to_merge:'nothing to merge',native_ancestry_unproven:'too large or too complex to find a single merge base',native_write_unresolved:'no confirmed outcome'} as const;
function sameRepository(state:Awaited<ReturnType<typeof backend>>,change:(v:PullRequestMergeObservation)=>void=()=>{}){
 state.pull.head!.repositoryId='11';
 state.change=v=>{v.sourceRepository=create(PullRequestMergeObservationSchema,{sourceRepository:key}).sourceRepository;v.sourceRepositoryId='11';v.sourceOwnerId='42';v.currentTargetWriter=true;v.nativeCallerCanMerge=true;change(v);};
}
const refuse=(v:PullRequestMergeObservation,reason:string)=>{v.nativeCallerCanMerge=false;v.mergeConfiguration!.allowMergeCommits=false;v.mergeConfiguration!.allowSquashMerge=false;v.unavailableReason=reason;};
const conflicts=(count:number)=>Array.from({length:count},(_,index)=>create(PullMergeConflictSchema,{path:`src/file-${String(index).padStart(2,'0')}.ts`,reason:index?'both_modified':'deleted_by_them'}));
test('native eligible same-repository observation enables a merge commit and squash',async({page})=>{
 const state=await backend(page,true,true);sameRepository(state);await open(page);
 await expect(page.getByRole('button',{name:'Merge pull request',exact:true})).toHaveCount(0);await inspect(page);
 await expect(panel(page)).toContainText('Standard native merge scope observed');await panel(page).getByText('Native merge observations',{exact:true}).click();
 await expect(panel(page)).toContainText('Merge commit, Squash');
 await page.getByRole('button',{name:'Merge pull request',exact:true}).click();
 await expect(page.getByRole('dialog').getByRole('option')).toHaveText(['Create a merge commit','Squash and merge']);await page.keyboard.press('Escape');
 expect(state.methods).not.toContain('SubmitStandardPullMerge');
});
test('native merge conflict names the refusal and lists at most 50 conflicting paths with their count',async({page})=>{
 const state=await backend(page,true,true);sameRepository(state,v=>{refuse(v,'native_merge_conflict');v.mergeConflicts=conflicts(50);v.mergeConflictCount=61;});
 await open(page);await inspect(page);await expect(panel(page)).toContainText('Merge unavailable');await expect(panel(page)).toContainText('changed the same paths differently');
 await expect(panel(page)).toContainText('61 paths conflict; the first 50 are listed');
 const listed=panel(page).getByRole('list',{name:'Conflicting paths'}).getByRole('listitem');
 await expect(listed).toHaveCount(50);await expect(listed.first()).toHaveText('src/file-00.ts changed on the base branch, deleted on the head branch');await expect(listed.nth(1)).toHaveText('src/file-01.ts changed differently on both branches');
 await expect(page.getByRole('region',{name:'Standard native merge'})).toContainText('Standard merge is unavailable');
 await expect(page.getByRole('button',{name:'Merge pull request',exact:true})).toHaveCount(0);expect(state.methods).not.toContain('SubmitStandardPullMerge');
});
for(const fault of ['no-paths','too-many','short-count','bad-reason','duplicate-path','paths-without-conflict'] as const)test(`native merge conflict with ${fault} is rejected`,async({page})=>{
 const state=await backend(page,true,true);sameRepository(state,v=>{refuse(v,fault==='paths-without-conflict'?'native_nothing_to_merge':'native_merge_conflict');
  v.mergeConflicts=fault==='no-paths'?[]:conflicts(fault==='too-many'?51:2);v.mergeConflictCount=fault==='short-count'?1:fault==='too-many'?51:2;
  if(fault==='bad-reason')v.mergeConflicts[0]!.reason='line_conflict';if(fault==='duplicate-path')v.mergeConflicts[1]!.path=v.mergeConflicts[0]!.path;});
 await open(page);await inspect(page);await expect(panel(page).getByRole('alert')).toContainText('does not match');
 await expect(page.getByRole('list',{name:'Conflicting paths'})).toHaveCount(0);await expect(page.getByRole('button',{name:'Merge pull request',exact:true})).toHaveCount(0);
});
test('native merge stays unmounted until the installation reports it ready',async({page})=>{
 const state=await backend(page,true,false);sameRepository(state);await open(page);await inspect(page);
 await expect(panel(page)).toContainText('Standard native merge scope observed');await expect(page.getByRole('region',{name:'Standard native merge'})).toHaveCount(0);
 await expect(page.getByRole('button',{name:'Merge pull request',exact:true})).toHaveCount(0);
});
for(const [reason,text] of Object.entries(nativeReasons))test(`native ${reason} names the refusal and offers no merge`,async({page})=>{
 const state=await backend(page,true,true);sameRepository(state,v=>refuse(v,reason));
 await open(page);await inspect(page);await expect(panel(page)).toContainText('Merge unavailable');await expect(panel(page)).toContainText(text);await expect(panel(page).getByRole('list',{name:'Conflicting paths'})).toHaveCount(0);
 await expect(page.getByRole('region',{name:'Standard native merge'})).toContainText('Standard merge is unavailable');
 await expect(page.getByRole('button',{name:'Merge pull request',exact:true})).toHaveCount(0);expect(state.methods).not.toContain('SubmitStandardPullMerge');
});
for(const fault of ['positive-flag','enabled-strategy','enabled-squash','unknown-reason','retired-reason','empty-reason'] as const)test(`native reason with ${fault} is rejected`,async({page})=>{
 const state=await backend(page,true,true);sameRepository(state,v=>{refuse(v,fault==='unknown-reason'?'native_anything_else':fault==='retired-reason'?'native_base_not_ancestor':fault==='empty-reason'?'':'native_nothing_to_merge');v.nativeCallerCanMerge=fault==='positive-flag';v.mergeConfiguration!.allowMergeCommits=fault==='enabled-strategy';v.mergeConfiguration!.allowSquashMerge=fault==='enabled-squash';});
 await open(page);await inspect(page);await expect(panel(page).getByRole('alert')).toContainText('does not match');
 await expect(page.getByRole('button',{name:'Merge pull request',exact:true})).toHaveCount(0);expect(state.methods).not.toContain('SubmitStandardPullMerge');
});
