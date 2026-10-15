import { useState } from 'react';
import { useForm } from '@tanstack/react-form';
import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { Plus, RefreshCw } from 'lucide-react';
import { repositoryClient } from './api';
import { DataTable, type DataTableColumn } from './DataTable';
import { DateLabel, Loading, PanelError, privateQuery } from './RepositoryUI';
import { repositoryOptions } from './navigation';
import { allowedOutputs, automationsKey, createAutomation, deleteAutomation, enginesFor, eventLabels, getAutomation, instructionsLimit, limitBounds, listAutomations, listRuns, outputLabels,
  placeLabels, readInstructions, runAutomation, runKinds, runStateClass, runStateLabels, scheduleBounds, setAutomationEnabled, setKillSwitch, targetKindLabels, triggerLabels, triggerText,
  updateAutomation, type Automation, type AutomationTarget, type Definition, type Inventory, type Place, type Run, type RunTarget, type Tool } from './automations';

// Automations (docs/AUTOMATIONS.md): one inventory for repository, organization and installation scope. The inventory leads; New, Edit and
// Run now open their forms on request. Run output is written by a model or a coding CLI: it is shown as plain text only, never as Markdown or HTML.
const message = (error: unknown) => error instanceof Error ? error.message : 'The automation change could not be confirmed.';
const lines = (text: string) => text.split('\n').map(line => line.trim()).filter(Boolean);
const bytes = (value: string) => new TextEncoder().encode(value).byteLength;
const repositoryKey = (full: string) => { const [owner, name, ...rest] = full.split('/'); return owner && name && !rest.length ? { owner, name } : undefined; };
const number = (value: number) => value.toLocaleString();
const scopeReach: Record<AutomationTarget['scope'], string> = {
  repository: 'Automations of this repository run on its events, on a schedule or when you choose Run now. Repository administrators manage them; writers can read them and their runs.',
  organization: 'Organization automations reach every repository of this organization, or the ones you list. Organization owners manage them; members can read them.',
  installation: 'Installation automations reach every repository on this installation, or the ones you list. Operations administrators manage them.',
};
const managers: Record<AutomationTarget['scope'], string> = { repository: 'Repository administrators manage these automations.', organization: 'Organization owners manage these automations.', installation: 'Operations administrators manage these automations.' };

// Repository Settings → Automations: the repository id the native API needs, then the shared inventory.
export function RepositoryAutomations({ userId, owner, name }: { userId: string; owner: string; name: string }) {
  const repository = useQuery({ ...privateQuery, queryKey: ['native-automations', userId, owner, name, 'repository'], queryFn: async ({ signal }) => {
    const response = await repositoryClient.getRepository({ repository: { owner, name } }, { signal, timeoutMs: 8000 });
    if (!response.repository?.id) throw new Error('The repository could not be read.');
    return response.repository.id;
  } });
  return <section className="page-stack" aria-labelledby="automations-title">
    <header className="repository-intro"><div><h1 id="automations-title">Automations</h1><p>Built-in tools and your own instructions that review pull requests, triage issues, propose fixes and write reports when something happens here. They act as a person, open drafts a person publishes, and never merge.</p></div></header>
    {repository.error ? <PanelError error={repository.error} retry={() => void repository.refetch()} /> : !repository.data ? <Loading label="Reading automations…" /> :
      <AutomationSettings target={{ scope: 'repository', repository: { owner, name }, repositoryId: repository.data }} userId={userId} />}
  </section>;
}

type Panel = { kind: 'new' } | { kind: 'edit'; automation: Automation } | { kind: 'run'; automation: Automation };

export function AutomationSettings({ target, userId }: { target: AutomationTarget; userId: string }) {
  const key = automationsKey(userId, target);
  const inventory = useQuery({ ...privateQuery, queryKey: key, queryFn: ({ signal }) => listAutomations(target, signal) });
  const runs = useQuery({ ...privateQuery, queryKey: [...key, 'runs'], queryFn: ({ signal }) => listRuns(target, signal),
    refetchInterval: query => query.state.data?.runs.some(run => run.state === 'QUEUED' || run.state === 'RUNNING') ? 10000 : false });
  const [panel, setPanel] = useState<Panel>(), [error, setError] = useState<unknown>(), [busy, setBusy] = useState(false), [notice, setNotice] = useState('');
  const refresh = () => Promise.all([inventory.refetch(), runs.refetch()]);
  const open = (next?: Panel) => { setNotice(''); setError(undefined); setPanel(next); };
  const act = async (change: () => Promise<unknown>, done: string) => {
    setBusy(true); setError(undefined); setNotice('');
    try { await change(); setNotice(done); return true; } catch (e) { setError(e); return false; } finally { setBusy(false); void refresh(); }
  };
  const data = inventory.data, manage = Boolean(data?.canManage), featureOn = data?.featureOn !== false;
  const engineLabel = (id: string) => data?.engines.find(engine => engine.id === id)?.label || id;
  const columns: DataTableColumn<Automation>[] = [
    { accessorKey: 'name', header: 'Automation', cell: ({ row: { original: a } }) => <div className="automation-name"><strong>{a.name}</strong><small>{a.toolLabel}</small></div> },
    { id: 'runsOn', header: 'Runs on', enableSorting: false, accessorFn: a => triggerText(a.trigger), cell: ({ row: { original: a } }) => <div className="automation-cell"><span>{triggerText(a.trigger)}</span><TargetFilters automation={a} /></div> },
    { id: 'engine', header: 'Engine', accessorFn: a => `${engineLabel(a.engine)} ${placeLabels[a.place] || a.place} ${a.hostName}`,
      cell: ({ row: { original: a } }) => <div className="automation-cell"><span>{engineLabel(a.engine)}</span><small>{a.place === 'agent-host' ? `Agent host ${a.hostName || a.hostId || 'not set'}` : placeLabels[a.place] || a.place}</small></div> },
    { id: 'output', header: 'Output', enableSorting: false, accessorFn: a => a.output.map(o => outputLabels[o]?.[0] || o).join(', '),
      cell: ({ row: { original: a } }) => <div className="automation-cell"><span>{a.output.map(o => outputLabels[o]?.[0] || o).join(', ')}</span>{a.approvals.allowLanding ? <small>Agentic mode may land its drafts</small> : null}</div> },
    { id: 'owner', header: 'Acts as', accessorFn: a => a.owner.login || 'Unknown account' },
    { id: 'today', header: 'Runs today', accessorFn: a => a.stats.today, sortFn: 'basic', enableGlobalFilter: false,
      cell: ({ row: { original: a } }) => <div className="automation-cell"><span>{number(a.stats.today)} of {number(a.limits.perDay)}</span>{a.stats.running || a.stats.queued ? <small>{a.stats.running} running · {a.stats.queued} queued</small> : null}</div> },
    { id: 'last', header: 'Last run', accessorFn: a => a.stats.last ? runStateLabels[a.stats.last.state] || a.stats.last.state : 'Never',
      cell: ({ row: { original: a } }) => a.stats.last ? <div className="automation-cell"><span className={runStateClass(a.stats.last.state)}>{runStateLabels[a.stats.last.state] || a.stats.last.state}</span><small><DateLabel value={a.stats.last.at} relative /></small>{a.stats.last.reason ? <small>{a.stats.last.reason}</small> : null}</div> : <span className="muted">Never</span> },
    { id: 'state', header: 'State', accessorFn: stateText, cell: ({ row: { original: a } }) => <span className={`visibility${a.killSwitch ? ' refused' : a.enabled ? ' available' : ''}`}>{stateText(a)}</span> },
    ...(manage ? [{ id: 'actions', header: 'Actions', enableSorting: false, enableGlobalFilter: false, cell: ({ row: { original: a } }) => <div className="row-actions automation-row-actions">
      <label className="checkbox-field"><input type="checkbox" role="switch" aria-label={`Automatic runs for ${a.name}`} checked={a.enabled} disabled={busy || !a.enabled && !featureOn}
        onChange={event => { const on = event.target.checked; void act(() => setAutomationEnabled(target, a, on), on ? `${a.name} is on. It now acts as you.` : `${a.name} is off; its queued event runs were skipped.`); }} />On</label>
      {a.killSwitch
        ? <button className="button secondary" disabled={busy} aria-label={`Release the kill switch of ${a.name}`} onClick={() => void act(() => setKillSwitch(target, a.id, false), `The kill switch of ${a.name} was released.`)}>Release kill switch</button>
        : <button className="button secondary danger-action" disabled={busy} aria-label={`Engage the kill switch of ${a.name}`} onClick={() => { if (window.confirm(`Engage the kill switch of ${a.name}? This is an emergency stop: queued runs are skipped, work in flight is cancelled, and nothing runs, not even Run now, until you release it.`)) void act(() => setKillSwitch(target, a.id, true), `The kill switch of ${a.name} is engaged; its queued and running work was stopped.`); }}>Emergency stop</button>}
      <button className="button secondary" disabled={busy} aria-label={`Edit ${a.name}`} onClick={() => open({ kind: 'edit', automation: a })}>Edit</button>
      <button className="button secondary" disabled={busy || a.killSwitch || !featureOn} aria-label={`Run ${a.name} now`} title={a.killSwitch ? 'Release the kill switch first.' : undefined} onClick={() => open({ kind: 'run', automation: a })}>Run now</button>
      <button className="button secondary danger-action" disabled={busy} aria-label={`Delete ${a.name}`} onClick={() => { if (window.confirm(`Delete automation ${a.name}? Its queued runs are skipped and work in flight is cancelled. Past runs stay listed.`)) { if (panel && 'automation' in panel && panel.automation.id === a.id) setPanel(undefined); void act(() => deleteAutomation(target, a.id), `${a.name} was deleted.`); } }}>Delete</button>
    </div> } as DataTableColumn<Automation>] : []),
  ];
  const editing = panel?.kind === 'edit' ? panel.automation : undefined, running = panel?.kind === 'run' ? panel.automation : undefined;
  return <div className="page-stack">
    <section className="browser-panel" aria-labelledby="automations-inventory-title"><div className="browser-panel-heading"><h2 id="automations-inventory-title">Automations</h2>
      <div className="row-actions"><button className="button secondary" aria-label="Refresh automations" disabled={inventory.isFetching} onClick={() => void refresh()}><RefreshCw size={15} className={inventory.isFetching ? 'spin' : ''} />Refresh</button>
        {manage ? <button className="button primary" disabled={!featureOn} onClick={() => open(panel?.kind === 'new' ? undefined : { kind: 'new' })} aria-expanded={panel?.kind === 'new'}><Plus size={15} />New automation</button> : null}</div></div>
      <p className="field-help">{scopeReach[target.scope]} Each automation acts as the person shown: turning it on or saving it makes that you.</p>
      {data && !data.featureOn ? <p className="field-help check-warning" role="note">{data.featureReason || 'Automations are turned off here by a feature policy.'} Saved automations are kept and do not run; you can still turn them off, edit or delete them.</p> : null}
      {notice ? <p className="session-notice" role="status">{notice}</p> : null}
      {error ? <p className="error" role="alert">{message(error)}</p> : null}
      {inventory.error ? <PanelError error={inventory.error} retry={() => void inventory.refetch()} /> : !data ? <Loading label="Reading automations…" /> : <>
        <DataTable data={data.automations} columns={columns} getRowId={a => a.id} label="automations" pagination={false}
          emptyMessage={manage ? 'No automations here yet. Choose New automation to start from a built-in tool.' : 'No automations here.'} />
        {manage ? null : <p className="panel-footnote">{managers[target.scope]}</p>}
      </>}
    </section>
    {data && manage && panel?.kind === 'new' ? <NewAutomation inventory={data} target={target} close={() => open()} done={name => { open(); setNotice(`${name} was created. It is off: use Run now to try it, then turn it on.`); void refresh(); }} /> : null}
    {data && manage && editing ? <EditAutomation key={`${editing.id}/${editing.version}`} automation={editing} inventory={data} target={target} userId={userId} close={() => open()}
      done={name => { open(); setNotice(`${name} was saved. It now acts as you.`); void refresh(); }} /> : null}
    {data && manage && running ? <RunNow key={running.id} automation={running} inventory={data} target={target} close={() => open()}
      done={text => { open(); setNotice(text); void refresh(); }} /> : null}
    {data?.inherited.length ? <section className="browser-panel" aria-labelledby="automations-inherited-title"><div className="browser-panel-heading"><h2 id="automations-inherited-title">From the organization and installation</h2></div>
      <p className="field-help">These automations are managed at a wider scope and also run on this repository. They are shown read-only.</p>
      <DataTable data={data.inherited} getRowId={a => a.id} label="inherited automations" pagination={false} columns={[
        { accessorKey: 'name', header: 'Automation', cell: ({ row: { original: a } }) => <div className="automation-name"><strong>{a.name}</strong><small>{a.toolLabel}</small></div> },
        { id: 'scope', header: 'Managed by', accessorFn: a => a.scope === 'organization' ? `Organization ${a.scopeName}` : 'Installation' },
        { id: 'runsOn', header: 'Runs on', enableSorting: false, accessorFn: a => triggerText(a.trigger) },
        { id: 'output', header: 'Output', enableSorting: false, accessorFn: a => a.output.map(o => outputLabels[o]?.[0] || o).join(', ') },
        { id: 'owner', header: 'Acts as', accessorFn: a => a.owner.login || 'Unknown account' },
        { id: 'state', header: 'State', accessorFn: stateText },
      ]} />
    </section> : null}
    <RunsPanel target={target} runs={runs} />
  </div>;
}

function stateText(a: Automation) { return a.killSwitch ? 'Kill switch engaged' : a.enabled ? 'On' : 'Off'; }

function TargetFilters({ automation: a }: { automation: Automation }) {
  const parts = [a.target.repositories.length ? `Repositories: ${a.target.repositories.join(', ')}` : '', a.target.branches.length ? `Branches: ${a.target.branches.join(', ')}` : '', a.target.paths.length ? `Paths: ${a.target.paths.join(', ')}` : ''].filter(Boolean);
  return parts.length ? <small>{parts.join(' · ')}</small> : null;
}

// ---------- create and edit ----------
type Values = { name: string; events: string[]; scheduled: boolean; everyMinutes: number; repositories: string; branches: string; paths: string; engine: string; place: Place; hostId: string;
  instructions: string; output: string[]; perDay: number; concurrency: number; maxOpenPRs: number; dedupeWindow: number; allowLanding: boolean };

function NewAutomation({ inventory, target, close, done }: { inventory: Inventory; target: AutomationTarget; close: () => void; done: (name: string) => void }) {
  const [tool, setTool] = useState<Tool>();
  const initial = (t: Tool): Values => {
    const engine = enginesFor(t, inventory.engines)[0], cli = engine?.kind === 'cli';
    return { name: t.defaults.name, events: [...t.defaults.events], scheduled: false, everyMinutes: 1440, repositories: '', branches: '', paths: '', engine: engine?.id || '', place: cli ? 'agent-host' : 'cloud',
      hostId: cli ? inventory.hosts[0]?.id || '' : '', instructions: t.defaults.instructions, output: [...t.defaults.output], ...t.defaults.limits, allowLanding: false };
  };
  return <section className="browser-panel" aria-labelledby="new-automation-title"><div className="browser-panel-heading"><h2 id="new-automation-title">New automation</h2></div>
    <div className="credential-form-content">
      <p className="field-help">Start from a built-in tool. Its defaults fill the form and you can change any of them. A new automation starts off: Run now works at once, and turning it on lets its events and schedule start runs.</p>
      <fieldset className="policy-choices automation-choices"><legend>Tool</legend>{inventory.tools.map(t => <label key={t.id} className="policy-choice">
        <input type="radio" name="automation-tool" checked={tool?.id === t.id} onChange={() => setTool(t)} />
        <span><strong>{t.label}</strong><small>{t.description}</small></span></label>)}</fieldset>
    </div>
    {tool ? <AutomationForm key={tool.id} label={`New ${tool.label} automation`} tool={tool} inventory={inventory} target={target} initial={initial(tool)} submitLabel="Create automation" close={close}
      save={async definition => { const created = await createAutomation(target, tool.id, definition); done(created.automation?.name || definition.name); }} />
      : <div className="credential-actions"><button type="button" className="button secondary" onClick={close}>Cancel</button></div>}
  </section>;
}

function EditAutomation({ automation, inventory, target, userId, close, done }: { automation: Automation; inventory: Inventory; target: AutomationTarget; userId: string; close: () => void; done: (name: string) => void }) {
  const detail = useQuery({ ...privateQuery, queryKey: [...automationsKey(userId, target), 'automation', automation.id, automation.version], queryFn: ({ signal }) => getAutomation(target, automation.id, signal) });
  const tool = inventory.tools.find(t => t.id === automation.tool);
  const a = detail.data?.automation;
  return <section className="browser-panel" aria-labelledby="edit-automation-title"><div className="browser-panel-heading"><h2 id="edit-automation-title">Edit {automation.name}</h2></div>
    {detail.error ? <PanelError error={detail.error} retry={() => void detail.refetch()} /> : !a || !detail.data ? <Loading label="Reading the automation…" /> : !tool ? <p className="error" role="alert">This installation no longer offers the tool {automation.toolLabel}; the automation cannot be edited here.</p> :
      <AutomationForm label={`Edit ${a.name}`} tool={tool} inventory={inventory} target={target} close={close} submitLabel="Save automation" versions={detail.data.instructionVersions} automationId={a.id}
        initial={{ name: a.name, events: [...a.trigger.events], scheduled: Boolean(a.trigger.schedule), everyMinutes: a.trigger.schedule?.everyMinutes || 1440, repositories: a.target.repositories.join('\n'),
          branches: a.target.branches.join('\n'), paths: a.target.paths.join('\n'), engine: a.engine, place: a.place, hostId: a.hostId, instructions: a.instructions, output: [...a.output], ...a.limits, allowLanding: a.approvals.allowLanding }}
        note={`Saving makes you the person this automation acts as${a.owner.login ? ` (now ${a.owner.login})` : ''}. Changed instructions are kept as a new version.`}
        save={async definition => { await updateAutomation(target, a.id, a.version, definition); done(definition.name); }} />}
  </section>;
}

function AutomationForm({ label, tool, inventory, target, initial, submitLabel, note, versions, automationId, close, save }: { label: string; tool: Tool; inventory: Inventory; target: AutomationTarget; initial: Values;
  submitLabel: string; note?: string; versions?: { version: number; createdBy: string; createdAt: string; current: boolean }[]; automationId?: string; close: () => void; save: (definition: Definition) => Promise<void> }) {
  const [error, setError] = useState<unknown>();
  const engines = enginesFor(tool, inventory.engines), kindOf = (id: string) => inventory.engines.find(engine => engine.id === id)?.kind;
  const form = useForm({ defaultValues: initial, onSubmit: async ({ value }) => {
    setError(undefined);
    const cli = kindOf(value.engine) === 'cli', allowed = allowedOutputs(tool, kindOf(value.engine)), output = value.output.filter(kind => allowed.includes(kind)), opens = output.includes('draft-pr');
    const problem = !value.name.trim() ? 'Name the automation.' : !value.engine ? 'Choose an engine.' : cli && value.place !== 'agent-host' ? inventory.places[value.place] || 'Choose an agent host.' : cli && !value.hostId ? 'Choose the agent host the coding CLI runs on.'
      : !output.length ? 'Choose at least one output.' : opens && value.maxOpenPRs < 1 ? 'Allow at least one open draft pull request.' : bytes(value.instructions) > instructionsLimit ? `Instructions are limited to ${instructionsLimit} bytes.` : '';
    if (problem) { setError(new Error(problem)); return; }
    const definition: Definition = { name: value.name.trim(),
      trigger: { events: tool.events.filter(event => value.events.includes(event)), ...(tool.schedule && value.scheduled ? { schedule: { everyMinutes: value.everyMinutes } } : {}) },
      target: { ...(target.scope === 'repository' ? {} : { repositories: lines(value.repositories) }), branches: lines(value.branches), paths: lines(value.paths) },
      engine: value.engine, place: cli ? value.place : 'cloud', hostId: cli ? value.hostId : '', instructions: value.instructions, output,
      limits: { perDay: value.perDay, concurrency: value.concurrency, maxOpenPRs: value.maxOpenPRs, dedupeWindow: value.dedupeWindow }, approvals: { allowLanding: opens && value.allowLanding } };
    try { await save(definition); } catch (e) { setError(e); }
  } });
  const bounded = (key: keyof typeof limitBounds) => ({ onChange: ({ value }: { value: number }) => !Number.isInteger(value) || value < limitBounds[key][0] || value > limitBounds[key][1] ? `Use a whole number from ${limitBounds[key][0]} to ${limitBounds[key][1]}.` : undefined });
  const errors = (list: unknown[]) => list.length ? <p className="error" role="alert">{list.join(' ')}</p> : null;
  return <form className="credential-form-content automation-form" aria-label={label} onSubmit={event => { event.preventDefault(); void form.handleSubmit(); }}>
    {note ? <p className="field-help" role="note">{note}</p> : null}
    <form.Field name="name">{field => <label>Name<input required maxLength={100} value={field.state.value} onChange={e => field.handleChange(e.target.value)} autoComplete="off" /></label>}</form.Field>

    <form.Field name="events">{field => <fieldset className="policy-choices"><legend>Runs on these events</legend>{tool.events.map(event => <label key={event} className="policy-choice">
      <input type="checkbox" checked={field.state.value.includes(event)} onChange={e => field.handleChange(e.target.checked ? [...field.state.value, event] : field.state.value.filter(value => value !== event))} />
      <span><strong>{eventLabels[event] || event}</strong><small><code>{event}</code></small></span></label>)}</fieldset>}</form.Field>
    {tool.schedule ? <form.Field name="scheduled">{field => <><label className="checkbox-field"><input type="checkbox" checked={field.state.value} onChange={e => field.handleChange(e.target.checked)} />Also run on a schedule</label>
      {field.state.value ? <form.Field name="everyMinutes" validators={{ onChange: ({ value }) => !Number.isInteger(value) || value < scheduleBounds[0] || value > scheduleBounds[1] ? `Schedule a run every ${scheduleBounds[0]} to ${scheduleBounds[1].toLocaleString()} minutes.` : undefined }}>
        {every => <><label>Every (minutes)<input type="number" min={scheduleBounds[0]} max={scheduleBounds[1]} required value={every.state.value} onChange={e => every.handleChange(Number(e.target.value))} /></label>
          <p className="field-help">A scheduled run looks at the open work of each repository in scope. 60 is hourly, 1440 daily.</p>{errors(every.state.meta.errors)}</>}</form.Field> : null}</>}</form.Field> : null}
    <form.Subscribe selector={state => state.values.events.length === 0 && !(tool.schedule && state.values.scheduled)}>{manualOnly => manualOnly ? <p className="field-help" role="note">With no event and no schedule it runs only when someone chooses Run now, and it cannot be turned on.</p> : null}</form.Subscribe>

    {target.scope === 'repository' ? null : <form.Field name="repositories">{field => <><label>Repositories<textarea rows={3} value={field.state.value} onChange={e => field.handleChange(e.target.value)} spellCheck={false} placeholder="owner/name" /></label>
      <p className="field-help">One <code>owner/name</code> per line{target.scope === 'organization' ? ', from this organization' : ''}. Empty means every repository in scope.</p></>}</form.Field>}
    <form.Field name="branches">{field => <><label>Branches<textarea rows={2} value={field.state.value} onChange={e => field.handleChange(e.target.value)} spellCheck={false} placeholder={'main\nrelease/*'} /></label>
      <p className="field-help">One pattern per line, up to 20. Empty means every branch.</p></>}</form.Field>
    <form.Field name="paths">{field => <><label>Paths<textarea rows={2} value={field.state.value} onChange={e => field.handleChange(e.target.value)} spellCheck={false} placeholder={'src/**\n**/*.go'} /></label>
      <p className="field-help">One pattern per line, up to 20: <code>*</code> stays within one folder, <code>**</code> spans folders. Empty means any change.</p></>}</form.Field>

    <form.Field name="engine">{field => { const selected = inventory.engines.find(engine => engine.id === field.state.value); return <><label>Engine<select value={field.state.value} onChange={e => {
        const next = e.target.value, kind = kindOf(next), allowed = allowedOutputs(tool, kind), kept = form.getFieldValue('output').filter(o => allowed.includes(o));
        field.handleChange(next);
        form.setFieldValue('place', kind === 'cli' ? 'agent-host' : 'cloud');
        if (kind === 'cli' && !form.getFieldValue('hostId')) form.setFieldValue('hostId', inventory.hosts[0]?.id || '');
        form.setFieldValue('output', kept.length ? kept : allowed.slice(0, 1));
      }}>{!field.state.value ? <option value="" disabled>Choose an engine</option> : null}
        {(['model', 'cli'] as const).map(kind => { const items = engines.filter(engine => engine.kind === kind); return items.length ? <optgroup key={kind} label={kind === 'model' ? 'Models' : 'Coding CLIs on an agent host'}>{items.map(engine => <option key={engine.id} value={engine.id}>{engine.label}</option>)}</optgroup> : null; })}
      </select></label>
      <p className="field-help">{selected?.detail || ''}{!inventory.enginesRegistered && tool.engines !== 'cli' ? ' Until the engines registry is part of this installation, the installation model selection is the only model engine.' : ''}</p></>; }}</form.Field>
    <form.Subscribe selector={state => kindOf(state.values.engine)}>{kind => kind === 'cli' ? <>
      <form.Field name="place">{field => <fieldset className="policy-choices automation-choices"><legend>Where it runs</legend>{(['agent-host', 'cloud', 'ssh-host'] as const).map(place => <label key={place} className="policy-choice">
        <input type="radio" name="automation-place" checked={field.state.value === place} disabled={place !== 'agent-host'} onChange={() => field.handleChange(place)} />
        <span><strong>{placeLabels[place]}</strong><small>{place === 'agent-host' ? 'A machine connected in Agent hosts, under the sign-ins already on it.' : `Unavailable: ${inventory.places[place] || 'not offered on this installation.'}`}</small></span></label>)}</fieldset>}</form.Field>
      <form.Field name="hostId">{field => inventory.hosts.length ? <label>Agent host<select value={field.state.value} onChange={e => field.handleChange(e.target.value)}>{!field.state.value ? <option value="" disabled>Choose an agent host</option> : null}
        {inventory.hosts.map(host => <option key={host.id} value={host.id}>{host.name} ({host.scope})</option>)}</select></label>
        : <p className="field-help check-warning" role="note">No active agent host you may use is registered. Connect one in Agent hosts settings first; a coding CLI cannot run without one.</p>}</form.Field>
    </> : kind === 'model' ? <p className="field-help">Model engines run in the cloud, through this installation’s AI runs.</p> : null}</form.Subscribe>

    <form.Field name="instructions" validators={{ onChange: ({ value }) => bytes(value) > instructionsLimit ? `Instructions are limited to ${instructionsLimit} bytes.` : undefined }}>{field => <>
      <label>Instructions<textarea rows={8} value={field.state.value} onChange={e => field.handleChange(e.target.value)} placeholder={tool.id === 'custom' ? 'What to look at and what to write.' : 'Leave empty to use the tool’s own instructions.'} /></label>
      <p className="field-help">{number(bytes(field.state.value))} of {number(instructionsLimit)} bytes. {tool.id === 'custom' ? 'Your instructions are the whole task.' : 'Added to the built-in tool’s own instructions.'}</p>
      {errors(field.state.meta.errors)}
      {versions?.length && automationId ? <InstructionHistory versions={versions} target={target} automationId={automationId} use={text => field.handleChange(text)} /> : null}</>}</form.Field>

    <form.Subscribe selector={state => allowedOutputs(tool, kindOf(state.values.engine))}>{allowed => <form.Field name="output">{field => <fieldset className="policy-choices"><legend>Output</legend>{allowed.map(kind => <label key={kind} className="policy-choice">
      <input type="checkbox" checked={field.state.value.includes(kind)} onChange={e => field.handleChange(e.target.checked ? [...field.state.value, kind] : field.state.value.filter(value => value !== kind))} />
      <span><strong>{outputLabels[kind]?.[0] || kind}</strong><small>{outputLabels[kind]?.[1] || ''}</small></span></label>)}</fieldset>}</form.Field>}</form.Subscribe>

    <fieldset className="policy-choices automation-limits"><legend>Limits</legend>
      <form.Field name="perDay" validators={bounded('perDay')}>{field => <label>Runs per day<input type="number" min={1} max={500} required value={field.state.value} onChange={e => field.handleChange(Number(e.target.value))} />{errors(field.state.meta.errors)}</label>}</form.Field>
      <form.Field name="concurrency" validators={bounded('concurrency')}>{field => <label>Runs at once<input type="number" min={1} max={10} required value={field.state.value} onChange={e => field.handleChange(Number(e.target.value))} />{errors(field.state.meta.errors)}</label>}</form.Field>
      <form.Field name="dedupeWindow" validators={bounded('dedupeWindow')}>{field => <label>Skip repeats within (minutes)<input type="number" min={0} max={10080} required value={field.state.value} onChange={e => field.handleChange(Number(e.target.value))} />{errors(field.state.meta.errors)}</label>}</form.Field>
      <form.Subscribe selector={state => state.values.output.includes('draft-pr')}>{opens => opens ? <form.Field name="maxOpenPRs" validators={bounded('maxOpenPRs')}>{field => <label>Open draft pull requests at most<input type="number" min={1} max={50} required value={field.state.value} onChange={e => field.handleChange(Number(e.target.value))} />{errors(field.state.meta.errors)}</label>}</form.Field> : null}</form.Subscribe>
    </fieldset>
    <p className="field-help">The same target, such as one pull request head or one issue, runs once within the repeat window; 0 means once ever.</p>

    <form.Subscribe selector={state => state.values.output.includes('draft-pr')}>{opens => opens ? <form.Field name="allowLanding">{field => <><div className="policy-choices"><label className="policy-choice"><input type="checkbox" checked={field.state.value} onChange={e => field.handleChange(e.target.checked)} />
      <span><strong>Let agentic mode decide on its drafts</strong><small>Automations only open draft pull requests and never merge.</small></span></label></div>
      <p className="field-help">On: a draft from this automation is evaluated by this repository’s agentic mode policy like any other change, and lands only if that policy allows it. Off: its drafts always wait for a person.</p></>}</form.Field> : null}</form.Subscribe>

    {error ? <p className="error" role="alert">{message(error)}</p> : null}
    <form.Subscribe selector={state => [state.isSubmitting, state.canSubmit] as const}>{([submitting, canSubmit]) => <div className="credential-actions">
      <button className="button primary" disabled={submitting || !canSubmit}>{submitting ? 'Saving…' : submitLabel}</button><button type="button" className="button secondary" disabled={submitting} onClick={close}>Cancel</button></div>}</form.Subscribe>
  </form>;
}

// Earlier instructions, newest first; one opens on request, and "Use this version" copies its text into the form.
function InstructionHistory({ versions, target, automationId, use }: { versions: { version: number; createdBy: string; createdAt: string; current: boolean }[]; target: AutomationTarget; automationId: string; use: (text: string) => void }) {
  const [viewing, setViewing] = useState<number>();
  const text = useQuery({ ...privateQuery, queryKey: ['native-automation-instructions', JSON.stringify(target), automationId, viewing], enabled: viewing !== undefined,
    queryFn: ({ signal }) => readInstructions(target, automationId, viewing!, signal) });
  return <details className="metadata-details automation-history"><summary>Instruction history ({versions.length} {versions.length === 1 ? 'version' : 'versions'})</summary>
    <DataTable data={versions} getRowId={v => String(v.version)} label="instruction versions" pagination={false} columns={[
      { id: 'version', header: 'Version', accessorFn: v => v.version, sortFn: 'basic', cell: ({ row: { original: v } }) => <>{`Version ${v.version}`}{v.current ? <small> · current</small> : null}</> },
      { accessorKey: 'createdBy', header: 'Saved by' },
      { accessorKey: 'createdAt', header: 'Saved', enableGlobalFilter: false, cell: ({ row: { original: v } }) => <DateLabel value={v.createdAt} relative /> },
      { id: 'view', header: 'Text', enableSorting: false, enableGlobalFilter: false, cell: ({ row: { original: v } }) => <button type="button" className="button secondary" aria-pressed={viewing === v.version} aria-label={`View version ${v.version}`} onClick={() => setViewing(viewing === v.version ? undefined : v.version)}>{viewing === v.version ? 'Hide' : 'View'}</button> },
    ]} />
    {viewing === undefined ? null : text.error ? <p className="error" role="alert">{message(text.error)}</p> : !text.data ? <Loading label="Reading the instructions…" /> :
      <div className="automation-history-version" aria-label={`Instructions version ${text.data.version}`} role="group">
        <pre className="automation-output-text">{text.data.text || '(empty: the tool’s own instructions only)'}</pre>
        <div className="credential-actions"><button type="button" className="button secondary" onClick={() => use(text.data.text)}>Use this version</button>
          <span className="field-help">Copies the text into the form; saving creates a new version.</span></div>
      </div>}
  </details>;
}

// ---------- run now ----------
function RunNow({ automation, inventory, target, close, done }: { automation: Automation; inventory: Inventory; target: AutomationTarget; close: () => void; done: (notice: string) => void }) {
  const [error, setError] = useState<unknown>();
  const tool = inventory.tools.find(t => t.id === automation.tool), kinds = runKinds(tool, automation.tool), wide = target.scope !== 'repository';
  const form = useForm({ defaultValues: { repository: automation.target.repositories.length === 1 ? automation.target.repositories[0]! : '', kind: kinds[0]!, number: 1, runId: '' }, onSubmit: async ({ value }) => {
    setError(undefined);
    const repository = wide ? repositoryKey(value.repository.trim()) : undefined;
    if (wide && !repository) { setError(new Error('Name the repository as owner/name.')); return; }
    if (value.kind === 'pipeline_run' && !/^[1-9][0-9]{0,15}$/.test(value.runId.trim())) { setError(new Error('Enter the Actions run id.')); return; }
    const runTarget: RunTarget = { ...(repository ? { repository } : {}), kind: value.kind,
      ...(value.kind === 'issue' || value.kind === 'pull_request' ? { number: value.number } : value.kind === 'pipeline_run' ? { runId: value.runId.trim() } : {}) };
    try { const result = await runAutomation(target, automation.id, runTarget); done(`${automation.name} was queued${result.run?.repository ? ` on ${result.run.repository}` : ''}. It runs as you; its result appears under Runs.`); } catch (e) { setError(e); }
  } });
  return <form className="browser-panel credential-form-content" aria-label={`Run ${automation.name} now`} onSubmit={event => { event.preventDefault(); void form.handleSubmit(); }}>
    <h3>Run {automation.name} now</h3>
    <p className="field-help">Runs once, as you, whether the automation is on or off. Its limits still apply.</p>
    {wide ? <form.Field name="repository">{field => <label>Repository<input required value={field.state.value} onChange={e => field.handleChange(e.target.value)} placeholder="owner/name" autoComplete="off" /></label>}</form.Field> : null}
    <form.Field name="kind">{field => <label>Run on<select value={field.state.value} onChange={e => field.handleChange(e.target.value as RunTarget['kind'])}>{kinds.map(kind => <option key={kind} value={kind}>{targetKindLabels[kind]}</option>)}</select></label>}</form.Field>
    <form.Subscribe selector={state => state.values.kind}>{kind => kind === 'issue' || kind === 'pull_request'
      ? <form.Field name="number" validators={{ onChange: ({ value }) => !Number.isSafeInteger(value) || value < 1 ? 'Enter a number from 1.' : undefined }}>{field => <><label>{kind === 'issue' ? 'Issue number' : 'Pull request number'}<input type="number" min={1} required value={field.state.value} onChange={e => field.handleChange(Number(e.target.value))} /></label>
        {field.state.meta.errors.length ? <p className="error" role="alert">{field.state.meta.errors.join(' ')}</p> : null}</>}</form.Field>
      : kind === 'pipeline_run' ? <form.Field name="runId">{field => <><label>Actions run id<input required inputMode="numeric" value={field.state.value} onChange={e => field.handleChange(e.target.value)} autoComplete="off" /></label>
        <p className="field-help">The number of the failed run, shown on its Actions page.</p></>}</form.Field>
      : <p className="field-help">Looks at the repository’s open issues and pull requests.</p>}</form.Subscribe>
    {error ? <p className="error" role="alert">{message(error)}</p> : null}
    <form.Subscribe selector={state => [state.isSubmitting, state.canSubmit] as const}>{([submitting, canSubmit]) => <div className="credential-actions">
      <button className="button primary" disabled={submitting || !canSubmit}>{submitting ? 'Queueing…' : 'Run now'}</button><button type="button" className="button secondary" disabled={submitting} onClick={close}>Cancel</button></div>}</form.Subscribe>
  </form>;
}

// ---------- runs ----------
function RunsPanel({ target, runs }: { target: AutomationTarget; runs: UseQueryResult<{ runs: Run[]; truncated: boolean }> }) {
  const columns: DataTableColumn<Run>[] = [
    { accessorKey: 'createdAt', header: 'Started', enableGlobalFilter: false, cell: ({ row: { original: r } }) => <DateLabel value={r.startedAt || r.createdAt} relative /> },
    { accessorKey: 'automationName', header: 'Automation' },
    ...(target.scope === 'repository' ? [] : [{ accessorKey: 'repository', header: 'Repository' } as DataTableColumn<Run>]),
    { id: 'trigger', header: 'Trigger', accessorFn: r => `${triggerLabels[r.trigger] || r.trigger}${r.requestedBy ? ` ${r.requestedBy}` : ''}`,
      cell: ({ row: { original: r } }) => <div className="automation-cell"><span>{triggerLabels[r.trigger] || r.trigger}</span>{r.requestedBy ? <small>by {r.requestedBy}</small> : null}</div> },
    { id: 'target', header: 'Target', accessorFn: r => `${r.target.kind} ${r.target.number ?? ''}`, cell: ({ row: { original: r } }) => <RunTargetLink run={r} /> },
    { id: 'state', header: 'State', accessorFn: r => runStateLabels[r.state] || r.state, cell: ({ row: { original: r } }) => <span className={runStateClass(r.state)}>{runStateLabels[r.state] || r.state}</span> },
    { accessorKey: 'reason', header: 'Reason', enableSorting: false, cell: ({ row: { original: r } }) => r.reason ? <span className="automation-reason">{r.reason}</span> : <span className="muted">—</span> },
    { id: 'engine', header: 'Engine', accessorFn: r => `${r.engine} ${placeLabels[r.place] || r.place}`, cell: ({ row: { original: r } }) => <div className="automation-cell"><span>{r.engine}</span><small>{placeLabels[r.place] || r.place}{r.instructionsVersion ? ` · instructions v${r.instructionsVersion}` : ''}</small></div> },
    { id: 'usage', header: 'Usage', enableSorting: false, enableGlobalFilter: false, accessorFn: usageText },
    { id: 'outputs', header: 'Output', enableSorting: false, accessorFn: r => outputSearchText(r), cell: ({ row: { original: r } }) => <RunOutputs run={r} /> },
  ];
  return <section className="browser-panel" aria-labelledby="automation-runs-title"><div className="browser-panel-heading"><h2 id="automation-runs-title">Runs</h2>
    <button className="button secondary" aria-label="Refresh runs" disabled={runs.isFetching} onClick={() => void runs.refetch()}><RefreshCw size={15} className={runs.isFetching ? 'spin' : ''} />Refresh</button></div>
    {runs.error ? <PanelError error={runs.error} retry={() => void runs.refetch()} /> : !runs.data ? <Loading label="Reading runs…" /> : <>
      <p className="field-help">The 50 most recent runs{target.scope === 'repository' ? ' on this repository' : ''} are loaded{runs.data.truncated ? '; older runs are not shown' : ''}. Search and sorting cover only those. Output is written by a model or a coding CLI: it is automated and unverified, and is shown as plain text.</p>
      <DataTable data={runs.data.runs} columns={columns} getRowId={r => r.id} label="automation runs" emptyMessage="No automation has run here yet." />
    </>}
  </section>;
}

function usageText(r: Run) {
  const u = r.usage;
  if (!u || u.reported === false || u.inputTokens === undefined && u.outputTokens === undefined && u.costUsd === undefined) return 'Not reported';
  return [u.inputTokens !== undefined ? `${number(u.inputTokens)} in` : '', u.outputTokens !== undefined ? `${number(u.outputTokens)} out` : '', u.costUsd !== undefined ? `$${u.costUsd.toFixed(2)}` : ''].filter(Boolean).join(' · ');
}

function RunTargetLink({ run: r }: { run: Run }) {
  const repository = repositoryKey(r.repository), n = r.target.number;
  if (r.target.kind === 'issue' && n) return repository ? <Link {...repositoryOptions(repository, { view: 'issues', issue: n })}>Issue #{n}</Link> : <span>Issue #{n}</span>;
  if (r.target.kind === 'pull_request' && n) return repository ? <Link {...repositoryOptions(repository, { view: 'pulls', pull: n })}>Pull request #{n}</Link> : <span>Pull request #{n}</span>;
  if (r.target.kind === 'pipeline_run') return <div className="automation-cell">{repository ? <Link {...repositoryOptions(repository, { view: 'actions' })}>Actions run {n ?? ''}</Link> : <span>Actions run {n ?? ''}</span>}{r.target.commit ? <small><code>{r.target.commit.slice(0, 12)}</code></small> : null}</div>;
  return <span>{r.target.kind === 'repository' ? 'Open work' : r.target.kind || '—'}</span>;
}

function outputSearchText(r: Run) {
  const o = r.outputs;
  return [o.pullNumber ? `#${o.pullNumber}` : '', o.issueNumber ? `#${o.issueNumber}` : '', ...(o.labels || []), ...(o.suggestions || []).map(s => s.name), o.review?.summary || '', o.report || ''].join(' ');
}

// Everything here came from a model or a coding CLI. It is rendered as text nodes only: no Markdown, no HTML, no links taken from the text.
function RunOutputs({ run: r }: { run: Run }) {
  const o = r.outputs, repository = repositoryKey(r.repository);
  const refs = [
    o.pullNumber ? <span key="pull">Draft pull request {repository ? <Link {...repositoryOptions(repository, { view: 'pulls', pull: o.pullNumber })}>#{o.pullNumber}</Link> : `#${o.pullNumber}`}</span> : null,
    o.issueNumber ? <span key="issue">Issue {repository ? <Link {...repositoryOptions(repository, { view: 'issues', issue: o.issueNumber })}>#{o.issueNumber}</Link> : `#${o.issueNumber}`}</span> : null,
    o.commentId ? <span key="comment">Commented on the target</span> : null,
    o.labels?.length ? <span key="labels">Labels: {o.labels.join(', ')}</span> : null,
    o.agentTaskId ? <span key="task">Agent task <code>{o.agentTaskId.slice(0, 8)}</code></span> : null,
  ].filter(Boolean);
  const detail = Boolean(o.review || o.report || o.suggestions?.length || o.duplicates?.length);
  if (!refs.length && !detail) return <span className="muted">None</span>;
  return <div className="automation-cell automation-run-refs">{refs}
    {detail ? <details className="metadata-details"><summary>Details <span className="automation-unverified">Automated, unverified</span></summary>
      <div className="automation-output" aria-label={`Output of ${r.automationName}`} role="group">
        {o.review ? <>{o.review.summary ? <p className="automation-output-text">{o.review.summary}</p> : null}
          {o.review.findings?.length ? <ul className="automation-findings">{o.review.findings.map((f, index) => <li key={index}>
            <strong>{f.severity ? `${f.severity}: ` : ''}{f.title}</strong>{f.path ? <small><code>{f.path}{f.line ? `:${f.line}` : ''}</code></small> : null}
            {f.evidence ? <p className="automation-output-text">{f.evidence}</p> : null}{f.suggestion ? <p className="automation-output-text">Suggestion: {f.suggestion}</p> : null}</li>)}</ul> : null}
          {o.review.markdown ? <details className="metadata-details"><summary>Review text (shown as plain text)</summary><pre className="automation-output-text">{o.review.markdown}</pre></details> : null}</> : null}
        {o.suggestions?.length ? <p className="automation-output-text">Suggested labels: {o.suggestions.map(s => `${s.name}${typeof s.probability === 'number' ? ` (${Math.round(s.probability * 100)}%)` : ''}`).join(', ')}</p> : null}
        {o.duplicates?.length ? <p className="automation-output-text">Possible duplicates: {o.duplicates.map(d => `#${d}`).join(', ')}</p> : null}
        {o.report ? <pre className="automation-output-text">{o.report}</pre> : null}
      </div></details> : null}
  </div>;
}
