#!/usr/bin/env python3
"""Configure one new private automatic-CI demo on the retained loopback stack.

Requires a qualified current schema, .tmp/local-admin/golf-login.txt and the full
local worker/storage profile. Never changes existing repositories or passwords.
Creates an explicit 24-hour personal delegation and a repository hook; enables
only this repository under existing instance ceilings. Tokens stay in memory.
"""
import argparse
from datetime import datetime, timedelta, timezone
import json
import os
from pathlib import Path
import secrets
import stat
import subprocess
import sys
import tempfile
import time
import uuid

sys.dont_write_bytecode = True
import smoke

ROOT = Path(__file__).resolve().parents[1]
COMPOSE = ['docker', 'compose', '--env-file', '.env', '--env-file', '.env.ci', '--env-file', '.env.storage',
           '-f', 'compose.yaml', '-f', 'compose.ci.yaml', '-f', 'compose.storage.yaml']


def command(*args, **kwargs):
    result = subprocess.run(args, capture_output=True, cwd=ROOT, timeout=180, **kwargs)
    assert result.returncode == 0, 'Local command failed; private diagnostics withheld'
    assert len(result.stdout) <= 8 << 20 and len(result.stderr) <= 8 << 20
    return result.stdout.decode().strip()


def private(path):
    info = path.lstat()
    assert stat.S_ISREG(info.st_mode) and info.st_uid == os.getuid() and stat.S_IMODE(info.st_mode) & 0o077 == 0


def configure(values):
    path = ROOT/'.env.ci'
    private(path)
    lines = path.read_text().splitlines()
    keys = [line.split('=', 1)[0] for line in lines if line and not line.startswith('#')]
    assert len(keys) == len(set(keys)), 'Duplicate local configuration keys'
    lines = [line for line in lines if line.split('=', 1)[0] not in values]
    for key, value in values.items():
        assert "'" not in value and '\n' not in value and '\r' not in value
        lines.append(key+"='"+value+"'")
    temporary = path.with_suffix('.ci.pending')
    with os.fdopen(os.open(temporary, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600), 'w') as out:
        out.write('\n'.join(lines)+'\n')
        out.flush(); os.fsync(out.fileno())
    os.replace(temporary, path)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--configure", action="store_true", required=True, help="Create and enable a new private local CI demo")
    parser.parse_args()
    schema = command('docker', 'exec', 'golf-postgres-1', 'psql', '-U', 'postgres', '-d', 'golf',
        '-Atc', 'SELECT max(version_id) FROM goose_db_version WHERE is_applied;')
    assert schema == '202610020021', 'Upgrade to the qualified schema before configuring a demo'
    login = ROOT/'.tmp/local-admin/golf-login.txt'
    private(login)
    credentials = dict(line.split(': ', 1) for line in login.read_text().splitlines() if ': ' in line)
    session = smoke.client()
    user = smoke.rpc(session, 'SessionService/LoginWithPassword', {
        'username': credentials['Email'], 'password': credentials['Password']})['user']
    assert user.get('isInstanceAdmin'), 'A local global administrator is required'
    try:
        capabilities = smoke.rpc(session, 'CapabilityService/ListCapabilities').get('capabilities', [])
        assert any(c['id']=='pipelines' and c['state']=='CAPABILITY_STATE_READY' for c in capabilities), 'A healthy local worker is required before creating a demo'
        owner = user['login']
        name = 'golf-local-ci-'+secrets.token_hex(3)
        repo = smoke.rpc(session, 'RepositoryService/CreateRepository', {'name': name,
            'private': True, 'idempotencyKey': str(uuid.uuid4())})['repository']
        key = {'owner': owner, 'name': name}
        assert repo['fullName'] == owner+'/'+name and repo.get('private')
        tokens = []
        for purpose, scopes in [('push', 'read:user,write:repository'), ('grant', 'read:user,read:repository')]:
            token = command(*COMPOSE, 'exec', '-T', 'gitea', 'gitea', '--config', '/etc/gitea/app.ini',
                'admin', 'user', 'generate-access-token', '--username', owner, '--token-name', name+'-'+purpose,
                '--scopes', scopes, '--raw')
            assert len(token) >= 8 and '\n' not in token
            tokens.append(token)
        push, delegated = tokens
        workflow = '.github/workflows/local.yml'
        with tempfile.TemporaryDirectory(prefix='golf-local-ci-') as directory:
            work = Path(directory)
            askpass = work/'askpass'
            askpass.write_text('#!/bin/sh\ncase "$1" in *Username*) printf "%s\\n" "$GOLF_DEMO_USER";; *) printf "%s\\n" "$GOLF_DEMO_TOKEN";; esac\n')
            askpass.chmod(0o700)
            environment = {k: v for k, v in os.environ.items() if not k.startswith('GIT_')}
            environment.update(GIT_ASKPASS=str(askpass), GIT_TERMINAL_PROMPT='0', GIT_CONFIG_NOSYSTEM='1',
                GIT_CONFIG_GLOBAL=os.devnull, GOLF_DEMO_USER=owner, GOLF_DEMO_TOKEN=push)
            def git(*arguments):
                return command('git', '-c', 'credential.helper=', '-c', 'core.hooksPath=/dev/null',
                    '-c', 'commit.gpgsign=false', '-c', 'http.followRedirects=false', '-C', str(work),
                    *arguments, env=environment)
            git('init', '--template=', '-b', 'main')
            git('config', 'user.name', 'Golf local demo'); git('config', 'user.email', credentials['Email'])
            (work/workflow).parent.mkdir(parents=True)
            (work/workflow).write_text('on: push\njobs:\n  check:\n    runs-on: linux\n    steps:\n      - run: |\n          test "$(id -u)" = 1000\n          test -f README.md\n          printf "Golf local automatic CI passed\\n"\n')
            (work/'README.md').write_text('# Golf local CI\n\nA private native Git repository with automatic isolated shell CI.\n')
            git('add', 'README.md', workflow); git('commit', '-m', 'Add local automatic CI demo')
            remote = smoke.GITEA+'/'+owner+'/'+name+'.git'
            git('push', remote, 'HEAD:refs/heads/main'); smoke.wait_for_push(push, owner+'/'+name)
            connection, secret = str(uuid.uuid4()), secrets.token_hex(32)
            # Preserve other operator connections; refuse to silently replace one.
            current = json.loads(command('docker', 'inspect', 'golf-forgejo-golf-1'))[0]
            runtime = dict(item.split('=', 1) for item in current['Config']['Env'])
            bindings = json.loads(runtime.get('GOLF_REPOSITORY_EVENT_CONNECTIONS') or '[]')
            bindings.append({'id': connection, 'repositoryId': str(repo['id']), 'ownerId': str(user['id']),
                'repository': owner+'/'+name, 'secret': secret})
            configure({'GOLF_REPOSITORY_EVENT_CONNECTIONS': json.dumps(bindings, separators=(',', ':')),
                'GOLF_PUSH_CI_ENABLED': 'true'})
            command(*COMPOSE, 'stop', 'runner')
            command(*COMPOSE, 'up', '-d', '--no-build', 'golf')
            command(*COMPOSE, 'up', '-d', '--no-build', 'runner'); smoke.ready()
            for scope in ['INSTANCE', 'REPOSITORY']:
                request = {'scope': 'EXECUTION_SCOPE_'+scope}
                if scope == 'REPOSITORY': request['repository'] = key
                old = smoke.rpc(session, 'ExecutionPolicyService/GetExecutionPolicy', request)['policy']
                selected = old.get('selectedRepositoryIds', [])
                mode = old.get('mode', 'EXECUTION_MODE_DISABLED')
                if scope == 'REPOSITORY': mode = 'EXECUTION_MODE_ALL'
                elif mode != 'EXECUTION_MODE_ALL':
                    mode = 'EXECUTION_MODE_SELECTED'; selected = list(dict.fromkeys([*selected, str(repo['id'])]))
                smoke.rpc(session, 'ExecutionPolicyService/UpdateExecutionPolicy', {**request,
                    'scopeId': old['scopeId'], 'expectedRevision': old.get('revision', '0'),
                    'expectedAuthorityRevision': old['authorityRevision'], 'mode': mode,
                    'selectedRepositoryIds': selected, 'manualDispatchEnabled': old.get('manualDispatchEnabled', False),
                    'pushAllowed': True, 'allowAllWorkflows': old.get('allowAllWorkflows', False),
                    'workflowPaths': list(dict.fromkeys([*old.get('workflowPaths', []), workflow]))})
            grant = smoke.rpc(session, 'AutomationGrantService/CreateAutomationGrant', {'repository': key,
                'expectedRepositoryId': str(repo['id']), 'expectedOwnerId': str(user['id']),
                'nativeToken': delegated, 'branches': ['main'], 'workflowPaths': [workflow],
                'expiresAt': (datetime.now(timezone.utc)+timedelta(hours=24)).isoformat(),
                'idempotencyKey': str(uuid.uuid4())})['grant']
            assert grant['executionState'] == 'requires_push_admission'
            smoke.provider(push, 'POST', 'repos/'+owner+'/'+name+'/hooks', {'type': 'gitea', 'active': True,
                'events': ['push'], 'branch_filter': 'main', 'config': {'url': 'http://golf:8080/hooks/forgejo/'+connection,
                    'content_type': 'json', 'http_method': 'POST', 'secret': secret}}, expected=201)
            time.sleep(7)
            (work/'README.md').write_text((work/'README.md').read_text()+'\nThis push exercises the automatic worker.\n')
            git('add', 'README.md'); git('commit', '-m', 'Exercise automatic Golf CI')
            commit = git('rev-parse', 'HEAD'); git('push', remote, 'HEAD:refs/heads/main')
            deadline = time.monotonic()+90
            while time.monotonic()<deadline:
                runs = smoke.rpc(session, 'WorkflowRunService/ListWorkflowRuns', {'repository': key}).get('runs', [])
                matching = [run for run in runs if run['commitId'] == commit]
                if matching:
                    assert len(matching)==1 and matching[0]['origin']=='WORKFLOW_RUN_ORIGIN_PUSH'
                    state=matching[0]['state']
                    if state=='WORKFLOW_RUN_STATE_SUCCEEDED':
                        print('PASS: http://localhost:8080/repositories/'+owner+'/'+name+'/settings/workflows')
                        print('Run: '+matching[0]['id']+' — native push, RustFS source, Docker execution')
                        return
                    assert state in ['WORKFLOW_RUN_STATE_QUEUED','WORKFLOW_RUN_STATE_RUNNING'], 'Demo run did not succeed'
                time.sleep(1)
            raise RuntimeError('Automatic demo run deadline exceeded')
    finally:
        smoke.rpc(session, 'SessionService/Logout')


if __name__=='__main__':
    try:
        main()
    except Exception:
        print('Local CI demo could not be completed; private diagnostics withheld.', file=sys.stderr)
        raise SystemExit(1)
