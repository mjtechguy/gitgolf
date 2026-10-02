import { expect, test, type Page } from '@playwright/test';
import { create } from '@bufbuild/protobuf';
import { GetAuthenticationOptionsResponseSchema, GetSessionResponseSchema, GetProfileResponseSchema, UpdateProfileRequestSchema, UpdateProfileResponseSchema, ProfileSchema, UserSchema } from '../src/gen/golf/v1/golf_pb';
import { reject, request, respond } from './rpc';
async function backend(page: Page, canEdit = true) {
  const state = { profile: create(ProfileSchema, { userId: '42', login: 'alex', fullName: 'Alex Original', bio: 'Original bio', location: 'Original location', website: 'https://example.test', revision: 'original-profile-revision', canEdit }), writes: [] as ReturnType<typeof request<typeof UpdateProfileRequestSchema>>[], dropped: false, denied: false, logoutFailed: false, barrier: undefined as Promise<void> | undefined };
  await page.route('**/rpc/**', async route => {
    const method = new URL(route.request().url()).pathname.split('/').at(-1);
    if (method === 'GetAuthenticationOptions') return respond(route, GetAuthenticationOptionsResponseSchema, {});
    if (method === 'GetSession') return respond(route, GetSessionResponseSchema, { user: create(UserSchema, { id: '42', login: 'alex', fullName: state.profile.fullName, isInstanceAdmin: true }) });
    if (method === 'GetProfile') return state.denied ? reject(route, 'permission_denied', 'Profile access denied.') : respond(route, GetProfileResponseSchema, { profile: state.profile });
    if (method === 'UpdateProfile') {
      const input = request(route, UpdateProfileRequestSchema); state.writes.push(input);
      if (state.denied) return reject(route, 'permission_denied', 'Profile access denied.');
      for (const key of ['fullName', 'bio', 'location', 'website'] as const) if (input[key] !== undefined) state.profile[key] = input[key];
      state.profile.revision = 'saved-profile-revision';
      if (state.barrier) await state.barrier;
      if (state.dropped) return route.abort('failed');
      return respond(route, UpdateProfileResponseSchema, { profile: state.profile }).catch(() => {});
    }
    if (method === 'Logout') return state.logoutFailed ? reject(route, 'unavailable', 'Sign-out could not be completed.') : route.fulfill({ contentType: 'application/json', body: '{}' });
    return reject(route, 'not_found', 'Unsupported profile fixture.');
  });
  return state;
}
test('profile shows authoritative fields and role with an explicit editor and read-only sign-in identity', async ({ page }) => {
  await backend(page); await page.goto('/account/settings'); const panel = page.getByRole('region', { name: 'Account profile', exact: true });
  await expect(panel.getByText('Alex Original', { exact: true })).toBeVisible(); await expect(panel.getByText('Instance administrator', { exact: true })).toBeVisible(); await expect(panel.getByText('alex · Read only', { exact: true })).toBeVisible();
  await expect(panel.locator('input,textarea,select')).toHaveCount(0); await expect(panel.getByRole('button', { name: 'Edit profile', exact: true })).toBeVisible();
  await page.getByRole('searchbox', { name: 'Search loaded Personal settings', exact: true }).fill('Profile and email'); await expect(page.getByRole('table', { name: 'Personal settings', exact: true }).getByText('Partial', { exact: true })).toBeVisible();
});
test('cancel and pagehide clear drafts without submitting profile changes', async ({ page }) => {
  const state = await backend(page); await page.goto('/account/settings'); await page.getByRole('button', { name: 'Edit profile', exact: true }).click(); await page.getByLabel('Display name', { exact: true }).fill('Private unsaved draft'); await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Edit profile', exact: true })).toBeFocused(); await page.getByRole('button', { name: 'Edit profile', exact: true }).click(); await expect(page.getByLabel('Display name', { exact: true })).toHaveValue('Alex Original'); await page.getByLabel('Bio', { exact: true }).fill('Private bio draft');
  await page.evaluate(() => window.dispatchEvent(new Event('pagehide'))); await expect(page.getByLabel('Bio', { exact: true })).toHaveCount(0); await page.getByRole('button', { name: 'Edit profile', exact: true }).click(); await expect(page.getByLabel('Bio', { exact: true })).toHaveValue('Original bio'); expect(state.writes).toHaveLength(0);
});
test('save sends only changed public fields with original identity and revision, including empty strings', async ({ page }) => {
  const state = await backend(page); await page.goto('/account/settings'); await page.getByRole('button', { name: 'Edit profile', exact: true }).click(); await page.getByLabel('Display name', { exact: true }).fill('Alex Updated'); await page.getByLabel('Bio', { exact: true }).fill(''); await page.getByRole('button', { name: 'Save profile', exact: true }).click();
  await expect(page.getByRole('status')).toHaveText('Profile saved.'); expect(state.writes).toHaveLength(1); const input = state.writes[0]!; expect(input.userId).toBe('42'); expect(input.expectedRevision).toBe('original-profile-revision'); expect(input.fullName).toBe('Alex Updated'); expect(input.bio).toBe(''); expect(input.location).toBeUndefined(); expect(input.website).toBeUndefined();
  await expect(page.getByRole('region', { name: 'Account profile', exact: true }).getByText('Alex Updated', { exact: true })).toBeVisible(); await expect(page.getByRole('button', { name: 'Edit profile', exact: true })).toBeFocused();
});
test('UTF-8 byte bounds and credential-bearing websites reject edits before dispatch', async ({ page }) => {
  const state = await backend(page); await page.goto('/account/settings'); await page.getByRole('button', { name: 'Edit profile', exact: true }).click(); await page.getByLabel('Display name', { exact: true }).fill('é'.repeat(60)); await page.getByRole('button', { name: 'Save profile', exact: true }).click(); await expect(page.getByRole('alert')).toContainText('100 UTF-8 bytes'); expect(state.writes).toHaveLength(0);
  await page.getByLabel('Display name', { exact: true }).fill('Valid name'); await page.getByLabel('Website', { exact: true }).fill('https://private:secret@example.test'); await page.getByRole('button', { name: 'Save profile', exact: true }).click(); await expect(page.getByRole('alert')).toContainText('without embedded credentials'); expect(state.writes).toHaveLength(0);
});
test('unknown applied write requires manual inspection and never automatically repeats the PATCH', async ({ page }) => {
  const state = await backend(page); state.dropped = true; await page.goto('/account/settings'); await page.getByRole('button', { name: 'Edit profile', exact: true }).click(); await page.getByLabel('Display name', { exact: true }).fill('Applied before lost receipt'); await page.getByRole('button', { name: 'Save profile', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Inspect current profile', exact: true })).toBeVisible(); await expect(page.getByLabel('Display name', { exact: true })).toHaveCount(0); await expect(page.getByRole('button', { name: 'Edit profile', exact: true })).toBeDisabled(); expect(state.writes).toHaveLength(1);
  await page.getByRole('button', { name: 'Refresh and inspect profile', exact: true }).click(); await expect(page.getByRole('region', { name: 'Account profile', exact: true }).getByText('Applied before lost receipt', { exact: true })).toBeVisible(); await expect(page.getByRole('button', { name: 'Edit profile', exact: true })).toBeEnabled(); expect(state.writes).toHaveLength(1);
});
test('denied mutation clears editor and cached private profile fields', async ({ page }) => {
  const state = await backend(page); await page.goto('/account/settings'); await page.getByRole('button', { name: 'Edit profile', exact: true }).click(); await page.getByLabel('Display name', { exact: true }).fill('Changed draft'); state.denied = true; await page.getByRole('button', { name: 'Save profile', exact: true }).click();
  await expect(page.getByRole('alert').first()).toContainText('Profile access denied.'); const panel = page.getByRole('region', { name: 'Account profile', exact: true }); await expect(panel.getByText('Original bio', { exact: true })).toHaveCount(0); await expect(panel.getByLabel('Display name', { exact: true })).toHaveCount(0); await expect(panel.getByRole('button', { name: 'Edit profile', exact: true })).toHaveCount(0); expect(state.writes).toHaveLength(1);
});
test('failed logout during pending save clears the draft and ignores a late receipt', async ({ page }) => {
  const state = await backend(page); state.logoutFailed = true; let release!: () => void; state.barrier = new Promise<void>(resolve => { release = resolve; }); await page.goto('/account/settings'); await page.getByRole('button', { name: 'Edit profile', exact: true }).click(); await page.getByLabel('Display name', { exact: true }).fill('Late profile receipt'); await page.getByRole('button', { name: 'Save profile', exact: true }).click(); await expect.poll(() => state.writes.length).toBe(1);
  await page.getByLabel('Your account', { exact: true }).click(); await page.getByRole('button', { name: 'Sign out', exact: true }).click(); await expect(page.getByText('Sign-out could not be completed.', { exact: true })).toBeVisible(); release();
  await expect(page.getByLabel('Display name', { exact: true })).toHaveCount(0); await expect(page.getByRole('heading', { name: 'Inspect current profile', exact: true })).toBeVisible(); await expect(page.getByRole('status').filter({ hasText: 'Profile saved.' })).toHaveCount(0); expect(state.writes).toHaveLength(1);
});
test('read-only profile preserves fields without offering a fake edit action', async ({ page }) => {
  const state = await backend(page, false); await page.goto('/account/settings'); await expect(page.getByRole('region', { name: 'Account profile', exact: true }).getByText('Alex Original', { exact: true })).toBeVisible(); await expect(page.getByRole('button', { name: 'Edit profile', exact: true })).toHaveCount(0); await expect(page.getByText('Profile is view-only with your current account permissions.', { exact: false })).toBeVisible(); expect(state.writes).toHaveLength(0);
});
