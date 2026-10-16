import { test } from 'node:test';
import assert from 'node:assert/strict';
import { landOutcome } from '../src/landOutcomes.ts';
import { isAgentBranch, patternMatches } from '../src/agentBranches.ts';
import type { LandOperation } from '../src/agenticMode';

const op = (state: LandOperation['state'], detail: LandOperation['detail'] = {}): LandOperation => ({ id: 'op', repositoryId: '1', pullRequestId: '9', number: 4, trigger: 'person', actorId: '2', actor: 'bob', state, method: 'merge',
  headCommitId: 'a'.repeat(40), baseCommitId: 'b'.repeat(40), landedCommitId: state === 'LANDED' ? 'c'.repeat(40) : '', revertCommitId: '', attempts: 1, createdAt: '', updatedAt: '', detail });
const error = (message: string, httpStatus?: number) => Object.assign(new Error(message), { httpStatus });

test('each land request of a batch is reported as the land queue answered it', () => {
  assert.deepEqual(landOutcome(4, { operation: op('LANDED'), phase: 'LANDED' }), { number: 4, kind: 'landed', text: 'Landed as cccccccccccc.' });
  assert.equal(landOutcome(4, { operation: op('LANDING', { reasons: ['the merge was sent but its outcome is not confirmed yet'] }), phase: 'LANDING' }).kind, 'queued');
  const rebase = landOutcome(4, { operation: op('NEEDS_REBASE', { conflicts: [{ path: 'src/a.ts', reason: 'both_modified' }], conflictCount: 3 }), phase: 'LAND_REFUSED' });
  assert.deepEqual([rebase.kind, rebase.text], ['needs_rebase', 'Needs a rebase: conflicts with the base branch in src/a.ts and 2 more.']);
  assert.deepEqual(landOutcome(4, { operation: op('BLOCKED', { reasons: ['the head moved to 0123456789ab after landing was requested'] }), phase: 'LAND_REFUSED' }),
    { number: 4, kind: 'blocked', text: 'Blocked: the head moved to 0123456789ab after landing was requested' });
  assert.equal(landOutcome(4, { operation: op('FAILED', { reasons: ['gave up'] }), phase: 'LAND_REFUSED' }).kind, 'failed');
  // A refusal before anything was recorded names the Worker's reason; no answer at all is unknown, never a success.
  assert.deepEqual(landOutcome(4, undefined, error('The pull request head moved to 0123456789ab.', 412)), { number: 4, kind: 'refused', text: 'Refused: The pull request head moved to 0123456789ab.' });
  assert.equal(landOutcome(4, undefined, error('Failed to fetch')).kind, 'unknown');
  assert.equal(landOutcome(4, undefined, error('Unavailable', 503)).kind, 'unknown');
});

test('agent branches match the Worker: golf-agent/* and token patterns, never * or the default branch', () => {
  assert.equal(patternMatches('golf-agent/*', 'golf-agent/1a2b3c4d'), true);
  assert.equal(patternMatches('*', 'main'), false);
  assert.equal(patternMatches('agent/fix', 'agent/fix-2'), false);
  assert.equal(isAgentBranch(['golf-agent/*', 'agent/*'], 'agent/x', 'main'), true);
  assert.equal(isAgentBranch(['golf-agent/*', 'main'], 'main', 'main'), false);
  assert.equal(isAgentBranch(['golf-agent/*'], 'feature', 'main'), false);
});
