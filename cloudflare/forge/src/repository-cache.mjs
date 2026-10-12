import { sha } from './git.mjs';

// Only immutable Git objects are cached; callers still verify identity and current grants.
export function cachedRepository(repo, cache, scope, clock) {
  if (cache) cache.blobSizes ||= new Map();
  const wrapped = new Proxy(repo, { get(target, method) {
    if (method === 'readBlobSize') return async hash => {
      if (!sha(hash)) throw Error('Use an immutable blob identity');
      const key = JSON.stringify([scope, hash]);
      if (cache?.blobSizes.has(key)) {
        clock?.count('object_hit');
        const size = cache.blobSizes.get(key); cache.blobSizes.delete(key); cache.blobSizes.set(key, size); return size;
      }
      const blob = await wrapped.readBlob(hash);
      if (!blob || !Number.isSafeInteger(blob.size) || blob.size < 0) throw Error('Invalid blob');
      return blob.size;
    };
    if (!cache) { const value = target[method]; return typeof value === 'function' ? (...args) => target[method](...args) : value; }
    if (!['readCommit', 'readTree', 'readBlob', 'log'].includes(method)) {
      const value = target[method]; return typeof value === 'function' ? (...args) => target[method](...args) : value;
    }
    return async hash => {
      const immutableLog = method === 'log' && hash && sha(hash.ref) && Object.keys(hash).every(key => ['ref', 'limit', 'offset'].includes(key)) && Number.isInteger(hash.limit ?? 50) && (hash.limit ?? 50) >= 1 && (hash.limit ?? 50) <= 1000 && Number.isSafeInteger(hash.offset ?? 0) && (hash.offset ?? 0) >= 0;
      if (method === 'log' ? !immutableLog : !sha(hash)) return target[method](hash);
      const key = JSON.stringify([scope, method, method === 'log' ? [hash.ref, hash.limit ?? 50, hash.offset ?? 0] : hash]);
      let entry = cache.objects.get(key);
      if (entry) { clock?.count('object_hit'); cache.objects.delete(key); cache.objects.set(key, entry); }
      else {
        let pending = cache.pending.get(key);
        clock?.count(pending ? 'object_shared' : 'object_miss');
        if (!pending) {
          pending = (async () => {
            const value = await target[method](hash);
            if (!value) return null;
            if (method === 'readBlob' && Number.isSafeInteger(value.size) && value.size >= 0) {
              const sizeKey = JSON.stringify([scope, hash]); cache.blobSizes.delete(sizeKey);
              if (cache.blobSizes.size >= 4096) cache.blobSizes.delete(cache.blobSizes.keys().next().value);
              cache.blobSizes.set(sizeKey, value.size);
            }
            const saved = method === 'readBlob' ? value : JSON.stringify(value);
            const size = method === 'readBlob' ? value.size : saved.length * 2;
            const result = { value: saved, size };
            if (Number.isSafeInteger(size) && size >= 0 && size <= 1024 * 1024) {
              while (cache.objects.size && (cache.objects.size >= 128 || cache.bytes + size > 4 * 1024 * 1024)) {
                const first = cache.objects.keys().next().value; cache.bytes -= cache.objects.get(first).size; cache.objects.delete(first);
              }
              cache.objects.set(key, result); cache.bytes += size;
            }
            return result;
          })();
          cache.pending.set(key, pending);
        }
        try { entry = await pending; } finally { if (cache.pending.get(key) === pending) cache.pending.delete(key); }
      }
      return entry ? method === 'readBlob' ? entry.value : JSON.parse(entry.value) : null;
    };
  } });
  return wrapped;
}
