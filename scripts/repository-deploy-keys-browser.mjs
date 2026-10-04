// Prepared actual deploy-key settings proof. Fixture credentials arrive only on
// stdin; never log RPC/native bodies, keys, credentials or browser error text.
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { writeFile, chmod } from 'node:fs/promises';
let browser, context, config, stage = 'initialization';
const captures = [], errors = [], requests = [], replies = [];
function check(value) { if (!value) throw new Error('assertion'); }
function equivalent(target, body, reply = false) {
  check(body.repositoryId === target.repositoryId && body.ownerId === target.ownerId);
  check((reply ? body.accessRevision : body.expectedRevision) === target.expectedRevision);
}
try {
  let input = ''; for await (const chunk of process.stdin) input += chunk;
  config = JSON.parse(input); input = '';
  const { chromium } = await import(pathToFileURL(join(config.stackRoot, 'web/node_modules/playwright/index.mjs')));
  browser = await chromium.launch(); context = await browser.newContext();
  const page = await context.newPage();
  page.on('pageerror', () => errors.push(true));
  page.on('request', request => {
    const method = new URL(request.url()).pathname.split('/').at(-1);
    if (!['ListRepositoryDeployKeys','AddRepositoryDeployKey','DeleteRepositoryDeployKey'].includes(method)) return;
    let body; try { body = request.postDataJSON(); equivalent(config.target, body); } catch { errors.push(true); return; }
    requests.push({ method, keyId: body.keyId, expectedKeyRevision: body.expectedKeyRevision, title: body.title, readOnly: body.readOnly });
  });
  const pending = [];
  page.on('response', response => {
    const method = new URL(response.url()).pathname.split('/').at(-1);
    if (!['ListRepositoryDeployKeys','AddRepositoryDeployKey','DeleteRepositoryDeployKey'].includes(method)) return;
    pending.push((async () => { check(response.status() === 200); const body = await response.json(); equivalent(config.target, body, true); replies.push({ method, body }); })().catch(() => errors.push(true)));
  });
  const headers = { Authorization: 'token '+config.ownerToken };
  const nativeBase = config.gitea+'/api/v1/repos/'+config.repository+'/keys/';
  async function nativeKey(id, expected) {
    const response = await context.request.get(nativeBase+id, { headers });
    check(response.status() === expected);
    return expected === 200 ? response.json() : undefined;
  }
  async function capture(theme, width, mode, state) {
    check(await page.locator('html').getAttribute('data-theme') === theme);
    check(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    check(await page.getByRole('form', { name: 'Add repository deploy key', exact: true }).count() === 0);
    const text = await page.locator('body').innerText();
    check(config.publicKeys.every(publicKey => !text.includes(publicKey.trim().split(/\s+/).slice(0,2).join(' '))));
    check(!text.includes(config.password) && !text.includes(config.ownerToken));
    const file = 'deploy-keys-'+theme+'-'+width+'-'+mode+'-'+state;
    await page.screenshot({ path: join(config.screenshots, file+'.png'), fullPage: true });
    await chmod(join(config.screenshots, file+'.png'), 0o600);
    await writeFile(join(config.screenshots, file+'.txt'), text, { mode: 0o600 });
    captures.push({ id: file, page: 'Repository settings · access · deploy keys', role: 'personal-owner', state, accessMode: mode, theme, viewport: { width, height: 900 }, image: file+'.png', text: file+'.txt', result: 'captured', caption: 'Actual disposable native deploy-key association; product image/runtime recorded below. No agent inference or retained-account changes.' });
  }
  stage = 'managed password sign-in'; await page.goto(config.golf);
  await page.getByLabel('Email or username', { exact: true }).fill(config.email);
  await page.getByLabel('Password', { exact: true }).fill(config.password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.getByRole('form', { name: 'Golf account sign-in', exact: true }).waitFor({ state: 'detached' });
  stage = 'canonical repository access settings';
  await page.goto(config.golf+'/'+config.repository+'/settings/access');
  const section = page.getByRole('region', { name: 'Deploy keys', exact: true });
  await section.getByRole('heading', { name: 'Deploy keys', exact: true }).waitFor();
  check(new URL(page.url()).pathname === '/'+config.repository+'/settings/access');
  check(await section.getByRole('form', { name: 'Add repository deploy key', exact: true }).count() === 0);
  let index = 0;
  for (const theme of ['dark','light']) for (const width of [1440,390]) for (const write of [false,true]) {
    const mode = write ? 'read-write' : 'read-only', title = 'Browser '+mode+' '+index;
    const publicKey = config.publicKeys[index++].trim();
    stage = 'actual Add/list/reload '+theme+' '+width+' '+mode;
    await page.setViewportSize({ width, height: 900 });
    const toggle = page.getByRole('button', { name: 'Switch to '+theme+' theme', exact: true });
    if (await toggle.count()) await toggle.click();
    await section.getByRole('button', { name: 'Add deploy key', exact: true }).click();
    const form = section.getByRole('form', { name: 'Add repository deploy key', exact: true });
    await form.getByLabel('Title', { exact: true }).fill(title);
    await form.getByLabel('Public SSH key', { exact: true }).fill(publicKey);
    const writeAccess = form.getByLabel('Allow write access', { exact: true });
    check(!(await writeAccess.isChecked()));
    if (write) await writeAccess.check();
    const before = requests.filter(row => row.method === 'AddRepositoryDeployKey').length;
    await form.getByRole('button', { name: 'Add deploy key', exact: true }).click();
    await section.getByRole('status').filter({ hasText: 'Deploy key added.' }).waitFor();
    await form.waitFor({ state: 'detached' });
    await section.getByRole('button', { name: 'Remove deploy key '+title, exact: true }).waitFor();
    await Promise.all(pending);
    check(requests.filter(row => row.method === 'AddRepositoryDeployKey').length === before+1);
    check(requests.filter(row => row.method === 'AddRepositoryDeployKey').at(-1).readOnly === !write);
    const add = replies.filter(row => row.method === 'AddRepositoryDeployKey').at(-1).body.key;
    check(add.title === title && (add.readOnly ?? false) === !write && /^[1-9][0-9]*$/.test(add.id) && /^[1-9][0-9]*$/.test(add.publicKeyId) && /^[a-f0-9]{64}$/.test(add.revision));
    check(add.publicKey === publicKey.split(/\s+/).slice(0,2).join(' '));
    const native = await nativeKey(add.id, 200);
    check(String(native.id) === add.id && String(native.key_id) === add.publicKeyId && native.read_only === !write && native.title === title);
    check(native.key.trim().split(/\s+/).slice(0,2).join(' ') === add.publicKey);
    await page.reload();
    const remove = section.getByRole('button', { name: 'Remove deploy key '+title, exact: true });
    await remove.waitFor();
    const row = section.getByRole('table', { name: 'Repository deploy keys', exact: true }).locator('tbody tr').filter({ has: remove });
    check((await row.innerText()).includes(write ? 'Read/write' : 'Read-only'));
    await capture(theme, width, mode, 'added-and-reloaded');
    stage = 'cancel then confirm exact association removal '+theme+' '+width+' '+mode;
    const deleteBefore = requests.filter(row => row.method === 'DeleteRepositoryDeployKey').length;
    await remove.click();
    const dialog = page.getByRole('dialog', { name: 'Remove this deploy key?', exact: true });
    await dialog.waitFor();
    check(await dialog.getByRole('button', { name: 'Cancel', exact: true }).evaluate(element => element === document.activeElement));
    await page.keyboard.press('Escape'); await dialog.waitFor({ state: 'detached' });
    check(requests.filter(row => row.method === 'DeleteRepositoryDeployKey').length === deleteBefore);
    await remove.click(); await dialog.getByRole('button', { name: 'Confirm remove deploy key', exact: true }).click();
    await section.getByRole('status').filter({ hasText: 'Deploy key removed.' }).waitFor();
    await remove.waitFor({ state: 'detached' }); await Promise.all(pending);
    check(requests.filter(row => row.method === 'DeleteRepositoryDeployKey').length === deleteBefore+1);
    const deletion = requests.filter(row => row.method === 'DeleteRepositoryDeployKey').at(-1);
    check(deletion.keyId === add.id && deletion.expectedKeyRevision === add.revision);
    const reply = replies.filter(row => row.method === 'DeleteRepositoryDeployKey').at(-1).body;
    check(reply.keyId === add.id);
    await nativeKey(add.id, 404);
    await page.reload(); await section.getByText('No deploy keys in the loaded inventory.', { exact: true }).waitFor();
    check(await section.getByRole('button', { name: 'Remove deploy key '+title, exact: true }).count() === 0);
    await capture(theme, width, mode, 'removed-and-reloaded');
  }
  await Promise.all(pending); check(errors.length === 0);
  check(captures.length === 16 && requests.filter(row => row.method === 'AddRepositoryDeployKey').length === 8 && requests.filter(row => row.method === 'DeleteRepositoryDeployKey').length === 8);
  await writeFile(join(config.screenshots, 'manifest.json'), JSON.stringify({ status: 'browser_checks_passed_parent_native_cleanup_pending', runtime: config.runtime, captureKind: 'Actual served disposable repository deploy-key Add/list/reload/Delete and independent native association readback', captures }, null, 2), { mode: 0o600 });
  console.log('PASS: actual deploy-key settings Add/list/reload/Delete, explicit modes, exact associations/native readback and16 dark/light1440/390 captures');
} catch (error) {
  console.error('Deploy-key browser failed at '+stage+'; '+(error.name === 'TimeoutError' ? 'TimeoutError' : 'assertion/error')+'; private diagnostics withheld'); process.exitCode = 1;
  if (config?.screenshots) await writeFile(join(config.screenshots, 'manifest.json'), JSON.stringify({ status: 'failed', runtime: config.runtime, captureKind: 'Partial actual served deploy-key browser evidence; not qualified', failedStage: stage, captures }, null, 2), { mode: 0o600 });
} finally {
  if (context && config) try {
    const response = await context.request.post(config.golf+'/rpc/golf.v1.SessionService/Logout', { headers: { Origin: config.golf, 'Connect-Protocol-Version': '1', 'Content-Type': 'application/json' }, data: {} });
    check(response.status() === 200);
  } catch { console.error('Deploy-key browser logout failed'); process.exitCode = 1; }
  await browser?.close();
}
