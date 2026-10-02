import { useEffect, useRef, useState } from 'react';
import { useInfiniteQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { ArrowDown, LoaderCircle, RefreshCw, ShieldCheck, X } from 'lucide-react';
import { errorMessage, sessionClient } from './api';
import type { SessionInfo } from './gen/golf/v1/golf_pb';

function SessionTime({ value }: { value: string }) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? <span>Time unavailable</span> : <time dateTime={value}>{date.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}</time>;
}

type Revocation = { kind: 'one'; sessionId: string } | { kind: 'others' };

export function SessionManager({ userId, onClose, onSignedOut }: { userId: string; onClose: () => void; onSignedOut: () => Promise<void> }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const cancelButton = useRef<HTMLButtonElement>(null);
  const previousFocus = useRef<HTMLElement | null>(null);
  const confirmationTrigger = useRef<HTMLButtonElement | null>(null);
  const [confirmation, setConfirmation] = useState<SessionInfo | 'others' | null>(null);
  const [notice, setNotice] = useState('');
  const client = useQueryClient();
  const queryKey = ['account-sessions', userId];
  const query = useInfiniteQuery({
    queryKey, initialPageParam: 1, staleTime: 0, gcTime: 0,
    queryFn: ({ pageParam, signal }) => sessionClient.listSessions({ page: { page: pageParam, limit: 20 } }, { signal, timeoutMs: 8_000 }),
    getNextPageParam: (page, _pages, currentPage) => {
      const next = page.page?.nextPage ?? 0;
      return next > currentPage && next <= 10_000 ? next : undefined;
    },
  });
  const revoke = useMutation({
    gcTime: 0,
    mutationFn: async (action: Revocation) => {
      if (action.kind === 'others') {
        const response = await sessionClient.revokeOtherSessions({}, { timeoutMs: 8_000 });
        return { currentSessionRevoked: false, notice: response.revokedCount === 0n ? 'No other active sessions were found.' : `${String(response.revokedCount)} other ${response.revokedCount === 1n ? 'session' : 'sessions'} revoked.` };
      }
      const response = await sessionClient.revokeSession({ sessionId: action.sessionId }, { timeoutMs: 8_000 });
      return { currentSessionRevoked: response.currentSessionRevoked, notice: 'Session revoked.' };
    },
    onSuccess: async (response) => {
      if (response.currentSessionRevoked) { await onSignedOut(); return; }
      setConfirmation(null);
      setNotice(response.notice);
      // Deletions shift offset pages. Start again at page one instead of retaining gaps.
      await client.resetQueries({ queryKey, exact: true });
    },
    onError: () => { setConfirmation(null); setNotice(''); },
  });
  const error = revoke.error ?? query.error;
  const sessions = !error && query.isSuccess && (!query.isFetching || query.isFetchingNextPage)
    ? [...new Map(query.data.pages.flatMap((page) => page.sessions).map((session) => [session.id, session])).values()] : [];
  const loading = query.isPending || (query.isFetching && !query.isFetchingNextPage);
  const confirming = confirmation !== null && !error;

  useEffect(() => {
    if (!previousFocus.current && document.activeElement instanceof HTMLElement) previousFocus.current = document.activeElement;
    const element = dialog.current;
    if (element && !element.open) element.showModal();
    closeButton.current?.focus();
    return () => {
      // Removal closes the native dialog. Calling close here also fires onClose
      // during React's development effect replay and would unmount a fresh modal.
      if (previousFocus.current?.isConnected) previousFocus.current.focus();
    };
  }, []);
  useEffect(() => {
    if (confirmation !== null) cancelButton.current?.focus();
    else if (confirmationTrigger.current?.isConnected) confirmationTrigger.current.focus();
    else closeButton.current?.focus();
  }, [confirmation]);

  function refresh() {
    setConfirmation(null);
    setNotice('');
    revoke.reset();
    void client.resetQueries({ queryKey, exact: true });
  }
  function confirm() {
    if (confirmation === null || revoke.isPending) return;
    revoke.mutate(confirmation === 'others' ? { kind: 'others' } : { kind: 'one', sessionId: confirmation.id });
  }

  return <dialog ref={dialog} className="create-dialog sessions-dialog" aria-labelledby="sessions-title" aria-describedby="sessions-boundary" onClose={onClose} onCancel={(event) => {
    if (revoke.isPending) event.preventDefault();
    else if (confirming) { event.preventDefault(); setConfirmation(null); }
  }}>
    <div className="dialog-header"><span className="small-icon"><ShieldCheck size={21} /></span><button ref={closeButton} className="icon-button" aria-label="Close sessions" disabled={revoke.isPending} onClick={onClose}><X size={19} /></button></div>
    <h2 id="sessions-title">Your Golf sessions</h2>
    <p className="muted" id="sessions-boundary">Revoke access to Golf on a session you no longer need. This does not revoke your Gitea token, OAuth provider consent or Git keys.</p>
    {error ? <div><p className="error" role="alert">{errorMessage(error)}</p><button className="button secondary" disabled={query.isFetching} onClick={refresh}>Try again</button></div> : null}
    {notice && !error ? <p className="session-notice" role="status">{notice}</p> : null}
    {confirming ? <section className="session-confirm" aria-labelledby="session-confirm-title">
      <h3 id="session-confirm-title">{confirmation === 'others' ? 'Revoke all other sessions?' : confirmation.current ? 'Revoke this session and sign out?' : 'Revoke this session?'}</h3>
      <p>{confirmation === 'others' ? 'All your other active Golf sessions will lose access, including sessions not loaded in this list. This session stays signed in.' : confirmation.current ? 'You will need to sign in again to use Golf in this browser.' : 'This Golf session will lose access on its next request.'}</p>
      {confirmation !== 'others' ? <p className="muted">Session <span className="session-id">{confirmation.id}</span> · Created <SessionTime value={confirmation.createdAt} /></p> : null}
      <div className="dialog-actions"><button ref={cancelButton} className="button secondary" disabled={revoke.isPending} onClick={() => setConfirmation(null)}>Cancel</button><button className="button session-danger" disabled={revoke.isPending} onClick={confirm}>{revoke.isPending ? <LoaderCircle size={16} className="spin" /> : null}{revoke.isPending ? 'Revoking…' : confirmation === 'others' ? 'Confirm revoke other sessions' : 'Confirm revoke session'}</button></div>
    </section> : null}
    <div hidden={confirming}>
      {!error ? <>
        <div className="session-toolbar"><button className="button secondary" disabled={query.isFetching || revoke.isPending} onClick={refresh}><RefreshCw size={15} />Refresh sessions</button><button className="text-button" disabled={loading || revoke.isPending || !sessions.some((session) => !session.current) && !query.hasNextPage} onClick={(event) => { confirmationTrigger.current = event.currentTarget; setNotice(''); setConfirmation('others'); }}>Revoke all other sessions</button></div>
        <div aria-busy={query.isFetching || revoke.isPending}>
          {loading ? <p className="browser-loading" role="status"><LoaderCircle className="spin" size={18} />Loading sessions…</p> : sessions.length ? <ul className="session-list">{sessions.map((session) => <li className="session-row" key={session.id}>
            <div><div className="session-heading"><h3>{session.credentialKind === 'oauth' ? 'Gitea OAuth' : session.credentialKind === 'pat' ? 'Gitea access token' : 'Golf session'}</h3>{session.current ? <span className="visibility">Current session</span> : null}</div><p className="session-id">Session {session.id}</p><dl><div><dt>Created</dt><dd><SessionTime value={session.createdAt} /></dd></div><div><dt>Expires</dt><dd><SessionTime value={session.expiresAt} /></dd></div></dl></div>
            <button className="button secondary" disabled={revoke.isPending || query.isFetching} aria-label={session.current ? 'Revoke current session' : `Revoke session ${session.id}`} onClick={(event) => { confirmationTrigger.current = event.currentTarget; setNotice(''); setConfirmation(session); }}>Revoke</button>
          </li>)}</ul> : <div className="empty-state"><ShieldCheck size={25} /><h3>No active sessions returned</h3><p>Refresh to check your account again.</p></div>}
        </div>
        {!loading ? <div className="list-footer"><span>{sessions.length} loaded {sessions.length === 1 ? 'session' : 'sessions'}</span>{query.hasNextPage ? <button className="text-button" disabled={query.isFetching || revoke.isPending} onClick={() => void query.fetchNextPage()}>{query.isFetchingNextPage ? 'Loading…' : 'Load more sessions'}<ArrowDown size={14} /></button> : null}</div> : null}
      </> : null}
    </div>
  </dialog>;
}
