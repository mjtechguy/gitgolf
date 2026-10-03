import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { create } from '@bufbuild/protobuf';
import { GetAuthenticationOptionsResponseSchema, GetOrganizationRequestSchema, GetOrganizationResponseSchema, GetRepositoryResponseSchema, GetSessionResponseSchema, GetTeamRequestSchema, GetTeamResponseSchema, ListCapabilitiesResponseSchema, ListOrganizationsRequestSchema, ListOrganizationsResponseSchema, ListRepositoriesResponseSchema, ListTeamMembersRequestSchema, ListTeamMembersResponseSchema, ListTeamRepositoriesRequestSchema, ListTeamRepositoriesResponseSchema, ListTeamsRequestSchema, ListTeamsResponseSchema, LoginWithGiteaTokenResponseSchema, LogoutResponseSchema, OrganizationSchema, OrganizationTeamSchema, OrganizationVisibility, TeamPermission, TeamVisibility, UserSchema } from '../src/gen/golf/v1/golf_pb';
import { reject, request, respond } from './rpc';

const teamId = '9007199254740993';
const organization = create(OrganizationSchema, { id: '9007199254740994', name: 'lab', fullName: 'Private Lab', description: '<script>window.executed=true</script> Organization details.', visibility: OrganizationVisibility.PRIVATE });
const team = create(OrganizationTeamSchema, { id: teamId, name: 'Platform', description: 'Private platform team', visibility: TeamVisibility.PRIVATE, permission: TeamPermission.ADMIN, includesAllRepositories: true, unitPermissions: { 'repo.code': TeamPermission.WRITE, 'repo.issues': TeamPermission.READ, '<img src=x onerror=alert(1)>': TeamPermission.NONE } });
type Failure = 'permission_denied' | 'not_found' | 'unauthenticated' | 'unavailable';

async function backend(page: Page) {
  const state = { signedIn: true, login: 'alex', empty: false, failures: {} as Record<string, Failure>, calls: [] as string[], teamIds: [] as string[] };
  await page.route('**/rpc/**', async (route) => {
    const method = new URL(route.request().url()).pathname.split('/').at(-1)!;
    const user = create(UserSchema, { id: state.login === 'alex' ? '11' : '12', login: state.login });
    if (method === 'GetAuthenticationOptions') return respond(route, GetAuthenticationOptionsResponseSchema, {});
    if (method === 'LoginWithGiteaToken') { state.signedIn = true; return respond(route, LoginWithGiteaTokenResponseSchema, { user }); }
    if (method === 'Logout') { state.signedIn = false; return respond(route, LogoutResponseSchema, {}); }
    if (!state.signedIn) return reject(route, 'unauthenticated', 'Sign in required.');
    if (method === 'GetSession') return respond(route, GetSessionResponseSchema, { user });
    if (method === 'ListCapabilities') return respond(route, ListCapabilitiesResponseSchema, {});
    if (method === 'ListRepositories') return respond(route, ListRepositoriesResponseSchema, {});
    if (method === 'GetRepository') return respond(route, GetRepositoryResponseSchema, { repository: { id: '50', name: 'engine', fullName: 'lab/engine', private: true, empty: true } });
    state.calls.push(method);
    const failure = state.failures[method];
    if (failure) {
      if (failure === 'unauthenticated') state.signedIn = false;
      return reject(route, failure, failure === 'permission_denied' ? 'Organization browsing requires read:organization and provider permission.' : failure === 'unavailable' ? 'Gitea is temporarily unavailable.' : 'Organization or team not found or inaccessible.');
    }
    if (state.login !== 'alex') return reject(route, 'not_found', 'Organization or team not found or inaccessible.');
    if (method === 'ListOrganizations') {
      const input = request(route, ListOrganizationsRequestSchema);
      expect(input.page?.limit).toBe(20);
      return respond(route, ListOrganizationsResponseSchema, state.empty ? {} : input.page?.page === 2 ? { organizations: [{ ...organization, id: '2', name: '1234', fullName: 'Numeric organization' }] } : { organizations: [organization], page: { nextPage: 2 } });
    }
    if (method === 'GetOrganization') {
      const input = request(route, GetOrganizationRequestSchema);
      if (!['lab', '1234'].includes(input.organization)) return reject(route, 'not_found', 'Organization or team not found or inaccessible.');
      return respond(route, GetOrganizationResponseSchema, { organization: { ...organization, name: input.organization } });
    }
    if (method === 'ListTeams') {
      const input = request(route, ListTeamsRequestSchema);
      return respond(route, ListTeamsResponseSchema, state.empty ? {} : input.page?.page === 2 ? { teams: [{ ...team, id: '22', name: 'Owners', permission: TeamPermission.OWNER, visibility: TeamVisibility.LIMITED }] } : { teams: [team], page: { nextPage: 2 } });
    }
    if (method === 'GetTeam') {
      const input = request(route, GetTeamRequestSchema);
      state.teamIds.push(input.teamId);
      return respond(route, GetTeamResponseSchema, { team });
    }
    if (method === 'ListTeamMembers') {
      const input = request(route, ListTeamMembersRequestSchema);
      state.teamIds.push(input.teamId);
      return respond(route, ListTeamMembersResponseSchema, input.page?.page === 2 ? { members: [{ id: '32', login: 'second-member' }] } : { members: [{ id: '31', login: 'private-member', fullName: '<img src=x onerror=alert(1)>' }], page: { nextPage: 2 } });
    }
    if (method === 'ListTeamRepositories') {
      const input = request(route, ListTeamRepositoriesRequestSchema);
      state.teamIds.push(input.teamId);
      // The provider can filter all records in a page while still offering another page.
      return respond(route, ListTeamRepositoriesResponseSchema, input.page?.page === 2 ? { repositories: [{ id: '50', name: 'engine', fullName: 'lab/engine', description: 'Private team repository', private: true }] } : { repositories: [], page: { nextPage: 2 } });
    }
    return reject(route, 'not_found', 'Method not found.');
  });
  return state;
}

test('organization/team routes paginate, preserve opaque IDs and support back, reload and source links', async ({ page }) => {
  const state = await backend(page);
  await page.goto('/');
  await page.getByRole('link', { name: 'Organizations', exact: true }).focus();
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/\/organizations$/);
  await page.getByRole('button', { name: 'Load more your organizations' }).click();
  await page.getByRole('link', { name: '1234', exact: true }).click();
  await expect(page.getByRole('heading', { name: /1234/ })).toBeVisible();
  await page.goBack();
  await page.getByRole('link', { name: 'lab', exact: true }).click();
  await page.getByRole('button', { name: 'Load more teams' }).click();
  await expect(page.getByRole('link', { name: 'Owners', exact: true })).toBeVisible();
  await page.getByRole('link', { name: 'Platform', exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`team=${teamId}$`));
  await expect(page.getByRole('heading', { name: 'Platform', exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByText('private-member', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Load more members' }).click();
  await expect(page.getByText('second-member', { exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'No visible repositories in the loaded pages.' })).toBeVisible();
  await page.getByRole('button', { name: 'Load more repositories' }).click();
  await page.getByRole('link', { name: 'lab/engine', exact: true }).click();
  await expect(page).toHaveURL(/\/lab\/engine$/);
  await expect(page.getByRole('heading', { name: 'No commits yet.' })).toBeVisible();
  await page.goBack();
  await expect(page.getByRole('heading', { name: 'Platform', exact: true })).toBeVisible();
  expect(state.teamIds.length).toBeGreaterThan(0);
  expect(state.teamIds.every((value) => value === teamId)).toBe(true);
});

test('native permissions are plain metadata and independent team panels show scoped denials', async ({ page }) => {
  const state = await backend(page);
  state.failures.ListTeamMembers = 'permission_denied';
  await page.goto(`/organizations/lab?team=${teamId}`);
  await expect(page.getByText('not a computed effective Golf role', { exact: false })).toBeVisible();
  await expect(page.getByText('Issue read permission may allow commenting', { exact: false })).toBeVisible();
  await expect(page.getByText('All repositories (provider setting)', { exact: true })).toBeVisible();
  await expect(page.getByText('repo.issues', { exact: true })).toBeVisible();
  await expect(page.locator('.organization-browser img,.organization-browser script')).toHaveCount(0);
  await expect(page.getByRole('region', { name: 'Members', exact: true }).getByRole('alert')).toHaveText(/read:organization/);
  await page.getByRole('button', { name: 'Load more repositories' }).click();
  await expect(page.getByRole('link', { name: 'lab/engine', exact: true })).toBeVisible();
  delete state.failures.ListTeamMembers;
  await page.getByRole('region', { name: 'Members', exact: true }).getByRole('button', { name: 'Try again' }).click();
  await expect(page.getByText('private-member', { exact: true })).toBeVisible();
  state.failures.ListTeamRepositories = 'not_found';
  await page.getByRole('button', { name: 'Refresh repositories', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Repositories', exact: true }).getByRole('alert')).toBeVisible();
  await expect(page.getByText('lab/engine', { exact: true })).toHaveCount(0);
  await expect(page.getByText('private-member', { exact: true })).toBeVisible();
  expect(await page.evaluate(() => (window as Window & { executed?: boolean }).executed)).toBeUndefined();
});

test('lost team/organization access hides all nested private data and expiry clears the workspace', async ({ page }) => {
  const state = await backend(page);
  await page.goto(`/organizations/lab?team=${teamId}`);
  await expect(page.getByText('private-member', { exact: true })).toBeVisible();
  state.failures.GetTeam = 'not_found';
  await page.getByRole('button', { name: 'Refresh team access' }).click();
  await expect(page.getByRole('alert')).toBeVisible();
  await expect(page.getByText('Private platform team', { exact: true })).toHaveCount(0);
  await expect(page.getByText('private-member', { exact: true })).toHaveCount(0);
  delete state.failures.GetTeam;
  await page.getByRole('button', { name: 'Try again' }).click();
  await expect(page.getByText('private-member', { exact: true })).toBeVisible();
  state.failures.GetOrganization = 'permission_denied';
  await page.getByRole('button', { name: 'Refresh organization access' }).click();
  await expect(page.getByRole('alert')).toHaveText(/read:organization/);
  await expect(page.getByText('Private Lab', { exact: true })).toHaveCount(0);
  await expect(page.getByText('private-member', { exact: true })).toHaveCount(0);
  state.failures.GetOrganization = 'unauthenticated';
  await page.getByRole('button', { name: 'Try again' }).click();
  await expect(page.getByRole('heading', { name: 'Welcome to Golf' })).toBeVisible();
  await expect(page.locator('.organization-browser')).toHaveCount(0);
});

test('organization scope, provider outage and genuine empty memberships remain distinct', async ({ page }) => {
  const state = await backend(page);
  state.failures.ListOrganizations = 'permission_denied';
  await page.goto('/organizations');
  await expect(page.getByRole('alert')).toHaveText(/read:organization/);
  await expect(page.getByRole('heading', { name: 'No organization memberships returned.' })).toHaveCount(0);
  state.failures.ListOrganizations = 'unavailable';
  await page.getByRole('button', { name: 'Try again' }).click();
  await expect(page.getByRole('alert')).toHaveText('Gitea is temporarily unavailable.');
  delete state.failures.ListOrganizations;
  state.empty = true;
  await page.getByRole('button', { name: 'Try again' }).click();
  await expect(page.getByRole('heading', { name: 'No organization memberships returned.' })).toBeVisible();
});

test('team search rejects noncanonical and overflowing IDs without provider requests', async ({ page }) => {
  const state = await backend(page);
  for (const invalid of ['0', '01', '-1', '1e3', '', '9223372036854775808']) {
    await page.goto(`/organizations/lab?team=${encodeURIComponent(invalid)}`);
    await expect(page.getByRole('heading', { name: 'Page not found' })).toBeVisible();
  }
  expect(state.calls).toEqual([]);
});

test('private organization views do not survive sign-out and a different user', async ({ page }) => {
  const state = await backend(page);
  await page.goto(`/organizations/lab?team=${teamId}`);
  await expect(page.getByText('private-member', { exact: true })).toBeVisible();
  await page.getByLabel('Your account', { exact: true }).click(); await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Welcome to Golf' })).toBeVisible();
  state.login = 'bob';
  await page.getByText('Advanced token sign-in', { exact: true }).click();
  await page.getByLabel('Provider access token').fill('bob-fixture-token');
  await page.getByRole('button', { name: 'Continue to workspace' }).click();
  await expect(page.getByRole('alert')).toHaveText('Organization or team not found or inaccessible.');
  await expect(page.getByText('private-member', { exact: true })).toHaveCount(0);
  await expect(page.getByText('Private Lab', { exact: true })).toHaveCount(0);
  expect(await page.evaluate(() => JSON.stringify({ ...localStorage, ...sessionStorage }))).not.toContain('private-member');
});

test('organization team detail fits charcoal desktop and light mobile with keyboard navigation', async ({ page }) => {
  await backend(page);
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.goto(`/organizations/lab?team=${teamId}`);
  await expect(page.getByRole('heading', { name: 'Native unit permissions' })).toBeVisible();
  await page.screenshot({ path: 'test-results/organization-dark.png', fullPage: true });
  if (await page.locator('html').getAttribute('data-theme') !== 'light') await page.getByRole('button', { name: 'Switch to light theme', exact: true }).click();
  await page.setViewportSize({ width: 320, height: 740 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: 'test-results/organization-mobile-light.png', fullPage: true });
  await page.getByRole('link', { name: 'All teams', exact: true }).focus();
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/\/organizations\/lab$/);
  await expect(page.getByRole('link', { name: 'Platform', exact: true })).toBeVisible();
});
