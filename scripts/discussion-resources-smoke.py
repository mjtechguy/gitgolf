#!/usr/bin/env python3
"""Qualify actual discussion resource APIs and served UI with disposable fixtures.

Uses supported native APIs and managed Golf sessions. No retained account,
repository, workflow, model usage or infrastructure setting is changed.
Credentials remain in memory; owned native actors and organizations are purged.
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
import urllib.request
import uuid
sys.dont_write_bytecode = True
import smoke


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--golf-url', default=smoke.GOLF)
    parser.add_argument('--skip-browser', action='store_true')
    parser.add_argument('--metadata-unit-only', action='store_true', help='qualify served069 inventory and issue/PR metadata with exact native org units')
    parser.add_argument('--source-unit-only', action='store_true', help='qualify current source native organization-unit authority reads without resource RPCs')
    args = parser.parse_args()
    smoke.GOLF = args.golf_url.rstrip('/')
    os.umask(0o077)
    args.output.mkdir(parents=True, exist_ok=False)
    report = {'passed': False, 'ownedSessionsLoggedOut': False, 'ownedUsersPurged': False, 'ownedOrganizationPurged': False}
    actors, users, organization, native = {}, [], None, None
    try:
        report['servedSourceRevision'] = subprocess.check_output(['docker', 'inspect', 'golf-golf-1', '--format', '{{ index .Config.Labels "io.golf.web.revision" }}'], text=True).strip()
        report['sourceRevision'] = subprocess.check_output(['git', 'rev-parse', 'HEAD'], text=True).strip()
        files = ['internal/server/discussion_resource_operations.go', 'internal/server/discussion_write_authority_test.go', 'internal/server/issue_discussions.go', 'internal/server/repository_labels.go', 'internal/server/repository_milestones.go', 'api/golf/v1/golf.proto', 'web/src/DiscussionResourceControls.tsx', 'scripts/discussion-resources-smoke.py', 'scripts/discussion-resources-browser.mjs']
        report['sourceFilesSha256'] = {p: hashlib.sha256(Path(p).read_bytes()).hexdigest() for p in files}
        prefix = 'golf-resources-'+secrets.token_hex(4)
        for role in ('owner', 'writer', 'reader', 'outsider', 'coder', 'pullwriter'):
            name = prefix+'-'+role
            smoke.admin('create', '--username', name, '--email', name+'@example.invalid', '--random-password', '--must-change-password=false', '--admin=false')
            users.append(name)
            token = smoke.admin('generate-access-token', '--username', name, '--token-name', prefix, '--scopes', 'write:user,write:repository,write:issue,write:organization', '--raw')
            session = smoke.client()
            identity = smoke.rpc(session, 'SessionService/LoginWithGiteaToken', {'token': token})['user']
            actors[role] = dict(name=name, token=token, session=session, id=identity['id'])
        owner = actors['owner']; token = owner['token']; session = owner['session']
        if args.source_unit_only or args.metadata_unit_only:
            organization = prefix+'-org'
            smoke.provider(token, 'POST', 'orgs', {'username': organization, 'visibility': 'private'}, expected=201)
            org_repo = smoke.provider(token, 'POST', 'orgs/'+organization+'/repos', {'name': 'units', 'private': True, 'auto_init': True}, expected=201)
            cases = []
            for role, units, issue_write, pull_write in [('writer', {'repo.code': 'read', 'repo.issues': 'write', 'repo.pulls': 'read'}, True, False), ('coder', {'repo.code': 'write', 'repo.issues': 'read', 'repo.pulls': 'read'}, False, False), ('reader', {'repo.code': 'read', 'repo.issues': 'read', 'repo.pulls': 'read'}, False, False), ('pullwriter', {'repo.code': 'read', 'repo.issues': 'read', 'repo.pulls': 'write'}, False, True)]:
                team = smoke.provider(token, 'POST', 'orgs/'+organization+'/teams', {'name': role, 'permission': 'write' if issue_write or pull_write or role == 'coder' else 'read', 'units_map': units, 'visibility': 'limited', 'includes_all_repositories': False}, expected=201)
                smoke.provider(token, 'PUT', 'teams/'+str(team['id'])+'/members/'+actors[role]['name'], expected=204)
                smoke.provider(token, 'PUT', 'teams/'+str(team['id'])+'/repos/'+org_repo['full_name'], expected=204)
                cases.append({'Role': role, 'Owner': organization, 'Name': 'units', 'RepositoryID': str(org_repo['id']), 'Token': actors[role]['token'], 'Issue': issue_write, 'Pull': pull_write})
            if args.metadata_unit_only:
                full = org_repo['full_name']; route = 'repos/'+full; selected = {'repository': {'owner': organization, 'name': 'units'}, 'repositoryId': str(org_repo['id'])}
                smoke.wait_for_push(token, full)
                label = smoke.provider(token, 'POST', route+'/labels', {'name': 'unit/label', 'color': 'abcdef'}, expected=201)
                milestone = smoke.provider(token, 'POST', route+'/milestones', {'title': 'Unit milestone'}, expected=201)
                native_issue = smoke.provider(token, 'POST', route+'/issues', {'title': 'Preserve unit issue title', 'body': 'Preserve unit issue body'}, expected=201)
                smoke.provider(token, 'POST', route+'/branches', {'new_branch_name': 'unit-feature', 'old_branch_name': org_repo['default_branch']}, expected=201)
                smoke.provider(token, 'POST', route+'/contents/unit.txt', {'branch': 'unit-feature', 'message': 'Own unit fixture', 'content': base64.b64encode(b'Native unit metadata qualification\n').decode()}, expected=201)
                native_pull = smoke.provider(token, 'POST', route+'/pulls', {'title': 'Preserve unit PR title', 'body': 'Preserve unit PR body', 'head': 'unit-feature', 'base': org_repo['default_branch']}, expected=201)
                outcomes=[]
                for case in cases:
                    actor=actors[case['Role']]
                    for is_pull, discussion in [(False,native_issue),(True,native_pull)]:
                        allowed=case['Pull'] if is_pull else case['Issue']; suffix='PullRequest' if is_pull else 'Issue'; field='pullRequest' if is_pull else 'issue'
                        inventories={}
                        for kind,capability in [('Labels','canEditLabels'),('Milestones','canEditMilestone'),('Assignees','canEditAssignees')]:
                            data={**selected,'pullRequest':is_pull}
                            if kind!='Assignees':data['page']={'limit':50}
                            if kind=='Milestones':data['state']='ISSUE_STATE_ALL'
                            inventories[kind]=smoke.rpc(actor['session'],'RepositoryService/ListRepository'+kind,data)
                            assert inventories[kind].get(capability,False)==allowed, 'Served inventory authority differs from exact native unit'
                        for editor in ['labels','milestone','assignees'] if allowed else ['labels']:
                            for clear in [False,True] if allowed else [False]:
                                current=smoke.rpc(actor['session'],'RepositoryService/Get'+suffix,{'repository':selected['repository'],'number':discussion['number']})[field]
                                payload={**selected,'number':current['number'],'expectedRevision':current['revision'],'idempotencyKey':str(uuid.uuid4()),'pullRequestId' if is_pull else 'issueId':current['id']}
                                metadata=current['metadata']
                                if editor=='labels':payload['labels']={'expectedLabelIds':sorted([r['id'] for r in metadata.get('labels',[])],key=int),'labelIds':[] if clear else [str(label['id'])]}
                                if editor=='milestone':payload['milestone']={'expectedMilestoneId':metadata.get('milestone',{}).get('id','0'),'milestoneId':'0' if clear else str(milestone['id'])}
                                if editor=='assignees':
                                    candidate=next(r for r in inventories['Assignees']['assignees'] if r['id']==actors['owner']['id'])
                                    payload['assignees']={'expectedAssigneeIds':sorted([r['id'] for r in metadata.get('assignees',[])],key=int),'assignees':[] if clear else [{'id':candidate['id'],'login':candidate['login']}]}
                                result=smoke.rpc(actor['session'],'RepositoryService/Update'+suffix,payload)
                                assert result['mutation']['state']==('ISSUE_MUTATION_STATE_SUCCEEDED' if allowed else 'ISSUE_MUTATION_STATE_REJECTED'), 'Served metadata edit differs from exact native unit'
                                again=smoke.rpc(actor['session'],'RepositoryService/Update'+suffix,payload)
                                assert again['mutation']==result['mutation'], 'Original metadata intent changed on repetition'
                                outcomes.append({'role':case['Role'],'pullRequest':is_pull,'editor':editor,'clear':clear,'allowed':allowed})
                issue_after=smoke.provider(token,'GET',route+'/issues/'+str(native_issue['number']));pull_after=smoke.provider(token,'GET',route+'/pulls/'+str(native_pull['number']))
                assert issue_after['title']==native_issue['title'] and issue_after['body']==native_issue['body'] and pull_after['title']==native_pull['title'] and pull_after['body']==native_pull['body']
                report.update(passed=True,scope='served069 actual native organization issue/pull-unit inventories and metadata mutations only; no070 resources or served UI',exactOrgUnits=True,metadataUnitOutcomes=outcomes,unrelatedIssuePullTextPreserved=True)
                return
            with (args.output/'source-native-unit-test.log').open('w') as output:
                result = subprocess.run(['go', 'test', '-race', './internal/server', '-run', '^TestDiscussionWriteAuthorityNative$', '-count=1', '-v'], env=os.environ | {'GOLF_TEST_DISCUSSION_UNIT_NATIVE_CASES': json.dumps(cases)}, stdout=output, stderr=subprocess.STDOUT)
            report.update(passed=result.returncode == 0, scope='current source native issue/pull unit authority reads only; no resource RPC or served UI qualification', sourceNativeExitCode=result.returncode, exactOrgUnits=result.returncode == 0)
            assert result.returncode == 0, 'Native organization unit source qualification failed; inspect private sanitized test log'
            return
        native = smoke.provider(token, 'POST', 'user/repos', {'name': 'resources', 'private': True, 'auto_init': True}, expected=201)
        base = 'repos/'+native['full_name']; repo = {'owner': owner['name'], 'name': 'resources'}
        smoke.wait_for_push(token, native['full_name'])
        for role, permission in [('writer', 'write'), ('reader', 'read')]:
            smoke.provider(token, 'PUT', base+'/collaborators/'+actors[role]['name'], {'permission': permission}, expected=204)
        issue = smoke.provider(token, 'POST', base+'/issues', {'title': 'Preserve issue title', 'body': 'Preserve issue description'}, expected=201)
        smoke.provider(token, 'POST', base+'/branches', {'new_branch_name': 'resource-feature', 'old_branch_name': native['default_branch']}, expected=201)
        smoke.provider(token, 'POST', base+'/contents/resource.txt', {'branch': 'resource-feature', 'message': 'Own fixture only', 'content': base64.b64encode(b'Owned resource qualification\n').decode()}, expected=201)
        pull = smoke.provider(token, 'POST', base+'/pulls', {'title': 'Preserve PR title', 'body': 'Preserve PR description', 'head': 'resource-feature', 'base': native['default_branch']}, expected=201)
        target = {'repository': repo, 'repositoryId': str(native['id'])}
        operations = []

        def apply(role, kind, resource=None, change=None, discussion=None, pull_request=False, override_target=None):
            actor = actors[role]; selected = override_target or target
            payload = {**selected, 'operationId': str(uuid.uuid4()), 'kind': 'DISCUSSION_RESOURCE_OPERATION_KIND_'+kind}
            if resource: payload.update(resourceId=resource['id'], expectedRevision=resource['revision'])
            if discussion: payload.update(issueId=str(discussion['id']), number=discussion['number'], pullRequest=pull_request)
            if change: payload.update(change)
            result = smoke.rpc(actor['session'], 'RepositoryService/SubmitDiscussionResourceOperation', payload)
            operation = result['operation']
            assert operation['phase'] == 'DISCUSSION_RESOURCE_OPERATION_PHASE_SUCCEEDED', 'Native outcome is unresolved; original key must not be retried'
            assert operation['operationId'] == payload['operationId'] and operation['repositoryId'] == selected['repositoryId'] and operation['repository'] == selected['repository']
            repeat = smoke.rpc(actor['session'], 'RepositoryService/SubmitDiscussionResourceOperation', payload)
            assert repeat['operation'] == operation and all(k not in repeat for k in ('label', 'milestone', 'comment'))
            inspected = smoke.rpc(actor['session'], 'RepositoryService/GetDiscussionResourceOperation', {'operationId': payload['operationId']})
            assert inspected == {'operation': operation}
            operations.append(dict(kind=kind, role=role, originalInspectionOnly=True))
            return result

        def inventory(label, selected=target, role='owner'):
            procedure = 'RepositoryService/ListRepository'+('Labels' if label else 'Milestones')
            data = {**selected, 'page': {'limit': 50}}
            if not label: data['state'] = 'ISSUE_STATE_ALL'
            result = smoke.rpc(actors[role]['session'], procedure, data)
            return result['labels' if label else 'milestones'], result.get('canManage', False)

        for role in ('owner', 'writer'):
            label = apply(role, 'CREATE_LABEL', change={'label': {'name': role+'/resource', 'color': '123456', 'description': 'Label configuration', 'exclusive': True, 'archived': True}})['label']
            raw = smoke.provider(token, 'GET', base+'/labels/'+label['id']); assert raw['is_archived'] and raw['exclusive'] and raw['description'] == 'Label configuration'
            label = apply(role, 'UPDATE_LABEL', resource=label, change={'label': {'name': role+'/edited', 'color': 'abcdef', 'description': '', 'exclusive': False, 'archived': False}})['label']
            raw = smoke.provider(token, 'GET', base+'/labels/'+label['id']); assert not raw['is_archived'] and not raw['exclusive'] and raw['description'] == ''
            apply(role, 'DELETE_LABEL', resource=label); smoke.provider(token, 'GET', base+'/labels/'+label['id'], expected=404)
            due = '1970-01-01' if role == 'owner' else '2026-12-01'
            milestone = apply(role, 'CREATE_MILESTONE', change={'milestone': {'title': role+' release', 'description': 'Milestone configuration', 'state': 'ISSUE_STATE_CLOSED', 'dueDate': due}})['milestone']
            raw = smoke.provider(token, 'GET', base+'/milestones/'+milestone['id']); assert raw['state'] == 'closed' and raw['due_on'].startswith(due)
            milestone = apply(role, 'UPDATE_MILESTONE', resource=milestone, change={'milestone': {'title': role+' next', 'description': '', 'state': 'ISSUE_STATE_OPEN', 'dueDate': ''}})['milestone']
            raw = smoke.provider(token, 'GET', base+'/milestones/'+milestone['id']); assert raw['state'] == 'open' and raw['description'] == '' and raw.get('due_on') is None
            apply(role, 'DELETE_MILESTONE', resource=milestone); smoke.provider(token, 'GET', base+'/milestones/'+milestone['id'], expected=404)
        for role in ('reader', 'outsider'):
            payload = {**target, 'operationId': str(uuid.uuid4()), 'kind': 'DISCUSSION_RESOURCE_OPERATION_KIND_CREATE_LABEL', 'label': {'name': 'Refused', 'color': 'abcdef'}}
            smoke.rpc(actors[role]['session'], 'RepositoryService/SubmitDiscussionResourceOperation', payload, expected=404 if role == 'outsider' else 403)
        assert not inventory(True, role='reader')[1]
        for role in ('owner', 'writer', 'reader'):
            for discussion, is_pull in ((issue, False), (smoke.provider(token, 'GET', base+'/issues/'+str(pull['number'])), True)):
                native_comment = smoke.provider(actors['reader']['token'], 'POST', base+'/issues/'+str(discussion['number'])+'/comments', {'body': 'Ordinary comment from reader'}, expected=201)
                comments = smoke.rpc(actors[role]['session'], 'RepositoryService/ListIssueComments', {**target, 'issueId': str(discussion['id']), 'number': discussion['number'], 'pullRequest': is_pull, 'page': {'limit': 50}})['comments']
                comment = next(row for row in comments if row['id'] == str(native_comment['id'])); assert comment['canEdit'] and comment['canDelete']
                comment = apply(role, 'UPDATE_COMMENT', resource=comment, change={'commentBody': 'Ordinary edited comment'}, discussion=discussion, pull_request=is_pull)['comment']
                raw = smoke.provider(token, 'GET', base+'/issues/comments/'+comment['id']); assert raw['body'] == 'Ordinary edited comment' and raw['user']['id'] == native_comment['user']['id'] and raw['created_at'] == native_comment['created_at']
                apply(role, 'DELETE_COMMENT', resource=comment, discussion=discussion, pull_request=is_pull); smoke.provider(token, 'GET', base+'/issues/comments/'+comment['id'], expected=404)
        # Exact organization unit permissions: code write does not grant issue metadata rights.
        organization = prefix+'-org'
        smoke.provider(token, 'POST', 'orgs', {'username': organization, 'visibility': 'private'}, expected=201)
        org_repo = smoke.provider(token, 'POST', 'orgs/'+organization+'/repos', {'name': 'units', 'private': True, 'auto_init': True}, expected=201)
        org_target = {'repository': {'owner': organization, 'name': 'units'}, 'repositoryId': str(org_repo['id'])}
        for role, units in [('writer', {'repo.code': 'read', 'repo.issues': 'write', 'repo.pulls': 'read'}), ('pullwriter', {'repo.code': 'read', 'repo.issues': 'read', 'repo.pulls': 'write'}), ('coder', {'repo.code': 'write', 'repo.issues': 'read', 'repo.pulls': 'read'})]:
            team = smoke.provider(token, 'POST', 'orgs/'+organization+'/teams', {'name': role, 'permission': 'write', 'units_map': units, 'visibility': 'limited', 'includes_all_repositories': False}, expected=201)
            smoke.provider(token, 'PUT', 'teams/'+str(team['id'])+'/members/'+actors[role]['name'], expected=204)
            smoke.provider(token, 'PUT', 'teams/'+str(team['id'])+'/repos/'+org_repo['full_name'], expected=204)
        assert inventory(True, org_target, 'writer')[1] and inventory(True, org_target, 'pullwriter')[1] and not inventory(True, org_target, 'coder')[1]
        label = apply('writer', 'CREATE_LABEL', change={'label': {'name': 'unit-writer', 'color': 'abcdef'}}, override_target=org_target)['label']
        denied = {**org_target, 'operationId': str(uuid.uuid4()), 'kind': 'DISCUSSION_RESOURCE_OPERATION_KIND_DELETE_LABEL', 'resourceId': label['id'], 'expectedRevision': label['revision']}
        smoke.rpc(actors['coder']['session'], 'RepositoryService/SubmitDiscussionResourceOperation', denied, expected=403)
        apply('writer', 'DELETE_LABEL', resource=label, override_target=org_target)
        label = apply('pullwriter', 'CREATE_LABEL', change={'label': {'name': 'pull-unit-writer', 'color': 'abcdef'}}, override_target=org_target)['label']
        apply('pullwriter', 'DELETE_LABEL', resource=label, override_target=org_target)
        # Browser uses only owned repositories and the same in-memory managed session.
        if not args.skip_browser:
            for discussion, kind in [(issue, 'issue'), (pull, 'pull')]:
                smoke.provider(token, 'POST', base+'/issues/'+str(discussion['number'])+'/comments', {'body': 'Browser ordinary '+kind}, expected=201)
            cookies = [dict(name=c.name, value=c.value, url=smoke.GOLF, httpOnly=c.has_nonstandard_attr('HttpOnly'), sameSite='Lax') for handler in session.handlers if isinstance(handler, urllib.request.HTTPCookieProcessor) for c in handler.cookiejar]
            browser = {'url': smoke.GOLF+'/'+native['full_name'], 'cookies': cookies, 'repositoryId': str(native['id']), 'issue': str(issue['number']), 'pull': str(pull['number']), 'output': str((args.output/'browser').resolve()), 'forbidden': [a['token'] for a in actors.values()]}
            child = subprocess.run(['node', 'scripts/discussion-resources-browser.mjs'], input=json.dumps(browser), text=True, capture_output=True, timeout=240)
            report['browserExitCode'] = child.returncode
            assert child.returncode == 0, 'Served qualification failed; inspect sanitized browser manifest'
            report['browser'] = json.loads((args.output/'browser/browser-manifest.json').read_text())
            assert report['browser']['passed']
        assert smoke.provider(token, 'GET', base+'/issues/'+str(issue['number']))['body'] == issue['body']
        preserved = smoke.provider(token, 'GET', base+'/pulls/'+str(pull['number'])); assert preserved['title'] == pull['title'] and preserved['body'] == pull['body']
        report.update(passed=True, operations=operations, exactOrgUnits=True, unrelatedIssuePullTextPreserved=True)
    finally:
        errors = []
        for actor in actors.values():
            try: smoke.rpc(actor['session'], 'SessionService/Logout'); smoke.rpc(actor['session'], 'SessionService/GetSession', expected=401)
            except BaseException: errors.append('session_cleanup')
        report['ownedSessionsLoggedOut'] = 'session_cleanup' not in errors
        if organization:
            try:
                for row in smoke.provider(actors['owner']['token'], 'GET', 'orgs/'+organization+'/repos?limit=50'):
                    assert row['name'] == 'units'; smoke.provider(actors['owner']['token'], 'DELETE', 'repos/'+row['full_name'], expected=204)
                smoke.provider(actors['owner']['token'], 'DELETE', 'orgs/'+organization, expected=204)
                smoke.provider(actors['owner']['token'], 'GET', 'orgs/'+organization, expected=404)
                report['ownedOrganizationPurged'] = True
            except BaseException: errors.append('organization_cleanup')
        else: report['ownedOrganizationPurged'] = True
        for name in reversed(users):
            try: smoke.admin('delete', '--username', name, '--purge'); smoke.request(smoke.client(), 'GET', smoke.GITEA+'/api/v1/users/'+name, expected=404)
            except BaseException: errors.append('user_cleanup')
        report['ownedUsersPurged'] = 'user_cleanup' not in errors
        report['cleanupErrors'] = errors
        if errors: report['passed'] = False
        (args.output/'manifest.json').write_text(json.dumps(report, indent=2)+'\n')
        if errors: raise RuntimeError('Owned fixture cleanup incomplete; inspect private receipt')
    print('PASS actual native discussion resource lifecycle, author/unit permissions and served UI; own fixtures cleaned')

if __name__ == '__main__':
    main()
