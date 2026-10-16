// The agentic inbox (docs/AGENTIC_MODE.md "Inbox and intent summaries"): the shapes of POST /native/agent-inbox/read (inbox, summary)
// and /native/agent-inbox (summarize), and the optional land queue route the batch action uses when the Worker reports it.
import { nativeAPI } from './nativeAPI';
import type { LandingDecision, LandMethod, LandOperation } from './agenticMode';
import type { LandAnswer } from './landOutcomes';

type Target = { repository: { owner: string; name: string }; repositoryId: string };
export type InboxTask = { id: string; state: 'QUEUED' | 'CLAIMED' | 'RUNNING'; tool: string; model: string; host: string; requestedBy: string;
  target: { kind: 'issue' | 'pull_request'; number: number; title: string }; branch: string; createdAt: string; startedAt: string };
export type IntentSummary = { headCommitId: string; model: string; aiWritten: true; createdAt: string; intent: string; areas: string[]; risks: string[]; confidence: 'high' | 'medium' | 'low';
  coverage: { files: number; totalFiles: number; bytes: number; limitBytes: number; notReadCount: number; descriptionTruncated: boolean } };
export type InboxPull = { number: number; title: string; author: string; pullRequestId: string; origin: '' | 'person' | 'api-token' | 'agent-task'; headCommitId: string; baseCommitId: string;
  decision: LandingDecision | 'unavailable'; risk: '' | 'low' | 'normal' | 'sensitive'; reasons: string[]; sensitivePaths: string[]; conflicts: { path: string; reason: string }[];
  mergeable?: boolean; changedPathCount: number; checks: { passed: number; pending: number; failed: number }; intent: IntentSummary | null; landing: { state: string; updatedAt: string } | null;
  // Whether this caller may land it now through the land queue (the policy says land, or asks only for a writer who is not the author).
  canLand?: boolean };
export type InboxRevert = { state: string; trigger: 'person' | 'policy'; actor: string; reason: string; conflicts: string[] };
export type InboxLanding = { id: string; pullRequestId: string; number: number; title: string; trigger: 'person' | 'policy'; actor: string; state: 'LANDED' | 'REVERTED'; method: string;
  headCommitId: string; landedCommitId: string; revertCommitId: string; revert?: InboxRevert | null; createdAt: string; updatedAt: string };
export type Inbox = { repositoryId: string; enabled: boolean; feature: { allowed: boolean; reason: string }; generatedAt: string; limit: number;
  inProgress: InboxTask[]; readyToLand: InboxPull[]; needsPerson: InboxPull[]; landed: InboxLanding[]; landingHistory: 'available' | 'unavailable';
  pulls: { state: 'evaluated' | 'agentic_mode_off' | 'pull_requests_off'; reason: string; open: number; evaluated: number; evaluateLimit: number };
  truncated: { inProgress: boolean; pulls: boolean; landed: boolean }; summaries: { available: boolean; reason: string };
  actions?: { land: boolean; revert: boolean; reason: string } };
type Pull = { number: number; pullRequestId: string; baseCommitId: string; headCommitId: string };
type RunView = { id: string; state: 'REQUESTED' | 'RESERVED' | 'SUCCEEDED' | 'UNKNOWN' | 'REFUSED'; refusal?: string } | null;
export type IntentRead = Pull & { summary: IntentSummary | null; run: RunView; inFlight: boolean; summaries: { available: boolean; reason: string } };
export type IntentRequest = Pull & { state: 'STORED' | 'RUNNING' | 'REFUSED'; summary: IntentSummary | null; run: RunView };

// Under 'agent-workspace' so the repository activity stream (agents, pulls, actions, source) refreshes it.
export const inboxKey = (userId: string, owner: string, name: string) => ['repository', userId, owner, name, 'agent-workspace', 'inbox'] as const;
export const readInbox = (target: Target, signal?: AbortSignal) => nativeAPI<Inbox>('/native/agent-inbox/read', { ...target, action: 'inbox' }, signal);
export const readIntent = (target: Target, number: number, signal?: AbortSignal) => nativeAPI<IntentRead>('/native/agent-inbox/read', { ...target, action: 'summary', number }, signal);
export const summarizeIntent = (target: Target, number: number) => nativeAPI<IntentRequest>('/native/agent-inbox', { ...target, action: 'summarize', number, idempotencyKey: crypto.randomUUID() });
// The land queue (land-queue.mjs) owns /native/land; the inbox calls it only while the Worker reports repository.agentic-landing ready.
// Batch landing is one land request per pull request, exactly as the pull request's Land button sends it: the head the inbox evaluated
// and one idempotency key per pull request and confirmation, so a retried batch replays each original operation.
export const landSelected = (target: Target, pull: Pick<InboxPull, 'number' | 'headCommitId'>, method: LandMethod, idempotencyKey: string) =>
  nativeAPI<LandAnswer>('/native/land', { ...target, action: 'land', number: pull.number, headCommitId: pull.headCommitId, method, idempotencyKey });
// A person's revert of a landing: the land operation, its pull request and landed commit as the inbox showed them, an optional reason and
// one idempotency key per confirmation.
export type RevertAnswer = { operation: LandOperation; phase: 'REVERTED' | 'REVERTING' | 'REVERT_REFUSED'; revert: { state: string; reason?: string; conflicts?: { path: string; reason: string }[] } | null };
export const revertLanding = (target: Target, item: Pick<InboxLanding, 'id' | 'number' | 'landedCommitId'>, reason: string, idempotencyKey: string) =>
  nativeAPI<RevertAnswer>('/native/land', { ...target, action: 'revert', id: item.id, number: item.number, landedCommitId: item.landedCommitId, ...(reason.trim() ? { reason: reason.trim() } : {}), idempotencyKey });
// The branch list's agent branch patterns, and whether Golf deletes agent branches after their pull request lands or closes.
export type AgentBranches = { repositoryId: string; defaultBranch: string; patterns: string[]; cleanup: boolean };
export const readAgentBranches = (target: Target, signal?: AbortSignal) => nativeAPI<AgentBranches>('/native/agent-inbox/read', { ...target, action: 'branches' }, signal);

export const originLabels: Record<InboxPull['origin'], string> = { '': 'Unknown', person: 'A person', 'api-token': 'API token', 'agent-task': 'Agent task' };
export const taskStateLabels: Record<InboxTask['state'], string> = { QUEUED: 'Queued', CLAIMED: 'Claimed by host', RUNNING: 'Running' };
