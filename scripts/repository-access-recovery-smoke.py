#!/usr/bin/env python3
"""Prepared schema059 Access-core backup/restore drill; runtime evidence only when run.

Root supplies exact cached --image, --source-revision and --proxy-image (Python3).
No build/pull, retained stack, external provider, workflow execution or SQL fixture
writes. Supported native/API enrollment produces the retained histories. Recovery
uses the documented offline PostgreSQL/native-volume exception in fresh targets.
Private fixture bodies/credentials stay in RAM or temporary owner-only files.
"""
import argparse
import base64
import datetime
import hashlib
import ipaddress
import json
import os
from pathlib import Path
import re
import secrets
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import traceback
import urllib.error
import urllib.parse
import urllib.request
import uuid
sys.dont_write_bytecode = True
import recovery
import smoke

ROOT = Path(__file__).resolve().parents[1]
HISTORY = {
    'golf_repository_access_operations': 'id',
    'golf_repository_access_generations': 'forge_url,repository_id,recipient_id',
    'golf_repository_access_operation_events': 'id',
    'golf_repository_invitations': 'id',
    'golf_repository_invitation_operations': 'id',
    'golf_repository_invitation_events': 'id',
    'golf_repository_invitation_operation_events': 'id',
}
PATH = '.github/workflows/recovery.yml'
WORKFLOW = b'''name: Recovery input retention
on:
  workflow_dispatch:
    inputs:
      text:
        type: string
        required: true
jobs:
  retain:
    runs-on: linux
    steps:
      - run: echo never executed by the recovery drill
'''
CATALOG = 'golf.workflow.act.v0.2.89.linux.v2'
STAGE = 'source prerequisites'
# This temporary adapter has only one fixed native destination, one exact owned
# fault and bounded counters. It is removed before the canonical capture.
PROXY_SOURCE = r'''
import http.client, http.server, ipaddress, json, os, re, socket, threading
IP = os.environ['NATIVE_IP']; ipaddress.IPv4Address(IP)
PROJECT = os.environ['OWNED_PROJECT']; assert re.fullmatch('golf-access059-[a-f0-9]{10}', PROJECT)
NONCE = os.environ['CONTROL_NONCE']; assert re.fullmatch('[a-f0-9]{64}', NONCE)
PREFIX = '/api/v1/repos/' + PROJECT + '-owner/'
PAIR = os.environ['FAULT_PAIR']; assert PAIR in {'direct', 'invitation'}
TARGET = PREFIX + ('unknown/collaborators/' + PROJECT + '-outsider' if PAIR == 'direct' else 'invitation-unknown/collaborators/' + PROJECT + '-recipient')
LOCK = threading.Lock(); LIMIT = threading.BoundedSemaphore(4)
STATE = {'forwards': 0, 'writes': 0, 'lost': 0, 'armed': False, 'failures': 0, 'controls': 0}
class Handler(http.server.BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.0'
    def setup(self):
        super().setup(); self.connection.settimeout(10)
    def log_message(self, *args): pass
    def control(self):
        with LOCK:
            if STATE['controls'] >= 256: return False
            STATE['controls'] += 1
        return True
    def reply(self, status, payload):
        raw = json.dumps(payload).encode(); self.send_response(status)
        self.send_header('Content-Type', 'application/json'); self.send_header('Cache-Control', 'no-store')
        self.send_header('Content-Length', str(len(raw))); self.end_headers(); self.wfile.write(raw)
    def do_POST(self):
        if self.server.server_port != 8082 or self.headers.get('X-Control-Nonce') != NONCE or not self.control():
            return self.reply(403, {'state': 'refused'})
        if self.path != '/arm' or self.headers.get('Content-Length') != '2':
            return self.reply(400, {'state': 'refused'})
        if self.rfile.read(2) != b'{}': return self.reply(400, {'state': 'refused'})
        with LOCK:
            if STATE['armed'] or STATE['lost']: return self.reply(409, {'state': 'refused'})
            STATE['armed'] = True
        self.reply(200, {'state': 'armed'})
    def do_GET(self):
        if self.server.server_port == 8082:
            if self.headers.get('X-Control-Nonce') != NONCE or self.path != '/state' or self.headers.get('Content-Length', '0') != '0' or not self.control():
                return self.reply(403, {'state': 'refused'})
            with LOCK: value = dict(STATE)
            return self.reply(200, value)
        self.forward()
    def do_PUT(self): self.forward()
    def forward(self):
        if self.server.server_port != 3000 or not LIMIT.acquire(False):
            return self.reply(503, {'state': 'refused'})
        connection = None
        try:
            path = self.path
            assert len(path) <= 4096 and '\\' not in path and not path.startswith('//')
            assert not self.headers.get('Transfer-Encoding')
            size = int(self.headers.get('Content-Length', '0')); assert 0 <= size <= 1048576
            assert (self.command == 'GET' and size == 0 and path.startswith('/api/v1/')) or (self.command == 'PUT' and path == TARGET)
            payload = self.rfile.read(size); assert len(payload) == size
            headers = {k: v for k, v in self.headers.items() if k.lower() not in {'host','connection','content-length','proxy-authorization','x-control-nonce'}}
            connection = http.client.HTTPConnection(IP, 3000, timeout=10)
            with LOCK:
                assert STATE['forwards'] < 256; STATE['forwards'] += 1
                if self.command != 'GET': STATE['writes'] += 1
            connection.request(self.command, path, payload, headers)
            response = connection.getresponse(); body = response.read(2097153); assert len(body) <= 2097152
            with LOCK:
                drop = STATE['armed'] and self.command == 'PUT' and path == TARGET
                if drop:
                    assert response.status == 204 and body == b''
                    STATE['armed'] = False; STATE['lost'] += 1
            if drop:
                self.close_connection = True; self.connection.shutdown(socket.SHUT_RDWR); self.connection.close(); return
            self.send_response(response.status)
            for k, v in response.getheaders():
                if k.lower() not in {'connection','content-length','transfer-encoding','keep-alive'}: self.send_header(k, v)
            self.send_header('Content-Length', str(len(body))); self.end_headers(); self.wfile.write(body)
        except Exception:
            with LOCK: STATE['failures'] += 1
            self.close_connection = True
            try: self.reply(502, {'state': 'unavailable'})
            except Exception: pass
        finally:
            if connection: connection.close()
            LIMIT.release()
if __name__ == '__main__':
    for port in (3000, 8082):
        server = http.server.ThreadingHTTPServer(('0.0.0.0', port), Handler)
        server.daemon_threads = True
        threading.Thread(target=server.serve_forever, daemon=True).start()
    threading.Event().wait()
'''


def private(path, value):
    path.write_bytes(value if isinstance(value, bytes) else value.encode())
    path.chmod(0o600)


def inventory(value):
    value = recovery.checked_key_status(value)
    return {key: sum(row[key] for row in value['keys']) for key in recovery.KEY_FAMILIES}


def equal_history(before, after):
    assert set(before) == set(after) == set(HISTORY)
    assert all(before[table] == after[table] for table in HISTORY), 'Original Access/invitation history changed'


def check_restored_history(before, after):
    # Migration044 intentionally expires PENDING invitations when recovery
    # disables/version-invalidates their issuer. Everything else is exact.
    changed = {'golf_repository_invitations', 'golf_repository_invitation_events'}
    assert set(before) == set(after) == set(HISTORY)
    assert all(before[t] == after[t] for t in HISTORY if t not in changed)
    original = json.loads(before['golf_repository_invitations'])
    current = json.loads(after['golf_repository_invitations'])
    assert len(original) == len(current) and [r['id'] for r in original] == [r['id'] for r in current]
    expired = {}
    for a, b in zip(original, current):
        if a['state'] != 'PENDING':
            assert a == b
            continue
        assert b['state'] == 'EXPIRED' and b['revision'] == a['revision'] + 1
        assert datetime.datetime.fromisoformat(b['updated_at']) >= datetime.datetime.fromisoformat(a['updated_at'])
        assert {k:v for k,v in a.items() if k not in {'state','revision','updated_at'}} == {k:v for k,v in b.items() if k not in {'state','revision','updated_at'}}
        expired[a['id']] = b['revision']
    events = json.loads(before['golf_repository_invitation_events'])
    observed = json.loads(after['golf_repository_invitation_events'])
    assert observed[:len(events)] == events
    added = observed[len(events):]
    assert len(added) == len(expired) and len({r['invitation_id'] for r in added}) == len(expired)
    assert all(r['state'] == 'EXPIRED' and expired.get(r['invitation_id']) == r['revision'] and
               type(r['id']) is int and r['id'] > max((v['id'] for v in events), default=0) for r in added)
    return len(expired)


def reject(check):
    try: check()
    except (ValueError, AssertionError): return
    raise AssertionError('Closed recovery guard admitted an unsupported profile')



def proxy_self_check():
    # In-process fake transport proves harness guards only, never native effects.
    from unittest.mock import patch
    from types import SimpleNamespace
    import io
    project = 'golf-access059-0123456789'
    with patch.dict(os.environ, {'NATIVE_IP':'172.31.0.3','OWNED_PROJECT':project,
                                'CONTROL_NONCE':'a'*64,'FAULT_PAIR':'direct'}):
        space={'__name__':'fixture_guard_check'};exec(compile(PROXY_SOURCE,'owned-proxy-source','exec'),space)
    calls=[]
    class Connection:
        status, body = 204, b''
        def __init__(self,*args,**kw):assert args==('172.31.0.3',3000)
        def request(self,*args):calls.append(args)
        def getresponse(self):return self
        def read(self,bound):assert bound==2097153;return self.body
        def getheaders(self):return []
        def close(self):pass
    class Socket:
        closed=False
        def shutdown(self,*args):pass
        def close(self):self.closed=True
    class Handler(space['Handler']):
        def __init__(self,path):
            self.server=SimpleNamespace(server_port=3000);self.path=path;self.command='PUT'
            self.headers={'Content-Length':'2','Authorization':'private-never-logged'}
            self.rfile=io.BytesIO(b'{}');self.wfile=io.BytesIO();self.connection=Socket()
        def reply(self,status,payload):self.reply_status=status;self.wfile.write(json.dumps(payload).encode())
    with patch.object(space['http'].client,'HTTPConnection',Connection):
        invalid=Handler('/api/v1/repos/foreign/repo/collaborators/other');invalid.forward()
        assert not calls and space['STATE']['writes']==space['STATE']['lost']==0
        space['STATE']['armed']=True
        wrong=Handler(space['TARGET']);Connection.status=200;wrong.forward()
        assert space['STATE']['lost']==0 and space['STATE']['armed'] and not wrong.connection.closed
        space['STATE'].update(forwards=0,writes=0,lost=0,failures=0,armed=True)
        Connection.status=204;good=Handler(space['TARGET']);good.forward()
        assert good.connection.closed and space['STATE']=={'forwards':1,'writes':1,'lost':1,'armed':False,'failures':0,'controls':0}
        assert b'private-never-logged' not in good.wfile.getvalue()+wrong.wfile.getvalue()+invalid.wfile.getvalue()
        space['STATE']['controls']=255
        assert good.control() and not good.control() and space['STATE']['controls']==256


def self_check():
    recovery.validate_profile(recovery.ACCESS_SCHEMA, recovery.ACCESS_PROFILE)
    for schema, profile in [(recovery.ACCESS_SCHEMA, None), ('202610040058', recovery.ACCESS_PROFILE),
                            ('202610020021', recovery.ACCESS_PROFILE), ('999999999999', None)]:
        reject(lambda: recovery.validate_profile(schema, profile))
    for schema in recovery.SUPPORTED_SCHEMAS: recovery.validate_profile(schema, None)
    counts = {key: 0 for key in recovery.ACCESS_EMPTY}
    counts.update({'native_' + key: 0 for key in recovery.ACCESS_NATIVE_EMPTY}, typed_queued=1)
    recovery.validate_access_counts(counts)
    for key in counts:
        invalid = dict(counts); invalid[key] = 2 if key == 'typed_queued' else 1
        reject(lambda: recovery.validate_access_counts(invalid))
    reject(lambda: recovery.validate_access_counts(dict(counts, unexpected=0)))
    fields = {key: 0 for key in recovery.KEY_FAMILIES}
    status = {'active_key_id': 'b', 'configured_active_key_id': 'b', 'keys': [dict(fields, key_id='b', configured=True)]}
    assert len(inventory(status)) == 13
    for key in fields:
        changed = json.loads(json.dumps(status)); del changed['keys'][0][key]
        reject(lambda: inventory(changed))
    changed = json.loads(json.dumps(status)); changed['keys'][0]['configured'] = False
    reject(lambda: inventory(changed))
    for key in fields:
        changed = json.loads(json.dumps(status)); changed['keys'][0][key] = True
        reject(lambda: inventory(changed))
    assert all(len('golf-access059-0123456789-'+role)<=40 for role in ('bootstrap','recipient','outsider','owner'))
    rows = {table: '[]' for table in HISTORY}; equal_history(rows, dict(rows))
    reject(lambda: equal_history(rows, dict(rows, golf_repository_access_generations='[{}]')))
    before = dict(rows)
    invitation = {'id':'original','state':'PENDING','revision':1,'updated_at':'2026-10-04T00:00:00+00:00',
                  'issuer_account_version':1,'input_hash':'retained-original','persistent_consent':True}
    before['golf_repository_invitations'] = json.dumps([invitation])
    before['golf_repository_invitation_events'] = json.dumps([{'id':1,'invitation_id':'original','state':'PENDING','revision':1}])
    after = dict(before)
    after['golf_repository_invitations'] = json.dumps([invitation|{'state':'EXPIRED','revision':2,'updated_at':'2026-10-04T00:01:00+00:00'}])
    after['golf_repository_invitation_events'] = json.dumps(json.loads(before['golf_repository_invitation_events'])+[{'id':2,'invitation_id':'original','state':'EXPIRED','revision':2}])
    assert check_restored_history(before, after)==1
    for key,value in [('issuer_account_version',2),('persistent_consent',False),('state','ACCEPTED')]:
        changed=dict(after);changed['golf_repository_invitations']=json.dumps([json.loads(after['golf_repository_invitations'])[0]|{key:value}])
        reject(lambda:check_restored_history(before,changed))
    reject(lambda:check_restored_history(before,dict(after,golf_repository_invitation_events=before['golf_repository_invitation_events'])))
    config = {'services': {'golf': {'environment': {'GITEA_URL': 'http://gitea:3000'}},
              'gitea': {'environment': {'GITEA__actions__ENABLED': 'false', 'GITEA__mailer__ENABLED': 'false', **{'GITEA__cron.'+name+'__ENABLED':'false' for name in recovery.NATIVE_CRON_TASKS}}}, 'postgres': {}}}
    recovery.validate_access_config(config)
    for key, value in [('HTTP_PROXY', 'http://private.invalid'), ('GOLF_PUSH_CI_ENABLED', 'true')]:
        changed = json.loads(json.dumps(config)); changed['services']['golf']['environment'][key] = value
        reject(lambda: recovery.validate_access_config(changed))
    for key in ('GITEA__actions__ENABLED', 'GITEA__mailer__ENABLED', 'GITEA__cron.update_mirrors__ENABLED'):
        changed = json.loads(json.dumps(config)); changed['services']['gitea']['environment'][key] = 'true'
        reject(lambda: recovery.validate_access_config(changed))
    # Exercise new archive-native guards independently of Docker/runtime.
    import io, tarfile
    with tempfile.TemporaryDirectory(prefix='golf-access-recovery-guards-') as tmp:
        stage = Path(tmp)
        ini = '[actions]\nENABLED=false\n[mailer]\nENABLED=false\n' + ''.join('[cron.'+name+']\nENABLED=false\n' for name in recovery.NATIVE_CRON_TASKS)
        def archive(path, name, data, kind=tarfile.REGTYPE):
            with tarfile.open(path, 'w:') as tar:
                row=tarfile.TarInfo(name); row.type=kind; row.size=len(data) if kind==tarfile.REGTYPE else 0
                tar.addfile(row,io.BytesIO(data) if row.isfile() else None)
        archive(stage/'gitea-config.tar','gitea/app.ini',ini.encode())
        archive(stage/'gitea-data.tar','gitea/git/.gitconfig',b'[core]\nquotepath=false\n')
        recovery.validate_access_archive(stage)
        for name,data,kind in [
            ('gitea/git/.gitconfig',b'[core]\nhooksPath=/outside\n',tarfile.REGTYPE),
            ('gitea/git/.gitconfig',b'[include]\npath=/outside\n',tarfile.REGTYPE),
            ('gitea/git/repositories/owner/repo.git/config',b'[core]\nhooksPath=/outside\n',tarfile.REGTYPE),
            ('gitea/git/repositories/owner/repo.git/custom_hooks',b'',tarfile.DIRTYPE),
            ('gitea/git/repositories/owner/repo.git/hooks/reference-transaction',b'',tarfile.SYMTYPE),
            ('gitea/git/repositories/owner/repo.git/hooks/pre-receive.d/extra',b'command',tarfile.REGTYPE),
        ]:
            archive(stage/'gitea-data.tar',name,data,kind)
            reject(lambda: recovery.validate_access_archive(stage))
    proxy_self_check()
    compile(PROXY_SOURCE, 'owned-proxy-source', 'exec')
    assert 'http.client.HTTPConnection(IP, 3000' in PROXY_SOURCE and "response.status == 204 and body == b''" in PROXY_SOURCE
    assert 'log_message(self, *args): pass' in PROXY_SOURCE and 'STATE[\'forwards\'] < 256' in PROXY_SOURCE
    assert "do_DELETE" not in PROXY_SOURCE and "do_PATCH" not in PROXY_SOURCE
    print('PASS: pure059 profile/history/13-family/owned-fault boundaries; no runtime resources')


def main():
    global ROOT, STAGE
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--self-check', action='store_true')
    parser.add_argument('--image'); parser.add_argument('--proxy-image')
    parser.add_argument('--source-revision'); parser.add_argument('--output', type=Path)
    parser.add_argument('--stack-root', type=Path, default=ROOT)
    args = parser.parse_args()
    if args.self_check: self_check(); return
    ROOT = args.stack_root.resolve(); recovery.ROOT = ROOT
    assert re.fullmatch('sha256:[a-f0-9]{64}', args.image or '') and re.fullmatch('sha256:[a-f0-9]{64}', args.proxy_image or '')
    assert re.fullmatch('[a-f0-9]{40}', args.source_revision or '') and args.output and not args.output.exists()
    for tool in ('docker', 'age', 'age-keygen', 'ssh-keygen'): assert shutil.which(tool)
    args.output.mkdir(mode=0o700); output = args.output.resolve()
    proof = {'status': 'running', 'complete': False, 'cleanup': 'not_created', 'sourceRevision': args.source_revision,
             'profile': recovery.ACCESS_PROFILE, 'wholePlatformRecovery': False}
    environment = {k: v for k, v in os.environ.items() if not k.startswith(('GOLF_', 'GITEA_', 'POSTGRES_', 'COMPOSE_', 'AWS_', 'OTEL_', 'RUSTFS_')) and k != 'DATABASE_URL'}
    forbidden = []
    def record(**fields):
        proof.update(fields); raw = json.dumps(proof, indent=2)
        assert not any(value and value in raw for value in forbidden)
        private(output/'manifest.tmp', raw); os.replace(output/'manifest.tmp', output/'manifest.json')
    def stage(name):
        global STAGE
        STAGE = name; record(stage=name); print('CHECK: ' + name, flush=True)
    def run(*argv, input=None, success=True, timeout=180, binary=False):
        payload = input if isinstance(input, bytes) else input.encode() if isinstance(input, str) else json.dumps(input).encode() if input is not None else None
        result = subprocess.run(argv, input=payload, capture_output=True, env=environment, cwd=ROOT, timeout=timeout)
        assert len(result.stdout) <= 16 << 20 and len(result.stderr) <= 16 << 20
        assert (result.returncode == 0) == success, 'Private subprocess failed; output withheld'
        return result.stdout if binary else result.stdout.decode().strip()
    def resources(project):
        return {kind: run('docker', *command, '--filter', 'label=com.docker.compose.project=' + project).split()
                for kind, command in [('containers', ('ps','-aq')), ('volumes', ('volume','ls','-q')), ('networks', ('network','ls','-q'))]}
    def foreign():
        ids = run('docker','ps','-aq','--no-trunc').split(); assert len(ids) <= 500
        if not ids: return {}
        template = '{"id":{{json .Id}},"image":{{json .Image}},"status":{{json .State.Status}},"running":{{json .State.Running}}}'
        return {row['id']: row for row in map(json.loads, run('docker','inspect','--format',template,*ids).splitlines())}
    stage('exact cached images and Python prerequisite before fixture mutation')
    core = json.loads(run('docker','image','inspect',args.image))[0]
    assert core['Id'] == args.image and core['Config'].get('Labels',{}).get('org.opencontainers.image.revision') == args.source_revision
    proxy_image = json.loads(run('docker','image','inspect',args.proxy_image))[0]
    assert proxy_image['Id'] == args.proxy_image
    run('docker','run','--rm','--pull=never','--network=none','--read-only','--cap-drop=ALL','--security-opt=no-new-privileges','--entrypoint','python3',args.proxy_image,'-c','import http.client,http.server,ipaddress; print("owned-python-ready")')
    images = {name: json.loads(run('docker','image','inspect',ref))[0]['Id'] for name, ref in
              [('golf', args.image), ('postgres','postgres:18.4-alpine3.24'), ('gitea','gitea/gitea:1.27.3-rootless')]}
    assert int(run('docker','run','--rm','--pull=never','--network=none','--read-only','--cap-drop=ALL','--entrypoint','/bin/df',args.image,'-Pk','/').splitlines()[-1].split()[3]) >= 2*1024*1024
    before = foreign(); private(output/'foreign-before.json', json.dumps(before))
    prefix = 'golf-access059-' + secrets.token_hex(5); source, target = prefix+'-source', prefix+'-restore'
    projects = [source, target]; assert not any(any(resources(p).values()) for p in projects)
    previous = smoke.GOLF, smoke.GITEA
    def free_port():
        with socket.socket() as s: s.bind(('127.0.0.1',0)); return s.getsockname()[1]
    ports = []
    while len(ports) < 4:
        value = free_port()
        if value not in ports: ports.append(value)
    smoke.GOLF, smoke.GITEA = 'http://127.0.0.1:'+str(ports[0]), 'http://127.0.0.1:'+str(ports[1])
    active_project = source; active_config = None; actors = {}; repos = []; organizations = []
    started = False; passed = False; original = None; cleanup_errors = []
    with tempfile.TemporaryDirectory(prefix=prefix+'-') as temporary:
        directory = Path(temporary).resolve(); directory.chmod(0o700)
        key_a, key_b = [base64.b64encode(secrets.token_bytes(32)).decode() for _ in range(2)]
        passwords = [secrets.token_hex(24) for _ in range(3)]; forbidden += passwords+[key_a,key_b]
        config = {'services': {
            'postgres': {'image': images['postgres'], 'pull_policy':'never', 'restart':'no', 'command':recovery.ACCESS_PG_COMMAND,
                'environment':dict(zip(('POSTGRES_PASSWORD','GOLF_DB_PASSWORD','GITEA_DB_PASSWORD'), passwords)),
                'volumes':['postgres-data:/var/lib/postgresql',str(ROOT/'deploy/postgres/init.sh')+':/docker-entrypoint-initdb.d/01-golf.sh:ro'],
                'healthcheck':{'test':['CMD-SHELL','pg_isready -h 127.0.0.1 -U postgres'],'interval':'2s','timeout':'3s','retries':60}},
            'gitea': {'image':images['gitea'], 'pull_policy':'never', 'restart':'no',
                'environment':{'HOME':'/var/lib/gitea/git','GITEA__database__DB_TYPE':'postgres','GITEA__database__HOST':'postgres:5432',
                    'GITEA__database__NAME':'gitea','GITEA__database__USER':'gitea','GITEA__database__PASSWD':passwords[2],
                    'GITEA__security__INSTALL_LOCK':'true','GITEA__service__DISABLE_REGISTRATION':'true',
                    'GITEA__server__ROOT_URL':smoke.GITEA+'/', 'GITEA__server__SSH_PORT':str(ports[2]),'GITEA__server__SSH_LISTEN_PORT':'2222',
                    'GITEA__actions__ENABLED':'false','GITEA__mailer__ENABLED':'false',**{'GITEA__cron.'+name+'__ENABLED':'false' for name in recovery.NATIVE_CRON_TASKS}},
                'ports':[f'127.0.0.1:{ports[1]}:3000',f'127.0.0.1:{ports[2]}:2222'],
                'volumes':['gitea-data:/var/lib/gitea','gitea-config:/etc/gitea'], 'depends_on':{'postgres':{'condition':'service_healthy'}}},
            'golf': {'image':images['golf'], 'pull_policy':'never','restart':'no',
                'environment':{'DATABASE_URL':f'postgres://golf:{passwords[1]}@postgres:5432/golf?sslmode=disable',
                    'GITEA_URL':'http://gitea:3000','GITEA_PUBLIC_URL':smoke.GITEA,'GOLF_PUBLIC_URL':smoke.GOLF,
                    'GOLF_LISTEN_ADDR':':8080','GOLF_ALLOW_INSECURE_COOKIES':'true','GOLF_WEB_DIR':'/app/web/dist',
                    'GOLF_ENCRYPTION_KEYS':json.dumps({'a':key_a,'b':key_b}), 'GOLF_ACTIVE_ENCRYPTION_KEY':'a',
                    'GOLF_RUNNER_KEYS':json.dumps({'recovery-unstarted':base64.urlsafe_b64encode(secrets.token_bytes(32)).decode().rstrip('=')}),
                    'GOLF_RUNNER_IMAGES':json.dumps({'linux':'alpine:3.23@sha256:85fe1e81d6758c208f3e1eed4338a1997e19d4be002d4dd32d3100c9a8c010a0'}),
                    'GOLF_ACTIONS_ENGINE_CATALOG':CATALOG,'GOLF_ACTIONS_ENGINE_BINARY':'/usr/local/bin/golf-actions-engine','GOLF_RUNNER_JOB_IMAGE':'alpine:3.23@sha256:85fe1e81d6758c208f3e1eed4338a1997e19d4be002d4dd32d3100c9a8c010a0',
                    'GOLF_PUSH_CI_ENABLED':'false'},'ports':[f'127.0.0.1:{ports[0]}:8080'],
                'depends_on':{'postgres':{'condition':'service_healthy'},'gitea':{'condition':'service_started'}}},
            }, 'volumes':{name:{} for name in ('postgres-data','gitea-data','gitea-config')}}
        canonical = directory/'source.json'; private(canonical, recovery.compose_bytes(config)); active_config = canonical
        def compose(*argv, **kw): return run('docker','compose','-p',active_project,'-f',str(active_config),*argv,**kw)
        def container(service):
            value = compose('ps','-aq',service); assert re.fullmatch('[a-f0-9]{12,64}',value); return value
        def sql(statement): return compose('exec','-T','postgres','psql','-U','postgres','-d','golf','-At','-v','ON_ERROR_STOP=1',input=statement)
        def rows(table, order):
            assert table in set(HISTORY)|{'golf_local_accounts','golf_encryption_keys','golf_encryption_policy','golf_workflow_dispatch_inputs','golf_workflow_runs','golf_local_account_events','golf_crypto_events'}
            return sql("SELECT COALESCE(json_agg(t),'[]'::json) FROM (SELECT * FROM "+table+' ORDER BY '+order+') t;')
        def histories(): return {table:rows(table,order) for table,order in HISTORY.items()}
        def operator(action, payload):
            value=json.loads(compose('exec','-T','golf','golf','local-account',action,input=payload)); assert value['state']=='complete'; return value['result']
        def keys(action, *argv, success=True, overrides=()):
            value=json.loads(compose('run','--rm','--no-deps','-T',*overrides,'golf','keys',action,*argv,success=success))
            assert value['state']==(('eligible' if action=='retirement-check' else 'complete') if success else 'failed'); return value.get('result')
        def rpc(actor, method, payload, expected=200, code=None):
            return smoke.rpc(actor['session'],method,payload,expected=expected,code=code)
        def access(repo):
            value=rpc(actors['owner'],'RepositoryAccessService/GetRepositoryAccess',{'repository':repo['key']})['access']
            assert value['repositoryId']==repo['id'] and value['ownerId']==repo['ownerId'] and value['canManage']; return value
        def intent(repo, recipient, permission=None):
            a=access(repo); fields={'repository':repo['key'],'repositoryId':repo['id'],'ownerId':repo['ownerId'],'expectedRevision':a['revision']}
            c=rpc(actors['owner'],'RepositoryAccessService/ResolveRepositoryCollaborator',fields|{'userLogin':recipient['name']})['collaborator']
            assert c['user']['id']==recipient['id']; fields |= {'userLogin':recipient['name'],'userId':recipient['id'],'expectedCollaboratorRevision':c['revision'],'idempotencyKey':str(uuid.uuid4())}
            if permission:fields['permission']=permission
            return fields
        def inspect(p):
            return rpc(actors['owner'],'RepositoryAccessService/GetRepositoryAccessOperation',{k:v for k,v in p.items() if k in {'repository','repositoryId','ownerId','expectedRevision','userId','idempotencyKey'}})['operation']
        def native_snapshot():
            result={'repositories':[], 'users':[], 'teams':[]}
            owner=actors['owner']
            for repo in repos:
                raw=smoke.provider(owner['token'],'GET','repos/'+repo['full'])
                assert str(raw['id'])==repo['id'] and str(raw['owner']['id'])==repo['ownerId']
                collaborators=smoke.provider(owner['token'],'GET','repos/'+repo['full']+'/collaborators?limit=100&page=1')
                assert len(collaborators)<100
                keys_=smoke.provider(owner['token'],'GET','repos/'+repo['full']+'/keys?limit=100&page=1');assert len(keys_)<100
                result['repositories'].append({'id':repo['id'],'ownerId':repo['ownerId'],'full':raw['full_name'],
                    'collaborators':sorted([(str(r['id']),r['login'],r['permissions']) for r in collaborators]),
                    'deployKeys':sorted([(str(r['id']),r['key'],r['read_only']) for r in keys_])})
            for actor in actors.values():
                u=smoke.provider(actor['token'],'GET','user'); assert str(u['id'])==actor['id'] and u['is_admin'] is False
                result['users'].append((str(u['id']),u['login']))
            for name in organizations:
                teams=smoke.provider(owner['token'],'GET','orgs/'+name+'/teams?limit=100&page=1'); assert len(teams)<100
                for team in teams:
                    members=smoke.provider(owner['token'],'GET','teams/'+str(team['id'])+'/members?limit=100&page=1')
                    repositories=smoke.provider(owner['token'],'GET','teams/'+str(team['id'])+'/repos?limit=100&page=1')
                    result['teams'].append({'id':str(team['id']),'name':team['name'],'permission':team['permission'],
                        'members':sorted(str(v['id']) for v in members),'repositories':sorted(str(v['id']) for v in repositories)})
            return result
        def call_recovery(action, *argv, success=True):
            value=json.loads(run(sys.executable,str(ROOT/'scripts/recovery.py'),action,*argv,success=success,timeout=360))
            assert value['schema_version']==recovery.FORMAT and value['state']==(('quarantined' if action=='restore' else 'complete') if success else 'failed')
            return value.get('result')
        proxy_nonce=secrets.token_hex(32); forbidden.append(proxy_nonce)
        control=urllib.request.build_opener(urllib.request.ProxyHandler({}))
        def proxy_control(path, payload=None):
            req=urllib.request.Request('http://127.0.0.1:'+str(ports[3])+path, data=None if payload is None else json.dumps(payload).encode(),
                headers={'X-Control-Nonce':proxy_nonce,'Content-Type':'application/json'})
            with control.open(req,timeout=5) as response:
                raw=response.read(4097); assert response.status==200 and len(raw)<=4096 and response.headers.get('Cache-Control')=='no-store'
                return json.loads(raw)
        try:
            started=True; record(cleanup='pending',project=source,images=images,proxyImage=args.proxy_image)
            stage('fresh canonical core and ordinary supported native identities')
            compose('up','-d','--no-build','--pull','never',timeout=180); smoke.ready()
            assert sql('SELECT max(version_id) FROM goose_db_version WHERE is_applied;')==recovery.ACCESS_SCHEMA
            admin=['exec','-T','gitea','gitea','--config','/etc/gitea/app.ini','admin','user']
            compose(*admin,'create','--username',prefix+'-bootstrap','--email',prefix+'-bootstrap@example.invalid','--random-password','--must-change-password=false','--admin')
            for role in ('owner','recipient','outsider'):
                name=prefix+'-'+role; a={'name':name,'email':name+'@example.invalid','password':secrets.token_urlsafe(32),'session':smoke.client()}; actors[role]=a
                forbidden.append(a['password']); compose(*admin,'create','--username',name,'--email',a['email'],'--random-password','--must-change-password=false')
                a['token']=compose(*admin,'generate-access-token','--username',name,'--token-name',prefix,'--scopes','write:user,write:repository,write:organization','--raw'); forbidden.append(a['token'])
                u=smoke.provider(a['token'],'GET','user'); assert u['login']==name and u['is_admin'] is False;a['id']=str(u['id'])
                operator('create',{'username':name,'email':a['email'],'password':a['password'],'forge_token':a['token'],'is_instance_admin':role=='owner'})
                assert rpc(a,'SessionService/LoginWithPassword',{'username':a['email'],'password':a['password']})['user']['id']==a['id']
            owner,recipient=actors['owner'],actors['recipient']
            org=prefix+'-org'; organizations.append(org); smoke.provider(owner['token'],'POST','orgs',{'username':org},expected=201)
            for name,organization in [('personal',None),('organization',org),('unknown',None),('invitation-unknown',None)]:
                n=smoke.provider(owner['token'],'POST','orgs/'+organization+'/repos' if organization else 'user/repos',{'name':name,'private':True,'auto_init':True},expected=201)
                repo={'key':{'owner':n['owner']['login'],'name':n['name']},'id':str(n['id']),'ownerId':str(n['owner']['id']),'full':n['full_name']};repos.append(repo);smoke.wait_for_push(owner['token'],repo['full'])
            team=smoke.provider(owner['token'],'POST','orgs/'+org+'/teams',{'name':'Readers','permission':'read','units':['repo.code','repo.issues','repo.pulls']},expected=201)
            smoke.provider(owner['token'],'PUT','teams/'+str(team['id'])+'/members/'+recipient['name'],expected=204)
            smoke.provider(owner['token'],'PUT','teams/'+str(team['id'])+'/repos/'+repos[1]['full'],expected=204)
            known=[]
            stage('real personal and organization grant generations and invitation outcomes')
            for repo in repos[:2]:
                for permission in ('read','write','admin'):
                    p=intent(repo,recipient,permission);r=rpc(owner,'RepositoryAccessService/SetRepositoryCollaborator',p)['operation'];assert r['phase']=='SUCCEEDED' and int(r['generation'])>0
                    assert inspect(p)==r;known.append((p,r))
                    p=intent(repo,recipient);r=rpc(owner,'RepositoryAccessService/RemoveRepositoryCollaborator',p)['operation'];assert r['phase']=='SUCCEEDED';known.append((p,r))
            invitations=[]
            def create_invite(repo):
                a=access(repo); fields={'repository':repo['key'],'repositoryId':repo['id'],'ownerId':repo['ownerId'],'expectedRevision':a['revision']}
                preview=rpc(owner,'RepositoryInvitationService/PreviewRepositoryInvitationRecipient',fields|{'username':recipient['name']})['recipient']
                payload=fields|{'recipientId':recipient['id'],'recipientUsername':recipient['name'],'recipientRevision':preview['revision'],
                    'permission':'read','expiresAt':(datetime.datetime.now(datetime.timezone.utc)+datetime.timedelta(hours=1)).isoformat().replace('+00:00','Z'),
                    'persistentConsent':True,'idempotencyKey':str(uuid.uuid4())}
                row=rpc(owner,'RepositoryInvitationService/CreateRepositoryInvitation',payload)['invitation']; assert row['state']=='PENDING'; return row,payload
            for decision in ('ACCEPT','REJECT'):
                row,payload=create_invite(repos[0]); response={'invitationId':row['id'],'expectedRevision':row['revision'],'decision':'REPOSITORY_INVITATION_DECISION_'+decision,'idempotencyKey':str(uuid.uuid4())}
                r=rpc(recipient,'RepositoryInvitationService/RespondRepositoryInvitation',response); assert r['invitation']['state']==('ACCEPTED' if decision=='ACCEPT' else 'REJECTED')
                if decision=='ACCEPT': assert r['operation']['phase']=='SUCCEEDED'
                invitations.append((row,payload,response,r))
                if decision=='ACCEPT':rpc(owner,'RepositoryAccessService/RemoveRepositoryCollaborator',intent(repos[0],recipient))
            row,payload=create_invite(repos[0]); a=access(repos[0]);rev={'repository':repos[0]['key'],'repositoryId':repos[0]['id'],'ownerId':repos[0]['ownerId'],'expectedRevision':a['revision'],'invitationId':row['id'],'invitationRevision':row['revision']}
            r=rpc(owner,'RepositoryInvitationService/RevokeRepositoryInvitation',rev); assert r['invitation']['state']=='REVOKED'; invitations.append((row,payload,None,r))
            row,pending=create_invite(repos[1]); invitations.append((row,pending,None,{'invitation':row}))
            # A real shared deploy key has separate association IDs/read_only modes.
            run('ssh-keygen','-q','-t','ed25519','-N','','-f',str(directory/'deploy'))
            public=(directory/'deploy.pub').read_text().strip()
            associations=[smoke.provider(owner['token'],'POST','repos/'+repo['full']+'/keys',{'key':public,'title':'Recovery owned key','read_only':read_only},expected=201) for repo,read_only in zip(repos[:2],(True,False))]
            assert associations[0]['id']!=associations[1]['id'] and associations[0]['read_only'] is True and associations[1]['read_only'] is False
            stage('one actual typed queued input admission without any worker or job execution')
            repo=repos[0];smoke.provider(owner['token'],'POST','repos/'+repo['full']+'/contents/'+PATH,{'content':base64.b64encode(WORKFLOW).decode(),'message':'Owned recovery source'},expected=201)
            head=smoke.provider(owner['token'],'GET','repos/'+repo['full']+'/branches/main')['commit']['id'];assert re.fullmatch('[a-f0-9]{40}',head)
            for scope in ('INSTANCE','REPOSITORY'):
                selected={'scope':'EXECUTION_SCOPE_'+scope}|({'repository':repo['key']} if scope=='REPOSITORY' else {})
                policy=rpc(owner,'ExecutionPolicyService/GetExecutionPolicy',selected)['policy']
                rpc(owner,'ExecutionPolicyService/UpdateExecutionPolicy',selected|{'scopeId':policy['scopeId'],'expectedRevision':policy.get('revision','0'),'expectedAuthorityRevision':policy['authorityRevision'],
                    'mode':'EXECUTION_MODE_ALL','manualDispatchEnabled':True,'pushAllowed':False,'allowAllWorkflows':True})
            inputs=[{'name':'text','stringValue':secrets.token_urlsafe(32)}];forbidden.append(inputs[0]['stringValue'])
            prepared=rpc(owner,'WorkflowRunService/PrepareWorkflowDispatch',{'repository':repo['key'],'repositoryId':repo['id'],'ownerId':repo['ownerId'],'commitId':head,'workflowPath':PATH,'inputs':inputs})
            assert prepared['repositoryId']==repo['id'] and prepared['ownerId']==repo['ownerId'] and prepared['nativeActorId']==owner['id'] and prepared['commitId']==head
            dispatch={k:prepared[k] for k in ('repository','repositoryId','ownerId','workflowPath','workflowBlobId','schemaSha256','submittedSha256','effectiveSha256','inputContract')}|{'ref':head,'inputs':inputs,'idempotencyKey':str(uuid.uuid4())}
            admitted=rpc(owner,'WorkflowRunService/DispatchWorkflow',dispatch)['run']; assert admitted['state']=='WORKFLOW_RUN_STATE_QUEUED' and admitted['commitId']==head
            assert sql('SELECT count(*) FROM golf_workflow_dispatch_inputs;')=='1'
            assert sql('SELECT count(*) FROM golf_workflow_run_logs;')=='0'
            original_input={k:prepared[k] for k in ('repository','repositoryId','ownerId','commitId','workflowPath','workflowBlobId','schemaSha256','submittedSha256','effectiveSha256','inputContract')}|{'idempotencyKey':dispatch['idempotencyKey']}
            def typed_original():
                value=rpc(owner,'WorkflowRunService/GetWorkflowDispatch',original_input)
                assert value['idempotencyKey']==dispatch['idempotencyKey']
                for field in ('repository','repositoryId','ownerId','nativeActorId','schemaSha256','submittedSha256','effectiveSha256','inputContract'):
                    assert value[field]==prepared[field]
                observed=value['run'];assert observed['id']==admitted['id'] and not observed.get('canCancel',False)
                for field in ('repositoryId','ownerId','commitId','workflowPath','workflowBlobId','schemaSha256','submittedSha256','effectiveSha256','inputContract'):
                    assert observed[field]==prepared[field]
                assert observed['engineCatalog']==CATALOG and re.fullmatch('[a-f0-9]{64}',observed['sourceSha256'])
                return observed
            assert typed_original()['state']=='WORKFLOW_RUN_STATE_QUEUED'
            record(realTypedAdmission=True,typedRunId=admitted['id'],jobsExecuted=0)
            stage('actual native204 response loss with unchanged canonical forge URL')
            native_id=container('gitea'); netrows=json.loads(run('docker','inspect',native_id))[0]['NetworkSettings']['Networks'];assert len(netrows)==1
            network_name,network=next(iter(netrows.items()));native_ip=network['IPAddress'];ipaddress.IPv4Address(native_ip)
            net=json.loads(run('docker','network','inspect',network_name))[0];assert net['Labels']['com.docker.compose.project']==source
            subnet=ipaddress.ip_network(net['IPAM']['Config'][0]['Subnet']); assert ipaddress.ip_address(native_ip) in subnet
            allnets=run('docker','network','ls','-q').split()
            for other in json.loads(run('docker','network','inspect',*allnets)):
                if other['Id']==net['Id']:continue
                for value in other['IPAM'].get('Config') or []:
                    if value.get('Subnet') and ipaddress.ip_network(value['Subnet']).version==subnet.version:assert not subnet.overlaps(ipaddress.ip_network(value['Subnet']))
            proxy_file=directory/'proxy.py';private(proxy_file,PROXY_SOURCE);proxy_file.chmod(0o444)
            transient=json.loads(json.dumps(config));transient['services']['fault']={'image':args.proxy_image,'pull_policy':'never','read_only':True,'user':'1000:1000',
                'entrypoint':['python3','/fixture/proxy.py'],'cap_drop':['ALL'],'security_opt':['no-new-privileges:true'],'mem_limit':'128m','cpus':0.25,'pids_limit':32,
                'volumes':[str(proxy_file)+':/fixture/proxy.py:ro'],'environment':{'NATIVE_IP':native_ip,'OWNED_PROJECT':prefix,'CONTROL_NONCE':proxy_nonce,'FAULT_PAIR':'direct'},'ports':[f'127.0.0.1:{ports[3]}:8082']}
            transient_file=directory/'transient.json';private(transient_file,recovery.compose_bytes(transient));active_config=transient_file
            compose('up','-d','--no-build','--pull','never','fault')
            proxy_row=json.loads(run('docker','inspect',container('fault')))[0];proxy_ip=proxy_row['NetworkSettings']['Networks'][network_name]['IPAddress']
            assert proxy_ip!=native_ip and ipaddress.ip_address(proxy_ip) in subnet and proxy_row['Image']==args.proxy_image
            assert proxy_row['Config']['Labels']['com.docker.compose.project']==source
            transient['services']['golf']['extra_hosts']=['gitea:'+proxy_ip];private(transient_file,recovery.compose_bytes(transient));compose('up','-d','--no-build','--pull','never','golf');smoke.ready()
            assert json.loads(run('docker','inspect',container('golf')))[0]['Config']['Env'].count('GITEA_URL=http://gitea:3000')==1
            unknown_intent=intent(repos[2],actors['outsider'],'read');assert proxy_control('/state')['writes']==0
            assert proxy_control('/arm',{})=={'state':'armed'}
            unknown=rpc(owner,'RepositoryAccessService/SetRepositoryCollaborator',unknown_intent)['operation'];assert unknown['phase']=='DISPATCH_UNKNOWN'
            state=proxy_control('/state');assert state['writes']==state['lost']==1 and state['failures']==0 and not state['armed']
            assert inspect(unknown_intent)==unknown
            assert rpc(owner,'RepositoryAccessService/SetRepositoryCollaborator',unknown_intent)['operation']==unknown
            assert proxy_control('/state')['writes']==1
            smoke.provider(owner['token'],'GET','repos/'+repos[2]['full']+'/collaborators/'+actors['outsider']['name'],expected=204)
            # Second independent owned target; never replace/retry the first key.
            invitation_row,invitation_create=create_invite(repos[3])
            invitation_response={'invitationId':invitation_row['id'],'expectedRevision':invitation_row['revision'],
                'decision':'REPOSITORY_INVITATION_DECISION_ACCEPT','idempotencyKey':str(uuid.uuid4())}
            compose('stop','golf');compose('rm','-f','-s','fault')
            transient['services']['fault']['environment']['FAULT_PAIR']='invitation'
            private(transient_file,recovery.compose_bytes(transient));compose('up','-d','--no-build','--pull','never','fault')
            proxy_row=json.loads(run('docker','inspect',container('fault')))[0]
            proxy_ip=proxy_row['NetworkSettings']['Networks'][network_name]['IPAddress']
            assert proxy_ip!=native_ip and ipaddress.ip_address(proxy_ip) in subnet
            transient['services']['golf']['extra_hosts']=['gitea:'+proxy_ip]
            private(transient_file,recovery.compose_bytes(transient));compose('up','-d','--no-build','--pull','never','golf');smoke.ready()
            assert proxy_control('/state')['writes']==proxy_control('/state')['lost']==0
            assert proxy_control('/arm',{})=={'state':'armed'}
            invitation_unknown=rpc(recipient,'RepositoryInvitationService/RespondRepositoryInvitation',invitation_response)
            assert invitation_unknown['operation']['phase']=='DISPATCH_UNKNOWN' and invitation_unknown['invitation']['state']=='GRANTING'
            assert rpc(recipient,'RepositoryInvitationService/GetRepositoryInvitationOperation',
                {'invitationId':invitation_row['id'],'idempotencyKey':invitation_response['idempotencyKey']})['operation']==invitation_unknown['operation']
            assert rpc(recipient,'RepositoryInvitationService/RespondRepositoryInvitation',invitation_response)['operation']==invitation_unknown['operation']
            state=proxy_control('/state');assert state['writes']==state['lost']==1 and state['failures']==0 and not state['armed']
            smoke.provider(owner['token'],'GET','repos/'+repos[3]['full']+'/collaborators/'+recipient['name'],expected=204)
            invitations.append((invitation_row,invitation_create,invitation_response,invitation_unknown))
            # Remove every temporary transport override before core-only capture.
            compose('stop','golf');compose('rm','-f','-s','fault');active_config=canonical
            compose('up','-d','--no-build','--pull','never','golf');smoke.ready();assert inspect(unknown_intent)==unknown
            record(nativeLostAcknowledgement=True,nativeAcknowledgementsDiscarded=2,originalUnknownPreserved=True,canonicalForgeIdentityPreserved=True)
            native_before=native_snapshot()
            stage('activate a second configured key while retaining old-key typed ciphertext')
            config['services']['golf']['environment']['GOLF_ACTIVE_ENCRYPTION_KEY']='b';private(canonical,recovery.compose_bytes(config))
            compose('stop','golf');keys('activate');compose('up','-d','--no-build','--pull','never','golf');smoke.ready();assert inspect(unknown_intent)==unknown
            key_before=keys('status');assert inventory(key_before)['workflow_dispatch_inputs']==1
            assert any(r['key_id']=='a' and r['workflow_dispatch_inputs']==1 for r in key_before['keys'])
            history=histories(); assert all(json.loads(v) for v in history.values())
            accounts=json.loads(rows('golf_local_accounts','id'));ciphertext=rows('golf_workflow_dispatch_inputs','run_id')
            registry=rows('golf_encryption_keys','key_id');policy_before=rows('golf_encryption_policy','singleton')
            crypto_history=json.loads(rows('golf_crypto_events','id'))
            assert inventory(key_before)=={key:({'sessions':3,'local_accounts':3,'workflow_dispatch_inputs':1}.get(key,0)) for key in recovery.KEY_FAMILIES}
            account_events=json.loads(rows('golf_local_account_events','id'))
            run_before=json.loads(rows('golf_workflow_runs','id'));assert len(run_before)==1 and run_before[0]['state']=='queued'
            session_count=int(sql('SELECT count(*) FROM golf_sessions;'));assert session_count==3
            compose('stop','golf','gitea')
            age_identity=directory/'age.key';private(age_identity,run('age-keygen',binary=True));recipient_age=run('age-keygen','-y',str(age_identity))
            encrypted=directory/'backup.age'; backup_args=['--project',source,'--compose-file',str(canonical),'--recipient',recipient_age,'--output',str(encrypted),'--writers-drained']
            call_recovery('backup',*backup_args,success=False);assert not encrypted.exists() # explicit profile is mandatory
            stage('closed059 encrypted backup, verification and fresh stopped-target restore')
            backup=call_recovery('backup',*backup_args,'--profile',recovery.ACCESS_PROFILE)
            verify_args=['--input',str(encrypted),'--identity',str(age_identity)];call_recovery('verify',*verify_args)
            wrong_age=directory/'wrong-age.key';private(wrong_age,run('age-keygen',binary=True))
            call_recovery('restore','--input',str(encrypted),'--identity',str(wrong_age),'--project',target,'--directory',str(directory/'wrong-age-target'),'--writers-drained',success=False)
            assert not any(resources(target).values()) and not (directory/'wrong-age-target').exists()
            restored=call_recovery('restore',*verify_args,'--project',target,'--directory',str(directory/'restored'),'--writers-drained')
            assert restored['backup_id']==backup['backup_id'] and restored['sessions_count']==session_count and restored['local_accounts_disabled_count']==3
            active_project=target;active_config=Path(restored['compose_file'])
            assert all(not json.loads(run('docker','inspect',container(s)))[0]['State']['Running'] for s in ('golf','gitea'))
            restored_history=histories();expired_count=check_restored_history(history,restored_history);assert expired_count==1
            assert rows('golf_workflow_dispatch_inputs','run_id')==ciphertext
            assert json.loads(rows('golf_crypto_events','id'))==crypto_history
            assert rows('golf_encryption_keys','key_id')==registry and rows('golf_encryption_policy','singleton')==policy_before
            after_accounts=json.loads(rows('golf_local_accounts','id'));assert len(after_accounts)==len(accounts)
            for a,b in zip(accounts,after_accounts):
                assert b['disabled_at'] is not None and b['credential_version']==a['credential_version']+1
                assert {k:v for k,v in a.items() if k not in {'disabled_at','credential_version'}}=={k:v for k,v in b.items() if k not in {'disabled_at','credential_version'}}
            after_runs=json.loads(rows('golf_workflow_runs','id')); assert len(after_runs)==1
            assert after_runs[0]['state']=='cancelled' and after_runs[0]['version']==run_before[0]['version']+1 and after_runs[0]['lease_token_hash'] is None
            assert {k:v for k,v in after_runs[0].items() if k not in {'state','version','reason','finished_at','lease_token_hash'}}=={k:v for k,v in run_before[0].items() if k not in {'state','version','reason','finished_at','lease_token_hash'}}
            assert sql('SELECT count(*) FROM golf_sessions;')==sql('SELECT count(*) FROM golf_oauth_attempts;')=='0'
            restored_account_events=json.loads(rows('golf_local_account_events','id'));assert restored_account_events[:len(account_events)]==account_events
            added=restored_account_events[len(account_events):];assert len(added)==3 and all(x['action']=='RECOVERY_DISABLED' for x in added)
            stage('wrong and missing restored content keys refuse supported operator inventory')
            wrong_keys=json.dumps({'a':base64.b64encode(secrets.token_bytes(32)).decode(),'b':key_b})
            keys('status',success=False,overrides=('-e','GOLF_ENCRYPTION_KEYS='+wrong_keys))
            missing_keys=json.dumps({'b':key_b})
            missing_status=keys('status',overrides=('-e','GOLF_ENCRYPTION_KEYS='+missing_keys))
            missing_row=next(r for r in missing_status['keys'] if r['key_id']=='a')
            assert missing_row['configured'] is False and missing_row['workflow_dispatch_inputs']==1 and missing_row['local_accounts']==3
            reject(lambda:recovery.checked_key_status(missing_status))
            for material in (wrong_keys,missing_keys):
                # Server.New checks registered fingerprints and required key
                # families before native calls or opening an HTTP listener.
                compose('run','--rm','--no-deps','-T','-e','GOLF_ENCRYPTION_KEYS='+material,'golf',success=False,timeout=90)
            assert all(not json.loads(run('docker','inspect',container(s)))[0]['State']['Running'] for s in ('golf','gitea'))
            assert rows('golf_workflow_dispatch_inputs','run_id')==ciphertext;equal_history(restored_history,histories())
            stage('bounded supported rotation authenticates retained encrypted inputs, with immutable bindings')
            status=keys('status');assert inventory(status)==inventory(key_before)|{'sessions':0,'oauth_attempts':0}
            rotated=keys('rotate','--batch-size','1','--max-batches','32');assert rotated['complete'] and rotated['rotated_workflow_dispatch_inputs']==1
            assert rotated['rotated_local_accounts']==3
            rotated_history=json.loads(rows('golf_crypto_events','id'));assert rotated_history[:len(crypto_history)]==crypto_history
            remaining=keys('retirement-check','--key-id','a');assert remaining is not None
            opened=json.loads(rows('golf_workflow_dispatch_inputs','run_id'));old=json.loads(ciphertext)
            assert opened[0]['credential_key_id']=='b' and opened[0]['encrypted_content']!=old[0]['encrypted_content']
            assert {k:v for k,v in opened[0].items() if k not in {'credential_key_id','encrypted_content'}}=={k:v for k,v in old[0].items() if k not in {'credential_key_id','encrypted_content'}}
            equal_history(restored_history,histories())
            record(historyHashes={t:hashlib.sha256(v.encode()).hexdigest() for t,v in history.items()},historyCounts={t:len(json.loads(v)) for t,v in history.items()},
                restoredHistoryHashes={t:hashlib.sha256(v.encode()).hexdigest() for t,v in restored_history.items()},pendingInvitationsExpired=expired_count,
                keyFamilies=list(recovery.KEY_FAMILIES),wrongKeyDenied=True,missingKeyDenied=True,typedRetainedCancelledAndAuthenticated=True,
                restoredSessionsInvalidated=True,issuerCredentialVersionsAdvanced=True)
            stage('controlled native/core validation restart and explicit current-account enrollment')
            compose('up','-d','--no-build','--pull','never','gitea','golf');smoke.ready();assert native_snapshot()==native_before
            for a in actors.values():
                rpc(a,'SessionService/GetSession',{},expected=401)
                rpc({'session':smoke.client()},'SessionService/LoginWithPassword',{'username':a['email'],'password':a['password']},expected=401)
            rpc(owner,'WorkflowRunService/GetWorkflowDispatch',original_input,expected=401)
            for a in actors.values():
                operator('enable',{'username':a['name'],'password':a['password'],'forge_token':a['token']})
                a['session']=smoke.client();rpc(a,'SessionService/LoginWithPassword',{'username':a['email'],'password':a['password']})
            original_cancelled=typed_original();assert original_cancelled['state']=='WORKFLOW_RUN_STATE_CANCELLED' and original_cancelled['version']==str(run_before[0]['version']+1)
            assert inspect(unknown_intent)==unknown
            for p,r in known:
                assert inspect(p)==r
                method='SetRepositoryCollaborator' if 'permission' in p else 'RemoveRepositoryCollaborator'
                assert rpc(owner,'RepositoryAccessService/'+method,p)['operation']==r
            assert rpc(owner,'RepositoryAccessService/SetRepositoryCollaborator',unknown_intent)['operation']==unknown
            fresh=intent(repos[2],actors['outsider'],'write');rpc(owner,'RepositoryAccessService/SetRepositoryCollaborator',fresh,expected=400,code='failed_precondition')
            for row,payload,response,result in invitations:
                if response and result.get('operation'):
                    rpc(recipient,'RepositoryInvitationService/GetRepositoryInvitationOperation',{'invitationId':row['id'],'idempotencyKey':response['idempotencyKey']},expected=403)
                    rpc(recipient,'RepositoryInvitationService/RespondRepositoryInvitation',response,expected=403)
            rpc(recipient,'RepositoryInvitationService/RespondRepositoryInvitation',{'invitationId':invitations[-2][0]['id'],'expectedRevision':invitations[-2][0]['revision'],
                'decision':'REPOSITORY_INVITATION_DECISION_ACCEPT','idempotencyKey':str(uuid.uuid4())},expected=400,code='failed_precondition')
            # UNKNOWN still blocks new direct work and archive after restore.
            fresh_invitation_target=intent(repos[3],recipient,'write')
            rpc(owner,'RepositoryAccessService/SetRepositoryCollaborator',fresh_invitation_target,expected=400,code='failed_precondition')
            for blocked_repo in repos[2:]:
                current=rpc(owner,'RepositoryLifecycleService/GetRepositoryLifecycle',{'repository':blocked_repo['key'],'repositoryId':blocked_repo['id']})['lifecycle']
                assert current['blockedReason']=='active_work' and not current.get('archiveAvailable',False)
                refused=rpc(owner,'RepositoryLifecycleService/ChangeRepositoryArchiveState',{'repository':blocked_repo['key'],'repositoryId':blocked_repo['id'],
                    'ownerId':blocked_repo['ownerId'],'expectedRevision':current['revision'],'archived':True,'confirmationName':blocked_repo['full'],
                    'currentPassword':owner['password'],'idempotencyKey':str(uuid.uuid4())})['operation']
                assert refused['phase']=='REJECTED' and refused['failureCode']=='preflight_refused'
            equal_history(restored_history,histories());assert native_snapshot()==native_before
            compose('restart','gitea','golf');smoke.ready();assert inspect(unknown_intent)==unknown
            equal_history(restored_history,histories());assert native_snapshot()==native_before
            assert typed_original()==original_cancelled and sql('SELECT count(*) FROM golf_workflow_runs;')==sql('SELECT count(*) FROM golf_workflow_dispatch_inputs;')=='1'
            assert sql('SELECT count(*) FROM golf_workflow_run_logs;')=='0'
            record(originalTypedStatusAfterReenrollment=True,originalDirectStatusAndReplay=True,staleInvitationConsentDeniedAfterReenrollment=True,nativeBindingsAndSharedDeployKeysUnchanged=True,unknownInvitationConsentNotUpgraded=True,
                queuedRunNeverReplayed=True,controlledRestartPreserved=True)
            passed=True
        except BaseException as error:
            original=error
            record(status='failed',originalFailure={'type':type(error).__name__,'stage':STAGE,
                'frames':[{'file':Path(f.filename).name if Path(f.filename).name in {Path(__file__).name,'recovery.py','smoke.py'} else 'dependency','line':f.lineno} for f in traceback.extract_tb(error.__traceback__)[-6:]]})
        finally:
            stage('exact owned fresh-project teardown; preserve original failure')
            for project in projects:
                try:
                    found=resources(project)
                    if found['containers']:run('docker','rm','-f','-v',*found['containers'])
                    if found['volumes']:run('docker','volume','rm',*found['volumes'])
                    if found['networks']:run('docker','network','rm',*found['networks'])
                    assert not any(resources(project).values())
                except BaseException as error:cleanup_errors.append({'project':project,'type':type(error).__name__})
            smoke.GOLF,smoke.GITEA=previous
            unchanged=False;zero=False
            try:
                after=foreign();private(output/'foreign-after.json',json.dumps(after));unchanged=before==after
                zero=not any(any(resources(p).values()) for p in projects)
            except BaseException as error:
                cleanup_errors.append({'scope':'final_inventory','type':type(error).__name__})
            record(cleanup='passed' if not cleanup_errors and zero else 'failed',cleanupErrors=cleanup_errors,ownedResourcesZero=zero,foreignIdentityUnchanged=unchanged)
            if not unchanged and original is None:original=AssertionError('Foreign resource identity changed')
            if cleanup_errors and original is None:original=AssertionError('Owned cleanup failed')
    if original:raise original
    assert passed;record(status='qualified',complete=True)
    print('PASS: bounded actual059 Access-core recovery; whole-platform recovery remains unqualified')

if __name__=='__main__':
    try: main()
    except BaseException as error:
        print('FAIL: Access recovery at '+STAGE+' ('+type(error).__name__+'); private diagnostics withheld', file=sys.stderr)
        raise SystemExit(1) from None
