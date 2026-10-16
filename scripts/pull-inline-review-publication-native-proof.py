#!/usr/bin/env python3
"""Qualify the production human inline publication handlers with native APIs and isolated PG.

Not a served worker/provider/Cloudflare/merge/recovery qualification. No inference
or workflow runs. Fixture accounts/repo use supported native APIs/admin; Golf
metadata lives in an automatically removed disposable PostgreSQL container.
Credentials cross to Go only through a removed owner-only temporary file.
"""
import argparse
import base64
import json
import os
import re
from pathlib import Path
import secrets
import subprocess
import sys
import tempfile
import time
import urllib.request

sys.dont_write_bytecode = True
from smoke import ROOT, FORGE, client, command, provider, ready, request, wait_for_push


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--stack-root', type=Path, default=ROOT)
    args = parser.parse_args()
    stack = args.stack_root.resolve()
    assert (stack/'compose.yaml').is_file() and (stack/'.env').is_file()

    def admin(*values):
        return command('docker', 'compose', '--project-directory', str(stack), '--file', str(stack/'compose.yaml'),
                       '--env-file', str(stack/'.env'), 'exec', '-T', 'forgejo', 'forgejo',
                       '--config', '/var/lib/gitea/custom/conf/app.ini', 'admin', 'user', *values)  # Forgejo's upstream path

    def native_diff(token, route):
        req = urllib.request.Request(FORGE+'/api/v1/'+route+'.diff', headers={'Authorization': 'token '+token})
        with client().open(req, timeout=20) as response:
            assert response.status == 200
            raw = response.read(512*1024+1)
            assert len(raw) <= 512*1024
            return raw.decode('utf-8')

    ready()
    assert request(client(), 'GET', FORGE+'/api/v1/version')['version'] == '15.0.9+gitea-1.22.0'  # Forgejo's upstream version string
    prefix = 'golf-inline-pub-probe-'+secrets.token_hex(4)
    users, repositories, actors = [], [], {}
    pg = prefix+'-pg'
    pg_started = False
    stage = 'native accounts'
    try:
        for role in ('owner', 'reviewer'):
            name = prefix+'-'+role
            admin('create', '--username', name, '--email', name+'@example.invalid',
                  '--random-password', '--must-change-password=false')
            users.append(name)
            token = admin('generate-access-token', '--username', name, '--token-name', prefix,
                          '--scopes', 'write:user,write:repository,write:issue', '--raw')
            actors[role] = {'name': name, 'token': token, 'id': provider(token, 'GET', 'user')['id']}
        owner, reviewer = actors['owner'], actors['reviewer']
        stage = 'private native repository'
        repo = provider(owner['token'], 'POST', 'user/repos', {'name': 'private', 'private': True, 'auto_init': True}, expected=201)
        repositories.append((owner['token'], repo['full_name']))
        full = repo['full_name']; route = 'repos/'+full
        wait_for_push(owner['token'], full)
        provider(owner['token'], 'PUT', route+'/collaborators/'+reviewer['name'], {'permission': 'write'}, expected=204)

        def content(method, branch, text, sha=None):
            body = {'branch': branch, 'message': 'Deterministic native publication fixture', 'content': base64.b64encode(text.encode()).decode()}
            if sha:
                body['sha'] = sha
            return provider(owner['token'], method, route+'/contents/src/context%20%C3%BC.txt', body, expected=201 if method == 'POST' else 200)

        initial = content('POST', repo['default_branch'], 'merge-base one\nkeep two\nkeep three\n')
        merge_base = initial['commit']['sha']
        provider(owner['token'], 'POST', route+'/branches', {'new_branch_name': 'selected'}, expected=201)
        advanced_base = content('PUT', repo['default_branch'], 'base-tip one\nkeep two\nkeep three\n', initial['content']['sha'])
        base = advanced_base['commit']['sha']
        selected = content('PUT', 'selected', 'selected-head one\nkeep two\nkeep three\n', initial['content']['sha'])
        head = selected['commit']['sha']
        pull = provider(owner['token'], 'POST', route+'/pulls', {'head': 'selected', 'base': repo['default_branch'], 'title': 'Native publication qualification'}, expected=201)
        proute = route+'/pulls/'+str(pull['number'])
        stage = 'native comparison settle'
        deadline = time.monotonic()+45
        while True:
            observed = provider(owner['token'], 'GET', proute)
            retained = provider(owner['token'], 'GET', route+'/commits?sha=refs%2Fpull%2F'+str(pull['number'])+'%2Fhead&limit=1&stat=false&files=false&verification=false')
            if observed['merge_base'] == merge_base and observed['base']['sha'] == base and observed['head']['sha'] == head and retained and retained[0]['sha'] == head:
                break
            assert time.monotonic() < deadline, 'Native fixture comparison did not settle'
            time.sleep(.2)
        assert merge_base != base
        pending = provider(reviewer['token'], 'POST', proute+'/reviews', {'event': 'PENDING', 'body': 'Explicit native pending control', 'commit_id': head, 'comments': [{'path': 'src/context ü.txt', 'new_position': 1, 'body': 'Preserve this pending control.'}]})
        assert pending['state'] == 'PENDING' and pending['comments_count'] == 1
        pending_children = provider(reviewer['token'], 'GET', proute+'/reviews/'+str(pending['id'])+'/comments')
        assert len(pending_children) == 1
        envelope = {'URL': FORGE, 'Owner': owner['name'], 'Repository': 'private', 'Reviewer': reviewer['name'], 'ReviewerToken': reviewer['token'], 'Path': 'src/context ü.txt',
                    'RepositoryID': repo['id'], 'PullID': pull['id'], 'Number': pull['number'], 'ReviewerID': reviewer['id'],
                    'Base': base, 'Head': head, 'MergeBase': merge_base, 'Diff': native_diff(owner['token'], proute), 'PendingID': pending['id'], 'PendingChildID': pending_children[0]['id']}
        stage = 'isolated Golf PostgreSQL'
        image = command('docker', 'inspect', 'golf-postgres-1', '--format', '{{.Config.Image}}')
        command('docker', 'run', '-d', '--rm', '--name', pg, '-e', 'POSTGRES_HOST_AUTH_METHOD=trust', '-p', '127.0.0.1::5432', image)
        pg_started = True
        deadline = time.monotonic()+30
        while subprocess.run(['docker', 'exec', pg, 'pg_isready', '-U', 'postgres'], capture_output=True).returncode:
            assert time.monotonic() < deadline, 'Disposable PostgreSQL unavailable'
            time.sleep(.2)
        port = command('docker', 'port', pg, '5432/tcp').rsplit(':', 1)[1]
        stage = 'production handler supported native proof'
        with tempfile.TemporaryDirectory(prefix='golf-native-publication-') as directory:
            target = Path(directory)/'proof.json'
            descriptor = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            with os.fdopen(descriptor, 'w') as stream:
                json.dump(envelope, stream)
            env = {**os.environ, 'GOLF_INLINE_REVIEW_NATIVE_PROOF': str(target), 'GOLF_TEST_DATABASE_URL': 'postgres://postgres@127.0.0.1:'+port+'/postgres?sslmode=disable'}
            result = subprocess.run(['go', 'test', '-race', './internal/server', '-run', '^TestInlineReviewNativeProof$', '-count=1'], cwd=ROOT, env=env, capture_output=True, text=True, timeout=180)
            if result.returncode:
                # Only fixed literals in our own test are diagnostic classes.
                # Never forward provider output, fixture payloads or credentials.
                source = (ROOT/'internal/server/pull_inline_reviews_native_test.go').read_text()
                allowed = set(re.findall(r't.Fatal\("([^"]+)"\)', source))
                for line in (result.stdout+result.stderr).splitlines():
                    candidate = line.rsplit(': ', 1)[-1].strip()
                    if candidate in allowed:
                        print('Native handler assertion class: '+candidate, file=sys.stderr, flush=True)
            assert result.returncode == 0, 'Production handler native proof failed (private output withheld)'
        print('PASS: production HTTP handlers save exact encrypted spaced/Unicode old/new draft, refuse own native PENDING without changing its child, keep rejected keys status-only, durably refuse an empty saved COMMENT summary with no shared event, and qualify three decisions with complete independent actual M/H context and one review per intent', flush=True)
        rows = provider(reviewer['token'], 'GET', proute+'/reviews?limit=50')
        assert len(rows) == 3 and {row['state'] for row in rows} == {'COMMENT', 'APPROVED', 'REQUEST_CHANGES'}
        for row in rows:
            assert row['commit_id'] == head and row['user']['id'] == reviewer['id'] and row['comments_count'] == 2
            children = provider(reviewer['token'], 'GET', proute+'/reviews/'+str(row['id'])+'/comments')
            assert len(children) == 2 and {(child['position'], child['original_position']) for child in children} == {(1, 0), (0, 1)}
            assert all(child['path'] == 'src/context ü.txt' and '-merge-base one' in child['diff_hunk'] and (child['original_position'] == 1 or '+selected-head one' in child['diff_hunk']) and 'base-tip one' not in child['diff_hunk'] for child in children)
        print('PASS: independent supported-native readback retains three historical decisions and six complete child receipts; no eligible approval/ref fencing/provider/served UI/recovery claim', flush=True)
    except Exception:
        print('FAIL stage: '+stage+' (private output withheld)', file=sys.stderr, flush=True)
        raise RuntimeError('Native inline qualification failed; private diagnostics withheld') from None
    finally:
        cleanup_errors = []
        if pg_started:
            try:
                command('docker', 'rm', '-f', pg)
            except Exception:
                cleanup_errors.append('disposable PostgreSQL')
        for token, full in reversed(repositories):
            try:
                provider(token, 'DELETE', 'repos/'+full, expected=204)
            except Exception:
                cleanup_errors.append('disposable native repository')
        for name in reversed(users):
            try:
                admin('delete', '--username', name, '--purge')
            except Exception:
                cleanup_errors.append('disposable native actor')
        assert not cleanup_errors, 'Explicit fixture cleanup failed: '+', '.join(cleanup_errors)
        assert prefix not in admin('list'), 'Disposable native actor remained after purge'
        print('Removed every disposable native actor/repository and isolated PostgreSQL container; no Golf live sessions or provider executions were created.', flush=True)


if __name__ == '__main__':
    main()
