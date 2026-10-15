// Issue → PR (docs/AUTOMATIONS.md): "Assign to agent" without a person pressing it. The issue becomes an agent task (agent-hosts.mjs:
// the same admission rules, prompt, proposal branch and live log) on the automation's agent host and coding CLI; when the task
// succeeds Golf opens a draft pull request from its proposal branch into the default branch, as the task's "Open pull request" does.
// Never merged: a draft needs a person under every landing policy. Only with allowLanding, and only where agentic mode is on, is it
// opened ready for review so that the repository's landing policy decides.
import { clipBytes } from './text.mjs';

export const agentFinished = { NO_CHANGES: 'The coding agent made no changes', FAILED: 'The agent task failed', CANCELLED: 'The agent task was cancelled', TIMED_OUT: 'The agent task timed out', LOST: 'The agent host stopped reporting' };
// The task's failure, in words (the reason code or the host's own masked failure text).
export function taskFailure(task) {
  return `${agentFinished[task.state] || 'The agent task ended'}${task.failure_reason ? ` (${clipBytes(task.failure_reason, 300)})` : ''}.`;
}
// Draft pull request text: the agent's summary is model output, neutralized by the caller like every automation text.
export function proposalBody({ task, summary, source }) {
  return [`${source}`, summary ? `Summary from the coding agent (${task.tool}, unverified):\n\n${clipBytes(summary, 3000)}` : 'The coding agent gave no summary.',
    `Proposal branch \`${task.branch}\` at \`${String(task.commit_id).slice(0, 12)}\` from agent task ${task.id}.`].join('\n\n');
}

export const issueToPR = {
  id: 'issue-to-pr', label: 'Issue → PR', engines: 'cli', schedule: false,
  description: 'Turns new issues into draft pull requests: a coding CLI on your agent host implements the issue on a proposal branch.',
  events: ['issue.opened'], outputs: ['draft-pr', 'comment'], targets: ['issue'],
  defaults: { name: 'Issue → PR', events: ['issue.opened'], output: ['draft-pr'], limits: { perDay: 10, concurrency: 1, maxOpenPRs: 3, dedupeWindow: 0 },
    instructions: 'Implement the issue with the smallest change that solves it, and add or update tests.' },
  opensPullRequests: true,
  dedupe: event => `issue:${event.number}`,

  async start(ctx) {
    const issue = await ctx.issue(ctx.run.target_number);
    if (issue.state !== 'ISSUE_STATE_OPEN') return { skip: `Issue #${issue.number} is closed.` };
    return { wait: 'task', task: await ctx.assignAgent({ kind: 'issue', number: issue.number, instructions: ctx.instructions }) };
  },

  async apply(ctx, { task }) {
    if (task.state !== 'SUCCEEDED') return task.state === 'NO_CHANGES' ? { outputs: { agentTaskId: task.id }, reason: taskFailure(task) } : { failed: taskFailure(task), outputs: { agentTaskId: task.id } };
    const outputs = { agentTaskId: task.id };
    if (ctx.outputs.includes('draft-pr')) {
      const issue = await ctx.issue(task.target_number);
      outputs.pullNumber = await ctx.openProposal(task, { title: `Draft: ${issue.title}`, body: proposalBody({ task, summary: ctx.taskSummary(task), source: `Implements issue #${issue.number}. Opened by automation “${ctx.automation.name}” from a coding agent's proposal branch; review it before marking it ready.` }) });
    }
    if (ctx.outputs.includes('comment')) outputs.commentId = await ctx.comment({ kind: 'issue', number: task.target_number,
      body: outputs.pullNumber ? `A coding agent proposed a change for this issue: draft pull request #${outputs.pullNumber}.` : `A coding agent proposed a change for this issue on branch \`${task.branch}\`.` });
    return { outputs, reason: outputs.pullNumber ? `Opened draft pull request #${outputs.pullNumber}.` : `Proposal branch ${task.branch} is ready.` };
  },
};
