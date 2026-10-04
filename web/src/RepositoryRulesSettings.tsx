import { ShieldCheck } from 'lucide-react';
import { repositoryRulesClient } from './api';
import { RepositorySettingsLayout } from './AccountSettings';
import { RepositoryRules } from './RepositoryRules';
import { Loading, PanelError } from './RepositoryUI';
import { useRepositorySettingsAccess } from './useRepositorySettingsAccess';

export function RepositoryRulesSettings({ userId, owner, name, signingOut }: { userId: string; owner: string; name: string; signingOut: boolean }) {
  const { access, revalidating, error, refresh, scope } = useRepositorySettingsAccess(userId, owner, name, signingOut);
  return <RepositorySettingsLayout owner={owner} name={name}><section className="page-stack">
    <header className="repository-intro"><div><h1><ShieldCheck size={24} />Rules and merge policy</h1><p>Inspect current branch, tag and merge configuration.</p></div></header>
    {error ? <PanelError error={error} retry={refresh} /> : !access ? <Loading label="Verifying repository access…" /> : null}
    {access ? <RepositoryRules key={`${scope}/${access.repositoryId}/${access.ownerId}`} client={repositoryRulesClient} userId={userId} owner={owner} name={name} access={access} signingOut={signingOut} revalidating={revalidating} /> : null}
  </section></RepositorySettingsLayout>;
}
