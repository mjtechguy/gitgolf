import { expect, test, type Page } from '@playwright/test';
import { GetAccountSecurityResponseSchema, GetRepositoryAccessResponseSchema, GetSessionResponseSchema, ListRepositoryEnvironmentsRequestSchema, ListRepositoryEnvironmentsResponseSchema, RepositoryEnvironmentCapability } from '../src/gen/golf/v1/golf_pb';
import { reject, request, respond } from './rpc';

async function backend(page: Page, local = true, permission = 'owner') {
  const counts = { writes: 0, inventory: 0 };
  await page.route('**/rpc/**', route => {
    const method = new URL(route.request().url()).pathname.split('/').at(-1);
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
