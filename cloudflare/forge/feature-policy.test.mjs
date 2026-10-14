import { test } from 'node:test';
import assert from 'node:assert/strict';
import { objectFixture, tokens, origin, repository } from './object-fixture.mjs';
import { effectiveFeatures, evidenceRefused, deliveryCancelled } from './src/feature-policy.mjs';
import { evidenceStep } from './src/evidence.mjs';
import { runCI } from './src/core.mjs';

const email = 'alice@example.invalid', uuid = () => crypto.randomUUID();
// Every governed feature allocated, as an operator would: tests, evidence, previews, values, webhooks, email, registry and public source.
function allocate(env) {
  Object.assign(env, { TEST_EXECUTION_ENABLED: 'true', TEST_WORKFLOW_FORMAT: 'actions', TEST_WORKFLOW_PATH: '.github/workflows/ci.yml', TEST_POLICY_SHA256: 'a'.repeat(64), testTasks: {},
    EVIDENCE_BUCKET: env.EVIDENCE_BUCKET || {}, EVIDENCE_QUEUE: { async send() {} }, EVIDENCE_QUEUE_NAME: 'evidence', EVIDENCE_WORKFLOW_NAME: 'evidence', EVIDENCE_DAILY_LIMIT: '5', EXECUTION_VALUE_KEY: { async get() {} },
    PREVIEW_ORIGIN: 'https://preview.example.net', PREVIEW_PATH: 'site', PREVIEW_ACCESS_AUD: 'preview', PREVIEW_TTL: '600', ACCESS_AUD: 'access',
    WEBHOOK_POLICY: JSON.stringify({ origins: ['https://hooks.example.net'], dailyLimit: 10 }), WEBHOOK_KEY: { async get() {} },
    EMAIL_POLICY: JSON.stringify({ sender: 'golf@mail.example.com', dailyLimit: 10 }), EMAIL: { async send() {} },
    REGISTRY: { async manage() {}, async fetch() {} }, REGISTRY_ORIGIN: 'https://registry.example.net', PUBLIC_REPOSITORIES: 'true' });
}
async function fixture(t) {
  const f = await objectFixture(t);
  allocate(f.env);
  f.sql.exec(`UPDATE users SET email='${email}' WHERE id=1; UPDATE users SET email='bob@example.invalid' WHERE id=2; INSERT INTO operations_admins(user_id) VALUES(1);
    INSERT INTO native_owners(id,slug,kind,user_id,creator_id) VALUES(1,'alice','PERSONAL',1,1); INSERT INTO repository_owners(repository_id,owner_id) VALUES(1,1)`);
  // A browser request as the public Worker forwards it: no credential, the verified Access address.
  const signed = async (path, body = {}, headers = { 'X-Golf-Native-Access-Email': email, 'X-Golf-Native-Access-Issued-At': String(Math.floor(Date.now() / 1000)) }) => {
    const response = await f.dispatch(new Request(origin + (path.startsWith('/') ? path : '/rpc/golf.v1.' + path), { method: 'POST', headers: { 'Content-Type': 'application/json', 'Connect-Protocol-Version': '1', ...headers }, body: JSON.stringify(body) }));
    const json = await response.json();
    return response.ok ? json : { status: response.status, code: json.code, message: json.message };
  };
  const policy = async feature => (await signed('FeaturePolicyService/GetFeaturePolicy', { scope: 'FEATURE_POLICY_SCOPE_INSTALLATION' })).policies.find(p => p.feature === feature);
  const set = async (feature, mode, confirmation = feature) => signed('FeaturePolicyService/UpdateFeaturePolicy', { scope: 'FEATURE_POLICY_SCOPE_INSTALLATION', feature, mode: 'FEATURE_POLICY_MODE_' + mode,
    expectedVersion: (await policy(feature)).version, confirmation, operationId: uuid() });
  const features = async (token = tokens.admin) => Object.fromEntries((await f.value('RepositoryFeatureService/GetRepositoryFeatures', { repository, repositoryId: '1' }, token)).features.map(feature => [feature.feature, feature]));
  return { ...f, signed, policy, set, features };
}

test('effective state: operator allocation, installation, organization, repository choice and dependencies', () => {
  const env = {}; allocate(env);
  const row = (policies = [], choices = [], execution = null, kind = 'PERSONAL') => ({ owner_kind: kind, feature_policy: JSON.stringify(policies), feature_choice: JSON.stringify(choices), feature_execution: execution && JSON.stringify(execution) });
  const state = (...args) => Object.fromEntries([...effectiveFeatures(env, row(...args))].map(([id, f]) => [id, [f.effective, f.decidedBy]]));
  // No rows: every allocated feature is on and the repository may turn it off; wiki was never allocated.
  const none = state();
  for (const id of ['actions', 'secrets', 'previews', 'attachments', 'webhooks', 'email', 'releases', 'packages']) assert.deepEqual(none[id], [true, 'REPOSITORY'], id);
  assert.deepEqual(none['public-repositories'], [true, 'INSTALLATION']); assert.deepEqual(none.wiki, [false, 'OPERATOR']);
  assert.deepEqual(none.agents, [false, 'OPERATOR']); assert.deepEqual(none.advice, [false, 'OPERATOR']);
  // Installation off wins over everything below; dependents report the dependency.
  const off = state([['installation', 'actions', 'DISABLED']]);
  assert.deepEqual([off.actions, off.secrets, off.previews], [[false, 'INSTALLATION'], [false, 'DEPENDENCY'], [false, 'DEPENDENCY']]);
  assert.match(effectiveFeatures(env, row([['installation', 'actions', 'DISABLED']])).get('secrets').reason, /because Actions is off \(installation policy\)/);
  // A repository turns an allowed feature off; enforcement overrides that choice but keeps it recorded.
  assert.deepEqual(state([], [['releases', 0, 3]]).releases, [false, 'REPOSITORY']);
  const enforced = effectiveFeatures(env, row([['installation', 'releases', 'ENFORCED']], [['releases', 0, 3]])).get('releases');
  assert.deepEqual([enforced.effective, enforced.decidedBy, enforced.repositoryEnabled, enforced.canChange], [true, 'INSTALLATION', false, false]);
  // Organization rows narrow only organization repositories.
  assert.deepEqual(state([['organization', 'webhooks', 'DISABLED']], [], null, 'ORGANIZATION').webhooks, [false, 'ORGANIZATION']);
  assert.deepEqual(state([['organization', 'webhooks', 'DISABLED']]).webhooks, [true, 'REPOSITORY']);
  // Actions follows the execution switch; a row for another artifact enables nothing.
  assert.deepEqual(state([], [], [0, 0, 1, 2]).actions, [false, 'REPOSITORY']); assert.deepEqual(state([], [], [1, 0, 1, 2]).actions, [true, 'REPOSITORY']);
  assert.deepEqual(state([], [], [1, 1, 0, 2]).actions, [false, 'REPOSITORY']); assert.deepEqual(state([], [], [0, 0, 1, 2]).secrets, [false, 'DEPENDENCY']);
  // Public repositories are never required, even by a stored row.
  assert.deepEqual(state([['installation', 'public-repositories', 'ENFORCED']])['public-repositories'], [true, 'INSTALLATION']);
  // A dependency the operator never allocated leaves its dependents unallocated, not policy-refused.
  delete env.TEST_EXECUTION_ENABLED;
  const bare = state();
  assert.deepEqual([bare.actions, bare.secrets, bare.previews], [[false, 'OPERATOR'], [false, 'OPERATOR'], [false, 'OPERATOR']]);
});

test('only a current operations administrator under Access reads or changes the installation policy', async t => {
  const f = await fixture(t), body = { scope: 'FEATURE_POLICY_SCOPE_INSTALLATION' };
  assert.equal((await f.value('FeaturePolicyService/GetFeaturePolicy', body)).status, 403);
  assert.equal((await f.signed('FeaturePolicyService/GetFeaturePolicy', body, { 'X-Golf-Native-Access-Email': email, 'CF-Access-Client-Id': 'service' })).status, 403);
  assert.equal((await f.signed('FeaturePolicyService/GetFeaturePolicy', body, { 'X-Golf-Native-Access-Email': 'bob@example.invalid' })).status, 403);
  const update = { ...body, feature: 'releases', mode: 'FEATURE_POLICY_MODE_DISABLED', expectedVersion: '0', operationId: uuid() };
  for (const token of [tokens.admin, tokens.writer]) assert.equal((await f.value('FeaturePolicyService/UpdateFeaturePolicy', update, token)).status, 403);
  assert.equal((await f.signed('FeaturePolicyService/UpdateFeaturePolicy', update, { 'X-Golf-Native-Access-Email': email, 'CF-Access-Client-Secret': 'x' })).status, 403);
  assert.equal(f.sql.prepare('SELECT count(*) AS n FROM feature_policies').get().n, 0);
  assert.equal((await f.signed('FeaturePolicyService/GetFeaturePolicy', { scope: 'FEATURE_POLICY_SCOPE_ORGANIZATION', organization: 'team' })).status, 501);
  const read = await f.signed('FeaturePolicyService/GetFeaturePolicy', body);
  assert.equal(read.revision, '0'); assert.equal(read.canEdit, true);
  const releases = read.policies.find(p => p.feature === 'releases');
  assert.deepEqual([releases.mode, releases.version, releases.allocated, releases.repositoriesOn, releases.repositoriesTotal], ['FEATURE_POLICY_MODE_ALLOWED', '0', true, 1, 1]);
  assert.match(read.policies.find(p => p.feature === 'wiki').unavailableReason, /no wiki service/);
  // A revoked administrator loses the policy with the dashboard.
  f.sql.exec('UPDATE operations_admins SET active=0');
  assert.equal((await f.signed('FeaturePolicyService/GetFeaturePolicy', body)).status, 403);
});

test('policy changes are version-fenced, widening needs the feature typed back, public repositories are never required', async t => {
  const f = await fixture(t);
  const narrow = await f.set('releases', 'DISABLED', undefined);
  assert.equal(narrow.policy.mode, 'FEATURE_POLICY_MODE_DISABLED'); assert.equal(narrow.policy.version, '1'); assert.equal(narrow.revision, '1');
  assert.equal(narrow.policy.updatedBy, 'alice'); assert.equal(narrow.policy.repositoriesOn, 0);
  // Stale version: the observed version no longer matches.
  const stale = await f.signed('FeaturePolicyService/UpdateFeaturePolicy', { scope: 'FEATURE_POLICY_SCOPE_INSTALLATION', feature: 'releases', mode: 'FEATURE_POLICY_MODE_ALLOWED', expectedVersion: '0', confirmation: 'releases', operationId: uuid() });
  assert.equal(stale.status, 412);
  assert.equal((await f.set('releases', 'ALLOWED', 'yes')).status, 400);
  assert.equal((await f.set('releases', 'ALLOWED')).policy.version, '2');
  assert.equal((await f.set('releases', 'ALLOWED')).status, 400);
  // Widening also needs an Access sign-in from the last ten minutes; the refusal writes nothing.
  const late = await f.signed('FeaturePolicyService/UpdateFeaturePolicy', { scope: 'FEATURE_POLICY_SCOPE_INSTALLATION', feature: 'packages', mode: 'FEATURE_POLICY_MODE_ENFORCED', expectedVersion: '0', confirmation: 'packages', operationId: uuid() },
    { 'X-Golf-Native-Access-Email': email, 'X-Golf-Native-Access-Issued-At': String(Math.floor(Date.now() / 1000) - 601) });
  assert.equal(late.status, 412); assert.match(late.message, /last 10 minutes/);
  // Every applied change is in the append-only installation audit log, in the same batch as the write.
  assert.deepEqual(f.sql.prepare("SELECT subject,action,before,after,widening FROM installation_audit ORDER BY id").all().map(row => ({ ...row })), [
    { subject: 'feature:releases', action: 'feature_policy.update', before: '"ALLOWED"', after: '"DISABLED"', widening: 0 },
    { subject: 'feature:releases', action: 'feature_policy.update', before: '"DISABLED"', after: '"ALLOWED"', widening: 1 }]);
  assert.match((await f.set('public-repositories', 'ENFORCED')).message, /never be required/);
  assert.equal((await f.set('wiki', 'DISABLED')).status, 412);
  assert.equal((await f.signed('FeaturePolicyService/UpdateFeaturePolicy', { scope: 'FEATURE_POLICY_SCOPE_INSTALLATION', feature: 'nonsense', mode: 'FEATURE_POLICY_MODE_DISABLED', expectedVersion: '0', operationId: uuid() })).status, 400);
  assert.equal(f.sql.prepare("SELECT revision FROM policy_revisions WHERE scope='installation'").get().revision, 2);
  const enforced = await f.set('packages', 'ENFORCED');
  assert.equal(enforced.policy.mode, 'FEATURE_POLICY_MODE_ENFORCED');
  const read = await f.signed('FeaturePolicyService/GetFeaturePolicy', { scope: 'FEATURE_POLICY_SCOPE_INSTALLATION' });
  assert.equal(read.lastChangedBy, 'alice'); assert.equal(read.revision, '3');
  // The deploy-time lock stops every change while saved policies stay in force.
  f.env.INSTALLATION_POLICY_EDITING = 'false';
  assert.equal((await f.signed('FeaturePolicyService/GetFeaturePolicy', { scope: 'FEATURE_POLICY_SCOPE_INSTALLATION' })).canEdit, false);
  const locked = await f.set('packages', 'ALLOWED');
  assert.equal(locked.status, 412); assert.match(locked.message, /locked at deploy/);
  assert.equal((await f.features()).packages.required, true);
});

test('capabilities and the repository feature read reflect the installation policy and name the level', async t => {
  const f = await fixture(t);
  const capability = async id => (await f.value('CapabilityService/ListCapabilities')).capabilities.find(c => c.id === id);
  assert.equal((await capability('settings.feature-policy')).state, 'CAPABILITY_STATE_READY');
  const before = (await f.value('CapabilityService/ListCapabilities')).capabilities;
  assert.equal((await capability('repository.releases')).state, 'CAPABILITY_STATE_READY');
  const read = await f.features(tokens.reader);
  assert.equal(read.releases.effective, true); assert.equal(read.releases.canChange, true); assert.equal(read.wiki.decidedBy, 'FEATURE_DECIDER_OPERATOR');
  assert.equal((await f.value('RepositoryFeatureService/GetRepositoryFeatures', { repository, repositoryId: '1' })).canEdit, false);
  await f.set('releases', 'DISABLED'); await f.set('actions', 'DISABLED');
  const releases = await capability('repository.releases');
  assert.equal(releases.state, 'CAPABILITY_STATE_DISABLED'); assert.equal(releases.reason, 'Releases are turned off for every repository by the installation policy.');
  assert.equal((await capability('settings.repository-secrets')).reason, 'Secrets and variables are turned off for every repository because Actions is off (installation policy).');
  // Nothing else changed state.
  const after = (await f.value('CapabilityService/ListCapabilities')).capabilities;
  assert.deepEqual(after.filter(c => c.state !== before.find(b => b.id === c.id).state).map(c => c.id).sort(),
    ['native-pr-previews', 'native-pr-tests', 'repository.releases', 'settings.repository-environments', 'settings.repository-execution-policy', 'settings.repository-secrets']);
  const features = await f.features();
  assert.deepEqual([features.releases.effective, features.releases.decidedBy, features.releases.canChange], [false, 'FEATURE_DECIDER_INSTALLATION', false]);
  assert.equal(features.releases.reason, 'Releases are turned off for this repository by the installation policy.');
  assert.equal(features.previews.decidedBy, 'FEATURE_DECIDER_DEPENDENCY');
  // Off retains data: no row of any repository table was removed or rewritten.
  assert.equal(f.sql.prepare('SELECT count(*) AS n FROM repositories').get().n, 1);
});

test('each request gate refuses with the deciding level while data stays in place', async t => {
  const f = await fixture(t), refused = /turned off for this repository by the installation policy|because Actions is off/;
  const expect412 = async (path, body) => { const result = await f.signed(path, body); assert.equal(result.status, 412, path); assert.match(result.message, refused, path); };
  const target = { repository, repositoryId: '1' };
  for (const feature of ['releases', 'packages', 'webhooks', 'email', 'secrets', 'previews', 'actions', 'attachments']) await f.set(feature, 'DISABLED');
  await expect412('RepositoryService/ListRepositoryReleases', target);
  await expect412('/native/release-asset/read', { ...target, releaseId: '1', assetId: '1' });
  await expect412('RepositoryReleasePublicationService/SubmitRepositoryReleasePublication', { ...f.target, operationId: uuid() });
  await expect412('/native/repository-packages', { ...target, action: 'list' });
  await expect412('RepositoryWebhookService/ListRepositoryWebhooks', target);
  await expect412('RepositoryExecutionValueService/ListRepositoryExecutionValues', { target: f.target });
  await expect412('/native/pr-preview/read', { ...target, action: 'list' });
  await expect412('RepositoryEnvironmentService/ListRepositoryEnvironments', { target: f.target });
  await expect412('/native/runner-placement', { ...target, action: 'get' });
  const email = await f.signed('EmailNotificationService/GetRepositoryEmailSubscription', { target: f.target });
  assert.equal(email.status, 412); assert.match(email.message, refused);
  const evidence = await f.signed('/native/pr-evidence', { action: 'create', selection: { ...target, pullRequestId: '1', number: 1, baseCommitId: 'a'.repeat(40), headCommitId: 'b'.repeat(40) }, idempotencyKey: uuid(), advice: false, runTests: true });
  assert.equal(evidence.status, 412); assert.equal(evidence.message, 'Actions is turned off for this repository by the installation policy.');
  const execution = await f.signed('ExecutionPolicyService/UpdateExecutionPolicy', { scope: 'EXECUTION_SCOPE_REPOSITORY', repository, scopeId: '1', expectedRevision: '0', expectedAuthorityRevision: 'a'.repeat(64), mode: 'EXECUTION_MODE_DISABLED', allowAllWorkflows: true });
  assert.equal(execution.status, 412); assert.equal(execution.message, 'Actions is turned off for this repository by the installation policy.');
  assert.equal((await f.signed('ExecutionPolicyService/GetExecutionPolicy', { scope: 'EXECUTION_SCOPE_REPOSITORY', repository })).policy.canEdit, false);
  // Attachments: uploads refused, the existing inventory stays readable.
  f.sql.exec("INSERT INTO discussions(id,repository_id,number,kind,author_id,title,body,state,created_at,updated_at) VALUES(1,1,1,'issue',1,'One','','OPEN','t','t')");
  const discussion = { ...target, issueId: '1', number: 1 };
  assert.equal((await f.value('DiscussionAttachmentService/ListDiscussionAttachments', { target: discussion })).attachments?.length ?? 0, 0);
  assert.equal((await f.value('DiscussionAttachmentUploadService/GetDiscussionAttachmentUploadState', { target: discussion })).canUpload, false);
  await expect412('DiscussionAttachmentUploadService/SubmitDiscussionAttachmentUpload', { target: discussion, operationId: uuid(), name: 'a.txt', content: 'aGk=' });
  // Turning the policy back on restores the routes without any repair.
  await f.set('releases', 'ALLOWED');
  assert.deepEqual((await f.value('RepositoryService/ListRepositoryReleases', target)).releases ?? [], []);
});

test('public repositories turned off stop anonymous reads and listings and refuse publishing; private stays possible', async t => {
  const f = await fixture(t);
  f.sql.exec('INSERT INTO repository_visibility(repository_id,is_public,version) VALUES(1,1,1)');
  const anonymous = path => f.value(path, { repository, repositoryId: '1' }, null);
  assert.equal((await f.value('/native/discover', {}, null)).repositories.length, 1);
  assert.equal((await anonymous('RepositoryAccessService/GetRepositoryAccess')).access.currentPermission, 'public');
  await f.set('public-repositories', 'DISABLED');
  assert.equal((await f.value('/native/discover', {}, null)).repositories.length, 0);
  assert.equal((await anonymous('RepositoryAccessService/GetRepositoryAccess')).status, 404);
  const visibility = await f.value('/native/repository-visibility', { repository, repositoryId: '1', action: 'get' });
  assert.equal(visibility.isPublic, true);
  assert.equal((await f.value('/native/repository-visibility', { repository, repositoryId: '1', action: 'set', isPublic: true, expectedRevision: visibility.revision })).status, 412);
  assert.equal((await f.value('/native/repository-visibility', { repository, repositoryId: '1', action: 'set', isPublic: false, expectedRevision: visibility.revision })).isPublic, false);
});

test('background paths: evidence steps, push intake and delivery outboxes stop where the policy turned a feature off', async t => {
  const f = await fixture(t), row = f.sql.prepare('SELECT * FROM repositories WHERE id=1').get(), db = f.env.DB, time = new Date().toISOString();
  const job = { id: uuid(), state: 'QUEUED', advice_state: 'NONE', test_state: 'REQUESTED', agent_state: 'NONE', expires_at: new Date(Date.now() + 60000).toISOString(), snapshot: JSON.stringify({ execution: { module: 'x' } }) };
  f.sql.prepare("INSERT INTO evidence_jobs(id,repository_id,user_id,operation_key,input_hash,snapshot,advice_state,test_state,created_at,updated_at,expires_at) VALUES(?,1,1,'k','h',?,'NONE','REQUESTED',?,?,?)").run(job.id, job.snapshot, time, time, job.expires_at);
  assert.equal(await evidenceRefused(db, f.env, row, job, JSON.parse(job.snapshot)), false);
  // Push intake recorded while Actions is allowed, refused once it is off.
  const push = state => f.sql.prepare("INSERT INTO git_operations(id,repository_id,user_id,ref,old_sha,new_sha,state,ci_state,created_at) VALUES(?,1,1,'refs/heads/main',?,?,'APPLIED','PENDING',?)").run(state, '0'.repeat(40), 'a'.repeat(40), time);
  f.env.CI_AUTO = 'true'; push('first'); await runCI(f.env);
  assert.equal(f.sql.prepare("SELECT ci_state FROM git_operations WHERE id='first'").get().ci_state, 'RECORDED');
  await f.set('actions', 'DISABLED');
  push('second'); await runCI(f.env);
  assert.equal(f.sql.prepare("SELECT ci_state FROM git_operations WHERE id='second'").get().ci_state, 'REFUSED');
  assert.equal((await evidenceStep(db, f.env, job, { person: { id: 1 }, row, artifact: null }, 'tests')).state, 'REFUSED');
  assert.equal(f.sql.prepare('SELECT state FROM evidence_jobs WHERE id=?').get(job.id).state, 'REFUSED');
  // Outboxes: queued deliveries of a repository with the feature off are cancelled with their own code; finished ones keep their record.
  await f.set('webhooks', 'DISABLED'); await f.set('email', 'DISABLED');
  f.sql.exec(`INSERT INTO webhook_subscriptions VALUES('s',1,'${row.artifact_name}',1,'hook','hooks.example.net','x',1,'["issues"]',1,1,1,0,0,'t','t');
    INSERT INTO email_subscriptions VALUES('s',1,1,'${row.artifact_name}',1,'["issues"]',1,1,0,0,'t','t')`);
  f.sql.prepare("INSERT INTO webhook_deliveries(id,subscription_id,subscription_version,event_id,event_topic,payload,state,next_attempt_at,created_at) VALUES('queued','s',1,'e','issues','{}','queued',?,?),('done','s',1,'f','issues','{}','accepted',?,?)").run(time, time, time, time);
  f.sql.prepare("INSERT INTO email_deliveries(id,subscription_id,subscription_version,user_id,repository_id,identity_version,event_id,event_topic,state,next_attempt_at,created_at) VALUES('mail','s',1,1,1,0,'e','issues','retrying',?,?)").run(time, time);
  assert.equal(await deliveryCancelled(db, f.env, 1, 'webhooks', 'queued'), true); assert.equal(await deliveryCancelled(db, f.env, 1, 'webhooks', 'done'), true);
  assert.equal(await deliveryCancelled(db, f.env, 1, 'email', 'mail'), true);
  assert.deepEqual(f.sql.prepare('SELECT id,state,failure_code FROM webhook_deliveries ORDER BY id').all().map(d => [d.id, d.state, d.failure_code]), [['done', 'accepted', ''], ['queued', 'cancelled', 'disabled_by_policy']]);
  assert.deepEqual(Object.values(f.sql.prepare('SELECT state,failure_code FROM email_deliveries').get()), ['cancelled', 'disabled_by_policy']);
  await f.set('webhooks', 'ALLOWED');
  assert.equal(await deliveryCancelled(db, f.env, 1, 'webhooks', 'queued'), false);
});

test('repository administrators toggle within the policy; Actions writes through the execution switch', async t => {
  const f = await fixture(t), target = { repository, repositoryId: '1' };
  const read = async () => f.signed('RepositoryFeatureService/GetRepositoryFeatures', target);
  const update = (changes, revision, headers) => f.signed('RepositoryFeatureService/UpdateRepositoryFeatures', { ...target, expectedRevision: revision, changes }, headers);
  const current = await f.signed('RepositoryFeatureService/GetRepositoryFeatures', target);
  assert.equal(current.canEdit, true); assert.equal((await f.value('RepositoryFeatureService/GetRepositoryFeatures', target)).canEdit, false);
  // Bearer, service-token and non-administrator callers never change features.
  assert.equal((await f.value('RepositoryFeatureService/UpdateRepositoryFeatures', { ...target, expectedRevision: current.revision, changes: [{ feature: 'releases' }] })).status, 403);
  assert.equal((await update([{ feature: 'releases' }], current.revision, { 'X-Golf-Native-Access-Email': email, 'CF-Access-Client-Id': 'service' })).status, 403);
  assert.equal((await update([{ feature: 'releases' }], current.revision, { 'X-Golf-Native-Access-Email': 'bob@example.invalid' })).status, 403);
  assert.equal((await update([{ feature: 'nonsense' }], current.revision)).status, 400);
  assert.equal((await update([{ feature: 'releases', enabled: true }], current.revision)).status, 400);
  assert.equal((await update([{ feature: 'public-repositories' }], current.revision)).status, 412);
  const off = await update([{ feature: 'releases' }, { feature: 'actions' }], current.revision);
  const state = Object.fromEntries(off.features.map(feature => [feature.feature, feature]));
  assert.deepEqual([state.releases.effective, state.releases.decidedBy, state.releases.repositoryEnabled], [false, 'FEATURE_DECIDER_REPOSITORY', false]);
  assert.deepEqual([state.actions.effective, state.secrets.decidedBy], [false, 'FEATURE_DECIDER_DEPENDENCY']);
  assert.deepEqual({ ...f.sql.prepare('SELECT manual,push,version FROM repository_execution_policy').get() }, { manual: 0, push: 0, version: 1 });
  assert.deepEqual(f.sql.prepare('SELECT feature,enabled FROM repository_features').all().map(row => [row.feature, row.enabled]), [['releases', 0]]);
  assert.deepEqual(f.sql.prepare("SELECT scope,scope_id,subject,after FROM installation_audit WHERE scope='repository' AND action='repository_feature.update' AND json_extract(client,'$.outcome') IS NULL ORDER BY id").all().map(row => Object.values(row)), [['repository', '1', 'feature:releases', 'false'], ['repository', '1', 'feature:actions', 'false']]);
  // The three refusals above (bearer, service token, non-administrator) are each recorded once by the dispatch hook, with who and how.
  assert.deepEqual(f.sql.prepare("SELECT json_extract(client,'$.outcome') AS outcome,json_extract(client,'$.via') AS via FROM installation_audit WHERE action='repository_feature.update' AND json_extract(client,'$.outcome') IS NOT NULL ORDER BY id").all().map(row => [row.outcome, row.via]),
    [['denied', 'token'], ['denied', 'service'], ['denied', 'person']]);
  assert.equal((await f.signed('ExecutionPolicyService/GetExecutionPolicy', { scope: 'EXECUTION_SCOPE_REPOSITORY', repository })).policy.mode, 'EXECUTION_MODE_DISABLED');
  const refused = await f.signed('RepositoryService/ListRepositoryReleases', target);
  assert.equal(refused.message, 'Releases are turned off for this repository by the repository policy.');
  // The observed revision is fenced.
  assert.equal((await update([{ feature: 'releases', enabled: true }], current.revision)).status, 412);
  assert.equal((await read()).revision, off.revision);
  // An installation requirement overrides the repository's recorded choice, which it cannot change meanwhile.
  await f.set('releases', 'ENFORCED');
  const enforced = Object.fromEntries((await read()).features.map(feature => [feature.feature, feature]));
  assert.deepEqual([enforced.releases.effective, enforced.releases.repositoryEnabled, enforced.releases.canChange], [true, false, false]);
  assert.equal((await update([{ feature: 'releases', enabled: true }], off.revision)).status, 412);
  await f.set('releases', 'DISABLED');
  assert.equal((await update([{ feature: 'releases', enabled: true }], off.revision)).message, 'Releases are turned off for this repository by the installation policy.');
  await f.set('releases', 'ALLOWED');
  const on = await update([{ feature: 'releases', enabled: true }, { feature: 'actions', enabled: true }], off.revision);
  assert.equal(on.features.find(feature => feature.feature === 'releases').effective, true);
  assert.deepEqual({ ...f.sql.prepare('SELECT manual,push,version FROM repository_execution_policy').get() }, { manual: 1, push: 1, version: 2 });
  // A change through the execution switch also moves the revision.
  const switched = await f.signed('ExecutionPolicyService/UpdateExecutionPolicy', { scope: 'EXECUTION_SCOPE_REPOSITORY', repository, scopeId: '1', expectedRevision: '2', expectedAuthorityRevision: (await f.access()).revision, mode: 'EXECUTION_MODE_ALL', manualDispatchEnabled: true, pushAllowed: false, allowAllWorkflows: true });
  assert.equal(switched.policy.revision, '3');
  assert.equal((await update([{ feature: 'releases', enabled: false }], on.revision)).status, 412);
});

test('issues, pull requests and merge are gated after the discussion kind is settled', async t => {
  const f = await fixture(t), target = { repository, repositoryId: '1' }, time = new Date().toISOString();
  f.sql.exec(`INSERT INTO discussions(id,repository_id,number,kind,author_id,title,body,state,created_at,updated_at) VALUES(1,1,1,'issue',1,'Issue','','OPEN','t','t'),(2,1,2,'pull',1,'Pull','','OPEN','t','t');
    INSERT INTO pull_requests(id,discussion_id,base_branch,head_branch,base_commit,head_commit,draft) VALUES(1,2,'main','feature','a','b',0);
    INSERT INTO discussion_comments(id,discussion_id,author_id,body,created_at,updated_at) VALUES(5,2,1,'On the pull request','t','t');
    INSERT INTO collaboration_operations VALUES('op',1,1,'0b6f1f3e-2a4c-4d5e-8f60-7a8b9c0d1e2f','CreateIssueComment','h','comment',5,'${time}')`);
  const listed = async () => (await f.value('RepositoryService/ListRepositories', { metadataOnly: true })).repositories[0];
  const revision = async () => (await f.signed('RepositoryFeatureService/GetRepositoryFeatures', target)).revision;
  const toggle = async (feature, enabled) => f.signed('RepositoryFeatureService/UpdateRepositoryFeatures', { ...target, expectedRevision: await revision(), changes: [{ feature, enabled }] });
  const comments = pullRequest => f.signed('RepositoryService/ListIssueComments', { ...target, number: pullRequest ? 2 : 1, issueId: pullRequest ? '2' : '1', pullRequest });
  await toggle('issues', false);
  assert.deepEqual([(await listed()).issuesEnabled, (await listed()).pullRequestsEnabled], [false, true]);
  assert.equal((await f.signed('RepositoryService/ListIssues', target)).message, 'Issues are turned off for this repository by the repository policy.');
  assert.equal((await comments(false)).status, 412);
  assert.deepEqual((await comments(true)).comments.map(comment => comment.body), ['On the pull request']);
  // Claiming the other kind does not get past the gate, and the module's own lookup refuses a mismatched kind.
  assert.equal((await f.signed('RepositoryService/ListIssueComments', { ...target, number: 2, issueId: '2', pullRequest: false })).status, 412);
  assert.equal((await f.signed('RepositoryService/ListIssueComments', { ...target, number: 1, issueId: '1', pullRequest: true })).status, 404);
  assert.equal((await f.signed('RepositoryService/GetIssueMutation', { ...target, idempotencyKey: '0b6f1f3e-2a4c-4d5e-8f60-7a8b9c0d1e2f' })).mutation.number, 2);
  await toggle('issues', true); await toggle('merge', false);
  const merge = await f.signed('StandardPullMergeService/GetStandardPullMergeOperation', { ...target, operationId: uuid() });
  assert.equal(merge.message, 'Merge is turned off for this repository by the repository policy.');
  assert.notEqual((await f.signed('RepositoryService/ListPullRequests', target)).status, 412);
  await toggle('merge', true); await toggle('pull-requests', false);
  assert.equal((await listed()).pullRequestsEnabled, false);
  for (const [path, body] of [['RepositoryService/ListPullRequests', target], ['RepositoryService/GetIssueMutation', { ...target, idempotencyKey: '0b6f1f3e-2a4c-4d5e-8f60-7a8b9c0d1e2f' }], ['PullMergeObservationService/GetPullRequestMergeObservation', target], ['/native/repository-check', target]])
    assert.equal((await f.signed(path, body)).status, 412, path);
  assert.equal((await f.signed('StandardPullMergeService/GetStandardPullMergeOperation', { ...target, operationId: uuid() })).message, 'Merge is turned off for this repository because Pull requests are off (repository policy).');
  const features = await f.features();
  assert.deepEqual([features.actions.decidedBy, features.advice.decidedBy], ['FEATURE_DECIDER_DEPENDENCY', 'FEATURE_DECIDER_OPERATOR']);
  assert.equal(f.sql.prepare('SELECT count(*) AS n FROM discussions').get().n, 2);
});
