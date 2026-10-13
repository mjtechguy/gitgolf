import { Breadcrumbs } from './Breadcrumbs';
import { RepositoryVisibility } from './RepositoryUI';
import { lazy, Suspense, useState } from 'react';
import { useForm } from '@tanstack/react-form';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { MapPin, Link2, Building2, UserRound } from 'lucide-react';
import { nativeAPI } from './NativeForge';
import { repositoryOptions } from './navigation';
import { Loading, PanelError, privateQuery } from './RepositoryUI';

const MarkdownBody = lazy(() => import('./RepositoryContent').then(m => ({ default: m.MarkdownBody })));
type Repository = { id: string; name: string; owner: string; fullName: string; description: string; topics: string[]; updatedAt: string };
type Profile = { ownerId: string; slug: string; kind: string; enabled: boolean; canEdit: boolean; revision: string;
  displayName: string; bio: string; location: string; website: string; readme: string; pinnedRepositories: Repository[]; publicRepositoryCount: number };
type ProfileDraft = Pick<Profile, 'enabled' | 'displayName' | 'bio' | 'location' | 'website' | 'readme'> & { pinned: string[] };
type Discovery = { repositories: Repository[]; nextPage: number };

function RepositoryList({ repositories, pinned = false }: { repositories: Repository[]; pinned?: boolean }) {
  return <div className={pinned ? 'public-pinned-grid' : 'public-repository-list'}>{repositories.map(repo => <article className="public-repository-card" key={repo.id}>
    <h3><Link {...repositoryOptions({ owner: repo.owner, name: repo.name })}>{repo.fullName}</Link><RepositoryVisibility isPrivate={false} /></h3>
    {repo.description ? <p>{repo.description}</p> : null}<div className="public-topics">{repo.topics.map(topic => <Link key={topic} to="/explore" search={{ topic }}>{topic}</Link>)}</div>
  </article>)}</div>;
}
export function PublicDiscovery({ owner, initialQuery = '', initialTopic = '' }: { owner?: string; initialQuery?: string; initialTopic?: string }) {
  const [criteria, setCriteria] = useState({ query: initialQuery, topic: initialTopic });
  const form = useForm({ defaultValues: criteria, onSubmit: ({ value }) => setCriteria(value) });
  const result = useInfiniteQuery({ ...privateQuery, queryKey: ['public-discovery', owner, criteria], initialPageParam: 1,
    queryFn: ({ pageParam, signal }) => nativeAPI<Discovery>('/native/discover', { ...criteria, owner, page: { page: pageParam, limit: 20 } }, signal),
    getNextPageParam: page => page.nextPage || undefined });
  const rows = result.data?.pages.flatMap(p => p.repositories) || [];
  return <section className="page-stack"><header className="repository-intro"><div><h2>{owner ? 'Public repositories' : 'Explore repositories'}</h2><p>Search public repository names, descriptions and topics.</p></div></header>
    <form className="public-search" onSubmit={event => { event.preventDefault(); void form.handleSubmit(); }}>
      <form.Field name="query">{field => <label>Search repositories<input type="search" value={field.state.value} maxLength={100} onChange={event => field.handleChange(event.target.value)} placeholder="Name, description or topic" /></label>}</form.Field>
      <form.Field name="topic">{field => <label>Topic<input value={field.state.value} maxLength={35} onChange={event => field.handleChange(event.target.value)} placeholder="Any topic" /></label>}</form.Field><button className="button primary">Search</button>
    </form>{result.error ? <PanelError error={result.error} retry={() => void result.refetch()} /> : result.isPending ? <Loading label="Searching public repositories…" /> : <><RepositoryList repositories={rows} />{!rows.length ? <p>No public repositories match this search.</p> : null}</>}
    {result.hasNextPage ? <button className="button secondary" disabled={result.isFetchingNextPage} onClick={() => void result.fetchNextPage()}>Load more results</button> : null}
  </section>;
}

export function PublicOwnerProfile({ owner, userId }: { owner: string; userId: string }) {
  const cache = useQueryClient(), [editing, setEditing] = useState(false);
  const key = ['public-profile', userId, owner];
  const query = useQuery({ ...privateQuery, queryKey: key, queryFn: ({ signal }) => nativeAPI<Profile>('/native/public-profile', { action: 'get', owner }, signal) });
  const value = query.data;
  if (query.error) return <PanelError error={query.error} retry={() => void query.refetch()} />;
  if (!value) return <Loading label="Opening profile…" />;
  const Icon = value.kind === 'ORGANIZATION' ? Building2 : UserRound;
  return <><Breadcrumbs location={{kind:'public-profile',owner}} currentLabel={value.displayName || value.slug} /><div className="public-profile-layout"><aside className="public-profile-identity"><div className="public-profile-avatar" aria-hidden="true"><Icon size={40} /></div>
    <span className="eyebrow">{value.kind === 'ORGANIZATION' ? 'Organization' : 'Developer'}</span><h1>{value.displayName || value.slug}</h1><p className="public-profile-handle">@{value.slug}</p>
    {value.bio ? <p>{value.bio}</p> : null}{value.location ? <p><MapPin size={15} /> {value.location}</p> : null}{value.website ? <p><Link2 size={15} /> <a href={value.website} target="_blank" rel="noreferrer">{new URL(value.website).hostname}</a></p> : null}
    <p>{value.publicRepositoryCount} public {value.publicRepositoryCount === 1 ? 'repository' : 'repositories'}</p>
    {value.canEdit ? <><button className="button secondary" disabled={editing || query.isFetching} onClick={() => setEditing(true)}>Edit public profile</button>{!value.enabled ? <p className="field-help">Profile details are unpublished. Visitors only see the owner name and public repositories.</p> : null}</> : null}
  </aside><div className="page-stack">{editing && value.canEdit ? <ProfileEditor key={value.revision} value={value} onSaved={profile => { cache.setQueryData(key, profile); setEditing(false); }} onCancel={() => { setEditing(false); void query.refetch(); }} /> : <>
    {value.readme ? <section className="browser-panel credential-form-content"><h2>README</h2><Suspense fallback={<Loading label="Opening profile README…" />}><MarkdownBody text={value.readme} label={`${owner} profile README`} /></Suspense></section> : null}
    {value.pinnedRepositories.length ? <section className="page-stack"><h2>Pinned repositories</h2><RepositoryList repositories={value.pinnedRepositories} pinned /></section> : null}
    <PublicDiscovery key={owner} owner={owner} /></>}
  </div></div></>;
}
function ProfileEditor({ value, onSaved, onCancel }: { value: Profile; onSaved: (value: Profile) => void; onCancel: () => void }) {
  const choices = useQuery({ ...privateQuery, queryKey: ['public-pin-choices', value.slug], queryFn: ({ signal }) => nativeAPI<Discovery>('/native/discover', { owner: value.slug, page: { page: 1, limit: 100 } }, signal) });
  const mutation = useMutation({ retry: false, mutationFn: (profile: ProfileDraft) => nativeAPI<Profile>('/native/public-profile', { action: 'save', owner: value.slug, ownerId: value.ownerId, expectedRevision: value.revision, profile }), onSuccess: result => {
    if (result.ownerId !== value.ownerId || result.slug !== value.slug || !result.canEdit || !/^[a-f0-9]{64}$/.test(result.revision)) throw Error('Profile update could not be confirmed. Refresh before editing.');
    onSaved(result);
  } });
  const form = useForm({ defaultValues: { enabled: value.enabled, displayName: value.displayName, bio: value.bio, location: value.location, website: value.website, readme: value.readme, pinned: value.pinnedRepositories.map(repo => repo.id) }, onSubmit: ({ value }) => mutation.mutate(value) });
  return <section className="browser-panel credential-form-content"><h2>Edit public profile</h2><p>Published fields are visible to everyone. Account email and organization membership remain private.</p><form className="page-stack" onSubmit={event => { event.preventDefault(); void form.handleSubmit(); }}>
    <form.Field name="enabled">{field => <label><input type="checkbox" checked={field.state.value} disabled={mutation.isPending} onChange={event => field.handleChange(event.target.checked)} /> Publish this profile</label>}</form.Field>
    {(['displayName','bio','location','website','readme'] as const).map(name => <form.Field key={name} name={name}>{field => <label>{({ displayName:'Display name',bio:'Bio or company description',location:'Location',website:'Website',readme:'Profile README (Markdown)' })[name]}{['bio','readme'].includes(name) ? <textarea rows={name === 'readme' ? 12 : 3} value={field.state.value} disabled={mutation.isPending} onChange={event => field.handleChange(event.target.value)} /> : <input type={name === 'website' ? 'url' : 'text'} value={field.state.value} disabled={mutation.isPending} onChange={event => field.handleChange(event.target.value)} />}</label>}</form.Field>)}
    <fieldset><legend>Pinned repositories · up to six</legend><p className="field-help">Choose from the first 100 public repositories owned by this profile.</p><form.Field name="pinned">{field => <div className="page-stack">{choices.data?.repositories.map(repo => <label key={repo.id}><input type="checkbox" checked={field.state.value.includes(repo.id)} disabled={mutation.isPending || !field.state.value.includes(repo.id) && field.state.value.length >= 6} onChange={event => field.handleChange(event.target.checked ? [...field.state.value,repo.id] : field.state.value.filter(id => id !== repo.id))} /> {repo.name} <RepositoryVisibility isPrivate={false} /></label>)}</div>}</form.Field>{choices.error ? <PanelError error={choices.error} retry={() => void choices.refetch()} /> : null}</fieldset>
    {mutation.error ? <PanelError error={mutation.error} retry={onCancel} /> : null}<div className="credential-actions"><button className="button primary" disabled={mutation.isPending || mutation.isError}>Save profile</button><button className="button secondary" type="button" disabled={mutation.isPending} onClick={onCancel}>Cancel</button></div>
  </form></section>;
}
