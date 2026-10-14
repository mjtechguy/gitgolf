import * as Workflows from '@distilled.cloud/cloudflare/workflows';
import * as Effect from 'effect/Effect';
import * as Layer from 'effect/Layer';
import * as Provider from 'alchemy/Provider';
import { Resource } from 'alchemy/Resource';
import { CloudflareApiLive } from 'alchemy/Cloudflare';

// Alchemy beta.83's Workflow resource omits concurrency and retention props.
// Apply these to the workflow it already owns; never provision a second one.
// The class defaults to EvidenceWorkflow with a concurrency of 2, the values applied before AiWorkflow existed.
interface Settings extends Resource<'Golf.WorkflowSettings', {
  accountId: string; workflowName: string; scriptName: string; steps: number; className?: 'EvidenceWorkflow' | 'AiWorkflow'; concurrency?: number;
}, { versionId: string }> {}
export const WorkflowSettings = Resource<Settings>('Golf.WorkflowSettings');
export const workflowSettingsProvider = () => Provider.succeed(WorkflowSettings, {
  diff: () => Effect.succeed({ action: 'update' as const }),
  reconcile: Effect.fn(function* ({ news }) {
    const observed = yield* Workflows.getWorkflow({ accountId: news.accountId, workflowName: news.workflowName });
    const { steps, className = 'EvidenceWorkflow', concurrency = 2, ...workflow } = news;
    if (observed.scriptName !== news.scriptName || observed.className !== className)
      return yield* Effect.fail(new Error('Workflow ownership differs'));
    const result = yield* Workflows.putWorkflow({ ...workflow, className,
      limits: { steps }, concurrency: { limit: concurrency },
      defaultRetention: { successRetention: '1 day', errorRetention: '1 day' } });
    return { versionId: result.versionId };
  }),
  delete: () => Effect.void,
}).pipe(Layer.provide(CloudflareApiLive()), Layer.orDie);
