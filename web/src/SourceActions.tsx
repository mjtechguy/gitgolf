import {Link,useRouter} from '@tanstack/react-router';
import {Download,History,MoreHorizontal} from 'lucide-react';
import {repositoryOptions} from './navigation';
import type {RepositoryLocation} from './navigation';
import {CopyButton,disclosureDismiss,downloadText,fitDisclosure,useFragment} from './RepositoryUI';

export function SourceActions({location,commitId,path,text,file}:{location:RepositoryLocation;commitId:string;path:string;text?:string;file:boolean}) {
 const router=useRouter(),fragment=useFragment();
 const source=repositoryOptions(location,{view:'source',ref:commitId,path,branch:'',tag:undefined,refKind:undefined,refName:undefined},file?'file':undefined);
 const permalink=window.location.origin+router.buildLocation(source).href+(/^#L[1-9][0-9]*(?:-L[1-9][0-9]*)?$/.test(fragment)?fragment:'');
 return <div className="row-actions source-actions"><Link className="text-button" {...repositoryOptions(location,{view:'commits',commit:undefined,ref:commitId,refKind:undefined,refName:undefined,historyPath:path||undefined})}><History size={15}/>History</Link><details className="source-action-menu" {...disclosureDismiss} onToggle={event=>{if(event.currentTarget.open)fitDisclosure(event.currentTarget,'.source-action-options');}}><summary className="icon-button" aria-label="Source actions" title="Source actions"><MoreHorizontal size={17}/></summary><div className="source-action-options"><span><span>Copy path</span><CopyButton text={path||'/'} label="Copy repository path"/></span><span><span>Copy permalink</span><CopyButton text={permalink} label="Copy source permalink"/></span>{file?<button className="text-button" disabled={text===undefined} title={text===undefined?'No downloadable text is available in this preview':'Download the displayed UTF-8 text'} onClick={()=>{if(text!==undefined)downloadText(text,path.split('/').pop()||'source.txt');}}><Download size={15}/>Download text</button>:null}</div></details></div>;
}
