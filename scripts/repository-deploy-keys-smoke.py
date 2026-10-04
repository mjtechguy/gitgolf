#!/usr/bin/env python3
"""Prepared native deploy-key qualification; no runtime proof until executed.

Creates only disposable native actors/repos and managed Golf fixture accounts.
Uses supported RPC/native API/admin/operator procedures and real SSH Git; never
starts/deploys services or edits native repositories/database files. Private
keys/credentials stay in memory or a temporary 0700 directory, and are not logged.
"""
import argparse
import base64
import hashlib
import json
import os
from pathlib import Path
import re
import secrets
import shlex
import subprocess
import sys
import tempfile
import traceback
import urllib.error
import urllib.parse
import urllib.request
sys.dont_write_bytecode = True
import smoke

SERVICE = 'RepositoryDeployKeyService/'
METHODS = ('ListRepositoryDeployKeys', 'AddRepositoryDeployKey', 'DeleteRepositoryDeployKey')
HEX = re.compile(r'[0-9a-f]{64}')
DECIMAL = re.compile(r'[1-9][0-9]{0,18}')


def identifier(value):
    return isinstance(value, str) and DECIMAL.fullmatch(value) is not None and int(value) <= 9223372036854775807


def normalize(public):
    pieces = public.strip().split()
    assert len(pieces) >= 2
    normalized = ' '.join(pieces[:2])
    fingerprint = 'SHA256:' + base64.b64encode(hashlib.sha256(base64.b64decode(pieces[1], validate=True)).digest()).decode().rstrip('=')
    return normalized, fingerprint


def receipt(result, target):
    assert result['repositoryId'] == target['repositoryId'] and result['ownerId'] == target['ownerId']
    assert result['accessRevision'] == target['expectedRevision']
    return result


def key_receipt(row, public, title, read_only):
    normalized, fingerprint = normalize(public)
    assert identifier(row['id']) and identifier(row['publicKeyId'])
    assert row['publicKey'] == normalized and row['fingerprint'] == fingerprint and row['title'] == title
    assert row.get('readOnly', False) is read_only
    assert HEX.fullmatch(row['revision']) and isinstance(row['createdAt'], str) and row['createdAt']
    return row


def native_matches(native, row):
    assert str(native['id']) == row['id'] and str(native['key_id']) == row['publicKeyId']
    assert native['title'] == row['title'] and normalize(native['key']) == (row['publicKey'], row['fingerprint'])
    assert native['read_only'] is row.get('readOnly', False) and native['created_at'] == row['createdAt']


def self_check(root, contract_file=None):
    # Pure contract checks only. These are not provider/runtime qualification.
    public = 'ssh-ed25519 ' + base64.b64encode(b'deploy-key-receipt-self-check').decode()
    target = {'repositoryId': '12', 'ownerId': '7', 'expectedRevision': 'a'*64}
    row = {'id': '22', 'publicKeyId': '31', 'publicKey': normalize(public)[0], 'fingerprint': normalize(public)[1], 'title': 'Example', 'createdAt': '2026-10-04T00:00:00Z', 'revision': 'b'*64}
    key_receipt(row, public, 'Example', False)
    receipt({**target, 'accessRevision': target['expectedRevision']}, target)
    for bad in ('0', '01', '-1', '9223372036854775808', '1e2'):
        assert not identifier(bad)
    for field in ('id', 'publicKeyId', 'publicKey', 'fingerprint', 'title', 'revision'):
        wrong = {**row, field: 'invalid'}
        try:
            key_receipt(wrong, public, 'Example', False)
        except (AssertionError, KeyError):
            pass
        else:
            raise AssertionError('Malformed deploy-key receipt admitted')
    proto = contract_file or root/'api/golf/v1/golf.proto'
    if contract_file or proto.is_file() and 'service RepositoryDeployKeyService' in proto.read_text():
        source = proto.read_text()
        for method in METHODS:
            assert 'rpc '+method+'(' in source
        fields = {
            'RepositoryDeployKey': [('string', 'id', 1), ('string', 'public_key_id', 2), ('string', 'revision', 8)],
            'ListRepositoryDeployKeysRequest': [('RepositoryKey', 'repository', 1), ('string', 'repository_id', 2), ('string', 'owner_id', 3), ('string', 'expected_revision', 4), ('PageRequest', 'page', 5)],
            'AddRepositoryDeployKeyRequest': [('string', 'title', 5), ('string', 'public_key', 6), ('optional bool', 'read_only', 7)],
            'DeleteRepositoryDeployKeyRequest': [('string', 'key_id', 5), ('string', 'expected_key_revision', 6)],
        }
        for name, expected in fields.items():
            body = re.search(r'message '+name+r'\s*\{([^}]+)\}', source).group(1)
            for kind, field, number in expected:
                assert re.search(re.escape(kind)+r'\s+'+field+r'\s*=\s*'+str(number)+r'\s*;', body)
        print('PASS: frozen deploy-key protobuf field/tag contract')
    print('PASS: pure deploy-key receipt/identity self-check; no provider or runtime operations executed')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--self-check', action='store_true', help='Pure validation only; no network, Git or container changes')
    parser.add_argument('--contract-file', type=Path, help='Optional frozen protobuf file for pure self-check')
    parser.add_argument('--stack-root', type=Path, help='Existing deployed Compose checkout; never deploys or restarts it')
    parser.add_argument('--browser', action='store_true', help='Actual settings Add/list/reload/delete in both modes/themes at1440/390')
    parser.add_argument('--screenshots', type=Path, help='Owner-only browser output directory (required with --browser)')
    parser.add_argument('--ssh-port', type=int, default=2222)
    parser.add_argument('--organization', action='store_true', help='Owned private organization repositories, member direct-admin and team-only-admin denial')
    parser.add_argument('--proof-output', type=Path, help='Fresh private diagnostic manifest; never includes raw bodies, URLs or credentials')
    args = parser.parse_args()
    if args.self_check:
        self_check(Path(__file__).resolve().parents[1], args.contract_file); return
    if not args.stack_root:
        parser.error('--stack-root is required for actual runtime qualification')
    stack = args.stack_root.resolve()
    if not (stack/'compose.yaml').is_file() or not (stack/'.env').is_file():
        parser.error('--stack-root must contain deployed compose.yaml and .env')
    if not 1 <= args.ssh_port <= 65535:
        parser.error('Invalid SSH port')
    if args.browser and (not args.screenshots or not (stack/'web/node_modules/playwright/index.mjs').is_file()):
        parser.error('--browser requires --screenshots and existing stack-root Playwright')
    if args.screenshots:
        if (args.screenshots/'manifest.json').exists():
            parser.error('Use a new screenshot directory; prior evidence must remain unchanged')
        args.screenshots.mkdir(parents=True, exist_ok=True, mode=0o700)
        args.screenshots.chmod(0o700)
    compose = ['docker', 'compose', '--project-directory', str(stack), '--file', str(stack/'compose.yaml'), '--env-file', str(stack/'.env')]
    actors, enrolled, bearers = {}, [], []
    owned_organization = None
    native_repos = []
    prefix = 'golf-deploy-keys-' + secrets.token_hex(4)
    stage = 'readiness'
    runtime_before = None
    passed = False
    original_failure = None
    observations = []
    original_request = smoke.request
    if args.proof_output:
        assert not args.proof_output.exists(), 'Use a fresh proof manifest'
        args.proof_output.parent.mkdir(parents=True, exist_ok=True, mode=0o700)

    def observed_request(opener, method, url, payload=None, headers=None, expected=200):
        # Closed wire facts only; never serialize the URL, request, native body,
        # credentials, arbitrary exception text or native error messages.
        if not url.startswith(smoke.GOLF + '/rpc/'):
            return original_request(opener, method, url, payload, headers, expected)
        procedure = url.removeprefix(smoke.GOLF + '/rpc/golf.v1.')
        permitted = {SERVICE+m for m in METHODS} | {'RepositoryAccessService/GetRepositoryAccess', 'SessionService/LoginWithPassword', 'SessionService/Logout', 'SessionService/RevokeOtherSessions', 'ApiCredentialService/CreateApiCredential', 'ApiCredentialService/RevokeApiCredential'}
        assert procedure in permitted and method == 'POST'
        role = next((name for name, actor in actors.items() if actor['session'] is opener), 'anonymous')
        body = json.dumps(payload).encode() if payload is not None else None
        req = urllib.request.Request(url, data=body, method=method, headers={'Origin': smoke.GOLF, 'Content-Type': 'application/json', **(headers or {})})
        try:
            response = opener.open(req, timeout=15)
        except urllib.error.HTTPError as error:
            response = error
        with response:
            raw = response.read(2 << 20)
            assert len(raw) < 2 << 20
            result = json.loads(raw) if raw else None
            known_codes = {'invalid_argument', 'unauthenticated', 'permission_denied', 'not_found', 'resource_exhausted', 'unavailable', 'failed_precondition', 'internal', 'aborted', 'already_exists'}
            code = result.get('code') if isinstance(result, dict) else None
            observation = {'procedure': procedure, 'role': role, 'status': response.status, 'expected': expected, 'noStore': response.headers.get('Cache-Control') == 'no-store', 'code': code if code in known_codes else None}
            observations.append(observation)
            assert len(observations) <= 512
            if response.status != expected or not observation['noStore']:
                print('Deploy-key RPC observation: '+json.dumps(observation, sort_keys=True), file=sys.stderr)
            assert response.status == expected and observation['noStore'], 'Closed RPC observation failed'
            return result

    smoke.request = observed_request

    def command(*arguments, payload=None, timeout=60):
        result = subprocess.run(arguments, cwd=stack, input=None if payload is None else json.dumps(payload), capture_output=True, text=True, timeout=timeout)
        assert result.returncode == 0 and len(result.stdout) <= 2 << 20 and len(result.stderr) <= 2 << 20, 'Private subprocess failed; output withheld'
        return result.stdout.strip()

    def admin(*arguments):
        return command(*compose, 'exec', '-T', 'gitea', 'gitea', '--config', '/etc/gitea/app.ini', 'admin', 'user', *arguments)

    def operator(action, payload):
        result = json.loads(command(*compose, 'exec', '-T', 'golf', '/usr/local/bin/golf', 'local-account', action, payload=payload))
        assert result['state'] == 'complete'
        return result['result']

    def runtime():
        container = command(*compose, 'ps', '-q', 'golf')
        assert re.fullmatch(r'[0-9a-f]{12,64}', container)
        projection = '{"golfImageReference":{{json .Config.Image}},"golfOCIConfig":{{json .Image}},"productSourceRevision":{{json (index .Config.Labels "org.opencontainers.image.revision")}}}'
        observed = json.loads(command('docker', 'inspect', '--format', projection, container))
        assert re.fullmatch(r'[0-9a-f]{40}', observed['productSourceRevision'] or ''), 'Require an explicitly revision-labeled product image'
        observed['nativeVersion'] = smoke.request(smoke.client(), 'GET', smoke.GITEA+'/api/v1/version')['version']
        assert observed['nativeVersion'] == '1.27.3', 'This qualifier targets pinned native1.27.3'
        return observed

    def call(actor, method, payload, expected=200, code=None, headers=None):
        return smoke.rpc(actor['session'], SERVICE+method, payload, expected=expected, code=code, headers=headers)

    def access(actor, repository):
        observed = smoke.rpc(actor['session'], 'RepositoryAccessService/GetRepositoryAccess', {'repository': repository})['access']
        assert identifier(observed['repositoryId']) and identifier(observed['ownerId']) and HEX.fullmatch(observed['revision'])
        return {'repository': repository, 'repositoryId': observed['repositoryId'], 'ownerId': observed['ownerId'], 'expectedRevision': observed['revision']}, observed

    def inventory(actor, target):
        rows, page = [], 1
        for _ in range(12):
            observed = receipt(call(actor, METHODS[0], {**target, 'page': {'page': page, 'limit': 1}}), target)
            part = observed.get('keys', []); assert len(part) <= 1
            rows.extend(part)
            next_page = observed.get('page', {}).get('nextPage', 0)
            if not next_page:
                assert len({row['id'] for row in rows}) == len(rows)
                return rows
            assert part and next_page == page + 1
            page = next_page
        raise AssertionError('Deploy-key pagination did not terminate')

    def add(actor, target, public, title, read_only):
        row = receipt(call(actor, METHODS[1], {**target, 'publicKey': public, 'title': title, 'readOnly': read_only}), target)['key']
        key_receipt(row, public, title, read_only)
        native_matches(smoke.provider(owner['token'], 'GET', path(target)+'/keys/'+row['id']), row)
        assert any(observed == row for observed in inventory(actor, target))
        return row

    def detach(actor, target, row):
        observed = receipt(call(actor, METHODS[2], {**target, 'keyId': row['id'], 'expectedKeyRevision': row['revision']}), target)
        assert observed['keyId'] == row['id']
        smoke.provider(owner['token'], 'GET', path(target)+'/keys/'+row['id'], expected=404)
        assert not any(observed['id'] == row['id'] for observed in inventory(actor, target))

    def path(target):
        key = target['repository']; return 'repos/'+key['owner']+'/'+key['name']

    def native_inventory(target):
        rows=smoke.provider(owner['token'], 'GET', path(target)+'/keys?limit=50')
        # Native key rows embed mutable repository metadata. Visibility updates
        # deliberately change that metadata, not the observed SSH association.
        for row in rows:
            if row.get('repository') is not None:
                assert str(row['repository']['id'])==target['repositoryId']
                assert str(row['repository']['owner']['id'])==target['ownerId']
        return [{field:row[field] for field in ('id','key_id','title','key','fingerprint','created_at','read_only')} for row in rows]

    def native_ref(target, name):
        # Direct supported Git refs do not depend on the native branch DB cache.
        observed = smoke.provider(owner['token'], 'GET', path(target)+'/git/refs/heads/'+urllib.parse.quote(name, safe=''))
        rows = observed if isinstance(observed, list) else [observed]
        assert len(rows) == 1 and rows[0]['ref'] == 'refs/heads/'+name
        assert rows[0]['object']['type'] == 'commit' and re.fullmatch(r'[a-f0-9]{40}', rows[0]['object']['sha'])
        return rows[0]['object']['sha']

    try:
        smoke.ready(); runtime_before = runtime()
        print('Owned fixture scope: '+prefix, flush=True)
        stage = 'owned native actors and managed Golf accounts'
        for role in ('owner', 'admin', 'writer', 'reader', 'outsider', 'global') + (('teamadmin',) if args.organization else ()):
            name = prefix+'-'+role
            actor = {'name': name, 'session': smoke.client(), 'created': False, 'loggedIn': False}
            actors[role] = actor
            options = ['create', '--username', name, '--email', name+'@example.invalid', '--random-password', '--must-change-password=false']
            if role == 'global': options.append('--admin')
            admin(*options); actor['created'] = True
            token = admin('generate-access-token', '--username', name, '--token-name', prefix, '--scopes', 'write:user,write:repository,write:organization' if args.organization else 'write:user,write:repository', '--raw')
            actor.update(token=token, id=str(smoke.provider(token, 'GET', 'user')['id']), email=name+'@golf.invalid', password='Fixture '+secrets.token_urlsafe(24))
            enrolled.append(actor)
            operator('create', {'username': name, 'email': actor['email'], 'password': actor['password'], 'forge_token': token, 'is_instance_admin': role == 'global'})
            identity = smoke.rpc(actor['session'], 'SessionService/LoginWithPassword', {'username': actor['email'], 'password': actor['password']})['user']
            assert identity['id'] == actor['id'] and identity['login'] == name
            actor['loggedIn'] = True
        owner = actors['owner']; targets, native_repos = [], []
        namespace, namespace_id, teams = owner['name'], owner['id'], []
        if args.organization:
            stage = 'owned private organization and independently scoped ordinary member teams'
            namespace = prefix+'-org'
            owned_organization = smoke.provider(owner['token'], 'POST', 'orgs', {'username': namespace, 'visibility': 'private'}, expected=201)
            assert owned_organization['username'] == namespace
            namespace_id = str(owned_organization['id'])
            for role, permission in (('admin','read'), ('writer','read'), ('reader','read'), ('teamadmin','admin')):
                team = smoke.provider(owner['token'], 'POST', 'orgs/'+namespace+'/teams', {'name': role, 'permission': permission, 'visibility': 'limited', 'units_map': {'repo.code': permission}, 'includes_all_repositories': False}, expected=201)
                smoke.provider(owner['token'], 'PUT', 'teams/'+str(team['id'])+'/members/'+actors[role]['name'], expected=204)
                teams.append(team)
        for name in ('first', 'second'):
            native = smoke.provider(owner['token'], 'POST', 'orgs/'+namespace+'/repos' if args.organization else 'user/repos', {'name': name, 'private': True, 'auto_init': True}, expected=201)
            repository = {'owner': namespace, 'name': name}
            for team in teams:
                smoke.provider(owner['token'], 'PUT', 'teams/'+str(team['id'])+'/repos/'+namespace+'/'+name, expected=204)
            for role, permission in (('admin', 'admin'), ('writer', 'write'), ('reader', 'read')):
                smoke.provider(owner['token'], 'PUT', 'repos/'+namespace+'/'+name+'/collaborators/'+actors[role]['name'], {'permission': permission}, expected=204)
            target, meta = access(owner, repository)
            assert meta['canManage'] and target['repositoryId'] == str(native['id']) and target['ownerId'] == namespace_id
            assert meta.get('organizationOwned',False) is args.organization
            parsed_ssh = urllib.parse.urlparse(native['ssh_url'])
            assert parsed_ssh.scheme == 'ssh' and parsed_ssh.hostname in ('localhost', '127.0.0.1') and parsed_ssh.port == args.ssh_port
            targets.append(target); native_repos.append(native)
        first, second = targets
        with tempfile.TemporaryDirectory(prefix='golf-deploy-key-proof-') as directory:
            local = Path(directory); local.chmod(0o700)
            key_file = local/'shared'
            command('ssh-keygen', '-q', '-t', 'ed25519', '-N', '', '-f', str(key_file))
            public = key_file.with_suffix('.pub').read_text()
            stage = 'independent repository associations share one public key'
            ro = add(owner, first, public, 'Shared read-only', True)
            rw = add(owner, second, public, 'Shared write access', False)
            assert ro['id'] != rw['id'] and ro['publicKeyId'] == rw['publicKeyId']
            mistaken_target, association = (first, ro) if ro['id'] != ro['publicKeyId'] else (second, rw)
            assert association['id'] != association['publicKeyId'] and len(native_inventory(mistaken_target)) == 1
            call(owner, METHODS[2], {**mistaken_target, 'keyId': association['publicKeyId'], 'expectedKeyRevision': association['revision']}, expected=404)
            assert len(native_inventory(mistaken_target)) == 1
            known = local/'known_hosts'
            known.write_text(command('ssh-keyscan', '-4', '-T', '3', '-t', 'ed25519', '-p', str(args.ssh_port), 'localhost'))
            assert known.read_text().strip()
            env = {**os.environ, 'GIT_CONFIG_NOSYSTEM': '1', 'GIT_CONFIG_GLOBAL': os.devnull, 'GIT_TERMINAL_PROMPT': '0', 'GIT_SSH_COMMAND': shlex.join(['ssh', '-4', '-F', os.devnull, '-i', str(key_file), '-o', 'IdentityAgent=none', '-o', 'IdentitiesOnly=yes', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-o', 'UserKnownHostsFile='+str(known), '-o', 'ControlMaster=no', '-o', 'ControlPath=none'])}
            def git(work, *arguments, denied=False, denial=()):
                result = subprocess.run(['git', '-c', 'credential.helper=', '-c', 'core.hooksPath='+os.devnull, '-c', 'commit.gpgsign=false', *arguments], cwd=work, env=env, capture_output=True, text=True, timeout=35)
                assert (result.returncode != 0) if denied else (result.returncode == 0), 'Git transport result unexpected; sensitive output withheld'
                if denied and denial:
                    assert any(expected in result.stderr.lower() for expected in denial), 'Expected native authorization refusal was not observed; output withheld'
                return result.stdout.strip()
            def candidate(work, name):
                git(work, 'checkout', '-b', name)
                (work/'deploy-key-proof.txt').write_text('Owned deploy-key transport qualification\n')
                git(work, 'add', 'deploy-key-proof.txt')
                git(work, '-c', 'user.name=Golf qualifier', '-c', 'user.email=qualifier@example.invalid', 'commit', '-m', 'Owned deploy-key transport qualification')
                return git(work, 'rev-parse', 'HEAD')
            # Pinned native authorization text: https://raw.githubusercontent.com/go-gitea/gitea/v1.27.3/routers/private/serv.go
            stage = 'real read-only private clone and denied push'
            ro_work = local/'read-only'; git(local, 'clone', native_repos[0]['ssh_url'], str(ro_work))
            assert git(ro_work, 'rev-parse', 'HEAD') == native_ref(first, native_repos[0]['default_branch'])
            candidate(ro_work, 'denied-deploy-key-push')
            git(ro_work, 'push', 'origin', 'HEAD:refs/heads/denied-deploy-key-push', denied=True, denial=('is not authorized to write to',))
            assert git(ro_work, 'ls-remote', 'origin', 'refs/heads/denied-deploy-key-push') == ''
            stage = 'real read/write push and independent native commit readback'
            rw_work = local/'read-write'; git(local, 'clone', native_repos[1]['ssh_url'], str(rw_work))
            sha = candidate(rw_work, 'allowed-deploy-key-push')
            git(rw_work, 'push', 'origin', 'HEAD:refs/heads/allowed-deploy-key-push')
            assert native_ref(second, 'allowed-deploy-key-push') == sha
            assert smoke.provider(owner['token'], 'GET', path(second)+'/git/commits/'+sha)['sha'] == sha
            stage = 'current organization owner/member-direct admin and team-only/non-admin denial' if args.organization else 'current personal owner/direct admin and non-admin denial'
            admin_target, admin_meta = access(actors['admin'], first['repository']); assert admin_meta['canManage']
            extra_file = local/'direct-admin'; command('ssh-keygen', '-q', '-t', 'ed25519', '-N', '', '-f', str(extra_file))
            extra = add(actors['admin'], admin_target, extra_file.with_suffix('.pub').read_text(), 'Direct administrator key', True)
            assert len(inventory(owner, first)) == 2
            detach(actors['admin'], admin_target, extra)
            baseline = native_inventory(first)
            for role in ('writer', 'reader', 'global') + (('teamadmin',) if args.organization else ()):
                if args.organization and role == 'global':
                    # A site administrator with no current organization
                    # membership cannot obtain its private access observation.
                    smoke.rpc(actors[role]['session'], 'RepositoryAccessService/GetRepositoryAccess', {'repository': first['repository']}, expected=404)
                    denied_target, expected_denial = first, 404
                else:
                    denied_target, denied_meta = access(actors[role], first['repository']); assert not denied_meta.get('canManage', False)
                    expected_denial = 403
                for method, fields in ((METHODS[0], {'page': {'limit': 1, 'page': 1}}), (METHODS[1], {'title': 'Denied', 'publicKey': public, 'readOnly': False}), (METHODS[2], {'keyId': ro['id'], 'expectedKeyRevision': ro['revision']})):
                    call(actors[role], method, {**denied_target, **fields}, expected=expected_denial)
            for method in METHODS:
                call(actors['outsider'], method, {**first, 'title': 'Denied', 'publicKey': public, 'readOnly': True, 'keyId': ro['id'], 'expectedKeyRevision': ro['revision']}, expected=404)
            assert native_inventory(first) == baseline
            stage = 'exact target and observed key/access revision refusal'
            for field, value in (('repositoryId', '9223372036854775807'), ('ownerId', '9223372036854775807'), ('expectedRevision', '0'*64)):
                call(owner, METHODS[0], {**first, field: value}, expected=400, code='failed_precondition')
            call(owner, METHODS[2], {**first, 'keyId': ro['id'], 'expectedKeyRevision': '0'*64}, expected=400, code='failed_precondition')
            call(owner, METHODS[2], {**second, 'keyId': ro['id'], 'expectedKeyRevision': ro['revision']}, expected=404)
            smoke.provider(owner['token'], 'PATCH', path(first), {'private': False})
            current, _ = access(owner, first['repository']); assert current['expectedRevision'] != first['expectedRevision']
            call(owner, METHODS[1], {**first, 'title': 'Stale visibility', 'publicKey': public, 'readOnly': False}, expected=400, code='failed_precondition')
            smoke.provider(owner['token'], 'PATCH', path(first), {'private': True})
            first, _ = access(owner, first['repository'])
            assert native_inventory(first) == baseline
            stage = 'Origin, delegated bearer and revoked-session refusal'
            delegation = smoke.rpc(owner['session'], 'ApiCredentialService/CreateApiCredential', {'label': 'Deploy-key boundary'})
            bearers.append((owner, delegation['credential']['id']))
            for method in METHODS:
                call({'session': smoke.client()}, method, first, headers={'Authorization': 'Bearer '+delegation['token']}, expected=403)
                call({'session': smoke.client()}, method, first, headers={'Authorization': 'token '+owner['token']}, expected=401)
                call(owner, method, {**first, 'title': 'Wrong origin', 'publicKey': public, 'readOnly': True, 'keyId': ro['id'], 'expectedKeyRevision': ro['revision']}, headers={'Origin': 'https://other.invalid'}, expected=403)
            smoke.rpc(actors['admin']['session'], 'SessionService/Logout'); actors['admin']['loggedIn'] = False
            call(actors['admin'], METHODS[1], {**admin_target, 'title': 'Expired administrator', 'publicKey': public, 'readOnly': True}, expected=401)
            assert native_inventory(first) == baseline
            stage = 'detaching first association preserves second global key and SSH grant'
            detach(owner, first, ro)
            git(ro_work, 'ls-remote', 'origin', denied=True, denial=('is not authorized to read',))
            native_matches(smoke.provider(owner['token'], 'GET', path(second)+'/keys/'+rw['id']), rw)
            assert sha in git(rw_work, 'ls-remote', 'origin', 'refs/heads/allowed-deploy-key-push')
            git(rw_work, 'push', 'origin', 'HEAD:refs/heads/surviving-deploy-key-push')
            assert native_ref(second, 'surviving-deploy-key-push') == sha
            replacement = add(owner, first, public, 'Reattached key', False)
            assert replacement['id'] != ro['id'] and replacement['publicKeyId'] == rw['publicKeyId']
            call(owner, METHODS[2], {**first, 'keyId': ro['id'], 'expectedKeyRevision': ro['revision']}, expected=404)
            detach(owner, first, replacement); detach(owner, second, rw)
            git(rw_work, 'ls-remote', 'origin', denied=True, denial=('permission denied', 'cannot find key'))
            assert native_inventory(first) == [] and native_inventory(second) == []
            if args.browser:
                stage = 'actual settings browser qualification'
                browser_keys = []
                for index in range(8):
                    key = local/('browser-'+str(index)); command('ssh-keygen', '-q', '-t', 'ed25519', '-N', '', '-f', str(key))
                    browser_keys.append(key.with_suffix('.pub').read_text())
                config = {'golf': smoke.GOLF, 'gitea': smoke.GITEA, 'email': owner['email'], 'password': owner['password'], 'ownerToken': owner['token'], 'repository': namespace+'/first', 'target': first, 'publicKeys': browser_keys, 'screenshots': str(args.screenshots.resolve()), 'runtime': runtime_before, 'stackRoot': str(stack)}
                proof = subprocess.run(['node', str(Path(__file__).with_name('repository-deploy-keys-browser.mjs'))], cwd=stack, input=json.dumps(config), capture_output=True, text=True, timeout=240)
                for line in proof.stderr.splitlines():
                    if line.startswith('Deploy-key browser failed at ') or line == 'Deploy-key browser logout failed':
                        print(line, file=sys.stderr)
                assert proof.returncode == 0, 'Browser proof failed; sensitive output withheld'
                print(proof.stdout.strip())
                assert native_inventory(first) == [] and native_inventory(second) == []
            assert runtime() == runtime_before, 'Product runtime changed during qualification'
        passed = True
    except Exception as failure:
        original_failure = type(failure).__name__
        frames=traceback.extract_tb(failure.__traceback__)
        location=next((frame for frame in reversed(frames) if frame.filename==__file__),frames[-1])
        print('Deploy-key qualification failed at '+stage+'; '+type(failure).__name__+'; qualifier line '+str(location.lineno)+'; private diagnostics withheld', file=sys.stderr)
        raise
    finally:
        failures = []
        for actor, credential_id in bearers:
            try: smoke.rpc(actor['session'], 'ApiCredentialService/RevokeApiCredential', {'credentialId': credential_id})
            except Exception: failures.append('bearer revocation')
        for actor in actors.values():
            try:
                if actor['loggedIn']:
                    smoke.rpc(actor['session'], 'SessionService/RevokeOtherSessions')
                    smoke.rpc(actor['session'], 'SessionService/Logout')
                    actor['loggedIn'] = False
            except Exception: failures.append('session cleanup')
        for actor in reversed(enrolled):
            try: assert operator('disable', {'username': actor['name']})['disabled']
            except Exception: failures.append('managed account disable')
        if owned_organization is not None:
            try:
                for native in reversed(native_repos):
                    route = 'repos/'+native['full_name']
                    current = smoke.provider(owner['token'], 'GET', route)
                    assert str(current['id']) == str(native['id']) and str(current['owner']['id']) == str(owned_organization['id'])
                    smoke.provider(owner['token'], 'DELETE', route, expected=204)
                    smoke.provider(owner['token'], 'GET', route, expected=404)
                route = 'orgs/'+owned_organization['username']
                current = smoke.provider(owner['token'], 'GET', route)
                assert str(current['id']) == str(owned_organization['id'])
                smoke.provider(owner['token'], 'DELETE', route, expected=204)
                smoke.provider(owner['token'], 'GET', route, expected=404)
            except Exception: failures.append('owned organization/repository cleanup')
        for actor in reversed(list(actors.values())):
            if actor['created']:
                try: admin('delete', '--username', actor['name'], '--purge')
                except Exception: failures.append('native purge')
        if args.browser and (args.screenshots/'manifest.json').is_file():
            manifest = json.loads((args.screenshots/'manifest.json').read_text())
            manifest.update(status='qualified' if passed and not failures else 'failed', nativeProofPassed=passed, repositoryScope='organization' if args.organization else 'personal', cleanup='complete' if not failures else 'incomplete')
            (args.screenshots/'manifest.json').write_text(json.dumps(manifest, indent=2)); (args.screenshots/'manifest.json').chmod(0o600)
        smoke.request = original_request
        if args.proof_output:
            proof = {'status': 'qualified' if passed and not failures else 'failed', 'nativeProofPassed': passed, 'repositoryScope': 'organization' if args.organization else 'personal', 'runtime': runtime_before, 'stage': stage, 'originalFailureType': original_failure, 'cleanup': 'complete' if not failures else 'incomplete', 'cleanupFailures': sorted(set(failures)), 'rpcObservations': observations}
            args.proof_output.write_text(json.dumps(proof, indent=2)+'\n'); args.proof_output.chmod(0o600)
        if failures:
            print('Deploy-key cleanup categories: '+json.dumps(sorted(set(failures))), file=sys.stderr)
        # Preserve the original proof exception if cleanup also fails.
        if failures and original_failure is None:
            raise AssertionError('Disposable deploy-key fixture cleanup incomplete')
        if not failures:
            print('Cleanup: native actors/repos/keys purged, managed fixture accounts disabled, sessions/bearers revoked; Golf account audit history remains retained.', flush=True)
    print('PASS: actual RO clone/denied push, RW push, association/global identity and multi-repository detach survival, native readback, direct-owner/admin authorization and exact revision/Origin/bearer/session boundaries')
    if not args.browser: print('Browser not executed; no settings/UI or theme/mobile qualification claimed.')


if __name__ == '__main__':
    try: main()
    except Exception:
        print('Deploy-key qualifier unsuccessful; private diagnostics withheld', file=sys.stderr)
        sys.exit(1)
