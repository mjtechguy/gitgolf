import { useEffect, useState } from 'react';
import { useForm } from '@tanstack/react-form';
import { useQuery } from '@tanstack/react-query';
import { CopyButton, Loading, PanelError, privateQuery } from './RepositoryUI';
import { useRepositorySettingsAccess } from './useRepositorySettingsAccess';
import { DataTable } from './DataTable';
import type { DataTableColumn } from './DataTable';
import { nativeAPI } from './NativeForge';

type Pool = { id: string; name: string; version: number; state: 'ACTIVE' | 'DRAINING'; trust_class: 'UNTRUSTED' | 'TRUSTED'; max_parallel: number; image_id: string };
type Machine = { id: string; pool_id: string; name: string; protocol: 'native' | 'gitlab'; version: number; state: 'ACTIVE' | 'DRAINING' | 'QUARANTINED' | 'REVOKED'; expires_at: number; last_seen_at: string | null; active_job_id: string | null; cleanup_state: 'CONFIRMED' | 'UNKNOWN' };
type Inventory = { pools: Pool[]; machines: Machine[]; truncated: boolean };
type Placement = { repository_id: number; pool_id: string | null; pool_version: number | null; version: number };
const message = (error: unknown) => error instanceof Error ? error.message : 'The runner operation could not be confirmed.';

function PoolEditor({ pool, busy, save, close }: { pool?: Pool; busy: boolean; save: (value: { name: string; state: Pool['state']; trustClass: Pool['trust_class']; maxParallel: number }) => Promise<void>; close: () => void }) {
  const form = useForm({ defaultValues: { name: pool?.name || '', state: pool?.state || 'ACTIVE' as Pool['state'], trustClass: pool?.trust_class || 'UNTRUSTED' as Pool['trust_class'], maxParallel: pool?.max_parallel || 1 }, onSubmit: async ({ value }) => save(value) });
  return <form className="credential-form-content" onSubmit={event => { event.preventDefault(); void form.handleSubmit(); }}>
    <h3>{pool ? `Edit ${pool.name}` : 'New runner pool'}</h3><p className="field-help">Untrusted pools can run approved PR code. Trusted pools are reserved from PR placement.</p>
    <form.Field name="name">{field => <label>Pool name<input required maxLength={80} disabled={busy} value={field.state.value} onChange={event => field.handleChange(event.target.value)} /></label>}</form.Field>
    <form.Field name="state">{field => <label>Admission<select disabled={busy} value={field.state.value} onChange={event => field.handleChange(event.target.value as Pool['state'])}><option value="ACTIVE">Active</option><option value="DRAINING">Draining</option></select></label>}</form.Field>
    <form.Field name="trustClass">{field => <label>Trust class<select disabled={busy} value={field.state.value} onChange={event => field.handleChange(event.target.value as Pool['trust_class'])}><option value="UNTRUSTED">Untrusted PR code</option><option value="TRUSTED">Trusted only</option></select></label>}</form.Field>
    <form.Field name="maxParallel">{field => <label>Maximum parallel jobs<input type="number" min={1} max={20} required disabled={busy} value={field.state.value} onChange={event => field.handleChange(Number(event.target.value))} /></label>}</form.Field>
    <div className="credential-actions"><button className="button primary" disabled={busy}>Save pool</button><button type="button" className="button secondary" disabled={busy} onClick={close}>Cancel</button></div>
  </form>;
}

function MachineEditor({ pool, busy, enroll, close }: { pool: Pool; busy: boolean; enroll: (name: string, ttlHours: number, protocol: Machine['protocol']) => Promise<void>; close: () => void }) {
  const form = useForm({ defaultValues: { name: '', ttlHours: 4, protocol: 'native' as Machine['protocol'], trustExecution: false }, onSubmit: async ({ value }) => { if (value.trustExecution) await enroll(value.name, value.ttlHours, value.protocol); } });
  return <form className="credential-form-content" onSubmit={event => { event.preventDefault(); void form.handleSubmit(); }}>
    <h3>Enroll machine in {pool.name}</h3><p className="field-help">The one-time credential gives this host access to approved source and jobs until expiry. Keep it in a private host secret store.</p>
    <form.Field name="name">{field => <label>Machine name<input required maxLength={80} disabled={busy} value={field.state.value} onChange={event => field.handleChange(event.target.value)} /></label>}</form.Field>
    <form.Field name="protocol">{field => <label>Runner protocol<select disabled={busy} value={field.state.value} onChange={event => field.handleChange(event.target.value as Machine['protocol'])}><option value="native">Golf native supervisor</option><option value="gitlab">Stock GitLab Runner 18.5.0</option></select></label>}</form.Field>
    <form.Field name="ttlHours">{field => <label>Credential lifetime in hours<input type="number" min={1} max={24} required disabled={busy} value={field.state.value} onChange={event => field.handleChange(Number(event.target.value))} /></label>}</form.Field>
    <form.Field name="trustExecution">{field => <label><input type="checkbox" required disabled={busy} checked={field.state.value} onChange={event => field.handleChange(event.target.checked)} /> I trust this host to isolate customer jobs and report cleanup honestly.</label>}</form.Field>
    <div className="credential-actions"><button className="button primary" disabled={busy}>Enroll machine</button><button type="button" className="button secondary" disabled={busy} onClick={close}>Cancel</button></div>
  </form>;
}

export function NativeRunnerAdmin() {
  const inventory = useQuery({ ...privateQuery, queryKey: ['native-runner-inventory'], queryFn: ({ signal }) => nativeAPI<Inventory>('/native/runner-admin', { action: 'list' }, signal), refetchInterval: 15000 });
  const [pool, setPool] = useState<Pool | 'new'>();
  const [newPoolId, setNewPoolId] = useState('');
  const [enrollment, setEnrollment] = useState<Pool>();
  const [newMachineId, setNewMachineId] = useState('');
  const [reconcile, setReconcile] = useState<Machine>();
  const [credential, setCredential] = useState<{ machine: string; value: string }>();
  const [busy, setBusy] = useState(false), [error, setError] = useState<unknown>();
  useEffect(() => { const clear = () => setCredential(undefined); window.addEventListener('pagehide', clear); return () => window.removeEventListener('pagehide', clear); }, []);
  async function mutate<T>(body: object, done?: (value: T) => void): Promise<boolean> {
    setBusy(true); setError(undefined);
    try { const value = await nativeAPI<T>('/native/runner-admin', body); done?.(value); await inventory.refetch(); return true; }
    catch (cause) { setError(cause); await inventory.refetch(); return false; }
    finally { setBusy(false); }
  }
  const pools: DataTableColumn<Pool>[] = [
    { accessorKey: 'name', header: 'Pool' }, { accessorKey: 'trust_class', header: 'Trust' }, { accessorKey: 'state', header: 'Admission' },
    { accessorKey: 'max_parallel', header: 'Capacity' }, { id: 'machines', header: 'Machines', accessorFn: p => inventory.data?.machines.filter(m => m.pool_id === p.id).length || 0 },
    { id: 'actions', header: 'Actions', enableSorting: false, cell: ({ row }) => <div className="credential-actions"><button className="button secondary" disabled={busy} onClick={() => setPool(row.original)}>Edit</button><button className="button secondary" disabled={busy || row.original.state !== 'ACTIVE'} onClick={() => { setNewMachineId(crypto.randomUUID()); setEnrollment(row.original); }}>Enroll host</button></div> },
  ];
  const machines: DataTableColumn<Machine>[] = [
    { accessorKey: 'name', header: 'Host' }, { id: 'pool', header: 'Pool', accessorFn: m => inventory.data?.pools.find(p => p.id === m.pool_id)?.name || m.pool_id },
    { accessorKey: 'protocol', header: 'Protocol' },
    { accessorKey: 'state', header: 'State' }, { accessorKey: 'cleanup_state', header: 'Cleanup' },
    { id: 'lease', header: 'Current job', accessorFn: m => m.active_job_id || 'Idle' },
    { id: 'expiry', header: 'Credential expiry', accessorFn: m => new Date(m.expires_at).toLocaleString() },
    { id: 'actions', header: 'Actions', enableSorting: false, cell: ({ row }) => { const m = row.original; return <div className="credential-actions">
      <button className="button secondary" disabled={busy || m.state === 'REVOKED' || !!m.active_job_id || m.cleanup_state !== 'CONFIRMED'} onClick={() => void mutate<{ credential: string }>({ action: 'rotate', id: m.id, expectedVersion: m.version, ttlHours: 4 }, value => setCredential({ machine: m.name, value: value.credential }))}>Rotate 4h</button>
      {m.state === 'ACTIVE' ? <button className="button secondary" disabled={busy} onClick={() => void mutate({ action: 'control', id: m.id, expectedVersion: m.version, state: 'DRAINING' })}>Drain</button> : m.state === 'DRAINING' && m.cleanup_state === 'CONFIRMED' ? <button className="button secondary" disabled={busy} onClick={() => void mutate({ action: 'control', id: m.id, expectedVersion: m.version, state: 'ACTIVE' })}>Activate</button> : null}
      {m.state !== 'REVOKED' && <button className="button secondary" disabled={busy} onClick={() => void mutate({ action: 'control', id: m.id, expectedVersion: m.version, state: 'REVOKED' })}>Revoke</button>}
      {m.cleanup_state === 'UNKNOWN' && m.active_job_id && ['QUARANTINED','REVOKED'].includes(m.state) && <button className="button secondary" disabled={busy} onClick={() => setReconcile(m)}>Reconcile cleanup</button>}
    </div>; } },
  ];
  return <section className="page-stack"><header className="repository-intro"><div><h2>Native runner pools</h2><p>Customer hosts poll outbound for approved PR jobs. A host must have the approved image installed and a private state directory.</p></div></header>
    {error ? <p className="error" role="alert">{message(error)} Refresh inventory and inspect the original operation before retrying.</p> : null}
    {credential && <section className="browser-panel"><h3>One-time credential for {credential.machine}</h3><p className="field-help">Store it on the host now. Closing this panel removes it from the page.</p><code>{credential.value}</code><div className="credential-actions"><CopyButton text={credential.value} label="Copy runner credential" /><button className="button secondary" onClick={() => setCredential(undefined)}>Close credential</button></div></section>}
    <section className="browser-panel"><div className="browser-panel-heading"><h3>Pools</h3><button className="button primary" disabled={busy || !!inventory.data?.truncated} onClick={() => { setNewPoolId(crypto.randomUUID()); setPool('new'); }}>New pool</button><button className="button secondary" disabled={inventory.isFetching || busy} onClick={() => void inventory.refetch()}>Refresh</button></div>
      {inventory.error && <p className="error" role="alert">{message(inventory.error)}</p>}{inventory.isSuccess && <DataTable data={inventory.data.pools} columns={pools} getRowId={p => p.id} label="native runner pools" />}</section>
    {pool && <PoolEditor key={pool === 'new' ? newPoolId : pool.id + '/' + pool.version} pool={pool === 'new' ? undefined : pool} busy={busy} close={() => setPool(undefined)} save={async value => { if (await mutate({ action: 'savePool', id: pool === 'new' ? newPoolId : pool.id, expectedVersion: pool === 'new' ? 0 : pool.version, ...value })) setPool(undefined); }} />}
    {enrollment && <MachineEditor key={newMachineId} pool={enrollment} busy={busy} close={() => setEnrollment(undefined)} enroll={async (name, ttlHours, protocol) => { if (await mutate<{ credential: string }>({ action: protocol === 'gitlab' ? 'enrollGitLab' : 'enroll', id: newMachineId, poolId: enrollment.id, poolVersion: enrollment.version, name, ttlHours, trustExecution: true }, value => setCredential({ machine: name, value: value.credential }))) setEnrollment(undefined); }} />}
    <section className="browser-panel"><div className="browser-panel-heading"><h3>Machines</h3></div>{inventory.isSuccess && <DataTable data={inventory.data.machines} columns={machines} getRowId={m => m.id} label="native runner machines" />}{inventory.data?.truncated && <p className="field-help">Inventory limit reached. Inspect the full inventory through the API before adding hosts.</p>}</section>
    {reconcile && <form className="credential-form-content" onSubmit={event => { event.preventDefault(); void mutate({ action: 'reconcile', id: reconcile.id, expectedVersion: reconcile.version, jobId: reconcile.active_job_id, cleanupConfirmed: true }).then(ok => { if (ok) setReconcile(undefined); }); }}><h3>Confirm physical cleanup of {reconcile.name}</h3><p>Verify all containers, volumes and local source files for job <code>{reconcile.active_job_id}</code> are gone before clearing quarantine.</p><label><input type="checkbox" required disabled={busy} /> I inspected the exact host and confirmed cleanup.</label><div className="credential-actions"><button className="button primary" disabled={busy}>Confirm cleanup</button><button type="button" className="button secondary" disabled={busy} onClick={() => setReconcile(undefined)}>Cancel</button></div></form>}
  </section>;
}

// Settings → Runners on the native runtime: the repository chooses one of the workspace's runner pools.
export function NativeRepositoryRunners({ userId, owner, name, signingOut }: { userId: string; owner: string; name: string; signingOut: boolean }) {
  const { access, error, refresh } = useRepositorySettingsAccess(userId, owner, name, signingOut);
  return <section className="page-stack"><header className="repository-intro"><div><h1>Runners</h1><p>Choose the runner pool that runs this repository's approved pull request jobs. Workspace administrators enroll machines and manage pools.</p></div></header>
    {error ? <PanelError error={error} retry={refresh} /> : !access ? <Loading label="Verifying repository access…" /> : signingOut ? null : <NativeRunnerPlacement key={access.repositoryId} context={{ repository: { owner, name }, repositoryId: access.repositoryId }} />}
  </section>;
}

export function NativeRunnerPlacement({ context }: { context: { repository: { owner: string; name: string }; repositoryId: string } }) {
  const [editing, setEditing] = useState(false);
  const inventory = useQuery({ ...privateQuery, queryKey: ['native-runner-placement', context.repositoryId], queryFn: ({ signal }) => nativeAPI<{ placement: Placement; pools: Pool[]; canEdit: boolean }>('/native/runner-placement', { ...context, action: 'get' }, signal), refetchInterval: editing ? false : 30000 });
  const [busy, setBusy] = useState(false), [error, setError] = useState<unknown>();
  // A background refetch keeps the last observation and the open editor; the server fences the version on save.
  const current = inventory.isSuccess ? inventory.data : undefined;
  async function save(choice: string) {
    if (!current) return;
    const pool = current.pools.find(p => p.id === choice);
    setBusy(true); setError(undefined);
    try { await nativeAPI('/native/runner-placement', { ...context, action: 'set', expectedVersion: current.placement.version, poolId: pool?.id || null, poolVersion: pool?.version || null }); setEditing(false); await inventory.refetch(); }
    catch (cause) { setError(cause); setEditing(false); await inventory.refetch(); }
    finally { setBusy(false); }
  }
  return <section className="browser-panel"><div className="browser-panel-heading"><h3>Pull request runner</h3><button className="button secondary" disabled={busy || inventory.isFetching} onClick={() => void inventory.refetch()}>Refresh</button></div>
    {inventory.error && <p className="error" role="alert">{message(inventory.error)}</p>}{error ? <p className="error" role="alert">{message(error)} Inspect the refreshed placement before another edit.</p> : null}
    {current && <div className="credential-form-content"><dl className="settings-profile"><div><dt>Current runner</dt><dd>{current.pools.find(p => p.id === current.placement.pool_id)?.name || (current.placement.pool_id ? 'Unavailable pool' : 'Managed Cloudflare Container')}</dd></div></dl>
      {current.canEdit && (editing ? <PlacementEditor key={current.placement.version} placement={current.placement} pools={current.pools} busy={busy || inventory.isFetching} save={save} close={() => setEditing(false)}/> : <button className="button secondary" disabled={inventory.isFetching} onClick={() => setEditing(true)}>Change runner</button>)}</div>}
    {inventory.isFetching ? <p className="panel-footnote" role="status">Checking runner settings…</p> : null}
  </section>;
}

function PlacementEditor({ placement, pools, busy, save, close }: { placement: Placement; pools: Pool[]; busy: boolean; save: (choice: string) => Promise<void>; close: () => void }) {
  const form = useForm({ defaultValues: { poolId: placement.pool_id || '' }, onSubmit: ({ value }) => save(value.poolId) });
  return <form onSubmit={event => { event.preventDefault(); void form.handleSubmit(); }}>
    <form.Field name="poolId">{field => <label>Runner pool<select value={field.state.value} disabled={busy} onChange={event => field.handleChange(event.target.value)}><option value="">Managed Cloudflare Container</option>{pools.map(pool => <option key={pool.id} value={pool.id} disabled={pool.state !== 'ACTIVE'}>{pool.name} · {pool.state.toLowerCase()} · capacity {pool.max_parallel}</option>)}</select></label>}</form.Field>
    <p className="field-help">Changing the runner stops queued jobs until they are admitted again.</p><div className="credential-actions"><form.Subscribe selector={state => state.values.poolId}>{choice => <button className="button primary" disabled={busy || choice === (placement.pool_id || '')}>Save runner</button>}</form.Subscribe><button type="button" className="button secondary" disabled={busy} onClick={close}>Cancel</button></div>
  </form>;
}
