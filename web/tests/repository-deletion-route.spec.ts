import { expect, test, type Page } from '@playwright/test';
import { GetRepositoryLifecycleRequestSchema, GetRepositoryLifecycleResponseSchema, GetRepositoryDeletionOperationRequestSchema, GetRepositoryDeletionOperationResponseSchema, GetSessionResponseSchema } from '../src/gen/golf/v1/golf_pb';
import { reject, request, respond } from './rpc';

const repositoryId = '9007199254740993';
const originalKey = '42faec6c-496a-4d23-95bb-e56d8dd95de7';
async function backend(page: Page, absent = false) {
  const state = { metadataReads: 0, availability: 0, status: 0, writes: 0 };
  await page.route('**/rpc/**', async route => {
    const method = new URL(route.request().url()).pathname.split('/').at(-1);
    if (method === 'GetSession') return respond(route, GetSessionResponseSchema, { user: { id: '42', login: 'alice' } });
    if (method === 'GetRepository' || method === 'GetRepositoryAccess') { state.metadataReads++; return reject(route, 'not_found', 'The historical address cannot be rebound.'); }
    if (method === 'GetRepositoryLifecycle') {
      state.availability++; const input = request(route, GetRepositoryLifecycleRequestSchema);
      expect(input.repositoryId).toBe(repositoryId); expect(input.repository).toMatchObject({ owner: 'alice', name: 'example' });
      if (absent) return reject(route, 'not_found', 'The original repository is absent.');
      return respond(route, GetRepositoryLifecycleResponseSchema, { lifecycle: { repository: input.repository, repositoryId, ownerId: '42', revision: 'a'.repeat(64), canManage: true, stepUpAvailable: true, activeWorkCount: '0', deleteNotice: 'managed_native_boundary_unqualified' } });
    }
    if (method === 'GetRepositoryDeletionOperation') {
      state.status++; const input = request(route, GetRepositoryDeletionOperationRequestSchema);
      expect(input.repositoryId).toBe(repositoryId); expect(input.ownerId).toBe('42'); expect(input.idempotencyKey).toBe(originalKey);
      return respond(route, GetRepositoryDeletionOperationResponseSchema, { operation: { action: 'delete', repository: input.repository, repositoryId, ownerId: '42', actorId: '42', idempotencyKey: originalKey, expectedRevision: 'a'.repeat(64), phase: 'SUCCEEDED', createdAt: '2026-10-04T10:00:00Z', updatedAt: '2026-10-04T10:00:01Z' } });
    }
    if (method === 'DeleteRepository') { state.writes++; return reject(route, 'failed_precondition', 'No deletion dispatch is authorized by this fixture.'); }
    return reject(route, 'unimplemented', 'Outside the route fixture.');
  });
  return state;
}

test('deletion deep link keeps its exact original identity without repository metadata resolution', async ({ page }) => {
  const state = await backend(page);
  await page.goto(`/alice/example/settings/deletion?repositoryId=${repositoryId}`);
  await expect(page.getByRole('heading', { name: 'Deletion', exact: true })).toBeVisible();
  await expect(page.getByText(repositoryId, { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Delete repository', exact: true })).toHaveCount(0);
  await expect(page.getByRole('form')).toHaveCount(0);
  expect(state.availability).toBeGreaterThan(0); expect(state.metadataReads).toBe(0); expect(state.writes).toBe(0);
});

test('original deletion remains inspectable after absence and reload without adopting a replacement', async ({ page }) => {
  const state = await backend(page, true);
  await page.addInitScript(({ repositoryId, originalKey }) => {
    const key = `golf.deletion-intent.${JSON.stringify([location.origin, '42', 'alice', 'example', repositoryId])}`;
    sessionStorage.setItem(key, JSON.stringify({ repositoryId, ownerId: '42', idempotencyKey: originalKey, expectedRevision: 'a'.repeat(64), archived: false }));
  }, { repositoryId, originalKey });
  await page.goto(`/alice/example/settings/deletion?repositoryId=${repositoryId}`);
  await expect(page.getByRole('heading', { name: 'Original deletion completed', exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Original deletion completed', exact: true })).toBeVisible();
  expect(state.status).toBeGreaterThan(1); expect(state.metadataReads).toBe(0); expect(state.writes).toBe(0);
});

for (const query of ['', '?repositoryId=0', '?repositoryId=01', '?repositoryId=9223372036854775808', '?repositoryId=not-an-id', '?repositoryId=9007199254740993&repositoryId=9007199254740994']) test(`invalid original identity ${query || 'missing'} cannot probe repository data`, async ({ page }) => {
  const state = await backend(page);
  await page.goto('/alice/example/settings/deletion' + query);
  await expect(page.getByRole('heading', { name: 'Page not found', exact: true })).toBeVisible();
  expect(state.availability).toBe(0); expect(state.metadataReads).toBe(0); expect(state.status).toBe(0); expect(state.writes).toBe(0);
});
