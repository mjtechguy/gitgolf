import { useRuntimeCapabilities } from './useRuntimeCapabilities';
import { ShieldCheck } from 'lucide-react';
import { repositoryRulesClient } from './api';
import { RepositoryRules } from './RepositoryRules';
import { Loading, PanelError } from './RepositoryUI';
import { useRepositorySettingsAccess } from './useRepositorySettingsAccess';

export function RepositoryRulesSettings({ userId, owner, name, signingOut }: { userId: string; owner: string; name: string; signingOut: boolean }) {
  const native=useRuntimeCapabilities().data?.runtimeProfile==='cloudflare-native';
  const { access, revalidating, error, refresh, scope } = useRepositorySettingsAccess(userId, owner, name, signingOut);
  return <><section className="page-stack">
    <header className="repository-intro"><div><h1><ShieldCheck size={24} />Rules and merge policy</h1><p>{native?'Lock branches and restrict tag writes on the Cloudflare Git broker.':'Configure branch protection, tag protection and merge defaults.'}</p></div></header>
    {error ? <PanelError error={error} retry={refresh} /> : !access ? <Loading label="Verifying repository access…" /> : null}
    {access ? <RepositoryRules native={native} key={`${scope}/${access.repositoryId}/${access.ownerId}`} client={repositoryRulesClient} userId={userId} owner={owner} name={name} access={access} signingOut={signingOut} revalidating={revalidating} /> : null}
  </section></>;
}
