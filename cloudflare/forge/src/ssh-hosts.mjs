// SSH hosts (docs/SSH_HOSTS.md, agents plan phases 1b and 5): machines Golf reaches over SSH, with the coding CLIs installed and
// signed in there and no Golf software. Each is an agent_hosts row (credential digest 'ssh:<uuid>') plus an ssh_hosts row, so sharing,
// admission, task states, deadlines, cancel and the LOST sweep are the agent host ones (agent-hosts.mjs). What differs:
// - Golf generates one Ed25519 key per host; the private key and reach secrets are sealed with the vault envelope (vault.mjs) and leave the Worker only
//   in the job a task's own container receives on standard input;
// - the host key is pinned only after a person confirmed the fingerprint a connection test reported (trust on first use, explicitly);
// - no host polls: Golf claims a queued task itself (the same claim as agent-host-protocol.mjs) and hands it to the SSHAgentTask
//   Durable Object (ssh-task.mjs), whose container runs `golf-agent-host ssh-run` against the host and reports through the task routes.
import { Fault, invalid, deny, digest } from './common.mjs';
import { admissionRefusal, agentTools, canManage, deleteHost, fields, forbidden, hostViews, managerMessage, maxDuration, now, organization, parse, plain,
  isReview, random, refuse, repositoryRow, scopes, sshHost, targetURL, terminalStates } from './agent-hosts.mjs';
import { ownerSlug } from './owners.mjs';
import { openSecret, sealSecret, sealedKeyId } from './vault.mjs';

// Golf's per-host key and reach secrets are sealed with the credential vault's envelope (vault.mjs), under EXECUTION_VALUE_KEY.
const sealState = env => env.EXECUTION_VALUE_KEY?.get ? { ready: true, reason: '' }
  : { ready: false, reason: 'Sealing SSH host keys needs the installation encryption key (the EXECUTION_VALUE_KEY Secrets Store binding the credential vault uses).' };

export const reaches = ['direct', 'tailscale', 'cloudflare-tunnel', 'workers-vpc'];
export const vpcBridgePort = 2222;
// Sealed with the vault interface, bound to the host and the purpose ('key' or 'reach'); seal_key_id names the installation key.
const sealFor = async (env, uuid, purpose, value) => { const sealed = await sealSecret(env, value, `ssh-host:${uuid}:${purpose}`); return { sealed, keyId: sealedKeyId(sealed) }; };
const openFor = async (env, uuid, purpose, sealed) => new TextDecoder().decode(await openSecret(env, sealed, `ssh-host:${uuid}:${purpose}`));
const probeTimeout = 5 * 60_000;
const text = new TextEncoder();
const b64 = bytes => btoa(String.fromCharCode(...bytes));
const unb64 = value => Uint8Array.from(atob(value), c => c.charCodeAt(0));
const sshString = bytes => { const out = new Uint8Array(4 + bytes.length); new DataView(out.buffer).setUint32(0, bytes.length); out.set(bytes, 4); return out; };
const join = (...parts) => { const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0)); let at = 0; for (const p of parts) { out.set(p, at); at += p.length; } return out; };
export const fingerprintOf = async blob => 'SHA256:' + b64(new Uint8Array(await crypto.subtle.digest('SHA-256', blob))).replace(/=+$/, '');

// ---------- schema, readiness, capability ----------
let migrated = false;
export async function sshSchema(db) {
  if (!migrated) migrated = Boolean((await db.prepare('PRAGMA table_info(ssh_hosts)').all()).results.length);
  return migrated;
}
async function requireSchema(db) { if (!await sshSchema(db)) refuse('SSH hosts need the schema 47 migration on this installation.'); }
// Execution needs the SSHAgentTask Durable Object with its container (deploy: SSH_HOSTS_EXECUTION) and the sealing key.
function executionMissing(env) {
  const missing = [];
  if (env.SSH_HOSTS_EXECUTION !== 'true' || !env.sshTasks) missing.push('the SSHAgentTask Durable Object with its SSH container (SSH_HOSTS_EXECUTION)');
  if (!sealState(env).ready) missing.push('the EXECUTION_VALUE_KEY Secrets Store encryption key');
  return missing;
}
export const executionReady = env => !executionMissing(env).length;
// What each reach needs beyond the container. Workers VPC is a Durable Object TCP bridge to a vpc_networks binding.
export function reachStates(env) {
  const missing = executionMissing(env), base = missing.length ? `Needs ${missing.join(' and ')}.` : '';
  return Object.fromEntries(reaches.map(reach => {
    const reason = base || (reach === 'workers-vpc' && !env.SSH_VPC_NETWORK?.connect ? 'Needs a Workers VPC network binding named SSH_VPC_NETWORK on this Worker (vpc_networks: a Cloudflare Tunnel or Cloudflare Mesh). The bridge is implemented but not yet verified against a real VPC network.' : '');
    return [reach, { available: !reason, reason }];
  }));
}
export async function sshCapability(db, env) {
  if (!await sshSchema(db)) return { id: 'agents.ssh-hosts', label: 'Coding agents on SSH hosts', state: 'CAPABILITY_STATE_DISABLED', reason: 'Apply the schema 47 migration to add SSH hosts.' };
  const missing = executionMissing(env);
  if (missing.length) return { id: 'agents.ssh-hosts', label: 'Coding agents on SSH hosts', state: 'CAPABILITY_STATE_UNCONFIGURED',
    reason: `SSH hosts are unavailable on this installation: it needs ${missing.join(' and ')}. See docs/SSH_HOSTS.md, "Deploy changes needed".` };
  return { id: 'agents.ssh-hosts', label: 'Coding agents on SSH hosts', state: 'CAPABILITY_STATE_READY',
    reason: 'Register a machine Golf reaches over SSH (directly, through Tailscale or through Cloudflare Tunnel' + (env.SSH_VPC_NETWORK?.connect ? ', or Workers VPC' : '') +
      ') with Codex, Claude Code, OpenCode or Grok installed and signed in there. Golf generates a key for it, pins its host key after you confirm the fingerprint, and runs each task in a fresh working copy on the machine; the result is a proposal branch with a live log. No Golf software runs on the machine.' };
}
// Why an SSH host cannot take a task now, or '' (admission rule 3 for SSH hosts).
export async function sshNotReady(db, env, host) {
  if (!await sshSchema(db)) return `SSH host ${host.name} needs the schema 47 migration.`;
  const row = await db.prepare('SELECT reach,host_key FROM ssh_hosts WHERE host_id=?').bind(host.id).first();
  if (!row) return `SSH host ${host.name} has no connection settings.`;
  const reach = reachStates(env)[row.reach];
  if (!reach?.available) return `SSH host ${host.name} cannot be reached: ${reach?.reason || 'unknown reach.'}`;
  if (!row.host_key) return `SSH host ${host.name} has no confirmed host key yet; test the connection and confirm its fingerprint.`;
  return '';
}

// ---------- keys ----------
// One Ed25519 key per host: the public key in OpenSSH form, its SHA256 fingerprint and the PKCS#8 private key (base64) for sealing.
export async function sshKeyPair(comment) {
  const pair = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
  const raw = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey)), pkcs8 = new Uint8Array(await crypto.subtle.exportKey('pkcs8', pair.privateKey));
  const blob = join(sshString(text.encode('ssh-ed25519')), sshString(raw));
  return { publicKey: `ssh-ed25519 ${b64(blob)} ${comment}`, fingerprint: await fingerprintOf(blob), privateKey: b64(pkcs8) };
}
const hostKeyTypes = ['ssh-ed25519', 'ecdsa-sha2-nistp256', 'ecdsa-sha2-nistp384', 'ecdsa-sha2-nistp521', 'ssh-rsa'];
// A host key as a connection test reports it ("type base64"): the blob must name the same type; the fingerprint is computed here.
export async function parseHostKey(value) {
  const match = typeof value === 'string' && value.length <= 4096 ? /^([a-z0-9-]{1,40}) ([A-Za-z0-9+/]{20,4000}={0,2})$/.exec(value.trim()) : null;
  if (!match || !hostKeyTypes.includes(match[1])) return null;
  let blob;
  try { blob = unb64(match[2]); } catch { return null; }
  if (blob.length < 8) return null;
  const length = new DataView(blob.buffer).getUint32(0);
  if (length !== match[1].length || new TextDecoder().decode(blob.subarray(4, 4 + length)) !== match[1]) return null;
  return { key: `${match[1]} ${match[2]}`, type: match[1], fingerprint: await fingerprintOf(blob) };
}

// ---------- validation ----------
const hostname = value => typeof value === 'string' && value.length <= 253 && (/^(?=.{1,253}$)(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$/.test(value) ||
  /^(?:\d{1,3}\.){3}\d{1,3}$/.test(value) && value.split('.').every(n => Number(n) <= 255) || /^[0-9a-fA-F:]{2,39}$/.test(value) && value.includes(':'));
const loginName = value => typeof value === 'string' && /^[A-Za-z_][A-Za-z0-9_.-]{0,31}$/.test(value);
const workDirectory = value => value === '' || typeof value === 'string' && value.length <= 200 && /^\/[A-Za-z0-9._/-]*$/.test(value) && !value.split('/').some(part => part === '..' || part === '.') && !/\/\//.test(value);
const tag = value => typeof value === 'string' && /^tag:[a-z0-9][a-z0-9-]{0,49}$/.test(value);
const tailscaleKey = value => typeof value === 'string' && /^tskey-[A-Za-z0-9_-]{8,200}$/.test(value);
const accessId = value => typeof value === 'string' && /^[A-Za-z0-9._-]{8,128}$/.test(value);
const accessSecret = value => typeof value === 'string' && /^[A-Za-z0-9._-]{16,256}$/.test(value);
const usage = 'Use an address (host name or IP), a port 1–65535, an account name, an absolute work directory or none, and a reach: direct, tailscale, cloudflare-tunnel or workers-vpc.';

// The connection settings from a create or update body over the stored ones. Secrets stay apart from the non-secret settings.
function connection(body, stored = {}) {
  const value = { address: body.address ?? stored.address, port: body.port ?? stored.port ?? 22, login: body.user ?? stored.login, workDirectory: body.workDirectory ?? stored.work_directory ?? '',
    reach: body.reach ?? stored.reach ?? 'direct' };
  if (!hostname(value.address) || !Number.isInteger(value.port) || value.port < 1 || value.port > 65535 || !loginName(value.login) || !workDirectory(value.workDirectory) || !reaches.includes(value.reach)) invalid(usage);
  const settings = parse(stored.reach_settings, {}), secrets = { ...(stored.secrets || {}) };
  const reachChanged = stored.reach !== undefined && value.reach !== stored.reach;
  const next = reachChanged ? {} : { ...settings }, nextSecrets = reachChanged ? {} : secrets;
  if (value.reach === 'tailscale') {
    const t = body.tailscale ?? {};
    if (typeof t !== 'object' || Array.isArray(t) || Object.keys(t).some(key => !['authKey', 'tags'].includes(key))) invalid('Tailscale settings are an auth key and tags.');
    if (t.tags !== undefined && (!Array.isArray(t.tags) || t.tags.length > 8 || new Set(t.tags).size !== t.tags.length || !t.tags.every(tag))) invalid('Use up to 8 Tailscale tags like tag:golf-agent.');
    if (t.authKey !== undefined && !tailscaleKey(t.authKey)) invalid('Use a Tailscale auth key (tskey-…). Create it reusable, ephemeral and pre-approved, tagged for the tags you name.');
    next.tags = t.tags ?? next.tags ?? [];
    if (t.authKey !== undefined) nextSecrets.tailscaleAuthKey = t.authKey;
    if (!nextSecrets.tailscaleAuthKey) invalid('Tailscale reach needs an auth key.');
  } else if (body.tailscale !== undefined) invalid('Tailscale settings apply only to the tailscale reach.');
  if (value.reach === 'cloudflare-tunnel') {
    const c = body.tunnel ?? {};
    if (typeof c !== 'object' || Array.isArray(c) || Object.keys(c).some(key => !['clientId', 'clientSecret'].includes(key))) invalid('Cloudflare Tunnel settings are an Access service token id and secret.');
    if (c.clientId !== undefined && c.clientId !== '' && !accessId(c.clientId) || c.clientSecret !== undefined && c.clientSecret !== '' && !accessSecret(c.clientSecret)) invalid('Use the Access service token id and secret exactly as Cloudflare shows them.');
    if (c.clientId !== undefined) next.clientId = c.clientId;
    if (c.clientSecret !== undefined) { if (c.clientSecret) nextSecrets.accessClientSecret = c.clientSecret; else delete nextSecrets.accessClientSecret; }
    if (Boolean(next.clientId) !== Boolean(nextSecrets.accessClientSecret)) invalid('An Access service token needs both its id and its secret, or neither.');
  } else if (body.tunnel !== undefined) invalid('Cloudflare Tunnel settings apply only to the cloudflare-tunnel reach.');
  if (value.reach === 'workers-vpc' && value.address.endsWith('.')) invalid(usage);
  return { ...value, settings: next, secrets: nextSecrets };
}

// ---------- views ----------
async function sshViews(db, env, rows) {
  if (!rows.length) return [];
  const base = await hostViews(db, env, rows), states = reachStates(env);
  const pinners = [...new Set(rows.map(row => row.host_key_pinned_by).filter(Boolean))];
  const logins = new Map(pinners.length ? (await db.prepare('SELECT id,login FROM users WHERE id IN (SELECT value FROM json_each(?))').bind(JSON.stringify(pinners)).all()).results.map(u => [u.id, u.login]) : []);
  return rows.map((row, i) => {
    const settings = parse(row.reach_settings, {}), probe = parse(row.probe_result, {}), reach = states[row.reach];
    const ready = reach.available && Boolean(row.host_key);
    return { ...base[i], kind: 'ssh', online: ready && row.probe_state === 'SUCCEEDED' && probe.authenticated === true,
      address: row.address, port: row.port, user: row.login, workDirectory: row.work_directory, reach: row.reach, reachAvailable: reach.available, reachReason: reach.reason,
      tailscale: row.reach === 'tailscale' ? { tags: settings.tags || [], ephemeral: true, authKeySet: true } : null,
      tunnel: row.reach === 'cloudflare-tunnel' ? { clientId: settings.clientId || '', clientSecretSet: Boolean(settings.clientId) } : null,
      publicKey: row.public_key, keyFingerprint: row.key_fingerprint,
      hostKey: { pinned: Boolean(row.host_key), fingerprint: row.host_key_fingerprint, type: row.host_key.split(' ')[0] || '', pinnedAt: row.host_key_pinned_at || '', pinnedBy: logins.get(row.host_key_pinned_by) || '' },
      probe: { state: row.probe_state, startedAt: row.probe_started_at || '', finishedAt: row.probe_finished_at || '', offered: probe.offered || null, matched: probe.matched ?? null,
        authenticated: probe.authenticated ?? null, os: probe.os || '', arch: probe.arch || '', toolCount: Array.isArray(probe.tools) ? probe.tools.length : 0, error: probe.error || '' },
      ready, readyReason: !reach.available ? reach.reason : !row.host_key ? 'Test the connection and confirm the host key fingerprint before assigning tasks.' : '' };
  });
}
const sshSelect = "SELECT h.*,s.* FROM agent_hosts h JOIN ssh_hosts s ON s.host_id=h.id";
const authorizedLine = publicKey => `restrict ${publicKey}`;
const installCommand = publicKey => `umask 077 && mkdir -p ~/.ssh && printf '%s\\n' '${authorizedLine(publicKey)}' >> ~/.ssh/authorized_keys`;

async function sshRow(db, id) {
  return /^[1-9][0-9]{0,15}$/.test(String(id || '')) ? db.prepare(sshSelect + ' WHERE h.id=? AND h.deleted=0').bind(Number(id)).first() : null;
}
async function storedSecrets(env, row) {
  return row.secrets_sealed ? JSON.parse(await openFor(env, row.uuid, 'reach', row.secrets_sealed)) : {};
}

// ---------- user API: POST /native/ssh-hosts ----------
export async function sshHostsAPI(db, env, person, request, body) {
  await requireSchema(db);
  const action = body.action;
  if (['list', 'create'].includes(action)) {
    if (!scopes.includes(body.scope)) invalid('Choose personal, organization or installation scope.');
    const scopeId = body.scope === 'personal' ? String(person.id) : body.scope === 'organization' ? await organization(db, body.organization) : '';
    const manage = await canManage(db, person, request, body.scope, scopeId);
    if (action === 'list') {
      if (!manage && !(body.scope === 'organization' && await db.prepare('SELECT 1 AS ok FROM native_owner_members WHERE owner_id=? AND user_id=?').bind(Number(scopeId), person.id).first())) forbidden(managerMessage[body.scope]);
      const { results } = await db.prepare(sshSelect + ' WHERE h.scope=? AND h.scope_id=? AND h.deleted=0 ORDER BY h.name,h.id LIMIT 100').bind(body.scope, scopeId).all();
      const views = await sshViews(db, env, results);
      return { hosts: manage ? views : views.map(({ publicKey, ...view }) => view), canManage: manage, capability: await sshCapability(db, env), reaches: reachStates(env) };
    }
    if (!manage) forbidden(managerMessage[body.scope]);
    if (!fields(body, ['action', 'scope', 'organization', 'name', 'address', 'port', 'user', 'workDirectory', 'reach', 'tailscale', 'tunnel', 'enabledTools'])) invalid('Unknown field.');
    if (!plain(body.name, 128)) invalid('Name the host (at most 128 characters).');
    if (body.enabledTools !== undefined && (!Array.isArray(body.enabledTools) || new Set(body.enabledTools).size !== body.enabledTools.length || body.enabledTools.some(tool => !agentTools.includes(tool))))
      invalid('Use tools from codex, claude, opencode and grok.');
    const value = connection(body);
    const sealing = sealState(env);
    if (!sealing.ready) refuse(sealing.reason);
    const reach = reachStates(env)[value.reach];
    if (!reach.available) refuse(`The ${value.reach} reach is unavailable on this installation: ${reach.reason}`);
    if ((await db.prepare('SELECT COUNT(*) AS n FROM agent_hosts WHERE scope=? AND scope_id=? AND deleted=0').bind(body.scope, scopeId).first()).n >= 100) refuse('This scope already has 100 agent hosts.');
    const uuid = crypto.randomUUID(), keys = await sshKeyPair(`golf-ssh-host-${uuid.slice(0, 8)}`), time = now();
    const privateKey = await sealFor(env, uuid, 'key', keys.privateKey);
    const secrets = Object.keys(value.secrets).length ? await sealFor(env, uuid, 'reach', JSON.stringify(value.secrets)) : null;
    if (secrets && secrets.keyId !== privateKey.keyId) throw Error('The sealing key changed while sealing');
    const tools = body.enabledTools ? agentTools.filter(tool => body.enabledTools.includes(tool)) : agentTools;
    await db.batch([
      db.prepare("INSERT INTO agent_hosts(uuid,name,scope,scope_id,registered_by,credential_digest,enabled_tools,host_version,created_at) VALUES(?,?,?,?,?,?,?,'ssh',?)")
        .bind(uuid, body.name.trim(), body.scope, scopeId, body.scope === 'personal' ? Number(scopeId) : person.id, 'ssh:' + uuid, JSON.stringify(tools), time),
      db.prepare(`INSERT INTO ssh_hosts(host_id,address,port,login,work_directory,reach,reach_settings,public_key,key_fingerprint,private_key_sealed,secrets_sealed,seal_key_id,created_at,updated_at)
        SELECT id,?,?,?,?,?,?,?,?,?,?,?,?,? FROM agent_hosts WHERE uuid=?`).bind(value.address, value.port, value.login, value.workDirectory, value.reach, JSON.stringify(value.settings), keys.publicKey,
        keys.fingerprint, privateKey.sealed, secrets?.sealed || '', privateKey.keyId, time, time, uuid),
    ]);
    const row = await db.prepare(sshSelect + ' WHERE h.uuid=?').bind(uuid).first();
    return { host: (await sshViews(db, env, [row]))[0], publicKey: keys.publicKey, authorizedKey: authorizedLine(keys.publicKey), installCommand: installCommand(keys.publicKey) };
  }
  if (!['update', 'delete', 'test', 'trustHostKey', 'rotateKey'].includes(action)) invalid('Unknown SSH host operation.');
  const row = await sshRow(db, body.id);
  if (!row) deny();
  if (!await canManage(db, person, request, row.scope, row.scope_id)) forbidden(managerMessage[row.scope]);
  const time = now(), view = async () => ({ host: (await sshViews(db, env, [await db.prepare(sshSelect + ' WHERE h.id=?').bind(row.host_id).first()]))[0] });
  if (action === 'delete') {
    // The key and reach secrets are erased with the host; running tasks are told to stop (their containers stop on the next tick).
    await db.batch([...deleteHost(db, { id: row.host_id }), db.prepare('DELETE FROM ssh_hosts WHERE host_id=?').bind(row.host_id)]);
    return { ok: true };
  }
  if (action === 'test') {
    if (!fields(body, ['action', 'id', 'scope', 'organization'])) invalid('Unknown field.');
    const reach = reachStates(env)[row.reach];
    if (!reach.available) refuse(`The ${row.reach} reach is unavailable on this installation: ${reach.reason}`);
    if (row.probe_state === 'RUNNING' && Date.parse(row.probe_started_at) > Date.now() - probeTimeout) throw new Fault('aborted', 409, 'A connection test is already running for this host.');
    const probeId = crypto.randomUUID();
    const changed = await db.prepare("UPDATE ssh_hosts SET probe_id=?,probe_state='RUNNING',probe_started_at=?,probe_finished_at=NULL,updated_at=? WHERE host_id=? AND (probe_id IS ? OR probe_id=?)")
      .bind(probeId, time, time, row.host_id, row.probe_id, row.probe_id).run();
    if (changed.meta.changes !== 1) throw new Fault('aborted', 409, 'A connection test is already running for this host.');
    try { await env.sshTasks.getByName('probe:' + probeId).probe({ probeId, hostId: row.host_id }); }
    catch { await recordSSHProbe(db, env, row.host_id, probeId, { authenticated: false, error: 'Golf could not start the connection test.' }); }
    return view();
  }
  if (action === 'trustHostKey') {
    // Trust on first use, explicitly: the person confirms the fingerprint the latest test was offered; nothing is pinned without it.
    if (!fields(body, ['action', 'id', 'scope', 'organization', 'fingerprint', 'expectedVersion']) || typeof body.fingerprint !== 'string') invalid('Confirm the fingerprint the connection test showed.');
    if (body.expectedVersion !== row.version) refuse('The SSH host changed; refresh before confirming its host key.');
    const offered = parse(row.probe_result, {}).offered;
    if (!offered || row.probe_state === 'RUNNING') refuse('Test the connection first; Golf pins only a host key a test was offered.');
    if (offered.fingerprint !== body.fingerprint) refuse('That fingerprint is not the one the latest connection test was offered; test again and compare.');
    const changed = await db.batch([
      // Pinned only if the host version and the test result read above still stand: a move or rotation in between clears them.
      db.prepare(`UPDATE ssh_hosts SET host_key=?,host_key_fingerprint=?,host_key_pinned_by=?,host_key_pinned_at=?,updated_at=? WHERE host_id=? AND probe_id=? AND probe_state<>'RUNNING' AND probe_result=?
        AND EXISTS(SELECT 1 FROM agent_hosts WHERE id=? AND version=? AND deleted=0)`).bind(offered.key, offered.fingerprint, person.id, time, time, row.host_id, row.probe_id, row.probe_result, row.host_id, row.version),
      db.prepare('UPDATE agent_hosts SET version=version+1 WHERE id=? AND changes()=1').bind(row.host_id),
    ]);
    if (changed[0].meta.changes !== 1) refuse('The connection test changed; refresh and confirm again.');
    return view();
  }
  if (action === 'rotateKey') {
    if (!fields(body, ['action', 'id', 'scope', 'organization', 'expectedVersion'])) invalid('Unknown field.');
    if (body.expectedVersion !== row.version) refuse('The SSH host changed; refresh before saving.');
    const keys = await sshKeyPair(`golf-ssh-host-${row.uuid.slice(0, 8)}`), sealed = await sealFor(env, row.uuid, 'key', keys.privateKey);
    if (sealed.keyId !== row.seal_key_id && row.secrets_sealed) refuse('The sealing key changed; re-enter the reach secrets with Connection settings first.');
    const changed = await db.batch([
      db.prepare('UPDATE agent_hosts SET version=version+1 WHERE id=? AND version=?').bind(row.host_id, row.version),
      db.prepare("UPDATE ssh_hosts SET public_key=?,key_fingerprint=?,private_key_sealed=?,seal_key_id=?,probe_state='NONE',probe_result='{}',updated_at=? WHERE host_id=? AND changes()=1")
        .bind(keys.publicKey, keys.fingerprint, sealed.sealed, sealed.keyId, time, row.host_id),
    ]);
    if (changed[1].meta.changes !== 1) refuse('The SSH host changed; refresh before saving.');
    return { ...await view(), publicKey: keys.publicKey, authorizedKey: authorizedLine(keys.publicKey), installCommand: installCommand(keys.publicKey) };
  }
  // update: the connection settings. Sharing, tools, state and concurrency are the agent host fields (/native/agent-hosts update).
  if (!fields(body, ['action', 'id', 'scope', 'organization', 'expectedVersion', 'name', 'address', 'port', 'user', 'workDirectory', 'reach', 'tailscale', 'tunnel'])) invalid('Unknown field.');
  if (body.expectedVersion !== row.version) refuse('The SSH host changed; refresh before saving.');
  if (body.name !== undefined && !plain(body.name, 128)) invalid('Name the host (at most 128 characters).');
  const value = connection(body, { ...row, secrets: await storedSecrets(env, row) });
  if (value.reach !== row.reach && !reachStates(env)[value.reach].available) refuse(`The ${value.reach} reach is unavailable on this installation: ${reachStates(env)[value.reach].reason}`);
  // Another machine may answer at a new address or through a new reach: its key must be confirmed again, and its tools reported again.
  const moved = value.address !== row.address || value.port !== row.port || value.reach !== row.reach, relogged = moved || value.login !== row.login;
  const secrets = Object.keys(value.secrets).length ? await sealFor(env, row.uuid, 'reach', JSON.stringify(value.secrets)) : null;
  if (secrets && secrets.keyId !== row.seal_key_id) refuse('The sealing key changed; rotate Golf’s key for this host first.');
  const changed = await db.batch([
    db.prepare('UPDATE agent_hosts SET name=?,version=version+1 WHERE id=? AND version=? AND deleted=0').bind(body.name === undefined ? row.name : body.name.trim(), row.host_id, row.version),
    db.prepare(`UPDATE ssh_hosts SET address=?,port=?,login=?,work_directory=?,reach=?,reach_settings=?,secrets_sealed=?,updated_at=?${moved ? ",host_key='',host_key_fingerprint='',host_key_pinned_by=NULL,host_key_pinned_at=NULL" : ''}${relogged ? ",probe_state='NONE',probe_result='{}'" : ''} WHERE host_id=? AND changes()=1`)
      .bind(value.address, value.port, value.login, value.workDirectory, value.reach, JSON.stringify(value.settings), secrets?.sealed || '', time, row.host_id),
    ...(relogged ? [db.prepare('DELETE FROM agent_host_tools WHERE host_id=? AND changes()=1').bind(row.host_id)] : []),
  ]);
  if (changed[0].meta.changes !== 1) refuse('The SSH host changed; refresh before saving.');
  return view();
}

// ---------- connection tests (the SSHAgentTask probe reports here) ----------
const probeOS = value => typeof value === 'string' && /^[a-z0-9_.-]{0,32}$/.test(value) ? value : '';
const reported = (value, max) => typeof value === 'string' && value.length <= max && !/[\x00-\x1f\x7f]/.test(value);
export async function recordSSHProbe(db, env, hostId, probeId, result) {
  const offered = result?.hostKey ? await parseHostKey(result.hostKey) : null;
  const tools = Array.isArray(result?.tools) ? result.tools.filter(item => item && agentTools.includes(item.tool) && reported(item.version ?? '', 64) && [true, false, null].includes(item.signedIn ?? null) && reported(item.account ?? '', 128)).slice(0, 8) : [];
  const authenticated = result?.authenticated === true && Boolean(offered);
  const stored = { offered: offered && { key: offered.key, type: offered.type, fingerprint: offered.fingerprint }, matched: typeof result?.matched === 'boolean' ? result.matched : null, authenticated,
    os: probeOS(result?.os), arch: probeOS(result?.arch), tools: tools.map(item => ({ tool: item.tool, version: item.version ?? '', signedIn: item.signedIn ?? null })),
    error: typeof result?.error === 'string' ? result.error.replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, 512) : '' };
  const time = now(), row = await db.prepare('SELECT host_key FROM ssh_hosts WHERE host_id=? AND probe_id=?').bind(hostId, probeId).first();
  if (!row) return { recorded: false };
  // Signed-in tools count only when the host proved the pinned key; a mismatch never updates anything but the test result.
  const proven = authenticated && row.host_key && offered.key === row.host_key && stored.matched === true;
  await db.batch([
    db.prepare("UPDATE ssh_hosts SET probe_state=?,probe_result=?,probe_finished_at=?,updated_at=? WHERE host_id=? AND probe_id=?")
      .bind(proven || !row.host_key && offered && !stored.error ? 'SUCCEEDED' : 'FAILED', JSON.stringify(stored), time, time, hostId, probeId),
    ...(proven ? [
      db.prepare('DELETE FROM agent_host_tools WHERE host_id=? AND tool NOT IN (SELECT value FROM json_each(?))').bind(hostId, JSON.stringify(tools.map(item => item.tool))),
      ...tools.map(item => db.prepare(`INSERT INTO agent_host_tools(host_id,tool,version,signed_in,account,updated_at) VALUES(?,?,?,?,?,?)
        ON CONFLICT(host_id,tool) DO UPDATE SET version=excluded.version,signed_in=excluded.signed_in,account=excluded.account,updated_at=excluded.updated_at`)
        .bind(hostId, item.tool, item.version ?? '', item.signedIn === null || item.signedIn === undefined ? null : item.signedIn ? 1 : 0, item.account ?? '', time)),
      db.prepare('UPDATE agent_hosts SET os=?,arch=?,last_seen_at=? WHERE id=?').bind(stored.os, stored.arch, time, hostId),
    ] : []),
  ]);
  return { recorded: true };
}

// The connection a container receives (on standard input, never in its environment or argv): the only place secrets are opened.
export async function sshConnectionJob(db, env, hostId) {
  const row = await db.prepare(sshSelect + ' WHERE h.id=? AND h.deleted=0').bind(hostId).first();
  if (!row) throw Error('SSH host unavailable');
  const settings = parse(row.reach_settings, {}), secrets = await storedSecrets(env, row);
  return { address: row.address, port: row.port, user: row.login, workDirectory: row.work_directory, reach: row.reach, hostKey: row.host_key,
    privateKey: await openFor(env, row.uuid, 'key', row.private_key_sealed),
    ...(row.reach === 'tailscale' ? { tailscale: { authKey: secrets.tailscaleAuthKey, tags: settings.tags || [], hostname: 'golf-' + row.uuid.slice(0, 8) } } : {}),
    ...(row.reach === 'cloudflare-tunnel' ? { tunnel: { hostname: row.address, clientId: settings.clientId || '', clientSecret: secrets.accessClientSecret || '' } } : {}),
    ...(row.reach === 'workers-vpc' ? { vpc: { listenPort: vpcBridgePort } } : {}) };
}

// ---------- dispatch: Golf claims for the host (no polling), with the agent host claim's rules ----------
async function claimSSHTask(db, env, host, candidate) {
  const time = now();
  const repository = await repositoryRow(db, candidate.repository_id);
  const { results: tools } = await db.prepare('SELECT * FROM agent_host_tools WHERE host_id=?').bind(host.id).all();
  const refusal = !repository || repository.artifact_name !== candidate.artifact_name ? { code: 'repository_unavailable' }
    : await admissionRefusal(db, env, { repository, requesterId: candidate.requested_by, host, tools, tool: candidate.tool, targetKind: candidate.target_kind });
  if (refusal) {
    await db.prepare("UPDATE agent_tasks SET state='FAILED',failure_reason=?,finished_at=?,updated_at=? WHERE id=? AND state='QUEUED'").bind('refused_' + refusal.code, time, time, candidate.id).run();
    return null;
  }
  const token = `golf_agent_task_${candidate.id}_${random()}`, claimId = crypto.randomUUID();
  const duration = Math.min(maxDuration, Math.max(60_000, candidate.deadline - Date.parse(candidate.created_at))), deadline = Date.now() + duration;
  const [changed] = await db.batch([
    db.prepare("UPDATE agent_tasks SET state='CLAIMED',claim_id=?,token_digest=?,claimed_at=?,deadline=?,updated_at=? WHERE id=? AND state='QUEUED' AND cancel_requested=0")
      .bind(claimId, await digest(token), time, deadline, time, candidate.id),
    // The dispatcher calls in for the host from now on (the LOST sweep reads last_seen_at).
    db.prepare('UPDATE agent_hosts SET last_seen_at=? WHERE id=? AND changes()=1').bind(time, host.id),
  ]);
  return changed.meta.changes === 1 ? { taskId: candidate.id, hostId: host.id, token } : null;
}
export async function dispatchSSHHost(db, env, hostId) {
  if (!executionReady(env) || !await sshSchema(db)) return { dispatched: 0 };
  const host = await db.prepare("SELECT * FROM agent_hosts WHERE id=? AND deleted=0 AND state='ACTIVE'").bind(Number(hostId)).first();
  if (!host || !sshHost(host)) return { dispatched: 0 };
  let free = host.max_concurrent - (await db.prepare("SELECT COUNT(*) AS n FROM agent_tasks WHERE host_id=? AND state IN ('CLAIMED','RUNNING')").bind(host.id).first()).n, dispatched = 0;
  if (free < 1) return { dispatched };
  const { results } = await db.prepare("SELECT * FROM agent_tasks WHERE host_id=? AND state='QUEUED' AND cancel_requested=0 ORDER BY created_at,id LIMIT 10").bind(host.id).all();
  for (const candidate of results) {
    if (free < 1) break;
    const claimed = await claimSSHTask(db, env, host, candidate);
    if (!claimed) continue;
    try { await env.sshTasks.getByName('task:' + claimed.taskId).run(claimed); dispatched++; free--; }
    catch {
      const time = now();
      await db.prepare("UPDATE agent_tasks SET state='FAILED',failure_reason='ssh_dispatch_failed',finished_at=?,updated_at=? WHERE id=? AND state='CLAIMED'").bind(time, time, claimed.taskId).run();
    }
  }
  return { dispatched };
}

// The claimed task in the agent host protocol's shape, for ssh-run, with the token minted at claim.
export async function sshTaskJob(db, env, taskId, token) {
  const task = await db.prepare('SELECT * FROM agent_tasks WHERE id=?').bind(taskId).first();
  if (!task || task.state !== 'CLAIMED' || task.token_digest !== await digest(token)) throw Error('The task is no longer claimed for this dispatch');
  const repository = await repositoryRow(db, task.repository_id);
  if (!repository) throw Error('The task repository is unavailable');
  return { origin: env.PUBLIC_ORIGIN, task: { id: task.id, repository: `${ownerSlug(repository, env)}/${repository.name}`, cloneUrl: `${env.PUBLIC_ORIGIN}/native/agent-host/tasks/${task.id}/git`, branch: task.branch,
    baseRef: task.base_ref, baseCommit: task.base_commit, tool: task.tool, model: task.model, prompt: task.prompt, deadline: task.deadline, token,
    ...(await isReview(db, task.id) ? { mode: 'review' } : {}),
    target: { kind: task.target_kind, number: task.target_number, title: task.target_title, url: targetURL(env, repository, task.target_kind, task.target_number) } },
    ssh: await sshConnectionJob(db, env, task.host_id) };
}

// One tick of a dispatched task, from its Durable Object: calls in for the host while the task runs, and says what the container should do.
export async function sshTaskTick(db, taskId) {
  const task = await db.prepare('SELECT id,host_id,state,cancel_requested,deadline FROM agent_tasks WHERE id=?').bind(taskId).first();
  if (!task) return { state: 'GONE', terminal: true };
  const terminal = terminalStates.includes(task.state);
  if (!terminal) await db.prepare('UPDATE agent_hosts SET last_seen_at=? WHERE id=?').bind(now(), task.host_id).run();
  return { state: task.state, terminal, cancel: Boolean(task.cancel_requested), deadline: task.deadline, hostId: task.host_id };
}
// The container stopped (or was stopped) before ssh-run finished the task: the task ends with the reason; a finished one is untouched.
export async function sshTaskStopped(db, taskId, state, reason) {
  const time = now();
  await db.prepare("UPDATE agent_tasks SET state=?,failure_reason=?,finished_at=?,updated_at=? WHERE id=? AND state IN ('CLAIMED','RUNNING')").bind(state, reason, time, time, taskId).run();
}

// Maintenance: dispatch queued SSH tasks (a dispatch that failed at create, or a host that was busy) and end connection tests that never reported.
export async function sweepSSHHosts(env) {
  const db = env.DB.withSession('first-primary');
  if (!await sshSchema(db)) return { processed: 0 };
  const stale = new Date(Date.now() - probeTimeout).toISOString(), time = now();
  const ended = await db.prepare(`UPDATE ssh_hosts SET probe_state='FAILED',probe_result=?,probe_finished_at=?,updated_at=? WHERE probe_state='RUNNING' AND probe_started_at<?`)
    .bind(JSON.stringify({ authenticated: false, error: 'The connection test did not report back.' }), time, time, stale).run();
  let processed = ended.meta.changes;
  if (!executionReady(env)) return { processed };
  const { results } = await db.prepare("SELECT DISTINCT t.host_id FROM agent_tasks t JOIN agent_hosts h ON h.id=t.host_id WHERE t.state='QUEUED' AND h.deleted=0 AND h.credential_digest LIKE 'ssh:%' LIMIT 50").all();
  for (const row of results) processed += (await dispatchSSHHost(db, env, row.host_id)).dispatched;
  return { processed };
}
