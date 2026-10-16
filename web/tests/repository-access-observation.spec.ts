import { portableRuntimeFixture } from './runtime-fixture';
import { expect, test, type Page } from '@playwright/test';
import { create } from '@bufbuild/protobuf';
import {
  GetRepositoryMirrorStatusResponseSchema, GetAuthenticationOptionsResponseSchema, GetRepositoryAccessResponseSchema, GetRepositoryLifecycleResponseSchema,
  GetRepositoryResponseSchema, GetRepositorySettingsResponseSchema, GetSessionResponseSchema,
  ListCapabilitiesResponseSchema, ListRepositoriesResponseSchema, ListRepositoryCollaboratorsResponseSchema,
  ListRepositoryDeployKeysResponseSchema, ListRepositoryInvitationsResponseSchema, ListRepositoryTeamAccessResponseSchema,
  RepositoryAccessSchema, RepositoryFeatureMode, RepositorySettingsSchema, UserSchema,
} from '../src/gen/golf/v1/golf_pb';
import { reject, respond } from './rpc';

const owner = 'alex', name = 'demo', repositoryId = '9007199254740997', ownerId = '9007199254740993';
const rev = (value = 'a') => value.repeat(64);
const inventories = ['ListRepositoryCollaborators','ListRepositoryDeployKeys','ListRepositoryInvitations','ListRepositoryTeamAccess'];
async function backend(page: Page) {
  const state = {
    user: create(UserSchema, { id: ownerId, login: owner }), signedOut: false,
    settings: create(RepositorySettingsSchema, { repositoryId, ownerId, defaultBranch: 'main', revision: rev(), generalEditImplemented: true, issuesMode: RepositoryFeatureMode.INTERNAL, hasIssues: true, wikiMode: RepositoryFeatureMode.DISABLED, canEdit: true }),
    access: create(RepositoryAccessSchema, { repositoryId, ownerId, owner: { id: ownerId, login: owner }, revision: rev('b'), currentPermission: 'owner', canManage: true }),
    reads: [] as { method: string; input: Record<string, unknown> }[], writes: [] as string[],
    nativeID: repositoryId, nativeName: name, nativeFullName: `${owner}/${name}`,
    childRevision: rev('b'), teamManage: false, localIssuer: true, nextPage: 0,
    finalChange: false, accessCalls: 0, deny: '' as '' | 'permission_denied' | 'not_found' | 'unauthenticated',
    denyMethod: 'GetRepositoryAccess', barrier: undefined as Promise<void> | undefined,
    generalBarrier: undefined as Promise<void> | undefined,
  };
  await page.route('**/rpc/**', async route => {
    const method = new URL(route.request().url()).pathname.split('/').at(-1)!;
    const input = route.request().postDataJSON() as Record<string, unknown>;
    state.reads.push({method,input});
    if (method === 'GetAuthenticationOptions') return respond(route, GetAuthenticationOptionsResponseSchema, {localPasswordEnabled:true});
    if (method === 'GetSession') return respond(route, GetSessionResponseSchema, state.signedOut ? {} : {user:state.user});
    if (method === 'Logout') { state.signedOut=true; return route.fulfill({status:200,json:{}}); }
    if (method === 'ListCapabilities') return respond(route,ListCapabilitiesResponseSchema, portableRuntimeFixture);
    if (method === 'ListRepositories') return respond(route,ListRepositoriesResponseSchema,{});
    if (method === 'GetRepositorySettings') { if(state.generalBarrier)await state.generalBarrier; return respond(route,GetRepositorySettingsResponseSchema,{settings:state.settings}); }
    if (method === 'GetRepositoryMirrorStatus') return respond(route, GetRepositoryMirrorStatusResponseSchema, {repository:{owner,name},repositoryId});
    if (method === 'GetRepositoryLifecycle') return respond(route,GetRepositoryLifecycleResponseSchema,{lifecycle:{repository:{owner,name},repositoryId,ownerId,revision:rev(),blockedReason:'ownership_required'}});
    if (method === 'GetRepository') return respond(route,GetRepositoryResponseSchema,{repository:{id:state.nativeID,name:state.nativeName,fullName:state.nativeFullName,defaultBranch:'main'}});
    if (state.barrier && (inventories.includes(method) || method === 'GetRepositoryAccess')) await state.barrier;
    if (state.deny && method === state.denyMethod) return reject(route,state.deny,'Access observation unavailable.');
    if (method === 'GetRepositoryAccess') {
      state.accessCalls++;
      return respond(route,GetRepositoryAccessResponseSchema,{access:state.finalChange && state.accessCalls%2===0 ? {...state.access,revision:rev('c')} : state.access});
    }
    if (inventories.includes(method)) {
      expect(input).toMatchObject({repository:{owner,name},repositoryId,ownerId,expectedRevision:state.access.revision,page:{page:1,limit:20}});
      const bound = {repositoryId,ownerId,accessRevision:state.childRevision,page:{nextPage:state.nextPage}};
      if (method === 'ListRepositoryCollaborators') return respond(route,ListRepositoryCollaboratorsResponseSchema,{page:{nextPage:state.nextPage},collaborators:[{user:{id:'31',login:'PRIVATE_RECIPIENT_CANARY'},permission:'read',revision:rev('d')}]});
      if (method === 'ListRepositoryDeployKeys') return respond(route,ListRepositoryDeployKeysResponseSchema,{...bound,keys:[{id:'45',publicKey:'PRIVATE_KEY_BODY_CANARY',revision:rev('e')}]});
      if (method === 'ListRepositoryInvitations') return respond(route,ListRepositoryInvitationsResponseSchema,{...bound,canManage:true,localIssuerAvailable:state.localIssuer});
      return respond(route,ListRepositoryTeamAccessResponseSchema,{...bound,canManage:state.teamManage});
    }
    if (/^(?:Set|Add|Create|Remove|Delete|Attach|Detach|Respond|Revoke|Update)/.test(method)) state.writes.push(method);
    return reject(route,'unimplemented','Unsupported observation fixture.');
  });
  return state;
}
async function open(page: Page) {
  await page.goto('/alex/demo/settings');
  await page.locator('.settings-diagnostics > summary').click();
  await expect(page.getByRole('button',{name:'Inspect access',exact:true})).toBeVisible();
}
const table = (page: Page) => page.getByRole('table',{name:'Current repository access observation',exact:true});
async function inspect(page: Page) {
  await page.getByRole('button',{name:'Inspect access',exact:true}).click();
  await expect(table(page)).toBeVisible();
}

test('explicit inspection binds metadata/access, performs no writes and caches no recipient/key display',async({page})=>{
  const state=await backend(page); await open(page);
  expect(state.reads.filter(r=>r.method==='GetRepositoryAccess'||inventories.includes(r.method))).toEqual([]);
  await inspect(page);
  expect(state.accessCalls).toBe(2);
  expect(state.reads.filter(r=>inventories.includes(r.method)).map(r=>r.method).sort()).toEqual(inventories.filter(m=>m!=='ListRepositoryTeamAccess').sort());
  await expect(table(page).getByText('Can manage · 1 loaded')).toHaveCount(2);
  await expect(page.getByText('PRIVATE_RECIPIENT_CANARY')).toHaveCount(0);
  await expect(page.getByText('PRIVATE_KEY_BODY_CANARY')).toHaveCount(0);
  await expect(page.getByRole('table',{name:'Repository settings',exact:true}).locator('[data-row-id="access"]')).toContainText('Partial');
  expect(state.writes).toEqual([]);
  const storage=await page.evaluate(()=>JSON.stringify([Object.entries(sessionStorage),Object.entries(localStorage)]));
  expect(storage).not.toMatch(/PRIVATE_RECIPIENT_CANARY|PRIVATE_KEY_BODY_CANARY/);
});

test('reader observes view-only authority without any private administrator inventory fanout',async({page})=>{
  const state=await backend(page); state.access.canManage=false; state.access.currentPermission='read';
  await open(page); await inspect(page);
  expect(state.reads.filter(r=>inventories.includes(r.method))).toEqual([]);
  await expect(table(page).getByText('View only · repository administration required')).toHaveCount(3);
  expect(state.writes).toEqual([]);
});

test('organization grants/keys, organization-owner teams and local invitation issuer remain distinct',async({page})=>{
  const state=await backend(page); state.access.organizationOwned=true; state.access.currentPermission='admin'; state.localIssuer=false;
  await open(page); await inspect(page);
  await expect(table(page)).toContainText('Organization owner required to manage associations · 0 loaded');
  await expect(table(page)).toContainText('Local-account issuer required · 0 loaded');
  await expect(table(page).getByText('Can manage · 1 loaded')).toHaveCount(2);
  expect(state.reads.filter(r=>r.method==='ListRepositoryTeamAccess')).toHaveLength(1);
});

for(const field of ['nativeID','nativeName','nativeFullName'] as const) test(`native ${field} mismatch refuses access probing`,async({page})=>{
  const state=await backend(page); state[field]='replacement'; await open(page);
  await page.getByRole('button',{name:'Inspect access',exact:true}).click();
  await expect(page.getByRole('region',{name:'Current access',exact:true}).getByRole('alert')).toContainText('could not be verified');
  expect(state.accessCalls).toBe(0); expect(state.reads.filter(r=>inventories.includes(r.method))).toEqual([]);
});

for(const field of ['repositoryId','ownerId','revision','currentPermission'] as const) test(`access ${field} mismatch fails before fanout`,async({page})=>{
  const state=await backend(page); state.access[field]='invalid'; await open(page);
  await page.getByRole('button',{name:'Inspect access',exact:true}).click();
  await expect(page.getByRole('region',{name:'Current access',exact:true}).getByRole('alert')).toContainText('could not be verified');
  expect(state.reads.filter(r=>inventories.includes(r.method))).toEqual([]);
});

test('final current revision drift and child receipt mismatch never release a success table',async({page})=>{
  const state=await backend(page); state.finalChange=true; await open(page);
  await page.getByRole('button',{name:'Inspect access',exact:true}).click();
  await expect(page.getByRole('region',{name:'Current access',exact:true}).getByRole('alert')).toContainText('could not be verified'); await expect(table(page)).toHaveCount(0);
  state.finalChange=false; state.childRevision=rev('f');
  await page.getByRole('button',{name:'Refresh access observation',exact:true}).click();
  await expect(page.getByRole('region',{name:'Current access',exact:true}).getByRole('alert')).toContainText('could not be verified'); await expect(table(page)).toHaveCount(0);
});

test('loaded-page status never claims totals and invalid next page is refused',async({page})=>{
  const state=await backend(page); state.nextPage=2; await open(page); await inspect(page);
  await expect(table(page)).toContainText('1 loaded · more available');
  state.nextPage=3; await page.getByRole('button',{name:'Refresh access observation',exact:true}).click();
  await expect(page.getByRole('region',{name:'Current access',exact:true}).getByRole('alert')).toContainText('could not be verified'); await expect(table(page)).toHaveCount(0);
});

for(const denied of ['permission_denied','not_found'] as const) test(`${denied} on refresh clears prior observations and action link`,async({page})=>{
  const state=await backend(page); await open(page); await inspect(page);
  state.deny=denied; state.denyMethod='ListRepositoryDeployKeys';
  await page.getByRole('button',{name:'Refresh access observation',exact:true}).click();
  await expect(page.getByRole('region',{name:'Current access',exact:true}).getByRole('alert')).toContainText('unavailable'); await expect(table(page)).toHaveCount(0);
  await expect(page.getByRole('link',{name:'Open access settings',exact:true})).toHaveCount(0);
});

test('General revalidation unmounts/hides private observation and requires renewed explicit inspection',async({page})=>{
  const state=await backend(page); await open(page); await inspect(page);
  let release!:()=>void; state.generalBarrier=new Promise<void>(resolve=>{release=resolve;});
  await page.getByRole('button',{name:'Refresh repository settings',exact:true}).click();
  await expect(table(page)).toHaveCount(0);
  await expect(page.getByRole('button',{name:'Refresh access observation',exact:true})).toHaveCount(0);
  const reads=state.accessCalls; state.settings.revision=rev('c'); release();
  await expect(page.getByRole('button',{name:'Inspect access',exact:true})).toBeVisible(); expect(state.accessCalls).toBe(reads);
});

test('route navigation cancels held observation so its late denial cannot restore private rows',async({page})=>{
  const state=await backend(page); await open(page);
  let release!:()=>void; state.barrier=new Promise<void>(resolve=>{release=resolve;});
  await page.getByRole('button',{name:'Inspect access',exact:true}).click();
  await expect.poll(()=>state.reads.filter(r=>r.method==='GetRepositoryAccess').length).toBe(1);
  state.deny='permission_denied';
  await page.goto('/'); release();
  await expect(table(page)).toHaveCount(0);
  await expect(page.getByRole('link',{name:'Open access settings',exact:true})).toHaveCount(0);
});

test('current role loss retains honest view-only observations without additional administration probes',async({page})=>{
  const state=await backend(page); await open(page); await inspect(page);
  const initial=state.reads.filter(r=>inventories.includes(r.method)).length;
  state.access.canManage=false; state.access.currentPermission='read';
  await page.getByRole('button',{name:'Refresh access observation',exact:true}).click();
  await expect(table(page).getByText('View only · repository administration required')).toHaveCount(3);
  expect(state.reads.filter(r=>inventories.includes(r.method))).toHaveLength(initial);
  await expect(page.getByRole('table',{name:'Repository settings',exact:true}).locator('[data-row-id="access"]')).toContainText('Partial');
});

test('401 ends the managed session and clears earlier observation and settings',async({page})=>{
  const state=await backend(page); await open(page); await inspect(page);
  state.deny='unauthenticated'; state.denyMethod='ListRepositoryInvitations';
  await page.getByRole('button',{name:'Refresh access observation',exact:true}).click();
  await expect(page.getByRole('form',{name:'Golf account sign-in',exact:true})).toBeVisible();
  await expect(table(page)).toHaveCount(0);
  await expect(page.getByRole('link',{name:'Open access settings',exact:true})).toHaveCount(0);
});

test('logout aborts held inspection and late response cannot restore private observation',async({page})=>{
  const state=await backend(page); await open(page);
  let release!:()=>void; state.barrier=new Promise<void>(resolve=>{release=resolve;});
  await page.getByRole('button',{name:'Inspect access',exact:true}).click();
  await expect.poll(()=>state.reads.filter(r=>r.method==='GetRepositoryAccess').length).toBe(1);
  await page.getByLabel('Your account',{exact:true}).click();
  await page.getByRole('button',{name:'Sign out',exact:true}).click();
  await expect(page.getByRole('form',{name:'Golf account sign-in',exact:true})).toBeVisible(); release();
  await expect(table(page)).toHaveCount(0);
  await expect(page.getByRole('button',{name:'Inspect access',exact:true})).toHaveCount(0);
  expect(state.writes).toEqual([]);
});

for(const theme of ['dark','light']) for(const width of [1440,390]) test(`${theme}/${width} observation uses shared compact controls without overflow`,async({page})=>{
  await page.setViewportSize({width,height:1000});
  await page.addInitScript(value=>localStorage.setItem('golf.theme',value),theme);
  const state=await backend(page); await open(page); await inspect(page); await page.evaluate(()=>document.fonts.ready);
  await expect(page.locator('html')).toHaveAttribute('data-theme',theme);
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  const fonts=await page.evaluate(()=>document.fonts.check('14px Archivo')); expect(fonts).toBe(true);
  expect(state.writes).toEqual([]);
});

for(const mode of ['archived','mirror'] as const) test(`${mode} configuration remains implemented view-only rather than missing`,async({page})=>{
  const state=await backend(page); state.settings[mode]=true; state.settings.canEdit=false; state.access.canManage=false;
  await open(page); await inspect(page);
  await expect(table(page)).toContainText(mode==='archived'?'Archived · read only':'Mirror · read only');
  expect(state.reads.filter(r=>inventories.includes(r.method))).toEqual([]);
});
