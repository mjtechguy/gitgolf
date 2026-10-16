#!/usr/bin/env python3
"""Owned offline act mechanics; no Golf run/CI/provider/native configuration."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import secrets
import subprocess
import tempfile
import time

ROOT = Path(__file__).resolve().parent
ALPINE = 'alpine:3.23@sha256:85fe1e81d6758c208f3e1eed4338a1997e19d4be002d4dd32d3100c9a8c010a0'
DIND = 'docker:29.8.1-dind@sha256:3f3c01aaaebf7cce837356b688b7c059a4749f10bd7660dec7c58fc454a283f0'
STAGE = 'initialization'


def stage(value):
    global STAGE
    STAGE = value
    print('CHECK: ' + value, flush=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source-daemon', required=True,
        help='Existing owned runner daemon container; read-only image save only')
    parser.add_argument('--artifacts', required=True)
    args = parser.parse_args()
    assert re.fullmatch(r'[A-Za-z0-9_.-]{1,128}', args.source_daemon)
    artifacts = Path(args.artifacts).resolve()
    artifacts.mkdir(parents=True, exist_ok=False, mode=0o700)
    env = {key: value for key, value in os.environ.items() if not key.startswith(
        ('GOLF_', 'FORGEJO_', 'POSTGRES_', 'OTEL_', 'COMPOSE_', 'RUSTFS_', 'AWS_', 'GIT_'))
        and key not in ('DATABASE_URL', 'DOCKER_HOST', 'DOCKER_TLS_VERIFY', 'DOCKER_CERT_PATH')}
    owner = 'golf-act-proof-' + secrets.token_hex(6)
    manifest = {'complete': False, 'passed': False, 'engine': json.loads(
        (ROOT / 'engine-pin.json').read_text()), 'cases': [], 'cleanup': False,
        'productionAdapter': False, 'javascriptQualified': False}

    def write_manifest():
        target = artifacts / 'manifest.json'
        target.write_text(json.dumps(manifest, indent=2) + '\n')
        target.chmod(0o600)

    def run(*command, payload=None, timeout=90, required=True):
        result = subprocess.run(command, input=payload, capture_output=True,
            cwd=ROOT, env=env, timeout=timeout)
        assert len(result.stdout) <= 4 << 20 and len(result.stderr) <= 4 << 20
        if required:
            assert result.returncode == 0, 'Owned operation failed'
        return result

    def inner(*command, **kwargs):
        return run('docker', 'exec', owner, *command, **kwargs)

    created = False
    try:
        stage('readonly image identity')
        daemon = json.loads(run('docker', 'image', 'inspect', DIND).stdout)[0]
        source = json.loads(run('docker', 'inspect', args.source_daemon).stdout)[0]
        assert source['State']['Running'] and source['HostConfig']['Privileged']
        alpine = json.loads(run('docker', 'exec', args.source_daemon,
            'docker', 'image', 'inspect', ALPINE).stdout)[0]
        assert re.fullmatch(r'sha256:[0-9a-f]{64}', alpine['Id'])
        assert any(value.endswith(ALPINE.split('@', 1)[1]) for value in alpine.get('RepoDigests', []))
        assert daemon['Architecture'] in ('arm64', 'amd64')
        disk = run('docker', 'exec', args.source_daemon, 'df', '-Pk', '/var/lib/docker').stdout.decode().splitlines()
        assert len(disk) == 2 and int(disk[1].split()[3]) * 1024 >= 2 << 30, 'Disk reserve below 2GiB'
        manifest.update(daemonImageId=daemon['Id'], daemonManifest=DIND,
            jobImageId=alpine['Id'], jobManifest=ALPINE)
        with tempfile.TemporaryDirectory(prefix=owner+'-') as tmp:
            binary = Path(tmp) / 'offline'
            stage('source build')
            build_env = dict(env, CGO_ENABLED='0', GOOS='linux', GOARCH=daemon['Architecture'])
            build = subprocess.run(['go', 'build', '-trimpath', '-o', str(binary), './cmd/offline'],
                cwd=ROOT, env=build_env, capture_output=True, timeout=180)
            assert build.returncode == 0, 'Owned source build failed'
            manifest['qualifierBinarySHA256'] = hashlib.sha256(binary.read_bytes()).hexdigest()
            stage('fresh offline daemon')
            run('docker', 'run', '-d', '--pull=never', '--name', owner,
                '--label', 'golf.qualification.actions=' + owner, '--network=none',
                '--privileged',
                '-e', 'DOCKER_TLS_CERTDIR=', '--entrypoint=dockerd-entrypoint.sh', daemon['Id'], 'dockerd',
                '--host=unix:///var/run/docker.sock', '--iptables=false',
                '--ip-masq=false', '--bridge=none')
            created = True
            owned = json.loads(run('docker', 'inspect', owner).stdout)[0]
            assert owned['HostConfig']['NetworkMode'] == 'none'
            assert owned['HostConfig']['Memory'] == 0 and owned['HostConfig']['NanoCpus'] == 0
            manifest['trustedOuterCgroups'] = 'unbounded; nested job limits inspected separately'
            assert not owned['HostConfig'].get('PortBindings') and not owned['HostConfig'].get('Binds')
            deadline = time.monotonic() + 45
            while time.monotonic() < deadline:
                if inner('docker', 'info', required=False, timeout=5).returncode == 0:
                    break
                time.sleep(0.25)
            else:
                raise AssertionError('Owned daemon readiness')
            stage('local readonly image transfer')
            # Streaming save/load avoids retaining an image archive or changing
            # any source-daemon images. Both commands have an outer hard bound.
            save = subprocess.Popen(['docker', 'exec', args.source_daemon,
                'docker', 'image', 'save', ALPINE], stdout=subprocess.PIPE,
                stderr=subprocess.DEVNULL, env=env)
            try:
                load = subprocess.Popen(['docker', 'exec', '-i', owner,
                    'docker', 'image', 'load'], stdin=save.stdout,
                    stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, env=env)
                save.stdout.close()
                try:
                    assert load.wait(timeout=90) == 0 and save.wait(timeout=10) == 0
                finally:
                    if load.poll() is None:
                        load.kill(); load.wait(timeout=10)
            finally:
                if save.poll() is None:
                    save.kill(); save.wait(timeout=10)
            copied = json.loads(inner('docker', 'image', 'inspect', alpine['Id']).stdout)[0]
            assert copied['Id'] == alpine['Id']
            run('docker', 'cp', str(binary), owner + ':/offline')
            inner('mkdir', '-p', '/qualification')

            for case, event in [('graph', 'workflow_dispatch'), ('graph', 'push'),
                                ('failure', 'workflow_dispatch'), ('cancel', 'workflow_dispatch')]:
                stage('owned runtime ' + case + ' ' + event)
                result = inner('env', 'DOCKER_HOST=unix:///var/run/docker.sock',
                    'GOLF_OWNED_ENGINE_DAEMON=1', '/offline', '--image-id', alpine['Id'],
                    '--case', case, '--event', event, timeout=90, required=False)
                if result.returncode != 0:
                    try:
                        manifest['failedReceipt'] = json.loads(result.stdout)
                    except (ValueError, UnicodeError):
                        pass
                    diagnostic = result.stderr.decode(errors='replace').strip()
                    if diagnostic.startswith('FAIL: offline owned runtime qualification:') and len(diagnostic) < 256:
                        manifest['runtimeFailure'] = diagnostic
                        print(diagnostic, flush=True)
                    raise AssertionError('Owned runtime failed')
                receipt = json.loads(result.stdout)
                assert receipt['case'] == case and receipt['event'] == event
                assert receipt['imageId'] == alpine['Id'] and receipt['nativeCleanup']
                manifest['cases'].append(receipt)
                write_manifest()

            stage('hard engine termination')
            inner('env', 'DOCKER_HOST=unix:///var/run/docker.sock',
                'GOLF_OWNED_ENGINE_DAEMON=1', 'sh', '-c',
                '/offline --image-id "$1" --case terminate >/qualification/terminate.out 2>/qualification/terminate.err &',
                'owned', alpine['Id'])
            deadline = time.monotonic() + 20
            running = []
            while time.monotonic() < deadline:
                running = inner('docker', 'ps', '-q').stdout.decode().split()
                started = any(inner('docker', 'exec', container, 'sh', '-c',
                    'test "$(cat /qualification/workspace/.proof)" = hang-started && ps -o args | grep -x "sleep 120" >/dev/null',
                    required=False).returncode == 0 for container in running)
                if started:
                    break
                time.sleep(0.25)
            assert running and started, 'Owned long-running job not observed'
            pid = inner('cat', '/qualification/engine.pid').stdout.decode().strip()
            assert re.fullmatch(r'[1-9][0-9]{0,8}', pid)
            inner('kill', '-KILL', pid)
            # Abrupt engine loss leaves uncertainty; cleanup is the trusted
            # daemon owner's responsibility, never a successful job receipt.
            manifest['hardTerminationObserved'] = True
            manifest['residualJobsBeforeOwnerCleanup'] = len(inner('docker', 'ps', '-q').stdout.decode().split())
            manifest['complete'] = True
            manifest['passed'] = True
    except Exception:
        manifest['failureStage'] = STAGE
        raise
    finally:
        stage('owned daemon cleanup')
        if created:
            removed = run('docker', 'rm', '-f', '-v', owner, required=False)
            absent = run('docker', 'inspect', owner, required=False)
            manifest['cleanup'] = removed.returncode == 0 and absent.returncode != 0
        else:
            manifest['cleanup'] = True
        manifest['passed'] = manifest['passed'] and manifest['cleanup']
        write_manifest()
        assert manifest['cleanup'], 'Owned daemon cleanup failed'
    print('PASS: owned offline engine mechanics; no product compatibility grant', flush=True)


if __name__ == '__main__':
    try:
        main()
    except Exception:
        print('FAIL: ' + STAGE, flush=True)
        raise SystemExit(1)
