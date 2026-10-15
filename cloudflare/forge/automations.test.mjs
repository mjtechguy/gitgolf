// Automations (docs/AUTOMATIONS.md): definitions and their authority and audit, events from where Golf records them, schedules from
// the maintenance sweep, limits, the kill switch, the feature policy, and whole runs of the four built-in tools and custom ones with
// a mocked model, a mocked engines registry and an agent host. node:sqlite as D1 over the real schema; a small in-memory Git server.
import * as realEngines from './src/engines.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { objectFixture, origin, repository } from './object-fixture.mjs';
import { handle, serialize, concurrentRead, advanceAutomations, advanceAi } from './src/core.mjs';
import { packetLine } from './src/git.mjs';
import { emitAutomationEvent, sweepAutomations, inferAutomationRuns } from './src/automations.mjs';
import { useEngines } from './src/automation-engines.mjs';
import { runAiWorkflow } from './src/ai-workflow.mjs';
import { withInstallationPolicy } from './src/installation.mjs';
import { advanceRunNow, logKey } from './src/pipelines.mjs';
import { memoryBucket } from './pipeline-fixture.mjs';

const base = 'a'.repeat(40), feature = 'b'.repeat(40), next = 'c'.repeat(40), proposal = 'd'.repeat(40), uuid = () => crypto.randomUUID();
const tools = [{ tool: 'claude', version: '2.1.0', signedIn: true, account: '' }, { tool: 'codex', version: '0.50.0', signedIn: null }];

async function fixture(t, { answer = async () => ({ response: 'ok' }) } = {}) {
  const f = await objectFixture(t);
  f.sql.exec(`UPDATE users SET email=login||'@example.invalid'; INSERT INTO operations_admins(user_id) VALUES(1);
    INSERT INTO native_owners(id,slug,kind,user_id,creator_id) VALUES(1,'alice','PERSONAL',1,1); INSERT INTO native_owners(id,slug,kind,creator_id) VALUES(2,'team','ORGANIZATION',1);
    INSERT INTO native_owner_members VALUES(2,1,'owner'),(2,2,'member'); INSERT INTO repository_owners VALUES(1,1);
    INSERT INTO repositories(id,name,description,artifact_name,creator_id,creation_key,input_hash,state,created_at) VALUES(2,'tooling','','repo-${'e'.repeat(32)}',1,'k2','h2','ACTIVE','2026-10-14T00:00:00Z');
    INSERT INTO repository_owners VALUES(2,2); INSERT INTO grants VALUES(2,1,'admin'),(2,2,'write');
    INSERT INTO discussions(id,repository_id,number,kind,author_id,title,body,state,created_at,updated_at) VALUES(1,1,12,'issue',2,'Parser crashes','It crashes.','OPEN','t','t'),
      (2,1,14,'pull',1,'Feature work','Adds the feature.','OPEN','t','t'),(3,2,1,'issue',1,'Organization issue','A longer description of the organization issue.','OPEN','t','t');
    INSERT INTO pull_requests(id,discussion_id,base_branch,head_branch,base_commit,head_commit,draft) VALUES(1,2,'main','feature','${base}','${feature}',0);
    INSERT INTO discussion_resources(id,repository_id,kind,name,payload) VALUES(1,1,'label','bug','{"name":"bug","color":"d73a4a","description":"Something is broken"}'),
      (2,1,'label','docs','{"name":"docs","color":"0075ca","description":"Documentation"}')`);
  const refs = new Map([['repo-' + 'b'.repeat(32), new Map([['refs/heads/main', base], ['refs/heads/feature', feature]])], ['repo-' + 'e'.repeat(32), new Map([['refs/heads/main', base]])]]);
  const commits = new Map([[base, []], [feature, [base]], [next, [feature]], [proposal, [base]]]), pushes = [];
  f.env.ARTIFACTS = { async get(name) { return { async info() { return { name, remote: `https://${f.env.ACCOUNT_ID}.artifacts.cloudflare.net/git/test-space/${name}.git` }; },
    async createToken() { return { plaintext: 'art_v1_token' }; }, async revokeToken() { return true; }, [Symbol.dispose]() {},
    async readCommit(hash) { return commits.has(hash) ? { hash, treeHash: (f.trees.get(hash) || 'f'.repeat(40)), parents: commits.get(hash), message: '' } : null; },
    async readTree(hash) { return f.treeEntries.get(hash) || []; } }; } };
  f.trees = new Map(); f.treeEntries = new Map();
  const providerFetch = async (input, init = {}) => {
    const url = new URL(input), name = /\/([^/]+)\.git\//.exec(url.pathname)[1], current = refs.get(name);
    if (url.pathname.endsWith('/info/refs')) {
      const service = url.searchParams.get('service');
      return new Response(Buffer.concat([packetLine(`# service=${service}\n`), Buffer.from('0000'), ...[...current].map(([ref, hash], i) => packetLine(`${hash} ${ref}${i ? '' : '\0report-status side-band-64k'}\n`)), Buffer.from('0000')]),
        { headers: { 'Content-Type': `application/x-${service}-advertisement` } });
    }
    if (url.pathname.endsWith('/git-receive-pack')) {
      const [old, value, ref] = Buffer.from(init.body).subarray(4).toString().split('\0')[0].split(' ');
      pushes.push({ name, old, next: value, ref }); current.set(ref, value);
      return new Response(Buffer.concat([packetLine('unpack ok\n'), packetLine(`ok ${ref}\n`), Buffer.from('0000')]), { headers: { 'Content-Type': 'application/x-git-receive-pack-result' } });
    }
    return new Response(Buffer.from('0008NAK\n'), { headers: { 'Content-Type': 'application/x-git-upload-pack-result' } });
  };
  // Collaboration reads refs through the global fetch.
  const fetched = globalThis.fetch; globalThis.fetch = providerFetch; t.after(() => { globalThis.fetch = fetched; });
  const calls = [], created = [];
  Object.assign(f.env, { EVIDENCE_ALLOW_AI: 'true', EVIDENCE_GATEWAY: 'golf-gateway',
    AI: { async run(model, input, options) { calls.push({ model, input, options }); return answer(model, input); } },
    AiWorkflow: { async create({ id }) { created.push(id); }, async get() { return { status: async () => ({ status: 'queued' }) }; } } });
  const queued = []; f.env.automationsQueued = () => queued.push(Date.now());
  const dispatch = serialize(request => handle(request, f.env, providerFetch), concurrentRead);
  const signed = async (path, body, who = 'alice') => {
    const response = await dispatch(new Request(origin + path, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Connect-Protocol-Version': '1', 'X-Golf-Native-Access-Email': who + '@example.invalid' }, body: JSON.stringify(body) }));
    return { status: response.status, ...await response.json() };
  };
  const repo = (body, who = 'alice', key = repository, id = '1') => signed('/native/automations', { scope: 'repository', repository: key, repositoryId: id, ...body }, who);
  const read = (body, who = 'alice', key = repository, id = '1') => signed('/native/automations/read', { scope: 'repository', repository: key, repositoryId: id, ...body }, who);
  const machine = async (path, body, credential) => {
    const response = await dispatch(new Request(origin + '/native/agent-host/' + path, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(credential ? { Authorization: 'Bearer ' + credential } : {}) }, body: JSON.stringify(body) }));
    return { status: response.status, ...await response.json() };
  };
  const connect = async (who = 'alice') => {
    const created = await signed('/native/agent-hosts', { action: 'createToken', scope: 'personal' }, who);
    const host = await machine('register', { registrationToken: created.token, name: `${who}-box`, hostVersion: '0.1.0', os: 'linux', arch: 'amd64' });
    assert.equal((await machine('heartbeat', { tools }, host.credential)).status, 200);
    return host;
  };
  // Create, then turn on (both as alice unless said otherwise).
  const enabled = async (body, who = 'alice') => {
    const made = await repo({ action: 'create', ...body }, who);
    assert.equal(made.status, 200, JSON.stringify(made));
    const on = await repo({ action: 'setEnabled', id: made.automation.id, expectedVersion: made.automation.version, enabled: true }, who);
    assert.equal(on.status, 200, JSON.stringify(on));
    return on.automation;
  };
  const process = () => advanceAutomations(f.env, providerFetch);
  const workflow = id => runAiWorkflow({ instanceId: id, payload: { runId: id } }, { async do(name, options, action) { return JSON.parse(JSON.stringify(await action())); } },
    f.env, { ai: (runId, phase, result) => advanceAi(f.env, runId, phase, result) }, withInstallationPolicy);
  const runs = automationId => f.sql.prepare('SELECT * FROM automation_runs WHERE automation_id=? ORDER BY created_at,rowid').all(automationId);
  const rpc = (method, body, who = 'alice') => signed('/rpc/golf.v1.RepositoryService/' + method, { repository, repositoryId: '1', ...body }, who);
  return { ...f, refs, commits, pushes, providerFetch, dispatch, signed, repo, read, machine, connect, enabled, process, workflow, runs, calls, created, queued, rpc };
}

test('repository administrators manage automations; writers read them; created off; audited without instructions', async t => {
  const f = await fixture(t);
  const made = await f.repo({ action: 'create', tool: 'issue-triage', instructions: 'Secret-ish instructions text' });
  assert.equal(made.status, 200, JSON.stringify(made));
  const a = made.automation;
  assert.deepEqual([a.tool, a.name, a.enabled, a.killSwitch, a.engine, a.place, a.output, a.trigger.events, a.owner.login, a.instructionsVersion], ['issue-triage', 'Issue triage', false, false, 'default', 'cloud', ['comment'], ['issue.opened'], 'alice', 1]);
  // bob writes: reads the inventory, may not change it; carol reads the repository only: neither.
  const listed = await f.read({ action: 'list' }, 'bob');
  assert.equal(listed.status, 200); assert.equal(listed.canManage, false); assert.equal(listed.automations.length, 1);
  assert.deepEqual(listed.tools.map(tool => tool.id), ['pr-reviewer', 'issue-triage', 'issue-to-pr', 'ci-fixer', 'custom']);
  assert.ok(listed.engines.some(engine => engine.id === 'default') && listed.engines.some(engine => engine.id === 'claude' && engine.kind === 'cli'));
  assert.equal((await f.repo({ action: 'create', tool: 'pr-reviewer' }, 'bob')).status, 403);
  assert.equal((await f.read({ action: 'list' }, 'carol')).status, 403);
  // The read route only reads; the change route only changes.
  assert.equal((await f.read({ action: 'create', tool: 'pr-reviewer' })).status, 400);
  assert.equal((await f.repo({ action: 'list' })).status, 400);
  // Versioned instructions: a change is a new version, the old text stays readable.
  const updated = await f.repo({ action: 'update', id: a.id, expectedVersion: a.version, instructions: 'Second version', name: 'Triage' });
  assert.equal(updated.status, 200, JSON.stringify(updated)); assert.equal(updated.automation.instructionsVersion, 2);
  assert.equal((await f.repo({ action: 'update', id: a.id, expectedVersion: a.version, name: 'Stale' })).status, 412);
  const got = await f.read({ action: 'get', id: a.id });
  assert.equal(got.automation.instructions, 'Second version'); assert.deepEqual(got.instructionVersions.map(v => [v.version, v.current]), [[2, true], [1, false]]);
  assert.equal((await f.read({ action: 'instructions', id: a.id, version: 1 })).text, 'Secret-ish instructions text');
  // Another repository's id is not found here.
  assert.equal((await f.read({ action: 'get', id: a.id }, 'alice', { owner: 'team', name: 'tooling' }, '2')).status, 404);
  const audit = f.sql.prepare("SELECT action,scope,scope_id,subject,before,after FROM installation_audit WHERE action LIKE 'automation.%' ORDER BY id").all();
  assert.deepEqual(audit.map(row => [row.action, row.scope, row.scope_id]), [['automation.create', 'repository', '1'], ['automation.create', 'repository', '1'], ['automation.update', 'repository', '1']]);
  assert.ok(!JSON.stringify(audit).includes('Secret-ish') && !JSON.stringify(audit).includes('Second version'));
  assert.equal(JSON.parse(audit[2].after).instructionsChanged, true);
  const log = await f.signed('/native/audit/read', { scope: 'installation', filters: { category: 'automation' } });
  assert.equal(log.status, 200); assert.ok(log.entries.every(entry => entry.categoryLabel === 'Automations'));
  // Delete: gone from the inventory, audited.
  assert.equal((await f.repo({ action: 'delete', id: a.id })).status, 200);
  assert.equal((await f.read({ action: 'list' })).automations.length, 0);
});

test('organization owners and operations administrators manage their scopes; members only read', async t => {
  const f = await fixture(t);
  const org = body => f.signed('/native/automations', { scope: 'organization', organization: 'team', ...body });
  const made = await org({ action: 'create', tool: 'issue-triage', target: { repositories: ['team/tooling'] } });
  assert.equal(made.status, 200, JSON.stringify(made)); assert.deepEqual(made.automation.target.repositories, ['team/tooling']);
  assert.equal((await org({ action: 'create', tool: 'issue-triage', target: { repositories: ['alice/project'] } })).status, 400);
  assert.equal((await f.signed('/native/automations/read', { scope: 'organization', organization: 'team', action: 'list' }, 'bob')).canManage, false);
  assert.equal((await f.signed('/native/automations', { scope: 'organization', organization: 'team', action: 'create', tool: 'pr-reviewer' }, 'bob')).status, 403);
  const installation = await f.signed('/native/automations', { scope: 'installation', action: 'create', tool: 'pr-reviewer' });
  assert.equal(installation.status, 200);
  assert.equal((await f.signed('/native/automations/read', { scope: 'installation', action: 'list' }, 'bob')).status, 403);
  // A repository lists the wider automations that reach it, read-only.
  const tooling = await f.read({ action: 'list' }, 'alice', { owner: 'team', name: 'tooling' }, '2');
  assert.deepEqual(tooling.inherited.map(a => a.scope).sort(), ['installation', 'organization']);
  assert.deepEqual((await f.read({ action: 'list' })).inherited.map(a => a.scope), ['installation']);
  const audit = f.sql.prepare("SELECT action,scope,scope_id FROM installation_audit WHERE action='automation.create' ORDER BY id").all();
  // The refused create (a repository outside the organization) is a validation refusal, which the audit log does not record.
  assert.deepEqual(audit.map(row => [row.scope, row.scope_id]), [['organization', '2'], ['organization', '2'], ['installation', 'alice']]);
});

test('engines and places are validated honestly: cloud sandboxes are phase 3, SSH hosts are not available, the registry is optional', async t => {
  const f = await fixture(t);
  const host = await f.connect();
  assert.match((await f.repo({ action: 'create', tool: 'issue-to-pr', engine: 'claude', place: 'cloud' })).message, /phase 3/);
  assert.match((await f.repo({ action: 'create', tool: 'issue-to-pr', engine: 'claude', place: 'ssh-host' })).message, /SSH hosts are not available/);
  assert.equal((await f.repo({ action: 'create', tool: 'issue-to-pr', engine: 'default' })).status, 400);
  assert.equal((await f.repo({ action: 'create', tool: 'pr-reviewer', engine: 'claude', place: 'agent-host', hostId: host.hostId })).status, 400);
  const unknown = await f.repo({ action: 'create', tool: 'pr-reviewer', engine: 'some-provider-model' });
  assert.equal(unknown.status, 412); assert.match(unknown.message, /not available in this scope/);
  assert.equal((await f.repo({ action: 'create', tool: 'issue-to-pr', engine: 'claude', place: 'agent-host', hostId: '999' })).status, 412);
  const ok = await f.repo({ action: 'create', tool: 'issue-to-pr', engine: 'claude', place: 'agent-host', hostId: host.hostId });
  assert.equal(ok.status, 200); assert.deepEqual([ok.automation.output, ok.automation.limits.maxOpenPRs, ok.automation.approvals], [['draft-pr'], 3, { draftOnly: true, allowLanding: false }]);
  assert.equal((await f.repo({ action: 'create', tool: 'issue-to-pr', engine: 'claude', place: 'agent-host', hostId: host.hostId, limits: { maxOpenPRs: 0 } })).status, 400);
  assert.equal((await f.repo({ action: 'create', tool: 'issue-triage', approvals: { allowLanding: true } })).status, 400);
  assert.equal((await f.repo({ action: 'create', tool: 'issue-triage', approvals: { draftOnly: false } })).status, 400);
  assert.equal((await f.repo({ action: 'create', tool: 'issue-triage', trigger: { events: ['push'] } })).status, 400);
  assert.equal((await f.repo({ action: 'create', tool: 'issue-to-pr', engine: 'claude', place: 'agent-host', hostId: host.hostId, trigger: { events: [], schedule: { everyMinutes: 60 } } })).status, 400);
  assert.equal((await f.repo({ action: 'create', tool: 'custom', trigger: { events: [], schedule: { everyMinutes: 5 } } })).status, 400);
  assert.equal((await f.repo({ action: 'create', tool: 'custom', output: ['draft-pr'] })).status, 400);
  assert.equal((await f.repo({ action: 'create', tool: 'pr-reviewer', target: { branches: ['../x'] } })).status, 400);
  // With a registry registered, its engines are offered and accepted.
  useEngines({ listEngines: async () => [{ id: 'provider:gpt', label: 'Provider model' }], resolveEngine: async () => ({}), runChat: async () => ({ text: '' }) }); t.after(() => useEngines(realEngines));
  const listed = await f.read({ action: 'list' });
  assert.ok(listed.enginesRegistered && listed.engines.some(engine => engine.id === 'provider:gpt'));
  assert.equal((await f.repo({ action: 'create', tool: 'pr-reviewer', engine: 'provider:gpt' })).status, 200);
  // An automation without events or a schedule cannot be turned on.
  const empty = await f.repo({ action: 'create', tool: 'custom', trigger: { events: [] } });
  assert.equal((await f.repo({ action: 'setEnabled', id: empty.automation.id, expectedVersion: 1, enabled: true })).status, 412);
});

test('events: issue and pull request creation, pushes (pull_request.updated), review requests and failed runs queue matching runs once', async t => {
  const f = await fixture(t);
  const triage = await f.enabled({ tool: 'issue-triage' });
  const reviewer = await f.enabled({ tool: 'pr-reviewer', trigger: { events: ['pull_request.opened', 'pull_request.updated', 'pull_request.review_requested'] }, target: { branches: ['main'] } });
  const pushes = await f.enabled({ tool: 'custom', trigger: { events: ['push'] } });
  // An issue created through the API queues triage; nothing else listens.
  const issue = await f.rpc('CreateIssue', { title: 'New bug', body: '', idempotencyKey: uuid() });
  assert.equal(issue.status, 200, JSON.stringify(issue));
  assert.deepEqual(f.runs(triage.id).map(r => [r.trigger, r.target_kind, r.target_number, r.state]), [['issue.opened', 'issue', issue.mutation.number, 'QUEUED']]);
  assert.ok(f.queued.length >= 1);
  // A pull request into main queues a review of its head.
  f.refs.get('repo-' + 'b'.repeat(32)).set('refs/heads/topic', next);
  const pull = await f.rpc('CreatePullRequest', { title: 'Topic', body: '', sourceRepositoryId: '1', sourceRepository: repository, baseBranch: 'main', headBranch: 'topic',
    baseCommitId: base, headCommitId: next, idempotencyKey: uuid() });
  assert.equal(pull.status, 200, JSON.stringify(pull));
  assert.deepEqual(f.runs(reviewer.id).map(r => [r.trigger, r.target_number, r.target_commit]), [['pull_request.opened', pull.mutation.number, next]]);
  // A push to the head branch of open pull requests is their pull_request.updated, and a push for push listeners; replays dedupe.
  const event = { type: 'push', repositoryId: 1, ref: 'refs/heads/feature', before: feature, after: proposal, actorId: 1 };
  assert.equal(await emitAutomationEvent(f.env, event), 2);
  assert.equal(await emitAutomationEvent(f.env, event), 0);
  assert.deepEqual(f.runs(reviewer.id).at(-1).trigger, 'pull_request.updated'); assert.equal(f.runs(reviewer.id).at(-1).target_commit, proposal);
  assert.deepEqual(f.runs(pushes.id).map(r => [r.trigger, r.target_kind, r.target_commit]), [['push', 'commit', proposal]]);
  // A branch written through the Source API is a push too (the Git route records it at the same point).
  const branch = await f.signed('/native/source/branch', { repository, repositoryId: '1', action: 'create', branch: 'topic2', from: 'main' });
  assert.equal(branch.status, 200, JSON.stringify(branch));
  assert.deepEqual(f.runs(pushes.id).map(r => JSON.parse(r.event).ref), ['refs/heads/feature', 'refs/heads/topic2']);
  // The same head again is skipped by its key (unchanged head); review_requested for that head adds nothing.
  assert.equal(await emitAutomationEvent(f.env, { type: 'pull_request.review_requested', repositoryId: 1, number: 14, headCommit: proposal }), 0);
  assert.equal(await emitAutomationEvent(f.env, { type: 'pull_request.review_requested', repositoryId: 1, number: 14, headCommit: 'e'.repeat(40) }), 1);
  // Branch filter: a pull request into another base branch is outside the target.
  f.sql.exec("UPDATE pull_requests SET base_branch='release' WHERE id=1");
  assert.equal(await emitAutomationEvent(f.env, { type: 'pull_request.review_requested', repositoryId: 1, number: 14, headCommit: '9'.repeat(40) }), 0);
  // Another repository's events never reach this repository's automations; a disabled automation hears nothing.
  assert.equal(await emitAutomationEvent(f.env, { type: 'issue.opened', repositoryId: 2, number: 1 }), 0);
  await f.repo({ action: 'setEnabled', id: triage.id, expectedVersion: (await f.read({ action: 'get', id: triage.id })).automation.version, enabled: false });
  assert.equal(await emitAutomationEvent(f.env, { type: 'issue.opened', repositoryId: 1, number: 12 }), 0);
});

test('a failed Actions run is the pipeline.failed event, from the run coordinator', async t => {
  const f = await fixture(t);
  Object.assign(f.env, { PIPELINES_ENABLED: 'true', PIPELINE_BUCKET: memoryBucket() });
  const host = await f.connect();
  const fixer = await f.enabled({ tool: 'ci-fixer', engine: 'claude', place: 'agent-host', hostId: host.hostId });
  f.sql.exec(`INSERT INTO pipeline_runs(id,repository_id,artifact_name,engine,number,workflow_path,workflow_name,event,ref,commit_id,actor_id,trusted,state,created_at,updated_at)
    VALUES(7,1,'repo-${'b'.repeat(32)}','forgejo-actions',3,'.github/workflows/ci.yml','CI','push','refs/heads/main','${base}',1,1,'RUNNING','t','t');
    INSERT INTO pipeline_jobs(id,run_id,attempt,engine,job_key,name,payload,state,created_at,updated_at) VALUES(70,7,1,'forgejo-actions','test','test','{}','FAILURE','t','t')`);
  assert.equal((await advanceRunNow(f.env, 7)).state, 'FAILURE');
  assert.deepEqual(f.runs(fixer.id).map(r => [r.trigger, r.target_kind, r.target_number, r.target_commit]), [['pipeline.failed', 'pipeline_run', 7, base]]);
});

test('Run now acts as the person who pressed it, while the automation is off; the kill switch refuses it', async t => {
  const f = await fixture(t);
  const made = (await f.repo({ action: 'create', tool: 'issue-triage' })).automation;
  const run = await f.repo({ action: 'run', id: made.id, target: { kind: 'issue', number: 12 } });
  assert.equal(run.status, 200, JSON.stringify(run));
  assert.deepEqual([run.run.trigger, run.run.state, run.run.requestedBy, run.run.target.kind, run.run.target.number], ['manual', 'QUEUED', 'alice', 'issue', 12]);
  assert.equal((await f.repo({ action: 'run', id: made.id, target: { kind: 'pull_request', number: 14 } })).status, 400);
  assert.equal((await f.repo({ action: 'run', id: made.id, target: { kind: 'issue', number: 99 } })).status, 400);
  assert.equal((await f.repo({ action: 'killSwitch', id: made.id, engaged: true })).automation.killSwitch, true);
  assert.equal(f.runs(made.id)[0].state, 'SKIPPED');
  assert.match((await f.repo({ action: 'run', id: made.id, target: { kind: 'issue', number: 12 } })).message, /kill switch/);
  assert.equal((await f.repo({ action: 'killSwitch', id: made.id, engaged: false })).automation.killSwitch, false);
  assert.deepEqual(f.sql.prepare("SELECT action FROM installation_audit WHERE action LIKE 'automation.%' ORDER BY id").all().map(row => row.action),
    ['automation.create', 'automation.run', 'automation.kill_switch', 'automation.release_kill_switch']);
});

test('issue triage end to end: Clef suggestions apply one confident label and comment, labelled and neutralized', async t => {
  const f = await fixture(t, { answer: async () => ({ answers: { label: { type: 'choice', choice: 'l1', probabilities: { l1: 0.86, l2: 0.04, none: 0.1 } } } }) });
  const triage = await f.enabled({ tool: 'issue-triage', output: ['labels', 'comment'] });
  await emitAutomationEvent(f.env, { type: 'issue.opened', repositoryId: 1, number: 12 });
  const started = await f.process();
  assert.equal(started.started, 1);
  let [run] = f.runs(triage.id);
  assert.deepEqual([run.state, run.phase, run.engine], ['RUNNING', 'wait-ai', 'default']);
  const aiRun = JSON.parse(run.outputs).aiRunId;
  assert.deepEqual({ ...f.sql.prepare('SELECT kind,user_id,state FROM ai_runs WHERE id=?').get(aiRun) }, { kind: 'triage', user_id: 1, state: 'REQUESTED' });
  // Still waiting until the AI run settles.
  assert.equal((await f.process()).advanced, 0);
  await f.workflow(aiRun);
  await f.process();
  [run] = f.runs(triage.id);
  assert.equal(run.state, 'SUCCEEDED', run.reason);
  assert.match(run.reason, /Labelled bug/);
  assert.deepEqual(f.sql.prepare('SELECT label_id FROM discussion_labels WHERE discussion_id=1').all().map(row => row.label_id), [1]);
  const comment = f.sql.prepare('SELECT body,author_id FROM discussion_comments WHERE discussion_id=1 ORDER BY id DESC').get();
  assert.equal(comment.author_id, 1);
  assert.match(comment.body, /^> Automation \*\*Issue triage\*\* \(Issue triage\) wrote this\. It is automated and unverified/);
  assert.match(comment.body, /Applied the label bug\./);
  assert.match(comment.body, /semantic search is not available/);
  assert.match(comment.body, /little detail/);
  const outputs = JSON.parse(run.outputs);
  assert.deepEqual([outputs.labels, outputs.duplicates, typeof outputs.commentId], [['bug'], null, 'string']);
  // A second pass changes nothing; the same issue again is deduplicated.
  await f.process();
  assert.equal(f.sql.prepare('SELECT count(*) AS n FROM discussion_comments WHERE discussion_id=1').get().n, 1);
  assert.equal(await emitAutomationEvent(f.env, { type: 'issue.opened', repositoryId: 1, number: 12 }), 0);
});

test('the PR reviewer drafts a review as the owner on the current head; a comment output posts the neutralized text', async t => {
  const f = await fixture(t);
  const reviewer = await f.enabled({ tool: 'pr-reviewer', output: ['review', 'comment'] });
  await emitAutomationEvent(f.env, { type: 'pull_request.opened', repositoryId: 1, number: 14, headCommit: feature });
  await f.process();
  let [run] = f.runs(reviewer.id);
  assert.deepEqual([run.state, run.phase], ['RUNNING', 'wait-ai']);
  const aiRun = JSON.parse(run.outputs).aiRunId, stored = f.sql.prepare('SELECT kind,user_id,target FROM ai_runs WHERE id=?').get(aiRun);
  assert.deepEqual([stored.kind, stored.user_id, JSON.parse(stored.target)], ['review-draft', 1, { number: 14, pullRequestId: '1', baseCommitId: base, headCommitId: feature }]);
  // The draft run succeeds (stood in for here: the diff read is ai-review's own test); its output is the reviewer's to apply.
  const output = { summary: 'Looks fine. See [docs](https://evil.example) @admin <b>x</b>', findings: [{ path: 'a.js', line: 3, severity: 'low', title: 'Typo', evidence: 'A typo in a comment.', suggestion: '' }],
    markdown: 'Looks fine.\n\n**Findings**\n\n- **Low** `a.js:3`: Typo\n  A typo in a comment.\n', read: {}, commits: { base, mergeBase: base, head: feature } };
  f.sql.prepare("UPDATE ai_runs SET state='SUCCEEDED',output=?,usage=? WHERE id=?").run(JSON.stringify(output), JSON.stringify({ prompt_tokens: 900, completion_tokens: 120 }), aiRun);
  await f.process();
  [run] = f.runs(reviewer.id);
  assert.equal(run.state, 'SUCCEEDED', run.reason); assert.match(run.reason, /1 finding, posted as a comment, drafted for review/);
  assert.deepEqual(JSON.parse(run.usage), { inputTokens: 900, outputTokens: 120, reported: true });
  const comment = f.sql.prepare('SELECT body FROM discussion_comments WHERE discussion_id=2').get();
  assert.match(comment.body, /Looks fine\./);
  // The run's view keeps the review for the runs table.
  const view = (await f.read({ action: 'runs' })).runs[0];
  assert.equal(view.outputs.review.findings[0].title, 'Typo'); assert.equal(view.usage.inputTokens, 900); assert.equal(view.target.url, `${origin}/alice/project/pull/14`);
  // A head that moved past the queued commit is skipped; the newer head has its own run.
  assert.equal(await emitAutomationEvent(f.env, { type: 'push', repositoryId: 1, ref: 'refs/heads/feature', before: feature, after: 'e'.repeat(40) }), 1);
  await f.process();
  assert.match(f.runs(reviewer.id).at(-1).reason, /moved past/);
});

test('limits: the daily budget, concurrency, open draft pull requests, and the feature policy', async t => {
  const f = await fixture(t);
  const triage = await f.enabled({ tool: 'issue-triage', limits: { perDay: 1, concurrency: 1 } });
  f.sql.exec(`INSERT INTO discussions(id,repository_id,number,kind,author_id,title,body,state,created_at,updated_at) VALUES(10,1,20,'issue',1,'Two','Second issue body text here.','OPEN','t','t'),(11,1,21,'issue',1,'Three','Third issue body text here.','OPEN','t','t')`);
  for (const number of [12, 20, 21]) await emitAutomationEvent(f.env, { type: 'issue.opened', repositoryId: 1, number });
  await f.process();
  assert.deepEqual(f.runs(triage.id).map(r => r.state), ['RUNNING', 'SKIPPED', 'SKIPPED']);
  assert.match(f.runs(triage.id)[1].reason, /daily budget of 1 run is used/);
  // Concurrency: a second run waits in the queue while one runs.
  f.sql.prepare("UPDATE automations SET limits=? WHERE id=?").run(JSON.stringify({ perDay: 10, concurrency: 1, maxOpenPRs: 0, dedupeWindow: 0 }), triage.id);
  await f.repo({ action: 'run', id: triage.id, target: { kind: 'issue', number: 20 } });
  await f.process();
  assert.equal(f.runs(triage.id).at(-1).state, 'QUEUED');
  // Max open pull requests: an Issue → PR automation with one open draft from it skips the next.
  const host = await f.connect();
  const toPR = await f.enabled({ tool: 'issue-to-pr', engine: 'claude', place: 'agent-host', hostId: host.hostId, limits: { maxOpenPRs: 1 } });
  f.sql.prepare("INSERT INTO automation_runs(id,automation_id,repository_id,trigger,state,outputs,dedupe_key,created_at,updated_at) VALUES(?,?,1,'issue.opened','SUCCEEDED',?,'x',?,?)").run(uuid(), toPR.id, JSON.stringify({ pullNumber: 14 }), '2026-10-01', '2026-10-01');
  await emitAutomationEvent(f.env, { type: 'issue.opened', repositoryId: 1, number: 21 });
  await f.process();
  assert.match(f.runs(toPR.id).at(-1).reason, /1 draft pull request from this automation is open \(limit 1\)/);
  // The feature policy: off at the installation queues nothing, refuses creation and refuses runs already queued.
  await f.repo({ action: 'run', id: toPR.id, target: { kind: 'issue', number: 12 } });
  f.sql.exec("INSERT INTO feature_policies(scope,scope_id,feature,mode,version,updated_by,updated_at) VALUES('installation','','automations','DISABLED',1,1,'t')");
  assert.equal(await emitAutomationEvent(f.env, { type: 'issue.opened', repositoryId: 1, number: 20 }), 0);
  const refused = await f.repo({ action: 'create', tool: 'pr-reviewer' });
  assert.equal(refused.status, 412); assert.match(refused.message, /turned off for this repository by the installation policy/);
  await f.process();
  assert.equal(f.runs(toPR.id).at(-1).state, 'REFUSED'); assert.match(f.runs(toPR.id).at(-1).reason, /installation policy/);
  const listed = await f.read({ action: 'list' });
  assert.equal(listed.featureOn, false); assert.match(listed.featureReason, /installation policy/);
});

test('schedules: the maintenance sweep queues one run per due slot and target repository; reviewers fan out to unreviewed heads', async t => {
  const f = await fixture(t);
  const reviewer = await f.enabled({ tool: 'pr-reviewer', trigger: { events: [], schedule: { everyMinutes: 60 } } });
  const stored = f.sql.prepare('SELECT next_run_at FROM automations WHERE id=?').get(reviewer.id);
  assert.ok(stored.next_run_at > Date.now() + 59 * 60_000);
  assert.equal((await sweepAutomations(f.env)).processed, 0);
  f.sql.prepare('UPDATE automations SET next_run_at=? WHERE id=?').run(Date.now() - 1000, reviewer.id);
  const swept = await sweepAutomations(f.env);
  assert.equal(swept.processed, 1); assert.equal(swept.pending, 1);
  assert.ok(f.sql.prepare('SELECT next_run_at FROM automations WHERE id=?').get(reviewer.id).next_run_at > Date.now() + 59 * 60_000);
  assert.equal((await sweepAutomations(f.env)).processed, 0);
  await f.process();
  const all = f.runs(reviewer.id);
  assert.deepEqual(all.map(r => [r.trigger, r.target_kind, r.state]), [['schedule', 'repository', 'SUCCEEDED'], ['schedule', 'pull_request', 'QUEUED']]);
  assert.match(all[0].reason, /Queued reviews of #14/);
  // The scheduled item shares the event key: the same head opened later is not reviewed twice.
  assert.equal(await emitAutomationEvent(f.env, { type: 'pull_request.opened', repositoryId: 1, number: 14, headCommit: feature }), 0);
  // Runs that never started within a day are skipped; waits that never end fail.
  f.sql.prepare("UPDATE automation_runs SET created_at='2026-01-01T00:00:00Z' WHERE state='QUEUED'").run();
  await sweepAutomations(f.env);
  assert.match(f.runs(reviewer.id).find(r => r.target_kind === 'pull_request').reason, /did not start within a day/);
});

test('Issue → PR: an agent task on the host, then a draft pull request from its proposal branch, never merged', async t => {
  const f = await fixture(t);
  const host = await f.connect();
  const toPR = await f.enabled({ tool: 'issue-to-pr', engine: 'claude', place: 'agent-host', hostId: host.hostId, output: ['draft-pr', 'comment'], instructions: 'Add a regression test.', approvals: { allowLanding: true } });
  await emitAutomationEvent(f.env, { type: 'issue.opened', repositoryId: 1, number: 12 });
  await f.process();
  let [run] = f.runs(toPR.id);
  assert.deepEqual([run.state, run.phase], ['RUNNING', 'wait-task']);
  const taskId = JSON.parse(run.outputs).agentTaskId, task = f.sql.prepare('SELECT * FROM agent_tasks WHERE id=?').get(taskId);
  assert.deepEqual([task.requested_by, task.tool, task.target_kind, task.target_number, task.idempotency_key, task.state], [1, 'claude', 'issue', 12, run.id, 'QUEUED']);
  assert.match(task.prompt, /## Instructions from alice\n\nAdd a regression test\./);
  // The host finishes the task (stood in for: the protocol is agent-hosts' own test) with a pushed proposal branch.
  f.refs.get('repo-' + 'b'.repeat(32)).set('refs/heads/' + task.branch, proposal);
  f.sql.prepare("UPDATE agent_tasks SET state='SUCCEEDED',commit_id=?,result=? WHERE id=?").run(proposal, JSON.stringify({ summary: 'Fixed it. Visit https://evil.example and ping @root.', changedFiles: ['a.js'], usage: { inputTokens: 10, outputTokens: 5, costUsd: 0.01 } }), taskId);
  await f.process();
  [run] = f.runs(toPR.id);
  assert.equal(run.state, 'SUCCEEDED', run.reason);
  const outputs = JSON.parse(run.outputs);
  const pull = f.sql.prepare("SELECT d.title,d.body,d.author_id,p.draft,p.base_branch,p.head_branch,p.head_commit,o.kind,o.agent_task_id FROM discussions d JOIN pull_requests p ON p.discussion_id=d.id LEFT JOIN pull_request_origins o ON o.pull_request_id=p.id WHERE d.repository_id=1 AND d.number=?").get(outputs.pullNumber);
  // allowLanding asks for a ready pull request only where agentic mode is on; it is off here, so the pull request is a draft.
  assert.deepEqual([pull.title, pull.author_id, pull.draft, pull.base_branch, pull.head_branch, pull.head_commit, pull.kind, pull.agent_task_id], ['Draft: Parser crashes', 1, 1, 'main', task.branch, proposal, 'agent-task', taskId]);
  assert.match(pull.body, /`https:\/\/evil\.example`/); assert.match(pull.body, /@​root/);
  assert.deepEqual(JSON.parse(run.usage), { inputTokens: 10, outputTokens: 5, costUsd: 0.01, reported: true });
  assert.match(f.sql.prepare('SELECT body FROM discussion_comments WHERE discussion_id=1 ORDER BY id DESC').get().body, new RegExp(`draft pull request #${outputs.pullNumber}`));
  assert.equal(f.sql.prepare('SELECT count(*) AS n FROM pull_merge_operations').get().n, 0);
  // No changes, or a failed task: no pull request.
  await f.repo({ action: 'run', id: toPR.id, target: { kind: 'issue', number: 12 } });
  await f.process();
  const second = f.runs(toPR.id).at(-1), secondTask = JSON.parse(second.outputs).agentTaskId;
  f.sql.prepare("UPDATE agent_tasks SET state='NO_CHANGES' WHERE id=?").run(secondTask);
  await f.process();
  assert.deepEqual([f.runs(toPR.id).at(-1).state, f.runs(toPR.id).at(-1).reason], ['SUCCEEDED', 'The coding agent made no changes.']);
});

test('the kill switch cancels the agent task of a running automation and discards its result', async t => {
  const f = await fixture(t);
  const host = await f.connect();
  const toPR = await f.enabled({ tool: 'issue-to-pr', engine: 'claude', place: 'agent-host', hostId: host.hostId });
  await emitAutomationEvent(f.env, { type: 'issue.opened', repositoryId: 1, number: 12 });
  await f.process();
  const taskId = JSON.parse(f.runs(toPR.id)[0].outputs).agentTaskId;
  await f.repo({ action: 'killSwitch', id: toPR.id, engaged: true });
  assert.deepEqual({ ...f.sql.prepare('SELECT state,cancel_requested FROM agent_tasks WHERE id=?').get(taskId) }, { state: 'CANCELLED', cancel_requested: 1 });
  assert.equal(f.runs(toPR.id)[0].state, 'FAILED'); assert.match(f.runs(toPR.id)[0].reason, /kill switch was engaged/);
  assert.equal(await emitAutomationEvent(f.env, { type: 'issue.opened', repositoryId: 1, number: 12 }), 0);
});

test('CI fixer: the masked log tail of a failed run on main becomes an issue and an agent task, then a draft fix', async t => {
  const f = await fixture(t);
  Object.assign(f.env, { PIPELINES_ENABLED: 'true', PIPELINE_BUCKET: memoryBucket() });
  const host = await f.connect();
  const fixer = await f.enabled({ tool: 'ci-fixer', engine: 'claude', place: 'agent-host', hostId: host.hostId, limits: { concurrency: 3 } });
  f.sql.exec(`INSERT INTO pipeline_runs(id,repository_id,artifact_name,engine,number,workflow_path,workflow_name,event,ref,commit_id,actor_id,trusted,state,created_at,updated_at)
    VALUES(7,1,'repo-${'b'.repeat(32)}','forgejo-actions',3,'.github/workflows/ci.yml','CI','push','refs/heads/main','${base}',1,1,'FAILURE','t','t');
    INSERT INTO pipeline_jobs(id,run_id,attempt,engine,job_key,name,payload,state,log_lines,log_bytes,log_chunks,log_complete,created_at,updated_at) VALUES(70,7,1,'forgejo-actions','test','test','{}','FAILURE',3,0,1,1,'t','t')`);
  const log = 'npm test\nexpected 2, got 3 ``` tricky\nleaked golf_agent_task_' + 'f'.repeat(30) + '\n';
  await f.env.PIPELINE_BUCKET.put(logKey(7, 70, 0), log);
  f.sql.prepare("UPDATE pipeline_jobs SET log_bytes=? WHERE id=70").run(Buffer.byteLength(log));
  f.sql.prepare("INSERT INTO pipeline_log_chunks(job_id,seq,first_line,lines,first_byte,bytes,created_at) VALUES(70,0,0,3,0,?,'t')").run(Buffer.byteLength(log));
  await emitAutomationEvent(f.env, { type: 'pipeline.failed', repositoryId: 1, runId: 7, ref: 'refs/heads/main', commit: base });
  await f.process();
  const [run] = f.runs(fixer.id);
  assert.deepEqual([run.state, run.phase], ['RUNNING', 'wait-task'], run.reason);
  const outputs = JSON.parse(run.outputs), issue = f.sql.prepare("SELECT title,body FROM discussions WHERE repository_id=1 AND number=? AND kind='issue'").get(outputs.issueNumber);
  assert.equal(issue.title, 'CI failed: CI on main (run #3)');
  assert.match(issue.body, /expected 2, got 3 ``` tricky/); assert.match(issue.body, /````\n/); assert.ok(!issue.body.includes('golf_agent_task_f'));
  const task = f.sql.prepare('SELECT * FROM agent_tasks WHERE id=?').get(outputs.agentTaskId);
  assert.deepEqual([task.target_kind, task.target_number], ['issue', outputs.issueNumber]);
  assert.match(task.instructions, /The Actions run that failed:[\s\S]*expected 2, got 3/);
  // A failure on a coding agent's proposal branch is not fixed (no loops); one on an unrelated branch neither.
  f.sql.exec(`INSERT INTO pipeline_runs(id,repository_id,artifact_name,engine,number,workflow_path,workflow_name,event,ref,commit_id,actor_id,trusted,state,created_at,updated_at)
    VALUES(8,1,'repo-${'b'.repeat(32)}','forgejo-actions',4,'.github/workflows/ci.yml','CI','push','refs/heads/golf-agent/1234abcd','${proposal}',1,1,'FAILURE','t','t'),
    (9,1,'repo-${'b'.repeat(32)}','forgejo-actions',5,'.github/workflows/ci.yml','CI','push','refs/heads/experiment','${proposal}',1,1,'FAILURE','t','t')`);
  await emitAutomationEvent(f.env, { type: 'pipeline.failed', repositoryId: 1, runId: 8 });
  await emitAutomationEvent(f.env, { type: 'pipeline.failed', repositoryId: 1, runId: 9 });
  await f.process();
  assert.match(f.runs(fixer.id)[1].reason, /proposal branch/); assert.match(f.runs(fixer.id)[2].reason, /neither the default branch nor the head of an open pull request/);
  // The task succeeds: a draft fix into main.
  f.refs.get('repo-' + 'b'.repeat(32)).set('refs/heads/' + task.branch, proposal);
  f.sql.prepare("UPDATE agent_tasks SET state='SUCCEEDED',commit_id=?,result='{}' WHERE id=?").run(proposal, task.id);
  await f.process();
  const done = f.runs(fixer.id)[0], pullNumber = JSON.parse(done.outputs).pullNumber;
  assert.equal(done.state, 'SUCCEEDED', done.reason);
  assert.deepEqual({ ...f.sql.prepare("SELECT d.title,p.draft FROM discussions d JOIN pull_requests p ON p.discussion_id=d.id WHERE d.repository_id=1 AND d.number=?").get(pullNumber) }, { title: 'Fix CI: CI failed: CI on main (run #3)', draft: 1 });
});

test('custom automations: the default engine is an AI run of kind automation; a registry engine is called outside the queue', async t => {
  const f = await fixture(t, { answer: async () => ({ choices: [{ finish_reason: 'stop', message: { content: 'Report: all good. ![x](https://evil.example/x.png) [link](https://evil.example) <script>alert(1)</script> @admin' } }], usage: { prompt_tokens: 50, completion_tokens: 20 } }) });
  const custom = await f.enabled({ tool: 'custom', trigger: { events: ['issue.opened'] }, output: ['report', 'comment'], instructions: 'Summarize the issue.' });
  await emitAutomationEvent(f.env, { type: 'issue.opened', repositoryId: 1, number: 12 });
  await f.process();
  let [run] = f.runs(custom.id);
  const aiRun = JSON.parse(run.outputs).aiRunId;
  assert.equal(f.sql.prepare('SELECT kind FROM ai_runs WHERE id=?').get(aiRun).kind, 'automation');
  // Nobody else can ask for this kind of run for it.
  const direct = await f.signed('/native/ai', { action: 'create', kind: 'automation', target: { runId: run.id }, idempotencyKey: uuid(), repository, repositoryId: '1' }, 'bob');
  assert.equal(direct.status, 412);
  await f.workflow(aiRun);
  assert.match(f.calls[0].input.messages[0].content, /Summarize the issue\./);
  assert.match(f.calls[0].input.messages[1].content, /<untrusted-[0-9a-f]+ label="issue">[\s\S]*Parser crashes/);
  await f.process();
  [run] = f.runs(custom.id);
  assert.equal(run.state, 'SUCCEEDED', run.reason);
  const report = JSON.parse(run.outputs).report;
  assert.ok(!/!\[|\]\(|<script>|https:\/\/evil\.example\/x/.test(report)); assert.match(report, /&lt;script&gt;/); assert.match(report, /@​admin/);
  assert.equal(run.input, null);
  // A registry engine: the run waits for one call outside the workspace queue, then is applied.
  const chats = [];
  useEngines({ listEngines: async () => [{ id: 'provider:gpt', label: 'Provider' }], resolveEngine: async (db, env, input) => ({ id: input.engineId }),
    runChat: async (env, handle, messages) => { chats.push({ handle, messages }); return { text: 'Engine says hi', usage: { input_tokens: 7, output_tokens: 3 } }; } });
  t.after(() => useEngines(realEngines));
  const engine = await f.enabled({ tool: 'custom', trigger: { events: ['issue.opened'] }, engine: 'provider:gpt', output: ['report'] });
  f.sql.exec("INSERT INTO discussions(id,repository_id,number,kind,author_id,title,body,state,created_at,updated_at) VALUES(20,1,30,'issue',1,'Engine issue','Body','OPEN','t','t')");
  await emitAutomationEvent(f.env, { type: 'issue.opened', repositoryId: 1, number: 30 });
  assert.equal((await f.process()).infer, 1);
  assert.equal((await inferAutomationRuns(f.env)).inferred, 1);
  assert.deepEqual(chats[0].handle, { id: 'provider:gpt' });
  await f.process();
  const done = f.runs(engine.id)[0];
  assert.equal(done.state, 'SUCCEEDED', done.reason);
  assert.deepEqual([JSON.parse(done.outputs).report, JSON.parse(done.usage)], ['Engine says hi', { inputTokens: 7, outputTokens: 3, reported: true }]);
  // An engine that fails fails the run with its reason.
  useEngines({ listEngines: async () => [{ id: 'provider:gpt' }], resolveEngine: async () => null, runChat: async () => ({}) });
  f.sql.exec("INSERT INTO discussions(id,repository_id,number,kind,author_id,title,body,state,created_at,updated_at) VALUES(21,1,31,'issue',1,'Another','Body','OPEN','t','t')");
  await emitAutomationEvent(f.env, { type: 'issue.opened', repositoryId: 1, number: 31 });
  await f.process(); await inferAutomationRuns(f.env);
  assert.match(f.runs(engine.id).at(-1).reason, /not available for this repository/);
});

test('the person an automation acts as must still hold the repository when a run starts', async t => {
  const f = await fixture(t);
  const triage = await f.enabled({ tool: 'issue-triage' });
  await emitAutomationEvent(f.env, { type: 'issue.opened', repositoryId: 1, number: 12 });
  f.sql.exec("UPDATE grants SET role='write' WHERE repository_id=1 AND user_id=1");
  await f.process();
  assert.deepEqual([f.runs(triage.id)[0].state], ['REFUSED']); assert.match(f.runs(triage.id)[0].reason, /needs admin access/);
  f.sql.exec("DELETE FROM grants WHERE repository_id=1 AND user_id=1");
  f.sql.prepare("UPDATE automation_runs SET dedupe_key='old' WHERE automation_id=?").run(triage.id);
  await emitAutomationEvent(f.env, { type: 'issue.opened', repositoryId: 1, number: 12 });
  await f.process();
  assert.match(f.runs(triage.id).at(-1).reason, /alice no longer has access to this repository/);
});

test('the paths filter reads the files a push changed', async t => {
  const f = await fixture(t);
  const custom = await f.enabled({ tool: 'custom', trigger: { events: ['push'] }, target: { paths: ['docs/**'] }, output: ['report'] });
  const hex = c => c.repeat(40);
  f.trees.set(base, hex('1')); f.trees.set(next, hex('2'));
  f.treeEntries.set(hex('1'), [{ name: 'src', type: 'tree', hash: hex('3'), mode: '040000' }]);
  f.treeEntries.set(hex('3'), [{ name: 'a.js', type: 'blob', hash: hex('4'), mode: '100644' }]);
  f.treeEntries.set(hex('2'), [{ name: 'src', type: 'tree', hash: hex('5'), mode: '040000' }]);
  f.treeEntries.set(hex('5'), [{ name: 'a.js', type: 'blob', hash: hex('6'), mode: '100644' }]);
  await emitAutomationEvent(f.env, { type: 'push', repositoryId: 1, ref: 'refs/heads/main', before: base, after: next });
  await f.process();
  assert.deepEqual([f.runs(custom.id)[0].state, f.runs(custom.id)[0].reason], ['SKIPPED', 'No changed file matches the path patterns.']);
  f.treeEntries.set(hex('2'), [{ name: 'src', type: 'tree', hash: hex('3'), mode: '040000' }, { name: 'docs', type: 'tree', hash: hex('7'), mode: '040000' }]);
  f.treeEntries.set(hex('7'), [{ name: 'guide.md', type: 'blob', hash: hex('8'), mode: '100644' }]);
  f.commits.set(proposal, [next]); f.trees.set(proposal, hex('2'));
  await emitAutomationEvent(f.env, { type: 'push', repositoryId: 1, ref: 'refs/heads/main', before: base, after: proposal });
  await f.process();
  assert.deepEqual([f.runs(custom.id)[1].state, f.runs(custom.id)[1].phase], ['RUNNING', 'wait-ai']);
});
