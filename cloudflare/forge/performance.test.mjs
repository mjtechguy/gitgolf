import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { PerformanceHistory, performanceSample } from './src/performance.mjs';
import { timings } from './src/telemetry.mjs';

test('performance history survives restart, expires, remains bounded and contains no request identity', t => {
  const db = new DatabaseSync(':memory:'); t.after(() => db.close());
  const sql = { exec(query, ...args) { return query.startsWith('SELECT') ? db.prepare(query).all(...args) : db.prepare(query).run(...args); } };
  const history = new PerformanceHistory(sql), now = Date.now();
  const request = new Request('https://private.example/rpc/golf.v1.RepositoryService/GetRepository?secret=PRIVATE', { headers: { Authorization: 'Bearer PRIVATE' } });
  const response = new Response('{}', { headers: { 'Server-Timing': 'd1;dur=10;desc="2 calls", object_hit;dur=0;desc="3 calls", index_miss;dur=0;desc="1 calls", artifacts_errors;dur=0;desc="1 calls"' } });
  const sample = performanceSample(request, response, 100);
  assert.ok(!JSON.stringify(sample).includes('PRIVATE'));
  history.record(sample, now);
  const metrics = new PerformanceHistory(sql).metrics(now), value = id => metrics.find(row => row.id === 'performance.' + id)?.value;
  assert.equal(value('request.p95'), 100); assert.equal(value('d1.mean'), 10);
  assert.equal(value('object_hit'), 3); assert.equal(value('object_hit_ratio'), 100); assert.equal(value('index_hit_ratio'), 0);
  assert.equal(value('artifacts_errors'), 1);
  assert.equal(history.metrics(now + 31 * 60000).find(row => row.id === 'performance.request.p95').state, 'unknown');
  for (let i = 0; i < 2050; i++) history.record({ ...sample, duration: i }, now);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM performance_samples').get().n, 2048);
  assert.throws(() => history.record({ ...sample, duration: NaN }));
  assert.equal(performanceSample(new Request('https://private.example/rpc/golf.v1.RepositoryActivityService/WatchRepository'), response, 10), null);
});

test('timings preserve rejected provider calls and cache counts without private error content', async () => {
  const clock = timings();
  await assert.rejects(clock.measure('artifacts', async () => { throw Error('PRIVATE'); }));
  clock.count('index_hit');
  assert.match(clock.header(), /artifacts_errors;dur=0.0;desc="1 calls"/);
  assert.match(clock.header(), /index_hit;dur=0.0;desc="1 calls"/);
  assert.ok(!clock.header().includes('PRIVATE'));
});

test('final-authority queue and database timings reach Operations without accepting invalid durations', () => {
  const clock = timings();
  clock.record('authority_queue', 6000); clock.record('authority_d1', 12);
  clock.record('authority_d1', 8); clock.record('authority_grant', NaN);
  clock.record('authority_actor', -1); clock.record('private;token', 1);
  const sample = performanceSample(new Request('https://golf.test/rpc/golf.v1.RepositoryService/GetRepository'), new Response('{}', { headers: { 'Server-Timing': clock.header() } }), 6050);
  assert.deepEqual(sample.timing, { authority_queue: 6000, authority_d1: 20 });
  const db = new DatabaseSync(':memory:');
  try {
    const sql = { exec(query, ...args) { return query.startsWith('SELECT') ? db.prepare(query).all(...args) : db.prepare(query).run(...args); } };
    const history = new PerformanceHistory(sql); history.record(sample);
    const metrics = history.metrics();
    assert.equal(metrics.find(m => m.id === 'performance.authority_queue.p95').value, 6000);
    assert.equal(metrics.find(m => m.id === 'performance.authority_d1.mean').value, 20);
  } finally { db.close(); }
});


test('workspace timings include source percentiles and bounded native routes without request data', t => {
  const db=new DatabaseSync(':memory:');t.after(()=>db.close());
  const history=new PerformanceHistory({exec(query,...args){return query.startsWith('SELECT')?db.prepare(query).all(...args):db.prepare(query).run(...args);}});
  for(const duration of [10,20,30,100])history.record({method:'GetContents',status:200,duration,timing:{}});
  const sample=performanceSample(new Request('https://golf.test/native/pr-evidence?secret=PRIVATE',{method:'POST',body:'PRIVATE'}),new Response('{}'),50);
  assert.equal(sample.method,'NativeEvidence');assert.ok(!JSON.stringify(sample).includes('PRIVATE'));history.record(sample);
  assert.equal(performanceSample(new Request('https://golf.test/native/not-a-metric'),new Response('{}'),1),null);
  const metrics=history.metrics(), value=id=>metrics.find(m=>m.id==='performance.'+id)?.value;
  assert.equal(value('source.p50'),20);assert.equal(value('source.p95'),100);assert.equal(value('evidence.p50'),50);
  assert.equal(metrics.find(m=>m.id==='performance.preview.p50').state,'unknown');
});
