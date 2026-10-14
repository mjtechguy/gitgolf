import { expect, test, type Page } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { featureBackend } from './feature-policy-fixture';

// Cloudflare-native Actions: run list, run detail, live logs, dispatch, approvals and runner administration against
// mocked /native/pipelines and /native/pipeline-runners responses shaped like cloudflare/forge/src/pipeline-api.mjs.
// GOLF_RUNNER_SHOTS=/tmp/golf-ui-review/runner-shots writes review screenshots.
const now = Date.now(), at = (minutes: number) => new Date(now - minutes * 60_000).toISOString();
const run = (id: number, extra: object = {}) => ({ id: String(id), number: id, engine: 'forgejo-actions', workflowPath: '.github/workflows/ci.yml', workflowName: 'CI', event: 'push', ref: 'refs/heads/main', branch: 'main', commitId: 'c0ffee1234567890'.padEnd(40, '0'),
  pullNumber: null, headRef: '', baseRef: '', actor: 'alex', trusted: true, title: 'Bump setup-node to v4', state: 'SUCCESS', reason: '', attempt: 1, cancelRequested: false, inputs: {}, createdAt: at(30 - id), startedAt: at(30 - id), finishedAt: at(28 - id), updatedAt: at(28 - id), ...extra });
const step = (number: number, name: string, state: string, logIndex: number, logLength: number) => ({ number, name, state, startedAt: at(5), finishedAt: state === 'RUNNING' ? null : at(4), logIndex, logLength });
const job = (id: number, key: string, name: string, state: string, needs: string[] = [], extra: object = {}) => ({ id: String(id), key, name, attempt: 1, stage: '', stageIndex: 0, needs, runsOn: ['ubuntu-latest'], state, when: 'on_success', allowFailure: false, exitCode: null,
  failureReason: '', reusedFrom: '', runner: 'golf-runner-1', logLines: 9, logComplete: state !== 'RUNNING', createdAt: at(6), startedAt: state === 'BLOCKED' || state === 'QUEUED' ? null : at(5), finishedAt: ['SUCCESS', 'FAILURE'].includes(state) ? at(3) : null,
  steps: state === 'BLOCKED' ? [] : [step(0, 'Run actions/checkout@v4', 'SUCCESS', 2, 2), step(1, 'Run actions/setup-node@v4', 'SUCCESS', 4, 2), step(2, 'Run npm test', state === 'FAILURE' ? 'FAILURE' : state === 'RUNNING' ? 'RUNNING' : 'SUCCESS', 6, 3)], waitingForLabels: false, ...extra });
const runs = [run(7, { state: 'RUNNING', finishedAt: null, title: 'Add services: postgres to the test job' }), run(6, { state: 'FAILURE', title: 'Try node 23' }), run(5, { event: 'pull_request', pullNumber: 12, headRef: 'feature/cache', title: 'Cache npm downloads' }),
  run(4, { state: 'WAITING', workflowName: 'Deploy', workflowPath: '.github/workflows/deploy.yml', title: 'Deploy to production' }), run(3, { state: 'REFUSED', workflowName: 'Nightly', workflowPath: '.github/workflows/nightly.yml', title: 'Nightly', reason: 'Job report calls a reusable workflow; reusable workflows are not available on Golf yet.' }),
  run(2, { event: 'workflow_dispatch', title: 'Manually run by alex', inputs: { note: 'release candidate' } }), run(1, { state: 'CANCELLED' })];
const jobs = [job(31, 'test', 'Node 20', 'SUCCESS'), job(32, 'test', 'Node 22', 'RUNNING'), job(33, 'lint', 'lint', 'SUCCESS'), job(34, 'report', 'report', 'BLOCKED', ['test', 'lint']),
  job(35, 'deploy', 'deploy', 'BLOCKED', ['report']), job(36, 'windows', 'Windows', 'QUEUED', [], { runsOn: ['windows-latest'], waitingForLabels: true, runner: '' })];
const log = ['Runner golf-runner-1 (version:v13.2.0) received task 32 of job test, triggered by event: push', 'workflow prepared', '::group::Run actions/checkout@v4', 'Fetching the repository', '::group::Run actions/setup-node@v4', 'Found in cache @ /opt/hostedtoolcache/node/22.11.0/x64', '> golf-actions-demo@1.0.0 test', '> node --test', '✔ sum adds (0.61ms)'];

async function backend(page: Page) {
  const state = await featureBackend(page), calls: Record<string, unknown>[] = [];
  await page.route('**/native/config', route => route.fulfill({ json: { runtimeProfile: 'cloudflare-native', workspace: 'alex', pipelines: true, evidence: false, tests: false, agents: false, advice: false, previews: false, apps: false } }));
  await page.route('**/native/pipelines', async route => {
    const body = route.request().postDataJSON(); calls.push(body);
    if (body.action === 'listRuns') return route.fulfill({ json: { runs: body.workflow ? runs.filter(r => r.workflowPath === body.workflow) : body.status === 'FAILURE' ? runs.filter(r => r.state === 'FAILURE') : runs, total: 7, nextPage: 0, canWrite: true, enabled: true,
      workflows: [{ path: '.github/workflows/ci.yml', name: 'CI', engine: 'forgejo-actions', runs: 5 }, { path: '.github/workflows/deploy.yml', name: 'Deploy', engine: 'forgejo-actions', runs: 1 }, { path: '.github/workflows/nightly.yml', name: 'Nightly', engine: 'forgejo-actions', runs: 1 }] } });
    if (body.action === 'workflows') return route.fulfill({ json: { branch: 'main', branches: ['main', 'feature/cache'], workflows: [{ path: '.github/workflows/ci.yml', name: 'CI', events: ['push', 'workflow_dispatch'], dispatch: true, error: '', inputs: [{ name: 'note', description: 'Release note', type: 'string', required: false, default: 'dispatched', options: [] }, { name: 'dry', description: 'Dry run', type: 'boolean', required: false, default: 'false', options: [] }] },
      { path: '.github/workflows/deploy.yml', name: 'Deploy', events: ['push'], dispatch: false, inputs: [], error: '' }, { path: '.github/workflows/nightly.yml', name: 'Nightly', events: [], dispatch: false, inputs: [], error: 'Job report calls a reusable workflow; reusable workflows are not available on Golf yet.' }] } });
    if (body.action === 'getRun') {
      if (body.runId === '4') return route.fulfill({ json: { run: runs[3], attempt: 1, canWrite: true, artifacts: [], jobs: [job(41, 'build', 'build', 'SUCCESS'), job(42, 'deploy', 'deploy', 'APPROVAL', ['build'], { steps: [], startedAt: null, finishedAt: null })] } });
      return route.fulfill({ json: { run: runs[0], attempt: 1, canWrite: true, jobs, artifacts: [{ id: '9', name: 'dist-20', kind: 'actions-v4', size: 18_342, jobId: '31', createdAt: at(4), expiresAt: new Date(now + 30 * 86400_000).toISOString(), expired: false }] } });
    }
    if (body.action === 'jobLog') return route.fulfill({ json: { jobId: body.jobId, state: 'RUNNING', text: body.fromLine ? '' : log.join('\n') + '\n', nextLine: 9, totalLines: 9, complete: false } });
    if (body.action === 'dispatch') return route.fulfill({ json: { runId: '8', number: 8 } });
    return route.fulfill({ json: { ok: true } });
  });
  await page.route('**/native/pipeline-runners', async route => {
    const body = route.request().postDataJSON(); calls.push(body);
    if (body.action === 'createToken') return route.fulfill({ json: { token: 'golfreg_' + 'a'.repeat(64), registration: {}, commands: ['# Forgejo Runner v13.2.0 (linux-amd64 sha256 fadaec…)', `forgejo-runner register --no-interactive --instance https://golf.example --token golfreg_${'a'.repeat(64)} --name golf-runner --labels ${body.labels.join(',')}`, 'forgejo-runner daemon'] } });
    return route.fulfill({ json: { scope: body.scope, scopeId: '', engines: ['forgejo-actions', 'gitlab-ci'], forgejoRunner: { version: 'v13.2.0', sha256: 'fadaec897f5e6641c363f87ecaf75f866f99c81b7097ec6b433e4c48123fcad1' }, instance: 'https://golf.example',
      runners: [{ id: '1', uuid: 'u1', engine: 'forgejo-actions', scope: body.scope, scopeId: '', name: 'golf-runner-1', labels: ['ubuntu-latest:docker://ghcr.io/catthehacker/ubuntu:act-24.04'], state: 'ACTIVE', version: 'v13.2.0', ephemeral: false, createdAt: at(600), lastSeenAt: at(0), online: true, busy: true },
        { id: '2', uuid: 'u2', engine: 'gitlab-ci', scope: body.scope, scopeId: '', name: 'kind-gitlab', labels: ['docker', 'kind'], state: 'DISABLED', version: '18.5.0', ephemeral: false, createdAt: at(900), lastSeenAt: at(300), online: false, busy: false }],
      inherited: body.scope === 'repository' ? [{ id: '3', uuid: 'u3', engine: 'forgejo-actions', scope: 'installation', scopeId: '', name: 'shared-linux', labels: ['ubuntu-latest'], state: 'ACTIVE', version: 'v13.2.0', ephemeral: false, createdAt: at(900), lastSeenAt: at(1), online: true, busy: false }] : [],
      tokens: [{ id: 't1', engine: 'forgejo-actions', labels: ['ubuntu-latest'], expiresAt: new Date(now + 3600_000).toISOString(), usesLeft: 1, createdAt: at(2) }] } });
  });
  return { state, calls };
}

test('the Actions tab lists runs with server filters, opens a run with its job graph, live folded logs and artifacts', async ({ page }) => {
  const { calls } = await backend(page);
  await page.goto('/alex/demo/actions');
  await expect(page.getByRole('heading', { name: 'All workflows' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Add services: postgres to the test job' })).toBeVisible();
  await expect(page.getByText('Job report calls a reusable workflow')).toBeVisible();
  await page.getByLabel('Status').selectOption('FAILURE');
  await expect.poll(() => calls.some(c => c.action === 'listRuns' && c.status === 'FAILURE')).toBe(true);
  await page.getByLabel('Status').selectOption('');
  await page.getByRole('link', { name: 'Add services: postgres to the test job' }).click();
  await expect(page).toHaveURL(/\/alex\/demo\/actions\/runs\/7$/);
  await expect(page.getByRole('list', { name: 'Job graph' }).getByRole('listitem')).toHaveCount(6);
  await expect(page.getByText('Waiting for a runner with windows-latest')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Download dist-20' })).toBeVisible();
  await page.getByRole('navigation', { name: 'Jobs' }).getByRole('button', { name: /Node 22/ }).click();
  await expect(page.getByRole('log', { name: 'Node 22 log' })).toContainText('✔ sum adds');
  await expect(page.getByRole('log', { name: 'Node 22 log' }).getByText('Run npm test')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Cancel workflow' })).toBeVisible();
});

test('workflow dispatch uses the declared inputs and a deployment waits for a reviewer', async ({ page }) => {
  const { calls } = await backend(page);
  await page.goto('/alex/demo/actions');
  await page.getByRole('navigation', { name: 'Workflows' }).getByRole('link', { name: 'CI' }).click();
  await page.getByRole('button', { name: 'Run workflow' }).click();
  const form = page.getByRole('form', { name: 'Run CI' });
  await form.getByLabel('Release note').fill('rc1');
  await form.getByLabel('Dry run').check();
  await form.getByRole('button', { name: 'Run workflow' }).click();
  await expect.poll(() => calls.find(c => c.action === 'dispatch')).toMatchObject({ workflowPath: '.github/workflows/ci.yml', ref: 'main', inputs: { note: 'rc1', dry: 'true' } });
  await page.goto('/alex/demo/actions/runs/4');
  const review = page.getByRole('region', { name: 'Review deployment for deploy' });
  await review.getByLabel('Comment').fill('Looks good');
  await review.getByRole('button', { name: 'Approve and deploy' }).click();
  await expect.poll(() => calls.find(c => c.action === 'approve')).toMatchObject({ jobId: '42', approve: true, comment: 'Looks good' });
});

test('runner administration shows the inventory first and the exact register command after New runner', async ({ page }) => {
  const { calls } = await backend(page);
  await page.goto('/alex/demo/settings/runners');
  await expect(page.getByRole('table', { name: 'registered runners' })).toContainText('golf-runner-1');
  await expect(page.getByRole('table', { name: 'shared runners' })).toContainText('shared-linux');
  await expect(page.getByRole('form', { name: 'New runner' })).toHaveCount(0);
  await page.getByRole('button', { name: 'New runner' }).click();
  await page.getByRole('form', { name: 'New runner' }).getByRole('button', { name: 'Create registration token' }).click();
  await expect(page.getByRole('region', { name: 'Register the runner' })).toContainText('forgejo-runner register --no-interactive --instance https://golf.example');
  expect(calls.find(c => c.action === 'createToken')).toMatchObject({ scope: 'repository', engine: 'forgejo-actions', ttlHours: 1, uses: 1 });
});

const directory = process.env.GOLF_RUNNER_SHOTS;
const looks = [['flare-dark', 'flare', 'console', 'dark', 1440, 900], ['classic-light', 'classic', 'primer', 'light', 1440, 900], ['golf-tiles', 'golf', 'tiles', 'dark', 1440, 900],
  ['flare-dark-390', 'flare', 'console', 'dark', 390, 844], ['classic-light-390', 'classic', 'primer', 'light', 390, 844], ['golf-tiles-390', 'golf', 'tiles', 'dark', 390, 844]] as const;
for (const [look, appearance, layout, theme, width, height] of looks) test(`Actions screenshots in ${look}`, async ({ page }) => {
  test.skip(!directory, 'Set GOLF_RUNNER_SHOTS to write review screenshots.');
  await mkdir(directory!, { recursive: true });
  await page.setViewportSize({ width, height });
  await page.addInitScript(([a, l, t]: [string, string, string]) => { localStorage.setItem('golf.appearance', a); localStorage.setItem('golf.layout.' + a, l); localStorage.setItem('golf.theme', t); }, [appearance, layout, theme] as [string, string, string]);
  await backend(page);
  const shot = async (name: string) => {
    await page.evaluate(() => { (document.activeElement as HTMLElement | null)?.blur(); window.scrollTo(0, 0); });
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
    await page.screenshot({ path: `${directory}/${look}-${name}.png`, fullPage: true, animations: 'disabled' });
  };
  await page.goto('/alex/demo/actions');
  await expect(page.getByRole('link', { name: 'Add services: postgres to the test job' })).toBeVisible();
  await shot('runs');
  await page.goto('/alex/demo/actions/runs/7');
  await expect(page.getByRole('list', { name: 'Job graph' })).toBeVisible();
  await shot('run-summary');
  await page.getByRole('navigation', { name: 'Jobs' }).getByRole('button', { name: /Node 22/ }).click();
  await expect(page.getByRole('log', { name: 'Node 22 log' })).toContainText('✔ sum adds');
  await page.getByRole('log', { name: 'Node 22 log' }).getByText('Run actions/setup-node@v4', { exact: true }).click();
  await shot('job-log');
  await page.goto('/alex/demo/actions/runs/4');
  await expect(page.getByRole('region', { name: 'Review deployment for deploy' })).toBeVisible();
  await shot('approval');
  await page.goto('/alex/demo/settings/runners');
  await expect(page.getByRole('table', { name: 'registered runners' })).toBeVisible();
  await page.getByRole('button', { name: 'New runner' }).click();
  await page.getByRole('form', { name: 'New runner' }).getByRole('button', { name: 'Create registration token' }).click();
  await expect(page.getByRole('region', { name: 'Register the runner' })).toBeVisible();
  await shot('repository-runners');
  await page.goto('/admin/settings/runners');
  await expect(page.getByRole('table', { name: 'registered runners' })).toBeVisible();
  await shot('admin-runners');
});
