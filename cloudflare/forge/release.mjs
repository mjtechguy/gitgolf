import { nativeBuildIdentity } from './build-identity.mjs';
import { webhookBindings } from './src/webhooks.mjs';
import { executionValueBindings } from './src/execution-values.mjs';
import { emailBindings } from './src/email.mjs';
import { accessBindings } from './src/access.mjs';
import { readFile, mkdir, writeFile, rename } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import * as esbuild from '../agents/node_modules/esbuild/lib/main.js';
import { readUIAssets } from './ui-assets.mjs';
import { immutableAsset } from './src/public.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
export function embeddedAssets(bundle) {
  const match = /^var define_GOLF_NATIVE_ASSETS_default = (.*);$/m.exec(bundle);
  if (!match) throw Error('Previous release has no embedded asset manifest');
  const assets = JSON.parse(match[1].replace(/\b(type|content): /g, '"$1": '));
  if (!assets || !assets['/native.html'] || Object.keys(assets).length > 192) throw Error('Invalid embedded asset inventory');
  let bytes = 0;
  for (const [path, entry] of Object.entries(assets)) {
    if (!['/native.html', '/golf.svg', '/golf-classic-dark.svg', '/golf-classic.svg', '/golf-flare.svg', '/theme.js'].includes(path) && !immutableAsset(path) || !entry || typeof entry.type !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(entry.content)) throw Error('Invalid embedded asset');
    bytes += Buffer.from(entry.content, 'base64').length;
  }
  if (bytes > 4 * 1024 * 1024) throw Error('Previous asset inventory exceeds its bound');
  return assets;
}

export async function buildRelease(directory, executable) {
  const root = resolve(directory), settings = JSON.parse(await readFile(resolve(root, 'forge.json'), 'utf8'));
  const cli = dirname(dirname(realpathSync(executable)));
  const u = await import(pathToFileURL(resolve(cli, 'node_modules/@cloudflare/build-output-utils/dist/index.mjs')).href);
  const output = await u.readBuildOutput(root), config = output.workers.default.config;
  if (config.name !== settings.worker || config.env.DB.id !== settings.database.uuid || config.env.ARTIFACTS.namespace !== settings.namespace || config.env.PUBLIC_ORIGIN.value !== settings.origin || config.env.WORKSPACE_SLUG.value !== settings.workspace || config.env.ACCOUNT_ID.value !== settings.account) throw Error('Release resource identity differs from prepared output');
  const target = resolve(u.getWorkerBundleDir(root), 'worker.mjs'), previous = await readFile(target);
  const oldAssets = embeddedAssets(previous.toString()), assets = await readUIAssets(settings.web_assets);
  const { release, configuration } = await nativeBuildIdentity(settings, assets), archive = resolve(root, 'releases');
  let base = hash(previous);
  try {
    const prior = JSON.parse(await readFile(resolve(root, 'release-manifest.json'), 'utf8'));
    const journal = JSON.parse(await readFile(resolve(root, 'release-journal.json'), 'utf8'));
    if (journal.releases[prior.release]?.state !== 'deployed') base = prior.previousBundleSha256;
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  await mkdir(archive, { recursive: true, mode: 0o700 });
  await writeFile(resolve(archive, hash(previous) + '.worker.mjs'), previous, { mode: 0o600 });
  const retained = {};
  for (const inventory of [oldAssets, assets]) for (const [path, entry] of Object.entries(inventory)) {
    if (!immutableAsset(path)) continue;
    const bytes = Buffer.from(entry.content, 'base64'), sha256 = hash(bytes);
    if (retained[path] && retained[path].sha256 !== sha256) throw Error('Immutable asset path collision');
    await writeFile(resolve(archive, sha256 + '.asset'), bytes, { mode: 0o600 });
    retained[path] = { key: 'ui-assets' + path, sha256, bytes: bytes.length, type: entry.type };
  }
  delete config.env.WEBHOOK_POLICY; delete config.env.WEBHOOK_KEY;
  Object.assign(config.env, webhookBindings(settings));
  delete config.env.EXECUTION_VALUE_KEY;
  Object.assign(config.env, executionValueBindings(settings));
  delete config.env.EMAIL_POLICY; delete config.env.EMAIL;
  Object.assign(config.env, emailBindings(settings));
  delete config.env.ACCESS_TEAM_DOMAIN;
  Object.assign(config.env, accessBindings(settings));
  if (settings.webhooks && !config.triggers?.some(trigger => trigger.type === 'scheduled')) config.triggers = [...(config.triggers || []), { type: 'scheduled', schedule: '* * * * *' }];
  if (settings.email && !config.triggers?.some(trigger => trigger.type === 'scheduled')) config.triggers = [...(config.triggers || []), { type: 'scheduled', schedule: '*/5 * * * *' }];
  config.exports.RepositoryReads = { type: 'durable-object', storage: 'sqlite' };
  config.env.READ_INDEXES = { type: 'text', value: 'true' };
  try {
    const ownership = JSON.parse(await readFile(resolve(root, 'ownership.json'), 'utf8'));
    const deadline = ownership.validation_window?.stop_at || ownership.demo?.stop_at;
    if (deadline) config.env.DEMO_STOP_AT = { type: 'text', value: deadline };
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  await esbuild.build({ entryPoints: ['cloudflare/forge/src/' + (settings.agent_path ? 'agent-entry.mjs' : settings.tests ? 'test-entry.mjs' : 'worker.mjs')], outfile: target + '.next', bundle: true, format: 'esm', platform: 'neutral',
    define: { GOLF_NATIVE_ASSETS: JSON.stringify(assets), GOLF_NATIVE_RELEASE: JSON.stringify(release), GOLF_NATIVE_CONFIGURATION: JSON.stringify(configuration), GOLF_NATIVE_BUILT_AT: String(Date.now()) }, nodePaths: ['cloudflare/agents/node_modules'],
    conditions: ['workerd', 'worker', 'browser'], external: ['cloudflare:workers', 'node:*'] });
  const manifest = { format: 1, release, contract: 1, schema: 52, account: settings.account, worker: settings.worker, database: settings.database.uuid,
    namespace: settings.namespace, workspace: settings.workspace, origin: settings.origin, bucket: settings.evidence.bucket,
    previousBundleSha256: base, bundleSha256: hash(await readFile(target + '.next')), assets: retained, createdAt: new Date().toISOString() };
  await writeFile(resolve(root, 'release-manifest.json.next'), JSON.stringify(manifest, null, 2) + '\n', { mode: 0o600 });
  await rename(target + '.next', target);
  await u.writeWorkerConfig({ root, config, manifest: { type: 'partial', mainModule: 'worker.mjs', modules: {} } });
  await u.readBuildOutput(root);
  await rename(resolve(root, 'release-manifest.json.next'), resolve(root, 'release-manifest.json'));
  return manifest;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [directory, executable] = process.argv.slice(2);
  if (!directory || !executable) throw Error('Use INSTALL_DIRECTORY CF_EXECUTABLE');
  const manifest = await buildRelease(directory, executable);
  console.log(JSON.stringify({ release: manifest.release, bundleSha256: manifest.bundleSha256, retainedAssets: Object.keys(manifest.assets).length }));
}
