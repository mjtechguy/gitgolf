import { createRootRoute, createRoute, createRouter, notFound, Outlet, stripSearchParams } from '@tanstack/react-router';
import { App } from './App';
import { defaultRepositorySearch } from './navigation';
import type { RepositorySearch } from './navigation';

const rootRoute = createRootRoute({
  component: Outlet,
  notFoundComponent: () => <App location={{ kind: 'missing' }} />,
  errorComponent: () => <App location={{ kind: 'missing' }} />,
});
const homeRoute = createRoute({ getParentRoute: () => rootRoute, path: '/', component: () => <App location={{ kind: 'home' }} /> });
const repositoryRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/repositories/$owner/$name',
  validateSearch: (search: Record<string, unknown>): RepositorySearch => {
    const issue = search.issue === undefined ? undefined : Number(search.issue);
    return {
      view: search.view === 'commits' || search.view === 'issues' ? search.view : 'source',
      ref: typeof search.ref === 'string' ? search.ref : '', path: typeof search.path === 'string' ? search.path : '',
      branch: typeof search.branch === 'string' ? search.branch : '',
      state: search.state === 'closed' || search.state === 'all' ? search.state : 'open', issue,
    };
  },
  beforeLoad: ({ params, search }) => {
    if (!params.owner || !params.name || /[\/\\]/.test(params.owner + params.name)) throw notFound();
    if (search.issue !== undefined && (!Number.isSafeInteger(search.issue) || search.issue <= 0 || search.issue > 0xffffffff)) throw notFound();
  },
  search: { middlewares: [stripSearchParams(defaultRepositorySearch)] },
  component: RepositoryPage,
});

function RepositoryPage() {
  const params = repositoryRoute.useParams();
  const search = repositoryRoute.useSearch();
  return <App location={{ ...params, ...search, kind: 'repository' }} />;
}

// Router owns navigation only. Private server data stays in the cancellable Query cache.
export const router = createRouter({
  routeTree: rootRoute.addChildren([homeRoute, repositoryRoute]),
  defaultPreload: false,
  // Refs and paths are opaque strings, including names such as "1234" or "true".
  parseSearch: (search) => Object.fromEntries(new URLSearchParams(search)),
  stringifySearch: (search) => {
    const query = new URLSearchParams(Object.entries(search).filter(([, value]) => value !== undefined).map(([key, value]) => [key, String(value)])).toString();
    return query ? `?${query}` : '';
  },
});
declare module '@tanstack/react-router' { interface Register { router: typeof router } }
