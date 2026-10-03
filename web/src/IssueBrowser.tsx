import { RepositoryListControls, useRepositoryWorkList } from './RepositoryListControls';
import { MarkdownBody } from './RepositoryContent';
import { useEffect, useRef, useState } from 'react';
import { useForm, useStore } from '@tanstack/react-form';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Code, ConnectError } from '@connectrpc/connect';
import { Link, useNavigate } from '@tanstack/react-router';
import { ArrowLeft, CircleDot, ExternalLink, LoaderCircle, MessageSquare, Plus, RefreshCw, X } from 'lucide-react';
import { repositoryClient, repositoryLink, errorMessage } from './api';
import { IssueMutationKind, IssueMutationState, IssueState } from './gen/golf/v1/golf_pb';
import type { CreateIssueCommentRequest, CreateIssueRequest, GetIssueMutationResponse, Issue, IssueComment, IssueMutation, PageResponse, RepositoryKey, User } from './gen/golf/v1/golf_pb';
import { repositoryOptions } from './navigation';
import type { RepositoryLocation } from './navigation';
import { DateLabel, Loading, More, PanelError, privateQuery } from './RepositoryUI';
import { issueIntentKey, readIssueIntent } from './issueIntents';
import type { IssueIntent } from './issueIntents';

type Props = { repositoryKey: Pick<RepositoryKey, 'owner' | 'name'>; repositoryId: string; queryKey: readonly unknown[]; location: RepositoryLocation; userId: string; pullRequest?: boolean };
type Observation = Pick<GetIssueMutationResponse, 'mutation' | 'issue' | 'comment'>;
const followingPage = (response: { page?: PageResponse }, _pages: unknown[], current: number) => {
  const next = response.page?.nextPage ?? 0;
  return next > current && next <= 10_000 ? next : undefined;
};
const denied = (error: unknown) => error instanceof ConnectError && [Code.PermissionDenied, Code.NotFound, Code.Unauthenticated].includes(error.code);

function IssueStateBadge({ state }: { state: IssueState }) {
  return <span className={`issue-state ${state === IssueState.CLOSED ? 'closed' : ''}`}><CircleDot size={13} />{state === IssueState.OPEN ? 'open' : state === IssueState.CLOSED ? 'closed' : 'unknown'}</span>;
}
function Comment({ comment }: { comment: IssueComment }) {
  const external = repositoryLink(comment.htmlUrl);
  return <article className="issue-comment"><div className="issue-comment-heading"><h3>{comment.user?.login || 'Deleted or unavailable author'}</h3><span>Comment <code>{comment.id}</code></span></div><p className="muted">Posted <DateLabel value={comment.createdAt} /> · Updated <DateLabel value={comment.updatedAt} /></p><MarkdownBody text={comment.body || 'No comment text provided.'} label={`Comment ${comment.id}, rendered Markdown`}/>{external ? <a className="text-button" href={external} target="_blank" rel="noopener noreferrer">Open original comment<ExternalLink size={14} /></a> : null}</article>;
}

function Composer({ repositoryKey, repositoryId, queryKey, userId, pullRequest, issue, onCreated, onPending, onPosted }: Props & { issue?: Issue; onCreated?: (issue: Issue) => void; onPending?: (value: boolean) => void; onPosted?: () => void }) {
  const kind = issue ? 'comment' : 'issue';
  const storageKey = issueIntentKey(userId, repositoryId, issue?.id);
  const [intent, setIntent] = useState(() => readIssueIntent(storageKey, repositoryId, issue?.id, issue?.number));
  const form = useForm({ defaultValues: { title: '', body: '' }, onSubmit: () => submit() });
  const { title, body } = useStore(form.store, (state) => state.values);
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
  const firstInput = useRef<HTMLInputElement | HTMLTextAreaElement | null>(null);
  const statusButton = useRef<HTMLButtonElement>(null);
  const client = useQueryClient();
  const active = () => mounted.current && client.getQueryData<User | null>(['session'])?.id === userId;
  async function observe(response: Observation, pending: IssueIntent) {
    if (!active()) return;
    const value = response.mutation;
    if (!value || value.idempotencyKey !== pending.key || value.repositoryId !== repositoryId || value.repository?.owner !== repositoryKey.owner || value.repository?.name !== repositoryKey.name ||
      value.kind !== (issue ? IssueMutationKind.CREATE_COMMENT : IssueMutationKind.CREATE_ISSUE) || issue && (value.issueId !== issue.id || value.number !== issue.number)) {
      throw new ConnectError('The outcome record does not match this request. Keep its key and check again.', Code.FailedPrecondition);
    }
    const success = value.state === IssueMutationState.SUCCEEDED;
    if (success && (response.issue && (response.issue.id !== value.issueId || response.issue.number !== value.number) || response.comment && response.comment.id !== value.commentId)) {
      throw new ConnectError('The returned object does not match the recorded outcome. Keep its key and check again.', Code.FailedPrecondition);
    }
    setRecord(value);
    const confirmed = success && (issue ? Boolean(response.comment) : Boolean(response.issue));
    if (!confirmed) return;
    try { sessionStorage.removeItem(storageKey); } catch { /* A later lookup can inspect the same durable outcome. */ }
    onPending?.(false);
    if (issue && response.comment) { setPosted(response.comment); onPosted?.(); }
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
      else if (issue && frozen.current) await observe(await repositoryClient.createIssueComment({ repository: repositoryKey, repositoryId, number: issue.number, issueId: issue.id, body: frozen.current.body, pullRequest, idempotencyKey: pending.key }, options), pending);
      else if (frozen.current && 'title' in frozen.current) await observe(await repositoryClient.createIssue({ repository: repositoryKey, repositoryId, title: frozen.current.title, body: frozen.current.body, idempotencyKey: pending.key }, options), pending);
      else throw new ConnectError('This resumed request supports status inspection only.', Code.FailedPrecondition);
    },
    onError: (failure) => {
      if (!active()) return;
      setRecord(null); setPosted(null); setError(failure);
      if (denied(failure)) { setTitle(''); setBody(''); frozen.current = null; }
    },
    onSettled: () => { latch.current = false; controller.current = null; },
  });
  useEffect(() => {
    mounted.current = true;
    if (intent) statusButton.current?.focus(); else firstInput.current?.focus();
    return () => { mounted.current = false; controller.current?.abort(); frozen.current = null; };
  }, []);
  function submit() {
    if (latch.current || intent) return;
    const exactTitle = title.trim();
    const titleBytes = new TextEncoder().encode(exactTitle);
    const bodyBytes = new TextEncoder().encode(body);
    if (!issue && (!exactTitle || titleBytes.byteLength > 255 || new TextDecoder().decode(titleBytes) !== exactTitle || /\p{Cc}/u.test(exactTitle))) {
      setError(new Error('Use a title of 1–255 UTF-8 bytes without control characters. No request was sent.')); return;
    }
    if (bodyBytes.byteLength > 6000 || new TextDecoder().decode(bodyBytes) !== body || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u.test(body) || issue && !body.trim()) {
      setError(new Error(`Use ${issue ? 'nonempty ' : ''}valid text up to 6,000 UTF-8 bytes. Only tabs and line breaks are allowed as control characters. No request was sent.`)); return;
    }
    try {
      const pending: IssueIntent = { key: crypto.randomUUID(), kind, repositoryId, issueId: issue?.id || '', number: issue?.number || 0 };
      sessionStorage.setItem(storageKey, JSON.stringify(pending));
      frozen.current = issue ? { body } : { title: exactTitle, body };
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
    frozen.current = null; setIntent(null); setRecord(null); setPosted(null); setError(null); action.reset(); onPending?.(false);
    if (posted) setBody('');
    requestAnimationFrame(() => firstInput.current?.focus());
  }
  const rejected = record?.state === IssueMutationState.REJECTED;
  const succeeded = record?.state === IssueMutationState.SUCCEEDED;
  return <div className="issue-composer">
    <p className="field-help">Creating issues and posting comments requires issue-write permission. If your connected account has read-only access, ask your administrator to update it.</p>
    {posted ? <><p className="session-notice" role="status">Comment posted.</p><Comment comment={posted} /><button className="button secondary" onClick={nextIntent}>Write another comment</button></> : <form onSubmit={(event) => { event.preventDefault(); void form.handleSubmit(); }}>
      {!issue ? <><label htmlFor="issue-title-input">Issue title</label><input ref={(element) => { firstInput.current = element; }} id="issue-title-input" value={title} onChange={(event) => setTitle(event.target.value)} required maxLength={255} disabled={Boolean(intent)} autoComplete="off" /></> : null}
      <label htmlFor={issue ? 'issue-comment-input' : 'issue-body-input'}>{issue ? 'Comment, plain text' : 'Description, plain text'}</label><textarea ref={issue ? (element) => { firstInput.current = element; } : undefined} id={issue ? 'issue-comment-input' : 'issue-body-input'} value={body} onChange={(event) => setBody(event.target.value)} required={Boolean(issue)} rows={issue ? 5 : 7} maxLength={6000} disabled={Boolean(intent)} autoComplete="off" />
      <button type="button" className="text-button" aria-pressed={preview} onClick={()=>setPreview(!preview)}>{preview?'Hide preview':'Preview Markdown'}</button>{preview?<MarkdownBody text={body||'Nothing to preview.'} label="Draft Markdown preview"/>:null}<p className="field-help">Markdown is rendered safely; HTML stays text. Maximum 6,000 UTF-8 bytes.</p>
      {intent ? <div className="creation-status" role="status"><p>{action.isPending ? 'Checking this request… Its outcome may still be unknown.' : rejected ? record.failureCode === 'target_changed' ? 'The target changed before this write was sent. Refresh repository access and inspect the issue before explicitly starting a new request.' : 'The request was rejected. You can explicitly start a new request.' : succeeded ? 'The write was recorded as successful, but Golf cannot confirm current access to its result. This record does not grant access.' : 'This request may still be running, or its outcome is unknown. Check its status; do not repost the text as a new request.'}</p><p className="field-help">Request key <code>{intent.key}</code></p>{!frozen.current ? <p className="field-help">Draft text was not stored. This resumed request supports status checks only.</p> : null}<p className="field-help">Closing or leaving does not cancel provider work. This tab saves only the key and target IDs until sign-out.</p></div> : null}
      {error ? <p className="error" role="alert">{errorMessage(error)}</p> : null}
      <div className="credential-actions">{intent ? <><button ref={statusButton} type="button" className="button secondary" disabled={action.isPending} onClick={inspect}><RefreshCw size={15} />Check request status</button>{rejected ? <button type="button" className="button primary" onClick={nextIntent}>Start a new request</button> : null}</> : <button className="button primary" disabled={issue ? !body.trim() : !title.trim()}>{action.isPending ? <LoaderCircle className="spin" size={16} /> : <Plus size={16} />}{issue ? 'Post comment' : 'Create issue'}</button>}</div>
    </form>}
  </div>;
}

function NewIssue({ onClose, ...props }: Props & { onClose: () => void; onPending: (value: boolean) => void; onCreated: (issue: Issue) => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const focus = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (!focus.current && document.activeElement instanceof HTMLElement) focus.current = document.activeElement;
    if (dialog.current && !dialog.current.open) dialog.current.showModal();
    return () => { if (focus.current?.isConnected) focus.current.focus(); };
  }, []);
  return <dialog ref={dialog} className="create-dialog new-issue-dialog" aria-labelledby="new-issue-title" onClose={onClose}><div className="dialog-header"><span className="small-icon"><CircleDot size={21} /></span><button className="icon-button" aria-label="Close new issue" onClick={onClose}><X size={19} /></button></div><h2 id="new-issue-title">New issue</h2><Composer {...props} /><div className="dialog-actions"><button className="button secondary" onClick={onClose}>Close</button></div></dialog>;
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
      {comments.length ? <ol className="issue-comment-list">{comments.map((comment) => <li key={comment.id}><Comment comment={comment} /></li>)}</ol> : <div className="empty-state"><MessageSquare size={24} /><h3>No comments in the loaded pages.</h3>{query.hasNextPage ? <p>More repository pages may contain comments for this issue.</p> : <p>No visible comments were returned for this issue.</p>}</div>}
      <div className="list-footer"><span>{comments.length} loaded comments</span><More hasMore={query.hasNextPage} loading={query.isFetching} load={() => void query.fetchNextPage()} label="comments" /></div><p className="panel-footnote">Each page reads one repository-wide provider page, filtered to this issue. An empty page can still have a next page.</p>
    </>}
    {!query.isError ? <section className="issue-comment-compose" aria-labelledby="comment-compose-title"><h2 id="comment-compose-title">Discussion</h2>{composing ? <><Composer {...props} onPosted={() => { void client.invalidateQueries({ queryKey: key, exact: true }); }} /><button className="button secondary" onClick={() => { setComposing(false); requestAnimationFrame(() => addButton.current?.focus()); }}>Close comment editor</button></> : <button ref={addButton} className="button secondary" onClick={() => setComposing(true)}><Plus size={16} />Add a comment</button>}</section> : null}
  </section>;
}

function IssueDetail(props: Props) {
  const { repositoryKey, queryKey, location } = props;
  const [discussionError, setDiscussionError] = useState<Error | null>(null);
  const query = useQuery({ ...privateQuery, queryKey: [...queryKey, 'issue', location.issue], queryFn: ({ signal }) => repositoryClient.getIssue({ repository: repositoryKey, number: location.issue }, { signal }).then((response) => { if (!response.issue) throw new ConnectError('The issue response is missing its metadata.', Code.Internal); return response.issue; }) });
  const error = query.error ?? discussionError;
  const issue = !error && query.isSuccess ? query.data : undefined;
  const external = issue && repositoryLink(issue.htmlUrl);
  return <>
    {error ? <PanelError error={error} retry={() => { setDiscussionError(null); void query.refetch(); }}/> : !issue ? <Loading label="Loading issue…"/> : <>
      {query.isFetching ? <Loading label="Checking issue access…"/> : null}
      <div hidden={query.isFetching}>
        <section className="discussion-summary issue-detail" aria-labelledby="issue-detail-title"><div className="discussion-navigation"><Link className="text-button" {...repositoryOptions(location,{issue:undefined})}><ArrowLeft size={15}/>All {location.state==='all'?'':location.state} issues</Link><button className="icon-button manual-refresh" aria-label="Refresh issue" disabled={query.isFetching} onClick={()=>{setDiscussionError(null);void query.refetch();}}><RefreshCw size={16}/></button></div><h2 id="issue-detail-title">{issue.title} <span className="muted">#{issue.number}</span></h2><div className="discussion-summary-meta"><IssueStateBadge state={issue.state}/><p>{issue.user?.login||'Unknown author'} opened this issue on <DateLabel value={issue.createdAt}/></p></div></section>
        <div className="discussion-layout issue-discussion-layout"><div className="discussion-main"><section className="browser-panel discussion-description" aria-label="Issue description"><div className="browser-panel-heading"><strong>{issue.user?.login||'Unknown author'}</strong><span className="muted">opened <DateLabel value={issue.createdAt}/></span></div><MarkdownBody text={issue.body||'No description provided.'} label="Issue body, rendered Markdown"/>{external?<div className="issue-footer"><span>Updated <DateLabel value={issue.updatedAt}/></span><a className="text-button" href={external} target="_blank" rel="noopener noreferrer">Open original<ExternalLink size={14}/></a></div>:null}</section><Comments key={issue.id} {...props} issue={issue} onDenied={setDiscussionError}/></div><aside className="discussion-sidebar" aria-label="Issue metadata"><h3>Discussion</h3><p>{issue.comments} comments at last issue refresh</p><p className="field-help">Updated <DateLabel value={issue.updatedAt}/></p><p className="field-help">Use the original issue interface to edit, close or reopen issues.</p></aside></div>
      </div>
    </>}
  </>;
}

function IssueList(props: Props) {
  const { repositoryKey, repositoryId, queryKey, location, userId } = props;
  const navigate = useNavigate();
  const [creating, setCreating] = useState(false);
  const [pending, setPending] = useState(() => Boolean(readIssueIntent(issueIntentKey(userId, repositoryId), repositoryId)));
  const query = useInfiniteQuery({ ...privateQuery, queryKey: [...queryKey, 'issues', location.state], initialPageParam: 1,
    queryFn: ({ pageParam, signal }) => repositoryClient.listIssues({ repository: repositoryKey, state: location.state === 'open' ? IssueState.OPEN : location.state === 'closed' ? IssueState.CLOSED : IssueState.ALL, page: { page: pageParam } }, { signal }), getNextPageParam: followingPage });
  const issues = query.isSuccess && (!query.isFetching || query.isFetchingNextPage) ? [...new Map(query.data.pages.flatMap((page) => page.issues).map((issue) => [issue.id, issue])).values()] : [];
  const list = useRepositoryWorkList(issues);
  return <><section className="browser-panel repository-work-list" aria-labelledby="issues-title"><div className="browser-panel-heading issue-list-heading"><h2 id="issues-title">Issues</h2><div className="panel-actions"><select aria-label="Issue state" value={location.state} onChange={(event) => void navigate(repositoryOptions(location, { state: event.target.value as RepositoryLocation['state'], issue: undefined }))}><option value="open">Open</option><option value="closed">Closed</option><option value="all">All states</option></select><button className="icon-button manual-refresh" aria-label="Refresh issues" disabled={query.isFetching} onClick={() => void query.refetch()}><RefreshCw size={16} /></button><button className="button primary" disabled={query.isError || query.isFetching} onClick={() => setCreating(true)}><Plus size={15} />{pending ? 'Resume issue request' : 'New issue'}</button></div></div>
    <RepositoryListControls label="issues" {...list.controls}/><details className="metadata-details panel-disclosure"><summary>Search scope and permissions</summary><p className="panel-footnote">Search and sort apply to loaded issues only. Reading requires issue-read permission; creating and posting require issue-write permission. Pull requests are listed separately.</p></details>
    {query.isError ? <PanelError error={query.error} retry={() => void query.refetch()} /> : query.isPending || query.isFetching && !query.isFetchingNextPage ? <Loading label="Loading issues…" /> : <><ul className="issue-list">{list.rows.map((issue) => <li key={issue.id}><CircleDot size={19} /><div><h3><Link {...repositoryOptions(location, { issue: issue.number })}>{issue.title}</Link></h3><p>#{issue.number} opened by {issue.user?.login || 'Unknown author'} on <DateLabel value={issue.createdAt} /></p></div><div className="work-row-meta"><IssueStateBadge state={issue.state} /><span className="comment-count" title={`${issue.comments} comments`}><MessageSquare size={15} aria-hidden="true"/><span>{issue.comments}</span></span></div></li>)}</ul>{!list.rows.length ? <div className="empty-state"><CircleDot size={25} /><h3>No {location.state === 'all' ? '' : `${location.state} `}issues.</h3><p>{list.controls.search ? 'No loaded issues match your search.' : 'There are no issues matching this state.'}</p></div> : null}<div className="list-footer"><span>{issues.length} loaded issues{query.hasNextPage ? ' · More available' : ''}</span><More hasMore={query.hasNextPage} loading={query.isFetching} load={() => void query.fetchNextPage()} label="issues" /></div></>}
  </section>{creating && !query.isError ? <NewIssue {...props} onPending={setPending} onClose={() => setCreating(false)} onCreated={(issue) => { setCreating(false); void navigate(repositoryOptions(location, { issue: issue.number })); }} /> : null}</>;
}

export function IssueBrowser(props: Props) { return props.location.issue ? <IssueDetail key={props.location.issue} {...props} /> : <IssueList {...props} />; }
