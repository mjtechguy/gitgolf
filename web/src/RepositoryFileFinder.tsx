import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { FileSearch } from 'lucide-react';
import { Code, ConnectError } from '@connectrpc/connect';
import { repositoryClient } from './api';
import { DetailsDialog } from './DetailsDialog';
import { Loading, PanelError, privateQuery, shortSHA } from './RepositoryUI';
import { sourcePath } from './sourceReads';
import { sourceOptions, type RepositoryLocation } from './navigation';

type Props = { location: RepositoryLocation; repositoryId: string; commitId: string; userId: string };
export function RepositoryFileFinder(props: Props) {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const shortcut = (event: KeyboardEvent) => {
      if (event.key !== 't' || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey || event.defaultPrevented ||
          document.querySelector('dialog[open]') || event.target instanceof Element && event.target.closest('input,textarea,select,[contenteditable="true"]')) return;
      event.preventDefault(); setOpen(true);
    };
    document.addEventListener('keydown', shortcut);
    return () => document.removeEventListener('keydown', shortcut);
  }, []);
  return <><button className="button secondary" type="button" aria-keyshortcuts="t" onClick={() => setOpen(true)}><FileSearch size={16} />Go to file <kbd>t</kbd></button>
    {open ? <DetailsDialog title="Go to file" onClose={() => setOpen(false)}><Finder {...props} close={() => setOpen(false)} /></DetailsDialog> : null}</>;
}

function Finder({ location, repositoryId, commitId, userId, close }: Props & { close: () => void }) {
  const [filter, setFilter] = useState('');
  const input = useRef<HTMLInputElement>(null), list = useRef<HTMLUListElement>(null);
  useEffect(() => { const frame = requestAnimationFrame(() => input.current?.focus()); return () => cancelAnimationFrame(frame); }, []);
  const query = useQuery({ ...privateQuery, queryKey: ['repository', userId, location.owner, location.name, 'file-index', repositoryId, commitId],
    queryFn: async ({ signal }) => {
      const value = await repositoryClient.getRepositoryFileIndex({ repository: { owner: location.owner, name: location.name }, repositoryId, commitId }, { signal, timeoutMs: 16000 });
      signal.throwIfAborted();
      const bytes = value.paths.reduce((total, path) => total + new TextEncoder().encode(path).length, 0);
      if (value.repositoryId !== repositoryId || value.commitId !== commitId || value.paths.length > 10000 || bytes > 1024 * 1024 ||
          new Set(value.paths).size !== value.paths.length || value.paths.some(path => !path || !sourcePath(path))) throw new ConnectError('File inventory does not match this repository snapshot.', Code.FailedPrecondition);
      return value.paths;
    } });
  const matches = useMemo(() => {
    const terms = filter.trim().toLocaleLowerCase().split(/\s+/);
    return (query.data || []).filter(path => terms.every(term => path.toLocaleLowerCase().includes(term)));
  }, [query.data, filter]);
  const available = query.isSuccess && !query.isFetching;
  return <><p className="field-help">Find filenames and paths throughout <strong>{location.owner}/{location.name}</strong> at <code>{shortSHA(commitId)}</code>. File contents and submodule repositories are not searched.</p>
    <input ref={input} type="search" aria-label="Find a file by name or path" placeholder="Type a filename or path…" autoComplete="off" maxLength={512} value={filter} onChange={event => setFilter(event.target.value)} onKeyDown={event => {
      if (available && (event.key === 'Enter' || event.key === 'ArrowDown')) {
        event.preventDefault(); const first = list.current?.querySelector('a');
        if (event.key === 'Enter') first?.click(); else first?.focus();
      }
    }} />
    {query.isError ? <PanelError error={query.error} retry={() => void query.refetch()} /> : !available ? <Loading label="Finding repository files…" /> : <>
      <p className="field-help" role="status">{matches.length} matching {matches.length === 1 ? 'file' : 'files'} · {query.data.length} in this snapshot{matches.length > 50 ? ' · Showing the first 50; type more to narrow results.' : ''}</p>
      <ul ref={list} className="file-finder-results" aria-label="Matching files" onKeyDown={event => {
        if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
        const links = [...list.current!.querySelectorAll('a')], index = links.indexOf(document.activeElement as HTMLAnchorElement);
        if (index < 0) return;
        event.preventDefault(); const next = index + (event.key === 'ArrowDown' ? 1 : -1);
        if (next < 0) input.current?.focus(); else links[Math.min(next, links.length - 1)]?.focus();
      }}>{matches.slice(0, 50).map(path => <li key={path}><Link {...sourceOptions({ ...location, refKind: undefined, refName: undefined }, commitId, path, true)} onClick={close}>{path}</Link></li>)}</ul>
      {!matches.length ? <p>No files match this path. Try fewer words.</p> : null}
    </>}
  </>;
}
