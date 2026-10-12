import { expect, test, type Page } from '@playwright/test';
import { portableRuntimeFixture } from './runtime-fixture';
import { respond, reject, request, resolveSourceFixture } from './rpc';
import { GetAuthenticationOptionsResponseSchema, GetSessionResponseSchema, ListCapabilitiesResponseSchema, GetRepositoryResponseSchema, ListBranchesResponseSchema, GetContentsRequestSchema, GetContentsResponseSchema, GetRepositoryAccessResponseSchema, GetRepositoryFileIndexRequestSchema, GetRepositoryFileIndexResponseSchema, SourceEntryType } from '../src/gen/golf/v1/golf_pb';
const commit='a'.repeat(40);
async function fixture(page:Page,profile='docker') {
 const state={indexes:0,denied:false,wrong:false,malformed:false,oversized:false};
 await page.route('**/rpc/**',async route=>{
  const method=new URL(route.request().url()).pathname.split('/').at(-1);
  if(method==='GetSession')return respond(route,GetSessionResponseSchema,{user:{id:'1',login:'alice'}});
  if(method==='GetAuthenticationOptions')return respond(route,GetAuthenticationOptionsResponseSchema,{});
  if(method==='ListCapabilities')return respond(route,ListCapabilitiesResponseSchema,{...portableRuntimeFixture,runtimeProfile:profile});
  if(method==='GetRepository')return respond(route,GetRepositoryResponseSchema,{repository:{id:'2',name:'demo',fullName:'alice/demo',defaultBranch:'main',cloneUrl:'https://git.example/alice/demo.git',private:true}});
  if(method==='GetRepositoryAccess')return respond(route,GetRepositoryAccessResponseSchema,{access:{repositoryId:'2'}});
  if(method==='ListBranches')return respond(route,ListBranchesResponseSchema,{branches:[{name:'main',commitId:commit}]});
  if(method==='ResolveRepositorySource')return resolveSourceFixture(route,'2',{owner:'alice',name:'demo'},'main',{main:commit});
  if(method==='GetRepositoryFileIndex'){
   state.indexes++;const input=request(route,GetRepositoryFileIndexRequestSchema);expect(input.repositoryId).toBe('2');expect(input.commitId).toBe(commit);
   if(state.denied)return reject(route,'permission_denied','Repository access removed.');
   if(state.oversized)return reject(route,'resource_exhausted','File finder limit reached. Browse folders for this snapshot.');
   return respond(route,GetRepositoryFileIndexResponseSchema,{repositoryId:'2',commitId:state.wrong?'b'.repeat(40):commit,paths:state.malformed?['../hidden']:['README.md','src/deep/雪 <literal>.ts','src/index.ts']});
  }
  if(method==='GetContents'){
   const input=request(route,GetContentsRequestSchema),file=!!input.path&&!['src','src/deep'].includes(input.path);
   return respond(route,GetContentsResponseSchema,{repositoryId:'2',commitId:commit,path:input.path,kind:file?SourceEntryType.FILE:SourceEntryType.DIRECTORY,entries:[],file:file?{entry:{name:input.path.split('/').at(-1),path:input.path,type:SourceEntryType.FILE,sha:commit,size:8n},content:'contents'}:undefined});
  }
  return reject(route,'unimplemented','Fixture unavailable.');
 });return state;
}
for(const profile of ['local','docker','kubernetes','cloudflare-native'])for(const width of [390,1440])test(`file finder uses exact deep links and keyboard navigation ${profile} ${width}`,async({page})=>{
 await page.setViewportSize({width,height:900});const state=await fixture(page,profile);await page.goto('/alice/demo');
 const trigger=page.getByRole('button',{name:'Go to file t',exact:true});await expect(trigger).toBeVisible();expect(state.indexes).toBe(0);
 await page.evaluate(()=>{(window as Window & {documentMarker?:string}).documentMarker='same-document'});
 await trigger.focus();await page.keyboard.press('t');
 const dialog=page.getByRole('dialog',{name:'Go to file'}),input=dialog.getByRole('searchbox');await expect(input).toBeFocused();await input.fill('deep literal');
 const link=dialog.getByRole('link',{name:'src/deep/雪 <literal>.ts',exact:true});await expect(link).toBeVisible();expect(decodeURIComponent((await link.getAttribute('href'))!)).toContain(`/blob/${commit}/src/deep/雪 <literal>.ts`);
 await input.press('Enter');await expect(dialog).toHaveCount(0);await expect(page.getByLabel('Plain text preview of 雪 <literal>.ts')).toContainText('contents');
 expect(await page.evaluate(()=>(window as Window & {documentMarker?:string}).documentMarker)).toBe('same-document');
 expect(await page.evaluate(()=>JSON.stringify({...localStorage,...sessionStorage}))).not.toContain('src/deep');
 await expect(page.locator('body')).toHaveJSProperty('scrollWidth',width);
});
for(const bad of ['wrong','malformed','oversized','denied'] as const)test(`file finder withholds inventory when ${bad}`,async({page})=>{
 const state=await fixture(page);state[bad]=true;await page.goto('/alice/demo');await page.getByRole('button',{name:'Go to file t',exact:true}).click();
 const dialog=page.getByRole('dialog',{name:'Go to file'});await expect(dialog.getByRole('alert')).toBeVisible();await expect(dialog.getByRole('link')).toHaveCount(0);
 await page.keyboard.press('Escape');await expect(dialog).toHaveCount(0);
});
test('finder does not capture typing, rechecks access after close, and restores focus',async({page})=>{
 const state=await fixture(page);await page.goto('/alice/demo');const button=page.getByRole('button',{name:'Go to file t',exact:true});await button.click();
 const dialog=page.getByRole('dialog',{name:'Go to file'});await dialog.getByRole('searchbox').fill('t');await expect(dialog.getByRole('searchbox')).toHaveValue('t');await expect(dialog.getByRole('status')).toContainText('in this snapshot');const initialReads=state.indexes;
 await dialog.getByRole('button',{name:'Close details'}).click();await expect(button).toBeFocused();state.denied=true;await button.click();await expect(dialog.getByRole('alert')).toContainText('access removed');await expect(dialog.getByRole('link')).toHaveCount(0);expect(state.indexes).toBeGreaterThan(initialReads);
});
test('native clone menu links to repository credentials instead of account SSH',async({page})=>{
 await fixture(page,'cloudflare-native');await page.goto('/alice/demo');await page.locator('summary').filter({hasText:'Code'}).click();
 await expect(page.getByRole('link',{name:'Manage repository Git credentials'})).toHaveAttribute('href','/alice/demo/settings/git');await expect(page.getByRole('link',{name:'Manage SSH keys'})).toHaveCount(0);
});
