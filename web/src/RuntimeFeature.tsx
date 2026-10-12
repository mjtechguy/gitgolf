import type { ReactNode } from 'react';
import { runtimeFeature } from './runtimeCapabilities';
import { useRuntimeCapabilities } from './useRuntimeCapabilities';

// Gate mounting as well as visibility, so unsupported editors make no requests.
export function RuntimeFeature({ id, children }: { id: string; children: ReactNode }) {
  const runtime = useRuntimeCapabilities();
  return runtimeFeature(runtime.isError ? undefined : runtime.data, id) ? children : null;
}
