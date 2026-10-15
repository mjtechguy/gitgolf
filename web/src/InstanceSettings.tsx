import { OperationsDashboard } from './OperationsDashboard';
import { NativeInstallationAdmin } from './NativeInstallationAdmin';
import { InstallationAudit } from './InstallationPolicy';
import { NativeRunnerAdmin } from './NativeRunners';
import { NativePipelineRunners } from './NativePipelineRunners';
import {AdminMFARecovery,type AdminMFARecoveryDraft} from './AdminMFARecovery';
import { GolfUserAccess } from './GolfUserAccess';
import { InstanceRunnerLimits } from './InstanceRunnerLimits';
import { InstanceRunnerPools } from './RunnerPools';
import { InstanceRunnerControls } from './RunnerControls';
import { runnerPoolClient, runnerControlClient } from './api';
import { EmailTransportSettings } from './EmailNotificationSettings';
import { AgentUsagePanel } from './AgentUsagePanel';
import { AgentUsageScope } from './gen/golf/v1/golf_pb';
import { useEffect, useRef, useState } from 'react';
import { useForm } from '@tanstack/react-form';
import { useInfiniteQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { RefreshCw, ShieldOff } from 'lucide-react';
import { instanceAdminClient, errorMessage } from './api';
import { DataTable } from './DataTable';
import type { DataTableColumn } from './DataTable';
import type { LocalAccountInfo } from './gen/golf/v1/golf_pb';
import { DateLabel, Loading, More, PanelError, privateQuery } from './RepositoryUI';
import { OrganizationCreationPolicyPanel } from './OrganizationCreationPolicyPanel';
import { InfrastructureConnections } from './InfrastructureConnections';
import { ExecutionPolicyPanel } from './ExecutionPolicyPanel';
import { ExecutionScope } from './gen/golf/v1/golf_pb';
import { LocalAccountLifecycle, type LocalAccountIntent, type LocalAccountDraft } from './LocalAccountLifecycle';
import { AdminCodexConnections } from './AdminCodexConnections';
import { AgentHostSettings } from './AgentHostSettings';
import { AutomationSettings } from './AutomationSettings';
import { SettingsInventory } from './AccountSettings';
import { Capabilities } from './Capabilities';
import { useRuntimeCapabilities } from './useRuntimeCapabilities';
import { AdminFeatures } from './AdminFeatures';
import { AiModelSettings } from './AiModelSettings';
import { CredentialSettings } from './CredentialSettings';
import { EngineSettings } from './EngineSettings';
import { NativeAiUsage } from './NativeAiUsage';
import { EstimatedCosts } from './EstimatedCosts';
import { RunnerCapacity } from './RunnerCapacity';
import { settingAvailable, settingForRoute } from './runtimeCapabilities';

type AdminView = 'operations' | 'features' | 'ai-models' | 'ai-usage' | 'costs' | 'capacity' | 'credentials' | 'engines' | 'overview' | 'accounts' | 'execution' | 'organizations' | 'infrastructure' | 'agents' | 'automations' | 'notifications' | 'runners' | 'audit' | 'capabilities';
// One heading per administration page; the navigation names the section.
const pages: Record<AdminView | 'installation' | 'agent-hosts', [string, string]> = {
  installation: ['Installation', 'What this Cloudflare installation is allocated, its limits and today’s use. Infrastructure changes with a deploy; policy inside it can be changed here.'],
  overview: ['Admin portal', 'Golf account administration is separate from organization and repository ownership.'],
  features: ['Features and policies', 'Which features repositories on this installation can use. The deployment sets what exists at all; you choose within it, and repository administrators choose within your policy.'],
  'ai-models': ['AI models', 'Which Workers AI model each AI feature runs. The deploy list is the ceiling; you choose the default and the allowed models from this account’s catalog, and whether repositories may choose.'],
  credentials: ['Credentials', 'Installation API keys for engines, sealed in Golf’s credential vault under the installation’s Secrets Store key. Values are never shown again; you choose who may use each one.'],
  engines: ['Engines', 'Which engine each AI use case runs: a Workers AI model, or an OpenAI, Anthropic, xAI or Google model through the private AI Gateway with a vault key. This replaces per-use-case model selection; without a choice, the AI models setting applies.'],
  'ai-usage': ['AI usage', 'Workers AI runs, tokens and outcomes from Golf’s own records, with AI Gateway analytics when they can be read. Cloudflare billing is authoritative.'],
  costs: ['Estimated costs', 'What this installation’s Cloudflare usage costs at list prices so far this month, the month projected at that pace, and what a scale-up would cost. Estimates, not a bill.'],
  capacity: ['Runner capacity', 'What runs work for this installation and how much of it waits: self-hosted runner pools, native pools, Cloudflare containers, agent and SSH hosts. Golf never starts machines; autoscalers read queue depth here. Raising a limit is a request another administrator approves, with its estimated cost.'],
  operations: ['Operations', 'Connected services, current observations and usage. Configured means connected by configuration; available needs an observation. Unknown values are not zero.'],
  accounts: ['Accounts', 'Golf accounts, local sign-in and authenticator recovery. Instance administrators are protected.'],
  execution: ['Execution policy', 'Installation-wide limits on what workflows and agents may run.'],
  organizations: ['Organization creation', 'Who may create organizations on this installation.'],
  infrastructure: ['Infrastructure', 'Infrastructure profiles and source storage connections.'],
  agents: ['Coding agents', 'Installation coding agent connections and their usage.'],
  'agent-hosts': ['Agent hosts', 'Machines operations administrators connect to run Codex, Claude Code, OpenCode or Grok for issues and pull requests in every repository, under the sign-ins already on each machine.'],
  automations: ['Automations', 'Built-in tools and your own instructions that run on every repository of this installation, or the ones you list, when something happens, on a schedule or on request. They act as a person, open drafts a person publishes, and never merge.'],
  notifications: ['Email delivery', 'The installation’s outgoing email transport.'],
  audit: ['Audit log', 'The installation audit log: privileged and state-changing actions across this installation, its organizations and repositories. Who acted, what changed, when, from where, and whether it succeeded.'],
  capabilities: ['System capabilities', 'What this installation provides today, with the evidence behind each state.'],
  runners: ['Runners', 'Runner pools, limits and controls for this installation.'],
};

const columns: DataTableColumn<LocalAccountInfo>[] = [
  { id: 'account', accessorFn: account => `${account.username} ${account.email}`, header: 'Account', cell: ({ row }) => <><strong>{row.original.username}</strong><small>{row.original.email || 'No enrolled email'}</small></> },
  { id: 'role', accessorFn: account => account.isInstanceAdmin ? 'Instance administrator' : 'User', header: 'Golf role' },
  { id: 'status', accessorFn: account => account.disabled ? 'Disabled' : 'Enabled', header: 'Local sign-in', cell: ({ row }) => <span className="visibility">{row.original.disabled ? 'Disabled' : 'Enabled'}</span> },
  {id:'mfa',header:'Authenticator',accessorFn:account=>account.mfaEnabled?'Enabled':account.mfaPendingExpiresAt?'Setup pending':'Disabled'},
  { accessorKey: 'id', header: 'Account ID' },
  { accessorKey: 'nativeUserId', header: 'Mapped user ID' },
  { accessorKey: 'createdAt', header: 'Enrolled', cell: ({ row }) => <DateLabel value={row.original.createdAt} /> },
];

function DisableEditor({ account, pending, onSubmit, onCancel }: { account: LocalAccountInfo; pending: boolean; onSubmit: (password: string) => Promise<void>; onCancel: () => void }) {
  const form = useForm({ defaultValues: { password: '' }, onSubmit: async ({ value }) => { const password = value.password; form.reset(); await onSubmit(password); } });
  useEffect(() => { const clear = () => form.reset(); window.addEventListener('pagehide', clear); return () => { window.removeEventListener('pagehide', clear); form.reset(); }; }, [form]);
  return <form className="credential-form-content" aria-label="Disable local sign-in" onSubmit={event => { event.preventDefault(); void form.handleSubmit(); }}>
    <h3>Disable local sign-in for {account.username}</h3><p>This revokes this account’s Golf password sessions and dependent API credentials. Native Git credentials and provider logins remain separate. Instance administrator accounts are protected.</p>
    <p className="field-help">Account {account.id} · credential version {account.credentialVersion.toString()}. Re-enabling requires a fresh account password and an identity credential.</p>
    <form.Field name="password">{field => <label>Your Golf password<input type="password" name="password-confirmation" autoComplete="current-password" required minLength={15} maxLength={1024} disabled={pending} value={field.state.value} onBlur={field.handleBlur} onChange={event => field.handleChange(event.target.value)} /></label>}</form.Field>
    <div className="credential-actions"><button className="button primary" disabled={pending} type="submit">{pending ? 'Disabling…' : 'Confirm disable local sign-in'}</button><button className="button secondary" type="button" disabled={pending} onClick={() => { form.reset(); onCancel(); }}>Cancel</button></div>
  </form>;
}

export function InstanceSettings({ userId, signingOut, view = 'accounts' }: { userId: string; signingOut: boolean; view?: AdminView }) {
  const runtime = useRuntimeCapabilities();
  const available = (id: string) => settingAvailable(runtime.isError ? undefined : runtime.data, id);
  const [lifecycle, setLifecycle] = useState<LocalAccountIntent | null>(null);
  const [target, setTarget] = useState<LocalAccountInfo>();
  const [mfaTarget,setMFATarget]=useState<LocalAccountInfo>();
  const [pending, setPending] = useState(false);
  const [uncertain, setUncertain] = useState(false);
  const [notice, setNotice] = useState('');
  const controller = useRef<AbortController | null>(null);
  const active = useRef(true);
  const query = useInfiniteQuery({ ...privateQuery, queryKey: ['instance-local-accounts', userId], enabled: view === 'accounts', initialPageParam: 1,
    queryFn: ({ pageParam, signal }) => instanceAdminClient.listLocalAccounts({ page: { page: pageParam, limit: 20 } }, { signal, timeoutMs: 8_000 }),
    getNextPageParam: (page, _pages, currentPage) => { const next = page.page?.nextPage ?? 0; return next > currentPage && next <= 10_000 ? next : undefined; },
  });
  useEffect(() => { active.current = true; const abort = () => { if (controller.current) { controller.current.abort(); setUncertain(true); setNotice('The disable outcome could not be confirmed. Refresh and inspect current account state; no automatic retry was made.'); } setTarget(undefined);setMFATarget(undefined); setLifecycle(null); }; window.addEventListener('pagehide', abort); return () => { active.current = false; controller.current?.abort(); window.removeEventListener('pagehide', abort); }; }, []);
  useEffect(() => { if (signingOut) { if (controller.current) { controller.current.abort(); setUncertain(true); setNotice('The disable outcome could not be confirmed. Refresh and inspect current account state; no automatic retry was made.'); } setTarget(undefined);setMFATarget(undefined); setLifecycle(null); } }, [signingOut]);
  useEffect(() => { if (query.error || (query.isFetching && !query.isFetchingNextPage)) { setTarget(undefined);setMFATarget(undefined); setLifecycle(null); if (controller.current) { controller.current.abort(); setUncertain(true); } } }, [query.error, query.isFetching, query.isFetchingNextPage]);
  const accounts = query.isSuccess && !query.error && !signingOut && (!query.isFetching || query.isFetchingNextPage)
    ? [...new Map(query.data.pages.flatMap(page => page.accounts).map(account => [account.id, account])).values()] : [];
  const loading = query.isPending || (query.isFetching && !query.isFetchingNextPage) || signingOut;
  async function refresh() { if (controller.current) return; setTarget(undefined);setMFATarget(undefined); setLifecycle(null); const result = await query.refetch(); if (active.current && !result.error) setUncertain(false); }
  async function disable(password: string) {
    if (!target || controller.current || signingOut || uncertain) return;
    const current = target; const request = new AbortController(); controller.current = request; setPending(true); setNotice(''); setTarget(undefined);setMFATarget(undefined); setLifecycle(null);
    try {
      const response = await instanceAdminClient.disableLocalAccount({ accountId: current.id, expectedCredentialVersion: current.credentialVersion, passwordConfirmation: password }, { signal: request.signal, timeoutMs: 12_000 });
      if (!active.current || request.signal.aborted) return;
      if (!response.account || response.account.id !== current.id || response.account.nativeUserId !== current.nativeUserId || !response.account.disabled || response.account.isInstanceAdmin || !/^[1-9][0-9]{0,18}$/.test(current.credentialVersion) || response.account.credentialVersion !== (BigInt(current.credentialVersion) + 1n).toString() || !response.operationId) throw new Error('The disable result could not be verified.');
      setNotice(`Local sign-in disabled for ${current.username}. ${response.sessionsRevoked.toString()} password sessions revoked.`);
      if (controller.current === request) controller.current = null;
      await query.refetch();
    } catch (error) { if (active.current && !request.signal.aborted) { setUncertain(true); setNotice(`${errorMessage(error instanceof Error ? error : new Error('The disable outcome could not be confirmed.'))} Refresh and inspect the current account state before a separate attempt. No automatic retry was made.`); } }
    finally { password = ''; if (controller.current === request) controller.current = null; if (active.current) setPending(false); }
  }
  async function saveLifecycle(draft: LocalAccountDraft) {
    if (!lifecycle || controller.current || signingOut || uncertain) return;
    const observed = lifecycle; const request = new AbortController(); controller.current = request; setPending(true); setNotice('');
    try {
      const options = { signal: request.signal, timeoutMs: 15000 };
      const response = observed.kind === 'enroll' ? await instanceAdminClient.enrollRegularLocalAccount({ username: draft.username, email: draft.email, expectedNativeUserId: draft.expectedNativeUserId, password: draft.password, forgeToken: draft.forgeToken, passwordConfirmation: draft.passwordConfirmation }, options) : observed.kind === 'reset' ? await instanceAdminClient.resetRegularLocalPassword({ accountId: observed.account.id, expectedCredentialVersion: observed.account.credentialVersion, password: draft.password, passwordConfirmation: draft.passwordConfirmation }, options) : await instanceAdminClient.enableRegularLocalAccount({ accountId: observed.account.id, expectedCredentialVersion: observed.account.credentialVersion, password: draft.password, forgeToken: draft.forgeToken, passwordConfirmation: draft.passwordConfirmation }, options);
      if (!active.current || request.signal.aborted) return;
      const account = response.account;
      if (!account || account.isInstanceAdmin || !response.operationId || !/^[1-9][0-9]{0,18}$/.test(account.credentialVersion) || (observed.kind === 'enroll' ? account.nativeUserId !== draft.expectedNativeUserId || account.username !== draft.username || account.disabled || account.credentialVersion !== '1' : account.id !== observed.account.id || account.nativeUserId !== observed.account.nativeUserId || account.credentialVersion !== (BigInt(observed.account.credentialVersion) + 1n).toString() || account.disabled !== (observed.kind === 'reset' ? observed.account.disabled : false))) throw new Error('The account change could not be verified.');
      setLifecycle(null); setNotice(`${observed.kind === 'enroll' ? 'Local account enrolled' : observed.kind === 'enable' ? 'Local sign-in enabled' : 'Local password reset'} for ${account.username}. ${response.sessionsRevoked.toString()} password sessions revoked.`); if (controller.current === request) controller.current = null; await query.refetch();
    } catch (cause) { if (active.current && !request.signal.aborted) { setLifecycle(null); setUncertain(true); setNotice(`${errorMessage(cause instanceof Error ? cause : new Error('The account outcome could not be confirmed.'))} Refresh and inspect the current account state before a separate attempt. No automatic retry was made.`); } }
    finally { draft.password = ''; draft.repeatPassword = ''; draft.forgeToken = ''; draft.passwordConfirmation = ''; if (controller.current === request) controller.current = null; if (active.current) setPending(false); }
  }
  const adminMFA=query.isSuccess&&!query.error&&(!query.isFetching||query.isFetchingNextPage)?query.data.pages[0]:undefined;
  async function resetMFA(draft:AdminMFARecoveryDraft){
   if(!mfaTarget||!adminMFA||controller.current||signingOut||uncertain)return;
   const observed=mfaTarget,actorVersion=adminMFA.adminMfaVersion;const request=new AbortController();controller.current=request;setPending(true);setNotice('');
   try{const response=await instanceAdminClient.resetRegularLocalMFA({accountId:observed.id,golfUserId:observed.golfUserId,nativeUserId:observed.nativeUserId,expectedCredentialVersion:observed.credentialVersion,expectedMfaVersion:observed.mfaVersion,expectedAdminMfaVersion:actorVersion,passwordConfirmation:draft.password,adminMfaCode:draft.code,reason:draft.reason,acknowledgeWarning:draft.acknowledge},{signal:request.signal,timeoutMs:15000});
    if(!active.current||request.signal.aborted)return;const account=response.account;if(!account||account.id!==observed.id||account.golfUserId!==observed.golfUserId||account.nativeUserId!==observed.nativeUserId||account.isInstanceAdmin||account.mfaEnabled||account.mfaPendingExpiresAt||account.disabled!==observed.disabled||account.credentialVersion!==(BigInt(observed.credentialVersion)+1n).toString()||account.mfaVersion!==(BigInt(observed.mfaVersion)+1n).toString()||!response.operationId)throw new Error('Authenticator recovery could not be verified.');
    setMFATarget(undefined);setNotice(`Authenticator reset for ${account.username}. ${response.sessionsRevoked} password sessions and ${response.challengesRevoked} sign-in challenges revoked. Ask the user to set up a new authenticator.`);if(controller.current===request)controller.current=null;await query.refetch();
   }catch(cause){if(active.current&&!request.signal.aborted){setMFATarget(undefined);setUncertain(true);setNotice(`${errorMessage(cause instanceof Error?cause:new Error('Authenticator recovery could not be confirmed.'))} Refresh and inspect the account before another explicit action. No automatic retry was made.`);}}
   finally{draft.password='';draft.code='';draft.reason='';if(controller.current===request)controller.current=null;if(active.current)setPending(false);}
  }
  const accountColumns: DataTableColumn<LocalAccountInfo>[] = [...columns, { id: 'actions', header: 'Action', enableSorting: false, enableGlobalFilter: false, cell: ({ row }) => row.original.isInstanceAdmin ? <span className="muted">Protected administrator</span> : row.original.nativeUserId === userId ? <span className="muted">Your account</span> : <div className="credential-actions">{(row.original.mfaEnabled||row.original.mfaPendingExpiresAt)&&/^[1-9][0-9]{0,18}$/.test(row.original.mfaVersion)&&row.original.golfUserId&&adminMFA?.adminMfaVersion?<button className="icon-button" title="Recover authenticator access" aria-label={`Recover authenticator for ${row.original.username}`} disabled={pending||uncertain||signingOut||Boolean(target)||Boolean(lifecycle)||Boolean(mfaTarget)} onClick={()=>{setMFATarget(row.original);setNotice('');}}><ShieldOff size={16}/></button>:null}<button className="text-button" disabled={pending || uncertain || signingOut || Boolean(target) || Boolean(lifecycle)||Boolean(mfaTarget)} onClick={() => { setLifecycle({ kind: 'reset', account: row.original }); setNotice(''); }}>Reset password</button>{row.original.disabled ? <button className="text-button" disabled={pending || uncertain || signingOut || Boolean(target) || Boolean(lifecycle)||Boolean(mfaTarget)} onClick={() => { setLifecycle({ kind: 'enable', account: row.original }); setNotice(''); }}>Enable local sign-in</button> : <button className="text-button" disabled={pending || uncertain || signingOut || Boolean(target) || Boolean(lifecycle)||Boolean(mfaTarget)} onClick={() => { setTarget(row.original); setNotice(''); }}>Disable local sign-in</button>}</div> }];
  const native = runtime.data?.runtimeProfile === 'cloudflare-native';
  // Native administration pages without a service move to one group at the foot once the installation has reported.
  const missing = native && runtime.isSuccess ? ([['/admin/execution', 'Execution policy', 'settings.execution'], ['/admin/organizations', 'Organization creation', 'settings.organization-creation'], ['/admin/agents', 'Agent hosts', 'agents.hosts']] as const).filter(([, , id]) => !available(id)) : [];
  const shown = (to: string) => !missing.some(([path]) => path === to);
  const [title, description] = pages[view === 'overview' && native ? 'installation' : view === 'agents' && native ? 'agent-hosts' : view];
  return <div className="account-layout"><nav className="account-navigation" aria-label="Instance administration"><span className="eyebrow">{native ? 'WORKSPACE ADMINISTRATION' : 'GLOBAL ADMINISTRATION'}</span><Link to="/admin" activeOptions={{ exact: true }}>Overview</Link><Link to="/admin/operations">Operations</Link>{available('operations.ai-usage') && <Link to="/admin/ai-usage" activeOptions={{ exact: true }}>AI usage</Link>}{available('operations.costs') && <Link to="/admin/costs" activeOptions={{ exact: true }}>Estimated costs</Link>}{available('operations.capacity') && <Link to="/admin/capacity" activeOptions={{ exact: true }}>Runner capacity</Link>}{available('settings.ai-models') && <Link to="/admin/ai" activeOptions={{ exact: true }}>AI models</Link>}{available('settings.engines') && <Link to="/admin/engines" activeOptions={{ exact: true }}>Engines</Link>}{available('settings.credentials') && <Link to="/admin/credentials" activeOptions={{ exact: true }}>Credentials</Link>}{available('settings.installation-audit') && <Link to="/admin/audit" activeOptions={{ exact: true }}>Audit log</Link>}
    {available('settings.feature-policy') && <Link to="/admin/features" activeOptions={{ exact: true }}>Features and policies</Link>}
    {available('settings.local-auth') && <Link to="/admin/settings" activeOptions={{ exact: true }}>Accounts</Link>}{shown('/admin/execution') && <Link to="/admin/execution" activeOptions={{ exact: true }}>Execution policy</Link>}{shown('/admin/organizations') && <Link to="/admin/organizations" activeOptions={{ exact: true }}>Organization creation</Link>}{available('settings.infrastructure') && <Link to="/admin/settings/infrastructure" activeOptions={{ exact: true }}>Infrastructure</Link>}{shown('/admin/agents') && <Link to="/admin/agents" activeOptions={{ exact: true }}>{native ? 'Agent hosts' : 'Coding agents'}</Link>}{native && available('automations') && <Link to="/admin/automations" activeOptions={{ exact: true }}>Automations</Link>}{available(native ? 'settings.native-runners' : 'settings.runners') && <Link to="/admin/settings/runners" activeOptions={{ exact: true }}>Runners</Link>}{available('settings.notifications') && <Link to="/admin/settings/notifications" activeOptions={{ exact: true }}>Email delivery</Link>}<Link to="/admin/capabilities" activeOptions={{ exact: true }}>System capabilities</Link>
    {missing.length ? <details className="settings-navigation-group settings-navigation-unavailable" open={missing.some(([, , id]) => settingForRoute('instance-settings', view, true) === id) || undefined}><summary>Not on this installation<span>{missing.length}</span></summary>{missing.map(([to, label]) => <Link key={to} to={to} activeOptions={{ exact: true }}><span className="settings-navigation-label">{label}</span></Link>)}</details> : null}</nav><div className="account-content"><section className="page-stack" aria-labelledby="instance-settings-title">
    <header className="repository-intro"><div><h1 id="instance-settings-title">{title}</h1><p>{description}</p></div></header>
    {view === 'capabilities' ? <Capabilities isInstanceAdmin /> : view === 'features' ? <AdminFeatures userId={userId} signingOut={signingOut} /> : view === 'audit' ? <InstallationAudit userId={userId} signingOut={signingOut} /> : view === 'operations' ? <OperationsDashboard userId={userId} signingOut={signingOut} /> : view === 'ai-models' ? <AiModelSettings userId={userId} signingOut={signingOut} /> : view === 'ai-usage' ? <NativeAiUsage userId={userId} signingOut={signingOut} /> : view === 'costs' ? <EstimatedCosts userId={userId} signingOut={signingOut} /> : view === 'capacity' ? <RunnerCapacity userId={userId} signingOut={signingOut} /> : view === 'credentials' ? <CredentialSettings key={userId} target={{ scope: 'installation' }} userId={userId} /> : view === 'engines' ? <EngineSettings key={userId} target={{ scope: 'installation' }} userId={userId} /> : view === 'runners' ? runtime.data?.runtimeProfile === 'cloudflare-native' ? <div className="page-stack"><NativePipelineRunners target={{ scope: 'installation' }} userId={userId} /><NativeRunnerAdmin /></div> : <div className="page-stack"><InstanceRunnerLimits userId={userId} signingOut={signingOut} revalidating={false} client={runnerControlClient} /><InstanceRunnerPools userId={userId} signingOut={signingOut} revalidating={false} client={runnerPoolClient} /><InstanceRunnerControls userId={userId} signingOut={signingOut} revalidating={false} client={runnerControlClient} /></div> : view === 'notifications' ? <EmailTransportSettings userId={userId} signingOut={signingOut} /> : view === 'agents' && native ? <AgentHostSettings key={userId} target={{ scope: 'installation' }} userId={userId} /> : view === 'automations' ? native ? <AutomationSettings key={userId} target={{ scope: 'installation' }} userId={userId} /> : <p className="field-help">Automations are available on the Cloudflare-native runtime.</p> : view === 'agents' ? <div className="page-stack"><AdminCodexConnections key={userId} userId={userId} signingOut={signingOut} /><AgentUsagePanel userId={userId} signingOut={signingOut} scope={AgentUsageScope.INSTANCE} /></div> : view === 'infrastructure' ? <InfrastructureConnections userId={userId} signingOut={signingOut} /> : view === 'overview' ? native ? <NativeInstallationAdmin userId={userId} signingOut={signingOut} /> : <SettingsInventory scope="instance" /> : view === 'execution' ? <ExecutionPolicyPanel key={`${userId}/instance`} userId={userId} signingOut={signingOut} scope={ExecutionScope.INSTANCE} /> : view === 'organizations' ? <OrganizationCreationPolicyPanel key={`${userId}/organization-creation`} userId={userId} signingOut={signingOut} /> : <div className="page-stack"><GolfUserAccess key={userId} userId={userId} signingOut={signingOut} /><section className="browser-panel credential-list-panel" aria-labelledby="instance-accounts-title">
      <div className="browser-panel-heading"><h2 id="instance-accounts-title">Local accounts</h2><button className="button primary" disabled={loading || Boolean(query.error) || pending || uncertain || signingOut || Boolean(target) || Boolean(lifecycle)||Boolean(mfaTarget)} onClick={() => { setLifecycle({ kind: 'enroll' }); setNotice(''); }}>New local account</button><button className="button secondary" disabled={query.isFetching || pending || signingOut} onClick={() => void refresh()}><RefreshCw size={15} />Refresh local accounts</button></div>
      {notice && !signingOut ? <p className="panel-footnote" role={uncertain ? 'alert' : 'status'}>{notice}</p> : null}
      {query.error ? <PanelError error={query.error} retry={() => void refresh()} /> : loading ? <Loading label="Verifying instance administration…" /> : <>{mfaTarget&&adminMFA?<AdminMFARecovery key={`${mfaTarget.id}/${mfaTarget.credentialVersion}/${mfaTarget.mfaVersion}`} account={mfaTarget} adminMFAEnabled={adminMFA.adminMfaEnabled} pending={pending} submit={resetMFA} cancel={()=>setMFATarget(undefined)}/>:null}{lifecycle ? <LocalAccountLifecycle key={lifecycle.kind === 'enroll' ? 'enroll' : `${lifecycle.kind}/${lifecycle.account.id}/${lifecycle.account.credentialVersion}`} intent={lifecycle} pending={pending} onSubmit={saveLifecycle} onCancel={() => setLifecycle(null)} /> : null}{target ? <DisableEditor key={`${target.id}/${target.credentialVersion}`} account={target} pending={pending} onSubmit={disable} onCancel={() => setTarget(undefined)} /> : null}<DataTable data={accounts} columns={accountColumns} getRowId={account => account.id} label="Local accounts" /><div className="list-footer"><span>{accounts.length} loaded</span><More hasMore={Boolean(query.hasNextPage)} loading={query.isFetchingNextPage || pending || Boolean(target) || Boolean(lifecycle)||Boolean(mfaTarget)} load={() => void query.fetchNextPage()} label="accounts" /></div></>}
      <p className="panel-footnote">This inventory contains enrolled Golf accounts, including disabled accounts. It does not list every Git or OAuth user. Administrators can enroll existing Git identities and reset, enable or disable ordinary local accounts after password confirmation. Authenticator recovery is separate, requires your enrolled factor, and never targets administrators. Instance administrators are protected; native Git credentials and provider logins remain separate.</p>
    </section></div>}
  </section></div></div>;
}
