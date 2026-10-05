import type {PullRequestMergeObservation} from './gen/golf/v1/golf_pb';
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { PullNativeMerge } from './PullNativeMerge';
import { PullMergeObservation } from './PullMergeObservation';
import { PullReviewDraftWorkspace } from './PullReviewDraft';
import { PullReviewComposer } from './PullReviewComposer';
import { PullReviewComments } from './PullReviewComments';
import { readReviewIntent, reviewIntentKey } from './reviewIntents';
import { PullRequestEditControls } from './PullRequestEditControls';
import { PullCommits, PullChecks } from './PullWorkspace';
import { RepositoryListControls, useRepositoryWorkList } from './RepositoryListControls';
import { MarkdownBody } from './RepositoryContent';
import { DiffViewer } from './DiffViewer';
import { Comments } from './IssueBrowser';
import { ReviewerRuns } from './ReviewerPanel';
import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query';
import { Code, ConnectError } from '@connectrpc/connect';
import { Link, useNavigate } from '@tanstack/react-router';
import { ArrowLeft, ExternalLink, FileDiff, GitCommitHorizontal, ListChecks, GitPullRequest, MessageSquare, FilePenLine, RefreshCw } from 'lucide-react';
import { standardPullMergeClient, pullMergeObservationClient, repositoryClient, repositoryLink } from './api';
import { IssueState, PullRequestReviewState } from './gen/golf/v1/golf_pb';
import type { PageResponse, PullRequest, PullRequestRef, RepositoryKey } from './gen/golf/v1/golf_pb';
import { repositoryOptions } from './navigation';
import type { RepositoryLocation } from './navigation';
import { DateLabel, RepositoryTabs, Loading, More, PanelError, privateQuery, shortSHA } from './RepositoryUI';

type Props = { repositoryKey: Pick<RepositoryKey, 'owner' | 'name'>; queryKey: readonly unknown[]; location: RepositoryLocation; repositoryId:string;userId:string };
const followingPage = (response: { page?: PageResponse }, _pages: unknown[], current: number) => {
  const next = response.page?.nextPage || 0;
  return next > current && next <= 10_000 ? next : undefined;
};
const reviewLabels: Partial<Record<PullRequestReviewState, string>> = {
  [PullRequestReviewState.APPROVED]: 'Approved', [PullRequestReviewState.PENDING]: 'Pending',
  [PullRequestReviewState.COMMENT]: 'Comment', [PullRequestReviewState.REQUEST_CHANGES]: 'Changes requested',
  [PullRequestReviewState.REQUEST_REVIEW]: 'Review requested',
};

function PullState({ pull }: { pull: PullRequest }) {
  return <div className="pull-state"><span className={`issue-state ${pull.merged || pull.state === IssueState.CLOSED ? 'closed' : ''}`}><GitPullRequest size={13} />{pull.merged ? 'Merged' : pull.state === IssueState.OPEN ? 'Open' : pull.state === IssueState.CLOSED ? 'Closed' : 'Unknown state'}</span>{pull.draft ? <span className="visibility">Draft</span> : null}</div>;
}
function RefMetadata({ title, value }: { title: string; value?: PullRequestRef }) {
  return <section className="pull-ref" aria-label={`${title} metadata`}><h3>{title}</h3>{value ? <>
    <p className="pull-ref-label">{value.label || 'Label unavailable'}</p>
    <dl><div><dt>Repository ID</dt><dd><code>{value.repositoryId || 'Unavailable'}</code></dd></div><div><dt>Ref</dt><dd><code>{value.ref || 'Unavailable'}</code></dd></div><div><dt>Commit</dt><dd><code>{value.commitId || 'Unavailable'}</code></dd></div></dl>
    <span className="pull-observation">{value.retainedSnapshot ? 'Retained PR snapshot' : 'Provider observation'}</span>
  </> : <p className="muted">Metadata unavailable.</p>}</section>;
}
function Reviews({ repositoryKey, queryKey, location, onReview, pull, repositoryId, userId, reviewActionLabel='Review changes' }: Props & {onReview:()=>void;pull:PullRequest;reviewActionLabel?:string}) {
  const query = useInfiniteQuery({ ...privateQuery, queryKey: [...queryKey, 'pull', location.pull, 'reviews'], initialPageParam: 1,
    queryFn: ({ pageParam, signal }) => repositoryClient.listPullRequestReviews({ repository: repositoryKey, number: location.pull, page: { page: pageParam, limit: 20 } }, { signal, timeoutMs: 8_000 }), getNextPageParam: followingPage });
  const reviews = query.isSuccess && (!query.isFetching || query.isFetchingNextPage)
    ? [...new Map(query.data.pages.flatMap((page) => page.reviews).map((review) => [review.id, review])).values()] : [];
  return <section className="browser-panel pull-reviews" aria-labelledby="reviews-title">
    <div className="browser-panel-heading"><h2 id="reviews-title">Reviews</h2><div className="panel-actions"><button className="button secondary" data-review-trigger onClick={onReview}>{reviewActionLabel}</button><button className="icon-button manual-refresh" aria-label="Refresh reviews" disabled={query.isFetching} onClick={() => void query.refetch()}><RefreshCw size={16} /></button></div></div>
    <details className="metadata-details panel-disclosure"><summary>About review states</summary><p className="panel-footnote">Native review records do not establish Golf approval eligibility or merge readiness.</p></details>
    {query.isError ? <PanelError error={query.error} retry={() => void query.refetch()} /> : query.isPending || (query.isFetching && !query.isFetchingNextPage) ? <Loading label="Loading reviews…" /> : <>
      {reviews.length ? <ol className="pull-review-list">{reviews.map((review) => {
        const external = repositoryLink(review.htmlUrl);
        return <li key={review.id}><div className="pull-review-heading"><h3>{review.user?.login || 'Deleted or unavailable author'}</h3><div className="review-flags"><span className="visibility">{reviewLabels[review.state] || 'Unknown review state'}</span>{review.stale ? <span className="visibility">Outdated</span> : null}{review.commitId && pull.head?.commitId && review.commitId !== pull.head.commitId ? <span className="visibility">Earlier snapshot</span> : null}{review.dismissed ? <span className="visibility">Dismissed</span> : null}</div></div>
          <p className="muted">{review.state===PullRequestReviewState.PENDING?<>Draft updated <DateLabel value={review.updatedAt}/></>:<>Submitted <DateLabel value={review.submittedAt}/> · Updated <DateLabel value={review.updatedAt}/></>}</p>
          <MarkdownBody text={review.body || 'No review text provided.'} label={`Review ${review.id} body, rendered Markdown`}/>
          <details className="metadata-details"><summary>Review details</summary><dl className="review-metadata"><div><dt>Review ID</dt><dd><code>{review.id}</code></dd></div><div><dt>Reviewed commit</dt><dd><code>{review.commitId || 'Unavailable'}</code></dd></div><div><dt>Marked stale</dt><dd>{review.stale ? 'Yes' : 'No'}</dd></div><div><dt>Dismissed</dt><dd>{review.dismissed ? 'Yes' : 'No'}</dd></div><div><dt>Official</dt><dd>{review.official ? 'Yes' : 'No'}</dd></div></dl></details>
          <PullReviewComments key={`${repositoryId}-${pull.id}-${review.id}-${review.commitId}`} repositoryKey={repositoryKey} repositoryId={repositoryId} userId={userId} queryKey={queryKey} pull={pull} review={review}/>
          {external ? <a className="text-button" href={external} target="_blank" rel="noopener noreferrer">Open original review<ExternalLink size={14} /></a> : null}
        </li>;
      })}</ol> : <div className="empty-state"><GitPullRequest size={24} /><h3>No visible reviews in the loaded pages.</h3>{query.hasNextPage ? <p>More provider pages may contain visible reviews.</p> : null}</div>}
      <div className="list-footer"><span>{reviews.length} loaded reviews{query.hasNextPage ? ' · More available' : ''}</span><More hasMore={query.hasNextPage} loading={query.isFetching} load={() => void query.fetchNextPage()} label="reviews" /></div>
    </>}
  </section>;
}
function PullDiscussion(props:Props){
 const query=useQuery({...privateQuery,queryKey:[...props.queryKey,'pull-discussion',props.location.pull],queryFn:({signal})=>repositoryClient.getPullRequestDiscussion({repository:props.repositoryKey,number:props.location.pull},{signal,timeoutMs:8000})});
 return query.isError?<PanelError error={query.error} retry={()=>void query.refetch()}/>:query.isSuccess&&query.data.issue?<Comments {...props} issue={query.data.issue} pullRequest onDenied={()=>{}}/>:<Loading label="Reading PR discussion…"/>;
}
function PullFiles(props: Props & { pull: PullRequest; onReview:()=>void }) {
  const { pull, repositoryKey, queryKey, location, repositoryId, onReview }=props;
  const [commentsOpen,setCommentsOpen]=useState(false);const [draftOpen,setDraftOpen]=useState(false);const lastDiff=useRef('');const commentsId=useId();
  const base = pull.base?.commitId || '', head = pull.head?.commitId || '', mergeBase = pull.mergeBaseCommitId;
  const query = useQuery({ ...privateQuery, queryKey: [...queryKey, 'pull-diff', repositoryId, pull.id, location.pull, base, mergeBase, head],
    queryFn: async ({signal}) => {
      if(!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(mergeBase) || mergeBase.length !== base.length || mergeBase.length !== head.length) throw new ConnectError('Refresh pull request metadata to select a complete old-side comparison.',Code.FailedPrecondition);
      const result = await repositoryClient.getPullRequestDiff({repository:repositoryKey,repositoryId,pullRequestId:pull.id,number:location.pull,baseCommitId:base,headCommitId:head},{signal,timeoutMs:8000});
      if(result.repositoryId !== repositoryId || result.pullRequestId !== pull.id || result.mergeBaseCommitId !== mergeBase || result.baseCommitId !== base || result.headCommitId !== head) throw new ConnectError('The PR diff does not match the selected comparison.',Code.Internal);
      if(result.byteSize > 512*1024 || new TextEncoder().encode(result.rawDiff).byteLength !== result.byteSize) throw new ConnectError('The PR diff exceeds its supported text bounds.',Code.ResourceExhausted);
      return result;
    }});
  if(query.isSuccess&&!query.isFetching)lastDiff.current=query.data.rawDiff;
  return <section className="browser-panel" aria-label="Pull request diff">
    {query.isError ? <PanelError error={query.error} retry={()=>void query.refetch()}/> : !query.isSuccess || query.isFetching ? <Loading label="Reading changed files…"/> : <>{!draftOpen?<DiffViewer key={`${String(queryKey[1])}-${repositoryId}-${pull.id}-${base}-${mergeBase}-${head}`} text={query.data.rawDiff} snapshotId={`${mergeBase}-${head}`} toolbarAction={<><button type="button" className="icon-button" title={`${commentsOpen?'Hide':'Show'} review comments`} aria-label={`${commentsOpen?'Hide':'Show'} review comments`} aria-expanded={commentsOpen} aria-controls={commentsId} onClick={()=>setCommentsOpen(value=>!value)}><MessageSquare size={16} aria-hidden="true"/></button><button className="icon-button" data-private-draft-trigger aria-label="Private draft" title="Private draft" onClick={()=>setDraftOpen(true)}><FilePenLine size={16} aria-hidden="true"/></button><button className="button primary" data-review-trigger onClick={onReview}>Review changes</button><button className="icon-button manual-refresh" aria-label="Refresh PR diff" disabled={query.isFetching} onClick={()=>void query.refetch()}><RefreshCw size={16}/></button></>}/>:null}<p className="panel-footnote">Old side <code title={mergeBase}>{shortSHA(mergeBase)}</code> · Head <code title={head}>{shortSHA(head)}</code>{base!==mergeBase?<> · Base branch tip <code title={base}>{shortSHA(base)}</code></>:null} · {query.data.byteSize.toLocaleString()} bytes. Viewed markers belong to this browser session and snapshot. This observation does not establish merge readiness.</p><div id={commentsId}>{commentsOpen?<section className="pull-files-comments" aria-label="Files changed comments"><Reviews {...props} reviewActionLabel="Review changes from comments"/><PullDiscussion {...props}/></section>:null}</div></>}
    {draftOpen&&!query.isError?<PullReviewDraftWorkspace key={`${props.userId}-${repositoryId}-${pull.id}`} repository={repositoryKey} repositoryId={repositoryId} userId={props.userId} pull={pull} text={query.isSuccess?query.data.rawDiff:lastDiff.current} blocked={query.isFetching} onClose={()=>{setDraftOpen(false);requestAnimationFrame(()=>document.querySelector<HTMLButtonElement>('[data-private-draft-trigger]')?.focus());}}/>:null}
  </section>;
}
function PullDetail(props: Props) {
  const { repositoryKey, queryKey, location } = props;
  const client=useQueryClient();
  const [reviewing,setReviewing]=useState(false);
  const [reviewGeneration,setReviewGeneration]=useState(0);
  const [dismissedReview,setDismissedReview]=useState(false);
  const reviewTrigger=useRef<HTMLElement|null>(null);
  const openReview=()=>{reviewTrigger.current=document.activeElement as HTMLElement;setDismissedReview(false);setReviewing(true);};
  const closeReview=()=>{setDismissedReview(true);setReviewing(false);requestAnimationFrame(()=>{if(reviewTrigger.current?.isConnected)reviewTrigger.current.focus();else document.querySelector<HTMLButtonElement>('[data-review-trigger]')?.focus();});};
  const mergeScope=JSON.stringify([props.userId,repositoryKey,props.repositoryId,location.pull]);
  const authorityEpoch=useRef(0);
  const currentScope=useRef(mergeScope);
  if(currentScope.current!==mergeScope){authorityEpoch.current++;currentScope.current=mergeScope;}
  useEffect(()=>()=>{authorityEpoch.current++;},[]);
  const [mergeDenial,setMergeDenial]=useState<{scope:string;error:ConnectError}|null>(null);
  const denied=mergeDenial?.scope===mergeScope?mergeDenial.error:undefined;
  const query = useQuery({ ...privateQuery, enabled:!denied, queryKey: [...queryKey, 'pull', location.pull], queryFn: async ({ signal }) => {
    const response = await repositoryClient.getPullRequest({ repository: repositoryKey, number: location.pull }, { signal, timeoutMs: 8_000 });
    if (!response.pullRequest) throw new ConnectError('The pull request response is missing its metadata.', Code.Internal);
    return response.pullRequest;
  } });
  const pull = !denied&&query.isSuccess ? query.data : undefined;
  const refreshPull=()=>{authorityEpoch.current++;setMergeDenial(null);void query.refetch();};
  const [mergeObservation,setMergeObservation]=useState<{scope:string;value:PullRequestMergeObservation|undefined}|null>(null);
  const observeMerge=useCallback((value:PullRequestMergeObservation|undefined)=>setMergeObservation({scope:mergeScope,value}),[mergeScope]);
  const currentMergeObservation=mergeObservation?.scope===mergeScope&&mergeObservation.value?.pullRevision===pull?.revision?mergeObservation.value:undefined;
  const denyMergeObservation=useCallback(async(error:ConnectError,revision:string)=>{
    const key=[...queryKey,'pull',location.pull];
    const matches=()=>currentScope.current===mergeScope&&client.getQueryData<{id:string}>(['session'])?.id===props.userId&&client.getQueryData<PullRequest>(key)?.revision===revision;
    if(!matches())return;
    // Background activity must not silently undo a current authority denial.
    const epoch=++authorityEpoch.current;
    setMergeDenial({scope:mergeScope,error});
    await client.cancelQueries({queryKey:key,exact:true});
    if(authorityEpoch.current!==epoch||!matches())return;
    client.getQueryCache().find({queryKey:key,exact:true})?.setState({data:undefined,error,status:'error',fetchStatus:'idle'});
  },[client,queryKey,location.pull,props.userId,mergeScope]);
  const external = pull && repositoryLink(pull.htmlUrl);
  const resumed = pull && readReviewIntent(reviewIntentKey(props.userId,props.repositoryId,pull.id),props.repositoryId,pull.id,pull.number);
  const reviewOpen=reviewing||Boolean(resumed)&&!dismissedReview;
  const refreshReviews=()=>{void client.invalidateQueries({queryKey:[...queryKey,'pull',location.pull,'reviews']});void query.refetch();};
  return <>
    {query.isFetching && pull ? <Loading label="Checking pull request access…"/> : null}
    <div hidden={query.isFetching && Boolean(pull)}>
    <section className="discussion-summary pull-detail" aria-labelledby="pull-detail-title">
      <div className="discussion-navigation"><Link className="text-button" {...repositoryOptions(location, { pull: undefined })}><ArrowLeft size={15} />All {location.state === 'all' ? '' : `${location.state} `}pull requests</Link><button className="icon-button manual-refresh" aria-label="Refresh pull request" disabled={query.isFetching} onClick={refreshPull}><RefreshCw size={16} /></button></div>
      {denied||query.isError ? <PanelError error={denied||query.error!} retry={refreshPull} /> : !pull ? <Loading label="Loading pull request…" /> : <>
        <h2 id="pull-detail-title">{pull.title} <span className="muted">#{pull.number}</span></h2>
        <div className="discussion-summary-meta"><PullState pull={pull} /><p>{pull.user?.login || 'Deleted or unavailable author'} opened this pull request on <DateLabel value={pull.createdAt} /></p><span className="pull-comparison"><code>{pull.base?.label || pull.base?.ref}</code><span>←</span><code>{pull.head?.label || pull.head?.ref}</code></span></div>
        <PullRequestEditControls key={pull.id} {...props} pull={pull} refresh={()=>{void query.refetch();void client.invalidateQueries({queryKey:[...queryKey,'pulls']});}}/>
      </>}
    </section>
    </div>
    {pull ? <RepositoryTabs className="pull-tabs" label="Pull request workspace" selection={location.pullView||'conversation'}><Link {...repositoryOptions(location,{pullView:undefined})} aria-current={!location.pullView || location.pullView === 'conversation' ? 'page' : undefined}><MessageSquare size={16}/>Conversation</Link><Link {...repositoryOptions(location,{pullView:'commits'})} aria-current={location.pullView === 'commits' ? 'page' : undefined}><GitCommitHorizontal size={16}/>Commits</Link><Link {...repositoryOptions(location,{pullView:'checks'})} aria-current={location.pullView === 'checks' ? 'page' : undefined}><ListChecks size={16}/>Checks</Link><Link {...repositoryOptions(location,{pullView:'files'})} aria-current={location.pullView === 'files' ? 'page' : undefined}><FileDiff size={16}/>Files changed</Link></RepositoryTabs>:null}
    <div hidden={query.isFetching && Boolean(pull)}>
    {pull ? <>
      {reviewOpen?<PullReviewComposer key={`${props.userId}-${props.repositoryId}-${pull.id}-${reviewGeneration}`} repositoryKey={repositoryKey} repositoryId={props.repositoryId} userId={props.userId} pull={pull} blocked={query.isFetching} onClose={closeReview} onCurrentSelection={()=>{setDismissedReview(false);setReviewing(true);setReviewGeneration(v=>v+1);}} onReviewed={refreshReviews}/>:null}
      {location.pullView === 'commits' ? <PullCommits {...props} pull={pull}/> : location.pullView === 'checks' ? <PullChecks {...props} pull={pull}/> : location.pullView === 'files' ? <PullFiles {...props} pull={pull} onReview={openReview}/> : <div className="discussion-layout"><div className="discussion-main"><section className="browser-panel discussion-description" aria-label="Pull request description"><div className="browser-panel-heading"><strong>{pull.user?.login || 'Deleted or unavailable author'}</strong><span className="muted">opened <DateLabel value={pull.createdAt}/></span></div><MarkdownBody text={pull.body || 'No description provided.'} label="Pull request body, rendered Markdown"/>{external ? <div className="issue-footer"><span>Updated <DateLabel value={pull.updatedAt}/></span><a className="text-button" href={external} target="_blank" rel="noopener noreferrer">Open original<ExternalLink size={14}/></a></div> : null}</section><Reviews {...props} pull={pull} onReview={openReview}/><PullDiscussion {...props}/><ReviewerRuns userId={String(queryKey[1]||'')} owner={repositoryKey.owner} name={repositoryKey.name} signingOut={false} pullNumber={pull.number}/></div>
        <aside className="discussion-sidebar" aria-label="Pull request metadata"><details className="metadata-details"><summary>Comparison details</summary><RefMetadata title="Base" value={pull.base}/><RefMetadata title="Head" value={pull.head}/></details>{pull.merged ? <div className="pull-merge-record"><strong>Native merge record</strong><p>Merged <DateLabel value={pull.mergedAt}/></p><code>{pull.mergeCommitId || 'Merge commit unavailable'}</code></div> : null}{!pull.merged?<PullMergeObservation key={`${props.userId}-${props.repositoryId}-${pull.id}-${pull.revision}`} client={pullMergeObservationClient} userId={props.userId} repository={repositoryKey} repositoryId={props.repositoryId} pull={pull} blocked={query.isFetching} onAuthorityDenied={denyMergeObservation} onObservation={observeMerge}/>:null}<PullNativeMerge key={`${props.userId}-${props.repositoryId}-${pull.id}`} client={standardPullMergeClient} userId={props.userId} repository={repositoryKey} repositoryId={props.repositoryId} pull={pull} observation={currentMergeObservation} blocked={query.isFetching} onVerified={()=>void query.refetch()} onAuthorityDenied={denyMergeObservation}/></aside>
      </div>}
    </> : null}
    </div>
  </>;
}

function PullList({ repositoryKey, queryKey, location }: Props) {
  const navigate = useNavigate();
  const query = useInfiniteQuery({ ...privateQuery, queryKey: [...queryKey, 'pulls', location.state], initialPageParam: 1,
    queryFn: ({ pageParam, signal }) => repositoryClient.listPullRequests({ repository: repositoryKey, state: location.state === 'open' ? IssueState.OPEN : location.state === 'closed' ? IssueState.CLOSED : IssueState.ALL, page: { page: pageParam, limit: 20 } }, { signal, timeoutMs: 8_000 }), getNextPageParam: followingPage });
  const pulls = query.isSuccess && (!query.isFetching || query.isFetchingNextPage)
    ? [...new Map(query.data.pages.flatMap((page) => page.pullRequests).map((pull) => [pull.id, pull])).values()] : [];
  const list = useRepositoryWorkList(pulls);
  return <section className="browser-panel repository-work-list" aria-labelledby="pulls-title">
    <div className="browser-panel-heading"><h2 id="pulls-title">Pull requests</h2><div className="panel-actions"><Link className="button primary" {...repositoryOptions(location,{view:'compare',pull:undefined})}><GitPullRequest size={16}/>New pull request</Link><select aria-label="Pull request state" value={location.state} onChange={(event) => void navigate(repositoryOptions(location, { state: event.target.value as RepositoryLocation['state'], pull: undefined }))}><option value="open">Open</option><option value="closed">Closed</option><option value="all">All states</option></select><button className="icon-button manual-refresh" aria-label="Refresh pull requests" disabled={query.isFetching} onClick={() => void query.refetch()}><RefreshCw size={16} /></button></div></div>

    <RepositoryListControls label="pull requests" {...list.controls}/>
    {query.isError ? <PanelError error={query.error} retry={() => void query.refetch()} /> : query.isPending || (query.isFetching && !query.isFetchingNextPage) ? <Loading label="Loading pull requests…" /> : <>
      <ul className="issue-list pull-list">{list.rows.map((pull) => <li key={pull.id}><GitPullRequest size={19} /><div><h3><Link {...repositoryOptions(location, { pull: pull.number })}>{pull.title}</Link></h3><p>#{pull.number} opened by {pull.user?.login || 'Deleted or unavailable author'} on <DateLabel value={pull.createdAt} />{pull.head?.retainedSnapshot ? <span className="pull-observation"> · Retained PR snapshot</span> : null}</p></div><PullState pull={pull} /></li>)}</ul>
      {!list.rows.length ? <div className="empty-state"><GitPullRequest size={25} /><h3>No {location.state === 'all' ? '' : `${location.state} `}pull requests.</h3>{query.hasNextPage ? <p>More provider pages may contain visible pull requests.</p> : <p>{list.controls.search ? 'No loaded pull requests match your search.' : 'There are no pull requests matching this state.'}</p>}</div> : null}
      <div className="list-footer"><span>{pulls.length} loaded pull requests{query.hasNextPage ? ' · More available' : ''}</span><More hasMore={query.hasNextPage} loading={query.isFetching} load={() => void query.fetchNextPage()} label="pull requests" /></div>
    </>}
  </section>;
}
export function PullRequestBrowser(props: Props) {
  return props.location.pull ? <PullDetail key={props.location.pull} {...props} /> : <PullList {...props} />;
}
