#!/usr/bin/env python3
"""Characterize native human review semantics on disposable private fixtures.

Supported APIs and native account setup only. No Golf mutation qualification,
workflow/model execution, protected merge proof, or atomic-head claims.
Credentials stay in memory and errors omit private payloads.
"""
import base64
import datetime
import json
import secrets
import sys
import time
import urllib.error
import urllib.request

sys.dont_write_bytecode = True
from smoke import GITEA, admin, client, provider, ready, wait_for_push


def probe(token, method, route, payload=None, expected=200, headers=False):
    request = urllib.request.Request(
        GITEA + '/api/v1/' + route, method=method,
        data=None if payload is None else json.dumps(payload).encode(),
        headers={'Authorization': 'token ' + token, 'Content-Type': 'application/json'})
    try:
        response = client().open(request, timeout=20)
    except urllib.error.HTTPError as error:
        response = error
    with response:
        raw = response.read()
        assert response.status == expected, f'Native {method}: HTTP {response.status}, expected {expected}'
        value = json.loads(raw) if raw else None
        return (value, response.headers) if headers else value


def main():
    ready()
    prefix = 'golf-review-probe-' + secrets.token_hex(4)
    users, repositories, actors = [], [], {}
    stage = 'account setup'
    try:
        for role in ['owner', 'author', 'writer', 'reader', 'outsider']:
            name = prefix + '-' + role
            admin('create', '--username', name, '--email', name+'@example.invalid',
                  '--random-password', '--must-change-password=false')
            users.append(name)
            token = admin('generate-access-token', '--username', name, '--token-name', prefix,
                          '--scopes', 'write:user,write:repository', '--raw')
            read = admin('generate-access-token', '--username', name, '--token-name', prefix+'-read',
                         '--scopes', 'read:user,read:repository', '--raw')
            actors[role] = {'name': name, 'token': token, 'read': read,
                            'id': provider(token, 'GET', 'user')['id']}
        owner, author, writer, reader, outsider = [actors[r] for r in actors]
        stage = 'fixture repository'
        repo = provider(owner['token'], 'POST', 'user/repos',
                        {'name': 'private', 'private': True, 'auto_init': True}, expected=201)
        route = 'repos/'+repo['full_name']
        repositories.append((owner['token'], repo['full_name']))
        wait_for_push(owner['token'], repo['full_name'])
        for actor, permission in [(author, 'write'), (writer, 'write'), (reader, 'read')]:
            provider(owner['token'], 'PUT', route+'/collaborators/'+actor['name'],
                     {'permission': permission}, expected=204)

        def create_pull(branch, title='Review semantics'):
            provider(author['token'], 'POST', route+'/branches', {'new_branch_name': branch}, expected=201)
            content = provider(author['token'], 'POST', route+'/contents/'+branch+'.txt',
                               {'branch': branch, 'message': 'Initial review fixture',
                                'content': base64.b64encode(b'first\nsecond\n').decode()}, expected=201)
            pull = provider(author['token'], 'POST', route+'/pulls',
                            {'head': branch, 'base': repo['default_branch'], 'title': title}, expected=201)
            deadline = time.monotonic()+30
            while True:
                rows = provider(owner['read'], 'GET', route+'/commits?sha=refs%2Fpull%2F'+str(pull['number'])+'%2Fhead&limit=1&stat=false&files=false&verification=false')
                if rows and rows[0]['sha'] == content['commit']['sha']:
                    break
                assert time.monotonic() < deadline, 'New native retained head failed to settle'
                time.sleep(.2)
            return pull, content

        pull, content = create_pull('review-head')
        proute = route+'/pulls/'+str(pull['number'])
        head = content['commit']['sha']

        def retained(expected):
            deadline = time.monotonic()+30
            while True:
                rows = provider(owner['read'], 'GET', route+'/commits?sha=refs%2Fpull%2F'+str(pull['number'])+'%2Fhead&limit=1&stat=false&files=false&verification=false')
                if rows and rows[0]['sha'] == expected:
                    return
                assert time.monotonic() < deadline, 'Retained native head failed to settle'
                time.sleep(.2)

        def review(actor, event, body='', commit=None, comments=None, expected=200, target=proute):
            payload = {'event': event, 'body': body, 'commit_id': head if commit is None else commit}
            if comments is not None:
                payload['comments'] = comments
            result = probe(actor['token'], 'POST', target+'/reviews', payload, expected=expected)
            if expected == 200:
                assert result['id'] > 0 and result['user']['id'] == actor['id']
                assert result['user']['login'] == actor['name']
                assert result['state'] == event and result['body'] == body
                assert result['commit_id'] == payload['commit_id'] or not payload['commit_id']
                assert isinstance(result['comments_count'], int)
                for field in ['submitted_at', 'updated_at']:
                    datetime.datetime.fromisoformat(result[field].replace('Z', '+00:00'))
                reread = provider(actor['read'], 'GET', target+'/reviews/'+str(result['id']))
                for field in ['id', 'state', 'body', 'commit_id', 'comments_count']:
                    assert reread[field] == result[field], 'Independent native review receipt differs'
            return result

        retained(head)
        stage = 'event/body/self permissions'
        review(author, 'COMMENT', 'Author commentary')
        review(author, 'APPROVED', expected=422)
        review(author, 'REQUEST_CHANGES', 'Self rejection', expected=422)
        for event in ['COMMENT', 'REQUEST_CHANGES']:
            review(writer, event, '   ', expected=422)
        approved = review(writer, 'APPROVED')
        assert approved['official'] and not approved['stale'] and not approved['dismissed']
        request = review(writer, 'REQUEST_CHANGES', 'Please revise')
        assert request['official']
        assert not provider(writer['read'], 'GET', proute+'/reviews/'+str(approved['id']))['official']
        read_approval = review(reader, 'APPROVED')
        assert not read_approval['official']
        review(reader, 'REQUEST_CHANGES', 'Reader feedback')
        review(outsider, 'COMMENT', 'Denied', expected=404)
        probe(writer['read'], 'POST', proute+'/reviews', {'event': 'COMMENT', 'body': 'Denied', 'commit_id': head}, expected=403)
        print('PASS: exact review events/receipts, author/self restrictions, whitespace, reader unofficial approval, writer official decision, scope/private denial', flush=True)

        stage = 'draft/closed/merged semantics'
        draft, _ = create_pull('draft-head', '[WIP] Draft review')
        stage = 'draft flag'
        assert draft['draft']
        droute = route+'/pulls/'+str(draft['number'])
        stage = 'draft approve'
        review(writer, 'APPROVED', commit=draft['head']['sha'], target=droute)
        stage = 'draft reject'
        review(writer, 'REQUEST_CHANGES', 'Draft feedback', commit=draft['head']['sha'], target=droute)
        stage = 'close draft'
        provider(author['token'], 'PATCH', droute, {'state': 'closed'}, expected=201)
        stage = 'closed comment'
        review(writer, 'COMMENT', 'Closed commentary', commit=draft['head']['sha'], target=droute)
        stage = 'closed approve/reject'
        review(writer, 'APPROVED', commit=draft['head']['sha'], target=droute, expected=422)
        review(writer, 'REQUEST_CHANGES', 'Closed reject', commit=draft['head']['sha'], target=droute, expected=422)
        merged, _ = create_pull('merge-head')
        mroute = route+'/pulls/'+str(merged['number'])
        stage = 'fixture merge'
        # One ordinary owner/native unprotected fixture merge; not Golf protected publication.
        probe(owner['token'], 'POST', mroute+'/merge', {'Do': 'merge', 'head_commit_id': merged['head']['sha']})
        assert provider(owner['read'], 'GET', mroute)['merged']
        stage = 'merged comment'
        review(writer, 'COMMENT', 'Merged commentary', commit=merged['head']['sha'], target=mroute)
        review(writer, 'APPROVED', commit=merged['head']['sha'], target=mroute, expected=422)
        review(writer, 'REQUEST_CHANGES', 'Merged reject', commit=merged['head']['sha'], target=mroute, expected=422)
        print('PASS: draft approval/rejection allowed; closed/merged comments allowed while approval/rejection refused', flush=True)

        stage = 'pinned old head after advance'
        old = head
        changed = provider(author['token'], 'PUT', route+'/contents/review-head.txt',
                           {'branch': 'review-head', 'sha': content['content']['sha'],
                            'message': 'Advance reviewed head', 'content': base64.b64encode(b'changed\nsecond\n').decode()})
        head = changed['commit']['sha']; retained(head)
        old_comment = review(writer, 'COMMENT', 'Explicit older snapshot', commit=old)
        assert not old_comment['stale'] and old_comment['commit_id'] == old
        old_approval = review(writer, 'APPROVED', commit=old)
        assert old_approval['stale'] and old_approval['commit_id'] == old
        latest = review(writer, 'COMMENT', 'Implicit current snapshot', commit='')
        assert latest['commit_id'] == head
        print('PASS: supplied old head persists after native head advance; old approval marked stale; old COMMENT stale=false; absent head selects current retained head', flush=True)

        stage = 'pending comments absorption/line receipts'
        pending = review(writer, 'PENDING', 'Native pending draft', comments=[
            {'path': 'review-head.txt', 'body': 'New-side draft', 'new_position': 1, 'old_position': 0},
            {'path': 'review-head.txt', 'body': 'Old-side draft', 'old_position': 1, 'new_position': 0}])
        assert pending['comments_count'] == 2
        comments = provider(writer['read'], 'GET', proute+'/reviews/'+str(pending['id'])+'/comments')
        assert len(comments) == 2
        for comment in comments:
            assert comment['id'] > 0 and comment['pull_request_review_id'] == pending['id']
            assert comment['path'] == 'review-head.txt' and comment['user']['id'] == writer['id']
        assert {c['body']: (c['position'], c['original_position']) for c in comments} == {
            'New-side draft': (1, 0), 'Old-side draft': (0, 1)}
        absorbed = review(writer, 'COMMENT', 'Body-only submission')
        assert absorbed['id'] == pending['id'] and absorbed['comments_count'] == 2
        print('PASS: real new/old line receipts and body-only POST submits existing native pending comments using the same review ID', flush=True)
        stage = 'explicit malformed commit/comment and unknown event behavior'
        # COMMENT itself does not validate a commit object; never expose this as Golf authority.
        arbitrary = review(reader, 'COMMENT', 'Unvalidated native commit', commit='f'*40)
        assert arbitrary['commit_id'] == 'f'*40
        unknown = probe(reader['token'], 'POST', proute+'/reviews',
                        {'event': 'NOT_AN_EVENT', 'body': 'Unknown native event', 'commit_id': head})
        assert unknown['state'] == 'PENDING'
        print('PASS: native COMMENT stores nonexistent full SHA and unknown event defaults to pending; Golf must validate exact commit/event itself', flush=True)
        stage = 'hidden pending native pagination'
        current_pending = review(writer, 'PENDING', 'Own pending after hidden draft')
        first, headers = probe(writer['read'], 'GET', proute+'/reviews?limit=1&page=1', headers=True)
        total = int(headers['X-Total-Count'])
        assert total > 1 and len(first) <= 1
        empty_before_own = False
        found = False
        for page in range(1, total+1):
            rows, observed_headers = probe(writer['read'], 'GET', proute+'/reviews?limit=1&page='+str(page), headers=True)
            assert int(observed_headers['X-Total-Count']) == total and len(rows) <= 1
            if not rows and not found:
                empty_before_own = True
            if any(row['id'] == current_pending['id'] for row in rows):
                found = True
        assert empty_before_own and found
        print('PASS: native visible page can be empty before own pending review; total counts hidden drafts and full total-driven scan finds own draft', flush=True)
        provider(writer['token'], 'DELETE', proute+'/reviews/'+str(current_pending['id']), expected=204)
        stage = 'native repeat submissions'
        first_repeat = review(writer, 'COMMENT', 'Same repeated native body')
        second_repeat = review(writer, 'COMMENT', 'Same repeated native body')
        assert first_repeat['id'] != second_repeat['id']
        print('PASS: identical native POSTs create two distinct review IDs; Golf must persist intents before dispatch and avoid resending unknown outcomes', flush=True)
        print('PASS: supported native human review characterization complete; no Golf review/merge authority claim', flush=True)
    except Exception as error:
        # Do not emit provider bodies, token-bearing request objects or fixture payloads.
        raise RuntimeError('Native review probe failed at '+stage+' ('+type(error).__name__+'); private diagnostics withheld') from None
    finally:
        for token, full in reversed(repositories):
            provider(token, 'DELETE', 'repos/'+full, expected=204)
        for name in reversed(users):
            admin('delete', '--username', name, '--purge')
        print('Disposable native-review users/repository purged.', flush=True)


if __name__ == '__main__':
    main()
