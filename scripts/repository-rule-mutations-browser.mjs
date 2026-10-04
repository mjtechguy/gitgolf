// Prepared actual049 UI qualifier. No substituted RPC responses; credentials stdin only.
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { writeFile, chmod } from 'node:fs/promises';
let config, browser, context, page, stage = 'initialization';
const captures = [], errors = [], pending = [], statuses = {}, counts = {}, acceptedRules = [], receiptObservations = [], managedActorObservations = [];
const decimal = value => typeof value === 'string' && /^[1-9][0-9]{0,18}$/.test(value) && BigInt(value) <= 9223372036854775807n;
const revision = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value);
function check(value) { if (!value) throw new Error('assertion'); }
function same(a, b) { return a?.owner === b?.owner && a?.name === b?.name; }
function exactTarget(value) {
 check(same(value.repository, config.target.repository) && value.repositoryId === config.target.repositoryId && value.ownerId === config.target.ownerId);
}
// Only fixed predicate names/booleans and a closed phase vocabulary leave memory.
function mutationReceiptFacts(value, request) {
 const row = value?.operation, current = value?.currentRules;
 return { phase: ['RESERVED', 'DISPATCH_UNKNOWN', 'SUCCEEDED', 'REJECTED'].includes(row?.phase) ? row.phase : 'UNREPORTED', checks: {
  operationPresent: Boolean(row), repositoryMatches: same(row?.repository, request.repository),
  operationIdMatches: row?.operationId === request.operationId,
  repositoryIdMatches: row?.repositoryId === request.repositoryId, ownerIdMatches: row?.ownerId === request.ownerId,
  actionMatches: row?.action === request.action,
  expectedAccessRevisionMatches: row?.expectedAccessRevision === request.expectedAccessRevision,
  expectedRulesRevisionMatches: row?.expectedRulesRevision === request.expectedRulesRevision,
  actorMatchesNativeFixture: row?.actorId === config.actorId,
  succeeded: row?.phase === 'SUCCEEDED', inputFingerprintValid: revision(row?.inputFingerprint),
  observedRulesRevisionValid: revision(row?.observedRulesRevision),
  currentRepositoryIdMatches: current?.repositoryId === request.repositoryId,
  currentOwnerIdMatches: current?.ownerId === request.ownerId,
  currentAccessRevisionMatches: current?.accessRevision === request.expectedAccessRevision,
  currentRulesRevisionMatches: Boolean(row) && current?.rulesRevision === row.observedRulesRevision,
  failureCodeAbsent: Boolean(row) && !row.failureCode,
  createdTimeValid: Number.isFinite(Date.parse(row?.createdAt)),
  updatedTimeValid: Number.isFinite(Date.parse(row?.updatedAt)),
  timesMonotonic: Date.parse(row?.updatedAt) >= Date.parse(row?.createdAt),
 } };
}
function mutationReceipt(value, request) {
 const facts = mutationReceiptFacts(value, request); check(Object.values(facts.checks).every(Boolean));
}
function managedActorFacts(value) {
 return { userPresent: Boolean(value?.user), actorCanonical: decimal(value?.user?.id), fixtureActorCanonical: decimal(config.actorId), actorMatchesNativeFixture: value?.user?.id === config.actorId };
}
if (process.argv.includes('--self-check')) {
 config = { actorId: '11', target: { repository: { owner: 'owned', name: 'rules' }, repositoryId: '9007199254740993', ownerId: '9' } };
 check(decimal(config.target.repositoryId) && !decimal('9223372036854775808') && !decimal('01') && !decimal(7));
 const request = { ...config.target, operationId: '12345678-1234-4123-8123-123456789abc', action: 'REPOSITORY_RULE_MUTATION_ACTION_CREATE_BRANCH', expectedAccessRevision: 'a'.repeat(64), expectedRulesRevision: 'b'.repeat(64) };
 const value = { operation: { ...request, actorId: '11', phase: 'SUCCEEDED', inputFingerprint: 'c'.repeat(64), observedRulesRevision: 'd'.repeat(64), createdAt: '2026-10-04T12:00:00Z', updatedAt: '2026-10-04T12:00:01Z' }, currentRules: { repositoryId: request.repositoryId, ownerId: request.ownerId, accessRevision: request.expectedAccessRevision, rulesRevision: 'd'.repeat(64) } };
 mutationReceipt(value, request);
 for (const field of ['operationId', 'repositoryId', 'actorId', 'phase', 'expectedRulesRevision', 'observedRulesRevision']) {
  let refused = false; try { mutationReceipt({ ...value, operation: { ...value.operation, [field]: 'wrong' } }, request); } catch { refused = true; } check(refused);
 }
 const privateValue = 'owned-private-fixture-secret';
 const privateReceipt = { operation: { ...value.operation, actorId: privateValue, phase: privateValue, createdAt: privateValue, extra: privateValue }, currentRules: { ...value.currentRules, rulesRevision: privateValue }, extra: privateValue };
 const facts = mutationReceiptFacts(privateReceipt, request);
 check(facts.phase === 'UNREPORTED' && !facts.checks.actorMatchesNativeFixture && !facts.checks.createdTimeValid && !facts.checks.currentRulesRevisionMatches);
 check(!JSON.stringify(facts).includes(privateValue) && Object.values(facts.checks).every(v => typeof v === 'boolean'));
 check(!JSON.stringify(managedActorFacts({ user: { id: privateValue, token: privateValue } })).includes(privateValue));
 check(Object.values(managedActorFacts({ user: { id: '11' } })).every(Boolean));
 for (const field of ['expectedAccessRevision', 'action', 'ownerId', 'createdAt', 'updatedAt', 'inputFingerprint']) {
  let refused = false; try { mutationReceipt({ ...value, operation: { ...value.operation, [field]: privateValue } }, request); } catch { refused = true; } check(refused);
 }
 for (const field of ['repositoryId','ownerId','accessRevision','rulesRevision']) {
  let refused = false; try { mutationReceipt({ ...value, currentRules: { ...value.currentRules, [field]: privateValue } }, request); } catch { refused = true; } check(refused);
 }
 check(uuid(request.operationId) && !uuid('bad'));
 console.log('PASS: pure049 exact browser target/operation/verified-revision/int64 receipts; no runtime operations'); process.exit(0);
}
async function settled() { await Promise.all(pending); check(errors.length === 0); }
async function inspectSaved() {
 const inspect = page.getByRole('button', { name: 'Inspect original operation', exact: true });
 if (await inspect.count()) {
  const response = page.waitForResponse(r => new URL(r.url()).pathname.endsWith('/GetRepositoryRuleMutation'));
  await inspect.click(); const value = await response; check(value.status() === 200);
  check((await value.json()).operation?.phase === 'SUCCEEDED');
  await page.getByRole('button', { name: 'Branch rule', exact: true }).waitFor();
  await page.waitForFunction(() => Array.from(document.querySelectorAll('button')).some(b => b.textContent === 'Branch rule' && !b.disabled));
 }
}
async function capture(theme, width, state) {
 check(await page.locator('html').getAttribute('data-theme') === theme); await page.evaluate(() => document.fonts.ready);
 const metrics = await page.evaluate(() => ({ documentWidth: document.documentElement.scrollWidth, viewportWidth: innerWidth, fontLoaded: document.fonts.check('16px Archivo') }));
 check(metrics.documentWidth <= width && metrics.viewportWidth === width && metrics.fontLoaded && errors.length === 0);
 const text = await page.locator('body').innerText(); check(!text.includes(config.password) && text.includes('Configure rules'));
 const privateValues = await page.evaluate(() => ({ inputs: Array.from(document.querySelectorAll('input,textarea')).map(e => e.value), storage: Object.keys(sessionStorage).map(k => [k, sessionStorage.getItem(k)]) }));
 check(!privateValues.inputs.includes(config.password) && !JSON.stringify(privateValues.storage).includes(config.password));
 for (const [key, raw] of privateValues.storage) if (key.startsWith('golf.rule-operation.')) { const value = JSON.parse(raw); check(Object.keys(value).sort().join(',') === 'accessRevision,action,operationId,rulesRevision' && uuid(value.operationId) && revision(value.accessRevision) && revision(value.rulesRevision)); }
 const id = 'rules049-'+theme+'-'+width+'-'+state;
 await page.screenshot({ path: join(config.screenshots, id+'.png'), fullPage: true }); await chmod(join(config.screenshots, id+'.png'), 0o600);
 await writeFile(join(config.screenshots, id+'.txt'), text, { mode: 0o600 });
 captures.push({ id, page: 'Repository settings · Rules', state, theme, viewport: { width, height: 900 }, ...metrics, image: id+'.png', text: id+'.txt', result: 'captured', caption: 'Actual owned ordinary administrator inventory, explicitly requested branch editor and once-only independently verified configuration receipt; no native CAS, precedence or protected merge enforcement claim.' });
}
try {
 let input = ''; for await (const chunk of process.stdin) { input += chunk; check(Buffer.byteLength(input) <= 65536); } config = JSON.parse(input); input = '';
 check(config.repository === config.target.repository.owner+'/'+config.target.repository.name && decimal(config.actorId) && decimal(config.target.repositoryId) && decimal(config.target.ownerId));
 const { chromium } = await import(pathToFileURL(join(config.stackRoot, 'web/node_modules/playwright/index.mjs')));
 browser = await chromium.launch(); context = await browser.newContext(); page = await context.newPage(); page.on('pageerror', () => errors.push('pageerror'));
 await page.route('**/rpc/**', async route => {
  const name = new URL(route.request().url()).pathname.split('/').at(-1);
  if (!/^(?:Get|List|Inspect)/.test(name) && !['LoginWithPassword', 'Logout', 'MutateRepositoryRules'].includes(name)) { errors.push('unexpected_mutation'); await route.abort(); }
  else await route.continue();
 });
 page.on('request', request => {
  const path = new URL(request.url()).pathname; if (!path.startsWith('/rpc/')) return; const name = path.split('/').at(-1); counts[name] = (counts[name] || 0)+1;
  if (name === 'MutateRepositoryRules') try {
   const value = request.postDataJSON(); exactTarget(value); check(value.action === 'REPOSITORY_RULE_MUTATION_ACTION_CREATE_BRANCH' && uuid(value.operationId) && revision(value.expectedAccessRevision) && revision(value.expectedRulesRevision));
   check(/^ui-(dark|light)-(1440|390)\/\*$/.test(value.ruleName) && value.desiredBranch?.ruleName === value.ruleName && value.desiredBranch.priority === '0' && value.desiredBranch.requiredApprovals === '1');
  } catch { errors.push('mutation_target'); }
 });
 page.on('response', response => {
  const name = new URL(response.url()).pathname.split('/').at(-1);
  if (name === 'LoginWithPassword') {
   pending.push((async () => { const facts = managedActorFacts(await response.json()); check(managedActorObservations.length < 4); managedActorObservations.push(facts); check(Object.values(facts).every(Boolean)); })().catch(() => errors.push('managed_actor'))); return;
  }
  if (!['MutateRepositoryRules', 'GetRepositoryRuleMutation'].includes(name)) return;
  const key = name+':'+response.status(); statuses[key] = (statuses[key] || 0)+1;
  pending.push((async () => {
   check(receiptObservations.length < 32);
   const observed = { procedure: name, http200: response.status() === 200, noStore: response.headers()['cache-control'] === 'no-store', bodyParsed: false };
   receiptObservations.push(observed); check(observed.http200 && observed.noStore);
   const value = await response.json(); observed.bodyParsed = true;
   const request = response.request().postDataJSON();
   observed.requestTargetMatches = same(request.repository, config.target.repository) && request.repositoryId === config.target.repositoryId && request.ownerId === config.target.ownerId;
   exactTarget(request);
   if (name === 'MutateRepositoryRules') { observed.receipt = mutationReceiptFacts(value, request); mutationReceipt(value, request); acceptedRules.push({ pattern: request.ruleName, requiredApprovals: request.desiredBranch.requiredApprovals, operationId: request.operationId, observedRulesRevision: value.operation.observedRulesRevision }); }
   else {
    const phase = value.operation?.phase;
    observed.receipt = { phase: ['RESERVED','DISPATCH_UNKNOWN','SUCCEEDED','REJECTED'].includes(phase) ? phase : 'UNREPORTED', checks: { operationIdMatches: value.operation?.operationId === request.operationId, actorMatchesNativeFixture: value.operation?.actorId === config.actorId, succeeded: phase === 'SUCCEEDED' } };
    check(Object.values(observed.receipt.checks).every(Boolean));
   }
  })().catch(() => errors.push('receipt')));
 });
 stage = 'managed ordinary-owner sign-in'; await page.goto(config.golf);
 await page.getByLabel('Email or username', { exact: true }).fill(config.email); await page.getByLabel('Password', { exact: true }).fill(config.password);
 await page.getByRole('button', { name: 'Sign in', exact: true }).click(); await page.getByRole('form', { name: 'Golf account sign-in', exact: true }).waitFor({ state: 'detached' });
 for (const theme of ['dark', 'light']) for (const width of [1440, 390]) {
  const at = value => { stage = value+' · '+theme+' '+width; };
  at('canonical Rules navigation'); await page.setViewportSize({ width, height: 900 }); await page.goto(config.golf+'/'+config.repository+'/settings/rules');
  await page.getByRole('heading', { name: 'Configure rules', exact: true }).waitFor(); await inspectSaved();
  const toggle = page.getByRole('button', { name: 'Switch to '+theme+' theme', exact: true }); if (await toggle.count()) await toggle.click();
  check(new URL(page.url()).pathname === '/'+config.repository+'/settings/rules'); await settled();
  check(await page.getByRole('form', { name: 'Add branch rule', exact: true }).count() === 0); at('actual current inventory'); await capture(theme, width, 'inventory');
  at('explicit requested branch editor'); await page.getByRole('button', { name: 'Branch rule', exact: true }).click();
  const form = page.getByRole('form', { name: 'Add branch rule', exact: true }); await form.waitFor();
  await form.getByLabel('Branch pattern', { exact: true }).fill('ui-'+theme+'-'+width+'/*'); await form.getByLabel('Required approvals', { exact: true }).fill('1'); await form.getByLabel('Priority', { exact: true }).fill('0');
  await settled(); await capture(theme, width, 'requested-editor');
  at('explicit once-only native configuration dispatch'); const before = counts.MutateRepositoryRules || 0;
  const accepted = page.waitForResponse(r => new URL(r.url()).pathname.endsWith('/MutateRepositoryRules')); await form.getByRole('button', { name: 'Save configuration', exact: true }).click();
  check((await accepted).status() === 200); await form.waitFor({ state: 'detached' }); await settled(); check(counts.MutateRepositoryRules === before+1);
  await page.getByText('Historical verified readback; current configuration may change independently.', { exact: true }).waitFor(); at('actual verified historical receipt'); await capture(theme, width, 'verified-receipt');
  at('reload is inspection-only'); const writes = counts.MutateRepositoryRules; await page.reload(); await page.getByRole('heading', { name: 'Configure rules', exact: true }).waitFor();
  await page.getByText('Status not inspected', { exact: true }).waitFor(); check(counts.MutateRepositoryRules === writes);
  await inspectSaved(); await settled(); check(counts.MutateRepositoryRules === writes);
 }
 await settled(); check(captures.length === 12 && acceptedRules.length === 4 && counts.MutateRepositoryRules === 4);
 await writeFile(join(config.screenshots, 'browser-manifest.json'), JSON.stringify({ status: 'browser_checks_passed_parent_cleanup_pending', runtime: config.runtime, captures, acceptedRules, requestCounts: counts, procedureStatusCounts: statuses, receiptObservations, managedActorObservations }, null, 2), { mode: 0o600 });
 console.log('PASS: actual requested rule edits/historical receipts/inspection-only reload and12 font-settled dark/light1440/390 captures');
} catch (error) {
 process.exitCode = 1; console.error('Rules049 browser failed at '+stage+'; '+(error.name === 'TimeoutError' ? 'TimeoutError' : 'assertion/error')+'; private diagnostics withheld');
 if (config?.screenshots) await writeFile(join(config.screenshots, 'browser-manifest.json'), JSON.stringify({ status: 'failed', failedStage: stage, runtime: config.runtime, captures, acceptedRules, requestCounts: counts, procedureStatusCounts: statuses, receiptObservations, managedActorObservations, failureCategories: [...new Set(errors)] }, null, 2), { mode: 0o600 });
} finally {
 if (context && config) try {
  const response = await context.request.post(config.golf+'/rpc/golf.v1.SessionService/Logout', { headers: { Origin: config.golf, 'Connect-Protocol-Version': '1', 'Content-Type': 'application/json' }, data: {} }); check(response.status() === 200);
 } catch { console.error('Rules049 browser logout failed'); process.exitCode = 1; }
 await browser?.close();
}
