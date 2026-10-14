import {RuntimeFeature} from './RuntimeFeature';
import {DiscussionAttachmentDisclosure} from './DiscussionAttachments';
import {useEffect,useState} from 'react';
import {useInfiniteQuery,useQuery} from '@tanstack/react-query';
import {Code,ConnectError} from '@connectrpc/connect';
import {Bell,BellOff,GitBranch,MessageSquare,Smile,RefreshCw} from 'lucide-react';
import {Link} from '@tanstack/react-router';
import {discussionCollaborationClient as client} from './api';
import {create} from '@bufbuild/protobuf';
import {DiscussionTargetSchema,DiscussionResourceOperationKind as Kind,DiscussionResourceOperationPhase as Phase,type RepositoryKey,type SubmitDiscussionResourceOperationRequest,type DiscussionTimelineEvent} from './gen/golf/v1/golf_pb';
import {useResourceOperation} from './DiscussionResourceControls';
import {DateLabel,Loading,More,PanelError,privateQuery} from './RepositoryUI';
import {repositoryOptions,type RepositoryLocation} from './navigation';

type Scope={repositoryKey:Pick<RepositoryKey,'owner'|'name'>;repositoryId:string;userId:string;queryKey:readonly unknown[];issue:{id:string;number:number};pullRequest?:boolean;onDenied:(e:Error)=>void;commentId?:string};
const emojis:Record<string,string>={'+1':'👍','-1':'👎',laugh:'😄',hooray:'🎉',confused:'😕',heart:'❤️',rocket:'🚀',eyes:'👀'};
const labels:Record<string,string>={'+1':'Thumbs up','-1':'Thumbs down',laugh:'Laugh',hooray:'Celebrate',confused:'Confused',heart:'Heart',rocket:'Rocket',eyes:'Eyes'};
const target=(s:Scope)=>({repository:s.repositoryKey,repositoryId:s.repositoryId,issueId:s.issue.id,number:s.issue.number,pullRequest:!!s.pullRequest,commentId:s.commentId||''});
const denied=(e:unknown)=>e instanceof ConnectError&&[Code.PermissionDenied,Code.NotFound,Code.Unauthenticated].includes(e.code);
export function DiscussionEngagement(scope:Scope){
 const [picker,setPicker]=useState(false);
 const query=useQuery({...privateQuery,queryKey:[...scope.queryKey,'engagement',scope.issue.id,scope.commentId||''],queryFn:({signal})=>client.getDiscussionEngagement({target:target(scope)},{signal,timeoutMs:15000})});
 useEffect(()=>{if(denied(query.error)){setPicker(false);scope.onDenied(query.error!);}},[query.error,scope.onDenied]);
 const operation=useResourceOperation(scope,`engagement:${scope.issue.id}:${scope.commentId||'description'}`,()=>{setPicker(false);void query.refetch();},scope.onDenied);
 useEffect(()=>{if(operation.record?.phase===Phase.SUCCEEDED)operation.clear();},[operation.record?.phase]);
 const data=query.isSuccess&&!query.isFetching?query.data:undefined;
 const ready=!!data&&/^[a-f0-9]{64}$/.test(data.revision)&&!operation.original&&!operation.busy;
 const send=(kind:Kind,reaction?:string)=>{if(!ready||!data)return;const input:SubmitDiscussionResourceOperationRequest={$typeName:'golf.v1.SubmitDiscussionResourceOperationRequest',repository:{$typeName:'golf.v1.RepositoryKey',...scope.repositoryKey},repositoryId:scope.repositoryId,issueId:scope.issue.id,number:scope.issue.number,pullRequest:!!scope.pullRequest,resourceId:scope.commentId||scope.issue.id,expectedRevision:data.revision,operationId:crypto.randomUUID(),kind,reactionComment:!!scope.commentId,subscriptionLogin:reaction?'':data.actorLogin,change:reaction?{case:'reaction',value:reaction}:{case:undefined}};operation.submit(input);setPicker(false);};
 return <><div className="discussion-engagement" aria-label={scope.commentId?'Comment reactions':'Issue reactions and notifications'}>
  {query.isError?<PanelError error={query.error} retry={()=>void query.refetch()}/>:null}
  <div className="row-actions">
   {data?.reactions.filter(r=>r.count>0).map(r=><button key={r.content} className={`button secondary reaction-button ${r.reacted?'selected':''}`} aria-label={`${r.reacted?'Remove':'Add'} ${labels[r.content]||r.content} reaction (${r.count})`} aria-pressed={r.reacted} title={labels[r.content]||r.content} disabled={!ready||!data.canReact} onClick={()=>send(r.reacted?Kind.REMOVE_REACTION:Kind.ADD_REACTION,r.content)}><span aria-hidden="true">{emojis[r.content]||r.content}</span>{r.count}</button>)}
   <button className="icon-button" aria-label="Add reaction" title="Add reaction" aria-expanded={picker} disabled={!ready||!data?.canReact} onClick={()=>setPicker(!picker)}><Smile size={16}/></button>
   {!scope.commentId?<button className="button secondary" disabled={!ready||!data?.canSubscribe} aria-pressed={data?.subscribed||false} onClick={()=>send(data?.subscribed?Kind.UNSUBSCRIBE:Kind.SUBSCRIBE)}>{data?.subscribed?<BellOff size={15}/>:<Bell size={15}/>} {data?.subscribed?'Unsubscribe':'Subscribe'}</button>:null}
   <button className="icon-button" aria-label="Refresh reactions" title="Refresh reactions" disabled={query.isFetching||operation.busy} onClick={()=>void query.refetch()}><RefreshCw size={14}/></button>
  </div>
  {picker&&data?<div className="row-actions reaction-picker" aria-label="Choose reaction">{data.reactions.map(r=><button key={r.content} className="icon-button" aria-label={labels[r.content]} title={labels[r.content]} aria-pressed={r.reacted} disabled={!ready} onClick={()=>send(r.reacted?Kind.REMOVE_REACTION:Kind.ADD_REACTION,r.content)}>{emojis[r.content]}</button>)}</div>:null}
  {operation.status}{operation.error?<p className="error" role="alert">{operation.error}</p>:null}
 </div><RuntimeFeature id="discussion.attachments"><DiscussionAttachmentDisclosure target={create(DiscussionTargetSchema,target(scope))} userId={scope.userId} blocked={query.isError||query.isFetching} onDenied={scope.onDenied}/></RuntimeFeature></>;
}
function eventText(e:DiscussionTimelineEvent){
 switch(e.kind){case 'close':return 'closed this';case 'reopen':return 'reopened this';case 'merge_pull':return 'merged this';case 'change_title':return `changed the title from “${e.oldTitle}” to “${e.newTitle}”`;case 'label':return `${e.label?'changed label '+e.label.name:'changed labels'}`;case 'assignees':return 'changed assignees';case 'milestone':return 'changed the milestone';case 'commit_ref':return 'referenced this in a commit';case 'issue_ref':case 'pull_ref':return 'referenced this';default:return e.kind.replaceAll('_',' ');}
}
export function DiscussionTimeline(scope:Scope&{location:RepositoryLocation}){
 const query=useInfiniteQuery({...privateQuery,queryKey:[...scope.queryKey,'timeline',scope.issue.id],initialPageParam:1,queryFn:({pageParam,signal})=>client.listDiscussionTimeline({target:target(scope),page:{page:pageParam,limit:30}},{signal,timeoutMs:8000}),getNextPageParam:(r,_all,p)=>r.page?.nextPage&&r.page.nextPage>p?r.page.nextPage:undefined});
 useEffect(()=>{if(denied(query.error))scope.onDenied(query.error!);},[query.error,scope.onDenied]);
 const rows=query.isSuccess&&(!query.isFetching||query.isFetchingNextPage)?query.data.pages.flatMap(p=>p.events).filter(e=>e.kind!=='comment'):[];
 return <section className="browser-panel discussion-timeline" aria-label="Discussion activity"><div className="browser-panel-heading"><h2><GitBranch size={16}/> Activity</h2><button className="icon-button" aria-label="Refresh activity" disabled={query.isFetching} onClick={()=>void query.refetch()}><RefreshCw size={15}/></button></div>{query.isError?<PanelError error={query.error} retry={()=>void query.refetch()}/>:query.isPending?<Loading label="Loading activity…"/>:<><ol className="discussion-activity-list">{rows.map(e=><li key={e.id}><MessageSquare size={14} aria-hidden="true"/><div><strong>{e.actor?.login||'Deleted or unavailable user'}</strong> {eventText(e)}{e.referencedNumber?<span> in <Link {...repositoryOptions(scope.location,e.referencedPullRequest?{view:'pulls',pull:e.referencedNumber,issue:undefined}:{view:'issues',issue:e.referencedNumber,pull:undefined})}>#{e.referencedNumber} {e.referencedTitle}</Link></span>:null}<span className="muted"> · <DateLabel value={e.createdAt}/></span></div></li>)}</ol>{!rows.length?<p className="panel-footnote">No non-comment activity in the loaded pages.</p>:null}<p className="panel-footnote">Loaded native activity. Provider filtering can leave empty pages; this is not a complete historical count.</p><More label="activity" hasMore={!!query.hasNextPage} loading={query.isFetchingNextPage} load={()=>void query.fetchNextPage()}/></>}</section>;
}
