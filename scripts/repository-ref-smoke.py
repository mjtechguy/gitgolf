#!/usr/bin/env python3
"""Qualify deployed branch/tag create/delete using supported native APIs and owned fixtures.

Credentials stay in memory. No existing users/repos, provider billing or pipeline jobs
are changed. Unknown writes are never retried; fixtures are purged after qualification.
"""
import argparse
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
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    os.umask(0o077)
    args.output.mkdir(parents=True, exist_ok=False)
    report = {'passed': False, 'ownedSessionsLoggedOut': False, 'ownedUsersPurged': False}
    actors, users = [], []
    try:
        report['servedSourceRevision'] = subprocess.check_output(['docker', 'inspect', 'golf-golf-1', '--format', '{{ index .Config.Labels "io.golf.web.revision" }}'], text=True).strip()
        prefix = 'golf-refs-'+secrets.token_hex(4)
        for role in ('owner', 'writer', 'reader', 'outsider'):
            name = prefix+'-'+role
            smoke.admin('create', '--username', name, '--email', name+'@example.invalid', '--random-password', '--must-change-password=false')
            users.append(name)
            token = smoke.admin('generate-access-token', '--username', name, '--token-name', prefix, '--scopes', 'write:user,write:repository,write:issue', '--raw')
            session = smoke.client()
            identity = smoke.rpc(session, 'SessionService/LoginWithGiteaToken', {'token': token})['user']
            actors.append((name, token, session, identity['id']))
        name, token, owner, _ = actors[0]
        repo = {'owner': name, 'name': 'refs'}
        native = smoke.provider(token, 'POST', 'user/repos', {'name': repo['name'], 'private': True, 'auto_init': True}, expected=201)
        base = 'repos/'+native['full_name']
        smoke.wait_for_push(token, native['full_name'])
        branch = smoke.provider(token, 'GET', base+'/branches/'+quote(native['default_branch'], safe='/'))
        head = branch['commit']['id']
        for actor, permission in ((actors[1], 'write'), (actors[2], 'read')):
            smoke.provider(token, 'PUT', base+'/collaborators/'+actor[0], {'permission': permission}, expected=204)
        target = {'repository': repo, 'repositoryId': str(native['id'])}
        access = smoke.rpc(owner, 'RepositoryAccessService/GetRepositoryAccess', {'repository': repo})['access']
        fixed = {**target, 'ownerId': access['ownerId'], 'accessRevision': access['revision']}
        outcomes = []
        def submit(kind, ref, commit=head, tag_object='', session=owner):
            payload = {**fixed, 'operationId': str(uuid.uuid4()), 'kind': 'REPOSITORY_REF_MUTATION_KIND_'+kind, 'name': ref, 'commitId': commit, 'tagObjectId': tag_object}
            result = smoke.rpc(session, 'RepositoryRefMutationService/SubmitRepositoryRefMutation', payload)['operation']
            assert all(result.get(k, '') == payload.get(k, '') for k in ('operationId', 'repositoryId', 'ownerId', 'accessRevision', 'kind', 'name', 'commitId', 'tagObjectId'))
            assert result['repository'] == repo and result['contract'] == 'golf.repository.ref-mutation.v1'
            return payload, result
        def inspect(payload):
            fields = {k: payload[k] for k in ('repository', 'repositoryId', 'ownerId', 'operationId')}
            return smoke.rpc(owner, 'RepositoryRefMutationService/GetRepositoryRefMutationOperation', fields)['operation']
        def phase(result, value):
            assert result['phase'] == 'REPOSITORY_REF_MUTATION_PHASE_'+value
        for actor in actors[1:]:
            payload = {**fixed, 'operationId': str(uuid.uuid4()), 'kind': 'REPOSITORY_REF_MUTATION_KIND_CREATE_BRANCH', 'name': 'denied/'+actor[0], 'commitId': head}
            smoke.rpc(actor[2], 'RepositoryRefMutationService/SubmitRepositoryRefMutation', payload, expected=404 if actor is actors[3] else 403)
        for kind, ref in (('BRANCH', 'feature/雪-%25'), ('TAG', 'version/雪-%25')):
            payload, result = submit('CREATE_'+kind, ref)
            phase(result, 'SUCCEEDED')
            assert inspect(payload) == result
            assert smoke.rpc(owner, 'RepositoryRefMutationService/SubmitRepositoryRefMutation', payload)['operation'] == result
            if kind == 'BRANCH':
                rows = smoke.provider(token, 'GET', base+'/git/refs/heads/'+quote(ref, safe='/'))
                if isinstance(rows, dict): rows = [rows]
                exact = [row for row in rows if row['ref'] == 'refs/heads/'+ref]
                assert len(exact) == 1 and exact[0]['object']['sha'] == head
                tag_object = ''
            else:
                tag = smoke.provider(token, 'GET', base+'/tags/'+quote(ref, safe='/'))
                assert tag['name'] == ref and tag['commit']['sha'] == head and tag['id'] == head
                tag_object = tag['id']
            selected = smoke.rpc(owner, 'RepositoryService/ResolveRepositorySource', {**target, 'selector': {'kind': 'REPOSITORY_SOURCE_REF_KIND_'+kind, 'name': ref}})
            assert selected['selection']['commitId'] == head and selected['repositoryId'] == target['repositoryId']
            payload, result = submit('DELETE_'+kind, ref, tag_object=tag_object)
            phase(result, 'SUCCEEDED')
            assert inspect(payload) == result
            smoke.provider(token, 'GET', base+('/git/refs/heads/' if kind == 'BRANCH' else '/tags/')+quote(ref, safe='/'), expected=404)
            outcomes.extend(['create_'+kind.lower(), 'delete_'+kind.lower()])
        release_tag='published/雪-%25'
        release=smoke.provider(token,'POST',base+'/releases',{'tag_name':release_tag,'target_commitish':head,'name':'Preserve published release','body':'Private unchanged notes','draft':False,'prerelease':False},expected=201)
        release_native_tag=smoke.provider(token,'GET',base+'/tags/'+quote(release_tag,safe='/'))
        _,release_refusal=submit('DELETE_TAG',release_tag,tag_object=release_native_tag['id'])
        phase(release_refusal,'REJECTED')
        assert smoke.provider(token,'GET',base+'/releases/'+str(release['id']))['body']==release['body']
        assert smoke.provider(token,'GET',base+'/tags/'+quote(release_tag,safe='/'))['id']==release_native_tag['id']
        report['publishedSlashTagDeletionRefused']=True
        browser_name='browser/雪-%25'
        cookies=[dict(name=c.name,value=c.value,url=smoke.GOLF,httpOnly=c.has_nonstandard_attr('HttpOnly'),sameSite='Lax') for handler in owner.handlers if isinstance(handler,urllib.request.HTTPCookieProcessor) for c in handler.cookiejar]
        config={'url':smoke.GOLF+'/'+native['full_name']+'/branches','cookies':cookies,'repository':repo,'ownerId':access['ownerId'],'accessRevision':access['revision'],'repositoryId':str(native['id']),'commitId':head,'name':browser_name,'output':str((args.output/'browser').resolve())}
        child=subprocess.run(['node','scripts/repository-ref-browser.mjs'],input=json.dumps(config),text=True,capture_output=True,timeout=120)
        assert all(actor[1] not in child.stdout+child.stderr for actor in actors), 'Child diagnostic withheld'
        report['browserExitCode']=child.returncode
        assert child.returncode==0,'Served ref browser qualification failed; inspect private receipt'
        created=smoke.provider(token,'GET',base+'/branches/'+quote(browser_name,safe='/'))
        assert created['name']==browser_name and created['commit']['id']==head
        _,browser_delete=submit('DELETE_BRANCH',browser_name)
        phase(browser_delete,'SUCCEEDED')
        _, result = submit('DELETE_BRANCH', native['default_branch'])
        phase(result, 'REJECTED')
        assert smoke.provider(token, 'GET', base+'/branches/'+quote(native['default_branch'], safe='/'))['commit']['id'] == head
        report.update(passed=True, nativeVersion=smoke.provider(token, 'GET', 'version')['version'], operations=outcomes, originalInspection=True, exactNativeReadback=True, defaultBranchDeleteRefused=True, roles=['owner admitted', 'writer/reader refused', 'outsider masked'], scope='Ordinary administration-only branch/tag create/delete; no protected writes or atomic native CAS')
    finally:
        errors = []
        for _, _, session, _ in actors:
            try:
                smoke.rpc(session, 'SessionService/Logout')
                smoke.rpc(session, 'SessionService/GetSession', expected=401)
            except BaseException:
                errors.append('session_cleanup')
        report['ownedSessionsLoggedOut'] = 'session_cleanup' not in errors
        for name in reversed(users):
            try:
                smoke.admin('delete', '--username', name, '--purge')
                smoke.request(smoke.client(), 'GET', smoke.GITEA+'/api/v1/users/'+name, expected=404)
            except BaseException:
                errors.append('user_cleanup')
        report['ownedUsersPurged'] = 'user_cleanup' not in errors
        report['cleanupErrors'] = errors
        if errors: report['passed'] = False
        (args.output/'manifest.json').write_text(json.dumps(report, indent=2)+'\n')
        if errors: raise RuntimeError('Owned fixture cleanup incomplete; inspect private receipt')
    print('PASS actual native branch/tag create/delete and original inspection; owned fixtures cleaned')

if __name__ == '__main__':
    main()
