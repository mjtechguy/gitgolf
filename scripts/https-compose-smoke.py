#!/usr/bin/env python3
"""Qualify the TLS edge and real cookie sessions on a disposable native core."""
import argparse
import base64
import http.cookiejar
import importlib.util
import json
import os
from pathlib import Path
import secrets
import ssl
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request

sys.dont_write_bytecode = True
import smoke

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('helpers', ROOT/'scripts/observability-smoke.py')
helpers = importlib.util.module_from_spec(spec)
spec.loader.exec_module(helpers)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--image', required=True)
    args = parser.parse_args()
    environment = {k: v for k, v in os.environ.items() if not k.startswith(
        ('GOLF_', 'GITEA_', 'POSTGRES_', 'COMPOSE_', 'RUSTFS_', 'AWS_', 'OTEL_')) and k != 'DATABASE_URL'}

    def run(*arguments, payload=None):
        result = subprocess.run(arguments, input=None if payload is None else json.dumps(payload).encode(),
            capture_output=True, cwd=ROOT, env=environment, timeout=180)
        assert result.returncode == 0, 'Subprocess failed; private output withheld'
        return result.stdout.decode().strip()

    image = json.loads(run('docker', 'image', 'inspect', args.image))[0]['Id']
    print('Golf image: '+image, flush=True)
    project = 'golf-https-proof-'+secrets.token_hex(5)
    tls_port, http_port, native_port = helpers.free_ports(3)
    original = smoke.GOLF, smoke.GITEA
    smoke.GOLF, smoke.GITEA = f'https://localhost:{tls_port}', f'http://127.0.0.1:{native_port}'
    with tempfile.TemporaryDirectory(prefix=project+'-') as temporary:
        directory = Path(temporary)
        directory.chmod(0o700)
        values = {k: secrets.token_hex(24) for k in ['POSTGRES_PASSWORD', 'GOLF_DB_PASSWORD', 'GITEA_DB_PASSWORD']}
        values.update(GOLF_ENCRYPTION_KEY=base64.b64encode(secrets.token_bytes(32)).decode(),
            GOLF_PUBLIC_URL=smoke.GOLF, GOLF_HTTPS_HOST='localhost', GOLF_HTTPS_PORT=str(tls_port),
            GOLF_HTTP_PORT=str(http_port), GOLF_EDGE_BIND='127.0.0.1', GITEA_PUBLIC_URL='',
            GITEA_OAUTH_CLIENT_ID='', GITEA_OAUTH_CLIENT_SECRET='', GOLF_ENCRYPTION_KEYS='',
            GOLF_ACTIVE_ENCRYPTION_KEY='', GOLF_REPOSITORY_EVENT_CONNECTIONS='')
        helpers.private_write(directory/'env', ''.join(k+'='+v+'\n' for k, v in values.items()))
        helpers.private_write(directory/'override.yaml', f'''services:
  golf:
    image: {image}
    pull_policy: never
  gitea:
    ports: !override ["127.0.0.1:{native_port}:3000"]
''')
        compose = ['docker', 'compose', '-p', project, '--env-file', str(directory/'env'),
            '-f', str(ROOT/'compose.yaml'), '-f', str(ROOT/'compose.https.yaml'),
            '-f', str(directory/'override.yaml')]

        def command(*arguments, **kwargs):
            return run(*compose, *arguments, **kwargs)

        def native(*arguments):
            return command('exec', '-T', 'gitea', 'gitea', '--config', '/etc/gitea/app.ini',
                'admin', 'user', *arguments)

        try:
            command('up', '-d', '--no-build', '--wait', '--wait-timeout', '120')
            certificate = directory/'root.crt'
            run('docker', 'cp', project+'-caddy-1:/data/caddy/pki/authorities/local/root.crt', str(certificate))
            context = ssl.create_default_context(cafile=str(certificate))
            jar = http.cookiejar.CookieJar()
            client = urllib.request.build_opener(urllib.request.HTTPSHandler(context=context),
                urllib.request.HTTPCookieProcessor(jar))

            def request(path, expected=200, headers=None):
                req = urllib.request.Request(smoke.GOLF+path, headers=headers or {'Accept': 'text/html'})
                try:
                    response = client.open(req, timeout=15)
                except urllib.error.HTTPError as error:
                    response = error
                with response:
                    assert response.status == expected, 'Unexpected edge response status'
                    return response.read()

            deadline = time.monotonic()+60
            while True:
                try:
                    smoke.rpc(client, 'SessionService/GetSession', expected=401)
                    break
                except (AssertionError, OSError):
                    assert time.monotonic() < deadline, 'HTTPS core readiness timeout'
                    time.sleep(0.5)
            request('/')
            for path in ['/internal/ci/poll', '/internal/ci/attempt/1/source', '/healthz', '/readyz', '/metrics']:
                request(path, 404)
            request('/', 421, {'Host': 'other.invalid', 'Accept': 'text/html'})
            assert json.loads(run('docker', 'inspect', project+'-golf-1'))[0]['NetworkSettings']['Ports'].get('8080/tcp') is None
            redirected = client.open(urllib.request.Request(
                f'http://localhost:{http_port}/account/settings?proof=1', headers={'Accept': 'text/html'}), timeout=15)
            with redirected:
                assert redirected.url == smoke.GOLF+'/account/settings?proof=1' and redirected.status == 200
            name = 'https-'+secrets.token_hex(5)
            native('create', '--username', name, '--email', name+'@example.invalid',
                '--random-password', '--must-change-password=false')
            token = native('generate-access-token', '--username', name, '--token-name', project,
                '--scopes', 'read:user', '--raw')
            assert len(token) == 40 and all(c in '0123456789abcdef' for c in token), 'Native token output was not canonical'
            deadline = time.monotonic()+45
            while True:
                try:
                    assert smoke.provider(token, 'GET', 'user')['login'] == name
                    break
                except (AssertionError, OSError):
                    assert time.monotonic() < deadline, 'Native user API readiness timeout'
                    time.sleep(0.5)
            password = 'Golf-only '+secrets.token_urlsafe(24)
            enrolled = json.loads(command('exec', '-T', 'golf', 'golf', 'local-account', 'create',
                payload={'username': name, 'email': name+'@example.invalid', 'password': password,
                    'forge_token': token, 'is_instance_admin': True}))
            assert enrolled['state'] == 'complete'
            smoke.rpc(client, 'SessionService/LoginWithPassword', {'username': name+'@example.invalid', 'password': password})
            cookies = list(jar)
            assert len(cookies) == 1
            cookie = cookies[0]
            assert cookie.name == '__Host-golf_session' and cookie.secure and cookie.path == '/'
            assert not cookie.domain_specified and cookie.expires > time.time()
            assert cookie.has_nonstandard_attr('HttpOnly') and cookie.get_nonstandard_attr('SameSite') == 'Lax'
            http_request = urllib.request.Request(f'http://localhost:{http_port}/')
            jar.add_cookie_header(http_request)
            assert not http_request.has_header('Cookie'), 'Secure cookie leaked to HTTP'
            old_cookie = cookie.name+'='+cookie.value
            smoke.rpc(client, 'SessionService/GetSession')
            smoke.rpc(client, 'SessionService/GetSession', headers={'Origin': 'https://other.invalid'}, expected=403)
            smoke.rpc(client, 'SessionService/GetSession', headers={'Sec-Fetch-Site': 'cross-site'}, expected=403)
            smoke.rpc(client, 'SessionService/LoginWithPassword', {'username': name, 'password': 'wrong'}, expected=401)
            command('restart', 'golf', 'caddy')
            deadline = time.monotonic()+45
            while True:
                try:
                    smoke.rpc(client, 'SessionService/GetSession')
                    break
                except (AssertionError, OSError):
                    assert time.monotonic() < deadline, 'Session did not survive restart'
                    time.sleep(0.5)
            run('docker', 'cp', project+'-caddy-1:/data/caddy/pki/authorities/local/root.crt', str(directory/'after.crt'))
            assert certificate.read_bytes() == (directory/'after.crt').read_bytes()
            smoke.rpc(client, 'SessionService/Logout')
            smoke.rpc(client, 'SessionService/GetSession', expected=401)
            smoke.rpc(client, 'SessionService/GetSession', headers={'Cookie': old_cookie}, expected=401)
            print('PASS: verified TLS, secure host-only persistent cookie, Origin/fetch guards, no-store RPC, private routes, redirect, restart, logout', flush=True)
        finally:
            command('down', '-v', '--remove-orphans')
            smoke.GOLF, smoke.GITEA = original


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        import traceback
        traceback.print_tb(error.__traceback__)
        print('FAIL: HTTPS qualification; private diagnostics withheld', file=sys.stderr)
        raise SystemExit(1)
