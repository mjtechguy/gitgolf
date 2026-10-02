import { useInfiniteQuery } from '@tanstack/react-query';
import { ShieldCheck, RefreshCw } from 'lucide-react';
import { instanceAdminClient } from './api';
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

export function InstanceSettings({ userId, signingOut }: { userId: string; signingOut: boolean }) {
  const query = useInfiniteQuery({ ...privateQuery, queryKey: ['instance-local-accounts', userId], initialPageParam: 1,
    queryFn: ({ pageParam, signal }) => instanceAdminClient.listLocalAccounts({ page: { page: pageParam, limit: 20 } }, { signal, timeoutMs: 8_000 }),
    getNextPageParam: (page, _pages, currentPage) => { const next = page.page?.nextPage ?? 0; return next > currentPage && next <= 10_000 ? next : undefined; },
  });
  const accounts = query.isSuccess && !query.error && !signingOut && (!query.isFetching || query.isFetchingNextPage)
    ? [...new Map(query.data.pages.flatMap(page => page.accounts).map(account => [account.id, account])).values()] : [];
  const loading = query.isPending || (query.isFetching && !query.isFetchingNextPage) || signingOut;
  return <section aria-labelledby="instance-settings-title">
    <header className="repository-intro"><div><span className="eyebrow">INSTALLATION ADMINISTRATION</span><h1 id="instance-settings-title"><ShieldCheck size={29} />Instance settings</h1><p>Enrolled Golf accounts and installation administration.</p></div></header>
    <section className="browser-panel credential-list-panel" aria-labelledby="instance-accounts-title">
      <div className="browser-panel-heading"><h2 id="instance-accounts-title">Local accounts</h2><button className="button secondary" disabled={query.isFetching || signingOut} onClick={() => void query.refetch()}><RefreshCw size={15} />Refresh local accounts</button></div>
      {query.error ? <PanelError error={query.error} retry={() => void query.refetch()} /> : loading ? <Loading label="Verifying instance administration…" /> : <><DataTable data={accounts} columns={columns} getRowId={account => account.id} label="Local accounts" /><div className="list-footer"><span>{accounts.length} loaded</span><More hasMore={Boolean(query.hasNextPage)} loading={query.isFetchingNextPage} load={() => void query.fetchNextPage()} label="accounts" /></div></>}
      <p className="panel-footnote">This inventory contains operator-enrolled Golf accounts, including disabled accounts. It does not list every native or OAuth user. Enrollment, reset, suspension and recovery still use operator commands. A local suspension does not disable native Git credentials.</p>
    </section>
    <SettingsInventory scope="instance" />
  </section>;
}
