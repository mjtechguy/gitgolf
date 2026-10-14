import {expect,test,type Page} from '@playwright/test';
import {create} from '@bufbuild/protobuf';
import {GetSessionResponseSchema,GetAuthenticationOptionsResponseSchema,ListCapabilitiesResponseSchema,ListRepositoriesResponseSchema,GetRepositoryResponseSchema,GetPullRequestResponseSchema,ListPullRequestReviewsResponseSchema,ListReviewerRunsResponseSchema,GetPullRequestDiscussionResponseSchema,ListIssueCommentsResponseSchema,PullRequestSchema,RepositorySchema,UserSchema,IssueState,GetPullReviewAuthoringStateResponseSchema,SubmitPullReviewAuthoringOperationRequestSchema,SubmitPullReviewAuthoringOperationResponseSchema,DiscussionResourceOperationPhase as Phase,PullReviewAuthoringKind as Kind,PullRequestReviewState as Decision} from '../src/gen/golf/v1/golf_pb';
import {GetRepositoryFeaturesResponseSchema,FeatureDecider} from '../src/gen/golf/v1/feature_policy_pb';
import {respond,reject,request,disabledAgentTasks} from './rpc';

const key={owner:'alex',name:'edge-api'},H='a1b2c3d4e5f6'.padEnd(40,'0'),B='b'.repeat(40),P='e'.repeat(64),S='f'.repeat(64),shots=process.env.GOLF_AI_SHOTS;
const user=create(UserSchema,{id:'42',login:'alex'}),author=create(UserSchema,{id:'43',login:'sam'});
const repository=create(RepositorySchema,{id:'11',name:key.name,fullName:'alex/edge-api',private:true,defaultBranch:'main'});
const pull=create(PullRequestSchema,{id:'901',number:7,title:'Cache repository reads per commit',body:'Reads of the same commit now share one cached tree.',revision:P,state:IssueState.OPEN,base:{repositoryId:'11',ref:'main',commitId:B},head:{repositoryId:'11',ref:'cache-reads',commitId:H},user:author,createdAt:new Date(Date.now()-86400_000).toISOString()});
const at=new Date(Date.now()-20*60_000).toISOString(),target={number:7,pullRequestId:'901',baseCommitId:B,headCommitId:H};
const findings=[
 {path:'src/cache.ts',line:42,severity:'high',title:'Cache key ignores the repository',evidence:'The key is built from the commit ID alone, so two repositories that share a commit (forks, mirrors) read each other’s cached trees.',suggestion:'Include the repository ID in the key.'},
 {path:'src/cache.ts',line:57,severity:'medium',title:'Eviction can drop an entry still being filled',evidence:'evict() runs before the pending promise settles; a concurrent reader then misses and starts a second provider read.',suggestion:''},
 {path:'src/reads.ts',line:12,severity:'low',title:'Invalidation is not awaited',evidence:'invalidate(head) returns a promise that is never awaited on push, so a failure is silently dropped.',suggestion:'Await it, or log the rejection.'}];
const summary='Adds a bounded LRU cache of repository trees keyed by commit, shared by reads of the same commit, and invalidates it on push.\n\nThe approach is sound; the key and the eviction order need attention before merge.';
const markdown=`${summary}\n\n**Findings**\n\n- **High** \`src/cache.ts:42\`: Cache key ignores the repository\n  The key is built from the commit ID alone.\n  Suggestion: Include the repository ID in the key.\n`;
const output=(rows=findings)=>({summary,findings:rows,markdown,read:{files:14,of:20,bytes:96*1024-310,notRead:[{path:'assets/logo.png',reason:'binary'},{path:'fixtures/large.json',reason:'size'}],notReadCount:6,descriptionTruncated:false},commits:{base:B,mergeBase:B,head:H}});
type Run={id:string;kind:string;idempotencyKey:string;state:string;target:typeof target;model:string;output?:ReturnType<typeof output>;usage?:Record<string,number>;refusal?:string;inputSha256:string;stale?:boolean;createdAt:string;updatedAt:string;expiresAt:string;advisoryOnly:true};
const run=(change:Partial<Run>={}):Run=>({id:'7c9e6679-7425-40de-944b-e07fc1f90ae7',kind:'review-draft',idempotencyKey:'1b4e28ba-2fa1-41d2-883f-0016d3cca427',state:'SUCCEEDED',target,model:'@cf/zai-org/glm-5.3',output:output(),usage:{prompt_tokens:24100,completion_tokens:640},inputSha256:'c'.repeat(64),createdAt:at,updatedAt:at,expiresAt:at,advisoryOnly:true,...change});

async function backend(page:Page,{runs=[run()],role='write',stale=false,policyOff=false,capability=true,pending=false,pendingBody='Earlier notes.',settleAfter=2}:{runs?:readonly Run[];role?:string;stale?:boolean;policyOff?:boolean;capability?:boolean;pending?:boolean;pendingBody?:string;settleAfter?:number}={}){
 const state={runs:[...runs],created:[] as Record<string,unknown>[],statusReads:0,aiCalls:0,writes:[] as ReturnType<typeof request<typeof SubmitPullReviewAuthoringOperationRequestSchema>>[],pending,body:pending?pendingBody:''};
 await page.route('**/rpc/**',async route=>{
  const method=new URL(route.request().url()).pathname.split('/').at(-1)!;
  if(method==='GetSession')return respond(route,GetSessionResponseSchema,{user});
  if(method==='GetAuthenticationOptions')return respond(route,GetAuthenticationOptionsResponseSchema,{localPasswordEnabled:true});
  if(method==='ListCapabilities')return respond(route,ListCapabilitiesResponseSchema,{runtimeProfile:'cloudflare-native',capabilities:[{id:'pull.pending-reviews',label:'Pending review summaries',state:3,reason:'Test.'},...(capability?[{id:'pull.ai-review-drafts',label:'AI review drafts',state:3,reason:'Test allocation.'}]:[]),...(policyOff?[{id:'settings.feature-policy',label:'Feature policies',state:3,reason:'Test policy.'}]:[])]});
  if(method==='GetRepositoryFeatures')return respond(route,GetRepositoryFeaturesResponseSchema,{repositoryId:'11',features:[{feature:'ai-review-drafts',label:'AI review drafts',effective:false,decidedBy:FeatureDecider.REPOSITORY,reason:'AI review drafts are turned off for this repository by the repository policy.'}]});
  if(method==='ListRepositories')return respond(route,ListRepositoriesResponseSchema,{repositories:[repository]});
  if(method==='GetRepository')return respond(route,GetRepositoryResponseSchema,{repository});
  if(method==='GetPullRequest')return respond(route,GetPullRequestResponseSchema,{pullRequest:pull});
  if(method==='ListPullRequestReviews')return respond(route,ListPullRequestReviewsResponseSchema,{});
  if(method==='ListReviewerRuns')return respond(route,ListReviewerRunsResponseSchema,{});
  if(method==='ListAgentTasks')return disabledAgentTasks(route);
  if(method==='GetPullRequestDiscussion')return respond(route,GetPullRequestDiscussionResponseSchema,{issue:{id:'101',number:7,title:pull.title,state:IssueState.OPEN}});
  if(method==='ListIssueComments')return respond(route,ListIssueCommentsResponseSchema,{});
  if(method==='GetPullReviewAuthoringState')return respond(route,GetPullReviewAuthoringStateResponseSchema,{target:{repository:key,repositoryId:'11',pullRequestId:'901',number:7},pullRevision:P,snapshotRevision:S,currentHeadCommitId:H,canCreate:!state.pending,canUpdate:state.pending,canSubmit:state.pending,canDiscard:state.pending,ownPending:state.pending,review:state.pending?{id:'9',user,body:state.body,state:Decision.PENDING,commitId:H,commentsCount:0}:undefined,comments:[]});
  if(method==='SubmitPullReviewAuthoringOperation'){
   const m=request(route,SubmitPullReviewAuthoringOperationRequestSchema);state.writes.push(m);state.pending=m.kind!==Kind.SUBMIT_DRAFT&&m.kind!==Kind.DISCARD_DRAFT;state.body=m.body;
   return respond(route,SubmitPullReviewAuthoringOperationResponseSchema,{operation:{contract:'golf.pull.review-authoring.v1',original:{...m,body:''},actorId:'42',phase:Phase.SUCCEEDED,observedReviewId:'9',createdAt:at,updatedAt:at}});
  }
  return reject(route,'unimplemented','Fixture procedure not supplied.');
 });
 await page.route('**/native/**',async route=>{
  const path=new URL(route.request().url()).pathname,body=route.request().postDataJSON() as Record<string,unknown>;
  const json=(value:unknown,status=200)=>route.fulfill({status,contentType:'application/json',body:JSON.stringify(value)});
  if(path==='/native/config')return json({runtimeProfile:'cloudflare-native',evidence:false,advice:false,tests:false,agents:false,previews:false,apps:false,dailyLimit:0});
  if(path==='/native/repository-access')return json({role});
  if(path==='/native/pr-preview/read')return json({previews:[],truncated:false});
  if(path==='/native/pr-evidence/read')return json({jobs:[],truncated:false});
  if(path.startsWith('/native/ai'))state.aiCalls++;
  if(path==='/native/ai/read'&&body.action==='list')return json({runs:state.runs.map(({stale:_,...row})=>row),truncated:false});
  if(path==='/native/ai/read'&&body.action==='status'){
   state.statusReads++;const index=state.runs.findIndex(row=>row.id===body.runId);
   // A requested run settles after a few polls, as the Workflow would.
   if(['REQUESTED','RESERVED'].includes(state.runs[index]!.state)&&state.statusReads>=settleAfter)state.runs[index]={...run({id:state.runs[index]!.id,idempotencyKey:state.runs[index]!.idempotencyKey}),createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()};
   const value=state.runs[index]!;return json({run:value.state==='SUCCEEDED'?{...value,stale}:value});
  }
  if(path==='/native/ai'&&body.action==='create'){state.created.push(body);const queued=run({id:'0f8fad5b-d9cb-469f-a165-70867728950e',idempotencyKey:String(body.idempotencyKey),state:'REQUESTED',output:undefined,usage:undefined,inputSha256:'',createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()});state.runs=[queued,...state.runs];return json({run:queued});}
  return json({code:'unimplemented',message:'Fixture route not supplied.'},501);
 });
 return state;
}
const card=(page:Page)=>page.getByRole('region',{name:'Workers AI review draft'});
const panel=(page:Page)=>page.getByLabel('Pending review workspace');
async function open(page:Page){await page.goto('/alex/edge-api/pull/7');await expect(page.getByRole('heading',{name:'Cache repository reads per commit #7'})).toBeVisible();}

test('a stored draft shows the summary, findings by file with severity, what was read and that it is current',async({page})=>{
 await backend(page);await open(page);
 await expect(card(page)).toContainText('Only you can see this draft. Nothing is posted until you publish it as your own review.');
 await expect(card(page).getByLabel('Draft summary, rendered Markdown')).toContainText('The approach is sound');
 const file=card(page).getByRole('region',{name:'Findings in src/cache.ts'});
 await expect(file.getByRole('heading')).toHaveText('src/cache.ts2 findings');
 await expect(file.getByRole('listitem').first()).toContainText('HighL42Cache key ignores the repository');
 await expect(file.getByRole('listitem').first()).toContainText('SuggestionInclude the repository ID in the key.');
 await expect(file.getByRole('listitem').nth(1)).not.toContainText('Suggestion');
 await expect(card(page).getByRole('region',{name:'Findings in src/reads.ts'})).toContainText('LowL12Invalidation is not awaited');
 await expect(card(page)).toContainText('Read 14 of 20 changed files (96 KiB), the title and the description; not read: assets/logo.png (binary), fixtures/large.json (over the limit) and 4 more. No review comments were read.');
 await expect(card(page)).toContainText('@cf/zai-org/glm-5.3');await expect(card(page)).toContainText('Current');await expect(card(page)).toContainText('Untrusted draft');
 await expect(card(page).getByTitle(H)).toHaveText(H.slice(0,12));
 await expect(card(page)).toContainText("Generated by Workers AI through this installation's private AI Gateway. It can be wrong; nothing is published until you act.");
 await expect(panel(page).getByRole('button',{name:'Draft again with Workers AI'})).toBeEnabled();
});

test('draft, then start a pending review with the text, then publish it as your own review',async({page})=>{
 const state=await backend(page);await open(page);
 await card(page).getByRole('button',{name:'Start pending review with this text'}).click();
 const form=page.getByRole('form',{name:'Edit pending review'});
 await expect(form.getByLabel('Review text',{exact:true})).toHaveValue(markdown);
 expect(state.writes).toHaveLength(0);
 await form.getByLabel('Review text',{exact:true}).fill(markdown+'\nChecked by hand.');
 await form.getByRole('button',{name:'Save',exact:true}).click();
 await expect(page.getByText('Review change confirmed.',{exact:true})).toBeVisible();
 expect(state.writes[0]).toMatchObject({kind:Kind.CREATE_DRAFT,body:markdown+'\nChecked by hand.',expectedPullRevision:P,expectedSnapshotRevision:S});
 await page.getByRole('button',{name:'Done',exact:true}).click();
 await panel(page).getByRole('button',{name:'Submit pending review',exact:true}).click();
 // The person chooses the decision; the draft never does.
 await expect(page.getByRole('combobox')).toHaveValue(String(Decision.COMMENT));
 await page.getByRole('combobox').selectOption(String(Decision.REQUEST_CHANGES));
 await page.getByRole('button',{name:'Review submission'}).click();
 await page.getByRole('button',{name:'Publish review',exact:true}).click();
 await expect.poll(()=>state.writes.length).toBe(2);
 expect(state.writes[1]).toMatchObject({kind:Kind.SUBMIT_DRAFT,reviewId:'9',decision:Decision.REQUEST_CHANGES,body:markdown+'\nChecked by hand.'});
});

test('an existing pending review gets the draft appended, not replaced',async({page})=>{
 const state=await backend(page,{pending:true});await open(page);
 await panel(page).getByRole('button',{name:'Inspect pending review'}).click();
 await card(page).getByRole('button',{name:'Add to my pending review'}).click();
 await expect(page.getByLabel('Review text',{exact:true})).toHaveValue('Earlier notes.\n\n'+markdown);
 await page.getByRole('button',{name:'Save',exact:true}).click();
 await expect.poll(()=>state.writes.length).toBe(1);expect(state.writes[0]).toMatchObject({kind:Kind.UPDATE_DRAFT,reviewId:'9',body:'Earlier notes.\n\n'+markdown});
});

test('Draft with Workers AI admits one run for the exact commits, shows it reading, then the draft',async({page})=>{
 const state=await backend(page,{runs:[]});await open(page);
 await expect(card(page)).toHaveCount(0);
 await panel(page).getByRole('button',{name:'Draft with Workers AI'}).click();
 await expect(panel(page).getByRole('button',{name:'Drafting…'})).toBeDisabled();
 await expect(card(page)).toContainText(`Workers AI is reading the diff of ${H.slice(0,12)}.`);
 expect(state.created).toHaveLength(1);
 expect(state.created[0]).toMatchObject({repository:key,repositoryId:'11',action:'create',kind:'review-draft',target});
 expect(Object.keys(state.created[0]!).sort()).toEqual(['action','idempotencyKey','kind','repository','repositoryId','target']);
 await expect(card(page).getByRole('region',{name:'Findings in src/cache.ts'})).toBeVisible({timeout:15_000});
 await expect(panel(page).getByRole('button',{name:'Draft again with Workers AI'})).toBeEnabled();
});

test('an out-of-date draft says why and cannot start a pending review',async({page})=>{
 await backend(page,{stale:true});await open(page);
 await expect(card(page)).toContainText('Out of date');
 await expect(card(page)).toContainText('The pull request changed after this draft (new commits, or an edited title or description). Draft again for the current commits.');
 await expect(card(page).getByRole('button',{name:'Start pending review with this text'})).toBeDisabled();
 await expect(card(page).getByRole('button',{name:'Copy text'})).toBeEnabled();
});

test('no findings is said plainly and is not an approval',async({page})=>{
 await backend(page,{runs:[run({output:output([])})]});await open(page);
 await expect(card(page)).toContainText('No findings. No findings is not an approval: the model reads at most 96 KiB and can miss problems.');
});

test('an unknown or refused latest request says no draft was stored and keeps the earlier draft',async({page})=>{
 await backend(page,{runs:[run({id:'3f333df6-90a4-4fda-8dd3-9485d27cee36',state:'UNKNOWN',output:undefined}),run()]});await open(page);
 await expect(card(page)).toContainText('The latest request’s outcome is unknown: Workers AI may have been called, but no draft was stored.');
 await expect(card(page)).toContainText('The draft above is from an earlier request.');
 await expect(card(page).getByRole('region',{name:'Findings in src/cache.ts'})).toBeVisible();
});
test('a refused request shows the Worker’s reason',async({page})=>{
 await backend(page,{runs:[run({state:'REFUSED',output:undefined,refusal:"This pull request's diff exceeds the native comparison limit (512 KiB of patch, 256 files, 2 MiB of file contents); nothing was billed."})]});await open(page);
 await expect(card(page)).toContainText("The latest request was refused: This pull request's diff exceeds the native comparison limit (512 KiB of patch, 256 files, 2 MiB of file contents); nothing was billed.");
 await expect(card(page).getByRole('list')).toHaveCount(0);
});

test('readers get no draft action and see no one else’s drafts',async({page})=>{
 await backend(page,{role:'read',runs:[]});await open(page);
 await expect(panel(page)).toBeVisible();await expect(panel(page).getByRole('button',{name:/Workers AI/})).toHaveCount(0);await expect(card(page)).toHaveCount(0);
});
test('a feature policy that turned drafts off keeps stored drafts and removes the action',async({page})=>{
 await backend(page,{policyOff:true});await open(page);
 await expect(card(page)).toContainText('AI review drafts are turned off for this repository by the repository policy. Stored drafts stay readable.');
 await expect(panel(page).getByRole('button',{name:/Workers AI/})).toHaveCount(0);
 await expect(card(page).getByRole('region',{name:'Findings in src/cache.ts'})).toBeVisible();
});
test('nothing is shown or requested without the AI review drafts capability',async({page})=>{
 const state=await backend(page,{capability:false});await open(page);
 await expect(panel(page)).toBeVisible();await expect(card(page)).toHaveCount(0);await expect(panel(page).getByRole('button',{name:/Workers AI/})).toHaveCount(0);
 expect(state.aiCalls).toBe(0);
});
test('the 390px draft fits the viewport',async({page})=>{
 await page.setViewportSize({width:390,height:844});await backend(page);await open(page);await expect(card(page)).toBeVisible();
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
});

test.describe('screenshots',()=>{
 test.skip(!shots,'Set GOLF_AI_SHOTS to a directory to capture the draft.');
 for(const [name,options] of [['draft',{}],['stale',{stale:true}],['reading',{runs:[run({state:'REQUESTED',output:undefined})],settleAfter:1e9}]] as const)
  for(const [appearance,layout,theme] of [['flare','console','dark'],['classic','primer','light'],['golf','tiles','dark']] as const)
   for(const [width,height] of [[1440,900],[390,844]] as const)
    test(`${name} in ${appearance} ${layout} ${theme} at ${width}px`,async({page})=>{
     await page.addInitScript(([a,l,t])=>{localStorage.setItem('golf.appearance',a!);localStorage.setItem(`golf.layout.${a}`,l!);localStorage.setItem('golf.theme',t!);},[appearance,layout,theme]);
     await page.setViewportSize({width,height});await backend(page,options);await open(page);await expect(card(page)).toBeVisible();
     if(name!=='reading')await expect(card(page).getByRole('region').first()).toBeVisible();
     await panel(page).scrollIntoViewIfNeeded();
     await page.screenshot({path:`${shots}/${name}-${appearance}-${layout}-${theme}-${width}.png`});
     await card(page).screenshot({path:`${shots}/${name}-${appearance}-${layout}-${theme}-${width}-card.png`});
    });
});
