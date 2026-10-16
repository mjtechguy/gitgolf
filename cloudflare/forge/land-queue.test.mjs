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
import { cleanUpAgentBranch, isAgentBranch, patternMatches } from './src/agent-branches.mjs';
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
  const hooks = { beforePush: null, afterAdvertise: null, busy: 0 }, counts = { pushes: 0, adverts: 0 }, queued = [];
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
      // Git storage busy: the session ends with Git's error packet before any command runs.
      if (hooks.busy > 0) { hooks.busy--; return new Response(Buffer.concat([packetLine('ERR artifacts_git_receive_pack_busy\n'), Buffer.from('0000')]), { headers: { 'Content-Type': 'application/x-git-receive-pack-result' } }); }
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
  assert.equal(list.status, 200); assert.equal(list.operations.length, 1); assert.equal(list.operations[0].id, done.operation.id); assert.equal(list.more, false);
  // `more` only when an older operation is left out: most recently updated first, however long ago it started.
  assert.equal((await f.call('/native/land/read', { action: 'list', limit: 1 })).more, false);
  const retried = crypto.randomUUID();
  f.sql.exec(`INSERT INTO land_operations(id,repository_id,pull_request_id,number,trigger,actor_id,state,created_at,updated_at) SELECT '${retried}',repository_id,pull_request_id,number,'person',actor_id,'BLOCKED','2000-01-01T00:00:00Z','2999-01-01T00:00:00Z' FROM land_operations WHERE id='${done.operation.id}'`);
  const capped = await f.call('/native/land/read', { action: 'list', limit: 1 });
  assert.deepEqual([capped.operations.map(o => o.id), capped.more], [[retried], true]);
  f.sql.exec(`DELETE FROM land_operations WHERE created_at='2000-01-01T00:00:00Z'`);
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

test('Git storage answering busy is retried within the land, and the repository is never left fenced', { skip }, async t => {
  const f = await fixture(t);
  f.settings();
  const a = f.pull('feature-a', { 'src/a.js': 'a\n' });
  f.hooks.busy = 2;
  const done = await f.land(a.number, 'bob', a.head);
  assert.equal(done.operation.state, 'LANDED', JSON.stringify(done)); assert.equal(done.operation.attempts, 3);
  assert.deepEqual(f.sql.prepare('SELECT phase,detail FROM pull_merge_operations ORDER BY created_at').all().map(row => [row.phase, row.detail]),
    [['REJECTED', 'provider_refused'], ['REJECTED', 'provider_refused'], ['SUCCEEDED', '']]);
  assert.equal(f.sql.prepare('SELECT write_pending FROM repositories').get().write_pending, null);
  assert.equal(f.g.text(['show', 'main:src/a.js']), 'a');
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
  // A merge sent while the provider was busy, whose branch never moved: once two minutes old, maintenance settles it as not applied,
  // the land fails and the repository is released (it used to stay fenced for good). A younger one still waits.
  const c = f.pull('feature-c', { 'src/c.js': 'c\n' }), git = crypto.randomUUID(), merge = crypto.randomUUID(), base = f.head('main');
  const stuck = old => {
    f.sql.exec(`DELETE FROM land_operations WHERE number=${c.number}; DELETE FROM pull_merge_operations WHERE pull_request_id=${c.number}; DELETE FROM git_operations WHERE id='${git}'`);
    f.sql.prepare("INSERT INTO git_operations(id,repository_id,user_id,ref,old_sha,new_sha,state,created_at) VALUES(?,1,2,'refs/heads/main',?,?,'DISPATCHED',?)").run(git, base, 'f'.repeat(40), old);
    f.sql.prepare(`INSERT INTO pull_merge_operations(actor_id,operation_id,repository_id,pull_request_id,input_hash,original,phase,detail,git_operation_id,merge_commit_id,actual_base_commit_id,created_at,updated_at)
      VALUES(2,?,1,?,'h',?,'DISPATCH_UNKNOWN','provider_status: ERR artifacts_git_receive_pack_busy',?,'','',?,?)`).run(merge, c.number, JSON.stringify({ number: c.number, headCommitId: c.head, method: 'merge' }), git, old, old);
    f.sql.prepare("UPDATE repositories SET write_pending=? WHERE id=1").run(git);
    f.sql.prepare(`INSERT INTO land_operations(id,repository_id,pull_request_id,number,trigger,actor_id,state,method,head_commit_id,detail,created_at,updated_at)
      VALUES(?,1,?,?,'person',2,'LANDING','merge',?,?,?,'2026-01-01T00:00:00Z')`).run(crypto.randomUUID(), c.number, c.number, c.head, JSON.stringify({ merge: { actorId: '2', operationId: merge } }), old);
  };
  stuck(new Date().toISOString());
  await sweepLanding(f.env, withArtifact);
  assert.equal(f.sql.prepare('SELECT write_pending FROM repositories WHERE id=1').get().write_pending, git);
  stuck('2026-01-01T00:00:00Z');
  await sweepLanding(f.env, withArtifact);
  assert.equal(f.sql.prepare('SELECT write_pending FROM repositories WHERE id=1').get().write_pending, null);
  assert.equal(f.sql.prepare('SELECT phase,detail FROM pull_merge_operations WHERE operation_id=?').get(merge).phase, 'REJECTED');
  assert.equal(f.sql.prepare('SELECT outcome FROM git_ref_writes WHERE operation_id=?').get(git).outcome, 'NOT_APPLIED');
  assert.equal(f.ops().find(o => o.number === c.number).state, 'FAILED');
  assert.equal(f.head('main'), base);
});

test('landSoon reaches its pull request however many are open: it starts from the branches at the commit, not a fixed 200', { skip }, async t => {
  const f = await fixture(t);
  f.settings({ landWithoutPerson: 1 });
  // 250 stale open pull requests whose branches are gone (an agent bench leaves them), then one whose head just passed its checks.
  for (let i = 0; i < 250; i++) {
    const { number, id } = f.sql.prepare('SELECT COALESCE(max(number),0)+1 AS number,COALESCE(max(id),0)+1 AS id FROM discussions').get();
    f.sql.prepare("INSERT INTO discussions(id,repository_id,number,kind,author_id,title,body,state,created_at,updated_at) VALUES(?,1,?,'pull',1,'stale','','OPEN','t','t')").run(id, number);
    f.sql.prepare("INSERT INTO pull_requests(discussion_id,base_branch,head_branch,base_commit,head_commit,draft) VALUES(?,'main',?,?,?,0)").run(id, 'gone-' + i, f.base, f.base);
  }
  const docs = f.pull('docs-late', { 'docs/late.md': 'late\n' });
  // The sweep's order puts it past the first 200 of these.
  const rank = f.sql.prepare(`SELECT rank FROM (SELECT d.number n, ROW_NUMBER() OVER (ORDER BY (p.id*7919)%104729) rank FROM discussions d JOIN pull_requests p ON p.discussion_id=d.id WHERE d.state='OPEN') WHERE n=?`).get(docs.number).rank;
  assert.ok(rank > 200, `rank ${rank}`);
  f.run(docs.head, 'SUCCESS', 'CI', 'pull_request');
  const pending = [], env = { ...f.env, waitUntil: promise => pending.push(promise) };
  landSoon(env, 1, docs.head, withArtifact); await Promise.all(pending.splice(0));
  assert.deepEqual(f.ops().map(op => [op.number, op.state]), [[docs.number, 'LANDED']]);
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

// ---------- the agentic inbox's batch land, revert and agent branch cleanup (AM-5) ----------
// The inbox lands a selection with one POST /native/land per pull request, each with its own idempotency key and expected head.
test('batch land: each pull request is its own land request; the answers are landed, needs rebase, refused and replayed', { skip }, async t => {
  const f = await fixture(t);
  f.settings();
  const a = f.pull('feature-a', { 'shared.txt': 'from a\n' }), b = f.pull('feature-b', { 'shared.txt': 'from b\n' }), c = f.pull('feature-c', { 'src/c.js': 'c\n' });
  const moved = f.commit(c.head, { 'src/c.js': 'c2\n' }, 'Pushed after review');
  f.ref('feature-c', moved);
  const keys = [a, b, c].map(() => crypto.randomUUID());
  const send = (pull, idempotencyKey) => f.call('/native/land', { action: 'land', number: pull.number, headCommitId: pull.head, idempotencyKey });
  const answers = [];
  for (const [i, pull] of [a, b, c].entries()) answers.push(await send(pull, keys[i]));
  assert.deepEqual(answers.map(answer => [answer.status, answer.phase, answer.operation?.state]),
    [[200, 'LANDED', 'LANDED'], [200, 'LAND_REFUSED', 'NEEDS_REBASE'], [412, undefined, undefined]]);
  assert.deepEqual(answers[1].operation.detail.conflicts, [{ path: 'shared.txt', reason: 'both_modified' }]);
  assert.match(answers[2].message, /head moved to/);
  // A retried batch replays each key: the same operations, nothing sent again.
  const pushes = f.counts.pushes;
  const again = [await send(a, keys[0]), await send(b, keys[1])];
  assert.deepEqual(again.map(answer => answer.operation.id), [answers[0].operation.id, answers[1].operation.id]);
  assert.equal(f.counts.pushes, pushes);
  // One key per pull request: reusing a's key for another pull request is refused.
  assert.equal((await send(c, keys[0])).status, 409);
  assert.equal(f.sql.prepare("SELECT count(*) AS n FROM installation_audit WHERE action='agentic_mode.land'").get().n >= 3, true);
});

test('a writer reverts a landing from the inbox: confirmed by key and landed commit, as themselves, once; conflicts refuse it; audited', { skip }, async t => {
  const f = await fixture(t);
  f.settings();
  const a = f.pull('feature-a', { 'docs/guide.md': 'guide v2\n', 'src/a.js': 'a\n' }, { title: 'Guide and a' });
  const landed = (await f.land(a.number, 'bob', a.head)).operation;
  assert.equal(landed.state, 'LANDED');
  const unrelated = f.commit(f.head('main'), { 'src/other.js': 'other\n' }, 'Unrelated');
  f.ref('main', unrelated);
  const revert = (body = {}, who = 'bob') => f.call('/native/land', { action: 'revert', id: landed.id, number: a.number, landedCommitId: landed.landedCommitId, idempotencyKey: crypto.randomUUID(), ...body }, who);
  // Readers may not; the request names the exact landing and a key; unknown fields are refused.
  assert.equal((await revert({}, 'carol')).status, 403);
  assert.equal((await revert({ landedCommitId: 'f'.repeat(40) })).status, 409);
  assert.equal((await revert({ idempotencyKey: undefined })).status, 400);
  assert.equal((await revert({ extra: true })).status, 400);
  assert.equal((await revert({ id: crypto.randomUUID() })).status, 404);
  assert.equal((await f.call('/native/land/read', { action: 'revert' })).status, 400);
  assert.equal(f.head('main'), unrelated);
  const idempotencyKey = crypto.randomUUID(), done = await revert({ idempotencyKey, reason: 'Broke the docs build.' });
  assert.equal(done.status, 200, JSON.stringify(done));
  assert.equal(done.phase, 'REVERTED'); assert.equal(done.operation.state, 'REVERTED'); assert.equal(done.operation.revertCommitId, f.head('main'));
  assert.equal(done.revert.state, 'applied'); assert.equal(done.revert.trigger, 'person'); assert.equal(done.revert.actor, 'bob');
  // The inverse merge onto the current tip, as `git revert -m 1`, committed as the person.
  assert.equal(f.g.text(['log', '-1', '--format=%P|%an <%ae>|%B', 'main']),
    `${unrelated}|Bob <bob@example.com>|Revert "Guide and a" (#1)\n\nBroke the docs build.\n\nReverted by @bob from the agentic inbox.\n\nThis reverts commit ${landed.landedCommitId}.`);
  assert.equal(f.g.text(['rev-parse', 'main^{tree}']), f.g.text(['merge-tree', '--write-tree', '--merge-base=' + landed.landedCommitId, unrelated, landed.landedCommitId + '^1']));
  assert.equal(f.g.text(['show', 'main:docs/guide.md']), 'guide'); assert.equal(f.g.text(['show', 'main:src/other.js']), 'other');
  f.g.run(['fsck', '--strict', '--full', '--no-dangling']);
  // The journal names bob; a comment on the pull request; a push intake for the revert; the audit records it.
  assert.equal(f.sql.prepare('SELECT user_id FROM git_operations WHERE new_sha=?').get(done.operation.revertCommitId).user_id, 2);
  assert.match(f.comments(a.number).at(-1).body, /^@bob reverted this pull request on `main` with [0-9a-f]{12} from the agentic inbox\.\n\n> Broke the docs build\.$/);
  assert.ok(f.sql.prepare("SELECT 1 FROM pipeline_intake WHERE json_extract(payload,'$.after')=?").get(done.operation.revertCommitId));
  const audit = f.sql.prepare("SELECT subject,after,json_extract(client,'$.outcome') AS outcome FROM installation_audit WHERE action='agentic_mode.revert_landing' AND json_extract(client,'$.outcome')='success'").get();
  assert.equal(audit.subject, '#1'); assert.equal(JSON.parse(audit.after).reason, 'Broke the docs build.');
  // A replay answers the same revert and sends nothing; another request is refused; the automatic revert no longer applies.
  const pushes = f.counts.pushes;
  assert.equal((await revert({ idempotencyKey, reason: 'Broke the docs build.' })).operation.revertCommitId, done.operation.revertCommitId);
  const twice = await revert();
  assert.equal(twice.status, 412); assert.match(twice.message, /already reverted/);
  f.run(landed.landedCommitId, 'FAILURE');
  await afterPipelineRun(f.env, { repository_id: 1, commit_id: landed.landedCommitId }, withArtifact);
  assert.equal(f.counts.pushes, pushes);

  // A revert that conflicts with a later change stays LANDED, says which paths, and gives the post-landing check back.
  const b = f.pull('feature-b', { 'docs/b.md': 'b\n' }, { title: 'Doc b' });
  const second = (await f.land(b.number, 'bob', b.head)).operation;
  f.ref('main', f.commit(f.head('main'), { 'docs/b.md': 'b edited\n' }, 'Edit b'));
  const tip = f.head('main');
  const refused = await f.call('/native/land', { action: 'revert', id: second.id, number: b.number, landedCommitId: second.landedCommitId, idempotencyKey: crypto.randomUUID() });
  assert.equal(refused.status, 200); assert.equal(refused.phase, 'REVERT_REFUSED'); assert.equal(refused.operation.state, 'LANDED');
  assert.deepEqual([refused.revert.state, refused.revert.conflicts], ['conflict', [{ path: 'docs/b.md', reason: 'deleted_by_them' }]]);
  assert.equal(f.head('main'), tip); assert.equal(refused.operation.detail.postLand, undefined);
  assert.equal(f.sql.prepare("SELECT json_extract(client,'$.outcome') AS outcome FROM installation_audit WHERE action='agentic_mode.revert_landing' ORDER BY id DESC").get().outcome, 'refused');
  // After a conflict a person may try again (it conflicts again).
  assert.equal((await f.call('/native/land', { action: 'revert', id: second.id, number: b.number, landedCommitId: second.landedCommitId, idempotencyKey: crypto.randomUUID() })).phase, 'REVERT_REFUSED');
});

test('a policy landing reverted by a person; an automatic revert in flight refuses a person, and a person in flight keeps the automatic one out', { skip }, async t => {
  const f = await fixture(t);
  f.settings({ landWithoutPerson: 1 });
  const docs = f.pull('docs-a', { 'docs/a.md': 'a\n' }, { title: 'Doc a' });
  f.run(docs.head, 'SUCCESS', 'CI', 'pull_request');
  await autoLand(f.env, 1, { withArtifact });
  const [op] = f.ops();
  assert.equal(op.trigger, 'policy');
  // An automatic revert that claimed the landing a moment ago and has not recorded an attempt: a person waits.
  f.sql.prepare("UPDATE land_operations SET detail=json_set(detail,'$.postLand',json(?)),updated_at=? WHERE id=?").run(JSON.stringify({ verdict: 'failed', checks: ['CI'], action: 'revert' }), new Date().toISOString(), op.id);
  const request = { action: 'revert', id: op.id, number: docs.number, landedCommitId: op.landed_commit_id };
  const busy = await f.call('/native/land', { ...request, idempotencyKey: crypto.randomUUID() });
  assert.equal(busy.status, 412); assert.match(busy.message, /already in progress/);
  // Ten minutes on without an attempt, the claim no longer holds a person back.
  f.sql.prepare("UPDATE land_operations SET updated_at='2026-01-01T00:00:00Z' WHERE id=?").run(op.id);
  const done = await f.call('/native/land', { ...request, idempotencyKey: crypto.randomUUID() });
  assert.equal(done.phase, 'REVERTED', JSON.stringify(done));
  assert.equal(f.g.text(['log', '-1', '--format=%an', 'main']), 'Bob');
  assert.equal(f.sql.prepare("SELECT count(*) AS n FROM discussions WHERE kind='issue'").get().n, 0);
  // A person's claim also takes the post-landing check, so checkLanded cannot start an automatic revert alongside it.
  const later = f.pull('docs-b', { 'docs/b.md': 'b\n' });
  f.run(later.head, 'SUCCESS', 'CI', 'pull_request');
  await autoLand(f.env, 1, { withArtifact });
  const second = f.ops().find(o => o.number === later.number);
  f.sql.prepare("UPDATE land_operations SET detail=json_set(detail,'$.revert',json(?),'$.postLand',json(?)) WHERE id=?").run(JSON.stringify({ state: 'requested', trigger: 'person', actorId: '2', actor: 'bob', key: crypto.randomUUID() }), JSON.stringify({ verdict: 'person_revert', checks: [] }), second.id);
  f.run(second.landed_commit_id, 'FAILURE');
  assert.equal(await checkLanded(f.env, f.ops().find(o => o.id === second.id), { withArtifact }), 'claimed');
  // A person's revert interrupted after it was sent is settled by maintenance from the branch fence's journal, and told as theirs.
  const sent = crypto.randomUUID(), revertCommit = 'e'.repeat(40);
  f.sql.prepare("INSERT INTO git_operations(id,repository_id,user_id,ref,old_sha,new_sha,state,created_at) VALUES(?,1,2,'refs/heads/main',?,?,'APPLIED','t')").run(sent, f.head('main'), revertCommit);
  f.sql.prepare("UPDATE land_operations SET detail=json_set(detail,'$.revert',json(?)),updated_at='2026-01-01T00:00:00Z' WHERE id=?")
    .run(JSON.stringify({ state: 'sending', trigger: 'person', actorId: '2', actor: 'bob', key: crypto.randomUUID(), operationId: sent, commitId: revertCommit }), second.id);
  await sweepLanding(f.env, withArtifact);
  const settled = f.ops().find(o => o.id === second.id);
  assert.deepEqual([settled.state, settled.revert_commit_id, settled.detail.revert.state], ['REVERTED', revertCommit, 'applied']);
  assert.match(f.comments(later.number).at(-1).body, /^@bob reverted this pull request on `main` with eeeeeeeeeeee from the agentic inbox\.$/);
  assert.equal(f.sql.prepare("SELECT count(*) AS n FROM discussions WHERE kind='issue'").get().n, 0);
});

// ---------- agent branches ----------
test('agent branch patterns: golf-agent/* and token patterns, never * and never the default branch', () => {
  assert.equal(patternMatches('golf-agent/*', 'golf-agent/1a2b3c4d'), true); assert.equal(patternMatches('agent/*', 'agent'), false);
  assert.equal(patternMatches('agent/fix', 'agent/fix'), true); assert.equal(patternMatches('*', 'anything'), false); assert.equal(patternMatches('', 'x'), false);
  assert.equal(isAgentBranch(['golf-agent/*', 'main'], 'main', 'main'), false); assert.equal(isAgentBranch(['golf-agent/*'], 'feature', 'main'), false);
  assert.equal(isAgentBranch(['golf-agent/*', 'agent/*'], 'agent/x', 'main'), true);
});

test('after landing, merging or closing, Golf deletes the agent head branch through the branch fence and audits it; other branches stay', { skip }, async t => {
  const f = await fixture(t);
  f.settings();
  const exists = name => Boolean(f.head(name));
  // A token whose branch pattern is agent/*; another whose pattern is * marks nothing.
  const token = (pattern, id) => f.sql.prepare("INSERT INTO api_tokens(id,digest,user_id,label,repositories,permission,branch_pattern,identity_version,created_at,expires_at) VALUES(?,?,2,'agent',NULL,'write',?,0,0,3600)").run(id, 'd' + id, pattern);
  token('agent/*', 1); token('*', 2);
  assert.deepEqual((await f.call('/native/agent-inbox/read', { action: 'branches' })).patterns, ['golf-agent/*', 'agent/*']);
  assert.equal((await f.call('/native/agent-inbox/read', { action: 'branches' })).cleanup, true);
  // Landed through the land queue: golf-agent/… and agent/… are deleted, feature-x stays.
  const task = f.pull('golf-agent/1a2b3c4d', { 'src/task.js': 'task\n' }), viaToken = f.pull('agent/fix-1', { 'src/token.js': 'token\n' }), person = f.pull('feature-x', { 'src/x.js': 'x\n' });
  for (const pull of [task, viaToken, person]) assert.equal((await f.land(pull.number, 'bob', pull.head)).operation.state, 'LANDED');
  assert.deepEqual([exists('golf-agent/1a2b3c4d'), exists('agent/fix-1'), exists('feature-x')], [false, false, true]);
  const deletions = f.sql.prepare("SELECT subject,after,actor_id,json_extract(client,'$.via') AS via FROM installation_audit WHERE action='agentic_mode.branch_delete' ORDER BY id").all();
  assert.deepEqual(deletions.map(row => [row.subject, row.actor_id, row.via]), [['golf-agent/1a2b3c4d', 0, 'agentic-mode'], ['agent/fix-1', 0, 'agentic-mode']]);
  assert.deepEqual(JSON.parse(deletions[0].after), { branch: 'golf-agent/1a2b3c4d', number: task.number, why: 'landed', headCommitId: task.head, principal: 'alice' });
  // Through the journal and the fence: an APPLIED git operation to zero under the administrator, the fence released, no pipeline intake for it.
  const journal = f.sql.prepare("SELECT user_id,old_sha,new_sha,state FROM git_operations WHERE ref='refs/heads/golf-agent/1a2b3c4d'").get();
  assert.deepEqual({ ...journal }, { user_id: 1, old_sha: task.head, new_sha: '0'.repeat(40), state: 'APPLIED' });
  assert.equal(f.sql.prepare('SELECT count(*) AS n FROM git_ref_writes').get().n, 0);
  assert.equal(f.sql.prepare("SELECT count(*) AS n FROM pipeline_intake WHERE json_extract(payload,'$.ref')='refs/heads/golf-agent/1a2b3c4d'").get().n, 0);

  // Closed through the API: deleted at the head it had when it was closed.
  const closing = f.pull('golf-agent/2b3c4d5e', { 'src/closed.js': 'closed\n' });
  const pr = (await f.call('/rpc/golf.v1.RepositoryService/GetPullRequest', { number: closing.number })).pullRequest;
  const closed = await f.call('/rpc/golf.v1.RepositoryService/UpdatePullRequest', { number: closing.number, pullRequestId: pr.id, expectedRevision: pr.revision, state: 'ISSUE_STATE_CLOSED', idempotencyKey: crypto.randomUUID() }, 'alice');
  assert.equal(closed.status, 200, closed.message);
  assert.equal(exists('golf-agent/2b3c4d5e'), false);
  assert.equal(JSON.parse(f.sql.prepare("SELECT after FROM installation_audit WHERE subject='golf-agent/2b3c4d5e'").get().after).why, 'closed');

  // Merged with the Merge button (the standard native merge): deleted too.
  const merging = f.pull('golf-agent/3c4d5e6f', { 'src/merged.js': 'merged\n' });
  const current = (await f.call('/rpc/golf.v1.RepositoryService/GetPullRequest', { number: merging.number })).pullRequest;
  const merged = await f.call('/rpc/golf.v1.StandardPullMergeService/SubmitStandardPullMerge', { selection: { repository: key, repositoryId: '1', pullRequestId: current.id, number: merging.number,
    baseCommitId: current.base.commitId, headCommitId: current.head.commitId }, ownerId: '1', expectedPullRevision: current.revision, operationId: crypto.randomUUID(), sourceRef: 'golf-agent/3c4d5e6f', targetRef: 'main' }, 'alice');
  assert.equal(merged.operation?.phase, 'STANDARD_PULL_MERGE_PHASE_SUCCEEDED', JSON.stringify(merged));
  assert.equal(exists('golf-agent/3c4d5e6f'), false);
  f.g.run(['fsck', '--strict', '--full', '--no-dangling']);
});

test('an agent branch is kept when its head moved, another open pull request uses it, a rule covers it, a task writes to it or agentic mode is off', { skip }, async t => {
  const f = await fixture(t);
  f.settings();
  const exists = name => Boolean(f.head(name));
  const pullId = number => f.sql.prepare('SELECT p.id FROM pull_requests p JOIN discussions d ON d.id=p.discussion_id WHERE d.number=?').get(number).id;
  const close = number => f.sql.prepare("UPDATE discussions SET state='CLOSED' WHERE number=?").run(number);
  const cleanup = (pull, headCommitId = pull.head) => cleanUpAgentBranch(f.env, { repositoryId: 1, pullRequestId: pullId(pull.number), headCommitId, why: 'closed' }, { withArtifact, pause: async () => {} });
  // Still open: kept.
  const open = f.pull('golf-agent/00000001', { 'a.txt': 'a\n' });
  assert.match((await cleanup(open)).reason, /is open/);
  // The head moved after it was closed (an agent pushed again): kept.
  const moved = f.pull('golf-agent/00000002', { 'b.txt': 'b\n' });
  close(moved.number);
  f.ref('golf-agent/00000002', f.commit(moved.head, { 'b.txt': 'b2\n' }, 'Again'));
  assert.match((await cleanup(moved)).reason, /moved to/);
  assert.equal(exists('golf-agent/00000002'), true);
  // Another open pull request uses it as its head or its base: kept.
  const shared = f.pull('golf-agent/00000003', { 'c.txt': 'c\n' });
  f.pull('golf-agent/00000003', { 'c.txt': 'c\n' }, { from: f.head('main') });
  f.ref('golf-agent/00000003', shared.head);
  close(shared.number);
  assert.match((await cleanup(shared)).reason, /another open pull request/);
  const stacked = f.pull('golf-agent/00000004', { 'd.txt': 'd\n' });
  const above = f.pull('topic-above', { 'e.txt': 'e\n' }, { from: stacked.head });
  f.sql.prepare("UPDATE pull_requests SET base_branch='golf-agent/00000004' WHERE head_branch='topic-above'").run();
  close(stacked.number);
  assert.match((await cleanup(stacked)).reason, /another open pull request/);
  assert.equal(exists('golf-agent/00000004'), true); assert.ok(above.number);
  // An unfinished agent task writes to it: kept.
  const tasked = f.pull('golf-agent/00000005', { 'f.txt': 'f\n' });
  close(tasked.number);
  f.sql.exec(`INSERT INTO agent_hosts(id,uuid,name,scope,scope_id,registered_by,credential_digest,created_at) VALUES(1,'u','laptop','personal','1',1,'x','t')`);
  f.sql.prepare(`INSERT INTO agent_tasks(id,repository_id,artifact_name,host_id,tool,requested_by,target_kind,target_number,target_title,base_ref,base_commit,branch,prompt,state,deadline,idempotency_key,created_at,updated_at)
    VALUES('00000005-0000-4000-8000-000000000000',1,?,1,'claude',1,'issue',1,'t','refs/heads/main',?,'golf-agent/00000005','p','RUNNING',0,'k','t','t')`).run(artifact, f.base);
  assert.match((await cleanup(tasked)).reason, /agent task writes/);
  // A branch rule covers it: kept.
  const ruled = f.pull('golf-agent/00000006', { 'g.txt': 'g\n' });
  close(ruled.number);
  f.sql.prepare("INSERT INTO repository_rules(repository_id,artifact_name,version,branches,tags,next_tag) VALUES(1,?,1,?,'[]',1)").run(artifact, JSON.stringify([{ ruleName: 'golf-agent/00000006' }]));
  assert.match((await cleanup(ruled)).reason, /branch rule/);
  // A non-agent branch is never deleted, even closed at its head.
  const plain = f.pull('feature-plain', { 'h.txt': 'h\n' });
  close(plain.number);
  assert.equal((await cleanup(plain)).reason, 'not an agent branch');
  // Agentic mode off (or turned off by a policy): kept.
  const off = f.pull('golf-agent/00000007', { 'i.txt': 'i\n' });
  close(off.number);
  f.settings({ enabled: 0 });
  assert.match((await cleanup(off)).reason, /agentic mode is off/);
  f.settings();
  f.sql.exec("INSERT INTO feature_policies(scope,scope_id,feature,mode,version,updated_by,updated_at) VALUES('installation','','agentic-mode','DISABLED',1,1,'t')");
  assert.match((await cleanup(off)).reason, /agentic mode is off/);
  f.sql.exec('DELETE FROM feature_policies');
  // An administrator who lost write access authorizes nothing.
  f.sql.exec("UPDATE grants SET role='read' WHERE user_id=1");
  assert.match((await cleanup(off)).reason, /no longer has write access/);
  f.sql.exec("UPDATE grants SET role='admin' WHERE user_id=1");
  for (const name of ['golf-agent/00000001', 'golf-agent/00000003', 'golf-agent/00000005', 'golf-agent/00000006', 'feature-plain', 'golf-agent/00000007']) assert.equal(exists(name), true, name);
  assert.equal(f.sql.prepare("SELECT count(*) AS n FROM installation_audit WHERE action='agentic_mode.branch_delete'").get().n, 0);
  // Once nothing holds it, the same call deletes it, and a second call finds it gone.
  assert.deepEqual(await cleanup(off), { deleted: true, reason: '', operationId: f.sql.prepare("SELECT id FROM git_operations WHERE ref='refs/heads/golf-agent/00000007'").get().id });
  assert.equal(exists('golf-agent/00000007'), false);
  assert.match((await cleanup(off)).reason, /no longer exists/);
  // A delete request whose guard no longer holds (another pull request opened from the branch in between) sends nothing.
  const raced = f.pull('golf-agent/00000008', { 'j.txt': 'j\n' });
  close(raced.number);
  f.hooks.afterAdvertise = () => { f.hooks.afterAdvertise = null; f.sql.prepare("UPDATE discussions SET state='OPEN' WHERE number=?").run(raced.number); };
  const pushes = f.counts.pushes;
  assert.match((await cleanup(raced)).reason, /came into use/);
  assert.equal(f.counts.pushes, pushes); assert.equal(exists('golf-agent/00000008'), true);
});
