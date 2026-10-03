import { createRootRoute, createRoute, createRouter, notFound, Outlet, stripSearchParams } from '@tanstack/react-router';
import { App } from './App';
import { defaultRepositorySearch, isCommitID } from './navigation';
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
const repositorySettingsRoute = createRoute({
  getParentRoute: () => rootRoute, path: '/repositories/$owner/$name/settings',
  beforeLoad: ({ params }) => { if (!params.owner || !params.name || /[\/\\]/.test(params.owner + params.name)) throw notFound(); },
  component: RepositorySettingsPage,
});
const repositoryAccessSettingsRoute = createRoute({
  getParentRoute: () => rootRoute, path: '/repositories/$owner/$name/settings/access',
  beforeLoad: ({ params }) => { if (!params.owner || !params.name || /[\/\\]/.test(params.owner + params.name)) throw notFound(); },
  component: () => { const { owner, name } = repositoryAccessSettingsRoute.useParams(); return <App location={{ kind: 'repository-access-settings', owner, name }} />; },
});
const repositoryWorkflowsRoute = createRoute({
  getParentRoute: () => rootRoute, path: '/repositories/$owner/$name/settings/workflows',
  beforeLoad: ({ params }) => { if (!params.owner || !params.name || /[\/\\]/.test(params.owner + params.name)) throw notFound(); },
  component: () => { const { owner, name } = repositoryWorkflowsRoute.useParams(); return <App location={{ kind: 'repository-workflows', owner, name }} />; },
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
    const issue = search.issue === undefined ? undefined : Number(search.issue);
    const pull = search.pull === undefined ? undefined : typeof search.pull === 'number' ? search.pull : typeof search.pull === 'string' && /^[1-9][0-9]*$/.test(search.pull) ? Number(search.pull) : NaN;
    return {
      view: search.view === 'commits' || search.view === 'issues' || search.view === 'pulls' || search.view === 'actions' ? search.view : 'source',
      ref: typeof search.ref === 'string' ? search.ref : '', path: typeof search.path === 'string' ? search.path : '',
      branch: typeof search.branch === 'string' ? search.branch : '',
      state: search.state === 'closed' || search.state === 'all' ? search.state : 'open', issue, pull,
      pullView: search.pullView === 'files' ? 'files' : undefined,
      commit: search.commit === undefined ? undefined : typeof search.commit === 'string' ? search.commit : '',
    };
  };
const repositoryRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/repositories/$owner/$name',
  validateSearch: validateRepositorySearch,
  beforeLoad: ({ params, search }) => {
    if (!params.owner || !params.name || /[\/\\]/.test(params.owner + params.name)) throw notFound();
    if (search.pull !== undefined && (!Number.isSafeInteger(search.pull) || search.pull <= 0 || search.pull > 0x7fffffff)) throw notFound();
    if (search.issue !== undefined && (!Number.isSafeInteger(search.issue) || search.issue <= 0 || search.issue > 0xffffffff)) throw notFound();
    if (search.commit !== undefined && !isCommitID(search.commit)) throw notFound();
  },
  search: { middlewares: [stripSearchParams(defaultRepositorySearch)] },
  component: RepositoryPage,
});

// Explicitly keep legacy query URLs readable. New navigation uses familiar
// repository paths; immutable source IDs avoid slash-ref ambiguity.
function canonicalLocation(owner:string,name:string,tail:string,search:RepositorySearch) {
  if(!owner||!name||/[\/\\]/.test(owner+name)) throw notFound();
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
  if(parts[0]==='commit'&&parts.length===2&&isCommitID(item)) return {...location,view:'commits' as const,commit:item};
  if(parts[0]==='issues'&&parts.length<=2) {
    if(parts.length===1)return {...location,view:'issues' as const,issue:undefined};
    if(/^[1-9][0-9]*$/.test(item)&&Number(parts[1])<=0x7fffffff)return {...location,view:'issues' as const,issue:Number(parts[1])};
  }
  if(parts[0]==='pull'&&parts.length>=2&&parts.length<=3&&/^[1-9][0-9]*$/.test(item)&&Number(parts[1])<=0x7fffffff&&(!parts[2]||parts[2]==='files')) return {...location,view:'pulls' as const,pull:Number(parts[1]),pullView:parts[2]==='files'?'files' as const:undefined};
  if(parts.length===1&&['pulls','commits','actions'].includes(tail))return {...location,view:tail as 'pulls'|'commits'|'actions',pull:undefined,commit:undefined};
  throw notFound();
}
const canonicalRepositoryPageRoute=createRoute({getParentRoute:()=>rootRoute,path:'/$owner/$name/$',validateSearch:validateRepositorySearch,
  beforeLoad:({params,search})=>{canonicalLocation(params.owner,params.name,params._splat||'',search);},
  search:{middlewares:[({search,next})=>{const clean:Partial<RepositorySearch>={...next(search)};delete clean.view;delete clean.path;delete clean.issue;delete clean.pull;delete clean.pullView;delete clean.commit;return clean as RepositorySearch;},stripSearchParams(defaultRepositorySearch)]},
  component:()=>{const p=canonicalRepositoryPageRoute.useParams();return <App location={canonicalLocation(p.owner,p.name,p._splat||'',canonicalRepositoryPageRoute.useSearch())}/>;}});

function RepositorySettingsPage() {
  const { owner, name } = repositorySettingsRoute.useParams();
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
  routeTree: rootRoute.addChildren([homeRoute, statusRoute, canonicalRepositoryPageRoute, repositoryRoute, repositorySettingsRoute, repositoryAccessSettingsRoute, repositoryWorkflowsRoute, instanceOverviewRoute, instanceAgentsRoute, instanceInfrastructureRoute, instanceExecutionRoute, instanceOrganizationsRoute, organizationSettingsRoute, organizationTeamSettingsRoute, instanceSettingsRoute, organizationsRoute, organizationRoute, auditRoute, apiCredentialsRoute, sshKeysRoute, settingsRoute, accountSecurityRoute, accountAgentsRoute, sessionsRoute]),
  defaultPreload: false,
  // Refs and paths are opaque strings, including names such as "1234" or "true".
  parseSearch: (search) => Object.fromEntries(new URLSearchParams(search)),
  stringifySearch: (search) => {
    const query = new URLSearchParams(Object.entries(search).filter(([, value]) => value !== undefined).map(([key, value]) => [key, String(value)])).toString();
    return query ? `?${query}` : '';
  },
});
declare module '@tanstack/react-router' { interface Register { router: typeof router } }
