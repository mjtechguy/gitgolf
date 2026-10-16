import { expect, test, type Page } from '@playwright/test';
import { ListCapabilitiesResponseSchema } from '../src/gen/golf/v1/golf_pb';
import { featureBackend } from './feature-policy-fixture';
import { respond } from './rpc';

// A Cloudflare-native installation answering /native/contributions/read as cloudflare/forge/src/contributions.mjs does (the shapes its
// forge tests assert). Review screenshots: GOLF_CONTRIBUTION_SHOTS=/output/directory npx playwright test contribution-graphs
const capabilities = ['settings.repository-general', 'settings.repository-access', 'settings.feature-policy', 'operations.dashboard', 'settings.native', 'operations.ai-usage', 'operations.ai-impact', 'operations.costs'];
const shots = process.env.GOLF_CONTRIBUTION_SHOTS;
const range = { from: '2025-10-12', to: '2026-10-16', year: null };
const kinds = (values: Record<string, number> = {}) => ({ commit: 0, pull_opened: 0, pull_merged: 0, review: 0, issue_opened: 0, issue_closed: 0, comment: 0, proposal_created: 0, proposal_accepted: 0, ...values });
const tiers = (values: Record<string, number> = {}) => ({ agent: 0, token: 0, assisted: 0, declared: 0, none: 0, ...values });
const dayMs = 86400_000;

// Deterministic activity over the year: weekdays busier, a few days with AI involvement.
function personDays() {
  const days = [];
  for (let at = Date.parse('2025-10-12T00:00:00Z'), i = 0; at <= Date.parse('2026-10-16T00:00:00Z'); at += dayMs, i++) {
    const weekday = new Date(at).getUTCDay(), human = weekday === 0 || weekday === 6 ? (i % 5 === 0 ? 1 : 0) : (i * 7) % 9;
    const ai = i % 6 === 0 ? 1 : 0, day = new Date(at).toISOString().slice(0, 10);
    if (!human || day === '2026-10-14') continue;
    days.push({ day, human, ai, kinds: kinds({ commit: human - ai, pull_merged: ai }), agentKinds: kinds(), tiers: tiers({ none: human - ai, assisted: ai }),
      repositories: [{ fullName: 'alex/demo', human: human - (i % 4 === 0 ? 1 : 0), ai }], private: i % 4 === 0 ? 1 : 0 });
  }
  days.push({ day: '2026-10-14', human: 4, ai: 3, kinds: kinds({ commit: 2, pull_merged: 1, review: 1 }), agentKinds: kinds({ proposal_created: 2 }), tiers: tiers({ none: 2, declared: 1, assisted: 1, agent: 2 }),
    repositories: [{ fullName: 'alex/demo', human: 3, ai: 2 }, { fullName: 'alex/tools', human: 1, ai: 1 }], private: 0 });
  return days.sort((a, b) => a.day.localeCompare(b.day));
}
function person(owner: string, self: boolean, showPrivate = false) {
  const days = personDays(), sum = (pick: (day: ReturnType<typeof personDays>[number]) => number) => days.reduce((total, day) => total + pick(day), 0);
  return { state: 'on', person: { login: owner, name: owner === 'alex' ? 'Alex Morgan' : 'Blake' }, range, years: [2026, 2025], days,
    totals: { human: sum(day => day.human), ai: sum(day => day.ai), kinds: kinds({ commit: sum(day => day.kinds.commit), pull_merged: sum(day => day.kinds.pull_merged), review: 1 }),
      agentKinds: kinds({ proposal_created: 2 }), tiers: tiers({ none: sum(day => day.tiers.none), assisted: sum(day => day.tiers.assisted), declared: 1, agent: 2 }), private: sum(day => day.private) },
    streaks: { longest: 6, current: 3 }, repositories: [{ fullName: 'alex/demo', human: sum(day => day.human) - 1, ai: sum(day => day.ai) - 1 }, { fullName: 'alex/tools', human: 1, ai: 1 }],
    privateCounts: { included: self || showPrivate, human: sum(day => day.private) },
    settings: self ? { showPrivate, version: showPrivate ? 1 : 0, canEdit: true } : { showPrivate, canEdit: false } };
}
const impact = {
  state: 'on', range, generatedAt: '2026-10-16T09:00:00Z', unreadable: [], excludedRepositories: 1,
  heatmap: personDays().filter((_, index) => index % 3 === 0).map((day, index) => ({ day: day.day, agent: index % 4, token: index % 6 === 1 ? 2 : 0, assisted: index % 3 ? 1 : 0, declared: index % 5 === 0 ? 1 : 0, none: day.human })),
  kinds: { commit: tiers({ agent: 12, declared: 9, none: 410 }), pull_opened: tiers({ agent: 31, token: 140, none: 12 }), pull_merged: tiers({ agent: 18, assisted: 9, none: 53 }), review: tiers({ agent: 7, none: 88 }),
    issue_opened: tiers({ none: 40 }), issue_closed: tiers({ none: 22 }), comment: tiers({ none: 190 }), proposal_created: tiers({ agent: 46 }), proposal_accepted: tiers({ agent: 18, assisted: 9 }) },
  agentTasks: [{ purpose: 'change', tool: 'claude', state: 'SUCCEEDED', count: 28, tokens: 4_210_000, reported: 28, costed: 26, costUsd: 61.4 }, { purpose: 'change', tool: 'codex', state: 'FAILED', count: 4, tokens: 0, reported: 0, costed: 0, costUsd: 0 },
    { purpose: 'review', tool: 'codex', state: 'SUCCEEDED', count: 7, tokens: 380_000, reported: 7, costed: 0, costUsd: 0 }],
  proposals: { fromTasks: { opened: 31, merged: 27 }, origins: [{ kind: 'agent-task', opened: 31, merged: 27 }, { kind: 'api-token', opened: 140, merged: 118 }, { kind: 'person', opened: 12, merged: 9 }], evidence: [{ state: 'succeeded', count: 18, tokens: 90_000 }, { state: 'failed', count: 3, tokens: 0 }] },
  reviewAdvice: [{ state: 'SUCCEEDED', count: 61 }, { state: 'UNKNOWN', count: 2 }],
  aiRuns: [{ kind: 'review-draft', state: 'SUCCEEDED', count: 33, tokens: 210_000 }, { kind: 'triage', state: 'SUCCEEDED', count: 51, tokens: 64_000 }, { kind: 'triage', state: 'REFUSED', count: 2, tokens: 0 }],
  landing: [{ trigger: 'policy', state: 'LANDED', count: 18 }, { trigger: 'policy', state: 'REVERTED', count: 1 }, { trigger: 'policy', state: 'BLOCKED', count: 4 }, { trigger: 'person', state: 'LANDED', count: 22 }],
  automations: [{ state: 'SUCCEEDED', count: 64, tokens: 120_000, costed: 0, costUsd: 0 }, { state: 'FAILED', count: 3, tokens: 0, costed: 0, costUsd: 0 }],
  costs: { reportedUsd: 61.4, reportingRuns: 26, runs: 106 },
  comparison: { label: 'Time from opening to merge, by how the pull request was opened. A comparison of what happened, not a measured effect of AI.', aiInvolved: { count: 27, medianHours: 1.6 }, other: { count: 53, medianHours: 19.2 }, truncated: false },
};

async function backend(page: Page, options: { owner?: string; showPrivate?: boolean } = {}) {
  const reads: Record<string, unknown>[] = [], writes: Record<string, unknown>[] = [];
  let showPrivate = options.showPrivate ?? false;
  await featureBackend(page);
  await page.route('**/rpc/golf.v1.CapabilityService/ListCapabilities', route => respond(route, ListCapabilitiesResponseSchema, { runtimeProfile: 'cloudflare-native', capabilities: capabilities.map(id => ({ id, label: id, state: 3, reason: 'Available.' })) }));
  await page.route('**/native/public-profile', route => { const owner = route.request().postDataJSON().owner;
    return route.fulfill({ json: { ownerId: owner === 'alex' ? '1' : '2', slug: owner, kind: 'PERSONAL', enabled: true, canEdit: owner === 'alex', revision: 'a'.repeat(64), displayName: owner === 'alex' ? 'Alex Morgan' : 'Blake', bio: '', location: '', website: '', readme: '', pinnedRepositories: [], publicRepositoryCount: 0 } }); });
  await page.route('**/native/discover', route => route.fulfill({ json: { repositories: [], nextPage: 0 } }));
  await page.route('**/native/contributions/read', route => { const body = route.request().postDataJSON(); reads.push(body);
    if (body.action === 'impact') return route.fulfill({ json: impact });
    const view = person(body.owner, body.owner === 'alex', showPrivate);
    return route.fulfill({ json: body.year ? { ...view, range: { from: `${body.year}-01-01`, to: `${body.year}-12-31`, year: body.year }, days: view.days.filter(day => day.day.startsWith(String(body.year))) } : view }); });
  await page.route('**/native/contributions', route => { const body = route.request().postDataJSON(); writes.push(body); showPrivate = body.showPrivate;
    return route.fulfill({ json: { settings: { showPrivate, version: 1, canEdit: true } } }); });
  return { reads, writes };
}

test('a profile leads with a year of contributions: a 53-week calendar, a legend, totals, a day panel, the AI overlay and a table', async ({ page }) => {
  const { reads } = await backend(page);
  await page.goto('/alex');
  const total = person('alex', true).totals.human;
  await expect(page.getByRole('heading', { level: 2, name: `${total.toLocaleString()} contributions in the last year` })).toBeVisible();
  const calendar = page.getByRole('table', { name: 'Contributions by alex in the last year' });
  await expect(calendar).toBeVisible();
  // 53 weeks of columns (plus the weekday labels), seven weekday rows, and a legend from less to more.
  await expect(calendar.locator('tbody tr')).toHaveCount(7);
  await expect(calendar.locator('tbody tr').first().locator("td")).toHaveCount(53);
  await expect(page.getByLabel('Legend')).toContainText('Less'); await expect(page.getByLabel('Legend')).toContainText('More');
  const band = page.getByRole('definition').filter({ hasText: /^6 days$/ });
  await expect(band).toBeVisible();
  // Every day reads in full, on hover and focus, without the colour.
  const busy = calendar.getByRole('button', { name: /4 contributions on .*Oct 14, 2026; 3 with AI involvement/ });
  await busy.hover();
  await expect(page.locator('.contribution-readout')).toContainText('4 contributions on');
  if (shots) await page.screenshot({ path: `${shots}/profile-heatmap.png`, fullPage: true, animations: 'disabled' });
  // The selected day opens below: what happened and where.
  await busy.click();
  const panel = page.getByRole('region', { name: /Oct 14, 2026/ });
  await expect(panel).toContainText('2 commits, 1 pull request merged, 1 review');
  await expect(panel).toContainText('Golf agent work they ran: 2 agent proposals.');
  await expect(panel.getByRole('link', { name: 'alex/tools' })).toBeVisible();
  // The overlay marks AI-involved days with a second hue and a shape, and never changes the human count.
  await expect(calendar.locator('[data-marked=true]')).toHaveCount(0);
  await page.getByRole('checkbox', { name: 'Show AI involvement' }).check();
  await expect(calendar.locator('[data-marked=true]').first()).toBeVisible();
  await expect(busy).toHaveAttribute('data-marked', 'true');
  const tierList = page.getByLabel('AI involvement by tier');
  for (const name of ['Golf agent', 'AI-assisted', 'Declared AI co-author', 'Unlabelled']) await expect(tierList.getByRole('term').filter({ hasText: name })).toBeVisible();
  await expect(page.getByRole('heading', { level: 2, name: `${total.toLocaleString()} contributions in the last year` })).toBeVisible();
  if (shots) await page.screenshot({ path: `${shots}/profile-heatmap-ai-overlay.png`, fullPage: true, animations: 'disabled' });
  if (shots) { await page.evaluate(() => { document.documentElement.dataset.theme = 'dark'; }); await page.screenshot({ path: `${shots}/profile-heatmap-ai-overlay-dark.png`, fullPage: true, animations: 'disabled' }); await page.evaluate(() => { document.documentElement.dataset.theme = 'light'; }); }
  // A table view behind the chart.
  await page.getByRole('button', { name: 'Show as a table' }).click();
  await expect(page.getByRole('table', { name: 'contributions by day' })).toContainText('2026-10-14');
  // The year picker reads one calendar year.
  await page.getByLabel('Period').selectOption('2025');
  await expect(page.getByRole('table', { name: 'Contributions by alex in 2025' })).toBeVisible();
  await expect.poll(() => reads.at(-1)).toMatchObject({ action: 'person', owner: 'alex', year: 2025 });
});

test('the private contributions choice leads with its value and opens a form only on request', async ({ page }) => {
  const { writes } = await backend(page);
  await page.goto('/alex');
  const setting = page.locator('.contribution-privacy');
  await expect(setting).toContainText('Hidden from visitors');
  await expect(page.getByRole('form', { name: 'Private contributions' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Edit private contributions' }).click();
  const form = page.getByRole('form', { name: 'Private contributions' });
  await form.getByRole('checkbox', { name: /anonymous counts/ }).check();
  await form.getByRole('button', { name: 'Save' }).click();
  expect(writes).toEqual([{ action: 'settings', showPrivate: true, expectedVersion: 0 }]);
  await expect(page.getByRole('form', { name: 'Private contributions' })).toHaveCount(0);
  await expect(setting).toContainText('Shown to visitors as anonymous counts');
});

test('a visitor sees no settings, and private activity only as counts by the person’s choice', async ({ page }) => {
  await backend(page, { showPrivate: true });
  await page.goto('/blake');
  await expect(page.getByRole('table', { name: 'Contributions by blake in the last year' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Edit private contributions' })).toHaveCount(0);
  await expect(page.getByText(/in repositories you cannot read, shown as counts by blake’s choice/)).toBeVisible();
});

test('the AI impact page holds counts, not claims: tiers, proposals and acceptance, policy landings, reported cost and a labelled comparison', async ({ page }) => {
  const { reads } = await backend(page);
  await page.goto('/admin/ai-impact');
  await expect(page.getByRole('heading', { level: 1, name: 'AI impact' })).toBeVisible();
  await expect(page.getByRole('navigation', { name: 'Instance administration' }).getByRole('link', { name: 'AI impact' })).toBeVisible();
  expect(reads[0]).toEqual({ action: 'impact' });
  await expect(page.getByRole('note').filter({ hasText: 'Counts, not claims' })).toContainText('1 repository has contribution graphs turned off');
  const summary = page.getByLabel('AI impact summary');
  await expect(summary).toContainText('27 of 80'); await expect(summary).toContainText('34% share');
  await expect(summary).toContainText('27 of 31'); await expect(summary).toContainText('$61.40'); await expect(summary).toContainText('26 of 106');
  await expect(page.getByRole('table', { name: 'AI activity by day, last 12 months' })).toBeVisible();
  await expect(page.getByRole('table', { name: 'contributions by tier' }).getByRole('row', { name: /Pull requests merged/ })).toContainText('80');
  // Work done through an API token has its own column: Golf reports the token, not what was behind it.
  const tokenColumn = page.getByRole('table', { name: 'contributions by tier' }).getByRole('columnheader', { name: /API token/ });
  await expect(tokenColumn).toBeVisible();
  await expect(page.getByRole('table', { name: 'contributions by tier' }).getByRole('row', { name: /Pull requests opened/ })).toContainText('140');
  // The comparison is labelled as one.
  const comparison = page.getByRole('region', { name: 'Comparison: time to merge' });
  await expect(comparison).toContainText('Comparison, not an effect'); await expect(comparison).toContainText('not a measured effect of AI');
  await expect(comparison).toContainText('1.6 h'); await expect(comparison).toContainText('19.2 h');
  await expect(page.getByRole('table', { name: 'agent tasks' })).toContainText('26 of 28 reported');
  // Nothing claims time saved or a productivity multiple.
  await expect(page.locator('main')).not.toContainText(/hours saved|\d+(?:\.\d+)?[x×] (?:faster|more|as)/i);
  if (shots) await page.screenshot({ path: `${shots}/ai-impact.png`, fullPage: true, animations: 'disabled' });
  if (shots) { await page.evaluate(() => { document.documentElement.dataset.theme = 'dark'; }); await page.screenshot({ path: `${shots}/ai-impact-dark.png`, fullPage: true, animations: 'disabled' }); await page.evaluate(() => { document.documentElement.dataset.theme = 'light'; }); }
  await page.getByLabel('Period').selectOption('2025');
  await expect.poll(() => reads.at(-1)).toEqual({ action: 'impact', year: 2025 });
});

test('the AI impact page says which sources it could not read, and why it is off', async ({ page }) => {
  await backend(page);
  await page.route('**/native/contributions/read', route => route.fulfill({ json: { ...impact, unreadable: ['automation-runs'], comparison: { ...impact.comparison, truncated: true } } }));
  await page.goto('/admin/ai-impact');
  await expect(page.getByRole('alert').filter({ hasText: 'automation runs' })).toContainText('missing from the totals, not zero');
  // A capped comparison names which merges it read.
  await expect(page.getByRole('region', { name: 'Comparison: time to merge' })).toContainText('Read from the 20,000 earliest merges in the period; later ones are left out.');
  await page.route('**/native/contributions/read', route => route.fulfill({ json: { state: 'off', reason: 'Contribution graphs are turned off for every repository by the installation policy.' } }));
  await page.reload();
  await expect(page.getByRole('note').filter({ hasText: 'turned off for every repository' })).toBeVisible();
});
