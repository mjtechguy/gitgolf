import { expect, test, type Locator, type Page } from '@playwright/test';
import { base, head, largeBackend, largeURLs } from './large-views-fixture';

// Large rows are memoized: an update that leaves a row's data alone does not render it again. React gives a host node a new
// props object (its `__reactProps$` key) whenever the component that owns the node renders, so the same node with the same
// props object means the row neither rendered again nor was replaced.
type Marked = Window & { markedRows?: Map<Element, unknown>; reactProps?: (element: Element) => unknown };
async function mark(page: Page, rows: Locator[]) {
  await page.evaluate(() => { const w = window as Marked; w.markedRows = new Map(); w.reactProps = element => { const key = Object.keys(element).find(name => name.startsWith('__reactProps$')); if (!key) throw new Error('React props key not found; the render check needs updating.'); return (element as unknown as Record<string, unknown>)[key]; }; });
  for (const row of rows) await row.evaluate(element => { const w = window as Marked; w.markedRows!.set(element, w.reactProps!(element)); });
}
// Hundreds of rows, each reading its own reactions, take a while under a loaded parallel run.
const loading = 30_000;
const unchanged = (rows: Locator[]) => Promise.all(rows.map(row => row.evaluate(element => { const w = window as Marked; return w.markedRows!.has(element) && w.markedRows!.get(element) === w.reactProps!(element); })));

for (const [kind, url, more] of [['issues', largeURLs.issues, 'Load more issues'], ['pull requests', largeURLs.pulls, 'Load more pull requests']] as const) test(`loading more ${kind} renders only the new rows`, async ({ page }) => {
  const state = await largeBackend(page); state.firstPage = 480;
  await page.goto(url);
  const rows = page.locator('.issue-list>li');
  await expect(rows).toHaveCount(480, { timeout: loading });
  const marked = [rows.first(), rows.nth(240), rows.nth(479)];
  await mark(page, marked);
  await page.getByRole('button', { name: more }).click();
  await expect(rows).toHaveCount(500);
  await expect(page.getByText(`500 loaded ${kind}`)).toBeVisible();
  expect(await unchanged(marked)).toEqual([true, true, true]);
});

for (const [kind, url, refresh, read] of [['issue', largeURLs.issue, 'Refresh issue', 'GetIssue'], ['pull request', largeURLs.pull, 'Refresh pull request', 'GetPullRequest']] as const) {
  test(`refreshing a ${kind} with 300 comments renders no comment again`, async ({ page }) => {
    const state = await largeBackend(page);
    await page.goto(url);
    const rows = page.locator('.issue-comments .issue-comment-list>li');
    await expect(rows).toHaveCount(300, { timeout: loading });
    const marked = [rows.first(), rows.nth(150), rows.last()];
    await mark(page, marked);
    const reads = state.methods.filter(method => method === read).length;
    await page.getByRole('button', { name: refresh }).click();
    await expect.poll(() => state.methods.filter(method => method === read).length).toBe(reads + 1);
    await expect(page.getByRole('button', { name: refresh })).toBeEnabled();
    await expect(rows).toHaveCount(300);
    expect(await unchanged(marked)).toEqual([true, true, true]);
  });
  test(`a ${kind} refresh that is denied still hides every comment`, async ({ page }) => {
    const state = await largeBackend(page);
    await page.goto(url);
    await expect(page.locator('.issue-comments .issue-comment-list>li')).toHaveCount(300, { timeout: loading });
    state.errors[read] = 'permission_denied';
    await page.getByRole('button', { name: refresh }).click();
    await expect.poll(() => state.methods.filter(method => method === read).length).toBeGreaterThan(1);
    await expect(page.locator('.issue-comments')).toHaveCount(0);
    await expect(page.getByText(/PRIVATE comment/)).toHaveCount(0);
  });
}

test('marking a file viewed or selecting a line renders no other file of a 100-file diff', async ({ page }) => {
  await largeBackend(page);
  await page.goto(largeURLs.files);
  const files = page.locator('.diff-file');
  await expect(files).toHaveCount(100, { timeout: loading });
  await expect(page.locator('.diff-lines tr')).toHaveCount(5400, { timeout: loading });
  const marked = [files.nth(50), files.nth(50).locator('.diff-lines tr').nth(3), files.nth(99).locator('.diff-lines tr').last()];
  await mark(page, marked);
  await files.nth(10).getByRole('checkbox', { name: 'Viewed' }).check();
  await expect(page.getByText('1/100 viewed')).toBeVisible();
  await expect(files.nth(10).getByRole('button', { name: /^Expand / })).toBeVisible();
  expect(await unchanged(marked)).toEqual([true, true, true]);
  await files.first().getByRole('link', { name: 'Line 12' }).first().click();
  await expect(page).toHaveURL(/-file-0-L12$/);
  await expect(files.first().getByRole('link', { name: 'Line 12' }).first()).toHaveAttribute('aria-current', 'location');
  expect(await unchanged(marked)).toEqual([true, true, true]);
});

// Off-screen files skip layout (content-visibility), so a link to a line deep in the diff must still land on it.
test('opening a link to a line deep in a large diff scrolls to that line', async ({ page }) => {
  await largeBackend(page);
  const line = `diff-${base}-${head}-file-80-R205`;
  await page.goto(`${largeURLs.files}#${line}`);
  await expect(page.locator('.diff-lines tr')).toHaveCount(5400, { timeout: loading });
  await expect(page.locator(`[id="${line}"]`)).toHaveAttribute('aria-current', 'location');
  await expect(page.locator(`[id="${line}"]`)).toBeInViewport();
});
