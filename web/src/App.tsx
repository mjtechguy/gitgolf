import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowDown, ArrowRight, BookOpen, Check, CircleDot, Command, ExternalLink, GitBranch, KeyRound, Layers2, LoaderCircle, LockKeyhole, LogOut, Monitor, Moon, Plus, RefreshCw, Search, ShieldCheck, Sun, X } from 'lucide-react';
import { api, ApiError, repositoryLink } from './api';
import type { Capability, Repository, RepositoryPage, User } from './api';
import { InternalLink, repositoryHref, useLocation } from './navigation';
import { RepositoryBrowser } from './RepositoryBrowser';
import { forgetPrivateQueries } from './queryClient';

const themes = ['system', 'dark', 'light'] as const;
type Theme = typeof themes[number];

function Brand() {
  return <InternalLink className="brand" href="/" aria-label="Golf home"><img src="/golf.svg" width="34" height="34" alt="" /><span>golf<span className="brand-dot">.</span></span></InternalLink>;
}

function ThemeSwitch() {
  const [theme, setTheme] = useState<Theme>(() => {
    const initial = document.documentElement.dataset.theme;
    return themes.includes(initial as Theme) ? initial as Theme : 'system';
  });
  function changeTheme(next: Theme) {
    setTheme(next);
    document.documentElement.dataset.theme = next;
    try { localStorage.setItem('golf.theme', next); } catch { /* Theme still works when storage is unavailable. */ }
  }
  return <div className="theme-switch" role="group" aria-label="Color theme">
    {themes.map((value) => {
      const Icon = value === 'system' ? Monitor : value === 'dark' ? Moon : Sun;
      return <button key={value} type="button" aria-label={`${value[0]!.toUpperCase()}${value.slice(1)} theme`} aria-pressed={theme === value} title={`${value} theme`} onClick={() => changeTheme(value)}><Icon size={15} /></button>;
    })}
  </div>;
}

function ErrorMessage({ error }: { error: Error | null }) {
  return error ? <p className="error" role="alert">{error.message}</p> : null;
}

function Login() {
  const client = useQueryClient();
  const [token, setToken] = useState('');
  const mutation = useMutation({
    gcTime: 0,
    mutationFn: (value: string) => api('/api/session', { method: 'POST', body: JSON.stringify({ token: value }) }),
    onSuccess: async () => {
      setToken('');
      forgetPrivateQueries(client);
      await client.invalidateQueries({ queryKey: ['session'] });
    },
  });
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (token.trim() && !mutation.isPending) mutation.mutate(token.trim());
  }
  return <div className="login-page">
    <header className="login-header"><Brand /><ThemeSwitch /></header>
    <main className="login-main" id="main-content">
      <section className="login-story">
        <span className="eyebrow"><span className="status-dot" /> THE START OF SOMETHING GOOD</span>
        <h1>Your code.<br />Your next <span>great idea.</span></h1>
        <p>A focused home for the repositories you’re building. Connect your forge and get straight to work.</p>
        <div className="story-art" aria-hidden="true"><div className="art-grid" /><div className="art-path"><GitBranch size={25} /><span /><CircleDot size={15} /><span /><Check size={20} /></div><div className="art-label"><span>idea</span><span>commit</span><span>possibility</span></div></div>
        <div className="story-footer"><ShieldCheck size={17} /><span>Your repositories. Your infrastructure.</span></div>
      </section>
      <section className="login-card" aria-labelledby="login-title">
        <span className="small-icon"><KeyRound size={21} /></span>
        <h2 id="login-title">Welcome to Golf</h2>
        <p>Sign in to your connected Gitea instance.</p>
        <form onSubmit={submit}>
          <label htmlFor="access-token">Gitea access token</label>
          <input id="access-token" type="password" autoComplete="off" spellCheck={false} required value={token} onChange={(event) => setToken(event.target.value)} placeholder="Enter your scoped access token" aria-describedby="token-help" disabled={mutation.isPending} />
          <p className="field-help" id="token-help">Create a token in Gitea → Settings → Applications. To browse, select read:user and read:repository. Issues also require read:issue. To create repositories, select write:user and write:repository.</p>
          <ErrorMessage error={mutation.error} />
          <button className="button primary full" disabled={!token.trim() || mutation.isPending}>{mutation.isPending ? <LoaderCircle size={17} className="spin" /> : null}{mutation.isPending ? 'Connecting…' : 'Continue to workspace'}{!mutation.isPending ? <ArrowRight size={17} /> : null}</button>
        </form>
        <div className="login-note"><LockKeyhole size={15} /><span>Your token is sent to Golf to establish a session. It is never saved in browser storage.</span></div>
      </section>
    </main>
    <footer className="login-footer"><span>Golf · Early development</span><span>Built around developers.</span></footer>
  </div>;
}

function CreateRepository({ onClose }: { onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const nameInput = useRef<HTMLInputElement>(null);
  const client = useQueryClient();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [isPrivate, setPrivate] = useState(true);
  const mutation = useMutation({
    mutationFn: () => api('/api/repositories', { method: 'POST', body: JSON.stringify({ name: name.trim(), description: description.trim(), private: isPrivate }) }),
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: ['repositories'] });
      onClose();
    },
  });
  useEffect(() => { dialog.current?.showModal(); nameInput.current?.focus(); }, []);
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (name.trim() && !mutation.isPending) mutation.mutate();
  }
  return <dialog ref={dialog} className="create-dialog" onClose={onClose} onCancel={(event) => { if (mutation.isPending) event.preventDefault(); }} aria-labelledby="create-title">
    <div className="dialog-header"><span className="small-icon"><BookOpen size={21} /></span><button className="icon-button" aria-label="Close new repository form" disabled={mutation.isPending} onClick={onClose}><X size={19} /></button></div>
    <h2 id="create-title">Start something new.</h2><p className="muted">Create a repository in your Gitea account.</p>
    <form onSubmit={submit}>
      <label htmlFor="repo-name">Repository name <span className="required">*</span></label>
      <input ref={nameInput} id="repo-name" required maxLength={100} autoComplete="off" value={name} onChange={(event) => setName(event.target.value)} placeholder="my-next-project" disabled={mutation.isPending} />
      <label htmlFor="repo-description">Description <span className="optional">optional</span></label>
      <textarea id="repo-description" maxLength={2000} rows={3} value={description} onChange={(event) => setDescription(event.target.value)} placeholder="What are you building?" disabled={mutation.isPending} />
      <label className="visibility-choice"><input type="checkbox" checked={isPrivate} onChange={(event) => setPrivate(event.target.checked)} disabled={mutation.isPending} /><LockKeyhole size={18} /><span><strong>Private repository</strong><small>{isPrivate ? 'Only you and people you authorize can access it.' : 'Public: code will be visible to everyone with access to your forge.'}</small></span></label>
      <ErrorMessage error={mutation.error} />
      <div className="dialog-actions"><button type="button" className="button secondary" disabled={mutation.isPending} onClick={onClose}>Cancel</button><button className="button primary" disabled={!name.trim() || mutation.isPending}>{mutation.isPending ? <LoaderCircle size={16} className="spin" /> : <Plus size={16} />}{mutation.isPending ? 'Creating…' : 'Create repository'}</button></div>
    </form>
  </dialog>;
}

function RepositoryRow({ repository }: { repository: Repository }) {
  const link = repositoryLink(repository.html_url);
  const owner = repository.full_name.split('/')[0];
  const internal = owner ? repositoryHref(owner, repository.name) : undefined;
  const updated = new Date(repository.updated_at);
  return <article className="repository-row">
    <div className="repository-icon"><BookOpen size={21} /></div>
    <div className="repository-detail"><div className="repository-heading"><h3>{internal ? <InternalLink href={internal}>{repository.full_name || repository.name}</InternalLink> : repository.full_name || repository.name}</h3><span className={`visibility ${repository.private ? 'private' : ''}`}>{repository.private ? <LockKeyhole size={11} /> : null}{repository.private ? 'Private' : 'Public'}</span></div>
      <p>{repository.description || 'No description yet.'}</p>
      <div className="repository-meta"><span><GitBranch size={13} />{repository.default_branch || 'No default branch'}</span>{!Number.isNaN(updated.getTime()) ? <time dateTime={repository.updated_at} title={updated.toLocaleString()}>Updated {updated.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}</time> : <span>Update time unavailable</span>}</div>
    </div>
    {link ? <a className="open-repository" href={link} target="_blank" rel="noopener noreferrer" aria-label={`Open ${repository.full_name || repository.name} in Gitea`}><ExternalLink size={16} /></a> : null}
  </article>;
}

function Capabilities() {
  const query = useQuery({ queryKey: ['capabilities'], queryFn: () => api<{ capabilities: Capability[] }>('/api/capabilities') });
  return <section className="capabilities-section" id="capabilities" aria-labelledby="capabilities-title">
    <div className="section-heading"><div><span className="eyebrow">A CLEAR VIEW OF WHAT’S AVAILABLE</span><h2 id="capabilities-title">Your workspace today</h2></div><span className="outline-badge">Early development</span></div>
    <p className="section-description">Availability comes directly from this Golf installation.</p>
    <ErrorMessage error={query.error} />
    {query.isPending ? <p role="status" className="muted">Loading capabilities…</p> : null}
    <div className="capability-grid">{query.data?.capabilities.map((capability) => {
      const available = capability.state === 'ready';
      return <article className="capability" key={capability.id}><div><span className={available ? 'capability-marker available' : 'capability-marker'}>{available ? <Check size={14} /> : <CircleDot size={14} />}</span><h3>{capability.label}</h3><span className={`capability-state ${available ? 'available' : ''}`}>{capability.state.replaceAll('_', ' ')}</span></div><p>{capability.reason}</p></article>;
    })}</div>
  </section>;
}

function Workspace({ user }: { user: User }) {
  const client = useQueryClient();
  const location = useLocation();
  const [search, setSearch] = useState('');
  const [visibility, setVisibility] = useState('all');
  const [creating, setCreating] = useState(false);
  const repositoryQuery = useInfiniteQuery({
    queryKey: ['repositories', user.id], initialPageParam: 1, staleTime: 0, gcTime: 0, enabled: location.kind === 'home',
    queryFn: ({ pageParam, signal }) => api<RepositoryPage>(`/api/repositories?page=${pageParam}`, { signal }),
    getNextPageParam: (lastPage) => lastPage.next_page && lastPage.next_page > 0 ? lastPage.next_page : undefined,
  });
  const repositories = repositoryQuery.isSuccess && (!repositoryQuery.isFetching || repositoryQuery.isFetchingNextPage) ? [...new Map(repositoryQuery.data.pages.flatMap((page) => page.repositories).map((repository) => [repository.id, repository])).values()] : [];
  const filtered = repositories.filter((repository) => `${repository.full_name} ${repository.description}`.toLowerCase().includes(search.toLowerCase().trim()) && (visibility === 'all' || repository.private === (visibility === 'private'))).sort((left, right) => right.updated_at.localeCompare(left.updated_at));
  const logout = useMutation({
    mutationFn: () => api('/api/session', { method: 'DELETE' }),
    onSuccess: async () => {
      await client.cancelQueries();
      client.setQueryData(['session'], null);
      forgetPrivateQueries(client);
    },
  });
  return <div className="app-shell">
    <aside className="sidebar"><div className="sidebar-top"><Brand /><span className="alpha-tag">EARLY ACCESS</span></div>
      <div className="workspace-label"><span className="workspace-avatar">{user.login.slice(0, 1).toUpperCase()}</span><div><strong>{user.login}</strong><span>Personal workspace</span></div></div>
      <nav aria-label="Workspace"><span className="nav-label">WORKSPACE</span><InternalLink className="nav-item active" href="/"><BookOpen size={17} />Repositories<span>{location.kind === 'home' && repositoryQuery.isSuccess ? repositories.length : '—'}</span></InternalLink><a className="nav-item" href="/#capabilities"><Layers2 size={17} />Capabilities</a></nav>
      <div className="sidebar-bottom"><div className="forge-note"><GitBranch size={17} /><div><strong>Connected to Gitea</strong><span>Code stays on your forge.</span></div></div><div className="sidebar-controls"><ThemeSwitch /><button className="icon-button" aria-label="Sign out" title="Sign out" disabled={logout.isPending} onClick={() => logout.mutate()}><LogOut size={17} /></button></div><ErrorMessage error={logout.error} /></div>
    </aside>
    <div className="workspace-content"><header className="topbar"><span><span className="muted">Workspace</span><span className="breadcrumb-slash">/</span>{location.kind === 'repository' ? location.name : 'Repositories'}</span><span className="connection-pill"><span className="status-dot" /> Signed in</span></header>
      <main id="main-content">{location.kind === 'repository' ? <RepositoryBrowser key={`${location.owner}/${location.name}`} location={location} userId={user.id} /> : location.kind === 'missing' ? <section className="empty-state"><h1>Page not found</h1><p>This Golf link does not match a repository page.</p><InternalLink className="button secondary" href="/">Back to repositories</InternalLink></section> : <><section className="workspace-intro"><div><span className="eyebrow">YOUR NEXT COMMIT STARTS HERE</span><h1>Good to see you, {user.full_name || user.login}<span className="accent">.</span></h1><p>A little less friction. A little more building.</p></div><div className="intro-emblem" aria-hidden="true"><Command size={31} /></div></section>
        <section className="repository-section" id="repositories" aria-labelledby="repositories-title"><div className="section-heading"><div className="title-count"><h2 id="repositories-title">Repositories</h2>{repositoryQuery.isSuccess ? <span className="count-badge">{repositories.length}{repositoryQuery.hasNextPage ? '+' : ''}</span> : null}</div><button className="button primary" onClick={() => setCreating(true)}><Plus size={16} />New repository</button></div>
          <p className="section-description">Your code, with room for what comes next. Open a repository to browse its source, commits and issues in Golf.</p>
          <div className="repository-toolbar"><div className="search-input"><Search size={17} /><input aria-label="Search loaded repositories" placeholder="Search repositories…" value={search} onChange={(event) => setSearch(event.target.value)} /></div><select aria-label="Repository visibility" value={visibility} onChange={(event) => setVisibility(event.target.value)}><option value="all">All visibility</option><option value="private">Private</option><option value="public">Public</option></select><button className="icon-button refresh" aria-label="Refresh repositories" disabled={repositoryQuery.isFetching} onClick={() => void repositoryQuery.refetch()}><RefreshCw size={17} className={repositoryQuery.isFetching ? 'spin' : ''} /></button></div>
          <ErrorMessage error={repositoryQuery.error} />
          <div className="repository-list" aria-busy={repositoryQuery.isFetching}>
            {repositoryQuery.isError ? null : repositoryQuery.isPending || (repositoryQuery.isFetching && !repositoryQuery.isFetchingNextPage) ? <div className="empty-state" role="status"><LoaderCircle className="spin" size={24} /><h3>Finding your repositories…</h3></div> : filtered.length ? filtered.map((repository) => <RepositoryRow repository={repository} key={repository.id} />) : repositoryQuery.isSuccess ? <div className="empty-state"><BookOpen size={29} /><h3>{repositories.length ? 'No matching repositories' : 'A clean slate. A new beginning.'}</h3><p>{repositories.length ? 'Try a different search or visibility filter.' : 'Create your first repository to start building.'}</p>{!repositories.length ? <button className="button secondary" onClick={() => setCreating(true)}><Plus size={15} />Create a repository</button> : null}</div> : null}
          </div>
          {repositoryQuery.isSuccess ? <div className="list-footer"><span role="status">{filtered.length} of {repositories.length} loaded repositories{repositoryQuery.hasNextPage ? ' · Search applies to loaded results' : ''}</span>{repositoryQuery.hasNextPage ? <button className="text-button" disabled={repositoryQuery.isFetchingNextPage} onClick={() => void repositoryQuery.fetchNextPage()}>{repositoryQuery.isFetchingNextPage ? 'Loading…' : 'Load more'}<ArrowDown size={14} /></button> : <span>Sorted by last update</span>}</div> : null}
        </section><Capabilities /></>}<footer className="workspace-footer"><span>Made for the work ahead.</span><span>golf<span className="accent">.</span></span></footer>
      </main>
    </div>{creating ? <CreateRepository onClose={() => setCreating(false)} /> : null}
  </div>;
}

export function App() {
  const client = useQueryClient();
  const session = useQuery({ queryKey: ['session'], queryFn: async ({ signal }) => {
    try { return await api<{ user: User }>('/api/session', { signal }); }
    catch (error) { if (error instanceof ApiError && error.status === 401) { forgetPrivateQueries(client); return null; } throw error; }
  } });
  return <><a className="skip-link" href="#main-content">Skip to content</a>{session.isPending ? <main className="loading-screen" id="main-content"><Brand /><p role="status"><LoaderCircle size={18} className="spin" />Opening your workspace…</p></main> : session.error ? <main className="loading-screen" id="main-content"><Brand /><ErrorMessage error={session.error} /><button className="button secondary" onClick={() => void session.refetch()}>Try again</button></main> : session.data ? <Workspace key={session.data.user.id} user={session.data.user} /> : <Login />}</>;
}
