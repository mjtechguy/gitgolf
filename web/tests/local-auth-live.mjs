// Native password UI qualification. Only a separately provisioned disposable core.
// node web/tests/local-auth-live.mjs --target PRIVATE_TARGET_JSON
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium } from '@playwright/test';

const targetIndex = process.argv.indexOf('--target');
if (targetIndex < 0 || !process.argv[targetIndex + 1]) throw new Error('A disposable target file is required.');
const target = JSON.parse(await readFile(process.argv[targetIndex + 1], 'utf8'));
const golf = new URL(target.golf);
if (!target.project?.startsWith('golf-api-proof-') || !target.container?.startsWith(`${target.project}-gitea-`) || !target.golfContainer?.startsWith(`${target.project}-golf-`) || golf.hostname !== '127.0.0.1' || ['8080', '3001'].includes(golf.port)) throw new Error('Only an isolated qualification target is allowed.');
const artifacts = resolve('.tmp/local-auth-browser');
await mkdir(artifacts, { recursive: true, mode: 0o700 });
const username = `golf-ui-${randomBytes(5).toString('hex')}`;
const password = `Golf-${randomBytes(24).toString('base64url')}`;
let created = false, enrolled = false, browser, context, phase = 'fixture enrollment', failed = false;
function require(condition) { if (!condition) throw new Error('Qualification assertion failed.'); }
function admin(...args) { return execFileSync('docker', ['exec', '--user', '1000:1000', target.container, 'gitea', 'admin', 'user', ...args], { encoding: 'utf8', timeout: 30_000, stdio: ['ignore', 'pipe', 'pipe'] }).trim(); }
function account(action, data) { return execFileSync('docker', ['exec', '-i', target.golfContainer, '/usr/local/bin/golf', 'local-account', action], { input: JSON.stringify(data), encoding: 'utf8', timeout: 30_000, stdio: ['pipe', 'pipe', 'pipe'] }); }
function stage(value) { phase = value; console.log(`Checking: ${value}`); }
try {
  admin('create', '--username', username, '--email', `${username}@example.invalid`, '--random-password', '--random-password-length', '32', '--must-change-password=false'); created = true;
  const pat = admin('generate-access-token', '--username', username, '--token-name', username, '--scopes', 'read:user,read:repository', '--raw');
  require(pat.length > 20);
  account('create', { username, email: `${username}@example.invalid`, password, forge_token: pat, is_instance_admin: true }); enrolled = true;
  browser = await chromium.launch({ headless: true });
  context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, colorScheme: 'dark' });
  const page = await context.newPage(); page.setDefaultTimeout(15_000);
  const errors = []; page.on('pageerror', () => errors.push('browser error'));
  const noStoredSecrets = async () => {
    const stored = await page.evaluate(() => JSON.stringify({ ...localStorage, ...sessionStorage }));
    require(!stored.includes(password) && !stored.includes(pat));
    require(!(await page.evaluate(() => document.cookie)).includes('golf_session'));
  };
  stage('default local sign-in, collapsed token fallback and dark/light/mobile');
  await page.goto(golf.origin);
  await page.getByLabel('Email or username', { exact: true }).waitFor();
  await page.waitForFunction(() => document.querySelector('#golf-username')?.disabled === false);
  require(await page.getByLabel('Email or username', { exact: true }).isEnabled());
  require(!await page.getByLabel('Provider access token', { exact: true }).isVisible());
  require(await page.getByLabel('Email or username', { exact: true }).getAttribute('autocomplete') === 'username');
  require(await page.getByLabel('Password', { exact: true }).getAttribute('autocomplete') === 'current-password');
  if (await page.locator('html').getAttribute('data-theme') !== 'dark') await page.getByRole('button', { name: 'Switch to dark theme', exact: true }).click();
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: `${artifacts}/native-login-dark.png`, fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  if (await page.locator('html').getAttribute('data-theme') !== 'light') await page.getByRole('button', { name: 'Switch to light theme', exact: true }).click();
  require(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await page.screenshot({ path: `${artifacts}/native-login-mobile-light.png`, fullPage: true });
  await page.setViewportSize({ width: 1440, height: 1000 });
  stage('wrong Golf password stays generic and clears immediately');
  await page.getByLabel('Email or username', { exact: true }).fill(`${username.toUpperCase()}@EXAMPLE.INVALID`);
  await page.getByLabel('Password', { exact: true }).fill(`${password}-wrong`);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.getByRole('alert').waitFor();
  require(await page.getByRole('alert').textContent() === 'Sign-in could not be completed. Check your Golf email or username and password and try again.');
  require(await page.getByLabel('Password', { exact: true }).inputValue() === '');
  await noStoredSecrets();
  stage('real local password creates HttpOnly session and verified role');
  await page.getByLabel('Password', { exact: true }).fill(password);
  const response = page.waitForResponse((response) => response.url().endsWith('/golf.v1.SessionService/LoginWithPassword'));
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  require((await response).status() === 200);
  await page.getByRole('heading', { name: 'Repositories', exact: true, level: 2 }).waitFor();
  await page.getByLabel('Your account', { exact: true }).click();
  await page.getByText('Instance administrator', { exact: true }).waitFor();
  await page.getByLabel('Your account', { exact: true }).click();
  const cookie = (await context.cookies()).find((cookie) => cookie.name === 'golf_session');
  require(cookie?.httpOnly && cookie.sameSite === 'Lax' && cookie.path === '/');
  await noStoredSecrets();
  await page.reload();
  await page.getByLabel('Your account', { exact: true }).click();
  await page.getByText('Instance administrator', { exact: true }).waitFor();
  await page.getByLabel('Your account', { exact: true }).click();
  if (await page.locator('html').getAttribute('data-theme') !== 'dark') await page.getByRole('button', { name: 'Switch to dark theme', exact: true }).click();
  await page.screenshot({ path: `${artifacts}/native-workspace-dark.png`, fullPage: true });
  await page.getByLabel('Your account', { exact: true }).click();
  await page.getByRole('link', { name: 'User settings', exact: true }).click();
  await page.getByRole('navigation', {name:'Account settings',exact:true}).getByRole('link', { name: 'Sessions', exact: true }).click();
  await page.getByRole('cell', { name: 'Golf password', exact: true }).waitFor();
  await page.keyboard.press('Escape');
  await page.getByRole('navigation', {name:'Account settings',exact:true}).getByRole('link', { name: 'Account activity', exact: true }).click();
  await page.getByText('Golf password', { exact: true }).first().waitFor();
  stage('sign-out clears credential fields and private account state');
  await page.getByLabel('Your account', { exact: true }).click(); await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await page.getByRole('heading', { name: 'Welcome to Golf', exact: true }).waitFor();
  require(await page.getByLabel('Password', { exact: true }).inputValue() === '');
  require(await page.getByLabel('Email or username', { exact: true }).inputValue() === '');
  require(await page.getByText('Instance administrator', { exact: true }).count() === 0);
  await noStoredSecrets();
  stage('explicit current local session revocation acknowledges success and clears the cookie');
  await page.getByLabel('Email or username', { exact: true }).fill(`${username.toUpperCase()}@EXAMPLE.INVALID`);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.getByLabel('Your account', { exact: true }).click();
  await page.getByRole('link', { name: 'User settings', exact: true }).click();
  await page.getByRole('navigation', {name:'Account settings',exact:true}).getByRole('link', { name: 'Sessions', exact: true }).click();
  await page.getByRole('button', { name: 'Revoke current session', exact: true }).click();
  const revocation = page.waitForResponse((response) => response.url().endsWith('/golf.v1.SessionService/RevokeSession'));
  await page.getByRole('button', { name: 'Confirm revoke session', exact: true }).click();
  const revoked = await revocation;
  require(revoked.status() === 200 && (await revoked.json()).currentSessionRevoked === true);
  await page.getByRole('heading', { name: 'Welcome to Golf', exact: true }).waitFor();
  require(!(await context.cookies()).some((cookie) => cookie.name === 'golf_session'));
  await noStoredSecrets(); require(errors.length === 0);
  console.log('PASS: native Golf password UI, safe failure, cookie, role, session/activity labels, reload, themes/mobile, sign-out and current-session revocation.');
} catch {
  failed = true; console.error(`FAIL: ${phase}; private diagnostic details withheld.`);
} finally {
  if (context) await context.close().catch(() => { failed = true; });
  if (browser) await browser.close().catch(() => { failed = true; });
  if (enrolled) { try { account('disable', { username }); } catch { failed = true; console.error('FAIL: local fixture account cleanup.'); } }
  if (created) { try { admin('delete', '--username', username, '--purge'); } catch { failed = true; console.error('FAIL: native fixture user cleanup.'); } }
}
if (failed) process.exitCode = 1;
