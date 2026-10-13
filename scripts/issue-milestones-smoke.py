#!/usr/bin/env python3
"""Exercise deployed milestone, label or assignee edits and roles in a disposable private repository.

Supported APIs create all data. Credentials remain in memory; owned sessions and
native accounts are removed afterward. No retained repository or account changes.
"""
import argparse
import base64
import json
import os
from pathlib import Path
import re
import secrets
import subprocess
import sys
import urllib.request
import uuid
sys.dont_write_bytecode = True
import smoke


def ids(values, limit=100):
    result = sorted((str(v) for v in values), key=int)
    assert len(result) <= limit and len(set(result)) == len(result)
    assert all(re.fullmatch(r'[1-9][0-9]{0,18}', v) and int(v) <= 9223372036854775807 for v in result)
    return result


def native_assignee_ids(issue):
    rows = issue.get('assignees')
    if rows is None:
        rows = []
    assert isinstance(rows, list) and all(isinstance(row, dict) and 'id' in row for row in rows)
    return ids([row['id'] for row in rows])


def metadata_change(field, expected, selected):
    if field == 'labels':
        return {'labels': {'expectedLabelIds': ids(expected, 256), 'labelIds': ids(selected, 256)}}
    if field == 'assignees':
        expected = ids(expected)
        assert len(selected) <= 100 and all(set(row) == {'id', 'login'} and isinstance(row['id'], str) and isinstance(row['login'], str) and row['login'] for row in selected)
        assert len({row['login'].casefold() for row in selected}) == len(selected)
        selected = sorted(selected, key=lambda row: int(row['id']))
        ids([row['id'] for row in selected])
        return {'assignees': {'expectedAssigneeIds': expected, 'assignees': selected}}
    assert field == 'milestone'
    return {'milestone': {'expectedMilestoneId': str(expected), 'milestoneId': str(selected)}}


def self_check():
    selected = [{'id': '9007199254740995', 'login': 'second'}, {'id': '2', 'login': 'first'}]
    payload = metadata_change('assignees', ['9007199254740995', '2'], selected)
    assert list(payload) == ['assignees'] and payload['assignees']['expectedAssigneeIds'] == ['2', '9007199254740995']
    assert [row['id'] for row in payload['assignees']['assignees']] == ['2', '9007199254740995']
    assert metadata_change('assignees', [], []) == {'assignees': {'expectedAssigneeIds': [], 'assignees': []}}
    for empty in ({}, {'assignees': None}, {'assignees': []}):
        assert native_assignee_ids(empty) == []
    assert native_assignee_ids({'assignees': [{'id': 9007199254740995}, {'id': 2}]}) == ['2', '9007199254740995']
    for malformed in (False, {}, 'invalid', [None], [{}], [{'id': 1}, {'id': 1}]):
        refused = False
        try:
            native_assignee_ids({'assignees': malformed})
        except AssertionError:
            refused = True
        assert refused
    for invalid in [['0'], ['01'], ['1', '1'], ['9223372036854775808'], list(map(str, range(1, 102)))]:
        refused = False
        try:
            ids(invalid)
        except (AssertionError, ValueError):
            refused = True
        assert refused
    assert len(metadata_change('labels', [], list(map(str, range(1, 257))))['labels']['labelIds']) == 256
    for field, selected in [('labels', list(map(str, range(1, 258)))), ('assignees', [{'id': '1', 'login': 'first'}, {'id': '2', 'login': 'FIRST'}])]:
        refused = False
        try:
            metadata_change(field, [], selected)
        except AssertionError:
            refused = True
        assert refused
    print('PASS pure assignee envelopes, nullable native clear and exact sorted int64 bounds; no runtime operations')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path)
    modes = parser.add_mutually_exclusive_group()
    modes.add_argument('--labels', action='store_true', help='Qualify repository-only label replacement instead of milestones')
    modes.add_argument('--assignees', action='store_true', help='Qualify assignable-user add/replace/clear instead of milestones')
    parser.add_argument('--self-check', action='store_true', help='Check pure request builders without touching the runtime')
    parser.add_argument('--pull', action='store_true', help='Qualify pull-request metadata on a real native pull request')
    args = parser.parse_args()
    if args.self_check:
        self_check()
        return
    if args.output is None:
        parser.error('--output is required for deployed qualification')
    os.umask(0o077)
    args.output.mkdir(parents=True, exist_ok=False)
    report = {'passed': False, 'ownedSessionsLoggedOut': False, 'ownedUsersPurged': False}
    actors = []
    users = []
    native_users = {}
    try:
        report['servedSourceRevision'] = subprocess.check_output(['docker', 'inspect', 'golf-forgejo-golf-1', '--format', '{{ index .Config.Labels "io.golf.web.revision" }}'], text=True).strip()
        field = 'assignees' if args.assignees else 'labels' if args.labels else 'milestone'
        prefix = 'golf-'+field+'-'+secrets.token_hex(4)
        for role in ('owner', 'writer', 'reader', 'outsider'):
            name = prefix+'-'+role
            smoke.admin('create', '--username', name, '--email', name+'@example.invalid', '--random-password', '--must-change-password=false')
            users.append(name)
            token = smoke.admin('generate-access-token', '--username', name, '--token-name', prefix, '--scopes', 'write:user,write:repository,write:issue', '--raw')
            session = smoke.client()
            actors.append((name, token, session))
            smoke.rpc(session, 'SessionService/LoginWithGiteaToken', {'token': token})
            if args.assignees:
                native_users[name] = smoke.provider(token, 'GET', 'user')
        name, token, owner = actors[0]
        repo = {'owner': name, 'name': 'milestones'}
        native = smoke.provider(token, 'POST', 'user/repos', {'name': repo['name'], 'private': True, 'auto_init': True}, expected=201)
        base = 'repos/'+native['full_name']
        for actor, permission in ((actors[1], 'write'), (actors[2], 'read')):
            smoke.provider(token, 'PUT', base+'/collaborators/'+actor[0], {'permission': permission}, expected=204)
        labels = [smoke.provider(token, 'POST', base+'/labels', {'name': 'Label '+label, 'color': 'aabbcc'}, expected=201) for label in ('A', 'B')] if args.labels or args.assignees else []
        milestones = [smoke.provider(token, 'POST', base+'/milestones', {'title': 'Release '+label, 'due_on': '2026-12-01T00:00:00Z'}, expected=201) for label in ('A', 'B')] if not args.labels else []
        if args.pull:
            smoke.provider(token, 'POST', base+'/branches', {'new_branch_name': 'metadata-proof', 'old_branch_name': native['default_branch']}, expected=201)
            smoke.provider(token, 'POST', base+'/contents/metadata-proof.txt', {'branch': 'metadata-proof', 'message': 'Create metadata fixture', 'content': base64.b64encode(b'Metadata fixture\n').decode()}, expected=201)
            pull = smoke.provider(token, 'POST', base+'/pulls', {'title': 'Metadata assignment qualification', 'body': 'Unchanged private description', 'base': native['default_branch'], 'head': 'metadata-proof'}, expected=201)
            number = pull['number']
            initial_metadata = {**({'milestone': milestones[0]['id']} if milestones else {}), **({'assignees': [name]} if args.assignees else {})}
            if initial_metadata:
                smoke.provider(token, 'PATCH', base+'/issues/'+str(number), initial_metadata, expected=201)
            if labels:
                smoke.provider(token, 'PUT', base+'/issues/'+str(number)+'/labels', {'labels': [labels[0]['id']]})
            issue = smoke.provider(token, 'GET', base+'/issues/'+str(number))
        else:
            issue = smoke.provider(token, 'POST', base+'/issues', {'title': 'Metadata assignment qualification', 'body': 'Unchanged private description', **({'labels': [labels[0]['id']]} if labels else {}), **({'milestone': milestones[0]['id']} if milestones else {}), **({'assignees': [name]} if args.assignees else {})}, expected=201)
        baseline = smoke.provider(token, 'GET', base+'/issues/'+str(issue['number']))
        target_field = 'pullRequest' if args.pull else 'issue'
        def read(session=owner):
            return smoke.rpc(session, 'RepositoryService/'+('GetPullRequest' if args.pull else 'GetIssue'), {'repository': repo, 'number': issue['number']})[target_field]
        def change(session, current, expected, selected):
            return smoke.rpc(session, 'RepositoryService/'+('UpdatePullRequest' if args.pull else 'UpdateIssue'), {'repository': repo, 'repositoryId': str(native['id']), ('pullRequestId' if args.pull else 'issueId'): str(pull['id'] if args.pull else issue['id']), 'number': issue['number'], 'expectedRevision': current['revision'], 'idempotencyKey': str(uuid.uuid4()), **metadata_change(field, expected, selected)})
        def pair(actor):
            row = native_users[actor[0]]
            return {'id': str(row['id']), 'login': row['login']}
        original = ids([native_users[name]['id']]) if args.assignees else [str(labels[0]['id'])] if args.labels else milestones[0]['id']
        selected = [pair(actor) for actor in actors[:2]] if args.assignees else [str(row['id']) for row in labels] if args.labels else milestones[1]['id']
        inventory = 'ListRepositoryAssignees' if args.assignees else 'ListRepositoryLabels' if args.labels else 'ListRepositoryMilestones'
        inventory_field = 'assignees' if args.assignees else 'labels' if args.labels else 'milestones'
        capability = 'canEditAssignees' if args.assignees else 'canEditLabels' if args.labels else 'canEditMilestone'
        for actor in actors[:3]:
            result = smoke.rpc(actor[2], 'RepositoryService/'+inventory, {'repository': repo, 'repositoryId': str(native['id']), 'pullRequest': args.pull, **({} if args.assignees else {'page': {'page': 1, 'limit': 20}}), **({'state': 'ISSUE_STATE_ALL'} if field == 'milestone' else {})})
            assert result.get(capability, False) == (actor in actors[:2]), 'Native discussion-write capability mismatch'
            if args.assignees:
                native_inventory = smoke.provider(token, 'GET', base+'/assignees')
                assert len(result.get('assignees', [])) <= 1000 and {(row['id'], row['login']) for row in result.get('assignees', [])} == {(str(row['id']), row['login']) for row in native_inventory}, 'Native assignable inventory mismatch'
                assert all((row['id'], row['login']) in {(str(user['id']), user['login']) for user in native_inventory} for row in selected), 'Owned selected users must actually be assignable'
            else:
                assert {row['id'] for row in result[inventory_field]} == {str(row['id']) for row in (labels if args.labels else milestones)}
        writer_result = change(actors[1][2], read(actors[1][2]), original, selected)
        assert writer_result['mutation']['state'] == 'ISSUE_MUTATION_STATE_SUCCEEDED', 'Native discussion writer refused'
        reset_expected = [row['id'] for row in selected] if args.assignees else selected
        reset_selected = [pair(actors[0])] if args.assignees else original
        assert change(owner, read(), reset_expected, reset_selected)['mutation']['state'] == 'ISSUE_MUTATION_STATE_SUCCEEDED', 'Owner baseline restore failed'
        denied = change(actors[2][2], read(actors[2][2]), original, selected)
        assert denied['mutation']['state'] == 'ISSUE_MUTATION_STATE_REJECTED', 'Reader metadata edit accepted'
        smoke.rpc(actors[3][2], 'RepositoryService/'+inventory, {'repository': repo, 'repositoryId': str(native['id']), 'pullRequest': args.pull}, expected=404)
        if args.assignees:
            denied = change(actors[3][2], read(), original, selected)
            assert denied['mutation']['state'] == 'ISSUE_MUTATION_STATE_REJECTED', 'Outsider assignee mutation accepted'
        stale = change(owner, read(), [] if args.labels or args.assignees else 0, selected)
        assert stale['mutation']['state'] == 'ISSUE_MUTATION_STATE_REJECTED' and stale['mutation']['failureCode'] == 'revision_changed'
        if args.assignees:
            def verify_native(expected_ids):
                actual = smoke.provider(token, 'GET', base+'/issues/'+str(issue['number']))
                assert native_assignee_ids(actual) == ids(expected_ids), 'Native assignee IDs differ'
                assert all(actual[k] == baseline[k] for k in ('id', 'title', 'body', 'state')), 'Assignee mutation changed issue fields'
                assert ids([row['id'] for row in actual.get('labels', [])], 256) == ids([row['id'] for row in baseline.get('labels', [])], 256), 'Assignee mutation changed labels'
                assert (actual.get('milestone') or {}).get('id') == (baseline.get('milestone') or {}).get('id'), 'Assignee mutation changed milestone'
            def apply_assignees(expected_ids, choices):
                for choice in choices:
                    smoke.provider(token, 'GET', base+'/assignees/'+choice['login'], expected=204)
                result = change(owner, read(), expected_ids, choices)
                assert result['mutation']['state'] == 'ISSUE_MUTATION_STATE_SUCCEEDED', 'Assignee edit was not confirmed'
                assert result[target_field]['metadata']['assigneesKnown'] and ids([row['id'] for row in result[target_field]['metadata'].get('assignees', [])]) == ids([row['id'] for row in choices]), 'Assignee receipt IDs differ'
                verify_native([row['id'] for row in choices])
            verify_native(original)
            mismatch = change(owner, read(), original, [{'id': pair(actors[1])['id'], 'login': name}])
            assert mismatch['mutation']['state'] == 'ISSUE_MUTATION_STATE_REJECTED' and mismatch['mutation']['failureCode'] == 'preflight_unavailable', 'ID/login mismatch accepted'
            verify_native(original)
            apply_assignees(original, selected)
            apply_assignees([row['id'] for row in selected], [pair(actors[1])])
            apply_assignees([pair(actors[1])['id']], [])
            report['apiAssigneeChanges'] = ['add', 'replace', 'clear']
            apply_assignees([], [pair(actors[1])])
            smoke.provider(token, 'DELETE', base+'/collaborators/'+actors[1][0], expected=204)
            native_inventory = smoke.provider(token, 'GET', base+'/assignees')
            assert pair(actors[1])['id'] not in {str(row['id']) for row in native_inventory}, 'Removed writer remains assignable'
            smoke.provider(token, 'GET', base+'/assignees/'+actors[1][0], expected=404)
            retained = smoke.provider(token, 'GET', base+'/issues/'+str(issue['number']))
            report['retainedNonassignableUserObserved'] = pair(actors[1])['id'] in native_assignee_ids(retained)
            if report['retainedNonassignableUserObserved']:
                refused = change(owner, read(), [pair(actors[1])['id']], [pair(actors[1])])
                assert refused['mutation']['state'] == 'ISSUE_MUTATION_STATE_REJECTED' and refused['mutation']['failureCode'] == 'preflight_unavailable', 'Nonassignable retained user was retained'
                verify_native([pair(actors[1])['id']])
                apply_assignees([pair(actors[1])['id']], [])
                report['retainedNonassignableRemovalQualified'] = True
            else:
                verify_native([])
                report['retainedNonassignableRemovalQualified'] = False
            smoke.provider(token, 'PUT', base+'/collaborators/'+actors[1][0], {'permission': 'write'}, expected=204)
            apply_assignees([], [pair(actors[0])])
        cookies = [dict(name=c.name, value=c.value, url=smoke.GOLF, httpOnly=c.has_nonstandard_attr('HttpOnly'), sameSite='Lax') for handler in owner.handlers if isinstance(handler, urllib.request.HTTPCookieProcessor) for c in handler.cookiejar]
        config = dict(pull=args.pull, labels=args.labels, assignees=args.assignees, assigneeChoices=selected if args.assignees else [], originalAssigneeIds=original if args.assignees else [], labelNames=[row['name'] for row in labels], labelIds=[str(row['id']) for row in labels], url=smoke.GOLF+'/'+native['full_name']+('/pull/' if args.pull else '/issues/')+str(issue['number']), cookies=cookies, forbidden=[a[1] for a in actors], repositoryId=str(native['id']), issueId=str(issue['id']), pullRequestId=str(pull['id']) if args.pull else '', number=issue['number'], originalId=str(milestones[0]['id']) if milestones else '', selectedId=str(milestones[1]['id']) if milestones else '', output=str((args.output/'browser').resolve()))
        result = subprocess.run(['node', 'scripts/issue-milestone-browser.mjs'], input=json.dumps(config), text=True, capture_output=True, timeout=150)
        assert all(a[1] not in result.stdout+result.stderr for a in actors), 'Child credential diagnostic withheld'
        report['browserExitCode'] = result.returncode
        assert result.returncode == 0, 'Browser qualification failed; inspect sanitized receipt'
        final = smoke.provider(token, 'GET', base+'/issues/'+str(issue['number']))
        if args.assignees:
            verify_native([])
        else:
            assert (not final['labels'] if args.labels else final['milestone'] is None) and all(final[k] == issue[k] for k in ('id', 'title', 'body', 'state')), 'Native clear changed unrelated fields'
        report.update(passed=True, nativeVersion=smoke.provider(token, 'GET', 'version')['version'], roles=['owner/writer admitted', 'reader refused', 'outsider masked'], scope='Actual deployed '+('pull-request' if args.pull else 'issue')+' '+field+' change/clear; native discussion-write admission; not atomic native CAS')
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
    print('PASS actual native/admin '+field+' edits, served browser and owned cleanup')


if __name__ == '__main__':
    main()
