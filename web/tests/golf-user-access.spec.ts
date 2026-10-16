import { portableRuntimeFixture } from './runtime-fixture';
import { test, expect, type Page } from '@playwright/test';
import { create } from '@bufbuild/protobuf';
import { GetAuthenticationOptionsResponseSchema, GetSessionResponseSchema, ListCapabilitiesResponseSchema, ListLocalAccountsResponseSchema, ListGolfUserAccessRequestSchema, ListGolfUserAccessResponseSchema, ChangeGolfUserAccessRequestSchema, ChangeGolfUserAccessResponseSchema, GetGolfUserAccessOperationRequestSchema, GetGolfUserAccessOperationResponseSchema, UserSchema, GolfUserAccessSchema } from '../src/gen/golf/v1/golf_pb';
import { request, respond, reject } from './rpc';
async function backend(page: Page) {
  const target = create(GolfUserAccessSchema, { golfUserId: '9007199254740993', nativeUserId: '9007199254740995', login: 'review-admin', isInstanceAdmin: true, version: '0' });
  const state = { denied: false, responseLost: false, mismatch: false, rejectPassword: false, rejectionMarked: true, reads: [] as number[], writes: [] as ReturnType<typeof request<typeof ChangeGolfUserAccessRequestSchema>>[], inspections: [] as ReturnType<typeof request<typeof GetGolfUserAccessOperationRequestSchema>>[], target, actor: create(UserSchema, { id: '42', login: 'operator', isInstanceAdmin: true }) };
  await page.route('**/rpc/**', async route => {
    const method = new URL(route.request().url()).pathname.split('/').at(-1);
    if (method === 'GetAuthenticationOptions') return respond(route, GetAuthenticationOptionsResponseSchema, {});
    if (method === 'GetSession') return respond(route, GetSessionResponseSchema, { user: state.actor });
    if (method === 'ListCapabilities') return respond(route, ListCapabilitiesResponseSchema, portableRuntimeFixture);
    if (method === 'ListLocalAccounts') return respond(route, ListLocalAccountsResponseSchema, {});
    if (method === 'ListGolfUserAccess') {
      const input = request(route, ListGolfUserAccessRequestSchema); state.reads.push(input.page?.page ?? 1);
      if (state.denied) return reject(route, 'permission_denied', 'Golf access administration required.');
      return respond(route, ListGolfUserAccessResponseSchema, { users: [state.target, { golfUserId: '1', nativeUserId: '42', login: 'operator', isInstanceAdmin: true, version: '0' }] });
    }
    const receipt = (input: typeof state.writes[number]) => ({ operationId: input.operationId, golfUserId: input.golfUserId, nativeUserId: state.mismatch ? '999' : input.nativeUserId, version: (BigInt(input.expectedVersion) + 1n).toString(), suspended: input.suspended, reason: input.reason, changedAt: '2026-10-05T12:00:00Z', sessionsRevoked: input.suspended ? 3n : 0n, automationGrantsRevoked: input.suspended ? 2n : 0n });
    if (method === 'ChangeGolfUserAccess') {
      const input = request(route, ChangeGolfUserAccessRequestSchema); state.writes.push(input); if (state.rejectPassword) return route.fulfill({ status: 403, contentType: 'application/json', headers: state.rejectionMarked ? { 'Golf-Access-Outcome': 'rejected' } : {}, json: { code: 'permission_denied', message: 'Confirm your current Golf password.' } }); state.target.suspended = input.suspended; state.target.version = (BigInt(input.expectedVersion) + 1n).toString(); state.target.reason = input.reason; state.target.changedAt = '2026-10-05T12:00:00Z';
      if (state.responseLost) return reject(route, 'unavailable', 'Response lost.');
      return respond(route, ChangeGolfUserAccessResponseSchema, { operation: receipt(input), user: state.target });
    }
    if (method === 'GetGolfUserAccessOperation') {
      const input = request(route, GetGolfUserAccessOperationRequestSchema); state.inspections.push(input);
      const write = state.writes.find(write => write.operationId === input.operationId);
      if (!write) return reject(route, 'not_found', 'No completed operation.');
      return respond(route, GetGolfUserAccessOperationResponseSchema, { operation: receipt(write), user: state.target });
    }
    return reject(route, 'unimplemented', 'Unsupported fixture.');
  });
  return state;
}
async function fill(page: Page, action = 'Suspend') {
  await page.getByRole('button', { name: `${action} Golf access for review-admin`, exact: true }).click();
  const form = page.getByRole('form', { name: `${action} Golf access`, exact: true });
  await expect(form.getByLabel('Reason', { exact: true })).toBeFocused();
  await form.getByLabel('Reason', { exact: true }).fill('Access review <script>alert(1)</script>');
  await form.getByLabel('Your Golf password', { exact: true }).fill('private admin password never stored');
  return form;
}
test('Golf access has explicit forms, exact immutable IDs, other administrator actions and safe restore', async ({ page }) => {
  const state = await backend(page); await page.goto('/admin/settings');
  const table = page.getByRole('table', { name: 'Golf access', exact: true });
  await expect(table.getByText('review-admin', { exact: true })).toBeVisible();
  await page.screenshot({path:test.info().outputPath('golf-access-1440.png'),fullPage:true});
  await expect(page.getByRole('form')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Suspend Golf access for operator', exact: true })).toHaveCount(0);
  await page.getByRole('searchbox', { name: 'Search loaded Golf access', exact: true }).fill('review-admin');
  await expect(table.locator('tbody tr[data-row-id]')).toHaveCount(1);
  let form = await fill(page); await form.getByRole('button', { name: 'Cancel', exact: true }).click(); expect(state.writes).toHaveLength(0);
  form = await fill(page); await form.getByRole('button', { name: 'Confirm suspend Golf access', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('3 sessions and 2 automation grants revoked');
  expect(state.writes).toHaveLength(1); expect(state.writes[0]).toMatchObject({ golfUserId: '9007199254740993', nativeUserId: '9007199254740995', expectedVersion: '0', suspended: true });
  expect(state.writes[0]!.operationId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4/);
  await expect(table.getByText('Access review <script>alert(1)</script>', { exact: true })).toBeVisible();
  expect(await page.evaluate(() => Object.values(localStorage).concat(Object.values(sessionStorage)).join(' '))).not.toContain('private admin password');
  form = await fill(page, 'Restore'); await expect(form).toContainText('Previous sessions and automation grants stay revoked');
  await form.getByRole('button', { name: 'Confirm restore Golf access', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('0 sessions and 0 automation grants revoked'); expect(state.writes[1]!.expectedVersion).toBe('1'); expect(state.writes[1]!.suspended).toBe(false);
});
test('response loss inspects the exact original access intent without replay', async ({ page }) => {
  const state = await backend(page); state.responseLost = true; await page.goto('/admin/settings');
  const form = await fill(page); await form.getByRole('button', { name: 'Confirm suspend Golf access', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('No automatic retry');
  await expect(page.getByRole('button', { name: 'Suspend Golf access for review-admin', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'Refresh Golf access', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Inspect access change', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Inspect access change', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('3 sessions and 2 automation grants revoked');
  expect(state.writes).toHaveLength(1); expect(state.inspections).toHaveLength(1); expect(state.inspections[0]).toMatchObject({ golfUserId: state.writes[0]!.golfUserId, nativeUserId: state.writes[0]!.nativeUserId, operationId: state.writes[0]!.operationId });
});
test('mismatched receipt stays uncertain; denial hides inventory, reason, editor and recovery controls', async ({ page }) => {
  const state = await backend(page); state.mismatch = true; await page.goto('/admin/settings');
  const form = await fill(page); await form.getByRole('button', { name: 'Confirm suspend Golf access', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('receipt could not be verified');
  state.denied = true; await page.getByRole('button', { name: 'Refresh Golf access', exact: true }).click();
  await expect(page.getByRole('alert')).toHaveText('Golf access administration required.');
  await expect(page.getByRole('table', { name: 'Golf access', exact: true })).toHaveCount(0);
  await expect(page.getByText('review-admin', { exact: true })).toHaveCount(0); await expect(page.getByRole('button', { name: 'Inspect access change', exact: true })).toHaveCount(0);
  expect(state.writes).toHaveLength(1);
});
for (const theme of ['dark', 'light']) test(`${theme} mobile access inventory fits and remains keyboard accessible`, async ({ page }) => {
  await backend(page); await page.addInitScript(theme => { localStorage.setItem('golf.theme', theme); }, theme); await page.setViewportSize({ width: 390, height: 844 }); await page.goto('/admin/settings');
  await expect(page.getByRole('table', { name: 'Golf access', exact: true })).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('data-theme',theme);
  await page.screenshot({path:test.info().outputPath(`golf-access-${theme}-390.png`),fullPage:true});
  const form = await fill(page); expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await form.getByRole('button', { name: 'Cancel', exact: true }).click(); await expect(page.getByRole('form')).toHaveCount(0);
});

test('confirmed rollback allows explicit password retry with a fresh intent and cleared secrets', async ({ page }) => {
 const state=await backend(page);state.rejectPassword=true;await page.goto('/admin/settings');
 let form=await fill(page);await form.getByRole('button',{name:'Confirm suspend Golf access',exact:true}).click();
 await expect(page.getByRole('status')).toContainText('No access change was committed');await expect(page.getByRole('button',{name:'Inspect access change',exact:true})).toHaveCount(0);
 await expect(page.getByRole('button',{name:'Suspend Golf access for review-admin',exact:true})).toBeEnabled();expect(state.writes).toHaveLength(1);
 await page.getByRole('button',{name:'Suspend Golf access for review-admin',exact:true}).click();form=page.getByRole('form',{name:'Suspend Golf access',exact:true});await expect(form.getByLabel('Your Golf password')).toHaveValue('');state.rejectPassword=false;
 await form.getByLabel('Reason',{exact:true}).fill('Separate explicitly confirmed attempt');await form.getByLabel('Your Golf password').fill('private admin password never stored');await form.getByRole('button',{name:'Confirm suspend Golf access',exact:true}).click();
 await expect(page.getByRole('status')).toContainText('3 sessions and 2 automation grants revoked');expect(state.writes).toHaveLength(2);expect(state.writes[1]!.operationId).not.toBe(state.writes[0]!.operationId);
});
test('an unmarked permission error remains uncertain and never infers rollback from HTTP status',async({page})=>{
 const state=await backend(page);state.rejectPassword=true;state.rejectionMarked=false;await page.goto('/admin/settings');const form=await fill(page);await form.getByRole('button',{name:'Confirm suspend Golf access',exact:true}).click();
 await expect(page.getByRole('alert')).toContainText('Inspect the original operation');await expect(page.getByRole('button',{name:'Suspend Golf access for review-admin',exact:true})).toBeDisabled();await page.getByRole('button',{name:'Inspect access change',exact:true}).click();
 expect(state.inspections[0]!.operationId).toBe(state.writes[0]!.operationId);expect(state.writes).toHaveLength(1);
});
