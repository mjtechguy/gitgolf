// Native CLI build output; configuration contains resource identities, never credentials.
import { copyFile, mkdir, readFile, lstat } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { validOrigin } from './src/worker.mjs';

if (process.argv.length !== 5) throw Error('Usage: node prepare.mjs INSTALL_DIRECTORY CF_EXECUTABLE WEB_DIST');
const root = resolve(process.argv[2]);
const cliRoot = dirname(dirname(realpathSync(process.argv[3])));
if (JSON.parse(await readFile(resolve(cliRoot, 'package.json'), 'utf8')).version !== '1.0.0-beta.13') {
  throw Error('Qualify the installed native cf build format');
}
const settings = JSON.parse(await readFile(resolve(root, 'control.json'), 'utf8'));
if (!/^[a-f0-9]{32}$/.test(settings.account) || !/^[a-z][a-z0-9-]{2,62}$/.test(settings.worker) ||
    !validOrigin(settings.public_origin) || !validOrigin(settings.bridge_origin) ||
    settings.public_origin === settings.bridge_origin) throw Error('Invalid control installation identities');
const assets = resolve(process.argv[4]);
if (!(await lstat(resolve(assets, 'index.html'))).isFile()) throw Error('Build the production frontend first');
const utils = await import(pathToFileURL(resolve(cliRoot, 'node_modules/@cloudflare/build-output-utils/dist/index.mjs')).href);
await utils.writeRootConfig(root, { accountId: settings.account }, { isPreview: false });
const bundle = utils.getWorkerBundleDir(root);
await mkdir(bundle, { recursive: true });
await copyFile(fileURLToPath(new URL('./src/worker.mjs', import.meta.url)), resolve(bundle, 'worker.mjs'));
await utils.writeAssets({ root, sourceDirectory: assets });
await utils.writeWorkerConfig({ root, config: {
  name: settings.worker, compatibilityDate: '2026-10-08',
  workersDev: false, previewUrls: false, domains: [new URL(settings.public_origin).hostname],
  assets: { runWorkerFirst: true, htmlHandling: 'none', notFoundHandling: 'none' },
  limits: { cpuMs: 50 }, observability: { enabled: false },
  env: {
    ASSETS: { type: 'assets' },
    GOLF_PUBLIC_ORIGIN: { type: 'text', value: settings.public_origin },
    GOLF_BRIDGE_ORIGIN: { type: 'text', value: settings.bridge_origin },
    GOLF_ACCESS_CLIENT_ID: { type: 'secret' },
    GOLF_ACCESS_CLIENT_SECRET: { type: 'secret' },
  },
}, manifest: { type: 'partial', mainModule: 'worker.mjs', modules: {} } });
await utils.readBuildOutput(root);
console.log('Cloudflare control Worker and production assets prepared; nothing deployed');
