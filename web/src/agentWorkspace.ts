import type { Job, Pull } from './NativeForge';

export function jobMatchesPull(job: Job, pull: Pull, repositoryId: string) {
  return !job.stale && job.selection.repositoryId === repositoryId && job.selection.pullRequestId === pull.id
    && job.selection.number === pull.number && job.selection.baseCommitId === pull.base.commitId
    && job.selection.headCommitId === pull.head.commitId;
}

export function pullStage(pull: Pull) {
  return pull.merged ? 'Merged' : pull.state === 'ISSUE_STATE_CLOSED' ? 'Closed' : pull.draft ? 'Draft' : 'Open for review';
}
