#!/usr/bin/env python3
"""Qualify workflow source inspection against the running local Compose core.

Only disposable ordinary users and their private repository are written. Native
Actions must be disabled. Source files are never executed or externally fetched.
No CI is installed in Golf's development repository or the user's repositories.
"""
import base64
import json
import os
from pathlib import Path
import secrets
import subprocess
import sys
import tempfile
import uuid

sys.dont_write_bytecode = True
from smoke import GITEA, GOLF, ROOT, admin, client, command, provider, ready, rpc, wait_for_push

STAGE = 'prerequisites'


def stage(value):
    global STAGE
    STAGE = value
    print('CHECK: ' + value, flush=True)


def main():
    ready()
    if container := os.environ.get('GOLF_SMOKE_FORGE_CONTAINER'):
        assert command('docker', 'exec', container, 'printenv', 'FORGEJO__actions__ENABLED').lower() == 'false'
        assert provider('', 'GET', 'version')['version'] == '15.0.9+gitea-1.22.0'
    else:
        assert command('docker', 'compose', 'exec', '-T', 'gitea', 'printenv', 'GITEA__actions__ENABLED').lower() == 'false'
        assert provider('', 'GET', 'version')['version'] == '1.27.3'
    capabilities = rpc(client(), 'CapabilityService/ListCapabilities')['capabilities']
    assert next(item for item in capabilities if item['id'] == 'pipelines')['state'] == 'CAPABILITY_STATE_DISABLED'
    prefix = 'golf-workflows-' + secrets.token_hex(4)
    users, sessions = [], []
    owner_token, repository = None, None
    try:
        actors = []
        for role in ['owner', 'reader', 'outsider']:
            name = prefix + '-' + role
            admin('create', '--username', name, '--email', name+'@example.invalid', '--random-password', '--must-change-password=false')
            users.append(name)
            token = admin('generate-access-token', '--username', name, '--token-name', prefix,
                          '--scopes', 'write:user,write:repository' if role == 'owner' else 'read:user,read:repository', '--raw')
            session = client(); sessions.append(session)
            rpc(session, 'SessionService/LoginWithGiteaToken', {'token': token})
            actors.append((name, token, session))
        owner_name, owner_token, owner = actors[0]
        reader_name, _, reader = actors[1]
        outsider = actors[2][2]
        key = {'owner': owner_name, 'name': 'inspection'}
        created = rpc(owner, 'RepositoryService/CreateRepository', {'name': key['name'], 'private': True,
                      'description': 'Workflow inspection fixture; execution disabled.', 'idempotencyKey': str(uuid.uuid4())})
        repository = owner_name + '/' + key['name']
        assert created['creation']['state'] == 'REPOSITORY_CREATION_STATE_SUCCEEDED'
        procedure = 'WorkflowService/InspectWorkflows'

        def inspect(ref='main', session=owner, expected=200):
            return rpc(session, procedure, {'repository': key, 'ref': ref}, expected=expected)

        rpc(owner, procedure, {'repository': key}, expected=400, code='failed_precondition')
        with tempfile.TemporaryDirectory(prefix='golf-workflow-source-') as temporary:
            work = Path(temporary); work.chmod(0o700)
            hooks = work/'empty-hooks'; hooks.mkdir()
            env = {k: v for k, v in os.environ.items() if not k.startswith(('GIT_', 'GOLF_', 'GITEA_', 'GITHUB_', 'GITLAB_'))}
            env.update(GIT_CONFIG_NOSYSTEM='1', GIT_CONFIG_GLOBAL='/dev/null', GIT_TERMINAL_PROMPT='0', GIT_LFS_SKIP_SMUDGE='1')
            auth = base64.b64encode((owner_name+':'+owner_token).encode()).decode()
            env.update(GIT_CONFIG_COUNT='1', GIT_CONFIG_KEY_0='http.'+GITEA+'/.extraHeader', GIT_CONFIG_VALUE_0='Authorization: Basic '+auth)

            def git(*args):
                result = subprocess.run(['git', '-c', 'credential.helper=', '-c', 'core.hooksPath='+str(hooks),
                    '-c', 'protocol.file.allow=never', '-c', 'protocol.ext.allow=never', '-c', 'http.followRedirects=false', *args],
                    cwd=work, env=env, capture_output=True, timeout=60)
                assert result.returncode == 0, 'Native Git command failed; private output withheld'
                return result.stdout.decode().strip()

            git('init', '--initial-branch=main', '--template=')
            git('config', 'user.name', 'Golf workflow fixture'); git('config', 'user.email', 'fixture@example.invalid')
            source = b'name: Manual fixture\non: workflow_dispatch\njobs:\n  inspect:\n    runs-on: linux\n    steps:\n      - run: printf inspection-only\n'
            files = {
                '.github/workflows/manual.yml': source,
                '.github/workflows/external.yaml': b'on: workflow_dispatch\njobs:\n  test:\n    runs-on: linux\n    steps:\n      - uses: external/action@main\n',
                '.github/workflows/duplicate.yml': b'name: first\nname: second\n',
                '.github/workflows/alias.yml': b'name: &a [*a]\n',
                '.github/workflows/invalid-utf8.yml': b'job: \xff\n',
                '.github/workflows/too-large.yml': b'x' * 65537,
                '.github/workflows/nested/ignored.yml': source,
                '.gitlab-ci.yml': ('check:\n  image: alpine@sha256:'+'a'*64+'\n  script: printf inspection-only\n').encode(),
                '.gitlab-ci.yaml': b'not-the-supported-location: true\n',
            }
            for name, data in files.items():
                destination = work/name; destination.parent.mkdir(parents=True, exist_ok=True); destination.write_bytes(data)
            (work/'.github/workflows/link.yml').symlink_to('../../.gitlab-ci.yml')
            git('add', '.github', '.gitlab-ci.yml', '.gitlab-ci.yaml'); git('commit', '-m', 'Workflow source qualification')
            original = git('rev-parse', 'HEAD')
            git('remote', 'add', 'origin', GITEA+'/'+repository+'.git'); git('push', 'origin', 'main')
            wait_for_push(owner_token, repository)
            stage('actual pinned source discovery, blob identity and three inspection outcomes')
            result = inspect()
            assert result['commitId'] == original and result['repositoryId'] == created['repository']['id']
            assert result['catalogVersion'] == 'golf.workflow.inspect.v3'
            rows = {row['path']: row for row in result['configurations']}
            expected = {
                '.github/workflows/manual.yml': 'VALIDATED_SUBSET', '.gitlab-ci.yml': 'VALIDATED_SUBSET',
                '.github/workflows/external.yaml': 'UNSUPPORTED', '.github/workflows/alias.yml': 'UNSUPPORTED',
                '.github/workflows/link.yml': 'UNSUPPORTED', '.github/workflows/too-large.yml': 'UNSUPPORTED',
                '.github/workflows/duplicate.yml': 'INVALID', '.github/workflows/invalid-utf8.yml': 'INVALID',
            }
            assert set(rows) == set(expected)
            for name, state in expected.items():
                row = rows[name]
                assert row['state'] == 'WORKFLOW_INSPECTION_STATE_'+state
                assert row['blobId'] == git('rev-parse', original+':'+name)
                if name in files: assert int(row['byteSize']) == len(files[name])
                if state != 'VALIDATED_SUBSET': assert row.get('diagnostics')
            assert rows['.github/workflows/manual.yml']['jobs'][0]['stepCount'] == 1
            assert rows['.github/workflows/manual.yml']['events'] == ['workflow_dispatch']
            assert 'printf inspection-only' not in json.dumps(result)

            stage('branch advancement leaves old commit inspection immutable')
            (work/'.github/workflows/manual.yml').write_bytes(source.replace(b'Manual fixture', b'Advanced fixture'))
            (work/'.gitlab-ci.yml').write_bytes(files['.gitlab-ci.yml']+b'include: https://example.invalid/untrusted.yml\n')
            git('add', '.github/workflows/manual.yml', '.gitlab-ci.yml'); git('commit', '-m', 'Advance configuration observation'); git('push', 'origin', 'main')
            advanced = git('rev-parse', 'HEAD')
            assert inspect()['commitId'] == advanced
            assert inspect(original) == result
            assert next(row for row in inspect()['configurations'] if row['path'] == '.gitlab-ci.yml')['state'] == 'WORKFLOW_INSPECTION_STATE_UNSUPPORTED'

            stage('caller scopes, current access, Origin and read-only delegation remain enforced')
            inspect(session=outsider, expected=404)
            provider(owner_token, 'PUT', 'repos/'+repository+'/collaborators/'+reader_name, {'permission': 'read'}, expected=204)
            assert inspect(original, reader)['commitId'] == original
            provider(owner_token, 'DELETE', 'repos/'+repository+'/collaborators/'+reader_name, expected=204)
            inspect(original, reader, expected=404)
            narrow_token = admin('generate-access-token', '--username', owner_name, '--token-name', prefix+'-narrow', '--scopes', 'read:user', '--raw')
            narrow = client(); sessions.append(narrow); rpc(narrow, 'SessionService/LoginWithGiteaToken', {'token': narrow_token})
            inspect(session=narrow, expected=403)
            rpc(owner, procedure, {'repository': key}, headers={'Origin': 'https://other.invalid'}, expected=403)
            delegated = rpc(owner, 'ApiCredentialService/CreateApiCredential', {'label': 'No workflow browser access'})['token']
            rpc(client(), procedure, {'repository': key}, headers={'Authorization': 'Bearer '+delegated}, expected=403)
            inspect('main~1', expected=400)

            stage('file count and aggregate source bounds reject whole inventories')
            for index in range(21): (work/f'.github/workflows/count-{index}.yml').write_bytes(source)
            git('add', '.github'); git('commit', '-m', 'Too many configurations'); git('push', 'origin', 'main'); inspect(expected=429)
            for name in (work/'.github/workflows').iterdir():
                if name.is_file() or name.is_symlink(): name.unlink()
            for index in range(9): (work/f'.github/workflows/large-{index}.yml').write_bytes(b'x'*65536)
            git('add', '-A', '.github'); git('commit', '-m', 'Aggregate inspection bound'); git('push', 'origin', 'main'); inspect(expected=429)
            assert inspect(original) == result
            stage('session revocation and continued execution-disabled capability')
            rpc(owner, 'SessionService/Logout'); inspect(original, expected=401)
            capabilities = rpc(client(), 'CapabilityService/ListCapabilities')['capabilities']
            assert next(item for item in capabilities if item['id'] == 'pipelines')['state'] == 'CAPABILITY_STATE_DISABLED'
            print('Synthetic source commit: '+original, flush=True)
    finally:
        failures = []
        for session in sessions:
            try: rpc(session, 'SessionService/Logout')
            except Exception: failures.append('session cleanup')
        if repository and owner_token:
            try: provider(owner_token, 'DELETE', 'repos/'+repository, expected=204)
            except Exception: failures.append('repository cleanup')
        for name in reversed(users):
            try: admin('delete', '--username', name, '--purge')
            except Exception: failures.append('user cleanup')
        assert not failures, 'Disposable cleanup did not complete'
    print('PASS: pinned workflow configuration inspection; no workflow execution; disposable fixtures removed', flush=True)


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        print('FAIL: '+STAGE+' ('+type(error).__name__+'; private diagnostics withheld)', file=sys.stderr)
        raise SystemExit(1) from None
