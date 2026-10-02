import { useSyncExternalStore } from 'react';
import type { AnchorHTMLAttributes } from 'react';

export type RepositoryLocation = {
  kind: 'repository';
  owner: string;
  name: string;
  view: 'source' | 'commits' | 'issues';
  ref: string;
  path: string;
  branch: string;
  state: 'open' | 'closed' | 'all';
  issue?: number;
};
type Location = RepositoryLocation | { kind: 'home' | 'missing' };

function subscribe(listener: () => void) {
  window.addEventListener('popstate', listener);
  return () => window.removeEventListener('popstate', listener);
}

export function navigate(href: string, replace = false) {
  window.history[replace ? 'replaceState' : 'pushState'](null, '', href);
  window.dispatchEvent(new PopStateEvent('popstate'));
}

export function useLocation(): Location {
  const value = useSyncExternalStore(subscribe, () => window.location.pathname + window.location.search);
  const url = new URL(value, window.location.origin);
  if (url.pathname === '/') return { kind: 'home' };
  const parts = url.pathname.match(/^\/repositories\/([^/]+)\/([^/]+)\/?$/);
  if (!parts) return { kind: 'missing' };
  try {
    const owner = decodeURIComponent(parts[1]!);
    const name = decodeURIComponent(parts[2]!);
    if (!owner || !name || /[\/\\]/.test(owner + name)) return { kind: 'missing' };
    const params = url.searchParams;
    const view = params.get('view');
    const state = params.get('state');
    const issue = params.get('issue');
    if (issue !== null && (!/^[1-9]\d*$/.test(issue) || !Number.isSafeInteger(Number(issue)))) return { kind: 'missing' };
    return {
      kind: 'repository', owner, name,
      view: view === 'commits' || view === 'issues' ? view : 'source',
      ref: params.get('ref') || '', path: params.get('path') || '', branch: params.get('branch') || '',
      state: state === 'closed' || state === 'all' ? state : 'open',
      issue: issue === null ? undefined : Number(issue),
    };
  } catch { return { kind: 'missing' }; }
}

export function repositoryHref(owner: string, name: string) {
  return `/repositories/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`;
}

export function browserHref(location: RepositoryLocation, changes: Partial<RepositoryLocation> = {}) {
  const next = { ...location, ...changes };
  const params = new URLSearchParams();
  if (next.view !== 'source') params.set('view', next.view);
  if (next.ref) params.set('ref', next.ref);
  if (next.path && next.view === 'source') params.set('path', next.path);
  if (next.branch) params.set('branch', next.branch);
  if (next.view === 'issues') {
    if (next.state !== 'open') params.set('state', next.state);
    if (next.issue) params.set('issue', String(next.issue));
  }
  const query = params.toString();
  return repositoryHref(next.owner, next.name) + (query ? `?${query}` : '');
}

export function InternalLink({ href, onClick, ...props }: AnchorHTMLAttributes<HTMLAnchorElement> & { href: string }) {
  return <a {...props} href={href} onClick={(event) => {
    onClick?.(event);
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.altKey || event.shiftKey || props.target) return;
    event.preventDefault();
    navigate(href);
  }} />;
}
