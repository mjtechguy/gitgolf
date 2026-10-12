import { useState } from 'react';
import { useForm } from '@tanstack/react-form';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { nativeAPI } from './NativeForge';
import { CopyButton, DateLabel, Loading, PanelError, privateQuery } from './RepositoryUI';
import { DataTable, type DataTableColumn } from './DataTable';
import { repositoryOptions, type RepositorySearch } from './navigation';

type Props = { userId: string; repository: { owner: string; name: string }; repositoryId: string; target: string; canPush: boolean; canManage?: boolean; packageDigest?: string; packagePanel?: RepositorySearch['packagePanel'] };
type Descriptor = { digest: string; mediaType: string; size: number; platform?: { os?: string; architecture?: string; variant?: string } };
type Artifact = Descriptor & { revision: number; hold: { reason: string } | null; tags: string[]; publishedAt: string; artifactType?: string; evidence: { state: string; finishedAt?: string; completed?: number; required?: number; platforms?: { digest: string; state: string }[] }; platforms: Descriptor[]; layers: Descriptor[]; manifest: unknown; links: { kind: string; url: string; label: string; verified: boolean }[] };
type Attachment = Descriptor & { artifactType?: string; provenance: string; verified: boolean; layers: Descriptor[] };
type Page<T> = { repositoryId: string; items: T[]; next: string | null; revision: number };
type ReportRow = { index?: number; id?: string; name?: string; version?: string; type?: string; purl?: string; licenses?: string[]; severity?: string; fixed?: string; source?: string; status?: string };
type Report = Page<ReportRow> & { kind: string; format: string; provenance: string; verified: boolean; total: number; matched: number; verification?: { keyName: string; fingerprint: string; predicateType?: string; verifiedAt: string } | null };
function usePackageQuery<T extends { repositoryId: string }>(p: Props, input: Record<string, unknown>) {
  return useQuery({ ...privateQuery, retry: false, queryKey: ['native-package-content', p.userId, p.repositoryId, p.repository.owner, p.repository.name, input], queryFn: async ({ signal }) => {
    const value = await nativeAPI<T>('/native/repository-packages', { ...input, repository: p.repository, repositoryId: p.repositoryId }, signal);
    if (value.repositoryId !== p.repositoryId) throw Error('Package response belongs to a different repository.');
    return value;
  } });
}
function PageControls({ next, history, setHistory, refresh }: { next?: string | null; history: (string | undefined)[]; setHistory: (h: (string | undefined)[]) => void; refresh: () => void }) {
  return <div className="credential-actions"><button className="button secondary" disabled={history.length < 2} onClick={() => setHistory(history.slice(0, -1))}>Previous page</button><button className="button secondary" disabled={!next} onClick={() => setHistory([...history, next!])}>Next page</button><button className="text-button" onClick={() => { setHistory([undefined]); refresh(); }}>Refresh from first page</button></div>;
}
function Search({ onSearch }: { onSearch: (q: string) => void }) {
  const form = useForm({ defaultValues: { query: '' }, onSubmit: ({ value }) => onSearch(value.query) });
  return <form onSubmit={event => { event.preventDefault(); void form.handleSubmit(); }}><form.Field name="query">{field => <label>Search all entries<input type="search" value={field.state.value} maxLength={256} onChange={e => field.handleChange(e.target.value)} /></label>}</form.Field><button className="button secondary" type="submit">Search</button></form>;
}
const showDigest = (id: string) => <span className="copy-field"><code title={id}>{id.slice(0, 23)}…</code><CopyButton text={id} label="Copy digest" /></span>;
export function NativeArtifactBrowser(p: Props) {
  return p.packageDigest ? <Detail key={p.packageDigest} {...p} /> : <><Inventory {...p} /><Jobs {...p} /></>;
}
function Inventory(p: Props) {
  const [history, setHistory] = useState<(string | undefined)[]>([undefined]), [query, setQuery] = useState('');
  const result = usePackageQuery<Page<Artifact>>(p, { action: 'inventory', kind: 'artifacts', query, cursor: history.at(-1), limit: 50 });
  const columns: DataTableColumn<Artifact>[] = [
    { id: 'digest', header: 'Artifact', cell: ({ row }) => <Link {...repositoryOptions(p.repository, { view: 'packages', packageDigest: row.original.digest })}><code>{row.original.digest.slice(0, 23)}…</code></Link> },
    { id: 'tags', header: 'Tags', accessorFn: a => a.tags.join(', ') || 'Untagged' },
    { id: 'type', header: 'Type', accessorFn: a => a.artifactType || a.mediaType },
    { id: 'scan', header: 'Scan state', accessorFn: a => a.evidence.state.replaceAll('_', ' ') },
    { accessorKey: 'publishedAt', header: 'Published', cell: ({ row }) => <DateLabel value={row.original.publishedAt} /> },
  ];
  return <><h3>Artifacts</h3><Search onSearch={q => { setQuery(q); setHistory([undefined]); }} />
    {result.isError ? <PanelError error={result.error} retry={() => { setHistory([undefined]); void result.refetch(); }} /> : result.isFetching || !result.data ? <Loading label="Loading artifacts…" /> : <DataTable data={result.data.items} columns={columns} getRowId={a => a.digest} label="artifacts" emptyMessage="No artifacts match this page. Publish an image or continue to the next page." />}
    <PageControls next={result.data?.next} history={history} setHistory={setHistory} refresh={() => void result.refetch()} /></>;
}
function Detail(p: Props) {
  const cache = useQueryClient();
  const action = useMutation({ mutationFn: (action: string) => nativeAPI('/native/repository-packages', { repository: p.repository, repositoryId: p.repositoryId, action, reference: p.packageDigest, idempotencyKey: crypto.randomUUID() }), onSuccess: () => cache.invalidateQueries({ queryKey: ['native-package-content', p.userId, p.repositoryId] }) });
  const detail = usePackageQuery<Artifact & { repositoryId: string }>(p, { action: 'artifact', reference: p.packageDigest });
  if (detail.isError) return <PanelError error={detail.error} retry={() => void detail.refetch()} />;
  if (detail.isFetching || !detail.data) return <Loading label="Loading immutable artifact…" />;
  const a = detail.data, panel = p.packagePanel || 'overview';
  return <><Link {...repositoryOptions(p.repository, { view: 'packages' })}>All artifacts</Link><h3>Artifact {showDigest(a.digest)}</h3>
    <p>{a.tags.join(', ') || 'Untagged'} · Published <DateLabel value={a.publishedAt} /></p><div className="copy-field"><code>docker pull {p.target}@{a.digest}</code><CopyButton text={`docker pull ${p.target}@${a.digest}`} label="Copy immutable pull command" /></div>
    {p.canPush ? <div className="credential-actions"><button className="button secondary" disabled={action.isPending} onClick={() => action.mutate('scan')}>Request scan</button><button className="button secondary" disabled={action.isPending} onClick={() => action.mutate('verify')}>Verify signatures and attestations</button></div> : null}
    {action.isError ? <p className="error" role="alert">{action.error.message}</p> : action.isSuccess ? <p role="status">Request recorded. Refresh to inspect its current result.</p> : null}
    <PolicyStatus {...p} />
    {p.canPush ? <ArtifactActions {...p} revision={a.revision} hold={a.hold} /> : null}
    <nav className="credential-actions" aria-label="Artifact details">{(['overview', 'sbom', 'vulnerabilities', 'signatures', 'provenance', 'activity'] as const).map(tab => <Link key={tab} {...repositoryOptions(p.repository, { view: 'packages', packageDigest: a.digest, packagePanel: tab })} aria-current={panel === tab ? 'page' : undefined}>{tab === 'sbom' ? 'SBOM' : tab.charAt(0).toUpperCase() + tab.slice(1)}</Link>)}</nav>
    {panel === 'overview' ? <><dl className="settings-profile"><div><dt>Media type</dt><dd>{a.mediaType}</dd></div><div><dt>Manifest size</dt><dd>{a.size.toLocaleString()} bytes</dd></div><div><dt>Scan state</dt><dd>{a.evidence.state.replaceAll('_', ' ')}{a.evidence.required !== undefined ? ` · ${a.evidence.completed}/${a.evidence.required} image manifests scanned` : ''}</dd></div></dl>
      {a.platforms.length ? <><h4>Declared platforms</h4><ul>{a.platforms.map(d => <li key={d.digest}><Link {...repositoryOptions(p.repository, { view: 'packages', packageDigest: d.digest })}>{[d.platform?.os, d.platform?.architecture, d.platform?.variant].filter(Boolean).join('/') || 'Platform not declared'} · {d.digest}</Link> · {a.evidence.platforms?.find(e => e.digest === d.digest)?.state.replaceAll('_', ' ') || 'Inspect platform evidence'}</li>)}</ul></> : null}
      <h4>Config and layers</h4><DataTable data={a.layers.map((d, i) => ({ ...d, index: i }))} columns={[{ id: 'digest', header: 'Digest', cell: ({ row }) => showDigest(row.original.digest) }, { accessorKey: 'mediaType', header: 'Type' }, { accessorKey: 'size', header: 'Bytes' }]} getRowId={d => String(d.index)} label="layers" />
      <details><summary>Exact manifest document</summary><div className="code-block"><pre>{JSON.stringify(a.manifest, null, 2)}</pre></div></details></> : panel === 'activity' ? <Activity {...p} /> : <Evidence key={panel} {...p} panel={panel} />}
    {a.links.length ? <><h4>Source and builds</h4><ul>{a.links.map((link, i) => <li key={i}><a href={link.url}>{link.label || link.kind}</a> · {link.verified ? 'Verified' : 'Supplied link'}</li>)}</ul></> : null}
  </>;
}
function Activity(p: Props) {
  const [history, setHistory] = useState<(string | undefined)[]>([undefined]);
  const result = usePackageQuery<Page<{ revision: number; at: string; type: string; actorId: string; detail: unknown }>>(p, { action: 'activity', reference: p.packageDigest, cursor: history.at(-1) });
  return <>{result.isError ? <PanelError error={result.error} retry={() => void result.refetch()} /> : !result.data || result.isFetching ? <Loading label="Loading activity…" /> : <DataTable data={result.data.items} columns={[{ accessorKey: 'type', header: 'Event' }, { accessorKey: 'actorId', header: 'Actor' }, { accessorKey: 'at', header: 'Time', cell: ({ row }) => <DateLabel value={row.original.at} /> }, { id: 'detail', header: 'Details', accessorFn: r => JSON.stringify(r.detail) }]} getRowId={r => String(r.revision)} label="artifact activity" />}<PageControls next={result.data?.next} history={history} setHistory={setHistory} refresh={() => void result.refetch()} /></>;
}
function Evidence(p: Props & { panel: string }) {
  const [history, setHistory] = useState<(string | undefined)[]>([undefined]), [selected, setSelected] = useState<{ attachment: string; blob: string }>();
  const result = usePackageQuery<Page<Attachment>>(p, { action: 'attachments', kind: p.panel, reference: p.packageDigest, cursor: history.at(-1) });
  if (selected) return <><button className="text-button" onClick={() => setSelected(undefined)}>Back to attached evidence</button><ReportViewer key={selected.blob} {...p} {...selected} /></>;
  return <><h4>{p.panel === 'sbom' ? 'Software bill of materials' : p.panel.charAt(0).toUpperCase() + p.panel.slice(1)}</h4><p className="field-help">Evidence is attached to this immutable digest. Supplied reports and signatures remain unverified until a configured verifier checks their subject and trust policy. No report does not mean no vulnerabilities.</p>
    {result.isError ? <PanelError error={result.error} retry={() => void result.refetch()} /> : !result.data || result.isFetching ? <Loading label="Loading attached evidence…" /> : <DataTable data={result.data.items} columns={[
      { id: 'digest', header: 'Evidence', cell: ({ row }) => showDigest(row.original.digest) }, { id: 'type', header: 'Type', accessorFn: r => r.artifactType || r.mediaType }, { accessorKey: 'provenance', header: 'Origin' }, { id: 'trust', header: 'Verification', accessorFn: r => r.verified ? 'Signature verified' : 'Not verified' },
      { id: 'reports', header: 'Reports', cell: ({ row }) => <>{row.original.layers.map((d, i) => <button key={d.digest + i} className="text-button" onClick={() => setSelected({ attachment: row.original.digest, blob: d.digest })}>Open {d.mediaType}</button>)}</> },
    ]} getRowId={r => r.digest} label="attached evidence" emptyMessage="No attached evidence on this page. For multi-platform images, also inspect each platform digest." />}
    <PageControls next={result.data?.next} history={history} setHistory={setHistory} refresh={() => void result.refetch()} /></>;
}
function ReportViewer(p: Props & { attachment: string; blob: string }) {
  const download = useMutation({ mutationFn: async () => {
    const value = await nativeAPI<{ repositoryId: string; subject: string; attachment: string; blob: string; size: number; encoding: string; content: string }>('/native/repository-packages', { repository: p.repository, repositoryId: p.repositoryId, action: 'downloadReport', reference: p.packageDigest, attachment: p.attachment, blob: p.blob });
    if (value.repositoryId !== p.repositoryId || value.subject !== p.packageDigest || value.attachment !== p.attachment || value.blob !== p.blob || value.encoding !== 'base64' || value.content.length > 12 * 1024 ** 2) throw Error('Report download identity mismatch.');
    const bytes = Uint8Array.from(atob(value.content), c => c.charCodeAt(0));
    const hash = new Uint8Array(await crypto.subtle.digest(p.blob.startsWith('sha512:') ? 'SHA-512' : 'SHA-256', bytes));
    if (bytes.length !== value.size || [...hash].map(b => b.toString(16).padStart(2, '0')).join('') !== p.blob.split(':')[1]) throw Error('Report download integrity mismatch.');
    const url = URL.createObjectURL(new Blob([bytes], { type: 'application/octet-stream' })), link = document.createElement('a');
    link.href = url; link.download = p.blob.replace(':', '-') + '.report'; document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  } });
  const [history, setHistory] = useState<(string | undefined)[]>([undefined]), [query, setQuery] = useState('');
  const result = usePackageQuery<Report>(p, { action: 'report', reference: p.packageDigest, attachment: p.attachment, blob: p.blob, query, cursor: history.at(-1) });
  const report = result.data;
  const columns: DataTableColumn<ReportRow>[] = report?.kind === 'vulnerabilities' ? [
    { accessorKey: 'id', header: 'Vulnerability' }, { accessorKey: 'severity', header: 'Severity' }, { accessorKey: 'name', header: 'Package' }, { accessorKey: 'version', header: 'Installed' }, { accessorKey: 'fixed', header: 'Fixed versions' }, { accessorKey: 'status', header: 'Status' },
  ] : [{ accessorKey: 'name', header: 'Package' }, { accessorKey: 'version', header: 'Version' }, { accessorKey: 'type', header: 'Type' }, { accessorKey: 'purl', header: 'Package URL' }, { id: 'licenses', header: 'Licenses', accessorFn: r => r.licenses?.join(', ') || 'Not declared' }];
  return <>{report?.kind === 'sbom' ? <SbomCompare {...p} /> : null}<button className="button secondary" disabled={download.isPending} onClick={() => download.mutate()}>Download original report</button>{download.isError ? <p role="alert" className="error">{download.error.message}</p> : null}<Search onSearch={q => { setQuery(q); setHistory([undefined]); }} />{result.isError ? <PanelError error={result.error} retry={() => void result.refetch()} /> : !report || result.isFetching ? <Loading label="Reading report…" /> : <><p>{report.format} · {report.provenance} · {report.verified ? 'Signature and subject verified' : 'Not verified'} · {report.matched.toLocaleString()} matching of {report.total.toLocaleString()} records</p>{report.verification ? <p>{report.verification.keyName} · <code>{report.verification.fingerprint}</code> · <DateLabel value={report.verification.verifiedAt} />{report.verification.predicateType ? <> · <code>{report.verification.predicateType}</code></> : null}. The signature authenticates the signer’s claims; it does not independently prove the build or a SLSA level.</p> : null}{['sbom', 'vulnerabilities'].includes(report.kind) ? <DataTable data={report.items.map((r, i) => ({ ...r, index: i }))} columns={columns} getRowId={r => String(r.index)} label="report records" /> : <div className="code-block"><pre>{JSON.stringify(report.items, null, 2)}</pre></div>}</>}
    <PageControls next={report?.next} history={history} setHistory={setHistory} refresh={() => void result.refetch()} /></>;
}

function PolicyStatus(p: Props) {
  const policy = usePackageQuery<{ repositoryId: string; allowed: boolean; mode: string; reasons: string[] }>(p, { action: 'policy', reference: p.packageDigest });
  const verification = usePackageQuery<{ repositoryId: string; verification: { state: string; verifiedAt?: string; signatures?: { keyName: string; fingerprint: string }[]; attestations?: { keyName: string; fingerprint: string; predicateType: string; payload: string }[] } }>(p, { action: 'verification', reference: p.packageDigest });
  return <><p>Policy: {policy.isError ? 'Unavailable' : !policy.data ? 'Checking…' : (policy.data.allowed ? 'Approved' : 'Not approved') + ' · ' + policy.data.mode}</p>{policy.data?.reasons.length ? <ul>{policy.data.reasons.map(reason => <li key={reason}>{reason}</li>)}</ul> : null}<p>Image signature verification: {verification.isError ? 'Unavailable' : verification.data?.verification.state.replaceAll('_', ' ') || 'Checking…'}</p>{verification.data?.verification.signatures?.map(s => <p key={s.fingerprint}>{s.keyName} · <code>{s.fingerprint}</code></p>)}{verification.data?.verification.attestations?.map(a => <p key={a.payload}>Attestation signature verified: {a.predicateType} · {a.keyName} · <code>{a.fingerprint}</code></p>)}</>;
}

function Jobs(p: Props) {
  const [history, setHistory] = useState<(string | undefined)[]>([undefined]);
  const result = usePackageQuery<Page<{ id: string; subject: string; state: string; createdAt: string; error?: string }>>(p, { action: 'jobs', reference: p.packageDigest, cursor: history.at(-1) });
  const cache = useQueryClient();
  const cancel = useMutation({ mutationFn: (jobId: string) => nativeAPI('/native/repository-packages', { repository: p.repository, repositoryId: p.repositoryId, action: 'cancelScan', jobId }), onSuccess: () => cache.invalidateQueries({ queryKey: ['native-package-content', p.userId, p.repositoryId] }) });
  return <details><summary>Scan jobs</summary>{result.isError ? <PanelError error={result.error} retry={() => void result.refetch()} /> : !result.data || result.isFetching ? <Loading label="Loading scan jobs…" /> : <DataTable data={result.data.items} columns={[
    { id: 'subject', header: 'Artifact', cell: ({ row }) => <Link {...repositoryOptions(p.repository, { view: 'packages', packageDigest: row.original.subject })}>{row.original.subject.slice(0, 23)}…</Link> }, { accessorKey: 'state', header: 'State' }, { accessorKey: 'createdAt', header: 'Requested', cell: ({ row }) => <DateLabel value={row.original.createdAt} /> }, { accessorKey: 'error', header: 'Failure detail' }, { id: 'cancel', header: 'Actions', cell: ({ row }) => p.canPush && ['queued', 'dispatching', 'running'].includes(row.original.state) ? <button className="text-button" disabled={cancel.isPending} onClick={() => cancel.mutate(row.original.id)}>Cancel scan</button> : null },
  ]} getRowId={r => r.id} label="scan jobs" />}<PageControls next={result.data?.next} history={history} setHistory={setHistory} refresh={() => void result.refetch()} />{cancel.isError ? <p role="alert" className="error">{cancel.error.message}</p> : null}</details>;
}
function ArtifactActions(p: Props & { revision: number; hold: { reason: string } | null }) {
  const cache = useQueryClient();
  const mutation = useMutation({ mutationFn: (input: Record<string, unknown>) => nativeAPI('/native/repository-packages', { ...input, repository: p.repository, repositoryId: p.repositoryId, reference: p.packageDigest, expectedRevision: p.revision }), onSuccess: () => cache.invalidateQueries({ queryKey: ['native-package-content', p.userId, p.repositoryId] }) });
  const promotion = useForm({ defaultValues: { tag: '' }, onSubmit: ({ value }) => mutation.mutate({ action: 'promote', tag: value.tag }) });
  const hold = useForm({ defaultValues: { reason: '' }, onSubmit: ({ value }) => mutation.mutate({ action: 'hold', enabled: !p.hold, reason: value.reason }) });
  const source = useForm({ defaultValues: { kind: 'build', label: '', url: '' }, onSubmit: ({ value }) => mutation.mutate({ action: 'link', links: [value] }) });
  return <>{p.hold ? <p role="status">Artifact held: {p.hold.reason}</p> : null}{p.canManage ? <details><summary>{p.hold ? 'Release artifact hold' : 'Place artifact hold'}</summary><form onSubmit={e => { e.preventDefault(); void hold.handleSubmit(); }}><hold.Field name="reason">{field => <label>Reason<input value={field.state.value} maxLength={1024} required onChange={e => field.handleChange(e.target.value)} /></label>}</hold.Field><button className="button secondary" disabled={mutation.isPending}>{p.hold ? 'Release hold' : 'Hold artifact'}</button></form></details> : null}<details><summary>Promote this digest</summary><form onSubmit={e => { e.preventDefault(); void promotion.handleSubmit(); }}><promotion.Field name="tag">{field => <label>Destination tag<input value={field.state.value} maxLength={128} required onChange={e => field.handleChange(e.target.value)} /></label>}</promotion.Field><button type="submit" className="button secondary" disabled={mutation.isPending}>Promote digest</button></form></details>
    <details><summary>Set source link</summary><p className="field-help">This replaces the artifact’s source links. Supplied links are labelled unverified.</p><form onSubmit={e => { e.preventDefault(); void source.handleSubmit(); }}><source.Field name="kind">{field => <label>Link type<select value={field.state.value} onChange={e => field.handleChange(e.target.value)}>{['commit', 'build', 'release'].map(kind => <option key={kind} value={kind}>{kind}</option>)}</select></label>}</source.Field><source.Field name="label">{field => <label>Label<input value={field.state.value} maxLength={256} onChange={e => field.handleChange(e.target.value)} /></label>}</source.Field><source.Field name="url">{field => <label>Golf repository URL<input type="url" required value={field.state.value} maxLength={2048} onChange={e => field.handleChange(e.target.value)} /></label>}</source.Field><button className="button secondary" disabled={mutation.isPending}>Save source link</button></form></details>
    {mutation.isError ? <p role="alert" className="error">{mutation.error.message}</p> : null}<Jobs {...p} /></>;
}


type ReportSelection = { reference: string; attachment: string; blob: string };
function SbomCompare(p: Props & { attachment: string; blob: string }) {
  const [baseline, setBaseline] = useState(''), [selected, setSelected] = useState<ReportSelection>();
  const form = useForm({ defaultValues: { digest: '' }, onSubmit: ({ value }) => { setSelected(undefined); setBaseline(value.digest); } });
  return <details><summary>Compare with another SBOM</summary><p className="field-help">Compare the same format, up to 2 MiB and 10,000 packages per report. This compares package names, versions, types, package URLs, licenses and occurrence counts. Version or license changes appear as a removal and an addition. Report-local IDs and dependency relationships are excluded.</p>
    <form onSubmit={e => { e.preventDefault(); void form.handleSubmit(); }}><form.Field name="digest">{field => <label>Baseline artifact digest<input required maxLength={135} pattern="sha256:[a-f0-9]{64}|sha512:[a-f0-9]{128}" value={field.state.value} onChange={e => field.handleChange(e.target.value)} /></label>}</form.Field><button className="button secondary" type="submit">Choose baseline report</button></form>
    {selected ? <><button className="text-button" onClick={() => setSelected(undefined)}>Choose another report</button><SbomDifference key={JSON.stringify(selected)} {...p} baseline={selected} /></> : baseline ? <SbomBaseline key={baseline} {...p} baseline={baseline} select={setSelected} /> : null}
  </details>;
}
function SbomBaseline(p: Props & { baseline: string; select: (selection: ReportSelection) => void }) {
  const [history, setHistory] = useState<(string | undefined)[]>([undefined]);
  const query = usePackageQuery<Page<Attachment>>(p, { action: 'attachments', kind: 'sbom', reference: p.baseline, cursor: history.at(-1) });
  return <>{query.isError ? <PanelError error={query.error} retry={() => void query.refetch()} /> : !query.data || query.isFetching ? <Loading label="Loading baseline SBOMs…" /> : <DataTable data={query.data.items} columns={[
    { id: 'digest', header: 'Evidence', cell: ({ row }) => showDigest(row.original.digest) }, { accessorKey: 'provenance', header: 'Origin' }, { id: 'select', header: 'Report', cell: ({ row }) => <>{row.original.layers.map((layer, i) => <button key={layer.digest + i} className="text-button" onClick={() => p.select({ reference: p.baseline, attachment: row.original.digest, blob: layer.digest })}>Compare {layer.mediaType}</button>)}</> },
  ]} getRowId={r => r.digest} label="baseline SBOMs" emptyMessage="No SBOMs on this page. Inspect a platform digest for a multi-platform image." />}<PageControls next={query.data?.next} history={history} setHistory={setHistory} refresh={() => void query.refetch()} /></>;
}
function SbomDifference(p: Props & { attachment: string; blob: string; baseline: ReportSelection }) {
  const [history, setHistory] = useState<(string | undefined)[]>([undefined]), [query, setQuery] = useState('');
  const result = usePackageQuery<Page<ReportRow & { change: string; count: number }> & { added: number; removed: number; matched: number }>(p, { action: 'compareSbom', reference: p.packageDigest, attachment: p.attachment, blob: p.blob, baseline: p.baseline, query, cursor: history.at(-1) });
  return <><p>Baseline: <code>{p.baseline.reference}</code> · report <code>{p.baseline.blob}</code></p><Search onSearch={q => { setQuery(q); setHistory([undefined]); }} />
    {result.isError ? <PanelError error={result.error} retry={() => void result.refetch()} /> : !result.data || result.isFetching ? <Loading label="Comparing immutable SBOMs…" /> : <><p>{result.data.added} package occurrences added · {result.data.removed} removed · {result.data.matched} matching change rows</p><DataTable data={result.data.items.map((r, i) => ({ ...r, index: i }))} columns={[
      { accessorKey: 'change', header: 'Change' }, { accessorKey: 'count', header: 'Occurrences' }, { accessorKey: 'name', header: 'Package' }, { accessorKey: 'version', header: 'Version' }, { accessorKey: 'type', header: 'Type' }, { accessorKey: 'purl', header: 'Package URL' }, { id: 'licenses', header: 'Licenses', accessorFn: r => r.licenses?.join(', ') || 'Not declared' },
    ]} getRowId={r => String(r.index)} label="SBOM changes" emptyMessage="No matching changes in the compared package fields." /></>}
    <PageControls next={result.data?.next} history={history} setHistory={setHistory} refresh={() => void result.refetch()} />
  </>;
}
