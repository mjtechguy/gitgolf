// Explicit native browser qualification, restricted to a disposable core.
// node web/tests/issues-live.mjs --target PRIVATE_TARGET_JSON
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium, request } from '@playwright/test';

const targetIndex = process.argv.indexOf('--target');
if (targetIndex < 0 || !process.argv[targetIndex + 1]) throw new Error('A disposable target file is required.');
const target = JSON.parse(await readFile(process.argv[targetIndex + 1], 'utf8'));
const golf = new URL(target.golf), forge = new URL(target.gitea);
if (!target.project?.startsWith('golf-api-proof-') || !target.container?.startsWith(`${target.project}-gitea-`) || golf.hostname !== '127.0.0.1' || forge.hostname !== '127.0.0.1' || ['8080', '3001'].includes(golf.port) || ['8080', '3001'].includes(forge.port)) throw new Error('Only an isolated qualification target is allowed.');
const artifacts = resolve('.tmp/issues-browser');
await mkdir(artifacts, { recursive: true, mode: 0o700 });
const username = `golf-ui-${randomBytes(5).toString('hex')}`;
let created = false, browser, context, native, phase = 'fixture creation', failed = false;
function require(condition) { if (!condition) throw new Error('Qualification assertion failed.'); }
function admin(...args) { return execFileSync('docker', ['exec', '--user', '1000:1000', target.container, 'gitea', 'admin', 'user', ...args], { encoding: 'utf8', timeout: 30_000, stdio: ['ignore', 'pipe', 'pipe'] }).trim(); }
function stage(value) { phase = value; console.log(`Checking: ${value}`); }
async function rpc(client, service, method, data = {}, expected = 200) {
  const response = await client.post(`${golf.origin}/rpc/golf.v1.${service}/${method}`, { data, headers: { 'Content-Type': 'application/json', 'Connect-Protocol-Version': '1', Origin: golf.origin }, timeout: 10_000 });
  require(response.status() === expected); return response.json();
}
try {
  admin('create', '--username', username, '--email', `${username}@example.invalid`, '--random-password', '--random-password-length', '32', '--must-change-password=false'); created = true;
  const pat = admin('generate-access-token', '--username', username, '--token-name', username, '--scopes', 'write:user,write:repository,write:issue', '--raw');
  require(pat.length > 20);
  native = await request.newContext({ baseURL: `${forge.origin}/api/v1/`, extraHTTPHeaders: { Authorization: `token ${pat}` } });
  const createdRepo = await native.post('user/repos', { data: { name: 'discussion', private: true, auto_init: true } });
  require(createdRepo.status() === 201);
  const repo = await createdRepo.json();
  const repoPath = `repos/${username}/discussion`;
  let initialized = false;
  for (let attempt = 0; attempt < 50; attempt++) {
    const observation = await native.get(repoPath); require(observation.status() === 200);
    if (!(await observation.json()).empty) { initialized = true; break; }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  require(initialized);
  const sourceText = '# Golf developer preview\n\nThis is a real private source file.\n<example>Plain text stays plain text.</example>\n';
  const sourceResult = await native.post(`${repoPath}/contents/branding.txt`, { data: { message: 'Add source browsing fixture', content: Buffer.from(sourceText).toString('base64') } });
  require(sourceResult.status() === 201);
  browser = await chromium.launch({ headless: true });
  context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, colorScheme: 'dark' });
  const page = await context.newPage(); page.setDefaultTimeout(15_000);
  const errors = []; page.on('pageerror', () => errors.push('browser error'));
  const listPath = `/repositories/${username}/discussion?view=issues`;
  const pending = () => page.evaluate(() => Object.entries(sessionStorage).filter(([key]) => key.startsWith('golf.issue-intent.')));
  stage('native sign-in, issue creation, immutable target and literal body');
  await page.goto(golf.origin + listPath);
  await page.getByLabel('Gitea access token', { exact: true }).fill(pat);
  await page.getByRole('button', { name: 'Continue to workspace', exact: true }).click();
  await page.getByRole('button', { name: 'New issue', exact: true }).waitFor();
  stage('branded workspace/source with loaded fonts, narrow and zoom-equivalent reflow');
  await page.getByRole('link', { name: 'All repositories', exact: true }).click();
  await page.getByRole('link', { name: `${username}/discussion`, exact: true }).waitFor();
  await page.getByRole('button', { name: 'Dark theme', exact: true }).click();
  await page.evaluate(() => document.fonts.ready);
  require(await page.evaluate(() => [...document.fonts].some((font) => font.family.includes('Archivo') && font.status === 'loaded')));
  await page.screenshot({ path: `${artifacts}/native-workspace-dark.png`, fullPage: true });
  await page.getByRole('link', { name: `${username}/discussion`, exact: true }).click();
  await page.getByRole('link', { name: /^branding\.txt File / }).click();
  const source = page.getByLabel('Plain text preview of branding.txt', { exact: true });
  await source.waitFor(); require(await source.textContent() === sourceText);
  for (const theme of ['Dark', 'Light']) {
    await page.getByRole('button', { name: `${theme} theme`, exact: true }).click();
    await page.evaluate(() => { if (document.activeElement instanceof HTMLElement) document.activeElement.blur(); window.scrollTo({ top: 0, behavior: 'instant' }); });
    await page.screenshot({ path: `${artifacts}/native-source-${theme.toLowerCase()}.png`, fullPage: true });
  }
  for (const width of [640, 320]) {
    await page.setViewportSize({ width, height: 900 });
    require(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await page.getByRole('navigation', { name: 'Repository', exact: true }).getByRole('link', { name: 'Source', exact: true }).waitFor();
    await page.screenshot({ path: `${artifacts}/native-source-light-${width}.png`, fullPage: true });
  }
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(golf.origin + listPath);
  await page.getByRole('button', { name: 'New issue', exact: true }).click();
  stage('native issue creation, immutable target and literal body');
  const body = '  PRIVATE native issue\n<img src=x onerror="window.executed=true">\t';
  await page.getByLabel('Issue title', { exact: true }).fill('Native Golf discussion');
  await page.getByLabel('Description, plain text', { exact: true }).fill(body);
  const creating = page.waitForResponse((response) => response.url().endsWith('/golf.v1.RepositoryService/CreateIssue'));
  await page.getByRole('button', { name: 'Create issue', exact: true }).click();
  const createdIssueResponse = await creating; require(createdIssueResponse.status() === 200);
  const first = await createdIssueResponse.json();
  require(first.mutation.state === 'ISSUE_MUTATION_STATE_SUCCEEDED' && first.mutation.repositoryId === String(repo.id));
  require(first.issue.id === first.mutation.issueId && first.issue.number === first.mutation.number);
  await page.getByLabel('Issue body, plain text', { exact: true }).waitFor();
  require(await page.getByLabel('Issue body, plain text', { exact: true }).textContent() === body);
  require(await pending().then((rows) => rows.length) === 0);
  require(await page.locator('.issue-body img').count() === 0);

  stage('native repository comment pagination with an empty requested-issue page');
  const otherResult = await native.post(`${repoPath}/issues`, { data: { title: 'Other discussion', body: 'Pagination fixture' } }); require(otherResult.status() === 201);
  const other = await otherResult.json();
  for (let index = 0; index < 20; index++) require((await native.post(`${repoPath}/issues/${other.number}/comments`, { data: { body: `Other discussion ${index}` } })).status() === 201);
  const ownResult = await native.post(`${repoPath}/issues/${first.issue.number}/comments`, { data: { body: '<b>Native literal comment</b>' } }); require(ownResult.status() === 201);
  const own = await ownResult.json();
  await page.getByRole('button', { name: 'Refresh comments', exact: true }).click();
  await page.getByRole('heading', { name: 'No comments in the loaded pages.', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Load more comments', exact: true }).click();
  await page.getByLabel(`Comment ${own.id}, plain text`, { exact: true }).waitFor();
  require(await page.locator('.issue-comment b').count() === 0);

  stage('real comment write with lost browser acknowledgment and lookup-only reload');
  let lostComment, postCalls = 0, statusCalls = 0;
  page.on('request', (request) => { if (request.url().endsWith('/golf.v1.RepositoryService/GetIssueMutation')) statusCalls++; });
  await page.route('**/golf.v1.RepositoryService/CreateIssueComment', async (route) => {
    postCalls++; const response = await route.fetch(); require(response.status() === 200); lostComment = await response.json();
    require(lostComment.mutation.state === 'ISSUE_MUTATION_STATE_SUCCEEDED'); await route.abort('failed');
  });
  const privateComment = '  PRIVATE native comment\n<script>window.executed=true</script>\t';
  await page.getByLabel('Comment, plain text', { exact: true }).fill(privateComment);
  await page.getByRole('button', { name: 'Post comment', exact: true }).click();
  await page.getByRole('alert').waitFor();
  require(postCalls === 1 && lostComment.comment.id === lostComment.mutation.commentId);
  const rows = await pending(); require(rows.length === 1);
  const record = JSON.parse(rows[0][1]);
  require(Object.keys(record).sort().join(',') === 'issueId,key,kind,number,repositoryId');
  require(record.key === lostComment.mutation.idempotencyKey && record.repositoryId === String(repo.id) && record.issueId === first.issue.id && record.number === first.issue.number);
  require(!JSON.stringify(rows).includes('PRIVATE'));
  await page.unroute('**/golf.v1.RepositoryService/CreateIssueComment');
  await page.reload();
  await page.getByRole('button', { name: 'Check request status', exact: true }).waitFor();
  require(await page.getByLabel('Comment, plain text', { exact: true }).inputValue() === '');
  require(postCalls === 1 && statusCalls === 0);
  await page.getByRole('button', { name: 'Check request status', exact: true }).click();
  await page.getByText('Comment posted.', { exact: true }).waitFor();
  require(postCalls === 1 && statusCalls === 1);
  require(await pending().then((rows) => rows.length) === 0);
  const actualComments = await native.get(`${repoPath}/issues/${first.issue.number}/comments`); require(actualComments.status() === 200);
  const comments = await actualComments.json(); require(comments.filter((comment) => comment.body === privateComment).length === 1);

  stage('real issue creation acknowledgment loss, close/reload and status without duplicate');
  await page.getByRole('link', { name: 'All open issues', exact: true }).click();
  await page.getByRole('button', { name: 'New issue', exact: true }).click();
  let lostIssue, createCalls = 0;
  await page.route('**/golf.v1.RepositoryService/CreateIssue', async (route) => {
    createCalls++; const response = await route.fetch(); require(response.status() === 200); lostIssue = await response.json();
    require(lostIssue.mutation.state === 'ISSUE_MUTATION_STATE_SUCCEEDED'); await route.abort('failed');
  });
  await page.getByLabel('Issue title', { exact: true }).fill('Lost issue acknowledgment');
  await page.getByLabel('Description, plain text', { exact: true }).fill('PRIVATE lost issue');
  await page.getByRole('button', { name: 'Create issue', exact: true }).click();
  await page.getByRole('alert').waitFor(); require(createCalls === 1 && lostIssue.issue.id === lostIssue.mutation.issueId);
  await page.unroute('**/golf.v1.RepositoryService/CreateIssue');
  await page.keyboard.press('Escape');
  await page.reload();
  await page.getByRole('button', { name: 'Resume issue request', exact: true }).click();
  require(await page.getByLabel('Issue title', { exact: true }).inputValue() === '');
  require(await page.getByLabel('Description, plain text', { exact: true }).inputValue() === '');
  await page.getByRole('button', { name: 'Check request status', exact: true }).click();
  await page.getByLabel('Issue body, plain text', { exact: true }).waitFor();
  require(page.url().endsWith(`issue=${lostIssue.issue.number}`));
  require(createCalls === 1);
  const actualIssues = await native.get(`${repoPath}/issues`); require(actualIssues.status() === 200);
  require((await actualIssues.json()).filter((issue) => issue.title === 'Lost issue acknowledgment').length === 1);

  stage('charcoal desktop, light mobile, reload/deep link and literal discussion');
  await page.goto(golf.origin + listPath + `&issue=${first.issue.number}`);
  await page.getByRole('button', { name: 'Load more comments', exact: true }).click();
  await page.getByLabel(`Comment ${lostComment.comment.id}, plain text`, { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Dark theme', exact: true }).click();
  await page.evaluate(() => { if (document.activeElement instanceof HTMLElement) document.activeElement.blur(); window.scrollTo({ top: 0, behavior: 'instant' }); });
  await page.screenshot({ path: `${artifacts}/native-dark.png`, fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: 'Light theme', exact: true }).click();
  require(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await page.evaluate(() => { if (document.activeElement instanceof HTMLElement) document.activeElement.blur(); window.scrollTo({ top: 0, behavior: 'instant' }); });
  await page.screenshot({ path: `${artifacts}/native-mobile-light.png`, fullPage: true });
  require(!await page.evaluate(() => 'executed' in window));

  stage('actual session revocation clears pending convenience data and displayed discussion');
  await page.getByLabel('Comment, plain text', { exact: true }).fill('PRIVATE before revoke');
  await page.route('**/golf.v1.RepositoryService/CreateIssueComment', async (route) => { const result = await route.fetch(); require(result.status() === 200); await route.abort('failed'); });
  await page.getByRole('button', { name: 'Post comment', exact: true }).click();
  await page.getByRole('alert').waitFor();
  require(await pending().then((rows) => rows.length) === 1);
  await rpc(context.request, 'SessionService', 'RevokeOtherSessions');
  const sessions = await rpc(context.request, 'SessionService', 'ListSessions');
  const current = sessions.sessions.find((session) => session.current); require(current?.id);
  await rpc(context.request, 'SessionService', 'RevokeSession', { sessionId: current.id });
  await page.getByRole('button', { name: 'Check request status', exact: true }).click();
  await page.getByRole('heading', { name: 'Welcome to Golf', exact: true }).waitFor();
  require(await pending().then((rows) => rows.length) === 0);
  require(await page.locator('.issue-body,.issue-comment').count() === 0);
  require(errors.length === 0);
  console.log('PASS: native issue/comment writes, filtered comment pages, lost acknowledgments without repost, literal text, dark/light mobile and revoked-session cleanup');
} catch (error) {
  failed = true; const line = error?.stack?.match(/issues-live\.mjs:(\d+):\d+/)?.[1];
  console.error(`FAIL: ${phase}${line ? ` (owned script line ${line})` : ''}; diagnostic details withheld to protect credentials`);
} finally {
  let cleanupFailed = false;
  if (context) {
    try { await rpc(context.request, 'SessionService', 'RevokeOtherSessions'); } catch { /* Source may already be revoked. */ }
    try { await rpc(context.request, 'SessionService', 'Logout'); } catch { cleanupFailed = true; }
    try { await context.close(); } catch { cleanupFailed = true; }
  }
  if (native) await native.dispose();
  if (browser) await browser.close();
  if (created) try { admin('delete', '--username', username, '--purge'); } catch { cleanupFailed = true; }
  if (cleanupFailed) { failed = true; console.error('FAIL: disposable browser fixture cleanup'); }
  else console.log('PASS: browser, native user/repository/token and active session cleaned; isolated target retained for owner');
}
process.exitCode = failed ? 1 : 0;
