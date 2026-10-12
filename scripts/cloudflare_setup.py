#!/usr/bin/env python3
"""Prepare and operate an independent Cloudflare migration-bridge installation."""
import argparse
import base64
import json
import os
from pathlib import Path
import re
import secrets
import signal
import stat
import subprocess
import sys
import tempfile

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_DIRECTORY = ROOT / '.cloudflare/install'
IMAGE = 'alpine:3.23@sha256:85fe1e81d6758c208f3e1eed4338a1997e19d4be002d4dd32d3100c9a8c010a0'
OPTIONAL = {'agents': 'compose.agents.yaml', 'email': 'compose.email.yaml',
            'webhooks': 'compose.webhooks.yaml', 'remote-actions': 'compose.actions-remote.yaml',
            'managed-git': 'compose.managed-git.yaml'}


def stop_owned_image_uploads(account, tags, proc=Path('/proc')):
    """The CF CLI can detach Docker from its process group; fence exact owned tags."""
    if not re.fullmatch('[a-f0-9]{32}', account) or any(not re.fullmatch(r'[a-z0-9-]+:[a-z0-9._-]+', tag) for tag in tags):
        raise ValueError('Explicit account and owned image tags required')
    targets = {('registry.cloudflare.com/' + account + '/' + tag).encode() for tag in tags}
    stopped = []
    for path in proc.iterdir():
        if not path.name.isdigit(): continue
        descriptor = None
        try:
            descriptor = os.pidfd_open(int(path.name))
            args = (path/'cmdline').read_bytes().split(b'\0')
            if path.stat().st_uid == os.getuid() and len(args) == 4 and Path(os.fsdecode(args[0])).name == 'docker' and args[1] == b'push' and args[2] in targets and args[3] == b'':
                signal.pidfd_send_signal(descriptor, signal.SIGKILL)
                stopped.append(int(path.name))
        except (FileNotFoundError, ProcessLookupError, PermissionError): pass
        finally:
            if descriptor is not None: os.close(descriptor)
    return stopped


def hostname(value):
    if len(value) > 253 or '.' not in value or any(not re.fullmatch(r'[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?', label)
                                                for label in value.split('.')):
        raise ValueError('Use a canonical DNS hostname without a scheme or path')
    return value


def private_write(path, value, mode=0o600):
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, mode)
    with os.fdopen(fd, 'w') as out:
        out.write(value)


def replace_private_json(path, value):
    path = Path(path)
    fd, temporary = tempfile.mkstemp(prefix=path.name + '-', dir=path.parent)
    try:
        with os.fdopen(fd, 'w') as out:
            json.dump(value, out, indent=2); out.write('\n'); out.flush(); os.fsync(out.fileno())
        os.replace(temporary, path)
    finally:
        Path(temporary).unlink(missing_ok=True)


def private_directory(directory):
    info = directory.lstat()
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077:
        raise ValueError('Installation directory must be owned by this user and mode 0700')


def private_read(path):
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(fd) as source:
        info = os.fstat(source.fileno())
        if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077 or info.st_size > 65536:
            raise ValueError('Configuration must be a private regular file under 64 KiB')
        return source.read()


def clean_environment():
    # Compose shell variables otherwise override even an explicitly selected env file.
    return {key: value for key, value in os.environ.items() if not key.startswith(
        ('GOLF_', 'GITEA_', 'POSTGRES_', 'COMPOSE_', 'RUSTFS_', 'AWS_', 'OTEL_')) and key != 'DATABASE_URL'}


def initialize(directory, account, public_host, bridge_host, bucket, components):
    if any(char in str(directory) for char in "'\r\n"):
        raise ValueError('Installation paths cannot contain quotes or line breaks')
    hostname(public_host)
    hostname(bridge_host)
    if public_host == bridge_host or not re.fullmatch('[a-f0-9]{32}', account):
        raise ValueError('Use distinct public/bridge hosts and a Cloudflare account ID')
    if not re.fullmatch(r'[a-z0-9][a-z0-9-]{1,61}[a-z0-9]', bucket):
        raise ValueError('Use a canonical R2 bucket name')
    if set(components) - OPTIONAL.keys():
        raise ValueError('Unsupported bridge component')
    # Refuse an existing target instead of rotating live database/encryption keys.
    directory.parent.mkdir(parents=True, exist_ok=True)
    directory.mkdir(mode=0o700)
    values = {key: secrets.token_hex(24) for key in ('POSTGRES_PASSWORD', 'GOLF_DB_PASSWORD', 'GITEA_DB_PASSWORD')}
    runner_key = secrets.token_urlsafe(32)
    values.update({
        'GOLF_ENCRYPTION_KEY': base64.b64encode(secrets.token_bytes(32)).decode(),
        'GOLF_PUBLIC_URL': 'https://' + public_host, 'GOLF_ALLOW_INSECURE_COOKIES': 'false',
        'GOLF_RUNNER_KEY': runner_key, 'GOLF_RUNNER_KEYS': json.dumps({'local-docker': runner_key}),
        'GOLF_RUNNER_IMAGES': json.dumps({'linux': IMAGE}), 'GOLF_RUNNER_JOB_IMAGE': IMAGE,
        'GOLF_RUNNER_APPROVED_IMAGES': json.dumps([IMAGE]),
        'GOLF_INTERNAL_TLS_LISTEN_ADDR': ':8443',
        'GOLF_INTERNAL_TLS_CERT_FILE': str(directory / 'origin.crt'),
        'GOLF_INTERNAL_TLS_KEY_FILE': str(directory / 'origin.key'),
        'GOLF_RUNNER_TLS_CA_FILE': str(directory / 'origin.crt'),
        'GOLF_RUNNER_TLS_URL': 'https://localhost:8443',
        'GOLF_OBJECT_ENDPOINT': f'https://{account}.r2.cloudflarestorage.com',
        'GOLF_OBJECT_BUCKET': bucket, 'GOLF_OBJECT_PREFIX': 'golf', 'GOLF_OBJECT_REGION': 'auto',
        'GOLF_OBJECT_PATH_STYLE': 'true', 'GOLF_OBJECT_ALLOW_HTTP': 'false',
        'GOLF_OBJECT_ACCESS_KEY_ID': '', 'GOLF_OBJECT_SECRET_ACCESS_KEY': '',
        'GOLF_TUNNEL_TOKEN_FILE': str(directory / 'tunnel-token'),
        'GOLF_CLOUDFLARED_UID': str(os.getuid()),
    })
    if 'agents' in components:
        values['GOLF_AGENT_IMAGE'] = ''
    private_write(directory / 'bridge.env', ''.join(f"{key}='{value}'\n" for key, value in values.items()))
    private_write(directory / 'tunnel-token', '')
    private_write(directory / 'worker-secrets.json', json.dumps({
        'GOLF_ACCESS_CLIENT_ID': '', 'GOLF_ACCESS_CLIENT_SECRET': '',
    }, indent=2) + '\n')
    private_write(directory / 'control.json', json.dumps({
        'account': account, 'worker': 'gitgolf-control', 'public_origin': 'https://' + public_host,
        'bridge_origin': 'https://' + bridge_host, 'components': sorted(set(components)),
    }, indent=2) + '\n')
    # A private parent protects the key on the host; the non-root Golf container
    # needs to read its individually mounted key regardless of the host UID.
    result = subprocess.run(['openssl', 'req', '-x509', '-newkey', 'rsa:3072', '-nodes', '-days', '365',
        '-subj', '/CN=golf', '-addext', 'subjectAltName=DNS:golf,DNS:localhost,IP:127.0.0.1',
        '-addext', 'extendedKeyUsage=serverAuth', '-keyout', str(directory / 'origin.key'),
        '-out', str(directory / 'origin.crt')], capture_output=True, timeout=30)
    if result.returncode:
        raise ValueError('Origin certificate generation failed; incomplete directory retained for inspection')
    (directory / 'origin.key').chmod(0o644)
    (directory / 'origin.crt').chmod(0o644)


def compose_command(directory, arguments):
    private_directory(directory)
    settings = json.loads(private_read(directory / 'control.json'))
    private_read(directory / 'bridge.env')
    components = settings.get('components', [])
    if not isinstance(components, list) or any(item not in OPTIONAL for item in components):
        raise ValueError('Invalid component selection')
    command = ['docker', 'compose', '--project-name', 'golf-cloudflare', '--project-directory', str(ROOT),
               '--env-file', str(directory / 'bridge.env')]
    for file in ['compose.yaml', 'compose.ci.yaml', 'compose.actions-engine.yaml'] + [OPTIONAL[c] for c in components] + [
            'compose.runner-tls.yaml', 'compose.cloudflare.yaml']:
        command += ['-f', str(ROOT / file)]
    return command + arguments


def run_compose(directory, arguments):
    return subprocess.run(compose_command(directory, arguments), cwd=ROOT, env=clean_environment(), check=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--directory', type=Path, default=DEFAULT_DIRECTORY)
    commands = parser.add_subparsers(dest='command', required=True)
    init = commands.add_parser('init', help='Write private configuration only; provision nothing')
    init.add_argument('--account-id', required=True)
    init.add_argument('--hostname', default='gitgolf.mjtechguy.com')
    init.add_argument('--bridge-hostname', default='origin.gitgolf.mjtechguy.com')
    init.add_argument('--bucket', required=True)
    init.add_argument('--with', dest='components', action='append', choices=OPTIONAL, default=[])
    for name in ('check', 'up', 'stop', 'status'):
        commands.add_parser(name)
    compose = commands.add_parser('compose', help='Run a Compose subcommand against this installation')
    compose.add_argument('arguments', nargs=argparse.REMAINDER)
    args = parser.parse_args()
    directory = args.directory.absolute()
    if args.command == 'init':
        initialize(directory, args.account_id, args.hostname, args.bridge_hostname, args.bucket, args.components)
        print('Private Cloudflare installation prepared. Configure R2, origin Access/Tunnel and Worker secrets; see docs/CLOUDFLARE_SETUP.md.')
    elif args.command == 'compose':
        arguments = args.arguments
        if arguments[:1] == ['--']:
            arguments = arguments[1:]
        if not arguments or arguments[0].startswith('-'):
            raise ValueError('Supply a Compose subcommand, not global project/configuration options')
        run_compose(directory, arguments)
    elif args.command == 'up':
        if not private_read(directory / 'tunnel-token').strip():
            raise ValueError('Configure the dedicated tunnel token before starting')
        # Rendering validates required values before stopping any service.
        run_compose(directory, ['config', '--quiet'])
        run_compose(directory, ['stop'])
        run_compose(directory, ['up', '-d', '--build', 'golf'])
        # The bucket must already exist; setup does not create or adopt provider resources.
        run_compose(directory, ['up', '-d', '--build', '--wait', '--wait-timeout', '180'])
    else:
        run_compose(directory, {'check': ['config', '--quiet'], 'stop': ['stop'], 'status': ['ps']}[args.command])


if __name__ == '__main__':
    try:
        main()
    except (ValueError, OSError, subprocess.SubprocessError) as error:
        print(f'Cloudflare setup failed: {error.__class__.__name__}; verify private configuration and command inputs.', file=sys.stderr)
        sys.exit(1)
