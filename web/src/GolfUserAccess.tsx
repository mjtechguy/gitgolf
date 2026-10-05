import { Code, ConnectError } from '@connectrpc/connect';
import { useEffect, useRef, useState } from 'react';
import { useForm } from '@tanstack/react-form';
import { useInfiniteQuery } from '@tanstack/react-query';
import { Ban, RefreshCw, UserRoundCheck } from 'lucide-react';
import { instanceAdminClient, errorMessage } from './api';
import { DataTable, type DataTableColumn } from './DataTable';
import { DateLabel, Loading, More, PanelError, privateQuery } from './RepositoryUI';
import type { GolfUserAccess as UserAccess, GolfUserAccessOperation } from './gen/golf/v1/golf_pb';

type AccessIntent = { user: UserAccess; suspended: boolean; operationId: string; reason: string };
function AccessEditor({ user, pending, onSubmit, onCancel }: { user: UserAccess; pending: boolean; onSubmit: (reason: string, password: string) => Promise<void>; onCancel: () => void }) {
  const first = useRef<HTMLTextAreaElement>(null);
  const form = useForm({ defaultValues: { reason: '', password: '' }, validators: { onSubmit: ({ value }) => !value.reason.trim() || new TextEncoder().encode(value.reason.trim()).length > 1024 ? 'Provide a reason of 1–1024 bytes.' : !value.password ? 'Confirm your Golf administrator password.' : undefined }, onSubmit: async ({ value }) => { const reason = value.reason.trim(); const password = value.password; form.reset(); await onSubmit(reason, password); } });
  useEffect(() => { first.current?.focus(); const clear = () => form.reset(); window.addEventListener('pagehide', clear); return () => { window.removeEventListener('pagehide', clear); form.reset(); }; }, [form]);
  return <form className="credential-form-content" aria-label={`${user.suspended ? 'Restore' : 'Suspend'} Golf access`} onSubmit={event => { event.preventDefault(); void form.handleSubmit(); }}>
    <h3>{user.suspended ? 'Restore' : 'Suspend'} Golf access for {user.login}</h3>
    <p className="field-help">{user.suspended ? 'Allow new Golf sign-ins. Previous sessions and automation grants stay revoked; local password enrollment is unchanged.' : 'Revoke all Golf sign-in sessions, dependent API and managed Git access, and sponsored automation grants. Native forge web, API and SSH access are separate.'}</p>
    <form.Field name="reason">{field => <label>Reason<textarea ref={first} required maxLength={1024} disabled={pending} value={field.state.value} onChange={event => field.handleChange(event.target.value)} onBlur={field.handleBlur} /></label>}</form.Field>
    <form.Field name="password">{field => <label>Your Golf password<input type="password" autoComplete="current-password" required minLength={15} maxLength={1024} disabled={pending} value={field.state.value} onChange={event => field.handleChange(event.target.value)} onBlur={field.handleBlur} /></label>}</form.Field>
    <form.Subscribe selector={state => state.errors}>{errors => errors.length ? <p role="alert" className="error">{errors.join(' ')}</p> : null}</form.Subscribe>
    <div className="credential-actions"><button type="submit" className="button primary" disabled={pending}>{pending ? 'Saving…' : user.suspended ? 'Confirm restore Golf access' : 'Confirm suspend Golf access'}</button><button type="button" className="button secondary" disabled={pending} onClick={() => { form.reset(); onCancel(); }}>Cancel</button></div>
  </form>;
}
function matchesOperation(op: GolfUserAccessOperation | undefined, intent: AccessIntent) {
  return Boolean(op && op.operationId === intent.operationId && op.golfUserId === intent.user.golfUserId && op.nativeUserId === intent.user.nativeUserId && /^(0|[1-9][0-9]{0,18})$/.test(intent.user.version) && op.version === (BigInt(intent.user.version) + 1n).toString() && op.suspended === intent.suspended && op.reason === intent.reason && op.changedAt && (!intent.suspended ? op.sessionsRevoked === 0n && op.automationGrantsRevoked === 0n : true));
}
export function GolfUserAccess({ userId, signingOut }: { userId: string; signingOut: boolean }) {
  const [editing, setEditing] = useState<UserAccess>();
  const [pending, setPending] = useState(false);
  const [uncertain, setUncertain] = useState<AccessIntent>();
  const [notice, setNotice] = useState('');
  const controller = useRef<AbortController | null>(null);
  const inFlight = useRef<AccessIntent | undefined>(undefined);
  const active = useRef(true);
  const query = useInfiniteQuery({ ...privateQuery, queryKey: ['instance-golf-user-access', userId], initialPageParam: 1, queryFn: ({ pageParam, signal }) => instanceAdminClient.listGolfUserAccess({ page: { page: pageParam, limit: 20 } }, { signal, timeoutMs: 8000 }), getNextPageParam: (page, _pages, current) => (page.page?.nextPage ?? 0) > current && (page.page?.nextPage ?? 0) <= 10000 ? page.page!.nextPage : undefined });
  const visible = query.isSuccess && !query.error && !signingOut && (!query.isFetching || query.isFetchingNextPage);
  const users = visible ? [...new Map(query.data.pages.flatMap(page => page.users).map(user => [user.golfUserId, user])).values()] : [];
  const loading = query.isPending || (query.isFetching && !query.isFetchingNextPage) || signingOut;
  useEffect(() => { active.current = true; const clear = () => { if (controller.current) { controller.current.abort(); if (inFlight.current) setUncertain(inFlight.current); } setEditing(undefined); }; window.addEventListener('pagehide', clear); return () => { active.current = false; controller.current?.abort(); window.removeEventListener('pagehide', clear); }; }, []);
  useEffect(() => { if (signingOut || query.error || (query.isFetching && !query.isFetchingNextPage)) { setEditing(undefined); if (controller.current && inFlight.current) { controller.current.abort(); setUncertain(inFlight.current); } } }, [signingOut, query.error, query.isFetching, query.isFetchingNextPage]);
  async function refresh() { if (controller.current) return; setEditing(undefined); await query.refetch(); }
  async function accepted(op: GolfUserAccessOperation, intent: AccessIntent) {
    setUncertain(undefined); setNotice(`${intent.suspended ? 'Golf access suspended' : 'Golf access restored'} for ${intent.user.login}. ${op.sessionsRevoked.toString()} sessions and ${op.automationGrantsRevoked.toString()} automation grants revoked.`); controller.current = null; inFlight.current = undefined; await query.refetch();
  }
  async function save(reason: string, password: string) {
    if (!editing || controller.current || uncertain || signingOut || !visible) return;
    const intent: AccessIntent = { user: editing, suspended: !editing.suspended, operationId: crypto.randomUUID(), reason };
    const request = new AbortController(); controller.current = request; inFlight.current = intent; setPending(true); setNotice(''); setEditing(undefined);
    try {
      const response = await instanceAdminClient.changeGolfUserAccess({ golfUserId: intent.user.golfUserId, nativeUserId: intent.user.nativeUserId, expectedVersion: intent.user.version, suspended: intent.suspended, reason, operationId: intent.operationId, passwordConfirmation: password }, { signal: request.signal, timeoutMs: 15000 });
      if (!active.current || request.signal.aborted) { if (active.current) setUncertain(intent); return; }
      if (!matchesOperation(response.operation, intent) || response.user?.golfUserId !== intent.user.golfUserId || response.user.nativeUserId !== intent.user.nativeUserId || response.user.version !== response.operation!.version || response.user.suspended !== intent.suspended) throw new Error('The access-change receipt could not be verified.');
      await accepted(response.operation!, intent);
    } catch (cause) { if (active.current) {
      if (!request.signal.aborted && cause instanceof ConnectError && cause.metadata.get('golf-access-outcome') === 'rejected') { setUncertain(undefined); inFlight.current = undefined; setNotice(`${errorMessage(cause)} No access change was committed. Select Suspend or Restore for a separate attempt.`); }
      else { setUncertain(intent); setNotice(`${request.signal.aborted ? 'The access-change outcome could not be confirmed.' : errorMessage(cause instanceof Error ? cause : new Error("The access change could not be confirmed."))} Inspect the original operation before another change. No automatic retry was made.`); }
      if (!request.signal.aborted && cause instanceof ConnectError && (cause.metadata.get('golf-access-outcome') === 'rejected' || cause.code === Code.Unauthenticated || cause.code === Code.PermissionDenied)) { controller.current = null; inFlight.current = undefined; await query.refetch(); }
    } }
    finally { password = ''; if (controller.current === request) controller.current = null; if (active.current) setPending(false); }
  }
  async function inspect() {
    if (!uncertain || controller.current || signingOut || !visible) return;
    const intent = uncertain; const request = new AbortController(); controller.current = request; setPending(true);
    try { const response = await instanceAdminClient.getGolfUserAccessOperation({ golfUserId: intent.user.golfUserId, nativeUserId: intent.user.nativeUserId, operationId: intent.operationId }, { signal: request.signal, timeoutMs: 8000 }); if (!active.current || request.signal.aborted) return; if (!matchesOperation(response.operation, intent) || response.user?.golfUserId !== intent.user.golfUserId || response.user.nativeUserId !== intent.user.nativeUserId) throw new Error('The original operation receipt could not be verified.'); await accepted(response.operation!, intent); }
    catch (cause) { if (active.current && !request.signal.aborted) setNotice(`${errorMessage(cause instanceof Error ? cause : new Error("The access change could not be confirmed."))} The original change remains unconfirmed. No write was retried.`); }
    finally { if (controller.current === request) controller.current = null; if (active.current) setPending(false); }
  }
  const columns: DataTableColumn<UserAccess>[] = [
    { id: 'user', accessorFn: user => user.login, header: 'User', cell: ({ row }) => <strong>{row.original.login}</strong> },
    { id: 'role', accessorFn: user => user.isInstanceAdmin ? 'Instance administrator' : 'User', header: 'Golf role' },
    { id: 'status', accessorFn: user => user.suspended ? 'Suspended' : 'Active', header: 'Golf access', cell: ({ row }) => <span className="visibility">{row.original.suspended ? 'Suspended' : 'Active'}</span> },
    { accessorKey: 'reason', header: 'Latest reason' },
    { accessorKey: 'changedAt', header: 'Changed', cell: ({ row }) => row.original.changedAt ? <DateLabel value={row.original.changedAt} /> : <span className="muted">—</span> },
    { id: 'actions', header: 'Action', enableSorting: false, enableGlobalFilter: false, cell: ({ row }) => row.original.nativeUserId === userId ? <span className="muted">Your account</span> : <button className="icon-button" type="button" aria-label={`${row.original.suspended ? 'Restore' : 'Suspend'} Golf access for ${row.original.login}`} title={`${row.original.suspended ? 'Restore' : 'Suspend'} Golf access`} disabled={pending || Boolean(uncertain) || Boolean(editing) || signingOut} onClick={() => { setEditing(row.original); setNotice(''); }}>{row.original.suspended ? <UserRoundCheck size={16} /> : <Ban size={16} />}</button> },
  ];
  return <section className="browser-panel credential-list-panel" aria-labelledby="golf-access-title"><div className="browser-panel-heading"><h2 id="golf-access-title">Golf access</h2><button className="button secondary" type="button" disabled={pending || query.isFetching || signingOut} onClick={() => void refresh()}><RefreshCw size={15} />Refresh Golf access</button></div>
    {query.error ? <PanelError error={query.error} retry={() => void refresh()} /> : loading ? <Loading label="Verifying Golf access administration…" /> : <>{notice ? <p className="panel-footnote" role={uncertain ? 'alert' : 'status'}>{notice}</p> : null}{uncertain ? <button className="button secondary" type="button" disabled={pending} onClick={() => void inspect()}>Inspect access change</button> : null}{editing ? <AccessEditor key={`${editing.golfUserId}/${editing.version}`} user={editing} pending={pending} onSubmit={save} onCancel={() => setEditing(undefined)} /> : null}<DataTable data={users} columns={columns} getRowId={user => user.golfUserId} label="Golf access" /><div className="list-footer"><span>{users.length} loaded</span><More hasMore={Boolean(query.hasNextPage)} loading={query.isFetchingNextPage || pending || Boolean(editing) || Boolean(uncertain)} load={() => void query.fetchNextPage()} label="Golf users" /></div></>}
    <p className="panel-footnote">Known Golf users across password, token and OAuth sign-ins. Suspension controls managed Golf access; native forge access is separate.</p>
  </section>;
}
