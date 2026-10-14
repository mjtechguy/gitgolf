import { expect, test, type Page } from '@playwright/test';
import { GetAuthenticationOptionsResponseSchema, GetSessionResponseSchema, ListCapabilitiesResponseSchema, ListRepositoriesResponseSchema } from '../src/gen/golf/v1/golf_pb';
import { reject, respond } from './rpc';

// API tokens on the Cloudflare-native runtime (docs/AGENT_ACCESS.md): Settings → Developer → API tokens against a mocked
// /native/api-tokens shaped like the Worker's user API.
const now = Date.now(), at = (hours: number) => new Date(now + hours * 3600_000).toISOString();
const secret = 'golf_pat_' + 'S'.repeat(43);
type Token = Record<string, unknown> & { id: string; label: string; state: string };
const repositories = [{ id: '41', name: 'demo', fullName: 'alex/demo', defaultBranch: 'main', private: true }, { id: '42', name: 'site', fullName: 'acme/site', defaultBranch: 'main', private: true }];

async function backend(page: Page, { capability = true } = {}) {
  const state = { calls: [] as Record<string, unknown>[], tokens: [
    { id: '7', label: 'claude on laptop', permission: 'write', branchPattern: 'agent/*', state: 'active', repositories: [{ id: '41', fullName: 'alex/demo' }], createdAt: at(-48), expiresAt: at(24 * 28), lastUsedAt: at(-1), revokedAt: '' },
    { id: '5', label: 'old reader', permission: 'read', branchPattern: '', state: 'expired', repositories: null, createdAt: at(-24 * 40), expiresAt: at(-24 * 10), lastUsedAt: '', revokedAt: '' },
  ] as Token[] };
  await page.route('**/rpc/**', async route => {
    const method = new URL(route.request().url()).pathname.split('/').at(-1)!;
    if (method === 'GetSession') return respond(route, GetSessionResponseSchema, { user: { id: '17', login: 'alex' } });
    if (method === 'GetAuthenticationOptions') return respond(route, GetAuthenticationOptionsResponseSchema, {});
    if (method === 'ListCapabilities') return respond(route, ListCapabilitiesResponseSchema, { runtimeProfile: 'cloudflare-native', capabilities: capability ? [{ id: 'agents.mcp', label: 'API tokens and remote MCP', state: 3, reason: 'Schema present.' }] : [] });
    if (method === 'ListRepositories') return respond(route, ListRepositoriesResponseSchema, { repositories });
    return reject(route, 'unimplemented', 'Fixture procedure not supplied.');
  });
  await page.route('**/native/**', async route => {
    const path = new URL(route.request().url()).pathname, body = (route.request().postDataJSON() || {}) as Record<string, unknown>;
    const json = (value: unknown, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(value) });
    if (path === '/native/config') return json({ runtimeProfile: 'cloudflare-native', workspace: 'alex', pipelines: false });
    if (path === '/native/api-tokens') {
      state.calls.push(body);
      if (body.action === 'list') return json({ tokens: state.tokens, active: state.tokens.filter(t => t.state === 'active').length, limit: 50, mcpUrl: 'https://golf.example/mcp', origin: 'https://golf.example' });
      if (body.action === 'create') {
        if (body.label === 'too many') return json({ code: 'failed_precondition', message: 'Your account has 50 active API tokens, or its access changed. Revoke unused tokens and retry.' }, 412);
        const ids = body.repositories as string[] | null, token: Token = { id: '8', label: String(body.label), permission: body.permission, branchPattern: body.branchPattern || '', state: 'active',
          repositories: ids && ids.map(id => ({ id, fullName: repositories.find(r => r.id === id)!.fullName })), createdAt: at(0), expiresAt: at(Number(body.lifetimeHours)), lastUsedAt: '', revokedAt: '' };
        state.tokens.unshift(token);
        return json({ token, secret, mcpUrl: 'https://golf.example/mcp', origin: 'https://golf.example' });
      }
      if (body.action === 'revoke') { Object.assign(state.tokens.find(t => t.id === body.id)!, { state: 'revoked', revokedAt: at(0) }); return json({ id: body.id, revoked: true }); }
    }
    return json({ code: 'unimplemented', message: 'Fixture route not supplied.' }, 501);
  });
  return state;
}
const table = (page: Page) => page.getByRole('table', { name: 'API tokens' });

test('API tokens lead with the inventory; New token opens the form and shows the secret once with ready-to-paste agent setups', async ({ page }) => {
  const state = await backend(page);
  await page.goto('/account/api-tokens');
  await expect(page.getByRole('heading', { name: 'API tokens', level: 1 })).toBeVisible();
  await expect(page.getByRole('navigation', { name: 'Account settings' }).getByRole('link', { name: 'API tokens' })).toHaveAttribute('aria-current', 'page');
  const laptop = table(page).getByRole('row').filter({ hasText: 'claude on laptop' });
  await expect(laptop).toContainText('alex/demo'); await expect(laptop).toContainText('Read and write'); await expect(laptop).toContainText('agent/*'); await expect(laptop).toContainText('Active');
  const old = table(page).getByRole('row').filter({ hasText: 'old reader' });
  await expect(old).toContainText('All repositories you can access'); await expect(old).toContainText('Expired'); await expect(old).toContainText('Never'); await expect(old).toContainText('No writes');
  await expect(old.getByRole('button', { name: /Revoke/ })).toHaveCount(0);
  await expect(page.getByText('1 of 50 active.')).toBeVisible();
  // The form opens only on request.
  await expect(page.getByRole('form', { name: 'New API token' })).toHaveCount(0);
  await page.getByRole('button', { name: 'New token' }).click();
  const form = page.getByRole('form', { name: 'New API token' });
  await form.getByLabel('Name').fill('codex agent');
  await form.getByRole('radio', { name: /Only selected repositories/ }).check();
  await expect(form.getByRole('button', { name: 'Create token' })).toBeDisabled();
  await form.getByRole('checkbox', { name: 'acme/site' }).check();
  await expect(form.getByLabel('Write branches')).toHaveCount(0);
  await form.getByLabel('Permission').selectOption('write');
  await expect(form).toContainText('limits commits and pushes to matching branches');
  await form.getByLabel('Write branches').fill('agent/*');
  await form.getByLabel('Expires after').selectOption({ label: '7 days' });
  await form.getByRole('button', { name: 'Create token' }).click();
  expect(state.calls.find(c => c.action === 'create')).toEqual({ action: 'create', label: 'codex agent', repositories: ['42'], permission: 'write', branchPattern: 'agent/*', lifetimeHours: 168 });
  const shown = page.getByRole('region', { name: 'Your new API token' });
  await expect(shown).toContainText(secret);
  await expect(shown).toContainText(`claude mcp add --transport http golf https://golf.example/mcp --header "Authorization: Bearer ${secret}"`);
  await expect(shown).toContainText('bearer_token_env_var = "GOLF_API_TOKEN"');
  await expect(shown).toContainText('"type": "remote"');
  await expect(shown).toContainText(`git clone https://x:${secret}@golf.example/git/acme/site.git`);
  await expect(shown.getByRole('button', { name: 'Copy token' })).toBeVisible();
  await expect(page.getByRole('form', { name: 'New API token' })).toHaveCount(0);
  await expect(table(page).getByRole('row').filter({ hasText: 'codex agent' })).toContainText('acme/site');
  await shown.getByRole('button', { name: 'Done' }).click();
  await expect(shown).toHaveCount(0);
  await expect(page.getByText(secret)).toHaveCount(0);
});

test('revoking asks first and reports the change; refusals show Golf’s message', async ({ page }) => {
  const state = await backend(page);
  await page.goto('/account/api-tokens');
  page.once('dialog', dialog => { expect(dialog.message()).toContain('Revoke API token claude on laptop?'); void dialog.accept(); });
  await table(page).getByRole('button', { name: 'Revoke claude on laptop' }).click();
  await expect(page.getByText('claude on laptop was revoked.')).toBeVisible();
  await expect(table(page).getByRole('row').filter({ hasText: 'claude on laptop' })).toContainText('Revoked');
  expect(state.calls.find(c => c.action === 'revoke')).toEqual({ action: 'revoke', id: '7' });
  await page.getByRole('button', { name: 'New token' }).click();
  const form = page.getByRole('form', { name: 'New API token' });
  await form.getByLabel('Name').fill('too many');
  await form.getByRole('button', { name: 'Create token' }).click();
  await expect(form.getByRole('alert')).toContainText('Your account has 50 active API tokens');
  await form.getByRole('button', { name: 'Cancel' }).click();
  await expect(form).toHaveCount(0);
});

test('without the agents.mcp capability the page and its navigation entry are not offered', async ({ page }) => {
  await backend(page, { capability: false });
  await page.goto('/account/settings');
  await expect(page.getByRole('navigation', { name: 'Account settings' }).getByRole('link', { name: 'Profile' })).toBeVisible();
  await expect(page.getByRole('navigation', { name: 'Account settings' }).getByRole('link', { name: 'API tokens' })).toHaveCount(0);
  await page.goto('/account/api-tokens');
  await expect(page.getByRole('table', { name: 'API tokens' })).toHaveCount(0);
});
