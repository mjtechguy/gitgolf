import { useLiveStatus } from './RepositoryLive';
import { currentPullPreviews } from './nativePreviews';
import { usePageVisible } from './RepositoryUI';
import { nativeAPI as api } from './nativeAPI';
import { CopyButton, PageHeader, privateQuery } from './RepositoryUI';
import { RefreshCw } from 'lucide-react';
import { Link } from '@tanstack/react-router';
import { repositoryOptions } from './navigation';
import { useEffect, useRef, useState } from 'react';
import { useForm } from '@tanstack/react-form';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { DataTable } from './DataTable';
import type { DataTableColumn } from './DataTable';
import { type RuntimeManifest } from './runtimeCapabilities';
import { NativeRunnerPlacement } from './NativeRunners';

export type Config = { runtimeProfile: string; workspace: string; canCreate: boolean; accessLogin: boolean; evidence: boolean; tests: boolean; agents: boolean; advice: boolean; previews: boolean; apps: boolean; automaticCI: boolean; appPath: string; browser: boolean; agentPath: string; previewPath: string; testModule: string; testWorkflowFormat: string; testWorkflowPath: string; dailyLimit: number; previewTTL: number; appTTL: number };
type Repository = { id: string; name: string; fullName: string; cloneUrl: string; description: string };
export type Pull = { id: string; number: number; title: string; body: string; state: string; merged: boolean; draft: boolean; revision: string; head: { commitId: string; ref: string }; base: { commitId: string; ref: string } };
export type Job = { id: string; idempotencyKey: string; state: string; agentState: string; testState: string; adviceState: string; stale: boolean; createdAt: string; updatedAt: string; selection: { repositoryId: string; pullRequestId: string; number: number; baseCommitId: string; headCommitId: string } };
export type Preview = { kind: 'STATIC' | 'WORKER' | 'IMAGE_STATIC'; imageDigest?: string; id: string; jobId: string; url: string; state: string; expiresAt: string; commitId: string; purged: boolean; captureState: string };
type Report = { execution?: { workflow?: { format: string; path: string; jobId?: string; catalog?: string } }; agentResult: { state: string; patch?: string; proposalCommitId?: string; tests?: { exitCode: number; stdout: string; stderr: string }; calls?: number; tokens?: number }; tests: { state: string; producer?: { kind: string; machineId: string; generation: number }; build?: { digest: string; bytes: number; sourceCommit: string }; image?: { registry: string; repository: string; tag: string; digest: string; commitId: string }; stdout?: string; stderr?: string; exitCode?: number }; advice: { state: string; answers?: { next: { choice: string } } }; limitations: string[] };
export type ReportValue = { job: Job; report: Report };
export function NativePreviewLink({ preview }: { preview: Preview }) {
  const expires = Date.parse(preview.expiresAt), [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!Number.isFinite(expires) || expires <= Date.now()) return;
    const timer = setTimeout(() => setNow(Date.now()), Math.min(expires - Date.now() + 1, 2_147_483_647));
    return () => clearTimeout(timer);
  }, [expires, now]);
  let url: URL | undefined;
  try { const parsed = new URL(preview.url); if (parsed.protocol === 'https:' && !parsed.username && !parsed.password && !parsed.search && !parsed.hash && parsed.pathname.endsWith('/')) url = parsed; } catch { /* Invalid receipts never become links. */ }
  if (preview.state !== 'READY' || !Number.isFinite(expires) || expires <= Date.now() || preview.purged || !url) return <span className="field-help">{preview.purged || expires <= Date.now() ? 'Preview expired' : preview.state === 'READY' ? 'Preview URL unavailable' : `Preview ${preview.state.toLowerCase()}`}</span>;
  const entry = new URL('__golf/enter', url).href;
  return <div className="credential-form-content"><div className="credential-actions"><a className="button secondary" href={entry} target="_blank" rel="noopener noreferrer">Open protected preview</a><CopyButton text={entry} label="Copy protected preview URL" /></div><a className="text-button" href={entry} target="_blank" rel="noopener noreferrer">{url.host}{url.pathname}</a><p className="field-help">{preview.kind === 'WORKER' ? 'Application' : preview.kind === 'IMAGE_STATIC' ? 'Scanned image static site' : 'Static site'} · expires <time dateTime={preview.expiresAt}>{new Date(expires).toLocaleString()}</time>{preview.imageDigest ? <> · image <code>{preview.imageDigest.slice(0, 23)}…</code></> : null}</p></div>;
}
export { api as nativeAPI };
const repositoryAPI = <T,>(method: string, body: object = {}, signal?: AbortSignal) => api<T>('/rpc/golf.v1.RepositoryService/' + method, body, signal);
const message = (error: unknown) => error instanceof Error ? error.message : 'Request could not be confirmed.';
function ErrorMessage({ error }: { error: unknown }) { return error ? <p className="error" role="alert">{message(error)}</p> : null; }

export function NativeSettings({ config }: { config: Config }) {
  const capabilities = useQuery({ ...privateQuery, queryKey: ['native-capabilities'], queryFn: ({ signal }) => api<RuntimeManifest>('/rpc/golf.v1.CapabilityService/ListCapabilities', {}, signal), refetchInterval: 30000 });
  const columns: DataTableColumn<RuntimeManifest['capabilities'][number]>[] = [
    { accessorKey: 'id', header: 'Capability' },
    { id: 'availability', header: 'Availability', accessorFn: c => c.state === 'CAPABILITY_STATE_READY' ? 'Available by policy' : c.state === 'CAPABILITY_STATE_DEGRADED' ? 'Degraded' : 'Unavailable' },
    { accessorKey: 'reason', header: 'Current scope' },
  ];
  const settings = [
    { name: 'Canonical Git', value: 'Private Cloudflare Artifacts repositories' },
    { name: 'Sign-in', value: config.accessLogin ? 'Cloudflare Access with active Golf user and repository grants' : 'Scoped Golf bearer credentials; browser Access login is unallocated' },
    { name: 'Approved execution', value: config.tests ? config.testWorkflowFormat ? `${config.testWorkflowFormat.startsWith('actions') ? 'Actions' : 'GitLab'} · ${config.testWorkflowPath}${config.testModule ? ` for pull requests · ${config.testModule} for agent proposals` : ''}` : config.testModule : 'Unallocated' },
    { name: 'Automatic PR push CI', value: config.automaticCI ? 'Enabled within approved test policy' : 'Disabled' },
    { name: 'Daily evidence admissions', value: String(config.dailyLimit) },
    { name: 'Agent edit path', value: config.agents ? config.agentPath : 'Unallocated' },
    { name: 'Static previews', value: config.previews ? `${config.previewPath} · ${config.previewTTL} seconds` : 'Unallocated' },
    { name: 'Worker applications', value: config.apps ? `${config.appPath} · private D1/R2 · ${config.appTTL} seconds` : 'Unallocated' },
    { name: 'Browser snapshots', value: config.browser ? 'One private static capture per preview' : 'Unallocated' },
  ];
  return <section className="page-stack"><h2>Cloudflare settings and capabilities</h2><p>Operators approve allocations through the native setup. Your current repository permissions govern every action. Portable database, Docker runner, password and SMTP editors belong to the portable installation.</p><section className="browser-panel"><div className="browser-panel-heading"><h3>Current allocation</h3></div><DataTable data={settings} columns={[{ accessorKey: 'name', header: 'Setting' }, { accessorKey: 'value', header: 'Current value' }]} getRowId={s => s.name} label="native settings" /></section><section className="browser-panel"><div className="browser-panel-heading"><h3>Installation capabilities</h3><button className="button secondary" disabled={capabilities.isFetching} onClick={() => void capabilities.refetch()}>Refresh capabilities</button></div><ErrorMessage error={capabilities.error} />{capabilities.isSuccess && !capabilities.isError && <DataTable data={capabilities.data.capabilities} columns={columns} getRowId={c => c.id} label="native capabilities" />}<p className="field-help">Configured policy, provider availability and successful execution are separate. Missing allocations do not enable fallback runners or provider actions.</p></section></section>;
}

type Context = { repository: { owner: string; name: string }; repositoryId: string };
export function NativePullPreviewSummary({ context, number, userId, commitId }: { context: Context; number: number; userId: string; commitId: string }) {
  const live = useLiveStatus() === 'live', visible = usePageVisible();
  const config = useQuery({ ...privateQuery, queryKey: ['native-config', userId], queryFn: ({ signal }) => api<Config>('/native/config', {}, signal) });
  const enabled = config.data?.previews === true;
  const jobs = useQuery({ ...privateQuery, queryKey: ['native-repository', context.repositoryId, number, 'jobs'], enabled, queryFn: ({ signal }) => api<{ jobs: Job[]; truncated: boolean }>('/native/pr-evidence/read', { ...context, action: 'list', number }, signal), refetchInterval: visible && !live ? 5000 : false });
  const previews = useQuery({ ...privateQuery, queryKey: ['native-repository', context.repositoryId, number, 'previews'], enabled, queryFn: ({ signal }) => api<{ previews: Preview[]; truncated: boolean }>('/native/pr-preview/read', { ...context, action: 'list' }, signal), refetchInterval: visible && !live ? 5000 : false });
  if (config.isSuccess && !enabled) return null;
  const error = config.error || jobs.error || previews.error;
  const ready = !error && jobs.isSuccess && previews.isSuccess ? currentPullPreviews(previews.data.previews, jobs.data.jobs, commitId) : [];
  return <section className="browser-panel" aria-label="Preview deployments"><div className="browser-panel-heading"><h3>Preview deployments</h3><code>{commitId.slice(0, 8)}</code></div><ErrorMessage error={error}/><div aria-live="polite">{ready.length ? ready.map(preview => <NativePreviewLink key={preview.id} preview={preview}/>) : !error ? <p className="panel-footnote">{!jobs.isSuccess || !previews.isSuccess ? 'Checking preview deployments…' : 'No active preview for this commit. Links appear here when deployment completes.'}</p> : null}</div></section>;
}
export function NativePullTools({ context, number, userId, selectedCommitId }: { context: Context; number: number; userId: string; selectedCommitId?: string }) {
  const live = useLiveStatus() === 'live', visible = usePageVisible();
  const config = useQuery({ ...privateQuery, queryKey: ['native-config', userId], queryFn: ({ signal }) => api<Config>('/native/config', {}, signal), refetchInterval: 30000 });
  const access = useQuery({ ...privateQuery, queryKey: ['native-repository', context.repositoryId, 'access'], queryFn: ({ signal }) => api<{ role: string }>('/native/repository-access', context, signal), refetchInterval: visible && !live ? 15000 : false });
  if (config.isError || access.isError) return <ErrorMessage error={config.error || access.error} />;
  if (!config.isSuccess || !access.isSuccess) return <p role="status">Checking Cloudflare allocations and current repository access…</p>;
  return <NativePullControls key={`${userId}-${context.repositoryId}-${number}`} context={context} repository={{ id: context.repositoryId, name: context.repository.name, fullName: '', cloneUrl: '', description: '' }} config={config.data} number={number} selectedCommitId={selectedCommitId} writable={['write', 'admin'].includes(access.data.role)} />;
}
export function NativeRepositoryActions({ context, userId }: { context: Context; userId: string }) {
  const pulls = useQuery({ ...privateQuery, queryKey: ['native-repository', context.repositoryId, 'pulls'], queryFn: ({ signal }) => repositoryAPI<{ pullRequests: Pull[]; page: { nextPage: number } }>('ListPullRequests', { ...context, state: 'ISSUE_STATE_ALL', page: { limit: 100 } }, signal) });
  const [number, setNumber] = useState<number>();
  const [runnersOpen, setRunnersOpen] = useState(false);
  const columns: DataTableColumn<Pull>[] = [
    { accessorKey: 'number', header: 'PR', cell: ({ row }) => <Link {...repositoryOptions({ ...context.repository, view: 'pulls', pull: row.original.number, pullView: 'checks' })}>#{row.original.number}</Link> },
    { accessorKey: 'title', header: 'Title' },
    { id: 'runs', header: 'Runs and previews', enableSorting: false, cell: ({ row }) => <button className="button secondary" onClick={() => setNumber(row.original.number)}>Inspect runs</button> },
  ];
  return <div className="page-stack repository-work-page"><PageHeader title="Actions" description="CI runs, test reports and previews for your pull requests." actions={<button className="button secondary" onClick={() => void pulls.refetch()}><RefreshCw size={15}/>Refresh</button>}/><section className="browser-panel"><div className="browser-panel-heading"><h3>Pull requests</h3></div><ErrorMessage error={pulls.error} />{pulls.isSuccess ? <DataTable data={pulls.data.pullRequests} columns={columns} getRowId={p => p.id} label="pull request execution" /> : <p role="status">Reading pull requests…</p>}{pulls.data?.page.nextPage ? <p className="panel-footnote">Only the first 100 pull requests are loaded.</p> : null}</section>{number ? <NativePullTools key={number} context={context} userId={userId} number={number} /> : null}<details className="metadata-details panel-disclosure" onToggle={event => setRunnersOpen(event.currentTarget.open)}><summary>Runner settings</summary>{runnersOpen ? <NativeRunnerPlacement context={context}/> : null}</details></div>;
}
function NativePullControls({ context, repository, config, number, writable, selectedCommitId }: { context: Context; repository: Repository; config: Config; number: number; writable: boolean; selectedCommitId?: string }) {
  const live = useLiveStatus() === 'live', visible = usePageVisible();
  const client = useQueryClient();
  const [busy, setBusy] = useState(false), [error, setError] = useState<unknown>(), [intent, setIntent] = useState<string[]>([]), [agentsOpen, setAgentsOpen] = useState(false);
  const [selected, setSelected] = useState<string[]>([]), [reports, setReports] = useState<ReportValue[]>([]), [resolution, setResolution] = useState('');
  const [snapshot, setSnapshot] = useState<string>();
  useEffect(() => () => { if (snapshot) URL.revokeObjectURL(snapshot); }, [snapshot]);
  const pull = useQuery({ ...privateQuery, queryKey: ['native-repository', repository.id, number, 'pull'], queryFn: ({ signal }) => repositoryAPI<{ pullRequest: Pull }>('GetPullRequest', { ...context, number }, signal), refetchInterval: visible && !live ? 15000 : false });
  const jobs = useQuery({ ...privateQuery, queryKey: ['native-repository', repository.id, number, 'jobs'], enabled: config.evidence, queryFn: ({ signal }) => api<{ jobs: Job[]; truncated: boolean }>('/native/pr-evidence/read', { ...context, action: 'list', number }, signal), refetchInterval: visible && !live ? 5000 : false });
  const previews = useQuery({ ...privateQuery, queryKey: ['native-repository', repository.id, number, 'previews'], enabled: config.previews, queryFn: ({ signal }) => api<{ previews: Preview[]; truncated: boolean }>('/native/pr-preview/read', { ...context, action: 'list' }, signal), refetchInterval: visible && !live ? 5000 : false });
  useEffect(() => { if (pull.isError || jobs.isError || previews.isError) { setReports([]); setSelected([]); setSnapshot(undefined); } }, [pull.isError, jobs.isError, previews.isError]);
  useEffect(() => { setReports([]); setResolution(''); setSelected([]); setSnapshot(undefined); }, [pull.data?.pullRequest.revision]);
  useEffect(() => { if (jobs.data && reports.some(r => jobs.data.jobs.find(j => j.id === r.job.id)?.stale || !jobs.data.jobs.some(j => j.id === r.job.id))) setReports([]); }, [jobs.data, reports]);
  async function refresh() { await client.invalidateQueries({ queryKey: ['native-repository', repository.id] }); }
  async function perform(action: () => Promise<void>) { setBusy(true); setError(undefined); try { await action(); } catch (e) { setError(e); setReports([]); } finally { setBusy(false); await refresh(); } }
  const pr = pull.data?.pullRequest;
  const selection = pr && { ...context, number, pullRequestId: pr.id, baseCommitId: pr.base.commitId, headCommitId: pr.head.commitId };
  const active = pr?.state === 'ISSUE_STATE_OPEN';
  async function createJobs(prompts?: string[]) {
    if (!selection || intent.length) return;
    const keys = (prompts || ['']).map(() => crypto.randomUUID()); setIntent(keys);
    await perform(async () => {
      const results = await Promise.allSettled(keys.map((idempotencyKey, i) => api<{ job: Job }>('/native/pr-evidence', {
        action: 'create', selection, idempotencyKey, advice: config.advice, ...(prompts ? { agent: { prompt: prompts[i] } } : { runTests: true }),
      })));
      if (results.some(r => r.status === 'rejected')) throw new Error('At least one admission could not be confirmed. Inspect the original keys in the refreshed inventory.');
      setIntent([]); setAgentsOpen(false);
    });
  }
  const jobColumns: DataTableColumn<Job>[] = [
    { id: 'select', header: 'Compare', enableSorting: false, cell: ({ row }) => <input type="checkbox" aria-label={`Select proposal ${row.original.id}`} disabled={row.original.state !== 'SUCCEEDED' || row.original.stale || row.original.agentState !== 'succeeded' || !selected.includes(row.original.id) && selected.length >= 2} checked={selected.includes(row.original.id)} onChange={e => setSelected(e.target.checked ? [...selected, row.original.id] : selected.filter(id => id !== row.original.id))} /> },
    { accessorKey: 'id', header: 'Run', cell: ({ row }) => <code>{row.original.id}</code> }, { accessorKey: 'state', header: 'Report' }, { accessorKey: 'agentState', header: 'Agent' }, { accessorKey: 'testState', header: 'Execution' },
    { id: 'source', header: 'Source', accessorFn: j => j.stale ? 'Stale' : 'Current' },
    { id: 'deployment', header: 'Deployment', enableSorting: false, cell: ({ row }) => previews.isError ? <span>Preview status unavailable</span> : config.previews && !previews.isSuccess ? <span>Reading preview status…</span> : previews.data?.previews.some(p => p.jobId === row.original.id && p.commitId === row.original.selection.headCommitId) ? <>{previews.data.previews.filter(p => p.jobId === row.original.id && p.commitId === row.original.selection.headCommitId).map(p => <NativePreviewLink key={p.id} preview={p} />)}</> : <span className="field-help">No preview deployed</span> },
    { id: 'actions', header: 'Actions', enableSorting: false, cell: ({ row }) => <div className="credential-actions"><button className="button secondary" disabled={busy || row.original.state !== 'SUCCEEDED'} onClick={() => void perform(async () => { const value = await api<ReportValue>('/native/pr-evidence/read', { ...context, action: 'report', jobId: row.original.id }); setReports([value]); setResolution(''); })}>Read report</button>{writable && row.original.state === 'QUEUED' && <button className="button secondary" disabled={busy} onClick={() => void perform(async () => { await api('/native/pr-evidence', { ...context, action: 'cancel', jobId: row.original.id }); })}>Cancel run</button>}{writable && config.previews && row.original.testState === 'PASSED' && !row.original.stale && <button className="button secondary" disabled={busy || intent.length > 0} onClick={() => void perform(async () => { const id = crypto.randomUUID(); setIntent([id]); await api('/native/pr-preview', { ...context, action: 'create', jobId: row.original.id, idempotencyKey: id }); setIntent([]); })}>Publish static preview</button>}{writable && config.apps && row.original.testState === 'PASSED' && !row.original.stale && <button className="button secondary" disabled={busy || intent.length > 0} onClick={() => void perform(async () => { const id = crypto.randomUUID(); setIntent([id]); await api('/native/pr-preview', { ...context, action: 'create', kind: 'WORKER', jobId: row.original.id, idempotencyKey: id }); setIntent([]); })}>Deploy Worker application</button>}</div> },
  ];
  const previewColumns: DataTableColumn<Preview>[] = [
    { accessorKey: 'kind', header: 'Hosting' },
    { accessorKey: 'id', header: 'Preview', cell: ({ row }) => <NativePreviewLink preview={row.original} /> }, { accessorKey: 'state', header: 'State' }, { accessorKey: 'commitId', header: 'Commit' }, { accessorKey: 'expiresAt', header: 'Expires' }, { accessorKey: 'captureState', header: 'Visual snapshot' },
    { id: 'actions', header: 'Actions', enableSorting: false, cell: ({ row }) => <div className="credential-actions">{row.original.state === 'READY' && Date.parse(row.original.expiresAt) > Date.now() && <>{config.browser && row.original.kind !== 'WORKER' && writable && row.original.captureState === 'NONE' && <button className="button secondary" disabled={busy} onClick={() => void perform(async () => { await api('/native/pr-preview', { ...context, action: 'capture', previewId: row.original.id }); })}>Capture visual snapshot</button>}{row.original.captureState === 'READY' && <button className="button secondary" disabled={busy} onClick={() => void perform(async () => {
      const response = await fetch('/native/pr-preview', { method: 'POST', credentials: 'same-origin', redirect: 'error', headers: { 'Content-Type': 'application/json', 'Connect-Protocol-Version': '1' }, body: JSON.stringify({ ...context, action: 'screenshot', previewId: row.original.id }) });
      if (!response.ok || response.headers.get('Content-Type') !== 'image/png') throw new Error('The private snapshot or current access is unavailable.');
      const blob = await response.blob(); if (blob.size > 1024 * 1024) throw new Error('Snapshot exceeds its limit.');
      setSnapshot(URL.createObjectURL(blob));
    })}>View visual snapshot</button>}</>}{writable && !row.original.purged && <button className="button secondary" disabled={busy} onClick={() => void perform(async () => { setSnapshot(undefined); await api('/native/pr-preview', { ...context, action: 'revoke', previewId: row.original.id }); })}>Revoke and remove</button>}</div> },
  ];
  if (pull.isError || jobs.isError || previews.isError) return <><ErrorMessage error={pull.error || jobs.error || previews.error} /><button className="button secondary" onClick={() => void refresh()}>Recheck current access</button></>;
  const currentPreviews = previews.data?.previews.filter(p => p.commitId === (selectedCommitId || pr?.head.commitId) && jobs.data?.jobs.some(j => j.id === p.jobId && j.selection.headCommitId === p.commitId)) || [];
  return <>{currentPreviews.length > 0 && <section className="browser-panel" aria-label="PR deployments"><div className="browser-panel-heading"><h3>PR deployments</h3><span className="field-help">Selected commit {(selectedCommitId || pr?.head.commitId)?.slice(0, 12)}</span></div>{currentPreviews.map(p => <NativePreviewLink key={p.id} preview={p} />)}</section>}{pr && <><div className="credential-actions"><button className="button secondary" disabled={busy} onClick={() => void refresh()}>Refresh PR</button>{writable && active && config.tests && <button className="button primary" disabled={busy || intent.length > 0} onClick={() => void createJobs()}>{config.testWorkflowFormat ? 'Run approved workflow' : 'Run canonical tests'}</button>}{writable && active && config.agents && <button className="button primary" disabled={busy || intent.length > 0} onClick={() => setAgentsOpen(true)}>New concurrent agents</button>}</div></>}
    <ErrorMessage error={error} />{intent.length > 0 && <p className="field-help">Original operation keys: {intent.join(', ')}. Inspect the refreshed inventory before another admission.</p>}
    {agentsOpen && <AgentEditor path={config.agentPath} blocked={busy || intent.length > 0} close={() => setAgentsOpen(false)} submit={prompts => void createJobs(prompts)} />}
    <section className="browser-panel"><div className="browser-panel-heading"><h3>Runs and private evidence</h3><button className="button secondary" disabled={busy || selected.length !== 2} onClick={() => void perform(async () => { const result = await api<{ proposals: ReportValue[]; resolution: string }>('/native/pr-evidence/read', { ...context, action: 'compare', jobIds: selected }); setReports(result.proposals); setResolution(result.resolution); })}>Compare selected proposals</button></div><p className="field-help">{config.automaticCI ? 'Eligible confirmed PR pushes automatically admit approved tests. ' : ''}Agents propose changes in separate Artifacts forks. Tests, reviews and AI advice do not grant merge permission.</p>{jobs.isSuccess && <DataTable data={jobs.data.jobs} columns={jobColumns} getRowId={j => j.id} label="PR runs" />}{jobs.data?.truncated && <p className="field-help">This PR is filtered from the latest 100 repository runs.</p>}{!config.evidence && <p>Evidence resources are not allocated.</p>}</section>
    {resolution && <p className="notice" role="status">{resolution.replaceAll('_', ' ').toLowerCase()}. Integration and merge remain human-controlled.</p>}
    <div className="native-proposals">{reports.map(value => <section key={value.job.id} className="browser-panel"><div className="browser-panel-heading"><h3>Report · {value.job.id}</h3></div><div className="credential-form-content"><p>{value.job.stale ? 'Stale source' : 'Current source'} · Agent: {value.report.agentResult.state} · {value.report.execution?.workflow ? 'Workflow' : 'Canonical tests'}: {value.report.tests.state} · Advice: {value.report.advice.state}</p>{value.report.tests.producer?.kind === 'customer-runner' && <p className="field-help">Customer-hosted runner <code>{value.report.tests.producer.machineId}</code> · attempt {value.report.tests.producer.generation}. Isolation and cleanup are host assertions.</p>}{value.report.execution?.workflow && <p>Approved {value.report.execution.workflow.format.startsWith('actions') ? 'Actions' : 'GitLab'} {value.report.execution.workflow.jobId ? <>job <code>{value.report.execution.workflow.jobId}</code></> : 'workflow'} from <code>{value.report.execution.workflow.path}</code></p>}{value.report.agentResult.proposalCommitId && <p><code>{value.report.agentResult.proposalCommitId}</code></p>}{value.report.agentResult.patch && <pre className="native-evidence-code">{value.report.agentResult.patch}</pre>}{value.report.agentResult.tests && <><h4>Proposal tests · exit {value.report.agentResult.tests.exitCode}</h4><pre className="native-evidence-code">{value.report.agentResult.tests.stdout}{value.report.agentResult.tests.stderr}</pre></>}{value.report.tests.build && <p>Socketless OCI build: <code>{value.report.tests.build.digest}</code> · {value.report.tests.build.bytes.toLocaleString()} bytes. Build output is not retained or published.</p>}{value.report.tests.image && <><h4>Published container image</h4><code>{value.report.tests.image.registry.replace(/^https:\/\//,'')}/{value.report.tests.image.repository}@{value.report.tests.image.digest}</code><p><Link {...repositoryOptions(context.repository, { view: 'packages', packageDigest: value.report.tests.image.digest })}>Inspect scan, SBOM and policy</Link></p>{writable && config.previews && !value.job.stale && value.report.tests.state === 'PASSED' && <button className="button secondary" disabled={busy} onClick={() => void perform(async () => { const id = crypto.randomUUID(); setIntent([id]); await api('/native/pr-preview', { ...context, action: 'create', kind: 'IMAGE_STATIC', imageDigest: value.report.tests.image!.digest, jobId: value.job.id, idempotencyKey: id }); setIntent([]); })}>Deploy scanned image preview</button>}<p className="field-help">The image must pass registry policy and contain assets matching this tested commit. Registry policy is checked for every visitor.</p></>}{value.report.tests.stdout || value.report.tests.stderr ? <><h4>{value.report.execution?.workflow ? 'Workflow' : 'Canonical tests'} · exit {value.report.tests.exitCode}</h4><pre className="native-evidence-code">{value.report.tests.stdout}{value.report.tests.stderr}</pre></> : null}{value.report.advice.answers?.next.choice && <p>Clef recommends: {value.report.advice.answers!.next.choice.replaceAll('_', ' ')}</p>}<p className="field-help">{value.report.limitations.join(' ')}</p></div></section>)}</div>
    {config.previews && <section className="browser-panel"><div className="browser-panel-heading"><h3>Protected previews</h3></div><p className="field-help">Static directory: {config.previewPath}.{config.apps && <> Worker entry: {config.appPath}, with a private database and file bucket.</>} Access verifies identity; current repository readers can request short-lived reviewer grants. Previews expire and their owned resources are removed automatically.</p>{previews.isSuccess && <DataTable data={previews.data.previews.filter(p => !jobs.isError && jobs.data?.jobs.some(j => j.id === p.jobId && j.selection.headCommitId === p.commitId))} columns={previewColumns} getRowId={p => p.id} label="repository previews" />}{previews.data?.truncated && <p className="field-help">Only the latest 100 previews are loaded.</p>}</section>}
    {snapshot && <section className="browser-panel"><div className="browser-panel-heading"><h3>Private Browser Run snapshot</h3><button className="button secondary" onClick={() => setSnapshot(undefined)}>Close snapshot</button></div><p className="field-help">Captured index HTML with scripts and external requests disabled. This is a visual snapshot, not an interactive preview test.</p><img className="native-browser-snapshot" src={snapshot} alt="Static visual snapshot of the approved PR index HTML" /></section>}
  </>;
}

function AgentEditor({ path, blocked, close, submit }: { path: string; blocked: boolean; close: () => void; submit: (prompts: string[]) => void }) {
  const form = useForm({ defaultValues: { first: '', second: '' }, onSubmit: ({ value }) => { if (!blocked) submit([value.first, value.second]); } });
  return <section className="credential-form-content"><h3>Two concurrent proposals</h3><p className="field-help">Both agents start from the current PR head and can edit only {path}. Each runs the approved tests; neither changes canonical Git.</p><form onSubmit={e => { e.preventDefault(); void form.handleSubmit(); }}>{(['first', 'second'] as const).map((name, index) => <form.Field key={name} name={name}>{f => <><label htmlFor={'agent-' + name}>Agent {index + 1} task</label><textarea id={'agent-' + name} required maxLength={16000} disabled={blocked} value={f.state.value} onChange={e => f.handleChange(e.target.value)} /></>}</form.Field>)}<div className="credential-actions"><button type="button" className="button secondary" onClick={close}>Close</button><button className="button primary" disabled={blocked}>Start both agents</button></div></form></section>;
}
export function NativeInstallationSettings() {
  const config = useQuery({ ...privateQuery, queryKey: ['native-config'], queryFn: ({ signal }) => api<Config>('/native/config', {}, signal), refetchInterval: 30000 });
  return <><ErrorMessage error={config.error} />{config.isSuccess ? <NativeSettings config={config.data} /> : <p role="status">Reading Cloudflare allocations…</p>}</>;
}
export function NativePreviewResume({ enabled }: { enabled: boolean }) {
  const started = useRef(false), [error, setError] = useState<unknown>();
  const preview = new URLSearchParams(window.location.search).get('preview');
  useEffect(() => {
    if (!enabled || !preview || started.current) return;
    started.current = true;
    void api<{ grant: string; action: string }>('/native/preview-resume', { previewId: preview }).then(value => {
      const form = document.createElement('form'); form.method = 'POST'; form.action = value.action;
      const input = document.createElement('input'); input.type = 'hidden'; input.name = 'grant'; input.value = value.grant; form.append(input); document.body.append(form); form.submit(); form.remove();
    }).catch(setError);
  }, [enabled, preview]);
  return preview && enabled ? <><ErrorMessage error={error} />{!error && <p role="status">Checking repository access and opening your protected preview…</p>}</> : null;
}
