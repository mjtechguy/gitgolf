import { expect, test, type Page } from '@playwright/test';
import { ListCapabilitiesResponseSchema } from '../src/gen/golf/v1/golf_pb';
import { featureBackend } from './feature-policy-fixture';
import { respond } from './rpc';

// Edit public profile on a Cloudflare-native installation, answering /native/public-profile and /native/discover as
// cloudflare/forge/src/public-profiles.mjs does: discover is newest (highest id) first, 100 a page, with nextPage.
const repo = (id: number) => ({ id: String(id), name: `repo-${id}`, owner: 'alex', fullName: `alex/repo-${id}`, description: '', topics: [], updatedAt: '2026-10-01T00:00:00Z' });
const pins = [1, 2, 3, 4, 5, 6].map(repo);

async function backend(page: Page) {
  const saves: Record<string, unknown>[] = [];
  await featureBackend(page);
  await page.route('**/rpc/golf.v1.CapabilityService/ListCapabilities', route => respond(route, ListCapabilitiesResponseSchema, { runtimeProfile: 'cloudflare-native', capabilities: [] }));
  const profile = { ownerId: '1', slug: 'alex', kind: 'PERSONAL', enabled: true, canEdit: true, revision: 'a'.repeat(64), displayName: 'Alex Morgan', bio: '', location: '', website: '', readme: '', pinnedRepositories: pins, publicRepositoryCount: 200 };
  await page.route('**/native/public-profile', route => { const body = route.request().postDataJSON();
    if (body.action === 'save') { saves.push(body); return route.fulfill({ json: { ...profile, revision: 'b'.repeat(64), pinnedRepositories: body.profile.pinned.map((id: string) => repo(Number(id))) } }); }
    return route.fulfill({ json: profile }); });
  // Page 1 holds ids 200..101, page 2 ids 100..1: the six pins (ids 1..6) are only on page 2.
  await page.route('**/native/discover', route => { const number = route.request().postDataJSON().page?.page ?? 1;
    return route.fulfill({ json: { repositories: Array.from({ length: 100 }, (_, i) => repo(200 - (number - 1) * 100 - i)), nextPage: number === 1 ? 2 : 0 } }); });
  return saves;
}

test('pins outside the loaded page are listed, can be cleared, and the editor can reach the rest', async ({ page }) => {
  const saves = await backend(page);
  await page.goto('/alex');
  await page.getByRole('button', { name: 'Edit public profile' }).click();
  const pinned = page.getByRole('group', { name: 'Pinned repositories · up to six' });
  await expect(pinned).toContainText('Current pins come first, then public repositories owned by this profile, newest first; 106 are loaded.');
  // Six pins on older ids are shown checked and can be cleared; other choices wait until a slot is free.
  for (const pin of pins) await expect(pinned.getByRole('checkbox', { name: `${pin.name} Public`, exact: true })).toBeChecked();
  await expect(pinned.getByRole('checkbox', { name: 'repo-200 Public', exact: true })).toBeDisabled();
  await pinned.getByRole('checkbox', { name: 'repo-3 Public', exact: true }).uncheck();
  await pinned.getByRole('checkbox', { name: 'repo-200 Public', exact: true }).check();
  await pinned.getByRole('button', { name: 'Load more repositories' }).click();
  await expect(pinned.getByRole('button', { name: 'Load more repositories' })).toHaveCount(0);
  await expect(pinned).not.toContainText('are loaded');
  // Page 2 repeats the pins; each appears once.
  await expect(pinned.getByRole('checkbox', { name: 'repo-1 Public', exact: true })).toHaveCount(1);
  await expect(pinned.getByRole('checkbox', { name: 'repo-7 Public', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'Save profile' }).click();
  await expect.poll(() => saves.length).toBe(1);
  expect((saves[0]!.profile as { pinned: string[] }).pinned).toEqual(['1', '2', '4', '5', '6', '200']);
});
