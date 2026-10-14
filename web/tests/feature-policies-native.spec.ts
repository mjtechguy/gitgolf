import { expect, test } from '@playwright/test';
import { FeaturePolicyMode } from '../src/gen/golf/v1/feature_policy_pb';
import { featureBackend } from './feature-policy-fixture';

test('the features page leads with the summary and grouped cards, and opens an editor only on request', async ({ page }) => {
  const state = await featureBackend(page);
  await page.goto('/admin/features');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Features and policies');
  await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1);
  const summary = page.getByRole('definition').filter({ hasText: /^\d+$/ });
  await expect(page.getByLabel('Feature policy summary')).toContainText('On everywhere0');
  await expect(page.getByLabel('Feature policy summary')).toContainText('Off1');
  await expect(page.getByLabel('Feature policy summary')).toContainText('Unavailable3');
  expect(await summary.count()).toBeGreaterThan(0);
  for (const group of ['Automation', 'Collaboration', 'Integrations', 'Distribution']) await expect(page.getByRole('heading', { level: 2, name: group })).toBeVisible();
  const actions = page.getByRole('listitem').filter({ has: page.getByRole('heading', { name: 'Actions', exact: true }) });
  await expect(actions).toContainText('Allowed'); await expect(actions).toContainText('On in 12 of 14 repositories'); await expect(actions).toContainText('Needs Pull requests');
  const packages = page.getByRole('listitem').filter({ has: page.getByRole('heading', { name: 'Packages', exact: true }) });
  await expect(packages).toContainText('Unavailable'); await expect(packages).toContainText('has not connected an OCI registry');
  await expect(packages.getByRole('button')).toHaveCount(0);
  await expect(page.getByRole('form')).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'Features and policies' })).toHaveAttribute('data-status', 'active');
  // Narrowing needs no confirmation; the effect names what else turns off.
  await page.getByRole('button', { name: 'Edit Actions policy' }).click();
  const editor = page.getByRole('form', { name: 'Actions policy' });
  await editor.getByRole('radio', { name: /Off/ }).check();
  await expect(editor).toContainText('Also turns off Secrets and variables, Previews and environments');
  await editor.getByRole('button', { name: 'Save policy' }).click();
  await expect(page.getByRole('status')).toHaveText('Actions: off for every repository.');
  expect(state.updates).toHaveLength(1);
  await expect(actions).toContainText('Off in all 14 repositories');
});

test('widening needs the feature typed back and public repositories can never be required', async ({ page }) => {
  const state = await featureBackend(page);
  await page.goto('/admin/features');
  await page.getByRole('button', { name: 'Edit Releases policy' }).click();
  const editor = page.getByRole('form', { name: 'Releases policy' });
  await editor.getByRole('radio', { name: /On everywhere/ }).check();
  const save = editor.getByRole('button', { name: 'Save policy' });
  await expect(save).toBeDisabled();
  await editor.getByLabel(/Type releases to confirm/).fill('release');
  await expect(save).toBeDisabled();
  await editor.getByLabel(/Type releases to confirm/).fill('releases');
  await save.click();
  await expect(page.getByRole('status')).toHaveText('Releases: on everywhere for every repository.');
  expect((state.updates[0] as { mode: number; confirmation: string })).toMatchObject({ mode: FeaturePolicyMode.ENFORCED, confirmation: 'releases' });
  await page.getByRole('button', { name: 'Edit Public repositories policy' }).click();
  await expect(page.getByRole('form', { name: 'Public repositories policy' }).getByRole('radio', { name: /On everywhere/ })).toBeDisabled();
});

test('a feature the installation turned off leaves the tabs, moves its settings to the policy group and names the level', async ({ page }) => {
  const state = await featureBackend(page);
  state.modes.secrets = 'DISABLED';
  await page.goto('/alex/demo');
  await expect(page.getByRole('link', { name: 'Code', exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: /^Releases/ })).toHaveCount(0);
  await expect(page.getByRole('link', { name: /^Actions/ })).toBeVisible();
  await page.goto('/alex/demo/releases');
  await expect(page.getByRole('heading', { name: 'Releases turned off' })).toBeVisible();
  await expect(page.getByText('Releases are turned off for this repository by the installation policy.', { exact: false })).toBeVisible();
  await page.goto('/alex/demo/settings/secrets');
  await expect(page.getByRole('heading', { level: 1, name: 'Secrets and variables' })).toBeVisible();
  await expect(page.getByText('Turned off · Installation policy')).toBeVisible();
  const nav = page.getByRole('navigation', { name: 'Repository settings' });
  await expect(nav.getByText('Turned off by policy')).toBeVisible();
  await expect(nav.getByRole('link', { name: /Secrets and variables/ })).toContainText('Installation policy');
  // Webhooks were turned off by this repository; the entry says so.
  await expect(nav.getByRole('link', { name: /Webhooks/ })).toContainText('This repository');
});

test('the portable server answers Unimplemented and the repository keeps its current tabs', async ({ page }) => {
  await featureBackend(page);
  await page.route('**/rpc/golf.v1.RepositoryFeatureService/**', route => route.fulfill({ status: 501, contentType: 'application/json', json: { code: 'unimplemented', message: 'Not implemented.' } }));
  await page.goto('/alex/demo');
  await expect(page.getByRole('link', { name: /^Actions/ })).toBeVisible();
  await expect(page.getByRole('link', { name: /^Releases/ })).toHaveCount(0);
});
