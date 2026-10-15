import { test } from 'node:test';
import assert from 'node:assert/strict';
import { vaultFixture, installationKey } from './vault-fixture.mjs';
import { sealSecret, openSecret, credentialFor, openCredential } from './src/vault.mjs';

const secret = 'sk-test-Zq9WvX2bL7mN4pR8tY1u-abcd';
// Every stored byte: a plaintext value must appear in none of it.
const everything = sql => JSON.stringify(sql.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(({ name }) => sql.prepare(`SELECT * FROM "${name}"`).all()));
const engineFor = (credentialId, places = ['cloud'], id = 'engine-1') => ({ id, credential_id: credentialId, places });
const create = (f, body, who = 'alice') => f.vault({ action: 'create', scope: 'user', kind: 'api-key', provider: 'openai', label: 'My OpenAI key', value: secret, ...body }, who);

test('sealing: an envelope round-trips, is bound to its context and installation key, and holds no plaintext', async t => {
  const f = await vaultFixture(t);
  const bytes = new TextEncoder().encode('private key material ☃'), sealed = await sealSecret(f.env, bytes, 'ssh-host:42');
  assert.doesNotMatch(sealed, /private key material/);
  const envelope = JSON.parse(sealed);
  assert.equal(envelope.v, 1); assert.match(envelope.k, /^[a-f0-9]{16}$/); assert.match(envelope.w, /^[A-Za-z0-9+/=]+\.[A-Za-z0-9+/=]+$/);
  assert.deepEqual(await openSecret(f.env, sealed, 'ssh-host:42'), bytes);
  // Another context, another installation key or a tampered envelope does not open.
  await assert.rejects(openSecret(f.env, sealed, 'ssh-host:43'));
  const other = { ...f.env, EXECUTION_VALUE_KEY: { async get() { return Buffer.alloc(32, 9).toString('base64'); } } };
  await assert.rejects(openSecret(other, sealed, 'ssh-host:42'), /different installation key/);
  await assert.rejects(openSecret(f.env, JSON.stringify({ ...envelope, d: envelope.d.replace(/^./, c => c === 'A' ? 'B' : 'A') }), 'ssh-host:42'));
  // Each seal uses a fresh data key and IV; strings seal as UTF-8.
  assert.notEqual(await sealSecret(f.env, bytes, 'ssh-host:42'), sealed);
  assert.equal(new TextDecoder().decode(await openSecret(f.env, await sealSecret(f.env, 'text'), '')), 'text');
  // Without the Secrets Store key nothing seals.
  await assert.rejects(sealSecret({ ...f.env, EXECUTION_VALUE_KEY: { async get() { return 'short'; } } }, bytes), /encryption key unavailable/);
});

test('create: metadata only in every answer, the database and the audit log; the value opens only through an issued handle', async t => {
  const f = await vaultFixture(t);
  const created = await create(f, {});
  assert.equal(created.status, 200, created.text);
  assert.doesNotMatch(created.text, /Zq9WvX2bL7mN4pR8tY1u/);
  const credential = created.value.credential;
  assert.equal(credential.fingerprint, '…abcd'); assert.equal(credential.state, 'active'); assert.equal(credential.version, 1); assert.equal(credential.scope, 'user'); assert.equal(credential.ownerId, '1');
  assert.equal(credential.createdBy, 'alice'); assert.equal(credential.usable, true);
  const listed = await f.vault({ action: 'list', scope: 'user' });
  assert.equal(listed.status, 200); assert.doesNotMatch(listed.text, /Zq9WvX2bL7mN4pR8tY1u/); assert.equal(listed.value.credentials.length, 1); assert.equal(listed.value.canManage, true);
  assert.ok(!everything(f.sql).includes(secret.slice(0, 20)));
  const row = f.sql.prepare('SELECT * FROM vault_credentials').get();
  assert.equal(row.fingerprint, 'abcd'); assert.equal(row.value_bytes, secret.length); assert.match(row.key_id, /^[a-f0-9]{16}$/);
  // The envelope is bound to the credential id and version: it does not open in another context.
  await assert.rejects(openSecret(f.env, row.sealed_value, ''));
  const use = await credentialFor(f.DB, f.env, { person: { id: 1, login: 'alice' }, engine: engineFor(row.id), place: 'cloud' });
  assert.equal(use.credential.label, 'My OpenAI key'); assert.equal(JSON.stringify(use.credential).includes(secret), false);
  assert.equal(await openCredential(f.env, use.credential), secret);
  await assert.rejects(openCredential(f.env, { ...use.credential }), /Not an issued credential handle/);
  assert.ok(f.sql.prepare('SELECT last_used_at FROM vault_credentials').get().last_used_at);
  // Labels are unique per owner while active; values are validated without echoing them.
  const duplicate = await create(f, {});
  assert.equal(duplicate.status, 412); assert.doesNotMatch(duplicate.text, /Zq9WvX2bL7mN4pR8tY1u/);
  assert.equal((await create(f, { label: 'Spaces', value: 'sk with spaces in it' })).status, 400);
  assert.equal((await create(f, { label: 'Bad provider', provider: 'acme' })).status, 400);
  // Mutations need a browser session from Golf's own origin.
  assert.equal((await f.call('/native/credentials', { action: 'create', scope: 'user', kind: 'api-key', provider: 'openai', label: 'Cross site', value: secret }, { headers: { Origin: 'https://evil.example' } })).status, 403);
  const rows = f.audit();
  assert.ok(rows.some(entry => entry.action === 'credential.create' && entry.subject === 'My OpenAI key' && entry.scope === 'installation'));
  assert.ok(!JSON.stringify(rows).includes(secret.slice(0, 20)));
});

test('rotation replaces the envelope and version; handles issued before it stop opening', async t => {
  const f = await vaultFixture(t);
  const { credential } = (await create(f, {})).value, before = f.sql.prepare('SELECT * FROM vault_credentials').get();
  const old = await credentialFor(f.DB, f.env, { person: { id: 1 }, engine: engineFor(credential.id), place: 'cloud' });
  assert.equal((await f.vault({ action: 'rotate', id: credential.id, expectedVersion: 2, value: 'sk-next-value-0000-wxyz' })).status, 412);
  const rotated = await f.vault({ action: 'rotate', id: credential.id, expectedVersion: 1, value: 'sk-next-value-0000-wxyz' });
  assert.equal(rotated.status, 200, rotated.text);
  assert.equal(rotated.value.credential.version, 2); assert.equal(rotated.value.credential.fingerprint, '…wxyz'); assert.ok(rotated.value.credential.rotatedAt);
  assert.doesNotMatch(rotated.text, /sk-next-value/);
  const after = f.sql.prepare('SELECT * FROM vault_credentials').get();
  assert.notEqual(after.sealed_value, before.sealed_value);
  await assert.rejects(openCredential(f.env, old.credential), /revoked or rotated/);
  const fresh = await credentialFor(f.DB, f.env, { person: { id: 1 }, engine: engineFor(credential.id), place: 'cloud' });
  assert.equal(await openCredential(f.env, fresh.credential), 'sk-next-value-0000-wxyz');
  // Bob cannot rotate Alice's credential.
  assert.equal((await f.vault({ action: 'rotate', id: credential.id, expectedVersion: 2, value: 'sk-bob-tries-this-1111' }, 'bob')).status, 403);
  assert.ok(f.audit().some(entry => entry.action === 'credential.rotate' && JSON.parse(entry.after).version === 2));
  assert.ok(!everything(f.sql).includes('sk-next-value'));
});

test('revocation destroys the envelope, refuses every later use and audits the refusal', async t => {
  const f = await vaultFixture(t);
  const { credential } = (await create(f, {})).value;
  const issued = await credentialFor(f.DB, f.env, { person: { id: 1 }, engine: engineFor(credential.id), place: 'cloud' });
  const revoked = await f.vault({ action: 'revoke', id: credential.id });
  assert.equal(revoked.status, 200); assert.equal(revoked.value.credential.state, 'revoked'); assert.equal(revoked.value.credential.usable, false);
  assert.equal(f.sql.prepare('SELECT sealed_value FROM vault_credentials').get().sealed_value, null);
  await assert.rejects(openCredential(f.env, issued.credential), /revoked or rotated/);
  const refused = await credentialFor(f.DB, f.env, { person: { id: 1, login: 'alice' }, engine: engineFor(credential.id), place: 'cloud' });
  assert.equal(refused.code, 'revoked'); assert.match(refused.refusal, /revoked/);
  assert.equal((await f.vault({ action: 'rotate', id: credential.id, expectedVersion: 2, value: 'sk-after-revoke-1234' })).status, 412);
  const denied = f.audit().find(entry => entry.action === 'credential.use_denied');
  assert.deepEqual(JSON.parse(denied.after), { credentialId: credential.id, reason: 'revoked' });
  // The label is free again for a new credential.
  assert.equal((await create(f, {})).status, 200);
});

test('grants: explicit sharing with a person, an organization, a repository or everyone, limited by engine and place', async t => {
  const f = await vaultFixture(t);
  const { credential } = (await create(f, {})).value, bob = { id: 2, login: 'bob' }, carol = { id: 3, login: 'carol' }, dave = { id: 4, login: 'dave' };
  const use = (person, extra = {}) => credentialFor(f.DB, f.env, { person, engine: engineFor(credential.id), place: 'cloud', ...extra });
  assert.equal((await use(bob)).code, 'not_granted');
  assert.equal(f.audit().filter(entry => entry.action === 'credential.use_denied').length, 1);
  // A dry run (listing, admission checks) refuses without an audit row.
  assert.equal((await use(bob, { dryRun: true })).code, 'not_granted');
  assert.equal(f.audit().filter(entry => entry.action === 'credential.use_denied').length, 1);
  const granted = await f.vault({ action: 'grant', id: credential.id, granteeKind: 'user', grantee: 'bob', engines: ['engine-1'], places: ['cloud'] });
  assert.equal(granted.status, 200, granted.text);
  assert.deepEqual(granted.value.credential.grants.map(g => [g.granteeKind, g.grantee, g.engines, g.places]), [['user', 'bob', ['engine-1'], ['cloud']]]);
  assert.ok((await use(bob)).credential);
  // Limited to engine-1 and the cloud place.
  assert.equal((await credentialFor(f.DB, f.env, { person: bob, engine: engineFor(credential.id, ['cloud'], 'engine-2'), place: 'cloud' })).code, 'not_granted');
  assert.equal((await credentialFor(f.DB, f.env, { person: bob, engine: engineFor(credential.id, ['cloud', 'agent-host']), place: 'agent-host' })).code, 'not_granted');
  assert.equal((await credentialFor(f.DB, f.env, { person: bob, engine: engineFor(credential.id), place: 'ssh-host' })).code, 'place');
  // Only Bob: Carol still cannot, and a user grant is not a repository grant.
  assert.equal((await use(carol)).code, 'not_granted');
  assert.equal((await f.vault({ action: 'grant', id: credential.id, granteeKind: 'repository', grantee: 'alice/project' })).status, 200);
  assert.ok((await use(carol, { repository: { id: 1 } })).credential);
  assert.equal((await use(carol, { repository: { id: 3 } })).code, 'not_granted');
  assert.equal((await use(carol)).code, 'not_granted');
  // Organization grants reach members within the organization's repositories.
  assert.equal((await f.vault({ action: 'grant', id: credential.id, granteeKind: 'organization', grantee: 'acme' })).status, 200);
  assert.ok((await use({ id: 2 }, { repository: { id: 2 } })).credential);
  assert.equal((await use(carol, { repository: { id: 2 } })).code, 'not_granted');
  // Everyone on the installation is for installation credentials only; inactive accounts are always refused.
  assert.equal((await f.vault({ action: 'grant', id: credential.id, granteeKind: 'installation' })).status, 400);
  assert.equal((await use(dave)).code, 'not_granted');
  // Ungranting is immediate.
  const grant = (await f.vault({ action: 'list', scope: 'user' })).value.credentials[0].grants.find(g => g.granteeKind === 'user');
  assert.ok((await use(bob, { repository: { id: 3 } })).credential);
  assert.equal((await f.vault({ action: 'ungrant', id: credential.id, grantId: grant.id })).status, 200);
  // Bob keeps what his organization's grant covers, nothing outside it.
  assert.equal((await use(bob, { repository: { id: 3 } })).code, 'not_granted');
  assert.ok((await use(bob, { repository: { id: 2 } })).credential);
  // Bob sees what is shared with him, as metadata, while a grant stands.
  assert.equal((await f.vault({ action: 'grant', id: credential.id, granteeKind: 'user', grantee: 'bob' })).status, 200);
  const shared = await f.vault({ action: 'list', scope: 'user' }, 'bob');
  assert.deepEqual(shared.value.sharedWithYou.map(c => c.label), ['My OpenAI key']); assert.equal(shared.value.sharedWithYou[0].grants, undefined);
  assert.doesNotMatch(shared.text, /Zq9WvX2bL7mN4pR8tY1u/);
  const actions = f.audit().map(entry => entry.action);
  assert.ok(actions.includes('credential.grant') && actions.includes('credential.ungrant'));
});

test('scope hierarchy: owners manage personal credentials, organization owners theirs, operations administrators the installation', async t => {
  const f = await vaultFixture(t);
  // Installation: operations administrators only.
  const installation = await f.vault({ action: 'create', scope: 'installation', kind: 'api-key', provider: 'anthropic', label: 'Installation Anthropic', value: 'sk-ant-installation-0001', grants: [{ granteeKind: 'installation' }] });
  assert.equal(installation.status, 200, installation.text);
  assert.equal(installation.value.credential.grants[0].grantee, 'Everyone on this installation');
  assert.equal((await f.vault({ action: 'create', scope: 'installation', kind: 'api-key', provider: 'openai', label: 'Bob try', value: secret }, 'bob')).status, 403);
  assert.equal((await f.vault({ action: 'list', scope: 'installation' }, 'bob')).status, 403);
  assert.ok((await credentialFor(f.DB, f.env, { person: { id: 3 }, engine: engineFor(installation.value.credential.id), place: 'cloud' })).credential);
  // Organization: owners manage; members read labels; others are refused.
  const org = await f.vault({ action: 'create', scope: 'organization', organization: 'acme', kind: 'api-key', provider: 'openai', label: 'Acme OpenAI', value: 'sk-acme-0000-0000-9999', grants: [{ granteeKind: 'organization', grantee: 'acme' }] });
  assert.equal(org.status, 200, org.text);
  assert.equal(org.value.credential.scope, 'organization'); assert.equal(org.value.credential.ownerId, '10');
  assert.equal((await f.vault({ action: 'create', scope: 'organization', organization: 'acme', kind: 'api-key', provider: 'openai', label: 'Bob org', value: secret }, 'bob')).status, 403);
  const member = await f.vault({ action: 'list', scope: 'organization', organization: 'acme' }, 'bob');
  assert.equal(member.status, 200); assert.equal(member.value.canManage, false); assert.deepEqual(member.value.credentials.map(c => c.label), ['Acme OpenAI']);
  assert.equal((await f.vault({ action: 'list', scope: 'organization', organization: 'acme' }, 'carol')).status, 403);
  assert.equal((await f.vault({ action: 'revoke', id: org.value.credential.id }, 'bob')).status, 403);
  // An organization credential is shared only inside its organization.
  assert.equal((await f.vault({ action: 'grant', id: org.value.credential.id, granteeKind: 'repository', grantee: 'alice/project' })).status, 400);
  assert.equal((await f.vault({ action: 'grant', id: org.value.credential.id, granteeKind: 'organization', grantee: 'other' })).status, 400);
  // Personal: nobody else manages them, not even an operations administrator.
  const bobs = await create(f, { label: 'Bob personal' }, 'bob');
  assert.equal((await f.vault({ action: 'revoke', id: bobs.value.credential.id })).status, 403);
  assert.equal((await f.vault({ action: 'list', scope: 'user' })).value.credentials.length, 0);
  // Organization changes are audited at the organization; denials through the route are recorded too.
  const rows = f.audit();
  assert.ok(rows.some(entry => entry.action === 'credential.create' && entry.scope === 'organization' && entry.scope_id === '10'));
  assert.ok(rows.some(entry => entry.action === 'credential.create' && JSON.parse(entry.client).outcome === 'denied'));
  assert.ok(rows.some(entry => entry.action === 'credential.revoke' && JSON.parse(entry.client).outcome === 'denied' && entry.scope === 'organization'));
});

test('subscription sign-ins are personal, need the terms note, are stored sealed and refused for use until cloud sandboxes', async t => {
  const f = await vaultFixture(t);
  const file = JSON.stringify({ OPENAI_API_KEY: null, tokens: { access_token: 'eyJ-access-secret', refresh_token: 'rt-refresh-secret' } });
  const body = { action: 'create', scope: 'user', kind: 'subscription', provider: 'openai', tool: 'codex', label: 'My ChatGPT', value: file };
  assert.equal((await f.vault(body)).status, 400);
  assert.equal((await f.vault({ ...body, acceptTerms: true, value: 'not json' })).status, 400);
  assert.equal((await f.vault({ ...body, acceptTerms: true, tool: 'claude' })).status, 400);
  assert.equal((await f.vault({ ...body, acceptTerms: true, scope: 'installation' })).status, 400);
  const created = await f.vault({ ...body, acceptTerms: true });
  assert.equal(created.status, 200, created.text);
  assert.equal(created.value.credential.fingerprint, ''); assert.equal(created.value.credential.usable, false); assert.match(created.value.credential.usableReason, /cloud sandboxes are phase 3/);
  assert.doesNotMatch(created.text, /refresh-secret|access-secret/);
  assert.ok(!everything(f.sql).includes('refresh-secret'));
  const listed = await f.vault({ action: 'list', scope: 'user' });
  assert.match(listed.value.subscriptionTerms, /provider’s terms/);
  const refused = await credentialFor(f.DB, f.env, { person: { id: 1 }, engine: engineFor(created.value.credential.id, ['cloud', 'agent-host']), place: 'cloud' });
  assert.equal(refused.code, 'subscription'); assert.match(refused.refusal, /cloud sandboxes are phase 3/);
  // Stored sealed for phase 3: the envelope opens to the exact file.
  const row = f.sql.prepare('SELECT * FROM vault_credentials').get();
  assert.equal(new TextDecoder().decode(await openSecret(f.env, row.sealed_value, `credential:${row.id}:1`)), file);
});

test('the vault is unavailable, and says why, without the installation key; audit reads list the Credentials category', async t => {
  const f = await vaultFixture(t, { key: null });
  const capabilities = (await f.call('/rpc/golf.v1.CapabilityService/ListCapabilities', {})).value.capabilities;
  const capability = capabilities.find(c => c.id === 'settings.credentials');
  assert.equal(capability.state, 'CAPABILITY_STATE_DISABLED'); assert.match(capability.reason, /EXECUTION_VALUE_KEY/);
  const refused = await create(f, {});
  assert.equal(refused.status, 412); assert.match(refused.value.message, /Secrets Store/);
  const listed = await f.vault({ action: 'list', scope: 'user' });
  assert.equal(listed.value.ready, false);
  const g = await vaultFixture(t);
  await create(g, {});
  const read = await g.call('/native/audit/read', { scope: 'installation', filters: { category: 'credential' } });
  assert.equal(read.status, 200, read.text);
  assert.ok(read.value.categories.some(c => c.id === 'credential' && c.label === 'Credentials'));
  assert.equal(read.value.entries[0].description, 'added credential My OpenAI key');
  assert.equal((await g.call('/rpc/golf.v1.CapabilityService/ListCapabilities', {})).value.capabilities.find(c => c.id === 'settings.credentials').state, 'CAPABILITY_STATE_READY');
  assert.ok(installationKey);
});
