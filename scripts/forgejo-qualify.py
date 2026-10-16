#!/usr/bin/env python3
"""Run portable Golf against an owned, disposable pinned Forgejo/PostgreSQL stack.

All listeners use random loopback high ports. No existing stack/config is used.
Credentials and logs stay in a temporary private directory; cleanup is unconditional.
"""
import argparse
import base64
import hashlib
import json
import os
from pathlib import Path
import secrets
import socket
import subprocess
import tempfile
import time
import urllib.request
import uuid

ROOT = Path(__file__).resolve().parents[1]
IMAGE = 'codeberg.org/forgejo/forgejo:15.0.9-rootless@sha256:caf1bca332f95cdcf124227a4bfa3b49bbbfbbc8a5e4a97406921cb581165413'
POSTGRES = 'postgres:18.4-alpine3.24'


def command(*args, **kwargs):
    result = subprocess.run(args, capture_output=True, text=True, timeout=kwargs.pop('timeout', 180), **kwargs)
    if result.returncode:
        raise RuntimeError(f'{args[0]} failed; private output withheld')
    return result.stdout.strip()


def port():
    with socket.socket() as sock:
        sock.bind(('127.0.0.1', 0))
        return sock.getsockname()[1]


def wait(url):
    deadline = time.monotonic() + 90
    while time.monotonic() < deadline:
        try:
            with urllib.request.urlopen(url, timeout=3) as response:
                return json.load(response)
        except (OSError, ValueError):
            time.sleep(.25)
    raise RuntimeError(f'Fixture did not become ready: {url}')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--test-pattern', default='TestForge|TestPathsAndDirectoryConfiguration|TestForgeTokenAlias|TestApiCredentialQuotaAndScopePostgres|TestSessionAndRepositoryWithPostgres', help='Go integration selection; use . for the full legacy suite')
    parser.add_argument('--integration', action='store_true', help='also run Go race/integration checks in an owned database')
    parser.add_argument('--suite', nargs='+', default=['smoke.py', 'workflow-config-smoke.py', 'forgejo-native-smoke.py'])
    args = parser.parse_args()
    for name in args.suite:
        if Path(name).name != name or not (ROOT/'scripts'/name).is_file():
            parser.error('suite must name an existing script in scripts/')
    receipt = {'profile':'forgejo-15.0.9', 'image':IMAGE, 'checks':[], 'cleanup':False}
    prefix = 'golf-forgejo-proof-' + secrets.token_hex(5)
    containers, network, process = [], False, None
    started = time.monotonic()
    args.output.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix=prefix) as directory:
        private = Path(directory)
        password = secrets.token_hex(24)
        pg_port, forge_port, golf_port = port(), port(), port()
        env = {k:v for k,v in os.environ.items() if not k.startswith(('GOLF_', 'FORGEJO_', 'DATABASE_URL', 'COMPOSE_'))}
        try:
            command('go','build','-o',str(private/'golf-server'),'./cmd/golf',cwd=ROOT)
            command('go','build','-o',str(private/'golf'),'./cmd/golfctl',cwd=ROOT)
            command('docker','network','create',prefix); network = True
            pg = prefix+'-postgres'; containers.append(pg)
            command('docker','run','-d','--name',pg,'--network',prefix,'-p',f'127.0.0.1:{pg_port}:5432',
                    '-e','POSTGRES_PASSWORD','--label','golf.fixture=forgejo',POSTGRES,env={**env,'POSTGRES_PASSWORD':password})
            deadline=time.monotonic()+60
            while subprocess.run(['docker','exec',pg,'pg_isready','-h','127.0.0.1','-U','postgres'],capture_output=True).returncode:
                if time.monotonic()>deadline: raise RuntimeError('PostgreSQL readiness failed')
                time.sleep(.25)
            for name in ('golf','forgejo','golf_tests'):
                command('docker','exec',pg,'createdb','-U','postgres',name)
            if args.integration:
                print('Running Go race/integration tests in owned PostgreSQL',flush=True)
                result=subprocess.run(['go','test','-race','./...','-count=1','-run',args.test_pattern],cwd=ROOT,env={**env,'GOLF_TEST_DATABASE_URL':f'postgres://postgres:{password}@127.0.0.1:{pg_port}/golf_tests?sslmode=disable'},capture_output=True,text=True,timeout=900)
                (args.output.parent/'go-integration.log').write_text(result.stdout+result.stderr)
                receipt['checks'].append({'script':'go test -race ./... -run '+args.test_pattern,'passed':result.returncode==0})
                if result.returncode: raise RuntimeError('Go integration failed; see go-integration.log')
            native = prefix+'-forgejo'; containers.append(native)
            settings = {
                'FORGEJO__database__DB_TYPE':'postgres', 'FORGEJO__database__HOST':pg+':5432',
                'FORGEJO__database__NAME':'forgejo','FORGEJO__database__USER':'postgres','FORGEJO__database__PASSWD':password,
                'FORGEJO__security__INSTALL_LOCK':'true','FORGEJO__service__DISABLE_REGISTRATION':'true',
                'FORGEJO__server__ROOT_URL':f'http://localhost:{forge_port}/','FORGEJO__actions__ENABLED':'false',
                'FORGEJO__mailer__ENABLED':'false','FORGEJO__repository__DEFAULT_BRANCH':'main',
            }
            flags = [part for key in settings for part in ('-e',key)]
            command('docker','run','-d','--name',native,'--network',prefix,'-p',f'127.0.0.1:{forge_port}:3000',
                    '--label','golf.fixture=forgejo',*flags,IMAGE,env={**env,**settings})
            native_url=f'http://localhost:{forge_port}'
            receipt['serverVersion']=wait(native_url+'/api/v1/version')['version']
            with urllib.request.urlopen(native_url+'/swagger.v1.json',timeout=10) as response:
                spec=json.load(response)
            receipt['openapiSHA256']=hashlib.sha256(json.dumps(spec,sort_keys=True,separators=(',',':')).encode()).hexdigest()
            (args.output.parent/'forgejo-openapi.json').write_text(json.dumps(spec,sort_keys=True))
            instance=str(uuid.uuid4())
            runtime = {**env,'DATABASE_URL':f'postgres://postgres:{password}@127.0.0.1:{pg_port}/golf?sslmode=disable',
                'GOLF_FORGE_KIND':'forgejo','GOLF_FORGE_URL':native_url,'GOLF_FORGE_INSTANCE_ID':instance,
                'GOLF_PUBLIC_URL':f'http://localhost:{golf_port}','GOLF_LISTEN_ADDR':f'127.0.0.1:{golf_port}',
                'GOLF_ENCRYPTION_KEY':base64.b64encode(secrets.token_bytes(32)).decode(),
                'GOLF_ALLOW_INSECURE_COOKIES':'true','GOLF_WEB_DIR':str(ROOT/'web/dist'),
                'GOLF_SMOKE_URL':f'http://localhost:{golf_port}','GOLF_SMOKE_FORGE_URL':native_url,
                'GOLF_SMOKE_FORGE_CONTAINER':native,'GOLF_SMOKE_FORGE_KIND':'forgejo'}
            with (private/'server.log').open('w') as log:
                process=subprocess.Popen([str(private/'golf-server')],env=runtime,cwd=ROOT,stdout=log,stderr=log)
                assert wait(runtime['GOLF_PUBLIC_URL']+'/readyz')['checks'] == {'database':'ready','forgejo':'ready'}
                for name in args.suite:
                    check_started=time.monotonic()
                    print('Running '+name,flush=True)
                    extra=['--cli',str(private/'golf')] if name=='smoke.py' else []
                    result=subprocess.run(['python3',str(ROOT/'scripts'/name),*extra],env=runtime,cwd=ROOT,timeout=300,capture_output=True,text=True)
                    if result.returncode:
                        # The private trace is retained only for operator diagnosis.
                        trace=args.output.parent/(name+'.failure.log')
                        fd=os.open(trace,os.O_WRONLY|os.O_CREAT|os.O_TRUNC,0o600)
                        with os.fdopen(fd,'w') as file: file.write(result.stdout+'\n'+result.stderr)
                        raise RuntimeError('Suite failed: '+name+'; private trace: '+str(trace))
                    output=result.stdout
                    receipt['checks'].append({'script':name,'passed':True,'seconds':round(time.monotonic()-check_started,3)})
                    print(output,flush=True)
                receipt['passed']=True
        finally:
            if process is not None:
                process.terminate()
                try: process.wait(timeout=10)
                except subprocess.TimeoutExpired: process.kill(); process.wait(timeout=10)
            for container in reversed(containers):
                subprocess.run(['docker','rm','-fv',container],capture_output=True,timeout=60)
            if network: subprocess.run(['docker','network','rm',prefix],capture_output=True,timeout=30)
            remaining=command('docker','ps','-aq','--filter','name='+prefix)
            receipt['cleanup']=not remaining
            receipt['seconds']=round(time.monotonic()-started,3)
            args.output.write_text(json.dumps(receipt,indent=2)+'\n')
            if remaining: raise RuntimeError('Owned fixture cleanup incomplete')
    print('Forgejo qualification and cleanup passed',flush=True)


if __name__=='__main__': main()
