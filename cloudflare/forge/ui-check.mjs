// Real local Access dev context, workerd, D1 and built assets; no provider writes.
import assert from 'node:assert/strict';
import { packetLine } from './src/git.mjs';
import { readFile } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { readUIAssets } from './ui-assets.mjs';
import * as esbuild from '../agents/node_modules/esbuild/lib/main.js';
const cli = dirname(dirname(realpathSync(process.argv[2]))), serve = process.argv[3] === '--serve';
if (JSON.parse(await readFile(resolve(cli, 'package.json'), 'utf8')).version !== '1.0.0-beta.13') throw Error('Qualify native CLI');
const { Miniflare, convertV4MiniflareOptions } = await import(pathToFileURL(resolve(cli, 'node_modules/miniflare/dist/src/index.js')).href);
const modules = [];
const activity = await esbuild.build({ entryPoints: ['cloudflare/forge/src/activity.mjs'], outfile: 'cloudflare/forge/src/activity.runtime.mjs', bundle: true, write: false, format: 'esm', platform: 'neutral', external: ['./common.mjs', './git.mjs'] });
const assets = await readUIAssets(resolve('web/dist-native'));
for (const file of ['worker.mjs', 'operations.mjs', 'operations-provider.mjs', 'core.mjs', 'file-index.mjs', 'telemetry.mjs', 'repository-indexes.mjs', 'repository-metadata.mjs', 'metadata-jobs.mjs', 'repository-images.mjs', 'repository-reads.mjs', 'repository-cache.mjs', 'repository-settings.mjs', 'managed-registry.mjs', 'native-runners.mjs', 'gitlab-runner.mjs', 'invitations.mjs', 'discussion-resources.mjs', 'discussion-engagement.mjs', 'webhooks.mjs', 'repository-rules.mjs', 'git-credentials.mjs', 'pull-reviews.mjs', 'pull-merge.mjs', 'review-authoring.mjs', 'codeowners.mjs', 'repository-diff.mjs', 'owners.mjs', 'public-profiles.mjs', 'public-repositories.mjs', 'workspace-ui.mjs', 'git.mjs', 'common.mjs', 'collaboration.mjs', 'evidence.mjs', 'delivery.mjs', 'environments.mjs', 'email.mjs', 'apps.mjs', 'app-policy.mjs', 'public.mjs', 'test-policy.mjs', 'agent-policy.mjs', 'agents.mjs', 'workflow-inventory.mjs', 'execution-policy.mjs']) modules.push({ type: 'ESModule', path: 'forge/src/' + file, contents: (file === 'public.mjs' ? 'const GOLF_NATIVE_ASSETS=' + JSON.stringify(assets) + ';\n' : '') + (await readFile(new URL('./src/' + file, import.meta.url), 'utf8')).replace("'../data/languages.json' with { type: 'json' }", "'../data/languages.mjs'") });
modules.push({ type: 'ESModule', path: 'forge/src/activity.mjs', contents: activity.outputFiles[0].text });
for (const file of ['execution-values.mjs', 'sealed.mjs']) modules.push({ type: 'ESModule', path: 'forge/src/' + file, contents: await readFile(new URL('./src/' + file, import.meta.url), 'utf8') });
for (const file of ['releases.mjs', 'asset-download.mjs', 'attachments.mjs']) modules.push({ type: 'ESModule', path: 'forge/src/' + file, contents: await readFile(new URL('./src/' + file, import.meta.url), 'utf8') });
const accessModule = await esbuild.build({ entryPoints: ['cloudflare/forge/src/access.mjs'], bundle: true, write: false, format: 'esm', platform: 'neutral' });
modules.push({ type: 'ESModule', path: 'forge/src/access.mjs', contents: accessModule.outputFiles[0].text });
const nativeWorkflow = await esbuild.build({ entryPoints: ['cloudflare/forge/src/native-workflow.mjs'], bundle: true, write: false, format: 'esm', platform: 'neutral', external: ['./git.mjs'] });
modules.push({ type: 'ESModule', path: 'forge/src/native-workflow.mjs', contents: nativeWorkflow.outputFiles[0].text });
const issueTemplates = await esbuild.build({ entryPoints: ['cloudflare/forge/src/issue-templates.mjs'], bundle: true, write: false, format: 'esm', platform: 'neutral', external: ['./common.mjs', './git.mjs'] });
modules.push({ type: 'ESModule', path: 'forge/src/issue-templates.mjs', contents: issueTemplates.outputFiles[0].text });
modules.push({ type: 'ESModule', path: 'forge/src/performance.mjs', contents: await readFile(new URL('./src/performance.mjs', import.meta.url), 'utf8') });
modules.push({ type: 'ESModule', path: 'forge/src/rate-limit.mjs', contents: await readFile(new URL('./src/rate-limit.mjs', import.meta.url), 'utf8') });
modules.push({ type: 'ESModule', path: 'forge/data/languages.mjs', contents: 'export default ' + await readFile(new URL('./data/languages.json', import.meta.url), 'utf8') });
modules.push({ type: 'ESModule', path: 'agents/src/policy.mjs', contents: await readFile(new URL('../agents/src/policy.mjs', import.meta.url), 'utf8') });
const origin = 'http://127.0.0.1:18789', mailSender = 'golf@mail.example.invalid';
const runtime = new Miniflare(convertV4MiniflareOptions({
  host: '127.0.0.1', port: serve ? 18789 : 0, modules, compatibilityDate: '2026-10-08',
  bindings: { PUBLIC_ORIGIN: origin, WORKSPACE_SLUG: 'local-access-proof', ARTIFACTS_NAMESPACE: 'local-access-proof', ACCESS_AUD: 'local-access-proof', EMAIL_POLICY: JSON.stringify({ sender: mailSender, dailyLimit: 5 }) },
  // The local Email Service simulator: it enforces the sender restriction and stores messages on this machine; nothing is delivered.
  email: { send_email: [{ name: 'EMAIL', allowed_sender_addresses: [mailSender] }] },
  access: { aud: 'local-access-proof', identity: { email: 'owner@example.invalid' } },
  d1Databases: { DB: 'local-ui-proof' }, durableObjects: { WORKSPACE: { className: 'Workspace', useSQLite: true } },
}));
try {
  const db = await runtime.getD1Database('DB');
  for (const sql of (await readFile(new URL('./schema.sql', import.meta.url), 'utf8')).replace(/--[^\n]*/g, '').split(/;\s*(?=CREATE\b)/).filter(s => s.trim())) await db.prepare(sql).run();
  await db.prepare("INSERT INTO users(id,login,email,can_create) VALUES(1,'local-reviewer','owner@example.invalid',1)").run();
  await db.prepare('INSERT INTO operations_admins(user_id) VALUES(1)').run();
  const response = await runtime.dispatchFetch(origin + '/');
  assert.equal(response.status, 200, await response.clone().text()); assert.ok((await response.text()).includes('/assets/native-'));
  for (const [path, asset] of Object.entries(assets)) {
    const response = await runtime.dispatchFetch(origin + path);
    assert.equal(response.status, 200); assert.equal(response.headers.get('Content-Type'), asset.type);
    assert.equal(response.headers.get('Cache-Control'), /^\/assets\/[^/]+-[A-Za-z0-9_-]{8}\.(?:js|css|woff2?|svg)$/.test(path) ? 'private, max-age=31536000, immutable' : 'no-store');
    assert.deepEqual(new Uint8Array(await response.arrayBuffer()), Uint8Array.from(Buffer.from(asset.content, 'base64')));
  }
  const session = await runtime.dispatchFetch(origin + '/rpc/golf.v1.SessionService/GetSession', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Connect-Protocol-Version': '1', 'X-Golf-Native-Access-Email': 'forged@example.invalid' }, body: '{}' });
  assert.equal(session.status, 200, await session.clone().text()); assert.equal((await session.json()).user.login, 'local-reviewer');
  const rpc = (path, body = {}) => runtime.dispatchFetch(origin + path, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Connect-Protocol-Version': '1', Origin: origin }, body: JSON.stringify(body) });
  assert.equal((await (await rpc('/rpc/golf.v1.SessionService/GetSession')).json()).user.isInstanceAdmin,true);
  assert.equal((await (await rpc('/native/diagnostics')).json()).schema, 29);
  const inbox = await rpc('/rpc/golf.v1.RepositoryInvitationService/ListOwnRepositoryInvitations');
  assert.equal(inbox.status, 200, await inbox.clone().text()); assert.deepEqual((await inbox.json()).invitations, []);
  const config = await (await rpc('/native/config')).json();
  assert.equal(config.runtimeProfile, 'cloudflare-native'); assert.equal(config.apps, false); assert.equal(config.tests, false);
  const capabilities = await (await rpc('/rpc/golf.v1.CapabilityService/ListCapabilities')).json();
  assert.equal(capabilities.runtimeProfile, 'cloudflare-native');
  for(const id of ['pull.review-requests','pull.review-lifecycle','pull.pending-reviews','pull.codeowners']) assert.equal(capabilities.capabilities.find(c=>c.id===id).state,'CAPABILITY_STATE_READY');
  assert.equal(capabilities.capabilities.find(c => c.id === 'settings.runners').state, 'CAPABILITY_STATE_DISABLED');
  // This proof has no R2 bucket binding, so private release assets are honestly unavailable.
  assert.equal(capabilities.capabilities.find(c => c.id === 'repository.releases').state, 'CAPABILITY_STATE_DISABLED');
  const operations = await rpc('/rpc/golf.v1.OperationsService/GetOperationsDashboard'); assert.equal(operations.status,200,await operations.clone().text());
  const dashboard = await operations.json(); assert.equal(dashboard.scope,'workspace:local-access-proof'); assert.equal(dashboard.metrics.find(row=>row.id==='jobs.queued').value,0);
  await db.prepare('UPDATE operations_admins SET active=0').run();assert.equal((await rpc('/rpc/golf.v1.OperationsService/GetOperationsDashboard')).status,403);
  await db.prepare('UPDATE operations_admins SET active=1').run();
  await db.prepare("INSERT OR IGNORE INTO workspaces(slug,artifact_namespace) VALUES('local-access-proof','local-access-proof')").run();
  await db.prepare("INSERT INTO repositories(id,name,description,artifact_name,creator_id,creation_key,input_hash,state,created_at) VALUES(1,'rules-proof','','rules-proof',1,'original','hash','ACTIVE',?)").bind(new Date().toISOString()).run();
  await db.prepare("INSERT INTO grants VALUES(1,1,'admin')").run();
  const target={repository:{owner:'local-access-proof',name:'rules-proof'},repositoryId:'1',ownerId:'1'};
  const read = async (service, method, body) => {
    const response=await rpc('/rpc/golf.v1.'+service+'/'+method,body);
    assert.equal(response.status,200,await response.clone().text());return response.json();
  };
  const {access}=await read('RepositoryAccessService','GetRepositoryAccess',target);
  const before=await read('RepositoryRulesService','GetRepositoryRules',{...target,expectedRevision:access.revision});
  const input={...target,operationId:crypto.randomUUID(),expectedAccessRevision:access.revision,expectedRulesRevision:before.rulesRevision,action:1,ruleName:'main',desiredBranch:{ruleName:'main',priority:'1',requiredApprovals:'0',blockAdminMergeOverride:true}};
  const saved=await read('RepositoryRulesService','MutateRepositoryRules',input);
  assert.equal(saved.operation.phase,'SUCCEEDED');
  const body=Buffer.concat([packetLine('0'.repeat(40)+' '+'a'.repeat(40)+' refs/heads/main\0report-status\n'),Buffer.from('0000PACK\0\0\0\x02')]);
  const denied=await runtime.dispatchFetch(origin+'/git/local-access-proof/rules-proof.git/git-receive-pack',{method:'POST',headers:{'Content-Type':'application/x-git-receive-pack-request',Origin:origin},body});
  assert.equal(denied.status,403,await denied.clone().text());
  assert.equal((await db.prepare('SELECT COUNT(*) n FROM git_operations').first()).n,0);
  const info=await read('GitTransportService','GetGitTransport',target);assert.equal(info.writeCredentialAvailable,true);
  const issued=await read('GitTransportService','CreateGitCredential',{...target,label:'Runtime proof',mode:2,lifetimeSeconds:300});
  assert.match(issued.secret,/^golf_git_[A-Za-z0-9_-]{43}$/);assert.equal(issued.credential.identityBound,true);assert.equal(issued.credential.sourceIdentityActive,true);
  const basic={Authorization:'Basic '+btoa('golf:'+issued.secret),'Content-Type':'application/x-git-receive-pack-request'};
  const locked=await runtime.dispatchFetch(origin+'/git/local-access-proof/rules-proof.git/git-receive-pack',{method:'POST',headers:basic,body});
  assert.equal(locked.status,403,await locked.clone().text());
  const inventory=await read('GitTransportService','ListGitCredentials',target);assert.equal(inventory.credentials.length,1);assert.ok(!JSON.stringify(inventory).includes(issued.secret));
  assert.equal((await read('GitTransportService','RevokeGitCredential',{...target,credentialId:issued.credential.id})).revoked,true);
  const revoked=await runtime.dispatchFetch(origin+'/git/local-access-proof/rules-proof.git/git-receive-pack',{method:'POST',headers:basic,body});
  assert.equal(revoked.status,401);assert.equal(revoked.headers.get('WWW-Authenticate'),'Basic realm="Golf Git"');
  console.log('Real Access/workerd/D1 Git credential issuance, one-time secret, Basic admission, rule enforcement and revocation passed');

  const removed=await read('RepositoryRulesService','MutateRepositoryRules',{...target,operationId:crypto.randomUUID(),expectedAccessRevision:access.revision,expectedRulesRevision:saved.currentRules.rulesRevision,action:3,ruleName:'main'});
  assert.equal(removed.operation.phase,'SUCCEEDED');
  assert.deepEqual(await read('RepositoryRulesService','MutateRepositoryRules',input),saved);
  assert.deepEqual((await read('RepositoryRulesService','GetRepositoryRuleMutation',{...target,operationId:input.operationId})).operation,saved.operation);
  assert.deepEqual((await read('RepositoryRulesService','GetRepositoryRules',{...target,expectedRevision:access.revision})).branchProtections,[]);
  console.log('Real Access/workerd/D1 rules: atomic policy/receipt, admin push denial and original replay passed');
  const execution={scope:'EXECUTION_SCOPE_REPOSITORY',repository:target.repository},policy=(await read('ExecutionPolicyService','GetExecutionPolicy',execution)).policy;
  assert.deepEqual([policy.revision,policy.manualDispatchEnabled,policy.pushAllowed,policy.canEdit],['0',true,true,true]);
  const change={...execution,scopeId:policy.scopeId,expectedRevision:policy.revision,expectedAuthorityRevision:policy.authorityRevision,mode:'EXECUTION_MODE_DISABLED',allowAllWorkflows:true};
  const stored=(await read('ExecutionPolicyService','UpdateExecutionPolicy',change)).policy;
  assert.deepEqual([stored.revision,stored.manualDispatchEnabled,stored.pushAllowed,stored.mode],['1',false,false,'EXECUTION_MODE_DISABLED']);
  assert.equal((await rpc('/rpc/golf.v1.ExecutionPolicyService/UpdateExecutionPolicy',change)).status,412);
  assert.equal((await db.prepare('SELECT version FROM repository_execution_policy WHERE repository_id=1').first()).version,1);
  console.log('Real Access/workerd/D1 repository execution switch: enabled default, version-fenced save and stale refusal passed');
  await db.prepare("INSERT INTO evidence_jobs(id,repository_id,user_id,operation_key,input_hash,snapshot,advice_state,test_state,agent_state,created_at,updated_at,expires_at) VALUES('11111111-1111-4111-8111-111111111111',1,1,'original','hash',?,'NONE','PASSED','NONE','2026-10-14T00:00:00.000Z','2026-10-14T00:00:00.000Z','2026-10-14T00:10:00.000Z')").bind(JSON.stringify({selection:{number:7,headCommitId:'b'.repeat(40)}})).run();
  const recent=await (await rpc('/native/pr-evidence/read',{action:'list',repository:target.repository,repositoryId:'1'})).json();
  assert.deepEqual([recent.truncated,recent.jobs.map(job=>[job.selection.number,job.testState])],[false,[[7,'PASSED']]]);
  console.log('Real Access/workerd/D1 recent repository runs read stored selections without a provider binding');
  console.log('Built native UI, real local Access identity mapping, spoof rejection and D1 session passed');
  // Email as the Access-signed-in owner: consent, a subscription, real activity, and the send that follows that mutation without the schedule.
  const mailState = () => read('CapabilityService','ListCapabilities',{}).then(value=>value.capabilities.find(c=>c.id==='repository.email-notifications').state);
  assert.equal(await mailState(),'CAPABILITY_STATE_DEGRADED');
  assert.equal((await rpc('/rpc/golf.v1.EmailNotificationService/ListEmailTransports')).status,501);
  const own=(await read('EmailNotificationService','GetOwnEmailNotifications',{})).state;
  assert.deepEqual([own.loginEmail,own.verified,own.enabled,own.localAccountId,own.credentialVersion],['owner@example.invalid',true,false,undefined,undefined]);
  const consent={expectedContactVersion:own.contactVersion,expectedPreferenceVersion:own.preferenceVersion,enabled:true,authorizeBackground:true};
  assert.equal((await read('EmailNotificationService','SaveOwnEmailPreference',consent)).state.enabled,true);
  assert.equal((await rpc('/rpc/golf.v1.EmailNotificationService/SaveOwnEmailPreference',consent)).status,412);
  const subscription=(await read('EmailNotificationService','SaveRepositoryEmailSubscription',{target,id:crypto.randomUUID(),expectedVersion:'0',expectedContactVersion:own.contactVersion,eventTopics:['issues'],enabled:true,authorizeBackground:true})).subscription;
  assert.deepEqual([subscription.version,subscription.enabled,subscription.authorizationState],['1',true,'authorized']);
  await read('RepositoryService','CreateIssue',{repository:target.repository,repositoryId:'1',title:'Private title',body:'Private body',idempotencyKey:crypto.randomUUID()});
  let mail;
  for(let i=0;i<100&&mail?.state!=='accepted';i++){await new Promise(resolve=>setTimeout(resolve,100));mail=await db.prepare('SELECT * FROM email_deliveries').first();}
  assert.deepEqual([mail.state,mail.attempts,mail.sender,mail.event_topic,mail.possible_duplicate],['accepted',1,mailSender,'issues',0]);assert.match(mail.provider_message_id,/^<[^@>]+@[^@>]+>$/);
  const mailHistory=(await read('EmailNotificationService','ListOwnEmailDeliveries',{target})).deliveries;
  assert.deepEqual([mailHistory.length,mailHistory[0].id,mailHistory[0].state,mailHistory[0].smtpStatus,mailHistory[0].transportId],[1,mail.id,'accepted',undefined,undefined]);
  assert.equal(await mailState(),'CAPABILITY_STATE_READY');
  // Explicit redelivery is drained after its own request and disclosed as a possible duplicate.
  const again=(await read('EmailNotificationService','RedeliverOwnEmail',{deliveryId:mail.id,operationId:crypto.randomUUID(),expectedContactVersion:own.contactVersion})).delivery;
  assert.deepEqual([again.possibleDuplicate,again.eventId],[true,mail.event_id]);
  const delivered=id=>db.prepare('SELECT state,attempts,possible_duplicate FROM email_deliveries WHERE id=?').bind(id).first();
  for(let i=0;i<100&&(await delivered(again.id)).state!=='accepted';i++)await new Promise(resolve=>setTimeout(resolve,100));
  assert.deepEqual(await delivered(again.id),{state:'accepted',attempts:1,possible_duplicate:1});
  // A due retry waits for a later drain. The schedule runs one as its own stage, journalled in the email table rather than the fixed-stage journal;
  // its other stages drain too, and the overlapping drains still send the retry exactly once.
  await db.prepare("UPDATE email_deliveries SET state='retrying',completed_at=NULL,next_attempt_at='2000' WHERE id=?").bind(again.id).run();
  await (await runtime.getWorker()).scheduled({cron:'*/5 * * * *',scheduledTime:Date.now()});
  for(let i=0;i<100&&(await delivered(again.id)).state!=='accepted';i++)await new Promise(resolve=>setTimeout(resolve,100));
  assert.deepEqual(await delivered(again.id),{state:'accepted',attempts:2,possible_duplicate:1});
  const journal=await db.prepare('SELECT stage,outcome,completed_at FROM email_maintenance').first();
  assert.equal(journal.stage,'email');assert.ok(['succeeded','degraded'].includes(journal.outcome)&&journal.completed_at);
  assert.equal((await db.prepare("SELECT COUNT(*) n FROM operations_maintenance WHERE stage='email'").first()).n,0);
  assert.equal((await db.prepare('SELECT attempts FROM email_daily').first()).attempts,3);
  // READY follows the recorded acceptance for the configured sender, not the configuration.
  await db.prepare("UPDATE email_acceptance SET sender='previous@mail.example.invalid'").run();
  assert.equal(await mailState(),'CAPABILITY_STATE_DEGRADED');
  console.log('Real Access/workerd/D1 email: consent, subscription, post-mutation send, redelivery and one scheduled retry through the local Email Service simulator, and recorded acceptance passed');
  if (serve) {
    console.log('Temporary UI browser check at ' + origin + '; automatically disposed in 120 seconds');
    await new Promise(resolve => { const timer = setTimeout(resolve, 120000); for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { clearTimeout(timer); resolve(); }); });
  }
  await db.prepare('UPDATE users SET active=0').run();
  assert.equal((await runtime.dispatchFetch(origin + '/')).status, 401);
  console.log('Disabled Golf user cannot open native UI despite a valid Access dev identity');
} finally { await runtime.dispose(); }
