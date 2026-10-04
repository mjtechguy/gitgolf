import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { create } from '@bufbuild/protobuf';
import { ListRepositoryTeamAccessResponseSchema, ListRepositoryDeployKeysResponseSchema, GetAuthenticationOptionsResponseSchema, GetRepositoryAccessResponseSchema, GetSessionResponseSchema, ListCapabilitiesResponseSchema, ListRepositoriesResponseSchema, ListRepositoryCollaboratorsRequestSchema, ListRepositoryCollaboratorsResponseSchema, LoginWithPasswordResponseSchema, LogoutResponseSchema, RemoveRepositoryCollaboratorRequestSchema, RemoveRepositoryCollaboratorResponseSchema, GetRepositoryAccessOperationRequestSchema, GetRepositoryAccessOperationResponseSchema, RepositoryAccessOperationSchema, RepositoryAccessSchema, RepositoryCollaboratorSchema, ResolveRepositoryCollaboratorRequestSchema, ResolveRepositoryCollaboratorResponseSchema, SetRepositoryCollaboratorRequestSchema, SetRepositoryCollaboratorResponseSchema, UserSchema } from '../src/gen/golf/v1/golf_pb';
import { emptyRepositoryInvitations, reject, request, respond } from './rpc';

const rev=(digit:string)=>digit.repeat(64);
const owner = create(UserSchema, { id: '9007199254740993', login: 'alex' });
const first = create(RepositoryCollaboratorSchema, { user: { id: '9007199254740994', login: 'first-reader' }, permission: 'read', isDirect: true, revision: rev('1'), generation:'0' });
const candidate = create(UserSchema, { id: '9007199254740997', login: 'new-collaborator' });
const path = '/repositories/alex/project/settings/access';
async function backend(page: Page) {
  const operations=new Map<string,ReturnType<typeof create<typeof RepositoryAccessOperationSchema>>>();
  const state = { operations, operationReads:[] as string[], operationDenied:false, malformedOperation:false, dropUnknown:false, signedIn: true, user: create(UserSchema, { id: '17', login: 'maintainer', isInstanceAdmin: true }), access: create(RepositoryAccessSchema, { owner, ownerId: owner.id, repositoryId: '9007199254740998', currentPermission: 'admin', canManage: true, revision: rev('2') }), collaborators: [first, create(RepositoryCollaboratorSchema, { user: { id: '17', login: 'maintainer' }, permission: 'admin', isDirect: true, revision: rev('3'), generation:'0' }), create(RepositoryCollaboratorSchema, { user: { id: '9007199254740995', login: '<literal-account>' }, permission: 'write', isDirect: true, revision: rev('4'), generation:'0' })], denied: false, listDenied: false, malformed: false, pages: [] as number[], resolves: [] as unknown[], requests: [] as unknown[], writes: [] as unknown[], drop: false, inherited: '' as string, barrier: undefined as Promise<void> | undefined, resolveBarrier: undefined as Promise<void> | undefined };
  await page.route('**/rpc/**', async (route) => {
    const method = new URL(route.request().url()).pathname.split('/').at(-1);
    if (method === 'GetAuthenticationOptions') return respond(route, GetAuthenticationOptionsResponseSchema, { localPasswordEnabled: true });
    if (method === 'LoginWithPassword') { state.signedIn = true; return respond(route, LoginWithPasswordResponseSchema, { user: state.user }); }
    if (method === 'Logout') { state.signedIn = false; return respond(route, LogoutResponseSchema, {}); }
    if (!state.signedIn) return reject(route, 'unauthenticated', 'Your session ended.');
    if (method === 'GetSession') return respond(route, GetSessionResponseSchema, { user: state.user });
    if (method === 'ListCapabilities') return respond(route, ListCapabilitiesResponseSchema, {});
    if (method === 'ListRepositories') return respond(route, ListRepositoriesResponseSchema, {});
    if (method === 'ListRepositoryDeployKeys') return respond(route, ListRepositoryDeployKeysResponseSchema, { repositoryId: state.access.repositoryId, ownerId: state.access.ownerId, accessRevision: state.access.revision, keys: [], page: { nextPage: 0 } });
    if (method === 'ListRepositoryTeamAccess') return respond(route, ListRepositoryTeamAccessResponseSchema, { repositoryId: state.access.repositoryId, ownerId: state.access.ownerId, accessRevision: state.access.revision, canManage: false, teams: [], page: {} });
    if (method === 'ListRepositoryInvitations') return emptyRepositoryInvitations(route);
    if (method === 'GetRepositoryAccess') return state.denied ? reject(route, 'not_found', 'Repository access unavailable.') : respond(route, GetRepositoryAccessResponseSchema, { access: state.access });
    if (method === 'ListRepositoryCollaborators') {
      if (state.listDenied) return reject(route, 'permission_denied', 'Collaborator inventory access denied.');
      const input = request(route, ListRepositoryCollaboratorsRequestSchema); const pageNumber = input.page?.page || 1; state.pages.push(pageNumber);
      expect(input.repositoryId).toBe(state.access.repositoryId); expect(input.ownerId).toBe(owner.id); expect(input.page?.limit).toBe(20);
      return respond(route, ListRepositoryCollaboratorsResponseSchema, { collaborators: state.malformed ? [{ ...first, user: undefined }] : state.collaborators.slice((pageNumber - 1) * 2, pageNumber * 2), page: { nextPage: state.collaborators.length > pageNumber * 2 ? pageNumber + 1 : 0 } });
    }
    if (method === 'ResolveRepositoryCollaborator') {
      const input = request(route, ResolveRepositoryCollaboratorRequestSchema); state.resolves.push(input);
      const known = state.collaborators.find((collaborator) => collaborator.user?.login === input.userLogin);
      const collaborator = known || create(RepositoryCollaboratorSchema, { user: input.userLogin === owner.login ? owner : candidate, permission: 'none', isDirect: false, revision: rev('5'), generation:'0' });
      if (state.resolveBarrier) await state.resolveBarrier;
      return respond(route, ResolveRepositoryCollaboratorResponseSchema, { collaborator });
    }
    if(method==='GetRepositoryAccessOperation'){const input=request(route,GetRepositoryAccessOperationRequestSchema);state.operationReads.push(input.idempotencyKey);if(state.operationDenied)return reject(route,'permission_denied','Original operation access denied.');const operation=operations.get(input.idempotencyKey);if(!operation)return reject(route,'not_found','Original operation not found.');return respond(route,GetRepositoryAccessOperationResponseSchema,{operation:state.malformedOperation?{...operation,generation:'0'}:operation});}
    if (method === 'SetRepositoryCollaborator' || method === 'RemoveRepositoryCollaborator') {
      const input = method === 'SetRepositoryCollaborator' ? request(route, SetRepositoryCollaboratorRequestSchema) : request(route, RemoveRepositoryCollaboratorRequestSchema);
      state.requests.push(input);
      if (!state.access.canManage || input.userId === owner.id || input.userId === state.user.id) return reject(route, 'permission_denied', 'Collaborator administration denied.');
      if (input.expectedRevision !== state.access.revision) return route.fulfill({status:400,headers:{'Golf-Access-Effect':'none'},contentType:'application/json',json:{code:'failed_precondition',message:'Repository authority changed.'}});
      const known = state.collaborators.find((collaborator) => collaborator.user?.id === input.userId);
      if (input.expectedCollaboratorRevision !== (known?.revision || rev('5'))) return reject(route, 'failed_precondition', 'Collaborator grant changed.');
      const target = known?.user || candidate;
      expect(target.id).toBe(input.userId); expect(target.login).toBe(input.userLogin); expect(input.ownerId).toBe(owner.id);
      state.writes.push(input); const remove = method === 'RemoveRepositoryCollaborator';
      const collaborator = create(RepositoryCollaboratorSchema, { user: target, permission: state.inherited || (remove ? 'none' : (input as { permission: string }).permission), isDirect: !remove, revision: rev('8'), generation:String(Number(known?.generation || '0')+1) });
      state.collaborators = state.collaborators.filter((entry) => entry.user?.id !== input.userId); if (!remove) state.collaborators.unshift(collaborator);
      expect(input.idempotencyKey).toMatch(/^[a-f0-9-]{36}$/);
      const operation=create(RepositoryAccessOperationSchema,{idempotencyKey:input.idempotencyKey,repository:input.repository,repositoryId:input.repositoryId,ownerId:input.ownerId,recipientId:input.userId,recipientLogin:input.userLogin,actorId:state.user.id,requestedPermission:remove?'':(input as {permission:string}).permission,remove,generation:collaborator.generation,phase:state.dropUnknown?'DISPATCH_UNKNOWN':'SUCCEEDED',createdAt:'2026-10-04T10:00:00Z',updatedAt:'2026-10-04T10:00:01Z',observedEffectivePermission:state.dropUnknown?'':collaborator.permission,observedDirectMembership:state.dropUnknown?false:collaborator.isDirect});operations.set(input.idempotencyKey,operation);
      if (state.barrier) await state.barrier;
      if (state.drop) return route.abort('failed');
      return remove ? respond(route, RemoveRepositoryCollaboratorResponseSchema, { collaborator,operation }) : respond(route, SetRepositoryCollaboratorResponseSchema, { collaborator,operation });
    }
    return reject(route, 'not_found', 'Unsupported access fixture.');
  });
  return state;
}
async function open(page: Page) { await page.goto(path); await expect(page.getByRole('table', { name: 'Repository collaborators', exact: true }).locator('tbody tr[data-row-id]')).toHaveCount(2); }
async function reviewNew(page: Page, permission = 'read') { await page.getByRole('button', { name: 'Add collaborator', exact: true }).click(); await page.getByLabel('Account username', { exact: true }).fill(candidate.login); await page.getByLabel('Requested permission', { exact: true }).selectOption(permission); await page.getByRole('button', { name: 'Resolve and review access', exact: true }).click(); await expect(page.getByRole('heading', { name: 'Review collaborator access', exact: true })).toBeVisible(); }

test('collaborator table searches and sorts loaded grants with exact IDs and locked own access', async ({ page }) => {
  const state = await backend(page); await open(page);
  await expect(page.getByRole('button', { name: 'Change access for maintainer', exact: true })).toHaveCount(0);
  const table = page.getByRole('table', { name: 'Repository collaborators', exact: true });
  const search = page.getByRole('searchbox', { name: 'Search loaded Repository collaborators', exact: true });
  await search.fill('<literal-account>'); await expect(table.locator('tbody tr[data-row-id]')).toHaveCount(0);
  expect(state.pages.every((pageNumber) => pageNumber === 1)).toBe(true);
  await page.getByRole('button', { name: 'Load more collaborators', exact: true }).click();
  await expect(table.getByText('<literal-account>', { exact: true })).toBeVisible(); await expect(table.locator('img')).toHaveCount(0);
  await search.fill(first.user!.id); await expect(table.locator('tbody tr[data-row-id]').first()).toHaveAttribute('data-row-id', first.user!.id);
  await search.fill(''); await table.getByRole('button', { name: 'Effective access', exact: true }).click(); await expect(table.getByRole('columnheader', { name: 'Effective access', exact: true })).toHaveAttribute('aria-sort', 'ascending');
});

test('admin access requires explicit identity/grant review and duplicate apply clicks dispatch once', async ({ page }) => {
  const state = await backend(page); await open(page); await reviewNew(page, 'admin');
  await expect(page.getByText('Admin can manage access and delete this repository. Apply only if this account should have that authority.', { exact: true })).toBeVisible(); expect(state.writes).toHaveLength(0);
  let release!: () => void; state.barrier = new Promise<void>((resolve) => { release = resolve; });
  await page.getByRole('button', { name: 'Apply reviewed access', exact: true }).evaluate((button) => { (button as HTMLButtonElement).click(); (button as HTMLButtonElement).click(); }); await expect.poll(() => state.writes.length).toBe(1); release();
  await expect(page.getByText(/^Requested direct permission acknowledged:/)).toBeVisible();
  expect(state.writes).toMatchObject([{ repositoryId: state.access.repositoryId, ownerId: owner.id, userId: candidate.id, userLogin: candidate.login, permission: 'admin', expectedRevision: rev('2'), expectedCollaboratorRevision: rev('5') }]);
  await expect(page.getByLabel('Account username', { exact: true })).toHaveCount(0); await expect(page.getByRole('dialog')).toHaveCount(0);
});

test('change editor cancels drafts and changing a requested grant invalidates its identity review', async ({ page }) => {
  const state = await backend(page); await open(page);
  const change = page.getByRole('button', { name: 'Change access for first-reader', exact: true });
  await change.click(); await expect(page.getByLabel('Account username', { exact: true })).toBeDisabled(); await expect(page.getByLabel('Requested permission', { exact: true })).toBeFocused();
  await page.getByLabel('Requested permission', { exact: true }).selectOption('write'); await page.getByRole('button', { name: 'Cancel', exact: true }).click(); await expect(change).toBeFocused(); expect(state.writes).toHaveLength(0);
  await change.click(); await expect(page.getByLabel('Requested permission', { exact: true })).toHaveValue('');
  await page.getByLabel('Requested permission', { exact: true }).selectOption('write'); await page.getByRole('button', { name: 'Resolve and review access', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Review collaborator access', exact: true })).toBeVisible(); await page.getByLabel('Requested permission', { exact: true }).selectOption('admin'); await expect(page.getByRole('heading', { name: 'Review collaborator access', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Resolve and review access', exact: true }).click(); await page.getByRole('button', { name: 'Apply reviewed access', exact: true }).click(); await expect(page.getByText(/^Requested direct permission acknowledged:/)).toBeVisible();
  expect(state.writes).toMatchObject([{ userId: first.user!.id, permission: 'admin', expectedCollaboratorRevision: rev('1') }]);
});

test('removal uses a short keyboard confirmation and preserves immutable target bindings', async ({ page }) => {
  const state = await backend(page); await open(page); const remove = page.getByRole('button', { name: 'Remove collaborator first-reader', exact: true });
  await remove.click(); await expect(page.getByRole('button', { name: 'Cancel', exact: true })).toBeFocused(); await page.keyboard.press('Escape'); await expect(remove).toBeFocused(); expect(state.writes).toHaveLength(0);
  await remove.click(); await page.getByRole('button', { name: 'Confirm remove collaborator', exact: true }).click(); await expect(page.getByText('Direct collaborator removed. Other grants may still provide access.', { exact: true })).toBeVisible();
  expect(state.writes).toMatchObject([{ userId: first.user!.id, expectedCollaboratorRevision: rev('1') }]); await expect(remove).toHaveCount(0);
});

test('lost grant response blocks retries until inspection and later inventory denial removes private rows', async ({ page }) => {
  const state = await backend(page); state.drop = true; await open(page); await reviewNew(page, 'write'); await page.getByRole('button', { name: 'Apply reviewed access', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Access change could not be confirmed', exact: true })).toBeVisible(); await expect(page.getByRole('button', { name: 'Add collaborator', exact: true })).toBeDisabled(); expect(state.writes).toHaveLength(1);
  await page.getByRole('button', { name: 'Refresh repository access', exact: true }).click(); await expect(page.getByRole('table', { name: 'Repository collaborators', exact: true }).getByText(candidate.login, { exact: true })).toBeVisible(); expect(state.writes).toHaveLength(1);
  state.listDenied = true; await page.getByRole('button', { name: 'Load more collaborators', exact: true }).click(); await expect(page.getByRole('alert')).toHaveText('Collaborator inventory access denied.'); await expect(page.getByRole('table', { name: 'Repository collaborators', exact: true })).toHaveCount(0);
});

test('changed repository or collaborator revisions are not silently adopted', async ({ page }) => {
  const state = await backend(page); await open(page); await reviewNew(page);
  state.access.revision = rev('6'); await page.getByRole('button', { name: 'Apply reviewed access', exact: true }).click(); await expect(page.getByRole('heading', { name: 'Access change was refused', exact: true })).toBeVisible(); expect(state.writes).toHaveLength(0); expect(state.requests).toMatchObject([{ expectedRevision: rev('2') }]);
  await page.getByRole('button',{name:'Dismiss refused request',exact:true}).click(); await page.getByRole('button', { name: 'Change access for first-reader', exact: true }).click(); await page.getByLabel('Requested permission',{exact:true}).selectOption('write'); state.collaborators[0] = { ...first, revision: rev('7'), permission: 'write' }; await page.getByRole('button', { name: 'Resolve and review access', exact: true }).click(); await expect(page.getByRole('alert')).toHaveText('Collaborator access changed. Refresh and review it again.'); await expect(page.getByRole('heading', { name: 'Review collaborator access', exact: true })).toHaveCount(0); expect(state.writes).toHaveLength(0);
});

for (const kind of ['read-only', 'organization-owned', 'exceptional owner'] as const) test(`${kind} displays inventory without fake administration even with a Golf instance role`, async ({ page }) => {
  const state = await backend(page); state.access.canManage = kind !== 'read-only'; state.access.organizationOwned = kind === 'organization-owned'; state.access.currentPermission = kind === 'exceptional owner' ? 'owner' : 'read'; await page.goto(path); await expect(page.getByRole('heading', { name: 'Repository access', exact: true })).toBeVisible(); await expect(page.getByText('Managing collaborators requires current repository administration, with verified ownership or direct administrator access. Organization membership is also required for organization repositories.', { exact: true })).toBeVisible(); await expect(page.getByRole('table', { name: 'Repository collaborators', exact: true })).toHaveCount(0); expect(state.pages).toHaveLength(0);
  await expect(page.getByRole('button', { name: 'Add collaborator', exact: true })).toHaveCount(0); await expect(page.getByRole('button', { name: /^Change access for/ })).toHaveCount(0); await expect(page.getByRole('button', { name: /^Remove collaborator/ })).toHaveCount(0);
  await page.setViewportSize({ width: 390, height: 844 }); expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true); expect(state.writes).toHaveLength(0);
});

test('owner identities cannot become reviewed collaborator mutations', async ({ page }) => {
  const state = await backend(page); await open(page); await page.getByRole('button', { name: 'Add collaborator', exact: true }).click(); await page.getByLabel('Account username', { exact: true }).fill(owner.login); await page.getByRole('button', { name: 'Resolve and review access', exact: true }).click();
  await expect(page.getByRole('alert')).toHaveText('Owner, self and exceptional owner-level access cannot be changed here.'); await expect(page.getByRole('button', { name: 'Apply reviewed access', exact: true })).toHaveCount(0); expect(state.writes).toHaveLength(0);
});

test('pending resolve cancellation and late write navigation cannot restore discarded previews or receipts', async ({ page }) => {
  const state = await backend(page); await open(page); let releaseResolve!: () => void; state.resolveBarrier = new Promise<void>((resolve) => { releaseResolve = resolve; }); await page.getByRole('button', { name: 'Add collaborator', exact: true }).click(); await page.getByLabel('Account username', { exact: true }).fill(candidate.login); await page.getByRole('button', { name: 'Resolve and review access', exact: true }).click(); await expect.poll(() => state.resolves.length).toBe(1); await page.getByRole('button', { name: 'Cancel', exact: true }).click(); state.resolveBarrier = undefined; releaseResolve();
  await reviewNew(page); let releaseWrite!: () => void; state.barrier = new Promise<void>((resolve) => { releaseWrite = resolve; }); await page.getByRole('button', { name: 'Apply reviewed access', exact: true }).click(); await expect.poll(() => state.writes.length).toBe(1); await page.getByRole('navigation', { name: 'Workspace', exact: true }).getByRole('link', { name: 'Repositories', exact: false }).click(); releaseWrite(); await page.goto(path);
  await expect(page.getByRole('table', { name: 'Repository collaborators', exact: true }).getByText(candidate.login, { exact: true })).toBeVisible(); await expect(page.getByRole('heading', { name: 'Review collaborator access', exact: true })).toHaveCount(0); await expect(page.getByText(/^Requested direct permission acknowledged:/)).toHaveCount(0); expect(state.writes).toHaveLength(1);
});

test('account switch hides former access and malformed inventory does not become a fabricated empty result', async ({ page }) => {
  const state = await backend(page); await open(page); await reviewNew(page); await page.getByLabel('Your account', { exact: true }).click(); await page.getByRole('button', { name: 'Sign out', exact: true }).click(); await expect(page.getByRole('heading', { name: 'Welcome to Golf', exact: true })).toBeVisible(); state.user = create(UserSchema, { id: '19', login: 'other' }); state.denied = true; await page.getByLabel('Email or username', { exact: true }).fill('fixture-account'); await page.getByLabel('Password', { exact: true }).fill('other-token'); await page.getByRole('button', { name: 'Sign in', exact: true }).click(); await expect(page.getByRole('alert')).toHaveText('Repository access unavailable.'); await expect(page.getByRole('table', { name: 'Repository collaborators', exact: true })).toHaveCount(0); await expect(page.getByRole('heading', { name: 'Review collaborator access', exact: true })).toHaveCount(0);
  state.denied = false; state.malformed = true; await page.reload(); await expect(page.getByRole('alert')).toHaveText('Collaborator metadata is incomplete.'); await expect(page.getByRole('table', { name: 'Repository collaborators', exact: true })).toHaveCount(0);
});

for (const theme of ['dark', 'light']) for (const width of [390, 1440]) test(`${theme} ${width} keeps access headings intact and actions compact`, async ({ page }) => {
  await page.addInitScript(value => localStorage.setItem('golf.theme', value), theme);
  await page.setViewportSize({ width, height: 950 }); await backend(page); await open(page);
  const section = page.getByRole('region', { name: 'Collaborators', exact: true });
  const heading = section.getByRole('heading', { name: 'Collaborators', exact: true });
  expect(await heading.evaluate(node => { const range = document.createRange(); range.selectNodeContents(node); return range.getClientRects().length; })).toBe(1);
  await expect(section.getByRole('button', { name: 'Refresh repository access', exact: true })).toHaveAttribute('title', 'Refresh repository access');
  await expect(section.getByRole('button', { name: 'Change access for first-reader', exact: true })).toHaveAttribute('title', 'Change access');
  await expect(section.getByRole('button', { name: 'Remove collaborator first-reader', exact: true })).toHaveAttribute('title', 'Remove collaborator');
  const details = section.locator('details').filter({ hasText: 'About repository access' });
  await expect(details).not.toHaveAttribute('open');
  await details.getByText('About repository access', { exact: true }).click();
  await expect(details.getByText(/Instance administration does not grant access/)).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await details.getByText('About repository access', { exact: true }).click();
  await page.screenshot({ path: `.tmp/access-density-source/${theme}-${width}.png`, fullPage: true });
});

test('organization direct administrator manages requested roles while effective team access remains higher', async ({ page }) => {
 const state = await backend(page); state.access.organizationOwned = true; state.inherited = 'admin'; state.collaborators[0] = { ...first, permission: 'admin' }; await open(page);
 await expect(page.getByRole('heading',{name:'Deploy keys',exact:true})).toBeVisible();
 await page.getByRole('button',{name:'Change access for first-reader',exact:true}).click();
 await expect(page.getByLabel('Requested permission',{exact:true})).toHaveValue('');
 await page.getByRole('button',{name:'Resolve and review access',exact:true}).click();
 await expect(page.getByRole('alert')).toHaveText('Choose an existing account username and a supported permission.'); expect(state.resolves).toHaveLength(0);
 await page.getByLabel('Requested permission',{exact:true}).selectOption('read'); await page.getByRole('button',{name:'Resolve and review access',exact:true}).click();
 await expect(page.getByText('Current effective access',{exact:true})).toBeVisible(); await expect(page.getByText('Current direct grant',{exact:true})).toHaveCount(0);
 await page.getByRole('button',{name:'Apply reviewed access',exact:true}).click();
 await expect(page.getByText('Requested direct permission acknowledged: read. Effective access is observed separately.',{exact:true})).toBeVisible();
 expect(state.writes).toMatchObject([{ permission:'read', userId:first.user!.id }]);
 const row = page.getByRole('table',{name:'Repository collaborators',exact:true}).locator(`tr[data-row-id="${first.user!.id}"]`); await expect(row.getByText('admin',{exact:true})).toBeVisible();
 await row.getByRole('button',{name:'Remove collaborator first-reader',exact:true}).click(); await page.getByRole('button',{name:'Confirm remove collaborator',exact:true}).click();
 await expect(page.getByText('Direct collaborator removed. Other grants may still provide access.',{exact:true})).toBeVisible(); expect(state.writes).toHaveLength(2);
});

test('organization owner uses server authority and no permission is inferred from its namespace', async ({ page }) => {
 const state=await backend(page); state.access.organizationOwned=true; state.access.currentPermission='owner'; await open(page); await expect(page.getByRole('button',{name:'Add collaborator',exact:true})).toBeVisible();
 state.access.canManage=false; await page.getByRole('button',{name:'Refresh repository access',exact:true}).click(); await expect(page.getByRole('button',{name:'Add collaborator',exact:true})).toHaveCount(0); await expect(page.getByRole('heading',{name:'Deploy keys',exact:true})).toHaveCount(0);
});

test('lost acknowledgement reload inspects only the original key and an unresolved receipt never enables retry', async ({page})=>{
 const state=await backend(page);state.drop=true;state.dropUnknown=true;await open(page);await reviewNew(page,'write');await page.getByRole('button',{name:'Apply reviewed access',exact:true}).click();
 await expect(page.getByRole('heading',{name:'Access change could not be confirmed',exact:true})).toBeVisible();
 const [original]=state.operations.keys();expect(original).toBeTruthy();
 await page.reload();await expect(page.getByText('Original operation remains unresolved. No retry is available.',{exact:true})).toBeVisible();
 expect(state.operationReads.every(key=>key===original)).toBe(true);expect(state.writes).toHaveLength(1);expect(state.requests).toHaveLength(1);
 await expect(page.getByRole('button',{name:'Add collaborator',exact:true})).toBeDisabled();
 await expect(page.getByRole('button',{name:'Finish inspection',exact:true})).toHaveCount(0);
 await page.getByRole('button',{name:'Inspect original operations',exact:true}).click();await expect(page.getByText('Original operation remains unresolved. No retry is available.',{exact:true})).toBeVisible();expect(state.writes).toHaveLength(1);
 const stored=await page.evaluate(()=>Object.entries(sessionStorage).filter(([key])=>key.startsWith('golf.access-intent.')).map(([,value])=>JSON.parse(value)));
 expect(stored).toHaveLength(1);expect(Object.keys(stored[0]).sort()).toEqual(['accessRevision','key','ownerId','permission','recipientId','recipientRevision','remove','repositoryId']);expect(JSON.stringify(stored)).not.toContain(candidate.login);
});
test('acknowledged historical original can be explicitly finished after response loss without replaying the write', async({page})=>{
 const state=await backend(page);state.drop=true;await open(page);await reviewNew(page);await page.getByRole('button',{name:'Apply reviewed access',exact:true}).click();
 await expect(page.getByText('Requested access operation was acknowledged. This receipt is historical.',{exact:true})).toBeVisible();
 await page.reload();await expect(page.getByText('Requested access operation was acknowledged. This receipt is historical.',{exact:true})).toBeVisible();
 await page.getByRole('button',{name:'Finish inspection',exact:true}).click();await expect(page.getByRole('button',{name:'Add collaborator',exact:true})).toBeEnabled();expect(state.writes).toHaveLength(1);expect(state.requests).toHaveLength(1);
});
test('malformed original receipt cannot clear intent or enable a replacement', async({page})=>{
 const state=await backend(page);state.drop=true;state.malformedOperation=true;await open(page);await reviewNew(page);await page.getByRole('button',{name:'Apply reviewed access',exact:true}).click();
 await expect(page.getByText('Original operation is unavailable. The original key is retained; no request was retried.',{exact:true})).toBeVisible();
 await expect(page.getByRole('button',{name:'Finish inspection',exact:true})).toHaveCount(0);await expect(page.getByRole('button',{name:'Add collaborator',exact:true})).toBeDisabled();expect(state.requests).toHaveLength(1);
});
test('denial during original inspection hides private inventory and preserves only the original metadata', async({page})=>{
 const state=await backend(page);state.drop=true;state.operationDenied=true;await open(page);await reviewNew(page);await page.getByRole('button',{name:'Apply reviewed access',exact:true}).click();
 await expect(page.getByRole('alert')).toHaveText('Original operation access denied.');await expect(page.getByRole('table',{name:'Repository collaborators',exact:true})).toHaveCount(0);await expect(page.getByText(candidate.login,{exact:true})).toHaveCount(0);
 expect(await page.evaluate(()=>Object.keys(sessionStorage).filter(key=>key.startsWith('golf.access-intent.')).length)).toBe(1);expect(state.requests).toHaveLength(1);
});
test('malformed original metadata fails closed without source, status or mutation probes',async({page})=>{
 const state=await backend(page);await page.addInitScript(()=>sessionStorage.setItem(`golf.access-intent.${location.origin}:17:9007199254740998:9007199254740997`,JSON.stringify({key:'not-an-original-key'})));await open(page);
 await expect(page.getByText('Original access operation metadata is unavailable. No new change can be sent; sign out before switching accounts or targets.',{exact:true})).toBeVisible();await expect(page.getByRole('button',{name:'Add collaborator',exact:true})).toBeDisabled();expect(state.operationReads).toHaveLength(0);expect(state.resolves).toHaveLength(0);expect(state.requests).toHaveLength(0);
});
