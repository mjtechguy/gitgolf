import { Fragment, useId, useState, type ReactNode } from 'react';
import { Link, useNavigate } from '@tanstack/react-router';
import { useForm } from '@tanstack/react-form';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CircleDot, FileCode2, GitPullRequest, LoaderCircle, Search, Sparkles, Trash2, RefreshCw } from 'lucide-react';
import { nativeAPI } from './nativeAPI';
import { repositoryOptions } from './navigation';
import { DateLabel, PanelError, privateQuery, privateSnapshotQuery, usePageVisible } from './RepositoryUI';
import { SummaryBand } from './Layout';
import { useRuntimeCapabilities } from './useRuntimeCapabilities';
import { CapabilityState } from './gen/golf/v1/golf_pb';

type Key = { owner: string; name: string };
type IndexState = 'PENDING' | 'INDEXING' | 'READY' | 'FAILED' | 'REMOVING';
export type SearchStatus = { repositoryId: string; available: boolean; reason: string; notice: string; canManage: boolean;
  index: null | { state: IndexState; served: boolean; model: string; dimensions: number; commitId: string; indexedAt: string; files: number; chunks: number; skipped: number;
    targetCommitId?: string; targetModel?: string; pending?: number; total?: number; progress?: number; verified: boolean; error: string; updatedAt: string } };
type Excerpt = { startLine: number; lines: string[] };
export type SearchResult = { kind: 'code' | 'issue' | 'pull'; score: number; startLine: number; endLine: number; excerpt: Excerpt; path?: string; number?: number; title?: string; state?: string };
type SearchAnswer = SearchStatus & { query: string; results: SearchResult[]; filtered: number };

const notice = 'Semantic matches by meaning; exact text search is not available.';
const stateLabel = (status?: SearchStatus) => {
  const index = status?.index;
  if (!index) return 'Not indexed';
  if (index.state === 'INDEXING') return `Indexing ${index.progress ?? 0}%`;
  return ({ PENDING: 'Queued', READY: index.verified ? 'Ready' : 'Ready, confirming', FAILED: 'Failed', REMOVING: 'Removing' } as const)[index.state];
};
function escape(value: string) { return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
// Words of three or more letters from the search, marked where they appear in the excerpt.
function marked(line: string, terms: string[]): ReactNode {
  if (!terms.length || !line) return line || ' ';
  const pattern = new RegExp(`(${terms.map(escape).join('|')})`, 'giu');
  return line.split(pattern).map((part, i) => i % 2 ? <mark key={i}>{part}</mark> : <Fragment key={i}>{part}</Fragment>);
}
const termsOf = (query: string) => [...new Set(query.toLowerCase().match(/[\p{L}\p{N}_]{3,}/gu) || [])].slice(0, 12);

function ExcerptLines({ excerpt, terms, label }: { excerpt: Excerpt; terms: string[]; label: string }) {
  return <pre className="search-excerpt" aria-label={label}><code>{excerpt.lines.map((line, i) => <span key={i} className="search-excerpt-line"><span className="search-excerpt-number" aria-hidden="true">{excerpt.startLine + i}</span><span>{marked(line, terms)}</span></span>)}</code></pre>;
}

// The search box in the repository header: it only opens the search page.
export function RepositorySearchField({ owner, name }: Key) {
  const navigate = useNavigate(), id = useId();
  const form = useForm({ defaultValues: { q: '' }, onSubmit: ({ value }) => { const q = value.q.trim(); if (q.length >= 2) void navigate({ to: '/$owner/$name/search', params: { owner, name }, search: { q: q.slice(0, 500) } }); } });
  return <form className="repository-search-field" role="search" aria-label="Search this repository by meaning" onSubmit={event => { event.preventDefault(); void form.handleSubmit(); }}>
    <form.Field name="q">{field => <div className="search-input"><label className="sr-only" htmlFor={id}>Search this repository by meaning</label><Sparkles size={15} aria-hidden="true"/><input id={id} type="search" autoComplete="off" placeholder="Search by meaning…" maxLength={500} value={field.state.value} onChange={event => field.handleChange(event.target.value)}/></div>}</form.Field>
  </form>;
}

export function RepositorySearch({ owner, name, query, userId }: Key & { query?: string; userId: string }) {
  const key = { owner, name }, client = useQueryClient(), navigate = useNavigate(), visible = usePageVisible(), inputId = useId();
  const runtime = useRuntimeCapabilities();
  const capability = runtime.data?.capabilities.find(item => item.id === 'repository.semantic-search');
  // Degraded still searches: it only says no index has yet read back from Vectorize.
  const offered = capability && (capability.state === CapabilityState.READY || capability.state === CapabilityState.DEGRADED);
  const statusKey = ['native-search', userId, owner, name, 'status'];
  const status = useQuery({ ...privateQuery, queryKey: statusKey, enabled: Boolean(offered),
    queryFn: ({ signal }) => nativeAPI<SearchStatus>('/native/search/read', { repository: key, action: 'status' }, signal),
    refetchInterval: current => visible && ['PENDING', 'INDEXING', 'REMOVING'].includes(current.state.data?.index?.state || '') ? 5000 : false });
  const submitted = (query || '').trim();
  const served = Boolean(status.data?.available && status.data.index?.served);
  // Each search is one embedding call against a daily allowance: an answer is kept while this page is open, never refetched in the background.
  const results = useQuery({ ...privateSnapshotQuery, gcTime: 5 * 60_000, queryKey: ['native-search', userId, owner, name, 'query', submitted, status.data?.index?.commitId], enabled: served && submitted.length >= 2,
    queryFn: ({ signal }) => nativeAPI<SearchAnswer>('/native/search/read', { repository: key, action: 'query', query: submitted }, signal) });
  const [confirmRemove, setConfirmRemove] = useState(false);
  const manage = useMutation({ mutationFn: (action: 'index' | 'remove') => nativeAPI<SearchStatus>('/native/search', { repository: key, repositoryId: status.data?.repositoryId, action }),
    onSuccess: value => { client.setQueryData(statusKey, value); setConfirmRemove(false); } });
  const form = useForm({ defaultValues: { q: submitted }, onSubmit: ({ value }) => { const q = value.q.trim(); if (q.length >= 2 && q.length <= 500) void navigate({ to: '/$owner/$name/search', params: { owner, name }, search: { q } }); } });

  const header = <header className="repository-intro"><div><h1><Sparkles aria-hidden="true"/>Search {owner}/{name}</h1><p>Find code, issues and pull requests by what they mean. <Link {...repositoryOptions(key, { view: 'source', path: '' })}>Back to the code</Link></p></div></header>;
  if (runtime.isPending) return <section className="page-stack repository-search">{header}<p role="status" className="repository-search-loading"><LoaderCircle size={16} className="spin"/>Checking whether semantic search is available…</p></section>;
  if (runtime.isError) return <section className="page-stack repository-search">{header}<PanelError error={runtime.error} retry={() => void runtime.refetch()}/></section>;
  if (!offered) return <section className="page-stack repository-search feature-unavailable" aria-labelledby="search-unavailable">{header}<div className="browser-panel repository-search-empty"><h2 id="search-unavailable">Semantic search is not available here</h2><p>{capability?.reason || 'This installation does not offer semantic search.'}</p><Link className="button secondary" to="/status">See what this installation provides</Link></div></section>;

  const index = status.data?.index, answer = results.data, terms = termsOf(submitted);
  const code = answer?.results.filter(result => result.kind === 'code') || [], discussions = answer?.results.filter(result => result.kind !== 'code') || [];
  const building = index && ['PENDING', 'INDEXING'].includes(index.state);
  const actions = status.data?.canManage && status.data.available ? <div className="credential-actions">
    {!index || index.state === 'READY' || index.state === 'FAILED' ? <button className="button secondary" disabled={manage.isPending} onClick={() => manage.mutate('index')}><RefreshCw size={15}/>{index ? 'Rebuild index' : 'Build index'}</button> : null}
    {index && index.state !== 'REMOVING' ? <button className="button secondary danger-action" disabled={manage.isPending} aria-expanded={confirmRemove} onClick={() => setConfirmRemove(true)}><Trash2 size={15}/>Remove index</button> : null}
  </div> : null;

  return <section className="page-stack repository-search" aria-labelledby="repository-search-title">
    <header className="repository-intro"><div><h1 id="repository-search-title"><Sparkles aria-hidden="true"/>Search {owner}/{name}</h1><p>Find code, issues and pull requests by what they mean. <Link {...repositoryOptions(key, { view: 'source', path: '' })}>Back to the code</Link></p></div>{actions}</header>
    {status.isError ? <PanelError error={status.error} retry={() => void status.refetch()}/> : null}
    {manage.isError ? <p className="error" role="alert">{manage.error.message}</p> : null}
    {confirmRemove && index ? <div className="browser-panel repository-search-confirm" role="alertdialog" aria-labelledby="remove-search-title"><h2 id="remove-search-title">Remove this repository's search index?</h2><p>Searches stop now. The next maintenance run deletes its {index.chunks.toLocaleString()} vectors from Vectorize and its rows from D1. Code, issues and pull requests are not changed. You can build it again later.</p><div className="credential-actions"><button className="button secondary danger-action" disabled={manage.isPending} onClick={() => manage.mutate('remove')}>Remove index</button><button className="button secondary" onClick={() => setConfirmRemove(false)}>Keep index</button></div></div> : null}
    {status.data ? <SummaryBand label="Search index" items={[
      ['Index', stateLabel(status.data), index?.state === 'READY' && !index.verified ? 'Vectorize has not yet returned a stored vector' : undefined],
      ['Indexed commit', index?.served && index.commitId ? <code title={index.commitId}>{index.commitId.slice(0, 12)}</code> : index?.served ? 'No code yet' : 'None yet', building && index?.targetCommitId ? `Building ${index.targetCommitId.slice(0, 12)}` : undefined],
      ['Indexed', index?.indexedAt ? <DateLabel value={index.indexedAt} relative/> : 'Never'],
      ['Files', index?.served ? index.files.toLocaleString() : '—', index?.skipped ? `${index.skipped.toLocaleString()} skipped` : undefined],
      ['Chunks', index?.served ? index.chunks.toLocaleString() : '—'],
      ['Model', index ? <code className="repository-search-model">{building && index.targetModel ? index.targetModel : index.model}</code> : '—', building && index?.targetModel && index.targetModel !== index.model ? `Serving ${index.model}` : undefined],
    ]}/> : status.isPending ? <p role="status" className="repository-search-loading"><LoaderCircle size={16} className="spin"/>Reading the search index…</p> : null}
    {index?.state === 'INDEXING' ? <div className="repository-search-progress"><progress max={100} value={index.progress ?? 0} aria-label="Indexing progress"/><span>{(index.total ?? 0) - (index.pending ?? 0)} of {index.total ?? 0} files and discussions embedded{index.served ? '; searches use the previous index until this finishes.' : '.'}</span></div> : null}
    {index?.error ? <p className={index.state === 'FAILED' ? 'error' : 'field-help'} role={index.state === 'FAILED' ? 'alert' : undefined}>{index.error}</p> : null}
    {status.data && !status.data.available ? <p className="field-help" role="note">{status.data.reason}</p> : null}

    <form className="repository-search-form" role="search" aria-label="Semantic search" onSubmit={event => { event.preventDefault(); void form.handleSubmit(); }}>
      <form.Field name="q" validators={{ onSubmit: ({ value }) => value.trim().length < 2 ? 'Search for at least 2 characters.' : value.trim().length > 500 ? 'Search for at most 500 characters.' : undefined }}>{field => <>
        <div className="search-input"><label className="sr-only" htmlFor={inputId}>Search by meaning</label><Search size={16} aria-hidden="true"/><input id={inputId} type="search" autoComplete="off" placeholder="How are cache entries evicted?" maxLength={500} value={field.state.value} disabled={!served} onChange={event => field.handleChange(event.target.value)} aria-describedby={`${inputId}-notice`}/></div>
        <button className="button primary" type="submit" disabled={!served || results.isFetching}>{results.isFetching ? <LoaderCircle size={15} className="spin"/> : <Search size={15}/>}Search</button>
        {field.state.meta.errors.length ? <p className="error" role="alert">{field.state.meta.errors.join(' ')}</p> : null}</>}</form.Field>
      <p className="field-help" id={`${inputId}-notice`}>{status.data?.notice || notice} Results respect your current access and show the indexed commit; pushes after it appear once it is indexed again.</p>
    </form>

    {!index && status.data?.available ? <div className="browser-panel repository-search-empty"><h2>This repository is not indexed yet</h2><p>{status.data.canManage ? 'Build the index to embed default-branch code (up to 2,000 files) and issue and pull request titles and descriptions. Indexing runs in the background with Workers AI; large repositories take several maintenance runs.' : 'A repository administrator can build the index.'}</p></div> : null}
    {index && !index.served && building ? <div className="browser-panel repository-search-empty"><h2>Building the first index</h2><p>Search opens when the first index is complete. This page refreshes on its own.</p></div> : null}
    {results.isError ? <PanelError error={results.error} retry={() => void results.refetch()}/> : null}
    {results.isFetching && !answer ? <p role="status" className="repository-search-loading"><LoaderCircle size={16} className="spin"/>Searching…</p> : null}
    {answer ? <div className="repository-search-results" aria-live="polite">
      <p className="repository-search-count" role="status">{answer.results.length ? `${answer.results.length} ${answer.results.length === 1 ? 'match' : 'matches'} for “${answer.query}”` : `No matches for “${answer.query}”`}{answer.filtered ? ` · ${answer.filtered} hidden because the source changed, was removed or is not available to you` : ''}</p>
      {code.length ? <section className="browser-panel repository-search-group" aria-labelledby="search-code"><div className="browser-panel-heading"><h2 id="search-code"><FileCode2 size={15} aria-hidden="true"/>Code</h2><span className="count-badge">{code.length}</span></div>
        <ol className="repository-search-list">{code.map(result => <li key={`${result.path}:${result.startLine}`}>
          <div className="repository-search-result-heading"><Link className="repository-search-path" {...repositoryOptions(key, { view: 'source', ref: answer.index?.commitId || '', path: result.path }, 'file')}>{result.path}</Link><span className="repository-search-lines">Lines {result.startLine}–{result.endLine}</span></div>
          <ExcerptLines excerpt={result.excerpt} terms={terms} label={`${result.path}, lines ${result.excerpt.startLine} to ${result.excerpt.startLine + result.excerpt.lines.length - 1}`}/></li>)}</ol></section> : null}
      {discussions.length ? <section className="browser-panel repository-search-group" aria-labelledby="search-discussions"><div className="browser-panel-heading"><h2 id="search-discussions"><CircleDot size={15} aria-hidden="true"/>Issues and pull requests</h2><span className="count-badge">{discussions.length}</span></div>
        <ol className="repository-search-list">{discussions.map(result => <li key={`${result.kind}:${result.number}:${result.startLine}`}>
          <div className="repository-search-result-heading">{result.kind === 'pull' ? <GitPullRequest size={15} aria-label="Pull request"/> : <CircleDot size={15} aria-label="Issue"/>}<Link className="repository-search-title" {...repositoryOptions(key, result.kind === 'pull' ? { view: 'pulls', pull: result.number } : { view: 'issues', issue: result.number })}>{result.title} <span className="muted">#{result.number}</span></Link><span className="visibility">{result.state === 'CLOSED' ? 'Closed' : 'Open'}</span></div>
          <ExcerptLines excerpt={result.excerpt} terms={terms} label={`${result.kind === 'pull' ? 'Pull request' : 'Issue'} #${result.number} excerpt`}/></li>)}</ol></section> : null}
      <p className="ai-advisory-footer repository-search-footer">Ranked by Workers AI embeddings ({answer.index?.model}) through this installation's private AI Gateway; excerpts are read from the repository now, not from the index.</p>
    </div> : null}
  </section>;
}
