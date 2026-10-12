import { useQuery } from '@tanstack/react-query';
import { capabilityClient } from './api';
export function useRuntimeCapabilities(enabled = true) {
  return useQuery({ queryKey: ['capabilities'], enabled, staleTime: 15000, queryFn: ({ signal }) => capabilityClient.listCapabilities({}, { signal, timeoutMs: 8000 }), refetchInterval: 30000 });
}
