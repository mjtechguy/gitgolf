import { createClient, ConnectError } from '@connectrpc/connect';
import { createConnectTransport } from '@connectrpc/connect-web';
import { CapabilityService, RepositoryService, SessionService } from './gen/golf/v1/golf_pb';

const transport = createConnectTransport({
  baseUrl: '/rpc',
  useBinaryFormat: false,
  fetch: (input, init) => fetch(input, { ...init, credentials: 'same-origin', cache: 'no-store' }),
});

export const sessionClient = createClient(SessionService, transport);
export const repositoryClient = createClient(RepositoryService, transport);
export const capabilityClient = createClient(CapabilityService, transport);

export function errorMessage(error: Error) {
  return error instanceof ConnectError ? error.rawMessage : error.message;
}

// Never turn a forge-provided URL into an executable browser link.
export function repositoryLink(value: string): string | undefined {
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password ? url.href : undefined;
  } catch {
    return undefined;
  }
}
