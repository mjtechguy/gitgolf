import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Code, ConnectError } from '@connectrpc/connect';
import { Link } from '@tanstack/react-router';
import { RefreshCw, ShieldCheck } from 'lucide-react';
import { repositoryAccessClient, repositoryClient, repositoryDeployKeyClient, repositoryInvitationClient, repositoryTeamAccessClient } from './api';
import type { PageResponse, RepositoryAccess, User } from './gen/golf/v1/golf_pb';
import { DataTable } from './DataTable';
import { Loading, PanelError, privateQuery } from './RepositoryUI';
import { sourceRepositoryID } from './sourceReads';
import { isRunID } from './navigation';

export type AccessObservationTarget = { repositoryId: string; ownerId: string; revision: string; archived: boolean; mirror: boolean };
const revision = (value: string) => /^[a-f0-9]{64}$/.test(value);
const permissions = ['none', 'read', 'write', 'admin', 'owner'];
const invalid = () => new ConnectError('Current repository access could not be verified. Inspect again after refreshing repository settings.', Code.FailedPrecondition);
function boundAccess(access: RepositoryAccess | undefined, target: AccessObservationTarget, owner: string): RepositoryAccess {
  if (!access || access.repositoryId !== target.repositoryId || access.ownerId !== target.ownerId || access.owner?.id !== target.ownerId || access.owner.login !== owner || !revision(access.revision) || !permissions.includes(access.currentPermission) || access.canManage && !['admin', 'owner'].includes(access.currentPermission)) throw invalid();
  return access;
}
function boundPage(page: PageResponse | undefined, count: number) {
  if (!page || count > 20 || ![0, 2].includes(page.nextPage)) throw invalid();
  return `${count} loaded${page.nextPage ? ' · more available' : ''}`;
}
function unique(values: string[]) {
  if (new Set(values).size !== values.length) throw invalid();
}
type Observation = { permission: string; configuration: string; grants: string; keys: string; invitations: string; teams: string };

// Only metadata projections enter this private query cache. Native key bodies,
// collaborator identities and invitation recipients are never returned here.
export function RepositoryAccessObservation({ userId, owner, name, target }: { userId: string; owner: string; name: string; target: AccessObservationTarget }) {
  const cache = useQueryClient();
  const [requested, setRequested] = useState(false);
  const key = ['repository-access-observation', userId, owner, name, target.repositoryId, target.ownerId, target.revision];
  const validTarget = sourceRepositoryID(userId) && sourceRepositoryID(target.repositoryId) && sourceRepositoryID(target.ownerId) && revision(target.revision);
  const current = () => cache.getQueryData<User | null>(['session'])?.id === userId;
  const query = useQuery({ ...privateQuery, queryKey: key, enabled: requested && validTarget, retry: false, queryFn: async ({ signal }): Promise<Observation> => {
    const bounded = AbortSignal.any([signal, AbortSignal.timeout(15_000)]);
    const options = { signal: bounded, timeoutMs: 8_000 };
    const repository = { owner, name };
    const ensureCurrent = () => { bounded.throwIfAborted(); if (!current()) throw new DOMException('Inspection cancelled.', 'AbortError'); };
    try {
      ensureCurrent();
      const native = await repositoryClient.getRepository({ repository }, options); ensureCurrent();
      if (native.repository?.id !== target.repositoryId || native.repository.name !== name || native.repository.fullName !== `${owner}/${name}`) throw invalid();
      const initial = boundAccess((await repositoryAccessClient.getRepositoryAccess({ repository }, options)).access, target, owner); ensureCurrent();
      const result: Observation = { permission: initial.currentPermission, configuration: target.archived ? 'Archived · read only' : target.mirror ? 'Mirror · read only' : 'Ordinary repository', grants: 'View only · repository administration required', keys: 'View only · repository administration required', invitations: 'View only · repository administration required', teams: initial.organizationOwned ? 'Organization owner required to manage associations' : 'Personal repository · no organization teams' };
      if (initial.canManage && (target.archived || target.mirror)) throw invalid();
      if (initial.canManage) {
        const request = { repository, repositoryId: target.repositoryId, ownerId: target.ownerId, expectedRevision: initial.revision, page: { page: 1, limit: 20 } };
        const [collaborators, keys, invitations, teams] = await Promise.all([
          repositoryAccessClient.listRepositoryCollaborators(request, options),
          repositoryDeployKeyClient.listRepositoryDeployKeys(request, options),
          repositoryInvitationClient.listRepositoryInvitations(request, options),
          initial.organizationOwned ? repositoryTeamAccessClient.listRepositoryTeamAccess(request, options) : Promise.resolve(undefined),
        ]); ensureCurrent();
        const bound = (response: { repositoryId: string; ownerId: string; accessRevision: string }) => {
          if (response.repositoryId !== target.repositoryId || response.ownerId !== target.ownerId || response.accessRevision !== initial.revision) throw invalid();
        };
        bound(keys); bound(invitations); if (teams) bound(teams);
        if (collaborators.collaborators.some(row => !sourceRepositoryID(row.user?.id || '') || !permissions.includes(row.permission) || !revision(row.revision))) throw invalid();
        unique(collaborators.collaborators.map(row => row.user!.id));
        if (keys.keys.some(row => !sourceRepositoryID(row.id) || !revision(row.revision))) throw invalid();
        unique(keys.keys.map(row => row.id));
        if (!invitations.canManage || invitations.invitations.some(row => !isRunID(row.id) || row.repositoryId !== target.repositoryId || row.ownerId !== target.ownerId || row.repository?.owner !== owner || row.repository.name !== name)) throw invalid();
        unique(invitations.invitations.map(row => row.id));
        result.grants = `Can manage · ${boundPage(collaborators.page, collaborators.collaborators.length)}`;
        result.keys = `Can manage · ${boundPage(keys.page, keys.keys.length)}`;
        result.invitations = `${invitations.localIssuerAvailable ? 'Can issue invitations' : 'Local-account issuer required'} · ${boundPage(invitations.page, invitations.invitations.length)}`;
        if (teams) {
          if (teams.teams.some(row => !sourceRepositoryID(row.team?.id || '') || !revision(row.revision))) throw invalid();
          unique(teams.teams.map(row => row.team!.id));
          result.teams = `${teams.canManage ? 'Can manage associations' : 'Organization owner required to manage associations'} · ${boundPage(teams.page, teams.teams.length)}`;
        }
      }
      const final = boundAccess((await repositoryAccessClient.getRepositoryAccess({ repository }, options)).access, target, owner); ensureCurrent();
      if (final.revision !== initial.revision || final.currentPermission !== initial.currentPermission || final.canManage !== initial.canManage || final.organizationOwned !== initial.organizationOwned) throw invalid();
      return result;
    } catch (error) {
      ensureCurrent();
      throw error;
    }
  } });
  useEffect(() => () => { void cache.cancelQueries({ queryKey: key, exact: true }); cache.removeQueries({ queryKey: key, exact: true }); }, [cache, userId, owner, name, target.repositoryId, target.ownerId, target.revision]);
  const observation = query.isSuccess && !query.isFetching && !query.error ? query.data : undefined;
  const rows = observation ? [
    { id: 'configuration', control: 'Observed configuration', value: observation.configuration },
    { id: 'permission', control: 'Your effective access', value: observation.permission },
    { id: 'grants', control: 'Collaborator grants', value: observation.grants },
    { id: 'keys', control: 'Deploy keys', value: observation.keys },
    { id: 'invitations', control: 'Invitations', value: observation.invitations },
    { id: 'teams', control: 'Organization teams', value: observation.teams },
  ] : [];
  return <section className="credential-form-content" aria-labelledby="access-observation-title"><div className="browser-panel-heading"><h3 id="access-observation-title"><ShieldCheck size={16} />Current access</h3><button className="button secondary" disabled={!validTarget || query.isFetching} onClick={() => requested ? void query.refetch() : setRequested(true)}><RefreshCw size={15} />{requested ? 'Refresh access observation' : 'Inspect access'}</button></div>
    {!requested ? <p className="field-help">Inspect your current authority without changing grants or sending invitations.</p> : query.isFetching || query.isPending ? <Loading label="Inspecting current repository access…" /> : query.error ? <PanelError error={query.error} retry={() => void query.refetch()} /> : observation ? <><DataTable data={rows} columns={[{ accessorKey: 'control', header: 'Control' }, { accessorKey: 'value', header: 'Current observation' }]} getRowId={row => row.id} label="Current repository access observation" /><Link className="button secondary" to="/$owner/$name/settings/access" params={{ owner, name }}>Open access settings</Link></> : null}
    <p className="panel-footnote">These independent reads describe current authority and the first loaded page, not total membership or qualification. The portable Access-core recovery drill is qualified; complete infrastructure-track and whole-platform recovery acceptance remains separate. Access coverage stays Partial.</p>
  </section>;
}
