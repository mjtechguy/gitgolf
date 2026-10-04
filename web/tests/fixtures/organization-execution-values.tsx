import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createClient } from '@connectrpc/connect';
import { createConnectTransport } from '@connectrpc/connect-web';
import { OrganizationExecutionValueService, RepositoryService } from '../../src/gen/golf/v1/golf_pb';
import { OrganizationExecutionValues } from '../../src/OrganizationExecutionValues';
import '../../src/styles.css';
const client = createClient(OrganizationExecutionValueService, createConnectTransport({baseUrl:'/rpc',useBinaryFormat:false}));
const repositoryClient = createClient(RepositoryService, createConnectTransport({baseUrl:'/rpc',useBinaryFormat:false}));
function Host() {
 const [userId,setUser]=useState('42'),[organizationId,setOrganization]=useState('81'),[canManage,setOwner]=useState(true),[signingOut,setSignOut]=useState(false);
 return <><div className="credential-actions"><button onClick={()=>setUser('43')}>Switch fixture account</button><button onClick={()=>setOrganization('82')}>Replace fixture organization</button><button onClick={()=>setOwner(false)}>Lose fixture ownership</button><button onClick={()=>setSignOut(true)}>Sign out fixture</button></div><OrganizationExecutionValues client={client} repositoryClient={repositoryClient} userId={userId} organization="acme" organizationId={organizationId} canManage={canManage} signingOut={signingOut}/></>;
}
createRoot(document.getElementById('root')!).render(<React.StrictMode><QueryClientProvider client={new QueryClient({defaultOptions:{queries:{retry:false}}})}><Host/></QueryClientProvider></React.StrictMode>);
