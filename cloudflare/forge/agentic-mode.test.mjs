// Agentic mode (docs/AGENTIC_MODE.md, AM-4): the per-repository setting behind the feature policy, its audit row, the record of how
// each pull request was opened and the landing evaluation of an open pull request. node:sqlite as D1 over the real schema; the
// repository is the two-commit fixture shared with the API token tests (main and feature differ in hello.txt).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { accessFixture, origin, repository, base, feature, commits } from './agent-access-fixture.mjs';
import { effectiveFeatures } from './src/feature-policy.mjs';

const zero = '0'.repeat(40);
async function fixture(t) {
  const f = await accessFixture(t);
  const call = (path, body, who = 'alice', headers = {}) => f.dispatch(new Request(origin + path, { method: 'POST', body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json', 'Connect-Protocol-Version': '1', Origin: origin, 'X-Golf-Native-Access-Email': who + '@example.invalid', ...headers } }))
    .then(async response => ({ status: response.status, ...await response.json() }));
  const read = (body, who, headers) => call('/native/agentic-mode/read', { repository, repositoryId: '1', ...body }, who, headers);
  const write = (body, who, headers) => call('/native/agentic-mode', { repository, repositoryId: '1', action: 'set', ...body }, who, headers);
  const settings = { enabled: true, lowRiskPaths: ['docs/**', '**/*.md'], sensitivePaths: ['.github/**', '.forgejo/**', '.gitlab-ci.yml', 'deploy/**', '**/CODEOWNERS'], landWithoutPerson: false, requiredChecks: [], revertOnFailure: true };
  const save = async (changes = {}, who = 'alice') => {
    const version = (await read({ action: 'get' })).settings.version;
    return write({ ...settings, ...changes, expectedVersion: version }, who);
  };
  const evaluate = (number = 14, who = 'alice') => read({ action: 'evaluate', number }, who);
  const run = (state, name = 'CI', commit = feature) => f.sql.prepare(`INSERT INTO pipeline_runs(repository_id,artifact_name,engine,number,workflow_path,workflow_name,event,ref,commit_id,actor_id,trusted,state,created_at,updated_at)
    VALUES(1,'repo-${'b'.repeat(32)}','forgejo-actions',(SELECT COALESCE(max(number),0)+1 FROM pipeline_runs),?,?,'push','refs/heads/feature',?,1,1,?,'t','t')`).run(`.forgejo/workflows/${name}.yml`, name, commit, state);
  const review = (author, state, head = feature) => f.sql.prepare("INSERT INTO pull_reviews(pull_request_id,author_id,head_commit,base_commit,state,body,created_at) VALUES(1,?,?,?,?,'','t')").run(author, head, base, state);
  return { ...f, call, read, write, save, evaluate, run, review, settings };
}

test('defaults: absent settings read as off with the documented paths; the capability is ready at schema 41', async t => {
  const f = await fixture(t);
  const got = await f.read({ action: 'get' });
  assert.equal(got.status, 200);
  assert.deepEqual(got.settings, { enabled: false, lowRiskPaths: ['docs/**', '**/*.md'], sensitivePaths: ['.github/**', '.forgejo/**', '.gitlab-ci.yml', 'deploy/**', '**/CODEOWNERS'], landWithoutPerson: false, requiredChecks: [], revertOnFailure: true, version: 0, updatedBy: '', updatedAt: '' });
  assert.deepEqual(got.feature.allowed, true); assert.equal(got.canEdit, true);
  assert.equal((await f.read({ action: 'get' }, 'carol')).canEdit, false);
  const capabilities = (await f.call('/rpc/golf.v1.CapabilityService/ListCapabilities', {})).capabilities;
  assert.equal(capabilities.find(c => c.id === 'repository.agentic-mode').state, 'CAPABILITY_STATE_READY');
  assert.equal((await f.call('/native/diagnostics', {})).schema, 49);
});

test('only a browser session reads or changes it; reads and changes use their own routes; outsiders are hidden', async t => {
  const f = await fixture(t);
  assert.equal((await f.read({ action: 'get' }, 'alice', { Origin: 'https://evil.example' })).status, 403);
  const noOrigin = await f.dispatch(new Request(origin + '/native/agentic-mode/read', { method: 'POST', body: JSON.stringify({ repository, repositoryId: '1', action: 'get' }),
    headers: { 'Content-Type': 'application/json', 'Connect-Protocol-Version': '1', 'X-Golf-Native-Access-Email': 'alice@example.invalid' } }));
  assert.equal(noOrigin.status, 403);
  const { secret } = await f.create({ repositories: ['1'] });
  assert.equal((await f.read({ action: 'get' }, 'alice', { Authorization: 'Bearer ' + secret })).status, 401);
  assert.equal((await f.call('/native/agentic-mode/read', { repository, repositoryId: '1', action: 'set' })).status, 400);
  assert.equal((await f.call('/native/agentic-mode', { repository, repositoryId: '1', action: 'get' })).status, 400);
  assert.equal((await f.read({ action: 'get' }, 'dave')).status, 404);
  assert.equal((await f.read({ action: 'get', repositoryId: '2' })).status, 404);
});

test('set: administrators only, every field validated, compare-and-swap on the version, audited', async t => {
  const f = await fixture(t);
  assert.equal((await f.save({}, 'bob')).status, 403);
  for (const [changes, pattern] of [[{ lowRiskPaths: ['/abs'] }, /no leading or trailing slash/], [{ sensitivePaths: ['a//b'] }, /empty/], [{ lowRiskPaths: Array(51).fill('a') }, /at most 50/],
    [{ lowRiskPaths: ['a', 'a'] }, /once/], [{ requiredChecks: [' ci'] }, /required check/], [{ requiredChecks: Array.from({ length: 51 }, (_, i) => 'c' + i) }, /at most 50/],
    [{ enabled: 'yes' }, /true or false/], [{ lowRiskPaths: ['x'.repeat(201)] }, /200 characters/], [{ extra: 1 }, /every agentic mode field/]]) {
    const result = await f.save(changes); assert.equal(result.status, 400, JSON.stringify(changes)); assert.match(result.message, pattern);
  }
  const missing = await f.write({ enabled: true, expectedVersion: 0 }); assert.equal(missing.status, 400);
  const saved = await f.save({ lowRiskPaths: ['docs/**', '*.txt'], requiredChecks: ['CI'], landWithoutPerson: true });
  assert.equal(saved.status, 200);
  assert.deepEqual({ ...saved.settings, updatedAt: '' }, { ...f.settings, lowRiskPaths: ['docs/**', '*.txt'], requiredChecks: ['CI'], landWithoutPerson: true, version: 1, updatedBy: 'alice', updatedAt: '' });
  assert.equal((await f.write({ ...f.settings, expectedVersion: 0 })).status, 412);
  assert.equal((await f.write({ ...f.settings, enabled: false, expectedVersion: 1 })).settings.version, 2);
  // Bob's refusal is recorded as denied; validation and stale-version refusals are not recorded.
  assert.deepEqual(f.sql.prepare("SELECT json_extract(client,'$.outcome') AS outcome FROM installation_audit WHERE action='agentic_mode.update' ORDER BY id").all().map(row => row.outcome), ['denied', 'success', 'success']);
  const audit = f.sql.prepare("SELECT scope,scope_id,action,before,after FROM installation_audit WHERE action='agentic_mode.update' AND json_extract(client,'$.outcome')='success' ORDER BY id").all();
  assert.deepEqual([audit[0].scope, audit[0].scope_id, JSON.parse(audit[0].before)], ['repository', '1', null]);
  assert.deepEqual(JSON.parse(audit[0].after), { enabled: true, landWithoutPerson: true, revertOnFailure: true, lowRiskPaths: ['docs/**', '*.txt'], sensitivePaths: f.settings.sensitivePaths, requiredChecks: ['CI'] });
  assert.equal(JSON.parse(audit[1].before).enabled, true); assert.equal(JSON.parse(audit[1].after).enabled, false);
  const log = await f.call('/native/audit/read', { scope: 'repository', repository, repositoryId: '1' });
  assert.ok(log.categories.some(c => c.id === 'agentic_mode' && c.label === 'Agentic mode'));
  assert.deepEqual(log.entries.filter(e => e.category === 'agentic_mode').map(e => e.description), ['changed agentic mode (off)', 'changed agentic mode (on, landing low-risk changes without a person)', 'tried to change agentic mode']);
});

test('feature policy: an installation policy can turn it off, never require it', async t => {
  const f = await fixture(t);
  f.sql.exec("INSERT INTO feature_policies(scope,scope_id,feature,mode,version,updated_by,updated_at) VALUES('installation','','agentic-mode','ENFORCED',1,1,'t')");
  const enforced = effectiveFeatures({}, { feature_policy: JSON.stringify([['installation', 'agentic-mode', 'ENFORCED']]) }).get('agentic-mode');
  assert.equal(enforced.effective, true); assert.equal(enforced.decidedBy, 'INSTALLATION'); assert.match(enforced.reason, /allowed by the installation policy/);
  assert.equal((await f.read({ action: 'get' })).settings.enabled, false);
  await f.save({ enabled: true });
  f.sql.exec("UPDATE feature_policies SET mode='DISABLED' WHERE feature='agentic-mode'");
  const got = await f.read({ action: 'get' });
  assert.equal(got.feature.allowed, false); assert.match(got.feature.reason, /Agentic mode is turned off for this repository by the installation policy/);
  const refused = await f.save({ enabled: true }); assert.equal(refused.status, 412); assert.match(refused.message, /installation policy/);
  assert.equal((await f.save({ enabled: false })).status, 200);
  f.sql.exec("UPDATE repository_agentic_settings SET enabled=1");
  const evaluated = await f.evaluate();
  assert.equal(evaluated.enabled, false); assert.equal(evaluated.evaluation.decision, 'needs_person');
  assert.deepEqual(evaluated.evaluation.reasons, ['agentic mode off', got.feature.reason]);
});

test('evaluate: changed paths from the merge base, checks of the head commit, reviews and the merge observation', async t => {
  const f = await fixture(t);
  // Off: a person decides; the risk is still reported.
  let result = await f.evaluate();
  assert.equal(result.status, 200);
  assert.deepEqual({ decision: result.evaluation.decision, reasons: result.evaluation.reasons, risk: result.evaluation.risk }, { decision: 'needs_person', reasons: ['agentic mode off'], risk: 'normal' });
  assert.deepEqual([result.baseCommitId, result.headCommitId, result.mergeBaseCommitId, result.changedPathCount, result.origin], [base, feature, base, 1, 'person']);
  assert.deepEqual(result.mergeable, { ok: true, reason: '' });
  // Low-risk and landing without a person: waits for a check, lands when it passes, is blocked when it fails.
  await f.save({ lowRiskPaths: ['*.txt'], landWithoutPerson: true });
  result = await f.evaluate();
  assert.deepEqual([result.evaluation.decision, result.evaluation.risk, result.evaluation.matched], ['waiting_checks', 'low', { low: ['hello.txt'], sensitive: [] }]);
  f.run('RUNNING'); assert.equal((await f.evaluate()).evaluation.decision, 'waiting_checks');
  f.sql.exec("UPDATE pipeline_runs SET state='SUCCESS'");
  result = await f.evaluate();
  assert.equal(result.evaluation.decision, 'land'); assert.deepEqual(result.checks, [{ name: 'CI', kind: 'pipeline', state: 'success' }]);
  f.run('FAILURE', 'Lint'); result = await f.evaluate();
  assert.deepEqual([result.evaluation.decision, result.evaluation.reasons], ['blocked', ['required check Lint failed']]);
  // Named required checks: only those count, including reported checks.
  await f.save({ lowRiskPaths: ['*.txt'], landWithoutPerson: true, requiredChecks: ['CI', 'external'] });
  assert.deepEqual((await f.evaluate()).evaluation.reasons, ['required check external has not reported']);
  f.sql.exec(`INSERT INTO reported_checks(repository_id,commit_id,context,state,description,target_url,author_id,created_at) VALUES(1,'${feature}','external','SUCCESS','','',1,'t')`);
  assert.equal((await f.evaluate()).evaluation.decision, 'land');
  // A check of another commit is not this one's.
  f.run('FAILURE', 'CI', base); assert.equal((await f.evaluate()).evaluation.decision, 'land');
  // Sensitive: a writer's approval of the current head is needed; the author, a reader or a stale approval never counts.
  await f.save({ lowRiskPaths: ['*.txt'], sensitivePaths: ['hello.txt'], landWithoutPerson: true, requiredChecks: ['CI'] });
  result = await f.evaluate();
  assert.deepEqual([result.evaluation.decision, result.evaluation.risk, result.evaluation.matched.sensitive], ['needs_person', 'sensitive', ['hello.txt']]);
  f.review(3, 'APPROVED'); f.review(2, 'APPROVED', base);
  assert.equal((await f.evaluate()).evaluation.decision, 'needs_person');
  f.review(2, 'APPROVED'); assert.equal((await f.evaluate()).evaluation.decision, 'land');
  // A later change request replaces that reviewer's approval; a later comment does not.
  f.review(2, 'COMMENT'); assert.equal((await f.evaluate()).evaluation.decision, 'land');
  f.review(2, 'REQUEST_CHANGES'); result = await f.evaluate();
  assert.equal(result.evaluation.decision, 'needs_person'); assert.ok(result.evaluation.reasons.includes('a writer requested changes'));
  // A dismissed change request no longer counts.
  const last = f.sql.prepare('SELECT max(id) AS id FROM pull_reviews').get().id;
  f.sql.prepare("INSERT INTO pull_review_lifecycle(review_id,version,dismissed,reason,updated_at) VALUES(?,1,1,'','t')").run(last);
  assert.equal((await f.evaluate()).evaluation.decision, 'land');
  // Drafts need a person.
  f.sql.exec('UPDATE pull_requests SET draft=1'); assert.deepEqual((await f.evaluate()).evaluation.reasons, ['the pull request is a draft']);
  f.sql.exec('UPDATE pull_requests SET draft=0');
  // Readers evaluate too; a closed or unknown pull request is refused.
  assert.equal((await f.evaluate(14, 'carol')).evaluation.decision, 'land');
  assert.equal((await f.evaluate(99)).status, 404);
  assert.equal((await f.evaluate(12)).status, 404);
  f.sql.exec("UPDATE discussions SET state='CLOSED' WHERE id=4"); assert.equal((await f.evaluate()).status, 412);
});

test('pull request origins: a person, an API token through MCP, and a finished agent task', async t => {
  const f = await fixture(t);
  const refs = f.refs.get('repo-' + 'b'.repeat(32));
  refs.set('refs/heads/person', feature); refs.set('refs/heads/golf-agent/0a1b2c3d', feature); refs.set('refs/heads/golf-agent/ffffffff', feature);
  const open = (head, extra = {}, who = 'alice') => f.call('/rpc/golf.v1.RepositoryService/CreatePullRequest', { repository, repositoryId: '1', sourceRepository: repository, sourceRepositoryId: '1',
    baseBranch: 'main', headBranch: head, baseCommitId: base, headCommitId: feature, title: 'Change ' + head, body: '', idempotencyKey: crypto.randomUUID(), ...extra }, who);
  const origins = () => f.sql.prepare('SELECT d.number,o.kind,o.api_token_id,o.agent_task_id FROM pull_request_origins o JOIN pull_requests p ON p.id=o.pull_request_id JOIN discussions d ON d.id=p.discussion_id ORDER BY d.number').all().map(row => ({ ...row }));
  assert.equal((await open('person')).status, 200);
  const { secret, token } = await f.create({ repositories: ['1'] }, 'bob');
  await f.tool(secret, 'open_pull_request', { head: 'agent/demo', base: 'main', title: 'Agent change', body: '' });
  f.sql.exec(`INSERT INTO agent_hosts(id,uuid,name,scope,scope_id,registered_by,credential_digest,created_at) VALUES(1,'u','laptop','personal','1',1,'x','t')`);
  const task = crypto.randomUUID(), other = crypto.randomUUID();
  f.sql.prepare(`INSERT INTO agent_tasks(id,repository_id,artifact_name,host_id,tool,requested_by,target_kind,target_number,base_ref,base_commit,branch,prompt,state,deadline,idempotency_key,created_at,updated_at)
    VALUES(?,1,'repo-${'b'.repeat(32)}',1,'claude',1,'issue',12,'refs/heads/main','${base}',?,'p',?,0,?,'t','t')`).run(task, 'golf-agent/0a1b2c3d', 'SUCCEEDED', 'k1');
  f.sql.prepare(`INSERT INTO agent_tasks(id,repository_id,artifact_name,host_id,tool,requested_by,target_kind,target_number,base_ref,base_commit,branch,prompt,state,deadline,idempotency_key,created_at,updated_at)
    VALUES(?,1,'repo-${'b'.repeat(32)}',1,'claude',1,'issue',12,'refs/heads/main','${base}',?,'p',?,0,?,'t','t')`).run(other, 'golf-agent/ffffffff', 'RUNNING', 'k2');
  // The task must be finished and its branch must be the head branch.
  assert.equal((await open('golf-agent/ffffffff', { agentTaskId: other })).status, 412);
  assert.equal((await open('golf-agent/ffffffff', { agentTaskId: task })).status, 412);
  assert.equal((await open('golf-agent/0a1b2c3d', { agentTaskId: 'nope' })).status, 400);
  assert.equal((await open('golf-agent/0a1b2c3d', { agentTaskId: task })).status, 200);
  assert.deepEqual(origins(), [{ number: 15, kind: 'person', api_token_id: null, agent_task_id: null }, { number: 16, kind: 'api-token', api_token_id: Number(token.id), agent_task_id: null },
    { number: 17, kind: 'agent-task', api_token_id: null, agent_task_id: task }]);
  // The evaluation reads the author kind from the origin.
  assert.equal((await f.evaluate(16)).origin, 'api-token');
  assert.equal((await f.evaluate(17)).origin, 'agent-task');
  assert.equal((await f.evaluate(14)).origin, 'person');
});

test('a pull request opens while a merge holds the repository; an unresolved write to one of its own branches still refuses it', async t => {
  const f = await fixture(t);
  const refs = f.refs.get('repo-' + 'b'.repeat(32));
  refs.set('refs/heads/topic', feature); refs.set('refs/heads/other', feature);
  const open = head => f.call('/rpc/golf.v1.RepositoryService/CreatePullRequest', { repository, repositoryId: '1', sourceRepository: repository, sourceRepositoryId: '1',
    baseBranch: 'main', headBranch: head, baseCommitId: base, headCommitId: feature, title: 'Change ' + head, body: '', idempotencyKey: crypto.randomUUID() });
  // A landing's merge holds the repository (it moves main): opening against the provider's current heads goes ahead.
  f.sql.exec("UPDATE repositories SET write_pending='merge-op'");
  assert.equal((await open('topic')).status, 200);
  // An unresolved push to the head branch: its commit is not known, so this pull request waits.
  f.sql.exec("INSERT INTO git_operations(id,repository_id,user_id,ref,old_sha,new_sha,state,created_at) VALUES('push-op',1,1,'refs/heads/other','" + base + "','" + feature + "','DISPATCHED','t')");
  f.sql.exec("INSERT INTO git_ref_writes(operation_id,repository_id,ref) VALUES('push-op',1,'refs/heads/other')");
  const refused = await open('other');
  assert.equal(refused.status, 412); assert.equal(refused.message, 'An unresolved operation fences further changes.');
});

test('open_pull_request reads the branches again when a landing moves the base between its read and the open', async t => {
  const f = await fixture(t);
  const refs = f.refs.get('repo-' + 'b'.repeat(32)), moved = 'c'.repeat(40);
  commits.set(moved, { ...commits.get(base), hash: moved, parents: [base], message: 'Landed meanwhile', authoredAt: 1700000100 });
  refs.set('refs/heads/agent/topic', feature);
  // The tool reads base and head (two advertisements), then CreatePullRequest reads them again: main moves before that third read.
  let reads = 0;
  const iterate = refs[Symbol.iterator].bind(refs);
  refs[Symbol.iterator] = () => { if (++reads === 3) Map.prototype.set.call(refs, 'refs/heads/main', moved); return iterate(); };
  const { secret } = await f.create({ repositories: ['1'] }, 'bob');
  const result = await f.tool(secret, 'open_pull_request', { head: 'agent/topic', base: 'main', title: 'Agent change', body: '' });
  assert.equal(result.isError, undefined, JSON.stringify(result));
  assert.equal(JSON.parse(result.content[0].text).base.commitId, moved); assert.ok(reads >= 6);
});
