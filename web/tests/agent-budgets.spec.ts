import { expect, test, type Page } from '@playwright/test';
import { GetAuthenticationOptionsResponseSchema, GetProfileResponseSchema, GetSessionResponseSchema, ListCapabilitiesResponseSchema, ListRepositoriesResponseSchema } from '../src/gen/golf/v1/golf_pb';
import { reject, respond } from './rpc';

// Agent rate budgets (AM-6, docs/AGENT_ACCESS.md) against mocked Worker routes shaped like cloudflare/forge/src/agent-budgets.mjs:
// the installation setting on /admin and each token's current minute on Settings → API tokens.
const stamp = new Date(Date.now() - 60_000).toISOString(), at = (hours: number) => new Date(Date.now() + hours * 3600_000).toISOString();
const defaults = { enabled: true, tokenRequestsPerMinute: 600, tokenWritesPerMinute: 60, taskRequestsPerMinute: 600, taskWritesPerMinute: 120 };
const bounds = Object.fromEntries(Object.keys(defaults).filter(key => key !== 'enabled').map(key => [key, [1, 100000]]));

function overview(value = defaults, version = '0') {
  return { generatedAt: stamp, release: 'b7c41e9a0d2f', configuration: '9f8e7d6c5b4a', schema: 43, workspace: 'mj', publicOrigin: 'https://golf.example', demoStopAt: '',
    editing: { enabled: true, reason: 'Operations administrators signed in through Access can narrow these values at any time. Widening one needs typed confirmation and an Access sign-in from the last 10 minutes.' },
    recent: [], groups: [{ id: 'installation', label: 'Installation and sign-in', items: [{ id: 'agent-budgets', label: 'Agent rate budgets', service: 'Durable Objects', state: 'configured', capability: '',
      values: [{ label: 'Budgets', value: value.enabled ? 'On' : 'Off (counted, never refused)' }, { label: 'Each API token', value: `${value.tokenRequestsPerMinute} requests and ${value.tokenWritesPerMinute} writes a minute` },
        { label: 'Each agent task', value: `${value.taskRequestsPerMinute} requests and ${value.taskWritesPerMinute} writes a minute` }],
      change: { settingsKey: '', alchemy: '' }, reason: 'A throttle kept in the workspace’s memory, not a quota: counts restart when the workspace restarts. People signed in through Access are never counted.',
      policy: { key: 'agent-budgets', label: 'Agent rate budgets', version, value, deploy: defaults, source: version === '0' ? 'deploy' : 'installation', unreadable: false, updatedAt: version === '0' ? '' : stamp, updatedBy: version === '0' ? '' : 'mj', bounds,
        effect: { queued: 'Nothing is queued by a budget.', inFlight: 'Requests already admitted complete.', new: 'Applies to the next request: each token and task keeps the window it has open, counted against the new limits.' }, confirmation: 'agent-budgets' } }] }] };
}

async function backend(page: Page, budget: object | null = { enabled: true, requestsPerMinute: 600, writesPerMinute: 60 }) {
  const s = { writes: [] as Record<string, unknown>[], value: defaults, version: '0' };
  await page.route('**/rpc/**', async route => {
    const method = new URL(route.request().url()).pathname.split('/').at(-1)!;
    if (method === 'GetSession') return respond(route, GetSessionResponseSchema, { user: { id: '1', login: 'mj', isInstanceAdmin: true } });
    if (method === 'GetAuthenticationOptions') return respond(route, GetAuthenticationOptionsResponseSchema, {});
    if (method === 'ListCapabilities') return respond(route, ListCapabilitiesResponseSchema, { runtimeProfile: 'cloudflare-native', capabilities: [{ id: 'agents.mcp', label: 'API tokens and remote MCP', state: 3, reason: 'Schema present.' }, { id: 'settings.native', label: 'Cloudflare allocation settings', state: 3, reason: 'Ready.' }] });
    if (method === 'GetProfile') return respond(route, GetProfileResponseSchema, { profile: { userId: '1', login: 'mj', revision: 'current', canEdit: true } });
    if (method === 'ListRepositories') return respond(route, ListRepositoriesResponseSchema, {});
    return reject(route, 'unimplemented', 'Fixture procedure not supplied.');
  });
  await page.route('**/native/**', async route => {
    const path = new URL(route.request().url()).pathname, body = (route.request().postDataJSON() || {}) as Record<string, unknown>;
    const json = (value: unknown, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(value) });
    if (path === '/native/config') return json({ runtimeProfile: 'cloudflare-native', workspace: 'mj', accessLogin: true });
    if (path === '/native/installation/read') return json(overview(s.value, s.version));
    if (path === '/native/installation') {
      s.writes.push(body);
      if (body.confirmation !== 'agent-budgets' && (body.value as typeof defaults).tokenWritesPerMinute > s.value.tokenWritesPerMinute) return json({ code: 'failed_precondition', message: 'This change widens agent rate budgets. Type agent-budgets to confirm it.' }, 412);
      s.value = body.value as typeof defaults; s.version = String(Number(body.expectedVersion) + 1);
      return json({ key: body.key, version: s.version, value: s.value, widening: false, operationId: body.operationId, at: stamp });
    }
    if (path === '/native/api-tokens') return json({ active: 2, limit: 50, mcpUrl: 'https://golf.example/mcp', origin: 'https://golf.example', budget, tokens: [
      { id: '7', label: 'claude on laptop', permission: 'write', branchPattern: 'agent/*', state: 'active', repositories: null, createdAt: at(-48), expiresAt: at(24), lastUsedAt: at(0), revokedAt: '', ...(budget ? { usage: { requests: 41, writes: 60, resetsInSeconds: 23 } } : {}) },
      { id: '6', label: 'codex reader', permission: 'read', branchPattern: '', state: 'active', repositories: null, createdAt: at(-48), expiresAt: at(24), lastUsedAt: '', revokedAt: '', ...(budget ? { usage: { requests: 0, writes: 0, resetsInSeconds: 0 } } : {}) },
      { id: '5', label: 'old reader', permission: 'read', branchPattern: '', state: 'expired', repositories: null, createdAt: at(-900), expiresAt: at(-24), lastUsedAt: '', revokedAt: '' }] });
    return json({ code: 'unimplemented', message: 'Fixture route not supplied.' }, 501);
  });
  return s;
}

test('agent rate budgets lead with current values; Edit opens the form, narrowing saves and widening asks for the setting name', async ({ page }) => {
  const s = await backend(page);
  await page.goto('/admin');
  const card = page.getByRole('region', { name: 'Agent rate budgets', exact: true });
  await expect(card).toContainText('600 requests and 60 writes a minute'); await expect(card).toContainText('600 requests and 120 writes a minute');
  await expect(card).toContainText('Built-in default'); await expect(card).toContainText('not a quota');
  await expect(card).not.toContainText('forge.json');
  await expect(page.locator('form')).toHaveCount(0);
  await card.getByRole('button', { name: 'Edit agent rate budgets' }).click();
  const form = page.getByRole('form', { name: 'Edit agent rate budgets' });
  await expect(form.getByLabel('API token writes a minute')).toHaveValue('60');
  await expect(form).toContainText('1 to 100,000.');
  await expect(form.getByLabel('Refuse requests over these budgets')).toBeChecked();
  await form.getByLabel('API token writes a minute').fill('30');
  await expect(form.getByText(/^Type agent-budgets to widen/)).toHaveCount(0);
  await form.getByRole('button', { name: 'Save agent rate budgets' }).click();
  await expect(form).toHaveCount(0);
  expect(s.writes[0]).toMatchObject({ action: 'update', key: 'agent-budgets', expectedVersion: '0', value: { ...defaults, tokenWritesPerMinute: 30 } });
  expect(s.writes[0]).not.toHaveProperty('confirmation');
  await expect(card).toContainText('600 requests and 30 writes a minute'); await expect(card).toContainText('Set here by mj');
  // Raising a limit widens: the form asks for the typed setting name before saving.
  await card.getByRole('button', { name: 'Edit agent rate budgets' }).click();
  await form.getByLabel('API token writes a minute').fill('90');
  await form.getByLabel(/^Type agent-budgets to widen/).fill('agent-budgets');
  await form.getByRole('button', { name: 'Save agent rate budgets' }).click();
  await expect(form).toHaveCount(0);
  expect(s.writes[1]).toMatchObject({ expectedVersion: '1', value: { tokenWritesPerMinute: 90 }, confirmation: 'agent-budgets' });
});

test('API tokens show each active token’s current minute against the budget in force, labelled as a throttle', async ({ page }) => {
  await backend(page);
  await page.goto('/account/api-tokens');
  const table = page.getByRole('table', { name: 'API tokens' });
  await expect(table.getByRole('columnheader', { name: 'This minute' })).toBeVisible();
  const laptop = table.getByRole('row').filter({ hasText: 'claude on laptop' });
  await expect(laptop).toContainText('41 of 600 requests · 60 of 60 writes'); await expect(laptop).toContainText('At budget · resets in 23 s');
  await expect(table.getByRole('row').filter({ hasText: 'codex reader' })).toContainText('0 of 600 requests · 0 of 60 writes');
  await expect(table.getByRole('row').filter({ hasText: 'old reader' })).not.toContainText('requests');
  await expect(page.getByText(/Each token may make 600 requests and 60 writes a minute; past that, Golf answers “retry in N s”\. Counts are a throttle/)).toBeVisible();
});

test('without a counter on this runtime the page says use is not counted here', async ({ page }) => {
  await backend(page, null);
  await page.goto('/account/api-tokens');
  await expect(page.getByRole('table', { name: 'API tokens' }).getByRole('row').filter({ hasText: 'claude on laptop' })).toContainText('Not counted here');
  await expect(page.getByText(/Each token may make/)).toHaveCount(0);
});
