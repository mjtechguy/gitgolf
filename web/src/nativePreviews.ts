type Preview = { id: string; jobId: string; commitId: string; kind: string; state: string; purged: boolean; expiresAt: string };
type Job = { id: string; stale: boolean; testState: string; selection: { headCommitId: string } };

// The API returns newest first; keep one current deployment per preview kind.
export function currentPullPreviews<T extends Preview>(previews: T[], jobs: Job[], commitId: string, now = Date.now()): T[] {
  const currentJobs = new Set(jobs.filter(job => !job.stale && job.testState === 'PASSED' && job.selection.headCommitId === commitId).map(job => job.id));
  const kinds = new Set<string>();
  return previews.filter(preview => {
    if (preview.commitId !== commitId || !currentJobs.has(preview.jobId) || preview.state !== 'READY' || preview.purged || !(Date.parse(preview.expiresAt) > now) || kinds.has(preview.kind)) return false;
    kinds.add(preview.kind); return true;
  });
}
