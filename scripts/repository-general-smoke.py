#!/usr/bin/env python3
"""Prepared disposable full-General native qualification (not proof until run).

--image selects an already-built local Golf image for a fresh base Compose stack.
No retained stack, CI overlay, runner, inference, provider credentials or policy
changes are used. Native/API actors and managed Golf accounts are disposable;
all project resources are removed on exit. --output must be a new owner-only
evidence directory; --ui adds 12 real browser captures. --self-check performs
no operations. This qualifies a personal repository; organization administration
and the Golf wiki workspace remain separate acceptance criteria.
"""
import argparse
import base64
import importlib.util
import json
import os
from pathlib import Path
import re
import secrets
import subprocess
import sys
import tempfile
import traceback
import urllib.parse

sys.dont_write_bytecode = True
import smoke
import uuid
ROOT = Path(__file__).resolve().parents[1]
SERVICE = 'RepositorySettingsService/'
MODES = {False: 'REPOSITORY_FEATURE_MODE_DISABLED', True: 'REPOSITORY_FEATURE_MODE_INTERNAL'}
EXTERNAL = 'REPOSITORY_FEATURE_MODE_EXTERNAL'
STAGE = 'arguments'
OUTPUT = None
NATIVE_SOURCES = ['https://codeberg.org/forgejo/forgejo/raw/tag/v15.0.9/'+path for path in ('services/convert/repository.go', 'modules/structs/repo.go', 'routers/api/v1/repo/repo.go', 'routers/api/v1/repo/topic.go', 'routers/api/v1/repo/branch.go')]
PROOF = {'status':'not_started', 'nativeSources':NATIVE_SOURCES, 'scope':'Disposable personal-repository full General configuration only; no atomic CAS, organization administration, wiki workspace, CI or broader settings claim', 'cleanup':'not_started', 'captures':[]}


def record(**values):
    PROOF.update(values)
    if OUTPUT is not None:
        temporary = OUTPUT/'manifest.json.tmp'
        with temporary.open('w', encoding='utf-8') as stream:
            temporary.chmod(0o600)
            json.dump(PROOF, stream, indent=2, sort_keys=True); stream.write('\n')
        temporary.replace(OUTPUT/'manifest.json')


def stage(value):
    global STAGE
    STAGE = value
    record(stage=value)
    print('CHECK: '+value, flush=True)


def native_shape(row):
    """Required converter presence; absent/null never becomes false or empty."""
    assert type(row['id']) is int and row['id'] > 0 and type(row['owner']['id']) is int and row['owner']['id'] > 0
    assert isinstance(row['topics'], list) and len(row['topics']) <= 25
    assert len(set(row['topics'])) == len(row['topics'])
    assert all(isinstance(v, str) and len(v) <= 35 and re.fullmatch(r'[a-z0-9][-.a-z0-9]*', v) for v in row['topics'])
    assert isinstance(row['website'], str) and len(row['website'].encode()) <= 1024
    for key in ('has_issues', 'has_wiki', 'has_pull_requests', 'archived', 'mirror'):
        assert type(row[key]) is bool
    internal, tracker, wiki = row.get('internal_tracker'), row.get('external_tracker'), row.get('external_wiki')
    if row['has_issues']:
        assert (internal is not None) != (tracker is not None), 'Native enabled issues must have exactly one observed unit config'
        if internal is not None:
            assert all(type(internal[k]) is bool for k in ('enable_time_tracker', 'allow_only_contributors_to_track_time', 'enable_issue_dependencies'))
        else:
            assert all(isinstance(tracker[k], str) for k in ('external_tracker_url', 'external_tracker_format', 'external_tracker_style', 'external_tracker_regexp_pattern'))
    else:
        assert internal is None and tracker is None
    if wiki is not None:
        assert row['has_wiki'] and isinstance(wiki['external_wiki_url'], str)
    return row


def settings_receipt(value, native):
    native_shape(native)
    assert value['repositoryId'] == str(native['id']) and value['ownerId'] == str(native['owner']['id'])
    assert re.fullmatch(r'[0-9a-f]{64}', value['revision']) and value['generalEditImplemented'] is True
    assert value.get('website', '') == native['website'] and value.get('description', '') == native['description'] and value['defaultBranch'] == native['default_branch']
    assert value.get('topics', []) == sorted(native['topics'])
    for wire, key in [('hasIssues', 'has_issues'), ('hasWiki', 'has_wiki'), ('hasPullRequests', 'has_pull_requests'), ('archived', 'archived'), ('mirror', 'mirror')]:
        assert value.get(wire, False) is native[key]
    assert value['issuesMode'] == (EXTERNAL if native.get('external_tracker') is not None else MODES[native['has_issues']])
    assert value['wikiMode'] == (EXTERNAL if native.get('external_wiki') is not None else MODES[native['has_wiki']])
    if value['issuesMode'] == EXTERNAL:
        tracker = native['external_tracker']
        assert value['externalTracker'] == {key:tracker[native_key] for key, native_key in [('url', 'external_tracker_url'), ('format', 'external_tracker_format'), ('style', 'external_tracker_style'), ('regexpPattern', 'external_tracker_regexp_pattern')] if tracker[native_key]}
    else:
        assert 'externalTracker' not in value
    if value['wikiMode'] == EXTERNAL:
        assert value['externalWiki'] == {'url':native['external_wiki']['external_wiki_url']}
    else:
        assert 'externalWiki' not in value
    return value


def self_check():
    global OUTPUT, PROOF
    source = (ROOT/'api/golf/v1/golf.proto').read_text()
    for method in ('GetRepositorySettings', 'UpdateRepositorySettings', 'UpdateRepositoryTopics'):
        assert 'rpc '+method+'(' in source
    for message, fields in {
        'GetRepositorySettingsRequest': [('string', 'repository_id', 2)],
        'RepositorySettings': [('string', 'website', 10), ('repeated string', 'topics', 11), ('RepositoryFeatureMode', 'issues_mode', 12), ('RepositoryFeatureMode', 'wiki_mode', 13), ('bool', 'general_edit_implemented', 18)],
        'UpdateRepositorySettingsRequest': [('optional string', 'website', 10), ('optional RepositoryFeatureMode', 'issues_mode', 11), ('optional RepositoryFeatureMode', 'wiki_mode', 12)],
        'UpdateRepositoryTopicsRequest': [('repeated string', 'topics', 5)],
    }.items():
        body = re.search(r'message '+message+r'\s*\{([^}]+)\}', source).group(1)
        for kind, name, tag in fields:
            assert re.search(re.escape(kind)+r'\s+'+name+r'\s*=\s*'+str(tag)+r'\s*;', body)
    row = {'id':7, 'owner':{'id':9}, 'topics':[], 'website':'', 'description':'', 'default_branch':'main', 'has_issues':True, 'has_wiki':False, 'has_pull_requests':True, 'archived':False, 'mirror':False, 'internal_tracker':{'enable_time_tracker':True, 'allow_only_contributors_to_track_time':False, 'enable_issue_dependencies':True}}
    settings_receipt({'repositoryId':'7', 'ownerId':'9', 'revision':'a'*64, 'generalEditImplemented':True, 'defaultBranch':'main', 'hasIssues':True, 'hasPullRequests':True, 'issuesMode':MODES[True], 'wikiMode':MODES[False]}, row)
    for mutate in (lambda r:r.pop('topics'), lambda r:r.update(topics=None), lambda r:r['internal_tracker'].pop('enable_issue_dependencies'), lambda r:r.update(has_issues=None), lambda r:r.update(internal_tracker=None), lambda r:r.update(external_tracker={'external_tracker_url':'https://example.test'})):
        broken = json.loads(json.dumps(row)); mutate(broken)
        try:
            native_shape(broken)
        except (AssertionError, KeyError, TypeError):
            pass
        else:
            raise AssertionError('Incomplete native converter counterexample accepted')
    prior_output, prior_proof = OUTPUT, PROOF
    try:
        with tempfile.TemporaryDirectory(prefix='golf-general-pure-') as temporary:
            OUTPUT = Path(temporary); OUTPUT.chmod(0o700); PROOF = {}
            record(status='failed', failedStage='initial predicate', cleanup='passed')
            observed = json.loads((OUTPUT/'manifest.json').read_text())
            assert observed['failedStage'] == 'initial predicate' and observed['cleanup'] == 'passed'
            assert (OUTPUT.stat().st_mode & 0o777) == 0o700 and ((OUTPUT/'manifest.json').stat().st_mode & 0o777) == 0o600
    finally:
        OUTPUT, PROOF = prior_output, prior_proof
    print('PASS: pure General wire/presence/counterexample checks; no Docker, HTTP, native or runtime operations executed')


def main():
    global OUTPUT
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--self-check', action='store_true')
    parser.add_argument('--image', help='Explicit already-built Golf image; resolved once, never built/pulled')
    parser.add_argument('--output', type=Path, help='New evidence directory, created mode 0700; safe manifests/captures only')
    parser.add_argument('--ui', action='store_true', help='Include actual browser Add/Edit/save/reload proof and 12 captures')
    args = parser.parse_args()
    if args.self_check:
        self_check(); return
    if not args.image or not args.output:
        parser.error('--image and --output are required for a fresh isolated qualification')
    args.output.mkdir(parents=True, exist_ok=False, mode=0o700); args.output.chmod(0o700); OUTPUT = args.output.resolve(strict=True)
    record(status='running', browser='pending' if args.ui else 'not_requested')
    if args.ui:
        stage('local browser dependency, no installation')
        assert (ROOT/'web/node_modules/playwright/index.mjs').is_file()
    spec = importlib.util.spec_from_file_location('general_helpers', ROOT/'scripts/observability-smoke.py')
    helpers = importlib.util.module_from_spec(spec); spec.loader.exec_module(helpers)
    environment = {key:value for key,value in os.environ.items() if not key.startswith(('GOLF_', 'FORGEJO_', 'POSTGRES_', 'COMPOSE_', 'OTEL_', 'AWS_', 'RUSTFS_')) and key != 'DATABASE_URL'}
    def run(*arguments, payload=None, timeout=180):
        result = subprocess.run(arguments, cwd=ROOT, env=environment, input=None if payload is None else json.dumps(payload).encode(), capture_output=True, timeout=timeout)
        assert result.returncode == 0 and len(result.stdout) <= 8<<20 and len(result.stderr) <= 8<<20, 'Private subprocess failed; diagnostics withheld'
        return result.stdout.decode().strip()
    stage('exact local image and pinned base dependencies')
    inspected = json.loads(run('docker', 'image', 'inspect', args.image))[0]
    image, revision = inspected['Id'], inspected['Config'].get('Labels', {}).get('org.opencontainers.image.revision')
    assert re.fullmatch(r'sha256:[0-9a-f]{64}', image) and re.fullmatch(r'[0-9a-f]{40}', revision or ''), 'Require explicitly revision-labeled product image'
    # Fail before creating anything rather than pulling or consuming retained disk.
    for name in ('postgres:18.4-alpine3.24', 'codeberg.org/forgejo/forgejo:15.0.9-rootless@sha256:caf1bca332f95cdcf124227a4bfa3b49bbbfbbc8a5e4a97406921cb581165413'):
        run('docker', 'image', 'inspect', name)
    space = run('docker', 'run', '--rm', '--pull=never', '--network=none', '--read-only', '--cap-drop=ALL', '--security-opt=no-new-privileges', '--entrypoint', '/bin/df', image, '-Pk', '/')
    assert int(space.splitlines()[-1].split()[3]) >= 2*1024*1024, 'Require 2 GiB free Docker VM space before fresh stack'
    project = 'golf-general-proof-'+secrets.token_hex(5)
    ports = helpers.free_ports(2); previous = smoke.GOLF, smoke.FORGE
    smoke.GOLF, smoke.FORGE = 'http://127.0.0.1:'+str(ports[0]), 'http://127.0.0.1:'+str(ports[1])
    actors, enrolled, bearers, started, passed = {}, [], [], False, False
    record(project=project, selectedImage=image, sourceRevision=revision, cleanup='not_created')
    with tempfile.TemporaryDirectory(prefix=project+'-') as temporary:
        directory = Path(temporary); directory.chmod(0o700)
        values = {key:secrets.token_hex(24) for key in ('POSTGRES_PASSWORD', 'GOLF_DB_PASSWORD', 'FORGEJO_DB_PASSWORD')} | {'GOLF_FORGE_INSTANCE_ID': str(uuid.uuid4())}
        values.update(GOLF_ENCRYPTION_KEY=base64.b64encode(secrets.token_bytes(32)).decode(), GOLF_PUBLIC_URL=smoke.GOLF, GOLF_PUSH_CI_ENABLED='false')
        env_file, override = directory/'core.env', directory/'proof.yaml'
        helpers.private_write(env_file, ''.join(key+'='+value+'\n' for key,value in values.items()))
        helpers.private_write(override, f'''services:
  golf:
    image: {image}
    pull_policy: never
    ports: !override ["127.0.0.1:{ports[0]}:8080"]
  forgejo:
    environment:
      FORGEJO__server__ROOT_URL: {smoke.FORGE}/
    ports: !override ["127.0.0.1:{ports[1]}:3000"]
''')
        compose = ['docker', 'compose', '-p', project, '--env-file', str(env_file), '-f', str(ROOT/'compose.yaml'), '-f', str(override)]
        def command(*arguments, **kwargs): return run(*compose, *arguments, **kwargs)
        def admin(*arguments): return command('exec', '-T', 'forgejo', 'forgejo', '--config', '/var/lib/gitea/custom/conf/app.ini', 'admin', 'user', *arguments)  # Forgejo's upstream path
        def operator(action, payload):
            result = json.loads(command('exec', '-T', 'golf', '/usr/local/bin/golf', 'local-account', action, payload=payload))
            assert result['state'] == 'complete'; return result['result']
        def runtime():
            container = command('ps', '-q', 'golf'); assert re.fullmatch(r'[0-9a-f]{12,64}', container)
            observed = json.loads(run('docker', 'inspect', '--format', '{"image":{{json .Image}},"reference":{{json .Config.Image}},"revision":{{json (index .Config.Labels "org.opencontainers.image.revision")}},"composeConfigHash":{{json (index .Config.Labels "com.docker.compose.config-hash")}}}', container))
            assert observed['image'] == image and observed['reference'] == image and observed['revision'] == revision
            observed['nativeVersion'] = smoke.request(smoke.client(), 'GET', smoke.FORGE+'/api/v1/version')['version']; assert observed['nativeVersion'] == '15.0.9+gitea-1.22.0'  # Forgejo's upstream version string
            return observed
        def call(actor, method, payload, **kwargs): return smoke.rpc(actor['session'], SERVICE+method, payload, **kwargs)
        try:
            stage('fresh base stack, CI and agents unconfigured')
            record(cleanup='pending'); started = True; command('up', '-d', '--no-build', '--pull', 'never', timeout=180); smoke.ready(); before_runtime = runtime()
            record(runtime=before_runtime)
            print('Runtime provenance: '+json.dumps(before_runtime, sort_keys=True), flush=True)
            stage('disposable ordinary native actors and managed password sessions')
            for role in ('owner', 'reader', 'outsider'):
                name = project+'-'+role; actor = {'name':name, 'created':False, 'session':smoke.client(), 'loggedIn':False}; actors[role] = actor
                admin('create', '--username', name, '--email', name+'@example.invalid', '--random-password', '--must-change-password=false'); actor['created'] = True
                actor['token'] = admin('generate-access-token', '--username', name, '--token-name', project, '--scopes', 'write:user,write:repository,write:issue', '--raw')
                native_user = smoke.provider(actor['token'], 'GET', 'user'); assert type(native_user['is_admin']) is bool and not native_user['is_admin']
                actor.update(id=str(native_user['id']), email=name+'@golf.invalid', password='General fixture '+secrets.token_urlsafe(24)); enrolled.append(actor)
                operator('create', {'username':name, 'email':actor['email'], 'password':actor['password'], 'forge_token':actor['token'], 'is_instance_admin':False})
                user = smoke.rpc(actor['session'], 'SessionService/LoginWithPassword', {'username':actor['email'], 'password':actor['password']})['user']; assert user['id'] == actor['id'] and not user.get('isInstanceAdmin', False); actor['loggedIn'] = True
            owner, reader, outsider = (actors[role] for role in ('owner', 'reader', 'outsider'))
            stage('supported native converter initial shape and exact source identity')
            native = smoke.provider(owner['token'], 'POST', 'user/repos', {'name':'general', 'private':True, 'auto_init':True}, 201)
            repository = {'owner':owner['name'], 'name':'general'}; path = 'repos/'+native['full_name']; smoke.wait_for_push(owner['token'], native['full_name'])
            smoke.provider(owner['token'], 'PUT', path+'/collaborators/'+reader['name'], {'permission':'read'}, 204)
            def native_read(): return native_shape(smoke.provider(owner['token'], 'GET', path))
            def read(actor=owner, identifier=str(native['id'])):
                value = call(actor, 'GetRepositorySettings', {'repository':repository, 'repositoryId':identifier})['settings']; return settings_receipt(value, native_read())
            def target(settings): return {'repository':repository, 'repositoryId':settings['repositoryId'], 'ownerId':settings['ownerId'], 'expectedRevision':settings['revision']}
            def update(settings, **patch):
                value = call(owner, 'UpdateRepositorySettings', {**target(settings), **patch})['settings']; settings_receipt(value, native_read()); assert read() == value; return value
            def topics(settings, values):
                value = call(owner, 'UpdateRepositoryTopics', {**target(settings), 'topics':values})['settings']; settings_receipt(value, native_read()); assert read() == value; return value
            def ref(name):
                observed = smoke.provider(owner['token'], 'GET', path+'/git/refs/heads/'+urllib.parse.quote(name, safe=''))
                rows = observed if isinstance(observed, list) else [observed]
                exact = [row for row in rows if row['ref'] == 'refs/heads/'+name]; assert len(exact) == 1 and exact[0]['object']['type'] == 'commit' and re.fullmatch(r'[0-9a-f]{40}', exact[0]['object']['sha']); return exact[0]['object']['sha']
            initial = read(); assert initial['canEdit']; head = ref(initial['defaultBranch'])
            exact_source = {'repository':repository, 'repositoryId':initial['repositoryId'], 'ref':head, 'path':'README.md'}
            original_source = smoke.rpc(owner['session'], 'RepositoryService/GetContents', exact_source); assert original_source['repositoryId'] == initial['repositoryId'] and original_source['commitId'] == head and original_source['path'] == 'README.md'
            stage('current permission, exact refresh and non-admin/private denial')
            read_only = read(reader); assert not read_only.get('canEdit', False)
            for method, extra in [('UpdateRepositorySettings', {'website':'https://denied.example.invalid'}), ('UpdateRepositoryTopics', {'topics':['denied']})]:
                call(reader, method, {**target(read_only), **extra}, expected=403)
            call(outsider, 'GetRepositorySettings', {'repository':repository, 'repositoryId':initial['repositoryId']}, expected=404)
            call(owner, 'GetRepositorySettings', {'repository':repository, 'repositoryId':'9223372036854775807'}, expected=400, code='failed_precondition')
            stage('website and topics are independent writes preserving internal options')
            native_internal = {'enable_time_tracker':True, 'allow_only_contributors_to_track_time':False, 'enable_issue_dependencies':False}
            smoke.provider(owner['token'], 'PATCH', path, {'has_issues':True, 'internal_tracker':native_internal})
            current = read(); assert native_read()['internal_tracker'] == native_internal
            current = update(current, website='https://docs.example.invalid/golf', description='Actual General qualification'); assert native_read()['internal_tracker'] == native_internal
            unrelated = native_read(); current = topics(current, ['golf','agents']); after = native_read()
            for key in ('website', 'description', 'default_branch', 'internal_tracker', 'has_issues', 'has_wiki', 'has_pull_requests'):
                assert after.get(key) == unrelated.get(key)
            current = topics(current, []); assert current.get('topics', []) == []
            stage('explicit external units preserve full config on unrelated metadata edits')
            tracker = {'url':'https://issues.example.invalid', 'format':'https://issues.example.invalid/{user}/{repo}/{index}', 'style':'regexp', 'regexpPattern':'GOLF-[0-9]+'}
            wiki = {'url':'https://wiki.example.invalid/golf'}
            current = update(current, issuesMode=EXTERNAL, externalTracker=tracker, wikiMode=EXTERNAL, externalWiki=wiki)
            assert current['externalTracker'] == tracker and current['externalWiki'] == wiki
            current = update(current, description='External configuration preserved'); assert current['externalTracker'] == tracker and current['externalWiki'] == wiki
            call(owner, 'UpdateRepositorySettings', {**target(current), 'hasIssues':True}, expected=400)
            call(owner, 'UpdateRepositorySettings', {**target(current), 'hasWiki':True}, expected=400)
            assert read() == current
            stage('explicit disabled and internal transitions, source units remain observations')
            current = update(current, issuesMode=MODES[False], wikiMode=MODES[False], hasPullRequests=False)
            observed = smoke.rpc(reader['session'], 'RepositoryService/GetRepository', {'repository':repository})['repository']; assert observed['id'] == current['repositoryId']; assert not any(observed.get(k, False) for k in ('issuesEnabled', 'wikiEnabled', 'pullRequestsEnabled'))
            current = update(current, issuesMode=MODES[True], wikiMode=MODES[True], hasPullRequests=True)
            observed = smoke.rpc(reader['session'], 'RepositoryService/GetRepository', {'repository':repository})['repository']; assert all(observed[k] for k in ('issuesEnabled', 'wikiEnabled', 'pullRequestsEnabled')); assert 'externalTracker' not in current and 'externalWiki' not in current
            assert smoke.rpc(owner['session'], 'RepositoryService/GetContents', exact_source) == original_source
            stage('exact slash default branch and absent/prefix/stale branch refusal')
            smoke.provider(owner['token'], 'POST', path+'/branches', {'new_branch_name':'release/general', 'old_branch_name':initial['defaultBranch']}, 201); assert ref('release/general') == head
            current = update(current, defaultBranch='release/general')
            smoke.provider(owner['token'], 'POST', path+'/branches', {'new_branch_name':'stale-default', 'old_branch_name':'release/general'}, 201); assert ref('stale-default') == head
            smoke.provider(owner['token'], 'DELETE', path+'/branches/stale-default', expected=204)
            for missing in ('missing', 'release', 'stale-default'):
                call(owner, 'UpdateRepositorySettings', {**target(current), 'defaultBranch':missing}, expected=404); assert read() == current
            stage('native external edits, wrong IDs and revisions dispatch no Golf changes')
            stale = current; smoke.provider(owner['token'], 'PATCH', path, {'website':'https://outside.example.invalid'}); current = read(); assert current['revision'] != stale['revision']
            for method, extra in [('UpdateRepositorySettings', {'description':'must not write'}), ('UpdateRepositoryTopics', {'topics':['must-not-write']})]:
                call(owner, method, {**target(stale), **extra}, expected=400, code='failed_precondition')
                call(owner, method, {**target(current), **extra, 'repositoryId':'9223372036854775807'}, expected=400, code='failed_precondition')
                call(owner, method, {**target(current), **extra, 'ownerId':'9223372036854775807'}, expected=400, code='failed_precondition')
            assert read() == current
            if args.ui:
                stage('real browser requested General and Topics editors, save/readback/reload')
                browser_config = {'stackRoot':str(ROOT), 'golf':smoke.GOLF, 'forge':smoke.FORGE, 'repository':native['full_name'], 'repositoryId':current['repositoryId'], 'ownerId':current['ownerId'], 'email':owner['email'], 'password':owner['password'], 'ownerToken':owner['token'], 'screenshots':str(OUTPUT), 'runtime':before_runtime}
                result = subprocess.run(['node', str(ROOT/'scripts/repository-general-browser.mjs')], cwd=ROOT, env=environment, input=json.dumps(browser_config).encode(), capture_output=True, timeout=300)
                assert len(result.stdout) <= 65536 and len(result.stderr) <= 65536
                browser_proof = json.loads((OUTPUT/'browser-manifest.json').read_text())
                record(browser=browser_proof['status'], captures=browser_proof['captures'], browserProcedureStatusCounts=browser_proof.get('procedureStatusCounts', {}), browserRequestCounts=browser_proof.get('requestCounts', {}), browserFailedStage=browser_proof.get('failedStage'))
                assert result.returncode == 0 and browser_proof['status'] == 'browser_checks_passed_parent_native_cleanup_pending' and len(browser_proof['captures']) == 12 and browser_proof['runtime'] == before_runtime, 'Browser proof failed; safe staged manifest available'
                assert result.stdout.decode().startswith('PASS: actual full-General requested editors,')
                print(result.stdout.decode().strip(), flush=True)
                current = read()
            stage('archived native state refuses both editors without changing source')
            smoke.provider(owner['token'], 'PATCH', path, {'archived':True})
            archived = read(); assert archived['archived'] and not archived.get('canEdit', False)
            for method, extra in [('UpdateRepositorySettings', {'description':'must not edit archive'}), ('UpdateRepositoryTopics', {'topics':['must-not-edit-archive']})]:
                call(owner, method, {**target(archived), **extra}, expected=403)
            assert read() == archived
            smoke.provider(owner['token'], 'PATCH', path, {'archived':False})
            current = read(); assert not current.get('archived', False) and current['canEdit']
            assert smoke.rpc(owner['session'], 'RepositoryService/GetContents', exact_source) == original_source
            record(archivedEditFences='passed')
            stage('native rename and replacement cannot reuse the former immutable target')
            pinned = current
            renamed = smoke.provider(owner['token'], 'PATCH', path, {'name':'general-renamed'})
            assert renamed['id'] == int(pinned['repositoryId']) and renamed['owner']['id'] == int(pinned['ownerId'])
            replacement = smoke.provider(owner['token'], 'POST', 'user/repos', {'name':'general', 'private':True, 'auto_init':True}, 201)
            assert replacement['id'] != renamed['id']
            replacement_before = native_shape(smoke.provider(owner['token'], 'GET', path))
            call(owner, 'GetRepositorySettings', {'repository':repository, 'repositoryId':pinned['repositoryId']}, expected=400, code='failed_precondition')
            for method, extra in [('UpdateRepositorySettings', {'description':'must not edit replacement'}), ('UpdateRepositoryTopics', {'topics':['must-not-edit-replacement']})]:
                call(owner, method, {**target(pinned), **extra}, expected=400, code='failed_precondition')
            assert native_shape(smoke.provider(owner['token'], 'GET', path)) == replacement_before
            smoke.provider(owner['token'], 'DELETE', path, expected=204)
            restored = smoke.provider(owner['token'], 'PATCH', 'repos/'+renamed['full_name'], {'name':'general'})
            assert restored['id'] == int(pinned['repositoryId'])
            current = read(); assert current == pinned
            record(renameReplacementFences='passed')
            stage('Origin and bearer boundaries, then persisted source truth after logout')
            credential = smoke.rpc(owner['session'], 'ApiCredentialService/CreateApiCredential', {'label':'General qualifier'})
            bearers.append((owner, credential['credential']['id']))
            for method, extra in [('GetRepositorySettings', {}), ('UpdateRepositorySettings', {'description':'denied'}), ('UpdateRepositoryTopics', {'topics':['denied']})]:
                payload = {'repository':repository, 'repositoryId':current['repositoryId']} if method == 'GetRepositorySettings' else {**target(current), **extra}
                call(owner, method, payload, headers={'Origin':'https://other.invalid'}, expected=403)
                smoke.rpc(smoke.client(), SERVICE+method, payload, headers={'Authorization':'Bearer '+credential['token']}, expected=403)
            smoke.rpc(owner['session'], 'ApiCredentialService/RevokeApiCredential', {'credentialId':credential['credential']['id']}); bearers.clear()
            current = update(current, website='', description=''); assert native_read()['website'] == '' and native_read()['description'] == ''
            smoke.rpc(owner['session'], 'SessionService/Logout'); owner['loggedIn'] = False
            call(owner, 'UpdateRepositorySettings', {**target(current), 'description':'revoked'}, expected=401)
            call(owner, 'UpdateRepositoryTopics', {**target(current), 'topics':['revoked']}, expected=401)
            settings_receipt(current, native_read()); assert runtime() == before_runtime
            record(nativeChecks='passed', runtimeUnchanged=True)
            passed = True
        finally:
            # Preserve the failing predicate's stage while cleanup runs independently.
            if not passed:
                record(failedStage=STAGE)
            print('CHECK: owned fixture cleanup', flush=True)
            failures = []
            for actor, identifier in bearers:
                try: smoke.rpc(actor['session'], 'ApiCredentialService/RevokeApiCredential', {'credentialId':identifier})
                except Exception: failures.append('bearer')
            for actor in actors.values():
                if actor['loggedIn']:
                    try: smoke.rpc(actor['session'], 'SessionService/RevokeOtherSessions'); smoke.rpc(actor['session'], 'SessionService/Logout')
                    except Exception: failures.append('session')
            for actor in reversed(enrolled):
                try: assert operator('disable', {'username':actor['name']})['disabled']
                except Exception: failures.append('managed disable')
            for actor in reversed(list(actors.values())):
                if actor['created']:
                    try: admin('delete', '--username', actor['name'], '--purge')
                    except Exception: failures.append('native purge')
            try:
                if started:
                    command('down', '--volumes', '--remove-orphans', timeout=180)
                    for arguments in [('ps','-aq'), ('volume','ls','-q'), ('network','ls','-q')]:
                        assert not run('docker', *arguments, '--filter', 'label=com.docker.compose.project='+project)
            except Exception:
                failures.append('fresh project resources')
            finally:
                smoke.GOLF, smoke.FORGE = previous
                record(cleanup='failed' if failures else 'passed', cleanupFailureCategories=failures)
            if failures and passed:
                record(failedStage='owned fixture cleanup')
            assert not failures, 'Owned native/managed cleanup incomplete (fresh project removed)'
            print('Cleanup: disposable actors/repos purged, managed sessions/bearers revoked/accounts disabled, fresh Compose containers/volumes/network removed.', flush=True)
    assert passed
    record(status='qualified', browser='qualified' if args.ui else 'not_requested')
    print('PASS: actual pinned native full General metadata/topics/modes/default-ref/identity/RBAC/readback qualification on an unchanged isolated runtime; no atomic CAS, wiki workspace, CI or broader settings claim')


if __name__ == '__main__':
    try:
        main()
    except Exception as failure:
        frames = traceback.extract_tb(failure.__traceback__)
        frame = next((item for item in reversed(frames) if item.filename == __file__), frames[-1])
        try:
            record(status='failed', failedStage=PROOF.get('failedStage', STAGE), failureType=type(failure).__name__, failureLine=frame.lineno)
        except Exception:
            pass
        print('General qualifier failed at '+PROOF.get('failedStage', STAGE)+': '+type(failure).__name__+'; line '+str(frame.lineno)+'; private diagnostics withheld', file=sys.stderr)
        raise SystemExit(1)
