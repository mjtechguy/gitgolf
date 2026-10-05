#!/usr/bin/env python3
"""Owned local-registry and actual ExecuteGit qualification; never deploys Golf.

Uses only existing cached bytes, offline Go builds, a bounded loopback registry
and isolated labeled runner resources. No external publication/pull, credential
forwarding, host mounts or broad cleanup. Job volumes have no hard disk quota.
"""
import argparse
import gzip
import hashlib
import io
import json
import os
from pathlib import Path
import re
import secrets
import subprocess
import tarfile
import time
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
SCRATCH = 'sha256:4974555dc0c54bf9d8bac3bf3a25067ca51f8e70490618b761a8d810db2fc50f'
REGISTRY = 'sha256:852b3e4d378c426dda6b318fe9d9bfe8e92a0eccb9926671ec3d3ea17a196696'
DAEMON = 'docker:29.8.1-dind@sha256:3f3c01aaaebf7cce837356b688b7c059a4749f10bd7660dec7c58fc454a283f0'
DIGEST = re.compile(r'sha256:[0-9a-f]{64}\Z')
CID = re.compile(r'[0-9a-f]{64}\Z')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    output = args.output.resolve()
    output.mkdir(mode=0o700, parents=True, exist_ok=False)
    os.chmod(output, 0o700)
    worker = 'golf-git-job-proof-' + secrets.token_hex(5)
    receipt = {'passed': False, 'complete': False, 'worker': worker, 'scope': 'Owned native Git HTTP/TLS fixture and actual ExecuteGit/maintained engine; no Golf/Gitea enrollment, job checkout token/origin, remote actions, unchanged Requests CI or activation', 'jobDiskQuota': False, 'failures': []}
    registry = None
    tagged = []
    phase = 'preflight'
    # Remove provider/control environment and credentials from all subprocesses.
    environment = {k: v for k, v in os.environ.items() if not k.startswith(('GOLF_', 'GITEA_', 'AWS_', 'CF_', 'CLOUDFLARE_', 'OTEL_', 'POSTGRES_', 'COMPOSE_')) and k not in ('DATABASE_URL', 'DOCKER_CONTEXT', 'DOCKER_HOST', 'DOCKER_CONFIG')}
    config = output/'docker-config'
    config.mkdir(mode=0o700)
    try:
        endpoint = subprocess.check_output(['docker', 'context', 'inspect', '--format', '{{.Endpoints.docker.Host}}'], timeout=10, stderr=subprocess.DEVNULL).decode().strip()
        assert endpoint.startswith('unix:///'), 'Local Unix Docker endpoint required'
        environment.update(DOCKER_HOST=endpoint, DOCKER_CONFIG=str(config), GOPROXY='off', GOSUMDB='off')

        def run(argv, *, limit=1 << 20, timeout=30, cwd=ROOT, extra=None):
            result = subprocess.run(argv, cwd=cwd, env=environment | (extra or {}), stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=timeout)
            assert result.returncode == 0 and len(result.stdout) <= limit and len(result.stderr) <= limit, 'Bounded native subprocess failed; output withheld'
            return result.stdout

        def inspect(image):
            rows = json.loads(run(['docker', 'image', 'inspect', image]))
            assert len(rows) == 1 and DIGEST.fullmatch(rows[0]['Id'])
            return rows[0]

        def inventory():
            return set(run(['docker', 'container', 'ls', '-aq', '--no-trunc']).decode().split())

        def http(url, accept=None):
            request = urllib.request.Request(url, headers={} if accept is None else {'Accept': accept})
            # Ignore ambient HTTP proxy variables, including for loopback.
            with urllib.request.build_opener(urllib.request.ProxyHandler({})).open(request, timeout=10) as response:
                body = response.read((16 << 20)+1)
                assert response.status == 200 and len(body) <= 16 << 20
                return response.headers, body

        before = inventory()
        source = inspect(SCRATCH)
        registry_image = inspect(REGISTRY)
        daemon = inspect(DAEMON)
        architecture = run(['go', 'env', 'GOHOSTARCH']).decode().strip()
        native_os = run(['go', 'env', 'GOHOSTOS']).decode().strip()
        assert architecture in ('amd64', 'arm64')
        for image in (source, registry_image, daemon):
            assert image['Os'] == 'linux' and image['Architecture'] == architecture
        assert source['Id'] == SCRATCH and source['Size'] <= 16 << 20 and not source['Config'].get('Volumes')
        assert REGISTRY in registry_image.get('RepoDigests', []) or any(r.endswith('@'+REGISTRY) for r in registry_image.get('RepoDigests', []))
        assert any(r.endswith('@'+DAEMON.split('@')[1]) for r in daemon.get('RepoDigests', []))
        receipt['originalSourceImage'] = {k: source.get(k) for k in ('Id', 'RepoDigests', 'Size', 'Architecture')}
        # Do not infer registry provenance from an image-ID-shaped RepoDigest.
        saved = run(['docker', 'image', 'save', SCRATCH], limit=16 << 20, timeout=60)
        with tarfile.open(fileobj=io.BytesIO(saved)) as archive:
            phase = 'cached OCI index/config/layer linkage'
            def cached_blob(digest):
                assert DIGEST.fullmatch(digest)
                data = archive.extractfile('blobs/sha256/'+digest.split(':')[1]).read((16 << 20)+1)
                assert len(data) <= 16 << 20 and digest == 'sha256:'+hashlib.sha256(data).hexdigest()
                return data
            index = json.loads(cached_blob(SCRATCH))
            assert index['schemaVersion'] == 2 and len(index['manifests']) <= 4
            platforms = [row for row in index['manifests'] if row.get('platform') == {'architecture': architecture, 'os': 'linux'}]
            assert len(platforms) == 1
            platform_digest = platforms[0]['digest']
            platform_bytes = cached_blob(platform_digest)
            platform_manifest = json.loads(platform_bytes)
            rows = json.load(archive.extractfile('manifest.json'))
            assert len(rows) == 1 and len(rows[0]['Layers']) <= 16
            configuration = archive.extractfile(rows[0]['Config']).read()
            configuration_sha = 'sha256:'+hashlib.sha256(configuration).hexdigest()
            assert configuration_sha == platform_manifest['config']['digest'], 'Cached image config does not match original OCI manifest'
            expected_layers = json.loads(configuration)['rootfs']['diff_ids']
            assert expected_layers == source['RootFS']['Layers'] and len(expected_layers) == len(platform_manifest['layers']) == len(rows[0]['Layers'])
            for descriptor, diff_id in zip(platform_manifest['layers'], expected_layers):
                assert descriptor['mediaType'] == 'application/vnd.oci.image.layer.v1.tar+gzip'
                layer = cached_blob(descriptor['digest'])
                assert len(layer) == descriptor['size']
                with gzip.GzipFile(fileobj=io.BytesIO(layer)) as stream:
                    plain = stream.read((16 << 20)+1)
                assert len(plain) <= 16 << 20 and diff_id == 'sha256:'+hashlib.sha256(plain).hexdigest()
        receipt['cachedPlatformManifestSHA256'] = platform_digest
        receipt['cachedConfigurationSHA256'] = configuration_sha
        receipt['cachedImageArchiveSHA256'] = hashlib.sha256(saved).hexdigest()
        del saved

        phase = 'offline builds'
        for filename, goos, directory, package in [('plan-engine', native_os, ROOT/'engines/act', './cmd/golf-actions-engine'), ('linux-engine', 'linux', ROOT/'engines/act', './cmd/golf-actions-engine')]:
            run(['go', 'build', '-trimpath', '-o', str(output/filename), package], cwd=directory, timeout=120, extra={'GOOS': goos, 'GOARCH': architecture, 'CGO_ENABLED': '0'})
        run(['go', 'test', '-c', '-o', str(output/'qualification.test'), './cmd/golf-runner'], timeout=120, extra={'GOOS': native_os, 'GOARCH': architecture, 'CGO_ENABLED': '0'})
        receipt['binaries'] = {p: hashlib.sha256((output/p).read_bytes()).hexdigest() for p in ('plan-engine', 'linux-engine', 'qualification.test')}
        receipt['sourceRevision'] = run(['git', 'rev-parse', 'HEAD']).decode().strip()
        receipt['sourceFiles'] = {p: hashlib.sha256((ROOT/p).read_bytes()).hexdigest() for p in ('cmd/golf-runner/git_execution.go', 'cmd/golf-runner/git_execution_test.go', 'internal/runner/actions.go', 'internal/runner/actions_git_source.go', 'internal/runner/git_preparation.go', 'internal/runner/git_source_envelope.go', 'engines/act/git_source.go', 'engines/act/execute.go', 'scripts/actions-git-source-smoke.py')}

        phase = 'capacity and owned loopback registry'
        # This cached-image probe is disposable, source-free and network-free.
        space = run(['docker', 'run', '--rm', '--pull=never', '--network=none', '--read-only', '--cap-drop=ALL', '--security-opt=no-new-privileges', '--memory=67108864', '--memory-swap=67108864', '--cpus=0.25', '--pids-limit=16', '--tmpfs', '/var/lib/registry:rw,size=1048576', '--label', 'io.golf.qualification='+worker, '--entrypoint', '/bin/df', REGISTRY, '-Pk', '/'])
        free_kib = int(space.decode().strip().splitlines()[-1].split()[3])
        receipt['dockerFreeKiBBefore'] = free_kib
        assert free_kib >= 2*1024*1024, 'Two-GiB Docker VM reserve required'
        created = run(['docker', 'container', 'create', '--pull=never', '--name', worker+'-registry', '--label', 'io.golf.qualification='+worker, '--publish', '127.0.0.1::5000', '--memory=134217728', '--memory-swap=134217728', '--cpus=0.5', '--pids-limit=32', '--cap-drop=ALL', '--security-opt=no-new-privileges', '--read-only', '--tmpfs', '/var/lib/registry:rw,size=134217728,mode=0700', '--tmpfs', '/tmp:rw,size=16777216,mode=1777', '--env', 'OTEL_SDK_DISABLED=true', REGISTRY]).decode().strip()
        assert CID.fullmatch(created), 'Registry create receipt lost; inspect only named owned residue'
        registry = created
        run(['docker', 'container', 'start', registry])
        state = json.loads(run(['docker', 'container', 'inspect', registry]))[0]
        assert state['Id'] == registry and state['Config']['Labels']['io.golf.qualification'] == worker
        assert not any(m['Type'] in ('volume', 'bind') for m in state['Mounts'])
        ports = state['NetworkSettings']['Ports']['5000/tcp']
        assert len(ports) == 1 and ports[0]['HostIp'] == '127.0.0.1'
        port = ports[0]['HostPort']
        origin = 'http://127.0.0.1:'+port
        for _ in range(40):
            try:
                http(origin+'/v2/')
                break
            except Exception:
                time.sleep(0.1)
        else:
            raise AssertionError('Owned registry failed readiness')

        phase = 'genuine local manifest and cached pull identity'
        repository = '127.0.0.1:'+port+'/golf/git-source-job-proof'
        tag = repository+':'+worker
        run(['docker', 'image', 'tag', SCRATCH, tag])
        tagged.append(tag)
        run(['docker', 'image', 'push', tag], timeout=90)
        headers, body = http(origin+'/v2/golf/git-source-job-proof/manifests/'+platform_digest, 'application/vnd.oci.image.manifest.v1+json')
        digest = 'sha256:'+hashlib.sha256(body).hexdigest()
        assert headers.get('Docker-Content-Digest') == digest == platform_digest and body == platform_bytes
        manifest = json.loads(body)
        assert manifest['schemaVersion'] == 2 and manifest['config']['digest'] == configuration_sha and len(manifest['layers']) == len(expected_layers)
        _, received_config = http(origin+'/v2/golf/git-source-job-proof/blobs/'+configuration_sha)
        assert received_config == configuration
        for layer in manifest['layers']:
            assert DIGEST.fullmatch(layer['digest']) and 0 < layer['size'] <= 16 << 20
            _, compressed = http(origin+'/v2/golf/git-source-job-proof/blobs/'+layer['digest'])
            assert len(compressed) == layer['size'] and 'sha256:'+hashlib.sha256(compressed).hexdigest() == layer['digest']
        approved = repository+'@'+digest
        run(['docker', 'image', 'pull', approved], timeout=60)
        tagged.append(approved)
        pulled = inspect(approved)
        assert pulled['Id'] in (SCRATCH, platform_digest, configuration_sha) and pulled['RootFS']['Layers'] == expected_layers and approved in pulled['RepoDigests']
        receipt.update(qualifiedJobImage=approved, registryManifestSHA256=digest, registryConfigSHA256=configuration_sha, registryContainer=registry, registryTmpfsBytes=134217728)

        phase = 'actual ExecuteGit engine/job qualification'
        env = environment | {'GOLF_TEST_GIT_JOB_IMAGE': approved, 'GOLF_TEST_GIT_WORKER_ID': worker, 'GOLF_TEST_GIT_PLAN_BINARY': str(output/'plan-engine'), 'GOLF_TEST_GIT_ENGINE_BINARY': str(output/'linux-engine')}
        with (output/'actual-engine.log').open('wb') as log:
            result = subprocess.run([str(output/'qualification.test'), '-test.run=^TestActionsGitActualEngine$', '-test.v', '-test.timeout=240s'], cwd=ROOT, env=env, stdout=log, stderr=subprocess.STDOUT, timeout=250)
        text = (output/'actual-engine.log').read_text()
        receipt['actualTestExitCode'] = result.returncode
        assert result.returncode == 0 and '--- SKIP' not in text and all('ACTUAL_GIT_JOB case='+case in text for case in ('success', 'wrong_tree', 'cancel')), 'Actual engine qualification failed; bounded log retained'
        receipt['cases'] = [line.strip() for line in text.splitlines() if 'ACTUAL_GIT_JOB case=' in line]
        assert set(run(['docker', 'container', 'ls', '-aq', '--filter', 'label=io.golf.runner.worker='+worker]).decode().split()) == set()
        assert not run(['docker', 'volume', 'ls', '-q', '--filter', 'label=io.golf.runner.worker='+worker]).strip()
        receipt['passed'] = True
    except Exception as error:
        receipt['failures'].append({'phase': phase, 'type': type(error).__name__, 'reason': str(error)[:512]})
    finally:
        cleanup_ok = True
        if registry:
            try:
                state = json.loads(run(['docker', 'container', 'inspect', registry]))[0]
                assert state['Id'] == registry and state['Config']['Labels']['io.golf.qualification'] == worker
                run(['docker', 'container', 'rm', '--force', registry])
            except Exception:
                cleanup_ok = False
        for tag in reversed(tagged):
            try:
                run(['docker', 'image', 'rm', '--no-prune', tag])
            except Exception:
                cleanup_ok = False
        if 'before' in locals():
            try:
                assert inventory() == before, 'Foreign/runtime container inventory changed or owned residue remains'
            except Exception:
                cleanup_ok = False
        receipt['cleanupComplete'] = cleanup_ok
        receipt['complete'] = True
        receipt['passed'] = receipt['passed'] and cleanup_ok
        (output/'manifest.json').write_text(json.dumps(receipt, indent=2)+'\n')
        os.chmod(output/'manifest.json', 0o600)
    print('Actual Git engine qualification '+('passed' if receipt['passed'] else 'refused')+'; receipt: '+str(output/'manifest.json'))
    return 0 if receipt['passed'] else 1


if __name__ == '__main__':
    raise SystemExit(main())
