// Real workerd/D1/R2/Durable Objects + the pinned stock Forgejo Runner + Docker, running real workflows end to end.
// Only the Cloudflare Artifacts binding is a fixture: its Git HTTP is served by `git http-backend` and its object reads by
// `git cat-file` over local bare repositories (Artifacts has no local simulator). Nothing else is mocked.
//
//   node cloudflare/forge/actions-runtime-check.mjs "$(which cf)" [--repos=demo,chalk,node-postgres,itsdangerous] [--source=/tmp/golf-real] [--keep]
//
// Upstream repositories are imported unchanged (full history); the proof pushes their real HEAD through Golf's
// Smart HTTP push, which triggers the push workflows exactly as on the hosted installation.
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { realpathSync, mkdtempSync, existsSync, writeFileSync, readFileSync, mkdirSync, chmodSync, cpSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { tmpdir, networkInterfaces } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import * as esbuild from '../agents/node_modules/esbuild/lib/main.js';
import { sealingKey, seal } from './src/sealed.mjs';
import { forgejoRunnerVersion, forgejoRunnerSha256 } from './src/pipeline-policy.mjs';

const args = Object.fromEntries(process.argv.slice(3).map(arg => arg.replace(/^--/, '').split('=')).map(([k, v]) => [k, v ?? true]));
const cli = dirname(dirname(realpathSync(process.argv[2])));
const { Miniflare, convertV4MiniflareOptions } = await import(pathToFileURL(resolve(cli, 'node_modules/miniflare/dist/src/index.js')).href);
const wanted = String(args.repos || 'demo,chalk,node-postgres,itsdangerous').split(',');
const source = String(args.source || '/tmp/golf-real');
const image = String(args.image || 'ghcr.io/catthehacker/ubuntu:act-24.04');
const host = String(args.host || Object.values(networkInterfaces()).flat().find(a => a.family === 'IPv4' && !a.internal && !/^(172\.|192\.168\.122\.|100\.)/.test(a.address))?.address);
const port = Number(args.port || 8799), origin = `http://${host}:${port}`;
const root = mkdtempSync(join(tmpdir(), 'golf-actions-proof-')), gitRoot = join(root, 'git');
mkdirSync(gitRoot);
console.log('proof root', root, 'origin', origin);
const gitEnv = { PATH: process.env.PATH, HOME: root, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_AUTHOR_NAME: 'Golf Proof', GIT_AUTHOR_EMAIL: 'proof@example.invalid', GIT_COMMITTER_NAME: 'Golf Proof', GIT_COMMITTER_EMAIL: 'proof@example.invalid', GIT_TERMINAL_PROMPT: '0' };
const git = (dir, gitArgs, options = {}) => execFileSync('git', ['-C', dir, ...gitArgs], { env: gitEnv, maxBuffer: 256 * 1024 * 1024, ...options });

// ---------- the Worker under test, with only ARTIFACTS replaced ----------
const fixture = `
import * as real from './src/worker.mjs';
import { remote } from './src/git.mjs';
const call = async (path, query) => { const r = await fetch('https://fixture.invalid/' + path + '?' + new URLSearchParams(query)); if (r.status === 404) return null; if (!r.ok) throw Error('fixture ' + r.status); return r; };
const artifacts = env => ({ async get(name) { return {
  async info() { return { name, remote: remote(env, name) }; },
  async createToken() { return { plaintext: 'local-fixture-token' }; }, async revokeToken() { return true; },
  async readCommit(hash) { const r = await call('commit', { repo: name, hash }); return r && r.json(); },
  async readTree(hash) { const r = await call('tree', { repo: name, hash }); return r && r.json(); },
  async readBlob(hash) { const r = await call('blob', { repo: name, hash }); return r && new Blob([await r.arrayBuffer()]); },
  async log(options) { const r = await call('log', { repo: name, ref: options.ref, limit: options.limit ?? 50, offset: options.offset ?? 0 }); return r ? r.json() : []; },
  [Symbol.dispose]() {} }; } });
const fix = env => ({ ...env, ARTIFACTS: artifacts(env) });
export class Workspace extends real.Workspace { constructor(ctx, env) { super(ctx, fix(env)); } }
export class RepositoryReads extends real.RepositoryReads { constructor(ctx, env) { super(ctx, fix(env)); } }
export class PipelineRun extends real.PipelineRun { constructor(ctx, env) { super(ctx, fix(env)); } }
export default { fetch: (request, env, ctx) => real.default.fetch(request, fix(env), ctx), scheduled: (event, env, ctx) => real.default.scheduled(event, fix(env), ctx), queue: (batch, env, ctx) => real.default.queue(batch, fix(env), ctx) };
`;
const bundle = await esbuild.build({ stdin: { contents: fixture, resolveDir: resolve('cloudflare/forge'), sourcefile: 'actions-proof-entry.mjs' }, bundle: true, write: false, format: 'esm', platform: 'neutral',
  conditions: ['workerd', 'worker', 'browser'], external: ['cloudflare:workers', 'node:*'], loader: { '.json': 'json' } });

function cgi(repoPath, request, body) {
  const url = new URL(request.url), path = url.pathname.replace(/^\/git\/[^/]+/, '');
  const result = spawnSync('git', ['http-backend'], { input: body, maxBuffer: 512 * 1024 * 1024, env: { ...gitEnv, GIT_PROJECT_ROOT: gitRoot, GIT_HTTP_EXPORT_ALL: '1', PATH_INFO: path, REQUEST_METHOD: request.method,
    QUERY_STRING: url.search.slice(1), CONTENT_TYPE: request.headers.get('Content-Type') || '', CONTENT_LENGTH: String(body?.length || 0), GIT_PROTOCOL: request.headers.get('Git-Protocol') || '', REMOTE_USER: 'golf', REMOTE_ADDR: '127.0.0.1' } });
  const output = result.stdout, split = output.indexOf('\r\n\r\n');
  const headers = new Headers(); let status = 200;
  for (const line of output.subarray(0, split).toString().split('\r\n')) { const at = line.indexOf(':'); const k = line.slice(0, at), v = line.slice(at + 1).trim(); if (/^status$/i.test(k)) status = Number(v.split(' ')[0]); else headers.set(k, v); }
  return new Response(output.subarray(split + 4), { status, headers });
}
const modeType = mode => mode === '040000' ? 'tree' : mode === '100755' ? 'exec' : mode === '120000' ? 'symlink' : mode === '160000' ? 'gitlink' : 'blob';
function parseCommit(hash, body) {
  const split = body.indexOf('\n\n'), headers = body.slice(0, split).split('\n'), author = /^author (.*) <(.*)> (\d+) [+-]\d{4}$/.exec(headers.find(line => line.startsWith('author ')) || '');
  const committer = /^committer (.*) <(.*)> (\d+) [+-]\d{4}$/.exec(headers.find(line => line.startsWith('committer ')) || '');
  return { hash, treeHash: headers[0].slice(5), parents: headers.filter(line => line.startsWith('parent ')).map(line => line.slice(7)), message: body.slice(split + 2),
    author: { name: author?.[1] || '', email: author?.[2] || '' }, authoredAt: Number(author?.[3] || 0), committer: { name: committer?.[1] || '', email: committer?.[2] || '' }, committedAt: Number(committer?.[3] || 0) };
}
async function outbound(request) {
  const url = new URL(request.url);
  if (url.hostname === 'fixture.invalid') {
    const repo = join(gitRoot, url.searchParams.get('repo') + '.git'), hash = url.searchParams.get('hash'), kind = url.pathname.slice(1);
    if (!/^[a-z0-9-]+$/.test(url.searchParams.get('repo') || '') || !existsSync(repo)) return new Response('missing', { status: 404 });
    if (kind === 'commit') { const r = spawnSync('git', ['--git-dir', repo, 'cat-file', 'commit', hash], { env: gitEnv }); return r.status ? new Response('', { status: 404 }) : Response.json(parseCommit(hash, r.stdout.toString())); }
    if (kind === 'tree') {
      const r = spawnSync('git', ['--git-dir', repo, 'ls-tree', '-z', hash], { env: gitEnv, maxBuffer: 64 * 1024 * 1024 });
      if (r.status) return new Response('', { status: 404 });
      return Response.json(r.stdout.toString().split('\0').filter(Boolean).map(line => { const [meta, name] = line.split('\t'); const [mode, , object] = meta.split(' '); return { name, hash: object, type: modeType(mode), mode }; }));
    }
    if (kind === 'blob') { const r = spawnSync('git', ['--git-dir', repo, 'cat-file', 'blob', hash], { env: gitEnv, maxBuffer: 256 * 1024 * 1024 }); return r.status ? new Response('', { status: 404 }) : new Response(r.stdout); }
    if (kind === 'log') {
      const r = spawnSync('git', ['--git-dir', repo, 'rev-list', '--max-count=' + url.searchParams.get('limit'), '--skip=' + url.searchParams.get('offset'), url.searchParams.get('ref')], { env: gitEnv });
      if (r.status) return Response.json([]);
      return Response.json(r.stdout.toString().split('\n').filter(Boolean).map(h => parseCommit(h, spawnSync('git', ['--git-dir', repo, 'cat-file', 'commit', h], { env: gitEnv }).stdout.toString())));
    }
  }
  if (url.hostname.endsWith('.artifacts.cloudflare.net')) return cgi(null, request, request.body ? Buffer.from(await request.arrayBuffer()) : null);
  return fetch(request);
}

const runtime = new Miniflare(convertV4MiniflareOptions({
  host: '0.0.0.0', port, modules: true, script: bundle.outputFiles[0].text, compatibilityDate: '2026-10-08', compatibilityFlags: ['nodejs_compat'],
  secretsStoreSecrets: { EXECUTION_VALUE_KEY: { store_id: 'local-proof', secret_name: 'execution-value-key' } },
  outboundService: outbound,
  bindings: { PUBLIC_ORIGIN: origin, WORKSPACE_SLUG: 'alice', ACCOUNT_ID: 'a'.repeat(32), ARTIFACTS_NAMESPACE: 'actions-proof', PIPELINES_ENABLED: 'true', OPERATIONS_SERVICE_HEALTH: 'false' },
  d1Databases: { DB: 'actions-proof' }, r2Buckets: { PIPELINE_BUCKET: 'actions-proof-pipelines' },
  durableObjects: { WORKSPACE: { className: 'Workspace', useSQLite: true }, READS: { className: 'RepositoryReads', useSQLite: true }, RUNS: { className: 'PipelineRun', useSQLite: true } },
}));
const children = [];
const receipt = { runner: { version: forgejoRunnerVersion, sha256: forgejoRunnerSha256 }, image, origin, startedAt: new Date().toISOString(), repositories: {} };
try {
  await runtime.ready;
  const db = await runtime.getD1Database('DB');
  for (const statement of (await readFile(new URL('./schema.sql', import.meta.url), 'utf8')).replace(/--[^\n]*/g, '').split(/;\s*(?=CREATE\b)/).filter(s => s.trim())) await db.prepare(statement).run();
  await db.prepare("INSERT INTO users(id,login,email,full_name,can_create) VALUES(1,'alice','alice@example.com','Alice',1),(2,'reviewer','reviewer@example.com','Reviewer',0)").run();
  await db.prepare('INSERT INTO operations_admins(user_id) VALUES(1)').run();
  await db.prepare("INSERT INTO workspaces(slug,artifact_namespace) VALUES('alice','actions-proof')").run();
  const keyText = randomBytes(32).toString('base64');
  await (await runtime.getSecretsStoreSecretAPI('EXECUTION_VALUE_KEY'))().create(keyText);
  const human = { 'X-Golf-Native-Access-Email': 'alice@example.com', 'Content-Type': 'application/json', 'Connect-Protocol-Version': '1' };
  // Without an Access audience the public Worker drops identity headers; the human Access identity reaches the workspace
  // object the way the public Worker forwards it after verification (as the other runtime checks do).
  const workspace = await runtime.getDurableObjectNamespace('WORKSPACE'), owner = workspace.get(workspace.idFromName('alice'));
  const viaAccess = (path, body, headers = human) => owner.fetch(new Request(origin + path, { method: 'POST', headers, body: JSON.stringify(body) }));
  const token = 'golf_native_' + randomBytes(32).toString('base64url').slice(0, 43);
  await db.prepare('INSERT INTO credentials VALUES(?,?,?,0)').bind(createHash('sha256').update(token).digest('hex'), 1, Math.floor(Date.now() / 1000) + 86400).run();
  const api = async (path, body, expect = 200) => {
    const response = await viaAccess(path, body);
    const text = await response.text();
    assert.equal(response.status, expect, path + ' ' + text);
    return JSON.parse(text);
  };

  // ---------- repositories ----------
  const repos = [];
  let id = 0;
  for (const name of wanted) {
    id++;
    const artifact = 'repo-' + createHash('sha256').update(name).digest('hex').slice(0, 32), bare = join(gitRoot, artifact + '.git');
    let work;
    if (name === 'demo') {
      work = join(root, 'demo'); cpSync(new URL('./actions-demo/', import.meta.url).pathname, work, { recursive: true });
      git(work, ['init', '-q', '-b', 'main']); git(work, ['add', '.']); git(work, ['commit', '-q', '-m', 'Actions demo']);
      git(work, ['commit', '-q', '--allow-empty', '-m', 'Trigger the demo workflows']);
    } else work = join(source, name);
    const branch = git(work, ['rev-parse', '--abbrev-ref', 'HEAD']).toString().trim(), head = git(work, ['rev-parse', 'HEAD']).toString().trim();
    execFileSync('git', ['clone', '-q', '--bare', work, bare], { env: gitEnv });
    git(bare, ['config', 'http.receivepack', 'true']);
    git(bare, ['config', 'uploadpack.allowAnySHA1InWant', 'true']);
    // Golf receives the real HEAD by Smart HTTP push; the bare repository starts one commit earlier.
    git(bare, ['update-ref', 'refs/heads/' + branch, head + '~1']);
    git(bare, ['symbolic-ref', 'HEAD', 'refs/heads/' + branch]);
    for (const ref of git(bare, ['for-each-ref', '--format=%(refname)']).toString().split('\n').filter(r => r && r !== 'refs/heads/' + branch)) git(bare, ['update-ref', '-d', ref]);
    await db.prepare("INSERT INTO repositories(id,name,description,artifact_name,creator_id,creation_key,input_hash,state,created_at,default_branch) VALUES(?,?,'',?,1,?,?,'ACTIVE',?,?)").bind(id, name, artifact, 'k' + id, 'h' + id, new Date().toISOString(), branch).run();
    await db.prepare("INSERT INTO grants(repository_id,user_id,role) VALUES(?,1,'admin'),(?,2,'read')").bind(id, id).run();
    repos.push({ id, name, artifact, work, branch, head });
  }

  // Repository values for the demo: a secret (released only to same-repository runs, redacted in stored logs) and a variable.
  const { key, id: keyId } = await sealingKey({ get: async () => keyText }, 'Repository value');
  const demo = repos.find(repo => repo.name === 'demo');
  const secretValue = 'golf-proof-' + randomBytes(5).toString('hex');
  if (demo) for (const [name, kind, value] of [['DEMO_SECRET', 'secret', secretValue], ['GREETING', 'variable', 'hello from golf vars']]) {
    const valueId = crypto.randomUUID(), bytes = Buffer.byteLength(value), time = new Date().toISOString();
    await db.prepare("INSERT INTO execution_values(id,repository_id,artifact_name,name,kind,version,deleted,value_bytes,created_at,updated_at) VALUES(?,?,?,?,?,1,0,?,?,?)").bind(valueId, demo.id, demo.artifact, name, kind, bytes, time, time).run();
    const encrypted = await seal(key, ['golf.native.execution-value.v1', origin, demo.id, demo.artifact, valueId, 1, name, kind, bytes], value);
    await db.prepare('INSERT INTO execution_value_versions(id,version,value_bytes,encrypted,key_id,created_at) VALUES(?,1,?,?,?,?)').bind(valueId, bytes, encrypted, keyId, time).run();
  }
  // A protected deployment environment: the demo deploy job waits for the reviewer.
  if (demo) await db.prepare("INSERT INTO pipeline_environments(repository_id,artifact_name,name,reviewers,prevent_self_review,branches,url,created_by,created_at,updated_at) VALUES(?,?,'production','[2]',1,'[\"main\"]','https://demo.example.invalid',1,?,?)").bind(demo.id, demo.artifact, new Date().toISOString(), new Date().toISOString()).run();

  // ---------- the pinned stock runner ----------
  const runnerDir = join(root, 'runner'); mkdirSync(runnerDir);
  const binary = join(runnerDir, 'forgejo-runner');
  const download = await fetch(`https://code.forgejo.org/forgejo/runner/releases/download/${forgejoRunnerVersion}/forgejo-runner-${forgejoRunnerVersion.slice(1)}-linux-amd64`);
  assert.equal(download.status, 200);
  const bytes = Buffer.from(await download.arrayBuffer());
  assert.equal(createHash('sha256').update(bytes).digest('hex'), forgejoRunnerSha256, 'pinned runner checksum');
  writeFileSync(binary, bytes); chmodSync(binary, 0o755);
  console.log('Verified', forgejoRunnerVersion, 'sha256', forgejoRunnerSha256);
  const registration = await api('/native/pipeline-runners', { scope: 'installation', action: 'createToken', engine: 'forgejo-actions', labels: [`ubuntu-latest:docker://${image}`], ttlHours: 1, uses: 1 });
  assert.match(registration.token, /^golfreg_[a-f0-9]{64}$/);
  assert.ok(registration.commands.some(command => command.startsWith('forgejo-runner register --no-interactive --instance ' + origin)));
  const runnerEnv = { ...process.env, HOME: runnerDir, DOCKER_HOST: process.env.DOCKER_HOST || `unix:///run/user/${process.getuid()}/docker.sock` };
  execFileSync(binary, ['register', '--no-interactive', '--instance', origin, '--token', registration.token, '--name', 'golf-proof', '--labels', `ubuntu-latest:docker://${image}`], { cwd: runnerDir, env: runnerEnv, stdio: 'inherit' });
  const config = execFileSync(binary, ['generate-config'], { env: runnerEnv }).toString()
    .replace(/capacity: \d+/, 'capacity: 1').replace(/fetch_interval: \S+/, 'fetch_interval: 2s').replace(/timeout: 3h/, 'timeout: 1h');
  writeFileSync(join(runnerDir, 'config.yml'), config);
  const daemon = spawn(binary, ['daemon', '--config', 'config.yml'], { cwd: runnerDir, env: runnerEnv, stdio: ['ignore', 'pipe', 'pipe'] });
  children.push(daemon);
  const runnerLog = [], runnerFile = join(root, 'runner.log'); const record = d => { runnerLog.push(d.toString()); writeFileSync(runnerFile, d.toString(), { flag: 'a' }); }; daemon.stdout.on('data', record); daemon.stderr.on('data', record);
  writeFileSync(join(root, 'runner.pid'), String(daemon.pid));

  // ---------- trigger: the real HEAD pushed through Golf's Smart HTTP push ----------
  for (const repo of repos) {
    // Asynchronous: the Worker's Artifacts fixture is served from this Node process while Git talks to the Worker.
    const push = await new Promise(done => {
      const child = spawn('git', ['-C', repo.work, '-c', 'http.extraHeader=Authorization: Bearer ' + token, 'push', `${origin}/git/alice/${repo.name}.git`, `${repo.head}:refs/heads/${repo.branch}`], { env: gitEnv });
      let stderr = ''; child.stderr.on('data', d => { stderr += d; }); child.on('close', status => done({ status, stderr }));
    });
    assert.equal(push.status, 0, push.stderr);
    console.log('pushed', repo.name, repo.head.slice(0, 12), 'to', repo.branch);
  }

  // ---------- wait and observe ----------
  const deadline = Date.now() + Number(args.minutes || 150) * 60_000;
  let approved = false;
  for (;;) {
    const { results: runs } = await db.prepare('SELECT * FROM pipeline_runs ORDER BY id').all();
    const { results: jobs } = await db.prepare('SELECT j.*,r.repository_id FROM pipeline_jobs j JOIN pipeline_runs r ON r.id=j.run_id AND r.attempt=j.attempt ORDER BY j.id').all();
    const waitingApproval = jobs.find(job => job.state === 'APPROVAL');
    if (waitingApproval && !approved) {
      // The run's actor cannot approve; the required reviewer does, through the Actions API.
      const asAlice = await viaAccess('/native/pipelines', ({ repository: { owner: 'alice', name: 'demo' }, repositoryId: String(demo.id), action: 'approve', jobId: String(waitingApproval.id), approve: true }));
      receipt.selfApprovalStatus = asAlice.status;
      const asReviewer = await viaAccess('/native/pipelines', ({ repository: { owner: 'alice', name: 'demo' }, repositoryId: String(demo.id), action: 'approve', jobId: String(waitingApproval.id), approve: true, comment: 'Proof approval' }), { ...human, 'X-Golf-Native-Access-Email': 'reviewer@example.com' });
      receipt.reviewerApprovalStatus = asReviewer.status;
      approved = true;
    }
    const open = runs.filter(run => ['QUEUED', 'RUNNING', 'WAITING'].includes(run.state));
    // Jobs no runner can take (Windows/macOS labels) stay queued honestly; they don't hold the proof open.
    const runnable = jobs.filter(job => ['QUEUED', 'RUNNING', 'BLOCKED', 'APPROVAL'].includes(job.state) && JSON.parse(job.runs_on).every(label => label === 'ubuntu-latest'));
    process.stdout.write(`\r${new Date().toISOString()} runs ${runs.length} open ${open.length} jobs ${jobs.map(job => job.state[0]).join('')}   `);
    if (runs.length && !runnable.length || Date.now() > deadline) break;
    await new Promise(r => setTimeout(r, 10_000));
  }
  console.log();

  // ---------- receipt ----------
  const { results: runs } = await db.prepare('SELECT * FROM pipeline_runs ORDER BY id').all();
  const bucket = await runtime.getR2Bucket('PIPELINE_BUCKET');
  for (const repo of repos) {
    const entry = receipt.repositories[repo.name] = { head: repo.head, branch: repo.branch, runs: [] };
    for (const run of runs.filter(run => run.repository_id === repo.id)) {
      const { results: jobs } = await db.prepare('SELECT * FROM pipeline_jobs WHERE run_id=? AND attempt=? ORDER BY id').bind(run.id, run.attempt).all();
      const detail = { id: run.id, workflow: run.workflow_path, name: run.workflow_name, event: run.event, state: run.state, reason: run.reason, jobs: [] };
      for (const job of jobs) {
        const { results: chunks } = await db.prepare('SELECT seq FROM pipeline_log_chunks WHERE job_id=? ORDER BY seq').bind(job.id).all();
        let log = '';
        for (const chunk of chunks) log += await (await bucket.get(`pipelines/${run.id}/${job.id}/log/${String(chunk.seq).padStart(8, '0')}`))?.text() ?? '';
        writeFileSync(join(root, `log-${repo.name}-${job.id}.txt`), log);
        const { results: steps } = await db.prepare('SELECT number,name,state FROM pipeline_steps WHERE job_id=? ORDER BY number').bind(job.id).all();
        detail.jobs.push({ id: job.id, name: job.name, runsOn: JSON.parse(job.runs_on), state: job.state, failureReason: job.failure_reason, logLines: job.log_lines, steps: steps.map(step => `${step.state} ${step.name}`),
          tail: log.split('\n').filter(Boolean).slice(-6), secretLeaked: Boolean(demo) && log.includes(secretValue) });
      }
      const { results: artifacts } = await db.prepare("SELECT name,size,state,kind FROM pipeline_artifacts WHERE run_id=?").bind(run.id).all();
      detail.artifacts = artifacts;
      entry.runs.push(detail);
    }
  }
  receipt.deployments = (await db.prepare('SELECT d.*,e.name AS environment FROM pipeline_deployments d JOIN pipeline_environments e ON e.id=d.environment_id').all()).results;
  receipt.finishedAt = new Date().toISOString();
  writeFileSync(join(root, 'receipt.json'), JSON.stringify(receipt, null, 2));
  writeFileSync(join(root, 'runner.log'), runnerLog.join(''));
  for (const [name, entry] of Object.entries(receipt.repositories)) for (const run of entry.runs) {
    console.log(`\n${name} · ${run.workflow} · ${run.event} · ${run.state}${run.reason ? ' · ' + run.reason : ''}`);
    for (const job of run.jobs) console.log(`  ${job.state.padEnd(9)} ${job.name} [${job.runsOn.join(',')}] ${job.failureReason}${job.secretLeaked ? ' SECRET LEAKED' : ''}`);
    if (run.artifacts.length) console.log('  artifacts:', run.artifacts.map(a => `${a.name} ${a.size}B ${a.state}`).join(', '));
  }
  console.log('\nreceipt', join(root, 'receipt.json'));
  if (demo) for (const run of receipt.repositories.demo.runs) for (const job of run.jobs) assert.equal(job.secretLeaked, false, 'secret must be redacted in stored logs');
  if (args.keep) { console.log('Keeping the Worker and runner up at', origin, '(Ctrl-C to stop)'); await new Promise(() => {}); }
} finally {
  for (const child of children) child.kill('SIGTERM');
  await runtime.dispose();
}
