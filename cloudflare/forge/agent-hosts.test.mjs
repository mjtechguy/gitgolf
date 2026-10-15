// Agent hosts and "Assign to agent" (docs/AGENT_HOSTS.md): registration, the six admission rules, the host protocol, the
// task-scoped Git route, cancel, the sweep and host deletion. node:sqlite as D1 over the real schema; the Artifacts provider
// is a small in-memory Git server that applies receive-pack commands to its refs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { objectFixture, origin, repository } from './object-fixture.mjs';
import { handle, serialize, concurrentRead, digest, withArtifact } from './src/core.mjs';
import { settleRefWrites } from './src/ref-writes.mjs';
import { packetLine } from './src/git.mjs';
import { sweepAgentTasks, buildPrompt } from './src/agent-hosts.mjs';

const base = 'a'.repeat(40), feature = 'b'.repeat(40), proposal = 'd'.repeat(40), stray = 'e'.repeat(40), zero = '0'.repeat(40), uuid = () => crypto.randomUUID();
const tools = [{ tool: 'claude', version: '2.1.0', signedIn: true, account: 'alice@example.invalid' }, { tool: 'codex', version: '0.50.0', signedIn: null }, { tool: 'opencode', version: '1.0.0', signedIn: false }];

async function fixture(t) {
  const f = await objectFixture(t);
  f.sql.exec(`UPDATE users SET email=login||'@example.invalid'; INSERT INTO operations_admins(user_id) VALUES(1);
    INSERT INTO native_owners(id,slug,kind,user_id,creator_id) VALUES(1,'alice','PERSONAL',1,1); INSERT INTO native_owners(id,slug,kind,creator_id) VALUES(2,'team','ORGANIZATION',1);
    INSERT INTO native_owner_members VALUES(2,1,'owner'),(2,2,'member'); INSERT INTO repository_owners VALUES(1,1);
    INSERT INTO repositories(id,name,description,artifact_name,creator_id,creation_key,input_hash,state,created_at) VALUES(2,'tooling','','repo-${'e'.repeat(32)}',1,'k2','h2','ACTIVE','2026-10-14T00:00:00Z');
    INSERT INTO repository_owners VALUES(2,2); INSERT INTO grants VALUES(2,1,'admin'),(2,2,'write');
    INSERT INTO discussions(id,repository_id,number,kind,author_id,title,body,state,created_at,updated_at) VALUES(1,1,12,'issue',2,'Fix the parser','It crashes on empty input.','OPEN','t','t'),
      (2,1,13,'issue',2,'Old','','CLOSED','t','t'),(3,2,1,'issue',1,'Organization issue','','OPEN','t','t'),(4,1,14,'pull',1,'Feature work','Body','OPEN','t','t');
    INSERT INTO pull_requests(id,discussion_id,base_branch,head_branch,base_commit,head_commit,draft) VALUES(1,4,'main','feature','${base}','${feature}',0);
    INSERT INTO discussion_comments(discussion_id,author_id,body,created_at,updated_at) VALUES(1,1,'Please add a test.','t','t')`);
  const refs = new Map([['repo-' + 'b'.repeat(32), new Map([['refs/heads/main', base], ['refs/heads/feature', feature]])], ['repo-' + 'e'.repeat(32), new Map([['refs/heads/main', base]])]]);
  const commits = new Map([[base, []], [feature, [base]], [proposal, [base]], [stray, []]]), pushes = [];
  f.env.ARTIFACTS = { async get(name) { return { async info() { return { name, remote: `https://${f.env.ACCOUNT_ID}.artifacts.cloudflare.net/git/test-space/${name}.git` }; },
    async createToken() { return { plaintext: 'art_v1_token' }; }, async revokeToken() { return true; }, [Symbol.dispose]() {},
    async readCommit(hash) { return commits.has(hash) ? { hash, treeHash: 'f'.repeat(40), parents: commits.get(hash), message: '' } : null; } }; } };
  const providerFetch = async (input, init = {}) => {
    const url = new URL(input), name = /\/([^/]+)\.git\//.exec(url.pathname)[1], current = refs.get(name);
    if (url.pathname.endsWith('/info/refs')) {
      const service = url.searchParams.get('service');
      return new Response(Buffer.concat([packetLine(`# service=${service}\n`), Buffer.from('0000'), ...[...current].map(([ref, hash], i) => packetLine(`${hash} ${ref}${i ? '' : '\0report-status side-band-64k'}\n`)), Buffer.from('0000')]),
        { headers: { 'Content-Type': `application/x-${service}-advertisement` } });
    }
    if (url.pathname.endsWith('/git-receive-pack')) {
      const [old, next, ref] = Buffer.from(init.body).subarray(4).toString().split('\0')[0].split(' ');
      pushes.push({ name, old, next, ref });
      current.set(ref, next);
      return new Response(Buffer.concat([packetLine('unpack ok\n'), packetLine(`ok ${ref}\n`), Buffer.from('0000')]), { headers: { 'Content-Type': 'application/x-git-receive-pack-result' } });
    }
    return new Response(Buffer.from('0008NAK\n'), { headers: { 'Content-Type': 'application/x-git-upload-pack-result' } });
  };
  const dispatch = serialize(request => handle(request, f.env, providerFetch), concurrentRead);
  const signed = async (path, body, who = 'alice') => {
    const response = await dispatch(new Request(origin + path, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Connect-Protocol-Version': '1', 'X-Golf-Native-Access-Email': who + '@example.invalid' }, body: JSON.stringify(body) }));
    return { status: response.status, ...await response.json() };
  };
  const machine = async (path, body, credential) => {
    const response = await dispatch(new Request(origin + '/native/agent-host/' + path, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(credential ? { Authorization: 'Bearer ' + credential } : {}) }, body: JSON.stringify(body) }));
    return { status: response.status, ...await response.json() };
  };
  const git = (task, route, token, { method = 'GET', body, type } = {}) => dispatch(new Request(origin + `/native/agent-host/tasks/${task}/git/${route}`, { method,
    headers: { ...(token ? { Authorization: 'Basic ' + btoa('golf:' + token) } : {}), ...(type ? { 'Content-Type': `application/x-${type}-request` } : {}) }, body }));
  const push = (task, token, old, next, ref) => git(task, 'git-receive-pack', token, { method: 'POST', type: 'git-receive-pack',
    body: Buffer.concat([packetLine(`${old} ${next} ${ref}\0report-status side-band-64k agent=git/2.43.0\n`), Buffer.from('0000PACK0000')]) });
  const hosts = (body, who) => signed('/native/agent-hosts', body, who);
  const tasks = (body, who, repo = repository, id = '1') => signed('/native/agent-tasks', { repository: repo, repositoryId: id, ...body }, who);
  const connect = async (who = 'alice', scope = 'personal', extra = {}, reported = tools) => {
    const created = await hosts({ action: 'createToken', scope, ...extra }, who);
    assert.equal(created.status, 200, JSON.stringify(created));
    const host = await machine('register', { registrationToken: created.token, name: `${who}-box`, hostVersion: '0.1.0', os: 'linux', arch: 'amd64' });
    assert.equal(host.status, 200, JSON.stringify(host));
    assert.equal((await machine('heartbeat', { tools: reported }, host.credential)).status, 200);
    return host;
  };
  const assign = (host, body = {}, who = 'alice') => tasks({ action: 'create', target: { kind: 'issue', number: 12 }, hostId: host.hostId, tool: 'claude', idempotencyKey: uuid(), ...body }, who);
  const update = async (host, change, who = 'alice') => {
    const current = (await signed('/native/agent-hosts', { action: 'list', ...(change.scope ? { scope: change.scope, organization: change.organization } : { scope: 'personal' }) }, who)).hosts.find(h => h.id === host.hostId);
    const { scope, organization, ...fields } = change;
    return hosts({ action: 'update', id: host.hostId, expectedVersion: current.version, ...fields }, who);
  };
  return { ...f, refs, commits, pushes, providerFetch, dispatch, signed, machine, git, push, hosts, tasks, connect, assign, update };
}

test('a personal host registers with a one-time token; only digests are stored and the credential works until deleted', async t => {
  const f = await fixture(t);
  const created = await f.hosts({ action: 'createToken', scope: 'personal', ttlHours: 2, uses: 1 });
  assert.match(created.token, /^golfagentreg_[a-f0-9]{64}$/);
  assert.ok(created.commands.some(command => command.includes(`golf-agent-host register --origin ${origin}`)) && created.commands.some(command => command.startsWith('golf-agent-host run')));
  const registered = await f.machine('register', { registrationToken: created.token, name: 'laptop', hostVersion: '0.1.0', os: 'linux', arch: 'amd64' });
  assert.equal(registered.status, 200);
  assert.match(registered.credential, new RegExp(`^golf_agent_host_${registered.uuid}_[a-f0-9]{64}$`));
  // One use: the token is spent; a made-up token is refused the same way.
  assert.equal((await f.machine('register', { registrationToken: created.token, name: 'again' })).status, 401);
  assert.equal((await f.machine('register', { registrationToken: 'golfagentreg_' + '0'.repeat(64), name: 'x' })).status, 401);
  const everything = JSON.stringify([f.sql.prepare('SELECT * FROM agent_hosts').all(), f.sql.prepare('SELECT * FROM agent_host_registrations').all()]);
  assert.equal(everything.includes(created.token), false); assert.equal(everything.includes(registered.credential), false);
  assert.ok(everything.includes(await digest(registered.credential)));
  // Heartbeat: tools are recorded (never a credential), unreported tools disappear, the state comes back.
  const beat = await f.machine('heartbeat', { tools }, registered.credential);
  assert.deepEqual([beat.ok, beat.cancel, beat.state], [true, [], 'ACTIVE']);
  assert.equal((await f.machine('heartbeat', { tools: [...tools, { tool: 'vim' }] }, registered.credential)).status, 400);
  assert.equal((await f.machine('heartbeat', { tools }, 'golf_agent_host_' + registered.uuid + '_' + '0'.repeat(64))).status, 401);
  const listed = await f.hosts({ action: 'list', scope: 'personal' });
  assert.equal(listed.canManage, true);
  assert.deepEqual(listed.hosts.map(h => [h.name, h.online, h.scope, h.tools.map(tool => [tool.tool, tool.signedIn])]), [['laptop', true, 'personal', [['claude', true], ['codex', null], ['opencode', false]]]]);
  await f.machine('heartbeat', { tools: tools.slice(0, 1) }, registered.credential);
  assert.deepEqual((await f.hosts({ action: 'list', scope: 'personal' })).hosts[0].tools.map(tool => tool.tool), ['claude']);
  // Another person sees only their own personal hosts; installation hosts need an operations administrator.
  assert.deepEqual((await f.hosts({ action: 'list', scope: 'personal' }, 'bob')).hosts, []);
  assert.equal((await f.hosts({ action: 'list', scope: 'installation' }, 'bob')).status, 403);
  assert.equal((await f.hosts({ action: 'createToken', scope: 'organization', organization: 'team' }, 'bob')).status, 403);
  assert.equal((await f.hosts({ action: 'list', scope: 'organization', organization: 'team' }, 'bob')).canManage, false);
  assert.equal((await f.hosts({ action: 'update', id: registered.hostId, expectedVersion: 1, name: 'mine' }, 'bob')).status, 403);
  // Revoked tokens stop registering.
  const revoked = await f.hosts({ action: 'createToken', scope: 'personal' });
  assert.equal((await f.hosts({ action: 'revokeToken', scope: 'personal', id: revoked.registration.id })).status, 200);
  assert.equal((await f.machine('register', { registrationToken: revoked.token, name: 'late' })).status, 401);
  // Deleting the host stops its credential at once.
  assert.equal((await f.hosts({ action: 'delete', id: registered.hostId })).status, 200);
  assert.equal((await f.machine('heartbeat', { tools }, registered.credential)).status, 401);
});

test('every admission rule refuses by name, at create and again at claim', async t => {
  const f = await fixture(t), host = await f.connect();
  const refusal = async (body, who, pattern, status = 412, using = host) => { const result = await f.assign(using, body, who); assert.equal(result.status, status, JSON.stringify(result)); assert.match(result.message, pattern); };
  // Rule 2: a reader cannot assign. Rule 4: bob may not use alice's personal host until she shares it with him.
  await refusal({}, 'carol', /^Rule 2 \(repository access\)/, 403);
  await refusal({}, 'bob', /^Rule 4 \(host users\)/, 403);
  // Rule 6: a tool turned off, one never reported, one signed out. Unknown sign-in (codex: null) is allowed.
  await refusal({ tool: 'grok' }, 'alice', /^Rule 6 \(tools\).*has not reported Grok/);
  await refusal({ tool: 'opencode' }, 'alice', /^Rule 6 \(tools\): OpenCode is not signed in/);
  assert.equal((await f.update(host, { enabledTools: ['claude', 'opencode'] })).status, 200);
  await refusal({ tool: 'codex' }, 'alice', /^Rule 6 \(tools\): Codex is turned off/);
  assert.equal((await f.update(host, { enabledTools: ['claude', 'codex', 'opencode', 'grok'], shareSignins: true, allowedUsers: ['bob'] })).status, 200);
  assert.equal((await f.assign(host, { tool: 'codex' }, 'bob')).status, 200);
  // Rule 5: the host's repository list; rule 3: disabled, and an organization host outside its organization.
  assert.equal((await f.update(host, { allowedRepositories: ['team/tooling'] })).status, 200);
  await refusal({}, 'alice', /^Rule 5 \(host repositories\)/);
  assert.equal((await f.update(host, { allowedRepositories: [], state: 'DISABLED' })).status, 200);
  await refusal({}, 'alice', /^Rule 3 \(host\).*disabled/);
  assert.equal((await f.machine('claim', { claimId: uuid() }, host.credential)).status, 403);
  const team = await f.connect('alice', 'organization', { organization: 'team' });
  await refusal({}, 'alice', /^Rule 3 \(host scope\).*its organization/, 412, team);
  // Rule 3 for personal hosts: the owner must be able to write the repository too.
  const dave = await f.connect('dave');
  f.sql.exec(`UPDATE agent_hosts SET share_signins=1,allowed_users='[1]' WHERE id=${dave.hostId}`);
  await refusal({}, 'alice', /^Rule 3 \(host scope\).*personal to an account without write access/, 412, dave);
  // An organization host serves its organization's repositories; without shared sign-ins only its registrant.
  const orgTask = await f.tasks({ action: 'create', target: { kind: 'issue', number: 1 }, hostId: team.hostId, tool: 'claude', idempotencyKey: uuid() }, 'bob', { owner: 'team', name: 'tooling' }, '2');
  assert.equal(orgTask.status, 403); assert.match(orgTask.message, /^Rule 4 \(shared sign-ins\)/);
  assert.equal((await f.tasks({ action: 'create', target: { kind: 'issue', number: 1 }, hostId: team.hostId, tool: 'claude', idempotencyKey: uuid() }, 'alice', { owner: 'team', name: 'tooling' }, '2')).status, 200);
  // Rule 1: the feature policy (installation, organization or repository) refuses with its reason.
  f.sql.exec("INSERT INTO feature_policies(scope,scope_id,feature,mode,version,updated_by,updated_at) VALUES('installation','','agent-hosts','DISABLED',1,1,'t')");
  const policy = await f.tasks({ action: 'create', target: { kind: 'issue', number: 1 }, hostId: team.hostId, tool: 'claude', idempotencyKey: uuid() }, 'alice', { owner: 'team', name: 'tooling' }, '2');
  assert.equal(policy.status, 412); assert.match(policy.message, /^Rule 1 \(feature policy\): Coding agents on your machines are turned off .* by the installation policy/);
  // At claim the same rules run again: the queued organization task fails with the rule's code.
  const claimed = await f.machine('claim', { claimId: uuid() }, team.credential);
  assert.deepEqual(claimed.task, null);
  assert.deepEqual(f.sql.prepare('SELECT state,failure_reason FROM agent_tasks WHERE host_id=?').all(Number(team.hostId)).map(row => ({ ...row })), [{ state: 'FAILED', failure_reason: 'refused_feature_off' }]);
});

test('assign an issue: claim, live log, push the proposal branch through the task route and finish verified', async t => {
  const f = await fixture(t), host = await f.connect(), key = uuid();
  const available = await f.tasks({ action: 'available' });
  assert.equal(available.featureOn, true);
  assert.deepEqual(available.hosts[0].tools.map(tool => [tool.tool, tool.usable]), [['claude', true], ['codex', true], ['opencode', false]]);
  assert.deepEqual((await f.tasks({ action: 'available' }, 'carol')).hosts, []);
  const created = await f.assign(host, { idempotencyKey: key, instructions: 'Keep the public API.', model: 'sonnet' });
  assert.equal(created.status, 200, JSON.stringify(created));
  const task = created.task;
  assert.deepEqual([task.state, task.branch, task.baseRef, task.baseCommit, task.target.title, task.requestedBy.login, task.host.name], ['QUEUED', 'golf-agent/' + task.id.slice(0, 8), 'refs/heads/main', base, 'Fix the parser', 'alice', 'alice-box']);
  // The same key returns the same task; different inputs under it are refused.
  assert.equal((await f.assign(host, { idempotencyKey: key, instructions: 'Keep the public API.', model: 'sonnet' })).task.id, task.id);
  assert.equal((await f.assign(host, { idempotencyKey: key })).status, 409);
  assert.match((await f.assign(host, { target: { kind: 'issue', number: 13 } })).message, /closed/);
  // Claim: the prompt carries the issue, its comments and the instructions; a retried claim gets a fresh token.
  const claimId = uuid(), first = await f.machine('claim', { claimId }, host.credential);
  assert.equal(first.task.id, task.id);
  assert.equal(first.task.cloneUrl, `${origin}/native/agent-host/tasks/${task.id}/git`);
  assert.match(first.task.prompt, /Issue #12: Fix the parser[\s\S]*It crashes on empty input[\s\S]*Please add a test[\s\S]*Instructions from alice[\s\S]*Keep the public API/);
  assert.match(first.task.token, /^golf_agent_task_[0-9a-f-]{36}_[0-9a-f]{64}$/);
  const again = await f.machine('claim', { claimId }, host.credential), token = again.task.token;
  assert.equal(again.task.id, task.id); assert.notEqual(token, first.task.token);
  assert.equal((await f.machine(`tasks/${task.id}/log`, { offset: 0, lines: ['x'] }, first.task.token)).status, 401);
  assert.equal((await f.machine('claim', { claimId: uuid() }, host.credential)).task, null); // max one at a time
  // Pushing before start is refused; reading is allowed once claimed.
  assert.equal((await f.push(task.id, token, zero, proposal, 'refs/heads/' + task.branch)).status, 403);
  const advertised = await f.git(task.id, 'info/refs?service=git-upload-pack', token);
  assert.equal(advertised.status, 200); assert.match(Buffer.from(await advertised.arrayBuffer()).toString(), /symref=HEAD:refs\/heads\/main/);
  assert.equal((await f.git(task.id, 'info/refs?service=git-upload-pack', '')).status, 401);
  assert.deepEqual(await f.machine(`tasks/${task.id}/start`, {}, token), { status: 200, ok: true, cancel: false });
  // Log offsets: a retried chunk stores only its new lines; a gap is refused with the expected offset. Golf credentials are masked.
  assert.equal((await f.machine(`tasks/${task.id}/log`, { offset: 0, lines: ['cloning', 'running claude'] }, token)).nextOffset, 2);
  assert.equal((await f.machine(`tasks/${task.id}/log`, { offset: 1, lines: ['running claude', `token ${token}`] }, token)).nextOffset, 3);
  assert.deepEqual(await f.machine(`tasks/${task.id}/log`, { offset: 9, lines: ['late'] }, token), { status: 409, code: 'aborted', message: 'Lines from 3 are missing; resend from that offset.', nextOffset: 3 });
  const log = await f.tasks({ action: 'log', id: task.id, offset: 0 });
  assert.deepEqual([log.lines, log.nextOffset, log.complete], [['cloning', 'running claude', 'token ***'], 3, false]);
  // The task route accepts exactly the task's branch, as a new branch, within 8 MiB, and answers git's probe.
  assert.equal((await f.push(task.id, token, base, proposal, 'refs/heads/main')).status, 403);
  assert.equal((await f.push(task.id, token, zero, proposal, 'refs/heads/other')).status, 403);
  assert.equal((await f.push(task.id, token, base, proposal, 'refs/heads/' + task.branch)).status, 403);
  assert.equal((await f.git(task.id, 'git-receive-pack', token, { method: 'POST', type: 'git-receive-pack', body: '0000' })).status, 200);
  assert.equal((await f.git(task.id, 'git-receive-pack', token, { method: 'POST', type: 'git-receive-pack', body: new Uint8Array(8 * 1024 * 1024 + 1) })).status, 413);
  const pushed = await f.push(task.id, token, zero, proposal, 'refs/heads/' + task.branch);
  assert.equal(pushed.status, 200, await pushed.clone().text());
  assert.deepEqual(f.pushes, [{ name: 'repo-' + 'b'.repeat(32), old: zero, next: proposal, ref: 'refs/heads/' + task.branch }]);
  assert.deepEqual(f.sql.prepare('SELECT user_id,ref,state FROM git_operations').all().map(row => ({ ...row })), [{ user_id: 1, ref: 'refs/heads/' + task.branch, state: 'APPLIED' }]);
  assert.equal(f.sql.prepare('SELECT write_pending FROM repositories WHERE id=1').get().write_pending, null);
  assert.equal(f.sql.prepare('SELECT COUNT(*) n FROM git_ref_writes').get().n, 0);
  // Finish succeeded: the branch points at the commit and the base is its first parent.
  const finished = await f.machine(`tasks/${task.id}/finish`, { state: 'succeeded', exitCode: 0, commitId: proposal, summary: 'Handled empty input.', changedFiles: ['src/parse.js'], usage: { inputTokens: 1200, outputTokens: 300 } }, token);
  assert.deepEqual(finished, { status: 200, ok: true, state: 'SUCCEEDED' });
  assert.deepEqual(await f.machine(`tasks/${task.id}/finish`, { state: 'failed' }, token), { status: 200, ok: true, state: 'SUCCEEDED' });
  const view = (await f.tasks({ action: 'get', id: task.id })).task;
  assert.deepEqual([view.state, view.commitId, view.summary, view.changedFiles, view.usage, view.exitCode, view.logLines], ['SUCCEEDED', proposal, 'Handled empty input.', ['src/parse.js'], { inputTokens: 1200, outputTokens: 300, reported: true }, 0, 3]);
  assert.equal((await f.tasks({ action: 'log', id: task.id, offset: 3 })).complete, true);
  // A finished task's token reaches nothing else.
  assert.equal((await f.git(task.id, 'info/refs?service=git-upload-pack', token)).status, 403);
  assert.equal((await f.machine(`tasks/${task.id}/log`, { offset: 3, lines: ['more'] }, token)).status, 409);
  assert.deepEqual((await f.tasks({ action: 'list', target: { kind: 'issue', number: 12 } })).tasks.map(item => item.id), [task.id]);
});

test('a pull request task starts from its head; an unverified proposal fails; a refused task can be finished from CLAIMED', async t => {
  const f = await fixture(t), host = await f.connect();
  const created = (await f.assign(host, { target: { kind: 'pull_request', number: 14 } })).task;
  assert.deepEqual([created.baseRef, created.baseCommit, created.target.title, created.target.url], ['refs/heads/feature', feature, 'Feature work', `${origin}/alice/project/pull/14`]);
  const { task } = await f.machine('claim', { claimId: uuid() }, host.credential);
  await f.machine(`tasks/${task.id}/start`, {}, task.token);
  // A commit unrelated to the base reaches the branch, but the finish check refuses it.
  assert.equal((await f.push(task.id, task.token, zero, stray, 'refs/heads/' + task.branch)).status, 200);
  assert.deepEqual(await f.machine(`tasks/${task.id}/finish`, { state: 'succeeded', commitId: stray }, task.token), { status: 200, ok: true, state: 'FAILED' });
  assert.equal((await f.tasks({ action: 'get', id: task.id })).task.failureReason, 'proposal_unverified');
  // The host may refuse a claimed task without starting it; usage is optional.
  const second = await f.assign(host);
  const claimed = await f.machine('claim', { claimId: uuid() }, host.credential);
  assert.equal(claimed.task.id, second.task.id);
  assert.deepEqual(await f.machine(`tasks/${claimed.task.id}/finish`, { state: 'failed', exitCode: 2, failure: `codex sandbox unavailable ${claimed.task.token}` }, claimed.task.token), { status: 200, ok: true, state: 'FAILED' });
  assert.equal((await f.tasks({ action: 'get', id: claimed.task.id })).task.failureReason, 'codex sandbox unavailable ***');
});

test('cancel: queued at once, claimed and running through heartbeat, log and Git; who may cancel', async t => {
  const f = await fixture(t), host = await f.connect();
  assert.equal((await f.update(host, { shareSignins: true, allowedUsers: ['bob'], maxConcurrent: 2 })).status, 200);
  const queued = (await f.assign(host, {}, 'bob')).task;
  assert.equal((await f.tasks({ action: 'cancel', id: queued.id }, 'carol')).status, 403);
  // The host's owner manages it, so she can cancel bob's task even without being its requester.
  assert.equal((await f.tasks({ action: 'cancel', id: queued.id }, 'alice')).task.state, 'CANCELLED');
  const running = (await f.assign(host, {}, 'bob')).task, claimed = (await f.assign(host, {}, 'bob')).task;
  const first = (await f.machine('claim', { claimId: uuid() }, host.credential)).task, second = (await f.machine('claim', { claimId: uuid() }, host.credential)).task;
  assert.deepEqual([first.id, second.id], [running.id, claimed.id]);
  await f.machine(`tasks/${first.id}/start`, {}, first.token);
  for (const id of [running.id, claimed.id]) assert.equal((await f.tasks({ action: 'cancel', id }, 'bob')).task.cancelRequested, true);
  assert.deepEqual((await f.machine('heartbeat', { tools }, host.credential)).cancel.sort(), [running.id, claimed.id].sort());
  assert.equal((await f.machine(`tasks/${first.id}/log`, { offset: 0, lines: ['stopping'] }, first.token)).cancel, true);
  assert.deepEqual(await f.machine(`tasks/${second.id}/start`, {}, second.token), { status: 200, ok: true, cancel: true });
  assert.equal((await f.push(first.id, first.token, zero, proposal, 'refs/heads/' + first.branch)).status, 403);
  assert.equal((await f.machine(`tasks/${first.id}/finish`, { state: 'cancelled' }, first.token)).state, 'CANCELLED');
  assert.equal((await f.tasks({ action: 'cancel', id: running.id }, 'bob')).status, 412);
});

test('a task push takes the same ref fence; settling its unknown outcome records the task commit and no pipeline intake', async t => {
  const f = await fixture(t), host = await f.connect(), task = (await f.assign(host)).task;
  const { token } = (await f.machine('claim', { claimId: uuid() }, host.credential)).task, ref = 'refs/heads/' + task.branch;
  await f.machine(`tasks/${task.id}/start`, {}, token);
  // A write to the task branch whose outcome is unknown fences the branch; the provider turns out to hold the commit.
  const unknown = uuid();
  f.sql.prepare("INSERT INTO git_operations(id,repository_id,user_id,ref,old_sha,new_sha,state,created_at) VALUES(?,1,1,?,?,?,'DISPATCHED','2026-01-01T00:00:00.000Z')").run(unknown, ref, zero, proposal);
  f.sql.prepare('INSERT INTO git_ref_writes(operation_id,repository_id,ref) VALUES(?,1,?)').run(unknown, ref);
  const pushed = await f.push(task.id, token, zero, proposal, ref);
  assert.equal(pushed.status, 409); assert.match(await pushed.text(), /another push to the branch is in flight/); assert.deepEqual(f.pushes, []);
  f.refs.get('repo-' + 'b'.repeat(32)).set(ref, proposal);
  const env = { ...f.env, providerFetch: f.providerFetch, PIPELINES_ENABLED: 'true', PIPELINE_BUCKET: {}, PIPELINE_QUEUE: { send() { throw Error('no intake for task branches'); } } };
  assert.deepEqual(await settleRefWrites(env, withArtifact), { processed: 1 });
  assert.equal(f.sql.prepare('SELECT state FROM git_operations WHERE id=?').get(unknown).state, 'APPLIED');
  assert.equal(f.sql.prepare('SELECT commit_id FROM agent_tasks WHERE id=?').get(task.id).commit_id, proposal);
  assert.equal(f.sql.prepare('SELECT COUNT(*) n FROM pipeline_intake').get().n, 0);
  // The task continues from the settled commit.
  f.commits.set(stray, [proposal]);
  assert.equal((await f.push(task.id, token, proposal, stray, ref)).status, 200);
  assert.equal(f.sql.prepare('SELECT commit_id FROM agent_tasks WHERE id=?').get(task.id).commit_id, stray);
});

test('the sweep marks lost hosts and passed deadlines; deleting a host cancels its work', async t => {
  const f = await fixture(t), host = await f.connect();
  assert.equal((await f.update(host, { maxConcurrent: 3 })).status, 200);
  const [lost, late, queued] = [(await f.assign(host)).task, (await f.assign(host)).task, (await f.assign(host)).task];
  const a = (await f.machine('claim', { claimId: uuid() }, host.credential)).task, b = (await f.machine('claim', { claimId: uuid() }, host.credential)).task;
  assert.deepEqual([a.id, b.id], [lost.id, late.id]);
  f.sql.prepare('UPDATE agent_tasks SET deadline=? WHERE id=?').run(Date.now() - 1, late.id);
  assert.equal((await f.machine(`tasks/${late.id}/log`, { offset: 0, lines: ['x'] }, b.token)).status, 401);
  const db = f.env.DB;
  assert.deepEqual(await sweepAgentTasks(db), { processed: 1 });
  f.sql.prepare('UPDATE agent_hosts SET last_seen_at=? WHERE id=?').run(new Date(Date.now() - 4 * 60_000).toISOString(), Number(host.hostId));
  assert.deepEqual(await sweepAgentTasks(db), { processed: 1 });
  assert.deepEqual(f.sql.prepare('SELECT id,state,failure_reason FROM agent_tasks ORDER BY created_at,id').all().map(row => [row.id, row.state, row.failure_reason]).sort(),
    [[lost.id, 'LOST', 'lost'], [late.id, 'TIMED_OUT', 'timed_out'], [queued.id, 'QUEUED', '']].sort());
  // The finish of a swept task replays its state.
  assert.equal((await f.machine(`tasks/${lost.id}/finish`, { state: 'succeeded', commitId: proposal }, a.token)).state, 'LOST');
  assert.equal((await f.hosts({ action: 'delete', id: host.hostId })).status, 200);
  assert.deepEqual((await f.tasks({ action: 'get', id: queued.id })).task.failureReason, 'host_deleted');
});

test('logs stop storing past their bound and say so; the prompt is bounded at 32 KiB', async t => {
  const f = await fixture(t), host = await f.connect(), created = (await f.assign(host)).task;
  const { task } = await f.machine('claim', { claimId: uuid() }, host.credential);
  await f.machine(`tasks/${task.id}/start`, {}, task.token);
  const line = 'x'.repeat(300);
  let offset = 0;
  for (let i = 0; i < 10; i++) offset = (await f.machine(`tasks/${task.id}/log`, { offset, lines: Array(200).fill(line) }, task.token)).nextOffset;
  assert.equal(offset, 2000);
  const view = (await f.tasks({ action: 'get', id: created.id })).task;
  assert.deepEqual([view.logLines, view.logTruncated], [2000, true]);
  const stored = f.sql.prepare('SELECT COUNT(*) AS n,SUM(length(text)+1) AS bytes FROM agent_task_logs WHERE task_id=?').get(task.id);
  assert.ok(stored.bytes <= 512 * 1024 && stored.n < 2000, JSON.stringify(stored));
  assert.equal((await f.machine(`tasks/${task.id}/log`, { offset, lines: ['y'.repeat(70 * 1024)] }, task.token)).status, 413);
  const prompt = buildPrompt({ name: 'project', owner_slug: 'alice' }, f.env, { kind: 'issue', baseRef: 'refs/heads/main', baseCommit: base, branch: 'golf-agent/x' }, { number: 1, title: 'Big', body: 'z'.repeat(64 * 1024) }, [], 'Do it.', 'alice');
  assert.ok(new TextEncoder().encode(prompt).length <= 32 * 1024); assert.match(prompt, /Truncated by Golf[\s\S]*Instructions from alice\n\nDo it\./);
});

test('the capability is ready with the schema and the feature follows the installation policy', async t => {
  const f = await fixture(t);
  const capabilities = async () => (await f.signed('/rpc/golf.v1.CapabilityService/ListCapabilities', {})).capabilities.find(c => c.id === 'agents.hosts');
  assert.equal((await capabilities()).state, 'CAPABILITY_STATE_READY');
  f.sql.exec("INSERT INTO feature_policies(scope,scope_id,feature,mode,version,updated_by,updated_at) VALUES('installation','','agent-hosts','DISABLED',1,1,'t')");
  assert.equal((await capabilities()).state, 'CAPABILITY_STATE_DISABLED');
  assert.deepEqual(await f.tasks({ action: 'available' }), { status: 200, hosts: [], featureOn: false, reason: 'Coding agents on your machines are turned off for this repository by the installation policy.' });
});

test('review tasks: a pull request only, a read-only tool on a 0.2.0 host, no MCP or push, and the review is the finish', async t => {
  const f = await fixture(t), host = await f.connect();
  const review = (body = {}) => f.assign(host, { target: { kind: 'pull_request', number: 14 }, mode: 'review', ...body });
  // The host registered as 0.1.0; a heartbeat that reports 0.2.0 lets it review.
  let refused = await review();
  assert.equal(refused.status, 412); assert.match(refused.message, /golf-agent-host 0\.1\.0; review tasks need 0\.2\.0/);
  assert.equal((await f.machine('heartbeat', { tools, hostVersion: '0.2.0' }, host.credential)).status, 200);
  refused = await review({ target: { kind: 'issue', number: 12 } });
  assert.equal(refused.status, 400); assert.match(refused.message, /reviews a pull request/);
  refused = await review({ tool: 'opencode' });
  assert.equal(refused.status, 412); assert.match(refused.message, /OpenCode has no read-only mode/);
  assert.equal((await review({ mode: 'bogus' })).status, 400);
  const created = (await review({ instructions: 'Focus on error handling.' })).task;
  assert.deepEqual([created.mode, created.baseRef, created.baseCommit], ['review', 'refs/heads/feature', feature]);
  assert.equal((await f.assign(host)).task.mode, 'change');
  // The claimed job says review, carries no MCP endpoint, and the prompt asks for a review without changes.
  const { task } = await f.machine('claim', { claimId: uuid() }, host.credential);
  assert.equal(task.id, created.id);
  assert.deepEqual([task.mode, task.mcp], ['review', null]);
  assert.match(task.prompt, /This is a read-only review; Golf discards any change\./); assert.match(task.prompt, /Focus on error handling\./);
  await f.machine(`tasks/${task.id}/start`, {}, task.token);
  // The task token cannot push, and a finish naming a commit is refused.
  const pushed = await f.push(task.id, task.token, zero, proposal, 'refs/heads/' + task.branch);
  assert.equal(pushed.status, 403); assert.match(await pushed.text(), /read-only/);
  assert.equal((await f.machine(`tasks/${task.id}/finish`, { state: 'succeeded', commitId: proposal, summary: 'x' }, task.token)).status, 400);
  // A review longer than 4 KiB (up to 12 KiB) is kept whole.
  const text = 'Looks fine. ' + 'Finding at src/parse.js:3. '.repeat(300);
  assert.deepEqual(await f.machine(`tasks/${task.id}/finish`, { state: 'succeeded', exitCode: 0, summary: text, usage: { inputTokens: 10 } }, task.token), { status: 200, ok: true, state: 'SUCCEEDED' });
  const done = (await f.tasks({ action: 'get', id: task.id })).task;
  assert.deepEqual([done.state, done.mode, done.commitId, done.summary.length], ['SUCCEEDED', 'review', '', text.length]);
  assert.equal(f.pushes.length, 0);
});
