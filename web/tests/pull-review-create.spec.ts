import { portableRuntimeFixture } from './runtime-fixture';
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { create, clone } from '@bufbuild/protobuf';
import {
 UserSchema, RepositorySchema, PullRequestSchema, PullRequestReviewSchema, PullRequestReviewMutationSchema,
 GetSessionResponseSchema, GetAuthenticationOptionsResponseSchema, ListCapabilitiesResponseSchema, ListRepositoriesResponseSchema,
 GetRepositoryResponseSchema, GetPullRequestResponseSchema, ListPullRequestReviewsResponseSchema,
 GetPullRequestDiscussionResponseSchema, ListIssueCommentsResponseSchema, ListReviewerRunsResponseSchema,
 GetPullRequestDiffResponseSchema, CreatePullRequestReviewRequestSchema, CreatePullRequestReviewResponseSchema,
 GetPullRequestReviewMutationRequestSchema, GetPullRequestReviewMutationResponseSchema, LogoutResponseSchema,
 IssueState, IssueMutationState, PullRequestReviewState,
} from '../src/gen/golf/v1/golf_pb';
import type { CreatePullRequestReviewRequest, PullRequestReviewMutation } from '../src/gen/golf/v1/golf_pb';
import { reject, request, respond } from './rpc';
const base='a'.repeat(40),head='b'.repeat(40),revision='c'.repeat(64);
const user=create(UserSchema,{id:'2',login:'reader'});
const repository=create(RepositorySchema,{id:'7',name:'sample',fullName:'owner/sample',private:true,defaultBranch:'main'});
const pull=create(PullRequestSchema,{mergeBaseCommitId:base,id:'13',number:3,title:'Refine keyboard controls',body:'Private PR description',revision,state:IssueState.OPEN,user:{id:'9',login:'owner'},base:{repositoryId:'7',ref:'main',commitId:base},head:{repositoryId:'7',ref:'feature',commitId:head}});
async function backend(page:Page){
 const s={pull:clone(PullRequestSchema,pull),user:clone(UserSchema,user),signedIn:true,creates:[] as CreatePullRequestReviewRequest[],inspections:[] as string[],mutation:null as PullRequestReviewMutation|null,unknown:false,rejectCode:'',denial:false,unauthenticated:false,missingReview:false,wrong:'',reviewReads:0,detailDenied:false,listReview:false,hold:undefined as Promise<void>|undefined,logoutHold:undefined as Promise<void>|undefined};
 await page.route('**/rpc/**',async route=>{
  const method=new URL(route.request().url()).pathname.split('/').at(-1)!;
  if(method==='GetSession')return s.signedIn?respond(route,GetSessionResponseSchema,{user:s.user}):reject(route,'unauthenticated','Sign in required.');
  if(method==='GetAuthenticationOptions')return respond(route,GetAuthenticationOptionsResponseSchema,{localPasswordEnabled:true});
  if(method==='Logout'){if(s.logoutHold)await s.logoutHold;s.signedIn=false;return respond(route,LogoutResponseSchema,{});}
  if(method==='WatchRepository')return reject(route,'unimplemented','No stream in this unary fixture.');
  if(method==='ListCapabilities')return respond(route,ListCapabilitiesResponseSchema, portableRuntimeFixture);
  if(method==='ListRepositories')return respond(route,ListRepositoriesResponseSchema,{repositories:[repository]});
  if(method==='GetRepository')return respond(route,GetRepositoryResponseSchema,{repository});
  if(method==='GetPullRequest')return s.detailDenied?reject(route,'permission_denied','PR access revoked.'):respond(route,GetPullRequestResponseSchema,{pullRequest:s.pull});
  if(method==='ListPullRequestReviews'){s.reviewReads++;return respond(route,ListPullRequestReviewsResponseSchema,{reviews:s.listReview?[{id:'22',user:s.user,state:PullRequestReviewState.COMMENT,commitId:'e'.repeat(40),stale:false,body:'Earlier head summary'}]:[]});}
  if(method==='GetPullRequestDiscussion')return respond(route,GetPullRequestDiscussionResponseSchema,{issue:{id:'14',number:3,title:pull.title,state:IssueState.OPEN}});
  if(method==='ListIssueComments')return respond(route,ListIssueCommentsResponseSchema,{});
  if(method==='ListReviewerRuns')return respond(route,ListReviewerRunsResponseSchema,{});
  if(method==='GetPullRequestDiff'){const rawDiff='diff --git a/file.ts b/file.ts\n--- a/file.ts\n+++ b/file.ts\n@@ -1 +1 @@\n-old\n+new\n';return respond(route,GetPullRequestDiffResponseSchema,{repositoryId:repository.id,pullRequestId:s.pull.id,mergeBaseCommitId:s.pull.mergeBaseCommitId,baseCommitId:s.pull.base!.commitId,headCommitId:s.pull.head!.commitId,rawDiff,byteSize:new TextEncoder().encode(rawDiff).byteLength});}
  if(method==='CreatePullRequestReview'||method==='GetPullRequestReviewMutation'){
   if(method==='CreatePullRequestReview'){
    const input=request(route,CreatePullRequestReviewRequestSchema);s.creates.push(input);
    s.mutation=create(PullRequestReviewMutationSchema,{id:'1',idempotencyKey:input.idempotencyKey,state:s.rejectCode?IssueMutationState.REJECTED:s.unknown?IssueMutationState.OUTCOME_UNKNOWN:IssueMutationState.SUCCEEDED,repository:input.repository,repositoryId:input.repositoryId,pullRequestId:input.pullRequestId,number:input.number,headCommitId:input.headCommitId,reviewState:input.state,observedReviewId:s.unknown||s.rejectCode?'':'21',failureCode:s.rejectCode});
   }else s.inspections.push(request(route,GetPullRequestReviewMutationRequestSchema).idempotencyKey);
   if(s.hold)await s.hold;
   if(s.unauthenticated){s.signedIn=false;return reject(route,'unauthenticated','Your session expired.');}
   if(s.denial)return reject(route,'permission_denied','Review access denied.');
   const m=s.mutation!;
   const review=m.state===IssueMutationState.SUCCEEDED&&!s.missingReview?create(PullRequestReviewSchema,{id:'21',user:s.user,body:s.creates.at(-1)?.body||'',state:m.reviewState,commitId:m.headCommitId,submittedAt:'2026-10-03T12:00:00Z'}):undefined;
   const result={mutation:s.wrong==='target'?{...m,pullRequestId:'999'}:m,review:review?{...review,...(s.wrong==='author'?{user:{...s.user,id:'999'}}:s.wrong==='state'?{state:PullRequestReviewState.COMMENT}:s.wrong==='head'?{commitId:'d'.repeat(40)}:s.wrong==='id'?{id:'999'}:s.wrong==='body'?{body:'different summary'}:s.wrong==='comments'?{commentsCount:1}:{})}:undefined};
   return method==='CreatePullRequestReview'?respond(route,CreatePullRequestReviewResponseSchema,result):respond(route,GetPullRequestReviewMutationResponseSchema,result);
  }
  return reject(route,'unimplemented','Unsupported fixture operation.');
 });return s;
}
const panel=(page:Page)=>page.getByRole('region',{name:'Review changes',exact:true});
async function open(page:Page,files=false){await page.goto(`/owner/sample/pull/3${files?'/files':''}`);await page.getByRole('button',{name:'Review changes',exact:true}).click();await expect(panel(page)).toBeVisible();}

test('explicit overall review from changed files freezes complete selection and validates independently read receipt',async({page})=>{
 const s=await backend(page);await open(page,true);expect(s.creates).toHaveLength(0);
 await expect(panel(page).getByLabel('Review summary, Markdown')).toBeFocused();
 await panel(page).getByLabel('Review summary, Markdown').fill('## Summary\nSafe **changes**.');
 await panel(page).getByRole('button',{name:'Preview Markdown',exact:true}).click();await expect(page.getByLabel('Review summary preview').getByRole('heading',{name:'Summary'})).toBeVisible();
 await panel(page).getByRole('radio',{name:'Approve',exact:true}).check();
 await panel(page).getByRole('button',{name:'Submit review'}).click();await expect(panel(page).getByRole('status')).toContainText('Review submitted.');
 expect(s.creates).toHaveLength(1);expect(s.creates[0]).toMatchObject({repository:{owner:'owner',name:'sample'},repositoryId:'7',pullRequestId:'13',number:3,expectedRevision:revision,baseCommitId:base,headCommitId:head,state:PullRequestReviewState.APPROVED,body:'## Summary\nSafe **changes**.'});
 expect(await page.evaluate(()=>Object.keys(sessionStorage).filter(k=>k.startsWith('golf.review-intent.')))).toEqual([]);
 await panel(page).getByRole('button',{name:'Done',exact:true}).click();await expect(panel(page)).toHaveCount(0);await expect(page.getByRole('button',{name:'Review changes',exact:true})).toBeFocused();
});

test('unknown request keeps only target metadata and reload never restores text or automatically resends',async({page})=>{
 const s=await backend(page);s.unknown=true;await open(page);await panel(page).getByLabel('Review summary, Markdown').fill('SECRET REVIEW SUMMARY');await panel(page).getByRole('button',{name:'Submit review'}).click();await expect(panel(page).getByRole('status')).toContainText('outcome is unknown');
 const stored=await page.evaluate(()=>Object.entries(sessionStorage).filter(([k])=>k.startsWith('golf.review-intent.')));expect(stored).toHaveLength(1);expect(stored[0]![1]).not.toContain('SECRET');expect(Object.keys(JSON.parse(stored[0]![1])).sort()).toEqual(['headCommitId','key','number','pullRequestId','repositoryId','state']);
 await page.reload();await expect(panel(page)).toBeVisible();await expect(panel(page).getByLabel('Review summary, Markdown')).toHaveValue('');await expect(panel(page)).toContainText('status inspection only');expect(s.creates).toHaveLength(1);expect(s.inspections).toHaveLength(0);
 await panel(page).getByRole('button',{name:'Check review status'}).click();await expect.poll(()=>s.inspections.length).toBe(1);expect(s.inspections[0]).toBe(s.creates[0]!.idempotencyKey);expect(s.creates).toHaveLength(1);
 await panel(page).getByRole('button',{name:'Close',exact:true}).click();await expect(panel(page)).toHaveCount(0);await page.getByRole('button',{name:'Review changes',exact:true}).click();await expect(panel(page)).toContainText('status inspection only');
});

test('revalidation retains original unsent draft, blocks changed selection and requires explicit new selection',async({page})=>{
 const s=await backend(page);await open(page);await panel(page).getByLabel('Review summary, Markdown').fill('PRIVATE DRAFT');
 s.pull=create(PullRequestSchema,{...s.pull,revision:'e'.repeat(64),head:{...s.pull.head!,commitId:'f'.repeat(40)}});await page.getByRole('button',{name:'Refresh pull request',exact:true}).click();
 await expect(panel(page)).toContainText('changed while you were writing');await expect(panel(page).getByLabel('Review summary, Markdown')).toHaveValue('PRIVATE DRAFT');await expect(panel(page).getByRole('button',{name:'Submit review'})).toHaveCount(0);expect(s.creates).toHaveLength(0);
 page.once('dialog',dialog=>dialog.dismiss());await panel(page).getByRole('button',{name:'Review current selection'}).click();await expect(panel(page).getByLabel('Review summary, Markdown')).toHaveValue('PRIVATE DRAFT');
 page.once('dialog',dialog=>dialog.accept());await panel(page).getByRole('button',{name:'Review current selection'}).click();await expect(panel(page).getByLabel('Review summary, Markdown')).toHaveValue('');await expect(panel(page)).toContainText('f'.repeat(40));
 await panel(page).getByLabel('Review summary, Markdown').fill('New selection');await panel(page).getByRole('button',{name:'Submit review'}).click();await expect(panel(page).getByRole('status')).toContainText('Review submitted');expect(s.creates[0]!.headCommitId).toBe('f'.repeat(40));
});

for(const kind of ['author','draft','closed','merged'] as const)test(`${kind} exposes comment only, with no approval or request-changes decision`,async({page})=>{
 const s=await backend(page);s.pull=create(PullRequestSchema,{...s.pull,...(kind==='author'?{user}:kind==='draft'?{draft:true}:kind==='closed'?{state:IssueState.CLOSED}:{merged:true,state:IssueState.CLOSED})});await open(page);await expect(panel(page).getByRole('radio',{name:'Comment',exact:true})).toBeVisible();await expect(panel(page).getByRole('radio',{name:'Approve',exact:true})).toHaveCount(0);await expect(panel(page).getByRole('radio',{name:'Request changes',exact:true})).toHaveCount(0);await expect(panel(page).getByRole('button',{name:'Submit review'})).toBeDisabled();expect(s.creates).toHaveLength(0);
});

for(const wrong of ['target','author','state','head','id'])test(`mismatched ${wrong} receipt cannot produce a success or replacement write`,async({page})=>{
 const s=await backend(page);s.wrong=wrong;await open(page);await panel(page).getByRole('radio',{name:'Approve',exact:true}).check();await panel(page).getByRole('button',{name:'Submit review'}).click();await expect(panel(page).getByRole('alert')).toContainText('does not match');await expect(panel(page)).not.toContainText('Review submitted.');await expect(panel(page).getByRole('button',{name:'Review current selection'})).toHaveCount(0);expect(s.creates).toHaveLength(1);await page.reload();await expect(panel(page)).toContainText('status inspection only');expect(s.creates).toHaveLength(1);
});

test('historic success without current review access does not clear key or authorize another review',async({page})=>{
 const s=await backend(page);s.missingReview=true;await open(page);await panel(page).getByLabel('Review summary, Markdown').fill('Review summary');await panel(page).getByRole('button',{name:'Submit review'}).click();await expect(panel(page).getByRole('status')).toContainText('current access to the review could not be confirmed');await expect(panel(page).getByRole('button',{name:'Review current selection'})).toHaveCount(0);expect(await page.evaluate(()=>Object.keys(sessionStorage).filter(k=>k.startsWith('golf.review-intent.')))).toHaveLength(1);
});

test('pending native draft rejection directs inspection and only explicit new selection can create another key',async({page})=>{
 const s=await backend(page);s.rejectCode='pending_review';await open(page);await panel(page).getByLabel('Review summary, Markdown').fill('Review summary');await panel(page).getByRole('button',{name:'Submit review'}).click();await expect(panel(page)).toContainText('Inspect your existing native draft');const first=s.creates[0]!.idempotencyKey;
 await panel(page).getByRole('button',{name:'Review current selection'}).click();await expect(panel(page).getByLabel('Review summary, Markdown')).toHaveValue('');s.rejectCode='';await panel(page).getByLabel('Review summary, Markdown').fill('New reviewed intent');await panel(page).getByRole('button',{name:'Submit review'}).click();await expect(panel(page).getByRole('status')).toContainText('Review submitted');expect(s.creates).toHaveLength(2);expect(s.creates[1]!.idempotencyKey).not.toBe(first);
});

test('denied write clears private summary and exposes inspection only',async({page})=>{
 const s=await backend(page);s.denial=true;await open(page);await panel(page).getByLabel('Review summary, Markdown').fill('PRIVATE REVIEW');await panel(page).getByRole('button',{name:'Submit review'}).click();await expect(panel(page).getByRole('alert')).toContainText('denied');await expect(panel(page).getByLabel('Review summary, Markdown')).toHaveValue('');await expect(panel(page).getByRole('button',{name:'Submit review'})).toHaveCount(0);expect(s.creates).toHaveLength(1);
});

test('private access revocation removes unsent editor and late accepted result cannot restore it',async({page})=>{
 const s=await backend(page);let release!:()=>void;s.hold=new Promise(r=>release=r);await open(page);await panel(page).getByLabel('Review summary, Markdown').fill('PRIVATE REVIEW');await panel(page).getByRole('button',{name:'Submit review'}).click();await expect.poll(()=>s.creates.length).toBe(1);s.detailDenied=true;await page.getByRole('button',{name:'Refresh pull request',exact:true}).click();await expect(panel(page)).toHaveCount(0);release();await expect(page.locator('body')).not.toContainText('Review submitted.');await expect(page.locator('body')).not.toContainText('PRIVATE REVIEW');
});

test('sign out immediately cancels editor, clears metadata and ignores late response',async({page})=>{
 const s=await backend(page);let release!:()=>void;s.hold=new Promise(r=>release=r);let logoutRelease!:()=>void;s.logoutHold=new Promise(r=>logoutRelease=r);await open(page);await panel(page).getByLabel('Review summary, Markdown').fill('PRIVATE REVIEW');await panel(page).getByRole('button',{name:'Submit review'}).click();await expect.poll(()=>s.creates.length).toBe(1);await page.getByLabel('Your account',{exact:true}).click();await page.getByRole('button',{name:'Sign out',exact:true}).click();await expect(panel(page)).toHaveCount(0);await expect(page.locator('body')).not.toContainText('PRIVATE REVIEW');await expect(page.locator('body')).not.toContainText('Private PR description');release();logoutRelease();await expect(page.getByLabel('Email or username')).toBeVisible();await expect.poll(()=>page.evaluate(()=>Object.keys(sessionStorage).filter(k=>k.startsWith('golf.review-intent.')).length)).toBe(0);await expect(page.locator('body')).not.toContainText('Review submitted.');
});

for(const theme of ['light','dark'])for(const width of [1280,390])test(`review panel keyboard, Markdown safety and compact fit in ${theme} at ${width}`,async({page},testInfo)=>{
 await backend(page);await page.setViewportSize({width,height:900});await page.addInitScript(theme=>localStorage.setItem('golf.theme',theme),theme);await open(page,true);
 await panel(page).getByLabel('Review summary, Markdown').fill('# Review\n<script>window.executed=true</script>\n[unsafe](javascript:alert(1))');await panel(page).getByRole('button',{name:'Preview Markdown',exact:true}).click();await expect(page.getByLabel('Review summary preview').getByRole('heading',{name:'Review',exact:true})).toBeVisible();expect(await page.evaluate(()=>Boolean((window as Window&{executed?:boolean}).executed))).toBe(false);expect(await panel(page).locator('a[href^="javascript:"]').count()).toBe(0);
 await page.screenshot({path:testInfo.outputPath('review-panel.png'),fullPage:true});
 const bounds=await panel(page).boundingBox();expect(bounds).not.toBeNull();expect(bounds!.x).toBeGreaterThanOrEqual(0);expect(bounds!.x+bounds!.width).toBeLessThanOrEqual(width);expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBe(true);
 await panel(page).getByRole('button',{name:'Write',exact:true}).click();await panel(page).getByLabel('Review summary, Markdown').focus();await page.keyboard.press('Tab');await expect(panel(page).getByRole('radio',{name:'Comment',exact:true})).toBeFocused();await page.keyboard.press('ArrowRight');await expect(panel(page).getByRole('radio',{name:'Approve',exact:true})).toBeChecked();
 page.once('dialog',dialog=>dialog.accept());await panel(page).getByRole('button',{name:'Cancel',exact:true}).click();await expect(panel(page)).toHaveCount(0);await expect(page.getByRole('button',{name:'Review changes',exact:true})).toBeFocused();
});


test('earlier native COMMENT head is labeled even when native stale is false',async({page})=>{
 const s=await backend(page);s.listReview=true;await page.goto('/owner/sample/pull/3');await expect(page.getByLabel('Review 22 body, rendered Markdown')).toBeVisible();const row=page.locator('.pull-review-list>li');await expect(row).toContainText('Earlier snapshot');await expect(row).not.toContainText('Outdated');await row.getByText('Review details', {exact:true}).click();await expect(row).toContainText('Marked staleNo');
});

test('double submit admits one review request while accepted work is pending',async({page})=>{
 const s=await backend(page);let release!:()=>void;s.hold=new Promise(r=>release=r);await open(page);await panel(page).getByLabel('Review summary, Markdown').fill('One review');await panel(page).locator('form').evaluate(form=>{(form as HTMLFormElement).requestSubmit();(form as HTMLFormElement).requestSubmit();});await expect.poll(()=>s.creates.length).toBe(1);await expect(panel(page).getByRole('button',{name:'Check review status'})).toBeDisabled();release();await expect(panel(page).getByRole('status')).toContainText('Review submitted');expect(s.creates).toHaveLength(1);
});

test('account switch clears scoped pending metadata and cannot inspect the previous user outcome',async({page})=>{
 const s=await backend(page);s.unknown=true;await open(page);await panel(page).getByLabel('Review summary, Markdown').fill('PRIVATE USER SUMMARY');await panel(page).getByRole('button',{name:'Submit review'}).click();await expect(panel(page).getByRole('status')).toContainText('outcome is unknown');s.user=create(UserSchema,{id:'4',login:'new-reader'});await page.reload();await expect(page.getByRole('button',{name:'Review changes',exact:true})).toBeVisible();await expect(panel(page)).toHaveCount(0);await expect.poll(()=>page.evaluate(()=>Object.keys(sessionStorage).filter(k=>k.startsWith('golf.review-intent.')).length)).toBe(0);expect(s.inspections).toHaveLength(0);await expect(page.locator('body')).not.toContainText('PRIVATE USER SUMMARY');
});

test('rebound native PR identity cannot reuse a saved intent',async({page})=>{
 const s=await backend(page);s.unknown=true;await open(page);await panel(page).getByLabel('Review summary, Markdown').fill('PRIVATE USER SUMMARY');await panel(page).getByRole('button',{name:'Submit review'}).click();await expect(panel(page).getByRole('status')).toContainText('outcome is unknown');const old=s.creates[0]!.idempotencyKey;s.pull=create(PullRequestSchema,{...s.pull,id:'15'});await page.reload();await expect(page.getByRole('button',{name:'Review changes',exact:true})).toBeVisible();await expect(panel(page)).toHaveCount(0);await page.getByRole('button',{name:'Review changes',exact:true}).click();await expect(panel(page).getByLabel('Review summary, Markdown')).toHaveValue('');await panel(page).getByLabel('Review summary, Markdown').fill('New target');await panel(page).getByRole('button',{name:'Submit review'}).click();await expect.poll(()=>s.creates.length).toBe(2);expect(s.creates[1]).toMatchObject({pullRequestId:'15'});expect(s.creates[1]!.idempotencyKey).not.toBe(old);expect(s.inspections).toHaveLength(0);
});

test('body receipt mismatch retains key and prevents false success',async({page})=>{
 const s=await backend(page);s.wrong='body';await open(page);await panel(page).getByLabel('Review summary, Markdown').fill('Exact frozen summary');await panel(page).getByRole('button',{name:'Submit review'}).click();await expect(panel(page).getByRole('alert')).toContainText('does not match');await expect(panel(page)).not.toContainText('Review submitted.');expect(s.creates).toHaveLength(1);
});

test('comments and change requests require body; UTF-8 byte bound is checked before dispatch',async({page})=>{
 const s=await backend(page);await open(page);await panel(page).getByRole('radio',{name:'Request changes',exact:true}).check();await expect(panel(page).getByRole('button',{name:'Submit review'})).toBeDisabled();await panel(page).getByLabel('Review summary, Markdown').fill('😀'.repeat(2001));await panel(page).getByRole('button',{name:'Submit review'}).click();await expect(panel(page).getByRole('alert')).toContainText('6,000 UTF-8 bytes');expect(s.creates).toHaveLength(0);await panel(page).getByLabel('Review summary, Markdown').fill('Needs a focused change');await panel(page).getByRole('button',{name:'Submit review'}).click();await expect(panel(page).getByRole('status')).toContainText('Review submitted');expect(s.creates[0]!.state).toBe(PullRequestReviewState.REQUEST_CHANGES);
});


test('unverified selection cannot send or save a review request',async({page})=>{
 const s=await backend(page);s.pull=create(PullRequestSchema,{...s.pull,revision:'invalid',head:{...s.pull.head!,commitId:'feature'}});await open(page);await panel(page).getByLabel('Review summary, Markdown').fill('No invalid request');await expect(panel(page)).toContainText('selection could not be verified');await expect(panel(page).getByRole('button',{name:'Submit review'})).toBeDisabled();expect(s.creates).toHaveLength(0);expect(await page.evaluate(()=>Object.keys(sessionStorage).filter(k=>k.startsWith('golf.review-intent.')))).toEqual([]);
});


test('concurrent inline-comment absorption cannot produce a confirmed overall review',async({page})=>{
 const s=await backend(page);s.wrong='comments';await open(page);await panel(page).getByLabel('Review summary, Markdown').fill('Overall summary');await panel(page).getByRole('button',{name:'Submit review'}).click();await expect(panel(page).getByRole('alert')).toContainText('does not match');await expect(panel(page)).not.toContainText('Review submitted.');await expect(panel(page).getByRole('button',{name:'Review current selection'})).toHaveCount(0);expect(s.creates).toHaveLength(1);
});


test('a reloaded rejected intent explicitly opens a fresh current-selection editor without resending',async({page})=>{
 const s=await backend(page);s.unknown=true;await open(page);await panel(page).getByRole('radio',{name:'Approve',exact:true}).check();await panel(page).getByRole('button',{name:'Submit review'}).click();await expect(panel(page).getByRole('status')).toContainText('outcome is unknown');await page.reload();await expect(panel(page)).toBeVisible();await expect(panel(page)).toContainText('Requested decision: Approve');s.mutation=create(PullRequestReviewMutationSchema,{...s.mutation!,state:IssueMutationState.REJECTED,failureCode:'pending_review'});await panel(page).getByRole('button',{name:'Check review status'}).click();await expect(panel(page)).toContainText('Inspect your existing native draft');await panel(page).getByRole('button',{name:'Review current selection'}).click();await expect(panel(page)).toBeVisible();await expect(panel(page).getByLabel('Review summary, Markdown')).toHaveValue('');await expect(panel(page).getByRole('button',{name:'Submit review'})).toBeDisabled();expect(s.creates).toHaveLength(1);expect(s.inspections).toHaveLength(1);
});


test('workspace tab navigation preserves the original draft and closes with focus in the current workspace',async({page})=>{
 await backend(page);await open(page);await panel(page).getByLabel('Review summary, Markdown').fill('Draft across workspace views');await page.getByRole('link',{name:'Files changed',exact:true}).click();await expect(panel(page)).toBeVisible();await expect(panel(page).getByLabel('Review summary, Markdown')).toHaveValue('Draft across workspace views');await page.getByRole('link',{name:'Conversation',exact:true}).click();await expect(panel(page).getByLabel('Review summary, Markdown')).toHaveValue('Draft across workspace views');page.once('dialog',dialog=>dialog.accept());await panel(page).getByRole('button',{name:'Cancel',exact:true}).click();await expect(panel(page)).toHaveCount(0);await expect(page.getByRole('button',{name:'Review changes',exact:true})).toBeFocused();
});


for(const inspect of [false,true])test(`review ${inspect?'status':'submission'} 401 immediately clears authenticated workspace and private request metadata`,async({page})=>{
 const s=await backend(page);s.unknown=inspect;await open(page);await panel(page).getByLabel('Review summary, Markdown').fill('PRIVATE REVIEW SUMMARY');if(inspect){await panel(page).getByRole('button',{name:'Submit review'}).click();await expect(panel(page).getByRole('status')).toContainText('outcome is unknown');}s.unauthenticated=true;await panel(page).getByRole('button',{name:inspect?'Check review status':'Submit review',exact:true}).click();await expect(page.getByLabel('Email or username')).toBeVisible();await expect(panel(page)).toHaveCount(0);await expect(page.locator('body')).not.toContainText('Private PR description');await expect(page.locator('body')).not.toContainText('PRIVATE REVIEW SUMMARY');await expect.poll(()=>page.evaluate(()=>Object.keys(sessionStorage).filter(k=>k.startsWith('golf.review-intent.')).length)).toBe(0);expect(s.creates).toHaveLength(1);expect(s.inspections).toHaveLength(inspect?1:0);
});
