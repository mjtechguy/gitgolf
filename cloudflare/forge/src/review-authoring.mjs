import { ownerSlug } from './owners.mjs';
import { digest, uuidOK, deny, invalid, Fault } from './common.mjs';
import { sha } from './git.mjs';
import { pullReviewContext, review, completeReviewRequest } from './collaboration.mjs';
import { reviewAuthority, confirmReviewAuthority } from './pull-reviews.mjs';
import { discussionEvent } from './discussion-engagement.mjs';
export const reviewAuthoringMethods=new Set(['GetPullReviewAuthoringState','SubmitPullReviewAuthoringOperation','GetPullReviewAuthoringOperation']);
const kinds=['UNSPECIFIED','CREATE_DRAFT','CREATE_FROM_PRIVATE_DRAFT','UPDATE_DRAFT','SUBMIT_DRAFT','DISCARD_DRAFT','EDIT_COMMENT','DELETE_COMMENT','APPEND_FROM_PRIVATE_DRAFT'];
const decisions=['UNSPECIFIED','APPROVED','PENDING','COMMENT','REQUEST_CHANGES','REQUEST_REVIEW'];
const revisionOK=v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
const idOK=v=>typeof v==='string'&&/^[1-9][0-9]{0,15}$/.test(v)&&Number.isSafeInteger(Number(v));
const phase=value=>'DISCUSSION_RESOURCE_OPERATION_PHASE_'+value;
async function state(db,env,person,row,target,body,artifact) {
 const {d,current}=await pullReviewContext(db,env,person,row,target,artifact);
 const version=(await db.prepare('SELECT version FROM pull_review_draft_versions WHERE pull_request_id=? AND author_id=?').bind(d.pull_id,person.id).first())?.version||0;
 const pending=await db.prepare("SELECT r.*,a.status AS draft_status,a.updated_at AS draft_updated_at FROM pull_reviews r JOIN pull_review_drafts a ON a.review_id=r.id WHERE a.pull_request_id=? AND a.author_id=? AND a.status='PENDING'").bind(d.pull_id,person.id).first();
 let selected=pending;
 if(body.reviewId) {
  if(!idOK(body.reviewId)||!sha(body.reviewCommitId)) invalid('Use the selected pending review and commit.');
  selected=await db.prepare("SELECT r.*,a.status AS draft_status,a.updated_at AS draft_updated_at FROM pull_reviews r JOIN pull_review_drafts a ON a.review_id=r.id WHERE r.id=? AND a.pull_request_id=? AND a.author_id=? AND a.status='PENDING' AND r.head_commit=?").bind(body.reviewId,d.pull_id,person.id,body.reviewCommitId).first();
  if(!selected) deny();
 } else if(body.reviewCommitId) invalid('Choose a review before a review commit.');
 const value=selected?await review(db,env,row,d,selected,current):undefined;
 const open=!row.write_pending&&d.state==='OPEN'&&!d.draft&&!current.base.retainedSnapshot&&!current.head.retainedSnapshot;
 const exact=open&&value&&!value.stale;
 const snapshot=await digest(JSON.stringify(['native.review-authoring.v1',row.id,row.artifact_name,d.pull_id,person.id,version,selected?.id||0]));
 return {d,current,version,selected,response:{target,pullRevision:current.revision,snapshotRevision:snapshot,currentHeadCommitId:current.head.commitId,...(value?{review:value}:{}),comments:[],canCreate:open&&!pending,canUpdate:Boolean(exact),canSubmit:Boolean(exact),canDiscard:Boolean(selected&&!row.write_pending),ownPending:Boolean(selected)}};
}
export async function reviewAuthoring(db,env,person,row,request,method,body,artifact) {
 if(request.headers.has('Authorization')||request.headers.has('CF-Access-Client-Id')||request.headers.has('CF-Access-Client-Secret')||!request.headers.get('X-Golf-Native-Access-Email')) deny();
 const target=body.target;
 if(target?.repository?.owner!==ownerSlug(row,env)||target?.repository?.name!==row.name||target?.repositoryId!==String(row.id)||!idOK(target?.pullRequestId)||!Number.isInteger(target.number)||target.number<1) deny();
 if(body.commentId||body.golfDraftId||body.expectedDraftVersion||body.expectedTargetGeneration) invalid('Saved inline drafts and comment editing are not supported by this native authoring adapter.');
 const submit=method==='SubmitPullReviewAuthoringOperation',lookup=method==='GetPullReviewAuthoringOperation';
 let original,hash,kind,decision;
 if(submit||lookup) {
  if(!uuidOK(body.operationId)) invalid('Use the original UUID v4 operation ID.');
  if(submit) {
   kind=typeof body.kind==='number'?kinds[body.kind]:body.kind?.replace('PULL_REVIEW_AUTHORING_KIND_','');
   decision=body.decision===undefined?'UNSPECIFIED':typeof body.decision==='number'?decisions[body.decision]:body.decision?.replace('PULL_REQUEST_REVIEW_STATE_','');
   if(!['CREATE_DRAFT','UPDATE_DRAFT','SUBMIT_DRAFT','DISCARD_DRAFT'].includes(kind)||!revisionOK(body.expectedPullRevision)||!revisionOK(body.expectedSnapshotRevision)|| (kind==='CREATE_DRAFT'?(body.reviewId||body.reviewCommitId):!idOK(body.reviewId)||!sha(body.reviewCommitId))) invalid('Use a supported pending-review action and observed revisions.');
   if(kind==='SUBMIT_DRAFT'?!['COMMENT','APPROVED','REQUEST_CHANGES'].includes(decision):decision!=='UNSPECIFIED') invalid('Choose a review decision only when publishing.');
   const text=body.body===undefined?'':body.body;
   if(typeof text!=='string'||new TextEncoder().encode(text).length>6000||/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(text)||new TextDecoder().decode(new TextEncoder().encode(text))!==text|| (kind==='DISCARD_DRAFT'?(text||body.bodyHash):body.bodyHash!==await digest(text)||!text.trim()&&!(kind==='SUBMIT_DRAFT'&&decision==='APPROVED'))) invalid('Use review text up to 6,000 UTF-8 bytes with its SHA256.');
   original={target:{repository:{owner:ownerSlug(row,env),name:row.name},repositoryId:target.repositoryId,pullRequestId:target.pullRequestId,number:target.number},kind:'PULL_REVIEW_AUTHORING_KIND_'+kind,reviewId:body.reviewId||'',reviewCommitId:body.reviewCommitId||'',expectedPullRevision:body.expectedPullRevision,expectedSnapshotRevision:body.expectedSnapshotRevision,bodyHash:body.bodyHash||'',decision:'PULL_REQUEST_REVIEW_STATE_'+decision,operationId:body.operationId};
   hash=await digest(JSON.stringify(original));
  }
  const saved=await db.prepare('SELECT * FROM pull_review_operations WHERE actor_id=? AND operation_id=?').bind(person.id,body.operationId).first();
  if(saved) {
   await confirmReviewAuthority(db,person,row);
   if(saved.repository_id!==row.id||String(saved.pull_request_id)!==target.pullRequestId||saved.kind!=='authoring') deny();
   const receipt=JSON.parse(saved.receipt);
   if(receipt.original.target.number!==target.number) deny();
   if(submit&&saved.input_hash!==hash) throw new Fault('already_exists',409,'Operation ID belongs to different review inputs.');
   return {operation:receipt};
  }
  if(lookup) deny();
 }
 const s=await state(db,env,person,row,target,body,artifact);await confirmReviewAuthority(db,person,row);
 if(!submit) return s.response;
 const valid=s.response.pullRevision===body.expectedPullRevision&&s.response.snapshotRevision===body.expectedSnapshotRevision&&s.response[{CREATE_DRAFT:'canCreate',UPDATE_DRAFT:'canUpdate',SUBMIT_DRAFT:'canSubmit',DISCARD_DRAFT:'canDiscard'}[kind]]&&!(kind==='SUBMIT_DRAFT'&&decision!=='COMMENT'&&s.d.author_id===person.id);
 const reviewId=kind==='CREATE_DRAFT'?(await db.prepare("SELECT max(COALESCE((SELECT max(id) FROM pull_reviews),0),COALESCE((SELECT seq FROM sqlite_sequence WHERE name='pull_reviews'),0))+1 AS id").first()).id:s.selected.id;
 const time=new Date().toISOString(),base={contract:'golf.pull.review-authoring.v1',original,actorId:String(person.id),createdAt:time,updatedAt:time};
 const success={...base,phase:phase('SUCCEEDED'),observedReviewId:String(reviewId),failureCode:''},refused={...base,phase:phase('REJECTED'),failureCode:'preflight_refused'};
 const guard=reviewAuthority(person,row,s.d);
 // Discard is permitted after the PR closes; source-bound publication is not.
 if(kind==='DISCARD_DRAFT') guard.sql=guard.sql.replace(" AND state='OPEN'",'');
 const statements=[db.prepare(`INSERT INTO pull_review_operations(actor_id,operation_id,repository_id,pull_request_id,kind,input_hash,receipt)
  SELECT ?,?,?,?,'authoring',?,CASE WHEN ? AND ${guard.sql} AND COALESCE((SELECT version FROM pull_review_draft_versions WHERE pull_request_id=? AND author_id=?),0)=? THEN ? ELSE ? END`)
  .bind(person.id,body.operationId,row.id,s.d.pull_id,hash,valid?1:0,...guard.values,s.d.pull_id,person.id,s.version,JSON.stringify(success),JSON.stringify(refused))];
 const admitted="EXISTS(SELECT 1 FROM pull_review_operations WHERE actor_id=? AND operation_id=? AND json_extract(receipt,'$.phase')='DISCUSSION_RESOURCE_OPERATION_PHASE_SUCCEEDED')",values=[person.id,body.operationId];
 statements.push(db.prepare(`INSERT INTO pull_review_draft_versions SELECT ?,?,? WHERE ${admitted} ON CONFLICT(pull_request_id,author_id) DO UPDATE SET version=excluded.version`).bind(s.d.pull_id,person.id,s.version+1,...values));
 if(kind==='CREATE_DRAFT') {
  statements.push(db.prepare(`INSERT INTO pull_reviews(id,pull_request_id,author_id,head_commit,base_commit,state,body,created_at) SELECT ?,?,?,?,?,'COMMENT',?,? WHERE ${admitted}`).bind(reviewId,s.d.pull_id,person.id,s.current.head.commitId,s.current.base.commitId,body.body,time,...values));
  statements.push(db.prepare(`INSERT INTO pull_review_drafts SELECT ?,?,?,'PENDING',? WHERE ${admitted}`).bind(reviewId,s.d.pull_id,person.id,time,...values));
 } else {
  statements.push(db.prepare(`UPDATE pull_reviews SET body=?,state=?,created_at=CASE WHEN ? THEN ? ELSE created_at END WHERE id=? AND ${admitted}`).bind(kind==='DISCARD_DRAFT'?'':body.body||'',kind==='SUBMIT_DRAFT'?decision:'COMMENT',kind==='SUBMIT_DRAFT'?1:0,time,reviewId,...values));
  statements.push(db.prepare(`UPDATE pull_review_drafts SET status=?,updated_at=? WHERE review_id=? AND ${admitted}`).bind(kind==='SUBMIT_DRAFT'?'PUBLISHED':kind==='DISCARD_DRAFT'?'DISCARDED':'PENDING',time,reviewId,...values));
 }
 // Private pending text never generates shared timeline, notifications or webhooks.
 if(kind==='SUBMIT_DRAFT') statements.push(...completeReviewRequest(db,person,s.d.pull_id,admitted,values),...discussionEvent(db,person,s.d.id,time,'review_'+decision.toLowerCase(),{},admitted,values));
 await db.batch(statements);await confirmReviewAuthority(db,person,row);
 return {operation:JSON.parse((await db.prepare('SELECT receipt FROM pull_review_operations WHERE actor_id=? AND operation_id=?').bind(...values).first()).receipt)};
}
