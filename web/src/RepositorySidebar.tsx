import { useId, useState, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { Code, ConnectError } from '@connectrpc/connect';
import { Eye, GitBranch, GitCommitHorizontal, GitFork, Globe, LockKeyhole, RefreshCw, Scale, Star } from 'lucide-react';
import { repositoryClient, repositoryLink, errorMessage } from './api';
import { RepositoryOverviewSectionState } from './gen/golf/v1/golf_pb';
import type { GetRepositoryOverviewResponse, Repository } from './gen/golf/v1/golf_pb';
import { repositoryOptions, type RepositoryLocation } from './navigation';
import { DateLabel, privateQuery } from './RepositoryUI';
import { sourceRepositoryID } from './sourceReads';

const decimal = (value: string) => /^(0|[1-9][0-9]*)$/.test(value) && value.length <= 19 && BigInt(value) <= 9223372036854775807n;
const countFormat = new Intl.NumberFormat();
const states = [RepositoryOverviewSectionState.UNAVAILABLE, RepositoryOverviewSectionState.AVAILABLE, RepositoryOverviewSectionState.ERROR, RepositoryOverviewSectionState.INDEXING];

function validateOverview(response: GetRepositoryOverviewResponse, repositoryId: string, location: RepositoryLocation, commitId?: string) {
  const text = (value: string, max: number) => new TextEncoder().encode(value).length <= max && !/[\uD800-\uDFFF]/u.test(value);
  const unique = (values: string[], max: number) => new Set(values).size === values.length && values.every(value => value !== '' && value.trim() === value && text(value, max) && !/[\p{Cc}]/u.test(value));
  const completeLanguages = response.languages.every(language => decimal(language.byteCount));
  const safeWebsite = response.website === '' || text(response.website, 1024) && !/[\p{Cc}]/u.test(response.website) && Boolean(repositoryLink(response.website));
  if (response.indexedCommitId && (!/^[a-f0-9]{40}$/.test(response.indexedCommitId) || commitId && response.indexedCommitId !== commitId) || response.licensePaths.length > 16 || !unique(response.licensePaths, 255) || response.licensePaths.some(path => /[\\/\p{Cc}]/u.test(path) || path === '.' || path === '..') || !text(response.languageClassifier, 256)) throw new ConnectError('Repository index does not match the selected source snapshot.', Code.FailedPrecondition);
  if (!sourceRepositoryID(repositoryId) || response.repositoryId !== repositoryId || response.repository?.owner.toLowerCase() !== location.owner.toLowerCase() || response.repository.name.toLowerCase() !== location.name.toLowerCase() || !text(response.description, 2048) || !safeWebsite || response.topics.length > 100 || !unique(response.topics, 100) || response.licenseIds.length > 128 || !unique(response.licenseIds, 128) || response.languages.length > 256 || !unique(response.languages.map(language => language.name), 100) || !completeLanguages || [response.starsCount, response.watchersCount, response.forksCount].some(value => value !== undefined && !decimal(value)) || !states.includes(response.languagesState) || !states.includes(response.licensesState) || response.languagesState !== RepositoryOverviewSectionState.AVAILABLE && response.languages.length > 0 || response.licensesState !== RepositoryOverviewSectionState.AVAILABLE && response.licenseIds.length > 0 || response.languages.reduce((sum, language) => sum + BigInt(language.byteCount), 0n) > 9223372036854775807n) {
    throw new ConnectError('Repository details do not match the selected repository or supported metadata contract.', Code.FailedPrecondition);
  }
  return response;
}

function SidebarSection({ title, action, children }: { title: string; action?: ReactNode; children: ReactNode }) {
  const id = useId();
  return <section className="repository-sidebar-section" aria-labelledby={id}><div className="repository-sidebar-heading"><h2 id={id}>{title}</h2>{action}</div>{children}</section>;
}

function Languages({ overview }: { overview: GetRepositoryOverviewResponse }) {
  if (overview.languagesState !== RepositoryOverviewSectionState.AVAILABLE) return <p className="muted" role="status">{overview.languagesState === RepositoryOverviewSectionState.INDEXING ? `Indexing source languages… ${countFormat.format(overview.indexingProcessed)} files processed.` : overview.languagesState === RepositoryOverviewSectionState.ERROR ? 'Language indexing failed. Refresh repository details to retry.' : 'Language statistics unavailable.'}</p>;
  const languages = [...overview.languages].sort((a, b) => BigInt(a.byteCount) === BigInt(b.byteCount) ? a.name.localeCompare(b.name) : BigInt(a.byteCount) > BigInt(b.byteCount) ? -1 : 1);
  const total = languages.reduce((sum, language) => sum + BigInt(language.byteCount), 0n);
  if (!total) return <p className="muted">No classified language bytes reported.</p>;
  let offset = 0;
  const geometry = languages.map((language, index) => {
    const width = Number(BigInt(language.byteCount) * 1_000_000n / total) / 1000;
    const segment = { ...language, index: index % 8, x: offset, width };
    offset += width;
    return segment;
  });
  const percent = (bytes: string) => {
    const tenths = (BigInt(bytes) * 1000n + total / 2n) / total;
    return tenths === 0n && BigInt(bytes) > 0n ? '<0.1%' : `${tenths / 10n}.${tenths % 10n}%`;
  };
  return <><svg className="repository-language-bar" viewBox="0 0 1000 8" preserveAspectRatio="none" aria-hidden="true" focusable="false">{geometry.map(language => <rect key={language.name} x={language.x} width={language.width} height={8} className={`language-color-${language.index}`}/>)}</svg><ul className="repository-language-legend" aria-label="Indexed language statistics">{geometry.map(language => <li key={language.name} title={`${language.byteCount} indexed bytes`}><svg width={8} height={8} aria-hidden="true" focusable="false"><circle cx={4} cy={4} r={4} className={`language-color-${language.index}`}/></svg><span>{language.name}</span><span className="muted">{percent(language.byteCount)}</span></li>)}</ul><p className="repository-sidebar-note">{overview.indexedCommitId ? `Source snapshot ${overview.indexedCommitId.slice(0, 8)} · ${countFormat.format(overview.indexedFiles)} files. ${overview.languageClassifier}` : 'Repository indexed statistics; not tied to this source snapshot.'}</p></>;
}

export function RepositorySidebar({ repository, location, userId, commitId }: { repository: Repository; location: RepositoryLocation; userId: string; commitId?: string }) {
  const [explicitRefresh, setExplicitRefresh] = useState(false);
  const query = useQuery<GetRepositoryOverviewResponse>({ ...privateQuery, queryKey: ['repository', userId, location.owner, location.name, 'metadata', 'sidebar', repository.id, commitId || 'default'],
    refetchInterval: query => query.state.data?.languagesState === RepositoryOverviewSectionState.INDEXING || query.state.data?.licensesState === RepositoryOverviewSectionState.INDEXING ? 5000 : false,
    queryFn: async ({ signal }) => {
      if (!sourceRepositoryID(repository.id)) throw new ConnectError('Select a valid native repository identity.', Code.FailedPrecondition);
      const response = await repositoryClient.getRepositoryOverview({ repository: { owner: location.owner, name: location.name }, repositoryId: repository.id, ref: commitId }, { signal, timeoutMs: 8000 });
      signal.throwIfAborted();
      return validateOverview(response, repository.id, location, commitId);
    } });
  const overview = query.isSuccess && !(query.isFetching && explicitRefresh) ? query.data : undefined;
  // Older deployments can lack this optional read procedure. Keep only basic
  // metadata already authorized by the parent; never invent successful sections.
  const unavailable = query.isError && query.error instanceof ConnectError && query.error.code === Code.Unimplemented;
  const basic = overview || unavailable;
  const refresh = <button className="icon-button" type="button" aria-label="Refresh repository details" title="Refresh repository details" disabled={query.isFetching} onClick={() => { setExplicitRefresh(true); void query.refetch().finally(() => setExplicitRefresh(false)); }}><RefreshCw size={15} className={query.isFetching ? 'spin' : ''} aria-hidden="true"/></button>;
  return <aside className="repository-sidebar" aria-label="About this repository"><SidebarSection title="About" action={refresh}>
    {!overview && (query.isFetching || query.isPending) ? <p className="muted" role="status">Reading repository details…</p> : query.isError && !unavailable ? <p className="repository-sidebar-note error" role="status">{errorMessage(query.error)}</p> : null}
    {basic ? <><p className="repository-description">{(overview ? overview.description : repository.description) || 'No description provided.'}</p>{overview?.website ? <a className="repository-sidebar-link" href={overview.website} target="_blank" rel="noopener noreferrer"><Globe size={15} aria-hidden="true"/><span>{overview.website.replace(/^https?:\/\//, '')}</span></a> : null}{overview?.topics.length ? <ul className="repository-topic-list" aria-label="Repository topics">{overview.topics.map(topic => <li key={topic}>{topic}</li>)}</ul> : null}{unavailable ? <><ul className="repository-sidebar-facts"><li><LockKeyhole size={15} aria-hidden="true"/>{repository.private ? 'Private repository' : 'Public repository'}</li><li><GitBranch size={15} aria-hidden="true"/><span>{repository.defaultBranch}</span></li><li><GitCommitHorizontal size={15} aria-hidden="true"/>Updated <DateLabel value={repository.updatedAt}/></li></ul><Link className="repository-sidebar-link" {...repositoryOptions(location, { view: 'commits', commit: undefined, historyPath: undefined })}><GitCommitHorizontal size={15} aria-hidden="true"/>Commit history</Link></> : null}{overview ? <ul className="repository-sidebar-statistics" aria-label="Repository statistics">{overview.starsCount !== undefined ? <li><Star size={15} aria-hidden="true"/><strong>{countFormat.format(BigInt(overview.starsCount))}</strong>{overview.starsCount === '1' ? 'star' : 'stars'}</li> : null}{overview.watchersCount !== undefined ? <li><Eye size={15} aria-hidden="true"/><strong>{countFormat.format(BigInt(overview.watchersCount))}</strong>watching</li> : null}{overview.forksCount !== undefined ? <li><GitFork size={15} aria-hidden="true"/><strong>{countFormat.format(BigInt(overview.forksCount))}</strong>{overview.forksCount === '1' ? 'fork' : 'forks'}</li> : null}</ul> : null}</> : null}
    {unavailable ? <p className="repository-sidebar-note" role="status">Additional repository details unavailable.</p> : null}
  </SidebarSection>{overview ? <><SidebarSection title="Licenses">{overview.licensesState === RepositoryOverviewSectionState.AVAILABLE ? overview.licenseIds.length ? <ul className="repository-license-list">{overview.licenseIds.map(license => <li key={license}><Scale size={15} aria-hidden="true"/><span>{license}</span></li>)}</ul> : <p className="muted">No license identifiers reported.</p> : <p className="muted">{overview.licensesState === RepositoryOverviewSectionState.ERROR ? 'License details could not be read.' : overview.licensesState === RepositoryOverviewSectionState.INDEXING ? 'Reading source licenses…' : 'License details unavailable.'}</p>}{overview.licensePaths.map(path => <Link key={path} className="repository-sidebar-link" {...repositoryOptions(location, { view: 'source', path, ref: overview.indexedCommitId || location.ref, refKind: undefined, refName: undefined, tag: undefined }, 'file')}>{path}</Link>)}</SidebarSection><SidebarSection title="Languages"><Languages overview={overview}/></SidebarSection></> : null}</aside>;
}
