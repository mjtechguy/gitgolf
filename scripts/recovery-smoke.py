#!/usr/bin/env python3
"""Qualify encrypted offline recovery in two disposable canonical Compose stacks.

Requires Docker, age/age-keygen, Git/git-lfs, GnuPG and ssh-keyscan. Supply the
locally built Golf image with --image. Neither the normal Compose project nor
its credentials/ports are used. Native Gitea APIs/Git/admin create the fixture;
only Golf's database is queried directly for recovery evidence. OAuth coverage
is a pending PKCE verifier, not restoration of an actual provider OAuth grant.
All fixture containers, volumes, networks and private local files are removed.
This small fixture does not qualify large backups. The 1 MiB cap check explicitly
skips when the fixture payload does not exceed that minimum supported bound.
"""
import argparse
import base64
from contextlib import ExitStack
import hashlib
import io
import json
import os
from pathlib import Path
import re
import secrets
import shlex
import shutil
import socket
import subprocess
import sys
import tarfile
import tempfile
import urllib.error
import urllib.request
import uuid

sys.dont_write_bytecode = True
import smoke

ROOT = Path(__file__).resolve().parents[1]
STAGE = 'prerequisites'


def check(message):
    global STAGE
    STAGE = message
    print('CHECK: '+message, flush=True)


def run(*command, input=None, env=None, cwd=ROOT, success=True, binary=False, timeout=180):
    if isinstance(input, str):
        input = input.encode()
    result = subprocess.run(command, input=input, env=env, cwd=cwd,
                            capture_output=True, timeout=timeout)
    if (result.returncode == 0) != success:
        print('Native command failed: '+Path(command[0]).name+' exit='+str(result.returncode), file=sys.stderr)
    assert (result.returncode == 0) == success, 'Native command failed; output withheld'
    return result.stdout if binary else result.stdout.decode()


def private(path, data, mode=0o600):
    path.write_bytes(data if isinstance(data, bytes) else data.encode())
    path.chmod(mode)


def port():
    with socket.socket() as listener:
        listener.bind(('127.0.0.1', 0))
        return listener.getsockname()[1]


def resources(project):
    label = 'label=com.docker.compose.project='+project
    return {kind: run('docker', *arguments, '--filter', label).split()
            for kind, arguments in [('containers', ['ps', '-aq']),
                                    ('volumes', ['volume', 'ls', '-q']),
                                    ('networks', ['network', 'ls', '-q'])]}


def purge(project):
    rows = resources(project)
    for kind, command in [('containers', ['rm', '-f']), ('volumes', ['volume', 'rm']),
                          ('networks', ['network', 'rm'])]:
        if rows[kind]:
            run('docker', *command, *rows[kind])
    assert not any(resources(project).values()), 'Fixture resources remain'


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--image', required=True, help='Locally built Golf image tag or ID')
    args = parser.parse_args()
    for tool in ['docker', 'age', 'age-keygen', 'git', 'git-lfs', 'gpg', 'gpgconf', 'ssh-keyscan']:
        assert shutil.which(tool), 'Required native tool is unavailable'
    image = json.loads(run('docker', 'image', 'inspect', args.image))[0]['Id']
    for tag in ['postgres:18.4-alpine3.24', 'gitea/gitea:1.27.3-rootless']:
        run('docker', 'image', 'inspect', tag)
    prefix = 'golf-recovery-'+secrets.token_hex(5)
    source, target, rejected = [prefix+'-'+name for name in ['source', 'restore', 'reject']]
    projects = [source, target, rejected]
    for project in projects:
        assert not any(resources(project).values()), 'Fixture project already exists'
    original_urls = smoke.GOLF, smoke.GITEA
    ports = set()
    while len(ports) < 3:
        ports.add(port())
    golf_port, gitea_port, ssh_port = sorted(ports)
    smoke.GOLF, smoke.GITEA = 'http://127.0.0.1:'+str(golf_port), 'http://127.0.0.1:'+str(gitea_port)
    # Compose receives only explicit fixture values, never the operator's keys.
    env = {key: value for key, value in os.environ.items()
           if not key.startswith(('GOLF_', 'GITEA_', 'COMPOSE_', 'POSTGRES_')) and key != 'DATABASE_URL'}
    forbidden = []
    try:
        with tempfile.TemporaryDirectory(prefix=prefix+'-') as temporary, ExitStack() as cleanup:
            # macOS /var is a symlink; Compose's config-file label must match
            # the operator's canonical resolved path exactly.
            directory = Path(temporary).resolve(); directory.chmod(0o700)
            config_file, restore_dir = directory/'source.json', directory/'restored'
            active_config, active_project = config_file, source

            def compose(*arguments, **options):
                return run('docker', 'compose', '-p', active_project, '-f', str(active_config),
                           *arguments, env=env, **options)

            def container(service):
                result = compose('ps', '-aq', service).strip()
                assert result and '\n' not in result, 'Expected one canonical service container'
                return result

            def ready():
                try:
                    smoke.ready()
                except Exception:
                    # Report only lifecycle metadata, never container env/logs
                    # or a readiness response body that could contain secrets.
                    states = {}
                    for service in ['postgres', 'gitea', 'golf']:
                        state = json.loads(run('docker', 'inspect', container(service)))[0]['State']
                        states[service] = {'status': state['Status'], 'running': state['Running'],
                                           'exit_code': state['ExitCode'],
                                           'health': state.get('Health', {}).get('Status', 'not_configured')}
                    print('Readiness failure service states: '+json.dumps(states, sort_keys=True), file=sys.stderr)
                    try:
                        with urllib.request.urlopen(smoke.GOLF+'/readyz', timeout=2) as response:
                            status = response.status
                    except urllib.error.HTTPError as error:
                        status = error.code; error.close()
                    except OSError:
                        status = 'unreachable'
                    print('Readiness HTTP status: '+str(status), file=sys.stderr)
                    raise

            def admin(*arguments):
                return compose('exec', '-T', 'gitea', 'gitea', '--config', '/etc/gitea/app.ini',
                               'admin', 'user', *arguments).strip()

            def sql(statement):
                return compose('exec', '-T', 'postgres', 'psql', '-U', 'postgres', '-d', 'golf',
                               '-At', '-v', 'ON_ERROR_STOP=1', input=statement).strip()

            def rows(table, order='id'):
                # Only fixed Golf table names and ordering constants are passed.
                return sql('SELECT COALESCE(json_agg(t),\'[]\'::json) FROM '
                           '(SELECT * FROM '+table+' ORDER BY '+order+') t;')

            def operator(*arguments, state='complete'):
                output = compose('run', '--rm', '--no-deps', '-T', 'golf', 'keys', *arguments)
                assert not any(value in output for value in forbidden), 'Operator exposed a credential'
                result = json.loads(output)
                assert result['schema_version'] == 'golf.keys.v1' and result['state'] == state
                return result['result']

            def local_operator(action, payload, success=True):
                output = compose('run', '--rm', '--no-deps', '-T', 'golf', 'local-account', action,
                                 input=json.dumps(payload), success=success)
                assert not any(value in output for value in forbidden), 'Local account operator exposed a credential'
                result = json.loads(output)
                assert result['schema_version'] == 'golf.local-account.v1'
                assert result['state'] == ('complete' if success else 'failed')
                return result.get('result')

            def recovery(action, *arguments, success=True):
                process = subprocess.run([sys.executable, str(ROOT/'scripts/recovery.py'), action, *arguments],
                                         cwd=ROOT, env=env, capture_output=True, timeout=360)
                output = process.stdout.decode()
                assert not any(value in output for value in forbidden), 'Recovery exposed a credential'
                result = json.loads(output)
                assert result['schema_version'] == 'golf.backup.v1'
                expected_state = ('quarantined' if action == 'restore' else 'complete') if success else 'failed'
                if result['state'] != expected_state or (process.returncode == 0) != success:
                    location = result.get('check', '')
                    if isinstance(location, str) and re.fullmatch(r'[0-9 >]+', location):
                        print('Recovery '+action+' failed at '+location, file=sys.stderr)
                assert (process.returncode == 0) == success, 'Recovery exit status did not match'
                assert result['state'] == expected_state
                return result.get('result', {})

            def git(*arguments, cwd=None, success=True):
                return run('git', '-c', 'credential.helper=', *arguments,
                           cwd=cwd or work, env=git_env, success=success).strip()

            def ssh_keys():
                output = run('ssh-keyscan', '-T', '10', '-p', str(ssh_port), '127.0.0.1')
                values = sorted(' '.join(line.split()[1:]) for line in output.splitlines()
                                if line and not line.startswith('#'))
                assert len(values) >= 2, 'SSH identity is missing'
                return values

            passwords = [secrets.token_urlsafe(32) for _ in range(3)]
            legacy, next_key = [base64.b64encode(secrets.token_bytes(32)).decode() for _ in range(2)]
            oauth_secret = secrets.token_urlsafe(32)
            forbidden.extend(passwords+[legacy, next_key, oauth_secret])
            config = {'services': {
                'postgres': {'image': 'postgres:18.4-alpine3.24', 'pull_policy': 'never',
                    'environment': {'POSTGRES_PASSWORD': passwords[0], 'GOLF_DB_PASSWORD': passwords[1],
                                    'GITEA_DB_PASSWORD': passwords[2]},
                    'volumes': ['postgres-data:/var/lib/postgresql',
                                str(ROOT/'deploy/postgres/init.sh')+':/docker-entrypoint-initdb.d/01-golf.sh:ro'],
                    'healthcheck': {'test': ['CMD-SHELL', 'pg_isready -h 127.0.0.1 -U postgres'], 'interval': '2s',
                                    'timeout': '3s', 'retries': 60}},
                'gitea': {'image': 'gitea/gitea:1.27.3-rootless', 'pull_policy': 'never',
                    'environment': {'GITEA__database__DB_TYPE': 'postgres', 'GITEA__database__HOST': 'postgres:5432',
                        'GITEA__database__NAME': 'gitea', 'GITEA__database__USER': 'gitea',
                        'GITEA__database__PASSWD': passwords[2], 'GITEA__server__ROOT_URL': smoke.GITEA+'/',
                        'GITEA__server__SSH_DOMAIN': '127.0.0.1', 'GITEA__server__SSH_PORT': str(ssh_port),
                        'GITEA__server__SSH_LISTEN_PORT': '2222', 'GITEA__server__LFS_START_SERVER': 'true',
                        'GITEA__security__INSTALL_LOCK': 'true', 'GITEA__service__DISABLE_REGISTRATION': 'true',
                        'GITEA__actions__ENABLED': 'false'},
                    'ports': [f'127.0.0.1:{gitea_port}:3000', f'127.0.0.1:{ssh_port}:2222'],
                    'volumes': ['gitea-data:/var/lib/gitea', 'gitea-config:/etc/gitea'],
                    'depends_on': {'postgres': {'condition': 'service_healthy'}}},
                'golf': {'image': image, 'pull_policy': 'never', 'environment': {
                        'GOLF_LISTEN_ADDR': ':8080', 'GOLF_PUBLIC_URL': smoke.GOLF,
                        'GOLF_ALLOW_INSECURE_COOKIES': 'true', 'GOLF_WEB_DIR': '/app/web/dist',
                        'GOLF_ENCRYPTION_KEY': legacy,
                        # Compose must unescape this to a literal dollar, then
                        # backup/restore must preserve that effective value.
                        'GOLF_RECOVERY_FIXTURE_MARKER': 'literal-$$recovery-marker',
                        'DATABASE_URL': f'postgres://golf:{passwords[1]}@postgres:5432/golf?sslmode=disable',
                        'GITEA_URL': 'http://gitea:3000', 'GITEA_PUBLIC_URL': smoke.GITEA,
                        'GITEA_OAUTH_CLIENT_ID': prefix, 'GITEA_OAUTH_CLIENT_SECRET': oauth_secret},
                    'ports': [f'127.0.0.1:{golf_port}:8080'],
                    'depends_on': {'postgres': {'condition': 'service_healthy'}, 'gitea': {'condition': 'service_started'}}}},
                'volumes': {name: {} for name in ['postgres-data', 'gitea-data', 'gitea-config']}}
            private(config_file, json.dumps(config))
            identity, wrong_identity = directory/'identity.agekey', directory/'wrong.agekey'
            for path in [identity, wrong_identity]:
                run('age-keygen', '-o', str(path)); path.chmod(0o600)
            recipient = run('age-keygen', '-y', str(identity)).strip()
            check('start isolated canonical source and create native identities')
            compose('up', '-d', '--wait', '--wait-timeout', '120', timeout=180)
            ready()
            users = [prefix+'-'+label for label in ['owner', 'outsider']]
            tokens, sessions = [], []
            for username in users:
                admin('create', '--username', username, '--email', username+'@example.invalid',
                      '--random-password', '--must-change-password=false')
                token = admin('generate-access-token', '--username', username, '--token-name', 'recovery-fixture',
                              '--scopes', 'write:user,write:repository,write:issue', '--raw')
                forbidden.append(token); tokens.append(token)
                session = smoke.client(); sessions.append(session)
                smoke.rpc(session, 'SessionService/LoginWithGiteaToken', {'token': token})
            owner, outsider = sessions
            def bearer_rpc(token, procedure, payload=None, expected=200):
                return smoke.rpc(smoke.client(), procedure, payload, expected=expected,
                                 headers={'Authorization': 'Bearer ' + token})
            api_issued = [smoke.rpc(owner, 'ApiCredentialService/CreateApiCredential',
                                    {'label': 'recovery delegation ' + str(index), 'lifetime_seconds': 43200})
                          for index in range(2)]
            forbidden.extend(issued['token'] for issued in api_issued)
            assert all('token' in issued and issued['credential']['sourceSessionActive'] for issued in api_issued)
            for issued in api_issued:
                assert bearer_rpc(issued['token'], 'SessionService/GetSession')['user'] == smoke.rpc(owner, 'SessionService/GetSession')['user']
            revoked_api = smoke.rpc(owner, 'ApiCredentialService/RevokeApiCredential',
                                    {'credential_id': api_issued[0]['credential']['id']})
            assert revoked_api['credential']['revokedAt']
            bearer_rpc(api_issued[0]['token'], 'SessionService/GetSession', expected=401)
            owner_token, outsider_token = tokens
            check('independent local passwords and a disabled account before capture')
            local_names = ['recovery-local-'+secrets.token_hex(5) for _ in range(2)]
            local_passwords = ['Recovery Golf password '+secrets.token_urlsafe(24) for _ in local_names]
            forbidden.extend(local_passwords)
            for index in range(2):
                local_operator('create', {'username': local_names[index], 'email': local_names[index]+'@example.invalid', 'password': local_passwords[index],
                    'forge_token': tokens[index], 'is_instance_admin': index == 0})
            local_session = smoke.client(); sessions.append(local_session)
            local_user = smoke.rpc(local_session, 'SessionService/LoginWithPassword',
                {'username': local_names[0], 'password': local_passwords[0]})['user']
            assert local_user['isInstanceAdmin']
            local_operator('disable', {'username': local_names[1]})
            extra = smoke.client(); sessions.append(extra)
            smoke.rpc(extra, 'SessionService/LoginWithGiteaToken', {'token': owner_token})
            owner_identity = smoke.rpc(owner, 'SessionService/GetSession')['user']
            smoke.rpc(smoke.client(), 'SessionService/BeginGiteaOAuth')
            assert sql('SELECT count(*) FROM golf_oauth_attempts;') == '1'
            creation_request = {'name': 'recovery-private', 'private': True, 'idempotency_key': str(uuid.uuid4())}
            created = smoke.rpc(owner, 'RepositoryService/CreateRepository', creation_request)
            repository, creation = created['repository'], created['creation']
            assert creation['state'] == 'REPOSITORY_CREATION_STATE_SUCCEEDED'
            full_name = repository['fullName']; key = {'owner': users[0], 'name': repository['name']}
            route = 'repos/'+full_name
            remote = smoke.GITEA+'/'+full_name+'.git'
            issue_request = {'repository': key, 'repository_id': repository['id'],
                             'title': 'Recovered issue discussion', 'body': 'Original plain-text issue body.',
                             'idempotency_key': str(uuid.uuid4())}
            issue_created = smoke.rpc(owner, 'RepositoryService/CreateIssue', issue_request)
            assert issue_created['mutation']['state'] == 'ISSUE_MUTATION_STATE_SUCCEEDED'
            discussion = issue_created['issue']
            comment_request = {'repository': key, 'repository_id': repository['id'],
                               'number': discussion['number'], 'issue_id': discussion['id'],
                               'body': 'Original plain-text discussion comment.', 'idempotency_key': str(uuid.uuid4())}
            comment_created = smoke.rpc(owner, 'RepositoryService/CreateIssueComment', comment_request)
            assert comment_created['mutation']['state'] == 'ISSUE_MUTATION_STATE_SUCCEEDED'
            rejected_request = {**issue_request, 'repository_id': str(int(repository['id']) + 1),
                                'idempotency_key': str(uuid.uuid4())}
            issue_rejected = smoke.rpc(owner, 'RepositoryService/CreateIssue', rejected_request)
            assert issue_rejected['mutation']['state'] == 'ISSUE_MUTATION_STATE_REJECTED'
            assert issue_rejected['mutation']['failureCode'] == 'target_changed'
            issue_operations = [('CreateIssue', issue_request, issue_created),
                                ('CreateIssueComment', comment_request, comment_created),
                                ('CreateIssue', rejected_request, issue_rejected)]
            print('PASS: durable issue/comment observations and no-dispatch target mismatch', flush=True)

            check('native signed Git objects, LFS bytes, release attachment and protection')
            work = directory/'work'; work.mkdir()
            askpass = directory/'askpass'
            private(askpass, '#!/bin/sh\ncase "$1" in *Username*) printf "%s\\n" "$GOLF_CHECK_USER";; '
                    '*) printf "%s\\n" "$GOLF_CHECK_TOKEN";; esac\n', 0o700)
            # A macOS /private/var/folders path can exceed the gpg-agent Unix
            # socket limit. Only the public verification key is imported here.
            public_home = Path(cleanup.enter_context(tempfile.TemporaryDirectory(prefix='golf-gpg-', dir='/tmp')))
            public_home.chmod(0o700)
            cleanup.callback(run, 'gpgconf', '--homedir', str(public_home), '--kill', 'all', env=env)
            signer = directory/'gpg-sign'

            def signing_wrapper():
                private(signer, '#!/bin/sh\nexec docker exec -i '+shlex.quote(container('gitea'))+
                        ' gpg --batch --pinentry-mode loopback --passphrase "" "$@"\n', 0o700)

            signing_wrapper()
            git_env = dict(env, GIT_ASKPASS=str(askpass), GIT_TERMINAL_PROMPT='0',
                           GOLF_CHECK_USER=users[0], GOLF_CHECK_TOKEN=owner_token,
                           GIT_CONFIG_NOSYSTEM='1', GIT_CONFIG_GLOBAL=os.devnull, GNUPGHOME=str(public_home))
            compose('exec', '-T', 'gitea', 'gpg', '--batch', '--pinentry-mode', 'loopback', '--passphrase', '',
                    '--quick-generate-key', 'Golf Recovery <recovery@example.invalid>', 'ed25519', 'sign', '0')
            secret_listing = compose('exec', '-T', 'gitea', 'gpg', '--with-colons', '--list-secret-keys')
            fingerprint = next(line.split(':')[9] for line in secret_listing.splitlines() if line.startswith('fpr:'))
            public_key = compose('exec', '-T', 'gitea', 'gpg', '--armor', '--export', fingerprint)
            run('gpg', '--batch', '--import', input=public_key, env=git_env)
            git('init', '-b', 'main')
            for name, value in [('user.name', 'Golf Recovery'), ('user.email', 'recovery@example.invalid'),
                                ('user.signingkey', fingerprint), ('gpg.program', str(signer)), ('commit.gpgsign', 'true')]:
                git('config', name, value)
            git('lfs', 'install', '--local')
            git('lfs', 'track', '*.lfs')
            payload = secrets.token_bytes(128 << 10)
            payload_hash = hashlib.sha256(payload).hexdigest()
            (work/'payload.lfs').write_bytes(payload)
            (work/'README.md').write_text('# Disposable recovery fixture\n')
            git('add', '.')
            git('commit', '-m', 'Preserve signed Git and LFS')
            commit_id = git('rev-parse', 'HEAD')
            git('tag', '-s', 'fixture-v1', '-m', 'Signed recovery fixture')
            git('branch', 'recovery-side')
            git('push', remote, '--all'); git('push', remote, '--tags')
            smoke.wait_for_push(owner_token, full_name)
            refs = git('ls-remote', '--heads', '--tags', remote)
            release = smoke.provider(owner_token, 'POST', route+'/releases',
                                     {'tag_name': 'fixture-v1', 'name': 'Recovery fixture'}, expected=201)
            attachment_bytes = b'Golf attachment recovery\n'+secrets.token_bytes(4096)
            upload = urllib.request.Request(smoke.GITEA+'/api/v1/'+route+'/releases/'+str(release['id'])+
                '/assets?name=recovery.bin', data=attachment_bytes, method='POST',
                headers={'Authorization': 'token '+owner_token, 'Content-Type': 'application/octet-stream'})
            with urllib.request.urlopen(upload, timeout=20) as response:
                assert response.status == 201
                attachment = json.load(response)
            protection = smoke.provider(owner_token, 'POST', route+'/branch_protections',
                {'rule_name': 'main', 'enable_push': True, 'enable_force_push': False}, expected=201)
            host_keys = ssh_keys()
            check('drained key activation and partial re-encryption before backup')
            compose('stop', 'golf')
            config['services']['golf']['environment'].update(
                GOLF_ENCRYPTION_KEYS=json.dumps({'legacy': legacy, 'next': next_key}),
                GOLF_ACTIVE_ENCRYPTION_KEY='next')
            private(config_file, json.dumps(config))
            assert operator('activate')['status']['active_key_id'] == 'next'
            partial = operator('rotate', '--batch-size', '1', '--max-batches', '1', state='partial')
            assert partial['rotated_sessions'] == 1
            compose('up', '-d', 'golf'); ready()
            new = smoke.client(); sessions.append(new)
            smoke.rpc(new, 'SessionService/LoginWithGiteaToken', {'token': owner_token})
            assert sql("SELECT count(DISTINCT credential_key_id) FROM golf_sessions;") == '2'
            assert sql("SELECT credential_key_id FROM golf_oauth_attempts;") == 'legacy'
            local_usage = operator('status')['keys']
            assert sum(row.get('local_accounts', 0) for row in local_usage) == 2
            for session in sessions:
                smoke.rpc(session, 'SessionService/GetSession')
            history = {table: rows(table, order) for table, order in [
                ('golf_users', 'id'), ('golf_audit_events', 'id'), ('golf_crypto_events', 'id'),
                ('golf_encryption_keys', 'key_id'), ('golf_encryption_policy', 'singleton'),
                ('golf_repository_creations', 'id'), ('golf_repository_creation_events', 'id'),
                ('golf_api_credentials', 'id'), ('golf_api_credential_events', 'id'),
                ('golf_issue_mutations', 'id'), ('golf_issue_mutation_events', 'id')]}
            local_accounts = json.loads(rows('golf_local_accounts'))
            local_events = json.loads(rows('golf_local_account_events'))
            assert len(local_accounts) == 2 and sum(row['disabled_at'] is not None for row in local_accounts) == 1
            counts = int(sql('SELECT count(*) FROM golf_sessions;')), int(sql('SELECT count(*) FROM golf_oauth_attempts;'))
            assert counts == (5, 1)
            check('live writers cannot be bypassed by the operator drain assertion')
            for service in ['golf', 'gitea']:
                assert json.loads(run('docker', 'inspect', container(service)))[0]['State']['Running']
            running_output = directory/'reject-running.age'
            recovery('backup', '--project', source, '--compose-file', str(config_file), '--recipient', recipient,
                     '--output', str(running_output), '--writers-drained', success=False)
            assert not running_output.exists()
            for service in ['golf', 'gitea']:
                assert json.loads(run('docker', 'inspect', container(service)))[0]['State']['Running']
            # GnuPG agent sockets are runtime state, not backup payloads.
            compose('exec', '-T', 'gitea', 'gpgconf', '--kill', 'all')
            compose('stop', 'golf', 'gitea')
            backup_file = directory/'backup.age'
            backup_args = ['--project', source, '--compose-file', str(config_file), '--recipient', recipient,
                           '--output', str(backup_file), '--writers-drained']
            check('encrypted backup and manifest integrity before any target mutation')
            archived = recovery('backup', *backup_args)
            backup_id = archived['backup_id']
            verify_args = ['--input', str(backup_file), '--identity', str(identity)]
            assert recovery('verify', *verify_args)['backup_id'] == backup_id
            encrypted = backup_file.read_bytes()
            assert not any(value.encode() in encrypted for value in forbidden)
            encrypted_hash = hashlib.sha256(encrypted).hexdigest()
            assert archived['encrypted_sha256'] == encrypted_hash
            recovery('backup', *backup_args, success=False)
            assert hashlib.sha256(backup_file.read_bytes()).hexdigest() == encrypted_hash
            print('PASS: detected live writers rejected and existing encrypted backup preserved', flush=True)
            if archived['plaintext_bytes'] > 1 << 20:
                recovery('verify', *verify_args, '--max-bytes', str(1 << 20), success=False)
                assert not any(resources(rejected).values())
                print('PASS: plaintext size cap rejected this larger fixture archive', flush=True)
            else:
                print('SKIP: fixture payload does not exceed the minimum 1 MiB plaintext cap', flush=True)
            bundle = run('age', '-d', '-i', str(identity), str(backup_file), binary=True)
            with tarfile.open(fileobj=io.BytesIO(bundle), mode='r:') as archive:
                files = {member.name: archive.extractfile(member).read() for member in archive}
            manifest = json.loads(files['manifest.json'])
            assert manifest['backup_id'] == backup_id and manifest['source_project'] == source
            assert manifest['images']['golf'] == image
            for name, evidence in manifest['files'].items():
                assert evidence == {'bytes': len(files[name]), 'sha256': hashlib.sha256(files[name]).hexdigest()}
            archived_config = json.loads(files['compose.json'])
            assert archived_config['services']['golf']['environment']['GOLF_ENCRYPTION_KEYS'] == config['services']['golf']['environment']['GOLF_ENCRYPTION_KEYS']
            def marker_value():
                values = json.loads(run('docker', 'inspect', container('golf')))[0]['Config']['Env']
                return next(value.split('=', 1)[1] for value in values if value.startswith('GOLF_RECOVERY_FIXTURE_MARKER='))

            assert marker_value() == 'literal-$recovery-marker'
            # Re-encrypt a structurally valid tar with one changed payload and its
            # original manifest: age passes but the inner checksum must fail.
            damaged = bytearray(files['golf.dump']); damaged[len(damaged)//2] ^= 1
            files['golf.dump'] = bytes(damaged)
            stream = io.BytesIO()
            with tarfile.open(fileobj=stream, mode='w:') as archive:
                for name, data in files.items():
                    member = tarfile.TarInfo(name); member.size = len(data); member.mode = 0o600
                    archive.addfile(member, io.BytesIO(data))
            checksum_file = directory/'checksum.age'
            private(checksum_file, run('age', '-r', recipient, input=stream.getvalue(), binary=True))
            truncated = directory/'truncated.age'; private(truncated, encrypted[:-32])
            for bad_file, bad_identity in [(backup_file, wrong_identity), (truncated, identity), (checksum_file, identity)]:
                recovery('verify', '--input', str(bad_file), '--identity', str(bad_identity), success=False)
                rejected_dir = directory/'rejected'
                recovery('restore', '--input', str(bad_file), '--identity', str(bad_identity), '--project', rejected,
                         '--directory', str(rejected_dir), '--writers-drained', success=False)
                assert not rejected_dir.exists() and not any(resources(rejected).values())
            recovery('restore', *verify_args, '--project', source, '--directory', str(directory/'existing-project'),
                     '--writers-drained', success=False)
            assert not (directory/'existing-project').exists()
            nonempty = directory/'nonempty'; nonempty.mkdir(); (nonempty/'keep').write_text('preserve')
            recovery('restore', *verify_args, '--project', rejected, '--directory', str(nonempty),
                     '--writers-drained', success=False)
            assert (nonempty/'keep').read_text() == 'preserve' and not any(resources(rejected).values())
            print('PASS: authenticated encryption, manifest checksums and pre-mutation restore rejection', flush=True)
            check('fresh restore remains quarantined and invalidates restored credentials atomically')
            restored = recovery('restore', *verify_args, '--project', target, '--directory', str(restore_dir), '--writers-drained')
            assert restored['backup_id'] == backup_id
            assert (restored['sessions_count'], restored['oauth_attempts_count']) == counts
            assert restored['local_accounts_disabled_count'] == 2
            active_config, active_project = Path(restored['compose_file']), target
            assert active_config == restore_dir/'compose.json'
            assert marker_value() == 'literal-$recovery-marker'
            for service in ['golf', 'gitea']:
                assert not json.loads(run('docker', 'inspect', container(service)))[0]['State']['Running']
            assert sql('SELECT count(*) FROM golf_sessions;') == '0'
            assert sql('SELECT count(*) FROM golf_oauth_attempts;') == '0'
            for table, order in [('golf_users', 'id'), ('golf_audit_events', 'id'), ('golf_crypto_events', 'id'),
                                 ('golf_encryption_keys', 'key_id'), ('golf_encryption_policy', 'singleton'),
                ('golf_repository_creations', 'id'), ('golf_repository_creation_events', 'id'),
                ('golf_api_credentials', 'id'), ('golf_api_credential_events', 'id'),
                ('golf_issue_mutations', 'id'), ('golf_issue_mutation_events', 'id')]:
                assert rows(table, order) == history[table], 'Restored Golf history or key metadata differs'
            recovery_events = json.loads(rows('golf_recovery_events'))
            assert len(recovery_events) == 1
            event = recovery_events[0]
            assert event['backup_id'] == backup_id and event['actor'] == 'golf'
            assert (event['sessions_count'], event['oauth_attempts_count']) == counts
            assert event['local_accounts_disabled_count'] == 2
            restored_accounts = json.loads(rows('golf_local_accounts'))
            assert len(restored_accounts) == len(local_accounts)
            for previous, actual in zip(local_accounts, restored_accounts):
                assert actual['disabled_at'] is not None
                assert actual['credential_version'] == previous['credential_version'] + 1
                assert {key: value for key, value in actual.items() if key not in ('disabled_at', 'credential_version')} == {
                    key: value for key, value in previous.items() if key not in ('disabled_at', 'credential_version')}
            restored_local_events = json.loads(rows('golf_local_account_events'))
            assert restored_local_events[:len(local_events)] == local_events
            local_recovery_events = restored_local_events[len(local_events):]
            assert len(local_recovery_events) == 2 and all(row['action'] == 'RECOVERY_DISABLED' for row in local_recovery_events)
            assert {row['operation_id'] for row in local_recovery_events} == {event['operation_id']}
            assert operator('status')['active_key_id'] == 'next'
            assert sum(row.get('local_accounts', 0) for row in operator('status')['keys']) == 2
            print('PASS: quarantine, exact invalidation ledger, preserved identity/audit/crypto history and key registry', flush=True)
            check('reopen only the disposable target and verify private restored data')
            compose('start', 'gitea', 'golf'); ready()
            for session in sessions:
                smoke.rpc(session, 'SessionService/GetSession', expected=401)
            for index in range(2):
                smoke.rpc(smoke.client(), 'SessionService/LoginWithPassword',
                    {'username': local_names[index], 'password': local_passwords[index]}, expected=401)
            owner, outsider = smoke.client(), smoke.client()
            assert smoke.rpc(owner, 'SessionService/LoginWithGiteaToken', {'token': owner_token})['user'] == owner_identity
            smoke.rpc(outsider, 'SessionService/LoginWithGiteaToken', {'token': outsider_token})
            assert sql("SELECT count(*) FROM golf_sessions WHERE credential_key_id='next';") == '2'
            for issued in api_issued:
                bearer_rpc(issued['token'], 'SessionService/GetSession', expected=401)
            retained = smoke.rpc(owner, 'ApiCredentialService/ListApiCredentials')['credentials']
            assert {item['id'] for item in retained} == {issued['credential']['id'] for issued in api_issued}
            assert all(not item.get('sourceSessionActive', False) for item in retained)
            fresh_api = smoke.rpc(owner, 'ApiCredentialService/CreateApiCredential',
                                  {'label': 'fresh post-recovery delegation'})
            forbidden.append(fresh_api['token'])
            assert bearer_rpc(fresh_api['token'], 'SessionService/GetSession')['user'] == owner_identity
            for issued in api_issued:
                bearer_rpc(issued['token'], 'SessionService/GetSession', expected=401)
            print('PASS: restored API credential metadata/events retained; old delegation stays denied after fresh sign-in', flush=True)
            check('restored local accounts require explicit current-authority re-enablement')
            restored_password = 'Reconciled Golf password '+secrets.token_urlsafe(24)
            forbidden.append(restored_password)
            local_operator('reset-password', {'username': local_names[0], 'password': restored_password})
            smoke.rpc(smoke.client(), 'SessionService/LoginWithPassword',
                {'username': local_names[0], 'password': restored_password}, expected=401)
            local_operator('enable', {'username': local_names[0], 'password': restored_password,
                'forge_token': outsider_token}, success=False)
            smoke.rpc(smoke.client(), 'SessionService/LoginWithPassword',
                {'username': local_names[0], 'password': restored_password}, expected=401)
            local_operator('enable', {'username': local_names[0], 'password': restored_password,
                'forge_token': owner_token})
            fresh_local = smoke.client()
            assert smoke.rpc(fresh_local, 'SessionService/LoginWithPassword',
                {'username': local_names[0], 'password': restored_password})['user'] == local_user
            assert smoke.rpc(fresh_local, 'RepositoryService/GetRepository', {'repository': key})['repository']['id'] == repository['id']
            smoke.rpc(fresh_local, 'SessionService/Logout')
            print('PASS: all restored local accounts disabled/version-fenced; password-only reset cannot enable, fresh immutable mapping required', flush=True)
            assert smoke.rpc(owner, 'RepositoryService/GetRepository', {'repository': key})['repository']['id'] == repository['id']
            lookup = {'idempotency_key': creation_request['idempotency_key']}
            observed = smoke.rpc(owner, 'RepositoryService/GetRepositoryCreation', lookup)
            assert observed['creation'] == creation and observed['repository']['id'] == repository['id']
            replay = smoke.rpc(owner, 'RepositoryService/CreateRepository', creation_request)
            assert replay['creation'] == creation and replay['repository']['id'] == repository['id']
            smoke.rpc(outsider, 'RepositoryService/GetRepositoryCreation', lookup, expected=404)
            for table in ['golf_repository_creations', 'golf_repository_creation_events']:
                assert rows(table, 'id') == history[table]
            print('PASS: restored creation journal, scoped lookup and same-key replay preserve original evidence', flush=True)
            for procedure, request, recorded in issue_operations:
                mutation_lookup = {'idempotency_key': request['idempotency_key']}
                observed = smoke.rpc(owner, 'RepositoryService/GetIssueMutation', mutation_lookup)
                assert observed['mutation'] == recorded['mutation']
                replay = smoke.rpc(owner, 'RepositoryService/' + procedure, request)
                assert replay['mutation'] == recorded['mutation']
                if 'issue' in recorded:
                    assert observed['issue']['id'] == replay['issue']['id'] == recorded['issue']['id']
                if 'comment' in recorded:
                    assert observed['comment']['id'] == replay['comment']['id'] == recorded['comment']['id']
                smoke.rpc(outsider, 'RepositoryService/GetIssueMutation', mutation_lookup, expected=404)
                assert bearer_rpc(fresh_api['token'], 'RepositoryService/GetIssueMutation', mutation_lookup)['mutation'] == recorded['mutation']
            for table in ['golf_issue_mutations', 'golf_issue_mutation_events']:
                assert rows(table, 'id') == history[table]
            native_comments = smoke.provider(owner_token, 'GET', route+'/issues/'+str(discussion['number'])+'/comments')
            assert [item['id'] for item in native_comments] == [int(comment_created['comment']['id'])]
            print('PASS: restored issue/comment journal and original native objects; keyed replay never reposts', flush=True)

            smoke.rpc(outsider, 'RepositoryService/GetRepository', {'repository': key}, expected=404)
            smoke.provider(outsider_token, 'GET', route, expected=404)
            assert git('ls-remote', '--heads', '--tags', remote) == refs
            clone = directory/'clone'
            git('clone', remote, str(clone), cwd=directory)
            git('fsck', '--full', cwd=clone)
            git('verify-commit', commit_id, cwd=clone); git('verify-tag', 'fixture-v1', cwd=clone)
            # Global Git configuration is deliberately disabled. A fresh native
            # consumer must install its local filters and fetch LFS objects.
            git('lfs', 'install', '--local', cwd=clone)
            git('lfs', 'pull', cwd=clone)
            git('lfs', 'fsck', cwd=clone)
            assert hashlib.sha256((clone/'payload.lfs').read_bytes()).hexdigest() == payload_hash
            with urllib.request.urlopen(urllib.request.Request(attachment['browser_download_url'],
                    headers={'Authorization': 'token '+owner_token}), timeout=20) as response:
                assert response.read() == attachment_bytes
            assert smoke.provider(owner_token, 'GET', route+'/branch_protections/main') == protection
            assert ssh_keys() == host_keys
            assert compose('exec', '-T', 'gitea', 'gpg', '--armor', '--export', fingerprint) == public_key
            signing_wrapper()
            (work/'after-restore.txt').write_text('A new signed write after recovery.\n')
            git('add', '.'); git('commit', '-m', 'Write after restore')
            next_commit = git('rev-parse', 'HEAD')
            git('push', remote, 'main')
            git('push', '--force', remote, commit_id+':refs/heads/main', success=False)
            assert git('ls-remote', remote, 'refs/heads/main').split()[0] == next_commit
            git('-c', 'gpg.program=gpg', 'verify-commit', next_commit)
            print('PASS: private Git refs/signatures, LFS bytes, attachments, protection, SSH and signing identity', flush=True)
            check('post-restore signed write and ordinary restart persistence')
            compose('restart', timeout=180); ready()
            assert smoke.rpc(owner, 'SessionService/GetSession')['user'] == owner_identity
            assert bearer_rpc(fresh_api['token'], 'SessionService/GetSession')['user'] == owner_identity
            for issued in api_issued:
                bearer_rpc(issued['token'], 'SessionService/GetSession', expected=401)
            assert git('ls-remote', remote, 'refs/heads/main').split()[0] == next_commit
            git('fetch', '--all', cwd=clone); git('fsck', '--full', cwd=clone)
            git('verify-commit', next_commit, cwd=clone)
            assert sql('SELECT count(*) FROM golf_recovery_events;') == '1'
            assert ssh_keys() == host_keys
            for row in json.loads(run('docker', 'inspect', *resources(source)['containers'])):
                if row['Config']['Labels']['com.docker.compose.service'] in {'golf', 'gitea'}:
                    assert not row['State']['Running'], 'Source writer was reopened'
            print('PASS: fresh-session key use, post-restore signed push, force-push denial and restart persistence', flush=True)
    finally:
        smoke.GOLF, smoke.GITEA = original_urls
        failures = []
        for project in reversed(projects):
            try:
                purge(project)
            except Exception:
                failures.append(project)
        assert not failures, 'Fixture cleanup incomplete; inspect only golf-recovery project labels'
    print('PASS: disposable recovery projects, volumes, networks and private files removed', flush=True)


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        # Native stderr, tokens and decrypted archives are never diagnostics.
        trace, frames = error.__traceback__, []
        while trace:
            frames.append(Path(trace.tb_frame.f_code.co_filename).name+':'+str(trace.tb_lineno))
            trace = trace.tb_next
        location = ' > '.join(frames)
        print('FAIL: '+STAGE+' ('+type(error).__name__+' at '+location+'; diagnostic output withheld)', file=sys.stderr)
        raise SystemExit(1)
