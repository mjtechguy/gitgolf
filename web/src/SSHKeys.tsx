import { useEffect, useMemo, useRef, useState } from 'react';
import { useForm } from '@tanstack/react-form';
import { DataTable } from './DataTable';
import type { DataTableColumn } from './DataTable';
import { useInfiniteQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { KeyRound, LoaderCircle, RefreshCw, X } from 'lucide-react';
import { gitAccessClient, errorMessage } from './api';
import type { SSHKey, User } from './gen/golf/v1/golf_pb';
import { Loading, More, privateQuery } from './RepositoryUI';

function RemoveKey({ value, pending, onClose, onConfirm }: { value: SSHKey; pending: boolean; onClose: () => void; onConfirm: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const previous = document.activeElement;
    dialog.current?.showModal(); cancel.current?.focus();
    return () => { if (previous instanceof HTMLElement && previous.isConnected) previous.focus(); };
  }, []);
  return <dialog ref={dialog} className="create-dialog" aria-labelledby="remove-key-title" onClose={onClose} onCancel={(event) => { if (pending) event.preventDefault(); }}>
    <div className="dialog-header"><span className="small-icon"><KeyRound size={21} /></span><button className="icon-button" aria-label="Close SSH key removal" disabled={pending} onClick={onClose}><X size={19} /></button></div>
    <h2 id="remove-key-title">Remove this SSH key?</h2><p>“{value.title}” will no longer authenticate new Git SSH connections.</p><p className="field-help"><code>{value.fingerprint}</code></p>
    <div className="dialog-actions"><button ref={cancel} className="button secondary" disabled={pending} onClick={onClose}>Cancel</button><button className="button session-danger" disabled={pending} onClick={onConfirm}>{pending ? 'Removing…' : 'Confirm remove key'}</button></div>
  </dialog>;
}

export function SSHKeys({ userId, signingOut }: { userId: string; signingOut: boolean }) {
  const client = useQueryClient();
  const queryKey = ['ssh-keys', userId];
  const [editing, setEditing] = useState(false);
  const newKeyButton = useRef<HTMLButtonElement>(null);
  const returnToNewKey = useRef(false);
  const [confirmation, setConfirmation] = useState<SSHKey | null>(null);
  const [notice, setNotice] = useState('');
  const [uncertain, setUncertain] = useState(false);
  const alive = useRef(true);
  const controller = useRef<AbortController | null>(null);
  const busy = useRef(false);
  const active = () => alive.current && !signingOut && client.getQueryData<User | null>(['session'])?.id === userId;
  useEffect(() => { alive.current = true; return () => { alive.current = false; controller.current?.abort(); }; }, []);
  useEffect(() => { if (signingOut) { controller.current?.abort(); setConfirmation(null); } }, [signingOut]);
  const query = useInfiniteQuery({
    ...privateQuery, queryKey, initialPageParam: 1,
    queryFn: ({ pageParam, signal }) => gitAccessClient.listSSHKeys({ page: { page: pageParam, limit: 20 } }, { signal, timeoutMs: 8_000 }),
    getNextPageParam: (response, _pages, page) => {
      const next = response.page?.nextPage ?? 0;
      return next > page && next <= 10_000 ? next : undefined;
    },
  });
  const form = useForm({
    defaultValues: { title: '', publicKey: '' },
    validators: {
      onSubmit: ({ value }) => {
        const label = value.title.trim(); const key = value.publicKey.trim();
        if (!label || new TextEncoder().encode(label).length > 64 || /\p{Cc}/u.test(label)) return 'Use a key title of 1–64 bytes without control characters.';
        if (!key || new TextEncoder().encode(key).length > 8192 || /[\r\n]/.test(key) || !/^(ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp(256|384|521)|sk-ssh-ed25519@openssh.com|sk-ecdsa-sha2-nistp256@openssh.com)\s/.test(key)) return 'Paste one OpenSSH public key. Private keys, options and certificates are not accepted.';
        return undefined;
      },
    },
    onSubmit: ({ value }) => {
      if (busy.current || disabled) return;
      busy.current = true; setNotice(''); mutation.mutate({ title: value.title.trim(), publicKey: value.publicKey.trim() });
    },
  });
  const mutation = useMutation({
    gcTime: 0, retry: false,
    mutationFn: async (input: { remove: string } | { title: string; publicKey: string }) => {
      const abort = new AbortController(); controller.current = abort;
      if ('remove' in input) await gitAccessClient.deleteSSHKey({ keyId: input.remove }, { signal: abort.signal, timeoutMs: 8_000 });
      else {
        const response = await gitAccessClient.addSSHKey(input, { signal: abort.signal, timeoutMs: 8_000 });
        if (!response.key?.id) throw new Error('The key result is incomplete. Refresh your keys before continuing.');
      }
    },
    onSuccess: async (_result, input) => {
      if (!active()) return;
      setConfirmation(null); setNotice('remove' in input ? 'SSH key removed.' : 'SSH key added.');
      if (!('remove' in input)) { form.reset(); setEditing(false); }
      await client.resetQueries({ queryKey, exact: true });
    },
    onError: () => { if (active()) { setConfirmation(null); setNotice(''); setUncertain(true); } },
    onSettled: () => { busy.current = false; controller.current = null; },
  });
  const listError = query.error;
  const loading = query.isPending || (query.isFetching && !query.isFetchingNextPage);
  const keys = useMemo(() => query.isSuccess && !listError && !loading && !signingOut ? [...new Map(query.data.pages.flatMap((page) => page.keys).map((key) => [key.id, key])).values()] : [], [query.isSuccess, query.data, listError, loading, signingOut]);
  useEffect(() => { if (listError) { controller.current?.abort(); setConfirmation(null); } }, [listError]);
  const disabled = mutation.isPending || query.isFetching || !!listError || uncertain || signingOut;
  useEffect(() => {
    if (editing) returnToNewKey.current = true;
    else if (returnToNewKey.current && !mutation.isPending) { returnToNewKey.current = false; newKeyButton.current?.focus(); }
  }, [editing, mutation.isPending]);
  async function refresh() {
    if (busy.current || signingOut) return;
    mutation.reset(); setNotice(''); setConfirmation(null);
    await client.resetQueries({ queryKey, exact: true });
    if (active() && !client.getQueryState(queryKey)?.error) setUncertain(false);
  }
  const columns = useMemo<DataTableColumn<SSHKey>[]>(() => [
    { accessorKey: 'title', header: 'Key', cell: ({ row }) => <><strong>{row.original.title}</strong><p>Account Git access</p></> },
    { accessorKey: 'fingerprint', header: 'Fingerprint', cell: ({ row }) => <code>{row.original.fingerprint}</code> },
    { accessorKey: 'createdAt', header: 'Added', cell: ({ row }) => new Date(row.original.createdAt).toLocaleDateString() },
    { accessorKey: 'lastUsedAt', header: 'Last used', cell: ({ row }) => row.original.lastUsedAt ? new Date(row.original.lastUsedAt).toLocaleDateString() : 'Not recorded' },
    { id: 'actions', header: 'Actions', enableSorting: false, enableGlobalFilter: false, cell: ({ row }) => <button className="button secondary" disabled={disabled} onClick={() => { mutation.reset(); setConfirmation(row.original); }}>Remove {row.original.title}</button> },
  ], [disabled, mutation.reset]);
  function cancelEditor() {
    if (mutation.isPending) return;
    form.reset(); setEditing(false);
  }
  return <section className="api-credentials" aria-labelledby="ssh-keys-title">
    <header className="repository-intro"><div><span className="eyebrow">YOUR CODE, YOUR CONNECTION</span><h1 id="ssh-keys-title"><KeyRound size={29} />SSH keys</h1></div><div className="dialog-actions"><button className="button secondary" disabled={mutation.isPending || query.isFetching || signingOut} onClick={() => void refresh()}><RefreshCw size={16} />Refresh SSH keys</button><button ref={newKeyButton} className="button primary" disabled={disabled || editing} onClick={() => { form.reset(); setEditing(true); }}><KeyRound size={16} />New SSH key</button></div></header>
    <p className="organization-guidance">Connect your Git client to Golf. Keys use your repository permissions and remain active until removed; signing out does not remove them.</p>
    {listError || mutation.error ? <p role="alert" className="error">{errorMessage((listError ?? mutation.error)! as Error)}</p> : null}
    {uncertain ? <p role="alert" className="organization-guidance">The change may already have completed. Refresh your SSH keys and inspect the list before trying again.</p> : null}
    {notice ? <p role="status">{notice}</p> : null}
    {editing ? <article className="browser-panel credential-create-panel"><div className="browser-panel-heading"><h2>Add an SSH key</h2></div><div className="credential-form-content"><form onSubmit={(event) => { event.preventDefault(); if (!disabled) void form.handleSubmit(); }}>
      <form.Field name="title">{(field) => <><label htmlFor="ssh-title">Key title</label><input id="ssh-title" value={field.state.value} onBlur={field.handleBlur} onChange={(event) => field.handleChange(event.target.value)} disabled={disabled} placeholder="My laptop" maxLength={64} autoFocus /></>}</form.Field>
      <form.Field name="publicKey">{(field) => <><label htmlFor="ssh-public">Public key</label><textarea id="ssh-public" value={field.state.value} onBlur={field.handleBlur} onChange={(event) => field.handleChange(event.target.value)} disabled={disabled} rows={4} spellCheck={false} autoComplete="off" placeholder="ssh-ed25519 AAAA…" /></>}</form.Field>
      <p className="field-help">Generate a key with <code>ssh-keygen -t ed25519</code> and paste the contents of its <code>.pub</code> file. Keep the private key on your machine.</p>
      <p className="field-help">Account keys apply to every repository you can access. They are not scoped agent credentials.</p>
      <form.Subscribe selector={(state) => state.errors}>{(errors) => errors.length ? <p role="alert" className="error">{errors.join(' ')}</p> : null}</form.Subscribe>
      <div className="dialog-actions"><button className="button secondary" type="button" disabled={mutation.isPending} onClick={cancelEditor}>Cancel</button><button className="button primary" disabled={disabled} type="submit">{mutation.isPending ? <LoaderCircle size={16} className="spin" /> : <KeyRound size={16} />}Add SSH key</button></div>
    </form></div></article> : null}
    {loading ? <Loading label="Loading SSH keys…" /> : null}
    {!listError && !loading ? <><DataTable label="SSH keys" data={keys} columns={columns} getRowId={(key) => key.id} emptyMessage="No SSH keys on your account." /><More hasMore={query.hasNextPage} loading={query.isFetchingNextPage} label="SSH keys" load={() => void query.fetchNextPage()} /></> : null}
    {confirmation ? <RemoveKey value={confirmation} pending={mutation.isPending} onClose={() => setConfirmation(null)} onConfirm={() => { if (busy.current || disabled) return; busy.current = true; mutation.mutate({ remove: confirmation.id }); }} /> : null}
  </section>;
}
