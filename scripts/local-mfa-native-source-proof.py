#!/usr/bin/env python3
"""Exercise real native identity/MFA/forms with host PostgreSQL and one owned actor.
No Docker services/jobs are created or restarted. Production Golf HTTP handlers
use an isolated test schema; the retained Golf installation is not modified.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import secrets
import subprocess
import sys
import tempfile
sys.dont_write_bytecode = True
from smoke import ROOT, GITEA, command, provider


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--stack-root', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    if not os.environ.get('GOLF_TEST_DATABASE_URL'):
        raise SystemExit('Supply an owned isolated host PostgreSQL database')
    os.umask(0o077)
    args.output.mkdir(parents=True, exist_ok=False)
    stack = args.stack_root.resolve()
    name = 'golf-mfa-probe-' + secrets.token_hex(5)
    report = {'passed': False, 'ownedUserPurged': False, 'dockerResourcesCreated': 0,
              'servedRuntimeQualified': False, 'ownedUsername': name}
    def admin(*values):
        return command('docker', 'compose', '--project-directory', str(stack), '--file', str(stack/'compose.yaml'),
                       '--env-file', str(stack/'.env'), 'exec', '-T', 'gitea', 'gitea', '--config',
                       '/etc/gitea/app.ini', 'admin', 'user', *values)
    created = False
    token = ''
    try:
        admin('create', '--username', name, '--email', name+'@example.invalid', '--random-password', '--must-change-password=false', '--admin=false')
        created = True
        token = admin('generate-access-token', '--username', name, '--token-name', name,
                      '--scopes', 'write:user,write:repository,write:issue', '--raw')
        report['nativeVersion'] = provider(token, 'GET', 'version')['version']
        report['sourceRevision'] = command('git', 'rev-parse', 'HEAD')
        files = ['api/golf/v1/golf.proto', 'internal/server/local_mfa.go', 'internal/server/local_auth.go',
                 'internal/server/session.go', 'internal/server/rpc.go', 'internal/server/local_mfa_native_test.go',
                 'internal/server/issue_form_templates.go', 'internal/server/issue_templates.go',
                 'scripts/local-mfa-native-source-proof.py']
        report['sourceFilesSHA256'] = {p: hashlib.sha256((ROOT/p).read_bytes()).hexdigest() for p in files}
        with tempfile.TemporaryDirectory(prefix='golf-owned-mfa-') as folder:
            envelope = Path(folder)/'fixture.json'
            envelope.write_text(json.dumps({'URL': GITEA, 'Username': name, 'Token': token}))
            envelope.chmod(0o600)
            result = subprocess.run(['go', 'test', '-race', '-p', '1', './internal/server', '-run', '^TestLocalMFANativeProof$', '-count=1', '-v'],
                                    cwd=ROOT, env=os.environ | {'GOLF_MFA_NATIVE_PROOF': str(envelope)},
                                    capture_output=True, text=True, timeout=180)
            log = result.stdout + result.stderr
            if token in log:
                raise RuntimeError('Private native diagnostic withheld')
            (args.output/'go-test.log').write_text(log)
            report['testExitCode'] = result.returncode
            if result.returncode or "--- PASS: TestLocalMFANativeProof" not in log or "--- SKIP:" in log:
                raise RuntimeError('Native MFA/forms proof failed; inspect sanitized receipt')
        report.update(passed=True, scope='Actual native identity, opaque password challenge, TOTP after application restart, recovery regeneration/refusal, factor disable/logout, exact-commit YAML template and independently read native issue publication. No served-runtime claim.')
    finally:
        if created:
            admin('delete', '--username', name, '--purge')
            report['ownedUserPurged'] = True
        (args.output/'manifest.json').write_text(json.dumps(report, indent=2)+'\n')
    if not report['passed'] or not report['ownedUserPurged']:
        raise SystemExit('Native MFA/forms qualification incomplete')
    print('PASS actual native MFA/form production handlers, restart and original authority; owned actor/repository purged; no new Docker resources')


if __name__ == '__main__':
    main()
