// Disposable native fixture supplied on stdin; never print provider credentials.
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
let browser, context, config, stage = 'initialization';
const check = value => { if (!value) throw new Error('assertion'); };
try {
  const { chromium } = await import(pathToFileURL(join(process.cwd(), 'web/node_modules/playwright/index.mjs')));
  let input = ''; for await (const chunk of process.stdin) input += chunk;
  config = JSON.parse(input); input = '';
  browser = await chromium.launch(); context = await browser.newContext();
  const page = await context.newPage(); const errors = [];
  page.on('pageerror', () => errors.push(true));
  stage = 'sign in'; await page.goto(config.golf);
  await page.getByText('Advanced token sign-in', { exact: true }).click();
  await page.getByLabel('Provider access token', { exact: true }).fill(config.token);
  await page.getByRole('button', { name: 'Continue to workspace', exact: true }).click();
  await page.getByLabel('Your account', { exact: true }).waitFor();
  stage = 'team administration';
  await page.goto(`${config.golf}/organizations/${encodeURIComponent(config.organization)}/teams/${config.teamId}/settings`);
  await page.getByRole('table', { name: 'Team members', exact: true }).waitFor();
  check(await page.getByLabel('Account username', { exact: true }).count() === 0);
  stage = 'cancel draft'; await page.getByRole('button', { name: 'Add member', exact: true }).click();
  await page.getByLabel('Account username', { exact: true }).fill('Discard this draft');
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  check(await page.getByLabel('Account username', { exact: true }).count() === 0);
  stage = 'resolve and add'; await page.getByRole('button', { name: 'Add member', exact: true }).click();
  await page.getByLabel('Account username', { exact: true }).fill(config.targetLogin);
  await page.getByRole('button', { name: 'Resolve member', exact: true }).click();
  await page.getByRole('heading', { name: 'Review team access', exact: true }).waitFor();
  check((await page.locator('.credential-uncertain').innerText()).includes(config.targetId));
  await page.getByRole('button', { name: 'Add resolved member', exact: true }).click();
  const remove = page.getByRole('button', { name: `Remove member ${config.targetLogin}`, exact: true });
  await remove.waitFor();
  stage = 'reload and mobile'; await page.reload(); await remove.waitFor();
  await page.setViewportSize({ width: 320, height: 760 });
  check(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  stage = 'cancel removal'; await remove.click(); await page.getByRole('dialog').waitFor();
  await page.keyboard.press('Escape'); check(await page.getByRole('dialog').count() === 0);
  stage = 'confirmed removal'; await remove.click();
  await page.getByRole('button', { name: 'Confirm remove member', exact: true }).click();
  await page.getByRole('status').filter({ hasText: 'Team member removed.' }).waitFor();
  await page.getByRole('table', { name: 'Team members', exact: true }).waitFor();
  check(await remove.count() === 0); check(errors.length === 0);
  console.log('PASS: actual served team settings, explicit resolve/grant review/add/reload, cancelled draft/removal, confirmed removal and mobile bounds');
} catch {
  console.error('Organization browser failed at '+stage+'; sensitive diagnostics withheld'); process.exitCode = 1;
} finally {
  if (context && config) try {
    const response = await context.request.post(config.golf+'/rpc/golf.v1.SessionService/Logout',
      { headers: { Origin: config.golf, 'Connect-Protocol-Version':'1', 'Content-Type':'application/json' }, data:{} });
    check(response.status() === 200);
  } catch { console.error('Browser logout failed'); process.exitCode = 1; }
  await browser?.close();
}
