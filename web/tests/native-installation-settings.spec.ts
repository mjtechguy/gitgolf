import { test, expect, type Page } from '@playwright/test';
import { respond, reject } from './rpc';
import { GetOperationsDashboardResponseSchema, GetProfileResponseSchema, GetSessionResponseSchema, ListCapabilitiesResponseSchema, ListRepositoriesResponseSchema } from '../src/gen/golf/v1/golf_pb';

// Mirrors what cloudflare/forge/src/installation.mjs and operations.mjs return for an operations administrator on a hosted installation.
const origin = 'https://demo.gitgolf.example.com', stamp = new Date(Date.now() - 90_000).toISOString();
const value = (label: string, text: string, usage?: string) => ({ label, value: text, ...(usage ? { usage } : {}) });
const item = (id: string, label: string, service: string, state: string, values: object[], settingsKey: string, alchemy: string, reason: string, capability = '') => ({ id, label, service, state, capability, values, change: { settingsKey, alchemy }, reason });
export const overview = () => ({ generatedAt: stamp, release: 'b7c41e9a0d2f5c6e8a1b3d4f5e6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a', configuration: '9f8e7d6c5b4a39281706f5e4d3c2b1a0', schema: 29, workspace: 'mj', publicOrigin: origin, demoStopAt: '2026-11-30T00:00:00.000Z',
  groups: [
    { id: 'installation', label: 'Installation and sign-in', items: [
      item('workspace', 'Workspace', 'Workers and Durable Objects', 'configured', [value('Workspace', 'mj'), value('Public origin', origin), value('Cloudflare account', '0123456789abcdef0123456789abcdef'), value('Artifacts namespace', 'golf-demo')], 'origin, workspace', 'prepare', 'Fixed when the installation is provisioned.'),
      item('access', 'Cloudflare Access sign-in', 'Access / Zero Trust', 'configured', [value('Team domain', 'https://golf-demo.cloudflareaccess.com'), value('Application audience', 'Configured (not shown)')], 'access_team_domain, access_aud', 'prepare', 'People sign in through Access; the audience tag is a credential check and is never displayed.'),
      item('public', 'Public repositories', 'Workers', 'configured', [value('Anonymous browsing and cloning', 'Allowed for repositories an administrator publishes'), value('First-visit appearance', 'flare/console')], 'public_repositories, default_appearance', 'enable-public', 'Publishing needs a repository administrator; collaboration and execution keep repository grants.', 'repository.public-source'),
      item('rate-limit', 'Anonymous rate limit', 'Workers rate limiting', 'configured', [value('Limit', 'About 120 requests per 60 seconds per client network and location')], 'anonymous_rate_limit', 'enable-rate-limit', 'Counts are approximate and per Cloudflare location; signed-in, credentialed and runner requests are never counted.'),
    ] },
    { id: 'automation', label: 'Automation', items: [
      item('evidence', 'Pull-request evidence', 'Queues, Workflows and R2', 'configured', [value('Queue', 'golf-demo-evidence'), value('Workflow', 'golf-demo-evidence-workflow'), value('Failure queue', 'golf-demo-evidence-failures'), value('Daily admissions', '50', '7 of 50 used today')], 'evidence', 'prepare', 'Every test, agent and advice run is admitted here; private reports go to R2.', 'native-pr-evidence'),
      item('tests', 'Container tests', 'Containers', 'configured', [value('Approved source', 'actions workflow .github/workflows/ci.yml'), value('Image', 'registry.cloudflare.com/0123456789abcdef/golf-runner@sha256:5d41402abc4b2a76b9719d911017c592ae2f3c1d9e8b7a6c5d4e3f2a1b0c9d8e'), value('Automatic push tests', 'Yes')], 'tests, automatic_ci', 'enable-workflow', 'The approved path is hashed into each run’s policy identity, so it changes only with a deploy.', 'native-pr-tests'),
      item('advice', 'AI advice', 'Workers AI and AI Gateway', 'configured', [value('Allowed at deploy', 'Yes'), value('Gateway', 'golf-demo-gateway')], 'evidence.allow_ai, evidence.gateway', 'enable-ai', 'Advisory only; private source reaches Workers AI through the gateway, whose caps are set in Cloudflare.'),
      item('agents', 'Agent proposals', 'Containers and Workers AI', 'configured', [value('Editable path', 'src/app.py')], 'agent_path', 'enable-ai --agent-path', 'Agents edit one approved path in an isolated fork; the path is part of the policy identity.', 'native-pr-agents'),
      item('previews', 'Protected previews', 'Workers, R2 and Access', 'configured', [value('Preview origin', 'https://previews.demo.gitgolf.example.com'), value('Static directory', 'site'), value('Lifetime', '60 minutes'), value('Installation slots', '4', '1 held now'), value('Published automatically', 'Yes'), value('Visual snapshots', 'No')], 'previews', 'prepare', 'The preview Worker, its origin and Access application are created at deploy.', 'native-pr-previews'),
      item('apps', 'Worker applications', 'Workers for Platforms', 'unallocated', [value('Allocation', 'Not installed')], 'apps', 'prepare', 'Each application gets a private database and file bucket that are removed on expiry.', 'native-pr-apps'),
      item('secrets', 'Repository secrets and variables', 'Secrets Store', 'configured', [value('Encryption key', 'Bound (value never shown)')], 'execution_values', 'enable-secrets', 'Values are released only to approved pull-request jobs.', 'settings.repository-secrets'),
    ] },
    { id: 'integrations', label: 'Integrations', items: [
      item('webhooks', 'Webhooks', 'Workers and Secrets Store', 'configured', [value('Approved origins', ['https://hooks.slack.com', 'https://ci.example-partner-integrations.com', 'https://webhook.site', 'https://deploy-notifications.internal-tools.example.org'].join('\n')), value('Daily delivery attempts', '300', '17 of 300 used today')], 'webhooks', 'enable-webhooks --origin', 'Repository administrators can subscribe only to these exact HTTPS origins.', 'settings.repository-webhooks'),
      item('email', 'Email notifications', 'Email Service', 'configured', [value('Sender', 'golf@mail.demo.gitgolf.example.com'), value('Daily send attempts', '200', '3 of 200 used today'), value('Provider acceptance', 'First accepted 2026-10-14')], 'email', 'enable-email --email-limit', 'Mail goes only to each subscriber’s own Access sign-in address.', 'repository.email-notifications'),
    ] },
    { id: 'operations', label: 'Operations', items: [
      item('observability', 'Observability', 'Workers Logs and Analytics', 'configured', [value('Request logs', 'Yes'), value('Workers Analytics collector', 'Token bound (never shown)'), value('Evidence metrics dataset', 'Not bound')], 'operations, analytics_dataset', 'enable-observability, enable-analytics', 'Provider usage and billing are not collected.', 'operations.dashboard'),
      item('registry', 'Package registry', 'Containers registry', 'refused', [value('Provider', 'External'), value('Job publishing', 'No')], 'registry', 'prepare', 'Image publishing needs an approved test allocation.', 'repository.packages'),
    ] },
  ] });

const capabilities = [
  ['settings.native', 'Cloudflare allocation settings', 3, 'Operations administrators signed in through Access see every installation setting the Worker holds.'],
  ['operations.dashboard', 'Operations dashboard', 3, 'Current workspace administrators; durable inventories and maintenance observations.'],
  ['settings.native-runners', 'Customer-hosted native runners', 3, 'Workspace administrators can enroll outbound machines and manage native pools.'],
  ['settings.execution', 'Installation execution policy', 1, 'Cloudflare native has no installation-wide execution policy service. Repository administrators switch pull-request runs per repository; the approved workflow is fixed at deploy.'],
  ['settings.organization-creation', 'Organization creation policy', 1, 'Cloudflare native has no organization creation policy service. Accounts allowed to create repositories create organizations.'],
  ['settings.agents-admin', 'Coding agent connections', 1, 'Cloudflare native has no coding agent connection or usage service.'],
  ['settings.repository-webhooks', 'Webhooks', 3, 'Encrypted subscriptions, signed delivery and retries to operator-approved HTTPS origins.'],
  ['repository.email-notifications', 'Repository email notifications', 3, 'Email to each subscriber’s own Access sign-in address through Cloudflare Email Service.'],
  ['native-pr-evidence', 'Private PR evidence', 3, 'Operator-allocated Queues, Workflows and R2; optional advisory Clef inference.'],
  ['native-pr-apps', 'Protected Worker applications', 1, 'Operator allocation enables the prebundled module/schema consumer.'],
].map(([id, label, state, reason]) => ({ id, label, state, reason })) as { id: string; label: string; state: number; reason: string }[];

const service = (id: string, label: string, state: string, detail: string, source = 'Installed binding / policy', checkedAt = '') => ({ id, label, state, detail, source, checkedAt });
const metric = (id: string, label: string, valueNumber?: number, unit = 'count') => ({ id, label, ...(valueNumber === undefined ? {} : { value: valueNumber }), unit, source: 'D1 workspace inventory', observedAt: stamp, window: 'Current snapshot', state: valueNumber === undefined ? 'unknown' : 'available' });
const dashboard = () => ({ runtimeProfile: 'cloudflare-native', scope: 'workspace:mj', generatedAt: stamp, release: 'b7c41e9a0d2f', notices: ['Workspace inventory only. Configured bindings are not verified provider health.', 'Retained report bytes and container states come from journals, not provider billing or live container probes.'],
  services: [service('workers', 'Golf Worker / workspace Durable Object', 'available', 'This workspace control request completed; not fleet-wide health.', 'Current request', stamp), service('d1', 'D1', 'available', 'Current workspace query observation; not provider-wide availability.', 'Primary-session inventory queries', stamp),
    service('maintenance.webhooks', 'Maintenance · webhooks', 'degraded', 'failed; last success 2026-10-14T09:10:00.000Z.', 'Hosted maintenance journal', '2026-10-14T11:55:00.000Z'), service('artifacts', 'Artifacts canonical Git', 'available', 'Last successful read probe: 2026-10-14T11:58:00.000Z.', 'Retained read-only service probe', stamp),
    service('queues', 'Queues', 'observed', 'Queued evidence completed and its private report was published.', 'Successful queued evidence journal', '2026-10-14T10:00:00.000Z'), service('email', 'Email Service', 'observed', 'Cloudflare Email Service accepted a notification with a provider message id.', 'Recorded provider acceptance', '2026-10-14T09:00:00.000Z'),
    service('secrets', 'Secrets Store', 'configured', 'Configuration only; provider health and consumption are not probed by this snapshot.'), service('browser', 'Browser Run', 'disabled', 'Configuration only; provider health and consumption are not probed by this snapshot.'),
    service('platforms', 'Workers for Platforms', 'disabled', 'Configuration only.'), service('rate-limit', 'Rate limiting · anonymous public reads', 'configured', 'About 120 anonymous public read or clone requests per 60 seconds for each client network at each Cloudflare location.')],
  metrics: [metric('repositories', 'Repositories', 14), metric('jobs.queued', 'Queued evidence jobs', 2), metric('jobs.running', 'Running containers (journal)', 1), metric('previews.active', 'Active previews', 1), metric('webhooks.queued', 'Queued webhook deliveries', 3), metric('email.queued', 'Queued email deliveries', 0), metric('delivery.failed', 'Failed deliveries observed in last 7 days', 2),
    metric('reports.bytes', 'Retained report bytes (journal)', 1843200, 'bytes'), metric('billing.actual', 'Provider billed spend', undefined, 'USD')] });

export async function nativeAdmin(page: Page, options: { admin?: boolean; refuse?: boolean; installation?: () => object } = {}) {
  const s = { reads: [] as string[], installation: options.installation || overview };
  await page.route('**/native/config', route => route.fulfill({ status: 200, contentType: 'application/json', json: { runtimeProfile: 'cloudflare-native', workspace: 'mj', accessLogin: true } }));
  await page.route('**/native/installation/read', route => { s.reads.push('installation'); return options.admin === false || options.refuse ? route.fulfill({ status: 403, contentType: 'application/json', json: { code: 'permission_denied', message: 'Current workspace operations administrator sign-in required.' } }) : route.fulfill({ status: 200, contentType: 'application/json', json: s.installation() }); });
  await page.route('**/rpc/**', async route => {
    const method = route.request().url().split('/').at(-1)!; s.reads.push(method);
    if (method === 'GetSession') return respond(route, GetSessionResponseSchema, { user: { id: '1', login: 'mj', isInstanceAdmin: options.admin !== false } });
    if (method === 'ListCapabilities') return respond(route, ListCapabilitiesResponseSchema, { runtimeProfile: 'cloudflare-native', capabilities });
    if (method === 'GetProfile') return respond(route, GetProfileResponseSchema, { profile: { userId: '1', login: 'mj', revision: 'current', canEdit: true } });
    if (method === 'ListRepositories') return respond(route, ListRepositoriesResponseSchema, {});
    if (method === 'GetOperationsDashboard') return respond(route, GetOperationsDashboardResponseSchema, dashboard());
    return reject(route, 'unimplemented', 'This capability is not implemented on the native forge.');
  });
  return s;
}
const card = (page: Page, name: string) => page.getByRole('region', { name, exact: true });

test('the native installation overview leads with a summary and grouped cards of held values, with no forms', async ({ page }) => {
  await nativeAdmin(page); await page.goto('/admin');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Installation');
  await expect(page.getByRole('heading', { name: 'Admin portal' })).toHaveCount(0);
  const summary = page.locator('dl[aria-label="Installation summary"]');
  await expect(summary).toContainText('13 of 15'); await expect(summary).toContainText('1 invalid at deploy');
  await expect(summary).toContainText('b7c41e9a0d2f');
  for (const group of ['Installation and sign-in', 'Automation', 'Integrations', 'Operations']) await expect(page.getByRole('heading', { name: group, level: 2, exact: true })).toBeVisible();
  const hooks = card(page, 'Webhooks');
  await expect(hooks.getByRole('listitem')).toHaveCount(4); await expect(hooks).toContainText('https://deploy-notifications.internal-tools.example.org'); await expect(hooks).toContainText('17 of 300 used today');
  await expect(hooks).toContainText('enable-webhooks --origin'); await expect(card(page, 'Package registry')).toContainText('Invalid at deploy');
  await expect(card(page, 'Worker applications')).toContainText('Not allocated');
  await expect(page.locator('form')).toHaveCount(0); await expect(page.getByRole('button', { name: /^Edit/ })).toHaveCount(0);
  await page.getByRole('link', { name: 'Open Operations' }).click(); await expect(page).toHaveURL(/\/admin\/operations$/);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Operations');
});

test('capabilities are listed by human label behind a disclosure, with honest search wording', async ({ page }) => {
  await nativeAdmin(page); await page.goto('/admin');
  await expect(page.getByRole('table', { name: 'Installation capabilities' })).toHaveCount(0);
  await page.getByText(/^Capabilities this installation reports/).click();
  const table = page.getByRole('table', { name: 'Installation capabilities' });
  await expect(table).toContainText('Installation execution policy'); await expect(table).toContainText('settings.execution');
  await expect(page.getByText('Search and sorting cover loaded entries only.')).toBeVisible();
});

test('admin pages without a native service move into the unavailable group and explain why', async ({ page }) => {
  await nativeAdmin(page); await page.goto('/admin');
  const nav = page.getByRole('navigation', { name: 'Instance administration' });
  await expect(nav.getByRole('link', { name: 'Overview' })).toBeVisible();
  const group = nav.locator('details.settings-navigation-unavailable');
  await expect(group.locator('summary')).toContainText('Not on this installation3');
  await group.locator('summary').click(); await group.getByRole('link', { name: 'Execution policy' }).click();
  await expect(page.getByText('Cloudflare native has no installation-wide execution policy service.', { exact: false })).toBeVisible();
});

test('a refused installation read shows the error and no values', async ({ page }) => {
  await nativeAdmin(page, { refuse: true }); await page.goto('/admin');
  await expect(page.getByRole('alert')).toContainText('operations administrator sign-in required'); await expect(page.getByRole('region', { name: 'Webhooks' })).toHaveCount(0);
});

test('profile installation details never read the administrator overview or show approved origins', async ({ page }) => {
  const s = await nativeAdmin(page, { admin: false }); await page.goto('/account/settings');
  await page.getByText('Installation details', { exact: true }).click();
  await expect(page.getByText('Reading Cloudflare allocations…').or(page.getByText('Canonical Git'))).toBeVisible();
  await expect(page.getByText('hooks.slack.com')).toHaveCount(0); expect(s.reads).not.toContain('installation');
});

test('the operations page leads with summaries and keeps the full metric table behind a disclosure', async ({ page }) => {
  await nativeAdmin(page); await page.goto('/admin/operations');
  await expect(page.locator('dl[aria-label="Service summary"]')).toContainText('5 of 10');
  await expect(page.locator('dl[aria-label="Current workload"]')).toContainText('Repositories');
  await expect(page.getByRole('region', { name: 'Needs attention' })).toContainText('Maintenance · webhooks');
  await expect(page.getByRole('table', { name: 'service observations' })).toContainText('Email Service');
  await expect(page.getByRole('table', { name: 'operations metrics' })).toHaveCount(0);
  await page.getByText('All metrics and usage (9)').click(); await expect(page.getByRole('table', { name: 'operations metrics' })).toContainText('Provider billed spend');
});

// GOLF_ADMIN_SHOTS=directory writes review screenshots of the administration pages in each appearance; skipped otherwise.
const looks = [['flare', 'console', 'dark', 1440, 900], ['flare', 'console', 'light', 1440, 900], ['golf', 'tiles', 'dark', 1440, 900], ['classic', 'primer', 'light', 1440, 900], ['flare', 'console', 'dark', 390, 844]] as const;
for (const [appearance, layout, theme, width, height] of looks) test(`review screenshots: ${appearance} ${layout} ${theme} ${width}`, async ({ page }) => {
  test.skip(!process.env.GOLF_ADMIN_SHOTS, 'Set GOLF_ADMIN_SHOTS to a directory to write review screenshots.');
  const name = (view: string) => `${process.env.GOLF_ADMIN_SHOTS}/${view}-${appearance}-${layout}-${theme}-${width}.png`;
  await page.setViewportSize({ width, height });
  await page.addInitScript(look => { localStorage.setItem('golf.appearance', look.appearance); localStorage.setItem(`golf.layout.${look.appearance}`, look.layout); localStorage.setItem('golf.theme', look.theme); }, { appearance, layout, theme });
  await nativeAdmin(page);
  for (const [view, path] of [['admin', '/admin'], ['operations', '/admin/operations']] as const) {
    await page.goto(path); await expect(page.getByRole('heading', { level: 1 })).toBeVisible(); await expect(page.locator('dl.summary-band').first()).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth), `${view} overflows horizontally`).toBeLessThanOrEqual(0);
    await page.screenshot({ path: name(view), fullPage: true });
    if (width < 500) await page.screenshot({ path: name(view + '-first-screen') });
  }
});
