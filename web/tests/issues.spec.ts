import { portableRuntimeFixture } from './runtime-fixture';
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { create } from '@bufbuild/protobuf';
import {
  ListIssueTemplatesResponseSchema, ListOwnForgeNotificationsRequestSchema, ListOwnForgeNotificationsResponseSchema,
  GetDiscussionEngagementRequestSchema, GetDiscussionEngagementResponseSchema, ListDiscussionTimelineResponseSchema,
  SubmitDiscussionResourceOperationRequestSchema, SubmitDiscussionResourceOperationResponseSchema, GetDiscussionResourceOperationRequestSchema, GetDiscussionResourceOperationResponseSchema, DiscussionResourceOperationKind, DiscussionResourceOperationPhase, DiscussionResourceOperationSchema,
  ListRepositoryAssigneesRequestSchema, ListRepositoryAssigneesResponseSchema, ListRepositoryLabelsRequestSchema, ListRepositoryLabelsResponseSchema, ListRepositoryMilestonesRequestSchema, ListRepositoryMilestonesResponseSchema, DiscussionMetadataSchema, DiscussionMilestoneSchema, DiscussionLabelSchema, UpdateIssueRequestSchema, UpdateIssueResponseSchema, CreateIssueRequestSchema, CreateIssueResponseSchema, CreateIssueCommentRequestSchema, CreateIssueCommentResponseSchema,
  GetAuthenticationOptionsResponseSchema, GetIssueMutationRequestSchema, GetIssueMutationResponseSchema, GetIssueResponseSchema,
  GetRepositoryResponseSchema, GetSessionResponseSchema, IssueCommentSchema, IssueMutationKind, IssueMutationSchema, IssueMutationState,
  IssueSchema, IssueState, ListCapabilitiesResponseSchema, ListIssueCommentsRequestSchema, ListIssueCommentsResponseSchema,
  ListIssuesRequestSchema, ListIssuesResponseSchema, ListRepositoriesResponseSchema, LoginWithPasswordResponseSchema, LogoutResponseSchema, RepositorySchema, UserSchema,
} from '../src/gen/golf/v1/golf_pb';
import type { CreateIssueRequest, CreateIssueCommentRequest, UpdateIssueRequest, IssueMutation, Issue, SubmitDiscussionResourceOperationRequest, DiscussionResourceOperation } from '../src/gen/golf/v1/golf_pb';
import { reject, request, respond } from './rpc';

const user = create(UserSchema, { id: '9007199254740993', login: 'alex' });
const repository = create(RepositorySchema, { id: '9007199254740995', name: 'project', fullName: 'alex/project', private: true, empty: true });
const repoKey = { owner: 'alex', name: 'project' };
const issue = create(IssueSchema, { id: '9007199254740997', number: 12, title: 'Private discussion', body: 'PRIVATE_BODY <script>alert(1)</script>', state: IssueState.OPEN, user, createdAt: '2026-10-02T12:00:00Z', updatedAt: '2026-10-02T12:00:00Z', revision: 'a'.repeat(64) });
const comment = create(IssueCommentSchema, { id: '9007199254740998', user, body: '<img src=x onerror="window.executed=true">\n[unsafe](javascript:alert(1))', createdAt: '2026-10-02T12:00:00Z', updatedAt: '2026-10-02T12:00:00Z', htmlUrl: 'javascript:alert(1)' });
const listURL = '/repositories/alex/project?view=issues';
const detailURL = `${listURL}&issue=12`;
type Failure = 'permission_denied' | 'not_found' | 'unauthenticated' | 'unavailable' | 'already_exists';

async function backend(page: Page, native = false, engagement = false) {
  const state = {
    user, signedIn: true, repoId: repository.id, issueId: issue.id, issue: { ...issue }, comments: [comment],
    issueReadWait: undefined as Promise<void> | undefined, issueRows: undefined as Issue[] | undefined, listPages: [] as number[], serverQueries: [] as unknown[], emptyFirst: false, unknown: false, drop: false, rejected: false, missingObject: false, mismatch: false,
    updates: [] as UpdateIssueRequest[], updateFailure: '', creates: [] as CreateIssueRequest[], posts: [] as CreateIssueCommentRequest[], inspections: [] as string[], pages: [] as number[],
    canEditAssignees: false, assignees: [create(UserSchema,{id:'9007199254740993',login:'PRIVATE_ASSIGNEE_A',fullName:'Alex Reviewer'}),create(UserSchema,{id:'12',login:'PRIVATE_ASSIGNEE_B'})], assigneeReads: 0, assigneeWait: undefined as Promise<void> | undefined,
    canEditLabels: false, labels: [create(DiscussionLabelSchema,{id:"9",name:"PRIVATE_LABEL_A",color:"aabbcc"}),create(DiscussionLabelSchema,{id:"12",name:"PRIVATE_LABEL_B",color:"aaff00"})], labelPages: [] as number[], labelMore: false,
    canEditMilestone: false, milestones: [create(DiscussionMilestoneSchema, { id:'51', title:'PRIVATE_MILESTONE_A', state:IssueState.OPEN }), create(DiscussionMilestoneSchema, { id:'52', title:'PRIVATE_MILESTONE_B', state:IssueState.CLOSED })], milestonePages: [] as number[], milestoneMore:false,
    methods: [] as string[], reaction:false,subscribed:false,engagementReads:0,canEngage:true,notificationUnread:true,templateEnabled:false,yamlTemplate:false,
    canManage: false, resourceUnknown:false, resourceRequests: [] as SubmitDiscussionResourceOperationRequest[], resourceRecords:new Map<string,DiscussionResourceOperation>(), resourceInspections:[] as string[],
    records: new Map<string, IssueMutation>(), errors: {} as Record<string, Failure>, barrier: undefined as Promise<void> | undefined,
  };
  await page.route('**/rpc/**', async (route) => {
    const method = new URL(route.request().url()).pathname.split('/').at(-1)!;
    state.methods.push(method);
    if (method === 'GetAuthenticationOptions') return respond(route, GetAuthenticationOptionsResponseSchema, { localPasswordEnabled: true });
    if (method === 'LoginWithPassword') { state.signedIn = true; return respond(route, LoginWithPasswordResponseSchema, { user: state.user }); }
    if (method === 'Logout') { state.signedIn = false; return respond(route, LogoutResponseSchema, {}); }
    if (state.errors[method]) { if (state.errors[method] === 'unauthenticated') state.signedIn = false; return reject(route, state.errors[method], method === 'CreateIssueComment' ? 'Posting requires write:issue.' : 'Discussion request unavailable or denied.'); }
    if (!state.signedIn) return reject(route, 'unauthenticated', 'Sign in required.');
    if (method === 'GetRepositoryStar') return reject(route, 'unimplemented', 'Stars are outside this issue fixture.');
    if (method === 'GetSession') return respond(route, GetSessionResponseSchema, { user: state.user });
    if (method === 'ListCapabilities') return respond(route, ListCapabilitiesResponseSchema, native ? {runtimeProfile:'cloudflare-native',capabilities:[{id:'discussion.resources',state:3},{id:'discussion.comments',state:3},...(engagement?[{id:'discussion.activity',state:3}]:[])]} : portableRuntimeFixture);
    if (method === 'ListRepositories') return respond(route, ListRepositoriesResponseSchema, { repositories: [repository] });
    if (method === 'GetRepository') return respond(route, GetRepositoryResponseSchema, { repository: { ...repository, id: state.repoId } });
    if (method === 'ListRepositoryAssignees') {
      const input=request(route,ListRepositoryAssigneesRequestSchema);expect(input.repository).toMatchObject(repoKey);expect(input.repositoryId).toBe(state.repoId);expect(Object.keys(input).sort()).toEqual(['$typeName','pullRequest','repository','repositoryId']);state.assigneeReads++;
      if(state.assigneeWait)await state.assigneeWait;
      return respond(route,ListRepositoryAssigneesResponseSchema,{assignees:state.assignees,canEditAssignees:state.canEditAssignees});
    }
    if (method === 'ListRepositoryLabels') {
      const input=request(route,ListRepositoryLabelsRequestSchema);expect(input.repository).toMatchObject(repoKey);expect(input.repositoryId).toBe(state.repoId);const number=input.page?.page||1;state.labelPages.push(number);
      return respond(route,ListRepositoryLabelsResponseSchema,{canManage:state.canManage,labels:state.labelMore?state.labels.slice(number-1,number):state.labels,canEditLabels:state.canEditLabels,page:state.labelMore&&number===1?{nextPage:2}:undefined});
    }
    if (method === 'ListRepositoryMilestones') {
      const input=request(route,ListRepositoryMilestonesRequestSchema); expect(input.repository).toMatchObject(repoKey);expect(input.repositoryId).toBe(state.repoId);expect(input.state).toBe(IssueState.ALL);
      const number=input.page?.page||1;state.milestonePages.push(number);
      return respond(route,ListRepositoryMilestonesResponseSchema,{canManage:state.canManage,milestones:state.milestoneMore?state.milestones.slice(number-1,number):state.milestones,canEditMilestone:state.canEditMilestone,page:state.milestoneMore&&number===1?{nextPage:2}:undefined});
    }
    if (method === 'ListIssues') {
      const input = request(route, ListIssuesRequestSchema), number = input.page?.page || 1; state.listPages.push(number); state.serverQueries.push(input.query);
      return respond(route, ListIssuesResponseSchema, state.issueRows ? { issues: state.issueRows.slice((number - 1) * 2, number * 2), page: number === 1 ? { nextPage: 2 } : undefined } : { issues: [state.issue] });
    }
    if (method === 'GetIssue') { if (state.issueReadWait) await state.issueReadWait; return respond(route, GetIssueResponseSchema, { issue: { ...state.issue, id: state.issueId } }); }
    if(method==='ListIssueTemplates'&&state.yamlTemplate)return respond(route,ListIssueTemplatesResponseSchema,{commitId:'a'.repeat(40),templates:[{path:'.github/ISSUE_TEMPLATE/bug.yml',name:'Structured bug',about:'A useful form',title:'[Bug]',blobId:'b'.repeat(40),fields:[{id:'intro',type:'markdown',value:'Please provide enough detail.'},{id:'version',type:'input',label:'Version',required:true,minLength:3},{id:'details',type:'textarea',label:'Logs',render:'shell'},{id:'platform',type:'dropdown',label:'Platform',required:true,options:[{label:'Linux'},{label:'macOS'}],defaultOption:0},{id:'agreement',type:'checkboxes',label:'Agreement',options:[{label:'I checked existing issues.',required:true}]}]}]});
    if (method === 'ListIssueTemplates') return respond(route,ListIssueTemplatesResponseSchema,state.templateEnabled?{commitId:'a'.repeat(40),templates:[{path:'.github/ISSUE_TEMPLATE/bug.md',name:'Bug report',about:'Reproduce a bug',title:'[Bug]',body:'## Steps\n',blobId:'b'.repeat(40)}]}:{});
    if(method==='ListOwnForgeNotifications'){const input=request(route,ListOwnForgeNotificationsRequestSchema);return respond(route,ListOwnForgeNotificationsResponseSchema,{notifications:state.notificationUnread||input.includeRead?[{id:'901',target:{repository:repoKey,repositoryId:state.repoId,issueId:state.issueId,number:12},title:'Private discussion',unread:state.notificationUnread,updatedAt:'2026-10-05T00:00:00Z',revision:'d'.repeat(64)}]:[]});}
    if (method === 'GetDiscussionEngagement') { const input=request(route,GetDiscussionEngagementRequestSchema);expect(input.target?.issueId).toBe(state.issueId);state.engagementReads++;return respond(route,GetDiscussionEngagementResponseSchema,{actorLogin:'alex',revision:'c'.repeat(64),canReact:state.canEngage,canSubscribe:state.canEngage&&!input.target?.commentId,subscribed:state.subscribed,reactions:['+1','-1','laugh','hooray','confused','heart','rocket','eyes'].map(content=>({content,count:content==='+1'&&state.reaction?1:0,reacted:content==='+1'&&state.reaction}))}); }
    if (method === 'ListDiscussionTimeline') return respond(route,ListDiscussionTimelineResponseSchema,{events:[{id:'72',kind:'change_title',actor:user,createdAt:'2026-10-05T00:00:00Z',oldTitle:'Before',newTitle:'After'}]});
    if (method === 'ListIssueComments') {
      const input = request(route, ListIssueCommentsRequestSchema);
      expect(input.repository).toMatchObject(repoKey); expect(input.repositoryId).toBe(state.repoId);
      expect(input.issueId).toBe(state.issueId); expect(input.number).toBe(12); expect(input.page?.limit).toBe(20);
      const number = input.page?.page || 1; state.pages.push(number);
      return respond(route, ListIssueCommentsResponseSchema, state.emptyFirst && number === 1 ? { page: { nextPage: 2 } } : { comments: state.comments });
    }
    if(method==='SubmitDiscussionResourceOperation') {
      const input=request(route,SubmitDiscussionResourceOperationRequestSchema);state.resourceRequests.push(input);
      const record=create(DiscussionResourceOperationSchema,{operationId:input.operationId,kind:input.kind,repository:repoKey,repositoryId:input.repositoryId,resourceId:input.resourceId,expectedRevision:input.expectedRevision,issueId:input.issueId,number:input.number,pullRequest:input.pullRequest,reactionComment:input.reactionComment,phase:state.resourceUnknown?DiscussionResourceOperationPhase.DISPATCH_UNKNOWN:DiscussionResourceOperationPhase.SUCCEEDED,observedResourceId:input.resourceId||'71',createdAt:'2026-10-05T00:00:00Z',updatedAt:'2026-10-05T00:00:00Z'});state.resourceRecords.set(input.operationId,record);
      if(!state.resourceUnknown) {
        if(input.kind===DiscussionResourceOperationKind.ADD_REACTION)state.reaction=true;
        if(input.kind===DiscussionResourceOperationKind.REMOVE_REACTION)state.reaction=false;
        if(input.kind===DiscussionResourceOperationKind.SUBSCRIBE)state.subscribed=true;
        if(input.kind===DiscussionResourceOperationKind.UNSUBSCRIBE)state.subscribed=false;
        if(input.kind===DiscussionResourceOperationKind.MARK_NOTIFICATION_READ)state.notificationUnread=false;
        if(input.kind===DiscussionResourceOperationKind.CREATE_LABEL||input.kind===DiscussionResourceOperationKind.UPDATE_LABEL){const d=input.change.case==='label'?input.change.value:undefined;if(d){const row=create(DiscussionLabelSchema,{id:input.resourceId||'71',name:d.name,color:d.color,description:d.description,exclusive:d.exclusive,archived:d.archived,revision:'b'.repeat(64)});state.labels=[...state.labels.filter(r=>r.id!==row.id),row];}}
        if(input.kind===DiscussionResourceOperationKind.DELETE_LABEL)state.labels=state.labels.filter(r=>r.id!==input.resourceId);
        if(input.kind===DiscussionResourceOperationKind.UPDATE_MILESTONE){const d=input.change.case==='milestone'?input.change.value:undefined;if(d)state.milestones=state.milestones.map(r=>r.id===input.resourceId?create(DiscussionMilestoneSchema,{...r,title:d.title,description:d.description,state:d.state,dueOn:d.dueDate?d.dueDate+'T23:59:59Z':'',revision:'b'.repeat(64)}):r);}
        if(input.kind===DiscussionResourceOperationKind.UPDATE_COMMENT)state.comments=state.comments.map(r=>r.id===input.resourceId?{...r,body:input.change.case==='commentBody'?input.change.value:r.body,revision:'b'.repeat(64)}:r);
        if(input.kind===DiscussionResourceOperationKind.DELETE_COMMENT)state.comments=state.comments.filter(r=>r.id!==input.resourceId);
      }
      return respond(route,SubmitDiscussionResourceOperationResponseSchema,{operation:record});
    }
    if(method==='GetDiscussionResourceOperation'){const key=request(route,GetDiscussionResourceOperationRequestSchema).operationId;state.resourceInspections.push(key);const record=state.resourceRecords.get(key);return record?respond(route,GetDiscussionResourceOperationResponseSchema,{operation:record}):reject(route,'not_found','No original outcome.');}
    if (method === 'UpdateIssue') {
      const input = request(route, UpdateIssueRequestSchema); state.updates.push(input);
      const mutation = create(IssueMutationSchema, {
        id: '9007199254740999', idempotencyKey: input.idempotencyKey, repository: repoKey, repositoryId: input.repositoryId,
        kind: IssueMutationKind.UPDATE_ISSUE, state: state.updateFailure ? IssueMutationState.REJECTED : state.unknown ? IssueMutationState.OUTCOME_UNKNOWN : IssueMutationState.SUCCEEDED,
        issueId: state.issueId, number: 12, failureCode: state.updateFailure,
      });
      state.records.set(input.idempotencyKey, mutation);
      if (!state.updateFailure) state.issue = { ...state.issue, ...(input.title !== undefined ? { title: input.title } : {}), ...(input.body !== undefined ? { body: input.body } : {}), ...(input.state !== IssueState.UNSPECIFIED ? { state: input.state } : {}), ...(input.milestone ? {metadata: create(DiscussionMetadataSchema,{...create(DiscussionMetadataSchema,state.issue.metadata),milestoneKnown:true,milestone:state.milestones.find(row=>row.id===input.milestone!.milestoneId)})}:{}), ...(input.assignees ? {metadata:create(DiscussionMetadataSchema,{...create(DiscussionMetadataSchema,state.issue.metadata),assigneesKnown:true,assignees:input.assignees.assignees.map(selection=>state.assignees.find(row=>row.id===selection.id)! )})}:{}), ...(input.labels ? {metadata: create(DiscussionMetadataSchema,{...create(DiscussionMetadataSchema,state.issue.metadata),labelsKnown:true,labels:state.labels.filter(row=>input.labels!.labelIds.includes(row.id))})}:{}), revision: 'b'.repeat(64) };
      if (state.barrier) await state.barrier;
      if (state.drop) return route.abort('failed');
      return respond(route, UpdateIssueResponseSchema, { mutation: state.mismatch ? { ...mutation, issueId: '9999' } : mutation, issue: mutation.state === IssueMutationState.SUCCEEDED && !state.missingObject ? state.issue : undefined });
    }
    if (method === 'CreateIssue' || method === 'CreateIssueComment') {
      const isComment = method === 'CreateIssueComment';
      const input = isComment ? request(route, CreateIssueCommentRequestSchema) : request(route, CreateIssueRequestSchema);
      if (isComment) state.posts.push(input as CreateIssueCommentRequest); else state.creates.push(input as CreateIssueRequest);
      const mutation = create(IssueMutationSchema, {
        id: '9007199254740999', idempotencyKey: input.idempotencyKey, repository: repoKey, repositoryId: input.repositoryId,
        kind: isComment ? IssueMutationKind.CREATE_COMMENT : IssueMutationKind.CREATE_ISSUE,
        state: state.rejected ? IssueMutationState.REJECTED : state.unknown ? IssueMutationState.OUTCOME_UNKNOWN : IssueMutationState.SUCCEEDED,
        issueId: state.issueId, number: 12, commentId: isComment ? comment.id : '', createdAt: '2026-10-02T12:00:00Z', updatedAt: '2026-10-02T12:00:00Z',
        failureCode: state.rejected ? 'target_changed' : '',
      });
      state.records.set(input.idempotencyKey, mutation);
      if (!isComment) state.issue = { ...issue, title: (input as CreateIssueRequest).title, body: input.body };
      else state.comments = [{ ...comment, body: input.body }];
      if (state.barrier) await state.barrier;
      if (state.drop) return route.abort('failed');
      const visible = mutation.state === IssueMutationState.SUCCEEDED && !state.missingObject;
      const returned = state.mismatch ? { ...mutation, repositoryId: '9999' } : mutation;
      return isComment ? respond(route, CreateIssueCommentResponseSchema, { mutation: returned, comment: visible ? state.comments[0] : undefined }) : respond(route, CreateIssueResponseSchema, { mutation: returned, issue: visible ? state.issue : undefined });
    }
    if (method === 'GetIssueMutation') {
      const key = request(route, GetIssueMutationRequestSchema).idempotencyKey; state.inspections.push(key);
      const mutation = state.records.get(key);
      if (!mutation) return reject(route, 'not_found', 'No matching outcome record is available.');
      const visible = mutation.state === IssueMutationState.SUCCEEDED && !state.missingObject;
      return respond(route, GetIssueMutationResponseSchema, { mutation: state.mismatch ? { ...mutation, issueId: '9999' } : mutation, issue: visible && mutation.kind !== IssueMutationKind.CREATE_COMMENT ? state.issue : undefined, comment: visible && mutation.kind === IssueMutationKind.CREATE_COMMENT ? state.comments[0] : undefined });
    }
    return reject(route, 'not_found', 'Unknown fixture RPC.');
  });
  return state;
}
const stored = (page: Page) => page.evaluate(() => Object.entries(sessionStorage).filter(([key]) => key.startsWith('golf.issue-intent.')));
function enableAssignees(state: Awaited<ReturnType<typeof backend>>) {
  state.canEditAssignees = true;
  state.issue.metadata = create(DiscussionMetadataSchema, { assigneesKnown: true, assignees: [state.assignees[0]!] });
}
async function newIssue(page: Page) {
  await page.goto(listURL);
  await page.getByRole('button', { name: 'New issue', exact: true }).click();
  await expect(page).toHaveURL(/issues\/new$/);
  return page.getByRole('region', { name: 'New issue', exact: true });
}

test('creates a plain-text issue once with immutable target IDs and follows its typed detail link', async ({ page }) => {
  const state = await backend(page);
  const dialog = await newIssue(page);
  await dialog.getByLabel('Issue title').fill('  New private discussion  ');
  const body = '  PRIVATE_DRAFT\n<img src=x onerror="window.executed=true">\t';
  await dialog.getByLabel('Description, plain text').fill(body);
  let release!: () => void; state.barrier = new Promise<void>((resolve) => { release = resolve; });
  await dialog.locator('form').evaluate((form: HTMLFormElement) => { form.requestSubmit(); form.requestSubmit(); });
  await expect.poll(() => state.creates.length).toBe(1);
  expect(state.creates[0]).toMatchObject({ repository: repoKey, repositoryId: repository.id, title: 'New private discussion', body });
  expect(state.creates[0]!.idempotencyKey).toMatch(/^[a-f0-9-]{14}4[a-f0-9-]{21}$/);
  await expect(dialog.getByLabel('Issue title')).toBeDisabled();
  release();
  await expect(page).toHaveURL(/issues\/12$/);
  await expect(page.getByLabel('Issue body, rendered Markdown')).toContainText('PRIVATE_DRAFT');
  await expect(page.locator('.issue-body img')).toHaveCount(0);
  expect(await stored(page)).toEqual([]);
  expect(await page.evaluate(() => 'executed' in window)).toBe(false);
});

test('unknown creation closes and reloads with metadata only, and resumes status without reposting', async ({ page }) => {
  const state = await backend(page); state.drop = true;
  const dialog = await newIssue(page);
  await dialog.getByLabel('Issue title').fill('PRIVATE_TITLE');
  await dialog.getByLabel('Description, plain text').fill('PRIVATE_DRAFT');
  await dialog.getByRole('button', { name: 'Create issue', exact: true }).click();
  await expect(dialog.getByRole('alert')).toBeVisible();
  const key = state.creates[0]!.idempotencyKey;
  const rows = await stored(page);
  expect(rows).toHaveLength(1);
  expect(rows[0]![0]).toContain(`:${user.id}:${repository.id}:new`);
  expect(JSON.parse(rows[0]![1])).toEqual({ key, kind: 'issue', repositoryId: repository.id, issueId: '', number: 0 });
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Resume issue request' })).toBeVisible();
  await page.reload();
  await page.getByRole('button', { name: 'Resume issue request' }).click();
  await expect(page.getByLabel('Issue title')).toHaveValue('');
  await expect(page.getByLabel('Description, plain text')).toHaveValue('');
  expect(state.creates).toHaveLength(1); expect(state.inspections).toHaveLength(0);
  await page.getByRole('button', { name: 'Check request status' }).click();
  await expect(page).toHaveURL(/issues\/12$/);
  expect(state.creates).toHaveLength(1); expect(state.inspections).toEqual([key]);
  expect(await stored(page)).toEqual([]);
});

test('unknown and historic success without current access do not allow a new creation request', async ({ page }) => {
  const state = await backend(page); state.unknown = true;
  const dialog = await newIssue(page);
  await dialog.getByLabel('Issue title').fill('Kept intent');
  await dialog.getByRole('button', { name: 'Create issue', exact: true }).click();
  await expect(dialog.getByText('This request may still be running, or its outcome is unknown.', { exact: false })).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Start a new request' })).toHaveCount(0);
  await dialog.getByRole('button', { name: 'Check request status' }).click();
  expect(state.creates).toHaveLength(1);
  state.records.get(state.creates[0]!.idempotencyKey)!.state = IssueMutationState.SUCCEEDED;
  state.missingObject = true;
  await dialog.getByRole('button', { name: 'Check request status' }).click();
  await expect(dialog.getByText(/recorded as successful, but Golf cannot confirm current access/)).toBeVisible();
  await expect(dialog.getByLabel('Issue title')).toBeDisabled();
  expect(await stored(page)).toHaveLength(1);
});

test('rejected mutation requires an explicit new intent with a new UUID and editable form', async ({ page }) => {
  const state = await backend(page); state.rejected = true;
  const dialog = await newIssue(page);
  await dialog.getByLabel('Issue title').fill('Original title');
  await dialog.getByRole('button', { name: 'Create issue', exact: true }).click();
  await expect(dialog.getByText(/target changed before this write was sent/)).toBeVisible();
  const first = state.creates[0]!.idempotencyKey;
  await dialog.getByRole('button', { name: 'Start a new request' }).click();
  await expect(dialog.getByLabel('Issue title')).toBeEnabled();
  await expect(dialog.getByLabel('Issue title')).toBeFocused();
  await dialog.getByLabel('Issue title').fill('Explicit second request');
  await dialog.getByRole('button', { name: 'Create issue', exact: true }).click();
  await expect.poll(() => state.creates.length).toBe(2);
  expect(state.creates[1]!.idempotencyKey).not.toBe(first);
});

test('preflight validates UTF-8 byte bounds and controls before reserving a key or sending', async ({ page }) => {
  const state = await backend(page);
  const dialog = await newIssue(page);
  await dialog.getByLabel('Issue title').fill('é'.repeat(128));
  await dialog.getByRole('button', { name: 'Create issue', exact: true }).click();
  await expect(dialog.getByRole('alert')).toContainText('1–255 UTF-8 bytes');
  await dialog.getByLabel('Issue title').fill('Valid title');
  await dialog.getByLabel('Description, plain text').fill('é'.repeat(3001));
  await dialog.getByRole('button', { name: 'Create issue', exact: true }).click();
  await expect(dialog.getByRole('alert')).toContainText('6,000 UTF-8 bytes');
  for (const text of ['before\u0000after', '\ud800']) {
    await dialog.getByLabel('Description, plain text').evaluate((input: HTMLTextAreaElement, text) => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(input, text);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    }, text);
    await dialog.getByRole('button', { name: 'Create issue', exact: true }).click();
    await expect(dialog.getByRole('alert')).toContainText('No request was sent.');
  }
  expect(state.creates).toEqual([]); expect(await stored(page)).toEqual([]);
  await expect(dialog.getByLabel('Issue title')).toBeEnabled();
});

test('comments advance across an empty native page, render literal text and preserve typed navigation', async ({ page }) => {
  const state = await backend(page); state.emptyFirst = true;
  await page.goto(detailURL);
  await expect(page.getByRole('heading', { name: 'No comments in the loaded pages.' })).toBeVisible();
  expect(state.pages.length).toBeGreaterThan(0); expect(state.pages.every((number) => number === 1)).toBe(true);
  await page.getByRole('button', { name: 'Load more comments' }).click();
  await expect(page.getByLabel(`Comment ${comment.id}, rendered Markdown`)).toContainText('image preview unavailable');
  expect(state.pages.at(-1)).toBe(2); expect(state.pages.filter((number) => number === 2)).toHaveLength(1);
  await expect(page.locator('.issue-comment img, .issue-comment a[href^="javascript:"]')).toHaveCount(0);
  await page.getByRole('link', { name: 'All open issues' }).click();
  await expect(page).toHaveURL(/issues$/);
  await page.goBack();
  await expect(page.getByLabel('Issue body, rendered Markdown')).toBeVisible();
  await page.reload();
  await expect(page.getByLabel('Issue body, rendered Markdown')).toBeVisible();
});

test('posts comment exactly once, validates native result IDs and clears its persisted intent', async ({ page }) => {
  const state = await backend(page);
  await page.goto(detailURL);
  const body = '  New private comment\n<img src=x onerror=alert(1)>\t';
  await page.getByRole('button', { name: 'Add a comment', exact: true }).click();
  await page.getByLabel('Comment, plain text', { exact: true }).fill(body);
  let release!: () => void; state.barrier = new Promise<void>((resolve) => { release = resolve; });
  await page.locator('.issue-composer form').evaluate((form: HTMLFormElement) => { form.requestSubmit(); form.requestSubmit(); });
  await expect.poll(() => state.posts.length).toBe(1);
  expect(state.posts[0]).toMatchObject({ repository: repoKey, repositoryId: repository.id, issueId: issue.id, number: 12, body });
  release();
  await expect(page.getByText('Comment posted.', { exact: true })).toBeVisible();
  expect(await stored(page)).toEqual([]);
  await page.getByRole('button', { name: 'Write another comment' }).click();
  await expect(page.getByLabel('Comment, plain text', { exact: true })).toHaveValue('');
  await expect(page.getByLabel('Comment, plain text', { exact: true })).toBeFocused();
});

test('comment lost response resumes lookup only after reload without storing body or title', async ({ page }) => {
  const state = await backend(page); state.drop = true;
  await page.goto(detailURL);
  await page.getByRole('button', { name: 'Add a comment', exact: true }).click();
  await page.getByLabel('Comment, plain text', { exact: true }).fill('PRIVATE_COMMENT');
  await page.getByRole('button', { name: 'Post comment' }).click();
  await expect(page.getByRole('alert')).toBeVisible();
  const key = state.posts[0]!.idempotencyKey;
  expect(JSON.parse((await stored(page))[0]![1])).toEqual({ key, kind: 'comment', repositoryId: repository.id, issueId: issue.id, number: 12 });
  await page.reload();
  await expect(page.getByLabel('Comment, plain text', { exact: true })).toHaveValue('');
  await expect(page.getByLabel('Comment, plain text', { exact: true })).toBeDisabled();
  expect(state.posts).toHaveLength(1); expect(state.inspections).toEqual([]);
  await page.getByRole('button', { name: 'Check request status' }).click();
  await expect(page.getByText('Comment posted.', { exact: true })).toBeVisible();
  expect(state.inspections).toEqual([key]); expect(state.posts).toHaveLength(1);
});

test('mismatched write/status records never become success or unlock a repost', async ({ page }) => {
  const state = await backend(page); state.mismatch = true;
  await page.goto(detailURL);
  await page.getByRole('button', { name: 'Add a comment', exact: true }).click();
  await page.getByLabel('Comment, plain text', { exact: true }).fill('Private mismatch draft');
  await page.getByRole('button', { name: 'Post comment' }).click();
  await expect(page.getByRole('alert')).toContainText('does not match this request');
  await expect(page.getByText('Comment posted.', { exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Check request status' }).click();
  await expect(page.getByRole('alert')).toContainText('does not match this request');
  expect(state.posts).toHaveLength(1);
  await expect(page.getByRole('button', { name: 'Start a new request' })).toHaveCount(0);
});

test('comment scope denial clears the draft and read denial removes prior discussion and controls', async ({ page }) => {
  const state = await backend(page);
  await page.goto(detailURL);
  await page.getByRole('button', { name: 'Add a comment', exact: true }).click();
  await page.getByLabel('Comment, plain text', { exact: true }).fill('PRIVATE_DRAFT');
  state.errors.CreateIssueComment = 'permission_denied';
  await page.getByRole('button', { name: 'Post comment' }).click();
  await expect(page.getByRole('alert')).toContainText('write:issue');
  await expect(page.getByLabel('Comment, plain text', { exact: true })).toHaveValue('');
  state.errors.ListIssueComments = 'permission_denied';
  await page.getByRole('button', { name: 'Refresh comments' }).click();
  await expect(page.getByLabel('Issue body, rendered Markdown')).toHaveCount(0);
  await expect(page.locator('.issue-comment')).toHaveCount(0);
  await expect(page.getByLabel('Comment, plain text', { exact: true })).toHaveCount(0);
});

test('expired session, sign-out and account switch clear pending private convenience data', async ({ page }) => {
  const state = await backend(page); state.unknown = true;
  const dialog = await newIssue(page);
  await dialog.getByLabel('Issue title').fill('PRIVATE_TITLE');
  await dialog.getByRole('button', { name: 'Create issue', exact: true }).click();
  await expect(dialog.getByRole('button', { name: 'Check request status' })).toBeEnabled();
  state.errors.GetIssueMutation = 'unauthenticated';
  await dialog.getByRole('button', { name: 'Check request status' }).click();
  await expect(page.getByRole('heading', { name: 'Welcome to Golf' })).toBeVisible();
  await expect.poll(() => stored(page)).toEqual([]);
  await page.evaluate(() => sessionStorage.setItem('golf.issue-intent.other-origin:other-user:999:new', '{"key":"stale"}'));
  delete state.errors.GetIssueMutation;
  state.user = create(UserSchema, { id: '22', login: 'other' });
  await page.getByLabel('Email or username', { exact: true }).fill('fixture-account'); await page.getByLabel('Password', { exact: true }).fill('fixture'); await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByLabel('Your account', { exact: true })).toBeVisible();
  await expect.poll(() => stored(page)).toEqual([]);
  await page.evaluate(() => sessionStorage.setItem('golf.issue-intent.synthetic', '{}'));
  await page.getByLabel('Your account', { exact: true }).click(); await page.getByRole('button', { name: 'Sign out' }).click();
  await expect.poll(() => stored(page)).toEqual([]);
});

test('target IDs namespace resumed requests and prevent reuse for a replaced repository or issue', async ({ page }) => {
  const state = await backend(page); state.unknown = true;
  await page.goto(detailURL);
  await page.getByRole('button', { name: 'Add a comment', exact: true }).click();
  await page.getByLabel('Comment, plain text', { exact: true }).fill('Original target draft');
  await page.getByRole('button', { name: 'Post comment' }).click();
  await expect(page.getByRole('button', { name: 'Check request status' })).toBeEnabled();
  state.issueId = '777';
  await page.reload();
  await page.getByRole('button', { name: 'Add a comment', exact: true }).click();
  await expect(page.getByLabel('Comment, plain text', { exact: true })).toBeEnabled();
  await expect(page.getByRole('button', { name: 'Check request status' })).toHaveCount(0);
  expect(state.inspections).toEqual([]); expect(state.posts).toHaveLength(1);
  state.repoId = '888';
  await page.reload();
  await page.getByRole('button', { name: 'Add a comment', exact: true }).click();
  await expect(page.getByLabel('Comment, plain text', { exact: true })).toBeEnabled();
  expect(state.posts).toHaveLength(1);
});

test('issue creation page and discussion remain keyboard usable in charcoal and light mobile layouts', async ({ page }) => {
  await backend(page);
  await page.addInitScript(() => localStorage.setItem('golf.theme', 'dark'));
  const errors: string[] = []; page.on('pageerror', (error) => errors.push(error.message));
  const dialog = await newIssue(page);
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await dialog.getByLabel('Issue title').focus(); await page.keyboard.press('Tab');
  await expect(dialog.getByRole('button', { name: 'Write', exact: true })).toBeFocused();
  await page.keyboard.press('Tab'); await expect(dialog.getByRole('button', { name: 'Preview Markdown', exact: true })).toBeFocused();
  await page.keyboard.press('Tab'); await expect(dialog.getByLabel('Description, plain text')).toBeFocused();
  await page.screenshot({ path: 'test-results/issues-create-dark.png', fullPage: true });
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(page.getByRole('button', { name: 'New issue', exact: true })).toBeVisible();
  await page.goto(detailURL);
  if (await page.locator('html').getAttribute('data-theme') !== 'light') await page.getByRole('button', { name: 'Switch to light theme', exact: true }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: 'Add a comment', exact: true }).click();
  await expect(page.getByLabel('Comment, plain text', { exact: true })).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: 'test-results/issues-mobile-light.png', fullPage: true });
  expect(errors).toEqual([]);
});

test('discussion opens an editor only on request and closing discards the draft', async ({ page }) => {
  const state = await backend(page);
  await page.goto(detailURL);
  await expect(page.getByLabel('Comment, plain text', { exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Add a comment', exact: true }).click();
  await page.getByLabel('Comment, plain text', { exact: true }).fill('Discard this private draft');
  await page.getByRole('button', { name: 'Close comment editor', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Add a comment', exact: true })).toBeFocused();
  await page.getByRole('button', { name: 'Add a comment', exact: true }).click();
  await expect(page.getByLabel('Comment, plain text', { exact: true })).toHaveValue('');
  expect(state.posts).toHaveLength(0);
});

for (const field of ['title', 'body', 'close', 'reopen'] as const) {
  test(`issue ${field} action sends only one field with the displayed revision and native IDs`, async ({ page }) => {
    const state = await backend(page);
    if (field === 'reopen') state.issue.state = IssueState.CLOSED;
    await page.goto(detailURL);
    await expect(page.getByLabel('Issue title', { exact: true })).toHaveCount(0);
    const trigger = field === 'title' ? 'Edit issue title' : field === 'body' ? 'Edit issue description' : field === 'close' ? 'Close issue' : 'Reopen issue';
    await page.getByRole('button', { name: trigger, exact: true }).click();
    const editor = page.getByRole('region', { name: field === 'title' ? 'Edit issue title' : field === 'body' ? 'Edit issue description' : 'Confirm issue state', exact: true });
    if (field === 'title') await editor.getByLabel('Issue title', { exact: true }).fill(' Edited title ');
    if (field === 'body') {
      await page.getByRole('button', { name: 'Add a comment', exact: true }).click();
      await editor.getByLabel('Description, Markdown', { exact: true }).fill('');
      // The description and comment editor must never share label IDs.
      expect(await page.locator('#issue-edit-body-input').count()).toBe(1);
      await expect(page.getByLabel('Comment, plain text', { exact: true })).toHaveValue('');
    }
    let release!: () => void; state.barrier = new Promise<void>((resolve) => { release = resolve; });
    await editor.locator('form').evaluate((form: HTMLFormElement) => { form.requestSubmit(); form.requestSubmit(); });
    await expect.poll(() => state.updates.length).toBe(1);
    const input = state.updates[0]!;
    expect(input).toMatchObject({ repository: repoKey, repositoryId: repository.id, issueId: issue.id, number: issue.number, expectedRevision: issue.revision });
    expect(input.title).toBe(field === 'title' ? 'Edited title' : undefined);
    expect(input.body).toBe(field === 'body' ? '' : undefined);
    expect(input.state).toBe(field === 'close' ? IssueState.CLOSED : field === 'reopen' ? IssueState.OPEN : IssueState.UNSPECIFIED);
    const saved = await stored(page); expect(saved).toHaveLength(1);
    expect(JSON.parse(saved[0]![1])).toEqual({ key: input.idempotencyKey, kind: 'update', repositoryId: repository.id, issueId: issue.id, number: issue.number, editField: field });
    release(); await expect(editor).toHaveCount(0); expect(await stored(page)).toEqual([]);
    if (field === 'title') await expect(page.getByRole('heading', { name: /Edited title #12/ })).toBeVisible();
    if (field === 'body') await expect(page.getByLabel('Issue body, rendered Markdown')).toContainText('No description provided.');
    if (field === 'close') { await expect(page.getByRole('button', { name: 'Reopen issue', exact: true })).toBeEnabled(); await expect(page.locator('.discussion-summary-meta .issue-state svg')).toHaveClass(/lucide-circle-check/); }
    if (field === 'reopen') await expect(page.getByRole('button', { name: 'Close issue', exact: true })).toBeEnabled();
  });
}

test('issue edit cancellation discards private text and stale forms require an explicit fresh review', async ({ page }) => {
  const state = await backend(page); await page.goto(detailURL);
  await page.getByRole('button', { name: 'Edit issue title', exact: true }).click();
  await page.getByLabel('Issue title', { exact: true }).fill('PRIVATE_UNSENT');
  await page.getByRole('button', { name: 'Close editor', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Edit issue title', exact: true })).toBeFocused();
  await page.getByRole('button', { name: 'Edit issue title', exact: true }).click();
  await expect(page.getByLabel('Issue title', { exact: true })).toHaveValue(issue.title);
  await page.getByLabel('Issue title', { exact: true }).fill('PRIVATE_STALE');
  state.issue = { ...state.issue, title: 'Concurrent title', revision: 'c'.repeat(64) };
  await page.getByRole('button', { name: 'Refresh issue', exact: true }).click();
  await expect(page.getByRole('heading', { name: /Concurrent title #12/ })).toBeVisible();
  await expect(page.getByLabel('Issue title', { exact: true })).toHaveValue('PRIVATE_STALE');
  state.updateFailure = 'revision_changed';
  await page.getByRole('button', { name: 'Save changes', exact: true }).click();
  await expect(page.getByText(/changed before this request was sent/)).toBeVisible();
  expect(state.updates[0]!.expectedRevision).toBe(issue.revision);
  await page.getByRole('button', { name: 'Review current issue', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Edit issue title', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: 'Edit issue title', exact: true }).click();
  await expect(page.getByLabel('Issue title', { exact: true })).toHaveValue('Concurrent title');
  state.updateFailure = '';
  await page.getByLabel('Issue title', { exact: true }).fill('Fresh review');
  await page.getByRole('button', { name: 'Save changes', exact: true }).click();
  await expect(page.getByRole('heading', { name: /Fresh review #12/ })).toBeVisible();
  expect(state.updates[1]!.expectedRevision).toBe('c'.repeat(64));
  expect(state.updates[1]!.idempotencyKey).not.toBe(state.updates[0]!.idempotencyKey);
});

test('lost issue-edit acknowledgement reloads with metadata only and never sends another PATCH', async ({ page }) => {
  const state = await backend(page); state.drop = true; await page.goto(detailURL);
  await page.getByRole('button', { name: 'Edit issue description', exact: true }).click();
  await page.getByLabel('Description, Markdown', { exact: true }).fill('PRIVATE_CHANGED_BODY');
  await page.getByRole('button', { name: 'Save changes', exact: true }).click();
  await expect(page.getByRole('alert')).toBeVisible();
  const key = state.updates[0]!.idempotencyKey;
  expect(JSON.stringify(await stored(page))).not.toContain('PRIVATE_CHANGED_BODY');
  await page.reload();
  await expect(page.getByText('This resumed request supports status checks only.', { exact: false })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Save changes', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Check request status', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Edit issue description', exact: true })).toHaveCount(0);
  expect(state.updates).toHaveLength(1); expect(state.inspections).toEqual([key]); expect(await stored(page)).toEqual([]);
});

for (const mode of ['unknown', 'mismatch', 'missingObject'] as const) {
  test(`issue edit ${mode} keeps its key without enabling another write`, async ({ page }) => {
    const state = await backend(page); state[mode] = true; await page.goto(detailURL);
    await page.getByRole('button', { name: 'Close issue', exact: true }).click();
    await page.getByRole('region', { name: 'Confirm issue state' }).getByRole('button', { name: 'Close issue', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Check request status', exact: true })).toBeEnabled();
    await page.getByRole('button', { name: 'Check request status', exact: true }).click();
    expect(state.updates).toHaveLength(1); expect(await stored(page)).toHaveLength(1);
    await expect(page.getByRole('button', { name: 'Review current issue', exact: true })).toHaveCount(0);
    await page.getByRole('button', { name: 'Close editor', exact: true }).click();
    await page.getByRole('button', { name: 'Resume issue change', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Check request status', exact: true })).toBeEnabled();
    await page.getByLabel('Your account', { exact: true }).click();
    await page.getByRole('button', { name: 'Sign out', exact: true }).click();
    await expect.poll(() => stored(page)).toEqual([]);
  });
}

test('missing native revision disables issue writes, and mobile editors stay compact in both themes', async ({ page }) => {
  const state = await backend(page); state.issue.revision = ''; await page.goto(detailURL);
  await expect(page.getByRole('button', { name: 'Edit issue title', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Close issue', exact: true })).toBeDisabled();
  expect(state.updates).toEqual([]);
  state.issue.revision = issue.revision; await page.getByRole('button', { name: 'Refresh issue', exact: true }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  for (const theme of ['dark', 'light']) {
    if (await page.locator('html').getAttribute('data-theme') !== theme) await page.getByRole('button', { name: `Switch to ${theme} theme`, exact: true }).click();
    await page.getByRole('button', { name: 'Edit issue description', exact: true }).click();
    await expect(page.getByLabel('Description, Markdown', { exact: true })).toBeFocused();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: `test-results/issue-edit-mobile-${theme}.png`, fullPage: true });
    await page.getByRole('button', { name: 'Close editor', exact: true }).click();
  }
});

for (const theme of ['dark', 'light']) for (const width of [1440, 390]) test(`loaded issue activity sorts and closed icons remain private in ${theme} ${width}px`, async ({ page }) => {
  const state = await backend(page); const titles = ['Old activity', 'Offset activity', 'Recent activity', 'Missing activity'] as const;
  state.issueRows = ['2026-10-01T12:00:00Z', '2026-10-03T01:00:00+02:00', '2026-10-03T00:00:00Z', ''].map((updatedAt, index) => create(IssueSchema, { ...issue, id: String(100 + index), number: 20 + index, title: titles[index]!, updatedAt, comments: [2, 10, 0, 3][index]!, state: index === 1 ? IssueState.CLOSED : IssueState.OPEN }));
  await page.setViewportSize({ width, height: 900 }); await page.addInitScript(theme => localStorage.setItem('golf.theme', theme), theme); await page.goto('/alex/project/issues?state=all');
  const rows = page.locator('.issue-list>li'), names = rows.locator('h3 a'), sort = page.getByRole('combobox', { name: 'Sort loaded issues', exact: true });
  await expect(names).toHaveText(titles.slice(0, 2)); await sort.selectOption('updated-newest'); await expect(names).toHaveText([titles[1], titles[0]]);
  await page.getByRole('button', { name: 'Load more issues', exact: true }).click(); await expect(names).toHaveText([titles[2], titles[1], titles[0], titles[3]]);
  await sort.selectOption('updated-oldest'); await expect(names).toHaveText([titles[0], titles[1], titles[2], titles[3]]);
  await sort.selectOption('most-commented'); await expect(names).toHaveText([titles[1], titles[3], titles[0], titles[2]]);
  await sort.selectOption('least-commented'); await expect(names).toHaveText([titles[2], titles[0], titles[3], titles[1]]);
  await sort.selectOption('provider'); await expect(names).toHaveText(titles);
  const closed = rows.filter({ has: page.getByRole('link', { name: titles[1], exact: true }) });
  await expect(closed.locator(':scope > svg')).toHaveClass(/lucide-circle-check/); await expect(closed.locator('.issue-state svg')).toHaveClass(/lucide-circle-check/); await expect(closed.locator('.issue-state')).toHaveText('closed'); await expect(closed.locator('svg').first()).toHaveAttribute('aria-hidden', 'true');
  await expect(rows.first().locator(':scope > svg')).toHaveClass(/lucide-circle-dot/);
  await page.getByRole('searchbox', { name: 'Search loaded issues', exact: true }).fill('Offset'); await expect(names).toHaveText([titles[1]]); await expect(page.getByText('1 of 4 loaded', { exact: true })).toBeVisible(); await sort.selectOption('most-commented'); await expect(names).toHaveText([titles[1]]);
  await page.getByRole('searchbox', { name: 'Search loaded issues', exact: true }).clear(); await expect(names).toHaveCount(4); expect(state.listPages).toContain(2);
  await page.evaluate(() => document.fonts.ready); expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true); await page.screenshot({ path: test.info().outputPath(`issue-activity-${theme}-${width}.png`), fullPage: true });
  state.errors.ListIssues = 'permission_denied'; await page.getByRole('button', { name: 'Refresh issues', exact: true }).click(); await expect(page.getByRole('alert')).toBeVisible(); await expect(rows).toHaveCount(0); expect(await page.evaluate(() => JSON.stringify({ ...localStorage, ...sessionStorage }))).not.toContain('Offset activity'); expect(state.creates).toHaveLength(0); expect(state.posts).toHaveLength(0); expect(state.updates).toHaveLength(0);
});

test.describe('native milestone calendar dates', () => {
  test.use({ timezoneId: 'America/New_York', locale: 'en-US' });
for (const theme of ['dark', 'light']) for (const width of [1440, 390]) test(`known native issue metadata is compact, inert and access-bound in ${theme} ${width}px`, async ({ page }) => {
  const state = await backend(page), largeCount = 9007199254740995n;
  state.issue.metadata = create(DiscussionMetadataSchema, { labelsKnown: true, assigneesKnown: true, milestoneKnown: true,
    labels: [create(DiscussionLabelSchema, { id: '41', name: 'PRIVATE_LABEL bug', color: 'ffffff', description: 'PRIVATE_LABEL_DESCRIPTION <img src=x>', exclusive: true }), create(DiscussionLabelSchema, { id: '42', name: 'archived work', color: '000000', archived: true }), create(DiscussionLabelSchema, { id: '43', name: 'safe fallback', color: 'url(https://tracking.example/color)' })],
    assignees: [user, create(UserSchema, { id: '100', login: 'PRIVATE_ASSIGNEE', fullName: 'A teammate', avatarUrl: 'https://tracking.example/avatar.png' })],
    milestone: create(DiscussionMilestoneSchema, { id: '51', title: 'PRIVATE_MILESTONE next release', state: IssueState.OPEN, openIssues: largeCount, closedIssues: 12n, dueOn: '2026-12-01T00:00:00Z', description: 'PRIVATE_MILESTONE_DESCRIPTION <script>window.executed=true</script>' }) });
  await page.setViewportSize({ width, height: 900 }); await page.addInitScript(theme => localStorage.setItem('golf.theme', theme), theme); await page.goto('/alex/project/issues/12');
  const sidebar = page.getByRole('complementary', { name: 'Issue metadata', exact: true }), metadata = sidebar.locator('.discussion-metadata'), labels = metadata.getByRole('region', { name: 'Labels', exact: true }), milestone = metadata.getByRole('region', { name: 'Milestone', exact: true });
  await expect(labels).toContainText('PRIVATE_LABEL bug'); await expect(labels).toContainText('Exclusive label'); await expect(labels).toContainText('Archived label'); await expect(labels.locator('.discussion-label-swatch circle').nth(0)).toHaveAttribute('fill', '#ffffff'); await expect(labels.locator('.discussion-label-swatch circle').nth(1)).toHaveAttribute('fill', '#000000'); await expect(labels.locator('.discussion-label-swatch circle').nth(2)).toHaveAttribute('fill', 'currentColor');
  await expect(metadata.getByRole('region', { name: 'Assignees', exact: true })).toContainText('PRIVATE_ASSIGNEE'); await expect(milestone.locator('dd')).toHaveText([largeCount.toLocaleString(), '12']); await expect(milestone.locator('time')).toHaveAttribute('datetime', '2026-12-01T00:00:00Z'); await expect(milestone.locator('time')).toHaveText('Dec 1, 2026'); await expect(milestone.locator('time')).toHaveAttribute('title', 'Dec 1, 2026'); await expect(milestone.locator('.discussion-milestone-state')).toHaveText('Open');
  const description = milestone.locator('details'); await expect(description.locator('p')).toBeHidden(); await description.locator('summary').focus(); await page.keyboard.press('Enter'); await expect(description.locator('p')).toHaveText('PRIVATE_MILESTONE_DESCRIPTION <script>window.executed=true</script>'); await expect(metadata.locator('button,input,select,form,[style],img,script,a')).toHaveCount(0); await expect(page.getByRole('button', { name: 'Edit issue title', exact: true })).toBeVisible(); await expect(page.getByRole('button', { name: 'Add a comment', exact: true })).toBeVisible(); expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.evaluate(() => document.fonts.ready); await page.evaluate(() => scrollTo(0, 0)); await page.screenshot({ path: test.info().outputPath(`issue-metadata-${theme}-${width}.png`), fullPage: true });
  let release!: () => void; state.issueReadWait = new Promise<void>(resolve => { release = resolve; }); await page.getByRole('button', { name: 'Refresh issue', exact: true }).click(); await expect(metadata).toBeHidden(); release(); state.issueReadWait = undefined; await expect(metadata).toBeVisible();
  state.errors.GetIssue = 'permission_denied'; await page.getByRole('button', { name: 'Refresh issue', exact: true }).click(); await expect(page.getByRole('alert')).toBeVisible(); await expect(metadata).toHaveCount(0); await expect(page.getByText('PRIVATE_ASSIGNEE', { exact: true })).toHaveCount(0); expect(await page.evaluate(() => JSON.stringify({ ...localStorage, ...sessionStorage }))).not.toMatch(/PRIVATE_LABEL|PRIVATE_ASSIGNEE|PRIVATE_MILESTONE/); expect(state.posts).toHaveLength(0); expect(state.updates).toHaveLength(0);
});
});

test('issue metadata preserves unknown sections and explicitly known empty inventories', async ({ page }) => {
  const state = await backend(page); await page.goto('/alex/project/issues/12'); const sidebar = page.getByRole('complementary', { name: 'Issue metadata', exact: true });
  await expect(sidebar.locator('.discussion-metadata')).toHaveCount(0);
  state.issue.metadata = create(DiscussionMetadataSchema, { labels: [{ id: '41', name: 'UNVERIFIED_LABEL', color: 'ffffff' }] }); await page.getByRole('button', { name: 'Refresh issue', exact: true }).click(); await expect(sidebar.locator('.discussion-metadata')).toHaveCount(0);
  state.issue.metadata = create(DiscussionMetadataSchema, { assigneesKnown: true, labels: [{ id: '41', name: 'UNVERIFIED_LABEL', color: 'ffffff' }] }); await page.getByRole('button', { name: 'Refresh issue', exact: true }).click(); await expect(sidebar.getByRole('region', { name: 'Assignees', exact: true })).toHaveText('AssigneesNone'); await expect(sidebar.getByRole('region', { name: 'Labels', exact: true })).toHaveCount(0); await expect(sidebar.getByRole('region', { name: 'Milestone', exact: true })).toHaveCount(0); await expect(sidebar).not.toContainText('UNVERIFIED_LABEL');
  state.issue.metadata = create(DiscussionMetadataSchema, { labelsKnown: true, assigneesKnown: true, milestoneKnown: true }); await page.getByRole('button', { name: 'Refresh issue', exact: true }).click(); await expect(sidebar.locator('.discussion-metadata>section')).toHaveText(['AssigneesNone', 'LabelsNone', 'MilestoneNone']);
  state.issue.metadata = create(DiscussionMetadataSchema, { milestoneKnown: true, milestone: { id: '51', title: 'Finished milestone', state: IssueState.CLOSED, openIssues: 0n, closedIssues: 4n } }); await page.getByRole('button', { name: 'Refresh issue', exact: true }).click(); await expect(sidebar.locator('.discussion-milestone-state')).toHaveText('Closed'); await expect(sidebar.locator('.discussion-milestone-state svg')).toHaveClass(/lucide-circle-check/); await expect(sidebar.locator('.discussion-milestone-due')).toHaveCount(0);
});

function enableMilestones(state: Awaited<ReturnType<typeof backend>>) {
  state.canEditMilestone=true;
  state.issue.metadata=create(DiscussionMetadataSchema,{milestoneKnown:true,milestone:state.milestones[0]});
}
test('milestone pencil opens the shared inline editor and saves change then explicit None without other fields',async({page})=>{
 const state=await backend(page);enableMilestones(state);await page.goto('/alex/project/issues/12');
 await expect(page.getByRole('combobox',{name:'Issue milestone',exact:true})).toHaveCount(0);
 for(const [expected,selected] of [['51','52'],['52','0']]){
  await page.getByRole('button',{name:'Edit issue milestone',exact:true}).click();const editor=page.getByRole('region',{name:'Edit issue milestone',exact:true});
  await expect(editor.getByRole('button',{name:'Save changes',exact:true})).toBeDisabled();await editor.getByRole('combobox',{name:'Issue milestone',exact:true}).selectOption(selected!);
  await expect(page.getByRole('button',{name:'Edit issue title',exact:true})).toBeDisabled();await editor.getByRole('button',{name:'Save changes',exact:true}).click();await expect(editor).toHaveCount(0);
  const request=state.updates.at(-1)!;expect(request.milestone).toMatchObject({expectedMilestoneId:expected,milestoneId:selected});expect(request.title).toBeUndefined();expect(request.body).toBeUndefined();expect(request.state).toBe(IssueState.UNSPECIFIED);
 }
 expect(state.issue.title).toBe(issue.title);expect(state.issue.body).toBe(issue.body);expect(state.issue.state).toBe(issue.state);expect(state.updates).toHaveLength(2);expect(await stored(page)).toEqual([]);
});
test('milestone editing uses real paginated choices and preserves read-only/unknown capability',async({page})=>{
 const state=await backend(page);enableMilestones(state);state.milestoneMore=true;await page.goto('/alex/project/issues/12');await page.getByRole('button',{name:'Edit issue milestone',exact:true}).click();
 const editor=page.getByRole('region',{name:'Edit issue milestone',exact:true});await expect(editor.getByRole('option',{name:'PRIVATE_MILESTONE_B (closed)',exact:true})).toHaveCount(0);await editor.getByRole('button',{name:'Load more milestones',exact:true}).click();await expect(editor.getByRole('option',{name:'PRIVATE_MILESTONE_B (closed)',exact:true})).toHaveCount(1);expect(state.milestonePages.slice(-2)).toEqual([1,2]);expect(state.milestonePages.every(number=>number===1||number===2)).toBe(true);
 await editor.getByRole('button',{name:'Close editor',exact:true}).click();state.canEditMilestone=false;await page.reload();await expect(page.getByRole('complementary',{name:'Issue metadata'})).toContainText('PRIVATE_MILESTONE_A');await expect(page.getByRole('button',{name:'Edit issue milestone',exact:true})).toHaveCount(0);expect(state.updates).toHaveLength(0);
 state.canEditMilestone=true;state.issue.metadata=undefined;await page.reload();await expect(page.getByRole('button',{name:'Edit issue milestone',exact:true})).toHaveCount(0);
});
test('lost milestone acknowledgement reloads into original-key inspection without another update',async({page})=>{
 const state=await backend(page);enableMilestones(state);state.drop=true;await page.goto('/alex/project/issues/12');await page.getByRole('button',{name:'Edit issue milestone',exact:true}).click();
 const editor=page.getByRole('region',{name:'Edit issue milestone',exact:true});await editor.getByRole('combobox',{name:'Issue milestone',exact:true}).selectOption('52');await editor.getByRole('button',{name:'Save changes',exact:true}).click();await expect(editor.getByRole('button',{name:'Check request status',exact:true})).toBeEnabled();
 const key=state.updates[0]!.idempotencyKey;expect(JSON.parse((await stored(page))[0]![1])).toEqual({key,kind:'update',repositoryId:repository.id,issueId:issue.id,number:12,editField:'milestone'});expect((await stored(page))[0]![1]).not.toContain('PRIVATE_MILESTONE');
 await page.reload();await page.getByRole('button',{name:'Check request status',exact:true}).click();await expect(page.getByRole('region',{name:'Edit issue milestone',exact:true})).toHaveCount(0);expect(state.updates).toHaveLength(1);expect(state.inspections).toEqual([key]);
});
for(const theme of ['dark','light'])test(`milestone editor is compact and denied inventories mask private content in ${theme}`,async({page})=>{
 const state=await backend(page);enableMilestones(state);await page.setViewportSize({width:390,height:900});await page.addInitScript(value=>localStorage.setItem('golf.theme',value),theme);await page.goto('/alex/project/issues/12');await page.getByRole('button',{name:'Edit issue milestone',exact:true}).click();
 await expect(page.getByRole('combobox',{name:'Issue milestone',exact:true})).toBeFocused();expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);await page.evaluate(()=>scrollTo(0,0));await page.screenshot({path:test.info().outputPath(`milestone-editor-${theme}-390.png`),fullPage:true});
 state.errors.ListRepositoryMilestones='permission_denied';await page.reload();await expect(page.getByRole('alert')).toBeVisible();await expect(page.getByText('PRIVATE_BODY <script>alert(1)</script>',{exact:true})).toHaveCount(0);await expect(page.getByRole('combobox',{name:'Issue milestone',exact:true})).toHaveCount(0);expect(state.updates).toHaveLength(0);
});

test('unavailable milestone inventory exposes retry without hiding the authorized issue',async({page})=>{
 const state=await backend(page);enableMilestones(state);state.errors.ListRepositoryMilestones='unavailable';await page.goto('/alex/project/issues/12');
 const sidebar=page.getByRole('complementary',{name:'Issue metadata',exact:true});await expect(sidebar.getByRole('alert')).toBeVisible();await expect(page.locator('#issue-detail-title')).toBeVisible();
 delete state.errors.ListRepositoryMilestones;await sidebar.getByRole('button',{name:'Try again',exact:true}).click();await expect(page.getByRole('button',{name:'Edit issue milestone',exact:true})).toBeVisible();expect(state.updates).toHaveLength(0);
});

function enableLabels(state: Awaited<ReturnType<typeof backend>>) {
 state.canEditLabels=true;state.issue.metadata=create(DiscussionMetadataSchema,{labelsKnown:true,labels:[state.labels[0]!]});
}
test('labels pencil opens shared form and replaces then clears exact IDs without changing other fields',async({page})=>{
 const state=await backend(page);enableLabels(state);await page.goto('/alex/project/issues/12');await expect(page.getByRole('checkbox')).toHaveCount(0);
 await page.getByRole('button',{name:'Edit issue labels',exact:true}).click();let editor=page.getByRole('region',{name:'Edit issue labels',exact:true});await expect(editor.getByRole('button',{name:'Save changes',exact:true})).toBeDisabled();await editor.getByRole('checkbox',{name:'PRIVATE_LABEL_B',exact:true}).check();await expect(page.getByRole('button',{name:'Edit issue title',exact:true})).toBeDisabled();await editor.getByRole('button',{name:'Save changes',exact:true}).click();await expect(editor).toHaveCount(0);
 expect(state.updates[0]!.labels).toMatchObject({expectedLabelIds:['9'],labelIds:['9','12']});
 await page.getByRole('button',{name:'Edit issue labels',exact:true}).click();editor=page.getByRole('region',{name:'Edit issue labels',exact:true});await editor.getByRole('checkbox',{name:'PRIVATE_LABEL_A',exact:true}).uncheck();await editor.getByRole('checkbox',{name:'PRIVATE_LABEL_B',exact:true}).uncheck();await editor.getByRole('button',{name:'Save changes',exact:true}).click();await expect(editor).toHaveCount(0);
 expect(state.updates[1]!.labels).toMatchObject({expectedLabelIds:['9','12'],labelIds:[]});for(const request of state.updates){expect(request.title).toBeUndefined();expect(request.body).toBeUndefined();expect(request.milestone).toBeUndefined();expect(request.state).toBe(IssueState.UNSPECIFIED);}expect(state.issue.title).toBe(issue.title);expect(state.issue.body).toBe(issue.body);expect(await stored(page)).toEqual([]);
});
test('label inventory pages and native admin permission control the editor',async({page})=>{
 const state=await backend(page);enableLabels(state);state.labelMore=true;await page.goto('/alex/project/issues/12');await page.getByRole('button',{name:'Edit issue labels',exact:true}).click();const editor=page.getByRole('region',{name:'Edit issue labels',exact:true});await expect(editor.getByRole('checkbox',{name:'PRIVATE_LABEL_B',exact:true})).toHaveCount(0);await editor.getByRole('button',{name:'Load more labels',exact:true}).click();await expect(editor.getByRole('checkbox',{name:'PRIVATE_LABEL_B',exact:true})).toBeVisible();expect(state.labelPages.at(-1)).toBe(2);
 await editor.getByRole('button',{name:'Close editor',exact:true}).click();await expect(page.getByRole('button',{name:'Edit issue labels',exact:true})).toBeFocused();state.canEditLabels=false;await page.reload();await expect(page.getByRole('complementary',{name:'Issue metadata',exact:true})).toContainText('PRIVATE_LABEL_A');await expect(page.getByRole('button',{name:'Edit issue labels',exact:true})).toHaveCount(0);expect(state.updates).toHaveLength(0);
});
test('lost label response resumes original UUID inspection without storing private choices or another update',async({page})=>{
 const state=await backend(page);enableLabels(state);state.drop=true;await page.goto('/alex/project/issues/12');await page.getByRole('button',{name:'Edit issue labels',exact:true}).click();const editor=page.getByRole('region',{name:'Edit issue labels',exact:true});await editor.getByRole('checkbox',{name:'PRIVATE_LABEL_B',exact:true}).check();await editor.getByRole('button',{name:'Save changes',exact:true}).click();await expect(editor.getByRole('button',{name:'Check request status',exact:true})).toBeEnabled();const key=state.updates[0]!.idempotencyKey;expect(JSON.parse((await stored(page))[0]![1])).toEqual({key,kind:'update',repositoryId:repository.id,issueId:issue.id,number:12,editField:'labels'});await page.reload();await page.getByRole('button',{name:'Check request status',exact:true}).click();await expect(page.getByRole('region',{name:'Edit issue labels',exact:true})).toHaveCount(0);expect(state.updates).toHaveLength(1);expect(state.inspections).toEqual([key]);
});
test('label selection refuses lossy native IDs but allows explicit removal of a large current ID',async({page})=>{
 const state=await backend(page);state.labels.push(create(DiscussionLabelSchema,{id:'9007199254740993',name:'BIG_NATIVE_ID',color:'ffffff'}));enableLabels(state);state.issue.metadata!.labels=[state.labels[2]!];await page.goto('/alex/project/issues/12');await page.getByRole('button',{name:'Edit issue labels',exact:true}).click();const editor=page.getByRole('region',{name:'Edit issue labels',exact:true});await expect(editor.getByRole('checkbox',{name:'BIG_NATIVE_ID',exact:true})).toBeEnabled();await expect(editor.getByRole('button',{name:'Save changes',exact:true})).toBeDisabled();await editor.getByRole('checkbox',{name:'BIG_NATIVE_ID',exact:true}).uncheck();await expect(editor.getByRole('checkbox',{name:'BIG_NATIVE_ID',exact:true})).toBeDisabled();await editor.getByRole('button',{name:'Save changes',exact:true}).click();await expect(editor).toHaveCount(0);expect(state.updates[0]!.labels).toMatchObject({expectedLabelIds:['9007199254740993'],labelIds:[]});
});
for(const theme of ['dark','light'])test(`labels editor compact ${theme} and current native denial hides private content`,async({page})=>{
 const state=await backend(page);enableLabels(state);await page.setViewportSize({width:390,height:900});await page.addInitScript(value=>localStorage.setItem('golf.theme',value),theme);await page.goto('/alex/project/issues/12');await page.getByRole('button',{name:'Edit issue labels',exact:true}).click();await expect(page.getByRole('checkbox',{name:'PRIVATE_LABEL_A',exact:true})).toBeFocused();expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);await page.evaluate(()=>scrollTo(0,0));await page.screenshot({path:test.info().outputPath(`labels-editor-${theme}-390.png`),fullPage:true});state.errors.ListRepositoryLabels='permission_denied';await page.reload();await expect(page.getByRole('alert')).toBeVisible();await expect(page.getByText('PRIVATE_BODY <script>alert(1)</script>',{exact:true})).toHaveCount(0);await expect(page.getByRole('checkbox')).toHaveCount(0);expect(state.updates).toHaveLength(0);
});

test('conflicting exclusive labels cannot submit until one group selection is removed',async({page})=>{
 const state=await backend(page);state.labels[0]!.name='type/bug';state.labels[1]!.name='type/feature';for(const row of state.labels)row.exclusive=true;enableLabels(state);await page.goto('/alex/project/issues/12');await page.getByRole('button',{name:'Edit issue labels',exact:true}).click();const editor=page.getByRole('region',{name:'Edit issue labels',exact:true});await editor.getByRole('checkbox',{name:'type/feature',exact:true}).check();await expect(editor).toContainText('Choose at most one exclusive label in each group.');await expect(editor.getByRole('button',{name:'Save changes',exact:true})).toBeDisabled();expect(state.updates).toHaveLength(0);await editor.getByRole('checkbox',{name:'type/bug',exact:true}).uncheck();await editor.getByRole('button',{name:'Save changes',exact:true}).click();await expect(editor).toHaveCount(0);expect(state.updates[0]!.labels).toMatchObject({expectedLabelIds:['9'],labelIds:['12']});
});
test('unavailable label inventory exposes retry without hiding authorized issue content',async({page})=>{
 const state=await backend(page);enableLabels(state);state.errors.ListRepositoryLabels='unavailable';await page.goto('/alex/project/issues/12');const sidebar=page.getByRole('complementary',{name:'Issue metadata',exact:true});await expect(sidebar.getByRole('alert')).toBeVisible();await expect(page.locator('#issue-detail-title')).toBeVisible();delete state.errors.ListRepositoryLabels;await sidebar.getByRole('button',{name:'Try again',exact:true}).click();await expect(page.getByRole('button',{name:'Edit issue labels',exact:true})).toBeVisible();expect(state.updates).toHaveLength(0);
});

test('replacement native issue resets metadata editor and cannot mix original choices with another issue ID',async({page})=>{
 const state=await backend(page);enableLabels(state);await page.goto('/alex/project/issues/12');await page.getByRole('button',{name:'Edit issue labels',exact:true}).click();await page.getByRole('checkbox',{name:'PRIVATE_LABEL_B',exact:true}).check();state.issueId='9007199254741007';state.issue={...state.issue,id:state.issueId,title:'Replacement issue',revision:'c'.repeat(64),metadata:create(DiscussionMetadataSchema,{labelsKnown:true,labels:[state.labels[1]!]})};await page.getByRole('button',{name:'Refresh issue',exact:true}).click();await expect(page.locator('#issue-detail-title')).toContainText('Replacement issue');await expect(page.getByRole('region',{name:'Edit issue labels',exact:true})).toHaveCount(0);await page.getByRole('button',{name:'Edit issue labels',exact:true}).click();const editor=page.getByRole('region',{name:'Edit issue labels',exact:true});await expect(editor.getByRole('checkbox',{name:'PRIVATE_LABEL_A',exact:true})).not.toBeChecked();await expect(editor.getByRole('checkbox',{name:'PRIVATE_LABEL_B',exact:true})).toBeChecked();await editor.getByRole('checkbox',{name:'PRIVATE_LABEL_A',exact:true}).check();await editor.getByRole('button',{name:'Save changes',exact:true}).click();await expect(editor).toHaveCount(0);expect(state.updates[0]!.issueId).toBe(state.issueId);expect(state.updates[0]!.expectedRevision).toBe('c'.repeat(64));expect(state.updates[0]!.labels).toMatchObject({expectedLabelIds:['12'],labelIds:['9','12']});
});
for(const empty of [true,false])test(`label editor keyboard focus enters an enabled control with ${empty?'empty':'unsafe first'} inventory`,async({page})=>{
 const state=await backend(page);enableLabels(state);state.issue.metadata!.labels=[];state.labels=empty?[]:[create(DiscussionLabelSchema,{id:'9007199254740993',name:'UNSELECTABLE',color:'ffffff'}),state.labels[0]!];await page.goto('/alex/project/issues/12');await page.getByRole('button',{name:'Edit issue labels',exact:true}).focus();await page.keyboard.press('Enter');const editor=page.getByRole('region',{name:'Edit issue labels',exact:true});await expect(editor.getByRole(empty?'button':'checkbox',{name:empty?'Close editor':'PRIVATE_LABEL_A',exact:true})).toBeFocused();expect(state.updates).toHaveLength(0);
});

for(const field of ['labels','milestone'])test(`open ${field} editor loses readiness when current native metadata becomes unknown`,async({page})=>{
 const state=await backend(page);if(field==='labels')enableLabels(state);else enableMilestones(state);await page.goto('/alex/project/issues/12');const name=field==='labels'?'Edit issue labels':'Edit issue milestone';await page.getByRole('button',{name,exact:true}).click();const editor=page.getByRole('region',{name,exact:true});if(field==='labels')await editor.getByRole('checkbox',{name:'PRIVATE_LABEL_B',exact:true}).check();else await editor.getByRole('combobox',{name:'Issue milestone',exact:true}).selectOption('52');await expect(editor.getByRole('button',{name:'Save changes',exact:true})).toBeEnabled();state.issue.metadata=create(DiscussionMetadataSchema);await page.getByRole('button',{name:'Refresh issue',exact:true}).click();await expect(editor.getByRole('button',{name:'Save changes',exact:true})).toBeDisabled();if(field==='labels')await expect(editor.getByRole('checkbox')).toHaveCount(0);else {await expect(editor.getByRole('combobox',{name:'Issue milestone',exact:true})).toBeDisabled();await expect(editor).not.toContainText('PRIVATE_MILESTONE_A');}await expect(editor).toContainText('could not be verified');expect(state.updates).toHaveLength(0);
});

test('assignee pencil replaces then clears exact int64 IDs and login pairs without other fields', async ({ page }) => {
  const state = await backend(page); enableAssignees(state); await page.goto('/alex/project/issues/12');
  await expect(page.getByRole('checkbox')).toHaveCount(0);
  for (const clear of [false, true]) {
    await page.getByRole('button', { name: 'Edit issue assignees', exact: true }).click();
    const editor = page.getByRole('region', { name: 'Edit issue assignees', exact: true });
    await expect(editor.getByRole('button', { name: 'Save changes', exact: true })).toBeDisabled();
    if (clear) { await editor.getByRole('checkbox', { name: 'PRIVATE_ASSIGNEE_A', exact: true }).uncheck(); await editor.getByRole('checkbox', { name: 'PRIVATE_ASSIGNEE_B', exact: true }).uncheck(); }
    else await editor.getByRole('checkbox', { name: 'PRIVATE_ASSIGNEE_B', exact: true }).check();
    await expect(page.getByRole('button', { name: 'Edit issue title', exact: true })).toBeDisabled();
    await editor.getByRole('button', { name: 'Save changes', exact: true }).click(); await expect(editor).toHaveCount(0);
  }
  expect(state.updates[0]!.assignees).toMatchObject({ expectedAssigneeIds: ['9007199254740993'], assignees: [{ id: '12', login: 'PRIVATE_ASSIGNEE_B' }, { id: '9007199254740993', login: 'PRIVATE_ASSIGNEE_A' }] });
  expect(state.updates[1]!.assignees).toMatchObject({ expectedAssigneeIds: ['12', '9007199254740993'], assignees: [] });
  for (const request of state.updates) { expect(request.title).toBeUndefined(); expect(request.body).toBeUndefined(); expect(request.milestone).toBeUndefined(); expect(request.labels).toBeUndefined(); expect(request.state).toBe(IssueState.UNSPECIFIED); }
  expect(state.issue.title).toBe(issue.title); expect(state.issue.body).toBe(issue.body); expect(await stored(page)).toEqual([]);
});

test('revoked current assignees remain removable but cannot be retained or reselected', async ({ page }) => {
  const state = await backend(page); enableAssignees(state);
  state.issue.metadata!.assignees.push(create(UserSchema, { id: '9223372036854775807', login: 'REVOKED_CURRENT' }));
  await page.goto('/alex/project/issues/12'); await page.getByRole('button', { name: 'Edit issue assignees', exact: true }).click();
  const editor = page.getByRole('region', { name: 'Edit issue assignees', exact: true });
  await editor.getByRole('checkbox', { name: 'PRIVATE_ASSIGNEE_B', exact: true }).check();
  await expect(editor).toContainText('not in current candidates; remove only'); await expect(editor.getByRole('button', { name: 'Save changes', exact: true })).toBeDisabled();
  await editor.getByRole('checkbox', { name: 'REVOKED_CURRENT', exact: true }).uncheck(); await expect(editor.getByRole('checkbox', { name: 'REVOKED_CURRENT', exact: true })).toBeDisabled();
  await editor.getByRole('button', { name: 'Save changes', exact: true }).click(); await expect(editor).toHaveCount(0);
  expect(state.updates[0]!.assignees).toMatchObject({ expectedAssigneeIds: ['9007199254740993', '9223372036854775807'], assignees: [{ id: '12', login: 'PRIVATE_ASSIGNEE_B' }, { id: '9007199254740993', login: 'PRIVATE_ASSIGNEE_A' }] });
});

test('assignee inventory is unpaginated and bounded with loaded search, scrolling and 100-selection cap', async ({ page }) => {
  const state = await backend(page); enableAssignees(state);
  state.assignees = Array.from({ length: 1000 }, (_, index) => create(UserSchema, { id: String(index + 1), login: `candidate-${index + 1}` }));
  state.issue.metadata!.assignees = state.assignees.slice(0, 100);
  await page.goto('/alex/project/issues/12'); await page.getByRole('button', { name: 'Edit issue assignees', exact: true }).click();
  const editor = page.getByRole('region', { name: 'Edit issue assignees', exact: true });
  await expect(editor.getByRole('checkbox')).toHaveCount(1000); await expect(editor.getByRole('button', { name: /Load more/ })).toHaveCount(0); expect(state.assigneeReads).toBeGreaterThan(0); expect(state.assigneeReads).toBeLessThanOrEqual(2);
  expect(await editor.locator('.metadata-choice-scroll').evaluate(element => element.clientHeight <= 240 && element.scrollHeight > element.clientHeight)).toBe(true);
  await editor.getByRole('searchbox', { name: 'Search loaded assignees', exact: true }).fill('candidate-1000');
  await expect(editor.getByRole('checkbox')).toHaveCount(1); await expect(editor.getByRole('checkbox', { name: 'candidate-1000', exact: true })).toBeDisabled();
  await editor.getByRole('searchbox').fill('candidate-1'); await editor.getByRole('checkbox', { name: 'candidate-1', exact: true }).uncheck();
  await editor.getByRole('searchbox').fill('candidate-1000'); await editor.getByRole('checkbox', { name: 'candidate-1000', exact: true }).check();
  await editor.getByRole('button', { name: 'Save changes', exact: true }).click(); await expect(editor).toHaveCount(0);
  expect(state.updates[0]!.assignees!.expectedAssigneeIds).toHaveLength(100); expect(state.updates[0]!.assignees!.assignees).toHaveLength(100); expect(state.updates[0]!.assignees!.assignees.at(-1)).toMatchObject({ id: '1000', login: 'candidate-1000' });
});

test('lost assignee acknowledgement resumes original edit key with status checks and no private draft storage', async ({ page }) => {
  const state = await backend(page); enableAssignees(state); state.drop = true; await page.goto('/alex/project/issues/12');
  await page.getByRole('button', { name: 'Edit issue assignees', exact: true }).click();
  let editor = page.getByRole('region', { name: 'Edit issue assignees', exact: true });
  await editor.getByRole('checkbox', { name: 'PRIVATE_ASSIGNEE_B', exact: true }).check(); await editor.getByRole('button', { name: 'Save changes', exact: true }).click();
  await expect(editor.getByRole('button', { name: 'Check request status', exact: true })).toBeEnabled();
  const key = state.updates[0]!.idempotencyKey; const saved = await stored(page);
  expect(saved).toHaveLength(1); expect(saved[0]![0]).toMatch(/:edit$/); expect(JSON.parse(saved[0]![1])).toEqual({ key, kind: 'update', repositoryId: repository.id, issueId: issue.id, number: 12, editField: 'assignees' }); expect(saved[0]![1]).not.toContain('PRIVATE_ASSIGNEE');
  await page.reload(); editor = page.getByRole('region', { name: 'Edit issue assignees', exact: true }); await expect(editor.getByRole('button', { name: 'Check request status', exact: true })).toBeFocused();
  await editor.getByRole('button', { name: 'Check request status', exact: true }).click(); await expect(editor).toHaveCount(0); expect(state.updates).toHaveLength(1); expect(state.inspections).toEqual([key]); expect(await stored(page)).toEqual([]);
});

for (const failure of ['unknown', 'missing', 'mismatch']) test(`uncertain assignee ${failure} outcome never permits repost or clears the original intent`, async ({ page }) => {
  const state = await backend(page); enableAssignees(state); state.unknown = failure === 'unknown'; state.missingObject = failure === 'missing'; state.mismatch = failure === 'mismatch'; await page.goto('/alex/project/issues/12');
  await page.getByRole('button', { name: 'Edit issue assignees', exact: true }).click(); const editor = page.getByRole('region', { name: 'Edit issue assignees', exact: true });
  await editor.getByRole('checkbox', { name: 'PRIVATE_ASSIGNEE_B', exact: true }).check(); await editor.getByRole('button', { name: 'Save changes', exact: true }).click();
  await expect(editor.getByRole('button', { name: 'Check request status', exact: true })).toBeEnabled(); await editor.getByRole('button', { name: 'Check request status', exact: true }).click();
  await expect(editor.getByRole('button', { name: 'Save changes', exact: true })).toHaveCount(0); await expect(editor.getByRole('button', { name: /Review current|Start a new/ })).toHaveCount(0); expect(state.updates).toHaveLength(1); expect(await stored(page)).toHaveLength(1);
});

for (const unavailable of ['readonly', 'unknown']) test(`assignee ${unavailable} capability exposes no editor or false clear`, async ({ page }) => {
  const state = await backend(page); enableAssignees(state); if (unavailable === 'readonly') state.canEditAssignees = false; else state.issue.metadata!.assigneesKnown = false;
  await page.goto('/alex/project/issues/12'); await expect(page.locator('#issue-detail-title')).toBeVisible(); await expect(page.getByRole('button', { name: 'Edit issue assignees', exact: true })).toHaveCount(0); await expect(page.getByRole('checkbox')).toHaveCount(0); expect(state.updates).toHaveLength(0);
});

test('assignee inventory refresh masks candidates and blocks saving on late capability loss', async ({ page }) => {
  const state = await backend(page); enableAssignees(state); await page.goto('/alex/project/issues/12'); await page.getByRole('button', { name: 'Edit issue assignees', exact: true }).click();
  const editor = page.getByRole('region', { name: 'Edit issue assignees', exact: true }); await editor.getByRole('checkbox', { name: 'PRIVATE_ASSIGNEE_B', exact: true }).check();
  let release!: () => void; state.assigneeWait = new Promise<void>(resolve => { release = resolve; }); state.canEditAssignees = false;
  const before = state.assigneeReads; await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange', { bubbles: true }))); await expect.poll(() => state.assigneeReads).toBeGreaterThan(before);
  await expect(editor.getByRole('checkbox')).toHaveCount(0); await expect(editor.getByRole('button', { name: 'Save changes', exact: true })).toBeDisabled(); release();
  await expect(editor).toContainText('discussion write access'); await expect(editor.getByRole('checkbox')).toHaveCount(0); expect(state.updates).toHaveLength(0);
});

test('open assignee editor loses readiness when current issue metadata becomes unknown', async ({ page }) => {
  const state = await backend(page); enableAssignees(state); await page.goto('/alex/project/issues/12'); await page.getByRole('button', { name: 'Edit issue assignees', exact: true }).click();
  const editor = page.getByRole('region', { name: 'Edit issue assignees', exact: true }); await editor.getByRole('checkbox', { name: 'PRIVATE_ASSIGNEE_B', exact: true }).check();
  state.issue.metadata = create(DiscussionMetadataSchema); await page.getByRole('button', { name: 'Refresh issue', exact: true }).click();
  await expect(editor.getByRole('button', { name: 'Save changes', exact: true })).toBeDisabled(); await expect(editor.getByRole('checkbox')).toHaveCount(0); await expect(editor).not.toContainText('PRIVATE_ASSIGNEE'); await expect(editor).toContainText('could not be verified'); expect(state.updates).toHaveLength(0);
});

test('assignee inventory failures expose retry while authorization failures hide private issue content', async ({ page }) => {
  const state = await backend(page); enableAssignees(state); state.errors.ListRepositoryAssignees = 'unavailable'; await page.goto('/alex/project/issues/12');
  const sidebar = page.getByRole('complementary', { name: 'Issue metadata', exact: true }); await expect(sidebar.getByRole('alert')).toBeVisible(); await expect(page.locator('#issue-detail-title')).toBeVisible();
  delete state.errors.ListRepositoryAssignees; await sidebar.getByRole('button', { name: 'Try again', exact: true }).click(); await expect(page.getByRole('button', { name: 'Edit issue assignees', exact: true })).toBeVisible();
  state.errors.ListRepositoryAssignees = 'permission_denied'; await page.reload(); await expect(page.getByRole('alert')).toBeVisible(); await expect(page.locator('#issue-detail-title')).toHaveCount(0); await expect(page.getByRole('checkbox')).toHaveCount(0); expect(state.updates).toHaveLength(0);
});

for (const theme of ['dark', 'light']) test(`assignee inline editor keyboard focus and compact ${theme} mobile layout`, async ({ page }) => {
  const state = await backend(page); enableAssignees(state); await page.setViewportSize({ width: 390, height: 900 }); await page.addInitScript(value => localStorage.setItem('golf.theme', value), theme); await page.goto('/alex/project/issues/12');
  const pencil = page.getByRole('button', { name: 'Edit issue assignees', exact: true }); await pencil.focus(); await page.keyboard.press('Enter'); const editor = page.getByRole('region', { name: 'Edit issue assignees', exact: true });
  await expect(editor.getByRole('searchbox', { name: 'Search loaded assignees', exact: true })).toBeFocused(); await page.keyboard.press('Tab'); await expect(editor.getByRole('checkbox', { name: 'PRIVATE_ASSIGNEE_A', exact: true })).toBeFocused();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true); await page.evaluate(() => document.fonts.ready); expect(await editor.evaluate(element => getComputedStyle(element).fontFamily)).toContain('Archivo');
  await page.screenshot({ path: test.info().outputPath(`assignees-editor-${theme}-390.png`), fullPage: true }); await editor.getByRole('button', { name: 'Close editor', exact: true }).click(); await expect(pencil).toBeFocused(); expect(state.updates).toHaveLength(0);
});

for (const malformed of ['overflow', 'duplicate', 'noncanonical']) test(`assignee ${malformed} inventory cannot enable writes`, async ({ page }) => {
  const state = await backend(page); enableAssignees(state);
  if (malformed === 'overflow') state.assignees = Array.from({ length: 1001 }, (_, index) => create(UserSchema, { id: String(index + 1), login: `candidate-${index + 1}` }));
  else if (malformed === 'duplicate') state.assignees.push(state.assignees[0]!); else state.assignees[0]!.id = '09223372036854775807';
  await page.goto('/alex/project/issues/12'); await expect(page.getByRole('complementary', { name: 'Issue metadata', exact: true }).getByRole('alert')).toBeVisible(); await expect(page.getByRole('button', { name: 'Edit issue assignees', exact: true })).toHaveCount(0); await expect(page.getByRole('checkbox')).toHaveCount(0); expect(state.updates).toHaveLength(0);
});

test('replacement native issue resets assignee editor and binds new expected IDs and revision', async ({ page }) => {
  const state = await backend(page); enableAssignees(state); await page.goto('/alex/project/issues/12'); await page.getByRole('button', { name: 'Edit issue assignees', exact: true }).click(); await page.getByRole('checkbox', { name: 'PRIVATE_ASSIGNEE_B', exact: true }).check();
  state.issueId = '9007199254741007'; state.issue = { ...state.issue, id: state.issueId, title: 'Replacement issue', revision: 'c'.repeat(64), metadata: create(DiscussionMetadataSchema, { assigneesKnown: true, assignees: [state.assignees[1]!] }) };
  await page.getByRole('button', { name: 'Refresh issue', exact: true }).click(); await expect(page.locator('#issue-detail-title')).toContainText('Replacement issue'); await expect(page.getByRole('region', { name: 'Edit issue assignees', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Edit issue assignees', exact: true }).click(); const editor = page.getByRole('region', { name: 'Edit issue assignees', exact: true }); await expect(editor.getByRole('checkbox', { name: 'PRIVATE_ASSIGNEE_A', exact: true })).not.toBeChecked(); await expect(editor.getByRole('checkbox', { name: 'PRIVATE_ASSIGNEE_B', exact: true })).toBeChecked();
  await editor.getByRole('checkbox', { name: 'PRIVATE_ASSIGNEE_A', exact: true }).check(); await editor.getByRole('button', { name: 'Save changes', exact: true }).click(); await expect(editor).toHaveCount(0);
  expect(state.updates[0]).toMatchObject({ issueId: state.issueId, expectedRevision: 'c'.repeat(64), assignees: { expectedAssigneeIds: ['12'], assignees: [{ id: '12', login: 'PRIVATE_ASSIGNEE_B' }, { id: '9007199254740993', login: 'PRIVATE_ASSIGNEE_A' }] } });
});

test('assignee sign-out clears intent and late acknowledged result cannot restore private metadata', async ({ page }) => {
  const state = await backend(page); enableAssignees(state); await page.goto('/alex/project/issues/12'); await page.getByRole('button', { name: 'Edit issue assignees', exact: true }).click();
  let release!: () => void; state.barrier = new Promise<void>(resolve => { release = resolve; });
  await page.getByRole('checkbox', { name: 'PRIVATE_ASSIGNEE_B', exact: true }).check(); await page.getByRole('region', { name: 'Edit issue assignees', exact: true }).getByRole('button', { name: 'Save changes', exact: true }).click(); await expect.poll(() => state.updates.length).toBe(1);
  await page.getByLabel('Your account', { exact: true }).click(); await page.getByRole('button', { name: 'Sign out', exact: true }).click(); await expect(page.getByRole('heading', { name: 'Welcome to Golf' })).toBeVisible(); release();
  await expect.poll(() => stored(page)).toEqual([]); await expect(page.getByText('PRIVATE_ASSIGNEE_A', { exact: true })).toHaveCount(0); await expect(page.getByRole('checkbox')).toHaveCount(0); expect(state.updates).toHaveLength(1);
});


test('repository issue query is explicit, URL-backed and separate from loaded filters',async({page})=>{
 const state=await backend(page);await page.goto('/alex/project/issues');
 const search=page.getByRole('searchbox',{name:'Search repository issues',exact:true});await search.fill('accessibility');await page.getByRole('button',{name:'Show repository filters',exact:true}).click();
 await page.getByLabel('Author username',{exact:true}).fill('alex');await page.getByLabel('Assignee username',{exact:true}).fill('bob');await page.getByLabel('Label names, comma-separated',{exact:true}).fill('bug, accessibility');await page.getByLabel('Milestone title',{exact:true}).fill('Release');await page.getByRole('button',{name:'Apply filters',exact:true}).click();
 await expect.poll(()=>state.serverQueries.at(-1)).toMatchObject({search:'accessibility',author:'alex',assignee:'bob',labelNames:['bug','accessibility'],milestoneTitle:'Release'});await expect(page).toHaveURL(/q=accessibility/);await expect(page.getByRole('searchbox',{name:'Search loaded issues',exact:true})).toHaveValue('');
 await page.getByRole('link',{name:'Private discussion',exact:true}).click();await expect(page).toHaveURL(/issues\/12.*q=accessibility/);await page.getByRole('link',{name:'All open issues',exact:true}).click();await expect(search).toHaveValue('accessibility');await page.getByRole('button',{name:'Clear repository filters',exact:true}).click();await expect.poll(()=>state.serverQueries.at(-1)).toMatchObject({search:'',author:'',assignee:'',labelNames:[],milestoneTitle:''});
});

test('label administration uses explicit inventory actions and full snapshots with original-key inspection',async({page})=>{
 const state=await backend(page);state.canManage=true;state.labels=state.labels.map(r=>({...r,revision:'a'.repeat(64),archived:true}));await page.goto(listURL);await page.getByRole('button',{name:'Labels',exact:true}).click();const panel=page.getByRole('region',{name:'labels administration'});await expect(panel.getByRole('table',{name:'labels',exact:true})).toBeVisible();await expect(panel.getByRole('textbox',{name:'Name',exact:true})).toHaveCount(0);
 await panel.getByRole('button',{name:'Edit label PRIVATE_LABEL_A',exact:true}).click();await panel.getByLabel('Name',{exact:true}).fill('security');await panel.getByRole('button',{name:'Save label',exact:true}).click();await expect.poll(()=>state.resourceRequests.length).toBe(1);expect(state.resourceRequests[0]).toMatchObject({kind:DiscussionResourceOperationKind.UPDATE_LABEL,repositoryId:repository.id,resourceId:'9',expectedRevision:'a'.repeat(64),change:{case:'label',value:{name:'security',archived:true,exclusive:false,color:'aabbcc',description:''}}});await expect(panel).toContainText('Change confirmed.');await panel.getByRole('button',{name:'Dismiss completed operation',exact:true}).click();
 await panel.getByRole('button',{name:'Delete label security',exact:true}).click();const confirm=page.getByRole('dialog',{name:'Delete label security?'});await confirm.getByRole('button',{name:'Confirm deletion',exact:true}).click();await expect.poll(()=>state.resourceRequests.length).toBe(2);expect(state.resourceRequests[1]?.change.case).toBeUndefined();await expect(panel.getByRole('button',{name:'Delete label security'})).toHaveCount(0);
});

test('uncertain resource writes reload with metadata only and inspect without replay',async({page})=>{
 const state=await backend(page);state.canManage=true;state.resourceUnknown=true;state.labels=state.labels.map(r=>({...r,revision:'a'.repeat(64)}));await page.goto(listURL);await page.getByRole('button',{name:'Labels',exact:true}).click();const panel=page.getByRole('region',{name:'labels administration'});await panel.getByRole('button',{name:'New label',exact:true}).click();await panel.getByLabel('Name',{exact:true}).fill('PRIVATE_RESOURCE_NAME');await panel.getByLabel('Description',{exact:true}).fill('PRIVATE_RESOURCE_DESCRIPTION');await panel.getByRole('button',{name:'Save label',exact:true}).click();await expect(panel).toContainText('Original outcome is unresolved.');const key=state.resourceRequests[0]!.operationId;
 const original=await page.evaluate(()=>Object.entries(sessionStorage).filter(([key])=>key.startsWith('golf.discussion-resource.')));expect(JSON.stringify(original)).not.toContain('PRIVATE_RESOURCE');await page.reload();await page.getByRole('button',{name:'Labels',exact:true}).click();await panel.getByRole('button',{name:'Inspect original operation',exact:true}).click();await expect.poll(()=>state.resourceInspections).toEqual([key]);expect(state.resourceRequests).toHaveLength(1);await expect(panel.getByRole('button',{name:'New label',exact:true})).toBeDisabled();
});

test('ordinary comment author controls edit and confirm deletion using exact discussion identity',async({page})=>{
 const state=await backend(page);state.comments=[{...comment,revision:'a'.repeat(64),canEdit:true,canDelete:true}];await page.goto(detailURL);await page.getByRole('button',{name:`Edit comment ${comment.id}`,exact:true}).click();const form=page.getByRole('form',{name:`Edit comment ${comment.id}`,exact:true});await form.getByLabel('Comment',{exact:true}).fill('Updated private comment');await form.getByRole('button',{name:'Save comment',exact:true}).click();await expect.poll(()=>state.resourceRequests.length).toBe(1);expect(state.resourceRequests[0]).toMatchObject({kind:DiscussionResourceOperationKind.UPDATE_COMMENT,resourceId:comment.id,issueId:issue.id,number:12,pullRequest:false,change:{case:'commentBody',value:'Updated private comment'}});await expect(page.getByLabel(`Comment ${comment.id}, rendered Markdown`)).toContainText('Updated private comment');await page.getByRole('button',{name:`Delete comment ${comment.id}`,exact:true}).click();await page.getByRole('dialog',{name:`Delete comment ${comment.id}?`}).getByRole('button',{name:'Confirm deletion',exact:true}).click();await expect.poll(()=>state.resourceRequests.length).toBe(2);await expect(page.getByLabel(`Comment ${comment.id}, rendered Markdown`)).toHaveCount(0);
});


test('own issue reactions and subscription use exact retained operations and compact controls',async({page})=>{
 const state=await backend(page);await page.goto(detailURL);
 const controls=page.getByLabel('Issue reactions and notifications');
 await controls.getByRole('button',{name:'Add reaction',exact:true}).click();await controls.getByRole('button',{name:'Thumbs up',exact:true}).click();
 await expect(controls.getByRole('button',{name:'Remove Thumbs up reaction (1)'})).toBeVisible();
 expect(state.resourceRequests[0]).toMatchObject({issueId:issue.id,resourceId:issue.id,repositoryId:repository.id,number:12,reactionComment:false,kind:DiscussionResourceOperationKind.ADD_REACTION,expectedRevision:'c'.repeat(64)});
 await controls.getByRole('button',{name:'Remove Thumbs up reaction (1)'}).click();await expect(controls.getByRole('button',{name:'Add reaction',exact:true})).toBeEnabled();await controls.getByRole('button',{name:'Subscribe',exact:true}).click();
 await expect(controls.getByRole('button',{name:'Unsubscribe',exact:true})).toBeVisible();expect(state.resourceRequests[2]!.subscriptionLogin).toBe('alex');
 await expect(page.getByLabel('Discussion activity')).toContainText('changed the title');
});
test('uncertain engagement reload inspects the original key without a repeated native write',async({page})=>{
 const state=await backend(page);state.resourceUnknown=true;await page.goto(detailURL);const controls=page.getByLabel('Issue reactions and notifications');
 await controls.getByRole('button',{name:'Subscribe',exact:true}).click();await expect(controls).toContainText('Original outcome is unresolved');const original=state.resourceRequests[0]!.operationId;
 await page.reload();await controls.getByRole('button',{name:'Inspect original operation'}).click();expect(state.resourceRequests).toHaveLength(1);expect(state.resourceInspections).toEqual([original]);await expect(controls.getByRole('button',{name:'Subscribe',exact:true})).toBeDisabled();
});
for(const theme of ['dark','light'])test(`engagement ${theme} mobile controls fit and remain keyboard accessible`,async({page})=>{
 await backend(page);await page.setViewportSize({width:390,height:844});await page.addInitScript(theme=>localStorage.setItem('golf-theme',theme),theme);await page.goto(detailURL);
 const controls=page.getByLabel('Issue reactions and notifications');await controls.getByRole('button',{name:'Add reaction',exact:true}).focus();await page.keyboard.press('Enter');await expect(controls.getByRole('button',{name:'Thumbs up',exact:true})).toBeVisible();expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBe(true);
});

test('native notification inbox marks one own item as read with exact retained identity',async({page})=>{
 const state=await backend(page);await page.goto('/notifications');await expect(page.getByRole('heading',{name:'Notifications',exact:true})).toBeVisible();await page.getByRole('button',{name:'Mark notification 901 as read'}).click();await expect(page.getByRole('button',{name:'Mark notification 901 as read'})).toHaveCount(0);
 expect(state.resourceRequests[0]).toMatchObject({kind:DiscussionResourceOperationKind.MARK_NOTIFICATION_READ,resourceId:'901',repositoryId:repository.id,issueId:issue.id,number:12,expectedRevision:'d'.repeat(64)});await page.getByLabel('Notification state').selectOption('all');await expect(page.getByRole('button',{name:'Mark notification 901 as read'})).toBeDisabled();
});
test('uncertain notification mark-read resumes inspection and never sends another write',async({page})=>{
 const state=await backend(page);state.resourceUnknown=true;await page.goto('/notifications');await page.getByRole('button',{name:'Mark notification 901 as read'}).click();await expect(page.getByText('Original outcome is unresolved.',{exact:false})).toBeVisible();const key=state.resourceRequests[0]!.operationId;await page.reload();await page.getByRole('button',{name:'Inspect original operation'}).click();expect(state.resourceRequests).toHaveLength(1);expect(state.resourceInspections).toEqual([key]);
});
test('Markdown issue template selection pre-fills an editable draft and confirms replacement',async({page})=>{
 const state=await backend(page);state.templateEnabled=true;await page.goto('/alex/project/issues/new');await page.getByText('Issue templates',{exact:true}).click();await page.getByRole('button',{name:'Use template'}).click();await expect(page.getByLabel('Issue title')).toHaveValue('[Bug]');await expect(page.getByLabel('Description, plain text',{exact:true})).toHaveValue('## Steps\n');await page.getByLabel('Issue title').fill('Unsent change');page.once('dialog',dialog=>void dialog.dismiss());await page.getByRole('button',{name:'Use template'}).click();await expect(page.getByLabel('Issue title')).toHaveValue('Unsent change');
});

test('YAML issue forms validate required fields then prepare sanitized editable Markdown through the existing issue journal',async({page})=>{
 const state=await backend(page);state.yamlTemplate=true;await page.goto('/alex/project/issues/new');await page.getByText('Issue templates',{exact:true}).click();await page.getByRole('button',{name:'Use template'}).click();await expect(page.getByRole('form',{name:'Issue template form'})).toBeVisible();await expect(page.getByLabel('Issue title')).toHaveCount(0);await page.getByRole('button',{name:'Review issue draft'}).click();await expect(page.getByRole('alert')).toContainText('Complete Version');expect(state.creates).toHaveLength(0);await page.getByLabel('Version *',{exact:true}).fill('1.2.3');await page.getByLabel('Logs',{exact:true}).fill('echo test\n```unsafe\n');await page.getByRole('button',{name:'Review issue draft'}).click();await expect(page.getByRole('alert')).toContainText('Complete required choices for Agreement');await page.getByRole('checkbox',{name:'I checked existing issues. *'}).check();await page.getByRole('button',{name:'Review issue draft'}).click();await expect(page.getByLabel('Issue title')).toHaveValue('[Bug]');const body=page.getByLabel('Description, plain text',{exact:true});const text=await body.inputValue();expect(text).toContain('### Version\n\n1.2.3');expect(text).toContain('````shell\necho test\n```unsafe');expect(text).toContain('### Platform\n\nLinux');expect(text).toContain('- [x] I checked existing issues.');expect(text).not.toContain('Please provide enough detail.');expect(state.creates).toHaveLength(0);
});

for(const width of [1440,390])test(`native metadata controls use repository labels ${width}`,async({page})=>{
 await page.setViewportSize({width,height:1000});const state=await backend(page,true);enableLabels(state);state.canManage=true;state.labels=state.labels.map(r=>({...r,revision:'a'.repeat(64)}));
 const inherited:boolean[]=[];page.on('request',r=>{if(r.url().endsWith('/ListRepositoryLabels')) inherited.push(Boolean(r.postDataJSON().includeOrganizationLabels));});
 await page.goto(detailURL);await page.getByRole('button',{name:'Edit issue labels',exact:true}).click();
 await page.getByRole('checkbox',{name:'PRIVATE_LABEL_B',exact:true}).check();await page.getByRole('region',{name:'Edit issue labels',exact:true}).getByRole('button',{name:'Save changes',exact:true}).click();
 await expect.poll(()=>state.updates.length).toBe(1);expect(inherited.length).toBeGreaterThan(0);expect(inherited.every(value=>!value)).toBe(true);
 await page.goto(listURL);await page.getByRole('button',{name:'Labels',exact:true}).click();const panel=page.getByRole('region',{name:'labels administration'});
 await panel.getByRole('button',{name:'New label',exact:true}).click();await panel.getByLabel('Name',{exact:true}).fill('native-bug');await panel.getByRole('button',{name:'Save label',exact:true}).click();
 await expect.poll(()=>state.resourceRequests.length).toBe(1);await expect(panel).toContainText('Change confirmed.');expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true);
});

test('native comment editing is enabled independently of reactions and notifications',async({page})=>{
 const state=await backend(page,true);state.comments=[{...comment,revision:'a'.repeat(64),canEdit:true,canDelete:true}];await page.goto(detailURL);
 await page.getByRole('button',{name:`Edit comment ${comment.id}`,exact:true}).click();const form=page.getByRole('form',{name:`Edit comment ${comment.id}`,exact:true});
 await form.getByLabel('Comment',{exact:true}).fill('Native comment edited');await form.getByRole('button',{name:'Save comment',exact:true}).click();
 await expect.poll(()=>state.resourceRequests.length).toBe(1);await expect(page.getByLabel(`Comment ${comment.id}, rendered Markdown`)).toContainText('Native comment edited');
 await expect(page.getByLabel('Issue reactions and notifications')).toHaveCount(0);
});

 test('native engagement mounts working controls without unsupported attachments or templates',async({page})=>{
 const state=await backend(page,true,true);await page.goto(detailURL);
 const controls=page.getByLabel('Issue reactions and notifications');
 await controls.getByRole('button',{name:'Subscribe',exact:true}).click();
 await expect(controls.getByRole('button',{name:'Unsubscribe',exact:true})).toBeVisible();
 await expect(page.getByRole('heading',{name:'Activity',exact:true})).toBeVisible();
 expect(state.methods).not.toContain('ListDiscussionAttachments');
 await page.goto('/alex/project/issues/new');
 await expect(page.getByRole('heading',{name:'Create an issue',exact:true})).toBeVisible();
 expect(state.methods).not.toContain('ListIssueTemplates');
 });
