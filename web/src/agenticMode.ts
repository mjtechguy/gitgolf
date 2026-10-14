// Agentic mode (docs/AGENTIC_MODE.md): the shapes of POST /native/agentic-mode and /native/agentic-mode/read.
import { nativeAPI } from './nativeAPI';

export type AgenticSettings = { enabled: boolean; lowRiskPaths: string[]; sensitivePaths: string[]; landWithoutPerson: boolean; requiredChecks: string[]; revertOnFailure: boolean; version: number; updatedBy: string; updatedAt: string };
export type AgenticState = { repositoryId: string; settings: AgenticSettings; feature: { allowed: boolean; reason: string; decidedBy: string }; canEdit: boolean; limits: { patterns: number; patternLength: number; checks: number; checkLength: number } };
export type LandingDecision = 'land' | 'needs_person' | 'waiting_checks' | 'blocked';
export type LandingEvaluation = { repositoryId: string; number: number; headCommitId: string; baseCommitId: string; mergeBaseCommitId: string; enabled: boolean; origin: 'person' | 'api-token' | 'agent-task';
  evaluation: { decision: LandingDecision; reasons: string[]; risk: 'low' | 'normal' | 'sensitive'; matched: { low: string[]; sensitive: string[] } };
  changedPathCount: number; checks: { name: string; kind: string; state: string }[]; mergeable: { ok: boolean; reason: string }; evaluatedAt: string; canLand?: boolean };
// Landing (POST /native/land and /native/land/read, schema 42): one row per attempt to land a pull request.
export type LandState = 'QUEUED' | 'LANDING' | 'LANDED' | 'NEEDS_REBASE' | 'BLOCKED' | 'FAILED' | 'REVERTED';
export type LandMethod = 'merge' | 'squash';
export type LandOperation = { id: string; repositoryId: string; pullRequestId: string; number: number; trigger: 'person' | 'policy'; actorId: string; actor: string; state: LandState; method: LandMethod;
  headCommitId: string; baseCommitId: string; landedCommitId: string; revertCommitId: string; attempts: number; createdAt: string; updatedAt: string;
  detail: { reasons?: string[]; conflicts?: { path: string; reason: string }[]; conflictCount?: number; postLand?: { verdict: string; checks: string[]; action?: string };
    revert?: { state: string; reason?: string; commitId?: string }; issue?: { number?: number; assignee?: string; skipped?: string } } };
type Target = { repository: { owner: string; name: string }; repositoryId: string };

export const agenticKey = (userId: string, owner: string, name: string) => ['native-agentic-mode', userId, owner, name] as const;
export const readAgentic = (target: Target, signal?: AbortSignal) => nativeAPI<AgenticState>('/native/agentic-mode/read', { ...target, action: 'get' }, signal);
export const evaluateLanding = (target: Target, number: number, signal?: AbortSignal) => nativeAPI<LandingEvaluation>('/native/agentic-mode/read', { ...target, action: 'evaluate', number }, signal);
export const saveAgentic = (target: Target, expectedVersion: number, settings: Omit<AgenticSettings, 'version' | 'updatedBy' | 'updatedAt'>) =>
  nativeAPI<AgenticState>('/native/agentic-mode', { ...target, action: 'set', expectedVersion, ...settings });

export const decisionLabels: Record<LandingDecision, string> = { land: 'May land now', needs_person: 'Needs a person', waiting_checks: 'Waiting for checks', blocked: 'Blocked' };
export const riskLabels = { low: 'Low risk', normal: 'Normal risk', sensitive: 'Sensitive' } as const;
export const landKey = (userId: string, owner: string, name: string) => ['native-land', userId, owner, name] as const;
export const listLands = (target: Target, options: { number?: number; limit?: number }, signal?: AbortSignal) =>
  nativeAPI<{ repositoryId: string; operations: LandOperation[]; limit: number }>('/native/land/read', { ...target, action: 'list', ...options }, signal);
// idempotencyKey: one per confirmation, so a retried request returns the original land operation.
export const landPull = (target: Target, number: number, headCommitId: string, method: LandMethod, idempotencyKey: string) =>
  nativeAPI<{ operation: LandOperation; phase: 'LANDED' | 'LANDING' | 'LAND_REFUSED' }>('/native/land', { ...target, action: 'land', number, headCommitId, method, idempotencyKey });
export const landStateLabels: Record<LandState, string> = { QUEUED: 'Queued', LANDING: 'Landing', LANDED: 'Landed', NEEDS_REBASE: 'Needs a rebase', BLOCKED: 'Blocked', FAILED: 'Failed', REVERTED: 'Reverted' };
// One line on what a land operation came to, from its stored detail.
export function landSummary(op: LandOperation) {
  const d = op.detail;
  if (op.state === 'REVERTED') return `Reverted automatically${op.revertCommitId ? ' with ' + op.revertCommitId.slice(0, 12) : ''}: required checks failed after landing (${(d.postLand?.checks || []).join(', ')}).`;
  if (op.state === 'NEEDS_REBASE') return `Conflicts with the base branch in ${(d.conflicts || []).map(c => c.path).join(', ') || 'some paths'}${(d.conflictCount || 0) > (d.conflicts || []).length ? ` and ${(d.conflictCount || 0) - (d.conflicts || []).length} more` : ''}.`;
  if (op.state === 'LANDED') {
    if (d.revert?.state === 'conflict') return 'Landed. Required checks then failed, and the revert conflicts with later changes; an issue was opened.';
    if (d.revert?.state === 'refused') return `Landed. Required checks then failed; it could not be reverted: ${d.revert.reason || 'refused'}.`;
    if (d.postLand?.verdict === 'failed') return `Landed. Required checks then failed: ${d.postLand.checks.join(', ')}.`;
    if (d.postLand?.verdict === 'passed') return 'Landed. Required checks passed on the base branch.';
    return 'Landed. Waiting for the required checks on the base branch.';
  }
  return (d.reasons || []).join('; ');
}
