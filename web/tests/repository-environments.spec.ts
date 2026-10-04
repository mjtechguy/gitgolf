import { expect, test, type Page } from '@playwright/test';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { create, clone } from '@bufbuild/protobuf';
import { RepositoryEnvironmentAction as Action, RepositoryEnvironmentCapability as Capability, RepositoryEnvironmentSchema, RepositoryEnvironmentPolicySchema, RepositoryEnvironmentOperationSchema, RepositoryEnvironmentTargetSchema, GetRepositoryAccessResponseSchema, ListRepositoryEnvironmentsRequestSchema, ListRepositoryEnvironmentsResponseSchema, SaveRepositoryEnvironmentRequestSchema, SaveRepositoryEnvironmentResponseSchema, DeleteRepositoryEnvironmentRequestSchema, DeleteRepositoryEnvironmentResponseSchema, GetRepositoryEnvironmentOperationRequestSchema, GetRepositoryEnvironmentOperationResponseSchema, ResolveRepositoryCollaboratorResponseSchema, type RepositoryEnvironment, type SaveRepositoryEnvironmentRequest, type DeleteRepositoryEnvironmentRequest } from '../src/gen/golf/v1/golf_pb';
import { request, respond, reject } from './rpc';

// The spec owns its ignored Vite fixture, keeping product integration and shared
// fixtures untouched. It imports real global CSS/fonts and the actual component.
let fixture = '';
let fixtureFiles: string[] = [];
test.beforeAll(async ({}, worker) => {
  const directory = resolve('.tmp'); await mkdir(directory, { recursive: true });
  const name = `environment-source-${worker.workerIndex}`;
  fixtureFiles = [resolve(directory, `${name}.html`), resolve(directory, `${name}.tsx`)]; fixture = `/.tmp/${name}.html`;
  await writeFile(fixtureFiles[1]!, `import {useState} from 'react';import {createRoot} from 'react-dom/client';import {QueryClient,QueryClientProvider} from '@tanstack/react-query';import {createClient} from '@connectrpc/connect';import {createConnectTransport} from '@connectrpc/connect-web';import {RepositoryEnvironmentService} from '../src/gen/golf/v1/golf_pb';import {RepositoryEnvironments} from '../src/RepositoryEnvironments';import '../src/styles.css';
const client=createClient(RepositoryEnvironmentService,createConnectTransport({baseUrl:location.origin+'/rpc',useBinaryFormat:false}));const q=new QueryClient({defaultOptions:{queries:{retry:false}}});document.documentElement.dataset.theme=localStorage.getItem('golf.theme')||'dark';function Host(){const[p,set]=useState({userId:'42',owner:'alice',name:'example',signingOut:false,revalidating:false,passwordConfirmationAvailable:!location.search.includes('oauth')});return <QueryClientProvider client={q}><main className="workspace-content"><div className="credential-actions"><button onClick={()=>set(v=>({...v,revalidating:true}))}>Fixture revalidate</button><button onClick={()=>set(v=>({...v,revalidating:false}))}>Fixture restore access</button><button onClick={()=>set(v=>({...v,userId:'43'}))}>Fixture switch account</button><button onClick={()=>set(v=>({...v,userId:'42'}))}>Fixture restore account</button><button onClick={()=>set(v=>({...v,signingOut:true}))}>Fixture logout</button></div><RepositoryEnvironments {...p} client={client}/></main></QueryClientProvider>}createRoot(document.getElementById('root')!).render(<Host/>);`);
  await writeFile(fixtureFiles[0]!, `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Environment source fixture</title></head><body><div id="root"></div><script type="module" src="./${name}.tsx"></script></body></html>`);
});
test.afterAll(async () => { for (const file of fixtureFiles) await rm(file, { force: true }); });
const stamp = '2026-10-04T00:00:00Z';
const id = '11111111-1111-4111-8111-111111111111';
const second = '22222222-2222-4222-8222-222222222222';
const target = () => create(RepositoryEnvironmentTargetSchema, { repository: { owner: 'alice', name: 'example' }, repositoryId: '9007199254740993', ownerId: '42', accessRevision: 'a'.repeat(64) });
const policy = () => create(RepositoryEnvironmentPolicySchema, { allowAllSources: true, preventSelfApproval: true, protectedPreviews: true, maxConcurrency: 1, previewTtlSeconds: 3600 });
const row = (name = 'Preview', rowId = id) => create(RepositoryEnvironmentSchema, { id: rowId, target: target(), name, version: '1', policy: policy(), creatorId: '42', updaterId: '42', createdAt: stamp, updatedAt: stamp, capability: Capability.CONFIGURATION_ONLY });
async function backend(page: Page) {
  const state = { rows: [row()], saves: [] as SaveRepositoryEnvironmentRequest[], deletes: [] as DeleteRepositoryEnvironmentRequest[], reads: 0, lookups: 0, inspections: 0, accessReads: 0, accessRevision: 'a'.repeat(64), permission: 'owner', canManage: true, mode: 'success', statusMissing: false, denied: false, malformed: '', receiptBad: '', barrier: undefined as Promise<void> | undefined, operations: new Map<string, { environment: RepositoryEnvironment; operation: ReturnType<typeof create<typeof RepositoryEnvironmentOperationSchema>> }>() };
  await page.route('**/rpc/**', async route => {
    const method = route.request().url().split('/').at(-1);
    if (method === 'GetRepositoryAccess') { state.accessReads++; if (state.denied) return reject(route, 'permission_denied', 'Current ordinary repository administrator required.'); return respond(route, GetRepositoryAccessResponseSchema, { access: { repositoryId: state.malformed === 'access-id' ? '01' : target().repositoryId, ownerId: '42', owner: { id: '42', login: 'alice' }, revision: state.accessRevision, currentPermission: state.permission, canManage: state.canManage } }); }
    if (method === 'ResolveRepositoryCollaborator') { state.lookups++; if (state.denied) return reject(route, 'permission_denied', 'Reviewer lookup authority was revoked.'); return respond(route, ResolveRepositoryCollaboratorResponseSchema, { collaborator: { user: { id: '43', login: 'reviewer' }, permission: 'read', isDirect: true, revision: 'b'.repeat(64), generation: '0' } }); }
    if (method === 'ListRepositoryEnvironments') {
      state.reads++; const input = request(route, ListRepositoryEnvironmentsRequestSchema); expect(input.target).toMatchObject({ ...target(), accessRevision: state.accessRevision });
      if (state.denied) return reject(route, 'permission_denied', 'Current ordinary repository administrator required.');
      const p = input.page?.page || 1; const rows = state.rows.filter(r => !r.deleted).slice((p - 1) * 20, p * 20).map(r => create(RepositoryEnvironmentSchema, r));
      const r = create(ListRepositoryEnvironmentsResponseSchema, { target: { ...target(), accessRevision: state.accessRevision }, environments: rows, totalCount: String(state.rows.filter(r => !r.deleted).length), page: { nextPage: p * 20 < state.rows.filter(r => !r.deleted).length ? p + 1 : 0 }, capability: Capability.CONFIGURATION_ONLY });
      if (state.malformed === 'target') r.target!.repositoryId = '123';
      if (state.malformed === 'total') r.totalCount = '01';
      if (state.malformed === 'page') r.page!.nextPage = 9;
      if (state.malformed === 'duplicate') { r.environments.push(rows[0]!); r.totalCount = '2'; }
      if (state.malformed === 'version') rows[0]!.version = '0';
      if (state.malformed === 'protection') rows[0]!.policy!.protectedPreviews = false;
      if (state.malformed === 'capability') r.capability = Capability.UNSPECIFIED;
      if (state.malformed === 'deployment') r.deploymentAvailable = true;
      if (state.malformed === 'policy') rows[0]!.policy = undefined;
      // create() owns its copied array/children; update that bound response.
      if (['version', 'protection', 'policy'].includes(state.malformed)) r.environments = rows;
      return respond(route, ListRepositoryEnvironmentsResponseSchema, r);
    }
    if (method === 'GetRepositoryEnvironmentOperation') {
      state.inspections++; const input = request(route, GetRepositoryEnvironmentOperationRequestSchema); expect(input.target?.accessRevision).toBe(state.accessRevision);
      if (state.denied) return reject(route, 'permission_denied', 'Current authority was revoked.');
      const found = state.operations.get(input.operationId); if (!found || state.statusMissing) return reject(route, 'not_found', 'Original operation not available.'); return respond(route, GetRepositoryEnvironmentOperationResponseSchema, found);
    }
    const deleting = method === 'DeleteRepositoryEnvironment'; expect(['SaveRepositoryEnvironment', 'DeleteRepositoryEnvironment']).toContain(method);
    const input = deleting ? request(route, DeleteRepositoryEnvironmentRequestSchema) : request(route, SaveRepositoryEnvironmentRequestSchema);
    if (deleting) state.deletes.push(input as DeleteRepositoryEnvironmentRequest); else state.saves.push(input as SaveRepositoryEnvironmentRequest);
    expect(input.currentPassword).toBe('fixture current password'); expect(input.target).toMatchObject({ ...target(), accessRevision: state.accessRevision });
    if (state.barrier) await state.barrier;
    if (state.mode === 'stale') return route.fulfill({ status: 409, json: { code: 'aborted', message: 'Environment changed; inspect the current configuration before a new action.' } });
    if (state.mode === 'denied') { state.denied = true; return reject(route, 'permission_denied', 'Current authority was revoked.'); }
    const old = state.rows.find(r => r.id === input.environmentId);
    const r = create(RepositoryEnvironmentSchema, { id: input.environmentId, target: input.target, name: deleting ? old!.name : (input as SaveRepositoryEnvironmentRequest).name, version: String(BigInt(input.expectedVersion) + 1n), policy: deleting ? old!.policy : (input as SaveRepositoryEnvironmentRequest).policy, deleted: deleting, creatorId: old?.creatorId || '42', updaterId: '42', createdAt: old?.createdAt || stamp, updatedAt: stamp, capability: Capability.CONFIGURATION_ONLY });
    const op = create(RepositoryEnvironmentOperationSchema, { operationId: input.operationId, environmentId: r.id, target: input.target, actorId: '42', action: deleting ? Action.DELETE : Action.SAVE, expectedVersion: input.expectedVersion, version: r.version, state: 'SUCCEEDED', createdAt: stamp });
    state.rows = [...state.rows.filter(e => e.id !== r.id), r]; state.operations.set(input.operationId, { environment: r, operation: op });
    if (state.mode === 'lost') return route.abort('failed');
    const shown = clone(RepositoryEnvironmentSchema, r), shownOp = clone(RepositoryEnvironmentOperationSchema, op);
    if (state.receiptBad === 'id') shown.id = second;
    if (state.receiptBad === 'version') shown.version = input.expectedVersion;
    if (state.receiptBad === 'actor') shownOp.actorId = '43';
    if (state.receiptBad === 'body') shown.policy!.waitSeconds++;
    if (state.receiptBad === 'target') shownOp.target!.ownerId = '123';
    if (state.receiptBad === 'deployment') shown.deploymentAvailable = true;
    return respond(route, deleting ? DeleteRepositoryEnvironmentResponseSchema : SaveRepositoryEnvironmentResponseSchema, { environment: shown, operation: shownOp });
  }); return state;
}
async function open(page: Page, suffix = '') { await page.goto(fixture + suffix); await expect(page.getByRole('heading', { name: 'Environments', exact: true })).toBeVisible(); await page.evaluate(() => document.fonts.ready); }
async function edit(page: Page) { await page.getByRole('button', { name: 'Edit environment Preview', exact: true }).click(); await expect(page.getByRole('form', { name: 'Environment configuration editor' })).toBeVisible(); }
async function password(page: Page) { await page.getByLabel('Current Golf password', { exact: true }).fill('fixture current password'); }

test('current inventory leads, details and forms are requested; save preserves exact IDs/version/policy', async ({ page }) => {
  const state = await backend(page); await open(page); await expect(page.getByRole('table', { name: 'Repository environments', exact: true })).toContainText('Preview'); await expect(page.getByRole('form')).toHaveCount(0); await expect(page.getByText('Deployment unavailable.', { exact: false })).toBeVisible();
  await edit(page); await page.getByLabel('Wait before deployment (seconds)').fill('120'); await password(page); await page.getByRole('button', { name: 'Save environment', exact: true }).click(); await expect(page.getByRole('status')).toContainText('Environment configuration saved.');
  expect(state.saves).toHaveLength(1); expect(state.saves[0]).toMatchObject({ target: target(), environmentId: id, expectedVersion: '1', name: 'Preview', policy: { waitSeconds: 120, preventSelfApproval: true, allowAdminBypass: false, protectedPreviews: true } }); await expect(page.getByRole('form')).toHaveCount(0);
  await page.reload(); await expect(page.getByRole('table', { name: 'Repository environments', exact: true })).toContainText('Preview'); await page.getByText('Policy details', { exact: true }).click(); await expect(page.getByText('120s / 1 deployment slots')).toBeVisible(); expect(state.saves).toHaveLength(1);
});
test('create exact typed restrictions and verified reviewer without manual native-ID fields', async ({ page }) => {
  const state = await backend(page); state.rows = []; await open(page); await page.getByRole('button', { name: 'Add environment', exact: true }).click(); await page.getByLabel('Name', { exact: true }).fill('Preview ü'); await page.getByLabel('Allow all sources').uncheck(); await page.getByLabel('Source 1 exact name or commit').fill('release/next'); await page.getByLabel('Reviewer username').fill('reviewer'); await page.getByRole('button', { name: 'Look up and add reviewer' }).click(); await expect(page.getByRole('list', { name: 'Selected environment reviewers' })).toContainText('reviewer'); await password(page); await page.getByRole('button', { name: 'Save environment', exact: true }).click(); await expect(page.getByRole('status')).toContainText('Environment configuration saved.'); expect(state.lookups).toBe(1); expect(state.saves[0]).toMatchObject({ expectedVersion: '0', policy: { sources: [{ kind: 2, name: 'release/next' }], reviewers: [{ id: '43', login: 'reviewer' }], requiredApprovals: 1 } });
});
test('invalid wildcard/policy does not create an operation or send a mutation', async ({ page }) => {
  const state = await backend(page); await open(page); await edit(page); await page.getByLabel('Allow all sources').uncheck(); await page.getByLabel('Source 1 exact name or commit').fill('release/*'); await password(page); await page.getByRole('button', { name: 'Save environment', exact: true }).click(); await expect(page.getByRole('alert')).toContainText('Use a bounded name'); expect(state.saves).toHaveLength(0); expect(await page.evaluate(() => Object.keys(sessionStorage).filter(k => k.startsWith('golf.environment-operation')))).toEqual([]);
});
test('lost acknowledgement persists metadata only, reload inspects original exactly once without resend', async ({ page }) => {
  const state = await backend(page); state.mode = 'lost'; await open(page); await edit(page); await page.getByLabel('Name', { exact: true }).fill('Private changed name'); await password(page); await page.getByRole('button', { name: 'Save environment', exact: true }).click(); await expect(page.getByRole('heading', { name: 'Environment change needs inspection' })).toBeVisible(); expect(state.saves).toHaveLength(1);
  const stored = await page.evaluate(() => Object.entries(sessionStorage).filter(([k]) => k.startsWith('golf.environment-operation'))); expect(stored).toHaveLength(1); expect(stored[0]![1]).not.toMatch(/password|Private changed name|policy|reviewers|waitSeconds/);
  await page.reload(); await expect(page.getByRole('heading', { name: 'Environment change needs inspection' })).toBeVisible(); expect(state.inspections).toBe(0); expect(state.saves).toHaveLength(1); await page.getByRole('button', { name: 'Inspect original environment operation' }).click(); await expect(page.getByRole('status')).toContainText('Historical local receipt'); expect(state.inspections).toBe(1); expect(state.saves).toHaveLength(1); await expect(page.getByRole('button', { name: 'Add environment', exact: true })).toBeDisabled(); await page.getByRole('button', { name: 'Finish operation inspection' }).click(); await expect(page.getByRole('button', { name: 'Add environment', exact: true })).toBeEnabled();
});
test('missing original status remains inspection-only through refresh, no automatic fresh key', async ({ page }) => {
  const state = await backend(page); state.mode = 'lost'; state.statusMissing = true; await open(page); await edit(page); await password(page); await page.getByRole('button', { name: 'Save environment', exact: true }).click(); await expect(page.getByRole('heading', { name: 'Environment change needs inspection' })).toBeVisible(); await page.getByRole('button', { name: 'Inspect original environment operation' }).click(); await expect(page.getByRole('alert')).toContainText('Original operation not available'); await page.getByRole('button', { name: 'Refresh environments' }).click(); await expect(page.getByRole('button', { name: 'Add environment', exact: true })).toBeDisabled(); expect(state.saves).toHaveLength(1);
});
for (const malformed of ['target', 'total', 'page', 'duplicate', 'version', 'protection', 'capability', 'deployment', 'policy', 'access-id']) test(`reject ${malformed} inventory before editable controls`, async ({ page }) => {
  const state = await backend(page); state.malformed = malformed; await open(page); await expect(page.getByRole('alert')).toBeVisible(); await expect(page.getByRole('table', { name: 'Repository environments', exact: true })).toHaveCount(0); await expect(page.getByRole('button', { name: 'Add environment', exact: true })).toBeDisabled(); expect(state.saves).toHaveLength(0); if (malformed === 'access-id') expect(state.reads).toBe(0);
});
for (const bad of ['id', 'version', 'actor', 'body', 'target', 'deployment']) test(`wrong ${bad} mutation receipt cannot grant success or unlock new intent`, async ({ page }) => {
  const state = await backend(page); state.receiptBad = bad; await open(page); await edit(page); await password(page); await page.getByRole('button', { name: 'Save environment', exact: true }).click(); await expect(page.getByRole('alert')).toContainText('does not match'); await expect(page.getByText('Environment configuration saved.', { exact: true })).toHaveCount(0); await expect(page.getByRole('button', { name: 'Add environment', exact: true })).toBeDisabled(); expect(state.saves).toHaveLength(1);
});
test('current native revision refresh hides private editor and switches fresh target before next edit', async ({ page }) => {
  const state = await backend(page); await open(page); await edit(page); await page.getByLabel('Name', { exact: true }).fill('Unsent private title'); state.accessRevision = 'b'.repeat(64); await page.getByRole('button', { name: 'Refresh environments' }).click(); await expect(page.getByRole('form')).toHaveCount(0); await expect(page.getByRole('table', { name: 'Repository environments', exact: true })).toContainText('Preview'); await edit(page); await password(page); await page.getByRole('button', { name: 'Save environment', exact: true }).click(); await expect(page.getByRole('status')).toContainText('configuration saved'); expect(state.saves[0]!.target!.accessRevision).toBe('b'.repeat(64));
});
test('native read denial clears editor/rows and does not refetch indefinitely', async ({ page }) => {
  const state = await backend(page); await open(page); await edit(page); await page.getByLabel('Name', { exact: true }).fill('Unsent private title'); state.denied = true; await page.getByRole('button', { name: 'Refresh environments' }).click(); await expect(page.getByRole('alert')).toContainText('administrator'); await expect(page.getByRole('table', { name: 'Repository environments', exact: true })).toHaveCount(0); await expect(page.getByRole('form')).toHaveCount(0); expect(state.saves).toHaveLength(0); expect(state.reads).toBe(1);
});
test('CAS refusal requires explicit discard/current reload rather than resending stale input', async ({ page }) => {
  const state = await backend(page); state.mode = 'stale'; await open(page); await edit(page); await password(page); await page.getByRole('button', { name: 'Save environment', exact: true }).click(); await expect(page.getByRole('heading', { name: 'Configuration version changed' })).toBeVisible(); expect(state.saves).toHaveLength(1); state.mode = 'success'; state.rows[0]!.version = '2'; await page.getByRole('button', { name: 'Discard refused change' }).click(); await edit(page); await password(page); await page.getByRole('button', { name: 'Save environment', exact: true }).click(); await expect(page.getByRole('status')).toContainText('configuration saved'); expect(state.saves).toHaveLength(2); expect(state.saves[1]!.expectedVersion).toBe('2'); expect(state.saves[1]!.operationId).not.toBe(state.saves[0]!.operationId);
});
test('server pages remain distinct from loaded-page filtering', async ({ page }) => {
  const state = await backend(page); state.rows = Array.from({ length: 21 }, (_, i) => row(`Environment ${i}`, `${String(i + 1).padStart(8, '0')}-1111-4111-8111-111111111111`)); await open(page); await expect(page.getByText('20 on this page · 21 total environments')).toBeVisible(); await page.getByRole('button', { name: 'Next environment page' }).click(); await expect(page.getByText('1 on this page · 21 total environments')).toBeVisible(); await expect(page.getByRole('table', { name: 'Repository environments', exact: true })).toContainText('Environment 20'); await expect(page.getByRole('button', { name: 'Next environment page' })).toBeDisabled();
});
test('reader has no inventory calls; OAuth/archived admin reads are view-only', async ({ page }) => {
  const state = await backend(page); state.permission = 'read'; state.canManage = false; await open(page); await expect(page.getByText('Current ordinary repository administrator authority is required')).toBeVisible(); expect(state.reads).toBe(0); state.permission = 'owner'; await page.reload(); await expect(page.getByRole('table', { name: 'Repository environments', exact: true })).toContainText('Preview'); await expect(page.getByRole('button', { name: 'Add environment', exact: true })).toBeDisabled(); state.canManage = true; await open(page, '?oauth'); await expect(page.getByRole('table', { name: 'Repository environments', exact: true })).toBeVisible(); await expect(page.getByRole('button', { name: 'Add environment', exact: true })).toBeDisabled();
});
test('delete uses confirmation only, Cancel receives focus/Escape; exact accepted tombstone survives reload', async ({ page }) => {
  const state = await backend(page); await open(page); await page.getByRole('button', { name: 'Delete environment Preview' }).click(); const dialog = page.getByRole('dialog', { name: 'Delete this environment?' }); await expect(dialog.getByRole('button', { name: 'Cancel', exact: true })).toBeFocused(); await page.keyboard.press('Escape'); await expect(dialog).toHaveCount(0); expect(state.deletes).toHaveLength(0); await page.getByRole('button', { name: 'Delete environment Preview' }).click(); await dialog.getByLabel('Current Golf password').fill('fixture current password'); await dialog.getByRole('button', { name: 'Confirm delete environment' }).click(); await expect(page.getByRole('status')).toContainText('Environment deleted.'); expect(state.deletes[0]).toMatchObject({ environmentId: id, expectedVersion: '1' }); await page.reload(); await expect(page.getByText('No environments configured.')).toBeVisible(); expect(state.deletes).toHaveLength(1);
});
test('corrupt saved original metadata blocks fresh operations without probing status', async ({ page }) => {
  const state = await backend(page); await page.addInitScript(() => sessionStorage.setItem('golf.environment-operation.v1:42:alice:example', '{broken')); await open(page); await expect(page.getByRole('alert')).toContainText('unreadable'); await expect(page.getByRole('button', { name: 'Add environment', exact: true })).toBeDisabled(); expect(state.inspections).toBe(0); expect(state.saves).toHaveLength(0);
});
test('same-tick double submit reserves just one original operation', async ({ page }) => {
  const state = await backend(page); let release!: () => void; state.barrier = new Promise<void>(r => { release = r; }); await open(page); await edit(page); await password(page); await page.getByRole('form', { name: 'Environment configuration editor' }).evaluate(form => { form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); }); await expect.poll(() => state.saves.length).toBe(1); release(); await expect(page.getByRole('status')).toContainText('configuration saved'); expect(state.saves).toHaveLength(1);
});
test('late mutation after account→other→back cannot disclose/adopt receipt; logout forgets metadata', async ({ page }) => {
  const state = await backend(page); let release!: () => void; state.barrier = new Promise<void>(r => { release = r; }); await open(page); await edit(page); await password(page); await page.getByRole('button', { name: 'Save environment', exact: true }).click(); await expect.poll(() => state.saves.length).toBe(1); await page.getByRole('button', { name: 'Fixture switch account' }).click(); await page.getByRole('button', { name: 'Fixture restore account' }).click(); release(); await expect(page.getByRole('table', { name: 'Repository environments', exact: true })).toBeVisible(); await expect(page.getByText('Environment configuration saved.', { exact: true })).toHaveCount(0); expect(state.inspections).toBe(0); await page.getByRole('button', { name: 'Fixture logout' }).click(); await expect(page.getByRole('heading', { name: 'Environments', exact: true })).toHaveCount(0); expect(await page.evaluate(() => Object.keys(sessionStorage).filter(k => k.startsWith('golf.environment-operation')))).toEqual([]);
});
for (const theme of ['dark', 'light']) for (const width of [1440, 390]) test(`${theme} ${width} actual shared fonts/layout, editor and privacy revalidation`, async ({ page }) => {
  await page.setViewportSize({ width, height: 1000 }); await page.addInitScript(v => localStorage.setItem('golf.theme', v), theme); const state = await backend(page); await open(page); await edit(page); await page.getByLabel('Name', { exact: true }).fill('Private working name'); expect(await page.evaluate(() => document.documentElement.dataset.theme)).toBe(theme); expect(await page.evaluate(() => document.fonts.check('14px Archivo'))).toBe(true); expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true); await page.getByRole('button', { name: 'Fixture revalidate' }).click(); await expect(page.getByRole('heading', { name: 'Environments', exact: true })).toHaveCount(0); await page.getByRole('button', { name: 'Fixture restore access' }).click(); await expect(page.getByRole('table', { name: 'Repository environments', exact: true })).toBeVisible(); await expect(page.getByRole('form')).toHaveCount(0); expect(state.saves).toHaveLength(0);
});

test('mutation authority denial synchronously masks private inventory and leaves original inspection identity', async ({ page }) => {
 const state=await backend(page);state.mode='denied';await open(page);await edit(page);await password(page);await page.getByRole('button',{name:'Save environment',exact:true}).click();await expect(page.getByRole('alert')).toContainText('revoked');await expect(page.getByRole('table',{name:'Repository environments',exact:true})).toHaveCount(0);await expect(page.getByRole('form')).toHaveCount(0);expect(state.saves).toHaveLength(1);expect(await page.evaluate(()=>Object.keys(sessionStorage).filter(k=>k.startsWith('golf.environment-operation')))).toHaveLength(1);
});

test('reviewer lookup authority denial clears private inventory and unsent editor without a mutation', async ({ page }) => {
  const state = await backend(page); await open(page); await edit(page); await page.getByLabel('Name', { exact: true }).fill('Private unsent environment'); await page.getByLabel('Reviewer username').fill('reviewer'); state.denied = true;
  await page.getByRole('button', { name: 'Look up and add reviewer' }).click(); await expect(page.getByRole('alert')).toContainText('revoked'); await expect(page.getByRole('table', { name: 'Repository environments', exact: true })).toHaveCount(0); await expect(page.getByRole('form')).toHaveCount(0); await expect(page.getByRole('button', { name: 'Add environment', exact: true })).toBeDisabled(); expect(state.lookups).toBe(1); expect(state.saves).toHaveLength(0); expect(state.inspections).toBe(0);
});
