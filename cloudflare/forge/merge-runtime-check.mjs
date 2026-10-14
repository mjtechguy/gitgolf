// Actual workerd/D1 merge transactions against a real local Git repository; only the Artifacts binding is a fixture.
// The pack is built inside workerd and received by `git receive-pack`, the program a smart-HTTP server runs.
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
const bundle=await esbuild.build({stdin:{resolveDir:resolve('cloudflare/forge'),sourcefile:'merge-runtime-fixture.mjs',contents:`
import {handle} from './src/core.mjs';
import {remote} from './src/git.mjs';
export default {fetch(request,env) {
 const fixture={...env,ARTIFACTS:{async get(name){return {async info(){return {name,remote:remote(env,name)};},async createToken(){return {plaintext:'local-only-token'};},async revokeToken(){return true;},
  async readCommit(hash){const response=await fetch('https://fixture.invalid/commit/'+hash);return response.ok?response.json():null;},[Symbol.dispose](){}};}}};
 return handle(request,fixture);
}};`},bundle:true,write:false,format:'esm',platform:'neutral'});
const root=mkdtempSync(join(tmpdir(),'golf-merge-runtime-')),directory=join(root,'project.git'),origin='https://golf.example.com';
const gitEnv={PATH:process.env.PATH,HOME:root,GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null',GIT_AUTHOR_NAME:'Fixture',GIT_AUTHOR_EMAIL:'fixture@example.invalid',GIT_COMMITTER_NAME:'Fixture',GIT_COMMITTER_EMAIL:'fixture@example.invalid'};
const git=(args,input)=>execFileSync('git',['--git-dir',directory,...args],{env:gitEnv,input,stdio:['pipe','pipe','pipe']}),text=(...args)=>git(...args).toString().trim();
execFileSync('git',['init','--bare','--quiet','--initial-branch=main',directory],{env:gitEnv});
const tree=files=>text(['mktree'],Object.entries(files).map(([name,content])=>`100644 blob ${text(['hash-object','-w','--stdin'],content)}\t${name}\n`).join(''));
const base=text(['commit-tree',tree({'readme.txt':'base\n'}),'-m','Base']),head=text(['commit-tree',tree({'readme.txt':'base\n','feature.txt':'change\n'}),'-p',base,'-m','Feature']);
const other=text(['commit-tree',tree({'readme.txt':'base\n','other.txt':'other\n'}),'-p',base,'-m','Other']);
for(const [name,commit] of [['main',base],['feature',head],['other',other]])git(['update-ref','refs/heads/'+name,commit]);
let pushes=0;
const runtime=new Miniflare(convertV4MiniflareOptions({modules:true,script:bundle.outputFiles[0].text,compatibilityDate:'2026-10-08',d1Databases:{DB:'merges'},
 bindings:{PUBLIC_ORIGIN:origin,WORKSPACE_SLUG:'alice',ARTIFACTS_NAMESPACE:'merge-proof',ACCOUNT_ID:'a'.repeat(32)},
 outboundService:async request=>{
  const url=new URL(request.url);
  if(url.hostname==='fixture.invalid') {
   const hash=url.pathname.split('/').at(-1),read=spawnSync('git',['--git-dir',directory,'cat-file','commit',hash],{env:gitEnv});
   if(read.status)return new Response('missing',{status:404});
   const body=read.stdout.toString(),split=body.indexOf('\n\n'),headers=body.slice(0,split).split('\n'),author=/^author (.*) <.*> (\d+) [+-]\d{4}$/.exec(headers.find(line=>line.startsWith('author ')));
   return Response.json({hash,treeHash:headers[0].slice(5),parents:headers.filter(line=>line.startsWith('parent ')).map(line=>line.slice(7)),message:body.slice(split+2),author:{name:author[1]},authoredAt:Number(author[2])});
  }
  assert.equal(url.pathname.split('/').slice(0,4).join('/'),'/git/merge-proof/repo-11111111111111111111111111111111.git');assert.equal(request.headers.get('Authorization'),'Bearer local-only-token');
  if(request.method==='GET'&&url.pathname.endsWith('/info/refs')&&url.search==='?service=git-upload-pack')
   return new Response(Buffer.concat([packetLine('# service=git-upload-pack\n'),Buffer.from('0000'),execFileSync('git',['upload-pack','--stateless-rpc','--advertise-refs',directory],{env:gitEnv})]),{headers:{'Content-Type':'application/x-git-upload-pack-advertisement'}});
  assert.equal(request.method,'POST');assert.ok(url.pathname.endsWith('/git-receive-pack'));assert.equal(request.headers.get('Content-Type'),'application/x-git-receive-pack-request');pushes++;
  const received=spawnSync('git',['receive-pack','--stateless-rpc',directory],{env:gitEnv,input:Buffer.from(await request.arrayBuffer())});
  return new Response(received.stdout,{headers:{'Content-Type':'application/x-git-receive-pack-result'}});
 }}));
try {
 const db=await runtime.getD1Database('DB');
 for(const sql of (await readFile(new URL('./schema.sql',import.meta.url),'utf8')).replace(/--[^\n]*/g,'').split(/;\s*(?=CREATE\b)/).filter(s=>s.trim()))await db.prepare(sql).run();
 await db.prepare("INSERT INTO users(id,login,email,full_name) VALUES(1,'alice','alice@example.com','Alice Example'),(2,'bob','bob@example.com','')").run();
 await db.prepare("INSERT INTO workspaces(slug,artifact_namespace) VALUES('alice','merge-proof')").run();
 await db.prepare("INSERT INTO repositories(id,name,description,artifact_name,creator_id,creation_key,input_hash,state,created_at) VALUES(1,'project','','repo-11111111111111111111111111111111',1,'original','hash','ACTIVE','2026-10-14T00:00:00Z')").run();
 await db.prepare("INSERT INTO grants VALUES(1,1,'admin'),(1,2,'read')").run();
 await db.prepare("INSERT INTO discussions(id,repository_id,number,kind,author_id,title,body,state,created_at,updated_at) VALUES(1,1,1,'pull',1,'Feature','','OPEN','2026-10-14T00:00:00Z','2026-10-14T00:00:00Z'),(2,1,2,'pull',1,'Other','','OPEN','2026-10-14T00:00:00Z','2026-10-14T00:00:00Z')").run();
 await db.prepare("INSERT INTO pull_requests(id,discussion_id,base_branch,head_branch,base_commit,head_commit,draft) VALUES(1,1,'main','feature',?,?,0),(2,2,'main','other',?,?,0)").bind(base,head,base,other).run();
 const key={owner:'alice',name:'project'};
 const rpc=async(service,method,body={},person='alice',status=200)=>{
  const response=await runtime.dispatchFetch(origin+'/rpc/golf.v1.'+service+'/'+method,{method:'POST',headers:{'Content-Type':'application/json','Connect-Protocol-Version':'1','X-Golf-Native-Access-Email':person+'@example.com',Origin:origin},body:JSON.stringify(body)});
  assert.equal(response.status,status,await response.clone().text());return response.json();
 };
 const pull=async number=>(await rpc('RepositoryService','GetPullRequest',{repository:key,number})).pullRequest;
 const intent=(pr,changes={})=>({selection:{repository:key,repositoryId:'1',pullRequestId:pr.id,number:pr.number,baseCommitId:pr.base.commitId,headCommitId:pr.head.commitId},ownerId:'1',expectedPullRevision:pr.revision,operationId:crypto.randomUUID(),sourceRef:pr.head.ref,targetRef:'main',...changes});
 const observe=async pr=>(await rpc('PullMergeObservationService','GetPullRequestMergeObservation',{selection:intent(pr).selection,expectedPullRevision:pr.revision})).observation;
 const first=await pull(1);assert.equal((await observe(first)).nativeCallerCanMerge,true);
 await rpc('StandardPullMergeService','SubmitStandardPullMerge',intent(first),'bob',404);assert.equal(pushes,0);
 const input=intent(first,{commitTitle:'Merge feature',commitMessage:'Built in workerd.'}),merged=(await rpc('StandardPullMergeService','SubmitStandardPullMerge',input)).operation;
 assert.equal(merged.phase,'STANDARD_PULL_MERGE_PHASE_SUCCEEDED');assert.equal(merged.actualBaseCommitId,base);assert.equal(pushes,1);
 // Real Git holds exactly the commit the Worker computed, on the base branch, with the head tree and both parents.
 assert.equal(text(['rev-parse','refs/heads/main']),merged.mergeCommitId);
 assert.equal(text(['rev-parse','refs/heads/main^{tree}']),text(['rev-parse','refs/heads/feature^{tree}']));
 assert.equal(text(['log','-1','--format=%an <%ae>|%cn <%ce>|%P|%B','refs/heads/main']),`Alice Example <alice@users.noreply.golf.example.com>|Alice Example <alice@users.noreply.golf.example.com>|${base} ${head}|Merge feature\n\nBuilt in workerd.`);
 git(['fsck','--strict','--full','--no-dangling']);
 assert.deepEqual((await rpc('StandardPullMergeService','SubmitStandardPullMerge',input)).operation,merged);
 assert.deepEqual((await rpc('StandardPullMergeService','GetStandardPullMergeOperation',{repository:key,repositoryId:'1',ownerId:'1',pullRequestId:'1',number:1,operationId:input.operationId})).operation,merged);
 assert.equal(pushes,1);
 assert.deepEqual(await db.prepare('SELECT state,ci_state,old_sha,new_sha FROM git_operations').first(),{state:'APPLIED',ci_state:'NONE',old_sha:base,new_sha:merged.mergeCommitId});
 assert.equal((await db.prepare('SELECT write_pending FROM repositories').first()).write_pending,null);
 const closed=await pull(1);assert.equal(closed.merged,true);assert.equal(closed.mergeCommitId,merged.mergeCommitId);assert.equal(closed.base.commitId,base);assert.equal(closed.mergeBaseCommitId,base);
 // The second proposal's base now has a commit its head lacks: refused before any write, on real D1.
 const second=await pull(2),blocked=await observe(second);assert.equal(second.base.commitId,merged.mergeCommitId);
 assert.equal(blocked.nativeCallerCanMerge,false);assert.equal(blocked.unavailableReason,'native_base_not_ancestor');
 const refused=(await rpc('StandardPullMergeService','SubmitStandardPullMerge',intent(second))).operation;
 assert.equal(refused.phase,'STANDARD_PULL_MERGE_PHASE_REJECTED');assert.equal(refused.failureCode,'preflight_refused');assert.equal(pushes,1);assert.equal(text(['rev-parse','refs/heads/main']),merged.mergeCommitId);
 assert.equal((await db.prepare("SELECT detail FROM pull_merge_operations WHERE phase='REJECTED'").first()).detail,'base_not_ancestor');
 // D1 itself enforces one unresolved operation per pull request and a single success.
 const add=phase=>db.prepare("INSERT INTO pull_merge_operations(actor_id,operation_id,repository_id,pull_request_id,input_hash,original,phase,created_at,updated_at) VALUES(1,?,1,2,'hash','{}',?,'t','t')").bind(crypto.randomUUID(),phase).run();
 await add('DISPATCH_UNKNOWN');await assert.rejects(add('RESERVED'));await assert.rejects(add('DISPATCH_UNKNOWN'));
 await assert.rejects(db.prepare("INSERT INTO pull_merge_operations(actor_id,operation_id,repository_id,pull_request_id,input_hash,original,phase,created_at,updated_at) VALUES(1,'again',1,1,'hash','{}','SUCCEEDED','t','t')").run());
 console.log('Real workerd/D1 native merge: pack built in workerd, received and verified by real Git; replay, refusal and uniqueness passed');
} finally {await runtime.dispose();rmSync(root,{recursive:true,force:true});}
