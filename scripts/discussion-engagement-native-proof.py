#!/usr/bin/env python3
"""Qualify source native engagement on owned fixtures without Docker workloads."""
import argparse
import base64
import hashlib
import json
import os
from pathlib import Path
import secrets
import subprocess
import sys
import urllib.request
sys.dont_write_bytecode = True
import smoke

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--output', type=Path, required=True)
args = parser.parse_args()
if not os.environ.get('GOLF_TEST_DATABASE_URL'):
    raise SystemExit('Set shared isolated-schema GOLF_TEST_DATABASE_URL')
os.umask(0o077)
args.output.mkdir(parents=True, exist_ok=False)
common = Path(subprocess.check_output(['git', 'rev-parse', '--git-common-dir'], text=True).strip()).resolve()
def admin(*args):
    return smoke.command('docker', 'compose', 'exec', '-T', 'gitea', 'gitea', '--config', '/etc/gitea/app.ini', 'admin', 'user', *args, cwd=common.parent)
name = 'golf-engagement-' + secrets.token_hex(5)
report = {'passed': False, 'ownedUserPurged': False, 'servedRuntimeQualified': False}
created, reader, organization, token = False, None, None, None
reader_created, organization_created = False, False
try:
    admin('create', '--username', name, '--email', name+'@example.invalid', '--random-password', '--must-change-password=false', '--admin=false')
    created = True
    token = admin('generate-access-token', '--username', name, '--token-name', name, '--scopes', 'write:user,write:repository,write:issue,write:organization,write:notification', '--raw')
    repo = smoke.provider(token, 'POST', 'user/repos', {'name': 'engagement', 'private': True, 'auto_init': True}, expected=201)
    smoke.wait_for_push(token, repo['full_name'])
    route = 'repos/'+repo['full_name']
    template = b'---\nname: Bug report\nabout: Native template fixture\ntitle: "[Bug]"\n---\n## Reproduce\n'
    smoke.provider(token, 'POST', route+'/contents/.github/ISSUE_TEMPLATE/bug.md', {'branch': repo['default_branch'], 'message': 'Owned template fixture', 'content': base64.b64encode(template).decode()}, expected=201)
    issue = smoke.provider(token, 'POST', route+'/issues', {'title': 'Owned native engagement', 'body': 'Native supported API proof'}, expected=201)
    comment = smoke.provider(token, 'POST', route+'/issues/'+str(issue['number'])+'/comments', {'body': 'Owned ordinary native comment'}, expected=201)
    probe = smoke.provider(token, 'POST', route+'/issues', {'title': 'Owned native status probe'}, expected=201)
    smoke.provider(token, 'POST', route+'/issues/'+str(probe['number'])+'/reactions', {'content': '+1'}, expected=201)
    request = urllib.request.Request(smoke.GITEA+'/api/v1/'+route+'/issues/'+str(probe['number'])+'/reactions', data=json.dumps({'content': '+1'}).encode(), method='DELETE', headers={'Authorization': 'token '+token, 'Content-Type': 'application/json'})
    with urllib.request.urlopen(request, timeout=15) as response:
        report['nativeReactionDeleteStatus'] = response.status
    reader = name+'-reader'
    admin('create', '--username', reader, '--email', reader+'@example.invalid', '--random-password', '--must-change-password=false', '--admin=false')
    reader_created = True
    reader_token = admin('generate-access-token', '--username', reader, '--token-name', reader, '--scopes', 'write:user,write:repository,write:issue,write:notification', '--raw')
    smoke.provider(token, 'PUT', route+'/collaborators/'+reader, {'permission': 'read'}, expected=204)
    smoke.provider(reader_token, 'POST', route+'/issues/'+str(issue['number'])+'/comments', {'body': 'Owned reader comment produces author notification'}, expected=201)
    organization = name+'-org'
    smoke.provider(token, 'POST', 'orgs', {'username': organization, 'visibility': 'private'}, expected=201)
    organization_created = True
    org_repo = smoke.provider(token, 'POST', 'orgs/'+organization+'/repos', {'name': 'labels', 'private': True}, expected=201)
    org_issue = smoke.provider(token, 'POST', 'repos/'+org_repo['full_name']+'/issues', {'title': 'Owned inherited label issue'}, expected=201)
    org_label = smoke.provider(token, 'POST', 'orgs/'+organization+'/labels', {'name': 'inherited/bug', 'color': 'abcdef'}, expected=201)
    payload = {'NativeURL': smoke.GITEA, 'Token': token, 'Owner': name, 'Name': repo['name'], 'RepositoryID': str(repo['id']), 'IssueID': str(issue['id']), 'Number': issue['number'], 'CommentID': str(comment['id']), 'ReaderToken': reader_token, 'Organization': organization, 'OrganizationRepositoryID': str(org_repo['id']), 'OrganizationIssueID': str(org_issue['id']), 'OrganizationNumber': org_issue['number'], 'OrganizationLabelID': str(org_label['id'])}
    report['sourceRevision'] = subprocess.check_output(['git', 'rev-parse', 'HEAD'], text=True).strip()
    report['sourceFilesSha256'] = {p: hashlib.sha256(Path(p).read_bytes()).hexdigest() for p in ['internal/server/discussion_engagement.go', 'internal/server/discussion_resource_operations.go', 'internal/server/discussion_engagement_native_test.go', 'internal/server/forge_notification_inbox.go', 'internal/server/issue_templates.go', 'internal/server/repository_labels.go', 'api/golf/v1/golf.proto', 'scripts/discussion-engagement-native-proof.py']}
    report['nativeVersion'] = smoke.provider(token, 'GET', 'version')['version']
    with (args.output/'native-test.log').open('w') as log:
        result = subprocess.run(['go', 'test', '-race', '-p', '1', './internal/server', '-run', '^TestDiscussionEngagementNative$', '-count=1', '-v'], env=os.environ | {'GOLF_TEST_ENGAGEMENT_NATIVE': json.dumps(payload)}, stdout=log, stderr=subprocess.STDOUT)
    report['testExitCode'] = result.returncode
    if result.returncode:
        raise RuntimeError('Source native engagement proof failed; inspect sanitized test log')
    report.update(passed=True, originalKeysDidNotDuplicate=True, scope='actual source native engagement, notifications, templates and inherited labels; not served deployment')
finally:
    cleanup_errors = []
    if organization_created:
        for route, field in [('repos/'+organization+'/labels', 'ownedOrganizationRepositoryPurged'), ('orgs/'+organization, 'ownedOrganizationPurged')]:
            try:
                smoke.provider(token, 'DELETE', route, expected=204)
                report[field] = True
            except Exception:
                cleanup_errors.append(field)
    for actor, created_actor, field in [(reader, reader_created, 'ownedReaderPurged'), (name, created, 'ownedUserPurged')]:
        if created_actor:
            try:
                admin('delete', '--username', actor, '--purge')
                report[field] = True
            except Exception:
                cleanup_errors.append(field)
    report['cleanupErrors'] = cleanup_errors
    (args.output/'manifest.json').write_text(json.dumps(report, indent=2)+'\n')
    if cleanup_errors:
        raise RuntimeError('Owned fixture cleanup incomplete; inspect sanitized manifest')
print('PASS actual native collaboration; owned fixtures purged; no served runtime claim')
