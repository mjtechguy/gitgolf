import { useMemo, useState } from 'react';
import { useForm } from '@tanstack/react-form';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { nativeAPI } from './nativeAPI';
import { DataTable, type DataTableColumn } from './DataTable';
import { Loading, PanelError, holdErrorOnFocus, privateQuery } from './RepositoryUI';
import { SummaryBand } from './Layout';
import { repositoryOptions } from './navigation';

// Mirrors cloudflare/forge/src/contributions.mjs (docs/AGENTS_AND_AUTOMATIONS_PLAN.md, CG-1 and CG-2). Counts, not claims.
export type ContributionKind = 'commit' | 'pull_opened' | 'pull_merged' | 'review' | 'issue_opened' | 'issue_closed' | 'comment' | 'proposal_created' | 'proposal_accepted';
export type AiTier = 'agent' | 'token' | 'assisted' | 'declared' | 'none';
type Counts = Record<ContributionKind, number>;
type Tiers = Record<AiTier, number>;
type Day = { day: string; human: number; ai: number; kinds: Counts; agentKinds: Counts; tiers: Tiers; repositories: { fullName: string; human: number; ai: number }[]; private: number };
export type Range = { from: string; to: string; year: number | null };
type PersonView = { state: 'on'; person: { login: string; name: string }; range: Range; years: number[]; days: Day[];
  totals: { human: number; ai: number; kinds: Counts; agentKinds: Counts; tiers: Tiers; private: number }; streaks: { longest: number; current: number };
  repositories: { fullName: string; human: number; ai: number }[]; privateCounts: { included: boolean; human: number };
  settings: { showPrivate: boolean; canEdit: boolean; version?: number } } | { state: 'off' | 'unavailable'; reason: string };

export const kindLabels: Record<ContributionKind, [string, string]> = {
  commit: ['commit', 'commits'], pull_opened: ['pull request opened', 'pull requests opened'], pull_merged: ['pull request merged', 'pull requests merged'],
  review: ['review', 'reviews'], issue_opened: ['issue opened', 'issues opened'], issue_closed: ['issue closed', 'issues closed'], comment: ['comment', 'comments'],
  proposal_created: ['agent proposal', 'agent proposals'], proposal_accepted: ['agent proposal accepted', 'agent proposals accepted'],
};
export const tierLabels: Record<AiTier, [string, string]> = {
  none: ['Unlabelled', 'Everything else. Never asserted to be written by a person alone.'],
  token: ['API token (agent or automation)', 'Done through an API token, the way agents and automations outside Golf connect (for example a coding CLI over MCP). Golf reports the token; it cannot tell an agent from a script.'],
  declared: ['Declared AI co-author', 'The commit carries a Co-Authored-By trailer naming an AI tool. Declared by its author, not verified.'],
  assisted: ['AI-assisted', 'A person merged work a Golf agent or an API token produced. The person is the contributor; the AI assisted.'],
  agent: ['Golf agent', 'Golf itself made it: an agent task, an agent proposal or a landing by the agentic mode policy. Verified from Golf’s records.'],
};
const number = (value: number) => value.toLocaleString();
const plural = (count: number, [one, many]: [string, string]) => `${number(count)} ${count === 1 ? one : many}`;
const dayMs = 86400_000;
const isoDay = (time: number) => new Date(time).toISOString().slice(0, 10);
const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export const longDate = (day: string) => new Date(day + 'T00:00:00Z').toLocaleDateString(undefined, { timeZone: 'UTC', weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
const summary = (counts: Counts) => (Object.keys(kindLabels) as ContributionKind[]).filter(kind => counts[kind]).map(kind => plural(counts[kind], kindLabels[kind])).join(', ');

// Calendar weeks (Sunday first) covering the range; days outside it are blank.
function weeks(range: Range) {
  const from = Date.parse(range.from + 'T00:00:00Z'), to = Date.parse(range.to + 'T00:00:00Z'), start = from - new Date(from).getUTCDay() * dayMs, list: (string | null)[][] = [];
  for (let week = start; week <= to; week += 7 * dayMs) list.push(Array.from({ length: 7 }, (_, i) => week + i * dayMs).map(time => time >= from && time <= to ? isoDay(time) : null));
  return list;
}
// Four levels from the quartiles of the non-zero values, as GitHub does; level 0 is no activity.
function levels(values: number[]) {
  const sorted = values.filter(value => value > 0).sort((a, b) => a - b), at = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? 0;
  const [q1, q2, q3] = [at(0.25), at(0.5), at(0.75)];
  return (value: number) => value <= 0 ? 0 : value <= q1 ? 1 : value <= q2 ? 2 : value <= q3 ? 3 : 4;
}

export type CalendarCell = { value: number; marked?: boolean; label: string };
// A GitHub-style calendar: a table of weeks by weekday. Each day is a button carrying its full reading; the readout line repeats the
// hovered or focused day, and the selected day opens below. The colour ramp is one hue; the overlay marker is a second hue and a shape.
export function ContributionCalendar({ range, cells, label, unit, selected, onSelect, overlay, overlayLabel }: { range: Range; cells: Map<string, CalendarCell>; label: string;
  unit: [string, string]; selected?: string; onSelect?: (day: string) => void; overlay?: boolean; overlayLabel?: string }) {
  const grid = useMemo(() => weeks(range), [range]), level = useMemo(() => levels([...cells.values()].map(cell => cell.value)), [cells]);
  const [hovered, setHovered] = useState<string>('');
  const reading = (day: string) => cells.get(day)?.label || `No ${unit[1]} on ${longDate(day)}`;
  const monthLabels = grid.map((week, index) => { const first = week.find(day => day && day.endsWith('-01')) || (index === 0 ? week.find(Boolean) : null); return first ? months[Number(first.slice(5, 7)) - 1] : ''; });
  return <figure className="contribution-figure">
    <div className="contribution-scroll" tabIndex={0} role="region" aria-label={`${label}, scroll horizontally when needed`}>
      <table className={overlay ? 'contribution-calendar contribution-overlay' : 'contribution-calendar'} aria-label={label}>
        <thead><tr><td />{monthLabels.map((month, index) => <th key={index} scope="col" className="contribution-month">{month ? <span>{month}</span> : null}</th>)}</tr></thead>
        <tbody>{[0, 1, 2, 3, 4, 5, 6].map(weekday => <tr key={weekday}><th scope="row" className="contribution-weekday">{weekday % 2 ? ['', 'Mon', '', 'Wed', '', 'Fri', ''][weekday] : ''}</th>
          {grid.map((week, index) => { const day = week[weekday]; if (!day) return <td key={index} aria-hidden="true" />;
            const cell = cells.get(day), text = reading(day);
            return <td key={index}><button type="button" className="contribution-day" data-level={level(cell?.value || 0)} data-marked={overlay && cell?.marked ? 'true' : undefined}
              aria-pressed={onSelect ? selected === day : undefined} aria-label={text} title={text}
              onPointerEnter={() => setHovered(day)} onFocus={() => setHovered(day)} onClick={() => onSelect?.(day)} /></td>; })}</tr>)}</tbody>
      </table>
    </div>
    <figcaption className="contribution-caption">
      <span className="contribution-readout" aria-live="polite">{hovered ? reading(hovered) : 'Point at or focus a day to read it.'}</span>
      <span className="contribution-legend" aria-label="Legend"><span>Less</span>{[0, 1, 2, 3, 4].map(step => <span key={step} className="contribution-swatch" data-level={step} aria-hidden="true" />)}<span>More</span>
        {overlay ? <><span className="contribution-swatch contribution-marker-sample" data-level={0} aria-hidden="true" /><span>{overlayLabel}</span></> : null}</span>
    </figcaption>
  </figure>;
}

type DayRow = { day: string; human: number; ai: number; kinds: string; repositories: string };
const dayColumns: DataTableColumn<DayRow>[] = [
  { accessorKey: 'day', header: 'Day' },
  { id: 'human', header: 'Contributions', accessorFn: row => row.human, sortFn: 'basic', cell: ({ row }) => number(row.original.human) },
  { id: 'ai', header: 'With AI involvement', accessorFn: row => row.ai, sortFn: 'basic', cell: ({ row }) => number(row.original.ai) },
  { accessorKey: 'kinds', header: 'What' },
  { accessorKey: 'repositories', header: 'Where' },
];

export function ContributionGraph({ owner, userId }: { owner: string; userId: string }) {
  const [year, setYear] = useState<number | null>(null), [overlay, setOverlay] = useState(false), [selected, setSelected] = useState(''), [table, setTable] = useState(false), [editing, setEditing] = useState(false);
  const key = ['contributions', userId, owner, year];
  const query = useQuery({ ...privateQuery, ...holdErrorOnFocus, queryKey: key, retry: false,
    queryFn: ({ signal }) => nativeAPI<PersonView>('/native/contributions/read', { action: 'person', owner, ...(year === null ? {} : { year }) }, signal) });
  const view = query.data;
  const cells = useMemo(() => new Map((view?.state === 'on' ? view.days : []).map(day => [day.day, { value: day.human, marked: day.ai > 0,
    label: `${plural(day.human, ['contribution', 'contributions'])} on ${longDate(day.day)}${day.ai ? `; ${number(day.ai)} with AI involvement` : ''}` }])), [view]);
  if (query.error) return <section className="browser-panel" aria-labelledby="contributions-title"><div className="browser-panel-heading"><h2 id="contributions-title">Contributions</h2></div><PanelError error={query.error} retry={() => void query.refetch()} /></section>;
  if (!view) return <Loading label="Reading contributions…" />;
  if (view.state !== 'on') return <section className="browser-panel" aria-labelledby="contributions-title"><div className="browser-panel-heading"><h2 id="contributions-title">Contributions</h2></div><p className="panel-footnote" role="note">{view.reason}</p></section>;
  const picked = view.days.find(day => day.day === selected);
  const period = view.range.year === null ? 'in the last year' : `in ${view.range.year}`;
  const rows: DayRow[] = view.days.map(day => ({ day: day.day, human: day.human, ai: day.ai, kinds: summary(day.kinds) + (summary(day.agentKinds) ? `; Golf agent: ${summary(day.agentKinds)}` : ''),
    repositories: [...day.repositories.map(repo => repo.fullName), ...(day.private ? [`${number(day.private)} in private repositories`] : [])].join(', ') }));
  return <section className="browser-panel contribution-panel" aria-labelledby="contributions-title">
    <div className="browser-panel-heading"><h2 id="contributions-title">{plural(view.totals.human, ['contribution', 'contributions'])} {period}</h2>
      <div className="contribution-controls">
        <label className="contribution-toggle"><input type="checkbox" checked={overlay} onChange={event => setOverlay(event.target.checked)} />Show AI involvement</label>
        <label>Period<select value={year ?? ''} onChange={event => { setYear(event.target.value ? Number(event.target.value) : null); setSelected(''); }}>
          <option value="">Last 12 months</option>{view.years.map(item => <option key={item} value={item}>{item}</option>)}</select></label>
      </div></div>
    <div className="contribution-body">
      <ContributionCalendar range={view.range} cells={cells} label={`Contributions by ${view.person.login} ${period}`} unit={['contribution', 'contributions']} selected={selected}
        onSelect={day => setSelected(current => current === day ? '' : day)} overlay={overlay} overlayLabel="AI involvement" />
      <SummaryBand label="Contribution summary" items={[
        ['Contributions', number(view.totals.human), 'Commits, pull requests, reviews, issues, comments'],
        ['With AI involvement', number(view.totals.ai), 'Any tier below except unlabelled'],
        ['Longest streak', plural(view.streaks.longest, ['day', 'days'])],
        ['Current streak', plural(view.streaks.current, ['day', 'days'])],
      ]} />
      {overlay ? <dl className="contribution-tiers" aria-label="AI involvement by tier">{(['agent', 'token', 'assisted', 'declared', 'none'] as AiTier[]).map(tier => <div key={tier}><dt>{tierLabels[tier][0]}</dt><dd>{number(view.totals.tiers[tier])}</dd><dd className="field-help">{tierLabels[tier][1]}</dd></div>)}</dl> : null}
      {picked ? <section className="contribution-day-panel" aria-labelledby="contribution-day-title"><h3 id="contribution-day-title">{longDate(picked.day)}</h3>
        <p>{summary(picked.kinds) || 'No contributions of their own.'}</p>
        {summary(picked.agentKinds) ? <p>Golf agent work they ran: {summary(picked.agentKinds)}.</p> : null}
        {picked.ai ? <p>With AI involvement: {(['assisted', 'declared', 'token', 'agent'] as AiTier[]).filter(tier => picked.tiers[tier]).map(tier => `${tierLabels[tier][0]} ${number(picked.tiers[tier])}`).join(' · ')}</p> : null}
        <ul>{picked.repositories.map(repo => { const [repositoryOwner, name] = repo.fullName.split('/'); return <li key={repo.fullName}><Link {...repositoryOptions({ owner: repositoryOwner!, name: name! })}>{repo.fullName}</Link> {plural(repo.human, ['contribution', 'contributions'])}{repo.ai ? `, ${number(repo.ai)} with AI involvement` : ''}</li>; })}
          {picked.private ? <li>{plural(picked.private, ['contribution', 'contributions'])} in private repositories</li> : null}</ul></section>
        : <p className="field-help">Select a day to see what happened and where.</p>}
      {view.repositories.length ? <div className="contribution-repositories"><h3>Most active repositories {period}</h3><ul>{view.repositories.map(repo => { const [repositoryOwner, name] = repo.fullName.split('/'); return <li key={repo.fullName}><Link {...repositoryOptions({ owner: repositoryOwner!, name: name! })}>{repo.fullName}</Link><span>{number(repo.human)}</span></li>; })}</ul></div> : null}
      <div className="credential-actions"><button type="button" className="button secondary" aria-expanded={table} onClick={() => setTable(value => !value)}>{table ? 'Hide the table' : 'Show as a table'}</button></div>
      {table ? <DataTable data={rows} columns={dayColumns} getRowId={row => row.day} label="contributions by day" emptyMessage={`No contributions ${period}.`} pagination={false} /> : null}
      <PrivacySetting view={view} editing={editing} setEditing={setEditing} />
    </div>
  </section>;
}

function PrivacySetting({ view, editing, setEditing }: { view: Extract<PersonView, { state: 'on' }>; editing: boolean; setEditing: (value: boolean) => void }) {
  const cache = useQueryClient();
  const mutation = useMutation({ retry: false, mutationFn: (showPrivate: boolean) => nativeAPI<{ settings: { showPrivate: boolean; version: number } }>('/native/contributions', { action: 'settings', showPrivate, expectedVersion: view.settings.version ?? 0 }),
    onSuccess: () => { setEditing(false); void cache.invalidateQueries({ queryKey: ['contributions'] }); } });
  const form = useForm({ defaultValues: { showPrivate: view.settings.showPrivate }, onSubmit: ({ value }) => mutation.mutate(value.showPrivate) });
  const current = view.settings.showPrivate ? 'Shown to visitors as anonymous counts, without repository names' : 'Hidden from visitors; they see activity only in repositories they can read';
  if (!view.settings.canEdit) return view.privateCounts.included && view.privateCounts.human ? <p className="field-help">Includes {plural(view.privateCounts.human, ['contribution', 'contributions'])} in repositories you cannot read, shown as counts by {view.person.login}’s choice.</p> : null;
  return <div className="contribution-privacy"><dl className="settings-profile"><div><dt>Private contributions</dt><dd>{current}</dd></div></dl>
    {view.privateCounts.human ? <p className="field-help">You see {plural(view.privateCounts.human, ['contribution', 'contributions'])} in repositories you can no longer read as counts here.</p> : null}
    {!editing ? <div className="credential-actions"><button type="button" className="button secondary" onClick={() => { form.reset(); setEditing(true); }}>Edit private contributions</button></div>
      : <form className="page-stack" aria-label="Private contributions" onSubmit={event => { event.preventDefault(); void form.handleSubmit(); }}>
        <form.Field name="showPrivate">{field => <label><input type="checkbox" checked={field.state.value} disabled={mutation.isPending} onChange={event => field.handleChange(event.target.checked)} /> Show my activity in private repositories as anonymous counts</label>}</form.Field>
        <p className="field-help">Visitors see how many contributions you made on each day, never which repository. Off, they see only repositories they can read.</p>
        {mutation.error ? <PanelError error={mutation.error} retry={() => { mutation.reset(); setEditing(false); }} /> : null}
        <div className="credential-actions"><button className="button primary" disabled={mutation.isPending}>Save</button><button type="button" className="button secondary" disabled={mutation.isPending} onClick={() => setEditing(false)}>Cancel</button></div>
      </form>}
  </div>;
}
