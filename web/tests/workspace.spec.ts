import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import type { Repository } from '../src/api';

const originalRepositories: Repository[] = [
  { id: 1, name: 'design-system', full_name: 'alex/design-system', description: 'A shared foundation for our next idea.', private: true, html_url: 'https://forge.example/alex/design-system', default_branch: 'main', updated_at: '2026-10-01T12:00:00Z' },
  { id: 2, name: 'tiny-tools', full_name: 'alex/tiny-tools', description: 'Small tools for everyday work.', private: false, html_url: 'https://forge.example/alex/tiny-tools', default_branch: 'main', updated_at: '2026-09-30T10:00:00Z' },
];

async function backend(page: Page, signedIn = true) {
  const state = { signedIn, repositories: [...originalRepositories], rejectCreation: false, receivedToken: '', created: undefined as unknown };
  await page.route('**/api/**', async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path === '/api/session') {
      if (request.method() === 'POST') {
        state.receivedToken = request.postDataJSON().token as string;
        if (state.receivedToken !== 'test-scoped-token') return route.fulfill({ status: 401, json: { error: { code: 'unauthorized', message: 'Gitea did not accept this token.' } } });
        state.signedIn = true;
      }
      if (request.method() === 'DELETE') { state.signedIn = false; return route.fulfill({ status: 204 }); }
      return route.fulfill({ status: state.signedIn ? 200 : 401, json: state.signedIn ? { user: { id: 7, login: 'alex', full_name: 'Alex', avatar_url: '' } } : { error: { code: 'unauthorized', message: 'Sign in required.' } } });
    }
    if (!state.signedIn) return route.fulfill({ status: 401, json: { error: { code: 'unauthorized', message: 'Your session expired.' } } });
    if (path === '/api/capabilities') return route.fulfill({ json: { capabilities: [
      { id: 'repositories', label: 'Repositories', state: 'configured', reason: 'Browse and create repositories on your connected Gitea instance. Check readiness for live dependency health.' },
      { id: 'agents', label: 'Agent workflows', state: 'disabled', reason: 'Agent execution is planned and is not available in this build.' },
    ] } });
    if (path === '/api/repositories') {
      if (request.method() === 'POST') {
        state.created = request.postDataJSON();
        if (state.rejectCreation) return route.fulfill({ status: 409, json: { error: { code: 'conflict', message: 'A repository with this name already exists.' } } });
        const input = state.created as { name: string; description: string; private: boolean };
        const repository = { ...originalRepositories[0]!, ...input, id: 3, full_name: `alex/${input.name}`, html_url: `https://forge.example/alex/${input.name}` };
        state.repositories.push(repository);
        return route.fulfill({ status: 201, json: { repository } });
      }
      return route.fulfill({ json: { repositories: state.repositories } });
    }
    return route.fulfill({ status: 404 });
  });
  return state;
}

test('sign-in handles errors, establishes a session, and never persists the token', async ({ page }) => {
  const state = await backend(page, false);
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Continue to workspace' })).toBeDisabled();
  await page.getByLabel('Gitea access token').fill('wrong');
  await page.getByRole('button', { name: 'Continue to workspace' }).click();
  await expect(page.getByRole('alert')).toHaveText('Gitea did not accept this token.');
  await page.getByLabel('Gitea access token').fill('test-scoped-token');
  await page.getByRole('button', { name: 'Continue to workspace' }).click();
  await expect(page.getByRole('heading', { name: 'Repositories', exact: true })).toBeVisible();
  expect(state.receivedToken).toBe('test-scoped-token');
  const stored = await page.evaluate(() => JSON.stringify({ ...localStorage, ...sessionStorage }));
  expect(stored).not.toContain('test-scoped-token');
  await expect(page.locator('input[type=password]')).toHaveCount(0);
});

test('repository filtering, safe links, theme persistence and mobile layout', async ({ page }) => {
  const state = await backend(page);
  state.repositories.push({ ...originalRepositories[0]!, id: 9, name: 'untrusted-link', full_name: 'alex/untrusted-link', html_url: 'javascript:alert(1)' });
  await page.goto('/');
  await expect(page.getByRole('link', { name: 'Open alex/design-system in Gitea' })).toHaveAttribute('href', 'https://forge.example/alex/design-system');
  await expect(page.getByRole('link', { name: 'Open alex/untrusted-link in Gitea' })).toHaveCount(0);
  await page.getByLabel('Repository visibility').selectOption('public');
  await expect(page.getByRole('heading', { name: 'alex/tiny-tools' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'alex/design-system' })).toHaveCount(0);
  await page.getByLabel('Repository visibility').selectOption('all');
  await page.getByLabel('Search loaded repositories').fill('design');
  await expect(page.getByRole('heading', { name: 'alex/tiny-tools' })).toHaveCount(0);
  await page.getByLabel('Search loaded repositories').clear();
  await page.getByRole('button', { name: 'Dark theme' }).click();
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await expect(page.getByText('Agent execution is planned')).toBeVisible();
  await page.screenshot({ path: 'test-results/workspace-dark.png', fullPage: true });
  await page.getByRole('button', { name: 'Light theme' }).click();
  await page.screenshot({ path: 'test-results/workspace-light.png', fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole('button', { name: 'New repository' })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: 'test-results/workspace-mobile.png', fullPage: true });
});

test('private creation keeps actionable errors, refreshes repositories and signs out', async ({ page }) => {
  const state = await backend(page);
  await page.goto('/');
  await page.getByRole('button', { name: 'New repository' }).click();
  await expect(page.getByLabel('Repository name')).toBeFocused();
  await page.getByLabel('Repository name').fill('next-project');
  await page.getByLabel('Description').fill('An idea worth building.');
  await expect(page.getByRole('checkbox', { name: 'Private repository' })).toBeChecked();
  state.rejectCreation = true;
  await page.getByRole('button', { name: 'Create repository', exact: true }).click();
  await expect(page.getByRole('alert')).toHaveText('A repository with this name already exists.');
  expect(state.created).toEqual({ name: 'next-project', description: 'An idea worth building.', private: true });
  state.rejectCreation = false;
  await page.getByRole('button', { name: 'Create repository', exact: true }).click();
  await expect(page.getByRole('dialog')).not.toBeVisible();
  await expect(page.getByRole('heading', { name: 'alex/next-project' })).toBeVisible();
  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page.getByRole('heading', { name: 'Welcome to Golf' })).toBeVisible();
  await expect(page.getByText('alex/next-project')).toHaveCount(0);
});

test('session expiry clears repository content', async ({ page }) => {
  const state = await backend(page);
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'alex/design-system' })).toBeVisible();
  state.signedIn = false;
  await page.getByRole('button', { name: 'Refresh repositories' }).click();
  await expect(page.getByRole('heading', { name: 'Welcome to Golf' })).toBeVisible();
  await expect(page.getByText('alex/design-system')).toHaveCount(0);
});
