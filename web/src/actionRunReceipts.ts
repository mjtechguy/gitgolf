import { Code, ConnectError } from '@connectrpc/connect';
import { ActionRunKind, WorkflowRunState, type ActionRunRef, type ActionRunSummary, type GetActionRunResponse } from './gen/golf/v1/golf_pb';
import { isCommitID, isRunID } from './navigation';
import { sourcePath, sourceRepositoryID } from './sourceReads';
export type ActionKind = 'workflow'|'coding-task'|'review';
export const kindValue = (kind?:ActionKind) => kind==='workflow'?ActionRunKind.WORKFLOW:kind==='coding-task'?ActionRunKind.CODING_TASK:kind==='review'?ActionRunKind.REVIEW:ActionRunKind.UNSPECIFIED;
export const kindName = (kind:ActionRunKind):ActionKind => kind===ActionRunKind.CODING_TASK?'coding-task':kind===ActionRunKind.REVIEW?'review':'workflow';
export const kindLabel = (kind:ActionRunKind) => kind===ActionRunKind.CODING_TASK?'Coding task':kind===ActionRunKind.REVIEW?'PR review':'Workflow';
const failure = ():never => {throw new ConnectError('The run receipt does not match this repository and typed run.',Code.FailedPrecondition)};
const text=(value:string,max=4096)=>new TextEncoder().encode(value).length<=max&&!/[\p{Cc}\uD800-\uDFFF]/u.test(value);
const date=(value:string|undefined)=>value===undefined||value===''||Number.isFinite(Date.parse(value));
const kinds=[ActionRunKind.WORKFLOW,ActionRunKind.CODING_TASK,ActionRunKind.REVIEW];
export const validActionRef=(ref:ActionRunRef|undefined)=>Boolean(ref&&kinds.includes(ref.kind)&&isRunID(ref.id));
export function validateActionSummary(summary:ActionRunSummary,repositoryId:string,kind=ActionRunKind.UNSPECIFIED,workflowPath='') {
 if(!sourceRepositoryID(repositoryId)||summary.repositoryId!==repositoryId||!sourceRepositoryID(summary.ownerId)||!validActionRef(summary.ref)||kind!==ActionRunKind.UNSPECIFIED&&summary.ref!.kind!==kind||!summary.title||!text(summary.title)||!summary.state||!text(summary.state,64)||!isCommitID(summary.commitId)||!summary.createdAt||!date(summary.createdAt)||!date(summary.startedAt)||!date(summary.finishedAt)||summary.workflowPath&&!sourcePath(summary.workflowPath)||workflowPath&&summary.workflowPath!==workflowPath||summary.childTask&&(!validActionRef(summary.childTask)||summary.childTask.kind!==ActionRunKind.CODING_TASK||summary.ref!.kind!==ActionRunKind.REVIEW)||!text(summary.trigger,128)||!text(summary.modelId,512)||!text(summary.workerId,512)||summary.attemptId&&!/^[a-f0-9]{32}$/.test(summary.attemptId)||summary.workflowBlobId&&!isCommitID(summary.workflowBlobId)||summary.sourceSha256&&!/^[a-f0-9]{64}$/.test(summary.sourceSha256)||!text(summary.eventRef,1024)||summary.repositoryEventId&&!sourceRepositoryID(summary.repositoryEventId)||summary.automationGrantId&&!isRunID(summary.automationGrantId))failure();
 return summary;
}
export function validateActionDetail(response:GetActionRunResponse,repositoryId:string,owner:string,name:string,ref:{kind:ActionRunKind;id:string}) {
 if(response.repositoryId!==repositoryId||!response.summary)failure();const summary=validateActionSummary(response.summary!,repositoryId,ref.kind);
 if(summary.ref!.id!==ref.id)failure();const detail=response.detail;
 if(ref.kind===ActionRunKind.WORKFLOW){if(detail.case!=='workflow'||detail.value.id!==ref.id||detail.value.repositoryId!==repositoryId||detail.value.ownerId!==summary.ownerId||detail.value.commitId!==summary.commitId||detail.value.workflowPath!==summary.workflowPath||WorkflowRunState[detail.value.state]?.toLowerCase()!==summary.state)failure();}
 else if(ref.kind===ActionRunKind.CODING_TASK){if(detail.case!=='task'||detail.value.id!==ref.id||detail.value.repository?.owner.toLowerCase()!==owner.toLowerCase()||detail.value.repository.name.toLowerCase()!==name.toLowerCase()||detail.value.commitId!==summary.commitId||detail.value.state!==summary.state||!sourceRepositoryID(detail.value.version)||!/^(0|[1-9][0-9]{0,18})$/.test(detail.value.tokens)||BigInt(detail.value.tokens)>9223372036854775807n||detail.value.workerId!==summary.workerId||detail.value.attemptId!==summary.attemptId||detail.value.modelId!==summary.modelId)failure();}
 else if(ref.kind===ActionRunKind.REVIEW){if(detail.case!=='review'||detail.value.id!==ref.id||detail.value.headCommit!==summary.commitId||detail.value.state!==summary.state||detail.value.pullNumber!==summary.pullNumber||!isCommitID(detail.value.baseCommit)||detail.value.baseCommit.length!==summary.commitId.length||!Number.isInteger(detail.value.pullNumber)||detail.value.pullNumber<=0||detail.value.reviewId&&detail.value.reviewId!=='0'&&!sourceRepositoryID(detail.value.reviewId)||(summary.childTask?summary.childTask.id!==detail.value.taskId:Boolean(detail.value.taskId)))failure();}
 else failure();return response;
}
