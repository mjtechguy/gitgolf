import { expect, test, type Page } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { GetSessionResponseSchema, ListCapabilitiesResponseSchema } from '../src/gen/golf/v1/golf_pb';
import { featureBackend } from './feature-policy-fixture';
import { respond } from './rpc';

// The /native/audit/read contract served by cloudflare/forge for installation, organization and repository scope.
const ago = (seconds: number) => new Date(Date.now() - seconds * 1000).toISOString();
const agent = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_6) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36';
export const categories = [['installation_policy', 'Installation policy'], ['feature_policy', 'Feature policy'], ['ai_model', 'AI models'], ['installation', 'Admin access'], ['runner_pool', 'Runner pools'], ['runner', 'Runners'],
  ['org', 'Organizations'], ['user', 'Accounts'], ['repo', 'Repositories'], ['repository_invitation', 'Invitations'], ['repository_rule', 'Rules'], ['hook', 'Webhooks'], ['repository_secret', 'Secrets and variables'],
  ['environment', 'Environments'], ['git_credential', 'Git credentials'], ['preview', 'Previews'], ['release', 'Releases'], ['pull_request', 'Pull requests'], ['label', 'Labels and milestones'], ['ai', 'AI runs'], ['actions', 'Actions runs']].map(([id, label]) => ({ id, label }));
const label = (id: string) => categories.find(c => c.id === id)!.label;
const event = (id: string, seconds: number, action: string, category: string, description: string, more: Record<string, unknown> = {}) => ({
  id, at: ago(seconds), action, category, categoryLabel: label(category), description, actor: 'mj', actorEmail: 'mj@example.com', actorKind: 'person', scope: 'installation', scopeId: 'mj', repository: '', organization: '',
  subject: '', before: null, after: null, widening: false, outcome: 'success', code: '', client: { country: 'US', colo: 'IAD', ip: '203.0.113.7', userAgent: agent, requestId: '8c1f2a9e7d3b4c5a-IAD' }, ...more });
export const events = () => [
  event('e7', 7200, 'runner.enroll', 'runner', 'enrolled runner mj-linux-docker in pool mj-workstation', { subject: 'mj-linux-docker', after: { machine: 'mj-linux-docker', pool: 'mj-workstation', protocol: 'native', lifetimeHours: 8 } }),
  event('e6', 7500, 'repo.update_runner_placement', 'repo', 'changed runner placement from no pool to pool mj-workstation', { scope: 'repository', scopeId: '41', repository: 'mj/golf', subject: 'mj/golf', before: { pool: null }, after: { pool: 'mj-workstation' } }),
  event('e5', 9000, 'runner_pool.create', 'runner_pool', 'created runner pool mj-workstation', { subject: 'mj-workstation', after: { name: 'mj-workstation', trust: 'untrusted', maxParallel: 2 } }),
  event('e4', 86_400, 'repo.update_visibility', 'repo', 'made the repository public', { scope: 'repository', scopeId: '41', repository: 'mj/golf', subject: 'mj/golf', before: { public: false }, after: { public: true }, widening: true, client: { country: 'GB', colo: 'LHR' } }),
  event('e3', 90_000, 'repository_secret.create', 'repository_secret', 'created secret DEPLOY_TOKEN', { scope: 'repository', scopeId: '41', repository: 'mj/golf', subject: 'DEPLOY_TOKEN', after: { name: 'DEPLOY_TOKEN', kind: 'secret' } }),
  event('e2', 100_000, 'installation.access_denied', 'installation', 'tried to open the installation administration', { actor: 'writer', actorEmail: 'writer@example.com', outcome: 'denied', code: 'permission_denied', client: { country: 'DE', colo: 'FRA', ip: '198.51.100.20' } }),
  event('e1', 200_000, 'update', 'installation_policy', 'changed installation policy webhooks', { subject: 'webhooks', before: { origins: ['https://hooks.slack.com'], dailyLimit: 300 }, after: { origins: ['https://hooks.slack.com', 'https://webhook.site'], dailyLimit: 300 }, widening: true, client: {} }),
];
const secretLooking = /ghp_|gho_|github_pat_|sk-[A-Za-z0-9]{8}|BEGIN [A-Z ]*PRIVATE KEY|xox[abp]-|AKIA[0-9A-Z]{12}/;

type Body = { scope: string; repository?: { owner: string; name: string }; organization?: string; filters?: Record<string, string>; page: { page: number; limit: number } };
async function auditBackend(page: Page, options: { status?: number; failures?: number } = {}) {
  const state = { bodies: [] as Body[] };
  await featureBackend(page);
  // Registered after the feature fixture, so these answer first and fall back to it for everything else.
  await page.route('**/rpc/**', async route => {
    const method = route.request().url().split('/').at(-1)!;
    if (method === 'GetSession') return respond(route, GetSessionResponseSchema, { user: { id: '17', login: 'mj', fullName: 'MJ', isInstanceAdmin: true } });
    if (method === 'ListCapabilities') return respond(route, ListCapabilitiesResponseSchema, { runtimeProfile: 'cloudflare-native', capabilities: ['settings.repository-general', 'settings.repository-access', 'settings.repository-git', 'settings.repository-rules', 'settings.repository-workflows', 'settings.native-runners', 'settings.repository-secrets', 'settings.repository-environments', 'settings.repository-webhooks', 'settings.installation-audit', 'settings.feature-policy', 'operations.dashboard', 'settings.native']
      .map(id => ({ id, label: id, state: 3, reason: 'Available.' })) });
    return route.fallback();
  });
  await page.route('**/native/audit/read', route => {
    const body = route.request().postDataJSON() as Body; state.bodies.push(body);
    if (options.status) return route.fulfill({ status: options.status, contentType: 'application/json', json: { code: 'permission_denied', message: 'Repository administrator access required.' } });
    let entries = events();
    if (body.scope === 'repository') entries = entries.filter(e => e.repository === `${body.repository!.owner}/${body.repository!.name}`);
    const f = body.filters || {};
    entries = entries.filter(e => (!f.category || e.category === f.category) && (!f.outcome || e.outcome === f.outcome) && (!f.actor || e.actor === f.actor || e.actorEmail === f.actor) && (!f.query || `${e.action} ${e.description} ${e.subject}`.includes(f.query)));
    const scope = body.scope === 'repository' ? { kind: 'repository', id: '41', label: 'mj/golf' } : body.scope === 'organization' ? { kind: 'organization', id: '9', label: body.organization } : { kind: 'installation', id: 'mj', label: 'mj' };
    return route.fulfill({ status: 200, contentType: 'application/json', json: { entries, page: { nextPage: 0 }, categories, recording: { failures: body.scope === 'installation' ? options.failures || 0 : 0, lastFailureAt: options.failures ? ago(1800) : '' }, scope } });
  });
  return state;
}
const overflow = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

test('the installation audit log reads like GitHub: who did what, where, when, from where and whether it worked', async ({ page }) => {
  const state = await auditBackend(page); await page.goto('/admin/audit');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Audit log');
  const table = page.getByRole('table', { name: 'Installation audit log' });
  await expect(table.locator('tbody tr')).toHaveCount(7);
  const enroll = table.locator('tr[data-row-id="e7"]');
  await expect(enroll).toContainText('mj enrolled runner mj-linux-docker in pool mj-workstation');
  await expect(enroll).toContainText('runner.enroll'); await expect(enroll).toContainText('Runners');
  await expect(enroll).toContainText('2 hours ago'); await expect(enroll).toContainText('US · IAD'); await expect(enroll).toContainText('Succeeded');
  const placement = table.locator('tr[data-row-id="e6"]');
  await expect(placement).toContainText('mj changed runner placement from no pool to pool mj-workstation in mj/golf');
  await expect(placement.getByRole('link', { name: 'mj/golf' })).toHaveAttribute('href', '/mj/golf');
  await expect(table.locator('tr[data-row-id="e2"]')).toContainText('writer tried to open the installation administration');
  await expect(table.locator('tr[data-row-id="e2"]')).toContainText('Denied');
  await expect(table.locator('tr[data-row-id="e1"]')).toContainText('Not recorded');
  await expect(page.getByText('Entries cannot be edited or removed through Golf. Newest first.')).toBeVisible();
  await expect(page.getByText('7 loaded', { exact: true })).toBeVisible();
  await expect(page.getByRole('searchbox', { name: 'Search loaded Installation audit log' })).toBeVisible();
  expect(state.bodies[0]).toEqual({ scope: 'installation', page: { page: 1, limit: 50 } });
  await expect(page.getByRole('navigation', { name: 'Instance administration' }).getByRole('link', { name: 'Audit log' })).toHaveAttribute('aria-current', 'page');
});

test('filters run on the server with the exact request body, count as active and clear', async ({ page }) => {
  const state = await auditBackend(page); await page.goto('/admin/audit');
  const form = page.getByRole('form', { name: 'Filter the audit log' });
  await expect(form.getByLabel('Category').locator('option')).toHaveCount(categories.length + 1);
  await expect(form).toContainText('Filters search the whole log');
  await form.getByLabel('Search').fill('enroll'); await form.getByLabel('Category').selectOption('runner'); await form.getByLabel('Actor').fill('mj');
  await form.getByLabel('Repository').fill('mj/golf'); await form.getByLabel('Outcome').selectOption('success');
  await form.getByLabel('From', { exact: true }).fill('2026-10-01'); await form.getByLabel('To', { exact: true }).fill('2026-10-14');
  await form.getByRole('button', { name: 'Apply filters' }).click();
  await expect.poll(() => state.bodies.at(-1)).toEqual({ scope: 'installation', filters: { query: 'enroll', category: 'runner', actor: 'mj', repository: 'mj/golf', outcome: 'success', from: '2026-10-01', to: '2026-10-14' }, page: { page: 1, limit: 50 } });
  await expect(page.getByText('7 active')).toBeVisible();
  await expect(page.getByRole('table', { name: 'Installation audit log' }).locator('tbody tr')).toHaveCount(1);
  await form.getByLabel('Outcome').selectOption('denied'); await form.getByRole('button', { name: 'Apply filters' }).click();
  await expect(page.getByText('No entries match these filters anywhere in the log.')).toBeVisible();
  await form.getByRole('button', { name: 'Clear' }).click();
  await expect.poll(() => state.bodies.at(-1)).toEqual({ scope: 'installation', page: { page: 1, limit: 50 } });
  await expect(page.getByRole('table', { name: 'Installation audit log' }).locator('tbody tr')).toHaveCount(7);
  await form.getByLabel('From', { exact: true }).fill('2026-10-14'); await form.getByLabel('To', { exact: true }).fill('2026-10-01'); await form.getByRole('button', { name: 'Apply filters' }).click();
  await expect(form.getByRole('alert')).toContainText('on or before');
});

test('details show before and after values, the request and never a secret value', async ({ page }) => {
  await auditBackend(page, { failures: 2 }); await page.goto('/admin/audit');
  await expect(page.getByRole('status').filter({ hasText: 'audit records could not be written' })).toContainText('2 audit records could not be written in this Worker instance since it started');
  const table = page.getByRole('table', { name: 'Installation audit log' });
  const visibility = table.locator('tr[data-row-id="e4"]');
  await visibility.getByText('Details').click();
  await expect(visibility).toContainText('public'); await expect(visibility.locator('.audit-before')).toHaveText('false'); await expect(visibility.locator('.audit-after')).toHaveText('true');
  await expect(visibility.locator('.audit-details-body')).toContainText('Widening');
  const secret = table.locator('tr[data-row-id="e3"]');
  await secret.getByText('Details').click();
  await expect(secret).toContainText('DEPLOY_TOKEN'); await expect(secret).toContainText('Recorded values');
  const enroll = table.locator('tr[data-row-id="e7"]'); await enroll.getByText('Details').click();
  for (const text of ['lifetimeHours', '8', 'mj@example.com', 'person', '203.0.113.7', '8c1f2a9e7d3b4c5a-IAD', 'Chrome/129.0']) await expect(enroll.locator('.audit-details-body')).toContainText(text);
  const denied = table.locator('tr[data-row-id="e2"]'); await denied.getByText('Details').click();
  await expect(denied.locator('.audit-details-body')).toContainText('permission_denied');
  expect(await page.locator('main').innerText()).not.toMatch(secretLooking);
});

test('repository settings read the repository scope and list the audit log in the settings navigation', async ({ page }) => {
  const state = await auditBackend(page); await page.goto('/alex/demo/settings');
  const nav = page.getByRole('navigation', { name: 'Repository settings', exact: true });
  await nav.getByRole('link', { name: 'Audit log' }).click();
  await expect(page).toHaveURL(/\/alex\/demo\/settings\/audit$/);
  await expect(page.getByRole('heading', { level: 1, name: 'Audit log' })).toBeVisible();
  await expect(nav.getByRole('link', { name: 'Audit log' })).toHaveAttribute('aria-current', 'page');
  await expect(page.getByRole('table', { name: 'Repository audit log' })).toBeVisible();
  expect(state.bodies.at(-1)).toEqual({ scope: 'repository', repository: { owner: 'alex', name: 'demo' }, page: { page: 1, limit: 50 } });
  await expect(page.getByRole('form', { name: 'Filter the audit log' }).getByLabel('Repository')).toHaveCount(0);
  await expect(page.getByText('Nothing has been recorded for this repository yet.')).toBeVisible();
});

test('repository rows omit the repository already named by the page', async ({ page }) => {
  await auditBackend(page); await page.goto('/mj/golf/settings/audit');
  const row = page.getByRole('table', { name: 'Repository audit log' }).locator('tr[data-row-id="e4"]');
  await expect(row).toContainText('mj made the repository public'); await expect(row).not.toContainText('in mj/golf');
});

test('organization settings read the organization scope', async ({ page }) => {
  const state = await auditBackend(page); await page.goto('/organizations/acme/settings/audit');
  await expect(page.getByRole('heading', { level: 1, name: 'Audit log' })).toBeVisible();
  await expect(page.getByRole('navigation', { name: 'Organization settings' }).getByRole('link', { name: 'Audit log' })).toHaveAttribute('aria-current', 'page');
  await expect(page.getByRole('table', { name: 'Organization audit log' })).toBeVisible();
  await expect(page.getByRole('navigation', { name: 'Breadcrumb' })).toContainText('acme');
  await expect(page.getByRole('navigation', { name: 'Breadcrumb' })).toContainText('Audit log');
  expect(state.bodies.at(-1)).toEqual({ scope: 'organization', organization: 'acme', page: { page: 1, limit: 50 } });
  await expect(page.getByRole('table', { name: 'Organization audit log' }).locator('tr[data-row-id="e6"]')).toContainText('in mj/golf');
});

test('a reader without rights sees why and no entries', async ({ page }) => {
  await auditBackend(page, { status: 403 }); await page.goto('/alex/demo/settings/audit');
  await expect(page.getByRole('alert')).toContainText('Only administrators of this repository can read its audit log.');
  await expect(page.getByRole('table', { name: 'Repository audit log' })).toHaveCount(0);
});

test('nothing scrolls sideways at 390 pixels, with details open', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await auditBackend(page); await page.goto('/admin/audit');
  const row = page.getByRole('table', { name: 'Installation audit log' }).locator('tr[data-row-id="e7"]');
  await row.getByText('Details').click(); await expect(row.locator('.audit-details-body')).toBeVisible();
  expect(await overflow(page)).toBeLessThanOrEqual(0);
  await page.goto('/mj/golf/settings/audit'); await expect(page.getByRole('table', { name: 'Repository audit log' })).toBeVisible();
  expect(await overflow(page)).toBeLessThanOrEqual(0);
});

// GOLF_AUDIT_SHOTS=/tmp/golf-ui-review/audit-shots writes full-page review screenshots in each appearance; skipped otherwise.
const directory = process.env.GOLF_AUDIT_SHOTS;
const looks = [['flare', 'console', 'dark'], ['classic', 'primer', 'light'], ['golf', 'tiles', 'dark']] as const;
for (const [appearance, layout, theme] of looks) for (const [width, height] of [[1440, 900], [390, 844]] as const) test(`audit log review screenshots: ${appearance} ${layout} ${theme} ${width}`, async ({ page }) => {
  test.skip(!directory, 'Set GOLF_AUDIT_SHOTS to a directory to write review screenshots.');
  await mkdir(directory!, { recursive: true });
  await page.setViewportSize({ width, height });
  await page.addInitScript(([a, l, t]: [string, string, string]) => { localStorage.setItem('golf.appearance', a); localStorage.setItem('golf.layout.' + a, l); localStorage.setItem('golf.theme', t); }, [appearance, layout, theme] as [string, string, string]);
  await auditBackend(page, { failures: 1 });
  const shot = async (view: string) => {
    await page.evaluate(() => { (document.activeElement as HTMLElement | null)?.blur(); window.scrollTo(0, 0); });
    expect(await overflow(page), `${view} overflows horizontally`).toBeLessThanOrEqual(0);
    await page.screenshot({ path: `${directory}/${view}-${appearance}-${layout}-${theme}-${width}.png`, fullPage: true, animations: 'disabled' });
  };
  await page.goto('/admin/audit'); await expect(page.getByRole('table', { name: 'Installation audit log' }).locator('tbody tr')).toHaveCount(7);
  await shot('admin-audit');
  const form = page.getByRole('form', { name: 'Filter the audit log' });
  await form.getByLabel('Category').selectOption('repo'); await form.getByLabel('Outcome').selectOption('success'); await form.getByLabel('From', { exact: true }).fill('2026-10-01');
  await form.getByRole('button', { name: 'Apply filters' }).click(); await expect(page.getByText('3 active')).toBeVisible();
  await shot('admin-audit-filtered');
  await form.getByRole('button', { name: 'Clear' }).click(); await expect(page.getByRole('table', { name: 'Installation audit log' }).locator('tbody tr')).toHaveCount(7);
  const row = page.getByRole('table', { name: 'Installation audit log' }).locator('tr[data-row-id="e6"]');
  await row.getByText('Details').click(); await expect(row.locator('.audit-details-body')).toBeVisible();
  await shot('admin-audit-details');
  await page.goto('/mj/golf/settings/audit'); await expect(page.getByRole('table', { name: 'Repository audit log' }).locator('tbody tr')).toHaveCount(3);
  await shot('repository-audit');
  await page.goto('/organizations/acme/settings/audit'); await expect(page.getByRole('table', { name: 'Organization audit log' }).locator('tbody tr')).toHaveCount(7);
  await shot('organization-audit');
});
