export type User = { id: number; login: string; full_name: string; avatar_url: string };
export type Repository = {
  id: number;
  name: string;
  full_name: string;
  description: string;
  private: boolean;
  html_url: string;
  default_branch: string;
  updated_at: string;
};
export type RepositoryPage = { repositories: Repository[]; next_page?: number };
export type Capability = { id: string; label: string; state: string; reason: string };

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, {
      ...options,
      credentials: 'same-origin',
      headers: { ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...options.headers },
    });
  } catch {
    throw new ApiError(0, 'Golf could not be reached. Check your connection and try again.');
  }
  const body: unknown = response.status === 204 ? undefined : await response.json().catch(() => undefined);
  if (!response.ok) {
    const error = typeof body === 'object' && body !== null && 'error' in body ? body.error : undefined;
    const detail = typeof error === 'object' && error !== null && 'message' in error && typeof error.message === 'string'
      ? error.message
      : typeof error === 'string' ? error
      : typeof body === 'object' && body !== null && 'message' in body && typeof body.message === 'string'
        ? body.message
        : `The request failed (${response.status}). Please try again.`;
    throw new ApiError(response.status, detail);
  }
  return body as T;
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
