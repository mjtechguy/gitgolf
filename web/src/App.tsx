import { Breadcrumbs } from './Breadcrumbs';
import { useForm, useStore } from '@tanstack/react-form';
import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowDown, ArrowRight, BookOpen, Check, CircleDot, Command, ExternalLink, GitBranch, KeyRound, Layers2, LoaderCircle, LockKeyhole, LogOut, Moon, Plus, RefreshCw, Search, Settings, ShieldCheck, Sun, UserRound, X } from 'lucide-react';
import { Code, ConnectError } from '@connectrpc/connect';
import { Link, useLocation } from '@tanstack/react-router';
import { create } from '@bufbuild/protobuf';
import { repositoryExecutionValueClient, errorMessage, repositoryClient, repositoryLink, sessionClient } from './api';
import { CreateRepositoryRequestSchema, RepositoryCreationState } from './gen/golf/v1/golf_pb';
import type { CreateRepositoryRequest, Repository, RepositoryCreation, User } from './gen/golf/v1/golf_pb';
import { repositoryOptions } from './navigation';
import type { Location } from './navigation';
import { forgetPrivateQueries } from './queryClient';
import { AccountLayout, AccountSettings, RepositorySettingsLayout, ScopedSettings } from './AccountSettings';
import { WorkspaceSwitcher } from './WorkspaceSwitcher';
const Capabilities = lazy(() => import('./Capabilities').then(module => ({ default: module.Capabilities })));
import { clearOtherIssueIntents } from './issueIntents';
import { clearOtherReviewIntents } from './reviewIntents';

const CodexConnections = lazy(() => import('./CodexConnections').then(module => ({ default: module.CodexConnections })));
const AccountSecurity = lazy(() => import('./AccountSecurity').then(module => ({ default: module.AccountSecurity })));
const InstanceSettings = lazy(() => import('./InstanceSettings').then((module) => ({ default: module.InstanceSettings })));
const OrganizationTeamSettings = lazy(() => import('./OrganizationTeamSettings').then((module) => ({ default: module.OrganizationTeamSettings })));
const RepositoryInvitationInbox = lazy(() => import('./RepositoryInvitationInbox').then(module => ({default:module.RepositoryInvitationInbox})));
const RepositoryRulesSettings = lazy(() => import('./RepositoryRulesSettings').then(module => ({ default: module.RepositoryRulesSettings })));
const RepositoryRunnerSettings = lazy(() => import('./RepositoryRunnerSettings').then(module => ({ default: module.RepositoryRunnerSettings })));
const RepositoryExecutionValues = lazy(() => import('./RepositoryExecutionValues').then(module => ({default:module.RepositoryExecutionValues})));
const RepositoryWebhooks = lazy(() => import('./RepositoryWebhooks').then(module => ({default:module.RepositoryWebhooks})));
const RepositoryAccessSettings = lazy(() => import('./RepositoryAccessSettings').then((module) => ({ default: module.RepositoryAccessSettings })));
const WorkflowConfigurations = lazy(() => import('./WorkflowConfigurations').then((module) => ({ default: module.WorkflowConfigurations })));
const RepositorySettings = lazy(() => import('./RepositorySettings').then((module) => ({ default: module.RepositorySettings })));
const RepositoryBrowser = lazy(() => import('./RepositoryBrowser').then((module) => ({ default: module.RepositoryBrowser })));
const OrganizationBrowser = lazy(() => import('./OrganizationBrowser').then((module) => ({ default: module.OrganizationBrowser })));
const SSHKeys = lazy(() => import('./SSHKeys').then((module) => ({ default: module.SSHKeys })));
const ApiCredentials = lazy(() => import('./ApiCredentials').then((module) => ({ default: module.ApiCredentials })));
const AccountActivity = lazy(() => import('./AccountActivity').then((module) => ({ default: module.AccountActivity })));
const SessionManager = lazy(() => import('./SessionManager').then((module) => ({ default: module.SessionManager })));

const themes = ['dark', 'light'] as const;
type Theme = typeof themes[number];

function Brand() {
  return <Link className="brand" to="/" aria-label="Golf home"><span className="brand-mark" aria-hidden="true">g</span><span>golf<span className="brand-dot">.</span></span></Link>;
}

function ThemeSwitch() {
  const [theme, setTheme] = useState<Theme>(() => document.documentElement.dataset.theme === 'light' ? 'light' : 'dark');
  const next = theme === 'dark' ? 'light' : 'dark';
  const Icon = next === 'dark' ? Moon : Sun;
  function toggleTheme() {
    setTheme(next);
    document.documentElement.dataset.theme = next;
    try { localStorage.setItem('golf.theme', next); } catch { /* Theme still works when storage is unavailable. */ }
  }
  return <button className="theme-toggle" type="button" aria-label={`Switch to ${next} theme`} title={`Switch to ${next} theme`} onClick={toggleTheme}><Icon size={18} aria-hidden="true" /></button>;
}

function ErrorMessage({ error }: { error: Error | null }) {
  return error ? <p className="error" role="alert">{errorMessage(error)}</p> : null;
}

const scopeLabels: Record<string, string> = {
  'read:user': 'Read user resources',
  'write:user': 'Read and write user resources',
  'read:repository': 'Read repository data',
  'write:repository': 'Read and write repository data',
  'read:issue': 'Read issues',
  'read:organization': 'Read organization resources',
  'write:issue': 'Read and write issues',
  all: 'Full account access',
};

function Login({ oauthFailed, notice }: { oauthFailed: boolean; notice?: string }) {
  const client = useQueryClient();
  const loginForm = useForm({ defaultValues: { username: '', password: '' }, onSubmit: async () => { await submitPassword(); } });
  const { username, password } = useStore(loginForm.store, (state) => state.values);
  const setUsername = (value: string) => loginForm.setFieldValue('username', value);
  const setPassword = (value: string) => loginForm.setFieldValue('password', value);
  const [passwordPending, setPasswordPending] = useState(false);
  const [passwordError, setPasswordError] = useState<Error | null>(null);
  const passwordAttempt = useRef<AbortController | null>(null);
  useEffect(() => {
    const clear = () => { setPassword(''); passwordAttempt.current?.abort(); };
    window.addEventListener('pagehide', clear);
    return () => { window.removeEventListener('pagehide', clear); passwordAttempt.current?.abort(); };
  }, []);
  const options = useQuery({
    queryKey: ['authentication-options'], staleTime: 0, gcTime: 0,
    queryFn: ({ signal }) => sessionClient.getAuthenticationOptions({}, { signal, timeoutMs: 8_000 }),
  });
  const passwordAvailable = options.isSuccess && !options.isFetching && options.data.localPasswordEnabled;
  const oauthAvailable = options.isSuccess && !options.isFetching && options.data.giteaOauthEnabled;
  async function signedIn() {
    setPassword('');
    forgetPrivateQueries(client);
    await client.invalidateQueries({ queryKey: ['session'] });
  }
  const oauth = useMutation({
    gcTime: 0,
    mutationFn: async () => {
      const result = await sessionClient.beginGiteaOAuth({}, { timeoutMs: 8_000 });
      const destination = repositoryLink(result.authorizationUrl);
      if (!destination) throw new ConnectError('Golf received an invalid sign-in address. Try again or sign in with your Golf account.', Code.Internal);
      return destination;
    },
    onSuccess: (destination) => { window.location.assign(destination); },
  });
  const redirecting = oauth.isPending || oauth.isSuccess;
  const busy = passwordPending || redirecting;
  async function submitPassword() {
    if (!passwordAvailable || busy || passwordAttempt.current || !username.trim() || !password) return;
    // Keep the credential out of mutation/query caches and clear the input before waiting.
    const request = { username: username.trim(), password };
    const controller = new AbortController();
    passwordAttempt.current = controller;
    setPassword(''); setPasswordError(null); setPasswordPending(true);
    try {
      await sessionClient.loginWithPassword(request, { signal: controller.signal, timeoutMs: 15_000 });
      await signedIn();
    } catch (error) {
      if (!controller.signal.aborted) setPasswordError(new Error(error instanceof ConnectError && error.code === Code.ResourceExhausted ? 'Too many sign-in attempts. Wait a few minutes and try again.' : error instanceof ConnectError && error.code === Code.Unavailable ? 'Sign-in is temporarily unavailable. Try again later.' : 'Sign-in could not be completed. Check your Golf email or username and password and try again.'));
    } finally {
      request.password = '';
      passwordAttempt.current = null;
      setPasswordPending(false);
    }
  }
  return <div className="login-page">
    <header className="login-header"><Brand /><ThemeSwitch /></header>
    <main className="login-main" id="main-content">
      <section className="login-story">
        <span className="eyebrow"><span className="status-dot" /> THE START OF SOMETHING GOOD</span>
        <h1>Your code.<br />Your next <span>great idea.</span></h1>
        <p>A focused home for the repositories you’re building. Sign in and get straight to work.</p>
        <div className="story-art" aria-hidden="true"><div className="art-grid" /><div className="art-path"><GitBranch size={25} /><span /><CircleDot size={15} /><span /><Check size={20} /></div><div className="art-label"><span>idea</span><span>commit</span><span>possibility</span></div></div>
        <div className="story-footer"><ShieldCheck size={17} /><span>Your repositories. Your infrastructure.</span></div>
      </section>
      <section className="login-card" aria-labelledby="login-title">
        <span className="small-icon"><KeyRound size={21} /></span>
        <h2 id="login-title">Welcome to Golf</h2>
        <p>Sign in with your Golf account.</p>
        {notice ? <p className="session-notice" role="status">{notice}</p> : null}
        {oauthFailed ? <p className="error" role="alert">Provider sign-in could not be completed. Please try again or sign in with your Golf account.</p> : null}
        {options.isPending || options.isFetching ? <p className="auth-options-status" role="status"><LoaderCircle className="spin" size={14} />Checking sign-in options…</p> : options.isError ? <div className="auth-options-error"><p className="error" role="alert">Sign-in options could not be loaded. Retry or contact your installation administrator.</p><button className="text-button" onClick={() => void options.refetch()}>Retry sign-in options</button></div> : !passwordAvailable ? <p className="auth-options-status">Golf password sign-in is not enabled for this installation. {oauthAvailable ? 'Use the connected provider below.' : 'Contact your installation administrator to enable sign-in.'}</p> : null}
        <form onSubmit={(event) => { event.preventDefault(); void loginForm.handleSubmit(); }} aria-label="Golf account sign-in">
          <label htmlFor="golf-username">Email or username</label>
          <input id="golf-username" name="username" autoComplete="username" autoCapitalize="none" spellCheck={false} required value={username} onChange={(event) => setUsername(event.target.value)} disabled={!passwordAvailable || busy} />
          <label htmlFor="golf-password">Password</label>
          <input id="golf-password" name="password" type="password" autoComplete="current-password" required value={password} onChange={(event) => setPassword(event.target.value)} aria-describedby="password-help" disabled={!passwordAvailable || busy} />
          <p className="field-help" id="password-help">Use the Golf account enrolled by your installation operator.</p>
          <ErrorMessage error={passwordError} />
          <button className="button primary full" disabled={!passwordAvailable || !username.trim() || !password || busy}>{passwordPending ? <LoaderCircle size={17} className="spin" /> : <ArrowRight size={17} />}{passwordPending ? 'Signing in…' : 'Sign in'}</button>
        </form>
        {oauthAvailable ? <section className="oauth-section" aria-label="Provider sign-in">
          <p className="oauth-provider">Continue through your connected provider. Your provider password stays with it.</p>
          <div className="oauth-permissions" id="oauth-permissions"><h3>Requested permissions</h3><p>Golf requests these scopes within your existing account access.</p>{options.data.scopes.length ? <ul>{options.data.scopes.map((scope) => <li key={scope}><code>{scope}</code>{scopeLabels[scope] ? <span>{scopeLabels[scope]}</span> : null}</li>)}</ul> : <p>No additional scopes were listed by this installation.</p>}</div>
          <ErrorMessage error={oauth.error} />
          <button className="button secondary full" disabled={busy} aria-describedby="oauth-permissions" onClick={() => { if (passwordAttempt.current) return; setPassword(''); setPasswordError(null); oauth.mutate(); }}>{redirecting ? <LoaderCircle className="spin" size={17} /> : <GitBranch size={17} />}{redirecting ? 'Continuing to provider…' : 'Continue with provider'}{!redirecting ? <ArrowRight size={17} /> : null}</button>
        </section> : null}
        <div className="login-note"><LockKeyhole size={15} /><span>Golf stores provider credentials on the server. They are never saved in browser storage.</span></div>
      </section>
    </main>
    <footer className="login-footer"><span>Golf · Early development</span><span>Built around developers.</span></footer>
  </div>;
}

type PendingCreation = { key: string; name: string; private: boolean };
const creationStoragePrefix = 'golf.repository-creation.';
function creationStorageKey(userId: string) { return `${creationStoragePrefix}${window.location.origin}:${userId}`; }
function clearOtherCreationIntents(userId?: string) {
  clearOtherIssueIntents(userId);
  clearOtherReviewIntents(userId);
  try {
    const keep = userId ? creationStorageKey(userId) : undefined;
    for (const key of Object.keys(sessionStorage)) if (key.startsWith(creationStoragePrefix) && key !== keep) sessionStorage.removeItem(key);
  } catch { /* Creation itself requires writable storage before sending. */ }
}
function pendingCreation(userId: string): PendingCreation | null {
  try {
    const value: unknown = JSON.parse(sessionStorage.getItem(creationStorageKey(userId)) || 'null');
    if (value && typeof value === 'object' && 'key' in value && 'name' in value && 'private' in value &&
        typeof value.key === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value.key) &&
        typeof value.name === 'string' && value.name.length <= 100 && typeof value.private === 'boolean') {
      return { key: value.key, name: value.name, private: value.private };
    }
  } catch { /* Never trust browser storage as operation evidence. */ }
  return null;
}

function CreateRepository({ userId, initial, onPendingChange, onClose }: { userId: string; initial: PendingCreation | null; onPendingChange: (value: PendingCreation | null) => void; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const nameInput = useRef<HTMLInputElement>(null);
  const statusButton = useRef<HTMLButtonElement>(null);
  const frozen = useRef<CreateRepositoryRequest | null>(null);
  const mounted = useRef(true);
  const client = useQueryClient();
  const [intent, setIntent] = useState(initial);
  const form = useForm({ defaultValues: { name: initial?.name || '', description: '', isPrivate: initial?.private ?? true }, onSubmit: () => submit() });
  const { name, description, isPrivate } = useStore(form.store, (state) => state.values);
  const setName = (value: string) => form.setFieldValue('name', value);
  const setDescription = (value: string) => form.setFieldValue('description', value);
  const setPrivate = (value: boolean) => form.setFieldValue('isPrivate', value);
  const [creation, setCreation] = useState<RepositoryCreation | null>(null);
  const [localError, setLocalError] = useState<Error | null>(null);
  const active = () => client.getQueryData<User | null>(['session'])?.id === userId;
  async function observe(result: { creation?: RepositoryCreation; repository?: Repository }, key: string) {
    if (!mounted.current || !active()) return;
    if (!result.creation || result.creation.idempotencyKey !== key || result.creation.requestedName !== name.trim() || result.creation.private !== isPrivate) {
      throw new ConnectError('The creation record does not match this request. Keep this request key and check its status.', Code.FailedPrecondition);
    }
    setCreation(result.creation);
    if (result.creation.state === RepositoryCreationState.SUCCEEDED) {
      try { sessionStorage.removeItem(creationStorageKey(userId)); } catch { /* A later status check can recover this terminal record. */ }
      onPendingChange(null);
      await client.invalidateQueries({ queryKey: ['repositories', userId] });
      if (active() && result.repository && result.repository.id === result.creation.repositoryId) onClose();
    }
  }
  const mutation = useMutation({
    gcTime: 0, retry: false,
    mutationFn: async (request: CreateRepositoryRequest) => {
      const result = await repositoryClient.createRepository(request, { timeoutMs: 15_000 });
      await observe(result, request.idempotencyKey);
    },
    onMutate: () => { setCreation(null); setLocalError(null); },
    onError: () => setCreation(null),
  });
  const status = useMutation({
    gcTime: 0, retry: false,
    mutationFn: async (key: string) => {
      const result = await repositoryClient.getRepositoryCreation({ idempotencyKey: key }, { timeoutMs: 8_000 });
      await observe(result, key);
    },
    onMutate: () => { setCreation(null); setLocalError(null); mutation.reset(); },
    onError: () => setCreation(null),
  });
  const busy = mutation.isPending || status.isPending;
  const rejected = creation?.state === RepositoryCreationState.REJECTED;
  const succeeded = creation?.state === RepositoryCreationState.SUCCEEDED;
  useEffect(() => { mounted.current = true; dialog.current?.showModal(); if (initial) statusButton.current?.focus(); else nameInput.current?.focus(); return () => { mounted.current = false; }; }, []);
  function submit() {
    if (!name.trim() || busy || intent || frozen.current) return;
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(name.trim())) {
      setLocalError(new Error('Use 1–100 letters, numbers, dots, underscores or hyphens, starting with a letter or number. No request was sent.'));
      return;
    }
    const trimmedDescription = description.trim();
    const descriptionBytes = new TextEncoder().encode(trimmedDescription);
    if (new TextDecoder().decode(descriptionBytes) !== trimmedDescription) {
      setLocalError(new Error('The description contains invalid Unicode. Replace the invalid text before creating the repository. No request was sent.'));
      return;
    }
    if (descriptionBytes.byteLength > 2000) {
      setLocalError(new Error('The description must fit within 2,000 UTF-8 bytes. Shorten it before creating the repository. No request was sent.'));
      return;
    }
    try {
      const request = create(CreateRepositoryRequestSchema, { name: name.trim(), description: trimmedDescription, private: isPrivate, idempotencyKey: crypto.randomUUID() });
      const pending = { key: request.idempotencyKey, name: request.name, private: isPrivate };
      sessionStorage.setItem(creationStorageKey(userId), JSON.stringify(pending));
      frozen.current = request;
      setIntent(pending); onPendingChange(pending);
      mutation.mutate(request);
    } catch {
      setLocalError(new Error('Golf needs secure random IDs and writable tab session storage before starting creation. No request was sent.'));
    }
  }
  function newIntent() {
    if (!rejected || busy) return;
    try { sessionStorage.removeItem(creationStorageKey(userId)); } catch { /* The next submission must replace the stored intent successfully. */ }
    frozen.current = null; setIntent(null); onPendingChange(null); setCreation(null); setLocalError(null); mutation.reset(); status.reset();
    requestAnimationFrame(() => nameInput.current?.focus());
  }
  return <dialog ref={dialog} className="create-dialog" onClose={onClose} aria-labelledby="create-title">
    <div className="dialog-header"><span className="small-icon"><BookOpen size={21} /></span><button className="icon-button" aria-label="Close new repository form" onClick={onClose}><X size={19} /></button></div>
    <h2 id="create-title">{intent ? 'Repository creation.' : 'Start something new.'}</h2><p className="muted">{intent ? 'Track this creation request.' : 'Create a repository in your Golf workspace.'}</p>
    <form onSubmit={(event) => { event.preventDefault(); void form.handleSubmit(); }}>
      <label htmlFor="repo-name">Repository name <span className="required">*</span></label>
      <input ref={nameInput} id="repo-name" required maxLength={100} autoComplete="off" value={name} onChange={(event) => setName(event.target.value)} placeholder="my-next-project" disabled={Boolean(intent)} />
      <label htmlFor="repo-description">Description <span className="optional">optional</span></label>
      <textarea id="repo-description" maxLength={2000} rows={3} value={description} onChange={(event) => setDescription(event.target.value)} placeholder="What are you building?" disabled={Boolean(intent)} />
      <label className="visibility-choice"><input type="checkbox" checked={isPrivate} onChange={(event) => setPrivate(event.target.checked)} disabled={Boolean(intent)} /><LockKeyhole size={18} /><span><strong>Private repository</strong><small>{isPrivate ? 'Only you and people you authorize can access it.' : 'Public: code will be visible to everyone with access to your forge.'}</small></span></label>
      {intent ? <div className="creation-status" role="status"><p>{succeeded ? 'Creation succeeded, but Golf cannot currently confirm access to the repository. This record does not grant access.' : rejected ? 'Creation was rejected. You can explicitly start a new request and edit its details.' : busy ? 'Checking this creation request… Its outcome may still be unknown.' : 'Creation may still be running, or its outcome is unknown. Keep this request key; do not start a replacement request.'}</p><p className="field-help">Request key <code>{intent.key}</code></p>{!frozen.current ? <p className="field-help">The description was not saved. This resumed intent supports status checks only; it will never automatically resubmit.</p> : null}<p className="field-help">Closing this dialog does not cancel provider work. Only the request key, name and visibility are saved in this tab until sign-out.</p></div> : null}
      <ErrorMessage error={localError || status.error || mutation.error} />
      <div className="dialog-actions creation-actions"><button type="button" className="button secondary" onClick={onClose}>{intent ? 'Close' : 'Cancel'}</button>{intent ? <><button ref={statusButton} type="button" className="button secondary" disabled={busy} onClick={() => status.mutate(intent.key)}>{status.isPending ? 'Checking…' : 'Check status'}</button>{rejected ? <button type="button" className="button primary" onClick={newIntent}>Start a new request</button> : !succeeded && frozen.current ? <button type="button" className="button primary" disabled={busy} onClick={() => { status.reset(); mutation.mutate(frozen.current!); }}>{mutation.isPending ? 'Creating…' : 'Retry same request'}</button> : null}</> : <button className="button primary" disabled={!name.trim() || busy}><Plus size={16} />Create repository</button>}</div>
    </form>
  </dialog>;
}

function RepositoryRow({ repository }: { repository: Repository }) {
  const link = repositoryLink(repository.htmlUrl);
  const owner = repository.fullName.split('/')[0];
  const internal = owner ? repositoryOptions({ owner, name: repository.name }) : undefined;
  const updated = new Date(repository.updatedAt);
  return <article className="repository-row">
    <div className="repository-icon"><BookOpen size={21} /></div>
    <div className="repository-detail"><div className="repository-heading"><h3>{internal ? <Link {...internal}>{repository.fullName || repository.name}</Link> : repository.fullName || repository.name}</h3><span className={`visibility ${repository.private ? 'private' : ''}`}>{repository.private ? <LockKeyhole size={11} /> : null}{repository.private ? 'Private' : 'Public'}</span></div>
      <p>{repository.description || 'No description yet.'}</p>
      <div className="repository-meta"><span><GitBranch size={13} />{repository.defaultBranch || 'No default branch'}</span>{!Number.isNaN(updated.getTime()) ? <time dateTime={repository.updatedAt} title={updated.toLocaleString()}>Updated {updated.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}</time> : <span>Update time unavailable</span>}</div>
    </div>
    {link ? <a className="open-repository" href={link} target="_blank" rel="noopener noreferrer" aria-label={`Open ${repository.fullName || repository.name} in the repository interface`}><ExternalLink size={16} /></a> : null}
  </article>;
}


function Workspace({ user, location, onSessionEnd }: { user: User; location: Location; onSessionEnd: (notice?: string) => void }) {
  const hash = useLocation({ select: (current) => current.hash });
  const client = useQueryClient();
  const [search, setSearch] = useState('');
  const [visibility, setVisibility] = useState('all');
  const [ownership, setOwnership] = useState('all');
  const [creating, setCreating] = useState(false);
  const [pending, setPending] = useState(() => pendingCreation(user.id));
  const accountMenu = useRef<HTMLDetailsElement>(null);
  function closeAccountMenu() { if (accountMenu.current) accountMenu.current.open = false; }
  const repositoryQuery = useInfiniteQuery({
    queryKey: ['repositories', user.id], initialPageParam: 1, staleTime: 0, gcTime: 0, enabled: location.kind === 'home' && hash !== 'capabilities',
    queryFn: ({ pageParam, signal }) => repositoryClient.listRepositories({ page: { page: pageParam } }, { signal }),
    getNextPageParam: (lastPage) => lastPage.page?.nextPage || undefined,
  });
  const repositories = repositoryQuery.isSuccess && (!repositoryQuery.isFetching || repositoryQuery.isFetchingNextPage) ? [...new Map(repositoryQuery.data.pages.flatMap((page) => page.repositories).map((repository) => [repository.id, repository])).values()] : [];
  const filtered = repositories.filter((repository) => `${repository.fullName} ${repository.description}`.toLowerCase().includes(search.toLowerCase().trim()) && (visibility === 'all' || repository.private === (visibility === 'private')) && (ownership === 'all' || repository.fullName.split('/')[0]?.toLowerCase() === user.login.toLowerCase())).sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  async function signedOut(notice?: string) {
    onSessionEnd(notice);
    clearOtherCreationIntents();
    await client.cancelQueries();
    client.setQueryData(['session'], null);
    forgetPrivateQueries(client);
  }
  const logout = useMutation({
    mutationFn: () => sessionClient.logout({}),
    onSuccess: () => signedOut(),
  });
  const accountPage = ['account-agents', 'account-security', 'settings', 'sessions', 'ssh-keys', 'api-credentials', 'audit'].includes(location.kind);
  const page = (location.kind === 'status' || (location.kind === 'home' && hash === 'capabilities') ? <Suspense fallback={<p role="status">Loading capabilities…</p>}><Capabilities isInstanceAdmin={user.isInstanceAdmin} /></Suspense> : location.kind === 'organization-team-settings' ? <Suspense fallback={<p role="status">Opening team settings…</p>}><OrganizationTeamSettings key={`${user.id}/${location.organization}/${location.teamId}`} userId={user.id} organization={location.organization} teamId={location.teamId} signingOut={logout.isPending} /></Suspense> : location.kind === 'repository-runners' ? <Suspense fallback={<p role="status">Opening repository runners…</p>}><RepositoryRunnerSettings key={`${user.id}/${location.owner}/${location.name}`} userId={user.id} owner={location.owner} name={location.name} signingOut={logout.isPending} /></Suspense> : location.kind === 'repository-rules' ? <Suspense fallback={<p role="status">Opening repository rules…</p>}><RepositoryRulesSettings key={`${user.id}/${location.owner}/${location.name}`} userId={user.id} owner={location.owner} name={location.name} signingOut={logout.isPending} /></Suspense> : location.kind === 'repository-secrets' ? <RepositorySettingsLayout owner={location.owner} name={location.name}><section className="page-stack"><header className="repository-intro"><div><h1>Secrets and variables</h1><p>Versioned repository values and exact workflow source approvals.</p></div></header><Suspense fallback={<p role="status">Opening execution values…</p>}><RepositoryExecutionValues client={repositoryExecutionValueClient} key={`${user.id}/${location.owner}/${location.name}`} userId={user.id} owner={location.owner} name={location.name} signingOut={logout.isPending}/></Suspense></section></RepositorySettingsLayout> : location.kind === 'repository-webhooks' ? <Suspense fallback={<p role="status">Opening webhooks…</p>}><RepositoryWebhooks key={`${user.id}/${location.owner}/${location.name}`} userId={user.id} owner={location.owner} name={location.name} signingOut={logout.isPending}/></Suspense> : location.kind === 'repository-access-settings' ? <Suspense fallback={<p role="status">Opening repository access…</p>}><RepositoryAccessSettings key={`${user.id}/${location.owner}/${location.name}`} userId={user.id} owner={location.owner} name={location.name} signingOut={logout.isPending} /></Suspense> : location.kind === 'repository-workflows' ? <Suspense fallback={<p role="status">Opening workflows…</p>}><WorkflowConfigurations key={`${user.id}/${location.owner}/${location.name}`} userId={user.id} owner={location.owner} name={location.name} signingOut={logout.isPending} /></Suspense> : location.kind === 'repository-settings' ? <Suspense fallback={<p role="status">Opening repository settings…</p>}><RepositorySettings key={`${user.id}/${location.owner}/${location.name}`} userId={user.id} owner={location.owner} name={location.name} signingOut={logout.isPending} /></Suspense> : location.kind === 'organization-settings' ? <ScopedSettings userId={user.id} signingOut={logout.isPending} scope="organization" name={location.organization} /> : location.kind === 'instance-settings' ? user.isInstanceAdmin ? <Suspense fallback={<p role="status">Opening instance settings…</p>}><InstanceSettings key={`${user.id}/${location.view ?? 'accounts'}`} view={location.view} userId={user.id} signingOut={logout.isPending} /></Suspense> : <section><h1>Instance settings unavailable</h1><p>This page requires an enrolled Golf instance administrator.</p></section> : location.kind === 'account-invitations' ? <AccountLayout><section className="page-stack"><header className="repository-intro"><div><h1>Invitations</h1><p>Review repository access offered to your account.</p></div></header><Suspense fallback={<p role="status">Opening invitations…</p>}><RepositoryInvitationInbox key={user.id} userId={user.id} signingOut={logout.isPending}/></Suspense></section></AccountLayout> : location.kind === 'account-agents' ? <Suspense fallback={<p role="status">Opening coding agent connections…</p>}><CodexConnections key={user.id} userId={user.id} signingOut={logout.isPending} /></Suspense> : location.kind === 'account-security' ? <Suspense fallback={<p role="status">Opening account security…</p>}><AccountSecurity key={user.id} userId={user.id} signingOut={logout.isPending} onSignedOut={signedOut} /></Suspense> : location.kind === 'settings' ? <AccountSettings key={user.id} user={user} signingOut={logout.isPending} /> : location.kind === 'sessions' ? <Suspense fallback={<p role="status">Opening sessions…</p>}><SessionManager userId={user.id} onSignedOut={signedOut} /></Suspense> : location.kind === 'ssh-keys' ? <Suspense fallback={<p role="status">Opening SSH keys…</p>}><SSHKeys key={user.id} userId={user.id} signingOut={logout.isPending} /></Suspense> : location.kind === 'api-credentials' ? <Suspense fallback={<div className="browser-loading" role="status"><LoaderCircle size={20} className="spin" />Opening API credentials…</div>}><ApiCredentials userId={user.id} signingOut={logout.isPending} /></Suspense> : location.kind === 'audit' ? <Suspense fallback={<div className="browser-loading" role="status"><LoaderCircle size={20} className="spin" />Opening account activity…</div>}><AccountActivity userId={user.id} /></Suspense> : location.kind === 'organizations' ? <Suspense fallback={<div className="browser-loading" role="status"><LoaderCircle size={20} className="spin" />Opening organizations…</div>}><OrganizationBrowser location={location} userId={user.id} /></Suspense> : location.kind === 'repository' ? <Suspense fallback={<div className="browser-loading" role="status"><LoaderCircle size={20} className="spin" />Opening repository…</div>}>{logout.isPending?<p role="status">Signing out…</p>:<RepositoryBrowser key={`${location.owner}/${location.name}`} location={location} userId={user.id} />}</Suspense> : location.kind === 'missing' ? <section className="empty-state"><h1>Page not found</h1><p>This Golf link does not match an available page.</p><Link className="button secondary" to="/">Back to repositories</Link></section> : <><section className="workspace-intro"><div><span className="eyebrow">YOUR NEXT COMMIT STARTS HERE</span><h1>Good to see you, {user.fullName || user.login}<span className="accent">.</span></h1><p>A little less friction. A little more building.</p></div><div className="intro-emblem" aria-hidden="true"><Command size={31} /></div></section>
        <section className="repository-section" id="repositories" aria-labelledby="repositories-title"><div className="section-heading"><div className="title-count"><h2 id="repositories-title">Repositories</h2>{repositoryQuery.isSuccess ? <span className="count-badge">{repositories.length}{repositoryQuery.hasNextPage ? '+' : ''}</span> : null}</div><button className="button primary" onClick={() => setCreating(true)}><Plus size={16} />{pending ? 'Resume repository creation' : 'New repository'}</button></div>
          <p className="section-description">Repositories you own or can access. Open a repository to browse its source, commits and issues in Golf.</p>
          <div className="repository-toolbar"><div className="search-input"><Search size={17} /><input aria-label="Search loaded repositories" placeholder="Search repositories…" value={search} onChange={(event) => setSearch(event.target.value)} /></div><select aria-label="Repository ownership" value={ownership} onChange={(event) => setOwnership(event.target.value)}><option value="all">All accessible</option><option value="owned">Owned by you</option></select><select aria-label="Repository visibility" value={visibility} onChange={(event) => setVisibility(event.target.value)}><option value="all">All visibility</option><option value="private">Private</option><option value="public">Public</option></select><button className="icon-button refresh" aria-label="Refresh repositories" disabled={repositoryQuery.isFetching} onClick={() => void repositoryQuery.refetch()}><RefreshCw size={17} className={repositoryQuery.isFetching ? 'spin' : ''} /></button></div>
          <ErrorMessage error={repositoryQuery.error} />
          <div className="repository-list" aria-busy={repositoryQuery.isFetching}>
            {repositoryQuery.isError ? null : repositoryQuery.isPending || (repositoryQuery.isFetching && !repositoryQuery.isFetchingNextPage) ? <div className="empty-state" role="status"><LoaderCircle className="spin" size={24} /><h3>Finding your repositories…</h3></div> : filtered.length ? filtered.map((repository) => <RepositoryRow repository={repository} key={repository.id} />) : repositoryQuery.isSuccess ? <div className="empty-state"><BookOpen size={29} /><h3>{repositories.length ? 'No matching repositories' : 'A clean slate. A new beginning.'}</h3><p>{repositories.length ? 'Try a different search, ownership or visibility filter.' : 'Create your first repository to start building.'}</p>{!repositories.length ? <button className="button secondary" onClick={() => setCreating(true)}><Plus size={15} />{pending ? 'Resume pending request' : 'Create a repository'}</button> : null}</div> : null}
          </div>
          {repositoryQuery.isSuccess ? <div className="list-footer"><span role="status">{filtered.length} of {repositories.length} loaded repositories{repositoryQuery.hasNextPage ? ' · Search applies to loaded results' : ''}</span>{repositoryQuery.hasNextPage ? <button className="text-button" disabled={repositoryQuery.isFetchingNextPage} onClick={() => void repositoryQuery.fetchNextPage()}>{repositoryQuery.isFetchingNextPage ? 'Loading…' : 'Load more'}<ArrowDown size={14} /></button> : <span>Sorted by last update</span>}</div> : null}
        </section></>);
  return <div className="app-shell">
    <div className="workspace-content"><header className="topbar"><div className="workspace-heading"><Brand /><WorkspaceSwitcher userId={user.id} login={user.login} currentOrganization={location.kind === 'organizations' || location.kind === 'organization-settings' || location.kind === 'organization-team-settings' ? location.organization : undefined} signingOut={logout.isPending} /><nav className="workspace-navigation" aria-label="Workspace"><Link to="/" activeOptions={{ exact: true }}>Repositories</Link><Link to="/organizations">Organizations</Link></nav></div><div className="topbar-controls"><ThemeSwitch /><details ref={accountMenu} className="account-menu" onKeyDown={(event) => { if (event.key === 'Escape') { closeAccountMenu(); accountMenu.current?.querySelector('summary')?.focus(); } }} onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) closeAccountMenu(); }}><summary aria-label="Your account" title="Your account"><UserRound size={18} aria-hidden="true" /></summary><div className="account-dropdown"><div className="account-label"><strong>{user.login}</strong><span>{user.isInstanceAdmin ? 'Instance administrator' : 'Personal workspace'}</span></div><Link to="/status" onClick={closeAccountMenu}><Layers2 size={17} />System status</Link><Link to="/account/settings" onClick={closeAccountMenu}><Settings size={17} />User settings</Link>{user.isInstanceAdmin ? <Link to="/admin" onClick={closeAccountMenu}><Settings size={17} />Admin portal</Link> : null}<button type="button" disabled={logout.isPending} onClick={() => { closeAccountMenu(); logout.mutate(); }}><LogOut size={17} />Sign out</button></div></details></div></header><div className="logout-error"><ErrorMessage error={logout.error} /></div>
      <main id="main-content"><Breadcrumbs location={location}/>{accountPage ? <AccountLayout>{page}</AccountLayout> : page}<footer className="workspace-footer"><span>Made for the work ahead.</span><span>golf<span className="accent">.</span></span></footer>
      </main>
    </div>{creating ? <CreateRepository userId={user.id} initial={pending} onPendingChange={setPending} onClose={() => setCreating(false)} /> : null}
  </div>;
}

export function App({ location }: { location: Location }) {
  const [loginNotice, setLoginNotice] = useState<string>();
  const client = useQueryClient();
  const session = useQuery({ queryKey: ['session'], queryFn: async ({ signal }) => {
    try { const response = await sessionClient.getSession({}, { signal }); if (!response.user) throw new ConnectError('The session response is missing its user.', Code.Internal); return response.user; }
    catch (error) { if (error instanceof ConnectError && error.code === Code.Unauthenticated) { forgetPrivateQueries(client); return null; } throw error; }
  } });
  useEffect(() => { if (session.isSuccess) { clearOtherCreationIntents(session.data?.id); if (session.data) setLoginNotice(undefined); } }, [session.isSuccess, session.data?.id]);
  return <><a className="skip-link" href="#main-content">Skip to content</a>{session.isPending ? <main className="loading-screen" id="main-content"><Brand /><p role="status"><LoaderCircle size={18} className="spin" />Opening your workspace…</p></main> : session.error ? <main className="loading-screen" id="main-content"><Brand /><ErrorMessage error={session.error} /><button className="button secondary" onClick={() => void session.refetch()}>Try again</button></main> : session.data ? <Workspace key={session.data.id} user={session.data} location={location} onSessionEnd={setLoginNotice} /> : <Login oauthFailed={location.kind === 'home' && Boolean(location.oauthFailed)} notice={loginNotice} />}</>;
}
