import { useRuntimeCapabilities } from './useRuntimeCapabilities';
import { RuntimeFeature } from './RuntimeFeature';
import {IssueFormEditor} from './IssueFormEditor';
import {IssueTemplateChooser} from './IssueTemplateChooser';
import {DiscussionEngagement,DiscussionTimeline} from './DiscussionEngagement';
import { DiscussionResourceManagement, CommentResourceControls } from './DiscussionResourceControls';
import { DiscussionListControls, discussionQuery } from './DiscussionListControls';
import { DiscussionMetadata } from './DiscussionMetadata';
import { IssueLabelSuggestions } from './IssueLabelSuggestions';
import { RepositoryListControls, useRepositoryWorkList } from './RepositoryListControls';
import { MarkdownBody } from './RepositoryContent';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useForm, useStore } from '@tanstack/react-form';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { Code, ConnectError } from '@connectrpc/connect';
import { Link, useBlocker, useNavigate } from '@tanstack/react-router';
import { ArrowLeft, CircleDot, ExternalLink, LoaderCircle, MessageSquare, Plus, RefreshCw, Pencil, FilePenLine, CircleCheck, Undo2 } from 'lucide-react';
import { repositoryClient, repositoryLink, errorMessage } from './api';
import { IssueMutationKind, IssueMutationState, IssueState } from './gen/golf/v1/golf_pb';
import type { CreateIssueCommentRequest, CreateIssueRequest, GetIssueMutationResponse, Issue, IssueComment, IssueMutation, PageResponse, RepositoryKey, UpdateIssueRequest, UpdatePullRequestRequest, PullRequest, User, RepositoryComparisonSelection, CreatePullRequestRequest, DiscussionMilestone, DiscussionLabel, IssueTemplate } from './gen/golf/v1/golf_pb';
import { repositoryOptions } from './navigation';
import type { RepositoryLocation } from './navigation';
import { DateLabel, Loading, More, PanelError, privateQuery } from './RepositoryUI';
import { issueIntentKey, readIssueIntent } from './issueIntents';
import type { IssueIntent } from './issueIntents';
import { NativeAgentTasks } from './NativeAgentTasks';

type Props = { repositoryKey: Pick<RepositoryKey, 'owner' | 'name'>; repositoryId: string; queryKey: readonly unknown[]; location: RepositoryLocation; userId: string; pullRequest?: boolean };
type Observation = Pick<GetIssueMutationResponse, 'mutation' | 'issue' | 'comment' | 'pullRequest'>;
const followingPage = (response: { page?: PageResponse }, _pages: unknown[], current: number) => {
  const next = response.page?.nextPage ?? 0;
  return next > current && next <= 10_000 ? next : undefined;
};
const sortedLabelIds = (values: readonly string[]) => [...values].sort((a, b) => BigInt(a) < BigInt(b) ? -1 : BigInt(a) > BigInt(b) ? 1 : 0);
const sameLabelIds = (a: readonly string[], b: readonly string[]) => { const sorted = sortedLabelIds(b); return a.length === b.length && sortedLabelIds(a).every((id, index) => id === sorted[index]); };
const selectableLabelId = (id: string) => /^[1-9][0-9]{0,15}$/.test(id) && BigInt(id) <= 9007199254740991n;
const assigneeId = (id: string) => /^[1-9][0-9]{0,18}$/.test(id) && BigInt(id) <= 9223372036854775807n;
const validAssigneeIds = (ids: readonly string[]) => ids.length <= 100 && new Set(ids).size === ids.length && ids.every(assigneeId);
const conflictingLabels = (ids: readonly string[], rows: readonly DiscussionLabel[]) => { const scopes = new Set<string>(); return rows.filter(row => ids.includes(row.id) && row.exclusive).some(row => { const split = row.name.lastIndexOf('/'); if (split <= 0 || split === row.name.length - 1) return false; const scope = row.name.slice(0, split); if (scopes.has(scope)) return true; scopes.add(scope); return false; }); };
const denied = (error: unknown) => error instanceof ConnectError && [Code.PermissionDenied, Code.NotFound, Code.Unauthenticated].includes(error.code);

export function refreshDiscussionMetadata(client: QueryClient, queryKey: readonly unknown[]) {
  for (const name of ['milestones','labels','assignees']) void client.invalidateQueries({queryKey:[...queryKey,name]});
}

function IssueStateIcon({ state, size = 13 }: { state: IssueState; size?: number }) {
  const Icon = state === IssueState.CLOSED ? CircleCheck : CircleDot;
  return <Icon size={size} aria-hidden="true"/>;
}
function IssueStateBadge({ state }: { state: IssueState }) {
  return <span className={`issue-state ${state === IssueState.CLOSED ? 'closed' : ''}`}><IssueStateIcon state={state}/>{state === IssueState.OPEN ? 'open' : state === IssueState.CLOSED ? 'closed' : 'unknown'}</span>;
}
function Comment({ comment, controls }: { comment: IssueComment; controls?: ReactNode }) {
  const external = repositoryLink(comment.htmlUrl);
  return <article className="issue-comment">
    <header className="issue-comment-heading"><div className="issue-comment-byline"><h3>{comment.user?.login || 'Deleted or unavailable author'}</h3><span>commented <DateLabel value={comment.createdAt}/></span>{comment.updatedAt && comment.updatedAt !== comment.createdAt ? <span>· edited <DateLabel value={comment.updatedAt}/></span> : null}</div>{external ? <a className="icon-button" href={external} target="_blank" rel="noopener noreferrer" aria-label="Open original comment" title="Open original comment"><ExternalLink size={14} aria-hidden="true"/></a> : null}</header>
    <MarkdownBody text={comment.body || 'No comment text provided.'} label={`Comment ${comment.id}, rendered Markdown`}/>{controls}
  </article>;
}

export function DiscussionComposer({ repositoryKey, repositoryId, queryKey, userId, pullRequest, issue, proposal, onCreated, onPending, onPosted, editField, onUpdated, onPullUpdated, creation, onPullCreated, initialTitle, initialBody, blocked, onClose, onDraftChange, fullPage, milestoneChoices, milestoneReady, labelChoices, labelsReady, suggestedLabelIds, assigneeChoices, assigneesReady }: Props & { creation?:RepositoryComparisonSelection; blocked?:boolean; initialTitle?:string; initialBody?:string; onPullCreated?:(pull:PullRequest)=>void; issue?: Issue; proposal?: PullRequest; onPullUpdated?: (pull?: PullRequest) => void; onCreated?: (issue: Issue) => void; onPending?: (value: boolean) => void; onPosted?: () => void; editField?: IssueIntent['editField']; onUpdated?: (issue?: Issue) => void; onClose?: () => void; onDraftChange?: (dirty: boolean) => void; fullPage?: boolean; milestoneChoices?: readonly DiscussionMilestone[]; milestoneReady?: boolean; labelChoices?: readonly DiscussionLabel[]; labelsReady?: boolean; suggestedLabelIds?: readonly string[]; assigneeChoices?: readonly User[]; assigneesReady?: boolean }) {
  const edit = Boolean(editField);
  const pageEditor = Boolean(fullPage && !issue && !proposal && !creation && !edit);
  const originalIssue = useRef(issue);
  const originalProposal = useRef(proposal);
  const target = proposal || issue;
  const originalTarget = originalProposal.current || originalIssue.current;
  const targetName = proposal || creation ? "pull request" : "issue";
  const kind = creation ? 'pull' : proposal ? 'pull-update' : edit ? 'update' : issue ? 'comment' : 'issue';
  const storageKey = issueIntentKey(userId, repositoryId, creation ? 'new-pull' : proposal ? 'pull-'+proposal.id : issue?.id) + (edit ? ':edit' : '');
  const [intent, setIntent] = useState(() => readIssueIntent(storageKey, repositoryId, issue?.id, target?.number, kind, proposal?.id));
  const form = useForm({ defaultValues: { title: editField === 'title' ? target?.title || '' : initialTitle || '', body: editField === 'body' ? target?.body || '' : initialBody || '', draft:false, milestoneId: target?.metadata?.milestone?.id || '0', labelIds: [...new Set([...target?.metadata?.labels.map(row => row.id) || [], ...editField === 'labels' && suggestedLabelIds ? suggestedLabelIds.filter(id => labelChoices?.some(row => row.id === id)) : []])], assigneeIds: target?.metadata?.assignees.map(row => row.id) || [], assigneeSearch: '' }, onSubmit: () => submit() });
  const { title, body, draft, milestoneId, labelIds, assigneeIds, assigneeSearch } = useStore(form.store, (state) => state.values);
  const originalAssigneeIds = originalTarget?.metadata?.assignees.map(row => row.id) || [];
  const assigneeInventory = new Map(assigneeChoices?.map(row => [row.id, row]));
  const assigneeSelectionsValid = Boolean(assigneesReady && originalTarget?.metadata?.assigneesKnown) && validAssigneeIds(originalAssigneeIds) && validAssigneeIds(assigneeIds) && assigneeIds.every(id => assigneeInventory.has(id));
  const assigneeRows = assigneesReady ? [...new Map([...originalTarget?.metadata?.assignees || [], ...assigneeChoices || []].map(row => [row.id, row])).values()].filter(row => row.login.toLowerCase().includes(assigneeSearch.trim().toLowerCase()) || row.fullName.toLowerCase().includes(assigneeSearch.trim().toLowerCase())) : [];
  const setTitle = (value: string) => form.setFieldValue('title', value);
  const setBody = (value: string) => form.setFieldValue('body', value);
  const [preview,setPreview]=useState(false);
  const [record, setRecord] = useState<IssueMutation | null>(null);
  const [posted, setPosted] = useState<IssueComment | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const mounted = useRef(true);
  const latch = useRef(false);
  const controller = useRef<AbortController | null>(null);
  const frozen = useRef<Pick<CreateIssueRequest, 'title' | 'body'> | Pick<CreateIssueCommentRequest, 'body'> | null>(null);
  const updateFrozen = useRef<UpdateIssueRequest | null>(null);
  const pullCreateFrozen=useRef<CreatePullRequestRequest|null>(null);
  const pullFrozen = useRef<UpdatePullRequestRequest | null>(null);
  const firstInput = useRef<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement | null>(null);
  const statusButton = useRef<HTMLButtonElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const client = useQueryClient();
  const active = () => mounted.current && client.getQueryData<User | null>(['session'])?.id === userId;
  async function observe(response: Observation, pending: IssueIntent) {
    if (!active()) return;
    const value = response.mutation;
    if (!value || value.idempotencyKey !== pending.key || value.repositoryId !== repositoryId || value.repository?.owner !== repositoryKey.owner || value.repository?.name !== repositoryKey.name ||
      value.kind !== (creation ? IssueMutationKind.CREATE_PULL : proposal ? IssueMutationKind.UPDATE_PULL : edit ? IssueMutationKind.UPDATE_ISSUE : issue ? IssueMutationKind.CREATE_COMMENT : IssueMutationKind.CREATE_ISSUE) || issue && (value.issueId !== issue.id || value.number !== issue.number) || proposal && (value.issueId !== "" || value.pullRequestId !== proposal.id || value.number !== proposal.number)) {
      throw new ConnectError('The outcome record does not match this request. Keep its key and check again.', Code.FailedPrecondition);
    }
    const success = value.state === IssueMutationState.SUCCEEDED;
    if (success && (response.issue && (response.issue.id !== value.issueId || response.issue.number !== value.number) || response.comment && response.comment.id !== value.commentId || (proposal || creation) && (value.observedResultId !== value.pullRequestId || value.observedNumber !== value.number || response.pullRequest && (response.pullRequest.id !== value.pullRequestId || response.pullRequest.number !== value.number || response.pullRequest.base?.repositoryId !== repositoryId)))) {
      throw new ConnectError('The returned object does not match the recorded outcome. Keep its key and check again.', Code.FailedPrecondition);
    }
    setRecord(value);
    const confirmed = success && (proposal || creation ? Boolean(response.pullRequest) : edit ? Boolean(response.issue) : issue ? Boolean(response.comment) : Boolean(response.issue));
    if (!confirmed) return;
    try { sessionStorage.removeItem(storageKey); } catch { /* A later lookup can inspect the same durable outcome. */ }
    onPending?.(false);
    if (creation && response.pullRequest) { onPullCreated?.(response.pullRequest); }
    else if (proposal && response.pullRequest) { onPullUpdated?.(response.pullRequest); }
    else if (edit && response.issue) { onUpdated?.(response.issue); }
    else if (issue && response.comment) { setPosted(response.comment); onPosted?.(); }
    else if (response.issue) { void client.invalidateQueries({ queryKey: [...queryKey, 'issues'] }); onCreated?.(response.issue); }
  }
  const action = useMutation({
    retry: false, gcTime: 0,
    // Mutation variables contain only metadata, never a private draft. The
    // frozen text is sent once and discarded when this composer unmounts.
    mutationFn: async ({ pending, inspect }: { pending: IssueIntent; inspect: boolean }) => {
      controller.current = new AbortController();
      const options = { signal: controller.current.signal, timeoutMs: inspect ? 8_000 : 15_000 };
      if (inspect) await observe(await repositoryClient.getIssueMutation({ idempotencyKey: pending.key }, options), pending);
      else if (creation && pullCreateFrozen.current) await observe(await repositoryClient.createPullRequest(pullCreateFrozen.current, options), pending);
      else if (proposal && pullFrozen.current) await observe(await repositoryClient.updatePullRequest(pullFrozen.current, options), pending);
      else if (edit && updateFrozen.current) await observe(await repositoryClient.updateIssue(updateFrozen.current, options), pending);
      else if (issue && frozen.current) await observe(await repositoryClient.createIssueComment({ repository: repositoryKey, repositoryId, number: issue.number, issueId: issue.id, body: frozen.current.body, pullRequest, idempotencyKey: pending.key }, options), pending);
      else if (frozen.current && 'title' in frozen.current) await observe(await repositoryClient.createIssue({ repository: repositoryKey, repositoryId, title: frozen.current.title, body: frozen.current.body, idempotencyKey: pending.key }, options), pending);
      else throw new ConnectError('This resumed request supports status inspection only.', Code.FailedPrecondition);
    },
    onError: (failure) => {
      if (!active()) return;
      setRecord(null); setPosted(null); setError(failure);
      if (denied(failure)) { setTitle(''); setBody(''); frozen.current = null; updateFrozen.current = null; pullFrozen.current = null; pullCreateFrozen.current=null; }
    },
    onSettled: () => { latch.current = false; controller.current = null; },
  });
  useEffect(() => {
    mounted.current = true;
    if (intent) statusButton.current?.focus(); else if (firstInput.current && !firstInput.current.disabled) firstInput.current.focus(); else closeButton.current?.focus();
    return () => { mounted.current = false; controller.current?.abort(); frozen.current = null; updateFrozen.current = null; pullFrozen.current = null; pullCreateFrozen.current=null; };
  }, []);
  function submit() {
    if (latch.current || intent || creation && blocked || editField === 'milestone' && (!milestoneReady || !originalTarget?.metadata?.milestoneKnown || milestoneId !== '0' && !milestoneChoices?.some(row => row.id === milestoneId))) return;
    if (editField === 'labels' && (!labelsReady || !originalTarget?.metadata?.labelsKnown || labelIds.length > 256 || conflictingLabels(labelIds, labelChoices || []) || labelIds.some(id => !selectableLabelId(id) || !labelChoices?.some(row => row.id === id)))) return;
    if (editField === 'assignees' && !assigneeSelectionsValid) return;
    const exactTitle = title.trim();
    const titleBytes = new TextEncoder().encode(exactTitle);
    const bodyBytes = new TextEncoder().encode(body);
    if ((!target || editField === 'title') && (!exactTitle || titleBytes.byteLength > 255 || new TextDecoder().decode(titleBytes) !== exactTitle || /\p{Cc}/u.test(exactTitle))) {
      setError(new Error('Use a title of 1–255 UTF-8 bytes without control characters. No request was sent.')); return;
    }
    if (bodyBytes.byteLength > 6000 || new TextDecoder().decode(bodyBytes) !== body || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u.test(body) || issue && !edit && !body.trim()) {
      setError(new Error(`Use ${issue && !edit ? 'nonempty ' : ''}valid text up to 6,000 UTF-8 bytes. Only tabs and line breaks are allowed as control characters. No request was sent.`)); return;
    }
    try {
      const pending: IssueIntent = { key: crypto.randomUUID(), kind, repositoryId, issueId: issue?.id || '', number: target?.number || 0, ...(proposal ? {pullRequestId:proposal.id} : {}), ...(edit ? {editField} : {}) };
      sessionStorage.setItem(storageKey, JSON.stringify(pending));
      if (creation) pullCreateFrozen.current={...creation,$typeName:'golf.v1.CreatePullRequestRequest',title:exactTitle,body,draft,idempotencyKey:pending.key};
      else if (proposal) pullFrozen.current = { $typeName:'golf.v1.UpdatePullRequestRequest', repository:{...repositoryKey,$typeName:'golf.v1.RepositoryKey'}, repositoryId, pullRequestId:proposal.id, number:proposal.number, expectedRevision:originalProposal.current!.revision, idempotencyKey:pending.key, state:editField==='close'?IssueState.CLOSED:editField==='reopen'?IssueState.OPEN:IssueState.UNSPECIFIED, ...(editField==='title'?{title:exactTitle}:editField==='body'?{body}:editField==='draft'?{draft:true}:editField==='ready'?{draft:false}:editField==='milestone'?{milestone:{$typeName:'golf.v1.IssueMilestoneChange',expectedMilestoneId:originalTarget!.metadata!.milestone?.id||'0',milestoneId}}:editField==='labels'?{labels:{$typeName:'golf.v1.IssueLabelsChange',expectedLabelIds:sortedLabelIds(originalTarget!.metadata!.labels.map(row=>row.id)),labelIds:sortedLabelIds(labelIds)}}:editField==='assignees'?{assignees:{$typeName:'golf.v1.IssueAssigneesChange',expectedAssigneeIds:sortedLabelIds(originalAssigneeIds),assignees:sortedLabelIds(assigneeIds).map(id=>({$typeName:'golf.v1.DiscussionAssigneeSelection',id,login:assigneeInventory.get(id)!.login}))}}:{}) };
      else if (edit) updateFrozen.current = { $typeName: 'golf.v1.UpdateIssueRequest', repository: {...repositoryKey,$typeName:'golf.v1.RepositoryKey'}, repositoryId, issueId: issue!.id, number: issue!.number, expectedRevision: originalIssue.current!.revision, idempotencyKey: pending.key, state: editField === 'close' ? IssueState.CLOSED : editField === 'reopen' ? IssueState.OPEN : IssueState.UNSPECIFIED, ...(editField === 'title' ? {title:exactTitle} : editField === 'body' ? {body} : editField === 'milestone' ? { milestone: { $typeName: 'golf.v1.IssueMilestoneChange', expectedMilestoneId: originalTarget!.metadata!.milestone?.id || '0', milestoneId } } : editField === 'labels' ? { labels: { $typeName: 'golf.v1.IssueLabelsChange', expectedLabelIds: sortedLabelIds(originalTarget!.metadata!.labels.map(row => row.id)), labelIds: sortedLabelIds(labelIds) } } : editField === 'assignees' ? { assignees: { $typeName: 'golf.v1.IssueAssigneesChange', expectedAssigneeIds: sortedLabelIds(originalAssigneeIds), assignees: sortedLabelIds(assigneeIds).map(id => ({ $typeName: 'golf.v1.DiscussionAssigneeSelection', id, login: assigneeInventory.get(id)!.login })) } } : {}) };
      else frozen.current = issue ? { body } : { title: exactTitle, body };
      latch.current = true; setIntent(pending); setError(null); onPending?.(true);
      action.mutate({ pending, inspect: false });
    } catch { setError(new Error('Golf needs secure random IDs and writable tab storage before sending. No request was sent.')); }
  }
  function inspect() {
    if (!intent || latch.current) return;
    latch.current = true; setRecord(null); setPosted(null); setError(null);
    action.mutate({ pending: intent, inspect: true });
  }
  function nextIntent() {
    if (latch.current || record?.state !== IssueMutationState.REJECTED && !posted) return;
    try { sessionStorage.removeItem(storageKey); } catch { setError(new Error('Golf could not clear the pending request in this tab. No new request was sent.')); return; }
    frozen.current = null; updateFrozen.current = null; pullFrozen.current = null; pullCreateFrozen.current=null; setIntent(null); setRecord(null); setPosted(null); setError(null); action.reset(); onPending?.(false);
    if (creation) {setTitle('');setBody('');onClose?.();}
    if (edit) { setTitle(''); setBody(''); if(proposal)onPullUpdated?.();else onUpdated?.(); }
    if (posted) setBody('');
    requestAnimationFrame(() => firstInput.current?.focus());
  }
  useEffect(() => { onDraftChange?.(!intent && Boolean(title || body)); }, [title, body, intent, onDraftChange]);
  const rejected = record?.state === IssueMutationState.REJECTED;
  const succeeded = record?.state === IssueMutationState.SUCCEEDED;
  return <div className="issue-composer">
    {pageEditor ? null : edit ? <details className="metadata-details"><summary>Editing permissions</summary><p className="field-help">This change requires {editField === 'milestone' || editField === 'labels' || editField === 'assignees' ? `${proposal ? 'pull-request' : 'issue'}-write access` : `the ${targetName} author or an account with ${proposal ? "pull-request" : "issue"}-write access`}. Permissions are checked when saving. A concurrent change may require a new review.</p></details> : creation ? <p className="field-help">The selected repositories and branch commits are checked again when creating the pull request.</p> : <p className="field-help">Creating issues and posting comments requires issue-write permission. If your connected account has read-only access, ask your administrator to update it.</p>}
    {posted ? <><p className="session-notice" role="status">Comment posted.</p><Comment comment={posted} /><button className="button secondary" onClick={nextIntent}>Write another comment</button></> : <form onSubmit={(event) => { event.preventDefault(); void form.handleSubmit(); }}>
      {!target || editField === 'title' ? <><label htmlFor="issue-title-input">{proposal || creation ? "Pull request title" : "Issue title"}</label><input ref={(element) => { firstInput.current = element; }} id="issue-title-input" value={title} onChange={(event) => setTitle(event.target.value)} required maxLength={255} disabled={Boolean(intent)} autoComplete="off" /></> : null}
      {!edit || editField === 'body' ? <><label htmlFor={edit ? 'issue-edit-body-input' : issue ? 'issue-comment-input' : 'issue-body-input'}>{creation || editField === 'body' ? 'Description, Markdown' : issue ? 'Comment, plain text' : 'Description, plain text'}</label>{pageEditor ? <div className="content-view-controls" aria-label="Description view"><button type="button" className={`text-button ${!preview ? 'active' : ''}`} aria-pressed={!preview} onClick={() => setPreview(false)}>Write</button><button type="button" className={`text-button ${preview ? 'active' : ''}`} aria-pressed={preview} onClick={() => setPreview(true)}>Preview Markdown</button></div> : null}<textarea hidden={pageEditor && preview} ref={target ? (element) => { firstInput.current = element; } : undefined} id={edit ? 'issue-edit-body-input' : issue ? 'issue-comment-input' : 'issue-body-input'} value={body} onChange={(event) => setBody(event.target.value)} required={Boolean(issue) && !edit} rows={issue ? 5 : 7} maxLength={6000} disabled={Boolean(intent)} autoComplete="off" />
      {!pageEditor ? <button type="button" className="text-button" aria-pressed={preview} onClick={()=>setPreview(!preview)}>{preview?'Hide preview':'Preview Markdown'}</button> : null}{preview?<MarkdownBody text={body||'Nothing to preview.'} label="Draft Markdown preview"/>:null}<p className="field-help">Markdown is rendered safely; HTML stays text. Maximum 6,000 UTF-8 bytes.</p></> : editField === 'close' || editField === 'reopen' ? <p>{editField === 'close' ? 'Close' : 'Reopen'} {targetName} #{target!.number}? This changes its native state and may send configured notifications.</p> : editField === 'draft' || editField === 'ready' ? <p>{editField === 'draft' ? 'Convert to draft' : 'Mark ready for review'}? Draft state uses the native title prefix. This changes the title and may send configured notifications.</p> : null}
      {editField === 'milestone' ? <form.Field name="milestoneId">{field => <label>Milestone<select ref={element => { firstInput.current = element; }} aria-label="Issue milestone" value={field.state.value} disabled={Boolean(intent) || !milestoneReady} onChange={event => field.handleChange(event.target.value)}><option value="0">None</option>{target?.metadata?.milestoneKnown && originalTarget?.metadata?.milestone && !milestoneChoices?.some(row => row.id === originalTarget!.metadata!.milestone!.id) ? <option value={originalTarget!.metadata.milestone.id}>{originalTarget!.metadata.milestone.title} (current)</option> : null}{milestoneChoices?.map(row => <option key={row.id} value={row.id}>{row.title}{row.state === IssueState.CLOSED ? ' (closed)' : ''}</option>)}</select></label>}</form.Field> : null}
      {editField === 'labels' ? <form.Field name="labelIds">{field => <fieldset className="metadata-choice-list" disabled={Boolean(intent) || !labelsReady}><legend>Labels</legend>{labelChoices?.length ? labelChoices.map((row, index) => <label key={row.id}><input ref={index === labelChoices.findIndex(row => selectableLabelId(row.id) || field.state.value.includes(row.id)) ? element => { firstInput.current = element; } : undefined} type="checkbox" aria-label={row.name} checked={field.state.value.includes(row.id)} disabled={!selectableLabelId(row.id) && !field.state.value.includes(row.id)} onChange={event => field.handleChange(event.target.checked ? [...field.state.value, row.id] : field.state.value.filter(id => id !== row.id))}/><span>{row.name}{row.archived ? ' (archived)' : ''}{row.exclusive ? ' (exclusive)' : ''}</span>{suggestedLabelIds?.includes(row.id) ? <span className="label-suggested">Suggested by Clef</span> : null}</label>) : <p className="muted">No repository labels in the loaded pages.</p>}<p className="field-help">{conflictingLabels(field.state.value, labelChoices || []) ? 'Choose at most one exclusive label in each group.' : suggestedLabelIds?.length ? 'Clef’s suggestions are selected; review them before saving. Nothing changes until you save.' : 'Clear all selections to remove repository labels.'}</p></fieldset>}</form.Field> : null}
      {editField === 'assignees' ? <form.Field name="assigneeIds">{field => <fieldset className="metadata-choice-list" disabled={Boolean(intent) || !assigneesReady}>
        <legend>Assignees</legend>
        <form.Field name="assigneeSearch">{search => <input ref={element => { firstInput.current = element; }} className="branch-search" type="search" aria-label="Search loaded assignees" placeholder="Search loaded assignees…" value={search.state.value} autoComplete="off" onChange={event => search.handleChange(event.target.value)}/>}</form.Field>
        <div className="metadata-choice-scroll" role="group" aria-label="Loaded assignee choices">{assigneeRows.map(row => <label key={row.id}><input type="checkbox" aria-label={row.login} checked={field.state.value.includes(row.id)} disabled={!assigneeInventory.has(row.id) && !field.state.value.includes(row.id) || field.state.value.length >= 100 && !field.state.value.includes(row.id)} onChange={event => field.handleChange(event.target.checked ? [...field.state.value, row.id] : field.state.value.filter(id => id !== row.id))}/><span>{row.login}{!assigneeInventory.has(row.id) ? <span className="muted"> (not in current candidates; remove only)</span> : row.fullName && row.fullName !== row.login ? <span className="muted"> · {row.fullName}</span> : null}</span></label>)}</div>
        {!assigneeRows.length ? <p className="muted">{assigneeSearch ? 'No loaded assignees match this search.' : 'No repository candidates.'}</p> : null}
        <p className="field-help">Search covers loaded repository candidates. Select up to 100 accounts; saving checks their current eligibility. Remove accounts absent from current candidates before saving. Clear selections to remove all assignees.</p>
      </fieldset>}</form.Field> : null}
      {creation?<label>Readiness<select aria-label="Pull request readiness" value={draft?'draft':'ready'} disabled={Boolean(intent)} onChange={event=>form.setFieldValue('draft',event.target.value==='draft')}><option value="ready">Ready for review</option><option value="draft">Draft pull request</option></select></label>:null}
      {intent ? <div className="creation-status" role="status"><p>{action.isPending ? 'Checking this request… Its outcome may still be unknown.' : rejected ? record.failureCode === 'provider_http_403' ? 'Your account does not have permission to make this change.' : record.failureCode === 'revision_changed' || record.failureCode === 'milestone_changed' || record.failureCode === 'assignees_changed' || record.failureCode === 'assignee_changed' || record.failureCode === 'provider_http_409' ? `The ${targetName} changed before this request was sent. Review the current ${targetName} before editing again.` : record.failureCode === 'unchanged' ? `The selected field is already unchanged. Review the current ${targetName}.` : record.failureCode === 'target_changed' ? 'The target changed before this write was sent. Refresh repository access and inspect the issue before explicitly starting a new request.' : 'The request was rejected. You can explicitly start a new request.' : succeeded ? 'The write was recorded as successful, but Golf cannot confirm current access to its result. This record does not grant access.' : 'This request may still be running, or its outcome is unknown. Check its status; do not repost the text as a new request.'}</p><p className="field-help">Request key <code>{intent.key}</code></p>{!frozen.current && !updateFrozen.current && !pullFrozen.current && !pullCreateFrozen.current ? <p className="field-help">Draft text was not stored. This resumed request supports status checks only.</p> : null}<p className="field-help">Closing or leaving does not cancel provider work. This tab saves only the key and target IDs until sign-out.</p></div> : null}
      {error ? <p className="error" role="alert">{errorMessage(error)}</p> : null}
      <div className="credential-actions">{intent ? <><button ref={statusButton} type="button" className="button secondary" disabled={action.isPending} onClick={inspect}><RefreshCw size={15} />Check request status</button>{rejected ? <button type="button" className="button primary" onClick={nextIntent}>{edit ? `Review current ${targetName}` : 'Start a new request'}</button> : null}</> : <button className="button primary" disabled={Boolean(creation&&blocked)||(edit ? editField === 'title' ? !title.trim() || title.trim() === (originalProposal.current || originalIssue.current)?.title : editField === 'body' ? body === (originalProposal.current || originalIssue.current)?.body : editField === 'milestone' ? !milestoneReady || milestoneId === (originalTarget?.metadata?.milestone?.id || '0') : editField === 'labels' ? !labelsReady || labelIds.length > 256 || conflictingLabels(labelIds, labelChoices || []) || labelIds.some(id => !selectableLabelId(id) || !labelChoices?.some(row => row.id === id)) || sameLabelIds(labelIds, originalTarget?.metadata?.labels.map(row => row.id) || []) : editField === 'assignees' ? !assigneeSelectionsValid || sameLabelIds(assigneeIds, originalAssigneeIds) : false : issue ? !body.trim() : !title.trim())}>{action.isPending ? <LoaderCircle className="spin" size={16} /> : edit ? editField === 'reopen' ? <Undo2 size={16}/> : <CircleCheck size={16}/> : <Plus size={16} />}{edit ? editField === 'close' ? `Close ${targetName}` : editField === 'reopen' ? `Reopen ${targetName}` : editField === 'draft' ? 'Convert to draft' : editField === 'ready' ? 'Ready for review' : 'Save changes' : creation ? draft?'Create draft pull request':'Create pull request' : issue ? 'Post comment' : 'Create issue'}</button>}{onClose ? <button ref={closeButton} type="button" className="button secondary" onClick={onClose}>{!target && !creation ? 'Cancel' : 'Close editor'}</button> : null}</div>
    </form>}
  </div>;
}

function NewIssue(props: Props) {
  const navigate = useNavigate();
  const [dirty, setDirty] = useState(false);
  const [template,setTemplate]=useState<IssueTemplate>();
  const completed = useRef(false);
  useBlocker({
    shouldBlockFn: () => !completed.current && dirty && !window.confirm('Discard this unsent issue draft?'),
    enableBeforeUnload: () => !completed.current && dirty,
  });
  const cancel = () => void navigate(repositoryOptions(props.location, { issue: undefined, issueNew: undefined }));
  return <section className="issue-create-page" aria-label="New issue">
    <header className="discussion-summary"><div className="discussion-navigation"><Link className="text-button" {...repositoryOptions(props.location, { issue: undefined, issueNew: undefined })}><ArrowLeft size={15} />Issues</Link></div><h2>New issue</h2><p className="field-help">Describe a bug, propose a change, or start a discussion in {props.location.owner}/{props.location.name}.</p></header>
    <div className="discussion-layout"><section className="browser-panel" aria-label="Issue editor"><div className="browser-panel-heading"><h2><CircleDot size={17} />Create an issue</h2></div><div className="issue-edit-content"><RuntimeFeature id="discussion.templates"><IssueTemplateChooser {...props} choose={value=>{if(!dirty||window.confirm('Replace this unsent issue draft with the selected template?')){setTemplate(value);setDirty(false);}}}/></RuntimeFeature>{template?.fields.length?<IssueFormEditor key={template.path+template.blobId} template={template} onDraftChange={setDirty} cancel={()=>{setTemplate(undefined);setDirty(false);}} prepare={body=>{setTemplate({...template,fields:[],body});setDirty(false);}}/>:<DiscussionComposer key={template?template.path+template.blobId:'blank'} {...props} initialTitle={template?.title} initialBody={template?.body} fullPage onDraftChange={setDirty} onClose={cancel} onCreated={(issue) => { completed.current = true; void navigate(repositoryOptions(props.location, { issue: issue.number, issueNew: undefined })); }} />}</div></section><aside className="discussion-sidebar" aria-label="Issue creation guidance"><h3>Writing a useful issue</h3><p>Include what happened, what you expected, and steps to reproduce it.</p><h3>Markdown</h3><p>Use headings, lists, links, and code blocks. Preview your description before posting.</p><details className="metadata-details"><summary>Access and request status</summary><p className="field-help">Repository access and issue-write permission are checked when submitting. A pending request keeps its key in this tab, so you can return to check the outcome without posting twice.</p></details></aside></div>
  </section>;
}

export function Comments(props: Props & { issue: Issue; onDenied: (error: Error) => void }) {
  const { issue, repositoryKey, repositoryId, queryKey } = props;
  const client = useQueryClient();
  const [composing, setComposing] = useState(() => Boolean(readIssueIntent(issueIntentKey(props.userId, repositoryId, issue.id), repositoryId, issue.id, issue.number)));
  const addButton = useRef<HTMLButtonElement>(null);
  const key = [...queryKey, props.pullRequest?'pull':'issue', issue.number, issue.id, 'comments'];
  const query = useInfiniteQuery({ ...privateQuery, queryKey: key, initialPageParam: 1,
    queryFn: ({ pageParam, signal }) => repositoryClient.listIssueComments({ repository: repositoryKey, repositoryId, number: issue.number, issueId: issue.id, pullRequest:props.pullRequest, page: { page: pageParam, limit: 20 } }, { signal, timeoutMs: 8_000 }), getNextPageParam: followingPage });
  useEffect(() => { if (denied(query.error)) props.onDenied(query.error!); }, [query.error, props.onDenied]);
  const comments = query.isSuccess && (!query.isFetching || query.isFetchingNextPage) ? [...new Map(query.data.pages.flatMap((page) => page.comments).map((comment) => [comment.id, comment])).values()] : [];
  const refresh = () => { void client.resetQueries({ queryKey: key, exact: true }); };
  return <section className="browser-panel issue-comments" aria-labelledby="comments-title"><div className="browser-panel-heading"><h2 id="comments-title">Comments</h2><button className="icon-button manual-refresh" aria-label="Refresh comments" disabled={query.isFetching} onClick={refresh}><RefreshCw size={16} /></button></div>
    {query.isError ? <PanelError error={query.error} retry={refresh} /> : query.isPending || query.isFetching && !query.isFetchingNextPage ? <Loading label="Loading comments…" /> : <>
      {comments.length ? <ol className="issue-comment-list">{comments.map((comment) => <li key={comment.id}><Comment comment={comment} controls={<><RuntimeFeature id="discussion.activity"><DiscussionEngagement {...props} commentId={comment.id}/></RuntimeFeature><RuntimeFeature id="discussion.comments"><CommentResourceControls {...props} comment={comment} refresh={refresh}/></RuntimeFeature></>} /></li>)}</ol> : <div className="empty-state"><MessageSquare size={24} /><h3>No comments in the loaded pages.</h3>{query.hasNextPage ? <p>More repository pages may contain comments for this issue.</p> : <p>No visible comments were returned for this issue.</p>}</div>}
      <div className="list-footer"><span>{comments.length} loaded comments</span><More hasMore={query.hasNextPage} loading={query.isFetching} load={() => void query.fetchNextPage()} label="comments" /></div><p className="panel-footnote">Each page reads one repository-wide provider page, filtered to this issue. An empty page can still have a next page.</p>
    </>}
    {!query.isError ? <section className="issue-comment-compose" aria-labelledby="comment-compose-title"><h2 id="comment-compose-title">Discussion</h2>{composing ? <><DiscussionComposer {...props} onPosted={() => { void client.invalidateQueries({ queryKey: key, exact: true }); }} /><button className="button secondary" onClick={() => { setComposing(false); requestAnimationFrame(() => addButton.current?.focus()); }}>Close comment editor</button></> : <button ref={addButton} className="button secondary" onClick={() => setComposing(true)}><Plus size={16} />Add a comment</button>}</section> : null}
  </section>;
}

type EditState = { mode: IssueIntent['editField']; setMode: (mode: IssueIntent['editField']) => void; pending: boolean; setPending: (pending: boolean) => void };
function IssueEditControls(props: Props & { issue: Issue; refresh: () => void } & EditState) {
  const { issue, userId, repositoryId, refresh, mode, setMode, pending, setPending } = props;
  const storageKey = issueIntentKey(userId, repositoryId, issue.id) + ':edit';
  const resumed = readIssueIntent(storageKey, repositoryId, issue.id, issue.number, 'update');
  useEffect(() => { if (resumed) { setMode(resumed.editField); setPending(true); } }, []);
  const trigger = useRef<HTMLButtonElement>(null);
  const done = () => { setMode(undefined); setPending(false); refresh(); requestAnimationFrame(() => trigger.current?.focus()); };
  return <section className="issue-edit-controls" aria-label="Issue actions">
    <div className="row-actions">{pending && !mode ? <button ref={trigger} className="button secondary" onClick={() => setMode(readIssueIntent(storageKey, repositoryId, issue.id, issue.number, 'update')?.editField)}>Resume issue change</button> : <>
      <button ref={trigger} className="icon-button" aria-label="Edit issue title" title="Edit issue title" disabled={Boolean(mode) || pending || !issue.revision} onClick={() => setMode('title')}><Pencil size={16}/></button>
      <button className="icon-button" aria-label="Edit issue description" title="Edit issue description" disabled={Boolean(mode) || pending || !issue.revision} onClick={() => setMode('body')}><FilePenLine size={16}/></button>
      <button className="button secondary" disabled={Boolean(mode) || pending || !issue.revision} onClick={() => setMode(issue.state === IssueState.CLOSED ? 'reopen' : 'close')}>{issue.state === IssueState.CLOSED ? <Undo2 size={16}/> : <CircleCheck size={16}/>} {issue.state === IssueState.CLOSED ? 'Reopen issue' : 'Close issue'}</button>
    </>}</div>
    {mode && mode !== 'milestone' && mode !== 'labels' && mode !== 'assignees' ? <section className="browser-panel issue-edit-panel" aria-label={mode === 'title' ? 'Edit issue title' : mode === 'body' ? 'Edit issue description' : 'Confirm issue state'}><div className="browser-panel-heading"><h2>{mode === 'title' ? 'Edit title' : mode === 'body' ? 'Edit description' : mode === 'close' ? 'Close issue' : 'Reopen issue'}</h2></div><div className="issue-edit-content"><DiscussionComposer key={`${issue.id}:${mode}`} {...props} editField={mode} onPending={setPending} onUpdated={done} onClose={() => { setMode(undefined); requestAnimationFrame(() => trigger.current?.focus()); }}/></div></section> : null}
    {!issue.revision ? <p className="field-help">Editing is unavailable because the native issue revision could not be verified.</p> : null}
  </section>;
}

export function IssueMetadataControls(props: Props & EditState & { issue?: Issue; proposal?: PullRequest; refresh: () => void; onDenied: (error: Error) => void }) {
  const { repositoryKey, repositoryId, queryKey, mode, setMode, pending, setPending, refresh } = props;
  const issue = (props.proposal || props.issue)!;
  const targetName = props.proposal ? 'pull request' : 'issue';
  const pullRequest = Boolean(props.proposal);
  const trigger = useRef<HTMLButtonElement>(null);
  const query = useInfiniteQuery({ ...privateQuery, queryKey: [...queryKey, 'milestones', repositoryId, pullRequest], initialPageParam: 1, enabled: Boolean(issue.metadata?.milestoneKnown),
    queryFn: ({ pageParam, signal }) => repositoryClient.listRepositoryMilestones({ repository: repositoryKey, repositoryId, pullRequest, state: IssueState.ALL, page: { page: pageParam, limit: 20 } }, { signal, timeoutMs: 8_000 }), getNextPageParam: followingPage });
  useEffect(() => { if (denied(query.error)) props.onDenied(query.error!); }, [query.error, props.onDenied]);
  const native = useRuntimeCapabilities().data?.runtimeProfile === 'cloudflare-native';
  const labelsTrigger = useRef<HTMLButtonElement>(null);
  const labelsQuery = useInfiniteQuery({ ...privateQuery, queryKey: [...queryKey, 'labels', repositoryId, pullRequest], initialPageParam: 1, enabled: Boolean(issue.metadata?.labelsKnown),
    queryFn: ({ pageParam, signal }) => repositoryClient.listRepositoryLabels({ repository: repositoryKey, repositoryId, pullRequest, includeOrganizationLabels:!native, page: { page: pageParam, limit: 20 } }, { signal, timeoutMs: 8_000 }), getNextPageParam: followingPage });
  useEffect(() => { if (denied(labelsQuery.error)) props.onDenied(labelsQuery.error!); }, [labelsQuery.error, props.onDenied]);
  const assigneesTrigger = useRef<HTMLButtonElement>(null);
  const assigneesQuery = useQuery({ ...privateQuery, queryKey: [...queryKey, 'assignees', repositoryId, pullRequest], enabled: Boolean(issue.metadata?.assigneesKnown),
    queryFn: async ({ signal }) => {
      const response = await repositoryClient.listRepositoryAssignees({ repository: repositoryKey, repositoryId, pullRequest }, { signal, timeoutMs: 8_000 });
      if (response.assignees.length > 1000 || response.assignees.some(row => !assigneeId(row.id) || !row.login) || new Set(response.assignees.map(row => row.id)).size !== response.assignees.length || new Set(response.assignees.map(row => row.login.toLowerCase())).size !== response.assignees.length) throw new ConnectError('The repository assignee inventory could not be verified.', Code.Internal);
      return response;
    } });
  useEffect(() => { if (denied(assigneesQuery.error)) props.onDenied(assigneesQuery.error!); }, [assigneesQuery.error, props.onDenied]);
  const assigneesReady = Boolean(issue.metadata?.assigneesKnown) && validAssigneeIds(issue.metadata!.assignees.map(row => row.id)) && assigneesQuery.isSuccess && !assigneesQuery.isFetching && assigneesQuery.data.canEditAssignees;
  const assigneeChoices = assigneesQuery.isSuccess && !assigneesQuery.isFetching ? assigneesQuery.data.assignees : [];
  const labelsReady = Boolean(issue.metadata?.labelsKnown) && labelsQuery.isSuccess && !labelsQuery.isFetching && labelsQuery.data.pages.every(page => page.canEditLabels);
  const labelChoices = issue.metadata?.labelsKnown && labelsQuery.isSuccess && !labelsQuery.isFetching ? [...new Map([...issue.metadata?.labels || [], ...labelsQuery.data.pages.flatMap(page => page.labels)].map(row => [row.id, row])).values()] : [];
  const ready = Boolean(issue.metadata?.milestoneKnown) && query.isSuccess && !query.isFetching && query.data.pages.every(page => page.canEditMilestone);
  const choices = issue.metadata?.milestoneKnown && query.isSuccess && !query.isFetching ? [...new Map(query.data.pages.flatMap(page => page.milestones).map(row => [row.id, row])).values()] : [];
  // Label suggestions open the same editor with Clef's labels selected; the person reviews and saves.
  const [suggestedLabelIds, setSuggestedLabelIds] = useState<string[]>();
  const close = () => { const button = mode === 'labels' ? labelsTrigger : mode === 'assignees' ? assigneesTrigger : trigger; setMode(undefined); setSuggestedLabelIds(undefined); requestAnimationFrame(() => button.current?.focus()); };
  const done = () => { setPending(false); close(); refresh(); };
  return <>
    <DiscussionMetadata metadata={issue.metadata} assigneesAction={assigneesReady && issue.revision ? <button ref={assigneesTrigger} className="icon-button" aria-label={`Edit ${targetName} assignees`} title="Edit assignees" disabled={Boolean(mode) || pending} onClick={() => setMode('assignees')}><Pencil size={14}/></button> : null} labelsAction={labelsReady && issue.revision ? <button ref={labelsTrigger} className="icon-button" aria-label={`Edit ${targetName} labels`} title="Edit labels" disabled={Boolean(mode) || pending} onClick={() => { setSuggestedLabelIds(undefined); setMode('labels'); }}><Pencil size={14}/></button> : null} milestoneAction={ready && issue.revision ? <button ref={trigger} className="icon-button" aria-label={`Edit ${targetName} milestone`} title="Edit milestone" disabled={Boolean(mode) || pending} onClick={() => setMode('milestone')}><Pencil size={14}/></button> : null}/>
    {native && !props.proposal && labelsReady && issue.revision && mode !== 'labels' ? <RuntimeFeature id="discussion.ai-triage"><IssueLabelSuggestions context={{ repository: { owner: repositoryKey.owner, name: repositoryKey.name }, repositoryId }} userId={props.userId} number={issue.number} labelChoices={labelChoices} busy={Boolean(mode) || pending} onApply={ids => { setSuggestedLabelIds(ids); setMode('labels'); }}/></RuntimeFeature> : null}
    {query.isError && mode !== 'milestone' && !denied(query.error) ? <PanelError error={query.error} retry={() => void query.refetch()}/> : null}
    {labelsQuery.isError && mode !== 'labels' && !denied(labelsQuery.error) ? <PanelError error={labelsQuery.error} retry={() => void labelsQuery.refetch()}/> : null}
    {assigneesQuery.isError && mode !== 'assignees' && !denied(assigneesQuery.error) ? <PanelError error={assigneesQuery.error} retry={() => void assigneesQuery.refetch()}/> : null}
    {mode === 'assignees' ? <section className="discussion-metadata-editor" aria-label={`Edit ${targetName} assignees`}>
      {assigneesQuery.isError ? <PanelError error={assigneesQuery.error} retry={() => void assigneesQuery.refetch()}/> : assigneesQuery.isFetching ? <Loading label="Checking assignee access…"/> : null}
      {!assigneesReady && !assigneesQuery.isFetching && !assigneesQuery.isError ? <p className="field-help">{!issue.metadata?.assigneesKnown ? 'Current issue assignees could not be verified. Refresh the issue before editing.' : 'Verified current assignees and discussion write access are required to change assignees.'}</p> : null}
      <DiscussionComposer {...props} editField="assignees" assigneeChoices={assigneeChoices} assigneesReady={assigneesReady} onPending={setPending} onUpdated={done} onPullUpdated={done} onClose={close}/>
    </section> : null}
    {mode === 'labels' ? <section className="discussion-metadata-editor" aria-label={`Edit ${targetName} labels`}>
      {labelsQuery.isError ? <PanelError error={labelsQuery.error} retry={() => void labelsQuery.refetch()}/> : labelsQuery.isFetching ? <Loading label="Checking label access…"/> : null}
      {labelsQuery.isSuccess && !labelsQuery.isFetching && !labelsReady ? <p className="field-help">{!issue.metadata?.labelsKnown ? 'Current issue labels could not be verified. Refresh the issue before editing.' : 'Discussion write access is required to change labels.'}</p> : null}
      <DiscussionComposer {...props} editField="labels" labelChoices={labelChoices} labelsReady={labelsReady} suggestedLabelIds={suggestedLabelIds} onPending={setPending} onUpdated={done} onPullUpdated={done} onClose={close}/>
      {labelsQuery.hasNextPage ? <More hasMore loading={labelsQuery.isFetching} load={() => void labelsQuery.fetchNextPage()} label="labels"/> : null}
    </section> : null}
    {mode === 'milestone' ? <section className="discussion-metadata-editor" aria-label={`Edit ${targetName} milestone`}>
      {query.isError ? <PanelError error={query.error} retry={() => void query.refetch()}/> : query.isFetching ? <Loading label="Checking milestone access…"/> : null}
      {query.isSuccess && !query.isFetching && !ready ? <p className="field-help">{!issue.metadata?.milestoneKnown ? 'Current issue milestone could not be verified. Refresh the issue before editing.' : 'Discussion write access is required to change milestones.'}</p> : null}
      <DiscussionComposer {...props} editField="milestone" milestoneChoices={choices} milestoneReady={ready} onPending={setPending} onUpdated={done} onPullUpdated={done} onClose={close}/>
      {query.hasNextPage ? <More hasMore loading={query.isFetching} load={() => void query.fetchNextPage()} label="milestones"/> : null}
    </section> : null}
  </>;
}

function IssueDetail(props: Props) {
  const { repositoryKey, queryKey, location } = props;
  const client = useQueryClient();
  const [discussionError, setDiscussionError] = useState<Error | null>(null);
  const [mode, setMode] = useState<IssueIntent['editField']>();
  const [pending, setPending] = useState(false);
  const query = useQuery({ ...privateQuery, queryKey: [...queryKey, 'issue', location.issue], queryFn: ({ signal }) => repositoryClient.getIssue({ repository: repositoryKey, number: location.issue }, { signal }).then((response) => { if (!response.issue) throw new ConnectError('The issue response is missing its metadata.', Code.Internal); return response.issue; }) });
  const error = query.error ?? discussionError;
  const issue = !error && query.isSuccess ? query.data : undefined;
  const external = issue && repositoryLink(issue.htmlUrl);
  const observedIssueId = useRef<string | undefined>(undefined);
  const scopedMode = observedIssueId.current === issue?.id ? mode : undefined;
  const scopedPending = observedIssueId.current === issue?.id && pending;
  useEffect(() => { if (!issue) return; if (observedIssueId.current && observedIssueId.current !== issue.id) { setMode(undefined); setPending(false); } observedIssueId.current = issue.id; }, [issue?.id]);
  return <>
    {error ? <PanelError error={error} retry={() => { setDiscussionError(null); void query.refetch(); }}/> : !issue ? <Loading label="Loading issue…"/> : <>
      {query.isFetching ? <Loading label="Checking issue access…"/> : null}
      <div hidden={query.isFetching}>
        <section className="discussion-summary issue-detail" aria-labelledby="issue-detail-title"><div className="discussion-navigation"><Link className="text-button" {...repositoryOptions(location,{issue:undefined})}><ArrowLeft size={15}/>All {location.state==='all'?'':location.state} issues</Link><button className="icon-button manual-refresh" aria-label="Refresh issue" disabled={query.isFetching} onClick={()=>{setDiscussionError(null);refreshDiscussionMetadata(client,queryKey);void query.refetch();}}><RefreshCw size={16}/></button></div><h2 id="issue-detail-title">{issue.title} <span className="muted">#{issue.number}</span></h2><div className="discussion-summary-meta"><IssueStateBadge state={issue.state}/><p>{issue.user?.login||'Unknown author'} opened this issue on <DateLabel value={issue.createdAt}/></p></div></section>
        <IssueEditControls key={issue.id} {...props} issue={issue} mode={scopedMode} setMode={setMode} pending={scopedPending} setPending={setPending} refresh={() => { void query.refetch(); void client.invalidateQueries({ queryKey: [...queryKey, 'issues'] }); }} />
        <div className="discussion-layout issue-discussion-layout"><div className="discussion-main"><section className="browser-panel discussion-description" aria-label="Issue description"><div className="browser-panel-heading"><strong>{issue.user?.login||'Unknown author'}</strong><span className="muted">opened <DateLabel value={issue.createdAt}/></span></div><MarkdownBody text={issue.body||'No description provided.'} label="Issue body, rendered Markdown"/><RuntimeFeature id="discussion.activity"><DiscussionEngagement {...props} issue={issue} onDenied={setDiscussionError}/></RuntimeFeature>{external?<div className="issue-footer"><span>Updated <DateLabel value={issue.updatedAt}/></span><a className="text-button" href={external} target="_blank" rel="noopener noreferrer">Open original<ExternalLink size={14}/></a></div>:null}</section><NativeAgentTasks context={{ repository: repositoryKey, repositoryId: props.repositoryId }} userId={props.userId} target={{ kind: 'issue', number: issue.number, title: issue.title }}/><RuntimeFeature id="discussion.activity"><DiscussionTimeline {...props} issue={issue} onDenied={setDiscussionError}/></RuntimeFeature><Comments key={issue.id} {...props} issue={issue} onDenied={setDiscussionError}/></div><aside className="discussion-sidebar" aria-label="Issue metadata"><RuntimeFeature id="discussion.resources"><IssueMetadataControls key={issue.id} {...props} issue={issue} mode={scopedMode} setMode={setMode} pending={scopedPending} setPending={setPending} onDenied={setDiscussionError} refresh={() => { void query.refetch(); void client.invalidateQueries({ queryKey: [...queryKey, 'issues'] }); }}/></RuntimeFeature><h3>Discussion</h3><p>{issue.comments} comments at last issue refresh</p><p className="field-help">Updated <DateLabel value={issue.updatedAt}/></p></aside></div>
      </div>
    </>}
  </>;
}

function IssueList(props: Props) {
  const { repositoryKey, repositoryId, queryKey, location, userId } = props;
  const navigate = useNavigate();
  const pending = Boolean(readIssueIntent(issueIntentKey(userId, repositoryId), repositoryId));
  const query = useInfiniteQuery({ ...privateQuery, queryKey: [...queryKey, 'issues', location.state, discussionQuery(location)], initialPageParam: 1,
    queryFn: ({ pageParam, signal }) => repositoryClient.listIssues({ repository: repositoryKey, query: discussionQuery(location), state: location.state === 'open' ? IssueState.OPEN : location.state === 'closed' ? IssueState.CLOSED : IssueState.ALL, page: { page: pageParam } }, { signal }), getNextPageParam: followingPage });
  const issues = query.isSuccess && (!query.isFetching || query.isFetchingNextPage) ? [...new Map(query.data.pages.flatMap((page) => page.issues).map((issue) => [issue.id, issue])).values()] : [];
  const list = useRepositoryWorkList(issues, true);
  return <><RuntimeFeature id="discussion.resources"><DiscussionResourceManagement {...props}/></RuntimeFeature><section className="browser-panel repository-work-list" aria-labelledby="issues-title"><div className="browser-panel-heading issue-list-heading"><h2 id="issues-title">Issues</h2><div className="panel-actions"><select aria-label="Issue state" value={location.state} onChange={(event) => void navigate(repositoryOptions(location, { state: event.target.value as RepositoryLocation['state'], issue: undefined }))}><option value="open">Open</option><option value="closed">Closed</option><option value="all">All states</option></select><button className="icon-button manual-refresh" aria-label="Refresh issues" disabled={query.isFetching} onClick={() => void query.refetch()}><RefreshCw size={16} /></button><button className="button primary" disabled={query.isError || query.isFetching} onClick={() => void navigate(repositoryOptions(location, { issue: undefined, issueNew: true }))}><Plus size={15} />{pending ? 'Resume issue request' : 'New issue'}</button></div></div>
    <DiscussionListControls key={JSON.stringify(discussionQuery(location))} location={location} label="issues"/><RepositoryListControls label="issues" {...list.controls}/><details className="metadata-details panel-disclosure"><summary>Search scope and permissions</summary><p className="panel-footnote">Repository search and filters run on the server. The loaded-results controls apply only to fetched pages. Reading requires issue-read permission; creating and posting require issue-write permission. Pull requests are listed separately.</p></details>
    {query.isError ? <PanelError error={query.error} retry={() => void query.refetch()} /> : query.isPending || query.isFetching && !query.isFetchingNextPage ? <Loading label="Loading issues…" /> : <><ul className="issue-list">{list.rows.map((issue) => <li key={issue.id}><IssueStateIcon state={issue.state} size={19}/><div><h3><Link {...repositoryOptions(location, { issue: issue.number })}>{issue.title}</Link></h3><p>#{issue.number} opened by {issue.user?.login || 'Unknown author'} on <DateLabel value={issue.createdAt} /></p></div><div className="work-row-meta"><IssueStateBadge state={issue.state} /><span className="comment-count" title={`${issue.comments} comments`}><MessageSquare size={15} aria-hidden="true"/><span>{issue.comments}</span></span></div></li>)}</ul>{!list.rows.length ? <div className="empty-state"><CircleDot size={25} /><h3>No {location.state === 'all' ? '' : `${location.state} `}issues.</h3><p>{list.controls.search ? 'No loaded issues match your search.' : 'There are no issues matching this state.'}</p></div> : null}<div className="list-footer"><span>{issues.length} loaded issues{query.hasNextPage ? ' · More available' : ''}</span><More hasMore={query.hasNextPage} loading={query.isFetching} load={() => void query.fetchNextPage()} label="issues" /></div></>}
  </section></>;
}

export function IssueBrowser(props: Props) { return props.location.issueNew ? <NewIssue key={props.repositoryId} {...props} /> : props.location.issue ? <IssueDetail key={props.location.issue} {...props} /> : <IssueList {...props} />; }
