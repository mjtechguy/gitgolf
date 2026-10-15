// PR reviewer (docs/AUTOMATIONS.md): a summary and findings on new-side lines of a pull request, from the AI review draft contract
// (ai-review.mjs). With the default engine it is an AI review-draft run of the automation's owner, so the draft also appears in that
// person's AI review panel on the pull request, to edit and publish as their own pending review. A comment output posts the
// neutralized review text. One run per pull request head: a new push re-reviews, an unchanged head is skipped by the dedupe key.
// A coding CLI (Claude Code under its own sign-in, on an agent host or SSH host) reviews as a read-only agent task (agent-hosts.mjs
// review mode): it commits nothing, and its final text is posted as the comment. It has no structured findings, so no review draft.
import { preparePullDiff, reviewLimits, reviewMessages, reviewOutput, reviewSchema } from '../ai-review.mjs';
import { taskFailure } from './issue-to-pr.mjs';
import { clipBytes } from './text.mjs';

export const prReviewer = {
  id: 'pr-reviewer', label: 'PR reviewer', engines: 'any', schedule: true,
  description: 'Reviews pull requests when they open or change: a summary and findings on changed lines, as a private review draft its owner publishes, or a comment.',
  events: ['pull_request.opened', 'pull_request.updated', 'pull_request.review_requested'], outputs: ['review', 'comment'], cliOutputs: ['comment'], targets: ['pull_request'],
  defaults: { name: 'PR reviewer', events: ['pull_request.opened', 'pull_request.updated'], output: ['review'], limits: { perDay: 50, concurrency: 2, maxOpenPRs: 0, dedupeWindow: 0 },
    instructions: 'Report concrete bugs, security issues and missing error handling. Skip style.' },
  useCase: 'review-drafts',
  // The same head is reviewed once (per dedupe window); a new head is a new key.
  dedupe: event => `pull_request:${event.number}:${event.headCommit || ''}`,

  async start(ctx) {
    const pull = await ctx.pull(ctx.run.target_number);
    if (pull.state !== 'ISSUE_STATE_OPEN' || pull.merged) return { skip: `Pull request #${pull.number} is not open.` };
    if (ctx.run.target_commit && pull.head.commitId !== ctx.run.target_commit) return { skip: `Pull request #${pull.number} moved past ${ctx.run.target_commit.slice(0, 12)}; the newer head has its own run.` };
    // A coding CLI reviews the head read-only on the automation's host; apply() posts its final text.
    if (ctx.cli) return { wait: 'task', task: await ctx.assignAgent({ kind: 'pull_request', number: pull.number, instructions: ctx.instructions, mode: 'review' }) };
    const target = { number: pull.number, pullRequestId: pull.id, baseCommitId: pull.base.commitId, headCommitId: pull.head.commitId };
    if (ctx.engine === 'default') return { wait: 'ai', aiRun: await ctx.aiRun('review-draft', target) };
    // A registry engine: the same bounded diff, read now in the workspace, then one chat outside it.
    return { infer: await preparePullDiff(reviewLimits.diffBytes)({ db: ctx.db, env: ctx.env, person: ctx.person, row: ctx.row, artifact: ctx.artifact, target }) };
  },
  engineRequest: input => ({ messages: reviewMessages(input), options: { responseFormat: { type: 'json_schema', json_schema: { name: 'review_draft', strict: true, schema: reviewSchema } }, maxTokens: 3000, reasoningEffort: 'low' } }),
  engineParse: (text, input) => reviewOutput({ response: text }, input),

  // output: the review-draft output (summary, findings, markdown), already neutralized by reviewOutput; task: a CLI's review task.
  async apply(ctx, { output, task }) {
    if (task) {
      const outputs = { agentTaskId: task.id };
      if (task.state !== 'SUCCEEDED') return { failed: taskFailure(task), outputs };
      const review = ctx.taskSummary(task).trim();
      if (!review) return { failed: 'The coding agent finished without a review.', outputs };
      if (ctx.outputs.includes('comment')) outputs.commentId = await ctx.comment({ kind: 'pull_request', number: task.target_number,
        body: `Review by ${task.tool} on an agent host (read-only, at \`${String(task.base_commit).slice(0, 12)}\`):\n\n${clipBytes(review, 11000)}` });
      return { outputs, reason: `Reviewed by ${task.tool}${outputs.commentId ? ', posted as a comment' : ''}.` };
    }
    const outputs = { review: { summary: output.summary, findings: output.findings, markdown: output.markdown, commits: output.commits } };
    if (ctx.outputs.includes('comment')) outputs.commentId = await ctx.comment({ kind: 'pull_request', number: ctx.run.target_number, body: output.markdown });
    const count = output.findings.length;
    return { outputs, reason: `${count ? count + ' finding' + (count === 1 ? '' : 's') : 'No findings'}${outputs.commentId ? ', posted as a comment' : ''}${ctx.outputs.includes('review') ? ', drafted for review' : ''}.` };
  },

  // A schedule reviews open pull requests whose current head this automation has not reviewed yet (at most five per run).
  async scheduled(ctx) {
    const pulls = await ctx.openPulls(20), queued = [];
    for (const pull of pulls) {
      if (queued.length >= 5) break;
      if (await ctx.enqueue({ trigger: 'schedule', kind: 'pull_request', number: pull.number, commit: pull.headCommit, key: prReviewer.dedupe({ number: pull.number, headCommit: pull.headCommit }) })) queued.push(pull.number);
    }
    return { reason: queued.length ? `Queued reviews of ${queued.map(n => '#' + n).join(', ')}.` : 'Every open pull request head is already reviewed.' };
  },
};
