import { Bot, CheckCircle2, CircleDashed, CircleSlash, GitPullRequest, LoaderCircle, Workflow, XCircle } from 'lucide-react';
import { ActionRunKind } from './gen/golf/v1/golf_pb';
import { kindLabel } from './actionRunReceipts';
export function ActionRunStatus({state,compact=false}:{state:string;compact?:boolean}) {
 const Icon=state==='succeeded'||state==='published'?CheckCircle2:state==='failed'?XCircle:state==='running'||state==='publishing'?LoaderCircle:state==='cancelled'||state==='outdated'?CircleSlash:CircleDashed;
 return <span title={state} className={`run-state run-state-${state.replace(/[^a-z_-]/g,'')}`}><Icon size={16} aria-hidden="true" className={state==='running'||state==='publishing'?'spin':undefined}/><span className={compact?'sr-only':undefined}>{state.replaceAll('_',' ')}</span></span>;
}
export function ActionRunKindBadge({kind}:{kind:ActionRunKind}){const Icon=kind===ActionRunKind.CODING_TASK?Bot:kind===ActionRunKind.REVIEW?GitPullRequest:Workflow;return <span className="run-kind-badge"><Icon size={13} aria-hidden="true"/>{kindLabel(kind)}</span>}
export function actionDuration(run:{startedAt?:string;finishedAt?:string;state:string}){
 if(!run.startedAt)return 'Duration not recorded';if(!run.finishedAt)return ['running','publishing'].includes(run.state)?'In progress':'Finish time not recorded';
 const seconds=Math.floor((Date.parse(run.finishedAt)-Date.parse(run.startedAt))/1000);return Number.isFinite(seconds)&&seconds>=0?`${Math.floor(seconds/60)}m ${seconds%60}s`:'Duration not recorded';
}
