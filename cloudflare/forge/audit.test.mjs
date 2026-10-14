import { test } from 'node:test';
import assert from 'node:assert/strict';
import { objectFixture, tokens, origin, repository } from './object-fixture.mjs';
import { audited, auditHealth, describe } from './src/audit.mjs';

const email = 'alice@example.invalid', uuid = () => crypto.randomUUID();
const image = 'sha256:' + 'a'.repeat(64);
async function fixture(t) {
  const f = await objectFixture(t);
  Object.assign(f.env, { TEST_EXECUTION_ENABLED: 'true', TEST_IMAGE_ID: image, TEST_WORKFLOW_FORMAT: 'actions', TEST_WORKFLOW_PATH: '.github/workflows/ci.yml', TEST_POLICY_SHA256: 'a'.repeat(64), testTasks: {},
    EVIDENCE_QUEUE: { async send() {} }, EVIDENCE_QUEUE_NAME: 'evidence', EVIDENCE_WORKFLOW_NAME: 'evidence', EVIDENCE_DAILY_LIMIT: '5', ACCESS_AUD: 'access' });
  f.sql.exec(`UPDATE users SET email='${email}' WHERE id=1; UPDATE users SET email='bob@example.invalid' WHERE id=2; INSERT INTO operations_admins(user_id) VALUES(1);
    INSERT INTO native_owners(id,slug,kind,user_id,creator_id) VALUES(1,'alice','PERSONAL',1,1); INSERT INTO repository_owners(repository_id,owner_id) VALUES(1,1)`);
  // A browser request as the public Worker forwards it: no credential, the verified Access address, Cloudflare's location and a user agent.
  const signed = async (path, body = {}, who = email, extra = {}) => {
    const response = await f.dispatch(new Request(origin + path, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Connect-Protocol-Version': '1', 'X-Golf-Native-Access-Email': who,
      'X-Golf-Native-Access-Country': 'US', 'X-Golf-Native-Access-Colo': 'IAD', 'CF-Connecting-IP': '203.0.113.7', 'User-Agent': 'Mozilla/5.0 (audit test)', 'CF-Ray': '8c1f0a2b3c4d5e6f-IAD', ...extra }, body: JSON.stringify(body) }));
    const json = await response.json();
    return { status: response.status, ...json };
  };
  const rows = () => f.sql.prepare('SELECT * FROM installation_audit ORDER BY id').all().map(row => ({ ...row, client: JSON.parse(row.client) }));
  const everything = () => JSON.stringify(f.sql.prepare('SELECT * FROM installation_audit').all());
  const read = (body, who = email) => signed('/native/audit/read', { page: { page: 1, limit: 50 }, ...body }, who);
  return { ...f, signed, rows, everything, read };
}

test('a runner pool, an enrollment and a placement change are recorded with names, never the credential', async t => {
  const f = await fixture(t), poolId = uuid(), machineId = uuid();
  const pool = await f.signed('/native/runner-admin', { action: 'savePool', id: poolId, expectedVersion: 0, name: 'linux', state: 'ACTIVE', trustClass: 'UNTRUSTED', maxParallel: 2 });
  assert.equal(pool.status, 200, JSON.stringify(pool));
  const enrolled = await f.signed('/native/runner-admin', { action: 'enroll', id: machineId, poolId, poolVersion: 1, name: 'box-1', ttlHours: 4, trustExecution: true });
  assert.equal(enrolled.status, 200, JSON.stringify(enrolled));
  assert.match(enrolled.credential, /^golf_runner_/);
  const placed = await f.signed('/native/runner-placement', { action: 'set', repository, repositoryId: '1', expectedVersion: 0, poolId, poolVersion: 1 });
  assert.equal(placed.status, 200, JSON.stringify(placed));
  const rows = f.rows();
  assert.deepEqual(rows.map(row => [row.action, row.scope, row.scope_id, row.subject]), [
    ['runner_pool.create', 'installation', 'alice', 'linux'], ['runner.enroll', 'installation', 'alice', 'box-1'], ['repo.update_runner_placement', 'repository', '1', 'alice/project']]);
  assert.deepEqual(JSON.parse(rows[1].after), { machine: 'box-1', pool: 'linux', protocol: 'native', lifetimeHours: 4 });
  assert.deepEqual([JSON.parse(rows[2].before), JSON.parse(rows[2].after)], [{ pool: null }, { pool: 'linux' }]);
  assert.deepEqual(rows[1].client, { via: 'person', login: 'alice', outcome: 'success', country: 'US', colo: 'IAD', ip: '203.0.113.7', userAgent: 'Mozilla/5.0 (audit test)', requestId: '8c1f0a2b3c4d5e6f-IAD', route: '/native/runner-admin' });
  assert.equal(rows[1].actor_id, 1); assert.equal(rows[1].actor_email, email);
  // Neither the one-time credential nor its stored digest is anywhere in the log.
  const { digest } = await import('./src/common.mjs');
  assert.equal(f.everything().includes(enrolled.credential), false);
  assert.equal(f.everything().includes(await digest(enrolled.credential)), false);
  assert.equal(f.everything().includes(enrolled.credential.slice(-40)), false);
  // The same facts, as the administrator reads them.
  const log = await f.read({ scope: 'installation' });
  assert.equal(log.status, 200, JSON.stringify(log));
  assert.deepEqual(log.entries.map(entry => entry.description), ['changed runner placement from no pool to pool linux', 'enrolled runner box-1 in pool linux', 'created runner pool linux']);
  assert.deepEqual([log.entries[1].actor, log.entries[1].outcome, log.entries[1].categoryLabel, log.entries[1].client.country, log.entries[1].repository], ['alice', 'success', 'Runners', 'US', '']);
  assert.equal(log.entries[0].repository, 'alice/project');
  assert.ok(log.categories.some(category => category.id === 'runner'));
  assert.deepEqual(log.recording, auditHealth());
  assert.throws(() => f.sql.exec("UPDATE installation_audit SET action='forged'"), /append-only/);
  assert.throws(() => f.sql.exec('DELETE FROM installation_audit'), /append-only/);
});

test('a refused privileged action is recorded with who tried and why, and changes nothing', async t => {
  const f = await fixture(t);
  const denied = await f.signed('/native/runner-admin', { action: 'enroll', id: uuid(), poolId: uuid(), poolVersion: 1, name: 'rogue', ttlHours: 4, trustExecution: true }, 'bob@example.invalid');
  assert.equal(denied.status, 403);
  assert.equal(f.sql.prepare('SELECT COUNT(*) AS n FROM native_runner_machines').get().n, 0);
  const [row] = f.rows();
  assert.deepEqual([row.action, row.actor_id, row.client.outcome, row.client.code, row.client.via, row.after], ['runner.enroll', 2, 'denied', 'permission_denied', 'person', null]);
  assert.equal(describe({ action: row.action, outcome: 'denied', subject: row.subject, after: null }), 'tried to enroll runner rogue');
  // An unauthenticated caller is recorded as anonymous, not dropped.
  const anonymous = await f.dispatch(new Request(origin + '/native/runner-admin', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Connect-Protocol-Version': '1' }, body: JSON.stringify({ action: 'list' }) }));
  assert.equal(anonymous.status, 401);
  assert.deepEqual(f.rows().slice(1).map(row => [row.action, row.actor_id, row.client.via, row.client.outcome]), [['installation.access_denied', 0, 'anonymous', 'denied']]);
  // Successful reads and validation errors are not audited events.
  assert.equal((await f.signed('/native/runner-admin', { action: 'list' })).status, 200);
  assert.equal((await f.signed('/native/runner-admin', { action: 'enroll', id: 'not-a-uuid' })).status, 400);
  assert.equal(f.rows().length, 2);
  // A non-administrator cannot read the installation log and sees a refusal; the attempt is itself recorded.
  assert.equal((await f.read({ scope: 'installation' }, 'bob@example.invalid')).status, 403);
  assert.deepEqual(f.rows().map(row => [row.action, row.client.outcome]), [['runner.enroll', 'denied'], ['installation.access_denied', 'denied'], ['installation.access_denied', 'denied']]);
});

test('secret and variable values, signing secrets and endpoint paths never reach a row', async t => {
  const f = await fixture(t);
  const secretValue = 'sk-live-THE-SECRET-VALUE-9f8e7d', signing = 'whsec_' + 'q'.repeat(40), endpoint = 'https://receiver.example.com/hooks/tok_PATHTOKEN?token=QUERYTOKEN';
  const person = { id: 1, login: 'alice' };
  const call = (route, body, answer = { receipt: { state: 'SUCCEEDED' } }) => audited(new Request(origin + '/rpc/golf.v1.' + route, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Golf-Native-Access-Email': email }, body: JSON.stringify(body) }),
    f.env, async () => Response.json(answer), async () => person);
  const target = { repository, repositoryId: '1', ownerId: '1' };
  await call('RepositoryExecutionValueService/SaveRepositoryExecutionValue', { target, name: 'DEPLOY_TOKEN', kind: 'REPOSITORY_EXECUTION_VALUE_KIND_SECRET', value: secretValue, expectedVersion: '0', operationId: uuid() }, { value: { value: secretValue } });
  await call('RepositoryExecutionValueService/SaveRepositoryExecutionValue', { target, name: 'REGION', kind: 2, value: 'eu-west-1', expectedVersion: '3', operationId: uuid() });
  await call('RepositoryWebhookService/SaveRepositoryWebhook', { target, id: uuid(), name: 'ci', endpoint, signingSecret: signing, enabled: true, eventTopics: ['pushes'], expectedVersion: '0', operationId: uuid() });
  await call('GitTransportService/CreateGitCredential', { ...target, label: 'laptop', mode: 2, lifetimeSeconds: 600 }, { secret: 'golf_git_' + 'z'.repeat(43), credential: { id: '9' } });
  await call('RepositoryReleasePublicationService/SubmitRepositoryReleasePublication', { repository, repositoryId: '1', tagName: 'v1.0', title: 'One', bodyMarkdown: 'PRIVATE-NOTES', operationId: uuid() });
  const rows = f.rows();
  assert.deepEqual(rows.map(row => [row.action, row.subject]), [['repository_secret.create', 'DEPLOY_TOKEN'], ['repository_variable.update', 'REGION'], ['hook.create', 'ci'], ['git_credential.create', 'laptop'], ['release.publish', 'v1.0']]);
  assert.deepEqual(JSON.parse(rows[0].after), { name: 'DEPLOY_TOKEN', kind: 'secret' });
  assert.deepEqual(JSON.parse(rows[2].after), { name: 'ci', endpointOrigin: 'https://receiver.example.com', enabled: true, events: ['pushes'], signingSecretReplaced: true });
  for (const forbidden of [secretValue, 'eu-west-1', signing, 'PATHTOKEN', 'QUERYTOKEN', 'golf_git_', 'PRIVATE-NOTES']) assert.equal(f.everything().includes(forbidden), false, forbidden);
});

test('an audit write that fails never fails the action; it is counted and logged', async t => {
  const f = await fixture(t), before = auditHealth().failures, logged = [];
  const original = console.log; console.log = line => logged.push(String(line));
  const prepare = f.env.DB.prepare.bind(f.env.DB);
  f.env.DB.prepare = query => { if (/INSERT OR IGNORE INTO installation_audit/.test(query)) throw Error('D1 unavailable'); return prepare(query); };
  try {
    const saved = await f.signed('/native/runner-admin', { action: 'savePool', id: uuid(), expectedVersion: 0, name: 'resilient', state: 'ACTIVE', trustClass: 'UNTRUSTED', maxParallel: 1 });
    assert.equal(saved.status, 200, JSON.stringify(saved));
  } finally { console.log = original; f.env.DB.prepare = prepare; }
  assert.equal(f.sql.prepare('SELECT COUNT(*) AS n FROM native_runner_pools').get().n, 1);
  assert.equal(f.rows().length, 0);
  assert.equal(auditHealth().failures, before + 1);
  assert.ok(logged.some(line => line.includes('golf.audit_write_failed')));
});

test('a replayed operation key writes one row; batch-recorded changes are not written twice', async t => {
  const f = await fixture(t), key = uuid();
  const person = { id: 1, login: 'alice' };
  const create = () => audited(new Request(origin + '/rpc/golf.v1.RepositoryService/CreateRepository', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Golf-Native-Access-Email': email },
    body: JSON.stringify({ name: 'project', private: true, idempotencyKey: key }) }), f.env, async () => Response.json({ creation: { state: 'REPOSITORY_CREATION_STATE_SUCCEEDED' } }), async () => person);
  await create(); await create();
  assert.deepEqual(f.rows().map(row => row.action), ['repo.create']);
  // An installation policy change writes its own row in its own batch; the hook adds nothing for the success.
  const policy = await f.signed('/native/installation', { action: 'update', key: 'evidence', expectedVersion: '0', operationId: uuid(), value: { dailyLimit: 3 } });
  assert.equal(policy.status, 200, JSON.stringify(policy));
  assert.deepEqual(f.rows().map(row => row.action), ['repo.create', 'update']);
});

test('the log is read by scope: repository administrators, organization owners and operations administrators', async t => {
  const f = await fixture(t);
  f.sql.exec(`INSERT INTO native_owners(id,slug,kind,creator_id) VALUES(2,'acme','ORGANIZATION',1); INSERT INTO native_owner_members(owner_id,user_id,role) VALUES(2,1,'owner'),(2,2,'member');
    INSERT INTO repositories(id,name,description,artifact_name,creator_id,creation_key,input_hash,state,created_at) VALUES(2,'tools','','repo-${'d'.repeat(32)}',1,'second','hash','ACTIVE','2026-01-01T00:00:00.000Z');
    INSERT INTO grants VALUES(2,1,'admin'); INSERT INTO repository_owners(repository_id,owner_id) VALUES(2,2)`);
  const entry = (scope, scopeId, action, extra = {}, at = '2026-10-14T10:00:00.000Z') => f.sql.prepare('INSERT INTO installation_audit(at,actor_id,actor_email,scope,scope_id,subject,action,before,after,client) VALUES(?,?,?,?,?,?,?,?,?,?)')
    .run(at, 1, email, scope, scopeId, extra.subject || 'x', action, null, JSON.stringify(extra.after ?? null), JSON.stringify({ via: 'person', login: 'alice', outcome: extra.outcome || 'success', ...(extra.client || {}) }));
  entry('repository', '1', 'repo.update_visibility', { subject: 'alice/project', after: { public: true } });
  entry('repository', '2', 'repo.update_visibility', { subject: 'acme/tools', after: { public: false }, outcome: 'denied' });
  entry('organization', '2', 'org.create', { subject: 'acme' }, '2026-10-10T10:00:00.000Z');
  entry('installation', 'alice', 'runner.revoke', { subject: 'box-9' }, '2026-10-01T10:00:00.000Z');
  const names = body => body.entries.map(row => row.action + ':' + row.outcome);
  const bearer = (path, body, token) => f.value(path, { page: { page: 1, limit: 50 }, ...body }, token);
  assert.deepEqual(names(await f.read({ scope: 'installation' })), ['runner.revoke:success', 'org.create:success', 'repo.update_visibility:denied', 'repo.update_visibility:success']);
  assert.equal((await f.read({ scope: 'installation' })).entries[3].description, 'made the repository public');
  assert.equal((await f.read({ scope: 'installation' })).entries[2].description, 'tried to change the visibility of the repository');
  // Repository scope: that repository's rows only, for its administrators only.
  const repo = await bearer('/native/audit/read', { scope: 'repository', repository, repositoryId: '1' }, tokens.admin);
  assert.deepEqual(names(repo), ['repo.update_visibility:success']); assert.equal(repo.scope.label, 'alice/project');
  assert.equal((await bearer('/native/audit/read', { scope: 'repository', repository, repositoryId: '1' }, tokens.writer)).status, 403);
  assert.equal((await bearer('/native/audit/read', { scope: 'repository', repository, repositoryId: '1' }, tokens.outsider)).status, 404);
  // Organization scope: its own rows and those of the repositories it owns; members who are not owners are refused.
  assert.deepEqual(names(await f.read({ scope: 'organization', organization: 'acme' })), ['org.create:success', 'repo.update_visibility:denied']);
  assert.equal((await f.read({ scope: 'organization', organization: 'acme' }, 'bob@example.invalid')).status, 403);
  // Filters apply to the whole log.
  assert.deepEqual(names(await f.read({ scope: 'installation', filters: { outcome: 'denied' } })), ['repo.update_visibility:denied']);
  assert.deepEqual(names(await f.read({ scope: 'installation', filters: { category: 'runner' } })), ['runner.revoke:success']);
  assert.deepEqual(names(await f.read({ scope: 'installation', filters: { repository: 'acme/tools' } })), ['repo.update_visibility:denied']);
  assert.deepEqual(names(await f.read({ scope: 'installation', filters: { from: '2026-10-05', to: '2026-10-14' } })), ['org.create:success', 'repo.update_visibility:denied', 'repo.update_visibility:success']);
  assert.deepEqual(names(await f.read({ scope: 'installation', filters: { query: 'box-9' } })), ['runner.revoke:success']);
  assert.deepEqual(names(await f.read({ scope: 'installation', filters: { actor: 'alice', query: '100%_' } })), []);
  assert.equal((await f.read({ scope: 'installation', filters: { category: 'nonsense' } })).status, 400);
  assert.equal((await f.read({ scope: 'installation', filters: { from: 'yesterday' } })).status, 400);
  const paged = await f.read({ scope: 'installation', page: { page: 1, limit: 3 } });
  assert.deepEqual([paged.entries.length, paged.page.nextPage], [3, 2]);
});

test('runner registration tokens, runner edits and pipeline actions are recorded without tokens, input values or comments', async t => {
  const f = await fixture(t);
  Object.assign(f.env, { PIPELINES_ENABLED: 'true', PIPELINE_BUCKET: {} });
  f.sql.exec("INSERT INTO pipeline_runners(id,uuid,engine,scope,scope_id,name,labels,token_digest,state,created_by,created_at) VALUES(7,'u-7','gitlab-ci','installation','','builder','[\"docker\"]','d7','ACTIVE',1,'2026-10-14T00:00:00Z')");
  const created = await f.signed('/native/pipeline-runners', { scope: 'installation', action: 'createToken', engine: 'gitlab-ci', labels: ['docker', 'gpu'], ttlHours: 4, uses: 2 });
  assert.equal(created.status, 200, JSON.stringify(created)); assert.match(created.token, /^golfreg_/);
  const revoked = await f.signed('/native/pipeline-runners', { scope: 'installation', action: 'revokeToken', id: created.registration.id });
  assert.equal(revoked.status, 200, JSON.stringify(revoked));
  const updated = await f.signed('/native/pipeline-runners', { scope: 'installation', action: 'update', id: '7', state: 'DISABLED', labels: ['docker'] });
  assert.equal(updated.status, 200, JSON.stringify(updated));
  const deleted = await f.signed('/native/pipeline-runners', { scope: 'installation', action: 'delete', id: '7' });
  assert.equal(deleted.status, 200, JSON.stringify(deleted));
  const denied = await f.signed('/native/pipeline-runners', { scope: 'installation', action: 'createToken', engine: 'forgejo-actions', labels: [], ttlHours: 1, uses: 1 }, 'bob@example.invalid');
  assert.equal(denied.status, 403);
  const rows = f.rows();
  assert.deepEqual(rows.map(row => [row.action, row.scope, row.subject, row.client.outcome]), [
    ['pipeline_runner.token_create', 'installation', 'gitlab-ci', 'success'], ['pipeline_runner.token_revoke', 'installation', created.registration.id, 'success'],
    ['pipeline_runner.update', 'installation', 'builder', 'success'], ['pipeline_runner.delete', 'installation', 'builder', 'success'], ['pipeline_runner.token_create', 'installation', 'forgejo-actions', 'denied']]);
  assert.deepEqual(JSON.parse(rows[0].after), { engine: 'gitlab-ci', labels: ['docker', 'gpu'], ttlHours: 4, uses: 2 });
  assert.deepEqual([JSON.parse(rows[2].before), JSON.parse(rows[2].after)], [{ name: 'builder', state: 'ACTIVE', labels: ['docker'] }, { labels: ['docker'], state: 'DISABLED' }]);
  assert.equal(f.everything().includes(created.token), false);
  assert.equal(f.everything().includes(created.token.slice(-24)), false);
  const log = await f.read({ scope: 'installation' });
  assert.equal(log.status, 200, JSON.stringify(log));
  assert.deepEqual(log.entries.map(entry => entry.description).reverse().slice(0, 4), ['created a GitLab runner registration token', 'revoked a runner registration token', 'updated runner builder', 'deleted runner builder']);
  assert.ok(log.categories.some(category => category.id === 'pipeline_runner'));
});

test('pipeline dispatch, cancel, approval and environment changes are recorded as counts and names only', async t => {
  const f = await fixture(t);
  Object.assign(f.env, { PIPELINES_ENABLED: 'true', PIPELINE_BUCKET: {}, EXECUTION_VALUE_KEY: { get: async () => btoa(String.fromCharCode(...new Uint8Array(32).fill(7))) } });
  const call = body => f.signed('/native/pipelines', { repository, repositoryId: '1', ...body });
  // Each handler may refuse (no run, no workflow): the audit row records the attempt and its outcome either way.
  await call({ action: 'dispatch', workflowPath: '.github/workflows/ci.yml', ref: 'main', inputs: { note: 'super-secret-input-value' } });
  await call({ action: 'cancel', runId: '41' });
  await call({ action: 'rerun', runId: '41', failedOnly: true });
  await call({ action: 'approve', jobId: '52', approve: true, comment: 'private reviewer remark' });
  await call({ action: 'approve', jobId: '53', approve: false, comment: 'another private remark' });
  await call({ action: 'saveEnvironment', name: 'production', reviewers: ['alice'], branches: ['main'], url: 'https://example.invalid', preventSelfReview: true, expectedVersion: 0 });
  await call({ action: 'saveEnvironmentValue', environmentId: '1', name: 'KUBECONFIG', kind: 'secret', value: 'kubeconfig-contents-that-must-not-appear' });
  const rows = f.rows();
  assert.deepEqual(rows.map(row => [row.action, row.scope, row.subject]), [
    ['actions.dispatch', 'repository', '.github/workflows/ci.yml'], ['actions.cancel', 'repository', '41'], ['actions.rerun', 'repository', '41'], ['actions.approve_deployment', 'repository', '52'],
    ['actions.reject_deployment', 'repository', '53'], ['environment.save', 'repository', 'production'], ['environment.save_value', 'repository', 'KUBECONFIG']]);
  assert.ok(rows.every(row => ['success', 'refused', 'denied', 'unknown'].includes(row.client.outcome)));
  const text = f.everything();
  for (const secret of ['super-secret-input-value', 'private reviewer remark', 'another private remark', 'kubeconfig-contents-that-must-not-appear']) assert.equal(text.includes(secret), false, secret);
});
