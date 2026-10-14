import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { pipelineFixture } from './pipeline-fixture.mjs';
import { recordPipelineIntake, processPipelineIntake, dispatchWorkflow, listWorkflows } from './src/actions-intake.mjs';

// An in-memory Git object store with the Artifacts read API the intake uses.
function store() {
  const objects = new Map(), hash = value => createHash('sha1').update(JSON.stringify(value)).digest('hex');
  const put = value => { const id = hash(value); objects.set(id, value); return id; };
  const tree = files => {
    const entries = new Map();
    for (const [path, content] of Object.entries(files)) {
      const [head, ...rest] = path.split('/');
      if (rest.length) entries.set(head, { ...(entries.get(head) || {}), [rest.join('/')]: content }); else entries.set(head, content);
    }
    return put([...entries].map(([name, value]) => typeof value === 'string' ? { name, type: 'blob', mode: '100644', hash: put({ blob: value }) } : { name, type: 'tree', mode: '040000', hash: tree(value) }));
  };
  const commit = (files, parents = [], message = 'change') => { const treeHash = tree(files); const id = put({ treeHash, parents, message }); objects.set(id, { hash: id, treeHash, parents, message, author: { name: 'A' }, authoredAt: 1 }); return id; };
  const repo = { createToken: async () => ({ plaintext: 'fixture-token' }), revokeToken: async () => true, readCommit: async id => objects.get(id)?.treeHash ? objects.get(id) : null, readTree: async id => Array.isArray(objects.get(id)) ? objects.get(id) : null,
    readBlob: async id => objects.get(id)?.blob !== undefined ? new Blob([objects.get(id).blob]) : null };
  return { commit, repo };
}
const ci = (extra = '') => `name: CI\non:\n  push:\n    branches: [main]\n    paths-ignore: ['docs/**']\n  pull_request:\n  workflow_dispatch:\n    inputs:\n      note:\n        default: hi\n${extra}jobs:\n  test:\n    runs-on: ubuntu-latest\n    strategy:\n      matrix:\n        node: [20, 22]\n    steps:\n      - run: echo \${{ matrix.node }}\n`;

test('push, pull_request and dispatch intake discover workflows at the exact commit, apply filters and refuse unsupported syntax visibly', async t => {
  const f = await pipelineFixture(t);
  const { commit, repo } = store();
  const base = commit({ '.github/workflows/ci.yml': ci(), '.github/workflows/broken.yml': 'on: push\njobs:\n  a:\n    uses: org/repo/.github/workflows/x.yml@v1\n', '.github/workflows/tags.yml': "on:\n  push:\n    tags: ['v*']\njobs:\n  a: {runs-on: x, steps: [{run: a}]}\n", 'src/a.js': '1' });
  const docsOnly = commit({ '.github/workflows/ci.yml': ci(), '.github/workflows/broken.yml': 'on: push\njobs:\n  a:\n    uses: org/repo/.github/workflows/x.yml@v1\n', '.github/workflows/tags.yml': "on:\n  push:\n    tags: ['v*']\njobs:\n  a: {runs-on: x, steps: [{run: a}]}\n", 'docs/x.md': 'd', 'src/a.js': '1' }, [base]);
  const withArtifact = async (env, row, action) => action(repo);
  // The PR intake reads the base branch tip from a Smart HTTP advertisement.
  const packet = text => (text.length + 4).toString(16).padStart(4, '0') + text;
  let advertised = new Map();
  const env = { ...f.env, waitUntil: undefined, providerFetch: async () => new Response(packet('# service=git-upload-pack\n') + '0000' + [...advertised].map(([ref, sha], i) => packet(`${sha} ${ref}${i ? '' : '\0side-band-64k'}\n`)).join('') + '0000',
    { headers: { 'Content-Type': 'application/x-git-upload-pack-advertisement' } }) };
  const runs = () => f.sql.prepare('SELECT workflow_path,event,state,reason,ref,trusted FROM pipeline_runs ORDER BY id').all().map(row => ({ ...row }));
  await processPipelineIntake(env, await recordPipelineIntake(f.db, env, 1, 'push', { ref: 'refs/heads/main', before: '0'.repeat(40), after: base, actorId: 1 }, 'push:1'), withArtifact);
  assert.deepEqual(runs().map(r => [r.workflow_path, r.state]), [['.github/workflows/broken.yml', 'REFUSED'], ['.github/workflows/ci.yml', 'QUEUED']]);
  assert.match(runs()[0].reason, /reusable workflows/);
  assert.equal(f.sql.prepare("SELECT COUNT(*) AS n FROM pipeline_jobs").get().n, 2);
  // A replayed intake records nothing new; a docs-only push is ignored by paths-ignore.
  assert.equal(await recordPipelineIntake(f.db, env, 1, 'push', {}, 'push:1'), null);
  await processPipelineIntake(env, await recordPipelineIntake(f.db, env, 1, 'push', { ref: 'refs/heads/main', before: base, after: docsOnly, actorId: 1 }), withArtifact);
  assert.deepEqual(runs().slice(2).map(r => [r.workflow_path, r.state]), [['.github/workflows/broken.yml', 'REFUSED']]);
  // Tag push matches only the tag workflow.
  await processPipelineIntake(env, await recordPipelineIntake(f.db, env, 1, 'push', { ref: 'refs/tags/v1.0', before: '0'.repeat(40), after: base, actorId: 1 }), withArtifact);
  assert.deepEqual(runs().slice(3).map(r => [r.workflow_path, r.ref]), [['.github/workflows/broken.yml', 'refs/tags/v1.0'], ['.github/workflows/tags.yml', 'refs/tags/v1.0']]);
  // Same-repository pull request: trusted, refs/pull/N/head, both workflows that list pull_request.
  f.sql.exec(`INSERT INTO discussions(id,repository_id,number,kind,author_id,title,body,state,created_at,updated_at) VALUES(1,1,4,'pull',1,'Docs','','OPEN','t','t');
    INSERT INTO pull_requests(id,discussion_id,base_branch,head_branch,base_commit,head_commit,draft) VALUES(1,1,'main','docs','${base}','${docsOnly}',0)`);
  advertised = new Map([['refs/heads/main', base], ['refs/heads/docs', docsOnly]]);
  await processPipelineIntake(env, await recordPipelineIntake(f.db, env, 1, 'pull_request', { number: 4, action: 'opened', headCommitId: docsOnly, actorId: 1 }), withArtifact);
  const pr = runs().slice(5);
  assert.deepEqual(pr.map(r => [r.workflow_path, r.event, r.ref, r.trusted, r.state]), [['.github/workflows/ci.yml', 'pull_request', 'refs/pull/4/head', 1, 'QUEUED']]);
  const payload = JSON.parse(f.sql.prepare("SELECT event_payload FROM pipeline_runs WHERE event='pull_request' LIMIT 1").get().event_payload);
  assert.equal(payload.pull_request.head.sha, docsOnly); assert.equal(payload.action, 'opened');
  // Dispatch with inputs on a branch head, and the workflow inventory the tab offers.
  const refs = new Map([['refs/heads/main', base]]);
  const dispatchArtifact = async (e, row, action) => action(repo);
  const originalRefs = await import('./src/actions-intake.mjs');
  assert.ok(originalRefs.repositoryRefs);
  const listed = await listWorkflows(env, { id: 1 }, repo, base);
  assert.deepEqual(listed.map(w => [w.path, w.dispatch, w.error ? 'error' : '']), [['.github/workflows/broken.yml', false, ''], ['.github/workflows/ci.yml', true, ''], ['.github/workflows/tags.yml', false, '']]);
  assert.deepEqual(listed[1].inputs.map(i => [i.name, i.default]), [['note', 'hi']]);
  void refs;
  const row = f.sql.prepare('SELECT * FROM repositories WHERE id=1').get();
  const dispatched = await dispatchWorkflow(f.db, env, { id: 1, login: 'alice' }, row, { workflowPath: '.github/workflows/ci.yml', ref: 'main', inputs: { note: 'release' } }, dispatchArtifact);
  const stored = f.sql.prepare('SELECT event,inputs,title,trusted FROM pipeline_runs WHERE id=?').get(dispatched.runId);
  assert.deepEqual({ ...stored }, { event: 'workflow_dispatch', inputs: '{"note":"release"}', title: 'Manually run by alice', trusted: 1 });
  await assert.rejects(dispatchWorkflow(f.db, env, { id: 1, login: 'alice' }, row, { workflowPath: '.github/workflows/ci.yml', ref: 'main', inputs: { other: 'x' } }, dispatchArtifact), /Unexpected input/);
  await assert.rejects(dispatchWorkflow(f.db, env, { id: 1, login: 'alice' }, row, { workflowPath: '.github/workflows/tags.yml', ref: 'main' }, dispatchArtifact), /no workflow_dispatch/);
});
