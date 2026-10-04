#!/usr/bin/env python3
"""Prepared actual disposable repository-invitation qualification; root executes.

Require --image (already built/revision labelled) and a NEW --output. No image
build/pull, retained configuration, native SQL/ref writes, CI or inference.
--ui adds 12 real Access/editor/inbox captures. --self-check is entirely pure.
Browser response loss is not native PUT acknowledgement-loss qualification.
"""
import argparse
import base64
import datetime
import importlib.util
import json
import os
from pathlib import Path
import re
import secrets
import subprocess
import sys
import tempfile
import time
import traceback
import urllib.error
import urllib.request
import uuid

sys.dont_write_bytecode = True
import smoke
ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('invitation_shared_qualification', ROOT/'scripts/repository-team-access-smoke.py')
common = importlib.util.module_from_spec(spec); spec.loader.exec_module(common)
common.PROOF = {'status':'not_started','cleanup':'not_started','captures':[], 'scope':'Existing native recipients and explicit local-issuer consent; full Access, native atomic CAS, native/SQL acknowledgement-loss repair, email identities and recovery remain open', 'nativeSources':['https://raw.githubusercontent.com/go-gitea/gitea/v1.27.3/routers/api/v1/repo/collaborators.go','https://raw.githubusercontent.com/go-gitea/gitea/v1.27.3/services/repository/collaboration.go']}
PROOF = common.PROOF
record, stage, checked_rpc = common.record, common.stage, common.checked_rpc
SERVICE = 'RepositoryInvitationService/'
positive = lambda v: isinstance(v,str) and re.fullmatch(r'[1-9][0-9]{0,18}',v) and int(v)<=9223372036854775807
revision = lambda v: isinstance(v,str) and re.fullmatch(r'[a-f0-9]{64}',v)
key = lambda: str(uuid.uuid4())
BINDINGS = {}


def invitation(row, recipient=None, repository=None, hidden=False):
    assert str(uuid.UUID(row['id']))==row['id'] and uuid.UUID(row['id']).version==4 and positive(row['revision'])
    assert row['state'] in {'PENDING','GRANTING','ACCEPTED','REJECTED','REVOKED','EXPIRED'}
    for name in ('createdAt','expiresAt'): datetime.datetime.fromisoformat(row[name].replace('Z','+00:00'))
    if hidden:
        assert not row.get('detailsAvailable',False)
        assert not any(name in row for name in ('repository','repositoryId','ownerId','issuer','recipient','permission','organizationOwned'))
    else:
        assert row['detailsAvailable'] and positive(row['repositoryId']) and positive(row['ownerId'])
        assert row['permission'] in {'read','write','admin'} and positive(row['issuer']['id']) and positive(row['recipient']['id'])
        if recipient: assert row['recipient']['id']==recipient['id']
        if repository: assert row['repository']==repository['key'] and row['repositoryId']==repository['id'] and row['ownerId']==repository['ownerId']
        binding=(row['repositoryId'],row['ownerId'],row['recipient']['id'])
        assert row['id'] not in BINDINGS or BINDINGS[row['id']]==binding
        BINDINGS[row['id']]=binding
    return row


def operation(row, original, phase):
    assert row['idempotencyKey']==original['idempotencyKey'] and row['invitationId']==original['invitationId'] and row['invitationRevision']==original['expectedRevision'] and row['phase']==phase
    assert positive(row['repositoryId']) and positive(row['ownerId']) and positive(row['recipientId'])
    assert (row['repositoryId'],row['ownerId'],row['recipientId'])==BINDINGS[original['invitationId']]
    assert row.get('failureCode','')==('preflight_refused' if phase=='REJECTED' else '')
    return row


def self_check():
    source=(ROOT/'api/golf/v1/golf.proto').read_text()
    for method in ('PreviewRepositoryInvitationRecipient','CreateRepositoryInvitation','ListRepositoryInvitations','ListOwnRepositoryInvitations','RespondRepositoryInvitation','RevokeRepositoryInvitation','GetRepositoryInvitationOperation'):assert 'rpc '+method+'(' in source
    for message,fields in {'CreateRepositoryInvitationRequest':[('string','recipient_id',5),('string','recipient_revision',7),('bool','persistent_consent',10),('string','idempotency_key',11)],'ListRepositoryInvitationsResponse':[('bool','can_manage',6),('bool','local_issuer_available',7)],'RespondRepositoryInvitationRequest':[('string','invitation_id',1),('string','expected_revision',2),('RepositoryInvitationDecision','decision',3),('string','idempotency_key',4)]}.items():
        body=re.search(r'message '+message+r'\s*\{([^}]+)\}',source).group(1)
        for kind,name,tag in fields:assert re.search(re.escape(kind)+r'\s+'+name+r'\s*=\s*'+str(tag)+r'\s*;',body)
    original={'idempotencyKey':key(),'invitationId':key(),'expectedRevision':'1'}
    row={**original,'invitationRevision':'1','phase':'DISPATCH_UNKNOWN','repositoryId':'7','ownerId':'9','recipientId':'11'}
    BINDINGS[original['invitationId']]=('7','9','11')
    operation(row,original,'DISPATCH_UNKNOWN')
    for field in ('idempotencyKey','invitationId','invitationRevision','repositoryId','ownerId','recipientId'):
        bad={**row,field:'wrong'}
        try:operation(bad,original,'DISPATCH_UNKNOWN')
        except (AssertionError,ValueError):pass
        else:raise AssertionError('Wrong original operation accepted')
    for field,value in (('repositoryId','8'),('ownerId','10'),('recipientId','12')):
        try:operation({**row,field:value},original,'DISPATCH_UNKNOWN')
        except AssertionError:pass
        else:raise AssertionError('Canonical but foreign original target accepted')
    hidden={'id':key(),'revision':'1','state':'EXPIRED','createdAt':'2026-10-04T12:00:00Z','expiresAt':'2026-10-04T13:00:00Z'}
    invitation(hidden,hidden=True)
    try:invitation({**hidden,'repositoryId':'7'},hidden=True)
    except AssertionError:pass
    else:raise AssertionError('Withheld target leaked')
    previous_output,previous_proof=common.OUTPUT,common.PROOF
    try:
        import io
        with tempfile.TemporaryDirectory(prefix='golf-invitation-pure-') as temporary:
            common.OUTPUT=Path(temporary);common.OUTPUT.chmod(0o700);common.PROOF={}
            class Response(io.BytesIO):status=403;headers={'Cache-Control':'no-store'}
            class Session:
                def open(self,request,timeout):return Response(b'{"code":"permission_denied","message":"PRIVATE_SENTINEL"}')
            checked_rpc(Session(),SERVICE+'RespondRepositoryInvitation',{},expected=403)
            assert 'PRIVATE_SENTINEL' not in (common.OUTPUT/'manifest.json').read_text()
            record(failedStage='original',failedProcedure=common.PROOF['lastProcedure'],cleanup='passed')
            try:checked_rpc(Session(),SERVICE+'RespondRepositoryInvitation',{})
            except AssertionError:pass
            else:raise AssertionError('Wrong HTTP acknowledgement accepted')
            assert common.PROOF['failedStage']=='original' and (common.OUTPUT/'manifest.json').stat().st_mode&0o777==0o600
    finally:common.OUTPUT,common.PROOF=previous_output,previous_proof
    print('PASS: pure invitation wire, immutable receipt, withheld metadata and safe failure-provenance checks; no runtime operations')


def main():
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('--self-check',action='store_true');parser.add_argument('--image');parser.add_argument('--output',type=Path);parser.add_argument('--ui',action='store_true');args=parser.parse_args()
    if args.self_check:self_check();return
    if not args.image or not args.output:parser.error('--image and a new --output are required')
    args.output.mkdir(parents=True,exist_ok=False,mode=0o700);args.output.chmod(0o700);common.OUTPUT=args.output.resolve();record(status='running',browser='pending' if args.ui else 'not_requested')
    if args.ui:assert (ROOT/'web/node_modules/playwright/index.mjs').is_file(),'Require existing local browser dependency; no installation'
    spec=importlib.util.spec_from_file_location('invitation_stack_helpers',ROOT/'scripts/observability-smoke.py');helpers=importlib.util.module_from_spec(spec);spec.loader.exec_module(helpers)
    environment={k:v for k,v in os.environ.items() if not k.startswith(('GOLF_','GITEA_','POSTGRES_','COMPOSE_','OTEL_','AWS_','RUSTFS_')) and k!='DATABASE_URL'}
    def run(*arguments,payload=None,timeout=180):
        result=subprocess.run(arguments,cwd=ROOT,env=environment,input=None if payload is None else json.dumps(payload).encode(),capture_output=True,timeout=timeout)
        assert result.returncode==0 and len(result.stdout)<=8<<20 and len(result.stderr)<=8<<20,'Private subprocess failure; output withheld'
        return result.stdout.decode().strip()
    stage('exact prebuilt product image and cached pinned base dependencies')
    selected=json.loads(run('docker','image','inspect',args.image))[0];image=selected['Id'];source=selected['Config'].get('Labels',{}).get('org.opencontainers.image.revision')
    assert re.fullmatch(r'sha256:[0-9a-f]{64}',image) and re.fullmatch(r'[0-9a-f]{40}',source or '')
    for name in ('postgres:18.4-alpine3.24','gitea/gitea:1.27.3-rootless'):run('docker','image','inspect',name)
    space=run('docker','run','--rm','--pull=never','--network=none','--read-only','--cap-drop=ALL','--security-opt=no-new-privileges','--entrypoint','/bin/df',image,'-Pk','/')
    assert int(space.splitlines()[-1].split()[3])>=2*1024*1024,'Require 2 GiB free VM disk before fresh fixture'
    project='golf-invitation-proof-'+secrets.token_hex(5);ports=helpers.free_ports(2);previous=smoke.GOLF,smoke.GITEA;smoke.GOLF,smoke.GITEA='http://127.0.0.1:'+str(ports[0]),'http://127.0.0.1:'+str(ports[1]);actors={};repositories={};organizations={};bearers=[];started=False;passed=False
    record(project=project,selectedImage=image,sourceRevision=source,cleanup='not_created')
    with tempfile.TemporaryDirectory(prefix=project+'-') as temporary:
        directory=Path(temporary);directory.chmod(0o700);values={k:secrets.token_hex(24) for k in ('POSTGRES_PASSWORD','GOLF_DB_PASSWORD','GITEA_DB_PASSWORD')};values.update(GOLF_ENCRYPTION_KEY=base64.b64encode(secrets.token_bytes(32)).decode(),GOLF_PUBLIC_URL=smoke.GOLF,GOLF_PUSH_CI_ENABLED='false')
        env_file,override=directory/'core.env',directory/'proof.yaml';helpers.private_write(env_file,''.join(k+'='+v+'\n' for k,v in values.items()));helpers.private_write(override,f'''services:
  golf:
    image: {image}
    pull_policy: never
    ports: !override ["127.0.0.1:{ports[0]}:8080"]
  gitea:
    environment:
      GITEA__server__ROOT_URL: {smoke.GITEA}/
    ports: !override ["127.0.0.1:{ports[1]}:3000"]
''')
        compose=['docker','compose','-p',project,'--env-file',str(env_file),'-f',str(ROOT/'compose.yaml'),'-f',str(override)]
        def command(*arguments,**kwargs):return run(*compose,*arguments,**kwargs)
        def admin(*arguments):return command('exec','-T','gitea','gitea','--config','/etc/gitea/app.ini','admin','user',*arguments)
        def operator(action,payload):
            result=json.loads(command('exec','-T','golf','/usr/local/bin/golf','local-account',action,payload=payload));assert result['state']=='complete';return result['result']
        def login(actor):
            actor['session']=smoke.client();u=checked_rpc(actor['session'],'SessionService/LoginWithPassword',{'username':actor['email'],'password':actor['password']})['user'];assert u['id']==actor['id'];actor['loggedIn']=True
        def runtime():
            container=command('ps','-q','golf');assert re.fullmatch(r'[0-9a-f]{12,64}',container);r=json.loads(run('docker','inspect','--format','{"image":{{json .Image}},"reference":{{json .Config.Image}},"revision":{{json (index .Config.Labels "org.opencontainers.image.revision")}},"composeConfigHash":{{json (index .Config.Labels "com.docker.compose.config-hash")}}}',container));assert r['image']==image and r['reference']==image and r['revision']==source;r['nativeVersion']=smoke.request(smoke.client(),'GET',smoke.GITEA+'/api/v1/version')['version'];assert r['nativeVersion']=='1.27.3';return r
        def call(actor,method,payload=None,**kwargs):return checked_rpc(actor['session'],SERVICE+method,payload,**kwargs)
        def create_repo(owner,name,organization=None):
            native=smoke.provider(owner['token'],'POST','orgs/'+organization+'/repos' if organization else 'user/repos',{'name':name,'private':True,'auto_init':True},201);r={'key':{'owner':native['owner']['login'],'name':native['name']},'name':native['full_name'],'id':str(native['id']),'ownerId':str(native['owner']['id']),'owner':owner};repositories[r['name']]=r;smoke.wait_for_push(owner['token'],r['name']);return r
        def member(repository,recipient,wanted):
            smoke.provider(repository['owner']['token'],'GET','repos/'+repository['name']+'/collaborators/'+recipient['name'],expected=204 if wanted else 404)
            if wanted:
                r=smoke.provider(repository['owner']['token'],'GET','repos/'+repository['name']+'/collaborators/'+recipient['name']+'/permission');assert str(r['user']['id'])==recipient['id'];return r['permission']
        def target(repository,actor):
            a=checked_rpc(actor['session'],'RepositoryAccessService/GetRepositoryAccess',{'repository':repository['key']})['access'];assert a['repositoryId']==repository['id'] and a['ownerId']==repository['ownerId'] and revision(a['revision']);return {'repository':repository['key'],'repositoryId':a['repositoryId'],'ownerId':a['ownerId'],'expectedRevision':a['revision']}
        def create(repository,issuer,recipient,seconds=3600):
            t=target(repository,issuer);before=member(repository,recipient,False);preview=call(issuer,'PreviewRepositoryInvitationRecipient',{**t,'username':recipient['name']});assert preview['repositoryId']==repository['id'] and preview['ownerId']==repository['ownerId'] and preview['accessRevision']==t['expectedRevision'];u=preview['recipient'];assert u['user']['id']==recipient['id'] and u['user']['login']==recipient['name'] and revision(u['revision']);payload={**t,'recipientId':recipient['id'],'recipientUsername':recipient['name'],'recipientRevision':u['revision'],'permission':'read','expiresAt':datetime.datetime.fromtimestamp(time.time()+seconds,datetime.timezone.utc).isoformat().replace('+00:00','Z'),'persistentConsent':True,'idempotencyKey':key()};r=invitation(call(issuer,'CreateRepositoryInvitation',payload)['invitation'],recipient,repository);assert r['state']=='PENDING' and r['revision']=='1';member(repository,recipient,False);return r,payload
        def respond(recipient,row,decision='REPOSITORY_INVITATION_DECISION_ACCEPT',**kwargs):
            original={'invitationId':row['id'],'expectedRevision':row['revision'],'decision':decision,'idempotencyKey':key()};return call(recipient,'RespondRepositoryInvitation',original,**kwargs),original
        def inspect(recipient,original,phase):return operation(call(recipient,'GetRepositoryInvitationOperation',{'invitationId':original['invitationId'],'idempotencyKey':original['idempotencyKey']})['operation'],original,phase)
        def own(recipient,identifier,hidden=False):
            r=call(recipient,'ListOwnRepositoryInvitations',{'page':{'page':1,'limit':20}});assert r.get('page',{}).get('nextPage',0)==0;rows=r.get('invitations',[]);assert len(rows)<=20 and len({x['id'] for x in rows})==len(rows);return invitation(next(x for x in rows if x['id']==identifier),recipient,hidden=hidden)
        try:
            stage('fresh base stack without CI or agents');started=True;record(cleanup='pending');command('up','-d','--no-build','--pull','never',timeout=180);smoke.ready();before=runtime();record(runtime=before)
            stage('ordinary native actors and managed local sessions')
            for role in ('owner','recipient','directadmin','outsider','golfadmin','expiryissuer','teamadmin'):
                actor={'role':role,'name':project+'-'+role,'created':False,'loggedIn':False};actors[role]=actor;admin('create','--username',actor['name'],'--email',actor['name']+'@example.invalid','--random-password','--must-change-password=false');actor['created']=True;actor['token']=admin('generate-access-token','--username',actor['name'],'--token-name',project,'--scopes','write:user,write:organization,write:repository','--raw');u=smoke.provider(actor['token'],'GET','user');assert not u['is_admin'];actor.update(id=str(u['id']),email=actor['name']+'@golf.invalid',password='Invitation fixture '+secrets.token_urlsafe(24));operator('create',{'username':actor['name'],'email':actor['email'],'password':actor['password'],'forge_token':actor['token'],'is_instance_admin':role=='golfadmin'});login(actor)
            owner,recipient,direct,outsider,golfadmin,expiryissuer,teamadmin=(actors[x] for x in ('owner','recipient','directadmin','outsider','golfadmin','expiryissuer','teamadmin'))
            expiry_repo=create_repo(owner,'expiry');expiring,_=create(expiry_repo,owner,recipient,65)
            stage('recipient ID/consent/stale target/Origin/bearer refuse before native grants')
            repo=create_repo(owner,'invitations');t=target(repo,owner);preview=call(owner,'PreviewRepositoryInvitationRecipient',{**t,'username':recipient['name']})['recipient'];payload={**t,'recipientId':recipient['id'],'recipientUsername':recipient['name'],'recipientRevision':preview['revision'],'permission':'read','expiresAt':datetime.datetime.fromtimestamp(time.time()+3600,datetime.timezone.utc).isoformat().replace('+00:00','Z'),'persistentConsent':True,'idempotencyKey':key()}
            for change,code in (({'persistentConsent':False},'invalid_argument'),({'recipientId':outsider['id']},'failed_precondition'),({'recipientRevision':'0'*64},'failed_precondition'),({'repositoryId':'9223372036854775807'},'failed_precondition'),({'expectedRevision':'0'*64},'failed_precondition')):call(owner,'CreateRepositoryInvitation',{**payload,**change,'idempotencyKey':key()},expected=400,code=code)
            for actor in (outsider,golfadmin):call(actor,'PreviewRepositoryInvitationRecipient',{**t,'username':recipient['name']},expected=404)
            row,_=create(repo,owner,recipient);call(owner,'RespondRepositoryInvitation',{'invitationId':row['id'],'expectedRevision':row['revision'],'decision':'REPOSITORY_INVITATION_DECISION_ACCEPT','idempotencyKey':key()},expected=404);member(repo,recipient,False)
            bearer=checked_rpc(owner['session'],'ApiCredentialService/CreateApiCredential',{'label':'Invitation boundary qualifier'});bearers.append((owner,bearer['credential']['id']))
            boundary={'PreviewRepositoryInvitationRecipient':{**t,'username':recipient['name']},'CreateRepositoryInvitation':payload,'ListRepositoryInvitations':{**t,'page':{'page':1,'limit':20}},'ListOwnRepositoryInvitations':{'page':{'page':1,'limit':20}},'RespondRepositoryInvitation':{'invitationId':row['id'],'expectedRevision':row['revision'],'decision':'REPOSITORY_INVITATION_DECISION_ACCEPT','idempotencyKey':key()},'RevokeRepositoryInvitation':{**t,'invitationId':row['id'],'invitationRevision':row['revision']},'GetRepositoryInvitationOperation':{'invitationId':row['id'],'idempotencyKey':key()}}
            for method,body in boundary.items():call(owner,method,body,headers={'Origin':'https://other.invalid'},expected=403);checked_rpc(smoke.client(),SERVICE+method,body,headers={'Authorization':'Bearer '+bearer['token']},expected=403)
            checked_rpc(owner['session'],'ApiCredentialService/RevokeApiCredential',{'credentialId':bearer['credential']['id']});bearers.clear();member(repo,recipient,False)
            stage('explicit issuer consent survives logout; exact success/replay has one observable grant')
            checked_rpc(owner['session'],'SessionService/Logout');owner['loggedIn']=False;result,original=respond(recipient,row);invitation(result['invitation'],recipient,repo);assert result['invitation']['state']=='ACCEPTED';op=operation(result['operation'],original,'SUCCEEDED');assert member(repo,recipient,True)=='read';assert inspect(recipient,original,'SUCCEEDED')==op;assert call(recipient,'RespondRepositoryInvitation',original)['operation']==op;call(recipient,'RespondRepositoryInvitation',{**original,'decision':'REPOSITORY_INVITATION_DECISION_REJECT'},expected=400,code='failed_precondition');login(owner)
            stage('reject and revoke never grant native access')
            for kind in ('reject','revoke'):
                r=create_repo(owner,kind);i,_=create(r,owner,recipient)
                if kind=='reject':result,original=respond(recipient,i,'REPOSITORY_INVITATION_DECISION_REJECT');assert result['invitation']['state']=='REJECTED';operation(result['operation'],original,'SUCCEEDED');inspect(recipient,original,'SUCCEEDED')
                else:result=call(owner,'RevokeRepositoryInvitation',{**target(r,owner),'invitationId':i['id'],'invitationRevision':i['revision']});assert result['invitation']['state']=='REVOKED';respond(recipient,i,expected=400,code='failed_precondition')
                member(r,recipient,False)
            stage('current target edit creates durable refusal; only explicit fresh intent may proceed')
            r=create_repo(owner,'stale');i,_=create(r,owner,recipient);smoke.provider(owner['token'],'PATCH','repos/'+r['name'],{'private':False});result,original=respond(recipient,i);operation(result['operation'],original,'REJECTED');assert inspect(recipient,original,'REJECTED')==result['operation'];assert call(recipient,'RespondRepositoryInvitation',original)['operation']==result['operation'];member(r,recipient,False);smoke.provider(owner['token'],'PATCH','repos/'+r['name'],{'private':True});result,fresh=respond(recipient,i);operation(result['operation'],fresh,'SUCCEEDED');assert fresh['idempotencyKey']!=original['idempotencyKey'];assert member(r,recipient,True)=='read'
            stage('direct-admin authority loss withholds details and grant; restore permits status-only refused receipt')
            r=create_repo(owner,'admin');smoke.provider(owner['token'],'PUT','repos/'+r['name']+'/collaborators/'+direct['name'],{'permission':'admin'},204);i,_=create(r,direct,recipient);smoke.provider(owner['token'],'DELETE','repos/'+r['name']+'/collaborators/'+direct['name'],expected=204);_,original=respond(recipient,i,expected=403);own(recipient,i['id'],hidden=True);member(r,recipient,False);smoke.provider(owner['token'],'PUT','repos/'+r['name']+'/collaborators/'+direct['name'],{'permission':'admin'},204);inspect(recipient,original,'REJECTED');result,fresh=respond(recipient,i);operation(result['operation'],fresh,'SUCCEEDED');assert member(r,recipient,True)=='read'
            stage('issuer account version and disable expire pending consent without native grant')
            for action in ('reset-password','disable'):
                r=create_repo(expiryissuer,'consent-'+action);i,_=create(r,expiryissuer,recipient);body={'username':expiryissuer['name']}
                if action=='reset-password':expiryissuer['password']='Replacement fixture '+secrets.token_urlsafe(24);body['password']=expiryissuer['password']
                operator(action,body);expiryissuer['loggedIn']=False;assert own(recipient,i['id'],hidden=True)['state']=='EXPIRED';respond(recipient,i,expected=400,code='failed_precondition');member(r,recipient,False)
                if action=='reset-password':login(expiryissuer)
            stage('renamed repository and replaced original route cannot grant the old immutable invitation')
            r=create_repo(owner,'original-identity');i,_=create(r,owner,recipient);old_name=r['name'];renamed=smoke.provider(owner['token'],'PATCH','repos/'+old_name,{'name':'renamed-identity'});assert str(renamed['id'])==r['id'] and str(renamed['owner']['id'])==r['ownerId'] and renamed['full_name']!=old_name
            del repositories[old_name];r['name']=renamed['full_name'];r['key']={'owner':renamed['owner']['login'],'name':renamed['name']};repositories[r['name']]=r
            replacement=create_repo(owner,'original-identity');assert replacement['id']!=r['id'];respond(recipient,i,expected=403);own(recipient,i['id'],hidden=True);member(r,recipient,False);member(replacement,recipient,False)
            stage('recipient logout prevents admission and cannot create a durable native grant')
            r=create_repo(owner,'recipient-session');i,_=create(r,owner,outsider);checked_rpc(outsider['session'],'SessionService/Logout');outsider['loggedIn']=False;respond(outsider,i,expected=401);member(r,outsider,False);login(outsider);call(owner,'RevokeRepositoryInvitation',{**target(r,owner),'invitationId':i['id'],'invitationRevision':i['revision']});member(r,outsider,False)
            stage('organization owner/direct member admin allowed; effective team admin alone is not delegation')
            organization=project+'-org';org=smoke.provider(owner['token'],'POST','orgs',{'username':organization,'visibility':'private'},201);organizations[organization]={'id':org['id'],'owner':owner};r=create_repo(owner,'organization',organization)
            for actor,permission in ((direct,'read'),(teamadmin,'admin')):
                team=smoke.provider(owner['token'],'POST','orgs/'+organization+'/teams',{'name':actor['role'],'permission':permission,'visibility':'limited','units_map':{'repo.code':permission},'includes_all_repositories':False},201);smoke.provider(owner['token'],'PUT','teams/'+str(team['id'])+'/members/'+actor['name'],expected=204);smoke.provider(owner['token'],'PUT','teams/'+str(team['id'])+'/repos/'+r['name'],expected=204)
            smoke.provider(owner['token'],'PUT','repos/'+r['name']+'/collaborators/'+direct['name'],{'permission':'admin'},204)
            t=target(r,teamadmin);readonly=call(teamadmin,'ListRepositoryInvitations',{**t,'page':{'page':1,'limit':20}});assert not readonly.get('canManage',False) and not readonly.get('invitations',[]);call(teamadmin,'PreviewRepositoryInvitationRecipient',{**t,'username':recipient['name']},expected=403)
            i,_=create(r,owner,recipient);call(owner,'RevokeRepositoryInvitation',{**target(r,owner),'invitationId':i['id'],'invitationRevision':i['revision']});i,_=create(r,direct,recipient);result,original=respond(recipient,i);operation(result['operation'],original,'SUCCEEDED');assert result['invitation']['organizationOwned'];assert member(r,recipient,True)=='read'
            stage('wall-clock expiry is observed without a background grant')
            deadline=datetime.datetime.fromisoformat(expiring['expiresAt'].replace('Z','+00:00')).timestamp();wait=max(0,deadline-time.time()+0.5);assert wait<66
            while time.time()<deadline+0.5:time.sleep(min(1,max(0.01,deadline+0.5-time.time())))
            assert own(recipient,expiring['id'])['state']=='EXPIRED';respond(recipient,expiring,expected=400,code='failed_precondition');member(expiry_repo,recipient,False)
            if args.ui:
                stage('real canonical Access/editor/inbox cycles and browser lost-acknowledgement inspection')
                ui_repo=create_repo(owner,'browser');config={'stackRoot':str(ROOT),'golf':smoke.GOLF,'gitea':smoke.GITEA,'repository':ui_repo['name'],'repositoryId':ui_repo['id'],'ownerId':ui_repo['ownerId'],'issuerEmail':owner['email'],'issuerPassword':owner['password'],'recipientEmail':recipient['email'],'recipientPassword':recipient['password'],'recipientId':recipient['id'],'recipientUsername':recipient['name'],'ownerToken':owner['token'],'screenshots':str(common.OUTPUT),'runtime':before}
                result=subprocess.run(['node',str(ROOT/'scripts/repository-invitations-browser.mjs')],cwd=ROOT,env=environment,input=json.dumps(config).encode(),capture_output=True,timeout=360);assert len(result.stdout)<=65536 and len(result.stderr)<=65536
                path=common.OUTPUT/'browser-manifest.json';assert path.is_file(),'Browser did not publish safe staged provenance';b=json.loads(path.read_text());record(browser=b['status'],captures=b.get('captures',[]),browserFailedStage=b.get('failedStage'),browserRequestCounts=b.get('requestCounts',{}),browserProcedureStatusCounts=b.get('procedureStatusCounts',{}));assert result.returncode==0 and b['status']=='browser_checks_passed_parent_native_cleanup_pending' and len(b['captures'])==12 and b['runtime']==before,'Browser proof failed; safe staged manifest available';print(result.stdout.decode().strip(),flush=True)
            assert runtime()==before;record(nativeChecks='passed',runtimeUnchanged=True,nativePutAcknowledgementLoss='not_qualified',browserResponseLoss='durable_original_status_inspection_no_repeat_request' if args.ui else 'not_requested');passed=True
        finally:
            if not passed:record(failedStage=common.STAGE,failedProcedure=PROOF.get('lastProcedure'))
            print('CHECK: exact owned fixture cleanup',flush=True);failures=[]
            for actor,identifier in bearers:
                try:checked_rpc(actor['session'],'ApiCredentialService/RevokeApiCredential',{'credentialId':identifier})
                except Exception:failures.append('bearer')
            for actor in actors.values():
                if actor.get('loggedIn'):
                    try:checked_rpc(actor['session'],'SessionService/RevokeOtherSessions');checked_rpc(actor['session'],'SessionService/Logout');actor['loggedIn']=False
                    except Exception:failures.append('session')
                if actor.get('created'):
                    try:assert operator('disable',{'username':actor['name']})['disabled']
                    except Exception:failures.append('managed disable')
            class NoRedirect(urllib.request.HTTPRedirectHandler):
                def redirect_request(self,*args):return None
            cleanup=urllib.request.build_opener(NoRedirect)
            def remove(route,actor,identifier,owner_id=None,role='repository'):
                def request(method):
                    req=urllib.request.Request(smoke.GITEA+'/api/v1/'+route,method=method,headers={'Authorization':'token '+actor['token']})
                    try:response=cleanup.open(req,timeout=15)
                    except urllib.error.HTTPError as e:response=e
                    with response:
                        observations=PROOF.get('cleanupObservations',[]);observations.append({'role':role,'method':method,'status':response.status});record(cleanupObservations=observations);raw=response.read((1<<20)+1);assert len(raw)<=1<<20;return response.status,json.loads(raw) if raw else None
                status,row=request('GET')
                if status==404:return
                assert status==200 and str(row['id'])==identifier
                if owner_id:assert str(row['owner']['id'])==owner_id
                assert request('DELETE')[0]==204 and request('GET')[0]==404
            for r in reversed(list(repositories.values())):
                try:remove('repos/'+r['name'],r['owner'],r['id'],r['ownerId'])
                except Exception:failures.append('native repository')
            for name,org in reversed(list(organizations.items())):
                try:remove('orgs/'+name,org['owner'],str(org['id']),role='organization')
                except Exception:failures.append('native organization')
            for actor in reversed(list(actors.values())):
                if actor.get('created'):
                    try:admin('delete','--username',actor['name'],'--purge')
                    except Exception:failures.append('native purge')
            try:
                if started:
                    command('down','--volumes','--remove-orphans',timeout=180)
                    for arguments in [('ps','-aq'),('volume','ls','-q'),('network','ls','-q')]:assert not run('docker',*arguments,'--filter','label=com.docker.compose.project='+project)
            except Exception:failures.append('fresh project resources')
            finally:smoke.GOLF,smoke.GITEA=previous;record(cleanup='failed' if failures else 'passed',cleanupFailureCategories=failures)
            if failures and passed:record(failedStage='owned fixture cleanup')
            assert not failures,'Owned fixture cleanup failed; initial failing predicate remains preserved'
    assert passed;record(status='qualified',browser='qualified' if args.ui else 'not_requested');print('PASS: actual supported-native invitation consent/inbox/grant/refusal/expiry/identity/authority/replay boundaries on unchanged fresh runtime; full Access remains Partial')


if __name__=='__main__':
    try:main()
    except Exception as error:
        frames=traceback.extract_tb(error.__traceback__);frame=next((v for v in reversed(frames) if v.filename==__file__),frames[-1]);record(status='failed',failedStage=PROOF.get('failedStage',common.STAGE),failureType=type(error).__name__,failureLine=frame.lineno);print('Invitation qualifier failed at '+PROOF.get('failedStage',common.STAGE)+': '+type(error).__name__+'; line '+str(frame.lineno)+'; private diagnostics withheld',file=sys.stderr);raise SystemExit(1)
