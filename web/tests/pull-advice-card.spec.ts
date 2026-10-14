import {expect,test,type Page} from '@playwright/test';
import {create} from '@bufbuild/protobuf';
import {GetSessionResponseSchema,GetAuthenticationOptionsResponseSchema,ListCapabilitiesResponseSchema,ListRepositoriesResponseSchema,GetRepositoryResponseSchema,GetPullRequestResponseSchema,ListPullRequestReviewsResponseSchema,ListReviewerRunsResponseSchema,GetPullRequestDiscussionResponseSchema,ListIssueCommentsResponseSchema,PullRequestSchema,RepositorySchema,UserSchema,IssueState} from '../src/gen/golf/v1/golf_pb';
import {GetRepositoryFeaturesResponseSchema,FeatureDecider} from '../src/gen/golf/v1/feature_policy_pb';
import {respond,reject,disabledAgentTasks} from './rpc';

const key={owner:'alex',name:'edge-api'},H='a1b2c3d4e5f6'.padEnd(40,'0'),B='b'.repeat(40),shots=process.env.GOLF_AI_SHOTS;
const user=create(UserSchema,{id:'42',login:'alex'});
const repository=create(RepositorySchema,{id:'11',name:key.name,fullName:'alex/edge-api',private:true,defaultBranch:'main'});
const pull=create(PullRequestSchema,{id:'901',number:7,title:'Cache repository reads per commit',body:'Reads of the same commit now share one cached tree. Adds a bounded LRU and invalidates on push.',revision:'e'.repeat(64),state:IssueState.OPEN,base:{repositoryId:'11',ref:'main',commitId:B},head:{repositoryId:'11',ref:'cache-reads',commitId:H},user,createdAt:new Date(Date.now()-86400_000).toISOString()});
const capturedAt=new Date(Date.now()-2*3600_000).toISOString();
const job=(state:Partial<{id:string;state:string;adviceState:string;stale:boolean}>={})=>({id:'7c9e6679-7425-40de-944b-e07fc1f90ae7',idempotencyKey:'1b4e28ba-2fa1-41d2-883f-0016d3cca427',state:'SUCCEEDED',agentState:'NONE',testState:'NONE',adviceState:'SUCCEEDED',stale:false,createdAt:capturedAt,updatedAt:capturedAt,
 selection:{repositoryId:'11',pullRequestId:'901',number:7,baseCommitId:B,headCommitId:H},...state});
const report=(value:ReturnType<typeof job>)=>({job:value,report:{capturedAt,advice:{state:'SUCCEEDED',model:'@cf/cloudflare/clef',advisoryOnly:true,answers:{next:{type:'choice',choice:'run_tests',probabilities:{inspect_changes:.27,run_tests:.61,resolve_feedback:.12}}},usage:{input_tokens:412,output_tokens:6}}}});

async function backend(page:Page,{jobs=[job()],role='write',advice=true,policyOff=false}:{jobs?:ReturnType<typeof job>[];role?:string;advice?:boolean;policyOff?:boolean}={}){
 const state={jobs,created:[] as Record<string,unknown>[],reports:0};
 await page.route('**/rpc/**',async route=>{
  const method=new URL(route.request().url()).pathname.split('/').at(-1)!;
  if(method==='GetSession')return respond(route,GetSessionResponseSchema,{user});
  if(method==='GetAuthenticationOptions')return respond(route,GetAuthenticationOptionsResponseSchema,{localPasswordEnabled:true});
  if(method==='ListCapabilities')return respond(route,ListCapabilitiesResponseSchema,{runtimeProfile:'cloudflare-native',capabilities:[{id:'native-pr-evidence',label:'Private PR evidence',state:3,reason:'Test allocation.'},...(policyOff?[{id:'settings.feature-policy',label:'Feature policies',state:3,reason:'Test policy.'}]:[])]});
  if(method==='GetRepositoryFeatures')return respond(route,GetRepositoryFeaturesResponseSchema,{repositoryId:'11',features:[{feature:'advice',label:'AI review advice',effective:false,decidedBy:FeatureDecider.REPOSITORY,reason:'AI review advice is turned off for this repository by the repository policy.'}]});
  if(method==='ListRepositories')return respond(route,ListRepositoriesResponseSchema,{repositories:[repository]});
  if(method==='GetRepository')return respond(route,GetRepositoryResponseSchema,{repository});
  if(method==='GetPullRequest')return respond(route,GetPullRequestResponseSchema,{pullRequest:pull});
  if(method==='ListPullRequestReviews')return respond(route,ListPullRequestReviewsResponseSchema,{});
  if(method==='ListReviewerRuns')return respond(route,ListReviewerRunsResponseSchema,{});
  if(method==='ListAgentTasks')return disabledAgentTasks(route);
  if(method==='GetPullRequestDiscussion')return respond(route,GetPullRequestDiscussionResponseSchema,{issue:{id:'101',number:7,title:pull.title,state:IssueState.OPEN}});
  if(method==='ListIssueComments')return respond(route,ListIssueCommentsResponseSchema,{});
  return reject(route,'unimplemented','Fixture procedure not supplied.');
 });
 await page.route('**/native/**',async route=>{
  const path=new URL(route.request().url()).pathname,body=route.request().postDataJSON() as Record<string,unknown>;
  const json=(value:unknown,status=200)=>route.fulfill({status,contentType:'application/json',body:JSON.stringify(value)});
  if(path==='/native/config')return json({runtimeProfile:'cloudflare-native',evidence:true,advice,tests:false,agents:false,previews:false,apps:false,dailyLimit:20});
  if(path==='/native/repository-access')return json({role});
  if(path==='/native/pr-evidence/read'&&body.action==='list')return json({jobs:state.jobs,truncated:false});
  if(path==='/native/pr-evidence/read'&&body.action==='report'){state.reports++;return json(report(state.jobs.find(j=>j.id===body.jobId)!));}
  if(path==='/native/pr-evidence'&&body.action==='create'){state.created.push(body);const queued=job({id:'0f8fad5b-d9cb-469f-a165-70867728950e',state:'QUEUED',adviceState:'REQUESTED'});state.jobs=[queued,...state.jobs];return json({job:queued});}
  if(path==='/native/pr-preview/read')return json({previews:[],truncated:false});
  return json({code:'unimplemented',message:'Fixture route not supplied.'},501);
 });
 return state;
}
const card=(page:Page)=>page.getByRole('region',{name:'Clef recommendation'});
async function open(page:Page){await page.goto('/alex/edge-api/pull/7');await expect(page.getByRole('heading',{name:'Cache repository reads per commit #7'})).toBeVisible();}
async function look(page:Page,name:string,appearance:string,layout:string,theme:string,width=1440,height=900){
 await page.addInitScript(([a,l,t])=>{localStorage.setItem('golf.appearance',a!);localStorage.setItem(`golf.layout.${a}`,l!);localStorage.setItem('golf.theme',t!);},[appearance,layout,theme]);
 await page.setViewportSize({width,height});await open(page);await expect(card(page)).toBeVisible();await expect(card(page).getByRole('status')).toHaveCount(0);
 if(shots){await card(page).scrollIntoViewIfNeeded();await page.screenshot({path:`${shots}/${name}-${appearance}-${layout}-${theme}-${width}.png`});await card(page).screenshot({path:`${shots}/${name}-${appearance}-${layout}-${theme}-${width}-card.png`});}
}

test('current advice reads as a sentence with each option’s probability, the model, what it read and the commit',async({page})=>{
 await backend(page);await open(page);
 await expect(card(page)).toContainText('Clef suggests Run the tests on this exact commit next.');
 await expect(card(page)).toContainText('Current');await expect(card(page)).not.toContainText('Out of date');
 await expect(card(page).getByRole('list',{name:"Clef's probability for each next step"}).getByRole('listitem')).toHaveText(['Inspect changes27%','Run tests (recommended)61%','Resolve feedback12%']);
 await expect(card(page).getByRole('meter',{name:'Run tests: 61%'})).toHaveAttribute('value','0.61');
 await expect(card(page)).toContainText('@cf/cloudflare/clef');await expect(card(page)).toContainText('Clef read only metadata: title, description, review and check states. It read no code.');
 await expect(card(page).getByTitle(H)).toHaveText(H.slice(0,12));
 await expect(card(page)).toContainText("Generated by Workers AI through this installation's private AI Gateway. It can be wrong; nothing is published until you act.");
 await expect(card(page).getByRole('button',{name:'Ask Clef again'})).toBeVisible();
});
test('stale advice is flagged out of date and says why',async({page})=>{
 await backend(page,{jobs:[job({stale:true})]});await open(page);
 await expect(card(page)).toContainText('Out of date');await expect(card(page)).toContainText('The pull request changed after this advice; ask again for the current commits.');
});
test('no advice offers a writer the first request',async({page})=>{
 await backend(page,{jobs:[]});await open(page);
 await expect(card(page)).toContainText('Clef has not been asked about this pull request.');
 await expect(card(page).getByRole('list')).toHaveCount(0);await expect(card(page)).not.toContainText('Current');
 await expect(card(page).getByRole('button',{name:'Ask Clef'})).toBeVisible();
});
test('an unknown latest outcome keeps the earlier advice and says no new advice was stored',async({page})=>{
 const state=await backend(page,{jobs:[job({id:'3f333df6-90a4-4fda-8dd3-9485d27cee36',adviceState:'UNKNOWN'}),job()]});await open(page);
 await expect(card(page)).toContainText('The latest request’s outcome is unknown: no advice was stored. The advice above is from an earlier request.');
 await expect(card(page)).toContainText('Run the tests on this exact commit next.');expect(state.reports).toBe(1);
});
test('readers see the advice without the request button',async({page})=>{
 await backend(page,{role:'read'});await open(page);
 await expect(card(page)).toContainText('Run the tests on this exact commit next.');await expect(card(page).getByRole('button')).toHaveCount(0);
});
test('Ask Clef again admits one advice-only evidence job for the exact commits and shows it reading',async({page})=>{
 const state=await backend(page);await open(page);
 await card(page).getByRole('button',{name:'Ask Clef again'}).click();
 await expect(card(page).getByRole('button',{name:'Clef is reading…'})).toBeDisabled();
 expect(state.created).toHaveLength(1);
 expect(state.created[0]).toMatchObject({action:'create',advice:true,selection:{repository:key,repositoryId:'11',number:7,pullRequestId:'901',baseCommitId:B,headCommitId:H}});
 expect(Object.keys(state.created[0]!).sort()).toEqual(['action','advice','idempotencyKey','selection']);
 await expect(card(page)).toContainText('Run the tests on this exact commit next.');
});
test('a feature policy that turned advice off keeps stored advice and removes the request',async({page})=>{
 await backend(page,{policyOff:true});await open(page);
 await expect(card(page)).toContainText('AI review advice is turned off for this repository by the repository policy. Stored advice stays readable.');
 await expect(card(page)).toContainText('Run the tests on this exact commit next.');await expect(card(page).getByRole('button')).toHaveCount(0);
});
test('the card is absent when the installation has not allocated advice',async({page})=>{
 await backend(page,{advice:false});await open(page);
 await expect(card(page)).toHaveCount(0);
});

test.describe('screenshots',()=>{
 test.skip(!shots,'Set GOLF_AI_SHOTS to a directory to capture the card.');
 for(const [name,jobs] of [['current',[job()]],['stale',[job({stale:true})]],['none',[]]] as const)
  for(const [appearance,layout,theme,width,height] of [['flare','console','dark',1440,900],['flare','console','light',1440,900],['golf','tiles','dark',1440,900],['classic','primer','light',1440,900],['flare','console','dark',390,844]] as const)
   test(`${name} card in ${appearance} ${layout} ${theme} at ${width}px`,async({page})=>{await backend(page,{jobs:[...jobs]});await look(page,name,appearance,layout,theme,width,height);});
});
