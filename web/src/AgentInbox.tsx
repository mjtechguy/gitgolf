import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { LoaderCircle, RefreshCw, Sparkles } from 'lucide-react';
import { DataTable, type DataTableColumn } from './DataTable';
import { AiAdvisory } from './AiAdvisory';
import { DateLabel, Loading, PageHeader, PanelError, privateQuery, usePageVisible } from './RepositoryUI';
import { useLiveStatus } from './RepositoryLive';
import { repositoryOptions, type RepositoryLocation } from './navigation';
import { decisionLabels, riskLabels } from './agenticMode';
import { inboxKey, landPull, originLabels, readInbox, readIntent, summarizeIntent, taskStateLabels, type InboxLanding, type InboxPull, type InboxTask, type IntentSummary } from './agentInbox';

type Context = { repository: { owner: string; name: string }; repositoryId: string };
const kib = (bytes: number) => `${bytes < 10 * 1024 ? (bytes / 1024).toFixed(1) : Math.round(bytes / 1024)} KiB`;
const message = (error: unknown, fallback: string) => error instanceof Error ? error.message : fallback;
const decisionLabel = (pull: InboxPull) => pull.decision === 'unavailable' ? 'Not evaluated' : decisionLabels[pull.decision];
const checkSummary = ({ passed, pending, failed }: InboxPull['checks']) => passed + pending + failed === 0 ? 'None reported' : [failed ? `${failed} failed` : '', pending ? `${pending} pending` : '', passed ? `${passed} passed` : ''].filter(Boolean).join(', ');

// The agentic inbox (docs/AGENTIC_MODE.md): what agents are doing and what needs a person, while agentic mode is on. Read-only except for
// intent summaries (a writer asks Workers AI) and, only when the Worker reports the land queue, landing selected pull requests.
export function AgentInbox({ location, context, userId, canLand }: { location: RepositoryLocation; context: Context; userId: string; canLand: boolean }) {
  const cache = useQueryClient(), visible = usePageVisible(), live = useLiveStatus() === 'live';
  const key = inboxKey(userId, location.owner, location.name);
  // The activity stream refreshes it; without a live connection it is read again every 30 s while visible.
  const inbox = useQuery({ ...privateQuery, queryKey: key, queryFn: ({ signal }) => readInbox(context, signal), refetchInterval: visible && !live ? 30000 : false });
  const [focus, setFocus] = useState<number>();
  const [selected, setSelected] = useState<number[]>([]);
  const [landed, setLanded] = useState<{ number: number; ok: boolean; text: string }[]>([]);
  const summarize = useMutation({ mutationFn: (number: number) => summarizeIntent(context, number), onSuccess: value => {
    cache.setQueryData(['repository', userId, location.owner, location.name, 'agent-workspace', 'intent', value.number], (old: object | undefined) => ({ ...old, ...value, inFlight: value.state === 'RUNNING' }));
    if (value.summary) void cache.invalidateQueries({ queryKey: key });
  } });
  const land = useMutation({ mutationFn: async (pulls: InboxPull[]) => {
    const out: { number: number; ok: boolean; text: string }[] = [];
    // One request per pull request, in order; each answer is reported as the land queue gave it.
    for (const pull of pulls) {
      try { const value = await landPull(context, pull); out.push({ number: pull.number, ok: true, text: value.state ? `accepted (${value.state.toLowerCase()})` : 'accepted' }); }
      catch (error) { out.push({ number: pull.number, ok: false, text: message(error, 'refused') }); }
    }
    return out;
  }, onSuccess: out => { setLanded(out); setSelected([]); void cache.invalidateQueries({ queryKey: key }); } });
  const refresh = () => void inbox.refetch();
  if (inbox.error) return <div className="page-stack agent-inbox"><PageHeader title="Agent inbox" description="What agents are doing and what needs a person."/><PanelError error={inbox.error} retry={refresh}/></div>;
  if (!inbox.data) return <Loading label="Evaluating open pull requests…"/>;
  const value = inbox.data, writer = value.summaries.available;
  const pr = (number: number, text?: string) => <Link {...repositoryOptions(location, { view: 'pulls', pull: number })}>{text ?? `#${number}`}</Link>;
  const intentCell = (pull: InboxPull) => pull.decision === 'unavailable' ? <span className="muted">—</span>
    : pull.intent ? <button type="button" className="button secondary" aria-label={`Show intent summary for #${pull.number}`} onClick={() => setFocus(pull.number)}><Sparkles size={14} aria-hidden="true"/>Show intent</button>
    : writer ? <button type="button" className="button secondary" aria-label={`Summarize intent of #${pull.number}`} disabled={summarize.isPending && summarize.variables === pull.number}
        onClick={() => { setFocus(pull.number); summarize.mutate(pull.number); }}><Sparkles size={14} aria-hidden="true"/>Summarize intent</button>
    : <span className="muted">None</span>;
  const pullColumns = (ready: boolean): DataTableColumn<InboxPull>[] => [
    ...(ready && canLand ? [{ id: 'select', header: 'Select', enableSorting: false, cell: ({ row }) => row.original.decision === 'land'
      ? <input type="checkbox" aria-label={`Select #${row.original.number} to land`} checked={selected.includes(row.original.number)}
          onChange={event => setSelected(list => event.target.checked ? [...list, row.original.number] : list.filter(n => n !== row.original.number))}/> : null } as DataTableColumn<InboxPull>] : []),
    { accessorKey: 'number', header: 'PR', sortFn: 'basic', cell: ({ row }) => pr(row.original.number) },
    { accessorKey: 'title', header: 'Title', cell: ({ row }) => pr(row.original.number, row.original.title) },
    { accessorKey: 'author', header: 'Author' },
    { id: 'origin', header: 'Opened by', accessorFn: pull => originLabels[pull.origin] },
    { id: 'decision', header: 'Decision', accessorFn: decisionLabel, cell: ({ row }) => <span className={`pull-landing-decision ${row.original.decision}`}>{decisionLabel(row.original)}</span> },
    { id: 'risk', header: 'Risk', accessorFn: pull => pull.risk ? riskLabels[pull.risk] : '' },
    ...(ready ? [{ id: 'checks', header: 'Checks', accessorFn: (pull: InboxPull) => checkSummary(pull.checks) } as DataTableColumn<InboxPull>]
      : [{ id: 'reasons', header: 'Why', accessorFn: (pull: InboxPull) => [...pull.reasons, ...pull.conflicts.map(c => c.path)].join(' '), enableSorting: false, cell: ({ row }) => <div className="agent-inbox-reasons">
          <ul className="pull-landing-reasons">{row.original.reasons.map(reason => <li key={reason}>{reason}</li>)}</ul>
          {row.original.sensitivePaths.length ? <p className="field-help">Sensitive: {row.original.sensitivePaths.map(path => <code key={path}>{path}</code>)}</p> : null}
          {row.original.conflicts.length ? <p className="field-help">Conflicts: {row.original.conflicts.map(c => <code key={c.path} title={c.reason}>{c.path}</code>)}</p> : null}
        </div> } as DataTableColumn<InboxPull>]),
    { id: 'landing', header: 'Land queue', accessorFn: pull => pull.landing?.state || '' },
    { id: 'head', header: 'Head', accessorFn: pull => pull.headCommitId, cell: ({ row }) => row.original.headCommitId ? <code title={row.original.headCommitId}>{row.original.headCommitId.slice(0, 12)}</code> : null },
    { id: 'intent', header: 'Intent', enableSorting: false, cell: ({ row }) => intentCell(row.original) },
  ];
  const taskColumns: DataTableColumn<InboxTask>[] = [
    { id: 'target', header: 'Work', accessorFn: task => `#${task.target.number} ${task.target.title}`, cell: ({ row }) => { const t = row.original.target;
      return <Link {...repositoryOptions(location, t.kind === 'pull_request' ? { view: 'pulls', pull: t.number } : { view: 'issues', issue: t.number })}>#{t.number} {t.title}</Link>; } },
    { id: 'state', header: 'State', accessorFn: task => taskStateLabels[task.state] },
    { id: 'agent', header: 'Agent', accessorFn: task => `${task.tool}${task.model ? ' · ' + task.model : ''}` },
    { accessorKey: 'host', header: 'Host' },
    { accessorKey: 'requestedBy', header: 'Requested by' },
    { accessorKey: 'branch', header: 'Branch', cell: ({ row }) => <code>{row.original.branch}</code> },
    { id: 'created', header: 'Created', accessorFn: task => task.createdAt, cell: ({ row }) => <DateLabel value={row.original.createdAt} relative/> },
  ];
  const landedColumns: DataTableColumn<InboxLanding>[] = [
    { accessorKey: 'number', header: 'PR', sortFn: 'basic', cell: ({ row }) => pr(row.original.number) },
    { accessorKey: 'title', header: 'Title', cell: ({ row }) => pr(row.original.number, row.original.title || `Pull request #${row.original.number}`) },
    { id: 'state', header: 'Outcome', accessorFn: item => item.state === 'REVERTED' ? 'Reverted' : 'Landed' },
    { id: 'trigger', header: 'Landed by', accessorFn: item => item.trigger === 'policy' ? 'Policy' : item.actor || 'A person' },
    { accessorKey: 'method', header: 'Method' },
    { id: 'commit', header: 'Commit', accessorFn: item => item.landedCommitId, cell: ({ row }) => <>{row.original.landedCommitId ? <code title={row.original.landedCommitId}>{row.original.landedCommitId.slice(0, 12)}</code> : null}{row.original.revertCommitId ? <> · reverted by <code title={row.original.revertCommitId}>{row.original.revertCommitId.slice(0, 12)}</code></> : null}</> },
    { id: 'updated', header: 'When', accessorFn: item => item.updatedAt, cell: ({ row }) => <DateLabel value={row.original.updatedAt} relative/> },
  ];
  const ready = value.readyToLand, chosen = ready.filter(pull => selected.includes(pull.number) && pull.decision === 'land');
  const focused = [...ready, ...value.needsPerson].find(pull => pull.number === focus);
  return <div className="page-stack agent-inbox">
    <PageHeader title="Agent inbox" description="What agents are doing and what needs a person, from this repository’s landing policy."
      actions={<button className="button secondary" disabled={inbox.isFetching} onClick={refresh}><RefreshCw size={15} className={inbox.isFetching ? 'spin' : ''}/>Refresh</button>}/>
    <div className="agent-workspace-summary agent-inbox-summary" role="group" aria-label="Inbox counts">
      <div><span>In progress</span><strong>{value.inProgress.length}{value.truncated.inProgress ? '+' : ''}</strong><small>Agent tasks not finished</small></div>
      <div><span>Ready to land</span><strong>{ready.length}</strong><small>May land now or waiting for checks</small></div>
      <div><span>Needs a person</span><strong>{value.needsPerson.length}</strong><small>Review, sensitive paths, conflicts or failed checks</small></div>
      <div><span>Landed</span><strong>{value.landingHistory === 'available' ? value.landed.length : '—'}</strong><small>{value.landingHistory === 'available' ? 'Recent landings and reverts' : 'Landing history unavailable'}</small></div>
    </div>
    {value.pulls.state !== 'evaluated' ? <p className="field-help" role="note">{value.pulls.reason}</p>
      : <p className="field-help">Evaluated {value.pulls.evaluated} of {value.pulls.open} open pull {value.pulls.open === 1 ? 'request' : 'requests'}, newest first{value.truncated.pulls ? `; at most ${value.pulls.evaluateLimit} are evaluated per read, so older ones are not shown here. Open Pull requests for the rest` : ''}. <DateLabel value={value.generatedAt} relative/></p>}
    {!value.summaries.available ? <p className="field-help">Intent summaries: {value.summaries.reason}</p> : null}

    <section className="browser-panel" aria-label="In progress"><div className="browser-panel-heading"><h3>In progress</h3>{value.truncated.inProgress ? <span className="field-help">Newest {value.limit} loaded</span> : null}</div>
      <DataTable data={value.inProgress} columns={taskColumns} getRowId={task => task.id} label="agent tasks in progress" emptyMessage="No agent task is queued or running."/></section>

    <section className="browser-panel" aria-label="Ready to land"><div className="browser-panel-heading"><h3>Ready to land</h3>
      {canLand ? <button type="button" className="button primary" disabled={!chosen.length || land.isPending} onClick={() => land.mutate(chosen)}>{land.isPending ? <LoaderCircle size={14} className="spin" aria-hidden="true"/> : null}Land selected ({chosen.length})</button> : null}</div>
      <DataTable data={ready} columns={pullColumns(true)} getRowId={pull => pull.pullRequestId} label="pull requests ready to land" emptyMessage="No evaluated pull request may land now or is waiting only for checks."/>
      {landed.length ? <ul className="agent-inbox-results" aria-label="Landing requests">{landed.map(result => <li key={result.number} className={result.ok ? '' : 'error'}>#{result.number}: {result.text}</li>)}</ul> : null}
      {!canLand ? <p className="panel-footnote">Golf does not land pull requests from the inbox on this installation; land them from each pull request.</p> : null}</section>

    <section className="browser-panel" aria-label="Needs a person"><div className="browser-panel-heading"><h3>Needs a person</h3></div>
      <DataTable data={value.needsPerson} columns={pullColumns(false)} getRowId={pull => pull.pullRequestId} label="pull requests that need a person" emptyMessage="No evaluated pull request needs a person."/></section>

    {focused ? <IntentPanel key={focused.number} {...{ location, context, userId, pull: focused, request: summarize.variables === focused.number ? summarize : undefined, onClose: () => setFocus(undefined) }}/> : null}

    <section className="browser-panel" aria-label="Landed"><div className="browser-panel-heading"><h3>Landed</h3>{value.truncated.landed ? <span className="field-help">Newest {value.limit} loaded</span> : null}</div>
      {value.landingHistory === 'available' ? <DataTable data={value.landed} columns={landedColumns} getRowId={item => item.id} label="recent landings" emptyMessage="Nothing has landed through the land queue yet."/>
        : <p className="credential-form-content" role="status">Landing history unavailable: this installation has no land queue yet.</p>}</section>
  </div>;
}

function reads(summary: IntentSummary) {
  const c = summary.coverage;
  return `Read ${c.files} of ${c.totalFiles} changed ${c.totalFiles === 1 ? 'file' : 'files'} (${kib(c.bytes)} of at most ${kib(c.limitBytes)})${c.notReadCount ? `; ${c.notReadCount} not read` : ''}${c.descriptionTruncated ? ', the title and the first 4 KiB of the description' : ', the title and the description'}.`;
}

// The intent summary of one pull request's current head: AI-written, next to (never instead of) the diff.
function IntentPanel({ location, context, userId, pull, request, onClose }: { location: RepositoryLocation; context: Context; userId: string; pull: InboxPull;
  request?: { isPending: boolean; error: Error | null; data?: { state: string; run: { state: string; refusal?: string } | null } }; onClose: () => void }) {
  const visible = usePageVisible(), cache = useQueryClient();
  const intent = useQuery({ ...privateQuery, queryKey: ['repository', userId, location.owner, location.name, 'agent-workspace', 'intent', pull.number], queryFn: ({ signal }) => readIntent(context, pull.number, signal),
    // Polled only while a summary is being written for this head.
    refetchInterval: query => visible && query.state.data && !query.state.data.summary && (query.state.data.inFlight || ['REQUESTED', 'RESERVED'].includes(query.state.data.run?.state || '')) ? 2500 : false });
  const data = intent.data, summary = data?.summary ?? null;
  const running = !summary && (request?.isPending || data?.inFlight || ['REQUESTED', 'RESERVED'].includes(data?.run?.state || ''));
  const failed = !summary && !running && data?.run && ['UNKNOWN', 'REFUSED'].includes(data.run.state) ? data.run : undefined;
  // A newly stored summary also shows in the inbox row.
  useEffect(() => { if (summary && !pull.intent) void cache.invalidateQueries({ queryKey: inboxKey(userId, location.owner, location.name) }); }, [summary, pull.intent, cache, userId, location.owner, location.name]);
  return <AiAdvisory title={`Intent summary · #${pull.number}`} label={`Intent summary for #${pull.number}`} model={summary?.model} commitId={data?.headCommitId || pull.headCommitId} at={summary?.createdAt}
    reads={summary ? reads(summary) : 'Workers AI reads the diff of the current head (whole files, up to 48 KiB), the title and the description. It reads no review comments.'}
    actions={<span className="ai-advisory-flags"><span className="visibility configured">AI-written</span><button type="button" className="button secondary" onClick={onClose}>Close</button></span>}>
    {intent.error ? <p className="error" role="alert">{message(intent.error, 'The intent summary could not be read.')}</p> : null}
    {request?.error ? <p className="error" role="alert">{message(request.error, 'The request could not be confirmed.')}</p> : null}
    {summary ? <div className="agent-inbox-intent">
      <p>{summary.intent}</p>
      <h4>Areas</h4>{summary.areas.length ? <ul>{summary.areas.map(area => <li key={area}>{area}</li>)}</ul> : <p className="muted">None named.</p>}
      <h4>Risks</h4>{summary.risks.length ? <ul>{summary.risks.map(risk => <li key={risk}>{risk}</li>)}</ul> : <p className="muted">None named. That is not an approval: the model reads at most 48 KiB and can miss problems.</p>}
      <p className="field-help">Model confidence: {summary.confidence}.</p>
    </div> : running ? <p className="ai-advisory-empty" role="status"><LoaderCircle className="spin" size={14} aria-hidden="true"/> Workers AI is reading the diff of {(data?.headCommitId || pull.headCommitId).slice(0, 12)}. This usually takes under a minute.</p>
      : failed ? <p className="field-help" role="status">{failed.state === 'UNKNOWN' ? 'The latest request’s outcome is unknown: Workers AI may have been called, but no summary was stored (its answer may have failed validation).' : `The latest request was refused: ${failed.refusal || 'nothing was billed.'}`}</p>
      : intent.isPending ? <p className="ai-advisory-empty" role="status">Reading…</p> : <p className="ai-advisory-empty">No intent summary for this head commit yet.</p>}
    <p className="field-help">It never replaces the diff. <Link {...repositoryOptions(location, { view: 'pulls', pull: pull.number, pullView: 'files' })}>Review the changes</Link></p>
  </AiAdvisory>;
}
