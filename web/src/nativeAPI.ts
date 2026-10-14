import { Code, ConnectError } from '@connectrpc/connect';

class NativeError extends ConnectError { readonly httpStatus: number; readonly body: unknown; constructor(message: string, status: number, body?: unknown) { super(message, status === 401 ? Code.Unauthenticated : status === 403 ? Code.PermissionDenied : status === 404 ? Code.NotFound : status === 412 ? Code.FailedPrecondition : status === 501 ? Code.Unimplemented : Code.Unavailable); this.httpStatus = status; this.body = body; } }
export async function nativeAPI<T>(path: string, body: object = {}, signal?: AbortSignal): Promise<T> {
  const response = await fetch(path, { method: 'POST', credentials: 'same-origin', redirect: 'error', signal,
    headers: { 'Content-Type': 'application/json', 'Connect-Protocol-Version': '1' }, body: JSON.stringify(body) });
  if (!response.headers.get('Content-Type')?.includes('application/json')) throw new NativeError('Access sign-in or the native API is unavailable. Reload to sign in.', response.status);
  const value = await response.json();
  // During a rolling update an older workspace may not know the read-only routes yet.
  const action = (body as { action?: string }).action;
  if (response.status === 501 && (path === '/native/pr-evidence/read' && ['list', 'status', 'report', 'compare'].includes(action || '') || path === '/native/pr-preview/read' && action === 'list'))
    return nativeAPI<T>(path.slice(0, -5), body, signal);
  // Right after a deploy the page can be newer than the Worker answering it; say so rather than "not implemented".
  if (response.status === 501) throw new NativeError('This installation’s Worker does not offer this yet. Right after a deploy it can take a few minutes to catch up; try again shortly.', 501);
  if (!response.ok) throw new NativeError(typeof value.message === 'string' ? value.message : 'Request failed.', response.status, value);
  return value as T;
}

// A busy or restarting Worker (429, 5xx, a dropped connection) is retried briefly; anything that is an answer is not.
// The JSON an error answer carried, for routes whose refusals include data (for example a log offset to resync to).
export const errorBody = (error: unknown) => error instanceof NativeError && error.body && typeof error.body === 'object' ? error.body as Record<string, unknown> : undefined;
// ConnectError's instanceof is structural, so `instanceof NativeError` holds for every RPC error too: tell them apart by the status field.
export const transientError = (error: unknown) => error instanceof ConnectError && [Code.Unavailable, Code.ResourceExhausted, Code.DeadlineExceeded].includes(error.code) &&
  (typeof (error as Partial<NativeError>).httpStatus !== 'number' || [0, 408, 429].includes((error as NativeError).httpStatus) || (error as NativeError).httpStatus >= 500 && (error as NativeError).httpStatus !== 501);
export const transientRetry = { retry: (failures: number, error: Error) => failures < 2 && transientError(error), retryDelay: (attempt: number) => 600 * 2 ** attempt };
