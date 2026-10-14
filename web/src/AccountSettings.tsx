import { NativeInstallationSettings } from './NativeForge';
import { AgentUsagePanel } from './AgentUsagePanel';
import { useRuntimeCapabilities } from './useRuntimeCapabilities';
import { runtimeFeature, settingAvailable, emailNotificationsMounted } from './runtimeCapabilities';
import { AgentUsageScope } from './gen/golf/v1/golf_pb';
import { ProfileSettings } from './ProfileSettings';
import { AppearanceSettings } from './ThemeSwitch';
import { ExecutionPolicyPanel } from './ExecutionPolicyPanel';
import { ExecutionScope } from './gen/golf/v1/golf_pb';
import { lazy, Suspense, useMemo, useState, type ReactNode } from 'react';
import { Link, useLocation, useNavigate } from '@tanstack/react-router';
import { Rocket, Server, MailPlus, Webhook, History, KeyRound, Plug, ShieldCheck, Tags, UserRound } from 'lucide-react';
import type { User } from './gen/golf/v1/golf_pb';
import { DataTable, type DataTableColumn } from './DataTable';
import { useQuery } from '@tanstack/react-query';
import { organizationClient } from './api';
import { Loading, PanelError, privateQuery } from './RepositoryUI';
import type { AccessObservationTarget } from './RepositoryAccessObservation';

const OwnEmailNotifications = lazy(() => import('./EmailNotificationSettings').then(module => ({ default: module.OwnEmailNotifications })));
const RepositoryAccessObservation = lazy(() => import('./RepositoryAccessObservation').then(module => ({ default: module.RepositoryAccessObservation })));

export function AccountLayout({ children }: { children: ReactNode }) {
  const runtime = useRuntimeCapabilities(), localAuth = settingAvailable(runtime.isError ? undefined : runtime.data, 'settings.local-auth');
  // The native runtime has no provider connection, agent account, API credential or account activity service.
  const portable = runtime.data?.runtimeProfile !== 'cloudflare-native';
  return <div className="account-layout"><nav className="account-navigation" aria-label="Account settings"><span className="eyebrow">PERSONAL SETTINGS</span>
    <Link to="/account/settings" activeOptions={{ exact:true }}><UserRound size={18} />Profile</Link>
    {localAuth && <Link to="/account/security" activeOptions={{ exact:true }}><ShieldCheck size={18} />Sign-in and security</Link>}
    <Link to="/account/invitations" activeOptions={{ exact:true }}><MailPlus size={18} />Invitations</Link>
    {portable && <Link to="/account/connections" activeOptions={{exact:true}}><Plug size={18}/>Provider connections</Link>}
    {portable && <Link to="/account/agents" activeOptions={{ exact:true }}><KeyRound size={18} />Coding agents</Link>}
    {localAuth && <Link to="/account/sessions" activeOptions={{ exact:true }}><ShieldCheck size={18} />Sessions</Link>}
    {localAuth && <Link to="/account/ssh-keys" activeOptions={{ exact:true }}><KeyRound size={18} />SSH keys</Link>}
    {portable && <Link to="/account/api-credentials" activeOptions={{ exact:true }}><KeyRound size={18} />API credentials</Link>}
    {portable && <Link to="/audit" activeOptions={{ exact:true }}><History size={18} />Account activity</Link>}
  </nav><div className="account-content">{children}</div></div>;
}

export function OrganizationSettingsLayout({ children, organization }: { children: ReactNode; organization: string }) {
  // The native runtime has no organization label or organization value service.
  const portable = useRuntimeCapabilities().data?.runtimeProfile !== 'cloudflare-native';
  return <div className="account-layout"><nav className="account-navigation" aria-label="Organization settings"><span className="eyebrow">ORGANIZATION SETTINGS</span>
    <Link to="/organizations/$organization/settings" params={{ organization }} activeOptions={{ exact: true }}><UserRound size={18} />General</Link>
    {portable && <Link to="/organizations/$organization/settings/labels" params={{organization}} activeOptions={{exact:true}}><Tags size={18}/>Labels</Link>}
    {portable && <Link to="/organizations/$organization/settings/secrets" params={{ organization }} activeOptions={{ exact: true }}><KeyRound size={18} />Secrets and variables</Link>}
    <Link to="/organizations/$organization" params={{ organization }} activeOptions={{ exact: true }}><ShieldCheck size={18} />Members and teams</Link>
  </nav><div className="account-content">{children}</div></div>;
}

export function RepositorySettingsLayout({ children, owner, name }: { children: ReactNode; owner: string; name: string }) {
  const runtime = useRuntimeCapabilities(), navigate = useNavigate();
  const manifest = runtime.isError ? undefined : runtime.data;
  // Own repository email shares the Webhooks page; on the native runtime it can be allocated without webhooks.
  const emailOnly = manifest?.runtimeProfile === 'cloudflare-native' && !settingAvailable(manifest, 'settings.repository-webhooks') && emailNotificationsMounted(manifest);
  const pathname = useLocation({select: location => location.pathname});
  const entries = [
    { label: 'General', group: '', suffix: '', icon: UserRound, enabled: runtimeFeature(manifest, 'settings.repository-general'), to: '/$owner/$name/settings' },
    { label: 'Access', group: 'Access and security', suffix: '/access', icon: ShieldCheck, enabled: runtimeFeature(manifest, 'settings.repository-access'), to: '/$owner/$name/settings/access' },
    { label: 'Git credentials', group: 'Access and security', suffix: '/git', icon: KeyRound, enabled: runtimeFeature(manifest, 'settings.repository-git'), to: '/$owner/$name/settings/git' },
    { label: 'Rules and merge policy', group: 'Access and security', suffix: '/rules', icon: ShieldCheck, enabled: runtimeFeature(manifest, 'settings.repository-rules'), to: '/$owner/$name/settings/rules' },
    { label: 'Workflows', group: 'Automation', suffix: '/workflows', icon: History, enabled: runtimeFeature(manifest, 'settings.repository-workflows'), to: '/$owner/$name/settings/workflows' },
    { label: 'Runners', group: 'Automation', suffix: '/runners', icon: Server, enabled: settingAvailable(runtime.isError ? undefined : runtime.data, runtime.data?.runtimeProfile === 'cloudflare-native' ? 'settings.native-runners' : 'settings.runners'), to: '/$owner/$name/settings/runners' },
    { label: 'Secrets and variables', group: 'Automation', suffix: '/secrets', icon: KeyRound, enabled: runtimeFeature(manifest, 'settings.repository-secrets'), to: '/$owner/$name/settings/secrets' },
    { label: 'Environments', group: 'Automation', suffix: '/environments', icon: Rocket, enabled: runtimeFeature(manifest, 'settings.repository-environments'), to: '/$owner/$name/settings/environments' },
    { label: emailOnly ? 'Email notifications' : 'Webhooks', group: 'Integrations', suffix: '/webhooks', icon: Webhook, enabled: runtimeFeature(manifest, 'settings.repository-webhooks') || emailOnly, to: '/$owner/$name/settings/webhooks' },
  ] as const;
  const availability = (enabled: boolean) => enabled ? '' : runtime.isPending ? 'Checking…' : runtime.isError ? 'Status unknown' : 'Unavailable';
  const current = entries.find(entry => pathname.endsWith('/settings'+entry.suffix));
  // Once the installation has reported, sections it does not provide move to one group at the foot.
  const settled = runtime.isSuccess, missing = settled ? entries.filter(entry => !entry.enabled) : [];
  return <div className="account-layout repository-settings-layout">
    <label className="settings-section-picker">Settings section<select aria-label="Settings section" value={current?.to || ''} onChange={event=>{const entry=entries.find(item=>item.to===event.target.value);if(entry)void navigate({to:entry.to,params:{owner,name}});}}>
      {!current ? <option value="" disabled>Current settings page</option> : null}
      {entries.map(entry=><option key={entry.to} value={entry.to}>{entry.label}{availability(entry.enabled) ? ` — ${availability(entry.enabled)}` : ''}</option>)}
    </select></label>
    <nav className="account-navigation" aria-label="Repository settings">
      {['', 'Access and security', 'Automation', 'Integrations'].map(group => {const items=entries.filter(entry=>entry.group===group&&(entry.enabled||!settled));return items.length ? <div className="settings-navigation-group" key={group}>{group?<h2>{group}</h2>:null}{items.map(entry=><Link key={entry.to} to={entry.to} params={{owner,name}} activeOptions={{exact:true}}><entry.icon size={18} aria-hidden="true"/><span className="settings-navigation-label">{entry.label}{availability(entry.enabled) ? <small>{availability(entry.enabled)}</small> : null}</span></Link>)}</div>:null;})}
      {missing.length ? <details className="settings-navigation-group settings-navigation-unavailable" open={missing.some(entry => entry === current) || undefined}><summary>Not on this installation<span>{missing.length}</span></summary>{missing.map(entry=><Link key={entry.to} to={entry.to} params={{owner,name}} activeOptions={{exact:true}}><entry.icon size={18} aria-hidden="true"/><span className="settings-navigation-label">{entry.label}</span></Link>)}</details> : null}
    </nav><div className="account-content">{children}</div>
  </div>;
}

export function AccountSettings({ user, signingOut }: { user: User; signingOut: boolean }) {
  const runtime = useRuntimeCapabilities();
  const native = runtime.data?.runtimeProfile === 'cloudflare-native';
  const [showInstallation, setShowInstallation] = useState(false);
  return <section className="page-stack" aria-labelledby="settings-title">
    <header className="repository-intro"><div><span className="eyebrow">YOUR GOLF ACCOUNT</span><h1 id="settings-title"><UserRound size={29} />Profile</h1><p>Your identity, access and account preferences.</p></div></header>
    <ProfileSettings key={user.id} userId={user.id} signingOut={signingOut} isInstanceAdmin={user.isInstanceAdmin} />
    <AppearanceSettings />
    {native && emailNotificationsMounted(runtime.isError ? undefined : runtime.data) ? <Suspense fallback={<Loading label="Opening notification settings…" />}><OwnEmailNotifications userId={user.id} signingOut={signingOut} native /></Suspense> : null}
    {native ? <details className="settings-diagnostics" onToggle={event=>setShowInstallation(event.currentTarget.open)}><summary>Installation details</summary>{showInstallation && <NativeInstallationSettings/>}</details> : runtime.isSuccess ? <Suspense fallback={<Loading label="Opening notification settings…" />}><OwnEmailNotifications userId={user.id} signingOut={signingOut} /></Suspense> : null}
    <SettingsInventory scope="personal" />
  </section>;
}

export type SettingsScope = 'personal' | 'organization' | 'repository' | 'instance';
type SettingEntry = { id: string; section: string; state: 'Ready' | 'Partial' | 'Read only' | 'Planned' | 'Unavailable'; unavailable?: boolean; detail: string; task: string; to?: '/account/connections' | '/account/agents' | '/account/security' | '/account/sessions' | '/account/ssh-keys' | '/account/api-credentials' | '/audit' | '/' | '/organizations' | '/status' | '/admin/execution' | '/admin/organizations' | '/admin/settings/runners' | '/admin/settings/notifications' | '/admin/settings/infrastructure' | '/admin/settings' | '/admin/agents'; hash?: string };
const inventory: Record<SettingsScope, SettingEntry[]> = {
  personal: [
    { id: 'profile', section: 'Profile and email', state: 'Partial', detail: 'Edit public profile fields above. Golf sign-in email changes have a separate security page; username changes and verified-email password recovery remain planned. Notification mailbox verification is configured separately.', task: 'P1.3 / G1' },
    { id: 'providers', section: 'GitHub and GitLab connections', state: 'Partial', detail: 'Personal encrypted provider tokens, selected import previews and original code-clone receipts are available. Complete metadata and private-provider migration fidelity remain required.', task: 'P2', to: '/account/connections' },
    { id: 'authentication', section: 'Passwords, recovery and MFA', state: 'Partial', detail: 'Manage your Golf password, sign-in alias, authenticator app and single-use MFA recovery codes. Sensitive changes confirm password and enrolled factor, then revoke local sessions and dependent API credentials. Passkeys and verified-email password recovery remain planned.', task: 'P1.3', to: '/account/security' },
    { id: 'sessions', section: 'Browser sessions', state: 'Ready', detail: 'List active sessions and revoke one or all others. This does not revoke native Git keys or provider grants.', task: 'P1.3', to: '/account/sessions' },
    { id: 'keys', section: 'SSH keys', state: 'Ready', detail: 'Manage persistent native account SSH keys. Signing-key management and scoped/expiring agent Git credentials are still planned.', task: 'P1.8 / P5.5', to: '/account/ssh-keys' },
    { id: 'signing', section: 'Signing keys', state: 'Planned', detail: 'Signing-key enrollment and revocation need dedicated supported APIs and signature/trust qualification; SSH authentication keys are managed separately.', task: 'P1.8 / P2.3' },
    { id: 'credentials', section: 'API credentials', state: 'Ready', detail: 'Issue source-session-bound read credentials or explicit repository-bound issue/PR write scopes. Service accounts and managed device login remain separate.', task: 'P1.8 / P5.5', to: '/account/api-credentials' },
    { id: 'identity', section: 'Connected identities and integrations', state: 'Planned', detail: 'Optional provider OAuth sign-in exists; account linking/unlinking, external OIDC and installation approval need explicit immutable identity binding.', task: 'P1.3 / G2' },
    { id: 'notifications', section: 'Notifications and email', state: 'Partial', detail: 'Verify your notification mailbox and explicitly enable portable repository email subscriptions. Delivery uses an administrator-configured SMTP worker; richer preferences, inbound replies and Cloudflare delivery remain required.', task: 'P3 / P6' },
    { id: 'appearance', section: 'Appearance', state: 'Ready', detail: 'Choose Classic, Golf or Flare and light or dark mode above. Choices are stored in this browser; synchronized account preferences are not implemented.', task: 'P1.4' },
    { id: 'activity', section: 'Account activity', state: 'Ready', detail: 'Inspect recorded successful session changes. Export, retention policy and broader security events remain planned.', task: 'P1.3', to: '/audit' },
    { id: 'agents', section: 'Agent tools and provider credentials', state: 'Partial', detail: 'Connect and re-authenticate your own Codex account, and view instance connections shared with you in Coding agents. Model access and task execution are not verified by authentication; Claude Code/OpenCode account setup and scoped usage configuration are available; managed execution remains planned.', task: 'P5 / G4', to: '/account/agents' },
  ],
  organization: [
    { id: 'members', section: 'Members, teams and roles', state: 'Partial', detail: 'Browse teams and manage existing account membership in ordinary teams as an organization owner. Invitations, team grant editors and delegated Golf roles still require implementation and ownership safeguards.', task: 'P1.5 / G1', to: '/organizations' },
    { id: 'defaults', section: 'Repository execution selection', state: 'Ready', detail: 'Organization owners configure disabled/all/selected repository eligibility and exact workflow selection below. Instance and repository ceilings still apply. Repository creation defaults remain planned.', task: 'G2 / G3' },
    { id: 'ci', section: 'CI, workflows and fork trust', state: 'Partial', detail: 'Manual shell jobs use durable admission, leases and isolated Docker workers. Native engine compatibility, remote actions, event triggers and fork approvals need further qualification.', task: 'P4 / G3' },
    { id: 'runners', section: 'Runner groups', state: 'Planned', detail: 'Repository/workflow access, pool labels, capacity, registration, drain and revocation need actual runner pools; labels alone cannot authorize execution.', task: 'P4 / G3' },
    { id: 'secrets', section: 'Secrets, variables and OIDC', state: 'Planned', detail: 'Selected-repository scopes, environment gates, rotation and workload identity require a credential broker and admission-time policy.', task: 'G3 / G5' },
    { id: 'rules', section: 'Rulesets and review policy', state: 'Planned', detail: 'Organization rules need qualified direct Git/API/background mutation control and trusted check producers; native observations do not establish Golf protection.', task: 'P0.8 / P2.3 / G5' },
    { id: 'agents', section: 'Agents, MCP and network policy', state: 'Planned', detail: 'Repository selection, harness/model allowlists, tool approvals and setup/sidecar egress limits require actual execution boundaries.', task: 'P5 / G4' },
    { id: 'connections', section: 'Connections, tokens and app approvals', state: 'Planned', detail: 'GitHub/GitLab imports, integration installation review and producer/consumer workflow sharing need verified connections and independent authority.', task: 'P2 / G2 / G3' },
    { id: 'budgets', section: 'Budgets and infrastructure', state: 'Planned', detail: 'Concurrency/cost limits and eligible Cloudflare accounts/zones or portable pools need measured capacity, authorized fallback and deny enforcement.', task: 'G3–G5 / P6.4' },
    { id: 'audit', section: 'Organization audit and retention', state: 'Planned', detail: 'Own-account session history exists; organization policy/membership/execution history, exports and retention require broader durable events.', task: 'P1.3 / G2 / G6' },
  ],
  repository: [
    { id: 'general', section: 'General and features', state: 'Partial', detail: 'General configuration requires a verified current native read. Website/topics and explicit tracker/wiki controls are separately qualified; a native wiki configuration is not a Golf workspace.', task: 'P1.4 / G1' },
    { id: 'access', section: 'Collaborators and deploy keys', state: 'Partial', detail: 'Qualified grants, invitations, team associations and read/write deploy keys for personal and organization repositories. Current observation, recovery and deployment-track acceptance remain required.', task: 'P1.5 / P1.8' },
    { id: 'rules', section: 'Rulesets, reviews and merge policy', state: 'Partial', detail: 'Versioned branch/tag rules and merge defaults have durable receipts. Protected merge execution, inherited policies and trusted checks remain required.', task: 'P0.8 / P2.3 / G5' },
    { id: 'ci', section: 'CI engines and workflow controls', state: 'Partial', detail: 'Manual and signed-push workflows run with policy ceilings; the pinned Actions engine supports matrix/dependency/composite graphs and job/step logs. Broader compatibility, triggers, artifacts and cache remain required.', task: 'P4 / G3' },
    { id: 'runners', section: 'Runners and resource limits', state: 'Partial', detail: 'Named Docker pools enforce placement, capacity and inherited resource limits. Administrators can drain or revoke workers. Expanded enrollment, scale testing and other runtimes remain required.', task: 'P4 / G3' },
    { id: 'secrets', section: 'Secrets, variables and OIDC', state: 'Partial', detail: 'Versioned secrets and variables support exact-source approval, verified TLS release and selected-repository organization inheritance. Typed input-bound approvals, environments, additional consumers and OIDC remain required.', task: 'G3 / G5' },
    { id: 'deployments', section: 'Environments, previews and production', state: 'Partial', detail: 'Named environment policies cover source restrictions, reviewers, waits, concurrency and preview lifetime. Deployment execution, protected temporary links, artifact promotion and rollback remain required.', task: 'P6 / G5' },
    { id: 'agents', section: 'Agents, MCP and models', state: 'Partial', detail: 'Scoped accounts, models, coding tasks and PR-review assignments are configurable; Actions retains results and Codex conversations. Interactive follow-ups, other harness journals and tool/network policies remain required.', task: 'P5 / G4' },
    { id: 'events', section: 'Webhooks and notifications', state: 'Partial', detail: 'Signed webhooks have consent, retries and delivery history; verified mailboxes support portable SMTP subscriptions. External delivery enablement, bounce handling and full notification semantics remain required.', task: 'P3 / P6' },
    { id: 'danger', section: 'Archive, transfer and deletion', state: 'Partial', detail: 'Owners can archive/unarchive with password confirmation and durable receipts. Active or uncertain work blocks changes. Transfer, deletion and the managed native mutation boundary remain required.', task: 'P1.5 / P2.3' },
  ],
  instance: [
    { id: 'runners', section: 'Enrolled runners', state: 'Partial', detail: 'Inspect enrolled worker presence and active leases; drain, resume or permanently revoke a worker after current-password confirmation. Named local-Docker pools and placement have versioned editors and source-tested capacity enforcement. Local Docker pool placement/capacity and job resource limits are qualified. Enrollment, expanded stress/scale and other runtimes remain required.', task: 'P4 / G3', to: '/admin/settings/runners' },
    { id: 'agents', section: 'Coding-agent accounts and access', state: 'Partial', detail: 'Create named Codex connections, authenticate and re-authenticate accounts, and grant selected enrolled Golf users access. Authentication and access configuration do not enable agent execution.', task: 'P5 / G4', to: '/admin/agents' },
    { id: 'enrollment', section: 'Enrollment, identity and SSO', state: 'Partial', detail: 'Enrolled local accounts have a dedicated administration inventory. Instance administrators can enroll existing Git identities and reset, enable or disable ordinary local accounts after password confirmation. Self-service password and login-email changes have a security page; Own TOTP and administrator/operator factor recovery are available; enterprise identity enforcement, external OIDC and native account provisioning remain required.', task: 'P1.3', to: '/admin/settings' },
    { id: 'health', section: 'System health and capabilities', state: 'Ready', detail: 'Inspect currently qualified capability states. Readiness reports dependencies; it is not an infrastructure configuration editor.', task: 'P1.1 / P1.2', to: '/status' },
    { id: 'infrastructure', section: 'Infrastructure connections', state: 'Ready', detail: 'Save and test versioned PostgreSQL and RustFS/S3/R2 connections. Activate private CI source storage after verification. Database changes require an operator migration and cutover; worker enrollment and runtime provisioning remain operator-managed.', task: 'P1 / P4 / P6', to: '/admin/settings/infrastructure' },
    { id: 'policy', section: 'Execution policy ceilings', state: 'Ready', detail: 'Default-deny instance, organization and repository ceilings govern manual shell jobs. Exact repository/workflow selections, compare-and-swap revisions and revocation epochs fence admission and worker results.', task: 'G2 / G3', to: '/admin/execution' },
    { id: 'organization-creation', section: 'Organization creation', state: 'Ready', detail: 'Choose administrators only, selected Golf users or all users. Golf enforces this ceiling on its API; independent native credentials retain their separate native permissions.', task: 'G1 / G2', to: '/admin/organizations' },
    { id: 'connections', section: 'Provider connections and email', state: 'Partial', detail: 'Named versioned SMTP transports can be configured and explicitly activated for verified notification subscriptions. Owned-relay SMTP delivery is qualified; external destination enablement, Cloudflare bindings and additional adapters require separate qualification.', to: '/admin/settings/notifications', task: 'P2 / P6' },
    { id: 'security', section: 'Credentials and compromise response', state: 'Partial', detail: 'Password-confirmed local disabling revokes Golf password sessions and dependent API credentials. Native Git keys and provider logins remain separate; unified suspension, service identities and keyring lifecycle editors are not implemented.', task: 'P1.3 / P1.8', to: '/admin/settings' },
    { id: 'recovery', section: 'Backup and recovery', state: 'Read only', detail: 'Canonical Docker offline recovery has bounded qualification through operator tooling. Browser recovery, Kubernetes cutovers and RPO/RTO qualification remain open.', task: 'P1.6' },
    { id: 'limits', section: 'Budgets, quotas and retention', state: 'Planned', detail: 'Shared resource ceilings, cost accounting and lifecycle retention need actual execution/storage measurements and auditable policy.', task: 'G3 / G6 / P8' },
  ],
};
function settingsColumns(repository?: { owner: string; name: string }, organization?: string): DataTableColumn<SettingEntry>[] { return [
  { id: 'section', accessorFn: entry => `${entry.section} ${entry.state} ${entry.detail} ${entry.task}`, header: 'Section and availability', cell: ({ row }) => <div className="table-primary">
    <strong>{row.original.section}</strong>
    <details className="metadata-details"><summary aria-label={`Scope and limitations for ${row.original.section}`}><span className="visibility">{row.original.state}</span>{' '}Scope and limitations</summary><p>{row.original.detail}</p><small><a href="https://github.com/ghost-hardened-open-source/golf-git/blob/main/GOLF_IMPLEMENTATION_PLAN.md" target="_blank" rel="noreferrer">Plan tasks: {row.original.task}</a></small></details>
  </div> },
  { id: 'actions', header: 'Action', enableSorting: false, enableGlobalFilter: false, cell: ({ row }) => {
    if (row.original.unavailable) return <span className="muted">Unavailable on this runtime</span>;
    const route = repository && ({ general: '/$owner/$name/settings', runners: '/$owner/$name/settings/runners', rules: '/$owner/$name/settings/rules', secrets: '/$owner/$name/settings/secrets', deployments: '/$owner/$name/settings/environments', access: '/$owner/$name/settings/access', ci: '/$owner/$name/settings/workflows', agents: '/$owner/$name/settings/workflows', events: '/$owner/$name/settings/webhooks' } as const)[row.original.id as 'general' | 'runners' | 'rules' | 'secrets' | 'access' | 'ci' | 'agents' | 'events' | 'deployments'];
    return organization && row.original.id === 'secrets' ? <Link className="text-button" to="/organizations/$organization/settings/secrets" params={{ organization }} aria-label="Open Secrets, variables and OIDC">Open</Link> : route && repository ? <Link className="text-button" to={route} params={repository} hash={row.original.id === 'general' ? 'repository-general-title' : undefined} aria-label={`Open ${row.original.section}`}>Open</Link> : row.original.to ? <Link className="text-button" to={row.original.to} hash={row.original.hash}>Open</Link> : <span className="muted">{row.original.state === 'Planned' ? 'Not configurable yet' : row.original.state === 'Partial' ? 'See available scope controls' : 'No browser editor'}</span>;
  } },
]; }

export function SettingsInventory({ scope, generalObservation, repository, organization, accessTarget, userId }: { scope: SettingsScope; organization?: string; repository?: { owner: string; name: string }; generalObservation?: { canEdit: boolean; implemented: boolean; issues: string; wiki: string }; accessTarget?: AccessObservationTarget; userId?: string }) {
 const runtime = useRuntimeCapabilities();
 const [expanded, setExpanded] = useState(false);
 const columns = useMemo(() => settingsColumns(scope === 'repository' && repository ? { owner: repository.owner, name: repository.name } : undefined, scope === 'organization' ? organization : undefined), [scope, repository?.owner, repository?.name, organization]);
 const originalEntries = scope === 'repository' && generalObservation ? inventory[scope].map((entry) => entry.id === 'general' ? { ...entry, state: generalObservation.implemented ? 'Ready' as const : 'Partial' as const, detail: `Verified current configuration: issues ${generalObservation.issues.toLowerCase()}, wiki ${generalObservation.wiki.toLowerCase()}. ${generalObservation.implemented ? runtime.data?.runtimeProfile === 'cloudflare-native' ? 'Description, website, topics and an existing default branch are editable; feature policies are operator-managed.' : 'Website, topics, default branch and tracker/wiki configuration editors are qualified.' : 'Editor support unavailable.'} ${generalObservation.canEdit ? 'You can administer these settings.' : 'You have view-only access.'} Wiki configuration does not include a Golf wiki workspace.` } : entry) : inventory[scope];
 const requirements: Record<string, string> = scope === 'personal' ? { authentication: 'settings.local-auth', sessions: 'settings.local-auth', keys: 'settings.local-auth' } : scope === 'instance' ? { infrastructure: 'settings.infrastructure', runners: 'settings.runners', connections: 'settings.notifications', enrollment: 'settings.local-auth', security: 'settings.local-auth' } : scope === 'repository' ? { runners: 'settings.runners', ...(runtime.data?.runtimeProfile === 'cloudflare-native' ? { general: 'settings.repository-general', access: 'settings.repository-access', rules: 'settings.repository-rules', ci: 'settings.repository-workflows', secrets: 'settings.repository-secrets', deployments: 'settings.repository-environments', agents: 'settings.repository-agents', events: 'settings.repository-webhooks', danger: 'settings.repository-lifecycle' } : {}) } : {};
 const entries: SettingEntry[] = originalEntries.map(entry => requirements[entry.id] && !settingAvailable(runtime.isError ? undefined : runtime.data, requirements[entry.id]!) ? { ...entry, state: 'Unavailable', unavailable: true, detail: runtime.data?.capabilities.find(c => c.id === requirements[entry.id])?.reason || 'This installation has not confirmed support for this settings editor.' } : entry);
  return <details className="settings-diagnostics" onToggle={event=>setExpanded(event.currentTarget.open)}><summary>Capability diagnostics</summary>{expanded ? <section className="browser-panel credential-list-panel" aria-labelledby={`${scope}-inventory-title`}><div className="browser-panel-heading"><h2 id={`${scope}-inventory-title`}>Settings coverage</h2><span className="visibility">Current preview</span></div><DataTable data={entries} columns={columns} getRowId={(entry) => entry.id} label={`${scope.charAt(0).toUpperCase()}${scope.slice(1)} settings`} /><p className="panel-footnote">Availability describes this build. Planned rows document missing enforcement and do not grant execution or administration. Search and sorting cover this displayed inventory.</p>{scope === 'repository' && runtimeFeature(runtime.data, 'settings.repository-access') && repository && accessTarget && userId ? <Suspense fallback={<Loading label="Opening access inspection…" />}><RepositoryAccessObservation key={JSON.stringify([userId,repository.owner,repository.name,accessTarget])} userId={userId} owner={repository.owner} name={repository.name} target={accessTarget}/></Suspense> : null}</section> : null}</details>;
}

export function ScopedSettings({ scope, name, userId, signingOut=false }: { signingOut?:boolean; scope: 'organization' | 'instance'; name?: string; userId: string }) {
  const organization = useQuery({ ...privateQuery, queryKey: ['organization-settings', userId, name], enabled: scope === 'organization' && !signingOut, queryFn: async ({ signal }) => { const response = await organizationClient.getOrganization({ organization: name || '' }, { signal, timeoutMs: 8_000 }); if (!response.organization?.id) throw new Error('Organization membership could not be confirmed.'); return response; } });
  const title = scope === 'instance' ? 'Admin portal' : 'Organization settings';
  // Organization execution policy and agent usage have no native service.
  const portable = useRuntimeCapabilities().data?.runtimeProfile !== 'cloudflare-native';
  return <section className="page-stack" aria-labelledby="scope-settings-title"><header className="repository-intro"><div><span className="eyebrow">{scope === 'instance' ? 'INSTALLATION ADMINISTRATION' : name || 'ORGANIZATION'}</span><h1 id="scope-settings-title"><ShieldCheck size={29} />{title}</h1><p>{scope === 'instance' ? 'Visible only to an explicitly enrolled Golf instance administrator. Operator-managed configuration is separate from native organization/repository roles; Execution policy, ordinary account disabling and infrastructure profile/source-storage controls have dedicated instance pages; remaining lifecycle controls are operator-managed.' : 'Membership grants this settings inventory. Native organization owners can manage existing account membership in ordinary teams; Owners teams, grant editors, invitations and delegated roles remain outside that editor. Golf instance administration does not override organization ownership.'}</p></div></header>{scope === 'organization' && organization.error ? <PanelError error={organization.error} retry={() => void organization.refetch()} /> : scope === 'organization' && (!organization.isSuccess || organization.isFetching) ? <Loading label="Verifying organization membership…" /> : <SettingsInventory scope={scope} organization={name} />}{scope === 'organization' && portable && organization.isSuccess && !organization.isFetching && !organization.error ? <ExecutionPolicyPanel key={`${userId}/${name}`} userId={userId} signingOut={signingOut} scope={ExecutionScope.ORGANIZATION} organization={name} /> : null}{scope === 'organization' && portable && organization.isSuccess && !organization.isFetching && !organization.error ? <AgentUsagePanel userId={userId} signingOut={signingOut} scope={AgentUsageScope.ORGANIZATION} organization={name} /> : null}</section>;
}
