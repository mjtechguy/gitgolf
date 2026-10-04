import { useEffect, useRef, useState } from 'react';
import { useForm } from '@tanstack/react-form';
import { useQuery } from '@tanstack/react-query';
import { Code, ConnectError } from '@connectrpc/connect';
import { Pencil, Server } from 'lucide-react';
import { runnerControlClient, workflowClient } from './api';
import { RepositorySettingsLayout } from './AccountSettings';
import { Loading, PanelError, privateQuery } from './RepositoryUI';
import { RepositoryRunners } from './RunnerControls';
import { isCommitID } from './navigation';
import { useRepositorySettingsAccess } from './useRepositorySettingsAccess';

const validPath = (path: string) => path === '.gitlab-ci.yml' || path.length <= 255 && /^\.github\/workflows\/[A-Za-z0-9_.-]+\.ya?ml$/.test(path) && !path.includes('..');
function WorkflowChoice({ paths, onChoose, cancel }: { paths: string[]; onChoose: (path: string) => void; cancel: () => void }) {
  const first = useRef<HTMLSelectElement>(null);
  const form = useForm({ defaultValues: { workflow: '' }, validators: { onSubmit: ({ value }) => paths.includes(value.workflow) ? undefined : 'Choose a workflow in this repository.' }, onSubmit: ({ value }) => onChoose(value.workflow) });
  useEffect(() => { first.current?.focus(); }, []);
  return <form className="credential-form-content" aria-label="Choose repository workflow" onSubmit={event => { event.preventDefault(); void form.handleSubmit(); }}>
    <form.Field name="workflow">{field => <><label htmlFor="runner-workflow-choice">Workflow</label><select ref={first} id="runner-workflow-choice" value={field.state.value} onChange={event => field.handleChange(event.target.value)}><option value="">Select a workflow…</option>{paths.map(path => <option key={path} value={path}>{path}</option>)}</select></>}</form.Field>
    <form.Subscribe selector={state => state.errors}>{errors => errors.length ? <p className="error" role="alert">{errors.join(' ')}</p> : null}</form.Subscribe>
    <div className="credential-actions"><button type="submit" className="button primary">Inspect workflow</button><button type="button" className="button secondary" onClick={cancel}>Cancel</button></div>
  </form>;
}
export function RepositoryRunnerSettings({ userId, owner, name, signingOut }: { userId: string; owner: string; name: string; signingOut: boolean }) {
  const { access, revalidating, error, refresh } = useRepositorySettingsAccess(userId, owner, name, signingOut);
  const [editing, edit] = useState(false);
  const [selected, select] = useState<{ repositoryId: string; ownerId: string; path: string } | null>(null);
  const ready = Boolean(access && !revalidating && !error && !signingOut);
  const paths = useQuery({ ...privateQuery, queryKey: ['runner-workflow-paths', userId, owner, name, access?.repositoryId, access?.revision], enabled: editing && ready,
    queryFn: async ({ signal }) => {
      const response = await workflowClient.inspectWorkflows({ repository: { owner, name }, repositoryId: access!.repositoryId }, { signal, timeoutMs: 25000 });
      signal.throwIfAborted();
      const list = response.configurations.map(row => row.path);
      if (response.repositoryId !== access!.repositoryId || !isCommitID(response.commitId) || list.length > 100 || new Set(list).size !== list.length || !list.every(validPath)) throw new ConnectError('Workflow source identity could not be verified.', Code.Internal);
      return list;
    },
  });
  const chosen = ready && selected?.repositoryId === access!.repositoryId && selected?.ownerId === access!.ownerId ? selected.path : '';
  return <RepositorySettingsLayout owner={owner} name={name}><section className="page-stack">
    <header className="repository-intro"><div><h1><Server size={24} />Runners</h1><p>Inspect enrolled workers and the policy for a selected workflow.</p></div></header>
    {error ? <PanelError error={error} retry={refresh} /> : !access ? <Loading label="Verifying repository access…" /> : null}
    {access ? <section className="browser-panel"><div className="browser-panel-heading"><h2>Workflow selection</h2><button className="button secondary" disabled={!ready || editing} onClick={() => edit(true)}><Pencil size={15} />Choose workflow</button></div>
      <p className="panel-footnote">{chosen || 'Choose a workflow to inspect its current policy. Worker controls are managed in the Admin portal.'}</p>
      {editing && ready ? paths.error ? <><PanelError error={paths.error} retry={() => void paths.refetch()} /><button className="button secondary" onClick={() => edit(false)}>Cancel</button></> : !paths.isSuccess || paths.isFetching ? <Loading label="Reading repository workflows…" /> : paths.data.length ? <WorkflowChoice paths={paths.data} cancel={() => edit(false)} onChoose={path => { select({ repositoryId: access.repositoryId, ownerId: access.ownerId, path }); edit(false); }} /> : <><p className="panel-footnote">No supported workflow paths were found. Add a workflow before inspecting its policy.</p><button className="button secondary" onClick={() => edit(false)}>Cancel</button></> : null}
    </section> : null}
    {chosen && access ? <RepositoryRunners key={`${userId}/${access.repositoryId}/${access.ownerId}/${chosen}`} userId={userId} owner={owner} name={name} repositoryId={access.repositoryId} ownerId={access.ownerId} workflowPath={chosen} signingOut={signingOut} revalidating={revalidating} client={runnerControlClient} /> : null}
  </section></RepositorySettingsLayout>;
}
