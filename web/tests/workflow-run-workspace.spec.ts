import { expect,test,type Page,type Route } from '@playwright/test';
import { create,toJson } from '@bufbuild/protobuf';
import { respond,request,reject,disabledAgentTasks } from './rpc';
import { GetSessionResponseSchema,GetRepositoryResponseSchema,ListRepositoriesResponseSchema,ListCapabilitiesResponseSchema,GetWorkflowRunRequestSchema,GetWorkflowRunResponseSchema,GetWorkflowRunLogsRequestSchema,GetWorkflowRunLogsResponseSchema,CancelWorkflowRunRequestSchema,CancelWorkflowRunResponseSchema,WatchRepositoryResponseSchema,WorkflowRunState,WorkflowRunOrigin,WorkflowStepState } from '../src/gen/golf/v1/golf_pb';

const runId='12345678-1234-4234-8234-123456789abc',head='a'.repeat(40),path=`/alex/demo/actions/runs/${runId}`;
function frame(flag:number,body:unknown){const payload=Buffer.from(JSON.stringify(body)),header=Buffer.alloc(5);header[0]=flag;header.writeUInt32BE(payload.length,1);return Buffer.concat([header,payload]);}
async function backend(page:Page){
 const state={catalog:'',cursor:1,live:false,deny:false,foreign:false,badLogs:false,truncated:false,chunks:17,after:[] as string[],reads:0,cancels:[] as {runId:string;expectedVersion:string}[],cancelLost:false,cancelBarrier:undefined as Promise<void>|undefined,state:WorkflowRunState.RUNNING,progress:false,stepComplete:false,startSecond:true,stepReads:[] as (number|undefined)[]};
 const run=()=>({engineCatalog:state.catalog,id:runId,repositoryId:state.foreign?'22':'11',workflowPath:'.github/workflows/qualification.yml',workflowBlobId:'b'.repeat(40),sourceSha256:'c'.repeat(64),commitId:head,createdAt:'2026-10-03T00:00:00Z',startedAt:'2026-10-03T00:01:00Z',finishedAt:state.state===WorkflowRunState.RUNNING?undefined:'2026-10-03T00:02:05Z',exitCode:state.state===WorkflowRunState.RUNNING?undefined:0,runnerId:'local-worker',version:'9',canCancel:state.state===WorkflowRunState.RUNNING,origin:WorkflowRunOrigin.PUSH,eventRef:'refs/heads/main',repositoryEventId:'5',automationGrantId:'owned-grant',state:state.state,logsTruncated:state.truncated,progress:state.progress?{jobId:'check',name:'Check source',eventsRecorded:true,steps:[{index:0,name:'First step',state:WorkflowStepState.SUCCEEDED,startedAt:'2026-10-03T00:01:00Z',finishedAt:'2026-10-03T00:01:10Z',exitCode:0},{index:1,name:'Second step',state:!state.startSecond?WorkflowStepState.PENDING:state.stepComplete?WorkflowStepState.SUCCEEDED:WorkflowStepState.RUNNING,startedAt:state.startSecond?'2026-10-03T00:01:11Z':undefined,finishedAt:state.stepComplete?'2026-10-03T00:01:25Z':undefined,exitCode:state.stepComplete?0:undefined}]}:undefined});
 await page.route('**/rpc/**',async(route:Route)=>{
  const method=new URL(route.request().url()).pathname.split('/').at(-1)!;
  if(method==='WatchRepository'){
   if(!state.live)return reject(route,'not_found','Live fixture not enabled.');
   const input=JSON.parse(route.request().postDataBuffer()!.subarray(5).toString());await new Promise(resolve=>setTimeout(resolve,200));
   const message=toJson(WatchRepositoryResponseSchema,create(WatchRepositoryResponseSchema,{repositoryId:'11',cursor:String(state.cursor),kind:!input.cursor?'reset':input.cursor!==String(state.cursor)?'change':'heartbeat',topics:input.cursor&&input.cursor!==String(state.cursor)?['actions']:[]}));
   return route.fulfill({status:200,contentType:'application/connect+json',body:Buffer.concat([frame(0,message),frame(0,{repositoryId:'11',cursor:String(state.cursor),kind:'reconnect'}),frame(2,{})])});
  }
  if(method==='GetSession')return respond(route,GetSessionResponseSchema,{user:{id:'42',login:'alex'}});
  if(method==='ListCapabilities')return respond(route,ListCapabilitiesResponseSchema,{});
  if(method==='ListRepositories')return respond(route,ListRepositoriesResponseSchema,{});
  if(method==='GetRepository')return respond(route,GetRepositoryResponseSchema,{repository:{id:'11',name:'demo',fullName:'alex/demo',private:true,defaultBranch:'main'}});
  if(method==='ListAgentTasks')return disabledAgentTasks(route);
  if(method==='GetWorkflowRun'){
   state.reads++;expect(request(route,GetWorkflowRunRequestSchema).runId).toBe(runId);
   if(state.deny)return reject(route,'permission_denied','Run access removed.');
   return respond(route,GetWorkflowRunResponseSchema,{run:run()});
  }
  if(method==='GetWorkflowRunLogs'){
   const input=request(route,GetWorkflowRunLogsRequestSchema);expect(input.runId).toBe(runId);state.after.push(input.afterSequence.toString());state.stepReads.push(input.stepIndex);
   if(input.stepIndex!==undefined){return respond(route,GetWorkflowRunLogsResponseSchema,{logs:[{sequence:BigInt(input.stepIndex+1),text:input.stepIndex===0?'First step output':'Second step output'}]});}
   if(state.deny)return reject(route,'permission_denied','Run log access removed.');
   if(state.badLogs&&input.afterSequence>0n)return respond(route,GetWorkflowRunLogsResponseSchema,{logs:[{sequence:input.afterSequence,text:'Invalid repeated sequence'}],hasMore:true});
   const start=Number(input.afterSequence),end=Math.min(start+16,state.chunks);
   return respond(route,GetWorkflowRunLogsResponseSchema,{logs:Array.from({length:Math.max(0,end-start)},(_,index)=>({sequence:BigInt(start+index+1),text:start+index===15?'<scr':start+index===16?'ipt>window.executed=true</script>\n':`Chunk ${start+index+1}\n`})),hasMore:end<state.chunks,truncated:state.truncated});
  }
  if(method==='CancelWorkflowRun'){
   state.cancels.push(request(route,CancelWorkflowRunRequestSchema));if(state.cancelBarrier)await state.cancelBarrier;
   state.state=WorkflowRunState.CANCELLED;if(state.cancelLost)return reject(route,'unavailable','Cancellation response lost.');
   return respond(route,CancelWorkflowRunResponseSchema,{run:run()});
  }
  return reject(route,'not_found','Unavailable workspace fixture.');
 });return state;
}

test('canonical run workspace continues logs across chunks, searches safely, downloads loaded text and survives reload',async({page})=>{
 const state=await backend(page);state.truncated=true;await page.goto(path);
 await expect(page.getByRole('heading',{name:'.github/workflows/qualification.yml',exact:true})).toBeVisible();
 await expect(page.getByRole('link',{name:'All runs'})).toHaveAttribute('href',/\/alex\/demo\/actions/);
 await expect(page.getByRole('link',{name:head.slice(0,12),exact:true})).toHaveAttribute('href',new RegExp(`/commit/${head}`));
 await expect(page.getByRole('button',{name:'Load more log output'})).toBeVisible();
 await page.getByRole('button',{name:'Load more log output'}).click();
 const log=page.getByLabel('Workflow run log',{exact:true});await expect(log).toContainText('<script>window.executed=true</script>');
 await expect(log.locator('script')).toHaveCount(0);expect(await page.evaluate(()=>('executed' in window))).toBe(false);
 expect(state.after).toContain('16');await expect(page.getByRole('button',{name:'Load more log output'})).toHaveCount(0);
 await page.getByRole('searchbox',{name:'Search loaded run log'}).fill('script');await expect(log.locator('mark')).toHaveCount(2);
 await expect(page.getByText('Output reached the worker limit.',{exact:false})).toBeVisible();
 const download=page.waitForEvent('download');await page.getByRole('button',{name:'Download loaded log'}).click();
 const result=await download;expect(result.suggestedFilename()).toBe(`golf-run-${runId}.log`);
 const stream=await result.createReadStream();let output='';for await(const chunk of stream!)output+=chunk.toString();expect(output).toContain('<script>window.executed=true</script>');
 await page.reload();await expect(page.getByRole('heading',{name:'.github/workflows/qualification.yml',exact:true})).toBeVisible();
 await expect(page.getByRole('searchbox',{name:'Search loaded run log'})).toHaveValue('');
});

test('foreign run binding refuses content before requesting logs and malformed run paths fail',async({page})=>{
 const state=await backend(page);state.foreign=true;await page.goto(path);
 await expect(page.getByRole('alert')).toHaveText('This run does not belong to the selected repository.');
 expect(state.after).toEqual([]);await expect(page.getByLabel('Workflow run log',{exact:true})).toHaveCount(0);
 await expect(page.getByRole('button',{name:'Reconnect live updates'})).toBeVisible();const reads=state.reads;
 await page.goto('/alex/demo/actions/runs/not-a-uuid');await expect(page.getByRole('heading',{name:'.github/workflows/qualification.yml'})).toHaveCount(0);expect(state.reads).toBe(reads);
});

test('invalid log continuation and permission loss remove loaded private output',async({page})=>{
 const state=await backend(page);await page.goto(path);await expect(page.getByLabel('Workflow run log',{exact:true})).toContainText('Chunk 1');
 state.badLogs=true;await page.getByRole('button',{name:'Load more log output'}).click();await expect(page.getByRole('alert')).toContainText('invalid sequence');await expect(page.getByLabel('Workflow run log',{exact:true})).toHaveCount(0);
 state.deny=true;await page.getByRole('button',{name:'Refresh selected run'}).click();await expect(page.getByRole('alert')).toHaveText('Run access removed.');await expect(page.getByRole('heading',{name:'Run log',exact:true})).toHaveCount(0);
 expect(await page.evaluate(()=>JSON.stringify({...localStorage,...sessionStorage}))).not.toContain('Chunk 1');
});

test('live action invalidations update already-loaded tail and selected run without manual refresh',async({page})=>{
 const state=await backend(page);state.live=true;await page.goto(path);await expect(page.getByText('Live',{exact:true})).toBeVisible();await expect(page.getByRole('button',{name:'Load more log output'})).toBeVisible();
 await page.getByRole('button',{name:'Load more log output'}).click();await expect(page.getByLabel('Workflow run log',{exact:true})).toContainText('</script>');
 state.chunks=18;state.state=WorkflowRunState.SUCCEEDED;state.cursor++;
 await expect(page.getByLabel('Workflow run log',{exact:true})).toContainText('Chunk 18');await expect(page.locator('.workflow-run-summary .run-state')).toHaveText('succeeded');await expect(page.getByText('1m 5s',{exact:true})).toBeVisible();
 await expect(page.getByRole('button',{name:'Refresh selected run'})).toBeHidden();await expect(page.getByRole('button',{name:'Cancel run'})).toHaveCount(0);
});

test('cancellation sends the observed version once and lost response remains inspectable',async({page})=>{
 const state=await backend(page);state.cancelLost=true;await page.goto(path);await expect(page.getByRole('button',{name:'Cancel run'})).toBeVisible();
 await page.getByRole('button',{name:'Cancel run'}).click();await expect(page.getByRole('status').filter({hasText:'Cancellation response lost'})).toBeVisible();
 expect(state.cancels.map(value=>({runId:value.runId,expectedVersion:value.expectedVersion}))).toEqual([{runId,expectedVersion:'9'}]);
 await page.getByRole('button',{name:'Refresh selected run'}).click();await expect(page.locator('.workflow-run-summary .run-state')).toHaveText('cancelled');await expect(page.getByRole('button',{name:'Cancel run'})).toHaveCount(0);expect(state.cancels).toHaveLength(1);
});

test('run workspace stays contained in dark/light mobile and preserves receipt/source navigation',async({page},testInfo)=>{
 const state=await backend(page);state.progress=true;await page.goto(path);await expect(page.getByLabel('Workflow run log',{exact:true})).toBeVisible();
 await page.locator('summary').filter({hasText:'Execution receipt'}).click();await expect(page.getByRole('link',{name:'.github/workflows/qualification.yml',exact:true})).toHaveAttribute('href',new RegExp(`/blob/${head}/.github/workflows/qualification.yml`));
 for(const theme of ['dark','light']){
  await page.evaluate(theme=>document.documentElement.dataset.theme=theme,theme);await page.setViewportSize({width:320,height:844});
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);await page.screenshot({path:testInfo.outputPath(`run-${theme}-mobile.png`),fullPage:true});
 }
});


test('leaving a pending cancellation aborts local UI handling without replaying the write',async({page})=>{
 const state=await backend(page);let release!:()=>void;state.cancelBarrier=new Promise(resolve=>{release=resolve;});await page.goto(path);
 await page.getByRole('button',{name:'Cancel run'}).click();await expect.poll(()=>state.cancels.length).toBe(1);
 await page.getByRole('link',{name:'All runs'}).click();await expect(page).toHaveURL(/\/alex\/demo\/actions$/);release();
 await expect(page.getByText('Run cancelled.',{exact:false})).toHaveCount(0);expect(state.cancels).toHaveLength(1);
});


test('job sidebar uses recorded events and step-scoped log links, including the zero index and reload',async({page})=>{
 const state=await backend(page);state.progress=true;await page.goto(path);await expect(page.getByLabel('Jobs and steps')).toContainText('Check source');
 await page.getByRole('link',{name:'First step 10s'}).click();await expect(page).toHaveURL(/step=0/);await expect(page.getByLabel('Workflow run log',{exact:true})).toHaveText('First step output');expect(state.stepReads).toContain(0);
 await page.reload();await expect(page.getByRole('link',{name:'First step 10s'})).toHaveAttribute('aria-current','page');await expect(page.getByLabel('Workflow run log',{exact:true})).toHaveText('First step output');
 await page.getByRole('link',{name:'Second step In progress'}).click();await expect(page).toHaveURL(/step=1/);await expect(page.getByLabel('Workflow run log',{exact:true})).toHaveText('Second step output');
 const download=page.waitForEvent('download');await page.getByRole('button',{name:'Download loaded log'}).click();expect((await download).suggestedFilename()).toBe(`golf-run-${runId}-step-2.log`);
 await page.getByRole('link',{name:'All run output'}).click();await expect(page).not.toHaveURL(/step=/);await expect(page.getByLabel('Workflow run log',{exact:true})).toContainText('Chunk 1');
});

test('live step completion updates sidebar while keeping selected log scope',async({page})=>{
 const state=await backend(page);state.live=true;state.progress=true;await page.goto(path+'?step=1');await expect(page.getByText('Live',{exact:true})).toBeVisible();
 await expect(page.getByLabel('Jobs and steps')).toContainText('In progress');state.stepComplete=true;state.cursor++;
 await expect(page.getByLabel('Jobs and steps')).toContainText('14s');await expect(page.getByRole('link',{name:'Second step 14s'})).toHaveAttribute('aria-current','page');
 await expect(page.getByLabel('Workflow run log',{exact:true})).toHaveText('Second step output');expect(state.stepReads.every(value=>value===1)).toBe(true);
});


test('a direct pending-step link waits for a real start event before reading its logs',async({page})=>{
 const state=await backend(page);state.live=true;state.progress=true;state.startSecond=false;await page.goto(path+'?step=1');
 await expect(page.getByRole('status').filter({hasText:'The selected step has no recorded output'})).toBeVisible();expect(state.stepReads).toEqual([]);
 state.startSecond=true;state.cursor++;await expect(page.getByLabel('Workflow run log',{exact:true})).toHaveText('Second step output');expect(state.stepReads).toContain(1);
});

for (const theme of ['dark','light']) for (const width of [390,320]) test(`mobile ${theme}/${width} opens the selected log before optional jobs and preserves keyboard step links`,async({page},testInfo)=>{
 const state=await backend(page);state.progress=true;state.state=WorkflowRunState.SUCCEEDED;
 await page.setViewportSize({width,height:844});await page.addInitScript(theme=>localStorage.setItem('golf.theme',theme),theme);
 await page.goto(path+'?step=1');const log=page.getByLabel('Workflow run log',{exact:true});await expect(log).toHaveText('Second step output');
 const jobs=page.locator('.workflow-jobs-disclosure');await expect(jobs).not.toHaveAttribute('open','');
 await expect(page.getByRole('link',{name:'First step 10s'})).toBeHidden();
 const box=await log.boundingBox();console.log('Actions mobile first log',{theme,width,y:box!.y});expect(box!.y).toBeLessThan(width===390?650:700);
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
 const summary=jobs.locator('summary');await summary.focus();await page.keyboard.press('Enter');await expect(page.getByRole('link',{name:'First step 10s'})).toBeVisible();
 await page.getByRole('link',{name:'First step 10s'}).click();await expect(page).toHaveURL(/step=0/);await expect(log).toHaveText('First step output');
 await page.reload();await expect(jobs).not.toHaveAttribute('open','');await expect(log).toHaveText('First step output');
 await page.getByRole('button',{name:'Search loaded run log',exact:true}).click();const search=page.getByRole('searchbox',{name:'Search loaded run log',exact:true});await expect(search).toBeVisible();await search.fill('First');await expect(log.locator('mark')).toHaveCount(1);
 expect(state.stepReads.every(step=>step===0||step===1)).toBe(true);await page.screenshot({path:testInfo.outputPath('actions-mobile-log-first.png'),fullPage:true});
});


test('explicit shell catalog retains its recorded single-job and numeric-step reader',async({page})=>{
 const state=await backend(page);state.catalog='golf.workflow.shell.v1';state.progress=true;await page.goto(path+'?step=0');
 await expect(page.getByLabel('Jobs and steps')).toContainText('Check source');
 await expect(page.getByLabel('Workflow run log',{exact:true})).toHaveText('First step output');
 expect(state.stepReads).toContain(0);await expect(page.getByRole('alert')).toHaveCount(0);
});
