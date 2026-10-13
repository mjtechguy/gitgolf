import { MutationCache, QueryCache, QueryClient } from '@tanstack/react-query';
import { Code, ConnectError } from '@connectrpc/connect';
import { fromJson } from '@bufbuild/protobuf';
import { GetSessionResponseSchema } from './gen/golf/v1/golf_pb';

export function forgetPrivateQueries(client: QueryClient) {
  const filter = { predicate: (query: { queryKey: readonly unknown[] }) => !['session', 'capabilities', 'authentication-options'].includes(String(query.queryKey[0])) };
  // Cancellation happens before removal so a late response cannot repopulate a signed-out session.
  void client.cancelQueries(filter);
  client.removeQueries(filter);
}

export function createQueryClient() {
  function onError(error: unknown, query?: { queryKey: readonly unknown[] }) {
    if (error instanceof ConnectError && error.code === Code.Unauthenticated) {
      client.setQueryData(['session'], null);
      forgetPrivateQueries(client);
    } else if (error instanceof ConnectError && error.code === Code.NotFound && query?.queryKey[0] === 'repository' && query.queryKey[4] === 'metadata' && query.queryKey[5] === 'sidebar') {
      // An older installation can lack overview; verify authority through the core read.
      void client.invalidateQueries({ queryKey: query.queryKey.slice(0, 5), exact: true });
    } else if (error instanceof ConnectError && (error.code === Code.PermissionDenied || error.code === Code.NotFound && ['metadata', 'access', 'source-access'].includes(String(query?.queryKey[4]))) && query?.queryKey[0] === 'repository') {
      const scope = query.queryKey.slice(0, 4);
      const filter = { predicate: (candidate: { queryKey: readonly unknown[]; meta?: Record<string, unknown>; getObserversCount(): number }) => candidate !== query && scope.every((value, index) => candidate.queryKey[index] === value) && (candidate.meta?.privateNavigation === true || candidate.getObserversCount() === 0) };
      void client.cancelQueries(filter); client.removeQueries(filter);
    }
  }
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: 30_000 } },
    queryCache: new QueryCache({ onError }),
    mutationCache: new MutationCache({ onError: error => onError(error) }),
  });
  const bootstrap = typeof document !== 'undefined' && document.documentElement.dataset.golfRuntime === 'cloudflare-native' ? document.getElementById('golf-session') : null;
  if (bootstrap) {
    try { const session = fromJson(GetSessionResponseSchema, JSON.parse(bootstrap.textContent || 'null')); if (session.user?.id) client.setQueryData(['session'], session.user); } catch { /* Older deployments use the session RPC. */ }
    bootstrap.remove();
  }
  let pruning = false;
  const measured = new WeakMap<object, { data: unknown; bytes: number }>();
  client.getQueryCache().subscribe(event => {
    if (pruning || !event.query.meta?.privateNavigation || !['updated', 'observerRemoved'].includes(event.type)) return;
    pruning = true;
    try {
      const retained = client.getQueryCache().findAll({ predicate: query => Boolean(query.meta?.privateNavigation) && query.state.data !== undefined });
      const sizes = new Map(retained.map(query => {
        let size = measured.get(query);
        if (!size || size.data !== query.state.data) { size = { data: query.state.data, bytes: new TextEncoder().encode(JSON.stringify(query.state.data ?? null, (_, value) => typeof value === 'bigint' ? value.toString() : value)).length }; measured.set(query, size); }
        return [query, size.bytes];
      }));
      let bytes = [...sizes.values()].reduce((sum, value) => sum + value, 0), count = retained.length;
      for (const query of retained.filter(query => !query.getObserversCount()).sort((a, b) => a.state.dataUpdatedAt - b.state.dataUpdatedAt)) {
        if (count <= 64 && bytes <= 8 * 1024 * 1024) break;
        client.removeQueries({ queryKey: query.queryKey, exact: true }); count--; bytes -= sizes.get(query)!;
      }
    } finally { pruning = false; }
  });
  return client;
}
