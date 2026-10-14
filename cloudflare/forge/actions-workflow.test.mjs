import test from 'node:test';
import assert from 'node:assert/strict';
import { parseWorkflow, matchTrigger, expandWorkflow, expandMatrix, dispatchInputs, filterMatches, WorkflowRefused } from './src/actions-workflow.mjs';
import { evaluate, interpolate } from './src/actions-expressions.mjs';
import { parse } from '../agents/node_modules/yaml/browser/index.js';

const github = { event_name: 'push', ref: 'refs/heads/main', ref_name: 'main', repository: 'alice/project', workflow: 'CI', sha: 'c'.repeat(40) };

test('expressions: literals, contexts, operators and functions in the server subset', () => {
  const context = { matrix: { os: null, python: '3.13', name: '' }, github };
  assert.equal(evaluate("matrix.os || 'ubuntu-latest'", context), 'ubuntu-latest');
  assert.equal(evaluate("matrix.name || matrix.python", context), '3.13');
  assert.equal(evaluate("format('py{0}', matrix.python)", context), 'py3.13');
  assert.equal(evaluate("github.ref == 'REFS/HEADS/MAIN' && !contains(github.ref, 'tags')", context), true);
  assert.equal(interpolate('${{ github.workflow }}-${{ github.ref }}', context), 'CI-refs/heads/main');
  assert.equal(interpolate('${{ 26 }}', context), 26);
  assert.throws(() => evaluate('needs.build.outputs.x', context), /not available/);
  assert.throws(() => evaluate("hashFiles('x')", context), /evaluated by the runner/);
});

test('matrix include/exclude follow GitHub semantics', () => {
  assert.deepEqual(expandMatrix({ os: ['a', 'b'], v: [1, 2], exclude: [{ os: 'b', v: 2 }], include: [{ os: 'a', extra: 'x' }, { os: 'c', v: 3 }] }, {}),
    [{ os: 'a', v: 1, extra: 'x' }, { os: 'a', v: 2, extra: 'x' }, { os: 'b', v: 1 }, { os: 'c', v: 3 }]);
  assert.throws(() => expandMatrix('${{ fromJSON(needs.a.outputs.m) }}', {}), WorkflowRefused);
});

test('trigger filters: branches, tags, paths and pull_request types', () => {
  const root = parseWorkflow(`on:\n  push:\n    branches: [main, 'releases/**', '!releases/old']\n    paths-ignore: ['docs/**']\n  pull_request:\n    types: [opened]\njobs:\n  a: {runs-on: x, steps: [{run: echo}]}\n`);
  const push = (ref, changedFiles = null) => matchTrigger(root, { event: 'push', ref, changedFiles }).match;
  assert.equal(push('refs/heads/main'), true); assert.equal(push('refs/heads/releases/1/x'), true); assert.equal(push('refs/heads/releases/old'), false);
  assert.equal(push('refs/heads/feature'), false); assert.equal(push('refs/tags/v1'), false);
  assert.equal(push('refs/heads/main', ['docs/a.md']), false); assert.equal(push('refs/heads/main', ['docs/a.md', 'src/x']), true);
  assert.equal(matchTrigger(root, { event: 'pull_request', action: 'synchronize', baseRef: 'main' }).match, false);
  assert.equal(filterMatches(['*.js', '!x.js'], 'x.js'), false);
  assert.throws(() => matchTrigger(parseWorkflow('on:\n  push:\n    branch: [x]\njobs: {a: {runs-on: x, steps: [{run: a}]}}'), { event: 'push', ref: 'refs/heads/x' }), /Unsupported push filter/);
  const tags = parseWorkflow('on:\n  push:\n    tags: [\'v*\']\njobs: {a: {runs-on: x, steps: [{run: a}]}}');
  assert.equal(matchTrigger(tags, { event: 'push', ref: 'refs/tags/v1.0' }).match, true);
  assert.equal(matchTrigger(tags, { event: 'push', ref: 'refs/heads/main' }).match, false);
});

test('dispatch inputs are typed and defaulted', () => {
  const root = parseWorkflow('on:\n  workflow_dispatch:\n    inputs:\n      level: {type: choice, options: [a, b], default: a}\n      dry: {type: boolean}\n      name: {required: true}\njobs: {a: {runs-on: x, steps: [{run: a}]}}');
  assert.deepEqual(dispatchInputs(root, { name: 'n' }), { level: 'a', dry: 'false', name: 'n' });
  assert.throws(() => dispatchInputs(root, {}), /required/);
  assert.throws(() => dispatchInputs(root, { name: 'n', level: 'c' }), /options/);
  assert.throws(() => dispatchInputs(root, { name: 'n', other: '1' }), /Unexpected/);
});

test('real upstream workflows expand like GitHub: chalk, node-postgres anchors and itsdangerous runs-on expressions', () => {
  const chalk = parseWorkflow(`name: CI
on:
  - push
  - pull_request
jobs:
  test:
    name: Node.js \${{ matrix.node-version }}
    runs-on: ubuntu-latest
    strategy:
      fail-fast: false
      matrix:
        node-version:
          - 26
          - 22
    steps:
      - uses: actions/checkout@v7
`);
  assert.equal(matchTrigger(chalk, { event: 'push', ref: 'refs/heads/main' }).match, true);
  const c = expandWorkflow(chalk, '.github/workflows/main.yml', { github });
  assert.deepEqual(c.jobs.map(job => job.name), ['Node.js 26', 'Node.js 22']);
  assert.deepEqual(parse(c.jobs[0].payload).jobs.test.strategy.matrix, { 'node-version': [26] });
  const pg = parseWorkflow(`on: [push, pull_request]
jobs:
  lint:
    runs-on: ubuntu-latest
    steps: [{run: lint}]
  build:
    needs: lint
    timeout-minutes: 15
    strategy:
      matrix:
        include:
          - { node: '16', postgres: &stable_postgres '18' }
          - { node: '18', postgres: *stable_postgres }
          - { node: &latest_node '26', postgres: '13' }
          - { node: *latest_node, postgres: '14' }
    name: Node.js \${{ matrix.node }} x PostgreSQL \${{ matrix.postgres }}
    runs-on: ubuntu-latest
    services:
      postgres:
        image: ghcr.io/railwayapp-templates/postgres-ssl:\${{ matrix.postgres }}
    steps: [{run: test}]
`);
  const p = expandWorkflow(pg, '.github/workflows/ci.yml', { github });
  assert.deepEqual(p.jobs.map(job => job.name), ['lint', 'Node.js 16 x PostgreSQL 18', 'Node.js 18 x PostgreSQL 18', 'Node.js 26 x PostgreSQL 13', 'Node.js 26 x PostgreSQL 14']);
  assert.deepEqual(p.jobs[1].needs, ['lint']); assert.equal(p.jobs[1].timeoutSeconds, 900);
  const its = parseWorkflow(`on:
  push:
    branches: [main, stable]
    paths-ignore: ['docs/**', 'README.md']
jobs:
  tests:
    name: \${{ matrix.name || matrix.python }}
    runs-on: \${{ matrix.os || 'ubuntu-latest' }}
    strategy:
      matrix:
        include:
          - {python: '3.13'}
          - {name: Windows, python: '3.13', os: windows-latest}
          - {name: PyPy, python: 'pypy-3.11', tox: pypy311}
    steps:
      - run: uv run --locked tox run -e \${{ matrix.tox || format('py{0}', matrix.python) }}
`);
  const i = expandWorkflow(its, '.github/workflows/tests.yaml', { github });
  assert.deepEqual(i.jobs.map(job => [job.name, job.runsOn[0]]), [['3.13', 'ubuntu-latest'], ['Windows', 'windows-latest'], ['PyPy', 'ubuntu-latest']]);
  assert.equal(matchTrigger(its, { event: 'push', ref: 'refs/heads/main', changedFiles: ['README.md'] }).match, false);
  assert.throws(() => expandWorkflow(parseWorkflow('on: push\njobs:\n  a:\n    uses: o/r/.github/workflows/x.yml@v1'), 'x', { github }), /reusable/);
});
