#!/usr/bin/env python3
"""Run the existing pinned native protection corpus plus SSH on owned fixtures.

Uses the retained local provider; creates no Docker resources or execution jobs.
Creates/purges only randomly named actors, their organization/repository and SSH
keys through supported native CLI/APIs. Never changes retained configuration.
"""
import argparse
import contextlib
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import secrets
import shlex
import subprocess
import tempfile
import traceback

ROOT = Path(__file__).resolve().parents[1]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--stack-root', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    os.umask(0o077)
    args.output.mkdir(parents=True, exist_ok=False)
    spec = importlib.util.spec_from_file_location('native_protection', ROOT / 'scripts/gitea-protection-smoke.py')
    native = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(native)
    stack = args.stack_root.resolve()
    native.GITEA = 'http://localhost:3001'
    native.COMPOSE = ['docker', 'compose', '--project-directory', str(stack), '--file', str(stack / 'compose.yaml'), '--env-file', str(stack / '.env')]
    report = {'passed': False, 'dockerResourcesCreated': 0, 'jobsExecuted': 0,
              'protectedPublicationQualified': False, 'sshProtectedPushDenials': 0}

    def ssh_protected_receive(actors, repository, work, candidate, original):
        with tempfile.TemporaryDirectory(prefix='golf-protected087-ssh-') as folder:
            folder = Path(folder)
            folder.chmod(0o700)
            known = folder / 'known_hosts'
            # Pin this controlled loopback provider's observed key. No reuse of
            # the user's host-key configuration, SSH agent or multiplexed sessions.
            known.write_text(native.command('ssh-keyscan', '-4', '-T', '3', '-p', '2222', '-t', 'ed25519', 'localhost'))
            assert known.read_text().strip(), 'Controlled native SSH host key missing'
            known.chmod(0o600)
            remote = 'ssh://git@localhost:2222/' + repository['full_name'] + '.git'
            for actor in actors:
                key = folder / ('key-' + secrets.token_hex(4))
                native.command('ssh-keygen', '-q', '-t', 'ed25519', '-N', '', '-f', str(key))
                row = native.api(actor['token'], 'POST', 'user/keys', {
                    'title': 'Golf protected087 owned fixture', 'key': key.with_suffix('.pub').read_text()}, expected=201)
                try:
                    env = native.git_env(actor)
                    # Remove HTTP credentials from SSH subprocess environments.
                    env['GIT_CONFIG_COUNT'] = '2'
                    env['GIT_CONFIG_KEY_0'] = 'credential.helper'
                    env['GIT_CONFIG_VALUE_0'] = ''
                    env['GIT_CONFIG_KEY_1'] = 'core.hooksPath'
                    env['GIT_CONFIG_VALUE_1'] = os.devnull
                    env.pop('GIT_CONFIG_KEY_2', None)
                    env.pop('GIT_CONFIG_VALUE_2', None)
                    env['GIT_SSH_COMMAND'] = shlex.join(['ssh', '-F', os.devnull, '-i', str(key), '-o', 'IdentitiesOnly=yes', '-o', 'IdentityAgent=none', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-o', 'UserKnownHostsFile=' + str(known), '-o', 'GlobalKnownHostsFile=' + os.devnull, '-o', 'ControlMaster=no', '-o', 'ControlPath=none'])
                    refs = native.command('git', 'ls-remote', remote, 'refs/heads/main', cwd=work, env=env)
                    assert refs.split()[0] == original, 'SSH read did not bind original target'
                    native.command('git', 'push', '--quiet', remote, candidate + ':refs/heads/main', cwd=work, env=env, success=False)
                    assert native.command('git', 'ls-remote', remote, 'refs/heads/main', cwd=work, env=env).split()[0] == original, 'Denied SSH push changed target'
                    report['sshProtectedPushDenials'] += 1
                finally:
                    native.api(actor['token'], 'DELETE', 'user/keys/' + str(row['id']), expected=204)
            native.check('owner/developer SSH reads succeed; protected receive denied and target remains exact')

    def exact_review_check(actor, repository, number, head, old_head):
        with tempfile.TemporaryDirectory(prefix='golf-protected087-review-') as folder:
            envelope = Path(folder) / 'fixture.json'
            envelope.write_text(json.dumps({'URL': native.GITEA, 'Token': actor['token'], 'FullName': repository['full_name'], 'Number': number, 'Head': head, 'OldHead': old_head}))
            envelope.chmod(0o600)
            result = subprocess.run(['go', 'test', '-race', '-p', '1', './internal/server', '-run', '^TestProtectedReviewNative087$', '-count=1', '-v'], cwd=ROOT, env=os.environ | {'GOLF_PROTECTED087_NATIVE_FIXTURE': str(envelope)}, capture_output=True, text=True, timeout=180)
            log = result.stdout + result.stderr
            assert actor['token'] not in log, 'Private native diagnostic withheld'
            (args.output / 'review-native.log').write_text(log)
            assert result.returncode == 0 and '--- PASS: TestProtectedReviewNative087' in log and '--- SKIP:' not in log, 'Native exact-head production consumer failed'
            report['exactHeadNativeConsumerPassed'] = True

    files = ['scripts/gitea-protection-smoke.py', 'scripts/protected087-native-proof.py', 'internal/server/protected_review_observation087.go', 'internal/server/pull_merge_observation.go']
    report['sourceRevision'] = native.command('git', 'rev-parse', 'HEAD')
    report['sourceSHA256'] = {name: hashlib.sha256((ROOT / name).read_bytes()).hexdigest() for name in files}
    report['nativeVersion'] = native.api(None, 'GET', 'version')['version']
    with (args.output / 'native.log').open('w') as log, contextlib.redirect_stdout(log):
        try:
            native.qualify(ssh_protected_receive, exact_review_check)
            assert report['sshProtectedPushDenials'] == 2
            report.update(passed=True, ownedFixturesPurged=True)
        except Exception as error:
            # Existing harness assertions intentionally withhold provider output.
            report['failureType'] = type(error).__name__
            report['failureLocation'] = [{'file': Path(frame.filename).name, 'line': frame.lineno} for frame in traceback.extract_tb(error.__traceback__)]
            raise
        finally:
            (args.output / 'manifest.json').write_text(json.dumps(report, indent=2) + '\n')
    print('PASS native HTTP/SSH/API protected-write regression; protected publication remains unqualified')


if __name__ == '__main__':
    main()
