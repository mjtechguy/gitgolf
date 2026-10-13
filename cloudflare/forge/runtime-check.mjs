import { createHmac } from 'node:crypto';
import assert from 'node:assert/strict';
import { realpathSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { digest } from './src/core.mjs';
import * as esbuild from '../agents/node_modules/esbuild/lib/main.js';

const cli = dirname(dirname(realpathSync(process.argv[2])));
if (JSON.parse(await readFile(resolve(cli, 'package.json'), 'utf8')).version !== '1.0.0-beta.13') throw Error('Qualify native CLI');
const { Miniflare, convertV4MiniflareOptions } = await import(pathToFileURL(resolve(cli, 'node_modules/miniflare/dist/src/index.js')).href);
const modules = [];
const activity = await esbuild.build({ entryPoints: ['cloudflare/forge/src/activity.mjs'], outfile: 'cloudflare/forge/src/activity.runtime.mjs', bundle: true, write: false, format: 'esm', platform: 'neutral', external: ['./common.mjs', './git.mjs'] });
for (const file of ['worker.mjs', 'owners.mjs', 'public-profiles.mjs', 'public-repositories.mjs', 'operations.mjs', 'operations-provider.mjs', 'core.mjs', 'file-index.mjs', 'telemetry.mjs', 'repository-indexes.mjs', 'repository-metadata.mjs', 'metadata-jobs.mjs', 'repository-images.mjs', 'repository-reads.mjs', 'repository-cache.mjs', 'repository-settings.mjs', 'managed-registry.mjs', 'native-runners.mjs', 'gitlab-runner.mjs', 'invitations.mjs', 'discussion-resources.mjs', 'discussion-engagement.mjs', 'webhooks.mjs', 'repository-rules.mjs', 'git-credentials.mjs', 'pull-reviews.mjs', 'review-authoring.mjs', 'codeowners.mjs', 'repository-diff.mjs', 'workspace-ui.mjs', 'git.mjs', 'common.mjs', 'collaboration.mjs', 'evidence.mjs', 'delivery.mjs', 'apps.mjs', 'app-policy.mjs', 'public.mjs', 'test-policy.mjs', 'agent-policy.mjs', 'agents.mjs']) modules.push({ type: 'ESModule', path: 'forge/src/' + file, contents: (await readFile(new URL('./src/' + file, import.meta.url), 'utf8')).replace("'../data/languages.json' with { type: 'json' }", "'../data/languages.mjs'") });
modules.push({ type: 'ESModule', path: 'forge/src/performance.mjs', contents: await readFile(new URL('./src/performance.mjs', import.meta.url), 'utf8') });
modules.push({ type: 'ESModule', path: 'forge/src/activity.mjs', contents: activity.outputFiles[0].text });
const access = await esbuild.build({ entryPoints: ['cloudflare/forge/src/access.mjs'], bundle: true, write: false, format: 'esm', platform: 'neutral' });
modules.push({ type: 'ESModule', path: 'forge/src/access.mjs', contents: access.outputFiles[0].text });
const nativeWorkflow = await esbuild.build({ entryPoints: ['cloudflare/forge/src/native-workflow.mjs'], bundle: true, write: false, format: 'esm', platform: 'neutral', external: ['./git.mjs'] });
modules.push({ type: 'ESModule', path: 'forge/src/native-workflow.mjs', contents: nativeWorkflow.outputFiles[0].text });
modules.push({ type: 'ESModule', path: 'forge/data/languages.mjs', contents: 'export default ' + await readFile(new URL('./data/languages.json', import.meta.url), 'utf8') });
modules.push({ type: 'ESModule', path: 'agents/src/policy.mjs', contents: await readFile(new URL('../agents/src/policy.mjs', import.meta.url), 'utf8') });
let webhookRequests = 0;
const webhookSecret = 'r'.repeat(40);
const runtime = new Miniflare(convertV4MiniflareOptions({
  host: '127.0.0.1', port: 0, modules, compatibilityDate: '2026-10-08',
  secretsStoreSecrets: { WEBHOOK_KEY: {store_id:'local-automation',secret_name:'webhook-key'}, REGISTRY_API_TOKEN: {store_id:'local-registry',secret_name:'registry-token'} },
  outboundService: async request => {
    if (new URL(request.url).origin === 'https://api.cloudflare.com') {
      assert.equal(request.headers.get('Authorization'), 'Bearer local-registry-api-token');
      return Response.json({ success: true, result: { account_id: 'a'.repeat(32), registry_host: 'registry.cloudflare.com', username: 'operator', password: 'local-registry-password' } });
    }
    if (new URL(request.url).origin === 'https://registry.cloudflare.com') {
      assert.equal(request.headers.get('Authorization'), 'Basic ' + btoa('operator:local-registry-password'));
      assert.equal(new URL(request.url).pathname, '/v2/' + 'a'.repeat(32) + '/local-native-r1/tags/list');
      return Response.json({ name: 'a'.repeat(32) + '/local-native-r1', tags: [] });
    }
    assert.equal(new URL(request.url).origin,'https://receiver.example.com');
    const body = await request.text(), stamp = request.headers.get('X-Golf-Timestamp'), event = request.headers.get('X-Golf-Event-ID');
    assert.equal(request.headers.get('X-Golf-Signature-256'), 'sha256='+createHmac('sha256',webhookSecret).update(stamp+'\n'+event+'\n'+body).digest('hex'));
    webhookRequests++; return new Response(null,{status:204});
  },
  bindings: { PUBLIC_REPOSITORIES: 'true', REGISTRY_PROVIDER: 'cloudflare', REGISTRY_ORIGIN: 'https://registry.cloudflare.com', REGISTRY_ACCOUNT: 'a'.repeat(32), REGISTRY_REPOSITORY_PREFIX: 'a'.repeat(32) + '/local-native-r', REGISTRY_CI_ENABLED: 'false',
    WEBHOOK_POLICY: JSON.stringify({origins:['https://receiver.example.com'],dailyLimit:10}), PUBLIC_ORIGIN: 'https://golf.example.com', WORKSPACE_SLUG: 'alice', ACCOUNT_ID: 'a'.repeat(32), ARTIFACTS_NAMESPACE: 'local-proof', EVIDENCE_DAILY_LIMIT: '2', EVIDENCE_ALLOW_AI: 'false',
    EVIDENCE_DEAD_LETTER_QUEUE: 'local-failed-evidence', EVIDENCE_QUEUE_NAME: 'local-evidence', EVIDENCE_WORKFLOW_NAME: 'local-evidence', OPERATIONS_SERVICE_HEALTH: 'true' },
  d1Databases: { DB: 'local-native-proof' },
  r2Buckets: { EVIDENCE_BUCKET: 'local-evidence' },
  queueProducers: { EVIDENCE_QUEUE: 'local-evidence', FAILURE_QUEUE: 'local-failed-evidence' },
  queueConsumers: { 'local-failed-evidence': { maxBatchSize: 1, maxBatchTimeout: 0, maxRetries: 1 }, 'local-evidence': { maxBatchSize: 1, maxBatchTimeout: 0, maxRetries: 1 } },
  workflows: { EVIDENCE_FLOW: { name: 'local-evidence', className: 'EvidenceWorkflow' } },
  workflowExports: { EvidenceWorkflow: { name: 'local-evidence', stepLimit: 3 } },
  durableObjects: { WORKSPACE: { className: 'Workspace', useSQLite: true } },
}));
try {
  const secrets = await runtime.getSecretsStoreSecretAPI('WEBHOOK_KEY');
  await secrets().create(Buffer.alloc(32,9).toString('base64'));
  const registrySecret = await runtime.getSecretsStoreSecretAPI('REGISTRY_API_TOKEN');
  await registrySecret().create('local-registry-api-token');
  const database = await runtime.getD1Database('DB');
  const schema = await readFile(new URL('./schema.sql', import.meta.url), 'utf8');
  for (const statement of schema.replace(/--[^\n]*/g, '').split(/;\s*(?=CREATE\b)/).filter(s => s.trim())) await database.prepare(statement).run();
  await database.prepare("INSERT INTO users(id,login,can_create) VALUES(1,'alice',1)").run();
  await database.prepare("INSERT INTO workspaces(slug,artifact_namespace) VALUES('alice','local-proof')").run();
  const token = 'golf_native_' + 'a'.repeat(43);
  await database.prepare('INSERT INTO credentials VALUES(?,?,?,0)').bind(await digest(token), 1, Math.floor(Date.now() / 1000) + 60).run();
  const call = (path, auth = token, extra = {}, payload = {}) => runtime.dispatchFetch('https://golf.example.com' + path, {
    method: 'POST', body: JSON.stringify(payload), headers: { Authorization: 'Bearer ' + auth, 'Content-Type': 'application/json', 'Connect-Protocol-Version': '1', ...extra },
  });
  const response = await call('/rpc/golf.v1.SessionService/GetSession');
  assert.equal(response.status, 200, await response.clone().text());
  assert.equal((await response.json()).user.login, 'alice');
  assert.equal((await call('/rpc/golf.v1.SessionService/GetSession', 'invalid', { 'X-Golf-Native-Access-Email': 'alice@example.com' })).status, 401);
  await database.prepare(`INSERT INTO repositories(id,name,description,artifact_name,creator_id,creation_key,input_hash,state,created_at)
    VALUES(1,'runtime','',?,1,?,?,'ACTIVE',?)`).bind('repo-' + 'b'.repeat(32), crypto.randomUUID(), 'c'.repeat(64), new Date().toISOString()).run();
  await database.prepare("INSERT INTO grants VALUES(1,1,'admin')").run();
  const readContext = { repository: { owner: 'alice', name: 'runtime' }, repositoryId: '1', number: 1 };
  const evidenceInventory = await call('/native/pr-evidence/read', token, {}, { ...readContext, action: 'list' });
  assert.equal(evidenceInventory.status, 200); assert.deepEqual(await evidenceInventory.json(), { jobs: [], truncated: false });
  for (const path of ['pr-evidence', 'pr-preview']) {
    assert.equal((await call('/native/' + path + '/read', token, {}, { ...readContext, action: 'create' })).status, 400);
    assert.equal((await call('/native/' + path + '/read', 'invalid', {}, { ...readContext, action: 'list' })).status, 401);
  }
  const publicCall = (path, payload) => runtime.dispatchFetch('https://golf.example.com'+path, {
    method:'POST',headers:{'Content-Type':'application/json','Connect-Protocol-Version':'1'},body:JSON.stringify(payload),
  });
  assert.deepEqual(await (await publicCall('/rpc/golf.v1.SessionService/GetSession',{})).json(),{});
  await call('/native/owners',token,{}, {action:'ensurePersonal',userId:'1',login:'alice',expectedLogin:'alice'});
  const target={repository:{owner:'alice',name:'runtime'},repositoryId:'1'};
  const visibility = await (await call('/native/repository-visibility',token,{}, {...target,action:'get'})).json();
  assert.equal((await publicCall('/rpc/golf.v1.RepositoryAccessService/GetRepositoryAccess',target)).status,404);
  assert.equal((await call('/native/repository-visibility',token,{}, {...target,action:'set',isPublic:true,expectedRevision:visibility.revision})).status,200);
  assert.equal((await publicCall('/rpc/golf.v1.RepositoryAccessService/GetRepositoryAccess',target)).status,200);
  assert.equal((await (await publicCall('/native/discover',{})).json()).repositories[0].fullName,'alice/runtime');
  const draft=await (await call('/native/public-profile',token,{}, {action:'get',owner:'alice'})).json();
  assert.equal((await call('/native/public-profile',token,{}, {action:'save',owner:'alice',ownerId:draft.ownerId,expectedRevision:draft.revision,
    profile:{enabled:true,displayName:'Alice',bio:'Public',location:'',website:'',readme:'# Hello',pinned:['1']}})).status,200);
  assert.equal((await (await publicCall('/native/public-profile',{action:'get',owner:'alice'})).json()).pinnedRepositories.length,1);
  const published=await (await call('/native/repository-visibility',token,{}, {...target,action:'get'})).json();
  await call('/native/repository-visibility',token,{}, {...target,action:'set',isPublic:false,expectedRevision:published.revision});
  assert.equal((await publicCall('/rpc/golf.v1.RepositoryAccessService/GetRepositoryAccess',target)).status,404);
  assert.equal((await (await publicCall('/native/public-profile',{action:'get',owner:'alice'})).json()).pinnedRepositories.length,0);
  console.log('Real workerd/D1/DO anonymous discovery, profile publication and private revocation passed');

  const packages = await call('/native/repository-packages', token, {}, { action: 'status', repository: { owner: 'alice', name: 'runtime' }, repositoryId: '1' });
  assert.equal(packages.status, 200, await packages.clone().text());
  assert.equal((await packages.json()).provider, 'cloudflare');
  assert.equal((await call('/native/repository-packages', token, {}, { action: 'credential', repository: { owner: 'alice', name: 'runtime' }, repositoryId: '1' })).status, 501);
  console.log('Real workerd/Secrets Store/D1 managed registry inventory passed; user credential issuance is unavailable');
  await database.prepare("INSERT INTO users(id,login) VALUES(2,'collaborator')").run();
  const accessCall = (method, body = {}) => call('/rpc/golf.v1.RepositoryAccessService/' + method, token, {}, { repository: { owner: 'alice', name: 'runtime' }, ...body });
  const { access } = await (await accessCall('GetRepositoryAccess')).json();
  const accessTarget = { repositoryId: '1', ownerId: access.ownerId, expectedRevision: access.revision, userLogin: 'collaborator' };
  const { collaborator } = await (await accessCall('ResolveRepositoryCollaborator', accessTarget)).json();
  const grant = { ...accessTarget, userId: '2', expectedCollaboratorRevision: collaborator.revision, permission: 'write', idempotencyKey: crypto.randomUUID() };
  const granted = await accessCall('SetRepositoryCollaborator', grant);
  assert.equal(granted.status, 200, await granted.clone().text());
  const originalGrant = (await granted.json()).operation;
  assert.equal(originalGrant.generation, '1');
  assert.deepEqual((await (await accessCall('SetRepositoryCollaborator', grant)).json()).operation, originalGrant);
  assert.deepEqual((await (await accessCall('GetRepositoryAccessOperation', grant)).json()).operation, originalGrant);
  const refreshedAccess = (await (await accessCall('GetRepositoryAccess')).json()).access;
  const inventory = await (await accessCall('ListRepositoryCollaborators', { ...accessTarget, expectedRevision: refreshedAccess.revision })).json();
  const grantedUser = inventory.collaborators.find(value => value.user.id === '2');
  const removed = await accessCall('RemoveRepositoryCollaborator', { ...accessTarget, expectedRevision: refreshedAccess.revision, expectedCollaboratorRevision: grantedUser.revision, userId: '2', idempotencyKey: crypto.randomUUID() });
  assert.equal(removed.status, 200, await removed.clone().text());
  assert.equal((await removed.json()).operation.observedDirectMembership, false);
  assert.equal((await accessCall('SetRepositoryCollaborator', { ...grant, idempotencyKey: crypto.randomUUID() })).status, 412);
  console.log('Real D1 collaborator grants, original receipt replay, revision triggers and revocation passed');
  await database.prepare("UPDATE users SET email=login || '@example.com'").run();
  const workspace = await runtime.getDurableObjectNamespace('WORKSPACE');
  const owner = workspace.get(workspace.idFromName('alice'));
  // Exercise the private transport after the public Worker's verified Access boundary.
  const invite = (method, payload, email = 'alice@example.com') => owner.fetch(new Request('https://golf.example.com/rpc/golf.v1.RepositoryInvitationService/' + method, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'Connect-Protocol-Version': '1', 'X-Golf-Native-Access-Email': email }, body: JSON.stringify(payload),
  }));
  const invitationAccess = (await (await accessCall('GetRepositoryAccess')).json()).access;
  const invitationTarget = { repository: { owner: 'alice', name: 'runtime' }, repositoryId: '1', ownerId: invitationAccess.ownerId, expectedRevision: invitationAccess.revision };
  const preview = await invite('PreviewRepositoryInvitationRecipient', { ...invitationTarget, username: 'collaborator' });
  assert.equal(preview.status, 200, await preview.clone().text());
  const invitationInput = { ...invitationTarget, recipientId: '2', recipientUsername: 'collaborator', recipientRevision: (await preview.json()).recipient.revision, permission: 'read', persistentConsent: true, expiresAt: new Date(Date.now() + 86400000).toISOString(), idempotencyKey: crypto.randomUUID() };
  const issued = await invite('CreateRepositoryInvitation', invitationInput);
  assert.equal(issued.status, 200, await issued.clone().text());
  const { invitation } = await issued.json();
  assert.equal(await database.prepare('SELECT role FROM grants WHERE user_id=2').first(), null);
  assert.equal((await (await invite('CreateRepositoryInvitation', invitationInput)).json()).invitation.id, invitation.id);
  const decision = { invitationId: invitation.id, expectedRevision: invitation.revision, decision: 1, idempotencyKey: crypto.randomUUID() };
  const acceptance = await invite('RespondRepositoryInvitation', decision, 'collaborator@example.com');
  assert.equal(acceptance.status, 200, await acceptance.clone().text());
  assert.equal((await acceptance.json()).operation.phase, 'SUCCEEDED');
  assert.equal((await database.prepare('SELECT role FROM grants WHERE user_id=2').first()).role, 'read');
  await database.prepare('DELETE FROM grants WHERE user_id=2').run();
  const historical = await (await invite('RespondRepositoryInvitation', decision, 'collaborator@example.com')).json();
  assert.equal(historical.operation.phase, 'SUCCEEDED');
  assert.equal(historical.invitation.detailsAvailable, false);
  assert.equal(await database.prepare('SELECT role FROM grants WHERE user_id=2').first(), null);
  assert.equal((await call('/rpc/golf.v1.RepositoryInvitationService/ListOwnRepositoryInvitations')).status, 403);
  console.log('Real D1 invitation issuance, atomic acceptance and receipt replay without regrant passed');
  const issueInput = { repository: { owner: 'alice', name: 'runtime' }, repositoryId: '1', title: 'Runtime D1 issue', body: '', idempotencyKey: crypto.randomUUID() };
  const createIssue = () => call('/rpc/golf.v1.RepositoryService/CreateIssue', token, {}, issueInput);
  const created = await createIssue(); assert.equal(created.status, 200, await created.clone().text());
  const issue = (await created.json()).issue;
  assert.equal((await (await createIssue()).json()).issue.id, issue.id);
  const resourceInput = { ...issueInput, operationId: crypto.randomUUID(), kind: 1, label: { name: 'bug', color: 'ff0000' } };
  const resource = await call('/rpc/golf.v1.RepositoryService/SubmitDiscussionResourceOperation', token, {}, resourceInput);
  assert.equal(resource.status, 200, await resource.clone().text());
  const label = (await resource.json()).label;
  const assignment = { repository: issueInput.repository, repositoryId: '1', number: issue.number, issueId: issue.id, expectedRevision: issue.revision, idempotencyKey: crypto.randomUUID(), labels: { labelIds: [label.id] } };
  const assigned = await call('/rpc/golf.v1.RepositoryService/UpdateIssue', token, {}, assignment);
  assert.equal(assigned.status, 200, await assigned.clone().text());
  assert.equal((await assigned.json()).issue.metadata.labels[0].id, label.id);
  const deletionInput = { repository: issueInput.repository, repositoryId: '1', operationId: crypto.randomUUID(), kind: 3, resourceId: label.id, expectedRevision: label.revision };
  const deleted = await call('/rpc/golf.v1.RepositoryService/SubmitDiscussionResourceOperation', token, {}, deletionInput);
  assert.equal(deleted.status, 200, await deleted.clone().text());
  assert.equal((await deleted.json()).operation.phase, 'DISCUSSION_RESOURCE_OPERATION_PHASE_SUCCEEDED');
  const changed = await call('/rpc/golf.v1.RepositoryService/GetIssue', token, {}, { repository: issueInput.repository, number: issue.number });
  const cleared = (await changed.json()).issue;
  assert.equal(cleared.metadata.labels.length, 0); assert.notEqual(cleared.revision, issue.revision);
  const replay = await call('/rpc/golf.v1.RepositoryService/SubmitDiscussionResourceOperation', token, {}, resourceInput);
  assert.equal((await replay.json()).operation.observedResourceId, label.id);
  assert.equal((await database.prepare('SELECT deleted FROM discussion_resources WHERE id=?').bind(label.id).first()).deleted, 1);
  console.log('Real D1 resource creation, metadata assignment, deletion triggers and historical replay passed');
  const commentInput = { repository: issueInput.repository, repositoryId: '1', issueId: issue.id, number: issue.number, body: 'D1 transaction reply', idempotencyKey: crypto.randomUUID() };
  const posted = await call('/rpc/golf.v1.RepositoryService/CreateIssueComment', token, {}, commentInput);
  assert.equal(posted.status, 200, await posted.clone().text());
  const postedComment = (await posted.json()).comment;
  const editInput = { repository: issueInput.repository, repositoryId: '1', operationId: crypto.randomUUID(), kind: 7, resourceId: postedComment.id, expectedRevision: postedComment.revision, issueId: issue.id, number: issue.number, commentBody: 'Edited in real D1' };
  const edited = await call('/rpc/golf.v1.RepositoryService/SubmitDiscussionResourceOperation', token, {}, editInput);
  assert.equal(edited.status, 200, await edited.clone().text());
  const comments = await call('/rpc/golf.v1.RepositoryService/ListIssueComments', token, {}, commentInput);
  const commentRows = (await comments.json()).comments;
  assert.equal(commentRows.length, 1); assert.equal(commentRows[0].body, 'Edited in real D1');
  const removedComment = await call('/rpc/golf.v1.RepositoryService/SubmitDiscussionResourceOperation', token, {}, { ...editInput, operationId: crypto.randomUUID(), kind: 8, expectedRevision: commentRows[0].revision, commentBody: undefined });
  assert.equal(removedComment.status, 200, await removedComment.clone().text());
  const originalEdit = await call('/rpc/golf.v1.RepositoryService/SubmitDiscussionResourceOperation', token, {}, editInput);
  assert.equal((await originalEdit.json()).operation.phase, 'DISCUSSION_RESOURCE_OPERATION_PHASE_SUCCEEDED');
  assert.equal((await database.prepare('SELECT count(*) AS n FROM discussion_comments').first()).n, 0);
  console.log('Real D1 comment edit/delete and receipt replay without restoring content passed');
  const subscriber = 'golf_native_' + 'b'.repeat(43);
  await database.prepare('INSERT INTO credentials VALUES(?,?,?,0)').bind(await digest(subscriber), 2, Math.floor(Date.now() / 1000) + 300).run();
  await database.prepare("INSERT OR REPLACE INTO grants VALUES(1,2,'read')").run();
  const engagementTarget = { repository: issueInput.repository, repositoryId: '1', issueId: issue.id, number: issue.number };
  const engagementCall = (method, body = {}) => call('/rpc/golf.v1.DiscussionCollaborationService/' + method, subscriber, {}, body);
  const observedEngagement = await (await engagementCall('GetDiscussionEngagement', { target: engagementTarget })).json();
  const subscribe = { ...engagementTarget, operationId: crypto.randomUUID(), kind: 11, resourceId: issue.id, expectedRevision: observedEngagement.revision, subscriptionLogin: 'collaborator' };
  const subscribed = await call('/rpc/golf.v1.RepositoryService/SubmitDiscussionResourceOperation', subscriber, {}, subscribe);
  assert.equal(subscribed.status, 200, await subscribed.clone().text());
  assert.equal((await subscribed.json()).operation.phase, 'DISCUSSION_RESOURCE_OPERATION_PHASE_SUCCEEDED');
  const currentEngagement = await (await engagementCall('GetDiscussionEngagement', { target: engagementTarget })).json();
  assert.equal(currentEngagement.subscribed, true);
  const reactionInput = { ...engagementTarget, operationId: crypto.randomUUID(), kind: 9, resourceId: issue.id, expectedRevision: currentEngagement.revision, reaction: 'heart' };
  const reacted = await call('/rpc/golf.v1.RepositoryService/SubmitDiscussionResourceOperation', subscriber, {}, reactionInput);
  assert.equal(reacted.status, 200, await reacted.clone().text());
  assert.equal((await reacted.json()).operation.phase, 'DISCUSSION_RESOURCE_OPERATION_PHASE_SUCCEEDED');
  const afterReaction = await (await engagementCall('GetDiscussionEngagement', { target: engagementTarget })).json();
  assert.equal(afterReaction.reactions.find(r => r.content === 'heart').count, 1);
  const notifyReply = await call('/rpc/golf.v1.RepositoryService/CreateIssueComment', token, {}, { ...commentInput, idempotencyKey: crypto.randomUUID() });
  assert.equal(notifyReply.status, 200, await notifyReply.clone().text());
  const notices = await (await engagementCall('ListOwnForgeNotifications')).json();
  assert.equal(notices.notifications.length, 1);
  const notice = notices.notifications[0];
  const readNotice = await call('/rpc/golf.v1.RepositoryService/SubmitDiscussionResourceOperation', subscriber, {}, { ...engagementTarget, operationId: crypto.randomUUID(), kind: 13, resourceId: notice.id, expectedRevision: notice.revision });
  assert.equal(readNotice.status, 200, await readNotice.clone().text());
  assert.equal((await (await engagementCall('ListOwnForgeNotifications')).json()).notifications.length, 0);
  const timeline = await (await engagementCall('ListDiscussionTimeline', { target: engagementTarget })).json();
  assert.ok(timeline.events.some(e => e.kind === 'deleted_comment'));
  await database.prepare('DELETE FROM grants WHERE user_id=2').run();
  assert.equal((await (await engagementCall('ListOwnForgeNotifications', { includeRead: true })).json()).notifications.length, 0);
  assert.equal((await engagementCall('GetDiscussionEngagement', { target: engagementTarget })).status, 404);
  console.log('Real D1 reactions, subscriptions, timeline, inbox, mark-read and current-authority filtering passed');
  const webhookTarget = {repository:issueInput.repository,repositoryId:'1',ownerId:access.ownerId};
  const webhookCall = (method, body) => call('/rpc/golf.v1.RepositoryWebhookService/'+method,token,{}, {target:webhookTarget,...body});
  const subscriptionId = crypto.randomUUID();
  const savedHook = await webhookCall('SaveRepositoryWebhook',{id:subscriptionId,expectedVersion:'0',name:'Runtime receiver',endpoint:'https://receiver.example.com/hook',signingSecret:webhookSecret,eventTopics:['issues'],enabled:true,authorizeBackground:true});
  assert.equal(savedHook.status,200,await savedHook.clone().text());
  assert.equal((await savedHook.json()).subscription.authorizationState,'authorized');
  const webhookOperation = {subscriptionId,expectedVersion:'1',operationId:crypto.randomUUID()};
  const testHook = await webhookCall('TestRepositoryWebhook',webhookOperation);
  assert.equal(testHook.status,200,await testHook.clone().text());
  for (let i=0;i<100;i++) {
    if ((await database.prepare('SELECT state FROM webhook_deliveries WHERE id=?').bind(webhookOperation.operationId).first()).state==='accepted') break;
    await new Promise(resolve=>setTimeout(resolve,20));
  }
  const deliveredHook = await (await webhookCall('TestRepositoryWebhook',webhookOperation)).json();
  assert.equal(deliveredHook.delivery.state,'accepted');assert.equal(deliveredHook.delivery.attempts,1);assert.equal(webhookRequests,1);
  const disabledHook = await webhookCall('SaveRepositoryWebhook',{id:subscriptionId,expectedVersion:'1',name:'Runtime receiver',eventTopics:['issues'],enabled:false});
  assert.equal(disabledHook.status,200,await disabledHook.clone().text());
  assert.ok(!(await database.prepare('SELECT encrypted FROM webhook_subscriptions').first()).encrypted.includes(webhookSecret));
  console.log('Real workerd/Secrets Store/D1 webhook encryption, signed outbound delivery, original receipt and disable passed');
  const generated = await esbuild.build({ stdin: { contents: "export { RepositoryActivityService } from './web/src/gen/golf/v1/golf_pb.ts'", resolveDir: process.cwd() }, bundle: true, write: false, format: 'esm', platform: 'neutral' });
  const { RepositoryActivityService } = await import('data:text/javascript;base64,' + Buffer.from(generated.outputFiles[0].text).toString('base64'));
  const { createClient, Code } = await import('../../web/node_modules/@connectrpc/connect/dist/esm/index.js');
  const { createConnectTransport } = await import('../../web/node_modules/@connectrpc/connect-web/dist/esm/index.js');
  for (const useBinaryFormat of [false, true]) {
    const client = createClient(RepositoryActivityService, createConnectTransport({ baseUrl: 'https://golf.example.com/rpc', useBinaryFormat,
      fetch: (url, init) => runtime.dispatchFetch(url, { ...init, headers: { ...Object.fromEntries(new Headers(init.headers)), Authorization: 'Bearer ' + token } }) }));
    const stream = client.watchRepository({ repository: issueInput.repository, repositoryId: '1' }, { timeoutMs: 14000 })[Symbol.asyncIterator]();
    const reset = (await stream.next()).value; assert.equal(reset.kind, 'reset');
    const change = stream.next();
    const added = await call('/rpc/golf.v1.RepositoryService/CreateIssueComment', token, {}, { ...commentInput, idempotencyKey: crypto.randomUUID() });
    assert.equal(added.status, 200);
    assert.deepEqual((await change).value.topics, ['issues']);
    await database.prepare('DELETE FROM grants WHERE repository_id=1').run();
    await assert.rejects(stream.next(), error => error.code === Code.NotFound);
    await database.prepare("INSERT INTO grants VALUES(1,1,'admin')").run();

  }
  const bucket = await runtime.getR2Bucket('EVIDENCE_BUCKET');
  await bucket.put('test/report.json', 'original', { onlyIf: { etagDoesNotMatch: '*' } });
  assert.equal(await bucket.put('test/report.json', 'replacement', { onlyIf: { etagDoesNotMatch: '*' } }), null);
  assert.equal(await (await bucket.get('test/report.json')).text(), 'original');
  const expired = crypto.randomUUID();
  await database.prepare(`INSERT INTO evidence_jobs(id,repository_id,user_id,operation_key,input_hash,snapshot,advice_state,created_at,updated_at,expires_at)
    VALUES(?,1,1,?,'hash','{}','NONE',?,?,?)`).bind(expired, crypto.randomUUID(), new Date().toISOString(), new Date().toISOString(), '2000-01-01').run();
  const queue = await runtime.getQueueProducer('EVIDENCE_QUEUE');
  await queue.send({ jobId: expired });
  for (let i = 0; i < 100; i++) {
    if ((await database.prepare('SELECT state FROM evidence_jobs WHERE id=?').bind(expired).first()).state === 'EXPIRED') break;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.equal((await database.prepare('SELECT state FROM evidence_jobs WHERE id=?').bind(expired).first()).state, 'EXPIRED');
  const bindings = await runtime.getBindings();
  const instance = await bindings.EVIDENCE_FLOW.create({ id: expired, params: { jobId: expired } });
  let workflowStatus;
  for (let i = 0; i < 100; i++) {
    workflowStatus = await instance.status();
    if (workflowStatus.status === 'complete' || workflowStatus.status === 'errored') break;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.equal(workflowStatus.status, 'complete', JSON.stringify(workflowStatus));
  assert.equal(workflowStatus.output.state, 'EXPIRED');
  const failed = crypto.randomUUID();
  await database.prepare(`INSERT INTO evidence_jobs(id,repository_id,user_id,operation_key,input_hash,snapshot,advice_state,created_at,updated_at,expires_at)
    VALUES(?,1,1,?,'hash','[','NONE',?,?,?)`).bind(failed, crypto.randomUUID(), new Date().toISOString(), new Date().toISOString(), new Date(Date.now() + 60000).toISOString()).run();
  const broken = await bindings.EVIDENCE_FLOW.create({ id: failed, params: { jobId: failed } });
  for (let i = 0; i < 100; i++) {
    const status = await broken.status();
    if (status.status === 'errored') break;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.equal((await broken.status()).status, 'errored');
  assert.equal((await database.prepare('SELECT state FROM evidence_jobs WHERE id=?').bind(failed).first()).state, 'REFUSED');
  const failures = await runtime.getQueueProducer('FAILURE_QUEUE');
  await failures.send({ jobId: failed });
  for(let i=0;i<100;i++) {
    if((await database.prepare('SELECT COUNT(*) AS n FROM operations_delivery_failures WHERE job_id=?').bind(failed).first()).n===1) break;
    await new Promise(resolve=>setTimeout(resolve,20));
  }
  assert.equal((await database.prepare('SELECT COUNT(*) AS n FROM operations_delivery_failures WHERE job_id=?').bind(failed).first()).n,1);
  assert.equal((await database.prepare('SELECT state FROM evidence_jobs WHERE id=?').bind(failed).first()).state,'REFUSED');
  const scheduled = await (await runtime.getWorker()).scheduled({cron:'*/5 * * * *',scheduledTime:Date.now()});
  assert.equal(scheduled.outcome,'ok',JSON.stringify(scheduled));
  const maintenance = (await database.prepare('SELECT stage,outcome FROM operations_maintenance UNION ALL SELECT stage,outcome FROM webhook_maintenance ORDER BY stage').all()).results;
  assert.deepEqual(maintenance.map(row=>row.stage),['ci','evidence','indexes','previews','webhooks']);
  assert.ok(maintenance.every(row=>row.outcome==='succeeded'),JSON.stringify(maintenance));
  assert.equal((await database.prepare("SELECT state FROM operations_provider WHERE service='r2'").first()).state,'succeeded');
  await database.prepare('UPDATE credentials SET revoked=1').run();
  assert.equal((await call('/rpc/golf.v1.SessionService/GetSession')).status, 401);
  console.log('Native workerd/D1/DO, real Queues/Workflows expired/failed-job denial, durable dead-letter intake, scheduled maintenance/R2 health, conditional R2 and revocation passed');
} finally { await runtime.dispose(); }
