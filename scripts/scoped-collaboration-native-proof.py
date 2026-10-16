#!/usr/bin/env python3
"""Qualify scoped writes against owned native fixtures without Docker workloads."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import secrets
import subprocess
import sys
sys.dont_write_bytecode = True
import smoke

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--output', type=Path, required=True)
args = parser.parse_args()
if not os.environ.get('GOLF_TEST_DATABASE_URL'):
    raise SystemExit('Set GOLF_TEST_DATABASE_URL to the shared isolated-schema test database')
os.umask(0o077)
args.output.mkdir(parents=True, exist_ok=False)
name = 'golf-api-write-' + secrets.token_hex(5)
report = {'passed': False, 'ownedUserPurged': False, 'servedRuntimeQualified': False}
created = False
try:
    smoke.admin('create', '--username', name, '--email', name+'@example.invalid', '--random-password', '--must-change-password=false', '--admin=false')
    created = True
    token = smoke.admin('generate-access-token', '--username', name, '--token-name', name, '--scopes', 'write:user,write:repository,write:issue', '--raw')
    repo = smoke.provider(token, 'POST', 'user/repos', {'name': 'scoped-writes', 'private': True}, expected=201)
    payload = {'NativeURL': smoke.FORGE, 'Token': token, 'Owner': name, 'Name': repo['name'], 'RepositoryID': str(repo['id'])}
    report['sourceRevision'] = subprocess.check_output(['git', 'rev-parse', 'HEAD'], text=True).strip()
    report['sourceFilesSha256'] = {str(path): hashlib.sha256(path.read_bytes()).hexdigest() for path in map(Path, ['internal/server/api_credentials.go', 'internal/server/api_write_scopes.go', 'internal/server/api_write_native_test.go', 'internal/server/issue_mutations.go', 'internal/server/rpc.go', 'api/golf/v1/golf.proto', 'scripts/scoped-collaboration-native-proof.py'])}
    report['nativeVersion'] = smoke.provider(token, 'GET', 'version')['version']
    with (args.output/'native-test.log').open('w') as log:
        result = subprocess.run(['go', 'test', '-race', '-p', '1', './internal/server', '-run', '^TestApiWriteGrantNative$', '-count=1', '-v'], env=os.environ | {'GOLF_TEST_API_GRANT_NATIVE': json.dumps(payload)}, stdout=log, stderr=subprocess.STDOUT)
    report['testExitCode'] = result.returncode
    if result.returncode:
        raise RuntimeError('Source native delegation proof failed; inspect sanitized test log')
    issues = smoke.provider(token, 'GET', 'repos/'+repo['full_name']+'/issues?state=all')
    assert len(issues) == 1 and issues[0]['title'] == 'Owned scoped native issue'
    comments = smoke.provider(token, 'GET', 'repos/'+repo['full_name']+'/issues/'+str(issues[0]['number'])+'/comments')
    assert len(comments) == 1 and comments[0]['body'] == 'One journaled native comment'
    report.update(passed=True, exactNativeIssueCount=1, exactNativeCommentCount=1, originalKeysDidNotDuplicate=True, revokedWriteRefused=True, actualCLI=True, actualMCPProtocols=["2026-07-28", "2025-11-25"])
finally:
    if created:
        smoke.admin('delete', '--username', name, '--purge')
        report['ownedUserPurged'] = True
    (args.output/'manifest.json').write_text(json.dumps(report, indent=2)+'\n')
if not report['passed'] or not report['ownedUserPurged']:
    raise SystemExit('Native delegation proof incomplete')
print('PASS actual native scoped issue/comment operations and replay/revocation; owned fixture purged; no served-runtime claim')
