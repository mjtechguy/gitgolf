// Actual workerd/D1 merge transactions against a real local Git repository; only the Artifacts binding is a fixture.
// The pack is built inside workerd and received by `git receive-pack`, the program a smart-HTTP server runs.
// Diverged merges and squashes are checked against `git merge-tree --write-tree` in a separate witness repository.
//
//   node cloudflare/forge/merge-runtime-check.mjs "$(command -v cf)"
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
const read=async (kind,hash)=>{const response=await fetch('https://fixture.invalid/'+kind+'/'+hash);return response.ok?response.json():null;};
export default {fetch(request,env) {
 const fixture={...env,ARTIFACTS:{async get(name){return {async info(){return {name,remote:remote(env,name)};},async createToken(){return {plaintext:'local-only-token'};},async revokeToken(){return true;},
  async readCommit(hash){return read('commit',hash);},async readTree(hash){return read('tree',hash);},[Symbol.dispose](){}};}}};
 return handle(request,fixture);
}};`},bundle:true,write:false,format:'esm',platform:'neutral'});
const root=mkdtempSync(join(tmpdir(),'golf-merge-runtime-')),directory=join(root,'project.git'),witness=join(root,'witness.git'),origin='https://golf.example.com';
const gitEnv={PATH:process.env.PATH,HOME:root,GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null',GIT_AUTHOR_NAME:'Fixture',GIT_AUTHOR_EMAIL:'fixture@example.invalid',GIT_COMMITTER_NAME:'Fixture',GIT_COMMITTER_EMAIL:'fixture@example.invalid'};
const git=(args,input,dir=directory)=>execFileSync('git',['--git-dir',dir,...args],{env:gitEnv,input,stdio:['pipe','pipe','pipe']}),text=(...args)=>git(...args).toString().trim();
for(const dir of [directory,witness])execFileSync('git',['init','--bare','--quiet','--initial-branch=main',dir],{env:gitEnv});
let indexes=0;
const tree=files=>{const index=join(root,'index-'+indexes++);
 execFileSync('git',['--git-dir',directory,'update-index','--add','--index-info'],{env:{...gitEnv,GIT_INDEX_FILE:index},input:Object.entries(files).map(([name,content])=>`100644 ${text(['hash-object','-w','--stdin'],content)}\t${name}\n`).join('')});
 return execFileSync('git',['--git-dir',directory,'write-tree'],{env:{...gitEnv,GIT_INDEX_FILE:index}}).toString().trim();};
const start={'readme.txt':'base\n'},base=text(['commit-tree',tree(start),'-m','Base']),branch=(files,message)=>text(['commit-tree',tree({...start,...files}),'-p',base,'-m',message]);
// Proposals from the same base: the first contains the base tip; later ones diverge once main moves.
const proposals=[['feature',{'feature.txt':'change\n'}],['other',{'other.txt':'other\n'}],['squashed',{'docs/guide/intro.md':'intro\n','readme.txt':'base\n'}],
 ['clash',{'feature.txt':'clash\n','docs/guide/intro.md':'clash\n'}],['late-merge',{'late/merge.txt':'merge\n'}],['late-squash',{'late/squash.txt':'squash\n'}]].map(([name,files])=>[name,branch(files,name)]);
git(['update-ref','refs/heads/main',base]);for(const [name,commit] of proposals)git(['update-ref','refs/heads/'+name,commit]);
// The tree real Git writes for a merge, computed in a repository the Worker never reads or writes.
const witnessFetch=(...commits)=>{const fetched=spawnSync('git',['--git-dir',witness,'fetch','--quiet','--no-write-fetch-head',directory,...commits.map((commit,index)=>`+${commit}:refs/witness/${index}`)],{env:gitEnv});assert.equal(fetched.status,0,fetched.stderr.toString());};
const gitMerge=(ours,theirs)=>{witnessFetch(ours,theirs);return text(['merge-tree','--write-tree',ours,theirs],undefined,witness);};
const types={'040000':'tree','100644':'blob','100755':'exec','120000':'symlink','160000':'gitlink'};
let pushes=0,hold=null;
const receive=body=>spawnSync('git',['receive-pack','--stateless-rpc',directory],{env:gitEnv,input:body});
const runtime=new Miniflare(convertV4MiniflareOptions({modules:true,script:bundle.outputFiles[0].text,compatibilityDate:'2026-10-08',d1Databases:{DB:'merges'},
 bindings:{PUBLIC_ORIGIN:origin,WORKSPACE_SLUG:'alice',ARTIFACTS_NAMESPACE:'merge-proof',ACCOUNT_ID:'a'.repeat(32)},
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
  assert.equal(url.pathname.split('/').slice(0,4).join('/'),'/git/merge-proof/repo-11111111111111111111111111111111.git');assert.equal(request.headers.get('Authorization'),'Bearer local-only-token');
  if(request.method==='GET'&&url.pathname.endsWith('/info/refs')&&url.search==='?service=git-upload-pack')
   return new Response(Buffer.concat([packetLine('# service=git-upload-pack\n'),Buffer.from('0000'),execFileSync('git',['upload-pack','--stateless-rpc','--advertise-refs',directory],{env:gitEnv})]),{headers:{'Content-Type':'application/x-git-upload-pack-advertisement'}});
  assert.equal(request.method,'POST');assert.ok(url.pathname.endsWith('/git-receive-pack'));assert.equal(request.headers.get('Content-Type'),'application/x-git-receive-pack-request');pushes++;
  const body=Buffer.from(await request.arrayBuffer());
  // A held push reaches Git only later: the Worker sees a provider failure and an unknown outcome.
  if(hold) {hold.body=body;return new Response('unavailable',{status:503});}
  const received=receive(body);
  return new Response(received.stdout,{headers:{'Content-Type':'application/x-git-receive-pack-result'}});
 }}));
try {
 const db=await runtime.getD1Database('DB');
 for(const sql of (await readFile(new URL('./schema.sql',import.meta.url),'utf8')).replace(/--[^\n]*/g,'').split(/;\s*(?=CREATE\b)/).filter(s=>s.trim()))await db.prepare(sql).run();
 await db.prepare("INSERT INTO users(id,login,email,full_name) VALUES(1,'alice','alice@example.com','Alice Example'),(2,'bob','bob@example.com','')").run();
 await db.prepare("INSERT INTO workspaces(slug,artifact_namespace) VALUES('alice','merge-proof')").run();
 await db.prepare("INSERT INTO repositories(id,name,description,artifact_name,creator_id,creation_key,input_hash,state,created_at) VALUES(1,'project','','repo-11111111111111111111111111111111',1,'original','hash','ACTIVE','2026-10-14T00:00:00Z')").run();
 await db.prepare("INSERT INTO grants VALUES(1,1,'admin'),(1,2,'read')").run();
 for(const [index,[name,head]] of proposals.entries()) {
  await db.prepare("INSERT INTO discussions(id,repository_id,number,kind,author_id,title,body,state,created_at,updated_at) VALUES(?,1,?,'pull',1,?,'','OPEN','2026-10-14T00:00:00Z','2026-10-14T00:00:00Z')").bind(index+1,index+1,'Proposal '+name).run();
  await db.prepare("INSERT INTO pull_requests(id,discussion_id,base_branch,head_branch,base_commit,head_commit,draft) VALUES(?,?,'main',?,?,?,0)").bind(index+1,index+1,name,base,head).run();
 }
 const key={owner:'alice',name:'project'};
 const rpc=async(service,method,body={},person='alice',status=200)=>{
  const response=await runtime.dispatchFetch(origin+'/rpc/golf.v1.'+service+'/'+method,{method:'POST',headers:{'Content-Type':'application/json','Connect-Protocol-Version':'1','X-Golf-Native-Access-Email':person+'@example.com',Origin:origin},body:JSON.stringify(body)});
  assert.equal(response.status,status,await response.clone().text());return response.json();
 };
 const pull=async number=>(await rpc('RepositoryService','GetPullRequest',{repository:key,number})).pullRequest;
 const intent=(pr,changes={})=>({selection:{repository:key,repositoryId:'1',pullRequestId:pr.id,number:pr.number,baseCommitId:pr.base.commitId,headCommitId:pr.head.commitId},ownerId:'1',expectedPullRevision:pr.revision,operationId:crypto.randomUUID(),sourceRef:pr.head.ref,targetRef:'main',...changes});
 const observe=async pr=>(await rpc('PullMergeObservationService','GetPullRequestMergeObservation',{selection:intent(pr).selection,expectedPullRevision:pr.revision})).observation;
 const submit=async input=>(await rpc('StandardPullMergeService','SubmitStandardPullMerge',input)).operation;
 const inspect=async (input,pr)=>(await rpc('StandardPullMergeService','GetStandardPullMergeOperation',{repository:key,repositoryId:'1',ownerId:'1',pullRequestId:pr.id,number:pr.number,operationId:input.operationId})).operation;
 // Replay and inspection return the original receipt and never send another pack.
 const replayed=async (input,pr,operation)=>{const before=pushes;assert.deepEqual(await submit(input),operation);assert.deepEqual(await inspect(input,pr),operation);assert.equal(pushes,before);};
 const author='Alice Example <alice@users.noreply.golf.example.com>';

 // 1. The head contains the base tip: a merge commit with the head tree.
 const first=await pull(1);assert.equal((await observe(first)).nativeCallerCanMerge,true);
 await rpc('StandardPullMergeService','SubmitStandardPullMerge',intent(first),'bob',404);assert.equal(pushes,0);
 const input=intent(first,{commitTitle:'Merge feature',commitMessage:'Built in workerd.'}),merged=await submit(input);
 assert.equal(merged.phase,'STANDARD_PULL_MERGE_PHASE_SUCCEEDED');assert.equal(merged.actualBaseCommitId,base);assert.equal(pushes,1);
 // Real Git holds exactly the commit the Worker computed, on the base branch, with the head tree and both parents.
 assert.equal(text(['rev-parse','refs/heads/main']),merged.mergeCommitId);
 assert.equal(text(['rev-parse','refs/heads/main^{tree}']),text(['rev-parse','refs/heads/feature^{tree}']));
 assert.equal(text(['log','-1','--format=%an <%ae>|%cn <%ce>|%P|%B','refs/heads/main']),`${author}|${author}|${base} ${proposals[0][1]}|Merge feature\n\nBuilt in workerd.`);
 git(['fsck','--strict','--full','--no-dangling']);
 await replayed(input,first,merged);
 assert.deepEqual(await db.prepare('SELECT state,ci_state,old_sha,new_sha FROM git_operations').first(),{state:'APPLIED',ci_state:'NONE',old_sha:base,new_sha:merged.mergeCommitId});
 assert.equal((await db.prepare('SELECT write_pending FROM repositories').first()).write_pending,null);
 const closed=await pull(1);assert.equal(closed.merged,true);assert.equal(closed.mergeCommitId,merged.mergeCommitId);assert.equal(closed.base.commitId,base);assert.equal(closed.mergeBaseCommitId,base);

 // 2. Diverged: main now has a commit the head lacks. A three-way tree merge gives Git's own merged tree and both parents.
 const second=await pull(2),open=await observe(second);assert.equal(second.base.commitId,merged.mergeCommitId);
 assert.equal(open.nativeCallerCanMerge,true);assert.equal(open.mergeConfiguration.allowMergeCommits,true);assert.equal(open.mergeConfiguration.allowSquashMerge,true);assert.equal(open.mergeConflicts,undefined);
 const expected2=gitMerge(merged.mergeCommitId,proposals[1][1]);
 const input2=intent(second),diverged=await submit(input2);
 assert.equal(diverged.phase,'STANDARD_PULL_MERGE_PHASE_SUCCEEDED');assert.equal(diverged.actualBaseCommitId,merged.mergeCommitId);assert.equal(pushes,2);
 assert.equal(text(['rev-parse','refs/heads/main']),diverged.mergeCommitId);
 assert.equal(text(['rev-parse','refs/heads/main^{tree}']),expected2);
 assert.equal(text(['log','-1','--format=%P|%B','refs/heads/main']),`${merged.mergeCommitId} ${proposals[1][1]}|Merge pull request #2 from other into main`);
 git(['fsck','--strict','--full','--no-dangling']);
 await replayed(input2,second,diverged);
 assert.equal((await pull(2)).mergeBaseCommitId,base);

 // 3. Squash of a diverged head: one commit, main as its only parent, Git's merged tree, the pull request title by default.
 const third=await pull(3),expected3=gitMerge(diverged.mergeCommitId,proposals[2][1]);
 // The served repository lacks the merged trees, so receive-pack's connectivity check proves the pack carried them.
 assert.notEqual(spawnSync('git',['--git-dir',directory,'cat-file','-e',expected3],{env:gitEnv}).status,0);
 const input3=intent(third,{method:'squash'}),squashed=await submit(input3);
 assert.equal(squashed.phase,'STANDARD_PULL_MERGE_PHASE_SUCCEEDED');assert.equal(squashed.method,'squash');assert.equal(pushes,3);
 assert.equal(text(['rev-parse','refs/heads/main']),squashed.mergeCommitId);assert.equal(text(['rev-parse','refs/heads/main^{tree}']),expected3);
 assert.equal(text(['log','-1','--format=%an <%ae>|%P|%B','refs/heads/main']),`${author}|${diverged.mergeCommitId}|Proposal squashed (#3)`);
 assert.equal(text(['show','refs/heads/main:docs/guide/intro.md']),'intro');
 git(['fsck','--strict','--full','--no-dangling']);
 await replayed(input3,third,squashed);
 assert.equal((await pull(3)).merged,true);

 // 4. Conflicts: a file both sides added differently. Observation and refusal list the path; nothing is sent.
 const fourth=await pull(4),blocked=await observe(fourth);
 assert.equal(blocked.nativeCallerCanMerge,false);assert.equal(blocked.unavailableReason,'native_merge_conflict');
 const conflicts=[{path:'docs/guide/intro.md',reason:'both_added'},{path:'feature.txt',reason:'both_added'}];
 assert.deepEqual(blocked.mergeConflicts,conflicts);assert.equal(blocked.mergeConflictCount,2);
 witnessFetch(squashed.mergeCommitId,proposals[3][1]);
 const report=spawnSync('git',['--git-dir',witness,'merge-tree','--write-tree','--name-only','--no-messages',squashed.mergeCommitId,proposals[3][1]],{env:gitEnv});
 assert.equal(report.status,1);assert.deepEqual(report.stdout.toString().trim().split('\n').slice(1),conflicts.map(c=>c.path));
 for(const method of ['merge','squash']) {
  const refusedInput=intent(fourth,{method}),refused=await submit(refusedInput);
  assert.equal(refused.phase,'STANDARD_PULL_MERGE_PHASE_REJECTED');assert.equal(refused.failureCode,'preflight_refused');assert.equal(refused.refusalCode,'merge_conflict');
  assert.deepEqual(refused.conflicts,conflicts);assert.equal(refused.conflictCount,2);
  await replayed(refusedInput,fourth,refused);
 }
 assert.equal(pushes,3);assert.equal(text(['rev-parse','refs/heads/main']),squashed.mergeCommitId);
 assert.deepEqual((await db.prepare("SELECT DISTINCT detail FROM pull_merge_operations WHERE phase='REJECTED'").all()).results,[{detail:'merge_conflict'}]);

 // 5. Unknown outcomes: the provider fails before Git sees the push. The receipt stays unknown and fences merges until the
 // same request lands and the readback shows the expected parents and tree. The pack is never sent again.
 for(const [number,method] of [[5,'merge'],[6,'squash']]) {
  const pr=await pull(number),tip=pr.base.commitId,expected=gitMerge(tip,proposals[number-1][1]);
  hold={};const late=intent(pr,{method}),unknown=await submit(late),sent=pushes;
  assert.equal(unknown.phase,'STANDARD_PULL_MERGE_PHASE_DISPATCH_UNKNOWN');assert.equal(text(['rev-parse','refs/heads/main']),tip);
  const journal=await db.prepare('SELECT detail,original FROM pull_merge_operations WHERE operation_id=?').bind(late.operationId).first();
  assert.equal(journal.detail,'provider_error: Provider Git HTTP status 503.');assert.equal(JSON.parse(journal.original).expectedTreeId,expected);
  assert.equal((await observe(pr)).unavailableReason,'native_write_unresolved');
  assert.deepEqual(await inspect(late,pr),unknown);assert.deepEqual(await submit(late),unknown);assert.equal(pushes,sent);
  const held=hold.body;hold=null;
  assert.equal(receive(held).status,0);
  const settled=await inspect(late,pr);
  assert.equal(settled.phase,'STANDARD_PULL_MERGE_PHASE_SUCCEEDED');assert.equal(settled.mergeCommitId,text(['rev-parse','refs/heads/main']));assert.equal(settled.actualBaseCommitId,tip);
  assert.equal(text(['rev-parse','refs/heads/main^{tree}']),expected);
  assert.equal(text(['log','-1','--format=%P','refs/heads/main']),method==='squash'?tip:`${tip} ${proposals[number-1][1]}`);
  assert.equal((await db.prepare('SELECT write_pending FROM repositories').first()).write_pending,null);
  await replayed(late,pr,settled);assert.equal(pushes,sent);
 }
 git(['fsck','--strict','--full','--no-dangling']);
 assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM git_operations WHERE state='APPLIED'").first()).n,5);

 // D1 itself enforces one unresolved operation per pull request and a single success.
 const add=phase=>db.prepare("INSERT INTO pull_merge_operations(actor_id,operation_id,repository_id,pull_request_id,input_hash,original,phase,created_at,updated_at) VALUES(1,?,1,4,'hash','{}',?,'t','t')").bind(crypto.randomUUID(),phase).run();
 await add('DISPATCH_UNKNOWN');await assert.rejects(add('RESERVED'));await assert.rejects(add('DISPATCH_UNKNOWN'));
 await assert.rejects(db.prepare("INSERT INTO pull_merge_operations(actor_id,operation_id,repository_id,pull_request_id,input_hash,original,phase,created_at,updated_at) VALUES(1,'again',1,1,'hash','{}','SUCCEEDED','t','t')").run());
 console.log('Real workerd/D1 native merge: head-contains-base, diverged three-way merge and squash packs built in workerd, received and verified by real Git against git merge-tree; conflicts listed and refused; unknown outcomes settled by readback; replay, refusal and uniqueness passed');
} finally {await runtime.dispose();rmSync(root,{recursive:true,force:true});}
