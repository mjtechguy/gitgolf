// Disposable native fixture supplied on stdin; never print credentials/keys.
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
let browser, context, config, stage = 'initialization';
function check(value) { if (!value) throw new Error('assertion'); }
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
  await page.getByRole('link', { name: 'Organizations', exact: true }).waitFor();
  stage = 'account navigation'; await page.getByLabel('Your account', { exact: true }).click();
  await page.getByRole('link', { name: 'User settings', exact: true }).click();
  await page.getByRole('link', { name: 'SSH keys', exact: true }).click();
  await page.getByRole('heading', { name: 'SSH keys', exact: true }).waitFor();
  check(new URL(page.url()).pathname === '/account/ssh-keys');
  check(await page.getByRole('dialog').count() === 0);
  check(await page.getByLabel('Key title', { exact: true }).count() === 0);
  await page.getByRole('button', { name: 'New SSH key', exact: true }).click();
  stage = 'reject private key'; await page.getByLabel('Key title', { exact: true }).fill('Browser key');
  await page.getByLabel('Public key', { exact: true }).fill('-----BEGIN OPENSSH PRIVATE KEY-----');
  await page.getByRole('button', { name: 'Add SSH key', exact: true }).click();
  await page.getByRole('alert').filter({ hasText: 'Paste one OpenSSH public key' }).waitFor();
  stage = 'add real key'; await page.getByLabel('Public key', { exact: true }).fill(config.publicKey);
  await page.getByRole('button', { name: 'Add SSH key', exact: true }).click();
  await page.getByRole('cell', { name: 'Browser key Account Git access', exact: true }).waitFor();
  stage = 'persist and mobile'; await page.reload();
  await page.getByRole('button', { name: 'Remove Browser key', exact: true }).waitFor();
  await page.setViewportSize({ width: 320, height: 760 });
  check(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await page.screenshot({ path:'/tmp/golf-ssh-keys-mobile.png', fullPage:true });
  stage = 'cancel removal'; await page.getByRole('button', { name: 'Remove Browser key', exact: true }).click();
  await page.getByRole('dialog').waitFor(); await page.keyboard.press('Escape');
  check(await page.getByRole('dialog').count() === 0);
  stage = 'remove real key'; await page.getByRole('button', { name: 'Remove Browser key', exact: true }).click();
  await page.getByRole('button', { name: 'Confirm remove key', exact: true }).click();
  await page.getByRole('status').filter({ hasText: 'SSH key removed.' }).waitFor();
  check(await page.getByRole('cell', { name: 'Browser key Account Git access', exact: true }).count() === 0);
  check(errors.length === 0);
  console.log('PASS: actual Golf SSH settings navigation, validation, add/reload, mobile and confirmed removal');
} catch {
  console.error('SSH browser failed at '+stage+'; sensitive diagnostics withheld'); process.exitCode = 1;
} finally {
  if (context && config) try {
    const response = await context.request.post(config.golf+'/rpc/golf.v1.SessionService/Logout',
      { headers: { Origin: config.golf, 'Connect-Protocol-Version':'1','Content-Type':'application/json' }, data:{} });
    check(response.status() === 200);
  } catch { console.error('Browser logout failed'); process.exitCode = 1; }
  await browser?.close();
}
