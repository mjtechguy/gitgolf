import { portableRuntimeFixture } from './runtime-fixture';
import { expect, test, type Page } from '@playwright/test';
import {
  GetAuthenticationOptionsResponseSchema, GetContentsRequestSchema, GetContentsResponseSchema, GetRepositoryOverviewResponseSchema,
  GetRepositoryResponseSchema, GetSessionResponseSchema, ListBranchesResponseSchema, ListCapabilitiesResponseSchema, ListCommitsRequestSchema,
  ListCommitsResponseSchema, ListRepositoriesResponseSchema, RepositoryOverviewSectionState as State, SourceEntryType,
} from '../src/gen/golf/v1/golf_pb';
import { reject, request, respond, resolveSourceFixture } from './rpc';

const head = 'a'.repeat(40), blob = 'b'.repeat(40), repositoryId = '41';
const repository = { id: repositoryId, name: 'demo', fullName: 'alex/demo', defaultBranch: 'main', private: true, issuesEnabled: true, pullRequestsEnabled: true,
  description: 'A layout fixture.', cloneUrl: 'https://forge.example/alex/demo.git', updatedAt: '2026-10-01T12:00:00Z' };
const entry = (name: string, type = SourceEntryType.FILE) => ({ name, path: name, sha: blob, type });
async function fixture(page: Page) {
  await page.route('**/rpc/**', async route => {
    const method = route.request().url().split('/').at(-1)!;
    if (method === 'GetSession') return respond(route, GetSessionResponseSchema, { user: { id: '17', login: 'alex' } });
    if (method === 'GetAuthenticationOptions') return respond(route, GetAuthenticationOptionsResponseSchema, { localPasswordEnabled: true });
    if (method === 'ListCapabilities') return respond(route, ListCapabilitiesResponseSchema, portableRuntimeFixture);
    if (method === 'ListRepositories') return respond(route, ListRepositoriesResponseSchema, { repositories: [repository, { ...repository, id: '42', name: 'tools', fullName: 'alex/tools', private: false }] });
    if (method === 'GetRepository') return respond(route, GetRepositoryResponseSchema, { repository });
    if (method === 'GetRepositoryOverview') return respond(route, GetRepositoryOverviewResponseSchema, { repositoryId, repository: { owner: 'alex', name: 'demo' }, description: 'A layout fixture.', topics: ['layouts'], licenseIds: ['MIT'], starsCount: '0', watchersCount: '1', forksCount: '0', languages: [{ name: 'TypeScript', byteCount: '750' }, { name: 'Go', byteCount: '250' }], languagesState: State.AVAILABLE, licensesState: State.AVAILABLE });
    if (method === 'ListBranches') return respond(route, ListBranchesResponseSchema, { repositoryId, branches: [{ name: 'main', commitId: head }] });
    if (method === 'ResolveRepositorySource') return resolveSourceFixture(route, repositoryId, { owner: 'alex', name: 'demo' }, 'main', { main: head });
    if (method === 'ListCommits') { const input = request(route, ListCommitsRequestSchema); return respond(route, ListCommitsResponseSchema, { repositoryId, commitId: head, path: input.path, commits: [{ sha: head, message: 'Arrange the panes', authorName: 'Alex', authoredAt: '2026-10-01T12:00:00Z' }] }); }
    if (method === 'GetContents') {
      const input = request(route, GetContentsRequestSchema);
      if (!input.path || input.path === 'src') return respond(route, GetContentsResponseSchema, { repositoryId, commitId: head, path: input.path, kind: SourceEntryType.DIRECTORY,
        entries: input.path ? [{ ...entry('index.ts'), path: 'src/index.ts' }] : [entry('src', SourceEntryType.DIRECTORY), entry('LICENSE'), entry('README.md'), entry('package.json')] });
      return respond(route, GetContentsResponseSchema, { repositoryId, commitId: head, path: input.path, kind: SourceEntryType.FILE,
        file: { entry: { ...entry(input.path.split('/').at(-1)!), path: input.path }, content: input.path === 'README.md' ? '# Demo\n\nA repository for arranging layouts.\n\n## Use\n\nOpen the code tab.' : 'export const value = true;' } });
    }
    return reject(route, 'unimplemented', 'Fixture procedure unavailable.');
  });
}
const presets = { classic: ['primer', 'workbench', 'reader'], golf: ['refined', 'strokes', 'tiles'], flare: ['kumo', 'overview', 'console'] } as const;
const parts: Record<string, [string, string, string]> = {
  primer: ['top', 'standard', ''], workbench: ['top', 'panes', ''], reader: ['top', 'standard', 'reader'], refined: ['top', 'standard', ''], strokes: ['top', 'standard', 'keys band'],
  tiles: ['rail', 'panes', 'contextnav'], kumo: ['sidebar', 'standard', 'contextnav'], overview: ['sidebar', 'standard', 'band'], console: ['rail', 'standard', ''],
};
async function choose(page: Page, appearance: string, layout: string, theme = 'light') {
  await page.addInitScript(([a, l, t]) => { localStorage.setItem('golf.appearance', a!); localStorage.setItem(`golf.layout.${a}`, l!); localStorage.setItem('golf.theme', t!); }, [appearance, layout, theme]);
}
const fits = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth);
const root = (page: Page) => page.locator('html');
const box = async (page: Page, selector: string) => (await page.locator(selector).first().boundingBox())!;

for (const [appearance, layouts] of Object.entries(presets)) for (const layout of layouts) {
  test(`${appearance} ${layout} lays out the repository list and a repository at desktop and phone widths`, async ({ page }) => {
    await fixture(page); await choose(page, appearance, layout);
    const [nav, content, features] = parts[layout]!;
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/');
    await expect(root(page)).toHaveAttribute('data-layout', layout);
    await expect(root(page)).toHaveAttribute('data-nav', nav);
    await expect(root(page)).toHaveAttribute('data-content', content);
    await expect(root(page)).toHaveAttribute('data-features', features);
    await expect(page.getByRole('link', { name: 'alex/demo', exact: true })).toBeVisible();
    await expect(page.getByRole('complementary', { name: 'Workspace shortcuts' })).toBeVisible({ visible: nav !== 'top' });
    if (features.includes('band')) await expect(page.getByLabel('Loaded repositories summary')).toContainText('Loaded repositories2');
    else await expect(page.getByLabel('Loaded repositories summary')).toHaveCount(0);
    expect(await fits(page)).toBe(true);
    await page.screenshot({ path: `test-results/layout-${appearance}-${layout}-home.png` });

    await page.goto('/alex/demo');
    const sections = page.getByRole('navigation', { name: 'Repository', exact: true });
    await expect(sections.getByRole('link', { name: 'Code', exact: true })).toHaveAttribute('aria-current', 'page');
    await expect(page.getByRole('region', { name: 'Repository README' })).toContainText('A repository for arranging layouts.');
    // Rail and sidebar layouts lift the heading into the top bar; side-navigation layouts also lift the sections.
    await expect(page.locator('.topbar .repository-context')).toHaveCount(nav === 'top' ? 0 : 1);
    await expect(page.getByRole('complementary', { name: 'Workspace shortcuts' }).getByRole('navigation', { name: 'Repository', exact: true })).toHaveCount(features.includes('contextnav') ? 1 : 0);
    await expect(page.locator('h1.repository-context')).toHaveCount(1);
    await expect(page.getByLabel('Repository summary')).toHaveCount(features.includes('band') ? 1 : 0);
    await expect(page.locator('.source-navigator')).toHaveCount(content === 'panes' ? 1 : 0);
    if (features.includes('reader')) expect((await box(page, '[aria-label="Repository README"]')).x).toBeGreaterThan((await box(page, '.source-tree')).x + 200);
    else expect((await box(page, '[aria-label="Repository README"]')).y).toBeGreaterThan((await box(page, '.source-tree')).y);
    expect(await fits(page)).toBe(true);
    await page.screenshot({ path: `test-results/layout-${appearance}-${layout}-repository.png` });

    // Phones share one shell: sections return to the page and nothing overflows.
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.getByRole('complementary', { name: 'Workspace shortcuts' })).toBeHidden();
    await expect(page.locator('#main-content').getByRole('navigation', { name: 'Repository', exact: true })).toBeVisible();
    await expect(page.locator('#main-content .repository-context')).toBeVisible();
    await expect(page.locator('.source-navigator')).toHaveCount(0);
    expect(await fits(page)).toBe(true);
    await page.screenshot({ path: `test-results/layout-${appearance}-${layout}-phone.png` });
  });
}

test('each appearance offers three layouts and remembers its own choice', async ({ page }) => {
  await fixture(page);
  await page.goto('/account/settings');
  const appearance = page.getByRole('group', { name: 'Appearance', exact: true }), layout = page.getByRole('group', { name: 'Layout', exact: true });
  await expect(root(page)).toHaveAttribute('data-appearance', 'golf');
  await expect(root(page)).toHaveAttribute('data-layout', 'tiles');
  await expect(layout.getByRole('button')).toHaveText([/Refined/, /Fewer strokes/, /Tiles/]);
  await expect(layout.getByRole('button', { name: 'Tiles layout' })).toHaveAttribute('aria-pressed', 'true');
  await page.locator('#appearance').screenshot({ path: 'test-results/layout-picker.png' });
  await layout.getByRole('button', { name: 'Fewer strokes layout' }).click();
  await expect(root(page)).toHaveAttribute('data-features', 'keys band');
  await appearance.getByRole('button', { name: 'Classic appearance' }).click();
  await expect(layout.getByRole('button')).toHaveText([/Primer/, /Workbench/, /Reader/]);
  await expect(root(page)).toHaveAttribute('data-layout', 'primer');
  await layout.getByRole('button', { name: 'Reader layout' }).click();
  await appearance.getByRole('button', { name: 'Flare appearance' }).click();
  await expect(root(page)).toHaveAttribute('data-layout', 'console');
  await appearance.getByRole('button', { name: 'Golf appearance' }).click();
  await expect(root(page)).toHaveAttribute('data-layout', 'strokes');
  await page.reload();
  await expect(root(page)).toHaveAttribute('data-layout', 'strokes');
  expect(await page.evaluate(() => [localStorage.getItem('golf.layout.golf'), localStorage.getItem('golf.layout.classic'), localStorage.getItem('golf.layout.flare')])).toEqual(['strokes', 'reader', null]);
  await page.evaluate(() => localStorage.setItem('golf.layout.golf', 'console'));
  await page.reload();
  await expect(root(page)).toHaveAttribute('data-layout', 'tiles');
});

test('operators set the first-visit appearance and layout; a saved choice still wins', async ({ page }) => {
  await fixture(page);
  const serve = (value: string) => page.route('**/', async route => { const response = await route.fetch(); await route.fulfill({ response, body: (await response.text()).replace('<html', `<html data-golf-default-appearance="${value}"`) }); });
  await serve('classic/workbench');
  await page.goto('/');
  await expect(root(page)).toHaveAttribute('data-appearance', 'classic');
  await expect(root(page)).toHaveAttribute('data-layout', 'workbench');
  await page.evaluate(() => localStorage.setItem('golf.appearance', 'flare'));
  await page.reload();
  await expect(root(page)).toHaveAttribute('data-layout', 'console');
  await page.evaluate(() => localStorage.clear());
  await page.unroute('**/'); await serve('lava/tiles');
  await page.reload();
  await expect(root(page)).toHaveAttribute('data-appearance', 'golf');
  await expect(root(page)).toHaveAttribute('data-layout', 'tiles');
});

test('signed-out pages keep the top bar and one frame in every appearance', async ({ page }) => {
  await page.route('**/rpc/**', route => route.request().url().endsWith('/GetSession') ? respond(route, GetSessionResponseSchema, {}) : reject(route, 'unimplemented', 'Fixture procedure unavailable.'));
  await page.route('**/', async route => { const response = await route.fetch(); await route.fulfill({ response, body: (await response.text()).replace('<html', '<html data-golf-public="true"') }); });
  for (const appearance of ['classic', 'golf', 'flare']) for (const width of [1600, 390]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto('/');
    await page.evaluate(value => localStorage.setItem('golf.appearance', value), appearance);
    await page.reload();
    await expect(root(page)).toHaveAttribute('data-appearance', appearance);
    await expect(page.getByRole('link', { name: 'Sign in', exact: true })).toBeVisible();
    await expect(page.locator('.topbar').getByRole('link', { name: 'Golf home', exact: true })).toBeVisible();
    await expect(page.getByRole('complementary', { name: 'Workspace shortcuts' })).toHaveCount(0);
    const brand = await box(page, '.topbar .brand'), main = await box(page, '#main-content'), signIn = await box(page, '.topbar .button');
    const padding = await page.locator('#main-content').evaluate(element => parseFloat(getComputedStyle(element).paddingLeft));
    if (width > 720) { expect(Math.abs(brand.x - (main.x + padding))).toBeLessThan(1); expect(signIn.height).toBeLessThanOrEqual(36); }
    expect(await fits(page)).toBe(true);
    await page.screenshot({ path: `test-results/layout-signed-out-${appearance}-${width}.png` });
  }
});

test('Cloudflare-native entry starts on Flare Console', async ({ page }) => {
  await page.goto('/native.html');
  await expect(root(page)).toHaveAttribute('data-appearance', 'flare');
  await expect(root(page)).toHaveAttribute('data-layout', 'console');
  await expect(root(page)).toHaveAttribute('data-nav', 'rail');
});

test('Fewer strokes follows section shortcuts, moves through rows and lists its keys', async ({ page }) => {
  await fixture(page); await choose(page, 'golf', 'strokes', 'dark');
  await page.goto('/alex/demo');
  await expect(page.getByRole('contentinfo', { name: 'Keyboard shortcuts' })).toContainText('all shortcuts');
  await expect(page.getByRole('region', { name: 'Repository README' })).toBeVisible();
  // Access revalidation briefly makes repository content inert, which drops focus; the sequence restarts from a clean state.
  const focused = () => page.evaluate(() => document.activeElement?.getAttribute('title'));
  await expect(async () => {
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await page.keyboard.press('j'); await page.keyboard.press('j');
    expect(await focused()).toBe('LICENSE');
    await page.keyboard.press('k');
    expect(await focused()).toBe('src');
  }).toPass();
  await page.keyboard.press('?');
  const dialog = page.getByRole('dialog', { name: 'Keyboard shortcuts' });
  await expect(dialog).toContainText('Commits');
  // Shortcuts pause while a dialog is open.
  await page.keyboard.press('g'); await page.keyboard.press('m');
  await expect(page).toHaveURL(/\/alex\/demo$/);
  await dialog.getByRole('button', { name: 'Close' }).click();
  await page.keyboard.press('g'); await page.keyboard.press('m');
  await expect(page).toHaveURL(/\/alex\/demo\/commits/);
  await page.keyboard.press('g'); await page.keyboard.press('r');
  await expect(page).toHaveURL(/\/$/);
  await page.getByLabel('Search loaded repositories').focus();
  await page.keyboard.type('gm');
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByLabel('Search loaded repositories')).toHaveValue('gm');
});

test('shortcuts stay off outside the Fewer strokes layout', async ({ page }) => {
  await fixture(page); await choose(page, 'golf', 'refined');
  await page.goto('/alex/demo');
  await expect(page.locator('.source-tree')).toBeVisible();
  await page.keyboard.press('g'); await page.keyboard.press('m');
  await expect(page).toHaveURL(/\/alex\/demo$/);
  await expect(page.getByRole('contentinfo', { name: 'Keyboard shortcuts' })).toHaveCount(0);
});
