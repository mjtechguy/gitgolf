import { useState } from 'react';
import { useForm } from '@tanstack/react-form';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { nativeAPI } from './NativeForge';
import { DataTable } from './DataTable';
import { Loading, PanelError, privateQuery } from './RepositoryUI';

type Props = { userId: string; repository: { owner: string; name: string }; repositoryId: string; canManage: boolean };
type TrustKey = { name: string; algorithm: string; pem: string; fingerprint?: string };
export function NativePackageTrust(p: Props) {
  const [adding, setAdding] = useState(false), cache = useQueryClient();
  const queryKey = ['native-package-trust', p.userId, p.repositoryId];
  const query = useQuery({ ...privateQuery, queryKey, retry: false, queryFn: async ({ signal }) => {
    const value = await nativeAPI<{ repositoryId: string; revision: number; keys: TrustKey[] }>('/native/repository-packages', { repository: p.repository, repositoryId: p.repositoryId, action: 'trust' }, signal);
    if (value.repositoryId !== p.repositoryId) throw Error('Trust policy identity mismatch.'); return value;
  } });
  const save = useMutation({ mutationFn: (keys: TrustKey[]) => nativeAPI('/native/repository-packages', { repository: p.repository, repositoryId: p.repositoryId, action: 'updateTrust', expectedRevision: query.data!.revision, keys }), onSuccess: async () => { setAdding(false); await cache.invalidateQueries({ queryKey }); await cache.invalidateQueries({ queryKey: ['native-package-content', p.userId, p.repositoryId] }); } });
  if (query.isError) return <PanelError error={query.error} retry={() => void query.refetch()} />;
  if (!query.data || query.isFetching) return <Loading label="Loading trusted signing keys…" />;
  const keys = query.data.keys;
  return <><h3>Trusted signing keys</h3><p className="field-help">Cosign public keys used to verify immutable image signatures. Changing this list makes earlier verification results stale. Private keys remain with your signing system.</p>
    <DataTable data={keys} columns={[{ accessorKey: 'name', header: 'Signer' }, { accessorKey: 'algorithm', header: 'Algorithm' }, { accessorKey: 'fingerprint', header: 'Fingerprint' }, { id: 'remove', header: 'Actions', cell: ({ row }) => p.canManage ? <button className="text-button" disabled={save.isPending} onClick={() => save.mutate(keys.filter(key => key.fingerprint !== row.original.fingerprint))}>Remove</button> : null }]} getRowId={key => key.fingerprint!} label="trusted signing keys" />
    {p.canManage ? adding ? <TrustForm disabled={save.isPending} cancel={() => setAdding(false)} save={key => save.mutate([...keys, key])} /> : <button className="button secondary" onClick={() => setAdding(true)}>Add trusted key</button> : null}
    {save.isError ? <PanelError error={save.error} retry={() => void query.refetch()} /> : null}
  </>;
}
function TrustForm({ disabled, cancel, save }: { disabled: boolean; cancel: () => void; save: (key: TrustKey) => void }) {
  const form = useForm({ defaultValues: { name: '', algorithm: 'ecdsa-p256', pem: '' }, onSubmit: ({ value }) => save(value) });
  return <form onSubmit={event => { event.preventDefault(); void form.handleSubmit(); }}><fieldset disabled={disabled}>
    <form.Field name="name">{field => <label>Signer name<input value={field.state.value} maxLength={128} required onChange={e => field.handleChange(e.target.value)} /></label>}</form.Field>
    <form.Field name="algorithm">{field => <label>Key algorithm<select value={field.state.value} onChange={e => field.handleChange(e.target.value)}><option value="ecdsa-p256">ECDSA P-256</option><option value="rsa-pss">RSA-PSS SHA-256</option><option value="rsa-pkcs1">RSA PKCS#1 SHA-256</option></select></label>}</form.Field>
    <form.Field name="pem">{field => <label>PEM public key<textarea value={field.state.value} rows={8} maxLength={16384} required onChange={e => field.handleChange(e.target.value)} /></label>}</form.Field>
    <button className="button" type="submit">Add key</button><button className="button secondary" type="button" onClick={cancel}>Cancel</button>
  </fieldset></form>;
}
