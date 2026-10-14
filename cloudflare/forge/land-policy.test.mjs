import test from 'node:test';
import assert from 'node:assert/strict';
import { globMatch, globError, evaluateLanding, normalizeSettings, requiredCheckStates, defaultAgenticSettings } from './src/land-policy.mjs';

test('glob: literal segments are anchored at both ends and case-sensitive', () => {
  assert.equal(globMatch('README.md', 'README.md'), true);
  assert.equal(globMatch('README.md', 'docs/README.md'), false);
  assert.equal(globMatch('docs', 'docs/a.md'), false);
  assert.equal(globMatch('docs/a.md', 'docs'), false);
  assert.equal(globMatch('readme.md', 'README.md'), false);
  assert.equal(globMatch('.gitlab-ci.yml', '.gitlab-ci.yml'), true);
  assert.equal(globMatch('.gitlab-ci.yml', 'sub/.gitlab-ci.yml'), false);
});

test('glob: * and ? stay inside one segment', () => {
  assert.equal(globMatch('*.md', 'a.md'), true);
  assert.equal(globMatch('*.md', '.md'), true);
  assert.equal(globMatch('*.md', 'docs/a.md'), false);
  assert.equal(globMatch('docs/*', 'docs/a'), true);
  assert.equal(globMatch('docs/*', 'docs/a/b'), false);
  assert.equal(globMatch('docs/*', 'docs'), false);
  assert.equal(globMatch('a?c', 'abc'), true);
  assert.equal(globMatch('a?c', 'ac'), false);
  assert.equal(globMatch('a?c', 'a/c'), false);
  assert.equal(globMatch('*', '.env'), true);
  assert.equal(globMatch('*_test.go', 'x_test.go'), true);
  assert.equal(globMatch('**/*.test.*', 'src/a.test.mjs'), true);
  assert.equal(globMatch('**/*.test.*', 'src/a.test'), false);
  assert.equal(globMatch('a*b*c', 'aXbYbZc'), true);
  assert.equal(globMatch('a*b*c', 'aXbYbZ'), false);
  assert.equal(globMatch('a**b', 'aXXb'), true, '** inside a segment behaves like *');
  assert.equal(globMatch('a**b', 'aX/Xb'), false);
});

test('glob: ** matches zero or more whole segments', () => {
  assert.equal(globMatch('docs/**', 'docs/a.md'), true);
  assert.equal(globMatch('docs/**', 'docs/x/y/z.txt'), true);
  assert.equal(globMatch('docs/**', 'docs'), true);
  assert.equal(globMatch('docs/**', 'docsx/a'), false);
  assert.equal(globMatch('**/*.md', 'a.md'), true);
  assert.equal(globMatch('**/*.md', 'x/y/a.md'), true);
  assert.equal(globMatch('**/*.md', 'x/y/a.mdx'), false);
  assert.equal(globMatch('**/CODEOWNERS', 'CODEOWNERS'), true);
  assert.equal(globMatch('**/CODEOWNERS', '.github/CODEOWNERS'), true);
  assert.equal(globMatch('**/CODEOWNERS', '.github/CODEOWNERS.bak'), false);
  assert.equal(globMatch('**/auth/**', 'src/auth/login.go'), true);
  assert.equal(globMatch('**/auth/**', 'auth/x'), true);
  assert.equal(globMatch('**/auth/**', 'src/oauth/x'), false);
  assert.equal(globMatch('a/**/b', 'a/b'), true);
  assert.equal(globMatch('a/**/b', 'a/x/y/b'), true);
  assert.equal(globMatch('a/**/b', 'a/x/y/c'), false);
  assert.equal(globMatch('**', 'anything/at/all'), true);
  assert.equal(globMatch('**/**/x', 'x'), true);
});

test('glob: regular-expression and special characters are literal', () => {
  for (const [pattern, path] of [['a.b', 'a.b'], ['(x)+', '(x)+'], ['[ab]', '[ab]'], ['a|b', 'a|b'], ['^$', '^$'], ['{a,b}', '{a,b}'], ['a+b', 'a+b']]) assert.equal(globMatch(pattern, path), true, pattern);
  assert.equal(globMatch('a.b', 'axb'), false);
  assert.equal(globMatch('[ab]', 'a'), false);
  assert.equal(globMatch('{a,b}', 'a'), false);
  assert.equal(globMatch('(.*)', 'anything'), false);
});

test('glob: pathological patterns stay fast', () => {
  const pattern = Array(20).fill('**').join('/') + '/z', path = Array(200).fill('a').join('/');
  const started = performance.now();
  assert.equal(globMatch(pattern, path), false);
  assert.equal(globMatch('*a*a*a*a*a*a*a*a*a*a*b', 'a'.repeat(190)), false);
  assert.ok(performance.now() - started < 1000);
});

test('glob: invalid patterns are named and never match', () => {
  for (const pattern of ['', '/abs', 'trailing/', 'a//b', './a', 'a/../b', 'a\\b', 'tab\there', 'x'.repeat(201), 3, null]) {
    assert.ok(globError(pattern), String(pattern));
    assert.equal(globMatch(pattern, 'a/b'), false);
  }
  assert.equal(globError('x'.repeat(200)), '');
  assert.equal(globMatch('a', ''), false);
});

const on = (extra = {}) => ({ ...defaultAgenticSettings, enabled: true, ...extra });
const paths = (...names) => names.map(path => ({ path, change: 'modified' }));
const ok = [{ name: 'ci', state: 'success' }];
const approval = { state: 'APPROVED', reviewerIsWriter: true, reviewerIsAuthor: false, reviewerIsAgent: false };
const evaluate = input => evaluateLanding({ settings: on(), changedPaths: paths('docs/a.md'), authorKind: 'agent', checks: ok, reviews: [], draft: false, ...input });

test('defaults: absent settings are agentic mode off with the documented paths', () => {
  assert.deepEqual(normalizeSettings(undefined), { enabled: false, lowRiskPaths: ['docs/**', '**/*.md'], sensitivePaths: ['.github/**', '.forgejo/**', '.gitlab-ci.yml', 'deploy/**', '**/CODEOWNERS'], landWithoutPerson: false, requiredChecks: [], revertOnFailure: true });
  const off = evaluateLanding({ changedPaths: paths('docs/a.md'), checks: ok, reviews: [approval] });
  assert.deepEqual(off, { decision: 'needs_person', reasons: ['agentic mode off'], risk: 'low', matched: { low: ['docs/a.md'], sensitive: [] } });
});

test('off: every input still needs a person, with the risk reported', () => {
  for (const input of [{}, { reviews: [approval] }, { checks: [{ name: 'ci', state: 'failure' }] }, { mergeable: { ok: false, reason: 'conflict' } }, { draft: true }]) {
    const result = evaluate({ settings: on({ enabled: false, landWithoutPerson: true }), ...input });
    assert.equal(result.decision, 'needs_person'); assert.deepEqual(result.reasons, ['agentic mode off']);
  }
  assert.equal(evaluate({ settings: on({ enabled: false }), changedPaths: paths('.github/workflows/ci.yml') }).risk, 'sensitive');
});

test('risk: sensitive beats low, normal otherwise; matched lists both sides', () => {
  const both = evaluate({ changedPaths: paths('.github/README.md', 'docs/a.md') });
  assert.equal(both.risk, 'sensitive'); assert.deepEqual(both.matched, { low: ['.github/README.md', 'docs/a.md'], sensitive: ['.github/README.md'] });
  assert.equal(evaluate({ changedPaths: paths('docs/a.md', 'src/x.js') }).risk, 'normal');
  assert.equal(evaluate({ changedPaths: [] }).risk, 'normal');
  assert.equal(evaluate({ changedPaths: paths('deploy/prod.yaml') }).risk, 'sensitive');
  assert.equal(evaluate({ changedPaths: [{ path: 'docs/a.md', change: 'deleted' }, { path: 'docs/a.md', change: 'added' }] }).matched.low.length, 1);
});

// The truth table for an enabled repository. Columns: risk, landWithoutPerson, checks, review → decision.
const table = [
  ['low', true, 'green', 'none', 'land'],
  ['low', true, 'pending', 'none', 'waiting_checks'],
  ['low', true, 'missing', 'none', 'waiting_checks'],
  ['low', true, 'none', 'none', 'waiting_checks'],
  ['low', true, 'failed', 'none', 'blocked'],
  ['low', false, 'green', 'none', 'needs_person'],
  ['low', false, 'green', 'approved', 'land'],
  ['low', false, 'pending', 'approved', 'waiting_checks'],
  ['low', false, 'none', 'approved', 'land'],
  ['low', true, 'green', 'changes', 'needs_person'],
  ['normal', true, 'green', 'none', 'needs_person'],
  ['normal', true, 'green', 'approved', 'land'],
  ['normal', false, 'failed', 'approved', 'blocked'],
  ['normal', false, 'pending', 'approved', 'waiting_checks'],
  ['normal', false, 'pending', 'none', 'needs_person'],
  ['normal', true, 'green', 'self', 'needs_person'],
  ['normal', true, 'green', 'agent', 'needs_person'],
  ['normal', true, 'green', 'reader', 'needs_person'],
  ['sensitive', true, 'green', 'none', 'needs_person'],
  ['sensitive', true, 'green', 'agent', 'needs_person'],
  ['sensitive', true, 'green', 'self', 'needs_person'],
  ['sensitive', true, 'green', 'approved', 'land'],
  ['sensitive', true, 'pending', 'approved', 'waiting_checks'],
  ['sensitive', true, 'green', 'approved+changes', 'needs_person'],
  ['sensitive', true, 'failed', 'approved', 'blocked'],
];
const riskPaths = { low: paths('docs/guide.md', 'README.md'), normal: paths('src/app.js'), sensitive: paths('.github/workflows/ci.yml', 'docs/a.md') };
const checkSets = { green: [{ name: 'ci', state: 'success' }, { name: 'lint', state: 'skipped' }], pending: [{ name: 'ci', state: 'running' }], failed: [{ name: 'ci', state: 'failure' }], missing: [{ name: 'other', state: 'success', kind: 'reported' }], none: [] };
const reviewSets = { none: [], approved: [approval], changes: [{ ...approval, state: 'CHANGES_REQUESTED' }], 'approved+changes': [approval, { ...approval, state: 'CHANGES_REQUESTED' }],
  self: [{ ...approval, reviewerIsAuthor: true }], agent: [{ ...approval, reviewerIsAgent: true }], reader: [{ ...approval, reviewerIsWriter: false }] };
for (const [risk, landWithoutPerson, checks, review, decision] of table) {
  test(`truth table: ${risk} paths, landWithoutPerson ${landWithoutPerson}, checks ${checks}, review ${review} → ${decision}`, () => {
    const result = evaluate({ settings: on({ landWithoutPerson }), changedPaths: riskPaths[risk], checks: checkSets[checks], reviews: reviewSets[review] });
    assert.equal(result.risk, risk); assert.equal(result.decision, decision, JSON.stringify(result.reasons));
    assert.ok(result.reasons.length > 0);
  });
}

test('reasons name what is missing', () => {
  assert.match(evaluate({ changedPaths: paths('.github/x.yml') }).reasons[0], /sensitive paths need approval from a writer who is not the author and not an agent: \.github\/x\.yml/);
  assert.deepEqual(evaluate({ checks: [{ name: 'ci', state: 'failure' }] }).reasons, ['required check ci failed']);
  assert.deepEqual(evaluate({ settings: on({ landWithoutPerson: true }), checks: [{ name: 'ci', state: 'queued' }] }).reasons, ['required check ci is still running']);
  assert.deepEqual(evaluate({ settings: on({ landWithoutPerson: true }) }).reasons, ['every changed path is low-risk, landing without a person is on and every required check passed (opened by an agent)']);
  assert.deepEqual(evaluate({}).reasons, ['landing without a person is off for this repository']);
  assert.deepEqual(evaluate({ changedPaths: [], reviews: [] }).reasons, ['no changed paths']);
  // Pending checks are listed after the reason a person is needed.
  assert.deepEqual(evaluate({ changedPaths: paths('src/a.js'), checks: [{ name: 'ci', state: 'pending' }] }).reasons, ['changes outside the low-risk paths need approval from a writer who is not the author and not an agent', 'required check ci is still running']);
});

test('drafts and merge observations', () => {
  const draft = evaluate({ settings: on({ landWithoutPerson: true }), draft: true });
  assert.equal(draft.decision, 'needs_person'); assert.deepEqual(draft.reasons, ['the pull request is a draft']);
  assert.equal(evaluate({ reviews: [approval], draft: true }).decision, 'needs_person');
  const conflict = evaluate({ settings: on({ landWithoutPerson: true }), mergeable: { ok: false, reason: 'base_not_ancestor' } });
  assert.deepEqual(conflict, { decision: 'blocked', reasons: ['cannot merge: base_not_ancestor'], risk: 'low', matched: { low: ['docs/a.md'], sensitive: [] } });
  assert.equal(evaluate({ settings: on({ landWithoutPerson: true }), mergeable: { ok: true } }).decision, 'land');
  assert.equal(evaluate({ settings: on({ landWithoutPerson: true }), mergeable: undefined }).decision, 'land');
  // Failed checks and a refused merge are both listed.
  assert.deepEqual(evaluate({ checks: [{ name: 'ci', state: 'error' }], mergeable: { ok: false } }).reasons, ['required check ci failed', 'cannot merge: not mergeable']);
});

test('required checks: named checks, the pipelines default, and combined states', () => {
  assert.deepEqual(requiredCheckStates([], [{ name: 'ci', state: 'success' }, { name: 'ext', state: 'failure', kind: 'reported' }, { name: 'ci / build', state: 'failure', kind: 'job' }]), [{ name: 'ci', outcome: 'passed' }]);
  assert.deepEqual(requiredCheckStates(['ext', 'gone'], [{ name: 'ext', state: 'success', kind: 'reported' }]), [{ name: 'ext', outcome: 'passed' }, { name: 'gone', outcome: 'missing' }]);
  assert.deepEqual(requiredCheckStates([], [{ name: 'ci', state: 'success' }, { name: 'ci', state: 'running' }]), [{ name: 'ci', outcome: 'pending' }]);
  assert.deepEqual(requiredCheckStates([], [{ name: 'ci', state: 'running' }, { name: 'ci', state: 'cancelled' }]), [{ name: 'ci', outcome: 'failed' }]);
  for (const state of ['success', 'SUCCESS', 'neutral', 'skipped']) assert.equal(requiredCheckStates(['x'], [{ name: 'x', state }])[0].outcome, 'passed', state);
  for (const state of ['failure', 'error', 'cancelled', 'timed_out', 'refused', 'ERROR']) assert.equal(requiredCheckStates(['x'], [{ name: 'x', state }])[0].outcome, 'failed', state);
  for (const state of ['pending', 'queued', 'running', 'waiting', '', undefined]) assert.equal(requiredCheckStates(['x'], [{ name: 'x', state }])[0].outcome, 'pending', String(state));
  // A named required check that has not reported waits; a failing check that is not required does not block.
  const settings = on({ landWithoutPerson: true, requiredChecks: ['build'] });
  assert.equal(evaluate({ settings, checks: [{ name: 'lint', state: 'failure' }] }).decision, 'waiting_checks');
  assert.equal(evaluate({ settings, checks: [{ name: 'lint', state: 'failure' }, { name: 'build', state: 'success', kind: 'job' }] }).decision, 'land');
});

test('reviews: changes requested by a reader do not block; an approval from the author or an agent never counts', () => {
  assert.equal(evaluate({ changedPaths: paths('src/a.js'), reviews: [approval, { ...approval, state: 'CHANGES_REQUESTED', reviewerIsWriter: false }] }).decision, 'land');
  assert.equal(evaluate({ changedPaths: paths('src/a.js'), reviews: [{ ...approval, state: 'COMMENT' }] }).decision, 'needs_person');
  assert.equal(evaluate({ changedPaths: paths('deploy/a'), reviews: [{ ...approval, reviewerIsAuthor: true }, { ...approval, reviewerIsAgent: true }] }).decision, 'needs_person');
});

test('the function is pure: inputs are not changed and equal inputs give equal results', () => {
  const input = { settings: on({ landWithoutPerson: true }), changedPaths: paths('docs/a.md'), checks: [...ok], reviews: [approval] };
  const before = JSON.stringify(input);
  assert.deepEqual(evaluateLanding(input), evaluateLanding(input));
  assert.equal(JSON.stringify(input), before);
});
