#!/usr/bin/env python3
"""Encrypted, offline recovery for Golf's canonical core, optionally with local RustFS.

Writers must already be drained/stopped. Restore accepts trusted operator backups
only, creates a fresh project, invalidates restored Golf sessions and leaves both
applications stopped. It never opens traffic or reconciles provider revocations.
"""
import argparse
import configparser
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import resource
import shutil
import stat
import subprocess
import sys
import tarfile
import tempfile
import time
import uuid
from urllib.parse import parse_qs, unquote, urlsplit

sys.dont_write_bytecode = True
ROOT = Path(__file__).resolve().parents[1]
FORMAT = 'golf.backup.v1'
SUPPORTED_SCHEMAS = {'202610020008', '202610020009', '202610020019', '202610020021'}
ACCESS_SCHEMA = '202610040059'
ACCESS_PROFILE = 'access-core059'
ACCESS_PG_COMMAND = ['postgres', '-c', 'max_wal_size=64MB', '-c', 'min_wal_size=32MB', '-c', 'checkpoint_timeout=30s']
# Closed source/restore eligibility, not a whole-platform recovery profile.
ACCESS_EMPTY = {
    'automation_grants': "golf_automation_grants WHERE enabled",
    'push_materializations': "golf_push_materializations WHERE state IN ('pending','preparing')",
    'agents': "golf_agent_tasks WHERE state IN ('queued','running')",
    'reviewers': "golf_reviewer_runs WHERE state IN ('admitting','queued','running','publishing','publication_unknown') OR legacy_effect_block",
    'bot_publications': "golf_reviewer_publications WHERE state IN ('reserved','dispatch_unknown')",
    'overall_reviews': "golf_pull_review_mutations WHERE state='OUTCOME_UNKNOWN'",
    'inline_reviews': "golf_inline_review_mutations WHERE phase IN ('RESERVED','DISPATCH_UNKNOWN')",
    'lifecycle': "golf_repository_lifecycle_operations WHERE phase IN ('RESERVED','DISPATCH_UNKNOWN')",
    'rules': "golf_repository_rule_mutations WHERE phase IN ('RESERVED','DISPATCH_UNKNOWN')",
    'git_profiles': 'golf_git_transport_profiles WHERE suspended_at IS NULL',
    'git_credentials': 'golf_git_credentials WHERE revoked_at IS NULL',
    'git_receives': "golf_git_receive_operations WHERE phase IN ('RESERVED','UNKNOWN')",
    'webhook_subscriptions': 'golf_webhook_subscriptions WHERE enabled',
    'webhook_deliveries': "golf_webhook_deliveries WHERE state IN ('queued','retrying','sending')",
    'email_subscriptions': 'golf_email_subscriptions WHERE enabled',
    'email_deliveries': "golf_email_deliveries WHERE state IN ('queued','retrying','sending')",
    'email_transport': 'golf_email_configuration WHERE transport_id IS NOT NULL',
    'event_connections': 'golf_repository_event_connections',
    'issue_mutations': "golf_issue_mutations WHERE state='OUTCOME_UNKNOWN'",
    'repository_creations': "golf_repository_creations WHERE state='OUTCOME_UNKNOWN'",
    # No active/leased or legacy queued work: only one unclaimed real typed run.
    'unsupported_workflows': "golf_workflow_runs r WHERE r.state='running' OR (r.state='queued' AND (r.origin<>'manual' OR r.lease_token_hash IS NOT NULL OR r.attempt_id<>'' OR r.runner_id<>'' OR r.lease_expires_at IS NOT NULL OR NOT EXISTS(SELECT 1 FROM golf_workflow_dispatch_inputs i WHERE i.run_id=r.id)))",
}
KEY_FAMILIES = ('sessions', 'oauth_attempts', 'local_accounts', 'infrastructure_connections',
                'automation_credentials', 'review_contents', 'conversation_contents', 'webhook_credentials',
                'repository_execution_values', 'organization_execution_values',
                'workflow_quarantined_outputs', 'notification_contents', 'workflow_dispatch_inputs')
# Forgejo 15.0.9 has no global cron switch; each task reads its own
# [cron.<name>] section. This is every task registered by v15.0.9
# services/cron/tasks_basic.go and tasks_extended.go, including conditionally
# registered ones. tasks_actions.go registers nothing while
# [actions] ENABLED=false, which this profile separately requires.
NATIVE_CRON_TASKS = ('update_mirrors', 'repo_health_check', 'check_repo_stats', 'archive_cleanup',
    'sync_external_users', 'deleted_branches_cleanup', 'update_migration_poster_id',
    'cleanup_hook_task_table', 'cleanup_packages',
    'delete_inactive_accounts', 'delete_repo_archives', 'git_gc_repos', 'resync_all_sshkeys',
    'resync_all_sshprincipals', 'resync_all_hooks', 'reinit_missing_repos', 'delete_missing_repos',
    'delete_generated_repository_avatars', 'delete_old_actions', 'update_checker',
    'delete_old_system_notices', 'gc_lfs', 'rebuild_issue_indexer', 'remove_resolved_reports')
ACCESS_NATIVE_EMPTY = ('mirror', 'push_mirror', 'webhook', 'hook_task', 'action_run')

# The rootless Forgejo 15.0.9 image (Dockerfile.rootless) keeps its single data
# volume, app.ini and temporary scratch under these upstream paths.
FORGEJO_DATA = PurePosixPath('/var/lib/gitea')  # Forgejo's upstream name
FORGEJO_TEMP = PurePosixPath('/tmp/gitea')  # Forgejo's upstream name
FORGEJO_APP_INI = FORGEJO_DATA/'custom/conf/app.ini'
# `forgejo --version` prints the build version, which carries the compatibility suffix.
FORGEJO_VERSION = 'forgejo version 15.0.9+gitea-1.22.0 '  # Forgejo's upstream name
# `docker cp` names the archive root after the copied directory.
DATA_ROOT = FORGEJO_DATA.name
DATA_APP_INI = str(PurePosixPath(DATA_ROOT)/FORGEJO_APP_INI.relative_to(FORGEJO_DATA))
FORGE_ENV_PREFIX = 'FORGEJO__'
# Forgejo's environment-to-ini also reads this prefix. Refuse it rather than
# guess which of two spellings for one setting wins.
UPSTREAM_ENV_PREFIX = 'GITEA__'  # Forgejo's upstream name
ENV_ESCAPE = re.compile(r'_0[xX]((?:[0-9a-fA-F]{2})+)_')
POSTGRES_INIT = 'deploy/postgres/forgejo-init.sh'  # Relative to ROOT, which a caller may rebind.

FILES = {'compose.json', 'postgres-init.sh', 'golf.dump', 'forgejo.dump', 'forgejo-data.tar'}
PROJECT = re.compile(r'^[a-z0-9][a-z0-9_-]{0,62}$')
LIMIT = 8 << 30
RUSTFS_IMAGE = 'rustfs/rustfs:1.0.0@sha256:8cc9801755448b71a786705ce76692c77e14936cccd87cf2fc31842e58f4d1ff'
RUSTFS_TMPFS = {'/logs': 'uid=10001,gid=10001,size=67108864,mode=0750'}


def envelope_limit(payload):
    # Bounded room for outer tar headers and age chunk authentication overhead;
    # 1 MiB alone is insufficient for a payload at the default 8 GiB boundary.
    return payload + payload // 1024 + (1 << 20)


def require(value):
    if not value:
        raise ValueError('Recovery precondition failed')


def private_file(path):
    info = path.lstat()
    require(stat.S_ISREG(info.st_mode) and info.st_uid == os.getuid() and
            stat.S_IMODE(info.st_mode) & 0o077 == 0)


def write(path, data):
    with os.fdopen(os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), 'wb') as file:
        file.write(data)


def digest(path):
    with path.open('rb') as file:
        return hashlib.file_digest(file, 'sha256').hexdigest()


def run(command, *, input=None, output=None, timeout=300, limit=LIMIT):
    # Native tools can emit secrets on failure. Keep both streams private and
    # bounded; never include their output or arguments in an exception/log.
    with tempfile.TemporaryFile() as errors, tempfile.TemporaryFile() as capture:
        destination = output.open('xb') if output else capture
        if output:
            os.chmod(output, 0o600)
        try:
            result = subprocess.run(command, stdin=input, stdout=destination, stderr=errors,
                                    timeout=timeout,
                                    preexec_fn=lambda: resource.setrlimit(resource.RLIMIT_FSIZE, (limit, limit)))
            require(result.returncode == 0)
            if not output:
                capture.seek(0)
                value = capture.read((1 << 20) + 1)
                require(len(value) <= 1 << 20)
                return value
        finally:
            if output:
                destination.close()


def docker_json(*command):
    return json.loads(run(['docker', *command]))


def containers(project):
    names = run(['docker', 'ps', '-aq', '--filter', 'label=com.docker.compose.project='+project]).decode().split()
    return docker_json('inspect', *names) if names else []


def environment(container):
    values = container['Config']['Env']
    require(all('=' in item for item in values))
    result = dict(item.split('=', 1) for item in values)
    require(len(result) == len(values))
    return result


def ports(container, expected):
    bindings = container['HostConfig']['PortBindings'] or {}
    require(set(bindings) == set(expected))
    result = []
    for target, entries in bindings.items():
        require(len(entries) == 1 and entries[0]['HostIp'] == '127.0.0.1')
        port = entries[0]['HostPort']
        require(port.isdecimal() and 0 < int(port) < 65536)
        result.append({'target': int(target.split('/')[0]), 'published': port,
                       'host_ip': '127.0.0.1', 'protocol': 'tcp'})
    return result


def captured_path(value):
    path = PurePosixPath(value)
    require(path.is_absolute() and '..' not in path.parts and value.rstrip('/') == path.as_posix() and
            (path == FORGEJO_DATA or FORGEJO_DATA in path.parents))


def native_settings(env):
    """Decode Forgejo 15.0.9 FORGEJO__SECTION__KEY settings (modules/setting/config_env.go).

    Refuse __FILE indirection (its value is outside the captured runtime) and
    any two variables naming one setting, instead of depending on order.
    """
    settings = {}
    for name, value in env.items():
        require(not name.startswith(UPSTREAM_ENV_PREFIX))
        if not name.startswith(FORGE_ENV_PREFIX):
            continue
        require(not name.endswith('__FILE'))
        encoded, section, key, in_key, last = name[len(FORGE_ENV_PREFIX):], '', '', False, 0

        def plain(text):
            nonlocal section, key, in_key
            if in_key:
                key += text
            elif '__' in text:
                before, after = text.split('__', 1)
                section, key, in_key = section+before, key+after, True
            else:
                section += text

        for match in ENV_ESCAPE.finditer(encoded):
            plain(encoded[last:match.start()])
            decoded = bytes.fromhex(match.group(1)).decode()
            if in_key:
                key += decoded
            else:
                section += decoded
            last = match.end()
        plain(encoded[last:])
        if not key:
            continue
        setting = (section.lower(), key.upper())
        require(setting not in settings)
        settings[setting] = value
    return settings


def validate_forgejo_environment(env, password):
    # The rootless image's own path variables. Every persistent path,
    # including app.ini, must stay inside the captured volume.
    image_paths = {'GITEA_WORK_DIR': str(FORGEJO_DATA),  # Forgejo's upstream name
                   'GITEA_CUSTOM': str(FORGEJO_DATA/'custom'),  # Forgejo's upstream name
                   'GITEA_APP_INI': str(FORGEJO_APP_INI),  # Forgejo's upstream name
                   'HOME': str(FORGEJO_DATA/'git')}
    require(all(env.get(key) == value for key, value in image_paths.items()))
    # Forgejo copies these over the image path variables at startup.
    require(not env.get('FORGEJO_CUSTOM') and not env.get('FORGEJO_WORK_DIR'))
    settings = native_settings(env)
    require(settings.get(('database', 'DB_TYPE')) == 'postgres' and
            settings.get(('database', 'HOST')) == 'postgres:5432' and
            settings.get(('database', 'NAME')) == 'forgejo' and
            settings.get(('database', 'USER')) == 'forgejo' and
            settings.get(('database', 'PASSWD')) == password)


def volume_names(rustfs):
    return ['postgres-data', 'forgejo-data', *(['rustfs-data'] if rustfs else [])]


def forgejo_volumes():
    return ['forgejo-data:' + str(FORGEJO_DATA)]


def compose_bytes(config):
    # Compose interpolates even JSON environment values. $$ is its documented
    # literal-dollar escape; preserve the archived runtime values exactly.
    config = json.loads(json.dumps(config))
    for service in config['services'].values():
        service['environment'] = {key: value.replace('$', '$$') for key, value in service['environment'].items()}
    return json.dumps(config).encode()


def profile_files(rustfs):
    return FILES | ({'rustfs-data.tar'} if rustfs else set())


def storage_fingerprint(config):
    golf = config['services']['golf']['environment']
    rustfs = config['services'].get('rustfs')
    if not rustfs:
        require(not golf.get('GOLF_OBJECT_BUCKET'))
        return ''
    env = rustfs['environment']
    require({key for key in env if key.startswith('RUSTFS_')} <= {
        'RUSTFS_ACCESS_KEY', 'RUSTFS_SECRET_KEY', 'RUSTFS_VOLUMES', 'RUSTFS_ADDRESS',
        'RUSTFS_CONSOLE_ENABLE', 'RUSTFS_CONSOLE_CORS_ALLOWED_ORIGINS',
        'RUSTFS_OBS_ENVIRONMENT', 'RUSTFS_OBS_LOGGER_LEVEL', 'RUSTFS_OBS_LOG_DIRECTORY'})
    expected = {'GOLF_OBJECT_ENDPOINT': 'http://rustfs:9000', 'GOLF_OBJECT_BUCKET': 'golf-ci',
                'GOLF_OBJECT_REGION': 'us-east-1', 'GOLF_OBJECT_PREFIX': 'golf',
                'GOLF_OBJECT_PATH_STYLE': 'true', 'GOLF_OBJECT_ALLOW_HTTP': 'true'}
    require(all(golf.get(key) == value for key, value in expected.items()) and
            not golf.get('GOLF_OBJECT_SESSION_TOKEN') and
            env.get('RUSTFS_VOLUMES') == '/data' and env.get('RUSTFS_ADDRESS') == '0.0.0.0:9000' and
            env.get('RUSTFS_CONSOLE_ENABLE') == 'false' and env.get('RUSTFS_OBS_LOG_DIRECTORY') == '/logs' and
            env.get('RUSTFS_ACCESS_KEY') and env.get('RUSTFS_SECRET_KEY') and
            golf.get('GOLF_OBJECT_ACCESS_KEY_ID') == env['RUSTFS_ACCESS_KEY'] and
            golf.get('GOLF_OBJECT_SECRET_ACCESS_KEY') == env['RUSTFS_SECRET_KEY'])
    value = {'Endpoint': expected['GOLF_OBJECT_ENDPOINT'], 'Bucket': expected['GOLF_OBJECT_BUCKET'],
             'Region': expected['GOLF_OBJECT_REGION'], 'Prefix': expected['GOLF_OBJECT_PREFIX'], 'PathStyle': True}
    return hashlib.sha256(json.dumps(value, separators=(',', ':')).encode()).hexdigest()


def validate_source_bindings(pg, config, schema):
    # Dormant connection profiles remain encrypted configuration, not backed-up
    # external resources. Active profiles and any profile-backed source refuse
    # this local-only backup, even if an operator labels that profile "local".
    fingerprint = storage_fingerprint(config)
    if int(schema) < 202610020013:
        return
    query = "SELECT count(*) FROM golf_workflow_runs WHERE source_storage='profile_s3' OR (source_storage='env_s3' AND source_fingerprint<>'"+fingerprint+"');"
    require(run(['docker', 'exec', pg, 'psql', '-U', 'postgres', '-d', 'golf', '-Atc', query]).strip() == b'0')
    if int(schema) >= 202610020014:
        query = 'SELECT count(*) FROM golf_active_object_connection WHERE profile_id IS NOT NULL;'
        require(run(['docker', 'exec', pg, 'psql', '-U', 'postgres', '-d', 'golf', '-Atc', query]).strip() == b'0')



def validate_profile(schema, profile):
    require((schema in SUPPORTED_SCHEMAS and profile is None) or
            (schema == ACCESS_SCHEMA and profile == ACCESS_PROFILE))


def validate_access_config(config):
    require(set(config['services']) == {'golf', 'forgejo', 'postgres'})
    golf = config['services']['golf']['environment']
    native = config['services']['forgejo']['environment']
    require(golf.get('GOLF_FORGE_URL') == 'http://forgejo:3000' and golf.get('GOLF_FORGE_KIND') == 'forgejo')
    # Do not capture proxy transport, external intake or managed Git activation.
    for key in ('HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy',
                'GOLF_REPOSITORY_EVENT_CONNECTIONS', 'GOLF_GIT_TRANSPORT_PROFILE',
                'GOLF_INTERNAL_TLS_CERT_FILE', 'GOLF_INTERNAL_TLS_KEY_FILE'):
        require(not golf.get(key))
    require(golf.get('GOLF_PUSH_CI_ENABLED', 'false').lower() == 'false')
    settings = native_settings(native)
    require(settings.get(('actions', 'ENABLED'), '').lower() == 'false' and
            settings.get(('mailer', 'ENABLED'), '').lower() == 'false' and
            all(settings.get(('cron.' + name, 'ENABLED'), '').lower() == 'false' for name in NATIVE_CRON_TASKS))
    # No injected native global hook command or environment proxy.
    require(not any(value for key, value in native.items() if key.upper() in {'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY'}))
    require(not any(value for (section, _), value in settings.items() if section.startswith('git.config')))


def validate_access_counts(counts):
    require(isinstance(counts, dict) and set(counts) == set(ACCESS_EMPTY) |
            {'typed_queued'} | {'native_' + name for name in ACCESS_NATIVE_EMPTY})
    require(all(type(value) is int and value == 0 for key, value in counts.items() if key != 'typed_queued'))
    require(type(counts['typed_queued']) is int and 0 <= counts['typed_queued'] <= 1)


def access_profile_observation(pg, config):
    validate_access_config(config)
    counts = {}
    for key, source in ACCESS_EMPTY.items():
        raw = run(['docker', 'exec', pg, 'psql', '-U', 'postgres', '-d', 'golf', '-Atc',
                   'SELECT count(*) FROM ' + source + ';']).strip()
        require(raw.isdigit()); counts[key] = int(raw)
    raw = run(['docker', 'exec', pg, 'psql', '-U', 'postgres', '-d', 'golf', '-Atc',
               "SELECT count(*) FROM golf_workflow_runs WHERE state='queued';"]).strip()
    require(raw.isdigit()); counts['typed_queued'] = int(raw)
    for table in ACCESS_NATIVE_EMPTY:
        raw = run(['docker', 'exec', pg, 'psql', '-U', 'postgres', '-d', 'forgejo', '-Atc',
                   'SELECT count(*) FROM ' + table + ';']).strip()
        require(raw.isdigit()); counts['native_' + table] = int(raw)
    validate_access_counts(counts)
    return counts




def validate_access_archive(stage):
    with tarfile.open(stage/'forgejo-data.tar', 'r:') as archive:
        ini = configparser.ConfigParser(interpolation=None, strict=False)
        ini.read_string('[DEFAULT]\n' + archive.extractfile(DATA_APP_INI).read().decode())
        require(ini.get('actions', 'ENABLED', fallback='').lower() == 'false' and
                ini.get('mailer', 'ENABLED', fallback='').lower() == 'false' and
                all(ini.get('cron.' + name, 'ENABLED', fallback='').lower() == 'false' for name in NATIVE_CRON_TASKS))
        require(not ini.has_section('git.config') or
                not any(key.lower() == 'core.hookspath' and value for key, value in ini['git.config'].items()))
        for member in archive:
            parts = PurePosixPath(member.name).parts
            require('custom_hooks' not in parts and not (parts[-1] == 'reference-transaction' and 'hooks' in parts))
            for index, part in enumerate(parts):
                if part in {'pre-receive.d', 'post-receive.d', 'update.d', 'proc-receive.d'}:
                    # Only Forgejo's generated delegate hook file is permitted.
                    require((index + 1 == len(parts) and member.isdir()) or
                            (index + 2 == len(parts) and parts[-1] == 'gitea' and member.isfile()))  # Forgejo's upstream name
            # Native Git configuration persists independently of app.ini: the
            # image HOME and Forgejo's [git] HOME_PATH each hold a .gitconfig.
            # Do not restore an out-of-profile hook path or a deferred include.
            if parts[-1] == '.gitconfig' or member.name.endswith('.git/config'):
                require(member.isfile() and member.size <= 1 << 20)
                git = configparser.ConfigParser(interpolation=None, strict=False)
                git.read_string(archive.extractfile(member).read().decode())
                for section in git.sections():
                    require(not section.lower().startswith('include'))
                    if section.lower() == 'core':
                        require(not git.get(section, 'hooksPath', fallback=''))


def checked_key_status(value):
    require(isinstance(value, dict) and set(value) == {'active_key_id', 'configured_active_key_id', 'keys'} and
            value['active_key_id'] == value['configured_active_key_id'] and isinstance(value['keys'], list) and
            1 <= len(value['keys']) <= 32)
    seen = set()
    for row in value['keys']:
        require(isinstance(row, dict) and set(row) == set(KEY_FAMILIES) | {'key_id', 'configured'} and
                isinstance(row['key_id'], str) and re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9._-]{0,63}', row['key_id']) and
                row['key_id'] not in seen and row['configured'] is True and
                all(type(row[key]) is int and 0 <= row[key] <= (1 << 63)-1 for key in KEY_FAMILIES))
        seen.add(row['key_id'])
    require(value['active_key_id'] in seen)
    return value


def access_key_status(compose):
    value = json.loads(run([*compose, 'run', '--rm', '--no-deps', '-T', 'golf', 'keys', 'status']))
    require(value.get('schema_version') == 'golf.keys.v1' and value.get('state') == 'complete')
    return checked_key_status(value['result'])


def matching_compose_files(label, supplied):
    # Compose may recreate only changed services, leaving older service labels
    # with fewer overlays. Every retained label must still describe this base
    # and an ordered, distinct subset of the explicitly supplied files.
    selected = label.split(',') if isinstance(label, str) else []
    expected = [str(file) for file in supplied]
    return bool(selected and expected and selected[0] == expected[0] and
                len(set(selected)) == len(selected) and len(set(expected)) == len(expected) and
                all(file in expected for file in selected) and
                [expected.index(file) for file in selected] == sorted(expected.index(file) for file in selected))


def snapshot(project, compose_files, profile=None):
    rows = containers(project)
    require(len(rows) in {3, 4})
    services = {row['Config']['Labels'].get('com.docker.compose.service'): row for row in rows}
    rustfs = 'rustfs' in services
    require(len(services) == len(rows))
    require(set(services) == {'golf', 'forgejo', 'postgres'} | ({'rustfs'} if rustfs else set()))
    for row in rows:
        labels = row['Config']['Labels']
        require(labels.get('com.docker.compose.oneoff') == 'False' and
                matching_compose_files(labels.get('com.docker.compose.project.config_files'), compose_files))
        require(not row['HostConfig']['Privileged'] and not row['HostConfig']['NetworkMode'].startswith('host'))
        image_config = docker_json('image', 'inspect', row['Image'])[0]['Config']
        require(all((row['Config'].get(key) or None) == (image_config.get(key) or None)
                    for key in ['Entrypoint', 'User', 'WorkingDir']))
        require((row['Config'].get('Cmd') or None) == (image_config.get('Cmd') or None) or
                (profile == ACCESS_PROFILE and row is services['postgres'] and row['Config'].get('Cmd') == ACCESS_PG_COMMAND))
        host = row['HostConfig']
        is_rustfs = row is services.get('rustfs')
        require(host['RestartPolicy']['Name'] in {'', 'no'} and
                not any(host.get(key) for key in ['Memory', 'NanoCpus', 'CpuShares', 'CapAdd',
                                                'DeviceRequests', 'ReadonlyRootfs', 'ExtraHosts']))
        if is_rustfs:
            require(row['Image'] == docker_json('image', 'inspect', RUSTFS_IMAGE)[0]['Id'] and
                    host.get('CapDrop') == ['ALL'] and host.get('SecurityOpt') == ['no-new-privileges:true'] and
                    host.get('Tmpfs') == RUSTFS_TMPFS and not (host['PortBindings'] or {}))
        else:
            require(not host.get('CapDrop') and not host.get('SecurityOpt') and not host.get('Tmpfs'))
        require(len(row['NetworkSettings']['Networks']) == 1)
    require(services['postgres']['State']['Running'])
    require(all(services[name]['State']['Status'] in {'exited', 'created'} for name in ['golf', 'forgejo', *(['rustfs'] if rustfs else [])]))
    require(services['forgejo']['Config']['User'] == '1000:1000')
    # The rootless Forgejo image declares exactly one volume; app.ini is inside it.
    expected = {'postgres': {'/var/lib/postgresql': 'postgres-data'},
                'forgejo': {str(FORGEJO_DATA): 'forgejo-data'}, 'golf': {}, **({'rustfs': {'/data': 'rustfs-data'}} if rustfs else {})}
    volumes = set()
    initializer = None
    for name, row in services.items():
        mounts = dict(expected[name])
        for mount in row['Mounts']:
            target = mount['Destination']
            if name == 'rustfs' and target == '/logs':
                require(mount['Type'] == 'tmpfs'); continue
            if name == 'postgres' and target == '/docker-entrypoint-initdb.d/01-golf.sh':
                require(mount['Type'] == 'bind' and not mount['RW'])
                initializer = Path(mount['Source']).read_bytes()
                require(initializer == (ROOT/POSTGRES_INIT).read_bytes())
                continue
            require(target in mounts and mount['Type'] == 'volume' and mount['RW'])
            volume = docker_json('volume', 'inspect', mount['Name'])[0]
            require(volume['Driver'] == 'local' and not volume.get('Options') and
                    volume.get('Labels', {}).get('com.docker.compose.project') == project and
                    volume.get('Labels', {}).get('com.docker.compose.volume') == mounts[target])
            volumes.add(mount['Name'])
            del mounts[target]
        require(not mounts)
    require(initializer is not None)
    active = run(['docker', 'ps', '-q']).decode().split()
    if active:
        for row in docker_json('inspect', *active):
            if row['Id'] != services['postgres']['Id']:
                require(not any(mount.get('Name') in volumes for mount in row['Mounts']))
    pg = services['postgres']['Id']
    # This detects existing direct clients, not a fence against a Docker/DB
    # administrator opening another connection after the check.
    query = "SELECT count(*) FROM pg_stat_activity WHERE datname IN ('golf','forgejo') AND backend_type='client backend';"
    require(run(['docker', 'exec', pg, 'psql', '-U', 'postgres', '-d', 'postgres', '-Atc', query]).strip() == b'0')
    config = {'services': {}, 'volumes': {name: {} for name in volume_names(rustfs)}}
    for name, row in services.items():
        image = row['Image']
        require(re.fullmatch(r'sha256:[a-f0-9]{64}', image))
        env = environment(row)
        config['services'][name] = {'image': image, 'pull_policy': 'never', 'environment': env,
                                    'restart': 'no'}
    golf, forgejo, postgres = [config['services'][name] for name in ['golf', 'forgejo', 'postgres']]
    if profile == ACCESS_PROFILE and services['postgres']['Config'].get('Cmd') == ACCESS_PG_COMMAND:
        postgres['command'] = list(ACCESS_PG_COMMAND)
    require(postgres['environment'].get('POSTGRES_PASSWORD') and
            postgres['environment'].get('GOLF_DB_PASSWORD') and postgres['environment'].get('FORGEJO_DB_PASSWORD'))
    validate_forgejo_environment(forgejo['environment'], postgres['environment']['FORGEJO_DB_PASSWORD'])
    require(golf['environment'].get('GOLF_FORGE_URL') == 'http://forgejo:3000' and
            golf['environment'].get('GOLF_FORGE_KIND') == 'forgejo')
    instance = golf['environment'].get('GOLF_FORGE_INSTANCE_ID', '')
    require(re.fullmatch(r'[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}', instance))
    database = urlsplit(golf['environment'].get('DATABASE_URL', ''))
    require(database.scheme == 'postgres' and database.hostname == 'postgres' and database.port == 5432 and
            database.username == 'golf' and unquote(database.password or '') == postgres['environment']['GOLF_DB_PASSWORD'] and
            database.path == '/golf' and parse_qs(database.query) == {'sslmode': ['disable']} and not database.fragment)
    postgres.update(volumes=['postgres-data:/var/lib/postgresql',
                             './postgres-init.sh:/docker-entrypoint-initdb.d/01-golf.sh:ro'],
                    healthcheck={'test': ['CMD-SHELL', 'pg_isready -h 127.0.0.1 -U postgres'], 'interval': '2s', 'timeout': '3s', 'retries': 60})
    require(not (services['postgres']['HostConfig']['PortBindings'] or {}))
    forgejo.update(volumes=forgejo_volumes(),
                   ports=ports(services['forgejo'], ['3000/tcp', '2222/tcp']),
                   depends_on={'postgres': {'condition': 'service_healthy'}})
    golf.update(ports=ports(services['golf'], ['8080/tcp']),
                depends_on={'postgres': {'condition': 'service_healthy'}, 'forgejo': {'condition': 'service_started'}})
    if rustfs:
        config['services']['rustfs'].update(volumes=['rustfs-data:/data'], tmpfs=['/logs:'+RUSTFS_TMPFS['/logs']],
            cap_drop=['ALL'], security_opt=['no-new-privileges:true'],
            healthcheck={'test': ['CMD', 'curl', '--fail', '--silent', 'http://localhost:9000/health'], 'interval': '3s', 'timeout': '3s', 'retries': 40})
        golf['depends_on']['rustfs'] = {'condition': 'service_healthy'}
    storage_fingerprint(config)
    return services, config, initializer


def validate_volume(path, config=False, rustfs=False):
    # Validate nested tar streams without extracting onto the host. Docker cp
    # receives only this checked archive; archive links cannot escape its root.
    references = set()
    root = 'data' if rustfs else DATA_ROOT
    owners = {0, 10001} if rustfs else {0, 1000}
    with tarfile.open(path, 'r:') as archive:
        members = {}
        total = 0
        for member in archive:
            name = member.name.rstrip('/')
            parts = PurePosixPath(name).parts
            require(parts and parts[0] == root and not name.startswith('/') and
                    '..' not in parts and name == PurePosixPath(name).as_posix() and len(name) <= 4096 and
                    name not in members and len(members) < 1_000_000)
            require(member.isfile() or member.isdir() or (not rustfs and (member.issym() or member.islnk())))
            require(0 <= member.size <= path.stat().st_size and (member.isfile() or member.size == 0))
            require(member.uid in owners and member.gid in owners and member.mode & 0o7000 == 0)
            total += member.size
            require(total <= path.stat().st_size)
            members[name] = member
        require(root in members and members[root].isdir())
        links_to_files = set()
        for name, member in members.items():
            for parent in PurePosixPath(name).parents:
                if str(parent) != '.':
                    require(str(parent) in members and members[str(parent)].isdir())
            if member.issym() or member.islnk():
                require(not member.linkname.startswith('/'))
                target = member.linkname if member.islnk() else str(PurePosixPath(name).parent/member.linkname)
                stack = []
                for part in PurePosixPath(target).parts:
                    if part == '..':
                        require(len(stack) > 1); stack.pop()
                    elif part != '.':
                        stack.append(part)
                target = '/'.join(stack)
                require(target in members and (members[target].isfile() or members[target].isdir()))
                require(not member.islnk() or members[target].isfile())
                if members[target].isfile():
                    links_to_files.add(name)
                for parent in PurePosixPath(target).parents:
                    if str(parent) != '.':
                        require(str(parent) in members and members[str(parent)].isdir())
        if config:
            require(DATA_APP_INI in members and members[DATA_APP_INI].isfile())
            require(members[DATA_APP_INI].size <= 1 << 20 and members[DATA_APP_INI].mode & 0o077 == 0)
            ini = configparser.ConfigParser(interpolation=None, strict=False)
            ini.read_string('[DEFAULT]\n'+archive.extractfile(members[DATA_APP_INI]).read().decode())
            require(ini.get('database', 'DB_TYPE') == 'postgres' and ini.get('database', 'HOST') == 'postgres:5432' and
                    ini.get('database', 'NAME') == 'forgejo' and ini.get('database', 'USER') == 'forgejo')
            for section in ini.sections():
                require(ini.get(section, 'STORAGE_TYPE', fallback='local') == 'local')
                if section.startswith('storage') or section in {'lfs', 'attachment', 'repository'}:
                    for key in ['PATH', 'ROOT']:
                        value = ini.get(section, key, fallback='')
                        if value:
                            captured_path(value)
            for section, keys in {'server': ['APP_DATA_PATH', 'SSH_ROOT_PATH'],
                                  'picture': ['AVATAR_UPLOAD_PATH', 'REPOSITORY_AVATAR_UPLOAD_PATH'],
                                  'git': ['HOME_PATH']}.items():
                for key in keys:
                    value = ini.get(section, key, fallback='')
                    if value:
                        captured_path(value)
            # Native local-clone/upload scratch is the image's temporary directory,
            # outside the persistent volume. Draining writers does not preserve in-flight work.
            for section, key in [('repository.local', 'LOCAL_COPY_PATH'), ('repository.upload', 'TEMP_PATH')]:
                value = ini.get(section, key, fallback='')
                if value:
                    scratch = PurePosixPath(value)
                    require(scratch.is_absolute() and '..' not in scratch.parts and value.rstrip('/') == scratch.as_posix())
                    if scratch != FORGEJO_TEMP and FORGEJO_TEMP not in scratch.parents:
                        captured_path(value)
            for section in [ini.default_section, *ini.sections()]:
                for key, value in ini[section].items():
                    if key.upper().endswith('_URI') and value:
                        uri = urlsplit(value)
                        require(uri.scheme == 'file' and not uri.netloc and not uri.query and not uri.fragment and '%' not in uri.path)
                        captured_path(uri.path)
                        references.add(uri.path.rstrip('/'))
            for value in ini.get('server', 'SSH_SERVER_HOST_KEYS', fallback='').split(','):
                if value.strip():
                    captured_path(value.strip())
                    references.add(value.strip().rstrip('/'))
        base = FORGEJO_DATA.parent
        files = {str(base/name) for name, member in members.items()
                 if member.isfile() or name in links_to_files}
        return files, references


def validate_forgejo_data(stage):
    # app.ini lives inside the single data volume; every file it references must too.
    files, references = validate_volume(stage/'forgejo-data.tar', config=True)
    require(references <= files)


def backup(args, stage):
    require(not args.output.exists() and not args.output.is_symlink() and args.output.parent.is_dir())
    compose_files = [file.resolve() for file in args.compose_file]
    services, config, initializer = snapshot(args.project, compose_files, args.profile)
    rustfs = 'rustfs' in services
    files = profile_files(rustfs)
    pg = services['postgres']['Id']
    pg_version = run(['docker', 'exec', pg, 'postgres', '--version']).decode().strip()
    forge_version = run(['docker', 'run', '--rm', '--network', 'none', '--entrypoint', 'forgejo',
                         services['forgejo']['Image'], '--version']).decode().strip()
    schema = run(['docker', 'exec', pg, 'psql', '-U', 'postgres', '-d', 'golf', '-Atc',
                  'SELECT max(version_id) FROM goose_db_version WHERE is_applied;']).decode().strip()
    require(pg_version == 'postgres (PostgreSQL) 18.4' and forge_version.startswith(FORGEJO_VERSION) and
            (schema in SUPPORTED_SCHEMAS or schema == ACCESS_SCHEMA))
    validate_profile(schema, args.profile)
    observation = access_profile_observation(pg, config) if args.profile else None
    key_inventory = None
    if args.profile:
        compose = ['docker', 'compose', '-p', args.project]
        for file in compose_files:
            compose += ['-f', str(file)]
        key_inventory = access_key_status(compose)
    validate_source_bindings(pg, config, schema)
    write(stage/'compose.json', json.dumps(config).encode())
    write(stage/'postgres-init.sh', initializer)
    for name in ['golf', 'forgejo']:
        run(['docker', 'exec', services['postgres']['Id'], 'pg_dump', '-Fc', '--no-owner', '--no-acl',
             '-U', 'postgres', '-d', name], output=stage/(name+'.dump'), limit=args.max_bytes)
    run(['docker', 'cp', '-a', services['forgejo']['Id']+':'+str(FORGEJO_DATA), '-'],
        output=stage/'forgejo-data.tar', limit=args.max_bytes)
    if rustfs:
        run(['docker', 'cp', '-a', services['rustfs']['Id']+':/data', '-'], output=stage/'rustfs-data.tar', limit=args.max_bytes)
        validate_volume(stage/'rustfs-data.tar', rustfs=True)
    validate_forgejo_data(stage)
    if args.profile:
        validate_access_archive(stage)
    # Revalidate ordinary writer/container state and runtime configuration after
    # all components; the explicit drained-writers assertion remains required.
    after, after_config, after_init = snapshot(args.project, compose_files, args.profile)
    require(config == after_config and initializer == after_init and
            all(after[name]['Id'] == row['Id'] for name, row in services.items()))
    if args.profile:
        require(access_profile_observation(pg, config) == observation)
    sizes = {name: {'bytes': (stage/name).stat().st_size, 'sha256': digest(stage/name)} for name in files}
    total = sum(row['bytes'] for row in sizes.values())
    require(total <= args.max_bytes)
    manifest = {'schema_version': FORMAT, 'backup_id': uuid.uuid4().hex,
                'created_at': datetime.now(timezone.utc).isoformat(), 'source_project': args.project,
                'versions': {'postgres': pg_version, 'forgejo': forge_version, 'golf_schema': schema},
                'images': {name: row['Image'] for name, row in services.items()}, 'files': sizes}
    if args.profile:
        manifest['recovery_profile'] = args.profile
        manifest['profile_observation'] = observation
        manifest['key_inventory'] = key_inventory
    if rustfs:
        manifest['storage_profile'] = 'local_rustfs'
    write(stage/'manifest.json', json.dumps(manifest, sort_keys=True).encode())
    with tarfile.open(stage/'bundle.tar', 'w:') as archive:
        for name in sorted(files | {'manifest.json'}):
            archive.add(stage/name, arcname=name, recursive=False)
    descriptor, temporary = tempfile.mkstemp(prefix='.golf-backup-', dir=args.output.parent)
    os.close(descriptor); os.unlink(temporary)
    try:
        with (stage/'bundle.tar').open('rb') as file:
            run(['age', '-r', args.recipient], input=file, output=Path(temporary), limit=envelope_limit(args.max_bytes))
        os.link(temporary, args.output)  # Atomic publication, never overwrite.
    finally:
        Path(temporary).unlink(missing_ok=True)
    return {'backup_id': manifest['backup_id'], 'plaintext_bytes': total, 'encrypted_sha256': digest(args.output)}


def verified(args, stage):
    private_file(args.identity)
    require(args.input.is_file() and not args.input.is_symlink() and args.input.stat().st_size <= envelope_limit(args.max_bytes))
    with args.input.open('rb') as file:
        run(['age', '-d', '-i', str(args.identity)], input=file, output=stage/'bundle.tar', limit=args.max_bytes+(1 << 20))
    # Wait for final age authentication before inspecting any plaintext.
    found = set()
    total = 0
    with tarfile.open(stage/'bundle.tar', 'r:') as archive:
        for member in archive:
            require(member.name in profile_files(True) | {'manifest.json'} and member.name not in found and member.isfile())
            require(member.size >= 0 and (member.name != 'manifest.json' or member.size <= 1 << 20))
            total += member.size
            require(total <= args.max_bytes+(1 << 20))
            with os.fdopen(os.open(stage/member.name, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), 'wb') as file:
                shutil.copyfileobj(archive.extractfile(member), file, 1 << 20)
            found.add(member.name)
    manifest = json.loads((stage/'manifest.json').read_text())
    rustfs = manifest.get('storage_profile') == 'local_rustfs'
    require('storage_profile' not in manifest or rustfs)
    files = profile_files(rustfs)
    services = {'postgres', 'forgejo', 'golf'} | ({'rustfs'} if rustfs else set())
    require(found == files | {'manifest.json'})
    require(manifest['schema_version'] == FORMAT and re.fullmatch('[a-f0-9]{32}', manifest['backup_id']) and
            set(manifest['files']) == files and set(manifest['images']) == services)
    require(manifest['versions']['postgres'] == 'postgres (PostgreSQL) 18.4' and
            set(manifest['versions']) == {'postgres', 'forgejo', 'golf_schema'} and
            manifest['versions']['forgejo'].startswith(FORGEJO_VERSION) and
            (manifest['versions']['golf_schema'] in SUPPORTED_SCHEMAS or manifest['versions']['golf_schema'] == ACCESS_SCHEMA))
    validate_profile(manifest['versions']['golf_schema'], manifest.get('recovery_profile'))
    if manifest.get('recovery_profile'):
        validate_access_counts(manifest.get('profile_observation'))
        checked_key_status(manifest.get('key_inventory'))
    else:
        require('profile_observation' not in manifest and 'key_inventory' not in manifest)
    for name in files:
        require(manifest['files'][name] == {'bytes': (stage/name).stat().st_size, 'sha256': digest(stage/name)})
    require(sum(row['bytes'] for row in manifest['files'].values()) <= args.max_bytes)
    require((stage/'postgres-init.sh').read_bytes() == (ROOT/POSTGRES_INIT).read_bytes())
    validate_forgejo_data(stage)
    if rustfs:
        validate_volume(stage/'rustfs-data.tar', rustfs=True)
    config = json.loads((stage/'compose.json').read_text())
    # This is an operator-trusted archive, not arbitrary uploaded Compose/SQL.
    # Still reject extra services, host mounts, privilege and substituted images.
    require(set(config) == {'services', 'volumes'} and set(config['services']) == services and
            config['volumes'] == {name: {} for name in volume_names(rustfs)})
    for name, service in config['services'].items():
        require(service['image'] == manifest['images'][name] and re.fullmatch(r'sha256:[a-f0-9]{64}', service['image']))
        require(set(service) <= {'image', 'pull_policy', 'environment', 'restart', 'volumes', 'ports', 'depends_on', 'healthcheck'} | ({'command'} if name == 'postgres' and manifest.get('recovery_profile') == ACCESS_PROFILE else set()) | ({'tmpfs', 'cap_drop', 'security_opt'} if name == 'rustfs' else set()))
        require(service['pull_policy'] == 'never' and service['restart'] == 'no' and isinstance(service['environment'], dict))
        require(all(isinstance(key, str) and isinstance(value, str) for key, value in service['environment'].items()))
    require('command' not in config['services']['postgres'] or config['services']['postgres']['command'] == ACCESS_PG_COMMAND)
    require(config['services']['postgres']['volumes'] == ['postgres-data:/var/lib/postgresql', './postgres-init.sh:/docker-entrypoint-initdb.d/01-golf.sh:ro'])
    require(config['services']['forgejo']['volumes'] == forgejo_volumes())
    require('volumes' not in config['services']['golf'])
    password = config['services']['postgres']['environment'].get('FORGEJO_DB_PASSWORD')
    require(password)
    validate_forgejo_environment(config['services']['forgejo']['environment'], password)
    require(config['services']['golf']['environment'].get('GOLF_FORGE_URL') == 'http://forgejo:3000' and
            config['services']['golf']['environment'].get('GOLF_FORGE_KIND') == 'forgejo')
    if rustfs:
        service = config['services']['rustfs']
        require(service['volumes'] == ['rustfs-data:/data'] and not service.get('ports') and
                service.get('tmpfs') == ['/logs:'+RUSTFS_TMPFS['/logs']] and service.get('cap_drop') == ['ALL'] and
                service.get('security_opt') == ['no-new-privileges:true'] and
                service['image'] == docker_json('image', 'inspect', RUSTFS_IMAGE)[0]['Id'])
    storage_fingerprint(config)
    if manifest.get('recovery_profile'):
        validate_access_archive(stage)
        validate_access_config(config)
        require(all(not service.get('extra_hosts') for service in config['services'].values()))
    return manifest


def fresh(project):
    require(not containers(project))
    require(not run(['docker', 'volume', 'ls', '-q', '--filter', 'label=com.docker.compose.project='+project]).strip())
    require(not run(['docker', 'network', 'ls', '-q', '--filter', 'label=com.docker.compose.project='+project]).strip())
    for name in volume_names(True):
        require(not run(['docker', 'volume', 'ls', '-q', '--filter', 'name=^'+project+'_'+name+'$']).strip())
    require(not run(['docker', 'network', 'ls', '-q', '--filter', 'name=^'+project+'_default$']).strip())


def restore(args, stage, manifest):
    fresh(args.project)
    require(not args.directory.exists())
    for image in manifest['images'].values():
        require(docker_json('image', 'inspect', image)[0]['Id'] == image)
    args.directory.mkdir(mode=0o700)
    write(args.directory/'compose.json', compose_bytes(json.loads((stage/'compose.json').read_text())))
    for name in ['postgres-init.sh', 'manifest.json']:
        write(args.directory/name, (stage/name).read_bytes())
    os.chmod(args.directory/'postgres-init.sh', 0o755)  # No literal secrets; PostgreSQL's OS user must read it.
    compose = ['docker', 'compose', '-p', args.project, '-f', str(args.directory/'compose.json')]
    run([*compose, 'create', '--pull', 'never'])
    rows = {row['Config']['Labels']['com.docker.compose.service']: row for row in containers(args.project)}
    require(set(rows) == set(manifest['images']) and not any(row['State']['Running'] for row in rows.values()))
    run([*compose, 'start', 'postgres'])
    deadline = time.monotonic()+90
    while time.monotonic() < deadline:
        row = docker_json('inspect', rows['postgres']['Id'])[0]
        if row['State'].get('Health', {}).get('Status') == 'healthy':
            break
        time.sleep(1)
    else:
        raise TimeoutError('Database startup failed')
    for name in ['golf', 'forgejo']:
        with (stage/(name+'.dump')).open('rb') as file:
            run(['docker', 'exec', '-i', rows['postgres']['Id'], 'pg_restore', '--no-owner', '--no-acl', '--role='+name,
                 '--single-transaction', '--exit-on-error', '-U', 'postgres', '-d', name], input=file)
    schema = run(['docker', 'exec', rows['postgres']['Id'], 'psql', '-U', 'postgres', '-d', 'golf', '-Atc',
                  'SELECT max(version_id) FROM goose_db_version WHERE is_applied;']).decode().strip()
    require(schema == manifest['versions']['golf_schema'])
    if manifest.get('recovery_profile'):
        require(access_profile_observation(rows['postgres']['Id'], json.loads((stage/'compose.json').read_text())) == manifest['profile_observation'])
    with (stage/'forgejo-data.tar').open('rb') as file:
        run(['docker', 'cp', '-a', '-', rows['forgejo']['Id']+':'+str(FORGEJO_DATA.parent)], input=file)
    validate_source_bindings(rows['postgres']['Id'], json.loads((stage/'compose.json').read_text()), schema)
    if 'rustfs' in rows:
        with (stage/'rustfs-data.tar').open('rb') as file:
            run(['docker', 'cp', '-a', '-', rows['rustfs']['Id']+':/'], input=file)
    if manifest.get('recovery_profile'):
        require(access_key_status(compose) == manifest['key_inventory'])
    recovery = json.loads(run([*compose, 'run', '--rm', '--no-deps', '-T', 'golf', 'recovery', 'invalidate-sessions',
                              '--backup-id', manifest['backup_id']]))
    require(recovery['schema_version'] == 'golf.recovery.v1' and recovery['state'] == 'complete')
    require(not any(row['State']['Running'] for row in containers(args.project)
                    if row['Config']['Labels'].get('com.docker.compose.service') in {'golf', 'forgejo', 'rustfs'}))
    return {'backup_id': manifest['backup_id'], 'compose_file': str(args.directory/'compose.json'),
            'sessions_count': recovery['result']['sessions_count'],
            'oauth_attempts_count': recovery['result']['oauth_attempts_count'],
            'local_accounts_disabled_count': recovery['result']['local_accounts_disabled_count']}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest='action', required=True)
    for name in ['backup', 'verify', 'restore']:
        command = commands.add_parser(name)
        command.add_argument('--max-bytes', type=int, default=LIMIT, help='Maximum plaintext payload bytes (default 8 GiB)')
        if name in {'backup', 'restore'}:
            command.add_argument('--project', required=True)
            command.add_argument('--writers-drained', action='store_true', required=True,
                                 help='Assert ALL application, Git and direct DB writers are fenced/drained')
        if name == 'backup':
            command.add_argument('--profile', choices=[ACCESS_PROFILE], help='Explicit bounded schema059 Access-core profile; no other feature recovery is implied')
            command.add_argument('--compose-file', required=True, type=Path, action='append', help='Repeat for every source Compose file in runtime order')
            command.add_argument('--recipient', required=True, help='Public native age recipient')
            command.add_argument('--output', required=True, type=Path)
        else:
            command.add_argument('--input', required=True, type=Path)
            command.add_argument('--identity', required=True, type=Path, help='Private operator age identity file')
        if name == 'restore':
            command.add_argument('--directory', required=True, type=Path, help='New private recovery directory')
    args = parser.parse_args()
    result = {'schema_version': FORMAT, 'action': args.action, 'state': 'failed'}
    try:
        require(1 << 20 <= args.max_bytes <= 1 << 40)
        if args.action != 'verify':
            require(PROJECT.fullmatch(args.project))
        if args.action == 'backup':
            require(all(file.is_file() for file in args.compose_file) and re.fullmatch(r'age1[0-9a-z]{58}', args.recipient))
            args.output = args.output.absolute()
        if args.action == 'restore':
            args.directory = args.directory.resolve()
        with tempfile.TemporaryDirectory(prefix='golf-recovery-') as directory:
            stage = Path(directory); os.chmod(stage, 0o700)
            if args.action == 'backup':
                value = backup(args, stage)
            else:
                manifest = verified(args, stage)
                value = restore(args, stage, manifest) if args.action == 'restore' else {
                    'backup_id': manifest['backup_id'], 'images': manifest['images'],
                    'plaintext_bytes': sum(row['bytes'] for row in manifest['files'].values())}
        result.update(state='quarantined' if args.action == 'restore' else 'complete', result=value)
        print(json.dumps(result)); return 0
    except (Exception, KeyboardInterrupt):
        result['error'] = 'Recovery failed; no application startup was requested and diagnostics are withheld.'
        print(json.dumps(result)); return 1


if __name__ == '__main__':
    raise SystemExit(main())
