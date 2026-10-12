// Build the import-free probe with the utilities already shipped in cf.
// No bundler installation or automatic setup. Optional fork mode uses native OAuth.
import { copyFile, mkdir, readFile } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(process.argv[2]);
const cliRoot = dirname(dirname(realpathSync(process.argv[3])));
const version = JSON.parse(await readFile(resolve(cliRoot, 'package.json'), 'utf8')).version;
if (version !== '1.0.0-beta.13') throw new Error('Qualify the installed cf version before using its beta build output');
const ownership = JSON.parse(await readFile(resolve(root, 'ownership.json'), 'utf8'));
if (process.argv[4] === 'fork') {
  // beta.13's generated command/SDK consumes name as a path parameter.
  // Native additionalBodyParameters keeps the destination name in the body.
  const destination = process.argv[5] || 'proposal';
  if (!['proposal', 'agent-a', 'agent-b', 'cancel', 'timeout', 'integration'].includes(destination)) throw new Error('invalid owned fork destination');
  const oauth = await import(pathToFileURL(resolve(cliRoot, 'dist/oauth-Bj5Ne1o8.mjs')).href);
  const auth = await import(pathToFileURL(resolve(cliRoot, 'dist/auth-CGLsxbc6.mjs')).href);
  oauth.p(ownership.profile);
  const client = await auth.n({});
  const result = await client.artifacts.namespaces.repos.fork(
    { account_id: ownership.account, namespace: ownership.resources.namespace, name: 'baseline', default_branch_only: false, read_only: false },
    { additionalBodyParameters: { name: destination }, timeoutInSeconds: 30, maxRetries: 0 });
  // Captured only by the runner; includes a secret and must never be logged.
  process.stdout.write(JSON.stringify(result));
  process.exit(0);
}
const utils = await import(pathToFileURL(resolve(cliRoot, 'node_modules/@cloudflare/build-output-utils/dist/index.mjs')).href);
const { account, resources, object_key, public_probe = false } = ownership;
const config = {
  name: resources.worker, compatibilityDate: '2026-10-07', workersDev: public_probe, previewUrls: false,
  limits: { cpuMs: 10 }, observability: { enabled: false },
  env: {
    EVIDENCE: { type: 'r2', name: resources.bucket },
    ARTIFACTS: { type: 'artifacts', namespace: resources.namespace },
    GOLF_PROBE_OBJECT_KEY: { type: 'text', value: object_key },
    GOLF_PROBE_TOKEN: { type: 'secret' },
  },
};
await utils.writeRootConfig(root, { accountId: account }, { isPreview: false });
const bundle = utils.getWorkerBundleDir(root);
await mkdir(bundle, { recursive: true });
await copyFile(fileURLToPath(new URL('./src/worker.mjs', import.meta.url)), resolve(bundle, 'worker.mjs'));
await utils.writeWorkerConfig({ root, config, manifest: { type: 'partial', mainModule: 'worker.mjs', modules: {} } });
await utils.readBuildOutput(root);
console.log('Native cf build output validated');
