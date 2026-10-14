import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { RepositoryActivity, activityFrame, activityInput, activityPath, activitySelection } from './src/activity.mjs';
import { Fault } from './src/common.mjs';
import { createClient, Code } from '../../web/node_modules/@connectrpc/connect/dist/esm/index.js';
import { createConnectTransport } from '../../web/node_modules/@connectrpc/connect-web/dist/esm/index.js';
import * as esbuild from '../agents/node_modules/esbuild/lib/main.js';
const generated = await esbuild.build({ stdin: { contents: "export { RepositoryActivityService } from './web/src/gen/golf/v1/golf_pb.ts'", resolveDir: process.cwd() }, bundle: true, write: false, format: 'esm', platform: 'neutral' });
const { RepositoryActivityService } = await import('data:text/javascript;base64,' + Buffer.from(generated.outputFiles[0].text).toString('base64'));

function fixture(t, options) {
  const sql = new DatabaseSync(':memory:'); t.after(() => sql.close());
  const storage = { sql: { exec(query, ...values) { const statement = sql.prepare(query); if (statement.columns().length) return statement.all(...values); statement.run(...values); return []; } },
    transactionSync(action) { sql.exec('BEGIN'); try { action(); sql.exec('COMMIT'); } catch (error) { sql.exec('ROLLBACK'); throw error; } } };
  const state = { allowed: true, user: '1', reads: 0 };
  const authorize = async () => { state.reads++; if (!state.allowed) throw new Fault('not_found', 404, 'Repository unavailable.'); return state.user; };
  const activity = new RepositoryActivity(storage, authorize, { heartbeat: 10, duration: 1000, ...options });
  return { activity, storage, state, authorize };
}
const input = (repositoryId = '1', cursor = '') => ({ repository: { owner: 'alice', name: 'repo' }, repositoryId, cursor });
const request = (value = input(), signal) => new Request('https://golf.example.com' + activityPath, {
  method: 'POST', headers: { 'Content-Type': 'application/connect+json' }, body: activityFrame(value), signal,
});
const decode = frame => JSON.parse(new TextDecoder().decode(frame.subarray(5)));

for (const useBinaryFormat of [false, true]) test(`generated Connect ${useBinaryFormat ? 'protobuf' : 'JSON'} client receives changes and immediate revocation`, async t => {
  const f = fixture(t);
  const client = createClient(RepositoryActivityService, createConnectTransport({ baseUrl: 'https://golf.example.com/rpc', useBinaryFormat,
    fetch: (url, init) => f.activity.watch(new Request(url, init)) }));
  const stream = client.watchRepository(input())[Symbol.asyncIterator]();
  assert.equal((await stream.next()).value.kind, 'reset');
  const pending = stream.next(); f.activity.publish('1', ['issues', 'issues']);
  const change = (await pending).value;
  assert.equal(change.kind, 'change'); assert.deepEqual(change.topics, ['issues']); assert.equal(change.cursor, '1');
  f.state.allowed = false;
  await assert.rejects(stream.next(), error => error.code === Code.NotFound);
  assert.equal(f.activity.total, 0); assert.equal(f.activity.listeners.size, 0);
});

test('durable cursors resume across restart, reject foreign identities and reset compacted history without rewinding', t => {
  const f = fixture(t);
  f.activity.publish('1', ['source']); const original = f.activity.observation('1', '').cursor;
  f.activity.publish('2', ['issues']);
  assert.throws(() => f.activity.observation('1', '2'), /another repository/);
  assert.throws(() => f.activity.observation('1', '100'), /ahead/);
  const restarted = new RepositoryActivity(f.storage, f.authorize);
  restarted.publish('1', ['actions']);
  assert.deepEqual(restarted.observation('1', original).topics, ['actions']);
  for (let i = 0; i < 1050; i++) restarted.publish('2', ['issues']);
  assert.equal(restarted.observation('1', '3').kind, 'heartbeat');
  assert.equal(restarted.observation('1', original).kind, 'reset');
  assert.equal(restarted.observation('1', original).cursor, '3');
  assert.ok([...f.storage.sql.exec('SELECT count(*) AS total FROM repository_activity')][0].total <= 1026);
});

test('admission, cancellation and unread-client lease retirement release every connection', async t => {
  const f = fixture(t, { duration: 30 });
  const responses = await Promise.all(Array.from({ length: 4 }, () => f.activity.watch(request())));
  await assert.rejects(f.activity.watch(request()), error => error.code === 'resource_exhausted');
  for (const response of responses) await response.body.cancel();
  assert.equal(f.activity.total, 0);
  const unread = await f.activity.watch(request());
  await new Promise(resolve => setTimeout(resolve, 60));
  assert.equal(f.activity.total, 0);
  assert.equal(decode((await unread.body.getReader().read()).value).error.code, 'deadline_exceeded');
  const controller = new AbortController(), stream = await f.activity.watch(request(input(), controller.signal)), reader = stream.body.getReader();
  await reader.read(); const pending = reader.read(); controller.abort();
  assert.equal((await pending).done, true); assert.equal(f.activity.total, 0);
});

test('heartbeats recheck identity, slow consumers do not accumulate frames, and graceful rotation ends Connect', async t => {
  const f = fixture(t, { duration: 15 });
  const response = await f.activity.watch(request()), reader = response.body.getReader();
  assert.equal(decode((await reader.read()).value).kind, 'reset');
  for (let i = 0; i < 20; i++) f.activity.publish('1', ['source']);
  assert.equal(f.state.reads, 2);
  assert.equal(decode((await reader.read()).value).kind, 'change');
  await new Promise(resolve => setTimeout(resolve, 17));
  const rotation = await reader.read();
  if (!decode(rotation.value).error) {
    assert.equal(decode(rotation.value).kind, 'reconnect'); assert.equal((await reader.read()).value[0], 2);
  }
  assert.equal(f.activity.total, 0);
  const active = fixture(t), stream = await active.activity.watch(request()), next = stream.body.getReader();
  await next.read(); active.state.user = '2';
  assert.equal(decode((await next.read()).value).error.code, 'unauthenticated'); assert.equal(active.activity.total, 0);
});

test('request grammar rejects compression, truncated or multiple frames and invalid cursors before authorization', async t => {
  const f = fixture(t);
  for (const body of [new Uint8Array([0]), new Uint8Array([1, 0, 0, 0, 0]), new Uint8Array([...activityFrame(input()), ...activityFrame(input())])]) {
    await assert.rejects(activityInput(new Request('https://golf.example.com' + activityPath, { method: 'POST', headers: { 'Content-Type': 'application/connect+json' }, body })), error => error.code === 'invalid_argument');
  }
  for (const value of [input('01'), input('1', '-1'), input('1', '9223372036854775808'), { ...input(), repositoryId: 1 }]) await assert.rejects(f.activity.watch(request(value)), error => error.code === 'invalid_argument');
  assert.equal(f.state.reads, 0);
});

test('mutation notices target issue versus PR discussions, and pure observations never publish feedback events', async () => {
  const write = (path, body) => new Request('https://golf.example.com' + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  for (const pullRequest of [false, true]) {
    const result = await activitySelection(write('/rpc/golf.v1.RepositoryService/CreateIssueComment', { ...input(), pullRequest }));
    assert.deepEqual(result.topics, [pullRequest ? 'pulls' : 'issues']); assert.equal(result.id, '1'); assert.equal(result.name, 'repo');
  }
  for (const method of ['SetRepositoryCollaborator', 'RemoveRepositoryCollaborator']) assert.deepEqual((await activitySelection(write('/rpc/golf.v1.RepositoryAccessService/' + method, input()))).topics, ['source', 'issues', 'pulls', 'actions', 'agents']);
  for (const method of ['GetRepositoryAccess', 'ListRepositoryCollaborators', 'ResolveRepositoryCollaborator', 'GetRepositoryAccessOperation']) assert.equal(await activitySelection(write('/rpc/golf.v1.RepositoryAccessService/' + method, input())), undefined);
  for (const method of ['CreateRepositoryInvitation', 'RevokeRepositoryInvitation', 'RespondRepositoryInvitation']) {
    const selected = await activitySelection(write('/rpc/golf.v1.RepositoryInvitationService/' + method, { ...input(), invitationId: 'original' }));
    assert.deepEqual(selected.topics, ['source', 'issues', 'pulls', 'actions', 'agents']);
    if (method.startsWith('Respond')) assert.equal(selected.invitation, 'original');
  }
  assert.deepEqual((await activitySelection(write('/rpc/golf.v1.RepositoryService/SubmitDiscussionResourceOperation', input()))).topics, ['issues', 'pulls']);
  assert.deepEqual((await activitySelection(write('/rpc/golf.v1.RepositoryService/UpdatePullRequest', input()))).topics, ['pulls']);
  // A native merge moves the base branch like a push; inspecting its receipt publishes nothing.
  const merge = await activitySelection(write('/rpc/golf.v1.StandardPullMergeService/SubmitStandardPullMerge', { selection: input() }));
  assert.deepEqual(merge.topics, ['source', 'pulls', 'actions']); assert.equal(merge.id, '1'); assert.equal(merge.name, 'repo');
  assert.equal(await activitySelection(write('/rpc/golf.v1.StandardPullMergeService/GetStandardPullMergeOperation', input())), undefined);
  for (const action of ['list', 'status', 'report', 'compare']) assert.equal(await activitySelection(write('/native/pr-evidence', { ...input(), action })), undefined);
  for (const action of ['list', 'grant', 'screenshot']) assert.equal(await activitySelection(write('/native/pr-preview', { ...input(), action })), undefined);
  assert.equal(await activitySelection(write(activityPath, input())), undefined);
  assert.deepEqual((await activitySelection(new Request('https://golf.example.com/git/alice/repo.git/git-receive-pack', { method: 'POST', body: '' }))).topics, ['source', 'pulls', 'actions']);
});

test('mutation selection re-reads an ordinary body under the unchanged 96 KiB bound', async () => {
  const write = size => new Request('https://golf.example.com/rpc/golf.v1.RepositoryService/CreateIssue', { method: 'POST', body: JSON.stringify({ ...input(), body: 'x'.repeat(size) }) });
  assert.deepEqual(await activitySelection(write(90 * 1024)), { name: 'repo', id: '1', topics: ['issues'] });
  // Node settles a cancelled clone branch only once its sibling is released; workerd settles it at once.
  const oversized = write(300 * 1024), selection = activitySelection(oversized);
  await oversized.body.cancel();
  assert.equal(await selection, undefined);
});
