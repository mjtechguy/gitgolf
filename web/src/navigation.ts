export type RepositorySearch = {
  view: 'source' | 'commits' | 'issues';
  ref: string;
  path: string;
  branch: string;
  state: 'open' | 'closed' | 'all';
  issue?: number;
};
export const defaultRepositorySearch: RepositorySearch = { view: 'source', ref: '', path: '', branch: '', state: 'open' };
export type RepositoryLocation = RepositorySearch & { kind: 'repository'; owner: string; name: string };
export type Location = RepositoryLocation | { kind: 'home'; oauthFailed?: boolean } | { kind: 'missing' };

export function repositoryOptions(location: Pick<RepositoryLocation, 'owner' | 'name'> & Partial<RepositorySearch>, changes: Partial<RepositorySearch> = {}) {
  const next = { ...defaultRepositorySearch, ...location, ...changes };
  const search: RepositorySearch = {
    view: next.view, ref: next.ref, path: next.view === 'source' ? next.path : '', branch: next.branch,
    state: next.state, issue: next.view === 'issues' ? next.issue : undefined,
  };
  return { to: '/repositories/$owner/$name' as const, params: { owner: next.owner, name: next.name }, search, activeOptions: { exact: true } };
}
