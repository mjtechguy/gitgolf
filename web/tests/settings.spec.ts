import { unconfiguredOwnEmail,emptyOwnEmailHistory,disabledAgentUsage } from './rpc';
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { create } from '@bufbuild/protobuf';
import { GetRepositoryLifecycleResponseSchema, GetRepositoryResponseSchema, GetAuthenticationOptionsResponseSchema, GetSessionResponseSchema, GetProfileResponseSchema, GetRepositorySettingsResponseSchema, UpdateRepositorySettingsRequestSchema, UpdateRepositorySettingsResponseSchema, GetOrganizationResponseSchema, ListCapabilitiesResponseSchema, ListRepositoriesResponseSchema, RepositorySettingsSchema, RepositoryFeatureMode, UpdateRepositoryTopicsRequestSchema, UpdateRepositoryTopicsResponseSchema, UserSchema } from '../src/gen/golf/v1/golf_pb';
import { reject, request, respond } from './rpc';

async function backend(page: Page, admin = true) {
  const state = { user: create(UserSchema, { id: '9007199254740993', login: 'alex', fullName: 'Alex', isInstanceAdmin: admin }), settings: create(RepositorySettingsSchema, { repositoryId: '9007199254740997', ownerId: '9007199254740993', description: 'Original description', defaultBranch: 'main', hasIssues: true, hasWiki: false, hasPullRequests: true, canEdit: admin, revision: 'a'.repeat(64), website: 'https://example.test', topics: ['golf'], issuesMode: RepositoryFeatureMode.INTERNAL, wikiMode: RepositoryFeatureMode.DISABLED, generalEditImplemented: true }), writes: [] as unknown[], dropped: false, denied: false, barrier: undefined as Promise<void> | undefined };
  await page.route('**/rpc/**', async (route) => {
    const method = new URL(route.request().url()).pathname.split('/').at(-1);
 if(method === 'GetAgentUsage') return disabledAgentUsage(route);
    if (method === 'GetAuthenticationOptions') return respond(route, GetAuthenticationOptionsResponseSchema, {});
    if (method === 'GetSession') return respond(route, GetSessionResponseSchema, { user: state.user });
    if(method==='GetOwnEmailNotifications')return unconfiguredOwnEmail(route,state.user.id);
    if(method==='ListOwnEmailDeliveries')return emptyOwnEmailHistory(route,state.user.id);
    if (method === 'GetProfile') return respond(route, GetProfileResponseSchema, { profile: { userId: state.user.id, login: state.user.login, fullName: state.user.fullName, revision: 'profile-revision', canEdit: true } });
    if (method === 'ListCapabilities') return respond(route, ListCapabilitiesResponseSchema, {});
    if (method === 'ListRepositories') return respond(route, ListRepositoriesResponseSchema, {});
    if (method === 'GetOrganization') return state.denied ? reject(route, 'not_found', 'Organization unavailable.') : respond(route, GetOrganizationResponseSchema, { organization: { id: '21', name: 'team', fullName: 'Team' } });
    if (method === 'GetRepository') return respond(route, GetRepositoryResponseSchema, { repository: { id: state.settings.repositoryId, name: 'demo', fullName: 'alex/demo', defaultBranch: 'main' } });
    if (method === 'GetRepositoryLifecycle') return state.denied ? reject(route, 'permission_denied', 'Repository lifecycle access denied.') : respond(route, GetRepositoryLifecycleResponseSchema, { lifecycle: { repository: { owner: 'alex', name: 'demo' }, repositoryId: state.settings.repositoryId, ownerId: state.settings.ownerId, revision: state.settings.revision, canManage: false, blockedReason: 'ownership_required' } });
    if (method === 'GetRepositorySettings') return state.denied ? reject(route, 'permission_denied', 'Repository settings access denied.') : respond(route, GetRepositorySettingsResponseSchema, { settings: state.settings });
    if (method === 'UpdateRepositorySettings') {
      const input = request(route, UpdateRepositorySettingsRequestSchema);
      state.writes.push(input);
      if (input.description !== undefined) state.settings.description = input.description;
      if(input.website !== undefined)state.settings.website=input.website;
      if(input.defaultBranch !== undefined)state.settings.defaultBranch=input.defaultBranch;
      if(input.hasPullRequests !== undefined)state.settings.hasPullRequests=input.hasPullRequests;
      if(input.issuesMode !== undefined){state.settings.issuesMode=input.issuesMode;state.settings.hasIssues=input.issuesMode!==RepositoryFeatureMode.DISABLED;state.settings.externalTracker=input.externalTracker;}
      if(input.wikiMode !== undefined){state.settings.wikiMode=input.wikiMode;state.settings.hasWiki=input.wikiMode!==RepositoryFeatureMode.DISABLED;state.settings.externalWiki=input.externalWiki;}
      if (input.hasWiki !== undefined) state.settings.hasWiki = input.hasWiki;
      state.settings.revision = 'b'.repeat(64);
      if (state.barrier) await state.barrier;
      if (state.dropped) return route.abort('failed');
      return respond(route, UpdateRepositorySettingsResponseSchema, { settings: state.settings });
    }
    if(method==='UpdateRepositoryTopics'){const input=request(route,UpdateRepositoryTopicsRequestSchema);state.writes.push(input);state.settings.topics=[...input.topics].sort();state.settings.revision='c'.repeat(64);if(state.barrier)await state.barrier;if(state.dropped)return route.abort('failed');return respond(route,UpdateRepositoryTopicsResponseSchema,{settings:state.settings});}
    return reject(route, 'not_found', 'Unsupported settings fixture.');
  });
  return state;
}

test('personal coverage distinguishes supported settings from missing enforcement and searches all displayed rows', async ({ page }) => {
  await backend(page);
  await page.goto('/account/settings');
  await expect(page.getByRole('heading', { name: 'Profile', exact: true })).toBeVisible();
  await expect(page.locator('input:not([type=search]),textarea,select:not(.data-table-page-size)')).toHaveCount(0);
  const table = page.getByRole('table', { name: 'Personal settings', exact: true });
  await expect(table.locator('tbody tr[data-row-id]')).toHaveCount(11);
  await page.getByRole('searchbox', { name: 'Search loaded Personal settings', exact: true }).fill('MFA');
  await expect(table.getByText('Passwords, recovery and MFA', { exact: true })).toBeVisible();
  await expect(table.getByText('Partial', { exact: true })).toBeVisible();
  await expect(table.getByText(/MFA, passkeys, verified email and recovery remain planned/)).toBeVisible();
  await expect(table.getByRole('link', { name: 'Open', exact: true })).toHaveAttribute('href', '/account/security');
  await expect(table.getByRole('button')).toHaveCount(3);
});

test('repository general editor cancels drafts and sends exact IDs/revision with only changed values', async ({ page }) => {
  const state = await backend(page);
  await page.goto('/repositories/alex/demo/settings');
  await expect(page.getByText('Original description', { exact: true })).toBeVisible();
  await expect(page.locator('tr[data-row-id="general"]').getByText('Ready', { exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Open Collaborators and deploy keys', exact: true })).toHaveAttribute('href', '/alex/demo/settings/access');
  await expect(page.getByRole('link', { name: 'Open CI engines and workflow controls', exact: true })).toHaveAttribute('href', '/alex/demo/settings/workflows');
  await expect(page.getByRole('link', { name: 'Open Webhooks and notifications', exact: true })).toHaveAttribute('href', '/alex/demo/settings/webhooks');
  await expect(page.locator('tr[data-row-id="events"]').getByText('Partial', { exact: true })).toBeVisible();
  await expect(page.locator('tr[data-row-id="rules"]').getByText('Partial', { exact: true })).toBeVisible();
  await expect(page.getByLabel('Description', { exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Edit general settings', exact: true }).click();
  await expect(page.getByLabel('Description', { exact: true })).toBeFocused();
  await page.getByLabel('Description', { exact: true }).fill('Cancelled draft');
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Edit general settings', exact: true })).toBeFocused();
  expect(state.writes).toHaveLength(0);
  await page.getByRole('button', { name: 'Edit general settings', exact: true }).click();
  await expect(page.getByLabel('Description', { exact: true })).toHaveValue('Original description');
  await page.getByLabel('Description', { exact: true }).fill('<b>Literal description</b>');
  await expect(page.getByLabel('Wiki', { exact: true })).toHaveValue(String(RepositoryFeatureMode.DISABLED));
  await page.getByLabel('Pull requests', { exact: true }).selectOption('false');
  await page.getByRole('button', { name: 'Save repository settings', exact: true }).click();
  await expect(page.getByText('Repository settings saved.', { exact: true })).toBeVisible();
  await expect(page.getByText('<b>Literal description</b>', { exact: true })).toBeVisible();
  expect(state.writes).toMatchObject([{ repository: { owner: 'alex', name: 'demo' }, repositoryId: '9007199254740997', ownerId: '9007199254740993', expectedRevision: 'a'.repeat(64), description: '<b>Literal description</b>', hasPullRequests: false }]);
  expect((state.writes[0] as Record<string, unknown>).hasWiki).toBeUndefined();
  expect((state.writes[0] as Record<string, unknown>).hasIssues).toBeUndefined();
  await expect(page.getByRole('dialog')).toHaveCount(0);
});

test('duplicate settings submissions dispatch once and navigation discards a late receipt', async ({ page }) => {
  const state = await backend(page);
  let release!: () => void;
  state.barrier = new Promise<void>((resolve) => { release = resolve; });
  await page.goto('/repositories/alex/demo/settings');
  await page.getByRole('button', { name: 'Edit general settings', exact: true }).click();
  await page.getByLabel('Description', { exact: true }).fill('One dispatch');
  await page.locator('form').evaluate((form) => {
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  });
  await expect.poll(() => state.writes.length).toBe(1);
  await expect(page.getByRole('button', { name: 'Saving…', exact: true })).toBeDisabled();
  await page.getByRole('navigation', { name: 'Workspace', exact: true }).getByRole('link', { name: 'Repositories', exact: false }).click();
  release();
  await page.goto('/repositories/alex/demo/settings');
  await expect(page.getByText('One dispatch', { exact: true })).toBeVisible();
  await expect(page.getByText('Repository settings saved.', { exact: true })).toHaveCount(0);
  await expect(page.getByLabel('Description', { exact: true })).toHaveCount(0);
  expect(state.writes).toHaveLength(1);
});

test('lost settings response blocks retry until current values are inspected and denial clears private values', async ({ page }) => {
  const state = await backend(page);
  state.dropped = true;
  await page.goto('/repositories/alex/demo/settings');
  await page.getByRole('button', { name: 'Edit general settings', exact: true }).click();
  await page.getByLabel('Description', { exact: true }).fill('Applied without receipt');
  await page.getByRole('button', { name: 'Save repository settings', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Save could not be confirmed', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Edit general settings', exact: true })).toBeDisabled();
  expect(state.writes).toHaveLength(1);
  await page.getByRole('button', { name: 'Inspect current repository settings', exact: true }).click();
  await expect(page.getByText('Applied without receipt', { exact: true })).toBeVisible();
  expect(state.writes).toHaveLength(1);
  state.denied = true;
  await page.getByRole('button', { name: 'Refresh repository settings', exact: true }).click();
  await expect(page.getByRole('region', { name: 'General', exact: true }).getByRole('alert')).toHaveText('Repository settings access denied.');
  await expect(page.getByText('Applied without receipt', { exact: true })).toHaveCount(0);
  await expect(page.locator('tr[data-row-id="general"]').getByText('Ready', { exact: true })).toHaveCount(0);
  await expect(page.locator('tr[data-row-id="general"]').getByText('Partial', { exact: true })).toBeVisible();
});

test('read-only repository users get no edit action and non-admin instance settings deny access', async ({ page }) => {
  await backend(page, false);
  await page.goto('/repositories/alex/demo/settings');
  await expect(page.getByText('Original description', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Edit general settings', exact: true })).toHaveCount(0);
  await expect(page.locator('tr[data-row-id="general"]').getByText('Ready', { exact: true })).toBeVisible();
  await page.goto('/admin/settings');
  await expect(page.getByRole('heading', { name: 'Instance settings', exact: true })).toHaveCount(0);
  await expect(page.getByRole('table', { name: 'Instance settings', exact: true })).toHaveCount(0);
});

test('organization settings require membership, distinguish planned policy and fit mobile without global overflow', async ({ page }) => {
  const state = await backend(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/organizations/team/settings');
  await expect(page.getByRole('heading', { name: 'Organization settings', exact: true })).toBeVisible();
  const table = page.getByRole('table', { name: 'Organization settings', exact: true });
  await expect(table.locator('tbody tr[data-row-id]')).toHaveCount(10);
  await expect(table.getByText('CI, workflows and fork trust', { exact: true })).toBeVisible();
  await expect(page.locator('input:not([type=search]),textarea,select:not(.data-table-page-size)')).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  state.denied = true;
  await page.reload();
  await expect(page.getByRole('table', { name: 'Organization settings', exact: true })).toHaveCount(0);
});

for(const theme of ['dark','light'])for(const width of [390,1440])test(`General explicit metadata and external modes save/reload ${theme} ${width}`,async({page})=>{
 const state=await backend(page);await page.addInitScript((theme)=>localStorage.setItem('golf.theme',theme),theme);await page.setViewportSize({width,height:900});await page.goto('/alex/demo/settings');
 await expect(page.locator('html')).toHaveAttribute('data-theme',theme);await expect(page.getByRole('link',{name:'https://example.test',exact:true})).toBeVisible();await page.getByRole('button',{name:'Edit general settings',exact:true}).click();
 await page.getByLabel('Website',{exact:true}).fill('https://docs.example.test/golf');await page.getByLabel('Issues',{exact:true}).selectOption(String(RepositoryFeatureMode.EXTERNAL));
 await page.getByLabel('External tracker URL',{exact:true}).fill('https://issues.example.test');await page.getByLabel('External issue URL format',{exact:true}).fill('https://issues.example.test/{repo}/{index}');await page.getByLabel('Issue identifier style',{exact:true}).selectOption('regexp');await page.getByLabel('Issue identifier pattern',{exact:true}).fill('GOLF-[0-9]+');
 await page.getByLabel('Wiki',{exact:true}).selectOption(String(RepositoryFeatureMode.EXTERNAL));await page.getByLabel('External wiki URL',{exact:true}).fill('https://wiki.example.test');
 await page.getByRole('button',{name:'Save repository settings',exact:true}).click();await expect(page.getByText('Repository settings saved.',{exact:true})).toBeVisible();
 expect(state.writes).toHaveLength(1);expect(state.writes[0]).toMatchObject({repositoryId:state.settings.repositoryId,ownerId:state.settings.ownerId,expectedRevision:'a'.repeat(64),website:'https://docs.example.test/golf',issuesMode:RepositoryFeatureMode.EXTERNAL,wikiMode:RepositoryFeatureMode.EXTERNAL,externalTracker:{url:'https://issues.example.test',format:'https://issues.example.test/{repo}/{index}',style:'regexp',regexpPattern:'GOLF-[0-9]+'},externalWiki:{url:'https://wiki.example.test'}});
 await page.reload();await expect(page.getByText('https://wiki.example.test',{exact:true})).toBeVisible();await expect(page.getByRole('dialog')).toHaveCount(0);expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
 await page.getByRole('button',{name:'Edit topics',exact:true}).click();await expect(page.getByRole('textbox',{name:'Topics',exact:true})).toBeFocused();await page.getByRole('textbox',{name:'Topics',exact:true}).fill('agents, git');await page.getByRole('button',{name:'Save topics',exact:true}).click();await expect(page.getByText('Repository topics saved.',{exact:true})).toBeVisible();await page.reload();await expect(page.getByText('agents, git',{exact:true})).toBeVisible();expect(state.writes).toHaveLength(2);
 await page.getByRole('button',{name:'Edit general settings',exact:true}).click();await expect(page.getByLabel('External issue URL format',{exact:true})).toHaveValue('https://issues.example.test/{repo}/{index}');await page.getByLabel('Description',{exact:true}).fill('Only description');await page.getByRole('button',{name:'Save repository settings',exact:true}).click();await expect(page.getByText('Repository settings saved.',{exact:true})).toBeVisible();expect((state.writes[2] as Record<string,unknown>).externalTracker).toBeUndefined();expect((state.writes[2] as Record<string,unknown>).issuesMode).toBeUndefined();expect(state.settings.externalWiki?.url).toBe('https://wiki.example.test');
 await page.getByRole('button',{name:'Edit general settings',exact:true}).click();await page.getByLabel('Issues',{exact:true}).selectOption(String(RepositoryFeatureMode.INTERNAL));await page.getByLabel('Wiki',{exact:true}).selectOption(String(RepositoryFeatureMode.DISABLED));await page.getByRole('button',{name:'Save repository settings',exact:true}).click();await expect(page.getByText('Repository settings saved.',{exact:true})).toBeVisible();expect(state.settings.externalTracker).toBeUndefined();expect(state.settings.externalWiki).toBeUndefined();expect(state.writes).toHaveLength(4);
});

test('settings refresh preserves dirty draft but refuses externally changed revision; denial clears it',async({page})=>{
 const state=await backend(page);await page.goto('/alex/demo/settings');await page.getByRole('button',{name:'Edit general settings',exact:true}).click();await page.getByLabel('Description',{exact:true}).fill('Private unsaved draft');
 state.settings.description='External update';state.settings.revision='d'.repeat(64);await page.getByRole('button',{name:'Refresh repository settings',exact:true}).click();await expect(page.getByLabel('Description',{exact:true})).toHaveValue('Private unsaved draft');await page.getByRole('button',{name:'Save repository settings',exact:true}).click();await expect(page.getByRole('alert')).toContainText('Current settings changed');expect(state.writes).toHaveLength(0);
 state.denied=true;await page.getByRole('button',{name:'Refresh repository settings',exact:true}).click();await expect(page.getByRole('region', { name: 'General', exact: true }).getByRole('alert')).toHaveText('Repository settings access denied.');await expect(page.getByLabel('Description',{exact:true})).toHaveCount(0);await expect(page.getByText('External update',{exact:true})).toHaveCount(0);
});

test('wrong immutable settings receipt blocks success and further writes',async({page})=>{
 const state=await backend(page);await page.goto('/alex/demo/settings');await page.getByRole('button',{name:'Edit general settings',exact:true}).click();await page.getByLabel('Description',{exact:true}).fill('Uncertain original');state.settings.repositoryId='99';await page.getByRole('button',{name:'Save repository settings',exact:true}).click();await expect(page.getByRole('heading',{name:'Save could not be confirmed',exact:true})).toBeVisible();await expect(page.getByText('Repository settings saved.',{exact:true})).toHaveCount(0);expect(state.writes).toHaveLength(1);await page.getByRole('button',{name:'Inspect current repository settings',exact:true}).click();await expect(page.getByRole('alert')).toContainText('identity or configuration');await expect(page.getByText('Uncertain original',{exact:true})).toHaveCount(0);expect(state.writes).toHaveLength(1);
});

test('topics validation and lost response never replay replacement',async({page})=>{
 const state=await backend(page);await page.goto('/alex/demo/settings');await page.getByRole('button',{name:'Edit topics',exact:true}).click();await page.getByRole('textbox',{name:'Topics',exact:true}).fill('Bad Topic, duplicate, duplicate');await page.getByRole('button',{name:'Save topics',exact:true}).click();await expect(page.getByRole('alert')).toContainText('unique lowercase');expect(state.writes).toHaveLength(0);state.dropped=true;await page.getByRole('textbox',{name:'Topics',exact:true}).fill('actual-change');await page.getByRole('button',{name:'Save topics',exact:true}).click();await expect(page.getByRole('heading',{name:'Save could not be confirmed',exact:true})).toBeVisible();expect(state.writes).toHaveLength(1);await page.getByRole('button',{name:'Inspect current repository settings',exact:true}).click();await expect(page.getByText('actual-change',{exact:true})).toBeVisible();expect(state.writes).toHaveLength(1);
});

test('private dirty form is hidden and inert during revalidation then restored without reset',async({page})=>{
 const state=await backend(page);await page.goto('/alex/demo/settings');await page.getByRole('button',{name:'Edit general settings',exact:true}).click();await page.getByLabel('Description',{exact:true}).fill('Retained private draft');let release!:()=>void;const barrier=new Promise<void>(resolve=>release=resolve);
 await page.route('**/rpc/golf.v1.RepositorySettingsService/GetRepositorySettings',async route=>{await barrier;return respond(route,GetRepositorySettingsResponseSchema,{settings:state.settings});});await page.getByRole('button',{name:'Refresh repository settings',exact:true}).click();await expect(page.getByRole('status',{name:''}).filter({hasText:'Loading repository settings'})).toBeVisible();await expect(page.getByRole('form',{name:'Edit repository general settings',exact:true})).toHaveCount(0);await expect(page.locator('form[aria-label="Edit repository general settings"]').locator('..')).toHaveAttribute('inert','');expect(state.writes).toHaveLength(0);release();await expect(page.getByLabel('Description',{exact:true})).toHaveValue('Retained private draft');await page.getByRole('button',{name:'Cancel',exact:true}).click();expect(state.writes).toHaveLength(0);
});

test('authority downgrade clears the editor without claiming unsupported configuration',async({page})=>{
 const state=await backend(page);await page.goto('/alex/demo/settings');await page.getByRole('button',{name:'Edit topics',exact:true}).click();await page.getByRole('textbox',{name:'Topics',exact:true}).fill('private-draft');state.settings.canEdit=false;await page.getByRole('button',{name:'Refresh repository settings',exact:true}).click();await expect(page.getByRole('textbox',{name:'Topics',exact:true})).toHaveCount(0);await expect(page.getByRole('button',{name:'Edit topics',exact:true})).toHaveCount(0);await expect(page.getByText('View only',{exact:true})).toBeVisible();await expect(page.getByText(/Website, topics, default branch and tracker\/wiki configuration editors are qualified/)).toBeVisible();expect(state.writes).toHaveLength(0);
});
