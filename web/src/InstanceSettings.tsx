import { useEffect, useRef, useState } from 'react';
import { useForm } from '@tanstack/react-form';
import { useInfiniteQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { ShieldCheck, RefreshCw } from 'lucide-react';
import { instanceAdminClient, errorMessage } from './api';
import { DataTable } from './DataTable';
import type { DataTableColumn } from './DataTable';
import type { LocalAccountInfo } from './gen/golf/v1/golf_pb';
import { DateLabel, Loading, More, PanelError, privateQuery } from './RepositoryUI';
import { SettingsInventory } from './AccountSettings';

const columns: DataTableColumn<LocalAccountInfo>[] = [
  { id: 'account', accessorFn: account => `${account.username} ${account.email}`, header: 'Account', cell: ({ row }) => <><strong>{row.original.username}</strong><small>{row.original.email || 'No enrolled email'}</small></> },
  { id: 'role', accessorFn: account => account.isInstanceAdmin ? 'Instance administrator' : 'User', header: 'Golf role' },
  { id: 'status', accessorFn: account => account.disabled ? 'Disabled' : 'Enabled', header: 'Local sign-in', cell: ({ row }) => <span className="visibility">{row.original.disabled ? 'Disabled' : 'Enabled'}</span> },
  { accessorKey: 'id', header: 'Account ID' },
  { accessorKey: 'nativeUserId', header: 'Mapped user ID' },
  { accessorKey: 'createdAt', header: 'Enrolled', cell: ({ row }) => <DateLabel value={row.original.createdAt} /> },
];

function DisableEditor({ account, pending, onSubmit, onCancel }: { account: LocalAccountInfo; pending: boolean; onSubmit: (password: string) => Promise<void>; onCancel: () => void }) {
  const form = useForm({ defaultValues: { password: '' }, onSubmit: async ({ value }) => { const password = value.password; form.reset(); await onSubmit(password); } });
  useEffect(() => { const clear = () => form.reset(); window.addEventListener('pagehide', clear); return () => { window.removeEventListener('pagehide', clear); form.reset(); }; }, [form]);
  return <form className="credential-form-content" aria-label="Disable local sign-in" onSubmit={event => { event.preventDefault(); void form.handleSubmit(); }}>
    <h3>Disable local sign-in for {account.username}</h3><p>This revokes this account’s Golf password sessions and dependent API credentials. Native Git credentials and provider logins remain separate. Instance administrator accounts are protected.</p>
    <p className="field-help">Account {account.id} · credential version {account.credentialVersion.toString()}. Re-enabling requires an operator.</p>
    <form.Field name="password">{field => <label>Your Golf password<input type="password" name="password-confirmation" autoComplete="current-password" required minLength={15} maxLength={1024} disabled={pending} value={field.state.value} onBlur={field.handleBlur} onChange={event => field.handleChange(event.target.value)} /></label>}</form.Field>
    <div className="credential-actions"><button className="button primary" disabled={pending} type="submit">{pending ? 'Disabling…' : 'Confirm disable local sign-in'}</button><button className="button secondary" type="button" disabled={pending} onClick={() => { form.reset(); onCancel(); }}>Cancel</button></div>
  </form>;
}

export function InstanceSettings({ userId, signingOut, view = 'accounts' }: { userId: string; signingOut: boolean; view?: 'overview' | 'accounts' }) {
  const [target, setTarget] = useState<LocalAccountInfo>();
  const [pending, setPending] = useState(false);
  const [uncertain, setUncertain] = useState(false);
  const [notice, setNotice] = useState('');
  const controller = useRef<AbortController | null>(null);
  const active = useRef(true);
  const query = useInfiniteQuery({ ...privateQuery, queryKey: ['instance-local-accounts', userId], enabled: view === 'accounts', initialPageParam: 1,
    queryFn: ({ pageParam, signal }) => instanceAdminClient.listLocalAccounts({ page: { page: pageParam, limit: 20 } }, { signal, timeoutMs: 8_000 }),
    getNextPageParam: (page, _pages, currentPage) => { const next = page.page?.nextPage ?? 0; return next > currentPage && next <= 10_000 ? next : undefined; },
  });
  useEffect(() => { active.current = true; const abort = () => { if (controller.current) { controller.current.abort(); setUncertain(true); setNotice('The disable outcome could not be confirmed. Refresh and inspect current account state; no automatic retry was made.'); } setTarget(undefined); }; window.addEventListener('pagehide', abort); return () => { active.current = false; controller.current?.abort(); window.removeEventListener('pagehide', abort); }; }, []);
  useEffect(() => { if (signingOut) { if (controller.current) { controller.current.abort(); setUncertain(true); setNotice('The disable outcome could not be confirmed. Refresh and inspect current account state; no automatic retry was made.'); } setTarget(undefined); } }, [signingOut]);
  const accounts = query.isSuccess && !query.error && !signingOut && (!query.isFetching || query.isFetchingNextPage)
    ? [...new Map(query.data.pages.flatMap(page => page.accounts).map(account => [account.id, account])).values()] : [];
  const loading = query.isPending || (query.isFetching && !query.isFetchingNextPage) || signingOut;
  async function refresh() { if (controller.current) return; setTarget(undefined); const result = await query.refetch(); if (active.current && !result.error) setUncertain(false); }
  async function disable(password: string) {
    if (!target || controller.current || signingOut || uncertain) return;
    const current = target; const request = new AbortController(); controller.current = request; setPending(true); setNotice(''); setTarget(undefined);
    try {
      const response = await instanceAdminClient.disableLocalAccount({ accountId: current.id, expectedCredentialVersion: current.credentialVersion, passwordConfirmation: password }, { signal: request.signal, timeoutMs: 12_000 });
      if (!active.current || request.signal.aborted) return;
      if (!response.account || response.account.id !== current.id || response.account.nativeUserId !== current.nativeUserId || !response.account.disabled || response.account.isInstanceAdmin || !/^[1-9][0-9]{0,18}$/.test(current.credentialVersion) || response.account.credentialVersion !== (BigInt(current.credentialVersion) + 1n).toString() || !response.operationId) throw new Error('The disable result could not be verified.');
      setNotice(`Local sign-in disabled for ${current.username}. ${response.sessionsRevoked.toString()} password sessions revoked.`);
      await query.refetch();
    } catch (error) { if (active.current && !request.signal.aborted) { setUncertain(true); setNotice(`${errorMessage(error instanceof Error ? error : new Error('The disable outcome could not be confirmed.'))} Refresh and inspect the current account state before a separate attempt. No automatic retry was made.`); } }
    finally { password = ''; if (controller.current === request) controller.current = null; if (active.current) setPending(false); }
  }
  const accountColumns: DataTableColumn<LocalAccountInfo>[] = [...columns, { id: 'actions', header: 'Action', enableSorting: false, enableGlobalFilter: false, cell: ({ row }) => row.original.isInstanceAdmin ? <span className="muted">Protected administrator</span> : row.original.disabled ? <span className="muted">Operator recovery</span> : <button className="text-button" disabled={pending || uncertain || signingOut || Boolean(target)} onClick={() => { setTarget(row.original); setNotice(''); }}>Disable local sign-in</button> }];
  return <div className="account-layout"><nav className="account-navigation" aria-label="Instance administration"><span className="eyebrow">GLOBAL ADMINISTRATION</span><Link to="/admin" activeOptions={{ exact: true }}>Overview</Link><Link to="/admin/settings" activeOptions={{ exact: true }}>Local accounts</Link><Link to="/status">System capabilities</Link></nav><div className="account-content"><section aria-labelledby="instance-settings-title">
    <header className="repository-intro"><div><span className="eyebrow">INSTALLATION ADMINISTRATION</span><h1 id="instance-settings-title"><ShieldCheck size={29} />Instance settings</h1><p>Golf account administration is separate from organization and repository ownership.</p></div></header>
    {view === 'overview' ? <SettingsInventory scope="instance" /> : <section className="browser-panel credential-list-panel" aria-labelledby="instance-accounts-title">
      <div className="browser-panel-heading"><h2 id="instance-accounts-title">Local accounts</h2><button className="button secondary" disabled={query.isFetching || pending || signingOut} onClick={() => void refresh()}><RefreshCw size={15} />Refresh local accounts</button></div>
      {notice && !signingOut ? <p className="panel-footnote" role={uncertain ? 'alert' : 'status'}>{notice}</p> : null}
      {query.error ? <PanelError error={query.error} retry={() => void refresh()} /> : loading ? <Loading label="Verifying instance administration…" /> : <>{target ? <DisableEditor key={`${target.id}/${target.credentialVersion}`} account={target} pending={pending} onSubmit={disable} onCancel={() => setTarget(undefined)} /> : null}<DataTable data={accounts} columns={accountColumns} getRowId={account => account.id} label="Local accounts" /><div className="list-footer"><span>{accounts.length} loaded</span><More hasMore={Boolean(query.hasNextPage)} loading={query.isFetchingNextPage || pending || Boolean(target)} load={() => void query.fetchNextPage()} label="accounts" /></div></>}
      <p className="panel-footnote">This inventory contains operator-enrolled Golf accounts, including disabled accounts. It does not list every native or OAuth user. Enrollment, reset and recovery still use operator commands. Disabling ordinary accounts requires your password; native Git credentials and provider logins remain separate.</p>
    </section>}
  </section></div></div>;
}
