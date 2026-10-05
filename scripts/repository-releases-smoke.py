#!/usr/bin/env python3
"""Prepared bounded releases read proof on an externally owned fresh stack.
Never starts/builds/pulls/stops services. Two ordinary managed actors, two native
releases, independent exact list/detail reads, then native reader removal.
Optional --browser captures eight actual read-only views. No asset/download,
snapshot/publication, provider or full repository readiness claim.
"""
import argparse
from datetime import datetime
import importlib.util
import json
from pathlib import Path
import re
import secrets
import subprocess
import sys
import time
sys.dont_write_bytecode=True
LIST='RepositoryService/ListRepositoryReleases'
GET='RepositoryService/GetRepositoryRelease'
FIELDS={'id','title','tagName','targetCommitish','bodyMarkdown','draft','prerelease','createdAt','publishedAt','author','assets','assetCount'}

def load_common(stack):
 spec=importlib.util.spec_from_file_location('release_native_helpers',stack/'scripts/pull-merge-observation-smoke.py')
 module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
 module.RPC_PROCEDURES=module.RPC_PROCEDURES|frozenset((LIST,GET))
 return module

def allowed(method,path,prefix):
 if method=='GET' and path in ('user','version'):return True
 if method=='GET' and re.fullmatch('users/'+re.escape(prefix)+r'-(owner|reader)',path):return True
 if method=='POST' and path=='user/repos':return True
 base='repos/'+re.escape(prefix)+r'-owner/private'
 if re.fullmatch(base,path):return method in ('GET','DELETE')
 if re.fullmatch(base+r'/collaborators/'+re.escape(prefix)+r'-reader',path):return method in ('PUT','DELETE')
 if re.fullmatch(base+r'/releases',path):return method in ('GET','POST')
 return method=='GET' and re.fullmatch(base+r'/releases/[1-9][0-9]*',path) is not None

def release_receipt(common,row,native):
 assert set(row)<=FIELDS and common.decimal(row['id']) and row['id']==str(native['id'])
 mapping={'title':'name','tagName':'tag_name','targetCommitish':'target_commitish','bodyMarkdown':'body','createdAt':'created_at','publishedAt':'published_at'}
 for wire,key in mapping.items():assert row.get(wire,'')==native[key]
 for field in ('draft','prerelease'):assert row.get(field,False)==native[field]
 for field in ('createdAt','publishedAt'):datetime.fromisoformat(row[field].replace('Z','+00:00'))
 assert row['author']['id']==str(native['author']['id']) and row['author']['login']==native['author']['login']
 assert row['author'].get('fullName','')==native['author'].get('full_name','') and row['author'].get('avatarUrl','')==native['author'].get('avatar_url','')
 assert native['assets']==[] and row.get('assets',[])==[] and row['assetCount']=='0'
 return row

def bound_response(row,target):
 assert row['repository']==target['repository'] and row['repositoryId']==target['repositoryId']
 return row

def self_check(stack):
 common=load_common(stack);prefix='golf-mergeobs-'+'a'*10
 for method,path in [('POST','user/repos'),('GET','repos/'+prefix+'-owner/private/releases'),('POST','repos/'+prefix+'-owner/private/releases'),('DELETE','repos/'+prefix+'-owner/private/collaborators/'+prefix+'-reader')]:assert allowed(method,path,prefix)
 for method,path in [('POST','repos/foreign/private/releases'),('POST','repos/'+prefix+'-owner/private/pulls/1/merge'),('GET','repos/'+prefix+'-owner/private/releases/1/assets'),('PATCH','repos/'+prefix+'-owner/private/releases/1')]:assert not allowed(method,path,prefix)
 native={'id':12,'name':'Owned release','tag_name':'v1','target_commitish':'main','body':'Controlled notes','draft':False,'prerelease':True,'created_at':'2026-10-04T00:00:00Z','published_at':'2026-10-04T00:00:00Z','author':{'id':7,'login':'owned','full_name':'','avatar_url':''},'assets':[]}
 row={'id':'12','title':native['name'],'tagName':'v1','targetCommitish':'main','bodyMarkdown':native['body'],'prerelease':True,'createdAt':native['created_at'],'publishedAt':native['published_at'],'author':{'id':'7','login':'owned'},'assetCount':'0'}
 release_receipt(common,row,native)
 for change in ({'id':'13'},{'tagName':'wrong'},{'bodyMarkdown':'changed'},{'publishedAt':'wrong'},{'downloadUrl':'https://outside.invalid'},{'author':{'id':'8','login':'owned'}}):
  try:release_receipt(common,row|change,native)
  except (AssertionError,ValueError):pass
  else:raise AssertionError('Changed release receipt accepted')
 print('PASS: pure native scope and exact release metadata tamper checks; no resources')

def main():
 p=argparse.ArgumentParser(description=__doc__)
 p.add_argument('--self-check',action='store_true');p.add_argument('--stack-root',type=Path,default=Path(__file__).resolve().parents[1]);p.add_argument('--project');p.add_argument('--compose-file',type=Path);p.add_argument('--env-file',type=Path);p.add_argument('--image');p.add_argument('--source-revision');p.add_argument('--golf-url');p.add_argument('--native-url');p.add_argument('--output',type=Path);p.add_argument('--browser',action='store_true')
 args=p.parse_args();stack=args.stack_root.resolve();common=load_common(stack)
 if args.self_check:return self_check(stack)
 assert all((args.project,args.compose_file,args.env_file,args.image,args.source_revision,args.golf_url,args.native_url,args.output))
 assert re.fullmatch('golf-mergeobs-[a-f0-9]{10}',args.project) and re.fullmatch('sha256:[a-f0-9]{64}',args.image) and re.fullmatch('[a-f0-9]{40}',args.source_revision)
 golf,native=common.loopback(args.golf_url),common.loopback(args.native_url)
 assert args.compose_file.is_file() and args.env_file.is_file()
 output=args.output.resolve();output.mkdir(mode=0o700,parents=True,exist_ok=False);output.chmod(0o700)
 compose=['docker','compose','--project-directory',str(stack),'-p',args.project,'-f',str(args.compose_file.resolve()),'--env-file',str(args.env_file.resolve())]
 prefix='golf-mergeobs-'+secrets.token_hex(5);actors={};repos=[];failure=None;cleanup=[];native_unknown=False;stage='runtime preflight';forbidden=[]
 manifest={'status':'running','scope':'Two current native release metadata observations','project':args.project,'fixturePrefix':prefix,'limits':['No release write API/UI qualification','No asset download/URL authority','No immutable tag/source snapshot','Root owns stack disposal']}
 def persist():
  manifest['actors']=[{k:a[k] for k in ('name','id','created','enrolled') if k in a} for a in actors.values()]
  value=json.dumps(manifest,indent=2)+'\n';assert len(value)<1<<20 and all(v not in value for v in forbidden if v)
  temp=output/'manifest.next';temp.write_text(value);temp.chmod(0o600);temp.replace(output/'manifest.json')
 def command(argv,payload=None,timeout=60):
  result=subprocess.run(argv,cwd=stack,input=None if payload is None else json.dumps(payload),text=True,capture_output=True,timeout=timeout)
  assert result.returncode==0 and len(result.stdout)+len(result.stderr)<2<<20
  return result.stdout.strip()
 def admin(*parts):return command(compose+['exec','-T','gitea','gitea','--config','/etc/gitea/app.ini','admin','user',*parts])
 def operator(action,payload):
  result=json.loads(command(compose+['exec','-T','golf','/usr/local/bin/golf','local-account',action],payload));assert result['state']=='complete';return result['result']
 def rpc(actor,procedure,payload=None,status=200,code=None):
  result=common.request(actor['session'],'POST',golf+'/rpc/golf.v1.'+procedure,{} if payload is None else payload,{'Origin':golf,'Content-Type':'application/json','Connect-Protocol-Version':'1'},status)
  if status!=200:assert result['code']==code
  return result
 def api(actor,method,path,payload=None,status=200):
  nonlocal native_unknown
  assert allowed(method,path,prefix)
  if method not in ('GET','HEAD'):native_unknown=True
  result=common.request(common.client(),method,native+'/api/v1/'+path,payload,{'Content-Type':'application/json',**({'Authorization':'token '+actor['token']} if actor else {})},status)
  if method not in ('GET','HEAD'):native_unknown=False
  return result
 def runtime_now():
  cid=command(compose+['ps','-q','golf']);assert re.fullmatch('[a-f0-9]{64}',cid)
  fmt='{"id":{{json .Id}},"image":{{json .Image}},"project":{{json (index .Config.Labels "com.docker.compose.project")}},"service":{{json (index .Config.Labels "com.docker.compose.service")}},"running":{{json .State.Running}},"configHash":{{json (index .Config.Labels "com.docker.compose.config-hash")}}}'
  row=json.loads(command(['docker','inspect','--format',fmt,cid]));label=command(['docker','image','inspect','--format','{{index .Config.Labels "org.opencontainers.image.revision"}}',args.image])
  assert row['id']==cid and row['image']==args.image and row['project']==args.project and row['service']=='golf' and row['running'] and label==args.source_revision
  return {**row,'sourceRevision':label}
 try:
  persist();runtime=runtime_now();manifest['runtimeBefore']=runtime;persist();assert common.request(common.client(),'GET',golf+'/readyz',None,{},200);assert api(None,'GET','version')['version']=='1.27.3'
  stage='ordinary native actors and managed enrollment'
  for role in ('owner','reader'):
   name=prefix+'-'+role;actor={'name':name,'created':False,'enrolled':False,'loggedIn':False,'session':common.client()};actors[role]=actor
   api(None,'GET','users/'+name,status=404);native_unknown=True;admin('create','--username',name,'--email',name+'@example.invalid','--random-password','--must-change-password=false');actor['created']=True
   row=api(None,'GET','users/'+name);assert row['login']==name;actor['id']=str(row['id']);native_unknown=False;persist()
   actor['token']=admin('generate-access-token','--username',name,'--token-name',prefix,'--scopes','write:user,write:repository','--raw');forbidden.append(actor['token'])
   user=api(actor,'GET','user');assert user['id']==int(actor['id']) and user['is_admin'] is False
   actor.update(email=name+'@golf.invalid',password='Fixture '+secrets.token_urlsafe(24));forbidden.append(actor['password']);actor['enrolled']=True;operator('create',{'username':name,'email':actor['email'],'password':actor['password'],'forge_token':actor['token'],'is_instance_admin':False})
   assert rpc(actor,'SessionService/LoginWithPassword',{'username':actor['email'],'password':actor['password']})['user']['id']==actor['id'];actor['loggedIn']=True
  owner,reader=actors.values();stage='supported native published and prerelease fixtures'
  repo=api(owner,'POST','user/repos',{'name':'private','private':True,'auto_init':True},201);repos.append((owner,repo));repository={'owner':owner['name'],'name':'private'};path='repos/'+repo['full_name']
  assert repo['full_name']==owner['name']+'/private' and repo['owner']['id']==int(owner['id'])
  deadline=time.monotonic()+45
  while api(owner,'GET',path)['empty']:assert time.monotonic()<deadline;time.sleep(.25)
  api(owner,'PUT',path+'/collaborators/'+reader['name'],{'permission':'read'},204)
  releases=[]
  for number,prerelease in ((1,False),(2,True)):
   request={'tag_name':'v'+str(number)+'.0.0','target_commitish':repo['default_branch'],'name':'Owned '+('prerelease' if prerelease else 'published release'),'body':'Controlled release '+str(number)+' notes.\n\n**Native metadata observation.**','draft':False,'prerelease':prerelease}
   created=api(owner,'POST',path+'/releases',request,201);assert created['id']>0 and created['name']==request['name'] and created['tag_name']==request['tag_name'] and created['body']==request['body'] and created['draft'] is False and created['prerelease']==prerelease
   observed=api(owner,'GET',path+'/releases/'+str(created['id']));assert all(observed[k]==created[k] for k in ('id','name','tag_name','target_commitish','body','draft','prerelease','created_at','published_at','author','assets'));releases.append(observed)
  target={'repository':repository,'repositoryId':str(repo['id'])};native_rows=api(owner,'GET',path+'/releases');assert len(native_rows)==2 and {r['id'] for r in native_rows}=={r['id'] for r in releases}
  stage='current native list and detail identities'
  by_id={str(r['id']):r for r in releases}
  for actor in (owner,reader):
   response=bound_response(rpc(actor,LIST,target|{'page':{'page':1,'limit':20}}),target);rows=response['releases'];assert response['totalCount']=='2' and not response.get('page',{}).get('nextPage',0) and len(rows)==2 and {r['id'] for r in rows}==set(by_id)
   for row in rows:release_receipt(common,row,by_id[row['id']])
   for release in releases:detail=bound_response(rpc(actor,GET,target|{'releaseId':str(release['id'])}),target);release_receipt(common,detail['release'],release)
  rpc(reader,LIST,target|{'repositoryId':str(int(target['repositoryId'])+1)},400,'failed_precondition')
  manifest['readProof']={'repositoryId':target['repositoryId'],'releaseIds':list(by_id),'published':1,'prereleases':1,'exactListAndDetail':True,'authorAndTimesMatched':True,'notesMatchedWithoutRetention':True,'assets':0,'assetURLsExposed':False,'totalCount':'2'};persist()
  if args.browser:
   stage='actual read-only release list and detail captures'
   cookies=[{'name':cookie.name,'value':cookie.value,'url':golf,'httpOnly':True,'sameSite':'Strict'} for handler in owner['session'].handlers if isinstance(handler,common.urllib.request.HTTPCookieProcessor) for cookie in handler.cookiejar];assert len(cookies)==1;forbidden.extend(c['value'] for c in cookies)
   command(['node',str(stack/'scripts/repository-releases-browser.mjs')],{'golf':golf,'cookies':cookies,'repository':repository,'target':target,'releases':[release_receipt(common,rpc(owner,GET,target|{'releaseId':str(r['id'])})['release'],r) for r in releases],'sourceRevision':args.source_revision,'stackRoot':str(stack),'output':str(output/'browser'),'forbidden':forbidden},timeout=180)
   browser=json.loads((output/'browser/manifest.json').read_text());assert browser['passed'] and browser['complete'] and len(browser['captures'])==8
   manifest['browser']={'manifest':'browser/manifest.json','captures':8,'readOnly':True};persist()
  stage='native reader removal and current denial'
  api(owner,'DELETE',path+'/collaborators/'+reader['name'],status=204)
  rpc(reader,LIST,target,404,'not_found');rpc(reader,GET,target|{'releaseId':str(releases[0]['id'])},404,'not_found')
  assert rpc(owner,LIST,target)['totalCount']=='2' and runtime_now()==runtime
  manifest['readerRevocationDenied']=True;manifest['runtimeAfter']=runtime_now();persist()
 except Exception as error:
  failure={'type':type(error).__name__,'stage':stage}
  if isinstance(error,common.HTTPContractFailure):failure['http']=error.diagnostic
  trace=error.__traceback__;frames=[]
  while trace:frames.append({'file':Path(trace.tb_frame.f_code.co_filename).name,'line':trace.tb_lineno});trace=trace.tb_next
  failure['frames']=frames[-6:];manifest.update(status='failed',failure=failure);persist()
 finally:
  for actor in actors.values():
   if actor['loggedIn']:
    try:rpc(actor,'SessionService/RevokeOtherSessions');rpc(actor,'SessionService/Logout')
    except Exception:cleanup.append('managed_session_cleanup')
  for actor in reversed(list(actors.values())):
   if actor['enrolled']:
    try:assert operator('disable',{'username':actor['name']})['disabled']
    except Exception:cleanup.append('managed_account_disable')
  if native_unknown:cleanup.append('native_mutation_unknown_root_disposal_required')
  else:
   for actor,row in reversed(repos):
    if native_unknown:break
    try:observed=api(actor,'GET','repos/'+row['full_name']);assert observed['id']==row['id'] and observed['full_name']==row['full_name'];api(actor,'DELETE','repos/'+row['full_name'],status=204)
    except Exception:cleanup.append('owned_repository_cleanup')
   for actor in reversed(list(actors.values())):
    if native_unknown:break
    if actor['created']:
     try:assert str(api(None,'GET','users/'+actor['name'])['id'])==actor['id'];admin('delete','--username',actor['name'],'--purge')
     except Exception:cleanup.append('owned_native_actor_cleanup')
  manifest['cleanup']={'failures':cleanup,'nativeScopePurged':not cleanup,'stackDisposal':'Root owns stack teardown','retainedGolfMetadata':'Own accounts disabled, no Golf history purge'}
  if cleanup:manifest['status']='failed'
  elif failure is None:manifest['status']='qualified_bounded_release_reads'
  persist()
 if failure or cleanup:print('FAIL: release qualifier; fixed private-safe receipt preserved',file=sys.stderr);return 1
 print('PASS: two current native release reads; assets/publication/snapshot readiness remains separate');return 0

if __name__=='__main__':
 try:sys.exit(main() or 0)
 except Exception:print('FAIL: release qualifier preflight; private diagnostics withheld',file=sys.stderr);sys.exit(1)
