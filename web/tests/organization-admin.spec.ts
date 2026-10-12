import { portableRuntimeFixture } from './runtime-fixture';
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { create } from '@bufbuild/protobuf';
import { AddTeamMemberRequestSchema, AddTeamMemberResponseSchema, GetAuthenticationOptionsResponseSchema, GetSessionResponseSchema, GetTeamAdministrationResponseSchema, ListCapabilitiesResponseSchema, ListRepositoriesResponseSchema, ListTeamMembersRequestSchema, ListTeamMembersResponseSchema, LogoutResponseSchema, LoginWithPasswordResponseSchema, OrganizationTeamSchema, RemoveTeamMemberRequestSchema, RemoveTeamMemberResponseSchema, ResolveTeamMemberRequestSchema, ResolveTeamMemberResponseSchema, TeamPermission, UserSchema } from '../src/gen/golf/v1/golf_pb';
import { reject, request, respond } from './rpc';

const teamId = '9007199254740993';
const organizationId = '9007199254740994';
const first = create(UserSchema, { id: '9007199254740995', login: 'first-member', fullName: '<img src=x onerror=alert(1)>' });
const candidate = create(UserSchema, { id: '9007199254740998', login: 'new-member', fullName: 'New member' });
const routePath = `/organizations/lab/teams/${teamId}/settings`;
async function backend(page: Page) {
  const state = { signedIn: true, user: create(UserSchema, { id: '17', login: 'owner', isInstanceAdmin: true }), canManage: true, ownerTeam: false, denied: false, memberDenied: false, revision: 'reviewed-revision', members: [first, create(UserSchema, { id: '9007199254740996', login: 'second-member' }), create(UserSchema, { id: '9007199254740997', login: 'later-member' })], pages: [] as number[], requests: [] as unknown[], writes: [] as unknown[], resolveCalls: [] as unknown[], drop: false, resolveBarrier: undefined as Promise<void> | undefined, barrier: undefined as Promise<void> | undefined };
  const team = create(OrganizationTeamSchema, { id: teamId, name: 'Platform', permission: TeamPermission.WRITE, unitPermissions: { 'repo.code': TeamPermission.WRITE, 'repo.issues': TeamPermission.READ }, includesAllRepositories: true });
  await page.route('**/rpc/**', async (route) => {
    const method = new URL(route.request().url()).pathname.split('/').at(-1);
    if (method === 'GetAuthenticationOptions') return respond(route, GetAuthenticationOptionsResponseSchema, { localPasswordEnabled: true });
    if (method === 'LoginWithPassword') { state.signedIn = true; return respond(route, LoginWithPasswordResponseSchema, { user: state.user }); }
    if (method === 'Logout') { state.signedIn = false; return respond(route, LogoutResponseSchema, {}); }
    if (!state.signedIn) return reject(route, 'unauthenticated', 'Your session ended.');
    if (method === 'GetSession') return respond(route, GetSessionResponseSchema, { user: state.user });
    if (method === 'ListCapabilities') return respond(route, ListCapabilitiesResponseSchema, portableRuntimeFixture);
    if (method === 'ListRepositories') return respond(route, ListRepositoriesResponseSchema, {});
    if (method === 'GetTeamAdministration') return state.denied ? reject(route, 'not_found', 'Team unavailable.') : respond(route, GetTeamAdministrationResponseSchema, { team, organizationId, canManageMembers: state.canManage, revision: state.revision, isOwnerTeam: state.ownerTeam });
    if (method === 'ListTeamMembers') {
      if (state.memberDenied) return reject(route, 'permission_denied', 'Team membership access denied.');
      const input = request(route, ListTeamMembersRequestSchema);
      expect(input.teamId).toBe(teamId); expect(input.organization).toBe('lab'); expect(input.page?.limit).toBe(20);
      const pageNumber = input.page?.page || 1; state.pages.push(pageNumber);
      return respond(route, ListTeamMembersResponseSchema, { members: state.members.slice((pageNumber - 1) * 2, pageNumber * 2), page: { nextPage: state.members.length > pageNumber * 2 ? pageNumber + 1 : 0 } });
    }
    if (method === 'ResolveTeamMember') {
      const input = request(route, ResolveTeamMemberRequestSchema); state.resolveCalls.push(input);
      if (!state.canManage || state.ownerTeam) return reject(route, 'permission_denied', 'Membership administration denied.');
      if (input.expectedRevision !== state.revision) return reject(route, 'failed_precondition', 'Team grants changed; refresh before reviewing access.');
      const user = input.userLogin === 'new-member' ? candidate : state.members.find((member) => member.login === input.userLogin);
      if (state.resolveBarrier) await state.resolveBarrier;
      return user ? respond(route, ResolveTeamMemberResponseSchema, { user, isMember: state.members.some((member) => member.id === user.id) }) : reject(route, 'not_found', 'Account unavailable.');
    }
    if (method === 'AddTeamMember' || method === 'RemoveTeamMember') {
      const input = method === 'AddTeamMember' ? request(route, AddTeamMemberRequestSchema) : request(route, RemoveTeamMemberRequestSchema);
      state.requests.push(input);
      if (!state.canManage || state.ownerTeam) return reject(route, 'permission_denied', 'Membership administration denied.');
      if (input.expectedRevision !== state.revision) return reject(route, 'failed_precondition', 'Team grants changed; refresh before reviewing access.');
      expect(input.organizationId).toBe(organizationId); expect(input.teamId).toBe(teamId);
      const user = input.userId === candidate.id ? candidate : state.members.find((member) => member.id === input.userId);
      if (!user || user.login !== input.userLogin) return reject(route, 'failed_precondition', 'Member identity changed.');
      state.writes.push(input);
      const remove = method === 'RemoveTeamMember';
      state.members = state.members.filter((member) => member.id !== user.id);
      if (!remove) state.members.unshift(user);
      if (state.barrier) await state.barrier;
      if (state.drop) return route.abort('failed');
      return remove ? respond(route, RemoveTeamMemberResponseSchema, { user, isMember: false }) : respond(route, AddTeamMemberResponseSchema, { user, isMember: true });
    }
    return reject(route, 'not_found', 'Unsupported organization admin fixture.');
  });
  return state;
}
async function open(page: Page) {
  await page.goto(routePath);
  await expect(page.getByRole('table', { name: 'Team members', exact: true }).locator('tbody tr[data-row-id]')).toHaveCount(2);
}
async function resolveNew(page: Page) {
  await page.getByRole('button', { name: 'Add member', exact: true }).click();
  await page.getByLabel('Account username', { exact: true }).fill('new-member');
  await page.getByRole('button', { name: 'Resolve member', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Review team access', exact: true })).toBeVisible();
}

test('team members search/sort only loaded rows and preserve literal names and exact IDs', async ({ page }) => {
  const state = await backend(page); await open(page);
  const table = page.getByRole('table', { name: 'Team members', exact: true });
  await expect(table.getByText('<img src=x onerror=alert(1)>', { exact: true })).toBeVisible();
  await expect(table.locator('img')).toHaveCount(0);
  await expect(page.getByLabel('Account username', { exact: true })).toHaveCount(0);
  const search = page.getByRole('searchbox', { name: 'Search loaded Team members', exact: true });
  await search.fill('later-member');
  await expect(table.locator('tbody tr[data-row-id]')).toHaveCount(0);
  expect(state.pages.every((pageNumber) => pageNumber === 1)).toBe(true);
  await page.getByRole('button', { name: 'Load more team members', exact: true }).click();
  await expect(table.locator('tbody tr[data-row-id]')).toHaveCount(1);
  await search.fill('9007199254740995');
  await expect(table.locator('tbody tr[data-row-id]').first()).toHaveAttribute('data-row-id', first.id);
  await search.fill('');
  await table.getByRole('button', { name: 'Member', exact: true }).click();
  await expect(table.getByRole('columnheader', { name: 'Member', exact: true })).toHaveAttribute('aria-sort', 'ascending');
  expect(state.writes).toHaveLength(0);
});

test('explicit add resolves identity and reviews grants; cancellation discards draft and duplicate clicks dispatch once', async ({ page }) => {
  const state = await backend(page); await open(page);
  await page.getByRole('button', { name: 'Add member', exact: true }).click();
  await expect(page.getByLabel('Account username', { exact: true })).toBeFocused();
  await page.getByLabel('Account username', { exact: true }).fill('Discarded');
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Add member', exact: true })).toBeFocused();
  await resolveNew(page);
  await expect(page.getByText('All repositories (native setting)', { exact: true })).toBeVisible();
  await expect(page.getByText('repo.issues', { exact: true })).toBeVisible();
  let release!: () => void; state.barrier = new Promise<void>((resolve) => { release = resolve; });
  await page.getByRole('button', { name: 'Add resolved member', exact: true }).evaluate((button) => { (button as HTMLButtonElement).click(); (button as HTMLButtonElement).click(); });
  await expect.poll(() => state.writes.length).toBe(1);
  release();
  await expect(page.getByText('Team member added.', { exact: true })).toBeVisible();
  expect(state.writes).toMatchObject([{ userLogin: 'new-member', userId: candidate.id, teamId, organizationId, expectedRevision: 'reviewed-revision' }]);
  await expect(page.getByLabel('Account username', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('dialog')).toHaveCount(0);
});

test('removal is confirmation-only, keyboard-cancellable and binds the immutable member', async ({ page }) => {
  const state = await backend(page); await open(page);
  const button = page.getByRole('button', { name: 'Remove member first-member', exact: true });
  await button.click(); await expect(page.getByRole('button', { name: 'Cancel', exact: true })).toBeFocused();
  await page.keyboard.press('Escape'); await expect(button).toBeFocused(); expect(state.writes).toHaveLength(0);
  await button.click(); await page.getByRole('button', { name: 'Confirm remove member', exact: true }).click();
  await expect(page.getByText('Team member removed.', { exact: true })).toBeVisible();
  expect(state.writes).toMatchObject([{ userId: first.id, userLogin: 'first-member', expectedRevision: 'reviewed-revision' }]);
  await expect(button).toHaveCount(0);
});

test('unknown add outcome blocks retry until inspection and permission failure hides earlier private rows', async ({ page }) => {
  const state = await backend(page); state.drop = true; await open(page); await resolveNew(page);
  await page.getByRole('button', { name: 'Add resolved member', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Membership change could not be confirmed', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Add member', exact: true })).toBeDisabled();
  expect(state.writes).toHaveLength(1);
  await page.getByRole('button', { name: 'Refresh team members', exact: true }).click();
  await expect(page.getByRole('table', { name: 'Team members', exact: true }).getByText('new-member', { exact: true })).toBeVisible();
  expect(state.writes).toHaveLength(1);
  state.memberDenied = true;
  await page.getByRole('button', { name: 'Load more team members', exact: true }).click();
  await expect(page.getByRole('alert')).toHaveText('Team membership access denied.');
  await expect(page.getByRole('table', { name: 'Team members', exact: true })).toHaveCount(0);
});

test('changed team grants are never silently adopted from a resolved preview', async ({ page }) => {
  const state = await backend(page); await open(page); await resolveNew(page);
  state.revision = 'changed-grants';
  await page.getByRole('button', { name: 'Add resolved member', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Membership change could not be confirmed', exact: true })).toBeVisible();
  expect(state.writes).toHaveLength(0);
  expect(state.requests).toMatchObject([{ expectedRevision: 'reviewed-revision' }]);
  await page.getByRole('button', { name: 'Refresh team members', exact: true }).click();
  await resolveNew(page);
  await page.getByRole('button', { name: 'Add resolved member', exact: true }).click();
  await expect(page.getByText('Team member added.', { exact: true })).toBeVisible();
  expect(state.writes).toMatchObject([{ expectedRevision: 'changed-grants' }]);
});

for (const kind of ['read-only', 'owner team'] as const) test(`${kind} has member inventory without fake administration, even for a Golf instance administrator`, async ({ page }) => {
  const state = await backend(page); state.canManage = kind !== 'read-only'; state.ownerTeam = kind === 'owner team';
  await open(page); await expect(page.getByRole('button', { name: 'Add member', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: /^Remove member / })).toHaveCount(0);
  expect(state.writes).toHaveLength(0);
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test('navigation aborts a pending write and late response cannot restore the former editor or receipt', async ({ page }) => {
  const state = await backend(page); await open(page); await resolveNew(page);
  let release!: () => void; state.barrier = new Promise<void>((resolve) => { release = resolve; });
  await page.getByRole('button', { name: 'Add resolved member', exact: true }).click();
  await expect.poll(() => state.writes.length).toBe(1);
  await page.getByRole('navigation', { name: 'Workspace', exact: true }).getByRole('link', { name: 'Repositories', exact: false }).click();
  release(); await page.goto(routePath);
  await expect(page.getByRole('table', { name: 'Team members', exact: true }).getByText('new-member', { exact: true })).toBeVisible();
  await expect(page.getByText('Team member added.', { exact: true })).toHaveCount(0);
  await expect(page.getByLabel('Account username', { exact: true })).toHaveCount(0);
  expect(state.writes).toHaveLength(1);
});

test('existing team member preview offers no add and changed username invalidates the resolved identity', async ({ page }) => {
  const state = await backend(page); await open(page); await resolveNew(page);
  await page.getByLabel('Account username', { exact: true }).fill('first-member');
  await expect(page.getByRole('heading', { name: 'Review team access', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Resolve member', exact: true }).click();
  await expect(page.getByText('This account is already a member of this team.', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Add resolved member', exact: true })).toHaveCount(0);
  expect(state.writes).toHaveLength(0);
});


test('cancelling a pending resolve prevents its late identity from opening a new draft', async ({ page }) => {
  const state = await backend(page); await open(page);
  let release!: () => void; state.resolveBarrier = new Promise<void>((resolve) => { release = resolve; });
  await page.getByRole('button', { name: 'Add member', exact: true }).click();
  await page.getByLabel('Account username', { exact: true }).fill('new-member');
  await page.getByRole('button', { name: 'Resolve member', exact: true }).click();
  await expect.poll(() => state.resolveCalls.length).toBe(1);
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  state.resolveBarrier = undefined; release();
  await page.getByRole('button', { name: 'Add member', exact: true }).click();
  await expect(page.getByLabel('Account username', { exact: true })).toHaveValue('');
  await expect(page.getByRole('heading', { name: 'Review team access', exact: true })).toHaveCount(0);
  expect(state.writes).toHaveLength(0);
});

test('account switch cannot retain a resolved grant preview or another user membership inventory', async ({ page }) => {
  const state = await backend(page); await open(page); await resolveNew(page);
  await page.getByLabel('Your account', { exact: true }).click();
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Welcome to Golf', exact: true })).toBeVisible();
  state.user = create(UserSchema, { id: '18', login: 'other' }); state.denied = true;
  await page.getByLabel('Email or username', { exact: true }).fill('fixture-account'); await page.getByLabel('Password', { exact: true }).fill('other-token'); await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByRole('alert')).toHaveText('Team unavailable.');
  await expect(page.getByRole('table', { name: 'Team members', exact: true })).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Review team access', exact: true })).toHaveCount(0);
  await expect(page.getByLabel('Account username', { exact: true })).toHaveCount(0);
  expect(state.writes).toHaveLength(0);
});
