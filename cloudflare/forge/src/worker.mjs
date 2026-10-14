import { drainWebhooks, webhookPolicy } from './webhooks.mjs';
import { drainEmail, emailPolicy } from './email.mjs';
import { collectWorkerMetrics, collectServiceHealth } from './operations-provider.mjs';
import { runMaintenance } from './operations.mjs';
import { withInstallationPolicy } from './installation.mjs';
import { publicFetch } from './public.mjs';
import { DurableObject, WorkflowEntrypoint, WorkerEntrypoint } from 'cloudflare:workers';
import { handle, serialize, concurrentRead, advanceEvidence, testGit, testRegistry, registryExecution, agentGit, servePreview, cleanupPreviews, runCI } from './core.mjs';
import { consumeEvidence, consumeEvidenceDeadLetters, reconcileEvidence } from './evidence.mjs';
import { Fault, deny } from './common.mjs';
import { reconcileIndexes } from './repository-indexes.mjs';
import { initializeMetadataJobs, metadataJob, advanceMetadataJobs } from './metadata-jobs.mjs';
import { RepositoryActivity, activityPath, activitySelection } from './activity.mjs';
import { activityAuthority } from './core.mjs';
import { registryAuthority } from './repository-settings.mjs';
import { PerformanceHistory } from './performance.mjs';
import { executionDiagnostic } from './test-policy.mjs';
import { nativeRunnerStop } from './native-runners.mjs';
import { managedRegistry } from './managed-registry.mjs';
import { releaseExecutionValues } from './execution-values.mjs';


const heartbeat = 5 * 60_000;
export class Workspace extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.performance = new PerformanceHistory(ctx.storage.sql);
    ctx.waitUntil(ctx.storage.getAlarm().then(at => at ?? ctx.storage.setAlarm(Date.now() + heartbeat)));
    const workflows = env.EvidenceWorkflow || ctx.exports.EvidenceWorkflow;
    this.activity = new RepositoryActivity(ctx.storage, (request, input) => this.authority({ activity: true, request, input }));
    const configured = this.configured = { ...env, previewChanged: id => this.activity.publish(String(id), ['actions', 'pulls']), performanceSnapshot: () => this.performance.metrics(), watchRepository: request => this.activity.watch(request), waitUntil: promise => ctx.waitUntil(promise), gitObjectCache: { objects: new Map(), pending: new Map(), bytes: 0 }, testTasks: ctx.exports.PRTestTask, agentTasks: ctx.exports.PRAgentTask };
    if (env.REGISTRY_PROVIDER === 'cloudflare') {
      configured.registryUploadStore = ctx.storage;
      configured.REGISTRY = managedRegistry(configured, input => registryAuthority(configured, input));
    }
    this.dispatch = serialize(async event => {
      const selection = await activitySelection(event);
      let result;
      try {
        result = await (event instanceof Request ? handle(event, configured) : event.ci ? runCI(configured) : event.preview ? servePreview(configured, event.preview) : event.cleanup ? cleanupPreviews(configured) : event.values ? releaseExecutionValues(configured, event.id, id => advanceEvidence(configured, id, 'authorize-test', workflows)) : event.git
          ? event.phase ? agentGit(configured, event.id, event.git, event.phase, workflows) : testGit(configured, event.id, event.git, workflows)
          : event.registry ? testRegistry(configured,event.id,event.registry) : event.notify ? undefined : advanceEvidence(configured, event.id, event.phase, workflows));
        return result;
      } finally {
        if (result?.ok && (selection || event instanceof Request && /\/golf\.v1\.RepositoryWebhookService\/(?:Test|Redeliver)RepositoryWebhook$/.test(new URL(event.url).pathname)))
          this.ctx.waitUntil(this.deliverWebhooks().catch(() => console.log(JSON.stringify({ event:'golf.webhook_delivery_failed' }))));
        // The first send follows the mutation, runner report or background step that queued it; only retries wait for a later drain or the schedule.
        if (selection ? result?.ok || !(event instanceof Request) : result?.ok && event instanceof Request && /\/golf\.v1\.EmailNotificationService\/RedeliverOwnEmail$|^\/native\/runner-machine\/[a-f0-9-]{36}\/finish$|^\/api\/v4\/jobs\/[1-9][0-9]{0,15}$/.test(new URL(event.url).pathname))
          this.ctx.waitUntil(this.deliverEmail().catch(() => console.log(JSON.stringify({ event:'golf.email_delivery_failed' }))));
        // Definite refusals have no activity; ambiguous provider failures can have effects.
        if (selection && (!(event instanceof Request) || !result || result.ok || result.status >= 500)) {
          try {
            const db = env.DB.withSession('first-primary');
            let rows;
            if (selection.job) rows = (await db.prepare('SELECT repository_id AS id FROM evidence_jobs WHERE id=?').bind(selection.job).all()).results;
            else if (selection.invitation) rows = (await db.prepare('SELECT repository_id AS id FROM repository_invitations WHERE id=?').bind(selection.invitation).all()).results;
            else if (selection.name || selection.id) rows = (await db.prepare("SELECT id FROM repositories WHERE state='ACTIVE' AND (name=? OR id=?)").bind(selection.name || '', selection.id || '').all()).results;
            else rows = (await db.prepare("SELECT id FROM repositories WHERE state='ACTIVE'").all()).results;
            for (const row of rows) this.activity.publish(String(row.id), selection.topics);
          } catch { console.log(JSON.stringify({ event: 'golf.activity_publication_failed' })); }
        }
      }
    }, concurrentRead);
    // Client mutations fence authority reads; background jobs cannot change membership.
    this.authority = serialize(event => event.activity ? activityAuthority(event.request, configured, event.input)
      : new URL(event.url).pathname === '/rpc/golf.v1.RepositoryAccessService/GetRepositoryAccess' ? handle(event, configured) : this.dispatch(event),
    event => event?.activity || concurrentRead(event));
  }
  // Drains read the installation policy in force at their start: removed origins, limits and email turned off.
  async deliverWebhooks() { return drainWebhooks(await withInstallationPolicy(this.configured)); }
  async deliverEmail() { return drainEmail(await withInstallationPolicy(this.configured)); }
  scheduleRan() { this.ctx.storage.kv.put('scheduled', Date.now()); }
  // Cron Triggers are the schedule. The alarm repeats the same maintenance only while none has reported in for two periods.
  async alarm() {
    // A workspace renamed by its operator leaves its old object behind; that one stops its own heartbeat.
    if (this.ctx.id?.name && this.ctx.id.name !== this.env.WORKSPACE_SLUG) { await this.ctx.storage.deleteAlarm(); return; }
    await this.ctx.storage.setAlarm(Date.now() + heartbeat);
    if (Date.now() - (this.ctx.storage.kv.get('scheduled') || 0) < 2 * heartbeat) return;
    try { await maintain(this.env, this.ctx.exports, this); } catch { /* Each stage's outcome is in the maintenance journal. */ }
  }
  evidence(id, phase) { return this.dispatch({ id, phase }); }
  recordPerformance(sample) { this.performance.record(sample); }
  preview(input) { return this.dispatch({ preview: input }); }
  cleanupPreviews() { return this.dispatch({ cleanup: true }); }
  runCI() { return this.dispatch({ ci: true }); }
  activityChanged(repositoryId, topics) { return this.dispatch({ notify: true, repositoryId, topics }); }
  agentGit(id, request, phase) { return this.dispatch({ id, git: request, phase }); }
  testRegistry(id, request) { return this.dispatch({ id, registry: request }); }
  testGit(id, request) { return this.dispatch({ id, git: request }); }
  // Callable only from this Worker's own test task; the reply carries released plaintext and is never logged or stored here.
  testValues(id) { return this.dispatch({ id, values: true }); }
  fetch(request) {
    // One partition owner serializes provider effects and permission changes.
    // Durable pending records fence writes after restart or an ambiguous response.
    // Streams re-enter the admission queue only for short authorization reads.
    // Native reads overlap in both queues, but cannot pass a pending client revocation.
    const path = new URL(request.url).pathname;
    const response = path === activityPath ? handle(request, this.configured)
      : path === '/rpc/golf.v1.RepositoryAccessService/GetRepositoryAccess' || path.startsWith('/native/') || !concurrentRead(request) ? this.authority(request) : this.dispatch(request);
    if (this.env.CI_AUTO === 'true' && request.method === 'POST' && new URL(request.url).pathname.endsWith('/git-receive-pack')) this.ctx.waitUntil(response.then(() => this.runCI()));
    return response;
  }
}

// Immutable reads coordinate per repository; the workspace retains final authority.
export class RepositoryReads extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    initializeMetadataJobs(ctx);
    const cache = { objects: new Map(), pending: new Map(), bytes: 0 };
    this.warmed = new Set();
    const owner = ctx.exports.Workspace.get(ctx.exports.Workspace.idFromName(env.WORKSPACE_SLUG));
    // Indexing mutates only its own journal; it must not queue foreground reads.
    this.index = serialize(() => advanceMetadataJobs(ctx, { ...env, notifyMetadata: id => owner.activityChanged(String(id), ['issues']), waitUntil: promise => ctx.waitUntil(promise) }));
    this.dispatch = serialize(async request => {
      return handle(request, { ...env, metadataIndex: (row, person, repo, commitId) => metadataJob(ctx, env, row, person, repo, commitId), waitUntil: promise => ctx.waitUntil(promise), gitObjectCache: cache, confirmRead: async (authority, clock) => {
        const headers = new Headers(request.headers); headers.set('Content-Type', 'application/json'); headers.set('Connect-Protocol-Version', '1');
        const receipt = await owner.fetch(new Request(env.PUBLIC_ORIGIN + '/rpc/golf.v1.RepositoryAccessService/GetRepositoryAccess', {
          method: 'POST', headers, body: JSON.stringify({ repository: authority.repository }) }));
        for (const part of (receipt.headers.get('Server-Timing') || '').split(',')) {
          const stage = /^\s*(queue|d1|actor|grant);dur=([\d.]+)(?:;desc="\d+ calls")?\s*$/.exec(part);
          if (stage) clock.record('authority_' + stage[1], Number(stage[2]));
        }
        if (receipt.status === 401) throw new Fault('unauthenticated', 401, 'Sign-in required.');
        if (receipt.status === 404 || receipt.status === 403) deny();
        if (!receipt.ok) throw Error('Read authority unavailable');
        const current = (await receipt.json()).access;
        if (current?.repositoryId !== authority.repositoryId || current.currentPermission !== authority.role) deny();
      } });
    }, event => event instanceof Request);
  }
  fetch(request) {
    const result = this.dispatch(request);
    if (this.env.READ_INDEXES === 'true' && new URL(request.url).pathname.endsWith('/GetRepository'))
      this.ctx.waitUntil(result.then(async response => {
        if (!response.ok) return;
        const value = await response.clone().json(), commitId = value.sourceSelection?.commitId;
        if (!commitId || !value.repository?.id) return;
        const key = value.repository.id + ':' + commitId;
        if (this.warmed.has(key)) return;
        if (this.warmed.size >= 64) this.warmed.delete(this.warmed.values().next().value);
        this.warmed.add(key);
        try { await this.prewarm(request, value.repository, commitId); } catch { this.warmed.delete(key); }
      }).catch(() => {}));
    return result;
  }
  async prewarm(request, repository, commitId) {
    const base = { repository: { owner: repository.fullName.split('/')[0], name: repository.name }, repositoryId: repository.id };
    const read = async (method, input) => {
      const headers = new Headers(request.headers); headers.set('Content-Type', 'application/json'); headers.set('Connect-Protocol-Version', '1');
      const response = await this.dispatch(new Request(this.env.PUBLIC_ORIGIN+'/rpc/golf.v1.RepositoryService/'+method, { method:'POST', headers, body:JSON.stringify({...base,...input}) }));
      if (!response.ok) throw Error('Repository pre-read unavailable');
      return response.json();
    };
    const contents = path => read('GetContents', { ref:commitId, path, includeLatestChanges:true, page:{page:1,limit:100} });
    // Pre-read the next screen, without making its provider work block this response.
    const results = await Promise.allSettled([contents(''), read('GetRepositoryOverview',{ref:commitId}), read('ListCommits',{ref:commitId,page:{page:1,limit:1}})]);
    if (results[0].status !== 'fulfilled') throw results[0].reason;
    const root = results[0].value.entries || [], choose = entries => entries?.find(entry => /^readme\.(md|markdown|mdown)$/i.test(entry.name));
    let readme;
    if (root.some(entry => entry.name === '.github' && entry.type === 'SOURCE_ENTRY_TYPE_DIRECTORY')) readme = choose((await contents('.github')).entries);
    readme ||= choose(root);
    if (!readme && root.some(entry => entry.name === 'docs' && entry.type === 'SOURCE_ENTRY_TYPE_DIRECTORY')) readme = choose((await contents('docs')).entries);
    if (readme) await contents(readme.path);
  }
  alarm() { return this.index(); }
}

// Only the dedicated preview Worker's scoped service binding can invoke this RPC.
export class PreviewBroker extends WorkerEntrypoint {
  preview(input) {
    const workspace = this.ctx.exports.Workspace;
    return workspace.get(workspace.idFromName(this.env.WORKSPACE_SLUG)).preview(input);
  }
}

// Only CFCR's private service binding can request inherited repository authority.
export class PackagesAuthority extends WorkerEntrypoint {
  async authorize(input) {
    // CFCR can call back while the workspace awaits its result; authority needs no coordinator hop.
    try {
      const configured = { ...this.env, testTasks: this.ctx.exports.PRTestTask, agentTasks: this.ctx.exports.PRAgentTask,
        registryExecution: (actorId,row,execution) => registryExecution(configured,actorId,row,execution) };
      return await registryAuthority(configured, input);
    } catch (error) { return { read: false, write: false, authorizationError: executionDiagnostic(error) }; }
  }
}

export class EvidenceWorkflow extends WorkflowEntrypoint {
  async run(event, step) {
    if (event.payload?.jobId !== event.instanceId) throw Error('Evidence workflow identity mismatch');
    const workspace = this.ctx.exports.Workspace;
    const owner = workspace.get(workspace.idFromName(this.env.WORKSPACE_SLUG));
    const id = event.payload.jobId;
    const executions = [['tests', this.ctx.exports.PRTestTask], ['agents', this.ctx.exports.PRAgentTask]];
    try {
      for (const [phase, tasks] of executions) if (tasks) {
        let result;
        for (let i = 0; i < (phase === 'agents' ? 80 : 70); i++) {
          result = await step.do('container ' + phase + ' ' + i, { retries: { limit: 2, delay: '1 second' }, timeout: '45 seconds' }, () => owner.evidence(id, phase));
          if (result.state !== 'RUNNING') break;
          await step.sleep('wait for ' + phase + ' ' + i, phase === 'tests' ? '9 seconds' : '5 seconds');
        }
        if (result.state === 'RUNNING') await step.do('stop overdue ' + phase, () => owner.evidence(id, 'finish-' + phase));
      }
      await step.do('bounded advisory', { retries: { limit: 0, delay: '1 second' }, timeout: '45 seconds' }, () => owner.evidence(id, 'advice'));
      const report = await step.do('immutable private report', { retries: { limit: 2, delay: '1 second' }, timeout: '180 seconds' }, () => owner.evidence(id, 'store'));
      // Provider publication gets fresh invocation limits and retains its original operation key.
      for (const [phase, enabled] of [['publish-static', this.env.PREVIEW_AUTO === 'true'], ['publish-app', this.env.APP_AUTO === 'true']]) if (enabled) {
        Object.assign(report, await step.do(phase, { retries: { limit: 2, delay: '1 second' }, timeout: '180 seconds' }, () => owner.evidence(id, phase)));
      }
      return report;
    } catch (error) {
      await step.do('refuse failed evidence', { retries: { limit: 2, delay: '1 second' }, timeout: '45 seconds' }, () => owner.evidence(id, 'refuse'));
      throw Error('Golf evidence workflow failed; inspect its retained job state.');
    } finally {
      for (const [phase, tasks] of executions) if (tasks) await step.do('destroy ' + phase + ' container', { retries: { limit: 2, delay: '1 second' }, timeout: '45 seconds' }, () => tasks.getByName(id).cancel());
    }
  }
}

// The same stages run from the Cron Trigger and, when that stops reporting in, from the workspace alarm.
async function maintain(env, exports, owner) {
    try { await runMaintenance(env, [
      ['ci', () => owner.runCI()],
      ...(webhookPolicy(env) ? [['webhooks', () => owner.deliverWebhooks()]] : []),
      ...(emailPolicy(env) ? [['email', () => owner.deliverEmail()]] : []),
      ['previews', () => owner.cleanupPreviews()],
      ['evidence', async () => { const result = await reconcileEvidence(env, async job => {
        if (job.test_state === 'RUNNING') {
          if (JSON.parse(job.snapshot).execution?.runner) await nativeRunnerStop(env,job);
          else {
            if (!exports.PRTestTask) throw Error('Test cleanup allocation is missing');
            await exports.PRTestTask.getByName(job.id).cancel();
          }
        }
        if (['FORK_PENDING', 'RUNNING'].includes(job.agent_state)) {
          if (!exports.PRAgentTask) throw Error('Agent cleanup allocation is missing');
          await exports.PRAgentTask.getByName(job.id).cancel();
        }
      }); await owner.activityChanged(); return result; }],
      ['indexes', () => reconcileIndexes(env)],

    ]); } finally { try { await collectWorkerMetrics(env); } finally { await collectServiceHealth(env); } }
}

export default {
  async scheduled(event, env, ctx) {
    const workspace = ctx.exports.Workspace;
    const owner = workspace.get(workspace.idFromName(env.WORKSPACE_SLUG));
    await owner.scheduleRan();
    await maintain(env, ctx.exports, owner);
  },
  async queue(batch, env, ctx) {
    const workspace = ctx.exports.Workspace;
    const owner = workspace.get(workspace.idFromName(env.WORKSPACE_SLUG));
    if (batch.queue === env.EVIDENCE_DEAD_LETTER_QUEUE) { const result = await consumeEvidenceDeadLetters(batch, env); await owner.activityChanged(); return result; }
    return consumeEvidence(batch, env, owner);
  },
  fetch: publicFetch,
};
