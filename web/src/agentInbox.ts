// The agentic inbox (docs/AGENTIC_MODE.md "Inbox and intent summaries"): the shapes of POST /native/agent-inbox/read (inbox, summary)
// and /native/agent-inbox (summarize), and the optional land queue route the batch action uses when the Worker reports it.
import { nativeAPI } from './nativeAPI';
import type { LandingDecision } from './agenticMode';

type Target = { repository: { owner: string; name: string }; repositoryId: string };
export type InboxTask = { id: string; state: 'QUEUED' | 'CLAIMED' | 'RUNNING'; tool: string; model: string; host: string; requestedBy: string;
  target: { kind: 'issue' | 'pull_request'; number: number; title: string }; branch: string; createdAt: string; startedAt: string };
export type IntentSummary = { headCommitId: string; model: string; aiWritten: true; createdAt: string; intent: string; areas: string[]; risks: string[]; confidence: 'high' | 'medium' | 'low';
  coverage: { files: number; totalFiles: number; bytes: number; limitBytes: number; notReadCount: number; descriptionTruncated: boolean } };
export type InboxPull = { number: number; title: string; author: string; pullRequestId: string; origin: '' | 'person' | 'api-token' | 'agent-task'; headCommitId: string; baseCommitId: string;
  decision: LandingDecision | 'unavailable'; risk: '' | 'low' | 'normal' | 'sensitive'; reasons: string[]; sensitivePaths: string[]; conflicts: { path: string; reason: string }[];
  mergeable?: boolean; changedPathCount: number; checks: { passed: number; pending: number; failed: number }; intent: IntentSummary | null; landing: { state: string; updatedAt: string } | null };
export type InboxLanding = { id: string; pullRequestId: string; number: number; title: string; trigger: 'person' | 'policy'; actor: string; state: 'LANDED' | 'REVERTED'; method: string;
  headCommitId: string; landedCommitId: string; revertCommitId: string; createdAt: string; updatedAt: string };
export type Inbox = { repositoryId: string; enabled: boolean; feature: { allowed: boolean; reason: string }; generatedAt: string; limit: number;
  inProgress: InboxTask[]; readyToLand: InboxPull[]; needsPerson: InboxPull[]; landed: InboxLanding[]; landingHistory: 'available' | 'unavailable';
  pulls: { state: 'evaluated' | 'agentic_mode_off' | 'pull_requests_off'; reason: string; open: number; evaluated: number; evaluateLimit: number };
  truncated: { inProgress: boolean; pulls: boolean; landed: boolean }; summaries: { available: boolean; reason: string } };
type Pull = { number: number; pullRequestId: string; baseCommitId: string; headCommitId: string };
type RunView = { id: string; state: 'REQUESTED' | 'RESERVED' | 'SUCCEEDED' | 'UNKNOWN' | 'REFUSED'; refusal?: string } | null;
export type IntentRead = Pull & { summary: IntentSummary | null; run: RunView; inFlight: boolean; summaries: { available: boolean; reason: string } };
export type IntentRequest = Pull & { state: 'STORED' | 'RUNNING' | 'REFUSED'; summary: IntentSummary | null; run: RunView };

// Under 'agent-workspace' so the repository activity stream (agents, pulls, actions, source) refreshes it.
export const inboxKey = (userId: string, owner: string, name: string) => ['repository', userId, owner, name, 'agent-workspace', 'inbox'] as const;
export const readInbox = (target: Target, signal?: AbortSignal) => nativeAPI<Inbox>('/native/agent-inbox/read', { ...target, action: 'inbox' }, signal);
export const readIntent = (target: Target, number: number, signal?: AbortSignal) => nativeAPI<IntentRead>('/native/agent-inbox/read', { ...target, action: 'summary', number }, signal);
export const summarizeIntent = (target: Target, number: number) => nativeAPI<IntentRequest>('/native/agent-inbox', { ...target, action: 'summarize', number, idempotencyKey: crypto.randomUUID() });
// The land queue (AM-4 item 4) owns /native/land. The inbox calls it only while the Worker reports repository.agentic-landing ready.
export const landPull = (target: Target, pull: InboxPull) => nativeAPI<{ state?: string; message?: string }>('/native/land', { ...target, action: 'land', number: pull.number, headCommitId: pull.headCommitId, idempotencyKey: crypto.randomUUID() });

export const originLabels: Record<InboxPull['origin'], string> = { '': 'Unknown', person: 'A person', 'api-token': 'API token', 'agent-task': 'Agent task' };
export const taskStateLabels: Record<InboxTask['state'], string> = { QUEUED: 'Queued', CLAIMED: 'Claimed by host', RUNNING: 'Running' };
