import { digest, uuidOK, deny, invalid, Fault, user } from './common.mjs';
import { sha } from './git.mjs';
import { pullReviewContext, review } from './collaboration.mjs';
import { discussionEvent } from './discussion-engagement.mjs';
import { branchLockObservation } from './repository-rules.mjs';

export async function pullMergeObservation(db,env,person,row,body,artifact) {
  const selected=body.selection;
  if(!selected || !sha(selected.headCommitId) || !sha(selected.baseCommitId) || !/^[a-f0-9]{64}$/.test(body.expectedPullRevision||'')) invalid('Select the exact pull request comparison and revision.');
  const {current}=await pullReviewContext(db,env,person,row,selected,artifact);
  if(current.revision!==body.expectedPullRevision || current.head.commitId!==selected.headCommitId || current.base.commitId!==selected.baseCommitId) throw new Fault('failed_precondition',412,'The pull request changed. Refresh before inspecting it.');
  const rule=await branchLockObservation(db,row,current.base.ref);
  const source=current.head.retainedSnapshot?{}:{sourceRepository:{owner:env.WORKSPACE_SLUG,name:row.name},sourceRepositoryId:String(row.id),sourceOwnerId:String(row.workspace_id),source:{kind:'REPOSITORY_SOURCE_REF_KIND_BRANCH',name:current.head.ref,commitId:current.head.commitId}};
  const observation={selection:selected,pullRevision:current.revision,targetOwnerId:String(row.workspace_id),...source,
    ...(current.base.retainedSnapshot?{}:{base:{kind:'REPOSITORY_SOURCE_REF_KIND_BRANCH',name:current.base.ref,commitId:current.base.commitId},nativeCallerCanMerge:false}),
    targetProtection:'PULL_MERGE_TARGET_PROTECTION_'+(current.base.retainedSnapshot?'UNKNOWN':rule.locked?'PROTECTED':'UNPROTECTED'),
    currentTargetWriter:['write','admin'].includes(row.role),sourceState:'PULL_MERGE_SOURCE_STATE_'+(current.head.retainedSnapshot?'RETAINED_ONLY':'CURRENT'),
    mergeConfiguration:{defaultMergeStyle:'merge',defaultUpdateStyle:'merge'},unavailableReason:'protected_integration_unqualified'};
  observation.fingerprint=await digest(JSON.stringify(['native.merge-observation.v1',row.artifact_name,row.access_version,rule.version,Boolean(row.write_pending),observation]));
  observation.observedAt=new Date().toISOString();
  await confirmReviewAuthority(db,person,row);
  return {observation};
}

export const pullReviewMethods = new Set(['GetPullCodeOwners','GetPullReviewRequests','GetPullReviewTeamCandidates','SubmitPullReviewRequest','GetPullReviewRequestOperation','GetPullReviewLifecycleState','SubmitPullReviewLifecycle','GetPullReviewLifecycleOperation']);
const revisionOK = value => typeof value==='string' && /^[a-f0-9]{64}$/.test(value);
const idOK = value => typeof value==='string' && /^[1-9][0-9]{0,15}$/.test(value) && Number.isSafeInteger(Number(value));
const active = (row,d,current) => !row.write_pending && d.state==='OPEN' && !d.draft && !current.base.retainedSnapshot && !current.head.retainedSnapshot;
const canRequest = (row,d,person) => row.role==='admin' || row.role==='write' || d.author_id===person.id;
const phase = value => 'DISCUSSION_RESOURCE_OPERATION_PHASE_'+value;

// Fence identity and access ABA changes, role changes, source writes and PR edits in the effect transaction.
export function reviewAuthority(person,row,d) {
  return {sql:`EXISTS(SELECT 1 FROM repositories r JOIN grants g ON g.repository_id=r.id JOIN users u ON u.id=g.user_id
    WHERE r.id=? AND r.artifact_name=? AND r.state='ACTIVE' AND r.write_pending IS NULL AND g.user_id=? AND g.role=? AND u.active=1)
    AND COALESCE((SELECT version FROM repository_access_versions WHERE repository_id=?),0)=?
    AND COALESCE((SELECT version FROM native_identity_versions WHERE user_id=?),0)=?
    AND EXISTS(SELECT 1 FROM discussions WHERE id=? AND repository_id=? AND revision=? AND state='OPEN')`,
    values:[row.id,row.artifact_name,person.id,row.role,row.id,row.access_version,person.id,person.identity_version,d.id,row.id,d.revision]};
}
export async function confirmReviewAuthority(db,person,row) {
  if (!await db.prepare(`SELECT 1 FROM repositories r JOIN grants g ON g.repository_id=r.id JOIN users u ON u.id=g.user_id
    WHERE r.id=? AND r.artifact_name=? AND r.state='ACTIVE' AND g.user_id=? AND g.role=? AND u.active=1
    AND COALESCE((SELECT version FROM native_identity_versions WHERE user_id=u.id),0)=?
    AND COALESCE((SELECT version FROM repository_access_versions WHERE repository_id=r.id),0)=?
    ${person.credential_digest?'AND EXISTS(SELECT 1 FROM credentials WHERE digest=? AND user_id=? AND revoked=0 AND expires_at>unixepoch())':''}`)
    .bind(row.id,row.artifact_name,person.id,row.role,person.identity_version,row.access_version,...(person.credential_digest?[person.credential_digest,person.id]:[])).first()) deny();
}
async function requests(db,row,d) {
  const version=(await db.prepare('SELECT version FROM pull_review_versions WHERE pull_request_id=?').bind(d.pull_id).first())?.version||0;
  const {results}=await db.prepare(`SELECT u.*,COALESCE(p.full_name,u.full_name) AS full_name FROM pull_review_requests a
    JOIN users u ON u.id=a.user_id JOIN grants g ON g.user_id=u.id AND g.repository_id=?
    LEFT JOIN profiles p ON p.user_id=u.id WHERE a.pull_request_id=? AND u.active=1
    AND a.identity_version=COALESCE((SELECT version FROM native_identity_versions WHERE user_id=u.id),0)
    AND a.grant_generation=COALESCE((SELECT generation FROM collaborator_versions WHERE user_id=u.id AND repository_id=g.repository_id),0)
    ORDER BY u.id LIMIT 101`).bind(row.id,d.pull_id).all();
  if(results.length>100) throw new Fault('resource_exhausted',429,'Review request inventory exceeds 100 accounts.');
  return {version,reviewers:results.map(user),revision:await digest(JSON.stringify(['native.review-requests.v1',row.id,row.artifact_name,d.pull_id,version,row.access_version,results.map(u=>[u.id,u.login])]))};
}
async function lifecycle(db,env,person,row,d,current,body) {
  if(!idOK(body.reviewId)||!sha(body.reviewCommitId)) invalid('Use the selected review and commit.');
  const r=await db.prepare(`SELECT * FROM pull_reviews WHERE id=? AND pull_request_id=? AND head_commit=? AND NOT EXISTS(SELECT 1 FROM pull_review_drafts WHERE review_id=pull_reviews.id AND status!='PUBLISHED')`).bind(body.reviewId,d.pull_id,body.reviewCommitId).first();
  if(!r) deny();
  const state=await db.prepare('SELECT * FROM pull_review_lifecycle WHERE review_id=?').bind(r.id).first()||{version:0,dismissed:0};
  const value=await review(db,env,row,d,{...r,dismissed:state.dismissed,updated_at:state.updated_at},current);
  const latest=await db.prepare('SELECT max(id) AS id FROM pull_reviews WHERE pull_request_id=? AND author_id=? AND state IN (\'APPROVED\',\'REQUEST_CHANGES\')').bind(d.pull_id,r.author_id).first();
  const author=await db.prepare('SELECT 1 FROM grants g JOIN users u ON u.id=g.user_id WHERE g.repository_id=? AND g.user_id=? AND u.active=1').bind(row.id,r.author_id).first();
  const manage=row.role==='admin' && active(row,d,current) && ['APPROVED','REQUEST_CHANGES'].includes(r.state);
  return {r,state,review:value,canManage:manage,canRestore:manage&&Boolean(state.dismissed)&&!value.stale&&latest.id===r.id&&Boolean(author),
    revision:await digest(JSON.stringify(['native.review-lifecycle.v1',row.id,row.artifact_name,r.id,r.head_commit,r.base_commit,r.state,state.version]))};
}
export async function pullReviews(db,env,person,row,request,method,body,artifact) {
  // These are human review decisions. Operator and Git tokens do not impersonate a reviewer.
  if(request.headers.has('Authorization')||request.headers.has('CF-Access-Client-Id')||request.headers.has('CF-Access-Client-Secret')||!request.headers.get('X-Golf-Native-Access-Email')) deny();
  if(body.repositoryId!==String(row.id)||!idOK(body.pullRequestId)||!Number.isInteger(body.number)||body.number<1) deny();
  const kind=method.includes('Lifecycle')?'lifecycle':'request', submit=method.startsWith('Submit'), lookup=method.endsWith('Operation');
  let original,hash;
  if(submit||lookup) {
    if(!uuidOK(body.operationId)) invalid('Use the original UUID v4 operation ID.');
    if(submit) {
      if(!revisionOK(body.expectedPullRevision)) invalid('Use the observed pull request revision.');
      const common={repository:{owner:env.WORKSPACE_SLUG,name:row.name},repositoryId:body.repositoryId,pullRequestId:body.pullRequestId,number:body.number,expectedPullRevision:body.expectedPullRevision,operationId:body.operationId};
      if(kind==='request') {
        if(!revisionOK(body.expectedRequestsRevision)||!idOK(body.reviewerId)||typeof body.reviewerLogin!=='string'||!/^[a-z0-9][a-z0-9_-]{0,62}$/.test(body.reviewerLogin)||body.requestReview!==undefined&&typeof body.requestReview!=='boolean'||body.reviewerTeam!==undefined&&body.reviewerTeam!==false) invalid('Select an enrolled account, exact requests revision and request/cancel action. Teams are not supported.');
        original={...common,expectedRequestsRevision:body.expectedRequestsRevision,reviewerId:body.reviewerId,reviewerLogin:body.reviewerLogin,requestReview:Boolean(body.requestReview),reviewerTeam:false};
      } else {
        if(!revisionOK(body.expectedReviewRevision)||!idOK(body.reviewId)||!sha(body.reviewCommitId)||body.dismiss!==undefined&&typeof body.dismiss!=='boolean') invalid('Select the exact review and dismissal action.');
        const reason=body.reason===undefined?'':body.reason;
        if(typeof reason!=='string'||new TextEncoder().encode(reason).length>1000||/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(reason)||new TextDecoder().decode(new TextEncoder().encode(reason))!==reason|| (body.dismiss?(!reason.trim()||body.reasonHash!==await digest(reason)):(reason||body.reasonHash))) invalid('Use a dismissal reason up to 1,000 UTF-8 bytes and its SHA256.');
        original={...common,reviewId:body.reviewId,reviewCommitId:body.reviewCommitId,expectedReviewRevision:body.expectedReviewRevision,dismiss:Boolean(body.dismiss),reasonHash:body.reasonHash||''};
      }
      hash=await digest(JSON.stringify(original));
    }
    const saved=await db.prepare('SELECT * FROM pull_review_operations WHERE actor_id=? AND operation_id=?').bind(person.id,body.operationId).first();
    if(saved) {
      await confirmReviewAuthority(db,person,row);
      if(saved.repository_id!==row.id||String(saved.pull_request_id)!==body.pullRequestId||saved.kind!==kind) deny();
      const receipt=JSON.parse(saved.receipt);
      if(receipt.original.number!==body.number) deny();
      if(submit&&saved.input_hash!==hash) throw new Fault('already_exists',409,'Operation ID belongs to different review inputs.');
      return {operation:receipt};
    }
    if(lookup) deny();
  }
  const {d,current}=await pullReviewContext(db,env,person,row,body,artifact);
  if(method==='GetPullReviewTeamCandidates') {await confirmReviewAuthority(db,person,row);return {teams:[]};}
  const state=kind==='request'?await requests(db,row,d):await lifecycle(db,env,person,row,d,current,body);
  await confirmReviewAuthority(db,person,row);
  const common={repositoryId:String(row.id),pullRequestId:String(d.pull_id),number:d.number,pullRevision:current.revision};
  if(!submit) return kind==='request'?{...common,requestsRevision:state.revision,reviewers:state.reviewers,teams:[],canManage:canRequest(row,d,person)&&active(row,d,current)}:
    {...common,reviewRevision:state.revision,review:state.review,canManage:state.canManage,canRestore:state.canRestore,currentHeadCommitId:current.head.commitId};
  if(kind==='request'?!canRequest(row,d,person):row.role!=='admin') deny();
  let valid=active(row,d,current)&&body.expectedPullRevision===current.revision&&state.revision===(kind==='request'?body.expectedRequestsRevision:body.expectedReviewRevision);
  let recipient;
  if(kind==='request') {
    recipient=await db.prepare(`SELECT u.*,COALESCE(v.version,0) AS identity_version,COALESCE(c.generation,0) AS generation FROM users u
      JOIN grants g ON g.user_id=u.id AND g.repository_id=? LEFT JOIN native_identity_versions v ON v.user_id=u.id
      LEFT JOIN collaborator_versions c ON c.user_id=u.id AND c.repository_id=g.repository_id WHERE u.id=? AND u.login=? AND u.active=1`).bind(row.id,body.reviewerId,body.reviewerLogin).first();
    valid=valid&&Boolean(recipient)&&Number(body.reviewerId)!==d.author_id&&(body.requestReview?!state.reviewers.some(u=>u.id===body.reviewerId)&&state.reviewers.length<100:state.reviewers.some(u=>u.id===body.reviewerId));
  } else valid=valid&&state.canManage&&(body.dismiss?!state.state.dismissed:state.canRestore);
  const time=new Date().toISOString(),base={contract:kind==='request'?'golf.pull.review-request.v1':'golf.pull.review-lifecycle.v1',original,actorId:String(person.id),createdAt:time,updatedAt:time};
  const success={...base,phase:phase('SUCCEEDED'),failureCode:''},refused={...base,phase:phase('REJECTED'),failureCode:'preflight_refused'};
  const guard=reviewAuthority(person,row,d),version=kind==='request'?state.version:state.state.version;
  const currentVersion=kind==='request'?'COALESCE((SELECT version FROM pull_review_versions WHERE pull_request_id=?),0)=?':'COALESCE((SELECT version FROM pull_review_lifecycle WHERE review_id=?),0)=?';
  const target=kind==='request'?d.pull_id:state.r.id;
  const recipientGuard=kind==='request'&&recipient?`AND EXISTS(SELECT 1 FROM users WHERE id=? AND login=? AND active=1 AND COALESCE((SELECT version FROM native_identity_versions WHERE user_id=?),0)=?)`:'';
  const restoreGuard=kind==='lifecycle'&&!body.dismiss?`AND EXISTS(SELECT 1 FROM grants g JOIN users u ON u.id=g.user_id WHERE g.repository_id=? AND g.user_id=? AND u.active=1) AND (SELECT max(id) FROM pull_reviews WHERE pull_request_id=? AND author_id=? AND state IN ('APPROVED','REQUEST_CHANGES'))=?`:'';
  const statements=[db.prepare(`INSERT INTO pull_review_operations(actor_id,operation_id,repository_id,pull_request_id,kind,input_hash,receipt)
    SELECT ?,?,?,?,?,?,CASE WHEN ? AND ${guard.sql} AND ${currentVersion} ${recipientGuard} ${restoreGuard} THEN ? ELSE ? END`)
    .bind(person.id,body.operationId,row.id,d.pull_id,kind,hash,valid?1:0,...guard.values,target,version,...(recipientGuard?[recipient.id,recipient.login,recipient.id,recipient.identity_version]:[]),...(restoreGuard?[row.id,state.r.author_id,d.pull_id,state.r.author_id,state.r.id]:[]),JSON.stringify(success),JSON.stringify(refused))];
  const admitted="EXISTS(SELECT 1 FROM pull_review_operations WHERE actor_id=? AND operation_id=? AND json_extract(receipt,'$.phase')='DISCUSSION_RESOURCE_OPERATION_PHASE_SUCCEEDED')", values=[person.id,body.operationId];
  if(kind==='request') {
    statements.push(db.prepare(`INSERT INTO pull_review_versions SELECT ?,? WHERE ${admitted} ON CONFLICT(pull_request_id) DO UPDATE SET version=excluded.version`).bind(d.pull_id,version+1,...values));
    if(body.requestReview&&recipient) statements.push(db.prepare(`INSERT INTO pull_review_requests SELECT ?,?,?,? WHERE ${admitted} ON CONFLICT(pull_request_id,user_id) DO UPDATE SET identity_version=excluded.identity_version,grant_generation=excluded.grant_generation`).bind(d.pull_id,recipient.id,recipient.identity_version,recipient.generation,...values));
    else statements.push(db.prepare(`DELETE FROM pull_review_requests WHERE pull_request_id=? AND user_id=? AND ${admitted}`).bind(d.pull_id,body.reviewerId,...values));
  } else statements.push(db.prepare(`INSERT INTO pull_review_lifecycle SELECT ?,?,?,?,? WHERE ${admitted} ON CONFLICT(review_id) DO UPDATE SET version=excluded.version,dismissed=excluded.dismissed,reason=excluded.reason,updated_at=excluded.updated_at`).bind(state.r.id,version+1,body.dismiss?1:0,body.reason||'',time,...values));
  statements.push(...discussionEvent(db,person,d.id,time,kind==='request'?(body.requestReview?'review_requested':'review_request_removed'):(body.dismiss?'review_dismissed':'review_restored'),kind==='request'?{reviewerId:body.reviewerId,operationId:body.operationId}:{reviewId:body.reviewId},admitted,values));
  if(kind==='request'&&body.requestReview) statements.push(db.prepare(`INSERT OR IGNORE INTO discussion_notifications(user_id,discussion_id,event_id,created_at)
    SELECT ?,discussion_id,id,created_at FROM discussion_events WHERE discussion_id=? AND actor_id=? AND kind='review_requested' AND json_extract(payload,'$.operationId')=? AND ${admitted}`)
    .bind(body.reviewerId,d.id,person.id,body.operationId,...values));
  await db.batch(statements);
  await confirmReviewAuthority(db,person,row);
  return {operation:JSON.parse((await db.prepare('SELECT receipt FROM pull_review_operations WHERE actor_id=? AND operation_id=?').bind(...values).first()).receipt)};
}
