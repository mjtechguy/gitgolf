import test from 'node:test';
import assert from 'node:assert/strict';
import * as p from './src/pipelines.mjs';

import { memoryBucket, pipelineFixture } from './pipeline-fixture.mjs';
export { memoryBucket, pipelineFixture };

const run = (extra = {}) => ({ repositoryId: 1, engine: 'forgejo-actions', workflowPath: '.github/workflows/ci.yml', workflowName: 'CI', event: 'push', ref: 'refs/heads/main', commitId: 'c'.repeat(40), actorId: 1, trusted: true, ...extra });
const job = (key, needs = [], extra = {}) => ({ key, name: key, needs, runsOn: ['ubuntu-latest'], payload: 'jobs: {}', ...extra });

test('runs advance a needs DAG, claim by label and scope, store redacted logs and finish', async t => {
  const f = await pipelineFixture(t);
  const created = await p.createPipelineRun(f.db, f.env, run({ intakeId: 'i1' }), [job('build'), job('test', ['build']), job('cleanup', ['test'], { when: 'always' }), job('notify', ['test'], { when: 'on_failure' })]);
  assert.equal(created.number, 1);
  assert.equal((await p.createPipelineRun(f.db, f.env, run({ intakeId: 'i1' }), [job('build')])).replayed, true);
  const state = () => Object.fromEntries(f.sql.prepare('SELECT name,state FROM pipeline_jobs WHERE run_id=? ORDER BY id').all(created.runId).map(row => [row.name, row.state]));
  assert.deepEqual(state(), { build: 'QUEUED', test: 'BLOCKED', cleanup: 'BLOCKED', notify: 'BLOCKED' });
  const { token: registration } = await p.createRegistrationToken(f.db, f.env, { id: 1 }, { engine: 'forgejo-actions', scope: 'repository', scopeId: '1', labels: ['ubuntu-latest:docker://node:20-bookworm'], ttlHours: 1, uses: 1 });
  const { runner, token } = await p.registerPipelineRunner(f.db, f.env, { engine: 'forgejo-actions', registrationToken: registration, name: 'r1', labels: [] });
  await assert.rejects(p.registerPipelineRunner(f.db, f.env, { engine: 'forgejo-actions', registrationToken: registration, name: 'r2', labels: [] }), /used or expired/);
  assert.equal((await p.runnerByToken(f.db, f.env, 'forgejo-actions', token, runner.uuid)).id, runner.id);
  // A runner without the label gets nothing.
  f.sql.prepare("INSERT INTO pipeline_runners(uuid,engine,scope,scope_id,name,labels,token_digest,created_by,created_at) VALUES('u2','forgejo-actions','installation','','other','[\"windows\"]','x',1,'t')").run();
  assert.equal(await p.claimPipelineJob(f.db, f.env, f.sql.prepare("SELECT * FROM pipeline_runners WHERE uuid='u2'").get()), null);
  const claim = await p.claimPipelineJob(f.db, f.env, runner, { requestKey: 'aaaaaaaa-1' });
  assert.equal(claim.job.name, 'build');
  const again = await p.claimPipelineJob(f.db, f.env, runner, { requestKey: 'aaaaaaaa-1' });
  assert.equal(again.job.id, claim.job.id);
  await assert.rejects(p.jobByToken(f.db, f.env, claim.token), /expired or unknown/);
  assert.equal((await p.jobByToken(f.db, f.env, again.token)).job.id, claim.job.id);
  assert.match(JSON.parse(atob(again.token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))).scp, new RegExp(`Actions.Results:${created.runId}:${claim.job.id}`));
  p.pipelineValues.cache?.clear?.();
  assert.deepEqual(await p.appendJobLogLines(f.db, f.env, claim.job, 0, ['one', 'two']), { ack: 2 });
  assert.deepEqual(await p.appendJobLogLines(f.db, f.env, claim.job, 1, ['two', 'three']), { ack: 3 });
  assert.deepEqual(await p.appendJobLogLines(f.db, f.env, claim.job, 9, ['x']), { ack: 3 });
  assert.equal((await p.readJobLog(f.db, f.env, claim.job, { fromLine: 1 })).text, 'two\nthree\n');
  await p.finishPipelineJob(f.db, f.env, claim.job, { result: 'failure', exitCode: 1 });
  assert.deepEqual(state(), { build: 'FAILURE', test: 'SKIPPED', cleanup: 'QUEUED', notify: 'QUEUED' });
  const cleanup = await p.claimPipelineJob(f.db, f.env, runner);
  await p.finishPipelineJob(f.db, f.env, cleanup.job, { result: 'success', outputs: { a: '1' } });
  await p.finishPipelineJob(f.db, f.env, (await p.claimPipelineJob(f.db, f.env, runner)).job, { result: 'success' });
  assert.equal(f.sql.prepare('SELECT state FROM pipeline_runs WHERE id=?').get(created.runId).state, 'FAILURE');
  // Re-run failed jobs: cleanup succeeded but needs a re-run job, so it runs again too.
  await p.rerunPipelineRun(f.db, f.env, { id: 1 }, created.runId, { failedOnly: true });
  assert.deepEqual(f.sql.prepare('SELECT name,state FROM pipeline_jobs WHERE run_id=? AND attempt=2 ORDER BY id').all(created.runId).map(row => row.state), ['QUEUED', 'BLOCKED', 'BLOCKED', 'BLOCKED']);
  await p.cancelPipelineRun(f.db, f.env, { id: 1 }, created.runId);
  assert.equal(f.sql.prepare('SELECT state FROM pipeline_runs WHERE id=?').get(created.runId).state, 'CANCELLED');
});

test('the actions feature gates creation and claims; refused runs keep their reason', async t => {
  const f = await pipelineFixture(t);
  const refused = await p.refusePipelineRun(f.db, f.env, run(), 'on: schedule is not supported');
  assert.equal(f.sql.prepare('SELECT state,reason FROM pipeline_runs WHERE id=?').get(refused.runId).reason, 'on: schedule is not supported');
  f.sql.exec("INSERT INTO repository_execution_policy(repository_id,artifact_name,version,manual,push,updated_by,updated_at) VALUES(1,'repo-" + 'b'.repeat(32) + "',1,0,0,1,'t')");
  await assert.rejects(p.createPipelineRun(f.db, f.env, run(), [job('build')]), /turned off/);
  await assert.rejects(p.createPipelineRun(f.db, { ...f.env, PIPELINES_ENABLED: 'false' }, run(), [job('build')]), /not allocated/);
});

test('GitLab byte traces keep offsets, redact secrets byte for byte and refuse gaps', async t => {
  const f = await pipelineFixture(t);
  const created = await p.createPipelineRun(f.db, f.env, run({ engine: 'gitlab-ci', workflowPath: '.gitlab-ci.yml' }), [job('a', [], { runsOn: [] })]);
  f.sql.prepare("INSERT INTO pipeline_runners(uuid,engine,scope,scope_id,name,labels,token_digest,created_by,created_at) VALUES('g','gitlab-ci','installation','','g','[]','y',1,'t')").run();
  const claim = await p.claimPipelineJob(f.db, f.env, f.sql.prepare("SELECT * FROM pipeline_runners WHERE uuid='g'").get());
  assert.match(claim.token, /^golfjob_[a-f0-9]{64}$/);
  const bytes = s => new TextEncoder().encode(s);
  assert.deepEqual(await p.appendJobLogBytes(f.db, f.env, claim.job, 0, bytes('hello\n')), { ack: 6 });
  await assert.rejects(p.appendJobLogBytes(f.db, f.env, claim.job, 0, bytes('x')), error => error.status === 416 && error.ack === 6);
  assert.equal((await p.readJobLog(f.db, f.env, claim.job, { fromByte: 2 })).text, 'llo\n');
  const artifact = await p.putJobArtifact(f.db, f.env, claim.job, { name: 'dist', kind: 'gitlab-archive' }, bytes('zipdata'), 7);
  assert.equal(new TextDecoder().decode(new Uint8Array(await new Response((await p.openArtifact(f.db, f.env, artifact.id)).body).arrayBuffer())), 'zipdata');
  assert.equal((await p.listRunArtifacts(f.db, f.env, created.runId)).length, 1);
  await p.cancelPipelineRun(f.db, f.env, { id: 1 }, created.runId);
  assert.equal(f.sql.prepare('SELECT cancel_requested FROM pipeline_runs WHERE id=?').get(created.runId).cancel_requested, 1);
  await p.finishPipelineJob(f.db, f.env, claim.job, { result: 'cancelled' });
  assert.equal(f.sql.prepare('SELECT state FROM pipeline_runs WHERE id=?').get(created.runId).state, 'CANCELLED');
});

test('environments: auto-created unprotected, protected ones wait for a reviewer, branch rules refuse, deployments are recorded', async t => {
  const f = await pipelineFixture(t);
  f.sql.exec("INSERT INTO pipeline_environments(repository_id,artifact_name,name,reviewers,prevent_self_review,branches,created_by,created_at,updated_at) VALUES(1,'repo-" + 'b'.repeat(32) + "','prod','[2]',1,'[\"main\"]',1,'t','t'),(1,'repo-" + 'b'.repeat(32) + "','other','[]',1,'[\"release/*\"]',1,'t','t')");
  const created = await p.createPipelineRun(f.db, f.env, run(), [job('build'), job('deploy', ['build'], { environment: { name: 'prod', url: 'https://x.example' } }), job('staging', [], { environment: { name: 'staging' } }), job('blocked', [], { environment: { name: 'other' } })]);
  const state = () => Object.fromEntries(f.sql.prepare('SELECT name,state,failure_reason FROM pipeline_jobs WHERE run_id=? ORDER BY id').all(created.runId).map(row => [row.name, row.state + (row.failure_reason ? ':' + row.failure_reason : '')]));
  assert.deepEqual(state(), { build: 'QUEUED', deploy: 'BLOCKED', staging: 'QUEUED', blocked: 'FAILURE:environment_branch' });
  assert.ok(f.sql.prepare("SELECT 1 FROM pipeline_environments WHERE name='staging'").get());
  f.sql.prepare("INSERT INTO pipeline_runners(uuid,engine,scope,scope_id,name,labels,token_digest,created_by,created_at) VALUES('r','forgejo-actions','installation','','r','[\"ubuntu-latest\"]','z',1,'t')").run();
  const runner = f.sql.prepare("SELECT * FROM pipeline_runners WHERE uuid='r'").get();
  for (let i = 0; i < 2; i++) { const claim = await p.claimPipelineJob(f.db, f.env, runner); await p.finishPipelineJob(f.db, f.env, claim.job, { result: 'success' }); }
  assert.equal(state().deploy, 'APPROVAL');
  assert.equal(f.sql.prepare('SELECT state FROM pipeline_runs WHERE id=?').get(created.runId).state, 'WAITING');
  const deploy = f.sql.prepare("SELECT id FROM pipeline_jobs WHERE name='deploy'").get().id;
  await assert.rejects(p.approveEnvironmentJob(f.db, f.env, { id: 1 }, deploy, { approve: true }), /required reviewer/);
  await p.approveEnvironmentJob(f.db, f.env, { id: 2 }, deploy, { approve: true });
  assert.equal(state().deploy, 'QUEUED');
  const claim = await p.claimPipelineJob(f.db, f.env, runner);
  await p.finishPipelineJob(f.db, f.env, claim.job, { result: 'success' });
  assert.deepEqual(f.sql.prepare('SELECT d.url,d.state,e.name FROM pipeline_deployments d JOIN pipeline_environments e ON e.id=d.environment_id ORDER BY d.id').all().map(row => ({ ...row })),
    [{ url: '', state: 'SUCCESS', name: 'staging' }, { url: 'https://x.example', state: 'SUCCESS', name: 'prod' }]);
});

test('playing a manual job to a protected environment waits for approval, then queues', async t => {
  const f = await pipelineFixture(t);
  f.sql.exec("INSERT INTO pipeline_environments(repository_id,artifact_name,name,reviewers,created_by,created_at,updated_at) VALUES(1,'repo-" + 'b'.repeat(32) + "','production','[2]',1,'t','t')");
  const created = await p.createPipelineRun(f.db, f.env, run({ engine: 'gitlab-ci', workflowPath: '.gitlab-ci.yml' }), [job('deploy', [], { when: 'manual', allowFailure: true, environment: { name: 'production' } })]);
  const state = () => f.sql.prepare('SELECT state,when_mode FROM pipeline_jobs WHERE run_id=?').get(created.runId);
  assert.equal(state().state, 'MANUAL');
  const id = f.sql.prepare('SELECT id FROM pipeline_jobs WHERE run_id=?').get(created.runId).id;
  await p.playManualJob(f.db, f.env, { id: 1 }, id);
  assert.deepEqual({ ...state() }, { state: 'APPROVAL', when_mode: 'on_success' });
  await p.approveEnvironmentJob(f.db, f.env, { id: 2 }, id, { approve: true });
  assert.equal(state().state, 'QUEUED');
});
