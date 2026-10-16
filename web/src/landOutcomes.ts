// What one land request of the inbox's batch came to (land-queue.mjs answers { operation, phase }): landed, queued (sent, outcome pending),
// needs a rebase (with the paths), blocked or failed (with the land queue's reasons), refused before anything was recorded (the Worker's
// message) or unknown (no answer). Pure, so node --test reads it.
import type { LandOperation } from './agenticMode';

export type LandAnswer = { operation: LandOperation; phase: 'LANDED' | 'LANDING' | 'LAND_REFUSED' };
export type LandOutcome = { number: number; kind: 'landed' | 'queued' | 'needs_rebase' | 'blocked' | 'failed' | 'refused' | 'unknown'; text: string };
export const outcomeLabels: Record<LandOutcome['kind'], string> = { landed: 'Landed', queued: 'Queued', needs_rebase: 'Needs a rebase', blocked: 'Blocked', failed: 'Failed', refused: 'Refused', unknown: 'Unknown' };

export function landOutcome(number: number, answer: LandAnswer | undefined, error?: unknown): LandOutcome {
  if (!answer) {
    // A native API refusal is a ConnectError: its rawMessage is the Worker's own words.
    const failure = error as { httpStatus?: number; rawMessage?: string } | undefined, status = failure?.httpStatus;
    const text = typeof failure?.rawMessage === 'string' && failure.rawMessage ? failure.rawMessage : error instanceof Error ? error.message : 'No answer.';
    return status && status < 500 ? { number, kind: 'refused', text: `Refused: ${text}` }
      : { number, kind: 'unknown', text: `Outcome unknown: ${text} Refresh before trying again; the same request is replayed, not repeated.` };
  }
  const op = answer.operation, d = op.detail || {}, reasons = (d.reasons || []).join('; ');
  if (op.state === 'LANDED') return { number, kind: 'landed', text: `Landed${op.landedCommitId ? ' as ' + op.landedCommitId.slice(0, 12) : ''}.` };
  if (op.state === 'QUEUED' || op.state === 'LANDING') return { number, kind: 'queued', text: `Queued: ${reasons || 'the merge was sent; maintenance confirms its outcome.'}` };
  if (op.state === 'NEEDS_REBASE') {
    const paths = (d.conflicts || []).map(c => c.path), more = (d.conflictCount || 0) - paths.length;
    return { number, kind: 'needs_rebase', text: `Needs a rebase: conflicts with the base branch in ${paths.join(', ') || 'some paths'}${more > 0 ? ` and ${more} more` : ''}.` };
  }
  return { number, kind: op.state === 'FAILED' ? 'failed' : 'blocked', text: `${op.state === 'FAILED' ? 'Failed' : 'Blocked'}: ${reasons || 'the land queue refused it.'}` };
}
