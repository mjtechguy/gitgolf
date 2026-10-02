import { useId } from 'react';
import type { ReactNode } from 'react';
import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query';
import { Code, ConnectError } from '@connectrpc/connect';
import { Link } from '@tanstack/react-router';
import { ArrowDown, ArrowLeft, Building2, LoaderCircle, RefreshCw, Users } from 'lucide-react';
import { OrganizationCreate } from './OrganizationCreate';
import { errorMessage, organizationClient } from './api';
import { OrganizationVisibility, TeamPermission, TeamVisibility } from './gen/golf/v1/golf_pb';
import type { PageResponse } from './gen/golf/v1/golf_pb';
import { organizationOptions, repositoryOptions } from './navigation';
import type { OrganizationLocation } from './navigation';

const privateQuery = { staleTime: 0, gcTime: 0 };
const permission = (value: TeamPermission) => TeamPermission[value]?.toLowerCase() || 'unknown';

function Loading({ label }: { label: string }) {
  return <p className="browser-loading" role="status"><LoaderCircle size={18} className="spin" />{label}</p>;
}
function Failure({ error, retry }: { error: Error; retry: () => void }) {
  return <div className="panel-error"><p className="error" role="alert">{errorMessage(error)}</p><button className="button secondary" onClick={retry}>Try again</button></div>;
}
function Refresh({ label, busy, refresh }: { label: string; busy: boolean; refresh: () => void }) {
  return <button className="icon-button" aria-label={label} disabled={busy} onClick={refresh}><RefreshCw size={16} className={busy ? 'spin' : ''} /></button>;
}

// All four lists share pagination and private-data handling; provider messages stay typed at each call.
function PagedPanel<T extends { id: string }>({ title, queryKey, load, render, empty }: {
  title: string; queryKey: string[]; load: (page: number, signal: AbortSignal) => Promise<{ items: T[]; page?: PageResponse }>;
  render: (item: T) => ReactNode; empty: string;
}) {
  const heading = useId();
  const query = useInfiniteQuery({ ...privateQuery, queryKey, initialPageParam: 1,
    queryFn: ({ pageParam, signal }) => load(pageParam, signal),
    getNextPageParam: (page, _pages, currentPage) => {
      const next = page.page?.nextPage ?? 0;
      return next > currentPage && next <= 10_000 ? next : undefined;
    },
  });
  const items = query.isSuccess && (!query.isFetching || query.isFetchingNextPage)
    ? [...new Map(query.data.pages.flatMap((page) => page.items).map((item) => [item.id, item])).values()] : [];
  return <section className="browser-panel organization-panel" aria-labelledby={heading}>
    <div className="browser-panel-heading"><h2 id={heading}>{title}</h2><Refresh label={`Refresh ${title.toLowerCase()}`} busy={query.isFetching} refresh={() => void query.refetch()} /></div>
    {query.isError ? <Failure error={query.error} retry={() => void query.refetch()} /> : query.isPending || (query.isFetching && !query.isFetchingNextPage) ? <Loading label={`Loading ${title.toLowerCase()}…`} /> : <>
      {items.length ? <ul className="organization-list">{items.map((item) => <li key={item.id}>{render(item)}</li>)}</ul> : <div className="empty-state"><Users size={24} /><h3>{empty}</h3>{query.hasNextPage ? <p>More provider pages are available and may contain visible results.</p> : null}</div>}
      <div className="list-footer organization-list-footer"><span>{items.length} loaded · {title.toLowerCase()}</span>{query.hasNextPage ? <button className="text-button" disabled={query.isFetching} onClick={() => void query.fetchNextPage()}>{query.isFetchingNextPage ? 'Loading…' : `Load more ${title.toLowerCase()}`}<ArrowDown size={14} /></button> : null}</div>
    </>}
  </section>;
}

function OrganizationList({ userId }: { userId: string }) {
  const client = useQueryClient();
  return <><header className="repository-intro"><div><span className="eyebrow">YOUR FORGE MEMBERSHIPS</span><h1><Building2 size={29} />Organizations</h1><p>Your organizations, repositories and team access.</p></div></header>
    <OrganizationCreate key={userId} userId={userId} signingOut={false} onCreated={async () => { await client.invalidateQueries({ queryKey: ['organizations', userId] }); }} />
    <PagedPanel title="Your organizations" queryKey={['organizations', userId]} empty="No organization memberships returned."
      load={async (page, signal) => { const response = await organizationClient.listOrganizations({ page: { page, limit: 20 } }, { signal, timeoutMs: 8_000 }); return { items: response.organizations, page: response.page }; }}
      render={(organization) => <><div className="organization-row-title"><h3><Link {...organizationOptions({ organization: organization.name })}>{organization.name}</Link></h3><span className="visibility">{OrganizationVisibility[organization.visibility]?.toLowerCase() || 'unknown'}</span></div>{organization.fullName ? <p>{organization.fullName}</p> : null}<p>{organization.description || 'No description provided.'}</p></>} />
  </>;
}

function TeamDetail({ organization, teamId, queryKey }: { organization: string; teamId: string; queryKey: string[] }) {
  const key = [...queryKey, 'team', teamId];
  const query = useQuery({ ...privateQuery, queryKey: [...key, 'metadata'], queryFn: async ({ signal }) => {
    const response = await organizationClient.getTeam({ organization, teamId }, { signal, timeoutMs: 8_000 });
    if (!response.team) throw new ConnectError('The team response is missing its metadata.', Code.Internal);
    return response.team;
  } });
  const team = query.isSuccess && !query.isFetching ? query.data : undefined;
  return <>
    <div className="organization-team-navigation"><Link className="button secondary" to="/organizations/$organization/teams/$teamId/settings" params={{ organization, teamId }}>Team settings</Link><Link className="text-button" {...organizationOptions({ organization })}><ArrowLeft size={15} />All teams</Link><Refresh label="Refresh team access" busy={query.isFetching} refresh={() => void query.refetch()} /></div>
    {query.isError ? <Failure error={query.error} retry={() => void query.refetch()} /> : !team ? <Loading label="Opening team…" /> : <>
      <section className="browser-panel organization-panel" aria-labelledby="team-title"><div className="browser-panel-heading"><h2 id="team-title">{team.name}</h2><span className="visibility">{TeamVisibility[team.visibility]?.toLowerCase() || 'unknown'}</span></div><div className="organization-team-metadata"><p>{team.description || 'No description provided.'}</p><dl><div><dt>Native team permission</dt><dd>{permission(team.permission)}</dd></div><div><dt>Repository assignment</dt><dd>{team.includesAllRepositories ? 'All repositories (provider setting)' : 'Explicit team assignments'}</dd></div></dl>
        <h3>Native unit permissions</h3>{Object.keys(team.unitPermissions).length ? <dl className="unit-permissions">{Object.entries(team.unitPermissions).map(([unit, value]) => <div key={unit}><dt><code>{unit}</code></dt><dd>{permission(value)}</dd></div>)}</dl> : <p className="muted">No per-unit permission metadata returned.</p>}
        <p className="organization-permission-note">These are recorded team settings, not a computed effective Golf role. Issue read permission may allow commenting; repository admin permission may allow deletion. Team grants can combine with other access.</p></div></section>
      <div className="organization-team-lists"><PagedPanel title="Members" queryKey={[...key, 'members']} empty="No visible members in the loaded pages."
        load={async (page, signal) => { const response = await organizationClient.listTeamMembers({ organization, teamId, page: { page, limit: 20 } }, { signal, timeoutMs: 8_000 }); return { items: response.members, page: response.page }; }}
        render={(member) => <><h3>{member.login}</h3>{member.fullName ? <p>{member.fullName}</p> : null}</>} />
      <PagedPanel title="Repositories" queryKey={[...key, 'repositories']} empty="No visible repositories in the loaded pages."
        load={async (page, signal) => { const response = await organizationClient.listTeamRepositories({ organization, teamId, page: { page, limit: 20 } }, { signal, timeoutMs: 8_000 }); return { items: response.repositories, page: response.page }; }}
        render={(repository) => { const owner = repository.fullName.split('/')[0]; return <><div className="organization-row-title"><h3>{owner ? <Link {...repositoryOptions({ owner, name: repository.name })}>{repository.fullName}</Link> : repository.name}</h3><span className="visibility">{repository.private ? 'Private' : 'Public'}</span></div><p>{repository.description || 'No description provided.'}</p></>; }} /></div>
    </>}
  </>;
}

function OrganizationDetail({ organization: name, teamId, userId }: { organization: string; teamId?: string; userId: string }) {
  const queryKey = ['organization', userId, name];
  const query = useQuery({ ...privateQuery, queryKey: [...queryKey, 'metadata'], queryFn: async ({ signal }) => {
    const response = await organizationClient.getOrganization({ organization: name }, { signal, timeoutMs: 8_000 });
    if (!response.organization) throw new ConnectError('The organization response is missing its metadata.', Code.Internal);
    return response.organization;
  } });
  const organization = query.isSuccess && !query.isFetching ? query.data : undefined;
  return <><Link to="/organizations" className="text-button repository-back"><ArrowLeft size={15} />All organizations</Link>
    {query.isError ? <Failure error={query.error} retry={() => void query.refetch()} /> : !organization ? <Loading label="Opening organization…" /> : <>
      <header className="repository-intro"><div><span className="eyebrow">ORGANIZATION</span><h1><Building2 size={29} />{organization.name}<span className="visibility">{OrganizationVisibility[organization.visibility]?.toLowerCase() || 'unknown'}</span></h1>{organization.fullName ? <p>{organization.fullName}</p> : null}<p>{organization.description || 'No description provided.'}</p></div><div className="panel-actions"><Link className="button secondary" to="/organizations/$organization/settings" params={{ organization: organization.name }}>Settings</Link><Refresh label="Refresh organization access" busy={query.isFetching} refresh={() => void query.refetch()} /></div></header>
      <p className="organization-guidance">Golf requires your membership to browse this organization. Visibility labels describe organization settings; they do not grant access to this Golf page. Your account must have permission to read the organization and its teams.</p>
      {teamId ? <TeamDetail key={teamId} organization={name} teamId={teamId} queryKey={queryKey} /> : <PagedPanel title="Teams" queryKey={[...queryKey, 'teams']} empty="No visible teams in the loaded pages."
        load={async (page, signal) => { const response = await organizationClient.listTeams({ organization: name, page: { page, limit: 20 } }, { signal, timeoutMs: 8_000 }); return { items: response.teams, page: response.page }; }}
        render={(team) => <><div className="organization-row-title"><h3><Link {...organizationOptions({ organization: name, team: team.id })}>{team.name}</Link></h3><span className="visibility">{TeamVisibility[team.visibility]?.toLowerCase() || 'unknown'}</span></div><p>{team.description || 'No description provided.'}</p><p className="organization-native-permission">Native permission: {permission(team.permission)}</p></>} />}
    </>}
  </>;
}

export function OrganizationBrowser({ location, userId }: { location: OrganizationLocation; userId: string }) {
  return <div className="organization-browser">{location.organization ? <OrganizationDetail key={location.organization} organization={location.organization} teamId={location.team} userId={userId} /> : <OrganizationList userId={userId} />}</div>;
}
