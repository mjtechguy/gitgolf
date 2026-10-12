#!/usr/bin/env python3
"""Additional actual Forgejo protocol/selection/role checks on an owned fixture."""
import base64
import os
import secrets
import uuid
import smoke

def main():
    assert os.environ.get('GOLF_SMOKE_FORGE_KIND') == 'forgejo'
    smoke.ready()
    users=[]
    try:
        actors=[]
        for role in ('owner','reviewer','outsider'):
            name='golf-fj-'+role+'-'+secrets.token_hex(4)
            smoke.admin('create','--username',name,'--email',name+'@example.invalid','--random-password','--must-change-password=false')
            users.append(name)
            token=smoke.admin('generate-access-token','--username',name,'--token-name','proof','--scopes','write:user,write:repository,write:issue','--raw')
            session=smoke.client()
            user=smoke.rpc(session,'SessionService/LoginWithGiteaToken',{'token':token})['user']
            actors.append((name,token,session,user))
        name,token,session,user=actors[0]
        native=smoke.provider(token,'POST','user/repos',{'name':'selection','private':True,'auto_init':True,'default_branch':'main'},201)
        key={'owner':name,'name':'selection'};base='repos/'+native['full_name']
        source=b'on: workflow_dispatch\njobs:\n  check:\n    runs-on: linux\n    steps:\n      - run: echo qualified\n'
        for path in ('.github/workflows/legacy.yml','.gitea/workflows/legacy.yml','.forgejo/workflows/check.yml'):
            smoke.provider(token,'POST',base+'/contents/'+path,{'content':base64.b64encode(source).decode(),'message':'Owned workflow'},201)
        result=smoke.rpc(session,'WorkflowService/InspectWorkflows',{'repository':key,'ref':'main'})
        paths=[r['path'] for r in result['configurations']]
        assert '.forgejo/workflows/check.yml' in paths and not any(p.startswith(('.gitea/','.github/')) for p in paths),paths
        assert sum(v['code']=='actions_shadowed' for v in result.get('diagnostics',[])) == 2, 'Shadowed workflow directories must be reported'
        smoke.rpc(actors[2][2],'WorkflowService/InspectWorkflows',{'repository':key,'ref':'main'},expected=404)
        smoke.provider(token,'PUT',base+'/collaborators/'+actors[1][0],{'permission':'write'},204)
        smoke.provider(token,'POST',base+'/branches',{'new_branch_name':'feature','old_branch_name':'main'},201)
        smoke.provider(token,'POST',base+'/contents/change.txt',{'branch':'feature','content':base64.b64encode(b'change\n').decode(),'message':'Candidate'},201)
        pull=smoke.provider(token,'POST',base+'/pulls',{'head':'feature','base':'main','title':'Forgejo review proof'},201)
        review=smoke.provider(actors[1][1],'POST',base+'/pulls/'+str(pull['number'])+'/reviews',{'event':'APPROVED','body':'Owned test'},200)
        assert review['state']=='APPROVED'
        assert any(v['id']==review['id'] for v in smoke.provider(token,'GET',base+'/pulls/'+str(pull['number'])+'/reviews'))
        smoke.provider(token,'DELETE',base+'/collaborators/'+actors[1][0],expected=204)
        smoke.rpc(actors[1][2],'WorkflowService/InspectWorkflows',{'repository':key,'ref':'main'},expected=404)
        options=smoke.rpc(smoke.client(),'SessionService/GetAuthenticationOptions')
        assert options['providerLabel']=='Forgejo'
        print('PASS: Forgejo workflow precedence, private source, real native PR/review, immediate reader revocation and provider label')
    finally:
        for name in reversed(users): smoke.admin('delete','--username',name,'--purge')

if __name__=='__main__':main()
