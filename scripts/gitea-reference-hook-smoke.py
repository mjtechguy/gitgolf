#!/usr/bin/env python3
"""SOURCE-ONLY PREPARED qualifier: fresh operator-global Gitea hook composition.

The operator supplies cached exact images and a precompiled Linux fixture. This
script never builds/pulls, edits native repositories/SQL, or runs a Golf policy.
Actual invocation creates and destroys its own stack through supported facilities.
"""
import argparse
import ast
import base64
import hashlib
import json
import os
from pathlib import Path
import re
import secrets
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import traceback
import urllib.error
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
BOUND = 2 << 20
HOOKS = ('pre-receive', 'update', 'post-receive', 'proc-receive', 'reference-transaction')
PIN = re.compile(r'^sha256:[0-9a-f]{64}$')
OID = re.compile(r'^[0-9a-f]{40}$')


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, response, code, message, headers, newurl):
        return None


def require(value):
    if not value:
        raise AssertionError('fixed fixture predicate failed')


def write_json(path, value):
    temporary = path.with_suffix(path.suffix + '.new')
    with open(temporary, 'x', encoding='utf-8') as handle:
        os.chmod(temporary, 0o600)
        json.dump(value, handle, sort_keys=True, indent=2)
    os.replace(temporary, path)


def foreign_diff(before, after):
    before = {row['id']: row for row in before}
    after = {row['id']: row for row in after}
    identity = sorted(before) == sorted(after) and all(
        all(before[key][field] == after[key][field] for field in ('image', 'status', 'running'))
        for key in before if key in after)
    observations = [{'id': key, 'before': {field: before[key][field] for field in ('startedAt', 'restartCount')},
                     'after': {field: after[key][field] for field in ('startedAt', 'restartCount')}}
                    for key in sorted(set(before) & set(after))
                    if any(before[key][field] != after[key][field] for field in ('startedAt', 'restartCount'))]
    return {'foreignIdentityUnchanged': identity, 'lifecycleObservations': observations, 'causeAsserted': False,
            'missing': sorted(set(before) - set(after)), 'extra': sorted(set(after) - set(before))}


def telemetry(raw):
    require(len(raw.encode()) <= 512 << 10)
    rows = [json.loads(line) for line in raw.splitlines()]
    require(0 < len(rows) <= 512)
    rows.sort(key=lambda row: row['sequence'])
    require([row['sequence'] for row in rows] == list(range(1, len(rows) + 1)))
    for row in rows:
        require(set(row) <= {'version', 'sequence', 'hook', 'state', 'context', 'gitVersion',
                            'hooksPathVerified', 'decision', 'updates', 'delegateExit'})
        require(row['version'] == 1 and row['hook'] in HOOKS and row['gitVersion'] == 'git version 2.54.0'
                and row['hooksPathVerified'] is True)
        require(row['context'] in ('owned_receiver', 'temporary_clone', 'unclassified'))
    return rows


def marker_events(rows, old, new=None):
    return [row for row in rows if row['hook'] == 'reference-transaction' and row.get('state') == 'prepared'
            and row['context'] == 'owned_receiver' and row['decision'] == 'reject_marker'
            and any(update['ref'] == 'refs/heads/main' and update['old'] == old
                    and (new is None or update['new'] == new) for update in row.get('updates', []))]


def self_check():
    tree = ast.parse(Path(__file__).read_text())
    require(not any(isinstance(node, ast.Name) and isinstance(node.ctx, (ast.Store, ast.Del))
                    and node.id in ('subprocess_run', 'inventory', 'api', 'cli') for node in ast.walk(tree)))
    # A lifecycle counter alone is an observation. Identity/image/runtime drift
    # remains a failure; neither is silently relabeled completely unchanged.
    baseline = [{'id': 'a', 'image': 'pin', 'status': 'running', 'running': True,
                 'startedAt': 'first', 'restartCount': 0}]
    moved = [dict(baseline[0], startedAt='next', restartCount=1)]
    require(foreign_diff(baseline, moved)['foreignIdentityUnchanged'])
    require(len(foreign_diff(baseline, moved)['lifecycleObservations']) == 1)
    require(not foreign_diff(baseline, [dict(baseline[0], image='different')])['foreignIdentityUnchanged'])
    row = {'version': 1, 'sequence': 1, 'hook': 'reference-transaction', 'state': 'prepared',
           'context': 'owned_receiver', 'gitVersion': 'git version 2.54.0', 'hooksPathVerified': True,
           'decision': 'reject_marker', 'updates': [{'old': '1'*40, 'new': '2'*40, 'ref': 'refs/heads/main'}]}
    require(len(marker_events(telemetry(json.dumps(row)), '1'*40, '2'*40)) == 1)
    require(not marker_events([dict(row, context='temporary_clone')], '1'*40, '2'*40))
    try:
        telemetry(json.dumps(dict(row, sequence=2)))
    except AssertionError:
        pass
    else:
        raise AssertionError('sequence gap accepted')
    print('PASS: closed telemetry, exact receiver veto and foreign identity predicates')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--native-image', help='cached exact sha256 image ID; runtime must be Gitea 1.27.3')
    parser.add_argument('--postgres-image', help='cached exact sha256 image ID; runtime must be PostgreSQL 18.4')
    parser.add_argument('--hook-binary', type=Path, help='operator-built static Linux reference-hook-fixture')
    parser.add_argument('--hook-sha256', help='independently pinned full helper SHA256')
    parser.add_argument('--output', type=Path, help='new private evidence directory')
    parser.add_argument('--stack-root', type=Path, default=ROOT)
    parser.add_argument('--self-check', action='store_true', help='pure checks; no Docker/network/Git')
    args = parser.parse_args()
    if args.self_check:
        self_check()
        return
    require(args.output and args.hook_binary and PIN.fullmatch(args.native_image or '')
            and PIN.fullmatch(args.postgres_image or '') and re.fullmatch(r'[0-9a-f]{64}', args.hook_sha256 or ''))
    args.output = args.output.resolve()
    args.output.mkdir(mode=0o700, parents=False, exist_ok=False)
    require(not args.output.is_symlink())
    os.chmod(args.output, 0o700)
    project = 'golf-hook-' + secrets.token_hex(5)
    owner_name = project + '-owner'
    manifest = {'status': 'pending', 'scope': 'operator_global_hook_composition_only', 'project': project,
                'nativeVersion': '1.27.3', 'requiredGitVersion': '2.54.0', 'nativeImage': args.native_image,
                'postgresImage': args.postgres_image, 'helperSha256': args.hook_sha256, 'fullP08Qualified': False,
                'cleanup': {'ownResourcesZero': False}, 'checks': []}
    stage = 'source_and_cached_artifacts'

    def subprocess_run(*command, env=None, cwd=None, expected=0, timeout=45):
        result = subprocess.run(command, env=env, cwd=cwd, capture_output=True, timeout=timeout)
        require(len(result.stdout) <= BOUND and len(result.stderr) <= BOUND)
        if expected is not None:
            require(result.returncode == expected)
        return result.returncode, result.stdout.decode('utf-8', 'strict')

    def inventory():
        ids = subprocess_run('docker', 'ps', '-aq')[1].split()
        if not ids:
            return []
        template = ('{"id":{{json .Id}},"image":{{json .Image}},"status":{{json .State.Status}},'
                    '"running":{{json .State.Running}},"startedAt":{{json .State.StartedAt}},'
                    '"restartCount":{{json .RestartCount}}}')
        return [json.loads(line) for line in subprocess_run('docker', 'inspect', '--format', template, *ids)[1].splitlines()]

    before = None
    failure = None
    users = []
    compose = None
    reserve_name = project + '-reserve'
    reserve_started = False
    owner_token = None
    repository_created = False
    with tempfile.TemporaryDirectory(prefix=project+'-') as temporary:
        directory = Path(temporary); os.chmod(directory, 0o700)
        try:
            binary = args.hook_binary.read_bytes()
            require(0 < len(binary) <= 32 << 20 and hashlib.sha256(binary).hexdigest() == args.hook_sha256
                    and binary[:4] == b'\x7fELF' and binary[4:6] == b'\x02\x01')
            native = json.loads(subprocess_run('docker', 'image', 'inspect', args.native_image)[1])[0]
            pg = json.loads(subprocess_run('docker', 'image', 'inspect', args.postgres_image)[1])[0]
            require(native['Id'] == args.native_image and pg['Id'] == args.postgres_image)
            require(int.from_bytes(binary[18:20], 'little') == {'arm64': 183, 'amd64': 62}[native['Architecture']])
            before = inventory(); write_json(args.output / 'foreign-before.json', before)
            for kind in ('container', 'volume', 'network'):
                require(not subprocess_run('docker', kind, 'ls', '-aq' if kind == 'container' else '-q',
                                           '--filter', 'label=com.docker.compose.project='+project)[1].strip())
            require(not subprocess_run('docker', 'ps', '-aq', '--filter', 'name=^/'+reserve_name+'$')[1].strip())
            stage = 'disk_reserve'
            reserve_started = True
            _, df = subprocess_run('docker', 'run', '--rm', '--name', reserve_name, '--label',
                'com.docker.compose.project='+project, '--pull', 'never', '--network', 'none', '--read-only',
                '--memory', '32m', '--pids-limit', '16', '--cap-drop', 'ALL', '--security-opt',
                'no-new-privileges', '--entrypoint', '/bin/df', args.native_image, '-Pk', '/')
            require(int(df.splitlines()[-1].split()[3]) >= 2*1024*1024)
            hook_dir = directory / 'hooks'; hook_dir.mkdir(mode=0o755)
            shutil.copyfile(args.hook_binary, hook_dir / 'fixture'); os.chmod(hook_dir / 'fixture', 0o555)
            descriptor = {'receiver': '/var/lib/gitea/git/repositories/'+owner_name+'/native-hook.git',
                          'deniedRef': 'refs/heads/main'}
            (hook_dir / 'fixture.json').write_text(json.dumps(descriptor)); os.chmod(hook_dir / 'fixture.json', 0o444)
            for name in HOOKS:
                (hook_dir / name).write_text('#!/bin/sh\nexec /opt/golf-hook-fixture/fixture --hook '+name+' -- "$@"\n')
                os.chmod(hook_dir / name, 0o555)
            os.chmod(hook_dir, 0o555)
            manifest['bundleSha256'] = hashlib.sha256(b''.join(name.encode()+b'\x00'+(hook_dir/name).read_bytes()
                for name in sorted(path.name for path in hook_dir.iterdir()))).hexdigest()
            with socket.socket() as sock:
                sock.bind(('127.0.0.1', 0)); port = sock.getsockname()[1]
            base = 'http://127.0.0.1:'+str(port)
            native_env = {'GITEA__database__DB_TYPE': 'postgres', 'GITEA__database__HOST': 'postgres:5432',
                'GITEA__database__NAME': 'gitea', 'GITEA__database__USER': 'gitea',
                'GITEA__database__PASSWD': secrets.token_urlsafe(32), 'GITEA__server__ROOT_URL': base+'/',
                'GITEA__server__APP_DATA_PATH': '/var/lib/gitea/data',
                'GITEA__server__APP_TEMP_PATH': '',
                'GITEA__repository__ROOT': '/var/lib/gitea/git/repositories',
                'GITEA__server__DISABLE_SSH': 'true', 'GITEA__security__INSTALL_LOCK': 'true',
                'GITEA__service__DISABLE_REGISTRATION': 'true', 'GITEA__actions__ENABLED': 'false'}
            spec = {'services': {'postgres': {'image': args.postgres_image, 'pull_policy': 'never',
                'command': ['postgres', '-c', 'max_wal_size=64MB', '-c', 'min_wal_size=32MB', '-c', 'checkpoint_timeout=30s'],
                'environment': {'POSTGRES_PASSWORD': secrets.token_urlsafe(32), 'GOLF_DB_PASSWORD': secrets.token_urlsafe(32),
                                'GITEA_DB_PASSWORD': native_env['GITEA__database__PASSWD']},
                'volumes': ['postgres-data:/var/lib/postgresql', str(args.stack_root.resolve()/'deploy/postgres/init.sh')+':/docker-entrypoint-initdb.d/01-golf.sh:ro'],
                'mem_limit': '384m', 'pids_limit': 128, 'healthcheck': {'test': ['CMD-SHELL', 'pg_isready -U postgres'],
                'interval': '2s', 'timeout': '3s', 'retries': 45}},
                'gitea': {'image': args.native_image, 'pull_policy': 'never', 'environment': native_env,
                'ports': ['127.0.0.1:'+str(port)+':3000'], 'mem_limit': '512m', 'pids_limit': 256,
                'volumes': ['gitea-data:/var/lib/gitea', 'gitea-config:/etc/gitea', str(hook_dir)+':/opt/golf-hook-fixture:ro'],
                'tmpfs': ['/run/golf-hook-telemetry:rw,nosuid,nodev,noexec,size=1048576,mode=0700,uid=1000,gid=1000'],
                'depends_on': {'postgres': {'condition': 'service_healthy'}}}},
                'volumes': {'postgres-data': {}, 'gitea-data': {}, 'gitea-config': {}}}
            spec_path = directory / 'compose.json'; write_json(spec_path, spec)
            compose = ['docker', 'compose', '--project-name', project, '--file', str(spec_path)]

            def cli(*words, expected=0):
                return subprocess_run(*compose, 'exec', '-T', 'gitea', 'gitea', '--config', '/etc/gitea/app.ini',
                                      'admin', 'user', *words, expected=expected)

            def api(token, method, path, payload=None, expected=200):
                require(path == 'version' or path.startswith(('admin/users', 'repos/'+owner_name+'/', 'user/repos')))
                headers = {'Accept': 'application/json', 'Content-Type': 'application/json'}
                if token: headers['Authorization'] = 'token '+token
                request = urllib.request.Request(base+'/api/v1/'+path, method=method, headers=headers,
                    data=None if payload is None else json.dumps(payload).encode())
                try: response = urllib.request.build_opener(NoRedirect()).open(request, timeout=30)
                except urllib.error.HTTPError as error: response = error
                with response:
                    raw = response.read(BOUND+1); require(len(raw) <= BOUND)
                    if expected is not None: require(response.status in ((expected,) if isinstance(expected, int) else expected))
                    return response.status, json.loads(raw) if raw else None

            def ready():
                deadline = time.monotonic()+90
                while True:
                    try:
                        require(api(None, 'GET', 'version')[1]['version'] == '1.27.3'); return
                    except (OSError, urllib.error.URLError, AssertionError):
                        require(time.monotonic() < deadline); time.sleep(0.5)

            def token_for(name):
                value = cli('generate-access-token', '--username', name, '--token-name', project,
                            '--scopes', 'write:admin,write:user,write:repository,write:issue', '--raw')[1].strip()
                require(re.fullmatch(r'[0-9a-f]{40}', value)); return value

            def git_env(actor):
                env = {key: value for key, value in os.environ.items() if not key.startswith(('GIT_', 'GOLF_'))}
                env.update({'GIT_CONFIG_NOSYSTEM': '1', 'GIT_CONFIG_GLOBAL': os.devnull, 'GIT_TERMINAL_PROMPT': '0',
                    'GIT_CONFIG_COUNT': '3', 'GIT_CONFIG_KEY_0': 'http.extraHeader',
                    'GIT_CONFIG_VALUE_0': 'Authorization: Basic '+base64.b64encode((actor['name']+':'+actor['token']).encode()).decode(),
                    'GIT_CONFIG_KEY_1': 'credential.helper', 'GIT_CONFIG_VALUE_1': '',
                    'GIT_CONFIG_KEY_2': 'http.followRedirects', 'GIT_CONFIG_VALUE_2': 'false'})
                return env

            def events():
                return telemetry(subprocess_run(*compose, 'exec', '-T', 'gitea', 'sh', '-c',
                                                'cat /run/golf-hook-telemetry/*.json')[1])

            stage = 'bootstrap_and_seed'
            subprocess_run(*compose, 'up', '-d', '--pull', 'never', timeout=120); ready()
            pg_version = subprocess_run(*compose, 'exec', '-T', 'postgres', 'postgres', '--version')[1].strip()
            require(pg_version.startswith('postgres (PostgreSQL) 18.4'))
            require(subprocess_run(*compose, 'exec', '-T', 'gitea', '/usr/bin/git', '--version')[1].strip() == 'git version 2.54.0')
            bootstrap = project+'-bootstrap'; cli('create', '--username', bootstrap, '--email', bootstrap+'@example.invalid',
                '--random-password', '--random-password-length', '32', '--admin', '--must-change-password=false'); users.append(bootstrap)
            bootstrap_token = token_for(bootstrap); actors = {}
            for role in ('owner', 'writer', 'reader', 'outsider'):
                name = project+'-'+role
                row = api(bootstrap_token, 'POST', 'admin/users', {'username': name, 'email': name+'@example.invalid',
                    'password': secrets.token_urlsafe(32), 'must_change_password': False, 'send_notify': False}, 201)[1]
                require(row['is_admin'] is False and row['id'] > 0); users.append(name)
                actors[role] = {'name': name, 'id': row['id'], 'token': token_for(name)}
            owner_token = actors['owner']['token']
            repo = api(owner_token, 'POST', 'user/repos', {'name': 'native-hook', 'private': True,
                       'auto_init': True, 'default_branch': 'main'}, 201)[1]; repository_created = True
            route = 'repos/'+owner_name+'/native-hook'
            require(repo['full_name'] == owner_name+'/native-hook' and repo['id'] > 0 and repo['owner']['id'] == actors['owner']['id'])
            deadline = time.monotonic()+45
            while api(owner_token, 'GET', route)[1]['empty']:
                require(time.monotonic() < deadline); time.sleep(0.2)
            for role, permission in (('writer', 'write'), ('reader', 'read')):
                api(owner_token, 'PUT', route+'/collaborators/'+actors[role]['name'], {'permission': permission}, 204)
            baseline = api(owner_token, 'GET', route+'/branches/main')[1]['commit']['id']; require(OID.fullmatch(baseline))
            manifest['repository'] = {'id': repo['id'], 'ownerId': repo['owner']['id'], 'fullName': repo['full_name'], 'initialHead': baseline}
            stage = 'activate_operator_hooks'
            spec['services']['gitea']['environment']['GITEA__git_0x2Econfig__core_0x2EhooksPath'] = '/opt/golf-hook-fixture'
            write_json(spec_path, spec)
            subprocess_run(*compose, 'up', '-d', '--no-deps', '--force-recreate', '--pull', 'never', 'gitea', timeout=90); ready()
            native_id = subprocess_run(*compose, 'ps', '-q', 'gitea')[1].strip()
            image = subprocess_run('docker', 'inspect', '--format', '{{.Image}}', native_id)[1].strip()
            label = subprocess_run('docker', 'inspect', '--format', '{{index .Config.Labels "com.docker.compose.project"}}', native_id)[1].strip()
            require(image == args.native_image and label == project)
            manifest['nativeContainerId'] = subprocess_run('docker', 'inspect', '--format', '{{.Id}}', native_id)[1].strip()
            require(subprocess_run(*compose, 'exec', '-T', 'gitea', 'sha256sum', '/opt/golf-hook-fixture/fixture')[1].split()[0] == args.hook_sha256)
            require(api(owner_token, 'GET', route)[1]['id'] == repo['id'])
            remote = base+'/'+repo['full_name']+'.git'; work = directory/'client'
            def git(*words, actor='writer', expected=0):
                return subprocess_run('git', *words, cwd=work if work.exists() else directory,
                                      env=git_env(actors[actor]), expected=expected)
            git('clone', '--quiet', remote, str(work))
            git('config', 'user.name', 'Golf owned hook fixture'); git('config', 'user.email', 'hook@example.invalid')
            git('config', 'commit.gpgsign', 'false'); git('checkout', '--quiet', '-b', 'allowed')
            (work/'fixture.txt').write_text('Owned qualification source\n'); git('add', '--', 'fixture.txt')
            git('commit', '--quiet', '-m', 'Owned hook qualification'); allowed = git('rev-parse', 'HEAD')[1].strip()
            stage = 'ordinary_writer_positive'
            git('push', '--quiet', 'origin', 'HEAD:refs/heads/allowed')
            require(api(owner_token, 'GET', route+'/branches/allowed')[1]['commit']['id'] == allowed)
            allowed_file = api(owner_token, 'GET', route+'/contents/fixture.txt?ref=allowed')[1]
            response = api(actors['writer']['token'], 'PUT', route+'/contents/fixture.txt',
                {'branch': 'allowed', 'sha': allowed_file['sha'], 'message': 'Owned native editor proof',
                 'content': base64.b64encode(b'Owned editor update\n').decode()}, 200)[1]
            require(api(owner_token, 'GET', route+'/branches/allowed')[1]['commit']['id'] == response['commit']['sha'])
            manifest['checks'].append('ordinary_writer_git_and_native_editor_positive')
            stage = 'ordinary_permission_denials'
            main_file = api(owner_token, 'GET', route+'/contents/README.md?ref=main')[1]
            mutation = {'branch': 'main', 'sha': main_file['sha'], 'message': 'Owned marker edit',
                        'content': base64.b64encode(b'Owned denied editor update\n').decode()}
            for role in ('reader', 'outsider'):
                api(actors[role]['token'], 'PUT', route+'/contents/README.md', mutation, (403, 404))
                require(git('push', '--quiet', 'origin', 'HEAD:refs/heads/permission-'+role, actor=role, expected=None)[0] != 0)
            git('ls-remote', 'origin', 'refs/heads/main', actor='reader')
            git('clone', '--quiet', '--no-checkout', remote, str(directory/'reader-client'), actor='reader')
            require(git('-C', str(directory/'reader-client'), 'rev-parse', 'HEAD', actor='reader')[1].strip() == baseline)
            require(git('ls-remote', 'origin', actor='outsider', expected=None)[0] != 0)
            manifest['checks'].append('ordinary_reader_and_outsider_permissions_preserved')
            stage = 'prepared_git_veto'
            previous = events(); git('checkout', '--quiet', '-B', 'denied', baseline)
            (work/'denied.txt').write_text('Owned prepared rejection\n'); git('add', '--', 'denied.txt')
            git('commit', '--quiet', '-m', 'Owned rejected update'); candidate = git('rev-parse', 'HEAD')[1].strip()
            require(git('push', '--quiet', 'origin', 'HEAD:refs/heads/main', expected=None)[0] != 0)
            rows = events(); require(marker_events(rows[len(previous):], baseline, candidate))
            require(api(owner_token, 'GET', route+'/branches/main')[1]['commit']['id'] == baseline)
            require(api(owner_token, 'GET', route+'/contents/README.md?ref=main')[1]['sha'] == main_file['sha'])
            manifest['checks'].append('exact_prepared_git_veto_unchanged_ref_and_file')
            stage = 'prepared_native_editor_veto'
            previous = rows; status, _ = api(owner_token, 'PUT', route+'/contents/README.md', mutation, expected=None)
            require(not 200 <= status < 300); rows = events(); require(marker_events(rows[len(previous):], baseline))
            require(api(owner_token, 'GET', route+'/branches/main')[1]['commit']['id'] == baseline)
            require(api(owner_token, 'GET', route+'/contents/README.md?ref=main')[1]['sha'] == main_file['sha'])
            manifest['nativeEditorVetoStatus'] = status
            manifest['checks'].append('exact_prepared_native_editor_veto_unchanged_ref_and_file')
            stage = 'native_proc_receive_bookkeeping'
            git('fetch', '--quiet', 'origin', 'allowed'); git('checkout', '--quiet', '-B', 'agit', 'FETCH_HEAD')
            (work/'agit.txt').write_text('Owned AGit source\n'); git('add', '--', 'agit.txt')
            git('commit', '--quiet', '-m', 'Owned native proc receive'); agit_head = git('rev-parse', 'HEAD')[1].strip()
            previous = rows; git('push', '--quiet', 'origin', 'HEAD:refs/for/allowed/hook-qualification')
            pulls = api(owner_token, 'GET', route+'/pulls?state=open&limit=10')[1]
            require(len(pulls) == 1 and pulls[0]['head']['sha'] == agit_head and pulls[0]['base']['ref'] == 'allowed')
            rows = events(); require(any(row['hook'] == 'proc-receive' and row['decision'] == 'delegate_exit'
                                        and row.get('delegateExit') == 0 for row in rows[len(previous):]))
            manifest['checks'].append('native_proc_receive_real_pull_bookkeeping')
            require(any(row['context'] == 'temporary_clone' for row in rows))
            for hook in HOOKS[:4]:
                require(any(row['hook'] == hook and row['decision'] == 'delegate_exit' and row.get('delegateExit') == 0 for row in rows))
            require(not any(row['context'] == 'unclassified' for row in rows))
            write_json(args.output/'hook-events.json', rows)
            manifest['referenceStatesObserved'] = sorted({row['state'] for row in rows if row['hook'] == 'reference-transaction'})
            manifest['abortedCallbackIsNotReleaseProof'] = True
            manifest['checks'].append('temporary_clone_observed_and_native_delegate_exits_verified')
            manifest['status'] = 'checks_passed_cleanup_pending'
        except Exception as error:
            failure = error
            manifest['status'] = 'failed'
            manifest['failure'] = {'stage': stage, 'type': type(error).__name__, 'lines': [frame.lineno for frame in traceback.extract_tb(error.__traceback__) if Path(frame.filename).name == Path(__file__).name][-8:]}
        finally:
            cleanup_errors = []
            if compose:
                if repository_created and owner_token:
                    try: api(owner_token, 'DELETE', 'repos/'+owner_name+'/native-hook', expected=204)
                    except Exception: cleanup_errors.append('supported_native_repository_cleanup')
                for name in reversed(users):
                    try: cli('delete', '--username', name, '--purge')
                    except Exception: cleanup_errors.append('supported_native_actor_cleanup')
                try: subprocess_run(*compose, 'down', '--volumes', '--remove-orphans', timeout=90)
                except Exception: cleanup_errors.append('compose_down')
            # Exact random reserve name only; it normally already exited --rm.
            try:
                if reserve_started:
                    reserve_ids = subprocess_run('docker', 'ps', '-aq', '--filter', 'name=^/'+reserve_name+'$')[1].split()
                    if reserve_ids:
                        require(len(reserve_ids) == 1)
                        reserve_id = reserve_ids[0]
                        require(subprocess_run('docker', 'inspect', '--format', '{{.Image}}', reserve_id)[1].strip() == args.native_image)
                        require(subprocess_run('docker', 'inspect', '--format', '{{index .Config.Labels "com.docker.compose.project"}}', reserve_id)[1].strip() == project)
                        subprocess_run('docker', 'rm', '-f', reserve_id)
            except Exception: cleanup_errors.append('owned_reserve_cleanup')
            try:
                residue = {kind: subprocess_run('docker', kind, 'ls', '-aq' if kind == 'container' else '-q', '--filter', 'label=com.docker.compose.project='+project)[1].split()
                           for kind in ('container', 'volume', 'network')}
                manifest['cleanup']['ownResourcesZero'] = not any(residue.values())
                manifest['cleanup']['residualCounts'] = {kind: len(rows) for kind, rows in residue.items()}
                if any(residue.values()): cleanup_errors.append('owned_resource_residue')
            except Exception: cleanup_errors.append('owned_resource_observation')
            if before is not None:
                try:
                    after = inventory(); write_json(args.output/'foreign-after.json', after)
                    comparison = foreign_diff(before, after); write_json(args.output/'foreign-comparison.json', comparison)
                    manifest['cleanup'].update(comparison)
                    if not comparison['foreignIdentityUnchanged']: cleanup_errors.append('foreign_identity_changed')
                except Exception: cleanup_errors.append('foreign_observation')
            manifest['cleanup']['errors'] = cleanup_errors
            if failure is None and not cleanup_errors:
                manifest['status'] = 'qualified_bounded_hook_composition'
            elif cleanup_errors:
                manifest['status'] = 'failed'
            write_json(args.output/'manifest.json', manifest)
    print(json.dumps({'status': manifest['status'], 'manifest': str(args.output/'manifest.json')}))
    if manifest['status'] != 'qualified_bounded_hook_composition': sys.exit(1)


if __name__ == '__main__':
    main()
