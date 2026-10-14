// Agentic mode (docs/AGENTIC_MODE.md): the shapes of POST /native/agentic-mode and /native/agentic-mode/read.
import { nativeAPI } from './nativeAPI';

export type AgenticSettings = { enabled: boolean; lowRiskPaths: string[]; sensitivePaths: string[]; landWithoutPerson: boolean; requiredChecks: string[]; revertOnFailure: boolean; version: number; updatedBy: string; updatedAt: string };
export type AgenticState = { repositoryId: string; settings: AgenticSettings; feature: { allowed: boolean; reason: string; decidedBy: string }; canEdit: boolean; limits: { patterns: number; patternLength: number; checks: number; checkLength: number } };
export type LandingDecision = 'land' | 'needs_person' | 'waiting_checks' | 'blocked';
export type LandingEvaluation = { repositoryId: string; number: number; headCommitId: string; baseCommitId: string; mergeBaseCommitId: string; enabled: boolean; origin: 'person' | 'api-token' | 'agent-task';
  evaluation: { decision: LandingDecision; reasons: string[]; risk: 'low' | 'normal' | 'sensitive'; matched: { low: string[]; sensitive: string[] } };
  changedPathCount: number; checks: { name: string; kind: string; state: string }[]; mergeable: { ok: boolean; reason: string }; evaluatedAt: string };
type Target = { repository: { owner: string; name: string }; repositoryId: string };

export const agenticKey = (userId: string, owner: string, name: string) => ['native-agentic-mode', userId, owner, name] as const;
export const readAgentic = (target: Target, signal?: AbortSignal) => nativeAPI<AgenticState>('/native/agentic-mode/read', { ...target, action: 'get' }, signal);
export const evaluateLanding = (target: Target, number: number, signal?: AbortSignal) => nativeAPI<LandingEvaluation>('/native/agentic-mode/read', { ...target, action: 'evaluate', number }, signal);
export const saveAgentic = (target: Target, expectedVersion: number, settings: Omit<AgenticSettings, 'version' | 'updatedBy' | 'updatedAt'>) =>
  nativeAPI<AgenticState>('/native/agentic-mode', { ...target, action: 'set', expectedVersion, ...settings });

export const decisionLabels: Record<LandingDecision, string> = { land: 'May land now', needs_person: 'Needs a person', waiting_checks: 'Waiting for checks', blocked: 'Blocked' };
export const riskLabels = { low: 'Low risk', normal: 'Normal risk', sensitive: 'Sensitive' } as const;
