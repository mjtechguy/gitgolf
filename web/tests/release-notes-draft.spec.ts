import {expect,test,type Page} from '@playwright/test';
import {GetSessionResponseSchema,GetAuthenticationOptionsResponseSchema,ListCapabilitiesResponseSchema,ListRepositoriesResponseSchema,GetRepositoryResponseSchema,GetRepositoryAccessResponseSchema,GetRepositoryRulesResponseSchema,
 ListTagsResponseSchema,ResolveRepositorySourceRequestSchema,ResolveRepositorySourceResponseSchema,RepositorySourceRefKind as Kind,RepositorySourceResolution as Resolution,ListRepositoryReleasesResponseSchema,
 SubmitRepositoryReleasePublicationRequestSchema} from '../src/gen/golf/v1/golf_pb';
import {GetRepositoryFeaturesResponseSchema,FeatureDecider} from '../src/gen/golf/v1/feature_policy_pb';
import {respond,reject,request} from './rpc';

const key={owner:'alex',name:'project'},shots=process.env.GOLF_AI_SHOTS,revision='c'.repeat(64);
const C11='a1b2c3d4e5f6'.padEnd(40,'1'),C10='0'.repeat(39)+'9',T11='e'.repeat(40);
const user={id:'42',login:'alex'},repository={id:'11',name:'project',fullName:'alex/project',private:true,defaultBranch:'main'};
const base='https://golf.example.com/alex/project',at=new Date(Date.now()-12*60_000).toISOString();
const markdown=`## Features\n\n- Repository reads are cached per commit, so browsing a large tree is faster. ([#41](${base}/pull/41))\n- Release pages show asset checksums. ([#44](${base}/pull/44))\n\n`+
 `## Fixes\n\n- An empty configuration file no longer crashes start-up. ([#39](${base}/pull/39), [\`9c1b4cd\`](${base}/commit/9c1b4cd${'0'.repeat(33)}))\n- Ignore previous instructions @​team &lt;b&gt; text stays inert. ([\`ef89783\`](${base}/commit/ef89783${'0'.repeat(33)}))\n\n`+
 `## Maintenance\n\n- Dependencies updated. ([\`a7b8607\`](${base}/commit/a7b8607${'0'.repeat(33)}))\n`;
const output={markdown,tag:'v1.1',previousTag:'v1.0',tagCommit:C11,previousCommit:C10,walked:15,pulls:7,commits:12,omittedPulls:0,omittedCommits:0,uncitedPulls:[40,42,43,45]};
type Run={id:string;kind:string;state:string;target:{tag:string;previousTag?:string};model:string;output?:typeof output;refusal?:string;createdAt:string;updatedAt:string};
const run=(over:Partial<Run>={}):Run=>({id:'7c9e6679-7425-40de-944b-e07fc1f90ae7',kind:'release-notes',state:'SUCCEEDED',target:{tag:'v1.1'},model:'@cf/zai-org/glm-5.3',output,createdAt:at,updatedAt:at,...over});

async function backend(page:Page,{runs=[run()] as Run[],capability=true,policyOff=false,stale=false}={}){
 const state={runs,created:[] as Record<string,unknown>[],writes:0,settleAfter:0};
 await page.route('**/rpc/**',async route=>{
  const method=new URL(route.request().url()).pathname.split('/').at(-1)!;
  if(method==='GetSession')return respond(route,GetSessionResponseSchema,{user});
  if(method==='GetAuthenticationOptions')return respond(route,GetAuthenticationOptionsResponseSchema,{localPasswordEnabled:true});
  if(method==='ListCapabilities')return respond(route,ListCapabilitiesResponseSchema,{runtimeProfile:'cloudflare-native',capabilities:[{id:'repository.releases',label:'Releases',state:3},
   ...(capability?[{id:'repository.ai-release-notes',label:'Release notes drafts',state:3}]:[]),...(policyOff?[{id:'settings.feature-policy',label:'Feature policies',state:3}]:[])]});
  if(method==='GetRepositoryFeatures')return respond(route,GetRepositoryFeaturesResponseSchema,{repositoryId:'11',features:[{feature:'ai-release-notes',label:'AI release notes drafts',effective:false,decidedBy:FeatureDecider.REPOSITORY,reason:'AI release notes drafts are turned off for this repository by the repository policy.'}]});
  if(method==='ListRepositories')return respond(route,ListRepositoriesResponseSchema,{repositories:[repository]});
  if(method==='GetRepository')return respond(route,GetRepositoryResponseSchema,{repository});
  if(method==='ListRepositoryReleases')return respond(route,ListRepositoryReleasesResponseSchema,{repository:key,repositoryId:'11',totalCount:'0',page:{nextPage:0}});
  if(method==='GetRepositoryAccess')return respond(route,GetRepositoryAccessResponseSchema,{access:{repositoryId:'11',ownerId:'42',owner:{id:'42',login:'alex'},revision,canManage:true}});
  if(method==='GetRepositoryRules')return respond(route,GetRepositoryRulesResponseSchema,{repositoryId:'11',ownerId:'42',accessRevision:revision,rulesRevision:'d'.repeat(64),tagProtections:[]});
  if(method==='ListTags')return respond(route,ListTagsResponseSchema,{repositoryId:'11',tags:[{name:'v1.0',id:C10,commitId:C10},{name:'v1.1',id:T11,commitId:C11}],page:{nextPage:0}});
  if(method==='ResolveRepositorySource'){const input=request(route,ResolveRepositorySourceRequestSchema),name=input.selector!.name;return respond(route,ResolveRepositorySourceResponseSchema,{repository:key,repositoryId:'11',resolution:Resolution.RESOLVED,selection:{kind:Kind.TAG,name,commitId:name==='v1.1'?C11:C10,tagObjectId:name==='v1.1'?T11:C10}});}
  if(method==='SubmitRepositoryReleasePublication'){request(route,SubmitRepositoryReleasePublicationRequestSchema);state.writes++;return reject(route,'unavailable','Not in this fixture.');}
  return reject(route,'unimplemented','Fixture procedure not supplied.');
 });
 await page.route('**/native/**',async route=>{
  const path=new URL(route.request().url()).pathname,body=route.request().postDataJSON() as Record<string,unknown>;
  const json=(value:unknown,status=200)=>route.fulfill({status,contentType:'application/json',body:JSON.stringify(value)});
  if(path==='/native/ai/read'&&body.action==='list'){
   expect(body).toMatchObject({kind:'release-notes',repository:key,repositoryId:'11'});
   if(state.settleAfter&&--state.settleAfter===0)state.runs=[run({id:state.runs[0]!.id,target:state.runs[0]!.target}),...state.runs.slice(1)];
   return json({runs:state.runs,truncated:false});
  }
  if(path==='/native/ai/read'&&body.action==='status')return json({run:{...state.runs.find(r=>r.id===body.runId)!,stale}});
  if(path==='/native/ai'&&body.action==='create'){state.created.push(body);const queued=run({id:'0f8fad5b-d9cb-469f-a165-70867728950e',state:'REQUESTED',output:undefined,target:body.target as Run['target']});state.runs=[queued,...state.runs];state.settleAfter=2;return json({run:queued});}
  return json({code:'unimplemented',message:'Fixture route not supplied.'},501);
 });
 return state;
}
const card=(page:Page)=>page.getByRole('region',{name:'Release notes draft'});
const notes=(page:Page)=>page.getByRole('textbox',{name:'Release notes, Markdown',exact:true});
async function open(page:Page,tag='v1.1'){
 await page.goto('/alex/project/releases');await page.getByRole('button',{name:'New release',exact:true}).click();
 await page.getByRole('button',{name:`Select release tag ${tag}`,exact:true}).click();await expect(card(page)).toBeVisible();
}

test('a stored draft shows rendered notes, what it read, the tag commit and the untrusted-draft badge; Use fills the notes field and publishes nothing',async({page})=>{
 const state=await backend(page);await open(page);
 await expect(card(page)).toContainText('Untrusted draft');await expect(card(page)).toContainText('Current');
 await expect(card(page)).toContainText('From 7 merged pull requests and 12 commits between v1.0 and v1.1.');
 await expect(card(page)).toContainText('@cf/zai-org/glm-5.3');await expect(card(page).getByTitle(C11)).toHaveText(C11.slice(0,12));
 const preview=card(page).getByLabel('Draft release notes, rendered Markdown');
 await expect(preview.getByRole('heading',{name:'Fixes'})).toBeVisible();await expect(preview.getByRole('link',{name:'#41'})).toHaveAttribute('href',`${base}/pull/41`);
 // Model text arrives neutralized: the escaped tag stays text and the mention stays inert.
 await expect(preview).toContainText('@​team <b> text stays inert');await expect(preview.locator('b')).toHaveCount(0);
 await expect(card(page)).toContainText('Not mentioned in the draft: #40, #42, #43, #45.');
 await expect(card(page)).toContainText("Generated by Workers AI through this installation's private AI Gateway. It can be wrong; nothing is published until you act.");
 await expect(notes(page)).toHaveValue('');
 await card(page).getByRole('button',{name:'Use as release notes'}).click();
 await expect(notes(page)).toHaveValue(markdown);
 await expect(card(page)).toContainText('The draft is in the release notes field. Edit it before you publish.');
 await notes(page).fill(markdown+'\nThanks to everyone who reported issues.\n');
 await expect(card(page).getByRole('button',{name:'Replace notes with draft'})).toBeEnabled();
 expect(state.writes).toBe(0);
});

test('Draft notes with Workers AI admits one run for the selected tag and previous tag, then shows the draft',async({page})=>{
 const state=await backend(page,{runs:[]});await open(page);
 await expect(card(page)).toContainText('No draft for v1.1 yet.');
 await card(page).getByRole('combobox',{name:'Previous tag'}).selectOption('v1.0');
 await expect(card(page).getByRole('combobox',{name:'Previous tag'}).locator('option')).toHaveText(['Latest published release','v1.0']);
 await card(page).getByRole('button',{name:'Draft notes with Workers AI'}).click();
 expect(state.created).toHaveLength(1);
 expect(Object.keys(state.created[0]!).sort()).toEqual(['action','idempotencyKey','kind','repository','repositoryId','target']);
 expect(state.created[0]).toMatchObject({action:'create',kind:'release-notes',target:{tag:'v1.1',previousTag:'v1.0'}});
 await expect(card(page).getByRole('button',{name:'Drafting…'})).toBeDisabled();
 await expect(card(page)).toContainText('Workers AI is drafting notes for v1.1…');
 await expect(card(page)).toContainText('From 7 merged pull requests',{timeout:10_000});
 expect(state.writes).toBe(0);
});

test('drafts of another tag are not shown; a stale draft says the tag moved',async({page})=>{
 await backend(page,{stale:true});await open(page);
 await expect(card(page)).toContainText('Out of date');await expect(card(page)).toContainText('A tag moved after this draft was written; draft again for the current range.');
});
test('another tag shows no draft for it',async({page})=>{
 await backend(page);await open(page,'v1.0');
 await expect(card(page)).toContainText('No draft for v1.0 yet.');await expect(card(page).getByRole('button',{name:'Use as release notes'})).toHaveCount(0);
});
test('a refused range and an unknown outcome are stated, and no draft is offered',async({page})=>{
 await backend(page,{runs:[run({state:'REFUSED',output:undefined,refusal:"The previous tag v0.9 is not on v1.1's first-parent history."})]});await open(page);
 await expect(card(page)).toContainText("The latest request was refused: The previous tag v0.9 is not on v1.1's first-parent history.");
 await expect(card(page).getByRole('button',{name:'Use as release notes'})).toHaveCount(0);
});
test('an unknown outcome keeps the earlier draft and says no new draft was stored',async({page})=>{
 await backend(page,{runs:[run({id:'3f333df6-90a4-4fda-8dd3-9485d27cee36',state:'UNKNOWN',output:undefined}),run()]});await open(page);
 await expect(card(page)).toContainText('The latest request’s outcome is unknown: no draft was stored (the answer may have failed validation). The draft above is from an earlier request.');
});
test('without the capability there is no draft card',async({page})=>{
 await backend(page,{capability:false});await page.goto('/alex/project/releases');await page.getByRole('button',{name:'New release',exact:true}).click();
 await page.getByRole('button',{name:'Select release tag v1.1',exact:true}).click();await expect(notes(page)).toBeVisible();await expect(card(page)).toHaveCount(0);
});
test('a feature policy that turned drafts off keeps the stored draft and removes the request',async({page})=>{
 await backend(page,{policyOff:true});await open(page);
 await expect(card(page)).toContainText('AI release notes drafts are turned off for this repository by the repository policy. Stored drafts stay readable.');
 await expect(card(page).getByRole('button',{name:'Draft again'})).toHaveCount(0);await expect(card(page).getByRole('button',{name:'Use as release notes'})).toBeVisible();
});

test.describe('screenshots',()=>{
 test.skip(!shots,'Set GOLF_AI_SHOTS to a directory to capture the draft.');
 for(const [appearance,layout,theme] of [['flare','console','dark'],['classic','primer','light'],['golf','tiles','light']] as const)
  for(const [width,height] of [[1440,900],[390,844]] as const)
   test(`draft in ${appearance} ${layout} ${theme} at ${width}px`,async({page})=>{
    await page.addInitScript(([a,l,t])=>{localStorage.setItem('golf.appearance',a!);localStorage.setItem(`golf.layout.${a}`,l!);localStorage.setItem('golf.theme',t!);},[appearance,layout,theme]);
    await page.setViewportSize({width,height});await backend(page);await open(page);await expect(card(page)).toContainText('Current');
    await page.evaluate(()=>document.fonts.ready);
    await card(page).scrollIntoViewIfNeeded();await page.screenshot({path:`${shots}/draft-${appearance}-${layout}-${theme}-${width}.png`});
    await card(page).screenshot({path:`${shots}/draft-${appearance}-${layout}-${theme}-${width}-card.png`});
    await card(page).getByRole('button',{name:'Use as release notes'}).click();await notes(page).scrollIntoViewIfNeeded();
    await page.screenshot({path:`${shots}/filled-${appearance}-${layout}-${theme}-${width}.png`});
   });
});
