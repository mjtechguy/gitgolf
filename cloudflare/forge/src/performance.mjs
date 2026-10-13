const stages = ['access', 'queue', 'actor', 'grant', 'd1', 'artifacts', 'artifact_open', 'artifact_info', 'artifact_log', 'authority', 'authority_queue', 'authority_d1', 'authority_actor', 'authority_grant', 'native'];
const counters = ['object_hit', 'object_miss', 'object_shared', 'index_hit', 'index_miss', 'artifacts_errors'];

export function performanceSample(request, response, duration) {
  const path = new URL(request.url).pathname;
  const native = {'/native/pr-evidence':'NativeEvidence','/native/pr-preview':'NativePreview'}[path];
  const match = /^\/rpc\/golf\.v1\.[A-Za-z]+Service\/([A-Za-z]{1,80})$/.exec(path);
  if (!match && !native || match?.[1] === 'WatchRepository') return null;
  const timing = {};
  for (const part of (response.headers.get('Server-Timing') || '').split(',')) {
    const value = /^\s*([a-z0-9_]+);dur=([\d.]+)(?:;desc="(\d+) calls")?\s*$/.exec(part);
    if (!value) continue;
    if (stages.includes(value[1])) timing[value[1]] = Number(value[2]);
    if (counters.includes(value[1])) timing[value[1]] = Number(value[3] || 0);
  }
  return { method: native || match[1], status: response.status, duration, timing };
}

// shortcut: retain the latest 2048 RPCs per workspace, use sampled analytics for fleet percentiles.
export class PerformanceHistory {
  constructor(sql) {
    this.sql = sql;
    sql.exec('CREATE TABLE IF NOT EXISTS performance_samples (id INTEGER PRIMARY KEY, observed INTEGER NOT NULL, payload TEXT NOT NULL)');
  }
  record(sample, now = Date.now()) {
    if (!sample || !/^[A-Za-z]{1,80}$/.test(sample.method) || !Number.isInteger(sample.status) || sample.status < 100 || sample.status > 599 || !Number.isFinite(sample.duration) || sample.duration < 0 || sample.duration > 3600000) throw Error('Invalid performance sample');
    const timing = {};
    for (const key of [...stages, ...counters]) if (Number.isFinite(sample.timing?.[key]) && sample.timing[key] >= 0 && sample.timing[key] <= 3600000) timing[key] = sample.timing[key];
    this.sql.exec('INSERT INTO performance_samples(observed,payload) VALUES(?,?)', now, JSON.stringify({ method: sample.method, status: sample.status, duration: sample.duration, timing }));
    this.sql.exec('DELETE FROM performance_samples WHERE observed<? OR id<=(SELECT MAX(id)-2048 FROM performance_samples)', now - 30 * 60000);
  }
  metrics(now = Date.now()) {
    const rows = [...this.sql.exec('SELECT observed,payload FROM performance_samples WHERE observed>=? ORDER BY id', now - 30 * 60000)];
    const samples = rows.map(row => JSON.parse(row.payload));
    const metrics = [], observedAt = rows.length ? new Date(rows.at(-1).observed).toISOString() : '';
    const metric = (id, label, value, unit = 'ms') => metrics.push({ id: 'performance.' + id, label, ...(value === undefined ? {} : { value }), unit, state: value === undefined ? 'unknown' : 'available', observedAt, source: 'Retained workspace RPC observations', window: 'Latest 2048 RPCs within 30 minutes; streams excluded' });
    metric('samples', 'Observed RPC requests', samples.length, 'count');
    metric('errors', 'Observed RPC server errors', samples.length ? samples.filter(row => row.status >= 500).length : undefined, 'count');
    const summarize = (id, label, values) => {
      values.sort((a, b) => a - b);
      metric(id + '.mean', label + ' · mean', values.length ? values.reduce((a, b) => a + b, 0) / values.length : undefined);
      metric(id + '.p50', label + ' · p50', values.length ? values[Math.ceil(values.length * .5) - 1] : undefined);
      metric(id + '.p95', label + ' · p95', values.length ? values[Math.ceil(values.length * .95) - 1] : undefined);
    };
    summarize('request', 'RPC response time', samples.map(row => row.duration));
    const sourceMethods = new Set(['ResolveRepositorySource','GetContents','GetRepositoryOverview','GetRepositoryFileIndex','ListCommits','GetCommitDiff','GetRepositoryComparison']);
    summarize('source', 'Source read response time', samples.filter(row => sourceMethods.has(row.method)).map(row => row.duration));
    summarize('evidence', 'Evidence API response time', samples.filter(row => row.method === 'NativeEvidence').map(row => row.duration));
    summarize('preview', 'Preview API response time', samples.filter(row => row.method === 'NativePreview').map(row => row.duration));
    summarize('metadata', 'Repository metadata response time', samples.filter(row => row.method === 'GetRepository').map(row => row.duration));
    for (const stage of stages) summarize(stage, stage.replaceAll('_', ' ') + ' time', samples.flatMap(row => row.timing[stage] === undefined ? [] : [row.timing[stage]]));
    for (const key of counters) metric(key, key.replaceAll('_', ' '), samples.length ? samples.reduce((sum, row) => sum + (row.timing[key] || 0), 0) : undefined, 'count');
    for (const kind of ['object', 'index']) {
      const hits = samples.reduce((sum, row) => sum + (row.timing[kind + '_hit'] || 0), 0), misses = samples.reduce((sum, row) => sum + (row.timing[kind + '_miss'] || 0), 0);
      metric(kind + '_hit_ratio', kind + ' cache hit ratio', hits + misses ? 100 * hits / (hits + misses) : undefined, '%');
    }
    return metrics;
  }
}
