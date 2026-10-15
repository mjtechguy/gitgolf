import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { GetAuthenticationOptionsResponseSchema, GetSessionResponseSchema, ListCapabilitiesResponseSchema } from '../src/gen/golf/v1/golf_pb';
import { portableRuntimeFixture } from './runtime-fixture';
import { disabledAgentTasks, disabledAgentUsage, reject, respond } from './rpc';

// A missing (or hidden) resource answers once. Returning to the tab, or a browser tool that reports the page visible again,
// must not refetch it: the refetch dropped the error screen for the loading state, so the page flickered between the two.
const user = { id: '17', login: 'alex', fullName: 'Alex' };
const missing = { status: 404, contentType: 'application/json', json: { code: 'not_found', message: 'Unavailable.' } };
const reads = { repository: 'GetRepository', organization: 'GetOrganization', profile: 'public-profile' } as const;

async function fixture(page: Page, profile: 'docker' | 'cloudflare-native') {
  const calls: string[] = [];
  await page.route('**/rpc/**', async route => {
    const method = route.request().url().split('/').at(-1)!;
    calls.push(method);
    if (method === 'GetAuthenticationOptions') return respond(route, GetAuthenticationOptionsResponseSchema, { localPasswordEnabled: true });
    if (method === 'GetSession') return respond(route, GetSessionResponseSchema, { user });
    if (method === 'ListCapabilities') return respond(route, ListCapabilitiesResponseSchema, { capabilities: [...portableRuntimeFixture.capabilities, { id: 'settings.feature-policy', label: 'Feature policies', state: 3, reason: 'Fixture reports feature policies.' }], runtimeProfile: profile });
    if (method === 'GetAgentUsage') return disabledAgentUsage(route);
    if (method === 'ListAgentTasks') return disabledAgentTasks(route);
    if (['GetRepository', 'GetRepositoryFeatures', 'GetOrganization'].includes(method)) return route.fulfill(missing);
    return reject(route, 'unimplemented', 'Missing resource fixture does not provide this operation.');
  });
  await page.route('**/native/**', route => { calls.push(route.request().url().split('/').at(-1)!); return route.fulfill(missing); });
  return calls;
}

// The browser's own event, as a tab switch or an automation tool's attach delivers it.
const reportVisible = (page: Page) => page.evaluate(() => document.dispatchEvent(new Event('visibilitychange', { bubbles: true })));

for (const [subject, path, profile] of [['repository', '/alex/ghost', 'docker'], ['organization', '/organizations/ghost-org', 'docker'], ['profile', '/ghost', 'cloudflare-native']] as const) test(`a missing ${subject} answers once and its error screen stays until Try again`, async ({ page }) => {
  const calls = await fixture(page, profile);
  const count = () => calls.filter(call => call === reads[subject]).length;
  await page.goto(path);
  const screen = page.getByRole('region', { name: `We can't show this ${subject}` });
  await expect(screen.getByText('Lost ball.')).toBeVisible();
  // The development build's StrictMode can start the first read twice; what matters is that nothing follows it.
  await page.waitForTimeout(500);
  const loaded = count();
  expect(loaded).toBeGreaterThanOrEqual(1);
  await page.evaluate(() => { const w = window as unknown as { left: boolean }; w.left = false; new MutationObserver(() => { if (!document.querySelector('.error-screen')) w.left = true; }).observe(document.body, { subtree: true, childList: true }); });
  for (let elapsed = 0; elapsed < 6000; elapsed += 500) { await reportVisible(page); await page.waitForTimeout(500); }
  expect(count()).toBe(loaded);
  expect(await page.evaluate(() => (window as unknown as { left: boolean }).left)).toBe(false);
  await expect(screen.getByText('It doesn\'t exist, or your sign-in can\'t see it, and Golf won\'t say which.', { exact: false })).toBeVisible();
  // Try again is the explicit refetch: exactly one more read, then the same screen.
  await screen.getByRole('button', { name: 'Try again' }).click();
  await expect.poll(count).toBe(loaded + 1);
  await expect(page.getByRole('region', { name: `We can't show this ${subject}` }).getByText('Lost ball.')).toBeVisible();
  await page.waitForTimeout(1000);
  expect(count()).toBe(loaded + 1);
});
