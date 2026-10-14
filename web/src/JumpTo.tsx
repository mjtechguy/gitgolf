import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { Search } from 'lucide-react';
import { repositoryClient } from './api';
import { DetailsDialog } from './DetailsDialog';
import { repositoryOptions } from './navigation';
import { Loading, PanelError, privateQuery } from './RepositoryUI';

const typing = 'input,textarea,select,[contenteditable="true"],.xterm';

// A top-bar field that opens a repository switcher. It reads one page of repositories when opened.
export function JumpTo({ userId }: { userId: string }) {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const shortcut = (event: KeyboardEvent) => {
      if (event.key.toLowerCase() !== 'k' || !(event.ctrlKey || event.metaKey) || event.altKey || event.shiftKey || event.defaultPrevented || document.querySelector('dialog[open]') || event.target instanceof Element && event.target.closest(typing)) return;
      event.preventDefault(); setOpen(true);
    };
    const request = () => setOpen(true);
    document.addEventListener('keydown', shortcut); window.addEventListener('golf-jump', request);
    return () => { document.removeEventListener('keydown', shortcut); window.removeEventListener('golf-jump', request); };
  }, []);
  return <><button className="jump-field" type="button" aria-label="Jump to a repository" aria-keyshortcuts="Control+K Meta+K" onClick={() => setOpen(true)}><Search size={15} aria-hidden="true" /><span>Jump to…</span><kbd>Ctrl K</kbd></button>
    {open ? <DetailsDialog title="Jump to a repository" onClose={() => setOpen(false)}><Repositories userId={userId} close={() => setOpen(false)} /></DetailsDialog> : null}</>;
}

function Repositories({ userId, close }: { userId: string; close: () => void }) {
  const [filter, setFilter] = useState('');
  const input = useRef<HTMLInputElement>(null), list = useRef<HTMLUListElement>(null);
  useEffect(() => { const frame = requestAnimationFrame(() => input.current?.focus()); return () => cancelAnimationFrame(frame); }, []);
  const query = useQuery({ ...privateQuery, queryKey: ['jump-repositories', userId], queryFn: ({ signal }) => repositoryClient.listRepositories({ page: { page: 1 }, metadataOnly: true }, { signal }) });
  const matches = useMemo(() => {
    const terms = filter.trim().toLocaleLowerCase().split(/\s+/);
    return (query.data?.repositories || []).filter(repository => repository.fullName.includes('/') && terms.every(term => repository.fullName.toLocaleLowerCase().includes(term)));
  }, [query.data, filter]);
  const available = query.isSuccess && !query.isFetching;
  return <>
    <input ref={input} type="search" aria-label="Find a repository by name" placeholder="Type an owner or repository name…" autoComplete="off" maxLength={256} value={filter} onChange={event => setFilter(event.target.value)} onKeyDown={event => {
      if (available && (event.key === 'Enter' || event.key === 'ArrowDown')) {
        event.preventDefault(); const first = list.current?.querySelector('a');
        if (event.key === 'Enter') first?.click(); else first?.focus();
      }
    }} />
    {query.isError ? <PanelError error={query.error} retry={() => void query.refetch()} /> : !available ? <Loading label="Finding your repositories…" /> : <>
      <p className="field-help" role="status">{matches.length} matching {matches.length === 1 ? 'repository' : 'repositories'}{query.data.page?.nextPage ? ' · Search covers the first page of your repositories' : ''}</p>
      <ul ref={list} className="file-finder-results" aria-label="Matching repositories" onKeyDown={event => {
        if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
        const links = [...list.current!.querySelectorAll('a')], index = links.indexOf(document.activeElement as HTMLAnchorElement);
        if (index < 0) return;
        event.preventDefault(); const next = index + (event.key === 'ArrowDown' ? 1 : -1);
        if (next < 0) input.current?.focus(); else links[Math.min(next, links.length - 1)]?.focus();
      }}>{matches.slice(0, 50).map(repository => { const [owner, name] = repository.fullName.split('/') as [string, string]; return <li key={repository.id}><Link {...repositoryOptions({ owner, name })} onClick={close}>{repository.fullName}</Link></li>; })}</ul>
      {!matches.length ? <p>No repository matches. Try fewer words.</p> : null}
    </>}
  </>;
}
