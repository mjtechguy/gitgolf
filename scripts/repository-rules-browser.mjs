// Prepared actual read-only Rules UI proof. Credentials only enter through stdin.
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { writeFile, chmod } from 'node:fs/promises';
let config, browser, context, page, stage = 'initialization';
const captures = [], errors = [], pending = [], statuses = {}, counts = {};
const method = 'GetRepositoryRules';
function check(value) { if (!value) throw new Error('assertion'); }
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(k => [k, canonical(value[k])]));
  return value;
}
function same(left, right) { return JSON.stringify(canonical(left)) === JSON.stringify(canonical(right)); }
function target(body, selected) { check(same(body.repository, selected.repository) && body.repositoryId === selected.repositoryId && body.ownerId === selected.ownerId && body.expectedRevision === selected.expectedRevision); }
function receipt(body, expected) { check(same(body, expected)); }
if (process.argv.includes('--self-check')) {
  check(same({ a: 1, b: [{ c: '2' }] }, { b: [{ c: '2' }], a: 1 }));
  check(!same({ b: [{ c: '2' }] }, { b: [{ c: 2 }] }));
  const selected = { repository: { owner: 'fixture', name: 'rules' }, repositoryId: '7', ownerId: '9', expectedRevision: 'a'.repeat(64) };
  target(selected, selected);
  for (const field of ['repositoryId', 'ownerId', 'expectedRevision']) {
    let refused = false; try { target({ ...selected, [field]: 'wrong' }, selected); } catch { refused = true; } check(refused);
  }
  let refused = false; try { receipt({ branchProtections: [] }, { branchProtections: [{ ruleName: 'main' }] }); } catch { refused = true; } check(refused);
  console.log('PASS: pure exact Rules browser target/whole-receipt checks; no browser or runtime operations');
  process.exit(0);
}
async function capture(theme, width, state) {
  check(await page.locator('html').getAttribute('data-theme') === theme);
  await page.evaluate(() => document.fonts.ready);
  const metrics = await page.evaluate(() => ({ documentWidth: document.documentElement.scrollWidth, viewportWidth: innerWidth, fontLoaded: document.fonts.check('16px Archivo') }));
  check(metrics.documentWidth <= width && metrics.viewportWidth === width && metrics.fontLoaded && errors.length === 0);
  const text = await page.locator('body').innerText(); check(!text.includes(config.password));
  check(text.includes('Read-only native configuration.') && text.includes('Branch protection') && text.includes('Tag protection') && text.includes('Merge configuration'));
  const id = 'rules-'+theme+'-'+width+'-'+state;
  await page.screenshot({ path: join(config.screenshots, id+'.png'), fullPage: true }); await chmod(join(config.screenshots, id+'.png'), 0o600);
  await writeFile(join(config.screenshots, id+'.txt'), text, { mode: 0o600 });
  captures.push({ id, page: 'Repository settings · Rules', state, theme, viewport: { width, height: 900 }, ...metrics, image: id+'.png', text: id+'.txt', result: 'captured', caption: 'Actual disposable ordinary-owner read-only configured native rules. Inventory, explicitly opened details and reload; not rule editing, effective matching, trusted checks or protected merge qualification.' });
}
async function settled() { await Promise.all(pending); check(errors.length === 0); }
try {
  let input = ''; for await (const chunk of process.stdin) { input += chunk; check(Buffer.byteLength(input) <= 65536); }
  config = JSON.parse(input); input = '';
  check(config.repository === config.target.repository.owner+'/'+config.target.repository.name && config.expected.repositoryId === config.target.repositoryId && config.expected.ownerId === config.target.ownerId);
  const { chromium } = await import(pathToFileURL(join(config.stackRoot, 'web/node_modules/playwright/index.mjs')));
  browser = await chromium.launch(); context = await browser.newContext(); page = await context.newPage();
  page.on('pageerror', () => errors.push('pageerror'));
  page.on('request', request => {
    const path = new URL(request.url()).pathname; if (!path.startsWith('/rpc/')) return;
    const name = path.split('/').at(-1); counts[name] = (counts[name] || 0)+1;
    // Read-only navigation is the purpose; any unexpected mutation is blocked.
    if (!/^(?:Get|List|Inspect)/.test(name) && !['LoginWithPassword', 'Logout'].includes(name)) errors.push('unexpected_mutation');
    if (name === method) try { target(request.postDataJSON(), config.target); } catch { errors.push('target'); }
  });
  await page.route('**/rpc/**', async route => {
    const name = new URL(route.request().url()).pathname.split('/').at(-1);
    if (!/^(?:Get|List|Inspect)/.test(name) && !['LoginWithPassword', 'Logout'].includes(name)) { errors.push('blocked_mutation'); await route.abort(); }
    else await route.continue();
  });
  page.on('response', response => {
    const name = new URL(response.url()).pathname.split('/').at(-1); if (name !== method) return;
    const key = name+':'+response.status(); statuses[key] = (statuses[key] || 0)+1;
    pending.push((async () => { check(response.status() === 200 && response.headers()['cache-control'] === 'no-store'); receipt(await response.json(), config.expected); })().catch(() => errors.push('receipt')));
  });
  stage = 'managed ordinary-owner sign-in'; await page.goto(config.golf);
  await page.getByLabel('Email or username', { exact: true }).fill(config.email); await page.getByLabel('Password', { exact: true }).fill(config.password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click(); await page.getByRole('form', { name: 'Golf account sign-in', exact: true }).waitFor({ state: 'detached' });
  for (const theme of ['dark', 'light']) for (const width of [1440, 390]) {
    const at = value => { stage = value+' · '+theme+' '+width; };
    at('canonical Rules navigation'); await page.setViewportSize({ width, height: 900 }); await page.goto(config.golf+'/'+config.repository+'/settings/rules');
    const inspect = page.getByRole('button', { name: 'Inspect branch rule main', exact: true }); await inspect.waitFor();
    at('real theme selection'); const toggle = page.getByRole('button', { name: 'Switch to '+theme+' theme', exact: true }); if (await toggle.count()) await toggle.click();
    check(new URL(page.url()).pathname === '/'+config.repository+'/settings/rules'); await settled();
    check(await page.getByRole('dialog').count() === 0);
    at('native inventory capture'); await capture(theme, width, 'inventory');
    at('explicit item details'); await inspect.click(); const dialog = page.getByRole('dialog', { name: 'Branch rule main', exact: true }); await dialog.waitFor();
    check((await dialog.innerText()).includes('9007199254740993') && (await dialog.innerText()).includes('golf/security'));
    at('native item details capture'); await settled(); await capture(theme, width, 'details');
    at('close and reload'); await dialog.getByRole('button', { name: 'Close rule details', exact: true }).click(); await dialog.waitFor({ state: 'detached' });
    const previousReads = counts[method]; await page.reload(); await inspect.waitFor(); await settled(); check(counts[method] > previousReads);
    check(new URL(page.url()).pathname === '/'+config.repository+'/settings/rules' && await page.getByRole('dialog').count() === 0);
    at('reloaded inventory capture'); await capture(theme, width, 'reload');
  }
  await settled(); check(captures.length === 12);
  await writeFile(join(config.screenshots, 'browser-manifest.json'), JSON.stringify({ status: 'browser_checks_passed_parent_cleanup_pending', runtime: config.runtime, captures, requestCounts: counts, procedureStatusCounts: statuses }, null, 2), { mode: 0o600 });
  console.log('PASS: actual canonical Rules inventories/details/reloads and12 font-loaded dark/light1440/390 captures');
} catch (error) {
  process.exitCode = 1; console.error('Rules browser failed at '+stage+'; '+(error.name === 'TimeoutError' ? 'TimeoutError' : 'assertion/error')+'; private diagnostics withheld');
  if (config?.screenshots) await writeFile(join(config.screenshots, 'browser-manifest.json'), JSON.stringify({ status: 'failed', failedStage: stage, runtime: config.runtime, captures, requestCounts: counts, procedureStatusCounts: statuses, failureCategories: [...new Set(errors)] }, null, 2), { mode: 0o600 });
} finally {
  if (context && config) try {
    const response = await context.request.post(config.golf+'/rpc/golf.v1.SessionService/Logout', { headers: { Origin: config.golf, 'Connect-Protocol-Version': '1', 'Content-Type': 'application/json' }, data: {} }); check(response.status() === 200);
  } catch { console.error('Rules browser logout failed'); process.exitCode = 1; }
  await browser?.close();
}
