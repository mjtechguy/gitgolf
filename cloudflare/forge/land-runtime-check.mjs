// Landing at agent speed in actual workerd/D1 against a real local Git repository; only the Artifacts binding is a fixture
// (docs/AGENTIC_MODE.md, AM-4 items 4 and 5). Merges and the revert are built inside workerd and received by `git receive-pack`.
//   1. Two pull requests on different files land concurrently through POST /native/land: the second meets the first one's
//      repository reservation, backs off and lands on the moved base; the tree equals `git merge-tree`.
//   2. A low-risk pull request lands without a person after its pipeline passes, committed as Golf (agentic mode).
//   3. Its push pipeline then fails: the automatic revert lands on the current tip with exactly the tree `git revert -m 1` writes.
//
//   node cloudflare/forge/land-runtime-check.mjs "$(command -v cf)"
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {realpathSync,mkdtempSync,rmSync} from 'node:fs';
import {execFileSync,spawnSync} from 'node:child_process';
import {tmpdir} from 'node:os';
import {dirname,join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {packetLine} from './src/git.mjs';
import * as esbuild from '../agents/node_modules/esbuild/lib/main.js';
const cli=dirname(dirname(realpathSync(process.argv[2])));
const {Miniflare,convertV4MiniflareOptions}=await import(pathToFileURL(resolve(cli,'node_modules/miniflare/dist/src/index.js')).href);
const bundle=await esbuild.build({stdin:{resolveDir:resolve('cloudflare/forge'),sourcefile:'land-runtime-fixture.mjs',contents:`
import {handle,withArtifact} from './src/core.mjs';
import {remote} from './src/git.mjs';
import {afterPipelineRun} from './src/land-queue.mjs';
const read=async (kind,hash)=>{const response=await fetch('https://fixture.invalid/'+kind+'/'+hash);return response.ok?response.json():null;};
export default {async fetch(request,env) {
 const fixture={...env,ARTIFACTS:{async get(name){return {async info(){return {name,remote:remote(env,name)};},async createToken(){return {plaintext:'local-only-token'};},async revokeToken(){return true;},
  async readCommit(hash){return read('commit',hash);},async readTree(hash){return read('tree',hash);},[Symbol.dispose](){}};}}};
 // The hook a finished pipeline run calls (worker.mjs PipelineRun), reached here directly by the check.
 if(new URL(request.url).pathname==='/__after-run'){await afterPipelineRun(fixture,await request.json(),withArtifact);return Response.json({ok:true});}
 return handle(request,fixture);
}};`},bundle:true,write:false,format:'esm',platform:'neutral'});
const root=mkdtempSync(join(tmpdir(),'golf-land-runtime-')),directory=join(root,'project.git'),witness=join(root,'witness.git'),origin='https://golf.example.com';
const gitEnv={PATH:process.env.PATH,HOME:root,GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null',GIT_AUTHOR_NAME:'Fixture',GIT_AUTHOR_EMAIL:'fixture@example.invalid',GIT_COMMITTER_NAME:'Fixture',GIT_COMMITTER_EMAIL:'fixture@example.invalid'};
const git=(args,input,dir=directory)=>execFileSync('git',['--git-dir',dir,...args],{env:gitEnv,input,stdio:['pipe','pipe','pipe']}),text=(...args)=>git(...args).toString().trim();
for(const dir of [directory,witness])execFileSync('git',['init','--bare','--quiet','--initial-branch=main',dir],{env:gitEnv});
let indexes=0;
const tree=files=>{const index=join(root,'index-'+indexes++);
 execFileSync('git',['--git-dir',directory,'update-index','--add','--index-info'],{env:{...gitEnv,GIT_INDEX_FILE:index},input:Object.entries(files).map(([name,content])=>`100644 ${text(['hash-object','-w','--stdin'],content)}\t${name}\n`).join('')});
 return execFileSync('git',['--git-dir',directory,'write-tree'],{env:{...gitEnv,GIT_INDEX_FILE:index}}).toString().trim();};
const start={'readme.txt':'base\n','docs/guide.md':'guide\n'},base=text(['commit-tree',tree(start),'-m','Base']);
const branch=(files,message)=>text(['commit-tree',tree({...start,...files}),'-p',base,'-m',message]);
const proposals=[['feature-a',{'src/a.txt':'a\n'},1],['feature-b',{'src/b.txt':'b\n'},1],['docs-c',{'docs/guide.md':'guide, revised\n','docs/c.md':'c\n'},2]].map(([name,files,author])=>[name,branch(files,name),author]);
git(['update-ref','refs/heads/main',base]);for(const [name,commit] of proposals)git(['update-ref','refs/heads/'+name,commit]);
const types={'040000':'tree','100644':'blob','100755':'exec','120000':'symlink','160000':'gitlink'};
let pushes=0,hold=null;
const receive=body=>spawnSync('git',['receive-pack','--stateless-rpc',directory],{env:gitEnv,input:body});
const runtime=new Miniflare(convertV4MiniflareOptions({modules:true,script:bundle.outputFiles[0].text,compatibilityDate:'2026-10-08',d1Databases:{DB:'lands'},
 bindings:{PUBLIC_ORIGIN:origin,WORKSPACE_SLUG:'alice',ARTIFACTS_NAMESPACE:'land-proof',ACCOUNT_ID:'a'.repeat(32)},
 outboundService:async request=>{
  const url=new URL(request.url);
  if(url.hostname==='fixture.invalid') {
   const [kind,hash]=url.pathname.split('/').slice(-2);
   if(kind==='tree') {
    const listed=spawnSync('git',['--git-dir',directory,'ls-tree','-z',hash],{env:gitEnv});
    if(listed.status)return new Response('missing',{status:404});
    return Response.json(listed.stdout.toString().split('\0').filter(Boolean).map(line=>{const [meta,name]=line.split('\t'),[mode,,id]=meta.split(' ');return {name,hash:id,type:types[mode],mode};}));
   }
   const read=spawnSync('git',['--git-dir',directory,'cat-file','commit',hash],{env:gitEnv});
   if(read.status)return new Response('missing',{status:404});
   const body=read.stdout.toString(),split=body.indexOf('\n\n'),headers=body.slice(0,split).split('\n'),author=/^author (.*) <.*> (\d+) [+-]\d{4}$/.exec(headers.find(line=>line.startsWith('author ')));
   return Response.json({hash,treeHash:headers[0].slice(5),parents:headers.filter(line=>line.startsWith('parent ')).map(line=>line.slice(7)),message:body.slice(split+2),author:{name:author[1]},authoredAt:Number(author[2])});
  }
  assert.equal(url.pathname.split('/').slice(0,4).join('/'),'/git/land-proof/repo-11111111111111111111111111111111.git');assert.equal(request.headers.get('Authorization'),'Bearer local-only-token');
  if(request.method==='GET'&&url.pathname.endsWith('/info/refs')&&url.search==='?service=git-upload-pack')
   return new Response(Buffer.concat([packetLine('# service=git-upload-pack\n'),Buffer.from('0000'),execFileSync('git',['upload-pack','--stateless-rpc','--advertise-refs',directory],{env:gitEnv})]),{headers:{'Content-Type':'application/x-git-upload-pack-advertisement'}});
  assert.equal(request.method,'POST');assert.ok(url.pathname.endsWith('/git-receive-pack'));pushes++;
  const body=Buffer.from(await request.arrayBuffer());
  // The first merge waits here until the other land has been admitted and met the repository reservation.
  if(hold){const wait=hold;hold=null;await wait();}
  const received=receive(body);
  return new Response(received.stdout,{headers:{'Content-Type':'application/x-git-receive-pack-result'}});
 }}));
try {
 const db=await runtime.getD1Database('DB');
 for(const sql of (await readFile(new URL('./schema.sql',import.meta.url),'utf8')).replace(/--[^\n]*/g,'').split(/;\s*(?=CREATE\b)/).filter(s=>s.trim()))await db.prepare(sql).run();
 await db.prepare("INSERT INTO users(id,login,email,full_name) VALUES(1,'alice','alice@example.com','Alice Example'),(2,'bob','bob@example.com','Bob Example')").run();
 await db.prepare("INSERT INTO workspaces(slug,artifact_namespace) VALUES('alice','land-proof')").run();
 await db.prepare("INSERT INTO repositories(id,name,description,artifact_name,creator_id,creation_key,input_hash,state,created_at) VALUES(1,'project','','repo-11111111111111111111111111111111',1,'original','hash','ACTIVE','2026-10-14T00:00:00Z')").run();
 await db.prepare("INSERT INTO grants VALUES(1,1,'admin'),(1,2,'write')").run();
 for(const [index,[name,head,author]] of proposals.entries()) {
  await db.prepare("INSERT INTO discussions(id,repository_id,number,kind,author_id,title,body,state,created_at,updated_at) VALUES(?,1,?,'pull',?,?,'','OPEN','t','t')").bind(index+1,index+1,author,'Proposal '+name).run();
  await db.prepare("INSERT INTO pull_requests(id,discussion_id,base_branch,head_branch,base_commit,head_commit,draft) VALUES(?,?,'main',?,?,?,0)").bind(index+1,index+1,name,base,head).run();
 }
 // Agentic mode on, saved by alice: docs are low-risk and may land without a person; every pipeline must pass; revert on failure.
 await db.prepare(`INSERT INTO repository_agentic_settings(repository_id,enabled,low_risk_paths,sensitive_paths,land_without_person,required_checks,revert_on_failure,version,updated_by,updated_at)
  VALUES(1,1,'["docs/**"]','["deploy/**"]',1,'[]',1,1,1,'t')`).run();
 const key={owner:'alice',name:'project'};
 const call=async(path,body,person)=>{
  const response=await runtime.dispatchFetch(origin+path,{method:'POST',headers:{'Content-Type':'application/json','Connect-Protocol-Version':'1','X-Golf-Native-Access-Email':person+'@example.com',Origin:origin},body:JSON.stringify({repository:key,repositoryId:'1',...body})});
  const value=await response.json();assert.equal(response.status,200,JSON.stringify(value));return value;
 };
 const land=(number,head)=>call('/native/land',{action:'land',number,expectedHeadCommitId:head},'bob');
 const run=(commit,state,event)=>db.prepare(`INSERT INTO pipeline_runs(repository_id,artifact_name,engine,number,workflow_path,workflow_name,event,ref,commit_id,actor_id,trusted,state,created_at,updated_at)
  VALUES(1,'repo-11111111111111111111111111111111','forgejo-actions',(SELECT COALESCE(max(number),0)+1 FROM pipeline_runs),'.forgejo/workflows/ci.yml','CI',?,'refs/heads/main',?,1,1,?,'t','t')`).bind(event,commit,state).run();
 const afterRun=async commit=>{const response=await runtime.dispatchFetch(origin+'/__after-run',{method:'POST',body:JSON.stringify({repository_id:1,commit_id:commit})});assert.equal(response.status,200,await response.clone().text());};

 // 1. Two concurrent lands of different files. Bob is a writer who is not the author: the qualifying approval for normal-risk paths.
 hold=async()=>{for(let i=0;i<400;i++){const other=await db.prepare("SELECT attempts FROM land_operations WHERE number=2").first();if(other?.attempts>=1)return;await new Promise(r=>setTimeout(r,10));}throw Error('the second land never started');};
 const firstLand=land(1,proposals[0][1]);
 await new Promise(r=>setTimeout(r,50));
 const [first,second]=await Promise.all([firstLand,land(2,proposals[1][1])]);
 assert.equal(first.operation.state,'LANDED');assert.equal(second.operation.state,'LANDED',JSON.stringify(second));
 assert.equal(first.operation.baseCommitId,base);assert.equal(second.operation.baseCommitId,first.operation.landedCommitId);assert.ok(second.operation.attempts>=2);
 assert.equal(text(['rev-parse','refs/heads/main']),second.operation.landedCommitId);
 const witnessFetch=(...commits)=>{const fetched=spawnSync('git',['--git-dir',witness,'fetch','--quiet','--no-write-fetch-head',directory,...commits.map((commit,index)=>`+${commit}:refs/witness/${index}`)],{env:gitEnv});assert.equal(fetched.status,0,fetched.stderr.toString());};
 witnessFetch(first.operation.landedCommitId,proposals[1][1]);
 assert.equal(text(['rev-parse','refs/heads/main^{tree}']),text(['merge-tree','--write-tree',first.operation.landedCommitId,proposals[1][1]],undefined,witness));
 assert.equal(text(['log','-1','--format=%P','refs/heads/main']),`${first.operation.landedCommitId} ${proposals[1][1]}`);
 git(['fsck','--strict','--full','--no-dangling']);
 assert.equal((await db.prepare('SELECT write_pending FROM repositories').first()).write_pending,null);

 // 2. The docs pull request's pipeline passes: the policy lands it without a person, committed as Golf.
 await run(proposals[2][1],'SUCCESS','pull_request');
 await afterRun(proposals[2][1]);
 const policy=await db.prepare("SELECT * FROM land_operations WHERE number=3").first();
 assert.equal(policy.state,'LANDED',policy.detail);assert.equal(policy.trigger,'policy');assert.equal(policy.actor_id,0);
 assert.equal(text(['log','-1','--format=%an <%ae>|%cn <%ce>|%P','refs/heads/main']),`Golf (agentic mode) <agentic@golf.invalid>|Golf (agentic mode) <agentic@golf.invalid>|${second.operation.landedCommitId} ${proposals[2][1]}`);
 assert.equal(text(['show','refs/heads/main:docs/guide.md']),'guide, revised');

 // 3. Another change lands on main, then the landed commit's push pipeline fails: the revert lands on the current tip.
 const laterTree=(()=>{const index=join(root,'index-later');execFileSync('git',['--git-dir',directory,'read-tree',policy.landed_commit_id+'^{tree}'],{env:{...gitEnv,GIT_INDEX_FILE:index}});
  execFileSync('git',['--git-dir',directory,'update-index','--add','--index-info'],{env:{...gitEnv,GIT_INDEX_FILE:index},input:`100644 ${text(['hash-object','-w','--stdin'],'later\n')}\tsrc/later.txt\n`});
  return execFileSync('git',['--git-dir',directory,'write-tree'],{env:{...gitEnv,GIT_INDEX_FILE:index}}).toString().trim();})();
 const tip=text(['commit-tree',laterTree,'-p',policy.landed_commit_id,'-m','Later']);
 git(['update-ref','refs/heads/main',tip,policy.landed_commit_id]);
 await run(policy.landed_commit_id,'FAILURE','push');
 const before=pushes;
 await afterRun(policy.landed_commit_id);
 const reverted=await db.prepare("SELECT * FROM land_operations WHERE number=3").first();
 assert.equal(reverted.state,'REVERTED',reverted.detail);assert.equal(reverted.revert_commit_id,text(['rev-parse','refs/heads/main']));assert.equal(pushes,before+1);
 assert.equal(text(['log','-1','--format=%P|%an <%ae>|%s','refs/heads/main']),`${tip}|Golf (agentic mode) <agentic@golf.invalid>|Revert "Proposal docs-c" (#3)`);
 // Real `git revert -m 1` of the landed merge on the same tip, in a separate clone: the same tree.
 const work=join(root,'work');
 execFileSync('git',['clone','--quiet','--branch','main',directory,work],{env:gitEnv});
 execFileSync('git',['-C',work,'reset','--quiet','--hard',tip],{env:gitEnv});
 execFileSync('git',['-C',work,'revert','--no-edit','-m','1',policy.landed_commit_id],{env:gitEnv,stdio:['pipe','pipe','pipe']});
 assert.equal(text(['rev-parse','refs/heads/main^{tree}']),execFileSync('git',['-C',work,'rev-parse','HEAD^{tree}'],{env:gitEnv}).toString().trim());
 git(['fsck','--strict','--full','--no-dangling']);
 // The pull request comment and the issue for the requester (bob, the author), assigned by the administrator who saved the setting.
 const issue=await db.prepare("SELECT d.title,(SELECT u.login FROM discussion_assignees a JOIN users u ON u.id=a.user_id WHERE a.discussion_id=d.id) AS assignee FROM discussions d WHERE d.kind='issue'").first();
 assert.deepEqual({...issue},{title:'Automatic revert of #3: checks failed',assignee:'bob'});
 assert.ok(await db.prepare("SELECT 1 FROM discussion_comments c JOIN discussions d ON d.id=c.discussion_id WHERE d.number=3 AND c.body LIKE '%reverted this pull request%'").first());
 // Once: another completion reverts nothing more.
 await afterRun(policy.landed_commit_id);assert.equal(pushes,before+1);
 const list=await call('/native/land/read',{action:'list',limit:10},'alice');
 assert.deepEqual(list.operations.map(op=>[op.number,op.state,op.trigger]).sort(),[[1,'LANDED','person'],[2,'LANDED','person'],[3,'REVERTED','policy']]);
 console.log('Real workerd/D1 landing: two concurrent lands of different files (one retried onto the moved base, tree equal to git merge-tree), a policy land committed as Golf (agentic mode), and an automatic revert after a failed push pipeline whose tree equals git revert -m 1; issue assigned, comment posted, revert once');
} finally {await runtime.dispose();rmSync(root,{recursive:true,force:true});}
