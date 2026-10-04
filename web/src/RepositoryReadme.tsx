import { useQuery } from '@tanstack/react-query';
import { Code, ConnectError } from '@connectrpc/connect';
import { BookOpen } from 'lucide-react';
import { readExactSource } from './sourceReads';
import { SourceEntryType, type SourceEntry } from './gen/golf/v1/golf_pb';
import { FileContent } from './RepositoryContent';
import { Loading, PanelError, privateQuery } from './RepositoryUI';

export function RepositoryReadme({owner,name,refId,path,entries,userId,repositoryId}:{repositoryId:string;owner:string;name:string;refId:string;path:string;entries:SourceEntry[];userId:string}) {
 const query=useQuery({...privateQuery,queryKey:['repository',userId,owner,name,'readme',repositoryId,refId,path],queryFn:async({signal})=>{
  const repository={owner,name};
  const choose=(rows:SourceEntry[])=>rows.filter(e=>e.type===SourceEntryType.FILE&&/^readme\.(md|markdown|mdown)$/i.test(e.name)).sort((a,b)=>a.name.localeCompare(b.name))[0];
  let readme=choose(entries);
  for(const directory of path?[]:['.github','', 'docs']) {
   if(directory==='') {readme=choose(entries);if(readme)break;continue;}
   if(!entries.some(e=>e.path===directory&&e.type===SourceEntryType.DIRECTORY))continue;
   const result=await readExactSource(repository,repositoryId,refId,directory,signal);
   if(result.commitId!==refId||result.kind!==SourceEntryType.DIRECTORY) throw new ConnectError('README directory snapshot changed.',Code.Internal);
   readme=choose(result.entries);if(readme)break;
  }
  if(!readme)return null;
  const result=await readExactSource(repository,repositoryId,refId,readme.path,signal);
  if(result.commitId!==refId||result.file?.entry?.sha!==readme.sha) throw new ConnectError('README identity changed.',Code.Internal);
  return result;
 }});
 if(query.isError)return <PanelError error={query.error} retry={()=>void query.refetch()}/>;
 if(query.isPending||query.isFetching)return <Loading label="Reading README…"/>;
 const file=query.data?.file;
 if(!file?.entry)return null;
 const heading=<h2><BookOpen size={17}/> {file.entry.path}</h2>;
 return <section className="browser-panel" aria-label="Repository README">{file.previewReason||file.entry.size>256n*1024n||file.content===undefined?<><div className="browser-panel-heading">{heading}</div><p className="panel-footnote">{file.previewReason||'README exceeds the preview limit.'}</p></>:<FileContent key={file.entry.sha} text={file.content} path={file.entry.path} heading={heading} context={{repositoryId,owner,name,ref:refId,path:file.entry.path,userId}}/>}</section>;
}
