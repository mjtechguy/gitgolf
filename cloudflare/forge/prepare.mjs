import { webhookBindings } from './src/webhooks.mjs';
import { operationsPolicy } from './src/operations-provider.mjs';
import { readFile, mkdir, rm, lstat } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as esbuild from '../agents/node_modules/esbuild/lib/main.js';
import { readUIAssets } from './ui-assets.mjs';

const [directory, executable, mode = 'build'] = process.argv.slice(2);
if (!directory || !executable || !['build', 'retire'].includes(mode)) throw Error('Use INSTALL_DIRECTORY CF_EXECUTABLE [build|retire]');
const root = resolve(directory), cli = dirname(dirname(realpathSync(executable)));
if (JSON.parse(await readFile(resolve(cli, 'package.json'), 'utf8')).version !== '1.0.0-beta.13') throw Error('Qualify native CLI version');
const settings = JSON.parse(await readFile(resolve(root, 'forge.json'), 'utf8'));
if (!/^[a-f0-9]{32}$/.test(settings.account) || !/^[a-z0-9-]{3,63}$/.test(settings.worker) ||
    !/^[a-z0-9-]{3,63}$/.test(settings.namespace) || !/^[a-z0-9][a-z0-9_-]{0,62}$/.test(settings.workspace) ||
    !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(settings.database?.uuid) || new URL(settings.origin).origin !== settings.origin ||
    !settings.origin.startsWith('https://')) throw Error('Invalid native forge installation');
const u = await import(pathToFileURL(resolve(cli, 'node_modules/@cloudflare/build-output-utils/dist/index.mjs')).href);
await u.writeRootConfig(root, { accountId: settings.account }, { isPreview: false });
await rm(u.getContainersDir(root), { recursive: true, force: true });
await rm(u.getWorkerAssetsDir(root), { recursive: true, force: true });
const bundle = u.getWorkerBundleDir(root);
let uiAssets = null;
await mkdir(bundle, { recursive: true });
const operations = operationsPolicy(settings);
const config = { name: settings.worker, compatibilityDate: '2026-10-08', workersDev: settings.workers_dev === true,
  previewUrls: false, observability: mode === 'retire' ? { enabled: false } : operations.observability, limits: { cpuMs: 100 },
  exports: Object.fromEntries(['Workspace', 'RepositoryReads'].map(name => [name, mode === 'retire' ? { type: 'durable-object', state: 'deleted' } : { type: 'durable-object', storage: 'sqlite' }])) };
if (settings.tests && mode === 'retire') config.exports.PRTestTask = { type: 'durable-object', state: 'deleted' };
if (settings.agent_path && mode === 'retire') config.exports.PRAgentTask = { type: 'durable-object', state: 'deleted' };
if (mode === 'retire') {
  await esbuild.build({ stdin: { contents: "export default {fetch(){return new Response('retired',{status:410})}}" },
    outfile: resolve(bundle, 'worker.mjs'), bundle: true, format: 'esm' });
} else {
  config.env = {
    DB: { type: 'd1', id: settings.database.uuid, name: settings.database.name },
    ARTIFACTS: { type: 'artifacts', namespace: settings.namespace },
  };
  config.exports.PackagesAuthority = { type: 'worker' };
  if (settings.registry) {
    const registry = settings.registry, origin = new URL(registry.origin);
    if (!/^[a-z0-9][a-z0-9-]{2,62}$/.test(registry.worker) || registry.worker === settings.worker || origin.protocol !== 'https:' || origin.origin !== registry.origin || origin.origin === settings.origin) throw Error('Use a separate CFCR Worker and HTTPS registry origin');
    config.env.REGISTRY = { type: 'worker', worker: registry.worker, exportName: 'GolfRegistry' };
    config.env.REGISTRY_ORIGIN = { type: 'text', value: registry.origin };
    if (registry.ci !== undefined && typeof registry.ci !== 'boolean' || registry.ci && !settings.tests) throw Error('Registry CI publishing requires an explicit boolean and an approved test allocation');
    config.env.REGISTRY_CI_ENABLED = { type: 'text', value: String(registry.ci === true) };
  }
  config.env.OPERATIONS_SERVICE_HEALTH = { type: 'text', value: String(operations.serviceHealth === true) };
  config.env.OPERATIONS_WORKER = { type: 'text', value: settings.worker };
  config.env.OPERATIONS_OBSERVABILITY = { type: 'text', value: String(operations.observability.enabled) };
  if (operations.analyticsSecret) config.env.OPERATIONS_ANALYTICS_TOKEN = { type: 'secrets-store-secret', storeId: operations.analyticsSecret.store, secretName: operations.analyticsSecret.name };
  if (settings.evidence) config.env.READ_INDEXES = { type: 'text', value: 'true' };
  if (settings.evidence) {
    const e = settings.evidence;
    if (![e.bucket, e.queue, e.workflow].every(n => typeof n === 'string' && /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(n)) ||
      !Number.isInteger(e.daily_limit) || e.daily_limit < 1 || e.daily_limit > 20 || typeof e.allow_ai !== 'boolean' ||
      e.allow_ai && !(typeof e.gateway === 'string' && /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(e.gateway))) throw Error('Invalid evidence allocation');
    config.env.EVIDENCE_BUCKET = { type: 'r2', name: e.bucket };
    config.env.EVIDENCE_QUEUE = { type: 'queue', name: e.queue };
    config.exports.EvidenceWorkflow = { type: 'workflow', name: e.workflow, concurrency: { limit: settings.tests ? 2 : 1 }, limits: { steps: settings.agent_path ? 100 : settings.tests ? 85 : 3 },
      defaultRetention: { successRetention: '1 day', errorRetention: '1 day' } };
    config.triggers = [{ type: 'queue', name: e.queue, maxBatchSize: 1, maxBatchTimeout: 1, maxConcurrency: 1, maxRetries: 3 }];
    if (e.dead_letter) {
      if (!/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(e.dead_letter) || e.dead_letter === e.queue) throw Error('Use a separate approved dead-letter queue');
      config.triggers[0].deadLetterQueue = e.dead_letter;
      config.triggers.push({ type: 'queue', name: e.dead_letter, maxBatchSize: 10, maxBatchTimeout: 5, maxConcurrency: 1, maxRetries: 10 });
      config.env.EVIDENCE_DEAD_LETTER_QUEUE = { type: 'text', value: e.dead_letter };
    }
    for (const [name, value] of Object.entries({ EVIDENCE_QUEUE_NAME: e.queue, EVIDENCE_WORKFLOW_NAME: e.workflow,
      EVIDENCE_DAILY_LIMIT: String(e.daily_limit), EVIDENCE_ALLOW_AI: String(e.allow_ai), EVIDENCE_GATEWAY: e.gateway || '' })) config.env[name] = { type: 'text', value };
    if (e.allow_ai) config.env.AI = { type: 'ai' };
  }
  if (settings.evidence && !settings.previews && !settings.automatic_ci) config.triggers = [...(config.triggers || []), { type: 'scheduled', schedule: '*/5 * * * *' }];
  if (settings.tests) {
    const { testModuleOK } = await import('./src/test-policy.mjs');
    const { nativeWorkflowPath } = await import('./src/native-workflow.mjs');
    const workflow = settings.tests.workflow;
    if (!settings.evidence || (workflow !== undefined ?
      !workflow || typeof workflow !== 'object' || Array.isArray(workflow) || Object.keys(workflow).some(key => !['format', 'path'].includes(key)) ||
        !nativeWorkflowPath(workflow.format, workflow.path) || settings.tests.module !== undefined : !testModuleOK(settings.tests.module))) throw Error('Invalid approved native test source');
    if (settings.tests.build !== undefined && (settings.tests.build !== true || workflow?.format !== 'actions-act')) throw Error('Socketless build requires the pinned native Actions profile');
    if (typeof settings.tests.image !== 'string' ||
      !/^[a-z0-9][a-z0-9._/-]{0,127}:[a-z0-9][a-z0-9._-]{0,63}(?:@sha256:[a-f0-9]{64})?$/.test(settings.tests.image) ||
      workflow?.format === 'actions-act' && !settings.tests.image.includes('@sha256:') ||
      !/^sha256:[a-f0-9]{64}$/.test(settings.tests.image_id || '')) throw Error('Invalid approved container test allocation');
    const imageId = execFileSync('docker', ['image', 'inspect', settings.tests.image, '--format', '{{.Id}}'], { encoding: 'utf8', timeout: 10000 }).trim();
    if (imageId !== settings.tests.image_id) throw Error('Approved container image changed');
    config.compatibilityFlags = ['nodejs_compat'];
    config.env.TEST_EXECUTION_ENABLED = { type: 'text', value: 'true' };
    config.env.TEST_IMAGE_ID = { type: 'text', value: imageId };
    config.env.TEST_IMAGE_REF = { type: 'text', value: settings.tests.image };
    if (settings.tests.build) config.env.TEST_SOCKETLESS_BUILD = { type: 'text', value: 'true' };
    if (workflow) {
      config.env.TEST_WORKFLOW_FORMAT = { type: 'text', value: workflow.format };
      config.env.TEST_WORKFLOW_PATH = { type: 'text', value: workflow.path };
    } else config.env.TEST_MODULE = { type: 'text', value: settings.tests.module };
    config.env.TEST_POLICY_SHA256 = { type: 'text', value: createHash('sha256').update(JSON.stringify(settings.tests.build ? [workflow, imageId, true] : [workflow || settings.tests.module, imageId])).digest('hex') };
    config.exports.PRTestTask = { type: 'durable-object', storage: 'sqlite', container: settings.worker };
    config.exports.TestOutbound = { type: 'worker' };
    await u.writeContainerConfig({ root, directoryName: 'pr-tests', config: { name: settings.worker, schedulingPolicy: 'durable-object',
      observability: { enabled: false }, images: { agent: { localReference: settings.tests.image } } } });
  }
  if (settings.agent_path !== undefined) {
    const { agentPathOK, filePolicy } = await import('./src/agent-policy.mjs');
    if (!settings.tests || settings.tests.workflow || !settings.evidence?.allow_ai || !agentPathOK(settings.agent_path) || settings.worker.length > 56 ||
        settings.agent_path === settings.tests.module.replaceAll('.', '/') + '.py') throw Error('Invalid approved native agent allocation');
    config.env.AGENT_EXECUTION_ENABLED = { type: 'text', value: 'true' };
    config.env.AGENT_PATH = { type: 'text', value: settings.agent_path };
    config.env.AGENT_POLICY_SHA256 = { type: 'text', value: createHash('sha256').update(JSON.stringify([config.env.TEST_POLICY_SHA256.value, filePolicy(settings.agent_path)])).digest('hex') };
    config.exports.PRAgentTask = { type: 'durable-object', storage: 'sqlite', container: settings.worker + '-agents' };
    config.exports.AgentOutbound = { type: 'worker' };
    await u.writeContainerConfig({ root, directoryName: 'pr-agents', config: { name: settings.worker + '-agents', schedulingPolicy: 'durable-object',
      observability: { enabled: false }, images: { agent: { localReference: settings.tests.image } } } });
  }
  if (settings.analytics_dataset !== undefined) {
    if (!settings.evidence || typeof settings.analytics_dataset !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(settings.analytics_dataset)) throw Error('Invalid evidence analytics dataset');
    config.env.USAGE_ANALYTICS = { type: 'analytics-engine-dataset', name: settings.analytics_dataset };
  }
  if (settings.ui) {
    if (!settings.access_aud || !settings.web_assets || !(await lstat(resolve(settings.web_assets, 'native.html'))).isFile()) throw Error('Native UI requires Access and a built native frontend');
    uiAssets = await readUIAssets(resolve(settings.web_assets));
  }
  if (settings.previews) {
    const p = settings.previews, { previewPolicy } = await import('./src/delivery.mjs');
    if (!settings.tests || !settings.evidence || !p.access_aud || !/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(p.worker) || p.worker === settings.worker ||
      !previewPolicy({ EVIDENCE_BUCKET: true, PREVIEW_ORIGIN: p.origin, PREVIEW_PATH: p.path, PREVIEW_TTL: String(p.ttl), PREVIEW_ACCESS_AUD: p.access_aud, PUBLIC_ORIGIN: settings.origin })) throw Error('Invalid protected preview allocation');
    config.exports.EvidenceWorkflow.limits.steps += 1;
    if (p.automatic !== undefined && typeof p.automatic !== 'boolean') throw Error('Automatic previews require an explicit boolean');
    if (p.browser !== undefined && typeof p.browser !== 'boolean') throw Error('Browser snapshots require an explicit boolean');
    if (p.browser === true) { config.env.BROWSER = { type: 'browser' }; config.env.PREVIEW_BROWSER = { type: 'text', value: 'true' }; }
    for (const [name, value] of Object.entries({ PREVIEW_ORIGIN: p.origin, PREVIEW_PATH: p.path, PREVIEW_TTL: String(p.ttl), PREVIEW_ACCESS_AUD: p.access_aud, PREVIEW_AUTO: String(p.automatic !== false) })) config.env[name] = { type: 'text', value };
    config.exports.PreviewBroker = { type: 'worker' };
    config.triggers = [...(config.triggers || []), { type: 'scheduled', schedule: '*/5 * * * *' }];
    const previewRoot = resolve(root, 'preview-worker');
    await u.writeRootConfig(previewRoot, { accountId: settings.account }, { isPreview: false });
    const previewBundle = u.getWorkerBundleDir(previewRoot); await mkdir(previewBundle, { recursive: true });
    await esbuild.build({ entryPoints: [fileURLToPath(new URL('./src/preview-gateway.mjs', import.meta.url))], outfile: resolve(previewBundle, 'worker.mjs'), bundle: true, format: 'esm', platform: 'neutral' });
    if (p.workers_dev === true && settings.workers_dev !== true) throw Error('workers.dev preview is restricted to an explicit API qualification installation');
    await u.writeWorkerConfig({ root: previewRoot, config: { name: p.worker, compatibilityDate: '2026-10-08', workersDev: p.workers_dev === true, previewUrls: false,
      ...(p.workers_dev === true ? {} : { domains: [new URL(p.origin).hostname] }), observability: { enabled: false }, limits: { cpuMs: 100 },
      env: { FORGE: { type: 'worker', worker: settings.worker, exportName: 'PreviewBroker' }, PUBLIC_ORIGIN: { type: 'text', value: settings.origin }, PREVIEW_ORIGIN: { type: 'text', value: p.origin }, ACCESS_AUD: { type: 'text', value: p.access_aud } } },
      manifest: { type: 'partial', mainModule: 'worker.mjs', modules: {} } });
    await u.readBuildOutput(previewRoot);
  }
  if (settings.apps) {
    const { appPolicy } = await import('./src/app-policy.mjs');
    const a = settings.apps;
    if (!settings.previews || !/^[a-f0-9]{32}$/.test(a.provisioner?.store) || !/^[A-Za-z0-9_-]{1,64}$/.test(a.provisioner?.name) ||
        a.policy?.gateway !== settings.previews.worker || a.policy?.outbound !== settings.worker + '-outbound' ||
        a.policy?.secret?.store === a.provisioner.store && a.policy?.secret?.name === a.provisioner.name || typeof a.automatic !== 'boolean' ||
        !appPolicy({ APP_POLICY: JSON.stringify(a.policy), APP_PROVISIONER_NAME: a.provisioner.name, APP_PROVISIONER: { get() {} }, APP_DISPATCH: { get() {} },
          PREVIEW_ORIGIN: settings.previews.origin, PREVIEW_ACCESS_AUD: settings.previews.access_aud })) throw Error('Invalid managed application allocation');
    config.exports.EvidenceWorkflow.limits.steps += 1;
    config.env.APP_POLICY = { type: 'text', value: JSON.stringify(a.policy) };
    config.env.APP_AUTO = { type: 'text', value: String(a.automatic) };
    config.env.APP_PROVISIONER_NAME = { type: 'text', value: a.provisioner.name };
    config.env.APP_PROVISIONER = { type: 'secrets-store-secret', storeId: a.provisioner.store, secretName: a.provisioner.name };
    config.env.APP_DISPATCH = { type: 'dispatch-namespace', namespace: a.policy.namespace, outbound: { worker: a.policy.outbound } };
    const outboundRoot = resolve(root, 'app-outbound');
    await u.writeRootConfig(outboundRoot, { accountId: settings.account }, { isPreview: false });
    const outboundBundle = u.getWorkerBundleDir(outboundRoot); await mkdir(outboundBundle, { recursive: true });
    await esbuild.build({ entryPoints: [fileURLToPath(new URL('./src/app-outbound.mjs', import.meta.url))], outfile: resolve(outboundBundle, 'worker.mjs'), bundle: true, format: 'esm' });
    await u.writeWorkerConfig({ root: outboundRoot, config: { name: a.policy.outbound, compatibilityDate: '2026-10-09', workersDev: false, previewUrls: false, observability: { enabled: false } }, manifest: { type: 'partial', mainModule: 'worker.mjs', modules: {} } });
    await u.readBuildOutput(outboundRoot);
    const previewRoot = resolve(root, 'preview-worker'), output = await u.readBuildOutput(previewRoot);
    // Reuse the existing preview authority; application Workers receive no forge service binding.
    output.workers.default.config.env.APP_HOSTS = { type: 'text', value: 'true' };
    await u.writeWorkerConfig({ root: previewRoot, config: output.workers.default.config, manifest: { type: 'partial', mainModule: 'worker.mjs', modules: {} } });
    await u.readBuildOutput(previewRoot);
  }
  if (settings.automatic_ci !== undefined) {
    if (typeof settings.automatic_ci !== 'boolean' || settings.automatic_ci && !settings.tests) throw Error('Automatic CI requires an approved test allocation');
    config.env.CI_AUTO = { type: 'text', value: String(settings.automatic_ci) };
    if (!settings.previews && settings.automatic_ci) config.triggers = [...(config.triggers || []), { type: 'scheduled', schedule: '*/5 * * * *' }];
  }
  for (const [name, value] of Object.entries({ ACCOUNT_ID: settings.account, ARTIFACTS_NAMESPACE: settings.namespace,
    WORKSPACE_SLUG: settings.workspace, PUBLIC_ORIGIN: settings.origin, ACCESS_AUD: settings.access_aud || '' })) config.env[name] = { type: 'text', value };
  if (settings.hostname) config.domains = [settings.hostname];
  const built = await esbuild.build({ entryPoints: [fileURLToPath(new URL(settings.agent_path ? './src/agent-entry.mjs' : settings.tests ? './src/test-entry.mjs' : './src/worker.mjs', import.meta.url))],
    outfile: resolve(bundle, 'worker.mjs'), bundle: true, format: 'esm', platform: 'neutral',
    // Binding changes must also change the bundle so live Durable Objects adopt the new configuration.
    define: { GOLF_NATIVE_ASSETS: JSON.stringify(uiAssets), GOLF_NATIVE_CONFIGURATION: JSON.stringify(createHash('sha256').update(JSON.stringify(settings)).digest('hex')) },
    nodePaths: [resolve(fileURLToPath(new URL('../agents/node_modules', import.meta.url)))],
    conditions: ['workerd', 'worker', 'browser'], external: ['cloudflare:workers', 'node:*'], metafile: true });
  const exported = Object.values(built.metafile.outputs).flatMap(output => output.exports);
  for (const name of Object.keys(config.exports)) if (!exported.includes(name)) throw Error('Native bundle is missing configured export: ' + name);
}
if (mode !== 'retire') {
  Object.assign(config.env, webhookBindings(settings));
  if (settings.webhooks && !config.triggers?.some(trigger => trigger.type === 'scheduled')) config.triggers = [...(config.triggers || []), { type: 'scheduled', schedule: '* * * * *' }];
}
if (mode !== 'retire' && (operations.analyticsSecret || operations.serviceHealth) && !config.triggers?.some(trigger => trigger.type === 'scheduled')) config.triggers = [...(config.triggers || []), { type: 'scheduled', schedule: '*/5 * * * *' }];
await u.writeWorkerConfig({ root, config, manifest: { type: 'partial', mainModule: 'worker.mjs', modules: {} } });
await u.readBuildOutput(root);
console.log('Native Artifacts/D1 forge build output validated');
