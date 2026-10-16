import { useEffect, useState } from 'react';
import { useForm } from '@tanstack/react-form';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { LoaderCircle, RefreshCw, Sparkles, Undo2 } from 'lucide-react';
import { DataTable, type DataTableColumn } from './DataTable';
import { errorMessage } from './api';
import { AiAdvisory } from './AiAdvisory';
import { DateLabel, Loading, PageHeader, PanelError, privateQuery, usePageVisible } from './RepositoryUI';
import { useLiveStatus } from './RepositoryLive';
import { repositoryOptions, type RepositoryLocation } from './navigation';
import { decisionLabels, landSummary, riskLabels, type LandMethod } from './agenticMode';
import { inboxKey, landSelected, originLabels, readInbox, readIntent, revertLanding, summarizeIntent, taskStateLabels, type InboxLanding, type InboxPull, type InboxTask, type IntentSummary } from './agentInbox';
import { landOutcome, outcomeLabels, type LandOutcome } from './landOutcomes';

type Context = { repository: { owner: string; name: string }; repositoryId: string };
const kib = (bytes: number) => `${bytes < 10 * 1024 ? (bytes / 1024).toFixed(1) : Math.round(bytes / 1024)} KiB`;
const message = (error: unknown, fallback: string) => error instanceof Error ? error.message : fallback;
const decisionLabel = (pull: InboxPull) => pull.decision === 'unavailable' ? 'Not evaluated' : decisionLabels[pull.decision];
const checkSummary = ({ passed, pending, failed }: InboxPull['checks']) => passed + pending + failed === 0 ? 'None reported' : [failed ? `${failed} failed` : '', pending ? `${pending} pending` : '', passed ? `${passed} passed` : ''].filter(Boolean).join(', ');
// Lands at a time from one confirmation; the land queue runs different pull requests side by side.
const batchConcurrency = 3;
// The landing's revert as one line, from the inbox row (the same words as a land operation's summary).
const landingNote = (item: InboxLanding) => landSummary({ id: item.id, repositoryId: '', pullRequestId: item.pullRequestId, number: item.number, trigger: item.trigger, actorId: '', actor: item.actor, state: item.state,
  method: item.method === 'squash' ? 'squash' : 'merge', headCommitId: item.headCommitId, baseCommitId: '', landedCommitId: item.landedCommitId, revertCommitId: item.revertCommitId, attempts: 0, createdAt: item.createdAt, updatedAt: item.updatedAt,
  detail: item.revert ? { revert: { state: item.revert.state, reason: item.revert.reason, ...(item.revert.trigger === 'person' ? { trigger: 'person' as const, actor: item.revert.actor } : {}), conflicts: item.revert.conflicts.map(path => ({ path, reason: '' })) } } : {} });
const revertBusy = (item: InboxLanding) => ['requested', 'sending', 'unknown'].includes(item.revert?.state || '');

// The agentic inbox (docs/AGENTIC_MODE.md): what agents are doing and what needs a person, while agentic mode is on. Writers ask Workers AI
// for intent summaries and, where the Worker reports the land queue, land a selection of pull requests and revert landings.
export function AgentInbox({ location, context, userId, canLand }: { location: RepositoryLocation; context: Context; userId: string; canLand: boolean }) {
  const cache = useQueryClient(), visible = usePageVisible(), live = useLiveStatus() === 'live';
  const key = inboxKey(userId, location.owner, location.name);
  // The activity stream refreshes it; without a live connection it is read again every 30 s while visible.
  const inbox = useQuery({ ...privateQuery, queryKey: key, queryFn: ({ signal }) => readInbox(context, signal), refetchInterval: visible && !live ? 30000 : false });
  const [focus, setFocus] = useState<number>();
  const [selected, setSelected] = useState<number[]>([]);
  const [confirming, setConfirming] = useState(false);
  const [outcomes, setOutcomes] = useState<LandOutcome[]>([]);
  const [reverting, setReverting] = useState<InboxLanding>();
  const [notice, setNotice] = useState('');
  const summarize = useMutation({ mutationFn: (number: number) => summarizeIntent(context, number), onSuccess: value => {
    cache.setQueryData(['repository', userId, location.owner, location.name, 'agent-workspace', 'intent', value.number], (old: object | undefined) => ({ ...old, ...value, inFlight: value.state === 'RUNNING' }));
    if (value.summary) void cache.invalidateQueries({ queryKey: key });
  } });
  const refresh = () => void inbox.refetch();
  if (inbox.error) return <div className="page-stack agent-inbox"><PageHeader title="Agent inbox" description="What agents are doing and what needs a person."/><PanelError error={inbox.error} retry={refresh}/></div>;
  if (!inbox.data) return <Loading label="Evaluating open pull requests…"/>;
  const value = inbox.data, writer = value.summaries.available;
  // Older Workers do not say per row or per inbox; then only rows the policy says land are offered, as before.
  const landing = canLand && value.actions?.land !== false, reverts = canLand && value.landingHistory === 'available' && value.actions?.revert === true;
  const selectable = (pull: InboxPull) => landing && Boolean(pull.headCommitId) && (pull.canLand ?? pull.decision === 'land');
  const pr = (number: number, text?: string) => <Link {...repositoryOptions(location, { view: 'pulls', pull: number })}>{text ?? `#${number}`}</Link>;
  const intentCell = (pull: InboxPull) => pull.decision === 'unavailable' ? <span className="muted">—</span>
    : pull.intent ? <button type="button" className="button secondary" aria-label={`Show intent summary for #${pull.number}`} onClick={() => setFocus(pull.number)}><Sparkles size={14} aria-hidden="true"/>Show intent</button>
    : writer ? <button type="button" className="button secondary" aria-label={`Summarize intent of #${pull.number}`} disabled={summarize.isPending && summarize.variables === pull.number}
        onClick={() => { setFocus(pull.number); summarize.mutate(pull.number); }}><Sparkles size={14} aria-hidden="true"/>Summarize intent</button>
    : <span className="muted">None</span>;
  const selectColumn: DataTableColumn<InboxPull> = { id: 'select', header: 'Select', enableSorting: false, enableGlobalFilter: false, cell: ({ row }) => selectable(row.original)
    ? <input type="checkbox" aria-label={`Select #${row.original.number} to ${row.original.decision === 'land' ? 'land' : 'approve and land'}`} checked={selected.includes(row.original.number)} disabled={confirming}
        onChange={event => setSelected(list => event.target.checked ? [...list, row.original.number] : list.filter(n => n !== row.original.number))}/> : null };
  const pullColumns = (ready: boolean): DataTableColumn<InboxPull>[] => [
    ...(landing && (ready ? value.readyToLand : value.needsPerson).some(selectable) ? [selectColumn] : []),
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
    { id: 'note', header: 'Revert', accessorFn: landingNote, cell: ({ row }) => <span className="agent-inbox-note">{row.original.revert || row.original.state === 'REVERTED' ? landingNote(row.original) : '—'}</span> },
    { id: 'updated', header: 'When', accessorFn: item => item.updatedAt, cell: ({ row }) => <DateLabel value={row.original.updatedAt} relative/> },
    ...(reverts ? [{ id: 'actions', header: 'Actions', enableSorting: false, enableGlobalFilter: false, cell: ({ row }) => row.original.state === 'LANDED' && row.original.landedCommitId
      ? <button type="button" className="button secondary" aria-label={`Revert the landing of #${row.original.number}`} disabled={revertBusy(row.original) || reverting?.id === row.original.id}
          onClick={() => { setNotice(''); setReverting(row.original); }}><Undo2 size={14} aria-hidden="true"/>Revert…</button> : null } as DataTableColumn<InboxLanding>] : []),
  ];
  const all = [...value.readyToLand, ...value.needsPerson], chosen = all.filter(pull => selected.includes(pull.number) && selectable(pull));
  const approvals = chosen.filter(pull => pull.decision !== 'land').length;
  const focused = all.find(pull => pull.number === focus);
  const landLabel = `${approvals ? 'Approve and land' : 'Land'} selected (${chosen.length})`;
  return <div className="page-stack agent-inbox">
    <PageHeader title="Agent inbox" description="What agents are doing and what needs a person, from this repository’s landing policy."
      actions={<button className="button secondary" disabled={inbox.isFetching} onClick={refresh}><RefreshCw size={15} className={inbox.isFetching ? 'spin' : ''}/>Refresh</button>}/>
    <div className="agent-workspace-summary agent-inbox-summary" role="group" aria-label="Inbox counts">
      <div><span>In progress</span><strong>{value.inProgress.length}{value.truncated.inProgress ? '+' : ''}</strong><small>Agent tasks not finished</small></div>
      <div><span>Ready to land</span><strong>{value.readyToLand.length}</strong><small>May land now or waiting for checks</small></div>
      <div><span>Needs a person</span><strong>{value.needsPerson.length}</strong><small>Review, sensitive paths, conflicts or failed checks</small></div>
      <div><span>Landed</span><strong>{value.landingHistory === 'available' ? value.landed.length : '—'}</strong><small>{value.landingHistory === 'available' ? 'Recent landings and reverts' : 'Landing history unavailable'}</small></div>
    </div>
    {value.pulls.state !== 'evaluated' ? <p className="field-help" role="note">{value.pulls.reason}</p>
      : <p className="field-help">Evaluated {value.pulls.evaluated} of {value.pulls.open} open pull {value.pulls.open === 1 ? 'request' : 'requests'}, newest first{value.truncated.pulls ? `; at most ${value.pulls.evaluateLimit} are evaluated per read, so older ones are not shown here. Open Pull requests for the rest` : ''}. <DateLabel value={value.generatedAt} relative/></p>}
    {!value.summaries.available ? <p className="field-help">Intent summaries: {value.summaries.reason}</p> : null}

    <section className="browser-panel" aria-label="In progress"><div className="browser-panel-heading"><h3>In progress</h3>{value.truncated.inProgress ? <span className="field-help">Newest {value.limit} loaded</span> : null}</div>
      <DataTable data={value.inProgress} columns={taskColumns} getRowId={task => task.id} label="agent tasks in progress" emptyMessage="No agent task is queued or running."/></section>

    <section className="browser-panel" aria-label="Ready to land"><div className="browser-panel-heading"><h3>Ready to land</h3>
      {landing ? <button type="button" className="button primary" disabled={!chosen.length || confirming} onClick={() => { setOutcomes([]); setConfirming(true); }}>{landLabel}</button> : null}</div>
      <DataTable data={value.readyToLand} columns={pullColumns(true)} getRowId={pull => pull.pullRequestId} label="pull requests ready to land" emptyMessage="No evaluated pull request may land now or is waiting only for checks."/>
      {confirming ? <LandSelection context={context} pulls={chosen} onProgress={setOutcomes} done={finished => { setConfirming(false); if (finished) { setSelected([]); void cache.invalidateQueries({ queryKey: key }); } }}/> : null}
      {outcomes.length ? <ul className="agent-inbox-results" aria-label="Landing requests">{outcomes.map(result => <li key={result.number} className={result.kind}><strong>#{result.number} {outcomeLabels[result.kind]}</strong> · {result.text}</li>)}</ul> : null}
      {!canLand ? <p className="panel-footnote">Golf does not land pull requests from the inbox on this installation; land them from each pull request.</p>
        : !landing ? <p className="panel-footnote">{value.actions?.reason || 'Landing from the inbox is not available.'}</p>
        : <p className="panel-footnote">Select pull requests the policy lets you land: those that may land now, and those in Needs a person that only wait for a writer who is not the author (your land request is that approval). Each is one land request for the head shown.</p>}</section>

    <section className="browser-panel" aria-label="Needs a person"><div className="browser-panel-heading"><h3>Needs a person</h3></div>
      <DataTable data={value.needsPerson} columns={pullColumns(false)} getRowId={pull => pull.pullRequestId} label="pull requests that need a person" emptyMessage="No evaluated pull request needs a person."/></section>

    {focused ? <IntentPanel key={focused.number} {...{ location, context, userId, pull: focused, request: summarize.variables === focused.number ? summarize : undefined, onClose: () => setFocus(undefined) }}/> : null}

    <section className="browser-panel" aria-label="Landed"><div className="browser-panel-heading"><h3>Landed</h3>{value.truncated.landed ? <span className="field-help">Newest {value.limit} loaded</span> : null}</div>
      {value.landingHistory === 'available' ? <DataTable data={value.landed} columns={landedColumns} getRowId={item => item.id} label="recent landings" emptyMessage="Nothing has landed through the land queue yet."/>
        : <p className="credential-form-content" role="status">Landing history unavailable: this installation has no land queue yet.</p>}
      {reverting ? <RevertForm key={reverting.id} context={context} item={reverting} done={result => { setReverting(undefined); if (result) { setNotice(result); void cache.invalidateQueries({ queryKey: key }); } }}/> : null}
      {notice ? <p className="session-notice" role="status">{notice}</p> : null}
      {value.landingHistory === 'available' && canLand && !reverts && value.actions?.reason ? <p className="panel-footnote">Reverting: {value.actions.reason}</p> : null}</section>
  </div>;
}

// The confirmation of a batch: the selected pull requests at the heads shown, merge or squash, then one land request per pull request
// with its own idempotency key (fixed for this confirmation), a few at a time; each answer is reported as the land queue gave it.
function LandSelection({ context, pulls, onProgress, done }: { context: Context; pulls: InboxPull[]; onProgress: (outcomes: LandOutcome[]) => void; done: (finished: boolean) => void }) {
  const [keys] = useState(() => new Map(pulls.map(pull => [pull.number, crypto.randomUUID()])));
  const form = useForm({ defaultValues: { method: 'merge' as LandMethod }, onSubmit: async ({ value }) => {
    const results = new Map<number, LandOutcome>(), queue = [...pulls];
    const report = () => onProgress(pulls.flatMap(pull => results.get(pull.number) ?? []));
    await Promise.all(Array.from({ length: Math.min(batchConcurrency, queue.length) }, async () => {
      for (let pull = queue.shift(); pull; pull = queue.shift()) {
        try { results.set(pull.number, landOutcome(pull.number, await landSelected(context, pull, value.method, keys.get(pull.number)!))); }
        catch (error) { results.set(pull.number, landOutcome(pull.number, undefined, error)); }
        report();
      }
    }));
    done(true);
  } });
  return <form className="credential-form-content agent-inbox-confirm" aria-label="Confirm landing" onSubmit={event => { event.preventDefault(); void form.handleSubmit(); }}>
    <h4>Land {pulls.length} pull {pulls.length === 1 ? 'request' : 'requests'}</h4>
    <ul className="agent-inbox-selection">{pulls.map(pull => <li key={pull.number}><strong>#{pull.number}</strong> {pull.title} · <code title={pull.headCommitId}>{pull.headCommitId.slice(0, 12)}</code>
      {pull.decision !== 'land' ? <span className="field-help"> · your land request is the approval it waits for</span> : null}</li>)}</ul>
    <form.Field name="method">{field => <fieldset className="policy-choices"><legend>Land each onto the current base</legend>
      <label className="policy-choice"><input type="radio" name="batch-land-method" checked={field.state.value === 'merge'} onChange={() => field.handleChange('merge')}/><span><strong>Merge</strong><small>A merge commit keeps every commit of the branch.</small></span></label>
      <label className="policy-choice"><input type="radio" name="batch-land-method" checked={field.state.value === 'squash'} onChange={() => field.handleChange('squash')}/><span><strong>Squash</strong><small>One commit with the pull request title.</small></span></label>
    </fieldset>}</form.Field>
    <p className="field-help">The land queue evaluates each pull request again. A head that moved, a policy that no longer allows it or overlapping changes stop that one; the others still land.</p>
    <form.Subscribe selector={state => state.isSubmitting}>{submitting => <div className="credential-actions">
      <button className="button primary" disabled={submitting}>{submitting ? <><LoaderCircle size={14} className="spin" aria-hidden="true"/>Landing…</> : `Land ${pulls.length} now`}</button>
      <button type="button" className="button secondary" disabled={submitting} onClick={() => done(false)}>Cancel</button></div>}</form.Subscribe>
  </form>;
}

// The confirmation of a revert: what Golf will commit, as whom, and an optional reason; one idempotency key per confirmation.
function RevertForm({ context, item, done }: { context: Context; item: InboxLanding; done: (result: string) => void }) {
  const [key] = useState(() => crypto.randomUUID()), [error, setError] = useState('');
  const form = useForm({ defaultValues: { reason: '' }, onSubmit: async ({ value }) => {
    setError('');
    try {
      const answer = await revertLanding(context, item, value.reason, key);
      if (answer.phase === 'REVERTED') return done(`Reverted #${item.number} with ${answer.operation.revertCommitId.slice(0, 12)}.`);
      if (answer.phase === 'REVERTING') return done(`The revert of #${item.number} was sent; its outcome is not confirmed yet. Maintenance reads the branch back.`);
      const r = answer.revert;
      setError(r?.state === 'conflict' ? `Not reverted: it conflicts with later changes in ${(r.conflicts || []).map(c => c.path).join(', ')}. Revert it by hand.`
        : r?.state === 'noop' ? 'Not reverted: the base branch no longer holds the change.' : `Not reverted: ${r?.reason || 'refused'}.`);
    } catch (e) { setError(e instanceof Error ? errorMessage(e) : 'The revert could not be confirmed.'); }
  } });
  return <form className="credential-form-content agent-inbox-confirm" aria-label={`Revert #${item.number}`} onSubmit={event => { event.preventDefault(); void form.handleSubmit(); }}>
    <h4>Revert #{item.number} {item.title}</h4>
    <p>Golf commits the inverse of <code title={item.landedCommitId}>{item.landedCommitId.slice(0, 12)}</code> onto the current base branch, as you, through the branch write fence. Branch rules apply, pipelines run on the revert and the pull request gets a comment. Overlapping later changes stop it.</p>
    <form.Field name="reason">{field => <label>Reason (optional, in the commit message and the comment)<textarea rows={2} maxLength={500} value={field.state.value} onChange={event => field.handleChange(event.target.value)}/></label>}</form.Field>
    {error ? <p className="error" role="alert">{error}</p> : null}
    <form.Subscribe selector={state => state.isSubmitting}>{submitting => <div className="credential-actions">
      <button className="button session-danger" disabled={submitting}>{submitting ? 'Reverting…' : `Revert #${item.number}`}</button>
      <button type="button" className="button secondary" disabled={submitting} onClick={() => done('')}>Cancel</button></div>}</form.Subscribe>
  </form>;
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
