import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { Code, ConnectError } from '@connectrpc/connect';
import { ArrowLeft, ArrowDownToLine, CheckCircle2, CircleDashed, CircleSlash, Clock3, Download, GitCommitHorizontal, LoaderCircle, RefreshCw, Search, XCircle } from 'lucide-react';
import { workflowRunClient, errorMessage } from './api';
import { WorkflowRunOrigin, WorkflowRunState, WorkflowStepState, type WorkflowStepProgress, type WorkflowRun } from './gen/golf/v1/golf_pb';
import { DataTable, type DataTableColumn } from './DataTable';
import { DateLabel, Loading, More, PanelError, privateQuery } from './RepositoryUI';
import { repositoryOptions } from './navigation';

export function runState(state: WorkflowRunState) { return WorkflowRunState[state]?.toLowerCase().replaceAll('_', ' ') || 'unknown'; }
function RunState({state}:{state:WorkflowRunState}) {
 const Icon = state===WorkflowRunState.SUCCEEDED?CheckCircle2:state===WorkflowRunState.FAILED?XCircle:state===WorkflowRunState.RUNNING?LoaderCircle:state===WorkflowRunState.CANCELLED?CircleSlash:CircleDashed;
 return <span className={`run-state run-state-${runState(state)}`}><Icon size={16} className={state===WorkflowRunState.RUNNING?'spin':undefined}/>{runState(state)}</span>;
}
export function WorkflowRuns({ userId, owner, name, signingOut }: { userId: string; owner: string; name: string; signingOut: boolean }) {
 const query = useInfiniteQuery({ ...privateQuery, queryKey: ['workflow-runs', userId, owner, name], enabled: !signingOut, initialPageParam: 1,
  queryFn: ({ signal, pageParam }) => workflowRunClient.listWorkflowRuns({ repository: { owner, name }, page: { page: pageParam, limit: 20 } }, { signal, timeoutMs: 12_000 }),
  getNextPageParam: (page, _pages, current) => page.page?.nextPage && page.page.nextPage > current ? page.page.nextPage : undefined });
 const loading = query.isPending || (query.isFetching && !query.isFetchingNextPage);
 const rows = query.isSuccess && !query.error && !loading && !signingOut ? [...new Map(query.data.pages.flatMap(page => page.runs).map(run => [run.id, run])).values()] : [];
 const columns = useMemo<DataTableColumn<WorkflowRun>[]>(() => [
  { id: 'workflow', accessorFn: row => row.workflowPath, header: 'Workflow', cell: ({ row }) => <><Link className="text-button" {...repositoryOptions({owner,name},{view:'actions',run:row.original.id})}>{row.original.workflowPath}</Link><small>{row.original.id.slice(0,8)}</small></> },
  { id: 'origin', accessorFn: row => row.origin === WorkflowRunOrigin.PUSH ? 'Push' : row.origin === WorkflowRunOrigin.MANUAL ? 'Manual' : 'Unknown', header: 'Trigger' },
  { id: 'state', accessorFn: row => runState(row.state), header: 'State', cell:({row})=><RunState state={row.original.state}/> },
  { accessorKey: 'commitId', header: 'Commit', cell: ({ row }) => <Link {...repositoryOptions({owner,name},{view:'commits',commit:row.original.commitId})}><code title={row.original.commitId}>{row.original.commitId.slice(0,12)}</code></Link> },
  { accessorKey: 'createdAt', header: 'Created', cell: ({ row }) => <DateLabel value={row.original.createdAt} /> },
  { accessorKey: 'runnerId', header: 'Worker', cell: ({ row }) => row.original.runnerId || 'Awaiting assignment' },
 ], [owner,name]);
 return <section className="browser-panel credential-list-panel" aria-labelledby="workflow-runs-title">
  <div className="browser-panel-heading"><h2 id="workflow-runs-title">Workflow runs</h2><button className="button secondary manual-refresh" disabled={signingOut || query.isFetching} onClick={() => void query.refetch()}><RefreshCw size={15} />Refresh runs</button></div>
  {query.error ? <PanelError error={query.error} retry={() => void query.refetch()} /> : loading ? <Loading label="Loading runs…" /> : <DataTable label="Workflow runs" data={rows} columns={columns} getRowId={row => row.id} emptyMessage="No workflow runs." />}
  <More hasMore={Boolean(query.hasNextPage)} loading={query.isFetchingNextPage || signingOut} load={() => void query.fetchNextPage()} label="workflow runs" />
 </section>;
}

function elapsed(run:WorkflowRun) {
 if(!run.startedAt)return 'Not started';
 if(!run.finishedAt)return 'In progress';
 const seconds=Math.floor((Date.parse(run.finishedAt)-Date.parse(run.startedAt))/1000);
 return Number.isFinite(seconds)&&seconds>=0?`${Math.floor(seconds/60)}m ${seconds%60}s`:'Unavailable';
}
function stepLabel(state:WorkflowStepState){return WorkflowStepState[state]?.toLowerCase()||'unknown';}
function stepDuration(step:WorkflowStepProgress){
 if(!step.startedAt)return stepLabel(step.state);
 if(!step.finishedAt)return step.state===WorkflowStepState.INTERRUPTED?'Interrupted':'In progress';
 const seconds=Math.floor((Date.parse(step.finishedAt)-Date.parse(step.startedAt))/1000);
 return Number.isFinite(seconds)&&seconds>=0?`${seconds}s`:'Duration unavailable';
}
function StepState({step}:{step:WorkflowStepProgress}){
 const Icon=step.state===WorkflowStepState.SUCCEEDED?CheckCircle2:step.state===WorkflowStepState.FAILED?XCircle:step.state===WorkflowStepState.RUNNING?LoaderCircle:step.state===WorkflowStepState.SKIPPED||step.state===WorkflowStepState.INTERRUPTED?CircleSlash:CircleDashed;
 return <span className={`run-state run-state-${stepLabel(step.state)}`} title={stepLabel(step.state)}><Icon size={16} aria-label={stepLabel(step.state)} className={step.state===WorkflowStepState.RUNNING?'spin':undefined}/></span>;
}
function LogHighlight({text,search}:{text:string;search:string}) {
 if(!search)return text;
 // Bound DOM work without dropping log text; browser Find can reach further matches.
 const lower=text.toLowerCase(),needle=search.toLowerCase(),parts=[];let cursor=0;
 for(let matches=0;matches<200;matches++) {
  const start=lower.indexOf(needle,cursor);if(start<0)break;
  parts.push(text.slice(cursor,start),<mark key={start}>{text.slice(start,start+search.length)}</mark>);cursor=start+search.length;
 }
 parts.push(text.slice(cursor));return parts;
}
function WorkflowRunLogs({userId,owner,name,runId,truncated,enabled,stepIndex}:{userId:string;owner:string;name:string;runId:string;truncated:boolean;enabled:boolean;stepIndex?:number}) {
 const [search,setSearch]=useState('');const searchId=useId();const end=useRef<HTMLSpanElement>(null);
 const query=useInfiniteQuery({...privateQuery,queryKey:['workflow-run-logs',userId,owner,name,runId,stepIndex??'all'],enabled,initialPageParam:0n,
  queryFn:async({signal,pageParam})=>{
   const page=await workflowRunClient.getWorkflowRunLogs({runId,afterSequence:pageParam,stepIndex},{signal,timeoutMs:12_000});
   let sequence=pageParam;
   for(const chunk of page.logs){if(chunk.sequence<=sequence||chunk.sequence>9223372036854775807n)throw new ConnectError('The log page has an invalid sequence. Refresh before continuing.',Code.Internal);sequence=chunk.sequence;}
   if(page.logs.length>16||page.hasMore&&!page.logs.length)throw new ConnectError('The log page cannot be continued safely.',Code.Internal);
   return page;
  },getNextPageParam:page=>page.hasMore?page.logs.at(-1)?.sequence:undefined});
 const loading=query.isPending||query.isFetching&&!query.isFetchingNextPage;
 const text=query.data?.pages.flatMap(page=>page.logs).map(chunk=>chunk.text).join('')||'';
 const denied=Boolean(query.error)||!enabled;
 const matches=search?text.toLowerCase().split(search.toLowerCase()).length-1:0;
 function download(){
  if(denied||loading||!text)return;
  const url=URL.createObjectURL(new Blob([text],{type:'text/plain;charset=utf-8'}));
  const link=document.createElement('a');link.href=url;link.download=`golf-run-${runId}${stepIndex!==undefined?'-step-'+(stepIndex+1):''}${query.hasNextPage?'-loaded':''}.log`;link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
 }
 return <section className="browser-panel workflow-log-panel" aria-labelledby="workflow-log-title">
  <div className="browser-panel-heading"><h2 id="workflow-log-title">Run log</h2><div className="row-actions"><button className="icon-button manual-refresh" aria-label="Refresh run log" title="Refresh run log" disabled={query.isFetching||!enabled} onClick={()=>void query.refetch()}><RefreshCw size={16}/></button><button className="icon-button" aria-label="Download loaded log" title="Download loaded log" disabled={denied||loading||!text} onClick={download}><Download size={16}/></button><button className="icon-button" aria-label="Go to end of loaded log" title="Go to end of loaded log" disabled={denied||loading||!text} onClick={()=>end.current?.scrollIntoView({block:'end'})}><ArrowDownToLine size={16}/></button></div></div>
  <div className="repository-list-controls"><div className="search-input"><label className="sr-only" htmlFor={searchId}>Search loaded run log</label><Search size={16} aria-hidden="true"/><input id={searchId} type="search" aria-label="Search loaded run log" placeholder="Search loaded log…" value={search} onChange={event=>setSearch(event.target.value)} disabled={denied}/></div><span className="loaded-list-count" role="status">{search?`${matches} match${matches===1?'':'es'}${matches>200?' · first 200 highlighted':''}`:query.hasNextPage?'More output available':'Loaded output'}</span></div>
  {query.error?<PanelError error={query.error} retry={()=>void query.refetch()}/>:loading?<Loading label="Loading run log…"/>:null}
  {!denied&&query.isSuccess?<div hidden={loading}><pre className="source-code execution-log" tabIndex={0} aria-label="Workflow run log"><LogHighlight text={text||'No log output yet.'} search={search}/><span ref={end}/></pre></div>:null}
  {!denied&&!loading?<More hasMore={Boolean(query.hasNextPage)} loading={query.isFetchingNextPage} load={()=>void query.fetchNextPage()} label="log output"/>:null}
  {!denied&&!loading&&(truncated||query.data?.pages.some(page=>page.truncated))?<p className="panel-footnote" role="status">Output reached the worker limit. The stored log is truncated; loading more cannot recover omitted output.</p>:null}
  <p className="panel-footnote">Search and download cover loaded chunks only.</p>
 </section>;
}

export function WorkflowRunPage({userId,owner,name,repositoryId,runId,signingOut,selectedStep}:{userId:string;owner:string;name:string;repositoryId:string;runId:string;signingOut:boolean;selectedStep?:number}) {
 const [notice,setNotice]=useState('');const [pending,setPending]=useState(false);
 const controller=useRef<AbortController|null>(null);const alive=useRef(true);
 useEffect(()=>{alive.current=true;return()=>{alive.current=false;controller.current?.abort();};},[]);
 useEffect(()=>{if(signingOut){controller.current?.abort();setNotice('');}},[signingOut]);
 const query=useQuery({...privateQuery,queryKey:['workflow-run',userId,owner,name,runId],enabled:!signingOut,
  queryFn:async({signal})=>{const response=await workflowRunClient.getWorkflowRun({runId},{signal,timeoutMs:12_000});if(!response.run||response.run.id!==runId||response.run.repositoryId!==repositoryId)throw new ConnectError('This run does not belong to the selected repository.',Code.NotFound);return response.run;}});
 const run=query.isSuccess&&!query.error&&!signingOut?query.data:undefined;
 async function cancel(){
  if(!run||!run.canCancel||pending||signingOut||query.isFetching)return;
  const observed=run;const request=new AbortController();controller.current=request;setPending(true);setNotice('');
  try{const result=await workflowRunClient.cancelWorkflowRun({runId:observed.id,expectedVersion:observed.version},{signal:request.signal,timeoutMs:12_000});
   if(!alive.current||request.signal.aborted)return;
   if(result.run?.id!==observed.id||result.run.repositoryId!==repositoryId||result.run.state!==WorkflowRunState.CANCELLED)throw new Error('Cancellation outcome could not be verified.');
   setNotice('Run cancelled. Its attempt credential is revoked; the worker stops when it observes cancellation.');await query.refetch();
  }catch(error){if(alive.current&&!request.signal.aborted)setNotice(`${errorMessage(error instanceof Error?error:new Error('Cancellation could not be confirmed.'))} Inspect the run before another action. No automatic retry was made.`);}
  finally{if(controller.current===request)controller.current=null;if(alive.current)setPending(false);}
 }
 return <section className="page-stack" aria-label="Workflow run workspace">
  <Link className="text-button" {...repositoryOptions({owner,name},{view:'actions'})}><ArrowLeft size={16}/>All workflow runs</Link>
  {query.error?<PanelError error={query.error} retry={()=>void query.refetch()}/>:!run?<Loading label="Loading selected run…"/>:null}
  {run?<><div hidden={query.isFetching} className="page-stack">
   <header className="discussion-summary workflow-run-summary"><div><h2>{run.workflowPath}</h2><p><RunState state={run.state}/><span>{run.origin===WorkflowRunOrigin.PUSH?'Push':run.origin===WorkflowRunOrigin.MANUAL?'Manual':'Unknown trigger'}{run.eventRef?` · ${run.eventRef}`:''}</span><span><Clock3 size={14}/>{elapsed(run)}</span></p></div><div className="row-actions"><button className="icon-button manual-refresh" aria-label="Refresh selected run" title="Refresh selected run" disabled={pending||query.isFetching||signingOut} onClick={()=>void query.refetch()}><RefreshCw size={16}/></button>{run.canCancel?<button className="button secondary" disabled={pending||signingOut||query.isFetching} onClick={()=>void cancel()}>Cancel run</button>:null}</div></header>
   <section className="browser-panel workflow-run-metadata" aria-label="Run summary"><dl><div><dt>Commit</dt><dd><Link {...repositoryOptions({owner,name},{view:'commits',commit:run.commitId})}><GitCommitHorizontal size={14}/><code title={run.commitId}>{run.commitId.slice(0,12)}</code></Link></dd></div><div><dt>Created</dt><dd><DateLabel value={run.createdAt}/></dd></div><div><dt>Worker</dt><dd>{run.runnerId||'Awaiting assignment'}</dd></div><div><dt>Exit code</dt><dd>{run.exitCode??'Not reported'}</dd></div></dl><details><summary>Execution receipt</summary><dl><div><dt>Run</dt><dd><code>{run.id}</code></dd></div><div><dt>Workflow source</dt><dd><Link {...repositoryOptions({owner,name},{ref:run.commitId,path:run.workflowPath},'file')}>{run.workflowPath}</Link></dd></div><div><dt>Workflow blob</dt><dd><code>{run.workflowBlobId}</code></dd></div><div><dt>Source archive</dt><dd><code>{run.sourceSha256}</code></dd></div>{run.origin===WorkflowRunOrigin.PUSH?<><div><dt>Event</dt><dd>{run.repositoryEventId}</dd></div><div><dt>Automation grant</dt><dd><code>{run.automationGrantId}</code></dd></div></>:null}</dl></details></section>
   {run.reason?<p className="panel-footnote">{run.reason}</p>:null}
   <div className="automation-run-layout"><aside className="automation-job-navigation" aria-label="Jobs and steps">
    <h3>Jobs</h3><strong>{run.progress?.name||run.progress?.jobId||'Job'}</strong>{run.progress?.stage?<span className="muted">{run.progress.stage}</span>:null}
    <Link className="automation-step-link" aria-current={selectedStep===undefined?'page':undefined} {...repositoryOptions({owner,name},{view:'actions',run:runId,step:undefined})}>All run output</Link>
    {run.progress?.steps.length?<ol>{run.progress.steps.map(step=><li key={step.index}>{step.startedAt?<Link className="automation-step-link" aria-current={selectedStep===step.index?'page':undefined} {...repositoryOptions({owner,name},{view:'actions',run:runId,step:step.index})}><StepState step={step}/><span>{step.name}<small>{stepDuration(step)}</small></span></Link>:<div className="automation-step-link"><StepState step={step}/><span>{step.name}<small>{stepLabel(step.state)}</small></span></div>}</li>)}</ol>:<p className="field-help">Step events were not recorded for this run.</p>}
    {run.progress&&!run.progress.eventsRecorded&&run.state!==WorkflowRunState.QUEUED&&run.state!==WorkflowRunState.RUNNING?<p className="field-help">This run has no recorded step outcomes. Its overall result does not establish individual step results.</p>:null}
   </aside><div className="automation-run-output">
    {selectedStep!==undefined?<h3>{run.progress?.steps.find(step=>step.index===selectedStep)?.name||'Selected step'}</h3>:null}
    {selectedStep!==undefined&&!run.progress?.steps.find(step=>step.index===selectedStep)?.startedAt?<p className="panel-footnote" role="status">The selected step has no recorded output. Choose all run output or a step that started.</p>:<WorkflowRunLogs key={selectedStep??'all'} userId={userId} owner={owner} name={name} runId={runId} stepIndex={selectedStep} truncated={run.logsTruncated} enabled={!query.isFetching&&!signingOut}/>}
   </div></div>
  </div>{query.isFetching?<Loading label="Checking run access…"/>:null}</>:null}
  {notice&&!signingOut?<p role="status" className="panel-footnote">{notice}</p>:null}
 </section>;
}
