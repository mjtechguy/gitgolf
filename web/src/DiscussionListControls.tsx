import { useId, useState } from 'react';
import { useForm, useStore } from '@tanstack/react-form';
import { useNavigate } from '@tanstack/react-router';
import { Search, ListFilter, X } from 'lucide-react';
import { repositoryOptions, type RepositoryLocation } from './navigation';

export function discussionQuery(location: RepositoryLocation) {
  return { search: location.q || '', author: location.author || '', assignee: location.assignee || '', labelNames: location.labels?.split(',').map(value => value.trim()).filter(Boolean) || [], milestoneTitle: location.milestone || '' };
}
export function DiscussionListControls({ location, label }: { location: RepositoryLocation; label: 'issues' | 'pull requests' }) {
  const navigate = useNavigate(), id = useId();
  const [expanded, setExpanded] = useState(false), [error, setError] = useState('');
  const query = discussionQuery(location);
  const form = useForm({ defaultValues: { q: query.search, author: query.author, assignee: query.assignee, labels: location.labels || '', milestone: query.milestoneTitle, sort: location.sort || 'newest', base: location.base || '' }, onSubmit: ({ value }) => {
    const q = value.q.trim(), author = value.author.trim(), assignee = value.assignee.trim(), names = value.labels.split(',').map(value => value.trim()).filter(Boolean), milestone = value.milestone.trim(), base = value.base.trim();
    const text = (value: string, limit: number) => new TextEncoder().encode(value).length <= limit && !/\p{Cc}/u.test(value);
    if (!text(q,512) || !text(milestone,255) || milestone.includes(',') || [author,assignee].some(value => value && !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$/.test(value)) || names.length > 20 || new Set(names).size !== names.length || names.some(name => !text(name,255))) { setError('Use bounded search text, valid account names and up to 20 distinct label names.'); return; }
    const filtered = Boolean(q || author || assignee || names.length || milestone);
    void navigate(repositoryOptions(location,{ q:q||undefined,author:author||undefined,assignee:assignee||undefined,labels:names.join(',')||undefined,milestone:milestone||undefined,sort:label==='issues'||filtered?'newest':value.sort as RepositoryLocation['sort'],base:label==='pull requests'?base||undefined:undefined,issue:undefined,pull:undefined }));
  } });
  const values = useStore(form.store,state=>state.values);
  const filtered = Boolean(values.q.trim() || values.author.trim() || values.assignee.trim() || values.labels.trim() || values.milestone.trim());
  const active = Boolean(query.search || query.author || query.assignee || query.labelNames.length || query.milestoneTitle || location.base || location.sort && location.sort !== 'newest');
  return <form aria-label={`Search repository ${label}`} onSubmit={event=>{event.preventDefault();setError('');void form.handleSubmit();}}>
    <div className="repository-list-controls">
      <form.Field name="q">{field=><div className="search-input"><label className="sr-only" htmlFor={id}>Search repository {label}</label><Search size={16} aria-hidden="true"/><input id={id} type="search" autoComplete="off" placeholder={`Search repository ${label}…`} value={field.state.value} maxLength={512} onChange={event=>field.handleChange(event.target.value)}/></div>}</form.Field>
      <button type="submit" className="button secondary">Search</button>
      <button type="button" className="icon-button" aria-label={`${expanded?'Hide':'Show'} repository filters`} title="Repository filters" aria-expanded={expanded} aria-controls={id+'-filters'} onClick={()=>setExpanded(value=>!value)}><ListFilter size={16} aria-hidden="true"/></button>
      {active?<button type="button" className="icon-button" aria-label="Clear repository filters" title="Clear filters" onClick={()=>void navigate(repositoryOptions(location,{q:undefined,author:undefined,assignee:undefined,labels:undefined,milestone:undefined,sort:undefined,base:undefined,issue:undefined,pull:undefined}))}><X size={16} aria-hidden="true"/></button>:null}
    </div>
    {expanded?<div id={id+'-filters'} className="discussion-filter-fields">
      {(['author','assignee','labels','milestone'] as const).map(name=><form.Field key={name} name={name}>{field=><label>{name==='labels'?'Label names, comma-separated':name==='milestone'?'Milestone title':name==='author'?'Author username':'Assignee username'}<input value={field.state.value} autoComplete="off" maxLength={name==='labels'?5140:name==='milestone'?255:100} onChange={event=>field.handleChange(event.target.value)}/></label>}</form.Field>)}
      {label==='pull requests'?<><form.Field name="base">{field=><label>Base branch<input value={field.state.value} autoComplete="off" maxLength={255} onChange={event=>field.handleChange(event.target.value)}/></label>}</form.Field><form.Field name="sort">{field=><label>Repository sort<select aria-label="Repository pull request sort" value={filtered?'newest':field.state.value} disabled={filtered} onChange={event=>field.handleChange(event.target.value as typeof field.state.value)}><option value="newest">Newest</option><option value="oldest">Oldest</option><option value="updated">Recently updated</option><option value="least-updated">Least recently updated</option><option value="most-commented">Most commented</option><option value="least-commented">Least commented</option></select></label>}</form.Field></>:null}
      <p className="field-help">Filters run against the repository on the server. Text and metadata searches use newest-first order.</p><div className="credential-actions"><button type="submit" className="button primary">Apply filters</button></div>
    </div>:null}
    {error?<p className="error" role="alert">{error}</p>:null}
  </form>;
}
