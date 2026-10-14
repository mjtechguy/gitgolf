import {expect,test,type Page} from '@playwright/test';
import {create} from '@bufbuild/protobuf';
import {GetSessionResponseSchema,GetAuthenticationOptionsResponseSchema,ListCapabilitiesResponseSchema,ListRepositoriesResponseSchema,GetRepositoryResponseSchema,GetIssueResponseSchema,ListIssueCommentsResponseSchema,
 ListRepositoryLabelsResponseSchema,ListRepositoryMilestonesResponseSchema,ListRepositoryAssigneesResponseSchema,UpdateIssueRequestSchema,UpdateIssueResponseSchema,IssueMutationSchema,IssueMutationKind,IssueMutationState,
 IssueSchema,IssueState,RepositorySchema,UserSchema,DiscussionLabelSchema,type UpdateIssueRequest} from '../src/gen/golf/v1/golf_pb';
import {GetRepositoryFeaturesResponseSchema,FeatureDecider} from '../src/gen/golf/v1/feature_policy_pb';
import {respond,reject,request} from './rpc';

const key={owner:'alex',name:'project'},shots=process.env.GOLF_AI_SHOTS;
const user=create(UserSchema,{id:'42',login:'alex'});
const repository=create(RepositorySchema,{id:'11',name:'project',fullName:'alex/project',private:true,defaultBranch:'main'});
const labels=[create(DiscussionLabelSchema,{id:'3',name:'bug',color:'d73a4a',description:"Something isn't working"}),create(DiscussionLabelSchema,{id:'4',name:'enhancement',color:'a2eeef',description:'New feature or request'}),
 create(DiscussionLabelSchema,{id:'5',name:'docs',color:'0075ca'}),create(DiscussionLabelSchema,{id:'6',name:'performance',color:'fbca04'})];
const issue=create(IssueSchema,{id:'101',number:12,title:'Crash when the config file is empty',body:'Starting with an empty golf.toml panics at load.',state:IssueState.OPEN,user,createdAt:'2026-10-12T12:00:00Z',updatedAt:'2026-10-12T12:00:00Z',revision:'a'.repeat(64),
 metadata:{labelsKnown:true,labels:[labels[3]!],assigneesKnown:true,milestoneKnown:true}});
const at=new Date(Date.now()-40*60_000).toISOString();
const output={choice:'3',none:0.08,considered:4,issueNumber:12,truncated:false,suggestions:[{labelId:'3',name:'bug',color:'d73a4a',probability:0.71},{labelId:'6',name:'performance',color:'fbca04',probability:0.16}],
 ranked:[{labelId:'3',name:'bug',color:'d73a4a',probability:0.71},{labelId:'6',name:'performance',color:'fbca04',probability:0.16},{labelId:'4',name:'enhancement',color:'a2eeef',probability:0.03},{labelId:'5',name:'docs',color:'0075ca',probability:0.02}]};
type Run={id:string;kind:string;state:string;target:{number:number};model:string;output?:typeof output;refusal?:string;stale?:boolean;createdAt:string;updatedAt:string};
const run=(over:Partial<Run>={}):Run=>({id:'7c9e6679-7425-40de-944b-e07fc1f90ae7',kind:'triage',state:'SUCCEEDED',target:{number:12},model:'@cf/cloudflare/clef',output,createdAt:at,updatedAt:at,...over});

async function backend(page:Page,{runs=[run()] as Run[],canEditLabels=true,capability=true,policyOff=false,stale=false,createError=''}={}){
 const state={runs,created:[] as Record<string,unknown>[],updates:[] as UpdateIssueRequest[],settleAfter:0,issue};
 await page.route('**/rpc/**',async route=>{
  const method=new URL(route.request().url()).pathname.split('/').at(-1)!;
  if(method==='GetSession')return respond(route,GetSessionResponseSchema,{user});
  if(method==='GetAuthenticationOptions')return respond(route,GetAuthenticationOptionsResponseSchema,{localPasswordEnabled:true});
  if(method==='ListCapabilities')return respond(route,ListCapabilitiesResponseSchema,{runtimeProfile:'cloudflare-native',capabilities:[{id:'discussion.resources',state:3},{id:'discussion.comments',state:3},
   ...(capability?[{id:'discussion.ai-triage',label:'Label suggestions',state:3,reason:'Test allocation.'}]:[]),...(policyOff?[{id:'settings.feature-policy',label:'Feature policies',state:3}]:[])]});
  if(method==='GetRepositoryFeatures')return respond(route,GetRepositoryFeaturesResponseSchema,{repositoryId:'11',features:[{feature:'ai-triage',label:'AI label suggestions',effective:false,decidedBy:FeatureDecider.REPOSITORY,reason:'AI label suggestions are turned off for this repository by the repository policy.'}]});
  if(method==='ListRepositories')return respond(route,ListRepositoriesResponseSchema,{repositories:[repository]});
  if(method==='GetRepository')return respond(route,GetRepositoryResponseSchema,{repository});
  if(method==='GetIssue')return respond(route,GetIssueResponseSchema,{issue:state.issue});
  if(method==='ListIssueComments')return respond(route,ListIssueCommentsResponseSchema,{});
  if(method==='ListRepositoryLabels')return respond(route,ListRepositoryLabelsResponseSchema,{labels,canManage:canEditLabels,canEditLabels});
  if(method==='ListRepositoryMilestones')return respond(route,ListRepositoryMilestonesResponseSchema,{canEditMilestone:canEditLabels});
  if(method==='ListRepositoryAssignees')return respond(route,ListRepositoryAssigneesResponseSchema,{assignees:[user],canEditAssignees:canEditLabels});
  if(method==='UpdateIssue'){
   const input=request(route,UpdateIssueRequestSchema);state.updates.push(input);
   state.issue=create(IssueSchema,{...state.issue,revision:'b'.repeat(64),metadata:{...state.issue.metadata!,labels:labels.filter(l=>input.labels?.labelIds.includes(l.id))}});
   return respond(route,UpdateIssueResponseSchema,{mutation:create(IssueMutationSchema,{id:'901',idempotencyKey:input.idempotencyKey,repository:key,repositoryId:'11',kind:IssueMutationKind.UPDATE_ISSUE,state:IssueMutationState.SUCCEEDED,issueId:'101',number:12}),issue:state.issue});
  }
  return reject(route,'unimplemented','Fixture procedure not supplied.');
 });
 await page.route('**/native/**',async route=>{
  const path=new URL(route.request().url()).pathname,body=route.request().postDataJSON() as Record<string,unknown>;
  const json=(value:unknown,status=200)=>route.fulfill({status,contentType:'application/json',body:JSON.stringify(value)});
  if(path==='/native/ai/read'&&body.action==='list'){
   expect(body).toMatchObject({kind:'triage',target:{number:12},repository:key,repositoryId:'11'});
   // A requested run settles on the second list read after it was created.
   if(state.settleAfter&&--state.settleAfter===0)state.runs=[run({id:state.runs[0]!.id}),...state.runs.slice(1)];
   return json({runs:state.runs.map(({stale:_,...r})=>r),truncated:false});
  }
  if(path==='/native/ai/read'&&body.action==='status'){const found=state.runs.find(r=>r.id===body.runId)!;return json({run:{...found,stale}});}
  if(path==='/native/ai'&&body.action==='create'){
   state.created.push(body);
   if(createError)return json({code:'failed_precondition',message:createError},412);
   const queued=run({id:'0f8fad5b-d9cb-469f-a165-70867728950e',state:'REQUESTED',output:undefined});state.runs=[queued,...state.runs];state.settleAfter=2;return json({run:queued});
  }
  return json({code:'unimplemented',message:'Fixture route not supplied.'},501);
 });
 return state;
}
const card=(page:Page)=>page.getByRole('region',{name:'Clef label suggestions'});
async function open(page:Page){await page.goto('/alex/project/issues/12');await expect(page.locator('#issue-detail-title')).toContainText('Crash when the config file is empty');}

test('a current suggestion shows ranked labels with probabilities, the model, what Clef read and the advisory footer',async({page})=>{
 await backend(page);await open(page);
 await expect(card(page)).toContainText('Clef suggests bug, performance');
 await expect(card(page).getByRole('list',{name:"Clef's probability for each suggested label"}).getByRole('listitem')).toHaveText(['bug71%','performance16%']);
 await expect(card(page).getByRole('meter',{name:'bug: 71%'})).toHaveAttribute('value','0.71');
 await expect(card(page)).toContainText('Current');await expect(card(page)).toContainText('@cf/cloudflare/clef');
 await expect(card(page)).toContainText('Clef read the title and description only.');
 await expect(card(page)).toContainText("Generated by Workers AI through this installation's private AI Gateway. It can be wrong; nothing is published until you act.");
 await card(page).getByText('All 4 labels Clef weighed').click();
 await expect(card(page).getByRole('list',{name:"Clef's probability for every label and for none"}).getByRole('listitem')).toHaveText(['bug71%','performance16%','enhancement3%','docs2%','None of these8%']);
 await expect(card(page).getByRole('button',{name:'Ask again'})).toBeVisible();
});

test('Suggest labels admits one triage run for the issue, shows Clef reading, then Review and apply opens the labels editor with the suggestions selected',async({page})=>{
 const state=await backend(page,{runs:[]});await open(page);
 await expect(card(page)).toContainText('Clef has not been asked about this issue.');
 await card(page).getByRole('button',{name:'Suggest labels'}).click();
 expect(state.created).toHaveLength(1);
 expect(Object.keys(state.created[0]!).sort()).toEqual(['action','idempotencyKey','kind','repository','repositoryId','target']);
 expect(state.created[0]).toMatchObject({action:'create',kind:'triage',target:{number:12},repository:key,repositoryId:'11'});
 await expect(card(page).getByRole('button',{name:'Clef is reading…'})).toBeDisabled();
 await expect(card(page)).toContainText('Clef is reading the title and description…');
 await expect(card(page)).toContainText('Clef suggests bug, performance',{timeout:10_000});
 expect(state.updates).toHaveLength(0);
 await card(page).getByRole('button',{name:'Review and apply'}).click();
 const editor=page.getByRole('region',{name:'Edit issue labels',exact:true});
 await expect(editor.getByRole('checkbox',{name:'bug',exact:true})).toBeChecked();
 await expect(editor.getByRole('checkbox',{name:'performance',exact:true})).toBeChecked();
 await expect(editor.getByRole('checkbox',{name:'docs',exact:true})).not.toBeChecked();
 await expect(editor.getByText('Suggested by Clef')).toHaveCount(2);
 await expect(editor).toContainText('Clef’s suggestions are selected; review them before saving. Nothing changes until you save.');
 // The person decides: drop one suggestion, then save through the ordinary label contract.
 await editor.getByRole('checkbox',{name:'performance',exact:true}).uncheck();
 expect(state.updates).toHaveLength(0);
 await editor.getByRole('button',{name:'Save changes',exact:true}).click();
 await expect(editor).toHaveCount(0);
 expect(state.updates).toHaveLength(1);expect(state.updates[0]!.labels).toMatchObject({expectedLabelIds:['6'],labelIds:['3']});
});

test('an out-of-date suggestion is flagged and says why',async({page})=>{
 await backend(page,{stale:true});await open(page);
 await expect(card(page)).toContainText('Out of date');
 await expect(card(page)).toContainText('The issue or the repository’s labels changed after Clef read them; ask again for a current suggestion.');
});

test('none fitting, an unknown latest outcome and a refusal are stated, never shown as suggestions',async({page})=>{
 const none={...output,choice:'none',none:0.81,suggestions:[]};
 await backend(page,{runs:[run({id:'3f333df6-90a4-4fda-8dd3-9485d27cee36',state:'UNKNOWN',output:undefined}),run({output:none})]});await open(page);
 await expect(card(page)).toContainText('Clef found no label that fits well');
 await expect(card(page)).toContainText('No label reached 15%; Clef put 81% on none of the 4 labels fitting.');
 await expect(card(page)).toContainText('The latest request’s outcome is unknown: no suggestion was stored. The suggestion above is from an earlier request.');
 await expect(card(page).getByRole('button',{name:'Review and apply'})).toHaveCount(0);
});
test('a refused run names its reason',async({page})=>{
 await backend(page,{runs:[run({state:'REFUSED',output:undefined,refusal:'Clef can choose among at most 20 labels; this repository has 23 (archived labels are not counted).'})]});await open(page);
 await expect(card(page)).toContainText('The latest request was refused: Clef can choose among at most 20 labels; this repository has 23 (archived labels are not counted).');
});
test('the server’s 20-label limit at admission is shown as an error',async({page})=>{
 await backend(page,{runs:[],createError:'Clef can choose among at most 20 labels; this repository has 21 (archived labels are not counted).'});await open(page);
 await card(page).getByRole('button',{name:'Suggest labels'}).click();
 await expect(card(page).getByRole('alert')).toHaveText('Clef can choose among at most 20 labels; this repository has 21 (archived labels are not counted).');
});
test('people who cannot edit labels, and installations without the capability, see no suggestions',async({page})=>{
 await backend(page,{canEditLabels:false});await open(page);
 await expect(page.getByRole('region',{name:'Labels'})).toBeVisible();await expect(card(page)).toHaveCount(0);
});
test('no capability, no card',async({page})=>{
 await backend(page,{capability:false});await open(page);
 await expect(page.getByRole('region',{name:'Labels'})).toBeVisible();await expect(card(page)).toHaveCount(0);
});
test('a feature policy that turned suggestions off keeps the stored one and removes the request',async({page})=>{
 await backend(page,{policyOff:true});await open(page);
 await expect(card(page)).toContainText('AI label suggestions are turned off for this repository by the repository policy. Stored suggestions stay readable.');
 await expect(card(page).getByRole('button',{name:'Ask again'})).toHaveCount(0);await expect(card(page).getByRole('button',{name:'Review and apply'})).toBeVisible();
});

test.describe('screenshots',()=>{
 test.skip(!shots,'Set GOLF_AI_SHOTS to a directory to capture the suggestions.');
 for(const [appearance,layout,theme] of [['flare','console','dark'],['classic','primer','light'],['golf','tiles','light']] as const)
  for(const [width,height] of [[1440,900],[390,844]] as const)
   test(`suggestions in ${appearance} ${layout} ${theme} at ${width}px`,async({page})=>{
    await page.addInitScript(([a,l,t])=>{localStorage.setItem('golf.appearance',a!);localStorage.setItem(`golf.layout.${a}`,l!);localStorage.setItem('golf.theme',t!);},[appearance,layout,theme]);
    await page.setViewportSize({width,height});await backend(page);await open(page);await expect(card(page)).toContainText('Clef suggests');await expect(card(page)).toContainText('Current');
    await card(page).scrollIntoViewIfNeeded();
    await page.screenshot({path:`${shots}/suggestions-${appearance}-${layout}-${theme}-${width}.png`});await card(page).screenshot({path:`${shots}/suggestions-${appearance}-${layout}-${theme}-${width}-card.png`});
    await card(page).getByRole('button',{name:'Review and apply'}).click();
    const editor=page.getByRole('region',{name:'Edit issue labels',exact:true});await expect(editor.getByText('Suggested by Clef').first()).toBeVisible();
    await editor.scrollIntoViewIfNeeded();await editor.screenshot({path:`${shots}/apply-${appearance}-${layout}-${theme}-${width}-editor.png`});
   });
});
