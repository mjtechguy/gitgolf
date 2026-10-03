import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { create, clone, toJson } from '@bufbuild/protobuf';
import { UserSchema, RepositorySchema, PullRequestSchema, PullRequestReviewSchema, PullRequestReviewCommentSchema, WatchRepositoryResponseSchema, GetSessionResponseSchema, GetAuthenticationOptionsResponseSchema, ListRepositoriesResponseSchema, GetRepositoryResponseSchema, GetPullRequestResponseSchema, GetPullRequestDiffResponseSchema, ListPullRequestReviewsResponseSchema, GetPullRequestDiscussionResponseSchema, ListIssueCommentsResponseSchema, ListReviewerRunsResponseSchema, LogoutResponseSchema, GetPullRequestReviewCommentsRequestSchema, GetPullRequestReviewCommentsResponseSchema, IssueState, PullRequestReviewState } from '../src/gen/golf/v1/golf_pb';
import type { GetPullRequestReviewCommentsRequest } from '../src/gen/golf/v1/golf_pb';
import { reject, request, respond } from './rpc';
// Development StrictMode cancels its first admitted read and remounts once; both requests must bind the same target.
const base='a'.repeat(40),head='b'.repeat(40),older='c'.repeat(40);
const user=create(UserSchema,{id:'2',login:'reader'});
const repository=create(RepositorySchema,{id:'7',name:'sample',fullName:'owner/sample',private:true,defaultBranch:'main'});
const pull=create(PullRequestSchema,{mergeBaseCommitId:base,id:'13',number:3,title:'Inline review workspace',body:'Private pull body',revision:'d'.repeat(64),state:IssueState.OPEN,user:{id:'9',login:'owner'},base:{repositoryId:'7',ref:'main',commitId:base},head:{repositoryId:'7',ref:'feature',commitId:head}});
const review=create(PullRequestReviewSchema,{id:'9007199254740993',user,body:'Overall review',state:PullRequestReviewState.COMMENT,commitId:head,commentsCount:3,submittedAt:'2026-10-03T12:00:00Z'});
const comment=create(PullRequestReviewCommentSchema,{id:'9007199254740994',reviewId:review.id,user,body:'## PRIVATE INLINE\n\nCheck **this line**.\n<script>window.executed=true</script>\n[Unsafe](javascript:alert(1))',path:'src/日本語 [check].ts',newLine:3,commitId:base,diffHunk:'@@ -1,1 +1,1 @@\n-old\n+<script>window.executed=true</script>',createdAt:'2026-10-03T12:00:00Z',updatedAt:'2026-10-03T12:05:00Z',htmlUrl:'https://forge.example/owner/sample/pulls/3#issuecomment-9007199254740994',resolved:true});
const oldComment=create(PullRequestReviewCommentSchema,{...comment,id:'9007199254740995',body:'Old side observation',user:undefined,newLine:0,oldLine:4,resolved:false,htmlUrl:'javascript:alert(1)'});
const reply=create(PullRequestReviewCommentSchema,{...comment,id:'9007199254740996',body:'Reply from another author',user:create(UserSchema,{id:'4',login:'contributor'}),resolved:false,htmlUrl:'https://forge.example/owner/sample/pulls/3#issuecomment-9007199254740996'});
async function backend(page:Page){
 const s={signedIn:true,user:clone(UserSchema,user),pull:clone(PullRequestSchema,pull),review:clone(PullRequestReviewSchema,review),comments:[clone(PullRequestReviewCommentSchema,comment),clone(PullRequestReviewCommentSchema,oldComment),clone(PullRequestReviewCommentSchema,reply)],reads:[] as GetPullRequestReviewCommentsRequest[],reviewReads:0,discussionReads:0,denied:false,expired:false,detailDenied:false,hold:undefined as Promise<void>|undefined,currentHead:head,wrong:'',detailHold:undefined as Promise<void>|undefined,live:false,streamChange:false,streamCursor:1};
 await page.route('**/rpc/**',async route=>{
  const method=new URL(route.request().url()).pathname.split('/').at(-1)!;
  if(method==='GetSession')return s.signedIn?respond(route,GetSessionResponseSchema,{user:s.user}):reject(route,'unauthenticated','Sign in required.');
  if(method==='GetAuthenticationOptions')return respond(route,GetAuthenticationOptionsResponseSchema,{localPasswordEnabled:true});
  if(method==='Logout'){s.signedIn=false;return respond(route,LogoutResponseSchema,{});}
  if(method==='WatchRepository'){if(!s.live)return reject(route,'unimplemented','No live stream in this unary fixture.');const changing=s.streamChange;if(changing){s.streamChange=false;s.streamCursor++;}const envelope=(flags:number,value:unknown)=>{const data=Buffer.from(JSON.stringify(value));const header=Buffer.alloc(5);header[0]=flags;header.writeUInt32BE(data.length,1);return Buffer.concat([header,data]);};return route.fulfill({status:200,contentType:'application/connect+json',body:Buffer.concat([envelope(0,toJson(WatchRepositoryResponseSchema,create(WatchRepositoryResponseSchema,{repositoryId:'7',cursor:String(s.streamCursor),kind:changing?'change':'heartbeat',topics:changing?['pulls']:[]}))),envelope(0,toJson(WatchRepositoryResponseSchema,create(WatchRepositoryResponseSchema,{repositoryId:'7',cursor:String(s.streamCursor),kind:'reconnect'}))),envelope(2,{})])});}
  if(method==='ListRepositories')return respond(route,ListRepositoriesResponseSchema,{repositories:[repository]});
  if(method==='GetRepository')return respond(route,GetRepositoryResponseSchema,{repository});
  if(method==='GetPullRequest'){if(s.detailHold)await s.detailHold;return s.detailDenied?reject(route,'permission_denied','Pull request access revoked.'):respond(route,GetPullRequestResponseSchema,{pullRequest:s.pull});}
  if(method==='ListPullRequestReviews'){s.reviewReads++;return respond(route,ListPullRequestReviewsResponseSchema,{reviews:[s.review]});}
  if(method==='GetPullRequestDiff'){const rawDiff='diff --git a/src/example.ts b/src/example.ts\n--- a/src/example.ts\n+++ b/src/example.ts\n@@ -1 +1 @@\n-old\n+new\n';return respond(route,GetPullRequestDiffResponseSchema,{repositoryId:repository.id,pullRequestId:s.pull.id,mergeBaseCommitId:s.pull.mergeBaseCommitId,baseCommitId:base,headCommitId:head,rawDiff,byteSize:new TextEncoder().encode(rawDiff).byteLength});}
  if(method==='GetPullRequestDiscussion'){s.discussionReads++;return respond(route,GetPullRequestDiscussionResponseSchema,{issue:{id:'14',number:3,title:pull.title,state:IssueState.OPEN}});}
  if(method==='ListIssueComments')return respond(route,ListIssueCommentsResponseSchema,{});
  if(method==='ListReviewerRuns')return respond(route,ListReviewerRunsResponseSchema,{});
  if(method==='GetPullRequestReviewComments'){
   s.reads.push(request(route,GetPullRequestReviewCommentsRequestSchema));if(s.hold)await s.hold;
   if(s.expired){s.signedIn=false;return reject(route,'unauthenticated','Your session expired.');}
   if(s.denied)return reject(route,'permission_denied','Inline comments are inaccessible.');
   return respond(route,GetPullRequestReviewCommentsResponseSchema,{repositoryId:s.wrong==='repository'?'8':'7',pullRequestId:s.wrong==='pull'?'15':'13',review:{...s.review,id:s.wrong==='review'?'999':s.review.id,commitId:s.wrong==='review-commit'?older:s.review.commitId,commentsCount:s.wrong==='count'?99:s.comments.length},currentHeadCommitId:s.wrong==='head'?'main':s.currentHead,comments:s.comments});
  }
  return reject(route,'unimplemented','Unsupported fixture operation.');
 });return s;
}
const panel=(page:Page)=>page.getByRole('region',{name:`Inline comments for review ${review.id}`,exact:true});
async function open(page:Page){await page.goto('/owner/sample/pull/3');await page.getByRole('button',{name:'Show inline comments (3)',exact:true}).click();await expect(panel(page)).toBeVisible();}

test('comments load only on explicit request, preserve IDs/reply authors and render old/new file lines',async({page})=>{
 const s=await backend(page);await page.goto('/owner/sample/pull/3');await expect(page.getByRole('button',{name:'Show inline comments (3)',exact:true})).toBeVisible();expect(s.reads).toHaveLength(0);await page.getByRole('button',{name:'Show inline comments (3)',exact:true}).click();await expect(panel(page).getByRole('article')).toHaveCount(3);
 expect(s.reads).toHaveLength(2);for(const read of s.reads)expect(read).toMatchObject({repository:{owner:'owner',name:'sample'},repositoryId:'7',pullRequestId:'13',number:3,reviewId:review.id,reviewCommitId:head});expect(Object.keys(s.reads[0]!)).not.toContain('page');
 await expect(panel(page)).toContainText('Current observed head');await expect(panel(page)).toContainText('contributor');await expect(panel(page)).toContainText('Deleted or unavailable author');await expect(panel(page)).toContainText('Old line 4');await expect(panel(page)).toContainText('New line 3');await expect(panel(page).getByRole('link',{name:/View .*line/})).toHaveCount(0);await expect(panel(page).getByRole('button',{name:/Load more/})).toHaveCount(0);
 await expect(panel(page).getByRole('article',{name:`Inline comment ${comment.id}`,exact:true})).toContainText('Comment resolved');await expect(panel(page).getByRole('article',{name:`Inline comment ${reply.id}`,exact:true})).not.toContainText('Comment resolved');
 await panel(page).getByRole('article',{name:`Inline comment ${comment.id}`,exact:true}).getByText('Comment details',{exact:true}).click();await expect(panel(page)).toContainText('Deleted or unavailable resolver');await expect(panel(page)).toContainText('Line / blame commit');await expect(panel(page)).toContainText(base);
 await expect(panel(page).getByRole('link',{name:`Open original inline comment ${comment.id}`})).toHaveAttribute('href',comment.htmlUrl);await expect(panel(page).getByRole('link',{name:`Open original inline comment ${oldComment.id}`})).toHaveCount(0);
 const storage=await page.evaluate(()=>JSON.stringify({...sessionStorage,...localStorage}));expect(storage).not.toContain('PRIVATE INLINE');expect(storage).not.toContain('日本語');
});

test('safe Markdown and recorded context do not execute HTML or fabricate suggestions/actions',async({page})=>{
 await backend(page);await open(page);await expect(page.getByLabel(`Inline comment ${comment.id} body, rendered Markdown`).getByRole('heading',{name:'PRIVATE INLINE'})).toBeVisible();const article=panel(page).getByRole('article',{name:`Inline comment ${comment.id}`,exact:true});await article.getByText('Comment details',{exact:true}).click();await article.getByText('Recorded diff context',{exact:true}).click();await expect(page.getByLabel(`Recorded diff context for comment ${comment.id}`)).toContainText('<script>window.executed=true</script>');expect(await page.evaluate(()=>Boolean((window as Window&{executed?:boolean}).executed))).toBe(false);expect(await panel(page).locator('a[href^="javascript:"]').count()).toBe(0);await expect(panel(page).getByRole('button',{name:/Reply|Resolve|Apply suggestion/})).toHaveCount(0);
});

for(const current of ['earlier','unavailable'])test(`${current} head is labeled from the observation without native stale or blame inference`,async({page})=>{
 const s=await backend(page);s.currentHead=current==='earlier'?older:'';s.review.stale=false;s.review.dismissed=true;await open(page);await expect(panel(page)).toContainText(current==='earlier'?'Earlier snapshot':'Current snapshot unavailable');await expect(panel(page)).toContainText('Dismissed');await expect(panel(page)).not.toContainText('Outdated');if(current==='unavailable')await expect(panel(page)).not.toContainText('Earlier snapshot');
});

for(const wrong of ['repository','pull','review','review-commit','count','head'])test(`mismatched ${wrong} receipt reveals no comment text`,async({page})=>{
 const s=await backend(page);s.wrong=wrong;await open(page);await expect(panel(page).getByRole('alert')).toContainText('do not match');await expect(panel(page)).not.toContainText('PRIVATE INLINE');expect(s.reads).toHaveLength(2);
});

for(const invalid of ['duplicate','id','review-id','zero-lines','both-lines','huge-line','path','date','blame','hunk','body','collection'])test(`invalid ${invalid} fails the whole bounded collection`,async({page})=>{
 const s=await backend(page);const first=s.comments[0]!;
 if(invalid==='duplicate')s.comments[1]=clone(PullRequestReviewCommentSchema,first);
 if(invalid==='id')first.id='0';if(invalid==='review-id')first.reviewId='99';if(invalid==='zero-lines')first.newLine=0;if(invalid==='both-lines')first.oldLine=3;if(invalid==='huge-line')first.newLine=2147483648;if(invalid==='path')first.path='../secret';if(invalid==='date')first.createdAt='not-a-date';if(invalid==='blame')first.commitId='main';if(invalid==='hunk')first.diffHunk='x'.repeat(65537);if(invalid==='body')first.body='x'.repeat(262145);if(invalid==='collection')s.comments=Array.from({length:101},(_,i)=>create(PullRequestReviewCommentSchema,{...first,id:String(i+1)}));
 await open(page);await expect(panel(page).getByRole('alert')).toBeVisible();await expect(panel(page).getByRole('article')).toHaveCount(0);await expect(panel(page)).not.toContainText('PRIVATE INLINE');expect(s.reads).toHaveLength(2);
});

test('a current complete zero-comment read is distinct from a stale list count',async({page})=>{
 const s=await backend(page);s.comments=[];await open(page);await expect(panel(page)).toContainText('No inline comments are visible in this current review observation.');expect(s.reads).toHaveLength(2);
});

test('native zero count and pending records do not trigger eager reads or claim comment absence',async({page})=>{
 const s=await backend(page);s.review.commentsCount=0;await page.goto('/owner/sample/pull/3');await expect(page.getByRole('heading',{name:'Reviews',exact:true})).toBeVisible();await expect(page.getByRole('button',{name:/Show inline comments/})).toHaveCount(0);await expect(page.locator('body')).not.toContainText('No inline comments');s.review.commentsCount=3;s.review.state=PullRequestReviewState.PENDING;s.review.user=create(UserSchema,{id:'8',login:'other'});await page.getByRole('button',{name:'Refresh reviews',exact:true}).click();await expect(page.getByRole('button',{name:/Show inline comments/})).toHaveCount(0);expect(s.reads).toHaveLength(0);
});

test('refresh hides private comments while revalidating and denial clears the collection',async({page})=>{
 const s=await backend(page);await open(page);await expect(panel(page)).toContainText('PRIVATE INLINE');let release!:()=>void;s.hold=new Promise(r=>release=r);s.denied=true;await page.getByRole('button',{name:`Refresh inline comments for review ${review.id}`} ).click();await expect(panel(page)).toContainText('Reading inline comments');await expect(panel(page)).not.toContainText('PRIVATE INLINE');release();await expect(panel(page).getByRole('alert')).toContainText('inaccessible');await expect(panel(page)).not.toContainText('PRIVATE INLINE');expect(s.reads).toHaveLength(3);
});

test('collapse cancels an inflight read; later reopen performs a fresh read',async({page})=>{
 const s=await backend(page);let release!:()=>void;s.hold=new Promise(r=>release=r);await open(page);await expect.poll(()=>s.reads.length).toBe(2);await page.getByRole('button',{name:'Hide inline comments (3)',exact:true}).click();await expect(panel(page)).toHaveCount(0);release();s.hold=undefined;await page.getByRole('button',{name:'Show inline comments (3)',exact:true}).click();await expect(panel(page)).toContainText('PRIVATE INLINE');expect(s.reads).toHaveLength(4);
});

test('PR access revocation removes an open reader and late results cannot restore private content',async({page})=>{
 const s=await backend(page);let release!:()=>void;s.hold=new Promise(r=>release=r);await open(page);await expect.poll(()=>s.reads.length).toBe(2);s.detailDenied=true;await page.getByRole('button',{name:'Refresh pull request',exact:true}).click();await expect(panel(page)).toHaveCount(0);release();await expect(page.locator('body')).not.toContainText('PRIVATE INLINE');
});

test('expired comment read immediately signs out and discards private workspace',async({page})=>{
 const s=await backend(page);s.expired=true;await page.goto('/owner/sample/pull/3');await page.getByRole('button',{name:'Show inline comments (3)',exact:true}).click();await expect(page.getByLabel('Email or username')).toBeVisible();await expect(panel(page)).toHaveCount(0);await expect(page.locator('body')).not.toContainText('Private pull body');await expect(page.locator('body')).not.toContainText('PRIVATE INLINE');
});

test('sign-out cancels delayed reads and a new account does not receive old private results',async({page})=>{
 const s=await backend(page);let release!:()=>void;s.hold=new Promise(r=>release=r);await open(page);await expect.poll(()=>s.reads.length).toBe(2);await page.getByLabel('Your account',{exact:true}).click();await page.getByRole('button',{name:'Sign out',exact:true}).click();await expect(page.getByLabel('Email or username')).toBeVisible();release();s.hold=undefined;s.signedIn=true;s.user=create(UserSchema,{id:'5',login:'new-reader'});await page.reload();await expect(page.getByRole('button',{name:'Show inline comments (3)',exact:true})).toBeVisible();await expect(panel(page)).toHaveCount(0);await expect(page.locator('body')).not.toContainText('PRIVATE INLINE');expect(s.reads).toHaveLength(2);
});

for(const theme of ['dark','light'])for(const width of [1280,390])test(`compact inline comments fit ${theme} at ${width} with keyboard disclosures`,async({page})=>{
 const s=await backend(page);s.comments[0]!.user=create(UserSchema,{...user,avatarUrl:'https://user:secret@images.example/avatar.png'});s.comments[1]!.user=create(UserSchema,{id:'8',login:'bad-avatar',avatarUrl:'javascript:alert(1)'});await page.setViewportSize({width,height:900});await page.addInitScript(theme=>localStorage.setItem('golf.theme',theme),theme);await page.goto('/owner/sample/pull/3');const show=page.getByRole('button',{name:'Show inline comments (3)',exact:true});await show.focus();await page.keyboard.press('Enter');await expect(panel(page).getByRole('article')).toHaveCount(3);await expect(panel(page).locator('img')).toHaveCount(0);const box=await panel(page).boundingBox();expect(box!.x).toBeGreaterThanOrEqual(0);expect(box!.x+box!.width).toBeLessThanOrEqual(width);expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);const details=panel(page).getByRole('article',{name:`Inline comment ${comment.id}`,exact:true}).getByText('Comment details',{exact:true});await details.focus();await page.keyboard.press('Enter');await expect(panel(page)).toContainText('Deleted or unavailable resolver');expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);await page.getByRole('button',{name:'Hide inline comments (3)',exact:true}).click();await expect(panel(page)).toHaveCount(0);await expect(page.getByRole('button',{name:'Show inline comments (3)',exact:true})).toBeFocused();
});


test('own pending review comments are inspectable read only; foreign pending has no read action',async({page})=>{
 const s=await backend(page);s.review.state=PullRequestReviewState.PENDING;s.review.updatedAt='2026-10-04T13:00:00Z';await open(page);const reviews=page.getByRole('region',{name:'Reviews',exact:true});await expect(reviews).toContainText('Draft updated');await expect(reviews.locator('.pull-review-list > li > p.muted time')).toHaveCount(1);await expect(reviews.locator('.pull-review-list > li > p.muted time')).toHaveAttribute('datetime',s.review.updatedAt);await expect(page.getByRole('region',{name:'Reviews',exact:true})).not.toContainText('Submitted');await expect(panel(page)).toContainText('Draft review · read only');await expect(panel(page)).toContainText('PRIVATE INLINE');await expect(panel(page).getByRole('button',{name:/Submit|Reply|Discard/})).toHaveCount(0);
 await page.getByRole('button',{name:'Hide inline comments (3)',exact:true}).click();s.review.user=create(UserSchema,{id:'8',login:'other'});await page.getByRole('button',{name:'Refresh reviews',exact:true}).click();await expect(page.getByRole('button',{name:/Show inline comments/})).toHaveCount(0);expect(s.reads).toHaveLength(2);
});

test('pending response cannot swap ownership into the selected reader',async({page})=>{
 const s=await backend(page);s.review.state=PullRequestReviewState.PENDING;await page.goto('/owner/sample/pull/3');await expect(page.getByRole('button',{name:'Show inline comments (3)',exact:true})).toBeVisible();s.review.user=create(UserSchema,{id:'8',login:'other'});await page.getByRole('button',{name:'Show inline comments (3)',exact:true}).click();await expect(panel(page).getByRole('alert')).toContainText('do not match');await expect(panel(page)).not.toContainText('PRIVATE INLINE');
});

test('Files changed opens shared review and discussion readers only on request',async({page})=>{
 const s=await backend(page);await page.goto('/owner/sample/pull/3/files');const show=page.getByRole('button',{name:'Show review comments',exact:true});await expect(show).toBeVisible();expect(s.reviewReads).toBe(0);expect(s.discussionReads).toBe(0);expect(s.reads).toHaveLength(0);await expect(page.getByRole('button',{name:'Review changes',exact:true})).toHaveCount(1);
 await show.click();const scope=page.getByRole('region',{name:'Files changed comments',exact:true});await expect(scope.getByRole('heading',{name:'Reviews',exact:true})).toBeVisible();await expect.poll(()=>s.reviewReads).toBe(2);await expect.poll(()=>s.discussionReads).toBe(2);expect(s.reads).toHaveLength(0);await expect(page.getByRole('button',{name:'Review changes',exact:true})).toHaveCount(1);await expect(scope.getByRole('button',{name:'Review changes from comments',exact:true})).toBeVisible();
 await scope.getByRole('button',{name:'Show inline comments (3)',exact:true}).click();await expect(panel(page)).toContainText('PRIVATE INLINE');await expect(panel(page).getByRole('link',{name:/View .*line/})).toHaveCount(0);await page.getByRole('button',{name:'Hide review comments',exact:true}).click();await expect(scope).toHaveCount(0);await expect(page.locator('body')).not.toContainText('PRIVATE INLINE');
});

for(const theme of ['dark','light'])for(const width of [1280,390,320])test(`Files changed comments fit ${theme} at ${width} and share the review composer`,async({page})=>{
 await backend(page);await page.setViewportSize({width,height:900});await page.addInitScript(theme=>localStorage.setItem('golf.theme',theme),theme);await page.goto('/owner/sample/pull/3/files');
 for(const label of ['Unified','Split','Show review comments','Review changes']){
  const button=page.locator('.diff-toolbar').getByRole('button',{name:label,exact:true});await expect(button).toBeVisible();
  const lines=await button.evaluate(el=>{const walker=document.createTreeWalker(el,NodeFilter.SHOW_TEXT);const tops:number[]=[];while(walker.nextNode()){const node=walker.currentNode;if(!node.textContent?.trim())continue;const range=document.createRange();range.selectNodeContents(node);for(const rect of range.getClientRects())if(rect.width)tops.push(Math.round(rect.top));}const box=el.getBoundingClientRect();return{lines:new Set(tops).size,inside:box.left>=0&&box.right<=innerWidth,clipped:el.scrollWidth>el.clientWidth};});
  expect(lines).toEqual({lines:label==='Show review comments'?0:1,inside:true,clipped:false});
  if(width<=760)expect((await button.boundingBox())!.height).toBeGreaterThanOrEqual(44);
 }
 const toolbar=await page.locator('.diff-toolbar').boundingBox();const firstCode=await page.locator('.diff-code').first().boundingBox();
 // Offline fixtures retain manual refresh alongside the review actions.
 if(width<=390){expect(toolbar!.height).toBeLessThanOrEqual(150);expect(firstCode!.y).toBeLessThan(850);}
 console.log('Fixture diff density '+JSON.stringify({theme,width,toolbar:toolbar!.height,firstCode:firstCode!.y}));
 await page.screenshot({path:`test-results/compact-review-toolbar-${theme}-${width}.png`});
 await page.getByRole('button',{name:'Split',exact:true}).click();await expect(page.getByRole('button',{name:'Split',exact:true})).toHaveAttribute('aria-pressed','true');
 await page.getByRole('button',{name:'Unified',exact:true}).click();await expect(page.getByRole('button',{name:'Unified',exact:true})).toHaveAttribute('aria-pressed','true');
 const show=page.getByRole('button',{name:'Show review comments',exact:true});await show.focus();await page.keyboard.press('Enter');const scope=page.getByRole('region',{name:'Files changed comments',exact:true});await scope.getByRole('button',{name:'Show inline comments (3)',exact:true}).click();await expect(panel(page).getByRole('article')).toHaveCount(3);expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);await scope.getByRole('button',{name:'Review changes from comments',exact:true}).click();await expect(page.getByRole('heading',{name:'Review changes',exact:true})).toBeVisible();await expect(page.getByRole('textbox',{name:'Review summary, Markdown',exact:true})).toBeVisible();await expect(page.getByRole('dialog')).toHaveCount(0);
});

test('resolved author identity is per comment and native stale remains separate from current head',async({page})=>{
 const s=await backend(page);s.comments[0]!.resolver=create(UserSchema,{id:'8',login:'maintainer'});s.review.stale=true;await open(page);await expect(panel(page)).toContainText('Current observed head');await expect(panel(page)).toContainText('Outdated');const first=panel(page).getByRole('article',{name:`Inline comment ${comment.id}`,exact:true});await first.getByText('Comment details',{exact:true}).click();await expect(first).toContainText('maintainer');await expect(panel(page).getByRole('article',{name:`Inline comment ${reply.id}`,exact:true})).not.toContainText('Comment resolved');
});

test('closing Files changed comments cancels delayed reads and removes the private reader',async({page})=>{
 const s=await backend(page);let release!:()=>void;s.hold=new Promise(r=>release=r);await page.goto('/owner/sample/pull/3/files');await page.getByRole('button',{name:'Show review comments',exact:true}).click();await page.getByRole('button',{name:'Show inline comments (3)',exact:true}).click();await expect.poll(()=>s.reads.length).toBe(2);await page.getByRole('button',{name:'Hide review comments',exact:true}).click();release();s.hold=undefined;await expect(panel(page)).toHaveCount(0);await expect(page.locator('body')).not.toContainText('PRIVATE INLINE');await page.getByRole('button',{name:'Show review comments',exact:true}).click();await expect(page.getByRole('button',{name:'Show inline comments (3)',exact:true})).toBeVisible();await expect(panel(page)).toHaveCount(0);expect(s.reads).toHaveLength(2);
});


test('constant workspace navigation keeps keyboard focus while private pull content revalidates',async({page})=>{
 const s=await backend(page);s.live=true;await open(page);await expect(panel(page)).toContainText('PRIVATE INLINE');await page.getByRole('button',{name:'Review changes',exact:true}).click();await page.getByRole('textbox',{name:'Review summary, Markdown',exact:true}).fill('Private unsent review');let release!:()=>void;s.detailHold=new Promise(r=>release=r);s.streamChange=true;await expect(page.getByText('Checking pull request access…',{exact:true})).toBeVisible();const tabs=page.getByRole('navigation',{name:'Pull request workspace',exact:true});await expect(tabs).toBeVisible();await expect(page.getByLabel('Pull request body, rendered Markdown')).toBeHidden();await expect(panel(page)).toBeHidden();await expect(page.getByRole('textbox',{name:'Review summary, Markdown',exact:true})).toBeHidden();const files=tabs.getByRole('link',{name:'Files changed',exact:true});await files.focus();await page.keyboard.press('Enter');await expect(files).toHaveAttribute('aria-current','page');await expect(files).toBeFocused();await expect(page.getByRole('region',{name:'Pull request diff',exact:true})).toBeHidden();release();s.detailHold=undefined;await expect(page.getByRole('region',{name:'Pull request diff',exact:true})).toBeVisible();await expect(page.getByRole('textbox',{name:'Review summary, Markdown',exact:true})).toHaveValue('Private unsent review');
});

test('explicit inline refresh stays available while live and observes native edits without a journal event',async({page})=>{
 const s=await backend(page);s.live=true;await open(page);await expect(page.getByText('Live',{exact:true})).toBeVisible();await expect(page.locator('.repository-browser.live-connected')).toBeVisible();await expect(panel(page)).toContainText('PRIVATE INLINE');await expect(panel(page).getByRole('button',{name:`Refresh inline comments for review ${review.id}`,exact:true})).toBeVisible();await expect(panel(page).getByRole('button',{name:`Refresh inline comments for review ${review.id}`,exact:true})).not.toHaveClass(/manual-refresh/);s.comments[0]!.body='Updated native review comment';s.comments[0]!.resolved=false;s.comments[0]!.resolver=undefined;let release!:()=>void;s.hold=new Promise(r=>release=r);await panel(page).getByRole('button',{name:`Refresh inline comments for review ${review.id}`,exact:true}).click();await expect(panel(page)).toContainText('Reading inline comments…');await expect(panel(page)).not.toContainText('PRIVATE INLINE');release();s.hold=undefined;await expect(panel(page)).toContainText('Updated native review comment');await expect(panel(page).getByRole('article',{name:`Inline comment ${comment.id}`,exact:true})).not.toContainText('Comment resolved');expect(s.reads).toHaveLength(3);
});
