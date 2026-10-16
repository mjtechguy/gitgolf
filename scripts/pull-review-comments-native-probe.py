#!/usr/bin/env python3
"""Characterize native inline review comments on owned disposable fixtures.

Only supported APIs/native account setup. No Golf mutation, protected merge,
workflow/inference, native storage edits, or remote organization writes.
"""
import base64
import datetime
import re
import secrets
import sys
import time
from urllib.parse import quote, urlsplit
from runpy import run_path

sys.dont_write_bytecode = True
from smoke import FORGE, ROOT, admin, client, provider, ready, request, wait_for_push
probe = run_path(str(ROOT/'scripts/pull-review-native-probe.py'))['probe']


def main():
    ready()
    assert request(client(), 'GET', FORGE+'/api/v1/version')['version'] == '15.0.9+gitea-1.22.0', 'Native version outside qualified contract'  # Forgejo's upstream version string
    prefix = 'golf-inline-probe-' + secrets.token_hex(4)
    users, actors, repositories = [], {}, []
    stage = 'accounts'
    try:
        for role in ['owner', 'author', 'reviewer', 'reader', 'outsider']:
            name = prefix+'-'+role
            admin('create', '--username', name, '--email', name+'@example.invalid',
                  '--random-password', '--must-change-password=false')
            users.append(name)
            token = admin('generate-access-token', '--username', name, '--token-name', prefix,
                          '--scopes', 'write:user,write:repository', '--raw')
            read = admin('generate-access-token', '--username', name, '--token-name', prefix+'-read',
                         '--scopes', 'read:user,read:repository', '--raw')
            actors[role] = {'name': name, 'token': token, 'read': read,
                            'id': provider(token, 'GET', 'user')['id']}
        owner, author, reviewer, reader, outsider = [actors[r] for r in actors]
        stage = 'native private source'
        repo = provider(owner['token'], 'POST', 'user/repos',
                        {'name': 'private', 'private': True, 'auto_init': True}, expected=201)
        full, route = repo['full_name'], 'repos/'+repo['full_name']
        repositories.append((owner['token'], full)); wait_for_push(owner['token'], full)
        for actor, permission in [(author, 'write'), (reviewer, 'write'), (reader, 'read')]:
            provider(owner['token'], 'PUT', route+'/collaborators/'+actor['name'],
                     {'permission': permission}, expected=204)
        path = 'review.txt'
        unicode_path = 'dir/[literal]* 世界.txt'
        def content(actor, method, name, branch, text=None, sha=None, **extra):
            payload = {'branch': branch, 'message': 'Inline qualification fixture', **extra}
            if text is not None:
                payload['content'] = base64.b64encode(text.encode()).decode()
            if sha is not None:
                payload['sha'] = sha
            return provider(actor['token'], method, route+'/contents/'+quote(name, safe='/'),
                            payload, expected=201 if method == 'POST' else 200)
        baseline = content(owner, 'POST', path, repo['default_branch'], 'old one\nstable two\nold three\n')
        content(owner, 'POST', unicode_path, repo['default_branch'], 'unicode baseline\n')
        provider(author['token'], 'POST', route+'/branches', {'new_branch_name': 'inline-head'}, expected=201)
        changed = content(author, 'PUT', path, 'inline-head', 'new one\nstable two\nold three\nadded four\n', baseline['content']['sha'])
        head = changed['commit']['sha']
        pull = provider(author['token'], 'POST', route+'/pulls',
                        {'head': 'inline-head', 'base': repo['default_branch'], 'title': 'Inline semantics'}, expected=201)
        proute = route+'/pulls/'+str(pull['number'])
        def retained(expected):
            deadline = time.monotonic()+30
            while True:
                rows = provider(owner['read'], 'GET', route+'/commits?sha=refs%2Fpull%2F'+str(pull['number'])+'%2Fhead&limit=1&stat=false&files=false&verification=false')
                if rows and rows[0]['sha'] == expected:
                    return
                assert time.monotonic() < deadline, 'Retained native head failed to settle'
                time.sleep(.2)
        retained(head)
        def review(actor, event, summary, comments):
            row = provider(actor['token'], 'POST', proute+'/reviews',
                           {'event': event, 'body': summary, 'commit_id': head, 'comments': comments})
            assert row['id'] > 0 and row['commit_id'] == head and row['state'] == event
            return row
        def rows(actor, review_id, query='', expected=200):
            return probe(actor['read'], 'GET', proute+'/reviews/'+str(review_id)+'/comments'+query,
                         expected=expected, headers=True)
        def validate(row, review_id):
            assert set(row) == {'id', 'body', 'user', 'resolver', 'pull_request_review_id', 'created_at', 'updated_at',
                                'path', 'commit_id', 'original_commit_id', 'diff_hunk', 'position',
                                'original_position', 'html_url', 'pull_request_url'}
            assert row['id'] > 0 and row['pull_request_review_id'] == review_id
            assert isinstance(row['body'], str) and row['user']['id'] > 0
            assert isinstance(row['diff_hunk'], str) and isinstance(row['path'], str)
            assert row['position'] >= 0 and row['original_position'] >= 0
            assert not (row['position'] > 0 and row['original_position'] > 0)
            assert re.fullmatch('[a-f0-9]{40}|[a-f0-9]{64}', row['commit_id'])
            assert not row['original_commit_id'] or re.fullmatch('[a-f0-9]{40}|[a-f0-9]{64}', row['original_commit_id'])
            for field in ['created_at', 'updated_at']:
                datetime.datetime.fromisoformat(row[field].replace('Z', '+00:00'))
            assert row['pull_request_url'] == pull['html_url']
            assert urlsplit(row['html_url']).path in [urlsplit(pull['html_url']).path, urlsplit(pull['html_url']).path+'/files']
            assert urlsplit(row['html_url']).fragment == 'issuecomment-'+str(row['id'])

        stage = 'submitted inline exact schema and snapshot'
        submitted = review(reviewer, 'COMMENT', 'Inline review', [
            {'path': path, 'body': 'New-side changed line', 'new_position': 1, 'old_position': 0},
            {'path': path, 'body': 'Old-side removed line', 'new_position': 0, 'old_position': 1},
            {'path': path, 'body': 'Unchanged new-side line', 'new_position': 2, 'old_position': 0},
            {'path': unicode_path, 'body': 'Unicode literal path', 'new_position': 1, 'old_position': 0}])
        initial, headers = rows(reviewer, submitted['id'])
        assert len(initial) == 4 and submitted['comments_count'] == 4
        for row in initial:
            validate(row, submitted['id']); assert row['resolver'] is None
        by_body = {r['body']: r for r in initial}
        assert (by_body['New-side changed line']['position'], by_body['New-side changed line']['original_position']) == (1, 0)
        assert (by_body['Old-side removed line']['position'], by_body['Old-side removed line']['original_position']) == (0, 1)
        assert by_body['Unchanged new-side line']['commit_id'] == baseline['commit']['sha'] != head
        assert all(row['original_commit_id'] == '' for row in initial)
        assert any(row['diff_hunk'].startswith('@@') for row in initial)
        assert all(not headers.get(field) for field in ['X-Total-Count', 'Link'])
        published_read, _ = rows(reader, submitted['id']); assert {r['id'] for r in published_read} == {r['id'] for r in initial}
        rows(outsider, submitted['id'], expected=404)
        probe(reader['read'], 'GET', proute+'/reviews/'+str(submitted['id']+999999)+'/comments', expected=404)
        provider(author['token'], 'POST', route+'/branches', {'new_branch_name': 'other-head'}, expected=201)
        content(author, 'POST', 'other.txt', 'other-head', 'other\n')
        other = provider(author['token'], 'POST', route+'/pulls',
                         {'head': 'other-head', 'base': repo['default_branch'], 'title': 'Other PR'}, expected=201)
        other_route = route+'/pulls/'+str(other['number'])
        probe(reader['read'], 'GET', other_route+'/reviews/'+str(submitted['id'])+'/comments', expected=404)
        print('PASS: exact inline schema, old/new absolute positions, Unicode path, blame commit distinct from selected review head, empty original_commit_id, private/PR/review binding', flush=True)

        stage = 'native inline body and side precedence'
        permissive = review(reader, 'COMMENT', 'Native field bounds', [
            {'path': path, 'body': 'x'*8192, 'new_position': 2},
            {'path': path, 'body': '', 'old_position': 1, 'new_position': 2}])
        permissive_rows, _ = rows(reader, permissive['id'])
        assert len(permissive_rows) == 2
        assert any(len(r['body']) == 8192 and r['body'] == 'x'*8192 for r in permissive_rows)
        assert any(r['body'] == '' and r['position'] == 0 and r['original_position'] == 1 for r in permissive_rows)
        print('PASS: native inline body preserves8192 bytes and empty text; both-side input chooses old side, not a range', flush=True)

        stage = 'native whole-array pagination'
        bulk = review(reviewer, 'COMMENT', 'Whole-array proof', [
            {'path': path, 'body': 'Bounded fixture comment '+str(i), 'new_position': 4} for i in range(53)])
        whole, _ = rows(reviewer, bulk['id']); assert len(whole) == 53
        original_ids = {row['id'] for row in whole}; assert len(original_ids) == 53
        for query in ['?limit=1&page=1', '?limit=1&page=2', '?limit=100&page=9999']:
            observed, observed_headers = rows(reader, bulk['id'], query)
            assert {row['id'] for row in observed} == original_ids
            assert not observed_headers.get('X-Total-Count') and not observed_headers.get('Link')
        print('PASS: all53 comments returned despite native maximum50 and limit1/page9999; no pagination/count headers', flush=True)

        stage = 'reply receipt and permission'
        parent = by_body['New-side changed line']
        reply = provider(reader['token'], 'POST', proute+'/comments/'+str(parent['id'])+'/replies', {'body': 'Reader reply'}, expected=201)
        validate(reply, submitted['id'])
        assert reply['user']['id'] == reader['id'] and reply['path'] == parent['path']
        assert reply['position'] == parent['position'] and reply['body'] == 'Reader reply'
        replied, _ = rows(reader, submitted['id']); assert len(replied) == 5 and any(r['id'] == reply['id'] for r in replied)
        assert provider(reader['read'], 'GET', proute+'/reviews/'+str(submitted['id']))['comments_count'] == 5
        probe(reader['token'], 'POST', other_route+'/comments/'+str(parent['id'])+'/replies', {'body': 'Wrong PR'}, expected=404)
        probe(reader['read'], 'POST', proute+'/comments/'+str(parent['id'])+'/replies', {'body': 'Read token denied'}, expected=403)
        probe(outsider['token'], 'POST', proute+'/comments/'+str(parent['id'])+'/replies', {'body': 'Private denied'}, expected=404)
        probe(reader['token'], 'POST', proute+'/comments/'+str(parent['id'])+'/replies', {'body': ''}, expected=422)
        print('PASS: reader reply accepted with original review/path/line, review count includes replies, wrong-PR/private/scope/empty-body denial; no parentID receipt', flush=True)

        stage = 'resolution receipts and permission'
        resolve_route = route+'/pulls/comments/'+str(parent['id'])
        stage = 'reader resolution permission'
        probe(reader['token'], 'POST', resolve_route+'/resolve', expected=403)
        stage = 'author resolution permission'
        probe(author['token'], 'POST', resolve_route+'/resolve', expected=204)
        stage = 'group resolution receipt'
        resolved, _ = rows(reader, submitted['id'])
        same_line = [r for r in resolved if r['path'] == parent['path'] and r['position'] == 1]
        print('Observed resolver flags on parent/reply: '+str([(r['id']==parent['id'], bool(r['resolver']), bool(r['resolver'] and r['resolver']['id']==author['id'])) for r in same_line]), flush=True)
        assert same_line and any(r['id']==parent['id'] and r['resolver'] and r['resolver']['id']==author['id'] for r in same_line)
        stage = 'writer unresolution permission'
        probe(reviewer['token'], 'POST', resolve_route+'/unresolve', expected=204)
        opened, _ = rows(reader, submitted['id'])
        assert all(r['resolver'] is None for r in opened if r['path'] == parent['path'] and r['position'] == 1)
        print('PASS: reader resolution refused, PR author resolves parent, writer reopens; resolver receipts checked without inventing global thread state', flush=True)

        stage = 'pending privacy and known-ID reply'
        pending = review(reviewer, 'PENDING', 'Private pending summary', [
            {'path': path, 'body': 'Private pending inline', 'new_position': 3}])
        own_pending, _ = rows(reviewer, pending['id']); assert len(own_pending) == 1
        validate(own_pending[0], pending['id'])
        assert own_pending[0]['html_url'] == pull['html_url']+'/files#issuecomment-'+str(own_pending[0]['id'])
        for actor in [owner, author, reader]:
            rows(actor, pending['id'], expected=404)
        pending_reply = provider(reader['token'], 'POST', proute+'/comments/'+str(own_pending[0]['id'])+'/replies',
                                 {'body': 'Known-ID pending reply'}, expected=201)
        validate(pending_reply, pending['id'])
        own_after, _ = rows(reviewer, pending['id']); assert len(own_after) == 2
        assert any(r['id'] == pending_reply['id'] for r in own_after)
        rows(reader, pending['id'], expected=404)
        print('PASS: foreign pending GET404, but known-parent reader reply201 appends to hidden pending review; Golf must preflight parent-review visibility itself', flush=True)
        provider(reviewer['token'], 'DELETE', proute+'/reviews/'+str(pending['id']), expected=204)

        stage = 'retained comments after head advance and path lifecycle'
        moved = content(author, 'PUT', path, 'inline-head', 'later one\nstable two\nold three\nadded four\n', changed['content']['sha'])
        retained(moved['commit']['sha'])
        after_move, _ = rows(reader, submitted['id'])
        indexed = {r['id']: r for r in after_move}
        for old in initial:
            new = indexed[old['id']]
            for field in ['body', 'path', 'position', 'original_position', 'commit_id', 'original_commit_id', 'diff_hunk']:
                assert new[field] == old[field]
        # Supported content move uses from_path on the destination route.
        renamed = content(author, 'PUT', 'renamed.txt', 'inline-head', 'later one\nstable two\nold three\nadded four\n', moved['content']['sha'], from_path=path)
        retained(renamed['commit']['sha'])
        content(author, 'DELETE', 'renamed.txt', 'inline-head', sha=renamed['content']['sha'])
        latest = provider(author['read'], 'GET', route+'/branches/inline-head')['commit']['id']; retained(latest)
        retained_rows, _ = rows(reader, submitted['id'])
        assert {r['id'] for r in retained_rows} == {r['id'] for r in after_move}
        assert all(r['path'] == path for r in retained_rows if r['id'] in {r['id'] for r in initial if r['path'] == path})
        assert all('outdated' not in r and 'resolved' not in r and 'in_reply_to_id' not in r for r in retained_rows)
        final_index = {r['id']: r for r in retained_rows}
        for old in initial:
            for field in ['body', 'path', 'position', 'original_position', 'commit_id', 'original_commit_id', 'diff_hunk']:
                assert final_index[old['id']][field] == old[field]
        print('PASS: original inline path/positions/commits/hunk remain readable after head change, rename and deletion; endpoint gives no explicit outdated/current position', flush=True)
        stage = 'deleted resolver retains resolution observation'
        probe(author['token'], 'POST', resolve_route+'/resolve', expected=204)
        admin('delete', '--username', author['name'], '--purge'); users.remove(author['name'])
        ghost_rows, _ = rows(reader, submitted['id'])
        ghost_parent = next(r for r in ghost_rows if r['id'] == parent['id'])
        assert ghost_parent['resolver'] is not None and ghost_parent['resolver']['id'] == -1
        print('PASS: deleted resolver appears as nonnull ghost ID-1; dropping identity must not turn resolved observation into unresolved', flush=True)
        print('PASS: native inline-comment characterization complete; no Golf read/write or protected integration qualification claim', flush=True)
    except Exception as error:
        raise RuntimeError('Native inline probe failed at '+stage+' ('+type(error).__name__+'); private diagnostics withheld') from None
    finally:
        cleanup_errors = []
        for token, full in reversed(repositories):
            try:
                provider(token, 'DELETE', 'repos/'+full, expected=204)
            except Exception:
                cleanup_errors.append('repository')
        for name in reversed(users):
            try:
                admin('delete', '--username', name, '--purge')
            except Exception:
                cleanup_errors.append('account')
        if cleanup_errors:
            raise RuntimeError('Native inline fixture cleanup incomplete; private diagnostics withheld') from None
        print('Disposable native inline-comment users/repositories purged.', flush=True)


if __name__ == '__main__':
    main()
