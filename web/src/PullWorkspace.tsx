import { useMemo } from 'react';
import { useInfiniteQuery } from '@tanstack/react-query';
import { Code, ConnectError } from '@connectrpc/connect';
import { CircleAlert, CircleCheck, CircleDashed, CircleX, ExternalLink, RefreshCw } from 'lucide-react';
import { CommitList } from './CommitList';
import { DataTable } from './DataTable';
import type { DataTableColumn } from './DataTable';
import { repositoryClient, repositoryLink } from './api';
import { ReportedCheckState } from './gen/golf/v1/golf_pb';
import type { PullRequest, PullRequestSelection, ReportedCheck } from './gen/golf/v1/golf_pb';
import type { RepositoryLocation } from './navigation';
import { isCommitID } from './navigation';
import { CopyButton, DateLabel, Loading, More, PanelError, privateQuery, shortSHA } from './RepositoryUI';

type Props = { pull: PullRequest; repositoryId: string; queryKey: readonly unknown[]; location: RepositoryLocation };
const labels: Partial<Record<ReportedCheckState,string>> = {
 [ReportedCheckState.PENDING]:'Pending',[ReportedCheckState.SUCCESS]:'Success',[ReportedCheckState.FAILURE]:'Failure',
 [ReportedCheckState.ERROR]:'Error',[ReportedCheckState.WARNING]:'Warning',[ReportedCheckState.SKIPPED]:'Skipped',
};
const followingPage = (response:{page?:{nextPage:number}}) => {
 const next=response.page?.nextPage||0;return next||undefined;
};
function validatePage(response:{page?:{nextPage:number}},current:number) {
 const next=response.page?.nextPage||0;
 if(next&&(!Number.isInteger(next)||next<=current||next>10000))throw new ConnectError('The page continuation is invalid. Refresh this comparison.',Code.Unavailable);
}
function selection({pull,repositoryId,location}:Props) {
 return {repository:{owner:location.owner,name:location.name},repositoryId,pullRequestId:pull.id,number:pull.number,baseCommitId:pull.base?.commitId||'',headCommitId:pull.head?.commitId||''};
}
function validateCommitSelection(expected:ReturnType<typeof selection>) {
 if(!isCommitID(expected.baseCommitId)||!isCommitID(expected.headCommitId))throw new ConnectError('This pull request has no verified comparison commits.',Code.FailedPrecondition);
}
function validateSelection(observed:PullRequestSelection|undefined,expected:ReturnType<typeof selection>) {
 validateCommitSelection(expected);
 if(!observed||observed.repository?.owner!==expected.repository.owner||observed.repository?.name!==expected.repository.name||observed.repositoryId!==expected.repositoryId||observed.pullRequestId!==expected.pullRequestId||observed.number!==expected.number||observed.baseCommitId!==expected.baseCommitId||observed.headCommitId!==expected.headCommitId)throw new ConnectError('The response does not match this pull request and selected comparison.',Code.FailedPrecondition);
}
export function PullCommits(props:Props) {
 const selected=selection(props);
 const query=useInfiniteQuery({...privateQuery,queryKey:[...props.queryKey,'pull-commits',selected.pullRequestId,selected.baseCommitId,selected.headCommitId],initialPageParam:1,
  queryFn:async({pageParam,signal})=>{
   validateCommitSelection(selected);
   const response=await repositoryClient.listPullRequestCommits({selection:selected,page:{page:pageParam,limit:20}},{signal,timeoutMs:8000});validateSelection(response.selection,selected);validatePage(response,pageParam);
   if(response.commits.some(commit=>!isCommitID(commit.sha)||commit.sha.length!==selected.headCommitId.length))throw new ConnectError('The commit page contains invalid object metadata.',Code.Unavailable);
   return response;
  },getNextPageParam:followingPage});
 const commits=query.isSuccess&&(!query.isFetching||query.isFetchingNextPage)?[...new Map(query.data.pages.flatMap(page=>page.commits).map(commit=>[commit.sha,commit])).values()]:[];
 return <section className="browser-panel commit-history" aria-labelledby="pull-commits-title"><div className="browser-panel-heading"><h2 id="pull-commits-title">Commits</h2><button className="icon-button manual-refresh" aria-label="Refresh PR commits" disabled={query.isFetching} onClick={()=>void query.refetch()}><RefreshCw size={16}/></button></div>
  {query.isError?<PanelError error={query.error} retry={()=>void query.refetch()}/>:!query.isSuccess||query.isFetching&&!query.isFetchingNextPage?<Loading label="Reading PR commits…"/>:<><CommitList commits={commits} location={props.location}/>{!commits.length?<div className="empty-state"><CircleDashed size={24}/><h3>No commits returned for this comparison.</h3></div>:null}<div className="list-footer"><span>{commits.length} loaded commits{query.hasNextPage?' · More available':''}</span><More hasMore={query.hasNextPage} loading={query.isFetching} load={()=>void query.fetchNextPage()} label="PR commits"/></div></>}
  <p className="panel-footnote">Native PR commit history for the selected comparison. Commit links open their exact diff; author dates preserve native order.</p>
 </section>;
}
function CheckState({state}:{state:ReportedCheckState}) {
 const Icon=state===ReportedCheckState.SUCCESS?CircleCheck:state===ReportedCheckState.FAILURE||state===ReportedCheckState.ERROR?CircleX:state===ReportedCheckState.WARNING?CircleAlert:CircleDashed;
 return <span className={`reported-check-state check-${labels[state]?.toLowerCase()||'unknown'}`}><Icon size={15} aria-hidden="true"/>{labels[state]||'Unknown'}</span>;
}
export function PullChecks(props:Props) {
 const selected=selection(props);
 const query=useInfiniteQuery({...privateQuery,queryKey:[...props.queryKey,'pull-checks',selected.pullRequestId,selected.baseCommitId,selected.headCommitId],initialPageParam:1,
  queryFn:async({pageParam,signal})=>{
   validateCommitSelection(selected);
   const response=await repositoryClient.listPullRequestChecks({selection:selected,page:{page:pageParam,limit:20}},{signal,timeoutMs:8000});validateSelection(response.selection,selected);validatePage(response,pageParam);
   if(response.checks.some(check=>!labels[check.state]||!check.context||!(/^[1-9][0-9]{0,18}$/).test(check.id)||BigInt(check.id)>9223372036854775807n))throw new ConnectError('The check page contains invalid status metadata.',Code.Unavailable);
   return response;
  },getNextPageParam:followingPage});
 const checks=query.isSuccess&&(!query.isFetching||query.isFetchingNextPage)?[...new Map(query.data.pages.flatMap(page=>page.checks).map(check=>[check.id,check])).values()]:[];
 const changedPages=new Set(checks.map(check=>check.context)).size!==checks.length;
 const columns=useMemo<DataTableColumn<ReportedCheck>[]>(()=>[
  {id:'context',accessorFn:check=>`${check.context} ${check.description}`,header:'Check',cell:({row})=><div className="table-primary"><strong>{row.original.context}</strong>{row.original.description?<span className="table-description">{row.original.description}</span>:null}</div>},
  {id:'state',accessorFn:check=>labels[check.state]||'Unknown',header:'Reported result',cell:({row})=><CheckState state={row.original.state}/>},
  {id:'publisher',accessorFn:check=>check.creator?.login||'Unavailable',header:'Reported by'},
  {accessorKey:'updatedAt',header:'Reported',cell:({row})=><DateLabel value={row.original.updatedAt}/>},
  {id:'details',header:'',enableSorting:false,enableGlobalFilter:false,cell:({row})=>{const url=repositoryLink(row.original.targetUrl);return url?<a className="icon-button" href={url} target="_blank" rel="noopener noreferrer" aria-label={`Open details for ${row.original.context}`} title="Open reported details"><ExternalLink size={15}/></a>:<span className="muted">—</span>;}}
 ],[]);
 return <section className="browser-panel" aria-labelledby="pull-checks-title"><div className="browser-panel-heading"><h2 id="pull-checks-title">Checks</h2><div className="panel-actions"><code title={selected.headCommitId}>{shortSHA(selected.headCommitId)}</code><CopyButton text={selected.headCommitId} label="Copy checked commit SHA"/><button className="icon-button manual-refresh" aria-label="Refresh PR checks" disabled={query.isFetching} onClick={()=>void query.refetch()}><RefreshCw size={16}/></button></div></div>
  <details className="metadata-details panel-disclosure"><summary>Check sources and permissions</summary><p className="panel-footnote">These are the latest native statuses per context reported to this repository for the selected PR head. Fork-only statuses and detailed check-run annotations are not included. Reported success, skipped or pending status is not trusted execution evidence or Golf merge readiness. Publishers may be repository writers.</p></details>
  {query.isError?<PanelError error={query.error} retry={()=>void query.refetch()}/>:!query.isSuccess||query.isFetching&&!query.isFetchingNextPage?<Loading label="Reading reported checks…"/>:changedPages?<PanelError error={new Error('Check contexts changed while paging. Refresh the pages before using these observations.')} retry={()=>void query.refetch()}/>:<><DataTable data={checks} columns={columns} getRowId={check=>check.id} label="checks" emptyMessage="No reported checks in the loaded pages."/><div className="list-footer"><span>{checks.length} loaded checks{query.hasNextPage?' · More available':''}</span><More hasMore={query.hasNextPage} loading={query.isFetching} load={()=>void query.fetchNextPage()} label="checks"/></div></>}
  <p className="panel-footnote">Reported status observations · protected merge enforcement remains unavailable.</p>
 </section>;
}
