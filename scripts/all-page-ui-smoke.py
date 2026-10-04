#!/usr/bin/env python3
"""Capture actual Golf page families on disposable supported-native fixtures.

Requires the existing deployed Compose stack. Does not deploy, change instance
policy, authenticate a provider, run inference or execute a workflow. Native
fixture setup writes are intentional; the browser only opens pages/editors.
Owner-only configuration is passed to the browser on stdin and removed finally.
"""
import argparse
import base64
import hashlib
import json
import os
from pathlib import Path
import secrets
import re
import subprocess
import sys
from urllib.parse import quote

sys.dont_write_bytecode = True
import smoke


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--stack-root', required=True, type=Path)
    parser.add_argument('--screenshots', type=Path)
    parser.add_argument('--served-source', help='Deployed product source SHA supplied by the deployment owner; git HEAD is separately recorded')
    parser.add_argument('--only', action='append', default=[], metavar='PAGE_ID', help='Capture only named page/state IDs; repeat to select several. The manifest explicitly records selective coverage.')
    parser.add_argument('--setup-only', action='store_true', help='Qualify owned native fixture setup/readback and cleanup without browser capture or private config')
    args = parser.parse_args()
    if args.served_source and (len(args.served_source) != 40 or any(c not in '0123456789abcdef' for c in args.served_source)):
        parser.error('--served-source must be a full lowercase commit SHA')
    stack = args.stack_root.resolve()
    for name in ('compose.yaml', '.env', 'web/node_modules/playwright/index.mjs'):
        if not (stack / name).is_file():
            parser.error('--stack-root requires a deployed Compose stack and installed Playwright')
    if args.only:
        preflight = subprocess.run(['node', str(Path(__file__).with_name('all-page-ui-browser.mjs')), '--check-pages', *args.only], cwd=stack, capture_output=True, text=True, timeout=15)
        if preflight.returncode != 0:
            parser.error('--only requires unique known page/state IDs; no fixtures were created')
    screenshots = (args.screenshots or stack / '.tmp/all-page-ui-review').resolve()
    screenshots.mkdir(mode=0o700, parents=True, exist_ok=True)
    os.chmod(screenshots, 0o700)
    private_config = stack / '.tmp/all-page-ui-review-config.json'
    if private_config.exists():
        parser.error('A prior owner-only audit configuration exists; inspect its fixture cleanup first')
    compose = ['docker', 'compose', '--project-directory', str(stack), '--file', str(stack / 'compose.yaml'), '--env-file', str(stack / '.env')]
    actors, repositories, organizations = {}, [], []
    config_created = False
    stage = 'readiness'
    last_native_status = None

    def command(*values, payload=None):
        result = subprocess.run(values, cwd=stack, input=None if payload is None else json.dumps(payload), capture_output=True, text=True, timeout=60)
        assert result.returncode == 0 and len(result.stdout) <= 2 << 20 and len(result.stderr) <= 2 << 20, 'Bounded subprocess failed'
        return result.stdout.strip()

    def admin(*values):
        return command(*compose, 'exec', '-T', 'gitea', 'gitea', '--config', '/etc/gitea/app.ini', 'admin', 'user', *values)

    def operator(action, payload):
        result = json.loads(command(*compose, 'exec', '-T', 'golf', '/usr/local/bin/golf', 'local-account', action, payload=payload))
        assert result['state'] == 'complete'
        return result['result']

    def runtime():
        container = command(*compose, 'ps', '-q', 'golf')
        image, config_hash = command('docker', 'inspect', '--format', '{{.Image}}|{{index .Config.Labels "com.docker.compose.config-hash"}}', container).split('|')
        assert image.startswith('sha256:')
        return {'containerImageReference': image, 'composeConfigHash': config_hash}

    def native(method, path, data=None, expected=200):
        nonlocal last_native_status
        last_native_status = None
        try:
            return smoke.provider(actors['owner']['token'], method, path, data, expected)
        except AssertionError as cause:
            # The existing helper's assertion includes a URL; only retain its
            # numeric HTTP observation, never the URL, body or credential.
            status = re.search(r': ([0-9]{3}), expected ([0-9]{3})$', str(cause))
            if status:
                last_native_status = {'actual': int(status[1]), 'expected': int(status[2])}
            raise

    try:
        smoke.ready()
        assert smoke.provider('', 'GET', 'version')['version'] == '1.27.3'
        baseline = runtime()
        prefix = 'golf-all-pages-' + secrets.token_hex(4)
        stage = 'owned actors'
        for role in ('owner', 'reader', 'outsider'):
            actor = actors[role] = {'name': prefix + '-' + role, 'created': False, 'enrolled': False, 'session': None}
            admin('create', '--username', actor['name'], '--email', actor['name'] + '@example.invalid', '--random-password', '--must-change-password=false')
            actor['created'] = True
            scopes = 'write:user,write:repository,write:issue,write:organization' if role == 'owner' else 'write:user,read:repository,read:issue,read:organization'
            actor['token'] = admin('generate-access-token', '--username', actor['name'], '--token-name', prefix, '--scopes', scopes, '--raw')
            actor['email'] = actor['name'] + '@golf.invalid'
            actor['password'] = 'Golf fixture ' + secrets.token_urlsafe(24)
            actor['enrolled'] = True  # Also attempt cleanup if create loses its acknowledgement.
            operator('create', {'username': actor['name'], 'email': actor['email'], 'password': actor['password'], 'forge_token': actor['token'], 'is_instance_admin': role == 'owner'})
            actor['session'] = smoke.client()
            smoke.rpc(actor['session'], 'SessionService/LoginWithPassword', {'username': actor['email'], 'password': actor['password']})

        stage = 'personal repository create'
        repo = native('POST', 'user/repos', {'name': 'workspace', 'private': True, 'auto_init': True, 'description': 'Actual disposable all-page Golf layout fixture'}, 201)
        full, route = repo['full_name'], 'repos/' + repo['full_name']
        repositories.append(full)
        stage = 'personal repository initial push readiness'
        smoke.wait_for_push(actors['owner']['token'], full)
        stage = 'empty repository create'
        empty = native('POST', 'user/repos', {'name': 'empty', 'private': True, 'auto_init': False}, 201)
        repositories.append(empty['full_name'])
        stage = 'personal reader collaborator grant'
        native('PUT', route + '/collaborators/' + actors['reader']['name'], {'permission': 'read'}, 204)
        stage = 'personal website metadata update'
        native('PATCH', route, {'website': 'https://example.invalid/golf'})
        stage = 'personal topics metadata update'
        native('PUT', route + '/topics', {'topics': ['golf', 'developer-tools', 'self-hosted']}, 204)
        path = 'src/app ü%.py'

        def write_file(method, name, branch, text, sha=None):
            data = {'branch': branch, 'message': 'Disposable audit source fixture', 'content': base64.b64encode(text.encode()).decode()}
            if sha:
                data['sha'] = sha
            return native(method, route + '/contents/' + quote(name, safe='/'), data, 201 if method == 'POST' else 200)

        stage = 'personal initial Unicode percent source create'
        initial = write_file('POST', path, repo['default_branch'], 'def greet(name):\n    return "Hello " + name\n\nprint(greet("Golf"))\n')
        before = initial['commit']['sha']
        stage = 'personal proposal branch create'
        native('POST', route + '/branches', {'new_branch_name': 'feature/review'}, 201)
        stage = 'personal proposal source update'
        changed_text = 'def greet(name):\n    return f"Welcome {name}"\n\nprint(greet("Golf"))\n'
        changed = write_file('PUT', path, 'feature/review', changed_text, initial['content']['sha'])
        head = changed['commit']['sha']
        stage = 'personal exact proposal commit and blob verification'
        assert re.fullmatch(r'[0-9a-f]{40}|[0-9a-f]{64}', head) and head != before
        assert native('GET', route + '/git/commits/' + head)['sha'] == head
        observed_branch = native('GET', route + '/branches/' + quote('feature/review', safe=''))
        assert observed_branch['name'] == 'feature/review' and observed_branch['commit']['id'] == head
        blob_id = changed['content']['sha']
        blob = native('GET', route + '/git/blobs/' + blob_id)
        raw = base64.b64decode(blob['content'], validate=True)
        assert blob['sha'] == blob_id and blob['encoding'] == 'base64' and blob['size'] == len(raw) and raw == changed_text.encode()
        digest = hashlib.sha1 if len(blob_id) == 40 else hashlib.sha256
        assert digest(b'blob ' + str(len(raw)).encode() + b'\x00' + raw).hexdigest() == blob_id
        stage = 'personal annotated tag create'
        native('POST', route + '/tags', {'tag_name': 'preview/v1', 'target': head, 'message': 'Disposable annotated audit tag'}, 201)
        stage = 'personal README original metadata read'
        readme = native('GET', route + '/contents/README.md', None)
        stage = 'personal README update'
        write_file('PUT', 'README.md', repo['default_branch'], '# Golf audit fixture\n\nReal local source used for layout review.\n\n## Contents\n\n| Surface | Purpose |\n| --- | --- |\n| Source | Code and history |\n| Collaboration | Issues and pull requests |\n\n```python\nprint("Golf")\n```\n', readme['sha'])
        stage = 'personal native pull request create'
        pull = native('POST', route + '/pulls', {'base': repo['default_branch'], 'head': 'feature/review', 'title': 'Review a small source change', 'body': '## Proposed change\n\nA real disposable comparison with old and new line context.'}, 201)
        stage = 'personal native open issue create'
        issue = native('POST', route + '/issues', {'title': 'Make repository navigation concise', 'body': '## Goal\n\nKeep the work visible and controls readable.\n\n- [ ] Inspect desktop\n- [ ] Inspect mobile'}, 201)
        stage = 'personal native issue comment create'
        native('POST', route + '/issues/' + str(issue['number']) + '/comments', {'body': 'Actual fixture comment for the discussion layout.'}, 201)
        stage = 'personal native second issue create'
        closed = native('POST', route + '/issues', {'title': 'Completed layout observation', 'body': 'A second actual issue for closed-list coverage.'}, 201)
        stage = 'personal native second issue close'
        closed_receipt = native('PATCH', route + '/issues/' + str(closed['number']), {'state': 'closed'}, 201)
        assert closed_receipt['id'] == closed['id'] and closed_receipt['number'] == closed['number'] and closed_receipt['state'] == 'closed'
        stage = 'personal native closed issue independent readback'
        closed_observed = native('GET', route + '/issues/' + str(closed['number']))
        assert closed_observed['id'] == closed['id'] and closed_observed['number'] == closed['number'] and closed_observed['state'] == 'closed'

        stage = 'owned organization create'
        organization = prefix + '-org'
        native('POST', 'orgs', {'username': organization, 'visibility': 'private', 'description': 'Actual disposable organization layout fixture'}, 201)
        organizations.append(organization)
        stage = 'owned ordinary team create'
        team = native('POST', 'orgs/' + organization + '/teams', {'name': 'Developers', 'visibility': 'limited', 'units_map': {'repo.code': 'read', 'repo.issues': 'read', 'repo.pulls': 'read'}}, 201)
        stage = 'owned reader team membership grant'
        native('PUT', 'teams/' + str(team['id']) + '/members/' + actors['reader']['name'], None, 204)
        stage = 'owned organization repository create'
        orgrepo = native('POST', 'orgs/' + organization + '/repos', {'name': 'organization-work', 'private': True, 'auto_init': True}, 201)
        repositories.append(orgrepo['full_name'])
        stage = 'owned ordinary team repository assignment'
        native('PUT', 'teams/' + str(team['id']) + '/repos/' + orgrepo['full_name'], None, 204)
        stage = 'owned organization initial push readiness'
        smoke.wait_for_push(actors['owner']['token'], orgrepo['full_name'])

        if args.setup_only:
            assert runtime() == baseline
            print('PASS: supported native fixture setup and exact proposal commit/blob/hash readback; no browser or private config created.', flush=True)
            return

        stage = 'actual page capture'
        config = {'only': args.only, 'golf': smoke.GOLF, 'screenshots': str(screenshots), 'runtime': baseline, 'workingTreeHead': command('git', 'rev-parse', 'HEAD'), 'servedSourceCommit': args.served_source, 'actors': {role: {k: actor[k] for k in ('name', 'email', 'password')} for role, actor in actors.items()}, 'repository': full, 'emptyRepository': empty['full_name'], 'orgRepository': orgrepo['full_name'], 'repositoryId': str(repo['id']), 'defaultBranch': repo['default_branch'], 'commit': head, 'beforeCommit': before, 'path': path, 'issue': issue['number'], 'closedIssue': closed['number'], 'pull': pull['number'], 'organization': organization, 'teamId': str(team['id'])}
        fd = os.open(private_config, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        config_created = True
        with os.fdopen(fd, 'w') as destination:
            json.dump(config, destination)
        result = subprocess.run(['node', str(Path(__file__).with_name('all-page-ui-browser.mjs'))], cwd=stack, input=json.dumps(config), text=True, timeout=900)
        assert result.returncode == 0, 'All-page browser audit contains unexpected failures; inspect owner-only manifest'
        assert runtime() == baseline, 'Runtime changed during capture'
        print('PASS: actual page-family audit captured on unchanged local runtime; pending states remain explicit.', flush=True)
    except Exception:
        print('All-page audit failed at ' + stage + '; sensitive diagnostics withheld.', file=sys.stderr)
        if last_native_status:
            print('Native HTTP status: actual ' + str(last_native_status['actual']) + ', expected ' + str(last_native_status['expected']) + '.', file=sys.stderr)
        raise
    finally:
        failures = []
        for actor in actors.values():
            if actor['session'] is not None:
                try:
                    smoke.rpc(actor['session'], 'SessionService/RevokeOtherSessions')
                    smoke.rpc(actor['session'], 'SessionService/Logout')
                except Exception:
                    failures.append('session revocation')
        for actor in reversed(list(actors.values())):
            if actor['enrolled']:
                try:
                    assert operator('disable', {'username': actor['name']})['disabled']
                except Exception:
                    failures.append('managed disable')
        # Delete repos before orgs, then purge only our native actors. Retain
        # encrypted Golf account/journal history according to the product contract.
        for repository in reversed(repositories):
            try:
                native('DELETE', 'repos/' + repository, None, 204)
            except Exception:
                failures.append('repository purge')
        for organization in reversed(organizations):
            try:
                native('DELETE', 'orgs/' + organization, None, 204)
            except Exception:
                failures.append('organization purge')
        for actor in reversed(list(actors.values())):
            if actor['created']:
                try:
                    admin('delete', '--username', actor['name'], '--purge')
                except Exception:
                    failures.append('native actor purge')
        if config_created:
            private_config.unlink(missing_ok=True)
        for capture in screenshots.iterdir():
            if capture.is_file():
                os.chmod(capture, 0o600)
        assert not failures, 'Owned all-page fixture cleanup incomplete; sensitive diagnostics withheld'
        print('Cleanup: owned native resources purged; managed sessions revoked/accounts disabled; private configuration removed.', flush=True)


if __name__ == '__main__':
    try:
        main()
    except Exception:
        print('All-page audit failed; sensitive diagnostics withheld.', file=sys.stderr)
        sys.exit(1)
