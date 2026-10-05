import { useEffect, useMemo } from 'react';
import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query';
import type { Client } from '@connectrpc/connect';
import { ArrowLeft, Download, Package, RefreshCw, Tag } from 'lucide-react';
import { RepositoryService, type RepositoryKey, type RepositoryRelease, type RepositoryReleaseAsset, type ListRepositoryReleasesResponse } from './gen/golf/v1/golf_pb';
import { DataTable, type DataTableColumn } from './DataTable';
import { MarkdownBody } from './RepositoryContent';
import { DateLabel, Loading, More, PanelError, privateQuery } from './RepositoryUI';
import { sourceRef, sourceRepositoryID } from './sourceReads';

type Props = { client: Client<typeof RepositoryService>; userId: string; signingOut: boolean; repository: Pick<RepositoryKey, 'owner' | 'name'>; repositoryId: string; releaseId?: string; revalidating?: boolean };
const bytes = (value: string) => new TextEncoder().encode(value).length;
const text = (value: string, max: number, empty = false) => (empty || !!value) && bytes(value) <= max && !/[\p{Cc}\p{Cs}]/u.test(value);
const count = (value: string) => value.length <= 19 && /^(0|[1-9][0-9]*)$/.test(value) && BigInt(value) <= 9223372036854775807n;
const date = (value: string) => value.length <= 64 && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,9})?(?:Z|[+-]\d\d:\d\d)$/.test(value) && Number.isFinite(Date.parse(value));
const tag = sourceRef;
const invalid = () => new Error('Release metadata could not be verified.');
const formatted = (value: string) => new Intl.NumberFormat().format(BigInt(value));
const downloadLimit = 10485760n;
function validateRelease(value: RepositoryRelease) {
 if (!sourceRepositoryID(value.id) || !text(value.title, 1024, true) || !tag(value.tagName) || !text(value.targetCommitish, 4096, true) || bytes(value.bodyMarkdown) > 128 * 1024 || /[\p{Cc}\p{Cs}]/u.test(value.bodyMarkdown.replace(/[\t\n\r]/g, '')) || !date(value.createdAt) || !date(value.publishedAt) || !count(value.assetCount) || BigInt(value.assetCount) !== BigInt(value.assets.length) || value.assets.length > 100) throw invalid();
 if (value.author && (!sourceRepositoryID(value.author.id) || !text(value.author.login, 100) || !text(value.author.fullName, 255, true))) throw invalid();
 const ids = new Set<string>();
 for (const asset of value.assets) {
  if (!sourceRepositoryID(asset.id) || ids.has(asset.id) || !text(asset.name, 1024) || !count(asset.sizeBytes) || !count(asset.downloadCount) || !date(asset.createdAt)) throw invalid();
  ids.add(asset.id);
 }
 return value;
}
function envelope(value: {repository?: RepositoryKey; repositoryId: string}, props: Props) {
 if (value.repositoryId !== props.repositoryId || value.repository?.owner !== props.repository.owner || value.repository?.name !== props.repository.name) throw invalid();
}
function validatePage(value: ListRepositoryReleasesResponse, props: Props, page: number) {
 envelope(value, props);
 if (!value.page || (value.page.nextPage !== 0 && value.page.nextPage !== page + 1) || !count(value.totalCount) || value.releases.length > 20 || BigInt(value.releases.length) > BigInt(value.totalCount) || (value.page.nextPage && value.releases.length !== 20)) throw invalid();
 const releases = new Set<string>(), assets = new Set<string>(); let noteBytes = 0;
 for (const release of value.releases) {
  validateRelease(release); if (releases.has(release.id)) throw invalid(); releases.add(release.id); noteBytes += bytes(release.bodyMarkdown);
  for (const asset of release.assets) { if (assets.has(asset.id)) throw invalid(); assets.add(asset.id); }
 }
 if (noteBytes > 512 * 1024 || assets.size > 500) throw invalid();
 return value;
}
function Badges({ release }: {release: RepositoryRelease}) {
 return <>{release.draft && <span className="visibility">Draft</span>}{release.prerelease && <span className="visibility">Pre-release</span>}</>;
}

// Scope changes remount the private reader; aborted old replies cannot restore an old account's notes.
export function RepositoryReleases(props: Props) {
 const scope = JSON.stringify([props.userId, props.repository.owner, props.repository.name, props.repositoryId, props.releaseId, props.signingOut, props.revalidating]);
 return <ReleaseReader key={scope} {...props}/>;
}
function ReleaseReader(props: Props) {
 const {client, userId, signingOut, repository, repositoryId, releaseId, revalidating} = props;
 const cache = useQueryClient();
 const enabled = !signingOut && !revalidating && sourceRepositoryID(userId) && sourceRepositoryID(repositoryId) && text(repository.owner, 100) && text(repository.name, 100) && !/[\/\\]/.test(repository.owner + repository.name) && (releaseId === undefined || sourceRepositoryID(releaseId));
 const queryKey = ['repository-releases', userId, repository.owner, repository.name, repositoryId, releaseId ?? 'inventory'];
 const list = useInfiniteQuery({...privateQuery, queryKey:[...queryKey, 'inventory'], enabled: enabled && releaseId === undefined, initialPageParam: 1,
  queryFn: async ({signal, pageParam}) => { const response = await client.listRepositoryReleases({repository, repositoryId, page:{page:pageParam, limit:20}}, {signal, timeoutMs:15000}); signal.throwIfAborted(); return validatePage(response, props, pageParam); },
  getNextPageParam: last => last.page?.nextPage || undefined});
 const detail = useQuery({...privateQuery, queryKey:[...queryKey, 'detail'], enabled:enabled && releaseId !== undefined,
  queryFn: async ({signal}) => {const response = await client.getRepositoryRelease({repository, repositoryId, releaseId}, {signal, timeoutMs:15000}); signal.throwIfAborted(); envelope(response, props); if (!response.release || response.release.id !== releaseId) throw invalid(); return validateRelease(response.release);}});
 useEffect(() => () => {void cache.cancelQueries({queryKey}); cache.removeQueries({queryKey});}, [cache]);
 const base = `/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.name)}/releases`;
 const columns = useMemo<DataTableColumn<RepositoryRelease>[]>(() => [
  {id:'release', header:'Release', accessorFn:v=>`${v.title || v.tagName} ${v.draft?'Draft':''} ${v.prerelease?'Pre-release':''}`, cell:({row})=><div className="table-primary"><a href={`${base}/${row.original.id}`}>{row.original.title || row.original.tagName}</a><div><Badges release={row.original}/></div></div>},
  {accessorKey:'tagName', header:'Tag'},
  {id:'author', header:'Author', accessorFn:v=>v.author?.login || 'Not recorded'},
  {accessorKey:'createdAt', header:'Created', cell:({row})=><DateLabel value={row.original.createdAt}/>},
  {accessorKey:'assetCount', header:'Assets', accessorFn:v=>BigInt(v.assetCount), sortFn:'basic', cell:({row})=>formatted(row.original.assetCount)},
 ], [base]);
 const assetColumns = useMemo<DataTableColumn<RepositoryReleaseAsset>[]>(() => [
  {accessorKey:'name', header:'Asset', cell:({row})=>releaseId && BigInt(row.original.sizeBytes)<=downloadLimit ? <a className="text-button" aria-label={`Download asset ${row.original.name}`} title={`Download asset ${row.original.name}`} href={`/api/repositories/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.name)}/${repositoryId}/releases/${releaseId}/assets/${row.original.id}/download`}><Download size={15} aria-hidden="true"/>{row.original.name}</a> : <div>{row.original.name}<small>Over the 10 MiB download limit</small></div>},
  {accessorKey:'sizeBytes', header:'Size', accessorFn:v=>BigInt(v.sizeBytes), sortFn:'basic', cell:({row})=>`${formatted(row.original.sizeBytes)} bytes`},
  {accessorKey:'downloadCount', header:'Native downloads', accessorFn:v=>BigInt(v.downloadCount), sortFn:'basic', cell:({row})=>formatted(row.original.downloadCount)},
  {accessorKey:'createdAt', header:'Created', cell:({row})=><DateLabel value={row.original.createdAt}/>},
 ], [repository.owner,repository.name,repositoryId,releaseId]);
 const active = releaseId === undefined ? list : detail;
 const pages = list.data?.pages;
 const duplicate = pages && (new Set(pages.flatMap(p=>p.releases.map(r=>r.id))).size !== pages.flatMap(p=>p.releases).length || pages.some(p=>p.totalCount !== pages[0]!.totalCount) || BigInt(pages.flatMap(p=>p.releases).length) > BigInt(pages[0]!.totalCount) || (!pages.at(-1)?.page?.nextPage && BigInt(pages.flatMap(p=>p.releases).length) !== BigInt(pages[0]!.totalCount)));
 const result = enabled && !active.isFetching && !active.error && !duplicate;
 const release = result && releaseId !== undefined ? detail.data : undefined;
 return <div className="page-stack"><section className="repository-intro"><div>{releaseId !== undefined && <div className="discussion-navigation"><a className="text-button" href={base}><ArrowLeft size={15}/>All releases</a></div>}<h1><Tag size={22}/>{release ? release.title || release.tagName : 'Releases'}{release && <Badges release={release}/>}</h1>{release && <div className="discussion-summary-meta"><span>Tag {release.tagName}</span><span>{release.author?.login || 'Author not recorded'}</span><span>Created <DateLabel value={release.createdAt}/></span></div>}</div><button className="icon-button" aria-label="Refresh releases" disabled={!enabled || active.isFetching} onClick={()=>void active.refetch()}><RefreshCw size={16}/></button></section>
 {!enabled ? <p className="field-help">Current repository authority is unavailable.</p> : active.error || duplicate ? <PanelError error={active.error || invalid()} retry={()=>void active.refetch()}/> : active.isFetching ? <Loading label="Loading releases…"/> : releaseId === undefined && result && pages ? <section className="browser-panel"><div className="browser-panel-heading"><h2>Release inventory</h2><span className="field-help">{formatted(pages[0]!.totalCount)} native releases · {pages.flatMap(p=>p.releases).length} loaded</span></div><DataTable label="Repository releases" data={pages.flatMap(p=>p.releases)} columns={columns} getRowId={v=>v.id} emptyMessage="No releases reported."/><More label="releases" hasMore={!!list.hasNextPage} loading={list.isFetchingNextPage} load={()=>void list.fetchNextPage()}/></section> : release ? <>
 <section className="browser-panel"><div className="browser-panel-heading"><h2>Release notes</h2></div>{release.bodyMarkdown ? <MarkdownBody text={release.bodyMarkdown} label="Release notes"/> : <p className="credential-form-content field-help">No release notes provided.</p>}</section>
 <details className="metadata-details"><summary>Native release metadata</summary><dl className="detail-grid"><div><dt>Release ID</dt><dd>{release.id}</dd></div><div><dt>Native target commitish</dt><dd>{release.targetCommitish || 'Not recorded'}</dd></div><div><dt>Native release timestamp</dt><dd><DateLabel value={release.publishedAt}/></dd></div></dl><p className="field-help">Target and timestamps are native metadata, not an exact source snapshot or proof of publication.</p></details>
 <section className="browser-panel"><div className="browser-panel-heading"><h2><Package size={17}/>Assets</h2><span className="field-help">Downloads up to 10 MiB; current access is checked on download.</span></div><DataTable label="Release assets" data={release.assets} columns={assetColumns} getRowId={v=>v.id} emptyMessage="No assets reported."/></section>
 </> : null}
 </div>;
}
