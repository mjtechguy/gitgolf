#!/usr/bin/env python3
"""Qualify operator key rotation with isolated PostgreSQL and real Forgejo PATs.

Requires the local Compose Forgejo and a built bin/golf-server. Creates and removes
its own database/container and provider user. Normal Golf/.env are untouched.
OAuth verification here covers a pending PKCE attempt, not a token exchange.
"""
import argparse
import base64
import json
import os
from pathlib import Path
import secrets
import socket
import subprocess
import sys
import tempfile
import time
from urllib.parse import parse_qs, urlencode, urlparse

sys.dont_write_bytecode = True
import smoke


def port():
    with socket.socket() as listener:
        listener.bind(('127.0.0.1', 0))
        return listener.getsockname()[1]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--server', type=Path, default=smoke.ROOT/'bin/golf-server')
    parser.add_argument('--legacy-server', type=Path, help='optional pre-keyring server for real schema-upgrade proof')
    args = parser.parse_args()
    binary = args.server.resolve()
    assert binary.is_file(), 'Build bin/golf-server first'
    initial_binary = args.legacy_server.resolve() if args.legacy_server else binary
    assert initial_binary.is_file(), 'Legacy server binary is missing'
    serving_binary = initial_binary
    prefix = 'golf-keys-'+secrets.token_hex(5)
    password = secrets.token_urlsafe(32)
    legacy, next_key = [base64.b64encode(secrets.token_bytes(32)).decode() for _ in range(2)]
    env = dict(os.environ, POSTGRES_PASSWORD=password)
    # Do not inherit an operator's real keys or optional OAuth application.
    for name in ['GOLF_ENCRYPTION_KEY', 'GOLF_ENCRYPTION_KEYS', 'GOLF_ACTIVE_ENCRYPTION_KEY']:
        env.pop(name, None)
    env.update(GOLF_ENCRYPTION_KEY=legacy, GOLF_FORGE_URL=smoke.FORGE,
               GOLF_FORGE_PUBLIC_URL=smoke.FORGE, GOLF_FORGE_OAUTH_CLIENT_ID=prefix,
               GOLF_FORGE_OAUTH_CLIENT_SECRET=secrets.token_urlsafe(32),
               GOLF_ALLOW_INSECURE_COOKIES='true', GOLF_WEB_DIR=str(smoke.ROOT/'web/dist'))
    original_url = smoke.GOLF
    smoke.GOLF = 'http://127.0.0.1:'+str(port())
    env.update(GOLF_PUBLIC_URL=smoke.GOLF, GOLF_LISTEN_ADDR=urlparse(smoke.GOLF).netloc)
    process, created_db, created_user = None, False, False
    forbidden = [password, legacy, next_key, env['GOLF_FORGE_OAUTH_CLIENT_SECRET']]

    def run(command, expected=0, input_text=None):
        result = subprocess.run(command, cwd=smoke.ROOT, env=env, text=True,
                                input=input_text, capture_output=True, timeout=70)
        assert result.returncode == expected, 'Fixture command failed; output withheld'
        return result

    def sql(statement, expected=0):
        return run(['docker', 'exec', '-i', prefix, 'psql', '-U', 'postgres', '-d', 'golf',
                    '-At', '-v', 'ON_ERROR_STOP=1'], expected, statement).stdout.strip()

    def operator(*arguments, state='complete', expected=0):
        result = run([str(binary), 'keys', *arguments], expected)
        assert not any(value in result.stdout+result.stderr for value in forbidden)
        value = json.loads(result.stdout)
        assert value['schema_version'] == 'golf.keys.v1' and value['state'] == state
        return value['result'] if 'result' in value else value

    def stop():
        nonlocal process
        if process:
            process.terminate()
            try:
                process.wait(timeout=12)
            except subprocess.TimeoutExpired:
                process.kill(); process.wait(timeout=5)
                raise AssertionError('Fixture server failed graceful shutdown')
            process = None

    def start(log, failure=False):
        nonlocal process
        process = subprocess.Popen([str(serving_binary)], cwd=smoke.ROOT, env=env,
                                   stdout=log, stderr=log)
        if failure:
            assert process.wait(timeout=15) != 0, 'Invalid key configuration accepted'
            process = None
            return
        smoke.ready()
        assert process.poll() is None

    try:
        run(['docker', 'run', '--rm', '-d', '--name', prefix, '-e', 'POSTGRES_PASSWORD',
             '-e', 'POSTGRES_DB=golf', '-p', '127.0.0.1::5432',
             'postgres:18.4-alpine3.24'])
        created_db = True
        database_port = run(['docker', 'port', prefix, '5432/tcp']).stdout.strip().rsplit(':', 1)[1]
        env['DATABASE_URL'] = f'postgres://postgres:{password}@127.0.0.1:{database_port}/golf?sslmode=disable'
        forbidden.append(env['DATABASE_URL'])
        for _ in range(60):
            probe = subprocess.run(['docker', 'exec', prefix, 'pg_isready', '-h', '127.0.0.1', '-U', 'postgres'],
                                   capture_output=True, timeout=5)
            if probe.returncode == 0:
                break
            time.sleep(.25)
        else:
            raise AssertionError('Fixture database did not become ready')
        smoke.admin('create', '--username', prefix, '--email', prefix+'@example.invalid',
                    '--random-password', '--random-password-length', '32', '--must-change-password=false')
        created_user = True
        token = smoke.admin('generate-access-token', '--username', prefix, '--token-name', prefix,
                            '--scopes', 'read:user', '--raw').strip()
        forbidden.append(token)
        with tempfile.TemporaryFile() as log:
            start(log)
            sessions = [smoke.client() for _ in range(3)]
            for session in sessions:
                smoke.rpc(session, 'SessionService/LoginWithForgeToken', {'token': token})
            original_sessions = smoke.rpc(sessions[0], 'SessionService/ListSessions')
            pending = smoke.client()
            authorization = smoke.rpc(pending, 'SessionService/BeginForgeOAuth')['authorizationUrl']
            state = parse_qs(urlparse(authorization).query)['state'][0]
            assert sql('SELECT count(*) FROM golf_oauth_attempts;') == '1'
            session_snapshot = sql("SELECT session_id,encode(token_hash,'hex'),encode(encrypted_token,'hex'),expires_at,credential_kind FROM golf_sessions ORDER BY session_id;")
            attempt_snapshot = sql("SELECT encode(state_hash,'hex'),encode(binding_hash,'hex'),encode(encrypted_verifier,'hex'),expires_at FROM golf_oauth_attempts ORDER BY state_hash;")
            stop()  # Drain ALL old writers before changing the database policy.
            assert operator('status')['active_key_id'] == 'legacy'
            assert sql("SELECT session_id,encode(token_hash,'hex'),encode(encrypted_token,'hex'),expires_at,credential_kind FROM golf_sessions ORDER BY session_id;") == session_snapshot
            assert sql("SELECT encode(state_hash,'hex'),encode(binding_hash,'hex'),encode(encrypted_verifier,'hex'),expires_at FROM golf_oauth_attempts ORDER BY state_hash;") == attempt_snapshot
            serving_binary = binary
            start(log)
            assert smoke.rpc(sessions[0], 'SessionService/ListSessions') == original_sessions
            stop()
            if args.legacy_server:
                print('PASS: pre-keyring schema upgrade preserves real login sessions and pending OAuth attempts')
            env.update(GOLF_ENCRYPTION_KEYS=json.dumps({'legacy': legacy, 'next': next_key}),
                       GOLF_ACTIVE_ENCRYPTION_KEY='next')
            activated = operator('activate')
            assert activated['status']['active_key_id'] == 'next'
            operator('retirement-check', '--key-id', 'legacy', state='failed', expected=1)
            # Old SQL writers default to legacy and are fenced even if still alive.
            sql('UPDATE golf_sessions SET encrypted_token=encrypted_token;', expected=3)
            start(log)
            assert smoke.rpc(sessions[0], 'SessionService/ListSessions') == original_sessions
            new = smoke.client()
            smoke.rpc(new, 'SessionService/LoginWithForgeToken', {'token': token})
            partial = operator('rotate', '--batch-size', '1', '--max-batches', '1', state='partial')
            assert partial['rotated_sessions'] == 1 and partial['batches'] == 1
            stop(); start(log)
            for session in sessions+[new]:
                smoke.rpc(session, 'SessionService/GetSession')
            complete = operator('rotate', '--batch-size', '1', '--max-batches', '10')
            assert complete['complete'] and complete['rotated_oauth_attempts'] == 1
            operator('retirement-check', '--key-id', 'legacy', state='eligible')
            stop()
            env.pop('GOLF_ENCRYPTION_KEY')
            env['GOLF_ENCRYPTION_KEYS'] = json.dumps({'next': next_key})
            start(log)
            assert len(smoke.rpc(new, 'SessionService/ListSessions')['sessions']) == 4
            for session in sessions+[new]:
                smoke.rpc(session, 'SessionService/GetSession')
            # A denied callback still authenticates and consumes the rotated verifier.
            with pending.open(smoke.GOLF+'/auth/forgejo/callback?'+urlencode({'state': state, 'error': 'access_denied'}), timeout=15) as response:
                response.read()
            assert sql('SELECT count(*) FROM golf_oauth_attempts;') == '0'
            stop()
            before = sql('SELECT count(*) FROM golf_sessions;')
            env['GOLF_ENCRYPTION_KEYS'] = json.dumps({'next': base64.b64encode(secrets.token_bytes(32)).decode()})
            start(log, failure=True)
            assert sql('SELECT count(*) FROM golf_sessions;') == before
            env['GOLF_ENCRYPTION_KEYS'] = json.dumps({'next': next_key})
            start(log)
            for session in sessions+[new]:
                smoke.rpc(session, 'SessionService/Logout')
            assert sql('SELECT count(*) FROM golf_sessions;') == '0'
            assert int(sql('SELECT count(*) FROM golf_crypto_events;')) >= 5
        print('PASS: real PAT cookies survive activation, mixed keys, bounded resume, restart and legacy-key removal')
        print('PASS: pending PKCE verifier rotates and consumes; stale writes and label/material reuse fail closed')
    finally:
        try:
            stop()
        finally:
            try:
                if created_user:
                    smoke.admin('delete', '--username', prefix, '--purge')
            finally:
                try:
                    if created_db:
                        run(['docker', 'rm', '-f', '-v', prefix])
                finally:
                    smoke.GOLF = original_url


if __name__ == '__main__':
    try:
        main()
    except Exception:
        raise SystemExit('Keyring qualification failed; sensitive diagnostics withheld')
