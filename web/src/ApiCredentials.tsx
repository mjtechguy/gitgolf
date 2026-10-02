import { useEffect, useMemo, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { useForm } from '@tanstack/react-form';
import { useInfiniteQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Code, ConnectError } from '@connectrpc/connect';
import { Copy, KeyRound, LoaderCircle, Plus, RefreshCw, X } from 'lucide-react';
import { apiCredentialClient, errorMessage } from './api';
import type { ApiCredential, User } from './gen/golf/v1/golf_pb';
import { Loading, More, privateQuery } from './RepositoryUI';
import { DataTable, type DataTableColumn } from './DataTable';

function CredentialTime({ value }: { value: string }) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? <span>Time unavailable</span> : <time dateTime={value}>{date.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}</time>;
}

function credentialStatus(credential: ApiCredential) {
  if (credential.revokedAt) return 'Revoked';
  if (Date.parse(credential.expiresAt) <= Date.now()) return 'Expired';
  if (!credential.sourceSessionActive) return 'Source session ended';
  return 'Not revoked or expired';
}

function RevokeCredential({ credential, pending, onCancel, onConfirm }: { credential: ApiCredential; pending: boolean; onCancel: () => void; onConfirm: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  const previousFocus = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (!previousFocus.current && document.activeElement instanceof HTMLElement) previousFocus.current = document.activeElement;
    if (dialog.current && !dialog.current.open) dialog.current.showModal();
    cancel.current?.focus();
    return () => { if (previousFocus.current?.isConnected) previousFocus.current.focus(); };
  }, []);
  return <dialog ref={dialog} className="create-dialog" aria-labelledby="revoke-credential-title" onClose={onCancel} onCancel={(event) => { if (pending) event.preventDefault(); }}>
    <div className="dialog-header"><span className="small-icon"><KeyRound size={21} /></span><button className="icon-button" aria-label="Close credential revocation" disabled={pending} onClick={onCancel}><X size={19} /></button></div>
    <h2 id="revoke-credential-title">Revoke this API credential?</h2>
    <p className="organization-guidance">“{credential.label}” will lose Golf API access. Your browser session, provider token, OAuth consent and Git keys stay unchanged.</p>
    <p className="field-help">Credential ID <code>{credential.id}</code></p>
    <div className="dialog-actions"><button ref={cancel} className="button secondary" disabled={pending} onClick={onCancel}>Cancel</button><button className="button session-danger" disabled={pending} onClick={onConfirm}>{pending ? <LoaderCircle className="spin" size={16} /> : null}{pending ? 'Revoking…' : 'Confirm revoke credential'}</button></div>
  </dialog>;
}

export function ApiCredentials({ userId, signingOut }: { userId: string; signingOut: boolean }) {
  const client = useQueryClient();
  const queryKey = ['api-credentials', userId];
  const [editing, setEditing] = useState(false);
  const [validation, setValidation] = useState('');
  const [secret, setSecret] = useState<{ token: string; credential: ApiCredential } | null>(null);
  const [copyNotice, setCopyNotice] = useState('');
  const [uncertain, setUncertain] = useState(false);
  const [reviewed, setReviewed] = useState(false);
  const [confirmation, setConfirmation] = useState<ApiCredential | null>(null);
  const [notice, setNotice] = useState('');
  const alive = useRef(true);
  const submitting = useRef(false);
  const revoking = useRef(false);
  const issueController = useRef<AbortController | null>(null);
  const revokeController = useRef<AbortController | null>(null);
  const labelInput = useRef<HTMLInputElement>(null);
  const copyButton = useRef<HTMLButtonElement>(null);
  const newButton = useRef<HTMLButtonElement>(null);
  const returnToAction = useRef(false);
  const active = () => alive.current && client.getQueryData<User | null>(['session'])?.id === userId;
  const query = useInfiniteQuery({
    ...privateQuery, queryKey, initialPageParam: 1,
    queryFn: ({ pageParam, signal }) => apiCredentialClient.listApiCredentials({ page: { page: pageParam, limit: 20 } }, { signal, timeoutMs: 8_000 }),
    getNextPageParam: (response, _pages, page) => {
      const next = response.page?.nextPage ?? 0;
      return next > page && next <= 10_000 ? next : undefined;
    },
  });
  const issuance = useMutation({
    gcTime: 0, retry: false,
    // Return no secret to the mutation cache. It lives only in this page's
    // component state and cannot be recovered after navigation or dismissal.
    mutationFn: async (input: { label: string; lifetimeSeconds: number }) => {
      const controller = new AbortController();
      issueController.current = controller;
      const response = await apiCredentialClient.createApiCredential(input, { signal: controller.signal, timeoutMs: 8_000 });
      if (!active() || controller.signal.aborted || client.getQueryState(queryKey)?.error) return;
      if (!response.credential?.id || !response.token) throw new ConnectError('Golf did not return a complete credential. Inspect the list before creating another.', Code.Internal);
      setSecret({ token: response.token, credential: response.credential });
      form.reset();
      setCopyNotice('');
      setNotice('');
    },
    onSuccess: async () => { if (active()) await client.resetQueries({ queryKey, exact: true }); },
    onError: () => {
      if (!active()) return;
      setSecret(null);
      setUncertain(true);
      setReviewed(false);
    },
    onSettled: () => { submitting.current = false; issueController.current = null; },
  });
  const revoke = useMutation({
    gcTime: 0, retry: false,
    mutationFn: async (credentialId: string) => {
      const controller = new AbortController();
      revokeController.current = controller;
      await apiCredentialClient.revokeApiCredential({ credentialId }, { signal: controller.signal, timeoutMs: 8_000 });
    },
    onSuccess: async () => {
      if (!active()) return;
      setSecret(null);
      setConfirmation(null);
      setNotice('API credential revoked.');
      await client.resetQueries({ queryKey, exact: true });
    },
    onError: () => { if (active()) { setSecret(null); setConfirmation(null); setNotice(''); } },
    onSettled: () => { revoking.current = false; revokeController.current = null; },
  });
  const listError = query.error ?? revoke.error;
  const loading = query.isPending || (query.isFetching && !query.isFetchingNextPage);
  const credentials = !listError && query.isSuccess && !loading ? [...new Map(query.data.pages.flatMap((page) => page.credentials).map((credential) => [credential.id, credential])).values()] : [];
  const sourceExpiresAt = query.isSuccess && !listError ? query.data.pages[0]?.currentSourceExpiresAt : undefined;
  const visibleSecret = !listError && !signingOut ? secret : null;

  useEffect(() => {
    alive.current = true;
    const clear = () => {
      issueController.current?.abort();
      // Commit removal before a pagehide event can freeze this document.
      flushSync(() => { setSecret(null); setCopyNotice(''); });
    };
    // A page restored from the browser's back-forward cache must not redisplay
    // a one-time secret from the previous document visit.
    window.addEventListener('pagehide', clear);
    window.addEventListener('pageshow', clear);
    return () => {
      alive.current = false;
      issueController.current?.abort();
      revokeController.current?.abort();
      window.removeEventListener('pagehide', clear);
      window.removeEventListener('pageshow', clear);
    };
  }, []);
  useEffect(() => {
    if (listError || signingOut) { setSecret(null); setCopyNotice(''); setConfirmation(null); issueController.current?.abort(); }
  }, [listError, signingOut]);
  useEffect(() => {
    if (secret) copyButton.current?.focus();
    else if (returnToAction.current) { returnToAction.current = false; newButton.current?.focus(); }
  }, [secret, editing]);

  useEffect(() => { if (editing && !secret && !uncertain) labelInput.current?.focus(); }, [editing, secret, uncertain]);
  const form = useForm({
    defaultValues: { label: '', lifetime: '3600' },
    onSubmit: ({ value }) => {
      if (submitting.current || secret || uncertain || listError || query.isFetching || signingOut) return;
      const trimmed = value.label.trim();
      const encoded = new TextEncoder().encode(trimmed);
      if (!trimmed || encoded.byteLength > 64 || new TextDecoder().decode(encoded) !== trimmed || /\p{Cc}/u.test(trimmed)) {
        setValidation('Use a label of 1–64 UTF-8 bytes without control characters.');
        labelInput.current?.focus();
        return;
      }
      const seconds = Number(value.lifetime);
      if (!Number.isInteger(seconds) || seconds < 60 || seconds > 43200) { setValidation('Choose an expiry between one minute and twelve hours.'); return; }
      submitting.current = true;
      setValidation('');
      setNotice('');
      issuance.mutate({ label: trimmed, lifetimeSeconds: seconds });
    },
  });
  function cancelEditor() { returnToAction.current = true; form.reset(); setValidation(''); setEditing(false); }
  async function refresh() {
    setSecret(null);
    setCopyNotice('');
    setConfirmation(null);
    setNotice('');
    revoke.reset();
    await client.resetQueries({ queryKey, exact: true });
    if (active() && !client.getQueryState(queryKey)?.error) setReviewed(true);
  }
  async function copySecret() {
    if (!visibleSecret) return;
    try {
      await navigator.clipboard.writeText(visibleSecret.token);
      if (active()) setCopyNotice('Credential copied. Dismissing this page does not clear your clipboard.');
    } catch { if (active()) setCopyNotice('Copy failed. Select and copy the credential manually.'); }
  }
  function dismissSecret() { returnToAction.current = true; setEditing(false); setSecret(null); setCopyNotice(''); setNotice('Secret dismissed. Golf cannot show it again.'); }
  function confirmRevoke() {
    if (!confirmation || revoking.current || signingOut) return;
    revoking.current = true;
    revoke.mutate(confirmation.id);
  }

  const columns = useMemo<DataTableColumn<ApiCredential>[]>(() => [
    { id: 'credential', accessorFn: (credential) => `${credential.label} ${credential.id}`, header: 'Credential', cell: ({ row }) => <><strong>{row.original.label}</strong><small>Credential <code>{row.original.id}</code></small></> },
    { id: 'status', accessorFn: credentialStatus, header: 'Status', cell: ({ row }) => <><span className="visibility">{credentialStatus(row.original)}</span>{row.original.revokedAt ? <small>Revoked <CredentialTime value={row.original.revokedAt} /></small> : null}</> },
    { accessorKey: 'expiresAt', header: 'Expires', cell: ({ row }) => <><CredentialTime value={row.original.expiresAt} /><small>Created <CredentialTime value={row.original.createdAt} /></small></> },
    { accessorKey: 'sourceSessionId', header: 'Source session', cell: ({ row }) => <><code>{row.original.sourceSessionId}</code><small>{row.original.sourceSessionActive ? 'Active at last check' : 'Ended'}</small></> },
    { id: 'actions', header: 'Actions', enableSorting: false, enableGlobalFilter: false, cell: ({ row }) => !row.original.revokedAt ? <button className="button secondary" disabled={query.isFetching || revoke.isPending || issuance.isPending} aria-label={`Revoke credential ${row.original.id}`} onClick={() => { setNotice(''); setConfirmation(row.original); }}>Revoke</button> : null },
  ], [query.isFetching, revoke.isPending, issuance.isPending]);

  return <div className="api-credentials">
    <header className="repository-intro"><div><span className="eyebrow">YOUR GOLF ACCOUNT</span><h1><KeyRound size={29} />API credentials</h1><p>Short-lived, read-only access for your tools.</p></div><button ref={newButton} className="button primary" disabled={editing || Boolean(visibleSecret) || uncertain || Boolean(listError) || query.isFetching || signingOut} onClick={() => { setEditing(true); setNotice(''); }}><Plus size={16} />New API credential</button></header>
    <p className="organization-guidance">These credentials can call Golf’s allowed read operations using your source session’s current repository access. They cannot create repositories, change your account or manage credentials. Signing out, revoking that source session or reaching its expiry also ends this access. They are not provider tokens or Git credentials.</p>
    {editing || visibleSecret || uncertain ? <section className="browser-panel credential-create-panel" aria-labelledby="credential-create-title">
      <div className="browser-panel-heading"><h2 id="credential-create-title">Create a read-only credential</h2><span className="visibility">Read only</span></div>
      <div className="credential-form-content">
        {visibleSecret ? <section className="credential-secret" aria-labelledby="credential-secret-title">
          <h3 id="credential-secret-title">Save this credential now</h3><p>Golf shows the secret only once. Copy it into your tool’s private configuration. It disappears when dismissed, refreshed or when you leave this page.</p>
          <label htmlFor="new-api-credential">New API credential</label><textarea id="new-api-credential" value={visibleSecret.token} readOnly rows={3} spellCheck={false} autoComplete="off" />
          <p className="field-help">Credential ID <code>{visibleSecret.credential.id}</code> · Expires <CredentialTime value={visibleSecret.credential.expiresAt} /></p>
          {copyNotice ? <p role="status" className="field-help">{copyNotice}</p> : null}
          <div className="credential-actions"><button ref={copyButton} className="button primary" onClick={() => void copySecret()}><Copy size={15} />Copy credential</button><button className="button secondary" onClick={dismissSecret}>Dismiss credential</button></div>
        </section> : uncertain ? <section className="credential-uncertain" aria-labelledby="credential-uncertain-title">
          <h3 id="credential-uncertain-title">Issuance outcome is unknown</h3><p role="alert">A credential may have been issued even though Golf did not receive its secret. This request will not be retried. Refresh the list and revoke any credential whose secret you did not receive before creating a separate one.</p>
          {issuance.error ? <p className="field-help">{errorMessage(issuance.error)}</p> : null}
          <div className="credential-actions"><button className="button secondary" disabled={query.isFetching} onClick={() => void refresh()}>Refresh credential list</button><button className="button secondary" disabled={!reviewed || Boolean(listError) || query.isFetching} onClick={() => { issuance.reset(); setUncertain(false); setReviewed(false); setValidation(''); }}>I reviewed the list; start a separate credential</button></div>
        </section> : <form onSubmit={(event) => { event.preventDefault(); void form.handleSubmit(); }}>
          <form.Field name="label">{(field) => <><label htmlFor="credential-label">Credential label</label><input ref={labelInput} id="credential-label" required autoComplete="off" maxLength={64} value={field.state.value} disabled={issuance.isPending || signingOut} onBlur={field.handleBlur} onChange={(event) => field.handleChange(event.target.value)} placeholder="Local read-only tool" aria-describedby="credential-label-help" />
          <p className="field-help" id="credential-label-help">A name you recognize, up to 64 UTF-8 bytes. Do not put a secret in the label.</p></>}</form.Field>
          <form.Field name="lifetime">{(field) => <><label htmlFor="credential-lifetime">Requested lifetime</label><select id="credential-lifetime" value={field.state.value} disabled={issuance.isPending || signingOut} onBlur={field.handleBlur} onChange={(event) => field.handleChange(event.target.value)}><option value="900">15 minutes</option><option value="3600">1 hour</option><option value="14400">4 hours</option><option value="43200">12 hours</option></select></>}</form.Field>
          <p className="field-help">The server caps expiry at this browser session’s remaining lifetime.{sourceExpiresAt ? <> This source session expires <CredentialTime value={sourceExpiresAt} />.</> : null}</p>
          {validation ? <p className="error" role="alert">{validation}</p> : null}
          <div className="credential-actions"><form.Subscribe selector={(state) => state.values.label}>{(label) => <button className="button primary" disabled={!label.trim() || issuance.isPending || Boolean(listError) || query.isFetching || signingOut}>{issuance.isPending ? <LoaderCircle className="spin" size={16} /> : <Plus size={16} />}{issuance.isPending ? 'Creating…' : 'Create API credential'}</button>}</form.Subscribe><button type="button" className="button secondary" disabled={issuance.isPending} onClick={cancelEditor}>Cancel</button></div>
        </form>}
      </div>
    </section> : null}
    {notice && !listError ? <p className="session-notice" role="status">{notice}</p> : null}
    <section className="browser-panel credential-list-panel" aria-labelledby="credential-list-title" aria-busy={query.isFetching}>
      <div className="browser-panel-heading"><h2 id="credential-list-title">Your API credentials</h2><button className="button secondary" disabled={query.isFetching || issuance.isPending || revoke.isPending} onClick={() => void refresh()}><RefreshCw size={15} className={query.isFetching ? 'spin' : ''} />Refresh credentials</button></div>
      {listError ? <div className="panel-error"><p className="error" role="alert">{errorMessage(listError)}</p><button className="button secondary" disabled={query.isFetching} onClick={() => void refresh()}>Try again</button></div> : loading ? <Loading label="Loading API credentials…" /> : <>
        <DataTable data={credentials} columns={columns} getRowId={(credential) => credential.id} label="API credentials" emptyMessage="No API credentials" />
        <div className="list-footer credential-list-footer"><span>{credentials.length} loaded {credentials.length === 1 ? 'credential' : 'credentials'}</span><More hasMore={Boolean(query.hasNextPage)} loading={query.isFetching || revoke.isPending || issuance.isPending} load={() => void query.fetchNextPage()} label="credentials" /></div>
        <p className="panel-footnote">Metadata remains visible after expiry or revocation. An active source session alone does not grant access: the credential must also be unexpired, unrevoked and authorized by the repository service on each call. Lost secrets cannot be recovered.</p>
      </>}
    </section>
    {confirmation && !listError ? <RevokeCredential credential={confirmation} pending={revoke.isPending} onCancel={() => { if (!revoke.isPending) setConfirmation(null); }} onConfirm={confirmRevoke} /> : null}
  </div>;
}
