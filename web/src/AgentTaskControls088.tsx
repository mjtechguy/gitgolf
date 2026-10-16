import { useEffect, useRef, useState } from 'react';
import { useForm } from '@tanstack/react-form';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Code, ConnectError } from '@connectrpc/connect';
import { agentControlClient, errorMessage } from './api';
import type { AgentControl } from './gen/golf/v1/agent_control088_pb';
import type { AgentTask as Task, User } from './gen/golf/v1/golf_pb';
import { MarkdownBody } from './RepositoryContent';
import { Loading, PanelError, privateQuery } from './RepositoryUI';

type Props={userId:string;scope:string;task:Task|undefined;ready:boolean};
const invalid=()=>{throw new ConnectError('The managed agent receipt could not be verified.',Code.FailedPrecondition)};
function controlReceipt(control:AgentControl|undefined,task:Task) {
 if(!control||control.taskId!==task.id||control.attemptId!==task.attemptId||control.taskVersion!==task.version||!['initializing','active','idle','permission','dispatching','cancelling','closing','closed'].includes(control.state)||control.messages.length>64)invalid();
 const c=control!;
 if(c.available&&(!/^[1-9][0-9]*$/.test(c.revision)||c.nativeVersion!=='1.18.34'||!/^sha256:[a-f0-9]{64}$/.test(c.image)||task.state!=='running'))invalid();
 if(!c.available&&(c.canResume||c.messages.length||c.permissionId||c.toolId||c.allowOnceOptions.length))invalid();
 if(c.filePermissionsQualified&&!c.available||!c.filePermissionsQualified&&c.allowOnceOptions.length||c.canResume&&c.state!=='idle'||c.allowOnceOptions.length>8||c.state!=='permission'&&(c.permissionId||c.toolId||c.allowOnceOptions.length))invalid();
 const safeId=(id:string)=>new TextEncoder().encode(id).length<=128&&!/[\p{Cc}\p{White_Space}\uD800-\uDFFF]/u.test(id);
 if(![c.permissionId,c.toolId,...c.allowOnceOptions].every(safeId)||new Set(c.allowOnceOptions).size!==c.allowOnceOptions.length||c.state==='permission'&&(!c.permissionId||!c.toolId))invalid();
 let sequence=0,total=0;
 for(const m of c.messages){const n=Number(m.sequence);total+=new TextEncoder().encode(m.text).length;if(!/^[1-9][0-9]*$/.test(m.sequence)||!Number.isSafeInteger(n)||n<=sequence||n>513||total>256*1024||/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\uD800-\uDFFF]/u.test(m.text))invalid();sequence=n;}
 return c;
}
export function useAgentTaskControl({userId,scope,task,ready}:Props) {
 const client=useQueryClient();
 const generation=useRef({scope,ready,value:0});if(generation.current.scope!==scope||generation.current.ready!==ready)generation.current={scope,ready,value:generation.current.value+1};
 const [action,setAction]=useState({scope,pending:false,uncertain:false,notice:'',editing:false});
 const query=useQuery<AgentControl>({...privateQuery,queryKey:['agent-control',userId,scope,task?.version],enabled:ready&&!!task?.attemptId&&task.state==='running',refetchOnWindowFocus:false,refetchOnReconnect:false,refetchInterval:q=>ready&&!(action.scope===scope&&action.editing)&&!q.state.error&&task?.state==='running'?2000:false,queryFn:async({signal})=>{
  const stamp=generation.current.value;
  const receipt=await agentControlClient.getAgentControl({taskId:task!.id,attemptId:task!.attemptId},{signal,timeoutMs:10000});signal.throwIfAborted();if(generation.current.value!==stamp)throw new ConnectError('The private task selection changed.',Code.Canceled);return controlReceipt(receipt.control,task!);
 }});
 const request=useRef<AbortController|null>(null),alive=useRef(false);
 useEffect(()=>{alive.current=true;return()=>{alive.current=false;request.current?.abort();};},[scope]);
 useEffect(()=>{if(!ready){const unknown=!!request.current;request.current?.abort();void client.cancelQueries({queryKey:['agent-control',userId,scope]});client.removeQueries({queryKey:['agent-control',userId,scope]});setAction(previous=>({scope,pending:false,uncertain:previous.scope===scope&&(previous.uncertain||unknown),notice:previous.scope===scope?previous.notice:'',editing:false}));}},[client,userId,scope,ready]);
 const state=action.scope===scope?action:{scope,pending:false,uncertain:false,notice:'',editing:false};
 const control=ready&&query.isSuccess&&!query.error&&!query.isFetching?query.data:undefined;
 const active=(stamp:number)=>alive.current&&ready&&generation.current.value===stamp&&client.getQueryData<User|null>(['session'])?.id===userId;
 async function send(kind:string,text='',optionId='') {
  if(!task||!control?.available||request.current||state.pending||state.uncertain)return;
  const stamp=generation.current.value;if(!active(stamp))return;
  const abort=new AbortController();request.current=abort;const id=crypto.randomUUID();setAction({scope,pending:true,uncertain:false,notice:'',editing:false});
  try {
   const receipt=await agentControlClient.submitAgentCommand({taskId:task.id,attemptId:task.attemptId,expectedTaskVersion:task.version,expectedRevision:control.revision,requestId:id,kind,text,permissionId:kind==='permission'?control.permissionId:'',optionId},{signal:abort.signal,timeoutMs:10000});
   if(!active(stamp)||abort.signal.aborted)return;
   if(receipt.requestId!==id||!['queued','claimed'].includes(receipt.state))invalid();
   setAction({scope,pending:false,uncertain:false,notice:'Command recorded. Native completion is checked separately.',editing:false});await query.refetch();
  }catch(error){if(active(stamp)&&!abort.signal.aborted)setAction({scope,pending:false,uncertain:true,notice:`${errorMessage(error instanceof Error?error:new Error('Command outcome unknown.'))} Refresh and inspect before another command. No automatic retry was made.`,editing:false});}
  finally{if(request.current===abort)request.current=null;}
 }
 // An explicit inspection that a parent check interrupts (ready drops, its receipt is discarded) runs again once the check passes.
 const inspection=useRef('');
 async function refresh(join=false){inspection.current=scope;const stamp=generation.current.value;const receipt=await query.refetch({cancelRefetch:!join});if(!active(stamp))return;if(inspection.current===scope)inspection.current='';if(!receipt.error)setAction({scope,pending:false,uncertain:false,notice:'',editing:false});}
 useEffect(()=>{if(ready&&inspection.current===scope)void refresh(true);},[ready,scope]);
 return {query,control,state,ready,task,send,refresh:()=>refresh(),edit:()=>setAction({...state,editing:true}),cancelEdit:()=>setAction({...state,editing:false})};
}

function ReplyForm({send,cancel,pending}:{send:(text:string)=>void;cancel:()=>void;pending:boolean}) {
 const form=useForm({defaultValues:{text:''},onSubmit:({value})=>{if(value.text.trim())send(value.text)}});
 return <form className="credential-form-content" aria-label="Reply to agent" onSubmit={event=>{event.preventDefault();void form.handleSubmit();}}><form.Field name="text">{field=><><label htmlFor="agent-reply">Reply</label><textarea id="agent-reply" required rows={4} maxLength={8192} value={field.state.value} onChange={event=>field.handleChange(event.target.value)} disabled={pending}/></>}</form.Field><div className="credential-actions"><button className="button primary" disabled={pending}>Send reply</button><button type="button" className="button secondary" disabled={pending} onClick={cancel}>Cancel</button></div></form>;
}
export function AgentTaskControls({controller}:{controller:ReturnType<typeof useAgentTaskControl>}) {
 const {query,control,state,task,ready}=controller;
 if(!ready||task?.state!=='running'||!task.attemptId)return null;
 const disabled=state.pending||state.uncertain;
 return <section className="panel-content" aria-label="Managed agent conversation">
 {query.error?<PanelError error={query.error} retry={()=>void controller.refresh()}/>:query.isFetching||query.isPending?<Loading label="Checking managed agent controls…"/>:!control?.available?<p className="panel-footnote">{control?.reason||'Managed conversation is unavailable for this attempt.'}</p>:<>
 <p className="panel-footnote">Preserved native session · {control.state}. Completed messages are screened against the current native credential cache. {control.filePermissionsQualified?'Qualified workspace file permissions last for one request.':'Native file-tool execution is not qualified; requests can only be rejected or cancelled.'} Shell and external files remain denied.</p>
 {control.messages.map(message=><article className="issue-comment" key={message.sequence}><MarkdownBody text={message.text} label="Screened conversation message"/></article>)}
 {state.notice?<p role="status" className="session-notice">{state.notice}</p>:null}
 <div className="credential-actions">
 {control.state==='idle'?<><button className="button primary" disabled={disabled||state.editing} onClick={controller.edit}>Reply</button>{control.canResume?<button className="button secondary" disabled={disabled} onClick={()=>void controller.send('resume')}>Resume native session</button>:null}<button className="button secondary" disabled={disabled} onClick={()=>void controller.send('finish')}>Finish task</button></>:null}
 {control.state==='active'||control.state==='permission'?<button className="button secondary" disabled={disabled} onClick={()=>void controller.send('cancel_turn')}>Cancel turn</button>:null}
 <button className="button secondary" disabled={state.pending} onClick={()=>void controller.refresh()}>Refresh controls</button></div>
 {control.state==='permission'?<div className="panel-content"><p>Agent tool <code>{control.toolId}</code> requests permission. Tool arguments and private file contents are withheld.</p><div className="credential-actions">{control.allowOnceOptions.map(option=><button key={option} className="button primary" disabled={disabled} onClick={()=>void controller.send('permission','',option)}>Allow workspace file request once</button>)}<button className="button secondary" disabled={disabled} onClick={()=>void controller.send('permission')}>Reject request</button></div></div>:null}
 {state.editing&&control.state==='idle'?<ReplyForm pending={disabled} send={text=>void controller.send('reply',text)} cancel={controller.cancelEdit}/>:null}
 </>}
 </section>;
}
