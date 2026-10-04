import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createClient } from '@connectrpc/connect';
import { createConnectTransport } from '@connectrpc/connect-web';
import { RunnerPoolService } from '../../src/gen/golf/v1/golf_pb';
import { InstanceRunnerPools, RepositoryRunnerPlacement } from '../../src/RunnerPools';
import '../../src/styles.css';

const client = createClient(RunnerPoolService, createConnectTransport({ baseUrl: `${location.origin}/rpc`, useBinaryFormat: false }));
const queries = new QueryClient({ defaultOptions: { queries: { retry: false } } });
const initial = { userId: '42', signingOut: false, revalidating: false, owner: 'alice', name: 'example', repositoryId: '9007199254740993', ownerId: '42', accessRevision: 'a'.repeat(64) };
document.documentElement.dataset.theme = localStorage.getItem('golf.theme') || 'dark';
function Host() {
  const [props, setProps] = useState(initial);
  return <QueryClientProvider client={queries}><main className="workspace-content"><div className="credential-actions">
    <button type="button" onClick={() => setProps(p => ({ ...p, revalidating: true }))}>Fixture revalidate</button>
    <button type="button" onClick={() => setProps(p => ({ ...p, revalidating: false }))}>Fixture restore access</button>
    <button type="button" onClick={() => setProps(p => ({ ...p, userId: '43' }))}>Fixture switch account</button>
    <button type="button" onClick={() => setProps(p => ({ ...p, userId: '42' }))}>Fixture restore account</button>
  </div>{new URLSearchParams(location.search).has('repository') ? <RepositoryRunnerPlacement {...props} client={client} /> : <InstanceRunnerPools {...props} client={client} />}</main></QueryClientProvider>;
}
createRoot(document.getElementById('root')!).render(<Host />);
