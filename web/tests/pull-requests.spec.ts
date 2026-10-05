import { ListRepositoryMilestonesRequestSchema,ListRepositoryMilestonesResponseSchema,ListRepositoryLabelsRequestSchema,ListRepositoryLabelsResponseSchema,ListRepositoryAssigneesRequestSchema,ListRepositoryAssigneesResponseSchema } from '../src/gen/golf/v1/golf_pb';
import { DiscussionMetadataSchema, DiscussionMilestoneSchema, DiscussionLabelSchema } from '../src/gen/golf/v1/golf_pb';
import { GetStandardPullMergeOperationResponseSchema, StandardPullMergePhase, UpdatePullRequestRequestSchema, UpdatePullRequestResponseSchema, GetIssueMutationRequestSchema, GetIssueMutationResponseSchema, IssueMutationKind, IssueMutationState } from '../src/gen/golf/v1/golf_pb';
import type { UpdatePullRequestRequest, IssueMutation, PullRequest } from '../src/gen/golf/v1/golf_pb';
import {ListPullRequestCommitsRequestSchema,ListPullRequestCommitsResponseSchema,ListPullRequestChecksRequestSchema,ListPullRequestChecksResponseSchema,ReportedCheckState} from '../src/gen/golf/v1/golf_pb';
import {GetPullRequestDiffRequestSchema,GetPullRequestDiffResponseSchema} from '../src/gen/golf/v1/golf_pb';
import {GetPullRequestDiscussionResponseSchema,ListIssueCommentsResponseSchema,ListReviewerRunsResponseSchema} from '../src/gen/golf/v1/golf_pb';
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { create, clone } from '@bufbuild/protobuf';
import {
  GetAuthenticationOptionsResponseSchema, GetContentsResponseSchema, GetPullRequestRequestSchema, GetPullRequestResponseSchema,
  GetRepositoryResponseSchema, GetSessionResponseSchema, IssueState, ListCapabilitiesResponseSchema, ListPullRequestReviewsRequestSchema,
  ListPullRequestReviewsResponseSchema, ListPullRequestsRequestSchema, ListPullRequestsResponseSchema, ListRepositoriesResponseSchema,
  LoginWithPasswordResponseSchema, LogoutResponseSchema, PullRequestReviewSchema, PullRequestReviewState, PullRequestSchema, PullRequestRefSchema,
  RepositorySchema, SourceEntryType, UserSchema,
} from '../src/gen/golf/v1/golf_pb';
import { resolveSourceFixture, reject, request, respond } from './rpc';

const base = 'a'.repeat(40);
const head = 'b'.repeat(40);
const merged = 'c'.repeat(40);
const user = create(UserSchema, { id: '9007199254740993', login: 'alex', fullName: 'Alex' });
const repository = create(RepositorySchema, { id: '9007199254740993', name: 'design-system', fullName: 'alex/design-system', private: true, defaultBranch: 'main', description: 'A private repository.', htmlUrl: 'https://forge.example/alex/design-system' });
const pull = create(PullRequestSchema, { mergeBaseCommitId:base, revision:'e'.repeat(64), id: '9007199254740994', number: 12, title: 'Make every control keyboard accessible', body: '# PRIVATE PULL\n<img src=x onerror="window.executed=true">\n[Unsafe](javascript:alert(1))', state: IssueState.OPEN, user, draft: true,
  createdAt: '2026-10-01T12:00:00Z', updatedAt: '2026-10-02T12:00:00Z', htmlUrl: 'https://forge.example/alex/design-system/pulls/12',
  base: { repositoryId: repository.id, label: 'alex:main', ref: 'main', commitId: base },
  head: { repositoryId: '9007199254740995', label: 'contributor:feature/keyboard', ref: 'feature/keyboard', commitId: head },
});
const closed = create(PullRequestSchema, { ...pull, id: '9007199254740996', number: 13, title: 'Ship focus indicators', state: IssueState.CLOSED, draft: false, merged: true, mergedAt: '2026-10-02T13:00:00Z', mergeCommitId: merged });
const snapshot = create(PullRequestSchema, { ...pull, id: '9007199254740997', number: 14, title: 'Retained contribution', user: undefined, htmlUrl: 'javascript:alert(1)', draft: false, head: create(PullRequestRefSchema, { repositoryId: '', label: 'Deleted source', ref: 'refs/pull/14/head', commitId: head, retainedSnapshot: true }) });
const review = create(PullRequestReviewSchema, { id: '9007199254740998', user, body: 'PRIVATE REVIEW\n<script>window.executed=true</script>\n[Link](javascript:alert(1))', state: PullRequestReviewState.APPROVED, commitId: head, stale: true, dismissed: true, official: true, submittedAt: '2026-10-01T14:00:00Z', updatedAt: '2026-10-02T14:00:00Z', htmlUrl: 'https://forge.example/alex/design-system/pulls/12#review' });
const pending = create(PullRequestReviewSchema, { ...review, id: '9007199254740999', user: undefined, body: '', state: PullRequestReviewState.PENDING, stale: false, dismissed: false, official: false, htmlUrl: 'javascript:alert(1)' });

async function backend(page: Page) {
  const state = { serverQueries:[] as unknown[], metadataCanEdit:false, metadataWait:undefined as Promise<void>|undefined, listRows:undefined as PullRequest[]|undefined, pull:clone(PullRequestSchema,pull),updates:[] as UpdatePullRequestRequest[],inspections:[] as string[],mutation:undefined as IssueMutation|undefined,updateFailure:"",unknown:false,wrongMutation:false,wrongObject:false,missingObject:false,dropUpdate:false,updateWait:undefined as Promise<void>|undefined, signedIn: true, metadataStatus: 200, listStatus: 200, detailStatus: 200, reviewStatus: 200, diffStatus: 200, wrongDiff:'', empty: false,
    workspaceStatus: 200, workspaceWait: undefined as Promise<void>|undefined, mismatched: false, badPage: false, emptyWorkspace: false, duplicateContext: false,
    commitPages: [] as number[], checkPages: [] as number[],
    reviewWait: undefined as Promise<void> | undefined, detailWait: undefined as Promise<void> | undefined,
    methods: [] as string[], pages: [] as number[], reviewPages: [] as number[], states: [] as IssueState[], numbers: [] as number[] };
  await page.route('**/rpc/**', async (route) => {
    const method = new URL(route.request().url()).pathname.split('/').at(-1)!;
    state.methods.push(method);
    expect(route.request().method()).toBe('POST');
    expect(route.request().headers()['connect-protocol-version']).toBe('1');
    const error = (status: number, message: string) => reject(route, status === 401 ? 'unauthenticated' : status === 403 ? 'permission_denied' : status === 404 ? 'not_found' : 'unavailable', message);
    if (method === 'GetAuthenticationOptions') return respond(route, GetAuthenticationOptionsResponseSchema, { localPasswordEnabled: true });
    if (method === 'GetSession') return state.signedIn ? respond(route, GetSessionResponseSchema, { user }) : error(401, 'Sign in required.');
    if (method === 'LoginWithPassword') { state.signedIn = true; return respond(route, LoginWithPasswordResponseSchema, { user }); }
    if (method === 'Logout') { state.signedIn = false; return respond(route, LogoutResponseSchema, {}); }
    if (!state.signedIn) return error(401, 'Your session expired.');
    if (method === 'GetRepositoryStar') return reject(route,'unimplemented','Stars are outside this PR fixture.');
    if (method === 'ListCapabilities') return respond(route, ListCapabilitiesResponseSchema, { capabilities: [] });
    if (method === 'ListRepositories') return respond(route, ListRepositoriesResponseSchema, { repositories: [repository] });
    if (method === 'GetRepository') return state.metadataStatus === 200 ? respond(route, GetRepositoryResponseSchema, { repository: { ...repository, empty: state.empty } }) : error(state.metadataStatus, 'Repository not found or inaccessible.');
    if (method === 'ResolveRepositorySource') return resolveSourceFixture(route, repository.id, { owner: 'alex', name: 'design-system' }, 'main', { main: base });
    if (method === 'GetContents') return respond(route, GetContentsResponseSchema, { repositoryId: repository.id, kind: SourceEntryType.DIRECTORY, commitId: base, entries: [] });
    if (method === 'ListPullRequests') {
      const input = request(route, ListPullRequestsRequestSchema);
      expect(input.repository).toMatchObject({ owner: 'alex', name: 'design-system' });
      state.pages.push(input.page?.page || 0); state.states.push(input.state); state.serverQueries.push({query:input.query,sort:input.sort,baseBranch:input.baseBranch});
      if (state.listStatus !== 200) return error(state.listStatus, 'Pull requests not found or inaccessible.');
      if (state.listRows) return respond(route, ListPullRequestsResponseSchema, { pullRequests: state.listRows.slice(((input.page?.page || 1) - 1) * 2, (input.page?.page || 1) * 2), page: input.page?.page === 2 ? undefined : { nextPage: 2 } });
      const listed = { ...pull, head: create(PullRequestRefSchema, { ...pull.head!, retainedSnapshot: true }) };
      return respond(route, ListPullRequestsResponseSchema, state.empty ? {} : input.state === IssueState.CLOSED ? { pullRequests: [closed] } : input.state === IssueState.ALL ? { pullRequests: [listed, closed, snapshot] } : input.page?.page === 2 ? { pullRequests: [listed, snapshot] } : { pullRequests: [listed], page: { nextPage: 2 } });
    }
    if(method==='ListPullRequestCommits'||method==='ListPullRequestChecks') {
      const commits=method==='ListPullRequestCommits';
      const input=commits?request(route,ListPullRequestCommitsRequestSchema):request(route,ListPullRequestChecksRequestSchema);
      expect(input.selection).toMatchObject({repository:{owner:'alex',name:'design-system'},repositoryId:repository.id,pullRequestId:pull.id,number:12,baseCommitId:base,headCommitId:head});
      const number=input.page?.page||1;(commits?state.commitPages:state.checkPages).push(number);
      if(state.workspaceWait)await state.workspaceWait;
      if(state.workspaceStatus!==200)return error(state.workspaceStatus,'PR workspace is unavailable.');
      const selection={...input.selection!,headCommitId:state.mismatched?'d'.repeat(40):head};
      const page={nextPage:state.badPage?number:number===1?2:0};
      if(commits)return respond(route,ListPullRequestCommitsResponseSchema,{selection,page:state.emptyWorkspace?undefined:page,commits:state.emptyWorkspace?[]:[
        {sha:head,message:'PRIVATE COMMIT title\n\nMeaningful <script> body',authorName:'Alex',authoredAt:'2026-10-02T13:00:00Z'},
        ...(number===2?[{sha:'c'.repeat(40),message:'Second commit',authorName:'Sam',authoredAt:'2026-10-01T13:00:00Z'}]:[]),
      ]});
      return respond(route,ListPullRequestChecksResponseSchema,{selection,page:state.emptyWorkspace?undefined:page,checks:state.emptyWorkspace?[]:[{
        id:String(9007199254740993n+BigInt(number)),context:number===1||state.duplicateContext?'ci/build':'review/security',
        state:number===1?ReportedCheckState.SUCCESS:ReportedCheckState.PENDING,description:number===1?'PRIVATE CHECK <img src=x>':'Security review queued',
        creator:user,createdAt:'2026-10-02T13:00:00Z',updatedAt:'2026-10-02T13:00:00Z',targetUrl:number===1?'https://checks.example/build':'javascript:alert(1)',
      }]});
    }
    if(method==='GetPullRequestDiff') {
      const input=request(route,GetPullRequestDiffRequestSchema);
      expect(input).toMatchObject({repositoryId:repository.id,pullRequestId:state.pull.id,number:12,baseCommitId:state.pull.base!.commitId,headCommitId:state.pull.head!.commitId});
      if(state.diffStatus!==200)return error(state.diffStatus,'PR comparison is unavailable.');
      const rawDiff='diff --git a/control.ts b/control.ts\n--- a/control.ts\n+++ b/control.ts\n@@ -1 +1,2 @@\n-old control\n+new control\n+<script>window.executed=true</script>\n';
      return respond(route,GetPullRequestDiffResponseSchema,{repositoryId:state.wrongDiff==='repository'?'999':repository.id,pullRequestId:state.wrongDiff==='pull'?'999':state.pull.id,mergeBaseCommitId:state.wrongDiff==='merge-base'?'f'.repeat(40):state.pull.mergeBaseCommitId,baseCommitId:state.pull.base!.commitId,headCommitId:state.pull.head!.commitId,rawDiff,byteSize:new TextEncoder().encode(rawDiff).byteLength});
    }
    if (method === 'GetPullRequest') {
      const input = request(route, GetPullRequestRequestSchema); state.numbers.push(input.number);
      if (state.detailWait) await state.detailWait;
      if (state.detailStatus !== 200) return error(state.detailStatus, 'Pull request not found or inaccessible.');
      const result = [state.pull, closed, snapshot].find((item) => item.number === input.number);
      return result ? respond(route, GetPullRequestResponseSchema, { pullRequest: result }) : error(404, 'Pull request not found or inaccessible.');
    }
    if(method==='ListRepositoryMilestones'||method==='ListRepositoryLabels'||method==='ListRepositoryAssignees') {
      const schema=method==='ListRepositoryMilestones'?ListRepositoryMilestonesRequestSchema:method==='ListRepositoryLabels'?ListRepositoryLabelsRequestSchema:ListRepositoryAssigneesRequestSchema;
      const input=request(route,schema);expect(input.pullRequest).toBe(true);expect(input.repositoryId).toBe(repository.id);
      if(state.metadataWait)await state.metadataWait;
      if(method==='ListRepositoryMilestones')return respond(route,ListRepositoryMilestonesResponseSchema,{canEditMilestone:state.metadataCanEdit,milestones:[{id:'51',title:'Release',state:IssueState.OPEN}]});
      if(method==='ListRepositoryLabels')return respond(route,ListRepositoryLabelsResponseSchema,{canEditLabels:state.metadataCanEdit,labels:[{id:'41',name:'bug',color:'abcdef'},{id:'42',name:'enhancement',color:'123456'}]});
      return respond(route,ListRepositoryAssigneesResponseSchema,{canEditAssignees:state.metadataCanEdit,assignees:[user,{id:'9007199254740996',login:'bob',fullName:'Bob'}]});
    }
    if(method==='UpdatePullRequest') {
      const input=request(route,UpdatePullRequestRequestSchema);state.updates.push(input);
      if(state.updateWait)await state.updateWait;
      const result=state.updateFailure?IssueMutationState.REJECTED:state.unknown?IssueMutationState.OUTCOME_UNKNOWN:IssueMutationState.SUCCEEDED;
      if(result===IssueMutationState.SUCCEEDED)state.pull=create(PullRequestSchema,{...state.pull,
        title:input.title??(input.draft===true?'WIP: '+state.pull.title:input.draft===false?state.pull.title.replace(/^WIP: /,''):state.pull.title),body:input.body??state.pull.body,
        state:input.state===IssueState.UNSPECIFIED?state.pull.state:input.state,draft:input.draft??state.pull.draft,revision:'f'.repeat(64)});
      if(result===IssueMutationState.SUCCEEDED&&(input.milestone||input.labels||input.assignees)) {
        const metadata=clone(DiscussionMetadataSchema,state.pull.metadata||create(DiscussionMetadataSchema,{labelsKnown:true,assigneesKnown:true,milestoneKnown:true}));
        if(input.milestone)metadata.milestone=input.milestone.milestoneId==='0'?undefined:create(DiscussionMilestoneSchema,{id:'51',title:'Release',state:IssueState.OPEN});
        if(input.labels)metadata.labels=input.labels.labelIds.map(id=>create(DiscussionLabelSchema,{id,name:id==='41'?'bug':'enhancement',color:'abcdef'}));
        if(input.assignees)metadata.assignees=input.assignees.assignees.map(row=>create(UserSchema,{id:row.id,login:row.login}));
        state.pull.metadata=metadata;
      }
      state.mutation=create((await import('../src/gen/golf/v1/golf_pb')).IssueMutationSchema,{id:'101',idempotencyKey:input.idempotencyKey,kind:IssueMutationKind.UPDATE_PULL,state:result,repository:input.repository,repositoryId:input.repositoryId,pullRequestId:input.pullRequestId,number:input.number,
        observedResultId:result===IssueMutationState.SUCCEEDED?input.pullRequestId:'',observedNumber:result===IssueMutationState.SUCCEEDED?input.number:0,failureCode:state.updateFailure});
      if(state.dropUpdate)return route.abort();
      return respond(route,UpdatePullRequestResponseSchema,{mutation:state.wrongMutation?{...state.mutation,pullRequestId:'999'}:state.mutation,pullRequest:result===IssueMutationState.SUCCEEDED&&!state.missingObject?{...state.pull,id:state.wrongObject?'999':state.pull.id}:undefined});
    }
    if(method==='GetIssueMutation') {
      state.inspections.push(request(route,GetIssueMutationRequestSchema).idempotencyKey);
      return respond(route,GetIssueMutationResponseSchema,{mutation:state.wrongMutation?{...state.mutation!,pullRequestId:'999'}:state.mutation,pullRequest:state.mutation?.state===IssueMutationState.SUCCEEDED&&!state.missingObject?{...state.pull,id:state.wrongObject?'999':state.pull.id}:undefined});
    }
    if(method==='GetPullRequestDiscussion')return respond(route,GetPullRequestDiscussionResponseSchema,{issue:{id:'9007199254740999',number:pull.number,title:pull.title,state:IssueState.OPEN}});
    if(method==='ListIssueComments')return respond(route,ListIssueCommentsResponseSchema,{});
    if(method==='ListReviewerRuns')return respond(route,ListReviewerRunsResponseSchema,{});
    if (method === 'ListPullRequestReviews') {
      const input = request(route, ListPullRequestReviewsRequestSchema); state.reviewPages.push(input.page?.page || 0);
      if (state.reviewWait) await state.reviewWait;
      if (state.reviewStatus !== 200) return error(state.reviewStatus, 'Reviews not found or inaccessible.');
      // Native pending filtering can leave an empty page with a continuation.
      return respond(route, ListPullRequestReviewsResponseSchema, input.page?.page === 3 ? { reviews: [review, pending] } : input.page?.page === 2 ? { reviews: [review], page: { nextPage: 3 } } : { reviews: [], page: { nextPage: 2 } });
    }
    return error(404, 'Unsupported fixture operation.');
  });
  return state;
}

async function visibleReview(page: Page) {
  await expect(page.getByRole('heading', { name: 'Reviews', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Load more reviews' }).click();
  await expect(page.getByLabel(`Review ${review.id} body, rendered Markdown`)).toBeVisible();
}

test('pull navigation paginates and filters native states with canonical detail URLs, reload and history', async ({ page }) => {
  const state = await backend(page);
  await page.goto('/');
  expect(state.methods).not.toContain('ListPullRequests');
  await page.goto('/repositories/alex/design-system?view=pulls');
  await expect(page.getByRole('link', { name: pull.title })).toBeVisible();
  await expect(page.locator('nav[aria-label="Repository"] [aria-current="page"]')).toHaveText('Pull requests');
  await expect(page.locator('.pull-list')).toContainText('Retained PR snapshot');
  await page.getByRole('button', { name: 'Load more pull requests' }).click();
  await expect(page.locator('.pull-list>li')).toHaveCount(2);
  expect([...new Set(state.pages)]).toEqual([1, 2]);
  await page.getByLabel('Pull request state').selectOption('closed');
  await expect(page.getByRole('link', { name: closed.title })).toBeVisible();
  await expect(page.locator('.pull-list')).toContainText('Merged');
  await expect(page.getByRole('link', { name: pull.title })).toHaveCount(0);
  await page.getByLabel('Pull request state').selectOption('all');
  await page.getByRole('link', { name: pull.title }).click();
  await expect(page).toHaveURL(/pull\/12\?state=all$/);
  await expect(page.getByRole('heading', { name: `${pull.title} #12` })).toBeVisible();
  await page.reload();
  await expect(page.getByLabel('Pull request body, rendered Markdown')).toBeVisible();
  await page.getByRole('link', { name: 'All pull requests', exact: true }).click();
  await expect(page.getByRole('link', { name: pull.title })).toBeVisible();
  await page.goBack();
  await expect(page.getByLabel('Pull request body, rendered Markdown')).toBeVisible();
  expect(state.states).toContain(IssueState.CLOSED);
  expect(state.states).toContain(IssueState.ALL);
  expect(state.methods).not.toContain('ListIssues');
  expect(state.methods).not.toContain('ListBranches');
});

test('detail preserves exact refs and IDs; review pagination retains empty pages and shows native flags and safe Markdown', async ({ page }) => {
  const state = await backend(page);
  await page.goto('/repositories/alex/design-system?view=pulls&pull=12');
  await expect(page.getByLabel('Pull request body, rendered Markdown')).toContainText('image preview unavailable');
  await page.getByText('Comparison details',{exact:true}).click();
  await expect(page.getByRole('region', { name: 'Base metadata' })).toContainText(repository.id);
  await expect(page.getByRole('region', { name: 'Head metadata' })).toContainText('9007199254740995');
  await expect(page.getByRole('region', { name: 'Head metadata' })).toContainText(head);
  await expect(page.getByRole('region', { name: 'Head metadata' })).toContainText('feature/keyboard');
  await expect(page.getByRole('region', { name: 'Head metadata' })).toContainText('Provider observation');
  await expect(page.getByRole('heading', { name: 'No visible reviews in the loaded pages.' })).toBeVisible();
  await visibleReview(page);
  await page.getByRole('button', { name: 'Load more reviews' }).click();
  await expect(page.locator('.pull-review-list>li')).toHaveCount(2);
  expect([...new Set(state.reviewPages)]).toEqual([1, 2, 3]);
  await expect(page.getByText('Approved', { exact: true })).toBeVisible();
  await expect(page.getByText('Pending', { exact: true })).toBeVisible();
  await expect(page.locator('.pull-review-list>li').first().locator('dl')).toContainText('Marked staleYes');
  await expect(page.locator('.pull-review-list>li').first().locator('dl')).toContainText('DismissedYes');
  await expect(page.locator('.pull-review-list>li').first().locator('dl')).toContainText('OfficialYes');
  await expect(page.getByRole('heading', { name: 'Deleted or unavailable author' })).toBeVisible();
  await expect(page.locator('.issue-body script,.issue-body img,.issue-body a')).toHaveCount(0);
  await expect(page.locator('a[href^="javascript:"]')).toHaveCount(0);
  expect(await page.evaluate(() => 'executed' in window)).toBe(false);
  await expect(page.getByRole('button', { name: /^(merge|approve|request changes)$/i })).toHaveCount(0);
  expect(await page.evaluate(() => JSON.stringify({ ...localStorage, ...sessionStorage }))).not.toMatch(/PRIVATE|9007199254740995/);
});

test('retained or deleted source metadata and merged records never imply a live source or current approval', async ({ page }) => {
  await backend(page);
  await page.goto('/repositories/alex/design-system?view=pulls&pull=14');
  await page.getByText('Comparison details',{exact:true}).click();
  await expect(page.getByRole('region', { name: 'Head metadata' })).toContainText('Retained PR snapshot');
  await expect(page.getByRole('region', { name: 'Head metadata' })).toContainText('refs/pull/14/head');
  await expect(page.getByRole('region', { name: 'Head metadata' })).toContainText('Repository IDUnavailable');
  await expect(page.getByText('Deleted or unavailable author opened this pull request', { exact: false })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Open original', exact: true })).toHaveCount(0);
  await page.goto('/repositories/alex/design-system?view=pulls&pull=13');
  await expect(page.locator('.pull-merge-record')).toContainText(merged);
  await expect(page.locator('.pull-detail .pull-state')).toHaveText('Merged');
  await expect(page.getByRole('region',{name:'Pull request merge observation',exact:true})).toHaveCount(0);
});

test('review and detail denials remove cached private content throughout retry and parent access rechecks', async ({ page }) => {
  const state = await backend(page);
  await page.goto('/repositories/alex/design-system?view=pulls&pull=12');
  await visibleReview(page);
  state.reviewStatus = 403;
  await page.getByRole('button', { name: 'Refresh reviews' }).click();
  await expect(page.getByRole('alert')).toHaveText('Reviews not found or inaccessible.');
  await expect(page.getByText('PRIVATE REVIEW', { exact: false })).toHaveCount(0);
  await expect(page.getByLabel('Pull request body, rendered Markdown')).toBeVisible();
  let release!: () => void;
  state.reviewWait = new Promise<void>((resolve) => { release = resolve; });
  state.reviewStatus = 200;
  await page.getByRole('button', { name: 'Try again' }).click();
  await expect(page.getByText('PRIVATE REVIEW', { exact: false })).toHaveCount(0);
  release(); state.reviewWait = undefined;
  await expect(page.getByRole('alert')).toHaveCount(0);
  await expect(page.getByLabel(`Review ${review.id} body, rendered Markdown`)).toBeVisible();
  state.detailStatus = 404;
  await page.getByRole('button', { name: 'Refresh pull request', exact: true }).click();
  await expect(page.getByRole('alert')).toHaveText('Pull request not found or inaccessible.');
  await expect(page.getByText('PRIVATE PULL', { exact: false })).toHaveCount(0);
  await expect(page.getByText('PRIVATE REVIEW', { exact: false })).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Reviews', exact: true })).toHaveCount(0);
  state.metadataStatus = 404;
  await page.getByRole('button', { name: 'Refresh repository access' }).click();
  await expect(page.getByRole('alert')).toHaveText('Repository not found or inaccessible.');
  await expect(page.getByRole('navigation', { name: 'Repository', exact: true })).toHaveCount(0);
});

test('expired sessions and logout discard pull and review data, including navigation after a new login', async ({ page }) => {
  const state = await backend(page);
  await page.goto('/repositories/alex/design-system?view=pulls&pull=12');
  await visibleReview(page);
  state.signedIn = false;
  await page.getByRole('button', { name: 'Refresh reviews' }).click();
  await expect(page.getByRole('heading', { name: 'Welcome to Golf' })).toBeVisible();
  await expect(page.getByText('PRIVATE PULL', { exact: false })).toHaveCount(0);
  await expect(page.getByText('PRIVATE REVIEW', { exact: false })).toHaveCount(0);
  state.detailStatus = 404;
  await page.getByLabel('Email or username', { exact: true }).fill('fixture-account'); await page.getByLabel('Password', { exact: true }).fill('second-session-token'); await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByRole('alert')).toHaveText('Pull request not found or inaccessible.');
  await expect(page.getByText('PRIVATE REVIEW', { exact: false })).toHaveCount(0);
  state.detailStatus = 200;
  await page.getByRole('button', { name: 'Try again' }).click();
  await expect(page.getByLabel('Pull request body, rendered Markdown')).toBeVisible();
  await page.getByLabel('Your account', { exact: true }).click(); await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page.getByRole('heading', { name: 'Welcome to Golf' })).toBeVisible();
  await expect(page.getByText('PRIVATE PULL', { exact: false })).toHaveCount(0);
  expect(await page.evaluate(() => JSON.stringify({ ...localStorage, ...sessionStorage }))).not.toMatch(/PRIVATE|second-session-token/);
});

test('list failures hide earlier pages and empty repositories still support pull browsing', async ({ page }) => {
  const state = await backend(page);
  await page.goto('/repositories/alex/design-system?view=pulls');
  await expect(page.getByRole('link', { name: pull.title })).toBeVisible();
  state.listStatus = 403;
  await page.getByRole('button', { name: 'Load more pull requests' }).click();
  await expect(page.getByRole('alert')).toHaveText('Pull requests not found or inaccessible.');
  await expect(page.getByRole('link', { name: pull.title })).toHaveCount(0);
  state.listStatus = 200; state.empty = true;
  await page.getByRole('button', { name: 'Refresh repository access' }).click();
  await expect(page.getByRole('heading', { name: 'No open pull requests.' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'No commits yet.' })).toHaveCount(0);
  expect(state.methods).not.toContain('ListBranches');
});

test('invalid pull numbers are rejected before RPC and changing tabs clears the pull search', async ({ page }) => {
  const state = await backend(page);
  for (const number of ['0', '-1', '01', '1.5', '1e2', '2147483648', 'not-a-number']) {
    await page.goto('/repositories/alex/design-system?view=pulls&pull=' + number);
    await expect(page.getByRole('heading', { name: 'Page not found' })).toBeVisible();
  }
  expect(state.methods).not.toContain('GetPullRequest');
  await page.goto('/repositories/alex/design-system?view=pulls&pull=12');
  await expect(page.getByLabel('Pull request body, rendered Markdown')).toBeVisible();
  await page.getByRole('navigation', { name: 'Repository', exact: true }).getByRole('link', { name: 'Code', exact: true }).click();
  await expect(page).not.toHaveURL(/pull=/);
  await expect(page.getByRole('heading', { name: 'Source', exact: true })).toBeVisible();
});

test('pull browsing is keyboard accessible and fits charcoal and light mobile layouts', async ({ page }) => {
  await backend(page);
  const errors: string[] = []; page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/repositories/alex/design-system?view=pulls');
  await page.getByRole('link', { name: pull.title }).focus();
  await page.keyboard.press('Enter');
  await expect(page.getByLabel('Pull request body, rendered Markdown')).toBeVisible();
  if (await page.locator('html').getAttribute('data-theme') !== 'dark') await page.getByRole('button', { name: 'Switch to dark theme', exact: true }).click();
  await page.getByRole('button', { name: 'Load more reviews' }).focus();
  await page.keyboard.press('Enter');
  await expect(page.getByLabel(`Review ${review.id} body, rendered Markdown`)).toBeVisible();
  await page.screenshot({ path: 'test-results/pull-request-dark.png', fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: 'test-results/pull-request-mobile-dark.png', fullPage: true });
  if (await page.locator('html').getAttribute('data-theme') !== 'light') await page.getByRole('button', { name: 'Switch to light theme', exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: 'test-results/pull-request-mobile-light.png', fullPage: true });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.screenshot({ path: 'test-results/pull-request-light.png', fullPage: true });
  await expect(page.locator('nav[aria-label="Repository"] [aria-current="page"]')).toHaveCount(1);
  expect(errors).toEqual([]);
});


test('PR changed-files workspace binds comparison, toggles split, filters, marks viewed and clears denied data',async({page})=>{
 const state=await backend(page);
 await page.goto('/repositories/alex/design-system?view=pulls&pull=12');
 expect(state.methods).not.toContain('GetPullRequestDiff');
 await page.getByRole('link',{name:'Files changed',exact:true}).click();
 await expect(page).toHaveURL(/pull\/12\/files/);
 await expect(page.getByRole('heading',{name:'Files changed',exact:true})).toBeVisible();
 await expect(page.locator('.diff-file')).toHaveCount(1);
 await expect(page.locator('.diff-lines')).toContainText('new control');
 await expect(page.locator('.diff-workspace script,.diff-workspace img')).toHaveCount(0);
 await page.getByRole('button',{name:'Split',exact:true}).click();
 await expect(page.locator('.diff-lines')).toHaveClass(/split/);
 await expect(page.getByRole('link',{name:'Line 2',exact:true})).toHaveAttribute('href',new RegExp(`diff-${base}-${head}-file-0-R2`));
 await page.getByLabel('Viewed',{exact:true}).check();
 await expect(page.getByText('1/1 viewed this session',{exact:true})).toBeVisible();
 await expect(page.locator('.diff-lines')).toBeHidden();
 await page.locator('.diff-file-toggle').click();await expect(page.locator('.diff-lines')).toBeVisible();await expect(page.getByLabel('Viewed',{exact:true})).toBeChecked();
 await page.locator('.diff-file-toggle').click();const fileLink=page.getByRole('navigation',{name:'Changed file navigation'}).getByRole('link');await fileLink.focus();await page.keyboard.press('Enter');
 await expect(page.locator('.diff-lines')).toBeVisible();await expect(page.getByLabel('Viewed',{exact:true})).toBeChecked();await expect(page.getByText('1/1 viewed this session',{exact:true})).toBeVisible();
 expect(state.methods.some(method=>/^(Create|Save|Update|Delete|Merge|Submit)/.test(method))).toBe(false);
 await page.getByLabel('Viewed',{exact:true}).uncheck();
 await page.locator(`#diff-${base}-${head}-file-0-R1`).click();await page.locator(`#diff-${base}-${head}-file-0-R2`).click({modifiers:['Shift']});
 await expect(page).toHaveURL(new RegExp(`#diff-${base}-${head}-file-0-R1-R2$`));await expect(page.locator('.diff-code.diff-line-selected')).toHaveCount(2);
 expect(state.methods.some(method=>/^(Create|Save|Update|Delete|Merge|Submit)/.test(method))).toBe(false);
 await page.getByLabel('Filter changed files').fill('missing');
 await expect(page.getByText('No files match this filter.',{exact:true})).toBeVisible();
 await page.getByLabel('Filter changed files').fill('control');
 await expect(page.locator('.diff-file')).toHaveCount(1);
 await page.reload();
 await expect(page.locator('.diff-lines')).toBeVisible();
 await expect(page.getByLabel('Viewed',{exact:true})).not.toBeChecked();
 for(const theme of ['dark','light']) {
   await page.evaluate((value)=>document.documentElement.setAttribute('data-theme',value),theme);
   await page.setViewportSize({width:320,height:760});
   expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBe(true);
 }
 state.diffStatus=403;
 await page.getByRole('button',{name:'Refresh PR diff',exact:true}).click();
 await expect(page.getByRole('alert')).toHaveText('PR comparison is unavailable.');
 await expect(page.locator('.diff-workspace')).toHaveCount(0);
 expect(await page.evaluate(()=>JSON.stringify({...localStorage,...sessionStorage}))).not.toContain('new control');
});

for(const theme of ['dark','light'])for(const width of [1440,390])test(`PR comparison details stay private and on request in ${theme} ${width}px`,async({page})=>{
 const state=await backend(page),old='d'.repeat(40);state.pull.mergeBaseCommitId=old;await page.setViewportSize({width,height:900});await page.addInitScript(theme=>localStorage.setItem('golf.theme',theme),theme);await page.goto('/alex/design-system/pull/12/files');
 const diff=page.getByRole('region',{name:'Pull request diff',exact:true}),summary=diff.getByText('Comparison details',{exact:true}),details=summary.locator('..');await expect(page.locator('.diff-file')).toHaveCount(1);
 await expect(details).not.toHaveAttribute('open','');await expect(details.locator('code').first()).toBeHidden();await expect(diff.getByText('This observation does not establish merge readiness.',{exact:false})).toHaveCount(0);
 await summary.focus();await page.keyboard.press('Enter');await expect(details.locator('code')).toHaveText([old,head,base]);await expect(details).toContainText('Patch size');await expect(details).toContainText('Binary files show metadata instead of a text preview.');
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);await page.screenshot({path:test.info().outputPath(`pr-comparison-details-${theme}-${width}.png`),fullPage:true});
 await summary.press('Enter');await expect(details.locator('code').first()).toBeHidden();await page.screenshot({path:test.info().outputPath(`pr-cleanup-${theme}-${width}.png`),fullPage:true});
 await page.getByRole('button',{name:'Private draft',exact:true}).click();await expect(diff.getByText('Comparison details',{exact:true})).toHaveCount(0);const draft=page.getByRole('region',{name:'Private review draft',exact:true});await expect(draft.getByRole('alert')).toContainText('Private draft access');await draft.getByRole('button',{name:'Close',exact:true}).click();await expect(summary).toBeVisible();
 state.diffStatus=403;await page.getByRole('button',{name:'Refresh PR diff',exact:true}).click();await expect(diff.getByRole('alert')).toBeVisible();await expect(diff.getByText('Comparison details',{exact:true})).toHaveCount(0);await expect(diff).not.toContainText(old);expect(state.methods.some(method=>/^(Create|Save|Update|Delete|Merge|Submit)/.test(method))).toBe(false);
});

test('PR diff names actual merge-base old side separately from a diverged base tip',async({page})=>{
 const state=await backend(page);const old='d'.repeat(40);state.pull.mergeBaseCommitId=old;
 await page.goto('/alex/design-system/pull/12/files');
 await expect(page.locator('.diff-file')).toHaveCount(1);
 await expect(page.getByRole('link',{name:'Line 2',exact:true})).toHaveAttribute('href',new RegExp(`diff-${old}-${head}-file-0-R2`));
 const details=page.getByRole('region',{name:'Pull request diff',exact:true}).locator('details').filter({has:page.getByText('Comparison details',{exact:true})});
 await expect(details.locator('code').first()).toBeHidden();await details.getByText('Comparison details',{exact:true}).click();await expect(details).toContainText(`Old side${old}`);await expect(details).toContainText(`Base branch tip${base}`);
 await expect(details.locator('code').first()).toHaveAttribute('title',old);await expect(details).toContainText('Text diffs are limited to 512 KiB.');
 await page.getByLabel('Viewed',{exact:true}).check();
 state.pull.mergeBaseCommitId='f'.repeat(40);
 await page.getByRole('button',{name:'Refresh pull request',exact:true}).click();
 await expect(page.locator('.diff-lines')).toBeVisible();await expect(page.getByLabel('Viewed',{exact:true})).not.toBeChecked();
 await expect(page.getByRole('link',{name:'Line 2',exact:true})).toHaveAttribute('href',new RegExp(`diff-${'f'.repeat(40)}-${head}-file-0-R2`));
});

for(const wrong of ['repository','pull','merge-base'])test(`PR diff refuses mismatched ${wrong} receipt and clears previously shown private bytes`,async({page})=>{
 const state=await backend(page);await page.goto('/alex/design-system/pull/12/files');await expect(page.locator('.diff-lines')).toContainText('new control');
 state.wrongDiff=wrong;await page.getByRole('button',{name:'Refresh PR diff',exact:true}).click();
 await expect(page.getByRole('alert')).toHaveText('The PR diff does not match the selected comparison.');
 await expect(page.locator('.diff-workspace')).toHaveCount(0);await expect(page.getByText('new control',{exact:true})).toHaveCount(0);await expect(page.getByRole('region',{name:'Pull request diff',exact:true}).getByText('Comparison details',{exact:true})).toHaveCount(0);
});

for(const old of ['', 'main', 'd'.repeat(64)])test(`PR diff refuses unavailable or invalid old-side metadata (${old.length||'empty'}) before dispatch`,async({page})=>{
 const state=await backend(page);state.pull.mergeBaseCommitId=old;await page.goto('/alex/design-system/pull/12/files');
 await expect(page.getByRole('alert')).toHaveText('Refresh pull request metadata to select a complete old-side comparison.');
 expect(state.methods).not.toContain('GetPullRequestDiff');await expect(page.locator('.diff-workspace')).toHaveCount(0);
});

test('PR workspace exposes four canonical tabs, shared commit rows and latest reported checks without aggregate readiness',async({page})=>{
 const state=await backend(page);
 await page.goto('/alex/design-system/pull/12');
 const tabs=page.getByRole('navigation',{name:'Pull request workspace'});
 await expect(tabs.getByRole('link')).toHaveText(['Conversation','Commits','Checks','Files changed']);
 expect(state.methods).not.toContain('ListPullRequestCommits');expect(state.methods).not.toContain('ListPullRequestChecks');
 await tabs.getByRole('link',{name:'Commits',exact:true}).click();
 await expect(page).toHaveURL(/\/pull\/12\/commits$/);
 await expect(page.locator('.commit-list>li')).toHaveCount(1);
 await expect(page.getByRole('link',{name:'PRIVATE COMMIT title',exact:true})).toHaveAttribute('href',`/alex/design-system/commit/${head}`);
 await page.getByRole('button',{name:'Load more PR commits',exact:true}).click();
 await expect(page.locator('.commit-list>li')).toHaveCount(2);expect([...new Set(state.commitPages)]).toEqual([1,2]);
 await page.reload();await expect(page.locator('.commit-list>li')).toHaveCount(1);
 await tabs.getByRole('link',{name:'Checks',exact:true}).click();
 await expect(page).toHaveURL(/\/pull\/12\/checks$/);
 await expect(page.getByRole('cell',{name:'Success',exact:true})).toBeVisible();
 await page.getByRole('button',{name:'Load more checks',exact:true}).click();
 await expect(page.getByRole('cell',{name:'Pending',exact:true})).toBeVisible();
 expect([...new Set(state.checkPages)]).toEqual([1,2]);
 await expect(page.getByRole('link',{name:'Open details for ci/build',exact:true})).toHaveAttribute('href','https://checks.example/build');
 await expect(page.getByRole('link',{name:'Open details for review/security',exact:true})).toHaveCount(0);
 const search=page.getByRole('searchbox',{name:'Search loaded checks',exact:true});
 const checkReads=state.checkPages.length;
 await search.fill('Success');await expect(page.getByRole('cell',{name:'Success',exact:true})).toBeVisible();await expect(page.getByRole('cell',{name:'Pending',exact:true})).toHaveCount(0);
 await search.fill('Pending');await expect(page.getByRole('cell',{name:'Pending',exact:true})).toBeVisible();await expect(page.getByRole('cell',{name:'Success',exact:true})).toHaveCount(0);
 await search.fill('Security review queued');await expect(page.getByRole('cell',{name:'Pending',exact:true})).toBeVisible();await expect(page.getByRole('cell',{name:'Success',exact:true})).toHaveCount(0);
 await search.fill('PRIVATE CHECK <img src=x>');await expect(page.getByRole('cell',{name:'Success',exact:true})).toBeVisible();await expect(page.locator('.browser-panel img')).toHaveCount(0);
 expect(state.checkPages).toHaveLength(checkReads);
 await search.fill('security');
 await expect(page.getByRole('cell',{name:'Success',exact:true})).toHaveCount(0);await expect(page.getByRole('cell',{name:'Pending',exact:true})).toBeVisible();
 await page.getByText('Check sources and permissions',{exact:true}).click();
 await expect(page.getByText('Publishers may be repository writers.',{exact:false})).toBeVisible();
 await expect(page.getByText('protected merge enforcement remains unavailable.',{exact:false})).toBeVisible();
 await expect(page.locator('.browser-panel img,.browser-panel script,a[href^="javascript:"]')).toHaveCount(0);
 await expect(page.getByRole('navigation',{name:'Breadcrumb'}).locator('[aria-current="page"]')).toHaveCount(1);
 await page.goBack();await expect(page.locator('.commit-list>li')).toHaveCount(1);
 expect(await page.evaluate(()=>JSON.stringify({...localStorage,...sessionStorage}))).not.toMatch(/PRIVATE COMMIT|PRIVATE CHECK/);
});

for(const kind of ['commits','checks'] as const) {
 test(`PR ${kind} stale-response and continuation failures do not expose private rows`,async({page})=>{
  const state=await backend(page);state.mismatched=true;
  await page.goto(`/alex/design-system/pull/12/${kind}`);
  await expect(page.getByRole('alert')).toHaveText('The response does not match this pull request and selected comparison.');
  await expect(page.getByText(/PRIVATE COMMIT|PRIVATE CHECK/)).toHaveCount(0);
  state.mismatched=false;state.badPage=true;
  await page.getByRole('button',{name:'Try again',exact:true}).click();
  await expect(page.getByRole('alert')).toHaveText('The page continuation is invalid. Refresh this comparison.');
  await expect(page.getByText(/PRIVATE COMMIT|PRIVATE CHECK/)).toHaveCount(0);
 });
 test(`PR ${kind} denial, revalidation, repository revocation and session expiry clear loaded data`,async({page})=>{
  const state=await backend(page);
  await page.goto(`/repositories/alex/design-system?view=pulls&pull=12&pullView=${kind}`);
  await expect(page.getByText(kind==='commits'?'PRIVATE COMMIT title':'PRIVATE CHECK <img src=x>',{exact:true})).toBeVisible();
  state.workspaceStatus=403;
  await page.getByRole('button',{name:`Refresh PR ${kind}`,exact:true}).click();
  await expect(page.getByRole('alert')).toHaveText('PR workspace is unavailable.');
  await expect(page.getByText(/PRIVATE COMMIT|PRIVATE CHECK/)).toHaveCount(0);
  let release!:()=>void;state.workspaceWait=new Promise<void>(resolve=>{release=resolve;});state.workspaceStatus=200;
  await page.getByRole('button',{name:'Try again',exact:true}).click();
  await expect(page.getByText(/PRIVATE COMMIT|PRIVATE CHECK/)).toHaveCount(0);
  release();state.workspaceWait=undefined;
  await expect(page.getByText(kind==='commits'?'PRIVATE COMMIT title':'PRIVATE CHECK <img src=x>',{exact:true})).toBeVisible();
  state.metadataStatus=404;
  await page.getByRole('button',{name:'Refresh repository access',exact:true}).click();
  await expect(page.getByRole('alert')).toHaveText('Repository not found or inaccessible.');
  await expect(page.getByText(/PRIVATE COMMIT|PRIVATE CHECK/)).toHaveCount(0);
  state.metadataStatus=200;await page.getByRole('button',{name:'Try again',exact:true}).click();
  await expect(page.getByText(kind==='commits'?'PRIVATE COMMIT title':'PRIVATE CHECK <img src=x>',{exact:true})).toBeVisible();
  state.signedIn=false;await page.getByRole('button',{name:`Refresh PR ${kind}`,exact:true}).click();
  await expect(page.getByRole('heading',{name:'Welcome to Golf',exact:true})).toBeVisible();
  await expect(page.getByText(/PRIVATE COMMIT|PRIVATE CHECK/)).toHaveCount(0);
 });
 test(`PR ${kind} empty observation stays distinct from missing access`,async({page})=>{
  const state=await backend(page);state.emptyWorkspace=true;
  await page.goto(`/alex/design-system/pull/12/${kind}`);
  await expect(page.getByText(kind==='commits'?'No commits returned for this comparison.':'No reported checks in the loaded pages.',{exact:true})).toBeVisible();
  state.workspaceStatus=404;await page.getByRole('button',{name:`Refresh PR ${kind}`,exact:true}).click();
  await expect(page.getByRole('alert')).toHaveText('PR workspace is unavailable.');
  await expect(page.getByText(kind==='commits'?'No commits returned for this comparison.':'No reported checks in the loaded pages.',{exact:true})).toHaveCount(0);
 });
}

test('changing native status contexts between pages fails the check view instead of showing contradictory rows',async({page})=>{
 const state=await backend(page);state.duplicateContext=true;
 await page.goto('/alex/design-system/pull/12/checks');
 await page.getByRole('button',{name:'Load more checks',exact:true}).click();
 await expect(page.getByRole('alert')).toHaveText('Check contexts changed while paging. Refresh the pages before using these observations.');
 await expect(page.getByRole('cell',{name:'Success',exact:true})).toHaveCount(0);
});

test('all four PR tabs remain keyboard visible and compact in charcoal/light mobile layouts',async({page})=>{
 await backend(page);const errors:string[]=[];page.on('pageerror',error=>errors.push(error.message));
 await page.goto('/alex/design-system/pull/12/commits');
 const tabs=page.getByRole('navigation',{name:'Pull request workspace'});
 for(const theme of ['dark','light'])for(const width of [1280,390,320]) {
  await page.setViewportSize({width,height:844});await page.evaluate(value=>document.documentElement.setAttribute('data-theme',value),theme);
  for(const view of ['Commits','Checks','Files changed','Conversation']) {
   const tab=tabs.getByRole('link',{name:view,exact:true});await tab.focus();await page.keyboard.press('Enter');
   await expect(tab).toHaveAttribute('aria-current','page');
   if(view==='Commits')await expect(page.locator('.commit-list>li')).toHaveCount(1);
   if(view==='Checks')await expect(page.getByRole('cell',{name:'Success',exact:true})).toBeVisible();
   if(view==='Files changed')await expect(page.locator('.diff-file')).toHaveCount(1);
   if(view==='Conversation')await expect(page.getByLabel('Pull request body, rendered Markdown')).toBeVisible();
   const visible=await tab.evaluate(el=>{const a=el.getBoundingClientRect(),p=el.parentElement!.getBoundingClientRect();return a.left>=p.left-1&&a.right<=p.right+1;});expect(visible).toBe(true);
   expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  }
 }
 expect(errors).toEqual([]);
});

const intentRows=(page:Page)=>page.evaluate(()=>Object.entries(sessionStorage).filter(([key])=>key.startsWith('golf.issue-intent.')));
for(const width of [1280,390])for(const field of ['title','body','draft','ready','close','reopen'] as const) {
 test(`PR ${field} at ${width}px sends one field with independent PR identity and frozen revision`,async({page})=>{
  await page.setViewportSize({width,height:900});
  const state=await backend(page);state.pull.draft=field==='ready';if(field==='reopen')state.pull.state=IssueState.CLOSED;
  await page.goto('/alex/design-system/pull/12');
  await expect(page.getByLabel('Pull request title',{exact:true})).toHaveCount(0);
  const trigger=field==='title'?'Edit pull request title':field==='body'?'Edit pull request description':field==='draft'?'Convert to draft':field==='ready'?'Ready for review':field==='close'?'Close pull request':'Reopen pull request';
  if(width<=720)await page.getByLabel('More pull request actions',{exact:true}).click();
  await page.getByRole('button',{name:trigger,exact:true}).click();
  if(width<=720)await expect(page.locator('.pull-action-menu')).not.toHaveAttribute('open');
  const editor=page.getByRole('region',{name:field==='title'?'Edit title':field==='body'?'Edit description':trigger,exact:true});
  await expect(editor.locator('xpath=ancestor::details')).toHaveCount(0);
  if(field==='title')await editor.getByLabel('Pull request title',{exact:true}).fill(' Edited proposal ');
  if(field==='body'){await page.getByRole('button',{name:'Add a comment',exact:true}).click();await editor.getByLabel('Description, Markdown',{exact:true}).fill('');await expect(page.getByLabel('Comment, plain text',{exact:true})).toHaveValue('');}
  let release!:()=>void;state.updateWait=new Promise<void>(resolve=>release=resolve);
  await editor.locator('form').evaluate((form:HTMLFormElement)=>{form.requestSubmit();form.requestSubmit()});
  await expect.poll(()=>state.updates.length).toBe(1);const input=state.updates[0]!;
  expect(input).toMatchObject({repository:{owner:'alex',name:'design-system'},repositoryId:repository.id,pullRequestId:pull.id,number:12,expectedRevision:pull.revision});
  expect(input.title).toBe(field==='title'?'Edited proposal':undefined);expect(input.body).toBe(field==='body'?'':undefined);
  expect(input.draft).toBe(field==='draft'?true:field==='ready'?false:undefined);
  expect(input.state).toBe(field==='close'?IssueState.CLOSED:field==='reopen'?IssueState.OPEN:IssueState.UNSPECIFIED);
  const saved=await intentRows(page);expect(saved).toHaveLength(1);expect(JSON.parse(saved[0]![1])).toEqual({key:input.idempotencyKey,kind:'pull-update',repositoryId:repository.id,issueId:'',pullRequestId:pull.id,number:12,editField:field});
  release();await expect(editor).toHaveCount(0);expect(await intentRows(page)).toEqual([]);
  if(field==='title')await expect(page.getByRole('heading',{name:'Edited proposal #12'})).toBeVisible();
 });
}
test('PR editing preserves unsent draft and old revision across revalidation; rejection requires a fresh review',async({page})=>{
 const state=await backend(page);await page.goto('/alex/design-system/pull/12');await page.getByRole('button',{name:'Edit pull request title',exact:true}).click();
 await page.getByLabel('Pull request title',{exact:true}).fill('PRIVATE_UNSENT');
 state.pull=create(PullRequestSchema,{...state.pull,title:'Concurrent title',revision:'c'.repeat(64)});
 await page.getByRole('button',{name:'Refresh pull request',exact:true}).click();await expect(page.getByRole('heading',{name:'Concurrent title #12'})).toBeVisible();
 await expect(page.getByLabel('Pull request title',{exact:true})).toHaveValue('PRIVATE_UNSENT');state.updateFailure='revision_changed';
 await page.getByRole('button',{name:'Save changes',exact:true}).click();await expect(page.getByText(/changed before this request was sent/)).toBeVisible();expect(state.updates[0]!.expectedRevision).toBe(pull.revision);
 await page.getByRole('button',{name:'Review current pull request',exact:true}).click();await page.getByRole('button',{name:'Edit pull request title',exact:true}).click();await expect(page.getByLabel('Pull request title',{exact:true})).toHaveValue('Concurrent title');
 state.updateFailure='';await page.getByLabel('Pull request title',{exact:true}).fill('Freshly reviewed');await page.getByRole('button',{name:'Save changes',exact:true}).click();await expect(page.getByRole('heading',{name:'Freshly reviewed #12'})).toBeVisible();expect(state.updates[1]!.expectedRevision).toBe('c'.repeat(64));expect(state.updates[1]!.idempotencyKey).not.toBe(state.updates[0]!.idempotencyKey);
});
for(const mode of ['unknown','wrongMutation','wrongObject','missingObject','dropUpdate'] as const) {
 test(`PR ${mode} keeps the metadata key and never automatically resends`,async({page})=>{
  const state=await backend(page);state[mode]=true;await page.goto('/alex/design-system/pull/12');await page.getByRole('button',{name:'Edit pull request description',exact:true}).click();
  await page.getByLabel('Description, Markdown',{exact:true}).fill('PRIVATE_DESCRIPTION');await page.getByRole('button',{name:'Save changes',exact:true}).click();await expect(page.getByRole('button',{name:'Check request status',exact:true})).toBeEnabled();
  expect(JSON.stringify(await intentRows(page))).not.toContain('PRIVATE_DESCRIPTION');await page.reload();await expect(page.getByText(/This resumed request supports status checks only/)).toBeVisible();
  await page.getByRole('button',{name:'Check request status',exact:true}).click();await expect.poll(()=>state.inspections.length).toBe(1);expect(state.updates).toHaveLength(1);
  if(mode==='dropUpdate'){await expect(page.getByRole('region',{name:'Edit description',exact:true})).toHaveCount(0);expect(await intentRows(page)).toEqual([]);}else{expect(await intentRows(page)).toHaveLength(1);await expect(page.getByRole('button',{name:'Save changes',exact:true})).toHaveCount(0);}
 });
}
test('PR merged lifecycle controls are absent, unverified edits stay disabled, and mobile editors keep focus and fit',async({page})=>{
 const state=await backend(page);await page.goto('/alex/design-system/pull/13');await expect(page.getByRole('button',{name:'Reopen pull request',exact:true})).toHaveCount(0);await expect(page.getByRole('button',{name:'Convert to draft',exact:true})).toHaveCount(0);
 await page.goto('/alex/design-system/pull/12');state.pull.revision='';await page.getByRole('button',{name:'Refresh pull request',exact:true}).click();await expect(page.getByRole('button',{name:'Edit pull request title',exact:true})).toBeDisabled();
 state.pull.revision=pull.revision;await page.getByRole('button',{name:'Refresh pull request',exact:true}).click();await expect(page.getByRole('button',{name:'Edit pull request description',exact:true})).toBeEnabled();await page.setViewportSize({width:390,height:844});
 for(const theme of ['dark','light']){if(await page.locator('html').getAttribute('data-theme')!==theme)await page.getByRole('button',{name:`Switch to ${theme} theme`,exact:true}).click();await page.getByLabel('More pull request actions',{exact:true}).click();await page.getByRole('button',{name:'Edit pull request description',exact:true}).click();await expect(page.getByLabel('Description, Markdown',{exact:true})).toBeFocused();expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);await page.screenshot({path:`test-results/pr-edit-mobile-${theme}.png`,fullPage:true});await page.getByRole('button',{name:'Close editor',exact:true}).click();await expect(page.getByLabel('More pull request actions',{exact:true})).toBeFocused();}
 expect(state.updates).toHaveLength(0);
});

test('diff disclosures fit mobile viewports, return keyboard focus, and close safely when resizing',async({page})=>{
 await backend(page);await page.goto('/alex/design-system/pull/12/files');
 for(const theme of ['dark','light'])for(const width of [320,390]) {
  await page.evaluate(value=>document.documentElement.dataset.theme=value,theme);await page.setViewportSize({width,height:560});
  for(const name of ['Diff settings','File filter']) {
   const trigger=page.getByLabel(name,{exact:true});
   await trigger.click();const popup=page.locator('.diff-options[open] .diff-options-content');await expect(popup).toBeVisible();
   await expect.poll(async()=>{const box=await popup.boundingBox();return Boolean(box&&box.y>=0&&box.y+box.height<=560);}).toBe(true);
   expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
   await trigger.press('Escape');await expect(popup).toHaveCount(0);await expect(trigger).toBeFocused();
  }
 }
 await page.getByLabel('Diff settings',{exact:true}).click();await page.getByLabel('Wrap lines',{exact:true}).focus();
 await page.setViewportSize({width:1280,height:900});await expect(page.locator('.diff-options[open]')).toHaveCount(0);await expect(page.getByLabel('Diff settings',{exact:true})).toBeFocused();
});


test('mobile PR action disclosure dismisses without dispatch and private editors clear on access loss',async({page})=>{
 await page.setViewportSize({width:390,height:900});const state=await backend(page);await page.goto('/alex/design-system/pull/12');
 const summary=page.getByLabel('More pull request actions',{exact:true});const menu=page.locator('.pull-action-menu');
 await expect(page.getByRole('button',{name:'Edit pull request title',exact:true})).toHaveCount(0);
 await summary.focus();await summary.press('Enter');await expect(menu).toHaveAttribute('open','');
 await page.getByRole('button',{name:'Edit pull request title',exact:true}).focus();await page.keyboard.press('Escape');await expect(menu).not.toHaveAttribute('open');await expect(summary).toBeFocused();
 await summary.click();await page.getByRole('link',{name:'All open pull requests',exact:true}).focus();await expect(menu).not.toHaveAttribute('open');expect(state.updates).toHaveLength(0);
 await summary.click();await page.getByRole('button',{name:'Edit pull request title',exact:true}).click();await page.getByLabel('Pull request title',{exact:true}).fill('PRIVATE_MOBILE_UNSENT');
 state.metadataStatus=404;await page.getByRole('button',{name:'Refresh repository access',exact:true}).click();await expect(page.getByRole('alert')).toHaveText('Repository not found or inaccessible.');
 await expect(menu).toHaveCount(0);await expect(page.getByLabel('Pull request title',{exact:true})).toHaveCount(0);expect(await page.locator('body').innerText()).not.toContain('PRIVATE_MOBILE_UNSENT');expect(state.updates).toHaveLength(0);
});


test('merged conversation keeps readable compact empty panels without advertising another merge',async({page})=>{
 const state=await backend(page);
 await page.route('**/rpc/golf.v1.RepositoryService/ListPullRequestReviews',route=>respond(route,ListPullRequestReviewsResponseSchema,{}));
 await page.goto('/alex/design-system/pull/13');
 await expect(page.locator('.pull-detail .pull-state')).toHaveText('Merged');
 await expect(page.getByRole('region',{name:'Pull request merge observation',exact:true})).toHaveCount(0);
 await expect(page.getByRole('region',{name:'Standard native merge',exact:true})).toHaveCount(0);
 await expect(page.getByRole('button',{name:'Edit pull request title',exact:true})).toBeEnabled();
 for(const width of [390,1440])for(const theme of ['dark','light']){
  await page.setViewportSize({width,height:900});await page.evaluate(value=>document.documentElement.dataset.theme=value,theme);await page.evaluate(()=>document.fonts.ready);
  if(width===390){await page.getByLabel('More pull request actions',{exact:true}).click();await expect(page.getByRole('button',{name:'Edit pull request description',exact:true})).toBeVisible();}
  await expect(page.getByRole('button',{name:/^(Reopen|Close) pull request$/})).toHaveCount(0);
  await expect(page.getByRole('button',{name:/^(Convert to draft|Ready for review)$/})).toHaveCount(0);
  if(width===390)await page.getByLabel('More pull request actions',{exact:true}).press('Escape');
  for(const selector of ['.pull-reviews > .empty-state','.issue-comments > .empty-state']){
   const empty=page.locator(selector);await expect(empty).toBeVisible();
   const box=await empty.boundingBox();expect(box!.height).toBeLessThan(180);
   expect(await empty.locator('h3').evaluate(element=>parseFloat(getComputedStyle(element).fontSize))).toBeGreaterThanOrEqual(16);
  }
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
 }
 expect(state.updates).toHaveLength(0);expect(state.methods).not.toContain('GetPullRequestMergeObservation');expect(state.methods).not.toContain('SubmitStandardPullMerge');
});

test('merged pull request retains explicit original-success inspection through current inventory refresh',async({page})=>{
 const state=await backend(page),operationId='3a2d1ef1-3cb7-4da2-81f2-123456789abc';let reads=0;
 const original={operationId,actorId:user.id,repository:{owner:'alex',name:'design-system'},repositoryId:repository.id,ownerId:user.id,pullRequestId:closed.id,number:closed.number,expectedPullRevision:pull.revision,headCommitId:head,baseCommitId:base,sourceRef:closed.head!.ref,targetRef:closed.base!.ref};
 await page.addInitScript(original=>sessionStorage.setItem(`golf.standard-merge.v1:${location.origin}:${original.actorId}:${original.repositoryId}:${original.pullRequestId}`,JSON.stringify(original)),original);
 await page.route('**/rpc/golf.v1.StandardPullMergeService/GetStandardPullMergeOperation',route=>{reads++;return respond(route,GetStandardPullMergeOperationResponseSchema,{operation:{...original,observedBaseCommitId:base,phase:StandardPullMergePhase.SUCCEEDED,mergeCommitId:merged,actualBaseCommitId:base,method:'merge',contract:'golf.pull.standard-native-merge.v1',createdAt:'2026-10-04T12:00:00Z',updatedAt:'2026-10-04T12:01:00Z'}});});
 await page.goto('/alex/design-system/pull/13');
 const history=page.getByRole('region',{name:'Standard native merge',exact:true});
 await expect(history.getByRole('button',{name:'Inspect original merge',exact:true})).toBeEnabled();expect(reads).toBe(0);
 await expect(page.getByRole('region',{name:'Pull request merge observation',exact:true})).toHaveCount(0);
 await history.getByRole('button',{name:'Inspect original merge',exact:true}).click();
 await expect(history.getByRole('status')).toContainText('Native merge confirmed.');
 await page.getByRole('button',{name:'Refresh pull request',exact:true}).click();await expect(history.getByRole('status')).toContainText('Native merge confirmed.');
 expect(reads).toBe(1);expect(state.updates).toHaveLength(0);expect(state.methods).not.toContain('SubmitStandardPullMerge');
});

for (const theme of ['dark', 'light']) for (const width of [1440, 390]) test(`loaded PR activity sorting excludes unavailable comment counts in ${theme} ${width}px`, async ({ page }) => {
  const state = await backend(page), titles = ['Old proposal', 'Offset proposal', 'Recent proposal', 'Missing proposal'] as const;
  state.listRows = ['2026-10-01T12:00:00Z', '2026-10-03T01:00:00+02:00', '2026-10-03T00:00:00Z', 'invalid'].map((updatedAt, index) => create(PullRequestSchema, { ...pull, id: String(100 + index), number: 20 + index, title: titles[index]!, updatedAt }));
  await page.setViewportSize({ width, height: 900 }); await page.addInitScript(theme => localStorage.setItem('golf.theme', theme), theme); await page.goto('/alex/design-system/pulls');
  const names = page.locator('.pull-list>li h3 a'), sort = page.getByRole('combobox', { name: 'Sort loaded pull requests', exact: true });
  await expect(names).toHaveText(titles.slice(0, 2)); await expect(sort.locator('option[value="most-commented"],option[value="least-commented"]')).toHaveCount(0); await sort.selectOption('updated-newest'); await expect(names).toHaveText([titles[1], titles[0]]);
  await page.getByRole('button', { name: 'Load more pull requests', exact: true }).click(); await expect(names).toHaveText([titles[2], titles[1], titles[0], titles[3]]); await sort.selectOption('updated-oldest'); await expect(names).toHaveText([titles[0], titles[1], titles[2], titles[3]]);
  await sort.selectOption('provider'); await expect(names).toHaveText(titles); const search = page.getByRole('searchbox', { name: 'Search loaded pull requests', exact: true }); await search.fill('proposal'); await sort.selectOption('updated-newest'); await expect(names).toHaveText([titles[2], titles[1], titles[0], titles[3]]); await search.fill('Offset'); await expect(names).toHaveText([titles[1]]); await expect(page.getByText('1 of 4 loaded', { exact: true })).toBeVisible(); await search.clear(); await expect(names).toHaveCount(4);
  await page.evaluate(() => document.fonts.ready); expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true); await page.screenshot({ path: test.info().outputPath(`pull-activity-${theme}-${width}.png`), fullPage: true });
  state.listStatus = 403; await page.getByRole('button', { name: 'Refresh pull requests', exact: true }).click(); await expect(page.getByRole('alert')).toBeVisible(); await expect(names).toHaveCount(0); expect(await page.evaluate(() => JSON.stringify({ ...localStorage, ...sessionStorage }))).not.toContain('Offset proposal'); expect(state.methods.some(method => /^(Create|Save|Update|Delete|Merge|Submit)/.test(method))).toBe(false);
});

test.describe('native milestone calendar dates', () => {
  test.use({ timezoneId: 'America/New_York', locale: 'en-US' });
for (const theme of ['dark', 'light']) for (const width of [1440, 390]) test(`known native PR metadata preserves conversation controls and private access in ${theme} ${width}px`, async ({ page }) => {
  const state = await backend(page); state.pull.metadata = create(DiscussionMetadataSchema, { labelsKnown: true, assigneesKnown: true, milestoneKnown: true,
    labels: [create(DiscussionLabelSchema, { id: '41', name: 'PRIVATE_PR_LABEL keyboard', color: '00AaBb', description: 'Native accessibility work', archived: true })], assignees: [create(UserSchema, { ...user, login: 'PRIVATE_PR_ASSIGNEE', fullName: 'Alex' })], milestone: create(DiscussionMilestoneSchema, { id: '51', title: 'PRIVATE_PR_MILESTONE release', description: 'Native release scope', state: IssueState.CLOSED, openIssues: 0n, closedIssues: 18n, dueOn: '2026-12-01T00:00:00Z' }) });
  await page.setViewportSize({ width, height: 900 }); await page.addInitScript(theme => localStorage.setItem('golf.theme', theme), theme); await page.goto('/alex/design-system/pull/12');
  const sidebar = page.getByRole('complementary', { name: 'Pull request metadata', exact: true }), metadata = sidebar.locator('.discussion-metadata'); await expect(metadata.getByRole('region', { name: 'Labels', exact: true })).toContainText('PRIVATE_PR_LABEL keyboard'); await expect(metadata.locator('.discussion-label-swatch circle')).toHaveAttribute('fill', '#00AaBb'); await expect(metadata.getByRole('region', { name: 'Assignees', exact: true })).toContainText('PRIVATE_PR_ASSIGNEE'); await expect(metadata.locator('.discussion-milestone-state')).toHaveText('Closed'); await expect(metadata.locator('dd')).toHaveText(['0', '18']); await expect(metadata.locator('.discussion-milestone-due time')).toHaveAttribute('datetime', '2026-12-01T00:00:00Z'); await expect(metadata.locator('.discussion-milestone-due time')).toHaveText('Dec 1, 2026'); await expect(metadata.locator('.discussion-milestone-due time')).toHaveAttribute('title', 'Dec 1, 2026'); await expect(sidebar.getByText('Comparison details', { exact: true })).toBeVisible(); if (width === 390) { const menu = page.getByLabel('More pull request actions', { exact: true }); await menu.click(); await expect(page.getByRole('button', { name: 'Edit pull request title', exact: true })).toBeVisible(); await menu.press('Escape'); } else await expect(page.getByRole('button', { name: 'Edit pull request title', exact: true })).toBeVisible(); await expect(page.getByRole('button', { name: 'Add a comment', exact: true })).toBeVisible(); await expect(page.getByRole('navigation', { name: 'Pull request workspace', exact: true }).getByRole('link')).toHaveCount(4); await expect(metadata.locator('button,input,select,form,[style],img,script,a')).toHaveCount(0); await expect(page.getByRole('button', { name: 'Edit issue assignees', exact: true })).toHaveCount(0); expect(state.methods).toContain('ListRepositoryAssignees');
  await page.evaluate(() => document.fonts.ready); expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true); await page.screenshot({ path: test.info().outputPath(`pull-metadata-${theme}-${width}.png`), fullPage: true });
  let release!: () => void; state.detailWait = new Promise<void>(resolve => { release = resolve; }); await page.getByRole('button', { name: 'Refresh pull request', exact: true }).click(); await expect(metadata).toBeHidden(); release(); state.detailWait = undefined; await expect(metadata).toBeVisible();
  state.detailStatus = 403; await page.getByRole('button', { name: 'Refresh pull request', exact: true }).click(); await expect(page.getByRole('alert')).toContainText('not found or inaccessible'); await expect(metadata).toHaveCount(0); await expect(page.getByText('PRIVATE_PR_ASSIGNEE', { exact: true })).toHaveCount(0); expect(await page.evaluate(() => JSON.stringify({ ...localStorage, ...sessionStorage }))).not.toMatch(/PRIVATE_PR_LABEL|PRIVATE_PR_ASSIGNEE|PRIVATE_PR_MILESTONE/); expect(state.methods.some(method => /^(Create|Save|Update|Delete|Merge|Submit)/.test(method))).toBe(false);
});
});

test('PR metadata omits unknown categories without hiding the existing merge and comparison sidebar', async ({ page }) => {
  const state = await backend(page); await page.goto('/alex/design-system/pull/12'); const sidebar = page.getByRole('complementary', { name: 'Pull request metadata', exact: true }); await expect(sidebar.locator('.discussion-metadata')).toHaveCount(0); await expect(sidebar.getByText('Comparison details', { exact: true })).toBeVisible();
  state.pull.metadata = create(DiscussionMetadataSchema, { labelsKnown: true, assignees: [user], milestone: { id: '51', title: 'UNVERIFIED_MILESTONE' } }); await page.getByRole('button', { name: 'Refresh pull request', exact: true }).click(); await expect(sidebar.getByRole('region', { name: 'Labels', exact: true })).toHaveText('LabelsNone'); await expect(sidebar.getByRole('region', { name: 'Assignees', exact: true })).toHaveCount(0); await expect(sidebar.getByRole('region', { name: 'Milestone', exact: true })).toHaveCount(0); await expect(sidebar).not.toContainText('UNVERIFIED_MILESTONE'); await expect(sidebar.getByText('Comparison details', { exact: true })).toBeVisible();
  state.pull.metadata = create(DiscussionMetadataSchema, { labelsKnown: true, assigneesKnown: true, milestoneKnown: true }); await page.getByRole('button', { name: 'Refresh pull request', exact: true }).click(); await expect(sidebar.locator('.discussion-metadata>section')).toHaveText(['AssigneesNone', 'LabelsNone', 'MilestoneNone']);
});


test.describe('pull request metadata editing',()=>{
 test('changes and clears all metadata with exact PR intent and explicit inventory unit',async({page})=>{
  const state=await backend(page);state.metadataCanEdit=true;state.pull.metadata=create(DiscussionMetadataSchema,{labelsKnown:true,assigneesKnown:true,milestoneKnown:true});
  await page.goto('/alex/design-system/pull/12');
  for(const field of ['milestone','labels','assignees'] as const){
   await page.getByRole('button',{name:`Edit pull request ${field}`,exact:true}).click();
   const editor=page.getByRole('region',{name:`Edit pull request ${field}`,exact:true});
   await expect(editor).toBeVisible();
   await expect(page.getByRole('button',{name:'Edit pull request title',exact:true})).toBeDisabled();
   if(field==='milestone')await editor.getByRole('combobox',{name:'Issue milestone',exact:true}).selectOption('51');
   else await editor.getByRole('checkbox',{name:field==='labels'?'bug':'bob',exact:true}).check();
   await editor.getByRole('button',{name:'Save changes',exact:true}).click();
   await expect(editor).toHaveCount(0);
   const input=state.updates.at(-1)!;expect(input.pullRequestId).toBe(pull.id);expect(input.expectedRevision).toMatch(/^[ef]{64}$/);expect(input.repositoryId).toBe(repository.id);expect(input.title).toBeUndefined();expect(input.body).toBeUndefined();expect(input.state).toBe(IssueState.UNSPECIFIED);
   if(field==='milestone')expect(input.milestone).toMatchObject({expectedMilestoneId:'0',milestoneId:'51'});
   if(field==='labels')expect(input.labels).toMatchObject({expectedLabelIds:[],labelIds:['41']});
   if(field==='assignees')expect(input.assignees).toMatchObject({expectedAssigneeIds:[],assignees:[{id:'9007199254740996',login:'bob'}]});
   await page.getByRole('button',{name:`Edit pull request ${field}`,exact:true}).click();
   if(field==='milestone')await editor.getByRole('combobox',{name:'Issue milestone',exact:true}).selectOption('0');
   else await editor.getByRole('checkbox',{name:field==='labels'?'bug':'bob',exact:true}).uncheck();
   await editor.getByRole('button',{name:'Save changes',exact:true}).click();await expect(editor).toHaveCount(0);
   if(field==='milestone')expect(state.updates.at(-1)!.milestone).toMatchObject({expectedMilestoneId:'51',milestoneId:'0'});
   if(field==='labels')expect(state.updates.at(-1)!.labels).toMatchObject({expectedLabelIds:['41'],labelIds:[]});
   if(field==='assignees')expect(state.updates.at(-1)!.assignees).toMatchObject({expectedAssigneeIds:['9007199254740996'],assignees:[]});
  }
  expect(state.updates).toHaveLength(6);expect(state.inspections).toHaveLength(0);
 });
 test('uncertain metadata reload only inspects original PR key',async({page})=>{
  const state=await backend(page);state.metadataCanEdit=true;state.unknown=true;state.pull.metadata=create(DiscussionMetadataSchema,{labelsKnown:true,assigneesKnown:true,milestoneKnown:true});
  await page.goto('/alex/design-system/pull/12');await page.getByRole('button',{name:'Edit pull request labels',exact:true}).click();await page.getByRole('checkbox',{name:'bug',exact:true}).check();await page.getByRole('button',{name:'Save changes',exact:true}).click();
  await expect(page.getByText('This request may still be running, or its outcome is unknown.',{exact:false})).toBeVisible();const key=state.updates[0]!.idempotencyKey;
  await page.reload();await expect(page.getByRole('button',{name:'Check request status',exact:true})).toBeVisible();await page.getByRole('button',{name:'Check request status',exact:true}).click();await expect.poll(()=>state.inspections).toEqual([key]);expect(state.updates).toHaveLength(1);expect(await page.evaluate(()=>JSON.stringify(sessionStorage))).not.toContain('bug');
 });
 test('capability loss keeps pending metadata draft disabled',async({page})=>{
  const state=await backend(page);state.metadataCanEdit=true;state.pull.metadata=create(DiscussionMetadataSchema,{labelsKnown:true,assigneesKnown:true,milestoneKnown:true});await page.goto('/alex/design-system/pull/12');await page.getByRole('button',{name:'Edit pull request assignees',exact:true}).click();await page.getByRole('checkbox',{name:'bob',exact:true}).check();
  state.metadataCanEdit=false;await page.getByRole('button',{name:'Refresh pull request',exact:true}).click();await expect(page.getByRole('button',{name:'Save changes',exact:true})).toBeDisabled();expect(state.updates).toHaveLength(0);
 });
});


test('repository PR filters force supported newest order and preserve base branch',async({page})=>{
 const state=await backend(page);await page.goto('/alex/design-system/pulls');await page.getByRole('button',{name:'Show repository filters',exact:true}).click();await page.getByLabel('Base branch',{exact:true}).fill('release/next');await page.getByRole('combobox',{name:'Repository pull request sort',exact:true}).selectOption('most-commented');await page.getByRole('searchbox',{name:'Search repository pull requests',exact:true}).fill('keyboard');await expect(page.getByRole('combobox',{name:'Repository pull request sort',exact:true})).toHaveValue('newest');await expect(page.getByRole('combobox',{name:'Repository pull request sort',exact:true})).toBeDisabled();await page.getByRole('button',{name:'Apply filters',exact:true}).click();await expect.poll(()=>state.serverQueries.at(-1)).toMatchObject({query:{search:'keyboard'},sort:'newest',baseBranch:'release/next'});await expect(page).toHaveURL(/q=keyboard/);await page.getByRole('button',{name:'Clear repository filters',exact:true}).click();await expect.poll(()=>state.serverQueries.at(-1)).toMatchObject({query:{search:''},sort:'',baseBranch:''});
});
