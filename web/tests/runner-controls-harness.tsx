import { createElement, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createClient } from '@connectrpc/connect';
import { createConnectTransport } from '@connectrpc/connect-web';
import { RunnerControlService } from '../src/gen/golf/v1/golf_pb';
import { InstanceRunnerControls, RepositoryRunners } from '../src/RunnerControls';
import '../src/styles.css';
const queries = new QueryClient({defaultOptions:{queries:{retry:false},mutations:{retry:false}}});
queries.setQueryData(['session'],{id:'1'});
const client=createClient(RunnerControlService,createConnectTransport({baseUrl:'/rpc',useBinaryFormat:false}));
declare global { interface Window { runnerControlProps: (props:{userId?:string;signingOut?:boolean;revalidating?:boolean})=>void } }
function Harness(){ const [props,setProps]=useState({userId:'1',signingOut:false,revalidating:false});window.runnerControlProps=value=>{setProps(p=>({...p,...value}));if(value.userId)queries.setQueryData(['session'],{id:value.userId});};const common={...props,client};return createElement(QueryClientProvider,{client:queries},new URLSearchParams(location.search).has('repo')?createElement(RepositoryRunners,{...common,owner:'alice',name:'example',repositoryId:'11',ownerId:'42',workflowPath:'.github/workflows/test.yml'}):createElement(InstanceRunnerControls,common));}
createRoot(document.getElementById('root')!).render(createElement(Harness));
