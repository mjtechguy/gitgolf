// Explicit opt-in native UI qualification against an already isolated Golf/Gitea
// stack. No normal localhost services, persistent browser profile or secret file.
// node web/tests/api-credentials-live.mjs --target PRIVATE_TARGET_JSON
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium, request } from '@playwright/test';

const targetIndex = process.argv.indexOf('--target');
if (targetIndex < 0 || !process.argv[targetIndex + 1]) throw new Error('A disposable target file is required.');
const target = JSON.parse(await readFile(process.argv[targetIndex + 1], 'utf8'));
const golf = new URL(target.golf);
if (!target.project?.startsWith('golf-api-proof-') || !target.container?.startsWith(`${target.project}-gitea-`) || golf.hostname !== '127.0.0.1' || golf.port === '8080') throw new Error('Only the named isolated qualification target is allowed.');
const artifacts = resolve('.tmp/api-credentials-browser');
await mkdir(artifacts, { recursive: true, mode: 0o700 });
const username = `golf-ui-${randomBytes(5).toString('hex')}`;
let created = false;
let browser;
let context;
let machine;
let phase = 'fixture creation';
let failed = false;
function require(condition) { if (!condition) throw new Error('Qualification assertion failed.'); }
function admin(...args) {
  return execFileSync('docker', ['exec', '--user', '1000:1000', target.container, 'gitea', 'admin', 'user', ...args], { encoding: 'utf8', timeout: 30_000, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}
function stage(value) { phase = value; console.log(`Checking: ${value}`); }
async function rpc(client, service, method, data = {}, expected = 200, bearer) {
  const headers = { 'Content-Type': 'application/json', 'Connect-Protocol-Version': '1', Origin: golf.origin };
  if (bearer) headers.Authorization = `Bearer ${bearer}`;
  const response = await client.post(`${golf.origin}/rpc/golf.v1.${service}/${method}`, { data, headers, timeout: 10_000 });
  require(response.status() === expected);
  return response.json();
}
try {
  admin('create', '--username', username, '--email', `${username}@example.invalid`, '--random-password', '--random-password-length', '32', '--must-change-password=false');
  created = true;
  const pat = admin('generate-access-token', '--username', username, '--token-name', username, '--scopes', 'read:user,read:repository', '--raw');
  require(pat.length > 20);
  browser = await chromium.launch({ headless: true });
  context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, colorScheme: 'dark', permissions: ['clipboard-read', 'clipboard-write'] });
  machine = await request.newContext();
  const page = await context.newPage();
  page.setDefaultTimeout(10_000);
  const errors = [];
  page.on('pageerror', () => errors.push('browser error'));
  stage('real token sign-in and account navigation');
  await page.goto(`${golf.origin}/account/api-credentials`);
  await page.getByText('Advanced token sign-in', { exact: true }).click();
  await page.getByLabel('Provider access token', { exact: true }).fill(pat);
  await page.getByRole('button', { name: 'Continue to workspace', exact: true }).click();
  await page.getByRole('heading', { name: 'No API credentials', exact: true }).waitFor();
  async function issue(label) {
    await page.getByLabel('Credential label', { exact: true }).fill(label);
    const response = page.waitForResponse((response) => response.url().endsWith('/golf.v1.ApiCredentialService/CreateApiCredential'));
    await page.getByRole('button', { name: 'Create API credential', exact: true }).click();
    const result = await response;
    require(result.status() === 200);
    const value = await result.json();
    await page.getByRole('heading', { name: 'Save this credential now', exact: true }).waitFor();
    require(await page.getByLabel('New API credential', { exact: true }).inputValue() === value.token);
    require(/^golf_ro_[A-Za-z0-9_-]{43}$/.test(value.token));
    return value;
  }
  async function revoke(id) {
    await page.getByRole('button', { name: `Revoke credential ${id}`, exact: true }).click();
    require(await page.getByRole('button', { name: 'Cancel', exact: true }).evaluate((element) => element === document.activeElement));
    await page.getByRole('button', { name: 'Confirm revoke credential', exact: true }).click();
    await page.getByText('API credential revoked.', { exact: true }).waitFor();
  }
  stage('real issuance, clipboard, source expiry and read-only bearer boundary');
  await page.getByLabel('Requested lifetime').selectOption('43200');
  const first = await issue('Browser read tool');
  const list = await rpc(context.request, 'ApiCredentialService', 'ListApiCredentials');
  require(Date.parse(first.credential.expiresAt) <= Date.parse(list.currentSourceExpiresAt));
  require(!JSON.stringify(list).includes(first.token));
  await rpc(machine, 'RepositoryService', 'ListRepositories', {}, 200, first.token);
  await rpc(machine, 'RepositoryService', 'CreateRepository', { name: 'must-not-create', private: true }, 403, first.token);
  await rpc(machine, 'ApiCredentialService', 'ListApiCredentials', {}, 403, first.token);
  await page.getByRole('button', { name: 'Copy credential', exact: true }).click();
  require(await page.evaluate(() => navigator.clipboard.readText()) === first.token);
  require(!await page.evaluate((secret) => JSON.stringify({ ...localStorage, ...sessionStorage }).includes(secret), first.token));
  require(!page.url().includes(first.token));
  await page.getByRole('button', { name: 'Dismiss credential', exact: true }).click();
  await page.getByLabel('New API credential', { exact: true }).waitFor({ state: 'detached' });
  await page.evaluate(() => navigator.clipboard.writeText(''));
  await page.reload();
  await page.getByRole('heading', { name: 'Browser read tool', exact: true }).waitFor();
  require(await page.getByLabel('New API credential', { exact: true }).count() === 0);
  stage('native revocation and immediate bearer denial');
  await revoke(first.credential.id);
  await rpc(machine, 'RepositoryService', 'ListRepositories', {}, 401, first.token);

  stage('lost browser acknowledgment after real issuance, inspection and revocation');
  let lost;
  let issueCalls = 0;
  await page.route('**/golf.v1.ApiCredentialService/CreateApiCredential', async (route) => {
    issueCalls++;
    const response = await route.fetch();
    require(response.status() === 200);
    lost = await response.json();
    await route.abort('failed');
  });
  await page.getByLabel('Credential label', { exact: true }).fill('Lost acknowledgment');
  await page.getByRole('button', { name: 'Create API credential', exact: true }).click();
  await page.getByRole('heading', { name: 'Issuance outcome is unknown', exact: true }).waitFor();
  require(issueCalls === 1 && lost?.credential?.id);
  await page.unroute('**/golf.v1.ApiCredentialService/CreateApiCredential');
  await page.getByRole('button', { name: 'Refresh credential list', exact: true }).click();
  await page.getByRole('heading', { name: 'Lost acknowledgment', exact: true }).waitFor();
  require(await page.getByLabel('New API credential', { exact: true }).count() === 0);
  await rpc(machine, 'RepositoryService', 'ListRepositories', {}, 200, lost.token);
  await revoke(lost.credential.id);
  await rpc(machine, 'RepositoryService', 'ListRepositories', {}, 401, lost.token);
  await page.getByRole('button', { name: 'I reviewed the list; start a separate credential', exact: true }).click();

  stage('real metadata pagination, literal labels, dark desktop and light mobile');
  for (let i = 0; i < 19; i++) await rpc(context.request, 'ApiCredentialService', 'CreateApiCredential', { label: i === 0 ? '<img src=x onerror=alert(1)>' : `Disposable read ${i}`, lifetimeSeconds: 900 });
  await page.getByRole('button', { name: 'Refresh credentials', exact: true }).click();
  await page.getByRole('button', { name: 'Load more credentials', exact: true }).click();
  await page.getByRole('heading', { name: 'Browser read tool', exact: true }).waitFor();
  require(await page.locator('.credential-row').count() === 21);
  require(await page.locator('.credential-row img').count() === 0);
  await page.getByRole('heading', { name: '<img src=x onerror=alert(1)>', exact: true }).waitFor();
  if (await page.locator('html').getAttribute('data-theme') !== 'dark') await page.getByRole('button', { name: 'Switch to dark theme', exact: true }).click();
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: `${artifacts}/native-dark.png`, fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  if (await page.locator('html').getAttribute('data-theme') !== 'light') await page.getByRole('button', { name: 'Switch to light theme', exact: true }).click();
  require(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: `${artifacts}/native-mobile-light.png`, fullPage: true });

  stage('actual source-session revocation removes displayed secret and account data');
  const last = await issue('Source-bound read tool');
  await rpc(machine, 'RepositoryService', 'ListRepositories', {}, 200, last.token);
  const sessions = await rpc(context.request, 'SessionService', 'ListSessions');
  const current = sessions.sessions.find((session) => session.current);
  require(current?.id);
  await rpc(context.request, 'SessionService', 'RevokeSession', { sessionId: current.id });
  await page.getByRole('button', { name: 'Refresh credentials', exact: true }).click();
  await page.getByRole('heading', { name: 'Welcome to Golf', exact: true }).waitFor();
  require(await page.getByLabel('New API credential', { exact: true }).count() === 0);
  require(await page.locator('.credential-row').count() === 0);
  await rpc(machine, 'RepositoryService', 'ListRepositories', {}, 401, last.token);
  require(!await page.evaluate((secret) => JSON.stringify({ ...localStorage, ...sessionStorage }).includes(secret), last.token));
  require(errors.length === 0);
  console.log('PASS: real API credential browser lifecycle, read-only bearer boundary, lost acknowledgment, pagination and source-session revocation');
} catch (error) {
  failed = true;
  const line = error?.stack?.match(/api-credentials-live\.mjs:(\d+):\d+/)?.[1];
  console.error(`FAIL: ${phase}${line ? ` (owned script line ${line})` : ''}; diagnostic details withheld to protect credentials`);
} finally {
  let cleanupFailed = false;
  if (context) {
    try { await rpc(context.request, 'SessionService', 'RevokeOtherSessions'); } catch { /* Source may already be revoked. */ }
    try { await rpc(context.request, 'SessionService', 'Logout'); } catch { cleanupFailed = true; }
    try { await context.close(); } catch { cleanupFailed = true; }
  }
  if (machine) await machine.dispose();
  if (browser) await browser.close();
  if (created) try { admin('delete', '--username', username, '--purge'); } catch { cleanupFailed = true; }
  if (cleanupFailed) { failed = true; console.error('FAIL: disposable browser fixture cleanup'); }
  else console.log('PASS: browser, provider user, token and active source session cleaned; isolated target retained for its owner');
}
process.exitCode = failed ? 1 : 0;
