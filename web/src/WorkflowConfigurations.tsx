import { AgentTasks } from './AgentTasks';
import { AgentUsagePanel } from './AgentUsagePanel';
import { AgentUsageScope } from './gen/golf/v1/golf_pb';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { FileCode2, RefreshCw } from 'lucide-react';
import { workflowClient, workflowRunClient, errorMessage } from './api';
import { RepositorySettingsLayout } from './AccountSettings';
import { DataTable, type DataTableColumn } from './DataTable';
import { Loading, PanelError, privateQuery } from './RepositoryUI';
import { repositoryOptions } from './navigation';
import { WorkflowRuns } from './WorkflowRuns';
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

export function WorkflowConfigurations({ userId, owner, name, signingOut }: { userId: string; owner: string; name: string; signingOut: boolean }) {
  const [dispatching, setDispatching] = useState(false);
  const [notice, setNotice] = useState('');
  const [uncertain, setUncertain] = useState(false);
  const controller = useRef<AbortController | null>(null);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; controller.current?.abort(); }; }, []);
  useEffect(() => { if (signingOut) { controller.current?.abort(); setNotice(''); } }, [signingOut]);
  const query = useQuery({ ...privateQuery, queryKey: ['workflow-configurations', userId, owner, name], enabled: !signingOut,
    queryFn: ({ signal }) => workflowClient.inspectWorkflows({ repository: { owner, name } }, { signal, timeoutMs: 25_000 }),
  });
  const result = query.isSuccess && !query.isFetching && !query.error && !signingOut ? query.data : undefined;
  const commit = result?.commitId ?? '';
  async function dispatch(path: string) {
    if (!commit || dispatching || uncertain || signingOut) return;
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
    { id: 'size', accessorFn: item => item.byteSize.toString(), header: 'Bytes', cell: ({ row }) => row.original.byteSize.toString(), enableSorting: false },
    { id: 'run', header: 'Run', enableSorting: false, enableGlobalFilter: false, cell: ({ row }) => row.original.state === WorkflowInspectionState.VALIDATED_SUBSET && (row.original.format === WorkflowFormat.GITLAB_CI || row.original.events.includes("workflow_dispatch")) ? <button className="button secondary" disabled={dispatching || uncertain || signingOut || !result?.executionAvailable} onClick={() => void dispatch(row.original.path)}>Run workflow</button> : <span className="muted">{row.original.state === WorkflowInspectionState.VALIDATED_SUBSET ? 'Push trigger only' : 'Unsupported'}</span> },
    { id: 'findings', header: 'Details', enableSorting: false, enableGlobalFilter: false, cell: ({ row }) => <details>
      <summary>Inspect {row.original.path}</summary>
      <p>Blob <code>{row.original.blobId}</code></p>
      {row.original.events.length ? <p>Declared events: {row.original.events.join(', ')}. No triggers are active.</p> : null}
      {row.original.jobs.length ? <ul>{row.original.jobs.map(job => <li key={job.id}>
        <strong>{job.name || job.id}</strong>{job.name && job.name !== job.id ? ` (${job.id})` : ''}
        {job.stage ? ` · Stage ${job.stage}` : ''} · {job.stepCount} declared step{job.stepCount === 1 ? '' : 's'}
      </li>)}</ul> : <p>No job summary is available for this configuration.</p>}
      {row.original.diagnostics.length ? <Diagnostics diagnostics={row.original.diagnostics} /> : <p>The bounded static inspection found no unsupported fields. Jobs have not run.</p>}
    </details> },
  ], [owner, name, commit, dispatching, uncertain, signingOut, result?.executionAvailable]);

  return <RepositorySettingsLayout owner={owner} name={name}>
    <section className="page-stack" aria-labelledby="workflow-configurations-title">
      <header className="repository-intro"><div><span className="eyebrow">REPOSITORY CONFIGURATION</span><h1 id="workflow-configurations-title"><FileCode2 size={29} />Workflow configuration</h1><p>Inspect Actions and GitLab configuration from the current default-branch commit.</p></div></header>
      <section className="browser-panel credential-list-panel" aria-labelledby="workflow-inventory-title">
        <div className="browser-panel-heading"><h2 id="workflow-inventory-title">Configuration files</h2><button className="button secondary" disabled={query.isFetching || signingOut} onClick={() => void query.refetch()}><RefreshCw size={15} />Refresh workflow inspection</button></div>
        <p className="panel-footnote">Manual execution requires every applicable execution policy to allow this repository and workflow, plus an operator-enrolled worker and approved image. A checked inspection subset alone does not grant execution.</p>
        {notice && !signingOut ? <p role="status" className="panel-footnote">{notice}{uncertain ? <button className="text-button" onClick={() => { setUncertain(false); setNotice(''); }}>I inspected runs; allow a new dispatch</button> : null}</p> : null}
        {query.error ? <PanelError error={query.error} retry={() => void query.refetch()} /> : !result ? <Loading label="Inspecting workflow configuration…" /> : <>
          <p className="panel-footnote">Pinned commit <Link {...repositoryOptions({ owner, name, ref: commit })}><code>{commit}</code></Link> · Catalog <code>{result.catalogVersion}</code>. Refresh resolves the current default branch again.</p>
          {result.diagnostics.length ? <div role="status"><Diagnostics diagnostics={result.diagnostics} /></div> : null}
          <DataTable label="Workflow configurations" data={result.configurations} columns={columns} getRowId={item => item.path} emptyMessage="No matching workflow configuration files at this commit." />
          <p className="panel-footnote">{result.configurations.length} configuration{result.configurations.length === 1 ? '' : 's'} inspected or reported as unsupported. Direct <code>.github/workflows/*.yml</code>/<code>*.yaml</code> and root <code>.gitlab-ci.yml</code> only; nested and custom locations are excluded.</p>
        </>}
        <p className="panel-footnote">Limits: 20 files, 64 KiB per inspected file and 512 KiB in total. Oversized files stay metadata-only; an overfull inventory fails visibly. Scripts and provider-specific semantics remain untrusted. Automatic triggers and deployments remain unavailable.</p>
      </section>
      {result ? <><ExecutionPolicyPanel key={`${userId}/${owner}/${name}`} userId={userId} signingOut={signingOut} scope={ExecutionScope.REPOSITORY} repository={{ owner, name }} />
      <AgentTasks userId={userId} owner={owner} name={name} signingOut={signingOut}/><AgentUsagePanel userId={userId} signingOut={signingOut} scope={AgentUsageScope.REPOSITORY} repository={{ owner, name }} /><AutomationGrantPanel userId={userId} owner={owner} name={name} signingOut={signingOut} />
      <WorkflowRuns key={`runs/${userId}/${owner}/${name}`} userId={userId} owner={owner} name={name} signingOut={signingOut} /></> : null}
    </section>
  </RepositorySettingsLayout>;
}
