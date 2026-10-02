import { useEffect, useRef, useState } from 'react';
import { useForm } from '@tanstack/react-form';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Code, ConnectError } from '@connectrpc/connect';
import { errorMessage, profileClient } from './api';
import type { Profile, User } from './gen/golf/v1/golf_pb';
import { Loading, PanelError, privateQuery } from './RepositoryUI';

type ProfileDraft = { fullName: string; bio: string; location: string; website: string };
function validateDraft(draft: ProfileDraft): string | undefined {
  for (const [name, value, limit] of [['Display name', draft.fullName, 100], ['Bio', draft.bio, 255], ['Location', draft.location, 50], ['Website', draft.website, 255]] as const) {
    const controls = name === 'Bio' ? value.replace(/[\r\n\t]/g, '') : value;
    if (new TextEncoder().encode(value).byteLength > limit || /\p{Cc}/u.test(controls)) return `${name} must fit within ${limit} UTF-8 bytes without unsupported controls.`;
  }
  if (draft.website) {
    try { const url = new URL(draft.website); if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password) return 'Use an HTTP or HTTPS website URL without embedded credentials.'; }
    catch { return 'Use a complete HTTP or HTTPS website URL.'; }
  }
  return undefined;
}
function ProfileEditor({ profile, pending, onSave, onCancel }: { profile: Profile; pending: boolean; onSave: (draft: ProfileDraft) => void; onCancel: () => void }) {
  const first = useRef<HTMLInputElement>(null);
  const form = useForm({ defaultValues: { fullName: profile.fullName, bio: profile.bio, location: profile.location, website: profile.website }, validators: { onSubmit: ({ value }) => validateDraft(value) }, onSubmit: ({ value }) => onSave({ ...value }) });
  useEffect(() => { first.current?.focus(); }, []);
  return <form className="credential-form-content" aria-label="Edit account profile" onSubmit={event => { event.preventDefault(); void form.handleSubmit(); }}>
    <form.Field name="fullName">{field => <><label htmlFor="profile-full-name">Display name</label><input ref={first} id="profile-full-name" value={field.state.value} disabled={pending} autoComplete="name" maxLength={100} onBlur={field.handleBlur} onChange={event => field.handleChange(event.target.value)} /></>}</form.Field>
    <form.Field name="bio">{field => <><label htmlFor="profile-bio">Bio</label><textarea id="profile-bio" value={field.state.value} disabled={pending} maxLength={255} rows={3} onBlur={field.handleBlur} onChange={event => field.handleChange(event.target.value)} /></>}</form.Field>
    <form.Field name="location">{field => <><label htmlFor="profile-location">Location</label><input id="profile-location" value={field.state.value} disabled={pending} autoComplete="off" maxLength={50} onBlur={field.handleBlur} onChange={event => field.handleChange(event.target.value)} /></>}</form.Field>
    <form.Field name="website">{field => <><label htmlFor="profile-website">Website</label><input id="profile-website" type="url" value={field.state.value} disabled={pending} autoComplete="url" maxLength={255} onBlur={field.handleBlur} onChange={event => field.handleChange(event.target.value)} /></>}</form.Field>
    <p className="field-help">These are public profile fields. Username and sign-in email changes are not available yet.</p>
    <form.Subscribe selector={state => state.errors}>{errors => errors.length ? <p className="error" role="alert">{errors.join(' ')}</p> : null}</form.Subscribe>
    <div className="credential-actions"><button className="button primary" type="submit" disabled={pending}>{pending ? 'Saving…' : 'Save profile'}</button><button className="button secondary" type="button" disabled={pending} onClick={() => { form.reset(); onCancel(); }}>Cancel</button></div>
  </form>;
}
export function ProfileSettings({ userId, signingOut, isInstanceAdmin }: { userId: string; signingOut: boolean; isInstanceAdmin: boolean }) {
  const client = useQueryClient(); const queryKey = ['own-profile', userId];
  const query = useQuery({ ...privateQuery, queryKey, queryFn: async ({ signal }) => { const response = await profileClient.getProfile({}, { signal, timeoutMs: 8000 }); const profile = response.profile; if (!profile || profile.userId !== userId || !profile.login || !profile.revision) throw new ConnectError('Your profile identity could not be verified.', Code.Internal); return profile; } });
  const [editing, setEditing] = useState<Profile | null>(null); const [pending, setPending] = useState(false); const [uncertain, setUncertain] = useState(false); const [denied, setDenied] = useState(false); const [notice, setNotice] = useState(''); const [error, setError] = useState('');
  const alive = useRef(true); const signing = useRef(signingOut); signing.current = signingOut; const busy = useRef(false); const generation = useRef(0); const controller = useRef<AbortController | null>(null); const editButton = useRef<HTMLButtonElement>(null); const returnFocus = useRef(false);
  const active = () => alive.current && !signing.current && client.getQueryData<User | null>(['session'])?.id === userId;
  const profile = query.isSuccess && !query.isFetching && !query.error && !signingOut && !denied ? query.data : undefined;
  useEffect(() => { alive.current = true; const hide = () => { generation.current++; controller.current?.abort(); setEditing(null); setNotice(''); setError(''); if (busy.current) setUncertain(true); }; window.addEventListener('pagehide', hide); return () => { alive.current = false; generation.current++; controller.current?.abort(); window.removeEventListener('pagehide', hide); }; }, []);
  useEffect(() => { if (signingOut || query.error || query.isFetching) { if (busy.current) setUncertain(true); generation.current++; controller.current?.abort(); setEditing(null); setNotice(''); setError(''); } }, [signingOut, query.error, query.isFetching]);
  useEffect(() => { if (!editing && profile && !pending && !uncertain && returnFocus.current) { returnFocus.current = false; editButton.current?.focus(); } }, [editing, profile, pending, uncertain]);
  async function refresh() { if (busy.current || signingOut) return; generation.current++; setEditing(null); setNotice(''); setError(''); setDenied(false); await client.resetQueries({ queryKey, exact: true }); if (active() && !client.getQueryState(queryKey)?.error) setUncertain(false); }
  async function save(draft: ProfileDraft) {
    if (!editing || !profile || !editing.canEdit || pending || busy.current || uncertain || !active()) return;
    const validation = validateDraft(draft); if (validation) { setError(validation); return; }
    const fields = { fullName: draft.fullName !== editing.fullName ? draft.fullName : undefined, bio: draft.bio !== editing.bio ? draft.bio : undefined, location: draft.location !== editing.location ? draft.location : undefined, website: draft.website !== editing.website ? draft.website : undefined };
    if (Object.values(fields).every(value => value === undefined)) { setError('Change a profile field before saving.'); return; }
    busy.current = true; setPending(true); setNotice(''); setError(''); const stamp = generation.current; const observed = editing; const attempt = new AbortController(); controller.current = attempt;
    try {
      const response = await profileClient.updateProfile({ userId: observed.userId, expectedRevision: observed.revision, ...fields }, { signal: attempt.signal, timeoutMs: 10000 });
      if (!response.profile || response.profile.userId !== observed.userId || response.profile.login !== observed.login || !response.profile.revision || Object.entries(fields).some(([key, value]) => value !== undefined && response.profile![key as keyof ProfileDraft] !== value)) throw new ConnectError('Profile save could not be confirmed. Refresh and inspect the current fields.', Code.Internal);
      if (!active() || stamp !== generation.current || attempt.signal.aborted) return;
      setEditing(null); returnFocus.current = true; client.setQueryData(queryKey, response.profile); await client.invalidateQueries({ queryKey: ['session'], exact: true }); if (active() && stamp === generation.current) setNotice('Profile saved.');
    } catch (cause) {
      if (active() && stamp === generation.current) { setEditing(null); returnFocus.current = true; setNotice(''); setUncertain(true); setError(errorMessage(cause instanceof Error ? cause : new Error('Profile update outcome is unknown.'))); if (cause instanceof ConnectError && (cause.code === Code.PermissionDenied || cause.code === Code.Unauthenticated)) { setDenied(true); client.removeQueries({ queryKey, exact: true }); } }
    } finally { busy.current = false; if (controller.current === attempt) controller.current = null; if (alive.current) setPending(false); }
  }
  return <section className="browser-panel credential-list-panel" aria-labelledby="profile-title"><div className="browser-panel-heading"><h2 id="profile-title">Account profile</h2><div className="credential-actions">{profile?.canEdit ? <button ref={editButton} className="button secondary" disabled={Boolean(editing) || pending || uncertain} onClick={() => { setError(''); setNotice(''); setEditing(profile); }}>Edit profile</button> : null}<button className="button secondary" disabled={query.isFetching || pending || signingOut} onClick={() => void refresh()}>Refresh profile</button></div></div>
    {query.error ? <PanelError error={query.error} retry={() => void refresh()} /> : !profile ? denied ? <p className="panel-footnote">Profile access is unavailable. Refresh after restoring your account authority.</p> : <Loading label="Loading your profile…" /> : editing ? <ProfileEditor profile={editing} pending={pending} onSave={draft => void save(draft)} onCancel={() => { setEditing(null); setError(''); returnFocus.current = true; }} /> : <div className="credential-form-content"><dl className="settings-profile"><div><dt>Username</dt><dd>{profile.login} · Read only</dd></div><div><dt>Instance role</dt><dd>{isInstanceAdmin ? 'Instance administrator' : 'Personal workspace'}</dd></div><div><dt>Display name</dt><dd>{profile.fullName || 'Not set'}</dd></div><div><dt>Bio</dt><dd>{profile.bio || 'Not set'}</dd></div><div><dt>Location</dt><dd>{profile.location || 'Not set'}</dd></div><div><dt>Website</dt><dd>{profile.website || 'Not set'}</dd></div></dl><p className="field-help">{profile.canEdit ? 'Edit public profile fields. Username and sign-in email changes are not available yet.' : 'Profile is view-only with your current account permissions. Username and sign-in email changes are not available yet.'}</p></div>}
    {notice ? <p className="session-notice" role="status">{notice}</p> : null}{error ? <p className="error" role="alert">{error}</p> : null}{uncertain ? <div className="credential-uncertain"><h3>Inspect current profile</h3><p>The save outcome could not be confirmed. No automatic retry was sent. Refresh and inspect the current profile before opening another edit.</p><button className="button secondary" disabled={pending || signingOut} onClick={() => void refresh()}>Refresh and inspect profile</button></div> : null}
  </section>;
}
