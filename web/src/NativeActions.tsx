import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate } from '@tanstack/react-router';
import { useForm } from '@tanstack/react-form';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Ban, CheckCircle2, ChevronRight, CircleDashed, CircleDot, Clock, Download, GitBranch, GitCommitHorizontal, Hand, LoaderCircle, MinusCircle, Play, Plus, RefreshCw, Rocket, RotateCcw, ShieldCheck, Workflow, XCircle } from 'lucide-react';
import { nativeAPI as api } from './nativeAPI';
import { DateLabel, PageHeader, privateQuery, usePageVisible, Loading } from './RepositoryUI';
import { DataTable, type DataTableColumn } from './DataTable';
import { repositoryOptions } from './navigation';
import { useLiveStatus } from './RepositoryLive';

type Context = { repository: { owner: string; name: string }; repositoryId: string };
export type PipelineRun = { id: string; number: number; engine: string; workflowPath: string; workflowName: string; event: string; ref: string; branch: string; commitId: string; pullNumber: number | null; headRef: string; baseRef: string; actor: string; trusted: boolean; title: string; state: string; reason: string; attempt: number; cancelRequested: boolean; inputs: Record<string, string>; createdAt: string; startedAt: string | null; finishedAt: string | null; updatedAt: string };
export type PipelineStep = { number: number; name: string; state: string; startedAt: string | null; finishedAt: string | null; logIndex: number; logLength: number };
export type PipelineJob = { id: string; key: string; name: string; attempt: number; stage: string; stageIndex: number; needs: string[]; runsOn: string[]; state: string; when: string; allowFailure: boolean; exitCode: number | null; failureReason: string; reusedFrom: string; runner: string; logLines: number; logComplete: boolean; createdAt: string; startedAt: string | null; finishedAt: string | null; steps: PipelineStep[]; waitingForLabels: boolean };
export type PipelineArtifact = { id: string; name: string; kind: string; size: number; jobId: string; createdAt: string; expiresAt: string; expired: boolean };
type RunList = { runs: PipelineRun[]; total: number; nextPage: number; workflows: { path: string; name: string; engine: string; runs: number }[]; canWrite: boolean; enabled: boolean };
type RunDetail = { run: PipelineRun; attempt: number; canWrite: boolean; jobs: PipelineJob[]; artifacts: PipelineArtifact[] };
type Workflows = { branch: string; branches: string[]; workflows: { path: string; name: string; events: string[]; dispatch: boolean; inputs: { name: string; description: string; type: string; required: boolean; default: string; options: string[] }[]; error: string }[] };
const active = (state: string) => ['QUEUED', 'RUNNING', 'WAITING', 'BLOCKED', 'APPROVAL', 'MANUAL'].includes(state);
const message = (error: unknown) => error instanceof Error ? error.message : 'The request could not be confirmed.';
const eventLabels: Record<string, string> = { push: 'push', pull_request: 'pull request', workflow_dispatch: 'manually run', merge_request_event: 'merge request', web: 'manually run', schedule: 'schedule' };
const stateLabels: Record<string, string> = { QUEUED: 'Queued', RUNNING: 'In progress', WAITING: 'Waiting', SUCCESS: 'Success', FAILURE: 'Failure', CANCELLED: 'Cancelled', SKIPPED: 'Skipped', REFUSED: 'Refused', BLOCKED: 'Waiting for needs', MANUAL: 'Manual', APPROVAL: 'Waiting for approval', PENDING: 'Pending' };

export function StateIcon({ state, size = 16, label: named }: { state: string; size?: number; label?: string }) {
  const label = named || stateLabels[state] || state;
  const icon = state === 'SUCCESS' ? <CheckCircle2 size={size} /> : state === 'FAILURE' || state === 'REFUSED' ? <XCircle size={size} /> : state === 'RUNNING' ? <LoaderCircle size={size} className="spin" />
    : state === 'CANCELLED' ? <Ban size={size} /> : state === 'SKIPPED' ? <MinusCircle size={size} /> : state === 'APPROVAL' ? <ShieldCheck size={size} /> : state === 'MANUAL' ? <Hand size={size} /> : state === 'QUEUED' ? <CircleDot size={size} /> : <CircleDashed size={size} />;
  return <span className={`pipeline-state pipeline-state-${state.toLowerCase()}`} title={label} role="img" aria-label={label}>{icon}</span>;
}
export function duration(start: string | null, end: string | null) {
  if (!start) return '';
  const seconds = Math.max(0, Math.round(((end ? Date.parse(end) : Date.now()) - Date.parse(start)) / 1000));
  return seconds < 60 ? `${seconds}s` : seconds < 3600 ? `${Math.floor(seconds / 60)}m ${seconds % 60}s` : `${Math.floor(seconds / 3600)}h ${Math.floor(seconds % 3600 / 60)}m`;
}
const refresh = (state?: string) => state && active(state) ? 2000 : false;

export function NativeActions({ context, userId, runId, workflowPath, evidence }: { context: Context; userId: string; runId?: string; workflowPath?: string; evidence?: React.ReactNode }) {
  return runId ? <NativeRunDetail key={runId} context={context} userId={userId} runId={runId} /> : <NativeRunList context={context} userId={userId} workflowPath={workflowPath} evidence={evidence} />;
}

function NativeRunList({ context, userId, workflowPath, evidence }: { context: Context; userId: string; workflowPath?: string; evidence?: React.ReactNode }) {
  const live = useLiveStatus() === 'live', visible = usePageVisible();
  const [filters, setFilters] = useState({ event: '', status: '', branch: '', actor: '' });
  const [page, setPage] = useState(1), [dispatching, setDispatching] = useState(false), [panel, setPanel] = useState<'runs' | 'evidence' | 'environments'>('runs');
  const runs = useQuery({ ...privateQuery, queryKey: ['native-pipelines', userId, context.repositoryId, 'runs', workflowPath || '', filters, page],
    queryFn: ({ signal }) => api<RunList>('/native/pipelines', { ...context, action: 'listRuns', ...(workflowPath ? { workflow: workflowPath } : {}), ...Object.fromEntries(Object.entries(filters).filter(([, v]) => v)), page }, signal),
    refetchInterval: query => visible && (!live || query.state.data?.runs.some(run => active(run.state))) ? 5000 : false });
  const workflows = useQuery({ ...privateQuery, queryKey: ['native-pipelines', userId, context.repositoryId, 'workflows'], queryFn: ({ signal }) => api<Workflows>('/native/pipelines', { ...context, action: 'workflows' }, signal) });
  const known = useMemo(() => {
    const map = new Map<string, { path: string; name: string; dispatch: boolean }>();
    for (const w of runs.data?.workflows || []) map.set(w.path, { path: w.path, name: w.name, dispatch: false });
    for (const w of workflows.data?.workflows || []) map.set(w.path, { path: w.path, name: w.name, dispatch: w.dispatch });
    return [...map.values()].sort((a, b) => a.name.localeCompare(b.name));
  }, [runs.data, workflows.data]);
  const selected = known.find(w => w.path === workflowPath), definition = workflows.data?.workflows.find(w => w.path === workflowPath);
  const columns: DataTableColumn<PipelineRun>[] = [
    { id: 'run', header: 'Run', accessorFn: run => `${run.title} ${run.workflowName} ${run.number} ${run.actor}`, cell: ({ row: { original: run } }) => <div className="workflow-run-row"><StateIcon state={run.state} size={18} /><div>
      <Link {...repositoryOptions({ ...context.repository, view: 'actions', run: run.id })}>{run.title || run.workflowName}</Link>
      <div className="pipeline-run-subtitle"><strong>{run.workflowName}</strong> #{run.number}: {run.event === 'pull_request' ? <>Pull request #{run.pullNumber} {run.attempt > 1 ? `re-run ${run.attempt}` : 'synchronized'}</> : <>{eventLabels[run.event] || run.event}</>}{run.actor ? <> by {run.actor}</> : null}</div>
      {run.state === 'REFUSED' && run.reason ? <p className="pipeline-reason">{run.reason}</p> : null}</div></div> },
    { id: 'branch', header: 'Branch', accessorFn: run => run.headRef || run.branch, cell: ({ row: { original: run } }) => <span className="pipeline-ref"><GitBranch size={13} aria-hidden="true" />{run.headRef || run.branch}</span> },
    { id: 'when', header: 'When', accessorFn: run => run.createdAt, cell: ({ row: { original: run } }) => <span className="pipeline-when"><DateLabel value={run.createdAt} relative /><span><Clock size={13} aria-hidden="true" />{duration(run.startedAt, run.finishedAt) || stateLabels[run.state]}</span></span> },
  ];
  const statusOptions = [['', 'All statuses'], ['in_progress', 'In progress'], ['completed', 'Completed'], ['SUCCESS', 'Success'], ['FAILURE', 'Failure'], ['CANCELLED', 'Cancelled'], ['WAITING', 'Waiting'], ['REFUSED', 'Refused']];
  const set = (key: keyof typeof filters, value: string) => { setPage(1); setFilters(current => ({ ...current, [key]: value })); };
  return <div className="page-stack repository-work-page"><div className="actions-workspace">
    <nav className="workflow-navigation-panel" aria-label="Workflows"><h2>Actions</h2><div className="workflow-navigation">
      <Link className="workflow-nav-link" aria-current={!workflowPath && panel === 'runs' ? 'page' : undefined} activeProps={{ 'aria-current': !workflowPath && panel === 'runs' ? 'page' : undefined }} {...repositoryOptions({ ...context.repository, view: 'actions', actionKind: undefined, workflowPath: undefined })} onClick={() => setPanel('runs')}><Workflow size={16} /><span>All workflows</span></Link>
      {known.map(w => <Link key={w.path} className="workflow-nav-link" aria-current={workflowPath === w.path && panel === 'runs' ? 'page' : undefined} activeProps={{ 'aria-current': workflowPath === w.path && panel === 'runs' ? 'page' : undefined }} title={w.path} {...repositoryOptions({ ...context.repository, view: 'actions', actionKind: 'workflow', workflowPath: w.path })} onClick={() => setPanel('runs')}><Workflow size={16} /><span>{w.name}</span></Link>)}
      <button type="button" className="workflow-nav-link" aria-current={panel === 'environments' ? 'page' : undefined} onClick={() => setPanel('environments')}><Rocket size={16} /><span>Environments</span></button>
      {evidence ? <button type="button" className="workflow-nav-link" aria-current={panel === 'evidence' ? 'page' : undefined} onClick={() => setPanel('evidence')}><ShieldCheck size={16} /><span>Pull request checks</span></button> : null}
    </div>{workflows.data?.workflows.some(w => w.error) ? <p className="field-help">{workflows.data.workflows.filter(w => w.error).length} workflow file(s) on {workflows.data.branch} cannot run; open them to see why.</p> : null}</nav>
    <div className="actions-main">{panel === 'evidence' ? evidence : panel === 'environments' ? <DeploymentEnvironments context={context} userId={userId} /> : <>
      <PageHeader title={selected?.name || 'All workflows'} description={selected ? selected.path : 'Workflow runs from pushes, pull requests and manual dispatch, run by your registered runners.'}
        actions={<div className="row-actions">{runs.data?.canWrite && definition?.dispatch && runs.data.enabled ? <button className="button primary" aria-expanded={dispatching} onClick={() => setDispatching(!dispatching)}><Play size={15} />Run workflow</button> : null}<button className="button secondary" aria-label="Refresh runs" disabled={runs.isFetching} onClick={() => { void runs.refetch(); void workflows.refetch(); }}><RefreshCw size={15} className={runs.isFetching ? 'spin' : ''} />Refresh</button></div>} />
      {definition?.error ? <p className="error" role="alert">This workflow file cannot run: {definition.error}</p> : null}
      {dispatching && definition && workflows.data ? <DispatchForm context={context} workflow={definition} branches={workflows.data.branches} defaultBranch={workflows.data.branch} close={() => setDispatching(false)} /> : null}
      {runs.data && !runs.data.enabled ? <p className="field-help" role="status">Actions are turned off for this repository. Existing runs stay readable.</p> : null}
      <section className="browser-panel workflow-runs-panel" aria-labelledby="pipeline-runs-title">
        <div className="browser-panel-heading"><h3 id="pipeline-runs-title">{runs.data ? `${runs.data.total} workflow run${runs.data.total === 1 ? '' : 's'}` : 'Workflow runs'}</h3>
          <div className="pipeline-filters" role="group" aria-label="Filter runs">
            <select aria-label="Event" value={filters.event} onChange={e => set('event', e.target.value)}><option value="">All events</option>{['push', 'pull_request', 'workflow_dispatch', 'merge_request_event'].map(v => <option key={v} value={v}>{eventLabels[v]}</option>)}</select>
            <select aria-label="Status" value={filters.status} onChange={e => set('status', e.target.value)}>{statusOptions.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>
            <select aria-label="Branch" value={filters.branch} onChange={e => set('branch', e.target.value)}><option value="">All branches</option>{(workflows.data?.branches || []).map(b => <option key={b} value={b}>{b}</option>)}</select>
          </div></div>
        {runs.isError ? <p className="error" role="alert">{message(runs.error)}</p> : runs.data ? <DataTable data={runs.data.runs} columns={columns} getRowId={run => run.id} label="workflow runs" emptyMessage={workflowPath ? 'This workflow has no runs yet.' : 'No workflow runs yet. Push a workflow file under .github/workflows or .forgejo/workflows to start one.'} /> : <Loading label="Reading workflow runs…" />}
        <div className="pipeline-pages">{page > 1 ? <button className="button secondary" onClick={() => setPage(page - 1)}>Newer</button> : null}{runs.data?.nextPage ? <button className="button secondary" onClick={() => setPage(runs.data!.nextPage)}>Older</button> : null}</div>
        <p className="panel-footnote">Filters are applied by the server across every run; search and sorting apply to the 25 runs on this page.</p>
      </section></>}
    </div></div></div>;
}

function DispatchForm({ context, workflow, branches, defaultBranch, close }: { context: Context; workflow: Workflows['workflows'][number]; branches: string[]; defaultBranch: string; close: () => void }) {
  const navigate = useNavigate(), client = useQueryClient();
  const [error, setError] = useState<unknown>();
  const form = useForm({ defaultValues: { ref: defaultBranch, inputs: Object.fromEntries(workflow.inputs.map(input => [input.name, input.default || (input.type === 'boolean' ? 'false' : '')])) as Record<string, string> },
    onSubmit: async ({ value }) => {
      setError(undefined);
      try {
        const created = await api<{ runId: string }>('/native/pipelines', { ...context, action: 'dispatch', workflowPath: workflow.path, ref: value.ref, inputs: value.inputs });
        await client.invalidateQueries({ queryKey: ['native-pipelines'] });
        close();
        void navigate(repositoryOptions({ ...context.repository, view: 'actions', run: created.runId }));
      } catch (e) { setError(e); }
    } });
  return <form className="browser-panel credential-form-content pipeline-dispatch" aria-label={`Run ${workflow.name}`} onSubmit={event => { event.preventDefault(); void form.handleSubmit(); }}>
    <h3>Run {workflow.name}</h3><p className="field-help">Runs <code>{workflow.path}</code> at the head of the branch you choose, with these inputs.</p>
    <form.Field name="ref">{field => <label>Use workflow from<select value={field.state.value} onChange={e => field.handleChange(e.target.value)}>{branches.map(b => <option key={b} value={b}>{b}</option>)}</select></label>}</form.Field>
    {workflow.inputs.map(input => <form.Field key={input.name} name={`inputs.${input.name}` as const}>{field => input.type === 'boolean'
      ? <label className="checkbox-label"><input type="checkbox" checked={field.state.value === 'true'} onChange={e => field.handleChange(e.target.checked ? 'true' : 'false')} />{input.description || input.name}</label>
      : input.type === 'choice' ? <label>{input.description || input.name}<select value={field.state.value} onChange={e => field.handleChange(e.target.value)}>{input.options.map(o => <option key={o} value={o}>{o}</option>)}</select></label>
      : <label>{input.description || input.name}{input.required ? ' (required)' : ''}<input required={input.required} type={input.type === 'number' ? 'number' : 'text'} value={field.state.value} onChange={e => field.handleChange(e.target.value)} /></label>}</form.Field>)}
    {error ? <p className="error" role="alert">{message(error)}</p> : null}
    <form.Subscribe selector={state => state.isSubmitting}>{submitting => <div className="credential-actions"><button className="button primary" disabled={submitting}><Play size={15} />{submitting ? 'Starting…' : 'Run workflow'}</button><button type="button" className="button secondary" onClick={close}>Cancel</button></div>}</form.Subscribe>
  </form>;
}

function NativeRunDetail({ context, userId, runId }: { context: Context; userId: string; runId: string }) {
  const visible = usePageVisible(), client = useQueryClient();
  const [attempt, setAttempt] = useState<number>();
  const detail = useQuery({ ...privateQuery, queryKey: ['native-pipelines', userId, context.repositoryId, 'run', runId, attempt ?? 'latest'],
    queryFn: ({ signal }) => api<RunDetail>('/native/pipelines', { ...context, action: 'getRun', runId, ...(attempt ? { attempt } : {}) }, signal),
    refetchInterval: query => visible ? refresh(query.state.data?.run.state) || (query.state.data?.jobs.some(job => active(job.state)) ? 2000 : false) : false });
  const [selectedJob, setSelectedJob] = useState<string>(() => /^#job-(\d+)$/.exec(window.location.hash)?.[1] || '');
  const [busy, setBusy] = useState(false), [error, setError] = useState<unknown>();
  const act = async (body: object) => { setBusy(true); setError(undefined); try { await api('/native/pipelines', { ...context, ...body }); setAttempt(undefined); await client.invalidateQueries({ queryKey: ['native-pipelines'] }); } catch (e) { setError(e); } finally { setBusy(false); } };
  const choose = (id: string) => { setSelectedJob(id); history.replaceState(null, '', id ? `#job-${id}` : window.location.pathname + window.location.search); };
  if (detail.isError) return <section className="browser-panel"><p className="error" role="alert">{message(detail.error)}</p><Link className="button secondary" {...repositoryOptions({ ...context.repository, view: 'actions', run: undefined })}>Back to runs</Link></section>;
  if (!detail.data) return <Loading label="Reading workflow run…" />;
  const { run, jobs, artifacts, canWrite } = detail.data, job = jobs.find(item => item.id === selectedJob);
  const finished = !active(run.state) && run.state !== 'REFUSED';
  return <div className="page-stack repository-work-page pipeline-run">
    <div className="workflow-run-summary"><div>
      <Link className="text-button" {...repositoryOptions({ ...context.repository, view: 'actions', run: undefined, actionKind: 'workflow', workflowPath: run.workflowPath })}>← {run.workflowName}</Link>
      <h2><StateIcon state={run.state} size={22} /> {run.title || run.workflowName} <span className="pipeline-run-number">#{run.number}</span></h2>
      <p><span>{eventLabels[run.event] || run.event}{run.actor ? ` by ${run.actor}` : ''}</span><span className="pipeline-ref"><GitBranch size={13} aria-hidden="true" />{run.headRef || run.branch}</span><span><GitCommitHorizontal size={14} aria-hidden="true" /><code>{run.commitId.slice(0, 7)}</code></span></p>
    </div><div className="row-actions">
      {canWrite && active(run.state) && !run.cancelRequested ? <button className="button secondary" disabled={busy} onClick={() => void act({ action: 'cancel', runId: run.id })}><Ban size={15} />Cancel workflow</button> : null}
      {canWrite && finished && jobs.some(j => j.state !== 'SUCCESS' && j.state !== 'SKIPPED') ? <button className="button secondary" disabled={busy} onClick={() => void act({ action: 'rerun', runId: run.id, failedOnly: true })}><RotateCcw size={15} />Re-run failed jobs</button> : null}
      {canWrite && finished ? <button className="button primary" disabled={busy} onClick={() => void act({ action: 'rerun', runId: run.id, failedOnly: false })}><RotateCcw size={15} />Re-run all jobs</button> : null}
    </div></div>
    {error ? <p className="error" role="alert">{message(error)}</p> : null}
    {run.reason ? <p className={run.state === 'REFUSED' ? 'error' : 'field-help'} role={run.state === 'REFUSED' ? 'alert' : 'status'}>{run.state === 'REFUSED' ? 'This workflow could not run: ' : ''}{run.reason}</p> : null}
    {run.cancelRequested && active(run.state) ? <p className="field-help" role="status">Cancellation requested; running jobs stop at their next runner update.</p> : null}
    <div className="automation-run-layout">
      <nav className="automation-job-navigation pipeline-job-nav" aria-label="Jobs">
        <button type="button" className="workflow-nav-link" aria-current={!job ? 'page' : undefined} onClick={() => choose('')}><Workflow size={16} /><span>Summary</span></button>
        <h3>Jobs</h3><ol>{jobs.map(item => <li key={item.id}><button type="button" className="workflow-nav-link" aria-current={job?.id === item.id ? 'page' : undefined} onClick={() => choose(item.id)}><StateIcon state={item.state} /><span>{item.name}</span></button></li>)}</ol>
        {run.attempt > 1 ? <label className="pipeline-attempt">Attempt<select value={detail.data.attempt} onChange={e => setAttempt(Number(e.target.value))}>{Array.from({ length: run.attempt }, (_, i) => run.attempt - i).map(n => <option key={n} value={n}>#{n}{n === run.attempt ? ' (latest)' : ''}</option>)}</select></label> : null}
      </nav>
      <div className="automation-run-output">{job ? <JobLog key={job.id} context={context} job={job} run={run} canWrite={canWrite} act={act} busy={busy} /> : <RunSummary context={context} run={run} jobs={jobs} artifacts={artifacts} choose={choose} canWrite={canWrite} act={act} busy={busy} />}</div>
    </div></div>;
}

function RunSummary({ context, run, jobs, artifacts, choose, canWrite, act, busy }: { context: Context; run: PipelineRun; jobs: PipelineJob[]; artifacts: PipelineArtifact[]; choose: (id: string) => void; canWrite: boolean; act: (body: object) => Promise<void>; busy: boolean }) {
  // Columns by dependency depth: each job sits one column right of its deepest need, as on GitHub.
  const columns = useMemo(() => {
    const depth = new Map<string, number>(), byKey = new Map<string, PipelineJob[]>();
    for (const job of jobs) byKey.set(job.key, [...(byKey.get(job.key) || []), job]);
    const of = (key: string, seen = new Set<string>()): number => {
      if (depth.has(key)) return depth.get(key)!;
      if (seen.has(key)) return 0; seen.add(key);
      const needs = byKey.get(key)?.[0]?.needs || [], value = needs.length ? Math.max(...needs.map(need => of(need, seen) + 1)) : 0;
      depth.set(key, value); return value;
    };
    const result: PipelineJob[][] = [];
    for (const job of jobs) (result[of(job.key)] ||= []).push(job);
    return result.filter(Boolean);
  }, [jobs]);
  const approvals = jobs.filter(job => job.state === 'APPROVAL'), manual = jobs.filter(job => job.state === 'MANUAL');
  return <div className="page-stack">
    <section className="browser-panel workflow-run-metadata" aria-label="Run summary"><dl>
      <div><dt>Triggered via {eventLabels[run.event] || run.event}</dt><dd><DateLabel value={run.createdAt} relative /></dd></div>
      <div><dt>Status</dt><dd>{stateLabels[run.state] || run.state}</dd></div>
      <div><dt>Total duration</dt><dd>{duration(run.startedAt, run.finishedAt) || '—'}</dd></div>
      <div><dt>Artifacts</dt><dd>{artifacts.length}</dd></div>
    </dl>{Object.keys(run.inputs).length ? <details><summary>Inputs</summary><dl>{Object.entries(run.inputs).map(([k, v]) => <div key={k}><dt>{k}</dt><dd><code>{v}</code></dd></div>)}</dl></details> : null}
      {!run.trusted ? <p className="field-help">Secrets were withheld from this run because it was not triggered from this repository.</p> : null}</section>
    {approvals.map(job => <ApprovalPanel key={job.id} context={context} job={job} />)}
    {manual.length && canWrite ? <section className="browser-panel"><div className="browser-panel-heading"><h3>Manual jobs</h3></div><ul className="pipeline-manual">{manual.map(job => <li key={job.id}><span>{job.name}</span><button className="button secondary" disabled={busy} onClick={() => void act({ action: 'play', jobId: job.id })}><Play size={15} />Run</button></li>)}</ul></section> : null}
    <section className="browser-panel" aria-labelledby="pipeline-graph-title"><div className="browser-panel-heading"><h3 id="pipeline-graph-title">{run.workflowPath}</h3><span className="field-help">on: {run.event}</span></div>
      {jobs.length ? <div className="pipeline-graph" role="list" aria-label="Job graph">{columns.map((column, index) => <div key={index} className="pipeline-graph-column" role="presentation">{column.map(job => <button key={job.id} type="button" role="listitem" className={`pipeline-graph-job${index ? ' pipeline-graph-dependent' : ''}`} onClick={() => choose(job.id)}>
        <StateIcon state={job.state} /><span>{job.name}</span><span className="pipeline-graph-time">{duration(job.startedAt, job.finishedAt)}</span>
        {job.waitingForLabels ? <span className="pipeline-graph-note">Waiting for a runner with {job.runsOn.join(', ')}</span> : null}</button>)}</div>)}</div>
        : <p className="field-help">This run has no jobs.</p>}
    </section>
    <section className="browser-panel" aria-labelledby="pipeline-artifacts-title"><div className="browser-panel-heading"><h3 id="pipeline-artifacts-title">Artifacts</h3><span className="field-help">Produced during runtime</span></div>
      {artifacts.length ? <DataTable data={artifacts} getRowId={a => a.id} label="artifacts" pagination={false} columns={[
        { accessorKey: 'name', header: 'Name' },
        { accessorKey: 'size', header: 'Size', cell: ({ row }) => formatSize(row.original.size) },
        { id: 'expires', header: 'Expires', accessorFn: a => a.expiresAt, cell: ({ row }) => row.original.expired ? 'Expired' : <DateLabel value={row.original.expiresAt} /> },
        { id: 'download', header: 'Download', enableSorting: false, cell: ({ row }) => row.original.expired ? null : <ArtifactDownload context={context} artifact={row.original} /> },
      ]} /> : <p className="field-help">No artifacts were uploaded by this run.</p>}
    </section></div>;
}
export const formatSize = (bytes: number) => bytes < 1024 ? `${bytes} B` : bytes < 1024 ** 2 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / 1024 ** 2).toFixed(1)} MB`;

function ArtifactDownload({ context, artifact }: { context: Context; artifact: PipelineArtifact }) {
  const [state, setState] = useState<'' | 'busy' | 'failed'>('');
  async function download() {
    setState('busy');
    try {
      const response = await fetch('/native/pipelines', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json', 'Connect-Protocol-Version': '1' }, body: JSON.stringify({ ...context, action: 'downloadArtifact', artifactId: artifact.id }) });
      if (!response.ok) throw Error('download');
      const url = URL.createObjectURL(await response.blob()), link = document.createElement('a');
      link.href = url; link.download = artifact.name + (artifact.kind === 'actions-v4' ? '.zip' : ''); link.click();
      setTimeout(() => URL.revokeObjectURL(url), 10_000); setState('');
    } catch { setState('failed'); }
  }
  return <button className="button secondary" disabled={state === 'busy'} aria-label={`Download ${artifact.name}`} onClick={() => void download()}><Download size={15} />{state === 'failed' ? 'Retry download' : 'Download'}</button>;
}

function ApprovalPanel({ context, job }: { context: Context; job: PipelineJob }) {
  const client = useQueryClient();
  const [error, setError] = useState<unknown>();
  const form = useForm({ defaultValues: { comment: '', approve: true }, onSubmit: async ({ value }) => {
    setError(undefined);
    try { await api('/native/pipelines', { ...context, action: 'approve', jobId: job.id, approve: value.approve, comment: value.comment }); await client.invalidateQueries({ queryKey: ['native-pipelines'] }); }
    catch (e) { setError(e); }
  } });
  return <section className="browser-panel pipeline-approval" aria-label={`Review deployment for ${job.name}`}><div className="browser-panel-heading"><h3><ShieldCheck size={16} aria-hidden="true" /> {job.name} is waiting for review</h3></div>
    <form className="credential-form-content" onSubmit={event => { event.preventDefault(); void form.handleSubmit(); }}>
      <p className="field-help">This job deploys to a protected environment. A required reviewer approves or rejects it; its environment secrets are released only after approval.</p>
      <form.Field name="comment">{field => <label>Comment<textarea rows={2} maxLength={1000} value={field.state.value} onChange={e => field.handleChange(e.target.value)} /></label>}</form.Field>
      {error ? <p className="error" role="alert">{message(error)}</p> : null}
      <form.Subscribe selector={state => state.isSubmitting}>{submitting => <div className="credential-actions"><button className="button primary" disabled={submitting} onClick={() => form.setFieldValue('approve', true)}>Approve and deploy</button><button className="button secondary" disabled={submitting} onClick={() => form.setFieldValue('approve', false)}>Reject</button></div>}</form.Subscribe>
    </form></section>;
}

const ansi = /\x1b\[[0-9;?]*[A-Za-z]/g;
function JobLog({ context, job, run, canWrite, act, busy }: { context: Context; job: PipelineJob; run: PipelineRun; canWrite: boolean; act: (body: object) => Promise<void>; busy: boolean }) {
  const visible = usePageVisible();
  const [lines, setLines] = useState<string[]>([]), [next, setNext] = useState(0), [complete, setComplete] = useState(false), [error, setError] = useState<unknown>();
  const source = job.reusedFrom || job.id;
  const fetching = useRef(false);
  useEffect(() => {
    let stopped = false, timer = 0;
    const load = async () => {
      if (fetching.current || stopped) return;
      fetching.current = true;
      try {
        const value = await api<{ text: string; nextLine: number; complete: boolean; state: string }>('/native/pipelines', { ...context, action: 'jobLog', jobId: source, fromLine: next });
        if (stopped) return;
        if (value.text) { setLines(current => [...current, ...value.text.replace(/\n$/, '').split('\n').map(line => line.replace(ansi, ''))]); setNext(value.nextLine); }
        setComplete(value.complete || !active(value.state) && value.nextLine >= job.logLines); setError(undefined);
      } catch (e) { if (!stopped) setError(e); }
      finally { fetching.current = false; }
    };
    void load();
    if (!complete && visible) timer = window.setInterval(() => void load(), 1500);
    return () => { stopped = true; window.clearInterval(timer); };
  }, [source, next, complete, visible]); // eslint-disable-line react-hooks/exhaustive-deps
  const steps = job.steps.length ? job.steps : [];
  const preamble = steps.length ? lines.slice(0, steps[0]!.logIndex) : lines;
  return <section className="browser-panel pipeline-job" aria-labelledby={`job-${job.id}-title`}>
    <div className="browser-panel-heading"><div><h3 id={`job-${job.id}-title`}><StateIcon state={job.state} /> {job.name}</h3>
      <p className="field-help">{job.state === 'QUEUED' ? job.waitingForLabels ? `Waiting for a runner with labels ${job.runsOn.join(', ')}. No online runner in this repository's scope has them.` : `Queued for ${job.runsOn.join(', ')}.` : job.startedAt ? <>Ran {duration(job.startedAt, job.finishedAt)}{job.runner ? ` on ${job.runner}` : ''}</> : stateLabels[job.state]}{job.failureReason && !job.reusedFrom ? ` · ${failureText(job.failureReason)}` : ''}{job.reusedFrom ? ' · reused from the previous attempt' : ''}</p></div>
      <div className="row-actions">{canWrite && job.state === 'MANUAL' ? <button className="button secondary" disabled={busy} onClick={() => void act({ action: 'play', jobId: job.id })}><Play size={15} />Run job</button> : null}{active(job.state) ? <span className="live-status live-status-live" role="status">Live</span> : null}</div></div>
    {error ? <p className="error" role="alert">{message(error)}</p> : null}
    {job.state === 'APPROVAL' ? <ApprovalPanel context={context} job={job} /> : null}
    <div className="pipeline-log" role="log" aria-live="polite" aria-label={`${job.name} log`}>
      {preamble.length ? <details className="pipeline-step"><summary><ChevronRight size={14} className="pipeline-step-chevron" aria-hidden="true" /><CheckCircle2 size={14} aria-hidden="true" /><span>Set up job</span></summary><LogLines lines={preamble} first={1} /></details> : null}
      {steps.map(step => { const slice = lines.slice(step.logIndex, step.logIndex + step.logLength); return <details key={step.number} className="pipeline-step" open={step.state === 'FAILURE' || step.state === 'RUNNING'}>
        <summary><ChevronRight size={14} className="pipeline-step-chevron" aria-hidden="true" /><StateIcon state={step.state} size={14} /><span>{step.name}</span><span className="pipeline-step-time">{duration(step.startedAt, step.finishedAt)}</span></summary>
        {slice.length ? <LogLines lines={slice} first={step.logIndex + 1} /> : <p className="pipeline-log-empty">{step.state === 'PENDING' || step.state === 'SKIPPED' ? 'This step did not run.' : 'No output yet.'}</p>}</details>; })}
      {steps.length && lines.length > (steps.at(-1)!.logIndex + steps.at(-1)!.logLength) && complete ? <details className="pipeline-step"><summary><ChevronRight size={14} className="pipeline-step-chevron" aria-hidden="true" /><CheckCircle2 size={14} aria-hidden="true" /><span>Complete job</span></summary><LogLines lines={lines.slice(steps.at(-1)!.logIndex + steps.at(-1)!.logLength)} first={steps.at(-1)!.logIndex + steps.at(-1)!.logLength + 1} /></details> : null}
      {!lines.length && !active(job.state) ? <p className="pipeline-log-empty">This job produced no log.</p> : null}
    </div>
    <p className="panel-footnote">Logs are stored with exact repository secret values replaced by ***.{run.engine === 'gitlab-ci' ? ' GitLab sections are shown as one log.' : ''}</p>
  </section>;
}
function LogLines({ lines, first }: { lines: string[]; first: number }) {
  // Workflow commands (::group::, ##[group], [command]) render as headings and dim lines rather than raw markers.
  const render = (raw: string) => {
    const line = raw.replace(/^\d{4}-\d\d-\d\dT[\d:.]+Z /, ''), group = /^(?:::group::|##\[group\])(.*)$/.exec(line);
    if (group) return <code className="pipeline-log-group">{group[1]}</code>;
    if (/^(?:::endgroup::|##\[endgroup\])$/.test(line)) return <code className="pipeline-log-command" />;
    return <code className={/^\[command\]|^::[a-z-]+(?: [^:]*)?::/.test(line) ? 'pipeline-log-command' : undefined}>{line.replace(/^\[command\]/, '')}</code>;
  };
  return <ol className="pipeline-log-lines" start={first}>{lines.map((line, index) => <li key={index}><span className="pipeline-log-number" aria-hidden="true">{first + index}</span>{render(line)}</li>)}</ol>;
}
const failureText = (reason: string) => ({ timeout: 'Timed out', runner_lost: 'The runner stopped reporting', no_runner: 'No runner picked it up within 24 hours', environment_branch: 'This ref may not deploy to the environment', environment_rejected: 'Deployment rejected by a reviewer', actions_disabled: 'Actions were turned off', job_failed: 'Failed' } as Record<string, string>)[reason] || reason;

type Environment = { id: string; name: string; url: string; branches: string[]; preventSelfReview: boolean; reviewers: { id: string; login: string }[]; version: number; updatedAt: string;
  deployments: { id: string; runId: string; jobId: string; action: string; commitId: string; ref: string; url: string; state: string; actor: string; createdAt: string }[] };
function DeploymentEnvironments({ context, userId }: { context: Context; userId: string }) {
  const key = ['native-pipelines', userId, context.repositoryId, 'environments'];
  const environments = useQuery({ ...privateQuery, queryKey: key, queryFn: ({ signal }) => api<{ canEdit: boolean; environments: Environment[] }>('/native/pipelines', { ...context, action: 'environments' }, signal) });
  const [editing, setEditing] = useState<Environment | 'new'>(), [secretFor, setSecretFor] = useState<Environment>();
  const deployments = (environments.data?.environments || []).flatMap(environment => environment.deployments.map(d => ({ ...d, environment: environment.name })));
  return <div className="page-stack">
    <PageHeader title="Environments" description="Deployment targets for jobs that name an environment. Required reviewers hold a deployment until one of them approves; environment secrets reach the job only after approval."
      actions={environments.data?.canEdit ? <button className="button primary" onClick={() => { setSecretFor(undefined); setEditing('new'); }}><Plus size={15} />New environment</button> : undefined} />
    {environments.isError ? <p className="error" role="alert">{message(environments.error)}</p> : null}
    <section className="browser-panel"><div className="browser-panel-heading"><h3>Environments</h3></div>
      {environments.data ? <DataTable data={environments.data.environments} getRowId={e => e.id} label="environments" emptyMessage="No environments yet. A job with environment: creates an unprotected one the first time it runs." columns={[
        { accessorKey: 'name', header: 'Name', cell: ({ row }) => <strong>{row.original.name}</strong> },
        { id: 'protection', header: 'Protection', accessorFn: e => e.reviewers.length ? `Reviewers: ${e.reviewers.map(r => r.login).join(', ')}` : 'No reviewers', cell: ({ row }) => row.original.reviewers.length ? <span>Required reviewers: {row.original.reviewers.map(r => r.login).join(', ')}{row.original.preventSelfReview ? ' · no self-review' : ''}</span> : <span className="field-help">Unprotected</span> },
        { id: 'branches', header: 'Branches', accessorFn: e => e.branches.join(' ') || 'Any', cell: ({ row }) => row.original.branches.length ? <span className="pipeline-labels">{row.original.branches.map(b => <span key={b}>{b}</span>)}</span> : 'Any branch' },
        { id: 'last', header: 'Latest deployment', accessorFn: e => e.deployments[0]?.createdAt || '', cell: ({ row }) => row.original.deployments[0] ? <span className="pipeline-when"><span><StateIcon state={row.original.deployments[0].state} /> <DateLabel value={row.original.deployments[0].createdAt} relative /></span></span> : 'Never' },
        ...(environments.data.canEdit ? [{ id: 'edit', header: 'Actions', enableSorting: false, cell: ({ row }: { row: { original: Environment } }) => <div className="row-actions"><button className="button secondary" aria-label={`Edit ${row.original.name}`} onClick={() => { setSecretFor(undefined); setEditing(row.original); }}>Edit</button><button className="button secondary" aria-label={`Add a secret to ${row.original.name}`} onClick={() => { setEditing(undefined); setSecretFor(row.original); }}>Add secret</button></div> } as DataTableColumn<Environment>] : []),
      ]} /> : <Loading label="Reading environments…" />}</section>
    {editing ? <EnvironmentForm key={editing === 'new' ? 'new' : editing.id} context={context} environment={editing === 'new' ? undefined : editing} close={() => setEditing(undefined)} saved={() => { setEditing(undefined); void environments.refetch(); }} /> : null}
    {secretFor ? <EnvironmentValueForm key={secretFor.id} context={context} environment={secretFor} close={() => setSecretFor(undefined)} /> : null}
    <section className="browser-panel"><div className="browser-panel-heading"><h3>Deployment history</h3></div>
      <DataTable data={deployments} getRowId={d => d.id} label="deployments" emptyMessage="No deployments yet." columns={[
        { accessorKey: 'environment', header: 'Environment' },
        { accessorKey: 'state', header: 'Result', cell: ({ row }) => <span className="run-state"><StateIcon state={row.original.state} />{stateLabels[row.original.state] || row.original.state}</span> },
        { id: 'run', header: 'Run', accessorFn: d => d.runId, cell: ({ row }) => <Link {...repositoryOptions({ ...context.repository, view: 'actions', run: row.original.runId })}>#{row.original.runId}</Link> },
        { id: 'commit', header: 'Commit', accessorFn: d => d.commitId, cell: ({ row }) => <code>{row.original.commitId.slice(0, 7)}</code> },
        { accessorKey: 'actor', header: 'By' },
        { id: 'url', header: 'URL', accessorFn: d => d.url, cell: ({ row }) => row.original.url ? <a href={row.original.url} target="_blank" rel="noopener noreferrer">{row.original.url}</a> : '—' },
        { id: 'when', header: 'When', accessorFn: d => d.createdAt, cell: ({ row }) => <DateLabel value={row.original.createdAt} relative /> },
      ]} /></section>
  </div>;
}
function EnvironmentForm({ context, environment, close, saved }: { context: Context; environment?: Environment; close: () => void; saved: () => void }) {
  const [error, setError] = useState<unknown>();
  const form = useForm({ defaultValues: { name: environment?.name || '', reviewers: environment?.reviewers.map(r => r.login).join(', ') || '', branches: environment?.branches.join(', ') || '', url: environment?.url || '', preventSelfReview: environment?.preventSelfReview ?? true },
    onSubmit: async ({ value }) => {
      setError(undefined);
      try {
        await api('/native/pipelines', { ...context, action: 'saveEnvironment', name: value.name.trim(), reviewers: value.reviewers.split(/[\s,]+/).filter(Boolean), branches: value.branches.split(/[\s,]+/).filter(Boolean), url: value.url.trim(), preventSelfReview: value.preventSelfReview, ...(environment ? { expectedVersion: environment.version } : {}) });
        saved();
      } catch (e) { setError(e); }
    } });
  return <form className="browser-panel credential-form-content" aria-label={environment ? `Edit ${environment.name}` : 'New environment'} onSubmit={event => { event.preventDefault(); void form.handleSubmit(); }}>
    <h3>{environment ? `Edit ${environment.name}` : 'New environment'}</h3>
    <form.Field name="name">{field => <label>Name<input required maxLength={255} readOnly={Boolean(environment)} value={field.state.value} onChange={e => field.handleChange(e.target.value)} /></label>}</form.Field>
    <form.Field name="reviewers">{field => <label>Required reviewers<input value={field.state.value} onChange={e => field.handleChange(e.target.value)} placeholder="login, login" /></label>}</form.Field>
    <p className="field-help">Up to six accounts with access to this repository. Any one of them can approve. Leave empty for no approval.</p>
    <form.Field name="preventSelfReview">{field => <label className="checkbox-label"><input type="checkbox" checked={field.state.value} onChange={e => field.handleChange(e.target.checked)} />Prevent the person who started the run from approving it</label>}</form.Field>
    <form.Field name="branches">{field => <label>Deployment branches<input value={field.state.value} onChange={e => field.handleChange(e.target.value)} placeholder="main, release/*" /></label>}</form.Field>
    <form.Field name="url">{field => <label>Environment URL<input type="url" value={field.state.value} onChange={e => field.handleChange(e.target.value)} placeholder="https://" /></label>}</form.Field>
    {error ? <p className="error" role="alert">{message(error)}</p> : null}
    <form.Subscribe selector={state => state.isSubmitting}>{submitting => <div className="credential-actions"><button className="button primary" disabled={submitting}>Save environment</button><button type="button" className="button secondary" onClick={close}>Cancel</button></div>}</form.Subscribe>
  </form>;
}
function EnvironmentValueForm({ context, environment, close }: { context: Context; environment: Environment; close: () => void }) {
  const [error, setError] = useState<unknown>(), [done, setDone] = useState('');
  const form = useForm({ defaultValues: { name: '', kind: 'secret', value: '' }, onSubmit: async ({ value, formApi }) => {
    setError(undefined); setDone('');
    try { await api('/native/pipelines', { ...context, action: 'saveEnvironmentValue', environmentId: environment.id, name: value.name, kind: value.kind, value: value.value }); setDone(value.name); formApi.reset(); }
    catch (e) { setError(e); }
  } });
  return <form className="browser-panel credential-form-content" aria-label={`Add a value to ${environment.name}`} onSubmit={event => { event.preventDefault(); void form.handleSubmit(); }}>
    <h3>Add a secret or variable to {environment.name}</h3><p className="field-help">Saving a name again replaces its value. Secret values are never shown again.</p>
    <form.Field name="kind">{field => <label>Kind<select value={field.state.value} onChange={e => field.handleChange(e.target.value)}><option value="secret">Secret</option><option value="variable">Variable</option></select></label>}</form.Field>
    <form.Field name="name">{field => <label>Name<input required pattern="[A-Z][A-Z0-9_]*" maxLength={64} value={field.state.value} onChange={e => field.handleChange(e.target.value.toUpperCase())} /></label>}</form.Field>
    <form.Field name="value">{field => <label>Value<textarea required rows={3} value={field.state.value} onChange={e => field.handleChange(e.target.value)} /></label>}</form.Field>
    {error ? <p className="error" role="alert">{message(error)}</p> : null}{done ? <p className="field-help" role="status">{done} saved.</p> : null}
    <form.Subscribe selector={state => state.isSubmitting}>{submitting => <div className="credential-actions"><button className="button primary" disabled={submitting}>Save value</button><button type="button" className="button secondary" onClick={close}>Close</button></div>}</form.Subscribe>
  </form>;
}
