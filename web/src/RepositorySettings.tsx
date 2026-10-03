import { useEffect, useRef, useState } from 'react';
import { useForm } from '@tanstack/react-form';
import { Code, ConnectError } from '@connectrpc/connect';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { LoaderCircle, RefreshCw, Settings } from 'lucide-react';
import { errorMessage, repositorySettingsClient } from './api';
import type { RepositorySettings as SettingsValue, User } from './gen/golf/v1/golf_pb';
import { Loading, PanelError, privateQuery } from './RepositoryUI';
import { RepositorySettingsLayout, SettingsInventory } from './AccountSettings';
import { repositoryOptions } from './navigation';

type Draft = { description: string; defaultBranch: string; hasIssues: boolean; hasWiki: boolean; hasPullRequests: boolean };
function GeneralEditor({ settings, pending, onSave, onCancel }: { settings: SettingsValue; pending: boolean; onSave: (draft: Draft) => void; onCancel: () => void }) {
  const firstInput = useRef<HTMLTextAreaElement>(null);
  const form = useForm({ defaultValues: { description: settings.description, defaultBranch: settings.defaultBranch, hasIssues: settings.hasIssues, hasWiki: settings.hasWiki, hasPullRequests: settings.hasPullRequests }, onSubmit: ({ value }) => onSave(value) });
  useEffect(() => { firstInput.current?.focus(); }, []);
  return <form className="credential-form-content" onSubmit={(event) => { event.preventDefault(); void form.handleSubmit(); }}>
    <form.Field name="description">{(field) => <><label htmlFor="repository-settings-description">Description</label><textarea ref={firstInput} id="repository-settings-description" value={field.state.value} disabled={pending} maxLength={2048} rows={3} onBlur={field.handleBlur} onChange={(event) => field.handleChange(event.target.value)} /></>}</form.Field>
    <form.Field name="defaultBranch">{(field) => <><label htmlFor="repository-settings-default-branch">Default branch</label><input id="repository-settings-default-branch" value={field.state.value} disabled={pending} maxLength={1024} onBlur={field.handleBlur} onChange={(event) => field.handleChange(event.target.value)} /><p className="field-help">Choose an existing native branch. This does not create or rename a branch.</p></>}</form.Field>
    <form.Field name="hasIssues">{(field) => <><label htmlFor="repository-settings-issues">Issues</label><select id="repository-settings-issues" value={String(field.state.value)} disabled={pending} onBlur={field.handleBlur} onChange={(event) => field.handleChange(event.target.value === 'true')}><option value="true">Enabled</option><option value="false">Disabled</option></select></>}</form.Field>
    <form.Field name="hasWiki">{(field) => <><label htmlFor="repository-settings-wiki">Wiki</label><select id="repository-settings-wiki" value={String(field.state.value)} disabled={pending} onBlur={field.handleBlur} onChange={(event) => field.handleChange(event.target.value === 'true')}><option value="true">Enabled</option><option value="false">Disabled</option></select></>}</form.Field>
    <form.Field name="hasPullRequests">{(field) => <><label htmlFor="repository-settings-pull-requests">Pull requests</label><select id="repository-settings-pull-requests" value={String(field.state.value)} disabled={pending} onBlur={field.handleBlur} onChange={(event) => field.handleChange(event.target.value === 'true')}><option value="true">Enabled</option><option value="false">Disabled</option></select></>}</form.Field>
    <p className="field-help">Feature flags control native repository features. They do not grant Golf CI, agent execution or protected merge authority.</p>
    <div className="credential-actions"><button type="submit" className="button primary" disabled={pending}>{pending ? <LoaderCircle size={16} className="spin" /> : null}{pending ? 'Saving…' : 'Save repository settings'}</button><button type="button" className="button secondary" disabled={pending} onClick={onCancel}>Cancel</button></div>
  </form>;
}

export function RepositorySettings({ userId, owner, name, signingOut }: { userId: string; owner: string; name: string; signingOut: boolean }) {
  const client = useQueryClient();
  const queryKey = ['repository-settings', userId, owner, name];
  const query = useQuery({ ...privateQuery, queryKey, queryFn: async ({ signal }) => { const response = await repositorySettingsClient.getRepositorySettings({ repository: { owner, name } }, { signal, timeoutMs: 8_000 }); if (!response.settings) throw new ConnectError('Repository settings were not returned.', Code.Internal); return response; } });
  const [editing, setEditing] = useState<SettingsValue | null>(null);
  const [uncertain, setUncertain] = useState(false);
  const [notice, setNotice] = useState('');
  const [validation, setValidation] = useState('');
  const alive = useRef(true);
  const submitting = useRef(false);
  const controller = useRef<AbortController | null>(null);
  const editButton = useRef<HTMLButtonElement>(null);
  const returnToEdit = useRef(false);
  const active = () => alive.current && client.getQueryData<User | null>(['session'])?.id === userId;
  const mutation = useMutation({ gcTime: 0, retry: false,
    mutationFn: async (draft: Draft) => {
      if (!editing) throw new ConnectError('Refresh repository settings before editing.', Code.FailedPrecondition);
      const attempt = new AbortController(); controller.current = attempt;
      return repositorySettingsClient.updateRepositorySettings({ repository: { owner, name }, repositoryId: editing.repositoryId, ownerId: editing.ownerId, expectedRevision: editing.revision,
        description: draft.description !== editing.description ? draft.description : undefined,
        defaultBranch: draft.defaultBranch !== editing.defaultBranch ? draft.defaultBranch : undefined,
        hasIssues: draft.hasIssues !== editing.hasIssues ? draft.hasIssues : undefined,
        hasWiki: draft.hasWiki !== editing.hasWiki ? draft.hasWiki : undefined,
        hasPullRequests: draft.hasPullRequests !== editing.hasPullRequests ? draft.hasPullRequests : undefined,
      }, { signal: attempt.signal, timeoutMs: 8_000 });
    },
    onSuccess: async () => {
      if (!active()) return;
      setEditing(null); setNotice('Repository settings saved.'); returnToEdit.current = true;
      await client.resetQueries({ queryKey, exact: true });
      await client.invalidateQueries({ queryKey: ['repository', userId, owner, name] });
    },
    onError: () => { if (active()) { setUncertain(true); setNotice(''); } },
    onSettled: () => { submitting.current = false; controller.current = null; },
  });
  const settings = !query.error && query.isSuccess && !query.isFetching && !signingOut ? query.data.settings : undefined;
  useEffect(() => { alive.current = true; return () => { alive.current = false; controller.current?.abort(); }; }, []);
  useEffect(() => { if (query.error || signingOut) { setEditing(null); controller.current?.abort(); } }, [query.error, signingOut]);
  useEffect(() => { if (!editing && returnToEdit.current && settings) { returnToEdit.current = false; editButton.current?.focus(); } }, [editing, settings]);
  function save(draft: Draft) {
    if (submitting.current || !editing || uncertain || signingOut || query.error || query.isFetching) return;
    if (new TextEncoder().encode(draft.description).byteLength > 2048 || /\p{Cc}/u.test(draft.description.replace(/[\r\n\t]/g, ''))) { setValidation('Use a description up to 2,048 UTF-8 bytes without unsupported controls.'); return; }
    if (![draft.description !== editing.description, draft.defaultBranch !== editing.defaultBranch, draft.hasIssues !== editing.hasIssues, draft.hasWiki !== editing.hasWiki, draft.hasPullRequests !== editing.hasPullRequests].some(Boolean)) { setValidation('Change a setting before saving.'); return; }
    submitting.current = true; setValidation(''); setNotice(''); mutation.mutate(draft);
  }
  async function refresh() {
    if (mutation.isPending) return;
    setEditing(null); setNotice(''); setValidation('');
    await client.resetQueries({ queryKey, exact: true });
    if (active() && !client.getQueryState(queryKey)?.error) { setUncertain(false); mutation.reset(); }
  }
  return <RepositorySettingsLayout owner={owner} name={name}><section className="page-stack" aria-labelledby="repository-settings-title">
    <header className="repository-intro"><div><span className="eyebrow">{owner}/{name}</span><h1 id="repository-settings-title"><Settings size={29} />Repository settings</h1><p>Repository administration and effective feature availability.</p></div><Link className="button secondary" {...repositoryOptions({ owner, name })}>Back to repository</Link></header>
    <section className="browser-panel credential-list-panel" aria-labelledby="repository-general-title"><div className="browser-panel-heading"><h2 id="repository-general-title">General</h2><div className="credential-actions">{settings?.canEdit ? <button ref={editButton} className="button secondary" disabled={Boolean(editing) || uncertain || mutation.isPending} onClick={() => { setEditing(settings); setNotice(''); }}>Edit general settings</button> : null}<button className="button secondary" disabled={query.isFetching || mutation.isPending} onClick={() => void refresh()}><RefreshCw size={15} />Refresh repository settings</button></div></div>
      {query.error ? <PanelError error={query.error} retry={() => void refresh()} /> : !settings ? <Loading label="Loading repository settings…" /> : <>
        {uncertain ? <div className="panel-error"><h3>Save could not be confirmed</h3><p role="alert">{mutation.error ? errorMessage(mutation.error) : 'The update outcome is unknown.'} No automatic retry was made. Refresh and inspect current values before opening a separate edit.</p><button className="button secondary" onClick={() => void refresh()}>Inspect current repository settings</button></div> : editing ? <><GeneralEditor settings={editing} pending={mutation.isPending || signingOut} onSave={save} onCancel={() => { returnToEdit.current = true; setEditing(null); setValidation(''); }} />{validation ? <p role="alert" className="error">{validation}</p> : null}</> : <div className="credential-form-content"><dl className="settings-profile"><div><dt>Description</dt><dd>{settings.description || 'Not set'}</dd></div><div><dt>Default branch</dt><dd>{settings.defaultBranch || 'Not set'}</dd></div><div><dt>Issues</dt><dd>{settings.hasIssues ? 'Enabled' : 'Disabled'}</dd></div><div><dt>Wiki</dt><dd>{settings.hasWiki ? 'Enabled' : 'Disabled'}</dd></div><div><dt>Pull requests</dt><dd>{settings.hasPullRequests ? 'Enabled' : 'Disabled'}</dd></div></dl><p className="field-help">{settings.canEdit ? 'Repository administration is verified on each read and save.' : 'View only. Editing requires native repository administration and a credential with write access.'} Updates use a checked revision and readback, not an atomic native compare-and-swap. Concurrent external edits remain a qualification limit.</p></div>}
        {notice ? <p role="status" className="session-notice">{notice}</p> : null}
      </>}
    </section>
    <SettingsInventory scope="repository" />
  </section></RepositorySettingsLayout>;
}
