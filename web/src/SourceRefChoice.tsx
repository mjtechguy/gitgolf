import { useId, useState } from 'react';
import { useForm } from '@tanstack/react-form';
import { Link, useNavigate } from '@tanstack/react-router';
import { Code, ConnectError } from '@connectrpc/connect';
import { GitBranch, Tag } from 'lucide-react';
import { repositoryOptions, type RepositoryLocation } from './navigation';
import { sourcePath, sourceRef } from './sourceReads';
import { RepositorySourceRefKind as Kind, type RepositorySourceCandidate } from './gen/golf/v1/golf_pb';
import { Loading, PanelError, shortSHA } from './RepositoryUI';

export function SourceRefChoice({ location, candidates, pending, error, retry }: {location:RepositoryLocation;candidates:RepositorySourceCandidate[];pending:boolean;error:unknown;retry:()=>void}) {
  const [editing,setEditing]=useState(false), navigate=useNavigate(), id=useId();
  const form=useForm({defaultValues:{kind:'branch' as 'branch'|'tag',name:'',path:''},onSubmit:async({value})=>{
    if(!sourceRef(value.name)||!sourcePath(value.path))return;
    await navigate(repositoryOptions(location,{view:'source',ref:value.name,refKind:value.kind,refName:value.name,path:value.path,branch:value.kind==='branch'?value.name:'',tag:value.kind==='tag'?value.name:undefined},location.sourceRoute==='blob'?'file':undefined));
  }});
  const canSelect=Boolean(candidates.length || error instanceof ConnectError&&[Code.ResourceExhausted,Code.InvalidArgument,Code.FailedPrecondition,Code.NotFound,Code.DeadlineExceeded,Code.Unavailable].includes(error.code));
  return <section className="browser-panel" aria-labelledby="source-selection-title"><div className="browser-panel-heading"><h2 id="source-selection-title">Source selection</h2></div>
    {pending?<Loading label="Resolving repository source…"/>:error?<PanelError error={error instanceof Error?error:new Error('Source selection unavailable.')} retry={retry}/>:null}
    {candidates.length?<><p>This address identifies multiple branch/tag and path combinations. Choose an explicit namespace. File existence is not used to select a ref.</p><ul className="source-ref-candidates" aria-label="Source address candidates">{candidates.map(candidate=>{const selected=candidate.selection!,kind=selected.kind===Kind.TAG?'tag':'branch',Icon=kind==='tag'?Tag:GitBranch;
      return <li key={`${kind}:${selected.name}:${candidate.path}`}><Link {...repositoryOptions(location,{view:'source',ref:selected.name,refKind:kind,refName:selected.name,path:candidate.path,branch:kind==='branch'?selected.name:'',tag:kind==='tag'?selected.name:undefined},location.sourceRoute==='blob'?'file':undefined)}><Icon size={16}/><span><strong>Use {kind} {selected.name}</strong><small>Path: {candidate.path||'/'} · Observed at {shortSHA(selected.commitId)}</small></span></Link></li>;
    })}</ul></>:null}
    {canSelect?<button className="text-button" onClick={()=>setEditing(!editing)} aria-expanded={editing}>Choose ref and path</button>:null}
    {editing?<form className="source-ref-form" aria-label="Explicit source selection" onSubmit={event=>{event.preventDefault();event.stopPropagation();void form.handleSubmit();}}>
      <form.Field name="kind">{field=><div><label htmlFor={`${id}-kind`}>Ref type</label><select id={`${id}-kind`} value={field.state.value} onChange={event=>field.handleChange(event.target.value as 'branch'|'tag')}><option value="branch">Branch</option><option value="tag">Tag</option></select></div>}</form.Field>
      <form.Field name="name" validators={{onChange:({value})=>sourceRef(value)?undefined:'Enter an exact valid branch or tag name.'}}>{field=><div><label htmlFor={`${id}-name`}>Ref name</label><input id={`${id}-name`} value={field.state.value} onChange={event=>field.handleChange(event.target.value)} autoComplete="off"/><span className="field-help">Exact namespace; loaded inventories do not prove completeness.</span></div>}</form.Field>
      <form.Field name="path" validators={{onChange:({value})=>sourcePath(value)?undefined:'Enter a literal repository path.'}}>{field=><div><label htmlFor={`${id}-path`}>Repository path</label><input id={`${id}-path`} value={field.state.value} onChange={event=>field.handleChange(event.target.value)} autoComplete="off"/></div>}</form.Field>
      <form.Subscribe selector={state=>[state.values.name,state.values.path,state.isSubmitting] as const}>{([name,path,busy])=><button className="button primary" disabled={busy||!sourceRef(name)||!sourcePath(path)}>Open source</button>}</form.Subscribe>
    </form>:null}
  </section>;
}
