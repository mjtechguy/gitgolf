import test from 'node:test';
import assert from 'node:assert/strict';
import { encode, decode, Struct } from './src/protobuf.mjs';
import { forgejoRunner, actionsGit } from './src/forgejo-runner.mjs';
import { actionsArtifacts, artifactBase } from './src/actions-artifacts.mjs';
import * as p from './src/pipelines.mjs';
import { pipelineFixture } from './pipeline-fixture.mjs';

const Runner = { id: [1, 'int64'], uuid: [2, 'string'], token: [3, 'string'], name: [4, 'string'], labels: [9, 'string', true] };
const Timestamp = { seconds: [1, 'int64'], nanos: [2, 'int32'] };
const StepState = { id: [1, 'int64'], result: [2, 'enum'], started_at: [3, Timestamp], stopped_at: [4, Timestamp], log_index: [5, 'int64'], log_length: [6, 'int64'] };
const TaskState = { id: [1, 'int64'], result: [2, 'enum'], steps: [5, StepState, true] };
const Task = { id: [1, 'int64'], workflow_payload: [2, 'bytes'], context: [3, Struct], secrets: [4, ['map', 'string', 'string']], needs: [6, ['map', 'string', { outputs: [1, ['map', 'string', 'string']], result: [2, 'enum'] }]], vars: [7, ['map', 'string', 'string']] };
const schemas = {
  Register: [{ name: [1, 'string'], token: [2, 'string'], version: [5, 'string'], labels: [6, 'string', true] }, { runner: [1, Runner] }],
  Declare: [{ version: [1, 'string'], labels: [2, 'string', true] }, { runner: [1, Runner] }],
  FetchTask: [{ tasks_version: [1, 'int64'] }, { task: [1, Task], tasks_version: [2, 'int64'] }],
  UpdateLog: [{ task_id: [1, 'int64'], index: [2, 'int64'], rows: [3, { content: [2, 'string'] }, true], no_more: [4, 'bool'] }, { ack_index: [1, 'int64'] }],
  UpdateTask: [{ state: [1, TaskState], outputs: [2, ['map', 'string', 'string']] }, { state: [1, TaskState], sent_outputs: [2, 'string', true] }],
};
const unstruct = value => value.struct_value ? Object.fromEntries(Object.entries(value.struct_value.fields).map(([k, v]) => [k, unstruct(v)])) : value.list_value ? value.list_value.values.map(unstruct) : value.string_value ?? value.number_value ?? value.bool_value ?? null;

test('protobuf: proto3 defaults, maps, nested messages and Struct round-trip', () => {
  const bytes = encode(Task, { id: 7, workflow_payload: new TextEncoder().encode('jobs: {}'), context: { fields: { a: { string_value: 'x' }, n: { number_value: 2 }, b: { bool_value: false } } }, secrets: { K: 'v' } });
  const back = decode(Task, bytes);
  assert.equal(back.id, 7); assert.equal(back.secrets.K, 'v'); assert.equal(unstruct({ struct_value: back.context }).b, false);
  assert.deepEqual(decode(schemas.UpdateLog[0], encode(schemas.UpdateLog[0], { task_id: 3, rows: [{ content: 'x' }] })), { task_id: 3, index: 0, rows: [{ content: 'x' }], no_more: false });
});

test('stock runner protocol: register, declare, fetch a task with context and secrets, logs, outputs, final state; git and artifacts authority', async t => {
  const f = await pipelineFixture(t, { ARTIFACTS: {} });
  const call = async (method, message, headers = {}) => {
    const response = await forgejoRunner(new Request(f.env.PUBLIC_ORIGIN + '/api/actions/runner.v1.RunnerService/' + method, { method: 'POST', headers: { 'Content-Type': 'application/proto', ...headers }, body: encode(schemas[method][0], message) }), f.env);
    if (!response.ok) return { status: response.status, error: await response.json() };
    return decode(schemas[method][1], new Uint8Array(await response.arrayBuffer()));
  };
  assert.equal((await call('Register', { name: 'r', token: 'golfreg_' + '0'.repeat(64) })).status, 403);
  const { token } = await p.createRegistrationToken(f.db, f.env, { id: 1 }, { engine: 'forgejo-actions', scope: 'installation', scopeId: '' });
  const { runner } = await call('Register', { name: 'local', token, version: 'v13.2.0', labels: ['ubuntu-latest:docker://node:20'] });
  assert.ok(runner.uuid && runner.token);
  const auth = { 'x-runner-uuid': runner.uuid, 'x-runner-token': runner.token };
  assert.equal((await call('Declare', { version: 'v13.2.0', labels: ['ubuntu-latest:docker://node:22'] }, { ...auth, 'x-runner-token': 'x'.repeat(64) })).status, 401);
  assert.deepEqual((await call('Declare', { version: 'v13.2.0', labels: ['ubuntu-latest:docker://node:22'] }, auth)).runner.labels, ['ubuntu-latest:docker://node:22']);
  assert.equal((await call('FetchTask', {}, auth)).task, undefined);
  const created = await p.createPipelineRun(f.db, f.env, { repositoryId: 1, engine: 'forgejo-actions', workflowPath: '.github/workflows/ci.yml', workflowName: 'CI', event: 'push', ref: 'refs/heads/main', commitId: 'c'.repeat(40), actorId: 1, trusted: true, eventPayload: { ref: 'refs/heads/main' } },
    [{ key: 'build', name: 'build', needs: [], runsOn: ['ubuntu-latest'], payload: 'on: push\njobs:\n  build:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo hi\n' }, { key: 'after', name: 'after', needs: ['build'], runsOn: ['ubuntu-latest'], payload: 'jobs: {}' }]);
  const fetched = await call('FetchTask', {}, { ...auth, 'x-runner-request-key': 'abcdef12-1' });
  const context = unstruct({ struct_value: fetched.task.context });
  assert.equal(context.repository, 'alice/project'); assert.equal(context.run_id, String(created.runId)); assert.equal(context.server_url, f.env.PUBLIC_ORIGIN);
  assert.equal(context.forgejo_default_actions_url, 'https://github.com'); assert.equal(fetched.task.secrets.GITHUB_TOKEN, context.token);
  const jobToken = context.token, jobId = fetched.task.id;
  // Git source: Basic x-access-token, read-only, exact repository.
  const fetchGit = (path, headers) => actionsGit(new Request(f.env.PUBLIC_ORIGIN + path, { headers }), f.env, async () => new Response('advertised'));
  assert.equal((await fetchGit('/alice/project/info/refs?service=git-upload-pack', {})).status, 401);
  assert.equal((await fetchGit('/alice/other/info/refs?service=git-upload-pack', { Authorization: 'basic ' + btoa('x-access-token:' + jobToken) })).status, 404);
  assert.equal(await (await fetchGit('/alice/project.git/info/refs?service=git-upload-pack', { Authorization: 'basic ' + btoa('x-access-token:' + jobToken) })).text(), 'advertised');
  assert.equal((await fetchGit('/alice/project/info/refs?service=git-receive-pack', { Authorization: 'basic ' + btoa('x-access-token:' + jobToken) })).status, 403);
  // Logs: acked indexes, completion.
  assert.equal((await call('UpdateLog', { task_id: jobId, index: 0, rows: [{ content: 'one' }, { content: 'two' }] }, auth)).ack_index, 2);
  assert.equal((await call('UpdateLog', { task_id: jobId, index: 5, rows: [{ content: 'gap' }] }, auth)).ack_index, 2);
  // Artifacts v4: create → block → blocklist → finalize → list → signed download.
  const twirp = (method, body, token = jobToken) => actionsArtifacts(new Request(f.env.PUBLIC_ORIGIN + artifactBase + method, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token }, body: JSON.stringify(body) }), f.env);
  const ids = { workflowRunBackendId: String(created.runId), workflowJobRunBackendId: String(jobId) };
  assert.equal((await twirp('CreateArtifact', { ...ids, name: 'dist', version: 4 }, 'wrong-token-' + 'x'.repeat(20))).status, 401);
  const { signedUploadUrl } = await (await twirp('CreateArtifact', { ...ids, name: 'dist', version: 4 })).json();
  f.env.PIPELINE_BUCKET.head = async key => f.env.PIPELINE_BUCKET.objects.has(key) ? { size: f.env.PIPELINE_BUCKET.objects.get(key).length } : null;
  assert.equal((await actionsArtifacts(new Request(signedUploadUrl + '&comp=block&blockid=YQ', { method: 'PUT', headers: { 'Content-Length': '3' }, body: 'zip' }), f.env)).status, 201);
  assert.equal((await actionsArtifacts(new Request(signedUploadUrl.replace(/sig=[^&]+/, 'sig=forged') + '&comp=block&blockid=YQ', { method: 'PUT', headers: { 'Content-Length': '3' }, body: 'bad' }), f.env)).status, 401);
  assert.equal((await actionsArtifacts(new Request(signedUploadUrl + '&comp=blocklist', { method: 'PUT', body: '<?xml version="1.0"?><BlockList><Latest>YQ</Latest></BlockList>' }), f.env)).status, 201);
  assert.equal((await (await twirp('FinalizeArtifact', { ...ids, name: 'dist', size: '3', hash: 'sha256:' + 'a'.repeat(64) })).json()).ok, true);
  assert.deepEqual((await (await twirp('ListArtifacts', { ...ids })).json()).artifacts.map(a => [a.name, a.size]), [['dist', '3']]);
  const { signedUrl } = await (await twirp('GetSignedArtifactURL', { ...ids, name: 'dist' })).json();
  assert.equal(await (await actionsArtifacts(new Request(signedUrl), f.env)).text(), 'zip');
  // Outputs and the final state; the dependent job becomes available with needs outputs.
  const updated = await call('UpdateTask', { state: { id: jobId, result: 1, steps: [{ id: 0, result: 1, log_index: 0, log_length: 2 }] }, outputs: { greeting: 'hi' } }, auth);
  assert.equal(updated.state.result, 1); assert.deepEqual(updated.sent_outputs, ['greeting']);
  assert.equal(f.sql.prepare("SELECT state FROM pipeline_steps WHERE job_id=?").get(jobId).state, 'SUCCESS');
  assert.equal((await fetchGit('/alice/project/info/refs?service=git-upload-pack', { Authorization: 'basic ' + btoa('x-access-token:' + jobToken) })).status, 401);
  const next = await call('FetchTask', {}, auth);
  assert.deepEqual(next.task.needs.build, { outputs: { greeting: 'hi' }, result: 1 });
  // Cancellation reaches a running task through its next update.
  await p.cancelPipelineRun(f.db, f.env, { id: 1 }, created.runId);
  assert.equal((await call('UpdateTask', { state: { id: next.task.id } }, auth)).state.result, 3);
});
