import { useEffect, useMemo, useRef, useState } from 'react';
import { hashKey, useQuery, useQueryClient } from '@tanstack/react-query';
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

// One observer and one pair of page listeners serve every row. A directory mounts up to 1000 rows; an observer, two
// listeners and a query observer per row made mounting the list slow enough to delay the visible rows' reads by seconds.
type WatchedRow = { intersects: boolean; update: () => void; hide: () => void };
const watchedRows = new Map<Element, WatchedRow>();
let rowObserver: IntersectionObserver | undefined;
const updateRows = () => watchedRows.forEach(row => row.update());
const hideRows = () => watchedRows.forEach(row => row.hide());
function watchRow(element: Element, update: (row: WatchedRow) => void, hide: () => void) {
  rowObserver ??= new IntersectionObserver(entries => {
    for (const entry of entries) {
      const row = watchedRows.get(entry.target);
      if (!row) continue;
      row.intersects = Boolean(entry.isIntersecting && entry.intersectionRect.width > 0 && entry.intersectionRect.height > 0); row.update();
    }
  }, { rootMargin: '0px', threshold: 0 });
  if (!watchedRows.size) { document.addEventListener('visibilitychange', updateRows); window.addEventListener('pagehide', hideRows); }
  const row: WatchedRow = { intersects: false, update: () => update(row), hide };
  watchedRows.set(element, row); rowObserver.observe(element);
  return () => {
    if (watchedRows.get(element) !== row) return;
    watchedRows.delete(element); rowObserver?.unobserve(element);
    if (!watchedRows.size) { document.removeEventListener('visibilitychange', updateRows); window.removeEventListener('pagehide', hideRows); }
  };
}

type Target = { userId: string; repositoryId: string; commitId: string; path: string; location: RepositoryLocation };

function ChangeLink({ commit, commitId, location }: { commit: Commit; commitId: string; location: RepositoryLocation }) {
  const title = commit.message.split('\n')[0] || 'Commit message unavailable';
  return <><Link className="source-entry-commit-title" {...repositoryOptions(location, { view: 'commits', ref:commitId, refKind:undefined,refName:undefined, commit: commit.sha, historyPath: undefined })} title={title}>{title}</Link><span className="source-entry-commit-date"><DateLabel relative value={commit.authoredAt}/></span></>;
}

export function SourceEntryCommit({ userId, repositoryId, commitId, path, location, latestChange, onOutcome }: Target & {
  latestChange?: Commit; onOutcome?: (available: boolean) => void;
}) {
  const target = useRef<HTMLSpanElement>(null);
  const client = useQueryClient();
  const key = useMemo(() => ['repository', userId, location.owner, location.name, 'source-entry-commit', repositoryId, commitId, path], [userId, location.owner, location.name, repositoryId, commitId, path]);
  const identity = JSON.stringify(key);
  // Exact-key filters (getQueryState, cancelQueries) scan and hash every cached query, so per-row calls made mounting
  // quadratic; look the row up by hash.
  const hash = useMemo(() => hashKey(key), [key]);
  const [visibleIdentity, setVisibleIdentity] = useState('');
  const [finishedIdentity, setFinishedIdentity] = useState('');
  const finished = finishedIdentity === identity;
  const validTarget = sourceRepositoryID(userId) && sourceRepositoryID(repositoryId) && isCommitID(commitId) && path !== '' && sourcePath(path);
  const projected = validTarget && latestChange && validSourceLatestChange(latestChange, commitId) ? latestChange : undefined;
  const eligible = validTarget && !projected;
  const visible = visibleIdentity === identity;
  const retained = client.getQueryCache().get(hash)?.state.status;
  useEffect(() => {
    const element = target.current;
    if (!eligible || finished || !element || typeof IntersectionObserver === 'undefined') return;
    return watchRow(element, row => setVisibleIdentity(row.intersects && document.visibilityState === 'visible' ? identity : ''), () => setVisibleIdentity(''));
  }, [identity, eligible, finished]);
  // Only a visible, settled or retained row mounts its read, so offscreen rows cost no query observer. A row that scrolls
  // away before its read settles unmounts the read, which cancels the pending offscreen work.
  const reading = eligible && (visible || finished || retained === 'success' || retained === 'error');
  // The list learns once per row whether it has a change to show; a read reports its own outcome.
  const outcome = projected ? true : !validTarget ? false : undefined;
  useEffect(() => { if (outcome !== undefined) onOutcome?.(outcome); }, [identity, outcome]);
  return <span ref={target} className="source-entry-commit" aria-label={`Latest change for ${path}`}>
    {projected ? <ChangeLink commit={projected} commitId={commitId} location={location}/>
      : reading ? <EntryRead queryKey={key} hash={hash} identity={identity} visible={visible} userId={userId} repositoryId={repositoryId} commitId={commitId} path={path} location={location} onFinished={setFinishedIdentity} onOutcome={onOutcome}/>
      : <span className="muted source-entry-commit-unavailable">{eligible ? 'Latest change not loaded' : 'Latest change unavailable'}</span>}
  </span>;
}

function EntryRead({ queryKey, hash, identity, visible, repositoryId, commitId, path, location, onFinished, onOutcome }: Target & {
  queryKey: readonly unknown[]; hash: string; identity: string; visible: boolean; onFinished: (identity: string) => void; onOutcome?: (available: boolean) => void;
}) {
  const client = useQueryClient();
  useEffect(() => () => { void client.getQueryCache().get(hash)?.cancel({ revert: true }); }, [client, hash]);
  const query = useQuery({ ...privateNavigationQuery, queryKey, retry: false, retryOnMount: false,
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
  // Once a validated read (or terminal refusal) settles, stop watching viewport edges. Completed exact observations stay
  // mounted and never refetch merely because the user scrolls back.
  const settled = !query.isFetching && (query.isSuccess || query.isError);
  useEffect(() => { if (settled) onFinished(identity); }, [identity, settled]);
  const outcome = query.isFetching ? undefined : query.isSuccess ? true : query.isError ? false : undefined;
  useEffect(() => { if (outcome !== undefined) onOutcome?.(outcome); }, [identity, outcome]);
  return query.isSuccess ? <ChangeLink commit={query.data} commitId={commitId} location={location}/>
    : <span className="muted source-entry-commit-unavailable">{query.isError ? 'Latest change unavailable' : visible ? 'Reading latest change…' : 'Latest change not loaded'}</span>;
}
