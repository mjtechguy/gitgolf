import { NativePackages } from './NativePackages';
import { NativeRepositoryVisibility } from './NativeRepositoryVisibility';
import { RuntimeFeature } from './RuntimeFeature';
import { useRuntimeCapabilities } from './useRuntimeCapabilities';
import {RepositoryMirrors} from './RepositoryMirrors';
import { RepositoryLifecycleSettings } from './RepositoryLifecycleSettings';
import { useEffect, useRef, useState } from 'react';
import { useForm } from '@tanstack/react-form';
import { Code, ConnectError } from '@connectrpc/connect';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { LoaderCircle, RefreshCw } from 'lucide-react';
import { errorMessage, repositorySettingsClient } from './api';
import { RepositoryFeatureMode as Mode } from './gen/golf/v1/golf_pb';
import type { RepositorySettings as SettingsValue, UpdateRepositorySettingsRequest, User } from './gen/golf/v1/golf_pb';
import { Loading, PanelError, privateQuery } from './RepositoryUI';
import { SettingsInventory } from './AccountSettings';
import { RepositoryFeaturesPanel } from './RepositoryFeatures';
import { RepositoryAiModels } from './RepositoryAiModels';
import { sourceRepositoryID } from './sourceReads';

const bytes = (value: string) => new TextEncoder().encode(value).byteLength;
const text = (value: string, max: number, multiline = false) => bytes(value) <= max && !/\p{Cc}/u.test(multiline ? value.replace(/[\r\n\t]/g, '') : value);
const safeURL = (value: string) => { try { const u = new URL(value); return text(value, 1024) && ['https:', 'http:'].includes(u.protocol) && Boolean(u.hostname) && !u.username && !u.password; } catch { return false; } };
const topicValues = (value: string) => value.trim() ? value.split(',').map((v) => v.trim()) : [];
const validTopics = (values: string[]) => values.length <= 25 && new Set(values).size === values.length && values.every((v) => v.length <= 35 && /^[a-z0-9][-.a-z0-9]*$/.test(v));
function validSettings(value: SettingsValue | undefined, expected?: { repositoryId: string; ownerId: string }): value is SettingsValue {
  if (!value || !sourceRepositoryID(value.repositoryId) || !sourceRepositoryID(value.ownerId) || !/^[a-f0-9]{64}$/.test(value.revision) || !text(value.description, 2048, true) || !text(value.website, 1024) || !value.defaultBranch || !text(value.defaultBranch, 1024) || !validTopics(value.topics) || !value.generalEditImplemented || expected && (value.repositoryId !== expected.repositoryId || value.ownerId !== expected.ownerId) || value.canEdit && (value.archived || value.mirror)) return false;
  if (![Mode.DISABLED, Mode.INTERNAL, Mode.EXTERNAL].includes(value.issuesMode) || ![Mode.DISABLED, Mode.INTERNAL, Mode.EXTERNAL].includes(value.wikiMode) || value.hasIssues !== (value.issuesMode !== Mode.DISABLED) || value.hasWiki !== (value.wikiMode !== Mode.DISABLED)) return false;
  if (value.issuesMode === Mode.EXTERNAL) { const t = value.externalTracker; if (!t || !text(t.url, 1024) || !text(t.format, 2048) || !text(t.style, 32) || !text(t.regexpPattern, 1024)) return false; } else if (value.externalTracker) return false;
  if (value.wikiMode === Mode.EXTERNAL) { if (!value.externalWiki || !text(value.externalWiki.url, 1024)) return false; } else if (value.externalWiki) return false;
  return true;
}
const modeName = (mode: Mode) => mode === Mode.INTERNAL ? 'Built-in' : mode === Mode.EXTERNAL ? 'External' : 'Disabled';
type Draft = { description: string; website: string; defaultBranch: string; issuesMode: Mode; wikiMode: Mode; trackerURL: string; trackerFormat: string; trackerStyle: string; trackerPattern: string; wikiURL: string; hasPullRequests: boolean };
const generalDraft = (s: SettingsValue): Draft => ({ description: s.description, website: s.website, defaultBranch: s.defaultBranch, issuesMode: s.issuesMode, wikiMode: s.wikiMode, trackerURL: s.externalTracker?.url || '', trackerFormat: s.externalTracker?.format || '', trackerStyle: s.externalTracker?.style || 'numeric', trackerPattern: s.externalTracker?.regexpPattern || '', wikiURL: s.externalWiki?.url || '', hasPullRequests: s.hasPullRequests });
function GeneralEditor({ settings, pending, onSave, onCancel, native }: { native: boolean; settings: SettingsValue; pending: boolean; onSave: (draft: Draft) => void; onCancel: () => void }) {
  const firstInput = useRef<HTMLTextAreaElement>(null);
  const form = useForm({ defaultValues: generalDraft(settings), onSubmit: ({ value }) => onSave(value) });
  useEffect(() => { firstInput.current?.focus(); }, []);
  const input = (name: 'website' | 'defaultBranch' | 'trackerURL' | 'trackerFormat' | 'trackerPattern' | 'wikiURL', label: string, max = 1024) => <form.Field name={name}>{(field) => <><label htmlFor={`repository-settings-${name}`}>{label}</label><input id={`repository-settings-${name}`} value={field.state.value} disabled={pending} maxLength={max} onBlur={field.handleBlur} onChange={(e) => field.handleChange(e.target.value)} /></>}</form.Field>;
  return <form aria-label="Edit repository general settings" className="credential-form-content" onSubmit={(event) => { event.preventDefault(); void form.handleSubmit(); }}>
    <form.Field name="description">{(field) => <><label htmlFor="repository-settings-description">Description</label><textarea ref={firstInput} id="repository-settings-description" value={field.state.value} disabled={pending} maxLength={2048} rows={3} onBlur={field.handleBlur} onChange={(event) => field.handleChange(event.target.value)} /></>}</form.Field>
    {input('website', 'Website')} {input('defaultBranch', 'Default branch')}
    <p className="field-help">Choose an existing branch. This does not create or rename a branch.</p>{native ? <p className="field-help">Issues, pull requests and other features are turned on or off in Features below.</p> : <>
    <form.Field name="issuesMode">{(field) => <><label htmlFor="repository-settings-issues">Issues</label><select id="repository-settings-issues" value={field.state.value} disabled={pending} onBlur={field.handleBlur} onChange={(e) => field.handleChange(Number(e.target.value) as Mode)}><option value={Mode.DISABLED}>Disabled</option><option value={Mode.INTERNAL}>Built-in issue tracker</option><option value={Mode.EXTERNAL}>External issue tracker</option></select></>}</form.Field>
    <form.Subscribe selector={(s) => s.values.issuesMode}>{(mode) => mode === Mode.EXTERNAL ? <>{input('trackerURL', 'External tracker URL')}{input('trackerFormat', 'External issue URL format', 2048)}<p className="field-help">Optional HTTP(S) issue URL using {'{user}'}, {'{repo}'} and {'{index}'} placeholders.</p><form.Field name="trackerStyle">{(field) => <><label htmlFor="repository-settings-tracker-style">Issue identifier style</label><select id="repository-settings-tracker-style" value={field.state.value} disabled={pending} onChange={(e) => field.handleChange(e.target.value)}><option value="numeric">Numeric</option><option value="alphanumeric">Alphanumeric</option><option value="regexp">Regular expression</option></select></>}</form.Field>{input('trackerPattern', 'Issue identifier pattern')}</> : null}</form.Subscribe>
    <form.Field name="wikiMode">{(field) => <><label htmlFor="repository-settings-wiki">Wiki</label><select id="repository-settings-wiki" value={field.state.value} disabled={pending} onBlur={field.handleBlur} onChange={(e) => field.handleChange(Number(e.target.value) as Mode)}><option value={Mode.DISABLED}>Disabled</option><option value={Mode.INTERNAL}>Built-in wiki configuration</option><option value={Mode.EXTERNAL}>External wiki</option></select></>}</form.Field>
    <form.Subscribe selector={(s) => s.values.wikiMode}>{(mode) => mode === Mode.EXTERNAL ? input('wikiURL', 'External wiki URL') : null}</form.Subscribe>
    <form.Field name="hasPullRequests">{(field) => <><label htmlFor="repository-settings-pull-requests">Pull requests</label><select id="repository-settings-pull-requests" value={String(field.state.value)} disabled={pending} onBlur={field.handleBlur} onChange={(event) => field.handleChange(event.target.value === 'true')}><option value="true">Enabled</option><option value="false">Disabled</option></select></>}</form.Field>
    <p className="field-help">Configuration does not grant access. Changing a tracker/wiki mode removes its previous native configuration; unrelated tracker options are preserved.</p>
    </>}<div className="credential-actions"><button type="submit" className="button primary" disabled={pending}>{pending ? <LoaderCircle size={16} className="spin" /> : null}{pending ? 'Saving…' : 'Save repository settings'}</button><button type="button" className="button secondary" disabled={pending} onClick={onCancel}>Cancel</button></div>
  </form>;
}
function TopicsEditor({ settings, pending, onSave, onCancel }: { settings: SettingsValue; pending: boolean; onSave: (values: string[]) => void; onCancel: () => void }) {
  const firstInput = useRef<HTMLInputElement>(null); const [error, setError] = useState('');
  const form = useForm({ defaultValues: { topics: settings.topics.join(', ') }, onSubmit: ({ value }) => { const topics = topicValues(value.topics); if (!validTopics(topics)) { setError('Use at most 25 unique lowercase topics, 1–35 characters each, starting with a letter or digit; dots and hyphens are allowed.'); return; } onSave(topics); } });
  useEffect(() => { firstInput.current?.focus(); }, []);
  return <form aria-label="Edit repository topics" className="credential-form-content" onSubmit={(e) => { e.preventDefault(); void form.handleSubmit(); }}><form.Field name="topics">{(field) => <><label htmlFor="repository-settings-topics">Topics</label><input ref={firstInput} id="repository-settings-topics" value={field.state.value} disabled={pending} maxLength={1000} onChange={(e) => field.handleChange(e.target.value)} /><p className="field-help">Comma-separated lowercase topics. Empty clears the list. Topics are saved separately from General settings.</p></>}</form.Field>{error ? <p role="alert" className="error">{error}</p> : null}<div className="credential-actions"><button className="button primary" disabled={pending}>{pending ? 'Saving…' : 'Save topics'}</button><button type="button" className="button secondary" disabled={pending} onClick={onCancel}>Cancel</button></div></form>;
}
function changedGeneral(draft: Draft, saved: SettingsValue) {
  const before = generalDraft(saved), tracker = { url: draft.trackerURL, format: draft.trackerFormat, style: draft.trackerStyle, regexpPattern: draft.trackerPattern };
  const trackerChanged = ['trackerURL', 'trackerFormat', 'trackerStyle', 'trackerPattern'].some((key) => draft[key as keyof Draft] !== before[key as keyof Draft]);
  return { description: draft.description !== saved.description ? draft.description : undefined, website: draft.website !== saved.website ? draft.website : undefined, defaultBranch: draft.defaultBranch !== saved.defaultBranch ? draft.defaultBranch : undefined,
    hasPullRequests: draft.hasPullRequests !== saved.hasPullRequests ? draft.hasPullRequests : undefined,
    issuesMode: draft.issuesMode !== saved.issuesMode || draft.issuesMode === Mode.EXTERNAL && trackerChanged ? draft.issuesMode : undefined,
    externalTracker: draft.issuesMode === Mode.EXTERNAL && (draft.issuesMode !== saved.issuesMode || trackerChanged) ? tracker as UpdateRepositorySettingsRequest['externalTracker'] : undefined,
    wikiMode: draft.wikiMode !== saved.wikiMode || draft.wikiMode === Mode.EXTERNAL && draft.wikiURL !== before.wikiURL ? draft.wikiMode : undefined,
    externalWiki: draft.wikiMode === Mode.EXTERNAL && (draft.wikiMode !== saved.wikiMode || draft.wikiURL !== before.wikiURL) ? { url: draft.wikiURL } as UpdateRepositorySettingsRequest['externalWiki'] : undefined,
  };
}
export function RepositorySettings({ userId, owner, name, signingOut }: { userId: string; owner: string; name: string; signingOut: boolean }) {
  const runtime = useRuntimeCapabilities(), native = runtime.data?.runtimeProfile === 'cloudflare-native';
  const client = useQueryClient(), identity = useRef<{ repositoryId: string; ownerId: string } | undefined>(undefined);
  const queryKey = ['repository-settings', userId, owner, name];
  const alive = useRef(true), submitting = useRef(false), controller = useRef<AbortController | null>(null), editButton = useRef<HTMLButtonElement>(null), returnToEdit = useRef(false);
  const active = () => alive.current && !signingOut && client.getQueryData<User | null>(['session'])?.id === userId;
  const query = useQuery({ ...privateQuery, enabled: !signingOut, queryKey, queryFn: async ({ signal }) => {
    const response = await repositorySettingsClient.getRepositorySettings({ repository: { owner, name }, repositoryId: identity.current?.repositoryId }, { signal, timeoutMs: 8_000 }); signal.throwIfAborted();
    if (!validSettings(response.settings, identity.current)) throw new ConnectError('Repository settings identity or configuration could not be verified.', Code.FailedPrecondition);
    identity.current ||= { repositoryId: response.settings.repositoryId, ownerId: response.settings.ownerId }; return response;
  } });
  const [editing, setEditing] = useState<{ kind: 'general' | 'topics'; settings: SettingsValue } | null>(null), [uncertain, setUncertain] = useState(false), [notice, setNotice] = useState(''), [validation, setValidation] = useState('');
  const mutation = useMutation({ gcTime: 0, retry: false, mutationFn: async (input: { kind: 'general'; draft: Draft } | { kind: 'topics'; topics: string[] }) => {
    if (!editing || !active()) throw new ConnectError('Refresh repository settings before editing.', Code.FailedPrecondition);
    const frozen = editing.settings, target = { repository: { owner, name }, repositoryId: frozen.repositoryId, ownerId: frozen.ownerId, expectedRevision: frozen.revision };
    const attempt = new AbortController(); controller.current = attempt;
    const patch = input.kind === 'general' ? changedGeneral(input.draft, frozen) : undefined;
    const response = input.kind === 'general' ? await repositorySettingsClient.updateRepositorySettings({ ...target, ...patch }, { signal: attempt.signal, timeoutMs: 8_000 }) : await repositorySettingsClient.updateRepositoryTopics({ ...target, topics: input.topics }, { signal: attempt.signal, timeoutMs: 8_000 });
    attempt.signal.throwIfAborted();
    if (!validSettings(response.settings, target) || !response.settings.canEdit) throw new ConnectError('Settings update receipt could not be verified. Inspect current values.', Code.FailedPrecondition);
    const result = response.settings;
    if (input.kind === 'topics' ? [...result.topics].sort().join(',') !== [...input.topics].sort().join(',') : Object.entries(patch!).some(([key, value]) => value !== undefined && (typeof value === 'object' ? JSON.stringify(key === 'externalTracker' ? { url: result.externalTracker?.url, format: result.externalTracker?.format, style: result.externalTracker?.style, regexpPattern: result.externalTracker?.regexpPattern } : { url: result.externalWiki?.url }) !== JSON.stringify(value) : result[key as keyof SettingsValue] !== value))) throw new ConnectError('Settings update values could not be verified. Inspect current values.', Code.FailedPrecondition);
    return response;
  }, onSuccess: async (_, input) => { if (!active()) return; setEditing(null); setNotice(input.kind === 'topics' ? 'Repository topics saved.' : 'Repository settings saved.'); returnToEdit.current = true; await client.resetQueries({ queryKey, exact: true }); await Promise.all([client.invalidateQueries({ queryKey: ['repository', userId, owner, name] }), client.invalidateQueries({ queryKey: ['repository-overview', userId, owner, name] })]); }, onError: () => { if (active()) { setUncertain(true); setNotice(''); } }, onSettled: () => { submitting.current = false; controller.current = null; } });
  const settings = !query.error && query.isSuccess && !query.isFetching && !signingOut ? query.data.settings : undefined;
  useEffect(() => { alive.current = true; return () => { alive.current = false; controller.current?.abort(); void client.cancelQueries({ queryKey, exact: true }); client.removeQueries({ queryKey, exact: true }); }; }, []);
  useEffect(() => { if (query.error || signingOut) { setEditing(null); setNotice(''); setValidation(''); controller.current?.abort(); } }, [query.error, signingOut]);
  useEffect(() => { if (settings && !settings.canEdit) setEditing(null); }, [settings?.canEdit]);
  useEffect(() => { if (!editing && returnToEdit.current && settings) { returnToEdit.current = false; editButton.current?.focus(); } }, [editing, settings]);
  function begin(kind: 'general' | 'topics') { if (settings?.canEdit && !uncertain && !submitting.current) { setEditing({ kind, settings }); setNotice(''); setValidation(''); } }
  function save(input: { kind: 'general'; draft: Draft } | { kind: 'topics'; topics: string[] }) {
    if (submitting.current || !editing || uncertain || !active() || !settings || !settings.canEdit) return;
    if (settings.revision !== editing.settings.revision) { setValidation('Current settings changed while you were editing. Your draft is preserved; cancel and inspect current values before a new edit.'); return; }
    if (input.kind === 'general') {
      if (!text(input.draft.description, 2048, true)) { setValidation('Use a description up to 2,048 UTF-8 bytes without unsupported controls.'); return; }
      if (input.draft.website !== editing.settings.website && input.draft.website && !safeURL(input.draft.website) || changedGeneral(input.draft, editing.settings).externalTracker && !safeURL(input.draft.trackerURL) || changedGeneral(input.draft, editing.settings).externalWiki && !safeURL(input.draft.wikiURL)) { setValidation('Use HTTP(S) URLs without credentials for the website and external services.'); return; }
      if (!Object.values(changedGeneral(input.draft, editing.settings)).some((v) => v !== undefined)) { setValidation('Change a setting before saving.'); return; }
    } else if ([...input.topics].sort().join(',') === editing.settings.topics.join(',')) { setValidation('Change a topic before saving.'); return; }
    submitting.current = true; setValidation(''); setNotice(''); mutation.mutate(input);
  }
  async function refresh() { if (mutation.isPending || signingOut) return; if (uncertain) setEditing(null); setNotice(''); setValidation(''); await client.resetQueries({ queryKey, exact: true }); if (active() && !client.getQueryState(queryKey)?.error) { setUncertain(false); mutation.reset(); } }
  function cancel() { returnToEdit.current = true; setEditing(null); setValidation(''); }
  return <><section className="page-stack" aria-labelledby="repository-settings-title">
    <header className="repository-intro"><div><h1 id="repository-settings-title">General settings</h1><p>Manage repository details and features.</p></div></header>
    <section className="browser-panel credential-list-panel" aria-labelledby="repository-general-title"><div className="browser-panel-heading"><h2 id="repository-general-title">General</h2><div className="credential-actions">{settings?.canEdit ? <button ref={editButton} className="button secondary" disabled={Boolean(editing) || uncertain || mutation.isPending} onClick={() => begin('general')}>Edit general settings</button> : null}<button className="button secondary" disabled={query.isFetching || mutation.isPending || signingOut} onClick={() => void refresh()}><RefreshCw size={15} />Refresh repository settings</button></div></div>
      {query.error ? <PanelError error={query.error} retry={() => void refresh()} /> : !settings ? <Loading label="Loading repository settings…" /> : null}
      {editing?.kind === 'general' && !query.error && !signingOut && !uncertain ? <div hidden={!settings} inert={!settings}>{settings && settings.revision !== editing.settings.revision ? <p className="field-help">Current values changed. Your unsaved draft is retained; inspect the new values before a separate edit.</p> : null}<GeneralEditor native={native} settings={editing.settings} pending={mutation.isPending || !settings?.canEdit} onSave={(draft) => save({ kind: 'general', draft })} onCancel={cancel} />{validation ? <p role="alert" className="error">{validation}</p> : null}</div> : null}
      {settings && (!editing || editing.kind === 'topics' || uncertain) ? <div className="credential-form-content"><dl className="settings-profile"><div><dt>Description</dt><dd>{settings.description || 'Not set'}</dd></div><div><dt>Website</dt><dd>{settings.website ? safeURL(settings.website) ? <a href={settings.website} target="_blank" rel="noreferrer">{settings.website}</a> : settings.website : 'Not set'}</dd></div><div><dt>Default branch</dt><dd>{settings.defaultBranch}</dd></div>{native ? null : <><div><dt>Issues</dt><dd>{modeName(settings.issuesMode)}{settings.externalTracker ? <><br />{settings.externalTracker.url}<br />Issue URL format: {settings.externalTracker.format || 'Not set'}<br />Identifiers: {settings.externalTracker.style || 'Not set'}{settings.externalTracker.regexpPattern ? <><br />Pattern: {settings.externalTracker.regexpPattern}</> : null}</> : null}</dd></div><div><dt>Wiki</dt><dd>{modeName(settings.wikiMode)}{settings.externalWiki ? <><br /><span>{settings.externalWiki.url}</span></> : null}</dd></div><div><dt>Pull requests</dt><dd>{settings.hasPullRequests ? 'Enabled' : 'Disabled'}</dd></div></>}<div><dt>Administration</dt><dd>{settings.archived ? 'Archived · read only' : settings.mirror ? 'Mirror · read only' : settings.canEdit ? 'Current repository administrator' : 'View only'}</dd></div></dl><p className="field-help">Golf checks your repository permissions again when saving.</p></div> : null}
      {settings && uncertain ? <div className="panel-error"><h3>Save could not be confirmed</h3><p role="alert">{mutation.error ? errorMessage(mutation.error) : 'The update outcome is unknown.'} No automatic retry was made. Refresh and inspect current values before a separate edit.</p><button className="button secondary" onClick={() => { setEditing(null); void refresh(); }}>Inspect current repository settings</button></div> : null}
      {settings && notice ? <p role="status" className="session-notice">{notice}</p> : null}
    </section>
    {(settings || editing?.kind === 'topics' && !query.error && !signingOut) && !uncertain ? <section className="browser-panel credential-list-panel" aria-labelledby="repository-topics-title"><div className="browser-panel-heading"><h2 id="repository-topics-title">Topics</h2>{settings?.canEdit ? <button className="button secondary" disabled={Boolean(editing) || mutation.isPending} onClick={() => begin('topics')}>Edit topics</button> : null}</div>{editing?.kind === 'topics' && !query.error && !signingOut ? <div hidden={!settings} inert={!settings}>{settings && settings.revision !== editing.settings.revision ? <p className="field-help">Current values changed. Your unsaved draft is retained; inspect the new values before a separate edit.</p> : null}<TopicsEditor settings={editing.settings} pending={mutation.isPending || !settings?.canEdit} onSave={(topics) => save({ kind: 'topics', topics })} onCancel={cancel} />{validation ? <p role="alert" className="error">{validation}</p> : null}</div> : settings ? <div className="credential-form-content"><p>{settings.topics.length ? settings.topics.join(', ') : 'No topics configured.'}</p></div> : null}</section> : null}
    {native ? <RepositoryFeaturesPanel userId={userId} owner={owner} name={name} signingOut={signingOut} /> : null}
    {native && settings ? <RuntimeFeature id="settings.ai-models"><RepositoryAiModels userId={userId} owner={owner} name={name} repositoryId={settings.repositoryId} signingOut={signingOut} /></RuntimeFeature> : null}
    {native && settings?.canEdit ? <RuntimeFeature id="repository.public-source"><NativeRepositoryVisibility userId={userId} repository={{owner,name}} repositoryId={settings.repositoryId} blocked={signingOut||query.isFetching||!!query.error}/></RuntimeFeature> : null}
    {native && settings ? <RuntimeFeature id="repository.packages"><NativePackages userId={userId} repository={{owner,name}} repositoryId={settings.repositoryId} settings blocked={signingOut||query.isFetching||!!query.error}/></RuntimeFeature> : null}
    {!native && (settings?.canEdit||settings?.mirror)?<RepositoryMirrors userId={userId} owner={owner} name={name} repositoryId={settings.repositoryId} blocked={signingOut||query.isFetching||!!query.error}/>:null}
    {!native && <RepositoryLifecycleSettings userId={userId} owner={owner} name={name} signingOut={signingOut} />}
    <SettingsInventory scope="repository" repository={{ owner, name }} userId={userId} accessTarget={settings ? { repositoryId: settings.repositoryId, ownerId: settings.ownerId, revision: settings.revision, archived: settings.archived, mirror: settings.mirror } : undefined} generalObservation={settings ? { canEdit: settings.canEdit, implemented: settings.generalEditImplemented, issues: modeName(settings.issuesMode), wiki: modeName(settings.wikiMode) } : undefined} />
  </section></>;
}
