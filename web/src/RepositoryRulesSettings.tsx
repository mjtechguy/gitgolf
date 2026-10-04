import { useRef } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Code, ConnectError } from '@connectrpc/connect';
import { ShieldCheck } from 'lucide-react';
import { repositoryAccessClient, repositoryRulesClient } from './api';
import { RepositorySettingsLayout } from './AccountSettings';
import { RepositoryRules } from './RepositoryRules';
import { Loading, PanelError, privateQuery } from './RepositoryUI';
import { sourceRepositoryID } from './sourceReads';
import type { RepositoryAccess } from './gen/golf/v1/golf_pb';

export function RepositoryRulesSettings({ userId, owner, name, signingOut }: { userId: string; owner: string; name: string; signingOut: boolean }) {
  const query = useQuery({ ...privateQuery, queryKey: ['repository-rules-access', userId, owner, name], enabled: !signingOut,
    queryFn: async ({ signal }) => {
      const response = await repositoryAccessClient.getRepositoryAccess({ repository: { owner, name } }, { signal, timeoutMs: 8000 });
      signal.throwIfAborted();
      const access = response.access;
      if (!access || !sourceRepositoryID(access.repositoryId) || !sourceRepositoryID(access.ownerId) || access.owner?.id !== access.ownerId || !/^[a-f0-9]{64}$/.test(access.revision)) throw new ConnectError('Repository identity could not be verified.', Code.Internal);
      return access;
    },
  });
  const scope = JSON.stringify([userId, owner, name]);
  const observed = useRef<{ scope: string; access: RepositoryAccess } | null>(null);
  if (observed.current?.scope !== scope || query.error || signingOut) observed.current = null;
  if (!signingOut && query.isSuccess && !query.isFetching) observed.current = { scope, access: query.data };
  return <RepositorySettingsLayout owner={owner} name={name}><section className="page-stack">
    <header className="repository-intro"><div><h1><ShieldCheck size={24} />Rules and merge policy</h1><p>Inspect current branch, tag and merge configuration.</p></div></header>
    {query.error && !signingOut ? <PanelError error={query.error} retry={() => void query.refetch()} /> : !observed.current ? <Loading label="Verifying repository access…" /> : null}
    {observed.current ? <RepositoryRules key={`${scope}/${observed.current.access.repositoryId}/${observed.current.access.ownerId}`} client={repositoryRulesClient} userId={userId} owner={owner} name={name} access={observed.current.access} signingOut={signingOut} revalidating={query.isFetching} /> : null}
  </section></RepositorySettingsLayout>;
}
