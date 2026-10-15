// The agentic inbox and intent summaries (docs/AGENTIC_MODE.md "Inbox and intent summaries", AM-5): sections, bounds and the truncation
// flag, permission refusals, an installation without the land queue table, and AI intent summaries stored once per head commit through
// the real AI run workflow with a recording model in place of the Workers AI binding. node:sqlite as D1 over the real schema; the
// repository is the two-commit fixture shared with the API token tests (main and feature differ in hello.txt).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { accessFixture, origin, repository, base, feature } from './agent-access-fixture.mjs';
import { tokens } from './object-fixture.mjs';
import { advanceAi } from './src/core.mjs';
import { runAiWorkflow } from './src/ai-workflow.mjs';
import { withInstallationPolicy } from './src/installation.mjs';
import { inboxLimits } from './src/agent-inbox.mjs';
import { intentLimits } from './src/ai-intent.mjs';

const artifact = 'repo-' + 'b'.repeat(32), next = '9'.repeat(40);
const good = { intent: 'Changes the greeting in hello.txt to address agents.', areas: ['greeting text'], risks: ['Scripts that compare the greeting exactly will fail.'], confidence: 'high' };
const chat = value => ({ choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: typeof value === 'string' ? value : JSON.stringify(value) } }], usage: { prompt_tokens: 700, completion_tokens: 90, total_tokens: 790 } });

async function fixture(t, { ai = true } = {}) {
  const f = await accessFixture(t);
  // A third commit on top of feature: hello.txt changes again and a 60 KiB file is added, more than the 48 KiB summary limit.
  const big = 'x'.repeat(60 * 1024) + '\n', original = f.env.ARTIFACTS;
  const commits = new Map([[next, { hash: next, treeHash: '8'.repeat(40), parents: [feature], message: 'Greet agents', author: { name: 'Bob' }, authoredAt: 1700000200 }]]);
  const trees = new Map([['8'.repeat(40), [{ name: 'big.txt', hash: '6'.repeat(40), type: 'blob', mode: '100644' }, { name: 'hello.txt', hash: '7'.repeat(40), type: 'blob', mode: '100644' }]]]);
  const blobs = new Map([['6'.repeat(40), big], ['7'.repeat(40), 'hello agents\n']]);
  f.env.ARTIFACTS = { async get(name) { const repo = await original.get(name); return { ...repo,
    readCommit: async hash => commits.get(hash) || repo.readCommit(hash), readTree: async hash => trees.get(hash) || repo.readTree(hash),
    readBlob: async hash => blobs.has(hash) ? new Blob([blobs.get(hash)]) : repo.readBlob(hash), readBlobSize: async hash => blobs.has(hash) ? new Blob([blobs.get(hash)]).size : repo.readBlobSize(hash) }; } };
  const calls = [], answers = [];
  if (ai) Object.assign(f.env, { EVIDENCE_ALLOW_AI: 'true', EVIDENCE_GATEWAY: 'golf-gateway', AI_WORKFLOW_NAME: 'golf-ai',
    AI: { async run(model, input, options) { calls.push({ model, input, options }); return chat(answers.shift() ?? good); } },
    AiWorkflow: { async create() {}, async get() { return { status: async () => ({ status: 'queued' }) }; } } });
  const call = (path, body, who = 'alice', headers = {}) => f.dispatch(new Request(origin + path, { method: 'POST', body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json', 'Connect-Protocol-Version': '1', Origin: origin, 'X-Golf-Native-Access-Email': who + '@example.invalid', ...headers } }))
    .then(async response => ({ status: response.status, ...await response.json() }));
  const inbox = (body = {}, who, headers) => call('/native/agent-inbox/read', { repository, repositoryId: '1', action: 'inbox', ...body }, who, headers);
  const summary = (number = 14, who = 'bob') => call('/native/agent-inbox/read', { repository, repositoryId: '1', action: 'summary', number }, who);
  const summarize = (number = 14, who = 'bob', idempotencyKey = crypto.randomUUID()) => call('/native/agent-inbox', { repository, repositoryId: '1', action: 'summarize', number, idempotencyKey }, who);
  const settings = { enabled: true, lowRiskPaths: ['docs/**', '**/*.md'], sensitivePaths: ['.github/**', '.forgejo/**', '.gitlab-ci.yml', 'deploy/**', '**/CODEOWNERS'], landWithoutPerson: false, requiredChecks: [], revertOnFailure: true };
  const save = async (changes = {}) => {
    const version = (await call('/native/agentic-mode/read', { repository, repositoryId: '1', action: 'get' })).settings.version;
    const saved = await call('/native/agentic-mode', { repository, repositoryId: '1', action: 'set', ...settings, ...changes, expectedVersion: version });
    assert.equal(saved.status, 200, saved.message);
  };
  const run = (state, name = 'CI', commit = feature) => f.sql.prepare(`INSERT INTO pipeline_runs(repository_id,artifact_name,engine,number,workflow_path,workflow_name,event,ref,commit_id,actor_id,trusted,state,created_at,updated_at)
    VALUES(1,'${artifact}','forgejo-actions',(SELECT COALESCE(max(number),0)+1 FROM pipeline_runs),?,?,'push','refs/heads/feature',?,1,1,?,'t','t')`).run(`.forgejo/workflows/${name}.yml`, name, commit, state);
  // More open pull requests on their own branches (each at the feature commit), numbered from 20.
  const open = (count, from = 20) => {
    const refs = f.refs.get(artifact);
    for (let i = 0; i < count; i++) {
      const number = from + i, id = 100 + number;
      f.sql.prepare("INSERT INTO discussions(id,repository_id,number,kind,author_id,title,body,state,created_at,updated_at) VALUES(?,1,?,'pull',2,?,'','OPEN','t','t')").run(id, number, 'Change ' + number);
      f.sql.prepare("INSERT INTO pull_requests(id,discussion_id,base_branch,head_branch,base_commit,head_commit,draft) VALUES(?,?,'main',?,?,?,0)").run(id, id, 'topic/' + number, base, feature);
      refs.set('refs/heads/topic/' + number, feature);
    }
  };
  // The AI workflow, as Workflows runs it: prepare and settle in the workspace, inference with the recording model.
  const workflow = id => runAiWorkflow({ instanceId: id, payload: { runId: id } }, { async do(name, options, action) { return JSON.parse(JSON.stringify(await action())); } }, f.env,
    { ai: (runId, phase, result) => advanceAi(f.env, runId, phase, result) }, withInstallationPolicy);
  return { ...f, call, inbox, summary, summarize, save, run, open, workflow, calls, answers };
}

test('sections: agent tasks in progress, pull requests ready to land or needing a person, each with its evaluation; capability ready at schema 43', async t => {
  const f = await fixture(t);
  const capabilities = (await f.call('/rpc/golf.v1.CapabilityService/ListCapabilities', {})).capabilities;
  const capability = capabilities.find(c => c.id === 'repository.agent-inbox');
  assert.equal(capability.state, 'CAPABILITY_STATE_READY'); assert.match(capability.reason, /intent summary/);
  assert.equal((await f.call('/native/diagnostics', {})).schema, 45);
  f.sql.exec(`INSERT INTO agent_hosts(id,uuid,name,scope,scope_id,registered_by,credential_digest,created_at) VALUES(1,'u','laptop','personal','1',1,'x','t')`);
  const task = (id, state, created, repositoryId = 1) => f.sql.prepare(`INSERT INTO agent_tasks(id,repository_id,artifact_name,host_id,tool,requested_by,target_kind,target_number,target_title,base_ref,base_commit,branch,prompt,state,deadline,idempotency_key,created_at,updated_at)
    VALUES(?,?,?,1,'claude',1,'issue',12,'Fix the parser','refs/heads/main','${base}',?,'p',?,0,?,?,?)`).run(id, repositoryId, repositoryId === 1 ? artifact : 'repo-' + 'e'.repeat(32), 'golf-agent/' + id.slice(0, 8), state, id, created, created);
  task('0a1b2c3d-0000-4000-8000-000000000001', 'RUNNING', '2026-10-14T01:00:00Z'); task('0a1b2c3d-0000-4000-8000-000000000002', 'QUEUED', '2026-10-14T02:00:00Z');
  task('0a1b2c3d-0000-4000-8000-000000000003', 'SUCCEEDED', '2026-10-14T03:00:00Z'); task('0a1b2c3d-0000-4000-8000-000000000004', 'RUNNING', '2026-10-14T04:00:00Z', 2);

  // Agentic mode off: tasks are listed, pull requests are not evaluated.
  let value = await f.inbox();
  assert.equal(value.status, 200, value.message);
  assert.equal(value.enabled, false); assert.equal(value.pulls.state, 'agentic_mode_off'); assert.deepEqual([value.readyToLand, value.needsPerson], [[], []]);
  assert.deepEqual(value.inProgress.map(item => [item.state, item.host, item.requestedBy, item.target.number, item.branch]),
    [['QUEUED', 'laptop', 'alice', 12, 'golf-agent/0a1b2c3d'], ['RUNNING', 'laptop', 'alice', 12, 'golf-agent/0a1b2c3d']]);

  // On: the one open pull request changes hello.txt, which is not low-risk, and nobody approved it.
  await f.save();
  value = await f.inbox();
  assert.equal(value.enabled, true); assert.deepEqual(value.pulls, { state: 'evaluated', reason: '', open: 1, evaluated: 1, evaluateLimit: inboxLimits.evaluate });
  assert.deepEqual(value.readyToLand, []);
  assert.deepEqual(value.needsPerson, [{ number: 14, title: 'Feature work', author: 'alice', pullRequestId: '1', landing: null, origin: 'person', headCommitId: feature, baseCommitId: base,
    decision: 'needs_person', risk: 'normal', reasons: ['changes outside the low-risk paths need approval from a writer who is not the author and not an agent'], sensitivePaths: [], conflicts: [],
    mergeable: true, changedPathCount: 1, checks: { passed: 0, pending: 0, failed: 0 }, intent: null }]);
  // Low-risk and landing without a person: waiting for checks, then ready to land; a failing check blocks it.
  await f.save({ lowRiskPaths: ['*.txt'], landWithoutPerson: true });
  value = await f.inbox();
  assert.deepEqual(value.readyToLand.map(item => [item.number, item.decision, item.risk]), [[14, 'waiting_checks', 'low']]);
  f.run('SUCCESS');
  value = await f.inbox();
  assert.deepEqual(value.readyToLand.map(item => [item.decision, item.checks]), [['land', { passed: 1, pending: 0, failed: 0 }]]);
  f.run('FAILURE', 'Lint');
  value = await f.inbox();
  assert.deepEqual(value.needsPerson.map(item => [item.decision, item.reasons]), [['blocked', ['required check Lint failed']]]);
  // Sensitive paths are named.
  await f.save({ sensitivePaths: ['hello.txt'] });
  value = await f.inbox();
  assert.deepEqual(value.needsPerson.map(item => [item.risk, item.sensitivePaths]), [['sensitive', ['hello.txt']]]);
  // A pull request whose head branch is gone is listed with the reason, not dropped.
  f.open(1); f.refs.get(artifact).delete('refs/heads/topic/20');
  value = await f.inbox();
  assert.deepEqual(value.needsPerson.map(item => [item.number, item.decision]), [[20, 'unavailable'], [14, 'blocked']]);
  assert.match(value.needsPerson[0].reasons[0], /no longer exists/);
  // Readers read the inbox too, but cannot ask for summaries.
  const reader = await f.inbox({}, 'carol');
  assert.equal(reader.status, 200); assert.deepEqual(reader.summaries, { available: false, reason: 'Asking for an intent summary needs write or admin access to this repository.' });
  assert.deepEqual(value.summaries, { available: true, reason: '' });
});

test('bounds: at most 25 open pull requests are evaluated, newest first, and the read says it stopped; rows are limited', async t => {
  const f = await fixture(t);
  await f.save();
  f.open(30);
  let value = await f.inbox();
  assert.deepEqual([value.pulls.open, value.pulls.evaluated, value.truncated.pulls], [31, 25, true]);
  const numbers = value.needsPerson.map(item => item.number);
  assert.equal(numbers.length, 25); assert.equal(numbers[0], 49); assert.equal(numbers.at(-1), 25);
  value = await f.inbox({ limit: 2 });
  assert.deepEqual([value.pulls.evaluated, value.truncated.pulls, value.limit], [2, true, 2]);
  for (const limit of [0, 101, 1.5, '10']) assert.equal((await f.inbox({ limit })).status, 400, String(limit));
  // A small repository is not truncated.
  f.sql.exec("UPDATE discussions SET state='CLOSED' WHERE number>=20");
  value = await f.inbox();
  assert.deepEqual([value.pulls.open, value.pulls.evaluated, value.truncated.pulls], [1, 1, false]);
});

test('only a browser session reads the inbox; routes are split by action; outsiders are hidden and readers cannot summarize', async t => {
  const f = await fixture(t);
  assert.equal((await f.inbox({}, 'alice', { Origin: 'https://evil.example' })).status, 403);
  const { secret } = await f.create({ repositories: ['1'] });
  assert.equal((await f.inbox({}, 'alice', { Authorization: 'Bearer ' + secret })).status, 401);
  assert.equal((await f.call('/native/agent-inbox/read', { repository, repositoryId: '1', action: 'summarize', number: 14, idempotencyKey: crypto.randomUUID() })).status, 400);
  assert.equal((await f.call('/native/agent-inbox', { repository, repositoryId: '1', action: 'inbox' })).status, 400);
  assert.equal((await f.inbox({}, 'dave')).status, 404);
  assert.equal((await f.inbox({ repositoryId: '2' })).status, 404);
  const reader = await f.summarize(14, 'carol');
  assert.equal(reader.status, 403); assert.match(reader.message, /write or admin access/);
  assert.equal((await f.summarize(14, 'bob', 'not-a-uuid')).status, 400);
  assert.equal((await f.summarize(99)).status, 404);
  f.sql.exec("UPDATE discussions SET state='CLOSED' WHERE id=4");
  assert.equal((await f.summarize()).status, 412);
  assert.equal(f.calls.length, 0);
});

test('the landed section lists recent landings and reverts from land_operations, and open pull requests show their latest land', async t => {
  const f = await fixture(t);
  await f.save();
  let value = await f.inbox();
  assert.deepEqual([value.landed, value.landingHistory, value.truncated.landed], [[], 'available', false]);
  // Rows as the land queue (schema 42) writes them.
  const cols = 'id,repository_id,pull_request_id,number,trigger,actor_id,state,method,head_commit_id,base_commit_id,landed_commit_id,revert_commit_id,attempts,detail,created_at,updated_at';
  f.sql.exec(`INSERT INTO land_operations(${cols}) VALUES('f-1',1,1,14,'policy',0,'LANDED','squash','${feature}','${base}','${'c'.repeat(40)}','',1,'{}','2026-10-14T01:00:00Z','2026-10-14T01:00:00Z'),
      ('b-2',1,1,14,'person',2,'REVERTED','merge','${feature}','${base}','${'d'.repeat(40)}','${'e'.repeat(40)}',1,'{}','2026-10-14T02:00:00Z','2026-10-14T03:00:00Z'),
      ('a-3',1,1,14,'person',2,'QUEUED','merge','${feature}','${base}','','',0,'{}','2026-10-14T04:00:00Z','2026-10-14T04:00:00Z')`);
  value = await f.inbox();
  assert.equal(value.landingHistory, 'available');
  assert.deepEqual(value.landed.map(item => [item.id, item.state, item.trigger, item.actor, item.title, item.landedCommitId.slice(0, 1), item.revertCommitId.slice(0, 1)]),
    [['b-2', 'REVERTED', 'person', 'bob', 'Feature work', 'd', 'e'], ['f-1', 'LANDED', 'policy', '', 'Feature work', 'c', '']]);
  // The open pull request shows its latest land operation.
  assert.deepEqual(value.needsPerson[0].landing, { state: 'QUEUED', updatedAt: '2026-10-14T04:00:00Z' });
  value = await f.inbox({ limit: 1 });
  assert.deepEqual([value.landed.length, value.truncated.landed], [1, true]);
});

test('intent summaries: AI-written once per head commit through the AI runs, bounded input, stored with the model; a new head gets a new one', async t => {
  const f = await fixture(t);
  await f.save();
  assert.equal(intentLimits.diffBytes, 48 * 1024);
  assert.deepEqual((await f.summary()).summary, null);
  const asked = await f.summarize();
  assert.equal(asked.status, 200, asked.message);
  assert.deepEqual([asked.state, asked.headCommitId, asked.run.state], ['RUNNING', feature, 'REQUESTED']);
  // Asking again while it runs does not start another run.
  const again = await f.summarize();
  assert.deepEqual([again.state, again.run], ['RUNNING', { id: asked.run.id, state: 'REQUESTED' }]);
  assert.equal(f.sql.prepare("SELECT count(*) AS n FROM ai_runs WHERE kind='intent-summary'").get().n, 1);
  await f.workflow(asked.run.id);
  // One gateway call with a strict JSON schema; the diff and the description are marked as untrusted data.
  assert.equal(f.calls.length, 1);
  const [call] = f.calls;
  assert.equal(call.model, '@cf/zai-org/glm-5.3'); assert.equal(call.input.response_format.json_schema.name, 'intent_summary'); assert.equal(call.input.response_format.json_schema.strict, true);
  assert.match(call.input.messages[1].content, /You are given 1 of 1 changed files/); assert.match(call.input.messages[1].content, /<untrusted-[0-9a-f]+ label="diff">/);
  assert.deepEqual(call.options.gateway, { id: 'golf-gateway', skipCache: true, collectLog: false });
  const stored = await f.summary();
  assert.deepEqual({ ...stored.summary, createdAt: '' }, { headCommitId: feature, model: '@cf/zai-org/glm-5.3', aiWritten: true, createdAt: '', ...good,
    coverage: { files: 1, totalFiles: 1, bytes: stored.summary.coverage.bytes, limitBytes: 49152, notReadCount: 0, descriptionTruncated: false }, runId: asked.run.id });
  assert.equal(stored.run.state, 'SUCCEEDED');
  // Usage is recorded on the run like every AI kind.
  assert.deepEqual(JSON.parse(f.sql.prepare('SELECT usage FROM ai_runs WHERE id=?').get(asked.run.id).usage), { prompt_tokens: 700, completion_tokens: 90, total_tokens: 790 });
  // The inbox shows it on the pull request for the current head.
  assert.equal((await f.inbox()).needsPerson[0].intent.intent, good.intent);
  // Not regenerated for the same head, by this route or by /native/ai directly.
  const same = await f.summarize();
  assert.deepEqual([same.state, same.summary.intent, same.run], ['STORED', good.intent, null]);
  const direct = await f.rpc('/native/ai', { repository, repositoryId: '1', action: 'create', kind: 'intent-summary', idempotencyKey: crypto.randomUUID(),
    target: { number: 14, pullRequestId: '1', baseCommitId: base, headCommitId: feature } }, tokens.writer);
  assert.equal(direct.status, 412); assert.match(direct.message, /already has an intent summary/);
  assert.equal(f.calls.length, 1);
  // Audited like other AI requests: one row per operation key.
  assert.ok(f.sql.prepare("SELECT count(*) AS n FROM installation_audit WHERE action='ai.run_request' AND subject='intent-summary' AND json_extract(client,'$.outcome')='success'").get().n >= 2);

  // A new head: the old summary stays with its commit, and a new one is written for the new head. The 60 KiB file is not read and is named.
  f.refs.get(artifact).set('refs/heads/feature', next);
  assert.deepEqual([(await f.summary()).headCommitId, (await f.summary()).summary], [next, null]);
  assert.equal((await f.inbox()).needsPerson[0].intent, null);
  f.answers.push({ intent: 'Adds a large text file and greets agents.', areas: ['greeting text', 'fixtures'], risks: [], confidence: 'medium' });
  const fresh = await f.summarize();
  assert.equal(fresh.state, 'RUNNING');
  await f.workflow(fresh.run.id);
  assert.equal(f.calls.length, 2);
  assert.match(f.calls[1].input.messages[1].content, /You are given 1 of 2 changed files/);
  assert.match(f.calls[1].input.messages[1].content, /big\.txt \(over the 48 KiB reading limit\)/);
  const second = (await f.summary()).summary;
  assert.deepEqual([second.headCommitId, second.confidence, second.risks, second.coverage.notReadCount, second.coverage.files, second.coverage.totalFiles], [next, 'medium', [], 1, 1, 2]);
  assert.deepEqual(f.sql.prepare('SELECT head_commit_id FROM pull_intent_summaries ORDER BY head_commit_id').all().map(row => row.head_commit_id), [next, feature].sort());
});

test('a model answer outside the schema is rejected whole and nothing is stored', async t => {
  const f = await fixture(t);
  for (const answer of [{ ...good, approve: true }, { ...good, confidence: 'certain' }, { ...good, areas: Array(9).fill('x') }, { ...good, intent: 'x'.repeat(601) }, 'not json', { ...good, intent: 'bad\u0007bell' }]) {
    f.answers.push(answer);
    const asked = await f.summarize();
    assert.equal(asked.state, 'RUNNING', JSON.stringify(answer));
    await f.workflow(asked.run.id);
    assert.equal((await f.summary()).run.state, 'UNKNOWN', JSON.stringify(answer));
    assert.equal(f.sql.prepare('SELECT count(*) AS n FROM pull_intent_summaries').get().n, 0);
  }
});

test('without Workers AI, or with AI review drafts turned off by a policy, summaries are refused with the reason and nothing runs', async t => {
  const f = await fixture(t, { ai: false });
  await f.save();
  const value = await f.inbox();
  assert.deepEqual(value.summaries, { available: false, reason: 'Workers AI is not enabled on this installation.' });
  const capability = (await f.call('/rpc/golf.v1.CapabilityService/ListCapabilities', {})).capabilities.find(c => c.id === 'repository.agent-inbox');
  assert.equal(capability.state, 'CAPABILITY_STATE_READY'); assert.match(capability.reason, /Intent summaries need Workers AI/);
  const refused = await f.summarize();
  assert.deepEqual([refused.status, refused.message], [412, 'Workers AI is not enabled on this installation.']);
  assert.equal(f.sql.prepare('SELECT count(*) AS n FROM ai_runs').get().n, 0);

  const g = await fixture(t);
  g.sql.exec("INSERT INTO feature_policies(scope,scope_id,feature,mode,version,updated_by,updated_at) VALUES('installation','','ai-review-drafts','DISABLED',1,1,'t')");
  const off = await g.summarize();
  assert.equal(off.status, 412); assert.match(off.message, /AI review drafts/i);
  assert.equal((await g.inbox()).summaries.available, false);
  assert.equal(g.calls.length, 0);
});
