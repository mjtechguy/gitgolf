import { Archive, CalendarDays, CircleCheck, CircleDot, LockKeyhole, Milestone, UserRound } from 'lucide-react';
import { IssueState } from './gen/golf/v1/golf_pb';
import type { DiscussionLabel, DiscussionMetadata as Metadata } from './gen/golf/v1/golf_pb';
import { DateLabel } from './RepositoryUI';

const labelColor = /^[0-9a-f]{6}$/i;
function Label({ label }: { label: DiscussionLabel }) {
  return <li className="discussion-label-chip" title={label.description || undefined}>
    <svg className="discussion-label-swatch" viewBox="0 0 10 10" width={10} height={10} aria-hidden="true"><circle cx={5} cy={5} r={4} fill={labelColor.test(label.color) ? `#${label.color}` : 'currentColor'}/></svg>
    <span>{label.name}</span>
    {label.description ? <span className="sr-only"> · {label.description}</span> : null}
    {label.exclusive ? <span className="discussion-label-flag" title="Exclusive label"><LockKeyhole size={12} aria-hidden="true"/><span className="sr-only"> · Exclusive label</span></span> : null}
    {label.archived ? <span className="discussion-label-flag" title="Archived label"><Archive size={12} aria-hidden="true"/><span className="sr-only"> · Archived label</span></span> : null}
  </li>;
}

export function DiscussionMetadata({ metadata }: { metadata?: Metadata }) {
  if (!metadata || !metadata.labelsKnown && !metadata.assigneesKnown && !metadata.milestoneKnown) return null;
  const milestone = metadata.milestone;
  return <div className="discussion-metadata">
    {metadata.assigneesKnown ? <section aria-label="Assignees"><h3>Assignees</h3>{metadata.assignees.length ? <ul className="discussion-assignees">{metadata.assignees.map(user => <li key={user.id}><UserRound size={16} aria-hidden="true"/><span><strong>{user.login || 'Unavailable account'}</strong>{user.fullName && user.fullName !== user.login ? <span className="muted">{user.fullName}</span> : null}</span></li>)}</ul> : <p className="muted">None</p>}</section> : null}
    {metadata.labelsKnown ? <section aria-label="Labels"><h3>Labels</h3>{metadata.labels.length ? <ul className="discussion-labels">{metadata.labels.map(label => <Label key={label.id} label={label}/>)}</ul> : <p className="muted">None</p>}</section> : null}
    {metadata.milestoneKnown ? <section aria-label="Milestone"><h3>Milestone</h3>{milestone ? <>
      <strong className="discussion-milestone-title"><Milestone size={16} aria-hidden="true"/>{milestone.title}</strong>
      <span className={`discussion-milestone-state ${milestone.state === IssueState.CLOSED ? 'muted' : ''}`}>{milestone.state === IssueState.CLOSED ? <CircleCheck size={13} aria-hidden="true"/> : <CircleDot size={13} aria-hidden="true"/>}{milestone.state === IssueState.OPEN ? 'Open' : milestone.state === IssueState.CLOSED ? 'Closed' : 'State unavailable'}</span>
      <dl className="discussion-milestone-counts"><div><dt>Open</dt><dd>{milestone.openIssues.toLocaleString()}</dd></div><div><dt>Closed</dt><dd>{milestone.closedIssues.toLocaleString()}</dd></div></dl>
      {milestone.dueOn ? <p className="discussion-milestone-due"><CalendarDays size={14} aria-hidden="true"/>Due <DateLabel value={milestone.dueOn}/></p> : null}
      {milestone.description ? <details className="metadata-details discussion-milestone-details"><summary>Description</summary><p>{milestone.description}</p></details> : null}
    </> : <p className="muted">None</p>}</section> : null}
  </div>;
}
