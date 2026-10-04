// Test-only component host: no product routing or capability implementation.
import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { create } from '@bufbuild/protobuf';
import { createClient } from '@connectrpc/connect';
import { createConnectTransport } from '@connectrpc/connect-web';
import { RepositoryAccessSchema, RepositoryRulesService } from '../../src/gen/golf/v1/golf_pb';
import { RepositoryRules } from '../../src/RepositoryRules';
import '../../src/styles.css';
const cache = new QueryClient({ defaultOptions: { queries: { retry: false } } });
const transport = createClient(RepositoryRulesService, createConnectTransport({ baseUrl: `${location.origin}/rpc`, useBinaryFormat: false }));
document.documentElement.dataset.theme = localStorage.getItem('golf.theme') || 'dark';
function Host() {
 const [out, signOut] = useState(false); const [refresh, revalidate] = useState(false); const [user, changeUser] = useState('17'); const [id, target] = useState('9007199254740993');
 const access = create(RepositoryAccessSchema, { repositoryId: id, ownerId: '42', revision: 'a'.repeat(64), currentPermission: 'admin', canManage: true });
 return <QueryClientProvider client={cache}><main className="workspace-content"><div className="credential-actions"><button onClick={() => signOut(true)}>Fixture sign out</button><button onClick={() => revalidate(v => !v)}>Fixture target refresh</button><button onClick={() => changeUser('18')}>Fixture switch account</button><button onClick={() => target('13')}>Fixture replaced target</button></div><RepositoryRules client={transport} owner="alice" name="example" userId={user} access={access} signingOut={out} revalidating={refresh} /></main></QueryClientProvider>;
}
createRoot(document.getElementById('root')!).render(<Host />);
