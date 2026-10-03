import {expect,test} from '@playwright/test';
import type {Page} from '@playwright/test';
import {create} from '@bufbuild/protobuf';
import * as v from '../src/gen/golf/v1/golf_pb';
import type {CreatePullRequestRequest,RepositoryComparisonSelection} from '../src/gen/golf/v1/golf_pb';
import {reject,request,respond} from './rpc';
const base='a'.repeat(40),head='b'.repeat(40);
const user=create(v.UserSchema,{id:'9007199254740993',login:'alex'});
const repository=create(v.RepositorySchema,{id:'9007199254740993',name:'design-system',fullName:'alex/design-system',defaultBranch:'main',private:true});
const fork=create(v.RepositorySchema,{id:'9007199254740994',name:'renamed-source',fullName:'team/renamed-source',defaultBranch:'main',private:true});
const diff='diff --git a/src/example.ts b/src/example.ts\n--- a/src/example.ts\n+++ b/src/example.ts\n@@ -1 +1 @@\n-old\n+const PRIVATE_COMPARE = "<script>window.executed=true</script>";\n';
async function backend(page:Page) {
 const state={signedIn:true,sourceDenied:false,compareCode:'' as 'not_found'|'failed_precondition'|'',mismatch:false,empty:false,mode:'success',created:[] as CreatePullRequestRequest[],compared:[] as RepositoryComparisonSelection[],lookups:0,branches:[] as string[],wait:undefined as Promise<void>|undefined};
 function outcome(value:CreatePullRequestRequest) {
  const pull={id:'9007199254740995',number:24,title:state.mode==='wrong-result'?'Wrong':value.title,body:value.body,state:v.IssueState.OPEN,draft:value.draft,user,revision:'d'.repeat(64),createdAt:'2026-10-03T12:00:00Z',base:{repositoryId:repository.id,ref:value.baseBranch,commitId:value.baseCommitId},head:{repositoryId:value.sourceRepositoryId,ref:value.headBranch,commitId:value.headCommitId}};
  const mutation={idempotencyKey:value.idempotencyKey,repository:value.repository,repositoryId:repository.id,kind:state.mode==='wrong-kind'?v.IssueMutationKind.CREATE_ISSUE:v.IssueMutationKind.CREATE_PULL,state:state.mode==='rejected'?v.IssueMutationState.REJECTED:v.IssueMutationState.SUCCEEDED,pullRequestId:pull.id,number:24,observedResultId:pull.id,observedNumber:24,failureCode:state.mode==='rejected'?'target_changed':''};
  return {mutation,pullRequest:state.mode==='missing-result'||state.mode==='rejected'?undefined:state.mode==='wrong-result'?{...pull,id:'999'}:pull};
 }
 await page.route('**/rpc/**',async route=>{
  const method=new URL(route.request().url()).pathname.split('/').at(-1)!;
  if(method==='GetSession')return state.signedIn?respond(route,v.GetSessionResponseSchema,{user}):reject(route,'unauthenticated','Sign in');
  if(method==='GetAuthenticationOptions')return respond(route,v.GetAuthenticationOptionsResponseSchema,{});
  if(method==='Logout'){state.signedIn=false;return respond(route,v.LogoutResponseSchema,{})}
  if(method==='WatchRepository')return reject(route,'unimplemented','Fixture has no stream');
  if(!state.signedIn)return reject(route,'unauthenticated','Session expired');
  if(method==='GetRepository'){
   const input=request(route,v.GetRepositoryRequestSchema);const source=input.repository?.owner==='team';
   if(source&&state.sourceDenied)return reject(route,'not_found','Source access revoked');
   return respond(route,v.GetRepositoryResponseSchema,{repository:source?fork:repository});
  }
  if(method==='ListRepositories')return respond(route,v.ListRepositoriesResponseSchema,{repositories:[repository]});
  if(method==='ListCapabilities')return respond(route,v.ListCapabilitiesResponseSchema,{});
  if(method==='ListBranches'){
   const input=request(route,v.ListBranchesRequestSchema);const key=input.repository!.owner+'/'+input.repository!.name;state.branches.push(key);
   if(key.startsWith('team/')&&state.sourceDenied)return reject(route,'not_found','Source access revoked');
   const second=input.page?.page===2;return respond(route,v.ListBranchesResponseSchema,{branches:second?[{name:'feature/slash',commitId:head}]:[{name:'main',commitId:base},{name:'feature',commitId:head}],page:second?undefined:{nextPage:2}});
  }
  if(method==='GetRepositoryComparison'){
   const input=request(route,v.GetRepositoryComparisonRequestSchema);state.compared.push(input.selection!);if(state.wait)await state.wait;
   if(state.compareCode)return reject(route,state.compareCode,'Comparison no longer available');
   return respond(route,v.GetRepositoryComparisonResponseSchema,{selection:{...input.selection!,headCommitId:state.mismatch?'c'.repeat(40):input.selection!.headCommitId},commits:state.empty?[]:[{sha:head,message:'Add useful feature',authorName:'Alex',authoredAt:'2026-10-03T12:00:00Z'}],rawDiff:state.empty?'':diff,byteSize:state.empty?0:new TextEncoder().encode(diff).byteLength});
  }
  if(method==='CreatePullRequest'){
   const input=request(route,v.CreatePullRequestRequestSchema);state.created.push(input);if(state.wait)await state.wait;
   if(state.mode==='drop')return reject(route,'unavailable','Acknowledgment lost');
   return respond(route,v.CreatePullRequestResponseSchema,outcome(input));
  }
  if(method==='GetIssueMutation'){state.lookups++;const input=request(route,v.GetIssueMutationRequestSchema);expect(input.idempotencyKey).toBe(state.created[0]!.idempotencyKey);return respond(route,v.GetIssueMutationResponseSchema,outcome(state.created[0]!));}
  if(method==='GetPullRequest')return respond(route,v.GetPullRequestResponseSchema,{pullRequest:outcome(state.created[0]!).pullRequest});
  if(method==='ListPullRequests')return respond(route,v.ListPullRequestsResponseSchema,{});
  if(method==='ListPullRequestReviews')return respond(route,v.ListPullRequestReviewsResponseSchema,{});
  if(method==='GetPullRequestDiscussion')return reject(route,'not_found','No discussion fixture');
  if(method==='ListReviewerRuns')return respond(route,v.ListReviewerRunsResponseSchema,{});
  return reject(route,'unimplemented','Fixture method absent');
 });return state;
}
async function compare(page:Page,url='/alex/design-system/compare?head=feature') {await page.goto(url);await page.getByRole('button',{name:'Compare',exact:true}).click();await expect(page.getByRole('region',{name:'Changed files'})).toBeVisible();}
test('canonical compare renders pinned commit/file views and opens explicit ready/draft PR editor',async({page})=>{
 const state=await backend(page);await compare(page);expect(state.compared[0]).toMatchObject({repositoryId:repository.id,sourceRepositoryId:repository.id,baseBranch:'main',headBranch:'feature',baseCommitId:base,headCommitId:head});
 await expect(page.getByLabel('Pull request title')).toHaveCount(0);await expect(page.locator('.diff-code').filter({hasText:'PRIVATE_COMPARE'})).toBeVisible();expect(await page.evaluate(()=>(window as unknown as {executed?:boolean}).executed)).toBeUndefined();
 await page.getByRole('button',{name:'Commits',exact:true}).click();await expect(page.getByRole('link',{name:'Add useful feature',exact:true})).toHaveAttribute('href',/commit\/bbbb/);
 await page.getByRole('button',{name:'Open pull request',exact:true}).click();await expect(page.getByLabel('Pull request title')).toHaveValue('Add useful feature');await page.getByLabel('Description, Markdown').fill('## Safe **Markdown**');await page.getByRole('button',{name:'Preview Markdown'}).click();await expect(page.getByRole('heading',{name:'Safe Markdown'})).toBeVisible();await page.getByLabel('Pull request readiness').selectOption('draft');await page.getByRole('button',{name:'Create draft pull request',exact:true}).click();await expect(page).toHaveURL(/\/alex\/design-system\/pull\/24/);
 expect(state.created).toHaveLength(1);expect(state.created[0]).toMatchObject({title:'Add useful feature',body:'## Safe **Markdown**',draft:true,baseCommitId:base,headCommitId:head});
});
test('renamed fork and paged slash branch selection preserve exact IDs and source commit links',async({page})=>{
 const state=await backend(page);await page.goto('/alex/design-system/compare');await page.getByLabel('Choose source repository').click();await page.getByLabel('Source repository',{exact:true}).fill('team/renamed-source');await page.getByRole('button',{name:'Choose repository',exact:true}).click();await page.getByLabel('Compare branch',{exact:true}).click();await page.getByRole('button',{name:'Load more branches',exact:true}).click();await page.getByLabel('Search loaded compare branches').fill('slash');await page.getByRole('button',{name:/feature\/slash Listed at/}).click();await page.getByRole('button',{name:'Compare',exact:true}).click();await expect(page.getByRole('region',{name:'Changed files'})).toBeVisible();expect(state.compared[0]).toMatchObject({sourceRepository:{owner:'team',name:'renamed-source'},sourceRepositoryId:fork.id,headBranch:'feature/slash'});await page.getByRole('button',{name:'Commits',exact:true}).click();await expect(page.getByRole('link',{name:'Add useful feature',exact:true})).toHaveAttribute('href',/\/team\/renamed-source\/commit\/bbbb/);expect(state.branches).toContain('team/renamed-source');
});
test('empty comparison disables PR creation and same-repository swap keeps branch names',async({page})=>{
 const state=await backend(page);state.empty=true;await compare(page);await expect(page.getByRole('button',{name:'Open pull request',exact:true})).toBeDisabled();await expect(page.getByText('There are no changes in this comparison.')).toBeVisible();await page.getByLabel('Swap base and compare branches').click();await expect(page).toHaveURL(/base=feature/);await expect(page.getByLabel('Base branch',{exact:true})).toContainText('feature');
});
for(const failure of ['failed_precondition','not_found','mismatch'] as const)test('comparison '+failure+' withholds private preview',async({page})=>{
 const state=await backend(page);if(failure==='mismatch')state.mismatch=true;else state.compareCode=failure;await page.goto('/alex/design-system/compare?head=feature');await page.getByRole('button',{name:'Compare',exact:true}).click();await expect(page.getByRole('alert')).toBeVisible();await expect(page.getByText('PRIVATE_COMPARE',{exact:false})).toHaveCount(0);await expect(page.getByRole('button',{name:'Open pull request',exact:true})).toHaveCount(0);
});
for(const mode of ['drop','wrong-kind','wrong-result','missing-result','rejected'])test('creation '+mode+' retains metadata and never silently resends',async({page})=>{
 const state=await backend(page);state.mode=mode;await compare(page);await page.getByRole('button',{name:'Open pull request',exact:true}).click();await page.getByLabel('Description, Markdown').fill('PRIVATE_DRAFT_SENT_ONCE');await page.getByRole('button',{name:'Create pull request',exact:true}).click();await expect(page.getByRole('button',{name:'Check request status',exact:true})).toBeVisible();expect(state.created).toHaveLength(1);
 const stored=await page.evaluate(()=>JSON.stringify({...sessionStorage}));expect(stored).not.toContain('PRIVATE_DRAFT');expect(stored).not.toContain('feature');expect(stored).not.toContain(head);
 await page.reload();await expect(page.getByRole('button',{name:'Check request status',exact:true})).toBeVisible();await expect(page.getByLabel('Pull request title')).toHaveValue('');expect(state.created).toHaveLength(1);
 state.mode='success';await page.getByRole('button',{name:'Check request status',exact:true}).click();await expect(page).toHaveURL(/\/pull\/24/);expect(state.lookups).toBe(1);expect(state.created).toHaveLength(1);
});
test('double submission is latched and branch selectors cannot discard the open draft',async({page})=>{
 const state=await backend(page);await compare(page);await page.getByRole('button',{name:'Open pull request',exact:true}).click();await expect(page.getByLabel('Base branch',{exact:true})).toHaveAttribute('aria-disabled','true');let release!:()=>void;state.wait=new Promise<void>(resolve=>{release=resolve});await page.getByRole('button',{name:'Create pull request',exact:true}).dblclick();await expect.poll(()=>state.created.length).toBe(1);release();await expect(page).toHaveURL(/\/pull\/24/);
});
test('both themes and mobile branch/source menus retain bounds, keyboard dismissal and clean editor layout',async({page})=>{
 await backend(page);await page.goto('/alex/design-system/compare?head=feature');for(const theme of ['dark','light'])for(const width of [320,390]){
  await page.evaluate(value=>document.documentElement.dataset.theme=value,theme);await page.setViewportSize({width,height:844});
  for(const label of ['Base branch','Compare branch','Choose source repository']){const trigger=page.getByLabel(label,{exact:true});await trigger.click();const popup=trigger.locator('..').locator('.branch-options');await expect(popup).toBeVisible();await expect.poll(async()=>{const box=await popup.boundingBox();return Boolean(box&&box.y>=0&&box.y+box.height<=844);}).toBe(true);expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);await trigger.press('Escape');await expect(trigger).toBeFocused();}
 }
 await page.getByRole('button',{name:'Compare',exact:true}).click();await page.getByRole('button',{name:'Open pull request',exact:true}).click();await expect(page.getByLabel('Pull request title')).toBeFocused();expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
});

test('compact mobile header retains workspace, account and theme controls with bounded keyboard menus',async({page})=>{
 await backend(page);await page.goto('/alex/design-system/compare?head=feature');
 for(const width of [320,390]){
  await page.setViewportSize({width,height:844});
  await expect(page.getByLabel('Switch workspace',{exact:true})).toBeVisible();
  await expect(page.getByLabel('Your account',{exact:true})).toBeVisible();
  const height=await page.locator('.topbar').evaluate(e=>e.getBoundingClientRect().height);expect(height).toBeLessThan(80);
  await page.getByLabel('Switch workspace',{exact:true}).focus();await page.keyboard.press('Enter');
  const menu=page.getByRole('navigation',{name:'Choose workspace',exact:true});await expect(menu.getByRole('link',{name:'Browse organizations',exact:true})).toBeVisible();await expect(menu.getByRole('link',{name:/Personal workspace/})).toHaveAttribute('href','/');
  const bounds=await menu.boundingBox();expect(bounds!.x).toBeGreaterThanOrEqual(0);expect(bounds!.x+bounds!.width).toBeLessThanOrEqual(width);
  await page.keyboard.press('Escape');await expect(page.getByLabel('Switch workspace',{exact:true})).toBeFocused();await expect(menu).toHaveCount(0);
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
 }
});
