#!/usr/bin/env python3
"""Encrypted, offline recovery for Golf's canonical three-service Docker profile.

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
FILES = {'compose.json', 'postgres-init.sh', 'golf.dump', 'gitea.dump',
         'gitea-data.tar', 'gitea-config.tar'}
PROJECT = re.compile(r'^[a-z0-9][a-z0-9_-]{0,62}$')
LIMIT = 8 << 30


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
            (path == PurePosixPath('/var/lib/gitea') or PurePosixPath('/var/lib/gitea') in path.parents or
             path == PurePosixPath('/etc/gitea') or PurePosixPath('/etc/gitea') in path.parents))


def compose_bytes(config):
    # Compose interpolates even JSON environment values. $$ is its documented
    # literal-dollar escape; preserve the archived runtime values exactly.
    config = json.loads(json.dumps(config))
    for service in config['services'].values():
        service['environment'] = {key: value.replace('$', '$$') for key, value in service['environment'].items()}
    return json.dumps(config).encode()


def snapshot(project, compose_file):
    rows = containers(project)
    require(len(rows) == 3)
    services = {row['Config']['Labels'].get('com.docker.compose.service'): row for row in rows}
    require(set(services) == {'golf', 'gitea', 'postgres'})
    for row in rows:
        labels = row['Config']['Labels']
        require(labels.get('com.docker.compose.oneoff') == 'False' and
                labels.get('com.docker.compose.project.config_files') == str(compose_file))
        require(not row['HostConfig']['Privileged'] and not row['HostConfig']['NetworkMode'].startswith('host'))
        image_config = docker_json('image', 'inspect', row['Image'])[0]['Config']
        require(all((row['Config'].get(key) or None) == (image_config.get(key) or None)
                    for key in ['Entrypoint', 'Cmd', 'User', 'WorkingDir']))
        host = row['HostConfig']
        require(host['RestartPolicy']['Name'] in {'', 'no'} and
                not any(host.get(key) for key in ['Memory', 'NanoCpus', 'CpuShares', 'CapAdd', 'CapDrop',
                                                'SecurityOpt', 'DeviceRequests', 'ReadonlyRootfs', 'ExtraHosts']))
        require(len(row['NetworkSettings']['Networks']) == 1)
    require(services['postgres']['State']['Running'])
    require(all(services[name]['State']['Status'] in {'exited', 'created'} for name in ['golf', 'gitea']))
    require(services['gitea']['Config']['User'] == '1000:1000')
    expected = {'postgres': {'/var/lib/postgresql': 'postgres-data'},
                'gitea': {'/var/lib/gitea': 'gitea-data', '/etc/gitea': 'gitea-config'}, 'golf': {}}
    volumes = set()
    initializer = None
    for name, row in services.items():
        mounts = dict(expected[name])
        for mount in row['Mounts']:
            target = mount['Destination']
            if name == 'postgres' and target == '/docker-entrypoint-initdb.d/01-golf.sh':
                require(mount['Type'] == 'bind' and not mount['RW'])
                initializer = Path(mount['Source']).read_bytes()
                require(initializer == (ROOT/'deploy/postgres/init.sh').read_bytes())
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
    query = "SELECT count(*) FROM pg_stat_activity WHERE datname IN ('golf','gitea') AND backend_type='client backend';"
    require(run(['docker', 'exec', pg, 'psql', '-U', 'postgres', '-d', 'postgres', '-Atc', query]).strip() == b'0')
    config = {'services': {}, 'volumes': {name: {} for name in ['postgres-data', 'gitea-data', 'gitea-config']}}
    for name, row in services.items():
        image = row['Image']
        require(re.fullmatch(r'sha256:[a-f0-9]{64}', image))
        env = environment(row)
        config['services'][name] = {'image': image, 'pull_policy': 'never', 'environment': env,
                                    'restart': 'no'}
    golf, gitea, postgres = [config['services'][name] for name in ['golf', 'gitea', 'postgres']]
    require(postgres['environment'].get('POSTGRES_PASSWORD') and
            postgres['environment'].get('GOLF_DB_PASSWORD') and postgres['environment'].get('GITEA_DB_PASSWORD'))
    require(gitea['environment'].get('GITEA__database__HOST') == 'postgres:5432' and
            gitea['environment'].get('GITEA__database__NAME') == 'gitea' and
            gitea['environment'].get('GITEA__database__USER') == 'gitea' and
            gitea['environment'].get('GITEA__database__PASSWD') == postgres['environment']['GITEA_DB_PASSWORD'])
    require(gitea['environment'].get('HOME') == '/var/lib/gitea/git')
    for key in ['GITEA_WORK_DIR', 'GITEA_CUSTOM', 'GITEA_APP_INI']:
        if gitea['environment'].get(key):
            captured_path(gitea['environment'][key])
    require(golf['environment'].get('GITEA_URL') == 'http://gitea:3000')
    database = urlsplit(golf['environment'].get('DATABASE_URL', ''))
    require(database.scheme == 'postgres' and database.hostname == 'postgres' and database.port == 5432 and
            database.username == 'golf' and unquote(database.password or '') == postgres['environment']['GOLF_DB_PASSWORD'] and
            database.path == '/golf' and parse_qs(database.query) == {'sslmode': ['disable']} and not database.fragment)
    postgres.update(volumes=['postgres-data:/var/lib/postgresql',
                             './postgres-init.sh:/docker-entrypoint-initdb.d/01-golf.sh:ro'],
                    healthcheck={'test': ['CMD-SHELL', 'pg_isready -h 127.0.0.1 -U postgres'], 'interval': '2s', 'timeout': '3s', 'retries': 60})
    require(not (services['postgres']['HostConfig']['PortBindings'] or {}))
    gitea.update(volumes=['gitea-data:/var/lib/gitea', 'gitea-config:/etc/gitea'],
                  ports=ports(services['gitea'], ['3000/tcp', '2222/tcp']),
                  depends_on={'postgres': {'condition': 'service_healthy'}})
    golf.update(ports=ports(services['golf'], ['8080/tcp']),
                depends_on={'postgres': {'condition': 'service_healthy'}, 'gitea': {'condition': 'service_started'}})
    return services, config, initializer


def validate_volume(path, config=False):
    # Validate nested tar streams without extracting onto the host. Docker cp
    # receives only this checked archive; archive links cannot escape its root.
    references = set()
    with tarfile.open(path, 'r:') as archive:
        members = {}
        total = 0
        for member in archive:
            name = member.name.rstrip('/')
            parts = PurePosixPath(name).parts
            require(parts and parts[0] == 'gitea' and not name.startswith('/') and
                    '..' not in parts and name == PurePosixPath(name).as_posix() and len(name) <= 4096 and
                    name not in members and len(members) < 1_000_000)
            require(member.isfile() or member.isdir() or member.issym() or member.islnk())
            require(0 <= member.size <= path.stat().st_size and (member.isfile() or member.size == 0))
            require(member.uid in {0, 1000} and member.gid in {0, 1000} and member.mode & 0o7000 == 0)
            total += member.size
            require(total <= path.stat().st_size)
            members[name] = member
        require('gitea' in members and members['gitea'].isdir())
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
            require('gitea/app.ini' in members and members['gitea/app.ini'].isfile())
            require(members['gitea/app.ini'].size <= 1 << 20 and members['gitea/app.ini'].mode & 0o077 == 0)
            ini = configparser.ConfigParser(interpolation=None, strict=False)
            ini.read_string('[DEFAULT]\n'+archive.extractfile(members['gitea/app.ini']).read().decode())
            require(ini.get('database', 'DB_TYPE') == 'postgres' and ini.get('database', 'HOST') == 'postgres:5432' and
                    ini.get('database', 'NAME') == 'gitea' and ini.get('database', 'USER') == 'gitea')
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
            # Native local-clone/upload scratch is outside persistent volumes
            # in this image. Draining writers does not preserve in-flight work.
            for section, key in [('repository.local', 'LOCAL_COPY_PATH'), ('repository.upload', 'TEMP_PATH')]:
                value = ini.get(section, key, fallback='')
                if value:
                    scratch = PurePosixPath(value)
                    require(scratch.is_absolute() and '..' not in scratch.parts and value.rstrip('/') == scratch.as_posix())
                    if scratch != PurePosixPath('/tmp/gitea') and PurePosixPath('/tmp/gitea') not in scratch.parents:
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
        base = PurePosixPath('/etc' if config else '/var/lib')
        files = {str(base/name) for name, member in members.items()
                 if member.isfile() or name in links_to_files}
        return files, references


def validate_pair(stage):
    data_files, data_references = validate_volume(stage/'gitea-data.tar')
    config_files, config_references = validate_volume(stage/'gitea-config.tar', config=True)
    require((data_references | config_references) <= (data_files | config_files))


def backup(args, stage):
    require(not args.output.exists() and not args.output.is_symlink() and args.output.parent.is_dir())
    services, config, initializer = snapshot(args.project, args.compose_file.resolve())
    pg = services['postgres']['Id']
    pg_version = run(['docker', 'exec', pg, 'postgres', '--version']).decode().strip()
    forge_version = run(['docker', 'run', '--rm', '--network', 'none', '--entrypoint', 'gitea',
                         services['gitea']['Image'], '--version']).decode().strip()
    schema = run(['docker', 'exec', pg, 'psql', '-U', 'postgres', '-d', 'golf', '-Atc',
                  'SELECT max(version_id) FROM goose_db_version WHERE is_applied;']).decode().strip()
    require(pg_version == 'postgres (PostgreSQL) 18.4' and forge_version.startswith('gitea version 1.27.3 ') and
            schema == '202610020008')
    write(stage/'compose.json', json.dumps(config).encode())
    write(stage/'postgres-init.sh', initializer)
    for name in ['golf', 'gitea']:
        run(['docker', 'exec', services['postgres']['Id'], 'pg_dump', '-Fc', '--no-owner', '--no-acl',
             '-U', 'postgres', '-d', name], output=stage/(name+'.dump'), limit=args.max_bytes)
    for name, directory in [('gitea-data.tar', '/var/lib/gitea'), ('gitea-config.tar', '/etc/gitea')]:
        run(['docker', 'cp', '-a', services['gitea']['Id']+':'+directory, '-'], output=stage/name, limit=args.max_bytes)
    validate_pair(stage)
    # Revalidate ordinary writer/container state and runtime configuration after
    # all components; the explicit drained-writers assertion remains required.
    after, after_config, after_init = snapshot(args.project, args.compose_file.resolve())
    require(config == after_config and initializer == after_init and
            all(after[name]['Id'] == row['Id'] for name, row in services.items()))
    sizes = {name: {'bytes': (stage/name).stat().st_size, 'sha256': digest(stage/name)} for name in FILES}
    total = sum(row['bytes'] for row in sizes.values())
    require(total <= args.max_bytes)
    manifest = {'schema_version': FORMAT, 'backup_id': uuid.uuid4().hex,
                'created_at': datetime.now(timezone.utc).isoformat(), 'source_project': args.project,
                'versions': {'postgres': pg_version, 'gitea': forge_version, 'golf_schema': schema},
                'images': {name: row['Image'] for name, row in services.items()}, 'files': sizes}
    write(stage/'manifest.json', json.dumps(manifest, sort_keys=True).encode())
    with tarfile.open(stage/'bundle.tar', 'w:') as archive:
        for name in sorted(FILES | {'manifest.json'}):
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
            require(member.name in FILES | {'manifest.json'} and member.name not in found and member.isfile())
            require(member.size >= 0 and (member.name != 'manifest.json' or member.size <= 1 << 20))
            total += member.size
            require(total <= args.max_bytes+(1 << 20))
            with os.fdopen(os.open(stage/member.name, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), 'wb') as file:
                shutil.copyfileobj(archive.extractfile(member), file, 1 << 20)
            found.add(member.name)
    require(found == FILES | {'manifest.json'})
    manifest = json.loads((stage/'manifest.json').read_text())
    require(manifest['schema_version'] == FORMAT and re.fullmatch('[a-f0-9]{32}', manifest['backup_id']) and
            set(manifest['files']) == FILES and set(manifest['images']) == {'postgres', 'gitea', 'golf'})
    require(manifest['versions']['postgres'] == 'postgres (PostgreSQL) 18.4' and
            manifest['versions']['gitea'].startswith('gitea version 1.27.3 ') and
            manifest['versions']['golf_schema'] == '202610020008')
    for name in FILES:
        require(manifest['files'][name] == {'bytes': (stage/name).stat().st_size, 'sha256': digest(stage/name)})
    require(sum(row['bytes'] for row in manifest['files'].values()) <= args.max_bytes)
    require((stage/'postgres-init.sh').read_bytes() == (ROOT/'deploy/postgres/init.sh').read_bytes())
    validate_pair(stage)
    config = json.loads((stage/'compose.json').read_text())
    # This is an operator-trusted archive, not arbitrary uploaded Compose/SQL.
    # Still reject extra services, host mounts, privilege and substituted images.
    require(set(config) == {'services', 'volumes'} and set(config['services']) == {'postgres', 'gitea', 'golf'} and
            config['volumes'] == {name: {} for name in ['postgres-data', 'gitea-data', 'gitea-config']})
    for name, service in config['services'].items():
        require(service['image'] == manifest['images'][name] and re.fullmatch(r'sha256:[a-f0-9]{64}', service['image']))
        require(set(service) <= {'image', 'pull_policy', 'environment', 'restart', 'volumes', 'ports', 'depends_on', 'healthcheck'})
        require(service['pull_policy'] == 'never' and service['restart'] == 'no' and isinstance(service['environment'], dict))
        require(all(isinstance(key, str) and isinstance(value, str) for key, value in service['environment'].items()))
    require(config['services']['postgres']['volumes'] == ['postgres-data:/var/lib/postgresql', './postgres-init.sh:/docker-entrypoint-initdb.d/01-golf.sh:ro'])
    require(config['services']['gitea']['volumes'] == ['gitea-data:/var/lib/gitea', 'gitea-config:/etc/gitea'])
    require('volumes' not in config['services']['golf'])
    return manifest


def fresh(project):
    require(not containers(project))
    require(not run(['docker', 'volume', 'ls', '-q', '--filter', 'label=com.docker.compose.project='+project]).strip())
    require(not run(['docker', 'network', 'ls', '-q', '--filter', 'label=com.docker.compose.project='+project]).strip())
    for name in ['postgres-data', 'gitea-data', 'gitea-config']:
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
    require(set(rows) == {'postgres', 'gitea', 'golf'} and not any(row['State']['Running'] for row in rows.values()))
    run([*compose, 'start', 'postgres'])
    deadline = time.monotonic()+90
    while time.monotonic() < deadline:
        row = docker_json('inspect', rows['postgres']['Id'])[0]
        if row['State'].get('Health', {}).get('Status') == 'healthy':
            break
        time.sleep(1)
    else:
        raise TimeoutError('Database startup failed')
    for name in ['golf', 'gitea']:
        with (stage/(name+'.dump')).open('rb') as file:
            run(['docker', 'exec', '-i', rows['postgres']['Id'], 'pg_restore', '--no-owner', '--no-acl', '--role='+name,
                 '--single-transaction', '--exit-on-error', '-U', 'postgres', '-d', name], input=file)
    for name, destination in [('gitea-data.tar', '/var/lib'), ('gitea-config.tar', '/etc')]:
        with (stage/name).open('rb') as file:
            run(['docker', 'cp', '-a', '-', rows['gitea']['Id']+':'+destination], input=file)
    recovery = json.loads(run([*compose, 'run', '--rm', '--no-deps', '-T', 'golf', 'recovery', 'invalidate-sessions',
                              '--backup-id', manifest['backup_id']]))
    require(recovery['schema_version'] == 'golf.recovery.v1' and recovery['state'] == 'complete')
    require(not any(row['State']['Running'] for row in containers(args.project)
                    if row['Config']['Labels'].get('com.docker.compose.service') in {'golf', 'gitea'}))
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
            command.add_argument('--compose-file', required=True, type=Path)
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
            require(args.compose_file.is_file() and re.fullmatch(r'age1[0-9a-z]{58}', args.recipient))
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
