#!/usr/bin/env python3
"""Qualify current-owner administration of non-owner teams on real Compose.

Disposable users/orgs/teams/repo only. No retained account changes, owner-team
writes, native DB writes or automatic write retries. Controlled-provider DB tests
cover response loss and revocation between native reads and dispatch.
"""
import json
import secrets
import subprocess
import urllib.error
import urllib.request
import sys
sys.dont_write_bytecode = True
from smoke import GITEA, GOLF, ROOT, admin, client, provider, ready, rpc


def main():
    ready()
    prefix = 'golf-org-admin-' + secrets.token_hex(4)
    users, sessions, orgs, repositories = [], [], [], []
    owner_token = None
    try:
        actors = []
        for role in ['owner','reader','target','outsider']:
            name = prefix+'-'+role
            admin('create','--username',name,'--email',name+'@example.invalid','--random-password','--must-change-password=false')
            users.append(name)
            token = admin('generate-access-token','--username',name,'--token-name',prefix,'--scopes','write:user,write:organization,write:repository','--raw')
            session = client();sessions.append(session)
            rpc(session,'SessionService/LoginWithGiteaToken',{'token':token})
            actors.append((name,token,session))
        owner_name,owner_token,owner = actors[0]
        reader_name,_,reader = actors[1]
        target_name,target_token,target_session = actors[2]
        outsider = actors[3][2]
        organization = prefix+'-org'
        org = provider(owner_token,'POST','orgs',{'username':organization,'visibility':'private'},expected=201);orgs.append(organization)
        team = provider(owner_token,'POST','orgs/'+organization+'/teams',{'name':'Developers','visibility':'limited','units_map':{'repo.code':'read'}},expected=201)
        team_id = str(team['id'])
        provider(owner_token,'PUT','teams/'+team_id+'/members/'+reader_name,expected=204)
        native_teams = provider(owner_token,'GET','orgs/'+organization+'/teams')
        owner_team_id = str(next(item['id'] for item in native_teams if item['permission']=='owner'))
        def inspect(session=owner,selected=team_id):
            return rpc(session,'OrganizationAdminService/GetTeamAdministration',{'organization':organization,'teamId':selected})
        administration = inspect()
        assert administration['canManageMembers'] and administration['organizationId']==str(org['id']) and administration['team']['id']==team_id
        assert not inspect(reader).get('canManageMembers',False)
        rpc(outsider,'OrganizationAdminService/GetTeamAdministration',{'organization':organization,'teamId':team_id},expected=404)
        owner_meta = inspect(selected=owner_team_id)
        assert owner_meta['isOwnerTeam'] and not owner_meta.get('canManageMembers',False)
        def lookup_request(meta=administration,selected=team_id):
            return {'organization':organization,'organizationId':meta['organizationId'],'teamId':selected,'userLogin':target_name,'expectedRevision':meta['revision']}
        candidate = rpc(owner,'OrganizationAdminService/ResolveTeamMember',lookup_request())
        assert not candidate.get('isMember',False) and candidate['user']['login']==target_name
        user_id = candidate['user']['id']
        def member_request(meta=administration):
            return {**lookup_request(meta),'userId':user_id}
        rpc(reader,'OrganizationAdminService/ResolveTeamMember',lookup_request(),expected=403)
        rpc(owner,'OrganizationAdminService/ResolveTeamMember',lookup_request(owner_meta,owner_team_id),expected=403)
        rpc(owner,'OrganizationAdminService/AddTeamMember',{**member_request(),'userId':'9223372036854775807'},expected=400,code='failed_precondition')
        provider(owner_token,'POST','orgs/'+organization+'/repos',{'name':'team-access','private':True,'auto_init':True},expected=201)
        repositories.append(organization+'/team-access')
        provider(owner_token,'PUT','teams/'+team_id+'/repos/'+organization+'/team-access',expected=204)
        provider(target_token,'GET','repos/'+organization+'/team-access',expected=404)
        added = rpc(owner,'OrganizationAdminService/AddTeamMember',member_request())
        assert added['isMember'] and added['user']['id']==user_id
        assert provider(target_token,'GET','repos/'+organization+'/team-access')['permissions']['pull']
        rpc(owner,'OrganizationAdminService/AddTeamMember',member_request(),expected=400,code='failed_precondition')
        removed = rpc(owner,'OrganizationAdminService/RemoveTeamMember',member_request())
        assert not removed.get('isMember',False) and removed['user']['id']==user_id
        provider(target_token,'GET','repos/'+organization+'/team-access',expected=404)
        provider(owner_token,'GET','teams/'+team_id+'/members/'+target_name,expected=404)
        provider(owner_token,'PATCH','teams/'+team_id,{'description':'Updated review context'})
        rpc(owner,'OrganizationAdminService/AddTeamMember',member_request(),expected=400,code='failed_precondition')
        fresh = inspect()
        assert fresh['revision']!=administration['revision']
        other_org = prefix+'-other'
        provider(owner_token,'POST','orgs',{'username':other_org,'visibility':'private'},expected=201);orgs.append(other_org)
        other_team = provider(owner_token,'POST','orgs/'+other_org+'/teams',{'name':'Other','visibility':'limited','units_map':{'repo.code':'read'}},expected=201)
        rpc(owner,'OrganizationAdminService/GetTeamAdministration',{'organization':organization,'teamId':str(other_team['id'])},expected=404)
        rpc(owner,'OrganizationAdminService/AddTeamMember',member_request(fresh),headers={'Origin':'https://other.invalid'},expected=403)
        delegated = rpc(owner,'ApiCredentialService/CreateApiCredential',{'label':'No organization administration'})['token']
        for method in ['GetTeamAdministration','ResolveTeamMember','AddTeamMember','RemoveTeamMember']:
            rpc(client(),'OrganizationAdminService/'+method,{},headers={'Authorization':'Bearer '+delegated},expected=403)
        subprocess.run(['node','scripts/organization-admin-browser.mjs'], input=json.dumps({
            'golf':GOLF, 'token':owner_token, 'organization':organization, 'teamId':team_id,
            'targetLogin':target_name, 'targetId':user_id}), text=True, check=True, cwd=ROOT)
        provider(owner_token,'GET','teams/'+team_id+'/members/'+target_name,expected=404)
        rpc(owner,'SessionService/Logout')
        rpc(owner,'OrganizationAdminService/AddTeamMember',member_request(fresh),expected=401)
        provider(owner_token,'GET','teams/'+team_id+'/members/'+target_name,expected=404)
    finally:
        for session in sessions:
            try:rpc(session,'SessionService/Logout')
            except Exception:pass
        cleanup_failed = False
        def remove_native(route):
            request = urllib.request.Request(GITEA+'/api/v1/'+route, method='DELETE',
                                             headers={'Authorization':'token '+owner_token})
            try:
                response = client().open(request, timeout=15)
            except urllib.error.HTTPError as error:
                response = error
            with response:
                if response.status not in [204,404]:
                    raise RuntimeError('Unexpected disposable cleanup result')
        if owner_token:
            # Native organization deletion does not remove a nonempty repository
            # fixture reliably. Delete tracked repositories before their owners.
            for repository in reversed(repositories):
                try:remove_native('repos/'+repository)
                except Exception:cleanup_failed = True
            for organization in reversed(orgs):
                try:remove_native('orgs/'+organization)
                except Exception:cleanup_failed = True
        for name in reversed(users):
            try:admin('delete','--username',name,'--purge')
            except Exception:cleanup_failed = True
        if cleanup_failed:
            raise RuntimeError('Disposable organization cleanup was incomplete; sensitive diagnostics withheld')
    print('PASS: native-backed organization team administration, exact user/org/team bindings, owner-only and owner-team/cross-org denial, membership readback and repository access revocation, stale grants, Origin/bearer/logout denial and fixture cleanup')


if __name__=='__main__':
    main()
