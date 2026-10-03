import { useRef, useState } from 'react';
import { Pencil, FilePenLine, CircleCheck, Undo2, GitPullRequestDraft, GitPullRequest } from 'lucide-react';
import { DiscussionComposer } from './IssueBrowser';
import { issueIntentKey, readIssueIntent } from './issueIntents';
import type { IssueIntent } from './issueIntents';
import { IssueState } from './gen/golf/v1/golf_pb';
import type { PullRequest, RepositoryKey } from './gen/golf/v1/golf_pb';
import type { RepositoryLocation } from './navigation';

type Props = { repositoryKey: Pick<RepositoryKey,'owner'|'name'>; repositoryId:string; queryKey:readonly unknown[]; location:RepositoryLocation; userId:string; pull:PullRequest; refresh:()=>void };
export function PullRequestEditControls(props:Props) {
 const {pull,userId,repositoryId,refresh}=props;
 const storageKey=issueIntentKey(userId,repositoryId,'pull-'+pull.id)+':edit';
 const resumed=()=>readIssueIntent(storageKey,repositoryId,'',pull.number,'pull-update',pull.id);
 const [mode,setMode]=useState<IssueIntent['editField']>(()=>resumed()?.editField);
 const [pending,setPending]=useState(()=>Boolean(resumed()));
 const trigger=useRef<HTMLButtonElement>(null);
 const done=()=>{setMode(undefined);setPending(false);refresh();requestAnimationFrame(()=>trigger.current?.focus());};
 const disabled=Boolean(mode)||pending||!pull.revision;
 const lifecycleDisabled=disabled||pull.merged;
 const draftDisabled=lifecycleDisabled||pull.state!==IssueState.OPEN;
 const label=mode==='title'?'Edit title':mode==='body'?'Edit description':mode==='close'?'Close pull request':mode==='reopen'?'Reopen pull request':mode==='draft'?'Convert to draft':'Ready for review';
 return <section className="issue-edit-controls" aria-label="Pull request actions"><div className="row-actions">
  {pending&&!mode?<button ref={trigger} className="button secondary" onClick={()=>setMode(resumed()?.editField)}>Resume pull request change</button>:<>
   <button ref={trigger} className="icon-button" aria-label="Edit pull request title" title="Edit pull request title" disabled={disabled} onClick={()=>setMode('title')}><Pencil size={16}/></button>
   <button className="icon-button" aria-label="Edit pull request description" title="Edit pull request description" disabled={disabled} onClick={()=>setMode('body')}><FilePenLine size={16}/></button>
   <button className="icon-button" aria-label={pull.draft?'Ready for review':'Convert to draft'} title={pull.draft?'Ready for review':'Convert to draft'} disabled={draftDisabled} onClick={()=>setMode(pull.draft?'ready':'draft')}>{pull.draft?<GitPullRequest size={16}/>:<GitPullRequestDraft size={16}/>}</button>
   <button className="button secondary" disabled={lifecycleDisabled} onClick={()=>setMode(pull.state===IssueState.CLOSED?'reopen':'close')}>{pull.state===IssueState.CLOSED?<Undo2 size={16}/>:<CircleCheck size={16}/>} {pull.state===IssueState.CLOSED?'Reopen pull request':'Close pull request'}</button>
  </>}
 </div>{mode?<section className="browser-panel issue-edit-panel" aria-label={label}><div className="browser-panel-heading"><h2>{label}</h2></div><div className="issue-edit-content"><DiscussionComposer key={pull.id+':'+mode} {...props} proposal={pull} editField={mode} onPending={setPending} onPullUpdated={done} onClose={()=>{setMode(undefined);requestAnimationFrame(()=>trigger.current?.focus());}}/></div></section>:null}
 {!pull.revision?<p className="field-help">Editing is unavailable because the native pull request revision could not be verified.</p>:null}</section>;
}
