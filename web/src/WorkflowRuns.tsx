import { useEffect, useMemo, useRef, useState } from 'react';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { RefreshCw } from 'lucide-react';
import { workflowRunClient, errorMessage } from './api';
import { WorkflowRunOrigin, WorkflowRunState, type WorkflowRun } from './gen/golf/v1/golf_pb';
import { DataTable, type DataTableColumn } from './DataTable';
import { DateLabel, Loading, More, PanelError, privateQuery } from './RepositoryUI';

export function runState(state: WorkflowRunState) { return WorkflowRunState[state]?.toLowerCase().replaceAll('_', ' ') || 'unknown'; }
export function WorkflowRuns({ userId, owner, name, signingOut }: { userId: string; owner: string; name: string; signingOut: boolean }) {
 const [selected, setSelected] = useState('');
 const [notice, setNotice] = useState('');
 const [pending, setPending] = useState(false);
 const controller = useRef<AbortController | null>(null);
 const alive = useRef(true);
 useEffect(() => { alive.current = true; return () => { alive.current = false; controller.current?.abort(); }; }, []);
 useEffect(() => { if (signingOut) { controller.current?.abort(); setSelected(''); setNotice(''); } }, [signingOut]);
 const query = useInfiniteQuery({ ...privateQuery, queryKey: ['workflow-runs', userId, owner, name], enabled: !signingOut, initialPageParam: 1,
  queryFn: ({ signal, pageParam }) => workflowRunClient.listWorkflowRuns({ repository: { owner, name }, page: { page: pageParam, limit: 20 } }, { signal, timeoutMs: 12_000 }),
  getNextPageParam: (page, _pages, current) => page.page?.nextPage && page.page.nextPage > current ? page.page.nextPage : undefined });
 const detail = useQuery({ ...privateQuery, queryKey: ['workflow-run', userId, owner, name, selected], enabled: Boolean(selected) && query.isSuccess && !query.error && !signingOut,
  queryFn: ({ signal }) => workflowRunClient.getWorkflowRun({ runId: selected }, { signal, timeoutMs: 12_000 }) });
 const logs = useQuery({ ...privateQuery, queryKey: ['workflow-run-logs', userId, owner, name, selected], enabled: Boolean(selected) && detail.isSuccess && !detail.error && !detail.isFetching && !signingOut,
  queryFn: ({ signal }) => workflowRunClient.getWorkflowRunLogs({ runId: selected }, { signal, timeoutMs: 12_000 }) });
 const loading = query.isPending || (query.isFetching && !query.isFetchingNextPage);
 const rows = query.isSuccess && !query.error && !loading && !signingOut ? [...new Map(query.data.pages.flatMap(page => page.runs).map(run => [run.id, run])).values()] : [];
 const run = query.isSuccess && !query.error && detail.isSuccess && !detail.error && !detail.isFetching && !signingOut ? detail.data.run : undefined;
 async function refresh() { if (pending || signingOut) return; setNotice(''); await query.refetch(); if (selected) { const result = await detail.refetch(); if (!result.error) await logs.refetch(); } }
 async function cancel() {
  if (!run || !run.canCancel || pending || signingOut) return;
  const observed = run; const request = new AbortController(); controller.current = request; setPending(true); setNotice('');
  try { const result = await workflowRunClient.cancelWorkflowRun({ runId: observed.id, expectedVersion: observed.version }, { signal: request.signal, timeoutMs: 12_000 });
   if (!alive.current || request.signal.aborted) return;
   if (result.run?.id !== observed.id || result.run.state !== WorkflowRunState.CANCELLED) throw new Error('Cancellation outcome could not be verified.');
   setNotice('Run cancelled. Its attempt credential is revoked; the worker stops when it observes cancellation.'); await query.refetch(); await detail.refetch();
  } catch (error) { if (alive.current && !request.signal.aborted) setNotice(`${errorMessage(error instanceof Error ? error : new Error('Cancellation could not be confirmed.'))} Refresh and inspect the run before another action. No automatic retry was made.`); }
  finally { if (controller.current === request) controller.current = null; if (alive.current) setPending(false); }
 }
 const columns = useMemo<DataTableColumn<WorkflowRun>[]>(() => [
  { id: 'workflow', accessorFn: row => row.workflowPath, header: 'Workflow', cell: ({ row }) => <><button className="text-button" disabled={pending || signingOut} onClick={() => { setSelected(row.original.id); setNotice(''); }}>{row.original.workflowPath}</button><small>{row.original.id}</small></> },
  { id: 'origin', accessorFn: row => row.origin === WorkflowRunOrigin.PUSH ? 'Push' : row.origin === WorkflowRunOrigin.MANUAL ? 'Manual' : 'Unknown', header: 'Trigger' },
  { id: 'state', accessorFn: row => runState(row.state), header: 'State' },
  { accessorKey: 'commitId', header: 'Commit', cell: ({ row }) => <code title={row.original.commitId}>{row.original.commitId.slice(0, 12)}</code> },
  { accessorKey: 'createdAt', header: 'Created', cell: ({ row }) => <DateLabel value={row.original.createdAt} /> },
  { accessorKey: 'runnerId', header: 'Worker', cell: ({ row }) => row.original.runnerId || 'Awaiting assignment' },
 ], [pending, signingOut]);
 return <section className="browser-panel credential-list-panel" aria-labelledby="workflow-runs-title">
  <div className="browser-panel-heading"><h2 id="workflow-runs-title">Workflow runs</h2><button className="button secondary manual-refresh" disabled={pending || signingOut || query.isFetching} onClick={() => void refresh()}><RefreshCw size={15} />Refresh runs</button></div>
  {query.error ? <PanelError error={query.error} retry={() => void refresh()} /> : loading ? <Loading label="Loading runs…" /> : <DataTable label="Workflow runs" data={rows} columns={columns} getRowId={row => row.id} emptyMessage="No workflow runs." />}
  <More hasMore={Boolean(query.hasNextPage)} loading={query.isFetchingNextPage || pending || signingOut} load={() => void query.fetchNextPage()} label="workflow runs" />
  {notice && !signingOut ? <p role="status" className="panel-footnote">{notice}</p> : null}
  {selected && !signingOut && !query.error ? <section aria-label="Selected workflow run">{detail.error ? <PanelError error={detail.error} retry={() => void refresh()} /> : !run ? <Loading label="Loading selected run…" /> : <>
   <div className="browser-panel-heading"><h3>{runState(run.state)}</h3>{run.canCancel ? <button className="button secondary" disabled={pending || signingOut} onClick={() => void cancel()}>Cancel run</button> : null}</div>
   {run.origin === WorkflowRunOrigin.PUSH ? <p className="panel-footnote">Push · <code>{run.eventRef}</code> · Event {run.repositoryEventId} · Grant <code>{run.automationGrantId}</code></p> : null}
   <p className="panel-footnote">Commit <code>{run.commitId}</code> · Workflow blob <code>{run.workflowBlobId}</code> · Source archive <code>{run.sourceSha256}</code></p>
   {run.reason ? <p className="panel-footnote">{run.reason}</p> : null}
   {logs.error ? <PanelError error={logs.error} retry={() => void logs.refetch()} /> : logs.isSuccess && !logs.isFetching ? <><pre className="source-code" aria-label="Workflow run log">{logs.data.logs.map(chunk => chunk.text).join('') || 'No log output yet.'}</pre>{logs.data.hasMore ? <p className="panel-footnote">Additional log output is available through the run log API.</p> : null}</> : <Loading label="Loading log…" />}
  </>}</section> : null}
  <p className="panel-footnote">Manual Linux shell catalog only. Runs use a pinned source archive and isolated containers; hosted runner images, remote actions, dependency graphs, Git checkout, artifacts, caches, secrets and trusted merge checks need further qualification.</p>
 </section>;
}
