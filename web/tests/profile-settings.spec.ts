import { expect, test, type Page } from '@playwright/test';
import { create } from '@bufbuild/protobuf';
import { GetAuthenticationOptionsResponseSchema, GetSessionResponseSchema, GetProfileResponseSchema, UpdateProfileRequestSchema, UpdateProfileResponseSchema, ProfileSchema, UserSchema } from '../src/gen/golf/v1/golf_pb';
import { unconfiguredOwnEmail,emptyOwnEmailHistory,reject, request, respond } from './rpc';
async function backend(page: Page, canEdit = true) {
  const state = { profile: create(ProfileSchema, { userId: '42', login: 'alex', fullName: 'Alex Original', bio: 'Original bio', location: 'Original location', website: 'https://example.test', revision: 'original-profile-revision', canEdit }), writes: [] as ReturnType<typeof request<typeof UpdateProfileRequestSchema>>[], dropped: false, denied: false, logoutFailed: false, signedIn:true, actor:'42', methods:[] as string[], barrier: undefined as Promise<void> | undefined };
  await page.route('**/rpc/**', async route => {
    const method = new URL(route.request().url()).pathname.split('/').at(-1);state.methods.push(method||'');
    if (method === 'GetAuthenticationOptions') return respond(route, GetAuthenticationOptionsResponseSchema, {});
    if(method==='GetSession'&&!state.signedIn)return reject(route,'unauthenticated','Your session ended.');
    if (method === 'GetSession') return respond(route, GetSessionResponseSchema, { user: create(UserSchema, { id: state.actor, login: 'alex', fullName: state.profile.fullName, isInstanceAdmin: true }) });
    if(method==='GetOwnEmailNotifications')return unconfiguredOwnEmail(route,'42');
    if(method==='ListOwnEmailDeliveries')return emptyOwnEmailHistory(route,'42');
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
    if (method === 'Logout') {if(state.logoutFailed)return reject(route,'unavailable','Sign-out could not be completed.');state.signedIn=false;return route.fulfill({contentType:'application/json',body:'{}'});}
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
  await expect(page.getByRole('region',{name:'Account profile',exact:true}).getByRole('status')).toHaveText('Profile saved.'); expect(state.writes).toHaveLength(1); const input = state.writes[0]!; expect(input.userId).toBe('42'); expect(input.expectedRevision).toBe('original-profile-revision'); expect(input.fullName).toBe('Alex Updated'); expect(input.bio).toBe(''); expect(input.location).toBeUndefined(); expect(input.website).toBeUndefined();
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

const originalDispatchMetadata=(actor:string)=>({actorId:actor,key:'12345678-1234-4234-8234-123456789012',owner:'alex',name:'private',repositoryId:'8',ownerId:'42',commitId:'a'.repeat(40),workflowPath:'.github/workflows/manual.yml',workflowBlobId:'b'.repeat(40)});
const storedDispatches=(page:Page)=>page.evaluate(()=>Object.keys(sessionStorage).filter(key=>key.startsWith('golf.workflow-dispatch.v1:')).sort());

test('accepted session retains only its own dispatch metadata without loading workflow UI',async({page})=>{
 const state=await backend(page);const modules:string[]=[];page.on('request',req=>{if(req.url().includes('/src/'))modules.push(req.url());});
 await page.addInitScript(({own,other})=>{if(sessionStorage.getItem('fixture.dispatch-seeded'))return;sessionStorage.setItem('fixture.dispatch-seeded','yes');sessionStorage.setItem(`golf.workflow-dispatch.v1:${location.origin}:42:8`,JSON.stringify(own));sessionStorage.setItem(`golf.workflow-dispatch.v1:${location.origin}:420:8`,JSON.stringify(other));sessionStorage.setItem('unrelated.fixture','preserved');},{own:originalDispatchMetadata('42'),other:originalDispatchMetadata('420')});
 await page.goto('/account/settings');await expect(page.getByRole('region',{name:'Account profile',exact:true})).toBeVisible();const own=`golf.workflow-dispatch.v1:${new URL(page.url()).origin}:42:8`;await expect.poll(()=>storedDispatches(page)).toEqual([own]);expect(await page.evaluate(key=>JSON.parse(sessionStorage.getItem(key)!),own)).toEqual(originalDispatchMetadata('42'));
 await page.reload();await expect(page.getByRole('region',{name:'Account profile',exact:true})).toBeVisible();await expect.poll(()=>storedDispatches(page)).toEqual([own]);expect(await page.evaluate(()=>sessionStorage.getItem('unrelated.fixture'))).toBe('preserved');expect(state.methods.some(method=>['DispatchWorkflow','GetWorkflowDispatch','InspectWorkflows'].includes(method))).toBe(false);expect(modules.some(url=>url.includes('/WorkflowConfigurations.tsx'))).toBe(false);
});

test('logout clears own dispatch metadata while the workflow component is unmounted',async({page})=>{
 const state=await backend(page);await page.goto('/account/settings');await expect(page.getByRole('region',{name:'Account profile',exact:true})).toBeVisible();await page.evaluate(value=>{sessionStorage.setItem(`golf.workflow-dispatch.v1:${location.origin}:42:8`,JSON.stringify(value));sessionStorage.setItem('unrelated.fixture','preserved');},originalDispatchMetadata('42'));
 await expect.poll(()=>storedDispatches(page)).toHaveLength(1);await page.getByLabel('Your account',{exact:true}).click();await page.getByRole('button',{name:'Sign out',exact:true}).click();await expect(page.getByRole('heading',{name:'Welcome to Golf',exact:true})).toBeVisible();await expect.poll(()=>storedDispatches(page)).toEqual([]);expect(await page.evaluate(()=>sessionStorage.getItem('unrelated.fixture'))).toBe('preserved');expect(state.methods.filter(method=>method==='Logout')).toHaveLength(1);expect(state.methods.some(method=>['DispatchWorkflow','GetWorkflowDispatch','InspectWorkflows'].includes(method))).toBe(false);
});

test('a changed accepted actor clears old dispatch identity and keeps only the new actor',async({page})=>{
 const state=await backend(page);await page.goto('/account/settings');await expect(page.getByRole('region',{name:'Account profile',exact:true})).toBeVisible();await page.evaluate(({old,next})=>{sessionStorage.setItem(`golf.workflow-dispatch.v1:${location.origin}:42:8`,JSON.stringify(old));sessionStorage.setItem(`golf.workflow-dispatch.v1:${location.origin}:17:8`,JSON.stringify(next));},{old:originalDispatchMetadata('42'),next:originalDispatchMetadata('17')});state.actor='17';state.profile.userId='17';await page.reload();await expect(page.getByRole('region',{name:'Account profile',exact:true})).toBeVisible();await expect.poll(()=>storedDispatches(page)).toEqual([`golf.workflow-dispatch.v1:${new URL(page.url()).origin}:17:8`]);expect(state.methods.some(method=>['DispatchWorkflow','GetWorkflowDispatch','InspectWorkflows'].includes(method))).toBe(false);
});

test('expired global session forgets dispatch metadata without mounting workflow UI',async({page})=>{
 const state=await backend(page);await page.goto('/account/settings');await expect(page.getByRole('region',{name:'Account profile',exact:true})).toBeVisible();await page.evaluate(value=>sessionStorage.setItem(`golf.workflow-dispatch.v1:${location.origin}:42:8`,JSON.stringify(value)),originalDispatchMetadata('42'));state.signedIn=false;await page.reload();await expect(page.getByRole('heading',{name:'Welcome to Golf',exact:true})).toBeVisible();await expect.poll(()=>storedDispatches(page)).toEqual([]);expect(state.methods.some(method=>['DispatchWorkflow','GetWorkflowDispatch','InspectWorkflows'].includes(method))).toBe(false);
});
