import { portableRuntimeFixture } from './runtime-fixture';
import { test,expect,type Page } from '@playwright/test';
import { reject,request,respond } from './rpc';
import { AgentEventBodyState,ActionRunKind,GetActionRunResponseSchema,GetAuthenticationOptionsResponseSchema,GetRepositoryResponseSchema,GetSessionResponseSchema,ListAgentTaskEventsResponseSchema,ListCapabilitiesResponseSchema } from '../src/gen/golf/v1/golf_pb';
import { GetAgentControlResponseSchema,SubmitAgentCommandRequestSchema,SubmitAgentCommandResponseSchema } from '../src/gen/golf/v1/agent_control088_pb';
const id='12345678-1234-4234-8234-123456789012',attempt='b'.repeat(32),commit='a'.repeat(40),repo='21',actor='7',url=`/alex/private/actions/tasks/${id}`;
async function fixture(page:Page){
 const state={sandbox:true,fileTools:true,nativeVersion:'1.18.34',current:'idle',revision:1,deny:false,ended:false,lost:false,commands:[] as unknown[],barrier:undefined as Promise<void>|undefined};
 await page.route('**/rpc/**',async route=>{
  const method=new URL(route.request().url()).pathname.split('/').at(-1)!;
  if(method==='GetAuthenticationOptions')return respond(route,GetAuthenticationOptionsResponseSchema,{localPasswordEnabled:true});
  if(method==='GetSession')return state.ended?respond(route,GetSessionResponseSchema,{}):respond(route,GetSessionResponseSchema,{user:{id:actor,login:'alex'}});
  if(method==='ListCapabilities')return respond(route,ListCapabilitiesResponseSchema, portableRuntimeFixture);
  if(method==='GetRepository')return respond(route,GetRepositoryResponseSchema,{repository:{id:repo,name:'private',fullName:'alex/private',defaultBranch:'main',private:true}});
  if(method==='GetActionRun'){const task={id,repository:{owner:'alex',name:'private'},state:'running',commitId:commit,version:'1',createdAt:'2026-10-01T12:00:00Z',workerId:'worker-1',attemptId:attempt,modelId:'opencode-go/model',tokens:'0',summary:'Private retained proposal'};return respond(route,GetActionRunResponseSchema,{repositoryId:repo,summary:{ref:{kind:ActionRunKind.CODING_TASK,id},repositoryId:repo,ownerId:actor,title:'Coding task',state:task.state,commitId:commit,createdAt:task.createdAt,workerId:task.workerId,attemptId:attempt,modelId:task.modelId},detail:{case:'task',value:task}});}
  if(method==='ListAgentTaskEvents')return respond(route,ListAgentTaskEventsResponseSchema,{repositoryId:repo,taskId:id,attemptId:attempt,commitId:commit,nativeInitiatorId:actor,bodyState:AgentEventBodyState.WITHHELD,events:[]});
  if(method==='GetAgentControl'){
   if(state.barrier)await state.barrier;if(state.deny)return reject(route,'permission_denied','Current managed agent authority revoked.');if(state.ended)return reject(route,'unauthenticated','Session ended.');
   return respond(route,GetAgentControlResponseSchema,{control:{taskId:id,attemptId:attempt,taskVersion:'1',revision:String(state.revision),available:state.sandbox,filePermissionsQualified:state.sandbox&&state.fileTools,state:state.sandbox?state.current:'closed',reason:'Pinned managed ACP unavailable until native qualification.',image:state.sandbox?'sha256:'+'d'.repeat(64):'',nativeVersion:state.nativeVersion,permissionId:state.sandbox&&state.current==='permission'?'s/native-permission':'',toolId:state.sandbox&&state.current==='permission'?'native-workspace-read':'',allowOnceOptions:state.sandbox&&state.fileTools&&state.current==='permission'?['once']:[],canResume:state.sandbox&&state.current==='idle',messages:state.sandbox?[{sequence:'5',text:'Completed native reply, screened against the actual cache.'}]:[]}});
  }
  if(method==='SubmitAgentCommand'){
   const input=request(route,SubmitAgentCommandRequestSchema);state.commands.push(input);if(state.barrier)await state.barrier;if(state.lost)return reject(route,'unavailable','Original command acknowledgement was lost.');
   state.revision++;if(input.kind==='reply')state.current='permission';else if(input.kind==='finish')state.current='closed';else state.current='idle';
   return respond(route,SubmitAgentCommandResponseSchema,{requestId:input.requestId,state:'queued'});
  }
  return reject(route,'unimplemented','Fixture does not implement this procedure.');
 });return state;
}
const panel=(page:Page)=>page.getByRole('region',{name:'Managed agent conversation',exact:true});
test('StrictMode dispatches one original reply, exact permission, cancel and native resume',async({page})=>{
 const s=await fixture(page);await page.goto(url);await expect(panel(page)).toContainText('Completed native reply');await expect(panel(page).getByRole('textbox')).toHaveCount(0);
 await panel(page).getByRole('button',{name:'Reply',exact:true}).click();await panel(page).getByRole('textbox',{name:'Reply',exact:true}).fill('Continue in this workspace');await panel(page).getByRole('button',{name:'Send reply',exact:true}).dblclick();
 await expect(panel(page)).toContainText('native-workspace-read');expect(s.commands).toHaveLength(1);expect(s.commands[0]).toMatchObject({taskId:id,attemptId:attempt,expectedTaskVersion:'1',expectedRevision:'1',kind:'reply',text:'Continue in this workspace'});
 await panel(page).getByRole('button',{name:'Allow workspace file request once'}).click();await expect(panel(page).getByRole('button',{name:'Reply',exact:true})).toBeVisible();expect(s.commands[1]).toMatchObject({kind:'permission',permissionId:'s/native-permission',optionId:'once'});
 await panel(page).getByRole('button',{name:'Resume native session'}).click();await expect.poll(()=>s.commands.length).toBe(3);expect(s.commands[2]).toMatchObject({kind:'resume',text:''});
 s.current='permission';s.revision++;await panel(page).getByRole('button',{name:'Refresh controls'}).click();await panel(page).getByRole('button',{name:'Cancel turn'}).click();await expect.poll(()=>s.commands.length).toBe(4);expect(s.commands[3]).toMatchObject({kind:'cancel_turn',permissionId:'',optionId:''});
 expect(new Set(s.commands.map(input=>(input as {requestId:string}).requestId)).size).toBe(4);expect(await page.evaluate(()=>JSON.stringify({...localStorage,...sessionStorage}))).not.toContain('Completed native reply');
});
test('missing pinned sandbox and wrong native version never enable controls',async({page})=>{
 const s=await fixture(page);s.sandbox=false;await page.goto(url);await expect(panel(page)).toContainText('unavailable until native qualification');await expect(panel(page).getByRole('button',{name:'Reply',exact:true})).toHaveCount(0);expect(s.commands).toHaveLength(0);
 s.sandbox=true;s.nativeVersion='2.0.16';await page.getByRole('button',{name:'Refresh selected run'}).click();await expect(panel(page).getByRole('alert')).toContainText('receipt could not be verified');await expect(panel(page).getByRole('button',{name:'Reply',exact:true})).toHaveCount(0);
});
test('a lost command acknowledgement disables further writes until explicit inspection',async({page})=>{
 const s=await fixture(page);s.lost=true;await page.goto(url);await panel(page).getByRole('button',{name:'Resume native session'}).click();await expect(panel(page)).toContainText('No automatic retry');await expect(panel(page).getByRole('button',{name:'Resume native session'})).toBeDisabled();await page.waitForTimeout(5300);expect(s.commands).toHaveLength(1);s.lost=false;await panel(page).getByRole('button',{name:'Refresh controls'}).click();await expect(panel(page).getByRole('button',{name:'Resume native session'})).toBeEnabled();
});
test('current authority loss removes completed ACP text and the prior proposal',async({page})=>{
 const s=await fixture(page);await page.goto(url);await expect(panel(page)).toContainText('Completed native reply');s.deny=true;await panel(page).getByRole('button',{name:'Refresh controls'}).click();await expect(page.getByRole('alert')).toContainText('authority revoked');await expect(panel(page)).toHaveCount(0);await expect(page.getByText('Private retained proposal',{exact:true})).toHaveCount(0);
});
test('late command receipts after route departure cannot restore private controls',async({page})=>{
 const s=await fixture(page);await page.goto(url);await expect(panel(page).getByRole('button',{name:'Reply',exact:true})).toBeVisible();let release!:()=>void;s.barrier=new Promise(resolve=>release=resolve);await panel(page).getByRole('button',{name:'Resume native session'}).click();await expect.poll(()=>s.commands.length).toBe(1);await page.getByRole('link',{name:'Back to Actions'}).click();release();s.barrier=undefined;await expect(panel(page)).toHaveCount(0);await expect(page.getByText('Completed native reply, screened against the actual cache.',{exact:true})).toHaveCount(0);
});
for(const theme of ['dark','light'] as const)test(`permission inventory ${theme} fits mobile and exposes no persistent approval`,async({page},info)=>{
 const s=await fixture(page);s.current='permission';await page.emulateMedia({colorScheme:theme});await page.setViewportSize({width:320,height:760});await page.goto(url);await expect(panel(page).getByRole('button',{name:'Reject request'})).toBeVisible();await expect(page.getByRole('button',{name:/allow always/i})).toHaveCount(0);expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);await page.screenshot({path:info.outputPath(`agent-permission-${theme}-320.png`),fullPage:true});await panel(page).getByRole('button',{name:'Reject request'}).click();await expect.poll(()=>s.commands.length).toBe(1);expect(s.commands[0]).toMatchObject({kind:'permission',optionId:''});
});

test('initialized native protocol without file execution receipt only permits rejection',async({page})=>{
 const s=await fixture(page);s.current='permission';s.fileTools=false;await page.goto(url);await expect(panel(page)).toContainText('Native file-tool execution is not qualified');await expect(panel(page).getByRole('button',{name:'Allow workspace file request once'})).toHaveCount(0);await panel(page).getByRole('button',{name:'Reject request'}).click();await expect.poll(()=>s.commands.length).toBe(1);expect(s.commands[0]).toMatchObject({kind:'permission',optionId:''});
});
