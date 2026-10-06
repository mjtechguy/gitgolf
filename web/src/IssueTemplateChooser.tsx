import {useQuery} from '@tanstack/react-query';
import {FileText} from 'lucide-react';
import {discussionCollaborationClient} from './api';
import {DataTable,type DataTableColumn} from './DataTable';
import {Loading,PanelError,privateQuery} from './RepositoryUI';
import type {IssueTemplate,RepositoryKey} from './gen/golf/v1/golf_pb';
export function IssueTemplateChooser({repositoryKey,repositoryId,queryKey,choose}:{repositoryKey:Pick<RepositoryKey,'owner'|'name'>;repositoryId:string;queryKey:readonly unknown[];choose:(template:IssueTemplate)=>void}){
 const query=useQuery({...privateQuery,queryKey:[...queryKey,'issue-templates',repositoryId],queryFn:({signal})=>discussionCollaborationClient.listIssueTemplates({repository:repositoryKey,repositoryId},{signal,timeoutMs:15000})});
 const columns:DataTableColumn<IssueTemplate>[]=[{accessorKey:'name',header:'Template',cell:({row})=><strong>{row.original.name}</strong>},{accessorKey:'about',header:'Description'},{id:'actions',header:'',enableSorting:false,enableGlobalFilter:false,cell:({row})=><button className="button secondary" onClick={()=>choose(row.original)}><FileText size={14}/>Use template</button>}];
 if(query.isSuccess&&!query.data.templates.length&&!query.data.unsupportedTemplates)return null;
 return <details className="metadata-details panel-disclosure"><summary>Issue templates</summary>{query.isError?<PanelError error={query.error} retry={()=>void query.refetch()}/>:query.isPending?<Loading label="Reading issue templates…"/>:<><DataTable label="issue templates" data={query.data.templates} columns={columns} getRowId={r=>r.path}/>{query.data.unsupportedTemplates?<p className="field-help">{query.data.unsupportedTemplates} unsupported or invalid templates could not be rendered. Available Markdown templates and YAML forms appear above.</p>:null}<p className="panel-footnote">From the default branch at <code>{query.data.commitId.slice(0,12)}</code>. Template text pre-fills an editable draft; labels and assignees are set separately.</p></>}</details>;
}
