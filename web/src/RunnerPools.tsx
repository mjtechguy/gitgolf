import { useEffect, useId, useRef, useState } from 'react';
import { useForm } from '@tanstack/react-form';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Code, ConnectError, type Client } from '@connectrpc/connect';
import { Pencil, Plus, RefreshCw, X } from 'lucide-react';
import { RunnerPoolService, RunnerPoolState, type GetRepositoryRunnerPlacementResponse, type ListRunnerPoolsResponse, type RepositoryRunnerPlacement as Placement, type RunnerPool, type SaveRunnerPoolRequest } from './gen/golf/v1/golf_pb';
import { DataTable, type DataTableColumn } from './DataTable';
import { DateLabel, Loading, PanelError, privateQuery } from './RepositoryUI';
import { forgetPrivateQueries } from './queryClient';

type PoolClient = Client<typeof RunnerPoolService>;
type Context = { client: PoolClient; userId: string; signingOut: boolean; revalidating: boolean };
type RepositoryContext = Context & { owner: string; name: string; repositoryId: string; ownerId: string; accessRevision: string };
const decimal = (v: string, positive = false) => (positive ? /^[1-9][0-9]{0,18}$/ : /^(0|[1-9][0-9]{0,18})$/).test(v) && BigInt(v) <= 9223372036854775807n;
const uuid = (v: string) => /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(v);
const worker = (v: string) => /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(v);
const revision = (v: string) => /^[a-f0-9]{64}$/.test(v);
const time = (v: string) => v.length <= 40 && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/.test(v) && Number.isFinite(Date.parse(v));
const poolName = (v: string) => v !== '' && v.trim() === v && new TextEncoder().encode(v).length <= 128 && !/[\p{Cc}]/u.test(v);
const stateName = (v: RunnerPoolState) => v === RunnerPoolState.ACTIVE ? 'Active' : 'Draining';
const denied = (e: unknown) => [Code.Unauthenticated, Code.PermissionDenied, Code.NotFound].includes(ConnectError.from(e).code);
const members = (v: string[]) => v.length <= 100 && new Set(v).size === v.length && v.every(worker);
function validPool(p: RunnerPool) {
  return uuid(p.id) && poolName(p.name) && decimal(p.version, true) && p.runtime === 'local-docker' && [RunnerPoolState.ACTIVE, RunnerPoolState.DRAINING].includes(p.state)
    && Number.isInteger(p.maxParallelAttempts) && p.maxParallelAttempts >= 1 && p.maxParallelAttempts <= 100 && members(p.workerIds) && (p.state !== RunnerPoolState.ACTIVE || p.workerIds.length > 0)
    && time(p.createdAt) && time(p.updatedAt) && Date.parse(p.updatedAt) >= Date.parse(p.createdAt) && (p.activeAttemptCount === undefined || decimal(p.activeAttemptCount));
}
function validPools(pools: RunnerPool[]) {
  return pools.length <= 20 && new Set(pools.map(p => p.id)).size === pools.length && new Set(pools.map(p => p.name)).size === pools.length && pools.every(validPool)
    && new Set(pools.flatMap(p => p.workerIds)).size === pools.reduce((n, p) => n + p.workerIds.length, 0);
}
export function validRunnerPools(response: ListRunnerPoolsResponse) {
  return members(response.enrolledWorkerIds) && validPools(response.pools) && response.pools.every(p => p.activeAttemptCount !== undefined);
}
function validPlacement(p: Placement | undefined, target: RepositoryContext) {
  return Boolean(p && p.repository?.owner === target.owner && p.repository.name === target.name && p.repositoryId === target.repositoryId && p.ownerId === target.ownerId
    && p.accessRevision === target.accessRevision && decimal(p.version) && (p.legacyUnbound ? p.poolId === '' && p.poolVersion === '' : uuid(p.poolId) && decimal(p.poolVersion, true) && p.version !== '0'));
}
export function validRepositoryRunnerPlacement(response: GetRepositoryRunnerPlacementResponse, target: RepositoryContext) {
  const p = response.placement, selected = response.selectedPool;
  if (!validPlacement(p, target) || !validPools(response.eligiblePools) || response.eligiblePools.some(pool => !pool.repositoryAssignmentEnabled || pool.activeAttemptCount !== undefined)) return false;
  if (p!.legacyUnbound) return selected === undefined;
  if (!selected || !validPool(selected) || selected.id !== p!.poolId || selected.activeAttemptCount !== undefined || BigInt(selected.version) < BigInt(p!.poolVersion)) return false;
  const eligible = response.eligiblePools.find(pool => pool.id === selected.id);
  return selected.repositoryAssignmentEnabled ? Boolean(eligible && equivalentPool(eligible, selected)) : !eligible;
}
function equivalentPool(a: RunnerPool, b: RunnerPool) {
  return a.id === b.id && a.name === b.name && a.version === b.version && a.runtime === b.runtime && a.state === b.state && a.maxParallelAttempts === b.maxParallelAttempts
    && a.repositoryAssignmentEnabled === b.repositoryAssignmentEnabled && a.createdAt === b.createdAt && a.updatedAt === b.updatedAt && [...a.workerIds].sort().join('\n') === [...b.workerIds].sort().join('\n');
}

// Local CAS mutations have no once-only publication receipt. Any unconfirmed
// result requires an explicit fresh read before another requested change.
function usePoolPanel<T>({ userId, signingOut, revalidating }: Context, scope: string, validTarget: boolean, load: (signal: AbortSignal) => Promise<T>) {
  const queries = useQueryClient();
  const queryKey = ['runner-pools', userId, scope];
  const [blockedScope, block] = useState('');
  const [pending, setPending] = useState(false);
  const [uncertain, setUncertain] = useState(false);
  const [notice, setNotice] = useState('');
  const enabled = validTarget && decimal(userId, true) && !signingOut && !revalidating && blockedScope !== scope;
  const controller = useRef<AbortController | null>(null);
  const busy = useRef(false);
  const mounted = useRef(true);
  const guard = useRef({ scope, enabled, epoch: 0 });
  if (guard.current.scope !== scope || guard.current.enabled !== enabled) guard.current = { scope, enabled, epoch: guard.current.epoch + 1 };
  const query = useQuery({ ...privateQuery, queryKey, enabled, refetchOnWindowFocus: false, refetchOnReconnect: false, queryFn: async ({ signal }) => { const result = await load(signal); signal.throwIfAborted(); return result; } });
  const live = (epoch: number) => mounted.current && guard.current.epoch === epoch && guard.current.scope === scope && guard.current.enabled;
  function clear(error: unknown) {
    if (!denied(error)) return;
    block(scope); controller.current?.abort(); void queries.cancelQueries({ queryKey }); queries.removeQueries({ queryKey });
    if (ConnectError.from(error).code === Code.Unauthenticated) { queries.setQueryData(['session'], null); forgetPrivateQueries(queries); }
  }
  useEffect(() => {
    mounted.current = true; controller.current?.abort(); controller.current = null; busy.current = false; setPending(false); setNotice(''); setUncertain(false);
    return () => { mounted.current = false; controller.current?.abort(); void queries.cancelQueries({ queryKey }); queries.removeQueries({ queryKey }); };
  }, [scope, queries]);
  useEffect(() => { clear(query.error); }, [query.error]);
  useEffect(() => { if (!enabled || query.isFetching || query.error) { if (busy.current) setUncertain(true); controller.current?.abort(); } if (!enabled) { void queries.cancelQueries({ queryKey }); queries.removeQueries({ queryKey }); } }, [enabled, query.isFetching, query.error]);
  const visible = enabled && query.isSuccess && !query.error && !query.isFetching;
  async function mutate(write: (signal: AbortSignal) => Promise<void>) {
    if (!visible || busy.current || uncertain) return;
    const epoch = guard.current.epoch, control = new AbortController();
    controller.current = control; busy.current = true; setPending(true); setNotice('');
    try {
      await write(control.signal); control.signal.throwIfAborted();
      if (live(epoch)) setNotice('Configuration change acknowledged. Refreshing current observations.');
    } catch (error) {
      if (live(epoch)) { clear(error); setUncertain(true); setNotice('The change could not be confirmed. Inspect current configuration before another action.'); }
    } finally {
      if (controller.current === control) { controller.current = null; busy.current = false; if (mounted.current) setPending(false); }
      if (live(epoch)) void queries.invalidateQueries({ queryKey });
    }
  }
  async function inspect() {
    if (!enabled || busy.current) return;
    const epoch = guard.current.epoch;
    const result = await query.refetch();
    if (live(epoch) && !result.error && result.data) { setUncertain(false); setNotice('Current configuration observed. This does not attribute an earlier unconfirmed change.'); }
  }
  return { query, visible, enabled, pending, uncertain, notice, blocked: blockedScope === scope, mutate, inspect };
}

type PoolValues = Pick<SaveRunnerPoolRequest, 'name' | 'runtime' | 'state' | 'maxParallelAttempts' | 'workerIds' | 'repositoryAssignmentEnabled'>;
function PoolEditor({ inventory, pool, pending, close, save }: { inventory: ListRunnerPoolsResponse; pool?: RunnerPool; pending: boolean; close: () => void; save: (values: PoolValues, password: string) => void }) {
  const passwordId = useId();
  const nameInput = useRef<HTMLInputElement>(null);
  const assignedElsewhere = new Set(inventory.pools.filter(p => p.id !== pool?.id).flatMap(p => p.workerIds));
  const workerIds = [...new Set([...inventory.enrolledWorkerIds, ...(pool?.workerIds ?? [])])].sort();
  const form = useForm({ defaultValues: { name: pool?.name ?? '', state: pool?.state ?? RunnerPoolState.ACTIVE, maxParallelAttempts: String(pool?.maxParallelAttempts ?? 1), workerIds: pool?.workerIds ?? [] as string[], repositoryAssignmentEnabled: pool?.repositoryAssignmentEnabled ?? false, password: '' },
    validators: { onSubmit: ({ value }) => !poolName(value.name) ? 'Use a trimmed pool name of up to 128 UTF-8 bytes.' : !/^(?:[1-9]|[1-9][0-9]|100)$/.test(value.maxParallelAttempts) ? 'Choose 1–100 parallel workflow attempts.' : !members(value.workerIds) || value.workerIds.some(id => !inventory.enrolledWorkerIds.includes(id) || assignedElsewhere.has(id)) ? 'Select unique enrolled workers that are not assigned to another pool.' : value.state === RunnerPoolState.ACTIVE && !value.workerIds.length ? 'An active pool needs at least one enrolled worker.' : !value.password ? 'Enter your current Golf password.' : undefined },
    onSubmit: ({ value }) => { save({ name: value.name, runtime: 'local-docker', state: value.state, maxParallelAttempts: Number(value.maxParallelAttempts), workerIds: [...value.workerIds].sort(), repositoryAssignmentEnabled: value.repositoryAssignmentEnabled }, value.password); form.reset(); } });
  useEffect(() => { nameInput.current?.focus(); }, []);
  const cancel = () => { if (form.state.isDirty && !window.confirm('Discard unsaved runner-pool changes?')) return; close(); };
  return <section className="browser-panel"><div className="browser-panel-heading"><h3>{pool ? 'Edit runner pool' : 'Add runner pool'}</h3><button type="button" className="icon-button" aria-label="Close pool editor" disabled={pending} onClick={cancel}><X size={16} /></button></div>
    <form className="credential-form-content" aria-label={pool ? 'Edit runner pool' : 'Add runner pool'} onSubmit={event => { event.preventDefault(); void form.handleSubmit(); }}>
      <form.Field name="name">{field => <label>Pool name<input ref={nameInput} value={field.state.value} disabled={pending} onChange={e => field.handleChange(e.target.value)} /></label>}</form.Field>
      <dl className="settings-profile"><div><dt>Runtime</dt><dd>Local Docker</dd></div>{pool && <div><dt>Current version</dt><dd>{pool.version}</dd></div>}</dl>
      <form.Field name="state">{field => <label>Pool control<select value={field.state.value} disabled={pending} onChange={e => field.handleChange(Number(e.target.value) as RunnerPoolState)}><option value={RunnerPoolState.ACTIVE}>Active</option><option value={RunnerPoolState.DRAINING}>Draining</option></select></label>}</form.Field>
      <form.Field name="maxParallelAttempts">{field => <label>Maximum parallel workflow attempts<input type="number" min="1" max="100" step="1" value={field.state.value} disabled={pending} onChange={e => field.handleChange(e.target.value)} /></label>}</form.Field>
      <form.Field name="workerIds">{field => <fieldset disabled={pending}><legend>Already enrolled Docker workers</legend>{workerIds.length ? workerIds.map(id => <label className="checkbox-field" key={id}><input type="checkbox" checked={field.state.value.includes(id)} disabled={assignedElsewhere.has(id) || !inventory.enrolledWorkerIds.includes(id) && !field.state.value.includes(id)} onChange={e => field.handleChange(e.target.checked ? [...field.state.value, id] : field.state.value.filter(v => v !== id))} />{id}{assignedElsewhere.has(id) ? ' · another pool' : !inventory.enrolledWorkerIds.includes(id) ? ' · no longer enrolled; remove explicitly' : ''}</label>) : <p className="field-help">No worker identities are currently enrolled. A draining empty pool can be saved.</p>}</fieldset>}</form.Field>
      <form.Field name="repositoryAssignmentEnabled">{field => <label className="checkbox-field"><input type="checkbox" checked={field.state.value} disabled={pending} onChange={e => field.handleChange(e.target.checked)} />Allow repository administrators to select this pool</label>}</form.Field>
      <p className="field-help">Every configuration edit changes its version. Queued runs with older pool pins need inspection and explicit new dispatch; running attempts may continue while draining. Assigning every worker to a pool can strand legacy unbound queued work. Parallel attempts are an admission ceiling, not measured CPU, memory or execution health.</p>
      <form.Field name="password">{field => <><label htmlFor={passwordId}>Current Golf password</label><input id={passwordId} type="password" autoComplete="current-password" value={field.state.value} disabled={pending} onChange={e => field.handleChange(e.target.value)} /></>}</form.Field>
      <form.Subscribe selector={s => s.errors}>{errors => errors.length ? <p className="error" role="alert">{errors.join(' ')}</p> : null}</form.Subscribe>
      <div className="credential-actions"><button type="submit" className="button primary" disabled={pending}>{pending ? 'Saving…' : 'Save pool'}</button><button type="button" className="button secondary" disabled={pending} onClick={cancel}>Cancel</button></div>
    </form></section>;
}
function PoolDetails({ pool }: { pool: RunnerPool }) {
  return <details><summary>Pool details</summary><dl className="settings-profile"><div><dt>Pool ID</dt><dd><code>{pool.id}</code></dd></div><div><dt>Version</dt><dd>{pool.version}</dd></div><div><dt>Workers</dt><dd>{pool.workerIds.length ? pool.workerIds.join(', ') : 'None assigned'}</dd></div><div><dt>Repository selection</dt><dd>{pool.repositoryAssignmentEnabled ? 'Opt-in enabled' : 'Disabled'}</dd></div><div><dt>Updated</dt><dd><DateLabel value={pool.updatedAt} /></dd></div></dl></details>;
}
export function InstanceRunnerPools(props: Context) {
  const scope = JSON.stringify(['instance', props.userId]);
  const panel = usePoolPanel(props, scope, true, async signal => { const r = await props.client.listRunnerPools({}, { signal, timeoutMs: 15_000 }); if (!validRunnerPools(r)) throw new ConnectError('Runner-pool observations could not be verified.', Code.Internal); return r; });
  const [editor, edit] = useState<{ pool?: RunnerPool; id: string } | null>(null);
  useEffect(() => { if (!panel.visible) edit(null); }, [panel.visible]);
  const inventory = panel.query.data;
  const unpooled = inventory?.enrolledWorkerIds.filter(id => !inventory.pools.some(p => p.workerIds.includes(id))).length ?? 0;
  const columns: DataTableColumn<RunnerPool>[] = [
    { accessorKey: 'name', header: 'Pool' }, { accessorKey: 'runtime', header: 'Runtime', cell: () => 'Local Docker' },
    { id: 'control', accessorFn: p => stateName(p.state), header: 'Control', cell: ({ row }) => <span className="status-pill">{stateName(row.original.state)}</span> },
    { accessorKey: 'maxParallelAttempts', header: 'Max parallel attempts' }, { accessorKey: 'activeAttemptCount', header: 'Running attempts' },
    { id: 'details', header: 'Details', enableSorting: false, enableGlobalFilter: false, cell: ({ row }) => <PoolDetails pool={row.original} /> },
    { id: 'edit', header: 'Actions', enableSorting: false, enableGlobalFilter: false, cell: ({ row }) => <button type="button" className="icon-button" aria-label={`Edit pool ${row.original.name}`} disabled={panel.pending || panel.uncertain || Boolean(editor)} onClick={() => edit({ pool: row.original, id: row.original.id })}><Pencil size={16} /></button> },
  ];
  function save(values: PoolValues, password: string) {
    if (!editor || !inventory || !panel.visible) return;
    const frozen = editor; edit(null);
    void panel.mutate(async signal => {
      const r = await props.client.saveRunnerPool({ id: frozen.id, expectedVersion: frozen.pool?.version ?? '0', ...values, currentPassword: password }, { signal, timeoutMs: 15_000 });
      const p = r.pool;
      if (!p || !validPool(p) || p.id !== frozen.id || p.version !== String(BigInt(frozen.pool?.version ?? '0') + 1n) || p.name !== values.name || p.runtime !== values.runtime || p.state !== values.state || p.maxParallelAttempts !== values.maxParallelAttempts || p.repositoryAssignmentEnabled !== values.repositoryAssignmentEnabled || [...p.workerIds].sort().join('\n') !== values.workerIds.join('\n') || frozen.pool && p.createdAt !== frozen.pool.createdAt) throw new ConnectError('The pool configuration acknowledgement could not be verified.', Code.Internal);
    });
  }
  return <div className="page-stack"><section className="browser-panel"><div className="browser-panel-heading"><h2>Runner pools</h2><div className="credential-actions"><button type="button" className="button secondary" disabled={!panel.visible || panel.pending || panel.uncertain || Boolean(editor) || (inventory?.pools.length ?? 20) >= 20} onClick={() => edit({ id: crypto.randomUUID() })}><Plus size={15} />Add pool</button><button type="button" className="icon-button" aria-label="Inspect current runner pools" disabled={!panel.enabled || panel.pending || panel.query.isFetching} onClick={() => void panel.inspect()}><RefreshCw size={16} /></button></div></div>
    <p className="field-help">Named pools select already enrolled local Docker workers. They do not enroll credentials or enable Kubernetes or Cloudflare execution.</p>
    {panel.query.isPending && panel.enabled && <Loading label="Loading runner pools…" />}{panel.blocked && <p className="error" role="alert">Runner pools are unavailable with your current administrator access.</p>}{panel.query.error && !panel.blocked && <PanelError error={panel.query.error} retry={() => void panel.inspect()} />}
    {panel.visible && inventory && <><DataTable label="Runner pools" data={inventory.pools} columns={columns} getRowId={p => p.id} emptyMessage="No named runner pools are configured." /><p className="field-help">{unpooled} currently enrolled workers are unpooled. Only unpooled workers can claim legacy unbound work. Counts are source observations, not verified capacity or health.</p>{inventory.enrolledWorkerIds.length > 0 && unpooled === 0 && <p className="field-help">All enrolled workers belong to pools. Legacy unbound queued work has no unpooled workers and may remain queued.</p>}</>}
    {panel.visible && panel.notice && <p className="field-help" role="status">{panel.notice}</p>}
    </section>{editor && panel.visible && inventory && <PoolEditor key={editor.id} pool={editor.pool} inventory={inventory} pending={panel.pending} close={() => edit(null)} save={save} />}</div>;
}

function PlacementEditor({ response, close, save }: { response: GetRepositoryRunnerPlacementResponse; close: () => void; save: (pool: RunnerPool | undefined, password: string) => void }) {
  const id = useId();
  const password = useRef<HTMLInputElement>(null);
  const form = useForm({ defaultValues: { poolId: response.placement!.poolId, password: '' }, validators: { onSubmit: ({ value }) => value.poolId && !response.eligiblePools.some(p => p.id === value.poolId && p.state === RunnerPoolState.ACTIVE) ? 'Choose an active opt-in pool or explicitly select legacy unbound placement.' : !value.password ? 'Enter your current Golf password.' : undefined }, onSubmit: ({ value }) => { save(response.eligiblePools.find(p => p.id === value.poolId), value.password); form.reset(); } });
  useEffect(() => { password.current?.focus(); }, []);
  const cancel = () => { if (form.state.isDirty && !window.confirm('Discard unsaved runner-placement changes?')) return; close(); };
  return <section className="browser-panel"><div className="browser-panel-heading"><h3>Edit runner placement</h3><button type="button" className="icon-button" aria-label="Close placement editor" onClick={cancel}><X size={16} /></button></div><form className="credential-form-content" aria-label="Edit runner placement" onSubmit={event => { event.preventDefault(); void form.handleSubmit(); }}>
    <form.Field name="poolId">{field => <label>Runner placement<select value={field.state.value} onChange={e => field.handleChange(e.target.value)}><option value="">Legacy unbound · unpooled workers only</option>{response.eligiblePools.map(p => <option key={p.id} value={p.id} disabled={p.state !== RunnerPoolState.ACTIVE}>{p.name} · {stateName(p.state)} · version {p.version}</option>)}{response.selectedPool && !response.eligiblePools.some(p => p.id === response.selectedPool!.id) && <option value={response.selectedPool.id} disabled>{response.selectedPool.name} · selection disabled</option>}</select></label>}</form.Field>
    <p className="field-help">Selection does not grant execution authority. The current repository, access, placement and selected pool versions are checked when saving. Changed placement or pool configuration makes old queued pins stale; inspect and explicitly dispatch new work. Existing running attempts continue subject to their execution fences.</p>
    <form.Field name="password">{field => <><label htmlFor={id}>Current Golf password</label><input id={id} ref={password} type="password" autoComplete="current-password" value={field.state.value} onChange={e => field.handleChange(e.target.value)} /></>}</form.Field>
    <form.Subscribe selector={s => s.errors}>{errors => errors.length ? <p className="error" role="alert">{errors.join(' ')}</p> : null}</form.Subscribe><div className="credential-actions"><button type="submit" className="button primary">Save placement</button><button type="button" className="button secondary" onClick={cancel}>Cancel</button></div>
    </form></section>;
}
export function RepositoryRunnerPlacement(props: RepositoryContext) {
  const { owner, name, repositoryId, ownerId, accessRevision } = props;
  const scope = JSON.stringify(['repository', props.userId, owner, name, repositoryId, ownerId, accessRevision]);
  const target = decimal(repositoryId, true) && decimal(ownerId, true) && revision(accessRevision) && owner !== '' && name !== '';
  const panel = usePoolPanel(props, scope, target, async signal => { const r = await props.client.getRepositoryRunnerPlacement({ repository: { owner, name }, repositoryId, ownerId, expectedRevision: accessRevision }, { signal, timeoutMs: 15_000 }); if (!validRepositoryRunnerPlacement(r, props)) throw new ConnectError('Repository runner-placement observations could not be verified.', Code.Internal); return r; });
  const [editor, edit] = useState<GetRepositoryRunnerPlacementResponse | null>(null);
  useEffect(() => { if (!panel.visible) edit(null); }, [panel.visible]);
  const response = panel.query.data, p = response?.placement;
  function save(pool: RunnerPool | undefined, password: string) {
    if (!editor || !panel.visible || !editor.canEdit || !editor.passwordConfirmationAvailable) return;
    const frozen = editor.placement!; edit(null);
    void panel.mutate(async signal => {
      const r = await props.client.setRepositoryRunnerPlacement({ repository: { owner, name }, repositoryId, ownerId, expectedRevision: accessRevision, expectedPlacementVersion: frozen.version, poolId: pool?.id ?? '', expectedPoolVersion: pool?.version ?? '', currentPassword: password }, { signal, timeoutMs: 15_000 });
      if (!validPlacement(r.placement, props) || r.placement!.version !== String(BigInt(frozen.version) + 1n) || r.placement!.poolId !== (pool?.id ?? '') || r.placement!.poolVersion !== (pool?.version ?? '') || r.placement!.legacyUnbound !== !pool) throw new ConnectError('The placement acknowledgement could not be verified.', Code.Internal);
    });
  }
  const selected = response?.selectedPool;
  const stale = p && selected && p.poolVersion !== selected.version;
  return <div className="page-stack"><section className="browser-panel"><div className="browser-panel-heading"><h2>Runner placement</h2><div className="credential-actions"><button type="button" className="icon-button" aria-label="Edit runner placement" disabled={!panel.visible || !response?.canEdit || !response.passwordConfirmationAvailable || panel.pending || panel.uncertain || Boolean(editor)} onClick={() => edit(response!)}><Pencil size={16} /></button><button type="button" className="icon-button" aria-label="Inspect current runner placement" disabled={!panel.enabled || panel.pending || panel.query.isFetching} onClick={() => void panel.inspect()}><RefreshCw size={16} /></button></div></div>
    {panel.query.isPending && panel.enabled && <Loading label="Loading runner placement…" />}{panel.blocked && <p className="error" role="alert">Runner placement is unavailable with your current repository administration access.</p>}{panel.query.error && !panel.blocked && <PanelError error={panel.query.error} retry={() => void panel.inspect()} />}
    {panel.visible && response && p && <><dl className="settings-profile"><div><dt>Placement</dt><dd>{p.legacyUnbound ? 'Legacy unbound · unpooled workers only' : selected!.name}</dd></div><div><dt>Placement version</dt><dd>{p.version}</dd></div>{selected && <><div><dt>Pool control</dt><dd>{stateName(selected.state)}{!selected.repositoryAssignmentEnabled ? ' · repository selection disabled' : ''}</dd></div><div><dt>Pool versions</dt><dd>Selected {p.poolVersion} · current {selected.version}</dd></div><div><dt>Max parallel attempts</dt><dd>{selected.maxParallelAttempts}</dd></div></>}</dl>{stale && <p className="field-help">The selected pool configuration has changed. Old queued pins require inspection and explicit new dispatch; this is not automatic reassignment.</p>}{selected && <PoolDetails pool={selected} />}
      <p className="field-help">Pool selection is not permission to execute. Legacy unbound work uses only unpooled workers. Current policy, source approval and execution fences still apply.</p>{(!response.canEdit || !response.passwordConfirmationAvailable) && <p className="field-help">Read-only observation. Changing placement requires current ordinary repository administration and local-password confirmation.</p>}
      <details><summary>Eligible pool observations</summary><DataTable label="Eligible runner pools" data={response.eligiblePools} getRowId={pool => pool.id} columns={[{ accessorKey: 'name', header: 'Pool' }, { id: 'control', accessorFn: pool => stateName(pool.state), header: 'Control' }, { accessorKey: 'version', header: 'Version' }, { accessorKey: 'maxParallelAttempts', header: 'Max parallel attempts' }]} emptyMessage="No pools have opted into repository selection." /><p className="field-help">Opt-in pools are visible to current repository administrators. Draining pools cannot be chosen for new placement. Labels, inventory presence and attempt ceilings do not enroll credentials or establish worker health.</p></details>
    </>}{panel.visible && panel.notice && <p className="field-help" role="status">{panel.notice}</p>}
    </section>{editor && panel.visible && <PlacementEditor response={editor} close={() => edit(null)} save={save} />}</div>;
}
