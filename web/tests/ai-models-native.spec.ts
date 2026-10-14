import { expect, test, type Page } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { ListCapabilitiesResponseSchema } from '../src/gen/golf/v1/golf_pb';
import { featureBackend } from './feature-policy-fixture';
import { respond } from './rpc';

// A Cloudflare-native installation with Workers AI, answering as cloudflare/forge/src/ai-models.mjs and ai-usage.mjs do.
const flash = '@cf/zai-org/glm-5.3-flash', glm = '@cf/zai-org/glm-5.3', glm52 = '@cf/zai-org/glm-5.2', qwen = '@cf/qwen/qwen3-embedding-0.6b', bge = '@cf/baai/bge-m3', clef = '@cf/cloudflare/clef';
const capabilities = ['settings.repository-general', 'settings.repository-access', 'settings.feature-policy', 'operations.dashboard', 'settings.native', 'settings.installation-audit', 'settings.ai-models', 'operations.ai-usage'];
const option = (model: string, state = 'available', extra: Record<string, unknown> = {}) => ({ model, state, reason: state === 'available' ? '' : state === 'unverified' ? 'The catalog does not report function calling for this model; capability unverified.' : 'Retired from the catalog 2026-10-12.',
  description: { [flash]: 'GLM 5.3 Flash: fast agentic coding with tool calls.', [glm]: 'GLM 5.3: long-context reasoning and structured output.', [glm52]: 'GLM 5.2: previous generation.', [qwen]: 'Qwen3 Embedding 0.6B.', [bge]: 'BGE M3 multilingual embeddings.' }[model] || '',
  price: model === flash ? '$0.06 per M input tokens · $0.40 per M output tokens' : model === glm ? '$0.30 per M input tokens · $1.20 per M output tokens' : '', contextWindow: model.includes('glm') ? '131072' : '', dimensions: model === qwen || model === bge ? 1024 : 0, ...extra });

export async function aiBackend(page: Page) {
  const state = { versions: { agents: 0, 'review-drafts': 2, 'release-notes': 0, search: 0 } as Record<string, number>, updates: [] as Record<string, unknown>[], repositoryUpdates: [] as Record<string, unknown>[], refreshes: 0, choice: '',
    values: { agents: { default: flash, allowed: [flash, glm], repositoryOverride: false }, 'review-drafts': { default: glm, allowed: [glm, flash], repositoryOverride: true },
      'release-notes': { default: glm, allowed: [glm, flash, glm52], repositoryOverride: false }, search: { default: qwen, allowed: [qwen, bge], repositoryOverride: false } } as Record<string, { default: string; allowed: string[]; repositoryOverride: boolean }> };
  const deploy: Record<string, { default: string; allowed: string[]; repositoryOverride: boolean }> = { agents: { default: flash, allowed: [flash, glm], repositoryOverride: false }, 'review-drafts': { default: glm, allowed: [glm, flash, glm52], repositoryOverride: false },
    'release-notes': { default: glm, allowed: [glm, flash, glm52], repositoryOverride: false }, search: { default: qwen, allowed: [qwen, bge], repositoryOverride: false } };
  const meta: Record<string, [string, string, string, string]> = { agents: ['Agent proposals', 'Text Generation', 'agents', 'OpenCode edits the approved file through tool calls in an isolated fork. The model is part of each proposal’s policy identity.'],
    'review-drafts': ['Summaries and review drafts', 'Text Generation', 'ai-review-drafts', 'Reads a bounded pull request diff and drafts a summary and review notes as strict JSON.'],
    'release-notes': ['Release notes', 'Text Generation', 'ai-release-notes', 'Drafts grouped release notes from merged pull requests and commits as strict JSON.'],
    search: ['Search embeddings', 'Text Embeddings', 'semantic-search', 'Embeds code and discussion chunks for semantic search. Changing it re-indexes every repository.'] };
  const view = () => ({ generatedAt: '2026-10-14T09:30:00Z', editing: { enabled: true, reason: 'Operations administrators signed in through Access choose within the deploy list. Allowing another model or letting repositories choose needs typed confirmation and an Access sign-in from the last 10 minutes.' },
    deploy: { source: 'deploy', valid: true }, allocated: true,
    catalog: { reads: [{ task: 'Text Generation', state: 'succeeded', readAt: '2026-10-14T09:20:00Z', attemptedAt: '2026-10-14T09:20:00Z', models: 41, reason: '' }, { task: 'Text Embeddings', state: 'succeeded', readAt: '2026-10-14T09:20:00Z', attemptedAt: '2026-10-14T09:20:00Z', models: 6, reason: '' }], stale: false, refreshable: true },
    uses: [
      ...['agents', 'advice', 'review-drafts', 'triage', 'release-notes', 'search'].map(use => use === 'advice' || use === 'triage'
        ? { use, label: use === 'advice' ? 'Review advice' : 'Issue triage', detail: use === 'advice' ? 'One constrained question about the next review step, answered with a probability for each option.' : 'Ranks up to 20 of the repository’s own labels for an issue with probabilities.', feature: use, fixed: true, task: 'Constrained choice', value: { default: clef, allowed: [clef], repositoryOverride: false }, reason: 'Clef is the only catalog model that returns calibrated probabilities for a constrained choice, so it is fixed here.' }
        : { use, label: meta[use]![0], task: meta[use]![1], feature: meta[use]![2], detail: meta[use]![3], needs: use === 'agents' ? 'function calling' : '', embedding: use === 'search', value: state.values[use], deploy: deploy[use]!,
          source: state.versions[use] ? 'installation' : 'deploy', version: String(state.versions[use]), updatedAt: state.versions[use] ? '2026-10-13T16:05:00Z' : '', updatedBy: state.versions[use] ? 'alex' : '',
          options: deploy[use]!.allowed.map(model => use === 'release-notes' && model === glm52 ? option(model, 'retired') : use === 'agents' && model === glm ? option(model, 'unverified') : option(model)),
          otherCatalogModels: use === 'search' ? 4 : 38, repositoriesOverriding: state.values[use]!.repositoryOverride ? 3 : 0, confirmation: 'ai.model.' + use,
          notes: use === 'release-notes' ? [`${glm52} was retired from the catalog. Repositories that chose it fall back to the default. Recorded runs keep their model.`] : [],
          ...(use === 'search' ? { reindex: { known: true, repositories: 0, chunks: 0, calls: 0 } } : {}) }),
    ] });
  const repository = () => ({ repositoryId: '41', canEdit: true, allocated: true, uses: [
    { use: 'agents', label: 'Agent proposals', model: flash, source: 'deploy', note: '', overrideAllowed: false, default: flash, allowed: [], choice: '', version: '0' },
    { use: 'advice', label: 'Review advice', fixed: true, model: clef, source: 'fixed', note: '', overrideAllowed: false, allowed: [], choice: '', version: '0' },
    { use: 'review-drafts', label: 'Summaries and review drafts', model: state.choice || glm, source: state.choice ? 'repository' : 'installation', note: '', overrideAllowed: true, default: glm, allowed: [{ model: glm, description: '' }, { model: flash, description: '' }], choice: state.choice, version: String(state.repositoryUpdates.length) },
    { use: 'triage', label: 'Issue triage', fixed: true, model: clef, source: 'fixed', note: '', overrideAllowed: false, allowed: [], choice: '', version: '0' },
    { use: 'release-notes', label: 'Release notes', model: glm, source: 'deploy', note: '', overrideAllowed: false, default: glm, allowed: [], choice: '', version: '0' },
    { use: 'search', label: 'Search embeddings', model: qwen, source: 'deploy', note: '', overrideAllowed: false, default: qwen, allowed: [], choice: '', version: '0' } ] });
  await featureBackend(page);
  await page.route('**/rpc/golf.v1.CapabilityService/ListCapabilities', route => respond(route, ListCapabilitiesResponseSchema, { runtimeProfile: 'cloudflare-native', capabilities: capabilities.map(id => ({ id, label: id, state: 3, reason: 'Available.' })) }));
  await page.route('**/native/ai-models/read', route => {
    const body = route.request().postDataJSON();
    return route.fulfill({ json: body.action === 'repository' ? repository() : view() });
  });
  await page.route('**/native/ai-models', route => {
    const body = route.request().postDataJSON();
    if (body.action === 'refresh-catalog') { state.refreshes++; return route.fulfill({ json: view() }); }
    if (body.action === 'repository-update') { state.repositoryUpdates.push(body); state.choice = body.model; return route.fulfill({ json: repository() }); }
    state.updates.push(body);
    const before = state.values[body.use]!, widening = body.value.allowed.some((m: string) => !before.allowed.includes(m)) || body.value.repositoryOverride && !before.repositoryOverride;
    if (body.expectedVersion !== String(state.versions[body.use])) return route.fulfill({ status: 412, json: { code: 'failed_precondition', message: 'This model setting changed since you read it. Refresh before editing.' } });
    if (widening && body.confirmation !== 'ai.model.' + body.use) return route.fulfill({ status: 412, json: { code: 'failed_precondition', message: `Type ai.model.${body.use} to confirm it.` } });
    state.values[body.use] = body.value; state.versions[body.use] = (state.versions[body.use] || 0) + 1;
    return route.fulfill({ json: { key: 'ai.model.' + body.use, use: body.use, version: String(state.versions[body.use]), value: body.value, widening, operationId: body.operationId, at: '2026-10-14T09:31:00Z' } });
  });
  return state;
}

export function usageAnswer(gatewayState: 'observed' | 'degraded' = 'observed') {
  const today = new Date().toISOString().slice(0, 10), day = (n: number) => new Date(Date.now() - n * 86400_000).toISOString().slice(0, 10);
  const row = (n: number, feature: string, source: string, model: string, runs: number, failed: number, input: number, output: number, tokens = input + output) => ({ day: day(n), feature, source, model, runs, succeeded: runs - failed - (feature === 'review-draft' && n === 0 ? 1 : 0), failed, refused: feature === 'review-draft' && n === 0 ? 1 : 0, pending: 0, inputTokens: input, outputTokens: output, tokens, reported: runs - failed });
  return { generatedAt: new Date().toISOString(), days: 14, since: day(13), today, allocated: true, limit: { daily: 100, todayRuns: 37, source: 'deploy' },
    rows: [row(0, 'review-draft', 'runs', glm, 22, 1, 182_400, 21_300), row(0, 'release-notes', 'runs', glm, 4, 0, 31_000, 6_100), row(0, 'triage', 'runs', clef, 11, 0, 9_800, 110),
      row(1, 'review-draft', 'runs', flash, 31, 2, 210_000, 18_000), row(2, 'review-draft', 'runs', glm, 18, 0, 150_000, 17_500), row(3, 'triage', 'runs', clef, 9, 0, 8_100, 90), row(5, 'review-draft', 'runs', glm, 64, 3, 520_000, 61_000),
      row(8, 'release-notes', 'runs', glm, 7, 1, 52_000, 9_400), row(11, 'index', 'runs', qwen, 48, 0, 640_000, 0),
      row(0, 'advice', 'advice', clef, 6, 0, 2_400, 6), row(4, 'agents', 'agents', flash, 3, 1, 0, 0, 41_800)],
    unreadable: [], caps: { requestsPerMinute: 60, spendCentsPerDay: 500 },
    gateway: gatewayState === 'observed' ? { state: 'observed', reason: '', gateway: 'golf-demo-ai', window: { start: new Date(Date.now() - 86400_000).toISOString(), end: new Date().toISOString() }, requests: 46, errors: 1, cost: 0.1873, tokensIn: 233_600, tokensOut: 27_516,
      models: [{ model: glm, requests: 27, cost: 0.1601, errors: 1 }, { model: clef, requests: 17, cost: 0.0041, errors: 0 }, { model: flash, requests: 2, cost: 0.0231, errors: 0 }] }
      : { state: 'degraded', reason: 'The analytics API refused the query: unknown field "aiGatewayRequestsAdaptiveGroups".', gateway: 'golf-demo-ai', window: { start: new Date(Date.now() - 86400_000).toISOString(), end: new Date().toISOString() } } };
}

test('administrators choose each use case’s default and allowed models; widening needs the typed key', async ({ page }) => {
  const state = await aiBackend(page);
  await page.goto('/admin/ai');
  await expect(page.getByRole('heading', { level: 1, name: 'AI models' })).toBeVisible();
  await expect(page.getByRole('navigation', { name: 'Instance administration' }).getByRole('link', { name: 'AI models' })).toBeVisible();
  await expect(page.getByRole('navigation', { name: 'Instance administration' }).getByRole('link', { name: 'AI usage' })).toBeVisible();
  // Clef is fixed: no edit control for advice or triage.
  await expect(page.getByRole('region', { name: 'Review advice' })).toContainText('Clef is the only catalog model');
  await expect(page.getByRole('button', { name: 'Edit Review advice models' })).toHaveCount(0);
  await expect(page.getByRole('region', { name: 'Model warnings' })).toContainText('glm-5.2 was retired');
  await page.getByRole('button', { name: 'Edit Agent proposals models' }).click();
  const editor = page.getByRole('form', { name: 'Edit Agent proposals models' });
  // An unverified model already allowed may stay; it cannot become the default only by being listed.
  await expect(editor.getByText('Capability unverified', { exact: true })).toBeVisible();
  await editor.getByRole('checkbox', { name: /glm-5\.3 Capability unverified/ }).uncheck();
  await editor.getByRole('button', { name: 'Save agent proposals models' }).click();
  await expect(page.getByRole('status')).toContainText('Agent proposals: zai-org/glm-5.3-flash by default, 1 allowed.');
  expect(state.updates.at(-1)).toMatchObject({ use: 'agents', expectedVersion: '0', value: { default: flash, allowed: [flash], repositoryOverride: false } });
  expect(state.updates.at(-1)).not.toHaveProperty('confirmation');
  // Letting repositories choose widens: the typed key is required before saving.
  await page.getByRole('button', { name: 'Edit Search embeddings models' }).click();
  const search = page.getByRole('form', { name: 'Edit Search embeddings models' });
  await search.getByRole('checkbox', { name: 'Repository administrators may choose another allowed model' }).check();
  const save = search.getByRole('button', { name: 'Save search embeddings models' });
  await expect(save).toBeDisabled();
  await search.getByLabel(/Type ai\.model\.search/).fill('ai.model.search');
  await save.click();
  await expect(page.getByRole('status')).toContainText('repositories may choose');
  expect(state.updates.at(-1)).toMatchObject({ use: 'search', confirmation: 'ai.model.search', value: { repositoryOverride: true } });
  await expect(page.getByRole('table', { name: 'Deploy-listed models' })).toContainText('$0.06 per M input tokens');
});

test('AI usage shows the run ledger first and says when gateway analytics are degraded', async ({ page }) => {
  await aiBackend(page);
  let answer = usageAnswer('degraded');
  await page.route('**/native/ai-usage/read', route => route.fulfill({ json: answer }));
  await page.goto('/admin/ai-usage');
  await expect(page.getByRole('heading', { level: 1, name: 'AI usage' })).toBeVisible();
  await expect(page.getByLabel('AI usage summary')).toContainText('37 of 100');
  await expect(page.getByRole('alert')).toContainText('Gateway analytics unavailable: The analytics API refused the query');
  await expect(page.getByText('Cost estimate')).toHaveCount(0);
  await expect(page.getByRole('list', { name: 'Tokens by feature' })).toContainText('Review drafts');
  await expect(page.getByRole('table', { name: 'AI usage by model' })).toContainText('zai-org/glm-5.3');
  answer = usageAnswer('observed');
  await page.getByRole('button', { name: 'Refresh' }).click();
  await expect(page.getByText('AI Gateway’s cost estimate, last 24 h, against a 500-cent limit')).toBeVisible();
  await expect(page.getByText('remaining allowance is not observed', { exact: false })).toBeVisible();
});

test('repository administrators choose a model only where the installation allows it', async ({ page }) => {
  const state = await aiBackend(page);
  await page.goto('/alex/demo/settings');
  const section = page.getByRole('region', { name: 'AI models' });
  await expect(section).toContainText('Summaries and review drafts');
  await expect(section.getByRole('button', { name: /^Choose the/ })).toHaveCount(1);
  await section.getByRole('button', { name: 'Choose the Summaries and review drafts model' }).click();
  await section.getByLabel('Model for this repository').selectOption(flash);
  await section.getByRole('button', { name: 'Save model' }).click();
  await expect(section.getByRole('status')).toContainText('Summaries and review drafts: zai-org/glm-5.3-flash.');
  expect(state.repositoryUpdates).toEqual([{ action: 'repository-update', repository: { owner: 'alex', name: 'demo' }, repositoryId: '41', use: 'review-drafts', model: flash, expectedVersion: '0' }]);
  await expect(section).toContainText('This repository');
});

// Review screenshots: GOLF_AI_SHOTS=/tmp/golf-ui-review/ai-shots npx playwright test ai-models-native
const directory = process.env.GOLF_AI_SHOTS;
const looks = [['flare-dark', 'flare', 'console', 'dark'], ['classic-light', 'classic', 'primer', 'light'], ['golf-tiles', 'golf', 'tiles', 'dark']] as const;
for (const [look, appearance, layout, theme] of looks) for (const width of [1440, 390]) test(`AI admin screens in ${look} at ${width}`, async ({ page }) => {
  test.skip(!directory, 'Set GOLF_AI_SHOTS to write review screenshots.');
  await mkdir(`${directory}/models`, { recursive: true }); await mkdir(`${directory}/usage`, { recursive: true });
  await page.setViewportSize({ width, height: width > 500 ? 900 : 844 });
  await page.addInitScript(([a, l, t]: [string, string, string]) => { localStorage.setItem('golf.appearance', a); localStorage.setItem('golf.layout.' + a, l); localStorage.setItem('golf.theme', t); }, [appearance, layout, theme] as [string, string, string]);
  await aiBackend(page);
  await page.route('**/native/ai-usage/read', route => route.fulfill({ json: usageAnswer('observed') }));
  const shot = async (path: string) => {
    await page.evaluate(() => { (document.activeElement as HTMLElement | null)?.blur(); window.scrollTo(0, 0); });
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
    await page.screenshot({ path: `${directory}/${path}-${look}-${width}.png`, fullPage: true, animations: 'disabled' });
  };
  await page.goto('/admin/ai');
  await expect(page.getByRole('region', { name: 'Search embeddings' })).toBeVisible();
  await shot('models/admin-models');
  await page.getByRole('button', { name: 'Edit Summaries and review drafts models' }).click();
  await page.getByRole('form', { name: 'Edit Summaries and review drafts models' }).getByRole('checkbox', { name: /glm-5\.2/ }).check();
  await page.getByRole('form', { name: 'Edit Summaries and review drafts models' }).getByLabel(/Type ai\.model/).fill('ai.model.review-drafts');
  await shot('models/admin-models-edit');
  await page.goto('/alex/demo/settings');
  await expect(page.getByRole('region', { name: 'AI models' }).getByText('Summaries and review drafts')).toBeVisible();
  await page.getByRole('button', { name: 'Choose the Summaries and review drafts model' }).click();
  await page.getByRole('region', { name: 'AI models' }).scrollIntoViewIfNeeded();
  await shot('models/repository-models');
  await page.goto('/admin/ai-usage');
  await expect(page.getByRole('list', { name: 'AI runs by day' })).toBeVisible();
  await shot('usage/admin-usage');
  await page.route('**/native/ai-usage/read', route => route.fulfill({ json: usageAnswer('degraded') }));
  await page.getByRole('button', { name: 'Refresh' }).click();
  await expect(page.getByText('Gateway analytics unavailable')).toBeVisible();
  await shot('usage/admin-usage-degraded');
});
