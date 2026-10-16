#!/usr/bin/env python3
"""Real local Git/SSH qualification through Golf-managed public keys.

Creates and purges disposable users/repos/keys. Does not restart services or
change retained accounts. Private keys exist only in a temporary 0700 directory.
Native account SSH keys intentionally survive Golf logout; this does not qualify
Golf suspension, session-scoped agent credentials or protected merges.
"""
import os
import json
import sys
sys.dont_write_bytecode = True
from pathlib import Path
import secrets
import shlex
import subprocess
import tempfile

from smoke import GOLF, FORGE, ROOT, admin, client, command, commit, pages, provider, ready, rpc, wait_for_push


def git(work, env, *args, fail=False):
    result = subprocess.run(['git', '-c', 'credential.helper=', *args], cwd=work, env=env,
                            capture_output=True, text=True, timeout=30)
    assert (result.returncode != 0) if fail else (result.returncode == 0), 'Git result unexpected; sensitive output withheld'
    return result.stdout.strip()


def main():
    ready()
    prefix = 'golf-git-access-' + secrets.token_hex(4)
    users, sessions = [], []
    try:
        actors = []
        for role in ['owner', 'outsider']:
            name = prefix + '-' + role
            admin('create', '--username', name, '--email', name+'@example.invalid', '--random-password', '--must-change-password=false')
            users.append(name)
            token = admin('generate-access-token', '--username', name, '--token-name', prefix,
                          '--scopes', 'write:user,write:repository', '--raw')
            session = client(); sessions.append(session)
            rpc(session, 'SessionService/LoginWithForgeToken', {'token': token})
            actors.append((name, token, session))
        name, token, owner = actors[0]
        outsider = actors[1][2]
        repo = rpc(owner, 'RepositoryService/CreateRepository', {'name': 'private', 'private': True})['repository']
        assert repo['cloneUrl'] == FORGE+'/'+repo['fullName']+'.git', 'Clone URL must use the public Git origin'
        repository = {'owner': name, 'name': 'private'}
        keys = []
        with tempfile.TemporaryDirectory(prefix='golf-ssh-proof-') as directory:
            root = Path(directory)
            for index, session in enumerate([owner, owner, outsider]):
                path = root / ('key-'+str(index))
                command('ssh-keygen', '-q', '-t', 'ed25519', '-N', '', '-f', str(path))
                row = rpc(session, 'GitAccessService/AddSSHKey', {'title': 'Key '+str(index),
                          'publicKey': path.with_suffix('.pub').read_text()})['key']
                assert row['fingerprint'].startswith('SHA256:')
                keys.append(row)
            rows = pages(owner, 'GitAccessService/ListSSHKeys', {}, 'keys')
            assert {row['id'] for row in rows} == {row['id'] for row in keys[:2]}
            rpc(outsider, 'GitAccessService/DeleteSSHKey', {'keyId': keys[0]['id']}, expected=404)
            read_token = admin('generate-access-token', '--username', name, '--token-name', prefix+'-read', '--scopes', 'read:user', '--raw')
            read_session = client(); sessions.append(read_session)
            rpc(read_session, 'SessionService/LoginWithForgeToken', {'token': read_token})
            rpc(read_session, 'GitAccessService/AddSSHKey', {'title': 'Denied', 'publicKey': (root/'key-0.pub').read_text()}, expected=403)
            rpc(owner, 'GitAccessService/AddSSHKey', {'title': 'Private key rejected', 'publicKey': (root/'key-0').read_text()}, expected=400)
            rpc(owner, 'GitAccessService/AddSSHKey', {'title': 'Duplicate', 'publicKey': (root/'key-0.pub').read_text()}, expected=400, code='failed_precondition')
            delegation = rpc(owner, 'ApiCredentialService/CreateApiCredential', {'label':'Denied SSH lifecycle'})['token']
            for method in ['ListSSHKeys', 'AddSSHKey', 'DeleteSSHKey']:
                rpc(client(), 'GitAccessService/'+method, headers={'Authorization': 'Bearer '+delegation}, expected=403)
            rpc(owner, 'GitAccessService/DeleteSSHKey', {'keyId': keys[0]['id']}, headers={'Origin':'https://other.invalid'}, expected=403)
            known = root/'known_hosts'
            known.write_text(command('ssh-keyscan', '-4', '-T', '3', '-t', 'ed25519', '-p', '2222', 'localhost'))
            def ssh_env(index):
                args = ['ssh','-4','-F','/dev/null','-i',str(root/('key-'+str(index))),
                        '-o','IdentityAgent=none','-o','IdentitiesOnly=yes','-o','BatchMode=yes',
                        '-o','StrictHostKeyChecking=yes','-o','UserKnownHostsFile='+str(known),
                        '-o','ControlMaster=no','-o','ControlPath=none']
                return {**os.environ, 'GIT_SSH_COMMAND':shlex.join(args), 'GIT_TERMINAL_PROMPT':'0'}
            env = ssh_env(0)
            work = root/'work'; work.mkdir()
            git(work, env, 'init', '-b', 'main')
            (work/'README.md').write_text('Golf Git lifecycle\n')
            git(work, env, 'add', '.'); initial = commit(work, 'Initial SSH push')
            git(work, env, 'remote', 'add', 'origin', repo['sshUrl'])
            git(work, env, 'push', '-u', 'origin', 'main'); wait_for_push(token, repo['fullName'])
            clone = root/'clone'
            git(root, env, 'clone', repo['sshUrl'], str(clone))
            assert git(clone, env, 'rev-parse', 'HEAD') == initial
            git(work, env, 'checkout', '-b', 'feature/ssh-workflow')
            (work/'feature.txt').write_text('branch workflow\n'); git(work, env, 'add', '.')
            feature = commit(work, 'Feature branch')
            git(work, env, 'push', '-u', 'origin', 'HEAD')
            git(clone, env, 'fetch', 'origin')
            assert git(clone, env, 'rev-parse', 'origin/feature/ssh-workflow') == feature
            previous = feature
            git(work, env, '-c', 'user.name=Golf Check', '-c', 'user.email=check@example.invalid',
                'commit', '--amend', '-m', 'Revised feature branch')
            feature = git(work, env, 'rev-parse', 'HEAD')
            assert feature != previous
            git(work, env, 'push', '--force-with-lease=refs/heads/feature/ssh-workflow:'+previous, 'origin', 'HEAD')
            # A stale expected-old ref must reject a different candidate.
            git(work, env, 'push', '--force-with-lease=refs/heads/feature/ssh-workflow:'+previous,
                'origin', 'main:refs/heads/feature/ssh-workflow', fail=True)
            git(clone, env, 'fetch', 'origin')
            assert git(clone, env, 'rev-parse', 'origin/feature/ssh-workflow') == feature
            # Configure identity for annotated tag without affecting the user's Git config.
            git(work, env, '-c', 'user.name=Golf Check', '-c', 'user.email=check@example.invalid',
                'tag', '-a', 'v0.0.0-proof', '-m', 'Temporary proof')
            git(work, env, 'push', 'origin', 'refs/tags/v0.0.0-proof')
            assert feature in git(clone, env, 'ls-remote', 'origin', 'refs/tags/v0.0.0-proof^{}')
            git(root, ssh_env(2), 'clone', repo['sshUrl'], str(root/'denied'), fail=True)
            # Local merge behavior is Git-owned; qualify the resulting transport.
            git(clone, env, 'checkout', '-b', 'integration', 'origin/main')
            git(clone, env, '-c', 'user.name=Golf Check', '-c', 'user.email=check@example.invalid', 'merge', '--no-ff', 'origin/feature/ssh-workflow', '-m', 'Local merge proof')
            git(clone, env, 'push', 'origin', 'HEAD:refs/heads/integration')
            git(work, env, 'push', 'origin', '--delete', 'feature/ssh-workflow', 'v0.0.0-proof')
            assert 'feature/ssh-workflow' not in git(clone, env, 'ls-remote', 'origin')
            observed = rpc(owner, 'RepositoryService/ListBranches', {'repository': repository})
            assert {row['name'] for row in observed['branches']} == {'main','integration'}
            # Also verify password-independent native token HTTP clone/fetch.
            askpass = root/'askpass.py'
            askpass.write_text('#!/usr/bin/env python3\nimport os,sys\nprint(os.environ["GOLF_CHECK_USER"] if "Username" in sys.argv[1] else os.environ["GOLF_CHECK_TOKEN"])\n')
            askpass.chmod(0o700)
            http_env = {**os.environ,'GIT_ASKPASS':str(askpass),'GIT_TERMINAL_PROMPT':'0', 'GOLF_CHECK_USER':name,'GOLF_CHECK_TOKEN':token}
            http_clone = root/'http-clone'
            git(root,http_env,'clone',repo['cloneUrl'],str(http_clone))
            git(http_clone,http_env,'fetch','origin')
            assert git(http_clone,http_env,'rev-parse','HEAD')==initial
            rpc(owner, 'GitAccessService/DeleteSSHKey', {'keyId': keys[0]['id']})
            git(clone, env, 'ls-remote', 'origin', fail=True)
            git(clone, ssh_env(1), 'ls-remote', 'origin')
            assert keys[0]['id'] not in {row['id'] for row in pages(owner,'GitAccessService/ListSSHKeys',{},'keys')}
            command('ssh-keygen','-q','-t','ed25519','-N','','-f',str(root/'browser-key'))
            proof = subprocess.run(['node','scripts/git-access-browser.mjs'], cwd=ROOT,
                input=json.dumps({'golf':GOLF,'token':token,'publicKey':(root/'browser-key.pub').read_text()}),
                capture_output=True,text=True,timeout=90)
            assert proof.returncode==0, proof.stderr.strip() or 'Browser proof failed; sensitive output withheld'
            print(proof.stdout.strip())
        print('PASS: Golf SSH add/list/delete, owner isolation, read-scope/API/Origin denial and public-key validation')
        print('PASS: real private SSH clone/fetch/push, branches, amend/force-with-lease, annotated tags, local merge transport and deletion')
        print('PASS: private HTTP clone/fetch and new SSH connection denied after key removal')
    finally:
        for session in sessions:
            rpc(session,'SessionService/Logout')
        for name in reversed(users):
            admin('delete','--username',name,'--purge')
        print('Disposable Git users, repositories and keys removed.')


if __name__ == '__main__':
    main()
