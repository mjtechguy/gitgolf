import { portableRuntimeFixture } from './runtime-fixture';
import {expect,test,type Locator,type Page,type Route} from '@playwright/test';

// Read xterm's own screen-reader rows, excluding only blank viewport padding.
async function terminalText(log:Locator){
 const rows=await log.locator('.xterm-accessibility-tree [role="listitem"]').allTextContents();
 return rows.map(row=>row.replaceAll('\u00a0',' ').trimEnd()).join('\n').trim();
}
import {respond,request,reject,disabledAgentTasks} from './rpc';
import {GetSessionResponseSchema,GetRepositoryResponseSchema,ListRepositoriesResponseSchema,ListCapabilitiesResponseSchema,GetWorkflowRunRequestSchema,GetWorkflowRunResponseSchema,GetWorkflowRunLogsRequestSchema,GetWorkflowRunLogsResponseSchema,WorkflowOutputState,WorkflowRunState,WorkflowRunOrigin,WorkflowStepState,ActionRunKind,ListActionRunsRequestSchema,ListActionRunsResponseSchema,InspectWorkflowsResponseSchema} from '../src/gen/golf/v1/golf_pb';

const runId='12345678-1234-4234-8234-123456789abc',commit='a'.repeat(40),attempt='d'.repeat(32),catalog='golf.workflow.act.v0.2.89.linux.v1',engineCommit='4f411281417e88660bea1c1a1749aa71ae0bd60f';
const build='1'.repeat(32),test22='2'.repeat(32),test24='3'.repeat(32),skip='4'.repeat(32),image='alpine:3.23@sha256:'+'5'.repeat(64),path=`/alex/demo/actions/runs/${runId}`;
const started='2026-10-04T00:01:00Z',finished='2026-10-04T00:01:10Z';
async function fixture(page:Page){
 const state={methods:[] as string[],inventories:[] as {repositoryId:string;kindFilter:ActionRunKind;workflowPath:string}[],twoJobs:false,dependencySkipped:false,typed:false,typedFault:'',publication:'' as ''|'withheld'|'redacted',rawWithheld:false,reads:0,deny:false,logDeny:false,logError:'' as ''|'permission_denied'|'not_found'|'unauthenticated',runBarrier:undefined as Promise<void>|undefined,badGraph:'',badReceipt:'',unrecorded:false,startSecond:false,complete:false,logBarrier:undefined as Promise<void>|undefined,continuationBarrier:undefined as Promise<void>|undefined,filters:[] as {jobInstanceId:string;stepId:string;stepIndex:number|undefined;after:string}[]};
 const run=()=>{
  const steps=(pending=false)=>[{id:'0',name:'Inspect source',state:pending?WorkflowStepState.PENDING:WorkflowStepState.SUCCEEDED,startedAt:pending?undefined:started,finishedAt:pending?undefined:finished},{id:'verify-code',name:'Verify source',state:pending?WorkflowStepState.PENDING:state.complete?WorkflowStepState.SUCCEEDED:WorkflowStepState.RUNNING,startedAt:pending?undefined:finished,finishedAt:state.complete&&!pending?'2026-10-04T00:01:30Z':undefined}];
  const jobs=[{instanceId:build,jobId:'build',name:'Build source',matrix:[],needs:[],state:WorkflowStepState.SUCCEEDED,startedAt:started,finishedAt:finished,eventsRecorded:true,imageDigest:image,steps:[{id:'compile',name:'Compile',state:WorkflowStepState.SUCCEEDED,startedAt:started,finishedAt:finished}]},{instanceId:test22,jobId:'test',name:'Test source',matrix:[{name:'node',valueJson:'"22"'}],needs:['build'],state:state.complete?WorkflowStepState.SUCCEEDED:WorkflowStepState.RUNNING,startedAt:finished,finishedAt:state.complete?'2026-10-04T00:01:30Z':undefined,eventsRecorded:true,imageDigest:image,steps:steps()},{instanceId:test24,jobId:'test',name:'Test source',matrix:[{name:'node',valueJson:'"24"'}],needs:['build'],state:state.startSecond?WorkflowStepState.RUNNING:WorkflowStepState.PENDING,startedAt:state.startSecond?started:undefined,eventsRecorded:state.startSecond,imageDigest:image,steps:steps(!state.startSecond)},{instanceId:skip,jobId:'optional',name:'Optional check',matrix:[],needs:['build'],state:WorkflowStepState.SKIPPED,finishedAt:finished,eventsRecorded:true,imageDigest:image,steps:[{id:'optional',name:'Optional source check',state:WorkflowStepState.SKIPPED,startedAt:undefined,finishedAt:undefined}]}];
  if(state.twoJobs){
   jobs.splice(2);jobs[0]!.steps=[{id:'0',name:'Inspect source',state:WorkflowStepState.SUCCEEDED,startedAt:started,finishedAt:finished}];
   const second=jobs[1]!;second.jobId='verify';second.name='Verify job';second.matrix=[];second.state=state.startSecond?state.complete?WorkflowStepState.SUCCEEDED:WorkflowStepState.RUNNING:WorkflowStepState.PENDING;second.startedAt=state.startSecond?finished:undefined;second.finishedAt=state.complete&&state.startSecond?'2026-10-04T00:01:30Z':undefined;second.eventsRecorded=state.startSecond;second.steps=steps(!state.startSecond);if(state.startSecond){second.steps[0]!.startedAt=finished;second.steps[0]!.finishedAt='2026-10-04T00:01:20Z';second.steps[1]!.startedAt='2026-10-04T00:01:20Z';}
   if(state.dependencySkipped){jobs[0]!.state=WorkflowStepState.FAILED;jobs[0]!.steps[0]!.state=WorkflowStepState.FAILED;second.state=WorkflowStepState.SKIPPED;second.startedAt=undefined;second.finishedAt=finished;second.eventsRecorded=true;for(const step of second.steps){step.state=WorkflowStepState.SKIPPED;step.startedAt=undefined;step.finishedAt=undefined;}}
  }
  if(state.unrecorded)for(const job of jobs){job.state=WorkflowStepState.UNRECORDED;job.eventsRecorded=false;job.startedAt=undefined;job.finishedAt=undefined;for(const step of job.steps){step.state=WorkflowStepState.UNRECORDED;step.startedAt=undefined;step.finishedAt=undefined;}}
  if(state.badGraph==='duplicate')jobs[2]!.instanceId=test22;
  if(state.badGraph==='invalid-step')jobs[1]!.steps[0]!.id='not/a/step';
  if(state.badGraph==='duplicate-step')jobs[1]!.steps[1]!.id='0';
  if(state.badGraph==='matrix')jobs[1]!.matrix[0]!.valueJson='not-json';
  if(state.badGraph==='needs')jobs[1]!.needs=['missing'];
  if(state.badGraph==='image')jobs[1]!.imageDigest='alpine:latest';
  if(state.badGraph==='state')jobs[1]!.state=999 as WorkflowStepState;
  if(state.publication==='redacted')for(const job of jobs){if(job.state!==WorkflowStepState.SKIPPED){job.state=WorkflowStepState.SUCCEEDED;job.startedAt=started;job.finishedAt=finished;for(const step of job.steps){step.state=WorkflowStepState.SUCCEEDED;step.startedAt=started;step.finishedAt=finished;}}}
  return {outputState:state.publication==='withheld'?WorkflowOutputState.WITHHELD:state.publication==='redacted'?WorkflowOutputState.REDACTED:WorkflowOutputState.UNSPECIFIED,executionBindingId:state.publication&&state.typedFault!=='binding'?'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa':'',executionBindingVersion:state.publication&&state.typedFault!=='binding-version'?'3':'',id:runId,repositoryId:'11',ownerId:'42',version:'9',workflowPath:'.github/workflows/graph.yml',workflowBlobId:'b'.repeat(40),sourceSha256:'c'.repeat(64),commitId:commit,attemptId:state.badGraph==='attempt'?'wrong':attempt,engineCatalog:state.badGraph==='catalog'?'unqualified.engine':state.typed?'golf.workflow.act.v0.2.89.linux.v2':catalog,inputContract:state.typed?state.typedFault==='contract'?'':'golf.workflow.dispatch.inputs.v1':'',schemaSha256:state.typed?state.typedFault==='schema'?'invalid':'6'.repeat(64):'',submittedSha256:state.typed?'7'.repeat(64):'',effectiveSha256:state.typed?'8'.repeat(64):'',engineCommit:state.badGraph==='pin'?'6'.repeat(40):engineCommit,createdAt:'2026-10-04T00:00:00Z',startedAt:started,finishedAt:state.publication==='redacted'||state.twoJobs&&state.complete||state.dependencySkipped?'2026-10-04T00:01:30Z':undefined,state:state.dependencySkipped?WorkflowRunState.FAILED:state.twoJobs&&state.complete?WorkflowRunState.SUCCEEDED:state.publication==='redacted'?WorkflowRunState.SUCCEEDED:state.unrecorded?WorkflowRunState.FAILED:WorkflowRunState.RUNNING,origin:state.typedFault==='origin'?WorkflowRunOrigin.PUSH:WorkflowRunOrigin.MANUAL,runnerId:'owned-source-fixture',canCancel:false,jobs};
 };
 await page.route('**/rpc/**',async(route:Route)=>{
  const method=new URL(route.request().url()).pathname.split('/').at(-1)!;state.methods.push(method);
  if(method==='InspectWorkflows')return respond(route,InspectWorkflowsResponseSchema,{repositoryId:'11',commitId:commit,catalogVersion:'fixture'});
  if(method==='ListActionRuns'){const input=request(route,ListActionRunsRequestSchema);state.inventories.push({repositoryId:input.repositoryId,kindFilter:input.kindFilter,workflowPath:input.workflowPath});return respond(route,ListActionRunsResponseSchema,{repositoryId:'11',runs:[{ref:{kind:ActionRunKind.WORKFLOW,id:runId},repositoryId:'11',ownerId:'42',title:'.github/workflows/graph.yml',workflowPath:'.github/workflows/graph.yml',state:'running',commitId:commit,trigger:'workflow_dispatch',createdAt:'2026-10-04T00:00:00Z'}]});}
  if(method==='GetSession')return respond(route,GetSessionResponseSchema,{user:{id:'42',login:'alex'}});
  if(method==='ListCapabilities')return respond(route,ListCapabilitiesResponseSchema, portableRuntimeFixture);
  if(method==='ListRepositories')return respond(route,ListRepositoriesResponseSchema,{});
  if(method==='GetRepository')return respond(route,GetRepositoryResponseSchema,{repository:{id:'11',name:'demo',fullName:'alex/demo',defaultBranch:'main',private:true}});
  if(method==='ListAgentTasks')return disabledAgentTasks(route);
  if(method==='GetRepositoryStar')return reject(route,'unimplemented','Star preferences are outside this graph fixture.');
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
   if(input.afterSequence>0n&&state.continuationBarrier)await state.continuationBarrier;
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
   const scope=input.jobInstanceId===test22?state.twoJobs?'Verify job':'Node22':input.jobInstanceId===test24?'Node24':input.jobInstanceId===build?'Build':'All jobs';
   const text=`${scope} ${input.stepId||'job output'}\n`;
   // A global log sequence may have gaps when filtered by exact attribution.
   const sequence=input.afterSequence===0n?7n:29n;
   return respond(route,GetWorkflowRunLogsResponseSchema,{...receipt,logs:[{sequence,text}],hasMore:input.jobInstanceId===test22&&input.stepId==='0'&&input.afterSequence===0n});
  }
  return reject(route,'unimplemented','Unavailable graph fixture.');
 });return state;
}

test('matrix jobs use immutable scoped links and filtered logs survive reload without conflating equal step IDs',async({page})=>{
 const state=await fixture(page);await page.goto(path);
 await expect(page.getByLabel('Jobs and steps')).toContainText('node: 22');await expect(page.getByLabel('Jobs and steps')).toContainText('node: 24');
 await page.getByRole('link',{name:'running Test source node: 22 · In progress',exact:true}).click();
 await expect(page).toHaveURL(new RegExp(`jobInstanceId=${test22}`));await expect.poll(()=>terminalText(page.getByLabel('Workflow run log',{exact:true}))).toBe('Node22 job output');
 await page.getByRole('link',{name:'succeeded Inspect source 10s',exact:true}).click();
 await expect(page).toHaveURL(/stepId=0/);await expect.poll(()=>terminalText(page.getByLabel('Workflow run log',{exact:true}))).toBe('Node22 0\nNode22 0');
 expect(state.filters.at(-1)).toEqual({jobInstanceId:test22,stepId:'0',stepIndex:undefined,after:'7'});
 await page.reload();await expect(page.getByRole('link',{name:'succeeded Inspect source 10s',exact:true})).toHaveAttribute('aria-current','page');
 await expect.poll(()=>terminalText(page.getByLabel('Workflow run log',{exact:true}))).toBe('Node22 0\nNode22 0');
 const download=page.waitForEvent('download');await page.getByRole('button',{name:'Download loaded log'}).click();expect((await download).suggestedFilename()).toBe(`golf-run-${runId}-job-${test22}-step-0.log`);
 state.startSecond=true;await page.getByRole('button',{name:'Refresh selected run',exact:true}).click();
 await page.getByRole('link',{name:'running Test source node: 24 · In progress',exact:true}).click();await page.getByRole('link',{name:'succeeded Inspect source 10s',exact:true}).click();
 await expect.poll(()=>terminalText(page.getByLabel('Workflow run log',{exact:true}))).toBe('Node24 0');expect(state.filters.at(-1)?.jobInstanceId).toBe(test24);
 await page.getByRole('link',{name:'All run output',exact:true}).click();await expect(page).not.toHaveURL(/jobInstanceId=|stepId=/);
 await expect.poll(()=>terminalText(page.getByLabel('Workflow run log',{exact:true}))).toBe('All jobs job output');
});


for(const workflowPath of ['', '.github/workflows/graph.yml'])test(`workflow drilldown preserves server filter ${workflowPath||'all workflows'} through jobs, reload and return`,async({page})=>{
 const state=await fixture(page),filters=new URLSearchParams({actionKind:'workflow',...(workflowPath?{workflowPath}: {})});
 await page.goto(`/alex/demo/actions?${filters}`);const table=page.getByRole('table',{name:'Action runs',exact:true});
 await expect(table.getByRole('link',{name:'.github/workflows/graph.yml',exact:true})).toBeVisible();
 await table.getByRole('link',{name:'.github/workflows/graph.yml',exact:true}).click();
 const filterIsPreserved=async()=>{const query=new URL(page.url()).searchParams;expect(query.get('actionKind')).toBe('workflow');expect(query.get('workflowPath')||'').toBe(workflowPath);};
 await expect(page.getByRole('link',{name:'All runs',exact:true})).toBeVisible();await filterIsPreserved();
 await page.getByRole('link',{name:'running Test source node: 22 · In progress',exact:true}).click();await expect.poll(()=>terminalText(page.getByLabel('Workflow run log',{exact:true}))).toBe('Node22 job output');await filterIsPreserved();
 await page.getByRole('link',{name:'succeeded Inspect source 10s',exact:true}).click();await expect.poll(()=>terminalText(page.getByLabel('Workflow run log',{exact:true}))).toBe('Node22 0\nNode22 0');await filterIsPreserved();
 await page.reload();await expect(page.getByRole('link',{name:'succeeded Inspect source 10s',exact:true})).toHaveAttribute('aria-current','page');await filterIsPreserved();
 await page.getByRole('link',{name:'All run output',exact:true}).click();await expect.poll(()=>terminalText(page.getByLabel('Workflow run log',{exact:true}))).toBe('All jobs job output');await filterIsPreserved();
 await page.getByRole('link',{name:'All runs',exact:true}).click();await expect(table.getByRole('link',{name:'.github/workflows/graph.yml',exact:true})).toBeVisible();await filterIsPreserved();
 const query=new URL(page.url()).searchParams;for(const name of ['run','runKind','step','jobInstanceId','stepId'])expect(query.has(name)).toBe(false);
 expect(state.inventories.at(-1)).toEqual({repositoryId:'11',kindFilter:ActionRunKind.WORKFLOW,workflowPath});
 expect(state.filters.some(input=>input.jobInstanceId===test22&&input.stepId==='0')).toBe(true);
 expect(state.methods.filter(method=>/Dispatch|Cancel|Save|Set/.test(method))).toEqual([]);
});

test('pending and unrecorded jobs never imply starts or request scoped logs',async({page})=>{
 const state=await fixture(page);await page.goto(path+`?jobInstanceId=${test24}&stepId=0`);
 await expect(page.getByRole('status').filter({hasText:'has no recorded start or output'})).toBeVisible();expect(state.filters).toEqual([]);
 state.startSecond=true;await page.getByRole('button',{name:'Refresh selected run',exact:true}).click();
 await expect.poll(()=>terminalText(page.getByLabel('Workflow run log',{exact:true}))).toBe('Node24 0');
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


for(const bad of ['run','attempt','repository','source','job','step'])test(`mismatched ${bad} automatic continuation removes already loaded private output`,async({page})=>{
 const state=await fixture(page);let release!:()=>void;state.continuationBarrier=new Promise(resolve=>{release=resolve});
 await page.goto(path+`?jobInstanceId=${test22}&stepId=0`);const log=page.getByLabel('Workflow run log',{exact:true});
 await expect.poll(()=>terminalText(log)).toBe('Node22 0');await expect.poll(()=>state.filters.some(filter=>filter.after==='7')).toBe(true);
 state.badReceipt=bad;release();await expect(page.getByRole('alert')).toContainText('log receipt does not match');await expect(log).toHaveCount(0);
 expect(state.filters.every(filter=>filter.jobInstanceId===test22&&filter.stepId==='0'&&filter.stepIndex===undefined&&['0','7'].includes(filter.after))).toBe(true);
 const reads=state.filters.length;await page.waitForTimeout(250);expect(state.filters).toHaveLength(reads);await expect(page.getByLabel('Jobs and steps')).toBeVisible();
 expect(await page.evaluate(()=>JSON.stringify({...localStorage,...sessionStorage}))).not.toContain('Node22');
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
 state.logBarrier=undefined;await page.goto(path+`?jobInstanceId=${test22}&stepId=0`);await expect.poll(()=>terminalText(page.getByLabel('Workflow run log',{exact:true}))).toBe('Node22 0\nNode22 0');
 state.deny=true;await page.getByRole('button',{name:'Refresh selected run',exact:true}).click();
 await expect(page.getByRole('alert')).toHaveText('Run access removed.');await expect(page.getByLabel('Jobs and steps')).toHaveCount(0);await expect(page.getByLabel('Workflow run log',{exact:true})).toHaveCount(0);
 expect(await page.evaluate(()=>JSON.stringify({...localStorage,...sessionStorage}))).not.toContain('Node22');
});

for(const theme of ['dark','light'])for(const width of [390,1440])test(`graph selection ${theme}/${width} stays compact, contained and keyboard reachable`,async({page},testInfo)=>{
 await fixture(page);await page.setViewportSize({width,height:900});await page.addInitScript(theme=>localStorage.setItem('golf.theme',theme),theme);
 await page.goto(path+`?jobInstanceId=${test22}&stepId=0`);await expect.poll(()=>terminalText(page.getByLabel('Workflow run log',{exact:true}))).toBe('Node22 0\nNode22 0');
 await expect(page.locator('html')).toHaveAttribute('data-theme',theme);
 await page.screenshot({path:testInfo.outputPath(`job-graph-${theme}-${width}-initial.png`),fullPage:true});
 if(width===390){const box=await page.getByLabel('Workflow run log',{exact:true}).boundingBox();expect(box!.y).toBeLessThan(700);}
 const disclosure=page.locator('.workflow-jobs-disclosure');if(width===390){await expect(disclosure).not.toHaveAttribute('open','');await disclosure.locator('summary').focus();await page.keyboard.press('Enter');}
 await expect(page.getByRole('link',{name:'succeeded Inspect source 10s',exact:true})).toBeVisible();
 await page.getByRole('link',{name:'running Verify source In progress',exact:true}).click();await expect(page).toHaveURL(/stepId=verify-code/);
 await expect.poll(()=>terminalText(page.getByLabel('Workflow run log',{exact:true}))).toBe('Node22 verify-code');
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
 await page.screenshot({path:testInfo.outputPath(`job-graph-${theme}-${width}.png`),fullPage:true});
});


test('legacy graph aliases retain exact typed scope and return canonical links',async({page})=>{
 const state=await fixture(page);await page.goto(`/repositories/alex/demo?view=actions&run=${runId}&jobInstanceId=${test22}&stepId=0`);
 await expect.poll(()=>terminalText(page.getByLabel('Workflow run log',{exact:true}))).toBe('Node22 0\nNode22 0');
 await page.getByRole('link',{name:'running Verify source In progress',exact:true}).click();
 await expect(page).toHaveURL(new RegExp(`/alex/demo/actions/runs/${runId}\\?`));
 await expect(page).toHaveURL(/stepId=verify-code/);expect(state.filters.at(-1)?.jobInstanceId).toBe(test22);
});


for(const code of ['permission_denied','not_found'] as const)test(`log ${code} clears bound job metadata and cancels a late parent revalidation without automatic retry`,async({page})=>{
 const state=await fixture(page);let releaseLogs!:()=>void,releaseRun!:()=>void;state.continuationBarrier=new Promise(resolve=>{releaseLogs=resolve});
 await page.goto(path+`?jobInstanceId=${test22}&stepId=0`);await expect.poll(()=>terminalText(page.getByLabel('Workflow run log',{exact:true}))).toBe('Node22 0');
 await expect.poll(()=>state.filters.some(filter=>filter.after==='7')).toBe(true);
 state.runBarrier=new Promise(resolve=>{releaseRun=resolve});const previous=state.reads;await page.getByRole('button',{name:'Refresh selected run',exact:true}).click();await expect.poll(()=>state.reads).toBeGreaterThan(previous);
 state.logError=code;releaseLogs();await expect(page.getByRole('alert')).toHaveText('Job log unavailable.');
 await expect(page.getByLabel('Jobs and steps')).toHaveCount(0);await expect(page.getByLabel('Workflow run log',{exact:true})).toHaveCount(0);
 const observedReads=state.reads;releaseRun();await expect(page.getByRole('alert')).toHaveText('Job log unavailable.');
 await expect(page.getByRole('heading',{name:'.github/workflows/graph.yml',exact:true})).toHaveCount(0);expect(state.reads).toBe(observedReads);
 expect(await page.evaluate(()=>JSON.stringify({...localStorage,...sessionStorage}))).not.toContain('Node22');
});

test('unauthenticated log read ends the managed session and clears the entire private run',async({page})=>{
 const state=await fixture(page);await page.goto(path+`?jobInstanceId=${test22}&stepId=0`);await expect.poll(()=>terminalText(page.getByLabel('Workflow run log',{exact:true}))).toBe('Node22 0\nNode22 0');
 state.logError='unauthenticated';await page.getByRole('button',{name:'Refresh run log',exact:true}).click();
 await expect(page.getByRole('form',{name:'Golf account sign-in',exact:true})).toBeVisible();
 await expect(page.getByLabel('Jobs and steps')).toHaveCount(0);await expect(page.getByLabel('Workflow run log',{exact:true})).toHaveCount(0);
});


test('withheld execution output is explicit and cannot be downloaded as an empty successful log',async({page})=>{
 const state=await fixture(page);state.publication='withheld';await page.goto(path);
 await expect(page.getByText('Output is withheld pending a verified execution result and current authorization.',{exact:true})).toBeVisible();
 await expect(page.getByLabel('Workflow run log',{exact:true})).toHaveCount(0);await expect(page.getByRole('button',{name:'Download loaded log',exact:true})).toHaveCount(0);
 await expect(page.getByText('No log output yet.',{exact:true})).toHaveCount(0);
 state.publication='redacted';await page.getByRole('button',{name:'Refresh selected run',exact:true}).click();
 await expect(page.getByText('Configured secret values were masked before this log was published.',{exact:true})).toBeVisible();await expect.poll(()=>terminalText(page.getByLabel('Workflow run log',{exact:true}))).toBe('All jobs job output');
});

test('a malformed withheld receipt never renders or downloads private bytes',async({page})=>{
 const state=await fixture(page);state.publication='withheld';state.rawWithheld=true;await page.goto(path);
 await expect(page.getByRole('alert')).toContainText('Withheld execution output cannot contain readable chunks');await expect(page.locator('body')).not.toContainText('forbidden-private-output');await expect(page.getByRole('button',{name:'Download loaded log',exact:true})).toHaveCount(0);
});

test('two completed nonmatrix jobs keep equal step IDs in separate immutable log scopes',async({page})=>{
 const state=await fixture(page);state.twoJobs=true;state.startSecond=true;state.complete=true;
 await page.goto(path+`?jobInstanceId=${build}&stepId=0`);await expect.poll(()=>terminalText(page.getByLabel('Workflow run log',{exact:true}))).toBe('Build 0');
 await expect(page.getByRole('link',{name:'succeeded Build source build · 10s',exact:true})).toBeVisible();await expect(page.getByRole('link',{name:'succeeded Verify job verify · 20s',exact:true})).toBeVisible();await expect(page.getByLabel('Jobs and steps')).not.toContainText('node:');
 await page.getByRole('link',{name:'succeeded Verify job verify · 20s',exact:true}).click();await page.getByRole('link',{name:'succeeded Inspect source 10s',exact:true}).click();
 await expect(page).toHaveURL(new RegExp(`jobInstanceId=${test22}`));await expect(page).toHaveURL(/stepId=0/);await expect.poll(()=>terminalText(page.getByLabel('Workflow run log',{exact:true}))).toBe('Verify job 0\nVerify job 0');
 await page.reload();await expect.poll(()=>terminalText(page.getByLabel('Workflow run log',{exact:true}))).toBe('Verify job 0\nVerify job 0');await expect(page.getByRole('link',{name:'succeeded Inspect source 10s',exact:true})).toHaveAttribute('aria-current','page');
 await page.getByText('Execution receipt',{exact:true}).click();const receipt=page.getByRole('region',{name:'Run summary',exact:true});await expect(receipt).toContainText(attempt);await expect(receipt).toContainText(catalog);await expect(receipt).toContainText(test22);await expect(receipt).toContainText('build');
 expect(state.filters.some(v=>v.jobInstanceId===build&&v.stepId==='0')).toBe(true);expect(state.filters.some(v=>v.jobInstanceId===test22&&v.stepId==='0')).toBe(true);expect(state.filters.every(v=>[build,test22].includes(v.jobInstanceId)&&v.stepIndex===undefined)).toBe(true);
});

test('recorded failed prerequisite and skipped dependent never synthesize job or step logs',async({page})=>{
 const state=await fixture(page);state.twoJobs=true;state.dependencySkipped=true;
 await page.goto(path+`?jobInstanceId=${test22}`);const notice=page.getByRole('status').filter({hasText:'has no recorded start or output'});await expect(notice).toContainText('This job was skipped.');await expect(notice).toContainText('Declared dependencies: build.');await expect(notice).not.toContainText('because');expect(state.filters).toEqual([]);
 await expect(page.getByRole('link',{name:'failed Build source build · 10s',exact:true})).toBeVisible();await expect(page.getByRole('link',{name:'skipped Verify job verify · skipped',exact:true})).toBeVisible();
 await page.getByRole('link',{name:'skipped Inspect source skipped',exact:true}).click();await expect(notice).toContainText('This step was skipped.');await expect(page.getByLabel('Workflow run log',{exact:true})).toHaveCount(0);expect(state.filters).toEqual([]);
 await page.reload();await expect(notice).toContainText('This step was skipped.');expect(state.filters).toEqual([]);
 await page.getByRole('link',{name:'failed Build source build · 10s',exact:true}).click();await expect.poll(()=>terminalText(page.getByLabel('Workflow run log',{exact:true}))).toBe('Build job output');expect(state.filters.every(v=>v.jobInstanceId===build)).toBe(true);
});

test('pending and unrecorded dependent descriptions wait for a real scoped start',async({page})=>{
 const state=await fixture(page);state.twoJobs=true;await page.goto(path+`?jobInstanceId=${test22}`);const notice=page.getByRole('status').filter({hasText:'has no recorded start or output'});
 await expect(notice).toContainText('This job is pending.');expect(state.filters).toEqual([]);await page.getByRole('link',{name:'pending Inspect source pending',exact:true}).click();await expect(notice).toContainText('This step is pending.');await expect(notice).toContainText('Declared dependencies: build.');await expect(notice).not.toContainText('queued');expect(state.filters).toEqual([]);
 state.startSecond=true;await page.getByRole('button',{name:'Refresh selected run',exact:true}).click();await expect.poll(()=>terminalText(page.getByLabel('Workflow run log',{exact:true}))).toBe('Verify job 0\nVerify job 0');expect(state.filters.every(v=>v.jobInstanceId===test22&&v.stepId==='0'&&v.stepIndex===undefined)).toBe(true);
 state.unrecorded=true;const prior=state.filters.length;await page.getByRole('button',{name:'Refresh selected run',exact:true}).click();await expect(notice).toContainText('No outcome was recorded for this step.');await expect(page.getByLabel('Workflow run log',{exact:true})).toHaveCount(0);expect(state.filters).toHaveLength(prior);
});

test('v2 typed secret output retains withholding then exact redacted two-job scope',async({page})=>{
 const state=await fixture(page);state.twoJobs=true;state.startSecond=true;state.typed=true;state.publication='withheld';await page.goto(path+`?jobInstanceId=${test22}&stepId=0`);
 await expect(page.getByText('Output is withheld pending a verified execution result and current authorization.',{exact:true})).toBeVisible();await expect(page.getByRole('button',{name:'Download loaded log',exact:true})).toHaveCount(0);await expect(page.getByLabel('Workflow run log',{exact:true})).toHaveCount(0);
 await page.getByText('Execution receipt',{exact:true}).click();const receipt=page.getByRole('region',{name:'Run summary',exact:true});await expect(receipt).toContainText('golf.workflow.act.v0.2.89.linux.v2');await expect(receipt).toContainText('golf.workflow.dispatch.inputs.v1');await expect(receipt).toContainText('6'.repeat(64));await expect(receipt).toContainText('7'.repeat(64));await expect(receipt).toContainText('8'.repeat(64));
 state.publication='redacted';await page.getByRole('button',{name:'Refresh selected run',exact:true}).click();await expect(page.getByText('Configured secret values were masked before this log was published.',{exact:true})).toBeVisible();await expect.poll(()=>terminalText(page.getByLabel('Workflow run log',{exact:true}))).toBe('Verify job 0\nVerify job 0');expect(state.filters.every(v=>v.jobInstanceId===test22&&v.stepId==='0'&&v.stepIndex===undefined)).toBe(true);
});
for(const fault of ['schema','contract','binding','binding-version','origin'])test(`v2 secret ${fault} receipt is still refused before output`,async({page})=>{
 const state=await fixture(page);state.typed=true;state.publication='withheld';state.typedFault=fault;await page.goto(path);await expect(page.getByRole('alert')).toContainText('recorded job graph');await expect(page.getByLabel('Jobs and steps')).toHaveCount(0);expect(state.filters).toEqual([]);
});
test('v2 withheld receipt with raw bytes cannot publish or download output',async({page})=>{
 const state=await fixture(page);state.typed=true;state.publication='withheld';state.rawWithheld=true;await page.goto(path);await expect(page.getByRole('alert')).toContainText('Withheld execution output cannot contain readable chunks');await expect(page.locator('body')).not.toContainText('forbidden-private-output');await expect(page.getByRole('button',{name:'Download loaded log',exact:true})).toHaveCount(0);
});
