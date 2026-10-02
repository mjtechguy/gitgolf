import { useEffect, useId, useRef, useState } from 'react';
import { useInfiniteQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { Building2, ChevronsUpDown, RefreshCw, UserRound } from 'lucide-react';
import { organizationClient } from './api';
import { organizationOptions } from './navigation';
import { Loading, PanelError, privateQuery } from './RepositoryUI';

// Mount only while the switcher is open; inactive membership pages have no cache lifetime.
function Memberships({ userId, currentOrganization, close }: { userId: string; currentOrganization?: string; close: () => void }) {
  const query = useInfiniteQuery({ ...privateQuery, queryKey: ['workspace-memberships', userId], initialPageParam: 1,
    queryFn: ({ pageParam, signal }) => organizationClient.listOrganizations({ page: { page: pageParam, limit: 20 } }, { signal, timeoutMs: 8_000 }),
    getNextPageParam: (response, _pages, current) => {
      const next = response.page?.nextPage || 0;
      return next > current && next <= 10_000 ? next : undefined;
    },
  });
  const organizations = query.isSuccess && (!query.isFetching || query.isFetchingNextPage)
    ? [...new Map(query.data.pages.flatMap(page => page.organizations).map(organization => [organization.id, organization])).values()] : [];
  return <>
    <div className="workspace-switcher-heading"><span>YOUR ORGANIZATIONS</span><button type="button" className="icon-button" aria-label="Refresh organizations" disabled={query.isFetching} onClick={() => void query.refetch()}><RefreshCw size={15} aria-hidden="true" /></button></div>
    {query.error ? <PanelError error={query.error} retry={() => void query.refetch()} /> : query.isPending || (query.isFetching && !query.isFetchingNextPage) ? <Loading label="Loading organization memberships…" /> : <>
      {organizations.length ? <ul className="workspace-switcher-list">{organizations.map(organization => <li key={organization.id}><Link {...organizationOptions({ organization: organization.name })} aria-current={currentOrganization === organization.name ? 'page' : undefined} onClick={close}><Building2 size={17} aria-hidden="true" /><span>{organization.name}</span></Link></li>)}</ul> : <p className="workspace-switcher-note">No organization memberships in the loaded pages.</p>}
      {query.hasNextPage ? <button type="button" disabled={query.isFetching} onClick={() => void query.fetchNextPage()}>{query.isFetchingNextPage ? 'Loading organizations…' : 'Load more organizations'}</button> : null}
    </>}
  </>;
}

export function WorkspaceSwitcher({ userId, login, currentOrganization, signingOut }: { userId: string; login: string; currentOrganization?: string; signingOut: boolean }) {
  const id = useId();
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const [openedFor, setOpenedFor] = useState<string>();
  const context = JSON.stringify([userId, login, currentOrganization]);
  const open = openedFor === context && !signingOut;
  const close = () => setOpenedFor(undefined);
  useEffect(() => { setOpenedFor(undefined); }, [userId, login, currentOrganization, signingOut]);
  useEffect(() => {
    if (!open) return;
    function outside(event: PointerEvent) { if (!root.current?.contains(event.target as Node)) setOpenedFor(undefined); }
    document.addEventListener('pointerdown', outside);
    return () => document.removeEventListener('pointerdown', outside);
  }, [open]);
  return <div className="workspace-switcher" ref={root} onBlur={event => { if (event.relatedTarget && !event.currentTarget.contains(event.relatedTarget)) close(); }} onKeyDown={event => { if (event.key === 'Escape' && open) { event.preventDefault(); event.stopPropagation(); close(); trigger.current?.focus(); } }}>
    <button type="button" className="workspace-switcher-trigger" ref={trigger} aria-label="Switch workspace" aria-expanded={open} aria-controls={id} disabled={signingOut} onClick={() => setOpenedFor(open ? undefined : context)}>
      {currentOrganization ? <Building2 size={17} aria-hidden="true" /> : <UserRound size={17} aria-hidden="true" />}<span>{currentOrganization || login}</span><ChevronsUpDown size={15} aria-hidden="true" />
    </button>
    {open ? <nav className="workspace-switcher-dropdown account-dropdown" id={id} aria-label="Choose workspace">
      <Link to="/" aria-current={currentOrganization ? undefined : 'page'} onClick={close}><UserRound size={17} aria-hidden="true" /><span>Personal workspace <small>{login}</small></span></Link>
      <Memberships key={userId} userId={userId} currentOrganization={currentOrganization} close={close} />
      <Link to="/organizations" onClick={close}><Building2 size={17} aria-hidden="true" />Browse organizations</Link>
    </nav> : null}
  </div>;
}
