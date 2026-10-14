import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/** @param {string} directory */
export const outputPath = directory => resolve(directory, '.cloudflare/output/v0/workers/default');
/** @param {string} directory */
export const readConfig = directory => JSON.parse(readFileSync(resolve(outputPath(directory), 'worker.config.json'), 'utf8'));

/** @param {Array<{id?: string, hostname?: string, service?: string, zoneId?: string}>} domains
 * @param {{hostname: string, service: string, zoneId: string}} expected */
export function ownedDomain(domains, expected) {
  const matches = domains.filter(d => d.hostname === expected.hostname);
  if (matches.length > 1 || matches.some(d => !d.id || d.service !== expected.service || d.zoneId !== expected.zoneId))
    throw Error('Preview domain ownership differs');
  return matches[0];
}

// Translate the shared build contract, refusing any binding we have not qualified.
/** @param {{env?: Record<string, any>}} config
 * @returns {import('alchemy/Cloudflare/Workers/WorkerBinding').WorkerBinding[]} */
export function bindings(config) {
  return Object.entries(config.env || {}).map(([name, value]) => {
    switch (value.type) {
      case 'text': return { name, type: 'plain_text', text: value.value };
      case 'd1': return { name, type: 'd1', id: value.id, databaseId: value.id };
      case 'artifacts': return { name, type: 'artifacts', namespace: value.namespace };
      case 'r2': return { name, type: 'r2_bucket', bucketName: value.name };
      case 'queue': return { name, type: 'queue', queueName: value.name };
      case 'browser': return { name, type: 'browser' };
      case 'analytics-engine-dataset': return { name, type: 'analytics_engine', dataset: value.name };
      case 'secrets-store-secret': return { name, type: 'secrets_store_secret', storeId: value.storeId, secretName: value.secretName };
      case 'worker': return { name, type: 'service', service: value.worker, entrypoint: value.exportName };
      case 'dispatch-namespace': return { name, type: 'dispatch_namespace', namespace: value.namespace,
        outbound: { worker: { service: value.outbound.worker } } };
      default: throw Error('Unqualified Alchemy binding: ' + value.type);
    }
  });
}
