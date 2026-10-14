import { expect, test, type Page } from '@playwright/test';
import { GetSessionResponseSchema } from '../src/gen/golf/v1/golf_pb';
import { reject, respond } from './rpc';
import { fixture } from './layout-fixture';

// The suite's saved layout is cleared so defaults and each layout's own choice are what is under test.
test.use({ storageState: { cookies: [], origins: [] } });

const presets = { classic: ['primer', 'workbench', 'reader'], golf: ['refined', 'strokes', 'tiles'], flare: ['kumo', 'overview', 'console'] } as const;
const parts: Record<string, [string, string, string]> = {
  primer: ['top', 'standard', 'crumb headertabs finder create counts'], workbench: ['top', 'panes', 'tree'], reader: ['top', 'standard', 'reader'], refined: ['top', 'standard', ''], strokes: ['top', 'standard', 'keys band'],
  tiles: ['rail', 'panes', 'contextnav split toptools counts'], kumo: ['sidebar', 'standard', 'contextnav'], overview: ['sidebar', 'standard', 'band'], console: ['rail', 'standard', 'crumb pagehead finder counts'],
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
    await expect(page.getByRole('navigation', { name: 'Repository filters', exact: true })).toHaveCount(content === 'panes' ? 1 : 0);
    await page.screenshot({ path: `test-results/layout-${appearance}-${layout}-home.png` });

    await page.goto('/alex/demo');
    const sections = page.getByRole('navigation', { name: 'Repository', exact: true });
    await expect(sections.getByRole('link', { name: 'Code', exact: true })).toHaveAttribute('aria-current', 'page');
    await expect(page.getByRole('region', { name: 'Repository README' })).toContainText('A repository for arranging layouts.');
    // Rail and sidebar layouts lift the heading into the top bar; side-navigation layouts also lift the sections.
    const crumb = features.includes('crumb');
    await expect(page.locator('.topbar .repository-context')).toHaveCount(nav === 'top' || crumb ? 0 : 1);
    await expect(page.locator('.topbar').getByRole('navigation', { name: 'Repository path', exact: true })).toHaveCount(crumb ? 1 : 0);
    await expect(page.locator('.topbar').getByRole('navigation', { name: 'Repository', exact: true })).toHaveCount(features.includes('headertabs') ? 1 : 0);
    await expect(page.locator('.repository-code-toolbar').getByRole('button', { name: /Go to file/ })).toHaveCount(features.includes('finder') ? 1 : 0);
    await expect(page.locator('.topbar .branch-picker')).toHaveCount(features.includes('toptools') ? 1 : 0);
    await expect(page.locator('.topbar').getByRole('button', { name: 'Jump to a repository', exact: true })).toBeVisible();
    await expect(page.getByRole('complementary', { name: 'Workspace shortcuts' }).getByRole('navigation', { name: 'Repository', exact: true })).toHaveCount(features.includes('contextnav') ? 1 : 0);
    await expect(page.locator('h1.repository-context')).toHaveCount(1);
    await expect(page.getByLabel('Repository summary')).toHaveCount(features.includes('band') ? 1 : 0);
    await expect(page.locator('.source-navigator')).toHaveCount(features.includes('tree') ? 1 : 0);
    // Rows show their latest change unless the reader turned that off.
    if (!features.includes('reader')) await expect(page.getByLabel('Latest change for LICENSE', { exact: true })).toContainText('Arrange the panes');
    if (features.includes('reader') || features.includes('split')) expect((await box(page, '[aria-label="Repository README"]')).x).toBeGreaterThan((await box(page, '.source-tree')).x + 200);
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

test('the three designs keep their drawn structure on a repository', async ({ page }) => {
  await fixture(page, true);
  await page.setViewportSize({ width: 1440, height: 900 });
  const open = async (appearance: string, layout: string) => {
    await page.goto('/alex/demo');
    await page.evaluate(([a, l]) => { localStorage.setItem('golf.appearance', a!); localStorage.setItem(`golf.layout.${a}`, l!); localStorage.setItem('golf.theme', 'light'); }, [appearance, layout]);
    await page.reload();
    await expect(root(page)).toHaveAttribute('data-layout', layout);
    await expect(page.getByRole('region', { name: 'Repository README' })).toContainText('FastAPI framework');
    // Open-item counts come from one bounded read per tab.
    const sections = page.getByRole('navigation', { name: 'Repository', exact: true });
    await expect(sections.getByRole('link', { name: /^Issues/ })).toContainText('12');
    await expect(sections.getByRole('link', { name: /^Pull requests/ })).toContainText('3');
    await expect(page.getByLabel('Latest change for docs', { exact: true })).toContainText('Update German translations');
    expect(await fits(page)).toBe(true);
    await page.screenshot({ path: `test-results/design-${layout}-repository.png` });
  };

  // Primer: mark, breadcrumb and jump field above the tabs in one header band; a titled page below.
  await open('classic', 'primer');
  const band = await box(page, '.topbar'), tabs = await box(page, '.topbar .repository-tabs'), path = await box(page, '.context-crumb');
  expect(tabs.y).toBeGreaterThan(path.y + 20); expect(tabs.y + tabs.height).toBeLessThanOrEqual(band.y + band.height + 1);
  await expect(page.locator('#main-content h1.repository-context')).toBeVisible(); await expect(page.locator('#main-content h1.repository-context > span').first()).toBeHidden();
  await expect(page.locator('.topbar').getByRole('button', { name: 'New repository', exact: true })).toBeVisible();

  // Tiles: one top line, then Files, README and About side by side with shared tops.
  await open('golf', 'tiles');
  const files = await box(page, '.source-tree'), readme = await box(page, '[aria-label="Repository README"]'), about = await box(page, '.repository-sidebar'), line = await box(page, '.topbar');
  expect(files.x).toBeLessThan(readme.x); expect(readme.x).toBeLessThan(about.x);
  expect(Math.abs(readme.y - (line.y + line.height))).toBeLessThan(2); expect(Math.abs(about.y - readme.y)).toBeLessThan(2);
  expect(about.x + about.width).toBeGreaterThan(1438);
  await expect(page.locator('.topbar').getByRole('link', { name: 'Repositories', exact: true })).toBeVisible();
  const rail = page.getByRole('complementary', { name: 'Workspace shortcuts' });
  await expect(rail.getByRole('link', { name: 'Code', exact: true })).toBeVisible();
  await expect(rail.getByRole('link', { name: 'Organizations', exact: true })).toBeHidden();
  await expect(rail.getByRole('link', { name: 'Notifications', exact: true })).toBeVisible();

  // Console: switchers in the top bar, plain tabs under it, then the repository's name and description.
  await open('flare', 'console');
  const crumb = page.locator('.topbar').getByRole('navigation', { name: 'Repository path', exact: true });
  await expect(crumb).toContainText('Public'); await expect(crumb.getByRole('link', { name: 'main' })).toBeVisible();
  const heading = await box(page, '#main-content h1.repository-context'), sections = await box(page, '#main-content .repository-tabs');
  expect(sections.y).toBeLessThan(heading.y);
  await expect(page.locator('#main-content h1.repository-context')).toBeVisible(); await expect(page.locator('#main-content h1.repository-context > span').first()).toBeHidden();
  await expect(page.locator('.repository-identity-description')).toContainText('FastAPI framework');
  // Away from the root the title row's controls join the breadcrumb, with one visibility badge.
  await page.getByRole('navigation', { name: 'Repository', exact: true }).getByRole('link', { name: /^Issues/ }).click();
  await expect(page).toHaveURL(/\/alex\/demo\/issues/);
  await expect(crumb.locator('.visibility:visible')).toHaveCount(1);
  await crumb.getByRole('button', { name: 'Switch repository', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Jump to a repository' })).toBeVisible();
});

for (const [appearance, layout] of [['classic', 'primer'], ['golf', 'tiles'], ['flare', 'console']] as const) test(`${layout} fits phone and tablet widths after a desktop start`, async ({ page }) => {
  await fixture(page, true); await choose(page, appearance, layout);
  for (const route of ['/alex/demo', '/alex/demo/issues', '/', '/account/settings']) {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(route);
    await expect(page.getByRole('button', { name: 'Jump to a repository', exact: true })).toBeVisible();
    for (const width of [390, 900]) {
      await page.setViewportSize({ width, height: 844 });
      await expect.poll(() => fits(page), { message: `${route} at ${width}px` }).toBe(true);
    }
  }
});

test('the jump field finds a loaded repository from the keyboard', async ({ page }) => {
  await fixture(page, true);
  await page.goto('/alex/demo');
  await expect(page.locator('.source-tree')).toBeVisible();
  await page.keyboard.press('Control+k');
  const dialog = page.getByRole('dialog', { name: 'Jump to a repository' });
  await dialog.getByLabel('Find a repository by name').fill('tiny');
  await expect(dialog.getByRole('list', { name: 'Matching repositories' }).getByRole('link')).toHaveText(['alex/tiny-tools']);
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/\/alex\/tiny-tools$/);
  await expect(dialog).toHaveCount(0);
});

test('other pages take the layout and sign-in follows the appearance', async ({ page }) => {
  await fixture(page, true); await choose(page, 'golf', 'tiles');
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/');
  const filters = page.getByRole('navigation', { name: 'Repository filters', exact: true });
  await expect(filters.getByRole('button', { name: /^Private/ })).toContainText('3');
  await filters.getByRole('button', { name: /^Public/ }).click();
  await expect(page.locator('.repository-row')).toHaveCount(2);
  await expect(page.getByLabel('Repository visibility', { exact: true })).toHaveValue('public');
  expect((await box(page, '.repository-filters')).x).toBeLessThan((await box(page, '.repository-list')).x);
  await page.goto('/account/settings');
  const navigation = await box(page, '.account-navigation'), railEdge = await box(page, '.appearance-sidebar');
  expect(Math.abs(navigation.x - (railEdge.x + railEdge.width))).toBeLessThan(2);
  expect(await fits(page)).toBe(true);
});

test('Classic and Flare sign in from a centered card; Golf keeps its statement', async ({ page }) => {
  await page.route('**/rpc/**', route => route.request().url().endsWith('/GetAuthenticationOptions') ? route.fulfill({ status: 200, contentType: 'application/json', json: { localPasswordEnabled: true } }) : reject(route, 'unauthenticated', 'Signed out.'));
  await page.setViewportSize({ width: 1440, height: 900 });
  for (const appearance of ['classic', 'golf', 'flare']) {
    await page.goto('/');
    await page.evaluate(value => localStorage.setItem('golf.appearance', value), appearance);
    await page.reload();
    const card = await box(page, '.login-card');
    await expect(page.locator('.login-story')).toBeVisible({ visible: appearance === 'golf' });
    if (appearance !== 'golf') expect(Math.abs(card.x + card.width / 2 - 720)).toBeLessThan(2);
    await page.screenshot({ path: `test-results/design-signin-${appearance}.png` });
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
