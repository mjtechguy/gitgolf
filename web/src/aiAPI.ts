import { nativeAPI } from './nativeAPI';

// Workers AI runs on the native forge. A run belongs to the person who asked for it; its output is advisory and untrusted.
export type AiRunState = 'REQUESTED' | 'RESERVED' | 'SUCCEEDED' | 'UNKNOWN' | 'REFUSED';
export type AiRun<Target = unknown, Output = unknown> = { id: string; kind: string; idempotencyKey: string; state: AiRunState; target: Target; model: string;
  output?: Output; usage?: Record<string, number>; refusal?: string; inputSha256: string; stale?: boolean;
  createdAt: string; updatedAt: string; expiresAt: string; advisoryOnly: true };
type Context = { repository: { owner: string; name: string }; repositoryId: string };

export const aiRunPending = (run?: AiRun) => run?.state === 'REQUESTED' || run?.state === 'RESERVED';
export function createAiRun<Target, Output>(context: Context, kind: string, target: Target, idempotencyKey: string) {
  return nativeAPI<{ run: AiRun<Target, Output> }>('/native/ai', { ...context, action: 'create', kind, target, idempotencyKey });
}
export function aiRunStatus<Target, Output>(context: Context, runId: string, signal?: AbortSignal) {
  return nativeAPI<{ run: AiRun<Target, Output> }>('/native/ai/read', { ...context, action: 'status', runId }, signal);
}
// Stored rows only, newest first: list entries carry no current or out-of-date claim.
export function listAiRuns<Target, Output>(context: Context, filter: { kind?: string; target?: Target } = {}, signal?: AbortSignal) {
  return nativeAPI<{ runs: AiRun<Target, Output>[]; truncated: boolean }>('/native/ai/read', { ...context, action: 'list', ...filter }, signal);
}
