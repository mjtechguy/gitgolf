import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Link } from '@tanstack/react-router';
import { useForm } from '@tanstack/react-form';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ConnectError } from '@connectrpc/connect';
import { Ban, Bot, ArrowDown, GitBranch, GitCommitHorizontal, GitPullRequest, RefreshCw, X } from 'lucide-react';
import { errorBody, nativeAPI as api } from './nativeAPI';
import { repositoryClient } from './api';
import { CopyButton, DateLabel, Loading, privateQuery, usePageVisible } from './RepositoryUI';
import { DataTable, type DataTableColumn } from './DataTable';
import { DetailsDialog } from './DetailsDialog';
import { MarkdownBody } from './RepositoryContent';
import { StateIcon, duration } from './NativeActions';
import { repositoryOptions } from './navigation';
import { useRuntimeCapabilities } from './useRuntimeCapabilities';
import { settingAvailable } from './runtimeCapabilities';
import { policyOff, useRepositoryFeatures } from './RepositoryFeatures';
import { RepositorySourceRefKind, RepositorySourceResolution } from './gen/golf/v1/golf_pb';
import { activeTask, branchName, failureText, pipelineState, requesterLogin, scopeLabels, signedInLabel, targetLabel, taskStateLabels, toolLabel,
  type AgentTask, type Available, type TaskLog, type TaskTarget } from './agentHosts';

type Context = { repository: { owner: string; name: string }; repositoryId: string };
const message = (error: unknown) => error instanceof Error ? error.message : 'The agent task request could not be confirmed.';
const tasksPath = '/native/agent-tasks';
const ansi = /\x1b\[[0-9;?]*[A-Za-z]/g;

// Native only, with the agent hosts capability reported; writers may assign, and a policy that turns the feature off hides assignment.
function useAgentHostAccess(context: Context, userId: string) {
  const runtime = useRuntimeCapabilities(), manifest = runtime.isError ? undefined : runtime.data;
  const allowed = manifest?.runtimeProfile === 'cloudflare-native' && settingAvailable(manifest, 'agents.hosts');
  const access = useQuery({ ...privateQuery, queryKey: ['native-repository', context.repositoryId, 'access'], enabled: allowed, queryFn: ({ signal }) => api<{ role: string }>('/native/repository-access', context, signal) });
  const off = policyOff(useRepositoryFeatures(userId, context.repository.owner, context.repository.name, allowed).data?.features, 'agent-hosts');
  return { allowed, writer: ['write', 'admin'].includes(access.data?.role || ''), admin: access.data?.role === 'admin', off };
}

// The agent tasks of one issue or pull request (with "Assign to agent"), or of the whole repository when no target is given.
export function NativeAgentTasks({ context, userId, target, title }: { context: Context; userId: string; target?: TaskTarget; title?: string }) {
  const { allowed, writer, admin, off } = useAgentHostAccess(context, userId);
  const visible = usePageVisible(), client = useQueryClient();
  const key = ['native-agent-tasks', userId, context.repositoryId, target ? `${target.kind}:${target.number}` : 'all'];
  const tasks = useQuery({ ...privateQuery, queryKey: key, enabled: allowed, queryFn: ({ signal }) => api<{ tasks: AgentTask[]; canAssign?: boolean }>(tasksPath, { ...context, action: 'list', ...(target ? { target: { kind: target.kind, number: target.number } } : {}) }, signal),
    refetchInterval: query => visible && query.state.data?.tasks.some(task => activeTask(task.state)) ? 5000 : false });
  const [selected, setSelected] = useState<string>(), [assigning, setAssigning] = useState(false);
  if (!allowed) return null;
  // The Worker says whether this caller may assign here; the role and policy decide until it has answered.
  const rows = tasks.data?.tasks || [], canAssign = Boolean(target) && (tasks.data?.canAssign ?? (writer && !off));
  // Readers see the panel only once there is something to read.
  if (target && !canAssign && !rows.length && !tasks.isError) return null;
  const location = (task: AgentTask) => repositoryOptions({ owner: context.repository.owner, name: context.repository.name }, task.target.kind === 'pull_request' ? { view: 'pulls', pull: task.target.number } : { view: 'issues', issue: task.target.number });
  const current = rows.find(task => task.id === selected);
  const columns: DataTableColumn<AgentTask>[] = [
    { id: 'task', header: 'Task', accessorFn: task => `${toolLabel(task.tool)} ${task.host.name} ${taskStateLabels[task.state] || task.state}`, cell: ({ row: { original: task } }) => <div className="agent-task-row"><StateIcon state={pipelineState(task.state)} label={taskStateLabels[task.state]} size={16} />
      <div><button type="button" className="text-button" aria-pressed={task.id === selected} onClick={() => setSelected(task.id === selected ? undefined : task.id)}>{toolLabel(task.tool)} on {task.host.name}</button><small>{taskStateLabels[task.state] || task.state}{task.model ? ` · ${task.model}` : ''}</small></div></div> },
    ...(target ? [] : [{ id: 'target', header: 'For', accessorFn: (task: AgentTask) => targetLabel(task.target), cell: ({ row: { original: task } }: { row: { original: AgentTask } }) => <Link {...location(task)}>{targetLabel(task.target)}</Link> } as DataTableColumn<AgentTask>]),
    { id: 'requester', header: 'Requested by', accessorFn: requesterLogin },
    { id: 'created', header: 'Created', accessorFn: task => task.createdAt, cell: ({ row }) => <DateLabel value={row.original.createdAt} relative /> },
    { id: 'duration', header: 'Duration', accessorFn: task => duration(task.startedAt, task.finishedAt) || '—', enableSorting: false },
  ];
  return <section className="browser-panel agent-tasks" aria-labelledby={`agent-tasks-${key[3]}`}>
    <div className="browser-panel-heading"><h3 id={`agent-tasks-${key[3]}`}><Bot size={16} aria-hidden="true" /> {title || 'Agent tasks'}</h3>
      <div className="row-actions"><button className="icon-button" aria-label="Refresh agent tasks" title="Refresh agent tasks" disabled={tasks.isFetching} onClick={() => void tasks.refetch()}><RefreshCw size={15} className={tasks.isFetching ? 'spin' : ''} /></button>
        {canAssign ? <button className="button secondary" onClick={() => setAssigning(true)}><Bot size={15} aria-hidden="true" />Assign to agent</button> : null}</div></div>
    {off ? <p className="field-help">{off.reason} Existing tasks stay readable.</p> : null}
    {tasks.isError ? <p className="error" role="alert">{message(tasks.error)}</p> : !tasks.data ? <Loading label="Reading agent tasks…" /> : rows.length ? <><DataTable data={rows} columns={columns} getRowId={task => task.id} label="agent tasks" pagination={false} />{rows.length >= 50 ? <p className="panel-footnote">The newest 50 tasks are shown.</p> : null}</>
      : <p className="field-help">{target ? `No agent has worked on this ${target.kind === 'pull_request' ? 'pull request' : 'issue'} yet. Assign it to a coding tool on one of your connected machines; the result is a branch you can open as a pull request.` : 'No agent tasks in this repository yet. Assign an issue or a pull request to an agent from its page.'}</p>}
    {current ? <AgentTaskDetail key={current.id} context={context} userId={userId} initial={current} writer={writer} admin={admin} close={() => setSelected(undefined)} listKey={key} targetTitle={target?.title} /> : null}
    {assigning && target ? <AssignToAgent context={context} userId={userId} target={target} close={() => setAssigning(false)}
      created={task => { client.setQueryData<{ tasks: AgentTask[] }>(key, value => ({ tasks: [task, ...(value?.tasks || []).filter(row => row.id !== task.id)] })); setSelected(task.id); setAssigning(false); void tasks.refetch(); }} /> : null}
  </section>;
}

function AssignToAgent({ context, userId, target, close, created }: { context: Context; userId: string; target: TaskTarget; close: () => void; created: (task: AgentTask) => void }) {
  const available = useQuery({ ...privateQuery, queryKey: ['native-agent-tasks', userId, context.repositoryId, 'available'], queryFn: ({ signal }) => api<Available>(tasksPath, { ...context, action: 'available' }, signal) });
  const [error, setError] = useState<unknown>();
  // One key per submission; a request whose outcome is unknown (no answer) keeps it, so trying again cannot start a second task.
  const idempotencyKey = useRef(crypto.randomUUID());
  const hosts = available.data?.hosts || [];
  const usable = hosts.flatMap(host => host.tools.filter(tool => tool.usable).map(tool => ({ host, tool })));
  const best = usable.find(choice => choice.host.online) || usable[0], first = best ? `${best.host.id}:${best.tool.tool}` : '';
  const form = useForm({ defaultValues: { choice: first, model: '', instructions: '' }, onSubmit: async ({ value }) => {
    setError(undefined);
    const split = value.choice.indexOf(':'), hostId = value.choice.slice(0, split), tool = value.choice.slice(split + 1);
    try {
      const result = await api<{ task: AgentTask }>(tasksPath, { ...context, action: 'create', target: { kind: target.kind, number: target.number }, hostId, tool, ...(value.model.trim() ? { model: value.model.trim() } : {}), ...(value.instructions.trim() ? { instructions: value.instructions } : {}), idempotencyKey: idempotencyKey.current });
      idempotencyKey.current = crypto.randomUUID(); created(result.task);
    } catch (e) { if (e instanceof ConnectError) idempotencyKey.current = crypto.randomUUID(); setError(e); }
  } });
  // The first usable choice arrives with the read; a choice the user made is kept.
  useEffect(() => { if (first && !form.getFieldValue('choice')) form.setFieldValue('choice', first); }, [first, form]);
  const what = target.kind === 'pull_request' ? 'pull request' : 'issue';
  return <DetailsDialog title="Assign to agent" onClose={close} closeLabel="Close assign to agent">
    <p className="field-help">A coding tool on a connected machine works on {what} #{target.number} in a fresh copy of the repository and pushes one commit to a new <code>golf-agent/…</code> branch. It never opens or merges a pull request; you decide that after reading the result.</p>
    {available.isError ? <p className="error" role="alert">{message(available.error)}</p> : !available.data ? <Loading label="Reading available hosts…" />
      : !available.data.featureOn ? <p className="error" role="alert">{available.data.reason || 'Coding agents on your machines are turned off for this repository.'}</p>
      : !hosts.length ? <p className="field-help">No agent host you may use covers this repository. Connect a machine in <Link to="/account/agents">Settings → Agent hosts</Link>, or ask an organization owner to share one.</p>
      : <form className="credential-form-content agent-assign" aria-label="Assign to agent" onSubmit={event => { event.preventDefault(); void form.handleSubmit(); }}>
        <form.Field name="choice">{field => <>{hosts.map(host => <fieldset key={host.id} className="policy-choices">
          <legend><strong>{host.name}</strong> · {scopeLabels[host.scope] || host.scope} · {host.online ? 'online' : 'offline, the task waits until it calls in'}</legend>
          {host.tools.length ? host.tools.map(tool => { const value = `${host.id}:${tool.tool}`; return <label key={tool.tool} className="policy-choice">
            <input type="radio" name="agent-choice" value={value} disabled={!tool.usable} checked={field.state.value === value} onChange={() => field.handleChange(value)} />
            <span><strong>{toolLabel(tool.tool)}</strong><small>{[tool.version, signedInLabel(tool.signedIn)].filter(Boolean).join(' · ')}</small>{!tool.usable && tool.reason ? <small className="agent-choice-reason">{tool.reason}</small> : null}</span></label>; })
            : <p className="field-help">This host has not reported any coding tool.</p>}
        </fieldset>)}</>}</form.Field>
        <form.Field name="model">{field => <label>Model <span className="optional">optional</span><input value={field.state.value} maxLength={128} autoComplete="off" placeholder="The tool’s default" onChange={e => field.handleChange(e.target.value)} /></label>}</form.Field>
        <form.Field name="instructions">{field => <label>Instructions <span className="optional">optional</span><textarea rows={4} maxLength={4096} value={field.state.value} onChange={e => field.handleChange(e.target.value)} placeholder="Anything to add to the issue text, for example where to look or how to test" /></label>}</form.Field>
        <p className="field-help">Golf sends the tool the {what}’s title, description, its 20 most recent comments and these instructions. With a shared host the task runs under its owner’s signed-in subscription.</p>
        {error ? <p className="error" role="alert">{message(error)}</p> : null}
        <form.Subscribe selector={state => [state.isSubmitting, state.values.choice] as const}>{([submitting, choice]) => <div className="credential-actions">
          <button className="button primary" disabled={submitting || !choice}><Bot size={15} aria-hidden="true" />{submitting ? 'Assigning…' : 'Assign'}</button><button type="button" className="button secondary" onClick={close}>Cancel</button></div>}</form.Subscribe>
        {!usable.length ? <p className="field-help" role="status">No tool can take this task right now; each one says why.</p> : null}
      </form>}
  </DetailsDialog>;
}

function AgentTaskDetail({ context, userId, initial, writer, admin, close, listKey, targetTitle }: { context: Context; userId: string; initial: AgentTask; writer: boolean; admin: boolean; close: () => void; listKey: unknown[]; targetTitle?: string }) {
  const visible = usePageVisible(), client = useQueryClient();
  const detail = useQuery({ ...privateQuery, queryKey: ['native-agent-tasks', userId, context.repositoryId, 'task', initial.id], placeholderData: { task: initial },
    queryFn: ({ signal }) => api<{ task: AgentTask }>(tasksPath, { ...context, action: 'get', id: initial.id }, signal), refetchInterval: query => visible && activeTask(query.state.data?.task.state ?? initial.state) ? 2000 : false });
  const task = detail.data?.task || initial, active = activeTask(task.state);
  const [cancelling, setCancelling] = useState(false), [error, setError] = useState<unknown>(), [requested, setRequested] = useState(false);
  // A finished task updates the list row as well.
  useEffect(() => { if (!active) void client.invalidateQueries({ queryKey: listKey }); }, [active]); // eslint-disable-line react-hooks/exhaustive-deps
  async function cancel() {
    setCancelling(true); setError(undefined);
    try { const result = await api<{ task?: AgentTask }>(tasksPath, { ...context, action: 'cancel', id: task.id }); setRequested(true); if (result.task) client.setQueryData(['native-agent-tasks', userId, context.repositoryId, 'task', task.id], { task: result.task }); else await detail.refetch(); } catch (e) { setError(e); } finally { setCancelling(false); }
  }
  // The requester and repository administrators may cancel (host managers too, but the page cannot tell); the server refuses anyone else with a reason shown here.
  const canCancel = admin || typeof task.requestedBy === 'object' && task.requestedBy?.id === userId;
  const failure = ['FAILED', 'TIMED_OUT', 'LOST'].includes(task.state) ? failureText(task) : '';
  const usage = task.usage && (task.usage.inputTokens || task.usage.outputTokens || task.usage.costUsd) ? task.usage : null;
  return <section className="agent-task" aria-label={`Agent task ${task.id}`}>
    <div className="agent-task-heading"><h4><StateIcon state={pipelineState(task.state)} label={taskStateLabels[task.state]} size={18} /> {toolLabel(task.tool)} on {task.host.name} <span className="muted">{taskStateLabels[task.state] || task.state}</span></h4>
      <div className="row-actions">{active && canCancel && !task.cancelRequested && !requested ? <button className="button secondary" disabled={cancelling} onClick={() => void cancel()}><Ban size={15} aria-hidden="true" />{cancelling ? 'Cancelling…' : 'Cancel task'}</button> : null}
        {active ? <span className="live-status live-status-live" role="status">Live</span> : null}
        <button className="icon-button" aria-label="Close task" title="Close task" onClick={close}><X size={16} /></button></div></div>
    <dl className="detail-grid agent-task-facts">
      <div><dt>Requested by</dt><dd>{requesterLogin(task)} · <DateLabel value={task.createdAt} relative /></dd></div>
      <div><dt>Ran</dt><dd>{task.startedAt ? `${duration(task.startedAt, task.finishedAt)}${task.finishedAt ? '' : ' so far'}` : active ? 'Not started' : '—'}</dd></div>
      <div><dt>Branch</dt><dd><span className="pipeline-ref"><GitBranch size={13} aria-hidden="true" />{task.branch}</span> from <code>{branchName(task.baseRef)}</code> at <code>{task.baseCommit.slice(0, 7)}</code></dd></div>
      <div><dt>Model</dt><dd>{task.model || 'The tool’s default'}</dd></div>
    </dl>
    {error ? <p className="error" role="alert">{message(error)}</p> : null}
    {active && (task.cancelRequested || requested) ? <p className="field-help" role="status">Cancellation requested. The host stops the tool at its next call to Golf.</p> : null}
    {task.state === 'QUEUED' ? <p className="field-help" role="status">Waiting for {task.host.name} to pick the task up.</p> : null}
    {failure ? <p className="error" role="alert">{failure}</p> : null}
    {task.state === 'CANCELLED' ? <p className="field-help" role="status">The task was cancelled. {task.failureReason ? `${failureText(task)} ` : ''}Nothing was proposed.</p> : null}
    {task.state === 'NO_CHANGES' ? <p className="field-help" role="status">The tool finished without changing any file, so there is nothing to propose.</p> : null}
    {task.state === 'SUCCEEDED' ? <div className="agent-task-result">
      <p className="agent-task-commit"><GitCommitHorizontal size={15} aria-hidden="true" />Commit <code>{task.commitId.slice(0, 12)}</code> on <code>{task.branch}</code><CopyButton text={task.branch} label="Copy branch name" /></p>
      {task.changedFiles.length ? <details className="metadata-details" open={task.changedFiles.length <= 8}><summary>{task.changedFiles.length} changed {task.changedFiles.length === 1 ? 'file' : 'files'}</summary><ul className="agent-task-files">{task.changedFiles.map(file => <li key={file}><code>{file}</code></li>)}</ul></details> : null}
      {task.summary ? <div className="agent-task-summary"><h5>What {toolLabel(task.tool)} reported</h5><MarkdownBody text={task.summary} label="Reported summary, rendered Markdown" /></div> : null}
      {usage ? <p className="field-help">Usage as reported by {toolLabel(task.tool)}: {[usage.inputTokens ? `${usage.inputTokens.toLocaleString()} input tokens` : '', usage.outputTokens ? `${usage.outputTokens.toLocaleString()} output tokens` : '', usage.costUsd ? `$${usage.costUsd.toFixed(2)}` : ''].filter(Boolean).join(' · ')}. Golf does not measure it; the provider’s billing is authoritative.</p> : null}
      {writer ? <OpenPullRequest key={task.id} context={context} task={task} targetTitle={task.target.title || targetTitle} /> : null}
    </div> : null}
    <TaskLogView context={context} task={task} />
  </section>;
}

function TaskLogView({ context, task }: { context: Context; task: AgentTask }) {
  const visible = usePageVisible(), terminal = !activeTask(task.state);
  const [lines, setLines] = useState<string[]>([]), [offset, setOffset] = useState(0), [complete, setComplete] = useState(false), [truncated, setTruncated] = useState(false), [error, setError] = useState<unknown>();
  const [following, setFollowing] = useState(true);
  const box = useRef<HTMLDivElement>(null), fetching = useRef(false);
  useEffect(() => {
    let stopped = false, timer = 0;
    const load = async () => {
      if (fetching.current || stopped) return;
      fetching.current = true;
      try {
        const value = await api<TaskLog>(tasksPath, { ...context, action: 'log', id: task.id, offset });
        if (stopped) return;
        if (value.lines.length) setLines(current => [...current, ...value.lines.map(line => line.replace(ansi, ''))]);
        setTruncated(value.truncated || Boolean(task.logTruncated));
        // Done once the server says so, or once a finished task has nothing more to send.
        const finished = terminal || Boolean(value.state && !activeTask(value.state));
        setComplete(value.complete || finished && !value.lines.length && value.nextOffset >= task.logLines);
        if (value.nextOffset > offset) setOffset(value.nextOffset);
        setError(undefined);
      } catch (e) {
        if (stopped) return;
        // An offset past what the Worker stored is answered with the offset to resync to.
        const resync = errorBody(e)?.nextOffset;
        if (typeof resync === 'number' && resync >= 0 && resync < offset) { setLines(current => current.slice(0, resync)); setOffset(resync); setError(undefined); } else setError(e);
      } finally { fetching.current = false; }
    };
    void load();
    if (!complete && visible) timer = window.setInterval(() => void load(), 1500);
    return () => { stopped = true; window.clearInterval(timer); };
  }, [task.id, offset, complete, visible, terminal]); // eslint-disable-line react-hooks/exhaustive-deps
  // Follow new lines unless the reader scrolled up.
  useLayoutEffect(() => { if (following && box.current) box.current.scrollTop = box.current.scrollHeight; }, [lines.length, following]);
  const onScroll = () => { const el = box.current; if (el) setFollowing(el.scrollHeight - el.scrollTop - el.clientHeight < 24); };
  return <div className="agent-task-log-panel">
    <div className="agent-task-log-heading"><h5>Log</h5>{!following ? <button type="button" className="text-button" onClick={() => setFollowing(true)}><ArrowDown size={14} aria-hidden="true" />Follow latest</button> : null}</div>
    {error ? <p className="error" role="alert">{message(error)}</p> : null}
    <div ref={box} className="pipeline-log agent-task-log" role="log" aria-live="polite" aria-label="Agent task log" tabIndex={0} onScroll={onScroll}>
      {lines.length ? <ol className="pipeline-log-lines">{lines.map((line, index) => <li key={index}><span className="pipeline-log-number" aria-hidden="true">{index + 1}</span><code>{line}</code></li>)}</ol>
        : <p className="pipeline-log-empty">{terminal ? complete ? 'This task produced no log.' : 'Reading the log…' : 'No output yet.'}</p>}
      {truncated ? <p className="pipeline-log-empty agent-task-log-truncated" role="status">Log truncated: Golf keeps the first 10,000 lines or 512 KiB of a task’s log; later lines were not stored.</p> : null}
    </div>
    <p className="panel-footnote">Output from the tool on the host, streamed as it runs. Golf does not filter it; the tool never receives Golf credentials.</p>
  </div>;
}

function OpenPullRequest({ context, task, targetTitle }: { context: Context; task: AgentTask; targetTitle?: string }) {
  const [open, setOpen] = useState(false), [error, setError] = useState<unknown>(), [opened, setOpened] = useState<number>();
  const idempotencyKey = useRef(crypto.randomUUID());
  const what = task.target.kind === 'pull_request' ? 'pull request' : 'issue', base = branchName(task.baseRef);
  const form = useForm({ defaultValues: { title: targetTitle || `${toolLabel(task.tool)} proposal for ${what} #${task.target.number}`,
    body: `${task.summary ? `${task.summary}\n\n` : ''}Proposed by a Golf agent task (${toolLabel(task.tool)} on ${task.host.name}) for ${what} #${task.target.number}.` },
  onSubmit: async ({ value }) => {
    setError(undefined);
    const resolve = async (name: string) => {
      const response = await repositoryClient.resolveRepositorySource({ repository: context.repository, repositoryId: context.repositoryId, selector: { kind: RepositorySourceRefKind.BRANCH, name }, path: '' }, { timeoutMs: 8000 });
      if (response.resolution !== RepositorySourceResolution.RESOLVED || response.selection?.name !== name || !response.selection.commitId) throw new Error(`The branch ${name} could not be read.`);
      return response.selection.commitId;
    };
    try {
      const [baseCommitId, headCommitId] = await Promise.all([resolve(base), resolve(task.branch)]);
      if (headCommitId !== task.commitId) throw new Error(`The branch ${task.branch} moved after the task finished; open the pull request from the compare page instead.`);
      const response = await repositoryClient.createPullRequest({ repository: context.repository, repositoryId: context.repositoryId, sourceRepository: context.repository, sourceRepositoryId: context.repositoryId,
        baseBranch: base, headBranch: task.branch, baseCommitId, headCommitId, title: value.title.trim(), body: value.body, draft: false, idempotencyKey: idempotencyKey.current }, { timeoutMs: 15000 });
      if (!response.pullRequest) throw new Error('Golf recorded the request but returned no pull request. Check the pull requests list before trying again.');
      setOpened(response.pullRequest.number); setOpen(false);
    } catch (e) { if (e instanceof ConnectError) idempotencyKey.current = crypto.randomUUID(); setError(e); }
  } });
  const location = { owner: context.repository.owner, name: context.repository.name };
  if (opened) return <p className="agent-task-opened" role="status"><GitPullRequest size={15} aria-hidden="true" />Pull request <Link {...repositoryOptions(location, { view: 'pulls', pull: opened })}>#{opened}</Link> opened from <code>{task.branch}</code> into <code>{base}</code>.</p>;
  if (!open) return <div className="credential-actions"><button className="button primary" onClick={() => setOpen(true)}><GitPullRequest size={15} aria-hidden="true" />Open pull request</button>
    <span className="field-help">From <code>{task.branch}</code> into <code>{base}</code>{task.target.kind === 'pull_request' ? `, the head branch of pull request #${task.target.number}` : ''}.</span></div>;
  return <form className="credential-form-content agent-open-pull" aria-label="Open pull request" onSubmit={event => { event.preventDefault(); void form.handleSubmit(); }}>
    <form.Field name="title">{field => <label>Pull request title<input required maxLength={200} value={field.state.value} onChange={e => field.handleChange(e.target.value)} /></label>}</form.Field>
    <form.Field name="body">{field => <label>Description, Markdown<textarea rows={5} maxLength={12000} value={field.state.value} onChange={e => field.handleChange(e.target.value)} /></label>}</form.Field>
    <p className="field-help">From <code>{task.branch}</code> into <code>{base}</code>. Both branches are checked again when the pull request is created.</p>
    {error ? <p className="error" role="alert">{message(error)}</p> : null}
    <form.Subscribe selector={state => state.isSubmitting}>{submitting => <div className="credential-actions"><button className="button primary" disabled={submitting}><GitPullRequest size={15} aria-hidden="true" />{submitting ? 'Creating…' : 'Create pull request'}</button><button type="button" className="button secondary" onClick={() => setOpen(false)}>Cancel</button></div>}</form.Subscribe>
  </form>;
}
