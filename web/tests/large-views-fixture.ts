import { portableRuntimeFixture } from './runtime-fixture';
import type { Page } from '@playwright/test';
import { create } from '@bufbuild/protobuf';
import {
  GetAuthenticationOptionsResponseSchema, GetCommitDiffRequestSchema, GetCommitDiffResponseSchema, CommitDiffBase, GetContentsResponseSchema, GetDiscussionEngagementResponseSchema,
  GetIssueResponseSchema, GetPullRequestDiffResponseSchema, GetPullRequestDiscussionResponseSchema, GetPullRequestResponseSchema, GetRepositoryResponseSchema, GetSessionResponseSchema,
  IssueCommentSchema, IssueSchema, IssueState, ListCapabilitiesResponseSchema, ListDiscussionTimelineResponseSchema, ListIssueCommentsRequestSchema, ListIssueCommentsResponseSchema,
  ListIssuesRequestSchema, ListIssuesResponseSchema, ListPullRequestReviewsResponseSchema, ListPullRequestsRequestSchema, ListPullRequestsResponseSchema, ListRepositoriesResponseSchema,
  ListReviewerRunsResponseSchema, PullRequestSchema, RepositorySchema, SourceEntryType, UserSchema,
} from '../src/gen/golf/v1/golf_pb';
import type { Issue, IssueComment, PullRequest } from '../src/gen/golf/v1/golf_pb';
import { disabledAgentTasks, reject, request, resolveSourceFixture, respond } from './rpc';

// Large private issue, pull request, conversation and diff inventories for render tests. Every row carries a PRIVATE marker
// so tests can check that a denial or sign-out hides all of it.
export const user = create(UserSchema, { id: '9007199254740993', login: 'alex', fullName: 'Alex' });
export const repository = create(RepositorySchema, { id: '9007199254740995', name: 'large', fullName: 'alex/large', private: true, defaultBranch: 'main' });
export const base = 'a'.repeat(40), head = 'b'.repeat(40), commit = 'c'.repeat(40);
const day = (index: number) => new Date(Date.UTC(2026, 0, 1) + index * 3_600_000).toISOString().replace('.000', '');
export const issues: Issue[] = Array.from({ length: 500 }, (_, index) => create(IssueSchema, { id: String(9007199254741000n + BigInt(index)), number: 500 - index, title: `PRIVATE issue ${500 - index}: keyboard focus ${index % 7}`, state: index % 5 ? IssueState.OPEN : IssueState.CLOSED, user, comments: index % 13, createdAt: day(index), updatedAt: day(index + 1), revision: 'a'.repeat(64) }));
export const pulls: PullRequest[] = Array.from({ length: 500 }, (_, index) => create(PullRequestSchema, { id: String(9007199254742000n + BigInt(index)), number: 1000 - index, title: `PRIVATE pull ${1000 - index}: focus rings ${index % 7}`, state: index % 5 ? IssueState.OPEN : IssueState.CLOSED, merged: index % 10 === 0, draft: index % 9 === 0, user, createdAt: day(index), updatedAt: day(index + 1), revision: 'e'.repeat(64), mergeBaseCommitId: base,
  base: { repositoryId: repository.id, label: 'alex:main', ref: 'main', commitId: base }, head: { repositoryId: repository.id, label: `alex:feature/${index}`, ref: `feature/${index}`, commitId: head } }));
export const issue = issues[0]!, pull = pulls[0]!;
const discussionIssueId = '9007199254743999';
export const comments: IssueComment[] = Array.from({ length: 300 }, (_, index) => create(IssueCommentSchema, { id: String(9007199254744000n + BigInt(index)), user, body: `PRIVATE comment ${index}\n\nThis comment has **Markdown**, a [link](https://example.test/${index}) and \`code\`.\n\n- one\n- two`, createdAt: day(index), updatedAt: day(index), revision: 'b'.repeat(64) }));
// 100 TypeScript files, two hunks each: 4,400 diff rows with syntax colours.
export const rawDiff = Array.from({ length: 100 }, (_, file) => {
  const path = `src/area-${file % 10}/module-${String(file).padStart(3, '0')}.ts`, line = (n: number) => `  const value${n} = compute(${n}, 'PRIVATE ${file}');`;
  const hunk = (start: number) => [`@@ -${start},18 +${start},22 @@ export function module${file}() {`, ...Array.from({ length: 8 }, (_, n) => ' ' + line(start + n)), ...Array.from({ length: 4 }, (_, n) => '-' + line(start + 8 + n)), ...Array.from({ length: 8 }, (_, n) => '+' + line(start + 100 + n)), ...Array.from({ length: 6 }, (_, n) => ' ' + line(start + 12 + n))];
  return [`diff --git a/${path} b/${path}`, 'index 1111111..2222222 100644', `--- a/${path}`, `+++ b/${path}`, ...hunk(10), ...hunk(200)].join('\n');
}).join('\n') + '\n';

export const largeURLs = { issues: '/repositories/alex/large?view=issues', issue: `/repositories/alex/large?view=issues&issue=${issue.number}`, pulls: '/repositories/alex/large?view=pulls', pull: `/repositories/alex/large?view=pulls&pull=${pull.number}`, files: `/repositories/alex/large?view=pulls&pull=${pull.number}&pullView=files`, commit: `/repositories/alex/large?view=commits&commit=${commit}` };

type Failure = 'permission_denied' | 'unauthenticated';
export async function largeBackend(page: Page) {
  // firstPage rows arrive on page 1 and the rest on page 2; a test that loads more reads the remainder.
  const state = { signedIn: true, firstPage: Infinity, methods: [] as string[], errors: {} as Record<string, Failure>, barrier: undefined as Promise<void> | undefined, barrierMethod: '' };
  const pageOf = <T,>(rows: T[], number: number) => number === 1 ? { rows: rows.slice(0, state.firstPage), next: rows.length > state.firstPage ? 2 : 0 } : { rows: rows.slice(state.firstPage), next: 0 };
  await page.route('**/rpc/**', async route => {
    const method = new URL(route.request().url()).pathname.split('/').at(-1)!;
    state.methods.push(method);
    if (method === 'GetAuthenticationOptions') return respond(route, GetAuthenticationOptionsResponseSchema, { localPasswordEnabled: true });
    if (state.errors[method]) { if (state.errors[method] === 'unauthenticated') state.signedIn = false; return reject(route, state.errors[method]!, 'Access revoked.'); }
    if (!state.signedIn) return reject(route, 'unauthenticated', 'Sign in required.');
    if (state.barrier && method === state.barrierMethod) await state.barrier;
    if (method === 'GetSession') return respond(route, GetSessionResponseSchema, { user });
    if (method === 'ListCapabilities') return respond(route, ListCapabilitiesResponseSchema, portableRuntimeFixture);
    if (method === 'ListRepositories') return respond(route, ListRepositoriesResponseSchema, { repositories: [repository] });
    if (method === 'GetRepository') return respond(route, GetRepositoryResponseSchema, { repository });
    if (method === 'ResolveRepositorySource') return resolveSourceFixture(route, repository.id, { owner: 'alex', name: 'large' }, 'main', { main: base });
    if (method === 'GetContents') return respond(route, GetContentsResponseSchema, { repositoryId: repository.id, kind: SourceEntryType.DIRECTORY, commitId: base, entries: [] });
    if (method === 'ListAgentTasks') return disabledAgentTasks(route);
    if (method === 'ListIssues') { const { rows, next } = pageOf(issues, request(route, ListIssuesRequestSchema).page?.page || 1); return respond(route, ListIssuesResponseSchema, { issues: rows, page: next ? { nextPage: next } : undefined }); }
    if (method === 'ListPullRequests') { const { rows, next } = pageOf(pulls, request(route, ListPullRequestsRequestSchema).page?.page || 1); return respond(route, ListPullRequestsResponseSchema, { pullRequests: rows, page: next ? { nextPage: next } : undefined }); }
    if (method === 'GetIssue') return respond(route, GetIssueResponseSchema, { issue });
    if (method === 'GetPullRequest') return respond(route, GetPullRequestResponseSchema, { pullRequest: pull });
    if (method === 'GetPullRequestDiscussion') return respond(route, GetPullRequestDiscussionResponseSchema, { issue: { id: discussionIssueId, number: pull.number, title: pull.title, state: IssueState.OPEN } });
    if (method === 'ListIssueComments') { const { rows, next } = pageOf(comments, request(route, ListIssueCommentsRequestSchema).page?.page || 1); return respond(route, ListIssueCommentsResponseSchema, { comments: rows, page: next ? { nextPage: next } : undefined }); }
    if (method === 'GetDiscussionEngagement') return respond(route, GetDiscussionEngagementResponseSchema, { actorLogin: 'alex', revision: 'c'.repeat(64), canReact: true, canSubscribe: true, reactions: ['+1', 'heart'].map(content => ({ content, count: 0, reacted: false })) });
    if (method === 'ListDiscussionTimeline') return respond(route, ListDiscussionTimelineResponseSchema, {});
    if (method === 'ListPullRequestReviews') return respond(route, ListPullRequestReviewsResponseSchema, {});
    if (method === 'ListReviewerRuns') return respond(route, ListReviewerRunsResponseSchema, {});
    if (method === 'GetPullRequestDiff') return respond(route, GetPullRequestDiffResponseSchema, { repositoryId: repository.id, pullRequestId: pull.id, mergeBaseCommitId: base, baseCommitId: base, headCommitId: head, rawDiff, byteSize: new TextEncoder().encode(rawDiff).byteLength });
    if (method === 'GetCommitDiff') { const commitId = request(route, GetCommitDiffRequestSchema).commitId; return respond(route, GetCommitDiffResponseSchema, { commit: { sha: commitId, message: 'PRIVATE large change', authorName: 'Alex', authoredAt: day(0) }, base: CommitDiffBase.FIRST_PARENT, baseCommitId: base, parentCommitIds: [base], rawDiff, byteSize: new TextEncoder().encode(rawDiff).byteLength }); }
    return reject(route, 'unimplemented', 'Outside the large-view fixture.');
  });
  return state;
}
