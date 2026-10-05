import {useEffect,useLayoutEffect,useRef,useState} from 'react';
import {useQuery,useQueryClient} from '@tanstack/react-query';
import {Code,ConnectError,type Client} from '@connectrpc/connect';
import {LoaderCircle,RefreshCw,Star} from 'lucide-react';
import {RepositoryService,type RepositoryKey,type RepositoryStarPreference} from './gen/golf/v1/golf_pb';
import {privateQuery} from './RepositoryUI';
import {sourceRepositoryID} from './sourceReads';

type Props={client:Client<typeof RepositoryService>;userId:string;repository:Pick<RepositoryKey,'owner'|'name'>;repositoryId:string;revalidating:boolean;signingOut?:boolean;onAuthorityDenied:(error:ConnectError)=>void};
const component=(name:string)=>name!==''&&name!=='.'&&name!=='..'&&name.length<=100&&!/[\/\\\p{Cc}\uD800-\uDFFF]/u.test(name);
const count=(value:string)=>value.length<=19&&/^(0|[1-9][0-9]*)$/.test(value)&&BigInt(value)<=9223372036854775807n;
const privacy=(error:unknown):error is ConnectError=>error instanceof ConnectError&&[Code.Unauthenticated,Code.PermissionDenied,Code.NotFound].includes(error.code);
function verify(preference:RepositoryStarPreference|undefined,props:Props,ownerId?:string){
 if(!preference||preference.repository?.owner.toLowerCase()!==props.repository.owner.toLowerCase()||preference.repository.name.toLowerCase()!==props.repository.name.toLowerCase()||preference.repositoryId!==props.repositoryId||preference.nativeUserId!==props.userId||!sourceRepositoryID(preference.ownerId)||ownerId!==undefined&&preference.ownerId!==ownerId||typeof preference.starred!=='boolean'||preference.starsCount!==undefined&&!count(preference.starsCount))throw new ConnectError('The star preference could not be verified.',Code.FailedPrecondition);
 return preference;
}
export function RepositoryStars(props:Props){
 if(!sourceRepositoryID(props.userId)||!sourceRepositoryID(props.repositoryId)||!component(props.repository.owner)||!component(props.repository.name))return <span className="muted" role="status">Star unavailable</span>;
 return <StarControl key={JSON.stringify([props.userId,props.repository.owner,props.repository.name,props.repositoryId])} {...props}/>;
}
function StarControl(props:Props){
 const {client,userId,repository,repositoryId,revalidating,signingOut,onAuthorityDenied}=props;
 const cache=useQueryClient(),key=['repository',userId,repository.owner,repository.name,'star',repositoryId];
 const [unknown,setUnknown]=useState<{ownerId:string;desired:boolean}|null>(null),[busy,setBusy]=useState(false),[denied,setDenied]=useState(false),[notice,setNotice]=useState('');
 const live=useRef(false),blocked=useRef(false),latch=useRef(false),controller=useRef<AbortController|null>(null);
 blocked.current=revalidating||Boolean(signingOut)||denied;
 useLayoutEffect(()=>{live.current=true;return()=>{live.current=false;controller.current?.abort();void cache.cancelQueries({queryKey:key,exact:true});cache.removeQueries({queryKey:key,exact:true});};},[]);
 useEffect(()=>{if(revalidating||signingOut){controller.current?.abort();latch.current=false;setBusy(false);setNotice('');void cache.cancelQueries({queryKey:key,exact:true});void cache.invalidateQueries({queryKey:key,exact:true,refetchType:'none'});if(signingOut){setUnknown(null);cache.removeQueries({queryKey:key,exact:true});}}},[revalidating,signingOut]);
 const query=useQuery({...privateQuery,staleTime:Infinity,refetchOnWindowFocus:false,refetchOnReconnect:false,retry:false,queryKey:key,enabled:!blocked.current&&!unknown,
  queryFn:async({signal})=>{const result=await client.getRepositoryStar({repository,repositoryId},{signal,timeoutMs:8000});signal.throwIfAborted();return verify(result.preference,props);}});
 const deny=(error:ConnectError)=>{if(!live.current||blocked.current)return;setDenied(true);setUnknown(null);setNotice('');cache.removeQueries({queryKey:key,exact:true});onAuthorityDenied(error);};
 useEffect(()=>{if(privacy(query.error))deny(query.error);},[query.error]);
 const observed=!blocked.current&&!unknown&&!busy&&query.isSuccess&&!query.isFetching&&!query.error?query.data:undefined;
 const refreshCounts=()=>void cache.invalidateQueries({queryKey:['repository',userId,repository.owner,repository.name,'metadata','sidebar',repositoryId],exact:true});
 async function change(){
  if(latch.current||blocked.current||!observed)return;
  const original=observed,desired=!original.starred,abort=new AbortController();controller.current=abort;latch.current=true;setBusy(true);setUnknown({ownerId:original.ownerId,desired});setNotice('');
  try{const result=await client.setRepositoryStar({repository,repositoryId,ownerId:original.ownerId,nativeUserId:userId,starred:desired},{signal:abort.signal,timeoutMs:8000});abort.signal.throwIfAborted();if(!live.current||blocked.current)return;const current=verify(result.preference,props,original.ownerId);if(current.starred!==desired)throw new ConnectError('The requested star preference could not be confirmed.',Code.FailedPrecondition);cache.setQueryData(key,current);setUnknown(null);setNotice(desired?'Repository starred.':'Repository unstarred.');refreshCounts();}
  catch(error){if(!live.current||abort.signal.aborted||blocked.current)return;if(privacy(error))deny(error);else setNotice('Star change could not be confirmed. Inspect the current preference before another change.');}
  finally{if(live.current&&controller.current===abort){latch.current=false;setBusy(false);}}
 }
 async function inspect(){
  if(latch.current||blocked.current)return;
  const original=unknown,abort=new AbortController();controller.current=abort;latch.current=true;setBusy(true);setNotice('');
  try{const result=await client.getRepositoryStar({repository,repositoryId},{signal:abort.signal,timeoutMs:8000});abort.signal.throwIfAborted();if(!live.current||blocked.current)return;const current=verify(result.preference,props,original?.ownerId);cache.setQueryData(key,current);setUnknown(null);setNotice(current.starred?'Currently starred.':'Currently not starred.');refreshCounts();}
  catch(error){if(!live.current||abort.signal.aborted||blocked.current)return;if(privacy(error))deny(error);else setNotice('Star preference could not be verified. No change was retried.');}
  finally{if(live.current&&controller.current===abort){latch.current=false;setBusy(false);}}
 }
 if(blocked.current)return <button type="button" className="button secondary" disabled aria-label="Star preference unavailable"><Star size={15} aria-hidden="true"/>Star</button>;
 return <span className="panel-actions" role="group" aria-label="Repository star">
  {unknown||query.isError?<><button type="button" className="button secondary" aria-label="Inspect current preference" title={unknown?'Star change unconfirmed. Inspect current preference; no change will be retried.':'Inspect current preference'} onClick={()=>void inspect()} disabled={busy}>{busy?<LoaderCircle size={15} className="spin" aria-hidden="true"/>:<RefreshCw size={15} aria-hidden="true"/>}Inspect star</button><span className="sr-only" role="status">{busy?'Checking star preference…':notice||(unknown?'Star change could not be confirmed.':'Star preference unavailable.')}</span></>:<><button type="button" className="button secondary" aria-label={observed?.starred?'Unstar repository':'Star repository'} title={observed?.starred?'Unstar repository':'Star repository'} aria-pressed={observed?.starred} disabled={!observed} onClick={()=>void change()}>{busy||query.isFetching?<LoaderCircle size={15} className="spin" aria-hidden="true"/>:<Star size={15} fill={observed?.starred?'currentColor':'none'} aria-hidden="true"/>}{observed?.starred?'Unstar':'Star'}</button><span className="sr-only" role="status">{notice}</span></>}
 </span>;
}
