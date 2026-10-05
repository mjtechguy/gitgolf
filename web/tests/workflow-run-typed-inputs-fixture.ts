import {expect,type Page,type Route} from '@playwright/test';
import {respond,request,reject,disabledAgentTasks} from './rpc';
import {GetSessionResponseSchema,GetRepositoryResponseSchema,ListRepositoriesResponseSchema,ListCapabilitiesResponseSchema,GetWorkflowRunRequestSchema,GetWorkflowRunResponseSchema,GetWorkflowRunLogsRequestSchema,GetWorkflowRunLogsResponseSchema,WorkflowOutputState,WorkflowRunState,WorkflowRunOrigin,WorkflowStepState} from '../src/gen/golf/v1/golf_pb';

export const runId='12345678-1234-4234-8234-123456789abc',commit='a'.repeat(40),attempt='d'.repeat(32),job='1'.repeat(32);
export const catalog='golf.workflow.act.v0.2.89.linux.v2',contract='golf.workflow.dispatch.inputs.v1';
export const path=`/alex/demo/actions/runs/${runId}`,selectedPath=path+`?jobInstanceId=${job}&stepId=literal`;
export async function typedRunFixture(page:Page){
 const state={catalog,contract,schema:'e'.repeat(64),submitted:'f'.repeat(64),effective:'9'.repeat(64),origin:WorkflowRunOrigin.MANUAL,status:WorkflowRunState.SUCCEEDED,publication:WorkflowOutputState.ORDINARY,withheldBinding:true,deny:false,logError:'' as ''|'permission_denied'|'not_found'|'unauthenticated',badReceipt:'',logBarrier:undefined as Promise<void>|undefined,reads:0,filters:[] as {job:string;step:string;after:string}[]};
 const run=()=>{
  const queued=state.status===WorkflowRunState.QUEUED,running=state.status===WorkflowRunState.RUNNING;
  const startedAt=queued?undefined:'2026-10-04T00:01:00Z',finishedAt=queued||running?undefined:'2026-10-04T00:01:10Z';
  return {id:runId,repositoryId:'11',ownerId:'42',version:'9',workflowPath:'.github/workflows/inputs.yml',workflowBlobId:'b'.repeat(40),sourceSha256:'c'.repeat(64),commitId:commit,attemptId:queued?'':attempt,engineCatalog:state.catalog,engineCommit:'4f411281417e88660bea1c1a1749aa71ae0bd60f',inputContract:state.contract,schemaSha256:state.schema,submittedSha256:state.submitted,effectiveSha256:state.effective,outputState:state.publication,executionBindingId:state.publication===WorkflowOutputState.WITHHELD&&state.withheldBinding?'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa':'',executionBindingVersion:state.publication===WorkflowOutputState.WITHHELD&&state.withheldBinding?'3':'',createdAt:'2026-10-04T00:00:00Z',startedAt,finishedAt,state:state.status,origin:state.origin,runnerId:queued?'':'owned-fixture-worker',canCancel:false,jobs:[{instanceId:job,jobId:'inputs',name:'Typed inputs',matrix:[],needs:[],state:queued?WorkflowStepState.PENDING:running?WorkflowStepState.RUNNING:WorkflowStepState.SUCCEEDED,startedAt,finishedAt,eventsRecorded:!queued,imageDigest:'alpine:3.23@sha256:'+'5'.repeat(64),steps:[{id:'literal',name:'Check literal input',state:queued?WorkflowStepState.PENDING:running?WorkflowStepState.RUNNING:WorkflowStepState.SUCCEEDED,startedAt,finishedAt},{id:'false-flag',name:'False flag branch',state:queued?WorkflowStepState.PENDING:WorkflowStepState.SKIPPED}]}]};
 };
 await page.route('**/rpc/**',async(route:Route)=>{
  const method=new URL(route.request().url()).pathname.split('/').at(-1)!;
  if(method==='GetSession')return respond(route,GetSessionResponseSchema,{user:{id:'42',login:'alex'}});
  if(method==='ListCapabilities')return respond(route,ListCapabilitiesResponseSchema,{});
  if(method==='ListRepositories')return respond(route,ListRepositoriesResponseSchema,{});
  if(method==='GetRepository')return respond(route,GetRepositoryResponseSchema,{repository:{id:'11',name:'demo',fullName:'alex/demo',defaultBranch:'main',private:true}});
  if(method==='ListAgentTasks')return disabledAgentTasks(route);
  if(method==='GetRepositoryStar')return reject(route,'unimplemented','Optional stars are outside this typed run fixture.');
  if(method==='WatchRepository')return reject(route,'unimplemented','No live stream in this source fixture.');
  if(method==='GetWorkflowRun'){
   expect(request(route,GetWorkflowRunRequestSchema).runId).toBe(runId);state.reads++;
   if(state.deny)return reject(route,'permission_denied','Run access removed.');
   return respond(route,GetWorkflowRunResponseSchema,{run:run()});
  }
  if(method==='GetWorkflowRunLogs'){
   const input=request(route,GetWorkflowRunLogsRequestSchema);expect(input.runId).toBe(runId);
   state.filters.push({job:input.jobInstanceId,step:input.stepId,after:input.afterSequence.toString()});
   if(state.logBarrier)await state.logBarrier;
   if(state.logError)return reject(route,state.logError,'Typed run log unavailable.');
   const receipt={runId,attemptId:attempt,repositoryId:'11',sourceCommitId:commit,jobInstanceId:input.jobInstanceId,stepId:input.stepId,outputState:state.publication};
   if(state.badReceipt==='run')receipt.runId='87654321-1234-4234-8234-123456789abc';
   if(state.badReceipt==='attempt')receipt.attemptId='2'.repeat(32);
   if(state.badReceipt==='repository')receipt.repositoryId='12';
   if(state.badReceipt==='source')receipt.sourceCommitId='6'.repeat(40);
   if(state.badReceipt==='job')receipt.jobInstanceId='2'.repeat(32);
   if(state.badReceipt==='step')receipt.stepId='false-flag';
   return respond(route,GetWorkflowRunLogsResponseSchema,{...receipt,logs:[{sequence:input.afterSequence===0n?7n:29n,text:input.afterSequence===0n?'Literal input stayed literal.\n':'Number and boolean input checks passed.\n'}],hasMore:input.stepId==='literal'&&input.afterSequence===0n});
  }
  return reject(route,'not_found','Unavailable typed run fixture.');
 });return state;
}
