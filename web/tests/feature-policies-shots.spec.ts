import { expect, test, type Page } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { featureBackend } from './feature-policy-fixture';

// Review screenshots against mocked native responses: GOLF_FEATURE_SHOTS=/output/directory npx playwright test feature-policies-shots
const directory = process.env.GOLF_FEATURE_SHOTS;
const looks = [
  ['flare-console-dark', 'flare', 'console', 'dark', 1440, 900], ['flare-console-light', 'flare', 'console', 'light', 1440, 900],
  ['golf-tiles-dark', 'golf', 'tiles', 'dark', 1440, 900], ['classic-primer-light', 'classic', 'primer', 'light', 1440, 900],
  ['flare-console-dark-390', 'flare', 'console', 'dark', 390, 844],
] as const;
async function shot(page: Page, name: string) {
  await page.evaluate(() => { (document.activeElement as HTMLElement | null)?.blur(); window.scrollTo(0, 0); });
  // No page may scroll sideways at any width.
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
  await page.screenshot({ path: `${directory}/${name}.png`, fullPage: true, animations: 'disabled' });
}
for (const [look, appearance, layout, theme, width, height] of looks) test(`feature policy screens in ${look}`, async ({ page }) => {
  test.skip(!directory, 'Set GOLF_FEATURE_SHOTS to write review screenshots.');
  await mkdir(directory!, { recursive: true });
  await page.setViewportSize({ width, height });
  await page.addInitScript(([a, l, t]: [string, string, string]) => { localStorage.setItem('golf.appearance', a); localStorage.setItem('golf.layout.' + a, l); localStorage.setItem('golf.theme', t); }, [appearance, layout, theme] as [string, string, string]);
  const state = await featureBackend(page);
  state.modes.secrets = 'DISABLED'; state.modes.email = 'ENFORCED'; state.versions.secrets = 1; state.versions.email = 2;
  await page.goto('/admin/features');
  await expect(page.getByRole('heading', { level: 2, name: 'Distribution' })).toBeVisible();
  await shot(page, `${look}-admin-features`);
  await page.getByRole('button', { name: 'Edit Releases policy' }).click();
  const editor = page.getByRole('form', { name: 'Releases policy' });
  await editor.getByRole('radio', { name: /Allowed/ }).check();
  await editor.getByLabel(/Type releases to confirm/).fill('releases');
  await editor.scrollIntoViewIfNeeded();
  await shot(page, `${look}-admin-features-edit`);
  await page.goto('/alex/demo/settings');
  await expect(page.getByRole('region', { name: 'Features' }).getByRole('heading', { level: 4, name: 'Releases' })).toBeVisible();
  await shot(page, `${look}-repository-settings-features`);
  await page.getByRole('button', { name: 'Edit features' }).click();
  await shot(page, `${look}-repository-settings-features-edit`);
  await page.goto('/alex/demo');
  await expect(page.getByRole('link', { name: /^Pull requests/ }).first()).toBeVisible();
  await shot(page, `${look}-repository-releases-tab-gone`);
  await page.goto('/alex/demo/releases');
  await expect(page.getByRole('heading', { name: 'Releases turned off' })).toBeVisible();
  await shot(page, `${look}-repository-releases-blocked`);
  await page.goto('/alex/demo/settings/secrets');
  await expect(page.getByText('Turned off · Installation policy')).toBeVisible();
  await shot(page, `${look}-repository-secrets-blocked-nav`);
});
