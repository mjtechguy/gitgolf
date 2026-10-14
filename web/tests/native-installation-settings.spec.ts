import { test, expect, type Page } from '@playwright/test';
import { respond, reject } from './rpc';
import { GetOperationsDashboardResponseSchema, GetProfileResponseSchema, GetSessionResponseSchema, ListCapabilitiesResponseSchema, ListRepositoriesResponseSchema } from '../src/gen/golf/v1/golf_pb';

// Mirrors what cloudflare/forge/src/installation.mjs and operations.mjs return for an operations administrator on a hosted installation.
const origin = 'https://demo.gitgolf.example.com', stamp = new Date(Date.now() - 90_000).toISOString();
const value = (label: string, text: string, usage?: string) => ({ label, value: text, ...(usage ? { usage } : {}) });
const item = (id: string, label: string, service: string, state: string, values: object[], settingsKey: string, alchemy: string, reason: string, capability = '') => ({ id, label, service, state, capability, values, change: { settingsKey, alchemy }, reason });
const baseOverview = () => ({ generatedAt: stamp, release: 'b7c41e9a0d2f5c6e8a1b3d4f5e6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a', configuration: '9f8e7d6c5b4a39281706f5e4d3c2b1a0', schema: 30, workspace: 'mj', publicOrigin: origin, demoStopAt: '2026-11-30T00:00:00.000Z',
  groups: [
    { id: 'installation', label: 'Installation and sign-in', items: [
      item('workspace', 'Workspace', 'Workers and Durable Objects', 'configured', [value('Workspace', 'mj'), value('Public origin', origin), value('Cloudflare account', '0123456789abcdef0123456789abcdef'), value('Artifacts namespace', 'golf-demo')], 'origin, workspace', 'prepare', 'Fixed when the installation is provisioned.'),
      item('access', 'Cloudflare Access sign-in', 'Access / Zero Trust', 'configured', [value('Team domain', 'https://golf-demo.cloudflareaccess.com'), value('Application audience', 'Configured (not shown)')], 'access_team_domain, access_aud', 'prepare', 'People sign in through Access; the audience tag is a credential check and is never displayed.'),
      item('public', 'Public repositories', 'Workers', 'configured', [value('Anonymous browsing and cloning', 'Allowed for repositories an administrator publishes'), value('First-visit appearance', 'flare/console')], 'public_repositories, default_appearance', 'enable-public', 'Publishing needs a repository administrator; collaboration and execution keep repository grants.', 'repository.public-source'),
      item('rate-limit', 'Anonymous rate limit', 'Workers rate limiting', 'configured', [value('Limit', 'About 120 requests per 60 seconds per client network and location')], 'anonymous_rate_limit', 'enable-rate-limit', 'Counts are approximate and per Cloudflare location; signed-in, credentialed and runner requests are never counted.'),
    ] },
    { id: 'automation', label: 'Automation', items: [
      item('evidence', 'Pull-request evidence', 'Queues, Workflows and R2', 'configured', [value('Queue', 'golf-demo-evidence'), value('Workflow', 'golf-demo-evidence-workflow'), value('Failure queue', 'golf-demo-evidence-failures'), value('Daily admissions', '20', '7 of 20 used today')], 'evidence', 'prepare', 'Every test, agent and advice run is admitted here; private reports go to R2.', 'native-pr-evidence'),
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

// Slice 2: editable policy inside the allocation, as installation.mjs reports it.
const effect = (queued: string) => ({ queued, inFlight: 'A delivery already sending completes.', new: 'Subscriptions to a removed origin can no longer be saved. A new limit applies at the next claim.' });
const policy = (key: string, label: string, valueNow: object, deploy: object, bounds: object, extra: object = {}) => ({ key, label, version: '0', value: valueNow, deploy, source: 'deploy', unreadable: false, updatedAt: '', updatedBy: '', bounds, effect: effect('Queued and retrying deliveries to a removed origin fail at their next attempt (destination unavailable).'), confirmation: key, ...extra });
const hooks = ['https://hooks.slack.com', 'https://ci.example-partner-integrations.com', 'https://webhook.site', 'https://deploy-notifications.internal-tools.example.org'];
export const recentEntries = () => [
  { id: '3', at: new Date(Date.now() - 600_000).toISOString(), actor: 'mj', actorEmail: 'mj@example.com', scope: 'installation', scopeId: 'mj', subject: 'evidence', action: 'update', before: { dailyLimit: 50 }, after: { dailyLimit: 20 }, widening: false, client: { colo: 'LHR', country: 'GB' } },
  { id: '2', at: new Date(Date.now() - 3_600_000).toISOString(), actor: 'mj', actorEmail: 'mj@example.com', scope: 'installation', scopeId: 'mj', subject: 'webhooks', action: 'update', before: { origins: hooks.slice(0, 3), dailyLimit: 300 }, after: { origins: hooks, dailyLimit: 300 }, widening: true, client: { colo: 'LHR', country: 'GB' } },
  { id: '1', at: new Date(Date.now() - 86_400_000).toISOString(), actor: 'ops', actorEmail: 'ops@example.com', scope: 'installation', scopeId: 'mj', subject: 'rate-limit', action: 'update', before: { enabled: true }, after: { enabled: true }, widening: false, client: {} },
];
// The same changes as /native/audit/read reports them for the installation audit log.
const auditEvents = () => recentEntries().map(entry => ({ ...entry, category: 'installation_policy', categoryLabel: 'Installation policy', description: `${entry.widening ? 'widened' : 'changed'} installation policy ${entry.subject}`, actorKind: 'person', repository: '', organization: '', outcome: 'success', code: '' }));
export function overview(locked = false) {
  const data = baseOverview() as ReturnType<typeof baseOverview> & { editing: object; recent: object[] };
  const policies: Record<string, object> = {
    webhooks: policy('webhooks', 'Webhooks', { origins: hooks, dailyLimit: 300 }, { origins: hooks.slice(0, 3), dailyLimit: 300 }, { origins: 'One to 32 public HTTPS origins. Never this installation or its subdomains, the preview origin, Cloudflare Access or Artifacts.', dailyLimit: [1, 5000] }, { version: '1', source: 'installation', updatedAt: new Date(Date.now() - 3_600_000).toISOString(), updatedBy: 'mj' }),
    email: policy('email', 'Email notifications', { enabled: true, dailyLimit: 200 }, { enabled: true, dailyLimit: 200 }, { dailyLimit: [1, 5000] }),
    advice: policy('advice', 'AI advice', { enabled: true }, { enabled: true }, {}),
    agents: policy('agents', 'Agent proposals', { enabled: true }, { enabled: true }, {}),
    previews: policy('previews', 'Protected previews', { lifetimeSeconds: 3600, concurrency: 4 }, { lifetimeSeconds: 3600, concurrency: 4 }, { lifetimeSeconds: [60, 3600], concurrency: [1, 4] }),
    'rate-limit': policy('rate-limit', 'Anonymous rate limit', { enabled: true }, { enabled: true }, {}, { version: '1', source: 'installation', updatedAt: new Date(Date.now() - 86_400_000).toISOString(), updatedBy: 'ops' }),
    evidence: policy('evidence', 'Daily evidence admissions', { dailyLimit: 20 }, { dailyLimit: 50 }, { dailyLimit: [1, 50] }, { version: '1', source: 'installation', updatedAt: new Date(Date.now() - 600_000).toISOString(), updatedBy: 'mj' }),
  };
  for (const group of data.groups) for (const entry of group.items as { id: string; policy?: object }[]) if (policies[entry.id]) entry.policy = policies[entry.id];
  data.editing = locked ? { enabled: false, reason: 'Installation policy is locked at deploy (policy_editing: false). Deploy values apply and every change needs a deploy.' }
    : { enabled: true, reason: 'Operations administrators signed in through Access can narrow these values at any time. Widening one needs typed confirmation and an Access sign-in from the last 10 minutes.' };
  data.recent = recentEntries();
  return data;
}

const capabilities = [
  ['settings.native', 'Cloudflare allocation settings', 3, 'Operations administrators signed in through Access see every installation setting the Worker holds.'],
  ['settings.installation-audit', 'Installation audit log', 3, 'Append-only record of privileged and state-changing actions at installation, organization and repository scope. Operations administrators read all of it through Access; organization owners and repository administrators read their own scope.'],
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

export async function nativeAdmin(page: Page, options: { admin?: boolean; refuse?: boolean; installation?: () => object; update?: (body: Record<string, unknown>) => { status: number; json: object } } = {}) {
  const s = { reads: [] as string[], writes: [] as Record<string, unknown>[], installation: options.installation || (() => overview()) };
  await page.route('**/native/installation', route => { const body = route.request().postDataJSON(); s.writes.push(body); const result = options.update?.(body) || { status: 200, json: { key: body.key, version: String(Number(body.expectedVersion) + 1), value: body.value, widening: false, operationId: body.operationId, at: stamp } };
    return route.fulfill({ status: result.status, contentType: 'application/json', json: result.json }); });
  await page.route('**/native/config', route => route.fulfill({ status: 200, contentType: 'application/json', json: { runtimeProfile: 'cloudflare-native', workspace: 'mj', accessLogin: true } }));
  await page.route('**/native/installation/read', route => { s.reads.push('installation'); return options.admin === false || options.refuse ? route.fulfill({ status: 403, contentType: 'application/json', json: { code: 'permission_denied', message: 'Current workspace operations administrator sign-in required.' } }) : route.fulfill({ status: 200, contentType: 'application/json', json: route.request().postDataJSON().action === 'audit' ? { entries: recentEntries(), page: { nextPage: 0 } } : s.installation() }); });
  await page.route('**/native/audit/read', route => { s.reads.push('audit'); return options.admin === false || options.refuse ? route.fulfill({ status: 403, contentType: 'application/json', json: { code: 'permission_denied', message: 'Current workspace operations administrator sign-in required.' } })
    : route.fulfill({ status: 200, contentType: 'application/json', json: { entries: auditEvents(), page: { nextPage: 0 }, categories: [{ id: 'installation_policy', label: 'Installation policy' }], recording: { failures: 0, lastFailureAt: '' }, scope: { kind: 'installation', id: 'mj', label: 'mj' } } }); });
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

test('the native installation overview leads with a summary and grouped cards of held values, with no form open', async ({ page }) => {
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
  await expect(page.locator('form')).toHaveCount(0);
  await page.getByRole('link', { name: 'Open Operations' }).click(); await expect(page).toHaveURL(/\/admin\/operations$/);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Operations');
});

test('capabilities are listed by human label behind a disclosure, with honest search wording', async ({ page }) => {
  await nativeAdmin(page); await page.goto('/admin');
  await expect(page.getByRole('table', { name: 'Installation capabilities' })).toHaveCount(0);
  await page.getByText(/^Capabilities this installation reports/).click();
  const table = page.getByRole('table', { name: 'Installation capabilities' });
  await expect(table).toContainText('Installation execution policy'); await expect(table).toContainText('settings.execution');
  await expect(page.getByRole('searchbox', { name: 'Search loaded Installation capabilities' })).toBeVisible();
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

test('a policy opens for editing only on request, states its effect and saves a narrowing with the version it read', async ({ page }) => {
  const s = await nativeAdmin(page); await page.goto('/admin');
  const hooks = card(page, 'Webhooks');
  await expect(hooks).toContainText('Set here by mj'); await expect(hooks).toContainText('deploy value 3 origins · 300 attempts a day');
  await expect(page.getByRole('button', { name: /^Edit / })).toHaveCount(7);
  await hooks.getByRole('button', { name: 'Edit webhooks' }).click();
  const form = page.getByRole('form', { name: 'Edit webhooks' });
  await expect(form).toContainText('Queued and retrying deliveries to a removed origin fail at their next attempt');
  await expect(form).toContainText('A delivery already sending completes.');
  await form.getByLabel('Approved origins').fill('https://hooks.slack.com\nhttps://webhook.site');
  await expect(form.getByText(/^Type webhooks to widen/)).toHaveCount(0);
  await form.getByRole('button', { name: 'Save webhooks' }).click();
  await expect(form).toHaveCount(0);
  expect(s.writes).toEqual([expect.objectContaining({ action: 'update', key: 'webhooks', expectedVersion: '1', value: { origins: ['https://hooks.slack.com', 'https://webhook.site'], dailyLimit: 300 } })]);
  expect(s.writes[0]!.operationId).toMatch(/^[a-f0-9-]{36}$/); expect(s.writes[0]).not.toHaveProperty('confirmation');
});

test('widening asks for the typed setting name, and a stale sign-in explains how to sign in again', async ({ page }) => {
  const s = await nativeAdmin(page, { update: body => body.confirmation === 'email' ? { status: 412, json: { code: 'failed_precondition', message: 'Widening changes need an Access sign-in from the last 10 minutes. Sign out of Access, sign in again and retry.' } } : { status: 412, json: { code: 'failed_precondition', message: 'This change widens email notifications. Type email to confirm it.' } } });
  await page.goto('/admin');
  await card(page, 'Email notifications').getByRole('button', { name: 'Edit email notifications' }).click();
  const form = page.getByRole('form', { name: 'Edit email notifications' });
  await form.getByLabel('Send attempts a day').fill('400');
  await form.getByLabel(/^Type email to widen/).fill('email');
  await form.getByRole('button', { name: 'Save email notifications' }).click();
  await expect(form.getByRole('alert')).toContainText('last 10 minutes'); await expect(form.getByRole('link', { name: 'Sign out of Access' })).toHaveAttribute('href', '/cdn-cgi/access/logout');
  await form.getByRole('button', { name: 'Save email notifications' }).click();
  expect(s.writes).toHaveLength(2); expect(s.writes[1]!.operationId).toBe(s.writes[0]!.operationId);
  expect(s.writes[0]).toMatchObject({ key: 'email', value: { enabled: true, dailyLimit: 400 }, confirmation: 'email' });
});

test('a deploy lock shows its reason and offers no edits; recent changes link to the audit log', async ({ page }) => {
  await nativeAdmin(page, { installation: () => overview(true) }); await page.goto('/admin');
  await expect(page.getByText('Installation policy is locked at deploy (policy_editing: false).', { exact: false })).toBeVisible();
  await expect(page.getByRole('button', { name: /^Edit / })).toHaveCount(0);
  const recentChanges = page.getByRole('region', { name: 'Recent changes' });
  await expect(recentChanges).toContainText('Webhooks · widened by mj'); await expect(recentChanges).toContainText('from LHR, GB');
  await page.getByText('If an administrator’s Access session is stolen').click();
  await expect(page.getByText('cannot go beyond what the deploy allocated', { exact: false })).toBeVisible();
  await recentChanges.getByRole('link', { name: 'Open the audit log' }).click(); await expect(page).toHaveURL(/\/admin\/audit$/);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Audit log');
  const table = page.getByRole('table', { name: 'Installation audit log' });
  await expect(table.locator('tbody tr')).toHaveCount(3); await expect(table).toContainText('Widening'); await expect(table).toContainText('GB · LHR');
  await expect(table).toContainText('mj widened installation policy webhooks'); await expect(table).toContainText('Succeeded');
  await expect(page.getByRole('navigation', { name: 'Instance administration' }).getByRole('link', { name: 'Audit log' })).toHaveAttribute('aria-current', 'page');
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
  await page.goto('/admin'); await card(page, 'Webhooks').getByRole('button', { name: 'Edit webhooks' }).click();
  const form = page.getByRole('form', { name: 'Edit webhooks' });
  await form.getByLabel('Approved origins').fill(hooks.join('\n') + '\nhttps://new-partner.example.com'); await expect(form.getByLabel(/^Type webhooks to widen/)).toBeVisible();
  await card(page, 'Webhooks').scrollIntoViewIfNeeded();
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth), 'edit state overflows horizontally').toBeLessThanOrEqual(0);
  await card(page, 'Webhooks').screenshot({ path: name('edit-webhooks') });
  await page.goto('/admin/audit'); await expect(page.getByRole('table', { name: 'Installation audit log' })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth), 'audit overflows horizontally').toBeLessThanOrEqual(0);
  await page.screenshot({ path: name('audit'), fullPage: true });
});
