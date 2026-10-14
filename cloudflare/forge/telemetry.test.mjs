import test from 'node:test';
import assert from 'node:assert/strict';
import { newerEdge } from './src/telemetry.mjs';

test('a workspace retires only for a strictly newer edge build, and never when it was not built', () => {
  const from = value => new Request('https://golf.example/native/config', { headers: value === undefined ? {} : { 'X-Golf-Edge-Built-At': value } });
  assert.equal(newerEdge(from('2000'), 1000), true);
  assert.equal(newerEdge(from('1000'), 1000), false);
  assert.equal(newerEdge(from('500'), 1000), false);
  assert.equal(newerEdge(from(undefined), 1000), false);
  assert.equal(newerEdge(from('not a time'), 1000), false);
  assert.equal(newerEdge(from('2000'), 0), false);
});
