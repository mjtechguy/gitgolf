import {expect,test,type Page,type Route} from '@playwright/test';
import {respond,request,reject,disabledAgentTasks} from './rpc';
import {GetSessionResponseSchema,GetRepositoryResponseSchema,ListRepositoriesResponseSchema,ListCapabilitiesResponseSchema,GetWorkflowRunRequestSchema,GetWorkflowRunResponseSchema,GetWorkflowRunLogsRequestSchema,GetWorkflowRunLogsResponseSchema,WorkflowOutputState,WorkflowRunState,WorkflowRunOrigin,WorkflowStepState} from '../src/gen/golf/v1/golf_pb';

const runId='12345678-1234-4234-8234-123456789abc',commit='a'.repeat(40),attempt='d'.repeat(32),catalog='golf.workflow.act.v0.2.89.linux.v1',engineCommit='4f411281417e88660bea1c1a1749aa71ae0bd60f';
const build='1'.repeat(32),test22='2'.repeat(32),test24='3'.repeat(32),skip='4'.repeat(32),image='alpine:3.23@sha256:'+'5'.repeat(64),path=`/alex/demo/actions/runs/${runId}`;
const started='2026-10-04T00:01:00Z',finished='2026-10-04T00:01:10Z';
async function fixture(page:Page){
 const state={publication:'' as ''|'withheld'|'redacted',rawWithheld:false,reads:0,deny:false,logDeny:false,logError:'' as ''|'permission_denied'|'not_found'|'unauthenticated',runBarrier:undefined as Promise<void>|undefined,badGraph:'',badReceipt:'',unrecorded:false,startSecond:false,complete:false,logBarrier:undefined as Promise<void>|undefined,filters:[] as {jobInstanceId:string;stepId:string;stepIndex:number|undefined;after:string}[]};
 const run=()=>{
  const steps=(pending=false)=>[{id:'0',name:'Inspect source',state:pending?WorkflowStepState.PENDING:WorkflowStepState.SUCCEEDED,startedAt:pending?undefined:started,finishedAt:pending?undefined:finished},{id:'verify-code',name:'Verify source',state:pending?WorkflowStepState.PENDING:state.complete?WorkflowStepState.SUCCEEDED:WorkflowStepState.RUNNING,startedAt:pending?undefined:finished,finishedAt:state.complete&&!pending?'2026-10-04T00:01:30Z':undefined}];
  const jobs=[{instanceId:build,jobId:'build',name:'Build source',matrix:[],needs:[],state:WorkflowStepState.SUCCEEDED,startedAt:started,finishedAt:finished,eventsRecorded:true,imageDigest:image,steps:[{id:'compile',name:'Compile',state:WorkflowStepState.SUCCEEDED,startedAt:started,finishedAt:finished}]},{instanceId:test22,jobId:'test',name:'Test source',matrix:[{name:'node',valueJson:'"22"'}],needs:['build'],state:state.complete?WorkflowStepState.SUCCEEDED:WorkflowStepState.RUNNING,startedAt:finished,finishedAt:state.complete?'2026-10-04T00:01:30Z':undefined,eventsRecorded:true,imageDigest:image,steps:steps()},{instanceId:test24,jobId:'test',name:'Test source',matrix:[{name:'node',valueJson:'"24"'}],needs:['build'],state:state.startSecond?WorkflowStepState.RUNNING:WorkflowStepState.PENDING,startedAt:state.startSecond?started:undefined,eventsRecorded:state.startSecond,imageDigest:image,steps:steps(!state.startSecond)},{instanceId:skip,jobId:'optional',name:'Optional check',matrix:[],needs:['build'],state:WorkflowStepState.SKIPPED,finishedAt:finished,eventsRecorded:true,imageDigest:image,steps:[{id:'optional',name:'Optional source check',state:WorkflowStepState.SKIPPED,startedAt:undefined,finishedAt:undefined}]}];
  if(state.unrecorded)for(const job of jobs){job.state=WorkflowStepState.UNRECORDED;job.eventsRecorded=false;job.startedAt=undefined;job.finishedAt=undefined;for(const step of job.steps){step.state=WorkflowStepState.UNRECORDED;step.startedAt=undefined;step.finishedAt=undefined;}}
  if(state.badGraph==='duplicate')jobs[2]!.instanceId=test22;
  if(state.badGraph==='invalid-step')jobs[1]!.steps[0]!.id='not/a/step';
  if(state.badGraph==='duplicate-step')jobs[1]!.steps[1]!.id='0';
  if(state.badGraph==='matrix')jobs[1]!.matrix[0]!.valueJson='not-json';
  if(state.badGraph==='needs')jobs[1]!.needs=['missing'];
  if(state.badGraph==='image')jobs[1]!.imageDigest='alpine:latest';
  if(state.badGraph==='state')jobs[1]!.state=999 as WorkflowStepState;
  if(state.publication==='redacted')for(const job of jobs){if(job.state!==WorkflowStepState.SKIPPED){job.state=WorkflowStepState.SUCCEEDED;job.startedAt=started;job.finishedAt=finished;for(const step of job.steps){step.state=WorkflowStepState.SUCCEEDED;step.startedAt=started;step.finishedAt=finished;}}}
  return {outputState:state.publication==='withheld'?WorkflowOutputState.WITHHELD:state.publication==='redacted'?WorkflowOutputState.REDACTED:WorkflowOutputState.UNSPECIFIED,executionBindingId:state.publication?'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa':'',executionBindingVersion:state.publication?'3':'',id:runId,repositoryId:'11',ownerId:'42',version:'9',workflowPath:'.github/workflows/graph.yml',workflowBlobId:'b'.repeat(40),sourceSha256:'c'.repeat(64),commitId:commit,attemptId:state.badGraph==='attempt'?'wrong':attempt,engineCatalog:state.badGraph==='catalog'?'unqualified.engine':catalog,engineCommit:state.badGraph==='pin'?'6'.repeat(40):engineCommit,createdAt:'2026-10-04T00:00:00Z',startedAt:started,state:state.publication==='redacted'?WorkflowRunState.SUCCEEDED:state.unrecorded?WorkflowRunState.FAILED:WorkflowRunState.RUNNING,origin:WorkflowRunOrigin.MANUAL,runnerId:'owned-source-fixture',canCancel:false,jobs};
 };
 await page.route('**/rpc/**',async(route:Route)=>{
  const method=new URL(route.request().url()).pathname.split('/').at(-1)!;
  if(method==='GetSession')return respond(route,GetSessionResponseSchema,{user:{id:'42',login:'alex'}});
  if(method==='ListCapabilities')return respond(route,ListCapabilitiesResponseSchema,{});
  if(method==='ListRepositories')return respond(route,ListRepositoriesResponseSchema,{});
  if(method==='GetRepository')return respond(route,GetRepositoryResponseSchema,{repository:{id:'11',name:'demo',fullName:'alex/demo',defaultBranch:'main',private:true}});
  if(method==='ListAgentTasks')return disabledAgentTasks(route);
  if(method==='WatchRepository')return reject(route,'unimplemented','No stream in this source fixture.');
  if(method==='GetWorkflowRun'){
   state.reads++;expect(request(route,GetWorkflowRunRequestSchema).runId).toBe(runId);
   const snapshot=run(),denied=state.deny;if(state.runBarrier)await state.runBarrier;
   if(denied)return reject(route,'permission_denied','Run access removed.');
   return respond(route,GetWorkflowRunResponseSchema,{run:snapshot});
  }
  if(method==='GetWorkflowRunLogs'){
   const input=request(route,GetWorkflowRunLogsRequestSchema);expect(input.runId).toBe(runId);
   state.filters.push({jobInstanceId:input.jobInstanceId,stepId:input.stepId,stepIndex:input.stepIndex,after:input.afterSequence.toString()});
   if(state.logBarrier)await state.logBarrier;
   if(state.logError)return reject(route,state.logError,'Job log unavailable.');
   if(state.logDeny)return reject(route,'permission_denied','Job log access removed.');
   const receipt={outputState:state.publication==='withheld'?WorkflowOutputState.WITHHELD:state.publication==='redacted'?WorkflowOutputState.REDACTED:WorkflowOutputState.UNSPECIFIED,runId,attemptId:attempt,repositoryId:'11',sourceCommitId:commit,jobInstanceId:input.jobInstanceId,stepId:input.stepId};
   if(state.badReceipt==='run')receipt.runId='87654321-1234-4234-8234-123456789abc';
   if(state.badReceipt==='attempt')receipt.attemptId='e'.repeat(32);
   if(state.badReceipt==='repository')receipt.repositoryId='12';
   if(state.badReceipt==='source')receipt.sourceCommitId='f'.repeat(40);
   if(state.badReceipt==='job')receipt.jobInstanceId=test24;
   if(state.badReceipt==='step')receipt.stepId='wrong-step';
   if(state.publication==='withheld')return respond(route,GetWorkflowRunLogsResponseSchema,{...receipt,logs:state.rawWithheld?[{sequence:1n,text:'forbidden-private-output'}]:[],hasMore:false});
   const scope=input.jobInstanceId===test22?'Node22':input.jobInstanceId===test24?'Node24':input.jobInstanceId===build?'Build':'All jobs';
   const text=`${scope} ${input.stepId||'job output'}\n`;
   // A global log sequence may have gaps when filtered by exact attribution.
   const sequence=input.afterSequence===0n?7n:29n;
   return respond(route,GetWorkflowRunLogsResponseSchema,{...receipt,logs:[{sequence,text}],hasMore:input.jobInstanceId===test22&&input.stepId==='0'&&input.afterSequence===0n});
  }
  return reject(route,'not_found','Unavailable graph fixture.');
 });return state;
}

test('matrix jobs use immutable scoped links and filtered logs survive reload without conflating equal step IDs',async({page})=>{
 const state=await fixture(page);await page.goto(path);
 await expect(page.getByLabel('Jobs and steps')).toContainText('node: 22');await expect(page.getByLabel('Jobs and steps')).toContainText('node: 24');
 await page.getByRole('link',{name:'running Test source node: 22 · In progress',exact:true}).click();
 await expect(page).toHaveURL(new RegExp(`jobInstanceId=${test22}`));await expect(page.getByLabel('Workflow run log',{exact:true})).toHaveText('Node22 job output');
 await page.getByRole('link',{name:'succeeded Inspect source 10s',exact:true}).click();
 await expect(page).toHaveURL(/stepId=0/);await expect(page.getByLabel('Workflow run log',{exact:true})).toContainText('Node22 0');
 await page.getByRole('button',{name:'Load more log output'}).click();expect(state.filters.at(-1)).toEqual({jobInstanceId:test22,stepId:'0',stepIndex:undefined,after:'7'});
 await page.reload();await expect(page.getByRole('link',{name:'succeeded Inspect source 10s',exact:true})).toHaveAttribute('aria-current','page');
 await expect(page.getByLabel('Workflow run log',{exact:true})).toHaveText('Node22 0');
 const download=page.waitForEvent('download');await page.getByRole('button',{name:'Download loaded log'}).click();expect((await download).suggestedFilename()).toBe(`golf-run-${runId}-job-${test22}-step-0-loaded.log`);
 state.startSecond=true;await page.getByRole('button',{name:'Refresh selected run',exact:true}).click();
 await page.getByRole('link',{name:'running Test source node: 24 · In progress',exact:true}).click();await page.getByRole('link',{name:'succeeded Inspect source 10s',exact:true}).click();
 await expect(page.getByLabel('Workflow run log',{exact:true})).toHaveText('Node24 0');expect(state.filters.at(-1)?.jobInstanceId).toBe(test24);
 await page.getByRole('link',{name:'All run output',exact:true}).click();await expect(page).not.toHaveURL(/jobInstanceId=|stepId=/);
 await expect(page.getByLabel('Workflow run log',{exact:true})).toHaveText('All jobs job output');
});

test('pending and unrecorded jobs never imply starts or request scoped logs',async({page})=>{
 const state=await fixture(page);await page.goto(path+`?jobInstanceId=${test24}&stepId=0`);
 await expect(page.getByRole('status').filter({hasText:'has no recorded start or output'})).toBeVisible();expect(state.filters).toEqual([]);
 state.startSecond=true;await page.getByRole('button',{name:'Refresh selected run',exact:true}).click();
 await expect(page.getByLabel('Workflow run log',{exact:true})).toHaveText('Node24 0');
 state.unrecorded=true;await page.getByRole('button',{name:'Refresh selected run',exact:true}).click();
 await expect(page.getByLabel('Jobs and steps')).toContainText('unrecorded');await expect(page.getByLabel('Workflow run log',{exact:true})).toHaveCount(0);
});

for(const bad of ['catalog','pin','attempt','duplicate','invalid-step','duplicate-step','matrix','needs','image','state'])test(`invalid ${bad} graph is refused before log reads`,async({page})=>{
 const state=await fixture(page);state.badGraph=bad;await page.goto(path);
 await expect(page.getByRole('alert')).toContainText('recorded job graph');expect(state.filters).toEqual([]);await expect(page.getByLabel('Jobs and steps')).toHaveCount(0);
});
for(const bad of ['run','attempt','repository','source','job','step'])test(`mismatched ${bad} log receipt removes private output`,async({page})=>{
 const state=await fixture(page);state.badReceipt=bad;await page.goto(path+`?jobInstanceId=${test22}&stepId=0`);
 await expect(page.getByRole('alert')).toContainText('log receipt does not match');await expect(page.getByLabel('Workflow run log',{exact:true})).toHaveCount(0);await expect(page.getByLabel('Jobs and steps')).toBeVisible();
});

test('unknown but syntactically valid job or step does not broaden to all logs',async({page})=>{
 const state=await fixture(page);await page.goto(path+`?jobInstanceId=${'7'.repeat(32)}`);
 await expect(page.getByRole('alert')).toContainText('does not belong');expect(state.filters).toEqual([]);
 await page.goto(path+`?jobInstanceId=${test22}&stepId=nonexistent`);
 await expect(page.getByRole('alert')).toContainText('does not belong');expect(state.filters).toEqual([]);
});

for(const query of [`stepId=0`,`jobInstanceId=bad`,`jobInstanceId=${test22}&stepId=bad%2Fstep`,`jobInstanceId=${test22}&step=0`,`jobInstanceId=${test22}&stepId=01`,`jobInstanceId=${test22}&stepId=1000`,`jobInstanceId=${test22}&jobInstanceId=${test24}`,`jobInstanceId=${test22}&stepId=0&stepId=verify-code`])test(`invalid graph route ${query} reads no run or logs`,async({page})=>{
 const state=await fixture(page);await page.goto(path+'?'+query);await expect(page.getByRole('heading',{name:'Page not found',exact:true})).toBeVisible();expect(state.reads).toBe(0);expect(state.filters).toEqual([]);
});

test('typed graph selectors are rejected on task, review, source and unbound legacy pages',async({page})=>{
 const state=await fixture(page);
 for(const target of [`/alex/demo/actions/tasks/${runId}`,`/alex/demo/actions/reviews/${runId}`,`/alex/demo/tree/${commit}`,'/alex/demo','/repositories/alex/demo']){await page.goto(target+`?jobInstanceId=${test22}`);await expect(page.getByRole('heading',{name:'Page not found',exact:true})).toBeVisible();}
 expect(state.reads).toBe(0);expect(state.filters).toEqual([]);
});

test('late log responses after navigation and access loss never revive prior private output',async({page})=>{
 const state=await fixture(page);let release!:()=>void;state.logBarrier=new Promise(resolve=>{release=resolve});await page.goto(path+`?jobInstanceId=${test22}&stepId=0`);
 await expect.poll(()=>state.filters.length).toBeGreaterThanOrEqual(1);await page.goto(path+`?jobInstanceId=${test24}`);release();
 await expect(page.getByRole('status').filter({hasText:'has no recorded start or output'})).toBeVisible();await expect(page.getByLabel('Workflow run log',{exact:true})).toHaveCount(0);
 state.logBarrier=undefined;await page.goto(path+`?jobInstanceId=${test22}&stepId=0`);await expect(page.getByLabel('Workflow run log',{exact:true})).toContainText('Node22');
 state.deny=true;await page.getByRole('button',{name:'Refresh selected run',exact:true}).click();
 await expect(page.getByRole('alert')).toHaveText('Run access removed.');await expect(page.getByLabel('Jobs and steps')).toHaveCount(0);await expect(page.getByLabel('Workflow run log',{exact:true})).toHaveCount(0);
 expect(await page.evaluate(()=>JSON.stringify({...localStorage,...sessionStorage}))).not.toContain('Node22');
});

for(const theme of ['dark','light'])for(const width of [390,1440])test(`graph selection ${theme}/${width} stays compact, contained and keyboard reachable`,async({page},testInfo)=>{
 await fixture(page);await page.setViewportSize({width,height:900});await page.addInitScript(theme=>localStorage.setItem('golf.theme',theme),theme);
 await page.goto(path+`?jobInstanceId=${test22}&stepId=0`);await expect(page.getByLabel('Workflow run log',{exact:true})).toContainText('Node22');
 await expect(page.locator('html')).toHaveAttribute('data-theme',theme);
 await page.screenshot({path:testInfo.outputPath(`job-graph-${theme}-${width}-initial.png`),fullPage:true});
 if(width===390){const box=await page.getByLabel('Workflow run log',{exact:true}).boundingBox();expect(box!.y).toBeLessThan(700);}
 const disclosure=page.locator('.workflow-jobs-disclosure');if(width===390){await expect(disclosure).not.toHaveAttribute('open','');await disclosure.locator('summary').focus();await page.keyboard.press('Enter');}
 await expect(page.getByRole('link',{name:'succeeded Inspect source 10s',exact:true})).toBeVisible();
 await page.getByRole('link',{name:'running Verify source In progress',exact:true}).click();await expect(page).toHaveURL(/stepId=verify-code/);
 await expect(page.getByLabel('Workflow run log',{exact:true})).toHaveText('Node22 verify-code');
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
 await page.screenshot({path:testInfo.outputPath(`job-graph-${theme}-${width}.png`),fullPage:true});
});


test('legacy graph aliases retain exact typed scope and return canonical links',async({page})=>{
 const state=await fixture(page);await page.goto(`/repositories/alex/demo?view=actions&run=${runId}&jobInstanceId=${test22}&stepId=0`);
 await expect(page.getByLabel('Workflow run log',{exact:true})).toContainText('Node22 0');
 await page.getByRole('link',{name:'running Verify source In progress',exact:true}).click();
 await expect(page).toHaveURL(new RegExp(`/alex/demo/actions/runs/${runId}\\?`));
 await expect(page).toHaveURL(/stepId=verify-code/);expect(state.filters.at(-1)?.jobInstanceId).toBe(test22);
});


for(const code of ['permission_denied','not_found'] as const)test(`log ${code} clears bound job metadata and cancels a late parent revalidation without automatic retry`,async({page})=>{
 const state=await fixture(page);await page.goto(path+`?jobInstanceId=${test22}&stepId=0`);await expect(page.getByLabel('Workflow run log',{exact:true})).toContainText('Node22');
 let releaseLogs!:()=>void,releaseRun!:()=>void;state.logBarrier=new Promise(resolve=>{releaseLogs=resolve});
 await page.getByRole('button',{name:'Load more log output',exact:true}).click();await expect.poll(()=>state.filters.some(filter=>filter.after==='7')).toBe(true);
 state.runBarrier=new Promise(resolve=>{releaseRun=resolve});const previous=state.reads;await page.getByRole('button',{name:'Refresh selected run',exact:true}).click();await expect.poll(()=>state.reads).toBeGreaterThan(previous);
 state.logError=code;releaseLogs();await expect(page.getByRole('alert')).toHaveText('Job log unavailable.');
 await expect(page.getByLabel('Jobs and steps')).toHaveCount(0);await expect(page.getByLabel('Workflow run log',{exact:true})).toHaveCount(0);
 const observedReads=state.reads;releaseRun();await expect(page.getByRole('alert')).toHaveText('Job log unavailable.');
 await expect(page.getByRole('heading',{name:'.github/workflows/graph.yml',exact:true})).toHaveCount(0);expect(state.reads).toBe(observedReads);
 expect(await page.evaluate(()=>JSON.stringify({...localStorage,...sessionStorage}))).not.toContain('Node22');
});

test('unauthenticated log read ends the managed session and clears the entire private run',async({page})=>{
 const state=await fixture(page);await page.goto(path+`?jobInstanceId=${test22}&stepId=0`);await expect(page.getByLabel('Workflow run log',{exact:true})).toContainText('Node22');
 state.logError='unauthenticated';await page.getByRole('button',{name:'Refresh run log',exact:true}).click();
 await expect(page.getByRole('form',{name:'Golf account sign-in',exact:true})).toBeVisible();
 await expect(page.getByLabel('Jobs and steps')).toHaveCount(0);await expect(page.getByLabel('Workflow run log',{exact:true})).toHaveCount(0);
});


test('withheld execution output is explicit and cannot be downloaded as an empty successful log',async({page})=>{
 const state=await fixture(page);state.publication='withheld';await page.goto(path);
 await expect(page.getByText('Output is withheld pending a verified execution result and current authorization.',{exact:true})).toBeVisible();
 await expect(page.getByLabel('Workflow run log',{exact:true})).toHaveCount(0);await expect(page.getByRole('button',{name:'Download loaded log',exact:true})).toBeDisabled();
 await expect(page.getByText('No log output yet.',{exact:true})).toHaveCount(0);
 state.publication='redacted';await page.getByRole('button',{name:'Refresh selected run',exact:true}).click();
 await expect(page.getByText('Configured secret values were masked before this log was published.',{exact:true})).toBeVisible();await expect(page.getByLabel('Workflow run log',{exact:true})).toContainText('All jobs');
});

test('a malformed withheld receipt never renders or downloads private bytes',async({page})=>{
 const state=await fixture(page);state.publication='withheld';state.rawWithheld=true;await page.goto(path);
 await expect(page.getByRole('alert')).toContainText('Withheld execution output cannot contain readable chunks');await expect(page.locator('body')).not.toContainText('forbidden-private-output');await expect(page.getByRole('button',{name:'Download loaded log',exact:true})).toBeDisabled();
});
