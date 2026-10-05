#!/usr/bin/env python3
"""Qualify native issue/PR metadata using a private, disposable repository.

Supported APIs create the fixture; current Go source reads and validates it.
No retained account, repository, pipeline or deployed Golf binary is changed.
Credentials remain in memory and the owned native account is purged afterward.
"""
import argparse
import base64
import hashlib
import json
import os
from pathlib import Path
import secrets
import subprocess
import sys

sys.dont_write_bytecode = True
import smoke


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, default=Path('.tmp/discussion-metadata-native-'+secrets.token_hex(4)))
    args = parser.parse_args()
    os.umask(0o077)
    args.output.mkdir(parents=True, exist_ok=False)
    report = {'passed': False, 'ownedUserPurged': False, 'runtimeChanged': False,
              'scope': 'actual native source reads, not deployed Golf RPC/browser or metadata edits'}
    name = 'golf-discussion-'+secrets.token_hex(5)
    created = False
    try:
        report['sourceRevision'] = subprocess.check_output(['git', 'rev-parse', 'HEAD'], text=True).strip()
        files = ['api/golf/v1/golf.proto', 'gen/golf/v1/golf.pb.go', 'internal/server/discussion_metadata.go',
                 'internal/server/discussion_metadata_test.go', 'internal/server/browser.go',
                 'internal/server/pulls.go', 'internal/server/rpc.go', 'scripts/discussion-metadata-smoke.py']
        report['sourceFilesSha256'] = {p: hashlib.sha256(Path(p).read_bytes()).hexdigest() for p in files}
        smoke.admin('create', '--username', name, '--email', name+'@example.invalid',
                    '--random-password', '--must-change-password=false')
        created = True
        token = smoke.admin('generate-access-token', '--username', name, '--token-name', name,
                            '--scopes', 'write:user,write:repository,write:issue', '--raw')
        native = smoke.provider(token, 'POST', 'user/repos',
                                {'name': 'metadata', 'private': True, 'auto_init': True}, expected=201)
        route = 'repos/'+native['full_name']
        base = native['default_branch']
        label = smoke.provider(token, 'POST', route+'/labels',
                               {'name': 'type/bug', 'color': 'aabb00', 'description': 'Native label description'}, expected=201)
        milestone = smoke.provider(token, 'POST', route+'/milestones',
                                   {'title': 'v1.0', 'description': 'Native release milestone',
                                    'due_on': '2026-12-01T00:00:00Z'}, expected=201)
        issue = smoke.provider(token, 'POST', route+'/issues',
                               {'title': 'Native metadata issue', 'body': 'Source qualification only',
                                'labels': [label['id']], 'assignees': [name], 'milestone': milestone['id']}, expected=201)
        smoke.provider(token, 'POST', route+'/branches',
                       {'new_branch_name': 'metadata-feature', 'old_branch_name': base}, expected=201)
        smoke.provider(token, 'POST', route+'/contents/qualification.txt',
                       {'branch': 'metadata-feature', 'message': 'Add native metadata fixture',
                        'content': base64.b64encode(b'Native metadata qualification\n').decode()}, expected=201)
        pull = smoke.provider(token, 'POST', route+'/pulls',
                              {'title': 'Native metadata pull request', 'head': 'metadata-feature', 'base': base,
                               'body': 'Source qualification only'}, expected=201)
        smoke.provider(token, 'POST', route+'/issues/'+str(pull['number'])+'/labels',
                       {'labels': [label['id']]})
        smoke.provider(token, 'PATCH', route+'/issues/'+str(pull['number']),
                       {'assignees': [name], 'milestone': milestone['id']}, expected=201)
        env = os.environ | {'GOLF_TEST_DISCUSSION_NATIVE_TOKEN': token,
                            'GOLF_TEST_DISCUSSION_NATIVE_REPOSITORY': native['full_name'],
                            'GOLF_TEST_DISCUSSION_NATIVE_ISSUE': str(issue['number']),
                            'GOLF_TEST_DISCUSSION_NATIVE_PULL': str(pull['number'])}
        result = subprocess.run(['go', 'test', '-race', './internal/server', '-run',
                                 '^TestDiscussionMetadataNativeRead$', '-count=1', '-v'],
                                env=env, capture_output=True, text=True, timeout=180)
        output = result.stdout+result.stderr
        assert token not in output, 'Private credential appeared in child output; diagnostic withheld'
        (args.output/'go-test.log').write_text(output)
        report.update(nativeRepositoryId=str(native['id']), issueNumber=issue['number'],
                      pullNumber=pull['number'], testExitCode=result.returncode,
                      nativeVersion=smoke.provider(token, 'GET', 'version')['version'])
        assert result.returncode == 0 and '--- PASS: TestDiscussionMetadataNativeRead' in output and 'SKIP' not in output, 'Native source qualification failed; inspect private receipt'
        report['passed'] = True
    finally:
        try:
            if created:
                smoke.admin('delete', '--username', name, '--purge')
                smoke.request(smoke.client(), 'GET', smoke.GITEA+'/api/v1/users/'+name, expected=404)
                report['ownedUserPurged'] = True
        except BaseException:
            report['passed'] = False
            raise
        finally:
            (args.output/'manifest.json').write_text(json.dumps(report, indent=2)+'\n')
    print('PASS actual native issue/list/PR metadata; owned account/repository purged; deployed Golf unchanged')


if __name__ == '__main__':
    main()
