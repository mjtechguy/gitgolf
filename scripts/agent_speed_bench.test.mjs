// Local end-to-end test for scripts/agent_speed_bench.mjs: `node --test scripts/agent_speed_bench.test.mjs`.
// Serves bare repositories through `git http-backend` behind a Node HTTP server with fake
// Access, /rpc and /native/source/commit endpoints. Nothing leaves localhost.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { devNull, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { classifyGit, stats } from './agent_speed_bench.mjs';

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), 'agent_speed_bench.mjs');
const SECRETS = { id: 'access-id-' + randomBytes(4).toString('hex'), secret: 'access-secret-' + randomBytes(8).toString('hex'),
  git: 'golf_git_' + randomBytes(12).toString('hex'), api: 'golf_pat_' + randomBytes(12).toString('hex') };
const gitEnv = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: devNull,
  GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
const git = (dir, ...args) => execFileSync('git', args, { cwd: dir, env: gitEnv, input: '' }).toString().trim();

async function makeRepos(root) {
  for (const name of ['one', 'two']) {
    const dir = join(root, 'alice', name + '.git');
    execFileSync('git', ['init', '-q', '--bare', '--initial-branch=main', dir], { env: gitEnv });
    git(dir, 'config', 'http.receivepack', 'true');
  }
  // "one" has a commit on main; "two" stays empty to exercise root commits.
  const dir = join(root, 'alice/one.git');
  const blob = execFileSync('git', ['hash-object', '-w', '--stdin'], { cwd: dir, env: gitEnv, input: '# one\n' }).toString().trim();
  const tree = execFileSync('git', ['mktree'], { cwd: dir, env: gitEnv, input: `100644 blob ${blob}\tREADME.md\n` }).toString().trim();
  git(dir, 'update-ref', 'refs/heads/main', git(dir, 'commit-tree', tree, '-m', 'init'));
}

function cgi(req, res, root) {
  const url = new URL(req.url, 'http://localhost');
  const env = { ...gitEnv, GIT_PROJECT_ROOT: root, GIT_HTTP_EXPORT_ALL: '1', PATH_INFO: url.pathname.slice(4), QUERY_STRING: url.search.slice(1),
    REQUEST_METHOD: req.method, CONTENT_TYPE: req.headers['content-type'] || '', REMOTE_ADDR: '127.0.0.1' };
  if (req.headers['content-length']) env.CONTENT_LENGTH = req.headers['content-length'];
  if (req.headers['content-encoding']) env.HTTP_CONTENT_ENCODING = req.headers['content-encoding'];
  if (req.headers['git-protocol']) env.HTTP_GIT_PROTOCOL = req.headers['git-protocol'];
  const child = spawn('git', ['http-backend'], { env });
  req.pipe(child.stdin);
  let head = Buffer.alloc(0), sent = false;
  child.stdout.on('data', chunk => {
    if (sent) return void res.write(chunk);
    head = Buffer.concat([head, chunk]);
    const end = head.indexOf('\r\n\r\n');
    if (end < 0) return;
    let status = 200;
    for (const line of head.subarray(0, end).toString().split('\r\n')) {
      const at = line.indexOf(':'), key = line.slice(0, at).trim(), value = line.slice(at + 1).trim();
      if (/^status$/i.test(key)) status = parseInt(value, 10); else res.setHeader(key, value);
    }
    res.writeHead(status); sent = true; res.write(head.subarray(end + 4));
  });
  child.on('close', () => { if (!sent) res.writeHead(500); res.end(); });
}

async function startServer(root) {
  const calls = { rpc: {}, source: 0, unauthorized: 0 }, heads = new Map();
  const basic = 'Basic ' + Buffer.from('golf:' + SECRETS.git).toString('base64'), bearer = 'Bearer ' + SECRETS.api;
  const server = createServer(async (req, res) => {
    res.setHeader('X-Golf-Release', 'test-release');
    res.setHeader('X-Golf-Worker-Release', 'test-worker-release');
    const json = (status, body) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
    if (req.headers['cf-access-client-id'] !== SECRETS.id || req.headers['cf-access-client-secret'] !== SECRETS.secret) { calls.unauthorized++; return json(403, { code: 'permission_denied' }); }
    const auth = req.headers.authorization;
    if (req.url.startsWith('/git/')) {
      if (auth !== basic && auth !== bearer) { calls.unauthorized++; res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="Golf Git"' }); return res.end(); }
      return cgi(req, res, root);
    }
    let body = ''; for await (const chunk of req) body += chunk;
    const input = body ? JSON.parse(body) : {};
    const rpc = /^\/rpc\/golf\.v1\.RepositoryService\/(\w+)$/.exec(req.url);
    if (rpc) {
      if (auth !== bearer) return json(401, { code: 'unauthenticated' });
      calls.rpc[rpc[1]] = (calls.rpc[rpc[1]] || 0) + 1;
      if (req.headers['connect-protocol-version'] !== '1') return json(400, { code: 'invalid_argument' });
      if (rpc[1] === 'GetRepository') return json(200, { repository: { id: '7', name: input.repository.name, defaultBranch: 'main' } });
      return json(200, {});
    }
    if (req.url === '/native/source/commit') {
      if (auth !== bearer) return json(401, { code: 'unauthenticated' });
      // Golf's native routes require the Connect protocol header, as on a real deployment.
      if (req.headers['connect-protocol-version'] !== '1') return json(400, { code: 'invalid_argument', message: 'Use Connect JSON POST.' });
      if (!input.branch) return json(400, { code: 'invalid_argument' });
      calls.source++;
      const current = heads.get(input.branch);
      if (current && current !== input.expectedHead && input.onStale === 'fail') return json(409, { code: 'aborted', currentHead: current });
      const id = randomBytes(20).toString('hex');
      heads.set(input.branch, id);
      return json(200, { commit: { id } });
    }
    json(404, { code: 'not_found' });
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  return { server, calls, origin: `http://127.0.0.1:${server.address().port}` };
}

function bench(args, env) {
  return new Promise(done => {
    const child = spawn(process.execPath, [SCRIPT, ...args], { env: { ...process.env, ...env } });
    let out = '', err = '';
    child.stdout.on('data', d => { out += d; }); child.stderr.on('data', d => { err += d; });
    child.on('close', code => done({ code, out, err }));
  });
}

test('outcome classification and percentiles', () => {
  assert.equal(classifyGit({ code: 0, out: '', err: '' }), 'ok');
  assert.equal(classifyGit({ code: 1, out: '!\tx:refs/heads/b\t[rejected] (fetch first)\n', err: '' }), 'nonff_rejected');
  assert.equal(classifyGit({ code: 128, out: '', err: 'error: RPC failed; HTTP 409 curl 22 The requested URL returned error: 409' }), 'contention_409');
  assert.equal(classifyGit({ code: 128, out: '', err: "fatal: unable to access 'x': The requested URL returned error: 503" }), '503');
  assert.equal(classifyGit({ code: 128, out: '', err: 'The requested URL returned error: 418' }), 'other:418');
  assert.deepEqual(stats([5, 1, 3, 2, 4]), { p50: 3, p95: 5, p99: 5, max: 5 });
});

test('dry run validates the environment without network calls', async () => {
  const bad = await bench(['--dry-run'], { GOLF_BENCH_ORIGIN: '', GOLF_BENCH_REPOS: '' });
  assert.equal(bad.code, 2);
  const env = { GOLF_BENCH_ORIGIN: 'http://127.0.0.1:9', GOLF_BENCH_REPOS: 'alice/one', GOLF_BENCH_GIT_TOKEN: SECRETS.git,
    GOLF_BENCH_ACCESS_ID: SECRETS.id, GOLF_BENCH_ACCESS_SECRET: SECRETS.secret };
  const ok = await bench(['--dry-run', '--scenarios', 'S1,S6', '--concurrency', '1,4'], env);
  assert.equal(ok.code, 0, ok.err);
  assert.match(ok.out, /S6 needs GOLF_BENCH_API_TOKEN/);
  for (const s of Object.values(SECRETS)) assert.ok(!ok.out.includes(s) && !ok.err.includes(s));
});

test('S1-S6 run end to end against git http-backend and fake endpoints', async t => {
  const root = await mkdtemp(join(tmpdir(), 'golf-bench-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await makeRepos(root);
  const { server, calls, origin } = await startServer(root);
  t.after(() => server.close());
  const out = join(root, 'evidence.json');
  const env = { GOLF_BENCH_ORIGIN: origin, GOLF_BENCH_REPOS: 'alice/one,alice/two', GOLF_BENCH_GIT_TOKENS: `alice/two=${SECRETS.git}`,
    GOLF_BENCH_GIT_TOKEN: SECRETS.git, GOLF_BENCH_API_TOKEN: SECRETS.api, GOLF_BENCH_ACCESS_ID: SECRETS.id, GOLF_BENCH_ACCESS_SECRET: SECRETS.secret };
  const r = await bench(['--scenarios', 'S1,S2,S3,S4,S5,S6', '--concurrency', '1,4', '--duration', '2', '--label', 'test', '--out', out], env);
  assert.equal(r.code, 0, r.err + r.out);
  for (const line of r.out.slice(r.out.indexOf('\nscenario  ')).trim().split('\n')) t.diagnostic(line);
  const text = await readFile(out, 'utf8'), evidence = JSON.parse(text);
  for (const s of Object.values(SECRETS)) assert.ok(!text.includes(s) && !r.out.includes(s) && !r.err.includes(s), 'credential leaked');
  assert.equal(evidence.originHost, new URL(origin).host);
  assert.match(evidence.gitVersion, /^git version/);
  assert.equal(evidence.results.length, 14); // S1-S5 x 2, S6 x 2 variants x 2
  for (const res of evidence.results) {
    assert.equal(res.status, 'ok', JSON.stringify(res));
    assert.ok(res.successes > 0, `${res.scenario} ${res.variant || ''} c${res.concurrency} had no successes: ${JSON.stringify(res)}`);
    for (const key of ['attempts', 'successesPerSec', 'latencyMs', 'outcomes', 'ops', 'releases']) assert.ok(key in res, key);
    for (const key of ['ok', 'contention_409', 'nonff_rejected', '413', '429', '503', 'other']) assert.ok(key in res.outcomes, key);
    assert.deepEqual(res.releases, { release: ['test-release'], workerRelease: ['test-worker-release'] });
  }
  const pick = (id, n) => evidence.results.find(x => x.scenario === id && x.concurrency === n);
  assert.ok(pick('S1', 4).ops.fetch.successes > 0);
  assert.match(pick('S3', 4).notes.join(' '), /2 repositories for 4 workers/);
  assert.ok(pick('S4', 4).ops.clone.successes > 0 && pick('S4', 4).ops.ls_remote.successes > 0 && pick('S4', 4).background.successes > 0);
  assert.ok(pick('S5', 1).ops.GetRepositoryComparison.attempts > 0 && pick('S5', 4).background.successes > 0);
  assert.ok(calls.rpc.GetContents > 0 && calls.rpc.ListCommits > 0 && calls.source > 0);
  assert.equal(calls.unauthorized, 0);
  assert.ok(evidence.cleanup.attempted > 0 && evidence.cleanup.failed.length === 0, JSON.stringify(evidence.cleanup));
  for (const repo of ['one', 'two']) assert.equal(git(join(root, 'alice', repo + '.git'), 'for-each-ref', 'refs/heads/bench'), '');
  assert.match(r.out, /scenario\s+conc\s+status/);
});

test('S5 and S6 degrade honestly without a read identity or API token', async t => {
  const root = await mkdtemp(join(tmpdir(), 'golf-bench-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await makeRepos(root);
  const { server, origin } = await startServer(root);
  t.after(() => server.close());
  const out = join(root, 'evidence.json');
  const r = await bench(['--scenarios', 'S5,S6', '--concurrency', '1', '--duration', '1', '--label', 'noapi', '--out', out],
    { GOLF_BENCH_ORIGIN: origin, GOLF_BENCH_REPOS: 'alice/one', GOLF_BENCH_GIT_TOKEN: SECRETS.git, GOLF_BENCH_API_TOKEN: '',
      GOLF_BENCH_ACCESS_ID: SECRETS.id, GOLF_BENCH_ACCESS_SECRET: SECRETS.secret });
  assert.equal(r.code, 0, r.err + r.out);
  const { results } = JSON.parse(await readFile(out, 'utf8'));
  assert.deepEqual(results.map(x => [x.scenario, x.status, x.reason]), [
    ['S5', 'skipped', 'no read identity'], ['S6', 'unavailable', 'GOLF_BENCH_API_TOKEN is not set']]);
});
