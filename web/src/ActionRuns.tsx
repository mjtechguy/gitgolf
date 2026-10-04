import { useMemo } from 'react';
import { useInfiniteQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { Code, ConnectError } from '@connectrpc/connect';
import { GitCommitHorizontal, RefreshCw } from 'lucide-react';
import { actionRunClient } from './api';
import { type ActionRunSummary } from './gen/golf/v1/golf_pb';
import { kindName, kindValue, validateActionSummary } from './actionRunReceipts';
import { ActionRunKindBadge, ActionRunStatus, actionDuration } from './ActionRunPresentation';
import { DataTable, type DataTableColumn } from './DataTable';
import { DateLabel, Loading, More, PanelError, privateQuery } from './RepositoryUI';
import { useLiveStatus } from './RepositoryLive';
import { repositoryOptions, type RepositoryLocation } from './navigation';
export function ActionRuns({userId,repositoryId,location,signingOut}:{userId:string;repositoryId:string;location:RepositoryLocation;signingOut:boolean}){
 const live=useLiveStatus(),{owner,name,actionKind,workflowPath}=location,kind=kindValue(actionKind),limit=25;
 const query=useInfiniteQuery({...privateQuery,queryKey:['action-runs',userId,owner,name,repositoryId,kind,workflowPath||''],enabled:!signingOut,initialPageParam:'',queryFn:async({signal,pageParam})=>{
  const response=await actionRunClient.listActionRuns({repository:{owner,name},repositoryId,kindFilter:kind,workflowPath:workflowPath||'',limit,cursor:pageParam},{signal,timeoutMs:12000});signal.throwIfAborted();
  if(response.repositoryId!==repositoryId||response.runs.length>limit||response.nextCursor.length>8192||response.nextCursor&&response.nextCursor===pageParam)throw new ConnectError('The run inventory does not match its repository or page boundary.',Code.FailedPrecondition);
  const seen=new Set<string>();for(const run of response.runs){validateActionSummary(run,repositoryId,kind,workflowPath);const key=`${run.ref!.kind}:${run.ref!.id}`;if(seen.has(key))throw new ConnectError('The run inventory contains a duplicate typed identity.',Code.FailedPrecondition);seen.add(key)}return response;
 },getNextPageParam:response=>response.nextCursor||undefined,refetchInterval:live==='live'?false:5000});
 const loading=query.isPending||query.isFetching&&!query.isFetchingNextPage;
 const rows=query.isSuccess&&!query.error&&!loading&&!signingOut?[...new Map(query.data.pages.flatMap(page=>page.runs).map(run=>[`${run.ref!.kind}:${run.ref!.id}`,run])).values()]:[];
 const columns=useMemo<DataTableColumn<ActionRunSummary>[]>(()=>[
  {id:'run',header:'Run',accessorFn:run=>`${run.title} ${run.state} ${run.trigger} ${run.eventRef} ${run.modelId} ${run.ref!.id} ${run.commitId}`,cell:({row})=>{const run=row.original;return <div className="workflow-run-row"><ActionRunStatus state={run.state} compact/><div><Link {...repositoryOptions(location,{run:run.ref!.id,runKind:kindName(run.ref!.kind),step:undefined})}>{run.title}</Link><small className="action-run-context"><ActionRunKindBadge kind={run.ref!.kind}/><span>{run.trigger||'Trigger not recorded'}{run.eventRef?` · ${run.eventRef}`:''} · {run.ref!.id.slice(0,8)}</span></small><Link className="workflow-run-commit" {...repositoryOptions(location,{view:'commits',commit:run.commitId,run:undefined,runKind:undefined})}><GitCommitHorizontal size={13}/><code title={run.commitId}>{run.commitId.slice(0,12)}</code></Link></div></div>}},
  {id:'created',header:'Created',accessorFn:run=>run.createdAt,cell:({row})=><><DateLabel value={row.original.createdAt}/><small>{actionDuration(row.original)}</small></>},
 ],[location]);
 return <section className="browser-panel credential-list-panel workflow-runs-panel" aria-labelledby="action-runs-title"><div className="browser-panel-heading"><h2 id="action-runs-title">{workflowPath?'Workflow runs':actionKind==='coding-task'?'Coding tasks':actionKind==='review'?'PR reviews':actionKind==='workflow'?'Workflow runs':'All runs'}</h2><button className="button secondary manual-refresh" disabled={query.isFetching||signingOut} onClick={()=>void query.refetch()}><RefreshCw size={15}/>Refresh runs</button></div>
 {query.error?<PanelError error={query.error} retry={()=>void query.refetch()}/>:loading?<Loading label="Reading run history…"/>:<DataTable label="Action runs" data={rows} columns={columns} getRowId={run=>`${run.ref!.kind}:${run.ref!.id}`} emptyMessage="No visible runs match this server filter."/>}
 <More hasMore={Boolean(query.hasNextPage)} loading={query.isFetchingNextPage||signingOut} load={()=>void query.fetchNextPage()} label="action runs"/><p className="panel-footnote">Run kind and workflow choices filter server history. Search and sorting apply to loaded rows. Private coding tasks require your ownership and current repository write access; no complete history count is claimed.</p></section>;
}
