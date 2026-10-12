import { useEffect, useRef, useState } from 'react';
import { useForm } from '@tanstack/react-form';
import { useInfiniteQuery } from '@tanstack/react-query';
import { Code, ConnectError } from '@connectrpc/connect';
import { infrastructureConnectionClient as client } from './api';
import { DataTable, type DataTableColumn } from './DataTable';
import { Loading, More, PanelError, privateQuery } from './RepositoryUI';
import { isRunID } from './navigation';
import { decimal } from './deploymentReads';
import type { CloudflareEnvironmentResources as Resources, InfrastructureConnection, RepositoryEnvironment } from './gen/golf/v1/golf_pb';

type Intent = { operationId: string; environmentVersion: string; connectionId: string; connectionVersion: string };
function savedIntent(key: string): { intent: Intent | null; corrupt: boolean } {
  try {
    const raw = sessionStorage.getItem(key); if (raw === null) return { intent: null, corrupt: false };
    if (raw.length > 1024) throw Error(); const i = JSON.parse(raw) as Intent;
    if (Object.keys(i).sort().join(',') !== 'connectionId,connectionVersion,environmentVersion,operationId' || !isRunID(i.operationId) || !isRunID(i.connectionId) || !decimal(i.connectionVersion) || !decimal(i.environmentVersion)) throw Error();
    return { intent: i, corrupt: false };
  } catch { return { intent: null, corrupt: true }; }
}
function ResourceEditor({ connections, removal, pending, submit, cancel }: { connections: InfrastructureConnection[]; removal: Resources | null; pending: boolean; submit: (connectionId: string, password: string) => void; cancel: () => void }) {
  const form = useForm({ defaultValues: { connectionId: connections.length === 1 ? connections[0]!.id : '', password: '' }, validators: { onSubmit: ({ value }) => !value.password || !removal && !value.connectionId ? 'Select an account and confirm your Golf administrator password.' : undefined }, onSubmit: ({ value }) => { const password = value.password; form.setFieldValue('password', ''); submit(value.connectionId, password); } });
  const first = useRef<HTMLInputElement>(null);
  useEffect(() => { first.current?.focus(); const clear = () => form.reset(); window.addEventListener('pagehide', clear); return () => { form.reset(); window.removeEventListener('pagehide', clear); }; }, []);
  return <form className="credential-form-content" aria-label={removal ? 'Remove Cloudflare resources' : 'Allocate Cloudflare resources'} onSubmit={event => { event.preventDefault(); if (!pending) void form.handleSubmit(); }}>
    {removal ? <p>Remove the acknowledged D1 database and empty R2 bucket from operation <code>{removal.operationId}</code>. Other resources and configuration history are retained.</p> : <><p>Create one empty D1 database and one private R2 bucket. This action allocates storage; application deployment and protected previews remain separate.</p><form.Field name="connectionId">{field => <><label htmlFor="cf-resource-connection">Cloudflare account</label><select id="cf-resource-connection" disabled={pending} value={field.state.value} onChange={event => field.handleChange(event.target.value)}><option value="">Select a saved account</option>{connections.map(c => <option key={c.id} value={c.id}>{c.label} · version {c.version} · {c.cloudflareAccountId}</option>)}</select></>}</form.Field></>}
    <form.Field name="password">{field => <><label htmlFor="cf-resource-password">Golf administrator password</label><input ref={first} id="cf-resource-password" type="password" autoComplete="current-password" disabled={pending} value={field.state.value} onChange={event => field.handleChange(event.target.value)} /></>}</form.Field>
    <form.Subscribe selector={state => state.errors}>{errors => errors.length ? <p className="error" role="alert">{errors.join(' ')}</p> : null}</form.Subscribe><div className="credential-actions"><button type="submit" className={removal ? 'button session-danger' : 'button primary'} disabled={pending}>{pending ? 'Checking…' : removal ? 'Remove owned resources' : 'Allocate D1 and R2'}</button><button type="button" className="button secondary" disabled={pending} onClick={cancel}>Cancel</button></div>
  </form>;
}

export function CloudflareEnvironmentResources({ userId, environment, active, close }: { userId: string; environment: RepositoryEnvironment; active: () => boolean; close: () => void }) {
  const key = `golf.cloudflare-resource.v1:${userId}:${environment.target!.repositoryId}:${environment.id}`;
  const initial = useRef<ReturnType<typeof savedIntent> | null>(null); initial.current ||= savedIntent(key);
  const [intent, setIntent] = useState(initial.current.intent), [editing, setEditing] = useState(false), [removal, setRemoval] = useState<Resources | null>(null), [pending, setPending] = useState(false), [failure, setFailure] = useState(''), [notice, setNotice] = useState(''), [denied, setDenied] = useState(false), [missing, setMissing] = useState(false);
  const alive = useRef(true), busy = useRef(false), abort = useRef<AbortController | null>(null), current = useRef(active); current.current = active;
  const available = () => alive.current && current.current() && !denied;
  useEffect(() => { alive.current = true; const hide = () => { abort.current?.abort(); setEditing(false); setRemoval(null); setFailure(''); setNotice(''); }; window.addEventListener('pagehide', hide); return () => { alive.current = false; abort.current?.abort(); window.removeEventListener('pagehide', hide); }; }, []);
  const profiles = useInfiniteQuery({ ...privateQuery, queryKey: ['infrastructure-connections', userId], initialPageParam: 1, enabled: available(), queryFn: ({ pageParam, signal }) => client.listInfrastructureConnections({ page: { page: pageParam, limit: 20 } }, { signal, timeoutMs: 8000 }), getNextPageParam: page => page.page?.nextPage || undefined });
  const inventory = useInfiniteQuery({ ...privateQuery, queryKey: ['cloudflare-resources', userId, environment.target!.repositoryId, environment.id], initialPageParam: 1, enabled: available(), queryFn: async ({ pageParam, signal }) => {
    const response = await client.listCloudflareEnvironmentResources({ target: environment.target, environmentId: environment.id, page: { page: pageParam, limit: 20 } }, { signal, timeoutMs: 15000 }); signal.throwIfAborted(); response.resources.forEach(r => verify(r)); return response;
  }, getNextPageParam: page => page.page?.nextPage || undefined });
  const visible = available() && profiles.isSuccess && inventory.isSuccess && !profiles.error && !inventory.error && !profiles.isFetching && !inventory.isFetching;
  const connections = visible ? profiles.data.pages.flatMap(p => p.connections).filter(p => p.kind === 'CLOUDFLARE') : [];
  const rows = visible ? inventory.data.pages.flatMap(p => p.resources) : [];
  const blocked = pending || !visible || Boolean(intent) || initial.current.corrupt;
  function verify(r?: Resources, i?: Intent) {
    const target = environment.target!;
    if (!r || !isRunID(r.operationId) || r.environmentId !== environment.id || r.target?.repositoryId !== target.repositoryId || r.target.ownerId !== target.ownerId || r.actorId !== userId || !isRunID(r.connectionId) || !decimal(r.connectionVersion) || !decimal(r.environmentVersion) || !/^[a-f0-9]{32}$/.test(r.accountId) || !['PREFLIGHT', 'PROVISIONING', 'READY', 'REFUSED', 'UNKNOWN', 'REMOVING', 'REMOVED'].includes(r.state) || r.d1Name !== `golf-env-${r.operationId.replaceAll('-', '')}` || r.r2Bucket !== r.d1Name || i && (r.operationId !== i.operationId || r.environmentVersion !== i.environmentVersion || r.connectionId !== i.connectionId || r.connectionVersion !== i.connectionVersion)) throw new ConnectError('The original Cloudflare resource receipt could not be verified.', Code.Internal);
    return r;
  }
  async function refresh() { if (busy.current || !available()) return; setEditing(false); setRemoval(null); setFailure(''); setNotice(''); await Promise.all([profiles.refetch(), inventory.refetch()]); }
  async function dispatch(connectionId: string, password: string) {
    if (busy.current || blocked || !available()) return;
    const connection = connections.find(c => c.id === connectionId); if (!removal && !connection) return;
    const i: Intent = removal ? { operationId: removal.operationId, environmentVersion: removal.environmentVersion, connectionId: removal.connectionId, connectionVersion: removal.connectionVersion } : { operationId: crypto.randomUUID(), environmentVersion: environment.version, connectionId: connection!.id, connectionVersion: connection!.version };
    const attempt = new AbortController(); abort.current = attempt; busy.current = true; setPending(true); setFailure(''); setNotice(''); setMissing(false);
    try {
      sessionStorage.setItem(key, JSON.stringify(i)); setIntent(i);
      const response = removal ? await client.removeCloudflareEnvironmentResources({ operationId: i.operationId, passwordConfirmation: password }, { signal: attempt.signal, timeoutMs: 30000 }) : await client.provisionCloudflareEnvironmentResources({ ...i, environmentId: environment.id, target: environment.target, passwordConfirmation: password }, { signal: attempt.signal, timeoutMs: 30000 }); attempt.signal.throwIfAborted(); const result = verify(response.resources, i);
      if (!available()) return; sessionStorage.removeItem(key); setIntent(null); setEditing(false); setRemoval(null); await inventory.refetch(); if (available()) setNotice(result.state === 'READY' ? 'Empty D1 and R2 resources allocated. Application deployment and protected previews remain unavailable.' : `Original operation: ${result.state}. ${result.reason.replaceAll('_', ' ')}`);
    } catch (e) { if (available()) { setFailure(e instanceof Error ? e.message : 'Inspect the original operation before another change.'); setEditing(false); setRemoval(null); if (e instanceof ConnectError && [Code.PermissionDenied, Code.Unauthenticated].includes(e.code)) setDenied(true); } }
    finally { busy.current = false; if (alive.current) setPending(false); if (abort.current === attempt) abort.current = null; }
  }
  async function inspect() {
    if (!intent || busy.current || !available()) return; busy.current = true; setPending(true); setFailure(''); const attempt = new AbortController(); abort.current = attempt;
    try { const r = await client.getCloudflareEnvironmentResources({ operationId: intent.operationId }, { signal: attempt.signal, timeoutMs: 15000 }); attempt.signal.throwIfAborted(); const result = verify(r.resources, intent); if (available()) { sessionStorage.removeItem(key); setIntent(null); await inventory.refetch(); setNotice(`Original operation: ${result.state}. No creation was retried.`); } }
    catch (e) { if (available()) {
      if (e instanceof ConnectError && e.code === Code.NotFound) {
        // A fresh authorized inventory permits explicitly dropping an absent
        // tab intent. The server's live environment fence still prevents a
        // delayed original request from creating a second resource pair.
        const checked = await inventory.refetch(); attempt.signal.throwIfAborted();
        if (available() && checked.isSuccess && !checked.error) { setMissing(true); setFailure('The original operation is absent from your current private allocation records. No creation was retried.'); }
      } else { setFailure(e instanceof Error ? e.message : 'Original operation unavailable.'); if (e instanceof ConnectError && [Code.PermissionDenied, Code.Unauthenticated].includes(e.code)) setDenied(true); }
    } }
    finally { busy.current = false; if (alive.current) setPending(false); if (abort.current === attempt) abort.current = null; }
  }
  const columns: DataTableColumn<Resources>[] = [
    { accessorKey: 'operationId', header: 'Operation' }, { accessorKey: 'environmentVersion', header: 'Environment version' }, { accessorKey: 'state', header: 'Allocation' },
    { id: 'resources', header: 'Storage', cell: ({ row }) => <details><summary>D1: {row.original.d1State} · R2: {row.original.r2State}</summary><p><code>{row.original.d1Name}</code></p>{row.original.d1Id ? <p>D1 ID: <code>{row.original.d1Id}</code></p> : null}<p>Account: <code>{row.original.accountId}</code> · connection version {row.original.connectionVersion}</p>{row.original.reason ? <p>{row.original.reason.replaceAll('_', ' ')}</p> : null}</details> },
    { id: 'actions', header: 'Actions', enableSorting: false, cell: ({ row }) => ['READY', 'UNKNOWN', 'REMOVING'].includes(row.original.state) ? <button className="button secondary" disabled={blocked} onClick={() => { setNotice(''); setEditing(true); setRemoval(row.original); }}>Remove resources</button> : null },
  ];
  return <section className="browser-panel credential-list-panel" aria-labelledby="cf-environment-title"><div className="browser-panel-heading"><h3 id="cf-environment-title">Cloudflare storage · {environment.name}</h3><div className="credential-actions"><button className="button secondary" disabled={blocked || rows.some(r => !['REFUSED', 'REMOVED'].includes(r.state)) || connections.length === 0} onClick={() => { setNotice(''); setEditing(true); setRemoval(null); }}>New resource allocation</button><button className="button secondary" disabled={pending} onClick={() => void refresh()}>Refresh resources</button><button className="button secondary" disabled={pending} onClick={close}>Close resources</button></div></div><p className="field-help">Operator-managed storage only. Each allocation is bound to this repository owner, environment version and Cloudflare account. At most one unresolved allocation belongs to this environment. Preview deployment, DNS and Access are separate gates.</p>
    {denied ? <p className="error" role="alert">Current administrator or repository authority is unavailable. Private resource data is hidden.</p> : profiles.error || inventory.error ? <PanelError error={profiles.error || inventory.error!} retry={() => void refresh()} /> : !visible ? <Loading label="Checking Cloudflare resources" /> : <><DataTable data={rows} columns={columns} getRowId={r => r.operationId} label="Cloudflare environment resources" emptyMessage="No Cloudflare resources allocated" /><p className="field-help">Search and sorting cover loaded allocations. Account selection covers loaded profiles.</p><More hasMore={Boolean(profiles.hasNextPage)} loading={profiles.isFetchingNextPage || pending} load={() => void profiles.fetchNextPage()} label="Load more account profiles" /><More hasMore={Boolean(inventory.hasNextPage)} loading={inventory.isFetchingNextPage || pending} load={() => void inventory.fetchNextPage()} label="Load more allocations" />{connections.length === 0 ? <p className="field-help">Add a Cloudflare account in Instance settings → Infrastructure connections.</p> : null}{editing && !intent ? <ResourceEditor connections={connections} removal={removal} pending={pending} cancel={() => { setEditing(false); setRemoval(null); }} submit={(id, password) => void dispatch(id, password)} /> : null}</>}
    {intent && available() ? <div className="credential-uncertain"><h4>Inspect original resource operation</h4><p>No automatic retry was sent. Operation: <code>{intent.operationId}</code></p><button className="button secondary" disabled={pending} onClick={() => void inspect()}>Inspect original allocation</button>{missing && visible ? <button className="button secondary" disabled={pending} onClick={() => { try { sessionStorage.removeItem(key); setIntent(null); setMissing(false); setFailure(''); setNotice('Absent tab intent cleared. Start a new allocation explicitly if needed.'); } catch { setFailure('The saved tab intent could not be cleared.'); } }}>Clear absent tab intent</button> : null}</div> : null}{initial.current.corrupt ? <p className="error" role="alert">Saved operation metadata is unreadable. New allocations are blocked until this browser session is inspected.</p> : null}{failure && available() ? <p className="error" role="alert">{failure}</p> : null}{notice && visible ? <p className="notice" role="status">{notice}</p> : null}
  </section>;
}
