// Real workerd/D1/R2 runtime check for GitLab CI pipelines driven by the UNMODIFIED stock GitLab Runner (RUN-C).
//
//   node cloudflare/forge/gitlab-pipeline-runtime-check.mjs "$(command -v cf)" /path/to/gitlab-runner-linux-amd64 [options]
//     --phases demo,cancel,hugo,extensions,kubernetes   (default demo,cancel)
//     --upstream DIR        directory holding clones of gitlab.com/inkscape/extensions and gitlab.com/pages/hugo
//     --evidence DIR        where job states, traces and artifact bytes are written (default: a new temp directory)
//     --host IP             address the Worker listens on; job containers must reach it (default 172.17.0.1, the Docker bridge)
//     --kube-context NAME   kind context for the kubernetes phase (default kind-golf-ci; namespace golf-gitlab-test is created and deleted)
//
// The Worker runs in the local workerd shipped with the qualified CLI with real D1, R2 and Secrets Store bindings. The only
// stand-in is Cloudflare Artifacts: repositories are local bare Git repositories served by `git http-backend` behind the
// provider URL the Worker fetches. The runner binary must be GitLab Runner 18.5.0 (sha256 checked below).
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import * as esbuild from '../agents/node_modules/esbuild/lib/main.js';

const runnerSha256 = '4f84c2995cff1aaff89ce8639426bf1219cb3770d9360ce8783e9b5fde628762'; // gitlab-runner-linux-amd64 v18.5.0 (release.sha256)
const args = process.argv.slice(2), option = (name, fallback) => { const i = args.indexOf('--' + name); return i >= 0 ? args[i + 1] : fallback; };
const [cliPath, runnerBinary] = args;
const phases = new Set(option('phases', 'demo,cancel').split(','));
const host = option('host', '172.17.0.1'), kubeContext = option('kube-context', 'kind-golf-ci'), namespace = 'golf-gitlab-test';
const upstream = option('upstream', ''), evidence = option('evidence', '') || await mkdtemp(join(tmpdir(), 'golf-gitlab-evidence-'));
await mkdir(evidence, { recursive: true });
assert.equal(createHash('sha256').update(await readFile(runnerBinary)).digest('hex'), runnerSha256, 'GitLab Runner binary is not the pinned 18.5.0 release');

const cli = dirname(dirname(realpathSync(cliPath)));
if (JSON.parse(await readFile(resolve(cli, 'package.json'), 'utf8')).version !== '1.0.0-beta.13') throw Error('Qualify native CLI');
const { Miniflare, convertV4MiniflareOptions } = await import(pathToFileURL(resolve(cli, 'node_modules/miniflare/dist/src/index.js')).href);

// ---------- the Worker under test: the production modules plus a harness route for setup and evidence ----------
const entry = `
import { gitLabRunner } from './gitlab-runner.mjs';
import { actionsGit } from './forgejo-runner.mjs';
import { gitLabPipelinePlan } from './gitlab-pipeline.mjs';
import { createPipelineRun, refusePipelineRun, createRegistrationToken, playManualJob, approveEnvironmentJob, saveEnvironmentValue, readJobLog, openArtifact, cancelPipelineRun, advanceRunNow } from './pipelines.mjs';
import { remote } from './git.mjs';
import { Fault } from './common.mjs';
const provider = env => name => ({ info: async () => ({ name, remote: remote(env, name) }), createToken: async () => ({ plaintext: 'local-provider-token' }), revokeToken: async () => true, [Symbol.dispose]() {} });
const withArtifact = async (env, row, action) => action(provider(env)(row.artifact_name));
async function harness(db, env, body) {
  const person = { id: body.personId || 1 };
  switch (body.op) {
    case 'sql': { const statement = db.prepare(body.sql).bind(...(body.params || [])); return body.all ? (await statement.all()).results : body.run ? (await statement.run()).meta : await statement.first(); }
    case 'registration': return createRegistrationToken(db, env, person, { engine: 'gitlab-ci', scope: 'installation', scopeId: '', labels: body.labels || [], ttlHours: 1, uses: 5 });
    case 'plan': {
      const files = body.files || {};
      const run = { repositoryId: body.repositoryId, engine: 'gitlab-ci', workflowPath: '.gitlab-ci.yml', workflowName: 'GitLab CI', event: body.event || 'push', ref: body.ref, commitId: body.commitId,
        beforeSha: '0'.repeat(40), actorId: 1, trusted: true, title: body.title || '' };
      try {
        const plan = await gitLabPipelinePlan({ source: body.source, readFile: async path => files[path] ?? null, files: body.list || null, changedFiles: null,
          context: { event: run.event, ref: body.ref, commitId: body.commitId, beforeSha: run.beforeSha, defaultBranch: body.defaultBranch, projectPath: body.projectPath, origin: env.PUBLIC_ORIGIN, commitMessage: body.title || '' } });
        if (plan.skipped) return { skipped: plan.skipped };
        const created = await createPipelineRun(db, env, { ...run, workflowName: plan.workflowName, reason: plan.notes.join(' ') }, plan.jobs);
        return { runId: created.runId, jobs: created.jobs, notes: plan.notes };
      } catch (error) {
        if (!(error instanceof Fault) || error.status !== 400) throw error;
        const refused = await refusePipelineRun(db, env, run, error.message);
        return { refused: error.message, runId: refused.runId };
      }
    }
    case 'play': return playManualJob(db, env, person, body.jobId);
    case 'approve': return approveEnvironmentJob(db, env, person, body.jobId, { approve: body.approve !== false, comment: body.comment || '' });
    case 'environmentValue': return saveEnvironmentValue(db, env, person, await db.prepare('SELECT * FROM pipeline_environments WHERE id=?').bind(body.environmentId).first(), body.value);
    case 'cancel': return cancelPipelineRun(db, env, person, body.runId);
    case 'advance': return advanceRunNow(env, body.runId);
    case 'log': return readJobLog(db, env, { id: body.jobId }, { fromByte: 0, limit: 8 * 1024 * 1024 });
  }
  throw new Fault('invalid_argument', 400, 'unknown harness op');
}
export default { async fetch(request, env) {
  const url = new URL(request.url), db = env.DB.withSession('first-primary');
  try {
    if (url.pathname === '/__harness') {
      if (request.headers.get('X-Harness-Key') !== env.HARNESS_KEY) return new Response('denied', { status: 403 });
      return Response.json(await harness(db, env, await request.json()) ?? null);
    }
    if (url.pathname === '/__harness/artifact') {
      if (request.headers.get('X-Harness-Key') !== env.HARNESS_KEY) return new Response('denied', { status: 403 });
      return new Response((await openArtifact(db, env, Number(url.searchParams.get('id')))).body);
    }
    if (url.pathname.startsWith('/api/v4/')) return await gitLabRunner(db, env, request, async () => false, () => new Response('denied', { status: 403 }));
    if (/\\/(info\\/refs|git-upload-pack)$/.test(url.pathname)) return await actionsGit(request, env, withArtifact);
    return new Response('not found', { status: 404 });
  } catch (error) {
    if (error instanceof Fault) return Response.json({ code: error.code, message: error.message }, { status: error.status });
    return new Response(String(error?.stack || error), { status: 500 });
  }
} };`;
const bundle = await esbuild.build({ stdin: { contents: entry, resolveDir: new URL('./src/', import.meta.url).pathname, loader: 'js', sourcefile: 'harness-entry.mjs' },
  bundle: true, write: false, format: 'esm', platform: 'neutral', external: ['node:*'], logLevel: 'error' });

// ---------- local Git provider ----------
const work = await mkdtemp(join(tmpdir(), 'golf-gitlab-runtime-'));
const reposDir = join(work, 'repos');
await mkdir(reposDir);
const git = (...cmd) => execFileSync('git', cmd, { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 }).trim();
function httpBackend(request, name, suffix) {
  return new Promise(async (resolvePromise, reject) => {
    const body = Buffer.from(await request.arrayBuffer()), url = new URL(request.url);
    const child = spawn('git', ['http-backend'], { env: { ...process.env, GIT_PROJECT_ROOT: reposDir, GIT_HTTP_EXPORT_ALL: '1', REQUEST_METHOD: request.method,
      PATH_INFO: `/${name}.git${suffix}`, QUERY_STRING: url.search.slice(1), CONTENT_TYPE: request.headers.get('Content-Type') || '', CONTENT_LENGTH: String(body.length),
      HTTP_GIT_PROTOCOL: request.headers.get('Git-Protocol') || '' } });
    const chunks = []; child.stdout.on('data', chunk => chunks.push(chunk)); child.on('error', reject);
    child.on('close', () => {
      const out = Buffer.concat(chunks), end = out.indexOf('\r\n\r\n');
      if (end < 0) return reject(Error('git http-backend returned no headers'));
      const headers = new Headers(); let status = 200;
      for (const line of out.subarray(0, end).toString().split('\r\n')) {
        const colon = line.indexOf(':'); if (colon < 0) continue;
        if (line.slice(0, colon).toLowerCase() === 'status') status = Number(line.slice(colon + 1).trim().split(' ')[0]); else headers.set(line.slice(0, colon), line.slice(colon + 1).trim());
      }
      resolvePromise(new Response(out.subarray(end + 4), { status, headers }));
    });
    child.stdin.end(body);
  });
}

// ---------- runtime ----------
const port = await new Promise(done => { const server = createServer(); server.listen(0, host, () => { const { port } = server.address(); server.close(() => done(port)); }); });
const origin = `http://${host}:${port}`, harnessKey = createHash('sha256').update(String(Math.random())).digest('hex');
const accountId = 'a'.repeat(32), namespaceName = 'local-gitlab';
const runtime = new Miniflare(convertV4MiniflareOptions({
  host, port, modules: [{ type: 'ESModule', path: 'harness-entry.mjs', contents: bundle.outputFiles[0].text }], compatibilityDate: '2026-10-08', compatibilityFlags: ['nodejs_compat'],
  secretsStoreSecrets: { EXECUTION_VALUE_KEY: { store_id: 'local-automation', secret_name: 'execution-value-key' } },
  outboundService: async request => {
    const url = new URL(request.url), prefix = `/git/${namespaceName}/`;
    if (url.origin !== `https://${accountId}.artifacts.cloudflare.net` || !url.pathname.startsWith(prefix)) return new Response('unexpected outbound ' + request.url, { status: 502 });
    assert.equal(request.headers.get('Authorization'), 'Bearer local-provider-token');
    const rest = url.pathname.slice(prefix.length), dot = rest.indexOf('.git/');
    return httpBackend(request, rest.slice(0, dot), rest.slice(dot + 4));
  },
  bindings: { PUBLIC_ORIGIN: origin, WORKSPACE_SLUG: 'mj', ACCOUNT_ID: accountId, ARTIFACTS_NAMESPACE: namespaceName, PIPELINES_ENABLED: 'true', HARNESS_KEY: harnessKey, GITLAB_DEFAULT_IMAGE: 'alpine:3.23' },
  d1Databases: { DB: 'local-gitlab-pipelines' }, r2Buckets: { PIPELINE_BUCKET: 'local-gitlab-pipelines' },
}));
const children = [];
const cleanup = async () => {
  for (const child of children) if (child.exitCode === null) child.kill('SIGTERM');
  await new Promise(done => setTimeout(done, 1500));
  await runtime.dispose().catch(() => {});
  await rm(work, { recursive: true, force: true }).catch(() => {});
};
process.on('SIGINT', async () => { await cleanup(); process.exit(130); });

const log = (...items) => { const line = `[${new Date().toISOString().slice(11, 19)}] ` + items.join(' '); console.log(line); };
const call = async body => {
  const response = await runtime.dispatchFetch(origin + '/__harness', { method: 'POST', headers: { 'X-Harness-Key': harnessKey, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const text = await response.text();
  if (!response.ok) throw Error(`harness ${body.op} ${response.status}: ${text}`);
  return JSON.parse(text);
};
const sql = (query, ...params) => call({ op: 'sql', sql: query, params, all: true });
const exec = (query, ...params) => call({ op: 'sql', sql: query, params, run: true });

try {
  await runtime.ready;
  const secret = await runtime.getSecretsStoreSecretAPI('EXECUTION_VALUE_KEY');
  await secret().create(Buffer.alloc(32, 7).toString('base64'));
  const database = await runtime.getD1Database('DB');
  const schema = await readFile(new URL('./schema.sql', import.meta.url), 'utf8');
  for (const statement of schema.replace(/--[^\n]*/g, '').split(/;\s*(?=CREATE\b)/).filter(s => s.trim())) await database.prepare(statement).run();
  await database.prepare("INSERT INTO users(id,login,email) VALUES(1,'mj','mj@example.invalid'),(2,'reviewer','reviewer@example.invalid')").run();

  // ---------- repositories ----------
  let nextRepository = 1;
  const repositories = {};
  async function addRepository(name, source, branch) {
    const id = nextRepository++, artifact = 'repo-' + createHash('md5').update(name).digest('hex');
    const bare = join(reposDir, artifact + '.git');
    git('clone', '--quiet', '--bare', '--no-hardlinks', source, bare);
    const head = git('--git-dir', bare, 'rev-parse', 'refs/heads/' + branch);
    await database.prepare("INSERT INTO repositories(id,name,description,artifact_name,creator_id,creation_key,input_hash,state,created_at,default_branch) VALUES(?,?,'',?,1,?,?,'ACTIVE',?,?)")
      .bind(id, name, artifact, crypto.randomUUID(), 'c'.repeat(64), new Date().toISOString(), branch).run();
    await database.prepare("INSERT INTO grants(repository_id,user_id,role) VALUES(?,1,'admin')").bind(id).run();
    repositories[name] = { id, bare, defaultBranch: branch, head };
    return repositories[name];
  }
  const snapshot = (repository, commit) => {
    const list = git('--git-dir', repository.bare, 'ls-tree', '-r', '--name-only', commit).split('\n').filter(Boolean);
    const files = {};
    let total = 0;
    for (const path of list) {
      if (!/\.(ya?ml|json|lock|toml|txt|cfg)$/.test(path)) continue;
      const text = git('--git-dir', repository.bare, 'show', `${commit}:${path}`);
      if ((total += text.length) > 2 * 1024 * 1024) break;
      files[path] = text;
    }
    return { list: list.slice(0, 20000), files };
  };
  async function startPipeline(repository, branch, sourceOverride, title = '') {
    const commit = git('--git-dir', repository.bare, 'rev-parse', 'refs/heads/' + branch), { list, files } = snapshot(repository, commit);
    const source = sourceOverride ?? files['.gitlab-ci.yml'];
    return call({ op: 'plan', repositoryId: repository.id, ref: 'refs/heads/' + branch, commitId: commit, defaultBranch: repository.defaultBranch, projectPath: 'mj/' + Object.keys(repositories).find(name => repositories[name] === repository),
      source, files, list, title });
  }
  const jobs = runId => sql('SELECT id,name,stage,state,when_mode,allow_failure,exit_code,failure_reason,runs_on,needs,started_at,finished_at,outputs,environment,log_bytes FROM pipeline_jobs WHERE run_id=? ORDER BY id', runId);
  const runState = async runId => (await sql('SELECT state,reason FROM pipeline_runs WHERE id=?', runId))[0];
  async function waitFor(label, check, timeoutMs, everyMs = 3000) {
    const deadline = Date.now() + timeoutMs;
    let last = '';
    for (;;) {
      const value = await check();
      if (value) return value;
      if (Date.now() > deadline) throw Error(`Timed out waiting for ${label}`);
      if (children.some(child => child.exitCode !== null && !child.stopping)) throw Error(`A runner exited while waiting for ${label}; see runner-*.log in ${evidence}`);
      await new Promise(done => setTimeout(done, everyMs));
      const summary = JSON.stringify(await sql("SELECT state,COUNT(*) AS n FROM pipeline_jobs GROUP BY state"));
      if (summary !== last) { log(label, summary); last = summary; }
    }
  }
  async function record(label, runId) {
    const rows = await jobs(runId), run = await runState(runId), out = { label, runId, run, jobs: [] };
    for (const job of rows) {
      const trace = job.log_bytes ? (await call({ op: 'log', jobId: job.id })).text : '';
      await writeFile(join(evidence, `${label}-${job.id}-${job.name.replace(/[^A-Za-z0-9._-]+/g, '_')}.log`), trace);
      const artifacts = await sql('SELECT id,name,kind,size,sha256,content_type FROM pipeline_artifacts WHERE job_id=?', job.id);
      for (const artifact of artifacts) {
        const response = await runtime.dispatchFetch(`${origin}/__harness/artifact?id=${artifact.id}`, { headers: { 'X-Harness-Key': harnessKey } });
        const bytes = Buffer.from(await response.arrayBuffer());
        artifact.bytes = bytes.length; artifact.sha256 = createHash('sha256').update(bytes).digest('hex');
        const file = join(evidence, `${label}-${job.id}-artifact-${artifact.id}-${artifact.name.replace(/[^A-Za-z0-9._-]+/g, '_')}`);
        await writeFile(file, bytes);
        if (artifact.kind === 'gitlab-archive') { try { artifact.entries = execFileSync('unzip', ['-Z1', file], { encoding: 'utf8' }).trim().split('\n').slice(0, 40); } catch { artifact.entries = ['(unzip failed)']; } }
      }
      out.jobs.push({ ...job, artifacts, traceTail: trace.split('\n').slice(-12).join('\n') });
    }
    await writeFile(join(evidence, `${label}.json`), JSON.stringify(out, null, 2));
    log(`== ${label}: run ${runId} ${run.state}${run.reason ? ' — ' + run.reason : ''}`);
    for (const job of out.jobs) log(`   ${job.state.padEnd(9)} ${job.name}${job.exit_code !== null ? ' exit=' + job.exit_code : ''}${job.failure_reason ? ' (' + job.failure_reason + ')' : ''}${job.artifacts.length ? ' artifacts=' + job.artifacts.map(a => `${a.name}:${a.bytes}B`).join(',') : ''}`);
    return out;
  }

  // ---------- the stock runner ----------
  async function startRunner(name, executorArgs, extraConfig = '', extraEnv = {}) {
    const home = join(work, name), config = join(home, 'config.toml');
    await mkdir(join(home, 'builds'), { recursive: true });
    const { token } = await call({ op: 'registration' });
    const registered = execFileSync(runnerBinary, ['register', '--non-interactive', '--config', config, '--url', origin, '--registration-token', token, '--description', name,
      '--run-untagged=true', '--tag-list', 'golf,linux', ...executorArgs], { encoding: 'utf8', env: { ...process.env, HOME: home }, stdio: ['ignore', 'pipe', 'pipe'] });
    void registered;
    let text = await readFile(config, 'utf8');
    text = text.replace(/^concurrent = \d+/m, 'concurrent = 4').replace(/^check_interval = \d+/m, 'check_interval = 1') + extraConfig;
    if (!/^check_interval/m.test(text)) text = 'check_interval = 1\n' + text;
    await writeFile(config, text);
    const child = spawn(runnerBinary, ['run', '--config', config, '--working-directory', join(home, 'builds')], { env: { ...process.env, HOME: home, ...extraEnv }, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', chunk => output += chunk); child.stderr.on('data', chunk => output += chunk);
    children.push(child);
    child.on('close', () => writeFile(join(evidence, `runner-${name}.log`), output).catch(() => {}));
    log(`runner ${name} registered and running (${executorArgs.join(' ')})`);
    return { child, stop: async () => { child.stopping = true; child.kill('SIGQUIT'); await new Promise(done => child.exitCode !== null ? done() : child.on('close', done)); await writeFile(join(evidence, `runner-${name}.log`), output); } };
  }

  const demoSource = await readFile(new URL('./fixtures/gitlab/demo.gitlab-ci.yml', import.meta.url), 'utf8');
  const demoDir = join(work, 'demo-src');
  await mkdir(demoDir);
  await writeFile(join(demoDir, '.gitlab-ci.yml'), demoSource);
  await writeFile(join(demoDir, 'README.md'), '# golf-demo\n');
  git('-C', demoDir, 'init', '-q', '-b', 'main'); git('-C', demoDir, 'add', '.');
  git('-C', demoDir, '-c', 'user.name=Golf', '-c', 'user.email=golf@example.invalid', 'commit', '-q', '-m', 'GitLab CI demo');
  const demo = await addRepository('golf-demo', demoDir, 'main');
  const summary = {};

  const docker = phases.has('demo') || phases.has('cancel') || phases.has('hugo') || phases.has('extensions')
    // A host directory for /cache: the runner's default per-slot cache volume is not shared between concurrent jobs.
    ? await mkdir(join(work, 'cache'), { recursive: true }).then(() => startRunner('golf-docker', ['--executor', 'docker', '--docker-image', 'alpine:3.23', '--docker-volumes', join(work, 'cache') + ':/cache', '--docker-pull-policy', 'if-not-present'])) : null;

  if (phases.has('demo')) {
    // A protected environment: production needs reviewer 2; its secret is released only after approval.
    await exec("INSERT INTO pipeline_environments(repository_id,artifact_name,name,reviewers,prevent_self_review,url,created_by,created_at,updated_at) VALUES(?,?,'production','[2]',1,'',1,?,?)",
      demo.id, (await sql('SELECT artifact_name FROM repositories WHERE id=?', demo.id))[0].artifact_name, new Date().toISOString(), new Date().toISOString());
    const environment = (await sql("SELECT id FROM pipeline_environments WHERE name='production'"))[0];
    await call({ op: 'environmentValue', environmentId: environment.id, value: { name: 'DEPLOY_TOKEN', kind: 'secret', value: 'golf-deploy-secret-4815162342' } });
    const started = await startPipeline(demo, 'main');
    assert.ok(started.runId && !started.refused, JSON.stringify(started));
    log('demo pipeline', started.runId, started.notes?.join(' ') || '');
    const runId = started.runId;
    await waitFor('demo stages', async () => (await jobs(runId)).every(job => ['SUCCESS', 'FAILURE', 'SKIPPED', 'MANUAL', 'CANCELLED'].includes(job.state)), 20 * 60_000);
    await record('demo-stages', runId);
    const deploy = (await jobs(runId)).find(job => job.name === 'deploy');
    assert.equal(deploy.state, 'MANUAL');
    assert.equal((await runState(runId)).state, 'SUCCESS', 'manual allow_failure job leaves the run successful');
    await call({ op: 'play', jobId: deploy.id });
    await waitFor('deploy approval', async () => (await jobs(runId)).find(job => job.name === 'deploy').state === 'APPROVAL', 60_000, 1000);
    await assert.rejects(call({ op: 'approve', jobId: deploy.id, personId: 1 }), /reviewer/);
    await call({ op: 'approve', jobId: deploy.id, personId: 2, comment: 'ship it' });
    await waitFor('deploy', async () => ['SUCCESS', 'FAILURE'].includes((await jobs(runId)).find(job => job.name === 'deploy').state), 10 * 60_000);
    summary.demo = await record('demo', runId);
    const byName = Object.fromEntries(summary.demo.jobs.map(job => [job.name, job]));
    assert.equal(byName.build.state, 'SUCCESS'); assert.equal(byName.unit.state, 'SUCCESS'); assert.equal(byName['postgres-service'].state, 'SUCCESS');
    assert.equal(byName['flaky-check'].state, 'FAILURE'); assert.equal(byName['flaky-check'].exit_code, 3);
    assert.equal(byName.package.state, 'SUCCESS'); assert.equal(byName['report 1/2'].state, 'SUCCESS'); assert.equal(byName['report 2/2'].state, 'SUCCESS');
    assert.ok(Date.parse(byName.package.started_at) < Date.parse(byName['postgres-service'].finished_at), 'needs: [build] starts package before the test stage finishes');
    assert.equal(byName.deploy.state, 'SUCCESS');
    const deployLog = await readFile(join(evidence, `demo-${byName.deploy.id}-deploy.log`), 'utf8');
    assert.ok(!deployLog.includes('golf-deploy-secret-4815162342') && /DEPLOY_TOKEN length 29/.test(deployLog), 'environment secret is delivered and masked');
    assert.ok(/cache hit: stamp/.test(await readFile(join(evidence, `demo-${byName.unit.id}-unit.log`), 'utf8')), 'cache restored in a later job');
    assert.equal(JSON.parse(byName.unit.outputs).coverage, '87.5');
    assert.equal((await runState(runId)).state, 'SUCCESS');
    const deployment = await sql('SELECT action,state,url,commit_id FROM pipeline_deployments WHERE job_id=?', byName.deploy.id);
    summary.demo.deployment = deployment;
    log('deployment record', JSON.stringify(deployment));
  }

  if (phases.has('cancel')) {
    const started = await startPipeline(demo, 'main', 'stages: [test]\nlong:\n  stage: test\n  script:\n    - echo started\n    - sleep 300\n  after_script:\n    - echo after-script-ran\n');
    const runId = started.runId;
    await waitFor('cancel job running', async () => (await jobs(runId))[0].log_bytes > 0, 5 * 60_000, 1000);
    await call({ op: 'cancel', runId });
    await waitFor('cancel', async () => (await runState(runId)).state === 'CANCELLED' && (await jobs(runId))[0].state === 'CANCELLED', 3 * 60_000, 1000);
    summary.cancel = await record('cancel', runId);
  }

  if (phases.has('hugo')) {
    const hugo = await addRepository('hugo', join(upstream, 'hugo'), 'main');
    git('--git-dir', hugo.bare, 'branch', 'feature', 'main');
    const refused = await startPipeline(hugo, 'main');
    log('hugo main:', JSON.stringify(refused));
    assert.match(refused.refused, /GitLab Pages/);
    const started = await startPipeline(hugo, 'feature');
    await waitFor('hugo feature', async () => ['SUCCESS', 'FAILURE'].includes((await runState(started.runId)).state), 20 * 60_000);
    summary.hugo = { main: refused, feature: await record('hugo-feature', started.runId) };
  }

  if (phases.has('extensions')) {
    const extensions = await addRepository('extensions', join(upstream, 'extensions'), 'master');
    const started = await startPipeline(extensions, 'master');
    assert.ok(started.runId && !started.refused, JSON.stringify(started));
    const runId = started.runId;
    // Windows jobs carry saas-windows-medium-amd64 tags no runner here has: they stay QUEUED, and test:coverage waits behind them (GitLab does the same).
    await waitFor('extensions linux jobs', async () => (await jobs(runId)).every(job => job.state !== 'RUNNING' && !(job.state === 'QUEUED' && job.runs_on === '[]')), 90 * 60_000, 10_000);
    summary.extensions = await record('extensions', runId);
    await call({ op: 'cancel', runId });
    summary.extensionsAfterCancel = await record('extensions-cancelled', runId);
  }
  if (docker) await docker.stop();

  if (phases.has('kubernetes')) {
    const kubectl = (...cmd) => execFileSync('kubectl', ['--context', kubeContext, ...cmd], { encoding: 'utf8' }).trim();
    try { kubectl('delete', 'namespace', namespace, '--wait=true', '--ignore-not-found'); } catch { /* fresh */ }
    kubectl('create', 'namespace', namespace);
    try {
      const kubeconfig = join(work, 'kubeconfig');
      await writeFile(kubeconfig, execFileSync('kubectl', ['config', 'view', '--raw', '--minify', '--context', kubeContext], { encoding: 'utf8' }));
      // The runner talks to the kind API with the operator's kubeconfig (KUBECONFIG), like a workstation-hosted runner.
      const k8s = await startRunner('golf-kubernetes', ['--executor', 'kubernetes', '--kubernetes-namespace', namespace, '--kubernetes-image', 'alpine:3.23',
        '--kubernetes-pull-policy', 'if-not-present'], '', { KUBECONFIG: kubeconfig });
      const started = await startPipeline(demo, 'main', await readFile(new URL('./fixtures/gitlab/kubernetes.gitlab-ci.yml', import.meta.url), 'utf8'));
      await waitFor('kubernetes pipeline', async () => ['SUCCESS', 'FAILURE'].includes((await runState(started.runId)).state), 20 * 60_000);
      summary.kubernetes = await record('kubernetes', started.runId);
      summary.kubernetes.pods = kubectl('get', 'pods', '-n', namespace, '-o', 'wide').split('\n');
      await k8s.stop();
    } finally {
      kubectl('delete', 'namespace', namespace, '--wait=false');
    }
  }
  await writeFile(join(evidence, 'summary.json'), JSON.stringify(summary, null, 2));
  log('Evidence written to', evidence);
  console.log('Real workerd/D1/R2 GitLab CI pipelines with the stock GitLab Runner 18.5.0 passed:', [...phases].join(', '));
} finally {
  await cleanup();
}
