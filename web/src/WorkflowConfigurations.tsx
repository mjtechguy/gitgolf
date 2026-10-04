import { ReviewerPanel } from './ReviewerPanel';
import { AgentTasks } from './AgentTasks';
import { AgentUsagePanel } from './AgentUsagePanel';
import { AgentUsageScope } from './gen/golf/v1/golf_pb';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import { Code, ConnectError } from '@connectrpc/connect';
import { Bot, FileCode2, GitPullRequest, ListFilter, RefreshCw, Settings2, Workflow } from 'lucide-react';
import { repositoryClient, repositoryAccessClient, workflowClient, workflowRunClient, errorMessage } from './api';
import { sourceRepositoryID } from './sourceReads';
import { isCommitID, isRunID } from './navigation';
import type { WorkflowRun } from './gen/golf/v1/golf_pb';
import { WorkflowRunOrigin, WorkflowRunState } from './gen/golf/v1/golf_pb';
import { RepositorySettingsLayout } from './AccountSettings';
import { DataTable, type DataTableColumn } from './DataTable';
import { Loading, PanelError, privateQuery } from './RepositoryUI';
import { repositoryOptions, defaultRepositorySearch, type RepositoryLocation } from './navigation';
import { ActionRuns } from './ActionRuns';
import { AutomationGrantPanel } from './AutomationGrantPanel';
import { ExecutionPolicyPanel } from './ExecutionPolicyPanel';
import { ExecutionScope, WorkflowFormat, WorkflowInspectionState, type WorkflowConfiguration, type WorkflowDiagnostic } from './gen/golf/v1/golf_pb';

// Original request metadata only; no credential, script or response body persists.
type DispatchIntent = { actorId:string; key:string; owner:string; name:string; repositoryId:string; ownerId:string; commitId:string; workflowPath:string; workflowBlobId:string };
const dispatchPrefix = 'golf.workflow-dispatch.v1:';
const dispatchStorageKey = (actor:string,repo:string) => `${dispatchPrefix}${location.origin}:${actor}:${repo}`;
const workflowPath = (value:string) => /^(?:\.github\/workflows\/[^/]+\.ya?ml|\.gitlab-ci\.yml)$/.test(value) && new TextEncoder().encode(value).length<=4096 && !/[\\\p{Cc}\uD800-\uDFFF]/u.test(value);
function validDispatchIntent(value:unknown, actor:string,repo:string):value is DispatchIntent {
 if(!value||typeof value!=='object'||Array.isArray(value))return false;
 const v=value as Record<string,unknown>;
 return Object.keys(v).length===9 && v.actorId===actor && v.repositoryId===repo && sourceRepositoryID(actor) && sourceRepositoryID(repo) && typeof v.key==='string' && isRunID(v.key) && typeof v.ownerId==='string' && sourceRepositoryID(v.ownerId) && typeof v.owner==='string' && typeof v.name==='string' && [v.owner,v.name].every(part=>part.length>0&&part.length<=255&&!/[\/\\\p{Cc}\uD800-\uDFFF]/u.test(part)) && typeof v.commitId==='string' && isCommitID(v.commitId) && typeof v.workflowBlobId==='string' && isCommitID(v.workflowBlobId) && v.workflowBlobId.length===v.commitId.length && typeof v.workflowPath==='string' && workflowPath(v.workflowPath);
}
// Exported for the enclosing account/logout boundary; importing the editor is not required by the component itself.
export function clearOtherWorkflowDispatchIntents(actor?:string) {
 try { const keep=actor?`${dispatchPrefix}${location.origin}:${actor}:`:'';for(const key of Object.keys(sessionStorage))if(key.startsWith(dispatchPrefix)&&(!keep||!key.startsWith(keep)))sessionStorage.removeItem(key); } catch { /* Unreadable storage blocks new dispatch below. */ }
}
function verifiedDispatchRun(run:WorkflowRun|undefined,intent:DispatchIntent,inspection=false):WorkflowRun {
 if(!run||!isRunID(run.id)||run.repositoryId!==intent.repositoryId||run.ownerId!==intent.ownerId||run.commitId!==intent.commitId||run.workflowPath!==intent.workflowPath||run.workflowBlobId!==intent.workflowBlobId||run.origin!==WorkflowRunOrigin.MANUAL||run.eventRef!==''||!/^([1-9][0-9]{0,18})$/.test(run.version)||BigInt(run.version)>9223372036854775807n||!/^\d{4}-\d\d-\d\dT/.test(run.createdAt)||!Number.isFinite(Date.parse(run.createdAt))||!/^([a-f0-9]{64})$/.test(run.sourceSha256)||run.state<WorkflowRunState.QUEUED||run.state>WorkflowRunState.LOST||(inspection&&run.canCancel))throw new ConnectError('The original dispatch receipt could not be verified.',Code.Internal);
 return run;
}

function format(value: WorkflowFormat) {
  return value === WorkflowFormat.GITHUB_ACTIONS ? 'GitHub Actions' : value === WorkflowFormat.GITLAB_CI ? 'GitLab CI' : 'Unknown format';
}
function state(value: WorkflowInspectionState) {
  return value === WorkflowInspectionState.VALIDATED_SUBSET ? 'Inspection subset checked' : value === WorkflowInspectionState.UNSUPPORTED ? 'Outside inspection subset' : value === WorkflowInspectionState.INVALID ? 'Invalid configuration' : 'Not inspected';
}
function Diagnostics({ diagnostics }: { diagnostics: WorkflowDiagnostic[] }) {
  return <ul>{diagnostics.map((diagnostic, index) => <li key={`${diagnostic.code}-${index}`}>
    {diagnostic.line > 0 ? <span>Line {diagnostic.line}{diagnostic.column > 0 ? `:${diagnostic.column}` : ''} · </span> : null}
    {diagnostic.message} <small>({diagnostic.code})</small>
  </li>)}</ul>;
}

export function WorkflowConfigurations({ userId, owner, name, signingOut, repositoryId = '', workView = false, location: suppliedLocation }: { repositoryId?:string; workView?:boolean;location?:RepositoryLocation; userId: string; owner: string; name: string; signingOut: boolean }) {
  const navigate = useNavigate();
  const [dispatching, setDispatching] = useState(false);
  const busy = useRef(false);
  const generation=useRef(0);
  const activeScope=useRef('');
  const available=useRef(false);
  const [original,setOriginal]=useState<{scope:string;intent?:DispatchIntent;blocked:boolean;denied?:boolean;run?:WorkflowRun}>({scope:'',blocked:true});
  const [tasksOpen, setTasksOpen] = useState(false);
  const location:RepositoryLocation=suppliedLocation||{...defaultRepositorySearch,kind:'repository',owner,name,view:'actions'};
  const scope = JSON.stringify([userId,owner,name]);
  const [notice, setNotice] = useState('');
  const controller = useRef<AbortController | null>(null);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; controller.current?.abort(); }; }, []);
  useEffect(() => { clearOtherWorkflowDispatchIntents(signingOut?undefined:userId);if(signingOut){controller.current?.abort();setNotice('');setOriginal({scope:'',blocked:true});} }, [userId,signingOut]);
  const metadata = useQuery({ ...privateQuery, queryKey: ['workflow-repository-identity', userId, owner, name], enabled: !signingOut && !repositoryId,
    queryFn: async ({signal}) => {
      const response = await repositoryClient.getRepository({repository:{owner,name}}, {signal,timeoutMs:8000}); signal.throwIfAborted();
      const repository = response.repository;
      if (!repository || !sourceRepositoryID(repository.id) || repository.name.toLowerCase()!==name.toLowerCase() || repository.fullName.toLowerCase()!==`${owner}/${name}`.toLowerCase()) throw new ConnectError('Repository identity could not be verified for workflow inspection.',Code.FailedPrecondition);
      return repository.id;
    },
  });
  const effectiveRepositoryId = repositoryId || (metadata.isSuccess && !metadata.isFetching && !metadata.error ? metadata.data : '');
  const identityReady = !signingOut && sourceRepositoryID(effectiveRepositoryId);
  const identityError = repositoryId && !sourceRepositoryID(repositoryId) ? new ConnectError('Select a valid repository identity.',Code.FailedPrecondition) : !repositoryId ? metadata.error : undefined;
  const query = useQuery({ ...privateQuery, queryKey: ['workflow-configurations', userId, owner, name, effectiveRepositoryId], enabled: identityReady,
    queryFn: async ({ signal }) => { const response=await workflowClient.inspectWorkflows({ repository: { owner, name }, repositoryId:effectiveRepositoryId }, { signal, timeoutMs: 25_000 });signal.throwIfAborted();if(response.repositoryId!==effectiveRepositoryId)throw new ConnectError('Workflow inspection does not match the selected repository.',Code.FailedPrecondition);return response; },
  });
  const inspection = identityReady && query.isSuccess && !query.isFetching && !query.error && !signingOut ? query.data : undefined;
  const accessQuery=useQuery({...privateQuery,queryKey:['workflow-dispatch-access',userId,owner,name,effectiveRepositoryId],enabled:identityReady,queryFn:async({signal})=>{
   const response=await repositoryAccessClient.getRepositoryAccess({repository:{owner,name}},{signal,timeoutMs:8000});signal.throwIfAborted();const access=response.access;
   if(!access||access.repositoryId!==effectiveRepositoryId||!sourceRepositoryID(access.ownerId)||!['read','write','admin','owner'].includes(access.currentPermission))throw new ConnectError('Repository authority could not be verified for workflow dispatch.',Code.FailedPrecondition);
   return access;
  }});
  const access=accessQuery.isSuccess&&!accessQuery.isFetching&&!accessQuery.error&&!signingOut?accessQuery.data:undefined;
  const storageScope=sourceRepositoryID(userId)&&sourceRepositoryID(effectiveRepositoryId)?dispatchStorageKey(userId,effectiveRepositoryId):'';
  const scopeDenied=original.scope===storageScope&&original.denied;
  const inspectionError = identityError || query.error || accessQuery.error || (scopeDenied?new ConnectError('Current workflow authority is unavailable. Refresh to inspect the original dispatch.',Code.PermissionDenied):undefined);
  const refreshInspection = () => { setOriginal(prior=>({...prior,denied:false}));if(identityReady){void accessQuery.refetch();void query.refetch();}else if(!repositoryId)void metadata.refetch(); };
  const result=access&&!scopeDenied?inspection:undefined;
  const commit = result?.commitId ?? '';
  const guardScope=JSON.stringify([userId,owner,name,effectiveRepositoryId,signingOut]);
  if(activeScope.current!==guardScope){activeScope.current=guardScope;generation.current++;controller.current?.abort();busy.current=false;}
  available.current=Boolean(result&&access&&['write','admin','owner'].includes(access.currentPermission));
  const stored=original.scope===storageScope?original:undefined;
  const intent=stored?.intent;
  const unresolved=Boolean(intent&&!stored?.run);
  const originalMatches=Boolean(!intent||(intent.owner===owner&&intent.name===name&&access?.ownerId===intent.ownerId));
  useEffect(()=>{
   controller.current?.abort();busy.current=false;setDispatching(false);setNotice('');
   if(!storageScope||signingOut){setOriginal({scope:storageScope,blocked:true});return;}
   try{const encoded=sessionStorage.getItem(storageScope);const value:unknown=encoded===null?undefined:JSON.parse(encoded);
    if(value!==undefined&&!validDispatchIntent(value,userId,effectiveRepositoryId))throw new Error('Original metadata unavailable');
    setOriginal({scope:storageScope,intent:value as DispatchIntent|undefined,blocked:false});
   }catch{setOriginal({scope:storageScope,blocked:true});}
  },[storageScope,guardScope,userId,effectiveRepositoryId,signingOut]);
  useEffect(()=>{if(!result){controller.current?.abort();}if(inspectionError){setNotice('');setOriginal(prior=>({...prior,run:undefined}));}},[Boolean(result),Boolean(inspectionError)]);
  const policyObserved = (item:WorkflowConfiguration) => Boolean(result && /^[a-f0-9]{64}$/.test(result.policyRevision) && typeof item.manualPolicyAllowed==='boolean' && typeof item.pushPolicyAllowed==='boolean');
  const policyLabel = (item:WorkflowConfiguration, kind:'manual'|'push') => !policyObserved(item)?'Unknown':(kind==='manual'?item.manualPolicyAllowed:item.pushPolicyAllowed)?'Ceilings allow':'Ceilings deny';
  const selectedPath = location.actionKind==='workflow' ? location.workflowPath : undefined;
  const manualEligible = (item:WorkflowConfiguration) => item.state===WorkflowInspectionState.VALIDATED_SUBSET && (item.format===WorkflowFormat.GITLAB_CI || item.events.includes('workflow_dispatch'));
  const canDispatch = (item:WorkflowConfiguration) => Boolean(isCommitID(commit) && manualEligible(item) && policyObserved(item) && item.manualPolicyAllowed===true && result?.executionAvailable && available.current && stored && !stored.blocked && originalMatches && !unresolved && !dispatching && !signingOut);
  const selectedConfiguration = selectedPath ? result?.configurations.find(item=>item.path===selectedPath) : undefined;
  const dispatchNotice = result && available.current && stored && (stored.blocked||intent||notice) && !signingOut ? <div className="panel-footnote page-stack">
   {stored.blocked?<p role="alert">Original dispatch metadata is unavailable. New dispatches are blocked; no request was retried.</p>:null}
   {intent?<div className="page-stack"><p>Original workflow <code>{intent.workflowPath}</code> · Snapshot <code title={intent.commitId}>{intent.commitId.slice(0,12)}</code></p>
    {stored.run?<p role="status">Run {stored.run.id} recorded. <Link {...repositoryOptions({owner:intent.owner,name:intent.name,view:'actions',run:stored.run.id,runKind:'workflow'})}>View recorded run</Link>. This is a historical receipt; current eligibility is checked for each new dispatch.</p>:<p role="status">{notice||'Original dispatch outcome has not been inspected.'} This request remains inspection-only. No automatic retry or replacement dispatch is available.</p>}
    <button type="button" className="button secondary" disabled={dispatching||stored.blocked||busy.current||!originalMatches} onClick={()=>void inspectDispatch()}><RefreshCw size={15}/>Inspect original dispatch</button>
   </div>:notice?<p role="status">{notice}</p>:null}
  </div>:null;
  const accepted=(stamp:number,request:AbortController)=>alive.current&&stamp===generation.current&&!request.signal.aborted&&available.current;
  async function dispatch(path: string) {
    const item=result?.configurations.find(item=>item.path===path);
    if (activeScope.current!==guardScope || !item || !canDispatch(item)||busy.current||!access||!isCommitID(item.blobId)) return;
    const frozen:DispatchIntent={actorId:userId,key:crypto.randomUUID(),owner,name,repositoryId:effectiveRepositoryId,ownerId:access.ownerId,commitId:commit,workflowPath:path,workflowBlobId:item.blobId};
    if(!validDispatchIntent(frozen,userId,effectiveRepositoryId))return;
    try{const encoded=JSON.stringify(frozen);sessionStorage.setItem(storageScope,encoded);if(sessionStorage.getItem(storageScope)!==encoded)throw new Error('Storage verification failed');}
    catch{setOriginal({scope:storageScope,blocked:true});setNotice('Original dispatch metadata could not be retained. No dispatch was made.');return;}
    setOriginal({scope:storageScope,intent:frozen,blocked:false});
    const request = new AbortController(),stamp=generation.current; controller.current = request;busy.current=true;setDispatching(true);setNotice('');
    try { const receipt = await workflowRunClient.dispatchWorkflow({ repository: { owner, name }, ref: frozen.commitId, workflowPath: frozen.workflowPath, idempotencyKey: frozen.key }, { signal: request.signal, timeoutMs: 25_000 });
      if (!accepted(stamp,request)) return;
      const run=verifiedDispatchRun(receipt.run,frozen);setOriginal({scope:storageScope,intent:frozen,blocked:false,run});
    } catch (error) { if (accepted(stamp,request)) {if(error instanceof ConnectError&&[Code.Unauthenticated,Code.PermissionDenied,Code.NotFound].includes(error.code))setOriginal(prior=>({...prior,run:undefined,denied:true}));else setNotice(`${errorMessage(error instanceof Error ? error : new Error('Dispatch could not be confirmed.'))} Inspect the original dispatch.`);} }
    finally { if (controller.current === request) {controller.current = null;busy.current=false;if(alive.current&&stamp===generation.current)setDispatching(false);} }
  }
  async function inspectDispatch(){
   if(activeScope.current!==guardScope||!originalMatches||!intent||!available.current||busy.current||stored?.blocked||signingOut)return;
   const frozen=intent,request=new AbortController(),stamp=generation.current;controller.current=request;busy.current=true;setDispatching(true);setNotice('');setOriginal(prior=>({...prior,run:undefined}));
   try{
    const receipt=await workflowRunClient.getWorkflowDispatch({repository:{owner:frozen.owner,name:frozen.name},repositoryId:frozen.repositoryId,ownerId:frozen.ownerId,commitId:frozen.commitId,workflowPath:frozen.workflowPath,idempotencyKey:frozen.key},{signal:request.signal,timeoutMs:15000});
    if(!accepted(stamp,request))return;
    if(receipt.repository?.owner!==frozen.owner||receipt.repository?.name!==frozen.name||receipt.repositoryId!==frozen.repositoryId||receipt.ownerId!==frozen.ownerId||receipt.nativeActorId!==frozen.actorId||receipt.idempotencyKey!==frozen.key)throw new ConnectError('The original dispatch receipt could not be verified.',Code.Internal);
    const run=verifiedDispatchRun(receipt.run,frozen,true);setOriginal({scope:storageScope,intent:frozen,blocked:false,run});
   }catch(error){if(accepted(stamp,request)){if(error instanceof ConnectError&&[Code.Unauthenticated,Code.PermissionDenied].includes(error.code))setOriginal(prior=>({...prior,run:undefined,denied:true}));else setNotice(error instanceof ConnectError&&error.code===Code.NotFound?'No original receipt is available. Absence does not establish that dispatch had no effect.':errorMessage(error instanceof Error?error:new Error('Original outcome could not be inspected.')));}}
   finally{if(controller.current===request){controller.current=null;busy.current=false;if(alive.current&&stamp===generation.current)setDispatching(false);}}
  }
  const columns = useMemo<DataTableColumn<WorkflowConfiguration>[]>(() => [
    { id: 'configuration', accessorFn: item => `${item.path} ${item.name}`, header: 'Configuration', cell: ({ row }) => <>
      <Link {...repositoryOptions({ owner, name, ref: commit, path: row.original.path })}>{row.original.path}</Link>
      {row.original.name ? <small>{row.original.name}</small> : null}
    </> },
    { id: 'format', accessorFn: item => format(item.format), header: 'Format' },
    { id: 'state', accessorFn: item => state(item.state), header: 'Inspection' },
    { id: 'policy', header: 'Policy ceilings', accessorFn:item=>`Manual ${policyLabel(item,'manual')} Automatic push ${policyLabel(item,'push')}`, cell:({row})=><><span>Manual: {policyLabel(row.original,'manual')}</span><small>Automatic push: {policyLabel(row.original,'push')}</small></> },
    { id: 'size', accessorFn: item => item.byteSize.toString(), header: 'Bytes', cell: ({ row }) => row.original.byteSize.toString(), enableSorting: false },
    { id: 'run', header: 'Run', enableSorting: false, enableGlobalFilter: false, cell: ({ row }) => manualEligible(row.original) ? <button className="button secondary" disabled={!canDispatch(row.original)} onClick={() => void dispatch(row.original.path)}>Run workflow</button> : <span className="muted">{row.original.state === WorkflowInspectionState.VALIDATED_SUBSET ? 'Push trigger only' : 'Unsupported'}</span> },
    { id: 'findings', header: 'Details', enableSorting: false, enableGlobalFilter: false, cell: ({ row }) => <details>
      <summary>Inspect {row.original.path}</summary>
      <p>Blob <code>{row.original.blobId}</code></p>
      {row.original.events.length ? <p>Declared events: {row.original.events.join(', ')}. Effective policies and automation grants determine activation.</p> : null}
      {row.original.jobs.length ? <ul>{row.original.jobs.map(job => <li key={job.id}>
        <strong>{job.name || job.id}</strong>{job.name && job.name !== job.id ? ` (${job.id})` : ''}
        {job.stage ? ` · Stage ${job.stage}` : ''} · {job.stepCount} declared step{job.stepCount === 1 ? '' : 's'}
      </li>)}</ul> : <p>No job summary is available for this configuration.</p>}
      {row.original.diagnostics.length ? <Diagnostics diagnostics={row.original.diagnostics} /> : <p>The bounded static inspection found no unsupported fields. Static inspection does not execute jobs.</p>}
    </details> },
  ], [owner, name, commit, dispatching, stored, unresolved, originalMatches, signingOut, result]);

  const configurationPanel = <section className="browser-panel credential-list-panel" aria-labelledby="workflow-inventory-title">
        <div className="browser-panel-heading"><h2 id="workflow-inventory-title">Configuration files</h2><button className="button secondary" disabled={query.isFetching || metadata.isFetching || signingOut} onClick={refreshInspection}><RefreshCw size={15} />Refresh workflow inspection</button></div>
        <p className="panel-footnote">Manual execution requires every applicable execution policy to allow this repository and workflow, plus an operator-enrolled worker and approved image. A checked inspection subset alone does not grant execution.</p>
        {!workView?dispatchNotice:null}
        {inspectionError ? <PanelError error={inspectionError} retry={refreshInspection} /> : !result ? <Loading label="Inspecting workflow configuration…" /> : <>
          <p className="panel-footnote">Pinned commit <Link {...repositoryOptions({ owner, name, ref: commit })}><code>{commit}</code></Link> · Catalog <code>{result.catalogVersion}</code>. Refresh resolves the current default branch again.</p>
          {result.diagnostics.length ? <div role="status"><Diagnostics diagnostics={result.diagnostics} /></div> : null}
          <DataTable label="Workflow configurations" data={result.configurations} columns={columns} getRowId={item => item.path} emptyMessage="No matching workflow configuration files at this commit." />
          <p className="panel-footnote">{result.configurations.length} configuration{result.configurations.length === 1 ? '' : 's'} inspected or reported as unsupported. Direct <code>.github/workflows/*.yml</code>/<code>*.yaml</code> and root <code>.gitlab-ci.yml</code> only; nested and custom locations are excluded.</p>
        </>}
        <p className="panel-footnote">Limits: 20 files, 64 KiB per inspected file and 512 KiB in total. Oversized files stay metadata-only; an overfull inventory fails visibly. Scripts and provider-specific semantics remain untrusted. Automatic push execution requires configured policies and an active automation grant; deployments remain unavailable.</p>
      </section>;

  const content = <>
    <section className="page-stack" aria-labelledby="workflow-configurations-title">
      <header className="repository-intro"><div>{workView ? null : <span className="eyebrow">REPOSITORY CONFIGURATION</span>}<h1 id="workflow-configurations-title"><FileCode2 size={29} />{workView?'Actions':'Workflow configuration'}</h1>{!workView?<p>Inspect Actions and GitLab configuration from the current default-branch commit.</p>:null}</div>{workView?<button className="button secondary" aria-expanded={tasksOpen} onClick={()=>setTasksOpen(open=>!open)}><Bot size={15}/>New coding task</button>:null}</header>
      {workView ? <>
        {result&&!result.executionAvailable?<p className="workflow-readiness" role="status">Workflow execution is unavailable. <Link to="/$owner/$name/settings/workflows" params={{owner,name}}>Review workflow settings</Link></p>:null}
        {dispatchNotice}
        <div className="actions-workspace"><aside className="workflow-navigation-panel" aria-label="Actions navigation"><div className="workflow-mobile-filters"><select aria-label="Run type" value={location.actionKind||''} onChange={event=>void navigate(repositoryOptions(location,{run:undefined,runKind:undefined,actionKind:(event.target.value||undefined) as RepositoryLocation['actionKind'],workflowPath:undefined,step:undefined}))}><option value="">All runs</option><option value="workflow">Workflow runs</option><option value="coding-task">Coding tasks</option><option value="review">PR reviews</option></select><select aria-label="Workflow" value={selectedPath||''} disabled={!result} onChange={event=>void navigate(repositoryOptions(location,{run:undefined,runKind:undefined,actionKind:'workflow',workflowPath:event.target.value||undefined,step:undefined}))}><option value="">All workflows</option>{result?.configurations.map(item=><option key={item.path} value={item.path}>{item.name||item.path.split('/').at(-1)}</option>)}</select></div><h2>Runs</h2><nav className="workflow-navigation" aria-label="Run navigation">
          <Link {...repositoryOptions(location,{run:undefined,runKind:undefined,actionKind:undefined,workflowPath:undefined,step:undefined})} className="workflow-nav-link" aria-current={!location.actionKind?'page':undefined}><ListFilter size={16}/>All runs</Link>
          {([{kind:'workflow',label:'Workflow runs',Icon:Workflow},{kind:'coding-task',label:'Coding tasks',Icon:Bot},{kind:'review',label:'PR reviews',Icon:GitPullRequest}] as const).map(({kind,label,Icon})=><Link key={kind} {...repositoryOptions(location,{run:undefined,runKind:undefined,actionKind:kind,workflowPath:undefined,step:undefined})} className="workflow-nav-link" aria-current={location.actionKind===kind&&!selectedPath?'page':undefined}><Icon size={16}/>{label}</Link>)}
        </nav><h3>Workflows</h3><nav className="workflow-navigation" aria-label="Workflow navigation">{result?.configurations.map(item=><Link key={item.path} {...repositoryOptions(location,{run:undefined,runKind:undefined,actionKind:'workflow',workflowPath:item.path,step:undefined})} className="workflow-nav-link" aria-label={`Show runs for ${item.path}`} title={`${item.name||item.path} · ${item.path}`} aria-current={selectedPath===item.path?'page':undefined}><FileCode2 size={16}/><span>{item.name||item.path.split('/').at(-1)}</span></Link>)}</nav>
        {inspectionError?<PanelError error={inspectionError} retry={refreshInspection}/>:!result?<Loading label="Inspecting workflow navigation…"/>:null}
        <Link className="text-button" to="/$owner/$name/settings/workflows" params={{owner,name}}><Settings2 size={15}/>Workflow settings</Link></aside><div className="actions-main">
        {tasksOpen?<AgentTasks key={scope} userId={userId} owner={owner} name={name} signingOut={signingOut} launcherOnly/>:null}
        {selectedConfiguration?<header className="browser-panel-heading workflow-selected-heading"><div><h2>{selectedConfiguration.name||selectedConfiguration.path}</h2><p className="field-help">Manual: {policyLabel(selectedConfiguration,'manual')} · Automatic push: {policyLabel(selectedConfiguration,'push')}. Policy observations do not grant native write access or activate a push grant.</p></div>{manualEligible(selectedConfiguration)?<button className="button secondary" disabled={!canDispatch(selectedConfiguration)} onClick={()=>void dispatch(selectedConfiguration.path)}>Run workflow</button>:null}</header>:null}
        <ActionRuns key={`${scope}-${effectiveRepositoryId}-${location.actionKind||''}-${selectedPath||''}`} userId={userId} repositoryId={effectiveRepositoryId} location={location} signingOut={signingOut||!identityReady}/></div></div>
        <details className="workflow-inspection-disclosure"><summary>Execution details and configuration</summary>{result?<div className="panel-content"><p className="field-help">{result.executionAvailable?'A workflow worker is configured.':'Workflow worker execution is unavailable.'} Execution requires policy approval; automatic pushes also need an active automation grant.</p><p className="field-help">Current default-branch configurations at <code title={commit}>{commit.slice(0,12)}</code>. A source-tab ref does not change run history.</p></div>:null}{configurationPanel}</details>

      </> : configurationPanel}
      {result && !workView ? <><ExecutionPolicyPanel key={`${userId}/${owner}/${name}`} userId={userId} signingOut={signingOut} scope={ExecutionScope.REPOSITORY} repository={{ owner, name }} />
      <ReviewerPanel userId={userId} owner={owner} name={name} signingOut={signingOut} showRuns={false}/><AgentUsagePanel userId={userId} signingOut={signingOut} scope={AgentUsageScope.REPOSITORY} repository={{ owner, name }} /><AutomationGrantPanel userId={userId} owner={owner} name={name} signingOut={signingOut} />
      <p className="panel-footnote"><Link {...repositoryOptions({owner,name,view:'actions'})}>Open Actions run history</Link> for workflows, coding tasks and PR reviews.</p></> : null}
    </section>
  </>;
  return workView ? content : <RepositorySettingsLayout owner={owner} name={name}>{content}</RepositorySettingsLayout>;
}
