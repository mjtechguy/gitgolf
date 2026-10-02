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
const repositoryRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/repositories/$owner/$name',
  validateSearch: (search: Record<string, unknown>): RepositorySearch => {
    const issue = search.issue === undefined ? undefined : Number(search.issue);
    const pull = search.pull === undefined ? undefined : typeof search.pull === 'number' ? search.pull : typeof search.pull === 'string' && /^[1-9][0-9]*$/.test(search.pull) ? Number(search.pull) : NaN;
    return {
      view: search.view === 'commits' || search.view === 'issues' || search.view === 'pulls' ? search.view : 'source',
      ref: typeof search.ref === 'string' ? search.ref : '', path: typeof search.path === 'string' ? search.path : '',
      branch: typeof search.branch === 'string' ? search.branch : '',
      state: search.state === 'closed' || search.state === 'all' ? search.state : 'open', issue, pull,
      commit: search.commit === undefined ? undefined : typeof search.commit === 'string' ? search.commit : '',
    };
  },
  beforeLoad: ({ params, search }) => {
    if (!params.owner || !params.name || /[\/\\]/.test(params.owner + params.name)) throw notFound();
    if (search.pull !== undefined && (!Number.isSafeInteger(search.pull) || search.pull <= 0 || search.pull > 0x7fffffff)) throw notFound();
    if (search.issue !== undefined && (!Number.isSafeInteger(search.issue) || search.issue <= 0 || search.issue > 0xffffffff)) throw notFound();
    if (search.commit !== undefined && !isCommitID(search.commit)) throw notFound();
  },
  search: { middlewares: [stripSearchParams(defaultRepositorySearch)] },
  component: RepositoryPage,
});

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
  routeTree: rootRoute.addChildren([homeRoute, repositoryRoute, organizationsRoute, organizationRoute, auditRoute, apiCredentialsRoute, sshKeysRoute, settingsRoute, sessionsRoute]),
  defaultPreload: false,
  // Refs and paths are opaque strings, including names such as "1234" or "true".
  parseSearch: (search) => Object.fromEntries(new URLSearchParams(search)),
  stringifySearch: (search) => {
    const query = new URLSearchParams(Object.entries(search).filter(([, value]) => value !== undefined).map(([key, value]) => [key, String(value)])).toString();
    return query ? `?${query}` : '';
  },
});
declare module '@tanstack/react-router' { interface Register { router: typeof router } }
