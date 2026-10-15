#!/usr/bin/env node
// Golf agent speed bench (AM-0). Usage: docs/AGENTIC_MODE_PLAN.md, "Running the bench".
// Node 22+, no dependencies: built-in fetch and the system git. Credentials come only
// from GOLF_BENCH_* environment variables; they reach git through GIT_CONFIG_* env
// (never argv) and are never printed or written to the evidence file.
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { devNull, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SCENARIOS = ['S1', 'S2', 'S3', 'S4', 'S5', 'S6', 'S7'];
const RPC = 'golf.v1.RepositoryService';
const PRIMARY = { S1: ['push'], S2: ['push'], S3: ['push'], S4: ['clone', 'ls_remote'],
  S5: ['GetContents', 'ListCommits', 'GetRepositoryComparison'], S6: ['source_commit'], S7: ['land'] };
const DESCRIBE = {
  S1: 'fast-forward pushes from every worker to one shared branch (fetch tip, commit, push)',
  S2: 'pushes to a branch per worker in the first repository',
  S3: 'pushes to a branch per worker, repositories assigned round-robin',
  S4: 'shallow clones and ls-remote of the first repository during S2 load',
  S5: 'GetContents, ListCommits and GetRepositoryComparison RPC reads during S2 load',
  S6: 'Source API commits (POST /native/source/commit), branch per writer and one shared branch',
  S7: 'the agent pull request loop: a Source API commit on a new agent/ branch, open_pull_request over MCP, then wait until it lands',
};
const USAGE =`Usage: node scripts/agent_speed_bench.mjs [--scenarios S1,S2,S3,S4,S5,S6]
  [--concurrency 1,4,16] [--duration 30] [--think 0] [--land-timeout 900] [--label baseline] [--out path] [--dry-run]
  --think N: each worker pauses N seconds (jittered 0.5x to 1.5x) between operations and starts at a random point within N,
  like an agent that thinks between writes; 0 (default) is a closed loop.
Environment: GOLF_BENCH_ORIGIN, GOLF_BENCH_REPOS=owner/name,...
  GOLF_BENCH_GIT_TOKEN | GOLF_BENCH_GIT_TOKENS=owner/name=token,... | GOLF_BENCH_API_TOKEN
  optional GOLF_BENCH_CI_TOKEN (an administrator's credential: S7 reports GOLF_BENCH_CI_CONTEXT, default bench/ci, as passed on each
  pull request head right after opening it, standing in for CI)
  optional GOLF_BENCH_ACCESS_ID + GOLF_BENCH_ACCESS_SECRET (Cloudflare Access service token)`;

// ---------- arguments and environment ----------

export function parseArgs(argv) {
  const o = { scenarios: ['S1', 'S2', 'S3', 'S4', 'S5'], concurrency: [1, 4, 16], duration: 30, think: 0, landTimeout: 900, label: 'run', out: '', dryRun: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i], value = () => { if (i + 1 >= argv.length) throw Error(`${a} needs a value`); return argv[++i]; };
    if (a === '--scenarios') o.scenarios = value().split(',').map(s => s.trim().toUpperCase()).filter(Boolean);
    else if (a === '--concurrency') o.concurrency = value().split(',').map(Number);
    else if (a === '--duration') o.duration = Number(value());
    else if (a === '--think') o.think = Number(value());
    else if (a === '--land-timeout') o.landTimeout = Number(value());
    else if (a === '--label') o.label = value();
    else if (a === '--out') o.out = value();
    else if (a === '--dry-run') o.dryRun = true;
    else if (a === '--help' || a === '-h') o.help = true;
    else throw Error(`Unknown argument ${a}`);
  }
  const bad = o.scenarios.filter(s => !SCENARIOS.includes(s));
  if (bad.length || !o.scenarios.length) throw Error(`Unknown scenarios: ${bad.join(',') || '(none)'}`);
  if (!o.concurrency.length || o.concurrency.some(n => !Number.isInteger(n) || n < 1 || n > 256)) throw Error('--concurrency takes integers 1..256');
  if (!(o.duration > 0)) throw Error('--duration must be a positive number of seconds');
  if (!(o.think >= 0 && o.think <= 3600)) throw Error('--think must be 0 to 3600 seconds');
  if (!(o.landTimeout > 0 && o.landTimeout <= 7200)) throw Error('--land-timeout must be 1 to 7200 seconds');
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(o.label)) throw Error('--label may use letters, digits, ".", "_" and "-"');
  return o;
}

export function readEnv(env = process.env) {
  const problems = [], origin = (env.GOLF_BENCH_ORIGIN || '').replace(/\/+$/, '');
  let host = '';
  try { const u = new URL(origin); if (!/^https?:$/.test(u.protocol) || u.username || u.password) throw 0; host = u.host; }
  catch { problems.push('GOLF_BENCH_ORIGIN must be an http(s) origin without credentials'); }
  const repos = (env.GOLF_BENCH_REPOS || '').split(',').map(s => s.trim()).filter(Boolean);
  if (!repos.length) problems.push('GOLF_BENCH_REPOS must list at least one owner/name');
  for (const r of repos) if (!/^[\w.-]+\/[\w.-]+$/.test(r)) problems.push(`GOLF_BENCH_REPOS entry is not owner/name: ${r}`);
  const gitTokens = new Map();
  for (const pair of (env.GOLF_BENCH_GIT_TOKENS || '').split(',').map(s => s.trim()).filter(Boolean)) {
    const at = pair.indexOf('=');
    if (at < 1) problems.push('GOLF_BENCH_GIT_TOKENS entries are owner/name=token'); else gitTokens.set(pair.slice(0, at), pair.slice(at + 1));
  }
  const id = env.GOLF_BENCH_ACCESS_ID || '', secret = env.GOLF_BENCH_ACCESS_SECRET || '';
  if (Boolean(id) !== Boolean(secret)) problems.push('Set both GOLF_BENCH_ACCESS_ID and GOLF_BENCH_ACCESS_SECRET, or neither');
  const cfg = { origin, host, repos, gitTokens, gitToken: env.GOLF_BENCH_GIT_TOKEN || '', apiToken: env.GOLF_BENCH_API_TOKEN || '',
    ciToken: env.GOLF_BENCH_CI_TOKEN || '', ciContext: env.GOLF_BENCH_CI_CONTEXT || 'bench/ci', access: id && secret ? { id, secret } : null, problems };
  for (const r of repos) if (!gitAuth(cfg, r)) problems.push(`No Git credential for ${r} (GOLF_BENCH_GIT_TOKEN, GOLF_BENCH_GIT_TOKENS or GOLF_BENCH_API_TOKEN)`);
  cfg.secrets = [id, secret, cfg.gitToken, cfg.apiToken, cfg.ciToken, ...gitTokens.values()].filter(s => s && s.length >= 4);
  for (const s of [...cfg.secrets]) cfg.secrets.push(Buffer.from('golf:' + s).toString('base64'));
  return cfg;
}

const scrub = (cfg, text) => cfg.secrets.reduce((t, s) => t.split(s).join('***'), String(text)).slice(0, 300);
const accessHeaders = cfg => cfg.access ? { 'CF-Access-Client-Id': cfg.access.id, 'CF-Access-Client-Secret': cfg.access.secret } : {};
function gitAuth(cfg, repo) {
  const token = cfg.gitTokens.get(repo) || cfg.gitToken;
  if (token) return 'Basic ' + Buffer.from('golf:' + token).toString('base64');
  return cfg.apiToken ? 'Bearer ' + cfg.apiToken : '';
}
const gitHeaders = (cfg, repo) => ({ ...accessHeaders(cfg), Authorization: gitAuth(cfg, repo) });
const apiHeaders = cfg => ({ ...accessHeaders(cfg), ...(cfg.apiToken ? { Authorization: 'Bearer ' + cfg.apiToken } : {}), 'Content-Type': 'application/json', 'Connect-Protocol-Version': '1' });
const gitUrl = (cfg, repo) => `${cfg.origin}/git/${repo}.git`;

// Git reads its config from env so headers stay out of argv. User/system config and inherited
// GIT_* variables (GIT_DIR, GIT_TRACE_CURL, ...) are dropped, except GIT_SSL_* for custom CAs.
function gitEnv(cfg, repo) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) =>
    !k.startsWith('GOLF_BENCH_') && (!k.startsWith('GIT_') || k.startsWith('GIT_SSL_'))));
  const entries = [['credential.helper', ''], ['http.extraHeader', ''],
    ...Object.entries(gitHeaders(cfg, repo)).map(([k, v]) => ['http.extraHeader', `${k}: ${v}`])];
  entries.forEach(([k, v], i) => { env[`GIT_CONFIG_KEY_${i}`] = k; env[`GIT_CONFIG_VALUE_${i}`] = v; });
  return Object.assign(env, { GIT_CONFIG_COUNT: String(entries.length), GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: devNull,
    GIT_TERMINAL_PROMPT: '0', GIT_AUTHOR_NAME: 'Golf bench', GIT_AUTHOR_EMAIL: 'bench@golf.invalid',
    GIT_COMMITTER_NAME: 'Golf bench', GIT_COMMITTER_EMAIL: 'bench@golf.invalid' });
}

// ---------- processes, outcomes and statistics ----------

function run(cmd, args, { cwd, env, input, timeout = 120_000 } = {}) {
  return new Promise(done => {
    const t0 = performance.now(), child = spawn(cmd, args, { cwd, env, timeout });
    let out = '', err = '';
    child.stdout.on('data', d => { out += d; });
    child.stderr.on('data', d => { err += d; });
    child.stdin.on('error', () => {});
    child.on('error', e => { err += e.message; });
    child.on('close', (code, signal) => done({ code: code ?? -1, signal, out, err, ms: performance.now() - t0 }));
    child.stdin.end(input ?? '');
  });
}
async function must(promise, what) {
  const r = await promise;
  if (r.code !== 0) throw Object.assign(Error(`${what} failed: ${r.err.trim().split('\n').pop()}`), { result: r });
  return r.out.trim();
}

export function httpOutcome(status) {
  if (status >= 200 && status < 300) return 'ok';
  if (status === 409) return 'contention_409';
  return [413, 429, 503].includes(status) ? String(status) : 'other:' + status;
}
export function classifyGit(r) {
  if (r.code === 0) return 'ok';
  const text = r.out + '\n' + r.err, http = /(?:\bHTTP|returned error:) (\d{3})\b/.exec(text);
  if (http) return httpOutcome(Number(http[1]));
  // A lost compare-and-swap is contention whether git or the server's ref lock notices it.
  if (/\[rejected\]|non-fast-forward|fetch first|cannot lock ref|but expected|stale info/.test(text)) return 'nonff_rejected';
  if (/\[remote rejected\]/.test(text)) return 'other:remote_rejected';
  if (/couldn't find remote ref/.test(text)) return 'other:missing_ref';
  return r.signal ? 'other:timeout' : 'other:git_exit_' + r.code;
}
const isContention = o => o === 'contention_409' || o === 'nonff_rejected';

export function stats(values) {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b), q = p => s[Math.min(s.length - 1, Math.max(0, Math.ceil(p * s.length) - 1))];
  const r = v => Math.round(v * 10) / 10;
  return { p50: r(q(0.5)), p95: r(q(0.95)), p99: r(q(0.99)), max: r(s.at(-1)) };
}
const emptyOutcomes = () => ({ ok: 0, contention_409: 0, nonff_rejected: 0, 413: 0, 429: 0, 503: 0, other: {} });

class Recorder {
  constructor(cfg) { Object.assign(this, { cfg, ops: new Map(), local: [], samples: new Set(), release: new Set(), workerRelease: new Set(), timing: new Map() }); }
  // Server-Timing of an HTTP operation: queue (waiting for admission in the repository's Workspace) and worker (the whole request).
  timed(op, h) {
    // A request can carry a stage twice (the Workspace admission queue, and a nested request's own queue): the largest is the wait.
    const st = h.get('server-timing') || '', dur = name => { const all = [...st.matchAll(new RegExp(`(?:^|,)\\s*${name};dur=([\\d.]+)`, 'g'))].map(m => Number(m[1])); return all.length ? Math.max(...all) : null; };
    const queue = dur('queue'), worker = dur('worker');
    if (queue === null && worker === null) return;
    if (!this.timing.has(op)) this.timing.set(op, { queue: [], worker: [] });
    if (queue !== null) this.timing.get(op).queue.push(queue);
    if (worker !== null) this.timing.get(op).worker.push(worker);
  }
  add(op, ms, outcome, detail) {
    if (!this.ops.has(op)) this.ops.set(op, { lat: [], outcomes: emptyOutcomes() });
    const o = this.ops.get(op);
    o.lat.push(ms);
    if (outcome.startsWith('other:')) o.outcomes.other[outcome.slice(6)] = (o.outcomes.other[outcome.slice(6)] || 0) + 1;
    else o.outcomes[outcome]++;
    if (outcome !== 'ok' && detail && this.samples.size < 5) this.samples.add(`${op} ${outcome}: ${scrub(this.cfg, detail).trim().split('\n').slice(-2).join(' | ')}`);
  }
  headers(h) {
    if (h.get('x-golf-release')) this.release.add(h.get('x-golf-release'));
    if (h.get('x-golf-worker-release')) this.workerRelease.add(h.get('x-golf-worker-release'));
  }
  summary(names, seconds) {
    const out = { attempts: 0, successes: 0, successesPerSec: 0, latencyMs: null, outcomes: emptyOutcomes() }, lat = [];
    for (const name of names) {
      const o = this.ops.get(name); if (!o) continue;
      lat.push(...o.lat);
      for (const [k, v] of Object.entries(o.outcomes)) {
        if (k === 'other') for (const [c, n] of Object.entries(v)) out.outcomes.other[c] = (out.outcomes.other[c] || 0) + n;
        else out.outcomes[k] += v;
      }
    }
    out.attempts = lat.length; out.successes = out.outcomes.ok;
    out.successesPerSec = Math.round(out.successes / seconds * 100) / 100;
    out.latencyMs = stats(lat);
    return out;
  }
}

// ---------- local repositories and Git operations ----------

const sleep = ms => new Promise(r => setTimeout(r, ms));
const slug = repo => repo.replace('/', '__');

function seed(ctx, repo) {
  if (!ctx.seeds.has(repo)) ctx.seeds.set(repo, (async () => {
    const dir = join(ctx.tmp, 'seed-' + slug(repo)), env = gitEnv(ctx.cfg, repo), url = gitUrl(ctx.cfg, repo);
    await must(run('git', ['init', '-q', '--bare', dir]), 'git init');
    const head = await run('git', ['ls-remote', '--symref', url, 'HEAD'], { cwd: dir, env });
    if (head.code) throw Error(`ls-remote ${repo}: ${classifyGit(head)} ${scrub(ctx.cfg, head.err.trim())}`);
    const branch = /^ref: refs\/heads\/(\S+)\s+HEAD/m.exec(head.out)?.[1] || null;
    let base = /^([0-9a-f]{40,64})\s+HEAD/m.exec(head.out)?.[1] || null;
    if (base && branch) await must(run('git', ['fetch', '-q', '--no-tags', url, `+refs/heads/${branch}:refs/bench/base`], { cwd: dir, env }), `fetch ${repo}`);
    else base = null;
    return { repo, dir, env, url, branch, base };
  })());
  return ctx.seeds.get(repo);
}

// One small local bare repository per worker, borrowing the seed's objects through alternates.
async function worker(ctx, repo, id) {
  const key = `${repo}#${id}`;
  if (!ctx.workers.has(key)) ctx.workers.set(key, (async () => {
    const s = await seed(ctx, repo), dir = join(ctx.tmp, `w-${slug(repo)}-${id}`);
    await must(run('git', ['init', '-q', '--bare', dir]), 'git init');
    await writeFile(join(dir, 'objects/info/alternates'), join(s.dir, 'objects') + '\n');
    return { id, repo, dir, seed: s, url: s.url, env: { ...s.env, GIT_INDEX_FILE: join(dir, 'bench.index') }, loaded: undefined };
  })());
  return ctx.workers.get(key);
}

async function makeCommit(ctx, w, parent, path, rec) {
  const t0 = performance.now(), opt = { cwd: w.dir, env: w.env };
  const blob = await must(run('git', ['hash-object', '-w', '--stdin'], { ...opt, input: `${ctx.runId} ${path} ${randomBytes(8).toString('hex')}\n` }), 'hash-object');
  if (w.loaded !== parent) await must(run('git', parent ? ['read-tree', parent] : ['read-tree', '--empty'], opt), 'read-tree');
  w.loaded = undefined;
  await must(run('git', ['update-index', '--add', '--cacheinfo', `100644,${blob},${path}`], opt), 'update-index');
  const tree = await must(run('git', ['write-tree'], opt), 'write-tree');
  const commit = await must(run('git', ['commit-tree', tree, ...(parent ? ['-p', parent] : []), '-m', `bench ${path}`], opt), 'commit-tree');
  w.loaded = commit;
  rec.local.push(performance.now() - t0);
  return commit;
}

const track = (ctx, repo, branch) => { if (!ctx.created.has(repo)) ctx.created.set(repo, new Set()); ctx.created.get(repo).add(branch); };

async function push(ctx, w, commit, branch, rec, op = 'push') {
  track(ctx, w.repo, branch);
  const r = await run('git', ['push', '--porcelain', '--no-verify', w.url, `${commit}:refs/heads/${branch}`], { cwd: w.dir, env: w.env });
  const outcome = classifyGit(r);
  rec?.add(op, r.ms, outcome, r.err || r.out);
  return outcome;
}

// Returns the branch tip, null when the branch does not exist, undefined on failure.
async function fetchTip(ctx, w, branch, rec) {
  const r = await run('git', ['fetch', '-q', '--no-tags', '--no-write-fetch-head', w.url, `+refs/heads/${branch}:refs/bench/tip`], { cwd: w.dir, env: w.env });
  const outcome = classifyGit(r);
  rec.add('fetch', r.ms, outcome, r.err);
  if (outcome === 'other:missing_ref') return null;
  if (r.code) return undefined;
  const t0 = performance.now(), tip = await must(run('git', ['rev-parse', 'refs/bench/tip'], { cwd: w.dir, env: w.env }), 'rev-parse');
  rec.local.push(performance.now() - t0);
  return tip;
}

async function lsRemote(ctx, w, branch, rec) {
  const r = await run('git', ['ls-remote', w.url, branch ? `refs/heads/${branch}` : 'HEAD'], { cwd: w.dir, env: w.env });
  rec.add('ls_remote', r.ms, classifyGit(r), r.err);
  return r.code ? undefined : (/^([0-9a-f]{40,64})\s/m.exec(r.out)?.[1] || null);
}

async function captureRelease(ctx, repo, rec) {
  try {
    const res = await fetch(`${gitUrl(ctx.cfg, repo)}/info/refs?service=git-upload-pack`, { headers: gitHeaders(ctx.cfg, repo), signal: AbortSignal.timeout(30_000) });
    rec.headers(res.headers); await res.arrayBuffer();
  } catch { /* release headers are best effort */ }
}

// Fast-forward push loop. Shared mode re-fetches the tip before every commit.
async function pushLoop(ctx, w, branch, shared, rec, deadline, path) {
  let parent = w.seed.base, sync = shared;
  await pace(ctx, deadline, true);
  for (let k = 0; performance.now() < deadline && !ctx.stopped; k++) {
    if (k) await pace(ctx, deadline);
    if (performance.now() >= deadline || ctx.stopped) break;
    try {
      if (sync) {
        const tip = await fetchTip(ctx, w, branch, rec);
        if (tip === undefined) { await sleep(250); continue; }
        parent = tip ?? w.seed.base;
      }
      const outcome = await push(ctx, w, await makeCommit(ctx, w, parent, path, rec), branch, rec);
      if (outcome === 'ok') { parent = w.loaded; sync = shared; } else { sync = true; if (!isContention(outcome)) await sleep(250); }
    } catch (e) { rec.add('local', 0, 'other:local_error', e.message); await sleep(250); }
  }
}

const range = n => Array.from({ length: n }, (_, i) => i);
// Agent pacing (--think): a jittered pause between operations, and a random start within one think time.
export const thinkMs = (think, random = Math.random) => think > 0 ? think * 1000 * (0.5 + random()) : 0;
const pace = async (ctx, deadline, first) => {
  const ms = first ? (ctx.opts.think > 0 ? ctx.opts.think * 1000 * Math.random() : 0) : thinkMs(ctx.opts.think);
  if (ms) await sleep(Math.max(0, Math.min(ms, deadline - performance.now())));
};
const workers = (ctx, n, repoFor, offset = 0) => Promise.all(range(n).map(i => worker(ctx, repoFor(i), offset + i)));

// ---------- RPC and Source API ----------

async function post(ctx, url, headers, body, rec, op, timingOp = op) {
  const t0 = performance.now();
  try {
    const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(60_000) });
    const text = await res.text(), ms = performance.now() - t0;
    rec?.headers(res.headers);
    if (rec && timingOp) rec.timed(timingOp, res.headers);
    if (op) rec.add(op, ms, httpOutcome(res.status), `HTTP ${res.status} ${text}`);
    let json = null; try { json = JSON.parse(text); } catch { /* non-JSON body */ }
    return { status: res.status, json };
  } catch (e) {
    if (op) rec.add(op, performance.now() - t0, 'other:network', e.message);
    return { status: 0, json: null };
  }
}
const rpc = (ctx, method, body, rec, op = method) =>
  post(ctx, `${ctx.cfg.origin}/rpc/${RPC}/${method}`, { ...apiHeaders(ctx.cfg), 'Connect-Protocol-Version': '1' }, body, rec, op);
const repoKey = repo => { const [owner, name] = repo.split('/'); return { owner, name }; };

// ---------- scenarios ----------

// S2 load behind S4/S5. Local setup and release capture happen before the clock starts.
async function backgroundS2(ctx, n, repo, tag) {
  const rec = new Recorder(ctx.cfg), ws = await workers(ctx, n, () => repo);
  await captureRelease(ctx, repo, rec);
  return { rec, start: deadline => Promise.all(ws.map(w => pushLoop(ctx, w, `${ctx.prefix}${tag}-bg-w${w.id}`, false, rec, deadline, `${ctx.dir}/${tag}-bg-w${w.id}.txt`))) };
}

async function scenario(ctx, id, n) {
  const rec = new Recorder(ctx.cfg), notes = [], repo = ctx.cfg.repos[0], tag = `${id.toLowerCase()}-c${n}`;
  const result = { scenario: id, concurrency: n, status: 'ok', notes };
  const finish = async (rec, started, bg, variant) => {
    const seconds = (performance.now() - started) / 1000;
    let background;
    if (bg) { await bg.done; background = bg.rec.summary(['push'], seconds); bg.rec.release.forEach(v => rec.release.add(v)); bg.rec.workerRelease.forEach(v => rec.workerRelease.add(v)); }
    const ops = Object.fromEntries([...rec.ops.keys()].map(k => [k, { ...rec.summary([k], seconds),
      ...(rec.timing.has(k) ? { serverTimingMs: { queue: stats(rec.timing.get(k).queue), worker: stats(rec.timing.get(k).worker) } } : {}) }]));
    const main = rec.summary(PRIMARY[id], seconds);
    return { ...result, ...(variant ? { variant } : {}), durationSec: Math.round(seconds * 100) / 100, ...main,
      contention: main.outcomes.contention_409 + main.outcomes.nonff_rejected, ops, localGitMs: stats(rec.local),
      ...(background ? { background } : {}), releases: { release: [...rec.release], workerRelease: [...rec.workerRelease] },
      errorSamples: [...rec.samples, ...(bg ? bg.rec.samples : [])].slice(0, 8) };
  };
  const skip = (status, reason) => [{ ...result, status, reason }];
  const deadlineFrom = () => performance.now() + ctx.opts.duration * 1000;

  if (id === 'S1' || id === 'S2' || id === 'S3') {
    const repos = ctx.cfg.repos, repoFor = id === 'S3' ? i => repos[i % repos.length] : () => repo;
    if (id === 'S3' && repos.length < n) notes.push(`${repos.length} repositories for ${n} workers; workers share repositories round-robin with a branch each`);
    const ws = await workers(ctx, n, repoFor);
    for (const r of new Set(ws.map(w => w.repo))) await captureRelease(ctx, r, rec);
    const shared = `${ctx.prefix}${tag}-shared`;
    if (id === 'S1') {
      const w = ws[0], setup = new Recorder(ctx.cfg);
      const start = w.seed.base ?? await makeCommit(ctx, w, null, `${ctx.dir}/${tag}-root.txt`, setup);
      const outcome = await push(ctx, w, start, shared, setup, 'setup');
      if (outcome !== 'ok') return skip('failed', `could not create ${shared}: ${outcome}`);
    }
    result.repositories = new Set(ws.map(w => w.repo)).size;
    const started = performance.now(), deadline = deadlineFrom();
    await Promise.all(ws.map(w => pushLoop(ctx, w, id === 'S1' ? shared : `${ctx.prefix}${tag}-w${w.id}`, id === 'S1', rec, deadline, `${ctx.dir}/${tag}-w${w.id}.txt`)));
    return [await finish(rec, started)];
  }

  if (id === 'S4') {
    await captureRelease(ctx, repo, rec);
    const readers = await workers(ctx, n, () => repo, 1000);
    const bg = await backgroundS2(ctx, n, repo, tag), deadline = deadlineFrom(), started = performance.now();
    bg.done = bg.start(deadline);
    await Promise.all(readers.map(async w => {
      await pace(ctx, deadline, true);
      for (let k = 0; performance.now() < deadline && !ctx.stopped; k++) {
        if (k) await pace(ctx, deadline);
        const into = join(ctx.tmp, `clone-${w.id}-${k}`);
        const r = await run('git', ['clone', '-q', '--depth', '1', '--no-checkout', w.url, into], { cwd: ctx.tmp, env: w.env });
        rec.add('clone', r.ms, classifyGit(r), r.err);
        await rm(into, { recursive: true, force: true });
        if (performance.now() < deadline) await lsRemote(ctx, w, null, rec);
      }
    }));
    notes.push('clone is `git clone --depth 1 --no-checkout`; ls_remote lists HEAD');
    return [await finish(rec, started, bg)];
  }

  if (id === 'S5') {
    const s = await seed(ctx, repo), got = await rpc(ctx, 'GetRepository', { repository: repoKey(repo) }, rec, 'setup');
    if (got.status === 401 || got.status === 403) return skip('skipped', 'no read identity');
    if (got.status !== 200 || !got.json?.repository?.id) return skip('failed', `GetRepository returned ${got.status}`);
    if (!s.base) return skip('skipped', 'empty repository');
    rec.ops.delete('setup');
    const repositoryId = String(got.json.repository.id), w = await worker(ctx, repo, 2000), head = `${ctx.prefix}${tag}-head`;
    const headCommit = await makeCommit(ctx, w, s.base, `${ctx.dir}/${tag}-head.txt`, new Recorder(ctx.cfg));
    const pushed = await push(ctx, w, headCommit, head, null);
    if (pushed !== 'ok') return skip('failed', `could not create ${head}: ${pushed}`);
    const key = repoKey(repo), calls = [
      ['GetContents', { repository: key, repositoryId, ref: s.base, path: '', page: { limit: 100 } }],
      ['ListCommits', { repository: key, ref: s.branch, page: { limit: 20 } }],
      ['GetRepositoryComparison', { selection: { repository: key, repositoryId, sourceRepository: key, sourceRepositoryId: repositoryId,
        baseBranch: s.branch, headBranch: head, baseCommitId: s.base, headCommitId: headCommit } }]];
    const bg = await backgroundS2(ctx, n, repo, tag), deadline = deadlineFrom(), started = performance.now();
    bg.done = bg.start(deadline);
    await Promise.all(range(n).map(async i => {
      await pace(ctx, deadline, true);
      for (let k = i; performance.now() < deadline && !ctx.stopped; k++) { if (k > i) await pace(ctx, deadline); await rpc(ctx, ...calls[k % calls.length], rec); }
    }));
    return [await finish(rec, started, bg)];
  }

  // S7: the whole agent pull request loop on a repository with agentic mode (low-risk paths, landing without a person). Each worker
  // commits one file under docs/ to a new agent/ branch through the Source API, opens a pull request over MCP, then polls the pull
  // request until it lands (merged) or --land-timeout passes. land latency is open-to-merged. Its branches are deleted at the end.
  if (id === 'S7') {
    if (!ctx.cfg.apiToken) return skip('unavailable', 'GOLF_BENCH_API_TOKEN is not set');
    const s = await seed(ctx, repo);
    if (!s.base) return skip('skipped', 'empty repository');
    const [owner, name] = repo.split('/'), commitUrl = `${ctx.cfg.origin}/native/source/commit`;
    const mcp = async (tool, args) => {
      const r = await post(ctx, `${ctx.cfg.origin}/mcp`, { ...apiHeaders(ctx.cfg), Accept: 'application/json, text/event-stream' },
        { jsonrpc: '2.0', id: randomBytes(4).toString('hex'), method: 'tools/call', params: { name: tool, arguments: { owner, name, ...args } } }, rec, null,
        tool === 'open_pull_request' ? 'open_pr' : 'poll_pr');
      const result = r.json?.result, text = result?.content?.[0]?.text || r.json?.error?.message || '';
      let value = null; try { value = JSON.parse(text); } catch { /* a tool error is text */ }
      return { ok: r.status === 200 && result && !result.isError, status: r.status, value, text };
    };
    const deadline = deadlineFrom(), started = performance.now(), landTimeout = ctx.opts.landTimeout * 1000;
    let landed = 0, opened = 0;
    await Promise.all(range(n).map(async i => {
      await pace(ctx, deadline, true);
      for (let k = 0; performance.now() < deadline && !ctx.stopped; k++) {
        if (k) await pace(ctx, deadline);
        if (performance.now() >= deadline || ctx.stopped) break;
        const branch = `agent/${ctx.prefix.replace(/\//g, '-')}${tag}-w${i}-${k}`;
        const c = await post(ctx, commitUrl, apiHeaders(ctx.cfg), { repository: { owner, name }, branch, expectedHead: '', base: s.branch, message: `bench ${tag} w${i} #${k}`,
          changes: [{ path: `docs/bench/${ctx.runId}/${tag}-w${i}-${k}.md`, content: `${ctx.runId} ${randomBytes(8).toString('hex')}\n` }] }, rec, 'source_commit');
        if (c.status < 200 || c.status >= 300) { await sleep(1000); continue; }
        track(ctx, repo, branch);
        const t0 = performance.now(), pr = await mcp('open_pull_request', { head: branch, base: s.branch, title: `bench ${tag} w${i} #${k}` });
        rec.add('open_pr', performance.now() - t0, pr.ok ? 'ok' : pr.status === 200 ? 'other:tool_error' : httpOutcome(pr.status), pr.text);
        if (!pr.ok || !pr.value?.number) continue;
        opened++;
        // CI stand-in: report the required check on the head commit, as CI would after the pull request opens.
        const head = c.json?.commitId;
        if (ctx.cfg.ciToken && head) {
          const t1 = performance.now(), check = await post(ctx, `${ctx.cfg.origin}/native/repository-check`, { ...accessHeaders(ctx.cfg), Authorization: 'Bearer ' + ctx.cfg.ciToken, 'Content-Type': 'application/json', 'Connect-Protocol-Version': '1' },
            { repository: { owner, name }, repositoryId: String(c.json?.repositoryId || ''), commitId: head, context: ctx.cfg.ciContext, state: 'REPORTED_CHECK_STATE_SUCCESS', description: 'bench CI stand-in', idempotencyKey: crypto.randomUUID() }, rec, null, 'ci_report');
          rec.add('ci_report', performance.now() - t1, httpOutcome(check.status), `HTTP ${check.status}`);
        }
        const number = pr.value.number, openedAt = performance.now();
        let done = false;
        while (!done && performance.now() - openedAt < landTimeout && !ctx.stopped) {
          await sleep(5000);
          const g = await mcp('get_pull_request', { number });
          rec.add('poll_pr', 0, g.ok ? 'ok' : g.status === 200 ? 'other:tool_error' : httpOutcome(g.status), g.text);
          if (g.value?.merged) { rec.add('land', performance.now() - openedAt, 'ok'); landed++; done = true; }
          else if (g.value?.state === 'ISSUE_STATE_CLOSED') { rec.add('land', performance.now() - openedAt, 'other:closed_unmerged'); done = true; }
        }
        if (!done) rec.add('land', performance.now() - openedAt, 'other:land_timeout');
      }
    }));
    notes.push(`${opened} pull requests opened, ${landed} landed within ${ctx.opts.landTimeout}s; land latency is open-to-merged`);
    return [await finish(rec, started)];
  }

  // S6: Source API commits (AM-2 contract), a branch per writer and all writers on one branch.
  if (!ctx.cfg.apiToken) return skip('unavailable', 'GOLF_BENCH_API_TOKEN is not set');
  // The probe names a real repository and no changes: a deployment with the route answers 400 (no changes); one without it, 404 or 501.
  const [owner, name] = repo.split('/'), url = `${ctx.cfg.origin}/native/source/commit`;
  const probe = await post(ctx, url, apiHeaders(ctx.cfg), { repository: { owner, name }, branch: 'bench/probe', expectedHead: '', message: 'probe', changes: [] }, rec);
  if (probe.status === 404 || probe.status === 501) return skip('unavailable', `POST /native/source/commit returned ${probe.status}`);
  const s = await seed(ctx, repo);
  if (!s.base) return skip('skipped', 'empty repository');
  const out = [];
  for (const variant of ['branch-per-writer', 'shared-branch']) {
    const vrec = new Recorder(ctx.cfg), shared = variant === 'shared-branch', setupWorker = await worker(ctx, repo, 3000);
    rec.release.forEach(v => vrec.release.add(v)); rec.workerRelease.forEach(v => vrec.workerRelease.add(v));
    const branchOf = i => shared ? `${ctx.prefix}${tag}-shared` : `${ctx.prefix}${tag}-w${i}`;
    const created = await Promise.all([...new Set(range(n).map(branchOf))].map(b => push(ctx, setupWorker, s.base, b, null)));
    if (created.some(o => o !== 'ok')) { out.push({ ...result, variant, status: 'failed', reason: `could not create branches: ${created.join(',')}` }); continue; }
    const deadline = deadlineFrom(), started = performance.now();
    await Promise.all(range(n).map(async i => {
      let headSha = s.base;
      const w = { ...setupWorker }, branch = branchOf(i);
      await pace(ctx, deadline, true);
      for (let k = 0; performance.now() < deadline && !ctx.stopped; k++) {
        if (k) await pace(ctx, deadline);
        const body = { repository: repoKey(repo), branch, expectedHead: headSha, message: `bench ${tag} w${i}`,
          changes: [{ path: `${ctx.dir}/${tag}-${variant}-w${i}.txt`, content: `${ctx.runId} ${randomBytes(8).toString('hex')}\n` }], onStale: shared ? 'merge' : 'fail' };
        const r = await post(ctx, url, apiHeaders(ctx.cfg), body, vrec, 'source_commit');
        const next = r.json?.commit?.id || r.json?.commitId || r.json?.head || r.json?.sha;
        if (r.status >= 200 && r.status < 300 && next) { headSha = next; continue; }
        if (ctx.opts.think) { const fresh = r.json?.currentHead; if (fresh) headSha = fresh; continue; }
        const fresh = r.json?.currentHead || await lsRemote(ctx, w, branch, vrec);
        if (fresh) headSha = fresh;
        if (r.status !== 409) await sleep(250);
      }
    }));
    out.push(await finish(vrec, started, null, variant));
  }
  return out;
}

// ---------- cleanup, output and main ----------

async function cleanup(ctx) {
  const report = { attempted: 0, deleted: 0, absent: 0, failed: [] };
  for (const [repo, branches] of ctx.created) {
    const s = await seed(ctx, repo).catch(() => null);
    if (!s) { report.failed.push(...[...branches].map(branch => ({ repository: repo, branch, outcome: 'no_local_seed' }))); continue; }
    const list = [...branches];
    report.attempted += list.length;
    for (let i = 0; i < list.length; i += 20) {
      const batch = list.slice(i, i + 20);
      const r = await run('git', ['push', '--porcelain', s.url, ...batch.map(b => `:refs/heads/${b}`)], { cwd: s.dir, env: s.env });
      const done = new Set([...r.out.matchAll(/^-\t:refs\/heads\/(\S+)\t/gm)].map(m => m[1]));
      report.deleted += done.size;
      for (const b of batch.filter(b => !done.has(b))) {
        const one = await run('git', ['push', '--porcelain', s.url, `:refs/heads/${b}`], { cwd: s.dir, env: s.env });
        if (one.code === 0) report.deleted++;
        else if (/remote ref does not exist/.test(one.err + one.out)) report.absent++;
        else report.failed.push({ repository: repo, branch: b, outcome: classifyGit(one) });
      }
    }
  }
  return report;
}

const fmt = v => v == null ? '-' : String(v);
function table(results) {
  const rows = [['scenario', 'conc', 'status', 'attempts', 'ok', 'ok/s', 'p50', 'p95', 'p99', 'max', 'outcomes']];
  for (const r of results) {
    const o = r.outcomes ? Object.entries(r.outcomes).flatMap(([k, v]) => k === 'other' ? Object.entries(v).map(([c, n]) => `${c}=${n}`) : v && k !== 'ok' ? [`${k}=${v}`] : []).join(' ') : r.reason || '';
    rows.push([r.scenario + (r.variant ? `/${r.variant}` : ''), r.concurrency, r.status, r.attempts, r.successes, r.successesPerSec,
      r.latencyMs?.p50, r.latencyMs?.p95, r.latencyMs?.p99, r.latencyMs?.max, o].map(fmt));
    if (r.background) rows.push(['  +S2 background', '', '', r.background.attempts, r.background.successes, r.background.successesPerSec,
      r.background.latencyMs?.p50, r.background.latencyMs?.p95, r.background.latencyMs?.p99, r.background.latencyMs?.max, ''].map(fmt));
  }
  const width = rows[0].map((_, c) => Math.max(...rows.map(r => r[c].length)));
  return rows.map(r => r.map((v, c) => c === r.length - 1 ? v : v.padEnd(width[c])).join('  ')).join('\n');
}

function plan(cfg, opts, runId) {
  return [`Golf agent speed bench (dry run: ${opts.dryRun})`, `origin host: ${cfg.host}`, `repositories: ${cfg.repos.join(', ')}`,
    `scenarios: ${opts.scenarios.join(',')}  concurrency: ${opts.concurrency.join(',')}  duration: ${opts.duration}s  think: ${opts.think}s  label: ${opts.label}`,
    `auth: access=${cfg.access ? 'service token' : 'none'} git=${cfg.repos.map(r => cfg.gitTokens.has(r) ? 'repo-token' : cfg.gitToken ? 'git-token' : cfg.apiToken ? 'api-token' : 'none').join(',')} api=${cfg.apiToken ? 'api-token' : 'none'}`,
    `branches: bench/${runId}/... (deleted at the end)`,
    ...opts.scenarios.map(id => `  ${id}: ${DESCRIBE[id]}`),
    ...(opts.scenarios.includes('S6') && !cfg.apiToken ? ['note: S6 needs GOLF_BENCH_API_TOKEN and will report unavailable'] : []),
    ...(opts.scenarios.includes('S3') && cfg.repos.length < Math.max(...opts.concurrency) ? [`note: S3 has ${cfg.repos.length} repositories for up to ${Math.max(...opts.concurrency)} workers`] : [])].join('\n');
}

async function main(argv) {
  let opts;
  try { opts = parseArgs(argv); } catch (e) { console.error(`${e.message}\n${USAGE}`); return 2; }
  if (opts.help) { console.log(USAGE); return 0; }
  const cfg = readEnv();
  if (cfg.problems.length) { console.error(cfg.problems.map(p => 'error: ' + p).join('\n') + '\n' + USAGE); return 2; }
  const date = new Date(), stamp = date.toISOString().slice(0, 10).replace(/-/g, '');
  const runId = `${stamp}-${randomBytes(3).toString('hex')}`;
  console.log(plan(cfg, opts, runId));
  if (opts.dryRun) return 0;

  const ctx = { cfg, opts, runId, prefix: `bench/${runId}/`, dir: `bench/${runId}`, tmp: await mkdtemp(join(tmpdir(), 'golf-bench-')),
    seeds: new Map(), workers: new Map(), created: new Map(), stopped: false };
  process.once('SIGINT', () => { ctx.stopped = true; console.error('interrupted: stopping and cleaning up'); });
  const results = [];
  try {
    for (const id of opts.scenarios) for (const n of opts.concurrency) {
      if (ctx.stopped) break;
      console.log(`running ${id} at concurrency ${n}...`);
      try { results.push(...await scenario(ctx, id, n)); }
      catch (e) { results.push({ scenario: id, concurrency: n, status: 'failed', reason: scrub(cfg, e.message) }); }
    }
  } finally {
    ctx.cleanup = await cleanup(ctx).catch(e => ({ error: scrub(cfg, e.message) }));
    await rm(ctx.tmp, { recursive: true, force: true });
  }
  const git = await run('git', ['--version']);
  const evidence = { tool: 'agent_speed_bench', schemaVersion: 1, runId, label: opts.label, date: date.toISOString(), originHost: cfg.host,
    gitVersion: git.out.trim(), nodeVersion: process.version, durationSec: opts.duration, concurrency: opts.concurrency, scenarios: opts.scenarios,
    repositories: cfg.repos, branchPrefix: ctx.prefix,
    auth: { access: Boolean(cfg.access), git: cfg.gitTokens.size || cfg.gitToken ? 'repository-credential' : 'api-token', api: Boolean(cfg.apiToken) },
    latencyNote: 'latencyMs covers every attempt of the primary operation (network only); localGitMs is local commit plumbing',
    results, cleanup: ctx.cleanup };
  const text = JSON.stringify(evidence, null, 2) + '\n';
  if (cfg.secrets.some(s => text.includes(s))) throw Error('refusing to write evidence containing a credential');
  const out = resolve(opts.out || join(dirname(fileURLToPath(import.meta.url)), '..', 'docs/compatibility/evidence', `agent-speed-${stamp}-${opts.label}.json`));
  await mkdir(dirname(out), { recursive: true });
  await writeFile(out, text);
  console.log('\n' + table(results));
  console.log(`\ncleanup: ${JSON.stringify(ctx.cleanup)}\nwrote ${out}`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  main(process.argv.slice(2)).then(code => { process.exitCode = code; }, e => { console.error('fatal:', e.message); process.exitCode = 1; });
