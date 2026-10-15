import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useForm } from '@tanstack/react-form';
import { Pencil, Plus } from 'lucide-react';
import { nativeAPI } from './nativeAPI';
import { DataTable, type DataTableColumn } from './DataTable';
import { DateLabel, Loading, PanelError, privateQuery } from './RepositoryUI';

/* Runner capacity, slice 2 (cloudflare/forge/src/capacity-policy.mjs and capacity-shares.mjs): self-hosted pool caps and runner shares.
 * The installation's values are installation policies, changed through /native/installation; an organization's or repository's own share
 * is changed through /native/capacity/shares. Every value here is what the server reported; nothing is assumed. */

export type Engine = 'forgejo-actions' | 'gitlab-ci';
export type PoolCap = { engine: Engine; labels: string[]; maxConcurrent: number };
export type ShareValue = { maxRunning: number | null; maxRunsPerDay: number | null };
export type InstallationShare = ShareValue & { enforced: boolean };
export type PolicyView<T> = { key: string; label: string; version: string; value: T; deploy: T; source: 'installation' | 'deploy'; unreadable: boolean; updatedAt: string; updatedBy: string;
  effect: { queued: string; inFlight: string; new: string }; confirmation: string };
export type RunnerPolicies = { pools: PolicyView<{ pools: PoolCap[] }> | null; shares: PolicyView<InstallationShare> | null };
export type ShareRow = { scope: 'organization' | 'repository'; id: string; name: string; limit: ShareValue; ceiling: ShareValue; own: ShareValue | null; granted: ShareValue | null; enforced: boolean;
  running: number; queued: number; held: number; runsToday: number };
type PoolUse = { id: string; running: number; queued: number; heldByCap: number };

const engineLabels: Record<Engine, string> = { 'forgejo-actions': 'Forgejo runners', 'gitlab-ci': 'GitLab runners' };
export const poolKey = (cap: { engine: string; labels: string[] }) => `${cap.engine}:${[...cap.labels].sort().join(',')}`;
const limitText = (value: number | null, unit: string) => value === null ? 'No limit' : `${value} ${unit}`;
const message = (error: unknown) => error instanceof Error ? error.message : 'The change could not be confirmed. Refresh before trying again.';
const recentSignIn = (failure: string) => /last 10 minutes/.test(failure) ? <> <a href="/cdn-cgi/access/logout">Sign out of Access</a>, sign in again, then retry.</> : null;
// Blank means no value (no limit, or inherit); otherwise a whole number.
const whole = (text: string) => text.trim() === '' ? null : Number(text.trim());
const wholeError = (text: string) => text.trim() === '' || /^[1-9][0-9]{0,5}$/.test(text.trim()) ? undefined : 'Enter a whole number, or leave it empty.';
const wider = (before: number | null, after: number | null) => before !== null && (after === null || after > before);

async function savePolicy(key: string, version: string, operationId: string, value: object, confirmation: string) {
  return nativeAPI('/native/installation', { action: 'update', key, expectedVersion: version, operationId, value, ...(confirmation ? { confirmation } : {}) });
}

// ---------- the Runner capacity page: installation values ----------
export function RunnerPolicyPanels({ policies, pools, shares, sharesSchema, refresh }: { policies: RunnerPolicies; pools: PoolUse[]; shares: ShareRow[]; sharesSchema: string; refresh: () => Promise<unknown> }) {
  const [capForm, setCapForm] = useState<{ mode: 'add' | 'edit' | 'remove'; cap?: PoolCap }>(), [sharesForm, setSharesForm] = useState(false), [notice, setNotice] = useState('');
  const caps = policies.pools, installation = policies.shares;
  const done = (text: string) => { setCapForm(undefined); setSharesForm(false); setNotice(text); void refresh(); };
  const capColumns: DataTableColumn<PoolCap>[] = [
    { id: 'pool', header: 'Pool', accessorFn: cap => poolKey(cap), cell: ({ row: { original: cap } }) => <span className="capacity-name">{cap.labels.join(', ') || 'No labels'}<small>{engineLabels[cap.engine]}</small></span> },
    { id: 'cap', header: 'Cap', accessorFn: cap => cap.maxConcurrent, sortFn: 'basic', cell: ({ row: { original: cap } }) => `${cap.maxConcurrent} running` },
    { id: 'running', header: 'Running now', accessorFn: cap => pools.find(pool => pool.id === poolKey(cap))?.running ?? 0, sortFn: 'basic' },
    { id: 'held', header: 'Waiting for the cap', accessorFn: cap => pools.find(pool => pool.id === poolKey(cap))?.heldByCap ?? 0, sortFn: 'basic' },
    { id: 'actions', header: 'Actions', enableSorting: false, enableGlobalFilter: false, cell: ({ row: { original: cap } }) => <div className="row-actions">
      <button type="button" className="button secondary" aria-label={`Edit cap for ${cap.labels.join(', ') || 'no labels'}`} onClick={() => { setCapForm({ mode: 'edit', cap }); setNotice(''); }}>Edit</button>
      <button type="button" className="button secondary danger-action" aria-label={`Remove cap for ${cap.labels.join(', ') || 'no labels'}`} onClick={() => { setCapForm({ mode: 'remove', cap }); setNotice(''); }}>Remove</button></div> },
  ];
  const shareColumns: DataTableColumn<ShareRow>[] = [
    { id: 'name', header: 'Organization or repository', accessorFn: row => row.name, cell: ({ row: { original: row } }) => <span className="capacity-name">{row.name}<small>{row.scope === 'organization' ? 'Organization, all its repositories' : 'Repository'} · {shareSource(row)}</small></span> },
    { id: 'running', header: 'Running', accessorFn: row => row.running, sortFn: 'basic', cell: ({ row: { original: row } }) => row.limit.maxRunning === null ? `${row.running} (no limit)` : `${row.running} of ${row.limit.maxRunning}` },
    { id: 'queued', header: 'Queued', accessorFn: row => row.queued, sortFn: 'basic' },
    { id: 'held', header: 'Held by the share', accessorFn: row => row.held, sortFn: 'basic' },
    { id: 'runs', header: 'Runs today', accessorFn: row => row.runsToday, sortFn: 'basic', cell: ({ row: { original: row } }) => row.limit.maxRunsPerDay === null ? `${row.runsToday} (no limit)` : `${row.runsToday} of ${row.limit.maxRunsPerDay}` },
  ];
  return <>
    {notice ? <p className="field-help" role="status">{notice}</p> : null}
    <section className="browser-panel" aria-labelledby="capacity-pool-caps"><div className="browser-panel-heading"><h2 id="capacity-pool-caps">Pool caps</h2>
      {caps && !capForm ? <button type="button" className="button primary" onClick={() => { setCapForm({ mode: 'add' }); setNotice(''); }}><Plus size={15} />Add pool cap</button> : null}</div>
      {!caps ? <p className="panel-footnote">Actions pipelines are not allocated on this installation, so there are no self-hosted pools to cap.</p> : <>
        <p className="field-help">A runner in a capped pool gets no job while the pool runs that many, exactly as when the queue is empty. A pool is an engine and its runners’ label names. {policySource(caps, 'No caps (the deploy value: self-hosted machines have no deploy allocation)')}</p>
        <DataTable data={caps.value.pools} columns={capColumns} getRowId={poolKey} label="pool caps" emptyMessage="No pool caps: every pool takes as many jobs as its runners can. Choose Add pool cap to set one." />
        {capForm ? <CapForm key={capForm.mode + (capForm.cap ? poolKey(capForm.cap) : '')} mode={capForm.mode} cap={capForm.cap} policy={caps} close={() => setCapForm(undefined)} done={done} /> : null}
      </>}
    </section>
    <section className="browser-panel" aria-labelledby="capacity-shares"><div className="browser-panel-heading"><h2 id="capacity-shares">Runner shares</h2>
      {installation && !sharesForm ? <button type="button" className="button secondary" onClick={() => { setSharesForm(true); setNotice(''); }}><Pencil size={15} />Edit</button> : null}</div>
      {!installation ? <p className="panel-footnote">Actions pipelines are not allocated on this installation; there is no runner capacity to share.</p> : <>
        <dl className="settings-profile" aria-label="Installation runner share">
          <div><dt>Running jobs</dt><dd>{limitText(installation.value.maxRunning, 'at once')} for each organization (all its repositories together) and each personal repository</dd></div>
          <div><dt>Runs a day</dt><dd>{limitText(installation.value.maxRunsPerDay, 'a day (UTC)')}</dd></div>
          <div><dt>Organizations and repositories</dt><dd>{installation.value.enforced ? 'Enforced: they cannot set their own' : 'May set their own at or below it'}</dd></div>
          <div><dt>Source</dt><dd>{policySource(installation, 'No limits (the deploy value)')}</dd></div>
        </dl>
        {sharesForm ? <SharesForm policy={installation} close={() => setSharesForm(false)} done={done} /> : null}
        {sharesSchema !== 'ready' ? <p className="panel-footnote">{sharesSchema}</p> : null}
        <DataTable data={shares} columns={shareColumns} getRowId={row => `${row.scope}:${row.id}`} label="runner shares" emptyMessage="No organization or repository has a share of its own, a grant, or work under a share right now." />
        <p className="panel-footnote">Listed: organizations and repositories with a share of their own or a grant, and those with running, queued or started work under a share that applies (at most 200). A held job waits while its organization or repository runs its share; runners take other jobs meanwhile. Organization owners ask for more than the installation’s value through a capacity request, decided above.</p>
      </>}
    </section>
  </>;
}
function policySource(policy: PolicyView<unknown>, deployText: string) {
  return policy.source === 'installation' ? <>Set by {policy.updatedBy || 'an administrator'} <DateLabel value={policy.updatedAt} relative />.</> : <>{deployText}.</>;
}
function shareSource(row: ShareRow) {
  if (row.enforced) return 'the installation’s, enforced';
  if (row.own && (row.own.maxRunning !== null || row.own.maxRunsPerDay !== null)) return 'its own value';
  if (row.granted) return 'granted by the installation';
  return row.scope === 'repository' ? 'inherited' : 'the installation’s';
}

function CapForm({ mode, cap, policy, close, done }: { mode: 'add' | 'edit' | 'remove'; cap?: PoolCap; policy: PolicyView<{ pools: PoolCap[] }>; close: () => void; done: (text: string) => void }) {
  const [operationId] = useState(() => crypto.randomUUID()), [failure, setFailure] = useState('');
  const next = (value: { engine: Engine; labels: string; maxConcurrent: string }) => {
    const entry = { engine: value.engine, labels: value.labels.split(',').map(label => label.trim()).filter(Boolean), maxConcurrent: Number(value.maxConcurrent) };
    const others = policy.value.pools.filter(item => !cap || poolKey(item) !== poolKey(cap));
    return mode === 'remove' ? others : [...others, entry];
  };
  const widens = (value: { maxConcurrent: string }) => mode === 'remove' || mode === 'edit' && Number(value.maxConcurrent) > (cap?.maxConcurrent ?? Infinity);
  const form = useForm({ defaultValues: { engine: (cap?.engine || 'forgejo-actions') as Engine, labels: cap?.labels.join(', ') || '', maxConcurrent: String(cap?.maxConcurrent ?? ''), confirmation: '' },
    onSubmit: async ({ value }) => {
      setFailure('');
      try { await savePolicy('runner-pools', policy.version, operationId, { pools: next(value) }, widens(value) ? value.confirmation : ''); done(mode === 'remove' ? 'The pool cap was removed.' : 'The pool cap was saved. It applies to the next claim.'); }
      catch (cause) { setFailure(message(cause)); }
    } });
  const title = mode === 'add' ? 'Add pool cap' : mode === 'edit' ? 'Edit pool cap' : 'Remove pool cap';
  return <form className="credential-form-content" aria-label={title} onSubmit={event => { event.preventDefault(); void form.handleSubmit(); }}>
    <h3>{title}</h3>
    {mode === 'add' ? <>
      <form.Field name="engine">{field => <label>Engine<select value={field.state.value} onChange={event => field.handleChange(event.target.value as Engine)}>
        {Object.entries(engineLabels).map(([value, text]) => <option key={value} value={value}>{text}</option>)}</select></label>}</form.Field>
      <form.Field name="labels" validators={{ onChange: ({ value }) => value.split(',').map(label => label.trim()).filter(Boolean).every(label => /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}(?::\S+)?$/.test(label)) ? undefined : 'Use runner label names separated by commas.' }}>{field => <label>Runner labels<input value={field.state.value} onChange={event => field.handleChange(event.target.value)} placeholder="ubuntu-latest, docker" spellCheck={false} />
        <span className="field-help">The labels the pool’s runners register with, separated by commas. Images are ignored, as in matching.</span>{field.state.meta.errors.length ? <span className="error" role="alert">{field.state.meta.errors.join(' ')}</span> : null}</label>}</form.Field>
    </> : <p className="field-help">{engineLabels[cap!.engine]}: {cap!.labels.join(', ') || 'no labels'}{mode === 'remove' ? `, now capped at ${cap!.maxConcurrent} running. Removing the cap lets the pool take as many jobs as its runners can.` : '.'}</p>}
    {mode !== 'remove' ? <form.Field name="maxConcurrent" validators={{ onChange: ({ value }) => /^[1-9][0-9]{0,3}$/.test(value.trim()) && Number(value) <= 1000 ? undefined : 'Enter a whole number from 1 to 1000.' }}>{field => <label>Running jobs at most<input type="number" inputMode="numeric" min={1} max={1000} required value={field.state.value} onChange={event => field.handleChange(event.target.value)} />
      {field.state.meta.errors.length ? <span className="error" role="alert">{field.state.meta.errors.join(' ')}</span> : null}</label>}</form.Field> : null}
    <dl className="settings-profile settings-policy-effect"><div><dt>Queued work</dt><dd>{policy.effect.queued}</dd></div><div><dt>In flight</dt><dd>{policy.effect.inFlight}</dd></div><div><dt>New work</dt><dd>{policy.effect.new}</dd></div></dl>
    <form.Subscribe selector={state => state.values}>{values => widens(values) ? <form.Field name="confirmation">{field => <label>Type <code>{policy.confirmation}</code> to confirm{mode === 'remove' ? ' removing the cap' : ' a higher cap'}
      <input autoComplete="off" spellCheck={false} value={field.state.value} onChange={event => field.handleChange(event.target.value)} /><span className="field-help">Letting a pool take more also needs an Access sign-in from the last 10 minutes.</span></label>}</form.Field> : null}</form.Subscribe>
    {failure ? <p className="error" role="alert">{failure}{recentSignIn(failure)}</p> : null}
    <form.Subscribe selector={state => [state.isSubmitting, state.canSubmit, state.values] as const}>{([submitting, canSubmit, values]) => <div className="credential-actions">
      <button className="button primary" disabled={submitting || !canSubmit || widens(values) && values.confirmation !== policy.confirmation}>{submitting ? 'Saving…' : mode === 'remove' ? 'Remove cap' : 'Save cap'}</button>
      <button type="button" className="button secondary" disabled={submitting} onClick={close}>Cancel</button></div>}</form.Subscribe>
  </form>;
}

function SharesForm({ policy, close, done }: { policy: PolicyView<InstallationShare>; close: () => void; done: (text: string) => void }) {
  const [operationId] = useState(() => crypto.randomUUID()), [failure, setFailure] = useState('');
  const value = (draft: { maxRunning: string; maxRunsPerDay: string; enforced: boolean }): InstallationShare => ({ maxRunning: whole(draft.maxRunning), maxRunsPerDay: whole(draft.maxRunsPerDay), enforced: draft.enforced });
  const widens = (after: InstallationShare) => wider(policy.value.maxRunning, after.maxRunning) || wider(policy.value.maxRunsPerDay, after.maxRunsPerDay) || !policy.value.enforced && after.enforced;
  const form = useForm({ defaultValues: { maxRunning: policy.value.maxRunning === null ? '' : String(policy.value.maxRunning), maxRunsPerDay: policy.value.maxRunsPerDay === null ? '' : String(policy.value.maxRunsPerDay), enforced: policy.value.enforced, confirmation: '' },
    onSubmit: async ({ value: draft }) => {
      setFailure('');
      const after = value(draft);
      try { await savePolicy('runner-shares', policy.version, operationId, after, widens(after) ? draft.confirmation : ''); done('The installation runner share was saved. It applies to the next claim and the next run.'); }
      catch (cause) { setFailure(message(cause)); }
    } });
  return <form className="credential-form-content" aria-label="Edit installation runner share" onSubmit={event => { event.preventDefault(); void form.handleSubmit(); }}>
    <h3>Installation runner share</h3>
    <form.Field name="maxRunning" validators={{ onChange: ({ value }) => wholeError(value) }}>{field => <label>Running jobs for each organization and personal repository<input inputMode="numeric" value={field.state.value} onChange={event => field.handleChange(event.target.value)} placeholder="No limit" />
      <span className="field-help">1 to 1000; empty for no limit.</span>{field.state.meta.errors.length ? <span className="error" role="alert">{field.state.meta.errors.join(' ')}</span> : null}</label>}</form.Field>
    <form.Field name="maxRunsPerDay" validators={{ onChange: ({ value }) => wholeError(value) }}>{field => <label>Runs a day for each organization and personal repository<input inputMode="numeric" value={field.state.value} onChange={event => field.handleChange(event.target.value)} placeholder="No limit" />
      <span className="field-help">1 to 100,000 a UTC day; empty for no limit. A run over it is recorded as refused, with the reason.</span>{field.state.meta.errors.length ? <span className="error" role="alert">{field.state.meta.errors.join(' ')}</span> : null}</label>}</form.Field>
    <form.Field name="enforced">{field => <label className="checkbox-field"><input type="checkbox" checked={field.state.value} onChange={event => field.handleChange(event.target.checked)} />Enforce: organizations and repositories cannot set their own</label>}</form.Field>
    <dl className="settings-profile settings-policy-effect"><div><dt>Queued work</dt><dd>{policy.effect.queued}</dd></div><div><dt>In flight</dt><dd>{policy.effect.inFlight}</dd></div><div><dt>New work</dt><dd>{policy.effect.new}</dd></div></dl>
    <form.Subscribe selector={state => state.values}>{draft => !wholeError(draft.maxRunning) && !wholeError(draft.maxRunsPerDay) && widens(value(draft)) ? <form.Field name="confirmation">{field => <label>Type <code>{policy.confirmation}</code> to widen the runner share
      <input autoComplete="off" spellCheck={false} value={field.state.value} onChange={event => field.handleChange(event.target.value)} /><span className="field-help">Widening also needs an Access sign-in from the last 10 minutes.</span></label>}</form.Field> : null}</form.Subscribe>
    {failure ? <p className="error" role="alert">{failure}{recentSignIn(failure)}</p> : null}
    <form.Subscribe selector={state => [state.isSubmitting, state.canSubmit] as const}>{([submitting, canSubmit]) => <div className="credential-actions">
      <button className="button primary" disabled={submitting || !canSubmit}>{submitting ? 'Saving…' : 'Save'}</button>
      <button type="button" className="button secondary" disabled={submitting} onClick={close}>Cancel</button></div>}</form.Subscribe>
  </form>;
}

// ---------- organization and repository settings ----------
export type ShareTarget = { organization: string } | { repository: { owner: string; name: string }; repositoryId: string };
type ShareRequest = { id: string; field: 'maxRunning' | 'maxRunsPerDay'; label: string; current: number; requested: number; reason: string; state: string; requestedAt: string; requestedBy: string; mine: boolean; decisionNote: string };
export type ShareView = { scope: 'organization' | 'repository'; name: string; allocated: boolean; reason?: string; schema: string; own: ShareValue; ceiling: ShareValue; limit: ShareValue; granted: ShareValue | null;
  installation: InstallationShare; parent: { scope: 'organization' | 'installation'; name: string }; version: string; updatedAt: string;
  usage: { running: number; queued: number; held: number; runsToday: number; parentRunning: number | null }; canEdit: boolean; canRequest: boolean; editReason: string; requests: ShareRequest[] };
const fieldLabels = { maxRunning: 'Running jobs', maxRunsPerDay: 'Runs a day' } as const;
const requestStates: Record<string, [string, string]> = { PENDING: ['Pending', 'configured'], APPROVED: ['Approved', 'configured'], APPLIED: ['Applied', 'available'], DECLINED: ['Declined', ''], WITHDRAWN: ['Withdrawn', ''], FAILED: ['Failed', 'refused'] };

export function RunnerSharePanel({ target, userId }: { target: ShareTarget; userId: string }) {
  const query = useQuery({ ...privateQuery, queryKey: ['runner-share', userId, JSON.stringify(target)], retry: false,
    queryFn: ({ signal }) => nativeAPI<ShareView>('/native/capacity/shares/read', { action: 'read', ...target }, signal) });
  const [editing, setEditing] = useState(false), [requesting, setRequesting] = useState(false), [notice, setNotice] = useState(''), [error, setError] = useState('');
  if (query.error) return <PanelError error={query.error} retry={() => void query.refetch()} />;
  const view = query.data;
  if (!view) return <Loading label="Reading the runner share…" />;
  const done = (text: string) => { setEditing(false); setRequesting(false); setNotice(text); void query.refetch(); };
  const withdraw = async (id: string) => {
    setError(''); setNotice('');
    try { await nativeAPI('/native/capacity/shares', { action: 'withdraw', ...target, id }); done('Your request was withdrawn.'); } catch (cause) { setError(message(cause)); }
  };
  const parent = view.parent.scope === 'organization' ? `the organization ${view.parent.name}` : 'the installation';
  const requestColumns: DataTableColumn<ShareRequest>[] = [
    { id: 'setting', header: 'Share', accessorFn: item => item.label, cell: ({ row: { original: item } }) => <span className="capacity-name">{item.label}<small>{item.reason}</small></span> },
    { id: 'change', header: 'Current → requested', accessorFn: item => item.requested, sortFn: 'basic', cell: ({ row: { original: item } }) => `${item.current} → ${item.requested}` },
    { id: 'by', header: 'Requested by', accessorFn: item => item.requestedBy, cell: ({ row: { original: item } }) => <span className="capacity-name">{item.requestedBy}<small><DateLabel value={item.requestedAt} relative /></small></span> },
    { id: 'state', header: 'State', accessorFn: item => item.state, cell: ({ row: { original: item } }) => <span className="capacity-name"><span className={`visibility ${requestStates[item.state]?.[1] || ''}`}>{requestStates[item.state]?.[0] || item.state}</span>{item.decisionNote ? <small>{item.decisionNote}</small> : null}</span> },
    { id: 'actions', header: 'Actions', enableSorting: false, enableGlobalFilter: false, cell: ({ row: { original: item } }) => item.mine && ['PENDING', 'APPROVED'].includes(item.state)
      ? <button type="button" className="button secondary" aria-label={`Withdraw request for ${item.label.toLowerCase()}`} onClick={() => void withdraw(item.id)}>Withdraw</button> : null },
  ];
  return <section className="browser-panel" aria-labelledby="runner-share-title"><div className="browser-panel-heading"><h2 id="runner-share-title">Runner share</h2>
    {view.allocated && view.canEdit && !editing ? <button type="button" className="button secondary" onClick={() => { setEditing(true); setRequesting(false); setNotice(''); }}><Pencil size={15} />Edit</button> : null}
    {view.allocated && view.canRequest && !requesting ? <button type="button" className="button secondary" onClick={() => { setRequesting(true); setEditing(false); setNotice(''); }}><Plus size={15} />Request more</button> : null}</div>
    {!view.allocated ? <p className="panel-footnote">{view.reason}</p> : <>
      <p className="field-help">{view.scope === 'organization' ? 'How much self-hosted runner capacity all of this organization’s repositories may use together.' : 'How much self-hosted runner capacity this repository may use.'} A job over the share stays queued while runners take other work; a run over the daily share is recorded as refused.</p>
      {notice ? <p className="field-help" role="status">{notice}</p> : null}
      {error ? <p className="error" role="alert">{error}</p> : null}
      <dl className="settings-profile" aria-label="Current runner share">
        <div><dt>Applies now</dt><dd>{limitText(view.limit.maxRunning, 'running jobs')} · {limitText(view.limit.maxRunsPerDay, 'runs a day (UTC)')}</dd></div>
        <div><dt>Own value</dt><dd>{view.own.maxRunning === null && view.own.maxRunsPerDay === null ? `None: ${parent}’s applies` : `${view.own.maxRunning ?? 'inherited'} running jobs · ${view.own.maxRunsPerDay ?? 'inherited'} runs a day`}</dd></div>
        <div><dt>Inherited limit</dt><dd>{limitText(view.ceiling.maxRunning, 'running jobs')} · {limitText(view.ceiling.maxRunsPerDay, 'runs a day')}, from {parent}{view.granted && (view.granted.maxRunning !== null || view.granted.maxRunsPerDay !== null) ? ', including a grant from the installation' : ''}</dd></div>
        <div><dt>In use</dt><dd>{view.usage.running} running · {view.usage.queued} queued{view.usage.held ? ` (${view.usage.held} held by the share)` : ''} · {view.usage.runsToday} runs started today</dd></div>
      </dl>
      {!view.canEdit && view.editReason ? <p className="panel-footnote">{view.editReason}</p> : null}
      {editing ? <ShareForm view={view} target={target} close={() => setEditing(false)} done={done} /> : null}
      {requesting ? <ShareRequestForm view={view} target={target} close={() => setRequesting(false)} done={done} /> : null}
      {view.scope === 'organization' && view.requests.length ? <DataTable data={view.requests} columns={requestColumns} getRowId={item => item.id} label="runner share requests" pagination={false} /> : null}
    </>}
  </section>;
}

function ShareForm({ view, target, close, done }: { view: ShareView; target: ShareTarget; close: () => void; done: (text: string) => void }) {
  const [failure, setFailure] = useState('');
  const atMost = (field: 'maxRunning' | 'maxRunsPerDay') => (text: string) => wholeError(text) || (whole(text) !== null && view.ceiling[field] !== null && whole(text)! > view.ceiling[field]! ? `At most ${view.ceiling[field]}, the inherited limit.` : undefined);
  const form = useForm({ defaultValues: { maxRunning: view.own.maxRunning === null ? '' : String(view.own.maxRunning), maxRunsPerDay: view.own.maxRunsPerDay === null ? '' : String(view.own.maxRunsPerDay) },
    onSubmit: async ({ value }) => {
      setFailure('');
      try { await nativeAPI('/native/capacity/shares', { action: 'set', ...target, maxRunning: whole(value.maxRunning), maxRunsPerDay: whole(value.maxRunsPerDay), expectedVersion: view.version }); done('The runner share was saved. It applies to the next claim and the next run.'); }
      catch (cause) { setFailure(message(cause)); }
    } });
  return <form className="credential-form-content" aria-label="Edit runner share" onSubmit={event => { event.preventDefault(); void form.handleSubmit(); }}>
    <h3>Edit runner share</h3>
    {(['maxRunning', 'maxRunsPerDay'] as const).map(name => <form.Field key={name} name={name} validators={{ onChange: ({ value }) => atMost(name)(value) }}>{field => <label>{fieldLabels[name]}<input inputMode="numeric" value={field.state.value} onChange={event => field.handleChange(event.target.value)} placeholder="Inherit" />
      <span className="field-help">Empty to inherit; at most {view.ceiling[name] ?? 'the bound'}{view.ceiling[name] === null ? '' : ', the inherited limit'}.</span>{field.state.meta.errors.length ? <span className="error" role="alert">{field.state.meta.errors.join(' ')}</span> : null}</label>}</form.Field>)}
    {failure ? <p className="error" role="alert">{failure}</p> : null}
    <form.Subscribe selector={state => [state.isSubmitting, state.canSubmit] as const}>{([submitting, canSubmit]) => <div className="credential-actions">
      <button className="button primary" disabled={submitting || !canSubmit}>{submitting ? 'Saving…' : 'Save share'}</button>
      <button type="button" className="button secondary" disabled={submitting} onClick={close}>Cancel</button></div>}</form.Subscribe>
  </form>;
}

function ShareRequestForm({ view, target, close, done }: { view: ShareView; target: ShareTarget; close: () => void; done: (text: string) => void }) {
  const [failure, setFailure] = useState('');
  const choices = (['maxRunning', 'maxRunsPerDay'] as const).filter(field => view.ceiling[field] !== null);
  const form = useForm({ defaultValues: { field: choices[0] as 'maxRunning' | 'maxRunsPerDay', value: '', reason: '' },
    onSubmit: async ({ value }) => {
      setFailure('');
      try { await nativeAPI('/native/capacity/shares', { action: 'request', ...target, field: value.field, value: Number(value.value), reason: value.reason.trim() }); done('Your request was recorded. An installation administrator approves or declines it.'); }
      catch (cause) { setFailure(message(cause)); }
    } });
  return <form className="credential-form-content" aria-label="Request a higher runner share" onSubmit={event => { event.preventDefault(); void form.handleSubmit(); }}>
    <h3>Request a higher runner share</h3>
    <form.Field name="field">{field => <label>Share<select value={field.state.value} onChange={event => field.handleChange(event.target.value as 'maxRunning' | 'maxRunsPerDay')}>{choices.map(name => <option key={name} value={name}>{fieldLabels[name]} (now up to {view.ceiling[name]})</option>)}</select></label>}</form.Field>
    <form.Field name="value" validators={{ onChange: ({ value }) => /^[1-9][0-9]{0,5}$/.test(value.trim()) ? undefined : 'Enter a whole number.' }}>{field => <label>Requested value<input type="number" inputMode="numeric" min={1} required value={field.state.value} onChange={event => field.handleChange(event.target.value)} />
      {field.state.meta.errors.length ? <span className="error" role="alert">{field.state.meta.errors.join(' ')}</span> : null}</label>}</form.Field>
    <form.Field name="reason">{field => <label>Why<textarea rows={3} maxLength={500} required value={field.state.value} onChange={event => field.handleChange(event.target.value)} placeholder="Release week: more parallel test jobs" /></label>}</form.Field>
    <p className="field-help">An operations administrator other than you decides. No cost is estimated: self-hosted runner machines are not billed through Cloudflare.</p>
    {failure ? <p className="error" role="alert">{failure}</p> : null}
    <form.Subscribe selector={state => [state.isSubmitting, state.canSubmit] as const}>{([submitting, canSubmit]) => <div className="credential-actions">
      <button className="button primary" disabled={submitting || !canSubmit}>{submitting ? 'Requesting…' : 'Request'}</button>
      <button type="button" className="button secondary" disabled={submitting} onClick={close}>Cancel</button></div>}</form.Subscribe>
  </form>;
}
