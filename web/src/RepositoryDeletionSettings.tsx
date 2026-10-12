import { useQueryClient } from '@tanstack/react-query';
import { Trash2 } from 'lucide-react';
import { repositoryLifecycleClient } from './api';
import { RepositoryDeletion } from './RepositoryDeletion';

export function RepositoryDeletionSettings({ userId, owner, name, repositoryId, signingOut }: { userId: string; owner: string; name: string; repositoryId: string; signingOut: boolean }) {
  const cache = useQueryClient();
  return <><section className="page-stack">
    <header className="repository-intro"><div><h1><Trash2 size={24} />Deletion</h1><p>Check availability or inspect the original operation for this repository identity.</p></div></header>
    <RepositoryDeletion client={repositoryLifecycleClient} userId={userId} owner={owner} name={name} repositoryId={repositoryId} signingOut={signingOut} onDeleted={() => { void cache.invalidateQueries({ queryKey: ['repositories', userId] }); }} />
  </section></>;
}
