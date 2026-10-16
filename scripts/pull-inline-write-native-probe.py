#!/usr/bin/env python3
"""Characterize native inline snapshot, draft and partial-write semantics.

Supported APIs and native account setup only. No Golf mutation qualification,
native storage edits, workflows/inference, merge or remote organization writes.
"""
import base64
import argparse
import json
import os
from pathlib import Path
import secrets
import re
import subprocess
import sys
import tempfile
import time
import urllib.request
from runpy import run_path
from urllib.parse import quote

sys.dont_write_bytecode = True
from smoke import ROOT, FORGE, admin as default_admin, client, command, provider, ready, request, wait_for_push

probe = run_path(str(ROOT/'scripts/pull-review-native-probe.py'))['probe']


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--parser-proof', action='store_true', help='Check the strict Go parser against supported native API contexts; no provider execution')
    parser.add_argument('--stack-root', type=Path, help='Existing Compose project directory for account setup when the probe source is in a worktree')
    args = parser.parse_args()
    stack_root = args.stack_root.resolve() if args.stack_root else None
    if stack_root:
        assert (stack_root/'compose.yaml').is_file() and (stack_root/'.env').is_file(), 'Existing stack Compose/environment files required'

    def admin(*values):
        if stack_root:
            return command('docker', 'compose', '--project-directory', str(stack_root), '--file', str(stack_root/'compose.yaml'),
                           '--env-file', str(stack_root/'.env'), 'exec', '-T', 'forgejo', 'forgejo',
                           '--config', '/var/lib/gitea/custom/conf/app.ini', 'admin', 'user', *values)  # Forgejo's upstream path
        return default_admin(*values)

    def raw_diff(token, route):
        req = urllib.request.Request(FORGE+'/api/v1/'+route+'.diff', headers={'Authorization': 'token '+token})
        with client().open(req, timeout=20) as response:
            assert response.status == 200
            raw = response.read(512*1024+1)
            assert len(raw) <= 512*1024, 'Bounded native diff required'
            return raw.decode('utf-8')

    def parser_proof(original, current, baseline_row, stale_row):
        assert baseline_row['path'] == stale_row['path'] == path and baseline_row['position'] == stale_row['position'] == 1
        rows = [
            {'name': 'selected-original-context', 'diff': original, 'path': path, 'line': 1, 'hunk': baseline_row['diff_hunk'], 'matches': True},
            {'name': 'historical-selected-current-context', 'diff': original, 'path': path, 'line': 1, 'hunk': stale_row['diff_hunk'], 'matches': False},
            {'name': 'current-context', 'diff': current, 'path': path, 'line': 1, 'hunk': stale_row['diff_hunk'], 'matches': True},
        ]
        # Synthetic private contents, not credentials, cross into the Go test
        # via an owner-only temporary file and are removed on every outcome.
        with tempfile.TemporaryDirectory(prefix='golf-native-review-parser-') as directory:
            target = Path(directory)/'proof.json'
            descriptor = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            with os.fdopen(descriptor, 'w') as stream:
                json.dump({'cases': rows}, stream)
            env = {**os.environ, 'GOLF_REVIEW_DIFF_NATIVE_PROOF': str(target)}
            result = subprocess.run(['go', 'test', './internal/server', '-run', '^TestReviewComparisonNativeProof$', '-count=1'],
                                    cwd=ROOT, env=env, capture_output=True, text=True, timeout=120)
            assert result.returncode == 0, 'Strict native parser proof failed (private output withheld)'
        print('PASS: strict Go parser admits actual selected M→H same-path context and rejects historical selected-head/current-hunk mixture; current-context positive control passes', flush=True)

    ready()
    assert request(client(), 'GET', FORGE+'/api/v1/version')['version'] == '15.0.9+gitea-1.22.0'  # Forgejo's upstream version string
    prefix = 'golf-inline-write-'+secrets.token_hex(4)
    users, repositories, actors = [], [], {}
    stage = 'accounts'
    try:
        for role in ('owner', 'author', 'reviewer', 'reader', 'outsider'):
            name = prefix+'-'+role
            admin('create', '--username', name, '--email', name+'@example.invalid',
                  '--random-password', '--must-change-password=false')
            users.append(name)
            token = admin('generate-access-token', '--username', name, '--token-name', prefix,
                          '--scopes', 'write:user,write:repository', '--raw')
            read = admin('generate-access-token', '--username', name, '--token-name', prefix+'-read',
                         '--scopes', 'read:user,read:repository', '--raw')
            actors[role] = {'name': name, 'token': token, 'read': read,
                            'id': provider(read, 'GET', 'user')['id']}
        owner, author, reviewer, reader, outsider = [actors[r] for r in actors]
        stage = 'diverged base and source'
        repo = provider(owner['token'], 'POST', 'user/repos',
                        {'name': 'private', 'private': True, 'auto_init': True}, expected=201)
        full = repo['full_name']; route = 'repos/'+full
        repositories.append((owner['token'], full)); wait_for_push(owner['token'], full)
        for actor, permission in ((author, 'write'), (reviewer, 'write'), (reader, 'read')):
            provider(owner['token'], 'PUT', route+'/collaborators/'+actor['name'],
                     {'permission': permission}, expected=204)
        path = 'context.txt'

        def content(actor, method, branch, text, sha=None):
            body = {'branch': branch, 'message': 'Inline snapshot fixture',
                    'content': base64.b64encode(text.encode()).decode()}
            if sha: body['sha'] = sha
            return provider(actor['token'], method, route+'/contents/'+quote(path, safe='/'),
                            body, expected=201 if method == 'POST' else 200)

        stage = 'initial source content'
        initial = content(owner, 'POST', repo['default_branch'], 'merge-base one\nmerge-base two\nstable three\n')
        merge_base = initial['commit']['sha']
        stage = 'feature branch'
        provider(author['token'], 'POST', route+'/branches', {'new_branch_name': 'inline-head'}, expected=201)
        stage = 'divergent base update'
        advanced_base = content(owner, 'PUT', repo['default_branch'], 'base-tip one\nmerge-base two\nstable three\n', initial['content']['sha'])
        base_tip = advanced_base['commit']['sha']
        stage = 'selected head update'
        selected = content(author, 'PUT', 'inline-head', 'selected-head one\nmerge-base two\nstable three\n', initial['content']['sha'])
        chosen = selected['commit']['sha']
        stage = 'divergent PR creation'
        pull = provider(author['token'], 'POST', route+'/pulls',
                        {'head': 'inline-head', 'base': repo['default_branch'], 'title': 'Inline write semantics'}, expected=201)
        proute = route+'/pulls/'+str(pull['number'])

        def settled(head):
            deadline = time.monotonic()+40
            while True:
                row = provider(owner['read'], 'GET', proute)
                retained = provider(owner['read'], 'GET', route+'/commits?sha=refs%2Fpull%2F'+str(pull['number'])+'%2Fhead&limit=1&stat=false&files=false&verification=false')
                if row['head']['sha'] == head and row['base']['sha'] == base_tip and row['merge_base'] == merge_base and retained and retained[0]['sha'] == head:
                    return row
                assert time.monotonic() < deadline, 'Native snapshot did not settle'
                time.sleep(.2)

        def create(actor, head, event, comments, summary='Inline native fixture'):
            row = provider(actor['token'], 'POST', proute+'/reviews',
                           {'event': event, 'body': summary, 'commit_id': head, 'comments': comments})
            assert row['user']['id'] == actor['id'] and row['commit_id'] == head and row['state'] == event
            return row

        def comments(actor, review):
            rows = provider(actor['read'], 'GET', proute+'/reviews/'+str(review['id'])+'/comments')
            assert len(rows) == provider(actor['read'], 'GET', proute+'/reviews/'+str(review['id']))['comments_count']
            assert all(r['pull_request_review_id'] == review['id'] and r['pull_request_url'] == pull['html_url'] for r in rows)
            return rows

        def delete_pending(actor, review):
            provider(actor['token'], 'DELETE', proute+'/reviews/'+str(review['id']), expected=204)

        def new_pending(actor, before):
            rows = provider(actor['read'], 'GET', proute+'/reviews?limit=50')
            found = [r for r in rows if r['id'] not in before and r['state'] == 'PENDING' and r['user']['id'] == actor['id']]
            assert len(found) == 1
            return found[0]

        stage = 'divergent PR metadata settle'
        settled(chosen)
        frozen_diff = raw_diff(reviewer['read'], proute) if args.parser_proof else None
        stage = 'baseline inline create'
        baseline = create(reviewer, chosen, 'COMMENT', [
            {'path': path, 'body': 'Original new side', 'new_position': 1},
            {'path': path, 'body': 'Original old side', 'old_position': 1}])
        stage = 'baseline inline read'
        baseline_rows = comments(reader, baseline)
        stage = 'baseline hunk identity'
        print('Observed baseline hunk markers (old,new,merge-base,selected-head,base-tip,length): '+str([
            (r['original_position'], r['position'], 'merge-base one' in r['diff_hunk'],
             'selected-head one' in r['diff_hunk'], 'base-tip one' in r['diff_hunk'], len(r['diff_hunk']))
            for r in baseline_rows]), flush=True)
        assert merge_base != base_tip and all('-merge-base one' in r['diff_hunk'] and 'base-tip one' not in r['diff_hunk'] for r in baseline_rows)
        assert '+selected-head one' in next(r for r in baseline_rows if r['position'])['diff_hunk']
        print('PASS: native merge_base differs from base tip; new hunk includes selected current head, old context includes merge base rather than base tip and can stop before the replacement', flush=True)

        stage = 'stale explicit selected head with current context'
        advanced = content(author, 'PUT', 'inline-head', 'current-head one\ncurrent-head two\nstable three\n', selected['content']['sha'])
        current = advanced['commit']['sha']; settled(current)
        current_diff = raw_diff(reader['read'], proute) if args.parser_proof else None
        stale = create(reader, chosen, 'COMMENT', [
            {'path': path, 'body': 'Stale new side', 'new_position': 1},
            {'path': path, 'body': 'Stale old side', 'old_position': 1}])
        stale_rows = comments(reader, stale)
        assert all('-merge-base one' in r['diff_hunk'] and 'selected-head one' not in r['diff_hunk'] for r in stale_rows)
        assert '+current-head one' in next(r for r in stale_rows if r['position'])['diff_hunk']
        assert next(r for r in stale_rows if r['position'])['commit_id'] == chosen
        assert next(r for r in stale_rows if r['original_position'])['commit_id'] == current
        assert all(r['original_commit_id'] == '' for r in stale_rows)
        print('PASS: explicit stale selected review head retained, new hunk uses current head; new blame follows selected head, old child commit follows current head and old context uses merge base', flush=True)
        if args.parser_proof:
            stage = 'strict Go parser native context proof'
            parser_proof(frozen_diff, current_diff, next(r for r in baseline_rows if r['position']), next(r for r in stale_rows if r['position']))

        stage = 'append existing pending with mismatched selected commit'
        pending = create(reviewer, chosen, 'PENDING', [{'path': path, 'body': 'Pending first', 'new_position': 1}])
        first = comments(reviewer, pending)[0]
        appended = create(reviewer, current, 'PENDING', [{'path': path, 'body': 'Pending second', 'new_position': 2}])
        assert appended['id'] == pending['id'] and appended['comments_count'] == 2
        appended_rows = comments(reviewer, appended); second = next(r for r in appended_rows if r['body'] == 'Pending second')
        assert second['commit_id'] == merge_base and '+current-head two' in second['diff_hunk']
        assert next(r for r in appended_rows if r['id'] == first['id'])['commit_id'] == chosen
        assert next(r for r in appended_rows if r['id'] == first['id'])['diff_hunk'] == first['diff_hunk']
        print('PASS: existing own pending absorbed and header rebound to supplied different head; newly appended blame uses prior pending head, hunk uses current head', flush=True)

        stage = 'submit pending after head advance'
        final = content(author, 'PUT', 'inline-head', 'final-head one\nfinal-head two\nstable three\n', advanced['content']['sha'])
        latest = final['commit']['sha']; settled(latest)
        submitted = provider(reviewer['token'], 'POST', proute+'/reviews/'+str(appended['id']),
                             {'event': 'APPROVED', 'body': 'Submit after head moved'})
        assert submitted['id'] == appended['id'] and submitted['commit_id'] == latest and submitted['state'] == 'APPROVED' and not submitted['stale']
        final_rows = comments(reader, submitted)
        for row in appended_rows:
            observed = next(r for r in final_rows if r['id'] == row['id'])
            assert all(observed[f] == row[f] for f in ('body','path','position','original_position','commit_id','original_commit_id','diff_hunk'))
        print('PASS: /reviews/ID submission changes review commit to current head and approval stale=false while original child contexts stay unchanged', flush=True)

        stage = 'empty batch create consumes pending at explicit old head'
        pending = create(reader, chosen, 'PENDING', [{'path': path, 'body': 'Before body only', 'new_position': 3}])
        consumed = create(reader, chosen, 'COMMENT', [], 'Body-only explicit selected commit')
        assert consumed['id'] == pending['id'] and consumed['comments_count'] == 1 and consumed['commit_id'] != latest
        assert comments(reader, consumed)[0]['body'] == 'Before body only'
        print('PASS: empty-batch CreatePullReview consumes own pending and records explicit old head, unlike /reviews/ID current-head submission', flush=True)

        stage = 'partial batch invalid later path'
        before = {r['id'] for r in provider(reviewer['read'], 'GET', proute+'/reviews?limit=50')}
        probe(reviewer['token'], 'POST', proute+'/reviews', {'event': 'COMMENT', 'body': 'Incomplete batch', 'commit_id': latest,
              'comments': [{'path': path, 'body': 'First partial comment', 'new_position': 1},
                           {'path': 'invalid\x00path.txt', 'body': 'Invalid later path', 'new_position': 1}]}, expected=500)
        partial = new_pending(reviewer, before); remaining = comments(reviewer, partial)
        assert partial['commit_id'] == latest and len(remaining) == 1 and remaining[0]['body'] == 'First partial comment'
        probe(reader['read'], 'GET', proute+'/reviews/'+str(partial['id'])+'/comments', expected=404)
        delete_pending(reviewer, partial)
        print('PASS: later NUL-path native failure500 leaves first comment and pending header; foreign read remains404; partial draft deleted explicitly', flush=True)

        stage = 'closed-PR setup'
        closed = provider(author['token'], 'PATCH', proute, {'state': 'closed'}, expected=201)
        assert closed['state'] == 'closed'
        before = {r['id'] for r in provider(reviewer['read'], 'GET', proute+'/reviews?limit=50')}
        stage = 'closed-PR decision dispatch'
        probe(reviewer['token'], 'POST', proute+'/reviews', {'event': 'REQUEST_CHANGES', 'body': 'Closed request changes', 'commit_id': latest,
              'comments': [{'path': path, 'body': 'Before closed submission rejection', 'new_position': 1}]}, expected=422)
        stage = 'closed-PR partial draft lookup'
        partial = new_pending(reviewer, before)
        stage = 'closed-PR partial draft read'
        remaining = comments(reviewer, partial)
        assert len(remaining) == 1 and remaining[0]['body'] == 'Before closed submission rejection'
        stage = 'closed-PR partial draft removal and reopen'
        delete_pending(reviewer, partial); provider(author['token'], 'PATCH', proute, {'state': 'open'}, expected=201)
        print('PASS: closed-PR decision submission422 occurs after comment creation and leaves pending first row; draft removed before reopening', flush=True)

        stage = 'hidden pending reply and resolution visibility'
        pending = create(reviewer, latest, 'PENDING', [{'path': path, 'body': 'Hidden parent', 'new_position': 1}])
        parent = comments(reviewer, pending)[0]
        for actor in (reader, author, owner):
            probe(actor['read'], 'GET', proute+'/reviews/'+str(pending['id'])+'/comments', expected=404)
        reply = provider(reader['token'], 'POST', proute+'/comments/'+str(parent['id'])+'/replies', {'body': 'Known hidden parent reply'}, expected=201)
        assert reply['pull_request_review_id'] == pending['id'] and reply['user']['id'] == reader['id']
        probe(reader['token'], 'POST', route+'/pulls/comments/'+str(parent['id'])+'/resolve', expected=403)
        probe(author['token'], 'POST', route+'/pulls/comments/'+str(parent['id'])+'/resolve', expected=204)
        hidden_rows = comments(reviewer, pending)
        assert len(hidden_rows) == 2 and next(r for r in hidden_rows if r['id'] == parent['id'])['resolver']['id'] == author['id']
        assert next(r for r in hidden_rows if r['id'] == reply['id'])['resolver'] is None
        probe(author['read'], 'GET', proute+'/reviews/'+str(pending['id'])+'/comments', expected=404)
        probe(outsider['token'], 'POST', proute+'/comments/'+str(parent['id'])+'/replies', {'body': 'Private outsider'}, expected=404)
        delete_pending(reviewer, pending)
        print('PASS: known hidden pending parent accepts reader reply201 and PR-author resolution204 despite parent GET404; reader resolve403/private outsider404; individual reply stays unmarked', flush=True)
        print('PASS: native inline-write characterization complete; no Golf inline mutation or protected integration qualification claim', flush=True)
    except Exception as error:
        status = re.search(r'HTTP (\d+), expected (\d+)', str(error))
        suffix = ' (HTTP '+status[1]+', expected '+status[2]+')' if status else ''
        raise RuntimeError('Inline write probe failed at '+stage+' ('+type(error).__name__+')'+suffix+'; private diagnostics withheld') from None
    finally:
        failed = []
        for token, full in reversed(repositories):
            try: provider(token, 'DELETE', 'repos/'+full, expected=204)
            except Exception: failed.append('repository')
        for name in reversed(users):
            try: admin('delete', '--username', name, '--purge')
            except Exception: failed.append('account')
        if failed: raise RuntimeError('Inline write fixture cleanup incomplete; private diagnostics withheld') from None
        print('Disposable inline-write users/repositories purged; no Golf sessions created.', flush=True)


if __name__ == '__main__':
    main()
