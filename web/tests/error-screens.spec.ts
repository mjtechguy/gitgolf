import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { GetAuthenticationOptionsResponseSchema, GetSessionResponseSchema, ListCapabilitiesResponseSchema } from '../src/gen/golf/v1/golf_pb';
import { portableRuntimeFixture } from './runtime-fixture';
import { disabledAgentTasks, disabledAgentUsage, reject, respond } from './rpc';

const user = { id: '17', login: 'alex', fullName: 'Alex' };
const requestId = '0f1e2d3c-4b5a-4968-8776-655443322110';
async function fixture(page: Page, repository: 'not_found' | 'permission_denied' | 'unavailable' = 'not_found') {
  const methods: string[] = [];
  await page.route('**/rpc/**', async route => {
    const method = route.request().url().split('/').at(-1)!;
    methods.push(method);
    if (method === 'GetAuthenticationOptions') return respond(route, GetAuthenticationOptionsResponseSchema, { localPasswordEnabled: true });
    if (method === 'GetSession') return respond(route, GetSessionResponseSchema, { user });
    if (method === 'ListCapabilities') return respond(route, ListCapabilitiesResponseSchema, { ...portableRuntimeFixture, runtimeProfile: 'docker' });
    if (method === 'GetAgentUsage') return disabledAgentUsage(route);
    if (method === 'ListAgentTasks') return disabledAgentTasks(route);
    if (method === 'GetRepository') {
      const status = { not_found: 404, permission_denied: 403, unavailable: 503 }[repository];
      return route.fulfill({ status, contentType: 'application/json', headers: { 'X-Request-ID': requestId }, json: { code: repository, message: repository === 'unavailable' ? 'Workspace restarting.' : 'Repository unavailable.' } });
    }
    return reject(route, 'unimplemented', 'Error screen fixture does not provide this operation.');
  });
  return methods;
}

test('an unknown address shows the out-of-bounds page with a way back and no protected reads', async ({ page }) => {
  const methods = await fixture(page);
  await page.goto('/alex/demo/no-such-view/at/all');
  await expect(page.getByRole('heading', { name: 'Page not found', exact: true })).toBeVisible();
  await expect(page.getByText('This hole doesn\'t exist.')).toBeVisible();
  await page.getByRole('link', { name: 'Back to repositories' }).click();
  await expect(page).toHaveURL(/\/$/);
  expect(methods.filter(method => method === 'GetRepository')).toHaveLength(0);
});

for (const code of ['not_found', 'permission_denied'] as const) test(`a ${code} repository keeps missing and hidden indistinguishable and shows the request ID`, async ({ page }) => {
  await fixture(page, code);
  await page.goto('/alex/ghost');
  const screen = page.getByRole('region', { name: 'We can\'t show this repository' });
  await expect(screen.getByText('Lost ball.')).toBeVisible();
  await expect(screen.getByText('It doesn\'t exist, or your sign-in can\'t see it, and Golf won\'t say which.', { exact: false })).toBeVisible();
  await expect(screen.getByRole('alert')).toHaveText('Repository unavailable.');
  await expect(screen.getByText(code, { exact: true })).toBeVisible();
  await expect(screen.getByText(requestId)).toBeVisible();
  await expect(screen.getByRole('button', { name: 'Try again' })).toBeVisible();
});

test('an unavailable workspace is a rain delay, not a missing repository', async ({ page }) => {
  await fixture(page, 'unavailable');
  await page.goto('/alex/ghost');
  const screen = page.getByRole('region', { name: 'Golf did not answer' });
  await expect(screen.getByText('Rain delay.')).toBeVisible();
  await expect(screen.getByRole('alert')).toHaveText('Workspace restarting.');
  await expect(screen.getByRole('link', { name: 'Golf status' })).toHaveAttribute('href', '/status');
  await expect(screen.getByText(requestId)).toBeVisible();
});
