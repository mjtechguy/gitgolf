import { Code, ConnectError } from '@connectrpc/connect';

export async function rpcFetch(input: RequestInfo | URL, init?: RequestInit) {
  const response = await fetch(input, { ...init, credentials: 'same-origin', cache: 'no-store', redirect: 'manual' });
  // Access redirects must expire private observations instead of appearing as network failures.
  if (response.type === 'opaqueredirect' || response.status >= 300 && response.status < 400)
    throw new ConnectError('Sign-in is required. Reload Golf to continue through your installation’s sign-in page.', Code.Unauthenticated);
  return response;
}
