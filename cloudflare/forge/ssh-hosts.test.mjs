// SSH hosts (docs/SSH_HOSTS.md): capability states, the sealed per-host key, sharing and management, connection tests and explicit host
// key pinning, admission and routing of "Assign to agent" to an SSH host (Golf claims, no polling), the task protocol with the minted
// token, cancel, the LOST sweep, delete, the audit rows, and the SSHAgentTask Durable Object with a mocked container.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { objectFixture, origin, repository } from './object-fixture.mjs';
import { handle, serialize, concurrentRead, digest } from './src/core.mjs';
import { sweepAgentTasks } from './src/agent-hosts.mjs';
import { sealSecret, openSecret, sealedKeyId } from './src/vault.mjs';
import { dispatchSSHHost, parseHostKey, recordSSHProbe, sshKeyPair, sshTaskJob, sshTaskTick, sweepSSHHosts, reachStates } from './src/ssh-hosts.mjs';

const hooks = registerHooks({ resolve(specifier, context, next) {
  if (specifier === 'cloudflare:workers') return { url: 'data:text/javascript,' + encodeURIComponent('export class DurableObject {constructor(ctx,env){this.ctx=ctx;this.env=env}}'), shortCircuit: true };
  return next(specifier, context);
} });
const { SSHAgentTask } = await import('./src/ssh-task.mjs');
hooks.deregister();

const base = 'a'.repeat(40), uuid = () => crypto.randomUUID();
const sealingKey = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))));
const hostKey = async () => (await sshKeyPair('host')).publicKey.split(' ').slice(0, 2).join(' ');
const toolsReport = [{ tool: 'claude', version: '2.1.0', signedIn: true }, { tool: 'codex', version: '0.50.0', signedIn: null }];

async function fixture(t, { execution = true, key = true } = {}) {
  const f = await objectFixture(t);
  f.sql.exec(`UPDATE users SET email=login||'@example.invalid'; INSERT INTO operations_admins(user_id) VALUES(1);
    INSERT INTO native_owners(id,slug,kind,user_id,creator_id) VALUES(1,'alice','PERSONAL',1,1); INSERT INTO native_owners(id,slug,kind,creator_id) VALUES(2,'team','ORGANIZATION',1);
    INSERT INTO native_owner_members VALUES(2,1,'owner'),(2,2,'member'); INSERT INTO repository_owners VALUES(1,1);
    INSERT INTO discussions(id,repository_id,number,kind,author_id,title,body,state,created_at,updated_at) VALUES(1,1,12,'issue',2,'Fix the parser','It crashes on empty input.','OPEN','t','t')`);
  const refs = new Map([['refs/heads/main', base]]);
  f.env.ARTIFACTS = { async get(name) { return { async info() { return { name, remote: `https://${f.env.ACCOUNT_ID}.artifacts.cloudflare.net/git/test-space/${name}.git` }; },
    async createToken() { return { plaintext: 'art_v1_token' }; }, async revokeToken() { return true; }, [Symbol.dispose]() {}, async readCommit() { return null; } }; } };
  const { packetLine } = await import('./src/git.mjs');
  const providerFetch = async input => {
    const url = new URL(input);
    if (url.pathname.endsWith('/info/refs')) return new Response(Buffer.concat([packetLine('# service=git-upload-pack\n'), Buffer.from('0000'), ...[...refs].map(([ref, hash], i) => packetLine(`${hash} ${ref}${i ? '' : '\0report-status'}\n`)), Buffer.from('0000')]),
      { headers: { 'Content-Type': 'application/x-git-upload-pack-advertisement' } });
    return new Response(Buffer.from('0008NAK\n'), { headers: { 'Content-Type': 'application/x-git-upload-pack-result' } });
  };
  const dispatched = [], probes = [];
  if (key) f.env.EXECUTION_VALUE_KEY = { async get() { return sealingKey; } };
  if (execution) {
    f.env.SSH_HOSTS_EXECUTION = 'true';
    f.env.sshTasks = { getByName: name => ({ run: async job => { dispatched.push({ name, ...job }); return { state: 'dispatched' }; }, probe: async job => { probes.push({ name, ...job }); return { state: 'dispatched' }; } }) };
  }
  const dispatch = serialize(request => handle(request, f.env, providerFetch), concurrentRead);
  const signed = async (path, body, who = 'alice') => {
    const response = await dispatch(new Request(origin + path, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Connect-Protocol-Version': '1', 'X-Golf-Native-Access-Email': who + '@example.invalid' }, body: JSON.stringify(body) }));
    return { status: response.status, ...await response.json() };
  };
  const machine = async (path, body, credential) => {
    const response = await dispatch(new Request(origin + '/native/agent-host/' + path, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(credential ? { Authorization: 'Bearer ' + credential } : {}) }, body: JSON.stringify(body) }));
    return { status: response.status, ...await response.json() };
  };
  const ssh = (body, who) => signed('/native/ssh-hosts', body, who);
  const tasks = (body, who) => signed('/native/agent-tasks', { repository, repositoryId: '1', ...body }, who);
  const create = async (extra = {}, who = 'alice') => {
    const created = await ssh({ action: 'create', scope: 'personal', name: 'build-box', address: 'build.example.net', port: 2222, user: 'agent', reach: 'direct', ...extra }, who);
    assert.equal(created.status, 200, JSON.stringify(created));
    return created;
  };
  // A connection test as the container would report it, then the explicit pin, then a test that proves the key and reports tools.
  const ready = async (host, offered, tools = toolsReport) => {
    await ssh({ action: 'test', scope: 'personal', id: host.id });
    const first = probes.at(-1);
    await recordSSHProbe(f.env.DB, f.env, Number(host.id), first.probeId, { hostKey: offered, matched: null, authenticated: false });
    const fingerprint = (await parseHostKey(offered)).fingerprint;
    const pinned = await ssh({ action: 'trustHostKey', scope: 'personal', id: host.id, fingerprint });
    assert.equal(pinned.status, 200, JSON.stringify(pinned));
    await ssh({ action: 'test', scope: 'personal', id: host.id });
    await recordSSHProbe(f.env.DB, f.env, Number(host.id), probes.at(-1).probeId, { hostKey: offered, matched: true, authenticated: true, os: 'linux', arch: 'amd64', tools });
    return fingerprint;
  };
  const assign = (host, body = {}, who = 'alice') => tasks({ action: 'create', target: { kind: 'issue', number: 12 }, hostId: host.id, tool: 'claude', idempotencyKey: uuid(), ...body }, who);
  return { ...f, refs, dispatch, signed, machine, ssh, tasks, create, ready, assign, dispatched, probes };
}
const audits = f => f.sql.prepare("SELECT action,subject,before,after,scope FROM installation_audit WHERE action LIKE 'ssh_host.%' ORDER BY id").all();

test('the capability and every reach say honestly what is missing; SSH hosts stay off without the container or the sealing key', async t => {
  const f = await fixture(t, { execution: false });
  const { sshCapability } = await import('./src/ssh-hosts.mjs');
  let state = await sshCapability(f.env.DB, f.env);
  assert.equal(state.state, 'CAPABILITY_STATE_UNCONFIGURED');
  assert.match(state.reason, /SSHAgentTask Durable Object/);
  assert.equal(reachStates(f.env).direct.available, false);
  // Listing works; creating refuses with the reason.
  assert.deepEqual((await f.ssh({ action: 'list', scope: 'personal' })).hosts, []);
  assert.equal((await f.ssh({ action: 'create', scope: 'personal', name: 'x', address: 'x.example.net', user: 'agent', reach: 'direct' })).status, 412);
  const g = await fixture(t, { key: false });
  state = await sshCapability(g.env.DB, g.env);
  assert.equal(state.state, 'CAPABILITY_STATE_UNCONFIGURED');
  assert.match(state.reason, /EXECUTION_VALUE_KEY/);
  const h = await fixture(t);
  state = await sshCapability(h.env.DB, h.env);
  assert.equal(state.state, 'CAPABILITY_STATE_READY');
  const reaches = reachStates(h.env);
  assert.deepEqual(Object.entries(reaches).map(([reach, value]) => [reach, value.available]), [['direct', true], ['tailscale', true], ['cloudflare-tunnel', true], ['workers-vpc', false]]);
  assert.match(reaches['workers-vpc'].reason, /SSH_VPC_NETWORK/);
  assert.equal(reachStates({ ...h.env, SSH_VPC_NETWORK: { connect() {} } })['workers-vpc'].available, true);
  assert.equal((await h.ssh({ action: 'create', scope: 'personal', name: 'x', address: 'x.example.net', user: 'agent', reach: 'workers-vpc' })).status, 412);
  // The capability list carries the same states.
  const listed = async g => (await g.signed('/rpc/golf.v1.CapabilityService/ListCapabilities', {})).capabilities.find(c => c.id === 'agents.ssh-hosts');
  assert.equal((await listed(h)).state, 'CAPABILITY_STATE_READY');
  assert.equal((await listed(f)).state, 'CAPABILITY_STATE_UNCONFIGURED');
});

test('SSH host secrets use the vault envelope: bound to their context, never under another key', async () => {
  const env = { EXECUTION_VALUE_KEY: { async get() { return sealingKey; } } }, decode = bytes => new TextDecoder().decode(bytes);
  const sealed = await sealSecret(env, 'private', 'ssh-host:1:key');
  assert.equal(JSON.parse(sealed).v, 1);
  assert.match(sealedKeyId(sealed), /^[a-f0-9]{16}$/);
  assert.equal(sealed.includes('private'), false);
  assert.equal(decode(await openSecret(env, sealed, 'ssh-host:1:key')), 'private');
  await assert.rejects(openSecret(env, sealed, 'ssh-host:1:reach'));
  await assert.rejects(openSecret(env, sealed, 'ssh-host:2:key'));
  const other = { EXECUTION_VALUE_KEY: { async get() { return btoa(String.fromCharCode(...new Uint8Array(32))); } } };
  await assert.rejects(openSecret(other, sealed, 'ssh-host:1:key'), /different installation key/);
});

test('creating an SSH host generates a sealed Ed25519 key; secrets never reach a row, a view or the audit log', async t => {
  const f = await fixture(t);
  const created = await f.create({ reach: 'tailscale', address: 'build-box.tail1234.ts.net', tailscale: { authKey: 'tskey-auth-abcdef123456-SECRETSECRET', tags: ['tag:golf-agent'] } });
  assert.match(created.publicKey, /^ssh-ed25519 [A-Za-z0-9+/]+=* golf-ssh-host-[0-9a-f]{8}$/);
  assert.equal(created.authorizedKey, 'restrict ' + created.publicKey);
  assert.ok(created.installCommand.includes(created.authorizedKey));
  const host = created.host;
  assert.deepEqual([host.kind, host.reach, host.port, host.user, host.hostKey.pinned, host.ready, host.tailscale], ['ssh', 'tailscale', 2222, 'agent', false, false, { tags: ['tag:golf-agent'], ephemeral: true, authKeySet: true }]);
  assert.match(host.readyReason, /confirm the host key/);
  const rows = JSON.stringify([f.sql.prepare('SELECT * FROM ssh_hosts').all(), f.sql.prepare('SELECT * FROM agent_hosts').all()]);
  assert.equal(rows.includes('SECRETSECRET'), false);
  assert.equal(rows.includes('BEGIN'), false);
  const row = f.sql.prepare('SELECT * FROM ssh_hosts').get(), agent = f.sql.prepare('SELECT * FROM agent_hosts').get();
  assert.equal(agent.credential_digest, 'ssh:' + agent.uuid);
  assert.equal(agent.host_version, 'ssh');
  // The sealed private key opens to a PKCS#8 Ed25519 key whose public half is the one shown.
  const pkcs8 = new TextDecoder().decode(await openSecret(f.env, row.private_key_sealed, `ssh-host:${agent.uuid}:key`));
  assert.equal(row.seal_key_id, sealedKeyId(row.private_key_sealed));
  const imported = await crypto.subtle.importKey('pkcs8', Uint8Array.from(atob(pkcs8), c => c.charCodeAt(0)), { name: 'Ed25519' }, true, ['sign']);
  const jwk = await crypto.subtle.exportKey('jwk', imported);
  const raw = Uint8Array.from(atob(jwk.x.replace(/-/g, '+').replace(/_/g, '/') + '='), c => c.charCodeAt(0));
  assert.deepEqual([...Uint8Array.from(atob(created.publicKey.split(' ')[1]), c => c.charCodeAt(0)).slice(-32)], [...raw]);
  assert.equal(JSON.parse(new TextDecoder().decode(await openSecret(f.env, row.secrets_sealed, `ssh-host:${agent.uuid}:reach`))).tailscaleAuthKey, 'tskey-auth-abcdef123456-SECRETSECRET');
  const listed = await f.ssh({ action: 'list', scope: 'personal' });
  assert.equal(JSON.stringify(listed).includes('SECRETSECRET'), false);
  assert.deepEqual(listed.hosts.map(h => h.name), ['build-box']);
  // SSH hosts are listed apart from outbound hosts, and are deleted only through their own API.
  assert.deepEqual((await f.signed('/native/agent-hosts', { action: 'list', scope: 'personal' })).hosts, []);
  assert.equal((await f.signed('/native/agent-hosts', { action: 'delete', id: host.id })).status, 412);
  const audit = audits(f);
  assert.deepEqual(audit.map(a => [a.action, a.subject, a.scope]), [['ssh_host.create', 'build-box', 'installation']]);
  assert.equal(JSON.stringify(audit).includes('SECRETSECRET'), false);
  assert.equal(JSON.parse(audit[0].after).tailscaleAuthKey, 'set');
});

test('validation and management: addresses, reaches, secrets in pairs; only managers create, read keys, test or change', async t => {
  const f = await fixture(t);
  for (const bad of [{ address: 'bad host' }, { address: 'x.example.net', port: 0 }, { user: 'root;rm' }, { reach: 'carrier-pigeon' }, { workDirectory: 'relative' }, { workDirectory: '/a/../b' },
    { reach: 'tailscale' }, { reach: 'tailscale', tailscale: { authKey: 'not-a-key' } }, { reach: 'tailscale', tailscale: { authKey: 'tskey-auth-12345678', tags: ['eng'] } },
    { reach: 'cloudflare-tunnel', tunnel: { clientId: 'abcdefgh.access' } }, { tailscale: { authKey: 'tskey-auth-12345678' } }, { extra: 1 }, { name: '' }]) {
    const result = await f.ssh({ action: 'create', scope: 'personal', name: 'n', address: 'x.example.net', user: 'agent', reach: 'direct', ...bad });
    assert.equal(result.status, 400, JSON.stringify([bad, result]));
  }
  const tunnel = await f.create({ reach: 'cloudflare-tunnel', address: 'ssh.example.com', tunnel: { clientId: 'abcdefgh.access', clientSecret: 'S'.repeat(40) } });
  assert.deepEqual(tunnel.host.tunnel, { clientId: 'abcdefgh.access', clientSecretSet: true });
  // bob cannot manage alice's host; organization members read organization hosts without keys; owners manage them.
  assert.equal((await f.ssh({ action: 'test', scope: 'personal', id: tunnel.host.id }, 'bob')).status, 403);
  assert.equal((await f.ssh({ action: 'create', scope: 'organization', organization: 'team', name: 'org-box', address: 'org.example.net', user: 'agent', reach: 'direct' }, 'bob')).status, 403);
  const org = await f.ssh({ action: 'create', scope: 'organization', organization: 'team', name: 'org-box', address: 'org.example.net', user: 'agent', reach: 'direct' });
  assert.equal(org.status, 200);
  const member = await f.ssh({ action: 'list', scope: 'organization', organization: 'team' }, 'bob');
  assert.deepEqual([member.canManage, member.hosts.length, member.hosts[0].publicKey], [false, 1, undefined]);
  assert.equal((await f.ssh({ action: 'list', scope: 'installation' }, 'bob')).status, 403);
  // Updates need the version they read; a new address forgets the pinned host key.
  const host = (await f.create()).host;
  await f.ready(host, await hostKey());
  let current = (await f.ssh({ action: 'list', scope: 'personal' })).hosts.find(h => h.id === host.id);
  assert.equal(current.hostKey.pinned, true);
  assert.equal((await f.ssh({ action: 'update', scope: 'personal', id: host.id, expectedVersion: current.version - 1, port: 22 })).status, 412);
  const renamed = await f.ssh({ action: 'update', scope: 'personal', id: host.id, expectedVersion: current.version, name: 'renamed', user: 'agent' });
  assert.deepEqual([renamed.host.name, renamed.host.hostKey.pinned, renamed.host.tools.length], ['renamed', true, 2]);
  const moved = await f.ssh({ action: 'update', scope: 'personal', id: host.id, expectedVersion: renamed.host.version, address: 'elsewhere.example.net' });
  assert.deepEqual([moved.host.hostKey.pinned, moved.host.tools.length, moved.host.probe.state], [false, 0, 'NONE']);
  // A new key: the old public key is replaced and shown once more for installing.
  const rotated = await f.ssh({ action: 'rotateKey', scope: 'personal', id: host.id, expectedVersion: moved.host.version });
  assert.notEqual(rotated.publicKey, moved.host.publicKey);
  // The first test row is bob's denied attempt.
  assert.deepEqual(audits(f).map(a => a.action).filter(a => a !== 'ssh_host.create'), ['ssh_host.test', 'ssh_host.test', 'ssh_host.trust_host_key', 'ssh_host.test', 'ssh_host.update', 'ssh_host.update', 'ssh_host.rotate_key']);
  const trust = audits(f).find(a => a.action === 'ssh_host.trust_host_key');
  assert.match(JSON.parse(trust.after).hostKeyFingerprint, /^SHA256:/);
});

test('host keys are pinned only from a test the person confirmed; a changed key fails the test and keeps the tools', async t => {
  const f = await fixture(t);
  const host = (await f.create()).host, offered = await hostKey(), fingerprint = (await parseHostKey(offered)).fingerprint;
  // Nothing to pin before a test; a test runs one at a time.
  assert.equal((await f.ssh({ action: 'trustHostKey', scope: 'personal', id: host.id, fingerprint })).status, 412);
  const started = await f.ssh({ action: 'test', scope: 'personal', id: host.id });
  assert.deepEqual([started.host.probe.state, f.probes.length, f.probes[0].name], ['RUNNING', 1, 'probe:' + f.probes[0].probeId]);
  assert.equal((await f.ssh({ action: 'test', scope: 'personal', id: host.id })).status, 409);
  // A report for another test is ignored; the fingerprint is computed here, never taken from the report.
  assert.deepEqual(await recordSSHProbe(f.env.DB, f.env, Number(host.id), uuid(), { hostKey: offered }), { recorded: false });
  await recordSSHProbe(f.env.DB, f.env, Number(host.id), f.probes[0].probeId, { hostKey: offered, fingerprint: 'SHA256:forged', authenticated: true, matched: true, tools: toolsReport });
  let view = (await f.ssh({ action: 'list', scope: 'personal' })).hosts[0];
  assert.deepEqual([view.probe.state, view.probe.offered.fingerprint, view.tools.length], ['SUCCEEDED', fingerprint, 0]);
  assert.equal((await f.ssh({ action: 'trustHostKey', scope: 'personal', id: host.id, fingerprint: 'SHA256:forged' })).status, 412);
  assert.equal((await f.ssh({ action: 'trustHostKey', scope: 'personal', id: host.id, fingerprint }, 'bob')).status, 403);
  view = (await f.ssh({ action: 'trustHostKey', scope: 'personal', id: host.id, fingerprint })).host;
  assert.deepEqual([view.hostKey.pinned, view.hostKey.fingerprint, view.hostKey.pinnedBy, view.ready], [true, fingerprint, 'alice', true]);
  // A proven test records tools, OS and the call-in time.
  await f.ssh({ action: 'test', scope: 'personal', id: host.id });
  await recordSSHProbe(f.env.DB, f.env, Number(host.id), f.probes.at(-1).probeId, { hostKey: offered, matched: true, authenticated: true, os: 'linux', arch: 'amd64', tools: [...toolsReport, { tool: 'vim' }] });
  view = (await f.ssh({ action: 'list', scope: 'personal' })).hosts[0];
  assert.deepEqual([view.probe.state, view.online, view.os, view.tools.map(tool => tool.tool)], ['SUCCEEDED', true, 'linux', ['claude', 'codex']]);
  // Another key answers: the test fails with the offered fingerprint, nothing else changes.
  const other = await hostKey();
  await f.ssh({ action: 'test', scope: 'personal', id: host.id });
  await recordSSHProbe(f.env.DB, f.env, Number(host.id), f.probes.at(-1).probeId, { hostKey: other, matched: false, authenticated: false, error: 'host key mismatch', tools: [] });
  view = (await f.ssh({ action: 'list', scope: 'personal' })).hosts[0];
  assert.deepEqual([view.probe.state, view.probe.matched, view.hostKey.fingerprint, view.tools.length], ['FAILED', false, fingerprint, 2]);
  assert.equal(view.probe.offered.fingerprint, (await parseHostKey(other)).fingerprint);
  // Malformed host keys are not offered at all.
  assert.equal(await parseHostKey('ssh-ed25519 ' + btoa('xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx')), null);
  assert.equal(await parseHostKey('ssh-dss AAAAB3NzaC1kc3MAAACBAP'), null);
  // A test that never reports ends at the sweep.
  await f.ssh({ action: 'test', scope: 'personal', id: host.id });
  f.sql.prepare("UPDATE ssh_hosts SET probe_started_at='2000-01-01T00:00:00Z'").run();
  await sweepSSHHosts(f.env);
  view = (await f.ssh({ action: 'list', scope: 'personal' })).hosts[0];
  assert.deepEqual([view.probe.state, view.probe.error], ['FAILED', 'The connection test did not report back.']);
});

test('Assign to agent on an SSH host: refused until ready, then claimed by Golf with a task token; the task protocol, cancel and the sweep apply', async t => {
  const f = await fixture(t);
  const host = (await f.create()).host;
  // Rule 3 for SSH hosts: no confirmed host key yet.
  let refused = await f.assign(host);
  assert.equal(refused.status, 412);
  assert.match(refused.message, /Rule 3 \(host\): SSH host build-box has no confirmed host key/);
  await f.ready(host, await hostKey());
  const available = await f.tasks({ action: 'available' });
  assert.deepEqual(available.hosts.map(h => [h.name, h.kind, h.online, h.tools.map(tool => [tool.tool, tool.usable])]), [['build-box', 'ssh', true, [['claude', true], ['codex', true]]]]);
  // Rule 6 still applies: OpenCode was not reported.
  assert.match((await f.assign(host, { tool: 'opencode' })).message, /Rule 6/);
  const created = await f.assign(host);
  assert.equal(created.status, 200, JSON.stringify(created));
  assert.deepEqual([created.task.state, created.task.host.kind], ['CLAIMED', 'ssh']);
  assert.equal(f.dispatched.length, 1);
  const job = f.dispatched[0];
  assert.equal(job.name, 'task:' + created.task.id);
  assert.match(job.token, new RegExp(`^golf_agent_task_${created.task.id}_[0-9a-f]{64}$`));
  const stored = f.sql.prepare('SELECT * FROM agent_tasks WHERE id=?').get(created.task.id);
  assert.equal(stored.token_digest, await digest(job.token));
  assert.equal(JSON.stringify(f.sql.prepare('SELECT * FROM agent_tasks').all()).includes(job.token), false);
  // The container's job: the claimed task in the protocol's shape and the connection with the opened private key.
  const full = await sshTaskJob(f.env.DB, f.env, created.task.id, job.token);
  assert.deepEqual([full.origin, full.task.cloneUrl, full.task.branch, full.task.baseCommit, full.task.tool, full.ssh.address, full.ssh.port, full.ssh.user, full.ssh.reach],
    [origin, `${origin}/native/agent-host/tasks/${created.task.id}/git`, 'golf-agent/' + created.task.id.slice(0, 8), base, 'claude', 'build.example.net', 2222, 'agent', 'direct']);
  assert.match(full.ssh.privateKey, /^[A-Za-z0-9+/]+=*$/);
  assert.match(full.ssh.hostKey, /^ssh-ed25519 /);
  await assert.rejects(sshTaskJob(f.env.DB, f.env, created.task.id, 'golf_agent_task_' + created.task.id + '_' + '0'.repeat(64)), /no longer claimed/);
  // A second task waits: the host runs one task at a time by default.
  const second = await f.assign(host);
  assert.deepEqual([second.task.state, f.dispatched.length], ['QUEUED', 1]);
  // ssh-run reports through the agent host task routes with the minted token, exactly as an outbound host.
  const id = created.task.id;
  assert.deepEqual(await f.machine(`tasks/${id}/start`, {}, job.token), { status: 200, ok: true, cancel: false });
  assert.equal((await f.machine(`tasks/${id}/log`, { offset: 0, lines: ['[golf-agent-host] connecting to agent@build.example.net:2222'] }, job.token)).nextOffset, 1);
  // An empty log chunk is how ssh-run polls for cancel while the tool is silent.
  assert.deepEqual(await f.machine(`tasks/${id}/log`, { offset: 1, lines: [] }, job.token), { status: 200, nextOffset: 1, cancel: false });
  assert.equal((await sshTaskTick(f.env.DB, id)).cancel, false);
  assert.equal((await f.tasks({ action: 'cancel', id })).task.cancelRequested, true);
  assert.deepEqual(await f.machine(`tasks/${id}/log`, { offset: 1, lines: [] }, job.token), { status: 200, nextOffset: 1, cancel: true });
  assert.equal((await sshTaskTick(f.env.DB, id)).cancel, true);
  assert.equal((await f.machine(`tasks/${id}/finish`, { state: 'cancelled', exitCode: -1, failure: 'cancelled in Golf' }, job.token)).state, 'CANCELLED');
  // The Durable Object dispatches the next queued task once this one ended.
  await dispatchSSHHost(f.env.DB, f.env, Number(host.id));
  assert.deepEqual([f.dispatched.length, f.dispatched[1].taskId], [2, second.task.id]);
  // The LOST sweep: the dispatcher stopped calling in for the host.
  f.sql.prepare("UPDATE agent_hosts SET last_seen_at='2000-01-01T00:00:00Z'").run();
  await sweepAgentTasks(f.env.DB);
  assert.equal(f.sql.prepare('SELECT state FROM agent_tasks WHERE id=?').get(second.task.id).state, 'LOST');
  // A queued task whose dispatch failed at create is dispatched by the sweep.
  const original = f.env.sshTasks;
  f.env.sshTasks = { getByName: () => ({ run: async () => { throw Error('unavailable'); } }) };
  const failed = await f.assign(host);
  assert.deepEqual([failed.task.state, failed.task.failureReason], ['FAILED', 'ssh_dispatch_failed']);
  f.env.sshTasks = original;
  f.sql.prepare("UPDATE agent_hosts SET max_concurrent=1").run();
  const later = await f.assign(host);
  assert.equal(later.task.state, 'CLAIMED');
  // Deleting the host erases its key; running tasks are told to stop.
  assert.equal((await f.ssh({ action: 'delete', scope: 'personal', id: host.id })).status, 200);
  assert.equal(f.sql.prepare('SELECT COUNT(*) AS n FROM ssh_hosts').get().n, 0);
  assert.equal(f.sql.prepare('SELECT cancel_requested FROM agent_tasks WHERE id=?').get(later.task.id).cancel_requested, 1);
  refused = await f.assign(host);
  assert.equal(refused.status, 412);
});

test('the SSHAgentTask Durable Object: the job only on standard input, the token dropped after launch, cancel, loss, deadline and probes', async t => {
  const f = await fixture(t);
  const host = (await f.create()).host;
  await f.ready(host, await hostKey());
  const created = await f.assign(host), job = f.dispatched[0];
  const store = new Map(), execs = [];
  let running = false, destroyed = 0, alarm = null, probeOutput = '{}';
  const container = { images: { ssh: 'ssh-image' }, get running() { return running; },
    start(options) { assert.deepEqual([options.image, options.enableInternet, options.entrypoint], ['ssh-image', true, ['sleep', 'infinity']]); running = true; },
    monitor: () => new Promise(() => {}), destroy: async () => { destroyed++; running = false; },
    exec: async (args, options) => {
      const stdin = options.stdin ? await new Response(options.stdin).text() : '';
      execs.push({ args, stdin, options });
      return { exitCode: Promise.resolve(0), output: async () => ({ exitCode: 0, stdout: new TextEncoder().encode(probeOutput), stderr: new Uint8Array() }) };
    } };
  const next = [];
  const ctx = { container, storage: { kv: { get: k => store.get(k), put: (k, v) => store.set(k, v) }, setAlarm: async at => { alarm = at; }, deleteAlarm: async () => { alarm = null; } },
    waitUntil: () => {}, exports: { SSHAgentTask: { getByName: name => ({ run: async value => { next.push({ name, ...value }); } }) } } };
  const env = { ...f.env, sshTasks: undefined };
  const object = new SSHAgentTask(ctx, env);
  assert.deepEqual(await object.run(job), { state: 'dispatched' });
  assert.ok(alarm);
  await object.alarm();
  const run = execs.find(e => e.args[1] === 'ssh-run');
  assert.deepEqual(run.args, ['/usr/local/bin/golf-agent-host', 'ssh-run']);
  assert.deepEqual([run.options.stdout, run.options.stderr, run.options.env], ['ignore', 'ignore', undefined]);
  const sent = JSON.parse(run.stdin);
  assert.deepEqual([sent.task.id, sent.task.token, sent.ssh.user], [created.task.id, job.token, 'agent']);
  assert.equal(JSON.stringify(store.get('ssh')).includes(job.token), false);
  assert.equal(store.get('ssh').stage, 'running');
  // Running: each tick calls in for the host.
  f.sql.prepare("UPDATE agent_hosts SET last_seen_at='2000-01-01T00:00:00Z'").run();
  await object.alarm();
  assert.notEqual(f.sql.prepare('SELECT last_seen_at FROM agent_hosts').get().last_seen_at, '2000-01-01T00:00:00Z');
  // Cancel: ssh-run gets a grace period to stop the tool and clean up, then the container is stopped and the task cancelled.
  await f.tasks({ action: 'cancel', id: created.task.id });
  await object.alarm();
  assert.deepEqual([destroyed, store.get('ssh').stage], [0, 'running']);
  store.set('ssh', { ...store.get('ssh'), cancelSeenAt: Date.now() - 61_000 });
  await object.alarm();
  assert.deepEqual([destroyed, store.get('ssh').stage, f.sql.prepare('SELECT state FROM agent_tasks WHERE id=?').get(created.task.id).state], [1, 'done', 'CANCELLED']);
  // A container that stops before the task finished: the task is lost.
  const second = await f.assign(host), job2 = f.dispatched.at(-1);
  assert.equal(job2.taskId, second.task.id);
  const store2 = new Map(), object2 = new SSHAgentTask({ ...ctx, storage: { ...ctx.storage, kv: { get: k => store2.get(k), put: (k, v) => store2.set(k, v) } } }, env);
  await object2.run(job2); await object2.alarm();
  running = false;
  await object2.alarm();
  assert.deepEqual([store2.get('ssh').stage, { ...f.sql.prepare('SELECT state,failure_reason FROM agent_tasks WHERE id=?').get(second.task.id) }], ['done', { state: 'LOST', failure_reason: 'ssh_runner_lost' }]);
  // A token that no longer matches the claim never starts a container.
  const store3 = new Map(), object3 = new SSHAgentTask({ ...ctx, storage: { ...ctx.storage, kv: { get: k => store3.get(k), put: (k, v) => store3.set(k, v) } } }, env);
  const third = await f.assign(host);
  const before = execs.length;
  await object3.run({ taskId: third.task.id, hostId: Number(host.id), token: 'golf_agent_task_' + third.task.id + '_' + '0'.repeat(64) });
  await object3.alarm();
  assert.deepEqual([execs.length, { ...f.sql.prepare('SELECT state,failure_reason FROM agent_tasks WHERE id=?').get(third.task.id) }], [before, { state: 'FAILED', failure_reason: 'ssh_dispatch_failed' }]);
  // Probes: ssh-probe reads the connection on stdin and its stdout is recorded.
  const offered = await hostKey();
  await f.ssh({ action: 'test', scope: 'personal', id: host.id });
  const probe = f.probes.at(-1), store4 = new Map(), object4 = new SSHAgentTask({ ...ctx, storage: { ...ctx.storage, kv: { get: k => store4.get(k), put: (k, v) => store4.set(k, v) } } }, env);
  probeOutput = JSON.stringify({ hostKey: offered, matched: false, authenticated: false, error: 'host key mismatch' });
  await object4.probe(probe); await object4.alarm();
  const probed = execs.at(-1);
  assert.deepEqual(probed.args, ['/usr/local/bin/golf-agent-host', 'ssh-probe']);
  assert.equal(JSON.parse(probed.stdin).ssh.address, 'build.example.net');
  const view = (await f.ssh({ action: 'list', scope: 'personal' })).hosts[0];
  assert.deepEqual([view.probe.state, view.probe.matched, store4.get('ssh').stage], ['FAILED', false, 'done']);
  void next;
});

test('the Workers VPC bridge connects only once the container listens, then pipes to the VPC network', async () => {
  const events = [], closed = () => ({ opened: Promise.resolve(), readable: new ReadableStream({ start: c => c.close() }), writable: new WritableStream() });
  let checks = 0;
  const container = {
    exec: async args => { events.push('check'); assert.match(args[2], /:08AE \[0-9A-F\]\+:\[0-9A-F\]\+ 0A /); return { exitCode: Promise.resolve(++checks >= 3 ? 0 : 1) }; },
    getTcpPort: port => ({ connect: address => { events.push(`inner ${port} ${address}`); return closed(); } }) };
  const env = { SSH_VPC_NETWORK: { connect: address => { events.push(`outer ${address}`); return closed(); } } };
  const object = new SSHAgentTask({ container, storage: { kv: { get: () => undefined, put: () => {} } }, exports: {} }, env);
  await object.bridge({ vpc: { listenPort: 2222 }, address: '10.0.0.5', port: 22 });
  assert.deepEqual(events, ['check', 'check', 'check', 'inner 2222 10.0.0.1:2222', 'outer 10.0.0.5:22']);
  await object.bridge({ vpc: { listenPort: 2222 }, address: 'fd00::5', port: 2200 });
  assert.equal(events.at(-1), 'outer [fd00::5]:2200');
});
