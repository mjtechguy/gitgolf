#!/usr/bin/env python3
"""Qualify the production bot publication helper with native APIs and isolated PG.

Not a served worker/provider/Cloudflare/merge/recovery qualification. No inference
or workflow runs. Fixture accounts/repo use supported native APIs/admin; Golf
metadata lives in disposable schemas on an explicitly supplied host PostgreSQL (or a legacy disposable PostgreSQL container).
Credentials cross to Go only through a removed owner-only temporary file.
"""
import argparse
import base64
import json
import hashlib
import os
from pathlib import Path
import secrets
import subprocess
import sys
import tempfile
import time
import urllib.request

sys.dont_write_bytecode = True
from smoke import ROOT, GITEA, client, command, provider, ready, request, wait_for_push


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--stack-root', type=Path, default=ROOT)
    parser.add_argument('--database-url', default='')
    parser.add_argument('--output', type=Path)
    args = parser.parse_args()
    stack = args.stack_root.resolve()
    assert (stack/'compose.yaml').is_file() and (stack/'.env').is_file()

    def admin(*values):
        return command('docker', 'compose', '--project-directory', str(stack), '--file', str(stack/'compose.yaml'),
                       '--env-file', str(stack/'.env'), 'exec', '-T', 'gitea', 'gitea',
                       '--config', '/etc/gitea/app.ini', 'admin', 'user', *values)

    def native_diff(token, route):
        req = urllib.request.Request(GITEA+'/api/v1/'+route+'.diff', headers={'Authorization': 'token '+token})
        with client().open(req, timeout=20) as response:
            assert response.status == 200
            raw = response.read(512*1024+1)
            assert len(raw) <= 512*1024
            return raw.decode('utf-8')

    ready()
    assert request(client(), 'GET', GITEA+'/api/v1/version')['version'] == '1.27.3'
    prefix = 'golf-bot-pub-probe-'+secrets.token_hex(4)
    users, repositories, actors = [], [], {}
    pg = prefix+'-pg'
    pg_started = False
    stage = 'native accounts'
    result = None
    passed = False
    source = command('git','rev-parse','HEAD')
    try:
        for role in ('owner', 'publisher'):
            name = prefix+'-'+role
            admin('create', '--username', name, '--email', name+'@example.invalid',
                  '--random-password', '--must-change-password=false')
            users.append(name)
            token = admin('generate-access-token', '--username', name, '--token-name', prefix,
                          '--scopes', 'write:user,write:repository,write:issue', '--raw')
            actors[role] = {'name': name, 'token': token, 'id': provider(token, 'GET', 'user')['id']}
        owner, publisher = actors['owner'], actors['publisher']
        stage = 'private native repository'
        repo = provider(owner['token'], 'POST', 'user/repos', {'name': 'private', 'private': True, 'auto_init': True}, expected=201)
        repositories.append((owner['token'], repo['full_name']))
        full = repo['full_name']; route = 'repos/'+full
        wait_for_push(owner['token'], full)
        provider(owner['token'], 'PUT', route+'/collaborators/'+publisher['name'], {'permission': 'write'}, expected=204)

        def content(method, branch, text, sha=None):
            body = {'branch': branch, 'message': 'Deterministic native publication fixture', 'content': base64.b64encode(text.encode()).decode()}
            if sha:
                body['sha'] = sha
            return provider(owner['token'], method, route+'/contents/context.txt', body, expected=201 if method == 'POST' else 200)

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
        pending = provider(publisher['token'], 'POST', proute+'/reviews', {'event': 'PENDING', 'body': 'Explicit native pending control', 'commit_id': head, 'comments': [{'path': 'context.txt', 'new_position': 1, 'body': 'Preserve this pending child during preflight refusal.'}]})
        assert pending['state'] == 'PENDING' and pending['comments_count'] == 1
        pending_children = provider(publisher['token'], 'GET', proute+'/reviews/'+str(pending['id'])+'/comments')
        assert len(pending_children) == 1
        envelope = {'URL': GITEA, 'Owner': owner['name'], 'Repository': 'private', 'SponsorToken': owner['token'], 'PublisherToken': publisher['token'],
                    'RepositoryID': repo['id'], 'PullID': pull['id'], 'Number': pull['number'], 'OwnerID': owner['id'], 'PublisherID': publisher['id'],
                    'Base': base, 'Head': head, 'MergeBase': merge_base, 'Diff': native_diff(owner['token'], proute), 'PendingID': pending['id'], 'PendingChildID': pending_children[0]['id']}
        stage = 'isolated Golf PostgreSQL'
        database_url = args.database_url
        if not database_url:
            image = command('docker', 'inspect', 'golf-postgres-1', '--format', '{{.Config.Image}}')
            command('docker', 'run', '-d', '--rm', '--name', pg, '-e', 'POSTGRES_HOST_AUTH_METHOD=trust', '-p', '127.0.0.1::5432', image)
            pg_started = True
            deadline = time.monotonic()+30
            while subprocess.run(['docker', 'exec', pg, 'pg_isready', '-U', 'postgres'], capture_output=True).returncode:
                assert time.monotonic() < deadline, 'Disposable PostgreSQL unavailable'
                time.sleep(.2)
            port = command('docker', 'port', pg, '5432/tcp').rsplit(':', 1)[1]
            database_url = 'postgres://postgres@127.0.0.1:'+port+'/postgres?sslmode=disable'
        stage = 'production helper supported native proof'
        with tempfile.TemporaryDirectory(prefix='golf-native-publication-') as directory:
            target = Path(directory)/'proof.json'
            descriptor = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            with os.fdopen(descriptor, 'w') as stream:
                json.dump(envelope, stream)
            env = {**os.environ, 'GOLF_REVIEW_PUBLICATION_NATIVE_PROOF': str(target), 'GOLF_TEST_DATABASE_URL': database_url}
            result = subprocess.run(['go', 'test', '-race', './internal/server', '-run', '^TestReviewerPublicationNativeProof$', '-count=1'], cwd=ROOT, env=env, capture_output=True, text=True, timeout=180)
            assert result.returncode == 0, 'Production helper native proof failed (private output withheld)'
        print('PASS: native PR comment original-author/body capture, edit and deletion refusal; no task/model executed',flush=True)
        print('PASS: production helper refuses existing own native pending without changing its child; rejected intent cannot replay after explicit cleanup', flush=True)
        rows = provider(owner['token'], 'GET', proute+'/reviews?limit=50')
        assert len(rows) == 1 and rows[0]['state'] == 'COMMENT' and rows[0]['commit_id'] == head and rows[0]['user']['id'] == publisher['id'] and rows[0]['comments_count'] == 1
        children = provider(owner['token'], 'GET', proute+'/reviews/'+str(rows[0]['id'])+'/comments')
        assert len(children) == 1 and children[0]['path'] == 'context.txt' and children[0]['position'] == 1 and children[0]['original_position'] == 0 and '-merge-base one' in children[0]['diff_hunk'] and '+selected-head one' in children[0]['diff_hunk'] and 'base-tip one' not in children[0]['diff_hunk']
        print('PASS: production helper journals once-only publication and independently verifies complete actual native header/child/body/M→H context; replay leaves exactly one native review', flush=True)
        passed=True
    except Exception:
        print('FAIL stage: '+stage+' (private output withheld)', file=sys.stderr, flush=True)
        raise
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
        print('Removed every disposable native actor/repository and isolated PostgreSQL schema; no Golf live sessions or provider executions were created.', flush=True)
        if args.output:
            args.output.mkdir(mode=0o700,parents=True,exist_ok=True)
            files=['internal/server/agent_comment_commands.go','internal/server/reviewer_worker.go','internal/server/reviewer_publication.go','internal/server/reviewer_publication_native_test.go','internal/server/database/migrations/202610050085_agent_comment_commands.sql','scripts/reviewer-publication-native-proof.py']
            manifest={'result':'PASS' if passed else 'FAIL','source_commit':source,'source_clean':not bool(command('git','status','--porcelain')),'native_version':'1.27.3','source_files':{name:hashlib.sha256((ROOT/name).read_bytes()).hexdigest() for name in files},'native_command_capture_edit_delete':passed,'production_publication':passed,'fixture_cleanup':True,'new_docker_resources':int(pg_started),'no_model_execution':True,'scope':'production native helper with isolated host schema; not served runtime or worker'}
            target=args.output/'manifest.json'
            descriptor=os.open(target,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
            with os.fdopen(descriptor,'w') as stream: json.dump(manifest,stream,indent=2)
            if result is not None and result.returncode==0:
                (args.output/'go-test.log').write_text(result.stdout)
                os.chmod(args.output/'go-test.log',0o600)


if __name__ == '__main__':
    main()
