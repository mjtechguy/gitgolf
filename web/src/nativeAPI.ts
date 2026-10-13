import { Code, ConnectError } from '@connectrpc/connect';

class NativeError extends ConnectError { constructor(message: string, status: number) { super(message, status === 401 ? Code.Unauthenticated : status === 403 ? Code.PermissionDenied : status === 404 ? Code.NotFound : status === 412 ? Code.FailedPrecondition : status === 501 ? Code.Unimplemented : Code.Unavailable); } }
export async function nativeAPI<T>(path: string, body: object = {}, signal?: AbortSignal): Promise<T> {
  const response = await fetch(path, { method: 'POST', credentials: 'same-origin', redirect: 'error', signal,
    headers: { 'Content-Type': 'application/json', 'Connect-Protocol-Version': '1' }, body: JSON.stringify(body) });
  if (!response.headers.get('Content-Type')?.includes('application/json')) throw new NativeError('Access sign-in or the native API is unavailable. Reload to sign in.', response.status);
  const value = await response.json();
  // During a rolling update an older workspace may not know the read-only routes yet.
  const action = (body as { action?: string }).action;
  if (response.status === 501 && (path === '/native/pr-evidence/read' && ['list', 'status', 'report', 'compare'].includes(action || '') || path === '/native/pr-preview/read' && action === 'list'))
    return nativeAPI<T>(path.slice(0, -5), body, signal);
  if (!response.ok) throw new NativeError(typeof value.message === 'string' ? value.message : 'Request failed.', response.status);
  return value as T;
}
