// The credential vault (docs/CREDENTIAL_VAULT.md, agents plan phase 2a): API keys and subscription sign-ins at user, organization and
// installation scope. Every value is sealed in an envelope: its own random AES-256-GCM data key encrypts it, and the installation key that
// execution values use (EXECUTION_VALUE_KEY, Secrets Store) encrypts that data key. Both layers authenticate a domain and the credential id
// and version, so ciphertext cannot be moved between credentials, versions or other sealed stores. No plaintext is stored, logged, audited
// or returned by any API: lists carry metadata only, and the only way to use a value is a handle from credentialFor(), which the engines
// module opens for one outbound provider call.
import { Fault, invalid, deny } from './common.mjs';
import { sealingKey } from './sealed.mjs';
import { operationsAdmin } from './operations.mjs';
import { auditStatement, clientHeaders } from './installation.mjs';
import { ownerSlug } from './owners.mjs';

export const credentialScopes = ['user', 'organization', 'installation'];
export const credentialKinds = ['api-key', 'subscription'];
export const providers = { openai: 'OpenAI', anthropic: 'Anthropic', xai: 'xAI', google: 'Google' };
// Subscription sign-ins belong to a coding CLI; each is listed with the provider whose account it signs in to.
export const subscriptionTools = { codex: { label: 'Codex (ChatGPT sign-in)', providers: ['openai'] }, claude: { label: 'Claude Code (Claude sign-in)', providers: ['anthropic'] },
  grok: { label: 'Grok Build (SuperGrok sign-in)', providers: ['xai'] }, agy: { label: 'Antigravity (Google sign-in)', providers: ['google'] },
  opencode: { label: 'OpenCode (provider sign-in)', providers: ['openai', 'anthropic', 'xai', 'google'] }, muse: { label: 'Muse Code', providers: ['openai', 'anthropic', 'xai', 'google'] } };
export const places = ['cloud', 'agent-host', 'ssh-host'];
export const subscriptionRefusal = 'cloud sandboxes are phase 3';
export const subscriptionTerms = 'A subscription sign-in is stored sealed for a later cloud sandbox to mount for one task at a time. Golf does not use it yet. Check that your provider’s terms allow a personal subscription to run in a hosted sandbox before you upload one; Golf will refuse providers whose terms do not.';
const maximumValue = 64 * 1024, maximumCredentials = 100, maximumGrants = 50;
const time = () => new Date().toISOString();
const text = new TextEncoder();
const parse = (value, fallback) => { try { return JSON.parse(value) ?? fallback; } catch { return fallback; } };
const forbidden = message => { throw new Fault('permission_denied', 403, message); };
const refuse = message => { throw new Fault('failed_precondition', 412, message); };
const fields = (body, allowed) => Object.keys(body).every(key => allowed.includes(key));
const labelOK = label => typeof label === 'string' && label && label.trim() === label && text.encode(label).length <= 64 && !/[\p{Cc}\p{Zl}\p{Zp}]/u.test(label);
const idOK = value => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value);

// ---------- sealing: also the shared helper for other stores (SSH host keys) ----------
function base64(bytes) {
  let out = '';
  for (let i = 0; i < bytes.length; i += 0x8000) out += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(out);
}
const unbase64 = value => Uint8Array.from(atob(value), c => c.charCodeAt(0));
const vaultKey = env => sealingKey(env.EXECUTION_VALUE_KEY, 'Credential vault');
const domain = (layer, context) => text.encode(JSON.stringify(['golf.vault.' + layer + '.v1', String(context)]));
async function encrypt(key, additionalData, bytes) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  return base64(iv) + '.' + base64(new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData }, key, bytes)));
}
async function decrypt(key, additionalData, sealed) {
  const [iv, data] = String(sealed).split('.');
  return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unbase64(iv), additionalData }, key, unbase64(data)));
}
/* sealSecret(env, bytes, context?) → an envelope string; openSecret(env, sealed, context?) → the bytes. context binds the envelope to its
 * owner (for example 'ssh-host:42'); opening with another context fails. The data key exists only in memory while sealing or opening. */
export async function sealSecret(env, bytes, context = '') {
  const value = typeof bytes === 'string' ? text.encode(bytes) : bytes;
  if (!(value instanceof Uint8Array)) throw TypeError('sealSecret needs bytes');
  const master = await vaultKey(env), raw = crypto.getRandomValues(new Uint8Array(32));
  const dataKey = await crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt']);
  const sealed = JSON.stringify({ v: 1, k: master.id, w: await encrypt(master.key, domain('key', context), raw), d: await encrypt(dataKey, domain('data', context), value) });
  raw.fill(0);
  return sealed;
}
export async function openSecret(env, sealed, context = '') {
  const envelope = parse(sealed, null);
  if (envelope?.v !== 1 || typeof envelope.w !== 'string' || typeof envelope.d !== 'string') throw Error('Sealed value unreadable');
  const master = await vaultKey(env);
  if (envelope.k !== master.id) throw Error('Sealed under a different installation key');
  const raw = await decrypt(master.key, domain('key', context), envelope.w);
  const dataKey = await crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['decrypt']);
  raw.fill(0);
  return decrypt(dataKey, domain('data', context), envelope.d);
}
export const sealedKeyId = sealed => parse(sealed, {})?.k || '';
const credentialContext = (id, version) => `credential:${id}:${version}`;

// ---------- schema and capability ----------
let migrated = false;
export async function vaultSchema(db) {
  if (!migrated) { try { migrated = Boolean((await db.prepare('PRAGMA table_info(vault_credentials)').all()).results.length); } catch { migrated = false; } }
  return migrated;
}
export async function vaultState(db, env) {
  if (!await vaultSchema(db)) return { ready: false, reason: 'Apply the schema 45 migration to keep credentials.' };
  if (!env.EXECUTION_VALUE_KEY?.get) return { ready: false, reason: 'The credential vault seals values with the installation’s Secrets Store encryption key (EXECUTION_VALUE_KEY), which this installation does not bind.' };
  return { ready: true, reason: '' };
}
export async function vaultCapability(db, env) {
  const state = await vaultState(db, env);
  return { id: 'settings.credentials', label: 'Credential vault', state: state.ready ? 'CAPABILITY_STATE_READY' : 'CAPABILITY_STATE_DISABLED',
    reason: state.ready ? 'API keys and subscription sign-ins for people, organizations and the installation, sealed with envelope encryption under the installation’s Secrets Store key. Values are never shown again; owners choose who may use each one, on which engines and where. Provider API keys run provider-model engines through the private AI Gateway; subscription sign-ins are stored for cloud sandboxes, which are not available yet.'
      : state.reason };
}

// ---------- authority ----------
async function organizationBySlug(db, slug) {
  if (typeof slug !== 'string' || !/^[a-z0-9][a-z0-9-]{0,39}$/.test(slug)) invalid('Name the organization.');
  const org = await db.prepare("SELECT id,slug FROM native_owners WHERE slug=? AND kind='ORGANIZATION'").bind(slug).first();
  if (!org) forbidden('Organization owners manage organization credentials.');
  return org;
}
const managers = { user: 'Only its owner manages a personal credential.', organization: 'Organization owners manage organization credentials.', installation: 'Current workspace operations administrator sign-in required.' };
export async function canManageScope(db, person, request, scope, ownerId) {
  if (scope === 'user') return ownerId === String(person.id);
  if (scope === 'organization') return Boolean(await db.prepare("SELECT 1 AS ok FROM native_owner_members m JOIN users u ON u.id=m.user_id WHERE m.owner_id=? AND m.user_id=? AND m.role='owner' AND u.active=1").bind(Number(ownerId), person.id).first());
  return scope === 'installation' && await operationsAdmin(db, person, request);
}
// The scope a request names: user → the caller; organization → its owner id; installation → ''.
export async function resolveScope(db, person, body) {
  if (!credentialScopes.includes(body.scope)) invalid('Choose user, organization or installation scope.');
  if (body.scope === 'user') return { scope: 'user', ownerId: String(person.id), label: person.login };
  if (body.scope === 'installation') return { scope: 'installation', ownerId: '', label: 'Installation' };
  const org = await organizationBySlug(db, body.organization);
  return { scope: 'organization', ownerId: String(org.id), label: org.slug };
}
const auditScope = (env, credential) => credential.scope === 'organization' ? { scope: 'organization', scopeId: credential.owner_id } : { scope: 'installation', scopeId: env.WORKSPACE_SLUG || '' };

// ---------- views: metadata only ----------
async function granteeNames(db, env, grants) {
  const ids = kind => [...new Set(grants.filter(g => g.grantee_kind === kind).map(g => Number(g.grantee_id)))];
  const query = async (sql, list) => list.length ? (await db.prepare(sql).bind(JSON.stringify(list)).all()).results : [];
  const users = new Map((await query('SELECT id,login FROM users WHERE id IN (SELECT value FROM json_each(?))', ids('user'))).map(row => [String(row.id), row.login]));
  const orgs = new Map((await query("SELECT id,slug FROM native_owners WHERE kind='ORGANIZATION' AND id IN (SELECT value FROM json_each(?))", ids('organization'))).map(row => [String(row.id), row.slug]));
  const repos = new Map((await query('SELECT r.id,r.name,o.slug AS owner_slug FROM repositories r LEFT JOIN repository_owners ro ON ro.repository_id=r.id LEFT JOIN native_owners o ON o.id=ro.owner_id WHERE r.id IN (SELECT value FROM json_each(?))', ids('repository')))
    .map(row => [String(row.id), `${ownerSlug(row, env)}/${row.name}`]));
  return g => g.grantee_kind === 'installation' ? 'Everyone on this installation' : (g.grantee_kind === 'user' ? users : g.grantee_kind === 'organization' ? orgs : repos).get(g.grantee_id) || `(${g.grantee_kind} ${g.grantee_id} unavailable)`;
}
export async function credentialViews(db, env, rows) {
  if (!rows.length) return [];
  const { results: grants } = await db.prepare('SELECT * FROM vault_credential_grants WHERE credential_id IN (SELECT value FROM json_each(?)) ORDER BY created_at,id').bind(JSON.stringify(rows.map(row => row.id))).all();
  const name = await granteeNames(db, env, grants);
  const creators = new Map((await db.prepare('SELECT id,login FROM users WHERE id IN (SELECT value FROM json_each(?))').bind(JSON.stringify([...new Set(rows.map(row => row.created_by))])).all()).results.map(row => [row.id, row.login]));
  return rows.map(row => ({ id: row.id, scope: row.scope, ownerId: row.owner_id, kind: row.kind, provider: row.provider, tool: row.tool, label: row.label,
    fingerprint: row.kind === 'api-key' && row.fingerprint ? '…' + row.fingerprint : '', valueBytes: row.value_bytes, state: row.revoked_at ? 'revoked' : 'active', version: row.version,
    createdBy: creators.get(row.created_by) || '', createdAt: row.created_at, rotatedAt: row.rotated_at || '', revokedAt: row.revoked_at || '', lastUsedAt: row.last_used_at || '',
    usable: !row.revoked_at && row.kind === 'api-key', usableReason: row.revoked_at ? 'Revoked.' : row.kind === 'subscription' ? `Stored only: ${subscriptionRefusal}.` : '',
    grants: grants.filter(g => g.credential_id === row.id).map(g => ({ id: g.id, granteeKind: g.grantee_kind, granteeId: g.grantee_id, grantee: name(g), engines: parse(g.engines, []), places: parse(g.places, []), createdAt: g.created_at })) }));
}

// ---------- create, rotate, revoke, grants (each writes its audit row in the same batch) ----------
function validValue(kind, value) {
  if (typeof value !== 'string' || !value || text.encode(value).length > maximumValue) invalid('Provide the value, up to 64 KiB.');
  if (kind === 'api-key' && (value.trim() !== value || value.length < 8 || value.length > 512 || /[\s\p{Cc}]/u.test(value))) invalid('Paste the API key exactly as the provider shows it, without spaces.');
  if (kind === 'subscription') {
    // Token files are JSON (Codex auth.json, Claude .credentials.json); anything else is refused rather than stored unread.
    const parsed = parse(value, null);
    if (!parsed || typeof parsed !== 'object') invalid('Upload or paste the sign-in token file as JSON, for example ~/.codex/auth.json or ~/.claude/.credentials.json.');
  }
}
const fingerprintOf = (kind, value) => kind === 'api-key' ? value.slice(-4) : '';
async function grantTarget(db, env, scope, body) {
  const kind = body.granteeKind;
  if (!['user', 'organization', 'repository', 'installation'].includes(kind)) invalid('Grant to a person, an organization, a repository or everyone on the installation.');
  if (kind === 'installation') {
    if (scope.scope !== 'installation') invalid('Only installation credentials can be shared with everyone on the installation.');
    return { kind, id: '' };
  }
  if (typeof body.grantee !== 'string' || !body.grantee || body.grantee.length > 200) invalid('Name who receives the grant.');
  if (kind === 'user') {
    const user = await db.prepare('SELECT id FROM users WHERE login=? AND active=1').bind(body.grantee).first();
    if (!user) invalid(`No active account named ${body.grantee}.`);
    return { kind, id: String(user.id) };
  }
  if (kind === 'organization') {
    const org = await db.prepare("SELECT id FROM native_owners WHERE slug=? AND kind='ORGANIZATION'").bind(body.grantee).first();
    if (!org) invalid(`No organization named ${body.grantee}.`);
    if (scope.scope === 'organization' && String(org.id) !== scope.ownerId) invalid('An organization credential can be shared only within its own organization.');
    return { kind, id: String(org.id) };
  }
  const [owner, name] = body.grantee.split('/');
  const { results } = name ? await db.prepare("SELECT r.id,r.name,o.slug AS owner_slug,o.kind AS owner_kind,o.id AS owner_id FROM repositories r LEFT JOIN repository_owners ro ON ro.repository_id=r.id LEFT JOIN native_owners o ON o.id=ro.owner_id WHERE r.name=? AND r.state='ACTIVE'").bind(name).all() : { results: [] };
  const repository = results.find(row => ownerSlug(row, env) === owner);
  if (!repository) invalid(`No repository ${body.grantee}.`);
  if (scope.scope === 'organization' && !(repository.owner_kind === 'ORGANIZATION' && String(repository.owner_id) === scope.ownerId)) invalid('An organization credential can be shared only with the organization’s repositories.');
  return { kind, id: String(repository.id) };
}
function grantLimits(body) {
  const engines = body.engines ?? [], where = body.places ?? places;
  if (!Array.isArray(engines) || engines.length > 20 || engines.some(id => typeof id !== 'string' || !/^[A-Za-z0-9:@/._-]{1,160}$/.test(id))) invalid('Limit the grant to up to 20 engine ids, or none for every engine.');
  if (!Array.isArray(where) || !where.length || new Set(where).size !== where.length || where.some(place => !places.includes(place))) invalid('Choose where it may be used: cloud, agent-host or ssh-host.');
  return { engines: [...new Set(engines)], places: places.filter(place => where.includes(place)) };
}

async function managedCredential(db, person, request, id) {
  if (!idOK(id)) invalid('Choose a credential.');
  const row = await db.prepare('SELECT * FROM vault_credentials WHERE id=?').bind(id).first();
  if (!row) deny();
  if (!await canManageScope(db, person, request, row.scope, row.owner_id)) forbidden(managers[row.scope]);
  return row;
}
const browserOnly = (env, request) => {
  if (request.headers.has('Authorization') || request.headers.has('CF-Access-Client-Id') || request.headers.has('CF-Access-Client-Secret') || !request.headers.get('X-Golf-Native-Access-Email') ||
      request.headers.get('Origin') !== env.PUBLIC_ORIGIN) forbidden('Manage credentials from a signed-in browser session.');
};
const actor = (person, request) => ({ actor: person, actorEmail: request.headers.get('X-Golf-Native-Access-Email') || '', client: clientHeaders(request) });

export async function createCredential(db, env, person, request, scope, body) {
  const kind = body.kind, provider = body.provider, tool = body.tool ?? '';
  if (!credentialKinds.includes(kind)) invalid('Choose an API key or a subscription sign-in.');
  if (!Object.hasOwn(providers, provider)) invalid('Choose OpenAI, Anthropic, xAI or Google.');
  if (kind === 'subscription' ? !Object.hasOwn(subscriptionTools, tool) || !subscriptionTools[tool].providers.includes(provider) : tool !== '') invalid('Name the coding CLI this sign-in belongs to, for its provider.');
  if (kind === 'subscription' && scope.scope !== 'user') invalid('Subscription sign-ins are personal: add them under your own account settings.');
  if (kind === 'subscription' && body.acceptTerms !== true) invalid('Confirm that you read the provider-terms note for subscription sign-ins.');
  if (!labelOK(body.label)) invalid('Use a trimmed name up to 64 bytes.');
  validValue(kind, body.value);
  const initial = Array.isArray(body.grants) ? body.grants : [];
  if (initial.length > 10) invalid('Add up to 10 grants when creating; add more afterwards.');
  const targets = [];
  for (const grant of initial) { if (!grant || typeof grant !== 'object') invalid('Each grant names a grantee.'); targets.push({ ...(await grantTarget(db, env, scope, grant)), ...grantLimits(grant) }); }
  const count = await db.prepare('SELECT COUNT(*) AS n FROM vault_credentials WHERE scope=? AND owner_id=? AND revoked_at IS NULL').bind(scope.scope, scope.ownerId).first();
  if (count.n >= maximumCredentials) refuse(`This scope already holds ${maximumCredentials} active credentials; revoke unused ones first.`);
  const id = crypto.randomUUID(), stamp = time(), sealed = await sealSecret(env, body.value, credentialContext(id, 1));
  const after = { label: body.label, kind, provider, tool: tool || undefined, grants: targets.length };
  const statements = [
    db.prepare(`INSERT INTO vault_credentials(id,scope,owner_id,kind,provider,tool,label,sealed_value,key_id,fingerprint,value_bytes,created_by,created_at,version)
      SELECT ?,?,?,?,?,?,?,?,?,?,?,?,?,1 WHERE NOT EXISTS(SELECT 1 FROM vault_credentials WHERE scope=? AND owner_id=? AND label=? AND revoked_at IS NULL)`)
      .bind(id, scope.scope, scope.ownerId, kind, provider, tool, body.label, sealed, sealedKeyId(sealed), fingerprintOf(kind, body.value), text.encode(body.value).length, person.id, stamp, scope.scope, scope.ownerId, body.label),
    auditStatement(db, { ...actor(person, request), ...auditScope(env, { scope: scope.scope, owner_id: scope.ownerId }), subject: body.label, action: 'credential.create', after }),
    ...targets.map(target => db.prepare(`INSERT INTO vault_credential_grants(id,credential_id,grantee_kind,grantee_id,engines,places,created_by,created_at) SELECT ?,?,?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM vault_credentials WHERE id=?)`)
      .bind(crypto.randomUUID(), id, target.kind, target.id, JSON.stringify(target.engines), JSON.stringify(target.places), person.id, stamp, id)),
  ];
  const saved = await db.batch(statements);
  if (saved[0].meta.changes !== 1) refuse(`A credential named ${body.label} already exists here.`);
  return (await credentialViews(db, env, [await db.prepare('SELECT * FROM vault_credentials WHERE id=?').bind(id).first()]))[0];
}

export async function rotateCredential(db, env, person, request, body) {
  const row = await managedCredential(db, person, request, body.id);
  if (row.revoked_at) refuse('This credential is revoked; add a new one instead.');
  if (body.expectedVersion !== row.version) refuse('The credential changed; refresh before rotating.');
  validValue(row.kind, body.value);
  const version = row.version + 1, stamp = time(), sealed = await sealSecret(env, body.value, credentialContext(row.id, version));
  const saved = await db.batch([
    db.prepare('UPDATE vault_credentials SET sealed_value=?,key_id=?,fingerprint=?,value_bytes=?,version=?,rotated_at=? WHERE id=? AND version=? AND revoked_at IS NULL')
      .bind(sealed, sealedKeyId(sealed), fingerprintOf(row.kind, body.value), text.encode(body.value).length, version, stamp, row.id, row.version),
    auditStatement(db, { ...actor(person, request), ...auditScope(env, row), subject: row.label, action: 'credential.rotate', after: { label: row.label, version } }),
  ]);
  if (saved[0].meta.changes !== 1) refuse('The credential changed; refresh before rotating.');
  return (await credentialViews(db, env, [await db.prepare('SELECT * FROM vault_credentials WHERE id=?').bind(row.id).first()]))[0];
}

// Revoking destroys the envelope at once; engines that use it stop at their next call. Metadata and grants stay for the record.
export async function revokeCredential(db, env, person, request, body) {
  const row = await managedCredential(db, person, request, body.id);
  if (row.revoked_at) return (await credentialViews(db, env, [row]))[0];
  const stamp = time();
  await db.batch([
    db.prepare('UPDATE vault_credentials SET sealed_value=NULL,revoked_at=?,version=version+1 WHERE id=? AND revoked_at IS NULL').bind(stamp, row.id),
    auditStatement(db, { ...actor(person, request), ...auditScope(env, row), subject: row.label, action: 'credential.revoke', after: { label: row.label } }),
  ]);
  return (await credentialViews(db, env, [await db.prepare('SELECT * FROM vault_credentials WHERE id=?').bind(row.id).first()]))[0];
}

async function grantCredential(db, env, person, request, body) {
  const row = await managedCredential(db, person, request, body.id);
  if (row.revoked_at) refuse('This credential is revoked.');
  const target = await grantTarget(db, env, { scope: row.scope, ownerId: row.owner_id }, body), limits = grantLimits(body);
  const count = await db.prepare('SELECT COUNT(*) AS n FROM vault_credential_grants WHERE credential_id=?').bind(row.id).first();
  if (count.n >= maximumGrants) refuse(`A credential has at most ${maximumGrants} grants.`);
  const name = (await granteeNames(db, env, [{ grantee_kind: target.kind, grantee_id: target.id }]))({ grantee_kind: target.kind, grantee_id: target.id });
  const saved = await db.batch([
    db.prepare(`INSERT INTO vault_credential_grants(id,credential_id,grantee_kind,grantee_id,engines,places,created_by,created_at) VALUES(?,?,?,?,?,?,?,?)
      ON CONFLICT(credential_id,grantee_kind,grantee_id) DO UPDATE SET engines=excluded.engines,places=excluded.places`)
      .bind(crypto.randomUUID(), row.id, target.kind, target.id, JSON.stringify(limits.engines), JSON.stringify(limits.places), person.id, time()),
    auditStatement(db, { ...actor(person, request), ...auditScope(env, row), subject: row.label, action: 'credential.grant', widening: true, after: { grantee: name, granteeKind: target.kind, engines: limits.engines.length || 'all', places: limits.places } }),
  ]);
  if (saved[0].meta.changes !== 1) refuse('The grant could not be saved; refresh and retry.');
  return (await credentialViews(db, env, [row]))[0];
}
async function ungrantCredential(db, env, person, request, body) {
  const row = await managedCredential(db, person, request, body.id);
  if (!idOK(body.grantId)) invalid('Choose a grant.');
  const grant = await db.prepare('SELECT * FROM vault_credential_grants WHERE id=? AND credential_id=?').bind(body.grantId, row.id).first();
  if (!grant) deny();
  const name = (await granteeNames(db, env, [grant]))(grant);
  await db.batch([
    db.prepare('DELETE FROM vault_credential_grants WHERE id=?').bind(grant.id),
    auditStatement(db, { ...actor(person, request), ...auditScope(env, row), subject: row.label, action: 'credential.ungrant', after: { grantee: name, granteeKind: grant.grantee_kind } }),
  ]);
  return (await credentialViews(db, env, [row]))[0];
}

// `/native/credentials` { action: list | create | rotate | revoke | grant | ungrant }. Browser sessions only; values never come back.
export async function credentialsAPI(db, env, person, request, body) {
  const state = await vaultState(db, env);
  if (!await vaultSchema(db)) refuse(state.reason);
  if (body.action === 'list') {
    const scope = await resolveScope(db, person, body), manage = await canManageScope(db, person, request, scope.scope, scope.ownerId);
    // Organization members see their organization's credential labels; only owners change them.
    if (!manage && !(scope.scope === 'organization' && await db.prepare('SELECT 1 AS ok FROM native_owner_members WHERE owner_id=? AND user_id=?').bind(Number(scope.ownerId), person.id).first())) forbidden(managers[scope.scope]);
    const { results } = await db.prepare('SELECT * FROM vault_credentials WHERE scope=? AND owner_id=? ORDER BY revoked_at IS NOT NULL,label,id LIMIT 200').bind(scope.scope, scope.ownerId).all();
    const credentials = await credentialViews(db, env, results);
    // Personal scope also lists credentials others shared with this person (metadata only).
    const shared = scope.scope === 'user' ? await credentialViews(db, env, (await db.prepare(`SELECT c.* FROM vault_credentials c WHERE c.revoked_at IS NULL AND NOT (c.scope='user' AND c.owner_id=?)
      AND EXISTS(SELECT 1 FROM vault_credential_grants g WHERE g.credential_id=c.id AND (g.grantee_kind='user' AND g.grantee_id=? OR g.grantee_kind='installation'
        OR g.grantee_kind='organization' AND g.grantee_id IN (SELECT CAST(owner_id AS TEXT) FROM native_owner_members WHERE user_id=?))) ORDER BY c.label LIMIT 200`).bind(String(person.id), String(person.id), person.id).all()).results) : [];
    return { scope: { scope: scope.scope, ownerId: scope.ownerId, label: scope.label }, credentials, sharedWithYou: shared.map(({ grants, ...rest }) => rest), canManage: manage, ready: state.ready, reason: state.reason,
      providers: Object.entries(providers).map(([id, label]) => ({ id, label })), tools: Object.entries(subscriptionTools).map(([id, tool]) => ({ id, label: tool.label, providers: tool.providers })),
      places, subscriptionTerms, limit: maximumCredentials };
  }
  browserOnly(env, request);
  if (!state.ready) refuse(state.reason);
  if (body.action === 'create') {
    if (!fields(body, ['action', 'scope', 'organization', 'kind', 'provider', 'tool', 'label', 'value', 'grants', 'acceptTerms'])) invalid('Unknown field.');
    const scope = await resolveScope(db, person, body);
    if (!await canManageScope(db, person, request, scope.scope, scope.ownerId)) forbidden(managers[scope.scope]);
    return { credential: await createCredential(db, env, person, request, scope, body) };
  }
  if (body.action === 'rotate') {
    if (!fields(body, ['action', 'id', 'expectedVersion', 'value'])) invalid('Unknown field.');
    return { credential: await rotateCredential(db, env, person, request, body) };
  }
  if (body.action === 'revoke') {
    if (!fields(body, ['action', 'id'])) invalid('Unknown field.');
    return { credential: await revokeCredential(db, env, person, request, body) };
  }
  if (body.action === 'grant') {
    if (!fields(body, ['action', 'id', 'granteeKind', 'grantee', 'engines', 'places'])) invalid('Unknown field.');
    return { credential: await grantCredential(db, env, person, request, body) };
  }
  if (body.action === 'ungrant') {
    if (!fields(body, ['action', 'id', 'grantId'])) invalid('Unknown field.');
    return { credential: await ungrantCredential(db, env, person, request, body) };
  }
  invalid('Use list, create, rotate, revoke, grant or ungrant.');
}

// ---------- use: credentialFor ----------
// Handles are unforgeable: only this module issues them, and only engines.mjs opens them (openCredential), for one outbound call.
const issued = new WeakMap();
async function useDenied(db, env, person, credential, repository, reason, code) {
  try {
    const where = repository ? { scope: 'repository', scopeId: String(repository.id) } : auditScope(env, credential);
    await db.prepare(`INSERT INTO installation_audit(at,actor_id,actor_email,scope,scope_id,subject,action,before,after,widening,operation_id,client) VALUES(?,?,'',?,?,?,'credential.use_denied',NULL,?,0,NULL,?)`)
      .bind(time(), person?.id || 0, where.scope, where.scopeId, credential.label, JSON.stringify({ credentialId: credential.id, reason: code }),
        JSON.stringify({ via: 'engine', login: person?.login || undefined, outcome: 'denied', code: 'permission_denied' })).run();
  } catch { console.log(JSON.stringify({ event: 'golf.audit_write_failed', action: 'credential.use_denied' })); }
  return { refusal: reason, code };
}
async function granted(db, person, credential, engineId, place, repository) {
  if (credential.scope === 'user' && credential.owner_id === String(person.id)) return true;
  const { results } = await db.prepare('SELECT * FROM vault_credential_grants WHERE credential_id=?').bind(credential.id).all();
  for (const grant of results) {
    const engines = parse(grant.engines, []), where = parse(grant.places, []);
    if (engines.length && !engines.includes(engineId) || !where.includes(place)) continue;
    if (grant.grantee_kind === 'installation') return true;
    if (grant.grantee_kind === 'user' && grant.grantee_id === String(person.id)) return true;
    if (grant.grantee_kind === 'organization') {
      const member = await db.prepare('SELECT 1 AS ok FROM native_owner_members WHERE owner_id=? AND user_id=?').bind(Number(grant.grantee_id), person.id).first();
      const inside = !repository || (await db.prepare("SELECT 1 AS ok FROM repository_owners ro JOIN native_owners o ON o.id=ro.owner_id WHERE ro.repository_id=? AND o.id=? AND o.kind='ORGANIZATION'").bind(Number(repository.id), Number(grant.grantee_id)).first());
      if (member && inside) return true;
    }
    if (grant.grantee_kind === 'repository' && repository && grant.grantee_id === String(repository.id) &&
        await db.prepare('SELECT 1 AS ok FROM grants WHERE repository_id=? AND user_id=?').bind(Number(repository.id), person.id).first()) return true;
  }
  return false;
}
/* credentialFor(db, env, { person, engine, place, repository?, dryRun? }) → { credential: handle | null } or { refusal, code }.
 * engine is an engine row or view (id, credential_id or credentialId, places, enabled); place is cloud, agent-host or ssh-host. A null
 * credential means the engine needs none (Workers AI). Every refusal except dryRun is audited as credential.use_denied (never the value). */
export async function credentialFor(db, env, { person, engine, place, repository = null, dryRun = false }) {
  const credentialId = engine?.credential_id ?? engine?.credentialId ?? null;
  if (!credentialId) return { credential: null };
  const state = await vaultState(db, env);
  if (!state.ready) return { refusal: state.reason, code: 'vault_unavailable' };
  const credential = await db.prepare('SELECT id,scope,owner_id,kind,provider,tool,label,version,revoked_at,sealed_value IS NOT NULL AS sealed FROM vault_credentials WHERE id=?').bind(credentialId).first();
  const refused = (reason, code) => dryRun ? { refusal: reason, code } : useDenied(db, env, person, credential, repository, reason, code);
  if (!credential) return { refusal: 'The credential this engine uses no longer exists.', code: 'missing' };
  if (credential.revoked_at || !credential.sealed) return refused(`Credential ${credential.label} was revoked.`, 'revoked');
  const enginePlaces = Array.isArray(engine.places) ? engine.places : parse(engine.places, []);
  if (!places.includes(place) || !enginePlaces.includes(place)) return refused(`This engine does not run in the ${place} place.`, 'place');
  if (credential.kind === 'subscription') return refused(`Credential ${credential.label} is a subscription sign-in: ${subscriptionRefusal}.`, 'subscription');
  const active = await db.prepare('SELECT 1 AS ok FROM users WHERE id=? AND active=1').bind(Number(person?.id || 0)).first();
  if (!active || !await granted(db, person, credential, engine.id, place, repository)) return refused(`You are not allowed to use credential ${credential.label}${repository ? ' in this repository' : ''}. Its owner shares it explicitly.`, 'not_granted');
  const handle = Object.freeze({ id: credential.id, label: credential.label, provider: credential.provider, kind: credential.kind, scope: credential.scope, version: credential.version });
  issued.set(handle, { id: credential.id, version: credential.version });
  if (!dryRun) try { await db.prepare('UPDATE vault_credentials SET last_used_at=? WHERE id=?').bind(time(), credential.id).run(); } catch { /* best effort */ }
  return { credential: handle };
}
// For engines.mjs only: the plaintext of an issued handle, read and opened at the moment of the call. It is never stored or returned.
export async function openCredential(env, handle) {
  const proof = issued.get(handle);
  if (!proof) throw Error('Not an issued credential handle');
  const row = await env.DB.withSession('first-primary').prepare('SELECT sealed_value,version,revoked_at FROM vault_credentials WHERE id=?').bind(proof.id).first();
  if (!row?.sealed_value || row.revoked_at || row.version !== proof.version) throw Error('The credential was revoked or rotated');
  try { return new TextDecoder().decode(await openSecret(env, row.sealed_value, credentialContext(proof.id, proof.version))); }
  catch { throw Error('The credential could not be opened'); }
}
export const issuedHandle = handle => issued.has(handle);
