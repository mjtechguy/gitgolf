// Prepared real General settings UI proof; fixture credentials only on stdin.
// No RPC bodies, provider credentials or source data are written to diagnostics.
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { writeFile, chmod } from 'node:fs/promises';
let config, browser, context, page, stage = 'initialization';
const captures = [], requests = [], replies = [], errors = [], pending = [];
const counts = {}, statuses = {};
const methods = ['GetRepositorySettings', 'UpdateRepositorySettings', 'UpdateRepositoryTopics'];
function check(value) { if (!value) throw new Error('assertion'); }
function identity(body) { check(body.repositoryId === config.repositoryId && body.ownerId === config.ownerId && /^[a-f0-9]{64}$/.test(body.revision)); }
async function native() {
  const response = await context.request.get(config.gitea+'/api/v1/repos/'+config.repository, { headers: { Authorization: 'token '+config.ownerToken } });
  check(response.status() === 200); const row = await response.json();
  check(String(row.id) === config.repositoryId && String(row.owner.id) === config.ownerId);
  return row;
}
async function capture(theme, width, state) {
  check(await page.locator('html').getAttribute('data-theme') === theme);
  check(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  const text = await page.locator('body').innerText();
  check(!text.includes(config.password) && !text.includes(config.ownerToken));
  const id = 'general-'+theme+'-'+width+'-'+state;
  await page.screenshot({ path: join(config.screenshots, id+'.png'), fullPage: true }); await chmod(join(config.screenshots, id+'.png'), 0o600);
  await writeFile(join(config.screenshots, id+'.txt'), text, { mode: 0o600 });
  captures.push({ id, page: 'Repository settings · General', role: 'ordinary-native-owner', state, theme, viewport: { width, height: 900 }, image: id+'.png', text: id+'.txt', result: 'captured', caption: 'Actual disposable repository current values and requested TanStack editors. Independent native save/readback and reload checks are recorded; editor captures show unsaved fixture inputs. Native wiki configuration is not a Golf wiki workspace.' });
}
try {
  let input = ''; for await (const chunk of process.stdin) { input += chunk; check(input.length <= 65536); }
  config = JSON.parse(input); input = '';
  check(config.repository.split('/').length === 2 && /^[1-9][0-9]*$/.test(config.repositoryId) && /^[1-9][0-9]*$/.test(config.ownerId));
  const { chromium } = await import(pathToFileURL(join(config.stackRoot, 'web/node_modules/playwright/index.mjs')));
  browser = await chromium.launch(); context = await browser.newContext(); page = await context.newPage();
  page.on('pageerror', () => errors.push(true));
  page.on('request', request => {
    const method = new URL(request.url()).pathname.split('/').at(-1); if (!methods.includes(method)) return;
    counts[method] = (counts[method] || 0)+1;
    try {
      const body = request.postDataJSON(); check(body.repository.owner+'/'+body.repository.name === config.repository);
      if (method === 'GetRepositorySettings') { check(body.repositoryId === undefined || body.repositoryId === '' || body.repositoryId === config.repositoryId); }
      else { check(body.repositoryId === config.repositoryId && body.ownerId === config.ownerId && /^[a-f0-9]{64}$/.test(body.expectedRevision)); }
      requests.push({ method, body });
    } catch { errors.push(true); }
  });
  page.on('response', response => {
    const method = new URL(response.url()).pathname.split('/').at(-1); if (!methods.includes(method)) return;
    const key = method+':'+response.status(); statuses[key] = (statuses[key] || 0)+1;
    pending.push((async () => { check(response.status() === 200); const body = await response.json(); identity(body.settings); check(body.settings.generalEditImplemented === true); replies.push({ method, settings: body.settings }); })().catch(() => errors.push(true)));
  });
  stage = 'managed ordinary-owner password sign-in'; await page.goto(config.golf);
  await page.getByLabel('Email or username', { exact: true }).fill(config.email); await page.getByLabel('Password', { exact: true }).fill(config.password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click(); await page.getByRole('form', { name: 'Golf account sign-in', exact: true }).waitFor({ state: 'detached' });
  for (const theme of ['dark', 'light']) for (const width of [1440, 390]) {
    const at = (value) => { stage = value+' · '+theme+' '+width; };
    at('canonical General navigation'); await page.setViewportSize({ width, height: 900 }); await page.goto(config.golf+'/'+config.repository+'/settings');
    const edit = page.getByRole('button', { name: 'Edit general settings', exact: true }); await edit.waitFor();
    at('theme selection'); const toggle = page.getByRole('button', { name: 'Switch to '+theme+' theme', exact: true }); if (await toggle.count()) await toggle.click();
    check(new URL(page.url()).pathname === '/'+config.repository+'/settings');
    check(await page.getByRole('form', { name: 'Edit repository general settings', exact: true }).count() === 0);
    at('current-value capture'); await capture(theme, width, 'current-values'); await Promise.all(pending);
    const observed = replies.filter(row => row.method === 'GetRepositorySettings').at(-1).settings;
    const name = 'Actual browser '+theme+' '+width, website = 'https://docs.example.invalid/'+theme+'/'+width;
    const tracker = { url: 'https://issues.example.invalid', format: 'https://issues.example.invalid/{repo}/{index}', style: 'regexp', regexpPattern: 'GOLF-[0-9]+' }, wiki = { url: 'https://wiki.example.invalid/golf' };
    at('open explicit General editor'); await edit.click();
    const form = page.getByRole('form', { name: 'Edit repository general settings', exact: true });
    at('description focus and fill'); check(await form.getByLabel('Description', { exact: true }).evaluate(el => el === document.activeElement)); await form.getByLabel('Description', { exact: true }).fill(name);
    at('website fill'); await form.getByLabel('Website', { exact: true }).fill(website);
    at('external issue mode'); await form.getByLabel('Issues', { exact: true }).selectOption('3');
    at('tracker URL'); await form.getByLabel('External tracker URL', { exact: true }).fill(tracker.url);
    at('tracker format'); await form.getByLabel('External issue URL format', { exact: true }).fill(tracker.format);
    at('tracker identifiers'); await form.getByLabel('Issue identifier style', { exact: true }).selectOption(tracker.style); await form.getByLabel('Issue identifier pattern', { exact: true }).fill(tracker.regexpPattern);
    at('external wiki mode'); await form.getByLabel('Wiki', { exact: true }).selectOption('3'); await form.getByLabel('External wiki URL', { exact: true }).fill(wiki.url);
    at('requested General editor capture'); await capture(theme, width, 'general-edit');
    const writeBefore = requests.filter(row => row.method === 'UpdateRepositorySettings').length;
    at('submit General once'); await form.getByRole('button', { name: 'Save repository settings', exact: true }).click();
    at('await verified General save'); await page.getByRole('status').filter({ hasText: 'Repository settings saved.' }).waitFor(); await form.waitFor({ state: 'detached' }); await Promise.all(pending);
    check(requests.filter(row => row.method === 'UpdateRepositorySettings').length === writeBefore+1);
    const dispatched = requests.filter(row => row.method === 'UpdateRepositorySettings').at(-1).body; check(dispatched.expectedRevision === observed.revision && dispatched.description === name && dispatched.website === website);
    const saved = replies.filter(row => row.method === 'UpdateRepositorySettings').at(-1).settings;
    check(saved.description === name && saved.website === website && saved.issuesMode === 'REPOSITORY_FEATURE_MODE_EXTERNAL' && saved.wikiMode === 'REPOSITORY_FEATURE_MODE_EXTERNAL');
    check(JSON.stringify(saved.externalTracker) === JSON.stringify(tracker) && saved.externalWiki.url === wiki.url);
    at('independent native General readback'); const nativeSaved = await native(); check(nativeSaved.description === name && nativeSaved.website === website && nativeSaved.external_tracker.external_tracker_url === tracker.url && nativeSaved.external_tracker.external_tracker_format === tracker.format && nativeSaved.external_tracker.external_tracker_style === tracker.style && nativeSaved.external_tracker.external_tracker_regexp_pattern === tracker.regexpPattern && nativeSaved.external_wiki.external_wiki_url === wiki.url);
    at('General reload'); await page.reload(); await edit.waitFor(); await page.getByRole('link', { name: website, exact: true }).waitFor(); check((await page.locator('body').innerText()).includes(name));
    at('open Topics editor'); await page.getByRole('button', { name: 'Edit topics', exact: true }).click(); const topicForm = page.getByRole('form', { name: 'Edit repository topics', exact: true });
    const values = ['browser-'+theme+'-'+width, 'golf']; at('topic focus and fill'); check(await topicForm.getByRole('textbox', { name: 'Topics', exact: true }).evaluate(el => el === document.activeElement)); await topicForm.getByRole('textbox', { name: 'Topics', exact: true }).fill(values.join(', '));
    at('requested Topics editor capture'); await capture(theme, width, 'topics-edit'); await Promise.all(pending);
    const beforeTopics = replies.filter(row => row.method === 'GetRepositorySettings').at(-1).settings, topicBefore = requests.filter(row => row.method === 'UpdateRepositoryTopics').length;
    at('submit Topics once'); await topicForm.getByRole('button', { name: 'Save topics', exact: true }).click();
    at('await verified Topics save'); await page.getByRole('status').filter({ hasText: 'Repository topics saved.' }).waitFor(); await topicForm.waitFor({ state: 'detached' }); await Promise.all(pending);
    check(requests.filter(row => row.method === 'UpdateRepositoryTopics').length === topicBefore+1);
    const topicRequest = requests.filter(row => row.method === 'UpdateRepositoryTopics').at(-1).body; check(topicRequest.expectedRevision === beforeTopics.revision && JSON.stringify(topicRequest.topics) === JSON.stringify(values));
    const topicSaved = replies.filter(row => row.method === 'UpdateRepositoryTopics').at(-1).settings; check(JSON.stringify(topicSaved.topics) === JSON.stringify([...values].sort()) && topicSaved.description === name && topicSaved.website === website && topicSaved.externalTracker.url === tracker.url && topicSaved.externalWiki.url === wiki.url);
    at('independent native Topics readback'); const nativeTopics = await native(); check(JSON.stringify(nativeTopics.topics) === JSON.stringify([...values].sort()) && nativeTopics.description === name && nativeTopics.website === website && JSON.stringify(nativeTopics.internal_tracker) === JSON.stringify(nativeSaved.internal_tracker) && JSON.stringify(nativeTopics.external_tracker) === JSON.stringify(nativeSaved.external_tracker) && JSON.stringify(nativeTopics.external_wiki) === JSON.stringify(nativeSaved.external_wiki));
    at('Topics reload'); await page.reload(); await edit.waitFor(); await page.getByText([...values].sort().join(', '), { exact: true }).waitFor();
    check(await page.getByRole('dialog').count() === 0);
  }
  await Promise.all(pending); check(errors.length === 0 && captures.length === 12);
  check(counts.UpdateRepositorySettings === 4 && counts.UpdateRepositoryTopics === 4);
  await writeFile(join(config.screenshots, 'browser-manifest.json'), JSON.stringify({ status: 'browser_checks_passed_parent_native_cleanup_pending', runtime: config.runtime, captureKind: 'Actual full-General current values, requested editors, once-only saves/native readback and reload; 12 dark/light1440/390 captures', requestCounts: counts, procedureStatusCounts: statuses, captures }, null, 2), { mode: 0o600 });
  console.log('PASS: actual full-General requested editors,4 verified General saves+4 separate Topics saves/reloads and12 dark/light1440/390 captures');
} catch (error) {
  console.error('General browser failed at '+stage+'; '+(error.name === 'TimeoutError' ? 'TimeoutError' : 'assertion/error')+'; private diagnostics withheld'); process.exitCode = 1;
  if (config?.screenshots) {
    let failureCapture;
    if (page && !page.isClosed()) try {
      let text = await page.locator('body').innerText(); for (const value of [config.password, config.ownerToken].filter(Boolean)) text = text.split(value).join('[redacted]');
      await page.screenshot({ path: join(config.screenshots, 'failure.png'), fullPage: true, mask: [page.locator('input,textarea,pre,code')], timeout: 10000 }); await chmod(join(config.screenshots, 'failure.png'), 0o600);
      await writeFile(join(config.screenshots, 'failure.txt'), text, { mode: 0o600 });
      failureCapture = { stage, image: 'failure.png', text: 'failure.txt', result: 'failed', caption: 'Failure-only actual served diagnostic; inputs/code masked and known credentials redacted. Not qualification.' };
    } catch { /* Safe staged metadata remains available. */ }
    await writeFile(join(config.screenshots, 'browser-manifest.json'), JSON.stringify({ status: 'failed', failedStage: stage, runtime: config.runtime, requestCounts: counts, procedureStatusCounts: statuses, validationOrPageErrorCount: errors.length, captures, failureCapture }, null, 2), { mode: 0o600 });
  }
} finally {
  if (context && config) try { const response = await context.request.post(config.golf+'/rpc/golf.v1.SessionService/Logout', { headers: { Origin: config.golf, 'Connect-Protocol-Version': '1', 'Content-Type': 'application/json' }, data: {} }); check(response.status() === 200); } catch { console.error('General browser logout failed'); process.exitCode = 1; }
  await browser?.close();
}
