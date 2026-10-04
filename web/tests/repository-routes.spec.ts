import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import {
  GetAuthenticationOptionsResponseSchema, GetSessionResponseSchema, ListCapabilitiesResponseSchema,
  GetRepositorySettingsResponseSchema, GetRepositoryAccessResponseSchema, ListRepositoryCollaboratorsResponseSchema,
  InspectWorkflowsResponseSchema, GetRepositoryResponseSchema, GetContentsRequestSchema, GetContentsResponseSchema,
  ListBranchesResponseSchema, ListCommitsRequestSchema, ListCommitsResponseSchema, ResolveRepositorySourceRequestSchema, SourceEntryType,
} from '../src/gen/golf/v1/golf_pb';
import { resolveSourceFixture, disabledAgentUsage, disabledAgentTasks, reject, request, respond } from './rpc';

const snapshot = 'a'.repeat(40), other = 'b'.repeat(40);
const user = { id: '17', login: 'alex', fullName: 'Alex' };
const repository = { id: '19', owner: user, name: 'demo', fullName: 'alex/demo', defaultBranch: 'main' };
async function fixture(page: Page) {
  const state = { denied: false, signedIn: true, methods: [] as string[], authorityURLs: [] as string[], refs: [] as string[], selections: [] as ReturnType<typeof request<typeof ResolveRepositorySourceRequestSchema>>[] };
  await page.route('**/rpc/**', async route => {
    const method = route.request().url().split('/').at(-1)!;
    state.methods.push(method);
    if (['GetRepository', 'GetRepositorySettings', 'GetRepositoryAccess', 'InspectWorkflows'].includes(method)) state.authorityURLs.push(page.url());
    if (method === 'GetAuthenticationOptions') return respond(route, GetAuthenticationOptionsResponseSchema, { localPasswordEnabled: true });
    if (method === 'GetSession') return state.signedIn ? respond(route, GetSessionResponseSchema, { user }) : reject(route, 'unauthenticated', 'Signed out.');
    if (method === 'ListCapabilities') return respond(route, ListCapabilitiesResponseSchema, {});
    if (state.denied) return reject(route, 'permission_denied', 'Current repository access denied.');
    if (method === 'GetRepositorySettings') return respond(route, GetRepositorySettingsResponseSchema, { settings: {
      repositoryId: repository.id, ownerId: user.id, description: 'PRIVATE route settings', defaultBranch: 'main', canEdit: true, revision: 'settings-v1', hasIssues: true, hasPullRequests: true,
    } });
    if (method === 'GetRepositoryAccess') return respond(route, GetRepositoryAccessResponseSchema, { access: {
      repositoryId: repository.id, ownerId: user.id, owner: user, canManage: true, currentPermission: 'admin', revision: 'access-v1',
    } });
    if (method === 'ListRepositoryCollaborators') return respond(route, ListRepositoryCollaboratorsResponseSchema, {});
    if (method === 'InspectWorkflows') return respond(route, InspectWorkflowsResponseSchema, { repositoryId:repository.id, commitId: snapshot, catalogVersion: 'routing-fixture' });
    if (method === 'GetAgentUsage') return disabledAgentUsage(route);
    if (method === 'ListAgentTasks') return disabledAgentTasks(route);
    if (method === 'GetRepository') return respond(route, GetRepositoryResponseSchema, { repository });
    if (method === 'ListBranches') return respond(route, ListBranchesResponseSchema, { branches: [{ name: 'main', commitId: snapshot }] });
    if (method === 'ResolveRepositorySource') { state.selections.push(request(route, ResolveRepositorySourceRequestSchema)); return resolveSourceFixture(route, repository.id, { owner: 'alex', name: 'demo' }, 'main', { main: snapshot }); }
    if (method === 'GetContents') {
      const input = request(route, GetContentsRequestSchema), file = input.path === 'src/index.ts'; state.refs.push(input.ref);
      return respond(route, GetContentsResponseSchema, { repositoryId: repository.id, commitId: snapshot, path: input.path, kind: file ? SourceEntryType.FILE : SourceEntryType.DIRECTORY,
        ...(file ? { file: { entry: { name: 'index.ts', path: input.path, sha: snapshot, type: SourceEntryType.FILE, size: 8n }, content: 'one\ntwo\n' } } : {}) });
    }
    if (method === 'ListCommits') {
      const input = request(route, ListCommitsRequestSchema); state.refs.push(input.ref);
      return respond(route, ListCommitsResponseSchema, { repositoryId: input.repositoryId, commitId: input.ref, path: input.path,
        commits: [{ sha: input.ref || snapshot, message: 'Pinned route history', authorName: 'Alex', authoredAt: '2026-10-01T12:00:00Z' }] });
    }
    return reject(route, 'unimplemented', 'Routing fixture does not provide this operation.');
  });
  return state;
}

const settingsPages = [
  ['settings', 'Repository settings', 'GetRepositorySettings'],
  ['settings/access', 'Repository access', 'GetRepositoryAccess'],
  ['settings/workflows', 'Workflow configuration', 'InspectWorkflows'],
] as const;
for (const [tail, heading, method] of settingsPages) test(`legacy ${tail} normalizes before reading the canonical settings page`, async ({ page }) => {
  const state = await fixture(page);
  await page.goto(`/repositories/alex/demo/${tail}#route-fragment`);
  await expect(page).toHaveURL(new RegExp(`/alex/demo/${tail}#route-fragment$`));
  await expect(page.getByRole('heading', { name: heading, exact: true })).toBeVisible();
  await expect.poll(() => state.methods.filter(value => value === method).length).toBeGreaterThan(0);
  const reads = state.methods.filter(value => value === method).length;
  expect(state.authorityURLs.every(url => new URL(url).pathname === `/alex/demo/${tail}`)).toBe(true);
  if(tail==='settings/workflows') { expect(state.methods).toContain('GetRepository'); expect(state.methods.indexOf('GetRepository')).toBeLessThan(state.methods.indexOf('InspectWorkflows')); } else expect(state.methods).not.toContain('GetRepository');
  await page.reload();
  await expect(page.getByRole('heading', { name: heading, exact: true })).toBeVisible();
  await expect.poll(() => state.methods.filter(value => value === method).length).toBeGreaterThan(reads);
  expect(state.methods.some(value => /^(Update|Set|Create|Delete|Dispatch|Save|Activate|Remove)/.test(value))).toBe(false);
});

test('canonical settings links support back/forward between the same supported units', async ({ page }) => {
  await fixture(page);
  await page.goto('/alex/demo/settings');
  const navigation = page.getByRole('navigation', { name: 'Repository settings', exact: true });
  await navigation.getByRole('link', { name: 'Access', exact: true }).click();
  await expect(page).toHaveURL(/\/alex\/demo\/settings\/access$/);
  await expect(page.getByRole('heading', { name: 'Repository access', exact: true })).toBeVisible();
  await navigation.getByRole('link', { name: 'Workflows', exact: true }).click();
  await expect(page).toHaveURL(/\/alex\/demo\/settings\/workflows$/);
  await page.goBack(); await expect(page.getByRole('heading', { name: 'Repository access', exact: true })).toBeVisible();
  await page.goForward(); await expect(page.getByRole('heading', { name: 'Workflow configuration', exact: true })).toBeVisible();
});

for (const [tail, , method] of settingsPages) test(`canonical and legacy ${tail} preserve current access denial`, async ({ page }) => {
  const state = await fixture(page); state.denied = true;
  for (const prefix of ['/alex/demo/', '/repositories/alex/demo/']) {
    await page.goto(prefix + tail);
    await expect(page).toHaveURL(new RegExp(`/alex/demo/${tail}$`));
    await expect(page.getByRole('alert').filter({ hasText: 'Current repository access denied.' }).first()).toBeVisible();
    await expect(page.getByText('PRIVATE route settings', { exact: true })).toHaveCount(0);
  }
  if(tail==='settings/workflows') { expect(state.methods.filter(value=>value==='GetRepository').length).toBeGreaterThanOrEqual(2); expect(state.methods).not.toContain('InspectWorkflows'); } else expect(state.methods.filter(value => value === method).length).toBeGreaterThanOrEqual(2);
  expect(state.authorityURLs.every(url => new URL(url).pathname === `/alex/demo/${tail}`)).toBe(true);
});

test('legacy settings redirect keeps the unauthenticated page and never probes repository data', async ({ page }) => {
  const state = await fixture(page); state.signedIn = false;
  await page.goto('/repositories/alex/demo/settings/access');
  await expect(page).toHaveURL(/\/alex\/demo\/settings\/access$/);
  await expect(page.getByRole('heading', { name: 'Welcome to Golf', exact: true })).toBeVisible();
  expect(state.methods.every(method => ['GetSession', 'GetAuthenticationOptions', 'ListCapabilities'].includes(method))).toBe(true);
});

for (const query of ['issue=0', 'issue=01', 'issue=1e2', 'issue=4294967296', 'pull=01', 'pull=2147483648', 'commit=main', `commit=${'A'.repeat(40)}`, 'run=not-a-run', 'step=-1', 'step=50', 'step=1.5']) {
  for (const prefix of ['/alex/demo', '/repositories/alex/demo']) test(`deep link ${prefix} rejects ${query} before data RPC`, async ({ page }) => {
    const state = await fixture(page);
    await page.goto(`${prefix}?${query}`);
    await expect(page.getByRole('heading', { name: 'Page not found', exact: true })).toBeVisible();
    expect(state.methods.every(method => ['GetSession', 'GetAuthenticationOptions', 'ListCapabilities'].includes(method))).toBe(true);
  });
}

for (const tail of [`tree/${snapshot}`, `blob/${snapshot}/src/index.ts`, `commits/${snapshot}/src/index.ts`]) test(`path-owned snapshot removes duplicate ref for ${tail.split('/')[0]} without a redirect loop`, async ({ page }) => {
  const state = await fixture(page);
  await page.goto(`/alex/demo/${tail}?ref=${other}&branch=feature%2FUI#L2`);
  await expect.poll(() => new URL(page.url()).searchParams.has('ref')).toBe(false);
  expect(new URL(page.url()).pathname).toBe(`/alex/demo/${tail}`);
  expect(new URL(page.url()).searchParams.get('branch')).toBe('feature/UI');
  expect(new URL(page.url()).hash).toBe('#L2');
  await expect.poll(() => state.refs.length).toBeGreaterThan(0);
  const reads = state.methods.filter(value => value === 'GetRepository').length;
  await page.reload();
  await expect.poll(() => new URL(page.url()).searchParams.has('ref')).toBe(false);
  await expect.poll(() => state.methods.filter(value => value === 'GetRepository').length).toBeGreaterThan(reads);
  await expect.poll(() => state.refs.length).toBeGreaterThan(1); expect(state.refs.every(ref => ref === snapshot)).toBe(true);
});

test('commit detail retains deliberately different history return context', async ({ page }) => {
  await fixture(page);
  await page.goto(`/alex/demo/commit/${snapshot}?ref=${other}&branch=feature%2FUI`);
  expect(new URL(page.url()).searchParams.get('ref')).toBe(other);
  expect(new URL(page.url()).searchParams.get('branch')).toBe('feature/UI');
});

test('readable main entry retains its address while source reads use the resolved native ID and full snapshot', async ({ page }) => {
  const state = await fixture(page);
  await page.goto('/alex/demo/tree/main');
  await expect.poll(() => state.methods.includes('GetContents')).toBe(true);
  await expect(page).toHaveURL(/\/alex\/demo\/tree\/main$/);
  await expect(page.getByRole('heading', { name: 'Page not found', exact: true })).toHaveCount(0);
  expect(state.selections.length).toBeGreaterThan(0);
  for (const selection of state.selections) expect(selection).toMatchObject({ repository: { owner: 'alex', name: 'demo' }, repositoryId: '19', suffix: 'main', path: '' });
  expect(state.refs.length).toBeGreaterThan(0);
  expect(state.refs.every(ref => ref === snapshot)).toBe(true);
});

for (const tail of ['tree/feature/UI/src', 'blob/release/2.0/README.md']) test(`missing readable entry ${tail} is resolved as a whole suffix without guessed source reads`, async ({ page }) => {
  const state = await fixture(page);
  await page.goto(`/alex/demo/${tail}`);
  await expect(page.getByRole('heading', { name: 'Source selection', exact: true })).toBeVisible();
  await expect(page.getByRole('alert')).toContainText('Exact fixture suffix not found.');
  await expect(page.getByRole('button', { name: 'Choose ref and path', exact: true })).toBeVisible();
  expect(new URL(page.url()).pathname).toBe(`/alex/demo/${tail}`);
  expect(state.methods).not.toContain('GetContents');
  expect(state.selections.length).toBeGreaterThan(0);
  for (const selection of state.selections) {
    expect(selection).toMatchObject({ repository: { owner: 'alex', name: 'demo' }, repositoryId: '19', suffix: tail.slice(tail.indexOf('/') + 1), path: '' });
    expect(selection.selector).toBeUndefined();
  }
});

for (const prefix of ['/alex/demo', '/repositories/alex/demo']) test(`legacy uint32 issue selector remains readable at ${prefix}`, async ({ page }) => {
  const state = await fixture(page);
  await page.goto(`${prefix}?view=issues&issue=4294967295`);
  await expect.poll(() => state.methods.includes('GetIssue')).toBe(true);
  await expect(page.getByRole('heading', { name: 'Page not found', exact: true })).toHaveCount(0);
});

for (const prefix of ['', '/repositories']) test(`settings reject decoded slash in owner before authority RPC ${prefix || 'canonical'}`, async ({ page }) => {
  const state = await fixture(page);
  await page.goto(`${prefix}/bad%2Fowner/demo/settings`);
  await expect(page.getByRole('heading', { name: 'Page not found', exact: true })).toBeVisible();
  expect(state.methods.every(method => ['GetSession', 'GetAuthenticationOptions', 'ListCapabilities'].includes(method))).toBe(true);
});

for (const query of ['issue=0', 'pull=01', 'commit=main', 'run=not-a-run']) test(`path normalization cannot discard invalid selector ${query} before validation`, async ({ page }) => {
  const state = await fixture(page);
  await page.goto(`/alex/demo/tree/${snapshot}?${query}&ref=${other}`);
  await expect(page.getByRole('heading', { name: 'Page not found', exact: true })).toBeVisible();
  expect(state.methods.every(method => ['GetSession', 'GetAuthenticationOptions', 'ListCapabilities'].includes(method))).toBe(true);
});

test('path-owned selectors normalize once while preserving deliberate issue return context', async ({ page }) => {
  const state = await fixture(page);
  await page.goto(`/alex/demo/issues/12?view=issues&issue=13&path=ignored&ref=${other}&branch=feature%2FUI#comment-2`);
  await expect.poll(() => state.methods.includes('GetIssue')).toBe(true);
  const url = new URL(page.url());
  expect(url.pathname).toBe('/alex/demo/issues/12');
  for (const key of ['view', 'issue', 'path']) expect(url.searchParams.has(key)).toBe(false);
  expect(url.searchParams.get('ref')).toBe(other);
  expect(url.searchParams.get('branch')).toBe('feature/UI');
  expect(url.hash).toBe('#comment-2');
  expect(state.methods).not.toContain('GetContents');
});
