import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { ArrowUpRight, CheckCircle2, GitCommitHorizontal, LockKeyhole, Package, Play, RefreshCw } from 'lucide-react';
import { nativeAPI } from './NativeForge';
import { CopyButton, DateLabel, Loading, PageHeader, PanelError, privateQuery } from './RepositoryUI';
import { NativePackageSettings } from './NativePackageSettings';
import { NativeArtifactBrowser } from './NativeArtifactBrowser';
import { DataTable, type DataTableColumn } from './DataTable';
import type { RepositorySearch } from './navigation';
import { repositoryOptions } from './navigation';

type Props = { userId: string; repository: { owner: string; name: string }; repositoryId: string; blocked?: boolean; settings?: boolean; packageDigest?: string; packagePanel?: RepositorySearch['packagePanel'] };
type Artifact = { tag: string; digest: string; mediaType: string; size: number; platforms: string[]; publishedAt: string; scanStatus: 'not_configured'; build?: { jobId: string; commitId: string; pullNumber: number } };
type Status = { repositoryId: string; enabled: boolean; canManage: boolean; canPush: boolean; provider?: 'cloudflare'; registry?: string; name?: string; imageRepository?: string; artifacts?: Artifact[]; truncated?: boolean; usedBytes?: number; reservedBytes?: number; limits?: { maxBlobBytes: number; maxRepositoryBytes: number; maxRequestBytes: number; deletionGrace: number } };
type Credential = { repositoryId: string; credential: string; expiresAt: number; registry: string; name: string; username: string };
const scope = (p: Props) => ['native-packages', p.userId, p.repositoryId, p.repository.owner, p.repository.name];
function usePackages(p: Props) {
  return useQuery({ ...privateQuery, queryKey: scope(p), enabled: !p.blocked, retry: false,
    queryFn: async ({ signal }) => {
      const value = await nativeAPI<Status>('/native/repository-packages', { repository: p.repository, repositoryId: p.repositoryId, action: 'status' }, signal);
      if (value.repositoryId !== p.repositoryId || typeof value.enabled !== 'boolean' || typeof value.canManage !== 'boolean' || typeof value.canPush !== 'boolean' || value.enabled &&
        (value.name !== `${p.repository.owner}/${p.repository.name}` || !value.registry || !Array.isArray(value.artifacts) || value.artifacts.some(a => !/^(sha256:[a-f0-9]{64}|sha512:[a-f0-9]{128})$/.test(a.digest) || typeof a.tag !== 'string' || !Array.isArray(a.platforms)))) throw Error('Package inventory identity could not be verified.');
      if (value.provider !== undefined && value.provider !== 'cloudflare' || value.provider === 'cloudflare' && (value.registry !== 'https://registry.cloudflare.com' || !new RegExp('^[a-f0-9]{32}/[a-z0-9-]+-r' + p.repositoryId + '$').test(value.imageRepository || ''))) throw Error('Managed registry identity could not be verified.');
      if (value.artifacts?.some(a => a.build && (!/^ci-[a-f0-9-]{36}$/.test(a.tag) || a.tag !== 'ci-'+a.build.jobId || !/^[a-f0-9]{40}$/.test(a.build.commitId) || !Number.isSafeInteger(a.build.pullNumber) || a.build.pullNumber<1 || !Number.isFinite(Date.parse(a.publishedAt))))) throw Error('Package build receipt could not be verified.');
      if (value.enabled && value.provider !== 'cloudflare' && (!value.limits || ![value.usedBytes, value.reservedBytes, value.limits.maxBlobBytes, value.limits.maxRepositoryBytes, value.limits.maxRequestBytes, value.limits.deletionGrace].every(v => Number.isSafeInteger(v) && v! >= 0) || !value.limits.maxRequestBytes)) throw Error('Package storage limits could not be verified.');
      if (value.registry) { const url = new URL(value.registry); if (url.origin !== value.registry || !['https:', 'http:'].includes(url.protocol)) throw Error('Registry destination could not be verified.'); }
      return value;
    } });
}

export function NativePackagesTab(p: Props & { selected?: boolean }) {
  // The enclosing capability/access gate admits navigation; inventory belongs to its page.
  return !p.blocked && p.repositoryId ? <Link {...repositoryOptions(p.repository, { view: 'packages' })} aria-current={p.selected ? 'page' : undefined}><Package size={16} />Packages</Link> : null;
}

export function NativePackages(p: Props) {
  return <Packages key={JSON.stringify([p.userId, p.repositoryId, p.repository])} {...p} />;
}
function Packages(p: Props) {
  const cache = useQueryClient(), status = usePackages(p);
  const [credential, setCredential] = useState<Credential | null>(null);
  const [notice, setNotice] = useState('');
  const alive = useRef(true), controller = useRef<AbortController | null>(null);
  const mutation = useMutation({ retry: false, mutationFn: async (action: 'enable' | 'credential' | 'revoke') => {
    controller.current = new AbortController(); setCredential(null); setNotice('');
    const value = await nativeAPI<Status | Credential>('/native/repository-packages', { repository: p.repository, repositoryId: p.repositoryId, action }, controller.current.signal);
    if (!alive.current) return;
    if (value.repositoryId !== p.repositoryId) throw Error('Package operation receipt could not be verified.');
    if (action === 'credential') {
      const result = value as Credential;
      if (!/^cfcr\.[A-Za-z0-9_-]+\.[a-f0-9]{64}$/.test(result.credential) || result.registry !== status.data?.registry || result.name !== status.data?.name || !Number.isSafeInteger(result.expiresAt) || result.expiresAt <= Date.now()) throw Error('Registry credential receipt could not be verified.');
      setCredential(result);
    } else setNotice(action === 'enable' ? 'Packages enabled.' : 'Your registry credentials have been revoked.');
    await cache.invalidateQueries({ queryKey: scope(p) });
  } });
  useEffect(() => {
    alive.current = true;
    const off = cache.getQueryCache().subscribe(() => {
      const user = cache.getQueryData<{ id: string }>(['session']);
      if (user?.id !== p.userId) { setCredential(null); controller.current?.abort(); }
    });
    return () => { alive.current = false; off(); controller.current?.abort(); };
  }, [cache, p.userId]);
  useEffect(() => { if (p.blocked || status.isError || status.data?.canPush === false) setCredential(null); }, [p.blocked, status.isError, status.data?.canPush]);
  useEffect(() => { if (!credential) return; const timer = setTimeout(() => setCredential(null), Math.max(0, credential.expiresAt - Date.now())); return () => clearTimeout(timer); }, [credential]);
  const value = !p.blocked && !status.isError && !status.isFetching ? status.data : undefined;
  const target = value?.registry && value.name ? `${new URL(value.registry).host}/${value.imageRepository || value.name}` : '';
  if (value?.provider === 'cloudflare') return <ManagedImages {...p} value={value} target={target} refresh={() => void status.refetch()} />;
  return <section className="browser-panel credential-list-panel" aria-labelledby="native-packages-title">
    <div className="browser-panel-heading"><h2 id="native-packages-title"><Package size={18} />Packages</h2><button className="icon-button" title="Refresh packages" aria-label="Refresh packages" disabled={status.isFetching || mutation.isPending || p.blocked} onClick={() => void status.refetch()}><RefreshCw size={16} /></button></div>
    {status.isError ? <PanelError error={status.error} retry={() => void status.refetch()} /> : !value ? <Loading label="Checking current package access…" /> : <div className="credential-form-content">
      {!value.enabled ? <><p>Publish container images and OCI artifacts from this repository.</p><p className="field-help">Packages start private and inherit this repository’s access. Readers can pull; writers can publish. Enabling packages does not start builds or uploads.</p>{value.canManage ? <button className="button" disabled={mutation.isPending} onClick={() => mutation.mutate('enable')}>Enable packages</button> : <p>A repository administrator can enable packages.</p>}</> : <>
        <dl className="settings-profile"><div><dt>Registry repository</dt><dd><code>{target}</code></dd></div><div><dt>Access</dt><dd>Private · inherited from this Git repository · {value.canPush ? 'publish and pull' : 'pull only'}</dd></div><div><dt>Storage</dt><dd>{((value.usedBytes || 0) / 1024 ** 3).toFixed(2)} GiB stored · {((value.reservedBytes || 0) / 1024 ** 3).toFixed(2)} GiB uploading · {((value.limits?.maxRepositoryBytes || 0) / 1024 ** 3).toFixed(0)} GiB limit</dd></div></dl>
        {p.settings ? <><NativePackageSettings {...p} canManage={value.canManage} /><Link className="button secondary" {...repositoryOptions(p.repository, { view: 'packages' })}>Open packages</Link></> : <>
          <NativeArtifactBrowser {...p} canManage={value.canManage} canPush={value.canPush} target={target} />
          <h3>Publish and pull</h3><p>Create a one-hour credential for this registry repository. Current Git access is checked on every registry request.</p>
          <div className="credential-actions"><button className="button secondary" disabled={mutation.isPending} onClick={() => mutation.mutate('credential')}>Create registry credential</button><button className="button secondary" disabled={mutation.isPending} onClick={() => mutation.mutate('revoke')}>Revoke my registry credentials</button></div>
          {credential ? <div><label htmlFor="cfcr-credential">Registry credential · expires {new Date(credential.expiresAt).toLocaleTimeString()}</label><div className="copy-field"><input id="cfcr-credential" type="password" value={credential.credential} readOnly autoComplete="off" /><CopyButton text={credential.credential} label="Copy registry credential" /></div><p className="field-help">Shown once. Paste this at Docker’s password prompt.</p><button className="text-button" onClick={() => setCredential(null)}>Dismiss credential</button></div> : null}
          <div className="code-block"><pre>{`docker login ${new URL(value.registry!).host} --username golf\n${value.canPush ? `docker tag YOUR_IMAGE ${target}:latest\ndocker push ${target}:latest\n` : ''}docker pull ${target}:latest`}</pre></div>
          <p className="field-help">Maximum layer: {((value.limits?.maxBlobBytes || 0) / 1024 ** 3).toFixed(1)} GiB. Each upload request can contain up to {((value.limits?.maxRequestBytes || 0) / 1024 ** 2).toFixed(0)} MiB. For larger layers, use the chunked upload commands below; ordinary Docker push may exceed the request limit.</p>
          {value.canPush ? <details><summary>Upload larger layers</summary><p>Install regctl, then create a registry credential and use it at the login prompt.</p><div className="code-block"><pre>{`regctl registry login ${new URL(value.registry!).host} --user golf\nregctl registry set ${new URL(value.registry!).host} --blob-chunk ${Math.min(32 * 1024 ** 2, value.limits!.maxRequestBytes)} --blob-max ${Math.min(32 * 1024 ** 2, value.limits!.maxRequestBytes)}\ndocker save YOUR_IMAGE -o image.tar\nregctl image import ${target}:latest image.tar\ndocker pull ${target}:latest`}</pre></div></details> : null}
          <p className="field-help">Deleted content remains charged during its {Math.ceil((value.limits?.deletionGrace || 0) / 60_000)} minute recovery window and until safe cleanup completes.</p>
        </>}
      </>}
    </div>}
    {mutation.isError ? <p className="error" role="alert">{mutation.error.message} Refresh to inspect the current state before retrying.</p> : null}
    {notice && value ? <p role="status" className="session-notice">{notice}</p> : null}
  </section>;
}

function RegistryConnection({ target }: { target: string }) {
  return <details className="metadata-details panel-disclosure package-registry-details"><summary>Registry connection</summary><div className="copy-field"><code>{target}</code><CopyButton text={target} label="Copy image repository"/></div><p className="field-help">CI publishes through the installation’s registry connection. Direct registry login, downloads and manual publishing are not available here.</p></details>;
}

function ManagedImages({ value, target, repository, refresh, settings }: Props & { value: Status; target: string; refresh: () => void }) {
  if (settings) return <section className="browser-panel" aria-labelledby="native-package-settings-title">
    <div className="browser-panel-heading"><h2 id="native-package-settings-title">Packages</h2><Link className="button secondary" {...repositoryOptions(repository,{view:'packages'})}>Open packages<ArrowUpRight size={14}/></Link></div>
    <div className="credential-form-content"><dl className="settings-profile"><div><dt>Storage</dt><dd>Cloudflare managed registry</dd></div><div><dt>Access</dt><dd>Private · repository permissions</dd></div><div><dt>Publishing</dt><dd>Approved CI jobs</dd></div></dl><RegistryConnection target={target}/></div>
  </section>;
  const artifacts = [...(value.artifacts || [])].sort((a,b) => (b.publishedAt || '').localeCompare(a.publishedAt || ''));
  const columns: DataTableColumn<Artifact>[] = [
    { accessorKey: 'tag', header: 'Artifact', cell: ({ row }) => <div className="package-artifact"><span className="package-artifact-icon"><Package size={20}/></span><div><strong>{repository.name}</strong><small title={row.original.tag}>CI build · {row.original.tag.replace(/^ci-/,'').slice(0,8)}</small></div></div> },
    { id: 'source', header: 'Source', accessorFn: image => image.build?.commitId || '', cell: ({ row }) => row.original.build ? <Link className="package-source" {...repositoryOptions(repository,{view:'source',ref:row.original.build.commitId})}><GitCommitHorizontal size={14}/><code>{row.original.build.commitId.slice(0,8)}</code></Link> : <span className="muted">—</span> },
    { accessorKey: 'digest', header: 'Digest', cell: ({ row }) => <span className="copy-field"><code title={row.original.digest}>{row.original.digest.slice(0, 23)}…</code><CopyButton text={`${target}@${row.original.digest}`} label="Copy immutable image reference" /></span> },
    { accessorKey: 'publishedAt', header: 'Published', cell: ({ row }) => row.original.publishedAt ? <DateLabel value={row.original.publishedAt} relative/> : <span className="muted">—</span> },
    { id: 'build', header: '', enableSorting: false, enableGlobalFilter: false, cell: ({ row }) => <Link className="text-button" {...repositoryOptions(repository,row.original.build ? {view:'pulls',pull:row.original.build.pullNumber} : {view:'actions'})}>View build<ArrowUpRight size={14}/></Link> },
  ];
  return <div className="page-stack repository-work-page">
    <PageHeader title="Packages" description={`Build artifacts published by ${repository.name} CI.`} actions={<button className="button secondary" onClick={refresh}><RefreshCw size={15}/>Refresh</button>}/>
    <section className="browser-panel package-inventory" aria-labelledby="native-packages-title"><div className="browser-panel-heading"><h3 id="native-packages-title"><Package size={17}/>Published artifacts<span className="package-count">{artifacts.length}{value.truncated?'+':''}</span></h3><span className="package-provider"><LockKeyhole size={12}/>Private · Cloudflare</span></div>
      {artifacts.length ? <><div className="package-inventory-note"><CheckCircle2 size={14}/><span>Published by CI · immutable content digests</span><span className="package-format">OCI</span></div><DataTable data={artifacts} columns={columns} getRowId={image => image.tag} label="artifacts"/></> : <div className="empty-state package-empty"><span className="package-empty-icon"><Package size={30}/></span><h3>Your next build starts here</h3><p>Wheels, source archives and build reports appear here after CI publishes them.</p><Link className="button secondary" {...repositoryOptions(repository,{view:'actions'})}><Play size={14}/>Open Actions</Link></div>}
      {value.truncated ? <p className="panel-footnote">Showing {artifacts.length} named tags from the start of the registry’s tag list; more entries follow it. Search and sorting cover only these. Refresh to update the loaded inventory.</p> : null}
    </section>
    <RegistryConnection target={target}/>
  </div>;
}
