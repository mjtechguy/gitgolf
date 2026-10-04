import { expect, test } from '@playwright/test';
import { GetRepositoryResponseSchema, GetAuthenticationOptionsResponseSchema, GetSessionResponseSchema, GetRepositoryAccessResponseSchema, GetRepositorySettingsResponseSchema, ListCapabilitiesResponseSchema, GetExecutionPolicyResponseSchema, ListWorkflowRunsResponseSchema, InspectWorkflowsResponseSchema, ListAgentTasksResponseSchema, GetAgentUsageResponseSchema, ListCodexConnectionsResponseSchema, ListAgentModelsResponseSchema, GetCodexConnectionResponseSchema, CreateAgentTaskRequestSchema, CreateAgentTaskResponseSchema, GetAgentTaskResponseSchema, CancelAgentTaskRequestSchema, CancelAgentTaskResponseSchema, AgentUsageScope, CodexConnectionState, CodexLoginMethod } from '../src/gen/golf/v1/golf_pb';
import { request, respond, reject } from './rpc';

test('manual tasks bind current account and policy, cancel only after confirmation and clear results on denial', async ({ page }) => {
 const repository={owner:'alex',name:'private'};const connection={id:'account',name:'Personal Codex',harness:'codex',state:CodexConnectionState.CONNECTED,authMethod:CodexLoginMethod.CHATGPT_DEVICE,canUse:true,version:'9'};
 const config={enabled:true,connectionId:'account',modelId:'native-model',reasoning:'low',allowAllModels:true,allowTaskOverrides:true,triggers:['manual'],timeoutSeconds:60,tokenBudget:4000,maxConcurrent:1};
 const task={id:'00000000-0000-4000-8000-000000000001',repository,state:'queued',version:'1',modelId:'native-model',commitId:'a'.repeat(40),canCancel:true};let state=task;let denied=false;let creates=0;let cancellations=0;
 await page.route('**/rpc/**', async route=>{
  const method=new URL(route.request().url()).pathname.split('/').at(-1);
  if(method==='GetAuthenticationOptions')return respond(route,GetAuthenticationOptionsResponseSchema,{localPasswordEnabled:true});
  if(method==='GetSession')return respond(route,GetSessionResponseSchema,{user:{id:'42',login:'alex'}});
  if(method==='ListCapabilities')return respond(route,ListCapabilitiesResponseSchema,{});
  if(method==='GetRepositoryAccess')return respond(route,GetRepositoryAccessResponseSchema,{access:{repositoryId:'12',ownerId:'42',currentPermission:'owner'}});
  if(method==='GetRepositorySettings')return respond(route,GetRepositorySettingsResponseSchema,{settings:{repositoryId:'12',ownerId:'42',canEdit:true}});
  if(method==='GetExecutionPolicy')return respond(route,GetExecutionPolicyResponseSchema,{});
  if(method==='ListWorkflowRuns')return respond(route,ListWorkflowRunsResponseSchema,{});
    if (method === 'GetRepository') return respond(route, GetRepositoryResponseSchema, {repository:{id:'12',name:'private',fullName:'alex/private',defaultBranch:'main'}});
  if(method==='InspectWorkflows')return respond(route,InspectWorkflowsResponseSchema,{repositoryId:'12'});
  if(method==='GetAgentUsage')return respond(route,GetAgentUsageResponseSchema,{settings:{scope:AgentUsageScope.REPOSITORY,scopeId:'12',revision:'7',authorityRevision:'authority',canEdit:true,config,effective:config}});
  if(method==='ListAgentTasks')return denied?reject(route,'permission_denied','Task access denied'):respond(route,ListAgentTasksResponseSchema,{executionAvailable:true,tasks:creates?[state]:[]});
  if(method==='ListCodexConnections')return respond(route,ListCodexConnectionsResponseSchema,{connections:[connection]});
  if(method==='ListAgentModels')return respond(route,ListAgentModelsResponseSchema,{models:[{id:'native-model',name:'Native model',reasoning:['low','high']}]});
  if(method==='GetCodexConnection')return respond(route,GetCodexConnectionResponseSchema,{connection});
  if(method==='CreateAgentTask'){const input=request(route,CreateAgentTaskRequestSchema);creates++;expect(input.expectedRevision).toBe('7');expect(input.expectedAuthorityRevision).toBe('authority');expect(input.expectedConnectionVersion).toBe('9');expect(input.instructions).toBe('Update README');expect(input.selection?.modelId).toBe('native-model');return respond(route,CreateAgentTaskResponseSchema,{task:state});}
  if(method==='GetAgentTask')return respond(route,GetAgentTaskResponseSchema,{task:state});
  if(method==='CancelAgentTask'){const input=request(route,CancelAgentTaskRequestSchema);expect(input.expectedVersion).toBe('1');cancellations++;state={...task,state:'cancelled',version:'2',canCancel:false};return respond(route,CancelAgentTaskResponseSchema,{task:state});}
  return reject(route,'not_found','Unsupported fixture');
 });
 await page.goto('/repositories/alex/private/settings/workflows');const panel=page.getByRole('region',{name:'Coding tasks',exact:true});await expect(panel.getByRole('form')).toHaveCount(0);await panel.getByRole('button',{name:'New coding task',exact:true}).click();const form=panel.getByRole('form',{name:'New agent task'});await expect(form.getByLabel('Model',{exact:true})).toHaveValue('native-model');await form.getByLabel('Task instructions').fill('Update README');await form.getByRole('button',{name:'Start task',exact:true}).click();await expect(panel.getByRole('button',{name:'Cancel coding task',exact:true})).toBeVisible();expect(creates).toBe(1);await panel.getByRole('button',{name:'Cancel coding task',exact:true}).click();const confirmation=page.getByRole('dialog',{name:'Cancel coding task?'});await expect(confirmation).toBeVisible();expect(cancellations).toBe(0);await confirmation.getByRole('button',{name:'Keep running'}).click();expect(cancellations).toBe(0);await panel.getByRole('button',{name:'Cancel coding task',exact:true}).click();await confirmation.getByRole('button',{name:'Confirm cancellation'}).click();await expect(panel.getByRole('table')).toContainText('cancelled');expect(cancellations).toBe(1);
 denied=true;await panel.getByRole('button',{name:'Refresh coding tasks'}).click();await expect(panel.getByRole('table')).toHaveCount(0);await expect(panel).not.toContainText('00000000');await expect(panel.getByRole('button',{name:'New coding task'})).toBeDisabled();
});
