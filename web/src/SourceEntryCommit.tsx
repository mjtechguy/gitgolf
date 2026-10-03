import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { Code, ConnectError } from '@connectrpc/connect';
import { repositoryClient } from './api';
import { isCommitID, repositoryOptions } from './navigation';
import type { RepositoryLocation } from './navigation';
import { DateLabel, privateQuery } from './RepositoryUI';

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

export function SourceEntryCommit({ userId, repositoryId, commitId, path, location }: {
  userId: string; repositoryId: string; commitId: string; path: string; location: RepositoryLocation;
}) {
  const target = useRef<HTMLSpanElement>(null);
  const client = useQueryClient();
  const key = useMemo(() => ['repository', userId, location.owner, location.name, 'source-entry-commit', repositoryId, commitId, path], [userId, location.owner, location.name, repositoryId, commitId, path]);
  const identity = JSON.stringify(key);
  const [visibleIdentity, setVisibleIdentity] = useState('');
  const eligible = Boolean(userId && /^[1-9][0-9]{0,18}$/.test(repositoryId) && BigInt(repositoryId) <= 9223372036854775807n && isCommitID(commitId) && path && new TextEncoder().encode(path).byteLength <= 4096 && !/[\\\p{Cc}]/u.test(path) && path.split('/').every(part => part && part !== '.' && part !== '..'));
  const visible = visibleIdentity === identity;
  useEffect(() => {
    const element = target.current;
    if (!eligible || !element || typeof IntersectionObserver === 'undefined') return;
    let intersects = false;
    const update = () => setVisibleIdentity(intersects && document.visibilityState === 'visible' ? identity : '');
    const observer = new IntersectionObserver(entries => {
      const entry = entries[0]; intersects = Boolean(entry?.isIntersecting && entry.intersectionRect.width > 0 && entry.intersectionRect.height > 0); update();
    }, { rootMargin: '0px', threshold: 0 });
    const hide = () => setVisibleIdentity('');
    observer.observe(element); document.addEventListener('visibilitychange', update); window.addEventListener('pagehide', hide);
    return () => { observer.disconnect(); document.removeEventListener('visibilitychange', update); window.removeEventListener('pagehide', hide); };
  }, [identity, eligible]);
  useEffect(() => {
    if (!visible) void client.cancelQueries({ queryKey: key, exact: true });
  }, [client, key, visible]);
  useEffect(() => () => { void client.cancelQueries({ queryKey: key, exact: true }); }, [client, key]);
  const query = useQuery({ ...privateQuery, queryKey: key, enabled: eligible && visible, retry: false,
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
  const commit = visible && query.isSuccess && !query.isFetching ? query.data : undefined;
  return <span ref={target} className="source-entry-commit" aria-label={`Latest change for ${path}`}>
    {commit ? <><Link className="source-entry-commit-title" {...repositoryOptions(location, { view: 'commits', commit: commit.sha, historyPath: undefined })} title={commit.message.split('\n')[0] || 'Commit message unavailable'}>{commit.message.split('\n')[0] || 'Commit message unavailable'}</Link><span className="source-entry-commit-date"><DateLabel relative value={commit.authoredAt}/></span></> : <span className="muted source-entry-commit-unavailable">{query.isError || !eligible ? 'Latest change unavailable' : visible ? 'Reading latest change…' : 'Latest change not loaded'}</span>}
  </span>;
}
