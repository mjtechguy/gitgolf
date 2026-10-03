import {expect, test} from '@playwright/test';
import type {Page} from '@playwright/test';
import {create} from '@bufbuild/protobuf';
import {CreateIssueRequestSchema, CreateIssueResponseSchema, GetAuthenticationOptionsResponseSchema, GetIssueMutationRequestSchema, GetIssueMutationResponseSchema, GetIssueResponseSchema, GetRepositoryResponseSchema, GetSessionResponseSchema, IssueMutationKind, IssueMutationSchema, IssueMutationState, IssueSchema, IssueState, ListCapabilitiesResponseSchema, ListIssueCommentsResponseSchema, ListIssuesResponseSchema, ListRepositoriesResponseSchema, RepositorySchema, UserSchema} from '../src/gen/golf/v1/golf_pb';
import type {CreateIssueRequest} from '../src/gen/golf/v1/golf_pb';
import {reject, request, respond} from './rpc';

const user = create(UserSchema, {id:'9007199254740993', login:'alex'});
const repository = create(RepositorySchema, {id:'9007199254740995', name:'project', fullName:'alex/project', private:true, empty:true});
const issue = create(IssueSchema, {id:'9007199254740997', number:12, title:'Created issue', state:IssueState.OPEN, user, revision:'a'.repeat(64)});
const newURL='/alex/project/issues/new';
async function backend(page:Page) {
  const state={creates:[] as CreateIssueRequest[], inspections:[] as string[], unknown:false, denied:false};
  let mutation:ReturnType<typeof create<typeof IssueMutationSchema>>|undefined;
  await page.route('**/rpc/**', async route=>{
    const method=new URL(route.request().url()).pathname.split('/').at(-1);
    if(method==='GetAuthenticationOptions')return respond(route,GetAuthenticationOptionsResponseSchema,{});
    if(method==='GetSession')return respond(route,GetSessionResponseSchema,{user});
    if(method==='ListCapabilities')return respond(route,ListCapabilitiesResponseSchema,{});
    if(method==='ListRepositories')return respond(route,ListRepositoriesResponseSchema,{repositories:[repository]});
    if(method==='GetRepository')return state.denied?reject(route,'permission_denied','Repository access revoked.'):respond(route,GetRepositoryResponseSchema,{repository});
    if(method==='ListIssues')return respond(route,ListIssuesResponseSchema,{issues:[issue]});
    if(method==='GetIssue')return respond(route,GetIssueResponseSchema,{issue});
    if(method==='ListIssueComments')return respond(route,ListIssueCommentsResponseSchema,{});
    if(method==='CreateIssue'){
      const input=request(route,CreateIssueRequestSchema);state.creates.push(input);
      mutation=create(IssueMutationSchema,{id:'9007199254740999',idempotencyKey:input.idempotencyKey,repository:input.repository,repositoryId:input.repositoryId,issueId:issue.id,number:issue.number,kind:IssueMutationKind.CREATE_ISSUE,state:state.unknown?IssueMutationState.OUTCOME_UNKNOWN:IssueMutationState.SUCCEEDED});
      return respond(route,CreateIssueResponseSchema,{mutation,issue:state.unknown?undefined:issue});
    }
    if(method==='GetIssueMutation'){
      state.inspections.push(request(route,GetIssueMutationRequestSchema).idempotencyKey);
      return respond(route,GetIssueMutationResponseSchema,{mutation,issue:mutation?.state===IssueMutationState.SUCCEEDED?issue:undefined});
    }
    return reject(route,'unimplemented','This fixture does not provide that capability.');
  });
  return state;
}

test('explicit New action opens a deep-linkable page and dirty navigation requires discard confirmation',async({page})=>{
  const state=await backend(page);
  await page.goto('/alex/project/issues');
  await expect(page.getByLabel('Issue title')).toHaveCount(0);
  await page.getByRole('button',{name:'New issue',exact:true}).click();
  await expect(page).toHaveURL(new RegExp(newURL+'$'));
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByLabel('Issue title')).toBeFocused();
  await page.getByLabel('Issue title').fill('PRIVATE unsent draft');
  page.once('dialog',dialog=>{expect(dialog.message()).toBe('Discard this unsent issue draft?');void dialog.dismiss();});
  await page.getByRole('button',{name:'Cancel',exact:true}).click();
  await expect(page).toHaveURL(new RegExp(newURL+'$'));
  await expect(page.getByLabel('Issue title')).toHaveValue('PRIVATE unsent draft');
  page.once('dialog',dialog=>void dialog.accept());
  await page.getByRole('navigation',{name:'Repository',exact:true}).getByRole('link',{name:'Code',exact:true}).click();
  await expect(page.getByLabel('Issue title')).toHaveCount(0);
  await page.goto(newURL);
  await expect(page.getByLabel('Issue title')).toHaveValue('');
  expect(state.creates).toEqual([]);
  expect(await page.evaluate(()=>JSON.stringify({...sessionStorage,...localStorage}))).not.toContain('PRIVATE');
});

test('unknown creation reloads directly into lookup-only mode and current access denial hides the editor',async({page})=>{
  const state=await backend(page);state.unknown=true;
  await page.goto(newURL);
  await page.getByLabel('Issue title').fill('PRIVATE frozen title');
  await page.getByLabel('Description, plain text').fill('PRIVATE frozen body');
  await page.getByRole('button',{name:'Create issue',exact:true}).click();
  await expect(page.getByRole('button',{name:'Check request status'})).toBeEnabled();
  await expect(page.getByLabel('Issue title')).toBeDisabled();
  await page.reload();
  await expect(page.getByLabel('Issue title')).toHaveValue('');
  await expect(page.getByText('Draft text was not stored. This resumed request supports status checks only.')).toBeVisible();
  expect(state.creates).toHaveLength(1);expect(state.inspections).toEqual([]);
  await page.getByRole('button',{name:'Check request status'}).click();
  await expect.poll(()=>state.inspections.length).toBe(1);
  expect(state.inspections[0]).toBe(state.creates[0]!.idempotencyKey);
  state.denied=true;
  await page.reload();
  await expect(page.getByText('Repository access revoked.',{exact:true})).toBeVisible();
  await expect(page.getByLabel('Issue title')).toHaveCount(0);
  expect(state.creates).toHaveLength(1);
});

for(const theme of ['dark','light'])for(const width of [1280,390])test(`create page is compact, keyboard usable, and safely previews Markdown at ${width}px in ${theme}`,async({page})=>{
  await backend(page);
  await page.addInitScript(theme=>localStorage.setItem('golf.theme',theme),theme);
  await page.setViewportSize({width,height:900});
  await page.goto(newURL);
  await expect(page.getByRole('region',{name:'New issue',exact:true})).toBeVisible();
  await expect(page.getByRole('navigation',{name:'Breadcrumb'})).toContainText('New issue');
  await expect(page.locator('html')).toHaveAttribute('data-theme',theme);
  await page.getByLabel('Issue title').focus();await page.keyboard.press('Tab');
  await expect(page.getByRole('button',{name:'Write',exact:true})).toBeFocused();
  await page.keyboard.press('Tab');await expect(page.getByRole('button',{name:'Preview Markdown',exact:true})).toBeFocused();
  await page.keyboard.press('Tab');await expect(page.getByLabel('Description, plain text')).toBeFocused();
  await page.getByLabel('Description, plain text').fill('## Useful detail\n\n- Reproduce it\n\n<script>window.executed=true</script>\n[unsafe](javascript:alert(1))');
  await page.getByRole('button',{name:'Preview Markdown',exact:true}).click();
  await expect(page.getByLabel('Description, plain text')).toBeHidden();
  await expect(page.getByLabel('Draft Markdown preview')).toContainText('Useful detail');
  await expect(page.getByLabel('Draft Markdown preview').locator('script,a[href^="javascript:"]')).toHaveCount(0);
  expect(await page.evaluate(()=> 'executed' in window)).toBe(false);
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  const headingHeight=await page.locator('.issue-create-page>.discussion-summary').evaluate(element=>element.getBoundingClientRect().height);
  expect(headingHeight).toBeLessThan(width===390?190:150);
  await page.screenshot({path:`test-results/issue-create-${theme}-${width}.png`,fullPage:true});
});
