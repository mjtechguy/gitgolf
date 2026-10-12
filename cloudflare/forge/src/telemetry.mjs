export const release = typeof GOLF_NATIVE_RELEASE === 'undefined' ? 'development' : GOLF_NATIVE_RELEASE;

export function timings() {
  const stages = new Map();
  const count = name => { const old = stages.get(name) || { duration: 0, count: 0 }; stages.set(name, { ...old, count: old.count + 1 }); };
  return {
    count,
    record(name, duration) {
      if (!/^[a-z][a-z0-9_]*$/.test(name) || !Number.isFinite(duration) || duration < 0 || duration > 3600000) return;
      const old = stages.get(name) || { duration: 0, count: 0 };
      stages.set(name, { duration: old.duration + duration, count: old.count + 1 });
    },
    async measure(name, action) {
      const start = performance.now();
      try { return await action(); } catch (error) { count(name + '_errors'); throw error; } finally {
        const old = stages.get(name) || { duration: 0, count: 0 };
        stages.set(name, { duration: old.duration + performance.now() - start, count: old.count + 1 });
      }
    },
    header() { return [...stages].map(([name, value]) => `${name};dur=${value.duration.toFixed(1)};desc="${value.count} calls"`).join(', '); },
  };
}

export function timedDatabase(database, clock) {
  const originals = new WeakMap();
  const statement = value => { const wrapped = new Proxy(value, { get(target, key) {
    if (key === 'bind') return (...args) => statement(target.bind(...args));
    if (['first', 'all', 'run', 'raw'].includes(key)) return (...args) => clock.measure('d1', () => target[key](...args));
    const result = target[key]; return typeof result === 'function' ? result.bind(target) : result;
  } }); originals.set(wrapped, value); return wrapped; };
  return new Proxy(database, { get(target, key) {
    if (key === 'withSession') return (...args) => timedDatabase(target.withSession(...args), clock);
    if (key === 'prepare') return (...args) => statement(target.prepare(...args));
    if (key === 'batch') return values => clock.measure('d1', () => target.batch(values.map(value => originals.get(value) || value)));
    const result = target[key]; return typeof result === 'function' ? result.bind(target) : result;
  } });
}

export function timedResponse(response, clock, name, duration) {
  const headers = new Headers(response.headers);
  const existing = headers.get('Server-Timing');
  headers.set('Server-Timing', [existing, clock?.header(), `${name};dur=${duration.toFixed(1)}`].filter(Boolean).join(', '));
  headers.set('X-Golf-Release', release);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}
