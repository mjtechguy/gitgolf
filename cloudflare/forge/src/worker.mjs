import { drainWebhooks, webhookPolicy } from './webhooks.mjs';
import { collectWorkerMetrics, collectServiceHealth } from './operations-provider.mjs';
import { runMaintenance } from './operations.mjs';
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


export class Workspace extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.performance = new PerformanceHistory(ctx.storage.sql);
    this.activity = new RepositoryActivity(ctx.storage, (request, input) => this.authority({ activity: true, request, input }));
    const configured = this.configured = { ...env, performanceSnapshot: () => this.performance.metrics(), watchRepository: request => this.activity.watch(request), waitUntil: promise => ctx.waitUntil(promise), gitObjectCache: { objects: new Map(), pending: new Map(), bytes: 0 }, testTasks: ctx.exports.PRTestTask, agentTasks: ctx.exports.PRAgentTask };
    this.dispatch = serialize(async event => {
      const selection = await activitySelection(event);
      let result;
      try {
        result = await (event instanceof Request ? handle(event, configured) : event.ci ? runCI(configured) : event.preview ? servePreview(configured, event.preview) : event.cleanup ? cleanupPreviews(configured) : event.git
          ? event.phase ? agentGit(configured, event.id, event.git, event.phase, ctx.exports.EvidenceWorkflow) : testGit(configured, event.id, event.git, ctx.exports.EvidenceWorkflow)
          : event.registry ? testRegistry(configured,event.id,event.registry) : event.notify ? undefined : advanceEvidence(configured, event.id, event.phase, ctx.exports.EvidenceWorkflow));
        return result;
      } finally {
        if (result?.ok && (selection || event instanceof Request && /\/golf\.v1\.RepositoryWebhookService\/(?:Test|Redeliver)RepositoryWebhook$/.test(new URL(event.url).pathname)))
          this.ctx.waitUntil(this.deliverWebhooks().catch(() => console.log(JSON.stringify({ event:'golf.webhook_delivery_failed' }))));
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
  deliverWebhooks() { return drainWebhooks(this.configured); }
  evidence(id, phase) { return this.dispatch({ id, phase }); }
  recordPerformance(sample) { this.performance.record(sample); }
  preview(input) { return this.dispatch({ preview: input }); }
  cleanupPreviews() { return this.dispatch({ cleanup: true }); }
  runCI() { return this.dispatch({ ci: true }); }
  activityChanged(repositoryId, topics) { return this.dispatch({ notify: true, repositoryId, topics }); }
  agentGit(id, request, phase) { return this.dispatch({ id, git: request, phase }); }
  testRegistry(id, request) { return this.dispatch({ id, registry: request }); }
  testGit(id, request) { return this.dispatch({ id, git: request }); }
  fetch(request) {
    // One partition owner serializes provider effects and permission changes.
    // Durable pending records fence writes after restart or an ambiguous response.
    // Streams re-enter the admission queue only for short authorization reads.
    const path = new URL(request.url).pathname;
    const response = path === activityPath ? handle(request, this.configured)
      : path === '/rpc/golf.v1.RepositoryAccessService/GetRepositoryAccess' || !concurrentRead(request) ? this.authority(request) : this.dispatch(request);
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
  fetch(request) { return this.dispatch(request); }
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
        for (let i = 0; i < (phase === 'agents' ? 80 : 40); i++) {
          result = await step.do('container ' + phase + ' ' + i, { retries: { limit: 2, delay: '1 second' }, timeout: '45 seconds' }, () => owner.evidence(id, phase));
          if (result.state !== 'RUNNING') break;
          await step.sleep('wait for ' + phase + ' ' + i, '5 seconds');
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

export default {
  async scheduled(event, env, ctx) {
    const workspace = ctx.exports.Workspace;
    const owner = workspace.get(workspace.idFromName(env.WORKSPACE_SLUG));
    try { await runMaintenance(env, [
      ['ci', () => owner.runCI()],
      ...(webhookPolicy(env) ? [['webhooks', () => owner.deliverWebhooks()]] : []),
      ['previews', () => owner.cleanupPreviews()],
      ['evidence', async () => { const result = await reconcileEvidence(env, async job => {
        if (job.test_state === 'RUNNING') {
          if (!ctx.exports.PRTestTask) throw Error('Test cleanup allocation is missing');
          await ctx.exports.PRTestTask.getByName(job.id).cancel();
        }
        if (['FORK_PENDING', 'RUNNING'].includes(job.agent_state)) {
          if (!ctx.exports.PRAgentTask) throw Error('Agent cleanup allocation is missing');
          await ctx.exports.PRAgentTask.getByName(job.id).cancel();
        }
      }); await owner.activityChanged(); return result; }],
      ['indexes', () => reconcileIndexes(env)],

    ]); } finally { try { await collectWorkerMetrics(env); } finally { await collectServiceHealth(env); } }
  },
  async queue(batch, env, ctx) {
    const workspace = ctx.exports.Workspace;
    const owner = workspace.get(workspace.idFromName(env.WORKSPACE_SLUG));
    if (batch.queue === env.EVIDENCE_DEAD_LETTER_QUEUE) { const result = await consumeEvidenceDeadLetters(batch, env); await owner.activityChanged(); return result; }
    return consumeEvidence(batch, env, owner);
  },
  fetch: publicFetch,
};
