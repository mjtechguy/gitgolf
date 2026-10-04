import { useEffect, useRef, useState } from 'react';
import { useForm } from '@tanstack/react-form';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Code, ConnectError, type Client } from '@connectrpc/connect';
import { LoaderCircle, Pause, Play, RefreshCw, ShieldOff, X } from 'lucide-react';
import { RunnerControlState, type EnrolledRunner, type RunnerControlService, type User } from './gen/golf/v1/golf_pb';
import { DataTable, type DataTableColumn } from './DataTable';
import { DateLabel, Loading, PanelError, privateQuery } from './RepositoryUI';
import { forgetPrivateQueries } from './queryClient';

type RunnerClient = Client<typeof RunnerControlService>;
type Context = { userId: string; signingOut: boolean; revalidating: boolean; client: RunnerClient };
const states = [RunnerControlState.ACTIVE, RunnerControlState.DRAINING, RunnerControlState.REVOKED];
const stateName = (state: RunnerControlState) => ({ [RunnerControlState.ACTIVE]: 'Active', [RunnerControlState.DRAINING]: 'Draining', [RunnerControlState.REVOKED]: 'Revoked' })[state as RunnerControlState.ACTIVE | RunnerControlState.DRAINING | RunnerControlState.REVOKED] ?? 'Unknown';
const nativeId = (value: string) => /^[1-9][0-9]{0,18}$/.test(value) && BigInt(value) <= 9223372036854775807n;
const workflow = (value: string) => value === '.gitlab-ci.yml' || value.length <= 255 && /^\.github\/workflows\/[A-Za-z0-9_.-]+\.ya?ml$/.test(value) && !value.includes('..');
const version = (value: string) => /^(0|[1-9][0-9]{0,18})$/.test(value) && BigInt(value) <= 9223372036854775807n;
export function validRunnerInventory(rows: EnrolledRunner[]) {
  return rows.length <= 100 && new Set(rows.map(row => row.workerId)).size === rows.length && rows.every(row => /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(row.workerId) && states.includes(row.state) && version(row.version) && (row.lastSeen === undefined || Number.isFinite(Date.parse(row.lastSeen))) && (!row.recentConnection || row.lastSeen !== undefined) && !(row.state === RunnerControlState.REVOKED && row.hasActiveAttempt));
}
const denial = (error: unknown) => error instanceof ConnectError && [Code.Unauthenticated, Code.PermissionDenied, Code.NotFound].includes(error.code);
function columns(action?: (row: EnrolledRunner) => React.ReactNode): DataTableColumn<EnrolledRunner>[] {
  const result: DataTableColumn<EnrolledRunner>[] = [
    { accessorKey: 'workerId', header: 'Worker' },
    { id: 'state', accessorFn: row => stateName(row.state), header: 'Control', cell: ({ row }) => <span className="status-pill">{stateName(row.original.state)}</span> },
    { id: 'connection', accessorFn: row => row.recentConnection ? 'Recent' : 'Not recent', header: 'Connection', cell: ({ row }) => <span>{row.original.recentConnection ? 'Recent connection' : 'No recent connection'}</span> },
    { id: 'attempt', accessorFn: row => row.hasActiveAttempt ? 'Assigned' : 'None observed', header: 'Attempt' },
    { id: 'seen', accessorFn: row => row.lastSeen ?? '', header: 'Last seen', cell: ({ row }) => row.original.lastSeen ? <DateLabel value={row.original.lastSeen} /> : <span className="muted">Not observed</span> },
  ];
  if (action) result.push({ id: 'actions', header: 'Actions', enableSorting: false, cell: ({ row }) => action(row.original) });
  return result;
}
function ControlConfirmation({ row, state, pending, onConfirm, onCancel }: { row: EnrolledRunner; state: RunnerControlState; pending: boolean; onConfirm: (password: string) => void; onCancel: () => void }) {
  const password = useRef<HTMLInputElement>(null);
  const form = useForm({ defaultValues: { password: '' }, validators: { onSubmit: ({ value }) => value.password ? undefined : 'Enter your current Golf password.' }, onSubmit: ({ value }) => { onConfirm(value.password); form.reset(); } });
  useEffect(() => { password.current?.focus(); }, []);
  return <form aria-label="Confirm runner control" onSubmit={event => { event.preventDefault(); void form.handleSubmit(); }}>
    <div className="browser-panel-heading"><h3>{stateName(state)} {row.workerId}</h3><button type="button" className="icon-button" aria-label="Close runner confirmation" disabled={pending} onClick={onCancel}><X size={16} /></button></div>
    <p className="field-help">{state === RunnerControlState.REVOKED ? 'Revocation cancels active attempts and fences source and results. This identity cannot be resumed. An operator must enroll a new worker identity and key. Daemon cleanup remains independently observed.' : state === RunnerControlState.DRAINING ? 'Stop new assignments. Existing attempts may continue to heartbeat, fetch source, log and finish.' : 'Allow new assignments again, subject to current repository policy and execution requirements.'}</p>
    <form.Field name="password">{field => <><label htmlFor="runner-control-password">Current Golf password</label><input id="runner-control-password" ref={password} type="password" autoComplete="current-password" value={field.state.value} disabled={pending} onChange={event => field.handleChange(event.target.value)} /></>}</form.Field>
    <form.Subscribe selector={state => state.errors}>{errors => errors.length ? <p className="error" role="alert">{errors.join(' ')}</p> : null}</form.Subscribe>
    <div className="credential-actions"><button className={`button ${state === RunnerControlState.REVOKED ? 'session-danger' : 'primary'}`} disabled={pending}>{pending && <LoaderCircle className="spin" size={15} />}Confirm {stateName(state).toLowerCase()}</button><button type="button" className="button secondary" disabled={pending} onClick={onCancel}>Cancel</button></div>
  </form>;
}
export function InstanceRunnerControls({ userId, signingOut, revalidating, client }: Context) {
  const queries = useQueryClient(); const queryKey = ['instance-runner-controls', userId];
  const [blocked, setBlocked] = useState(false); const [deniedMessage, setDeniedMessage] = useState(''); const [intent, setIntent] = useState<{ row: EnrolledRunner; state: RunnerControlState } | null>(null);
  const [pending, setPending] = useState(false); const [notice, setNotice] = useState(''); const [uncertain, setUncertain] = useState(false);
  const controller = useRef<AbortController | null>(null); const busy = useRef(false); const mounted = useRef(true); const current = useRef({ userId, signingOut, revalidating }); current.current = { userId, signingOut, revalidating };
  const enabled = nativeId(userId) && !blocked && !signingOut && !revalidating;
  useEffect(() => { setBlocked(false); setDeniedMessage(''); setIntent(null); setNotice(''); setUncertain(false); setPending(false); controller.current?.abort(); }, [userId]);
  function clear(error: unknown) {
    if (!denial(error)) return;
    setBlocked(true); setDeniedMessage(error instanceof ConnectError && error.code === Code.Unauthenticated ? 'Sign in again to inspect runner controls.' : 'Runner controls are unavailable with your current administrator access.'); setIntent(null); setNotice(''); controller.current?.abort(); void queries.cancelQueries({ queryKey }); queries.removeQueries({ queryKey });
    if (error instanceof ConnectError && error.code === Code.Unauthenticated) { queries.setQueryData(['session'], null); forgetPrivateQueries(queries); }
  }
  const query = useQuery({ ...privateQuery, queryKey, enabled, queryFn: async ({ signal }) => { const response = await client.getInstanceRunners({}, { signal, timeoutMs: 15_000 }); signal.throwIfAborted(); if (!validRunnerInventory(response.runners)) throw new ConnectError('Worker observations are incomplete.', Code.Internal); return response; } });
  useEffect(() => { clear(query.error); }, [query.error]);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; controller.current?.abort(); void queries.cancelQueries({ queryKey }); queries.removeQueries({ queryKey }); }; }, [userId, queries]);
  useEffect(() => { if (!enabled || query.error || query.isFetching) { if (busy.current) setUncertain(true); setIntent(null); controller.current?.abort(); } }, [enabled, query.error, query.isFetching]);
  const visible = enabled && query.isSuccess && !query.error && !query.isFetching;
  const active = (owner: string) => mounted.current && current.current.userId === owner && !current.current.signingOut && !current.current.revalidating && queries.getQueryData<User | null>(['session'])?.id === owner;
  async function confirm(password: string) {
    if (!intent || !visible || busy.current || uncertain) return;
    const frozen = intent; const owner = userId; const control = new AbortController(); controller.current = control; busy.current = true; setPending(true); setNotice('');
    try {
      const response = await client.updateRunnerControl({ workerId: frozen.row.workerId, expectedVersion: frozen.row.version, state: frozen.state, currentPassword: password }, { signal: control.signal, timeoutMs: 15_000 }); control.signal.throwIfAborted();
      if (!response.runner || !validRunnerInventory([response.runner]) || response.runner.workerId !== frozen.row.workerId || response.runner.state !== frozen.state || response.runner.version !== String(BigInt(frozen.row.version) + 1n)) throw new ConnectError('Control acknowledgement could not be verified. Inspect current controls.', Code.Internal);
      if (active(owner)) { setIntent(null); setNotice('Control change recorded. Refreshing current observations.'); setUncertain(false); }
    } catch (error) {
      if (active(owner)) { clear(error); setIntent(null); setUncertain(true); if (!denial(error)) setNotice('The control result could not be confirmed. Inspect current controls before another action.'); }
    } finally {
      busy.current = false;
      if (mounted.current && current.current.userId === owner) setPending(false);
      if (active(owner)) void queries.invalidateQueries({ queryKey });
    }
  }
  async function inspect() { if (busy.current) return; setIntent(null); const result = await query.refetch(); if (!result.error && result.data && enabled) { setUncertain(false); setNotice('Current control observed; this does not attribute an earlier unconfirmed change.'); } }
  const actionColumns = columns(row => <div className="table-actions">{row.state !== RunnerControlState.REVOKED ? <><button type="button" className="icon-button" aria-label={`${row.state === RunnerControlState.ACTIVE ? 'Drain' : 'Resume'} ${row.workerId}`} title={row.state === RunnerControlState.ACTIVE ? 'Drain worker' : 'Resume worker'} disabled={pending || uncertain} onClick={() => setIntent({ row, state: row.state === RunnerControlState.ACTIVE ? RunnerControlState.DRAINING : RunnerControlState.ACTIVE })}>{row.state === RunnerControlState.ACTIVE ? <Pause size={16} /> : <Play size={16} />}</button><button type="button" className="icon-button" aria-label={`Revoke ${row.workerId}`} title="Revoke worker permanently" disabled={pending || uncertain} onClick={() => setIntent({ row, state: RunnerControlState.REVOKED })}><ShieldOff size={16} /></button></> : <span className="muted">New operator identity required</span>}</div>);
  return <section className="browser-panel" aria-labelledby="instance-runner-controls-heading"><div className="browser-panel-heading"><h2 id="instance-runner-controls-heading">Docker workers</h2><button className="icon-button" type="button" aria-label="Inspect current runner controls" title="Inspect current controls" disabled={!enabled || pending || query.isFetching} onClick={() => void inspect()}><RefreshCw size={16} /></button></div>
    <p className="field-help">Operator-enrolled identities. Recent connection activity is not execution health or capacity.</p>
    {query.isPending && enabled && <Loading label="Loading workers…" />}{blocked && <p className="error" role="alert">{deniedMessage}</p>}{query.error && !blocked && <PanelError error={query.error} retry={() => void query.refetch()} />}{visible && <DataTable data={query.data!.runners} columns={actionColumns} getRowId={row => row.workerId} label="Docker workers" emptyMessage="No Docker workers are enrolled." />}
    {notice && !blocked && <p role="status" className="field-help">{notice}</p>}{intent && visible && <ControlConfirmation row={intent.row} state={intent.state} pending={pending} onConfirm={password => void confirm(password)} onCancel={() => setIntent(null)} />}
  </section>;
}
export function RepositoryRunners({ userId, signingOut, revalidating, client, owner, name, repositoryId, ownerId, workflowPath }: Context & { owner: string; name: string; repositoryId: string; ownerId: string; workflowPath: string }) {
  const queries = useQueryClient(); const queryKey = ['repository-runners', userId, owner, name, repositoryId, ownerId, workflowPath]; const [blocked, setBlocked] = useState(false);
  const enabled = nativeId(userId) && nativeId(repositoryId) && nativeId(ownerId) && workflow(workflowPath) && !blocked && !signingOut && !revalidating;
  useEffect(() => { setBlocked(false); }, [userId, owner, name, repositoryId, ownerId, workflowPath]);
  const query = useQuery({ ...privateQuery, queryKey, enabled, queryFn: async ({ signal }) => { const response = await client.getRepositoryRunners({ repository: { owner, name }, repositoryId, ownerId, workflowPath }, { signal, timeoutMs: 15_000 }); signal.throwIfAborted(); if (response.repositoryId !== repositoryId || response.ownerId !== ownerId || response.workflowPath !== workflowPath || response.repository?.owner.toLowerCase() !== owner.toLowerCase() || response.repository.name.toLowerCase() !== name.toLowerCase() || !validRunnerInventory(response.runners)) throw new ConnectError('Repository worker observations changed.', Code.Internal); return response; } });
  useEffect(() => { if (denial(query.error)) { setBlocked(true); void queries.cancelQueries({ queryKey }); queries.removeQueries({ queryKey }); if (query.error instanceof ConnectError && query.error.code === Code.Unauthenticated) { queries.setQueryData(['session'], null); forgetPrivateQueries(queries); } } }, [query.error]);
  useEffect(() => () => { void queries.cancelQueries({ queryKey }); queries.removeQueries({ queryKey }); }, [queries, userId, repositoryId, ownerId, owner, name, workflowPath]);
  const visible = enabled && query.isSuccess && !query.isFetching && !query.error;
  return <section className="browser-panel" aria-labelledby="repository-runners-heading"><div className="browser-panel-heading"><h2 id="repository-runners-heading">Docker workers</h2><button type="button" className="icon-button" aria-label="Refresh repository runners" disabled={!enabled || query.isFetching} onClick={() => void query.refetch()}><RefreshCw size={16} /></button></div>{!workflowPath && <p className="field-help">Select a workflow to inspect its current policy ceilings.</p>}{query.isPending && enabled && <Loading label="Loading workers…" />}{blocked && <p className="error" role="alert">Repository runner controls are unavailable with your current access.</p>}{query.error && !blocked && <PanelError error={query.error} retry={() => void query.refetch()} />}{visible && <><dl className="settings-profile"><div><dt>Workflow</dt><dd><code>{workflowPath}</code></dd></div><div><dt>Manual policy</dt><dd>{query.data!.manualAllowed ? 'Allowed by policy' : 'Blocked by policy'}</dd></div><div><dt>Push policy</dt><dd>{query.data!.pushAllowed ? 'Allowed by policy' : 'Blocked by policy'}</dd></div></dl><DataTable data={query.data!.runners} columns={columns()} getRowId={row => row.workerId} label="Repository Docker workers" emptyMessage="No Docker workers are enrolled." /><p className="field-help">Policy and worker observations do not grant execution or confirm engine, image, source approval or cleanup availability.</p></>}</section>;
}
