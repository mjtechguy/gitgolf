import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { nativeAPI } from './NativeForge';
import { DataTable } from './DataTable';
import { DateLabel, Loading, PanelError, privateQuery } from './RepositoryUI';
type Props = { userId: string; repository: { owner: string; name: string }; repositoryId: string; canManage: boolean };
export function NativePackageRetention(p: Props) {
  const cache = useQueryClient(), queryKey = ['native-package-retention', p.userId, p.repositoryId];
  const query = useQuery({ ...privateQuery, queryKey, retry: false, queryFn: async ({ signal }) => {
    const value = await nativeAPI<{ repositoryId: string; revision: number; items: { digest: string; size: number; publishedAt: string }[] }>('/native/repository-packages', { repository: p.repository, repositoryId: p.repositoryId, action: 'retention' }, signal);
    if (value.repositoryId !== p.repositoryId) throw Error('Retention preview identity mismatch.'); return value;
  } });
  const remove = useMutation({ mutationFn: (digest: string) => nativeAPI('/native/repository-packages', { repository: p.repository, repositoryId: p.repositoryId, action: 'retentionApply', expectedRevision: query.data!.revision, digests: [digest] }), onSuccess: async () => { await cache.invalidateQueries({ queryKey }); await cache.invalidateQueries({ queryKey: ['native-package-content', p.userId, p.repositoryId] }); } });
  return <details><summary>Review retention candidates</summary><p className="field-help">Up to 100 untagged manifests older than the retention period. Holds, active scans, and dependent manifests are excluded. Deleting a manifest starts the configured storage recovery window; shared layers remain stored.</p>
    {query.isError ? <PanelError error={query.error} retry={() => void query.refetch()} /> : !query.data || query.isFetching ? <Loading label="Checking retention candidates…" /> : <DataTable data={query.data.items} columns={[{ accessorKey: 'digest', header: 'Manifest digest' }, { accessorKey: 'publishedAt', header: 'Published', cell: ({ row }) => <DateLabel value={row.original.publishedAt} /> }, { accessorKey: 'size', header: 'Manifest bytes' }, { id: 'delete', header: 'Actions', cell: ({ row }) => p.canManage ? <button className="button danger" disabled={remove.isPending} onClick={() => remove.mutate(row.original.digest)}>Delete this manifest</button> : null }]} getRowId={r => r.digest} label="retention candidates" emptyMessage="No eligible manifests in the current preview." />}
    <button className="button secondary" onClick={() => void query.refetch()}>Refresh preview</button>{remove.isError ? <p role="alert" className="error">{remove.error.message} Refresh the preview before retrying.</p> : null}
  </details>;
}
