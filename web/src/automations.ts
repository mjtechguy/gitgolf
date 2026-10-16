// Automations (docs/AUTOMATIONS.md): the shapes of POST /native/automations and /native/automations/read.
import { nativeAPI } from './nativeAPI';

export type AutomationScopeName = 'repository' | 'organization' | 'installation';
export type AutomationTarget = { scope: 'repository'; repository: { owner: string; name: string }; repositoryId: string } | { scope: 'organization'; organization: string } | { scope: 'installation' };
export type ToolId = 'pr-reviewer' | 'issue-triage' | 'issue-to-pr' | 'ci-fixer' | 'custom';
export type Place = 'cloud' | 'agent-host' | 'ssh-host';
export type Limits = { perDay: number; concurrency: number; maxOpenPRs: number; dedupeWindow: number };
export type Trigger = { events: string[]; schedule?: { everyMinutes: number } | null };
export type RunState = 'QUEUED' | 'RUNNING' | 'SUCCEEDED' | 'FAILED' | 'SKIPPED' | 'REFUSED';
export type Automation = { id: string; scope: AutomationScopeName; scopeId: string; scopeName: string; tool: string; toolLabel: string; name: string; enabled: boolean; killSwitch: boolean;
  trigger: Trigger; target: { repositories: string[]; branches: string[]; paths: string[] }; engine: string; place: Place; hostId: string; hostName: string; output: string[]; limits: Limits;
  approvals: { draftOnly: true; allowLanding: boolean }; instructionsVersion: number; version: number; owner: { id: string; login: string }; createdBy: string; updatedBy: string;
  createdAt: string; updatedAt: string; nextRunAt: string; stats: { today: number; running: number; queued: number; last: { state: RunState; reason: string; at: string } | null } };
export type InstructionVersion = { version: number; createdBy: string; createdAt: string; current: boolean };
export type AutomationDetail = { automation: Automation & { instructions: string }; instructionVersions: InstructionVersion[] };
export type InstructionsText = InstructionVersion & { text: string };
// targets is not part of the catalogue today; runKinds below falls back to what each built-in accepts.
export type Tool = { id: ToolId; label: string; description: string; engines: 'model' | 'cli' | 'any'; schedule: boolean; events: string[]; outputs: string[]; cliOutputs?: string[]; opensPullRequests: boolean;
  targets?: string[]; defaults: { name: string; events: string[]; output: string[]; limits: Limits; instructions: string } };
export type Engine = { id: string; kind: 'model' | 'cli'; label: string; detail: string };
export type AutomationHost = { id: string; name: string; scope: string };
export type Inventory = { scope: { scope: AutomationScopeName; scopeId: string; name: string }; canManage: boolean; featureOn: boolean; featureReason: string; automations: Automation[];
  inherited: Automation[]; inheritedTruncated?: boolean; tools: Tool[]; engines: Engine[]; enginesRegistered: boolean; hosts: AutomationHost[]; places: Record<Place, string> };
export type Review = { summary: string; findings: { path: string; line: number | null; severity: string; title: string; evidence: string; suggestion: string }[]; markdown: string };
export type RunOutputs = { aiRunId?: string; agentTaskId?: string; commentId?: string; pullNumber?: number; pullUrl?: string; issueNumber?: number; issueUrl?: string; labels?: string[];
  suggestions?: { labelId?: string; name: string; probability?: number | null }[]; duplicates?: number[] | null; review?: Review; report?: string };
export type Run = { id: string; automationId: string; automationName: string; tool: string; repository: string; trigger: string; target: { kind: string; number: number | null; commit: string; url: string };
  state: RunState; phase: string; reason: string; engine: string; place: Place; instructionsVersion: number; requestedBy: string;
  usage: { inputTokens?: number; outputTokens?: number; costUsd?: number; reported?: boolean } | null; outputs: RunOutputs; createdAt: string; startedAt: string; finishedAt: string };
// What a create or update sends; omitted fields keep the tool's defaults (create) or the current values (update).
export type Definition = { name: string; trigger: Trigger; target: { repositories?: string[]; branches: string[]; paths: string[] }; engine: string; place: Place; hostId: string;
  instructions: string; output: string[]; limits: Limits; approvals: { allowLanding: boolean } };
export type RunTarget = { repository?: { owner: string; name: string }; kind: 'issue' | 'pull_request' | 'pipeline_run' | 'repository'; number?: number; runId?: string };

export const automationsKey = (userId: string, target: AutomationTarget) => ['native-automations', userId, JSON.stringify(target)] as const;
const read = <T>(target: AutomationTarget, body: object, signal?: AbortSignal) => nativeAPI<T>('/native/automations/read', { ...target, ...body }, signal);
const write = <T>(target: AutomationTarget, body: object) => nativeAPI<T>('/native/automations', { ...target, ...body });
export const listAutomations = (target: AutomationTarget, signal?: AbortSignal) => read<Inventory>(target, { action: 'list' }, signal);
export const getAutomation = (target: AutomationTarget, id: string, signal?: AbortSignal) => read<AutomationDetail>(target, { action: 'get', id }, signal);
export const readInstructions = (target: AutomationTarget, id: string, version: number, signal?: AbortSignal) => read<InstructionsText>(target, { action: 'instructions', id, version }, signal);
export const listRuns = (target: AutomationTarget, signal?: AbortSignal) => read<{ runs: Run[]; truncated: boolean }>(target, { action: 'runs' }, signal);
export const createAutomation = (target: AutomationTarget, tool: string, definition: Definition) => write<{ automation: Automation }>(target, { action: 'create', tool, ...definition });
export const updateAutomation = (target: AutomationTarget, id: string, expectedVersion: number, definition: Definition) => write<{ automation: Automation }>(target, { action: 'update', id, expectedVersion, ...definition });
export const setAutomationEnabled = (target: AutomationTarget, a: Automation, enabled: boolean) => write<{ automation: Automation }>(target, { action: 'setEnabled', id: a.id, expectedVersion: a.version, enabled });
export const setKillSwitch = (target: AutomationTarget, id: string, engaged: boolean) => write<{ automation: Automation }>(target, { action: 'killSwitch', id, engaged });
export const deleteAutomation = (target: AutomationTarget, id: string) => write<{ ok: true }>(target, { action: 'delete', id });
export const runAutomation = (target: AutomationTarget, id: string, runTarget: RunTarget) => write<{ run: Run }>(target, { action: 'run', id, target: runTarget });

export const eventLabels: Record<string, string> = { 'pull_request.opened': 'Pull request opened', 'pull_request.updated': 'Pull request updated', 'pull_request.review_requested': 'Review requested',
  'issue.opened': 'Issue opened', 'pipeline.failed': 'Actions run failed', push: 'Push' };
export const outputLabels: Record<string, [string, string]> = {
  comment: ['Comment', 'A comment on the issue or pull request.'], review: ['Private review draft', 'A review draft only its owner sees until they publish it.'],
  labels: ['Labels', 'Applies one of the repository’s own labels.'], issue: ['Issue', 'Opens an issue with the result.'],
  'draft-pr': ['Draft pull request', 'A draft pull request a person reviews; automations never merge.'], report: ['Report', 'Text kept on the run, shown below.'] };
export const placeLabels: Record<Place, string> = { cloud: 'Cloud', 'agent-host': 'Agent host', 'ssh-host': 'SSH host' };
export const runStateLabels: Record<RunState, string> = { QUEUED: 'Queued', RUNNING: 'Running', SUCCEEDED: 'Succeeded', FAILED: 'Failed', SKIPPED: 'Skipped', REFUSED: 'Refused' };
// The shared run-state colours: succeeded, failed or muted.
export const runStateClass = (state: string) => `run-state run-state-${state === 'SUCCEEDED' ? 'succeeded' : state === 'FAILED' || state === 'REFUSED' ? 'failed' : 'queued'}`;
export const targetKindLabels: Record<RunTarget['kind'], string> = { issue: 'Issue', pull_request: 'Pull request', pipeline_run: 'Actions run', repository: 'The repository (open work)' };
export const triggerLabels: Record<string, string> = { manual: 'Run now', schedule: 'Schedule', ...eventLabels };
export const limitBounds: Record<keyof Limits, [number, number]> = { perDay: [1, 500], concurrency: [1, 10], maxOpenPRs: [0, 50], dedupeWindow: [0, 10080] };
export const scheduleBounds = [15, 10080] as const;
export const instructionsLimit = 4000;

// What Run now may target: the tool's targets, and the repository itself for tools that run on a schedule.
const builtInTargets: Record<string, RunTarget['kind'][]> = { 'pr-reviewer': ['pull_request'], 'issue-triage': ['issue'], 'issue-to-pr': ['issue'], 'ci-fixer': ['pipeline_run'], custom: ['issue', 'pull_request', 'repository'] };
export function runKinds(tool: Tool | undefined, toolId: string): RunTarget['kind'][] {
  const kinds = (tool?.targets || builtInTargets[toolId] || ['issue', 'pull_request', 'pipeline_run', 'repository']) as RunTarget['kind'][];
  return [...new Set([...kinds, ...(tool?.schedule ? ['repository' as const] : [])])];
}
// Custom automations: a model writes a comment, an issue or a report; a coding CLI opens a draft pull request. Other tools may name
// what a coding CLI can produce (the PR reviewer's read-only review is a comment only).
export function allowedOutputs(tool: Tool, engineKind: Engine['kind'] | undefined) {
  return tool.id === 'custom' ? engineKind === 'cli' ? ['draft-pr'] : ['comment', 'issue', 'report'] : engineKind === 'cli' && tool.cliOutputs ? tool.cliOutputs : tool.outputs;
}
export const enginesFor = (tool: Tool, engines: Engine[]) => engines.filter(engine => tool.engines === 'any' || engine.kind === tool.engines);
export const scheduleText = (minutes: number) => minutes % 1440 === 0 ? `every ${minutes / 1440 === 1 ? 'day' : `${minutes / 1440} days`}` : minutes % 60 === 0 ? `every ${minutes / 60 === 1 ? 'hour' : `${minutes / 60} hours`}` : `every ${minutes} minutes`;
export const triggerText = (trigger: Trigger) => [...trigger.events.map(event => eventLabels[event] || event), ...(trigger.schedule ? [`Schedule, ${scheduleText(trigger.schedule.everyMinutes)}`] : [])].join(', ') || 'Run now only';
