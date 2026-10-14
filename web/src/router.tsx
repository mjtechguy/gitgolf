import { useMemo } from 'react';
import { createRootRoute, createRoute, createRouter, notFound, isNotFound, redirect, useMatches, stripSearchParams } from '@tanstack/react-router';
import { App } from './App';
import { defaultRepositorySearch, isCommitID, isRunID, isWorkflowJobInstanceID, isWorkflowStepID } from './navigation';
import { sourcePath, sourceRef, sourceRepositoryID } from './sourceReads';
import type { Location, RepositorySearch } from './navigation';

type LocationMatch = { params: { owner: string; name: string; organization: string; teamId: string; _splat?: string }; search: RepositorySearch & { repositoryId: string; auth_error?: string; team?: string; query?: string; topic?: string } };
declare module '@tanstack/react-router' {
  interface StaticDataRouteOption { golfLocation?: (match: LocationMatch) => Location }
}
function RoutedApp() {
  const matches = useMatches();
  const failed = matches.find(match => match.status === 'error' || match.status === 'notFound' || match._notFound);
  const match = matches.at(-1);
  const params = match?.params, search = match?.search, resolve = match?.staticData.golfLocation;
  // Router pending-state updates must not restart panel navigation effects.
  const location = useMemo(() => !failed && resolve ? resolve({params, search} as unknown as LocationMatch) : {kind:'missing' as const}, [failed, resolve, params, search]);
  if (failed) {
    if (failed.status === 'notFound' || failed._notFound || isNotFound(failed.error)) return <App location={{kind:'missing'}}/>;
    throw failed.error;
  }
  return <App location={location} />;
}

const rootRoute = createRootRoute({
  component: RoutedApp,
  notFoundComponent: () => <App location={{ kind: 'missing' }} />,
  errorComponent: ({ error }) => isNotFound(error) || error instanceof Error && isNotFound(error.cause) ? <App location={{ kind: 'missing' }} /> : <main className="page-stack"><section className="browser-panel credential-form-content"><h1>Golf could not load this page.</h1><p>The page or its required assets are unavailable. Reload to check your sign-in and fetch the current version.</p><button className="button primary" onClick={() => window.location.reload()}>Reload Golf</button></section></main>,
});
const homeRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/',
  validateSearch: (search: Record<string, unknown>): { auth_error?: 'oauth_failed' } => ({
    auth_error: search.auth_error === 'oauth_failed' ? 'oauth_failed' : undefined,
  }),
  staticData: { golfLocation: HomePage },
});
const publicProfileRoute = createRoute({
  getParentRoute: () => rootRoute, path: '/$owner',
  beforeLoad: ({ params }) => { if (!/^[a-z0-9][a-z0-9-]{0,38}$/.test(params.owner)) throw notFound(); },
  staticData: { golfLocation: match => ({ kind: 'public-profile', owner: match.params.owner }) },
});
const exploreRoute = createRoute({
  getParentRoute: () => rootRoute, path: '/explore',
  validateSearch: (search: Record<string, unknown>): { query?: string; topic?: string } => ({ query: typeof search.query === 'string' ? search.query.slice(0,100) : undefined, topic: typeof search.topic === 'string' ? search.topic.slice(0,35) : undefined }),
  staticData: { golfLocation: match => ({ kind: 'explore', query: match.search.query, topic: match.search.topic }) },
});
const organizationsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/organizations',
  staticData: { golfLocation: () => ({ kind: 'organizations' }) },
});
const notificationInboxRoute=createRoute({getParentRoute:()=>rootRoute,path:'/notifications',staticData: { golfLocation: () => ({kind:'notifications'}) }});
const statusRoute = createRoute({ getParentRoute: () => rootRoute, path: '/status', staticData: { golfLocation: () => ({ kind: 'status' }) } });
const auditRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/audit',
  staticData: { golfLocation: () => ({ kind: 'audit' }) },
});
const apiCredentialsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/account/api-credentials',
  staticData: { golfLocation: () => ({ kind: 'api-credentials' }) },
});
const accountConnectionsRoute=createRoute({getParentRoute:()=>rootRoute,path:'/account/connections',staticData: { golfLocation: () => ({kind:'account-connections'}) }});
const accountAgentsRoute = createRoute({ getParentRoute: () => rootRoute, path: '/account/agents', staticData: { golfLocation: () => ({ kind: 'account-agents' }) } });
const accountInvitationsRoute = createRoute({ getParentRoute: () => rootRoute, path: '/account/invitations', staticData: { golfLocation: () => ({ kind: 'account-invitations' }) } });
const accountSecurityRoute = createRoute({ getParentRoute: () => rootRoute, path: '/account/security', staticData: { golfLocation: () => ({ kind: 'account-security' }) } });
const settingsRoute = createRoute({
  getParentRoute: () => rootRoute, path: '/account/settings',
  staticData: { golfLocation: () => ({ kind: 'settings' }) },
});
const sessionsRoute = createRoute({
  getParentRoute: () => rootRoute, path: '/account/sessions',
  staticData: { golfLocation: () => ({ kind: 'sessions' }) },
});
const sshKeysRoute = createRoute({
  getParentRoute: () => rootRoute, path: '/account/ssh-keys',
  staticData: { golfLocation: () => ({ kind: 'ssh-keys' }) },
});
function validateRepositoryIdentity(owner: string, name: string) {
  if (!owner || !name || /[\/\\]/.test(owner + name)) throw notFound();
}
const canonicalRepositorySettingsRoute = createRoute({
  getParentRoute: () => rootRoute, path: '/$owner/$name/settings',
  beforeLoad: ({ params }) => validateRepositoryIdentity(params.owner, params.name),
  staticData: { golfLocation: RepositorySettingsPage },
});
// The original native identity survives repository absence. Do not resolve this
// route through repository metadata or adopt a replacement at the same address.
const canonicalRepositoryDeletionRoute = createRoute({
  getParentRoute: () => rootRoute, path: '/$owner/$name/settings/deletion',
  beforeLoad: ({ params }) => validateRepositoryIdentity(params.owner, params.name),
  validateSearch: (search: Record<string, unknown>): { repositoryId: string } => {
    const id = search.repositoryId;
    if (typeof id !== 'string' || !/^[1-9][0-9]{0,18}$/.test(id) || BigInt(id) > 9223372036854775807n) throw notFound();
    return { repositoryId: id };
  },
  staticData: { golfLocation: (match) => { const { owner, name } = match.params; const { repositoryId } = match.search; return { kind: 'repository-deletion', owner, name, repositoryId }; } },
});
const canonicalRepositoryAccessSettingsRoute = createRoute({
  getParentRoute: () => rootRoute, path: '/$owner/$name/settings/access',
  beforeLoad: ({ params }) => validateRepositoryIdentity(params.owner, params.name),
  staticData: { golfLocation: (match) => { const { owner, name } = match.params; return { kind: 'repository-access-settings', owner, name }; } },
});
const canonicalRepositoryGitRoute=createRoute({getParentRoute:()=>rootRoute,path:'/$owner/$name/settings/git',beforeLoad:({params})=>validateRepositoryIdentity(params.owner,params.name),staticData: { golfLocation: (match) => {const {owner,name}=match.params;return {kind:'repository-git',owner,name}; } }});
const canonicalRepositoryRulesRoute=createRoute({getParentRoute:()=>rootRoute,path:'/$owner/$name/settings/rules',beforeLoad:({params})=>validateRepositoryIdentity(params.owner,params.name),staticData: { golfLocation: (match) => {const {owner,name}=match.params;return {kind:'repository-rules',owner,name}; } }});
const canonicalRepositoryRunnersRoute=createRoute({getParentRoute:()=>rootRoute,path:'/$owner/$name/settings/runners',beforeLoad:({params})=>validateRepositoryIdentity(params.owner,params.name),staticData: { golfLocation: (match) => {const {owner,name}=match.params;return {kind:'repository-runners',owner,name}; } }});
const canonicalRepositorySecretsRoute=createRoute({getParentRoute:()=>rootRoute,path:'/$owner/$name/settings/secrets',beforeLoad:({params})=>validateRepositoryIdentity(params.owner,params.name),staticData: { golfLocation: (match) => {const {owner,name}=match.params;return {kind:'repository-secrets',owner,name}; } }});
const canonicalRepositoryEnvironmentsRoute=createRoute({getParentRoute:()=>rootRoute,path:'/$owner/$name/settings/environments',beforeLoad:({params})=>validateRepositoryIdentity(params.owner,params.name),staticData: { golfLocation: (match) => {const {owner,name}=match.params;return {kind:'repository-environments',owner,name}; } }});
const canonicalRepositoryWebhooksRoute=createRoute({getParentRoute:()=>rootRoute,path:'/$owner/$name/settings/webhooks',beforeLoad:({params})=>validateRepositoryIdentity(params.owner,params.name),staticData: { golfLocation: (match) => {const {owner,name}=match.params;return {kind:'repository-webhooks',owner,name}; } }});
const canonicalRepositoryWorkflowsRoute = createRoute({
  getParentRoute: () => rootRoute, path: '/$owner/$name/settings/workflows',
  beforeLoad: ({ params }) => validateRepositoryIdentity(params.owner, params.name),
  staticData: { golfLocation: (match) => { const { owner, name } = match.params; return { kind: 'repository-workflows', owner, name }; } },
});
// Old links normalize without probing repository data or changing page authority.
const repositorySettingsRoute = createRoute({
  getParentRoute: () => rootRoute, path: '/repositories/$owner/$name/settings',
  beforeLoad: ({ params, location }) => { validateRepositoryIdentity(params.owner, params.name); throw redirect({ to: '/$owner/$name/settings', params, hash: location.hash, replace: true }); },
});
const repositoryAccessSettingsRoute = createRoute({
  getParentRoute: () => rootRoute, path: '/repositories/$owner/$name/settings/access',
  beforeLoad: ({ params, location }) => { validateRepositoryIdentity(params.owner, params.name); throw redirect({ to: '/$owner/$name/settings/access', params, hash: location.hash, replace: true }); },
});
const repositoryWorkflowsRoute = createRoute({
  getParentRoute: () => rootRoute, path: '/repositories/$owner/$name/settings/workflows',
  beforeLoad: ({ params, location }) => { validateRepositoryIdentity(params.owner, params.name); throw redirect({ to: '/$owner/$name/settings/workflows', params, hash: location.hash, replace: true }); },
});
const organizationSettingsRoute = createRoute({
  getParentRoute: () => rootRoute, path: '/organizations/$organization/settings',
  beforeLoad: ({ params }) => { if (!params.organization || /[\/\\]/.test(params.organization)) throw notFound(); },
  staticData: { golfLocation: OrganizationSettingsPage },
});
const organizationLabelsRoute = createRoute({ getParentRoute: () => rootRoute, path: '/organizations/$organization/settings/labels', beforeLoad: ({params}) => {if(!params.organization || /[\/\\]/.test(params.organization))throw notFound();}, staticData: { golfLocation: (match) => {const {organization}=match.params;return {kind:'organization-labels',organization}; } } });
const organizationSecretsRoute = createRoute({ getParentRoute: () => rootRoute, path: '/organizations/$organization/settings/secrets', beforeLoad: ({ params }) => { if (!params.organization || /[\/\\]/.test(params.organization)) throw notFound(); }, staticData: { golfLocation: (match) => { const { organization } = match.params; return { kind: 'organization-secrets', organization }; } } });
const organizationTeamSettingsRoute = createRoute({
  getParentRoute: () => rootRoute, path: '/organizations/$organization/teams/$teamId/settings',
  beforeLoad: ({ params }) => { if (!params.organization || /[\/\\]/.test(params.organization) || !/^[1-9][0-9]{0,18}$/.test(params.teamId) || BigInt(params.teamId) > 9223372036854775807n) throw notFound(); },
  staticData: { golfLocation: OrganizationTeamSettingsPage },
});
const instanceExecutionRoute = createRoute({ getParentRoute: () => rootRoute, path: '/admin/execution', staticData: { golfLocation: () => ({ kind: 'instance-settings', view: 'execution' }) } });
const instanceOrganizationsRoute = createRoute({ getParentRoute: () => rootRoute, path: '/admin/organizations', staticData: { golfLocation: () => ({ kind: 'instance-settings', view: 'organizations' }) } });
const instanceAgentsRoute = createRoute({ getParentRoute: () => rootRoute, path: '/admin/agents', staticData: { golfLocation: () => ({ kind: 'instance-settings', view: 'agents' }) } });
const instanceNotificationsRoute = createRoute({ getParentRoute: () => rootRoute, path: '/admin/settings/notifications', staticData: { golfLocation: () => ({ kind: 'instance-settings', view: 'notifications' }) } });
const instanceRunnersRoute = createRoute({ getParentRoute: () => rootRoute, path: '/admin/settings/runners', staticData: { golfLocation: () => ({ kind: 'instance-settings', view: 'runners' }) } });
const instanceInfrastructureRoute = createRoute({ getParentRoute: () => rootRoute, path: '/admin/settings/infrastructure', staticData: { golfLocation: () => ({ kind: 'instance-settings', view: 'infrastructure' }) } });
const instanceAuditRoute = createRoute({ getParentRoute: () => rootRoute, path: '/admin/audit', staticData: { golfLocation: () => ({ kind: 'instance-settings', view: 'audit' }) } });
const instanceCapabilitiesRoute = createRoute({ getParentRoute: () => rootRoute, path: '/admin/capabilities', staticData: { golfLocation: () => ({ kind: 'instance-settings', view: 'capabilities' }) } });
const instanceOperationsRoute = createRoute({ getParentRoute: () => rootRoute, path: '/admin/operations', staticData: { golfLocation: () => ({ kind: 'instance-settings', view: 'operations' }) } });
const instanceOverviewRoute = createRoute({ getParentRoute: () => rootRoute, path: '/admin', staticData: { golfLocation: () => ({ kind: 'instance-settings', view: 'overview' }) } });
const instanceSettingsRoute = createRoute({ getParentRoute: () => rootRoute, path: '/admin/settings', staticData: { golfLocation: () => ({ kind: 'instance-settings' }) } });
const organizationRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/organizations/$organization',
  validateSearch: (search: Record<string, unknown>): { team?: string } => ({
    team: search.team === undefined ? undefined : typeof search.team === 'string' ? search.team : '',
  }),
  beforeLoad: ({ params, search }) => {
    if (!params.organization || /[\/\\]/.test(params.organization)) throw notFound();
    if (search.team !== undefined && (!/^[1-9][0-9]{0,18}$/.test(search.team) || BigInt(search.team) > 9223372036854775807n)) throw notFound();
  },
  staticData: { golfLocation: OrganizationPage },
});
const validateRepositorySearch = (search: Record<string, unknown>): RepositorySearch => {
    if (search.refKind !== undefined && search.refKind !== 'branch' && search.refKind !== 'tag' || (search.refKind === undefined) !== (search.refName === undefined) || search.refName !== undefined && (typeof search.refName !== 'string' || !sourceRef(search.refName))) throw notFound();
    if(search.runKind!==undefined&&!['workflow','coding-task','review'].includes(String(search.runKind))||search.actionKind!==undefined&&!['workflow','coding-task','review'].includes(String(search.actionKind))||search.workflowPath!==undefined&&(typeof search.workflowPath!=='string'||!search.workflowPath||!sourcePath(search.workflowPath)||search.actionKind!=='workflow'))throw notFound();
    const textBytes=(value:string)=>new TextEncoder().encode(value).length;
    for(const key of ['q','author','assignee','labels','milestone','sort'] as const) if(search[key]!==undefined&&typeof search[key]!=='string')throw notFound();
    if(typeof search.q==='string'&&(textBytes(search.q)>512||/[\p{Cc}\p{Cs}]/u.test(search.q)))throw notFound();
    for(const key of ['author','assignee'] as const)if(typeof search[key]==='string'&&search[key]!==''&&(!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/.test(search[key])))throw notFound();
    if(typeof search.milestone==='string'&&(textBytes(search.milestone)>255||/[\p{Cc}\p{Cs}]/u.test(search.milestone)))throw notFound();
    if(typeof search.labels==='string'&&(search.labels.split(',').length>20||search.labels.split(',').some(value=>textBytes(value)>255||/[\p{Cc}\p{Cs}]/u.test(value))))throw notFound();
    if(search.sort!==undefined&&!['newest','oldest','updated','least-updated','most-commented','least-commented'].includes(search.sort as string))throw notFound();
    const issue = search.issue === undefined ? undefined : typeof search.issue === 'number' ? search.issue : typeof search.issue === 'string' && /^[1-9][0-9]*$/.test(search.issue) ? Number(search.issue) : NaN;
    const pull = search.pull === undefined ? undefined : typeof search.pull === 'number' ? search.pull : typeof search.pull === 'string' && /^[1-9][0-9]*$/.test(search.pull) ? Number(search.pull) : NaN;
    return {
      view: search.view === 'commits' || search.view === 'issues' || search.view === 'pulls' || search.view === 'actions' || search.view === 'compare' || search.view === 'releases' || search.view === 'deployments' || search.view === 'branches' || search.view === 'tags' || search.view === 'wiki' || search.view === 'packages' || search.view === 'agents' ? search.view : 'source',
      q:typeof search.q==='string'?search.q:undefined,author:typeof search.author==='string'?search.author:undefined,assignee:typeof search.assignee==='string'?search.assignee:undefined,labels:typeof search.labels==='string'?search.labels:undefined,milestone:typeof search.milestone==='string'?search.milestone:undefined,sort:search.sort as RepositorySearch['sort'],
      ref: typeof search.ref === 'string' ? search.ref : '', path: typeof search.path === 'string' ? search.path : '',
      base:typeof search.base==='string'?search.base:undefined,head:typeof search.head==='string'?search.head:undefined,sourceOwner:typeof search.sourceOwner==='string'?search.sourceOwner:undefined,sourceName:typeof search.sourceName==='string'?search.sourceName:undefined,
      branch: typeof search.branch === 'string' ? search.branch : '',
      tag: typeof search.tag === 'string' ? search.tag : undefined,
      refKind: search.refKind as RepositorySearch['refKind'], refName: search.refName as string | undefined,
      historyPath:typeof search.historyPath==='string'?search.historyPath:undefined,
      issueNew:search.issueNew===true?true:undefined,
      state: search.state === 'closed' || search.state === 'all' ? search.state : 'open', issue, pull,
      pullView: search.pullView === 'files' || search.pullView === 'commits' || search.pullView === 'checks' ? search.pullView : undefined,
      deploymentId:search.deploymentId===undefined?undefined:typeof search.deploymentId==='string'?search.deploymentId:'',
      wikiPage:search.wikiPage===undefined?undefined:typeof search.wikiPage==='string'?search.wikiPage:'',
      releaseId:search.releaseId===undefined?undefined:typeof search.releaseId==='string'?search.releaseId:'',
      commit: search.commit === undefined ? undefined : typeof search.commit === 'string' ? search.commit : '',
      runKind:search.runKind as RepositorySearch['runKind'],actionKind:search.actionKind as RepositorySearch['actionKind'],workflowPath:search.workflowPath as string|undefined,
      run: search.run === undefined ? undefined : typeof search.run === 'string' ? search.run : '',
      jobInstanceId:search.jobInstanceId===undefined?undefined:typeof search.jobInstanceId==='string'?search.jobInstanceId:'',
      stepId:search.stepId===undefined?undefined:typeof search.stepId==='string'?search.stepId:'',
      step: search.step === undefined ? undefined : typeof search.step === 'number' ? search.step : typeof search.step === 'string' && /^(0|[1-9][0-9]*)$/.test(search.step) ? Number(search.step) : NaN,
    };
  };
function validateRepositorySelectors(search: RepositorySearch) {
  if(search.wikiPage!==undefined&&(search.view!=='wiki'||!search.wikiPage||search.wikiPage.length>1024||! /^[A-Za-z0-9_.~+%\-]+$/.test(search.wikiPage)||search.wikiPage==='.'||search.wikiPage==='..'))throw notFound();
  if(search.wikiPage!==undefined){try{decodeURIComponent(search.wikiPage.replaceAll('+',' '));}catch{throw notFound();}}
  if (search.deploymentId !== undefined && (search.view !== 'deployments' || !isRunID(search.deploymentId))) throw notFound();
  if (search.releaseId !== undefined && (search.view !== 'releases' || !sourceRepositoryID(search.releaseId))) throw notFound();
  if (search.pull !== undefined && (!Number.isSafeInteger(search.pull) || search.pull <= 0 || search.pull > 0x7fffffff)) throw notFound();
  if (search.issue !== undefined && (!Number.isSafeInteger(search.issue) || search.issue <= 0 || search.issue > 0xffffffff)) throw notFound();
  if (search.commit !== undefined && !isCommitID(search.commit)) throw notFound();
  if (search.run !== undefined && !isRunID(search.run)) throw notFound();
  if (search.runKind&&search.runKind!=='workflow'&&search.step!==undefined)throw notFound();
  if(search.jobInstanceId!==undefined&&!isWorkflowJobInstanceID(search.jobInstanceId)||search.stepId!==undefined&&(!isWorkflowStepID(search.stepId)||search.jobInstanceId===undefined)||search.jobInstanceId!==undefined&&search.step!==undefined||search.runKind&&search.runKind!=='workflow'&&(search.jobInstanceId!==undefined||search.stepId!==undefined))throw notFound();
  if (search.step !== undefined && (!Number.isInteger(search.step) || search.step < 0 || search.step > 49)) throw notFound();
}
const repositoryRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/repositories/$owner/$name',
  validateSearch: validateRepositorySearch,
  beforeLoad: ({ params, search }) => {
    validateRepositoryIdentity(params.owner, params.name);
    validateRepositorySelectors(search);
    if(search.runKind&&!search.run||search.jobInstanceId!==undefined&&(search.view!=='actions'||!search.run))throw notFound();
  },
  search: { middlewares: [stripSearchParams(defaultRepositorySearch)] },
  staticData: { golfLocation: RepositoryPage },
});

// Explicitly keep legacy query URLs readable. New navigation uses familiar
// repository paths; immutable source IDs avoid slash-ref ambiguity.
function canonicalLocation(owner:string,name:string,tail:string,search:RepositorySearch) {
  validateRepositoryIdentity(owner, name);
  validateRepositorySelectors(search);
  const location={...search,owner,name,kind:'repository' as const};
  if(search.jobInstanceId!==undefined&&!(tail?tail.startsWith('actions/runs/'):search.view==='actions'&&search.run))throw notFound();
  if(!tail) return location;
  const parts=tail.split('/');
  const item=parts[1]||'';
  if(parts[0]==='tree'||parts[0]==='blob') {
    const suffix=parts.slice(1).join('/');
    if (!suffix || !sourcePath(suffix)) throw notFound();
    if (search.refKind) {
      const name=search.refName!;
      if(search.refKind==='tag'&&search.branch===name||search.refKind==='branch'&&search.tag===name)throw notFound();
      if(suffix!==name&&!suffix.startsWith(`${name}/`)) throw notFound();
      const path=suffix===name?'':suffix.slice(name.length+1);
      if(!sourcePath(path)) throw notFound();
      return {...location,view:'source' as const,ref:name,path,sourceRoute:parts[0] as 'tree'|'blob'};
    }
    if(isCommitID(item)) return {...location,view:'source' as const,ref:item,path:parts.slice(2).join('/'),sourceRoute:parts[0] as 'tree'|'blob'};
    return {...location,view:'source' as const,ref:'',path:'',sourceSuffix:suffix,sourceRoute:parts[0] as 'tree'|'blob'};
  }
  if(tail==='agents')return {...location,view:'agents' as const,pull:undefined};
  if(parts[0]==='agents'&&parts.length===2&&/^[1-9][0-9]{0,8}$/.test(parts[1]||''))return {...location,view:'agents' as const,pull:Number(parts[1])};
  if(tail==='packages')return {...location,view:'packages' as const};
  if(tail.startsWith('packages/')) {
    const parts=tail.split('/');
    if((parts.length===2||parts.length===3)&&/^(sha256:[a-f0-9]{64}|sha512:[a-f0-9]{128})$/.test(parts[1] || '')&&['overview','sbom','vulnerabilities','signatures','provenance','activity'].includes(parts[2]||'overview')) return {...location,view:'packages' as const,packageDigest:parts[1],packagePanel:(parts[2]||'overview') as RepositorySearch['packagePanel']};
    throw notFound();
  }
  if(parts[0]==='wiki'){
    if(parts.length===1&&search.wikiPage===undefined)return {...location,view:'wiki' as const,wikiPage:undefined};
    if(parts.length===2&&item&&item!=='.'&&item!=='..'&&item.length<=1024&&/^[A-Za-z0-9_.~+%\-]+$/.test(item)){try{decodeURIComponent(item.replaceAll('+',' '));}catch{throw notFound();}if(search.wikiPage!==undefined&&search.wikiPage!==item)throw notFound();return {...location,view:'wiki' as const,wikiPage:item};}
    throw notFound();
  }
  if(parts[0]==='deployments') {
    if(parts.length===1 && search.deploymentId===undefined)return {...location,view:'deployments' as const,deploymentId:undefined};
    if(parts.length===2 && isRunID(item) && (search.deploymentId===undefined || search.deploymentId===item))return {...location,view:'deployments' as const,deploymentId:item};
    throw notFound();
  }
  if(parts[0]==='releases') {
    if(parts.length===1 && search.releaseId===undefined)return {...location,view:'releases' as const,releaseId:undefined};
    if(parts.length===2 && sourceRepositoryID(item) && (search.releaseId===undefined || search.releaseId===item))return {...location,view:'releases' as const,releaseId:item};
    throw notFound();
  }
  if(tail==='branches'||tail==='tags')return {...location,view:tail as 'branches'|'tags'};
  if(tail==='compare')return {...location,view:'compare' as const};
  if(parts[0]==='commits'&&parts.length>=3&&isCommitID(item)) {
    const historyPath=parts.slice(2).join('/');
    if(!historyPath||historyPath.split('/').some(p=>!p||p==='.'||p==='..')||/[\\\u0000-\u001f]/.test(historyPath))throw notFound();
    return {...location,view:'commits' as const,ref:item,historyPath,commit:undefined};
  }
  if(parts[0]==='commit'&&parts.length===2&&isCommitID(item)) return {...location,view:'commits' as const,commit:item};
  if(tail==='issues/new')return {...location,view:'issues' as const,issue:undefined,issueNew:true};
  if(parts[0]==='issues'&&parts.length<=2) {
    if(parts.length===1)return {...location,view:'issues' as const,issue:undefined,issueNew:undefined};
    if(/^[1-9][0-9]*$/.test(item)&&Number(parts[1])<=0x7fffffff)return {...location,view:'issues' as const,issue:Number(parts[1]),issueNew:undefined};
  }
  if(parts[0]==='pull'&&parts.length>=2&&parts.length<=3&&/^[1-9][0-9]*$/.test(item)&&Number(parts[1])<=0x7fffffff&&(!parts[2]||['files','commits','checks'].includes(parts[2]))) return {...location,view:'pulls' as const,pull:Number(parts[1]),pullView:parts[2] as RepositorySearch['pullView']};
  if(parts[0]==='actions'&&['runs','tasks','reviews'].includes(parts[1]||'')&&parts.length===3&&isRunID(parts[2]||'')){const runKind=parts[1]==='tasks'?'coding-task':parts[1]==='reviews'?'review':'workflow';if(search.runKind&&search.runKind!==runKind||runKind!=='workflow'&&search.step!==undefined)throw notFound();return {...location,view:'actions' as const,run:parts[2],runKind:runKind as RepositorySearch['runKind']};}
  if(parts.length===1&&['pulls','commits','actions'].includes(tail))return {...location,view:tail as 'pulls'|'commits'|'actions',pull:undefined,commit:undefined,run:undefined};
  throw notFound();
}
const canonicalRepositoryPageRoute=createRoute({getParentRoute:()=>rootRoute,path:'/$owner/$name/$',validateSearch:validateRepositorySearch,
  beforeLoad:({params,search,location})=>{
    const tail=params._splat||'';
    canonicalLocation(params.owner,params.name,tail,search);
    const parts=tail.split('/');
    const ownsRef=parts[0]==='tree'||parts[0]==='blob'||isCommitID(parts[1]||'')&&parts[0]==='commits'&&parts.length>=3;
    // The installed search middleware has no route params. Normalize only
    // after validating the incoming selectors, keeping empty-tail aliases and
    // deliberate source return-context on issue, pull and commit pages.
    const owned=['view','path','issue','pull','pullView','commit','run','runKind','historyPath','issueNew','releaseId','deploymentId'];
    if(tail && (owned.some(key=>key in location.search) || ownsRef && 'ref' in location.search)) {
      const clean={...search};
      for(const key of owned) delete clean[key as keyof RepositorySearch];
      if(ownsRef) clean.ref='';
      throw redirect({to:'/$owner/$name/$',params:{owner:params.owner,name:params.name,_splat:tail},search:clean,hash:location.hash,replace:true});
    }
  },
  search:{middlewares:[stripSearchParams(defaultRepositorySearch)]},
  staticData: { golfLocation: (match) => {const p=match.params;return canonicalLocation(p.owner,p.name,p._splat||'',match.search); } }});

function RepositorySettingsPage(match: LocationMatch): Location {
  const { owner, name } = match.params;
  return { kind: 'repository-settings', owner, name };
}
function OrganizationTeamSettingsPage(match: LocationMatch): Location {
  const { organization, teamId } = match.params;
  return { kind: 'organization-team-settings', organization, teamId };
}
function OrganizationSettingsPage(match: LocationMatch): Location {
  const { organization } = match.params;
  return { kind: 'organization-settings', organization };
}
function RepositoryPage(match: LocationMatch): Location {
  const params = match.params;
  const search = match.search;
  return { ...params, ...search, kind: 'repository' };
}

function HomePage(match: LocationMatch): Location {
  const search = match.search;
  return { kind: 'home', oauthFailed: search.auth_error === 'oauth_failed' };
}

function OrganizationPage(match: LocationMatch): Location {
  const { organization } = match.params;
  const { team } = match.search;
  return { kind: 'organizations', organization, team };
}

// Router owns navigation only. Private server data stays in the cancellable Query cache.
export const router = createRouter({
  routeTree: rootRoute.addChildren([homeRoute, publicProfileRoute, exploreRoute, notificationInboxRoute, statusRoute, canonicalRepositoryPageRoute, repositoryRoute, canonicalRepositorySettingsRoute, canonicalRepositoryDeletionRoute, canonicalRepositoryAccessSettingsRoute, canonicalRepositoryWebhooksRoute, canonicalRepositorySecretsRoute, canonicalRepositoryEnvironmentsRoute, canonicalRepositoryRulesRoute, canonicalRepositoryGitRoute, canonicalRepositoryRunnersRoute, canonicalRepositoryWorkflowsRoute, repositorySettingsRoute, repositoryAccessSettingsRoute, repositoryWorkflowsRoute, instanceOperationsRoute, instanceCapabilitiesRoute, instanceAuditRoute, instanceOverviewRoute, instanceAgentsRoute, instanceNotificationsRoute, instanceRunnersRoute, instanceInfrastructureRoute, instanceExecutionRoute, instanceOrganizationsRoute, organizationSettingsRoute, organizationLabelsRoute, organizationSecretsRoute, organizationTeamSettingsRoute, instanceSettingsRoute, organizationsRoute, organizationRoute, auditRoute, apiCredentialsRoute, sshKeysRoute, settingsRoute, accountInvitationsRoute, accountSecurityRoute, accountConnectionsRoute,accountAgentsRoute, sessionsRoute]),
  defaultPreload: false,
  // Refs and paths are opaque strings, including names such as "1234" or "true".
  parseSearch: (search) => {
    try { for (const part of search.replace(/^\?/, '').split('&')) for(const value of part.split('=')) decodeURIComponent(value.replace(/\+/g,' ')); } catch { return {refKind:'invalid'}; }
    const query=new URLSearchParams(search);
    if (['refKind','refName','ref','path','branch','tag','runKind','actionKind','workflowPath','run','step','jobInstanceId','stepId','repositoryId','releaseId','deploymentId'].some(key=>query.getAll(key).length>1)) return {refKind:'invalid'};
    return Object.fromEntries(query);
  },
  stringifySearch: (search) => {
    const query = new URLSearchParams(Object.entries(search).filter(([, value]) => value !== undefined).map(([key, value]) => [key, String(value)])).toString();
    return query ? `?${query}` : '';
  },
});
declare module '@tanstack/react-router' { interface Register { router: typeof router } }
