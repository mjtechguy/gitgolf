// Prepared disposable served archive UI proof. Credentials only arrive on stdin.
// No RPC bodies, password, provider token or private source enters diagnostics.
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { writeFile, chmod } from 'node:fs/promises';
let config, baseConfig, browser, context, page, stage = 'initialization';
const captures = [], requests = [], replies = [], pending = [], errors = [];
const counts = {}, statuses = {};
let lostAcknowledgementStatus, lostAcknowledgementFailure;
const methods = ['GetRepositoryLifecycle', 'ChangeRepositoryArchiveState', 'GetRepositoryLifecycleOperation'];
function check(value) { if (!value) throw new Error('assertion'); }
function identity(value) { check(value.repository?.owner+'/'+value.repository?.name === config.repository && value.repositoryId === config.repositoryId && value.ownerId === config.ownerId && /^[a-f0-9]{64}$/.test(value.revision)); }
function receipt(value, intent) {
  for (const field of ['repositoryId', 'ownerId', 'expectedRevision', 'idempotencyKey']) check(value[field] === intent[field]);
  check(value.repository?.owner+'/'+value.repository?.name === config.repository && value.actorId === config.actorId && value.phase === 'SUCCEEDED');
  check((value.fromArchived || false) === !intent.archived && (value.toArchived || false) === intent.archived && !value.failureCode);
  check(Number.isFinite(Date.parse(value.createdAt)) && Number.isFinite(Date.parse(value.updatedAt)));
}
async function native(archived) {
  const response = await context.request.get(config.forge+'/api/v1/repos/'+config.repository, { headers: { Authorization: 'token '+config.ownerToken } });
  check(response.status() === 200); const row = await response.json();
  check(String(row.id) === config.repositoryId && String(row.owner.id) === config.ownerId && row.archived === archived && row.has_actions === false);
  return row;
}
async function capture(theme, width, state) {
  check(await page.locator('html').getAttribute('data-theme') === theme);
  check(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await page.evaluate(() => document.fonts.ready);
  const text = await page.locator('body').innerText(); check(!text.includes(config.password) && !text.includes(config.ownerToken));
  const id = 'lifecycle-'+theme+'-'+width+'-'+state;
  await page.screenshot({ path: join(config.screenshots, id+'.png'), fullPage: true }); await chmod(join(config.screenshots, id+'.png'), 0o600);
  await writeFile(join(config.screenshots, id+'.txt'), text, { mode: 0o600 });
  captures.push({ id, page: 'Repository settings · Archive lifecycle', role: 'ordinary-native-owner', repositoryId: config.repositoryId, repository: config.repository, state, theme, viewport: { width, height: 900 }, image: id+'.png', text: id+'.txt', result: 'captured', caption: 'Actual disposable repository current values, requested confirmation and verified archive receipt. Independent native readback, separate unarchive intent and status-only reload are checked. Transfer/deletion, external ingress and native lost-acknowledgement repair remain unqualified.' });
}
try {
  let input = ''; for await (const chunk of process.stdin) { input += chunk; check(input.length <= 65536); }
  baseConfig = JSON.parse(input); input = '';
  for (const theme of ['dark','light']) { const row=baseConfig.fixtures[theme]; check(row.repository.split('/').length===2 && /^[1-9][0-9]*$/.test(row.repositoryId) && /^[1-9][0-9]*$/.test(row.ownerId) && /^[1-9][0-9]*$/.test(row.actorId)); }
  config={...baseConfig,...baseConfig.fixtures.dark};
  const { chromium } = await import(pathToFileURL(join(config.stackRoot, 'web/node_modules/playwright/index.mjs')));
  browser = await chromium.launch();
  function attach(page) {
  page.on('pageerror', () => errors.push(true));
  page.on('request', request => {
    const method = new URL(request.url()).pathname.split('/').at(-1); if (!methods.includes(method)) return;
    counts[method] = (counts[method] || 0)+1;
    try {
      const body = request.postDataJSON(); check(body.repository.owner+'/'+body.repository.name === config.repository && body.repositoryId === config.repositoryId);
      if (method !== 'GetRepositoryLifecycle') check(body.ownerId === config.ownerId && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(body.idempotencyKey));
      if (method === 'ChangeRepositoryArchiveState') check(/^[a-f0-9]{64}$/.test(body.expectedRevision) && typeof body.archived === 'boolean' && body.confirmationName === config.repository && body.currentPassword === config.password);
      check(requests.length<256); requests.push({ method, body });
    } catch { errors.push(true); }
  });
  page.on('response', response => {
    const method = new URL(response.url()).pathname.split('/').at(-1); if (!methods.includes(method)) return;
    const key = method+':'+response.status(); statuses[key] = (statuses[key] || 0)+1;
    pending.push((async () => {
      check(response.status() === 200 && response.headers()['cache-control'] === 'no-store'); const body = await response.json();
      if (method === 'GetRepositoryLifecycle') { identity(body.lifecycle); check(body.lifecycle.canManage && body.lifecycle.stepUpAvailable && body.lifecycle.activeWorkCount === '0'); }
      else {
        const matching = requests.filter(row => row.method === 'ChangeRepositoryArchiveState' && row.body.idempotencyKey === body.operation?.idempotencyKey).at(-1);
        // Status-only reloads retain original metadata; request body is never re-sent.
        const intent = matching?.body || intents.get(body.operation?.idempotencyKey); check(intent); receipt(body.operation, intent);
        if (body.lifecycle) { identity(body.lifecycle); check((body.lifecycle.archived || false) === intent.archived); }
      }
      check(replies.length<256); replies.push({ method, body });
    })().catch(() => errors.push(true)));
  });
  }
  const intents = new Map();
  async function signIn() {
  stage = 'managed ordinary-owner password sign-in'; await page.goto(config.golf);
  await page.getByLabel('Email or username', { exact: true }).fill(config.email); await page.getByLabel('Password', { exact: true }).fill(config.password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click(); await page.getByRole('form', { name: 'Golf account sign-in', exact: true }).waitFor({ state: 'detached' });
  }
  let panel;
  async function waitAction(archived) { await panel.getByRole('button', { name: archived ? 'Unarchive repository' : 'Archive repository', exact: true }).waitFor(); await Promise.all(pending); check(errors.length === 0); }
  async function open(archived) {
    await waitAction(archived); await panel.getByRole('button', { name: archived ? 'Unarchive repository' : 'Archive repository', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: archived ? 'Unarchive this repository?' : 'Archive this repository?', exact: true }); await dialog.waitFor();
    check(await dialog.getByRole('button', { name: 'Cancel', exact: true }).evaluate(el => el === document.activeElement));
    await dialog.getByLabel('Full repository name', { exact: true }).fill(config.repository);
    await dialog.getByLabel('Current Golf password', { exact: true }).fill(config.password);
    return dialog;
  }
  async function submit(dialog, archived) {
    const before = counts.ChangeRepositoryArchiveState || 0;
    await dialog.getByRole('button', { name: archived ? 'Confirm unarchive repository' : 'Confirm archive repository', exact: true }).click();
    await dialog.waitFor({ state: 'detached' }); await panel.getByRole('heading', { name: 'Original archive operation completed', exact: true }).waitFor();
    await waitAction(!archived); await Promise.all(pending); check(counts.ChangeRepositoryArchiveState === before+1);
    const intent = requests.filter(row => row.method === 'ChangeRepositoryArchiveState').at(-1).body; intents.set(intent.idempotencyKey, intent);
    const reply = replies.filter(row => row.method === 'ChangeRepositoryArchiveState').at(-1).body; receipt(reply.operation, intent); await native(!archived);
    return intent;
  }
  for (const theme of ['dark', 'light']) {
    config={...baseConfig,...baseConfig.fixtures[theme]}; context=await browser.newContext();page=await context.newPage();attach(page);await signIn();
    panel=page.getByRole('region',{name:'Archive, transfer and deletion',exact:true});
    for (const width of [1440, 390]) {
    const at = value => { stage = value+' · '+theme+' '+width; };
    at('canonical settings current values'); await page.setViewportSize({ width, height: 900 }); await page.goto(config.golf+'/'+config.repository+'/settings'); await waitAction(false);
    at('theme selection'); const toggle = page.getByRole('button', { name: 'Switch to '+theme+' theme', exact: true }); if (await toggle.count()) await toggle.click();
    check(new URL(page.url()).pathname === '/'+config.repository+'/settings' && await page.getByRole('dialog').count() === 0); await native(false);
    at('current-value capture'); await capture(theme, width, 'current-values');
    at('explicit confirmation dialog'); let dialog = await open(false); await capture(theme, width, 'confirmation');
    at('Escape cancellation makes no mutation'); const canceledCount = counts.ChangeRepositoryArchiveState || 0; await dialog.press('Escape'); await dialog.waitFor({ state: 'detached' }); check((counts.ChangeRepositoryArchiveState || 0) === canceledCount);
    at('archive once with exact native receipt'); dialog = await open(false); const archivedIntent = await submit(dialog, false);
    at('verified receipt capture'); await capture(theme, width, 'verified-archive');
    at('reload original key is inspection only'); const beforeReload = counts.ChangeRepositoryArchiveState; await page.reload(); await waitAction(true); await panel.getByRole('heading', { name: 'Original archive operation completed', exact: true }).waitFor(); await Promise.all(pending); check(counts.ChangeRepositoryArchiveState === beforeReload);
    const inspected = replies.filter(row => row.method === 'GetRepositoryLifecycleOperation' && row.body.operation.idempotencyKey === archivedIntent.idempotencyKey).at(-1); check(inspected); receipt(inspected.body.operation, archivedIntent);
    at('separate unarchive once and independent native readback'); await submit(await open(true), true);
    }
    if(theme==='dark'){ const signedOut = await context.request.post(config.golf+'/rpc/golf.v1.SessionService/Logout',{headers:{Origin:config.golf,'Connect-Protocol-Version':'1','Content-Type':'application/json'},data:{}});check(signedOut.status()===200);await context.close();context=undefined; }
  }
  stage = 'accepted server acknowledgement deliberately withheld from browser';
  const route = '**/rpc/golf.v1.RepositoryLifecycleService/ChangeRepositoryArchiveState'; let accepted;
  await page.route(route, async intercept => {
    try {
      const response = await intercept.fetch({ timeout: 20000 }); lostAcknowledgementStatus = response.status(); check(response.status() === 200); accepted = await response.json();
      const intent = intercept.request().postDataJSON(); receipt(accepted.operation, intent); intents.set(intent.idempotencyKey, intent);
    } catch (error) {
      lostAcknowledgementFailure = error.name === 'TimeoutError' ? 'timeout' : 'receipt_or_transport'; errors.push(true);
    } finally {
      await intercept.abort('failed').catch(() => { lostAcknowledgementFailure = 'abort'; errors.push(true); });
    }
  });
  const beforeLost = counts.ChangeRepositoryArchiveState; const lostDialog = await open(false);
  await lostDialog.getByRole('button', { name: 'Confirm archive repository', exact: true }).click();
  await lostDialog.waitFor({ state: 'detached' }); await panel.getByRole('heading', { name: 'Archive operation requires inspection', exact: true }).waitFor();
  check(accepted && counts.ChangeRepositoryArchiveState === beforeLost+1); await native(true);
  await page.unroute(route);
  check(await panel.getByRole('button', { name: 'Unarchive repository', exact: true }).count() === 0);
  stage = 'inspect original accepted key without a repeated mutation';
  await panel.getByRole('button', { name: 'Inspect original archive operation', exact: true }).click();
  await panel.getByRole('heading', { name: 'Original archive operation completed', exact: true }).waitFor(); check(counts.ChangeRepositoryArchiveState === beforeLost+1);
  stage = 'reload remains status-only after deliberately lost browser acknowledgement'; await page.reload(); await waitAction(true);
  await panel.getByRole('heading', { name: 'Original archive operation completed', exact: true }).waitFor(); check(counts.ChangeRepositoryArchiveState === beforeLost+1);
  stage = 'independently observed archive is explicitly restored by a new intent'; await submit(await open(true), true);
  await Promise.all(pending); check(errors.length === 0 && captures.length === 12 && counts.ChangeRepositoryArchiveState === 10);
  // Body/password never enters tab persistence; only scoped original metadata may remain.
  check(await page.evaluate(password => Object.keys(sessionStorage).filter(key => key.startsWith('golf.lifecycle-intent.')).every(key => !sessionStorage.getItem(key).includes(password) && !sessionStorage.getItem(key).includes('currentPassword')), config.password));
  await writeFile(join(config.screenshots, 'browser-manifest.json'), JSON.stringify({ status: 'browser_checks_passed_parent_native_cleanup_pending', runtime: config.runtime, captureKind: 'Actual archive current values, requested confirmation and verified original receipt; 12 dark/light1440/390 captures', requestCounts: counts, procedureStatusCounts: statuses, lostAcknowledgementScope: 'Accepted Golf response withheld from browser; original status-only inspect and reload, no repeated mutation. Native PATCH lost acknowledgement and crash repair are not qualified.', captures }, null, 2), { mode: 0o600 });
  console.log('PASS: actual lifecycle confirmations, 10 once-only archive/unarchive intents with independent native readback, reload/status-only lost browser acknowledgement and 12 dark/light1440/390 captures');
} catch (error) {
  console.error('Lifecycle browser failed at '+stage+'; '+(error.name === 'TimeoutError' ? 'TimeoutError' : 'assertion/error')+'; private diagnostics withheld'); process.exitCode = 1;
  if (config?.screenshots) {
    let failureCapture;
    if (page && !page.isClosed()) try {
      let text = await page.locator('body').innerText(); for (const value of [config.password, config.ownerToken].filter(Boolean)) text = text.split(value).join('[redacted]');
      await page.screenshot({ path: join(config.screenshots, 'failure.png'), fullPage: true, mask: [page.locator('input,textarea,pre,code')], timeout: 10000 }); await chmod(join(config.screenshots, 'failure.png'), 0o600);
      await writeFile(join(config.screenshots, 'failure.txt'), text, { mode: 0o600 });
      failureCapture = { stage, image: 'failure.png', text: 'failure.txt', result: 'failed', caption: 'Failure-only served diagnostic, not qualification. Inputs/code masked and known credentials redacted.' };
    } catch { /* Safe staged metadata remains available. */ }
    await writeFile(join(config.screenshots, 'browser-manifest.json'), JSON.stringify({ status: 'failed', failedStage: stage, runtime: config.runtime, requestCounts: counts, procedureStatusCounts: statuses, validationOrPageErrorCount: errors.length, lostAcknowledgementStatus, lostAcknowledgementFailure, captures, failureCapture }, null, 2), { mode: 0o600 });
  }
} finally {
  if (context && config) try { const response = await context.request.post(config.golf+'/rpc/golf.v1.SessionService/Logout', { headers: { Origin: config.golf, 'Connect-Protocol-Version': '1', 'Content-Type': 'application/json' }, data: {} }); check(response.status() === 200); } catch { console.error('Lifecycle browser logout failed'); process.exitCode = 1; }
  await browser?.close();
}
