// CI fixer (docs/AUTOMATIONS.md): when an Actions run fails, the tail of each failed job's log (stored with the run's secrets already
// masked, and Golf credentials masked again here) goes to a coding CLI on the automation's agent host as an agent task, and a
// successful task becomes a draft pull request. A failure on an open pull request is fixed against that pull request's head branch;
// a failure on the default branch first records an issue with the excerpt (the agent task needs an issue or pull request to work
// from). Failures on other branches, and on the proposal branches of agent tasks (golf-agent/…), are skipped: no fix loops.
import { clipBytes, fenced } from './text.mjs';
import { taskFailure, proposalBody } from './issue-to-pr.mjs';

export const ciLimits = { jobs: 3, lines: 80, jobBytes: 1200, excerptBytes: 3000 };

// The excerpt that goes into the agent's instructions and the issue: job names and the masked tail of their logs.
export function failureExcerpt(run, jobs) {
  if (!jobs.length) return `Run #${run.number} (${run.workflow_name}) failed; no failed job log was available.`;
  return clipBytes(`Run #${run.number} (${run.workflow_name}) failed at ${String(run.commit_id).slice(0, 12)} on ${run.ref}.\n\n` +
    jobs.map(job => `Job "${job.name}" failed${job.reason ? ` (${job.reason})` : ''}. Last lines of its log:\n${job.log || '(log unavailable)'}`).join('\n\n'), ciLimits.excerptBytes);
}
// Which branch the fix targets, or why the failure is skipped.
export function fixTarget(run, defaultBranch) {
  if (!String(run.ref).startsWith('refs/heads/') && !run.pull_number) return { skip: `Run #${run.number} did not run on a branch.` };
  const branch = run.pull_number ? run.head_ref.replace(/^refs\/heads\//, '') : run.ref.slice(11);
  if (branch.startsWith('golf-agent/')) return { skip: `Run #${run.number} ran on a coding agent's proposal branch; the CI fixer does not fix its own proposals.` };
  if (run.pull_number) return { kind: 'pull_request', number: run.pull_number };
  if (branch === defaultBranch) return { kind: 'issue' };
  // A push or manual run on some other branch: start() looks for an open pull request with that head branch.
  return { skip: `Run #${run.number} failed on ${branch}, which is neither the default branch nor the head of an open pull request.`, branch };
}

export const ciFixer = {
  id: 'ci-fixer', label: 'CI fixer', engines: 'cli', schedule: false,
  description: 'When an Actions run fails on the default branch or a pull request, a coding CLI on your agent host proposes a fix as a draft pull request.',
  events: ['pipeline.failed'], outputs: ['draft-pr', 'issue', 'comment'], targets: ['pipeline_run'],
  defaults: { name: 'CI fixer', events: ['pipeline.failed'], output: ['draft-pr', 'issue'], limits: { perDay: 10, concurrency: 1, maxOpenPRs: 3, dedupeWindow: 0 },
    instructions: 'Find the cause of the failure from the log and fix it. Do not disable or skip tests.' },
  opensPullRequests: true,
  dedupe: event => `pipeline_run:${event.runId}`,

  async start(ctx) {
    const failure = await ctx.pipelineFailure(Number(ctx.event.runId));
    if (!failure) return { skip: 'The pipeline run no longer exists.' };
    const { run, jobs } = failure;
    if (run.state !== 'FAILURE') return { skip: `Run #${run.number} is ${run.state.toLowerCase()}, not failed.` };
    let target = fixTarget(run, ctx.row.default_branch);
    if (target.branch) {
      const number = await ctx.openPullForBranch(target.branch);
      if (number) target = { kind: 'pull_request', number };
    }
    if (target.skip) return { skip: target.skip };
    const excerpt = failureExcerpt(run, jobs), outputs = {};
    let number = target.number;
    if (target.kind === 'pull_request') {
      const pull = await ctx.pull(number);
      if (pull.state !== 'ISSUE_STATE_OPEN') return { skip: `Pull request #${number} is not open.` };
      if (pull.head.commitId !== run.commit_id) return { skip: `Pull request #${number} moved past the failed commit ${String(run.commit_id).slice(0, 12)}.` };
      if (ctx.outputs.includes('comment')) outputs.commentId = await ctx.comment({ kind: 'pull_request', number, body: `Run #${run.number} (${run.workflow_name}) failed; a coding agent is working on a fix.`, verbatim: fenced(excerpt) });
    } else {
      if (!ctx.outputs.includes('issue')) return { skip: `Run #${run.number} failed on the default branch, but this automation may not open issues, and a coding agent needs an issue to work from.` };
      number = await ctx.createIssue({ title: `CI failed: ${run.workflow_name} on ${run.ref.slice(11)} (run #${run.number})`.slice(0, 200),
        body: `Run #${run.number} of ${run.workflow_name} failed at ${String(run.commit_id).slice(0, 12)}. The last lines of the failed jobs follow, with secrets masked.`, verbatim: fenced(excerpt) });
      outputs.issueNumber = number;
    }
    const task = await ctx.assignAgent({ kind: target.kind, number, instructions: `${ctx.instructions}\n\nThe Actions run that failed:\n\n${excerpt}` });
    return { wait: 'task', task, outputs };
  },

  async apply(ctx, { task }) {
    if (task.state !== 'SUCCEEDED') return task.state === 'NO_CHANGES' ? { outputs: { agentTaskId: task.id }, reason: taskFailure(task) } : { failed: taskFailure(task), outputs: { agentTaskId: task.id } };
    const outputs = { agentTaskId: task.id };
    if (ctx.outputs.includes('draft-pr')) outputs.pullNumber = await ctx.openProposal(task, { title: `Fix CI: ${task.target_title}`.slice(0, 200),
      body: proposalBody({ task, summary: ctx.taskSummary(task), source: `Proposed fix for a failed Actions run (${task.target_kind === 'pull_request' ? 'pull request' : 'issue'} #${task.target_number}). Opened by automation “${ctx.automation.name}”; review it before marking it ready.` }) });
    return { outputs, reason: outputs.pullNumber ? `Opened draft pull request #${outputs.pullNumber}.` : `Proposal branch ${task.branch} is ready.` };
  },
};
