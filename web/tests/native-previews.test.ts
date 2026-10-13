import { test } from 'node:test';
import assert from 'node:assert/strict';
import { currentPullPreviews } from '../src/nativePreviews.ts';

const now = Date.now(), commit = 'a'.repeat(40);
const job = { id: 'job', stale: false, testState: 'PASSED', selection: { headCommitId: commit } };
const preview = { id: 'preview', jobId: job.id, commitId: commit, kind: 'STATIC', state: 'READY', purged: false, expiresAt: new Date(now + 60000).toISOString() };

test('the PR card shows the newest ready deployment of each kind for its current tested commit', () => {
  const rows = [preview, { ...preview, id: 'older' }, { ...preview, id: 'app', kind: 'WORKER' }];
  assert.deepEqual(currentPullPreviews(rows, [job], commit, now).map(p => p.id), ['preview', 'app']);
  assert.deepEqual(currentPullPreviews(rows, [job], 'b'.repeat(40), now), []);
});

test('failed, stale, unconfirmed and expired deployments never become current preview links', () => {
  for (const change of [{ state: 'PUBLISHING' }, { state: 'REVOKED' }, { purged: true }, { jobId: 'other-pr' }, { expiresAt: new Date(now).toISOString() }, { expiresAt: 'invalid' }])
    assert.deepEqual(currentPullPreviews([{ ...preview, ...change }], [job], commit, now), []);
  for (const change of [{ stale: true }, { testState: 'FAILED' }, { selection: { headCommitId: 'b'.repeat(40) } }])
    assert.deepEqual(currentPullPreviews([preview], [{ ...job, ...change }], commit, now), []);
});
