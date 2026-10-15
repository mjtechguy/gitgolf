// Agent hosts (docs/AGENT_HOSTS.md): the user API shapes the native Worker returns from /native/agent-hosts and /native/agent-tasks.
export type HostScopeName = 'personal' | 'organization' | 'installation';
export type HostScope = { scope: 'personal' } | { scope: 'organization'; organization: string } | { scope: 'installation' };
export type HostTool = { tool: string; version: string; signedIn: boolean | null; account?: string };
export type AgentHost = { id: string; uuid: string; name: string; scope: HostScopeName; scopeId: string; state: 'ACTIVE' | 'DISABLED'; online: boolean; lastSeenAt: string | null;
  shareSignins: boolean; allowedUsers: string[]; allowedRepositories: string[]; enabledTools: string[]; maxConcurrent: number; hostVersion: string; os: string; arch: string;
  tools: HostTool[]; activeTasks: number; version: number };
export type HostToken = { id: string; expiresAt: string; usesLeft: number };
export type HostInventory = { hosts: AgentHost[]; tokens: HostToken[]; canManage: boolean };

export type AvailableTool = { tool: string; version: string; signedIn: boolean | null; usable: boolean; reason: string };
export type AvailableHost = { id: string; name: string; scope: HostScopeName; kind?: 'agent' | 'ssh'; online: boolean; tools: AvailableTool[] };
export type Available = { hosts: AvailableHost[]; featureOn: boolean; reason: string };

export type TaskTarget = { kind: 'issue' | 'pull_request'; number: number; title?: string; url?: string };
export type TaskState = 'QUEUED' | 'CLAIMED' | 'RUNNING' | 'SUCCEEDED' | 'NO_CHANGES' | 'FAILED' | 'CANCELLED' | 'TIMED_OUT' | 'LOST';
export type TaskUsage = { inputTokens?: number; outputTokens?: number; costUsd?: number; reported?: boolean };
// requestedBy is { id, login }; a bare login is accepted too.
export type AgentTask = { id: string; state: TaskState; tool: string; model: string; mode?: 'change' | 'review'; host: { id: string; name: string; kind?: 'agent' | 'ssh' }; requestedBy: string | { id: string; login: string }; target: TaskTarget;
  branch: string; baseRef: string; baseCommit: string; commitId: string; changedFiles: string[]; summary: string; usage: TaskUsage | null; exitCode: number | null;
  failureReason: string; createdAt: string; claimedAt?: string | null; startedAt: string | null; finishedAt: string | null; deadline?: number | null; logLines: number; logTruncated?: boolean; cancelRequested?: boolean };
export type TaskLog = { lines: string[]; nextOffset: number; complete: boolean; truncated: boolean; state?: TaskState };

export const tools = ['codex', 'claude', 'opencode', 'grok'] as const;
export const toolLabels: Record<string, string> = { codex: 'Codex', claude: 'Claude Code', opencode: 'OpenCode', grok: 'Grok' };
export const toolLabel = (tool: string) => toolLabels[tool] || tool;
export const scopeLabels: Record<string, string> = { personal: 'Personal', organization: 'Organization', installation: 'Installation' };
export const signedInLabel = (value: boolean | null | undefined) => value === true ? 'signed in' : value === false ? 'not signed in' : 'sign-in unknown';

export const activeTask = (state: string) => state === 'QUEUED' || state === 'CLAIMED' || state === 'RUNNING';
export const taskStateLabels: Record<string, string> = { QUEUED: 'Queued', CLAIMED: 'Starting', RUNNING: 'Running', SUCCEEDED: 'Proposal ready', NO_CHANGES: 'No changes',
  FAILED: 'Failed', CANCELLED: 'Cancelled', TIMED_OUT: 'Timed out', LOST: 'Lost' };
// The pipeline state icons already carry the colours for these outcomes.
export const pipelineState = (state: string) => ({ QUEUED: 'QUEUED', CLAIMED: 'RUNNING', RUNNING: 'RUNNING', SUCCEEDED: 'SUCCESS', NO_CHANGES: 'SKIPPED', FAILED: 'FAILURE', CANCELLED: 'CANCELLED', TIMED_OUT: 'FAILURE', LOST: 'FAILURE' } as Record<string, string>)[state] || 'PENDING';
// failureReason is a Worker code (docs/AGENT_HOSTS.md) or the host's own failure text.
const failures: Record<string, string> = {
  proposal_unverified: 'The host reported a commit that Golf could not verify on the task branch, so no proposal was recorded.',
  timed_out: 'The task ran past its deadline and was stopped.', lost: 'The host stopped calling in for more than three minutes while running this task.',
  host_deleted: 'The host was deleted before it picked the task up.', cancelled: 'The task was cancelled before a host picked it up.',
  ssh_dispatch_failed: 'Golf could not start the connection to the SSH host for this task.', ssh_runner_lost: 'The connection Golf ran to the SSH host stopped before the task finished.',
};
// refused_<code>: the task no longer passed the admission rules when the host claimed it.
const refusals: Record<string, string> = {
  feature_off: 'coding agents on your machines are turned off for this repository', not_writer: 'the requester can no longer write to this repository',
  host_unavailable: 'the host is disabled or deleted', host_scope: 'the host’s scope no longer covers this repository', not_allowed: 'the requester is no longer allowed on this host',
  repository_not_allowed: 'the host no longer allows this repository', tool_disabled: 'the tool is turned off on this host', tool_missing: 'the host no longer reports the tool as installed',
  tool_signed_out: 'the tool is not signed in on the host', repository_unavailable: 'the repository is not available',
};
export function failureText(task: Pick<AgentTask, 'state' | 'failureReason' | 'exitCode'>) {
  const reason = task.failureReason, refused = /^refused_(.+)$/.exec(reason);
  if (refused) return `Refused when the host claimed it: ${refusals[refused[1]!] || refused[1]!.replaceAll('_', ' ')}.`;
  if (failures[reason]) return failures[reason]!;
  if (reason) return `The host reported: ${reason}`;
  return task.state === 'TIMED_OUT' ? failures.timed_out! : task.state === 'LOST' ? failures.lost! : task.state === 'FAILED' ? `The tool failed${task.exitCode !== null && task.exitCode !== undefined ? ` with exit code ${task.exitCode}` : ''} and made no proposal.` : '';
}
export const requesterLogin = (task: Pick<AgentTask, 'requestedBy'>) => typeof task.requestedBy === 'string' ? task.requestedBy : task.requestedBy?.login || 'Unknown';
export const branchName = (ref: string) => ref.replace(/^refs\/heads\//, '');
export const targetLabel = (target: TaskTarget) => `${target.kind === 'pull_request' ? 'Pull request' : 'Issue'} #${target.number}`;

// SSH hosts (docs/SSH_HOSTS.md): the shapes /native/ssh-hosts returns. An SSH host is an agent host Golf reaches itself.
export type SSHReach = 'direct' | 'tailscale' | 'cloudflare-tunnel' | 'workers-vpc';
export const reaches: SSHReach[] = ['direct', 'tailscale', 'cloudflare-tunnel', 'workers-vpc'];
export const reachLabels: Record<SSHReach, string> = { direct: 'Direct', tailscale: 'Tailscale', 'cloudflare-tunnel': 'Cloudflare Tunnel', 'workers-vpc': 'Workers VPC' };
export type SSHProbe = { state: 'NONE' | 'RUNNING' | 'SUCCEEDED' | 'FAILED'; startedAt: string; finishedAt: string; offered: { key: string; type: string; fingerprint: string } | null;
  matched: boolean | null; authenticated: boolean | null; os: string; arch: string; toolCount: number; error: string };
export type SSHHost = AgentHost & { kind: 'ssh'; address: string; port: number; user: string; workDirectory: string; reach: SSHReach; reachAvailable: boolean; reachReason: string;
  tailscale: { tags: string[]; ephemeral: boolean; authKeySet: boolean } | null; tunnel: { clientId: string; clientSecretSet: boolean } | null;
  publicKey?: string; keyFingerprint: string; hostKey: { pinned: boolean; fingerprint: string; type: string; pinnedAt: string; pinnedBy: string }; probe: SSHProbe; ready: boolean; readyReason: string };
export type SSHInventory = { hosts: SSHHost[]; canManage: boolean; capability: { id: string; state: string; reason: string }; reaches: Record<SSHReach, { available: boolean; reason: string }> };
export type SSHKeyResult = { host: SSHHost; publicKey: string; authorizedKey: string; installCommand: string };
