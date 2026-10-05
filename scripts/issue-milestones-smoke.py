#!/usr/bin/env python3
"""Exercise deployed milestone edits and roles in a disposable private repository.

Supported APIs create all data. Credentials remain in memory; owned sessions and
native accounts are removed afterward. No retained repository or account changes.
"""
import argparse
import json
import os
from pathlib import Path
import secrets
import subprocess
import sys
import urllib.request
import uuid
sys.dont_write_bytecode = True
import smoke


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    os.umask(0o077)
    args.output.mkdir(parents=True, exist_ok=False)
    report = {'passed': False, 'ownedSessionsLoggedOut': False, 'ownedUsersPurged': False}
    actors = []
    users = []
    try:
        report['servedSourceRevision'] = subprocess.check_output(['docker', 'inspect', 'golf-golf-1', '--format', '{{ index .Config.Labels "io.golf.web.revision" }}'], text=True).strip()
        prefix = 'golf-milestone-'+secrets.token_hex(4)
        for role in ('owner', 'writer', 'reader', 'outsider'):
            name = prefix+'-'+role
            smoke.admin('create', '--username', name, '--email', name+'@example.invalid', '--random-password', '--must-change-password=false')
            users.append(name)
            token = smoke.admin('generate-access-token', '--username', name, '--token-name', prefix, '--scopes', 'write:user,write:repository,write:issue', '--raw')
            session = smoke.client()
            actors.append((name, token, session))
            smoke.rpc(session, 'SessionService/LoginWithGiteaToken', {'token': token})
        name, token, owner = actors[0]
        repo = {'owner': name, 'name': 'milestones'}
        native = smoke.provider(token, 'POST', 'user/repos', {'name': repo['name'], 'private': True, 'auto_init': True}, expected=201)
        base = 'repos/'+native['full_name']
        for actor, permission in ((actors[1], 'write'), (actors[2], 'read')):
            smoke.provider(token, 'PUT', base+'/collaborators/'+actor[0], {'permission': permission}, expected=204)
        milestones = [smoke.provider(token, 'POST', base+'/milestones', {'title': 'Release '+label, 'due_on': '2026-12-01T00:00:00Z'}, expected=201) for label in ('A', 'B')]
        issue = smoke.provider(token, 'POST', base+'/issues', {'title': 'Milestone assignment qualification', 'body': 'Unchanged private description', 'milestone': milestones[0]['id']}, expected=201)
        def read(session=owner):
            return smoke.rpc(session, 'RepositoryService/GetIssue', {'repository': repo, 'number': issue['number']})['issue']
        def change(session, current, expected, selected):
            return smoke.rpc(session, 'RepositoryService/UpdateIssue', {'repository': repo, 'repositoryId': str(native['id']), 'issueId': str(issue['id']), 'number': issue['number'], 'expectedRevision': current['revision'], 'idempotencyKey': str(uuid.uuid4()), 'milestone': {'expectedMilestoneId': str(expected), 'milestoneId': str(selected)}})
        for actor in actors[:3]:
            result = smoke.rpc(actor[2], 'RepositoryService/ListRepositoryMilestones', {'repository': repo, 'repositoryId': str(native['id']), 'state': 'ISSUE_STATE_ALL', 'page': {'page': 1, 'limit': 20}})
            assert result.get('canEditMilestone', False) == (actor == actors[0]), 'Native admin capability mismatch'
            assert {row['id'] for row in result['milestones']} == {str(row['id']) for row in milestones}
        for actor in actors[1:3]:
            denied = change(actor[2], read(actor[2]), milestones[0]['id'], milestones[1]['id'])
            assert denied['mutation']['state'] == 'ISSUE_MUTATION_STATE_REJECTED', 'Nonadmin milestone edit accepted'
        smoke.rpc(actors[3][2], 'RepositoryService/ListRepositoryMilestones', {'repository': repo, 'repositoryId': str(native['id'])}, expected=404)
        stale = change(owner, read(), 0, milestones[1]['id'])
        assert stale['mutation']['state'] == 'ISSUE_MUTATION_STATE_REJECTED' and stale['mutation']['failureCode'] == 'revision_changed'
        cookies = [dict(name=c.name, value=c.value, url=smoke.GOLF, httpOnly=c.has_nonstandard_attr('HttpOnly'), sameSite='Lax') for handler in owner.handlers if isinstance(handler, urllib.request.HTTPCookieProcessor) for c in handler.cookiejar]
        config = dict(url=smoke.GOLF+'/'+native['full_name']+'/issues/'+str(issue['number']), cookies=cookies, forbidden=[a[1] for a in actors], repositoryId=str(native['id']), issueId=str(issue['id']), number=issue['number'], originalId=str(milestones[0]['id']), selectedId=str(milestones[1]['id']), output=str((args.output/'browser').resolve()))
        result = subprocess.run(['node', 'scripts/issue-milestone-browser.mjs'], input=json.dumps(config), text=True, capture_output=True, timeout=150)
        assert all(a[1] not in result.stdout+result.stderr for a in actors), 'Child credential diagnostic withheld'
        report['browserExitCode'] = result.returncode
        assert result.returncode == 0, 'Browser qualification failed; inspect sanitized receipt'
        final = smoke.provider(token, 'GET', base+'/issues/'+str(issue['number']))
        assert final['milestone'] is None and all(final[k] == issue[k] for k in ('id', 'title', 'body', 'state')), 'Native clear changed unrelated fields'
        report.update(passed=True, nativeVersion=smoke.provider(token, 'GET', 'version')['version'], roles=['owner admitted', 'writer/reader refused', 'outsider masked'], scope='Actual deployed issue milestone change/clear; admin-only admission; not PR metadata or atomic native CAS')
    finally:
        cleanup_errors = []
        for _, _, session in actors:
            try:
                smoke.rpc(session, 'SessionService/Logout')
                smoke.rpc(session, 'SessionService/GetSession', expected=401)
            except BaseException:
                cleanup_errors.append('session_cleanup')
        report['ownedSessionsLoggedOut'] = 'session_cleanup' not in cleanup_errors
        for name in reversed(users):
            try:
                smoke.admin('delete', '--username', name, '--purge')
                smoke.request(smoke.client(), 'GET', smoke.GITEA+'/api/v1/users/'+name, expected=404)
            except BaseException:
                cleanup_errors.append('user_cleanup')
        report['ownedUsersPurged'] = 'user_cleanup' not in cleanup_errors
        if cleanup_errors:
            report['passed'] = False
        report['cleanupErrors'] = cleanup_errors
        (args.output/'manifest.json').write_text(json.dumps(report, indent=2)+'\n')
        if cleanup_errors:
            raise RuntimeError('Owned fixture cleanup incomplete; inspect private receipt')
    print('PASS actual native/admin milestone edits, served browser and owned cleanup')


if __name__ == '__main__':
    main()
