// PR reviewer (docs/AUTOMATIONS.md): a summary and findings on new-side lines of a pull request, from the AI review draft contract
// (ai-review.mjs). With the default engine it is an AI review-draft run of the automation's owner, so the draft also appears in that
// person's AI review panel on the pull request, to edit and publish as their own pending review. A comment output posts the
// neutralized review text. One run per pull request head: a new push re-reviews, an unchanged head is skipped by the dedupe key.
import { preparePullDiff, reviewLimits, reviewMessages, reviewOutput, reviewSchema } from '../ai-review.mjs';

export const prReviewer = {
  id: 'pr-reviewer', label: 'PR reviewer', engines: 'model', schedule: true,
  description: 'Reviews pull requests when they open or change: a summary and findings on changed lines, as a private review draft its owner publishes, or a comment.',
  events: ['pull_request.opened', 'pull_request.updated', 'pull_request.review_requested'], outputs: ['review', 'comment'], targets: ['pull_request'],
  defaults: { name: 'PR reviewer', events: ['pull_request.opened', 'pull_request.updated'], output: ['review'], limits: { perDay: 50, concurrency: 2, maxOpenPRs: 0, dedupeWindow: 0 },
    instructions: 'Report concrete bugs, security issues and missing error handling. Skip style.' },
  useCase: 'review-drafts',
  // The same head is reviewed once (per dedupe window); a new head is a new key.
  dedupe: event => `pull_request:${event.number}:${event.headCommit || ''}`,

  async start(ctx) {
    const pull = await ctx.pull(ctx.run.target_number);
    if (pull.state !== 'ISSUE_STATE_OPEN' || pull.merged) return { skip: `Pull request #${pull.number} is not open.` };
    if (ctx.run.target_commit && pull.head.commitId !== ctx.run.target_commit) return { skip: `Pull request #${pull.number} moved past ${ctx.run.target_commit.slice(0, 12)}; the newer head has its own run.` };
    const target = { number: pull.number, pullRequestId: pull.id, baseCommitId: pull.base.commitId, headCommitId: pull.head.commitId };
    if (ctx.engine === 'default') return { wait: 'ai', aiRun: await ctx.aiRun('review-draft', target) };
    // A registry engine: the same bounded diff, read now in the workspace, then one chat outside it.
    return { infer: await preparePullDiff(reviewLimits.diffBytes)({ db: ctx.db, env: ctx.env, person: ctx.person, row: ctx.row, artifact: ctx.artifact, target }) };
  },
  engineRequest: input => ({ messages: reviewMessages(input), options: { responseFormat: { type: 'json_schema', json_schema: { name: 'review_draft', strict: true, schema: reviewSchema } }, maxTokens: 3000 } }),
  engineParse: (text, input) => reviewOutput({ response: text }, input),

  // output: the review-draft output (summary, findings, markdown), already neutralized by reviewOutput.
  async apply(ctx, { output }) {
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
