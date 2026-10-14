import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { Code, ConnectError } from '@connectrpc/connect';
import { repositoryClient } from './api';
import { isCommitID, repositoryOptions } from './navigation';
import type { RepositoryLocation } from './navigation';
import { sourceRepositoryID, sourcePath, validSourceLatestChange } from './sourceReads';
import type { Commit } from './gen/golf/v1/golf_pb';
import { DateLabel, privateNavigationQuery } from './RepositoryUI';

// Only these directory-row reads share this cap. No speculative/offscreen RPCs.
let activeReads = 0;
const waitingReads = new Set<() => void>();
function entryReadSlot(signal: AbortSignal) {
  return new Promise<() => void>((resolve, reject) => {
    const aborted = () => { waitingReads.delete(start); signal.removeEventListener('abort', aborted); reject(signal.reason); };
    const start = () => {
      if (signal.aborted) { aborted(); return; }
      if (activeReads >= 3) { waitingReads.add(start); return; }
      waitingReads.delete(start); signal.removeEventListener('abort', aborted); activeReads++;
      let released = false;
      resolve(() => { if (released) return; released = true; activeReads--; waitingReads.values().next().value?.(); });
    };
    signal.addEventListener('abort', aborted, { once: true }); start();
  });
}

export function SourceEntryCommit({ userId, repositoryId, commitId, path, location, latestChange, onOutcome }: {
  userId: string; repositoryId: string; commitId: string; path: string; location: RepositoryLocation; latestChange?: Commit; onOutcome?: (available: boolean) => void;
}) {
  const target = useRef<HTMLSpanElement>(null);
  const client = useQueryClient();
  const key = useMemo(() => ['repository', userId, location.owner, location.name, 'source-entry-commit', repositoryId, commitId, path], [userId, location.owner, location.name, repositoryId, commitId, path]);
  const identity = JSON.stringify(key);
  const [visibleIdentity, setVisibleIdentity] = useState('');
  const [finishedIdentity, setFinishedIdentity] = useState('');
  const finished = finishedIdentity === identity;
  const validTarget = sourceRepositoryID(userId) && sourceRepositoryID(repositoryId) && isCommitID(commitId) && path !== '' && sourcePath(path);
  const projected = validTarget && latestChange && validSourceLatestChange(latestChange, commitId) ? latestChange : undefined;
  const eligible = validTarget && !projected;
  const visible = visibleIdentity === identity;
  const retained = client.getQueryState(key);
  useEffect(() => {
    const element = target.current;
    if (!eligible || finished || !element || typeof IntersectionObserver === 'undefined') return;
    let intersects = false;
    const update = () => setVisibleIdentity(intersects && document.visibilityState === 'visible' ? identity : '');
    const observer = new IntersectionObserver(entries => {
      const entry = entries[0]; intersects = Boolean(entry?.isIntersecting && entry.intersectionRect.width > 0 && entry.intersectionRect.height > 0); update();
    }, { rootMargin: '0px', threshold: 0 });
    const hide = () => setVisibleIdentity('');
    observer.observe(element); document.addEventListener('visibilitychange', update); window.addEventListener('pagehide', hide);
    return () => { observer.disconnect(); document.removeEventListener('visibilitychange', update); window.removeEventListener('pagehide', hide); };
  }, [identity, eligible, finished]);
  useEffect(() => {
    if (!visible && !finished) void client.cancelQueries({ queryKey: key, exact: true });
  }, [client, key, visible, finished]);
  useEffect(() => () => { void client.cancelQueries({ queryKey: key, exact: true }); }, [client, key]);
  const query = useQuery({ ...privateNavigationQuery, queryKey: key, enabled: eligible && (visible || finished || retained?.status === 'success' || retained?.status === 'error'), retry: false, retryOnMount: false,
    queryFn: async ({ signal }) => {
      const release = await entryReadSlot(signal);
      try {
        signal.throwIfAborted();
        const response = await repositoryClient.listCommits({ repository: { owner: location.owner, name: location.name }, ref: commitId, path, repositoryId, page: { page: 1, limit: 1 } }, { signal, timeoutMs: 8_000 });
        const commit = response.commits[0];
        if (response.path !== path || response.commitId !== commitId || response.repositoryId !== repositoryId || response.commits.length !== 1 || !commit || !isCommitID(commit.sha) || commit.sha.length !== commitId.length || !Number.isFinite(Date.parse(commit.authoredAt))) throw new ConnectError('The returned latest change does not identify this path and snapshot.', Code.FailedPrecondition);
        return commit;
      } finally { release(); }
    },
  });
  // Once a validated read (or terminal refusal) settles, stop watching viewport
  // edges. Pending offscreen work still cancels; completed exact observations
  // stay mounted and never refetch merely because the user scrolls back.
  useEffect(() => {
    if (!query.isFetching && (query.isSuccess || query.isError)) setFinishedIdentity(identity);
  }, [identity, query.isFetching, query.isSuccess, query.isError]);
  // The list learns once per row whether it has a change to show.
  const outcome = projected ? true : !validTarget ? false : query.isFetching ? undefined : query.isSuccess ? true : query.isError ? false : undefined;
  useEffect(() => { if (outcome !== undefined) onOutcome?.(outcome); }, [identity, outcome]);
  const commit = projected || (eligible && query.isSuccess ? query.data : undefined);
  return <span ref={target} className="source-entry-commit" aria-label={`Latest change for ${path}`}>
    {commit ? <><Link className="source-entry-commit-title" {...repositoryOptions(location, { view: 'commits', ref:commitId, refKind:undefined,refName:undefined, commit: commit.sha, historyPath: undefined })} title={commit.message.split('\n')[0] || 'Commit message unavailable'}>{commit.message.split('\n')[0] || 'Commit message unavailable'}</Link><span className="source-entry-commit-date"><DateLabel relative value={commit.authoredAt}/></span></> : <span className="muted source-entry-commit-unavailable">{query.isError || !eligible ? 'Latest change unavailable' : visible ? 'Reading latest change…' : 'Latest change not loaded'}</span>}
  </span>;
}
