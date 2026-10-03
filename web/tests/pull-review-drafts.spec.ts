import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { create, clone } from '@bufbuild/protobuf';
import { createHash } from 'node:crypto';
import { UserSchema, RepositorySchema, PullRequestSchema, GetSessionResponseSchema, GetAuthenticationOptionsResponseSchema, ListRepositoriesResponseSchema, GetRepositoryResponseSchema, GetPullRequestResponseSchema, GetPullRequestDiffResponseSchema, LogoutResponseSchema, GetPullRequestReviewDraftResponseSchema, SavePullRequestReviewDraftRequestSchema, SavePullRequestReviewDraftResponseSchema, DeletePullRequestReviewDraftRequestSchema, DeletePullRequestReviewDraftResponseSchema, PullReviewDraftSchema, PullReviewDraftReceiptSchema, PullReviewDraftOperationKind, IssueState } from '../src/gen/golf/v1/golf_pb';
import type { SavePullRequestReviewDraftRequest, DeletePullRequestReviewDraftRequest, PullReviewDraft, PullReviewDraftReceipt } from '../src/gen/golf/v1/golf_pb';
import { respond, reject, request } from './rpc';
const base='a'.repeat(40),head='b'.repeat(40),merge='c'.repeat(40);
const path='src/日本語 [view].ts';
const diff=`diff --git a/README.md b/README.md\n--- a/README.md\n+++ b/README.md\n@@ -1 +1 @@\n-old readme\n+new readme\ndiff --git "a/${path}" "b/${path}"\n--- "a/${path}"\n+++ "b/${path}"\n@@ -1,2 +1,2 @@\n-old\n+new\n keep\n@@ -10 +10 @@\n-oldSecond\n+newSecond\n`;
const user=create(UserSchema,{id:'9007199254740993',login:'reader'});
const repo=create(RepositorySchema,{id:'9007199254740994',name:'sample',fullName:'owner/sample',private:true,defaultBranch:'main'});
const originalPull=create(PullRequestSchema,{id:'9007199254740995',number:3,title:'Private draft workspace',body:'PRIVATE pull body',revision:'d'.repeat(64),mergeBaseCommitId:merge,state:IssueState.OPEN,user:{id:'9',login:'owner'},base:{repositoryId:repo.id,ref:'main',commitId:base},head:{repositoryId:repo.id,ref:'feature',commitId:head}});
const comparisonId='11111111-1111-4111-8111-111111111111';
async function backend(page:Page){
 const state={signedIn:true,user:clone(UserSchema,user),pull:clone(PullRequestSchema,originalPull),text:diff,draft:null as PullReviewDraft|null,deleted:false,version:'0',generation:'0',receipts:new Map<string,PullReviewDraftReceipt>(),saves:[] as SavePullRequestReviewDraftRequest[],deletes:[] as DeletePullRequestReviewDraftRequest[],reads:[] as Record<string,unknown>[],lostSave:false,lostDelete:false,conflict:false,deny:false,expired:false,wrong:'',hold:undefined as Promise<void>|undefined,saveHold:undefined as Promise<void>|undefined};
 await page.route('**/rpc/**',async route=>{
  const method=new URL(route.request().url()).pathname.split('/').at(-1)!;
  if(method==='GetSession')return state.signedIn?respond(route,GetSessionResponseSchema,{user:state.user}):reject(route,'unauthenticated','Sign in required.');
  if(method==='GetAuthenticationOptions')return respond(route,GetAuthenticationOptionsResponseSchema,{localPasswordEnabled:true});
  if(method==='Logout'){state.signedIn=false;return respond(route,LogoutResponseSchema,{});}
  if(method==='ListRepositories')return respond(route,ListRepositoriesResponseSchema,{repositories:[repo]});
  if(method==='GetRepository')return respond(route,GetRepositoryResponseSchema,{repository:repo});
  if(method==='GetPullRequest')return state.deny?reject(route,'permission_denied','Private target access revoked.'):respond(route,GetPullRequestResponseSchema,{pullRequest:state.pull});
  if(method==='GetPullRequestDiff')return respond(route,GetPullRequestDiffResponseSchema,{repositoryId:repo.id,pullRequestId:state.pull.id,baseCommitId:state.pull.base!.commitId,headCommitId:state.pull.head!.commitId,mergeBaseCommitId:state.pull.mergeBaseCommitId,rawDiff:state.text,byteSize:Buffer.byteLength(state.text)});
  if(method==='GetPullRequestReviewDraft'){
   const input=route.request().postDataJSON() as Record<string,unknown>;state.reads.push(input);if(state.hold)await state.hold;
   if(state.expired){state.signedIn=false;return reject(route,'unauthenticated','Session expired.');}
   if(state.deny)return reject(route,'permission_denied','Private draft access revoked.');
   const receipt=state.receipts.get(String(input.operationId||''));if(input.operationId&&!receipt||input.draftId&&!state.draft)return reject(route,'not_found','Requested private draft operation not found.');return respond(route,GetPullRequestReviewDraftResponseSchema,{draft:state.deleted?undefined:state.draft||undefined,currentVersion:state.version,targetGeneration:state.generation,deleted:state.deleted,receipt});
  }
  if(method==='SavePullRequestReviewDraft'){
   const input=request(route,SavePullRequestReviewDraftRequestSchema);state.saves.push(input);if(state.saveHold)await state.saveHold;
   if(state.conflict)return route.fulfill({status:409,contentType:'application/json',headers:{'Golf-Draft-Effect':'none'},json:{code:'aborted',message:'Another device changed this private draft. Reload before saving.'}});
   if(state.deny)return reject(route,'permission_denied','Draft permission revoked.');
   const version=String(BigInt(input.expectedVersion)+1n),generation=String(BigInt(input.expectedTargetGeneration)+1n);
   const capture=input.comparison.case==='capture'?input.comparison.value:state.draft!.comparison!.capture!;
   state.draft=create(PullReviewDraftSchema,{id:input.draftId,target:input.target,userId:state.user.id,version,comparison:{id:comparisonId,capture,rawDiff:input.comparison.case==='capture'?state.text:state.draft!.comparison!.rawDiff,byteSize:input.comparison.case==='capture'?Buffer.byteLength(state.text):state.draft!.comparison!.byteSize,parserVersion:'golf-review-diff-v1'},summary:input.summary,entries:input.entries,createdAt:'2026-10-03T12:00:00Z',updatedAt:'2026-10-03T12:00:00Z'});state.deleted=false;state.version=version;state.generation=generation;
   const receipt=create(PullReviewDraftReceiptSchema,{operationId:input.operationId,draftId:input.draftId,target:input.target,kind:PullReviewDraftOperationKind.SAVE,expectedVersion:input.expectedVersion,acceptedVersion:version,comparisonId,expectedTargetGeneration:input.expectedTargetGeneration,acceptedTargetGeneration:generation});state.receipts.set(input.operationId,receipt);
   if(state.lostSave)return reject(route,'unavailable','Save acknowledgement lost.');
   const shown=clone(PullReviewDraftSchema,state.draft),shownReceipt=clone(PullReviewDraftReceiptSchema,receipt);
   if(state.wrong==='owner')shown.userId='99';if(state.wrong==='target')shown.target!.pullRequestId='99';if(state.wrong==='version')shown.version='01';if(state.wrong==='generation')shownReceipt.acceptedTargetGeneration='02';if(state.wrong==='receipt')shownReceipt.operationId='22222222-2222-4222-8222-222222222222';if(state.wrong==='hash')shown.comparison!.capture!.diffSha256='f'.repeat(64);if(state.wrong==='content')shown.entries[0]!.body='REPLACED CONTENT';
   return respond(route,SavePullRequestReviewDraftResponseSchema,{draft:shown,receipt:shownReceipt,currentVersion:version,targetGeneration:generation});
  }
  if(method==='DeletePullRequestReviewDraft'){
   const input=request(route,DeletePullRequestReviewDraftRequestSchema);state.deletes.push(input);state.deleted=true;state.version=String(BigInt(input.expectedVersion)+1n);state.generation=String(BigInt(input.expectedTargetGeneration)+1n);const receipt=create(PullReviewDraftReceiptSchema,{operationId:input.operationId,draftId:input.draftId,target:input.target,kind:PullReviewDraftOperationKind.DELETE,expectedVersion:input.expectedVersion,acceptedVersion:state.version,comparisonId,expectedTargetGeneration:input.expectedTargetGeneration,acceptedTargetGeneration:state.generation});state.receipts.set(input.operationId,receipt);if(state.lostDelete)return reject(route,'unavailable','Delete acknowledgement lost.');return respond(route,DeletePullRequestReviewDraftResponseSchema,{receipt,currentVersion:state.version,targetGeneration:state.generation,deleted:true});
  }
  return reject(route,'unimplemented','Unsupported fixture operation.');
 });return state;
}
const scope=(page:Page)=>page.getByRole('region',{name:'Private review draft',exact:true});
async function open(page:Page){await page.goto('/owner/sample/pull/3/files');await page.getByRole('button',{name:'Private draft',exact:true}).click();await expect(scope(page).getByRole('button',{name:`Add private comment on new line 10 in ${path}`,exact:true})).toBeVisible();}
async function add(page:Page,side:'old'|'new'='new',line=10,body='PRIVATE comment **text**'){
 await scope(page).getByRole('button',{name:`Add private comment on ${side} line ${line} in ${path}`,exact:true}).click();await scope(page).getByRole('textbox',{name:`Private comment · ${side} line ${line} · ${path}`,exact:true}).fill(body);await scope(page).getByRole('button',{name:'Keep comment',exact:true}).click();await expect(scope(page).getByRole('article',{name:`Private comment ${side} line ${line} in ${path}`,exact:true})).toContainText('PRIVATE');
}
async function save(page:Page){await scope(page).getByRole('button',{name:'Save private draft',exact:true}).click();await expect(scope(page)).toContainText('Saved privately in Golf. No review was published.');}

test('explicit private controls capture original stable old/new coordinates with no eager mutation',async({page})=>{
 const s=await backend(page);await page.goto('/owner/sample/pull/3/files');expect(s.reads).toHaveLength(0);await expect(page.getByRole('textbox',{name:/Private comment/})).toHaveCount(0);await page.getByRole('button',{name:'Private draft',exact:true}).click();await expect(scope(page).getByRole('button',{name:`Add private comment on old line 10 in ${path}`,exact:true})).toBeVisible();await add(page,'old');await add(page,'new');expect(s.saves).toHaveLength(0);await save(page);expect(s.saves).toHaveLength(1);const sent=s.saves[0]!;expect(sent.target).toMatchObject({repositoryId:repo.id,pullRequestId:originalPull.id,number:3});expect(sent.expectedVersion).toBe('0');expect(sent.expectedTargetGeneration).toBe('0');expect(sent.comparison.case).toBe('capture');if(sent.comparison.case==='capture')expect(sent.comparison.value).toMatchObject({mergeBaseCommitId:merge,diffSha256:createHash('sha256').update(diff).digest('hex'),selection:{baseCommitId:base,headCommitId:head}});expect(sent.entries.map(e=>e.coordinate)).toEqual([expect.objectContaining({fileIndex:1,hunkIndex:1,side:1,line:10,path}),expect.objectContaining({fileIndex:1,hunkIndex:1,side:2,line:10,path})]);expect(s.deletes).toHaveLength(0);expect(await page.evaluate(()=>JSON.stringify({...sessionStorage}))).not.toContain('PRIVATE');
});

test('split syntax and filtered files keep coordinate inventory indices and unsent editor',async({page})=>{
 const s=await backend(page);await open(page);await scope(page).getByRole('button',{name:'Split',exact:true}).click();await scope(page).getByRole('textbox',{name:'Filter changed files',exact:true}).fill('日本語');await scope(page).getByRole('button',{name:`Add private comment on old line 10 in ${path}`,exact:true}).click();const input=scope(page).getByRole('textbox',{name:`Private comment · old line 10 · ${path}`,exact:true});await input.fill('PRIVATE split editor');await scope(page).getByRole('button',{name:'Unified',exact:true}).click();await expect(input).toHaveValue('PRIVATE split editor');await scope(page).getByRole('button',{name:'Keep comment',exact:true}).click();await save(page);expect(s.saves[0]!.entries[0]!.coordinate).toMatchObject({fileIndex:1,hunkIndex:1,line:10,side:1,path});
});

test('lost Save acknowledgement persists metadata only; reload reads receipt without reposting',async({page})=>{
 const s=await backend(page);s.lostSave=true;await open(page);await add(page);await scope(page).getByRole('button',{name:'Save private draft',exact:true}).click();await expect(scope(page).getByRole('alert')).toContainText('acknowledgement lost');const storage=await page.evaluate(()=>JSON.stringify({...sessionStorage}));expect(storage).not.toContain('PRIVATE');expect(storage).not.toContain(path);expect(storage).not.toContain(head);expect(storage).not.toContain(createHash('sha256').update(diff).digest('hex'));expect(storage).toContain(s.saves[0]!.operationId);await page.reload();await page.getByRole('button',{name:'Private draft',exact:true}).click();await expect(scope(page)).toContainText('Saved privately in Golf. No review was published.');expect(s.saves).toHaveLength(1);await expect(scope(page).getByRole('article',{name:`Private comment new line 10 in ${path}`,exact:true})).toContainText('PRIVATE comment');
});

test('CAS conflict preserves text and explicit reopen obtains the current version before new intent',async({page})=>{
 const s=await backend(page);await open(page);await add(page);await save(page);await scope(page).getByRole('button',{name:`Edit private comment new line 10 in ${path}`,exact:true}).click();await scope(page).getByRole('textbox',{name:`Private comment · new line 10 · ${path}`,exact:true}).fill('PRIVATE changed locally');await scope(page).getByRole('button',{name:'Keep comment',exact:true}).click();s.conflict=true;await scope(page).getByRole('button',{name:'Save private draft',exact:true}).click();await expect(scope(page).getByRole('alert')).toContainText('Another device');await expect(scope(page)).toContainText('PRIVATE changed locally');expect(s.saves).toHaveLength(2);page.once('dialog',dialog=>dialog.accept());await scope(page).getByRole('button',{name:'Reopen saved private draft',exact:true}).click();await expect(scope(page)).toContainText('PRIVATE comment');await expect(scope(page)).not.toContainText('PRIVATE changed locally');expect(s.saves).toHaveLength(2);
});

for(const wrong of ['owner','target','version','generation','receipt','hash','content'])test(`mismatched ${wrong} save receipt never replaces private draft state`,async({page})=>{
 const s=await backend(page);s.wrong=wrong;await open(page);await add(page);await scope(page).getByRole('button',{name:'Save private draft',exact:true}).click();await expect(scope(page).getByRole('alert')).toBeVisible();await expect(scope(page)).not.toContainText('Saved privately in Golf. No review was published.');await expect(scope(page)).not.toContainText('REPLACED CONTENT');expect(s.saves).toHaveLength(1);await expect(scope(page).getByRole('button',{name:'Save private draft',exact:true})).toBeDisabled();
});

test('original saved snapshot reopens after push and subsequent edit uses its immutable comparison',async({page})=>{
 const s=await backend(page);await open(page);await add(page);await save(page);s.pull.head!.commitId='e'.repeat(40);s.pull.revision='f'.repeat(64);s.text=diff.replace('newSecond','CURRENT DIFFERENT SOURCE');await page.reload();await page.getByRole('button',{name:'Private draft',exact:true}).click();await expect(scope(page)).toContainText('Earlier snapshot');await expect(scope(page)).toContainText('newSecond');await expect(scope(page)).not.toContainText('CURRENT DIFFERENT SOURCE');await scope(page).getByRole('button',{name:`Edit private comment new line 10 in ${path}`,exact:true}).click();await scope(page).getByRole('textbox',{name:`Private comment · new line 10 · ${path}`,exact:true}).fill('PRIVATE original snapshot edit');await scope(page).getByRole('button',{name:'Keep comment',exact:true}).click();await save(page);expect(s.saves[1]!.comparison).toEqual({case:'comparisonId',value:comparisonId});expect(s.saves[1]!.expectedVersion).toBe('1');
});

test('delete acknowledgement loss reloads metadata tombstone without private source or second delete',async({page})=>{
 const s=await backend(page);await open(page);await add(page);await save(page);s.lostDelete=true;page.once('dialog',dialog=>dialog.accept());await scope(page).getByRole('button',{name:'Delete private draft',exact:true}).click();await expect(scope(page).getByRole('alert')).toContainText('acknowledgement lost');await page.reload();await page.getByRole('button',{name:'Private draft',exact:true}).click();await expect(scope(page)).toContainText('Private draft deleted. No native review was changed.');await expect(scope(page)).not.toContainText('PRIVATE comment');expect(s.deletes).toHaveLength(1);expect(s.saves).toHaveLength(1);expect(s.deletes[0]!.expectedVersion).toBe('1');expect(s.deletes[0]!.expectedTargetGeneration).toBe('1');
});

test('held read hides private content and revocation clears it before late results',async({page})=>{
 const s=await backend(page);await open(page);await add(page);await save(page);let release!:()=>void;s.hold=new Promise(resolve=>release=resolve);await scope(page).getByRole('button',{name:'Reopen saved private draft',exact:true}).click();await expect(scope(page).getByText('PRIVATE comment text',{exact:false})).toBeHidden();s.deny=true;release();await expect(scope(page).getByRole('alert')).toContainText('cleared');await expect(scope(page)).not.toContainText('PRIVATE comment');await expect(scope(page)).not.toContainText('newSecond');
});

test('expired draft read signs out and cancels late private results',async({page})=>{
 const s=await backend(page);await open(page);await add(page);await save(page);s.expired=true;await scope(page).getByRole('button',{name:'Reopen saved private draft',exact:true}).click();await expect(page.getByLabel('Email or username')).toBeVisible();await expect(page.locator('body')).not.toContainText('PRIVATE comment');await expect(scope(page)).toHaveCount(0);
});

for(const theme of ['dark','light'])for(const width of [1280,390,320])test(`private workspace ${theme}/${width} keeps keyboard actions, density and Markdown safe`,async({page})=>{
 await backend(page);await page.setViewportSize({width,height:900});await page.addInitScript(theme=>localStorage.setItem('golf.theme',theme),theme);await open(page);const button=scope(page).getByRole('button',{name:`Add private comment on new line 10 in ${path}`,exact:true});await button.focus();await page.keyboard.press('Enter');await scope(page).getByRole('textbox',{name:`Private comment · new line 10 · ${path}`,exact:true}).fill('PRIVATE <script>window.executed=true</script> **safe**');await scope(page).getByRole('button',{name:'Preview Markdown',exact:true}).click();await expect(scope(page).getByLabel('Private comment preview',{exact:true})).not.toContainText('window.executed=true');expect(await page.evaluate(()=>Boolean((window as unknown as {executed?:boolean}).executed))).toBe(false);await scope(page).getByRole('button',{name:'Keep comment',exact:true}).click();await expect(button).toBeFocused();await save(page);expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);await expect(page.getByRole('dialog')).toHaveCount(0);
});

test('missing receipt after lost save remains status-only across reload without a new operation',async({page})=>{
 const s=await backend(page);s.lostSave=true;await open(page);await add(page);await scope(page).getByRole('button',{name:'Save private draft',exact:true}).click();await expect(scope(page).getByRole('alert')).toBeVisible();s.draft=null;s.version='0';s.generation='0';s.receipts.clear();await page.reload();await page.getByRole('button',{name:'Private draft',exact:true}).click();await expect(scope(page)).toContainText('An absent operation is not proof of no effect');await expect(scope(page).getByRole('button',{name:'Save private draft',exact:true})).toHaveCount(0);await expect(scope(page).getByRole('button',{name:/Add private comment/})).toHaveCount(0);await scope(page).getByRole('button',{name:'Check draft operation status',exact:true}).click();await expect(scope(page)).toContainText('An absent operation is not proof of no effect');expect(s.saves).toHaveLength(1);expect(s.deletes).toHaveLength(0);
});

test('rapid repeated save click freezes one operation before digest or network completes',async({page})=>{
 const s=await backend(page);await open(page);await add(page);let release!:()=>void;s.saveHold=new Promise(resolve=>release=resolve);const button=scope(page).getByRole('button',{name:'Save private draft',exact:true});await button.evaluate(el=>{(el as HTMLButtonElement).click();(el as HTMLButtonElement).click();});await expect.poll(()=>s.saves.length).toBe(1);release();await expect(scope(page)).toContainText('Saved privately in Golf. No review was published.');expect(s.saves).toHaveLength(1);
});

test('dirty confirmation leaves editor intact on cancelled navigation and Escape restores focused Add control',async({page})=>{
 await backend(page);await open(page);const button=scope(page).getByRole('button',{name:`Add private comment on new line 10 in ${path}`,exact:true});await button.click();const editor=scope(page).getByRole('textbox',{name:`Private comment · new line 10 · ${path}`,exact:true});await editor.fill('PRIVATE unsent line');page.once('dialog',dialog=>dialog.dismiss());await page.getByRole('link',{name:'Conversation',exact:true}).click();await expect(editor).toHaveValue('PRIVATE unsent line');expect(page.url()).toContain('/files');page.once('dialog',dialog=>dialog.accept());await editor.focus();await page.keyboard.press('Escape');await expect(editor).toHaveCount(0);await expect(button).toBeFocused();
});

test('native push preserves unsaved original coordinates and blocks first save until explicit current selection',async({page})=>{
 const s=await backend(page);await open(page);await add(page);s.pull.head!.commitId='e'.repeat(40);s.pull.revision='f'.repeat(64);s.text=diff.replace('newSecond','CURRENT source');await page.getByRole('button',{name:'Refresh pull request',exact:true}).click();await expect(scope(page)).toContainText('This first comparison changed');await expect(scope(page)).toContainText('newSecond');await expect(scope(page).getByRole('button',{name:'Save private draft',exact:true})).toBeDisabled();expect(s.saves).toHaveLength(0);page.once('dialog',dialog=>dialog.accept());await scope(page).getByRole('button',{name:'Use current changes',exact:true}).click();await expect(scope(page)).not.toContainText('PRIVATE comment');await expect(scope(page)).toContainText('CURRENT source');await expect(scope(page).getByRole('button',{name:'Save private draft',exact:true})).toBeEnabled();
});

test('sign out cancels held receipt reads and a different owner cannot restore late private content',async({page})=>{
 const errors:string[]=[];page.on('console',message=>{if(message.type()==='error'&&message.text().includes('Cannot update a component'))errors.push(message.text());});
 const s=await backend(page);await open(page);await add(page);await save(page);let release!:()=>void;s.hold=new Promise(resolve=>release=resolve);await scope(page).getByRole('button',{name:'Reopen saved private draft',exact:true}).click();await page.getByLabel('Your account',{exact:true}).click();await page.getByRole('button',{name:'Sign out',exact:true}).click();await expect(page.getByLabel('Email or username')).toBeVisible();release();s.hold=undefined;s.signedIn=true;s.user=create(UserSchema,{id:'5',login:'new-reader'});await page.reload();await page.getByRole('button',{name:'Private draft',exact:true}).click();await expect(scope(page).getByRole('alert')).toContainText('owner');await expect(scope(page)).not.toContainText('PRIVATE comment');expect(s.saves).toHaveLength(1);expect(errors).toEqual([]);
});


const nativeDelimitedDiff=()=>diff.replace(`diff --git "a/${path}" "b/${path}"`,`diff --git a/${path} b/${path}`).replace(`--- "a/${path}"`,`--- a/${path}\t`).replace(`+++ "b/${path}"`,`+++ b/${path}\t`);
test('native empty TAB side delimiters save exact old/new private coordinates and untouched comparison',async({page})=>{
 const s=await backend(page);s.text=nativeDelimitedDiff();await open(page);await add(page,'old');await add(page,'new');expect(s.saves).toHaveLength(0);await save(page);
 expect(s.saves).toHaveLength(1);const sent=s.saves[0]!;expect(sent.entries.map(e=>e.coordinate)).toEqual([expect.objectContaining({fileIndex:1,hunkIndex:1,side:1,line:10,path}),expect.objectContaining({fileIndex:1,hunkIndex:1,side:2,line:10,path})]);
 expect(sent.comparison.case).toBe('capture');if(sent.comparison.case==='capture')expect(sent.comparison.value.diffSha256).toBe(createHash('sha256').update(s.text).digest('hex'));
 expect(s.draft!.comparison!.rawDiff).toBe(s.text);expect(s.deletes).toHaveLength(0);
});
for(const suffix of ['\t\t','\ttimestamp','\tother/path\t'])test(`ambiguous native side suffix ${JSON.stringify(suffix)} offers no private coordinate or eager save`,async({page})=>{
 const s=await backend(page);s.text=nativeDelimitedDiff().replace(`+++ b/${path}\t\n`,`+++ b/${path}${suffix}\n`);await page.goto('/owner/sample/pull/3/files');await page.getByRole('button',{name:'Private draft',exact:true}).click();const malformed=scope(page).locator('.diff-file').nth(1);
 await expect(malformed).toContainText('cannot be mapped safely');await expect(malformed.getByRole('button',{name:/Add private comment/})).toHaveCount(0);await expect(malformed.locator('pre')).toContainText('newSecond');expect(s.saves).toHaveLength(0);expect(s.deletes).toHaveLength(0);
});
