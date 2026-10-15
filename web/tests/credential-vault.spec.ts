import { expect, test, type Page } from '@playwright/test';
import { GetAuthenticationOptionsResponseSchema, GetSessionResponseSchema, ListCapabilitiesResponseSchema } from '../src/gen/golf/v1/golf_pb';
import { reject, respond } from './rpc';

// The credential vault and engines on the Cloudflare-native runtime (docs/CREDENTIAL_VAULT.md, docs/ENGINES.md), against mocked
// /native/credentials and /native/engines shaped like the Worker's API. No value ever comes back from the backend.
const now = Date.now(), at = (hours: number) => new Date(now + hours * 3600_000).toISOString();
type Row = Record<string, unknown> & { id: string; label: string };
const credential = (extra: Record<string, unknown>): Row => ({ id: crypto.randomUUID(), scope: 'user', ownerId: '17', kind: 'api-key', provider: 'anthropic', tool: '', label: 'Key', fingerprint: '…abcd', valueBytes: 40,
  state: 'active', version: 1, createdBy: 'alex', createdAt: at(-48), rotatedAt: '', revokedAt: '', lastUsedAt: '', usable: true, usableReason: '', grants: [], ...extra });
const catalog = { providers: [{ id: 'openai', label: 'OpenAI' }, { id: 'anthropic', label: 'Anthropic' }, { id: 'xai', label: 'xAI' }, { id: 'google', label: 'Google' }],
  tools: [{ id: 'codex', label: 'Codex (ChatGPT sign-in)', providers: ['openai'] }, { id: 'claude', label: 'Claude Code (Claude sign-in)', providers: ['anthropic'] }], places: ['cloud', 'agent-host', 'ssh-host'],
  subscriptionTerms: 'Check that your provider’s terms allow a personal subscription to run in a hosted sandbox before you upload one.', limit: 100 };
const glm = '@cf/zai-org/glm-5.3';
const builtIn = { id: 'workers-ai:' + glm, name: 'Workers AI · zai-org/glm-5.3', kind: 'cloudflare-model', provider: 'workers-ai', model: glm, tool: '', places: ['cloud'], scope: 'installation', ownerId: '', credential: null, enabled: true, builtIn: true, version: 0 };

async function backend(page: Page, { manage = true } = {}) {
  const state = { calls: [] as Record<string, unknown>[], credentials: [credential({ label: 'Personal Anthropic', lastUsedAt: at(-2), grants: [{ id: 'g1', granteeKind: 'user', granteeId: '43', grantee: 'sam', engines: [], places: ['cloud'], createdAt: at(-1) }] })],
    engines: [{ id: '5b2f7c1e-0000-4000-8000-000000000001', name: 'Claude Sonnet', kind: 'provider-model', provider: 'anthropic', model: 'claude-sonnet-4-5', tool: '', places: ['cloud'], scope: 'installation', ownerId: '',
      credential: { id: 'c-inst', label: 'Installation Anthropic', kind: 'api-key', state: 'active' }, enabled: true, builtIn: false, version: 1 }],
    selection: { engineId: '', allowOverride: false, version: 0, updatedAt: '' } };
  await page.route('**/rpc/**', async route => {
    const method = new URL(route.request().url()).pathname.split('/').at(-1)!;
    if (method === 'GetSession') return respond(route, GetSessionResponseSchema, { user: { id: '17', login: 'alex', isInstanceAdmin: true } });
    if (method === 'GetAuthenticationOptions') return respond(route, GetAuthenticationOptionsResponseSchema, {});
    if (method === 'ListCapabilities') return respond(route, ListCapabilitiesResponseSchema, { runtimeProfile: 'cloudflare-native', capabilities: [{ id: 'settings.credentials', label: 'Credential vault', state: 3, reason: 'Ready.' },
      { id: 'settings.engines', label: 'Engines', state: 3, reason: 'Ready.' }, { id: 'settings.ai-models', label: 'AI models', state: 3, reason: 'Ready.' }] });
    return reject(route, 'unimplemented', 'Fixture procedure not supplied.');
  });
  await page.route('**/native/**', async route => {
    const path = new URL(route.request().url()).pathname, body = (route.request().postDataJSON() || {}) as Record<string, unknown>;
    const json = (value: unknown, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(value) });
    if (path === '/native/config') return json({ runtimeProfile: 'cloudflare-native', workspace: 'alex', pipelines: false });
    if (path === '/native/credentials') {
      state.calls.push(body);
      const scope = String(body.scope || 'user');
      if (body.action === 'list') return json({ scope: { scope, ownerId: scope === 'user' ? '17' : scope === 'organization' ? '10' : '', label: scope }, credentials: scope === 'user' ? state.credentials : [credential({ scope, label: 'Acme OpenAI', provider: 'openai', fingerprint: '…9999' })],
        sharedWithYou: scope === 'user' ? [credential({ scope: 'installation', label: 'Installation Anthropic', ownerId: '' })] : [], canManage: manage, ready: true, reason: '', ...catalog });
      if (body.action === 'create') {
        const row = credential({ label: body.label, provider: body.provider, kind: body.kind, tool: body.tool || '', fingerprint: body.kind === 'api-key' ? '…' + String(body.value).slice(-4) : '', usable: body.kind === 'api-key',
          usableReason: body.kind === 'subscription' ? 'Stored only: cloud sandboxes are phase 3.' : '' });
        state.credentials.push(row);
        return json({ credential: row });
      }
      if (body.action === 'revoke') { const row = state.credentials.find(c => c.id === body.id)!; Object.assign(row, { state: 'revoked', revokedAt: at(0), usable: false }); return json({ credential: row }); }
      if (body.action === 'rotate') { const row = state.credentials.find(c => c.id === body.id)!; Object.assign(row, { version: 2, rotatedAt: at(0), fingerprint: '…' + String(body.value).slice(-4) }); return json({ credential: row }); }
      if (body.action === 'grant') { const row = state.credentials.find(c => c.id === body.id)!; (row.grants as unknown[]).push({ id: 'g2', granteeKind: body.granteeKind, granteeId: '9', grantee: body.grantee, engines: body.engines, places: body.places, createdAt: at(0) }); return json({ credential: row }); }
    }
    if (path === '/native/engines') {
      state.calls.push(body);
      const effective = state.selection.engineId ? { engineId: state.selection.engineId, engineName: 'Claude Sonnet', kind: 'provider-model', model: 'anthropic/claude-sonnet-4-5', source: 'installation', note: '', refusal: '' }
        : { engineId: builtIn.id, engineName: builtIn.name, kind: 'cloudflare-model', model: glm, source: 'default', note: '', refusal: '' };
      const uses = [{ use: 'review-drafts', label: 'Summaries and review drafts', detail: 'Pull request review drafts.', selectable: true, allowedHere: true, reason: '', selection: state.selection, effective },
        { use: 'triage', label: 'Issue triage', selectable: false, reason: 'Clef answers this constrained choice with calibrated probabilities; no other engine can.' }];
      const list = { scope: { scope: body.scope, label: 'installation' }, engines: body.scope === 'repository' ? [] : state.engines, builtIn: [builtIn], uses, selectable: [builtIn, ...state.engines], canManage: manage, canSelect: manage,
        credentials: [credential({ id: 'c-inst', scope: 'installation', label: 'Installation Anthropic' })], kinds: ['cloudflare-model', 'provider-model', 'coding-cli'], providers: catalog.providers,
        tools: [{ id: 'codex', label: 'Codex', signIn: '' }, { id: 'claude', label: 'Claude Code', signIn: '' }], places: catalog.places, workersAiModels: [glm], gateway: true };
      if (body.action === 'list') return json(list);
      if (body.action === 'select') { state.selection = { engineId: String(body.engineId), allowOverride: Boolean(body.allowOverride), version: 1, updatedAt: at(0) }; return json({ uses }); }
      if (body.action === 'create') { const engine = { id: '5b2f7c1e-0000-4000-8000-000000000002', name: body.name, kind: body.kind, provider: body.provider || '', model: body.model, tool: body.tool || '', places: body.places, scope: 'installation', ownerId: '', credential: { id: 'c-inst', label: 'Installation Anthropic', kind: 'api-key', state: 'active' }, enabled: true, builtIn: false, version: 1 };
        state.engines.push(engine as typeof state.engines[number]); return json({ engine }); }
    }
    return json({ code: 'unimplemented', message: 'Fixture route not supplied.' }, 501);
  });
  return state;
}

test('personal credentials lead with the inventory; Add API key seals a value that never comes back', async ({ page }) => {
  const state = await backend(page);
  await page.goto('/account/credentials');
  await expect(page.getByRole('heading', { name: 'Credentials and engines', level: 1 })).toBeVisible();
  await expect(page.getByRole('navigation', { name: 'Account settings' }).getByRole('link', { name: 'Credentials and engines' })).toHaveAttribute('aria-current', 'page');
  const table = page.getByRole('table', { name: 'credentials', exact: true });
  const row = table.getByRole('row').filter({ hasText: 'Personal Anthropic' });
  await expect(row).toContainText('…abcd'); await expect(row).toContainText('sam'); await expect(row).toContainText('Usable');
  await expect(page.getByRole('table', { name: 'credentials shared with you' })).toContainText('Installation Anthropic');
  // Forms open only on request.
  await expect(page.getByRole('form', { name: 'Add API key' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Add API key' }).click();
  const form = page.getByRole('form', { name: 'Add API key' });
  await form.getByLabel('Name', { exact: true }).fill('Work OpenAI');
  await form.getByRole('combobox', { name: /^Provider/ }).selectOption('openai');
  await expect(form.getByLabel('API key')).toHaveAttribute('type', 'password');
  await form.getByLabel('API key').fill('sk-proj-secret-value-wxyz');
  await form.getByRole('button', { name: 'Seal key' }).click();
  await expect(page.getByRole('status')).toContainText('Work OpenAI was added and sealed');
  await expect(page.getByRole('form', { name: 'Add API key' })).toHaveCount(0);
  await expect(table.getByRole('row').filter({ hasText: 'Work OpenAI' })).toContainText('…wxyz');
  await expect(page.getByText('sk-proj-secret-value-wxyz')).toHaveCount(0);
  expect(state.calls.find(call => call.action === 'create')).toMatchObject({ scope: 'user', kind: 'api-key', provider: 'openai', label: 'Work OpenAI', value: 'sk-proj-secret-value-wxyz', grants: [] });
  // Share and rotate open their own forms; revoke asks first.
  await table.getByRole('button', { name: 'Share Personal Anthropic' }).click();
  const share = page.getByRole('form', { name: 'Add a grant to Personal Anthropic' });
  await share.getByLabel('Login', { exact: true }).fill('jo');
  await share.getByRole('checkbox', { name: 'SSH hosts' }).uncheck();
  await share.getByRole('button', { name: 'Add grant' }).click();
  await expect(page.getByRole('status')).toContainText('The grant was saved');
  expect(state.calls.find(call => call.action === 'grant')).toMatchObject({ granteeKind: 'user', grantee: 'jo', places: ['cloud', 'agent-host'], engines: [] });
  await page.getByRole('button', { name: 'Done' }).click();
  await table.getByRole('button', { name: 'Rotate Personal Anthropic' }).click();
  await page.getByRole('form', { name: 'Rotate Personal Anthropic' }).getByLabel('New API key').fill('sk-ant-next-9876');
  await page.getByRole('form', { name: 'Rotate Personal Anthropic' }).getByRole('button', { name: 'Rotate' }).click();
  await expect(table.getByRole('row').filter({ hasText: 'Personal Anthropic' })).toContainText('…9876');
  page.once('dialog', dialog => void dialog.accept());
  await table.getByRole('button', { name: 'Revoke Personal Anthropic' }).click();
  await expect(table.getByRole('row').filter({ hasText: 'Personal Anthropic' })).toContainText('Revoked');
  await expect(table.getByRole('row').filter({ hasText: 'Personal Anthropic' })).toContainText('Destroyed');
});

test('a subscription sign-in shows the warning and terms note and cannot be sealed until the terms are confirmed', async ({ page }) => {
  const state = await backend(page);
  await page.goto('/account/credentials');
  await page.getByRole('button', { name: 'Add subscription sign-in' }).click();
  const form = page.getByRole('form', { name: 'Add subscription sign-in' });
  await expect(form.getByRole('note')).toContainText('signs in as you');
  await expect(form.getByRole('note')).toContainText('provider’s terms');
  await expect(form.getByRole('note')).toContainText('not available yet');
  await form.getByLabel('Name', { exact: true }).fill('My ChatGPT');
  await form.getByLabel('Or paste the file’s contents').fill('{"tokens":{"refresh_token":"rt-secret"}}');
  await expect(form.getByRole('button', { name: 'Seal sign-in' })).toBeDisabled();
  await form.getByRole('checkbox', { name: /I checked my provider’s terms/ }).check();
  await form.getByRole('button', { name: 'Seal sign-in' }).click();
  const row = page.getByRole('table', { name: 'credentials', exact: true }).getByRole('row').filter({ hasText: 'My ChatGPT' });
  await expect(row).toContainText('Stored'); await expect(row).toContainText('cloud sandboxes are phase 3');
  expect(state.calls.find(call => call.action === 'create')).toMatchObject({ kind: 'subscription', tool: 'codex', provider: 'openai', acceptTerms: true });
  await expect(page.getByText('rt-secret')).toHaveCount(0);
});

test('admin engines: the engine for each use, an explicit Edit to choose one, and New engine with a vault key', async ({ page }) => {
  const state = await backend(page);
  await page.goto('/admin/engines');
  await expect(page.getByRole('heading', { name: 'Engines', level: 1 })).toBeVisible();
  const uses = page.getByRole('table', { name: 'AI uses' });
  await expect(uses.getByRole('row').filter({ hasText: 'Summaries and review drafts' })).toContainText('AI models default');
  await expect(uses.getByRole('row').filter({ hasText: 'Issue triage' })).toContainText('Clef');
  await expect(page.getByRole('link', { name: 'AI models' }).first()).toBeVisible();
  await expect(page.getByRole('table', { name: 'engines', exact: true }).getByRole('row').filter({ hasText: 'Claude Sonnet' })).toContainText('Installation Anthropic');
  await expect(page.getByRole('form', { name: /Choose the engine/ })).toHaveCount(0);
  await uses.getByRole('button', { name: 'Choose the engine for Summaries and review drafts' }).click();
  const choose = page.getByRole('form', { name: 'Choose the engine for Summaries and review drafts' });
  await choose.getByRole('combobox', { name: /^Engine/ }).selectOption({ label: 'Claude Sonnet (Provider model, Anthropic)' });
  await choose.getByRole('checkbox', { name: /Organizations and their repositories may choose/ }).check();
  await choose.getByRole('button', { name: 'Save engine' }).click();
  await expect(page.getByRole('status')).toContainText('Summaries and review drafts: Claude Sonnet');
  expect(state.calls.find(call => call.action === 'select')).toMatchObject({ scope: 'installation', use: 'review-drafts', engineId: '5b2f7c1e-0000-4000-8000-000000000001', allowOverride: true, expectedVersion: 0 });
  await expect(uses.getByRole('row').filter({ hasText: 'Summaries and review drafts' })).toContainText('anthropic/claude-sonnet-4-5');
  await page.getByRole('button', { name: 'New engine' }).click();
  const form = page.getByRole('form', { name: 'New engine' });
  await form.getByLabel('Name', { exact: true }).fill('Claude Haiku');
  await form.getByRole('combobox', { name: /^Kind/ }).selectOption('provider-model');
  await form.getByRole('combobox', { name: /^Provider/ }).selectOption('anthropic');
  await form.getByLabel('Model', { exact: true }).fill('claude-haiku-4-5');
  await form.getByRole('combobox', { name: /^Credential/ }).selectOption({ label: 'Installation Anthropic (API key …abcd)' });
  await form.getByRole('button', { name: 'Add engine' }).click();
  await expect(page.getByRole('table', { name: 'engines', exact: true })).toContainText('Claude Haiku');
  expect(state.calls.find(call => call.action === 'create')).toMatchObject({ scope: 'installation', kind: 'provider-model', provider: 'anthropic', model: 'claude-haiku-4-5', credentialId: 'c-inst', places: ['cloud'] });
});

test('organization members read credential labels without Add, Rotate or Revoke', async ({ page }) => {
  await backend(page, { manage: false });
  await page.goto('/organizations/acme/settings/credentials');
  await expect(page.getByRole('heading', { name: 'Credentials', level: 1 })).toBeVisible();
  await expect(page.getByRole('table', { name: 'credentials', exact: true })).toContainText('Acme OpenAI');
  await expect(page.getByRole('button', { name: 'Add API key' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: /Revoke/ })).toHaveCount(0);
  await expect(page.getByText('Organization owners manage these credentials')).toBeVisible();
  await expect(page.getByRole('navigation', { name: 'Organization settings' }).getByRole('link', { name: 'Engines' })).toBeVisible();
});
