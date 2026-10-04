import { createContext,useContext,useEffect,useRef,useState } from 'react';
import { Code, ConnectError } from '@connectrpc/connect';
import { useQueryClient } from '@tanstack/react-query';
import { Radio, RefreshCw, WifiOff } from 'lucide-react';
import { repositoryActivityClient } from './api';
import { forgetPrivateQueries } from './queryClient';

export const RepositoryLiveContext=createContext<'connecting'|'live'|'offline'>('offline');
export const useLiveStatus=()=>useContext(RepositoryLiveContext);
const allowedTopics=['source','issues','pulls','actions','agents'];
export function useRepositoryLive(userId:string,owner:string,name:string,repositoryId:string|undefined,ref:string,enabled:boolean,pinComparison=false){
 const pin=useRef(pinComparison);pin.current=pinComparison;
 const client=useQueryClient();const [status,setStatus]=useState<'connecting'|'live'|'offline'>('connecting');const [newSource,setNewSource]=useState(false);const [attempt,setAttempt]=useState(0);
 useEffect(()=>setNewSource(false),[owner,name,ref]);
 useEffect(()=>{
  if(!enabled||!repositoryId)return;
  const controller=new AbortController();let cursor='',live=true;let timer:ReturnType<typeof setTimeout>|undefined;let failures=0;
  setStatus('connecting');
  const scoped=(key:readonly unknown[])=>key[1]===userId&&key[2]===owner&&key[3]===name;
  const refresh=(topics:string[],revalidateMetadata=false)=>{
   void client.invalidateQueries({predicate:query=>{
    const key=query.queryKey;if(!scoped(key))return false;
    if(key[0]==='repository'&&key[4]==='metadata')return revalidateMetadata && topics.some(topic=>allowedTopics.includes(topic));
    if(key[0]==='repository'&&pin.current&&key[4]==='branches')return topics.includes('source')||topics.includes('pulls');
    if(key[0]==='repository'&&pin.current&&key[4]==='pull'&&key.length===6)return false;
    if(key[0]==='repository'&&key[4]==='pull-checks')return topics.includes('pulls')||topics.includes('actions');
    if(key[0]==='repository')return topics.includes('issues')&&['issue','issues'].includes(String(key[4]))||topics.includes('pulls')&&['pull','pulls','pull-discussion'].includes(String(key[4]));
    if(key[0]==='agent-task-events')return topics.includes('agents');
    if(['action-runs','action-run'].includes(String(key[0])))return topics.some(topic=>['actions','agents','pulls'].includes(topic));
    if(key[0]==='workflow-configurations')return topics.includes('source')||topics.includes('actions');
    return topics.includes('actions')&&['workflow-runs','workflow-run','workflow-run-logs'].includes(String(key[0]))||topics.includes('agents')&&['agent-tasks','agent-task'].includes(String(key[0]))||topics.includes('pulls')&&key[0]==='reviewer-runs';
   }});
  };
  const wait=(ms:number)=>new Promise<void>(resolve=>{const done=()=>{clearTimeout(timer);controller.signal.removeEventListener('abort',done);resolve();};timer=setTimeout(done,ms);controller.signal.addEventListener('abort',done,{once:true});});
  async function run(){while(live&&!controller.signal.aborted){
   try{
    let received=false,rotate=false;
    for await(const event of repositoryActivityClient.watchRepository({repository:{owner,name},repositoryId,cursor},{signal:controller.signal,timeoutMs:14000})){
     if(!live||controller.signal.aborted)return;
     if(event.repositoryId!==repositoryId||!['reset','change','heartbeat','reconnect'].includes(event.kind)||event.topics.some(t=>!allowedTopics.includes(t))||(!/^(0|[1-9][0-9]{0,18})$/.test(event.cursor)||BigInt(event.cursor)>9223372036854775807n)||cursor&&BigInt(event.cursor)<BigInt(cursor))throw new Error('Invalid live activity response.');
     received=true;failures=0;setStatus('live');
     if(event.kind==='reset')refresh(['issues','pulls','actions','agents'],true);
     else if(event.kind==='change'){if(event.topics.includes('source')||pin.current&&event.topics.includes('pulls'))setNewSource(true);refresh(event.topics,true);}
     cursor=event.cursor;
     if(event.kind==='reconnect')rotate=true;
    }
    if(!received||!rotate)throw new Error('Live stream ended unexpectedly.');
    await wait(200);
   }catch(error){
    if(!live||controller.signal.aborted)return;
    if(error instanceof ConnectError&&error.code===Code.Unauthenticated){client.setQueryData(['session'],null);forgetPrivateQueries(client);return;}
    if(error instanceof ConnectError&&[Code.PermissionDenied,Code.NotFound].includes(error.code)){
     await client.cancelQueries({predicate:q=>scoped(q.queryKey)});
     client.removeQueries({predicate:q=>scoped(q.queryKey)&&q.queryKey[4]!=='metadata'});
     client.getQueryCache().find({queryKey:['repository',userId,owner,name,'metadata'],exact:true})?.setState({data:undefined,error,status:'error',fetchStatus:'idle'});return;
    }
    setStatus('offline');if(error instanceof ConnectError&&error.code===Code.Unimplemented)return;
    if(error instanceof ConnectError&&error.code===Code.InvalidArgument)cursor='';
    // Visible fallback revalidates observations, never silently changes source.
    refresh(['issues','pulls','actions','agents']);
    await wait(Math.min(15000,1000*2**Math.min(failures++,4)));
   }
  }}
  void run();const hide=()=>{live=false;controller.abort();};window.addEventListener('pagehide',hide);
  return()=>{hide();clearTimeout(timer);window.removeEventListener('pagehide',hide);};
 },[client,userId,owner,name,repositoryId,enabled,attempt]);
 return {status,newSource,reconnect:()=>setAttempt(v=>v+1),refreshComparison:()=>{setNewSource(false);void client.invalidateQueries({queryKey:['repository',userId,owner,name,'pull']});}};
}
export function RepositoryLiveStatus({status,reconnect}:{status:'connecting'|'live'|'offline';reconnect:()=>void}){
 return <span className={`live-status live-status-${status}`} title={status==='live'?'Repository activity updates automatically; source snapshots stay pinned.':'Live connection unavailable; mutable views revalidate while reconnecting.'}>{status==='live'?<Radio size={14}/>:<WifiOff size={14}/>}<span>{status==='live'?'Live':status==='connecting'?'Connecting…':'Reconnecting…'}</span>{status==='offline'?<button className="icon-button" aria-label="Reconnect live updates" onClick={reconnect}><RefreshCw size={14}/></button>:null}</span>;
}
