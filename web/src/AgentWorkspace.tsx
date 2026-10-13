import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { RefreshCw } from 'lucide-react';
import { DataTable, type DataTableColumn } from './DataTable';
import { nativeAPI, NativePreviewLink, type Config, type Pull, type Job, type Preview, type ReportValue } from './NativeForge';
import { Loading, PageHeader, PanelError, privateQuery, usePageVisible } from './RepositoryUI';
import { useLiveStatus } from './RepositoryLive';
import { currentPullPreviews } from './nativePreviews';
import { jobMatchesPull, pullStage } from './agentWorkspace';
import { repositoryOptions, type RepositoryLocation } from './navigation';

type Props = { location: RepositoryLocation; repositoryId: string; userId: string };
export function AgentWorkspace({ location, repositoryId, userId }: Props) {
  const [detailError,setDetailError]=useState<Error>();
  const cache = useQueryClient(), visible = usePageVisible(), live = useLiveStatus() === 'live';
  const scope = ['repository',userId,location.owner,location.name,'agent-workspace'];
  const context = { repository: {owner:location.owner,name:location.name}, repositoryId };
  const interval = visible && !live ? 15000 : false;
  const config = useQuery({...privateQuery,queryKey:['native-config',userId],queryFn:({signal})=>nativeAPI<Config>('/native/config',{},signal)});
  const pulls = useQuery({...privateQuery,queryKey:[...scope,'pulls'],queryFn:({signal})=>nativeAPI<{pullRequests:Pull[];page:{nextPage:number}}>('/rpc/golf.v1.RepositoryService/ListPullRequests',{...context,state:'ISSUE_STATE_ALL',page:{limit:100}},signal),refetchInterval:interval});
  const number = location.pull ?? pulls.data?.pullRequests[0]?.number;
  const refresh = () => { void cache.resetQueries({queryKey:scope}).then(()=>setDetailError(undefined)); void config.refetch(); };
  const columns: DataTableColumn<Pull>[] = [
    {accessorKey:'number',header:'PR',cell:({row})=><Link {...repositoryOptions(location,{view:'agents',pull:row.original.number})} aria-current={row.original.number===number?'page':undefined}>#{row.original.number}</Link>},
    {accessorKey:'title',header:'Work',cell:({row})=><Link {...repositoryOptions(location,{view:'agents',pull:row.original.number})}>{row.original.title}</Link>},
    {id:'state',header:'Review',accessorFn:pullStage},
    {id:'head',header:'Source',accessorFn:p=>p.head.commitId,cell:({row})=><code>{row.original.head.commitId.slice(0,12)}</code>},
  ];
  const error=config.error||pulls.error||detailError;
  return <div className="page-stack agent-workspace"><PageHeader title="Agent workspace" description="Proposals, review, tests and previews in one place." actions={<button className="button secondary" disabled={pulls.isFetching||config.isFetching} onClick={refresh}><RefreshCw size={15}/>Refresh</button>}/>
    {error?<PanelError error={error} retry={refresh}/>:!config.data||!pulls.data?<Loading label="Reading repository work…"/>:<>
      {!config.data.agents?<p className="field-help">Agent execution is not enabled on this installation. Existing CI and review evidence is available below.</p>:null}
      <section className="browser-panel"><div className="browser-panel-heading"><h2>Work by pull request</h2><Link {...repositoryOptions(location,{view:'pulls',pull:undefined})}>All pull requests</Link></div><DataTable data={pulls.data.pullRequests} columns={columns} getRowId={p=>p.id} label="workspace pull requests" emptyMessage="No pull requests yet. Open a pull request to track its work here."/>{pulls.data.page.nextPage?<p className="panel-footnote">Latest 100 pull requests loaded. Use All pull requests for older work.</p>:null}</section>
      {number?<SelectedWork key={number} onError={setDetailError} {...{context,scope,number,config:config.data,interval,location}}/>:null}
    </>}
  </div>;
}
function SelectedWork({context,scope,number,config,interval,location,onError}:{onError:(error:Error)=>void;context:{repository:{owner:string;name:string};repositoryId:string};scope:string[];number:number;config:Config;interval:number|false;location:RepositoryLocation}) {
  const cache=useQueryClient();
  const pull=useQuery({...privateQuery,queryKey:[...scope,number,'pull'],queryFn:({signal})=>nativeAPI<{pullRequest:Pull}>('/rpc/golf.v1.RepositoryService/GetPullRequest',{...context,number},signal),refetchInterval:interval});
  const jobs=useQuery({...privateQuery,queryKey:[...scope,number,'jobs'],enabled:config.evidence,queryFn:({signal})=>nativeAPI<{jobs:Job[];truncated:boolean}>('/native/pr-evidence/read',{...context,action:'list',number},signal),refetchInterval:interval});
  const previews=useQuery({...privateQuery,queryKey:[...scope,'previews'],enabled:config.previews,queryFn:({signal})=>nativeAPI<{previews:Preview[];truncated:boolean}>('/native/pr-preview/read',{...context,action:'list'},signal),refetchInterval:interval});
  const [reportId,setReportId]=useState(''),[now,setNow]=useState(Date.now);
  useEffect(()=>{
    const expires=Math.min(...(previews.data?.previews||[]).map(p=>Date.parse(p.expiresAt)).filter(t=>t>now));
    if(!Number.isFinite(expires))return;
    const timer=setTimeout(()=>setNow(Date.now()),Math.min(expires-Date.now()+1,2147483647));
    return ()=>clearTimeout(timer);
  },[previews.data,now]);
  const pr=pull.data?.pullRequest;
  const report=useQuery({...privateQuery,queryKey:[...scope,number,'report',reportId,pr?.revision],enabled:!!reportId&&!!pr&&!!jobs.data?.jobs.some(j=>j.id===reportId&&j.state==='SUCCEEDED'),queryFn:async({signal})=>{
    const result=await nativeAPI<ReportValue>('/native/pr-evidence/read',{...context,action:'report',jobId:reportId},signal);
    if(result.job.id!==reportId||result.job.selection.repositoryId!==context.repositoryId||result.job.selection.pullRequestId!==pr!.id)throw Error('Report identity changed. Refresh the workspace.');
    return result;
  }});
  const refresh=()=>void cache.invalidateQueries({queryKey:scope});
  const error=pull.error||jobs.error||previews.error||report.error;
  useEffect(()=>{if(error)onError(error);},[error,onError]);
  if(error)return <PanelError error={error} retry={refresh}/>;
  if(!pr||config.evidence&&!jobs.data||config.previews&&!previews.data)return <Loading label="Reading selected work…"/>;
  const rows=jobs.data?.jobs||[];
  const currentJobs=rows.filter(j=>jobMatchesPull(j,pr,context.repositoryId));
  const latestTests=currentJobs.find(j=>j.testState!=='NONE');
  const currentPreviews=currentPullPreviews(previews.data?.previews||[],currentJobs,pr.head.commitId,now);
  const selected=rows.find(j=>j.id===reportId&&j.state==='SUCCEEDED');
  const value=selected?report.data:undefined;
  const columns:DataTableColumn<Job>[]=[
    {id:'kind',header:'Work',accessorFn:j=>j.agentState==='NONE'?'CI / evidence':'Agent proposal'},
    {id:'source',header:'Source',accessorFn:j=>jobMatchesPull(j,pr,context.repositoryId)?'Current':'Stale'},
    {accessorKey:'state',header:'Run'},
    {accessorKey:'agentState',header:'Agent'},
    {accessorKey:'testState',header:'Tests'},
    {id:'created',header:'Created',accessorFn:j=>j.createdAt,cell:({row})=><time dateTime={row.original.createdAt}>{new Date(row.original.createdAt).toLocaleString()}</time>},
    {id:'report',header:'Report',enableSorting:false,cell:({row})=><button className="button secondary" disabled={row.original.state!=='SUCCEEDED'} onClick={()=>setReportId(row.original.id)}>Inspect report</button>},
  ];
  return <section className="page-stack" aria-label="Selected work"><header className="agent-workspace-heading"><div><span className="eyebrow">{pullStage(pr)} · #{pr.number}</span><h2>{pr.title}</h2><p><code>{pr.base.commitId.slice(0,12)}</code> → <code>{pr.head.commitId.slice(0,12)}</code></p></div><div className="credential-actions"><Link className="button secondary" {...repositoryOptions(location,{view:'pulls',pull:number,pullView:'files'})}>Review changes</Link><Link className="button secondary" {...repositoryOptions(location,{view:'pulls',pull:number,pullView:'checks'})}>Checks and controls</Link></div></header>
    <div className="agent-workspace-summary"><div><span>Agent runs</span><strong>{currentJobs.filter(j=>j.agentState!=='NONE').length}</strong><small>For the current source</small></div><div><span>CI evidence</span><strong>{latestTests?.testState||'No current run'}</strong><small>Latest current run · not merge approval</small></div><div><span>Previews</span><strong>{currentPreviews.length}</strong><small>Current, passing and unexpired</small></div></div>
    <section className="browser-panel"><div className="browser-panel-heading"><h3>Runs and proposals</h3><span className="field-help">{rows.length} loaded</span></div>{config.evidence?<DataTable data={rows} columns={columns} getRowId={j=>j.id} label="workspace runs" emptyMessage="No evidence runs for this pull request."/>:<p className="credential-form-content">Evidence collection is not enabled.</p>}{jobs.data?.truncated?<p className="panel-footnote">Filtered from the latest 100 repository runs.</p>:null}</section>
    {currentPreviews.length?<section className="browser-panel"><div className="browser-panel-heading"><h3>Current previews</h3></div>{currentPreviews.map(p=><NativePreviewLink key={p.id} preview={p}/>)}</section>:null}
    {previews.data?.truncated?<p className="field-help">Previews are filtered from the latest 100 repository deployments.</p>:null}
    {report.isFetching?<Loading label="Opening evidence report…"/>:value?<section className="browser-panel"><div className="browser-panel-heading"><h3>Evidence report</h3><button className="button secondary" onClick={()=>setReportId('')}>Close report</button></div><div className="credential-form-content page-stack"><p>{jobMatchesPull(value.job,pr,context.repositoryId)?'Current source':'Historical evidence · source has changed'} · Agent: {value.report.agentResult.state} · Tests: {value.report.tests.state}</p>{value.report.agentResult.proposalCommitId?<p>Proposed commit <code>{value.report.agentResult.proposalCommitId}</code></p>:null}{value.job.agentState!=='NONE'?<p className="field-help">Agent tokens: {value.report.agentResult.tokens?.toLocaleString()??'Not reported'} · Calls: {value.report.agentResult.calls??'Not reported'} · Monetary cost: not reported</p>:null}{value.report.agentResult.patch?<details><summary>Proposed patch</summary><pre className="native-evidence-code">{value.report.agentResult.patch}</pre></details>:null}{value.report.agentResult.tests?<details><summary>Agent proposal tests · exit {value.report.agentResult.tests.exitCode}</summary><pre className="native-evidence-code">{value.report.agentResult.tests.stdout}{value.report.agentResult.tests.stderr}</pre></details>:null}<details><summary>Test output</summary><pre className="native-evidence-code">{value.report.tests.stdout||value.report.tests.stderr?`${value.report.tests.stdout||''}${value.report.tests.stderr||''}`:'No captured output.'}</pre></details>{value.report.limitations?.map(text=><p className="field-help" key={text}>{text}</p>)}</div></section>:null}
  </section>;
}
