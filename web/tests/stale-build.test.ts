import test from 'node:test';
import assert from 'node:assert/strict';
import { reloadOnceForBuild } from '../src/staleBuild.ts';

const memory = () => { const values = new Map<string, string>(); return { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } }; };

test('a stale tab reloads once per build and never loops on the same build', () => {
  const storage = memory(); let reloads = 0;
  assert.equal(reloadOnceForBuild(storage, '/assets/index-a.js', () => reloads++), true);
  assert.equal(reloadOnceForBuild(storage, '/assets/index-a.js', () => reloads++), false);
  assert.equal(reloads, 1);
  assert.equal(reloadOnceForBuild(storage, '/assets/index-b.js', () => reloads++), true);
  assert.equal(reloads, 2);
});

test('unknown builds and unavailable storage never reload', () => {
  let reloads = 0;
  assert.equal(reloadOnceForBuild({ getItem: () => null, setItem: () => {} }, '', () => reloads++), false);
  assert.equal(reloadOnceForBuild({ getItem: () => { throw Error('denied'); }, setItem: () => {} }, '/assets/index-a.js', () => reloads++), false);
  assert.equal(reloads, 0);
});
