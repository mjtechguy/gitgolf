import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { Code, ConnectError } from '@connectrpc/connect';
import { ArrowLeft, ArrowDownToLine, CheckCircle2, CircleDashed, CircleSlash, Clock3, Download, GitCommitHorizontal, LoaderCircle, RefreshCw, Search, XCircle } from 'lucide-react';
import { forgetPrivateQueries } from './queryClient';
import { workflowRunClient, errorMessage } from './api';
import { WorkflowOutputState, WorkflowRunOrigin, WorkflowRunState, WorkflowStepState, type WorkflowStepProgress, type WorkflowRun, type WorkflowJobInstance } from './gen/golf/v1/golf_pb';
import { DataTable, type DataTableColumn } from './DataTable';
import { DateLabel, Loading, More, PanelError, privateQuery } from './RepositoryUI';
import { isRunID, isCommitID, isWorkflowJobInstanceID, isWorkflowStepID, repositoryOptions, type RepositoryLocation } from './navigation';
import { sourcePath, sourceRepositoryID } from './sourceReads';
import { WorkflowArtifacts } from './WorkflowArtifacts';
import { useLiveStatus } from './RepositoryLive';

function useWideWorkflowLayout() {
 const [wide,setWide]=useState(()=>window.matchMedia('(min-width:701px)').matches);
 useEffect(()=>{const media=window.matchMedia('(min-width:701px)');const changed=()=>setWide(media.matches);media.addEventListener('change',changed);return()=>media.removeEventListener('change',changed);},[]);
 return wide;
}

export function runState(state: WorkflowRunState) { return WorkflowRunState[state]?.toLowerCase().replaceAll('_', ' ') || 'unknown'; }
function RunState({state,compact=false}:{state:WorkflowRunState;compact?:boolean}) {
 const Icon = state===WorkflowRunState.SUCCEEDED?CheckCircle2:state===WorkflowRunState.FAILED?XCircle:state===WorkflowRunState.RUNNING?LoaderCircle:state===WorkflowRunState.CANCELLED?CircleSlash:CircleDashed;
 return <span title={runState(state)} className={`run-state run-state-${runState(state)}`}><Icon size={16} aria-hidden="true" className={state===WorkflowRunState.RUNNING?'spin':undefined}/><span className={compact?'sr-only':undefined}>{runState(state)}</span></span>;
}
export function WorkflowRuns({ userId, owner, name, signingOut, workflowPath }: { userId: string; owner: string; name: string; signingOut: boolean; workflowPath?:string }) {
 const query = useInfiniteQuery({ ...privateQuery, queryKey: ['workflow-runs', userId, owner, name], enabled: !signingOut, initialPageParam: 1,
  queryFn: ({ signal, pageParam }) => workflowRunClient.listWorkflowRuns({ repository: { owner, name }, page: { page: pageParam, limit: 20 } }, { signal, timeoutMs: 12_000 }),
  getNextPageParam: (page, _pages, current) => page.page?.nextPage && page.page.nextPage > current ? page.page.nextPage : undefined });
 const loading = query.isPending || (query.isFetching && !query.isFetchingNextPage);
 const rows = query.isSuccess && !query.error && !loading && !signingOut ? [...new Map(query.data.pages.flatMap(page => page.runs).map(run => [run.id, run])).values()] : [];
 const filteredRows = workflowPath ? rows.filter(run=>run.workflowPath===workflowPath) : rows;
 const columns = useMemo<DataTableColumn<WorkflowRun>[]>(() => [
  { id: 'workflow', accessorFn: row => `${row.workflowPath} ${runState(row.state)} ${row.eventRef} ${row.id} ${row.commitId}`, header: 'Run', cell: ({ row }) => <div className="workflow-run-row"><RunState state={row.original.state} compact/><div><Link {...repositoryOptions({owner,name},{view:'actions',run:row.original.id})}>{row.original.workflowPath}</Link><small>{row.original.origin===WorkflowRunOrigin.PUSH?'Push':row.original.origin===WorkflowRunOrigin.MANUAL?'Manual':'Unknown trigger'}{row.original.eventRef?` · ${row.original.eventRef}`:''} · {row.original.id.slice(0,8)}</small><Link className="workflow-run-commit" {...repositoryOptions({owner,name},{view:'commits',commit:row.original.commitId})}><GitCommitHorizontal size={13}/><code title={row.original.commitId}>{row.original.commitId.slice(0,12)}</code></Link></div></div> },
  { accessorKey: 'createdAt', header: 'Created', cell: ({ row }) => <><DateLabel value={row.original.createdAt}/><small>{elapsed(row.original)}</small></> },
 ], [owner,name]);
 return <section className="browser-panel credential-list-panel workflow-runs-panel" aria-labelledby="workflow-runs-title">
  <div className="browser-panel-heading"><h2 id="workflow-runs-title">{workflowPath?'Selected workflow runs':'Workflow runs'}</h2><button className="button secondary manual-refresh" disabled={signingOut || query.isFetching} onClick={() => void query.refetch()}><RefreshCw size={15} />Refresh runs</button></div>
  {query.error ? <PanelError error={query.error} retry={() => void query.refetch()} /> : loading ? <Loading label="Loading runs…" /> : <DataTable label="Workflow runs" data={filteredRows} columns={columns} getRowId={row => row.id} emptyMessage={workflowPath?'No runs for this workflow in the loaded pages.':'No workflow runs.'} />}
  {workflowPath?<p className="panel-footnote">Filtering loaded runs for <code>{workflowPath}</code>. Load more to inspect earlier server pages; this is not a complete history count.</p>:null}
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
function stepDuration(step:Pick<WorkflowStepProgress,'state'|'startedAt'|'finishedAt'>){
 if(!step.startedAt)return stepLabel(step.state);
 if(!step.finishedAt)return step.state===WorkflowStepState.INTERRUPTED?'Interrupted':step.state===WorkflowStepState.RUNNING?'In progress':'Duration not recorded';
 const seconds=Math.floor((Date.parse(step.finishedAt)-Date.parse(step.startedAt))/1000);
 return Number.isFinite(seconds)&&seconds>=0?`${seconds}s`:'Duration unavailable';
}
function StepState({step}:{step:Pick<WorkflowStepProgress,'state'>}){
 const Icon=step.state===WorkflowStepState.SUCCEEDED?CheckCircle2:step.state===WorkflowStepState.FAILED?XCircle:step.state===WorkflowStepState.RUNNING?LoaderCircle:step.state===WorkflowStepState.SKIPPED||step.state===WorkflowStepState.INTERRUPTED?CircleSlash:CircleDashed;
 return <span className={`run-state run-state-${stepLabel(step.state)}`} title={stepLabel(step.state)}><Icon size={16} aria-label={stepLabel(step.state)} className={step.state===WorkflowStepState.RUNNING?'spin':undefined}/></span>;
}

const actionsCatalog='golf.workflow.act.v0.2.89.linux.v1';
const actionsInputsCatalog='golf.workflow.act.v0.2.89.linux.v2';
const manualInputsContract='golf.workflow.dispatch.inputs.v1';
const isActionsCatalog=(catalog:string)=>catalog===actionsCatalog||catalog===actionsInputsCatalog;
const actionsEngineCommit='4f411281417e88660bea1c1a1749aa71ae0bd60f';
const graphFailure=():never=>{throw new ConnectError('The recorded job graph does not match this run and source receipt.',Code.FailedPrecondition)};
const graphText=(value:string,max=255)=>Boolean(value)&&new TextEncoder().encode(value).length<=max&&!/[\p{Cc}\uD800-\uDFFF]/u.test(value);
const graphDate=(value:string|undefined)=>value===undefined||Boolean(value)&&Number.isFinite(Date.parse(value));
function validateJobGraph(run:WorkflowRun){
 const placement=run.runnerPlacement;
 const placementVersion=(value:string)=>/^(0|[1-9][0-9]{0,18})$/.test(value)&&BigInt(value)<=9223372036854775807n;
 if(placement&&(!placementVersion(placement.placementVersion)||(placement.legacyUnbound?placement.poolId!==''||placement.poolVersion!=='':!isRunID(placement.poolId)||!placementVersion(placement.poolVersion)||placement.poolVersion==='0'||placement.placementVersion==='0')))throw new ConnectError('The recorded runner placement could not be verified.',Code.FailedPrecondition);
 const typed=run.engineCatalog===actionsInputsCatalog;
 const inputDigests=[run.schemaSha256,run.submittedSha256,run.effectiveSha256];
 if(typed?run.origin!==WorkflowRunOrigin.MANUAL||run.inputContract!==manualInputsContract||inputDigests.some(value=>!/^[a-f0-9]{64}$/.test(value)):Boolean(run.inputContract)||inputDigests.some(Boolean))graphFailure();
 const state=run.outputState;
 if(state===WorkflowOutputState.WITHHELD||state===WorkflowOutputState.REDACTED){if(!isActionsCatalog(run.engineCatalog)||!isRunID(run.executionBindingId)||!sourceRepositoryID(run.executionBindingVersion)||state===WorkflowOutputState.REDACTED&&![WorkflowRunState.SUCCEEDED,WorkflowRunState.FAILED].includes(run.state))graphFailure();}
 else if(![WorkflowOutputState.UNSPECIFIED,WorkflowOutputState.ORDINARY].includes(state)||run.executionBindingId||run.executionBindingVersion)graphFailure();
 if(!run.engineCatalog||run.engineCatalog==='golf.workflow.shell.v1'){if(run.jobs.length||run.engineCommit)graphFailure();return run;}
 if(!isActionsCatalog(run.engineCatalog)||run.engineCommit!==actionsEngineCommit||!sourceRepositoryID(run.ownerId)||!sourceRepositoryID(run.version)||!isCommitID(run.commitId)||!isCommitID(run.workflowBlobId)||run.workflowBlobId.length!==run.commitId.length||!sourcePath(run.workflowPath)||!run.workflowPath||!/^[a-f0-9]{64}$/.test(run.sourceSha256)||run.attemptId&&!isWorkflowJobInstanceID(run.attemptId)||run.state===WorkflowRunState.RUNNING&&!run.attemptId||run.progress||run.jobs.length<1||run.jobs.length>12)graphFailure();
 const ids=new Set<string>(),jobIds=new Set(run.jobs.map(job=>job.jobId));let stepCount=0;
 for(const job of run.jobs){
  if(!isWorkflowJobInstanceID(job.instanceId)||ids.has(job.instanceId)||!/^[A-Za-z_][A-Za-z0-9_-]{0,254}$/.test(job.jobId)||!graphText(job.name)||!graphDate(job.startedAt)||!graphDate(job.finishedAt)||job.startedAt&&job.finishedAt&&Date.parse(job.finishedAt)<Date.parse(job.startedAt)||!Number.isInteger(job.state)||job.state<WorkflowStepState.PENDING||job.state>WorkflowStepState.UNRECORDED||job.matrix.length>8||job.needs.length>8||job.steps.length<1||job.steps.length>32||!/^[A-Za-z0-9][A-Za-z0-9._:/-]*@sha256:[a-f0-9]{64}$/.test(job.imageDigest))graphFailure();
  ids.add(job.instanceId);const matrixNames=new Set<string>(),stepIds=new Set<string>();
  for(const entry of job.matrix){if(!/^[A-Za-z_][A-Za-z0-9_-]{0,63}$/.test(entry.name)||matrixNames.has(entry.name)||new TextEncoder().encode(entry.valueJson).length>1024)graphFailure();matrixNames.add(entry.name);try{const value:unknown=JSON.parse(entry.valueJson);if(value!==null&&typeof value!=='string'&&typeof value!=='number'&&typeof value!=='boolean'||typeof value==='number'&&!Number.isFinite(value))graphFailure()}catch{graphFailure()}}
  const needs=new Set<string>();for(const need of job.needs){if(!jobIds.has(need)||need===job.jobId||needs.has(need))graphFailure();needs.add(need);}
  for(const step of job.steps){if(!isWorkflowStepID(step.id)||stepIds.has(step.id)||!graphText(step.name)||!graphDate(step.startedAt)||!graphDate(step.finishedAt)||step.startedAt&&step.finishedAt&&Date.parse(step.finishedAt)<Date.parse(step.startedAt)||!Number.isInteger(step.state)||step.state<WorkflowStepState.PENDING||step.state>WorkflowStepState.UNRECORDED)graphFailure();stepIds.add(step.id);stepCount++;}
 }
 if(stepCount>128)graphFailure();return run;
}
function noJobOutput(job:WorkflowJobInstance,step?:{state:WorkflowStepState}){
 const subject=step?'step':'job',state=step?.state??job.state;
 const outcome=state===WorkflowStepState.SKIPPED?`This ${subject} was skipped. `:state===WorkflowStepState.PENDING?`This ${subject} is pending. `:state===WorkflowStepState.UNRECORDED?`No outcome was recorded for this ${subject}. `:'';
 return `${outcome}The selected job or step has no recorded start or output. ${job.needs.length?`Declared dependencies: ${job.needs.join(', ')}. `:''}Choose all run output or a job/step that started.`;
}
function matrixLabel(job:WorkflowJobInstance){return job.matrix.map(entry=>{const value=JSON.parse(entry.valueJson) as unknown;return `${entry.name}: ${typeof value==='string'?value:entry.valueJson}`}).join(', ');}
function graphOptions(location:RepositoryLocation,runId:string,jobInstanceId?:string,stepId?:string){return repositoryOptions(location,{view:'actions',run:runId,step:undefined,jobInstanceId,stepId});}
function JobGraphNavigation({run,location,selectedJobInstanceId,selectedStepId}:{run:WorkflowRun;location:RepositoryLocation;selectedJobInstanceId?:string;selectedStepId?:string}){
 return <><h3>Jobs</h3><Link className="automation-step-link" aria-current={!selectedJobInstanceId?'page':undefined} {...graphOptions(location,run.id)}>All run output</Link><ol>{run.jobs.map(job=><li key={job.instanceId}><Link className="automation-step-link" aria-current={selectedJobInstanceId===job.instanceId&&!selectedStepId?'page':undefined} title={`${job.jobId} · ${job.instanceId}`} {...graphOptions(location,run.id,job.instanceId)}><StepState step={job}/><span>{job.name}<small>{matrixLabel(job)||job.jobId} · {stepDuration(job)}</small></span></Link>{selectedJobInstanceId===job.instanceId?<><small className="muted">{job.needs.length?`Needs: ${job.needs.join(', ')}`:'No dependencies'}</small><ol>{job.steps.map(step=><li key={step.id}><Link className="automation-step-link" aria-current={selectedStepId===step.id?'page':undefined} {...graphOptions(location,run.id,job.instanceId,step.id)}><StepState step={step}/><span>{step.name}<small>{stepDuration(step)}</small></span></Link></li>)}</ol></>:null}</li>)}</ol></>;
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
function WorkflowRunLogs({userId,owner,name,runId,truncated,enabled,stepIndex,run,jobInstanceId,stepId,onAuthorityDenied}:{userId:string;owner:string;name:string;runId:string;truncated:boolean;enabled:boolean;stepIndex?:number;run:WorkflowRun;jobInstanceId?:string;stepId?:string;onAuthorityDenied:(error:ConnectError,observed:WorkflowRun)=>void}) {
 const [search,setSearch]=useState('');const searchId=useId();
 const wide=useWideWorkflowLayout(),[searchOpen,setSearchOpen]=useState(false);const end=useRef<HTMLSpanElement>(null);
 const query=useInfiniteQuery({...privateQuery,queryKey:['workflow-run-logs',userId,owner,name,runId,run.repositoryId,run.attemptId,run.commitId,jobInstanceId??'all',stepId??'all',stepIndex??'all',run.outputState,run.engineCatalog,run.inputContract,run.schemaSha256,run.submittedSha256,run.effectiveSha256],enabled,initialPageParam:0n,
  queryFn:async({signal,pageParam})=>{
   const page=await workflowRunClient.getWorkflowRunLogs({runId,afterSequence:pageParam,stepIndex,jobInstanceId,stepId},{signal,timeoutMs:12_000});
   signal.throwIfAborted();
   if(isActionsCatalog(run.engineCatalog)&&(page.runId!==run.id||page.attemptId!==run.attemptId||page.repositoryId!==run.repositoryId||page.sourceCommitId!==run.commitId||page.jobInstanceId!==(jobInstanceId??'')||page.stepId!==(stepId??'')))throw new ConnectError('The log receipt does not match the selected run, attempt, source and job/step.',Code.FailedPrecondition);
   if(page.outputState!==run.outputState&&!(run.outputState===WorkflowOutputState.UNSPECIFIED&&page.outputState===WorkflowOutputState.ORDINARY))throw new ConnectError('The log publication receipt changed. Refresh the run before continuing.',Code.FailedPrecondition);
   if(page.outputState===WorkflowOutputState.WITHHELD&&(page.logs.length||page.hasMore))throw new ConnectError('Withheld execution output cannot contain readable chunks.',Code.FailedPrecondition);
   let sequence=pageParam;
   for(const chunk of page.logs){if(chunk.sequence<=sequence||chunk.sequence>9223372036854775807n)throw new ConnectError('The log page has an invalid sequence. Refresh before continuing.',Code.Internal);sequence=chunk.sequence;}
   if(page.logs.length>16||page.hasMore&&!page.logs.length)throw new ConnectError('The log page cannot be continued safely.',Code.Internal);
   return page;
  },getNextPageParam:page=>page.hasMore?page.logs.at(-1)?.sequence:undefined});
 useEffect(()=>{if(query.error instanceof ConnectError&&[Code.Unauthenticated,Code.PermissionDenied,Code.NotFound].includes(query.error.code))onAuthorityDenied(query.error,run);},[query.error,onAuthorityDenied,run]);
 const loading=query.isPending;
 const liveStatus=useLiveStatus();
 const active=run.state===WorkflowRunState.RUNNING||run.state===WorkflowRunState.QUEUED;
 const withheld=run.outputState===WorkflowOutputState.WITHHELD;
 const text=query.data?.pages.flatMap(page=>page.logs).map(chunk=>chunk.text).join('')||'';
 const denied=Boolean(query.error)||!enabled;
 useEffect(()=>{if(active&&liveStatus==='live'&&enabled&&!withheld&&!query.error&&query.hasNextPage&&!query.isFetching)void query.fetchNextPage();},[active,liveStatus,enabled,withheld,query.error,query.hasNextPage,query.isFetching,query.fetchNextPage]);
 const matches=search?text.toLowerCase().split(search.toLowerCase()).length-1:0;
 function download(){
  if(denied||loading||!text)return;
  const url=URL.createObjectURL(new Blob([text],{type:'text/plain;charset=utf-8'}));
  const link=document.createElement('a');link.href=url;link.download=`golf-run-${runId}${jobInstanceId?'-job-'+jobInstanceId:''}${stepId?'-step-'+stepId:stepIndex!==undefined?'-step-'+(stepIndex+1):''}${query.hasNextPage?'-loaded':''}.log`;link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
 }
 return <section className="browser-panel workflow-log-panel" aria-labelledby="workflow-log-title">
  <div className="browser-panel-heading"><h2 id="workflow-log-title">Run log</h2><div className="row-actions"><button className="icon-button workflow-log-search-toggle" aria-label="Search loaded run log" title="Search loaded run log" aria-expanded={searchOpen} aria-controls={searchId+'-controls'} disabled={denied} onClick={()=>setSearchOpen(value=>!value)}><Search size={16}/></button><button className="icon-button manual-refresh" aria-label="Refresh run log" title="Refresh run log" disabled={query.isFetching||!enabled} onClick={()=>void query.refetch()}><RefreshCw size={16}/></button><button className="icon-button" aria-label="Download loaded log" title="Download loaded log" disabled={denied||loading||!text} onClick={download}><Download size={16}/></button><button className="icon-button" aria-label="Go to end of loaded log" title="Go to end of loaded log" disabled={denied||loading||!text} onClick={()=>end.current?.scrollIntoView({block:'end'})}><ArrowDownToLine size={16}/></button></div></div>
  <div id={searchId+'-controls'} className="workflow-log-search" hidden={!wide&&!searchOpen}><div className="repository-list-controls"><div className="search-input"><label className="sr-only" htmlFor={searchId}>Search loaded run log</label><Search size={16} aria-hidden="true"/><input id={searchId} type="search" aria-label="Search loaded run log" placeholder="Search loaded log…" value={search} onChange={event=>setSearch(event.target.value)} disabled={denied}/></div><span className="loaded-list-count" role="status">{search?`${matches} match${matches===1?'':'es'}${matches>200?' · first 200 highlighted':''}`:query.hasNextPage?'More output available':'Loaded output'}</span></div></div>
  {query.error?<PanelError error={query.error} retry={()=>void query.refetch()}/>:loading?<Loading label="Loading run log…"/>:null}
  {!denied&&withheld?<p className="panel-footnote" role="status">Output is withheld pending a verified execution result and current authorization.</p>:null}
  {!denied&&run.outputState===WorkflowOutputState.REDACTED?<p className="panel-footnote">Configured secret values were masked before this log was published.</p>:null}
  {!denied&&!withheld&&query.isSuccess?<div hidden={loading}><pre className="source-code execution-log" tabIndex={0} aria-label="Workflow run log"><LogHighlight text={text||'No log output yet.'} search={search}/><span ref={end}/></pre></div>:null}
  {!denied&&!loading?<More hasMore={Boolean(query.hasNextPage)} loading={query.isFetchingNextPage} load={()=>void query.fetchNextPage()} label="log output"/>:null}
  {!denied&&!loading&&(truncated||query.data?.pages.some(page=>page.truncated))?<p className="panel-footnote" role="status">Output reached the worker limit. The stored log is truncated; loading more cannot recover omitted output.</p>:null}
  <p className="panel-footnote">Search and download cover loaded chunks only.</p>
 </section>;
}

export function WorkflowRunPage({userId,owner,name,location,repositoryId,runId,signingOut,selectedStep,selectedJobInstanceId,selectedStepId}:{userId:string;owner:string;name:string;location:RepositoryLocation;repositoryId:string;runId:string;signingOut:boolean;selectedStep?:number;selectedJobInstanceId?:string;selectedStepId?:string}) {
 const client=useQueryClient();
 const [notice,setNotice]=useState('');const [pending,setPending]=useState(false);const [checkingAccess,setCheckingAccess]=useState(false);
 const desktop=useWideWorkflowLayout();
 const [mobileJobsOpen,setMobileJobsOpen]=useState(false);
 const controller=useRef<AbortController|null>(null);const alive=useRef(true);
 useEffect(()=>{alive.current=true;return()=>{alive.current=false;controller.current?.abort();};},[]);
 useEffect(()=>{if(signingOut){controller.current?.abort();setNotice('');}},[signingOut]);
 const query=useQuery({...privateQuery,queryKey:['workflow-run',userId,owner,name,runId,repositoryId],enabled:!signingOut,
  queryFn:async({signal})=>{const response=await workflowRunClient.getWorkflowRun({runId},{signal,timeoutMs:12_000});signal.throwIfAborted();if(!response.run||response.run.id!==runId||response.run.repositoryId!==repositoryId)throw new ConnectError('This run does not belong to the selected repository.',Code.NotFound);return validateJobGraph(response.run);}});
 const run=query.isSuccess&&!query.error&&!signingOut?query.data:undefined;
 const denyLogAuthority=useCallback(async(error:ConnectError,observed:WorkflowRun)=>{
  const key=['workflow-run',userId,owner,name,runId,repositoryId];
  const current=()=>client.getQueryData<WorkflowRun>(key);
  const matches=()=>alive.current&&!signingOut&&client.getQueryData<{id:string}>(['session'])?.id===userId&&current()?.id===observed.id&&current()?.repositoryId===observed.repositoryId&&observed.repositoryId===repositoryId&&current()?.attemptId===observed.attemptId&&current()?.commitId===observed.commitId;
  if(!matches())return;
  if(error.code===Code.Unauthenticated){client.setQueryData(['session'],null);forgetPrivateQueries(client);return;}
  // A log read has the same current repository/session fence as this run.
  // Clear only this exact observation; no retry or inference of revocation.
  const scopedLogs=(q:{queryKey:readonly unknown[]})=>{const k=q.queryKey;return k[0]==='workflow-run-logs'&&k[1]===userId&&k[2]===owner&&k[3]===name&&k[4]===runId&&k[5]===repositoryId&&k[6]===observed.attemptId&&k[7]===observed.commitId;};
  await Promise.all([client.cancelQueries({queryKey:key,exact:true}),client.cancelQueries({predicate:scopedLogs})]);
  if(!matches())return;
  client.removeQueries({predicate:scopedLogs});
  client.getQueryCache().find({queryKey:key,exact:true})?.setState({data:undefined,error,status:'error',fetchStatus:'idle'});
 },[client,userId,owner,name,runId,repositoryId,signingOut]);
 async function refreshRunAccess(){setCheckingAccess(true);try{await query.refetch();}finally{if(alive.current)setCheckingAccess(false);}}
 const engineRun=Boolean(run&&isActionsCatalog(run.engineCatalog));
 const job=run?.jobs.find(job=>job.instanceId===selectedJobInstanceId),engineStep=job?.steps.find(step=>step.id===selectedStepId);
 const badSelection=Boolean(run&&(selectedJobInstanceId&&(!engineRun||!job)||selectedStepId&&!engineStep||engineRun&&selectedStep!==undefined));
 const selectedRecorded=selectedJobInstanceId?selectedStepId?Boolean(engineStep?.startedAt):Boolean(job?.startedAt):selectedStep!==undefined?Boolean(run?.progress?.steps.find(step=>step.index===selectedStep)?.startedAt):true;
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
 return <section className="page-stack workflow-run-workspace" aria-label="Workflow run workspace">
  <Link className="text-button" {...repositoryOptions(location,{view:'actions',run:undefined,runKind:undefined,step:undefined,jobInstanceId:undefined,stepId:undefined})}><ArrowLeft size={16}/>All runs</Link>
  {query.error?<PanelError error={query.error} retry={()=>void query.refetch()}/>:!run?<Loading label="Loading selected run…"/>:null}
  {run?<><div hidden={checkingAccess} className="page-stack">
   <header className="discussion-summary workflow-run-summary"><div><h2 title={run.workflowPath}>{run.workflowPath}</h2><p><RunState state={run.state}/><span>{run.origin===WorkflowRunOrigin.PUSH?'Push':run.origin===WorkflowRunOrigin.MANUAL?'Manual':'Unknown trigger'}{run.eventRef?` · ${run.eventRef}`:''}</span><span><Clock3 size={14}/>{elapsed(run)}</span></p></div><div className="row-actions"><button className="icon-button manual-refresh" aria-label="Refresh selected run" title="Refresh selected run" disabled={pending||query.isFetching||signingOut} onClick={()=>void refreshRunAccess()}><RefreshCw size={16}/></button>{run.canCancel?<button className="button secondary" disabled={pending||signingOut||query.isFetching} onClick={()=>void cancel()}>Cancel run</button>:null}</div></header>
   <section className="browser-panel workflow-run-metadata" aria-label="Run summary"><dl><div><dt>Commit</dt><dd><Link {...repositoryOptions({owner,name},{view:'commits',commit:run.commitId})}><GitCommitHorizontal size={14}/><code title={run.commitId}>{run.commitId.slice(0,12)}</code></Link></dd></div><div><dt>Created</dt><dd><DateLabel value={run.createdAt}/></dd></div></dl><details><summary>Execution receipt</summary><dl><div><dt>Worker</dt><dd>{run.runnerId||'Awaiting assignment'}</dd></div><div><dt>Admitted runner pool</dt><dd>{run.runnerPlacement?run.runnerPlacement.legacyUnbound?'Unpooled workers':<code>{run.runnerPlacement.poolId}</code>:'Not recorded'}</dd></div>{run.runnerPlacement?<><div><dt>Placement version</dt><dd><code>{run.runnerPlacement.placementVersion}</code></dd></div>{!run.runnerPlacement.legacyUnbound?<div><dt>Pool configuration version</dt><dd><code>{run.runnerPlacement.poolVersion}</code></dd></div>:null}</>:null}<div><dt>Exit code</dt><dd>{run.exitCode??'Not reported'}</dd></div><div><dt>Attempt</dt><dd><code>{run.attemptId||'Not recorded'}</code></dd></div>{run.engineCatalog?<><div><dt>Engine catalog</dt><dd><code>{run.engineCatalog}</code></dd></div>{run.engineCommit?<div><dt>Engine source</dt><dd><code>{run.engineCommit}</code></dd></div>:null}</>:null}{run.engineCatalog===actionsInputsCatalog?<><div><dt>Manual input contract</dt><dd><code>{run.inputContract}</code></dd></div><div><dt>Input schema</dt><dd><code>{run.schemaSha256}</code></dd></div><div><dt>Submitted inputs receipt</dt><dd><code>{run.submittedSha256}</code></dd></div><div><dt>Effective inputs receipt</dt><dd><code>{run.effectiveSha256}</code></dd></div></>:null}{job?<><div><dt>Job instance</dt><dd><code>{job.instanceId}</code></dd></div><div><dt>Source job</dt><dd><code>{job.jobId}</code></dd></div>{job.matrix.length?<div><dt>Matrix</dt><dd>{matrixLabel(job)}</dd></div>:null}<div><dt>Needs</dt><dd>{job.needs.join(', ')||'No dependencies'}</dd></div><div><dt>Job image</dt><dd><code>{job.imageDigest}</code></dd></div>{job.startedAt?<div><dt>Job started</dt><dd><DateLabel value={job.startedAt}/></dd></div>:null}{job.finishedAt?<div><dt>Job finished</dt><dd><DateLabel value={job.finishedAt}/></dd></div>:null}{engineStep?<><div><dt>Step</dt><dd><code>{engineStep.id}</code></dd></div>{engineStep.startedAt?<div><dt>Step started</dt><dd><DateLabel value={engineStep.startedAt}/></dd></div>:null}{engineStep.finishedAt?<div><dt>Step finished</dt><dd><DateLabel value={engineStep.finishedAt}/></dd></div>:null}</>:null}</>:null}<div><dt>Run</dt><dd><code>{run.id}</code></dd></div><div><dt>Workflow source</dt><dd><Link {...repositoryOptions({owner,name},{ref:run.commitId,path:run.workflowPath},'file')}>{run.workflowPath}</Link></dd></div><div><dt>Workflow blob</dt><dd><code>{run.workflowBlobId}</code></dd></div><div><dt>Source archive</dt><dd><code>{run.sourceSha256}</code></dd></div>{run.origin===WorkflowRunOrigin.PUSH?<><div><dt>Event</dt><dd>{run.repositoryEventId}</dd></div><div><dt>Automation grant</dt><dd><code>{run.automationGrantId}</code></dd></div></>:null}</dl></details></section>
   {run.reason?<p className="panel-footnote">{run.reason}</p>:null}
   <WorkflowArtifacts key={`${userId}-${run.repositoryId}-${run.ownerId}-${run.id}-${run.attemptId}`} run={run} userId={userId} enabled={!query.isFetching&&!signingOut} onAuthorityDenied={denyLogAuthority}/>
   <div className="automation-run-layout"><aside className="automation-job-navigation" aria-label="Jobs and steps"><details className="workflow-jobs-disclosure" open={desktop||mobileJobsOpen} onToggle={event=>{if(!desktop)setMobileJobsOpen(event.currentTarget.open)}}><summary>Jobs · {engineRun?job?`${job.name}${job.matrix.length?' · '+matrixLabel(job):''}`:`${run.jobs.length} recorded instances`:run.progress?.name||run.progress?.jobId||'Job'}{selectedStepId?` · ${engineStep?.name||'Selected step'}`:selectedStep!==undefined?` · ${run.progress?.steps.find(step=>step.index===selectedStep)?.name||'Selected step'}`:' · All run output'}</summary><div className="workflow-jobs-content">
    {engineRun?<JobGraphNavigation run={run} location={location} selectedJobInstanceId={selectedJobInstanceId} selectedStepId={selectedStepId}/>:<><h3>Jobs</h3><strong>{run.progress?.name||run.progress?.jobId||'Job'}</strong>{run.progress?.stage?<span className="muted">{run.progress.stage}</span>:null}
    <Link className="automation-step-link" aria-current={selectedStep===undefined?'page':undefined} {...repositoryOptions(location,{view:'actions',run:runId,step:undefined})}>All run output</Link>
    {run.progress?.steps.length?<ol>{run.progress.steps.map(step=><li key={step.index}>{step.startedAt?<Link className="automation-step-link" aria-current={selectedStep===step.index?'page':undefined} {...repositoryOptions(location,{view:'actions',run:runId,step:step.index})}><StepState step={step}/><span>{step.name}<small>{stepDuration(step)}</small></span></Link>:<div className="automation-step-link"><StepState step={step}/><span>{step.name}<small>{stepLabel(step.state)}</small></span></div>}</li>)}</ol>:<p className="field-help">Step events were not recorded for this run.</p>}
    {run.progress&&!run.progress.eventsRecorded&&run.state!==WorkflowRunState.QUEUED&&run.state!==WorkflowRunState.RUNNING?<p className="field-help">This run has no recorded step outcomes. Its overall result does not establish individual step results.</p>:null}
   </>}
   </div></details></aside><div className="automation-run-output">
    {selectedStepId||selectedJobInstanceId?<h3>{engineStep?.name||job?.name||'Selected job'}</h3>:selectedStep!==undefined?<h3>{run.progress?.steps.find(step=>step.index===selectedStep)?.name||'Selected step'}</h3>:null}
    {badSelection?<PanelError error={new ConnectError('The selected job or step does not belong to this recorded run.',Code.NotFound)} retry={()=>void query.refetch()}/>:!selectedRecorded?<p className="panel-footnote" role="status">{selectedJobInstanceId&&job?noJobOutput(job,engineStep):'The selected step has no recorded output. Choose all run output or a step that started.'}</p>:<WorkflowRunLogs onAuthorityDenied={denyLogAuthority} key={`${run.attemptId}-${run.outputState}-${run.engineCatalog}-${run.inputContract}-${run.schemaSha256}-${run.submittedSha256}-${run.effectiveSha256}-${selectedJobInstanceId||'all'}-${selectedStepId||'all'}-${selectedStep??'all'}`} run={run} userId={userId} owner={owner} name={name} runId={runId} stepIndex={selectedStep} jobInstanceId={selectedJobInstanceId} stepId={selectedStepId} truncated={run.logsTruncated} enabled={!checkingAccess&&!signingOut}/>}
    {engineRun&&!selectedJobInstanceId&&run.jobs.some(job=>!job.eventsRecorded)?<p className="panel-footnote">Job outcomes without recorded events are shown as pending or unrecorded. The overall run result does not establish missing job or step outcomes.</p>:null}
   </div></div>
  </div>{checkingAccess?<Loading label="Checking run access…"/>:null}</>:null}
  {notice&&!signingOut?<p role="status" className="panel-footnote">{notice}</p>:null}
 </section>;
}
