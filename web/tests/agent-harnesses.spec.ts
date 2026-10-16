import { disabledAgentUsage } from './rpc';
import { test, expect } from '@playwright/test';
import { create } from '@bufbuild/protobuf';
import { CodexConnectionSchema, CodexConnectionState, CodexConnectionScope, CodexLoginMethod, GetCodexConnectionRequestSchema, GetCodexConnectionResponseSchema, StartCodexLoginRequestSchema, StartCodexLoginResponseSchema, CompleteAgentLoginRequestSchema, CompleteAgentLoginResponseSchema, RefreshCodexConnectionRequestSchema, RefreshCodexConnectionResponseSchema, DisconnectCodexConnectionRequestSchema, DisconnectCodexConnectionResponseSchema, GetSessionResponseSchema, UserSchema, ListCodexConnectionsResponseSchema } from '../src/gen/golf/v1/golf_pb';
import { respond, request, reject } from './rpc';

test('Claude native browser code and OpenCode providers remain separate and keep credentials out of rows', async ({ page }) => {
 const rows = new Map<string, ReturnType<typeof create<typeof CodexConnectionSchema>>>();
 const starts: ReturnType<typeof request<typeof StartCodexLoginRequestSchema>>[] = [];
 const completions: ReturnType<typeof request<typeof CompleteAgentLoginRequestSchema>>[] = [];
 await page.route('**/rpc/**', route => {
  const method = new URL(route.request().url()).pathname.split('/').at(-1);
 if(method === 'GetAgentUsage') return disabledAgentUsage(route);
  if (method === 'GetSession') return respond(route, GetSessionResponseSchema, { user: create(UserSchema, { id: '42', login: 'alex' }) });
  if (method === 'ListCodexConnections') return respond(route, ListCodexConnectionsResponseSchema, { connections: [] });
  if (method === 'GetCodexConnection') {
   const input = request(route, GetCodexConnectionRequestSchema); const key = `${input.harness || 'codex'}:${input.provider || 'openai'}`;
   return respond(route, GetCodexConnectionResponseSchema, { connection: input.connectionId ? [...rows.values()].find(row => row.id === input.connectionId) : rows.get(key) || create(CodexConnectionSchema, { harness: input.harness, provider: input.provider, version: '0', state: CodexConnectionState.UNCONFIGURED }) });
  }
  if (method === 'StartCodexLogin') {
   const input = request(route, StartCodexLoginRequestSchema); starts.push(input); const key = `${input.harness}:${input.provider}`;
   const row = create(CodexConnectionSchema, { id: key, name: `Personal ${input.harness}`, harness: input.harness, provider: input.provider, version: '1', scope: CodexConnectionScope.PERSONAL, canManage: true, canUse: true, state: input.method === CodexLoginMethod.BROWSER_CODE ? CodexConnectionState.AWAITING_AUTH : CodexConnectionState.CONNECTED, authMethod: input.method, ...(input.method === CodexLoginMethod.BROWSER_CODE ? { loginId: 'native-login-42', verificationUrl: 'https://claude.com/cai/oauth/authorize?state=fixture&code_challenge=fixture', loginExpiresAt: new Date(Date.now() + 600000).toISOString() } : {}) }); rows.set(key, row);
   return respond(route, StartCodexLoginResponseSchema, { connection: row });
  }
  if (method === 'CompleteAgentLogin') {
   const input = request(route, CompleteAgentLoginRequestSchema); completions.push(input); const prior = rows.get(input.connectionId)!;
   const row = create(CodexConnectionSchema, { ...prior, version: '2', state: CodexConnectionState.CONNECTED, loginId: '', verificationUrl: '', loginExpiresAt: '', email: 'claude-owner@example.test', planType: 'fixture-plan' }); rows.set(input.connectionId, row);
   return respond(route, CompleteAgentLoginResponseSchema, { connection: row });
  }
  if (method === 'RefreshCodexConnection') { const input = request(route, RefreshCodexConnectionRequestSchema); return respond(route, RefreshCodexConnectionResponseSchema, { connection: rows.get(input.connectionId), usage: { available: false, reason: 'Usage is not reported by this account adapter.' } }); }
  if (method === 'DisconnectCodexConnection') { const input = request(route, DisconnectCodexConnectionRequestSchema); const row = create(CodexConnectionSchema, { ...rows.get(input.connectionId)!, state: CodexConnectionState.UNCONFIGURED, version: '2' }); rows.set(input.connectionId, row); return respond(route, DisconnectCodexConnectionResponseSchema, { connection: row }); }
  return reject(route, 'unimplemented', 'Unsupported fixture');
 });
 await page.goto('/account/agents');
 await page.getByRole('button', { name: 'Connect Claude Code', exact: true }).click();
 const editor = page.getByRole('form', { name: 'Connect Claude Code' }); await expect(editor.getByLabel('Authentication method')).toHaveValue(String(CodexLoginMethod.BROWSER_CODE)); await editor.getByRole('button', { name: 'Continue' }).click();
 await expect(page.getByRole('link', { name: 'Open official Claude login' })).toHaveAttribute('href', /^https:\/\/claude.com\/cai\/oauth\/authorize\?/);
 await page.getByLabel('Authorization code').fill('private-fixture-code'); await page.getByRole('button', { name: 'Complete sign-in' }).click(); await expect(page.getByRole('dialog')).toContainText('claude-owner@example.test'); expect(completions[0]!.loginId).toBe('native-login-42'); await expect(page.getByText('private-fixture-code')).toHaveCount(0); await page.keyboard.press('Escape');
 await page.getByLabel('OpenCode provider', { exact: true }).selectOption('anthropic'); await page.getByRole('button', { name: 'Connect OpenCode', exact: true }).click();
 const open = page.getByRole('form', { name: 'Connect OpenCode' }); await expect(open.getByLabel('Authentication method').locator('option')).toHaveCount(1); await open.getByLabel('Provider API key').fill('private-fixture-provider-key'); await open.getByRole('button', { name: 'Continue' }).click(); await expect(page.getByRole('table', { name: 'OpenCode connections', exact: true })).toContainText('Configured');
 expect(starts[1]!.provider).toBe('anthropic'); expect(starts[1]!.harness).toBe('opencode'); expect(starts[0]!.apiKey).toBe(''); await expect(page.getByRole('table', { name: 'Claude Code connections', exact: true })).toContainText('claude-owner@example.test');
 await expect(page.getByText('private-fixture-provider-key')).toHaveCount(0); expect(await page.evaluate(() => JSON.stringify({ ...localStorage, ...sessionStorage }))).not.toContain('private-fixture');
 await page.getByLabel('OpenCode provider', { exact: true }).selectOption('openai'); await expect(page.getByRole('table', { name: 'OpenCode connections', exact: true })).toContainText('Not connected'); await expect(page.getByRole('table', { name: 'Claude Code connections', exact: true })).toContainText('Authenticated');
});
