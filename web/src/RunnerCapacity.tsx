import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useForm } from '@tanstack/react-form';
import { Link } from '@tanstack/react-router';
import { BarChart3, Plus, RefreshCw, Server } from 'lucide-react';
import { nativeAPI } from './nativeAPI';
import { DataTable, type DataTableColumn } from './DataTable';
import { CopyButton, DateLabel, Loading, PanelError, privateQuery } from './RepositoryUI';
import { SummaryBand } from './Layout';

// Mirrors cloudflare/forge/src/capacity.mjs. Golf never starts machines; an unknown allocation is shown as unknown, never as a number.
type Pool = { id: string; engine: 'forgejo-actions' | 'gitlab-ci'; labels: string[]; registered: number; active: number; online: number; running: number; queued: number; oldestWaitSeconds: number | null; scopes: string[] };
type NativePool = { id: string; name: string; state: string; trustClass: string; maxParallel: number; activeMachines: number; running: number; queued: number };
type Count = number | null;
type ContainerClass = { id: string; label: string; binding: string; configured: boolean; allocation: number | null; allocationReason: string; limit: { value: Count; inUse: Count; source: string }; running: Count; queued: Count };
type Hosts = { id: string; label: string; hosts: Count; capacity: Count; online: Count; running: Count; queued: Count; onlineNote: string };
type Setting = { key: string; field: string; label: string; unit: string; policyLabel: string; version: string; cost: string | null; allocated: boolean; reason?: string; current?: number; ceiling?: number; deployMax?: number | null; fixed?: string; deploySetting?: string };
type Deploy = { setting: string; value: number; command: string; steps: string };
export type CapacityRequest = { id: string; key: string; field: string; label: string; unit: string; current: number; requested: number; ceiling: number; needsDeploy: boolean; estimatedMonthlyDelta: number | null; estimateBasis: string;
  reason: string; requestedBy: string; requestedAt: string; mine: boolean; state: 'PENDING' | 'APPROVED' | 'DECLINED' | 'WITHDRAWN' | 'APPLIED' | 'FAILED'; decidedBy: string; decidedAt: string; decisionNote: string;
  appliedBy: string; appliedAt: string; deploy: Deploy | null };
type MetricsToken = { id: string; label: string; createdBy: string; createdAt: string; expiresAt: string; lastUsedAt: string; revokedAt: string; state: 'active' | 'expired' | 'revoked' };
export type Capacity = { generatedAt: string; selfHosted: { configured: boolean; pools: Pool[]; unmatched: { queued: number; oldestWaitSeconds: number | null; byEngine: Record<string, number> }; truncated: boolean; onlineWindowSeconds: number };
  nativePools: NativePool[]; containers: ContainerClass[]; hosts: Hosts[]; settings: Setting[]; requests: CapacityRequest[]; tokens: MetricsToken[]; schema: string; editing: string; metricsPath: string; origin: string; you: string };
type Preview = { current: number; requested: number; ceiling: number; needsDeploy: boolean; estimatedMonthlyDelta: number | null; estimateBasis: string; deploy: Deploy | null };

// One row of the inventory table, whatever the source.
type Row = { id: string; source: string; name: string; capacity: string; online: string; running: Count; queued: Count; wait: number | null; note: string };
const engines: Record<string, string> = { 'forgejo-actions': 'Forgejo runners', 'gitlab-ci': 'GitLab runners' };
const shown = (value: Count) => value === null ? 'Unknown' : String(value);
export const waitText = (seconds: number | null) => seconds === null ? '—' : seconds < 60 ? `${seconds} s` : seconds < 3600 ? `${Math.floor(seconds / 60)} min` : `${Math.floor(seconds / 3600)} h ${Math.floor(seconds % 3600 / 60)} min`;
export const money = (value: number | null) => value === null ? 'Not estimated' : `${value < 0 ? '−' : '+'}$${Math.abs(value).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} a month`;
const message = (error: unknown) => error instanceof Error ? error.message : 'The capacity operation could not be confirmed. Refresh before trying again.';
const stateLabels: Record<CapacityRequest['state'], [string, string]> = { PENDING: ['Pending', 'configured'], APPROVED: ['Approved, waiting for a deploy', 'configured'], APPLIED: ['Applied', 'available'], DECLINED: ['Declined', ''], WITHDRAWN: ['Withdrawn', ''], FAILED: ['Failed', 'refused'] };

export function inventoryRows(data: Capacity): Row[] {
  const self = data.selfHosted;
  return [
    ...self.pools.map(pool => ({ id: 'pool:' + pool.id, source: engines[pool.engine] || pool.engine, name: pool.labels.join(', ') || 'No labels', capacity: `${pool.active} active of ${pool.registered} registered`,
      online: String(pool.online), running: pool.running, queued: pool.queued, wait: pool.oldestWaitSeconds, note: `Scope: ${pool.scopes.join(', ')}` })),
    { id: 'unmatched', source: 'Self-hosted runners', name: 'Queued with no runner', capacity: 'No active runner has these labels and scope', online: '—', running: null, queued: self.unmatched.queued, wait: self.unmatched.oldestWaitSeconds,
      note: Object.entries(self.unmatched.byEngine).map(([engine, n]) => `${engines[engine] || engine}: ${n}`).join(' · ') || (self.configured ? 'None waiting' : 'Actions pipelines are not allocated on this installation') },
    ...data.nativePools.map(pool => ({ id: 'native:' + pool.id, source: 'Native runner pool', name: pool.name, capacity: `${pool.maxParallel} parallel · ${pool.activeMachines} active machines`, online: '—',
      running: pool.running, queued: pool.queued, wait: null, note: `${pool.state.toLowerCase()} · ${pool.trustClass.toLowerCase()}` })),
    ...data.containers.map(item => ({ id: 'containers:' + item.id, source: 'Cloudflare containers', name: item.label, capacity: item.allocation === null ? 'Allocation not known to the Worker' : String(item.allocation),
      online: '—', running: item.running, queued: item.queued, wait: null, note: item.configured ? `Golf limit ${shown(item.limit.value)} (${shown(item.limit.inUse)} in use). ${item.limit.source}` : `${item.binding} is not configured on this installation.` })),
    ...data.hosts.map(item => ({ id: 'hosts:' + item.id, source: item.label, name: `${shown(item.hosts)} active`, capacity: `${shown(item.capacity)} concurrent tasks`, online: item.online === null ? '—' : shown(item.online),
      running: item.running, queued: item.queued, wait: null, note: item.onlineNote })),
  ];
}
const inventoryColumns: DataTableColumn<Row>[] = [
  { id: 'source', header: 'Source', accessorFn: row => row.source },
  { id: 'name', header: 'Pool or class', accessorFn: row => row.name, cell: ({ row }) => <span className="capacity-name">{row.original.name}<small>{row.original.note}</small></span> },
  { id: 'capacity', header: 'Capacity', accessorFn: row => row.capacity },
  { id: 'online', header: 'Online', accessorFn: row => row.online },
  { id: 'running', header: 'Running', accessorFn: row => row.running ?? -1, sortFn: 'basic', cell: ({ row }) => shown(row.original.running) },
  { id: 'queued', header: 'Queued', accessorFn: row => row.queued ?? -1, sortFn: 'basic', cell: ({ row }) => shown(row.original.queued) },
  { id: 'wait', header: 'Oldest wait', accessorFn: row => row.wait ?? -1, sortFn: 'basic', cell: ({ row }) => waitText(row.original.wait) },
];

export function RunnerCapacity({ userId, signingOut }: { userId: string; signingOut: boolean }) {
  const query = useQuery({ ...privateQuery, queryKey: ['capacity', userId], enabled: !signingOut, retry: false,
    queryFn: ({ signal }) => nativeAPI<Capacity>('/native/capacity/read', { action: 'read' }, signal) });
  const [requesting, setRequesting] = useState(false), [deciding, setDeciding] = useState<{ request: CapacityRequest; approve: boolean }>();
  const [creatingToken, setCreatingToken] = useState(false), [created, setCreated] = useState<{ token: MetricsToken; secret: string; metricsUrl: string }>();
  const [notice, setNotice] = useState(''), [error, setError] = useState(''), [busy, setBusy] = useState(false);
  if (query.error) return <PanelError error={query.error} retry={() => void query.refetch()} />;
  const data = query.data;
  if (!data) return <Loading label="Reading runner capacity…" />;
  const refresh = () => query.refetch();
  const act = async (body: object, done: string) => {
    setBusy(true); setError(''); setNotice('');
    try { await nativeAPI('/native/capacity', body); setNotice(done); await refresh(); } catch (cause) { setError(message(cause)); } finally { setBusy(false); }
  };
  const ready = data.schema === 'ready', pending = data.requests.filter(item => item.state === 'PENDING').length;
  const queued = data.selfHosted.pools.reduce((sum, pool) => sum + pool.queued, 0);
  const requestColumns: DataTableColumn<CapacityRequest>[] = [
    { id: 'setting', header: 'Setting', accessorFn: item => item.label, cell: ({ row: { original: item } }) => <span className="capacity-name">{item.label}<small>{item.reason}</small></span> },
    { id: 'change', header: 'Current → requested', accessorFn: item => item.requested, sortFn: 'basic', cell: ({ row: { original: item } }) => `${item.current} → ${item.requested} ${item.unit}` },
    { id: 'ceiling', header: 'Ceiling', accessorFn: item => item.ceiling, sortFn: 'basic', cell: ({ row: { original: item } }) => <>{item.ceiling}{item.needsDeploy ? <> <span className="visibility configured">Needs a deploy</span></> : null}</> },
    { id: 'cost', header: 'Cost change', accessorFn: item => item.estimatedMonthlyDelta ?? -1, sortFn: 'basic', cell: ({ row: { original: item } }) => <span className="capacity-name">{money(item.estimatedMonthlyDelta)}<small>{item.estimateBasis}</small></span> },
    { id: 'requester', header: 'Requested by', accessorFn: item => item.requestedBy, cell: ({ row: { original: item } }) => <span className="capacity-name">{item.requestedBy}<small><DateLabel value={item.requestedAt} relative /></small></span> },
    { id: 'state', header: 'State', accessorFn: item => stateLabels[item.state][0], cell: ({ row: { original: item } }) => <span className="capacity-name"><span className={`visibility ${stateLabels[item.state][1]}`}>{stateLabels[item.state][0]}</span>
      <small>{item.decidedBy ? `${item.state === 'WITHDRAWN' ? 'Withdrawn' : 'Decided'} by ${item.decidedBy}` : ''}{item.appliedBy ? ` · applied by ${item.appliedBy}` : ''}{item.decisionNote ? ` · ${item.decisionNote}` : ''}</small></span> },
    { id: 'actions', header: 'Actions', enableSorting: false, enableGlobalFilter: false, cell: ({ row: { original: item } }) => <div className="row-actions">
      {!item.mine && ['PENDING', 'APPROVED'].includes(item.state) ? <button type="button" className="button secondary" disabled={busy} aria-label={`${item.state === 'PENDING' ? 'Approve' : 'Apply'} ${item.label}`} onClick={() => { setDeciding({ request: item, approve: true }); setError(''); }}>{item.state === 'PENDING' ? 'Approve' : 'Apply'}</button> : null}
      {!item.mine && item.state === 'PENDING' ? <button type="button" className="button secondary danger-action" disabled={busy} aria-label={`Decline ${item.label}`} onClick={() => { setDeciding({ request: item, approve: false }); setError(''); }}>Decline</button> : null}
      {item.mine && ['PENDING', 'APPROVED'].includes(item.state) ? <button type="button" className="button secondary" disabled={busy} aria-label={`Withdraw ${item.label}`} onClick={() => void act({ action: 'withdraw', id: item.id }, `Your request for ${item.label.toLowerCase()} was withdrawn.`)}>Withdraw</button> : null}
      {item.mine && item.state === 'PENDING' ? <span className="muted">Another administrator decides</span> : null}</div> },
  ];
  const tokenColumns: DataTableColumn<MetricsToken>[] = [
    { accessorKey: 'label', header: 'Token', cell: ({ row: { original: t } }) => <span className="capacity-name">{t.label}<small>Created by {t.createdBy} <DateLabel value={t.createdAt} relative /></small></span> },
    { id: 'expires', header: 'Expires', accessorFn: t => t.expiresAt, cell: ({ row: { original: t } }) => <DateLabel value={t.expiresAt} relative /> },
    { id: 'used', header: 'Last used', accessorFn: t => t.lastUsedAt, cell: ({ row: { original: t } }) => t.lastUsedAt ? <DateLabel value={t.lastUsedAt} relative /> : <span className="muted">Never</span> },
    { id: 'state', header: 'State', accessorFn: t => t.state, cell: ({ row: { original: t } }) => <span className={`visibility${t.state === 'active' ? ' available' : ''}`}>{t.state === 'active' ? 'Active' : t.state === 'expired' ? 'Expired' : 'Revoked'}</span> },
    { id: 'actions', header: 'Actions', enableSorting: false, enableGlobalFilter: false, cell: ({ row: { original: t } }) => t.state === 'active' ? <button type="button" className="button secondary danger-action" disabled={busy} aria-label={`Revoke ${t.label}`}
      onClick={() => { if (window.confirm(`Revoke capacity metrics token ${t.label}? Autoscalers using it stop reading queue depth.`)) void act({ action: 'revokeMetricsToken', id: t.id }, `${t.label} was revoked.`); }}>Revoke</button> : null },
  ];
  return <div className="page-stack">
    <div className="settings-toolbar"><span className="field-help">Read <DateLabel value={data.generatedAt} relative /></span>
      <button type="button" className="button secondary" disabled={query.isFetching} onClick={() => void refresh()}><RefreshCw size={15} className={query.isFetching ? 'spin' : undefined} />Refresh</button>
      <Link className="button secondary" to="/admin/settings/runners"><Server size={15} />Runners</Link>
      <Link className="button secondary" to="/admin/costs"><BarChart3 size={15} />Estimated costs</Link></div>
    <SummaryBand label="Runner capacity summary" items={[
      ['Queued for self-hosted pools', String(queued), `${data.selfHosted.pools.length} pools`],
      ['Queued with no runner', String(data.selfHosted.unmatched.queued), data.selfHosted.unmatched.oldestWaitSeconds === null ? 'Nothing waiting' : `Oldest ${waitText(data.selfHosted.unmatched.oldestWaitSeconds)}`],
      ['Pending requests', String(pending), pending ? 'Another administrator decides' : 'None'],
      ['Metrics tokens', String(data.tokens.filter(t => t.state === 'active').length), 'Active'],
    ]} />
    {notice ? <p className="field-help" role="status">{notice}</p> : null}
    {error && !deciding ? <p className="error" role="alert">{error}</p> : null}
    <section className="browser-panel" aria-labelledby="capacity-inventory"><div className="browser-panel-heading"><h2 id="capacity-inventory">Capacity by source</h2><span className="policy-card-note">Current snapshot from Golf’s records</span></div>
      <DataTable data={inventoryRows(data)} columns={inventoryColumns} getRowId={row => row.id} label="runner capacity" pagination={false} />
      <p className="panel-footnote">Self-hosted runners are pooled by engine and label names (a Forgejo label <code>name:docker://image</code> counts as <code>name</code>), as the claim matches them. A pool’s queue is the jobs its labels take in repositories its runners’ scope covers; a job several pools can take is counted in each. Online means seen in the last {data.selfHosted.onlineWindowSeconds / 60} minutes.{data.selfHosted.truncated ? ' Only the newest runners and oldest queued jobs were read; counts are partial.' : ''}</p>
    </section>
    <section className="browser-panel" aria-labelledby="capacity-requests"><div className="browser-panel-heading"><h2 id="capacity-requests">Capacity requests</h2>
      {ready && !requesting ? <button type="button" className="button primary" onClick={() => { setRequesting(true); setNotice(''); setError(''); }}><Plus size={15} />Request more capacity</button> : null}</div>
      <p className="field-help">A request raises one installation limit. Another operations administrator approves it, and approval applies it with the same rules as the Installation page: type the setting name, and an Access sign-in from the last 10 minutes when it widens. A value above the deploy ceiling cannot be applied here: approval records it, and it is applied after a deploy raises the ceiling.</p>
      {data.editing ? <p className="error" role="alert">{data.editing}</p> : null}
      {!ready ? <p className="panel-footnote">{data.schema}</p> : <DataTable data={data.requests} columns={requestColumns} getRowId={item => item.id} label="capacity requests" emptyMessage="No capacity requests yet. Choose Request more capacity to ask for a higher limit." />}
      {data.requests.filter(item => item.deploy && item.state === 'APPROVED').map(item => <div key={item.id} className="pipeline-runner-command"><strong>Deploy to raise the ceiling for {item.label.toLowerCase()}</strong><p className="field-help">{item.deploy!.steps}</p><pre>{item.deploy!.command}</pre></div>)}
    </section>
    {requesting ? <RequestForm settings={data.settings} close={() => setRequesting(false)} done={text => { setRequesting(false); setNotice(text); void refresh(); }} /> : null}
    {deciding ? <DecisionForm key={deciding.request.id + String(deciding.approve)} request={deciding.request} approve={deciding.approve} version={data.settings.find(s => s.key === deciding.request.key)?.version || '0'}
      close={() => setDeciding(undefined)} done={text => { setDeciding(undefined); setNotice(text); void refresh(); }} /> : null}
    <section className="browser-panel" aria-labelledby="capacity-tokens"><div className="browser-panel-heading"><h2 id="capacity-tokens">Autoscaler metrics tokens</h2>
      {ready && !creatingToken ? <button type="button" className="button primary" onClick={() => { setCreatingToken(true); setCreated(undefined); setNotice(''); }}><Plus size={15} />New metrics token</button> : null}</div>
      <p className="field-help">A metrics token reads queue depth for one runner pool at <code>{data.origin}{data.metricsPath}?engine=forgejo-actions&amp;labels=…</code> and nothing else in Golf. Point a KEDA <code>metrics-api</code> scaler or an HPA external metric at it; see docs/RUNNER_CAPACITY.md.</p>
      {!ready ? <p className="panel-footnote">{data.schema}</p> : <DataTable data={data.tokens} columns={tokenColumns} getRowId={t => t.id} label="capacity metrics tokens" emptyMessage="No metrics tokens. Choose New metrics token to create one for an autoscaler." />}
    </section>
    {creatingToken ? <TokenForm close={() => setCreatingToken(false)} done={value => { setCreatingToken(false); setCreated(value); void refresh(); }} /> : null}
    {created ? <section className="browser-panel credential-form-content pipeline-runner-command" aria-label="Your new metrics token"><h3>Copy your new metrics token now</h3>
      <p className="field-help">This is the only time Golf shows <strong>{created.token.label}</strong>. Golf keeps only a hash of it; store it as a Kubernetes Secret for the scaler.</p>
      <pre>{created.secret}</pre><div className="credential-actions"><CopyButton text={created.secret} label="Copy token" /></div>
      <pre>{`curl -H "Authorization: Bearer $GOLF_CAPACITY_TOKEN" '${created.metricsUrl}?engine=forgejo-actions&labels=ubuntu-latest'`}</pre>
      <div className="credential-actions"><button type="button" className="button secondary" onClick={() => setCreated(undefined)}>Done</button></div></section> : null}
  </div>;
}

function RequestForm({ settings, close, done }: { settings: Setting[]; close: () => void; done: (text: string) => void }) {
  const choices = settings.filter(s => s.allocated);
  const [preview, setPreview] = useState<Preview>(), [failure, setFailure] = useState('');
  const form = useForm({ defaultValues: { setting: choices[0] ? `${choices[0].key}/${choices[0].field}` : '', value: '', reason: '' },
    onSubmit: async ({ value }) => {
      setFailure('');
      const [key, field] = value.setting.split('/');
      try { await nativeAPI('/native/capacity', { action: 'request', key, field, value: Number(value.value), reason: value.reason.trim() }); done('Your request was recorded. Another operations administrator approves or declines it.'); }
      catch (cause) { setFailure(message(cause)); }
    } });
  const chosen = (text: string) => choices.find(s => `${s.key}/${s.field}` === text);
  const estimate = async () => {
    const { setting, value } = form.state.values, [key, field] = setting.split('/');
    setFailure(''); setPreview(undefined);
    try { setPreview(await nativeAPI<Preview>('/native/capacity/read', { action: 'preview', key, field, value: Number(value) })); } catch (cause) { setFailure(message(cause)); }
  };
  return <form className="browser-panel credential-form-content" aria-label="Request more capacity" onSubmit={event => { event.preventDefault(); void form.handleSubmit(); }}>
    <h3>Request more capacity</h3>
    <form.Field name="setting">{field => <label>Setting<select value={field.state.value} onChange={event => { field.handleChange(event.target.value); setPreview(undefined); }}>
      {choices.map(s => <option key={`${s.key}/${s.field}`} value={`${s.key}/${s.field}`}>{s.label} ({s.policyLabel})</option>)}</select></label>}</form.Field>
    <form.Subscribe selector={state => state.values.setting}>{setting => { const s = chosen(setting); return s ? <p className="field-help">Now {s.current} {s.unit}; up to {s.ceiling} without a deploy{s.deployMax ? `, up to ${s.deployMax} with one (${s.deploySetting})` : `. ${s.fixed}`}. {s.cost ? `Cost: ${s.cost.toLowerCase()}.` : 'No cost model for this setting.'}</p> : null; }}</form.Subscribe>
    <form.Field name="value" validators={{ onChange: ({ value }) => /^[1-9][0-9]{0,8}$/.test(value.trim()) ? undefined : 'Enter a whole number.' }}>{field => <label>Requested value<input type="number" inputMode="numeric" min={1} required value={field.state.value}
      onChange={event => { field.handleChange(event.target.value); setPreview(undefined); }} />{field.state.meta.errors.length ? <span className="error" role="alert">{field.state.meta.errors.join(' ')}</span> : null}</label>}</form.Field>
    <form.Field name="reason">{field => <label>Why<textarea rows={3} maxLength={500} required value={field.state.value} onChange={event => field.handleChange(event.target.value)} placeholder="Bench at 200 agents next week" /></label>}</form.Field>
    {preview ? <dl className="settings-profile" aria-label="Request preview"><div><dt>Change</dt><dd>{preview.current} → {preview.requested}{preview.needsDeploy ? ` (above the ceiling ${preview.ceiling}: needs a deploy)` : ''}</dd></div>
      <div><dt>Estimated cost change</dt><dd>{money(preview.estimatedMonthlyDelta)}. {preview.estimateBasis}</dd></div>
      {preview.deploy ? <div><dt>Deploy step</dt><dd>{preview.deploy.steps}</dd></div> : null}</dl> : null}
    {failure ? <p className="error" role="alert">{failure}</p> : null}
    <form.Subscribe selector={state => [state.isSubmitting, state.canSubmit] as const}>{([submitting, canSubmit]) => <div className="credential-actions">
      <button type="button" className="button secondary" disabled={submitting || !canSubmit} onClick={() => void estimate()}>Estimate cost</button>
      <button className="button primary" disabled={submitting || !canSubmit}>{submitting ? 'Requesting…' : 'Request'}</button>
      <button type="button" className="button secondary" disabled={submitting} onClick={close}>Cancel</button></div>}</form.Subscribe>
  </form>;
}

function DecisionForm({ request, approve, version, close, done }: { request: CapacityRequest; approve: boolean; version: string; close: () => void; done: (text: string) => void }) {
  // One operation ID per opened form: a retry after an unknown outcome cannot apply the change twice.
  const [operationId] = useState(() => crypto.randomUUID()), [failure, setFailure] = useState('');
  const verb = !approve ? 'Decline' : request.state === 'APPROVED' ? 'Apply' : 'Approve';
  const form = useForm({ defaultValues: { confirmation: '', note: '' },
    onSubmit: async ({ value }) => {
      setFailure('');
      try {
        const result = await nativeAPI<{ request: CapacityRequest }>('/native/capacity', approve ? { action: 'approve', id: request.id, operationId, expectedVersion: version, confirmation: value.confirmation, ...(value.note.trim() ? { note: value.note.trim() } : {}) }
          : { action: 'decline', id: request.id, ...(value.note.trim() ? { note: value.note.trim() } : {}) });
        const state = result.request.state;
        done(state === 'APPLIED' ? `${request.label} is now ${request.requested}.` : state === 'APPROVED' ? `Approved. ${request.label} waits for a deploy that raises the ceiling.` : state === 'FAILED' ? `The request failed: ${result.request.decisionNote}` : `The request for ${request.label.toLowerCase()} was declined.`);
      } catch (cause) { setFailure(message(cause)); }
    } });
  return <form className="browser-panel credential-form-content" aria-label={`${verb} capacity request`} onSubmit={event => { event.preventDefault(); void form.handleSubmit(); }}>
    <h3>{verb} {request.label.toLowerCase()}: {request.current} → {request.requested}</h3>
    <dl className="settings-profile"><div><dt>Requested by</dt><dd>{request.requestedBy}: {request.reason}</dd></div><div><dt>Estimated cost change</dt><dd>{money(request.estimatedMonthlyDelta)}. {request.estimateBasis}</dd></div>
      {request.needsDeploy && request.deploy ? <div><dt>Needs a deploy</dt><dd>Above the ceiling of {request.ceiling}. Approval records it; nothing changes until {request.deploy.steps}</dd></div> : null}</dl>
    {approve ? <form.Field name="confirmation">{field => <label>Type <code>{request.key}</code> to confirm<input autoComplete="off" spellCheck={false} required value={field.state.value} onChange={event => field.handleChange(event.target.value)} />
      <span className="field-help">Applying a wider value also needs an Access sign-in from the last 10 minutes.</span></label>}</form.Field> : null}
    <form.Field name="note">{field => <label>Note (optional)<textarea rows={2} maxLength={500} value={field.state.value} onChange={event => field.handleChange(event.target.value)} /></label>}</form.Field>
    {failure ? <p className="error" role="alert">{failure}{/last 10 minutes/.test(failure) ? <> <a href="/cdn-cgi/access/logout">Sign out of Access</a>, sign in again, then retry.</> : null}</p> : null}
    <form.Subscribe selector={state => [state.isSubmitting, state.values.confirmation] as const}>{([submitting, confirmation]) => <div className="credential-actions">
      <button className="button primary" disabled={submitting || approve && confirmation !== request.key}>{submitting ? 'Saving…' : verb}</button>
      <button type="button" className="button secondary" disabled={submitting} onClick={close}>Cancel</button></div>}</form.Subscribe>
  </form>;
}

function TokenForm({ close, done }: { close: () => void; done: (value: { token: MetricsToken; secret: string; metricsUrl: string }) => void }) {
  const [failure, setFailure] = useState('');
  const form = useForm({ defaultValues: { label: '', lifetimeDays: 90 },
    onSubmit: async ({ value }) => {
      setFailure('');
      try { done(await nativeAPI('/native/capacity', { action: 'createMetricsToken', label: value.label.trim(), lifetimeDays: value.lifetimeDays })); } catch (cause) { setFailure(message(cause)); }
    } });
  return <form className="browser-panel credential-form-content" aria-label="New metrics token" onSubmit={event => { event.preventDefault(); void form.handleSubmit(); }}>
    <h3>New metrics token</h3>
    <form.Field name="label">{field => <label>Name<input required maxLength={64} autoComplete="off" value={field.state.value} onChange={event => field.handleChange(event.target.value)} placeholder="keda-golf-ci" /></label>}</form.Field>
    <form.Field name="lifetimeDays">{field => <label>Expires after<select value={field.state.value} onChange={event => field.handleChange(Number(event.target.value))}>{[[30, '30 days'], [90, '90 days'], [365, '1 year']].map(([days, text]) => <option key={days} value={days}>{text}</option>)}</select></label>}</form.Field>
    {failure ? <p className="error" role="alert">{failure}</p> : null}
    <form.Subscribe selector={state => state.isSubmitting}>{submitting => <div className="credential-actions"><button className="button primary" disabled={submitting}>Create token</button><button type="button" className="button secondary" onClick={close}>Cancel</button></div>}</form.Subscribe>
  </form>;
}
