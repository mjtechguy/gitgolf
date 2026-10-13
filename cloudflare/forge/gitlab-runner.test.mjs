import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFile } from 'node:fs/promises';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { digest } from './src/common.mjs';
import { gitLabRunner } from './src/gitlab-runner.mjs';
import { nativeRunnerAdmin, nativeRunnerPlacement } from './src/native-runners.mjs';
import { nativeWorkflow, nativeWorkflowContract } from './src/native-workflow.mjs';

async function fixture(t) {
  const sql = new DatabaseSync(':memory:'); t.after(() => sql.close());
  sql.exec(await readFile(new URL('./schema.sql',import.meta.url),'utf8'));
  sql.exec("INSERT INTO users(id,login,email) VALUES(1,'admin','admin@example.invalid'); INSERT INTO operations_admins(user_id) VALUES(1); INSERT INTO repositories(id,name,description,artifact_name,creator_id,creation_key,input_hash,state,created_at) VALUES(1,'project','','repo',1,'key','hash','ACTIVE','2026-10-12T00:00:00Z')");
  sql.prepare('UPDATE repositories SET artifact_name=? WHERE id=1').run('repo-'+'b'.repeat(32));
  const db = { prepare(query) { const statement = sql.prepare(query); let values = []; return {
    bind(...input) { values=input; return this; }, async first() { return statement.get(...values)||null; },
    async all() { return {results:statement.all(...values)}; }, async run() { return {meta:{changes:statement.run(...values).changes}}; },
  }; }, async batch(statements) { sql.exec('BEGIN'); try { const values=[]; for (const statement of statements) values.push(await statement.run()); sql.exec('COMMIT'); return values; } catch (error) { sql.exec('ROLLBACK'); throw error; } } };
  const env = { PUBLIC_ORIGIN:'https://golf.example.invalid', WORKSPACE_SLUG:'workspace', TEST_EXECUTION_ENABLED:'true', TEST_IMAGE_ID:'sha256:'+'a'.repeat(64), TEST_IMAGE_REF:'alpine:3.23@sha256:85fe1e81d6758c208f3e1eed4338a1997e19d4be002d4dd32d3100c9a8c010a0', ACCOUNT_ID:'a'.repeat(32), ARTIFACTS_NAMESPACE:'golf-tests' };
  const admin = new Request(env.PUBLIC_ORIGIN+'/native/runner-admin',{headers:{'X-Golf-Native-Access-Email':'admin@example.invalid'}});
  const call = async body => (await nativeRunnerAdmin(db,env,{id:1,email:'admin@example.invalid'},admin,body)).json();
  const poolId=crypto.randomUUID(), machineId=crypto.randomUUID(), jobId=crypto.randomUUID();
  await call({action:'savePool',id:poolId,expectedVersion:0,name:'gitlab',state:'ACTIVE',trustClass:'UNTRUSTED',maxParallel:1});
  const enrolled=await call({action:'enrollGitLab',id:machineId,poolId,poolVersion:1,name:'runner',ttlHours:1,trustExecution:true});
  assert.match(enrolled.credential,/^glrt-[a-f0-9-]{36}_[a-f0-9]{64}$/);
  await nativeRunnerPlacement(db,env,{id:1,role:'admin'},{action:'set',repository:{owner:'workspace',name:'project'},repositoryId:'1',expectedVersion:0,poolId,poolVersion:1});
  const workflow={path:'.gitlab-ci.yml',blobId:'f'.repeat(40),plan:nativeWorkflow('gitlab','check:\n  script: echo ok\n')};
  const execution={contract:nativeWorkflowContract,commitId:'a'.repeat(40),treeId:'b'.repeat(40),branch:'feature',workflow,
    workflowSha256:await digest(JSON.stringify(workflow)),policySha256:'c'.repeat(64),runner:{poolId,poolVersion:1,placementVersion:1,imageId:env.TEST_IMAGE_ID}};
  const stamp=new Date().toISOString();
  sql.prepare("INSERT INTO evidence_jobs(id,repository_id,user_id,operation_key,input_hash,snapshot,advice_state,created_at,updated_at,expires_at,test_state) VALUES(?,1,1,'job','hash',?,'NONE',?,?,?,'REQUESTED')")
    .run(jobId,JSON.stringify({execution}),stamp,stamp,new Date(Date.now()+600000).toISOString());
  const invoke=(path,method,body,headers={},git=()=>assert.fail('Unexpected Git request'),authorize=async()=>true) => gitLabRunner(db,env,new Request(env.PUBLIC_ORIGIN+path,{method,headers,
    ...(body===undefined?{}:{body:typeof body==='string'?body:JSON.stringify(body)})}),authorize,git);
  return {sql,db,env,invoke,credential:enrolled.credential,jobId,machineId};
}

test('stock GitLab coordinator exchanges bind runner, job, trace and completion',async t=>{
  const f=await fixture(t), headers={'Content-Type':'application/json'};
  const verify=await f.invoke('/api/v4/runners/verify','POST',{token:f.credential,system_id:'s_12345678'},headers);
  assert.equal(verify.status,200);
  await assert.rejects(f.invoke('/api/v4/jobs/request','POST',{token:f.credential,system_id:'s_12345678',info:{version:'18.5.0',executor:'shell'}},headers),/Docker executor/);
  f.sql.prepare('UPDATE native_runner_machines SET expires_at=? WHERE id=?').run(Date.now()+60000,f.machineId);
  assert.equal((await f.invoke('/api/v4/jobs/request','POST',{token:f.credential,system_id:'s_12345678',info:{version:'18.5.0',executor:'docker'}},headers)).status,204);
  f.sql.prepare('UPDATE native_runner_machines SET expires_at=? WHERE id=?').run(Date.now()+3600000,f.machineId);
  const claimed=await f.invoke('/api/v4/jobs/request','POST',{token:f.credential,system_id:'s_12345678',info:{version:'18.5.0',executor:'docker'}},headers);
  assert.equal(claimed.status,201);
  const job=await claimed.json();
  assert.equal(job.git_info.sha,'a'.repeat(40)); assert.equal(job.steps[0].script[0],'echo ok');
  assert.ok(f.sql.prepare('SELECT lease_expires_at FROM native_runner_machines WHERE id=?').get(f.machineId).lease_expires_at > Date.now()+5*60000);
  assert.equal((await f.invoke('/api/v4/jobs/request','POST',{token:f.credential,system_id:'s_12345678',info:{version:'18.5.0',executor:'docker'}},headers)).status,204);
  const id=job.id, token=job.token;
  await assert.rejects(f.invoke(`/api/v4/jobs/${id}/trace?debug_trace=false`,'PATCH','ok\n',{'Content-Range':'0-2','Job-Token':'wrong'}),/authority ended/);
  await assert.rejects(f.invoke(`/api/v4/jobs/${id}/trace?debug_trace=false`,'PATCH','ok\n',{'Content-Range':'0-2','Job-Token':token},undefined,async()=>false),/authority ended/);
  f.sql.prepare('UPDATE operations_admins SET active=0 WHERE user_id=1').run();
  await assert.rejects(f.invoke(`/api/v4/jobs/${id}/trace?debug_trace=false`,'PATCH','ok\n',{'Content-Range':'0-2','Job-Token':token}),/authority ended/);
  f.sql.prepare('UPDATE operations_admins SET active=1 WHERE user_id=1').run();
  const trace=await f.invoke(`/api/v4/jobs/${id}/trace?debug_trace=false`,'PATCH','ok\n',{'Content-Range':'0-2','Job-Token':token});
  assert.equal(trace.status,202);
  assert.ok(f.sql.prepare('SELECT lease_expires_at FROM native_runner_machines WHERE id=?').get(f.machineId).lease_expires_at > Date.now()+5*60000);
  assert.equal((await f.invoke(`/api/v4/jobs/${id}/trace?debug_trace=false`,'PATCH','ok\n',{'Content-Range':'0-2','Job-Token':token})).status,416);
  const got=await f.invoke(`/api/v4/jobs/${id}/git/info/refs?service=git-upload-pack`,'GET',undefined,{Authorization:'Basic '+btoa('gitlab-ci-token:'+token)},(jobId,source)=>{
    assert.equal(jobId,f.jobId); assert.equal(source.headers.has('Authorization'),false); return new Response('git-ok');
  });
  assert.equal(await got.text(),'git-ok');
  const running=await f.invoke(`/api/v4/jobs/${id}`,'PUT',{token,state:'running'}, {...headers,'Job-Token':token});
  assert.equal(running.status,200);
  await assert.rejects(f.invoke(`/api/v4/jobs/${id}`,'PUT',{token,state:'success',exit_code:1},{...headers,'Job-Token':token}),/Invalid job update state/);
  const done=await f.invoke(`/api/v4/jobs/${id}`,'PUT',{token,state:'success',exit_code:0},{...headers,'Job-Token':token});
  assert.equal(done.status,200);
  const result=JSON.parse(f.sql.prepare('SELECT test_result FROM evidence_jobs WHERE id=?').get(f.jobId).test_result);
  assert.equal(result.state,'PASSED'); assert.equal(result.stdout,'ok\n'); assert.equal(result.producer.machineId,f.machineId);
  assert.equal(f.sql.prepare('SELECT active_job_id FROM native_runner_machines WHERE id=?').get(f.machineId).active_job_id,null);
  assert.equal((await f.invoke(`/api/v4/jobs/${id}`,'PUT',{token,state:'success',exit_code:0},{...headers,'Job-Token':token})).status,200);
  await assert.rejects(f.invoke(`/api/v4/jobs/${id}`,'PUT',{token,state:'failed',exit_code:1},{...headers,'Job-Token':token}),/authority ended/);
});

test('pinned stock GitLab Runner registers and executes through the coordinator', { skip: !process.env.GOLF_TEST_GITLAB_RUNNER }, async t => {
  const f=await fixture(t), binary=process.env.GOLF_TEST_GITLAB_RUNNER, directory=await mkdtemp(join(tmpdir(),'golf-gitlab-runner-'));
  t.after(()=>rm(directory,{recursive:true,force:true}));
  const source=join(directory,'source'), bare=join(directory,'project.git');
  await mkdir(source); await writeFile(join(source,'.gitlab-ci.yml'),'check:\n  script:\n    - test "$(cat probe.txt)" = exact\n    - test -z "${CI_JOB_TOKEN:-}"\n    - "! git config --get remote.origin.url | grep -q gitlab-ci-token"\n');
  await writeFile(join(source,'probe.txt'),'exact\n');
  const gitCommand=(...args)=>execFileSync('git',args,{encoding:'utf8'}).trim();
  gitCommand('-C',source,'init','-b','feature'); gitCommand('-C',source,'add','.');
  execFileSync('git',['-C',source,'-c','user.name=Golf Test','-c','user.email=golf@example.invalid','commit','-m','test']);
  gitCommand('clone','--bare',source,bare);
  const commit=gitCommand('-C',source,'rev-parse','HEAD'),tree=gitCommand('-C',source,'rev-parse','HEAD^{tree}'),blob=gitCommand('-C',source,'rev-parse','HEAD:.gitlab-ci.yml');
  const row=f.sql.prepare('SELECT snapshot FROM evidence_jobs WHERE id=?').get(f.jobId), snapshot=JSON.parse(row.snapshot);
  snapshot.execution.commitId=commit; snapshot.execution.treeId=tree; snapshot.execution.workflow.blobId=blob;
  snapshot.execution.workflow.plan=nativeWorkflow('gitlab','check:\n  script:\n    - test "$(cat probe.txt)" = exact\n    - test -z "${CI_JOB_TOKEN:-}"\n    - "! git config --get remote.origin.url | grep -q gitlab-ci-token"\n');
  snapshot.execution.workflowSha256=await digest(JSON.stringify(snapshot.execution.workflow));
  f.sql.prepare('UPDATE evidence_jobs SET snapshot=? WHERE id=?').run(JSON.stringify(snapshot),f.jobId);
  const seen=[];
  const git=async (_jobId,request)=>{
    const url=new URL(request.url),body=Buffer.from(await request.arrayBuffer());
    const result=spawnSync('git',['http-backend'],{input:body,env:{...process.env,GIT_PROJECT_ROOT:directory,GIT_HTTP_EXPORT_ALL:'1',
      REQUEST_METHOD:request.method,PATH_INFO:'/project.git'+url.pathname.slice(url.pathname.indexOf('.git')+4),QUERY_STRING:url.search.slice(1),
      CONTENT_TYPE:request.headers.get('Content-Type')||'',CONTENT_LENGTH:String(body.length),HTTP_GIT_PROTOCOL:request.headers.get('Git-Protocol')||''}});
    if (result.error || result.status!==0) throw result.error||Error(result.stderr.toString());
    const end=result.stdout.indexOf('\r\n\r\n'); if(end<0) throw Error('Git CGI response missing headers');
    const headers=new Headers(); let status=200;
    for(const line of result.stdout.subarray(0,end).toString().split('\r\n')) {
      const colon=line.indexOf(':'); if(colon<0) continue;
      if(line.slice(0,colon).toLowerCase()==='status') status=Number(line.slice(colon+1).trim().split(' ')[0]);
      else headers.set(line.slice(0,colon),line.slice(colon+1).trim());
    }
    return new Response(result.stdout.subarray(end+4),{status,headers});
  };
  const server=createServer(async (req,res)=>{
    try {
      const chunks=[]; for await (const chunk of req) chunks.push(chunk);
      const target=new Request(f.env.PUBLIC_ORIGIN+req.url,{method:req.method,headers:req.headers,
        ...(chunks.length?{body:Buffer.concat(chunks)}:{})});
      const response=await gitLabRunner(f.db,f.env,target,async()=>true,git);
      seen.push([req.method,req.url,response.status]);
      res.writeHead(response.status,Object.fromEntries(response.headers)); res.end(Buffer.from(await response.arrayBuffer()));
    } catch (error) { seen.push([req.method,req.url,String(error)]); res.writeHead(error.status||500); res.end(String(error.message)); }
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise(resolve=>server.close(resolve)));
  f.env.PUBLIC_ORIGIN=`http://127.0.0.1:${server.address().port}`;
  const execute=(args,timeout=90000,completed=()=>false)=>new Promise((resolve,reject)=>{
    const child=spawn(binary,args,{cwd:directory,env:{...process.env,HOME:directory}});
    let output=''; child.stdout.on('data',chunk=>output+=chunk); child.stderr.on('data',chunk=>output+=chunk);
    const timer=setTimeout(()=>child.kill('SIGKILL'),timeout), poll=setInterval(()=>{if(completed()) child.kill('SIGTERM');},100);
    child.on('error',reject); child.on('close',code=>{clearTimeout(timer);clearInterval(poll);resolve({code,output});});
  });
  const registered=await execute(['register','--non-interactive','--config',join(directory,'config.toml'),'--url',f.env.PUBLIC_ORIGIN,
    '--token',f.credential,'--executor','docker','--docker-image',f.env.TEST_IMAGE_REF]);
  assert.equal(registered.code,0,registered.output);
  const run=await execute(['run-single','--url',f.env.PUBLIC_ORIGIN,'--token',f.credential,'--executor','docker',
    '--docker-image',f.env.TEST_IMAGE_REF,'--docker-network-mode','host','--output-limit','48','--limit','1'],60000,
    ()=>Boolean(f.sql.prepare('SELECT test_result FROM evidence_jobs WHERE id=?').get(f.jobId).test_result));
  const result=f.sql.prepare('SELECT test_result FROM evidence_jobs WHERE id=?').get(f.jobId);
  assert.equal(JSON.parse(result.test_result).state,'PASSED',run.output+'\n'+JSON.stringify(seen));
  assert.ok(seen.some(row=>row[1]==='/api/v4/runners/verify'));
  assert.ok(seen.some(row=>row[1]==='/api/v4/jobs/request' && row[2]===201));
  assert.ok(seen.some(row=>/^\/api\/v4\/jobs\/\d+\/trace/.test(row[1]) && row[2]===202));
  assert.ok(seen.some(row=>/\/git\/info\/refs/.test(row[1]) && row[2]===200));
  assert.ok(seen.some(row=>/^\/api\/v4\/jobs\/\d+$/.test(row[1]) && row[2]===200));
});
