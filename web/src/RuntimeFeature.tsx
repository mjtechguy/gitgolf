import type { ReactNode } from 'react';
import { runtimeFeature } from './runtimeCapabilities';
import { useRuntimeCapabilities } from './useRuntimeCapabilities';

// Gate mounting as well as visibility, so unsupported editors make no requests.
export function RuntimeFeature({ id, children }: { id: string; children: ReactNode }) {
  const runtime = useRuntimeCapabilities();
  // A failed refresh keeps the last answer: one dropped request must not hide tabs until the next poll.
  return runtimeFeature(runtime.data, id) ? children : null;
}
