import { useEffect, useMemo, useState } from 'react';
import { useQueries } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { Code, ConnectError } from '@connectrpc/connect';
import { ChevronDown, ChevronRight, File, Folder, FolderOpen, GitCommitHorizontal, Link2, ListTree } from 'lucide-react';
import { repositoryClient } from './api';
import { SourceEntryType } from './gen/golf/v1/golf_pb';
import type { SourceEntry } from './gen/golf/v1/golf_pb';
import { isCommitID, repositoryOptions } from './navigation';
import type { RepositoryLocation } from './navigation';
import { Loading, PanelError, privateQuery } from './RepositoryUI';

const maxFolders = 64;
const maxDepth = 32;
const validPath = (path: string) => path.length <= 4096 && !/[\\\u0000-\u001f\u007f]/.test(path) && path.split('/').every(part => part !== '' && part !== '.' && part !== '..');
function ancestors(path: string) {
  const parts = path.split('/');
  return validPath(path) ? parts.slice(0, -1).map((_, index) => parts.slice(0, index + 1).join('/')).slice(0, maxDepth) : [];
}

type Props = { location: RepositoryLocation; commitId: string; repositoryId: string; userId: string };

// Keys reset in-memory expansion/filter state when the account, native identity or snapshot changes.
export function SourceNavigator(props: Props) {
  if (!props.userId || !props.repositoryId || !isCommitID(props.commitId)) return null;
  return <Navigator key={`${props.userId}:${props.location.owner}:${props.location.name}:${props.repositoryId}:${props.commitId}`} {...props}/>;
}

function Navigator({ location, commitId, repositoryId, userId }: Props) {
  const [visible, setVisible] = useState(() => window.matchMedia('(min-width: 900px)').matches);
  return <details className="source-navigator browser-panel" open={visible} onToggle={event => setVisible(event.currentTarget.open)}>
    <summary><ListTree size={17} aria-hidden="true"/><strong>Files</strong><ChevronDown size={15} aria-hidden="true"/></summary>
    {visible ? <Folders location={location} commitId={commitId} repositoryId={repositoryId} userId={userId}/> : null}
  </details>;
}

function Folders({ location, commitId, repositoryId, userId }: Props) {
  const [expanded, setExpanded] = useState(() => new Set(['', ...ancestors(location.path)]));
  const [filter, setFilter] = useState('');
  const [notice, setNotice] = useState('');
  useEffect(() => {
    setExpanded(previous => new Set([...previous, ...ancestors(location.path)].slice(0, maxFolders)));
  }, [location.path]);
  const paths = [...expanded];
  const queries = useQueries({ queries: paths.map(path => ({ ...privateQuery,
    queryKey: ['repository', userId, location.owner, location.name, 'source-navigator', repositoryId, commitId, path],
    queryFn: async ({ signal }: { signal: AbortSignal }) => {
      const response = await repositoryClient.getContents({ repository: { owner: location.owner, name: location.name }, ref: commitId, path }, { signal });
      if (response.commitId !== commitId || response.path !== path || response.kind !== SourceEntryType.DIRECTORY || response.entries.length > 1000) throw new ConnectError('The returned folder does not match this source snapshot.', Code.FailedPrecondition);
      const seen = new Set<string>();
      for (const entry of response.entries) {
        if (!validPath(entry.path) || entry.path !== (path ? `${path}/` : '') + entry.name || entry.name.includes('/') || seen.has(entry.path) || ![SourceEntryType.DIRECTORY, SourceEntryType.FILE, SourceEntryType.SYMLINK, SourceEntryType.SUBMODULE].includes(entry.type)) throw new ConnectError('The returned folder contains invalid entry metadata.', Code.FailedPrecondition);
        seen.add(entry.path);
      }
      return response;
    },
  })) });
  const folders = new Map(paths.map((path, index) => [path, queries[index]]));
  const root = folders.get('')!;
  const failed = queries.find(query => query.isError);
  const loaded = useMemo(() => queries.flatMap(query => query.isSuccess && !query.isFetching ? query.data.entries : []), [queries]);
  const selectedDirectory = loaded.find(entry => entry.path === location.path && entry.type === SourceEntryType.DIRECTORY)?.path;
  useEffect(() => {
    if (selectedDirectory && selectedDirectory.split('/').length <= maxDepth) setExpanded(previous => previous.has(selectedDirectory) || previous.size >= maxFolders ? previous : new Set([...previous, selectedDirectory]));
  }, [selectedDirectory]);
  const sorted = (entries: SourceEntry[]) => [...entries].sort((a, b) => Number(b.type === SourceEntryType.DIRECTORY) - Number(a.type === SourceEntryType.DIRECTORY) || a.name.localeCompare(b.name));
  function toggle(path: string) {
    setNotice('');
    if (expanded.has(path)) setExpanded(previous => new Set([...previous].filter(value => value !== path && !value.startsWith(`${path}/`))));
    else if (path.split('/').length > maxDepth || expanded.size >= maxFolders) setNotice(`Expand up to ${maxFolders - 1} folders and ${maxDepth} levels. Open the directory to browse deeper.`);
    else setExpanded(previous => new Set([...previous, path]));
  }
  function entryLink(entry: SourceEntry, fullPath = false) {
    const Icon = entry.type === SourceEntryType.DIRECTORY ? expanded.has(entry.path) ? FolderOpen : Folder : entry.type === SourceEntryType.FILE ? File : entry.type === SourceEntryType.SYMLINK ? Link2 : GitCommitHorizontal;
    return <Link {...repositoryOptions(location, { view: 'source', ref: commitId, path: entry.path, historyPath: undefined }, entry.type === SourceEntryType.FILE ? 'file' : undefined)} aria-current={location.path === entry.path ? 'page' : undefined} title={entry.path}><Icon size={15} aria-hidden="true"/><span>{fullPath ? entry.path : entry.name}</span></Link>;
  }
  function directory(path: string, depth: number) {
    const query = folders.get(path);
    if (!query) return null;
    if (query.isError) return <PanelError error={query.error} retry={() => void query.refetch()}/>;
    if (!query.isSuccess || query.isFetching) return <Loading label={`Loading ${path || 'repository'} files…`}/>;
    return query.data.entries.length ? <ul className={depth >= 8 ? 'source-navigator-deep' : undefined}>{sorted(query.data.entries).map(entry => <li key={entry.path}>
      <div className="source-navigator-row">{entry.type === SourceEntryType.DIRECTORY ? <button type="button" className="icon-button" aria-label={`${expanded.has(entry.path) ? 'Collapse' : 'Expand'} ${entry.path}`} aria-expanded={expanded.has(entry.path)} onClick={() => toggle(entry.path)}>{expanded.has(entry.path) ? <ChevronDown size={13}/> : <ChevronRight size={13}/>}</button> : <span className="source-navigator-spacer"/>}{entryLink(entry)}</div>
      {entry.type === SourceEntryType.DIRECTORY && expanded.has(entry.path) && depth < maxDepth ? directory(entry.path, depth + 1) : null}
    </li>)}</ul> : <p className="field-help">This folder is empty.</p>;
  }
  return <nav aria-label="Repository files">
    <Link className="source-navigator-root" {...repositoryOptions(location, { view: 'source', ref: commitId, path: '', historyPath: undefined })} aria-current={!location.path ? 'page' : undefined}><Folder size={15} aria-hidden="true"/>{location.name}</Link>
    <input className="source-navigator-search" type="search" aria-label="Filter expanded folder entries" placeholder="Filter expanded folders…" autoComplete="off" value={filter} onChange={event => setFilter(event.target.value)}/>
    <p className="field-help source-navigator-help">Filter includes loaded entries in expanded folders.</p>
    {failed ? <PanelError error={failed.error!} retry={() => void failed.refetch()}/> : !root.isSuccess || root.isFetching ? <Loading label="Loading repository files…"/> : filter ? <ul className="source-navigator-results">{sorted(loaded.filter(entry => entry.path.toLocaleLowerCase().includes(filter.toLocaleLowerCase()))).map(entry => <li key={entry.path}>{entryLink(entry, true)}</li>)}{!loaded.some(entry => entry.path.toLocaleLowerCase().includes(filter.toLocaleLowerCase())) ? <li className="field-help">No loaded entries match.</li> : null}</ul> : directory('', 0)}
    {notice ? <p className="field-help" role="status">{notice}</p> : null}
  </nav>;
}
