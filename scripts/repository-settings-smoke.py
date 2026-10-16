#!/usr/bin/env python3
"""Qualify bounded general repository settings on the real Compose services.

Disposable native users/repository only; retained administrators are untouched.
Lost-response retry behavior is exercised by TestRepositorySettingsPostgres,
where the fake provider can fail after applying a PATCH. This native proof does
not claim atomic CAS, durable mutation journaling, CI or protection policy.
"""
import secrets
import sys
sys.dont_write_bytecode = True
from smoke import admin, client, provider, ready, rpc


def main():
    ready()
    prefix = 'golf-repo-settings-' + secrets.token_hex(4)
    users, sessions = [], []
    try:
        actors = []
        for role in ['owner', 'reader', 'outsider']:
            name = prefix + '-' + role
            admin('create', '--username', name, '--email', name+'@example.invalid',
                  '--random-password', '--must-change-password=false')
            users.append(name)
            token = admin('generate-access-token', '--username', name, '--token-name', prefix,
                          '--scopes', 'write:user,write:repository', '--raw')
            session = client(); sessions.append(session)
            rpc(session, 'SessionService/LoginWithForgeToken', {'token': token})
            actors.append((name, token, session))
        name, token, owner = actors[0]
        reader_name, _, reader = actors[1]
        outsider = actors[2][2]
        repository = {'owner': name, 'name': 'settings'}
        path = 'repos/'+name+'/settings'
        native = provider(token, 'POST', 'user/repos', {'name':'settings', 'private':True, 'auto_init':True}, expected=201)
        provider(token, 'PUT', path+'/collaborators/'+reader_name, {'permission':'read'}, expected=204)
        def read(session=owner):
            return rpc(session, 'RepositorySettingsService/GetRepositorySettings', {'repository':repository})['settings']
        def request(settings, **patch):
            return {'repository':repository, 'repositoryId':settings['repositoryId'], 'ownerId':settings['ownerId'],
                    'expectedRevision':settings['revision'], **patch}
        def update(settings, **patch):
            return rpc(owner, 'RepositorySettingsService/UpdateRepositorySettings', request(settings, **patch))['settings']
        before = read()
        assert before['repositoryId'] == str(native['id']) and before['ownerId'] == str(native['owner']['id'])
        assert before['canEdit'] and len(before['revision']) == 64
        readonly = read(reader)
        assert not readonly.get('canEdit', False)
        rpc(reader, 'RepositorySettingsService/UpdateRepositorySettings', request(readonly, description='Denied'), expected=403)
        rpc(outsider, 'RepositorySettingsService/GetRepositorySettings', {'repository':repository}, expected=404)
        changed = update(before, description='Actual Compose qualification', hasIssues=False, hasWiki=False, hasPullRequests=False)
        assert changed['description'] == 'Actual Compose qualification'
        assert not any(changed.get(field, False) for field in ['hasIssues','hasWiki','hasPullRequests'])
        observed = provider(token, 'GET', path)
        assert observed['description'] == changed['description'] and not any(observed[field] for field in ['has_issues','has_wiki','has_pull_requests'])
        rpc(owner, 'RepositorySettingsService/UpdateRepositorySettings', request(before, description='Stale'), expected=400, code='failed_precondition')
        rpc(owner, 'RepositorySettingsService/UpdateRepositorySettings', {**request(changed, description='Wrong owner'), 'ownerId':'9223372036854775807'}, expected=400, code='failed_precondition')
        rpc(owner, 'RepositorySettingsService/UpdateRepositorySettings', {**request(changed, description='Bad ID'), 'repositoryId':'0'+changed['repositoryId']}, expected=400)
        rpc(owner, 'RepositorySettingsService/UpdateRepositorySettings', request(changed, defaultBranch='missing'), expected=404)
        assert read()['revision'] == changed['revision']
        provider(token, 'POST', path+'/branches', {'new_branch_name':'release/settings', 'old_branch_name':before['defaultBranch']}, expected=201)
        final = update(changed, defaultBranch='release/settings', description='', hasIssues=True, hasWiki=True, hasPullRequests=True)
        assert final['defaultBranch'] == 'release/settings' and final.get('description','') == ''
        assert all(final[field] for field in ['hasIssues','hasWiki','hasPullRequests'])
        assert read()['revision'] == final['revision']
        rpc(owner, 'RepositorySettingsService/UpdateRepositorySettings', request(final, description='Wrong origin'), headers={'Origin':'https://other.invalid'}, expected=403)
        delegation = rpc(owner, 'ApiCredentialService/CreateApiCredential', {'label':'Settings boundary'})['token']
        for method in ['GetRepositorySettings','UpdateRepositorySettings']:
            rpc(client(), 'RepositorySettingsService/'+method, {'repository':repository}, headers={'Authorization':'Bearer '+delegation}, expected=403)
        rpc(owner, 'SessionService/Logout')
        rpc(owner, 'RepositorySettingsService/UpdateRepositorySettings', request(final, description='Revoked session'), expected=401)
        assert provider(token, 'GET', path)['description'] == ''
        print('PASS: real Compose repository settings read/admin-denial, native PATCH/readback, optional false/empty, slash default branch, stale identity/revision, Origin/bearer and revoked-session denial')
    finally:
        for session in sessions:
            try:
                rpc(session, 'SessionService/Logout')
            except Exception:
                pass
        for name in reversed(users):
            admin('delete', '--username', name, '--purge')


if __name__ == '__main__':
    main()
