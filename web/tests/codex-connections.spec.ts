import { disabledAgentUsage } from './rpc';
import { expect, test, type Page } from '@playwright/test';
import { create } from '@bufbuild/protobuf';
import { CodexConnectionScope, CreateCodexConnectionRequestSchema, CreateCodexConnectionResponseSchema, SetCodexConnectionAccessRequestSchema, SetCodexConnectionAccessResponseSchema, ListLocalAccountsResponseSchema, LocalAccountInfoSchema, ListCodexConnectionsResponseSchema, CodexConnectionSchema, CodexConnectionState, CodexLoginMethod, GetCodexConnectionRequestSchema, GetCodexConnectionResponseSchema, StartCodexLoginRequestSchema, StartCodexLoginResponseSchema, CancelCodexLoginRequestSchema, CancelCodexLoginResponseSchema, RefreshCodexConnectionRequestSchema, RefreshCodexConnectionResponseSchema, DisconnectCodexConnectionRequestSchema, DisconnectCodexConnectionResponseSchema, GetSessionResponseSchema, UserSchema, GetAuthenticationOptionsResponseSchema, ListCapabilitiesResponseSchema, CapabilitySchema, CapabilityState } from '../src/gen/golf/v1/golf_pb';
import { reject, request, respond } from './rpc';
const waiting = () => create(CodexConnectionSchema, { state: CodexConnectionState.AWAITING_AUTH, version: '1', authMethod: CodexLoginMethod.CHATGPT_DEVICE, loginId: 'test-login-id', verificationUrl: 'https://auth.openai.com/codex/device', userCode: 'TEST-1234', loginExpiresAt: new Date(Date.now() + 600_000).toISOString(), reasonCode: 'awaiting_device_approval' });
const connected = () => create(CodexConnectionSchema, { state: CodexConnectionState.CONNECTED, version: '2', authMethod: CodexLoginMethod.CHATGPT_DEVICE, email: 'owner@example.test', planType: 'test-plan', checkedAt: new Date().toISOString(), modelVerified: false });
async function backend(page: Page, admin = false) {
  const state = { row: create(CodexConnectionSchema, { state: CodexConnectionState.UNCONFIGURED, version: '0' }), starts: [] as ReturnType<typeof request<typeof StartCodexLoginRequestSchema>>[], cancels: [] as ReturnType<typeof request<typeof CancelCodexLoginRequestSchema>>[], disconnects: [] as ReturnType<typeof request<typeof DisconnectCodexConnectionRequestSchema>>[], usage: undefined as { available: boolean; checkedAt: string; bankedResets?: number; buckets: { id: string; primary?: { usedPercent: number; windowDurationMins?: number; resetsAt: string } }[] } | undefined, checks: [] as ReturnType<typeof request<typeof RefreshCodexConnectionRequestSchema>>[], instances: [] as ReturnType<typeof create<typeof CodexConnectionSchema>>[], creates: [] as ReturnType<typeof request<typeof CreateCodexConnectionRequestSchema>>[], accessWrites: [] as ReturnType<typeof request<typeof SetCodexConnectionAccessRequestSchema>>[], inventoryDenied: false, gets: 0, denied: false, dropped: false, malformed: false, barrier: undefined as Promise<void> | undefined, readBarrier: undefined as Promise<void> | undefined, logoutFailed: false };
  await page.route('**/rpc/**', async route => {
    const method = new URL(route.request().url()).pathname.split('/').at(-1);
 if(method === 'GetAgentUsage') return disabledAgentUsage(route);
    if (method === 'GetAuthenticationOptions') return respond(route, GetAuthenticationOptionsResponseSchema, { localPasswordEnabled: true });
    if (method === 'GetSession') return respond(route, GetSessionResponseSchema, { user: create(UserSchema, { id: '42', login: 'alex', isInstanceAdmin: admin }) });
    if (method === 'ListCapabilities') return respond(route, ListCapabilitiesResponseSchema, { capabilities: [create(CapabilitySchema, { id: 'agents.codex', label: 'Codex', state: CapabilityState.DISABLED, reason: 'Authentication setup available; execution unavailable.' })] });
    if (method === 'ListCodexConnections') return state.inventoryDenied ? reject(route, 'permission_denied', 'Hidden inventory details.') : respond(route, ListCodexConnectionsResponseSchema, { connections: state.instances });
    if (method === 'ListLocalAccounts') return respond(route, ListLocalAccountsResponseSchema, { accounts: [create(LocalAccountInfoSchema, { id: 'local-id-777', golfUserId: 'golf-id-17', nativeUserId: 'native-id-99', username: 'selected-user', email: 'selected@example.test' }), create(LocalAccountInfoSchema, { id: 'disabled-account', golfUserId: 'golf-id-disabled', username: 'disabled-user', disabled: true })] });
    if (method === 'CreateCodexConnection') { const input = request(route, CreateCodexConnectionRequestSchema); state.creates.push(input); const connection = create(CodexConnectionSchema, { id: 'instance-1', name: input.name, scope: CodexConnectionScope.INSTANCE, canManage: true, canUse: false, state: CodexConnectionState.UNCONFIGURED, version: '1' }); state.instances = [connection]; return respond(route, CreateCodexConnectionResponseSchema, { connection }); }
    if (method === 'SetCodexConnectionAccess') { const input = request(route, SetCodexConnectionAccessRequestSchema); state.accessWrites.push(input); const instance = state.instances.find(connection => connection.id === input.connectionId); const connection = create(CodexConnectionSchema, { ...(instance || state.row), name: input.name, allowedUserIds: input.allowedUserIds, version: String(BigInt(input.expectedVersion) + 1n) }); if (instance) state.instances = [connection]; else state.row = connection; return respond(route, SetCodexConnectionAccessResponseSchema, { connection }); }
    if (method === 'GetCodexConnection') { const input = request(route, GetCodexConnectionRequestSchema); if (!input.connectionId && input.harness && input.harness !== 'codex') return respond(route, GetCodexConnectionResponseSchema, { connection: create(CodexConnectionSchema, { state: CodexConnectionState.UNAVAILABLE, version: '0', harness: input.harness, provider: input.provider }) }); state.gets++; if (state.readBarrier) await state.readBarrier; return state.denied ? reject(route, 'permission_denied', 'Hidden private provider diagnostics.') : respond(route, GetCodexConnectionResponseSchema, { connection: admin && state.instances[0] ? state.instances[0] : state.row }); }
    if (method === 'StartCodexLogin') {
      const input = request(route, StartCodexLoginRequestSchema); state.starts.push(input);
      if (state.denied) return reject(route, 'permission_denied', 'Hidden private provider diagnostics.');
      state.row = input.method === CodexLoginMethod.CHATGPT_DEVICE ? waiting() : create(CodexConnectionSchema, { state: CodexConnectionState.CONNECTED, version: '1', authMethod: CodexLoginMethod.API_KEY, checkedAt: new Date().toISOString(), modelVerified: false });
      state.row.version = String(BigInt(input.expectedVersion) + 1n);
      if (input.connectionId) { const profile = state.instances.find(connection => connection.id === input.connectionId)!; state.row = create(CodexConnectionSchema, { ...state.row, id: profile.id, name: profile.name, scope: profile.scope, canManage: profile.canManage, canUse: profile.canUse, allowedUserIds: profile.allowedUserIds }); state.instances = [state.row]; }
      if (state.barrier) await state.barrier;
      if (state.dropped) return route.abort('failed');
      const row = state.malformed ? { ...state.row, verificationUrl: 'https://attacker.test/device' } : state.row;
      return respond(route, StartCodexLoginResponseSchema, { connection: row }).catch(() => {});
    }
    if (method === 'CancelCodexLogin') { state.cancels.push(request(route, CancelCodexLoginRequestSchema)); state.row = create(CodexConnectionSchema, { state: CodexConnectionState.UNCONFIGURED, version: '2' }); return respond(route, CancelCodexLoginResponseSchema, { connection: state.row }); }
    if (method === 'RefreshCodexConnection') { state.checks.push(request(route, RefreshCodexConnectionRequestSchema)); state.row = connected(); return respond(route, RefreshCodexConnectionResponseSchema, { connection: state.row, usage: state.usage }); }
    if (method === 'DisconnectCodexConnection') { state.disconnects.push(request(route, DisconnectCodexConnectionRequestSchema)); state.row = create(CodexConnectionSchema, { state: CodexConnectionState.UNCONFIGURED, version: '3' }); return respond(route, DisconnectCodexConnectionResponseSchema, { connection: state.row }); }
    if (method === 'Logout') return state.logoutFailed ? reject(route, 'unavailable', 'Sign-out could not be completed.') : route.fulfill({ contentType: 'application/json', body: '{}' });
    return reject(route, 'not_found', 'Unsupported Codex fixture.');
  }); return state;
}
test('agent settings has compact current inventory, explicit Connect and status setup navigation', async ({ page }) => {
  await backend(page); await page.goto('/account/agents'); await expect(page.getByRole('table', { name: 'Coding agent connections', exact: true })).toContainText('Not connected');
  await expect(page.locator('input[type=password]')).toHaveCount(0); await expect(page.getByRole('form', { name: 'Connect Codex' })).toHaveCount(0); await expect(page.getByRole('navigation', { name: 'Account settings' }).getByRole('link', { name: 'Coding agents' })).toHaveAttribute('aria-current', 'page');
  await page.goto('/status'); const row = page.getByRole('table', { name: 'Coding agents', exact: true }).getByRole('row').filter({ hasText: 'Codex' }); await expect(row).toContainText('disabled'); await row.getByRole('link', { name: 'Manage Codex connection', exact: true }).click(); await expect(page).toHaveURL(/\/account\/agents$/);
});
test('device login displays only official link, polls into real account details and cancels exact observed login', async ({ page }) => {
  const state = await backend(page); await page.goto('/account/agents'); await page.getByRole('button', { name: 'Connect Codex', exact: true }).click(); await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await expect(page.getByRole('link', { name: 'Open official ChatGPT device login' })).toHaveAttribute('href', 'https://auth.openai.com/codex/device'); await expect(page.getByText('TEST-1234', { exact: true })).toBeVisible(); expect(state.starts[0]!.expectedVersion).toBe('0'); expect(state.starts[0]!.apiKey).toBe('');
  let releaseRead!: () => void; state.readBarrier = new Promise<void>(resolve => { releaseRead = resolve; }); await expect.poll(() => state.gets).toBeGreaterThan(1); await expect(page.getByText('TEST-1234', { exact: true })).toBeVisible(); state.row = connected(); state.readBarrier = undefined; releaseRead(); await expect(page.getByRole('table', { name: 'Coding agent connections', exact: true })).toContainText('owner@example.test'); await expect(page.getByText('TEST-1234', { exact: true })).toHaveCount(0);  await expect(page.getByRole('table', { name: 'Coding agent connections', exact: true })).toContainText('Authenticated');
  if (await page.getByRole('button', { name: 'Close details', exact: true }).count()) await page.getByRole('button', { name: 'Close details', exact: true }).click(); await page.getByRole('button', { name: 'Reconnect Codex', exact: true }).click(); await page.getByRole('button', { name: 'Continue', exact: true }).click(); await page.getByRole('button', { name: 'Cancel login', exact: true }).click(); expect(state.cancels[0]!.loginId).toBe('test-login-id'); expect(state.cancels[0]!.expectedVersion).toBe('3'); await expect(page.getByText('TEST-1234', { exact: true })).toHaveCount(0);
});
test('API key clears at submit and cancel, never appears in inventory, storage or a URL', async ({ page }) => {
  const state = await backend(page); let release!: () => void; state.barrier = new Promise<void>(resolve => { release = resolve; }); await page.goto('/account/agents'); await page.getByRole('button', { name: 'Connect Codex', exact: true }).click(); await page.getByLabel('Authentication method', { exact: true }).selectOption(String(CodexLoginMethod.API_KEY)); await page.getByLabel('OpenAI API key', { exact: true }).fill('test-private-not-a-real-key'); await page.getByRole('button', { name: 'Continue', exact: true }).click(); await expect.poll(() => state.starts.length).toBe(1); await expect(page.getByLabel('OpenAI API key', { exact: true })).toHaveValue(''); release();
  await expect(page.getByRole('table', { name: 'Coding agent connections', exact: true })).toContainText('Configured'); await page.getByRole('button', { name: 'Connection details', exact: true }).click(); await expect(page.getByRole('dialog')).toContainText('API key'); await expect(page.getByText('test-private-not-a-real-key', { exact: false })).toHaveCount(0); expect(page.url()).not.toContain('test-private'); expect(await page.evaluate(() => JSON.stringify({ ...localStorage, ...sessionStorage }))).not.toContain('test-private');
  if (await page.getByRole('button', { name: 'Close details', exact: true }).count()) await page.getByRole('button', { name: 'Close details', exact: true }).click(); await page.getByRole('button', { name: 'Reconnect Codex', exact: true }).click(); await page.getByLabel('Authentication method', { exact: true }).selectOption(String(CodexLoginMethod.API_KEY)); await expect(page.getByLabel('OpenAI API key', { exact: true })).toHaveValue(''); await page.getByLabel('OpenAI API key', { exact: true }).fill('cancel-private-key'); await page.getByRole('button', { name: 'Cancel', exact: true }).click(); await expect(page.getByLabel('OpenAI API key', { exact: true })).toHaveCount(0); expect(state.starts).toHaveLength(1);
});
test('unknown login outcome is inspected without automatic resubmission and unsafe provider links are hidden', async ({ page }) => {
  const state = await backend(page); state.malformed = true; await page.goto('/account/agents'); await page.getByRole('button', { name: 'Connect Codex', exact: true }).click(); await page.getByRole('button', { name: 'Continue', exact: true }).click(); await expect(page.getByRole('alert')).toContainText('could not be confirmed'); await expect(page.getByRole('link', { name: 'Open official ChatGPT device login' })).toHaveCount(0); expect(state.starts).toHaveLength(1);
  await page.getByRole('button', { name: 'Refresh connection', exact: true }).click(); await page.getByRole('button', { name: 'Connection details', exact: true }).click(); await expect(page.getByText('TEST-1234', { exact: true })).toBeVisible(); expect(state.starts).toHaveLength(1);
});
test('disconnect confirmation preserves original revision; provider refresh never verifies model execution', async ({ page }) => {
  const state = await backend(page); state.row = connected(); await page.goto('/account/agents'); await page.getByRole('button', { name: 'Connection details', exact: true }).click(); await page.getByRole('button', { name: 'Refresh plan and usage', exact: true }).click(); await expect.poll(() => state.checks.length).toBe(1); expect(state.checks[0]!.expectedVersion).toBe('2'); await expect(page.getByRole('dialog').getByText('Authentication does not verify model access or enable task execution.', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Close details', exact: true }).click(); await page.getByRole('button', { name: 'Disconnect Codex', exact: true }).click(); await page.getByRole('dialog').getByRole('button', { name: 'Cancel', exact: true }).click(); expect(state.disconnects).toHaveLength(0); await page.getByRole('button', { name: 'Disconnect Codex', exact: true }).click(); await page.getByRole('button', { name: 'Confirm disconnect Codex', exact: true }).click(); expect(state.disconnects[0]!.expectedVersion).toBe('2'); await expect(page.getByRole('table', { name: 'Coding agent connections', exact: true })).toContainText('Not connected');
});
test('pagehide, permission denial and failed logout clear private state and ignore late login receipts', async ({ page }) => {
  const state = await backend(page); await page.goto('/account/agents'); await page.getByRole('button', { name: 'Connect Codex', exact: true }).click(); await page.getByLabel('Authentication method', { exact: true }).selectOption(String(CodexLoginMethod.API_KEY)); await page.getByLabel('OpenAI API key', { exact: true }).fill('private-draft-key'); await page.evaluate(() => window.dispatchEvent(new Event('pagehide'))); await expect(page.getByLabel('OpenAI API key', { exact: true })).toHaveCount(0); await page.getByRole('button', { name: 'Refresh connection', exact: true }).click();
  state.denied = true; await page.getByRole('button', { name: 'Refresh connection', exact: true }).click(); await expect(page.getByRole('table', { name: 'Coding agent connections', exact: true })).toHaveCount(0); await expect(page.getByText('Hidden private provider diagnostics.', { exact: true })).toHaveCount(0);
  state.denied = false; await page.getByRole('button', { name: 'Refresh connection', exact: true }).click(); let release!: () => void; state.barrier = new Promise<void>(resolve => { release = resolve; }); state.logoutFailed = true; await page.getByRole('button', { name: 'Connect Codex', exact: true }).click(); await page.getByRole('button', { name: 'Continue', exact: true }).click(); await expect.poll(() => state.starts.length).toBe(1); await page.getByLabel('Your account', { exact: true }).click(); await page.getByRole('button', { name: 'Sign out', exact: true }).click(); await expect(page.getByText('Sign-out could not be completed.', { exact: true })).toBeVisible(); release(); await expect(page.getByText('TEST-1234', { exact: true })).toHaveCount(0); await expect(page.getByRole('form', { name: 'Connect Codex' })).toHaveCount(0);
});
test('unavailable runtime exposes honest read-only state and compact mobile bounds', async ({ page }) => {
  const state = await backend(page); state.row = create(CodexConnectionSchema, { state: CodexConnectionState.UNAVAILABLE, version: '0', reasonCode: 'runtime_unavailable' }); await page.setViewportSize({ width: 320, height: 860 }); await page.goto('/account/agents'); await expect(page.getByRole('table', { name: 'Coding agent connections', exact: true })).toContainText('Unavailable'); await expect(page.getByRole('button', { name: 'Connect Codex', exact: true })).toHaveCount(0); await expect(page.getByText('OpenCode providers', { exact: true })).toBeVisible(); expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});


test('instance admin creates a named connection and grants immutable Golf user access through explicit editors', async ({ page }) => {
  const state = await backend(page, true); await page.goto('/admin/agents');
  await expect(page.getByRole('navigation', { name: 'Instance administration' }).getByRole('link', { name: 'Coding agents' })).toHaveAttribute('aria-current', 'page');
  await expect(page.getByRole('form')).toHaveCount(0);
  await page.getByRole('button', { name: 'New agent connection', exact: true }).click(); await page.getByLabel('Connection name', { exact: true }).fill('Team engineering'); await page.getByRole('button', { name: 'Create connection', exact: true }).click();
  await expect(page.getByRole('table', { name: 'Instance agent connections', exact: true })).toContainText('Team engineering'); expect(state.creates[0]!.name).toBe('Team engineering');
  await expect(page.getByRole('form')).toHaveCount(0); await page.getByRole('button', { name: 'Edit name and access', exact: true }).click();
  await expect(page.getByLabel('Allow disabled-user')).toBeDisabled(); await page.getByLabel('Allow selected-user').check(); await page.getByRole('button', { name: 'Save connection access', exact: true }).click();
  await expect(page.getByRole('table', { name: 'Instance agent connections', exact: true })).toContainText('1 selected users'); expect(state.accessWrites[0]!.connectionId).toBe('instance-1'); expect(state.accessWrites[0]!.expectedVersion).toBe('1'); expect(state.accessWrites[0]!.allowedUserIds).toEqual(['golf-id-17']);
  await page.getByRole('button', { name: 'Manage authentication', exact: true }).click(); await expect(page.getByRole('button', { name: 'Connect Codex', exact: true })).toBeVisible();
  // An admin can manage authentication without receiving implicit use permission.
  expect(state.instances[0]!.canUse).toBe(false); await page.getByRole('button', { name: 'Connect Codex', exact: true }).click(); await page.getByRole('button', { name: 'Continue', exact: true }).click(); await expect(page.getByText('TEST-1234', { exact: true })).toBeVisible(); expect(state.starts[0]!.connectionId).toBe('instance-1'); expect(state.starts[0]!.expectedVersion).toBe('2');
  await page.getByRole('button', { name: 'Close details', exact: true }).click(); state.inventoryDenied = true; await page.getByRole('button', { name: 'Refresh connections', exact: true }).click(); await expect(page.getByRole('table', { name: 'Instance agent connections', exact: true })).toHaveCount(0); await expect(page.getByRole('button', { name: 'Connect Codex', exact: true })).toHaveCount(0); await expect(page.getByText('Hidden inventory details.', { exact: true })).toHaveCount(0);
});

test('personal shared inventory is metadata only and rejects leaked native challenges', async ({ page }) => {
  const state = await backend(page); state.instances = [create(CodexConnectionSchema, { id: 'shared-17', name: 'Allowed team account', scope: CodexConnectionScope.INSTANCE, canManage: false, canUse: true, state: CodexConnectionState.CONNECTED, version: '3', email: 'team@example.test', planType: 'team' })];
  await page.goto('/account/agents'); const shared = page.getByRole('table', { name: 'Available instance connections', exact: true }); await expect(shared).toContainText('Allowed team account'); await expect(shared).toContainText('team@example.test'); await expect(shared.locator('tbody').getByRole('button')).toHaveCount(1); await shared.getByRole('button', { name: 'Shared connection details' }).click(); await expect(page.getByRole('dialog')).toContainText('Allowed team account'); await page.keyboard.press('Escape');
  state.instances[0]!.state = CodexConnectionState.AWAITING_AUTH; state.instances[0]!.loginId = 'private-id'; state.instances[0]!.userCode = 'SECRET-1234'; state.instances[0]!.verificationUrl = 'https://auth.openai.com/codex/device'; state.instances[0]!.loginExpiresAt = new Date(Date.now() + 600_000).toISOString();
  await page.getByRole('button', { name: 'Refresh shared connections', exact: true }).click(); await expect(shared).toHaveCount(0); await expect(page.getByText('SECRET-1234', { exact: true })).toHaveCount(0); await expect(page.getByRole('link', { name: 'Open official ChatGPT device login' })).toHaveCount(0);
});

test('provider quota snapshots show plan, remaining percentages, reset time and known-zero banked resets', async ({ page }) => {
 const state = await backend(page); state.row = connected();
 state.usage = { available: true, checkedAt: new Date().toISOString(), bankedResets: 0, buckets: [{ id: 'codex', primary: { usedPercent: 25, windowDurationMins: 300, resetsAt: new Date(Date.now() + 3600000).toISOString() } }] };
 await page.goto('/account/agents');
 await page.getByRole('button', { name: 'Connection details', exact: true }).click();
 await page.getByRole('button', { name: 'Refresh plan and usage' }).click();
 const panel = page.getByRole('region', { name: 'Codex plan and usage' });
 await expect(panel).toContainText('75% remaining'); await expect(panel).toContainText('5-hour window'); await expect(panel).toContainText('Resets in'); await expect(panel).toContainText('Banked resets: 0');
 state.usage = { ...state.usage, bankedResets: undefined };
 await page.getByRole('button', { name: 'Refresh plan and usage' }).click();
 await expect(panel).toContainText('Banked resets: Not reported');
 await page.evaluate(() => window.dispatchEvent(new Event('pagehide')));
 await expect(page.getByText('75% remaining')).toHaveCount(0);
});

test('shared page stack gives panels consistent desktop and mobile section gaps', async ({ page }) => {
 await backend(page); await page.goto('/account/agents');
 await expect(page.getByRole('region', { name: 'Codex account connection', exact: true })).toBeVisible();
 // The gap is the shared --section-gap token (16px at every width since fa4dbd3), not a page-specific value.
 for (const width of [1440, 390]) {
  await page.setViewportSize({ width, height: 1000 });
  const bounds = await page.evaluate(() => {
   const panel = document.querySelector('[aria-label="Codex account connection"]')!.getBoundingClientRect();
   const other = document.querySelector('[aria-label="Claude Code account connection"]')!.getBoundingClientRect();
   return { gap: other.top-panel.bottom, token: Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--section-gap')), body: document.documentElement.scrollWidth, viewport: window.innerWidth };
  });
  expect(bounds.token).toBeGreaterThan(0); expect(bounds.gap).toBe(bounds.token); expect(bounds.body).toBeLessThanOrEqual(bounds.viewport);
 }
});

 test('compact icons open read-only details with focus return and rename through an explicit editor', async ({ page }) => {
  const state = await backend(page); state.row = create(CodexConnectionSchema, { ...connected(), id: 'personal-42', name: 'My Codex', scope: CodexConnectionScope.PERSONAL, canManage: true });
  await page.goto('/account/agents'); const table = page.getByRole('table', { name: 'Coding agent connections', exact: true });
  await expect(page.getByRole('region', { name: 'Codex plan and usage' })).toHaveCount(0);
  const details = table.getByRole('button', { name: 'Connection details', exact: true }); await details.click();
  await expect(page.getByRole('dialog', { name: 'My Codex' })).toBeVisible(); const box = await page.getByRole('dialog', { name: 'My Codex' }).boundingBox(); expect(box!.y).toBeGreaterThan(0); await expect(page.getByRole('dialog').getByRole('form')).toHaveCount(0); await page.keyboard.press('Escape'); await expect(details).toBeFocused();
  await table.getByRole('button', { name: 'Rename connection', exact: true }).click(); await expect(page.getByRole('dialog')).toHaveCount(0); await page.getByLabel('Connection name', { exact: true }).fill('Work Codex'); await page.getByRole('button', { name: 'Save connection name' }).click();
  await expect(table).toContainText('Work Codex'); expect(state.accessWrites[0]!.connectionId).toBe('personal-42'); expect(state.accessWrites[0]!.allowedUserIds).toEqual([]); await expect(page.getByRole('form', { name: 'Rename agent connection' })).toHaveCount(0);
 });
