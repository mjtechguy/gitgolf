// Actual served pages only. Configuration arrives on stdin; no mocked RPCs,
// provider authentication, inference, workflow dispatch or editor submission.
import {pathToFileURL} from 'node:url';
import {join} from 'node:path';
import {chmod, writeFile} from 'node:fs/promises';

const headers = origin => ({Origin:origin,'Connect-Protocol-Version':'1','Content-Type':'application/json'});
const encodePath = path => path.split('/').map(encodeURIComponent).join('/');
const entry = (id, route, selector, extra={}) => ({id,route,selector,role:'owner',state:'current',...extra});
const readProcedure = method => /^(Get|List|Watch|Inspect|Resolve)/.test(method)||method==='QueryRepositoryComparison';

function pages(c) {
  const repo='/'+c.repository, org='/organizations/'+c.organization;
  const file=repo+'/blob/'+c.commit+'/'+encodePath(c.path);
  const pull=repo+'/pull/'+c.pull;
  return [
    entry('home','/','#repositories-title'),
    entry('status','/status','#capabilities-title'),
    entry('status-alias','/#capabilities','#capabilities-title',{state:'alias'}),
    entry('code',repo,'.source-tree'),
    entry('empty-code','/'+c.emptyRepository,'.empty-state',{state:'empty'}),
    entry('folder',repo+'/tree/'+c.commit+'/src','.source-tree'),
    entry('file',file,'.numbered-source'),
    entry('file-lines',file+'#L1-L2','.numbered-source',{state:'line-range'}),
    entry('markdown',repo+'/blob/'+c.commit+'/README.md','.markdown-body'),
    entry('branch',repo+'/tree/feature/review?refKind=branch&refName=feature%2Freview','.source-tree',{state:'explicit-named-branch'}),
    entry('tag',repo+'/tree/preview/v1?refKind=tag&refName=preview%2Fv1','.source-tree',{state:'explicit-named-tag'}),
    entry('source-alias','/repositories/'+c.repository+'?ref='+c.commit+'&path='+encodeURIComponent(c.path),'.numbered-source',{state:'alias'}),
    entry('commits',repo+'/commits?ref='+c.commit,'#commits-title'),
    entry('path-history',repo+'/commits/'+c.commit+'/'+encodePath(c.path),'#commits-title'),
    entry('commit',repo+'/commit/'+c.commit,'#commit-diff-title'),
    entry('compare',repo+'/compare?base='+encodeURIComponent(c.defaultBranch)+'&head=feature%2Freview','.repository-comparison'),
    entry('issues',repo+'/issues','#issues-title'),
    entry('closed-issues',repo+'/issues?state=closed','#issues-title',{state:'closed-filter'}),
    entry('new-issue',repo+'/issues/new','[aria-label="Issue editor"]',{state:'explicit-editor'}),
    entry('issue',repo+'/issues/'+c.issue,'#issue-detail-title'),
    entry('closed-issue',repo+'/issues/'+c.closedIssue,'#issue-detail-title',{state:'closed'}),
    entry('pulls',repo+'/pulls','#pulls-title'),
    entry('pull-conversation',pull,'#pull-detail-title'),
    entry('pull-files',pull+'/files','[aria-label="Pull request diff"]'),
    entry('pull-commits',pull+'/commits','#pull-commits-title'),
    entry('pull-checks',pull+'/checks','#pull-checks-title',{state:'empty-reported-statuses'}),
    entry('actions',repo+'/actions','#workflow-configurations-title',{state:'empty-runs-and-workflows'}),
    entry('repository-settings',repo+'/settings','#repository-general-title'),
    entry('repository-access',repo+'/settings/access','#collaborators-title'),
    entry('repository-workflows',repo+'/settings/workflows','#workflow-inventory-title',{state:'empty-configurations-with-settings'}),
    ...['','/access','/workflows'].map((suffix,i)=>entry('settings-alias-'+i,'/repositories/'+c.repository+'/settings'+suffix,'.account-content',{state:'alias'})),
    entry('profile','/account/settings','#profile-title'),
    entry('security','/account/security','#account-security-title'),
    entry('sessions','/account/sessions','#sessions-title'),
    entry('ssh-keys','/account/ssh-keys','#ssh-keys-title',{state:'empty'}),
    entry('api-credentials','/account/api-credentials','#credential-list-title',{state:'empty'}),
    entry('audit','/audit','#activity-title'),
    entry('personal-agents','/account/agents','[aria-label="Codex account connection"]',{state:'unconfigured-or-unavailable'}),
    entry('organizations','/organizations','.organization-list'),
    entry('organization',org,'.organization-guidance'),
    entry('team',org+'?team='+c.teamId,'#team-title'),
    entry('organization-settings',org+'/settings','#scope-settings-title'),
    entry('team-settings',org+'/teams/'+c.teamId+'/settings','#team-members-title'),
    entry('organization-repository','/'+c.orgRepository,'.source-tree'),
    entry('admin','/admin','#instance-settings-title'),
    entry('admin-accounts','/admin/settings','#instance-accounts-title'),
    entry('admin-execution','/admin/execution','[aria-label="Execution policy"]'),
    entry('admin-organizations','/admin/organizations','[aria-label="Organization creation policy"]'),
    entry('admin-agents','/admin/agents','[aria-label="Instance coding-agent connections"]',{state:'current-instance-inventory'}),
    entry('admin-infrastructure','/admin/settings/infrastructure','#database-connections-title'),
    entry('reader-code',repo,'.source-tree',{role:'reader',state:'read-only'}),
    entry('reader-settings',repo+'/settings','#repository-general-title',{role:'reader',state:'read-only'}),
    entry('reader-team-settings',org+'/teams/'+c.teamId+'/settings','#team-members-title',{role:'reader',state:'read-only-member'}),
    entry('nonadmin','/admin','h1',{role:'reader',state:'denied-admin',text:'Instance settings unavailable'}),
    entry('outsider-repository',repo,'[role="alert"]',{role:'outsider',state:'denied-private',deny:true,forbid:'.source-tree,.numbered-source,.markdown-body,.repository-sidebar'}),
    entry('outsider-organization',org,'[role="alert"]',{role:'outsider',state:'denied-membership',deny:true,forbid:'.organization-list,.unit-permissions,.organization-guidance'}),
    entry('missing','/this-route-does-not-exist','.empty-state',{state:'not-found',text:'Page not found'}),
    entry('invalid-pull',repo+'/pull/0','.empty-state',{state:'invalid-deep-link',text:'Page not found',noRepositoryRPC:true}),
    entry('invalid-run',repo+'/actions/runs/not-a-uuid','.empty-state',{state:'invalid-deep-link',text:'Page not found',noRepositoryRPC:true}),
    entry('login','/account/settings','[aria-label="Golf account sign-in"]',{role:'anonymous',state:'signed-out'}),
    entry('profile-editor','/account/settings','[aria-label="Edit account profile"]',{state:'explicit-editor',button:'Edit profile'}),
    entry('ssh-editor','/account/ssh-keys','.credential-create-panel',{state:'explicit-editor',button:'New SSH key'}),
    entry('api-editor','/account/api-credentials','#credential-create-title',{state:'explicit-editor',button:'New API credential'}),
    entry('repository-editor',repo+'/settings','#repository-settings-description',{state:'explicit-editor',button:'Edit general settings'}),
    entry('private-draft',pull+'/files','[aria-label="Private review draft"]',{state:'unsaved-private-editor',button:'Private draft'}),
    entry('review-editor',pull,'[aria-label="Review changes"]',{role:'reader',state:'explicit-editor',button:'Review changes'}),
    entry('user-menu','/account/sessions','.account-dropdown',{state:'explicit-menu',click:'summary[aria-label="Your account"]'}),
    entry('branch-menu',repo,'.branch-options',{state:'explicit-menu',click:'.ref-picker:not(.clone-picker) summary'}),
    entry('clone-menu',repo,'.clone-options',{state:'explicit-menu',click:'.clone-picker summary'}),
    entry('new-repository','/','#create-title',{state:'explicit-editor',button:'New repository'}),
    entry('admin-new-connection','/admin/agents','form[aria-label="New agent connection"]',{state:'explicit-editor',button:'New agent connection'}),
    entry('admin-add-database','/admin/settings/infrastructure','#connection-editor-title',{state:'explicit-editor',button:'Add database profile'}),
    entry('admin-add-storage','/admin/settings/infrastructure','#connection-editor-title',{state:'explicit-editor',button:'Add object-storage profile'}),
    entry('admin-test-warning','/admin/settings/infrastructure','#connection-editor-title',{state:'explicit-test-editor-no-probe',ready:'#database-connections-title',optionalButton:'Test'}),
    entry('admin-activation-warning','/admin/settings/infrastructure','#connection-editor-title',{state:'explicit-activation-editor-no-apply',ready:'#database-connections-title',optionalButton:'Activate'}),
  ];
}

function selectedPages(c) {
  const inventory=pages(c);
  if(c.only===undefined||c.only.length===0)return inventory;
  if(!Array.isArray(c.only)||c.only.length>inventory.length||new Set(c.only).size!==c.only.length||c.only.some(id=>typeof id!=='string'||!inventory.some(item=>item.id===id)))throw Error('Invalid selected page identifiers');
  return inventory.filter(item=>c.only.includes(item.id));
}

let config,browser,stage='configuration';
const contexts=[],results=[];
const pending=[
  {family:'Actions run detail and selected step',reason:'No actual owned workflow run: execution is deliberately not performed by this audit.'},
  {family:'Saved draft/native publication receipt',reason:'No private Save or native Publish: use the separate explicitly authorized publication qualifier.'},
  {family:'Provider auth, connected agent/model/task result',reason:'No provider sign-in or paid inference; current configured/unavailable states only.'},
  {family:'Faults/loading/revocation/recovery',reason:'Capture is read-only: deterministic fixtures and separate real authority/restart qualifiers retain their own provenance.'},
  {family:'SSH/token/grant/infrastructure mutation confirmation',reason:'Editors may open, but no credential issuance, key addition, delegation or global setting change is submitted.'},
  {family:'Authenticated GitHub settings/write controls',reason:'This driver captures Golf only; no imported GitHub session or authenticated reference is invented.'},
];

if(process.argv.includes('--self-check')||process.argv.includes('--check-pages')){
  const c={repository:'owner/workspace',emptyRepository:'owner/empty',orgRepository:'example-org/work',organization:'example-org',teamId:'42',commit:'a'.repeat(40),path:'src/app ü%.py',defaultBranch:'main',issue:1,closedIssue:2,pull:3};
  const inventory=pages(c);
  if(process.argv.includes('--check-pages')){
    selectedPages({...c,only:process.argv.slice(process.argv.indexOf('--check-pages')+1)});
    console.log('PASS: selected page identifiers are valid; no browser or native fixture run.');
    process.exit(0);
  }
  if(selectedPages({...c,only:['status','actions']}).length!==2)throw Error('Selected page filtering changed');
  for(const only of [['unknown'],['status','status'],[null]]){let rejected=false;try{selectedPages({...c,only});}catch{rejected=true;}if(!rejected)throw Error('Invalid page selection accepted');}
  if(new Set(inventory.map(value=>value.id)).size!==inventory.length)throw Error('Duplicate page identifier');
  if(inventory.some(value=>!value.selector||!value.route.startsWith('/')||!['owner','reader','outsider','anonymous'].includes(value.role)))throw Error('Invalid page entry');
  if(!inventory.find(value=>value.id==='file').route.endsWith('/src/app%20%C3%BC%25.py'))throw Error('Literal path encoding changed');
  if(!inventory.find(value=>value.id==='login'&&value.role==='anonymous')||!inventory.find(value=>value.id==='outsider-repository'&&value.forbid))throw Error('Privacy coverage missing');
  for(const method of ['GetContents','ListTags','ResolveRepositorySource','QueryRepositoryComparison'])if(!readProcedure(method))throw Error('Read guard denied supported read');
  for(const method of ['PublishPullRequestReviewDraft','SavePullRequestReviewDraft','CreateApiCredential','DispatchWorkflow','SetRepositoryCollaborator'])if(readProcedure(method))throw Error('Read guard permits effect');
  console.log('PASS: '+inventory.length+' page/state cases, literal path encoding and no-effect network guard; no browser or native fixture run.');
  process.exit(0);
}

try {
  let raw='';for await(const chunk of process.stdin)raw+=chunk;
  config=JSON.parse(raw);raw='';
  if(!config.golf?.startsWith('http://localhost:')||!config.screenshots||!config.actors?.owner)throw Error('Invalid local fixture configuration');
  const {chromium}=await import(pathToFileURL(join(process.cwd(),'web/node_modules/playwright/index.mjs')));
  browser=await chromium.launch();
  const inventory=selectedPages(config);
  for(const width of [1440,390])for(const theme of ['dark','light']){
    const roleContexts={};
    for(const role of ['owner','reader','outsider','anonymous']){
      const context=await browser.newContext({viewport:{width,height:1000},colorScheme:theme});contexts.push({context,role});
      if(role!=='anonymous'){
        stage='managed-login';const actor=config.actors[role];
        const response=await context.request.post(config.golf+'/rpc/golf.v1.SessionService/LoginWithPassword',{headers:headers(config.golf),data:{username:actor.email,password:actor.password}});
        if(response.status()!==200)throw Error('Managed sign-in refused');
        const identity=(await response.json()).user;
        if(identity?.login!==actor.name||Boolean(identity.isInstanceAdmin)!==(role==='owner'))throw Error('Managed actor identity differs');
      }
      await context.addInitScript(value=>{localStorage.setItem('golf.theme',value);},theme);
      roleContexts[role]=context;
    }
    for(const item of inventory){
      stage=item.id;
      const context=roleContexts[item.role],page=await context.newPage();
      const rpc=[],privateErrors=[],writes=[];let inflight=0,lastResponse=Date.now();
      page.setDefaultTimeout(15000);
      page.on('pageerror',()=>privateErrors.push('page-error'));
      // Prevent an accidental editor submit from causing a native/global effect.
      // Nothing is mocked: read requests proceed to the real server unchanged.
      await page.route('**/rpc/**',route=>{
        const method=route.request().url().split('/').at(-1);
        if(!readProcedure(method)){writes.push(method);return route.abort('blockedbyclient');}
        return route.continue();
      });
      page.on('request',request=>{if(/\/rpc\//.test(request.url())&&!request.url().endsWith('/WatchRepository'))inflight++;});
      page.on('requestfailed',request=>{if(/\/rpc\//.test(request.url())&&!request.url().endsWith('/WatchRepository')){inflight=Math.max(0,inflight-1);lastResponse=Date.now();}});
      page.on('response',response=>{
        if(!/\/rpc\//.test(response.url()))return;
        const procedure=response.url().split('/').at(-1);
        rpc.push({procedure,status:response.status()});
        if(procedure!=='WatchRepository'){inflight=Math.max(0,inflight-1);lastResponse=Date.now();}
      });
      const result={id:item.id,requestedRoute:item.route,role:item.role,state:item.state,width,height:1000,theme,captureKind:'actual-served-owned-native-fixture',status:'pending',rpc};
      try{
        await page.goto(config.golf+item.route,{waitUntil:'domcontentloaded'});
        if(item.optionalButton){
          await page.locator(item.ready).waitFor({state:'visible'});
          const deadline=Date.now()+12000;
          while(Date.now()<deadline&&(inflight>0||Date.now()-lastResponse<450))await page.waitForTimeout(100);
          if(inflight>0||rpc.some(value=>value.status>=400))throw Error('Infrastructure inventory did not settle');
          const button=page.getByRole('button',{name:item.optionalButton,exact:true}).first();
          if(!await button.count()){
            result.status='pending-configuration';result.reason='No eligible saved profile/action in the actual current inventory; no profile was created for this capture.';
          }else await button.click();
        }
        if(item.button){const button=page.getByRole('button',{name:item.button,exact:true});await button.waitFor();await button.click();}
        if(item.click)await page.locator(item.click).first().click();
        if(result.status!=='pending-configuration')await page.locator(item.selector).first().waitFor({state:'visible'});
        if(item.text&&!await page.locator('main').getByText(item.text,{exact:true}).count())throw Error('Unexpected page state');
        // Settle bounded unary reads/visible lazy rows; a live stream remains open.
        const deadline=Date.now()+12000;
        while(Date.now()<deadline&&(inflight>0||Date.now()-lastResponse<450))await page.waitForTimeout(100);
        if(inflight>0)throw Error('Unary reads did not settle');
        const actualTheme=await page.locator('html').getAttribute('data-theme');
        if(actualTheme!==theme){await page.getByRole('button',{name:'Switch to '+theme+' theme',exact:true}).click();}
        result.actualTheme=await page.locator('html').getAttribute('data-theme');
        result.rpcErrors=rpc.filter(value=>value.status>=400);
        const unexpected=result.rpcErrors.filter(value=>!(item.role==='anonymous'&&value.procedure==='GetSession'&&value.status===401)&&!(item.deny&&[403,404].includes(value.status))&&!(item.state==='read-only-member'&&value.status===403));
        if(unexpected.length)throw Error('Unexpected route RPC error');
        const metrics=await page.evaluate(()=>({documentWidth:document.documentElement.scrollWidth,viewportWidth:innerWidth,headings:[...document.querySelectorAll('main h1,main h2')].filter(e=>e.getClientRects().length).map(e=>({text:e.textContent?.trim(),x:e.getBoundingClientRect().x,y:e.getBoundingClientRect().y,height:e.getBoundingClientRect().height})),firstCodeY:document.querySelector('.diff-line,.source-tree li')?.getBoundingClientRect().y??null}));
        result.metrics=metrics;
        result.actualRoute=new URL(page.url()).pathname+new URL(page.url()).search+new URL(page.url()).hash;
        if(privateErrors.length||writes.length||metrics.documentWidth>width||result.actualTheme!==theme)throw Error('Runtime, accidental write, overflow or theme failure');
        if(item.deny&&!rpc.some(r=>r.status===403||r.status===404))throw Error('Expected current denial not observed');
        if(item.forbid&&await page.locator(item.forbid).count())throw Error('Private resource remained rendered on denied page');
        if(item.noRepositoryRPC&&rpc.some(value=>!['GetSession','GetAuthenticationOptions','ListCapabilities'].includes(value.procedure)))throw Error('Invalid route probed a protected resource');
        if(result.status!=='pending-configuration')result.status='captured';
      }catch{result.status='failed';result.reason='Expected actual page/state, read-only, runtime or layout assertion failed; sensitive diagnostics withheld';}
      result.pageErrorCount=privateErrors.length;result.blockedWriteCount=writes.length;
      const basename=item.id+'-'+theme+'-'+width;
      const image=join(config.screenshots,basename+'.png');
      try{
        await page.screenshot({path:image,fullPage:true,timeout:20000});await chmod(image,0o600);
        await writeFile(join(config.screenshots,basename+'.txt'),await page.locator('body').innerText(),{mode:0o600});
        result.screenshot=basename+'.png';result.textSnapshot=basename+'.txt';
      }catch{result.status='failed';result.reason='Actual capture could not be written';}
      results.push(result);await page.close();
      // Persist incrementally so an interrupted/failed audit never appears complete.
      await writeFile(join(config.screenshots,'manifest.json'),JSON.stringify({workingTreeHead:config.workingTreeHead,servedSourceCommit:config.servedSourceCommit??null,runtime:config.runtime,captureKind:'Actual local Golf read-only browser audit on disposable native fixture',complete:false,results,pending},null,2),{mode:0o600});
      if(results.length%20===0)console.log('Recorded '+results.length+' actual page/state captures; errors, if any, remain in the private manifest.');
    }
    for(const [role,context] of Object.entries(roleContexts)){
      if(role!=='anonymous'){
        const response=await context.request.post(config.golf+'/rpc/golf.v1.SessionService/Logout',{headers:headers(config.golf),data:{}});
        if(response.status()!==200)throw Error('Managed logout failed');
      }
      await context.close();contexts.splice(contexts.findIndex(value=>value.context===context),1);
    }
    console.log('Capture batch recorded: '+theme+' '+width+'; inspect owner-only manifest for actual states.');
  }
  await writeFile(join(config.screenshots,'manifest.json'),JSON.stringify({workingTreeHead:config.workingTreeHead,servedSourceCommit:config.servedSourceCommit??null,runtime:config.runtime,captureKind:config.only?.length?'Actual selected-page local Golf read-only browser audit on disposable native fixture':'Actual local Golf read-only browser audit on disposable native fixture',selectedPageIds:config.only??[],pageStateCount:inventory.length,complete:true,passed:results.every(value=>['captured','pending-configuration'].includes(value.status)),results,pending},null,2),{mode:0o600});
  if(results.some(value=>!['captured','pending-configuration'].includes(value.status)))throw Error('One or more page captures failed');
  console.log('PASS: real route-family captures; no browser mutation dispatched; pending coverage explicitly recorded.');
}catch{
  console.error('All-page browser failed at '+stage+'; sensitive diagnostics withheld.');process.exitCode=1;
}finally{
  for(const {context,role} of contexts){
    if(config&&role!=='anonymous')try{
      const response=await context.request.post(config.golf+'/rpc/golf.v1.SessionService/Logout',{headers:headers(config.golf),data:{}});
      if(response.status()!==200)throw Error('Logout refused');
    }catch{console.error('All-page browser session cleanup failed; sensitive diagnostics withheld.');process.exitCode=1;}
    await context.close().catch(()=>{});
  }
  await browser?.close();
}
