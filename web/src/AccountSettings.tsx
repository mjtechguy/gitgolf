import type { ReactNode } from 'react';
import { Link } from '@tanstack/react-router';
import { History, KeyRound, ShieldCheck, UserRound } from 'lucide-react';
import type { User } from './gen/golf/v1/golf_pb';
import { DataTable, type DataTableColumn } from './DataTable';
import { useQuery } from '@tanstack/react-query';
import { organizationClient } from './api';
import { Loading, PanelError, privateQuery } from './RepositoryUI';

export function AccountLayout({ children }: { children: ReactNode }) {
  return <div className="account-layout"><nav className="account-navigation" aria-label="Account settings"><span className="eyebrow">PERSONAL SETTINGS</span>
    <Link to="/account/settings" activeOptions={{ exact:true }}><UserRound size={18} />Profile</Link>
    <Link to="/account/sessions" activeOptions={{ exact:true }}><ShieldCheck size={18} />Sessions</Link>
    <Link to="/account/ssh-keys" activeOptions={{ exact:true }}><KeyRound size={18} />SSH keys</Link>
    <Link to="/account/api-credentials" activeOptions={{ exact:true }}><KeyRound size={18} />API credentials</Link>
    <Link to="/audit" activeOptions={{ exact:true }}><History size={18} />Account activity</Link>
  </nav><div className="account-content">{children}</div></div>;
}

export function AccountSettings({ user }: { user: User }) {
  return <section aria-labelledby="settings-title">
    <header className="repository-intro"><div><span className="eyebrow">YOUR GOLF ACCOUNT</span><h1 id="settings-title"><UserRound size={29} />Profile</h1><p>Your identity, access and account preferences.</p></div></header>
    <section className="browser-panel credential-list-panel" aria-labelledby="profile-title"><div className="browser-panel-heading"><h2 id="profile-title">Account profile</h2><span className="visibility">View only</span></div>
      <div className="credential-form-content"><dl className="settings-profile"><div><dt>Username</dt><dd>{user.login}</dd></div><div><dt>Display name</dt><dd>{user.fullName || 'Not set'}</dd></div><div><dt>Instance role</dt><dd>{user.isInstanceAdmin ? 'Instance administrator' : 'Personal workspace'}</dd></div></dl>
        <p className="field-help">Profile edits, email changes and password recovery currently require your administrator. Self-service account editing is still being built.</p>
      </div>
    </section>
    <SettingsInventory scope="personal" />
  </section>;
}

export type SettingsScope = 'personal' | 'organization' | 'repository' | 'instance';
type SettingEntry = { id: string; section: string; state: 'Ready' | 'Read only' | 'Planned'; detail: string; task: string; to?: '/account/sessions' | '/account/ssh-keys' | '/account/api-credentials' | '/audit' | '/' | '/organizations'; hash?: string };
const inventory: Record<SettingsScope, SettingEntry[]> = {
  personal: [
    { id: 'profile', section: 'Profile and email', state: 'Read only', detail: 'Current username, display name and role are visible. Email/profile edits and email verification need self-service identity APIs; enrolled login changes require an operator.', task: 'P1.3 / G1' },
    { id: 'authentication', section: 'Passwords, recovery and MFA', state: 'Planned', detail: 'Password sign-in works; self-service password changes, recovery, MFA, passkeys and step-up need verified credential lifecycle and recovery safeguards.', task: 'P1.3' },
    { id: 'sessions', section: 'Browser sessions', state: 'Ready', detail: 'List active sessions and revoke one or all others. This does not revoke native Git keys or provider grants.', task: 'P1.3', to: '/account/sessions' },
    { id: 'keys', section: 'SSH keys', state: 'Ready', detail: 'Manage persistent native account SSH keys. Signing-key management and scoped/expiring agent Git credentials are still planned.', task: 'P1.8 / P5.5', to: '/account/ssh-keys' },
    { id: 'signing', section: 'Signing keys', state: 'Planned', detail: 'Signing-key enrollment and revocation need dedicated supported APIs and signature/trust qualification; SSH authentication keys are managed separately.', task: 'P1.8 / P2.3' },
    { id: 'credentials', section: 'API credentials', state: 'Ready', detail: 'Issue source-session-bound, read-only credentials. Configurable scopes, service accounts and managed device login need additional enforcement.', task: 'P1.8 / P5.5', to: '/account/api-credentials' },
    { id: 'identity', section: 'Connected identities and integrations', state: 'Planned', detail: 'Optional provider OAuth sign-in exists; account linking/unlinking, external OIDC and installation approval need explicit immutable identity binding.', task: 'P1.3 / G2' },
    { id: 'notifications', section: 'Notifications and email', state: 'Planned', detail: 'Subscriptions, delivery preferences, verified email and webhook/email delivery are not implemented. Provider selection must remain optional for portable installs.', task: 'P3 / P6' },
    { id: 'appearance', section: 'Appearance', state: 'Ready', detail: 'Use the header theme button. Dark/light choice is stored in this browser; synchronized account preferences are not implemented.', task: 'P1.4' },
    { id: 'activity', section: 'Account activity', state: 'Ready', detail: 'Inspect recorded successful session changes. Export, retention policy and broader security events remain planned.', task: 'P1.3', to: '/audit' },
    { id: 'agents', section: 'Agent tools and provider credentials', state: 'Planned', detail: 'Model connections, five coding harnesses, MCP tool approvals, credential ownership and budgets need integrated execution and policy enforcement.', task: 'P5 / G4' },
  ],
  organization: [
    { id: 'members', section: 'Members, teams and roles', state: 'Read only', detail: 'Browse teams and manage existing account membership in ordinary teams as an organization owner. Invitations, team grant editors and delegated Golf roles still require implementation and ownership safeguards.', task: 'P1.5 / G1', to: '/organizations' },
    { id: 'defaults', section: 'Repository defaults and selection', state: 'Planned', detail: 'Creation defaults and disabled/all/selected execution require immutable repository targeting, inherited ceilings and explicit future-repository behavior.', task: 'G2 / G3' },
    { id: 'ci', section: 'CI, workflows and fork trust', state: 'Planned', detail: 'Actions/GitLab engines, actor/event authorization, dependency allowlists and exact-commit fork approvals require the real scheduler and compatibility corpus.', task: 'P4 / G3' },
    { id: 'runners', section: 'Runner groups', state: 'Planned', detail: 'Repository/workflow access, pool labels, capacity, registration, drain and revocation need actual runner pools; labels alone cannot authorize execution.', task: 'P4 / G3' },
    { id: 'secrets', section: 'Secrets, variables and OIDC', state: 'Planned', detail: 'Selected-repository scopes, environment gates, rotation and workload identity require a credential broker and admission-time policy.', task: 'G3 / G5' },
    { id: 'rules', section: 'Rulesets and review policy', state: 'Planned', detail: 'Organization rules need qualified direct Git/API/background mutation control and trusted check producers; native observations do not establish Golf protection.', task: 'P0.8 / P2.3 / G5' },
    { id: 'agents', section: 'Agents, MCP and network policy', state: 'Planned', detail: 'Repository selection, harness/model allowlists, tool approvals and setup/sidecar egress limits require actual execution boundaries.', task: 'P5 / G4' },
    { id: 'connections', section: 'Connections, tokens and app approvals', state: 'Planned', detail: 'GitHub/GitLab imports, integration installation review and producer/consumer workflow sharing need verified connections and independent authority.', task: 'P2 / G2 / G3' },
    { id: 'budgets', section: 'Budgets and infrastructure', state: 'Planned', detail: 'Concurrency/cost limits and eligible Cloudflare accounts/zones or portable pools need measured capacity, authorized fallback and deny enforcement.', task: 'G3–G5 / P6.4' },
    { id: 'audit', section: 'Organization audit and retention', state: 'Planned', detail: 'Own-account session history exists; organization policy/membership/execution history, exports and retention require broader durable events.', task: 'P1.3 / G2 / G6' },
  ],
  repository: [
    { id: 'general', section: 'General and features', state: 'Ready', detail: 'Current native description, default branch and feature values appear above. Edit is offered only when a fresh supported API grants repository administration.', task: 'P1.4 / G1' },
    { id: 'access', section: 'Collaborators and deploy keys', state: 'Planned', detail: 'Invites, per-unit roles, expiring deploy keys and transfer need immutable target checks and native authority qualification.', task: 'P1.5 / P1.8' },
    { id: 'rules', section: 'Rulesets, reviews and merge policy', state: 'Planned', detail: 'Required reviews/checks, branch/tag protection, trusted publishers and merge queues remain gated on complete mutation enforcement.', task: 'P0.8 / P2.3 / G5' },
    { id: 'ci', section: 'CI engines and workflow controls', state: 'Planned', detail: 'Repository eligibility, individual workflow pause, trigger trust and Actions/GitLab compatibility need an enforcing scheduler; no CI toggle is live.', task: 'P4 / G3' },
    { id: 'runners', section: 'Runners and resource limits', state: 'Planned', detail: 'Choose approved groups and resources only after pools exist and organization ceilings can be enforced.', task: 'P4 / G3' },
    { id: 'secrets', section: 'Secrets, variables and OIDC', state: 'Planned', detail: 'Repository/environment credentials, metadata-only inventories and rotation need a broker; workflow text must not expand permission.', task: 'G3 / G5' },
    { id: 'deployments', section: 'Environments, previews and production', state: 'Planned', detail: 'Reviewers, branch restrictions, protected temporary links, exact artifact promotion and rollback need real CD and destination authority.', task: 'P6 / G5' },
    { id: 'agents', section: 'Agents, MCP and models', state: 'Planned', detail: 'Integrated harnesses, read/write tool policy, provider ownership and network budgets are separate from CI enablement.', task: 'P5 / G4' },
    { id: 'events', section: 'Webhooks and notifications', state: 'Planned', detail: 'Verified destinations, signing secrets, replay/retry controls and email subscriptions require durable delivery and safe outbound access.', task: 'P3 / P6' },
    { id: 'danger', section: 'Archive, transfer and deletion', state: 'Planned', detail: 'Destructive administration is not exposed yet; ownership recovery, confirmation, target binding and audit must precede these controls.', task: 'P1.5 / P2.3' },
  ],
  instance: [
    { id: 'enrollment', section: 'Enrollment, identity and SSO', state: 'Read only', detail: 'Enrolled accounts are listed above. Enrollment, reset, disable and email changes remain operator-managed; browser lifecycle editors, external OIDC and enforced MFA are still planned.', task: 'P1.3' },
    { id: 'health', section: 'System health and capabilities', state: 'Ready', detail: 'Inspect currently qualified capability states. Readiness reports dependencies; it is not an infrastructure configuration editor.', task: 'P1.1 / P1.2', to: '/', hash: 'capabilities' },
    { id: 'infrastructure', section: 'Infrastructure and shared pools', state: 'Read only', detail: 'Compose/Helm and operator configuration provide the current portable deployment. Browser pool/storage/provider administration needs live adapters.', task: 'P1 / P4 / P6' },
    { id: 'policy', section: 'Policy ceilings and delegated administration', state: 'Planned', detail: 'Typed inheritance, organization/repository selection, locked limits and authorized roles need persisted policy and admission enforcement.', task: 'G2–G6' },
    { id: 'connections', section: 'Provider connections and email', state: 'Planned', detail: 'Cloudflare account/zone bindings, optional portable backends, import providers and email delivery require qualified credentials and adapters.', task: 'P2 / P6' },
    { id: 'security', section: 'Credentials and compromise response', state: 'Read only', detail: 'Operator keyring/revocation commands exist. Browser lifecycle controls, unified native suspension and service identity policy remain unimplemented.', task: 'P1.3 / P1.8' },
    { id: 'recovery', section: 'Backup and recovery', state: 'Read only', detail: 'Canonical Docker offline recovery has bounded qualification through operator tooling. Browser recovery, Kubernetes cutovers and RPO/RTO qualification remain open.', task: 'P1.6' },
    { id: 'limits', section: 'Budgets, quotas and retention', state: 'Planned', detail: 'Shared resource ceilings, cost accounting and lifecycle retention need actual execution/storage measurements and auditable policy.', task: 'G3 / G6 / P8' },
  ],
};
const settingsColumns: DataTableColumn<SettingEntry>[] = [
  { accessorKey: 'section', header: 'Section' },
  { accessorKey: 'state', header: 'Availability', cell: ({ row }) => <span className="visibility">{row.original.state}</span> },
  { accessorKey: 'detail', header: 'Details', cell: ({ row }) => <>{row.original.detail}<small><a href="https://github.com/mjtechguy/golf-git/blob/main/GOLF_IMPLEMENTATION_PLAN.md" target="_blank" rel="noreferrer">Plan tasks: {row.original.task}</a></small></> },
  { id: 'actions', header: 'Action', enableSorting: false, enableGlobalFilter: false, cell: ({ row }) => row.original.to ? <Link className="text-button" to={row.original.to} hash={row.original.hash}>Open</Link> : <span className="muted">{row.original.state === 'Planned' ? 'Not configurable yet' : 'No browser editor'}</span> },
];

export function SettingsInventory({ scope }: { scope: SettingsScope }) {
  return <section className="browser-panel credential-list-panel" aria-labelledby={`${scope}-inventory-title`}><div className="browser-panel-heading"><h2 id={`${scope}-inventory-title`}>Settings coverage</h2><span className="visibility">Current preview</span></div><DataTable data={inventory[scope]} columns={settingsColumns} getRowId={(entry) => entry.id} label={`${scope.charAt(0).toUpperCase()}${scope.slice(1)} settings`} /><p className="panel-footnote">Availability describes this build. Planned rows document missing enforcement and do not grant execution or administration. Search and sorting cover this displayed inventory.</p></section>;
}

export function ScopedSettings({ scope, name, userId }: { scope: 'organization' | 'instance'; name?: string; userId: string }) {
  const organization = useQuery({ ...privateQuery, queryKey: ['organization-settings', userId, name], enabled: scope === 'organization', queryFn: async ({ signal }) => { const response = await organizationClient.getOrganization({ organization: name || '' }, { signal, timeoutMs: 8_000 }); if (!response.organization?.id) throw new Error('Organization membership could not be confirmed.'); return response; } });
  const title = scope === 'instance' ? 'Instance settings' : 'Organization settings';
  return <section aria-labelledby="scope-settings-title"><header className="repository-intro"><div><span className="eyebrow">{scope === 'instance' ? 'INSTALLATION ADMINISTRATION' : name || 'ORGANIZATION'}</span><h1 id="scope-settings-title"><ShieldCheck size={29} />{title}</h1><p>{scope === 'instance' ? 'Visible only to an explicitly enrolled Golf instance administrator. Operator-managed configuration is separate from native organization/repository roles; global browser editing is not implemented.' : 'Membership grants this read-only inventory, not organization administration. Owner/admin/member roles remain native observations; Golf organization editors are not implemented.'}</p></div></header>{scope === 'organization' && organization.error ? <PanelError error={organization.error} retry={() => void organization.refetch()} /> : scope === 'organization' && (!organization.isSuccess || organization.isFetching) ? <Loading label="Verifying organization membership…" /> : <SettingsInventory scope={scope} />}</section>;
}
