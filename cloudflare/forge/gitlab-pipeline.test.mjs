import test from 'node:test';
import assert from 'node:assert/strict';
import { gitLabPipelinePlan, evaluate, globPattern, duration } from './src/gitlab-pipeline.mjs';
import { gitLabRunner } from './src/gitlab-runner.mjs';
import { createPipelineRun, createRegistrationToken, cancelPipelineRun, playManualJob } from './src/pipelines.mjs';
import { pipelineFixture } from './pipelines.test.mjs';

const context = (extra = {}) => ({ event: 'push', ref: 'refs/heads/main', commitId: 'c'.repeat(40), beforeSha: 'b'.repeat(40), defaultBranch: 'main', projectPath: 'alice/project', origin: 'https://golf.example.invalid', ...extra });
const plan = (source, { files = {}, changedFiles = null, list = null, ...extra } = {}) => gitLabPipelinePlan({ source, readFile: async path => files[path] ?? null, files: list, changedFiles, context: context(extra) });
const byName = result => Object.fromEntries(result.jobs.map(job => [job.name, { ...job, spec: JSON.parse(job.payload) }]));

const synthetic = `
include:
  - local: ci/common.yml
variables:
  GLOBAL: one
  RAW: { value: "$NOT_EXPANDED", expand: false }
default:
  image: alpine:3.23
  before_script: [echo default-before]
  retry: 1
stages: [build, test, deploy]
.base:
  script: [echo base]
  variables: { FROM_BASE: "yes" }
build:
  stage: build
  extends: .base
  script:
    - !reference [.shared, script]
    - echo build > out.txt
  artifacts: { paths: [out.txt], expire_in: 1 week, reports: { dotenv: build.env } }
  cache: { key: { files: [lock.json] }, paths: [.cache/] }
lint:
  stage: build
  needs: []
  script: echo lint
  rules:
    - if: '$CI_COMMIT_BRANCH == "main" && $GLOBAL =~ /^on/'
      variables: { RULE_VAR: set }
test:
  stage: test
  parallel: 2
  needs: [build]
  services: [{ name: "postgres:16", alias: db, variables: { POSTGRES_PASSWORD: pw } }]
  script: echo test
  timeout: 15 minutes
matrix:
  stage: test
  parallel: { matrix: [{ PY: ["3.11", "3.12"], OS: linux }] }
  script: echo $PY
  allow_failure: true
coverage:
  stage: deploy
  dependencies: ["matrix: [3.11, linux]"]
  script: echo "TOTAL 87.5%"
  coverage: '/TOTAL\\s+(\\d+\\.\\d+)%/'
release:
  stage: deploy
  when: manual
  inherit: { default: false }
  image: alpine:3.23
  script: echo deploy
  environment: { name: "review/$CI_COMMIT_REF_SLUG", url: "https://$CI_COMMIT_REF_SLUG.example.invalid" }
tagged-only:
  only: [tags]
  script: echo tag
not-main:
  except: [main]
  script: echo nope
`;
const common = { 'ci/common.yml': '.shared:\n  script: [echo shared]\n', 'lock.json': '{"a":1}' };

test('a .gitlab-ci.yml becomes a stage-ordered DAG with GitLab defaults, includes, references and parallel jobs', async () => {
  const result = await plan(synthetic, { files: common });
  const jobs = byName(result);
  assert.deepEqual(Object.keys(jobs).sort(), ['build', 'coverage', 'lint', 'matrix: [3.11, linux]', 'matrix: [3.12, linux]', 'release', 'test 1/2', 'test 2/2']);
  assert.deepEqual(jobs.build.spec.script, ['echo default-before', 'echo shared', 'echo build > out.txt']);
  assert.deepEqual(jobs.build.spec.variables.find(v => v.key === 'FROM_BASE'), { key: 'FROM_BASE', value: 'yes', raw: false });
  assert.deepEqual(jobs.build.spec.variables.find(v => v.key === 'RAW'), { key: 'RAW', value: '$NOT_EXPANDED', raw: true });
  assert.equal(jobs.build.retryMax, 1);
  assert.deepEqual(jobs.build.spec.artifacts.map(a => [a.artifact_type, a.artifact_format, a.expire_in]), [['archive', 'zip', '1 week'], ['dotenv', 'gzip', '1 week']]);
  assert.match(jobs.build.spec.cache[0].key, /^[a-f0-9]{40}$/);
  assert.deepEqual(jobs.lint.needs, []);
  assert.ok(jobs.lint.spec.variables.some(v => v.key === 'RULE_VAR'));
  assert.deepEqual(jobs['test 1/2'].needs, ['build']);
  assert.deepEqual(jobs['test 1/2'].spec.dependencies, ['build']);
  assert.equal(jobs['test 2/2'].spec.variables.find(v => v.key === 'CI_NODE_INDEX').value, '2');
  assert.deepEqual(jobs['test 1/2'].spec.services, [{ name: 'postgres:16', alias: 'db', variables: [{ key: 'POSTGRES_PASSWORD', value: 'pw' }] }]);
  assert.equal(jobs['test 1/2'].timeoutSeconds, 900);
  assert.equal(jobs['matrix: [3.12, linux]'].spec.variables.find(v => v.key === 'PY').value, '3.12');
  assert.equal(jobs['matrix: [3.11, linux]'].allowFailure, true);
  // Stage order: a job without needs waits for every job of earlier stages.
  assert.deepEqual(jobs.coverage.needs.sort(), ['build', 'lint', 'matrix: [3.11, linux]', 'matrix: [3.12, linux]', 'test 1/2', 'test 2/2']);
  assert.deepEqual(jobs.coverage.spec.dependencies, ['matrix: [3.11, linux]']);
  assert.equal(jobs.release.when, 'manual');
  assert.equal(jobs.release.allowFailure, true);
  assert.deepEqual(jobs.release.spec.script, ['echo deploy']);
  assert.deepEqual(jobs.release.environment, { name: 'review/main', url: 'https://main.example.invalid', action: 'start' });
  assert.ok(result.notes.some(note => /cache:key:files/.test(note)));
  // Tag pipelines: only tags-only and unrestricted jobs; except:[main] runs on tags too.
  const tag = byName(await plan(synthetic, { files: common, ref: 'refs/tags/v1' }));
  assert.ok(tag['tagged-only'] && tag['not-main'] && !tag.lint);
  // Merge request pipelines run only jobs that opt in.
  assert.deepEqual(await plan(synthetic, { files: common, event: 'merge_request_event', ref: 'refs/pull/3/head', headRef: 'feature', baseRef: 'main', pullNumber: 3 }), { skipped: 'No jobs match this pipeline’s rules.' });
});

test('workflow rules, changes and exists follow GitLab semantics', async () => {
  const source = `workflow:\n  name: "Run $CI_COMMIT_REF_NAME"\n  rules:\n    - if: $CI_COMMIT_TAG\n      when: never\n    - when: always\na:\n  script: x\n  rules:\n    - changes: [src/**/*.js]\nb:\n  script: x\n  rules:\n    - exists: [Dockerfile]\n      when: manual\n`;
  assert.match((await plan(source, { ref: 'refs/tags/v1' })).skipped, /when: never/);
  const pushed = await plan(source, { changedFiles: ['src/x/y.js'], list: ['Dockerfile', 'src/x/y.js'] });
  assert.equal(pushed.workflowName, 'Run main');
  assert.deepEqual(pushed.jobs.map(job => [job.name, job.when, job.allowFailure]), [['a', 'on_success', false], ['b', 'manual', false]]);
  assert.deepEqual((await plan(source, { changedFiles: ['README.md'], list: [] })).skipped, 'No jobs match this pipeline’s rules.');
  const fresh = await plan(source, { list: [] });
  assert.deepEqual(fresh.jobs.map(job => job.name), ['a']);
  assert.ok(fresh.notes.some(note => /no before-sha diff/.test(note)));
});

test('unsupported configuration refuses pipeline creation with a visible reason', async () => {
  const cases = [
    ['include:\n  - remote: https://example.com/ci.yml\na: { script: x }\n', /include:remote/],
    ['include:\n  - template: Auto-DevOps.gitlab-ci.yml\na: { script: x }\n', /include:template/],
    ['include:\n  - project: g/p\n    file: x.yml\na: { script: x }\n', /include:project/],
    ['a: { script: x, trigger: other }\n', /trigger/],
    ['pages: { script: x }\n', /GitLab Pages/],
    ['a: { script: x, pages: true }\n', /GitLab Pages/],
    ['a: { script: x, retry: { max: 2, when: runner_system_failure } }\n', /retry:when/],
    ['a: { script: x, when: delayed, start_in: 5 minutes }\n', /delayed/],
    ['a: { script: x, allow_failure: { exit_codes: [3] } }\n', /exit_codes/],
    ['a: { script: x, environment: { name: prod, kubernetes: { namespace: x } } }\n', /environment:kubernetes/],
    ['a: { script: x, stage: nowhere }\n', /not declared/],
    ['a: { script: x, scriptt: y }\n', /unknown keyword/],
    ['a: { stage: build, script: x, needs: [b] }\nb: { stage: test, script: x }\n', /later stage/],
    ['a: { script: x, needs: [{ project: g/p, job: j, ref: main }] }\n', /needs:project/],
    ['a: { script: x, timeout: 7h }\n', /6 hours/],
    ['a: { script: x, image: { name: x, kubernetes: { user: 1 } } }\n', /image:kubernetes/],
    ['a: !custom { script: x }\n', /YAML/],
    ['a: { script: x, rules: [{ if: "$A ==" }] }\n', /Incomplete expression/],
    ['a: { stage: .pre, script: x }\n', /outside the .pre/],
  ];
  for (const [source, reason] of cases) await assert.rejects(plan(source), error => error.status === 400 && reason.test(error.message), source);
  // A job excluded by its rules does not refuse the pipeline for an unsupported feature.
  assert.deepEqual((await plan('test: { script: x }\npages-job: { script: x, pages: true, rules: [{ if: $CI_COMMIT_TAG }] }\n')).jobs.map(job => job.name), ['test']);
});

test('expressions, globs and durations', () => {
  const vars = { A: 'main', B: '', P: '/^ma/', N: 'x' };
  const lookup = name => vars[name];
  assert.equal(evaluate('$A == "main" && ($B || $N != null)', lookup), true);
  assert.equal(evaluate('$A =~ $P', lookup), true);
  assert.equal(evaluate('$A !~ /^MA/i', lookup), false);
  assert.equal(evaluate('$UNSET == null || $B', lookup), true);
  assert.equal(evaluate('$B', lookup), false);
  assert.equal(globPattern('src/**/*.{js,ts}').test('src/a/b/c.ts'), true);
  assert.equal(globPattern('src/**/*.js').test('src/c.js'), true);
  assert.equal(globPattern('*.md').test('docs/a.md'), false);
  assert.equal(duration('1h 30m', 't'), 5400);
  assert.equal(duration('2 days', 't'), 172800);
});

// ---------- stock-runner protocol against the shared pipeline core ----------
async function protocol(t) {
  const f = await pipelineFixture(t, { GITLAB_DEFAULT_IMAGE: 'alpine:3.23' });
  const call = async (path, method, body, headers = {}) => gitLabRunner(f.db, f.env, new Request(f.env.PUBLIC_ORIGIN + path, { method, headers,
    ...(body === undefined ? {} : { body: typeof body === 'string' || body instanceof Uint8Array ? body : JSON.stringify(body) }) }), async () => true, () => assert.fail('evidence Git'));
  const json = { 'Content-Type': 'application/json' };
  const { token: registration } = await createRegistrationToken(f.db, f.env, { id: 1 }, { engine: 'gitlab-ci', scope: 'repository', scopeId: '1', labels: [], ttlHours: 1, uses: 1 });
  const registered = await call('/api/v4/runners', 'POST', { token: registration, description: 'stock', tag_list: 'docker,linux', info: { version: '18.5.0', executor: 'docker' } }, json);
  assert.equal(registered.status, 201);
  const runner = await registered.json();
  assert.match(runner.token, /^glrt-golf_[a-f0-9]{32}_[a-f0-9]{64}$/);
  return { f, call, json, runner };
}
const createRun = async (f, source, files = {}) => {
  const result = await plan(source, { files });
  return createPipelineRun(f.db, f.env, { repositoryId: 1, engine: 'gitlab-ci', workflowPath: '.gitlab-ci.yml', workflowName: result.workflowName, event: 'push', ref: 'refs/heads/main',
    commitId: 'c'.repeat(40), beforeSha: 'b'.repeat(40), actorId: 1, trusted: true }, result.jobs);
};
const multipart = (name, bytes) => {
  const boundary = 'golfboundary', head = `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${name}"\r\nContent-Type: application/octet-stream\r\n\r\n`;
  const tail = `\r\n--${boundary}--\r\n`, enc = new TextEncoder();
  const body = new Uint8Array([...enc.encode(head), ...bytes, ...enc.encode(tail)]);
  return { body, headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` } };
};

test('stock GitLab Runner protocol: register, claim, trace, artifacts between stages, dotenv, coverage, finish', async t => {
  const { f, call, json, runner } = await protocol(t);
  assert.equal((await call('/api/v4/runners/verify', 'POST', { token: runner.token, system_id: 's_12345678' }, json)).status, 200);
  assert.equal((await call('/api/v4/runners/verify', 'POST', { token: 'glrt-golf_' + 'a'.repeat(32) + '_' + 'b'.repeat(64) }, json)).status, 403);
  const request = () => call('/api/v4/jobs/request', 'POST', { token: runner.token, info: { version: '18.5.0', executor: 'docker', platform: 'linux', architecture: 'amd64' } }, json);
  assert.equal((await request()).status, 204);
  const created = await createRun(f, 'build:\n  stage: build\n  script: [echo hi]\n  artifacts: { paths: [out], reports: { dotenv: build.env } }\ntest:\n  coverage: "/TOTAL (\\\\d+)%/"\n  script: [echo $FROM_DOTENV]\ndeploy:\n  stage: deploy\n  when: manual\n  script: [echo deploy]\n');
  const claimed = await request();
  assert.equal(claimed.status, 201);
  const job = await claimed.json();
  assert.equal(job.job_info.name, 'build');
  assert.match(job.token, /^golfjob_[a-f0-9]{64}$/);
  assert.equal(job.git_info.repo_url, `https://gitlab-ci-token:${job.token}@golf.example.invalid/alice/project.git`);
  assert.equal(job.git_info.sha, 'c'.repeat(40));
  assert.deepEqual(job.steps.map(step => step.name), ['script']);
  const variable = name => job.variables.find(v => v.key === name)?.value;
  assert.equal(variable('CI_PIPELINE_ID'), String(created.runId));
  assert.equal(variable('CI_JOB_ID'), String(job.id));
  assert.equal(variable('CI_PROJECT_PATH'), 'alice/project');
  assert.equal(variable('CI_COMMIT_BRANCH'), 'main');
  assert.equal(job.variables.find(v => v.key === 'CI_JOB_TOKEN').masked, true);
  assert.equal(JSON.parse(f.sql.prepare('SELECT info FROM pipeline_runners WHERE id=?').get(runner.id).info).executor, 'docker');
  const auth = { 'Job-Token': job.token };
  assert.equal((await call(`/api/v4/jobs/${job.id}/trace`, 'PATCH', 'hello\n', { ...auth, 'Content-Range': '0-5' })).status, 202);
  const stale = await call(`/api/v4/jobs/${job.id}/trace`, 'PATCH', 'x', { ...auth, 'Content-Range': '0-0' });
  assert.equal(stale.status, 416); assert.equal(stale.headers.get('Range'), '0-6');
  assert.equal((await call(`/api/v4/jobs/${job.id}/trace`, 'PATCH', 'x', { 'Job-Token': 'golfjob_' + 'f'.repeat(64), 'Content-Range': '6-6' })).status, 403);
  const zip = new Uint8Array([80, 75, 3, 4, 1, 2, 3]);
  const archive = multipart('artifacts.zip', zip);
  assert.equal((await call(`/api/v4/jobs/${job.id}/artifacts?artifact_format=zip&artifact_type=archive&expire_in=1+day`, 'POST', archive.body, { ...auth, ...archive.headers })).status, 201);
  const dotenv = new Uint8Array(await new Response(new Blob(['FROM_DOTENV=passed\n']).stream().pipeThrough(new CompressionStream('gzip'))).arrayBuffer());
  const report = multipart('build.env.gz', dotenv);
  assert.equal((await call(`/api/v4/jobs/${job.id}/artifacts?artifact_format=gzip&artifact_type=dotenv`, 'POST', report.body, { ...auth, ...report.headers })).status, 201);
  assert.equal((await call(`/api/v4/jobs/${job.id}`, 'PUT', { token: job.token, state: 'running' }, json)).headers.get('Job-Status'), 'running');
  assert.equal((await call(`/api/v4/jobs/${job.id}`, 'PUT', { token: job.token, state: 'success', exit_code: 0 }, json)).status, 200);
  const next = await (await request()).json();
  assert.equal(next.job_info.name, 'test');
  assert.deepEqual(next.dependencies.map(d => [d.id, d.name, d.artifacts_file.size]), [[job.id, 'build', zip.length]]);
  assert.equal(next.variables.find(v => v.key === 'FROM_DOTENV').value, 'passed');
  const download = await call(`/api/v4/jobs/${job.id}/artifacts`, 'GET', undefined, { 'Job-Token': next.dependencies[0].token });
  assert.equal(download.status, 200);
  assert.deepEqual(new Uint8Array(await download.arrayBuffer()), zip);
  // The finished job's own token no longer reads anything.
  assert.equal((await call(`/api/v4/jobs/${job.id}/artifacts`, 'GET', undefined, auth)).status, 403);
  await call(`/api/v4/jobs/${next.id}/trace`, 'PATCH', 'TOTAL 91%\n', { 'Job-Token': next.token, 'Content-Range': '0-9' });
  assert.equal((await call(`/api/v4/jobs/${next.id}`, 'PUT', { token: next.token, state: 'success', exit_code: 0 }, json)).status, 200);
  assert.equal(JSON.parse(f.sql.prepare('SELECT outputs FROM pipeline_jobs WHERE id=?').get(next.id).outputs).coverage, '91');
  const states = () => Object.fromEntries(f.sql.prepare('SELECT name,state FROM pipeline_jobs WHERE run_id=?').all(created.runId).map(row => [row.name, row.state]));
  assert.deepEqual(states(), { build: 'SUCCESS', test: 'SUCCESS', deploy: 'MANUAL' });
  assert.equal(f.sql.prepare('SELECT state FROM pipeline_runs WHERE id=?').get(created.runId).state, 'SUCCESS');
  await playManualJob(f.db, f.env, { id: 1 }, f.sql.prepare("SELECT id FROM pipeline_jobs WHERE name='deploy'").get().id);
  const deploy = await (await request()).json();
  assert.equal(deploy.job_info.name, 'deploy');
  assert.equal((await call(`/api/v4/jobs/${deploy.id}`, 'PUT', { token: deploy.token, state: 'failed', exit_code: 3, failure_reason: 'script_failure' }, json)).status, 200);
  assert.equal(f.sql.prepare('SELECT state,exit_code,failure_reason FROM pipeline_jobs WHERE id=?').get(deploy.id).exit_code, 3);
  assert.equal(f.sql.prepare('SELECT state FROM pipeline_runs WHERE id=?').get(created.runId).state, 'FAILURE');
});

test('cancellation reaches the stock runner, oversize artifacts are refused and evidence credentials stay on the evidence path', async t => {
  const { f, call, json, runner } = await protocol(t);
  f.env.GITLAB_ARTIFACT_MAX_BYTES = String(1024 * 1024);
  const created = await createRun(f, 'a:\n  script: [sleep 100]\n');
  const job = await (await call('/api/v4/jobs/request', 'POST', { token: runner.token, info: { version: '18.5.0' } }, json)).json();
  const big = multipart('artifacts.zip', new Uint8Array(1024 * 1024 + 10));
  assert.equal((await call(`/api/v4/jobs/${job.id}/artifacts?artifact_format=zip&artifact_type=archive`, 'POST', big.body, { 'Job-Token': job.token, ...big.headers })).status, 413);
  await cancelPipelineRun(f.db, f.env, { id: 1 }, created.runId);
  const trace = await call(`/api/v4/jobs/${job.id}/trace`, 'PATCH', 'x', { 'Job-Token': job.token, 'Content-Range': '0-0' });
  assert.equal(trace.headers.get('Job-Status'), 'canceled');
  // The job keeps its token until the runner's terminal update.
  assert.equal(f.sql.prepare('SELECT state FROM pipeline_jobs WHERE id=?').get(job.id).state, 'RUNNING');
  assert.equal((await call(`/api/v4/jobs/${job.id}`, 'PUT', { token: job.token, state: 'running' }, json)).headers.get('Job-Status'), 'canceled');
  const final = await call(`/api/v4/jobs/${job.id}`, 'PUT', { token: job.token, state: 'failed', exit_code: 137, failure_reason: 'job_canceled' }, json);
  assert.deepEqual([final.status, final.headers.get('Job-Status')], [200, 'canceled']);
  assert.equal(f.sql.prepare('SELECT state FROM pipeline_jobs WHERE id=?').get(job.id).state, 'CANCELLED');
  assert.equal(f.sql.prepare('SELECT state FROM pipeline_runs WHERE id=?').get(created.runId).state, 'CANCELLED');
  // A glrt- evidence credential never reaches the pipeline coordinator.
  await assert.rejects(call('/api/v4/jobs/request', 'POST', { token: 'glrt-' + crypto.randomUUID() + '_' + 'a'.repeat(64), system_id: 's_12345678', info: { version: '18.5.0', executor: 'docker' } }, json), /Runner|authority|credential/i);
  // Pipelines off: the pipeline coordinator answers nothing.
  f.env.PIPELINES_ENABLED = 'false';
  assert.equal((await call('/api/v4/jobs/request', 'POST', { token: runner.token }, json)).status, 404);
});
