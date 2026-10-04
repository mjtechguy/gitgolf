import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { create } from '@bufbuild/protobuf';
import { ListRepositoryDeployKeysResponseSchema, GetAuthenticationOptionsResponseSchema, GetRepositoryAccessResponseSchema, GetSessionResponseSchema, ListCapabilitiesResponseSchema, ListRepositoriesResponseSchema, ListRepositoryCollaboratorsRequestSchema, ListRepositoryCollaboratorsResponseSchema, LoginWithPasswordResponseSchema, LogoutResponseSchema, RemoveRepositoryCollaboratorRequestSchema, RemoveRepositoryCollaboratorResponseSchema, RepositoryAccessSchema, RepositoryCollaboratorSchema, ResolveRepositoryCollaboratorRequestSchema, ResolveRepositoryCollaboratorResponseSchema, SetRepositoryCollaboratorRequestSchema, SetRepositoryCollaboratorResponseSchema, UserSchema } from '../src/gen/golf/v1/golf_pb';
import { emptyRepositoryInvitations, reject, request, respond } from './rpc';

const owner = create(UserSchema, { id: '9007199254740993', login: 'alex' });
const first = create(RepositoryCollaboratorSchema, { user: { id: '9007199254740994', login: 'first-reader' }, permission: 'read', isDirect: true, revision: 'first-grant' });
const candidate = create(UserSchema, { id: '9007199254740997', login: 'new-collaborator' });
const path = '/repositories/alex/project/settings/access';
async function backend(page: Page) {
  const state = { signedIn: true, user: create(UserSchema, { id: '17', login: 'maintainer', isInstanceAdmin: true }), access: create(RepositoryAccessSchema, { owner, ownerId: owner.id, repositoryId: '9007199254740998', currentPermission: 'admin', canManage: true, revision: 'reviewed-repository' }), collaborators: [first, create(RepositoryCollaboratorSchema, { user: { id: '17', login: 'maintainer' }, permission: 'admin', isDirect: true, revision: 'self-grant' }), create(RepositoryCollaboratorSchema, { user: { id: '9007199254740995', login: '<literal-account>' }, permission: 'write', isDirect: true, revision: 'later-grant' })], denied: false, listDenied: false, malformed: false, pages: [] as number[], resolves: [] as unknown[], requests: [] as unknown[], writes: [] as unknown[], drop: false, barrier: undefined as Promise<void> | undefined, resolveBarrier: undefined as Promise<void> | undefined };
  await page.route('**/rpc/**', async (route) => {
    const method = new URL(route.request().url()).pathname.split('/').at(-1);
    if (method === 'GetAuthenticationOptions') return respond(route, GetAuthenticationOptionsResponseSchema, { localPasswordEnabled: true });
    if (method === 'LoginWithPassword') { state.signedIn = true; return respond(route, LoginWithPasswordResponseSchema, { user: state.user }); }
    if (method === 'Logout') { state.signedIn = false; return respond(route, LogoutResponseSchema, {}); }
    if (!state.signedIn) return reject(route, 'unauthenticated', 'Your session ended.');
    if (method === 'GetSession') return respond(route, GetSessionResponseSchema, { user: state.user });
    if (method === 'ListCapabilities') return respond(route, ListCapabilitiesResponseSchema, {});
    if (method === 'ListRepositories') return respond(route, ListRepositoriesResponseSchema, {});
    if (method === 'ListRepositoryDeployKeys') return respond(route, ListRepositoryDeployKeysResponseSchema, { repositoryId: state.access.repositoryId, ownerId: state.access.ownerId, accessRevision: state.access.revision, keys: [], page: { nextPage: 0 } });
    if (method === 'ListRepositoryInvitations') return emptyRepositoryInvitations(route);
    if (method === 'GetRepositoryAccess') return state.denied ? reject(route, 'not_found', 'Repository access unavailable.') : respond(route, GetRepositoryAccessResponseSchema, { access: state.access });
    if (method === 'ListRepositoryCollaborators') {
      if (state.listDenied) return reject(route, 'permission_denied', 'Collaborator inventory access denied.');
      const input = request(route, ListRepositoryCollaboratorsRequestSchema); const pageNumber = input.page?.page || 1; state.pages.push(pageNumber);
      expect(input.repositoryId).toBe(state.access.repositoryId); expect(input.ownerId).toBe(owner.id); expect(input.page?.limit).toBe(20);
      return respond(route, ListRepositoryCollaboratorsResponseSchema, { collaborators: state.malformed ? [{ ...first, user: undefined }] : state.collaborators.slice((pageNumber - 1) * 2, pageNumber * 2), page: { nextPage: state.collaborators.length > pageNumber * 2 ? pageNumber + 1 : 0 } });
    }
    if (method === 'ResolveRepositoryCollaborator') {
      const input = request(route, ResolveRepositoryCollaboratorRequestSchema); state.resolves.push(input);
      const known = state.collaborators.find((collaborator) => collaborator.user?.login === input.userLogin);
      const collaborator = known || create(RepositoryCollaboratorSchema, { user: input.userLogin === owner.login ? owner : candidate, permission: 'none', isDirect: false, revision: 'no-direct-grant' });
      if (state.resolveBarrier) await state.resolveBarrier;
      return respond(route, ResolveRepositoryCollaboratorResponseSchema, { collaborator });
    }
    if (method === 'SetRepositoryCollaborator' || method === 'RemoveRepositoryCollaborator') {
      const input = method === 'SetRepositoryCollaborator' ? request(route, SetRepositoryCollaboratorRequestSchema) : request(route, RemoveRepositoryCollaboratorRequestSchema);
      state.requests.push(input);
      if (!state.access.canManage || state.access.organizationOwned || input.userId === owner.id || input.userId === state.user.id) return reject(route, 'permission_denied', 'Collaborator administration denied.');
      if (input.expectedRevision !== state.access.revision) return reject(route, 'failed_precondition', 'Repository authority changed.');
      const known = state.collaborators.find((collaborator) => collaborator.user?.id === input.userId);
      if (input.expectedCollaboratorRevision !== (known?.revision || 'no-direct-grant')) return reject(route, 'failed_precondition', 'Collaborator grant changed.');
      const target = known?.user || candidate;
      expect(target.id).toBe(input.userId); expect(target.login).toBe(input.userLogin); expect(input.ownerId).toBe(owner.id);
      state.writes.push(input); const remove = method === 'RemoveRepositoryCollaborator';
      const collaborator = create(RepositoryCollaboratorSchema, { user: target, permission: remove ? 'none' : (input as { permission: string }).permission, isDirect: !remove, revision: `saved-${state.writes.length}` });
      state.collaborators = state.collaborators.filter((entry) => entry.user?.id !== input.userId); if (!remove) state.collaborators.unshift(collaborator);
      if (state.barrier) await state.barrier;
      if (state.drop) return route.abort('failed');
      return remove ? respond(route, RemoveRepositoryCollaboratorResponseSchema, { collaborator }) : respond(route, SetRepositoryCollaboratorResponseSchema, { collaborator });
    }
    return reject(route, 'not_found', 'Unsupported access fixture.');
  });
  return state;
}
async function open(page: Page) { await page.goto(path); await expect(page.getByRole('table', { name: 'Repository collaborators', exact: true }).locator('tbody tr[data-row-id]')).toHaveCount(2); }
async function reviewNew(page: Page, permission = 'read') { await page.getByRole('button', { name: 'Add collaborator', exact: true }).click(); await page.getByLabel('Account username', { exact: true }).fill(candidate.login); await page.getByLabel('Requested permission', { exact: true }).selectOption(permission); await page.getByRole('button', { name: 'Resolve and review access', exact: true }).click(); await expect(page.getByRole('heading', { name: 'Review collaborator access', exact: true })).toBeVisible(); }

test('collaborator table searches and sorts loaded grants with exact IDs and locked own access', async ({ page }) => {
  const state = await backend(page); await open(page);
  await expect(page.getByRole('button', { name: 'Change access for maintainer', exact: true })).toHaveCount(0);
  const table = page.getByRole('table', { name: 'Repository collaborators', exact: true });
  const search = page.getByRole('searchbox', { name: 'Search loaded Repository collaborators', exact: true });
  await search.fill('<literal-account>'); await expect(table.locator('tbody tr[data-row-id]')).toHaveCount(0);
  expect(state.pages.every((pageNumber) => pageNumber === 1)).toBe(true);
  await page.getByRole('button', { name: 'Load more collaborators', exact: true }).click();
  await expect(table.getByText('<literal-account>', { exact: true })).toBeVisible(); await expect(table.locator('img')).toHaveCount(0);
  await search.fill(first.user!.id); await expect(table.locator('tbody tr[data-row-id]').first()).toHaveAttribute('data-row-id', first.user!.id);
  await search.fill(''); await table.getByRole('button', { name: 'Permission', exact: true }).click(); await expect(table.getByRole('columnheader', { name: 'Permission', exact: true })).toHaveAttribute('aria-sort', 'ascending');
});

test('admin access requires explicit identity/grant review and duplicate apply clicks dispatch once', async ({ page }) => {
  const state = await backend(page); await open(page); await reviewNew(page, 'admin');
  await expect(page.getByText('Admin can manage access and delete this repository. Apply only if this account should have that authority.', { exact: true })).toBeVisible(); expect(state.writes).toHaveLength(0);
  let release!: () => void; state.barrier = new Promise<void>((resolve) => { release = resolve; });
  await page.getByRole('button', { name: 'Apply reviewed access', exact: true }).evaluate((button) => { (button as HTMLButtonElement).click(); (button as HTMLButtonElement).click(); }); await expect.poll(() => state.writes.length).toBe(1); release();
  await expect(page.getByText('Collaborator access saved.', { exact: true })).toBeVisible();
  expect(state.writes).toMatchObject([{ repositoryId: state.access.repositoryId, ownerId: owner.id, userId: candidate.id, userLogin: candidate.login, permission: 'admin', expectedRevision: 'reviewed-repository', expectedCollaboratorRevision: 'no-direct-grant' }]);
  await expect(page.getByLabel('Account username', { exact: true })).toHaveCount(0); await expect(page.getByRole('dialog')).toHaveCount(0);
});

test('change editor cancels drafts and changing a requested grant invalidates its identity review', async ({ page }) => {
  const state = await backend(page); await open(page);
  const change = page.getByRole('button', { name: 'Change access for first-reader', exact: true });
  await change.click(); await expect(page.getByLabel('Account username', { exact: true })).toBeDisabled(); await expect(page.getByLabel('Requested permission', { exact: true })).toBeFocused();
  await page.getByLabel('Requested permission', { exact: true }).selectOption('write'); await page.getByRole('button', { name: 'Cancel', exact: true }).click(); await expect(change).toBeFocused(); expect(state.writes).toHaveLength(0);
  await change.click(); await expect(page.getByLabel('Requested permission', { exact: true })).toHaveValue('read');
  await page.getByLabel('Requested permission', { exact: true }).selectOption('write'); await page.getByRole('button', { name: 'Resolve and review access', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Review collaborator access', exact: true })).toBeVisible(); await page.getByLabel('Requested permission', { exact: true }).selectOption('admin'); await expect(page.getByRole('heading', { name: 'Review collaborator access', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Resolve and review access', exact: true }).click(); await page.getByRole('button', { name: 'Apply reviewed access', exact: true }).click(); await expect(page.getByText('Collaborator access saved.', { exact: true })).toBeVisible();
  expect(state.writes).toMatchObject([{ userId: first.user!.id, permission: 'admin', expectedCollaboratorRevision: 'first-grant' }]);
});

test('removal uses a short keyboard confirmation and preserves immutable target bindings', async ({ page }) => {
  const state = await backend(page); await open(page); const remove = page.getByRole('button', { name: 'Remove collaborator first-reader', exact: true });
  await remove.click(); await expect(page.getByRole('button', { name: 'Cancel', exact: true })).toBeFocused(); await page.keyboard.press('Escape'); await expect(remove).toBeFocused(); expect(state.writes).toHaveLength(0);
  await remove.click(); await page.getByRole('button', { name: 'Confirm remove collaborator', exact: true }).click(); await expect(page.getByText('Collaborator removed.', { exact: true })).toBeVisible();
  expect(state.writes).toMatchObject([{ userId: first.user!.id, expectedCollaboratorRevision: 'first-grant' }]); await expect(remove).toHaveCount(0);
});

test('lost grant response blocks retries until inspection and later inventory denial removes private rows', async ({ page }) => {
  const state = await backend(page); state.drop = true; await open(page); await reviewNew(page, 'write'); await page.getByRole('button', { name: 'Apply reviewed access', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Access change could not be confirmed', exact: true })).toBeVisible(); await expect(page.getByRole('button', { name: 'Add collaborator', exact: true })).toBeDisabled(); expect(state.writes).toHaveLength(1);
  await page.getByRole('button', { name: 'Refresh repository access', exact: true }).click(); await expect(page.getByRole('table', { name: 'Repository collaborators', exact: true }).getByText(candidate.login, { exact: true })).toBeVisible(); expect(state.writes).toHaveLength(1);
  state.listDenied = true; await page.getByRole('button', { name: 'Load more collaborators', exact: true }).click(); await expect(page.getByRole('alert')).toHaveText('Collaborator inventory access denied.'); await expect(page.getByRole('table', { name: 'Repository collaborators', exact: true })).toHaveCount(0);
});

test('changed repository or collaborator revisions are not silently adopted', async ({ page }) => {
  const state = await backend(page); await open(page); await reviewNew(page);
  state.access.revision = 'changed-repository'; await page.getByRole('button', { name: 'Apply reviewed access', exact: true }).click(); await expect(page.getByRole('heading', { name: 'Access change could not be confirmed', exact: true })).toBeVisible(); expect(state.writes).toHaveLength(0); expect(state.requests).toMatchObject([{ expectedRevision: 'reviewed-repository' }]);
  await page.getByRole('button', { name: 'Refresh repository access', exact: true }).click(); await page.getByRole('button', { name: 'Change access for first-reader', exact: true }).click(); state.collaborators[0] = { ...first, revision: 'changed-grant', permission: 'write' }; await page.getByRole('button', { name: 'Resolve and review access', exact: true }).click(); await expect(page.getByRole('alert')).toHaveText('Collaborator access changed. Refresh and review it again.'); await expect(page.getByRole('heading', { name: 'Review collaborator access', exact: true })).toHaveCount(0); expect(state.writes).toHaveLength(0);
});

for (const kind of ['read-only', 'organization-owned', 'exceptional owner'] as const) test(`${kind} displays inventory without fake administration even with a Golf instance role`, async ({ page }) => {
  const state = await backend(page); state.access.canManage = kind !== 'read-only'; state.access.organizationOwned = kind === 'organization-owned'; state.access.currentPermission = kind === 'exceptional owner' ? 'owner' : 'read'; await page.goto(path); await expect(page.getByRole('heading', { name: 'Repository access', exact: true })).toBeVisible(); await expect(page.getByText('Managing collaborators requires administration of a personal repository. Your permission is shown above. Organization and team grants are not managed here.', { exact: true })).toBeVisible(); await expect(page.getByRole('table', { name: 'Repository collaborators', exact: true })).toHaveCount(0); expect(state.pages).toHaveLength(0);
  await expect(page.getByRole('button', { name: 'Add collaborator', exact: true })).toHaveCount(0); await expect(page.getByRole('button', { name: /^Change access for/ })).toHaveCount(0); await expect(page.getByRole('button', { name: /^Remove collaborator/ })).toHaveCount(0);
  await page.setViewportSize({ width: 390, height: 844 }); expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true); expect(state.writes).toHaveLength(0);
});

test('owner identities cannot become reviewed collaborator mutations', async ({ page }) => {
  const state = await backend(page); await open(page); await page.getByRole('button', { name: 'Add collaborator', exact: true }).click(); await page.getByLabel('Account username', { exact: true }).fill(owner.login); await page.getByRole('button', { name: 'Resolve and review access', exact: true }).click();
  await expect(page.getByRole('alert')).toHaveText('Owner, self and exceptional owner-level access cannot be changed here.'); await expect(page.getByRole('button', { name: 'Apply reviewed access', exact: true })).toHaveCount(0); expect(state.writes).toHaveLength(0);
});

test('pending resolve cancellation and late write navigation cannot restore discarded previews or receipts', async ({ page }) => {
  const state = await backend(page); await open(page); let releaseResolve!: () => void; state.resolveBarrier = new Promise<void>((resolve) => { releaseResolve = resolve; }); await page.getByRole('button', { name: 'Add collaborator', exact: true }).click(); await page.getByLabel('Account username', { exact: true }).fill(candidate.login); await page.getByRole('button', { name: 'Resolve and review access', exact: true }).click(); await expect.poll(() => state.resolves.length).toBe(1); await page.getByRole('button', { name: 'Cancel', exact: true }).click(); state.resolveBarrier = undefined; releaseResolve();
  await reviewNew(page); let releaseWrite!: () => void; state.barrier = new Promise<void>((resolve) => { releaseWrite = resolve; }); await page.getByRole('button', { name: 'Apply reviewed access', exact: true }).click(); await expect.poll(() => state.writes.length).toBe(1); await page.getByRole('navigation', { name: 'Workspace', exact: true }).getByRole('link', { name: 'Repositories', exact: false }).click(); releaseWrite(); await page.goto(path);
  await expect(page.getByRole('table', { name: 'Repository collaborators', exact: true }).getByText(candidate.login, { exact: true })).toBeVisible(); await expect(page.getByRole('heading', { name: 'Review collaborator access', exact: true })).toHaveCount(0); await expect(page.getByText('Collaborator access saved.', { exact: true })).toHaveCount(0); expect(state.writes).toHaveLength(1);
});

test('account switch hides former access and malformed inventory does not become a fabricated empty result', async ({ page }) => {
  const state = await backend(page); await open(page); await reviewNew(page); await page.getByLabel('Your account', { exact: true }).click(); await page.getByRole('button', { name: 'Sign out', exact: true }).click(); await expect(page.getByRole('heading', { name: 'Welcome to Golf', exact: true })).toBeVisible(); state.user = create(UserSchema, { id: '19', login: 'other' }); state.denied = true; await page.getByLabel('Email or username', { exact: true }).fill('fixture-account'); await page.getByLabel('Password', { exact: true }).fill('other-token'); await page.getByRole('button', { name: 'Sign in', exact: true }).click(); await expect(page.getByRole('alert')).toHaveText('Repository access unavailable.'); await expect(page.getByRole('table', { name: 'Repository collaborators', exact: true })).toHaveCount(0); await expect(page.getByRole('heading', { name: 'Review collaborator access', exact: true })).toHaveCount(0);
  state.denied = false; state.malformed = true; await page.reload(); await expect(page.getByRole('alert')).toHaveText('Collaborator metadata is incomplete.'); await expect(page.getByRole('table', { name: 'Repository collaborators', exact: true })).toHaveCount(0);
});

for (const theme of ['dark', 'light']) for (const width of [390, 1440]) test(`${theme} ${width} keeps access headings intact and actions compact`, async ({ page }) => {
  await page.addInitScript(value => localStorage.setItem('golf.theme', value), theme);
  await page.setViewportSize({ width, height: 950 }); await backend(page); await open(page);
  const section = page.getByRole('region', { name: 'Collaborators', exact: true });
  const heading = section.getByRole('heading', { name: 'Collaborators', exact: true });
  expect(await heading.evaluate(node => { const range = document.createRange(); range.selectNodeContents(node); return range.getClientRects().length; })).toBe(1);
  await expect(section.getByRole('button', { name: 'Refresh repository access', exact: true })).toHaveAttribute('title', 'Refresh repository access');
  await expect(section.getByRole('button', { name: 'Change access for first-reader', exact: true })).toHaveAttribute('title', 'Change access');
  await expect(section.getByRole('button', { name: 'Remove collaborator first-reader', exact: true })).toHaveAttribute('title', 'Remove collaborator');
  const details = section.locator('details').filter({ hasText: 'About repository access' });
  await expect(details).not.toHaveAttribute('open');
  await details.getByText('About repository access', { exact: true }).click();
  await expect(details.getByText(/Instance administration does not grant access/)).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await details.getByText('About repository access', { exact: true }).click();
  await page.screenshot({ path: `.tmp/access-density-source/${theme}-${width}.png`, fullPage: true });
});
