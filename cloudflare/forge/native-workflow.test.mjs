import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { nativeWorkflow, nativeWorkflowPath, nativeWorkflowPlanOK, nativeWorkflowSource } from './src/native-workflow.mjs';

const actions = `name: Verify
on: pull_request
jobs:
  check:
    runs-on: golf-native-linux
    steps:
      - name: First
        run: |
          printf 'hello\\n'
          test -f README.md
      - run: echo done
        shell: sh
`;
const gitlab = `stages: [test]
check:
  stage: test
  before_script:
    - export VALUE=ready
  script:
    - test "$VALUE" = ready
  after_script:
    - echo cleanup
`;

test('native shell profiles preserve Actions step isolation and GitLab shared main shell', () => {
  const action = nativeWorkflow('actions', actions), lab = nativeWorkflow('gitlab', gitlab);
  assert.equal(action.steps.length, 2);
  assert.equal(action.steps[0].shell, 'default');
  assert.equal(action.steps[1].shell, 'sh');
  assert.equal(lab.steps[0].run, 'export VALUE=ready\ntest "$VALUE" = ready');
  assert.equal(lab.afterScript, 'echo cleanup');
  assert.equal(nativeWorkflowPlanOK(action), true);
  assert.equal(nativeWorkflowPlanOK(lab), true);
  assert.equal(nativeWorkflowPath('actions', '.github/workflows/check.yml'), true);
  assert.equal(nativeWorkflowPath('gitlab', '.gitlab-ci.yml'), true);
});

test('unsupported syntax and YAML ambiguity never produce an executable plan', () => {
  for (const source of [
    actions.replace('on: pull_request', 'on: pull_request_target'),
    actions.replace('run: echo done', 'uses: actions/checkout@v4'),
    actions.replace('run: echo done', 'run: echo ${{ secrets.TOKEN }}'),
    actions.replace('on: pull_request', 'on: pull_request\non: push'),
    actions.replace('run: echo done', 'run: *script'),
    actions.replace('run: echo done', 'run: !unsafe echo done'),
    actions.replace('runs-on: golf-native-linux', 'runs-on: ubuntu-latest'),
    actions.replace('shell: sh', 'env: { TOKEN: private }'),
  ]) assert.throws(() => nativeWorkflow('actions', source), /Unsupported/);
  for (const source of [
    gitlab.replace('after_script:', 'image: node:latest\n  after_script:'),
    gitlab.replace('script:', 'rules: [{ when: always }]\n  script:'),
    gitlab.replace('test "$VALUE" = ready', 'test ${{ secrets.TOKEN }}'),
    gitlab + 'second:\n  script: echo unadmitted\n',
  ]) assert.throws(() => nativeWorkflow('gitlab', source), /Unsupported/);
  assert.equal(nativeWorkflowPath('actions', '.github/workflows/../evil.yml'), false);
  assert.equal(nativeWorkflowPath('gitlab', '.gitlab-ci.yaml'), false);
  assert.equal(nativeWorkflowPlanOK({ ...nativeWorkflow('actions', actions), hidden: true }), false);
});

test('workflow source is read from an exact regular Git blob with bounded bytes', async () => {
  const tree = 'a'.repeat(40), folder = 'b'.repeat(40), workflows = 'd'.repeat(40), blobId = 'c'.repeat(40);
  const repo = {
    readTree: async hash => hash === tree ? [{ name: '.github', type: 'tree', hash: folder }] :
      hash === folder ? [{ name: 'workflows', type: 'tree', hash: workflows }] :
      hash === workflows ? [{ name: 'check.yml', type: 'blob', hash: blobId }] : [],
    readBlob: async hash => hash === blobId ? new Blob([actions]) : null,
  };
  const result = await nativeWorkflowSource(repo, tree, 'actions', '.github/workflows/check.yml');
  assert.equal(result.blobId, blobId);
  assert.equal(result.plan.jobId, 'check');
  await assert.rejects(nativeWorkflowSource(repo, tree, 'actions', '.github/workflows/missing.yml'), /missing/);
});

test('native Actions and GitLab host fixtures are admitted with exact shell plans', async () => {
  const base = new URL('../../docs/compatibility/fixtures/', import.meta.url);
  const action = nativeWorkflow('actions', await readFile(new URL('native-actions-shell.yml', base), 'utf8'));
  const lab = nativeWorkflow('gitlab', await readFile(new URL('native-gitlab-shell.yml', base), 'utf8'));
  assert.equal(action.jobId, 'verify');
  assert.equal(action.steps[0].run, 'test -f README.md && cat README.md');
  assert.equal(lab.jobId, 'verify');
  assert.equal(lab.steps[0].run, 'test -f README.md && echo main && exit 7');
  assert.equal(lab.afterScript, 'echo after-script');
  const portable = nativeWorkflow('gitlab', await readFile(new URL('gitlab-shell.yml', base), 'utf8'));
  assert.match(portable.image, /^alpine:3\.23@sha256:/);
  assert.equal(portable.steps[0].run.includes('printf "gitlab proof\\n"'), true);
  assert.equal(nativeWorkflowPlanOK(portable), true);
});
