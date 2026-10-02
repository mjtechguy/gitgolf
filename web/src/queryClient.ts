import { MutationCache, QueryCache, QueryClient } from '@tanstack/react-query';
import { Code, ConnectError } from '@connectrpc/connect';

export function forgetPrivateQueries(client: QueryClient) {
  const filter = { predicate: (query: { queryKey: readonly unknown[] }) => query.queryKey[0] !== 'session' && query.queryKey[0] !== 'capabilities' };
  // Cancellation happens before removal so a late response cannot repopulate a signed-out session.
  void client.cancelQueries(filter);
  client.removeQueries(filter);
}

export function createQueryClient() {
  function onError(error: Error) {
    if (error instanceof ConnectError && error.code === Code.Unauthenticated) {
      client.setQueryData(['session'], null);
      forgetPrivateQueries(client);
    }
  }
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: 30_000 } },
    queryCache: new QueryCache({ onError }),
    mutationCache: new MutationCache({ onError }),
  });
  return client;
}
