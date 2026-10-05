#!/usr/bin/env python3
"""Prepared bounded releases read proof on an externally owned fresh stack.
Never provisions/builds/pulls/disposes services; optional recipes restart only
the externally owned fresh core. Two ordinary managed actors, two native
releases, independent exact list/detail reads, then native reader removal.
Optional --browser captures eight actual read-only views. --assets additionally
qualifies bounded managed native-asset attachments; no Golf asset writes,
snapshot/publication, provider or full repository readiness claim. --publish
adds one explicit existing-tag publication and original-key inspection.
No lost-acknowledgement or protected publication qualification.
"""
import argparse
import uuid
import hashlib
from email.message import Message
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
SUBMIT_PUBLICATION='RepositoryReleasePublicationService/SubmitRepositoryReleasePublication'
GET_PUBLICATION='RepositoryReleasePublicationService/GetRepositoryReleasePublicationOperation'
PUBLICATION_CONTRACT='golf.repository.release-publication.v1'
PUBLICATION_PHASE='REPOSITORY_RELEASE_PUBLICATION_PHASE_'
FIELDS={'id','title','tagName','targetCommitish','bodyMarkdown','draft','prerelease','createdAt','publishedAt','author','assets','assetCount'}

def load_common(stack):
 spec=importlib.util.spec_from_file_location('release_native_helpers',stack/'scripts/pull-merge-observation-smoke.py')
 module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
 module.RPC_PROCEDURES=module.RPC_PROCEDURES|frozenset((LIST,GET,SUBMIT_PUBLICATION,GET_PUBLICATION,'RepositoryAccessService/GetRepositoryAccess'))
 return module

def allowed(method,path,prefix,assets=False,publish=False):
 if method=='GET' and path in ('user','version'):return True
 if method=='GET' and re.fullmatch('users/'+re.escape(prefix)+r'-(owner|reader)',path):return True
 if method=='POST' and path=='user/repos':return True
 base='repos/'+re.escape(prefix)+r'-owner/private'
 if re.fullmatch(base,path):return method in ('GET','DELETE')
 if re.fullmatch(base+r'/collaborators/'+re.escape(prefix)+r'-reader',path):return method in ('PUT','DELETE')
 if re.fullmatch(base+r'/releases',path):return method in ('GET','POST')
 if publish and re.fullmatch(base+r'/tags',path):return method=='POST'
 if publish and re.fullmatch(base+r'/tags/(v1\.0\.0|owned-publication)',path):return method=='GET'
 if publish and re.fullmatch(base+r'/tag_protections',path):return method=='GET'
 if assets and re.fullmatch(base+r'/releases/[1-9][0-9]*/assets/[1-9][0-9]*',path):return method=='GET'
 if assets and re.fullmatch(base+r'/releases/[1-9][0-9]*/assets\?name=owned-release-[12]\.bin',path):return method=='POST'
 return method=='GET' and re.fullmatch(base+r'/releases/[1-9][0-9]*',path) is not None

def release_receipt(common,row,native):
 assert set(row)<=FIELDS and common.decimal(row['id']) and row['id']==str(native['id'])
 mapping={'title':'name','tagName':'tag_name','targetCommitish':'target_commitish','bodyMarkdown':'body','createdAt':'created_at','publishedAt':'published_at'}
 for wire,key in mapping.items():assert row.get(wire,'')==native[key]
 for field in ('draft','prerelease'):assert row.get(field,False)==native[field]
 for field in ('createdAt','publishedAt'):datetime.fromisoformat(row[field].replace('Z','+00:00'))
 assert row['author']['id']==str(native['author']['id']) and row['author']['login']==native['author']['login']
 assert row['author'].get('fullName','')==native['author'].get('full_name','') and row['author'].get('avatarUrl','')==native['author'].get('avatar_url','')
 assets=native['assets'];observed=row.get('assets',[]);assert len(assets)==len(observed) and row['assetCount']==str(len(assets))
 for expected,actual in zip(sorted(assets,key=lambda v:v['id']),sorted(observed,key=lambda v:int(v['id']))):
  assert set(actual)<={'id','name','sizeBytes','downloadCount','createdAt'}
  assert common.decimal(actual['id']) and actual['id']==str(expected['id']) and actual['name']==expected['name'] and actual['sizeBytes']==str(expected['size']) and actual['downloadCount']==str(expected['download_count']) and actual['createdAt']==expected['created_at']
 return row

def bound_response(row,target):
 assert row['repository']==target['repository'] and row['repositoryId']==target['repositoryId']
 return row

def asset_download_path(repository,repository_id,release_id,asset_id):
 from urllib.parse import quote
 assert all(re.fullmatch('[1-9][0-9]{0,18}',v) and int(v)<=9223372036854775807 for v in (repository_id,release_id,asset_id))
 assert all(re.fullmatch('[a-zA-Z0-9_.-]{1,100}',repository[k]) for k in ('owner','name'))
 return '/api/repositories/'+quote(repository['owner'],safe='')+'/'+quote(repository['name'],safe='')+'/'+repository_id+'/releases/'+release_id+'/assets/'+asset_id+'/download'

def attachment_receipt(data,headers,asset,expected):
 assert len(data)<=10<<20 and data==expected and len(data)==asset['size']
 assert headers['Content-Type']=='application/octet-stream' and headers['Content-Length']==str(len(data))
 assert headers['Cache-Control']=='no-store' and headers['X-Content-Type-Options']=='nosniff' and headers['Content-Security-Policy']=="sandbox; default-src 'none'"
 disposition=Message();disposition['Content-Disposition']=headers['Content-Disposition']
 assert disposition.get_content_disposition()=='attachment' and disposition.get_filename()==asset['name']
 return hashlib.sha256(data).hexdigest()

def publication_status(intent):
 return {key:intent[key] for key in ('repository','repositoryId','ownerId','operationId')}

def publication_receipt(common,row,intent,actor,phase):
 fields={'contract','operationId','actorId','repository','repositoryId','ownerId','accessRevision','tagName','tagObjectId','commitId','titleSha256','bodySha256','prerelease','phase','releaseId','createdAt','updatedAt','failureCode'}
 assert isinstance(row,dict) and set(row)<=fields and row['contract']==PUBLICATION_CONTRACT
 assert phase in {PUBLICATION_PHASE+p for p in ('RESERVED','DISPATCH_UNKNOWN','SUCCEEDED','REJECTED')} and row['phase']==phase
 for key in ('operationId','repository','repositoryId','ownerId','accessRevision','tagName','tagObjectId','commitId'):assert row[key]==intent[key]
 assert common.decimal(row['actorId']) and row['actorId']==actor
 assert all(common.decimal(intent[key]) for key in ('repositoryId','ownerId'))
 assert str(uuid.UUID(intent['operationId']))==intent['operationId'] and common.HASH.fullmatch(intent['accessRevision'])
 assert common.OID.fullmatch(row['tagObjectId']) and common.OID.fullmatch(row['commitId']) and len(row['tagObjectId'])==len(row['commitId'])
 for wire,source in (('titleSha256','title'),('bodySha256','bodyMarkdown')):assert row[wire]==hashlib.sha256(intent[source].encode()).hexdigest()
 assert row.get('prerelease',False) is intent['prerelease']
 for key in ('createdAt','updatedAt'):
  assert re.fullmatch(r'\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,9})?Z',row[key]);datetime.fromisoformat(row[key].replace('Z','+00:00'))
 if phase==PUBLICATION_PHASE+'SUCCEEDED':assert common.decimal(row['releaseId']) and not row.get('failureCode')
 else:assert not row.get('releaseId') and row.get('failureCode','')==('preflight_refused' if phase==PUBLICATION_PHASE+'REJECTED' else '')
 return row

def publication_native_receipt(common,release,tag,intent,actor):
 assert tag['name']==intent['tagName'] and tag['id']==intent['tagObjectId'] and tag['commit']['sha']==intent['commitId']
 assert common.OID.fullmatch(tag['id']) and common.OID.fullmatch(tag['commit']['sha'])
 assert common.decimal(str(release['id'])) and release['tag_name']==intent['tagName'] and release['target_commitish']==intent['commitId']
 assert release['name']==intent['title'] and release['body']==intent['bodyMarkdown'] and release['draft'] is False and release['prerelease'] is intent['prerelease']
 assert str(release['author']['id'])==actor and release['assets']==[]
 for key in ('created_at','published_at'):datetime.fromisoformat(release[key].replace('Z','+00:00'))
 return release

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
 asset={'id':21,'name':'owned-release-1.bin','size':3,'download_count':0,'created_at':native['created_at']}
 with_asset=native|{'assets':[asset]};asset_row={'id':'21','name':asset['name'],'sizeBytes':'3','downloadCount':'0','createdAt':asset['created_at']}
 release_receipt(common,row|{'assetCount':'1','assets':[asset_row]},with_asset)
 for change in ({'id':'22'},{'sizeBytes':'4'},{'name':'changed'},{'downloadCount':'1'},{'uuid':'private-transport-id'},{'browserDownloadUrl':'https://outside.invalid'}):
  try:release_receipt(common,row|{'assetCount':'1','assets':[asset_row|change]},with_asset)
  except (AssertionError,ValueError):pass
  else:raise AssertionError('Changed asset receipt accepted')
 upload='repos/'+prefix+'-owner/private/releases/12/assets?name=owned-release-1.bin'
 assert allowed('POST',upload,prefix,True) and not allowed('POST',upload,prefix)
 for path in (upload.replace('owned-release-1.bin','private-value.bin'),upload+'&url=https://outside.invalid',upload.replace(prefix,'foreign')):assert not allowed('POST',path,prefix,True)
 route=asset_download_path({'owner':'owned','name':'private'},'2','12','21');assert route=='/api/repositories/owned/private/2/releases/12/assets/21/download'
 for ids in (('02','12','21'),('2','0','21'),('2','12','9223372036854775808')):
  try:asset_download_path({'owner':'owned','name':'private'},*ids)
  except AssertionError:pass
  else:raise AssertionError('Unbound attachment path accepted')
 headers={'Content-Type':'application/octet-stream','Content-Length':'3','Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Content-Security-Policy':"sandbox; default-src 'none'",'Content-Disposition':'attachment; filename=owned-release-1.bin'}
 assert attachment_receipt(b'abc',headers,asset,b'abc')==hashlib.sha256(b'abc').hexdigest()
 for data,h in ((b'abd',headers),(b'abc',headers|{'Content-Type':'text/html'}),(b'abc',headers|{'Content-Disposition':'inline; filename=owned-release-1.bin'}),(b'abc',headers|{'Content-Length':'4'}),(b'abc',headers|{'Cache-Control':'public'}),(b'abc',headers|{'Content-Disposition':'attachment; filename=other.bin'})):
  try:attachment_receipt(data,h,asset,b'abc')
  except AssertionError:pass
  else:raise AssertionError('Unsafe attachment accepted')
 publication={'repository':{'owner':'owned','name':'private'},'repositoryId':'2','ownerId':'4','accessRevision':'b'*64,'operationId':'12345678-1234-4234-8234-123456789abc','tagName':'owned-publication','tagObjectId':'a'*40,'commitId':'a'*40,'title':'Owned publication','bodyMarkdown':'Literal "notes" café','prerelease':False}
 receipt=publication_status(publication)|{key:publication[key] for key in ('accessRevision','tagName','tagObjectId','commitId')}|{'contract':PUBLICATION_CONTRACT,'actorId':'4','titleSha256':hashlib.sha256(publication['title'].encode()).hexdigest(),'bodySha256':hashlib.sha256(publication['bodyMarkdown'].encode()).hexdigest(),'phase':PUBLICATION_PHASE+'SUCCEEDED','releaseId':'12','createdAt':native['created_at'],'updatedAt':native['created_at']}
 publication_receipt(common,receipt,publication,'4',receipt['phase'])
 publication_receipt(common,receipt|{'prerelease':True},publication|{'prerelease':True},'4',receipt['phase'])
 for change in ({'repositoryId':'3'},{'ownerId':'5'},{'actorId':'5'},{'repository':{'owner':'other','name':'private'}},{'accessRevision':'c'*64},{'tagObjectId':'c'*40},{'commitId':'c'*40},{'tagName':'other'},{'operationId':str(uuid.uuid4())},{'titleSha256':'c'*64},{'bodySha256':'c'*64},{'prerelease':True},{'phase':PUBLICATION_PHASE+'DISPATCH_UNKNOWN'},{'releaseId':'0'},{'title':publication['title']},{'bodyMarkdown':publication['bodyMarkdown']}):
  try:publication_receipt(common,receipt|change,publication,'4',receipt['phase'])
  except (AssertionError,ValueError):pass
  else:raise AssertionError('Changed/private publication receipt accepted')
 for phase in ('RESERVED','DISPATCH_UNKNOWN','REJECTED'):
  partial={k:v for k,v in receipt.items() if k!='releaseId'};partial['phase']=PUBLICATION_PHASE+phase
  if phase=='REJECTED':partial['failureCode']='preflight_refused'
  publication_receipt(common,partial,publication,'4',partial['phase'])
  try:publication_receipt(common,partial|{'releaseId':'12'},publication,'4',partial['phase'])
  except AssertionError:pass
  else:raise AssertionError('Unverified release ID accepted')
 tag={'name':publication['tagName'],'id':publication['tagObjectId'],'commit':{'sha':publication['commitId']}}
 published=native|{'tag_name':publication['tagName'],'target_commitish':publication['commitId'],'name':publication['title'],'body':publication['bodyMarkdown'],'prerelease':False,'author':{'id':4}}
 publication_native_receipt(common,published,tag,publication,'4')
 for change in ({'target_commitish':'main'},{'body':'changed'},{'draft':True},{'author':{'id':5}},{'tag_name':'other'}):
  try:publication_native_receipt(common,published|change,tag,publication,'4')
  except AssertionError:pass
  else:raise AssertionError('Changed native publication accepted')
 for tag_id in ('a'*40,'c'*40):publication_native_receipt(common,published,tag|{'id':tag_id},publication|{'tagObjectId':tag_id},'4')
 tag_path='repos/'+prefix+'-owner/private/tags'
 assert allowed('POST',tag_path,prefix,publish=True) and not allowed('POST',tag_path,prefix)
 assert allowed('GET',tag_path+'/owned-publication',prefix,publish=True) and not allowed('GET',tag_path+'/foreign',prefix,publish=True)
 assert not allowed('DELETE',tag_path+'/owned-publication',prefix,publish=True) and not allowed('POST',tag_path.replace(prefix,'foreign'),prefix,publish=True)
 print('PASS: pure native scope, release/publication receipts and attachment tamper checks; no resources')

def main():
 p=argparse.ArgumentParser(description=__doc__)
 p.add_argument('--self-check',action='store_true');p.add_argument('--stack-root',type=Path,default=Path(__file__).resolve().parents[1]);p.add_argument('--project');p.add_argument('--compose-file',type=Path);p.add_argument('--env-file',type=Path);p.add_argument('--image');p.add_argument('--source-revision');p.add_argument('--golf-url');p.add_argument('--native-url');p.add_argument('--output',type=Path);p.add_argument('--browser',action='store_true');p.add_argument('--assets',action='store_true',help='Also qualify current-authorized local native attachments <=10MiB');p.add_argument('--publish',action='store_true',help='Qualify one existing-tag Golf publication and original no-resend inspection');p.add_argument('--publication-tag-type',choices=('lightweight','annotated'),default='lightweight')
 args=p.parse_args();stack=args.stack_root.resolve();common=load_common(stack)
 if args.self_check:return self_check(stack)
 assert args.publish or args.publication_tag_type=='lightweight'
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
  assert allowed(method,path,prefix,args.assets,args.publish)
  if method not in ('GET','HEAD'):native_unknown=True
  result=common.request(common.client(),method,native+'/api/v1/'+path,payload,{'Content-Type':'application/json',**({'Authorization':'token '+actor['token']} if actor else {})},status)
  if method not in ('GET','HEAD'):native_unknown=False
  return result
 def exchange(opener,method,url,data,headers,status=200):
  request=common.urllib.request.Request(url,method=method,data=data,headers=headers)
  try:reply=opener.open(request,timeout=20)
  except common.urllib.error.HTTPError as error:reply=error
  with reply:
   raw=reply.read((10<<20)+1)
   if reply.status!=status or len(raw)>10<<20:raise common.HTTPContractFailure(common.http_diagnostic(method,url,reply.status,status,b'', 'response_too_large' if len(raw)>10<<20 else 'unexpected_status'))
   return raw,reply.headers
 def native_asset(actor,release,asset):
  assert asset['id']>0 and re.fullmatch('[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}',asset['uuid'])
  before=api(actor,'GET',path+'/releases/'+str(release['id'])+'/assets/'+str(asset['id']))
  assert all(before[k]==asset[k] for k in ('id','uuid','name','size','created_at'))
  # UUID is verified under the exact release API, never a user URL or public grant.
  url=native+'/'+repo['full_name']+'/releases/attachments/'+asset['uuid']
  raw,_=exchange(common.client(),'GET',url,None,{'Authorization':'Bearer '+actor['token']})
  after=api(actor,'GET',path+'/releases/'+str(release['id'])+'/assets/'+str(asset['id']))
  assert all(after[k]==before[k] for k in ('id','uuid','name','size','created_at')) and len(raw)==asset['size']
  return raw
 def download(actor,release,asset,expected,status=200,extra=None,repository_id=None,release_id=None,asset_id=None):
  url=golf+asset_download_path(repository,repository_id or target['repositoryId'],release_id or str(release['id']),asset_id or str(asset['id']))
  raw,headers=exchange(actor['session'],'GET',url,None,{'Origin':golf}|(extra or {}),status)
  if status==200:attachment_receipt(raw,headers,asset,expected)
  else:assert raw!=expected and headers['Cache-Control']=='no-store' and headers['X-Content-Type-Options']=='nosniff'
  return raw
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
  if args.assets:
   stage='supported owned native assets and exact private attachments'
   manifest['readProof']['checkpoint']='Before optional native asset uploads'
   manifest['scope']='Two current native release reads plus bounded local asset attachments'
   manifest['limits']=['No Golf release/asset write or publication qualification','Local <=10MiB buffered attachment only; no redirect/ServeDirect/remote provider support','Observed SHA is fetched bytes, not an immutable publication snapshot','Root owns stack disposal']
   assets=[]
   for number,release in enumerate(releases,1):
    body=('owned release '+str(number)+' asset\n').encode();name='owned-release-'+str(number)+'.bin'
    upload=path+'/releases/'+str(release['id'])+'/assets?name='+name;assert allowed('POST',upload,prefix,True)
    native_unknown=True
    raw,_=exchange(common.client(),'POST',native+'/api/v1/'+upload,body,{'Content-Type':'application/octet-stream','Authorization':'token '+owner['token']},201)
    asset=json.loads(raw);assert common.decimal(str(asset['id'])) and asset['name']==name and asset['size']==len(body)
    native_unknown=False;assets.append((release,asset,body))
    for actor in (owner,reader):
     assert native_asset(actor,release,asset)==body
     assert download(actor,release,asset,body)==body
    download(owner,release,asset,body,403,extra={'Origin':'https://outside.invalid'})
    download(owner,release,asset,body,403,extra={'Authorization':'Bearer '+owner['token']})
    download(owner,release,asset,body,403,extra={'Sec-Fetch-Site':'cross-site'})
    url=golf+asset_download_path(repository,target['repositoryId'],str(release['id']),str(asset['id']))
    exchange(common.client(),'GET',url,None,{'Origin':golf},401)
    exchange(owner['session'],'GET',url+'?url=https://outside.invalid',None,{'Origin':golf},403)
   for release,asset,body in assets:
    download(reader,release,asset,body,404,repository_id=str(int(target['repositoryId'])+1))
    other=next(r for r in releases if r['id']!=release['id'])
    download(reader,release,asset,body,404,release_id=str(other['id']))
    download(reader,release,asset,body,404,asset_id='9223372036854775807')
   releases=[api(owner,'GET',path+'/releases/'+str(r['id'])) for r in releases]
   for actor in (owner,reader):
    listing=bound_response(rpc(actor,LIST,target),target)
    for row in listing['releases']:release_receipt(common,row,next(v for v in releases if str(v['id'])==row['id']))
   manifest['assetProof']={'assets':[{'releaseId':str(r['id']),'assetId':str(a['id']),'bytes':len(b),'sha256':hashlib.sha256(b).hexdigest()} for r,a,b in assets],'independentNativeBytes':True,'ownerAndReaderExactAttachments':True,'wrongAssociationDenied':True,'foreignOriginAndBearerDenied':True,'crossSiteQueryAndMissingSessionDenied':True,'uuidAndNativeURLsNotExposed':True};persist()
   stage='asset restart preserves current private bytes'
   command(compose+['restart','golf']);deadline=time.monotonic()+60
   while True:
    try:common.request(common.client(),'GET',golf+'/readyz',None,{},200);break
    except Exception:assert time.monotonic()<deadline;time.sleep(.25)
   assert runtime_now()==runtime
   for release,asset,body in assets:assert download(owner,release,asset,body)==body
   manifest['assetProof']['restartExactBytes']=True;persist()
  if args.browser:
   stage='actual read-only release list and detail captures'
   if args.assets:releases=[api(owner,'GET',path+'/releases/'+str(r['id'])) for r in releases]
   cookies=[{'name':cookie.name,'value':cookie.value,'url':golf,'httpOnly':True,'sameSite':'Strict'} for handler in owner['session'].handlers if isinstance(handler,common.urllib.request.HTTPCookieProcessor) for cookie in handler.cookiejar];assert len(cookies)==1;forbidden.extend(c['value'] for c in cookies)
   command(['node',str(stack/'scripts/repository-releases-browser.mjs')],{'golf':golf,'cookies':cookies,'repository':repository,'target':target,'releases':[release_receipt(common,rpc(owner,GET,target|{'releaseId':str(r['id'])})['release'],r) for r in releases],'sourceRevision':args.source_revision,'stackRoot':str(stack),'output':str(output/'browser'),'forbidden':forbidden,'assetMode':args.assets,'assetProof':manifest.get('assetProof')},timeout=180)
   browser=json.loads((output/'browser/manifest.json').read_text());assert browser['passed'] and browser['complete'] and len(browser['captures'])==8
   manifest['browser']={'manifest':'browser/manifest.json','captures':8,'readOnly':True,'assetDownloads':1 if args.assets else 0};persist()
  if args.publish:
   stage='existing unprotected native tag and exact publication bindings'
   assert api(owner,'GET',path+'/tag_protections')==[]
   original_tag=api(owner,'GET',path+'/tags/v1.0.0');H=original_tag['commit']['sha'];assert common.OID.fullmatch(H)
   tag_name='owned-publication';tag_message='Owned annotated tag fixture' if args.publication_tag_type=='annotated' else ''
   tag=api(owner,'POST',path+'/tags',{'tag_name':tag_name,'target':H,'message':tag_message},201)
   tag=api(owner,'GET',path+'/tags/'+tag_name)
   assert tag['name']==tag_name and common.OID.fullmatch(tag['id']) and tag['commit']['sha']==H and len(tag['id'])==len(H)
   assert (tag['id']!=H) is (args.publication_tag_type=='annotated')
   assert len(api(owner,'GET',path+'/releases'))==2
   access=rpc(owner,'RepositoryAccessService/GetRepositoryAccess',{'repository':repository})['access']
   assert access['repositoryId']==target['repositoryId'] and access['ownerId']==owner['id'] and access['owner']['id']==owner['id'] and access['owner']['login']==owner['name'] and access['canManage'] and access['currentPermission']=='owner' and common.HASH.fullmatch(access['revision'])
   intent=target|{'ownerId':owner['id'],'accessRevision':access['revision'],'operationId':str(uuid.uuid4()),'tagName':tag_name,'tagObjectId':tag['id'],'commitId':H,'title':'Owned Golf publication','bodyMarkdown':'Controlled published notes.\n\n**Existing tag observation only.**','prerelease':False}
   forbidden.extend((intent['title'],intent['bodyMarkdown']))
   stage='stale publication revision durably refused without native publication'
   refused=intent|{'operationId':str(uuid.uuid4()),'accessRevision':('0' if access['revision']!='0'*64 else '1')*64}
   native_unknown=True
   rejected=publication_receipt(common,rpc(owner,SUBMIT_PUBLICATION,refused)['operation'],refused,owner['id'],PUBLICATION_PHASE+'REJECTED')
   assert publication_receipt(common,rpc(owner,GET_PUBLICATION,publication_status(refused))['operation'],refused,owner['id'],rejected['phase'])==rejected
   assert publication_receipt(common,rpc(owner,SUBMIT_PUBLICATION,refused)['operation'],refused,owner['id'],rejected['phase'])==rejected
   assert len(api(owner,'GET',path+'/releases'))==2;native_unknown=False
   stage='one explicit Golf existing-tag publication'
   native_unknown=True
   receipt=publication_receipt(common,rpc(owner,SUBMIT_PUBLICATION,intent)['operation'],intent,owner['id'],PUBLICATION_PHASE+'SUCCEEDED')
   observed=publication_native_receipt(common,api(owner,'GET',path+'/releases/'+receipt['releaseId']),api(owner,'GET',path+'/tags/'+tag_name),intent,owner['id'])
   assert str(observed['id'])==receipt['releaseId'];native_unknown=False
   published_ids={str(r['id']) for r in releases}|{receipt['releaseId']}
   def verify_publication():
    rows=api(owner,'GET',path+'/releases');assert len(rows)==3 and {str(r['id']) for r in rows}==published_ids
    current=publication_native_receipt(common,api(owner,'GET',path+'/releases/'+receipt['releaseId']),api(owner,'GET',path+'/tags/'+tag_name),intent,owner['id'])
    assert all(current[key]==observed[key] for key in ('id','name','tag_name','target_commitish','body','draft','prerelease','author','created_at','published_at','assets'))
    assert publication_receipt(common,rpc(owner,GET_PUBLICATION,publication_status(intent))['operation'],intent,owner['id'],receipt['phase'])==receipt
   stage='original publication status and exact-key replay without another release'
   verify_publication()
   native_unknown=True
   assert publication_receipt(common,rpc(owner,SUBMIT_PUBLICATION,intent)['operation'],intent,owner['id'],receipt['phase'])==receipt
   verify_publication();native_unknown=False
   # Different content under the original key must never become a new intent.
   native_unknown=True
   rpc(owner,SUBMIT_PUBLICATION,intent|{'bodyMarkdown':'Changed original publication body'},400,'failed_precondition');verify_publication();native_unknown=False
   stage='publication restart preserves original receipt and native release'
   command(compose+['restart','golf']);deadline=time.monotonic()+60
   while True:
    try:common.request(common.client(),'GET',golf+'/readyz',None,{},200);break
    except Exception:assert time.monotonic()<deadline;time.sleep(.25)
   assert runtime_now()==runtime;verify_publication()
   native_unknown=True
   assert publication_receipt(common,rpc(owner,SUBMIT_PUBLICATION,intent)['operation'],intent,owner['id'],receipt['phase'])==receipt
   verify_publication();native_unknown=False
   # The reader cannot publish or inspect another actor's original operation.
   stage='reader publication authority refusal'
   native_unknown=True
   rpc(reader,SUBMIT_PUBLICATION,intent|{'operationId':str(uuid.uuid4())},403,'permission_denied')
   rpc(reader,GET_PUBLICATION,publication_status(intent),403,'permission_denied');verify_publication();native_unknown=False
   manifest['scope']='Existing release reads plus one bounded existing-tag Golf publication'+(' and local asset attachments' if args.assets else '')
   manifest['limits']=['No protected/atomic tag-source fencing or cryptographic artifact promotion','No publication lost-acknowledgement qualification or automatic replacement key','Publication UI remains unqualified; optional browser views are metadata/asset reads','Root owns stack disposal']
   manifest['publicationProof']={'operation':receipt,'tagType':args.publication_tag_type,'explicitPublicationVerified':True,'independentNativeContentAndAuthorMatched':True,'nativeReleaseCount':'3','staleRevisionRejectedWithoutPublication':True,'originalInspectionAndReplayNoAdditionalRelease':True,'changedOriginalContentRefused':True,'restartReceiptAndReplayStable':True,'readerPublicationAndOriginalInspectionRefused':True,'titleAndBodyNotRetained':True};persist()
  stage='native reader removal and current denial'
  api(owner,'DELETE',path+'/collaborators/'+reader['name'],status=204)
  rpc(reader,LIST,target,404,'not_found');rpc(reader,GET,target|{'releaseId':str(releases[0]['id'])},404,'not_found')
  if args.assets:
   for release,asset,body in assets:download(reader,release,asset,body,404);assert download(owner,release,asset,body)==body
   manifest['assetProof']['readerRevocationDenied']=True
  assert rpc(owner,LIST,target)['totalCount']==('3' if args.publish else '2') and runtime_now()==runtime
  if args.publish:verify_publication();manifest['publicationProof']['historicalInspectionAfterAccessRevisionChange']=True
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
  elif failure is None:manifest['status']='qualified_bounded_release_publication' if args.publish else 'qualified_bounded_release_assets' if args.assets else 'qualified_bounded_release_reads'
  persist()
 if failure or cleanup:print('FAIL: release qualifier; fixed private-safe receipt preserved',file=sys.stderr);return 1
 print('PASS: current native release reads'+(' and bounded local attachments' if args.assets else '')+(' and one existing-tag publication; protected publication/snapshot readiness remains separate' if args.publish else '; publication/snapshot readiness remains separate'));return 0

if __name__=='__main__':
 try:sys.exit(main() or 0)
 except Exception:print('FAIL: release qualifier preflight; private diagnostics withheld',file=sys.stderr);sys.exit(1)
