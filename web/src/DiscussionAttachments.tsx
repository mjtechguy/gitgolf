import {useEffect,useRef,useState} from 'react';
import {useQuery,useQueryClient} from '@tanstack/react-query';
import {Code,ConnectError} from '@connectrpc/connect';
import {create,equals} from '@bufbuild/protobuf';
import {Download,Paperclip,RefreshCw} from 'lucide-react';
import {DataTable,type DataTableColumn} from './DataTable';
import {DateLabel,Loading,PanelError,privateQuery} from './RepositoryUI';
import {errorMessage} from './api';
import {discussionAttachmentClient} from './forge089Api';
import {DiscussionTargetSchema,type DiscussionTarget} from './gen/golf/v1/golf_pb';
import type {DiscussionAttachment} from './gen/golf/v1/forge089_pb';
import {sourceRepositoryID} from './sourceReads';

type Props={target:DiscussionTarget;userId:string;blocked?:boolean;onDenied?:(e:Error)=>void};
export function DiscussionAttachmentDisclosure(p:Props){return <Disclosure key={JSON.stringify([p.userId,p.target])} {...p}/>}
function Disclosure(p:Props){const [open,setOpen]=useState(false);return <details className="metadata-details panel-disclosure" onToggle={e=>setOpen(e.currentTarget.open)}><summary>Attachments</summary>{open?<DiscussionAttachments {...p}/>:null}</details>}
const denied=(e:unknown)=>e instanceof ConnectError&&[Code.NotFound,Code.Unauthenticated,Code.PermissionDenied].includes(e.code);
const revision=/^[a-f0-9]{64}$/;
const valid=(a:DiscussionAttachment)=>sourceRepositoryID(a.id)&&!!a.name&&new TextEncoder().encode(a.name).length<=1024&&a.sizeBytes>=0n&&revision.test(a.revision)&&Number.isFinite(Date.parse(a.createdAt));
export function DiscussionAttachments(p:Props){return <Attachments key={JSON.stringify([p.userId,p.target])} {...p}/>}
function Attachments(p:Props){
 const cache=useQueryClient(),scope=['discussion-attachments',p.userId,p.target.repository?.owner,p.target.repository?.name,p.target.repositoryId,p.target.issueId,p.target.number,p.target.pullRequest,p.target.commentId],alive=useRef(true),epoch=useRef(0),abort=useRef<AbortController|undefined>(undefined);
 const [busy,setBusy]=useState(''),[error,setError]=useState(''),[hidden,setHidden]=useState(false);
 const current=()=>cache.getQueryData<{id:string}>(['session'])?.id===p.userId;
 const q=useQuery({...privateQuery,queryKey:scope,enabled:!hidden&&!p.blocked&&current(),queryFn:async({signal})=>{const r=await discussionAttachmentClient.listDiscussionAttachments({target:p.target},{signal});if(!r.target||!equals(DiscussionTargetSchema,r.target,create(DiscussionTargetSchema,p.target))||!revision.test(r.snapshotRevision)||r.attachments.length>100||r.attachments.some(a=>!valid(a))||new Set(r.attachments.map(a=>a.id)).size!==r.attachments.length)throw Error('Attachment inventory could not be verified.');return r}});
 useEffect(()=>{alive.current=true;const cancel=()=>{epoch.current++;abort.current?.abort();queueMicrotask(()=>{if(alive.current){setBusy('');setError('')}})};const off=cache.getQueryCache().subscribe(()=>{if(!current())cancel()});return()=>{alive.current=false;epoch.current++;abort.current?.abort();off();void cache.cancelQueries({queryKey:scope});cache.removeQueries({queryKey:scope})}},[]);
 useEffect(()=>{if(p.blocked||q.error){epoch.current++;abort.current?.abort();setBusy('');if(denied(q.error)){setHidden(true);p.onDenied?.(q.error as Error)}}},[p.blocked,q.error]);
 async function download(a:DiscussionAttachment){if(busy||q.isFetching||q.error||p.blocked||!current())return;const n=++epoch.current,c=new AbortController();abort.current=c;setBusy(a.id);setError('');const active=()=>alive.current&&epoch.current===n&&current();try{const r=await discussionAttachmentClient.downloadDiscussionAttachment({target:p.target,attachmentId:a.id,expectedRevision:a.revision},{signal:c.signal,timeoutMs:15000});const hash=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new Uint8Array(r.content)))).map(b=>b.toString(16).padStart(2,'0')).join('');if(!r.target||!equals(DiscussionTargetSchema,r.target,create(DiscussionTargetSchema,p.target))||!r.attachment||!valid(r.attachment)||r.attachment.id!==a.id||r.attachment.revision!==a.revision||r.attachment.name!==a.name||r.attachment.sizeBytes!==a.sizeBytes||BigInt(r.content.length)!==a.sizeBytes||r.content.length>10*1024*1024||hash!==r.contentSha256)throw Error('Attachment bytes could not be verified.');if(!active())return;const url=URL.createObjectURL(new Blob([new Uint8Array(r.content)],{type:'application/octet-stream'})),link=document.createElement('a');link.href=url;link.download=a.name;link.click();setTimeout(()=>URL.revokeObjectURL(url),1000)}catch(e){if(active()){setError(errorMessage(e instanceof Error?e:Error('Download failed.')));if(denied(e)){setHidden(true);p.onDenied?.(e as Error)}}}finally{if(active()){setBusy('');abort.current=undefined}}}
 const columns:DataTableColumn<DiscussionAttachment>[]=[{accessorKey:'name',header:'File'},{accessorKey:'sizeBytes',header:'Bytes',cell:({row})=>row.original.sizeBytes.toString()},{accessorKey:'createdAt',header:'Added',cell:({row})=><DateLabel value={row.original.createdAt}/>},{id:'download',header:'',enableSorting:false,enableGlobalFilter:false,cell:({row})=><button className="icon-button" aria-label={`Download ${row.original.name}`} title="Download attachment" disabled={!!busy||q.isFetching||row.original.sizeBytes>10n*1024n*1024n} onClick={()=>void download(row.original)}><Download size={15}/></button>}];
 if(hidden||p.blocked||!current())return null;
 return <section className="browser-panel" aria-label="Discussion attachments"><div className="browser-panel-heading"><h3><Paperclip size={16}/>Attachments</h3><button className="icon-button" aria-label="Refresh attachments" title="Refresh attachments" disabled={q.isFetching||!!busy} onClick={()=>void q.refetch()}><RefreshCw size={15}/></button></div>{q.error?<PanelError error={q.error} retry={()=>void q.refetch()}/>:q.isPending||q.isFetching?<Loading label="Reading current attachments…"/>:q.data?<DataTable label="discussion attachments" data={q.data.attachments} columns={columns} getRowId={a=>a.id} emptyMessage="No attachments on this discussion body."/>:null}{error?<p className="error" role="alert">{error}</p>:null}<p className="field-help">Current authorized downloads up to 10 MiB. Attachment creation and replacement remain unavailable.</p></section>
}
