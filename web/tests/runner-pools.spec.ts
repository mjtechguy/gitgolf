import { expect, test, type Page } from '@playwright/test';
import { create } from '@bufbuild/protobuf';
import { RunnerPoolState as State, RunnerPoolSchema, ListRunnerPoolsResponseSchema, SaveRunnerPoolRequestSchema, SaveRunnerPoolResponseSchema, GetRepositoryRunnerPlacementRequestSchema, GetRepositoryRunnerPlacementResponseSchema, SetRepositoryRunnerPlacementRequestSchema, SetRepositoryRunnerPlacementResponseSchema, type GetRepositoryRunnerPlacementResponse, type RunnerPool, type SaveRunnerPoolRequest, type SetRepositoryRunnerPlacementRequest } from '../src/gen/golf/v1/golf_pb';
import { request, respond, reject } from './rpc';

const id = '11111111-1111-4111-8111-111111111111';
const secondId = '22222222-2222-4222-8222-222222222222';
const stamp = '2026-10-04T00:00:00Z';
const pool = () => create(RunnerPoolSchema, { id, name: 'Trusted Linux', version: '1', runtime: 'local-docker', state: State.ACTIVE, maxParallelAttempts: 2, workerIds: ['worker-1'], repositoryAssignmentEnabled: true, createdAt: stamp, updatedAt: stamp });
const placement = () => ({ repository: { owner: 'alice', name: 'example' }, repositoryId: '9007199254740993', ownerId: '42', accessRevision: 'a'.repeat(64), version: '0', poolId: '', poolVersion: '', legacyUnbound: true });
type Mode = 'success' | 'lost' | 'denied' | 'stale' | 'wrong version' | 'wrong target' | 'wrong values';
async function backend(page: Page) {
  const state = { pools: [pool()], enrolled: ['worker-1', 'worker-2'], placement: placement(), canEdit: true, password: true, mode: 'success' as Mode, saves: [] as SaveRunnerPoolRequest[], sets: [] as SetRepositoryRunnerPlacementRequest[], reads: 0, denyRead: false, malformed: undefined as ((rows: RunnerPool[]) => RunnerPool[]) | undefined, malformedPlacement: undefined as ((r: GetRepositoryRunnerPlacementResponse) => void) | undefined, barrier: undefined as Promise<void> | undefined };
  await page.route('**/rpc/**', async route => {
    const method = route.request().url().split('/').at(-1);
    if (method === 'ListRunnerPools') {
      state.reads++;
      if (state.denyRead) return reject(route, 'permission_denied', 'Current administrator required.');
      return respond(route, ListRunnerPoolsResponseSchema, { enrolledWorkerIds: state.enrolled, pools: state.malformed ? state.malformed(state.pools) : state.pools.map(p => ({ ...p, activeAttemptCount: '0' })) });
    }
    if (method === 'GetRepositoryRunnerPlacement') {
      state.reads++;
      const input = request(route, GetRepositoryRunnerPlacementRequestSchema);
      expect(input).toMatchObject({ repository: { owner: 'alice', name: 'example' }, repositoryId: '9007199254740993', ownerId: '42', expectedRevision: 'a'.repeat(64) });
      if (state.denyRead) return reject(route, 'permission_denied', 'Current repository administrator required.');
      const response = create(GetRepositoryRunnerPlacementResponseSchema, { placement: state.placement, eligiblePools: state.pools.filter(p => p.repositoryAssignmentEnabled), selectedPool: state.pools.find(p => p.id === state.placement.poolId), canEdit: state.canEdit, passwordConfirmationAvailable: state.password });
      state.malformedPlacement?.(response);
      return respond(route, GetRepositoryRunnerPlacementResponseSchema, response);
    }
    if (method === 'SaveRunnerPool') {
      const input = request(route, SaveRunnerPoolRequestSchema); state.saves.push(input);
      expect(input.runtime).toBe('local-docker'); expect(input.currentPassword).toBe('fixture current password');
      if (state.barrier) await state.barrier;
      if (state.mode === 'denied') { state.denyRead = true; return reject(route, 'permission_denied', 'Current administrator required.'); }
      if (state.mode === 'stale') return route.fulfill({ status: 409, json: { code: 'aborted', message: 'Pool version changed.' } });
      const prior = state.pools.find(p => p.id === input.id);
      expect(input.expectedVersion).toBe(prior?.version ?? '0');
      const next = create(RunnerPoolSchema, { id: input.id, name: input.name, runtime: input.runtime, state: input.state, maxParallelAttempts: input.maxParallelAttempts, workerIds: input.workerIds, repositoryAssignmentEnabled: input.repositoryAssignmentEnabled, version: String(BigInt(input.expectedVersion) + 1n), createdAt: prior?.createdAt ?? stamp, updatedAt: stamp });
      state.pools = [...state.pools.filter(p => p.id !== next.id), next];
      if (state.mode === 'lost') return route.abort('failed');
      if (state.mode === 'wrong version') next.version = input.expectedVersion;
      if (state.mode === 'wrong target') next.id = secondId;
      if (state.mode === 'wrong values') next.name = 'Different request';
      return respond(route, SaveRunnerPoolResponseSchema, { pool: next });
    }
    expect(method).toBe('SetRepositoryRunnerPlacement');
    const input = request(route, SetRepositoryRunnerPlacementRequestSchema); state.sets.push(input);
    expect(input).toMatchObject({ repository: { owner: 'alice', name: 'example' }, repositoryId: '9007199254740993', ownerId: '42', expectedRevision: 'a'.repeat(64), currentPassword: 'fixture current password' });
    if (state.barrier) await state.barrier;
    if (state.mode === 'denied') { state.denyRead = true; return reject(route, 'permission_denied', 'Current repository administration required.'); }
    if (state.mode === 'stale') return route.fulfill({ status: 409, json: { code: 'aborted', message: 'Placement changed.' } });
    expect(input.expectedPlacementVersion).toBe(state.placement.version);
    state.placement = { ...state.placement, version: String(BigInt(input.expectedPlacementVersion) + 1n), poolId: input.poolId, poolVersion: input.expectedPoolVersion, legacyUnbound: input.poolId === '' };
    if (state.mode === 'lost') return route.abort('failed');
    const result = { ...state.placement };
    if (state.mode === 'wrong version') result.version = input.expectedPlacementVersion;
    if (state.mode === 'wrong target') result.repositoryId = '9007199254740994';
    if (state.mode === 'wrong values') result.poolVersion = '9';
    return respond(route, SetRepositoryRunnerPlacementResponseSchema, { placement: result });
  });
  return state;
}
async function open(page: Page, repository = false) {
  await page.goto(`/tests/fixtures/runner-pools.html${repository ? '?repository=1' : ''}`);
  await expect(page.getByRole('heading', { name: repository ? 'Runner placement' : 'Runner pools', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: repository ? 'Inspect current runner placement' : 'Inspect current runner pools', exact: true })).toBeEnabled();
}
async function editPool(page: Page) {
  await page.getByRole('button', { name: 'Edit pool Trusted Linux', exact: true }).click();
  await page.getByRole('textbox', { name: 'Pool name', exact: true }).fill('Trusted build pool');
  await page.getByLabel('Current Golf password', { exact: true }).fill('fixture current password');
}
async function editPlacement(page: Page) {
  await page.getByRole('button', { name: 'Edit runner placement', exact: true }).click();
  await page.getByRole('combobox', { name: 'Runner placement', exact: true }).selectOption(id);
  await page.getByLabel('Current Golf password', { exact: true }).fill('fixture current password');
}
test('pool inventory is compact and forms open only on request', async ({ page }) => {
  const s = await backend(page); await open(page);
  await expect(page.getByRole('table', { name: 'Runner pools', exact: true })).toBeVisible(); await expect(page.getByRole('form')).toHaveCount(0);
  await expect(page.getByText('1 currently enrolled workers are unpooled.', { exact: false })).toBeVisible();
  await page.getByText('Pool details', { exact: true }).click(); await expect(page.getByText('worker-1', { exact: true })).toBeVisible();
  expect(s.saves).toHaveLength(0); await expect(page.getByText('not verified capacity or health', { exact: false })).toBeVisible();
});
test('pool edit freezes exact UUID/version and verifies changed values before reload', async ({ page }) => {
  const s = await backend(page); await open(page); await editPool(page); await page.getByRole('combobox', { name: 'Pool control', exact: true }).selectOption(String(State.DRAINING)); await page.getByRole('button', { name: 'Save pool', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Edit pool Trusted build pool', exact: true })).toBeEnabled(); expect(s.saves).toHaveLength(1); expect(s.saves[0]).toMatchObject({ id, expectedVersion: '1', state: State.DRAINING, maxParallelAttempts: 2, workerIds: ['worker-1'], repositoryAssignmentEnabled: true });
  await expect(page.locator('input[type=password]')).toHaveCount(0); await page.reload(); await expect(page.getByRole('button', { name: 'Edit pool Trusted build pool' })).toBeEnabled(); expect(s.saves).toHaveLength(1);
});
test('new pools require enrolled workers and explicit opt-in; no credential enrollment', async ({ page }) => {
  const s = await backend(page); s.pools = []; await open(page); await page.getByRole('button', { name: 'Add pool', exact: true }).click(); await page.getByLabel('Pool name', { exact: true }).fill('CI Linux'); await page.getByLabel('Current Golf password', { exact: true }).fill('fixture current password'); await page.getByRole('button', { name: 'Save pool' }).click();
  await expect(page.getByRole('alert')).toContainText('at least one enrolled worker'); expect(s.saves).toHaveLength(0); await page.getByRole('checkbox', { name: 'worker-1', exact: true }).check(); await expect(page.getByRole('checkbox', { name: 'Allow repository administrators to select this pool', exact: true })).not.toBeChecked(); await page.getByRole('button', { name: 'Save pool' }).click(); await expect(page.getByRole('button', { name: 'Edit pool CI Linux' })).toBeEnabled(); expect(s.saves[0]).toMatchObject({ expectedVersion: '0', repositoryAssignmentEnabled: false, workerIds: ['worker-1'] }); expect(s.saves[0]!.id).toMatch(/^[a-f0-9-]{36}$/);
});
test('workers in other pools cannot be silently moved by this editor', async ({ page }) => {
  const s = await backend(page); s.pools.push(create(RunnerPoolSchema, { ...pool(), id: secondId, name: 'Another pool', workerIds: ['worker-2'] })); await open(page); await editPool(page); await expect(page.getByRole('checkbox', { name: 'worker-2 · another pool', exact: true })).toBeDisabled(); expect(s.saves).toHaveLength(0);
});
for (const mode of ['lost', 'stale', 'wrong version', 'wrong target', 'wrong values'] as const) test(`${mode} pool change is inspection-only until explicit current read`, async ({ page }) => {
  const s = await backend(page); s.mode = mode; await open(page); await editPool(page); await page.getByRole('button', { name: 'Save pool', exact: true }).click(); await expect(page.getByRole('status')).toContainText('could not be confirmed'); await expect(page.getByRole('button', { name: 'Add pool', exact: true })).toBeDisabled(); expect(s.saves).toHaveLength(1); s.mode = 'success'; await page.getByRole('button', { name: 'Inspect current runner pools' }).click(); await expect(page.getByRole('status')).toContainText('does not attribute'); expect(s.saves).toHaveLength(1);
});
for (const malformed of ['version', 'runtime', 'count', 'timestamp', 'duplicate memberships', 'duplicate ID', 'unknown state', 'empty active', 'missing count'] as const) test(`malformed pool ${malformed} hides the entire inventory`, async ({ page }) => {
  const s = await backend(page); s.malformed = rows => { const p = create(RunnerPoolSchema, { ...rows[0]!, activeAttemptCount: '0' }); if (malformed === 'version') p.version = '01'; if (malformed === 'runtime') p.runtime = 'cloudflare'; if (malformed === 'count') p.activeAttemptCount = '-1'; if (malformed === 'timestamp') p.updatedAt = 'not a time'; if (malformed === 'unknown state') p.state = State.UNSPECIFIED; if (malformed === 'empty active') p.workerIds = []; if (malformed === 'missing count') p.activeAttemptCount = undefined; return malformed === 'duplicate ID' ? [p, p] : malformed === 'duplicate memberships' ? [p, create(RunnerPoolSchema, { ...p, id: secondId, name: 'Duplicate membership' })] : [p]; }; await open(page); await expect(page.getByRole('alert')).toContainText('could not be verified'); await expect(page.getByRole('table')).toHaveCount(0); await expect(page.getByRole('button', { name: 'Add pool', exact: true })).toBeDisabled(); expect(s.saves).toHaveLength(0);
});
test('lowered attempt ceiling does not erase currently running attempts', async ({ page }) => {
  const s = await backend(page); s.malformed = rows => [create(RunnerPoolSchema, { ...rows[0]!, maxParallelAttempts: 1, activeAttemptCount: '2' })]; await open(page); await expect(page.getByRole('table', { name: 'Runner pools', exact: true })).toBeVisible(); await expect(page.getByRole('cell', { name: '2', exact: true })).toBeVisible();
});
test('same-tick duplicate save dispatches one CAS operation', async ({ page }) => {
  const s = await backend(page); let release!: () => void; s.barrier = new Promise(resolve => release = resolve); await open(page); await editPool(page); await page.getByRole('form', { name: 'Edit runner pool', exact: true }).evaluate(node => { (node as HTMLFormElement).requestSubmit(); (node as HTMLFormElement).requestSubmit(); }); await expect.poll(() => s.saves.length).toBe(1); release(); await expect(page.getByRole('button', { name: 'Edit pool Trusted build pool', exact: true })).toBeEnabled(); expect(s.saves).toHaveLength(1);
});
test('pool denial removes metadata and a late response cannot repopulate another account', async ({ page }) => {
  const s = await backend(page); let release!: () => void; s.barrier = new Promise(resolve => release = resolve); await open(page); await editPool(page); await page.getByRole('button', { name: 'Save pool', exact: true }).click(); await expect.poll(() => s.saves.length).toBe(1); s.denyRead = true; await page.getByRole('button', { name: 'Fixture switch account' }).click(); await expect(page.getByRole('table')).toHaveCount(0); release(); await expect(page.getByRole('alert')).toContainText('unavailable'); await expect(page.getByText('Trusted build pool', { exact: true })).toHaveCount(0); await expect(page.locator('input[type=password]')).toHaveCount(0); expect(s.saves).toHaveLength(1);
});
test('revalidation hides forms and uncertainty survives an account return without retry', async ({ page }) => {
  const s = await backend(page); let release!: () => void; s.barrier = new Promise(resolve => release = resolve); await open(page); await editPool(page); await page.getByRole('button', { name: 'Save pool' }).click(); await expect.poll(() => s.saves.length).toBe(1); await page.getByRole('button', { name: 'Fixture revalidate' }).click(); await expect(page.getByRole('table')).toHaveCount(0); await expect(page.getByRole('form')).toHaveCount(0); release(); await page.getByRole('button', { name: 'Fixture restore access' }).click(); await expect(page.getByRole('table', { name: 'Runner pools', exact: true })).toBeVisible(); await expect(page.getByRole('button', { name: 'Add pool' })).toBeDisabled(); expect(s.saves).toHaveLength(1); await page.getByRole('button', { name: 'Inspect current runner pools' }).click(); await expect(page.getByRole('button', { name: 'Add pool' })).toBeEnabled(); expect(s.saves).toHaveLength(1);
});
test('repository placement begins explicitly unbound and binds native IDs/current versions', async ({ page }) => {
  const s = await backend(page); await open(page, true); await expect(page.getByText('Legacy unbound · unpooled workers only', { exact: true })).toBeVisible(); await expect(page.getByRole('form')).toHaveCount(0); await editPlacement(page); await page.getByRole('button', { name: 'Save placement', exact: true }).click(); await expect(page.getByText('Selected 1 · current 1', { exact: true })).toBeVisible(); expect(s.sets).toHaveLength(1); expect(s.sets[0]).toMatchObject({ expectedPlacementVersion: '0', poolId: id, expectedPoolVersion: '1' }); await page.reload(); await expect(page.getByText('Selected 1 · current 1', { exact: true })).toBeVisible(); expect(s.sets).toHaveLength(1);
});
test('unbound selection retains a monotone version and never erases the placement slot', async ({ page }) => {
  const s = await backend(page); s.placement = { ...placement(), version: '7', poolId: id, poolVersion: '1', legacyUnbound: false }; await open(page, true); await page.getByRole('button', { name: 'Edit runner placement' }).click(); await page.getByRole('combobox', { name: 'Runner placement', exact: true }).selectOption(''); await page.getByLabel('Current Golf password').fill('fixture current password'); await page.getByRole('button', { name: 'Save placement' }).click(); await expect(page.getByText('Legacy unbound · unpooled workers only', { exact: true })).toBeVisible(); expect(s.sets[0]).toMatchObject({ expectedPlacementVersion: '7', poolId: '', expectedPoolVersion: '' }); expect(s.placement.version).toBe('8');
});
test('current pool drift is visible without silently changing the original selection receipt', async ({ page }) => {
  const s = await backend(page); s.placement = { ...placement(), version: '3', poolId: id, poolVersion: '1', legacyUnbound: false }; s.pools[0]!.version = '5'; await open(page, true); await expect(page.getByText('Selected 1 · current 5', { exact: true })).toBeVisible(); await expect(page.getByText('The selected pool configuration has changed.', { exact: false })).toBeVisible(); await editPlacement(page); await page.getByRole('button', { name: 'Save placement' }).click(); await expect(page.getByText('Selected 5 · current 5', { exact: true })).toBeVisible(); expect(s.sets[0]).toMatchObject({ expectedPlacementVersion: '3', expectedPoolVersion: '5' });
});
test('draining eligible pools remain observations and cannot be selected', async ({ page }) => {
  const s = await backend(page); s.pools[0]!.state = State.DRAINING; await open(page, true); await page.getByRole('button', { name: 'Edit runner placement' }).click(); await expect(page.getByRole('option', { name: 'Trusted Linux · Draining · version 1', exact: true })).toBeDisabled(); await expect(page.getByRole('combobox', { name: 'Runner placement' })).toHaveValue(''); expect(s.sets).toHaveLength(0);
});
test('managed read-only placement exposes no mutation form', async ({ page }) => {
  const s = await backend(page); s.canEdit = false; s.password = false; await open(page, true); await expect(page.getByRole('button', { name: 'Edit runner placement', exact: true })).toBeDisabled(); await expect(page.getByText('Read-only observation.', { exact: false })).toBeVisible(); await expect(page.getByRole('form')).toHaveCount(0); expect(s.sets).toHaveLength(0);
});
for (const mode of ['lost', 'stale', 'wrong version', 'wrong target', 'wrong values'] as const) test(`${mode} placement keeps CAS outcome uncertain until explicit inspection`, async ({ page }) => {
  const s = await backend(page); s.mode = mode; await open(page, true); await editPlacement(page); await page.getByRole('button', { name: 'Save placement' }).click(); await expect(page.getByRole('status')).toContainText('could not be confirmed'); await expect(page.getByRole('button', { name: 'Edit runner placement', exact: true })).toBeDisabled(); expect(s.sets).toHaveLength(1); s.mode = 'success'; await page.getByRole('button', { name: 'Inspect current runner placement' }).click(); await expect(page.getByRole('button', { name: 'Edit runner placement', exact: true })).toBeEnabled(); expect(s.sets).toHaveLength(1);
});
for (const malformed of ['native ID', 'access revision', 'version', 'bound absent', 'unbound object', 'old current pool', 'cross-repository count', 'selected mismatch'] as const) test(`malformed placement ${malformed} clears its private observation`, async ({ page }) => {
  const s = await backend(page); if (['old current pool', 'selected mismatch'].includes(malformed)) s.placement = { ...placement(), version: '2', poolId: id, poolVersion: '3', legacyUnbound: false };
  s.malformedPlacement = r => { if (malformed === 'native ID') r.placement!.repositoryId = '99'; if (malformed === 'access revision') r.placement!.accessRevision = 'b'.repeat(64); if (malformed === 'version') r.placement!.version = '00'; if (malformed === 'bound absent') { r.placement!.poolId = id; r.placement!.poolVersion = '1'; r.placement!.legacyUnbound = false; r.selectedPool = undefined; } if (malformed === 'unbound object') r.selectedPool = pool(); if (malformed === 'cross-repository count') r.eligiblePools[0]!.activeAttemptCount = '1'; if (malformed === 'selected mismatch') { r.selectedPool!.version = '3'; r.selectedPool!.name = 'Unverified different pool'; } };
  await open(page, true); await expect(page.getByRole('alert')).toContainText('could not be verified'); await expect(page.getByText('Legacy unbound · unpooled workers only', { exact: true })).toHaveCount(0); await expect(page.getByRole('table')).toHaveCount(0); expect(s.sets).toHaveLength(0);
});
test('repository administration denial removes placement and never sends a replacement', async ({ page }) => {
  const s = await backend(page); s.mode = 'denied'; await open(page, true); await editPlacement(page); await page.getByRole('button', { name: 'Save placement' }).click(); await expect(page.getByRole('alert')).toContainText('unavailable'); await expect(page.getByText('Trusted Linux', { exact: true })).toHaveCount(0); await expect(page.getByRole('form')).toHaveCount(0); expect(s.sets).toHaveLength(1);
});
for (const repository of [false, true]) for (const theme of ['dark', 'light']) for (const width of [1440, 390]) test(`${repository ? 'placement' : 'pools'} ${theme} ${width} uses shared controls and bounded layout`, async ({ page }) => {
  await page.addInitScript(theme => localStorage.setItem('golf.theme', theme), theme); const s = await backend(page); await page.setViewportSize({ width, height: 1000 }); await open(page, repository); if (repository) await editPlacement(page); else await editPool(page); await page.evaluate(() => document.fonts.ready); await expect(page.locator('html')).toHaveAttribute('data-theme', theme); expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true); expect(await page.evaluate(() => document.fonts.check('14px Archivo'))).toBe(true); expect(s.saves).toHaveLength(0); expect(s.sets).toHaveLength(0);
});
