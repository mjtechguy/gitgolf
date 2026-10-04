import { useRef } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Code, ConnectError } from '@connectrpc/connect';
import { repositoryAccessClient } from './api';
import { privateQuery } from './RepositoryUI';
import { sourceRepositoryID } from './sourceReads';
import type { RepositoryAccess } from './gen/golf/v1/golf_pb';

// Read-only settings pages share immutable identity and private refresh behavior.
export function useRepositorySettingsAccess(userId: string, owner: string, name: string, signingOut: boolean) {
  const query = useQuery({ ...privateQuery, queryKey: ['repository-settings-access', userId, owner, name], enabled: !signingOut,
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
  return { access: observed.current?.access, revalidating: query.isFetching, error: signingOut ? null : query.error, refresh: () => void query.refetch(), scope };
}
