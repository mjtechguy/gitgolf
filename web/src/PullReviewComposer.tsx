import { useLayoutEffect, useRef, useState } from 'react';
import { useForm, useStore } from '@tanstack/react-form';
import { useQueryClient } from '@tanstack/react-query';
import { Code, ConnectError } from '@connectrpc/connect';
import { Check, GitPullRequest, LoaderCircle, MessageSquare, ShieldAlert, X } from 'lucide-react';
import { repositoryClient, errorMessage } from './api';
import { forgetPrivateQueries } from './queryClient';
import { MarkdownBody } from './RepositoryContent';
import { IssueMutationState, IssueState, PullRequestReviewState } from './gen/golf/v1/golf_pb';
import type { PullRequest, RepositoryKey, User, PullRequestReviewMutation, GetPullRequestReviewMutationResponse, CreatePullRequestReviewRequest } from './gen/golf/v1/golf_pb';
import { readReviewIntent, reviewIntentKey } from './reviewIntents';
import type { ReviewIntent } from './reviewIntents';

type Props={repositoryKey:Pick<RepositoryKey,'owner'|'name'>;repositoryId:string;userId:string;pull:PullRequest;blocked:boolean;onClose:()=>void;onCurrentSelection:()=>void;onReviewed:()=>void};
const labels={ [PullRequestReviewState.COMMENT]:'Comment', [PullRequestReviewState.APPROVED]:'Approve', [PullRequestReviewState.REQUEST_CHANGES]:'Request changes' };
export function PullReviewComposer({repositoryKey,repositoryId,userId,pull,blocked,onClose,onCurrentSelection,onReviewed}:Props){
 const original=useRef(pull);const client=useQueryClient();const storageKey=reviewIntentKey(userId,repositoryId,pull.id);
 const [intent,setIntent]=useState(()=>readReviewIntent(storageKey,repositoryId,pull.id,pull.number));
 const [record,setRecord]=useState<PullRequestReviewMutation|null>(null);const [confirmed,setConfirmed]=useState(false);
 const [error,setError]=useState<Error|null>(null);const [busy,setBusy]=useState(false);const [preview,setPreview]=useState(false);const [accessDenied,setAccessDenied]=useState(false);
 const form=useForm({defaultValues:{body:'',state:PullRequestReviewState.COMMENT},onSubmit:()=>submit()});
 const {body,state}=useStore(form.store,s=>s.values);
 const frozen=useRef<CreatePullRequestReviewRequest|null>(null);const controller=useRef<AbortController|null>(null);const generation=useRef(0);const mounted=useRef(false);const latch=useRef(false);
 const input=useRef<HTMLTextAreaElement>(null);const status=useRef<HTMLButtonElement>(null);
 const active=(version:number)=>mounted.current&&version===generation.current&&client.getQueryData<User|null>(['session'])?.id===userId;
 const changed=original.current.id!==pull.id||original.current.revision!==pull.revision||original.current.base?.commitId!==pull.base?.commitId||original.current.head?.commitId!==pull.head?.commitId;
 const verifiedSelection=/^[0-9a-f]{64}$/.test(pull.revision)&&/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(pull.base?.commitId||'')&&/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(pull.head?.commitId||'')&&pull.base?.commitId.length===pull.head?.commitId.length;
 const decisionsAllowed=pull.state===IssueState.OPEN&&!pull.merged&&!pull.draft&&pull.user?.id!==userId;
 useLayoutEffect(()=>{mounted.current=true;if(intent)status.current?.focus();else input.current?.focus();const clear=()=>{generation.current++;controller.current?.abort();frozen.current=null;};window.addEventListener('pagehide',clear);return()=>{mounted.current=false;clear();window.removeEventListener('pagehide',clear);};},[]);
 function observe(response:Pick<GetPullRequestReviewMutationResponse,'mutation'|'review'>,pending:ReviewIntent){
  const v=response.mutation;
  if(!v||v.idempotencyKey!==pending.key||v.repositoryId!==repositoryId||v.pullRequestId!==pending.pullRequestId||v.number!==pending.number||v.repository?.owner!==repositoryKey.owner||v.repository?.name!==repositoryKey.name||v.headCommitId!==pending.headCommitId||v.reviewState!==pending.state||![IssueMutationState.OUTCOME_UNKNOWN,IssueMutationState.REJECTED,IssueMutationState.SUCCEEDED].includes(v.state))throw new ConnectError('The review outcome does not match this request. Keep its key and check again.',Code.FailedPrecondition);
  const review=response.review;
  if(v.state===IssueMutationState.SUCCEEDED&&review&&(review.id!==v.observedReviewId||!(/^[1-9][0-9]{0,18}$/.test(review.id))||BigInt(review.id)>9223372036854775807n||review.user?.id!==userId||review.state!==pending.state||review.commitId!==pending.headCommitId||review.commentsCount!==0||frozen.current&&review.body!==frozen.current.body))throw new ConnectError('The returned review does not match the recorded outcome. Keep its key and check again.',Code.FailedPrecondition);
  setRecord(v);
  if(v.state===IssueMutationState.SUCCEEDED&&review){setConfirmed(true);form.setFieldValue('body','');frozen.current=null;try{sessionStorage.removeItem(storageKey);}catch{/* A repeated lookup can inspect the durable result. */}onReviewed();}
 }
 async function send(pending:ReviewIntent,inspect:boolean){
  const version=++generation.current;latch.current=true;setBusy(true);setError(null);controller.current=new AbortController();
  try{const options={signal:controller.current.signal,timeoutMs:inspect?8000:15000};const response=inspect?await repositoryClient.getPullRequestReviewMutation({idempotencyKey:pending.key},options):await repositoryClient.createPullRequestReview(frozen.current!,options);if(active(version))observe(response,pending);}
  catch(failure){if(!active(version))return;const value=failure instanceof Error?failure:new Error('Review outcome unavailable.');setError(value);if(value instanceof ConnectError&&[Code.PermissionDenied,Code.NotFound,Code.Unauthenticated].includes(value.code)){setAccessDenied(true);form.setFieldValue('body','');frozen.current=null;if(value.code===Code.Unauthenticated){client.setQueryData(['session'],null);forgetPrivateQueries(client);}}}
  finally{if(active(version)){latch.current=false;controller.current=null;setBusy(false);}}
 }
 function submit(){
  if(intent||latch.current||blocked||changed||accessDenied||!verifiedSelection)return;
  if(state!==PullRequestReviewState.COMMENT&&!decisionsAllowed){setError(new Error('Only comments are available for this pull request. No request was sent.'));return;}
  const bytes=new TextEncoder().encode(body);
  if((state!==PullRequestReviewState.APPROVED&&!body.trim())||bytes.byteLength>6000||new TextDecoder().decode(bytes)!==body||/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u.test(body)){setError(new Error('Use valid review text up to 6,000 UTF-8 bytes. Comments and change requests need a summary. No request was sent.'));return;}
  const target=original.current;
  if(!target.head?.commitId||!target.base?.commitId)return;
  try{const pending:ReviewIntent={key:crypto.randomUUID(),repositoryId,pullRequestId:target.id,number:target.number,headCommitId:target.head.commitId,state};sessionStorage.setItem(storageKey,JSON.stringify(pending));frozen.current={$typeName:'golf.v1.CreatePullRequestReviewRequest',repository:{$typeName:'golf.v1.RepositoryKey',...repositoryKey},repositoryId,pullRequestId:target.id,number:target.number,expectedRevision:target.revision,baseCommitId:target.base.commitId,headCommitId:target.head.commitId,state,body,idempotencyKey:pending.key};setIntent(pending);void send(pending,false);}catch{setError(new Error('Golf needs secure random IDs and writable tab storage before submitting. No request was sent.'));}
 }
 function close(){if(!intent&&body&& !window.confirm('Discard this unsent review?'))return;onClose();}
 const rejected=record?.state===IssueMutationState.REJECTED;
 return <section className="browser-panel pull-review-composer" aria-label="Review changes">
  <div className="browser-panel-heading"><h2><GitPullRequest size={17}/>Review changes</h2><button type="button" className="icon-button" aria-label="Close review editor" title="Close review editor" onClick={close}><X size={17}/></button></div>
  <div className="issue-edit-content"><p className="field-help">Reviewing commit <code>{intent?.headCommitId||original.current.head?.commitId}</code>. Overall reviews publish immediately. Saved private drafts are separate and are not included.</p>
   {changed&&!intent?<p className="session-notice" role="status">This pull request changed while you were writing. Your original draft is preserved. Review the current selection before submitting.</p>:null}
   {!verifiedSelection&&!intent?<p className="field-help" role="status">The current pull request selection could not be verified. Review submission is unavailable.</p>:null}
   {blocked?<p className="field-help" role="status">Checking current pull request access…</p>:null}
   {confirmed?<p className="session-notice" role="status"><Check size={16}/>Review submitted. This record does not establish merge readiness.</p>:null}
   {!confirmed?<form onSubmit={e=>{e.preventDefault();void form.handleSubmit();}}>
    <label htmlFor="pull-review-summary">Review summary, Markdown</label><div className="content-view-controls" aria-label="Review summary view"><button type="button" className={`text-button ${!preview?'active':''}`} aria-pressed={!preview} onClick={()=>setPreview(false)}>Write</button><button type="button" className={`text-button ${preview?'active':''}`} aria-pressed={preview} onClick={()=>setPreview(true)}>Preview Markdown</button></div>
    <textarea ref={input} id="pull-review-summary" hidden={preview} rows={5} maxLength={6000} autoComplete="off" value={body} disabled={Boolean(intent)||accessDenied} onChange={e=>form.setFieldValue('body',e.target.value)}/>{preview?<MarkdownBody text={body||'Nothing to preview.'} label="Review summary preview"/>:null}
    {!intent&&!accessDenied?<fieldset className="review-decisions"><legend>Review decision</legend>{([PullRequestReviewState.COMMENT,PullRequestReviewState.APPROVED,PullRequestReviewState.REQUEST_CHANGES] as const).filter(value=>value===PullRequestReviewState.COMMENT||decisionsAllowed).map(value=><label key={value}><input type="radio" name="review-decision" value={value} checked={state===value} onChange={()=>form.setFieldValue('state',value)}/>{value===PullRequestReviewState.APPROVED?<Check size={16}/>:value===PullRequestReviewState.REQUEST_CHANGES?<ShieldAlert size={16}/>:<MessageSquare size={16}/>}<span>{labels[value]}</span></label>)}</fieldset>:null}
    {!decisionsAllowed&&!intent?<p className="field-help">Comments are available. Approval and change requests require an open, ready pull request from another author.</p>:null}
    {intent?<div className="creation-status" role="status"><p>{record?.state===IssueMutationState.SUCCEEDED?'Submission succeeded, but current access to the review could not be confirmed. This receipt does not grant access.':rejected?'The review was rejected. No replacement request will be sent automatically.':busy?'Checking this review request… Its outcome may still be unknown.':'The review may still be running, or its outcome is unknown. Check status; do not submit a replacement.'}</p>{record?.failureCode==='pending_review'?<p>Inspect your existing native draft review before creating another review.</p>:null}<p className="field-help">Requested decision: {labels[intent.state as keyof typeof labels]} · Request key <code>{intent.key}</code></p>{!frozen.current?<p className="field-help">Review text was not saved. This resumed request supports status inspection only.</p>:null}<p className="field-help">Closing this editor does not cancel an accepted review submission.</p></div>:null}
    {error?<p className="error" role="alert">{errorMessage(error)}</p>:null}
    <div className="dialog-actions"><button type="button" className="button secondary" onClick={close}>{intent?'Close':'Cancel'}</button>{intent?<><button ref={status} type="button" className="button secondary" disabled={busy} onClick={()=>{if(!latch.current)void send(intent,true);}}>{busy?<LoaderCircle size={16} className="spin"/>:null}Check review status</button>{rejected&&!accessDenied?<button type="button" className="button primary" disabled={busy||blocked} onClick={()=>{try{sessionStorage.removeItem(storageKey);}catch{setError(new Error('The pending key could not be cleared. No new request was sent.'));return;}onCurrentSelection();}}>Review current selection</button>:null}</>:changed?<button type="button" className="button primary" disabled={blocked} onClick={()=>{if(!body||window.confirm('Discard this unsent review and review the current selection?'))onCurrentSelection();}}>Review current selection</button>:<button className="button primary" disabled={blocked||accessDenied||busy||!verifiedSelection||state!==PullRequestReviewState.APPROVED&&!body.trim()}>Submit review</button>}</div>
   </form>:<div className="dialog-actions"><button type="button" className="button secondary" onClick={onClose}>Done</button></div>}
  </div>
 </section>;
}
