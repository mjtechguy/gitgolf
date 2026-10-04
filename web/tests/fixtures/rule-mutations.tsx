import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { create } from '@bufbuild/protobuf';
import { createClient } from '@connectrpc/connect';
import { createConnectTransport } from '@connectrpc/connect-web';
import { GetRepositoryRulesResponseSchema, RepositoryRulesService } from '../../src/gen/golf/v1/golf_pb';
import { RuleMutationActions } from '../../src/RuleMutationActions';
import '../../src/styles.css';
const timestamp='2026-10-04T00:00:00Z';
const inventory=create(GetRepositoryRulesResponseSchema,{repositoryId:'9007199254740993',ownerId:'42',accessRevision:'a'.repeat(64),rulesRevision:'b'.repeat(64),branchProtections:[{ruleName:'main',priority:'0',requiredApprovals:'1',enablePush:true,createdAt:timestamp,updatedAt:timestamp}],tagProtections:[{id:'9007199254740994',namePattern:'v*',allowedUsernames:['alice'],createdAt:timestamp,updatedAt:timestamp}],mergeConfiguration:{allowMergeCommits:true,allowSquashMerge:true,allowMergeUpdate:true,defaultMergeStyle:'squash',defaultUpdateStyle:'merge'}});
const client=createClient(RepositoryRulesService,createConnectTransport({baseUrl:`${location.origin}/rpc`,useBinaryFormat:false}));
document.documentElement.dataset.theme=localStorage.getItem('golf.theme')||'dark';
function Host(){const [user,setUser]=useState('42');const [disabled,setDisabled]=useState(false);const [revision,setRevision]=useState(inventory.rulesRevision);const [verified,setVerified]=useState(0);return <QueryClientProvider client={new QueryClient()}><main className="workspace-content"><div className="credential-actions"><button onClick={()=>setDisabled(true)}>Fixture revoke</button><button onClick={()=>{setDisabled(true);setUser('43')}}>Fixture account switch</button><button onClick={()=>{setUser('42');setDisabled(false)}}>Fixture restore account</button><button onClick={()=>setRevision('c'.repeat(64))}>Fixture configuration changed</button><span data-testid="verified-count">{verified}</span></div><RuleMutationActions client={client} userId={user} owner="alice" name="example" inventory={{...inventory,rulesRevision:revision}} disabled={disabled} onVerified={()=>setVerified(v=>v+1)} onUnavailable={()=>setDisabled(true)} /></main></QueryClientProvider>}
createRoot(document.getElementById('root')!).render(<Host/>);
