import { Comments } from './IssueBrowser';
import { ReviewerRuns } from './ReviewerPanel';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { Code, ConnectError } from '@connectrpc/connect';
import { Link, useNavigate } from '@tanstack/react-router';
import { ArrowLeft, ExternalLink, GitPullRequest, RefreshCw } from 'lucide-react';
import { repositoryClient, repositoryLink } from './api';
import { IssueState, PullRequestReviewState } from './gen/golf/v1/golf_pb';
import type { PageResponse, PullRequest, PullRequestRef, RepositoryKey } from './gen/golf/v1/golf_pb';
import { repositoryOptions } from './navigation';
import type { RepositoryLocation } from './navigation';
import { DateLabel, Loading, More, PanelError, privateQuery } from './RepositoryUI';

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
function Reviews({ repositoryKey, queryKey, location }: Props) {
  const query = useInfiniteQuery({ ...privateQuery, queryKey: [...queryKey, 'pull', location.pull, 'reviews'], initialPageParam: 1,
    queryFn: ({ pageParam, signal }) => repositoryClient.listPullRequestReviews({ repository: repositoryKey, number: location.pull, page: { page: pageParam, limit: 20 } }, { signal, timeoutMs: 8_000 }), getNextPageParam: followingPage });
  const reviews = query.isSuccess && (!query.isFetching || query.isFetchingNextPage)
    ? [...new Map(query.data.pages.flatMap((page) => page.reviews).map((review) => [review.id, review])).values()] : [];
  return <section className="browser-panel pull-reviews" aria-labelledby="reviews-title">
    <div className="browser-panel-heading"><h2 id="reviews-title">Reviews</h2><button className="icon-button" aria-label="Refresh reviews" disabled={query.isFetching} onClick={() => void query.refetch()}><RefreshCw size={16} /></button></div>
    <p className="panel-footnote issue-help">Provider records only. These states do not establish Golf approval eligibility or merge readiness.</p>
    {query.isError ? <PanelError error={query.error} retry={() => void query.refetch()} /> : query.isPending || (query.isFetching && !query.isFetchingNextPage) ? <Loading label="Loading reviews…" /> : <>
      {reviews.length ? <ol className="pull-review-list">{reviews.map((review) => {
        const external = repositoryLink(review.htmlUrl);
        return <li key={review.id}><div className="pull-review-heading"><h3>{review.user?.login || 'Deleted or unavailable author'}</h3><span className="visibility">{reviewLabels[review.state] || 'Unknown review state'}</span></div>
          <p className="muted">Submitted <DateLabel value={review.submittedAt} /> · Updated <DateLabel value={review.updatedAt} /></p>
          <pre className="issue-body review-body" tabIndex={0} aria-label={`Review ${review.id} body, plain text`}>{review.body || 'No review text provided.'}</pre>
          <dl className="review-metadata"><div><dt>Review ID</dt><dd><code>{review.id}</code></dd></div><div><dt>Reviewed commit</dt><dd><code>{review.commitId || 'Unavailable'}</code></dd></div><div><dt>Marked stale</dt><dd>{review.stale ? 'Yes' : 'No'}</dd></div><div><dt>Dismissed</dt><dd>{review.dismissed ? 'Yes' : 'No'}</dd></div><div><dt>Official</dt><dd>{review.official ? 'Yes' : 'No'}</dd></div></dl>
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
function PullDetail(props: Props) {
  const { repositoryKey, queryKey, location } = props;
  const query = useQuery({ ...privateQuery, queryKey: [...queryKey, 'pull', location.pull], queryFn: async ({ signal }) => {
    const response = await repositoryClient.getPullRequest({ repository: repositoryKey, number: location.pull }, { signal, timeoutMs: 8_000 });
    if (!response.pullRequest) throw new ConnectError('The pull request response is missing its metadata.', Code.Internal);
    return response.pullRequest;
  } });
  const pull = query.isSuccess && !query.isFetching ? query.data : undefined;
  const external = pull && repositoryLink(pull.htmlUrl);
  return <>
    <section className="browser-panel issue-detail pull-detail" aria-labelledby="pull-detail-title">
      <div className="browser-panel-heading"><Link className="text-button" {...repositoryOptions(location, { pull: undefined })}><ArrowLeft size={15} />All {location.state === 'all' ? '' : `${location.state} `}pull requests</Link><button className="icon-button" aria-label="Refresh pull request" disabled={query.isFetching} onClick={() => void query.refetch()}><RefreshCw size={16} /></button></div>
      {query.isError ? <PanelError error={query.error} retry={() => void query.refetch()} /> : !pull ? <Loading label="Loading pull request…" /> : <>
        <div className="issue-title"><PullState pull={pull} /><h2 id="pull-detail-title">{pull.title} <span className="muted">#{pull.number}</span></h2><p className="muted">{pull.user?.login || 'Deleted or unavailable author'} opened this pull request on <DateLabel value={pull.createdAt} /></p></div>
        <pre className="issue-body" tabIndex={0} aria-label="Pull request body, plain text">{pull.body || 'No description provided.'}</pre>
        <div className="pull-refs"><RefMetadata title="Base" value={pull.base} /><RefMetadata title="Head" value={pull.head} /></div>
        <p className="panel-footnote">Refs and commits are provider observations. A retained PR snapshot is not proof of an existing source branch, freshness, or protected integration eligibility.</p>
        {pull.merged ? <div className="pull-merge-record"><strong>Native merge record</strong><p>Merged <DateLabel value={pull.mergedAt} /></p><code>{pull.mergeCommitId || 'Merge commit unavailable'}</code></div> : null}
        <div className="issue-footer"><span>Updated <DateLabel value={pull.updatedAt} /></span>{external ? <a className="text-button" href={external} target="_blank" rel="noopener noreferrer">Open original<ExternalLink size={14} /></a> : null}</div>
        <p className="panel-footnote">Read-only, plain-text view. Reviews below show native records; protected integration remains unavailable.</p>
      </>}
    </section>
    {pull ? <><ReviewerRuns userId={String(queryKey[1]||'')} owner={repositoryKey.owner} name={repositoryKey.name} signingOut={false} pullNumber={pull.number}/><Reviews {...props} /><PullDiscussion {...props}/></> : null}
  </>;
}
function PullList({ repositoryKey, queryKey, location }: Props) {
  const navigate = useNavigate();
  const query = useInfiniteQuery({ ...privateQuery, queryKey: [...queryKey, 'pulls', location.state], initialPageParam: 1,
    queryFn: ({ pageParam, signal }) => repositoryClient.listPullRequests({ repository: repositoryKey, state: location.state === 'open' ? IssueState.OPEN : location.state === 'closed' ? IssueState.CLOSED : IssueState.ALL, page: { page: pageParam, limit: 20 } }, { signal, timeoutMs: 8_000 }), getNextPageParam: followingPage });
  const pulls = query.isSuccess && (!query.isFetching || query.isFetchingNextPage)
    ? [...new Map(query.data.pages.flatMap((page) => page.pullRequests).map((pull) => [pull.id, pull])).values()] : [];
  return <section className="browser-panel" aria-labelledby="pulls-title">
    <div className="browser-panel-heading"><h2 id="pulls-title">Pull requests</h2><div className="panel-actions"><select aria-label="Pull request state" value={location.state} onChange={(event) => void navigate(repositoryOptions(location, { state: event.target.value as RepositoryLocation['state'], pull: undefined }))}><option value="open">Open</option><option value="closed">Closed</option><option value="all">All states</option></select><button className="icon-button" aria-label="Refresh pull requests" disabled={query.isFetching} onClick={() => void query.refetch()}><RefreshCw size={16} /></button></div></div>
    <p className="panel-footnote issue-help">Read-only pull requests and reviews. Your repository permissions apply.</p>
    {query.isError ? <PanelError error={query.error} retry={() => void query.refetch()} /> : query.isPending || (query.isFetching && !query.isFetchingNextPage) ? <Loading label="Loading pull requests…" /> : <>
      <ul className="issue-list pull-list">{pulls.map((pull) => <li key={pull.id}><GitPullRequest size={19} /><div><h3><Link {...repositoryOptions(location, { pull: pull.number })}>{pull.title}</Link></h3><p>#{pull.number} · {pull.user?.login || 'Deleted or unavailable author'} · <DateLabel value={pull.createdAt} /></p>{pull.head?.retainedSnapshot ? <p className="pull-observation">Retained PR snapshot</p> : null}</div><PullState pull={pull} /></li>)}</ul>
      {!pulls.length ? <div className="empty-state"><GitPullRequest size={25} /><h3>No {location.state === 'all' ? '' : `${location.state} `}pull requests.</h3>{query.hasNextPage ? <p>More provider pages may contain visible pull requests.</p> : <p>There are no pull requests matching this state.</p>}</div> : null}
      <div className="list-footer"><span>{pulls.length} loaded pull requests{query.hasNextPage ? ' · More available' : ''}</span><More hasMore={query.hasNextPage} loading={query.isFetching} load={() => void query.fetchNextPage()} label="pull requests" /></div>
    </>}
  </section>;
}
export function PullRequestBrowser(props: Props) {
  return props.location.pull ? <PullDetail key={props.location.pull} {...props} /> : <PullList {...props} />;
}
