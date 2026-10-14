import { portableRuntimeFixture } from './runtime-fixture';
import { expect, test, type Page } from '@playwright/test';
import { ListCapabilitiesResponseSchema, GetAccountSecurityResponseSchema, GetRepositoryAccessResponseSchema, GetSessionResponseSchema, ListRepositoryEnvironmentsRequestSchema, ListRepositoryEnvironmentsResponseSchema, RepositoryEnvironmentCapability, RepositoryEnvironmentAction, SaveRepositoryEnvironmentRequestSchema, SaveRepositoryEnvironmentResponseSchema, DeleteRepositoryEnvironmentRequestSchema, DeleteRepositoryEnvironmentResponseSchema, type RepositoryEnvironment, type RepositoryEnvironmentSchema } from '../src/gen/golf/v1/golf_pb';
import type { MessageInitShape } from '@bufbuild/protobuf';
import { reject, request, respond } from './rpc';

async function backend(page: Page, local = true, permission = 'owner') {
  const counts = { writes: 0, inventory: 0 };
  await page.route('**/rpc/**', route => {
    const method = new URL(route.request().url()).pathname.split('/').at(-1);
    if (method === 'ListCapabilities') return respond(route, ListCapabilitiesResponseSchema, portableRuntimeFixture);
    if (method === 'GetSession') return respond(route, GetSessionResponseSchema, { user: { id: '42', login: 'alice' } });
    if (method === 'GetAccountSecurity') return respond(route, GetAccountSecurityResponseSchema, { security: { userId: '42', accountId: local ? '2' : '', credentialVersion: local ? '1' : '', canManage: local } });
    if (method === 'GetRepositoryAccess') return respond(route, GetRepositoryAccessResponseSchema, { access: { repositoryId: '9007199254740993', ownerId: '42', owner: { id: '42', login: 'alice' }, revision: 'a'.repeat(64), currentPermission: permission, canManage: permission === 'owner' } });
    if (method === 'ListRepositoryEnvironments') {
      counts.inventory++;
      const input = request(route, ListRepositoryEnvironmentsRequestSchema);
      expect(input.target?.repository).toMatchObject({ owner: 'alice', name: 'example' });
      expect(input.target?.repositoryId).toBe('9007199254740993');
      return respond(route, ListRepositoryEnvironmentsResponseSchema, { target: input.target, totalCount: '0', page: {}, capability: RepositoryEnvironmentCapability.CONFIGURATION_ONLY });
    }
    if (method === 'SaveRepositoryEnvironment' || method === 'DeleteRepositoryEnvironment') counts.writes++;
    return reject(route, 'unimplemented', 'Outside the environment route fixture.');
  });
  return counts;
}

test('canonical environment route uses current native identity and opens its editor only on request', async ({ page }) => {
  const counts = await backend(page);
  await page.goto('/alice/example/settings/environments');
  await expect(page.getByRole('heading', { name: 'Environments', exact: true, level: 1 })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Add environment', exact: true })).toBeEnabled();
  await expect(page.getByRole('form')).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'Environments', exact: true })).toHaveAttribute('data-status', 'active');
  await expect(page.getByRole('link', { name: 'General', exact: true })).not.toHaveAttribute('data-status', 'active');
  await page.getByRole('button', { name: 'Add environment', exact: true }).click();
  await expect(page.getByRole('form', { name: 'Environment configuration editor' })).toBeVisible();
  expect(counts.inventory).toBeGreaterThan(0); expect(counts.writes).toBe(0);
});

test('native administrator without local password can inspect configuration without an editable form', async ({ page }) => {
  const counts = await backend(page, false);
  await page.goto('/alice/example/settings/environments');
  await expect(page.getByRole('button', { name: 'Add environment', exact: true })).toBeDisabled();
  await expect(page.getByRole('form')).toHaveCount(0);
  await expect.poll(() => counts.inventory).toBeGreaterThan(0);
  expect(counts.writes).toBe(0);
});

test('ordinary reader cannot read environment inventory through the mounted settings route', async ({ page }) => {
  const counts = await backend(page, true, 'read');
  await page.goto('/alice/example/settings/environments');
  await expect(page.getByRole('heading', { name: 'Environments', exact: true, level: 1 })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Add environment', exact: true })).toBeDisabled();
  await expect(page.getByRole('form')).toHaveCount(0);
  await expect(page.getByText('Current ordinary repository administrator authority is required to read environment configuration.', { exact: true })).toBeVisible();
  expect(counts.inventory).toBe(0); expect(counts.writes).toBe(0);
});

// Cloudflare native: no AccountSecurityService and no passwords; the Worker answers with PREVIEW_POLICY and refuses unsupported shapes.
async function nativeBackend(page: Page) {
  const state = { security: 0, saves: [] as Record<string, unknown>[], deletes: [] as Record<string, unknown>[], refuse: false, row: null as MessageInitShape<typeof RepositoryEnvironmentSchema> | null };
  const stamp = '2026-10-14T00:00:00.000Z';
  await page.route('**/native/config', route => route.fulfill({ status: 200, contentType: 'application/json', json: { runtimeProfile: 'cloudflare-native', previews: true, previewTTL: 900 } }));
  await page.route('**/rpc/**', route => {
    const method = new URL(route.request().url()).pathname.split('/').at(-1);
    if (method === 'ListCapabilities') return respond(route, ListCapabilitiesResponseSchema, { runtimeProfile: 'cloudflare-native', capabilities: [{ id: 'settings.repository-environments', label: 'Environments', state: 3, reason: 'One environment named preview governs protected pull-request previews.' }] });
    if (method === 'GetSession') return respond(route, GetSessionResponseSchema, { user: { id: '42', login: 'alice' } });
    if (method === 'GetAccountSecurity') { state.security++; return reject(route, 'unimplemented', 'This capability is not implemented on the native forge.'); }
    if (method === 'GetRepositoryAccess') return respond(route, GetRepositoryAccessResponseSchema, { access: { repositoryId: '7', ownerId: '1', owner: { id: '1', login: 'alice' }, revision: 'a'.repeat(64), currentPermission: 'admin', canManage: true } });
    if (method === 'ListRepositoryEnvironments') {
      const input = request(route, ListRepositoryEnvironmentsRequestSchema);
      return respond(route, ListRepositoryEnvironmentsResponseSchema, { target: input.target, environments: state.row ? [state.row] : [], totalCount: state.row ? '1' : '0', page: {}, capability: RepositoryEnvironmentCapability.PREVIEW_POLICY });
    }
    if (method === 'SaveRepositoryEnvironment' || method === 'DeleteRepositoryEnvironment') {
      const deleting = method === 'DeleteRepositoryEnvironment', raw = route.request().postDataJSON() as Record<string, unknown>;
      (deleting ? state.deletes : state.saves).push(raw);
      if (state.refuse) return reject(route, 'invalid_argument', 'Preview lifetime must be between 60 and 300 seconds on this installation.');
      const input = deleting ? request(route, DeleteRepositoryEnvironmentRequestSchema) : request(route, SaveRepositoryEnvironmentRequestSchema);
      const version = String(BigInt(input.expectedVersion) + 1n);
      const environment = { id: input.environmentId, target: input.target, name: 'preview', version, policy: deleting ? state.row!.policy : (input as { policy?: RepositoryEnvironment['policy'] }).policy, creatorId: '42', updaterId: '42', createdAt: stamp, updatedAt: stamp, deleted: deleting, capability: RepositoryEnvironmentCapability.PREVIEW_POLICY };
      const operation = { operationId: input.operationId, environmentId: input.environmentId, target: input.target, actorId: '42', action: deleting ? RepositoryEnvironmentAction.DELETE : RepositoryEnvironmentAction.SAVE, expectedVersion: input.expectedVersion, version, state: 'SUCCEEDED', createdAt: stamp };
      state.row = deleting ? null : environment;
      return respond(route, deleting ? DeleteRepositoryEnvironmentResponseSchema : SaveRepositoryEnvironmentResponseSchema, { environment, operation });
    }
    return reject(route, 'unimplemented', 'Outside the native environment route fixture.');
  });
  return state;
}

test('native environments save the preview policy with the Access session: no password, reviewer or wait fields', async ({ page }) => {
  const state = await nativeBackend(page);
  await page.goto('/alice/example/settings/environments');
  await expect(page.getByRole('heading', { name: 'Environments', exact: true, level: 1 })).toBeVisible();
  await expect(page.getByText('One environment named preview governs protected pull-request previews when they are published or renewed', { exact: false })).toBeVisible();
  await expect(page.getByText('Configuration only', { exact: false })).toHaveCount(0);
  await expect(page.getByRole('form')).toHaveCount(0);
  await page.getByRole('button', { name: 'Add environment', exact: true }).click();
  const form = page.getByRole('form', { name: 'Environment configuration editor' });
  await expect(form).toBeVisible();
  await expect(form.locator('input[type="password"]')).toHaveCount(0);
  await expect(page.getByLabel('Current Golf password', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('group', { name: 'Required reviewers' })).toHaveCount(0);
  await expect(page.getByLabel('Reviewer username')).toHaveCount(0);
  await expect(page.getByLabel('Required approvals')).toHaveCount(0);
  await expect(page.getByLabel('Wait before deployment (seconds)')).toHaveCount(0);
  await expect(form.getByText('Saving uses your signed-in Cloudflare Access session; this installation has no account passwords.', { exact: false })).toBeVisible();
  await expect(page.getByLabel('Name', { exact: true })).toHaveValue('preview');
  await expect(page.getByLabel('Name', { exact: true })).toHaveAttribute('readonly', '');
  await expect(page.getByLabel('Protected preview lifetime (seconds)')).toHaveValue('900');
  await page.getByLabel('Allow every head branch').uncheck();
  await expect(page.getByLabel('Source 1 type')).toHaveCount(0);
  await page.getByLabel('Head branch 1', { exact: true }).fill('release/next');
  await page.getByLabel('Maximum concurrent previews').fill('2');
  // The operator ceiling and the workspace's four preview slots are checked before any request is sent.
  await page.getByLabel('Protected preview lifetime (seconds)').fill('901');
  await page.getByRole('button', { name: 'Save environment', exact: true }).click();
  expect(await page.getByLabel('Protected preview lifetime (seconds)').evaluate((input: HTMLInputElement) => input.validity.rangeOverflow && input.max)).toBe('900');
  await expect(page.getByRole('status')).toHaveCount(0);
  expect(state.saves).toHaveLength(0);
  await page.getByLabel('Protected preview lifetime (seconds)').fill('600');
  await page.getByRole('button', { name: 'Save environment', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Environment configuration saved.');
  await expect(page.getByRole('status')).toContainText('It applies to the next preview publication or renewal.');
  expect(state.saves).toHaveLength(1);
  expect('currentPassword' in state.saves[0]!).toBe(false);
  expect(state.saves[0]).toMatchObject({ target: { repository: { owner: 'alice', name: 'example' }, repositoryId: '7', ownerId: '1', accessRevision: 'a'.repeat(64) }, expectedVersion: '0', name: 'preview',
    policy: { sources: [{ kind: 'REPOSITORY_SOURCE_REF_KIND_BRANCH', name: 'release/next' }], maxConcurrency: 2, previewTtlSeconds: 600, preventSelfApproval: true, protectedPreviews: true } });
  for (const absent of ['allowAllSources', 'reviewers', 'requiredApprovals', 'waitSeconds', 'allowAdminBypass']) expect(absent in (state.saves[0]!.policy as object)).toBe(false);
  // The saved policy is read back from the server; the single environment leaves nothing more to add.
  const table = page.getByRole('table', { name: 'Repository environments', exact: true });
  await expect(table).toContainText('preview'); await expect(table).toContainText('Enforced on protected previews'); await expect(table).toContainText('2 concurrent · 600s lifetime');
  await expect(page.getByRole('button', { name: 'Add environment', exact: true })).toBeDisabled();
  await expect(page.getByRole('form')).toHaveCount(0);
  // A server refusal of a native setting commits nothing and can be discarded.
  state.refuse = true;
  await page.getByRole('button', { name: 'Edit environment preview', exact: true }).click();
  await page.getByRole('button', { name: 'Save environment', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Change refused before commit' })).toBeVisible();
  await expect(page.getByRole('alert')).toContainText('between 60 and 300 seconds on this installation');
  await page.getByRole('button', { name: 'Discard refused change' }).click();
  await expect(page.getByRole('button', { name: 'Edit environment preview', exact: true })).toBeEnabled();
  state.refuse = false;
  // Deletion is confirmed by the same session, without a password prompt.
  await page.getByRole('button', { name: 'Delete environment preview', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.locator('input')).toHaveCount(0);
  await expect(dialog).toContainText('Deleting uses your signed-in Cloudflare Access session');
  await dialog.getByRole('button', { name: 'Confirm delete environment' }).click();
  await expect(page.getByRole('status')).toContainText('Environment deleted.');
  expect(state.deletes).toHaveLength(1); expect('currentPassword' in state.deletes[0]!).toBe(false); expect(state.deletes[0]).toMatchObject({ expectedVersion: '1' });
  await expect(page.getByRole('button', { name: 'Add environment', exact: true })).toBeEnabled();
  expect(state.security).toBe(0);
});
