import {PullReviewAuthoring} from "./PullReviewAuthoring";
import {PullReviewCommentResolution} from './PullReviewCommentResolution';
import { useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Code, ConnectError } from '@connectrpc/connect';
import { ExternalLink, FileCode, MessageSquare, RefreshCw, UserRound } from 'lucide-react';
import { repositoryClient, repositoryLink } from './api';
import { MarkdownBody } from './RepositoryContent';
import { DateLabel, Loading, PanelError, privateQuery, shortSHA } from './RepositoryUI';
import { PullRequestReviewState } from './gen/golf/v1/golf_pb';
import type { GetPullRequestReviewCommentsResponse, PullRequest, PullRequestReview, PullRequestReviewComment, RepositoryKey, User } from './gen/golf/v1/golf_pb';

type Props = {repositoryKey:Pick<RepositoryKey,'owner'|'name'>;repositoryId:string;userId:string;queryKey:readonly unknown[];pull:PullRequest;review:PullRequestReview};
const validID=(value:string)=>/^[1-9][0-9]{0,18}$/.test(value)&&BigInt(value)<=9223372036854775807n;
const validCommit=(value:string)=>/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(value);
const text=(value:string,max:number)=>new TextEncoder().encode(value).byteLength<=max&&new TextDecoder().decode(new TextEncoder().encode(value))===value&&!/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u.test(value);
const path=(value:string)=>Boolean(value)&&new TextEncoder().encode(value).byteLength<=4096&&!/[\p{Cc}\\]/u.test(value)&&!value.startsWith('/')&&!value.endsWith('/')&&value.split('/').every(part=>part&&part!=='.'&&part!=='..');
const published=(value:PullRequestReviewState)=>[PullRequestReviewState.COMMENT,PullRequestReviewState.APPROVED,PullRequestReviewState.REQUEST_CHANGES].includes(value);
const readable=(review:PullRequestReview,userId:string)=>published(review.state)||review.state===PullRequestReviewState.PENDING&&review.user?.id===userId;
function validate(response:GetPullRequestReviewCommentsResponse,props:Props){
 const review=response.review;
 if(response.repositoryId!==props.repositoryId||response.pullRequestId!==props.pull.id||!review||review.id!==props.review.id||review.commitId!==props.review.commitId||response.currentHeadCommitId!==''&&!validCommit(response.currentHeadCommitId)||!readable(review,props.userId)||response.comments.length>100||review.commentsCount!==response.comments.length)throw new ConnectError('Inline comments do not match this selected review. No comments are shown.',Code.FailedPrecondition);
 const ids=new Set<string>();
 for(const comment of response.comments){
  const position=(comment.oldLine>0)!==(comment.newLine>0);
  if(!validID(comment.id)||comment.replyToCommentId&&!validID(comment.replyToCommentId)||ids.has(comment.id)||comment.reviewId!==review.id||!path(comment.path)||!position||!Number.isInteger(comment.oldLine)||!Number.isInteger(comment.newLine)||comment.oldLine<0||comment.newLine<0||comment.oldLine>2147483647||comment.newLine>2147483647||!text(comment.body,256*1024)||!text(comment.diffHunk,64*1024)||comment.commitId&&!validCommit(comment.commitId)||comment.originalCommitId&&!validCommit(comment.originalCommitId)||!comment.createdAt||!Number.isFinite(Date.parse(comment.createdAt))||comment.updatedAt&&!Number.isFinite(Date.parse(comment.updatedAt)))throw new ConnectError('An inline comment exceeds the supported bounds or has invalid identity or position. No comments are shown.',Code.FailedPrecondition);
  ids.add(comment.id);
 }
 return response;
}
function Avatar({user}:{user?:User}){
 const source=repositoryLink(user?.avatarUrl||'');const [failed,setFailed]=useState(false);
 return source&&!failed?<img className="review-comment-avatar" src={source} width={24} height={24} alt="" loading="lazy" decoding="async" referrerPolicy="no-referrer" onError={()=>setFailed(true)}/>:<UserRound className="review-comment-avatar" size={24} aria-hidden="true"/>;
}
function Comment({comment,response,props,refresh}:{comment:PullRequestReviewComment;response:GetPullRequestReviewCommentsResponse;props:Props;refresh:()=>void}){
 const external=repositoryLink(comment.htmlUrl);const coordinate=`${comment.oldLine?'Old':'New'} line ${comment.oldLine||comment.newLine}`;
 return <article className="issue-comment review-inline-comment" aria-label={`Inline comment ${comment.id}`}>
  <header className="issue-comment-heading"><div className="issue-comment-byline"><Avatar key={comment.user?.avatarUrl} user={comment.user}/><h3>{comment.user?.login||'Deleted or unavailable author'}</h3><span>commented <DateLabel value={comment.createdAt}/></span>{comment.updatedAt&&comment.updatedAt!==comment.createdAt?<span>· edited <DateLabel value={comment.updatedAt}/></span>:null}</div>{external?<a className="icon-button" href={external} target="_blank" rel="noopener noreferrer" aria-label={`Open original inline comment ${comment.id}`} title="Open original comment"><ExternalLink size={14} aria-hidden="true"/></a>:null}</header>
  <div className="review-comment-location"><FileCode size={15} aria-hidden="true"/><code>{comment.path}</code>{comment.resolved?<span className="visibility">Comment resolved</span>:null}<span className="visibility">{coordinate}</span>{comment.replyToCommentId?<span className="visibility">Reply to #{comment.replyToCommentId}</span>:null}</div>
  {response.review?.state!==PullRequestReviewState.PENDING?<PullReviewCommentResolution repository={props.repositoryKey} repositoryId={props.repositoryId} userId={props.userId} pull={props.pull} reviewId={props.review.id} reviewCommitId={props.review.commitId} comment={comment} onChanged={refresh}/>:null}
  <PullReviewAuthoring target={{$typeName:"golf.v1.PullReviewDraftTarget",repository:{$typeName:"golf.v1.RepositoryKey",...props.repositoryKey},repositoryId:props.repositoryId,pullRequestId:props.pull.id,number:props.pull.number}} userId={props.userId} pull={props.pull} review={response.review} comment={comment} onChanged={refresh}/>
  <MarkdownBody text={comment.body||'No comment text provided.'} label={`Inline comment ${comment.id} body, rendered Markdown`}/>
  <details className="metadata-details review-comment-details"><summary>Comment details</summary><dl className="review-metadata"><div><dt>Comment ID</dt><dd><code>{comment.id}</code></dd></div><div><dt>Review commit</dt><dd><code>{response.review?.commitId}</code></dd></div>{comment.commitId?<div><dt>Line / blame commit</dt><dd><code>{comment.commitId}</code></dd></div>:null}{comment.originalCommitId?<div><dt>Native original commit</dt><dd><code>{comment.originalCommitId}</code></dd></div>:null}{comment.resolved?<div><dt>Native resolver</dt><dd>{comment.resolver?.login||'Deleted or unavailable resolver'}</dd></div>:null}</dl>{comment.resolved?<p className="field-help">This comment has a native resolver record. It does not establish resolution of every comment at this location.</p>:null}{comment.diffHunk?<details className="metadata-details"><summary>Recorded diff context</summary><pre className="source-preview" tabIndex={0} aria-label={`Recorded diff context for comment ${comment.id}`}><code>{comment.diffHunk}</code></pre></details>:null}</details>
 </article>;
}
function CommentsRead(props:Props){
 const {repositoryKey,repositoryId,userId,queryKey,pull,review}=props;const client=useQueryClient();const active=useRef(true);
 const prefix=JSON.stringify(queryKey);
 const key=useMemo(()=>[...queryKey,'pull',pull.number,'review-comments',repositoryId,pull.id,review.id,review.commitId],[prefix,repositoryId,pull.id,pull.number,review.id,review.commitId]);
 useLayoutEffect(()=>{active.current=true;return()=>{active.current=false;void client.cancelQueries({queryKey:key,exact:true});};},[client,key]);
 const query=useQuery({...privateQuery,retry:false,queryKey:key,queryFn:async({signal})=>{const response=await repositoryClient.getPullRequestReviewComments({repository:repositoryKey,repositoryId,pullRequestId:pull.id,number:pull.number,reviewId:review.id,reviewCommitId:review.commitId},{signal,timeoutMs:8000});if(!active.current||client.getQueryData<User|null>(['session'])?.id!==userId)throw new ConnectError('This comment read belongs to an inactive account or selection.',Code.Canceled);return validate(response,props);}});

 return <section className="review-inline-comments" aria-label={`Inline comments for review ${review.id}`}>
  {query.isError?<PanelError error={query.error} retry={()=>void query.refetch()}/>:!query.isSuccess||query.isFetching?<Loading label="Reading inline comments…"/>:<><div className="review-inline-summary">{query.data.review?.state===PullRequestReviewState.PENDING?<span className="visibility">Private pending review</span>:null}<span>{query.data.comments.length} inline {query.data.comments.length===1?'comment':'comments'}</span><span className="visibility">{!query.data.currentHeadCommitId?'Current snapshot unavailable':query.data.review?.commitId===query.data.currentHeadCommitId?'Current observed head':'Earlier snapshot'}</span>{query.data.review?.stale?<span className="visibility">Outdated</span>:null}{query.data.review?.dismissed?<span className="visibility">Dismissed</span>:null}<button type="button" className="icon-button" aria-label={`Refresh inline comments for review ${review.id}`} title="Refresh inline comments" onClick={()=>void query.refetch()}><RefreshCw size={15}/></button></div>
   {query.data.comments.length?<ol className="issue-comment-list review-inline-list">{query.data.comments.map(comment=><li key={comment.id}><Comment comment={comment} response={query.data} props={props} refresh={()=>void query.refetch()}/></li>)}</ol>:<p className="panel-footnote">No inline comments are visible in this current review observation.</p>}
   <details className="metadata-details review-comments-observation"><summary>About this comment observation</summary><p className="field-help">Review commit <code>{shortSHA(review.commitId)}</code> · observed PR head <code>{query.data.currentHeadCommitId?shortSHA(query.data.currentHeadCommitId):'Unavailable'}</code>. Comments are grouped by their native review; reply parents are shown only for verified Golf replies with both comments still visible. External reply ancestry and complete thread resolution state are unavailable. Native line/blame commits do not establish the reviewed snapshot. The observed head is not an atomic snapshot or merge readiness check.</p></details>
  </>}
 </section>;
}
export function PullReviewComments(props:Props){
 const [show,setShow]=useState(false);const id=useId();
 if(!props.review.commentsCount||!readable(props.review,props.userId)||!validID(props.repositoryId)||!validID(props.pull.id)||!validID(props.review.id)||!validCommit(props.review.commitId))return null;
 return <div className="review-comments-control"><button type="button" className="text-button" aria-expanded={show} aria-controls={id} onClick={()=>setShow(value=>!value)}><MessageSquare size={15} aria-hidden="true"/>{show?'Hide':'Show'} inline comments ({props.review.commentsCount})</button><div id={id}>{show?<CommentsRead {...props}/>:null}</div></div>;
}
