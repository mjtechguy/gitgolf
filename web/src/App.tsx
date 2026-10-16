import { RepositoryVisibility } from './RepositoryUI';
import { NativePreviewResume } from './NativeForge';
import { ThemeSwitch, useAppearance } from './ThemeSwitch';
import { headingSlot, KeyboardLayer, navigationSlot, RailTooltip, SummaryBand, tabsSlot, toolsSlot } from './Layout';
import { JumpTo } from './JumpTo';
import { NotFoundScreen, OfflineScreen, unreachable } from './ErrorScreens';
import { isRunID } from './navigation';
import {clearOtherReviewRequestIntents} from './reviewRequestIntents';

import {PublicRepositoryImport} from './PublicRepositoryImport';
import { clearOtherDeploymentIntents } from './deploymentIntents';
import { clearOtherReleasePublicationIntents } from './releasePublicationIntents';
import { clearOtherRefMutationIntents } from './refMutationIntents';
import { clearOtherFileMutationIntents } from './fileMutationIntents';
import { clearOtherDiscussionResourceIntents } from './discussionResourceIntents';
import { clearOtherWorkflowDispatchIntents } from './workflowDispatchIntents';
import { clearOtherStandardMergeIntents } from './standardMergeIntents';
import { clearOtherAccessIntents } from './accessIntents';
import { clearOtherRuleIntents } from './ruleIntents';
import { Breadcrumbs } from './Breadcrumbs';
import { useRuntimeCapabilities } from './useRuntimeCapabilities';
import { runtimeFeature, settingAvailable, settingForRoute, emailNotificationsMounted } from './runtimeCapabilities';
import { useRepositoryFeatures, policyOff, deciderLabels } from './RepositoryFeatures';
import { useForm, useStore } from '@tanstack/react-form';
import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Bell, ArrowDown, ArrowRight, BookOpen, Check, CircleDot, Menu, ExternalLink, GitBranch, KeyRound, Layers2, LoaderCircle, LockKeyhole, LogOut, Plus, RefreshCw, Search, Settings, ShieldCheck, UserRound, X } from 'lucide-react';
import { Code, ConnectError } from '@connectrpc/connect';
import { Link, useLocation } from '@tanstack/react-router';
import { create } from '@bufbuild/protobuf';
import { repositoryExecutionValueClient, errorMessage, repositoryClient, repositoryLink, sessionClient } from './api';
import { CreateRepositoryRequestSchema, RepositoryCreationState } from './gen/golf/v1/golf_pb';
import type { CreateRepositoryRequest, Repository, RepositoryCreation, User } from './gen/golf/v1/golf_pb';
import { defaultRepositorySearch, repositoryOptions } from './navigation';
import type { Location } from './navigation';
import { forgetPrivateQueries } from './queryClient';
import { AccountLayout, AccountSettings, OrganizationSettingsLayout, ScopedSettings } from './AccountSettings';
import { WorkspaceSwitcher } from './WorkspaceSwitcher';
const Capabilities = lazy(() => import('./Capabilities').then(module => ({ default: module.Capabilities })));
import { clearOtherIssueIntents } from './issueIntents';
import { clearOtherReviewIntents } from './reviewIntents';

const ProviderConnections086=lazy(()=>import('./ProviderConnections086').then(m=>({default:m.ProviderConnections086})));
const ConnectedRepositoryImport086=lazy(()=>import('./ConnectedRepositoryImport086').then(m=>({default:m.ConnectedRepositoryImport086})));
const OrganizationLabels = lazy(() => import('./OrganizationLabels').then(module=>({default:module.OrganizationLabels})));
const RepositorySearch = lazy(() => import('./RepositorySearch').then(module => ({ default: module.RepositorySearch })));
const ForgeNotificationInbox=lazy(()=>import('./ForgeNotificationInbox').then(m=>({default:m.ForgeNotificationInbox})));
const CodexConnections = lazy(() => import('./CodexConnections').then(module => ({ default: module.CodexConnections })));
const AgentHostSettings = lazy(() => import('./AgentHostSettings').then(module => ({ default: module.AgentHostSettings })));
const AccountSecurity = lazy(() => import('./AccountSecurity').then(module => ({ default: module.AccountSecurity })));
const InstanceSettings = lazy(() => import('./InstanceSettings').then((module) => ({ default: module.InstanceSettings })));
const OrganizationExecutionSettings = lazy(() => import('./OrganizationExecutionSettings').then(module => ({ default: module.OrganizationExecutionSettings })));
const OrganizationTeamSettings = lazy(() => import('./OrganizationTeamSettings').then((module) => ({ default: module.OrganizationTeamSettings })));
const RepositoryInvitationInbox = lazy(() => import('./RepositoryInvitationInbox').then(module => ({default:module.RepositoryInvitationInbox})));
const RepositoryGitSettings = lazy(() => import('./RepositoryGitSettings').then(module => ({ default: module.RepositoryGitSettings })));
const RepositoryDeletionSettings = lazy(() => import('./RepositoryDeletionSettings').then(module => ({ default: module.RepositoryDeletionSettings })));
const RepositoryEnvironmentSettings = lazy(() => import('./RepositoryEnvironmentSettings').then(module => ({ default: module.RepositoryEnvironmentSettings })));
const RepositoryRulesSettings = lazy(() => import('./RepositoryRulesSettings').then(module => ({ default: module.RepositoryRulesSettings })));
const RepositoryRunnerSettings = lazy(() => import('./RepositoryRunnerSettings').then(module => ({ default: module.RepositoryRunnerSettings })));
const NativeRepositoryRunners = lazy(() => import('./NativeRunners').then(module => ({ default: module.NativeRepositoryRunners })));
const RepositoryExecutionValues = lazy(() => import('./RepositoryExecutionValues').then(module => ({default:module.RepositoryExecutionValues})));
const AuditLog = lazy(() => import('./AuditLog').then(module => ({ default: module.AuditLog })));
const AgenticModeSettings = lazy(() => import('./AgenticModeSettings').then(module => ({ default: module.AgenticModeSettings })));
const RepositoryAutomations = lazy(() => import('./AutomationSettings').then(module => ({ default: module.RepositoryAutomations })));
const AutomationSettings = lazy(() => import('./AutomationSettings').then(module => ({ default: module.AutomationSettings })));
const RepositoryWebhooks = lazy(() => import('./RepositoryWebhooks').then(module => ({default:module.RepositoryWebhooks})));
const RepositoryAccessSettings = lazy(() => import('./RepositoryAccessSettings').then((module) => ({ default: module.RepositoryAccessSettings })));
const WorkflowConfigurations = lazy(() => import('./WorkflowConfigurations').then((module) => ({ default: module.WorkflowConfigurations })));
const RepositorySettings = lazy(() => import('./RepositorySettings').then((module) => ({ default: module.RepositorySettings })));
const RepositoryBrowser = lazy(() => import('./RepositoryBrowser').then((module) => ({ default: module.RepositoryBrowser })));
const OrganizationBrowser = lazy(() => import('./OrganizationBrowser').then((module) => ({ default: module.OrganizationBrowser })));
const SSHKeys = lazy(() => import('./SSHKeys').then((module) => ({ default: module.SSHKeys })));
const ApiTokenSettings = lazy(() => import('./ApiTokenSettings').then(module => ({ default: module.ApiTokenSettings })));
const CredentialSettings = lazy(() => import('./CredentialSettings').then(module => ({ default: module.CredentialSettings })));
const EngineSettings = lazy(() => import('./EngineSettings').then(module => ({ default: module.EngineSettings })));
const ApiCredentials = lazy(() => import('./ApiCredentials').then((module) => ({ default: module.ApiCredentials })));
const AccountActivity = lazy(() => import('./AccountActivity').then((module) => ({ default: module.AccountActivity })));
const SessionManager = lazy(() => import('./SessionManager').then((module) => ({ default: module.SessionManager })));

const PublicOwnerProfile = lazy(() => import('./PublicProfiles').then(m => ({ default: m.PublicOwnerProfile })));
const PublicDiscovery = lazy(() => import('./PublicProfiles').then(m => ({ default: m.PublicDiscovery })));

function Brand() {
  return <Link className="brand" to="/" aria-label="Golf home"><span className="brand-mark" aria-hidden="true">g</span><span>golf<span className="brand-dot">.</span></span></Link>;
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

const PasswordRecovery90 = lazy(() => import('./PasswordRecovery90').then(m => ({default:m.PasswordRecovery90})));

function Login({ oauthFailed, notice }: { oauthFailed: boolean; notice?: string }) {
  const client = useQueryClient();
  const [recovering,setRecovering] = useState(false);
  const loginForm = useForm({ defaultValues: { username: '', password: '', mfaCode: '' }, onSubmit: async () => { await submitPassword(); } });
  const { username, password, mfaCode } = useStore(loginForm.store, (state) => state.values);
  const setUsername = (value: string) => loginForm.setFieldValue('username', value);
  const setPassword = (value: string) => loginForm.setFieldValue('password', value);
  const [mfaChallenge, setMfaChallenge] = useState<string | null>(null);
  const [passwordPending, setPasswordPending] = useState(false);
  const [passwordError, setPasswordError] = useState<Error | null>(null);
  const passwordAttempt = useRef<AbortController | null>(null);
  useEffect(() => {
    const clear = () => { setPassword(''); loginForm.setFieldValue('mfaCode',''); setMfaChallenge(null); passwordAttempt.current?.abort(); };
    window.addEventListener('pagehide', clear);
    return () => { window.removeEventListener('pagehide', clear); passwordAttempt.current?.abort(); };
  }, []);
  const options = useQuery({
    queryKey: ['authentication-options'], staleTime: 0, gcTime: 0,
    queryFn: ({ signal }) => sessionClient.getAuthenticationOptions({}, { signal, timeoutMs: 8_000 }),
  });
  const passwordAvailable = options.isSuccess && !options.isFetching && options.data.localPasswordEnabled;
  const oauthAvailable = options.isSuccess && !options.isFetching && options.data.forgeOauthEnabled;
  const accessAvailable = document.documentElement.dataset.golfRuntime === 'cloudflare-native' || options.isSuccess && !options.isFetching && options.data.providerLabel === 'Cloudflare Access' && !options.data.localPasswordEnabled && !options.data.forgeOauthEnabled;
  async function signedIn() {
    setPassword(''); loginForm.setFieldValue('mfaCode',''); setMfaChallenge(null);
    forgetPrivateQueries(client);
    await client.invalidateQueries({ queryKey: ['session'] });
  }
  const oauth = useMutation({
    gcTime: 0,
    mutationFn: async () => {
      const result = await sessionClient.beginForgeOAuth({}, { timeoutMs: 8_000 });
      const destination = repositoryLink(result.authorizationUrl);
      if (!destination) throw new ConnectError('Golf received an invalid sign-in address. Try again or sign in with your Golf account.', Code.Internal);
      return destination;
    },
    onSuccess: (destination) => { window.location.assign(destination); },
  });
  const redirecting = oauth.isPending || oauth.isSuccess;
  const busy = passwordPending || redirecting;
  async function submitPassword() {
    if (!passwordAvailable || busy || passwordAttempt.current || (mfaChallenge ? !mfaCode.trim() : !username.trim() || !password)) return;
    // Keep the credential out of mutation/query caches and clear the input before waiting.
    const request = { username: username.trim(), password }; const factor=mfaCode.trim(); loginForm.setFieldValue('mfaCode','');
    const controller = new AbortController();
    passwordAttempt.current = controller;
    setPassword(''); setPasswordError(null); setPasswordPending(true);
    try {
      const response=mfaChallenge?await sessionClient.completePasswordMFA({code:factor},{signal:controller.signal,timeoutMs:15000}):await sessionClient.loginWithPassword(request, { signal: controller.signal, timeoutMs: 15_000 });
      if(response.mfaRequired){if(response.user||!response.challengeExpiresAt||!Number.isFinite(Date.parse(response.challengeExpiresAt)))throw new ConnectError('Invalid authentication challenge.',Code.Internal);setMfaChallenge(response.challengeExpiresAt);}else{if(!response.user)throw new ConnectError('Sign-in could not be confirmed.',Code.Internal);await signedIn();}
    } catch (error) {
      if (!controller.signal.aborted) setPasswordError(new Error(error instanceof ConnectError && error.code === Code.ResourceExhausted ? 'Too many sign-in attempts. Wait a few minutes and try again.' : error instanceof ConnectError && error.code === Code.Unavailable ? 'Sign-in is temporarily unavailable. Try again later.' : mfaChallenge?'The authentication code was not accepted. Use a fresh authenticator code or unused recovery code. If the challenge expired, start sign-in again.':'Sign-in could not be completed. Check your Golf email or username and password and try again.'));
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
        {recovering?<Suspense fallback={<p role="status">Opening password recovery…</p>}><PasswordRecovery90 onClose={()=>setRecovering(false)}/></Suspense>:<>
        <span className="small-icon"><KeyRound size={21} /></span>
        <h2 id="login-title">Welcome to Golf</h2>
        <p>{accessAvailable ? 'Continue through Cloudflare Access with your enrolled Golf identity.' : 'Sign in with your Golf account.'}</p>
        {notice ? <p className="session-notice" role="status">{notice}</p> : null}
        {oauthFailed ? <p className="error" role="alert">Provider sign-in could not be completed. Please try again or sign in with your Golf account.</p> : null}
        {options.isPending || options.isFetching ? <p className="auth-options-status" role="status"><LoaderCircle className="spin" size={14} />Checking sign-in options…</p> : options.isError ? <div className="auth-options-error"><p className="error" role="alert">Sign-in options could not be loaded. Retry or contact your installation administrator.</p><button className="text-button" onClick={() => void options.refetch()}>Retry sign-in options</button><button className="button secondary" onClick={() => document.documentElement.dataset.golfPublic === 'true' ? window.location.assign('/auth/login?returnTo='+encodeURIComponent(window.location.pathname+window.location.search)) : window.location.reload()}>Reload to sign in</button></div> : !passwordAvailable && !accessAvailable ? <p className="auth-options-status">Golf password sign-in is not enabled for this installation. {oauthAvailable ? 'Use the connected provider below.' : 'Contact your installation administrator to enable sign-in.'}</p> : null}
        {accessAvailable ? <button className="button primary full" onClick={() => document.documentElement.dataset.golfPublic === 'true' ? window.location.assign('/auth/login?returnTo='+encodeURIComponent(window.location.pathname+window.location.search)) : window.location.reload()}><ArrowRight size={17} />Continue with Cloudflare Access</button> : <form onSubmit={(event) => { event.preventDefault(); void loginForm.handleSubmit(); }} aria-label="Golf account sign-in">
          {mfaChallenge?<><label htmlFor="golf-mfa-code">Authenticator or recovery code</label><input id="golf-mfa-code" autoComplete="one-time-code" autoCapitalize="none" spellCheck={false} required maxLength={27} value={mfaCode} disabled={busy} onChange={event=>loginForm.setFieldValue('mfaCode',event.target.value)}/><p className="field-help">Enter a fresh six-digit authenticator code or one unused recovery code.</p><button type="button" className="text-button" disabled={busy} onClick={()=>{setMfaChallenge(null);loginForm.reset();setPasswordError(null);}}>Start sign-in again</button></>:<><label htmlFor="golf-username">Email or username</label>
          <input id="golf-username" name="username" autoComplete="username" autoCapitalize="none" spellCheck={false} required value={username} onChange={(event) => setUsername(event.target.value)} disabled={!passwordAvailable || busy} />
          <label htmlFor="golf-password">Password</label>
          <input id="golf-password" name="password" type="password" autoComplete="current-password" required value={password} onChange={(event) => setPassword(event.target.value)} aria-describedby="password-help" disabled={!passwordAvailable || busy} />
          <p className="field-help" id="password-help">Use the Golf account enrolled by your installation operator.</p>
          </>}<ErrorMessage error={passwordError} />
          <button className="button primary full" disabled={!passwordAvailable || (mfaChallenge?!mfaCode.trim():!username.trim()||!password) || busy}>{passwordPending ? <LoaderCircle size={17} className="spin" /> : <ArrowRight size={17} />}{passwordPending ? 'Signing in…' : mfaChallenge ? 'Verify and sign in' : 'Sign in'}</button>
        </form>}
        {passwordAvailable&&!mfaChallenge?<button className="text-button" disabled={busy} onClick={()=>{setPassword('');setPasswordError(null);setRecovering(true)}}>Forgot your password?</button>:null}
        {oauthAvailable&&!mfaChallenge ? <section className="oauth-section" aria-label="Provider sign-in">
          <p className="oauth-provider">Continue through your connected provider. Your provider password stays with it.</p>
          <div className="oauth-permissions" id="oauth-permissions"><h3>Requested permissions</h3><p>Golf requests these scopes within your existing account access.</p>{options.data.scopes.length ? <ul>{options.data.scopes.map((scope) => <li key={scope}><code>{scope}</code>{scopeLabels[scope] ? <span>{scopeLabels[scope]}</span> : null}</li>)}</ul> : <p>No additional scopes were listed by this installation.</p>}</div>
          <ErrorMessage error={oauth.error} />
          <button className="button secondary full" disabled={busy} aria-describedby="oauth-permissions" onClick={() => { if (passwordAttempt.current) return; setPassword(''); setPasswordError(null); oauth.mutate(); }}>{redirecting ? <LoaderCircle className="spin" size={17} /> : <GitBranch size={17} />}{redirecting ? 'Continuing to provider…' : 'Continue with provider'}{!redirecting ? <ArrowRight size={17} /> : null}</button>
        </section> : null}
        <div className="login-note"><LockKeyhole size={15} /><span>Golf stores provider credentials on the server. They are never saved in browser storage.</span></div>
        </>}
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

function CreateRepository({ userId, initial, onPendingChange, onClose, privateOnly = false }: { privateOnly?: boolean; userId: string; initial: PendingCreation | null; onPendingChange: (value: PendingCreation | null) => void; onClose: () => void }) {
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
      <label className="visibility-choice"><input type="checkbox" checked={isPrivate} onChange={(event) => setPrivate(event.target.checked)} disabled={Boolean(intent) || privateOnly} /><LockKeyhole size={18} /><span><strong>Private repository</strong><small>{isPrivate ? 'Only you and people you authorize can access it.' : 'Public: code will be visible to everyone with access to your forge.'}</small></span></label>
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
    <div className="repository-detail"><div className="repository-heading"><h3>{internal ? <Link {...internal}>{repository.fullName || repository.name}</Link> : repository.fullName || repository.name}</h3><RepositoryVisibility isPrivate={repository.private} /></div>
      <p>{repository.description || 'No description yet.'}</p>
      <div className="repository-meta"><span><GitBranch size={13} />{repository.defaultBranch || 'No default branch'}</span>{!Number.isNaN(updated.getTime()) ? <time dateTime={repository.updatedAt} title={updated.toLocaleString()}>Updated {updated.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}</time> : <span>Update time unavailable</span>}</div>
    </div>
    {link ? <a className="open-repository" href={link} target="_blank" rel="noopener noreferrer" aria-label={`Open ${repository.fullName || repository.name} in the repository interface`}><ExternalLink size={16} /></a> : null}
  </article>;
}


function Workspace({ user, location, onSessionEnd }: { user: User; location: Location; onSessionEnd: (notice?: string,recoveryCodes?:string[]) => void }) {
  const runtime = useRuntimeCapabilities();
  const requiredSetting = settingForRoute(location.kind, location.kind === 'instance-settings' ? location.view : undefined, runtime.data?.runtimeProfile === 'cloudflare-native');
  const native = runtime.data?.runtimeProfile === 'cloudflare-native';
  const appearance = useAppearance();
  const manifest = runtime.isError ? undefined : runtime.data;
  // Repository runners are portable pools, or on the native runtime the workspace's own runner pools.
  const repositorySetting = location.kind === 'repository-runners' ? native ? 'settings.native-runners' : 'settings.runners' : settingForRoute(location.kind, undefined, true);
  const repositorySettingsPage = location.kind.startsWith('repository-') && repositorySetting;
  // Own repository email shares the Webhooks page, so on the native runtime either capability opens it.
  const emailPage = native && location.kind === 'repository-webhooks' && emailNotificationsMounted(manifest);
  // A repository settings page whose feature a policy turned off names the deciding level instead of opening.
  const settingsFeature = ({ 'repository-runners': 'actions', 'repository-secrets': 'secrets', 'repository-environments': 'previews', 'repository-webhooks': 'webhooks', 'repository-agentic-mode': 'agentic-mode' } as Record<string, string>)[location.kind];
  const repositoryFeatures = useRepositoryFeatures(user.id, 'owner' in location ? location.owner : '', 'name' in location ? location.name : '', native && Boolean(settingsFeature)).data?.features;
  const policyBlocked = settingsFeature && !(settingsFeature === 'webhooks' && emailPage && !policyOff(repositoryFeatures, 'email')) ? policyOff(repositoryFeatures, settingsFeature) : undefined;
  const runtimeBlocked = !policyBlocked && !emailPage && (repositorySettingsPage ? !runtimeFeature(manifest, repositorySetting) || (repositorySetting === 'settings.runners' || repositorySetting === 'settings.installation-audit' || repositorySetting === 'repository.agentic-mode' || repositorySetting === 'automations') && !settingAvailable(manifest, repositorySetting) : requiredSetting && !settingAvailable(manifest, requiredSetting));
  const unavailableSetting = manifest?.capabilities.find(item => item.id === (repositorySettingsPage ? repositorySetting : requiredSetting));
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
    queryFn: ({ pageParam, signal }) => repositoryClient.listRepositories({ page: { page: pageParam }, metadataOnly: true }, { signal }),
    getNextPageParam: (lastPage) => lastPage.page?.nextPage || undefined,
  });
  const repositories = repositoryQuery.isSuccess && (!repositoryQuery.isFetching || repositoryQuery.isFetchingNextPage) ? [...new Map(repositoryQuery.data.pages.flatMap((page) => page.repositories).map((repository) => [repository.id, repository])).values()] : [];
  const filtered = repositories.filter((repository) => `${repository.fullName} ${repository.description}`.toLowerCase().includes(search.toLowerCase().trim()) && (visibility === 'all' || repository.private === (visibility === 'private')) && (ownership === 'all' || repository.fullName.split('/')[0]?.toLowerCase() === user.login.toLowerCase())).sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  async function signedOut(notice?: string,recoveryCodes?:string[]) {
    onSessionEnd(notice,recoveryCodes);
    clearOtherCreationIntents();
    clearOtherAccessIntents();
    clearOtherRuleIntents();
    clearOtherWorkflowDispatchIntents(); clearOtherStandardMergeIntents(); clearOtherReleasePublicationIntents(); clearOtherRefMutationIntents(); clearOtherFileMutationIntents(); clearOtherDiscussionResourceIntents(); clearOtherReviewRequestIntents(); clearOtherDeploymentIntents();
    await client.cancelQueries();
    client.setQueryData(['session'], null);
    forgetPrivateQueries(client);
  }
  // Pages take signingOut={logout.isPending} and hide private data at once. The repository browser has no such prop: it
  // unmounts while sign-out is pending, which aborts its in-flight work (editors, reviews) so a late reply is ignored.
  const logout = useMutation({
    mutationFn: async () => { if (native) { window.location.assign('/cdn-cgi/access/logout'); return; } return sessionClient.logout({}); },
    onSuccess: () => signedOut(),
  });
  const repositoryLocation = 'owner' in location && 'name' in location ? location.kind === 'repository' ? location : { ...defaultRepositorySearch, kind: 'repository' as const, owner: location.owner, name: location.name } : undefined;
  const globalMenu = useRef<HTMLDetailsElement>(null);
  useEffect(() => { if (globalMenu.current) globalMenu.current.open = false; }, [location]);
  const accountPage = ['account-connections','account-agents', 'account-security', 'settings', 'sessions', 'ssh-keys', 'api-credentials', 'account-api-tokens', 'account-credentials', 'audit'].includes(location.kind);
  const page = (native && location.kind === 'public-profile' ? <Suspense fallback={<p role="status">Opening profile…</p>}><PublicOwnerProfile key={location.owner} owner={location.owner} userId={user.id} /></Suspense> : native && location.kind === 'explore' ? <Suspense fallback={<p role="status">Opening discovery…</p>}><PublicDiscovery key={JSON.stringify([location.query,location.topic])} initialQuery={location.query} initialTopic={location.topic} /></Suspense> : runtimeBlocked ? <section className="page-stack feature-unavailable" aria-labelledby="settings-unavailable-title"><header className="repository-intro"><div><h1 id="settings-unavailable-title">{runtime.isPending ? 'Checking settings availability…' : unavailableSetting?.label || 'Not available here'}</h1>{runtime.isPending || runtime.isError ? null : <p className="feature-unavailable-state">Not available on this installation</p>}<p>{runtime.isPending ? 'Checking installation capabilities…' : runtime.isError ? 'Settings availability could not be checked. Retry to load the current installation capabilities.' : unavailableSetting?.reason || 'This installation does not provide this page. Nothing here is hidden from your account; the service behind it has not been set up.'}</p></div></header><ErrorMessage error={runtime.error}/><div className="credential-actions"><Link className="button secondary" to="/status">See what this installation provides</Link><button className="button secondary" disabled={runtime.isFetching} onClick={() => void runtime.refetch()}>Refresh availability</button></div></section> : policyBlocked ? <section className="page-stack feature-unavailable" aria-labelledby="settings-unavailable-title"><header className="repository-intro"><div><h1 id="settings-unavailable-title">{policyBlocked.label}</h1><p className="feature-unavailable-state">Turned off · {deciderLabels[policyBlocked.decidedBy]}</p><p>{policyBlocked.reason} Its settings and data are kept; turning it back on restores this page.</p></div></header>{'owner' in location && 'name' in location ? <div className="credential-actions"><Link className="button secondary" to="/$owner/$name/settings" params={{ owner: location.owner, name: location.name }}>See repository features</Link></div> : null}</section> : location.kind === 'status' || (location.kind === 'home' && hash === 'capabilities') ? <Suspense fallback={<p role="status">Loading capabilities…</p>}><Capabilities isInstanceAdmin={user.isInstanceAdmin} /></Suspense> : location.kind === 'organization-team-settings' ? <Suspense fallback={<p role="status">Opening team settings…</p>}><OrganizationTeamSettings key={`${user.id}/${location.organization}/${location.teamId}`} userId={user.id} organization={location.organization} teamId={location.teamId} signingOut={logout.isPending} /></Suspense> : location.kind === 'repository-git' ? <Suspense fallback={<p role="status">Opening Golf Git credentials…</p>}><RepositoryGitSettings key={`${user.id}/${location.owner}/${location.name}`} userId={user.id} owner={location.owner} name={location.name} signingOut={logout.isPending}/></Suspense> : location.kind === 'repository-deletion' ? <Suspense fallback={<p role="status">Opening repository deletion…</p>}><RepositoryDeletionSettings key={`${user.id}/${location.owner}/${location.name}/${location.repositoryId}`} userId={user.id} owner={location.owner} name={location.name} repositoryId={location.repositoryId} signingOut={logout.isPending} /></Suspense> : location.kind === 'repository-environments' ? <Suspense fallback={<p role="status">Opening repository environments…</p>}><RepositoryEnvironmentSettings key={`${user.id}/${location.owner}/${location.name}`} userId={user.id} owner={location.owner} name={location.name} signingOut={logout.isPending} /></Suspense> : location.kind === 'repository-runners' ? <Suspense fallback={<p role="status">Opening repository runners…</p>}>{native ? <NativeRepositoryRunners key={`${user.id}/${location.owner}/${location.name}`} userId={user.id} owner={location.owner} name={location.name} signingOut={logout.isPending} /> : <RepositoryRunnerSettings key={`${user.id}/${location.owner}/${location.name}`} userId={user.id} owner={location.owner} name={location.name} signingOut={logout.isPending} />}</Suspense> : location.kind === 'repository-rules' ? <Suspense fallback={<p role="status">Opening repository rules…</p>}><RepositoryRulesSettings key={`${user.id}/${location.owner}/${location.name}`} userId={user.id} owner={location.owner} name={location.name} signingOut={logout.isPending} /></Suspense> : location.kind === 'repository-secrets' ? <><section className="page-stack"><header className="repository-intro"><div><h1>Secrets and variables</h1><p>Versioned repository values and exact workflow source approvals.</p></div></header><Suspense fallback={<p role="status">Opening execution values…</p>}><RepositoryExecutionValues client={repositoryExecutionValueClient} key={`${user.id}/${location.owner}/${location.name}`} userId={user.id} owner={location.owner} name={location.name} signingOut={logout.isPending}/></Suspense></section></> : location.kind === 'repository-audit' ? <section className="page-stack"><header className="repository-intro"><div><h1>Audit log</h1><p>Privileged and state-changing actions on this repository: who acted, what changed, when, from where, and whether it succeeded. Repository administrators can read it.</p></div></header><Suspense fallback={<p role="status">Opening the audit log…</p>}><AuditLog key={`${user.id}/${location.owner}/${location.name}`} scope={{ kind: 'repository', owner: location.owner, name: location.name }} userId={user.id} signingOut={logout.isPending} /></Suspense></section> : location.kind === 'repository-automations' ? <Suspense fallback={<p role="status">Opening automations…</p>}><RepositoryAutomations key={`${user.id}/${location.owner}/${location.name}`} userId={user.id} owner={location.owner} name={location.name} /></Suspense> : location.kind === 'repository-agentic-mode' ? <Suspense fallback={<p role="status">Opening agentic mode…</p>}><AgenticModeSettings key={`${user.id}/${location.owner}/${location.name}`} userId={user.id} owner={location.owner} name={location.name} /></Suspense> : location.kind === 'repository-webhooks' ? <Suspense fallback={<p role="status">Opening webhooks…</p>}><RepositoryWebhooks key={`${user.id}/${location.owner}/${location.name}`} userId={user.id} owner={location.owner} name={location.name} signingOut={logout.isPending}/></Suspense> : location.kind === 'repository-access-settings' ? <Suspense fallback={<p role="status">Opening repository access…</p>}><RepositoryAccessSettings key={`${user.id}/${location.owner}/${location.name}`} userId={user.id} owner={location.owner} name={location.name} signingOut={logout.isPending} /></Suspense> : location.kind === 'repository-workflows' ? <Suspense fallback={<p role="status">Opening workflows…</p>}><WorkflowConfigurations key={`${user.id}/${location.owner}/${location.name}`} userId={user.id} owner={location.owner} name={location.name} signingOut={logout.isPending} /></Suspense> : location.kind === 'repository-settings' ? <Suspense fallback={<p role="status">Opening repository settings…</p>}><RepositorySettings key={`${user.id}/${location.owner}/${location.name}`} userId={user.id} owner={location.owner} name={location.name} signingOut={logout.isPending} /></Suspense> : location.kind === 'organization-labels' ? <OrganizationSettingsLayout organization={location.organization}><section className="page-stack"><header className="repository-intro"><div><h1>Organization labels</h1><p>Shared labels inherited by organization repositories.</p></div></header><Suspense fallback={<p role="status">Opening organization labels…</p>}><OrganizationLabels key={`${user.id}/${location.organization}`} userId={user.id} organization={location.organization} blocked={logout.isPending}/></Suspense></section></OrganizationSettingsLayout> : location.kind === 'organization-audit' ? <OrganizationSettingsLayout organization={location.organization}><section className="page-stack"><header className="repository-intro"><div><h1>Audit log</h1><p>Privileged and state-changing actions in this organization and its repositories: who acted, what changed, when, from where, and whether it succeeded. Organization owners can read it.</p></div></header><Suspense fallback={<p role="status">Opening the audit log…</p>}><AuditLog key={`${user.id}/${location.organization}`} scope={{ kind: 'organization', organization: location.organization }} userId={user.id} signingOut={logout.isPending} /></Suspense></section></OrganizationSettingsLayout> : location.kind === 'organization-credentials' ? <OrganizationSettingsLayout organization={location.organization}><section className="page-stack"><header className="repository-intro"><div><h1>Credentials</h1><p>API keys this organization’s owners add for its engines, sealed in Golf’s credential vault and shared explicitly.</p></div></header><Suspense fallback={<p role="status">Opening credentials…</p>}><CredentialSettings key={`${user.id}/${location.organization}`} target={{ scope: 'organization', organization: location.organization }} userId={user.id} /></Suspense></section></OrganizationSettingsLayout> : location.kind === 'organization-engines' ? <OrganizationSettingsLayout organization={location.organization}><section className="page-stack"><header className="repository-intro"><div><h1>Engines</h1><p>The engine each AI use case runs in this organization’s repositories, and the engines its owners define.</p></div></header><Suspense fallback={<p role="status">Opening engines…</p>}><EngineSettings key={`${user.id}/${location.organization}`} target={{ scope: 'organization', organization: location.organization }} userId={user.id} /></Suspense></section></OrganizationSettingsLayout> : location.kind === 'organization-automations' ? <OrganizationSettingsLayout organization={location.organization}><section className="page-stack"><header className="repository-intro"><div><h1>Automations</h1><p>Built-in tools and your own instructions that run on this organization’s repositories when something happens, on a schedule or on request. They act as a person, open drafts a person publishes, and never merge.</p></div></header><Suspense fallback={<p role="status">Opening automations…</p>}><AutomationSettings key={`${user.id}/${location.organization}`} target={{ scope: 'organization', organization: location.organization }} userId={user.id} /></Suspense></section></OrganizationSettingsLayout> : location.kind === 'organization-agents' ? <OrganizationSettingsLayout organization={location.organization}><section className="page-stack"><header className="repository-intro"><div><h1>Agent hosts</h1><p>Machines this organization’s owners connect to run coding tools for issues and pull requests in its repositories.</p></div></header><Suspense fallback={<p role="status">Opening agent hosts…</p>}><AgentHostSettings key={`${user.id}/${location.organization}`} target={{ scope: 'organization', organization: location.organization }} userId={user.id} /></Suspense></section></OrganizationSettingsLayout> : location.kind === 'organization-secrets' ? <Suspense fallback={<p role="status">Opening organization values…</p>}><OrganizationExecutionSettings key={`${user.id}/${location.organization}`} userId={user.id} organization={location.organization} signingOut={logout.isPending} /></Suspense> : location.kind === 'organization-settings' ? <OrganizationSettingsLayout organization={location.organization}><ScopedSettings userId={user.id} signingOut={logout.isPending} scope="organization" name={location.organization} /></OrganizationSettingsLayout> : location.kind === 'instance-settings' ? user.isInstanceAdmin ? <Suspense fallback={<p role="status">Opening instance settings…</p>}><InstanceSettings key={`${user.id}/${location.view ?? 'accounts'}`} view={location.view} userId={user.id} signingOut={logout.isPending} /></Suspense> : <section><h1>Instance settings unavailable</h1><p>This page requires an enrolled Golf instance administrator.</p></section> : location.kind === 'repository-search' ? <Suspense fallback={<p role="status">Opening search…</p>}><RepositorySearch key={`${user.id}/${location.repository.owner}/${location.repository.name}`} userId={user.id} owner={location.repository.owner} name={location.repository.name} query={location.q}/></Suspense> : location.kind === 'notifications' ? <Suspense fallback={<p role="status">Opening notifications…</p>}><ForgeNotificationInbox key={user.id} userId={user.id}/></Suspense> : location.kind === 'account-invitations' ? <AccountLayout><section className="page-stack"><header className="repository-intro"><div><h1>Invitations</h1><p>Review repository access offered to your account.</p></div></header><Suspense fallback={<p role="status">Opening invitations…</p>}><RepositoryInvitationInbox key={user.id} userId={user.id} signingOut={logout.isPending}/></Suspense></section></AccountLayout> : location.kind === 'account-credentials' ? <section className="page-stack"><header className="repository-intro"><div><span className="eyebrow">DEVELOPER</span><h1>Credentials and engines</h1><p>Your API keys and subscription sign-ins, sealed in Golf’s credential vault, and the personal engines that use them.</p></div></header><Suspense fallback={<p role="status">Opening credentials…</p>}><CredentialSettings key={user.id} target={{ scope: 'user' }} userId={user.id} /><EngineSettings key={`engines-${user.id}`} target={{ scope: 'user' }} userId={user.id} /></Suspense></section> : location.kind === 'account-api-tokens' ? <section className="page-stack"><header className="repository-intro"><div><span className="eyebrow">DEVELOPER</span><h1>API tokens</h1><p>Personal tokens for coding agents: the remote MCP endpoint, the Source API and HTTPS Git, scoped to repositories, read or write and the branches they may write.</p></div></header><Suspense fallback={<p role="status">Opening API tokens…</p>}><ApiTokenSettings key={user.id} userId={user.id} /></Suspense></section> : location.kind === 'account-connections' ? <section className="page-stack"><header className="repository-intro"><div><h1>Provider connections</h1><p>Personal GitHub and GitLab credentials for explicitly selected imports.</p></div></header><Suspense fallback={<p role="status">Opening provider connections…</p>}><ProviderConnections086 key={user.id} userId={user.id} blocked={logout.isPending}/></Suspense></section> : location.kind === 'account-agents' ? native ? <section className="page-stack"><header className="repository-intro"><div><h1>Agent hosts</h1><p>Your own machines that run Codex, Claude Code, OpenCode or Grok for issues and pull requests, under the sign-ins already on each machine.</p></div></header><Suspense fallback={<p role="status">Opening agent hosts…</p>}><AgentHostSettings key={user.id} target={{ scope: 'personal' }} userId={user.id} /></Suspense></section> : <Suspense fallback={<p role="status">Opening coding agent connections…</p>}><CodexConnections key={user.id} userId={user.id} signingOut={logout.isPending} /></Suspense> : location.kind === 'account-security' ? <Suspense fallback={<p role="status">Opening account security…</p>}><AccountSecurity key={user.id} userId={user.id} signingOut={logout.isPending} onSignedOut={signedOut} /></Suspense> : location.kind === 'settings' ? <AccountSettings key={user.id} user={user} signingOut={logout.isPending} /> : location.kind === 'sessions' ? <Suspense fallback={<p role="status">Opening sessions…</p>}><SessionManager userId={user.id} onSignedOut={signedOut} /></Suspense> : location.kind === 'ssh-keys' ? <Suspense fallback={<p role="status">Opening SSH keys…</p>}><SSHKeys key={user.id} userId={user.id} signingOut={logout.isPending} /></Suspense> : location.kind === 'api-credentials' ? <Suspense fallback={<div className="browser-loading" role="status"><LoaderCircle size={20} className="spin" />Opening API credentials…</div>}><ApiCredentials userId={user.id} signingOut={logout.isPending} /></Suspense> : location.kind === 'audit' ? <Suspense fallback={<div className="browser-loading" role="status"><LoaderCircle size={20} className="spin" />Opening account activity…</div>}><AccountActivity userId={user.id} /></Suspense> : location.kind === 'organizations' ? <Suspense fallback={<div className="browser-loading" role="status"><LoaderCircle size={20} className="spin" />Opening organizations…</div>}><OrganizationBrowser location={location} userId={user.id} /></Suspense> : location.kind === 'repository' ? null : location.kind === 'missing' ? <NotFoundScreen jump /> : <><section className="repository-section repository-index" id="repositories" aria-labelledby="repositories-title">{appearance.content === 'panes' && repositoryQuery.isSuccess ? <nav className="repository-filters" aria-label="Repository filters"><h2>Filter</h2><h3>Owner</h3>{([['all', 'All accessible'], ['owned', 'Owned by you']] as const).map(([value, label]) => <button key={value} type="button" aria-pressed={ownership === value} onClick={() => setOwnership(value)}>{label}<span>{repositories.filter(repository => value === 'all' || repository.fullName.split('/')[0]?.toLowerCase() === user.login.toLowerCase()).length}</span></button>)}<h3>Visibility</h3>{([['all', 'All visibility'], ['private', 'Private'], ['public', 'Public']] as const).map(([value, label]) => <button key={value} type="button" aria-pressed={visibility === value} onClick={() => setVisibility(value)}>{label}<span>{repositories.filter(repository => value === 'all' || repository.private === (value === 'private')).length}</span></button>)}<p>Counts cover loaded repositories.</p></nav> : null}<div className="section-heading"><div className="title-count"><h1 id="repositories-title">Repositories</h1>{repositoryQuery.isSuccess ? <span className="count-badge">{repositories.length}{repositoryQuery.hasNextPage ? '+' : ''}</span> : null}</div>{runtime.isSuccess && !native && <PublicRepositoryImport userId={user.id} blocked={logout.isPending} onVerified={()=>void repositoryQuery.refetch()}/>}<button className="button primary" onClick={() => setCreating(true)}><Plus size={16} />{pending ? 'Resume repository creation' : 'New repository'}</button></div>
          <p className="section-description">Your repositories and organization projects.</p>
          {appearance.feature('band') && repositoryQuery.isSuccess ? <SummaryBand label="Loaded repositories summary" items={[['Loaded repositories', repositories.length, repositoryQuery.hasNextPage ? 'More are available' : undefined], ['Private', repositories.filter(repository => repository.private).length], ['Public', repositories.filter(repository => !repository.private).length], ['Shown', filtered.length, 'After search and filters']]} /> : null}
          <div className="repository-toolbar"><div className="search-input"><Search size={17} /><input aria-label="Search loaded repositories" placeholder="Search repositories…" value={search} onChange={(event) => setSearch(event.target.value)} /></div><select aria-label="Repository ownership" value={ownership} onChange={(event) => setOwnership(event.target.value)}><option value="all">All accessible</option><option value="owned">Owned by you</option></select><select aria-label="Repository visibility" value={visibility} onChange={(event) => setVisibility(event.target.value)}><option value="all">All visibility</option><option value="private">Private</option><option value="public">Public</option></select><button className="icon-button refresh" aria-label="Refresh repositories" disabled={repositoryQuery.isFetching} onClick={() => void repositoryQuery.refetch()}><RefreshCw size={17} className={repositoryQuery.isFetching ? 'spin' : ''} /></button></div>
          <ErrorMessage error={repositoryQuery.error} />
          <div className="repository-list" aria-busy={repositoryQuery.isFetching}>
            {repositoryQuery.isError ? null : repositoryQuery.isPending || (repositoryQuery.isFetching && !repositoryQuery.isFetchingNextPage) ? <div className="empty-state" role="status"><LoaderCircle className="spin" size={24} /><h3>Finding your repositories…</h3></div> : filtered.length ? filtered.map((repository) => <RepositoryRow repository={repository} key={repository.id} />) : repositoryQuery.isSuccess ? <div className="empty-state"><BookOpen size={29} /><h3>{repositories.length ? 'No matching repositories' : 'A clean slate. A new beginning.'}</h3><p>{repositories.length ? 'Try a different search, ownership or visibility filter.' : 'Create your first repository to start building.'}</p>{!repositories.length ? <button className="button secondary" onClick={() => setCreating(true)}><Plus size={15} />{pending ? 'Resume pending request' : 'Create a repository'}</button> : null}</div> : null}
          </div>
          {repositoryQuery.isSuccess ? <div className="list-footer"><span role="status">{filtered.length} of {repositories.length} loaded repositories{repositoryQuery.hasNextPage ? ' · Search applies to loaded results' : ''}</span>{repositoryQuery.hasNextPage ? <button className="text-button" disabled={repositoryQuery.isFetchingNextPage} onClick={() => void repositoryQuery.fetchNextPage()}>{repositoryQuery.isFetchingNextPage ? 'Loading…' : 'Load more'}<ArrowDown size={14} /></button> : <span>Sorted by last update</span>}</div> : null}
          {runtime.isSuccess && !native && <Suspense fallback={<p role="status">Opening connected imports…</p>}><ConnectedRepositoryImport086 userId={user.id} blocked={logout.isPending} onCreated={()=>void repositoryQuery.refetch()}/></Suspense>}
        </section></>);
  return <div className="app-shell">
    <aside className="appearance-sidebar" aria-label="Workspace shortcuts"><Brand /><span className="appearance-sidebar-label">Workspace</span><nav aria-label="Workspace"><Link to="/" data-tip="Repositories" activeOptions={{ exact: true }} aria-current={repositoryLocation ? 'page' : undefined}><BookOpen size={17} />Repositories</Link><Link to="/organizations" data-tip="Organizations"><Layers2 size={17} />Organizations</Link><Link to="/notifications" data-tip="Notifications"><Bell size={17} />Notifications</Link></nav><div ref={navigationSlot} className="context-navigation" /><span className="appearance-sidebar-label">Account</span><nav aria-label="Account"><Link to="/account/settings" data-tip="Settings"><Settings size={17} />Settings</Link><Link to="/status" data-tip="System status"><ShieldCheck size={17} />System status</Link></nav></aside>
    <div className="workspace-content"><header className="topbar"><div className="workspace-heading">
      <details ref={globalMenu} className="global-menu account-menu" onKeyDown={event => { if(event.key==='Escape'){event.currentTarget.open=false;event.currentTarget.querySelector('summary')?.focus();} }} onBlur={event=>{if(!event.currentTarget.contains(event.relatedTarget))event.currentTarget.open=false;}}><summary aria-label="Open workspace navigation" title="Workspace navigation"><Menu size={20}/></summary><nav className="account-dropdown" aria-label="Workspace menu"><strong>Workspace</strong><Link to="/">Repositories</Link><Link to="/organizations">Organizations</Link><Link to="/notifications">Notifications</Link></nav></details>
      <Brand />
      {location.kind === 'home' || location.kind === 'organizations' ? <WorkspaceSwitcher userId={user.id} login={user.login} currentOrganization={location.kind === 'organizations' ? location.organization : undefined} signingOut={logout.isPending} /> : null}
      <div ref={headingSlot} className="context-heading" /><nav className="workspace-navigation" aria-label="Workspace"><Link to="/" data-shortcut="r" activeOptions={{ exact: true }} aria-current={repositoryLocation ? 'page' : undefined}>Repositories</Link><Link to="/organizations" data-shortcut="o">Organizations</Link></nav><div ref={tabsSlot} className="context-tabs" /><div ref={toolsSlot} className="context-tools" /></div><div className="topbar-controls"><JumpTo userId={user.id} />{appearance.feature('create') ? <button type="button" className="icon-button topbar-create" aria-label="New repository" title="New repository" onClick={() => setCreating(true)}><Plus size={18} aria-hidden="true" /></button> : null}<Link to="/notifications" className="icon-button" aria-label="Notifications" title="Notifications"><Bell size={18}/></Link><ThemeSwitch /><details ref={accountMenu} className="account-menu" onKeyDown={(event) => { if (event.key === 'Escape') { closeAccountMenu(); accountMenu.current?.querySelector('summary')?.focus(); } }} onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) closeAccountMenu(); }}><summary aria-label="Your account" title="Your account"><UserRound size={18} aria-hidden="true" /></summary><div className="account-dropdown"><div className="account-label"><strong>{user.login}</strong><span>{user.isInstanceAdmin ? runtime.data?.runtimeProfile === 'cloudflare-native' ? 'Workspace administrator' : 'Instance administrator' : 'Personal workspace'}</span></div><Link to="/status" onClick={closeAccountMenu}><Layers2 size={17} />System status</Link>{native && document.documentElement.dataset.golfPublic === 'true' ? <><Link to="/$owner" params={{owner:user.login}} onClick={closeAccountMenu}>Your public profile</Link><Link to="/explore" onClick={closeAccountMenu}>Explore repositories</Link></> : null}<Link to="/account/settings" onClick={closeAccountMenu}><Settings size={17} />User settings</Link>{user.isInstanceAdmin ? <Link to="/admin" onClick={closeAccountMenu}><Settings size={17} />Admin portal</Link> : null}<button type="button" disabled={logout.isPending} onClick={() => { closeAccountMenu(); logout.mutate(); }}><LogOut size={17} />Sign out</button></div></details></div></header><div className="logout-error"><ErrorMessage error={logout.error} /></div>
      <main id="main-content"><NativePreviewResume enabled={native} />{!repositoryLocation && location.kind!=='public-profile' ? <Breadcrumbs location={location}/> : null}{repositoryLocation ? logout.isPending ? <p role="status">Signing out…</p> : <Suspense fallback={<p role="status">Opening repository…</p>}><RepositoryBrowser key={`${user.id}/${repositoryLocation.owner}/${repositoryLocation.name}`} userId={user.id} location={repositoryLocation} settingsPage={location.kind!=='repository'}>{page}</RepositoryBrowser></Suspense> : accountPage ? <AccountLayout>{page}</AccountLayout> : page}<footer className="workspace-footer"><span>Made for the work ahead.</span><span>golf<span className="accent">.</span></span></footer>
      </main>{appearance.feature('keys') ? <KeyboardLayer /> : null}{appearance.nav === 'rail' ? <RailTooltip /> : null}
    </div>{creating ? <CreateRepository privateOnly={native} userId={user.id} initial={pending} onPendingChange={setPending} onClose={() => setCreating(false)} /> : null}
  </div>;
}

function PublicWorkspace({ location }: { location: Location }) {
  const repositoryPage = location.kind === 'repository' && ['source', 'commits', 'branches', 'tags', 'compare'].includes(location.view);
  const signIn = '/auth/login?returnTo=' + encodeURIComponent(window.location.pathname + window.location.search);
  return <div className="public-workspace"><header className="topbar"><Brand /><div className="topbar-controls"><Link to="/explore">Explore</Link><ThemeSwitch /><a className="button secondary" href={signIn}>Sign in</a></div></header>
    <main id="main-content">{repositoryPage ? <Suspense fallback={<p role="status">Opening repository…</p>}><RepositoryBrowser key={`anonymous/${location.owner}/${location.name}`} userId="anonymous" anonymous location={location} /></Suspense>
      : location.kind === 'public-profile' ? <Suspense fallback={<p role="status">Opening profile…</p>}><PublicOwnerProfile key={location.owner} owner={location.owner} userId="anonymous" /></Suspense>
      : location.kind === 'home' || location.kind === 'explore' ? <Suspense fallback={<p role="status">Opening discovery…</p>}><PublicDiscovery key={location.kind === 'explore' ? JSON.stringify([location.query,location.topic]) : 'home'} initialQuery={location.kind === 'explore' ? location.query : undefined} initialTopic={location.kind === 'explore' ? location.topic : undefined} /></Suspense>
      : <section className="empty-state"><h1>Sign in to continue</h1><p>Public source and Git history are available without an account. Collaboration, builds and settings require sign-in and repository access.</p><a className="button primary" href={signIn}>Continue with Cloudflare Access</a><Link to="/">Browse public repositories</Link></section>}
    </main></div>;
}

export function App({ location }: { location: Location }) {
  const [loginNotice, setLoginNotice] = useState<string>();
  const [recoveryDisclosure,setRecoveryDisclosure]=useState<string[]|null>(null);
  useEffect(()=>{const clear=()=>setRecoveryDisclosure(null);window.addEventListener('pagehide',clear);return()=>window.removeEventListener('pagehide',clear);},[]);
  useEffect(()=>{if(!recoveryDisclosure)return;const timer=setTimeout(()=>setRecoveryDisclosure(null),5*60*1000);return()=>clearTimeout(timer);},[recoveryDisclosure]);
  const onSessionEnd=(notice?:string,codes?:string[])=>{setLoginNotice(notice);setRecoveryDisclosure(codes?.length?[...codes]:null);};
  const client = useQueryClient();
  const session = useQuery({ queryKey: ['session'], queryFn: async ({ signal }) => {
    try { const response = await sessionClient.getSession({}, { signal }); if (!response.user && document.documentElement.dataset.golfPublic === 'true') return null; if (!response.user) throw new ConnectError('The session response is missing its user.', Code.Internal); return response.user; }
    catch (error) { if (error instanceof ConnectError && error.code === Code.Unauthenticated) { forgetPrivateQueries(client); return null; } throw error; }
  } });
  useEffect(() => { if (session.isSuccess) { clearOtherCreationIntents(session.data?.id); clearOtherAccessIntents(session.data?.id); clearOtherRuleIntents(session.data?.id); clearOtherWorkflowDispatchIntents(session.data?.id); clearOtherStandardMergeIntents(session.data?.id); clearOtherReleasePublicationIntents(session.data?.id); clearOtherRefMutationIntents(session.data?.id); clearOtherFileMutationIntents(session.data?.id); clearOtherDiscussionResourceIntents(session.data?.id); clearOtherReviewRequestIntents(session.data?.id); clearOtherDeploymentIntents(session.data?.id); if (session.data) setLoginNotice(undefined); } }, [session.isSuccess, session.data?.id]);
  useEffect(() => {
    if (!session.isSuccess || !session.data || window.location.pathname !== '/') return;
    const request = new URLSearchParams(window.location.search).get('access_login');
    if (request && request.length <= 4096) window.location.replace(`/auth/access/authorize?${request}`);
    const preview = new URLSearchParams(window.location.search).get('preview_login');
    if (!request && preview && isRunID(preview)) window.location.replace(`/api/deployments/${preview}/resume`);
  }, [session.isSuccess, session.data?.id]);
  return <><a className="skip-link" href="#main-content">Skip to content</a>{recoveryDisclosure?<MFARecoveryDisclosure codes={recoveryDisclosure} acknowledge={()=>setRecoveryDisclosure(null)}/>:session.isPending ? <main className="loading-screen" id="main-content"><Brand /><p role="status"><LoaderCircle size={18} className="spin" />Opening your workspace…</p></main> : session.error ? <main className="loading-screen" id="main-content"><Brand />{unreachable(session.error) ? <OfflineScreen error={session.error} retry={() => void session.refetch()} level={1} /> : <><ErrorMessage error={session.error} /><button className="button secondary" onClick={() => void session.refetch()}>Try again</button></>}</main> : session.data ? <Workspace key={session.data.id} user={session.data} location={location} onSessionEnd={onSessionEnd} /> : document.documentElement.dataset.golfPublic === 'true' ? <PublicWorkspace location={location} /> : <Login oauthFailed={location.kind === 'home' && Boolean(location.oauthFailed)} notice={loginNotice} />}</>;
}

// One-time factor recovery disclosure lives outside the authenticated workspace.
// Its plaintext is ephemeral React state, independent of expired private queries.
function MFARecoveryDisclosure({codes,acknowledge}:{codes:string[];acknowledge:()=>void}){
 const [error,setError]=useState('');
 return <main className="login-page" id="main-content"><Brand/><section className="browser-panel credential-form-content" aria-labelledby="mfa-recovery-title"><h1 id="mfa-recovery-title">Save your recovery codes</h1><p>Your authenticator settings were saved and password and token browser sessions were revoked. Each code works once, together with your Golf password. Save these codes in your password manager before continuing. This disclosure clears when leaving or reloading the page and after five minutes.</p><pre className="source-preview" aria-label="Recovery codes">{codes.join('\n')}</pre><div className="credential-actions"><button className="button secondary" onClick={()=>void navigator.clipboard.writeText(codes.join('\n')).catch(()=>setError('Copy failed. Select the codes and copy them manually.'))}>Copy recovery codes</button><button className="button primary" onClick={acknowledge}>I saved my codes. Return to sign-in</button></div>{error?<p className="error" role="alert">{error}</p>:null}</section></main>;
}
