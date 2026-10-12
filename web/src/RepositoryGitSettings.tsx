import { useRuntimeCapabilities } from './useRuntimeCapabilities';
import { KeyRound, RefreshCw } from 'lucide-react';
import { gitTransportClient } from './api';
import { RepositoryGitTransport } from './RepositoryGitTransport';
import { useRepositorySettingsAccess } from './useRepositorySettingsAccess';
import { Loading, PanelError } from './RepositoryUI';
export function RepositoryGitSettings({ userId, owner, name, signingOut }: { userId: string; owner: string; name: string; signingOut: boolean }) {
 const native=useRuntimeCapabilities().data?.runtimeProfile==='cloudflare-native';
 const {access,revalidating,error,refresh}=useRepositorySettingsAccess(userId,owner,name,signingOut);
 return <><section className="page-stack"><header className="repository-intro"><div><h1><KeyRound size={24}/>Git access</h1><p>Clone and fetch with short-lived Golf credentials for this repository.</p></div><button className="icon-button" title="Recheck repository access" aria-label="Recheck repository access" onClick={refresh} disabled={revalidating||signingOut}><RefreshCw size={16}/></button></header>
  {error ? <PanelError error={error} retry={refresh}/> : !access||revalidating ? <Loading label="Verifying repository access…"/> : null}
  {access&&!revalidating&&!error&&!signingOut?<RepositoryGitTransport native={native} key={`${userId}/${access.repositoryId}/${access.ownerId}`} client={gitTransportClient} userId={userId} signingOut={signingOut} target={{repository:{$typeName:'golf.v1.RepositoryKey',owner,name},repositoryId:access.repositoryId,ownerId:access.ownerId}}/>:null}
 </section></>;
}
