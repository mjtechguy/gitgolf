import { useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Code, ConnectError } from '@connectrpc/connect';
import { Download, Package, RefreshCw } from 'lucide-react';
import { workflowArtifactClient } from './api';
import { Loading, PanelError, privateQuery } from './RepositoryUI';
import { DataTable } from './DataTable';
import { WorkflowFormat, WorkflowRunState, type WorkflowRun, type WorkflowArtifact } from './gen/golf/v1/golf_pb';

function boundedCount(value:string,max:bigint,min=0n){return value.length<=20&&/^(0|[1-9][0-9]*)$/.test(value)&&BigInt(value)>=min&&BigInt(value)<=max;}
function matches(a:WorkflowArtifact,run:WorkflowRun){
 return a.runId===run.id&&a.attemptId===run.attemptId&&/^[a-f0-9]{32}$/.test(a.attemptId)&&a.repositoryId===run.repositoryId&&boundedCount(a.repositoryId,9223372036854775807n,1n)&&a.ownerId===run.ownerId&&boundedCount(a.ownerId,9223372036854775807n,1n)&&a.commitId===run.commitId&&/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(a.commitId)&&a.workflowPath===run.workflowPath&&a.blobId===run.workflowBlobId&&/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(a.blobId)&&a.sourceSha256===run.sourceSha256&&/^[a-f0-9]{64}$/.test(a.sourceSha256)&&/^[a-f0-9]{64}$/.test(a.archiveSha256)&&Number.isInteger(a.fileCount)&&a.fileCount>=1&&a.fileCount<=128&&boundedCount(a.fileBytes,8388608n)&&boundedCount(a.archiveBytes,10485760n,1024n)&&a.createdAt.length<=64&&Number.isFinite(Date.parse(a.createdAt))&&a.downloadPath===`/api/workflow-runs/${run.id}/artifact`;
}

// A successful ordinary GitLab shell run already has current parent authority.
// This is an additional exact read, never an upload, dispatch or public link.
export function WorkflowArtifacts({run,userId,enabled,onAuthorityDenied}:{run:WorkflowRun;userId:string;enabled:boolean;onAuthorityDenied:(error:ConnectError,run:WorkflowRun)=>void}){
 const eligible=run.state===WorkflowRunState.SUCCEEDED&&run.format===WorkflowFormat.GITLAB_CI&&!run.inputContract&&!run.executionBindingId&&(!run.engineCatalog||run.engineCatalog==='golf.workflow.shell.v1');
 const query=useQuery({...privateQuery,queryKey:['workflow-artifact',userId,run.repositoryId,run.ownerId,run.id,run.attemptId,run.commitId,run.workflowBlobId,run.sourceSha256],enabled:enabled&&eligible,
  queryFn:async({signal})=>{try{const response=await workflowArtifactClient.getWorkflowArtifact({runId:run.id},{signal,timeoutMs:12000});signal.throwIfAborted();if(response.artifact&&!matches(response.artifact,run))throw new ConnectError('The build artifact receipt could not be verified.',Code.Internal);return response.artifact??null;}catch(error){signal.throwIfAborted();throw error;}}});
 useEffect(()=>{if(query.error instanceof ConnectError&&[Code.Unauthenticated,Code.PermissionDenied,Code.NotFound].includes(query.error.code))onAuthorityDenied(query.error,run);},[query.error,onAuthorityDenied,run]);
 if(!enabled||!eligible)return null;
 const artifact=query.isSuccess&&!query.error&&!query.isFetching?query.data:null;
 return <section className="browser-panel" aria-label="Build artifacts">
  <div className="browser-panel-heading"><h3><Package size={16} aria-hidden="true"/>Build artifacts</h3><button className="icon-button manual-refresh" aria-label="Refresh build artifact" title="Refresh build artifact" disabled={query.isFetching} onClick={()=>void query.refetch()}><RefreshCw size={16}/></button></div>
  {query.error?<PanelError error={query.error} retry={()=>void query.refetch()}/>:query.isFetching?<Loading label="Checking build artifact access…"/>:query.isSuccess?<DataTable data={artifact?[artifact]:[]} columns={[{id:'name',header:'Artifact',cell:()=> 'Build outputs'},{accessorKey:'fileCount',header:'Files'},{id:'size',header:'Size',cell:({row})=>`${Number(row.original.fileBytes).toLocaleString()} bytes`},{id:'download',header:'',cell:({row})=><a className="icon-button" aria-label="Download artifact" title="Download artifact" href={row.original.downloadPath} download="build-artifacts.tar"><Download size={16}/></a>}]} getRowId={a=>a.archiveSha256} label="Build artifacts" emptyMessage="No build artifact was recorded for this run."/>:null}
  {artifact?<details><summary>Artifact receipt</summary><dl><div><dt>Archive SHA-256</dt><dd><code>{artifact.archiveSha256}</code></dd></div><div><dt>Attempt</dt><dd><code>{artifact.attemptId}</code></dd></div><div><dt>Delivery</dt><dd>Private attachment; this is not a preview or deployment.</dd></div></dl></details>:null}
 </section>;
}
