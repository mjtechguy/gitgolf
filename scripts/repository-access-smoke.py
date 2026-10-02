#!/usr/bin/env python3
"""Qualify personal repository collaborator administration against real Compose.

Uses disposable native API fixtures; no DB writes, retries or retained changes.
"""
import json
import secrets
import sys
import urllib.error
import urllib.request
sys.dont_write_bytecode = True
from smoke import GITEA, admin, client, provider, ready, rpc


def main():
    ready()
    prefix = 'golf-repo-access-' + secrets.token_hex(4)
    users, sessions, repositories, organizations = [], [], [], []
    owner_token = None
    try:
        actors = {}
        for role in ['owner', 'admin', 'reader', 'target', 'outsider', 'global']:
            name = prefix + '-' + role
            options = ['create', '--username', name, '--email', name+'@example.invalid', '--random-password', '--must-change-password=false']
            if role == 'global':
                options.append('--admin')
            admin(*options)
            users.append(name)
            token = admin('generate-access-token', '--username', name, '--token-name', prefix,
                          '--scopes', 'write:user,write:organization,write:repository', '--raw')
            session = client(); sessions.append(session)
            rpc(session, 'SessionService/LoginWithGiteaToken', {'token': token})
            actors[role] = (name, token, session)
        owner_name, owner_token, owner = actors['owner']
        target_name, target_token, _ = actors['target']
        admin_name, admin_token, administrator = actors['admin']
        reader_name, reader_token, reader = actors['reader']
        repo = provider(owner_token, 'POST', 'user/repos', {'name':'private-access','private':True,'auto_init':True}, expected=201)
        repositories.append(owner_name+'/private-access')
        base = 'repos/'+repositories[-1]
        provider(owner_token, 'PUT', base+'/collaborators/'+admin_name, {'permission':'admin'}, expected=204)
        provider(owner_token, 'PUT', base+'/collaborators/'+reader_name, {'permission':'read'}, expected=204)
        key = {'owner':owner_name,'name':'private-access'}
        def inspect(session=owner, selected=key):
            return rpc(session,'RepositoryAccessService/GetRepositoryAccess',{'repository':selected})['access']
        access = inspect()
        assert access['canManage'] and access['ownerId']==str(repo['owner']['id']) and access['repositoryId']==str(repo['id'])
        assert inspect(administrator)['canManage']
        assert not inspect(reader).get('canManage',False)
        assert not inspect(actors['global'][2]).get('canManage',False)
        rpc(actors['outsider'][2],'RepositoryAccessService/GetRepositoryAccess',{'repository':key},expected=404)
        def scope(meta=access, selected=key):
            return {'repository':selected,'repositoryId':meta['repositoryId'],'ownerId':meta['ownerId'],'expectedRevision':meta['revision']}
        def resolve(login=target_name, session=owner, meta=access, selected=key):
            return rpc(session,'RepositoryAccessService/ResolveRepositoryCollaborator',{**scope(meta,selected),'userLogin':login})['collaborator']
        def write_request(member, meta=access, selected=key):
            return {**scope(meta,selected),'userLogin':member['user']['login'],'userId':member['user']['id'],'expectedCollaboratorRevision':member['revision']}
        candidate = resolve()
        assert not candidate.get('isDirect',False) and candidate.get('permission')=='none'
        rpc(reader,'RepositoryAccessService/ResolveRepositoryCollaborator',{**scope(),'userLogin':target_name},expected=403)
        rpc(actors['global'][2],'RepositoryAccessService/ResolveRepositoryCollaborator',{**scope(),'userLogin':target_name},expected=403)
        rpc(owner,'RepositoryAccessService/SetRepositoryCollaborator',{**write_request(candidate),'userId':'9223372036854775807','permission':'read'},expected=400,code='failed_precondition')
        for permission in ['read','write','admin']:
            previous = candidate
            candidate = rpc(owner,'RepositoryAccessService/SetRepositoryCollaborator',{**write_request(candidate),'permission':permission})['collaborator']
            assert candidate['isDirect'] and candidate['permission']==permission
            native = provider(owner_token,'GET',base+'/collaborators/'+target_name+'/permission')
            assert native['permission']==permission and native['user']['id']==int(candidate['user']['id'])
            rpc(owner,'RepositoryAccessService/SetRepositoryCollaborator',{**write_request(previous),'permission':permission},expected=400,code='failed_precondition')
        inventory = rpc(owner,'RepositoryAccessService/ListRepositoryCollaborators',{**scope(),'page':{'page':1,'limit':1}})
        assert len(inventory['collaborators'])==1 and inventory.get('page',{}).get('nextPage')==2
        loaded = inventory['collaborators'][:]
        next_page = inventory['page']['nextPage']
        while next_page:
            assert next_page <= 4
            inventory = rpc(owner,'RepositoryAccessService/ListRepositoryCollaborators',{**scope(),'page':{'page':next_page,'limit':1}})
            loaded.extend(inventory.get('collaborators',[]))
            continuation = inventory.get('page',{}).get('nextPage',0)
            assert not continuation or continuation > next_page
            next_page = continuation
        assert {member['user']['login'] for member in loaded} == {admin_name,reader_name,target_name}
        assert len(loaded) == 3
        owner_candidate = resolve(owner_name)
        rpc(owner,'RepositoryAccessService/SetRepositoryCollaborator',{**write_request(owner_candidate),'permission':'read'},expected=403)
        rpc(owner,'RepositoryAccessService/RemoveRepositoryCollaborator',write_request(owner_candidate),expected=403)
        own_admin = resolve(admin_name,administrator)
        rpc(administrator,'RepositoryAccessService/SetRepositoryCollaborator',{**write_request(own_admin),'permission':'admin'},expected=403)
        provider(owner_token,'PUT',base+'/collaborators/'+admin_name,{'permission':'read'},expected=204)
        rpc(administrator,'RepositoryAccessService/SetRepositoryCollaborator',{**write_request(candidate),'permission':'write'},expected=403)
        provider(owner_token,'PUT',base+'/collaborators/'+admin_name,{'permission':'admin'},expected=204)
        removed = rpc(owner,'RepositoryAccessService/RemoveRepositoryCollaborator',write_request(candidate))['collaborator']
        assert not removed.get('isDirect',False) and removed['permission']=='none'
        provider(target_token,'GET',base,expected=404)
        public_repo = provider(owner_token,'POST','user/repos',{'name':'public-access','private':False,'auto_init':True},expected=201)
        repositories.append(owner_name+'/public-access')
        public_key={'owner':owner_name,'name':'public-access'}; public_access=inspect(selected=public_key)
        public_member=resolve(meta=public_access,selected=public_key)
        assert public_member['permission']=='read' and not public_member.get('isDirect',False)
        public_member=rpc(owner,'RepositoryAccessService/SetRepositoryCollaborator',{**write_request(public_member,public_access,public_key),'permission':'write'})['collaborator']
        public_member=rpc(owner,'RepositoryAccessService/RemoveRepositoryCollaborator',write_request(public_member,public_access,public_key))['collaborator']
        assert public_member['permission']=='read' and not public_member.get('isDirect',False)
        assert provider(target_token,'GET','repos/'+owner_name+'/public-access')['id']==public_repo['id']
        # Outside direct administrators can see a hidden organization's repository
        # but not its organization metadata. That 404 must fail closed.
        organization=prefix+'-org'
        provider(owner_token,'POST','orgs',{'username':organization,'visibility':'private'},expected=201);organizations.append(organization)
        provider(owner_token,'POST','orgs/'+organization+'/repos',{'name':'org-access','private':True,'auto_init':True},expected=201)
        repositories.append(organization+'/org-access')
        provider(owner_token,'PUT','repos/'+organization+'/org-access/collaborators/'+admin_name,{'permission':'admin'},expected=204)
        orgkey={'owner':organization,'name':'org-access'}
        orgmeta=inspect(selected=orgkey)
        assert orgmeta['organizationOwned'] and not orgmeta.get('canManage',False)
        provider(admin_token,'GET','orgs/'+organization,expected=404)
        rpc(administrator,'RepositoryAccessService/GetRepositoryAccess',{'repository':orgkey},expected=404)
        rpc(owner,'RepositoryAccessService/SetRepositoryCollaborator',{**write_request(removed),'permission':'write'},headers={'Origin':'https://other.invalid'},expected=403)
        delegated=rpc(owner,'ApiCredentialService/CreateApiCredential',{'label':'No collaborator administration'})['token']
        for method in ['GetRepositoryAccess','ListRepositoryCollaborators','ResolveRepositoryCollaborator','SetRepositoryCollaborator','RemoveRepositoryCollaborator']:
            rpc(client(),'RepositoryAccessService/'+method,{},headers={'Authorization':'Bearer '+delegated},expected=403)
        rpc(owner,'SessionService/Logout')
        rpc(owner,'RepositoryAccessService/SetRepositoryCollaborator',{**write_request(removed),'permission':'write'},expected=401)
        provider(owner_token,'GET',base+'/collaborators/'+target_name,expected=404)
    finally:
        for session in sessions:
            try:rpc(session,'SessionService/Logout')
            except Exception:pass
        cleanup_failed=False
        def remove_native(route):
            request=urllib.request.Request(GITEA+'/api/v1/'+route,method='DELETE',headers={'Authorization':'token '+owner_token})
            try:response=client().open(request,timeout=15)
            except urllib.error.HTTPError as error:response=error
            with response:
                if response.status not in [204,404]:raise RuntimeError('Unexpected disposable cleanup result')
        if owner_token:
            for repository in reversed(repositories):
                try:remove_native('repos/'+repository)
                except Exception:cleanup_failed=True
            for organization in reversed(organizations):
                try:remove_native('orgs/'+organization)
                except Exception:cleanup_failed=True
        for name in reversed(users):
            try:admin('delete','--username',name,'--purge')
            except Exception:cleanup_failed=True
        if cleanup_failed:raise RuntimeError('Disposable repository access cleanup was incomplete; sensitive diagnostics withheld')
    print('PASS: native-backed personal repository collaborator read/write/admin, exact identity bindings, actual-owner/self/global-admin protection, public/private revocation, direct membership versus effective readability, hidden organization fail-closed, Origin/bearer/logout denial, cleanup')


if __name__=='__main__':main()
