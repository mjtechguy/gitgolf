import { useState } from 'react';
import { useForm } from '@tanstack/react-form';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { nativeAPI } from './NativeForge';
import { privateQuery, PanelError, RepositoryVisibility } from './RepositoryUI';

type Visibility = { repositoryId: string; isPublic: boolean; revision: string };
export function NativeRepositoryVisibility({ userId, repository, repositoryId, blocked }: {
  userId: string; repository: { owner: string; name: string }; repositoryId: string; blocked: boolean;
}) {
  const cache = useQueryClient(), [editing, setEditing] = useState(false);
  const key = ['repository', userId, repository.owner, repository.name, 'visibility'];
  const read = useQuery({ ...privateQuery, queryKey: key, enabled: !blocked,
    queryFn: ({ signal }) => nativeAPI<Visibility>('/native/repository-visibility', { action: 'get', repository, repositoryId }, signal) });
  const save = useMutation({ retry: false, mutationFn: async (isPublic: boolean) => {
    if (blocked || !read.data) throw Error('Refresh repository visibility before saving.');
    const value = await nativeAPI<Visibility>('/native/repository-visibility', { action: 'set', repository, repositoryId, isPublic, expectedRevision: read.data.revision });
    if (value.repositoryId !== repositoryId || value.isPublic !== isPublic || !/^[a-f0-9]{64}$/.test(value.revision)) throw Error('Visibility change could not be confirmed. Refresh to inspect current visibility.');
    return value;
  }, onSuccess: async value => { cache.setQueryData(key, value); setEditing(false); await cache.invalidateQueries({ queryKey: ['repository', userId, repository.owner, repository.name] }); await cache.invalidateQueries({ queryKey: ['repositories'] }); } });
  return <section className="browser-panel credential-list-panel"><div className="browser-panel-heading"><h2>Visibility</h2><button className="button secondary" disabled={blocked || !read.data || read.isFetching || save.isPending} onClick={() => { save.reset(); setEditing(true); }}>Change visibility</button></div>
    <div className="credential-form-content">{read.error ? <PanelError error={read.error} retry={() => void read.refetch()} /> : read.data ? <p><RepositoryVisibility isPrivate={!read.data.isPublic} /> · {read.data.isPublic ? 'Anyone can browse source and Git history and clone over HTTPS.' : 'Repository access requires sign-in and a grant.'}</p> : <p role="status">Loading visibility…</p>}
      <p className="field-help">Collaboration, CI artifacts, previews and writes retain their existing permissions. Making a repository private cannot recall copies people already cloned.</p>
      {editing && read.data ? <VisibilityEditor key={read.data.revision} value={read.data.isPublic} disabled={blocked || save.isPending || save.isError || read.isFetching} save={value => save.mutate(value)} cancel={() => setEditing(false)} /> : null}
      {save.error ? <PanelError error={save.error} retry={() => { setEditing(false); save.reset(); void read.refetch(); }} /> : null}</div></section>;
}
function VisibilityEditor({ value, disabled, save, cancel }: { value: boolean; disabled: boolean; save: (value: boolean) => void; cancel: () => void }) {
  const form = useForm({ defaultValues: { visibility: value ? 'public' : 'private' }, onSubmit: ({ value }) => save(value.visibility === 'public') });
  return <form onSubmit={event => { event.preventDefault(); void form.handleSubmit(); }}><form.Field name="visibility">{field => <label>Repository visibility<select value={field.state.value} disabled={disabled} onChange={event => field.handleChange(event.target.value)}><option value="private">Private</option><option value="public">Public source and Git history</option></select></label>}</form.Field><div className="credential-actions"><button className="button primary" disabled={disabled}>Save visibility</button><button type="button" className="button secondary" disabled={disabled} onClick={cancel}>Cancel</button></div></form>;
}
