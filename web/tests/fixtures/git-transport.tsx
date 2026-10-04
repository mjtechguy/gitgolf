import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createClient } from '@connectrpc/connect';
import { createConnectTransport } from '@connectrpc/connect-web';
import { GitTransportService } from '../../src/gen/golf/v1/golf_pb';
import { RepositoryGitTransport } from '../../src/RepositoryGitTransport';
import '../../src/styles.css';
const client = createClient(GitTransportService, createConnectTransport({ baseUrl: `${location.origin}/rpc`, useBinaryFormat: false }));
const queries = new QueryClient({ defaultOptions: { queries: { retry: false } } });
function Host() {
 const [userId,setUserId]=useState('42'),[signingOut,setSigningOut]=useState(false),[repositoryId,setRepositoryId]=useState('123');
 return <QueryClientProvider client={queries}><main className="workspace-content"><div className="row-actions"><button onClick={()=>setSigningOut(true)}>Fixture sign out</button><button onClick={()=>setUserId('43')}>Fixture switch user</button><button onClick={()=>setRepositoryId('124')}>Fixture replace repository</button></div><RepositoryGitTransport client={client} userId={userId} signingOut={signingOut} target={{repository:{$typeName:'golf.v1.RepositoryKey',owner:'alice',name:'example'},repositoryId,ownerId:'42'}} /></main></QueryClientProvider>;
}
createRoot(document.getElementById('root')!).render(<Host />);
