// Remote MCP (docs/AGENT_ACCESS.md, AM-3): the JSON-RPC protocol over POST /mcp, the tool catalogue by token permission, read and
// write tools through the same handlers as the UI, and the Source API tools against the AM-2 contract, with a stub handler and end to end.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { accessFixture, bearer, origin, repository, base, feature } from './agent-access-fixture.mjs';
import { tokens } from './object-fixture.mjs';
import { mcpEndpoint, mcpClass, mcpActivity } from './src/mcp.mjs';
import { spawnSync } from 'node:child_process';
import { handle, serialize, admission } from './src/core.mjs';
import { packetLine } from './src/git.mjs';
import { gitAvailable, gitFixture } from './git-cli-fixture.mjs';
import { publicFetch } from './src/public.mjs';
import { AgentBudgets, chargeBudget } from './src/agent-budgets.mjs';

const gitTypes = { '040000': 'tree', '100644': 'blob', '100755': 'exec', '120000': 'symlink', '160000': 'gitlink' };

const text = result => result.content[0].text, data = result => JSON.parse(text(result));
const readTools = ['repo_overview', 'list_tree', 'read_files', 'search_code', 'grep', 'blame', 'list_commits', 'compare', 'get_issue', 'list_issues', 'get_pull_request', 'pull_request_diff', 'pipeline_status'];
const writeTools = ['commit_changes', 'create_branch', 'open_pull_request', 'comment'];

test('protocol: initialize negotiates the version, notifications get 202, GET is 405, and only a bearer credential is accepted', async t => {
  const f = await accessFixture(t);
  const { secret } = await f.create({ permission: 'read' });
  const init = await f.mcp(secret, 'initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
  assert.equal(init.status, 200); assert.equal(init.headers.get('Content-Type'), 'application/json'); assert.equal(init.headers.get('Cache-Control'), 'no-store');
  assert.deepEqual([init.jsonrpc, init.id, init.result.protocolVersion, init.result.serverInfo.name], ['2.0', 1, '2025-03-26', 'golf']);
  assert.deepEqual(init.result.capabilities, { tools: {} }); assert.match(init.result.instructions, /read-only/);
  assert.equal((await f.mcp(secret, 'initialize', { protocolVersion: '1999-01-01' }, 'a')).result.protocolVersion, '2025-06-18');
  assert.equal((await f.mcp(secret, 'notifications/initialized', undefined, null)).status, 202);
  assert.deepEqual((await f.mcp(secret, 'ping', undefined, 7)).result, {});
  assert.equal((await f.dispatch(new Request(origin + '/mcp', { headers: { Authorization: bearer(secret) } }))).status, 405);
  // No credential, or only a browser session: 401 with a Bearer challenge.
  for (const headers of [{}, { 'X-Golf-Native-Access-Email': 'alice@example.invalid' }, { Authorization: 'Bearer golf_pat_' + 'Z'.repeat(43) }]) {
    const refused = await f.dispatch(new Request(origin + '/mcp', { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: '{"jsonrpc":"2.0","id":1,"method":"ping"}' }));
    assert.equal(refused.status, 401); assert.equal(refused.headers.get('WWW-Authenticate'), 'Bearer realm="Golf MCP"');
  }
  // A native credential is a bearer too, with its account's own authority.
  assert.equal((await f.mcp(tokens.admin, 'ping')).status, 200);
  const raw = (body, type = 'application/json') => f.dispatch(new Request(origin + '/mcp', { method: 'POST', headers: { Authorization: bearer(secret), 'Content-Type': type }, body })).then(async r => [r.status, (await r.json()).error?.code]);
  assert.deepEqual(await raw('{not json'), [400, -32700]);
  assert.deepEqual(await raw('[{"jsonrpc":"2.0","id":1,"method":"ping"}]'), [400, -32600]);
  assert.deepEqual(await raw('{"jsonrpc":"1.0","id":1,"method":"ping"}'), [400, -32600]);
  assert.deepEqual(await raw('{"jsonrpc":"2.0","id":1,"method":"ping"}', 'text/plain'), [415, -32700]);
  assert.equal((await f.mcp(secret, 'resources/list')).error.code, -32601);
  assert.equal((await f.mcp(secret, 'tools/call', { name: 'rm_rf', arguments: {} })).error.code, -32602);
});

test('tools/list shows write tools only to write tokens; every tool has a strict object schema naming the repository', async t => {
  const f = await accessFixture(t);
  const read = (await f.mcp((await f.create({ permission: 'read' })).secret, 'tools/list')).result.tools;
  assert.deepEqual(read.map(tool => tool.name), readTools);
  const write = (await f.mcp((await f.create()).secret, 'tools/list')).result.tools;
  assert.deepEqual(write.map(tool => tool.name), [...readTools, ...writeTools]);
  for (const tool of write) {
    assert.equal(tool.inputSchema.type, 'object'); assert.equal(tool.inputSchema.additionalProperties, false);
    assert.deepEqual(tool.inputSchema.required.slice(0, 2), ['owner', 'name']); assert.ok(tool.description.length > 20);
    assert.equal(tool.annotations.readOnlyHint, !writeTools.includes(tool.name));
  }
  assert.match(write.find(tool => tool.name === 'search_code').description, /^Semantic/);
});

test('read tools call the UI handlers with the token’s authority and scope; refusals are tool errors with Golf’s message', async t => {
  const f = await accessFixture(t);
  const { secret } = await f.create({ permission: 'read', repositories: ['1'] });
  const overview = data(await f.tool(secret, 'repo_overview'));
  assert.deepEqual([overview.fullName, overview.defaultBranch, overview.head, overview.cloneUrl], ['alice/project', 'main', base, origin + '/git/alice/project.git']);
  const commits = data(await f.tool(secret, 'list_commits', { ref: 'feature', limit: 5 }));
  assert.deepEqual(commits.commits.map(c => c.sha), [feature, base]); assert.equal(commits.more, false);
  const compared = text(await f.tool(secret, 'compare', { base: 'main', head: 'feature' }));
  assert.match(compared, new RegExp(`^base main ${base}\nhead feature ${feature}\n\n${feature.slice(0, 12)} Greet the agent \\(Bob\\)`));
  assert.match(compared, /-hello\n\+hello agent/);
  const issue = data(await f.tool(secret, 'get_issue', { number: 12 }));
  assert.deepEqual([issue.title, issue.comments.map(c => c.body)], ['Fix the parser', ['Please add a test.']]);
  assert.deepEqual(data(await f.tool(secret, 'list_issues', { state: 'all' })).issues.map(i => i.number), [12]);
  const pull = data(await f.tool(secret, 'get_pull_request', { number: 14 }));
  assert.deepEqual([pull.head.ref, pull.base.ref, pull.head.commitId], ['feature', 'main', feature]);
  assert.match(text(await f.tool(secret, 'pull_request_diff', { number: 14 })), /^#14 Feature work\nbase main a{40}\nhead feature b{40}\n\ndiff --git a\/hello.txt b\/hello.txt/);
  // Golf's own refusals: out of scope, a missing branch, an unallocated feature, invalid arguments.
  const outside = await f.tool(secret, 'repo_overview', { name: 'tooling' });
  assert.deepEqual([outside.isError, text(outside)], [true, 'This API token does not cover this repository.']);
  assert.deepEqual(await f.tool(secret, 'compare', { base: 'main', head: 'nope' }), { isError: true, content: [{ type: 'text', text: 'Branch nope does not exist in alice/project, or the repository is unavailable.' }] });
  assert.equal((await f.tool(secret, 'search_code', { query: 'parser' })).isError, true);
  assert.equal(text(await f.tool(secret, 'pipeline_status')), 'Actions pipelines are not allocated on this installation.');
  assert.equal(text(await f.tool(secret, 'get_issue', { number: 0 })), 'number must be a whole number from 1.');
  assert.equal(text(await f.tool(secret, 'list_issues', { owner: 7 })), 'owner must be a non-empty string of at most 100 characters.');
  assert.equal(text((await f.mcp(secret, 'tools/call', { name: 'get_issue', arguments: [] })).result), 'arguments must be an object.');
  // A read token's write tools are refused before anything runs.
  const refused = await f.tool(secret, 'comment', { number: 12, body: 'hi' });
  assert.deepEqual([refused.isError, text(refused)], [true, 'comment needs a write token; this API token is read-only.']);
  assert.equal(f.sql.prepare('SELECT COUNT(*) AS n FROM discussion_comments').get().n, 1);
});

test('write tools comment and open pull requests as the token’s account, capped by its grant', async t => {
  const f = await accessFixture(t);
  const { secret } = await f.create({ repositories: ['1'], branchPattern: 'agent/*' }, 'bob');
  assert.deepEqual(data(await f.tool(secret, 'comment', { number: 12, body: 'On it.' })).kind, 'issue');
  assert.deepEqual(data(await f.tool(secret, 'comment', { number: 14, body: 'Reviewed.' })).kind, 'pull_request');
  assert.deepEqual(f.sql.prepare('SELECT discussion_id,author_id,body FROM discussion_comments ORDER BY id').all().map(r => [r.discussion_id, r.author_id, r.body]), [[1, 1, 'Please add a test.'], [1, 2, 'On it.'], [4, 2, 'Reviewed.']]);
  assert.equal(text(await f.tool(secret, 'comment', { number: 99, body: 'x' })), 'No issue or pull request #99 in alice/project, or the repository is unavailable.');
  const opened = data(await f.tool(secret, 'open_pull_request', { head: 'agent/demo', base: 'main', title: 'Agent change', body: 'From MCP.' }));
  assert.deepEqual([opened.number, opened.head.ref, opened.head.commitId, opened.base.commitId], [15, 'agent/demo', feature, base]);
  assert.deepEqual({ ...f.sql.prepare("SELECT d.author_id,d.title,p.head_branch FROM pull_requests p JOIN discussions d ON d.id=p.discussion_id WHERE d.number=15").get() }, { author_id: 2, title: 'Agent change', head_branch: 'agent/demo' });
  assert.match(text(await f.tool(secret, 'open_pull_request', { head: 'agent/demo', base: 'main', title: 'Again' })), /already exists/);
  // An administrator's write token opens one too: authority re-checks compare the owner's actual grant, not the token's permission.
  const admin = (await f.create({ repositories: ['1'], branchPattern: 'agent/*' }, 'alice')).secret;
  assert.equal(data(await f.tool(admin, 'create_branch', { branch: 'agent/admin', from: 'feature' })).commitId, feature);
  assert.equal(data(await f.tool(admin, 'open_pull_request', { head: 'agent/admin', base: 'main', title: 'Administrator via MCP' })).number, 16);
  // carol reads repository 1: her write token cannot open a pull request there.
  const capped = (await f.create({ repositories: ['1'] }, 'carol')).secret;
  assert.equal((await f.tool(capped, 'open_pull_request', { head: 'feature', base: 'main', title: 'No' })).isError, true);
});

test('Source API tools send the AM-2 request bodies, and results are capped at 256 KiB with a truncated flag', async () => {
  const sent = [], answers = { tree: { entries: [{ path: 'hello.txt', type: 'file' }], truncated: false }, files: { files: [{ path: 'big.txt', content: 'x'.repeat(300 * 1024) }] },
    commit: { commitId: 'c'.repeat(40), treeId: 'd'.repeat(40), previousHead: base, merged: false }, branch: { code: 'failed_precondition', message: 'Branch agent/x already exists.' } };
  const invoke = async request => {
    const path = new URL(request.url).pathname, body = await request.json();
    sent.push([path, body, request.headers.get('Authorization'), request.headers.get('Connect-Protocol-Version')]);
    if (path === '/rpc/golf.v1.RepositoryService/GetRepository') return Response.json({ repository: { id: '1', defaultBranch: 'main' } });
    const action = path.split('/').at(-1);
    return Response.json(answers[action], { status: action === 'branch' ? 412 : 200 });
  };
  const secret = 'golf_pat_' + 'Q'.repeat(43), env = { PUBLIC_ORIGIN: origin };
  const call = async (name, args, permission = 'write') => (await (await mcpEndpoint(new Request(origin + '/mcp', { method: 'POST', headers: { Authorization: bearer(secret), 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: { ...repository, ...args } } }) }), env, async () => ({ id: 1, token_scope: { permission, repositories: null, branchPattern: '' } }), invoke)).json()).result;
  assert.deepEqual(data(await call('list_tree', { path: 'src' })), answers.tree);
  const read = text(await call('read_files', { ref: 'feature', paths: ['big.txt'] }));
  assert.ok(new TextEncoder().encode(read).length < 256 * 1024 + 200); assert.match(read, /\{"truncated": true, "limitBytes": 262144/);
  const changes = [{ path: 'a.txt', content: 'A\n' }, { path: 'bin', contentBase64: 'AAE=', mode: 'executable' }, { path: 'old.txt', delete: true }, { path: 'new.txt', from: 'moved.txt' }];
  assert.deepEqual(data(await call('commit_changes', { branch: 'agent/x', expectedHead: '', base: 'main', message: 'Agent commit', changes, onStale: 'merge' })), answers.commit);
  const branch = await call('create_branch', { branch: 'agent/x', from: 'main' });
  assert.deepEqual([branch.isError, text(branch)], [true, 'Branch agent/x already exists.']);
  assert.deepEqual(sent.map(([path, body]) => [path, body]), [
    ['/rpc/golf.v1.RepositoryService/GetRepository', { repository }],
    ['/native/source/tree', { repository, ref: 'main', path: 'src', recursive: true }],
    ['/native/source/files', { repository, ref: 'feature', paths: ['big.txt'] }],
    ['/native/source/commit', { repository, branch: 'agent/x', expectedHead: '', base: 'main', message: 'Agent commit', changes, onStale: 'merge' }],
    ['/native/source/branch', { repository, branch: 'agent/x', action: 'create', from: 'main' }],
  ]);
  // Every internal request carries the caller's own credential as a Connect JSON call.
  assert.ok(sent.every(([, , authorization, connect]) => authorization === bearer(secret) && connect === '1'));
  assert.equal(text(await call('commit_changes', { branch: 'x', expectedHead: base, message: 'm', changes: [] })), 'changes must list at least one change.');
  assert.equal(text(await call('commit_changes', { branch: 'x', expectedHead: base, message: 'm', changes }, 'read')), 'commit_changes needs a write token; this API token is read-only.');
  assert.equal(sent.length, 5);
});

// The Source API tools end to end: the real /native/source/* routes over a real bare Git repository, under an agent/* write token.
test('an agent/* token reads, branches, commits and opens a pull request through MCP; main, read tokens and a mid-request revocation write nothing', { skip: !gitAvailable }, async t => {
  const f = await accessFixture(t), g = gitFixture(t), artifact = 'repo-' + 'b'.repeat(32);
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
  // The repository's first commit, by the administrator's native credential.
  const seeded = await dispatch(new Request(origin + '/native/source/commit', { method: 'POST', headers: { Authorization: bearer(tokens.admin), 'Content-Type': 'application/json', 'Connect-Protocol-Version': '1' },
    body: JSON.stringify({ repository, branch: 'main', expectedHead: '', message: 'Initial', changes: [{ path: 'README.md', content: '# Project\n' }, { path: 'src/app.js', content: 'console.log(1);\n' }] }) }));
  assert.equal(seeded.status, 200, await seeded.clone().text());
  const main = head('main'), { secret } = await f.create({ repositories: ['1'], branchPattern: 'agent/*' }, 'bob');
  assert.deepEqual(data(await call(secret, 'list_tree', {})).entries.map(e => e.path).sort(), ['README.md', 'src', 'src/app.js']);
  assert.equal(data(await call(secret, 'read_files', { paths: ['README.md'] })).files[0].content, '# Project\n');
  assert.equal((await call(secret, 'create_branch', { branch: 'agent/demo', from: 'main' })).isError, undefined);
  assert.equal(head('agent/demo'), main);
  const committed = data(await call(secret, 'commit_changes', { branch: 'agent/demo', expectedHead: main, message: 'Agent edit', changes: [{ path: 'src/app.js', content: 'console.log(2);\n' }] }));
  assert.equal(head('agent/demo'), committed.commitId);
  assert.equal(git(['show', `${committed.commitId}:src/app.js`]).stdout.toString(), 'console.log(2);\n');
  // A stale head returns the current head with the refusal, for the agent to retry.
  const stale = await call(secret, 'commit_changes', { branch: 'agent/demo', expectedHead: main, message: 'Stale', changes: [{ path: 'b.txt', content: 'b\n' }] });
  assert.equal(stale.isError, true); assert.match(text(stale), new RegExp(`"currentHead": "${committed.commitId}"`));
  // Outside the pattern, nothing is written.
  const refused = await call(secret, 'commit_changes', { branch: 'main', expectedHead: main, message: 'No', changes: [{ path: 'x', content: 'x' }] });
  assert.equal(refused.isError, true); assert.match(text(refused), /agent\/\*/); assert.equal(head('main'), main);
  const pull = data(await call(secret, 'open_pull_request', { head: 'agent/demo', base: 'main', title: 'Agent edit' }));
  assert.deepEqual([pull.head.commitId, pull.base.commitId], [committed.commitId, main]);
  // A read token sees no write tools and cannot call them.
  const reader = (await f.create({ permission: 'read' }, 'bob')).secret;
  assert.equal(text(await call(reader, 'create_branch', { branch: 'agent/r', from: 'main' })), 'create_branch needs a write token; this API token is read-only.');
  assert.equal(head('agent/r'), '');
  // Revoked after admission but before the reservation: the write is not journaled and the branch does not move.
  const late = await f.create({ repositories: ['1'], branchPattern: 'agent/*' }, 'bob');
  const current = head('agent/demo');
  opened = () => { opened = () => {}; f.sql.prepare('UPDATE api_tokens SET revoked_at=? WHERE id=?').run(Math.floor(Date.now() / 1000), Number(late.token.id)); };
  const raced = await call(late.secret, 'commit_changes', { branch: 'agent/demo', expectedHead: current, message: 'Raced', changes: [{ path: 'c.txt', content: 'c\n' }] });
  assert.equal(raced.isError, true); assert.match(text(raced), /changed during the request; nothing was sent/);
  assert.equal(head('agent/demo'), current);
});

test('admission and live activity read the tool from the body: reads overlap, writes are exclusive and publish their repository', () => {
  const body = (method, name, args = { owner: 'alice', name: 'project' }) => JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: { name, arguments: args } });
  for (const name of readTools) assert.equal(mcpClass(body('tools/call', name)), 'read', name);
  for (const name of writeTools) assert.equal(mcpClass(body('tools/call', name)), ['commit_changes', 'create_branch'].includes(name) ? 'transfer' : 'exclusive', name);
  for (const method of ['initialize', 'ping', 'tools/list']) assert.equal(mcpClass(body(method)), 'read');
  assert.equal(mcpClass(body('tools/call', 'unknown')), 'exclusive'); assert.equal(mcpClass('{'), 'exclusive'); assert.equal(mcpClass(body('resources/read')), 'exclusive');
  assert.deepEqual(mcpActivity(body('tools/call', 'commit_changes')), { name: 'project', topics: ['source', 'pulls', 'actions'] });
  assert.deepEqual(mcpActivity(body('tools/call', 'comment')), { name: 'project', topics: ['issues', 'pulls'] });
  assert.equal(mcpActivity(body('tools/call', 'read_files')), undefined);
});

test('the stateless Worker serves read and Source API tools, confirms reads against D1, and leaves other tools to the Workspace', async t => {
  const f = await accessFixture(t);
  f.env.agentBudgets = new AgentBudgets();
  const { secret, token } = await f.create({ repositories: ['1'] });
  const forwarded = [], settled = [], waits = [];
  const ctx = { waitUntil: promise => waits.push(promise), exports: { Workspace: { idFromName: key => key, get: () => ({
    fetch: async request => { forwarded.push(JSON.parse(await request.text()).params?.name); return Response.json({ jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text: 'workspace' }] } }); },
    chargeBudget: (...args) => chargeBudget(f.env, f.env.DB, ...args), writeSettled: async (...args) => { settled.push(args); },
    automations: async () => {}, activityChanged: async () => {} }) } } };
  const call = (name, args) => publicFetch(new Request(origin + '/mcp', { method: 'POST', headers: { Authorization: bearer(secret), 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: { ...repository, ...args } } }) }), { ...f.env, WORKSPACE_SLUG: 'alice' }, ctx).then(r => r.json());
  // A read tool, served here and charged on the Workspace's counters.
  const pull = await call('get_pull_request', { number: 14 });
  assert.equal(pull.result.isError, undefined); assert.equal(data(pull.result).number, 14);
  assert.deepEqual(forwarded, []); assert.equal(f.env.agentBudgets.usage('token', token.id).requests, 1);
  // A Source API tool is a write here, settled once in the Workspace.
  const branch = await call('create_branch', { branch: 'agent/stateless', from: 'feature' });
  assert.equal(branch.result.isError, undefined, text(branch.result)); await Promise.all(waits);
  assert.equal(settled.length, 1); assert.equal(settled[0][0].name, 'project'); assert.equal(settled[0][1], true);
  // Opening a pull request (an exclusive tool) still goes to the Workspace.
  assert.equal(text((await call('open_pull_request', { head: 'agent/stateless', base: 'main', title: 'x' })).result), 'workspace');
  assert.deepEqual(forwarded, ['open_pull_request']);
  // A grant deleted while the read runs: its result is not returned.
  const original = globalThis.fetch;
  globalThis.fetch = (input, init) => { f.sql.prepare('DELETE FROM grants WHERE repository_id=1 AND user_id=1').run(); return original(input, init); };
  try {
    const revoked = await call('get_pull_request', { number: 14 });
    assert.equal(revoked.result.isError, true); assert.ok(!text(revoked.result).includes('Feature work'));
  } finally { globalThis.fetch = original; }
});

test('Source API reads run in the stateless Worker and are confirmed against D1 after they read', async t => {
  const f = await accessFixture(t);
  f.env.agentBudgets = new AgentBudgets();
  const { secret } = await f.create({ repositories: ['1'] });
  const forwarded = [];
  const ctx = { waitUntil() {}, exports: { Workspace: { idFromName: key => key, get: () => ({
    fetch: async request => { forwarded.push(new URL(request.url).pathname); return new Response(null, { status: 204 }); },
    chargeBudget: (...args) => chargeBudget(f.env, f.env.DB, ...args) }) } } };
  const tree = () => publicFetch(new Request(origin + '/native/source/tree', { method: 'POST', headers: { Authorization: bearer(secret), 'Content-Type': 'application/json', 'Connect-Protocol-Version': '1' },
    body: JSON.stringify({ repository, repositoryId: '1', commitId: feature }) }), { ...f.env, WORKSPACE_SLUG: 'alice' }, ctx);
  const read = await tree();
  assert.equal(read.status, 200); assert.ok((await read.json()).entries.length > 0); assert.deepEqual(forwarded, []);
  const original = globalThis.fetch;
  globalThis.fetch = (input, init) => { f.sql.prepare('DELETE FROM grants WHERE repository_id=1 AND user_id=1').run(); return original(input, init); };
  try { const revoked = await tree(); assert.equal(revoked.status, 404); assert.ok(!JSON.stringify(await revoked.json()).includes('hello')); }
  finally { globalThis.fetch = original; }
});

test('requests served by the stateless Worker share one isolate object cache: a second read of the same commit reads nothing again', async t => {
  const f = await accessFixture(t);
  f.env.agentBudgets = new AgentBudgets();
  const { secret } = await f.create({ repositories: ['1'] });
  const ctx = { waitUntil() {}, exports: { Workspace: { idFromName: key => key, get: () => ({ fetch: async () => new Response(null, { status: 204 }), chargeBudget: (...args) => chargeBudget(f.env, f.env.DB, ...args) }) } } };
  const reads = [], get = f.env.ARTIFACTS.get.bind(f.env.ARTIFACTS);
  f.env.ARTIFACTS = { get: async name => { const repo = await get(name); return { ...repo, info: repo.info, [Symbol.dispose]: repo[Symbol.dispose],
    readCommit: async hash => { reads.push(hash); return repo.readCommit(hash); }, readTree: repo.readTree, readBlob: repo.readBlob, readBlobSize: repo.readBlobSize, log: repo.log }; } };
  const tree = () => publicFetch(new Request(origin + '/native/source/tree', { method: 'POST', headers: { Authorization: bearer(secret), 'Content-Type': 'application/json', 'Connect-Protocol-Version': '1' },
    body: JSON.stringify({ repository, repositoryId: '1', commitId: feature }) }), { ...f.env, WORKSPACE_SLUG: 'alice' }, ctx);
  // The first read may already find objects an earlier request in this isolate read; the repeat reads nothing new.
  assert.equal((await tree()).status, 200); const first = reads.length;
  assert.equal((await tree()).status, 200); assert.equal(reads.length, first);
});
