import { useQuery } from '@tanstack/react-query';
import { Code, ConnectError } from '@connectrpc/connect';
import { Rocket } from 'lucide-react';
import { accountSecurityClient, repositoryEnvironmentClient } from './api';
import { RepositorySettingsLayout } from './AccountSettings';
import { RepositoryEnvironments } from './RepositoryEnvironments';
import { PanelError, privateQuery } from './RepositoryUI';
import { sourceRepositoryID } from './sourceReads';

export function RepositoryEnvironmentSettings({ userId, owner, name, signingOut }: { userId: string; owner: string; name: string; signingOut: boolean }) {
  const security = useQuery({ ...privateQuery, queryKey: ['account-security', userId], enabled: !signingOut,
    queryFn: async ({ signal }) => {
      const response = await accountSecurityClient.getAccountSecurity({}, { signal, timeoutMs: 8000 });
      signal.throwIfAborted();
      const value = response.security;
      if (!value || value.userId !== userId || (value.canManage ? !sourceRepositoryID(value.accountId) || !sourceRepositoryID(value.credentialVersion) : value.accountId !== '' || value.credentialVersion !== '')) throw new ConnectError('Your Golf account could not be verified.', Code.Internal);
      return value;
    },
  });
  return <RepositorySettingsLayout owner={owner} name={name}><section className="page-stack">
    <header className="repository-intro"><div><h1><Rocket size={24} />Environments</h1><p>Configure named environments and protection policies. Deployment consumers are still being implemented.</p></div></header>
    {!signingOut && security.error ? <PanelError error={security.error} retry={() => void security.refetch()} /> : <RepositoryEnvironments client={repositoryEnvironmentClient} userId={userId} owner={owner} name={name} signingOut={signingOut} revalidating={Boolean(security.data && security.isFetching)} passwordConfirmationAvailable={security.isSuccess && !security.isFetching && security.data.canManage} />}
  </section></RepositorySettingsLayout>;
}
