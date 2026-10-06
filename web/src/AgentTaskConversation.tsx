import { useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Code, ConnectError } from '@connectrpc/connect';
import { toJsonString } from '@bufbuild/protobuf';
import { Bot, CheckCircle2, FilePenLine, ListTodo, MessageSquare, Pause, Play, RefreshCw, ShieldX, Terminal, Workflow } from 'lucide-react';
import { agentTaskClient } from './api';
import { AgentEventBodyState as Body, ListAgentTaskEventsResponseSchema, type AgentTask, type AgentTaskEvent, type ListAgentTaskEventsResponse } from './gen/golf/v1/golf_pb';
import { MarkdownBody } from './RepositoryContent';
import { DateLabel, Loading, PanelError, privateQuery } from './RepositoryUI';
import { isCommitID, isRunID } from './navigation';
import { sourceRepositoryID } from './sourceReads';

const kinds = ['prompt','thread_started','turn_started','tool_started','tool_completed','approval_declined','assistant_message','plan_updated','usage_updated','turn_completed'];
const statuses = ['', 'inProgress','completed','failed','interrupted','declined','pending'];
const tools = ['', 'commandExecution','fileChange'];
const bodies = [Body.WITHHELD, Body.AVAILABLE, Body.UNAVAILABLE];
const bytes = (text:string) => new TextEncoder().encode(text).length;
const safeText = (text:string,limit:number) => bytes(text)<=limit&&!/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\uD800-\uDFFF]/u.test(text);
const nativeId = (id:string) => id===''||bytes(id)<=128&&!/[\p{Cc}\p{White_Space}\uD800-\uDFFF]/u.test(id);
const counter = (value:string) => /^(0|[1-9][0-9]{0,18})$/.test(value)&&BigInt(value)<=9223372036854775807n;
const invalid = ():never => { throw new ConnectError('Recorded activity does not match this task attempt or event boundary.',Code.FailedPrecondition); };
export const conversationDenial = (error:Error|null|undefined) => error instanceof ConnectError&&[Code.Unauthenticated,Code.PermissionDenied,Code.NotFound].includes(error.code);

function validatePage(response:ListAgentTaskEventsResponse,repositoryId:string,userId:string,task:AgentTask,after:string,limit:number) {
 if(response.repositoryId!==repositoryId||response.taskId!==task.id||response.attemptId!==task.attemptId||response.commitId!==task.commitId||response.nativeInitiatorId!==userId||!bodies.includes(response.bodyState)||response.events.length>limit||bytes(toJsonString(ListAgentTaskEventsResponseSchema,response))>512*1024)invalid();
 let sequence=Number(after||'0');
 for(const event of response.events){
  if(!counter(event.sequence)||Number(event.sequence)!==++sequence||sequence>513||!kinds.includes(event.kind)||!statuses.includes(event.status)||!tools.includes(event.toolKind)||event.bodyState!==response.bodyState||!event.createdAt||!Number.isFinite(Date.parse(event.createdAt))||event.totalTokens!==undefined&&!counter(event.totalTokens))invalid();
  if(event.kind==='prompt'&&sequence!==1||sequence===1&&event.kind!=='prompt')invalid();
  if(event.bodyState!==Body.AVAILABLE){if(event.text||event.threadId||event.turnId||event.itemId||event.phase||event.plan.length)invalid();}
  else {
   if(!safeText(event.text,event.kind==='prompt'?16384:65536)||![event.threadId,event.turnId,event.itemId].every(nativeId)||!['','commentary','final_answer'].includes(event.phase)||event.plan.length>32||event.plan.reduce((sum,step)=>sum+bytes(step.step),0)>16384||event.plan.some(step=>!step.step.trim()||!safeText(step.step,512)||!['pending','inProgress','completed'].includes(step.status)))invalid();
   if(event.kind!=='prompt'&&event.kind!=='assistant_message'&&event.text||event.kind!=='assistant_message'&&event.phase||event.kind!=='plan_updated'&&event.plan.length)invalid();
  }
 }
 if(response.nextSequence&&(!response.events.length||response.nextSequence!==response.events.at(-1)!.sequence||sequence>=513))invalid();
 if(!task.attemptId&&(response.bodyState!==Body.UNAVAILABLE||response.events.length||response.nextSequence))invalid();
 return response;
}

type Props={userId:string;repositoryId:string;owner:string;name:string;task:AgentTask|undefined;ready:boolean};
// Keep the reader mounted during parent access checks, but cancel reads and render
// no private bodies. Only the display pause flag persists, and only in memory.
export function useAgentTaskConversation({userId,repositoryId,owner,name,task,ready}:Props) {
 const client=useQueryClient(),limit=32;
 const scope=JSON.stringify([userId,repositoryId,owner,name,task?.id,task?.attemptId,task?.commitId]);
 const generation=useRef({scope,ready,value:0});
 if(generation.current.scope!==scope||generation.current.ready!==ready)generation.current={scope,ready,value:generation.current.value+1};
 const [refreshRequest,setRefreshRequest]=useState({scope,number:0});
 const handledRefresh=useRef(0);
 const [pause,setPause]=useState<{scope:string;value:boolean}>({scope,value:false});
 const paused=pause.scope===scope&&pause.value;
 const valid=Boolean(task&&isRunID(task.id)&&isCommitID(task.commitId)&&sourceRepositoryID(repositoryId)&&sourceRepositoryID(userId)&&(!task.attemptId||/^[a-f0-9]{32}$/.test(task.attemptId)));
 const key=['agent-task-events',userId,owner,name,repositoryId,task?.id||'',task?.attemptId||'',task?.commitId||''];
 // Each refresh reads a complete bounded journal from cursor zero. No partially
 // screened collection enters the cache, and a screening transition gets one reset.
 const query=useQuery({...privateQuery,staleTime:Infinity,refetchOnWindowFocus:false,refetchOnReconnect:false,refetchOnMount:false,queryKey:key,enabled:valid&&ready&&!paused,
  queryFn:async({signal})=>{
   const stamp=generation.current.value,bounded=AbortSignal.any([signal,AbortSignal.timeout(12000)]);
   if(!task||!ready)invalid();
   let after='',collection:ListAgentTaskEventsResponse|undefined,resetBody:Body|undefined;
   for(let page=0;page<34;page++){
    const response=await agentTaskClient.listAgentTaskEvents({repository:{owner,name},repositoryId,taskId:task!.id,attemptId:task!.attemptId,afterSequence:after,limit},{signal:bounded,timeoutMs:12000});
    bounded.throwIfAborted();if(generation.current.value!==stamp)throw new ConnectError('The private activity selection changed.',Code.Canceled);
    validatePage(response,repositoryId,userId,task!,after,limit);
    if(collection&&response.bodyState!==collection.bodyState){
     if(resetBody!==undefined||collection.bodyState!==Body.WITHHELD)throw new ConnectError('Activity screening changed while reading. Refresh from the beginning.',Code.FailedPrecondition);
     resetBody=response.bodyState;collection=undefined;after='';continue;
    }
    if(resetBody!==undefined&&response.bodyState!==resetBody)invalid();
    if(after&&!response.events.length)invalid();
    if(collection){collection.events.push(...response.events);collection.nextSequence=response.nextSequence;}else collection=response;
    if(collection.events.length>513||bytes(toJsonString(ListAgentTaskEventsResponseSchema,collection))>512*1024)invalid();
    if(!response.nextSequence)return collection;
    after=response.nextSequence;
   }
   return invalid();
  },
  refetchInterval:current=>ready&&!paused&&!current.state.error&&task?.state==='running'?5000:false,
 });
 useEffect(()=>{if(!ready||paused)void client.cancelQueries({queryKey:key,exact:true});},[client,scope,ready,paused]);
 useEffect(()=>{if(ready&&refreshRequest.scope===scope&&refreshRequest.number>handledRefresh.current){handledRefresh.current=refreshRequest.number;void query.refetch({cancelRefetch:false});}},[ready,scope,refreshRequest]);
 const pendingRefresh=refreshRequest.scope===scope&&refreshRequest.number>handledRefresh.current;
 const visible=ready&&!pendingRefresh&&query.isSuccess&&!query.error&&!query.isFetching;
 return {query,ready,paused,scheduleRefresh:()=>setRefreshRequest(previous=>({scope,number:previous.number+1})),setPaused:(value:boolean)=>{setPause({scope,value});if(!value)setRefreshRequest(previous=>({scope,number:previous.number+1}));},pendingRefresh,body:visible?query.data.bodyState:undefined,events:visible?query.data.events:[],running:task?.state==='running'};
}

function presentation(event:AgentTaskEvent) {
 if(event.kind==='prompt')return {label:'Task request',Icon:MessageSquare};
 if(event.kind==='assistant_message')return {label:event.phase==='final_answer'?'Final reply':event.phase==='commentary'?'Agent commentary':'Assistant message',Icon:Bot};
 if(event.kind==='plan_updated')return {label:'Plan updated',Icon:ListTodo};
 if(event.kind==='usage_updated')return {label:'Usage reported',Icon:CheckCircle2};
 if(event.kind==='approval_declined')return {label:'Approval declined',Icon:ShieldX};
 if(event.kind.startsWith('tool_'))return {label:`${event.toolKind==='commandExecution'?'Command':event.toolKind==='fileChange'?'File change':'Tool'} ${event.kind==='tool_started'?'started':'completed'}`,Icon:event.toolKind==='fileChange'?FilePenLine:Terminal};
 return {label:event.kind==='thread_started'?'Conversation started':event.kind==='turn_started'?'Turn started':'Turn completed',Icon:Workflow};
}
export function AgentTaskConversation({reader}:{reader:ReturnType<typeof useAgentTaskConversation>}) {
 const {query,ready,paused,body,events,running,pendingRefresh}=reader;
 if(!ready)return null;
 return <section className="browser-panel credential-list-panel" aria-label="Conversation and activity"><div className="browser-panel-heading"><h3><MessageSquare size={18}/>Conversation and activity</h3><div className="row-actions">{running?<button className="icon-button" title={paused?'Resume activity refresh':'Pause activity refresh'} aria-label={paused?'Resume activity refresh':'Pause activity refresh'} aria-pressed={paused} onClick={()=>reader.setPaused(!paused)}>{paused?<Play size={16}/>:<Pause size={16}/>}</button>:null}<button className="icon-button" aria-label="Refresh conversation activity" title="Refresh conversation activity" disabled={query.isFetching} onClick={()=>void query.refetch()}><RefreshCw size={16}/></button></div></div>
 {query.error?<PanelError error={query.error} retry={()=>void query.refetch()}/>:pendingRefresh||query.isPending||query.isFetching?<Loading label="Reading recorded activity…"/>:<>
 <p className="panel-footnote">{body===Body.WITHHELD?'Live activity metadata. Message text and plans remain withheld until credential screening finishes.':body===Body.AVAILABLE?'Screened recorded messages and activity for this attempt.':events.length?'Activity metadata is retained; message content is unavailable for this attempt.':'No conversation journal is available for this attempt.'} {paused?'Activity refresh is paused.':running?'Activity is checked periodically; this is not a live token stream.':''}</p>
 <ol className="issue-comment-list" aria-label="Recorded agent events">{events.map(event=>{const {label,Icon}=presentation(event);return <li key={event.sequence}><article className="issue-comment"><header className="issue-comment-heading"><div className="issue-comment-byline"><h3 className="row-actions"><Icon size={15} aria-hidden="true"/>{label}</h3><span><DateLabel value={event.createdAt}/></span>{event.status?<span>· {event.status==='inProgress'?'in progress':event.status}</span>:null}</div></header>
 {event.text?<MarkdownBody text={event.text} label={label}/>:null}
 {event.plan.length?<ul className="panel-content" aria-label="Recorded plan">{event.plan.map((step,index)=><li key={index}>{step.step} · {step.status==='inProgress'?'in progress':step.status}</li>)}</ul>:null}
 {event.totalTokens!==undefined?<p className="panel-footnote">Reported total tokens: {BigInt(event.totalTokens).toLocaleString()}</p>:null}
 {(event.kind==='prompt'||event.kind==='assistant_message'||event.kind==='plan_updated')&&event.bodyState!==Body.AVAILABLE?<p className="panel-footnote">{event.bodyState===Body.WITHHELD?'Content withheld pending screening.':'Message content unavailable.'}</p>:null}
 </article></li>})}</ol>
 </>}
 <p className="panel-footnote">Recorded activity supports Codex tasks and OpenCode read-only PR reviews. Raw commands, terminal output and reasoning are not shown. Reply, approvals and continuation are not available here.</p></section>;
}
