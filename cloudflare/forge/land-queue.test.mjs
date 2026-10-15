// Landing at agent speed (docs/AGENTIC_MODE.md, AM-4 items 4 and 5): POST /native/land, policy landing and the revert after failed
// checks. node:sqlite as D1 over the real schema and a real bare Git repository as the provider (`git upload-pack` advertises, `git
// receive-pack` applies every merge and revert), so each commit Golf writes is checked by Git itself.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { spawnSync, execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { handle, serialize, admission, withArtifact } from './src/core.mjs';
import { packetLine } from './src/git.mjs';
import { afterPipelineRun, autoLand, checkLanded, landSoon, sweepLanding, backoff, landLimits } from './src/land-queue.mjs';
import { onlyApprovalNeeded } from './src/land-policy.mjs';
import { gitAvailable, gitFixture } from './git-cli-fixture.mjs';

const origin = 'https://golf.example.com', artifact = 'repo-' + 'b'.repeat(32), key = { owner: 'alice', name: 'project' };
const types = { '040000': 'tree', '100644': 'blob', '100755': 'exec', '120000': 'symlink', '160000': 'gitlink' };
const skip = !gitAvailable && 'git is not installed';

async function fixture(t) {
  const g = gitFixture(t), sql = new DatabaseSync(':memory:');
  t.after(() => sql.close());
  sql.exec(await readFile(new URL('./schema.sql', import.meta.url), 'utf8'));
  sql.exec(`INSERT INTO users(id,login,email,full_name) VALUES(1,'alice','alice@example.com','Alice Example'),(2,'bob','bob@example.com','Bob'),(3,'carol','carol@example.com','');
    INSERT INTO workspaces(slug,artifact_namespace) VALUES('alice','test-space');
    INSERT INTO repositories(id,name,description,artifact_name,creator_id,creation_key,input_hash,state,created_at) VALUES(1,'project','','${artifact}',1,'original','hash','ACTIVE','2026-10-14T00:00:00Z');
    INSERT INTO grants VALUES(1,1,'admin'),(1,2,'write'),(1,3,'read')`);
  const db = {
    withSession() { return this; },
    prepare(query) { let values = []; const statement = sql.prepare(query); return {
      bind(...args) { assert.ok(args.every(value => value !== undefined), 'D1 refuses undefined bindings'); values = args; return this; },
      async first() { return statement.get(...values) || null; },
      async all() { return { results: statement.all(...values) }; },
      async run() { return { meta: { changes: statement.run(...values).changes } }; },
    }; },
    async batch(statements) {
      sql.exec('BEGIN');
      try { const results = []; for (const statement of statements) results.push(await statement.run()); sql.exec('COMMIT'); return results; }
      catch (error) { sql.exec('ROLLBACK'); throw error; }
    },
  };
  const git = args => spawnSync('git', ['--git-dir', g.directory, ...args], { env: g.env, maxBuffer: 1 << 28 });
  const hooks = { beforePush: null, afterAdvertise: null }, counts = { pushes: 0, adverts: 0 }, queued = [];
  const env = { DB: db, ACCOUNT_ID: 'c'.repeat(32), ARTIFACTS_NAMESPACE: 'test-space', WORKSPACE_SLUG: 'alice', PUBLIC_ORIGIN: origin,
    PIPELINES_ENABLED: 'true', PIPELINE_BUCKET: {}, PIPELINE_QUEUE: { async send(message) { queued.push(message); } },
    ARTIFACTS: { async get(name) { assert.equal(name, artifact); return {
      async info() { return { name, remote: `https://${env.ACCOUNT_ID}.artifacts.cloudflare.net/git/test-space/${name}.git` }; },
      async createToken() { return { plaintext: 'art_v1_local' }; }, async revokeToken() { return true; }, [Symbol.dispose]() {},
      async readCommit(hash) {
        const read = git(['cat-file', 'commit', hash]);
        if (read.status) return null;
        const body = read.stdout.toString(), headers = body.slice(0, body.indexOf('\n\n')).split('\n');
        return { hash, treeHash: headers[0].slice(5), parents: headers.filter(line => line.startsWith('parent ')).map(line => line.slice(7)), message: body.slice(body.indexOf('\n\n') + 2), author: { name: 'x' }, authoredAt: 1 };
      },
      async readTree(hash) {
        const listed = git(['ls-tree', '-z', hash]);
        if (listed.status) return null;
        return listed.stdout.toString().split('\0').filter(Boolean).map(line => { const [mode, , id] = line.slice(0, line.indexOf('\t')).split(' '); return { name: line.slice(line.indexOf('\t') + 1), type: types[mode], hash: id, mode }; });
      },
      async readBlob(hash) { const read = git(['cat-file', 'blob', hash]); return read.status ? null : new Blob([read.stdout]); },
      async log() { return []; },
    }; } } };
  const providerFetch = async (url, options = {}) => {
    if (options.method === 'POST') {
      counts.pushes++;
      if (hooks.beforePush) { const hook = hooks.beforePush; hooks.beforePush = null; await hook(); }
      const received = spawnSync('git', ['receive-pack', '--stateless-rpc', g.directory], { env: g.env, input: Buffer.from(options.body) });
      return new Response(received.stdout, { headers: { 'Content-Type': 'application/x-git-receive-pack-result' } });
    }
    const advertised = spawnSync('git', ['upload-pack', '--stateless-rpc', '--advertise-refs', g.directory], { env: g.env }).stdout;
    counts.adverts++;
    if (hooks.afterAdvertise) hooks.afterAdvertise(counts.adverts);
    return new Response(Buffer.concat([packetLine('# service=git-upload-pack\n'), Buffer.from('0000'), advertised]), { headers: { 'Content-Type': 'application/x-git-upload-pack-advertisement' } });
  };
  env.providerFetch = providerFetch;
  // Collaboration reads refs with the global fetch; only the local provider answers.
  const original = globalThis.fetch;
  globalThis.fetch = (input, init) => String(input).startsWith(`https://${env.ACCOUNT_ID}.artifacts.cloudflare.net/`) ? providerFetch(String(input), init) : Promise.reject(Error('No network in tests'));
  t.after(() => { globalThis.fetch = original; });
  const dispatch = serialize(request => handle(request, env, providerFetch), admission);
  const call = async (path, body, who = 'bob') => {
    const response = await dispatch(new Request(origin + path, { method: 'POST', body: JSON.stringify({ repository: key, repositoryId: '1', ...body }),
      headers: { 'Content-Type': 'application/json', 'Connect-Protocol-Version': '1', Origin: origin, 'X-Golf-Native-Access-Email': who + '@example.com' } }));
    return { status: response.status, ...await response.json() };
  };
  const head = ref => git(['rev-parse', '--verify', '-q', 'refs/heads/' + ref]).stdout.toString().trim();
  const commit = (parent, files, message) => {
    const ops = Object.entries(files).map(([path, content]) => content === null ? { path, delete: true } : { path, content });
    const tree = g.edit(parent ? parent + '^{tree}' : null, ops);
    return g.text(['commit-tree', tree, ...(parent ? ['-p', parent] : []), '-m', message]);
  };
  const ref = (name, hash) => g.run(['update-ref', 'refs/heads/' + name, hash]);
  const base = commit(null, { 'README.md': '# Project\n', 'src/app.js': 'one\ntwo\n', 'docs/guide.md': 'guide\n', 'shared.txt': 'shared\n' }, 'Initial');
  ref('main', base);
  // A pull request from a branch off main with the given files; author alice unless told otherwise.
  const pull = (branch, files, { author = 1, title = 'Change ' + branch, from = head('main') } = {}) => {
    const tip = commit(from, files, title);
    ref(branch, tip);
    const { number, id } = sql.prepare('SELECT COALESCE(max(number),0)+1 AS number,COALESCE(max(id),0)+1 AS id FROM discussions').get();
    sql.prepare("INSERT INTO discussions(id,repository_id,number,kind,author_id,title,body,state,created_at,updated_at) VALUES(?,1,?,'pull',?,?,'','OPEN','t','t')").run(id, number, author, title);
    sql.prepare("INSERT INTO pull_requests(discussion_id,base_branch,head_branch,base_commit,head_commit,draft) VALUES(?,'main',?,?,?,0)").run(id, branch, from, tip);
    return { number, head: tip };
  };
  const settings = (changes = {}) => {
    const s = { enabled: 1, low: ['docs/**', '**/*.md'], sensitive: ['.github/**', 'deploy/**'], landWithoutPerson: 0, checks: [], revert: 1, by: 1, ...changes };
    sql.prepare(`INSERT INTO repository_agentic_settings(repository_id,enabled,low_risk_paths,sensitive_paths,land_without_person,required_checks,revert_on_failure,version,updated_by,updated_at)
      VALUES(1,?,?,?,?,?,?,1,?,'t') ON CONFLICT(repository_id) DO UPDATE SET enabled=excluded.enabled,low_risk_paths=excluded.low_risk_paths,sensitive_paths=excluded.sensitive_paths,
      land_without_person=excluded.land_without_person,required_checks=excluded.required_checks,revert_on_failure=excluded.revert_on_failure,version=version+1,updated_by=excluded.updated_by`)
      .run(s.enabled, JSON.stringify(s.low), JSON.stringify(s.sensitive), s.landWithoutPerson, JSON.stringify(s.checks), s.revert, s.by);
  };
  const run = (commitId, state, name = 'CI', event = 'push') => sql.prepare(`INSERT INTO pipeline_runs(repository_id,artifact_name,engine,number,workflow_path,workflow_name,event,ref,commit_id,actor_id,trusted,state,created_at,updated_at)
    VALUES(1,'${artifact}','forgejo-actions',(SELECT COALESCE(max(number),0)+1 FROM pipeline_runs),?,?,?,'refs/heads/main',?,1,1,?,'t','t')`).run(`.forgejo/workflows/${name}.yml`, name, event, commitId, state);
  const land = (number, who = 'bob', expectedHeadCommitId, method) => call('/native/land', { action: 'land', number, expectedHeadCommitId, ...(method ? { method } : {}) }, who);
  const ops = () => sql.prepare('SELECT * FROM land_operations ORDER BY created_at,rowid').all().map(op => ({ ...op, detail: JSON.parse(op.detail) }));
  const comments = number => sql.prepare('SELECT c.body,u.login FROM discussion_comments c JOIN discussions d ON d.id=c.discussion_id JOIN users u ON u.id=c.author_id WHERE d.number=? ORDER BY c.id').all(number);
  return { g, sql, env, db, dispatch, call, head, commit, ref, pull, settings, run, land, ops, comments, hooks, counts, queued, providerFetch, base };
}

test('backoff is jittered between 200 ms and 2 s, and the policy helper names approval-only refusals', () => {
  for (let attempt = 1; attempt <= 6; attempt++) for (const random of [() => 0, () => 0.5, () => 0.999]) {
    const ms = backoff(attempt, random);
    assert.ok(ms >= 200 && ms <= 2000, `${attempt}: ${ms}`);
  }
  assert.equal(backoff(1, () => 0), 200); assert.equal(backoff(6, () => 0.9999), 2000); assert.equal(landLimits.attempts, 60); assert.equal(landLimits.budgetMs, 45_000);
  assert.equal(onlyApprovalNeeded({ decision: 'needs_person', reasons: ['landing without a person is off for this repository'] }), true);
  assert.equal(onlyApprovalNeeded({ decision: 'needs_person', reasons: ['changes outside the low-risk paths need approval from a writer who is not the author and not an agent', 'required check CI is still running'] }), false);
  assert.equal(onlyApprovalNeeded({ decision: 'needs_person', reasons: ['the pull request is a draft'] }), false);
  assert.equal(onlyApprovalNeeded({ decision: 'land', reasons: [] }), false);
  assert.equal(admission(new Request(origin + '/native/land', { method: 'POST' })), 'transfer');
  assert.equal(admission(new Request(origin + '/native/land/read', { method: 'POST' })), 'read');
});

const base = f => f.base;
test('a writer lands; refusals are named; reads list and get; only browser sessions; audited', { skip }, async t => {
  const f = await fixture(t);
  const a = f.pull('feature-a', { 'src/a.js': 'a\n' });
  // Agentic mode off: refused, nothing recorded.
  assert.match((await f.land(a.number, 'bob', a.head)).message, /Agentic mode is off/);
  f.settings();
  assert.equal((await f.land(a.number, 'carol', a.head)).status, 403);
  assert.equal((await f.land(a.number, 'bob', 'f'.repeat(40))).status, 412);
  assert.equal((await f.call('/native/land', { action: 'land', number: a.number, expectedHeadCommitId: a.head, extra: 1 })).status, 400);
  assert.equal((await f.call('/native/land', { action: 'list' })).status, 400);
  assert.equal((await f.call('/native/land/read', { action: 'land' })).status, 400);
  // The author is not the qualifying approval the policy asks for.
  const own = await f.land(a.number, 'alice', a.head);
  assert.equal(own.status, 412); assert.match(own.message, /Another writer must land or approve/);
  // A pending required check waits even for a writer.
  f.run(a.head, 'RUNNING');
  const waiting = await f.land(a.number, 'bob', a.head);
  assert.equal(waiting.status, 412); assert.match(waiting.message, /needs a person first|still running/);
  f.sql.exec("UPDATE pipeline_runs SET state='SUCCESS'");
  // The evaluation tells each caller whether they may land it.
  const canLand = async who => (await f.call('/native/agentic-mode/read', { action: 'evaluate', number: a.number }, who)).canLand;
  assert.deepEqual([await canLand('alice'), await canLand('bob'), await canLand('carol')], [false, true, false]);
  // headCommitId (or expectedHeadCommitId) and an idempotency key: a replay returns the original operation and sends nothing.
  const idempotencyKey = crypto.randomUUID(), request = { action: 'land', number: a.number, headCommitId: a.head, method: 'squash', idempotencyKey };
  assert.equal((await f.call('/native/land', { ...request, expectedHeadCommitId: base(f) })).status, 400);
  const before = f.head('main'), done = await f.call('/native/land', request);
  assert.equal(done.status, 200, JSON.stringify(done));
  const pushes = f.counts.pushes, replay = await f.call('/native/land', request);
  assert.equal(replay.status, 200); assert.equal(replay.operation.id, done.operation.id); assert.equal(replay.phase, 'LANDED'); assert.equal(f.counts.pushes, pushes);
  assert.equal((await f.call('/native/land', { ...request, method: 'merge' })).status, 409);
  assert.equal((await f.call('/native/land', { ...request, idempotencyKey: 'nope' })).status, 400);
  assert.equal(done.phase, 'LANDED'); assert.equal(done.operation.state, 'LANDED'); assert.equal(done.operation.trigger, 'person'); assert.equal(done.operation.actor, 'bob');
  assert.equal(done.operation.method, 'squash'); assert.equal(done.operation.baseCommitId, before); assert.equal(done.operation.landedCommitId, f.head('main'));
  // Squash: one parent, the person's identity, Git accepts the graph.
  assert.equal(f.g.text(['log', '-1', '--format=%P|%an <%ae>', 'main']), `${before}|Bob <bob@users.noreply.golf.example.com>`);
  assert.equal(f.g.text(['show', 'main:src/a.js']), 'a');
  f.g.run(['fsck', '--strict', '--full', '--no-dangling']);
  // The merge is the standard journal: one SUCCEEDED row, the discussion closed, and a push intake for the base push.
  assert.equal(f.sql.prepare("SELECT phase FROM pull_merge_operations WHERE pull_request_id=?").get(a.number).phase, 'SUCCEEDED');
  assert.equal(f.sql.prepare('SELECT state FROM discussions WHERE number=?').get(a.number).state, 'CLOSED');
  const intake = f.sql.prepare("SELECT kind,payload FROM pipeline_intake").get();
  assert.equal(intake.kind, 'push'); assert.equal(JSON.parse(intake.payload).after, f.head('main'));
  assert.equal((await f.land(a.number, 'bob', a.head)).status, 412);
  const capabilities = (await f.call('/rpc/golf.v1.CapabilityService/ListCapabilities', {})).capabilities;
  assert.equal(capabilities.find(c => c.id === 'repository.agentic-landing').state, 'CAPABILITY_STATE_READY');
  // Reads: list (newest first, optional number filter) and get; a reader can read.
  const list = await f.call('/native/land/read', { action: 'list', limit: 10 }, 'carol');
  assert.equal(list.status, 200); assert.equal(list.operations.length, 1); assert.equal(list.operations[0].id, done.operation.id);
  assert.equal((await f.call('/native/land/read', { action: 'list', number: 99 })).operations.length, 0);
  assert.equal((await f.call('/native/land/read', { action: 'list', limit: 101 })).status, 400);
  assert.equal((await f.call('/native/land/read', { action: 'get', id: done.operation.id })).operation.landedCommitId, f.head('main'));
  assert.equal((await f.call('/native/land/read', { action: 'get', id: crypto.randomUUID() })).status, 404);
  const foreign = await f.dispatch(new Request(origin + '/native/land/read', { method: 'POST', body: JSON.stringify({ repository: key, repositoryId: '1', action: 'list' }),
    headers: { 'Content-Type': 'application/json', 'Connect-Protocol-Version': '1', Origin: 'https://evil.example', 'X-Golf-Native-Access-Email': 'bob@example.com' } }));
  assert.equal(foreign.status, 403);
  assert.deepEqual(f.sql.prepare("SELECT action,subject,json_extract(client,'$.outcome') AS outcome FROM installation_audit WHERE action='agentic_mode.land' ORDER BY id").all().map(row => ({ ...row })),
    [{ action: 'agentic_mode.land', subject: '#1', outcome: 'denied' }, { action: 'agentic_mode.land', subject: '#1', outcome: 'success' }]);
});

test('two pull requests on different files land concurrently; the second re-plans onto the moved base', { skip }, async t => {
  const f = await fixture(t);
  f.settings();
  const a = f.pull('feature-a', { 'src/a.js': 'a\n' }), b = f.pull('feature-b', { 'src/b.js': 'b\n' });
  const before = f.head('main');
  let second;
  // While the first merge is being received, the second land starts: both are transfers, so it is admitted at once and meets the
  // first one's repository reservation, then retries against the new base.
  f.hooks.beforePush = async () => {
    second = f.land(b.number, 'bob', b.head);
    for (let i = 0; i < 200 && !f.ops().some(op => op.number === b.number && op.attempts >= 1); i++) await new Promise(resolve => setTimeout(resolve, 5));
  };
  const first = await f.land(a.number, 'bob', a.head), other = await second;
  assert.equal(first.operation.state, 'LANDED'); assert.equal(other.operation.state, 'LANDED', JSON.stringify(other));
  assert.equal(first.operation.baseCommitId, before);
  assert.equal(other.operation.baseCommitId, first.operation.landedCommitId);
  assert.ok(other.operation.attempts >= 2, `retried: ${other.operation.attempts}`);
  assert.equal(f.head('main'), other.operation.landedCommitId);
  assert.equal(f.g.text(['log', '-1', '--format=%P', 'main']), `${first.operation.landedCommitId} ${b.head}`);
  assert.equal(f.g.text(['show', 'main:src/a.js']), 'a'); assert.equal(f.g.text(['show', 'main:src/b.js']), 'b');
  // Git's own merge of the two branch heads gives the same tree.
  assert.equal(f.g.text(['rev-parse', 'main^{tree}']), f.g.text(['merge-tree', '--write-tree', first.operation.landedCommitId, b.head]));
  f.g.run(['fsck', '--strict', '--full', '--no-dangling']);
  assert.equal(f.sql.prepare('SELECT write_pending FROM repositories').get().write_pending, null);
});

test('six lands requested at once all land, each waiting its turn, without journaling a refusal for the busy repository', { skip }, async t => {
  const f = await fixture(t);
  f.settings();
  const pulls = Array.from({ length: 6 }, (_, i) => f.pull('feature-' + i, { [`src/f${i}.js`]: `${i}\n` }));
  const done = await Promise.all(pulls.map(pull => f.land(pull.number, 'bob', pull.head)));
  assert.deepEqual(done.map(value => value.operation.state), Array(6).fill('LANDED'), JSON.stringify(done.map(value => value.operation.detail)));
  for (let i = 0; i < 6; i++) assert.equal(f.g.text(['show', `main:src/f${i}.js`]), String(i));
  assert.equal(f.sql.prepare("SELECT COUNT(*) AS n FROM pull_merge_operations WHERE phase='REJECTED' AND detail='write_unresolved'").get().n, 0);
  f.g.run(['fsck', '--strict', '--full', '--no-dangling']);
});

test('a base that moves between the read and the merge is re-planned; a moved head stops the land', { skip }, async t => {
  const f = await fixture(t);
  f.settings();
  const a = f.pull('feature-a', { 'src/a.js': 'a\n' });
  const moved = f.commit(f.head('main'), { 'other.txt': 'other\n' }, 'Another push');
  // Advertisements: the evaluation (1), the land's own read (2), the merge request's read (3). The base moves after the second.
  let start = f.counts.adverts;
  f.hooks.afterAdvertise = n => { if (n === start + 2) { f.ref('main', moved); f.hooks.afterAdvertise = null; } };
  const done = await f.land(a.number, 'bob', a.head);
  assert.equal(done.operation.state, 'LANDED', JSON.stringify(done));
  assert.equal(done.operation.attempts, 2); assert.equal(done.operation.baseCommitId, moved);
  assert.deepEqual(f.sql.prepare('SELECT phase,detail FROM pull_merge_operations ORDER BY created_at').all().map(row => [row.phase, row.detail]), [['REJECTED', 'pull_request_changed'], ['SUCCEEDED', '']]);
  assert.equal(f.g.text(['show', 'main:other.txt']), 'other'); assert.equal(f.g.text(['show', 'main:src/a.js']), 'a');

  const b = f.pull('feature-b', { 'src/b.js': 'b\n' });
  const pushed = f.commit(b.head, { 'src/b.js': 'b2\n' }, 'More');
  start = f.counts.adverts;
  f.hooks.afterAdvertise = n => { if (n === start + 2) { f.ref('feature-b', pushed); f.hooks.afterAdvertise = null; } };
  const stopped = await f.land(b.number, 'bob', b.head);
  assert.equal(stopped.operation.state, 'BLOCKED'); assert.match(stopped.operation.detail.reasons[0], /head moved/);
  assert.equal(stopped.phase, 'LAND_REFUSED');
});

test('conflicting paths end in NEEDS_REBASE with the paths, and an agent pull request gets a comment', { skip }, async t => {
  const f = await fixture(t);
  f.settings();
  const a = f.pull('feature-a', { 'shared.txt': 'from a\n' }), b = f.pull('feature-b', { 'shared.txt': 'from b\n', 'src/b.js': 'b\n' });
  f.sql.exec("INSERT INTO pull_request_origins(pull_request_id,kind,created_at) VALUES(2,'agent-task','t')");
  const first = await f.land(a.number, 'bob', a.head);
  assert.equal(first.operation?.state, 'LANDED', JSON.stringify(first));
  const main = f.head('main'), conflicted = await f.land(b.number, 'bob', b.head);
  assert.equal(conflicted.operation.state, 'NEEDS_REBASE'); assert.equal(conflicted.phase, 'LAND_REFUSED');
  assert.deepEqual(conflicted.operation.detail.conflicts, [{ path: 'shared.txt', reason: 'both_modified' }]);
  assert.equal(conflicted.operation.detail.commented, true);
  assert.equal(f.head('main'), main);
  const [note] = f.comments(b.number);
  assert.equal(note.login, 'bob'); assert.match(note.body, /conflicts with `main` in these paths:\n\n- `shared.txt` \(both modified\)/); assert.match(note.body, /follow-up agent task can resolve/);
  assert.equal(f.sql.prepare("SELECT count(*) AS n FROM agent_tasks").get().n, 0);
  // A person's own pull request gets no comment.
  const c = f.pull('feature-c', { 'shared.txt': 'from c\n' }, { from: f.base });
  assert.equal((await f.land(c.number, 'bob', c.head)).operation.state, 'NEEDS_REBASE');
  assert.equal(f.comments(c.number).length, 0);
  // A conflict that appears while landing (the base moved between the evaluation and the merge) is found by the merge plan itself.
  const d = f.pull('feature-d', { 'src/app.js': 'one\nfrom d\n' });
  f.sql.prepare("INSERT INTO pull_request_origins(pull_request_id,kind,created_at) VALUES(?,'agent-task','t')").run(f.sql.prepare('SELECT id FROM pull_requests WHERE head_branch=?').get('feature-d').id);
  const racing = f.commit(f.head('main'), { 'src/app.js': 'one\nfrom main\n' }, 'Racing push'), start = f.counts.adverts;
  f.hooks.afterAdvertise = n => { if (n === start + 1) { f.ref('main', racing); f.hooks.afterAdvertise = null; } };
  const raced = await f.land(d.number, 'bob', d.head);
  assert.equal(raced.operation.state, 'NEEDS_REBASE', JSON.stringify(raced)); assert.equal(raced.operation.attempts, 1);
  assert.deepEqual(raced.operation.detail.conflicts, [{ path: 'src/app.js', reason: 'both_modified' }]);
  assert.equal(f.sql.prepare("SELECT detail FROM pull_merge_operations WHERE pull_request_id=(SELECT id FROM pull_requests WHERE head_branch='feature-d')").get().detail, 'merge_conflict');
  assert.match(f.comments(d.number)[0].body, /`src\/app.js` \(both modified\)/);
});

test('policy landing: only with landing without a person on, low-risk paths and passing checks; Golf is the committer', { skip }, async t => {
  const f = await fixture(t);
  const docs = f.pull('docs-a', { 'docs/a.md': 'a\n' }), code = f.pull('code', { 'src/x.js': 'x\n' }), ci = f.pull('ci', { '.github/workflows/x.yml': 'on: push\n', 'docs/b.md': 'b\n' });
  for (const pr of [docs, code, ci]) f.run(pr.head, 'SUCCESS', 'CI', 'pull_request');
  const options = { withArtifact, pause: async () => {} };
  f.settings({ landWithoutPerson: 0 });
  assert.deepEqual(await autoLand(f.env, 1, options), { evaluated: 0, landed: 0 });
  f.settings({ landWithoutPerson: 1, enabled: 0 });
  assert.deepEqual(await autoLand(f.env, 1, options), { evaluated: 0, landed: 0 });
  // A feature policy that turns agentic mode off stops it too.
  f.settings({ landWithoutPerson: 1 });
  f.sql.exec("INSERT INTO feature_policies(scope,scope_id,feature,mode,version,updated_by,updated_at) VALUES('installation','','agentic-mode','DISABLED',1,1,'t')");
  assert.deepEqual(await autoLand(f.env, 1, options), { evaluated: 0, landed: 0 });
  f.sql.exec("DELETE FROM feature_policies");
  // The pipeline completion hook for the docs head lands it alone.
  await afterPipelineRun(f.env, { repository_id: 1, commit_id: docs.head }, withArtifact);
  const [op] = f.ops();
  assert.equal(op.state, 'LANDED'); assert.equal(op.trigger, 'policy'); assert.equal(op.actor_id, 0); assert.equal(op.number, docs.number); assert.equal(op.detail.principal, 'alice');
  assert.equal(f.g.text(['log', '-1', '--format=%an <%ae>|%cn <%ce>', 'main']), 'Golf (agentic mode) <agentic@golf.invalid>|Golf (agentic mode) <agentic@golf.invalid>');
  // The accountable account in the journals is the administrator who saved the setting.
  assert.equal(f.sql.prepare('SELECT user_id FROM git_operations').get().user_id, 1);
  assert.equal(f.sql.prepare("SELECT action FROM installation_audit WHERE action='agentic_mode.auto_land'").get().action, 'agentic_mode.auto_land');
  // The sweep evaluates the rest: normal-risk and sensitive changes are not landed, and nothing is retried for the same head.
  await sweepLanding(f.env, withArtifact);
  assert.equal(f.ops().length, 1);
  assert.equal(f.sql.prepare("SELECT state FROM discussions WHERE number=?").get(code.number).state, 'OPEN');
  assert.equal(f.sql.prepare("SELECT state FROM discussions WHERE number=?").get(ci.number).state, 'OPEN');
  // An administrator who loses write access stops policy landing.
  const later = f.pull('docs-b', { 'docs/c.md': 'c\n' });
  f.run(later.head, 'SUCCESS', 'CI', 'pull_request');
  f.sql.exec("UPDATE grants SET role='read' WHERE user_id=1");
  assert.deepEqual(await autoLand(f.env, 1, options), { evaluated: 0, landed: 0 });
  f.sql.exec("UPDATE grants SET role='admin' WHERE user_id=1");
  assert.equal((await autoLand(f.env, 1, options)).landed, 1);
});

test('failed checks after a policy landing revert it like git revert, once; comments and an issue for the requester', { skip }, async t => {
  const f = await fixture(t);
  f.settings({ landWithoutPerson: 1 });
  const docs = f.pull('docs-a', { 'docs/a.md': 'a\n', 'docs/guide.md': 'guide v2\n' }, { author: 2, title: 'Document a' });
  f.run(docs.head, 'SUCCESS', 'CI', 'pull_request');
  await autoLand(f.env, 1, { withArtifact });
  const [landedOp] = f.ops();
  assert.equal(landedOp.state, 'LANDED');
  // Someone else lands an unrelated change on main after it.
  const unrelated = f.commit(f.head('main'), { 'src/other.js': 'other\n' }, 'Unrelated');
  f.ref('main', unrelated);
  // Pending: nothing yet. Then the push pipeline of the landed commit fails.
  f.run(landedOp.landed_commit_id, 'RUNNING');
  assert.equal(await checkLanded(f.env, f.ops()[0], { withArtifact }), 'pending');
  f.sql.exec("UPDATE pipeline_runs SET state='FAILURE' WHERE commit_id='" + landedOp.landed_commit_id + "'");
  await afterPipelineRun(f.env, { repository_id: 1, commit_id: landedOp.landed_commit_id }, withArtifact);
  const [op] = f.ops();
  assert.equal(op.state, 'REVERTED'); assert.equal(op.revert_commit_id, f.head('main'));
  assert.deepEqual(op.detail.postLand, { verdict: 'failed', checks: ['CI'], action: 'revert' });
  // The revert is a child of the current tip with the tree `git revert -m 1` gives (the inverse merge onto the tip).
  assert.equal(f.g.text(['log', '-1', '--format=%P|%an <%ae>|%B', 'main']),
    `${unrelated}|Golf (agentic mode) <agentic@golf.invalid>|Revert "Document a" (#1)\n\nAutomatic revert: required checks failed after landing: CI.\n\nThis reverts commit ${landedOp.landed_commit_id}.`);
  assert.equal(f.g.text(['rev-parse', 'main^{tree}']), f.g.text(['merge-tree', '--write-tree', '--merge-base=' + landedOp.landed_commit_id, unrelated, landedOp.landed_commit_id + '^1']));
  assert.equal(f.g.text(['show', 'main:docs/guide.md']), 'guide'); assert.equal(f.g.text(['show', 'main:src/other.js']), 'other');
  assert.notEqual(spawnSync('git', ['--git-dir', f.g.directory, 'cat-file', '-e', 'main:docs/a.md'], { env: f.g.env }).status, 0);
  f.g.run(['fsck', '--strict', '--full', '--no-dangling']);
  // A comment on the pull request and an issue assigned to the requester (bob, the author), both by the accountable administrator.
  const [note] = f.comments(docs.number);
  assert.equal(note.login, 'alice'); assert.match(note.body, /reverted this pull request on `main`/);
  const issue = f.sql.prepare("SELECT d.number,d.title,d.body,u.login AS author,(SELECT x.login FROM discussion_assignees a JOIN users x ON x.id=a.user_id WHERE a.discussion_id=d.id) AS assignee FROM discussions d JOIN users u ON u.id=d.author_id WHERE d.kind='issue'").get();
  assert.equal(issue.title, 'Automatic revert of #1: checks failed'); assert.equal(issue.author, 'alice'); assert.equal(issue.assignee, 'bob'); assert.match(issue.body, /@bob/);
  assert.deepEqual(op.detail.issue, { number: issue.number, assignee: 'bob' });
  // The revert push records its own push intake; the audit names it.
  assert.ok(f.sql.prepare("SELECT 1 FROM pipeline_intake WHERE json_extract(payload,'$.after')=?").get(op.revert_commit_id));
  assert.equal(f.sql.prepare("SELECT json_extract(after,'$.revertCommitId') AS id FROM installation_audit WHERE action='agentic_mode.revert'").get().id, op.revert_commit_id.slice(0, 12));
  // Idempotent: another completion, another check or the sweep revert nothing more.
  const pushes = f.counts.pushes;
  await afterPipelineRun(f.env, { repository_id: 1, commit_id: landedOp.landed_commit_id }, withArtifact);
  assert.equal(await checkLanded(f.env, f.ops()[0], { withArtifact }), 'claimed');
  await sweepLanding(f.env, withArtifact);
  assert.equal(f.counts.pushes, pushes); assert.equal(f.comments(docs.number).length, 1);
  assert.equal(f.sql.prepare("SELECT count(*) AS n FROM discussions WHERE kind='issue'").get().n, 1);
});

test('a revert that conflicts stays LANDED with the paths and opens an issue; a person landing only gets a comment', { skip }, async t => {
  const f = await fixture(t);
  f.settings({ landWithoutPerson: 1 });
  const docs = f.pull('docs-a', { 'docs/guide.md': 'guide v2\n' });
  f.run(docs.head, 'SUCCESS', 'CI', 'pull_request');
  await autoLand(f.env, 1, { withArtifact });
  const landedCommit = f.ops()[0].landed_commit_id;
  // A later change edits the same file: the inverse merge conflicts.
  f.ref('main', f.commit(f.head('main'), { 'docs/guide.md': 'guide v3\n' }, 'Edit again'));
  const tip = f.head('main');
  f.run(landedCommit, 'FAILURE');
  assert.equal(await checkLanded(f.env, f.ops()[0], { withArtifact }), 'conflict');
  const [op] = f.ops();
  assert.equal(op.state, 'LANDED'); assert.equal(op.revert_commit_id, ''); assert.equal(f.head('main'), tip);
  assert.deepEqual(op.detail.revertConflict, [{ path: 'docs/guide.md', reason: 'both_modified' }]);
  assert.equal(op.detail.revert.state, 'conflict');
  assert.match(f.sql.prepare("SELECT body FROM discussions WHERE kind='issue'").get().body, /conflicts with later changes in:\n\n- `docs\/guide.md`/);
  assert.match(f.comments(docs.number)[0].body, /opened an issue instead/);

  // A person's landing whose checks fail is only commented on.
  f.settings({ landWithoutPerson: 0 });
  const code = f.pull('code', { 'src/x.js': 'x\n' });
  const done = await f.land(code.number, 'bob', code.head);
  assert.equal(done.operation.state, 'LANDED');
  f.run(done.operation.landedCommitId, 'FAILURE', 'Tests');
  const main = f.head('main');
  assert.equal(await checkLanded(f.env, f.ops().find(o => o.number === code.number), { withArtifact }), 'commented');
  assert.equal(f.head('main'), main);
  const [note] = f.comments(code.number);
  assert.equal(note.login, 'bob'); assert.match(note.body, /required checks failed on `main` after this pull request landed .*`Tests`.*landed by a person/);
  assert.equal(f.ops().find(o => o.number === code.number).state, 'LANDED');
  // Passing checks close the question without action.
  const passing = f.pull('code-2', { 'src/y.js': 'y\n' });
  const second = await f.land(passing.number, 'bob', passing.head);
  f.run(second.operation.landedCommitId, 'SUCCESS');
  assert.equal(await checkLanded(f.env, f.ops().find(o => o.number === passing.number), { withArtifact }), 'passed');
  assert.deepEqual(f.ops().find(o => o.number === passing.number).detail.postLand, { verdict: 'passed', checks: ['CI'] });
});

test('maintenance settles a land interrupted after its merge was sent', { skip }, async t => {
  const f = await fixture(t);
  f.settings();
  const a = f.pull('feature-a', { 'src/a.js': 'a\n' });
  const done = await f.land(a.number, 'bob', a.head);
  assert.equal(done.operation.state, 'LANDED');
  // An interrupted land: the row still says LANDING, but its merge journal (detail.merge) succeeded.
  f.sql.exec(`UPDATE land_operations SET state='LANDING',landed_commit_id='',updated_at='2026-01-01T00:00:00Z'`);
  await sweepLanding(f.env, withArtifact);
  const [op] = f.ops();
  assert.equal(op.state, 'LANDED'); assert.equal(op.landed_commit_id, f.head('main'));
  // A LANDING row that never journaled a merge is marked FAILED.
  const b = f.pull('feature-b', { 'src/b.js': 'b\n' });
  f.sql.prepare("INSERT INTO land_operations(id,repository_id,pull_request_id,number,trigger,actor_id,state,method,head_commit_id,detail,created_at,updated_at) VALUES(?,1,?,?,'person',2,'LANDING','merge',?,'{}','2026-01-01T00:00:00Z','2026-01-01T00:00:00Z')")
    .run(crypto.randomUUID(), b.number, b.number, b.head);
  await sweepLanding(f.env, withArtifact);
  assert.equal(f.ops().find(o => o.number === b.number).state, 'FAILED');
});

test('landSoon lands the pull request whose head just passed its checks, after the response; only where landing without a person is on', { skip }, async t => {
  const f = await fixture(t);
  const docs = f.pull('docs-soon', { 'docs/soon.md': 'soon\n' });
  f.run(docs.head, 'SUCCESS', 'CI', 'pull_request');
  const pending = [], env = { ...f.env, waitUntil: promise => pending.push(promise) };
  f.settings({ landWithoutPerson: 0 });
  landSoon(env, 1, docs.head, withArtifact); await Promise.all(pending.splice(0));
  assert.equal(f.ops().length, 0);
  f.settings({ landWithoutPerson: 1 });
  landSoon(env, 1, 'not-a-commit', withArtifact);
  assert.equal(pending.length, 0);
  landSoon({ ...f.env }, 1, docs.head, withArtifact);
  assert.equal(f.ops().length, 0);
  landSoon(env, 1, docs.head, withArtifact); await Promise.all(pending.splice(0));
  const [op] = f.ops();
  assert.deepEqual([op.state, op.trigger, op.number], ['LANDED', 'policy', docs.number]);
});
