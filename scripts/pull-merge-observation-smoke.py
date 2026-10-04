#!/usr/bin/env python3
"""Prepared merge-observation qualifier for a root-owned disposable Compose stack.

Never starts, stops, builds, pulls or restarts services. Uses supported native
APIs/admin CLI and managed Golf accounts, with bounded owned-actor cleanup.
No merge POST, publication, workflow, inference or native database/file write.
--self-check performs pure contract checks and browser-source syntax only.
"""
import argparse
import base64
import copy
import hashlib
import http.cookiejar
import json
import os
from pathlib import Path
import re
import secrets
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
sys.dont_write_bytecode = True

SERVICE = 'PullMergeObservationService/GetPullRequestMergeObservation'
OID = re.compile(r'(?:[a-f0-9]{40}|[a-f0-9]{64})')
HASH = re.compile(r'[a-f0-9]{64}')
ID = re.compile(r'[1-9][0-9]{0,18}')
PROJECT = re.compile(r'golf-(?:mergeobs|rules49|access48)-[a-f0-9]{10}')
STRATEGIES = {'allow_merge_commits':'allowMergeCommits','allow_rebase':'allowRebase','allow_rebase_explicit':'allowRebaseExplicit','allow_squash_merge':'allowSquashMerge','allow_fast_forward_only_merge':'allowFastForwardOnlyMerge','allow_manual_merge':'allowManualMerge','autodetect_manual_merge':'autodetectManualMerge','allow_merge_update':'allowMergeUpdate','allow_rebase_update':'allowRebaseUpdate','default_delete_branch_after_merge':'defaultDeleteBranchAfterMerge','default_allow_maintainer_edit':'defaultAllowMaintainerEdit'}

CONNECT_CODES = frozenset(('canceled','unknown','invalid_argument','deadline_exceeded','not_found','already_exists','permission_denied','resource_exhausted','failed_precondition','aborted','out_of_range','unimplemented','internal','unavailable','data_loss','unauthenticated'))
RPC_PROCEDURES = frozenset((SERVICE,'RepositoryService/GetPullRequest','SessionService/LoginWithPassword','SessionService/Logout','SessionService/RevokeOtherSessions','ApiCredentialService/CreateApiCredential','ApiCredentialService/RevokeApiCredential'))

class HTTPContractFailure(Exception):
    def __init__(self, diagnostic):
        super().__init__('HTTP contract failure; private response withheld')
        self.diagnostic = diagnostic


def http_diagnostic(method, url, status, expected, raw, category='unexpected_status'):
    path=urllib.parse.urlsplit(url).path
    procedure=path.removeprefix('/rpc/golf.v1.')
    if procedure not in RPC_PROCEDURES:
        procedure='native_api' if path.startswith('/api/v1/') else 'readiness' if path=='/readyz' else 'unclassified'
    code='unavailable_code'
    if path.startswith('/rpc/') and len(raw)<=2<<20:
        try:
            decoded=json.loads(raw)
            candidate=decoded.get('code') if isinstance(decoded,dict) else None
            if isinstance(candidate,str) and candidate in CONNECT_CODES:code=candidate
        except (ValueError,TypeError):pass
    return {'procedure':procedure,'method':method if method in ('GET','POST','PATCH','PUT','DELETE','HEAD') else 'unclassified','status':status if isinstance(status,int) and 100<=status<=599 else 0,'expectedStatus':expected,'code':code,'category':category}


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args):
        return None


def loopback(value):
    p = urllib.parse.urlsplit(value)
    assert p.scheme in ('http','https') and p.hostname in ('127.0.0.1','localhost','::1')
    assert p.port and not p.username and not p.password and p.path in ('','/') and not p.query and not p.fragment
    assert not any(ord(c)<33 or ord(c)==127 for c in value)
    return value.rstrip('/')


def client():
    return urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect(), urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))


def request(opener, method, url, payload, headers, expected):
    req = urllib.request.Request(url, method=method, data=None if payload is None else json.dumps(payload).encode(), headers=headers)
    try:
        response = opener.open(req, timeout=20)
    except urllib.error.HTTPError as error:
        response = error
    with response:
        raw = response.read((2<<20)+1)
        if len(raw)>2<<20:raise HTTPContractFailure(http_diagnostic(method,url,response.status,expected,b'', 'response_too_large'))
        if response.status!=expected:raise HTTPContractFailure(http_diagnostic(method,url,response.status,expected,raw))
        if '/rpc/' in url and response.headers.get('Cache-Control')!='no-store':raise HTTPContractFailure(http_diagnostic(method,url,response.status,expected,raw,'no_store_missing'))
        return json.loads(raw) if raw else None


def decimal(value):
    return isinstance(value,str) and ID.fullmatch(value) is not None and int(value)<=9223372036854775807


def native_path_allowed(method, path, prefix):
    # A closed supported-API fixture vocabulary; merge/publication endpoints
    # are never eligible, even under an owned repository namespace.
    method = method.upper()
    if method == 'GET' and path in ('version', 'user'): return True
    if method == 'GET' and re.fullmatch(r'users/' + re.escape(prefix) + r'-[a-z]+', path): return True
    if method == 'POST' and path == 'user/repos': return True
    match = re.fullmatch(r'repos/(' + re.escape(prefix) + r'-[a-z]+)/(private)(?:/(.*))?', path)
    if not match: return False
    tail = match.group(3) or ''
    if method == 'GET':
        return tail == '' or re.fullmatch(r'(?:pulls/[1-9][0-9]*|branches/[^?#]+|git/refs/heads/[^?#]+|commits\?sha=[a-zA-Z0-9%]+&limit=1&stat=false&files=false&verification=false)', tail) is not None
    if method == 'DELETE': return tail == '' or re.fullmatch(r'collaborators/' + re.escape(prefix) + r'-[a-z]+', tail) is not None
    if method == 'PUT': return tail == 'contents/fixture.txt' or re.fullmatch(r'collaborators/' + re.escape(prefix) + r'-[a-z]+', tail) is not None
    if method == 'POST': return tail in ('forks', 'branches', 'contents/fixture.txt', 'pulls', 'branch_protections')
    return method == 'PATCH' and re.fullmatch(r'pulls/[1-9][0-9]*', tail) is not None


def exact_ref(rows, name):
    assert isinstance(rows,list) and len(rows)==1
    row=rows[0];assert row['ref']=='refs/heads/'+name and row['object']['type']=='commit' and OID.fullmatch(row['object']['sha'])
    return row['object']['sha']


def receipt(value, selected, native_branch, raw_repo, source_id, source_name, live_head):
    v=value['observation']
    assert v['selection']==selected['selection'] and v['pullRevision']==selected['expectedPullRevision']
    assert v['targetOwnerId']==str(raw_repo['owner']['id']) and decimal(v['targetOwnerId'])
    assert HASH.fullmatch(v['fingerprint']) and re.fullmatch(r'\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,9})?Z',v['observedAt'])
    assert v['unavailableReason']=='protected_integration_unqualified'
    assert isinstance(native_branch['protected'],bool) and isinstance(native_branch['user_can_merge'],bool)
    assert v['targetProtection']=='PULL_MERGE_TARGET_PROTECTION_'+('PROTECTED' if native_branch['protected'] else 'UNPROTECTED')
    assert v['nativeCallerCanMerge'] is native_branch['user_can_merge']
    assert v['base']=={'kind':'REPOSITORY_SOURCE_REF_KIND_BRANCH','name':native_branch['name'],'commitId':native_branch['commit']['id']}
    config=v['mergeConfiguration']
    for native,wire in STRATEGIES.items():
        assert isinstance(raw_repo[native],bool) and config.get(wire,False) is raw_repo[native]
    assert config['defaultMergeStyle']==raw_repo['default_merge_style'] and config['defaultUpdateStyle']==raw_repo['default_update_style']
    if live_head is None:
        assert v['sourceState']=='PULL_MERGE_SOURCE_STATE_UNAVAILABLE'
        assert not v.get('source') and not v.get('sourceRepository') and not v.get('sourceRepositoryId')
    else:
        assert v['sourceRepositoryId']==str(source_id) and v['sourceRepository']==source_name
        assert v['source']=={'kind':'REPOSITORY_SOURCE_REF_KIND_BRANCH','name':selected['headRef'],'commitId':live_head}
        assert v['sourceState']=='PULL_MERGE_SOURCE_STATE_'+('CURRENT' if live_head==selected['selection']['headCommitId'] else 'CHANGED')
    assert isinstance(v['currentTargetWriter'],bool)
    return v


BROWSER = r'''
import {pathToFileURL} from 'node:url';import {join} from 'node:path';import {writeFile} from 'node:fs/promises';
let browser,config,stage='initialization',contexts=[];const captures=[],allErrors=[];function check(x){if(!x)throw Error('assertion');}
try{
 let raw='';for await(const p of process.stdin){raw+=p;check(raw.length<=65536);}config=JSON.parse(raw);raw='';
 const {chromium}=await import(pathToFileURL(join(config.stackRoot,'web/node_modules/playwright/index.mjs')));browser=await chromium.launch();
 const headers={Origin:config.golf,'Content-Type':'application/json','Connect-Protocol-Version':'1'};
 for(const theme of ['dark','light'])for(const width of [1440,390]){
  stage='managed login '+theme+' '+width;const context=await browser.newContext({viewport:{width,height:1000}});contexts.push(context);
  await context.route('**/*',route=>{const u=new URL(route.request().url());return ['http:','https:'].includes(u.protocol)&&u.origin!==config.golf?route.abort():route.continue();});
  check((await context.request.post(config.golf+'/rpc/golf.v1.SessionService/LoginWithPassword',{maxRedirects:0,headers,data:{username:config.email,password:config.password}})).status()===200);
  const page=await context.newPage(),errors=[];let reads=0,invalid=false;page.on('pageerror',()=>{errors.push(true);allErrors.push(true)});
  page.on('request',r=>{if(!new URL(r.url()).pathname.startsWith('/rpc/'))return;const m=r.url().split('/').at(-1);if(m==='GetPullRequestMergeObservation')reads++;else if(!/^(Get|List|Resolve|Watch)/.test(m))invalid=true;});
  const url=config.golf+'/'+config.repository+'/pull/'+config.number, panel=page.getByRole('region',{name:'Pull request merge observation',exact:true});
  stage='no initial observation fanout';await page.goto(url);await page.getByRole('button',{name:'Inspect merge observations',exact:true}).waitFor();check(reads===0&&!invalid);
  const toggle=page.getByRole('button',{name:'Switch to '+theme+' theme',exact:true});if(await toggle.count())await toggle.click();check(await page.locator('html').getAttribute('data-theme')===theme);
  const validate=r=>{check(r.status()===200);return r.json().then(body=>{const v=body.observation,i=config.intent;check(v.pullRevision===i.expectedPullRevision&&v.selection.repositoryId===i.selection.repositoryId&&v.selection.pullRequestId===i.selection.pullRequestId&&v.selection.number===i.selection.number&&v.selection.headCommitId===i.selection.headCommitId&&v.selection.baseCommitId===i.selection.baseCommitId&&v.selection.repository.owner===i.selection.repository.owner&&v.selection.repository.name===i.selection.repository.name);check(v.targetProtection==='PULL_MERGE_TARGET_PROTECTION_PROTECTED'&&v.sourceState==='PULL_MERGE_SOURCE_STATE_CURRENT'&&v.sourceRepositoryId===config.sourceRepositoryId&&v.source.commitId===config.head&&v.base.commitId===config.base&&/^[a-f0-9]{64}$/.test(v.fingerprint));});};
  let ack=page.waitForResponse(r=>r.url().endsWith('/GetPullRequestMergeObservation'));
  stage='explicit protected observation';await page.getByRole('button',{name:'Inspect merge observations',exact:true}).click();await validate(await ack);await panel.getByText('Native merge observations',{exact:true}).waitFor();check(reads===1);await panel.getByText('Native merge observations',{exact:true}).click();
  await panel.getByText('Target branch is protected.',{exact:false}).waitFor();check((await panel.innerText()).includes('Live source matches the selected head.'));check(await panel.getByRole('button',{name:/^Merge/}).count()===0);
  stage='exact selected and live receipts';const full=await panel.innerText();check(full.includes(config.fingerprintReason));for(const id of [config.head,config.base])check(await panel.locator('code[title="'+id+'"]').count()>=1);
  stage='explicit refresh';ack=page.waitForResponse(r=>r.url().endsWith('/GetPullRequestMergeObservation'));await page.getByRole('button',{name:'Refresh merge observation',exact:true}).click();await validate(await ack);await panel.getByText('Native merge observations',{exact:true}).waitFor();check(reads===2);await panel.getByText('Native merge observations',{exact:true}).click();
  await page.evaluate(()=>document.fonts.ready);check(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));check(errors.length===0&&!invalid);await panel.scrollIntoViewIfNeeded();
  const file='merge-observation-'+theme+'-'+width+'.png';await page.screenshot({path:join(config.output,file),fullPage:true});const metrics=await page.evaluate(()=>({documentWidth:document.documentElement.scrollWidth,viewportWidth:innerWidth,theme:document.documentElement.dataset.theme}));captures.push({file,theme,width,metrics,observationReads:reads,pageErrors:errors.length});
  check((await context.request.post(config.golf+'/rpc/golf.v1.SessionService/Logout',{maxRedirects:0,headers,data:{}})).status()===200);await context.close();contexts=contexts.filter(c=>c!==context);
 }
 stage='private denial after native role removal';const context=await browser.newContext({viewport:{width:390,height:1000}});contexts.push(context);check((await context.request.post(config.golf+'/rpc/golf.v1.SessionService/LoginWithPassword',{maxRedirects:0,headers,data:{username:config.email,password:config.password}})).status()===200);
 const page=await context.newPage();page.on('pageerror',()=>allErrors.push(true));await page.goto(config.golf+'/'+config.repository+'/pull/'+config.number);const panel=page.getByRole('region',{name:'Pull request merge observation',exact:true});await page.getByRole('button',{name:'Inspect merge observations',exact:true}).click();await panel.getByText('Native merge observations',{exact:true}).waitFor();
 check((await context.request.delete(config.native+'/api/v1/repos/'+config.repository+'/collaborators/'+config.login,{maxRedirects:0,headers:{Authorization:'token '+config.ownerToken}})).status()===204);
 const refresh=page.getByRole('button',{name:'Refresh merge observation',exact:true});let denialVia='live';if(await refresh.count()){try{await refresh.click({timeout:1500});denialVia='explicit_refresh';}catch{await panel.waitFor({state:'detached'});}}await page.getByRole('heading',{name:config.title+' #'+config.number,exact:true}).waitFor({state:'detached'});check(!(await page.locator('body').innerText()).includes(config.bodyMarker));await panel.waitFor({state:'detached'});check(allErrors.length===0);
 await writeFile(join(config.output,'browser-manifest.json'),JSON.stringify({status:'browser_checks_passed_parent_cleanup_pending',runtime:config.runtime,captures,privateDenialCleared:true,privateDenialVia:denialVia,scope:'Explicit protected observation only; no merge publication'},null,2),{mode:0o600});
 console.log('PASS: four actual merge observation captures, explicit read/refresh and private denial; parent cleanup pending');
}catch{console.error('Merge observation browser failed at '+stage+'; private diagnostics withheld');process.exitCode=1;}
finally{for(const c of contexts)if(config)try{check((await c.request.post(config.golf+'/rpc/golf.v1.SessionService/Logout',{maxRedirects:0,headers:{Origin:config.golf,'Content-Type':'application/json','Connect-Protocol-Version':'1'},data:{}})).status()===200);}catch{process.exitCode=1;}await browser?.close();}
'''


def self_check():
    for value in ('http://127.0.0.1:8080','https://localhost:8443','http://[::1]:8080'):
        assert loopback(value)==value
    for value in ('http://foreign.invalid:80','http://127.0.0.1:80/path','http://u:p@localhost:80','http://localhost:80?token=x','http://localhost:80#fragment','http://localhost:80\n','file:///tmp'):
        try: loopback(value)
        except (AssertionError,ValueError): pass
        else: raise AssertionError('Nonlocal/credential-bearing URL admitted')
    row=[{'ref':'refs/heads/feature/topic','object':{'type':'commit','sha':'a'*40}}]
    assert exact_ref(row,'feature/topic')=='a'*40
    for wrong in ([],row+row,[{**row[0],'ref':'refs/heads/feature/topic-extra'}],[{'ref':row[0]['ref'],'object':{'type':'tag','sha':'a'*40}}]):
        try: exact_ref(wrong,'feature/topic')
        except (AssertionError,KeyError): pass
        else: raise AssertionError('Ambiguous native namespace admitted')
    prefix='golf-mergeobs-'+('a'*10)
    for method,path in (('GET','version'),('POST','user/repos'),('GET','repos/'+prefix+'-owner/private'),('POST','repos/'+prefix+'-owner/private/pulls'),('PATCH','repos/'+prefix+'-owner/private/pulls/1'),('GET','repos/'+prefix+'-owner/private/git/refs/heads/feature%2Ftopic')):
        assert native_path_allowed(method,path,prefix)
    for method,path in (('POST','repos/'+prefix+'-owner/private/pulls/1/merge'),('PUT','repos/'+prefix+'-owner/private/git/refs/heads/main'),('DELETE','repos/foreign/private'),('POST','admin/users'),('POST','repos/'+prefix+'-owner/private/actions/runs'),('GET','repos/'+prefix+'-owner/private/../other')):
        assert not native_path_allowed(method,path,prefix)
    selected={'selection':{'repository':{'owner':'owner','name':'private'},'repositoryId':'1','pullRequestId':'9','number':1,'headCommitId':'a'*40,'baseCommitId':'b'*40},'expectedPullRevision':'fixed','headRef':'feature/topic'}
    branch={'name':'main','protected':False,'user_can_merge':False,'commit':{'id':'b'*40}}
    raw={'owner':{'id':2},**{name:False for name in STRATEGIES},'default_merge_style':'merge','default_update_style':'merge'}
    source={'owner':'author','name':'private'}
    v={'selection':copy.deepcopy(selected['selection']),'pullRevision':'fixed','targetOwnerId':'2','fingerprint':'c'*64,'observedAt':'2026-10-04T12:00:00Z','unavailableReason':'protected_integration_unqualified','targetProtection':'PULL_MERGE_TARGET_PROTECTION_UNPROTECTED','nativeCallerCanMerge':False,'currentTargetWriter':False,'base':{'kind':'REPOSITORY_SOURCE_REF_KIND_BRANCH','name':'main','commitId':'b'*40},'mergeConfiguration':{'defaultMergeStyle':'merge','defaultUpdateStyle':'merge'},'sourceRepositoryId':'3','sourceRepository':source,'source':{'kind':'REPOSITORY_SOURCE_REF_KIND_BRANCH','name':'feature/topic','commitId':'a'*40},'sourceState':'PULL_MERGE_SOURCE_STATE_CURRENT'}
    assert receipt({'observation':v},selected,branch,raw,3,source,'a'*40)['currentTargetWriter'] is False
    for change in ('repository','revision','sourceIdentity','sourceCommit','sourceState','nativeFlag','writerPresence','configuration','fingerprint'):
        bad=copy.deepcopy(v)
        if change=='repository':bad['selection']['repositoryId']='4'
        if change=='revision':bad['pullRevision']='changed'
        if change=='sourceIdentity':bad['sourceRepositoryId']='4'
        if change=='sourceCommit':bad['source']['commitId']='d'*40
        if change=='sourceState':bad['sourceState']='PULL_MERGE_SOURCE_STATE_CHANGED'
        if change=='nativeFlag':del bad['nativeCallerCanMerge']
        if change=='writerPresence':del bad['currentTargetWriter']
        if change=='configuration':bad['mergeConfiguration']['allowManualMerge']=True
        if change=='fingerprint':bad['fingerprint']='c'*63
        try:receipt({'observation':bad},selected,branch,raw,3,source,'a'*40)
        except (AssertionError,KeyError):pass
        else:raise AssertionError('Mismatched observation admitted')
    denied=copy.deepcopy(v);denied['sourceState']='PULL_MERGE_SOURCE_STATE_UNAVAILABLE'
    for key in ('source','sourceRepository','sourceRepositoryId'):denied.pop(key)
    receipt({'observation':denied},selected,branch,raw,3,source,None)
    denied['sourceRepositoryId']='3'
    try:receipt({'observation':denied},selected,branch,raw,3,source,None)
    except AssertionError:pass
    else:raise AssertionError('Denied source identity leaked')
    url='http://127.0.0.1:8080/rpc/golf.v1.'+SERVICE
    secret='PRIVATE_FIXTURE_TOKEN'
    diagnostic=http_diagnostic('POST',url,400,200,json.dumps({'code':'failed_precondition','message':secret,'details':[secret]}).encode())
    assert diagnostic=={'procedure':SERVICE,'method':'POST','status':400,'expectedStatus':200,'code':'failed_precondition','category':'unexpected_status'} and secret not in json.dumps(diagnostic)
    for raw in (json.dumps({'code':secret}).encode(), b'invalid JSON '+secret.encode(), b'[]',json.dumps({'code':{'private':secret}}).encode()):
        assert http_diagnostic('POST',url,503,200,raw)['code']=='unavailable_code'
    assert http_diagnostic('DELETE','http://localhost:8080/api/v1/repos/'+secret+'/private',404,204,b'')['procedure']=='native_api'
    class Response:
        status=400;headers={'Cache-Control':'no-store'}
        def __enter__(self):return self
        def __exit__(self,*unused):pass
        def read(self,size):return json.dumps({'code':'failed_precondition','message':secret}).encode()
    class Opener:
        def open(self,*unused,**ignored):return Response()
    try:request(Opener(),'POST',url,{}, {},200)
    except HTTPContractFailure as error:assert error.diagnostic==diagnostic and secret not in str(error)
    else:raise AssertionError('Unexpected HTTP status did not fail')
    syntax=subprocess.run(['node','--input-type=module','--check'],input=BROWSER,text=True,capture_output=True,timeout=10)
    assert syntax.returncode==0
    print('PASS: pure URL/namespace, closed native API vocabulary, exact observation/tamper/privacy and browser syntax checks; no runtime')


def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('--self-check',action='store_true');p.add_argument('--stack-root',type=Path);p.add_argument('--project');p.add_argument('--compose-file',type=Path);p.add_argument('--env-file',type=Path)
    p.add_argument('--image');p.add_argument('--source-revision');p.add_argument('--golf-url');p.add_argument('--native-url');p.add_argument('--output',type=Path);p.add_argument('--browser',action='store_true')
    args=p.parse_args()
    if args.self_check:return self_check()
    assert all((args.stack_root,args.project,args.image,args.source_revision,args.golf_url,args.native_url,args.output))
    assert PROJECT.fullmatch(args.project) and re.fullmatch(r'sha256:[a-f0-9]{64}',args.image) and re.fullmatch(r'[a-f0-9]{40}',args.source_revision)
    stack=args.stack_root.resolve();golf,native_url=loopback(args.golf_url),loopback(args.native_url)
    compose_file=(args.compose_file or stack/'compose.yaml').resolve();env_file=(args.env_file or stack/'.env').resolve();assert compose_file.is_file() and env_file.is_file()
    output=args.output.resolve();output.mkdir(mode=0o700,parents=True,exist_ok=False);os.chmod(output,0o700)
    compose=['docker','compose','--project-directory',str(stack),'-p',args.project,'-f',str(compose_file),'--env-file',str(env_file)]
    prefix='golf-mergeobs-'+secrets.token_hex(5);actors={};repos=[];bearers=[];stage='runtime preflight';failure=None;cleanup=[];runtime={};facts=[];native_unknown=False
    manifest={'status':'running','scope':'Current native observations only; no merge POST','fixturePrefix':prefix,'project':args.project,'capturesRequested':args.browser,'limits':['No fault-proxy mid-read race proof','No same-key publication/merge dispatch','No protected integration or P0.8 readiness']}
    def persist():
        manifest['fixtureActors']=[{k:a[k] for k in ('name','id','created','enrolled') if k in a} for a in actors.values()];
        path=output/'manifest.json';temp=output/'manifest.next';temp.write_text(json.dumps(manifest,indent=2)+'\n');os.chmod(temp,0o600);temp.replace(path)
    def command(arguments,payload=None):
        done=subprocess.run(arguments,cwd=stack,input=None if payload is None else json.dumps(payload),text=True,capture_output=True,timeout=60)
        assert len(done.stdout)<=2<<20 and len(done.stderr)<=2<<20 and done.returncode==0
        return done.stdout.strip()
    def admin(*parts):return command(compose+['exec','-T','gitea','gitea','--config','/etc/gitea/app.ini','admin','user',*parts])
    def operator(action,payload):
        result=json.loads(command(compose+['exec','-T','golf','/usr/local/bin/golf','local-account',action],payload));assert result['state']=='complete';return result['result']
    def rpc(actor,method,payload=None,status=200,code=None,extra=None):
        result=request(actor['session'] if actor else client(),'POST',golf+'/rpc/golf.v1.'+method,{} if payload is None else payload,{'Origin':golf,'Content-Type':'application/json','Connect-Protocol-Version':'1',**(extra or {})},status)
        if status!=200:assert result['code']==code
        return result
    def api(actor,method,path,payload=None,status=200):
        nonlocal native_unknown
        assert native_path_allowed(method,path,prefix)
        if method not in ('GET','HEAD'):native_unknown=True
        result=request(client(),method,native_url+'/api/v1/'+path,payload,{'Content-Type':'application/json',**({'Authorization':'token '+actor['token']} if actor else {})},status)
        if method not in ('GET','HEAD'):native_unknown=False
        return result
    def selected(actor,target,number):
        row=rpc(actor,'RepositoryService/GetPullRequest',{'repository':target,'number':number})['pullRequest']
        selection={'repository':target,'repositoryId':str(repo['id']),'pullRequestId':row['id'],'number':number,'headCommitId':row['head']['commitId'],'baseCommitId':row['base']['commitId']}
        return {'selection':selection,'expectedPullRevision':row['revision'],'headRef':row['head']['ref']}
    def inspect(actor,intent):return rpc(actor,SERVICE,{k:v for k,v in intent.items() if k!='headRef'})
    def runtime_now():
        container=command(compose+['ps','-q','golf']);assert re.fullmatch(r'[a-f0-9]{64}',container)
        raw=json.loads(command(['docker','inspect','--format','{"id":{{json .Id}},"image":{{json .Image}},"project":{{json (index .Config.Labels "com.docker.compose.project")}},"service":{{json (index .Config.Labels "com.docker.compose.service")}},"running":{{json .State.Running}},"configHash":{{json (index .Config.Labels "com.docker.compose.config-hash")}}}',container]))
        image=json.loads(command(['docker','image','inspect','--format','{"id":{{json .Id}},"source":{{json (index .Config.Labels "org.opencontainers.image.revision")}}}',args.image]))
        assert raw['id']==container and raw['project']==args.project and raw['service']=='golf' and raw['running'] and raw['image']==args.image and image['source']==args.source_revision
        return {**raw,'imageInspectId':image['id'],'sourceRevision':image['source']}
    try:
        persist();runtime=runtime_now();manifest['runtime']=runtime
        assert request(client(),'GET',golf+'/readyz',None,{},200)
        assert api(None,'GET','version')['version']=='1.27.3'
        stage='ordinary native actors and managed enrollment'
        for role in ('owner','author','writer','reader','outsider'):
            name=prefix+'-'+role;actor={'name':name,'created':False,'enrolled':False,'session':client(),'loggedIn':False};actors[role]=actor
            api(None,'GET','users/'+name,status=404)
            native_unknown=True
            admin('create','--username',name,'--email',name+'@example.invalid','--random-password','--must-change-password=false');actor['created']=True
            native_created=api(None,'GET','users/'+name);assert native_created['login']==name
            actor['id']=str(native_created['id']);native_unknown=False;persist()
            actor['token']=admin('generate-access-token','--username',name,'--token-name',prefix,'--scopes','write:user,write:repository,read:issue','--raw')
            native_actor=api(actor,'GET','user');assert native_actor['login']==name and native_actor['is_admin'] is False
            assert str(native_actor['id'])==actor['id']
            actor.update(email=name+'@golf.invalid',password='Fixture '+secrets.token_urlsafe(24))
            actor['enrolled']=True;operator('create',{'username':name,'email':actor['email'],'password':actor['password'],'forge_token':actor['token'],'is_instance_admin':False})
            user=rpc(actor,'SessionService/LoginWithPassword',{'username':actor['email'],'password':actor['password']})['user'];assert user['id']==actor['id'] and user['login']==name;actor['loggedIn']=True
        owner,author,writer,reader,outsider=[actors[r] for r in actors]
        stage='private source and target fixtures'
        repo=api(owner,'POST','user/repos',{'name':'private','private':True,'auto_init':True},201);target={'owner':owner['name'],'name':'private'};path='repos/'+repo['full_name'];repos.append((owner,repo));assert repo['full_name']==owner['name']+'/private' and str(repo['owner']['id'])==owner['id'] and decimal(str(repo['id']))
        deadline=time.monotonic()+45
        while api(owner,'GET',path)['empty']:
            assert time.monotonic()<deadline;time.sleep(.25)
        for actor,permission in ((author,'write'),(writer,'write'),(reader,'read')):api(owner,'PUT',path+'/collaborators/'+actor['name'],{'permission':permission},204)
        fork=api(author,'POST',path+'/forks',{},202);repos.append((author,fork));source_path='repos/'+fork['full_name'];source_key={'owner':author['name'],'name':fork['name']};assert fork['full_name']==author['name']+'/private' and fork['name']=='private' and str(fork['owner']['id'])==author['id'] and decimal(str(fork['id']))
        deadline=time.monotonic()+45
        while api(author,'GET',source_path)['empty']:
            assert time.monotonic()<deadline;time.sleep(.25)
        for actor in (owner,writer,reader):api(author,'PUT',source_path+'/collaborators/'+actor['name'],{'permission':'read'},204)
        branch='feature/topic';api(author,'POST',source_path+'/branches',{'new_branch_name':branch},201)
        content=api(author,'POST',source_path+'/contents/fixture.txt',{'branch':branch,'message':'Owned observation source','content':base64.b64encode(b'owned observation\n').decode()},201)
        head=content['commit']['sha'];title='Owned merge observation fixture';body_marker='OWNED MERGE OBSERVATION BODY'
        pull=api(author,'POST',path+'/pulls',{'head':author['name']+':'+branch,'base':repo['default_branch'],'title':title,'body':body_marker},201);number=pull['number']
        deadline=time.monotonic()+30
        while True:
            rows=api(owner,'GET',path+'/commits?sha=refs%2Fpull%2F'+str(number)+'%2Fhead&limit=1&stat=false&files=false&verification=false')
            if rows and rows[0]['sha']==head:break
            assert time.monotonic()<deadline;time.sleep(.25)
        intent=selected(owner,target,number);assert intent['selection']['headCommitId']==head
        base=exact_ref(api(owner,'GET',path+'/git/refs/heads/'+urllib.parse.quote(repo['default_branch'],safe='')),repo['default_branch']);assert intent['selection']['baseCommitId']==base
        source_head=exact_ref(api(author,'GET',source_path+'/git/refs/heads/feature%2Ftopic'),branch);assert source_head==head
        native_pull=api(owner,'GET',path+'/pulls/'+str(number));assert str(native_pull['id'])==intent['selection']['pullRequestId'] and native_pull['number']==number and native_pull['head']['sha']==head and native_pull['base']['sha']==base and str(native_pull['head']['repo']['id'])==str(fork['id']) and str(native_pull['base']['repo']['id'])==str(repo['id'])
        stage='independent native unprotected observations'
        for actor in (owner,writer,reader):
            actor_intent=selected(actor,target,number);native_branch=api(actor,'GET',path+'/branches/'+urllib.parse.quote(repo['default_branch'],safe=''));raw_repo=api(actor,'GET',path)
            v=receipt(inspect(actor,actor_intent),actor_intent,native_branch,raw_repo,fork['id'],source_key,source_head)
            assert v['currentTargetWriter'] is (actor is not reader) and v['targetProtection']=='PULL_MERGE_TARGET_PROTECTION_UNPROTECTED'
            facts.append({'actor':actor['name'],'protection':v['targetProtection'],'writer':v['currentTargetWriter'],'nativeCallerCanMerge':v['nativeCallerCanMerge'],'H':head,'B':base})
        manifest['facts']=facts;persist()
        stage='private source separately denied'
        api(author,'DELETE',source_path+'/collaborators/'+reader['name'],status=204)
        api(reader,'GET',source_path,status=404)
        reader_intent=selected(reader,target,number)
        receipt(inspect(reader,reader_intent),reader_intent,api(reader,'GET',path+'/branches/'+urllib.parse.quote(repo['default_branch'],safe='')),api(reader,'GET',path),fork['id'],source_key,None)
        api(author,'PUT',source_path+'/collaborators/'+reader['name'],{'permission':'read'},204)
        stage='native protected branch readback'
        rule=api(owner,'POST',path+'/branch_protections',{'rule_name':repo['default_branch'],'enable_push':False,'enable_force_push':False,'enable_merge_whitelist':True,'merge_whitelist_usernames':[owner['name']],'block_admin_merge_override':True},201)
        assert rule['rule_name']==repo['default_branch'] and rule['enable_merge_whitelist'] is True
        for role,actor in (('owner',owner),('writer',writer),('reader',reader)):
            stage='native protected branch readback '+role
            actor_intent=selected(actor,target,number);v=receipt(inspect(actor,actor_intent),actor_intent,api(actor,'GET',path+'/branches/'+urllib.parse.quote(repo['default_branch'],safe='')),api(actor,'GET',path),fork['id'],source_key,source_head)
            assert v['targetProtection']=='PULL_MERGE_TARGET_PROTECTION_PROTECTED'
            facts.append({'actor':actor['name'],'protection':v['targetProtection'],'writer':v['currentTargetWriter'],'nativeCallerCanMerge':v['nativeCallerCanMerge'],'H':head,'B':base})
        stage='browser-only authority and exact original selection'
        body={k:v for k,v in intent.items() if k!='headRef'}
        rpc(outsider,SERVICE,body,404,'not_found');rpc(None,SERVICE,body,401,'unauthenticated')
        rpc(owner,SERVICE,body,403,'permission_denied',{'Origin':'https://foreign.invalid'})
        credential=rpc(owner,'ApiCredentialService/CreateApiCredential',{'label':prefix,'lifetimeSeconds':300});bearers.append((owner,credential['credential']['id']))
        rpc(None,SERVICE,body,403,'permission_denied',{'Authorization':'Bearer '+credential['token']})
        wrong=copy.deepcopy(body);wrong['selection']['repositoryId']=str(int(repo['id'])+1);rpc(owner,SERVICE,wrong,400,'failed_precondition')
        if args.browser:
            stage='actual browser activation refresh and private denial'
            config={'stackRoot':str(stack),'golf':golf,'native':native_url,'repository':repo['full_name'],'number':number,'login':reader['name'],'email':reader['email'],'password':reader['password'],'ownerToken':owner['token'],'head':head,'base':base,'title':title,'bodyMarker':body_marker,'fingerprintReason':'These separate reads do not reserve','output':str(output),'runtime':runtime,'intent':body,'sourceRepositoryId':str(fork['id'])}
            native_unknown=True  # Browser revokes one native grant; ACK failure is conservative.
            result=subprocess.run(['node','--input-type=module','-e',BROWSER],input=json.dumps(config),cwd=stack,text=True,capture_output=True,timeout=180)
            assert result.returncode==0 and all(secret not in result.stdout+result.stderr for actor in actors.values() for secret in (actor['token'],actor['password']))
            browser_manifest=json.loads((output/'browser-manifest.json').read_text());assert browser_manifest['status']=='browser_checks_passed_parent_cleanup_pending' and len(browser_manifest['captures'])==4
            assert browser_manifest['privateDenialCleared'] is True
            native_unknown=False
            manifest['browser']=browser_manifest
            api(reader,'GET',path,status=404)
            api(owner,'PUT',path+'/collaborators/'+reader['name'],{'permission':'read'},204)
        stage='changed PR revision refuses original selection'
        api(owner,'PATCH',path+'/pulls/'+str(number),{'title':title+' updated'},201)
        revised=selected(owner,target,number);assert revised['expectedPullRevision']!=body['expectedPullRevision']
        rpc(owner,SERVICE,body,400,'failed_precondition')
        body={k:v for k,v in revised.items() if k!='headRef'}
        stage='native source drift refuses original selection'
        changed=api(author,'PUT',source_path+'/contents/fixture.txt',{'branch':branch,'sha':content['content']['sha'],'message':'Advance owned source','content':base64.b64encode(b'advanced owned observation\n').decode()})
        next_head=changed['commit']['sha'];assert next_head!=head
        deadline=time.monotonic()+30
        while selected(owner,target,number)['selection']['headCommitId']!=next_head:
            assert time.monotonic()<deadline;time.sleep(.25)
        rpc(owner,SERVICE,body,400,'failed_precondition')
        stage='native target grant removal and parent logout'
        api(owner,'DELETE',path+'/collaborators/'+writer['name'],status=204)
        rpc(writer,SERVICE,{k:v for k,v in selected(owner,target,number).items() if k!='headRef'},404,'not_found')
        rpc(reader,'SessionService/Logout');reader['loggedIn']=False
        rpc(reader,SERVICE,body,401,'unauthenticated')
        assert runtime_now()==runtime
        manifest.update(status='checks_passed_cleanup_pending',facts=facts,selection=body,sourceRepositoryId=str(fork['id']),sourceRepository=source_key,nativeSourceAdvancedTo=next_head,initialFanout='none unless --browser actually passed')
        persist()
    except Exception as error:
        failure={'stage':stage,'type':type(error).__name__,'frames':[]}
        if isinstance(error,HTTPContractFailure):failure['http']=error.diagnostic
        trace=error.__traceback__
        while trace:
            failure['frames'].append({'file':Path(trace.tb_frame.f_code.co_filename).name,'line':trace.tb_lineno});trace=trace.tb_next
        manifest.update(status='failed',failure=failure);persist()
    finally:
        # Each account/session/native actor is this invocation's unique namespace.
        # Never remove a provider name whose immutable ID was replaced.
        for actor,cid in bearers:
            try:rpc(actor,'ApiCredentialService/RevokeApiCredential',{'credentialId':cid})
            except Exception:cleanup.append('bearer_revocation')
        for actor in actors.values():
            if actor['loggedIn']:
                try:rpc(actor,'SessionService/RevokeOtherSessions');rpc(actor,'SessionService/Logout')
                except Exception:cleanup.append('managed_session_cleanup')
        for actor in reversed(list(actors.values())):
            if actor['enrolled']:
                try:assert operator('disable',{'username':actor['name']})['disabled']
                except Exception:cleanup.append('managed_account_disable')
        if native_unknown:
            cleanup.append('native_mutation_unconfirmed_root_disposal_required')
        else:
            for actor,row in reversed(repos):
                if native_unknown:break
                try:
                    observed=api(actor,'GET','repos/'+row['full_name']);assert observed['id']==row['id'] and observed['full_name']==row['full_name']
                    api(actor,'DELETE','repos/'+row['full_name'],status=204)
                except Exception:cleanup.append('owned_repository_cleanup')
            for actor in reversed(list(actors.values())):
                if native_unknown:break
                if actor['created']:
                    try:
                        observed=api(None,'GET','users/'+actor['name']);assert str(observed['id'])==actor.get('id') and observed['login']==actor['name'];admin('delete','--username',actor['name'],'--purge')
                    except Exception:cleanup.append('owned_native_actor_cleanup')
        if native_unknown and 'native_mutation_unconfirmed_root_disposal_required' not in cleanup:cleanup.append('native_mutation_unconfirmed_root_disposal_required')
        manifest['cleanup']={'failures':cleanup,'fixtureAccountsDisabled':not any(x=='managed_account_disable' for x in cleanup),'nativeScopePurged':not any('native_' in x or 'repository_' in x for x in cleanup),'retainedGolfMetadata':'Disabled account and audit/session history retained; no full Golf data purge claimed','stackResources':'Parent owns stack disposal; this helper never mutates Compose resources'}
        if cleanup:manifest['status']='failed'
        elif failure is None:manifest['status']='qualified_bounded_observations'
        persist()
    if failure or cleanup:
        print('FAIL: merge observation qualifier; closed stage/type/cleanup recorded, private diagnostics withheld',file=sys.stderr);return 1
    print('PASS: bounded native merge observations; owned fixture cleanup complete, full P0.8 remains open');return 0

if __name__=='__main__':
    try:sys.exit(main() or 0)
    except Exception:
        print('FAIL: merge observation qualifier preflight; private diagnostics withheld',file=sys.stderr);sys.exit(1)
