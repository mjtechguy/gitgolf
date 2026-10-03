import { Link } from '@tanstack/react-router';
import { ChevronRight } from 'lucide-react';
import { repositoryOptions, type Location } from './navigation';

// One navigation pattern for repositories, account settings and administration.
export function Breadcrumbs({location}:{location:Location}) {
 const repository='owner' in location&&'name' in location;
 return <nav className="workspace-breadcrumbs" aria-label="Breadcrumb"><Link to="/">Repositories</Link>
 {repository?<><ChevronRight size={13}/><span>{location.owner}</span><ChevronRight size={13}/><Link {...repositoryOptions(location,{view:'source',path:''})}>{location.name}</Link>
 {location.kind==='repository'&&location.view!=='source'?<><ChevronRight size={13}/><Link {...repositoryOptions(location,{issue:undefined,issueNew:undefined,pull:undefined,pullView:undefined,commit:undefined,historyPath:undefined,run:undefined,step:undefined})}>{location.view==='compare'?'Compare changes':location.view==='pulls'?'Pull requests':location.view==='commits'?'Commits':location.view==='actions'?'Actions':'Issues'}</Link>{location.issue||location.pull||location.commit||location.run?<><ChevronRight size={13}/><span aria-current={location.pullView&&location.pullView!=='conversation'?undefined:'page'}>{location.commit?.slice(0,12)||location.run?.slice(0,8)||`#${location.issue||location.pull}`}</span></>:null}{location.issueNew?<><ChevronRight size={13}/><span aria-current="page">New issue</span></>:null}{location.historyPath?<><ChevronRight size={13}/><span aria-current="page">{location.historyPath}</span></>:null}{location.pullView&&location.pullView!=='conversation'?<><ChevronRight size={13}/><span aria-current="page">{location.pullView==='files'?'Files changed':location.pullView==='checks'?'Checks':'Commits'}</span></>:null}</>:null}
 {location.kind!=='repository'?<><ChevronRight size={13}/><span aria-current="page">{location.kind==='repository-access-settings'?'Access':location.kind==='repository-workflows'?'Automation':'Settings'}</span></>:null}</>:location.kind==='home'?null:<><ChevronRight size={13}/>{location.kind==='instance-settings'?<><Link to="/admin">Admin portal</Link>{location.view&&location.view!=='overview'?<><ChevronRight size={13}/><span aria-current="page">{location.view.charAt(0).toUpperCase()+location.view.slice(1)}</span></>:null}</>:<span aria-current="page">{location.kind==='settings'?'Profile':location.kind==='status'?'System status':location.kind==='audit'?'Audit log':location.kind.replaceAll('-',' ')}</span>}</>}
 </nav>;
}
