export type RepositorySearch = {
  view: 'source' | 'commits' | 'issues' | 'pulls' | 'actions' | 'compare';
  ref: string;
  path: string;
  branch: string;
  tag?: string;
  refKind?: 'branch' | 'tag';
  refName?: string;
  state: 'open' | 'closed' | 'all';
  issue?: number;
  issueNew?: boolean;
  pull?: number;
  pullView?: 'conversation' | 'commits' | 'checks' | 'files';
  commit?: string;
  run?: string;
  runKind?: 'workflow' | 'coding-task' | 'review';
  actionKind?: 'workflow' | 'coding-task' | 'review';
  workflowPath?: string;
  step?: number;
  jobInstanceId?: string;
  stepId?: string;
  base?: string;
  head?: string;
  sourceOwner?: string;
  sourceName?: string;
  historyPath?: string;
};
export const defaultRepositorySearch: RepositorySearch = { view: 'source', ref: '', path: '', branch: '', state: 'open' };
export type RepositoryLocation = RepositorySearch & { kind: 'repository'; owner: string; name: string; sourceSuffix?: string; sourceRoute?: 'tree' | 'blob' };
export type OrganizationLocation = { kind: 'organizations'; organization?: string; team?: string };
export type Location = RepositoryLocation | OrganizationLocation | { kind: 'repository-webhooks' | 'repository-settings' | 'repository-access-settings' | 'repository-workflows'; owner: string; name: string } | { kind: 'organization-team-settings'; organization: string; teamId: string } | { kind: 'organization-settings'; organization: string } | { kind: 'instance-settings'; view?: 'overview' | 'accounts' | 'execution' | 'organizations' | 'infrastructure' | 'agents' | 'notifications' } | { kind: 'status' } | { kind: 'audit' } | { kind: 'api-credentials' } | { kind: 'ssh-keys' } | { kind: 'account-agents' } | { kind: 'account-security' } | { kind: 'settings' } | { kind: 'sessions' } | { kind: 'home'; oauthFailed?: boolean } | { kind: 'missing' };
export const isRunID = (value: string) => /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value);
export const isWorkflowJobInstanceID = (value:string) => /^[a-f0-9]{32}$/.test(value);
export const isWorkflowStepID = (value:string) => /^(?:[A-Za-z_][A-Za-z0-9_-]{0,63}|0|[1-9][0-9]{0,2})$/.test(value);
export const isCommitID = (value: string) => /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value);

export function organizationOptions({ organization, team }: { organization: string; team?: string }) {
  return { to: '/organizations/$organization' as const, params: { organization }, search: { team }, activeOptions: { exact: true } };
}

export function repositoryOptions(location: Pick<RepositoryLocation, 'owner' | 'name'> & Partial<RepositorySearch>, changes: Partial<RepositorySearch> = {}, sourceKind?:'file') {
  const next = { ...defaultRepositorySearch, ...location, ...changes };
  if (changes.ref !== undefined && changes.ref !== location.ref && changes.refKind === undefined) { next.refKind = undefined; next.refName = undefined; }
  if(changes.run!==undefined&&changes.run!==location.run&&changes.jobInstanceId===undefined){next.jobInstanceId=undefined;next.stepId=undefined;if(changes.step===undefined)next.step=undefined;}
  if(next.view === 'commits') { next.refKind=undefined; next.refName=undefined; }
  const search: RepositorySearch = {
    view: next.view, ref: next.ref, path: next.view === 'source' ? next.path : '', branch: next.branch, tag: next.tag,
    refKind: next.refKind, refName: next.refName,
    state: next.view === 'issues' || next.view === 'pulls' ? next.state : 'open', issue: next.view === 'issues' ? next.issue : undefined,
    issueNew:next.view==='issues'&&!next.issue?next.issueNew:undefined,
    pull: next.view === 'pulls' ? next.pull : undefined,
    pullView: next.view === 'pulls' && next.pull ? next.pullView : undefined,
    commit: next.view === 'commits' ? next.commit : undefined,
    run: next.view === 'actions' ? next.run : undefined,
    runKind: next.view==='actions'&&next.run?next.runKind:undefined,
    actionKind:next.view==='actions'?next.actionKind:undefined,workflowPath:next.view==='actions'?next.workflowPath:undefined,
    step: next.view === 'actions' && next.run && !next.jobInstanceId ? next.step : undefined,
    jobInstanceId: next.view==='actions'&&next.run&&(!next.runKind||next.runKind==='workflow')?next.jobInstanceId:undefined,
    stepId: next.view==='actions'&&next.run&&next.jobInstanceId&&(!next.runKind||next.runKind==='workflow')?next.stepId:undefined,
    base:next.view==='compare'?next.base:undefined,head:next.view==='compare'?next.head:undefined,
    sourceOwner:next.view==='compare'?next.sourceOwner:undefined,sourceName:next.view==='compare'?next.sourceName:undefined,
    historyPath:next.view==='commits'&&!next.commit?next.historyPath:undefined,
  };
  const params = {owner:next.owner,name:next.name};
  let path = '';
  if(next.view==='compare')path='compare';
  else if(next.view==='issues') path=next.issueNew&&!next.issue?'issues/new':next.issue?`issues/${next.issue}`:'issues';
  else if(next.view==='pulls') path=next.pull?`pull/${next.pull}${next.pullView&&next.pullView!=='conversation'?'/'+next.pullView:''}`:'pulls';
  else if(next.view==='actions') path=next.run?`actions/${next.runKind==='coding-task'?'tasks':next.runKind==='review'?'reviews':'runs'}/${next.run}`:'actions';
  else if(next.view==='commits') path=next.commit?`commit/${next.commit}`:next.historyPath&&isCommitID(next.ref)?`commits/${next.ref}/${next.historyPath}`:'commits';
  else if(next.refKind && next.refName) path=`${sourceKind==='file'?'blob':'tree'}/${next.refName}${next.path?`/${next.path}`:''}`;
  else if(isCommitID(next.ref)) path=`${sourceKind==='file'?'blob':'tree'}/${next.ref}${next.path?`/${next.path}`:''}`;
  // Canonical paths carry their own view and detail selectors. Keep only
  // deliberate source/history return context and relevant list filters.
  search.view = 'source'; search.path = '';
  if(next.view==='source'&&next.refKind){search.branch='';search.tag=undefined;}
  search.issue = undefined; search.issueNew = undefined; search.pull = undefined; search.pullView = undefined; search.commit = undefined; search.run = undefined; search.runKind=undefined;
  if (next.view === 'commits' && next.historyPath && isCommitID(next.ref)) search.historyPath = undefined;
  // The path is authoritative for source and path-history snapshots.
  if ((next.view === 'source' && (isCommitID(next.ref) || Boolean(next.refKind))) || (next.view === 'commits' && !next.commit && next.historyPath && isCommitID(next.ref))) search.ref = '';
  return {to:'/$owner/$name/$' as const,params:{...params,_splat:path},search,activeOptions:{exact:true}};
}

// Browsing retains an explicit named address; immutable operations use commitId.
export function sourceOptions(location: RepositoryLocation, commitId: string, path: string, file = false) {
  return repositoryOptions(location, { view: 'source', ref: location.refKind ? location.refName || '' : commitId, path, historyPath: undefined }, file ? 'file' : undefined);
}
