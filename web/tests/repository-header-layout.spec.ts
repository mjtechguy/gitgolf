import { expect, test, type Page } from '@playwright/test';
import { ListCapabilitiesResponseSchema } from '../src/gen/golf/v1/golf_pb';
import { respond } from './rpc';
import { featureBackend } from './feature-policy-fixture';

// Every layout keeps the repository header on one row inside its bar: nothing spills above or below the top bar,
// nothing runs under the top-bar controls, and the repository action group never splits across lines.
const layouts = [['classic', 'primer'], ['classic', 'workbench'], ['classic', 'reader'], ['golf', 'refined'], ['golf', 'strokes'], ['golf', 'tiles'],
  ['flare', 'kumo'], ['flare', 'overview'], ['flare', 'console']] as const;
const capabilities = ['repository.semantic-search', 'repository.live', 'repository.packages', 'repository.releases', 'settings.repository-general']
  .map(id => ({ id, label: id, state: 3, reason: 'Available.' }));

async function open(page: Page, appearance: string, layout: string, width: number, path: string) {
  await page.addInitScript(([a, l]) => { localStorage.setItem('golf.appearance', a!); localStorage.setItem(`golf.layout.${a}`, l!); localStorage.setItem('golf.theme', 'dark'); }, [appearance, layout]);
  await page.setViewportSize({ width, height: width < 500 ? 844 : 900 });
  await featureBackend(page);
  await page.route('**/rpc/golf.v1.CapabilityService/ListCapabilities', route => respond(route, ListCapabilitiesResponseSchema, { runtimeProfile: 'cloudflare-native', capabilities }));
  await page.goto(path);
  await expect(page.locator('.repository-identity-actions').first()).toBeVisible();
}

function measure(page: Page) {
  return page.evaluate(() => {
    const shown = (el: Element) => { const b = el.getBoundingClientRect(), cs = getComputedStyle(el);
      return b.width > 2 && b.height > 2 && cs.visibility !== 'hidden' && cs.clipPath !== 'inset(50%)' && !el.closest('.sr-only,[hidden],.repository-identity-compact,details:not([open]) > :not(summary)'); };
    const name = (el: Element) => (el.getAttribute('aria-label') || el.textContent || el.tagName).trim().slice(0, 24);
    const bar = document.querySelector('.topbar')!, box = bar.getBoundingClientRect(), controls = document.querySelector('.topbar-controls')?.getBoundingClientRect();
    const items = [...bar.querySelectorAll('a,button,input,h1,.live-status')].filter(shown);
    const outside = items.filter(el => { const b = el.getBoundingClientRect(); return b.top < box.top - 1 || b.bottom > box.bottom + 1 || b.right > innerWidth + 1; }).map(name);
    const under = controls ? items.filter(el => !el.closest('.topbar-controls') && !el.contains(document.querySelector('.topbar-controls'))).filter(el => {
      const b = el.getBoundingClientRect(); return b.right > controls.left + 1 && b.left < controls.right - 1 && b.bottom > controls.top + 1 && b.top < controls.bottom - 1; }).map(name) : [];
    const group = document.querySelector('.repository-identity:not(.repository-identity-compact) .repository-identity-actions') || document.querySelector('.context-crumb .repository-identity-actions');
    const rows = group ? new Set([...group.children].filter(shown).map(c => { const b = c.getBoundingClientRect(); return Math.round((b.top + b.height / 2) / 14); })).size : 0;
    return { outside, under, rows };
  });
}

for (const width of [1440, 1100, 900]) for (const [appearance, layout] of layouts) {
  test(`${appearance} ${layout} header fits at ${width}`, async ({ page }) => {
    const places: string[] = [];
    for (const path of ['/alex/demo', '/alex/demo/actions', '/alex/demo/issues']) {
      await open(page, appearance, layout, width, path);
      expect(await measure(page), path).toEqual({ outside: [], under: [], rows: 1 });
      places.push(await page.locator('.repository-identity-actions').first().evaluate(el => el.closest('.topbar') ? 'top bar' : 'page'));
    }
    // The controls stay in one place on every repository page of a layout.
    expect(new Set(places).size).toBe(1);
  });
}
