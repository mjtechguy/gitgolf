import { useQuery } from '@tanstack/react-query';
import { Code, ConnectError } from '@connectrpc/connect';
import { executionPolicyApi, organizationClient, organizationExecutionValueClient } from './api';
import { ExecutionScope } from './gen/golf/v1/golf_pb';
import { OrganizationExecutionValues } from './OrganizationExecutionValues';
import { OrganizationSettingsLayout } from './AccountSettings';
import { Loading, PanelError, privateQuery } from './RepositoryUI';

const identity = (value: string) => /^[1-9][0-9]{0,18}$/.test(value) && BigInt(value) <= 9223372036854775807n;

export function OrganizationExecutionSettings({ userId, organization, signingOut }: { userId: string; organization: string; signingOut: boolean }) {
  const enabled = !signingOut && identity(userId);
  const currentOrganization = useQuery({ ...privateQuery, enabled, queryKey: ['organization-values-identity', userId, organization], queryFn: async ({ signal }) => {
    const response = await organizationClient.getOrganization({ organization }, { signal, timeoutMs: 8000 });
    signal.throwIfAborted();
    if (!response.organization || !identity(response.organization.id) || response.organization.name !== organization) throw new ConnectError('Organization identity could not be verified.', Code.Internal);
    return response.organization;
  } });
  const authority = useQuery({ ...privateQuery, enabled, queryKey: ['organization-values-authority', userId, organization], queryFn: async ({ signal }) => {
    const response = await executionPolicyApi.getExecutionPolicy({ scope: ExecutionScope.ORGANIZATION, organization }, { signal, timeoutMs: 8000 });
    signal.throwIfAborted();
    const policy = response.policy;
    if (!policy || policy.scope !== ExecutionScope.ORGANIZATION || !identity(policy.scopeId) || policy.ownerId !== policy.scopeId || !policy.canEdit || !/^[a-f0-9]{64}$/.test(policy.authorityRevision)) throw new ConnectError('Current organization ownership could not be verified.', Code.PermissionDenied);
    return policy;
  } });
  const error = currentOrganization.error ?? authority.error;
  const ready = enabled && !error && currentOrganization.isSuccess && authority.isSuccess && !currentOrganization.isFetching && !authority.isFetching;
  const exact = ready && currentOrganization.data.id === authority.data.scopeId;
  const refresh = () => { void currentOrganization.refetch(); void authority.refetch(); };
  return <OrganizationSettingsLayout organization={organization}><section className="page-stack">
    <header className="repository-intro"><div><h1>Secrets and variables</h1><p>Share versioned values with selected repositories. Each workflow also requires its own source approval.</p></div></header>
    {signingOut ? <Loading label="Signing out…" /> : error ? <PanelError error={error} retry={refresh} /> : !ready ? <Loading label="Verifying organization ownership…" /> : !exact ? <p role="alert" className="error">Organization identity changed. Refresh before continuing.</p> : <OrganizationExecutionValues key={`${userId}/${organization}/${currentOrganization.data.id}`} client={organizationExecutionValueClient} userId={userId} organization={organization} organizationId={currentOrganization.data.id} signingOut={signingOut} canManage />}
  </section></OrganizationSettingsLayout>;
}
