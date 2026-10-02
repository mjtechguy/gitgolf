#!/usr/bin/env python3
"""Copy pinned public Git objects into private, disposable Golf repositories.

This is source-transfer/read qualification, not a production importer or a CI
engine. No checkout, workflow, package install, LFS fetch or submodule runs.
Only public source URLs are read; every destination belongs to a fresh core.
"""
import argparse
import base64
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import secrets
import subprocess
import sys
import tempfile
import uuid

sys.dont_write_bytecode = True
import smoke

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('observation_helpers', ROOT / 'scripts/observability-smoke.py')
helpers = importlib.util.module_from_spec(spec)
spec.loader.exec_module(helpers)
STAGE = 'prerequisites'
SOURCES = (
    {'provider': 'github', 'url': 'https://github.com/actions/hello-world-javascript-action.git',
     'commit': '79ac0da13ee392da3fdd151813d5ce4658cb7e27', 'source_branch': 'main', 'commits': 391,
     'workflow': '.github/workflows/ci.yml'},
    {'provider': 'gitlab', 'url': 'https://gitlab.com/gitlab-examples/nodejs.git',
     'commit': '892a1f16725e56cc3a2cb0d677be42935c8fc262', 'source_branch': 'master', 'commits': 36,
     'workflow': '.gitlab-ci.yml'},
)


def stage(value):
    global STAGE
    STAGE = value
    print('CHECK: ' + value, flush=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--image', required=True, help='already-built local Golf image')
    parser.add_argument('--cli', type=Path, required=True, help='current built Golf CLI')
    args = parser.parse_args()
    binary = args.cli.resolve()
    assert binary.is_file(), 'Build the current Golf CLI first'
    environment = {key: value for key, value in os.environ.items()
        if not key.startswith(('GOLF_', 'GITEA_', 'GITHUB_', 'GITLAB_', 'GIT_', 'POSTGRES_', 'COMPOSE_', 'OTEL_'))
        and key != 'DATABASE_URL'}
    git_environment = {**environment, 'GIT_CONFIG_NOSYSTEM': '1', 'GIT_CONFIG_GLOBAL': '/dev/null',
        'GIT_TERMINAL_PROMPT': '0', 'GIT_LFS_SKIP_SMUDGE': '1'}

    def run(*arguments, payload=None, env=None, cwd=ROOT, timeout=120):
        result = subprocess.run(arguments, input=payload, cwd=cwd, env=env or environment,
            capture_output=True, timeout=timeout)
        assert result.returncode == 0, 'Subprocess failed; private diagnostics withheld'
        assert len(result.stdout) <= 8 << 20 and len(result.stderr) <= 8 << 20, 'Unexpected output size'
        return result.stdout

    image = json.loads(run('docker', 'image', 'inspect', args.image))[0]['Id']
    assert image.startswith('sha256:')
    print('Golf image: ' + image, flush=True)
    project = 'golf-api-proof-' + secrets.token_hex(5)
    golf_port, forge_port = helpers.free_ports(2)
    original_urls = smoke.GOLF, smoke.GITEA
    smoke.GOLF, smoke.GITEA = f'http://127.0.0.1:{golf_port}', f'http://127.0.0.1:{forge_port}'
    with tempfile.TemporaryDirectory(prefix='golf-public-proof-') as temporary:
        directory = Path(temporary).resolve(); directory.chmod(0o700)
        hooks = directory/'no-hooks'; hooks.mkdir()

        def git(path, *arguments, authenticated=False):
            env = git_environment
            if authenticated:
                # The sole credential-bearing Git configuration is bound to the
                # isolated destination origin and never used for public fetches.
                auth = base64.b64encode((owner_name + ':' + owner_token).encode()).decode()
                env = {**env, 'GIT_CONFIG_COUNT': '1', 'GIT_CONFIG_KEY_0': f'http.{smoke.GITEA}/.extraHeader',
                    'GIT_CONFIG_VALUE_0': 'Authorization: Basic ' + auth}
            return run('git', '-c', 'credential.helper=', '-c', f'core.hooksPath={hooks}',
                '-c', 'protocol.file.allow=never', '-c', 'protocol.ext.allow=never',
                '-c', 'http.followRedirects=false', *arguments, cwd=path, env=env)

        prepared = []
        for source in SOURCES:
            stage(source['provider'] + ': read pinned public source without executing repository content')
            path = directory/source['provider']; path.mkdir()
            git(path, 'init', '--bare', '--template=')
            git(path, 'fetch', '--no-tags', source['url'], source['commit'])
            assert git(path, 'rev-parse', 'FETCH_HEAD').decode().strip() == source['commit']
            git(path, 'fsck', '--full', '--strict', '--no-reflogs', source['commit'])
            history = git(path, 'rev-list', source['commit']).decode().splitlines()
            assert len(history) == source['commits'] and len(set(history)) == len(history)
            files = git(path, 'ls-tree', '-r', '--name-only', source['commit']).decode().splitlines()
            workflows = [name for name in files if name == '.gitlab-ci.yml' or name.startswith('.github/workflows/') and name.endswith(('.yml', '.yaml'))]
            assert source['workflow'] in workflows and 'README.md' in files and 'LICENSE' in files
            bodies = {name: git(path, 'show', source['commit'] + ':' + name).decode('utf-8')
                for name in ['README.md', 'LICENSE', *workflows]}
            assert all(len(body.encode()) <= 256 << 10 for body in bodies.values())
            assert sum(file.stat().st_size for file in path.rglob('*') if file.is_file()) < 64 << 20
            prepared.append((source, path, history, bodies))

        env_file, override = directory/'core.env', directory/'proof.yaml'
        values = {key: secrets.token_hex(24) for key in ['POSTGRES_PASSWORD', 'GOLF_DB_PASSWORD', 'GITEA_DB_PASSWORD']}
        values.update(GOLF_ENCRYPTION_KEY=base64.b64encode(secrets.token_bytes(32)).decode(),
            GOLF_PUBLIC_URL=smoke.GOLF, GOLF_ENCRYPTION_KEYS='', GOLF_ACTIVE_ENCRYPTION_KEY='',
            GITEA_PUBLIC_URL='', GITEA_OAUTH_CLIENT_ID='', GITEA_OAUTH_CLIENT_SECRET='')
        helpers.private_write(env_file, ''.join(key+'='+value+'\n' for key, value in values.items()))
        helpers.private_write(override, f'''services:
  golf:
    image: {image}
    pull_policy: never
    ports: !override ["127.0.0.1:{golf_port}:8080"]
  gitea:
    environment:
      GITEA__server__ROOT_URL: {smoke.GITEA}/
      GITEA__actions__ENABLED: 'false'
    ports: !override ["127.0.0.1:{forge_port}:3000"]
''')
        compose = ['docker', 'compose', '-p', project, '--env-file', str(env_file),
            '-f', str(ROOT/'compose.yaml'), '-f', str(override)]

        def command(*arguments, **kwargs):
            return run(*compose, *arguments, **kwargs)

        def admin(*arguments):
            return command('exec', '-T', 'gitea', 'gitea', '--config', '/etc/gitea/app.ini',
                'admin', 'user', *arguments).decode().strip()

        started = False
        try:
            stage('isolated canonical core with Actions disabled and no runner services')
            rendered = json.loads(command('config', '--format', 'json'))
            assert set(rendered['services']) == {'golf', 'gitea', 'postgres'}
            assert str(rendered['services']['gitea']['environment']['GITEA__actions__ENABLED']).lower() == 'false'
            assert not rendered['services']['postgres'].get('ports')
            assert all(port['host_ip'] == '127.0.0.1' for service in rendered['services'].values() for port in service.get('ports', []))
            started = True
            command('up', '-d', '--no-build', '--wait', '--wait-timeout', '120', timeout=180)
            smoke.ready()
            assert json.loads(run('docker', 'inspect', project+'-golf-1'))[0]['Image'] == image
            assert smoke.provider('', 'GET', 'version')['version'] == '1.27.3'
            capabilities = smoke.rpc(smoke.client(), 'CapabilityService/ListCapabilities')['capabilities']
            assert next(item for item in capabilities if item['id'] == 'pipelines')['state'] == 'CAPABILITY_STATE_DISABLED'
            identities = {}
            for role in ['owner', 'outsider']:
                name = 'golf-public-' + role + '-' + secrets.token_hex(4)
                admin('create', '--username', name, '--email', name+'@example.invalid', '--random-password',
                    '--random-password-length', '32', '--must-change-password=false')
                token = admin('generate-access-token', '--username', name, '--token-name', project,
                    '--scopes', 'write:user,write:repository' if role == 'owner' else 'read:user,read:repository', '--raw')
                session = smoke.client()
                assert smoke.rpc(session, 'SessionService/LoginWithGiteaToken', {'token': token})['user']['login'] == name
                identities[role] = (name, token, session)
            owner_name, owner_token, owner = identities['owner']
            outsider = identities['outsider'][2]
            for source, path, history, bodies in prepared:
                stage(source['provider'] + ': create through Golf and push only to the private local destination')
                key = {'owner': owner_name, 'name': source['provider']+'-source'}
                created = smoke.rpc(owner, 'RepositoryService/CreateRepository', {'name': key['name'],
                    'description': 'Pinned public-source qualification; workflows are not executed.', 'private': True,
                    'idempotencyKey': str(uuid.uuid4())})
                assert created['creation']['state'] == 'REPOSITORY_CREATION_STATE_SUCCEEDED'
                assert created['repository']['private'] and created['repository']['empty']
                remote = smoke.GITEA+'/'+owner_name+'/'+key['name']+'.git'
                git(path, 'push', '--atomic', remote, source['commit']+':refs/heads/main',
                    source['commit']+':refs/tags/qualification-source', authenticated=True)
                smoke.wait_for_push(owner_token, owner_name+'/'+key['name'])
                refs = dict(line.split()[::-1] for line in git(path, 'ls-remote', '--refs', remote, authenticated=True).decode().splitlines())
                assert refs == {'refs/heads/main': source['commit'], 'refs/tags/qualification-source': source['commit']}
                stage(source['provider'] + ': exact immutable source, full selected history, workflow bytes and privacy')
                branches = smoke.rpc(owner, 'RepositoryService/ListBranches', {'repository': key})['branches']
                assert [(branch['name'], branch['commitId']) for branch in branches] == [('main', source['commit'])]
                observed, page = [], 1
                for _ in range(10):
                    result = smoke.rpc(owner, 'RepositoryService/ListCommits', {'repository': key, 'ref': source['commit'], 'page': {'page': page, 'limit': 100}})
                    observed.extend(commit['sha'] for commit in result.get('commits', []))
                    following = result.get('page', {}).get('nextPage', 0)
                    if not following: break
                    assert following == page + 1
                    page = following
                else: raise AssertionError('Pinned history pagination did not terminate')
                assert observed[0] == source['commit'] and len(observed) == len(history) and set(observed) == set(history)
                for name, body in bodies.items():
                    content = smoke.content(owner, key, source['commit'], name)
                    assert content['commitId'] == source['commit'] and content['file']['content'] == body
                    expected_blob = git(path, 'rev-parse', source['commit']+':'+name).decode().strip()
                    assert content['file']['entry']['sha'] == expected_blob
                before = smoke.rpc(owner, 'SessionService/ListSessions', {})['sessions']
                output = run(str(binary), '--token-stdin', 'repo', 'contents', owner_name+'/'+key['name'],
                    '--ref', source['commit'], '--path', source['workflow'], payload=(owner_token+'\n').encode(),
                    env={**environment, 'GOLF_URL': smoke.GOLF})
                assert owner_token.encode() not in output
                envelope = json.loads(output)
                assert envelope['schema_version'] == 'golf.cli.v1' and envelope['data']['commitId'] == source['commit']
                assert envelope['data']['file']['content'] == bodies[source['workflow']]
                after = smoke.rpc(owner, 'SessionService/ListSessions', {})['sessions']
                assert {row['id'] for row in before} == {row['id'] for row in after}
                smoke.rpc(outsider, 'RepositoryService/GetRepository', {'repository': key}, expected=404)
                smoke.rpc(outsider, 'RepositoryService/GetContents', {'repository': key, 'ref': source['commit'], 'path': source['workflow']}, expected=404)
                print(json.dumps({'provider': source['provider'], 'source_commit': source['commit'], 'history_commits': len(history),
                    'destination_branch': 'main', 'source_branch': source['source_branch'], 'workflow_files': [
                        {'path': name, 'sha256': hashlib.sha256(body.encode()).hexdigest(), 'bytes': len(body.encode())}
                        for name, body in bodies.items() if name not in ['README.md', 'LICENSE']],
                    'source_transfer': 'verified', 'ci_execution': 'unsupported_not_run',
                    'reason': 'No qualified Golf Actions/GitLab compiler, coordinator or runner is installed.'}), flush=True)
            for _, _, session in identities.values():
                smoke.rpc(session, 'SessionService/Logout')
            print('PASS: pinned GitHub/GitLab source transfer, selected refs/history, Golf API/CLI reads and privacy; workflows NOT executed', flush=True)
        finally:
            smoke.GOLF, smoke.GITEA = original_urls
            if started:
                command('down', '--volumes', '--remove-orphans', '--timeout', '10')
            for resource, action in [('container', 'ls'), ('volume', 'ls'), ('network', 'ls')]:
                extra = ['-a'] if resource == 'container' else []
                assert not run('docker', resource, action, *extra, '-q', '--filter', 'label=com.docker.compose.project='+project).strip()
            print('PASS: isolated core resources removed; public sources and normal installation unchanged', flush=True)


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        import traceback
        locations = ','.join(str(frame.lineno) for frame in traceback.extract_tb(error.__traceback__)[-3:])
        print('FAIL: '+STAGE+' ('+type(error).__name__+', lines '+locations+'; private diagnostics withheld)', file=sys.stderr)
        raise SystemExit(1)
