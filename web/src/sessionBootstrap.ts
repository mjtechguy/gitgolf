import type { QueryClient } from '@tanstack/react-query';
import { fromJson } from '@bufbuild/protobuf';
import { GetSessionResponseSchema } from './gen/golf/v1/golf_pb';

// A Cloudflare-native page embeds the signed-in session, so the first render needs no session RPC.
export function seedBootstrapSession(client: QueryClient) {
  const bootstrap = document.documentElement.dataset.golfRuntime === 'cloudflare-native' ? document.getElementById('golf-session') : null;
  if (!bootstrap) return;
  try { const session = fromJson(GetSessionResponseSchema, JSON.parse(bootstrap.textContent || 'null')); if (session.user?.id) client.setQueryData(['session'], session.user); } catch { /* Older deployments use the session RPC. */ }
  bootstrap.remove();
}
