import { Link } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { Code, ConnectError } from '@connectrpc/connect';
import { agentControlClient } from './api';
import { DataTable, type DataTableColumn } from './DataTable';
import { Loading, PanelError, privateQuery } from './RepositoryUI';
import { isCommitID, isRunID, repositoryOptions, type RepositoryLocation } from './navigation';
import type { WorkflowAgentChild } from './gen/golf/v1/agent_control088_pb';

export const workflowAgentCatalog088='golf.workflow.act.v0.2.89.linux.agents088.v1';
export function WorkflowAgentChildren({userId,repositoryId,runId,attemptId,commitId,location,ready}:{userId:string;repositoryId:string;runId:string;attemptId:string;commitId:string;location:RepositoryLocation;ready:boolean}){
 const query=useQuery({...privateQuery,queryKey:['workflow-agent-children',userId,repositoryId,runId,attemptId,commitId],enabled:ready&&isRunID(runId)&&!!attemptId,queryFn:async({signal})=>{
  const result=await agentControlClient.listWorkflowAgentChildren({runId,attemptId},{signal,timeoutMs:10000});signal.throwIfAborted();
  if(result.runId!==runId||result.attemptId!==attemptId||result.repositoryId!==repositoryId||result.commitId!==commitId||!isCommitID(result.commitId)||result.children.length>128||result.children.some(child=>!isRunID(child.taskId)||!/^[a-f0-9]{32}$/.test(child.jobInstanceId)||!/^([A-Za-z_][A-Za-z0-9_-]{0,63}|0|[1-9][0-9]{0,2})$/.test(child.stepId)||child.attemptId&&!/^[a-f0-9]{32}$/.test(child.attemptId)||!['queued','running','succeeded','failed','cancelled','timed_out','budget_exceeded','lost'].includes(child.state)))throw new ConnectError('The workflow agent child receipt could not be verified.',Code.FailedPrecondition);
  return result.children;
 },refetchInterval:q=>ready&&!q.state.error?5000:false});
 if(!ready)return null;
 const columns:DataTableColumn<WorkflowAgentChild>[]=[{accessorKey:'stepId',header:'Step'},{accessorKey:'jobInstanceId',header:'Job instance',cell:({row})=><code>{row.original.jobInstanceId.slice(0,12)}</code>},{accessorKey:'state',header:'Agent state'},{id:'task',header:'Private task',cell:({row})=><Link {...repositoryOptions(location,{view:'actions',run:row.original.taskId,runKind:'coding-task',step:undefined})}>Open agent task</Link>}];
 return <section className="browser-panel credential-list-panel" aria-label="Workflow agent steps"><div className="browser-panel-heading"><h3>Workflow agent steps</h3></div><p className="panel-footnote">Own private child tasks use this workflow's original source snapshot. Proposed patches are reviewed separately and are not applied to the job workspace.</p>{query.error?<PanelError error={query.error} retry={()=>void query.refetch()}/>:query.isPending||query.isFetching?<Loading label="Reading workflow agent steps…"/>:<DataTable label="Workflow agent steps" data={query.data||[]} columns={columns} getRowId={row=>row.taskId}/>}</section>;
}
