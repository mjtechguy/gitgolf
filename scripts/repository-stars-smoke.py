#!/usr/bin/env python3
"""Prepared own-Star qualification on an externally owned fresh stack.
Two ordinary managed actors and one private repository; explicit Golf own-star
changes, independent native current state/count, restart and reader revocation.
May restart only the already-bound owned Golf service. No journal/CAS/replay
attribution, watch/fork, provider loss injection or repository readiness claim.
"""
import argparse
import importlib.util
import json
from pathlib import Path
import re
import secrets
import subprocess
import sys
import time
sys.dont_write_bytecode=True
GET='RepositoryService/GetRepositoryStar'
SET='RepositoryService/SetRepositoryStar'
FIELDS={'repository','repositoryId','ownerId','nativeUserId','starred','starsCount'}

def load_common(stack):
 spec=importlib.util.spec_from_file_location('star_native_helpers',stack/'scripts/pull-merge-observation-smoke.py')
 module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
 module.RPC_PROCEDURES=module.RPC_PROCEDURES|frozenset((GET,SET))
 return module

def allowed(method,path,prefix):
 if method=='GET' and path in ('user','version'):return True
 if method=='GET' and re.fullmatch('users/'+re.escape(prefix)+r'-(owner|reader)',path):return True
 if method=='POST' and path=='user/repos':return True
 base='repos/'+re.escape(prefix)+r'-owner/private'
 if re.fullmatch(base,path):return method in ('GET','DELETE')
 if re.fullmatch(base+r'/collaborators/'+re.escape(prefix)+r'-reader',path):return method in ('PUT','DELETE')
 return method=='GET' and path=='user/starred/'+prefix+'-owner/private'

def star_receipt(common,response,target,actor,native,expected):
 assert set(response)=={'preference'}
 row=response['preference'];assert set(row)<=FIELDS
 assert row['repository']==target['repository'] and row['repositoryId']==target['repositoryId'] and row['ownerId']==target['ownerId'] and row['nativeUserId']==actor['id']
 assert all(common.decimal(row[k]) for k in ('repositoryId','ownerId','nativeUserId'))
 assert type(row['starred']) is bool and row['starred'] is expected
 assert str(native['id'])==target['repositoryId'] and str(native['owner']['id'])==target['ownerId']
 assert native['full_name']==target['repository']['owner']+'/'+target['repository']['name']
 if 'stars_count' in native:
  assert type(native['stars_count']) is int and 0<=native['stars_count']<=9223372036854775807
  assert row['starsCount']==str(native['stars_count'])
 else:assert 'starsCount' not in row
 return row

def self_check(stack):
 common=load_common(stack);prefix='golf-mergeobs-'+'a'*10
 for method,path in [('POST','user/repos'),('GET','user/starred/'+prefix+'-owner/private'),('GET','repos/'+prefix+'-owner/private')]:assert allowed(method,path,prefix)
 for method,path in [('GET','user/starred/foreign/private'),('PUT','user/starred/'+prefix+'-owner/private'),('DELETE','user/starred/'+prefix+'-owner/private'),('POST','repos/'+prefix+'-owner/private/pulls/1/merge')]:assert not allowed(method,path,prefix)
 target={'repository':{'owner':prefix+'-owner','name':'private'},'repositoryId':'12','ownerId':'7'};actor={'id':'9'}
 native={'id':12,'owner':{'id':7},'full_name':prefix+'-owner/private','stars_count':0}
 row=target|{'nativeUserId':'9','starred':False,'starsCount':'0'}
 star_receipt(common,{'preference':row},target,actor,native,False)
 for change in ({'starred':None},{'starred':0},{'starred':True},{'repositoryId':'13'},{'ownerId':'8'},{'nativeUserId':'10'},{'starsCount':'1'},{'operationId':'invented'}):
  try:star_receipt(common,{'preference':row|change},target,actor,native,False)
  except (AssertionError,ValueError):pass
  else:raise AssertionError('Changed current-star receipt accepted')
 try:star_receipt(common,{'preference':{k:v for k,v in row.items() if k!='starred'}},target,actor,native,False)
 except (AssertionError,KeyError):pass
 else:raise AssertionError('Missing explicit preference accepted')
 star_receipt(common,{'preference':{k:v for k,v in row.items() if k!='starsCount'}},target,actor,{k:v for k,v in native.items() if k!='stars_count'},False)
 print('PASS: pure own-Star scope/identity/presence/count receipt guards; no resources')

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
 manifest={'status':'running','scope':'Two own-account current Star preferences','project':args.project,'fixturePrefix':prefix,'limits':['Current preference is not an original-effect receipt','No native lost-ACK/automatic retry qualification','Counts are independent current native observations','No watch/fork or source authority','Root owns stack disposal']}
 def persist():
  manifest['actors']=[{k:a[k] for k in ('name','id','created','enrolled') if k in a} for a in actors.values()]
  value=json.dumps(manifest,indent=2)+'\n';assert len(value)<1<<20 and all(v not in value for v in forbidden if v)
  temp=output/'manifest.next';temp.write_text(value);temp.chmod(0o600);temp.replace(output/'manifest.json')
 def command(argv,payload=None,timeout=60):
  result=subprocess.run(argv,cwd=stack,input=None if payload is None else json.dumps(payload),text=True,capture_output=True,timeout=timeout)
  assert result.returncode==0 and len(result.stdout)+len(result.stderr)<2<<20
  return result.stdout.strip()
 def admin(*parts):return command(compose+['exec','-T','forgejo','forgejo','--config','/var/lib/gitea/custom/conf/app.ini','admin','user',*parts])  # Forgejo's upstream path
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
  persist();runtime=runtime_now();manifest['runtimeBefore']=runtime;persist();assert common.request(common.client(),'GET',golf+'/readyz',None,{},200);assert api(None,'GET','version')['version']=='15.0.9+gitea-1.22.0'  # Forgejo's upstream version string
  stage='ordinary native actors and managed enrollment'
  for role in ('owner','reader'):
   name=prefix+'-'+role;actor={'name':name,'created':False,'enrolled':False,'loggedIn':False,'session':common.client()};actors[role]=actor
   api(None,'GET','users/'+name,status=404);native_unknown=True;admin('create','--username',name,'--email',name+'@example.invalid','--random-password','--must-change-password=false');actor['created']=True
   row=api(None,'GET','users/'+name);assert row['login']==name;actor['id']=str(row['id']);native_unknown=False;persist()
   actor['token']=admin('generate-access-token','--username',name,'--token-name',prefix,'--scopes','write:user,write:repository','--raw');forbidden.append(actor['token'])
   user=api(actor,'GET','user');assert user['id']==int(actor['id']) and user['is_admin'] is False
   actor.update(email=name+'@golf.invalid',password='Fixture '+secrets.token_urlsafe(24));forbidden.append(actor['password']);actor['enrolled']=True;operator('create',{'username':name,'email':actor['email'],'password':actor['password'],'forge_token':actor['token'],'is_instance_admin':False})
   assert rpc(actor,'SessionService/LoginWithPassword',{'username':actor['email'],'password':actor['password']})['user']['id']==actor['id'];actor['loggedIn']=True
  owner,reader=actors.values();stage='supported private native repository and ordinary reader'
  repo=api(owner,'POST','user/repos',{'name':'private','private':True,'auto_init':True},201);repos.append((owner,repo));repository={'owner':owner['name'],'name':'private'};path='repos/'+repo['full_name']
  assert repo['full_name']==owner['name']+'/private' and repo['owner']['id']==int(owner['id'])
  deadline=time.monotonic()+45
  while api(owner,'GET',path)['empty']:assert time.monotonic()<deadline;time.sleep(.25)
  api(owner,'PUT',path+'/collaborators/'+reader['name'],{'permission':'read'},204)
  target={'repository':repository,'repositoryId':str(repo['id']),'ownerId':str(repo['owner']['id'])};lookup={k:target[k] for k in ('repository','repositoryId')}
  def observe(actor,expected,count):
   native_before=api(actor,'GET',path)
   api(actor,'GET','user/starred/'+owner['name']+'/private',status=204 if expected else 404)
   native_after=api(actor,'GET',path);assert native_before['id']==native_after['id']==repo['id'] and native_after['stars_count']==count
   return star_receipt(common,rpc(actor,GET,lookup),target,actor,native_after,expected)
  def set_star(actor,desired,count):
   response=rpc(actor,SET,target|{'nativeUserId':actor['id'],'starred':desired})
   row=star_receipt(common,response,target,actor,api(actor,'GET',path),desired)
   assert row==observe(actor,desired,count)
   return row
  stage='original target actor refusals before any star change'
  for field,value,status,code in [('repositoryId',str(int(target['repositoryId'])+1),400,'failed_precondition'),('ownerId',reader['id'],400,'failed_precondition'),('nativeUserId',reader['id'],401,'unauthenticated')]:
   rpc(owner,SET,target|{'nativeUserId':owner['id'],'starred':True,field:value},status,code)
   observe(owner,False,0);observe(reader,False,0)
  stage='two independent own-Star true and false states'
  for actor in (owner,reader):observe(actor,False,0)
  set_star(owner,True,1);observe(reader,False,1)
  set_star(reader,True,2);observe(owner,True,2)
  set_star(owner,False,1);observe(reader,True,1)
  set_star(reader,False,0);observe(owner,False,0)
  manifest['preferenceProof']={'repositoryId':target['repositoryId'],'ownerId':target['ownerId'],'nativeUserIds':[owner['id'],reader['id']],'explicitTrueAndFalseForBothActors':True,'independentNativeOwnStateAndCounts':True,'originalTargetRefusalsWithoutEffect':True,'currentObservationNotOriginalReceipt':True};persist()
  owner_expected=False
  if args.browser:
   stage='one explicit actual Star click then read-only theme and size captures'
   cookies=[{'name':cookie.name,'value':cookie.value,'url':golf,'httpOnly':True,'sameSite':'Strict'} for handler in owner['session'].handlers if isinstance(handler,common.urllib.request.HTTPCookieProcessor) for cookie in handler.cookiejar];assert len(cookies)==1;forbidden.extend(c['value'] for c in cookies)
   command(['node',str(stack/'scripts/repository-stars-browser.mjs')],{'golf':golf,'cookies':cookies,'target':target,'nativeUserId':owner['id'],'sourceRevision':args.source_revision,'stackRoot':str(stack),'output':str(output/'browser'),'forbidden':forbidden},timeout=180)
   browser=json.loads((output/'browser/manifest.json').read_text());assert browser['passed'] and browser['complete'] and len(browser['captures'])==4 and browser['setRequests']==1
   owner_expected=True;observe(owner,True,1);observe(reader,False,1)
   manifest['browser']={'manifest':'browser/manifest.json','captures':4,'oneActualExplicitSet':True,'subsequentViewsReadOnly':True};persist()
  stage='owned Golf restart and explicit current inspection without resend'
  current=observe(owner,owner_expected,1 if owner_expected else 0)
  command(compose+['restart','golf']);deadline=time.monotonic()+60
  while True:
   try:assert common.request(common.client(),'GET',golf+'/readyz',None,{},200);break
   except Exception:
    assert time.monotonic()<deadline;time.sleep(.25)
  assert runtime_now()==runtime and observe(owner,owner_expected,1 if owner_expected else 0)==current
  observe(reader,False,1 if owner_expected else 0)
  manifest['restart']={'sameOwnedCoreIdentity':True,'currentNativeStateObserved':True,'explicitGetOnly':True,'noOriginalEffectAttribution':True};persist()
  stage='current reader revocation hides own preference'
  api(owner,'DELETE',path+'/collaborators/'+reader['name'],status=204)
  rpc(reader,GET,lookup,404,'not_found');rpc(reader,SET,target|{'nativeUserId':reader['id'],'starred':True},404,'not_found')
  observe(owner,owner_expected,1 if owner_expected else 0)
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
  elif failure is None:manifest['status']='qualified_bounded_own_star'
  persist()
 if failure or cleanup:print('FAIL: Star qualifier; fixed private-safe receipt preserved',file=sys.stderr);return 1
 print('PASS: explicit own-Star changes/current native reads; no original effect attribution or full readiness');return 0

if __name__=='__main__':
 try:sys.exit(main() or 0)
 except Exception:print('FAIL: Star qualifier preflight; private diagnostics withheld',file=sys.stderr);sys.exit(1)
