import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createClient } from '@connectrpc/connect';
import { createConnectTransport } from '@connectrpc/connect-web';
import { RunnerControlService, RunnerPoolService } from '../../src/gen/golf/v1/golf_pb';
import { InstanceRunnerLimits } from '../../src/InstanceRunnerLimits';
import { InstanceRunnerPools } from '../../src/RunnerPools';
import '../../src/styles.css';
const client = createClient(RunnerControlService, createConnectTransport({ baseUrl: `${location.origin}/rpc`, useBinaryFormat: false }));
const poolClient = createClient(RunnerPoolService, createConnectTransport({ baseUrl: `${location.origin}/rpc`, useBinaryFormat: false }));
const queries = new QueryClient({ defaultOptions: { queries: { retry: false } } });
document.documentElement.dataset.theme = localStorage.getItem('golf.theme') || 'dark';
function Host() {
  const [props, setProps] = useState({ userId: '42', signingOut: false, revalidating: false });
  return <QueryClientProvider client={queries}><main className="workspace-content"><div className="credential-actions">
    <button type="button" onClick={() => setProps(p => ({ ...p, revalidating: true }))}>Fixture revalidate</button><button type="button" onClick={() => setProps(p => ({ ...p, revalidating: false }))}>Fixture restore access</button>
    <button type="button" onClick={() => setProps(p => ({ ...p, userId: '43' }))}>Fixture switch account</button><button type="button" onClick={() => setProps(p => ({ ...p, userId: '42' }))}>Fixture restore account</button><button type="button" onClick={() => setProps(p => ({ ...p, signingOut: true }))}>Fixture sign out</button>
    </div><InstanceRunnerLimits {...props} client={client} />{new URLSearchParams(location.search).has('pools') && <InstanceRunnerPools {...props} client={poolClient} />}</main></QueryClientProvider>;
}
createRoot(document.getElementById('root')!).render(<Host />);
