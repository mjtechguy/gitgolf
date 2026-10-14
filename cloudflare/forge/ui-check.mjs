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
for (const file of ['worker.mjs', 'operations.mjs', 'operations-provider.mjs', 'core.mjs', 'file-index.mjs', 'telemetry.mjs', 'repository-indexes.mjs', 'repository-metadata.mjs', 'metadata-jobs.mjs', 'repository-images.mjs', 'repository-reads.mjs', 'repository-cache.mjs', 'repository-settings.mjs', 'managed-registry.mjs', 'native-runners.mjs', 'gitlab-runner.mjs', 'invitations.mjs', 'discussion-resources.mjs', 'discussion-engagement.mjs', 'webhooks.mjs', 'repository-rules.mjs', 'git-credentials.mjs', 'pull-reviews.mjs', 'review-authoring.mjs', 'codeowners.mjs', 'repository-diff.mjs', 'owners.mjs', 'public-profiles.mjs', 'public-repositories.mjs', 'workspace-ui.mjs', 'git.mjs', 'common.mjs', 'collaboration.mjs', 'evidence.mjs', 'delivery.mjs', 'environments.mjs', 'apps.mjs', 'app-policy.mjs', 'public.mjs', 'test-policy.mjs', 'agent-policy.mjs', 'agents.mjs']) modules.push({ type: 'ESModule', path: 'forge/src/' + file, contents: (file === 'public.mjs' ? 'const GOLF_NATIVE_ASSETS=' + JSON.stringify(assets) + ';\n' : '') + (await readFile(new URL('./src/' + file, import.meta.url), 'utf8')).replace("'../data/languages.json' with { type: 'json' }", "'../data/languages.mjs'") });
modules.push({ type: 'ESModule', path: 'forge/src/activity.mjs', contents: activity.outputFiles[0].text });
const accessModule = await esbuild.build({ entryPoints: ['cloudflare/forge/src/access.mjs'], bundle: true, write: false, format: 'esm', platform: 'neutral' });
modules.push({ type: 'ESModule', path: 'forge/src/access.mjs', contents: accessModule.outputFiles[0].text });
const nativeWorkflow = await esbuild.build({ entryPoints: ['cloudflare/forge/src/native-workflow.mjs'], bundle: true, write: false, format: 'esm', platform: 'neutral', external: ['./git.mjs'] });
modules.push({ type: 'ESModule', path: 'forge/src/native-workflow.mjs', contents: nativeWorkflow.outputFiles[0].text });
modules.push({ type: 'ESModule', path: 'forge/src/performance.mjs', contents: await readFile(new URL('./src/performance.mjs', import.meta.url), 'utf8') });
modules.push({ type: 'ESModule', path: 'forge/data/languages.mjs', contents: 'export default ' + await readFile(new URL('./data/languages.json', import.meta.url), 'utf8') });
modules.push({ type: 'ESModule', path: 'agents/src/policy.mjs', contents: await readFile(new URL('../agents/src/policy.mjs', import.meta.url), 'utf8') });
const origin = 'http://127.0.0.1:18789';
const runtime = new Miniflare(convertV4MiniflareOptions({
  host: '127.0.0.1', port: serve ? 18789 : 0, modules, compatibilityDate: '2026-10-08',
  bindings: { PUBLIC_ORIGIN: origin, WORKSPACE_SLUG: 'local-access-proof', ARTIFACTS_NAMESPACE: 'local-access-proof', ACCESS_AUD: 'local-access-proof' },
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
  assert.equal((await (await rpc('/native/diagnostics')).json()).schema, 23);
  const inbox = await rpc('/rpc/golf.v1.RepositoryInvitationService/ListOwnRepositoryInvitations');
  assert.equal(inbox.status, 200, await inbox.clone().text()); assert.deepEqual((await inbox.json()).invitations, []);
  const config = await (await rpc('/native/config')).json();
  assert.equal(config.runtimeProfile, 'cloudflare-native'); assert.equal(config.apps, false); assert.equal(config.tests, false);
  const capabilities = await (await rpc('/rpc/golf.v1.CapabilityService/ListCapabilities')).json();
  assert.equal(capabilities.runtimeProfile, 'cloudflare-native');
  for(const id of ['pull.review-requests','pull.review-lifecycle','pull.pending-reviews','pull.codeowners']) assert.equal(capabilities.capabilities.find(c=>c.id===id).state,'CAPABILITY_STATE_READY');
  assert.equal(capabilities.capabilities.find(c => c.id === 'settings.runners').state, 'CAPABILITY_STATE_DISABLED');
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
  console.log('Built native UI, real local Access identity mapping, spoof rejection and D1 session passed');
  if (serve) {
    console.log('Temporary UI browser check at ' + origin + '; automatically disposed in 120 seconds');
    await new Promise(resolve => { const timer = setTimeout(resolve, 120000); for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { clearTimeout(timer); resolve(); }); });
  }
  await db.prepare('UPDATE users SET active=0').run();
  assert.equal((await runtime.dispatchFetch(origin + '/')).status, 401);
  console.log('Disabled Golf user cannot open native UI despite a valid Access dev identity');
} finally { await runtime.dispose(); }
