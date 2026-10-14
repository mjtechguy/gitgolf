import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFile, readdir } from 'node:fs/promises';
import { handle, digest, concurrentRead } from './src/core.mjs';
import { emailPolicy, emailBindings, emailMethods, drainEmail } from './src/email.mjs';
import { runMaintenance } from './src/operations.mjs';

const origin = 'https://golf.example.com', sender = 'golf@mail.golf.example.com';
const target = { repository: { owner: 'alice', name: 'project' }, repositoryId: '1', ownerId: '1' };
const topics = ['source', 'issues', 'pulls', 'actions'];
async function fixture(t, dailyLimit = 100) {
  const sql = new DatabaseSync(':memory:'); t.after(() => sql.close());
  sql.exec(await readFile(new URL('./schema.sql', import.meta.url), 'utf8'));
  sql.exec(`INSERT INTO users(id,login,email,can_create) VALUES(1,'alice','alice@example.com',1),(2,'bob','bob@example.com',0),(3,'carol','carol@example.com',0);
    INSERT INTO workspaces(slug,artifact_namespace) VALUES('alice','test-space');
    INSERT INTO repositories(id,name,description,artifact_name,creator_id,creation_key,input_hash,state,created_at) VALUES(1,'project','','artifact-1',1,'key','hash','ACTIVE','2026-01-01T00:00:00.000Z');
    INSERT INTO grants VALUES(1,1,'admin'),(1,2,'read');`);
  const f = { sql, sent: [], afterClaim: null, provider: async () => ({ messageId: '<' + crypto.randomUUID() + '@provider.example>' }) };
  const db = {
    withSession() { return this; },
    prepare(query) { let values = []; const statement = sql.prepare(query); return { query,
      bind(...args) { values = args; return this; },
      execute() { return query.startsWith('SELECT') ? { results: statement.all(...values) } : { meta: { changes: statement.run(...values).changes } }; },
      async first() { return statement.get(...values) || null; },
      async all() { return { results: statement.all(...values) }; },
      async run() { return { meta: { changes: statement.run(...values).changes } }; },
    }; },
    // One implicit transaction per batch, as D1 runs it; nothing interleaves.
    async batch(statements) {
      sql.exec('BEGIN'); let results;
      try { results = statements.map(statement => statement.execute()); sql.exec('COMMIT'); }
      catch (error) { sql.exec('ROLLBACK'); throw error; }
      // A window between the committed claim and the provider call, for revocations that race a send.
      if (statements[0].query.includes('email_daily') && f.afterClaim) { const action = f.afterClaim; f.afterClaim = null; action(); }
      return results;
    },
  };
  f.env = { DB: db, ACCOUNT_ID: 'c'.repeat(32), ARTIFACTS_NAMESPACE: 'test-space', WORKSPACE_SLUG: 'alice', PUBLIC_ORIGIN: origin, ACCESS_AUD: 'aud',
    EMAIL_POLICY: JSON.stringify({ sender, dailyLimit }), EMAIL: { async send(message) { f.sent.push(message); return f.provider(message); } } };
  f.request = (path, body = {}, email = 'alice@example.com', headers = {}) => handle(new Request(origin + path, { method: 'POST', body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json', 'Connect-Protocol-Version': '1', ...(email ? { 'X-Golf-Native-Access-Email': email } : {}), ...headers } }), f.env);
  f.call = (method, body, email, headers) => f.request('/rpc/golf.v1.EmailNotificationService/' + method, body, email, headers);
  f.value = async response => { const body = await response.json(); assert.equal(response.status, 200, JSON.stringify(body)); return body; };
  f.own = async email => (await f.value(await f.call('GetOwnEmailNotifications', {}, email))).state;
  f.enable = async (email, enabled = true) => { const state = await f.own(email);
    return (await f.value(await f.call('SaveOwnEmailPreference', { expectedContactVersion: state.contactVersion, expectedPreferenceVersion: state.preferenceVersion, enabled, authorizeBackground: enabled }, email))).state; };
  f.subscribe = async (email, extra = {}) => { const current = await f.value(await f.call('GetRepositoryEmailSubscription', { target }, email));
    return (await f.value(await f.call('SaveRepositoryEmailSubscription', { target, id: current.subscription?.id || crypto.randomUUID(), expectedVersion: current.subscription?.version || '0', expectedContactVersion: current.state.contactVersion, eventTopics: topics, enabled: true, authorizeBackground: true, ...extra }, email))).subscription; };
  f.push = () => { const id = crypto.randomUUID(); sql.prepare("INSERT INTO git_operations(id,repository_id,user_id,ref,old_sha,new_sha,state,created_at) VALUES(?,1,1,'refs/heads/private-branch-name',?,?,'DISPATCHED','2026-01-01')").run(id, '0'.repeat(40), 'a'.repeat(40)); sql.prepare("UPDATE git_operations SET state='APPLIED' WHERE id=?").run(id); return id; };
  f.deliveries = () => sql.prepare('SELECT * FROM email_deliveries ORDER BY rowid').all();
  f.capability = async () => (await f.value(await f.request('/rpc/golf.v1.CapabilityService/ListCapabilities'))).capabilities.find(c => c.id === 'repository.email-notifications');
  f.history = async email => (await f.value(await f.call('ListOwnEmailDeliveries', { target }, email))).deliveries;
  return f;
}
const ready = async t => { const f = await fixture(t); await f.enable(); await f.subscribe(); return f; };

test('email capability is disabled without the binding, degraded when configured and ready only after a recorded acceptance', async t => {
  const f = await fixture(t), { EMAIL, EMAIL_POLICY } = f.env;
  for (const patch of [{ EMAIL: undefined }, { EMAIL_POLICY: undefined }, { ACCESS_AUD: '' }, { EMAIL_POLICY: JSON.stringify({ sender, dailyLimit: 0 }) }, { EMAIL_POLICY: JSON.stringify({ sender: 'Golf <golf@example.com>', dailyLimit: 5 }) },
    { EMAIL_POLICY: JSON.stringify({ sender, dailyLimit: 5, recipients: ['other@example.com'] }) }]) {
    Object.assign(f.env, { EMAIL, EMAIL_POLICY, ACCESS_AUD: 'aud' }, patch);
    assert.equal(emailPolicy(f.env), null); assert.equal((await f.capability()).state, 'CAPABILITY_STATE_DISABLED');
    assert.equal((await f.call('GetOwnEmailNotifications')).status, 412);
  }
  Object.assign(f.env, { EMAIL, EMAIL_POLICY, ACCESS_AUD: 'aud' });
  let capability = await f.capability();
  assert.equal(capability.state, 'CAPABILITY_STATE_DEGRADED'); assert.match(capability.reason, /from golf@mail\.golf\.example\.com\..*At most 100 send attempts per day\..*has not yet accepted/);
  // Consent, a subscription and even a failed send do not make it ready.
  await f.enable(); await f.subscribe(); f.push(); f.provider = async () => { throw Object.assign(Error('private provider text'), { code: 'E_SENDER_NOT_VERIFIED' }); };
  await drainEmail(f.env); assert.equal((await f.capability()).state, 'CAPABILITY_STATE_DEGRADED');
  // Neither does a send the provider answered without its message identifier.
  f.push(); f.provider = async () => ({}); await drainEmail(f.env);
  assert.deepEqual(f.deliveries().map(d => [d.state, d.failure_code, d.possible_duplicate]), [['failed', 'sender_unavailable', 0], ['failed', 'acceptance_unconfirmed', 1]]);
  assert.equal((await f.capability()).state, 'CAPABILITY_STATE_DEGRADED'); assert.ok(!JSON.stringify(f.deliveries()).includes('private provider text'));
  f.push(); f.provider = async () => ({ messageId: 'provider-message-1' }); await drainEmail(f.env);
  capability = await f.capability(); assert.equal(capability.state, 'CAPABILITY_STATE_READY'); assert.match(capability.reason, /first accepted a message from this sender on \d{4}-\d\d-\d\d\.$/);
  assert.deepEqual({ ...f.sql.prepare('SELECT sender,delivery_id FROM email_acceptance').get() }, { sender, delivery_id: f.deliveries().find(d => d.state === 'accepted').id });
  // Acceptance is recorded for one sender; another address has to earn its own.
  f.env.EMAIL_POLICY = JSON.stringify({ sender: 'other@mail.golf.example.com', dailyLimit: 100 }); assert.equal((await f.capability()).state, 'CAPABILITY_STATE_DEGRADED');
  f.sql.exec('DROP TABLE email_acceptance'); capability = await f.capability(); assert.equal(capability.state, 'CAPABILITY_STATE_DISABLED'); assert.match(capability.reason, /schema is not applied/);
});

test('SMTP transport and verification methods are refused as unimplemented and reads overlap', async t => {
  const f = await fixture(t);
  for (const method of ['ListEmailTransports', 'SaveEmailTransport', 'ActivateEmailTransport', 'DeactivateEmailTransport', 'RequestEmailVerification', 'ConfirmEmailVerification', 'Unknown']) {
    const response = await f.call(method, { operationId: crypto.randomUUID(), expectedContactVersion: '1' }); assert.equal(response.status, 501, method); assert.equal((await response.json()).code, 'unimplemented');
  }
  const proto = await readFile(new URL('../../api/golf/v1/golf.proto', import.meta.url), 'utf8'), service = /service EmailNotificationService \{([^}]*)\}/.exec(proto)[1];
  for (const method of emailMethods) assert.ok(service.includes(' rpc ' + method + '('), method);
  for (const [method, read] of [['GetOwnEmailNotifications', true], ['GetRepositoryEmailSubscription', true], ['ListOwnEmailDeliveries', true], ['SaveOwnEmailPreference', false], ['SaveRepositoryEmailSubscription', false], ['RedeliverOwnEmail', false]])
    assert.equal(concurrentRead(new Request(origin + '/rpc/golf.v1.EmailNotificationService/' + method, { method: 'POST' })), read, method);
  assert.equal(f.sql.prepare('SELECT COUNT(*) n FROM email_deliveries').get().n, 0); assert.equal(f.sent.length, 0);
});

test('only a verified Access sign-in reads or enables email; bearer and service-token callers cannot', async t => {
  const f = await fixture(t), token = 'golf_native_' + 'a'.repeat(43);
  f.sql.prepare('INSERT INTO credentials VALUES(?,?,?,0)').run(await digest(token), 1, Math.floor(Date.now() / 1000) + 300);
  const save = { expectedContactVersion: '1', expectedPreferenceVersion: '0', enabled: true, authorizeBackground: true };
  for (const [email, headers] of [['', { Authorization: 'Bearer ' + token }], ['alice@example.com', { Authorization: 'Bearer ' + token }], ['alice@example.com', { 'CF-Access-Client-Id': 'service' }], ['alice@example.com', { 'CF-Access-Client-Secret': 'secret' }]]) {
    for (const [method, body] of [['GetOwnEmailNotifications', {}], ['SaveOwnEmailPreference', save], ['GetRepositoryEmailSubscription', { target }], ['SaveRepositoryEmailSubscription', { target, id: crypto.randomUUID(), expectedVersion: '0', expectedContactVersion: '1', eventTopics: topics, enabled: true, authorizeBackground: true }], ['ListOwnEmailDeliveries', { target }], ['RedeliverOwnEmail', { deliveryId: crypto.randomUUID(), operationId: crypto.randomUUID(), expectedContactVersion: '1' }]]) {
      const response = await f.call(method, body, email, headers); assert.equal(response.status, 403, method); assert.equal((await response.json()).code, 'permission_denied');
    }
  }
  assert.equal((await f.call('GetOwnEmailNotifications', {}, '')).status, 401); assert.equal((await f.call('GetOwnEmailNotifications', {}, 'stranger@example.com')).status, 401);
  assert.equal(f.sql.prepare('SELECT COUNT(*) n FROM email_preferences').get().n + f.sql.prepare('SELECT COUNT(*) n FROM email_subscriptions').get().n, 0);
  // An account whose sign-in address is not one plain mailbox cannot become a recipient.
  f.sql.prepare("UPDATE users SET email='carol@example.com, victim@example.com' WHERE id=3").run();
  assert.equal((await f.call('GetOwnEmailNotifications', {}, 'carol@example.com, victim@example.com')).status, 412);
});

test('own state reports the Access address without inventing local-account, SMTP or verification fields', async t => {
  const f = await fixture(t), state = await f.own();
  assert.deepEqual(state, { userId: '1', nativeUserId: '1', contactVersion: '1', loginEmail: 'alice@example.com', verified: true, enabled: false, suppression: '', transportActive: true, preferenceVersion: '0' });
  assert.deepEqual(await f.value(await f.call('ListOwnEmailDeliveries', {})), { deliveries: [], page: { nextPage: 0 }, userId: '1' });
});

test('own preference needs explicit consent and exact contact and preference versions', async t => {
  const f = await fixture(t), save = body => f.call('SaveOwnEmailPreference', { expectedContactVersion: '1', expectedPreferenceVersion: '0', enabled: true, authorizeBackground: true, ...body });
  assert.equal((await save({ authorizeBackground: false })).status, 400); assert.equal((await save({ enabled: 'yes' })).status, 400); assert.equal((await save({ expectedPreferenceVersion: '-1' })).status, 400);
  assert.equal((await save({ expectedContactVersion: '2' })).status, 412); assert.equal((await save({ expectedPreferenceVersion: '1' })).status, 412);
  // Two saves from the same observation: exactly one wins.
  const results = await Promise.all([save(), save()]); assert.deepEqual(results.map(r => r.status).sort(), [200, 412]);
  let state = await f.own(); assert.equal(state.enabled, true); assert.equal(state.preferenceVersion, '1');
  assert.equal((await save()).status, 412);
  state = (await f.value(await save({ expectedPreferenceVersion: '1', enabled: false, authorizeBackground: false }))).state; assert.equal(state.enabled, false); assert.equal(state.preferenceVersion, '2');
  // An operator changing the address invalidates the stored consent; nothing carries over to the new mailbox.
  await f.value(await save({ expectedPreferenceVersion: '2' })); f.sql.exec("UPDATE users SET email='alice@new.example.com' WHERE id=1");
  state = await f.own('alice@new.example.com'); assert.deepEqual([state.loginEmail, state.enabled, state.contactVersion, state.preferenceVersion], ['alice@new.example.com', false, '2', '3']);
  assert.equal((await f.call('SaveOwnEmailPreference', { expectedContactVersion: '1', expectedPreferenceVersion: '3', enabled: true, authorizeBackground: true }, 'alice@new.example.com')).status, 412);
  assert.equal((await f.call('GetOwnEmailNotifications', {}, 'alice@example.com')).status, 401);
});

test('repository subscriptions compare and swap, need a current grant and enabled own email, and are bounded', async t => {
  const f = await fixture(t), id = crypto.randomUUID();
  const save = (body, email) => f.call('SaveRepositoryEmailSubscription', { target, id, expectedVersion: '0', expectedContactVersion: '1', eventTopics: ['issues', 'source'], enabled: true, authorizeBackground: true, ...body }, email);
  assert.deepEqual(Object.keys(await f.value(await f.call('GetRepositoryEmailSubscription', { target }))).sort(), ['state', 'target']);
  // Enabling needs the account-level consent first; a disabled draft does not.
  assert.equal((await save()).status, 412); await f.enable();
  for (const patch of [{ id: 'not-a-uuid' }, { eventTopics: [] }, { eventTopics: ['issues', 'issues'] }, { eventTopics: ['agents'] }, { authorizeBackground: false }, { workflowNotifications: 9 }, { expectedVersion: 'x' }]) assert.equal((await save(patch)).status, 400, JSON.stringify(patch));
  assert.equal((await save({ expectedVersion: '1' })).status, 412); assert.equal((await save({ expectedContactVersion: '2' })).status, 412);
  for (const wrong of [{ ...target, repositoryId: '2' }, { ...target, ownerId: '9' }, { ...target, repository: { owner: 'bob', name: 'project' } }]) assert.equal((await save({ target: wrong })).status, 404);
  const results = await Promise.all([save(), save()]); assert.deepEqual(results.map(r => r.status).sort(), [200, 412]);
  let subscription = (await f.value(await f.call('GetRepositoryEmailSubscription', { target }))).subscription;
  assert.deepEqual({ ...subscription, updatedAt: '' }, { id, version: '1', eventTopics: ['issues', 'source'], enabled: true, authorizationState: 'authorized', contactVersion: '1', updatedAt: '', workflowNotifications: 1 });
  // One subscription per account and repository: a second identity or a replayed version is refused.
  assert.equal((await save({ id: crypto.randomUUID() })).status, 412); assert.equal((await save()).status, 412);
  subscription = (await f.value(await save({ expectedVersion: '1', eventTopics: ['actions'], workflowNotifications: 'WORKFLOW_NOTIFICATION_MODE_FAILURES', enabled: false, authorizeBackground: false }))).subscription;
  assert.deepEqual([subscription.version, subscription.enabled, subscription.authorizationState, subscription.workflowNotifications], ['2', false, 'disabled', 3]);
  // A reader may subscribe for themself; an account without a grant cannot, and learns nothing.
  await f.enable('bob@example.com'); const bob = await f.subscribe('bob@example.com'); assert.equal(bob.enabled, true); assert.notEqual(bob.id, id);
  assert.equal((await f.call('GetRepositoryEmailSubscription', { target }, 'carol@example.com')).status, 404); assert.equal((await save({ id: crypto.randomUUID() }, 'carol@example.com')).status, 404);
  assert.equal((await f.call('ListOwnEmailDeliveries', { target }, 'carol@example.com')).status, 404);
  // Admission bounds count retained subscriptions.
  f.sql.exec("INSERT INTO users(id,login,email) VALUES(4,'dave','dave@example.com'); INSERT INTO grants VALUES(1,4,'read')");
  await f.enable('dave@example.com');
  const row = f.sql.prepare("INSERT INTO email_subscriptions(id,user_id,repository_id,artifact_name,version,event_topics,workflow_notifications,enabled,identity_version,grant_generation,created_at,updated_at) VALUES(?,?,?,?,1,'[\"source\"]',1,0,0,0,'2026','2026')");
  f.sql.exec('BEGIN'); for (let n = 2; n < 500; n++) { f.sql.prepare("INSERT INTO repositories(id,name,description,artifact_name,creator_id,creation_key,input_hash,state,created_at) VALUES(?,?,'',?,1,?,'hash','ACTIVE','2026')").run(n, 'r' + n, 'a' + n, 'k' + n); }
  f.sql.exec('COMMIT');
  // 498 further rows on this repository reach its bound of 500 with alice and bob.
  f.sql.exec('BEGIN'); for (let n = 100; n < 598; n++) { f.sql.prepare("INSERT INTO users(id,login,email) VALUES(?,?,?)").run(n, 'u' + n, 'u' + n + '@example.com'); row.run('s' + n, n, 1, 'artifact-1'); }
  f.sql.exec('COMMIT');
  assert.equal((await save({ id: crypto.randomUUID() }, 'dave@example.com')).status, 412);
  f.sql.exec("DELETE FROM email_subscriptions WHERE id='s100'"); assert.equal((await save({ id: crypto.randomUUID() }, 'dave@example.com')).status, 200);
  // And 100 per account.
  f.sql.exec("DELETE FROM email_subscriptions WHERE user_id=4");
  f.sql.exec('BEGIN'); for (let n = 2; n < 102; n++) row.run('own' + n, 4, n, 'a' + n); f.sql.exec('COMMIT');
  assert.equal((await save({ id: crypto.randomUUID() }, 'dave@example.com')).status, 412);
});

test('the outbox captures committed source, discussion and test transitions per topic and bounds each account', async t => {
  const f = await ready(t);
  f.push();
  await f.value(await f.request('/rpc/golf.v1.RepositoryService/CreateIssue', { repository: target.repository, repositoryId: '1', title: 'PRIVATE TITLE', body: 'PRIVATE BODY', idempotencyKey: crypto.randomUUID() }));
  const time = new Date().toISOString(), job = crypto.randomUUID();
  f.sql.prepare("INSERT INTO evidence_jobs(id,repository_id,user_id,operation_key,input_hash,snapshot,advice_state,test_state,created_at,updated_at,expires_at) VALUES(?,1,1,?,'hash','{\"log\":\"PRIVATE LOG\"}','NONE','REQUESTED',?,?,?)").run(job, crypto.randomUUID(), time, time, time);
  f.sql.prepare("UPDATE evidence_jobs SET test_state='PASSED' WHERE id=?").run(job);
  let rows = f.deliveries(); assert.deepEqual(rows.map(d => d.event_topic).sort(), ['actions', 'actions', 'issues', 'source']);
  assert.ok(rows.every(d => d.user_id === 1 && d.repository_id === 1 && d.state === 'queued' && d.subscription_version === 1 && /^[a-f0-9-]{36}$/.test(d.id)));
  assert.ok(!JSON.stringify(rows).match(/PRIVATE|private-branch-name|alice@example\.com/));
  // A rolled-back activity leaves no message behind.
  f.sql.exec('BEGIN'); f.sql.prepare("UPDATE evidence_jobs SET test_state='FAILED' WHERE id=?").run(job); f.sql.exec('ROLLBACK'); assert.equal(f.deliveries().length, 4);
  // Topic and workflow filters; bob follows issues only.
  await f.enable('bob@example.com'); await f.subscribe('bob@example.com', { eventTopics: ['issues'] });
  await f.subscribe('alice@example.com', { eventTopics: ['actions'], workflowNotifications: 3 });
  f.push(); assert.equal(f.deliveries().length, 4);
  f.sql.prepare("UPDATE evidence_jobs SET test_state='CANCELLED' WHERE id=?").run(job); assert.equal(f.deliveries().length, 4);
  f.sql.prepare("UPDATE evidence_jobs SET test_state='FAILED' WHERE id=?").run(job); assert.equal(f.deliveries().length, 5);
  await f.value(await f.request('/rpc/golf.v1.RepositoryService/CreateIssue', { repository: target.repository, repositoryId: '1', title: 'Second', body: '', idempotencyKey: crypto.randomUUID() }));
  rows = f.deliveries(); assert.equal(rows.length, 6); assert.deepEqual([rows.at(-1).user_id, rows.at(-1).event_topic], [2, 'issues']);
  // At most 200 messages wait per account; further activity is not queued for it.
  const insert = f.sql.prepare("INSERT INTO email_deliveries(id,subscription_id,subscription_version,user_id,repository_id,identity_version,event_id,event_topic,automatic_key,next_attempt_at,created_at) SELECT ?,id,version,user_id,1,0,?,'issues',?,'2999','2026' FROM email_subscriptions WHERE user_id=2");
  f.sql.exec('BEGIN'); for (let n = 0; n < 199; n++) insert.run(crypto.randomUUID(), 'fill:' + n, 'fill:' + n); f.sql.exec('COMMIT');
  await f.value(await f.request('/rpc/golf.v1.RepositoryService/CreateIssue', { repository: target.repository, repositoryId: '1', title: 'Third', body: '', idempotencyKey: crypto.randomUUID() }));
  assert.equal(f.sql.prepare("SELECT COUNT(*) n FROM email_deliveries WHERE user_id=2").get().n, 200);
});

test('a message goes only to the account\'s own address and carries a category and links, never titles, bodies, source or logs', async t => {
  const f = await ready(t);
  await f.enable('bob@example.com'); await f.subscribe('bob@example.com', { eventTopics: ['issues'] });
  f.push();
  await f.value(await f.request('/rpc/golf.v1.RepositoryService/CreateIssue', { repository: target.repository, repositoryId: '1', title: 'PRIVATE TITLE', body: 'PRIVATE BODY', idempotencyKey: crypto.randomUUID() }));
  const time = new Date().toISOString();
  f.sql.prepare("INSERT INTO evidence_jobs(id,repository_id,user_id,operation_key,input_hash,snapshot,advice_state,test_state,created_at,updated_at,expires_at) VALUES(?,1,1,?,'hash','{\"log\":\"PRIVATE LOG\"}','NONE','REQUESTED',?,?,?)").run(crypto.randomUUID(), crypto.randomUUID(), time, time, time);
  f.sql.exec("INSERT INTO discussions(id,repository_id,number,kind,author_id,title,body,state,created_at,updated_at) VALUES(90,1,90,'pull','1','PRIVATE PULL','PRIVATE BODY','OPEN','2026','2026'); INSERT INTO discussion_events VALUES('pull-event',90,1,'commented','{\"body\":\"PRIVATE COMMENT\"}','2026')");
  const result = await drainEmail(f.env); assert.deepEqual(result, { processed: 5, pending: 0 });
  const byUser = email => f.sent.filter(m => m.to === email);
  assert.equal(byUser('alice@example.com').length, 4); assert.equal(byUser('bob@example.com').length, 1); assert.equal(f.sent.length, 5);
  for (const message of f.sent) {
    // Exactly these fields: no cc, bcc, reply-to, html, attachments or caller-set Message-ID.
    assert.deepEqual(Object.keys(message).sort(), ['from', 'headers', 'subject', 'text', 'to']); assert.equal(message.from, sender); assert.equal(typeof message.to, 'string');
    assert.deepEqual(Object.keys(message.headers), ['X-Golf-Delivery-ID']); assert.ok(f.deliveries().some(d => d.id === message.headers['X-Golf-Delivery-ID']));
    assert.ok(!JSON.stringify(message).match(/PRIVATE|private-branch-name|refs\/heads|[a-f0-9]{40}|discussion:|carol|bob@example\.com.*alice@example\.com/));
  }
  const expected = { source: ['Code changed', ''], issues: ['Issues changed', '/issues'], pulls: ['Pull requests changed', '/pulls'], actions: ['Checks changed', '/actions'] };
  for (const d of f.deliveries().filter(d => d.user_id === 1)) {
    const message = f.sent.find(m => m.headers['X-Golf-Delivery-ID'] === d.id), [label, path] = expected[d.event_topic];
    assert.equal(message.subject, '[alice/project] ' + label);
    assert.equal(message.text, `${label} in alice/project.\n\nSign in to view: ${origin}/alice/project${path}\n\nYou subscribed to email about this repository. Change or stop it: ${origin}/alice/project/settings/webhooks\n`);
  }
  // History is the owner's own, shows provider acceptance and never an SMTP status or transport.
  const history = await f.history(); assert.equal(history.length, 4);
  for (const d of history) { assert.deepEqual([d.kind, d.state, d.attempts, d.contactVersion, d.subscriptionVersion], ['activity', 'accepted', 1, '1', '1']); for (const key of ['smtpStatus', 'transportId', 'transportVersion', 'possibleDuplicate']) assert.ok(!d[key], key); }
  assert.equal((await f.history('bob@example.com')).length, 1);
  assert.ok(f.deliveries().every(d => d.sender === sender && d.provider_message_id.endsWith('@provider.example>') && d.state === 'accepted'));
  assert.equal((await drainEmail(f.env)).processed, 0); assert.equal(f.sent.length, 5);
  // A repository under a named owner is linked under that owner.
  f.sql.exec("INSERT INTO native_owners(id,slug,kind,creator_id) VALUES(7,'acme','ORGANIZATION',1); INSERT INTO repository_owners VALUES(1,7)");
  f.push(); await drainEmail(f.env); assert.equal(f.sent.at(-1).subject, '[acme/project] Code changed'); assert.ok(f.sent.at(-1).text.includes(origin + '/acme/project\n'));
});

test('access revoked between enqueue and send cancels the delivery, across grant ABA and inside the claim window', async t => {
  const f = await ready(t); await f.enable('bob@example.com'); await f.subscribe('bob@example.com', { eventTopics: ['source'] });
  f.push(); f.sql.exec('DELETE FROM grants WHERE user_id=2');
  await drainEmail(f.env); assert.deepEqual(f.sent.map(m => m.to), ['alice@example.com']);
  assert.deepEqual(f.deliveries().filter(d => d.user_id === 2).map(d => [d.state, d.failure_code, d.attempts]), [['cancelled', 'authority_changed', 0]]);
  // Restoring the grant does not adopt the old consent; the subscription reads as paused until it is saved again.
  f.sql.exec("INSERT INTO grants VALUES(1,2,'write')"); f.push(); await drainEmail(f.env); assert.equal(f.sent.filter(m => m.to === 'bob@example.com').length, 0);
  let subscription = (await f.value(await f.call('GetRepositoryEmailSubscription', { target }, 'bob@example.com'))).subscription; assert.deepEqual([subscription.enabled, subscription.authorizationState], [false, 'authority_unavailable']);
  subscription = await f.subscribe('bob@example.com', { eventTopics: ['source'] }); assert.equal(subscription.authorizationState, 'authorized');
  // Revocation after the delivery was claimed, immediately before the provider call.
  f.push(); const before = f.sent.length; f.afterClaim = () => f.sql.exec('DELETE FROM grants WHERE user_id=1');
  await drainEmail(f.env);
  assert.equal(f.sent.slice(before).filter(m => m.to === 'alice@example.com').length, 0);
  assert.deepEqual(f.deliveries().filter(d => d.user_id === 1).at(-1).state, 'cancelled'); assert.equal(f.deliveries().filter(d => d.user_id === 1).at(-1).lease, null);
  // The revoked reader can no longer read history for the repository.
  assert.equal((await f.call('ListOwnEmailDeliveries', { target })).status, 404);
  assert.equal((await f.call('RedeliverOwnEmail', { deliveryId: f.deliveries().find(d => d.user_id === 1).id, operationId: crypto.randomUUID(), expectedContactVersion: '1' })).status, 404);
});

test('a deactivated account, a changed address, withdrawn consent or an edited subscription all cancel queued mail', async t => {
  const f = await ready(t);
  f.push(); f.sql.exec('UPDATE users SET active=0 WHERE id=1'); await drainEmail(f.env);
  assert.equal(f.sent.length, 0); assert.deepEqual(f.deliveries().map(d => d.state), ['cancelled']);
  // Reactivation is a new identity version: old consent stays void.
  f.sql.exec('UPDATE users SET active=1 WHERE id=1'); f.push(); await drainEmail(f.env); assert.equal(f.sent.length, 0);
  assert.equal((await f.own()).enabled, false); await f.enable(); await f.subscribe();
  f.push(); await drainEmail(f.env); assert.equal(f.sent.length, 1);
  // The operator changes the address while a message waits: it is not sent to either mailbox.
  f.push(); f.sql.exec("UPDATE users SET email='alice@new.example.com' WHERE id=1"); await drainEmail(f.env); assert.equal(f.sent.length, 1);
  await f.enable('alice@new.example.com'); await f.subscribe('alice@new.example.com'); f.push(); await drainEmail(f.env); assert.equal(f.sent.at(-1).to, 'alice@new.example.com');
  // The address changes inside the claim window.
  f.push(); f.afterClaim = () => f.sql.exec("UPDATE users SET email='alice@late.example.com' WHERE id=1"); await drainEmail(f.env); assert.equal(f.sent.length, 2);
  f.sql.exec("UPDATE users SET email='alice@new.example.com' WHERE id=1"); await f.enable('alice@new.example.com'); await f.subscribe('alice@new.example.com');
  // Withdrawing account consent pauses every subscription without editing them.
  f.push(); await f.enable('alice@new.example.com', false); await drainEmail(f.env); assert.equal(f.sent.length, 2);
  await f.enable('alice@new.example.com'); f.push(); await drainEmail(f.env); assert.equal(f.sent.length, 3);
  // An edited subscription voids mail queued under the previous version.
  f.push(); await f.subscribe('alice@new.example.com', { eventTopics: ['source', 'issues'] }); await drainEmail(f.env); assert.equal(f.sent.length, 3);
  assert.deepEqual(f.deliveries().map(d => d.state).filter(s => !['accepted', 'cancelled'].includes(s)), []);
  // A repository that stops being active stops its mail.
  f.push(); f.sql.exec("UPDATE repositories SET state='CREATING' WHERE id=1"); await drainEmail(f.env); assert.equal(f.sent.length, 3);
});

test('the daily budget bounds send attempts and concurrent drains never send one delivery twice', async t => {
  const f = await fixture(t, 2); await f.enable(); await f.subscribe();
  for (let n = 0; n < 4; n++) f.push();
  await Promise.all([drainEmail(f.env), drainEmail(f.env), drainEmail(f.env)]);
  assert.equal(f.sent.length, 2); assert.equal(new Set(f.sent.map(m => m.headers['X-Golf-Delivery-ID'])).size, 2);
  assert.equal(f.sql.prepare('SELECT attempts FROM email_daily').get().attempts, 2);
  assert.deepEqual(f.deliveries().map(d => d.state).sort(), ['accepted', 'accepted', 'queued', 'queued']);
  const result = await drainEmail(f.env); assert.deepEqual(result, { processed: 0, pending: 2 }); assert.equal(f.sent.length, 2);
  // The budget is per UTC day.
  f.sql.exec("UPDATE email_daily SET day='2000-01-01'"); await drainEmail(f.env); assert.equal(f.sent.length, 4);
});

test('retries keep the delivery identity, mark possible duplicates only when the outcome was uncertain and stop at six attempts', async t => {
  const f = await ready(t), due = () => f.sql.exec("UPDATE email_deliveries SET next_attempt_at='2000' WHERE state='retrying'");
  f.push(); f.provider = async () => { throw Error('connection lost after the provider read the message'); };
  await drainEmail(f.env); let [d] = f.deliveries();
  assert.deepEqual([d.state, d.attempts, d.possible_duplicate, d.failure_code, d.completed_at], ['retrying', 1, 1, 'transport_uncertain', null]); assert.ok(Date.parse(d.next_attempt_at) > Date.now() + 25000);
  assert.equal((await drainEmail(f.env)).processed, 0); assert.equal(f.sent.length, 1);
  assert.deepEqual((await f.history()).map(h => [h.state, h.possibleDuplicate, h.attempts, Boolean(h.nextAttemptAt)]), [['retrying', true, 1, true]]);
  for (let n = 2; n <= 6; n++) { due(); await drainEmail(f.env); }
  [d] = f.deliveries(); assert.deepEqual([d.state, d.attempts, d.possible_duplicate], ['failed', 6, 1]); assert.ok(d.completed_at);
  assert.equal(f.sent.length, 6); assert.equal(new Set(f.sent.map(m => m.headers['X-Golf-Delivery-ID'])).size, 1); assert.equal(new Set(f.sent.map(m => m.text)).size, 1);
  due(); await drainEmail(f.env); assert.equal(f.sent.length, 6);
  // A definite rate or quota refusal is retried without claiming a duplicate; a later acceptance keeps the same identity.
  f.push(); f.provider = async () => { throw Object.assign(Error('slow down'), { code: 'E_RATE_LIMIT_EXCEEDED' }); }; await drainEmail(f.env);
  d = f.deliveries().at(-1); assert.deepEqual([d.state, d.possible_duplicate, d.failure_code], ['retrying', 0, 'rate_limited']);
  f.provider = async () => ({ messageId: 'accepted-later' }); due(); await drainEmail(f.env);
  d = f.deliveries().at(-1); assert.deepEqual([d.state, d.attempts, d.possible_duplicate, d.provider_message_id], ['accepted', 2, 0, 'accepted-later']);
  assert.equal(f.sent.at(-1).headers['X-Golf-Delivery-ID'], d.id); assert.equal(f.sent.at(-2).headers['X-Golf-Delivery-ID'], d.id);
  // Service errors may have accepted the message; validation and unknown refusals are final.
  for (const [code, state, failure, duplicate] of [['E_INTERNAL_SERVER_ERROR', 'retrying', 'provider_unavailable', 1], ['E_DAILY_LIMIT_EXCEEDED', 'retrying', 'provider_quota_exhausted', 0], ['E_VALIDATION_ERROR', 'failed', 'provider_rejected', 0],
    ['E_HEADER_NOT_ALLOWED', 'failed', 'provider_rejected', 0], ['E_RECIPIENT_NOT_ALLOWED', 'failed', 'recipient_refused', 0], ['E_DELIVERY_FAILED', 'failed', 'delivery_refused', 0], ['<script>', 'retrying', 'transport_uncertain', 1]]) {
    f.sql.exec("UPDATE email_deliveries SET state='cancelled' WHERE state='retrying'"); f.push(); f.provider = async () => { throw Object.assign(Error('PRIVATE PROVIDER DETAIL'), { code }); }; await drainEmail(f.env);
    d = f.deliveries().at(-1); assert.deepEqual([d.state, d.failure_code, d.possible_duplicate], [state, failure, duplicate], code);
  }
  assert.ok(!JSON.stringify(f.deliveries()).includes('PRIVATE PROVIDER DETAIL'));
  // A drain that died mid-send leaves a lease; once it expires the retry is disclosed as a possible duplicate.
  f.sql.exec("UPDATE email_deliveries SET state='cancelled' WHERE state='retrying'"); f.push(); const id = f.deliveries().at(-1).id;
  f.sql.prepare("UPDATE email_deliveries SET state='sending',attempts=1,lease='dead',lease_until='2000' WHERE id=?").run(id);
  f.provider = async () => ({ messageId: 'after-lease' }); await drainEmail(f.env);
  d = f.deliveries().at(-1); assert.deepEqual([d.state, d.attempts, d.possible_duplicate], ['accepted', 2, 1]);
  // An unexpired lease is left alone.
  f.push(); f.sql.prepare("UPDATE email_deliveries SET state='sending',attempts=1,lease='live',lease_until='2999' WHERE id=?").run(f.deliveries().at(-1).id);
  const before = f.sent.length; assert.deepEqual(await drainEmail(f.env), { processed: 0, pending: 1 }); assert.equal(f.sent.length, before);
});

test('a provider-suppressed mailbox pauses the account until its owner explicitly saves the preference again', async t => {
  const f = await ready(t);
  f.push(); f.push(); f.provider = async () => { throw Object.assign(Error('suppressed'), { code: 'E_RECIPIENT_SUPPRESSED' }); };
  await drainEmail(f.env);
  assert.equal(f.sent.length, 1); assert.deepEqual(f.deliveries().map(d => [d.state, d.failure_code]).sort(), [['cancelled', 'authority_changed'], ['suppressed', 'recipient_suppressed']]);
  let state = await f.own(); assert.deepEqual([state.enabled, state.suppression], [false, 'recipient_rejected']);
  assert.equal((await f.value(await f.call('GetRepositoryEmailSubscription', { target }))).subscription.authorizationState, 'authority_unavailable');
  f.provider = async () => ({ messageId: 'ok' }); f.push(); await drainEmail(f.env); assert.equal(f.sent.length, 1);
  state = await f.enable(); assert.deepEqual([state.enabled, state.suppression], [true, '']);
  f.push(); await drainEmail(f.env); assert.equal(f.sent.length, 2);
});

test('explicit redelivery is a new possible-duplicate message under current authority with an original receipt', async t => {
  const f = await ready(t); f.push(); await drainEmail(f.env);
  const [original] = await f.history(), operationId = crypto.randomUUID(), input = { deliveryId: original.id, operationId, expectedContactVersion: '1' };
  f.push(); const waiting = f.deliveries().at(-1);
  assert.equal((await f.call('RedeliverOwnEmail', { ...input, deliveryId: waiting.id })).status, 412);
  assert.equal((await f.call('RedeliverOwnEmail', { ...input, expectedContactVersion: '2' })).status, 412); assert.equal((await f.call('RedeliverOwnEmail', { ...input, operationId: 'x' })).status, 400);
  // Another account cannot redeliver or even address this delivery.
  await f.enable('bob@example.com'); assert.equal((await f.call('RedeliverOwnEmail', input, 'bob@example.com')).status, 404);
  const queued = (await f.value(await f.call('RedeliverOwnEmail', input))); assert.equal(queued.userId, '1');
  assert.deepEqual([queued.delivery.id, queued.delivery.eventId, queued.delivery.subscriptionId, queued.delivery.possibleDuplicate, queued.delivery.state, queued.delivery.attempts], [operationId, original.eventId, original.subscriptionId, true, 'queued', 0]);
  // The receipt replays without queueing again, and the key cannot be reused for another delivery.
  assert.deepEqual((await f.value(await f.call('RedeliverOwnEmail', input))).delivery, queued.delivery); assert.equal(f.deliveries().length, 3);
  await drainEmail(f.env); const other = (await f.history()).find(d => d.id === waiting.id);
  assert.equal((await f.call('RedeliverOwnEmail', { ...input, deliveryId: other.id })).status, 409);
  assert.equal(f.sent.length, 3); assert.equal(f.sent.filter(m => m.headers['X-Golf-Delivery-ID'] === operationId).length, 1);
  assert.equal((await f.value(await f.call('RedeliverOwnEmail', input))).delivery.state, 'accepted');
  // A paused subscription cannot redeliver; the request fails rather than queueing.
  await f.subscribe('alice@example.com', { enabled: false, authorizeBackground: false });
  assert.equal((await f.call('RedeliverOwnEmail', { ...input, operationId: crypto.randomUUID() })).status, 412); assert.equal(f.deliveries().length, 3);
  // The per-account waiting bound applies to redelivery too.
  await f.subscribe(); const insert = f.sql.prepare("INSERT INTO email_deliveries(id,subscription_id,subscription_version,user_id,repository_id,identity_version,event_id,event_topic,automatic_key,next_attempt_at,created_at) SELECT ?,id,version,1,1,0,?,'issues',?,'2999','2026' FROM email_subscriptions WHERE user_id=1");
  f.sql.exec('BEGIN'); for (let n = 0; n < 200; n++) insert.run(crypto.randomUUID(), 'fill:' + n, 'fill:' + n); f.sql.exec('COMMIT');
  assert.equal((await f.call('RedeliverOwnEmail', { ...input, operationId: crypto.randomUUID() })).status, 429);
});

test('deployment bindings carry a sender and a limit, never a secret, and need Access sign-in', async () => {
  const email = { sender, dailyLimit: 200 };
  assert.deepEqual(emailBindings({}), {});
  assert.deepEqual(emailBindings({ access_aud: 'aud', email }), { EMAIL_POLICY: { type: 'text', value: JSON.stringify(email) }, EMAIL: { type: 'send-email', allowedSenderAddresses: [sender] } });
  assert.throws(() => emailBindings({ email }), /Access sign-in/);
  for (const patch of [{ dailyLimit: true }, { dailyLimit: 5001 }, { dailyLimit: 1.5 }, { sender: 'golf' }, { sender: 'Golf@mail.example.com' }, { sender: 'a@b' }, { sender: 'a@example.com\nBcc: x@example.com' }, { sender: ['a@example.com'] }, { token: 'secret' }, { key: { store: 'a', name: 'b' } }])
    assert.throws(() => emailBindings({ access_aud: 'aud', email: { ...email, ...patch } }), /Invalid native email policy/, JSON.stringify(patch));
});

test('the schedule journals the email drain in its own table and operations report its queue', async t => {
  const f = await ready(t); f.sql.exec("INSERT INTO operations_admins(user_id) VALUES(1)");
  f.push(); f.push(); f.sql.exec("UPDATE email_deliveries SET next_attempt_at='2999' WHERE rowid=(SELECT MAX(rowid) FROM email_deliveries)");
  await runMaintenance(f.env, [['email', () => drainEmail(f.env)]]);
  assert.deepEqual({ ...f.sql.prepare('SELECT stage,outcome,processed,pending FROM email_maintenance').get() }, { stage: 'email', outcome: 'degraded', processed: 1, pending: 1 });
  assert.equal(f.sql.prepare('SELECT COUNT(*) n FROM operations_maintenance').get().n, 0);
  const data = await f.value(await f.request('/rpc/golf.v1.OperationsService/GetOperationsDashboard'));
  assert.equal(data.metrics.find(m => m.id === 'email.queued').value, 1); assert.equal(data.metrics.find(m => m.id === 'email.failed').value, 0);
  assert.equal(data.services.find(s => s.id === 'maintenance.email').state, 'degraded'); assert.ok(!JSON.stringify(data).includes('alice@example.com'));
  // Without the binding nothing is drained or reported, and queued mail stays put.
  delete f.env.EMAIL; assert.deepEqual(await drainEmail(f.env), { processed: 0 });
  const quiet = await f.value(await f.request('/rpc/golf.v1.OperationsService/GetOperationsDashboard')); assert.ok(!quiet.metrics.some(m => m.id.startsWith('email.'))); assert.ok(!quiet.services.some(s => s.id === 'maintenance.email'));
});

test('the reviewed migration appears verbatim in the schema and creates only repeatable objects', async () => {
  const name = (await readdir(new URL('./migrations/', import.meta.url))).find(file => file.endsWith('_email_notifications.sql'));
  const schema = await readFile(new URL('./schema.sql', import.meta.url), 'utf8'), migration = await readFile(new URL('./migrations/' + name, import.meta.url), 'utf8');
  // The hosted migrate step peels each migration and its separating newline off the schema's tail, so it must appear verbatim after one.
  assert.ok(schema.includes(';\n\n' + migration));
  const statements = migration.replace(/--[^\n]*/g, '').split(/;\s*(?=CREATE\b)/).filter(s => s.trim());
  assert.equal(statements.length, 14); for (const statement of statements) assert.match(statement.trim(), /^CREATE (TABLE|INDEX|TRIGGER) IF NOT EXISTS email_/);
  const sql = new DatabaseSync(':memory:'); sql.exec(schema); sql.exec(migration); sql.close();
});
