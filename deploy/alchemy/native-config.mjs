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
      case 'ai': return { name, type: 'ai' };
      // The semantic search index by name; Alchemy creates it (and its repository metadata index) before the Worker binds it.
      case 'vectorize':
        if (Object.keys(value).some(key => !['type', 'name'].includes(key)) || typeof value.name !== 'string' || !/^[a-z0-9][a-z0-9-]{1,62}$/.test(value.name)) throw Error('Unqualified Alchemy Vectorize binding');
        return { name, type: 'vectorize', indexName: value.name };
      case 'analytics-engine-dataset': return { name, type: 'analytics_engine', dataset: value.name };
      case 'rate-limit': return { name, type: 'ratelimit', namespaceId: value.namespace, simple: value.simple };
      case 'secrets-store-secret': return { name, type: 'secrets_store_secret', storeId: value.storeId, secretName: value.secretName };
      case 'worker': return { name, type: 'service', service: value.worker, entrypoint: value.exportName };
      // Sender-restricted only: a destination restriction would name mailboxes at deploy time, and recipients are each account's own address.
      case 'send-email':
        if (Object.keys(value).some(key => !['type', 'allowedSenderAddresses'].includes(key)) || !Array.isArray(value.allowedSenderAddresses) || value.allowedSenderAddresses.length !== 1 || typeof value.allowedSenderAddresses[0] !== 'string')
          throw Error('Unqualified Alchemy email binding');
        return { name, type: 'send_email', allowedSenderAddresses: value.allowedSenderAddresses };
      case 'dispatch-namespace': return { name, type: 'dispatch_namespace', namespace: value.namespace,
        outbound: { worker: { service: value.outbound.worker } } };
      default: throw Error('Unqualified Alchemy binding: ' + value.type);
    }
  });
}
