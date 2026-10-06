import {useState} from 'react';
import {useQuery,useQueryClient} from '@tanstack/react-query';
import {Users,RefreshCw} from 'lucide-react';
import {pullReviewRequestClient,errorMessage} from './api';
import type {PullRequest,RepositoryKey} from './gen/golf/v1/golf_pb';
import {privateQuery,shortSHA} from './RepositoryUI';
import {isCommitID} from './navigation';

type Props={repository:Pick<RepositoryKey,'owner'|'name'>;repositoryId:string;userId:string;pull:PullRequest;blocked:boolean};
export function PullCodeOwners(p:Props){
 const cache=useQueryClient(),[requested,setRequested]=useState(false);
 const current=cache.getQueryData<{id:string}>(['session'])?.id===p.userId;
 const base=p.pull.base?.commitId||'',head=p.pull.head?.commitId||'';
 const selection={repository:p.repository,repositoryId:p.repositoryId,pullRequestId:p.pull.id,number:p.pull.number,baseCommitId:base,headCommitId:head};
 const complete=isCommitID(base)&&isCommitID(head)&&/^[a-f0-9]{64}$/.test(p.pull.revision);
 const query=useQuery({...privateQuery,queryKey:['pull-codeowners',p.userId,p.repositoryId,p.pull.id,p.pull.revision,base,head],enabled:requested&&current&&!p.blocked&&complete,queryFn:async({signal})=>{const r=await pullReviewRequestClient.getPullCodeOwners({selection,expectedPullRevision:p.pull.revision},{signal,timeoutMs:15000});if(r.selection?.repository?.owner!==p.repository.owner||r.selection.repository.name!==p.repository.name||r.selection.repositoryId!==p.repositoryId||r.selection.pullRequestId!==p.pull.id||r.selection.number!==p.pull.number||r.selection.baseCommitId!==base||r.selection.headCommitId!==head||r.pullRevision!==p.pull.revision||r.path&&!['CODEOWNERS','docs/CODEOWNERS','.gitea/CODEOWNERS'].includes(r.path)||r.path&&!isCommitID(r.blobId)||r.matches.length>400||r.source.length>16384||r.unsupportedRules>0&&r.routingComplete||r.matches.some(m=>!m.path||m.owners.some(o=>!/^@[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)?$/.test(o))))throw new Error('Code owner observations could not be verified.');signal.throwIfAborted();if(cache.getQueryData<{id:string}>(['session'])?.id!==p.userId)throw new Error('This selection belongs to an inactive account.');return r;}});
 if(!current)return null;
 const visible=requested&&!p.blocked&&!query.isFetching&&!query.error?query.data:undefined;
 return <section className="discussion-metadata" aria-label="Code owner suggestions"><div className="discussion-metadata-heading"><h3><Users size={14}/>Code owners</h3><button className="icon-button" title="Inspect code owners" aria-label="Inspect code owners" disabled={!complete||p.blocked||query.isFetching} onClick={()=>{if(!requested)setRequested(true);else void query.refetch();}}><RefreshCw size={14}/></button></div>{query.error?<p className="error" role="alert">{errorMessage(query.error)}</p>:visible?<>{!visible.path?<p className="muted">No native-format CODEOWNERS file at the selected base.</p>:<><p className="field-help">{visible.path} · base <code>{shortSHA(base)}</code></p>{!visible.routingComplete?<p className="field-help">Routing unavailable: {visible.unsupportedRules} unsupported rules.</p>:visible.matches.length?<ul className="repository-about-list">{visible.matches.map(m=><li key={m.path}><code>{m.path}</code><span>{m.owners.join(', ')}</span></li>)}</ul>:<p className="muted">No matching owners for this comparison.</p>}<details className="metadata-details"><summary>Ownership rules</summary><pre className="source-preview" tabIndex={0}><code>{visible.source}</code></pre><p className="field-help">Native-format regular expressions. Suggestions do not establish membership, eligible approval or protected merge readiness.</p></details></>}</>:requested?<p className="muted">Reading code owners…</p>:null}</section>;
}
