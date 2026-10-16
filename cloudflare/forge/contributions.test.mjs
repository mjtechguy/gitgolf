import { test } from 'node:test';
import assert from 'node:assert/strict';
import { objectFixture, origin, repository } from './object-fixture.mjs';
import { withArtifact, concurrentRead } from './src/core.mjs';
import { statelessRoute } from './src/public.mjs';
import { sweepContributions, recordRefWrite, declaredAI, contributionRange, contributionLimits } from './src/contributions.mjs';

const uuid = () => crypto.randomUUID();
const hour = 3600_000;
const ago = ms => new Date(Date.now() - ms).toISOString();
const hash = n => n.toString(16).padStart(40, '0');

async function fixture(t) {
  const f = await objectFixture(t);
  f.sql.exec(`UPDATE users SET email=login||'@example.invalid';
    INSERT INTO operations_admins(user_id) VALUES(1);
    INSERT INTO repositories(id,name,description,artifact_name,creator_id,creation_key,input_hash,state,created_at) VALUES(2,'secret','','repo-${'e'.repeat(32)}',1,'k2','h2','ACTIVE','2026-10-01T00:00:00Z');
    INSERT INTO grants VALUES(2,1,'admin');
    INSERT INTO agent_hosts(id,uuid,name,scope,scope_id,registered_by,credential_digest,created_at) VALUES(1,'host-1','laptop','personal','1',1,'digest-1','2026-10-01T00:00:00Z')`);
  // A browser request through Access, as the public Worker forwards it.
  const access = (path, body, who = 'alice') => f.dispatch(new Request(origin + path, { method: 'POST', body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json', 'Connect-Protocol-Version': '1', 'X-Golf-Native-Access-Email': who + '@example.invalid' } }))
    .then(async response => ({ status: response.status, ...(await response.json()) }));
  const days = (where = '1=1') => f.sql.prepare(`SELECT actor_id,repository_id,kind,ai_tier,SUM(count) AS count FROM contribution_days WHERE ${where} GROUP BY actor_id,repository_id,kind,ai_tier ORDER BY actor_id,repository_id,kind,ai_tier`).all().map(row => ({ ...row }));
  const sweep = (limits = {}) => sweepContributions(f.env, withArtifact, { ...contributionLimits, ...limits });
  return { ...f, access, days, sweep };
}

test('reads are served statelessly and overlap other reads', () => {
  const request = path => new Request(origin + path, { method: 'POST', body: '{}' });
  assert.equal(statelessRoute(request('/native/contributions/read')), 'read');
  assert.equal(statelessRoute(request('/native/contributions')), null);
  assert.equal(concurrentRead(request('/native/contributions/read')), true);
  assert.equal(concurrentRead(request('/native/contributions')), false);
});

test('a Co-Authored-By trailer naming an AI tool is declared, and nothing else is', () => {
  assert.equal(declaredAI('Fix\n\nCo-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>'), true);
  assert.equal(declaredAI('Fix\n\nco-authored-by: Copilot <175728472+Copilot@users.noreply.github.com>'), true);
  assert.equal(declaredAI('Fix\n\nCo-authored-by: Cursor Agent <cursoragent@cursor.com>'), true);
  assert.equal(declaredAI('Fix\n\nCo-Authored-By: Grace Hopper <grace@example.com>'), false);
  assert.equal(declaredAI('Mention Claude in the body only'), false);
});

test('the person range is 53 weeks from a Sunday, or one calendar year', () => {
  const range = contributionRange(undefined, Date.parse('2026-10-16T12:00:00Z'));
  assert.equal(range.to, '2026-10-16'); assert.equal(new Date(range.from + 'T00:00:00Z').getUTCDay(), 0);
  assert.equal((Date.parse('2026-10-11') - Date.parse(range.from)) / (7 * 86400_000), 52);
  assert.deepEqual(contributionRange(2025, Date.parse('2026-10-16T12:00:00Z')), { from: '2025-01-01', to: '2025-12-31', year: 2025 });
  assert.throws(() => contributionRange(2027, Date.parse('2026-10-16T12:00:00Z')), /year/);
});

test('writers count an issue, a comment and a close once, however often they are retried, and the sweep never double counts them', async t => {
  const f = await fixture(t);
  const create = { repository, repositoryId: '1', title: 'Parser crashes', body: '', idempotencyKey: uuid() };
  const issue = await f.value('RepositoryService/CreateIssue', create);
  assert.equal(issue.mutation.number, 1);
  // A retried request returns the original receipt and counts nothing again.
  await f.value('RepositoryService/CreateIssue', create);
  const comment = { repository, repositoryId: '1', number: 1, issueId: issue.mutation.issueId, body: 'Reproduced.', idempotencyKey: uuid() };
  await f.value('RepositoryService/CreateIssueComment', comment, (await import('./object-fixture.mjs')).tokens.writer);
  await f.value('RepositoryService/CreateIssueComment', comment, (await import('./object-fixture.mjs')).tokens.writer);
  const current = await f.value('RepositoryService/GetIssue', { repository, repositoryId: '1', number: 1 });
  const close = await f.value('RepositoryService/UpdateIssue', { repository, repositoryId: '1', number: 1, issueId: issue.mutation.issueId, state: 'ISSUE_STATE_CLOSED', expectedRevision: current.issue.revision, idempotencyKey: uuid() });
  assert.equal(close.issue.state, 'ISSUE_STATE_CLOSED');
  const expected = [{ actor_id: 1, repository_id: 1, kind: 'issue_closed', ai_tier: 'none', count: 1 }, { actor_id: 1, repository_id: 1, kind: 'issue_opened', ai_tier: 'none', count: 1 },
    { actor_id: 2, repository_id: 1, kind: 'comment', ai_tier: 'none', count: 1 }];
  assert.deepEqual(f.days(), expected);
  // The sweep reaches the same events once they are older than its lag: the same keys, nothing added.
  f.sql.exec(`UPDATE discussion_events SET created_at='${ago(hour)}'`);
  await f.sweep(); await f.sweep();
  assert.deepEqual(f.days(), expected);
  assert.equal(f.sql.prepare('SELECT count(*) AS n FROM contribution_events WHERE pending=1').get().n, 0);
});

test('the sweep counts what no writer saw, with AI tiers for agent proposals, policy landings and agent tasks', async t => {
  const f = await fixture(t);
  const at = ago(3 * hour), day = at.slice(0, 10), task = uuid();
  f.sql.exec(`INSERT INTO discussions(id,repository_id,number,kind,author_id,title,body,state,created_at,updated_at) VALUES
      (10,1,10,'pull',1,'Agent change','','CLOSED','${at}','${at}'),(11,1,11,'pull',2,'Landed by policy','','CLOSED','${at}','${at}'),(12,1,12,'pull',2,'Plain','','CLOSED','${at}','${at}'),(13,1,13,'issue',3,'Question','','OPEN','${at}','${at}');
    INSERT INTO pull_requests(id,discussion_id,base_branch,head_branch,base_commit,head_commit,draft) VALUES(10,10,'main','golf-agent/a','${hash(1)}','${hash(2)}',0),(11,11,'main','b','${hash(1)}','${hash(3)}',0),(12,12,'main','c','${hash(1)}','${hash(4)}',0);
    INSERT INTO land_operations(id,repository_id,pull_request_id,number,trigger,actor_id,state,created_at,updated_at) VALUES('land-1',1,11,11,'policy',0,'LANDED','${at}','${at}');
    INSERT INTO discussion_events(id,discussion_id,actor_id,kind,payload,created_at) VALUES
      ('e1',10,1,'opened','{}','${at}'),('e2',10,1,'merge_pull','{}','${at}'),('e3',11,1,'merge_pull','{}','${at}'),('e4',12,2,'opened','{}','${at}'),('e5',12,1,'merge_pull','{}','${at}'),
      ('e6',12,3,'review_approved','{}','${at}'),('e7',12,3,'review_requested','{}','${at}'),('e8',13,3,'opened','{}','${at}'),('e9',12,2,'close','{}','${at}'),('e10',13,1,'label','{}','${at}'),
      ('young',13,3,'comment','{}','${ago(10_000)}');
    INSERT INTO agent_tasks(id,repository_id,artifact_name,host_id,tool,model,requested_by,target_kind,target_number,base_ref,base_commit,branch,prompt,state,deadline,commit_id,idempotency_key,created_at,updated_at,finished_at) VALUES
      ('${task}',1,'repo-${'b'.repeat(32)}',1,'claude','',2,'issue',13,'main','${hash(1)}','golf-agent/x','Fix it','SUCCEEDED',0,'${hash(9)}','k1','${at}','${at}','${at}'),
      ('t-review-0000-4000-8000-000000000000',1,'repo-${'b'.repeat(32)}',1,'codex','',2,'pull_request',12,'main','${hash(1)}','golf-agent/y','Review','SUCCEEDED',0,'','k2','${at}','${at}','${at}'),
      ('${uuid()}',1,'repo-${'b'.repeat(32)}',1,'codex','',2,'issue',13,'main','${hash(1)}','golf-agent/z','Fail','FAILED',0,'','k3','${at}','${at}','${at}');
    INSERT INTO pull_request_origins(pull_request_id,kind,agent_task_id,created_at) VALUES(10,'agent-task','${task}','${at}');
    INSERT INTO agent_task_reviews(task_id,created_at) VALUES('t-review-0000-4000-8000-000000000000','${at}');
    INSERT INTO evidence_jobs(id,repository_id,user_id,operation_key,input_hash,snapshot,state,advice_state,agent_state,created_at,updated_at,expires_at) VALUES
      ('job-1',1,3,'o1','h','{}','SUCCEEDED','NONE','succeeded','${at}','${at}','${at}'),('job-2',1,3,'o2','h','{}','SUCCEEDED','NONE','failed','${at}','${at}','${at}')`);
  const result = await f.sweep();
  assert.ok(result.processed >= 13);
  const rows = f.days(`day='${day}'`);
  const find = (actor, kind) => rows.filter(row => row.actor_id === actor && row.kind === kind).map(row => `${row.ai_tier}:${row.count}`).sort();
  // A person merged an agent task's pull request: AI-assisted, and its proposal accepted. The policy landed another: Golf's agent.
  assert.deepEqual(find(1, 'pull_merged'), ['agent:1', 'assisted:1', 'none:1']);
  assert.deepEqual(find(1, 'proposal_accepted'), ['assisted:1']);
  assert.deepEqual(find(1, 'pull_opened'), ['agent:1']);
  assert.deepEqual(find(2, 'pull_opened'), ['none:1']);
  // Reviews count; requesting a review, closing a pull request and labelling do not. A comment younger than the lag waits.
  assert.deepEqual(find(3, 'review'), ['none:1']);
  assert.deepEqual(find(3, 'issue_opened'), ['none:1']);
  assert.deepEqual(find(3, 'comment'), []);
  assert.deepEqual(find(2, 'issue_closed'), []);
  // Agent tasks: one proposal and one review by Golf's agent for the person who ran them; the failed one is not counted.
  assert.deepEqual(find(2, 'proposal_created'), ['agent:1']);
  assert.deepEqual(find(2, 'review'), ['agent:1']);
  // An evidence agent proposal that succeeded.
  assert.deepEqual(find(3, 'proposal_created'), ['agent:1']);
  // Merges make the repository's Git walk due.
  assert.equal(f.sql.prepare('SELECT pending FROM contribution_git WHERE repository_id=1').get().pending, 1);
  // Repeating the sweep adds nothing; the cursors moved past what it read.
  const before = JSON.stringify(f.days());
  await f.sweep();
  assert.equal(JSON.stringify(f.days()), before);
  assert.ok(f.sql.prepare("SELECT position FROM contribution_cursors WHERE source='discussion-events'").get().position.includes(at));
});

test('the Git backfill walks first-parent history in bounded batches, resumes where it stopped, and a push walks only the new commits', async t => {
  const f = await fixture(t);
  // 45 commits on main, newest first: authors with and without accounts, Golf's own identity, a declared AI co-author, an agent task's
  // commit and a merge commit of an agent task's pull request.
  const commits = new Map(), refs = new Map(), calls = { log: 0, readCommit: 0 };
  const add = (n, parent, author, message = `Commit ${n}`) => commits.set(hash(n), { hash: hash(n), treeHash: 'f'.repeat(40), parents: parent ? [hash(parent)] : [], message,
    author: { name: author, email: author }, authoredAt: Math.floor(Date.parse('2026-10-01T12:00:00Z') / 1000) + n * 3600 });
  for (let n = 1; n <= 45; n++) add(n, n - 1, n % 3 === 0 ? 'stranger@example.com' : n % 3 === 1 ? 'alice@example.invalid' : 'BOB@example.invalid',
    n === 10 ? 'Fix\n\nCo-Authored-By: Claude <noreply@anthropic.com>' : undefined);
  commits.get(hash(20)).author.email = 'agentic@golf.invalid';
  refs.set('main', hash(45));
  f.sql.exec(`INSERT INTO agent_tasks(id,repository_id,artifact_name,host_id,tool,model,requested_by,target_kind,target_number,base_ref,base_commit,branch,prompt,state,deadline,commit_id,idempotency_key,created_at,updated_at) VALUES
      ('${uuid()}',1,'repo-${'b'.repeat(32)}',1,'claude','',1,'issue',1,'main','${hash(1)}','golf-agent/x','Fix it','RUNNING',0,'${hash(31)}','k1','${ago(hour)}','${ago(hour)}');
    INSERT INTO discussions(id,repository_id,number,kind,author_id,title,body,state,created_at,updated_at) VALUES(10,1,10,'pull',2,'Agent change','','CLOSED','t','t');
    INSERT INTO pull_requests(id,discussion_id,base_branch,head_branch,base_commit,head_commit,draft) VALUES(10,10,'main','golf-agent/a','${hash(1)}','${hash(2)}',0);
    INSERT INTO pull_request_origins(pull_request_id,kind,created_at) VALUES(10,'agent-task','t');
    INSERT INTO pull_merge_operations(actor_id,operation_id,repository_id,pull_request_id,input_hash,original,phase,merge_commit_id,created_at,updated_at) VALUES(1,'m1',1,10,'h','{}','SUCCEEDED','${hash(40)}','t','t')`);
  f.env.ARTIFACTS = { async get(name) { return {
    async info() { return { name, remote: `https://${f.env.ACCOUNT_ID}.artifacts.cloudflare.net/git/test-space/${name}.git` }; }, [Symbol.dispose]() {},
    async readCommit(id) { calls.readCommit++; return commits.get(id) || null; },
    async log({ ref, limit }) { if (name !== 'repo-' + 'b'.repeat(32)) return []; calls.log++; const out = []; for (let at = refs.get(ref) || ref; commits.has(at) && out.length < limit; at = commits.get(at).parents[0]) out.push(commits.get(at)); return out; },
  }; } };
  const limits = { commits: 15, reads: 5 };
  const walked = () => f.sql.prepare('SELECT next_commit,pending,walked FROM contribution_git WHERE repository_id=1').get();
  // Enrolment, then a short page from the tip (at most 15 here), then full batches from where each stopped.
  await f.sweep(limits);
  assert.deepEqual({ ...walked() }, { next_commit: hash(30), pending: 0, walked: 15 });
  await f.sweep(limits);
  assert.deepEqual({ ...walked() }, { next_commit: hash(15), pending: 0, walked: 30 });
  await f.sweep(limits);
  assert.deepEqual({ ...walked() }, { next_commit: '', pending: 0, walked: 45 });
  assert.equal(calls.log, 3); assert.equal(calls.readCommit, 0);
  const commitsBy = () => f.days("kind='commit'").map(row => `${row.actor_id}:${row.ai_tier}:${row.count}`);
  // alice: 15 commits (n%3==1), one declared (10), one an agent task's (31), one the agent pull request's merge (40, AI-assisted); bob
  // (matched case-insensitively): 15, one of them by Golf's own identity (20), which is actor 0; strangers are never counted.
  assert.deepEqual(commitsBy(), ['0:agent:1', '1:agent:1', '1:assisted:1', '1:declared:1', '1:none:12', '2:none:14']);
  assert.equal(f.sql.prepare("SELECT count(*) AS n FROM contribution_events WHERE kind='commit'").get().n, 45);
  // Nothing more until the branch moves.
  await f.sweep(limits);
  assert.equal(calls.log, 3);
  // A push of three commits: the confirmed write marks the walk due, and the walk stops at the first commit already counted.
  for (let n = 46; n <= 48; n++) add(n, n - 1, 'alice@example.invalid');
  refs.set('main', hash(48));
  f.sql.exec(`INSERT INTO git_operations(id,repository_id,user_id,ref,old_sha,new_sha,state,created_at) VALUES('op-1',1,1,'refs/heads/main','${hash(45)}','${hash(48)}','APPLIED','${ago(0)}'),
    ('op-2',1,1,'refs/heads/feature','${hash(45)}','${hash(48)}','APPLIED','${ago(0)}')`);
  await recordRefWrite(f.env.DB, 'op-2');
  assert.equal(walked().pending, 0, 'a push to another branch changes nothing');
  await recordRefWrite(f.env.DB, 'op-1');
  assert.equal(walked().pending, 1);
  await f.sweep(limits);
  assert.deepEqual(commitsBy(), ['0:agent:1', '1:agent:1', '1:assisted:1', '1:declared:1', '1:none:15', '2:none:14']);
  assert.deepEqual({ ...walked() }, { next_commit: '', pending: 0, walked: 48 });
});

test('the Git walk is resumable after an Artifacts failure and leaves other repositories to go first', async t => {
  const f = await fixture(t);
  f.env.ARTIFACTS = { async get() { throw Error('Artifacts unavailable'); } };
  await f.sweep();
  const rows = f.sql.prepare('SELECT repository_id,pending,next_commit FROM contribution_git ORDER BY repository_id').all().map(row => ({ ...row }));
  // Both stay due for the next pass; nothing was counted and the pass itself did not fail.
  assert.deepEqual(rows, [{ repository_id: 1, pending: 1, next_commit: '' }, { repository_id: 2, pending: 1, next_commit: '' }]);
  assert.equal(f.sql.prepare('SELECT count(*) AS n FROM contribution_days').get().n, 0);
});

test('a profile shows only repositories the viewer can read; private activity is anonymous and only by the person’s choice', async t => {
  const f = await fixture(t);
  const today = new Date().toISOString().slice(0, 10), yesterday = ago(86400_000).slice(0, 10);
  f.sql.exec(`INSERT INTO contribution_days(actor_id,day,repository_id,kind,ai_tier,count) VALUES
      (1,'${today}',1,'commit','none',3),(1,'${today}',1,'pull_merged','assisted',1),(1,'${yesterday}',1,'commit','declared',2),(1,'${today}',1,'proposal_created','agent',4),
      (1,'${today}',2,'commit','none',5),(1,'2024-03-01',2,'commit','none',1)`);
  const view = (who, body = {}) => f.access('/native/contributions/read', { action: 'person', owner: 'alice', ...body }, who);
  // carol reads project, not secret.
  let carol = await view('carol');
  assert.equal(carol.state, 'on');
  assert.equal(carol.totals.human, 6); assert.equal(carol.totals.ai, 7); assert.equal(carol.totals.private, 0);
  assert.deepEqual(carol.totals.tiers, { agent: 4, assisted: 1, declared: 2, none: 3 });
  assert.deepEqual(carol.repositories, [{ fullName: 'alice/project', human: 6, ai: 7 }]);
  assert.deepEqual(carol.streaks, { longest: 2, current: 2 });
  assert.deepEqual(carol.years, [new Date().getUTCFullYear()]);
  assert.equal(JSON.stringify(carol).includes('secret'), false);
  assert.deepEqual(carol.settings, { showPrivate: false, canEdit: false });
  // dave reads neither: nothing at all, not even a total.
  let dave = await view('dave');
  assert.equal(dave.totals.human, 0); assert.deepEqual(dave.days, []); assert.deepEqual(dave.repositories, []);
  // alice sees her own private activity counted anonymously in her own view... and every repository by name she can read.
  const self = await view('alice');
  assert.equal(self.totals.human, 11); assert.equal(self.settings.canEdit, true); assert.equal(self.settings.version, 0);
  assert.deepEqual(self.years, [new Date().getUTCFullYear(), 2024]);
  // Only alice changes alice's choice, through Access, version-fenced.
  assert.equal((await f.call('/native/contributions', { action: 'settings', showPrivate: true, expectedVersion: 0 })).status, 403);
  const saved = await f.access('/native/contributions', { action: 'settings', showPrivate: true, expectedVersion: 0 });
  assert.deepEqual(saved.settings, { showPrivate: true, version: 1, canEdit: true });
  assert.equal((await f.access('/native/contributions', { action: 'settings', showPrivate: false, expectedVersion: 0 })).status, 412);
  // Now dave sees alice's activity as anonymous counts: no repository named, never a private repository's name.
  dave = await view('dave');
  assert.equal(dave.totals.human, 11); assert.equal(dave.totals.private, 11); assert.deepEqual(dave.repositories, []);
  assert.equal(dave.days.find(day => day.day === today).private, 9);
  assert.equal(JSON.stringify(dave).includes('secret') || JSON.stringify(dave).includes('project'), false);
  assert.equal(dave.privateCounts.included, true);
  // The year view: secret's 2024 commit, anonymous for dave.
  const year = await view('dave', { year: 2024 });
  assert.deepEqual(year.range, { from: '2024-01-01', to: '2024-12-31', year: 2024 });
  assert.equal(year.totals.private, 1);
  // A repository whose feature is off hides its counts from everyone, and keeps them.
  f.sql.exec(`INSERT INTO repository_features(repository_id,artifact_name,feature,enabled,version,updated_by,updated_at) VALUES(1,'repo-${'b'.repeat(32)}','contribution-graphs',0,1,1,'t')`);
  carol = await view('carol');
  assert.deepEqual(carol.repositories, []); assert.equal(carol.totals.human, 5); assert.equal(carol.totals.private, 5);
  assert.equal(f.sql.prepare('SELECT count(*) AS n FROM contribution_days WHERE repository_id=1').get().n, 4);
  // Unknown people and organizations are not found.
  assert.equal((await f.access('/native/contributions/read', { action: 'person', owner: 'nobody' }, 'carol')).status, 404);
  // Off for the installation: the page says so.
  f.sql.exec("INSERT INTO feature_policies(scope,scope_id,feature,mode,version,updated_by,updated_at) VALUES('installation','','contribution-graphs','DISABLED',1,1,'t')");
  assert.equal((await view('carol')).state, 'off');
});

test('public repositories are readable to everyone on a public installation', async t => {
  const f = await fixture(t);
  f.env.PUBLIC_REPOSITORIES = 'true';
  f.sql.exec(`INSERT INTO repository_visibility(repository_id,is_public,version) VALUES(2,1,1);
    INSERT INTO contribution_days(actor_id,day,repository_id,kind,ai_tier,count) VALUES(1,'${new Date().toISOString().slice(0, 10)}',2,'commit','none',2)`);
  const dave = await f.access('/native/contributions/read', { action: 'person', owner: 'alice' }, 'dave');
  assert.deepEqual(dave.repositories, [{ fullName: 'alice/secret', human: 2, ai: 0 }]);
});

test('the AI impact page is for operations administrators and holds anonymous installation aggregates', async t => {
  const f = await fixture(t);
  const at = ago(2 * hour), day = at.slice(0, 10), later = ago(hour);
  f.sql.exec(`INSERT INTO contribution_days(actor_id,day,repository_id,kind,ai_tier,count) VALUES
      (1,'${day}',1,'pull_merged','assisted',2),(0,'${day}',1,'commit','agent',3),(2,'${day}',2,'commit','declared',1),(3,'${day}',1,'review','none',4);
    INSERT INTO discussions(id,repository_id,number,kind,author_id,title,body,state,created_at,updated_at) VALUES(10,1,10,'pull',1,'A','','CLOSED','${ago(5 * hour)}','t'),(11,1,11,'pull',1,'B','','CLOSED','${at}','t');
    INSERT INTO pull_requests(id,discussion_id,base_branch,head_branch,base_commit,head_commit,draft) VALUES(10,10,'main','a','${hash(1)}','${hash(2)}',0),(11,11,'main','b','${hash(1)}','${hash(3)}',0);
    INSERT INTO pull_request_origins(pull_request_id,kind,created_at) VALUES(10,'agent-task','${at}');
    INSERT INTO pull_merge_operations(actor_id,operation_id,repository_id,pull_request_id,input_hash,original,phase,merge_commit_id,created_at,updated_at) VALUES
      (1,'m1',1,10,'h','{}','SUCCEEDED','${hash(5)}','${later}','${later}'),(1,'m2',1,11,'h','{}','SUCCEEDED','${hash(6)}','${later}','${later}');
    INSERT INTO land_operations(id,repository_id,pull_request_id,number,trigger,actor_id,state,created_at,updated_at) VALUES('l1',1,10,10,'policy',0,'LANDED','${at}','${at}'),('l2',1,11,11,'person',1,'BLOCKED','${at}','${at}');
    INSERT INTO agent_tasks(id,repository_id,artifact_name,host_id,tool,model,requested_by,target_kind,target_number,base_ref,base_commit,branch,prompt,state,deadline,commit_id,result,idempotency_key,created_at,updated_at) VALUES
      ('${uuid()}',1,'repo-${'b'.repeat(32)}',1,'claude','',1,'issue',1,'main','${hash(1)}','golf-agent/x','Fix','SUCCEEDED',0,'${hash(9)}','{"usage":{"inputTokens":100,"outputTokens":50,"costUsd":0.25,"reported":true}}','k1','${at}','${at}'),
      ('${uuid()}',1,'repo-${'b'.repeat(32)}',1,'codex','',1,'issue',1,'main','${hash(1)}','golf-agent/y','Fix','FAILED',0,'','{}','k2','${at}','${at}');
    INSERT INTO ai_runs(id,kind,repository_id,user_id,operation_key,input_hash,target,model,state,usage,created_at,updated_at,expires_at) VALUES('r1','review-draft',1,1,'o','h','{}','m','SUCCEEDED','{"total_tokens":70}','${at}','${at}','${at}')`);
  // Signed in, but not an operations administrator: refused, and so is an API credential.
  assert.equal((await f.access('/native/contributions/read', { action: 'impact' }, 'bob')).status, 403);
  assert.equal((await f.call('/native/contributions/read', { action: 'impact' })).status, 403);
  const impact = await f.access('/native/contributions/read', { action: 'impact' });
  assert.equal(impact.state, 'on'); assert.deepEqual(impact.unreadable, []);
  assert.deepEqual(impact.heatmap, [{ day, agent: 3, assisted: 2, declared: 1, none: 4 }]);
  assert.deepEqual(impact.kinds.pull_merged, { agent: 0, assisted: 2, declared: 0, none: 0 });
  assert.deepEqual(impact.proposals.fromTasks, { opened: 1, merged: 1 });
  assert.deepEqual(impact.landing.map(row => `${row.trigger}:${row.state}:${row.count}`).sort(), ['person:BLOCKED:1', 'policy:LANDED:1']);
  assert.deepEqual(impact.agentTasks.map(row => `${row.tool}:${row.state}:${row.count}:${row.tokens}`).sort(), ['claude:SUCCEEDED:1:150', 'codex:FAILED:1:0']);
  assert.deepEqual(impact.costs, { reportedUsd: 0.25, reportingRuns: 1, runs: 2 });
  assert.deepEqual(impact.aiRuns, [{ kind: 'review-draft', state: 'SUCCEEDED', count: 1, tokens: 70 }]);
  // Time to merge is a labelled comparison: 4 h for the agent task's pull request, 1 h for the other.
  assert.match(impact.comparison.label, /not a measured effect/);
  assert.equal(impact.comparison.aiInvolved.count, 1); assert.equal(Math.round(impact.comparison.aiInvolved.medianHours), 4);
  assert.equal(Math.round(impact.comparison.other.medianHours), 1);
  // No repository or person is named.
  for (const name of ['project', 'secret', 'alice', 'bob']) assert.equal(JSON.stringify(impact).includes(name), false, name);
  // A repository with the feature off leaves the aggregates.
  f.sql.exec(`INSERT INTO repository_features(repository_id,artifact_name,feature,enabled,version,updated_by,updated_at) VALUES(2,'repo-${'e'.repeat(32)}','contribution-graphs',0,1,1,'t')`);
  const narrowed = await f.access('/native/contributions/read', { action: 'impact' });
  assert.deepEqual(narrowed.heatmap, [{ day, agent: 3, assisted: 2, declared: 0, none: 4 }]); assert.equal(narrowed.excludedRepositories, 1);
});

test('a confirmed push to the default branch makes its Git walk due; a push to another branch does not', async t => {
  const { accessFixture, basic, feature, base } = await import('./agent-access-fixture.mjs');
  const f = await accessFixture(t);
  const secret = (await f.create({ repositories: ['1'] }, 'bob')).secret;
  const due = () => f.sql.prepare('SELECT pending FROM contribution_git WHERE repository_id=1').get()?.pending;
  assert.equal((await f.push(basic(secret), 'refs/heads/agent/new')).status, 200);
  assert.equal(due(), undefined);
  assert.equal((await f.push(basic(secret), 'refs/heads/main', feature, base)).status, 200);
  assert.equal(due(), 1);
});
