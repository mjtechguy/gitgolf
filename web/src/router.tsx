import { createRootRoute, createRoute, createRouter, notFound, redirect, Outlet, stripSearchParams } from '@tanstack/react-router';
import { App } from './App';
import { defaultRepositorySearch, isCommitID, isRunID } from './navigation';
import type { RepositorySearch } from './navigation';

const rootRoute = createRootRoute({
  component: Outlet,
  notFoundComponent: () => <App location={{ kind: 'missing' }} />,
  errorComponent: () => <App location={{ kind: 'missing' }} />,
});
const homeRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/',
  validateSearch: (search: Record<string, unknown>): { auth_error?: 'oauth_failed' } => ({
    auth_error: search.auth_error === 'oauth_failed' ? 'oauth_failed' : undefined,
  }),
  component: HomePage,
});
const organizationsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/organizations',
  component: () => <App location={{ kind: 'organizations' }} />,
});
const statusRoute = createRoute({ getParentRoute: () => rootRoute, path: '/status', component: () => <App location={{ kind: 'status' }} /> });
const auditRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/audit',
  component: () => <App location={{ kind: 'audit' }} />,
});
const apiCredentialsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/account/api-credentials',
  component: () => <App location={{ kind: 'api-credentials' }} />,
});
const accountAgentsRoute = createRoute({ getParentRoute: () => rootRoute, path: '/account/agents', component: () => <App location={{ kind: 'account-agents' }} /> });
const accountSecurityRoute = createRoute({ getParentRoute: () => rootRoute, path: '/account/security', component: () => <App location={{ kind: 'account-security' }} /> });
const settingsRoute = createRoute({
  getParentRoute: () => rootRoute, path: '/account/settings',
  component: () => <App location={{ kind: 'settings' }} />,
});
const sessionsRoute = createRoute({
  getParentRoute: () => rootRoute, path: '/account/sessions',
  component: () => <App location={{ kind: 'sessions' }} />,
});
const sshKeysRoute = createRoute({
  getParentRoute: () => rootRoute, path: '/account/ssh-keys',
  component: () => <App location={{ kind: 'ssh-keys' }} />,
});
function validateRepositoryIdentity(owner: string, name: string) {
  if (!owner || !name || /[\/\\]/.test(owner + name)) throw notFound();
}
const canonicalRepositorySettingsRoute = createRoute({
  getParentRoute: () => rootRoute, path: '/$owner/$name/settings',
  beforeLoad: ({ params }) => validateRepositoryIdentity(params.owner, params.name),
  component: RepositorySettingsPage,
});
const canonicalRepositoryAccessSettingsRoute = createRoute({
  getParentRoute: () => rootRoute, path: '/$owner/$name/settings/access',
  beforeLoad: ({ params }) => validateRepositoryIdentity(params.owner, params.name),
  component: () => { const { owner, name } = canonicalRepositoryAccessSettingsRoute.useParams(); return <App location={{ kind: 'repository-access-settings', owner, name }} />; },
});
const canonicalRepositoryWorkflowsRoute = createRoute({
  getParentRoute: () => rootRoute, path: '/$owner/$name/settings/workflows',
  beforeLoad: ({ params }) => validateRepositoryIdentity(params.owner, params.name),
  component: () => { const { owner, name } = canonicalRepositoryWorkflowsRoute.useParams(); return <App location={{ kind: 'repository-workflows', owner, name }} />; },
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
  component: OrganizationSettingsPage,
});
const organizationTeamSettingsRoute = createRoute({
  getParentRoute: () => rootRoute, path: '/organizations/$organization/teams/$teamId/settings',
  beforeLoad: ({ params }) => { if (!params.organization || /[\/\\]/.test(params.organization) || !/^[1-9][0-9]{0,18}$/.test(params.teamId) || BigInt(params.teamId) > 9223372036854775807n) throw notFound(); },
  component: OrganizationTeamSettingsPage,
});
const instanceExecutionRoute = createRoute({ getParentRoute: () => rootRoute, path: '/admin/execution', component: () => <App location={{ kind: 'instance-settings', view: 'execution' }} /> });
const instanceOrganizationsRoute = createRoute({ getParentRoute: () => rootRoute, path: '/admin/organizations', component: () => <App location={{ kind: 'instance-settings', view: 'organizations' }} /> });
const instanceAgentsRoute = createRoute({ getParentRoute: () => rootRoute, path: '/admin/agents', component: () => <App location={{ kind: 'instance-settings', view: 'agents' }} /> });
const instanceInfrastructureRoute = createRoute({ getParentRoute: () => rootRoute, path: '/admin/settings/infrastructure', component: () => <App location={{ kind: 'instance-settings', view: 'infrastructure' }} /> });
const instanceOverviewRoute = createRoute({ getParentRoute: () => rootRoute, path: '/admin', component: () => <App location={{ kind: 'instance-settings', view: 'overview' }} /> });
const instanceSettingsRoute = createRoute({ getParentRoute: () => rootRoute, path: '/admin/settings', component: () => <App location={{ kind: 'instance-settings' }} /> });
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
  component: OrganizationPage,
});
const validateRepositorySearch = (search: Record<string, unknown>): RepositorySearch => {
    const issue = search.issue === undefined ? undefined : typeof search.issue === 'number' ? search.issue : typeof search.issue === 'string' && /^[1-9][0-9]*$/.test(search.issue) ? Number(search.issue) : NaN;
    const pull = search.pull === undefined ? undefined : typeof search.pull === 'number' ? search.pull : typeof search.pull === 'string' && /^[1-9][0-9]*$/.test(search.pull) ? Number(search.pull) : NaN;
    return {
      view: search.view === 'commits' || search.view === 'issues' || search.view === 'pulls' || search.view === 'actions' || search.view === 'compare' ? search.view : 'source',
      ref: typeof search.ref === 'string' ? search.ref : '', path: typeof search.path === 'string' ? search.path : '',
      base:typeof search.base==='string'?search.base:undefined,head:typeof search.head==='string'?search.head:undefined,sourceOwner:typeof search.sourceOwner==='string'?search.sourceOwner:undefined,sourceName:typeof search.sourceName==='string'?search.sourceName:undefined,
      branch: typeof search.branch === 'string' ? search.branch : '',
      tag: typeof search.tag === 'string' ? search.tag : undefined,
      historyPath:typeof search.historyPath==='string'?search.historyPath:undefined,
      issueNew:search.issueNew===true?true:undefined,
      state: search.state === 'closed' || search.state === 'all' ? search.state : 'open', issue, pull,
      pullView: search.pullView === 'files' || search.pullView === 'commits' || search.pullView === 'checks' ? search.pullView : undefined,
      commit: search.commit === undefined ? undefined : typeof search.commit === 'string' ? search.commit : '',
      run: search.run === undefined ? undefined : typeof search.run === 'string' ? search.run : '',
      step: search.step === undefined ? undefined : typeof search.step === 'number' ? search.step : typeof search.step === 'string' && /^(0|[1-9][0-9]*)$/.test(search.step) ? Number(search.step) : NaN,
    };
  };
function validateRepositorySelectors(search: RepositorySearch) {
  if (search.pull !== undefined && (!Number.isSafeInteger(search.pull) || search.pull <= 0 || search.pull > 0x7fffffff)) throw notFound();
  if (search.issue !== undefined && (!Number.isSafeInteger(search.issue) || search.issue <= 0 || search.issue > 0xffffffff)) throw notFound();
  if (search.commit !== undefined && !isCommitID(search.commit)) throw notFound();
  if (search.run !== undefined && !isRunID(search.run)) throw notFound();
  if (search.step !== undefined && (!Number.isInteger(search.step) || search.step < 0 || search.step > 49)) throw notFound();
}
const repositoryRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/repositories/$owner/$name',
  validateSearch: validateRepositorySearch,
  beforeLoad: ({ params, search }) => {
    validateRepositoryIdentity(params.owner, params.name);
    validateRepositorySelectors(search);
  },
  search: { middlewares: [stripSearchParams(defaultRepositorySearch)] },
  component: RepositoryPage,
});

// Explicitly keep legacy query URLs readable. New navigation uses familiar
// repository paths; immutable source IDs avoid slash-ref ambiguity.
function canonicalLocation(owner:string,name:string,tail:string,search:RepositorySearch) {
  validateRepositoryIdentity(owner, name);
  validateRepositorySelectors(search);
  const location={...search,owner,name,kind:'repository' as const};
  if(!tail) return location;
  const parts=tail.split('/');
  const item=parts[1]||'';
  if(parts[0]==='tree'||parts[0]==='blob') {
    if(!isCommitID(item)) throw notFound();
    const path=parts.slice(2).join('/');
    if(path.split('/').some(p=>p==='.'||p==='..')||/[\\\u0000-\u001f]/.test(path)) throw notFound();
    return {...location,view:'source' as const,ref:item,path};
  }
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
  if(parts[0]==='actions'&&parts[1]==='runs'&&parts.length===3&&isRunID(parts[2]||''))return {...location,view:'actions' as const,run:parts[2]};
  if(parts.length===1&&['pulls','commits','actions'].includes(tail))return {...location,view:tail as 'pulls'|'commits'|'actions',pull:undefined,commit:undefined,run:undefined};
  throw notFound();
}
const canonicalRepositoryPageRoute=createRoute({getParentRoute:()=>rootRoute,path:'/$owner/$name/$',validateSearch:validateRepositorySearch,
  beforeLoad:({params,search,location})=>{
    const tail=params._splat||'';
    canonicalLocation(params.owner,params.name,tail,search);
    const parts=tail.split('/');
    const ownsRef=isCommitID(parts[1]||'') && (parts[0]==='tree'||parts[0]==='blob'||parts[0]==='commits'&&parts.length>=3);
    // The installed search middleware has no route params. Normalize only
    // after validating the incoming selectors, keeping empty-tail aliases and
    // deliberate source return-context on issue, pull and commit pages.
    const owned=['view','path','issue','pull','pullView','commit','run','historyPath','issueNew'];
    if(tail && (owned.some(key=>key in location.search) || ownsRef && 'ref' in location.search)) {
      const clean={...search};
      for(const key of owned) delete clean[key as keyof RepositorySearch];
      if(ownsRef) clean.ref='';
      throw redirect({to:'/$owner/$name/$',params:{owner:params.owner,name:params.name,_splat:tail},search:clean,hash:location.hash,replace:true});
    }
  },
  search:{middlewares:[stripSearchParams(defaultRepositorySearch)]},
  component:()=>{const p=canonicalRepositoryPageRoute.useParams();return <App location={canonicalLocation(p.owner,p.name,p._splat||'',canonicalRepositoryPageRoute.useSearch())}/>;}});

function RepositorySettingsPage() {
  const { owner, name } = canonicalRepositorySettingsRoute.useParams();
  return <App location={{ kind: 'repository-settings', owner, name }} />;
}
function OrganizationTeamSettingsPage() {
  const { organization, teamId } = organizationTeamSettingsRoute.useParams();
  return <App location={{ kind: 'organization-team-settings', organization, teamId }} />;
}
function OrganizationSettingsPage() {
  const { organization } = organizationSettingsRoute.useParams();
  return <App location={{ kind: 'organization-settings', organization }} />;
}
function RepositoryPage() {
  const params = repositoryRoute.useParams();
  const search = repositoryRoute.useSearch();
  return <App location={{ ...params, ...search, kind: 'repository' }} />;
}

function HomePage() {
  const search = homeRoute.useSearch();
  return <App location={{ kind: 'home', oauthFailed: search.auth_error === 'oauth_failed' }} />;
}

function OrganizationPage() {
  const { organization } = organizationRoute.useParams();
  const { team } = organizationRoute.useSearch();
  return <App location={{ kind: 'organizations', organization, team }} />;
}

// Router owns navigation only. Private server data stays in the cancellable Query cache.
export const router = createRouter({
  routeTree: rootRoute.addChildren([homeRoute, statusRoute, canonicalRepositoryPageRoute, repositoryRoute, canonicalRepositorySettingsRoute, canonicalRepositoryAccessSettingsRoute, canonicalRepositoryWorkflowsRoute, repositorySettingsRoute, repositoryAccessSettingsRoute, repositoryWorkflowsRoute, instanceOverviewRoute, instanceAgentsRoute, instanceInfrastructureRoute, instanceExecutionRoute, instanceOrganizationsRoute, organizationSettingsRoute, organizationTeamSettingsRoute, instanceSettingsRoute, organizationsRoute, organizationRoute, auditRoute, apiCredentialsRoute, sshKeysRoute, settingsRoute, accountSecurityRoute, accountAgentsRoute, sessionsRoute]),
  defaultPreload: false,
  // Refs and paths are opaque strings, including names such as "1234" or "true".
  parseSearch: (search) => Object.fromEntries(new URLSearchParams(search)),
  stringifySearch: (search) => {
    const query = new URLSearchParams(Object.entries(search).filter(([, value]) => value !== undefined).map(([key, value]) => [key, String(value)])).toString();
    return query ? `?${query}` : '';
  },
});
declare module '@tanstack/react-router' { interface Register { router: typeof router } }
