// Real workerd, D1 and Durable Objects drive the agent host protocol (docs/AGENT_HOSTS.md) end to end with a small fake host
// in this script: register, heartbeat, assign an issue through /native/agent-tasks, claim, log, a real `git clone` and
// `git push` through the task's Git route, finish, then cancel and the LOST sweep from the scheduled handler. Only the
// Cloudflare Artifacts binding is a fixture (as in actions-runtime-check.mjs): its Git HTTP is `git http-backend` and its
// object reads are `git cat-file` over a local bare repository. No coding CLI runs here; the fake host commits a file.
//
//   node cloudflare/forge/agent-hosts-runtime-check.mjs "$(command -v cf)"
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { realpathSync, mkdtempSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import * as esbuild from '../agents/node_modules/esbuild/lib/main.js';

const cli = dirname(dirname(realpathSync(process.argv[2])));
const { Miniflare, convertV4MiniflareOptions } = await import(pathToFileURL(resolve(cli, 'node_modules/miniflare/dist/src/index.js')).href);
const port = 8797, origin = `http://127.0.0.1:${port}`;
const root = mkdtempSync(join(tmpdir(), 'golf-agent-hosts-proof-')), gitRoot = join(root, 'git');
mkdirSync(gitRoot);
const gitEnv = { PATH: process.env.PATH, HOME: root, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_AUTHOR_NAME: 'Golf agent (claude)', GIT_AUTHOR_EMAIL: 'agent@golf.invalid',
  GIT_COMMITTER_NAME: 'Golf agent (claude)', GIT_COMMITTER_EMAIL: 'agent@golf.invalid', GIT_TERMINAL_PROMPT: '0' };
const git = (dir, args) => execFileSync('git', ['-C', dir, ...args], { env: gitEnv }).toString().trim();
// Asynchronous: the Worker's Artifacts fixture is served from this process while Git talks to the Worker.
const gitAsync = (dir, args) => new Promise(done => {
  const child = spawn('git', ['-C', dir, ...args], { env: gitEnv });
  let stderr = ''; child.stderr.on('data', d => { stderr += d; }); child.on('close', status => done({ status, stderr }));
});

const fixture = `
import * as real from './src/worker.mjs';
import { remote } from './src/git.mjs';
const call = async (path, query) => { const r = await fetch('https://fixture.invalid/' + path + '?' + new URLSearchParams(query)); if (r.status === 404) return null; if (!r.ok) throw Error('fixture ' + r.status); return r; };
const artifacts = env => ({ async get(name) { return {
  async info() { return { name, remote: remote(env, name) }; },
  async createToken() { return { plaintext: 'local-fixture-token' }; }, async revokeToken() { return true; },
  async readCommit(hash) { const r = await call('commit', { repo: name, hash }); return r && r.json(); },
  async log(options) { const r = await call('log', { repo: name, ref: options.ref, limit: options.limit ?? 50 }); return r ? r.json() : []; },
  [Symbol.dispose]() {} }; } });
const fix = env => ({ ...env, ARTIFACTS: artifacts(env) });
export class Workspace extends real.Workspace { constructor(ctx, env) { super(ctx, fix(env)); } }
export class RepositoryReads extends real.RepositoryReads { constructor(ctx, env) { super(ctx, fix(env)); } }
export class PipelineRun extends real.PipelineRun { constructor(ctx, env) { super(ctx, fix(env)); } }
export default { fetch: (request, env, ctx) => real.default.fetch(request, fix(env), ctx), scheduled: (event, env, ctx) => real.default.scheduled(event, fix(env), ctx) };
`;
const bundle = await esbuild.build({ stdin: { contents: fixture, resolveDir: resolve('cloudflare/forge'), sourcefile: 'agent-hosts-proof-entry.mjs' }, bundle: true, write: false, format: 'esm', platform: 'neutral',
  conditions: ['workerd', 'worker', 'browser'], external: ['cloudflare:workers', 'node:*'], loader: { '.json': 'json' } });

function cgi(request, body) {
  const url = new URL(request.url), path = url.pathname.replace(/^\/git\/[^/]+/, '');
  const result = spawnSync('git', ['http-backend'], { input: body, maxBuffer: 64 * 1024 * 1024, env: { ...gitEnv, GIT_PROJECT_ROOT: gitRoot, GIT_HTTP_EXPORT_ALL: '1', PATH_INFO: path, REQUEST_METHOD: request.method,
    QUERY_STRING: url.search.slice(1), CONTENT_TYPE: request.headers.get('Content-Type') || '', CONTENT_LENGTH: String(body?.length || 0), GIT_PROTOCOL: request.headers.get('Git-Protocol') || '', REMOTE_USER: 'golf', REMOTE_ADDR: '127.0.0.1' } });
  const output = result.stdout, split = output.indexOf('\r\n\r\n'), headers = new Headers(); let status = 200;
  for (const line of output.subarray(0, split).toString().split('\r\n')) { const at = line.indexOf(':'), k = line.slice(0, at), v = line.slice(at + 1).trim(); if (/^status$/i.test(k)) status = Number(v.split(' ')[0]); else headers.set(k, v); }
  return new Response(output.subarray(split + 4), { status, headers });
}
function parseCommit(hash, body) {
  const split = body.indexOf('\n\n'), headers = body.slice(0, split).split('\n'), author = /^author (.*) <(.*)> (\d+) [+-]\d{4}$/.exec(headers.find(line => line.startsWith('author ')) || '');
  return { hash, treeHash: headers[0].slice(5), parents: headers.filter(line => line.startsWith('parent ')).map(line => line.slice(7)), message: body.slice(split + 2),
    author: { name: author?.[1] || '', email: author?.[2] || '' }, authoredAt: Number(author?.[3] || 0) };
}
async function outbound(request) {
  const url = new URL(request.url);
  if (url.hostname === 'fixture.invalid') {
    const repo = join(gitRoot, url.searchParams.get('repo') + '.git'), kind = url.pathname.slice(1);
    if (!/^[a-z0-9-]+$/.test(url.searchParams.get('repo') || '') || !existsSync(repo)) return new Response('missing', { status: 404 });
    if (kind === 'commit') { const r = spawnSync('git', ['--git-dir', repo, 'cat-file', 'commit', url.searchParams.get('hash')], { env: gitEnv }); return r.status ? new Response('', { status: 404 }) : Response.json(parseCommit(url.searchParams.get('hash'), r.stdout.toString())); }
    if (kind === 'log') {
      const r = spawnSync('git', ['--git-dir', repo, 'rev-list', '--max-count=' + url.searchParams.get('limit'), url.searchParams.get('ref')], { env: gitEnv });
      return Response.json(r.status ? [] : r.stdout.toString().split('\n').filter(Boolean).map(h => parseCommit(h, spawnSync('git', ['--git-dir', repo, 'cat-file', 'commit', h], { env: gitEnv }).stdout.toString())));
    }
  }
  if (url.hostname.endsWith('.artifacts.cloudflare.net')) return cgi(request, request.body ? Buffer.from(await request.arrayBuffer()) : null);
  return new Response('No outbound network in this check', { status: 502 });
}

const runtime = new Miniflare(convertV4MiniflareOptions({
  host: '127.0.0.1', port, modules: true, script: bundle.outputFiles[0].text, compatibilityDate: '2026-10-08', compatibilityFlags: ['nodejs_compat'], outboundService: outbound,
  bindings: { PUBLIC_ORIGIN: origin, WORKSPACE_SLUG: 'alice', ACCOUNT_ID: 'a'.repeat(32), ARTIFACTS_NAMESPACE: 'agent-proof', OPERATIONS_SERVICE_HEALTH: 'false' },
  d1Databases: { DB: 'agent-proof' },
  durableObjects: { WORKSPACE: { className: 'Workspace', useSQLite: true }, READS: { className: 'RepositoryReads', useSQLite: true }, RUNS: { className: 'PipelineRun', useSQLite: true } },
}));
const receipt = { origin, startedAt: new Date().toISOString() };
try {
  await runtime.ready;
  const db = await runtime.getD1Database('DB');
  for (const statement of (await readFile(new URL('./schema.sql', import.meta.url), 'utf8')).replace(/--[^\n]*/g, '').split(/;\s*(?=CREATE\b)/).filter(s => s.trim())) await db.prepare(statement).run();
  await db.prepare("INSERT INTO users(id,login,email,full_name,can_create) VALUES(1,'alice','alice@example.com','Alice',1),(2,'bob','bob@example.com','Bob',0)").run();
  await db.prepare('INSERT INTO operations_admins(user_id) VALUES(1)').run();
  await db.prepare("INSERT INTO workspaces(slug,artifact_namespace) VALUES('alice','agent-proof')").run();
  // One repository with a real history; issue #1 with a comment, as the forge stores them.
  const artifact = 'repo-' + createHash('sha256').update('agent-demo').digest('hex').slice(0, 32), bare = join(gitRoot, artifact + '.git'), seed = join(root, 'seed');
  mkdirSync(seed); git(seed, ['init', '-q', '-b', 'main']); writeFileSync(join(seed, 'parse.js'), 'export const parse = text => JSON.parse(text);\n'); git(seed, ['add', '.']); git(seed, ['commit', '-q', '-m', 'Parser']);
  execFileSync('git', ['clone', '-q', '--bare', seed, bare], { env: gitEnv }); git(bare, ['config', 'http.receivepack', 'true']);
  const base = git(bare, ['rev-parse', 'refs/heads/main']);
  await db.prepare("INSERT INTO repositories(id,name,description,artifact_name,creator_id,creation_key,input_hash,state,created_at,default_branch) VALUES(1,'agent-demo','',?,1,'k','h','ACTIVE',?,'main')").bind(artifact, new Date().toISOString()).run();
  await db.prepare("INSERT INTO grants(repository_id,user_id,role) VALUES(1,1,'admin'),(1,2,'read')").run();
  await db.prepare("INSERT INTO discussions(id,repository_id,number,kind,author_id,title,body,state,created_at,updated_at) VALUES(1,1,1,'issue',1,'Empty input crashes parse','parse(\"\") throws.','OPEN',?,?),(2,1,2,'issue',1,'Second','','OPEN',?,?),(3,1,3,'issue',1,'Third','','OPEN',?,?)")
    .bind(...Array(6).fill(new Date().toISOString())).run();
  await db.prepare("INSERT INTO discussion_comments(discussion_id,author_id,body,created_at,updated_at) VALUES(1,1,'Return null instead.',?,?)").bind(new Date().toISOString(), new Date().toISOString()).run();

  // The person, through the workspace object as the public Worker forwards a verified Access identity.
  const workspace = await runtime.getDurableObjectNamespace('WORKSPACE'), owner = workspace.get(workspace.idFromName('alice'));
  const person = async (path, body, status = 200) => {
    const response = await owner.fetch(new Request(origin + path, { method: 'POST', headers: { 'X-Golf-Native-Access-Email': 'alice@example.com', 'Content-Type': 'application/json', 'Connect-Protocol-Version': '1' }, body: JSON.stringify(body) }));
    const text = await response.text(); assert.equal(response.status, status, path + ' ' + text); return JSON.parse(text);
  };
  const tasks = (body, status) => person('/native/agent-tasks', { repository: { owner: 'alice', name: 'agent-demo' }, repositoryId: '1', ...body }, status);
  // The fake host: plain HTTP to the public Worker's port, outside Access like the real binary.
  const host = async (path, body, credential, status = 200) => {
    const response = await fetch(origin + '/native/agent-host/' + path, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(credential ? { Authorization: 'Bearer ' + credential } : {}) }, body: JSON.stringify(body) });
    const text = await response.text(); assert.equal(response.status, status, path + ' ' + text); return JSON.parse(text);
  };

  const capability = (await person('/rpc/golf.v1.CapabilityService/ListCapabilities', {})).capabilities.find(c => c.id === 'agents.hosts');
  assert.equal(capability.state, 'CAPABILITY_STATE_READY');
  assert.equal((await person('/native/diagnostics', {})).schema, 36);
  const created = await person('/native/agent-hosts', { action: 'createToken', scope: 'personal', ttlHours: 1, uses: 1 });
  const registered = await host('register', { registrationToken: created.token, name: 'proof-box', hostVersion: '0.1.0', os: 'linux', arch: 'amd64' });
  await host('register', { registrationToken: created.token, name: 'again' }, undefined, 401);
  const credential = registered.credential, tools = [{ tool: 'claude', version: '2.1.0', signedIn: true }, { tool: 'codex', version: '0.50.0', signedIn: null }];
  assert.deepEqual(await host('heartbeat', { tools }, credential), { ok: true, cancel: [], state: 'ACTIVE' });
  const listed = await person('/native/agent-hosts', { action: 'list', scope: 'personal' });
  assert.deepEqual(listed.hosts.map(h => [h.name, h.online, h.tools.map(t => t.tool)]), [['proof-box', true, ['claude', 'codex']]]);

  // ---------- assign issue #1, claim, log, clone, commit, push, finish ----------
  const task = (await tasks({ action: 'create', target: { kind: 'issue', number: 1 }, hostId: registered.hostId, tool: 'claude', instructions: 'Keep the signature.', idempotencyKey: crypto.randomUUID() })).task;
  assert.deepEqual([task.state, task.baseCommit, task.target.title], ['QUEUED', base, 'Empty input crashes parse']);
  const claimed = (await host('claim', { claimId: crypto.randomUUID() }, credential)).task;
  assert.equal(claimed.id, task.id); assert.match(claimed.prompt, /Issue #1: Empty input crashes parse[\s\S]*Return null instead[\s\S]*Keep the signature/);
  const auth = token => ['-c', 'http.extraHeader=Authorization: Basic ' + Buffer.from('golf:' + token).toString('base64')];
  assert.deepEqual(await host(`tasks/${task.id}/start`, {}, claimed.token), { ok: true, cancel: false });
  assert.deepEqual(await host(`tasks/${task.id}/log`, { offset: 0, lines: ['$ claude -p …', 'Reading parse.js'] }, claimed.token), { nextOffset: 2, cancel: false });
  const work = join(root, 'work');
  const clone = await gitAsync(root, [...auth(claimed.token), 'clone', '-q', claimed.cloneUrl, work]);
  assert.equal(clone.status, 0, clone.stderr);
  git(work, ['checkout', '-q', '-b', claimed.branch, claimed.baseCommit]);
  writeFileSync(join(work, 'parse.js'), 'export const parse = text => text === "" ? null : JSON.parse(text);\n');
  git(work, ['commit', '-q', '-am', `Handle empty input (issue #1)\n\nGolf-Agent-Task: ${task.id}`]);
  const commit = git(work, ['rev-parse', 'HEAD']);
  const other = await gitAsync(work, [...auth(claimed.token), 'push', claimed.cloneUrl, 'HEAD:refs/heads/main']);
  assert.notEqual(other.status, 0, 'a push to another ref must be refused');
  assert.equal(git(bare, ['rev-parse', 'refs/heads/main']), base);
  const pushed = await gitAsync(work, [...auth(claimed.token), 'push', claimed.cloneUrl, `HEAD:refs/heads/${claimed.branch}`]);
  assert.equal(pushed.status, 0, pushed.stderr);
  assert.equal(git(bare, ['rev-parse', 'refs/heads/' + claimed.branch]), commit);
  await host(`tasks/${task.id}/log`, { offset: 2, lines: ['Committed and pushed ' + commit.slice(0, 12)] }, claimed.token);
  assert.deepEqual(await host(`tasks/${task.id}/finish`, { state: 'succeeded', exitCode: 0, commitId: commit, summary: 'parse("") returns null.', changedFiles: ['parse.js'], usage: { inputTokens: 900, outputTokens: 120 } }, claimed.token), { ok: true, state: 'SUCCEEDED' });
  const done = (await tasks({ action: 'get', id: task.id })).task;
  assert.deepEqual([done.state, done.commitId, done.changedFiles, done.logLines], ['SUCCEEDED', commit, ['parse.js'], 3]);
  assert.deepEqual((await tasks({ action: 'log', id: task.id, offset: 0 })).lines, ['$ claude -p …', 'Reading parse.js', 'Committed and pushed ' + commit.slice(0, 12)]);
  const operation = await db.prepare('SELECT ref,new_sha,state FROM git_operations').first();
  assert.deepEqual({ ...operation }, { ref: 'refs/heads/' + claimed.branch, new_sha: commit, state: 'APPLIED' });
  const after = await gitAsync(work, [...auth(claimed.token), 'ls-remote', claimed.cloneUrl]);
  assert.notEqual(after.status, 0, 'a finished task’s token reads nothing');
  receipt.proposal = { task: task.id, branch: claimed.branch, commit, base, otherRefRefused: other.stderr.trim().split('\n').slice(-2) };

  // ---------- cancel: the person cancels a running task; heartbeat says so, Git refuses, the host finishes cancelled ----------
  const second = (await tasks({ action: 'create', target: { kind: 'issue', number: 2 }, hostId: registered.hostId, tool: 'codex', idempotencyKey: crypto.randomUUID() })).task;
  const claimedSecond = (await host('claim', { claimId: crypto.randomUUID() }, credential)).task;
  await host(`tasks/${second.id}/start`, {}, claimedSecond.token);
  assert.equal((await tasks({ action: 'cancel', id: second.id })).task.cancelRequested, true);
  assert.deepEqual((await host('heartbeat', { tools }, credential)).cancel, [second.id]);
  const refused = await gitAsync(root, [...auth(claimedSecond.token), 'clone', '-q', claimedSecond.cloneUrl, join(root, 'cancelled')]);
  assert.notEqual(refused.status, 0);
  assert.deepEqual(await host(`tasks/${second.id}/finish`, { state: 'cancelled' }, claimedSecond.token), { ok: true, state: 'CANCELLED' });

  // ---------- LOST: a claimed task whose host stops calling in, swept by the scheduled maintenance ----------
  const third = (await tasks({ action: 'create', target: { kind: 'issue', number: 3 }, hostId: registered.hostId, tool: 'claude', idempotencyKey: crypto.randomUUID() })).task;
  assert.equal((await host('claim', { claimId: crypto.randomUUID() }, credential)).task.id, third.id);
  await db.prepare('UPDATE agent_hosts SET last_seen_at=? WHERE id=?').bind(new Date(Date.now() - 4 * 60_000).toISOString(), Number(registered.hostId)).run();
  const scheduled = await (await runtime.getWorker()).scheduled({ cron: '*/5 * * * *', scheduledTime: Date.now() });
  const lost = (await tasks({ action: 'get', id: third.id })).task;
  assert.deepEqual([lost.state, lost.failureReason], ['LOST', 'lost']);
  receipt.scheduled = scheduled.outcome;
  receipt.states = (await db.prepare('SELECT target_number,state,failure_reason FROM agent_tasks ORDER BY target_number').all()).results;
  receipt.finishedAt = new Date().toISOString();
  writeFileSync(join(root, 'receipt.json'), JSON.stringify(receipt, null, 2));
  console.log(JSON.stringify(receipt, null, 2));
  console.log('Agent hosts on real workerd/D1/DO: registration, heartbeat, assignment, claim, live log, real git clone and push through the task route, verified finish, other-ref refusal, cancel and the LOST sweep passed');
} finally { await runtime.dispose(); }
