export type RepositorySearch = {
  view: 'source' | 'commits' | 'issues' | 'pulls' | 'actions';
  ref: string;
  path: string;
  branch: string;
  state: 'open' | 'closed' | 'all';
  issue?: number;
  pull?: number;
  pullView?: 'conversation' | 'files';
  commit?: string;
  run?: string;
  step?: number;
};
export const defaultRepositorySearch: RepositorySearch = { view: 'source', ref: '', path: '', branch: '', state: 'open' };
export type RepositoryLocation = RepositorySearch & { kind: 'repository'; owner: string; name: string };
export type OrganizationLocation = { kind: 'organizations'; organization?: string; team?: string };
export type Location = RepositoryLocation | OrganizationLocation | { kind: 'repository-settings' | 'repository-access-settings' | 'repository-workflows'; owner: string; name: string } | { kind: 'organization-team-settings'; organization: string; teamId: string } | { kind: 'organization-settings'; organization: string } | { kind: 'instance-settings'; view?: 'overview' | 'accounts' | 'execution' | 'organizations' | 'infrastructure' | 'agents' } | { kind: 'status' } | { kind: 'audit' } | { kind: 'api-credentials' } | { kind: 'ssh-keys' } | { kind: 'account-agents' } | { kind: 'account-security' } | { kind: 'settings' } | { kind: 'sessions' } | { kind: 'home'; oauthFailed?: boolean } | { kind: 'missing' };
export const isRunID = (value: string) => /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value);
export const isCommitID = (value: string) => /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value);

export function organizationOptions({ organization, team }: { organization: string; team?: string }) {
  return { to: '/organizations/$organization' as const, params: { organization }, search: { team }, activeOptions: { exact: true } };
}

export function repositoryOptions(location: Pick<RepositoryLocation, 'owner' | 'name'> & Partial<RepositorySearch>, changes: Partial<RepositorySearch> = {}, sourceKind?:'file') {
  const next = { ...defaultRepositorySearch, ...location, ...changes };
  const search: RepositorySearch = {
    view: next.view, ref: next.ref, path: next.view === 'source' ? next.path : '', branch: next.branch,
    state: next.state, issue: next.view === 'issues' ? next.issue : undefined,
    pull: next.view === 'pulls' ? next.pull : undefined,
    pullView: next.view === 'pulls' && next.pull ? next.pullView : undefined,
    commit: next.view === 'commits' ? next.commit : undefined,
    run: next.view === 'actions' ? next.run : undefined,
    step: next.view === 'actions' && next.run ? next.step : undefined,
  };
  const params = {owner:next.owner,name:next.name};
  let path = '';
  if(next.view==='issues') path=next.issue?`issues/${next.issue}`:'issues';
  else if(next.view==='pulls') path=next.pull?`pull/${next.pull}${next.pullView==='files'?'/files':''}`:'pulls';
  else if(next.view==='actions') path=next.run?`actions/runs/${next.run}`:'actions';
  else if(next.view==='commits') path=next.commit?`commit/${next.commit}`:'commits';
  else if(isCommitID(next.ref)) path=`${sourceKind==='file'?'blob':'tree'}/${next.ref}${next.path?`/${next.path}`:''}`;
  return {to:'/$owner/$name/$' as const,params:{...params,_splat:path},search,activeOptions:{exact:true}};
}
