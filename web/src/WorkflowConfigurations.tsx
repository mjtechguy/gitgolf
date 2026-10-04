import { ReviewerPanel } from './ReviewerPanel';
import { AgentTasks } from './AgentTasks';
import { AgentUsagePanel } from './AgentUsagePanel';
import { AgentUsageScope } from './gen/golf/v1/golf_pb';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { Code, ConnectError } from '@connectrpc/connect';
import { Bot, FileCode2, GitPullRequest, ListFilter, RefreshCw, Settings2, Workflow } from 'lucide-react';
import { repositoryClient, workflowClient, workflowRunClient, errorMessage } from './api';
import { sourceRepositoryID } from './sourceReads';
import { RepositorySettingsLayout } from './AccountSettings';
import { DataTable, type DataTableColumn } from './DataTable';
import { Loading, PanelError, privateQuery } from './RepositoryUI';
import { repositoryOptions, defaultRepositorySearch, type RepositoryLocation } from './navigation';
import { ActionRuns } from './ActionRuns';
import { AutomationGrantPanel } from './AutomationGrantPanel';
import { ExecutionPolicyPanel } from './ExecutionPolicyPanel';
import { ExecutionScope, WorkflowFormat, WorkflowInspectionState, type WorkflowConfiguration, type WorkflowDiagnostic } from './gen/golf/v1/golf_pb';

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
  const [dispatching, setDispatching] = useState(false);
  const [tasksOpen, setTasksOpen] = useState(false);
  const location:RepositoryLocation=suppliedLocation||{...defaultRepositorySearch,kind:'repository',owner,name,view:'actions'};
  const scope = JSON.stringify([userId,owner,name]);
  const [notice, setNotice] = useState('');
  const [uncertain, setUncertain] = useState(false);
  const controller = useRef<AbortController | null>(null);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; controller.current?.abort(); }; }, []);
  useEffect(() => { if (signingOut) { controller.current?.abort(); setNotice(''); } }, [signingOut]);
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
  const inspectionError = identityError || query.error;
  const refreshInspection = () => { if(identityReady)void query.refetch();else if(!repositoryId)void metadata.refetch(); };
  const result = identityReady && query.isSuccess && !query.isFetching && !query.error && !signingOut ? query.data : undefined;
  const commit = result?.commitId ?? '';
  const policyObserved = (item:WorkflowConfiguration) => Boolean(result && /^[a-f0-9]{64}$/.test(result.policyRevision) && typeof item.manualPolicyAllowed==='boolean' && typeof item.pushPolicyAllowed==='boolean');
  const policyLabel = (item:WorkflowConfiguration, kind:'manual'|'push') => !policyObserved(item)?'Unknown':(kind==='manual'?item.manualPolicyAllowed:item.pushPolicyAllowed)?'Ceilings allow':'Ceilings deny';
  const selectedPath = location.actionKind==='workflow' ? location.workflowPath : undefined;
  const manualEligible = (item:WorkflowConfiguration) => item.state===WorkflowInspectionState.VALIDATED_SUBSET && (item.format===WorkflowFormat.GITLAB_CI || item.events.includes('workflow_dispatch'));
  const canDispatch = (item:WorkflowConfiguration) => Boolean(commit && manualEligible(item) && policyObserved(item) && item.manualPolicyAllowed===true && result?.executionAvailable && !dispatching && !uncertain && !signingOut);
  const selectedConfiguration = selectedPath ? result?.configurations.find(item=>item.path===selectedPath) : undefined;
  const dispatchNotice = notice && result && !signingOut ? <p role="status" className="panel-footnote">{notice}{uncertain ? <button className="text-button" onClick={() => { setUncertain(false); setNotice(''); }}>I inspected runs; allow a new dispatch</button> : null}</p> : null;
  async function dispatch(path: string) {
    const item=result?.configurations.find(item=>item.path===path);
    if (!item || !canDispatch(item)) return;
    const request = new AbortController(); controller.current = request; setDispatching(true); setNotice('');
    try { const receipt = await workflowRunClient.dispatchWorkflow({ repository: { owner, name }, ref: commit, workflowPath: path, idempotencyKey: crypto.randomUUID() }, { signal: request.signal, timeoutMs: 25_000 });
      if (!alive.current || request.signal.aborted) return;
      if (!receipt.run || receipt.run.commitId !== commit || receipt.run.workflowPath !== path) throw new Error('Dispatch receipt could not be verified.');
      setNotice(`Run ${receipt.run.id} recorded. Refresh runs to inspect its state.`);
    } catch (error) { if (alive.current && !request.signal.aborted) { setUncertain(true); setNotice(`${errorMessage(error instanceof Error ? error : new Error('Dispatch could not be confirmed.'))} Inspect workflow runs before a new dispatch. No automatic retry was made.`); } }
    finally { if (controller.current === request) controller.current = null; if (alive.current) setDispatching(false); }
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
  ], [owner, name, commit, dispatching, uncertain, signingOut, result]);

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
      <header className="repository-intro"><div>{workView ? null : <span className="eyebrow">REPOSITORY CONFIGURATION</span>}<h1 id="workflow-configurations-title"><FileCode2 size={29} />{workView?'Actions':'Workflow configuration'}</h1><p>{workView ? 'Workflow, coding task and PR review runs for this repository.' : 'Inspect Actions and GitLab configuration from the current default-branch commit.'}</p></div></header>
      {workView ? <>
        {result?<p className="workflow-readiness">{result.executionAvailable?'A workflow worker is configured.':'Workflow worker execution is unavailable.'} Execution requires policy approval; automatic pushes also need an active automation grant. <Link to="/$owner/$name/settings/workflows" params={{owner,name}}>Review workflow settings</Link></p>:null}
        {dispatchNotice}
        <div className="actions-workspace"><aside className="workflow-navigation-panel" aria-label="Actions navigation"><h2>Runs</h2><nav className="workflow-navigation" aria-label="Run navigation">
          <Link {...repositoryOptions(location,{run:undefined,runKind:undefined,actionKind:undefined,workflowPath:undefined,step:undefined})} className="workflow-nav-link" aria-current={!location.actionKind?'page':undefined}><ListFilter size={16}/>All runs</Link>
          {([{kind:'workflow',label:'Workflow runs',Icon:Workflow},{kind:'coding-task',label:'Coding tasks',Icon:Bot},{kind:'review',label:'PR reviews',Icon:GitPullRequest}] as const).map(({kind,label,Icon})=><Link key={kind} {...repositoryOptions(location,{run:undefined,runKind:undefined,actionKind:kind,workflowPath:undefined,step:undefined})} className="workflow-nav-link" aria-current={location.actionKind===kind&&!selectedPath?'page':undefined}><Icon size={16}/>{label}</Link>)}
        </nav><h3>Workflows</h3><nav className="workflow-navigation" aria-label="Workflow navigation">{result?.configurations.map(item=><Link key={item.path} {...repositoryOptions(location,{run:undefined,runKind:undefined,actionKind:'workflow',workflowPath:item.path,step:undefined})} className="workflow-nav-link" aria-label={`Show runs for ${item.path}`} title={`${item.name||item.path} · ${item.path}`} aria-current={selectedPath===item.path?'page':undefined}><FileCode2 size={16}/><span>{item.name||item.path}</span></Link>)}</nav>
        {inspectionError?<PanelError error={inspectionError} retry={refreshInspection}/>:!result?<Loading label="Inspecting workflow navigation…"/>:<p className="field-help">Current default-branch configurations at <code title={commit}>{commit.slice(0,12)}</code>. A source-tab ref does not change run history.</p>}
        <Link className="text-button" to="/$owner/$name/settings/workflows" params={{owner,name}}><Settings2 size={15}/>Workflow settings</Link></aside><div className="actions-main">
        <div className="browser-panel-heading action-inventory-actions"><span className="field-help">Recorded execution history</span><button className="button secondary" aria-expanded={tasksOpen} onClick={()=>setTasksOpen(open=>!open)}><Bot size={15}/>New coding task</button></div>
        {tasksOpen?<AgentTasks key={scope} userId={userId} owner={owner} name={name} signingOut={signingOut} launcherOnly/>:null}
        {selectedConfiguration?<header className="browser-panel-heading workflow-selected-heading"><div><h2>{selectedConfiguration.name||selectedConfiguration.path}</h2><p className="field-help">Manual: {policyLabel(selectedConfiguration,'manual')} · Automatic push: {policyLabel(selectedConfiguration,'push')}. Policy observations do not grant native write access or activate a push grant.</p></div>{manualEligible(selectedConfiguration)?<button className="button secondary" disabled={!canDispatch(selectedConfiguration)} onClick={()=>void dispatch(selectedConfiguration.path)}>Run workflow</button>:null}</header>:null}
        <ActionRuns key={`${scope}-${effectiveRepositoryId}-${location.actionKind||''}-${selectedPath||''}`} userId={userId} repositoryId={effectiveRepositoryId} location={location} signingOut={signingOut||!identityReady}/></div></div>
        <details className="workflow-inspection-disclosure"><summary>Workflow configuration files</summary>{configurationPanel}</details>

      </> : configurationPanel}
      {result && !workView ? <><ExecutionPolicyPanel key={`${userId}/${owner}/${name}`} userId={userId} signingOut={signingOut} scope={ExecutionScope.REPOSITORY} repository={{ owner, name }} />
      <ReviewerPanel userId={userId} owner={owner} name={name} signingOut={signingOut} showRuns={false}/><AgentUsagePanel userId={userId} signingOut={signingOut} scope={AgentUsageScope.REPOSITORY} repository={{ owner, name }} /><AutomationGrantPanel userId={userId} owner={owner} name={name} signingOut={signingOut} />
      <p className="panel-footnote"><Link {...repositoryOptions({owner,name,view:'actions'})}>Open Actions run history</Link> for workflows, coding tasks and PR reviews.</p></> : null}
    </section>
  </>;
  return workView ? content : <RepositorySettingsLayout owner={owner} name={name}>{content}</RepositorySettingsLayout>;
}
