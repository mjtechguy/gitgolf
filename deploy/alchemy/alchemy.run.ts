import * as Alchemy from 'alchemy';
import * as Cloudflare from 'alchemy/Cloudflare';
import * as Command from 'alchemy/Command';
import * as Output from 'alchemy/Output';
import { localState } from 'alchemy/State';
import * as Effect from 'effect/Effect';
import * as Layer from 'effect/Layer';
import * as Redacted from 'effect/Redacted';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { bindings, outputPath, readConfig } from './native-config.mjs';
import { WorkflowSettings, workflowSettingsProvider } from './workflow-settings.js';
import { PreviewDomain, previewDomainProvider } from './preview-domain.js';

const directory = resolve(process.env.GOLF_ALCHEMY_DIRECTORY!);
const input = JSON.parse(readFileSync(resolve(directory, 'alchemy-input.json'), 'utf8'));
const root = resolve(import.meta.dirname, '../..');
const name = input.name;

export default Alchemy.Stack('GolfDemo', {
  providers: Layer.mergeAll(Cloudflare.providers(), Command.providers(), workflowSettingsProvider(), previewDomainProvider()),
  state: localState(),
}, Effect.gen(function* () {
  const db = yield* Cloudflare.D1.Database('Database', { name });
  const bucket = yield* Cloudflare.R2.Bucket('Evidence', { name, forceDestroy: true, publicAccess: false });
  const queue = yield* Cloudflare.Queues.Queue('EvidenceQueue', { name });
  const dispatch = yield* Cloudflare.WorkersForPlatforms.DispatchNamespace('Applications', { name });
  const machine = yield* Cloudflare.Access.ServiceToken('Operator', { name: name + '-operator', duration: '5h' });
  const idp = yield* Cloudflare.Access.IdentityProvider('Login', { name, type: 'onetimepin', config: {} });
  const policies = [
    { name: 'Approved demo owner', decision: 'allow' as const, include: [{ email: { email: input.email } }] },
    { name: 'Demo operator', decision: 'non_identity' as const, include: [{ serviceToken: { tokenId: machine.serviceTokenId } }] },
  ];
  const controlAccess = yield* Cloudflare.Access.Application('ControlAccess', {
    name: name + '-control', type: 'self_hosted', domain: input.hostname,
    sessionDuration: '4h', allowedIdps: [idp.identityProviderId], autoRedirectToIdentity: true, policies,
  });
  const previewAccess = yield* Cloudflare.Access.Application('PreviewAccess', {
    name: name + '-preview', type: 'self_hosted', domain: input.previewHostname,
    destinations: [input.previewHostname, '*.' + input.previewHostname].map(uri => ({ type: 'public' as const, uri })),
    sessionDuration: '4h', allowedIdps: [idp.identityProviderId], autoRedirectToIdentity: true, policies,
  });
  const policy = (permissionGroups: Cloudflare.ApiToken.PermissionGroupRef[]) => [{ effect: 'allow' as const,
    resources: { ['com.cloudflare.api.account.' + input.account]: '*' }, permissionGroups }];
  const management = yield* Cloudflare.ApiToken.AccountApiToken('AppAuthority', {
    name, expiresOn: input.expiresAt,
    policies: policy(['D1 Write', 'Workers Scripts Write', 'Workers R2 Storage Write', 'Secrets Store Write']),
  });
  const registry = yield* Cloudflare.ApiToken.AccountApiToken('RegistryAuthority', {
    name: name + '-registry', expiresOn: input.expiresAt, policies: policy(['Workers Containers Write']),
  });
  const store = input.secretStoreId ? { storeId: input.secretStoreId, accountId: input.account }
    : yield* Cloudflare.SecretsStore.Store('Secrets');
  const secrets = yield* Effect.all([
    Cloudflare.SecretsStore.Secret('ManagementSecret', { store, name: name + '-management', value: management.value }),
    Cloudflare.SecretsStore.Secret('RegistrySecret', { store, name: name + '-registry', value: registry.value }),
    Cloudflare.SecretsStore.Secret('SigningSecret', { store, name: name + '-signing', value: Redacted.make(input.signingKey) }),
  ]);
  const settings = Output.all(db.databaseId, controlAccess.aud, previewAccess.aud,
    bucket.bucketName, queue.queueName, dispatch.name, ...secrets.map(s => s.storeId)).pipe(Output.map(([databaseId, aud, previewAud, , , , storeId]) => ({
      ...input.settings, database: { name, uuid: databaseId }, access_aud: aud,
      previews: { ...input.settings.previews, access_aud: previewAud },
      registry: { ...input.settings.registry, apiToken: { store: storeId, name: name + '-registry' } },
      apps: { ...input.settings.apps, provisioner: { store: storeId, name: name + '-management' },
        policy: { ...input.settings.apps.policy, secret: { store: storeId, name: name + '-signing' } } },
  })));
  const build = yield* Command.Build('NativeBuild', {
    command: 'python3 scripts/cloudflare_alchemy_demo.py build', cwd: root, outdir: resolve(directory, '.cloudflare'),
    env: { GOLF_ALCHEMY_DIRECTORY: directory, GOLF_ALCHEMY_SETTINGS: settings.pipe(Output.map(JSON.stringify)) },
    memo: { include: ['cloudflare/forge/**', 'web/src/**', 'web/public/**', 'web/*.html', 'web/vite*.ts', 'web/tsconfig*.json', 'web/package*.json', 'scripts/cloudflare_alchemy_demo.py', 'deploy/alchemy/**'], exclude: ['**/node_modules/**'] },
    timeout: '5 minutes',
  });
  const config = (part = '') => build.outdir.pipe(Output.map(dir => readConfig(resolve(dir, '..', part))));
  const main = (part = '') => build.outdir.pipe(Output.map(dir => resolve(outputPath(resolve(dir, '..', part)), 'bundle/worker.mjs')));
  const outbound = yield* Cloudflare.Worker('Outbound', {
    name: name + '-outbound', main: main('app-outbound'), bundle: false, workersDev: false,
    compatibility: { date: '2026-10-09', flags: [] }, observability: { enabled: false },
  });
  const agent = Cloudflare.Container('agent', {
    schedulingPolicy: 'durable_object', context: resolve(directory, 'image'),
    publish: { repository: name }, observability: { logs: { enabled: false } },
  });
  const published = yield* agent.Application;
  const control = yield* Cloudflare.Worker('Control', {
    name, main: main(), bundle: false, workersDev: false,
    domain: { name: input.hostname, zoneId: input.zone },
    compatibility: { date: '2026-10-08', flags: ['nodejs_compat'] },
    observability: { enabled: false }, limits: { cpuMs: 100 }, crons: ['*/5 * * * *'],
    entrypoints: { PackagesAuthority: {}, TestOutbound: {}, PreviewBroker: {} },
    env: {
      Workspace: Cloudflare.DurableObject('Workspace'),
      RepositoryReads: Cloudflare.DurableObject('RepositoryReads'),
      PRTestTask: Cloudflare.DurableObject('PRTestTask', { containers: [agent] }),
      EvidenceWorkflow: Cloudflare.Workflow('EvidenceWorkflow', { workflowName: name, limits: { steps: 87 } }),
      ALCHEMY_OUTBOUND_DEPENDENCY: outbound.workerName,
    },
  });
  yield* control.bind('native-contract', { bindings: config().pipe(Output.map(bindings)) });
  const preview = yield* Cloudflare.Worker('Preview', {
    name: name + '-preview', main: main('preview-worker'), bundle: false, workersDev: false,
    compatibility: { date: '2026-10-08', flags: [] }, observability: { enabled: false }, limits: { cpuMs: 100 },
    env: { ALCHEMY_CONTROL_DEPENDENCY: control.workerName },
  });
  yield* preview.bind('native-contract', { bindings: config('preview-worker').pipe(Output.map(bindings)) });
  yield* PreviewDomain('PreviewDomain', { accountId: input.account, hostname: input.previewHostname,
    service: preview.workerName, zoneId: input.zone });
  const consumer = yield* Cloudflare.Queues.Consumer('EvidenceConsumer', {
    queueId: queue.queueId, scriptName: control.workerName,
    settings: { batchSize: 1, maxConcurrency: 1, maxRetries: 3, maxWaitTimeMs: 1000 },
  });
  const workflow = yield* WorkflowSettings('WorkflowLimits', { accountId: input.account,
    workflowName: control.env.EvidenceWorkflow.workflowName, scriptName: control.workerName });
  yield* Command.Exec('Receipt', {
    command: 'python3 scripts/cloudflare_alchemy_demo.py receipt', cwd: root, memo: false,
    env: { GOLF_ALCHEMY_DIRECTORY: directory,
      GOLF_ALCHEMY_RECEIPT: Output.all(settings, machine.clientId, machine.clientSecret,
        machine.serviceTokenId, control.workerId, preview.workerId, consumer.consumerId, workflow.versionId, published.image).pipe(Output.map(
        ([settings, clientId, clientSecret, serviceTokenId, workerId, previewId, , , image]) => Redacted.make(JSON.stringify({
          settings, clientId, clientSecret: Redacted.value(clientSecret!), serviceTokenId, workerId, previewId, image,
        })))),
    }, timeout: '2 minutes',
  });
  return { url: 'https://' + input.hostname, previewUrl: 'https://' + input.previewHostname, directory };
}));
