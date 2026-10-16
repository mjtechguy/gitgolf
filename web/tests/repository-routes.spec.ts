import { portableRuntimeFixture } from './runtime-fixture';
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import {
  GetRepositoryMirrorStatusResponseSchema, GetRepositoryLifecycleResponseSchema, RepositoryFeatureMode, GetAuthenticationOptionsResponseSchema, GetSessionResponseSchema, ListCapabilitiesResponseSchema,
  GetRepositorySettingsResponseSchema, GetRepositoryAccessResponseSchema, ListRepositoryCollaboratorsResponseSchema,
  InspectWorkflowsResponseSchema, GetRepositoryResponseSchema, GetContentsRequestSchema, GetContentsResponseSchema,
  ListBranchesResponseSchema, ListCommitsRequestSchema, ListCommitsResponseSchema, ResolveRepositorySourceRequestSchema, SourceEntryType,
} from '../src/gen/golf/v1/golf_pb';
import { resolveSourceFixture, disabledAgentUsage, disabledAgentTasks, reject, request, respond } from './rpc';

const snapshot = 'a'.repeat(40), other = 'b'.repeat(40);
const user = { id: '17', login: 'alex', fullName: 'Alex' };
const repository = { id: '19', owner: user, name: 'demo', fullName: 'alex/demo', defaultBranch: 'main' };
async function fixture(page: Page, profile = 'docker') {
  const state = { capabilitiesFailed: false, capabilitiesBarrier: undefined as Promise<void> | undefined, nativeCapabilities: [{id:'settings.repository-general',label:'General settings',state:3,reason:'Available'}, {id:'settings.repository-access',label:'Repository access',state:3,reason:'Available'}, {id:'settings.repository-rules',label:'Rules and merge policy',state:1,reason:'Protected merge enforcement is not implemented on Cloudflare native.'}], denied: false, signedIn: true, methods: [] as string[], authorityURLs: [] as string[], canonicalBodies: [] as {method:string;repository:unknown}[], refs: [] as string[], selections: [] as ReturnType<typeof request<typeof ResolveRepositorySourceRequestSchema>>[] };
  await page.route('**/rpc/**', async route => {
    const method = route.request().url().split('/').at(-1)!;
    state.methods.push(method);
    if(method==='GetRepository')state.canonicalBodies.push({method,repository:{...route.request().postDataJSON().repository}});
    if(method==='GetRepositorySettings')state.canonicalBodies.push({method,repository:{...route.request().postDataJSON().repository}});
    if(method==='GetRepositoryLifecycle')state.canonicalBodies.push({method,repository:{...route.request().postDataJSON().repository}});
    if (['GetRepository', 'GetRepositorySettings', 'GetRepositoryLifecycle', 'GetRepositoryAccess', 'InspectWorkflows'].includes(method)) state.authorityURLs.push(page.url());
    if (method === 'GetAuthenticationOptions') return respond(route, GetAuthenticationOptionsResponseSchema, { localPasswordEnabled: true });
    if (method === 'GetSession') return state.signedIn ? respond(route, GetSessionResponseSchema, { user }) : reject(route, 'unauthenticated', 'Signed out.');
    if (method === 'ListCapabilities') { if (state.capabilitiesBarrier) await state.capabilitiesBarrier; return state.capabilitiesFailed ? reject(route, 'unavailable', 'Capabilities temporarily unavailable.') : respond(route, ListCapabilitiesResponseSchema, profile === 'cloudflare-native' ? {runtimeProfile:profile,capabilities:state.nativeCapabilities} : {...portableRuntimeFixture,runtimeProfile:profile}); }
    if (state.denied) return reject(route, 'permission_denied', 'Current repository access denied.');
    if(method==='GetRepositoryLifecycle') return respond(route,GetRepositoryLifecycleResponseSchema,{lifecycle:{repository:{owner:'alex',name:'demo'},repositoryId:repository.id,ownerId:user.id,revision:'a'.repeat(64),canManage:false,blockedReason:'ownership_required'}});
    if(method==='GetRepositoryMirrorStatus') return respond(route,GetRepositoryMirrorStatusResponseSchema,{repository:{owner:'alex',name:'demo'},repositoryId:repository.id});
    if (method === 'GetRepositorySettings') return respond(route, GetRepositorySettingsResponseSchema, { settings: {
      repositoryId: repository.id, ownerId: user.id, description: 'PRIVATE route settings', defaultBranch: 'main', canEdit: true, revision: 'a'.repeat(64), generalEditImplemented:true, issuesMode:RepositoryFeatureMode.INTERNAL, wikiMode:RepositoryFeatureMode.DISABLED, hasIssues: true, hasPullRequests: true,
    } });
    if (method === 'GetRepositoryAccess') return respond(route, GetRepositoryAccessResponseSchema, { access: {
      repositoryId: repository.id, ownerId: user.id, owner: user, canManage: true, currentPermission: 'admin', revision: 'a'.repeat(64),
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
  ['settings', 'General settings', 'GetRepositorySettings'],
  ['settings/access', 'Repository access', 'GetRepositoryAccess'],
  ['settings/workflows', 'Workflow configuration', 'InspectWorkflows'],
] as const;

test('workspace frame stays aligned between repository, list, and account pages', async ({page}) => {
  test.setTimeout(60_000);
  await fixture(page);
  for (const appearance of ['classic', 'golf', 'flare']) for (const width of [1440, 320]) {
    await page.setViewportSize({width, height:900});
    await page.goto('/alex/demo');
    await page.evaluate(value => localStorage.setItem('golf.appearance', value), appearance);
    await page.reload();
    await expect(page.locator('.repository-context')).toHaveAttribute('aria-label', 'alex/demo');
    await expect(page.locator('.workspace-navigation a').first()).toHaveAttribute('aria-current', 'page');
    // Since 882ba28 the workspace switcher is mounted only on home and organization pages, so it is not part of the shared frame.
    // Since fa4dbd3 the repository list is .repository-index rather than .workspace-intro.
    const frame = () => page.evaluate(() => {
      const x = (selector:string) => Math.round(document.querySelector(selector)!.getBoundingClientRect().x);
      return {header:Math.round(document.querySelector('.topbar')!.getBoundingClientRect().height), menu:x('.global-menu'), account:x('.topbar-controls .account-menu'), content:x('.repository-context, .repository-index, .account-layout'), overflow:document.documentElement.scrollWidth > innerWidth};
    });
    const repositoryFrame = await frame();
    // Since 27098d4 wide layouts without top navigation hide the workspace menu and show the Workspace links instead.
    const workspaceMenu = page.getByLabel('Open workspace navigation', {exact:true});
    if (await workspaceMenu.isVisible()) { await workspaceMenu.click(); await page.getByRole('navigation', {name:'Workspace menu', exact:true}).getByRole('link', {name:'Repositories', exact:true}).click(); }
    else await page.getByRole('navigation', {name:'Workspace', exact:true}).getByRole('link', {name:'Repositories', exact:true}).click();
    await expect(page).toHaveURL('/');
    expect(await frame()).toEqual(repositoryFrame);
    await page.getByLabel('Your account', {exact:true}).click();
    await page.getByRole('link', {name:'User settings', exact:true}).click();
    await expect(page).toHaveURL('/account/settings');
    expect(await frame()).toEqual(repositoryFrame);
    expect(repositoryFrame.overflow).toBe(false);
  }
});

for (const profile of ['local', 'docker', 'kubernetes', 'cloudflare-native']) for (const width of [320, 1440]) test(`persistent repository frame and settings navigation ${profile} ${width}`, async ({page}) => {
  const state = await fixture(page, profile);
  await page.addInitScript(theme=>localStorage.setItem('golf.theme',theme), profile==='local'||profile==='kubernetes'?'dark':'light');
  await page.setViewportSize({width, height:900});
  await page.goto('/alex/demo');
  const tabs = page.getByRole('navigation', {name:'Repository',exact:true});
  await expect(tabs.getByRole('link',{name:'Code',exact:true})).toHaveAttribute('aria-current','page');
  const header = await page.locator('.topbar').elementHandle(), navigation = await tabs.elementHandle();
  await page.getByLabel('Open workspace navigation',{exact:true}).click();
  await expect(page.getByRole('navigation',{name:'Workspace menu',exact:true})).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('navigation',{name:'Workspace menu',exact:true})).toBeHidden();
  await expect(page.getByLabel('Open workspace navigation',{exact:true})).toBeFocused();
  await tabs.getByRole('link',{name:'Settings',exact:true}).click();
  await expect(page.getByText('PRIVATE route settings',{exact:true})).toBeVisible();
  await expect(tabs.getByRole('link',{name:'Settings',exact:true})).toHaveAttribute('aria-current','page');
  await expect(tabs.locator('[aria-current="page"]')).toHaveCount(1);
  expect(await header!.evaluate(node=>node.isConnected)).toBe(true);
  expect(await navigation!.evaluate(node=>node.isConnected)).toBe(true);
  await expect(page.getByRole('heading',{name:'Settings coverage',exact:true})).toHaveCount(0);
  const sidebar = await page.locator('.repository-settings-layout > .account-navigation').elementHandle();
  const picker = page.getByRole('combobox',{name:'Settings section',exact:true});
  if(width===320) await expect(picker).toBeVisible(); else await expect(picker).toBeHidden();
  if(profile!=='cloudflare-native') {
    if(width===320) await picker.selectOption('/$owner/$name/settings/access');
    else await page.getByRole('navigation',{name:'Repository settings',exact:true}).getByRole('link',{name:'Access',exact:true}).click();
    await expect(page.getByRole('heading',{name:'Repository access',exact:true})).toBeVisible();
    expect(await sidebar!.evaluate(node=>node.isConnected)).toBe(true);
    expect(await navigation!.evaluate(node=>node.isConnected)).toBe(true);
    await page.goBack();
    await expect(page.getByText('PRIVATE route settings',{exact:true})).toBeVisible();
  }
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  await page.screenshot({path:`test-results/repository-shell-${profile}-${width}.png`,fullPage:true});
  await tabs.getByRole('link',{name:'Code',exact:true}).click();
  await expect(tabs.getByRole('link',{name:'Code',exact:true})).toHaveAttribute('aria-current','page');
  expect(await header!.evaluate(node=>node.isConnected)).toBe(true);
  expect(await navigation!.evaluate(node=>node.isConnected)).toBe(true);
  // Revoke at the settings read, so concurrent source revalidation cannot
  // correctly remove the navigation before this test clicks it.
  await page.route('**/rpc/**/GetRepositorySettings', route => {
    state.denied=true;
    return reject(route, 'permission_denied', 'Current repository access denied.');
  });
  await tabs.getByRole('link',{name:'Settings',exact:true}).click();
  await expect(page.getByRole('alert').filter({hasText:'Current repository access denied.'}).first()).toBeVisible();
  await expect(page.getByText('PRIVATE route settings',{exact:true})).toHaveCount(0);
  expect(state.methods.some(method=>/^(Update|Set|Create|Delete|Dispatch|Save|Activate|Remove)/.test(method))).toBe(false);
});
for (const [tail, heading, method] of settingsPages) test(`legacy ${tail} normalizes before reading the canonical settings page`, async ({ page }) => {
  const state = await fixture(page);
  await page.goto(`/repositories/alex/demo/${tail}#route-fragment`);
  await expect(page).toHaveURL(new RegExp(`/alex/demo/${tail}#route-fragment$`));
  await expect(page.getByRole('heading', { name: heading, exact: true })).toBeVisible();
  await expect.poll(() => state.methods.filter(value => value === method).length).toBeGreaterThan(0);
  const reads = state.methods.filter(value => value === method).length;
  expect(state.authorityURLs.every(url => new URL(url).pathname === `/alex/demo/${tail}`)).toBe(true);
  if(tail==='settings/workflows') { expect(state.methods).toContain('GetRepository'); expect(state.methods.indexOf('GetRepository')).toBeLessThan(state.methods.indexOf('InspectWorkflows')); } else if(tail==='settings') { expect(state.methods).toContain('GetRepository'); await expect.poll(()=>state.canonicalBodies.some(value=>value.method==='GetRepositoryLifecycle')).toBe(true); expect(state.canonicalBodies.some(value=>value.method==='GetRepositorySettings')).toBe(true); for(const value of state.canonicalBodies)expect(value.repository).toEqual({owner:'alex',name:'demo'});expect(state.authorityURLs.every(url=>new URL(url).pathname==='/alex/demo/settings')).toBe(true); } else expect(state.methods).not.toContain('GetRepository');
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

for (const width of [320, 1440]) test(`native settings retain the full sidebar and explain unavailable sections at ${width}px`, async ({ page }) => {
  const state = await fixture(page, 'cloudflare-native');
  await page.setViewportSize({width, height:900});
  await page.goto('/alex/demo/settings');
  await expect(page.getByText('PRIVATE route settings', {exact:true})).toBeVisible();
  const nav = page.locator('.repository-settings-layout > .account-navigation');
  const picker = page.getByRole('combobox', {name:'Settings section', exact:true, includeHidden:true});
  const sections = ['General', 'Access', 'Git credentials', 'Rules and merge policy', 'Workflows', 'Runners', 'Secrets and variables', 'Environments', 'Webhooks', 'Audit log', 'Agentic mode', 'Automations'];
  await expect(nav.getByRole('link', {includeHidden:true})).toHaveCount(sections.length);
  await expect(picker.locator('option')).toHaveCount(sections.length);
  for (const section of sections) await expect(nav.getByRole('link', {includeHidden:true}).filter({hasText:section})).toHaveCount(1);
  const sidebar = await page.locator('.repository-settings-layout > .account-navigation').elementHandle();
  const tabs = page.getByRole('navigation', {name:'Repository', exact:true});
  const frame = await tabs.elementHandle();
  const methods = state.methods.length;
  if (width === 320) await picker.selectOption('/$owner/$name/settings/rules');
  else { await nav.getByText('Not on this installation').click(); await nav.getByRole('link').filter({hasText:'Rules and merge policy'}).click(); }
  await expect(page.getByRole('heading', {name:'Rules and merge policy', exact:true})).toBeVisible();
  await expect(page.getByText('Protected merge enforcement is not implemented on Cloudflare native.', {exact:true})).toBeVisible();
  await expect(nav.locator('[aria-current="page"]')).toContainText('Rules and merge policy');
  await expect(tabs.getByRole('link', {name:'Settings', exact:true})).toHaveAttribute('aria-current','page');
  expect(await sidebar!.evaluate(node=>node.isConnected)).toBe(true);
  expect(await frame!.evaluate(node=>node.isConnected)).toBe(true);
  expect(state.methods.slice(methods).filter(method=>!['GetRepository','ListCapabilities','WatchRepository'].includes(method))).toEqual([]);
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  await page.goBack();
  await expect(page.getByText('PRIVATE route settings', {exact:true})).toBeVisible();
});

test('native settings wait for capabilities, retain navigation on failure and recover explicitly', async ({page}) => {
  const state = await fixture(page, 'cloudflare-native');
  let release!: () => void;
  state.capabilitiesBarrier = new Promise<void>(resolve=>{release=resolve;});
  await page.goto('/alex/demo/settings/workflows');
  await expect(page.getByRole('heading', {name:'Checking settings availability…',exact:true})).toBeVisible();
  expect(state.methods).not.toContain('InspectWorkflows');
  await expect(page.getByRole('navigation', {name:'Repository settings',exact:true}).getByRole('link')).toHaveCount(12);
  state.capabilitiesFailed = true; release();
  await expect(page.getByText('Settings availability could not be checked. Retry to load the current installation capabilities.',{exact:true})).toBeVisible();
  expect(state.methods).not.toContain('InspectWorkflows');
  state.capabilitiesFailed = false;
  state.nativeCapabilities.push({id:'settings.repository-workflows',label:'Workflows',state:3,reason:'Available'});
  await page.getByRole('button', {name:'Refresh availability',exact:true}).click();
  await expect(page.getByRole('heading', {name:'Workflow configuration',exact:true})).toBeVisible();
  await expect.poll(() => state.methods).toContain('InspectWorkflows');
});


test('native runner chooser stays open while repository access and placement revalidate', async ({page}) => {
  const state = await fixture(page, 'cloudflare-native');
  state.nativeCapabilities.push({id:'settings.native-runners',label:'Customer-hosted native runners',state:3,reason:'Available'});
  let reads = 0;
  // The placement panel renders only when /native/config reports tests, and the page also reads the repository's runner share.
  await page.route('**/native/config', route => route.fulfill({status:200, contentType:'application/json', json:{tests:true}}));
  await page.route('**/native/capacity/shares/read', route => route.fulfill({status:200, contentType:'application/json', json:{allocated:false, reason:'No runner share is allocated on this installation.', parent:{scope:'installation', name:''}}}));
  await page.route('**/native/runner-placement', route => { reads++; return route.fulfill({status:200, contentType:'application/json', json:{placement:{repository_id:19,pool_id:null,pool_version:null,version:1},pools:[{id:'p1',name:'workstation',version:1,state:'ACTIVE',trust_class:'UNTRUSTED',max_parallel:1,image_id:'sha256:'+'a'.repeat(64)}],canEdit:true}}); });
  await page.goto('/alex/demo/settings/runners');
  await page.getByRole('button', {name:'Change runner',exact:true}).click();
  const chooser = page.getByRole('combobox', {name:'Runner pool'});
  await chooser.selectOption('p1');
  const before = { access: state.methods.filter(method => method === 'GetRepositoryAccess').length, reads };
  await page.evaluate(() => { window.dispatchEvent(new Event('visibilitychange')); window.dispatchEvent(new Event('focus')); });
  await expect.poll(() => state.methods.filter(method => method === 'GetRepositoryAccess').length + reads).toBeGreaterThan(before.access + before.reads);
  await expect(page.getByText('Verifying repository access…')).toHaveCount(0);
  await expect(chooser).toHaveValue('p1');
  await expect(page.getByRole('button', {name:'Save runner',exact:true})).toBeEnabled();
});
test('native runners settings open the workspace pool chooser and account navigation lists only provided pages', async ({page}) => {
  const state = await fixture(page, 'cloudflare-native');
  state.nativeCapabilities.push({id:'settings.native-runners',label:'Customer-hosted native runners',state:3,reason:'Available'});
  await page.route('**/native/runner-placement', route => route.fulfill({status:200, contentType:'application/json', json:{placement:{repository_id:19,pool_id:null,pool_version:null,version:1},pools:[]}}));
  await page.goto('/alex/demo/settings/runners');
  await expect(page.getByRole('heading', {name:'Runners',exact:true})).toBeVisible();
  await expect(page.getByText('Not available on this installation',{exact:true})).toHaveCount(0);
  const nav = page.getByRole('navigation', {name:'Repository settings',exact:true});
  await expect(nav.locator('[aria-current="page"]')).toHaveAttribute('href', '/alex/demo/settings/runners');
  await expect(nav.getByText('Not on this installation')).toContainText('9');
  // The native runtime has no API credential, provider connection, agent account or activity service.
  await page.goto('/account/settings');
  const account = page.getByRole('navigation', {name:'Account settings',exact:true});
  await expect(account.getByRole('link')).toHaveText(['Profile', 'Invitations']);
  const methods = state.methods.length;
  await page.goto('/account/api-credentials');
  await expect(page.getByText('Not available on this installation',{exact:true})).toBeVisible();
  expect(state.methods.slice(methods).filter(method=>!['GetSession','GetAuthenticationOptions','ListCapabilities'].includes(method))).toEqual([]);
});

test('each unavailable native settings route keeps its selected sidebar without probing unsupported APIs', async ({page}) => {
  const state = await fixture(page, 'cloudflare-native');
  for (const suffix of ['git','rules','workflows','runners','secrets','environments','webhooks','agentic-mode','automations']) {
    await page.goto(`/alex/demo/settings/${suffix}`);
    await expect(page.getByText('Not available on this installation',{exact:true})).toBeVisible();
    const nav = page.getByRole('navigation', {name:'Repository settings',exact:true});
    await expect(nav.locator('[aria-current="page"]')).toHaveAttribute('href', `/alex/demo/settings/${suffix}`);
    await expect(nav.getByRole('link')).toHaveCount(12);
  }
  expect(state.methods.filter(method=>!['GetSession','GetAuthenticationOptions','ListCapabilities','GetRepository'].includes(method))).toEqual([]);
});

test('native Actions lists recent repository runs and opens one pull request’s runs on request', async ({page}) => {
  await fixture(page, 'cloudflare-native');
  const pull = (number: number) => ({ id: String(100 + number), number, title: `Proposal ${number}`, body: '', state: 'ISSUE_STATE_OPEN', merged: false, draft: false, revision: 'r' + number, head: { commitId: other, ref: 'feature-' + number }, base: { commitId: snapshot, ref: 'main' } });
  const run = (id: string, number: number, minutes: number, states: object = {}) => ({ id, state: 'SUCCEEDED', agentState: 'NONE', testState: 'PASSED', adviceState: 'NONE', createdAt: new Date(Date.now() - minutes * 60000).toISOString(), updatedAt: new Date().toISOString(), expiresAt: new Date().toISOString(), advisoryOnly: true,
    selection: { repository: { owner: 'alex', name: 'demo' }, repositoryId: repository.id, pullRequestId: String(100 + number), number, baseCommitId: snapshot, headCommitId: other }, ...states });
  const recent = [run('11111111-1111-4111-8111-111111111111', 7, 3), run('22222222-2222-4222-8222-222222222222', 4, 50, { state: 'QUEUED', testState: 'NONE', agentState: 'RUNNING' })];
  const requests: { path: string; action?: string; number?: number; repositoryId?: string }[] = [];
  const pullLists: Record<string, unknown>[] = [];
  await page.route('**/rpc/golf.v1.RepositoryService/ListPullRequests', route => { pullLists.push(route.request().postDataJSON()); return route.fulfill({ json: { pullRequests: [pull(7), pull(4)], page: { nextPage: 2 } } }); });
  await page.route('**/rpc/golf.v1.RepositoryService/GetPullRequest', route => route.fulfill({ json: { pullRequest: pull(route.request().postDataJSON().number) } }));
  await page.route('**/native/**', async route => {
    const path = new URL(route.request().url()).pathname, body = route.request().postDataJSON(); requests.push({ path, action: body.action, number: body.number, repositoryId: body.repositoryId });
    if (path === '/native/config') return route.fulfill({ json: { runtimeProfile: 'cloudflare-native', workspace: 'alex', evidence: true, tests: true, agents: false, advice: false, previews: false, apps: false, automaticCI: true, testModule: 'test_calc', testWorkflowFormat: '', testWorkflowPath: '', dailyLimit: 8 } });
    if (path === '/native/repository-access') return route.fulfill({ json: { role: 'read' } });
    if (path === '/native/pr-evidence/read' && body.action === 'list') return route.fulfill({ json: body.number === undefined ? { jobs: recent, truncated: true } : { jobs: recent.filter(job => job.selection.number === body.number).map(job => ({ ...job, idempotencyKey: job.id, stale: false })), truncated: false } });
    return route.fulfill({ status: 501, json: { code: 'unimplemented', message: 'This capability is not implemented on the native forge.' } });
  });
  await page.goto('/alex/demo/actions');
  const table = page.getByRole('table', { name: 'recent repository runs', exact: true });
  await expect(table.locator('tbody tr[data-row-id]')).toHaveCount(2);
  const first = table.locator('tbody tr[data-row-id="11111111-1111-4111-8111-111111111111"]'), second = table.locator('tbody tr[data-row-id="22222222-2222-4222-8222-222222222222"]');
  await expect(first).toContainText('Tests'); await expect(first).toContainText('PASSED'); await expect(first).toContainText(other.slice(0, 12));
  await expect(second).toContainText('Agent proposal'); await expect(second).toContainText('QUEUED');
  expect(new URL((await first.getByRole('link', { name: '#7', exact: true }).getAttribute('href'))!, page.url()).pathname).toContain('/pull/7');
  await expect(page.getByText('Only the latest 50 runs are loaded; search and sorting apply to those.', { exact: false })).toBeVisible();
  // The pull request page is the newest by number, open and closed, and says so when another page exists.
  await expect(page.getByText('Only the 100 newest pull requests, open and closed, are loaded; search and sorting cover only those.', { exact: false })).toBeVisible();
  expect(pullLists.length).toBeGreaterThan(0); expect(pullLists.every(body => body.state === 'ISSUE_STATE_ALL' && body.sort === 'newest')).toBe(true);
  // The repository-wide rows make no staleness claim; that needs the pull request's own list.
  await expect(table.getByText('Current', { exact: true })).toHaveCount(0); await expect(table.getByText('Stale', { exact: true })).toHaveCount(0);
  const lists = requests.filter(request => request.path === '/native/pr-evidence/read');
  expect(lists.length).toBeGreaterThan(0); expect(lists.every(request => request.action === 'list' && request.number === undefined && request.repositoryId === repository.id)).toBe(true);
  await expect(page.getByRole('table', { name: 'PR runs', exact: true })).toHaveCount(0);
  await first.getByRole('button', { name: 'Inspect runs for pull request 7', exact: true }).click();
  const selected = page.getByRole('table', { name: 'PR runs', exact: true });
  await expect(selected.locator('tbody tr[data-row-id]')).toHaveCount(1); await expect(selected).toContainText('Current');
  expect(requests.some(request => request.path === '/native/pr-evidence/read' && request.number === 7)).toBe(true);
});
