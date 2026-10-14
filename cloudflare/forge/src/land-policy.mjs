// Agentic mode landing policy (docs/AGENTIC_MODE.md, docs/AGENTIC_MODE_PLAN.md AM-4). Pure: no I/O, no clock, no randomness.
// evaluateLanding decides whether an open pull request may land now, from its changed paths, author kind, check states, reviews,
// draft flag and an optional merge observation. Glob patterns are matched by a small anchored matcher, never compiled to a RegExp.

export const defaultAgenticSettings = Object.freeze({
  enabled: false,
  lowRiskPaths: Object.freeze(['docs/**', '**/*.md']),
  sensitivePaths: Object.freeze(['.github/**', '.forgejo/**', '.gitlab-ci.yml', 'deploy/**', '**/CODEOWNERS']),
  landWithoutPerson: false,
  requiredChecks: Object.freeze([]),
  revertOnFailure: true,
});
export const limits = Object.freeze({ patterns: 50, patternLength: 200, checks: 50, checkLength: 100 });

// A pattern is a /-separated path with no empty, '.' or '..' segment and no control characters or backslashes. Segments match
// literally except '*' (any run of characters within one segment, possibly empty), '?' (exactly one character within one segment)
// and a whole segment '**' (zero or more segments). Matching is anchored at both ends and case-sensitive; '*' also matches a leading dot.
export function globError(pattern) {
  if (typeof pattern !== 'string' || !pattern) return 'Use a non-empty pattern.';
  if (pattern.length > limits.patternLength) return `Use patterns of at most ${limits.patternLength} characters.`;
  if (/[\x00-\x1f\x7f\\]/.test(pattern)) return 'Patterns cannot contain control characters or backslashes.';
  if (pattern.startsWith('/') || pattern.endsWith('/')) return 'Patterns are relative to the repository root: no leading or trailing slash.';
  if (pattern.split('/').some(segment => !segment || segment === '.' || segment === '..')) return 'Patterns cannot contain empty, "." or ".." segments.';
  return '';
}

// Wildcard match of one segment: '*' any run, '?' one character. Greedy with backtracking to the last star: O(n·m) at worst.
function segmentMatch(pattern, name) {
  let p = 0, n = 0, star = -1, resume = 0;
  while (n < name.length) {
    if (p < pattern.length && (pattern[p] === '?' || pattern[p] !== '*' && pattern[p] === name[n])) { p++; n++; }
    else if (p < pattern.length && pattern[p] === '*') { star = p++; resume = n; }
    else if (star >= 0) { p = star + 1; n = ++resume; }
    else return false;
  }
  while (p < pattern.length && pattern[p] === '*') p++;
  return p === pattern.length;
}

export function globMatch(pattern, path) {
  if (globError(pattern) || typeof path !== 'string' || !path) return false;
  const parts = pattern.split('/'), names = path.split('/'), seen = new Set();
  // match(i, j): parts[i..] matches names[j..]. Memoized over (i, j), so '**' runs stay polynomial.
  const match = (i, j) => {
    const key = i * (names.length + 1) + j;
    if (seen.has(key)) return false;
    seen.add(key);
    if (i === parts.length) return j === names.length;
    if (parts[i] === '**') {
      for (let k = j; k <= names.length; k++) if (match(i + 1, k)) return true;
      return false;
    }
    return j < names.length && segmentMatch(parts[i], names[j]) && match(i + 1, j + 1);
  };
  return match(0, 0);
}
export const anyMatch = (patterns, path) => patterns.some(pattern => globMatch(pattern, path));

const passed = new Set(['success', 'neutral', 'skipped']);
const failed = new Set(['failure', 'error', 'cancelled', 'timed_out', 'refused', 'action_required']);
const checkOutcome = state => { const value = String(state || '').toLowerCase(); return passed.has(value) ? 'passed' : failed.has(value) ? 'failed' : 'pending'; };
const list = (value, fallback) => Array.isArray(value) ? value.filter(item => typeof item === 'string') : [...fallback];

export function normalizeSettings(settings = {}) {
  const value = settings || {};
  return { enabled: value.enabled === true, lowRiskPaths: list(value.lowRiskPaths, defaultAgenticSettings.lowRiskPaths), sensitivePaths: list(value.sensitivePaths, defaultAgenticSettings.sensitivePaths),
    landWithoutPerson: value.landWithoutPerson === true, requiredChecks: list(value.requiredChecks, []), revertOnFailure: value.revertOnFailure !== false };
}

// Required checks: the named ones, or with none named every pipeline check (kind 'pipeline' or unspecified) reported for the commit.
// Several checks with one name (a workflow run for push and for pull_request) combine: any failure fails, any pending waits.
export function requiredCheckStates(requiredChecks, checks) {
  const names = requiredChecks.length ? [...new Set(requiredChecks)] : [...new Set(checks.filter(check => (check.kind ?? 'pipeline') === 'pipeline').map(check => check.name))];
  return names.map(name => {
    const outcomes = checks.filter(check => check.name === name).map(check => checkOutcome(check.state));
    return { name, outcome: !outcomes.length ? 'missing' : outcomes.includes('failed') ? 'failed' : outcomes.includes('pending') ? 'pending' : 'passed' };
  });
}

export function evaluateLanding({ settings, changedPaths = [], authorKind = 'person', checks = [], reviews = [], draft = false, mergeable } = {}) {
  const s = normalizeSettings(settings), paths = [...new Set(changedPaths.map(entry => entry?.path).filter(path => typeof path === 'string' && path))];
  const sensitive = paths.filter(path => anyMatch(s.sensitivePaths, path)), low = paths.filter(path => anyMatch(s.lowRiskPaths, path));
  const allLow = paths.length > 0 && !sensitive.length && low.length === paths.length;
  const risk = sensitive.length ? 'sensitive' : allLow ? 'low' : 'normal', matched = { low, sensitive };
  const result = (decision, reasons) => ({ decision, reasons, risk, matched });
  if (!s.enabled) return result('needs_person', ['agentic mode off']);

  const required = requiredCheckStates(s.requiredChecks, checks.filter(check => check && typeof check.name === 'string'));
  const blocked = [
    ...required.filter(check => check.outcome === 'failed').map(check => `required check ${check.name} failed`),
    ...(mergeable && mergeable.ok === false ? [`cannot merge: ${mergeable.reason || 'not mergeable'}`] : []),
  ];
  if (blocked.length) return result('blocked', blocked);

  // Only writers' reviews count. An approval counts only from a writer who is neither the author nor an agent.
  const changesRequested = reviews.some(review => review?.state === 'CHANGES_REQUESTED' && review.reviewerIsWriter === true);
  const approved = !changesRequested && reviews.some(review => review?.state === 'APPROVED' && review.reviewerIsWriter === true && review.reviewerIsAuthor !== true && review.reviewerIsAgent !== true);
  const waiting = required.filter(check => check.outcome !== 'passed').map(check => check.outcome === 'missing' ? `required check ${check.name} has not reported` : `required check ${check.name} is still running`);
  const person = [];
  if (draft) person.push('the pull request is a draft');
  if (changesRequested) person.push('a writer requested changes');
  if (sensitive.length && !approved) person.push(`sensitive paths need approval from a writer who is not the author and not an agent: ${sensitive.join(', ')}`);
  const withoutPerson = allLow && s.landWithoutPerson;
  if (!person.length && !approved && !withoutPerson) {
    if (!paths.length) person.push('no changed paths');
    else if (!allLow) person.push('changes outside the low-risk paths need approval from a writer who is not the author and not an agent');
    else person.push('landing without a person is off for this repository');
  }
  if (person.length) return result('needs_person', [...person, ...waiting]);
  // Landing without a person needs at least one passing check: with none reported yet, it waits for them.
  if (!approved && !required.length) waiting.push('no checks have reported on the head commit yet');
  if (waiting.length) return result('waiting_checks', waiting);
  return result('land', approved
    ? [`approved by a writer who is not the author and not an agent${required.length ? '; every required check passed' : '; no checks reported'}`]
    : [`every changed path is low-risk, landing without a person is on and every required check passed${authorKind === 'agent' ? ' (opened by an agent)' : ''}`]);
}
