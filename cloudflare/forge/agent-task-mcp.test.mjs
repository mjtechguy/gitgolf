// Agent task tokens on the remote MCP endpoint and the Source API (docs/AGENT_ACCESS.md, docs/AGENT_HOSTS.md): a running task's own
// golf_agent_task_ token reads its repository and writes only its branch, opens pull requests only from it (origin agent-task) and
// comments only on its issue or pull request, is refused on /git/ and every other route and once the task stops, and is counted
// under the task's rate budget. The claim names the MCP endpoint.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { accessFixture, bearer, basic, origin, repository } from './agent-access-fixture.mjs';
import { tokens } from './object-fixture.mjs';
import { handle, serialize, admission, digest } from './src/core.mjs';
import { packetLine } from './src/git.mjs';
import { machineTokenRoute } from './src/api-tokens.mjs';
import { publicFetch } from './src/public.mjs';
import { AgentBudgets } from './src/agent-budgets.mjs';
import { gitAvailable, gitFixture } from './git-cli-fixture.mjs';

const artifact = 'repo-' + 'b'.repeat(32), gitTypes = { '040000': 'tree', '100644': 'blob', '100755': 'exec', '120000': 'symlink', '160000': 'gitlink' };
const text = result => result.content[0].text, data = result => JSON.parse(text(result));

// A host owned by bob and one task of his on alice/project, for issue #12, in the given state.
async function addTask(f, { state = 'RUNNING', requester = 2, target = ['issue', 12], hostId = 1 } = {}) {
  if (!f.sql.prepare('SELECT 1 FROM agent_hosts WHERE id=?').get(hostId))
    f.sql.prepare(`INSERT INTO agent_hosts(id,uuid,name,scope,scope_id,registered_by,credential_digest,created_at,last_seen_at) VALUES(?,?,'box','personal',?,?,?,'t','t')`)
      .run(hostId, crypto.randomUUID(), String(requester), requester, 'host-digest-' + hostId);
  const id = crypto.randomUUID(), token = `golf_agent_task_${id}_${'7'.repeat(64)}`, branch = 'golf-agent/' + id.slice(0, 8);
  f.sql.prepare(`INSERT INTO agent_tasks(id,repository_id,artifact_name,host_id,tool,requested_by,target_kind,target_number,base_ref,base_commit,branch,prompt,state,token_digest,deadline,idempotency_key,created_at,updated_at)
    VALUES(?,1,?,?,'claude',?,?,?,'refs/heads/main',?,?,'p',?,?,?,?,'t','t')`).run(id, artifact, hostId, requester, target[0], target[1], 'a'.repeat(40), branch, state, await digest(token), Date.now() + 3_600_000, id);
  return { id, token, branch };
}

test('a running task token reads through MCP as its requester, within its repository; tools/list and instructions name its branch', async t => {
  const f = await accessFixture(t);
  f.env.agentBudgets = new AgentBudgets();
  const task = await addTask(f);
  const init = await f.mcp(task.token, 'initialize', { protocolVersion: '2025-06-18' });
  assert.equal(init.status, 200); assert.match(init.result.instructions, new RegExp(`writes only the branch ${task.branch}.*comment only on #12`));
  assert.deepEqual((await f.mcp(task.token, 'tools/list')).result.tools.filter(tool => !tool.annotations.readOnlyHint).map(tool => tool.name), ['commit_changes', 'create_branch', 'open_pull_request', 'comment']);
  assert.equal(data(await f.tool(task.token, 'repo_overview')).fullName, 'alice/project');
  assert.equal(data(await f.tool(task.token, 'get_issue', { number: 12 })).title, 'Fix the parser');
  assert.equal(data(await f.tool(task.token, 'get_pull_request', { number: 14 })).head.ref, 'feature');
  // Another repository bob can read is outside the task's scope; the refusal is audited at that repository without the token.
  const outside = await f.tool(task.token, 'repo_overview', { name: 'tooling' });
  assert.deepEqual([outside.isError, text(outside)], [true, 'This agent task token does not cover this repository.']);
  const audit = f.sql.prepare("SELECT action,scope_id,after,client FROM installation_audit WHERE action='api_token.use_denied'").get();
  assert.deepEqual([audit.scope_id, JSON.parse(audit.after), JSON.parse(audit.client).via], ['2', { agentTaskId: task.id, reason: 'repository' }, 'agent_task']);
  assert.ok(!JSON.stringify(audit).includes(task.token.slice(-64)));
  // Every MCP message with an id counts against the task's own budget, the same window as its host protocol calls.
  assert.deepEqual(f.env.agentBudgets.usage('task', task.id), { requests: 6, writes: 0, resetsInSeconds: 60 });
  assert.equal((await f.mcp(task.token, 'tools/call', { name: 'comment', arguments: { ...repository, number: 12, body: 'Working on it.' } })).result.isError, undefined);
  assert.deepEqual(f.env.agentBudgets.usage('task', task.id), { requests: 7, writes: 1, resetsInSeconds: 60 });
  assert.equal(f.env.agentBudgets.usage('token', task.id).requests, 0);
});

test('a task token is refused on /git/, on every RPC and account route, and once its task stops, is cancelled, expires or loses its writer', async t => {
  const f = await accessFixture(t);
  const task = await addTask(f);
  // Not Git: neither as a Bearer nor as Basic (the task has its own Git route).
  assert.equal((await f.git(bearer(task.token), 'info/refs?service=git-upload-pack')).status, 401);
  assert.equal((await f.git(basic(task.token, 'golf'), 'info/refs?service=git-upload-pack')).status, 401);
  assert.equal((await f.push(bearer(task.token), 'refs/heads/' + task.branch)).status, 401);
  assert.equal(f.pushes.length, 0);
  // Not the UI's routes: the MCP tools reach their allowlist only as internal requests.
  for (const [path, body] of [['/rpc/golf.v1.RepositoryService/GetRepository', { repository }], ['/rpc/golf.v1.RepositoryService/CreateIssueComment', { repository, number: 12, body: 'x' }],
    ['/rpc/golf.v1.SessionService/GetSession', {}], ['/native/api-tokens', { action: 'list' }], ['/native/agent-tasks', { action: 'list', repository, repositoryId: '1' }]]) {
    const refused = await f.rpc(path, body, task.token);
    assert.equal(refused.status, 401, path); assert.match(refused.message, /accepted only on \/mcp, \/native\/source\//, path);
  }
  // The Source API directly: reads work, writes outside the branch are refused by scope.
  assert.equal((await f.rpc('/native/source/files', { repository, ref: 'main', paths: ['hello.txt'] }, task.token)).files[0].content, 'hello\n');
  const main = await f.rpc('/native/source/branch', { repository, branch: 'elsewhere', action: 'create', from: 'main' }, task.token);
  assert.deepEqual([main.status, main.message], [403, `This agent task token may write only to branches matching ${task.branch}.`]);
  // A token for another task id, or a finished, cancel-requested, expired or unwritable task: refused.
  assert.equal((await f.mcp(`golf_agent_task_${crypto.randomUUID()}_${'7'.repeat(64)}`, 'ping')).status, 401);
  const status = async () => (await f.mcp(task.token, 'ping')).status;
  assert.equal(await status(), 200);
  for (const [change, restore, expected] of [["state='SUCCEEDED'", "state='RUNNING'", 401], ["state='CLAIMED'", "state='RUNNING'", 401], ['cancel_requested=1', 'cancel_requested=0', 401],
    [`deadline=${Date.now() - 1}`, `deadline=${Date.now() + 3_600_000}`, 401]]) {
    f.sql.exec(`UPDATE agent_tasks SET ${change} WHERE id='${task.id}'`);
    assert.equal(await status(), expected, change);
    f.sql.exec(`UPDATE agent_tasks SET ${restore} WHERE id='${task.id}'`);
  }
  f.sql.exec("UPDATE grants SET role='read' WHERE repository_id=1 AND user_id=2");
  const lost = await f.mcp(task.token, 'ping');
  assert.deepEqual([lost.status, lost.message], [403, 'The task’s requester no longer has write access to its repository.']);
  f.sql.exec("UPDATE grants SET role='write' WHERE repository_id=1 AND user_id=2");
  // The repository's agent-access feature governs task tokens like API tokens.
  f.sql.exec("INSERT INTO feature_policies(scope,scope_id,feature,mode,version,updated_by,updated_at) VALUES('installation','','agent-access','DISABLED',1,1,'t')");
  assert.match(text(await f.tool(task.token, 'repo_overview')), /API tokens and MCP are turned off/);
});

test('the public Worker lets a task token through Access only on /mcp and /native/source/*, never on Git or other routes', async () => {
  const id = crypto.randomUUID(), token = `golf_agent_task_${id}_${'7'.repeat(64)}`, forwarded = [];
  for (const [path, authorization, expected] of [['/mcp', bearer(token), true], ['/native/source/commit', bearer(token), true], ['/native/source/files', basic(token, 'golf'), false],
    ['/git/alice/project.git/info/refs', bearer(token), false], ['/git/alice/project.git/git-receive-pack', basic(token, 'golf'), false], ['/rpc/golf.v1.RepositoryService/GetRepository', bearer(token), false],
    ['/native/agent-tasks', bearer(token), false], ['/mcp', bearer(token.slice(0, -1)), false], ['/mcp', bearer(token.toUpperCase()), false]]) assert.equal(machineTokenRoute(path, authorization), expected, path);
  const env = { PUBLIC_ORIGIN: origin, ACCESS_AUD: 'aud', WORKSPACE_SLUG: 'alice', ASSETS: { fetch() { throw Error('No asset dispatch'); } } };
  const ctx = { exports: { Workspace: { idFromName: key => key, get: () => ({ fetch: async request => {
    forwarded.push([new URL(request.url).pathname, request.headers.get('X-Golf-Native-Access-Email'), request.headers.get('Cookie')]);
    return new Response('workspace');
  } }) } } };
  const send = (path, authorization) => publicFetch(new Request(origin + path, { method: 'POST', body: '{}',
    headers: { Authorization: authorization, Cookie: 'CF_Authorization=forged', 'X-Golf-Native-Access-Email': 'forged@example.com' } }), env, ctx);
  assert.equal(await (await send('/mcp', bearer(token))).text(), 'workspace');
  // The Source API passes Access the same way and is served by the Worker itself (scale-out S2, S3); this stub has no database.
  for (const path of ['/native/source/commit', '/native/source/files']) assert.equal((await send(path, bearer(token))).status, 503, path);
  for (const path of ['/git/alice/project.git/git-receive-pack', '/rpc/golf.v1.RepositoryService/GetRepository', '/native/agent-tasks']) assert.equal((await send(path, bearer(token))).status, 401, path);
  assert.deepEqual(forwarded, [['/mcp', null, null]]);
});

test('claim names the MCP endpoint for the task token, and null while agent access is off for the repository', async t => {
  const f = await accessFixture(t);
  const uuid = crypto.randomUUID(), credential = `golf_agent_host_${uuid}_${'5'.repeat(64)}`;
  f.sql.prepare(`INSERT INTO agent_hosts(id,uuid,name,scope,scope_id,registered_by,credential_digest,created_at,last_seen_at) VALUES(1,?,'box','personal','2',2,?,'t',?)`).run(uuid, await digest(credential), new Date().toISOString());
  f.sql.prepare("INSERT INTO agent_host_tools(host_id,tool,version,signed_in,account,updated_at) VALUES(1,'claude','2.1.0',1,'','t')").run();
  const queue = () => { const id = crypto.randomUUID(); f.sql.prepare(`INSERT INTO agent_tasks(id,repository_id,artifact_name,host_id,tool,requested_by,target_kind,target_number,base_ref,base_commit,branch,prompt,state,deadline,idempotency_key,created_at,updated_at)
    VALUES(?,1,?,1,'claude',2,'issue',12,'refs/heads/main',?,?,'p','QUEUED',?,?,?,?)`).run(id, artifact, 'a'.repeat(40), 'golf-agent/' + id.slice(0, 8), Date.now() + 1_800_000, id, new Date().toISOString(), new Date().toISOString()); return id; };
  const claim = async () => {
    const response = await f.dispatch(new Request(origin + '/native/agent-host/claim', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: bearer(credential) }, body: JSON.stringify({ claimId: crypto.randomUUID() }) }));
    assert.equal(response.status, 200); return (await response.json()).task;
  };
  const first = queue(), claimed = await claim();
  assert.equal(claimed.id, first); assert.deepEqual(claimed.mcp, { url: origin + '/mcp' });
  // The claimed token is the MCP credential once the task starts.
  assert.equal((await f.mcp(claimed.token, 'ping')).status, 401);
  const start = await f.dispatch(new Request(`${origin}/native/agent-host/tasks/${first}/start`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: bearer(claimed.token) }, body: '{}' }));
  assert.equal(start.status, 200);
  assert.equal((await f.mcp(claimed.token, 'ping')).status, 200);
  f.sql.exec(`UPDATE agent_tasks SET state='SUCCEEDED' WHERE id='${first}'`);
  f.sql.exec("INSERT INTO feature_policies(scope,scope_id,feature,mode,version,updated_by,updated_at) VALUES('installation','','agent-access','DISABLED',1,1,'t')");
  queue();
  assert.equal((await claim()).mcp, null);
});

// End to end over a real bare repository: the Source API tools write only the task's branch, the pull request records the task.
test('a task commits only to its branch, opens its pull request with origin agent-task, comments on its own issue and pull request; a stop mid-request writes nothing', { skip: !gitAvailable }, async t => {
  const f = await accessFixture(t), g = gitFixture(t);
  const git = args => spawnSync('git', ['--git-dir', g.directory, ...args], { env: g.env, maxBuffer: 1 << 28 });
  const head = ref => git(['rev-parse', '--verify', '-q', 'refs/heads/' + ref]).stdout.toString().trim();
  let opened = () => {};
  f.env.ARTIFACTS = { async get(name) { opened(); assert.equal(name, artifact); return {
    async info() { return { name, remote: `https://${f.env.ACCOUNT_ID}.artifacts.cloudflare.net/git/test-space/${name}.git` }; },
    async createToken() { return { plaintext: 'art_v1_local' }; }, async revokeToken() { return true; }, [Symbol.dispose]() {},
    async readCommit(hash) {
      const read = git(['cat-file', 'commit', hash]); if (read.status) return null;
      const body = read.stdout.toString(), headers = body.slice(0, body.indexOf('\n\n')).split('\n');
      return { hash, treeHash: headers[0].slice(5), parents: headers.filter(line => line.startsWith('parent ')).map(line => line.slice(7)), message: body.slice(body.indexOf('\n\n') + 2), author: { name: 'x' }, authoredAt: 1 };
    },
    async readTree(hash) {
      const listed = git(['ls-tree', '-z', hash]); if (listed.status) return null;
      return listed.stdout.toString().split('\0').filter(Boolean).map(line => { const [mode, , id] = line.slice(0, line.indexOf('\t')).split(' '); return { name: line.slice(line.indexOf('\t') + 1), type: gitTypes[mode], hash: id, mode }; });
    },
    async readBlob(hash) { const read = git(['cat-file', 'blob', hash]); return read.status ? null : new Blob([read.stdout]); },
    async log({ ref, limit = 20 }) { const listed = git(['rev-list', `--max-count=${limit}`, ref]); return listed.status ? [] : await Promise.all(listed.stdout.toString().trim().split('\n').filter(Boolean).map(hash => this.readCommit(hash))); },
  }; } };
  const providerFetch = async (url, options = {}) => {
    if (options.method === 'POST') return new Response(spawnSync('git', ['receive-pack', '--stateless-rpc', g.directory], { env: g.env, input: Buffer.from(options.body) }).stdout, { headers: { 'Content-Type': 'application/x-git-receive-pack-result' } });
    return new Response(Buffer.concat([packetLine('# service=git-upload-pack\n'), Buffer.from('0000'), spawnSync('git', ['upload-pack', '--stateless-rpc', '--advertise-refs', g.directory], { env: g.env }).stdout]), { headers: { 'Content-Type': 'application/x-git-upload-pack-advertisement' } });
  };
  globalThis.fetch = providerFetch;
  const dispatch = serialize(request => handle(request, f.env, providerFetch), admission);
  const call = async (secret, name, args) => (await (await dispatch(new Request(origin + '/mcp', { method: 'POST', headers: { Authorization: bearer(secret), 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: { ...repository, ...args } } }) }))).json()).result;
  const seeded = await dispatch(new Request(origin + '/native/source/commit', { method: 'POST', headers: { Authorization: bearer(tokens.admin), 'Content-Type': 'application/json', 'Connect-Protocol-Version': '1' },
    body: JSON.stringify({ repository, branch: 'main', expectedHead: '', message: 'Initial', changes: [{ path: 'README.md', content: '# Project\n' }] }) }));
  assert.equal(seeded.status, 200, await seeded.clone().text());
  const main = head('main'), task = await addTask(f);
  assert.equal(data(await call(task.token, 'read_files', { paths: ['README.md'] })).files[0].content, '# Project\n');
  // Its branch only: commit_changes creates it from main; main and other branches are refused before anything is written.
  const committed = data(await call(task.token, 'commit_changes', { branch: task.branch, expectedHead: '', base: main, message: 'Agent edit', changes: [{ path: 'README.md', content: '# Project\n\nFixed.\n' }] }));
  assert.equal(head(task.branch), committed.commitId);
  for (const [name, args] of [['commit_changes', { branch: 'main', expectedHead: main, message: 'No', changes: [{ path: 'x', content: 'x' }] }], ['create_branch', { branch: 'agent/other', from: 'main' }],
    ['commit_changes', { branch: task.branch + '-2', expectedHead: '', base: main, message: 'No', changes: [{ path: 'x', content: 'x' }] }]]) {
    const refused = await call(task.token, name, args);
    assert.deepEqual([refused.isError, text(refused)], [true, `This agent task token may write only to branches matching ${task.branch}.`], name);
  }
  assert.equal(head('main'), main); assert.equal(head('agent/other'), '');
  // Pull requests only from its branch; the origin is the task.
  const elsewhere = await call(task.token, 'open_pull_request', { head: 'feature', base: 'main', title: 'Not mine' });
  assert.deepEqual([elsewhere.isError, text(elsewhere)], [true, `This agent task may open a pull request only from its branch ${task.branch}.`]);
  const pull = data(await call(task.token, 'open_pull_request', { head: task.branch, base: 'main', title: 'Fix the parser', body: 'Closes #12.' }));
  assert.deepEqual([pull.head.ref, pull.head.commitId, pull.base.commitId], [task.branch, committed.commitId, main]);
  const origin_ = f.sql.prepare('SELECT o.kind,o.api_token_id,o.agent_task_id,d.author_id FROM pull_request_origins o JOIN pull_requests p ON p.id=o.pull_request_id JOIN discussions d ON d.id=p.discussion_id WHERE d.number=?').get(pull.number);
  assert.deepEqual({ ...origin_ }, { kind: 'agent-task', api_token_id: null, agent_task_id: task.id, author_id: 2 });
  // Comments: its issue and the pull request it opened, nothing else.
  assert.equal(data(await call(task.token, 'comment', { number: 12, body: 'Opened a fix.' })).kind, 'issue');
  assert.equal(data(await call(task.token, 'comment', { number: pull.number, body: 'Ready.' })).kind, 'pull_request');
  const other = await call(task.token, 'comment', { number: 14, body: 'Unrelated.' });
  assert.deepEqual([other.isError, text(other)], [true, `This agent task may comment only on #12 and on pull requests from its branch ${task.branch}.`]);
  assert.equal(f.sql.prepare("SELECT COUNT(*) AS n FROM discussion_comments WHERE body='Unrelated.'").get().n, 0);
  // Cancelled after admission but before the reservation: the guard in the reservation refuses, the branch does not move.
  const current = head(task.branch);
  opened = () => { opened = () => {}; f.sql.prepare('UPDATE agent_tasks SET cancel_requested=1 WHERE id=?').run(task.id); };
  const raced = await call(task.token, 'commit_changes', { branch: task.branch, expectedHead: current, message: 'Raced', changes: [{ path: 'c.txt', content: 'c\n' }] });
  assert.equal(raced.isError, true); assert.match(text(raced), /changed during the request; nothing was sent/);
  assert.equal(head(task.branch), current);
  // Once the task has finished, nothing is accepted at all.
  f.sql.prepare("UPDATE agent_tasks SET cancel_requested=0,state='SUCCEEDED' WHERE id=?").run(task.id);
  assert.equal((await dispatch(new Request(origin + '/mcp', { method: 'POST', headers: { Authorization: bearer(task.token), 'Content-Type': 'application/json' }, body: '{"jsonrpc":"2.0","id":1,"method":"ping"}' }))).status, 401);
});
