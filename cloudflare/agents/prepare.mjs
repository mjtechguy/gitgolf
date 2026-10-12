// Native cf build output; esbuild bundles the sole runtime dependency, Sandbox.
import { readFile, mkdir, rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { realpathSync } from 'node:fs';
import { pathToFileURL, fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';
const [rootArg, cfArg, mode = 'build'] = process.argv.slice(2);
const root = resolve(rootArg), cli = dirname(dirname(realpathSync(cfArg)));
if (JSON.parse(await readFile(resolve(cli, 'package.json'))).version !== '1.0.0-beta.13') throw new Error('qualify native CLI version');
const u = await import(pathToFileURL(resolve(cli, 'node_modules/@cloudflare/build-output-utils/dist/index.mjs')).href);
const s = JSON.parse(await readFile(resolve(root, 'ownership.json')));
const bundle = u.getWorkerBundleDir(root);
await mkdir(bundle, { recursive: true });
await u.writeRootConfig(root, { accountId: s.account }, { isPreview: false });
await rm(u.getContainersDir(root), { recursive: true, force: true });
if (mode === 'retire') {
  // Delete only this Worker's class, after destroying all owned containers.
  await esbuild.build({ stdin: { contents: "export default { fetch(){return new Response('retired',{status:410})} }", resolveDir: root },
    outfile: resolve(bundle, 'worker.mjs'), bundle: true, format: 'esm' });
  await u.writeWorkerConfig({ root, config: { name: s.resources.worker, compatibilityDate: '2026-10-07',
    workersDev: false, previewUrls: false, exports: { AgentTask: { type: 'durable-object', state: 'deleted' } } },
    manifest: { type: 'partial', mainModule: 'worker.mjs', modules: {} } });
} else {
  await esbuild.build({ entryPoints: [fileURLToPath(new URL('./src/worker.mjs', import.meta.url))],
    outfile: resolve(bundle, 'worker.mjs'), bundle: true, format: 'esm', platform: 'neutral',
    external: ['cloudflare:workers', 'node:*'], conditions: ['workerd', 'worker', 'browser'] });
  const env = {
    EVIDENCE: { type: 'r2', name: s.resources.bucket }, AI: { type: 'ai' },
    GOLF_PROBE_TOKEN: { type: 'secret' },
  };
  for (const [name, value] of Object.entries(s.vars)) env[name] = { type: 'text', value };
  for (const name of s.secret_names) env[name] = { type: 'secret' };
  await u.writeContainerConfig({ root, directoryName: 'agent', config: { name: s.resources.worker,
    schedulingPolicy: 'durable-object', observability: { enabled: false }, images: { agent: { localReference: s.image } } } });
  await u.writeWorkerConfig({ root, config: { name: s.resources.worker, compatibilityDate: '2026-10-07',
    compatibilityFlags: ['nodejs_compat'], workersDev: true, previewUrls: false, limits: { cpuMs: 100 },
    observability: { enabled: false }, env,
    exports: { AgentTask: { type: 'durable-object', storage: 'sqlite', container: s.resources.worker }, Outbound: { type: 'worker' } } },
    manifest: { type: 'partial', mainModule: 'worker.mjs', modules: {} } });
}
await u.readBuildOutput(root);
console.log('Native agent build output validated');
