#!/usr/bin/env python3
"""Qualify encrypted offline recovery in disposable native Compose/RustFS stacks.

Requires Docker, age/age-keygen, Git/git-lfs, GnuPG and ssh-keyscan. Supply the
locally built Golf image with --image. Neither the normal Compose project nor
its credentials/ports are used. Native Forgejo APIs/Git/admin create the fixture;
only Golf's database is queried/seeded directly for recovery evidence. Two actual
native pushes admit automatic runs; HTTP leases exercise control-plane authority,
without executing Docker jobs. Explicit pending/preparing metadata fixtures cover
interrupted materialization quarantine. OAuth coverage
is a pending PKCE verifier, not restoration of an actual provider OAuth grant.
All fixture containers, volumes, networks and private local files are removed.
This small fixture does not qualify large backups. The 1 MiB cap check explicitly
skips when the fixture payload does not exceed that minimum supported bound.
"""
import argparse
import base64
from contextlib import ExitStack
from datetime import datetime, timedelta, timezone
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
import time
import urllib.error
import urllib.request
import uuid

sys.dont_write_bytecode = True
import recovery as recovery_tool
import smoke

ROOT = Path(__file__).resolve().parents[1]
STAGE = 'prerequisites'
FORGEJO_IMAGE = 'codeberg.org/forgejo/forgejo:15.0.9-rootless@sha256:caf1bca332f95cdcf124227a4bfa3b49bbbfbbc8a5e4a97406921cb581165413'
JOB_IMAGE = 'alpine:3.23@sha256:85fe1e81d6758c208f3e1eed4338a1997e19d4be002d4dd32d3100c9a8c010a0'
# Fixed Golf metadata only. Mutable grant/run/account state is compared separately.
HISTORY_TABLES = [
    ('golf_users', 'id'), ('golf_audit_events', 'id'), ('golf_crypto_events', 'id'),
    ('golf_encryption_keys', 'key_id'), ('golf_encryption_policy', 'singleton'),
    ('golf_repository_creations', 'id'), ('golf_repository_creation_events', 'id'),
    ('golf_api_credentials', 'id'), ('golf_api_credential_events', 'id'),
    ('golf_issue_mutations', 'id'), ('golf_issue_mutation_events', 'id'),
    ('golf_execution_policies', 'scope,scope_id'), ('golf_execution_policy_repositories', 'scope,scope_id,repository_id'),
    ('golf_execution_policy_workflows', 'scope,scope_id,workflow_path'), ('golf_execution_policy_events', 'id'),
    ('golf_organization_creation_policies', 'forge_url'), ('golf_organization_creation_selections', 'user_id'),
    ('golf_organization_creation_policy_events', 'id'),
    ('golf_infrastructure_connections', 'id'), ('golf_infrastructure_connection_versions', 'profile_id,version'),
    ('golf_infrastructure_activation_events', 'revision'), ('golf_active_object_connection', 'singleton'),
    ('golf_repository_event_connections', 'id'), ('golf_repository_events', 'id'),
    ('golf_repository_event_payloads', 'connection_id,payload_sha256'),
    ('golf_automation_credentials', 'grant_id'), ('golf_workflow_run_logs', 'run_id,sequence'),
]


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
    print('Golf image: '+image, flush=True)
    for tag in ['postgres:18.4-alpine3.24', FORGEJO_IMAGE]:
        run('docker', 'image', 'inspect', tag)
    prefix = 'golf-recovery-'+secrets.token_hex(5)
    source, target, rejected, schema_rejected = [prefix+'-'+name for name in ['source', 'restore', 'reject', 'schema']]
    projects = [source, target, rejected, schema_rejected]
    for project in projects:
        assert not any(resources(project).values()), 'Fixture project already exists'
    original_urls = smoke.GOLF, smoke.FORGE
    ports = set()
    while len(ports) < 3:
        ports.add(port())
    golf_port, forge_port, ssh_port = sorted(ports)
    smoke.GOLF, smoke.FORGE = 'http://127.0.0.1:'+str(golf_port), 'http://127.0.0.1:'+str(forge_port)
    # Compose receives only explicit fixture values, never the operator's keys.
    env = {key: value for key, value in os.environ.items()
           if not key.startswith(('GOLF_', 'FORGEJO_', 'COMPOSE_', 'POSTGRES_', 'RUSTFS_', 'AWS_')) and key != 'DATABASE_URL'}
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
                    for service in ['postgres', 'forgejo', 'golf']:
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
                return compose('exec', '-T', 'forgejo', 'forgejo', '--config', str(recovery_tool.FORGEJO_APP_INI),
                               'admin', 'user', *arguments).strip()

            def sql(statement):
                return compose('exec', '-T', 'postgres', 'psql', '-U', 'postgres', '-d', 'golf',
                               '-At', '-v', 'ON_ERROR_STOP=1', input=statement).strip()

            def object_files():
                data = run('docker', 'cp', '-a', container('rustfs')+':/data', '-', binary=True)
                with tarfile.open(fileobj=io.BytesIO(data), mode='r:') as archive:
                    return {item.name: hashlib.sha256(archive.extractfile(item).read()).hexdigest()
                            for item in archive if item.isfile()}

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
            runner_key = base64.urlsafe_b64encode(secrets.token_bytes(32)).decode().rstrip('=')
            second_runner_key = base64.urlsafe_b64encode(secrets.token_bytes(32)).decode().rstrip('=')
            workers = [('recovery-worker',runner_key),('recovery-secondary',second_runner_key)]
            event_secret = secrets.token_urlsafe(32)
            object_access, object_secret = 'golf-proof-'+secrets.token_hex(12), secrets.token_hex(32)
            forbidden.extend(passwords+[legacy, next_key, oauth_secret, runner_key, second_runner_key, event_secret, object_access, object_secret])
            config = {'services': {
                'postgres': {'image': 'postgres:18.4-alpine3.24', 'pull_policy': 'never',
                    'environment': {'POSTGRES_PASSWORD': passwords[0], 'GOLF_DB_PASSWORD': passwords[1],
                                    'FORGEJO_DB_PASSWORD': passwords[2]},
                    'volumes': ['postgres-data:/var/lib/postgresql',
                                str(ROOT/recovery_tool.POSTGRES_INIT)+':/docker-entrypoint-initdb.d/01-golf.sh:ro'],
                    'healthcheck': {'test': ['CMD-SHELL', 'pg_isready -h 127.0.0.1 -U postgres'], 'interval': '2s',
                                    'timeout': '3s', 'retries': 60}},
                'forgejo': {'image': FORGEJO_IMAGE, 'pull_policy': 'never',
                    'environment': {'FORGEJO__database__DB_TYPE': 'postgres', 'FORGEJO__database__HOST': 'postgres:5432',
                        'FORGEJO__database__NAME': 'forgejo', 'FORGEJO__database__USER': 'forgejo',
                        'FORGEJO__database__PASSWD': passwords[2], 'FORGEJO__server__ROOT_URL': smoke.FORGE+'/',
                        'FORGEJO__server__SSH_DOMAIN': '127.0.0.1', 'FORGEJO__server__SSH_PORT': str(ssh_port),
                        'FORGEJO__server__SSH_LISTEN_PORT': '2222', 'FORGEJO__server__LFS_START_SERVER': 'true',
                        'FORGEJO__security__INSTALL_LOCK': 'true', 'FORGEJO__service__DISABLE_REGISTRATION': 'true',
                        'FORGEJO__actions__ENABLED': 'false', 'FORGEJO__webhook__ALLOWED_HOST_LIST': 'golf'},
                    'ports': [f'127.0.0.1:{forge_port}:3000', f'127.0.0.1:{ssh_port}:2222'],
                    'volumes': recovery_tool.forgejo_volumes(),
                    'depends_on': {'postgres': {'condition': 'service_healthy'}}},
                'golf': {'image': image, 'pull_policy': 'never', 'environment': {
                        'GOLF_LISTEN_ADDR': ':8080', 'GOLF_PUBLIC_URL': smoke.GOLF,
                        'GOLF_ALLOW_INSECURE_COOKIES': 'true', 'GOLF_WEB_DIR': '/app/web/dist',
                        'GOLF_ENCRYPTION_KEY': legacy, 'GOLF_PUSH_CI_ENABLED': 'false',
                        'GOLF_OBJECT_ENDPOINT': 'http://rustfs:9000', 'GOLF_OBJECT_BUCKET': 'golf-ci',
                        'GOLF_OBJECT_REGION': 'us-east-1', 'GOLF_OBJECT_PREFIX': 'golf',
                        'GOLF_OBJECT_PATH_STYLE': 'true', 'GOLF_OBJECT_ALLOW_HTTP': 'true',
                        'GOLF_OBJECT_ACCESS_KEY_ID': object_access, 'GOLF_OBJECT_SECRET_ACCESS_KEY': object_secret,
                        'GOLF_RUNNER_KEYS': json.dumps(dict(workers)),
                        'GOLF_RUNNER_IMAGES': json.dumps({'linux': JOB_IMAGE}),
                        # Compose must unescape this to a literal dollar, then
                        # backup/restore must preserve that effective value.
                        'GOLF_RECOVERY_FIXTURE_MARKER': 'literal-$$recovery-marker',
                        'DATABASE_URL': f'postgres://golf:{passwords[1]}@postgres:5432/golf?sslmode=disable',
                        'GOLF_FORGE_URL': 'http://forgejo:3000', 'GOLF_FORGE_KIND': 'forgejo',
                        'GOLF_FORGE_INSTANCE_ID': str(uuid.uuid4()), 'GOLF_FORGE_PUBLIC_URL': smoke.FORGE,
                        'GOLF_FORGE_OAUTH_CLIENT_ID': prefix, 'GOLF_FORGE_OAUTH_CLIENT_SECRET': oauth_secret},
                    'ports': [f'127.0.0.1:{golf_port}:8080'],
                    'depends_on': {'postgres': {'condition': 'service_healthy'}, 'forgejo': {'condition': 'service_started'}}}},
                'volumes': {name: {} for name in recovery_tool.volume_names(False)}}
            config['services']['rustfs'] = {
                'image': 'rustfs/rustfs:1.0.0@sha256:8cc9801755448b71a786705ce76692c77e14936cccd87cf2fc31842e58f4d1ff',
                'environment': {'RUSTFS_VOLUMES': '/data', 'RUSTFS_ADDRESS': '0.0.0.0:9000',
                    'RUSTFS_CONSOLE_ENABLE': 'false', 'RUSTFS_ACCESS_KEY': object_access,
                    'RUSTFS_SECRET_KEY': object_secret, 'RUSTFS_OBS_LOG_DIRECTORY': '/logs'},
                'volumes': ['rustfs-data:/data'], 'tmpfs': ['/logs:uid=10001,gid=10001,size=67108864,mode=0750'],
                'cap_drop': ['ALL'], 'security_opt': ['no-new-privileges:true'],
                'healthcheck': {'test': ['CMD', 'curl', '--fail', '--silent', 'http://localhost:9000/health'],
                    'interval': '3s', 'timeout': '3s', 'retries': 40}}
            config['volumes']['rustfs-data'] = {}
            config['services']['golf']['depends_on']['rustfs'] = {'condition': 'service_healthy'}
            private(config_file, json.dumps(config))
            identity, wrong_identity = directory/'identity.agekey', directory/'wrong.agekey'
            for path in [identity, wrong_identity]:
                run('age-keygen', '-o', str(path)); path.chmod(0o600)
            recipient = run('age-keygen', '-y', str(identity)).strip()
            check('start isolated canonical source and create native identities')
            compose('up', '-d', '--wait', '--wait-timeout', '120', timeout=180)
            ready()
            compose('exec', '-T', 'golf', 'golf', 'objectstore', 'initialize')
            users = [prefix+'-'+label for label in ['owner', 'outsider']]
            tokens, sessions = [], []
            for username in users:
                admin('create', '--username', username, '--email', username+'@example.invalid',
                      '--random-password', '--must-change-password=false')
                token = admin('generate-access-token', '--username', username, '--token-name', 'recovery-fixture',
                              '--scopes', 'write:user,write:repository,write:issue', '--raw')
                forbidden.append(token); tokens.append(token)
                session = smoke.client(); sessions.append(session)
                smoke.rpc(session, 'SessionService/LoginWithForgeToken', {'token': token})
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
            local_accounts_before = smoke.rpc(local_session, 'InstanceAdminService/ListLocalAccounts')['accounts']
            disable_target = next(row for row in local_accounts_before if row['username'] == local_names[1])
            disable_actor = next(row for row in local_accounts_before if row['username'] == local_names[0])
            disable_actor_session = next(row for row in smoke.rpc(local_session, 'SessionService/ListSessions')['sessions'] if row.get('current'))
            admin_disabled = smoke.rpc(local_session, 'InstanceAdminService/DisableLocalAccount', {
                'accountId': disable_target['id'], 'expectedCredentialVersion': disable_target['credentialVersion'],
                'passwordConfirmation': local_passwords[0]})
            assert admin_disabled['account']['disabled'] and admin_disabled['operationId']
            extra = smoke.client(); sessions.append(extra)
            smoke.rpc(extra, 'SessionService/LoginWithForgeToken', {'token': owner_token})
            owner_identity = smoke.rpc(owner, 'SessionService/GetSession')['user']
            smoke.rpc(smoke.client(), 'SessionService/BeginForgeOAuth')
            assert sql('SELECT count(*) FROM golf_oauth_attempts;') == '1'
            creation_request = {'name': 'recovery-private', 'private': True, 'idempotency_key': str(uuid.uuid4())}
            created = smoke.rpc(owner, 'RepositoryService/CreateRepository', creation_request)
            repository, creation = created['repository'], created['creation']
            assert creation['state'] == 'REPOSITORY_CREATION_STATE_SUCCEEDED'
            full_name = repository['fullName']; key = {'owner': users[0], 'name': repository['name']}
            route = 'repos/'+full_name
            native_owner_id = str(smoke.provider(owner_token, 'GET', 'user')['id'])
            remote = smoke.FORGE+'/'+full_name+'.git'
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
                private(signer, '#!/bin/sh\nexec docker exec -i '+shlex.quote(container('forgejo'))+
                        ' gpg --batch --pinentry-mode loopback --passphrase "" "$@"\n', 0o700)

            signing_wrapper()
            git_env = dict(env, GIT_ASKPASS=str(askpass), GIT_TERMINAL_PROMPT='0',
                           GOLF_CHECK_USER=users[0], GOLF_CHECK_TOKEN=owner_token,
                           GIT_CONFIG_NOSYSTEM='1', GIT_CONFIG_GLOBAL=os.devnull, GNUPGHOME=str(public_home))
            compose('exec', '-T', 'forgejo', 'gpg', '--batch', '--pinentry-mode', 'loopback', '--passphrase', '',
                    '--quick-generate-key', 'Golf Recovery <recovery@example.invalid>', 'ed25519', 'sign', '0')
            secret_listing = compose('exec', '-T', 'forgejo', 'gpg', '--with-colons', '--list-secret-keys')
            fingerprint = next(line.split(':')[9] for line in secret_listing.splitlines() if line.startswith('fpr:'))
            public_key = compose('exec', '-T', 'forgejo', 'gpg', '--armor', '--export', fingerprint)
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
            workflow = '.github/workflows/recovery.yml'
            (work/'.github/workflows').mkdir(parents=True)
            (work/workflow).write_text('on: {workflow_dispatch: {}, push: {branches: [main]}}\njobs:\n  proof:\n    runs-on: linux\n    steps:\n      - run: printf "Recovery source fixture\\n"\n')
            event_connection = str(uuid.uuid4())
            config['services']['golf']['environment']['GOLF_REPOSITORY_EVENT_CONNECTIONS'] = json.dumps([{
                'id': event_connection, 'repositoryId': repository['id'], 'ownerId': native_owner_id,
                'repository': full_name, 'secret': event_secret}])
            private(config_file, json.dumps(config))
            compose('up', '-d', 'golf'); ready()
            hook = smoke.provider(owner_token, 'POST', route+'/hooks', {'type': 'forgejo', 'active': True,
                'events': ['push'], 'branch_filter': '*', 'config': {'url': 'http://golf:8080/hooks/forgejo/'+event_connection,
                'content_type': 'json', 'http_method': 'POST', 'secret': event_secret}}, expected=201)
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
            upload = urllib.request.Request(smoke.FORGE+'/api/v1/'+route+'/releases/'+str(release['id'])+
                '/assets?name=recovery.bin', data=attachment_bytes, method='POST',
                headers={'Authorization': 'token '+owner_token, 'Content-Type': 'application/octet-stream'})
            with urllib.request.urlopen(upload, timeout=20) as response:
                assert response.status == 201
                attachment = json.load(response)
            protection = smoke.provider(owner_token, 'POST', route+'/branch_protections',
                {'rule_name': 'main', 'enable_push': True, 'enable_force_push': False}, expected=201)
            host_keys = ssh_keys()
            check('current schema event, grant, infrastructure and queued/leased-run recovery fixtures')
            deadline = time.monotonic()+30
            while time.monotonic() < deadline and sql('SELECT count(*) FROM golf_repository_events;') == '0':
                time.sleep(.5)
            assert int(sql('SELECT count(*) FROM golf_repository_events;')) > 0
            assert sql("SELECT count(*) FROM golf_repository_events WHERE ref='refs/heads/main' AND after_commit_id='"+commit_id+"';") == '1'
            # Stop future native deliveries before the stopped-writer snapshot.
            grants = []
            grant_input = {'repository': key, 'expectedRepositoryId': repository['id'],
                'expectedOwnerId': native_owner_id, 'nativeToken': owner_token,
                'branches': ['main'], 'workflowPaths': [workflow],
                'expiresAt': (datetime.now(timezone.utc)+timedelta(hours=1)).isoformat()}
            for index in range(2):
                grant = smoke.rpc(owner, 'AutomationGrantService/CreateAutomationGrant',
                    {**grant_input, 'idempotencyKey': str(uuid.uuid4())})['grant']
                if index == 1:
                    grant = smoke.rpc(owner, 'AutomationGrantService/RevokeAutomationGrant',
                        {'repository': key, 'grantId': grant['id'], 'expectedRevision': grant['revision']})['grant']
                grants.append(grant)
            # A third sponsor deliberately has no local password account.
            pat_name = prefix+'-pat-sponsor'
            admin('create', '--username', pat_name, '--email', pat_name+'@example.invalid',
                  '--random-password', '--must-change-password=false')
            pat_token = admin('generate-access-token', '--username', pat_name, '--token-name', 'recovery-grant',
                '--scopes', 'write:user,write:repository,write:issue', '--raw')
            forbidden.append(pat_token)
            smoke.provider(owner_token, 'PUT', route+'/collaborators/'+pat_name, {'permission': 'admin'}, expected=204)
            pat_session = smoke.client()
            smoke.rpc(pat_session, 'SessionService/LoginWithForgeToken', {'token': pat_token})
            grants.append(smoke.rpc(pat_session, 'AutomationGrantService/CreateAutomationGrant',
                {**grant_input, 'nativeToken': pat_token, 'idempotencyKey': str(uuid.uuid4())})['grant'])
            smoke.rpc(pat_session, 'SessionService/Logout')
            assert sql('SELECT count(*) FROM golf_automation_grants g JOIN golf_local_accounts l ON l.user_id=g.sponsor_user_id;') == '2'
            profile = smoke.rpc(local_session, 'InfrastructureConnectionService/SaveInfrastructureConnection', {
                'connection': {'label': 'Recovery PostgreSQL profile', 'kind': 'DATABASE', 'databaseRole': 'GOLF',
                    'backend': 'POSTGRESQL', 'endpoint': 'postgres:5432', 'databaseName': 'golf', 'databaseUser': 'golf',
                    'tlsMode': 'disable', 'allowInsecure': True},
                'credential': {'databasePassword': passwords[1]}, 'expectedVersion': '0',
                'passwordConfirmation': local_passwords[0]})['connection']
            assert smoke.rpc(local_session, 'InfrastructureConnectionService/TestInfrastructureConnection', {
                'id': profile['id'], 'expectedVersion': profile['version'],
                'passwordConfirmation': local_passwords[0]})['accessible']
            for scope, caller in [('INSTANCE', local_session), ('REPOSITORY', owner)]:
                request = {'scope': 'EXECUTION_SCOPE_'+scope}
                if scope == 'REPOSITORY': request['repository'] = key
                previous = smoke.rpc(caller, 'ExecutionPolicyService/GetExecutionPolicy', request)['policy']
                smoke.rpc(caller, 'ExecutionPolicyService/UpdateExecutionPolicy', {**request,
                    'scopeId': previous['scopeId'], 'expectedRevision': previous.get('revision', '0'),
                    'expectedAuthorityRevision': previous['authorityRevision'], 'mode': 'EXECUTION_MODE_ALL',
                    'manualDispatchEnabled': True, 'pushAllowed': True, 'allowAllWorkflows': True})
            check('two actual native pushes admit independently delegated automatic source snapshots')
            config['services']['golf']['environment']['GOLF_PUSH_CI_ENABLED'] = 'true'
            private(config_file, json.dumps(config)); compose('up', '-d', 'golf'); ready()
            time.sleep(7)  # Native timestamps plus the five-second clock-skew margin.
            automatic_runs, manual_runs = [], []
            for index in range(2):
                (work/'automation.txt').write_text('Recovery automatic source '+str(index)+'\n')
                git('add', '.'); git('commit', '-m', 'Automatic recovery source '+str(index))
                pushed = git('rev-parse', 'HEAD'); git('push', remote, 'main')
                deadline = time.monotonic()+60
                while time.monotonic() < deadline:
                    candidates = smoke.rpc(owner, 'WorkflowRunService/ListWorkflowRuns', {'repository': key}).get('runs', [])
                    matches = [row for row in candidates if row['commitId'] == pushed]
                    if matches:
                        assert len(matches) == 1
                        automatic = matches[0]
                        assert automatic['origin'] == 'WORKFLOW_RUN_ORIGIN_PUSH'
                        assert automatic['eventRef'] == 'refs/heads/main' and automatic['automationGrantId'] == grants[0]['id']
                        assert automatic['workflowBlobId'] == git('rev-parse', 'HEAD:'+workflow)
                        automatic_runs.append(automatic)
                        break
                    time.sleep(.5)
                else: raise AssertionError('Native automatic recovery admission timed out')
                if index == 0:
                    manual_runs.append(smoke.rpc(owner, 'WorkflowRunService/DispatchWorkflow', {'repository': key,
                        'workflowPath': workflow, 'ref': commit_id, 'idempotencyKey': str(uuid.uuid4())})['run'])
            smoke.provider(owner_token, 'PATCH', route+'/hooks/'+str(hook['id']), {'active': False}, expected=200)
            refs = git('ls-remote', '--heads', '--tags', remote)
            fixture_runs = automatic_runs+manual_runs+[smoke.rpc(owner, 'WorkflowRunService/DispatchWorkflow', {'repository': key,
                'workflowPath': workflow, 'ref': commit_id, 'idempotencyKey': str(uuid.uuid4())})['run']]
            deadline = time.monotonic()+30
            while time.monotonic() < deadline and sql("SELECT count(*) FROM golf_push_materializations WHERE state IN ('pending','preparing');") != '0':
                time.sleep(.5)
            assert sql("SELECT count(*) FROM golf_push_materializations WHERE state IN ('pending','preparing');") == '0'
            poll = urllib.request.Request(smoke.GOLF+'/internal/ci/poll', data=b'{}', method='POST',
                headers={'Authorization': 'Bearer '+runner_key, 'Golf-Runner-ID': 'recovery-worker', 'Content-Type': 'application/json'})
            assignments = []
            for worker_id, worker_key in workers:
                request = urllib.request.Request(smoke.GOLF+'/internal/ci/poll', data=b'{}', method='POST',
                    headers={'Authorization': 'Bearer '+worker_key, 'Golf-Runner-ID': worker_id, 'Content-Type': 'application/json'})
                with urllib.request.urlopen(request, timeout=15) as response:
                    assert response.status == 200, 'Expected worker assignment'
                    assignments.append(json.load(response))
                forbidden.append(assignments[-1]['attemptToken'])
                assert assignments[-1]['runId'] in {row['id'] for row in fixture_runs}
            assignment = assignments[0]
            assert sql("SELECT string_agg(state,',' ORDER BY state) FROM golf_workflow_runs;") == 'queued,queued,running,running'
            assert sql("SELECT string_agg(origin||':'||state,',' ORDER BY origin,state) FROM golf_workflow_runs;") == 'manual:queued,manual:running,push:queued,push:running'
            assert sql("SELECT count(*) FROM golf_workflow_runs WHERE source_storage='env_s3' AND source_archive IS NULL;") == '4'
            assert sql("SELECT count(*) FROM golf_push_materializations WHERE state='admitted' AND native_activity_id>0;") == '2'
            # This is a leased control-plane attempt, not a claim that a Docker job ran.
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
            smoke.rpc(new, 'SessionService/LoginWithForgeToken', {'token': owner_token})
            assert sql("SELECT count(DISTINCT credential_key_id) FROM golf_sessions;") == '2'
            assert sql("SELECT credential_key_id FROM golf_oauth_attempts;") == 'legacy'
            local_usage = operator('status')['keys']
            assert sum(row.get('local_accounts', 0) for row in local_usage) == 2
            for session in sessions:
                smoke.rpc(session, 'SessionService/GetSession')
            history = {table: rows(table, order) for table, order in HISTORY_TABLES}
            grant_history = json.loads(rows('golf_automation_grants'))
            grant_events = json.loads(rows('golf_automation_grant_events'))
            run_history = json.loads(rows('golf_workflow_runs'))
            assert sum(row.get('automation_credentials', 0) for row in local_usage) == 3
            assert sum(row.get('infrastructure_connections', 0) for row in local_usage) == 1
            local_accounts = json.loads(rows('golf_local_accounts'))
            local_events = json.loads(rows('golf_local_account_events'))
            assert len(local_accounts) == 2 and sum(row['disabled_at'] is not None for row in local_accounts) == 1
            admin_disable_events = [row for row in local_events if row['action'] == 'ADMIN_DISABLED']
            assert len(admin_disable_events) == 1
            admin_disable_event = admin_disable_events[0]
            assert admin_disable_event['operation_id'] == admin_disabled['operationId']
            assert admin_disable_event['actor_user_id'] == int(disable_actor['golfUserId'])
            assert admin_disable_event['actor_session_id'] == int(disable_actor_session['id'])
            counts = int(sql('SELECT count(*) FROM golf_sessions;')), int(sql('SELECT count(*) FROM golf_oauth_attempts;'))
            assert counts == (5, 1)
            check('live writers cannot be bypassed by the operator drain assertion')
            for service in ['golf', 'forgejo']:
                assert json.loads(run('docker', 'inspect', container(service)))[0]['State']['Running']
            running_output = directory/'reject-running.age'
            recovery('backup', '--project', source, '--compose-file', str(config_file), '--recipient', recipient,
                     '--output', str(running_output), '--writers-drained', success=False)
            assert not running_output.exists()
            for service in ['golf', 'forgejo']:
                assert json.loads(run('docker', 'inspect', container(service)))[0]['State']['Running']
            # GnuPG agent sockets are runtime state, not backup payloads.
            compose('exec', '-T', 'forgejo', 'gpgconf', '--kill', 'all')
            compose('stop', 'golf', 'forgejo', 'rustfs')
            # Explicit Golf metadata fixtures exercise interrupted preparation quarantine;
            # actual admitted automatic rows above retain separate native evidence.
            for index, fixture_state in enumerate(['pending', 'preparing']):
                lease = "NULL,NULL" if fixture_state == 'pending' else "'"+str(uuid.uuid4())+"'::uuid,clock_timestamp()+interval '1 hour'"
                sql("INSERT INTO golf_push_materializations(id,event_id,grant_id,grant_revision,grant_epoch,credential_version,workflow_path,state,attempts,lease_id,lease_expires_at) "
                    "SELECT '"+str(uuid.uuid4())+"'::uuid,(SELECT min(id) FROM golf_repository_events),g.id,g.revision,g.revocation_epoch,c.version,'"+workflow+"','"+fixture_state+"',1,"+lease+" FROM golf_automation_grants g JOIN golf_automation_credentials c ON c.grant_id=g.id WHERE g.id='"+grants[index*2]['id']+"'::uuid;")
            materialization_history = json.loads(rows('golf_push_materializations'))
            assert sum(row['state']=='admitted' for row in materialization_history) == 2
            assert sum(row['state']=='pending' for row in materialization_history) == 1
            assert sum(row['state']=='preparing' for row in materialization_history) == 1
            source_object_files = object_files()
            assert source_object_files
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
            assert manifest['storage_profile'] == 'local_rustfs' and 'rustfs-data.tar' in files
            for name, evidence in manifest['files'].items():
                assert evidence == {'bytes': len(files[name]), 'sha256': hashlib.sha256(files[name]).hexdigest()}
            archived_config = json.loads(files['compose.json'])
            assert archived_config['services']['golf']['environment']['GOLF_ENCRYPTION_KEYS'] == config['services']['golf']['environment']['GOLF_ENCRYPTION_KEYS']
            def marker_value():
                values = json.loads(run('docker', 'inspect', container('golf')))[0]['Config']['Env']
                return next(value.split('=', 1)[1] for value in values if value.startswith('GOLF_RECOVERY_FIXTURE_MARKER='))

            assert marker_value() == 'literal-$recovery-marker'
            def encrypted_bundle(contents, destination):
                stream = io.BytesIO()
                with tarfile.open(fileobj=stream, mode='w:') as archive:
                    for name, data in contents.items():
                        member = tarfile.TarInfo(name); member.size = len(data); member.mode = 0o600
                        archive.addfile(member, io.BytesIO(data))
                private(destination, run('age', '-r', recipient, input=stream.getvalue(), binary=True))

            # A permitted historical schema label must still match the restored dump.
            # Payload integrity alone cannot establish that semantic binding.
            mislabeled = dict(files)
            wrong_manifest = json.loads(files['manifest.json'])
            wrong_manifest['versions']['golf_schema'] = '202610020008'
            mislabeled['manifest.json'] = json.dumps(wrong_manifest).encode()
            schema_file = directory/'wrong-schema.age'
            encrypted_bundle(mislabeled, schema_file)
            recovery('verify', '--input', str(schema_file), '--identity', str(identity))
            recovery('restore', '--input', str(schema_file), '--identity', str(identity), '--project', schema_rejected,
                '--directory', str(directory/'wrong-schema'), '--writers-drained', success=False)
            rejected_rows = json.loads(run('docker', 'inspect', *resources(schema_rejected)['containers']))
            assert all(not row['State']['Running'] for row in rejected_rows
                if row['Config']['Labels'].get('com.docker.compose.service') in {'golf', 'forgejo'})
            rejected_pg = next(row['Id'] for row in rejected_rows
                if row['Config']['Labels'].get('com.docker.compose.service')=='postgres')
            assert run('docker', 'exec', rejected_pg, 'psql', '-U', 'postgres', '-d', 'golf', '-Atc',
                'SELECT count(*) FROM golf_sessions;').strip() == str(counts[0])
            print('PASS: restored-schema mismatch rejected before invalidation with applications quarantined', flush=True)

            # Re-encrypt a structurally valid tar with one changed payload and its
            # original manifest: age passes but the inner checksum must fail.
            damaged = bytearray(files['golf.dump']); damaged[len(damaged)//2] ^= 1
            files['golf.dump'] = bytes(damaged)
            checksum_file = directory/'checksum.age'
            encrypted_bundle(files, checksum_file)
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
            for service in ['golf', 'forgejo', 'rustfs']:
                assert not json.loads(run('docker', 'inspect', container(service)))[0]['State']['Running']
            assert object_files() == source_object_files, 'Restored RustFS file hashes differ'
            assert sql('SELECT count(*) FROM golf_sessions;') == '0'
            assert sql('SELECT count(*) FROM golf_oauth_attempts;') == '0'
            for table, order in HISTORY_TABLES:
                assert rows(table, order) == history[table], 'Restored Golf history or key metadata differs'
            restored_grants = json.loads(rows('golf_automation_grants'))
            for previous, actual in zip(grant_history, restored_grants):
                assert actual['enabled'] is False
                increment = int(previous['enabled'])
                assert actual['revision'] == previous['revision']+increment
                assert actual['revocation_epoch'] == previous['revocation_epoch']+increment
                excluded = {'enabled', 'revision', 'revocation_epoch'}
                assert {k:v for k,v in actual.items() if k not in excluded} == {k:v for k,v in previous.items() if k not in excluded}
            restored_grant_events = json.loads(rows('golf_automation_grant_events'))
            assert restored_grant_events[:len(grant_events)] == grant_events
            added = restored_grant_events[len(grant_events):]
            assert len(added) == 2 and all(row['action']=='RECOVERY_REVOKED' for row in added)
            assert {row['grant_id'] for row in added} == {row['id'] for row in grant_history if row['enabled']}
            for previous, actual in zip(run_history, json.loads(rows('golf_workflow_runs'))):
                assert actual['state'] == 'cancelled' and actual['version'] == previous['version']+1
                assert actual['lease_token_hash'] is None and actual['finished_at'] is not None
                excluded = {'state', 'version', 'finished_at', 'reason', 'lease_token_hash'}
                assert {k:v for k,v in actual.items() if k not in excluded} == {k:v for k,v in previous.items() if k not in excluded}
            for previous, actual in zip(materialization_history, json.loads(rows('golf_push_materializations'))):
                mutable = {'state','reason','lease_id','lease_expires_at','updated_at'}
                if previous['state'] in ['pending','preparing']:
                    assert actual['state'] == 'blocked' and actual['reason'] == 'recovery_quarantine'
                    assert actual['lease_id'] is None and actual['lease_expires_at'] is None
                    assert {k:v for k,v in previous.items() if k not in mutable} == {k:v for k,v in actual.items() if k not in mutable}
                else: assert actual == previous
            print('PASS: RustFS file hashes/source locators/provenance preserved; pending/preparing work quarantined and admitted history retained', flush=True)
            print('PASS: enabled local and PAT-only grants revoked, prior revocation retained, queued/leased runs cancelled and all credential ciphertext/history preserved', flush=True)
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
            assert next(row for row in restored_local_events if row['action'] == 'ADMIN_DISABLED') == admin_disable_event
            local_recovery_events = restored_local_events[len(local_events):]
            assert len(local_recovery_events) == 2 and all(row['action'] == 'RECOVERY_DISABLED' for row in local_recovery_events)
            assert {row['operation_id'] for row in local_recovery_events} == {event['operation_id']}
            assert operator('status')['active_key_id'] == 'next'
            assert sum(row.get('local_accounts', 0) for row in operator('status')['keys']) == 2
            print('PASS: quarantine, exact invalidation ledger, preserved identity/audit/crypto history and key registry', flush=True)
            check('reopen only the disposable target and verify private restored data')
            compose('start', 'rustfs')
            compose('up', '-d', 'forgejo', 'golf'); ready()
            for session in sessions:
                smoke.rpc(session, 'SessionService/GetSession', expected=401)
            for (worker_id, worker_key), assignment in zip(workers,assignments):
                old_attempt = urllib.request.Request(smoke.GOLF+'/internal/ci/attempt/'+assignment['attemptId']+'/heartbeat',
                    data=b'{}', method='POST', headers={'Authorization': 'Bearer '+worker_key,
                        'Golf-Runner-ID': worker_id, 'Golf-Attempt-Token': assignment['attemptToken'], 'Content-Type': 'application/json'})
                try:
                    urllib.request.urlopen(old_attempt, timeout=15)
                    raise AssertionError('Restored attempt capability accepted')
                except urllib.error.HTTPError as error:
                    assert error.code == 403
                    error.close()
            for index in range(2):
                smoke.rpc(smoke.client(), 'SessionService/LoginWithPassword',
                    {'username': local_names[index], 'password': local_passwords[index]}, expected=401)
            owner, outsider = smoke.client(), smoke.client()
            assert smoke.rpc(owner, 'SessionService/LoginWithForgeToken', {'token': owner_token})['user'] == owner_identity
            smoke.rpc(outsider, 'SessionService/LoginWithForgeToken', {'token': outsider_token})
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
            assert smoke.rpc(fresh_local, 'InfrastructureConnectionService/TestInfrastructureConnection', {
                'id': profile['id'], 'expectedVersion': profile['version'],
                'passwordConfirmation': restored_password})['accessible']
            retained_grants = smoke.rpc(fresh_local, 'AutomationGrantService/ListAutomationGrants', {'repository': key})['grants']
            assert {row['id'] for row in retained_grants} == {row['id'] for row in grants}
            assert all(not row.get('enabled', False) for row in retained_grants)
            smoke.rpc(fresh_local, 'SessionService/Logout')
            print('PASS: all restored local accounts disabled/version-fenced; password-only reset cannot enable, fresh immutable mapping required', flush=True)
            check('restored fifth-family key rotation and no queued-attempt replay')
            with urllib.request.urlopen(poll, timeout=15) as response:
                assert response.status == 204
            assert sql("SELECT count(*) FROM golf_workflow_runs WHERE state IN ('queued','running');") == '0'
            assert sql("SELECT count(*) FROM golf_push_materializations WHERE state IN ('pending','preparing');") == '0'
            assert sql('SELECT count(*) FROM golf_workflow_runs;') == '4'
            rotated = operator('rotate', '--batch-size', '2', '--max-batches', '20')
            assert rotated['rotated_automation_credentials'] == 3
            assert rotated['rotated_infrastructure_connections'] == 1
            assert sql("SELECT count(*) FROM golf_automation_credentials WHERE credential_key_id='next';") == '3'
            assert sql("SELECT count(*) FROM golf_infrastructure_connection_versions WHERE credential_key_id='next';") == '1'
            assert operator('retirement-check', '--key-id', 'legacy', state='eligible')['complete']
            assert all(not row['enabled'] for row in json.loads(rows('golf_automation_grants')))
            assert not smoke.provider(owner_token, 'GET', route+'/hooks/'+str(hook['id']))['active']
            print('PASS: restored profile decrypts and tests, all grants remain revoked after login/rotation, inactive key can retire and no run replays', flush=True)

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
            assert compose('exec', '-T', 'forgejo', 'gpg', '--armor', '--export', fingerprint) == public_key
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
                if row['Config']['Labels']['com.docker.compose.service'] in {'golf', 'forgejo'}:
                    assert not row['State']['Running'], 'Source writer was reopened'
            print('PASS: fresh-session key use, post-restore signed push, force-push denial and restart persistence', flush=True)
    finally:
        smoke.GOLF, smoke.FORGE = original_urls
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
