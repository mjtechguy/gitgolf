#!/usr/bin/env python3
"""Qualify served ordinary web files on owned fixtures with independent native objects.

No existing repositories or credentials are modified. Native writes are submitted
once; unknown outcomes fail qualification and are only inspected, never retried.
"""
import argparse
import base64
import hashlib
import json
import os
from pathlib import Path
import secrets
import subprocess
import sys
import urllib.request
from urllib.parse import quote
import uuid
sys.dont_write_bytecode = True
import smoke

def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output',type=Path,required=True)
    args=parser.parse_args();os.umask(0o077);args.output.mkdir(parents=True,exist_ok=False)
    report={'passed':False,'ownedSessionsLoggedOut':False,'ownedUsersPurged':False}
    actors,users=[],[]
    try:
        report['servedSourceRevision']=subprocess.check_output(['docker','inspect','golf-golf-1','--format','{{ index .Config.Labels "io.golf.web.revision" }}'],text=True).strip()
        prefix='golf-files-'+secrets.token_hex(4)
        for role in ('owner','writer','reader','outsider'):
            name=prefix+'-'+role;smoke.admin('create','--username',name,'--email',name+'@example.invalid','--random-password','--must-change-password=false');users.append(name)
            token=smoke.admin('generate-access-token','--username',name,'--token-name',prefix,'--scopes','write:user,write:repository,write:issue','--raw')
            session=smoke.client();actor=smoke.rpc(session,'SessionService/LoginWithGiteaToken',{'token':token})['user'];actors.append((name,token,session,actor['id']))
        name,token,owner,_=actors[0];repo={'owner':name,'name':'files'}
        native=smoke.provider(token,'POST','user/repos',{'name':repo['name'],'private':True,'auto_init':True},expected=201);base='repos/'+native['full_name'];branch=native['default_branch'];smoke.wait_for_push(token,native['full_name'])
        for actor,permission in ((actors[1],'write'),(actors[2],'read')):smoke.provider(token,'PUT',base+'/collaborators/'+actor[0],{'permission':permission},expected=204)
        target={'repository':repo,'repositoryId':str(native['id'])};access=smoke.rpc(owner,'RepositoryAccessService/GetRepositoryAccess',{'repository':repo})['access'];fixed={**target,'ownerId':access['ownerId'],'accessRevision':access['revision']}
        def head():return smoke.provider(token,'GET',base+'/branches/'+quote(branch,safe='/'))['commit']['id']
        def blob_id(data):return hashlib.sha1(b'blob '+str(len(data)).encode()+b'\0'+data).hexdigest()
        def inspect(payload):return smoke.rpc(owner,'RepositoryFileMutationService/GetRepositoryFileMutationOperation',{k:payload[k] for k in ('repository','repositoryId','ownerId','operationId')})['operation']
        def submit(kind,path,data=b'',blob='',commit=None,session=owner,expected=200):
            payload={**fixed,'operationId':str(uuid.uuid4()),'kind':'REPOSITORY_FILE_MUTATION_KIND_'+kind,'branch':branch,'expectedCommitId':commit or head(),'path':path,'expectedBlobId':blob,'content':base64.b64encode(data).decode(),'commitMessage':kind.title()+' owned file fixture'}
            response=smoke.rpc(session,'RepositoryFileMutationService/SubmitRepositoryFileMutation',payload,expected=expected)
            if expected!=200:return payload,None
            operation=response['operation'];assert operation['contract']=='golf.repository.file-mutation.v1';assert operation['repository']==repo
            for k in ('repositoryId','ownerId','accessRevision','operationId','kind','branch','expectedCommitId','path'):assert operation[k]==payload[k]
            assert operation.get('expectedBlobId','')==blob and operation['contentSha256']==hashlib.sha256(data).hexdigest() and int(operation.get('contentSizeBytes','0'))==len(data) and operation['commitMessageSha256']==hashlib.sha256(payload['commitMessage'].encode()).hexdigest()
            assert inspect(payload)==operation
            return payload,operation
        def succeeded(payload,operation,data=b''):
            assert operation['phase']=='REPOSITORY_FILE_MUTATION_PHASE_SUCCEEDED','Native result unresolved: inspect original only'
            commit=operation['commitId'];assert head()==commit
            receipt=smoke.provider(token,'GET',base+'/git/commits/'+commit+'?stat=false&files=false&verification=false');assert receipt['sha']==commit and len(receipt['parents'])==1 and receipt['parents'][0]['sha']==payload['expectedCommitId']
            if payload['kind'].endswith('_DELETE'):
                smoke.provider(token,'GET',base+'/contents/'+quote(payload['path'],safe='/')+'?ref='+commit,expected=404)
            else:
                expected_blob=blob_id(data);assert operation['blobId']==expected_blob
                native_blob=smoke.provider(token,'GET',base+'/git/blobs/'+expected_blob);assert native_blob['sha']==expected_blob and native_blob['size']==len(data) and base64.b64decode(native_blob['content'])==data
                source=smoke.rpc(owner,'RepositoryService/GetContents',{**target,'ref':commit,'path':payload['path']});assert source['commitId']==commit and source['file']['entry']['sha']==expected_blob
        original=head()
        for actor in actors[1:]:submit('CREATE','denied-'+actor[0]+'.txt',b'not allowed',session=actor[2],expected=404 if actor is actors[3] else 403)
        path='雪-%25.txt';data=b'# Useful documentation\n';payload,operation=submit('CREATE',path,data);succeeded(payload,operation,data)
        report['create']=True
        data2=b'# Improved documentation\n';payload,operation=submit('UPDATE',path,data2,blob=blob_id(data));succeeded(payload,operation,data2);report['update']=True
        # Stale commit or original blob must refuse before native dispatch.
        stable=head();_,refused=submit('UPDATE',path,b'stale change',blob=blob_id(data),commit=stable);assert refused['phase']=='REPOSITORY_FILE_MUTATION_PHASE_REJECTED' and head()==stable;report['staleBlobRefused']=True
        _,refused=submit('CREATE','stale-head.txt',b'stale head',commit=original);assert refused['phase']=='REPOSITORY_FILE_MUTATION_PHASE_REJECTED' and head()==stable;report['staleHeadRefused']=True
        binary=bytes([0,1,2,128,255]);payload,operation=submit('CREATE','exact-binary.bin',binary);succeeded(payload,operation,binary);report['binaryBytesExact']=True
        payload,operation=submit('DELETE',path,blob=blob_id(data2));succeeded(payload,operation);report['delete']=True
        # All configured rules are refused even if native administrators can bypass.
        smoke.provider(token,'POST',base+'/branch_protections',{'rule_name':branch,'enable_push':False},expected=201)
        protected_head=head();_,refused=submit('CREATE','protected.txt',b'refuse protected');assert refused['phase']=='REPOSITORY_FILE_MUTATION_PHASE_REJECTED' and head()==protected_head;report['protectedAdministratorRefused']=True
        smoke.provider(token,'DELETE',base+'/branch_protections/'+quote(branch,safe='/'),expected=204)
        # Read-only characterization of native writer protection discovery.
        writer=actors[1][1]
        details=smoke.provider(writer,'GET',base+'/branches/'+quote(branch,safe='/'))
        report['writerBranchProtectedProjection']=details.get('protected')
        try:
            observed=smoke.provider(writer,'GET',base+'/branch_protections');report['writerProtectionListReadable']=isinstance(observed,list)
        except AssertionError:
            smoke.provider(writer,'GET',base+'/branch_protections',expected=403);report['writerProtectionListReadable']=False;report['writerProtectionListStatus']=403
        cookies=[dict(name=c.name,value=c.value,url=smoke.GOLF,httpOnly=c.has_nonstandard_attr('HttpOnly'),sameSite='Lax') for handler in owner.handlers if isinstance(handler,urllib.request.HTTPCookieProcessor) for c in handler.cookiejar]
        config={'url':smoke.GOLF+'/'+native['full_name']+'/tree/'+quote(branch,safe='/')+'?refKind=branch&refName='+quote(branch,safe=''),'cookies':cookies,'repository':repo,'repositoryId':str(native['id']),'ownerId':access['ownerId'],'actorId':actors[0][3],'accessRevision':access['revision'],'branch':branch,'commitId':head(),'initialText':'Useful browser documentation\n','updatedText':'Improved browser documentation\n','output':str((args.output/'browser').resolve())}
        child=subprocess.run(['node','scripts/repository-file-browser.mjs'],input=json.dumps(config),text=True,capture_output=True,timeout=180)
        assert all(actor[1] not in child.stdout+child.stderr for actor in actors),'Child diagnostic withheld';report['browserExitCode']=child.returncode;assert child.returncode==0,'Served file browser qualification failed; inspect private receipt'
        browser=json.loads((args.output/'browser'/'manifest.json').read_text());assert len(browser['writes'])==4
        for write,operation in zip(browser['writes'],browser['operations']):
            for k in ('repositoryId','operationId','kind','branch','expectedCommitId','path'):assert write[k]==operation[k]
            assert write['contentSha256']==operation['contentSha256'] and write['contentSizeBytes']==int(operation.get('contentSizeBytes','0'))
            receipt=smoke.provider(token,'GET',base+'/git/commits/'+operation['commitId']+'?stat=false&files=false&verification=false');assert receipt['parents'][0]['sha']==write['expectedCommitId']
            if not write['kind'].endswith('_DELETE'):
                native_blob=smoke.provider(token,'GET',base+'/git/blobs/'+operation['blobId']);assert hashlib.sha256(base64.b64decode(native_blob['content'])).hexdigest()==write['contentSha256']
        assert smoke.provider(token,'GET',base)['default_branch']==branch;report['defaultBranchPreserved']=True
        report.update(passed=True,nativeVersion=smoke.provider(token,'GET','version')['version'],originalInspection=True,exactNativeReadback=True,roles=['owner admitted','writer/reader refused','outsider masked'],scope='Ordinary administration-only individual contents create/update/delete and binary upload; no native expected-HEAD CAS, no protected writes, max 256 KiB')
    finally:
        errors=[]
        for _,_,session,_ in actors:
            try:smoke.rpc(session,'SessionService/Logout');smoke.rpc(session,'SessionService/GetSession',expected=401)
            except BaseException:errors.append('session_cleanup')
        report['ownedSessionsLoggedOut']='session_cleanup' not in errors
        for name in reversed(users):
            try:smoke.admin('delete','--username',name,'--purge');smoke.request(smoke.client(),'GET',smoke.GITEA+'/api/v1/users/'+name,expected=404)
            except BaseException:errors.append('user_cleanup')
        report['ownedUsersPurged']='user_cleanup' not in errors;report['cleanupErrors']=errors
        if errors:report['passed']=False
        (args.output/'manifest.json').write_text(json.dumps(report,indent=2)+'\n')
        if errors:raise RuntimeError('Owned fixture cleanup incomplete; inspect private receipt')
    print('PASS actual native file create/update/delete/upload and served UI; owned fixtures cleaned')
if __name__=='__main__':main()
