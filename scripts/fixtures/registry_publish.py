"""Real OCI publication from the approved test process, using only brokered HTTP."""
import gzip
import hashlib
import io
import json
import os
import pathlib
import subprocess
import tarfile
import urllib.error
import urllib.parse
import urllib.request


def publish():
    origin = os.environ.get('GOLF_REGISTRY')
    if not origin:
        return  # Agent proposal tests do not acquire canonical publishing authority.
    image, tag = os.environ['GOLF_IMAGE'].rsplit(':', 1)
    assert not any(key in os.environ for key in ['CFCR_CREDENTIAL', 'CLOUDFLARE_API_TOKEN'])
    def sha(data): return 'sha256:' + hashlib.sha256(data).hexdigest()
    def encoded(value): return json.dumps(value, separators=(',', ':')).encode()
    def request(path, data, method, content_type='application/octet-stream', expected=201):
        req = urllib.request.Request(origin + path, data=data, method=method, headers={'Content-Type': content_type})
        try: response = urllib.request.urlopen(req, timeout=20)
        except urllib.error.HTTPError as error: response = error
        with response:
            assert response.status == expected, (path, response.status)
            return response.read(65536), response.headers
    layer = io.BytesIO()
    with tarfile.open(fileobj=layer, mode='w') as archive:
        files = {'payload': 'Golf CI source ' + os.environ['GOLF_COMMIT'] + '\n',
                 'etc/os-release': 'ID=alpine\nVERSION_ID=3.16.0\n',
                 'lib/apk/db/installed': 'P:openssl\nV:1.1.1o-r0\nA:x86_64\nS:100\nI:100\nT:TLS\nU:https://openssl.org\nL:OpenSSL\no:openssl\nm:Fixture\nt:1650000000\nc:1234567890\n\n'}
        if origin == 'https://registry.cloudflare.com':
            files = {'payload': files['payload']}
            for path in [pathlib.Path('README.md'), *sorted(pathlib.Path('public').rglob('*'))]:
                if path.is_file() and not path.is_symlink():
                    files[str(path)] = path.read_bytes()
            for path in sorted(pathlib.Path('dist').glob('*')):
                if path.is_file() and not path.is_symlink() and path.suffix in ['.whl', '.json', '.gz']:
                    if path.stat().st_size > 24 * 1024 * 1024:
                        raise ValueError('Demo artifact exceeds publication bound')
                    files[str(path)] = path.read_bytes()
        if sum(len(v.encode() if isinstance(v, str) else v) for v in files.values()) > 31 * 1024 * 1024:
            raise ValueError('Demo image exceeds publication bound')
        for name, value in files.items():
            data = value.encode() if isinstance(value, str) else value; entry = tarfile.TarInfo(name); entry.size = len(data)
            archive.addfile(entry, io.BytesIO(data))
    compressed = gzip.compress(layer.getvalue(), mtime=0)
    labels = {'org.opencontainers.image.revision': os.environ['GOLF_COMMIT']}
    public = pathlib.Path('public')
    if public.is_dir() and (public / 'index.html').is_file():
        types = {'html': 'text/html; charset=utf-8', 'css': 'text/css; charset=utf-8', 'js': 'text/javascript; charset=utf-8',
                 'json': 'application/json; charset=utf-8', 'svg': 'image/svg+xml', 'txt': 'text/plain; charset=utf-8'}
        files = [{'path': str(path.relative_to(public)), 'contentType': types[path.suffix[1:]], 'content': path.read_text('utf-8')}
                 for path in sorted(public.rglob('*')) if path.is_file()]
        bundle = {'schema': 'golf.native.static-preview.v1', 'commitId': os.environ['GOLF_COMMIT'],
                  'treeId': subprocess.check_output(['git', 'rev-parse', 'HEAD^{tree}'], text=True).strip(),
                  'sourcePath': 'public', 'files': files}
        labels['dev.golf.static-preview.v1'] = json.dumps(bundle, separators=(',', ':'))
    config = encoded({'architecture': 'amd64', 'os': 'linux', 'config': {'Labels': labels},
                      'rootfs': {'type': 'layers', 'diff_ids': [sha(layer.getvalue())]}})
    descriptors = []
    for data, media in [(config, 'application/vnd.oci.image.config.v1+json'), (compressed, 'application/vnd.oci.image.layer.v1.tar+gzip')]:
        _, headers = request('/v2/' + image + '/blobs/uploads/', b'', 'POST', expected=202)
        location = urllib.parse.urlsplit(urllib.parse.urljoin(origin, headers['Location']))
        assert location.scheme + '://' + location.netloc == origin and location.path.startswith('/v2/' + image + '/blobs/uploads/')
        request(location.path + ('?' + location.query + '&' if location.query else '?') + 'digest=' + sha(data), data, 'PUT')
        descriptors.append({'digest': sha(data), 'size': len(data), 'mediaType': media})
    manifest = encoded({'schemaVersion': 2, 'mediaType': 'application/vnd.oci.image.manifest.v1+json', 'config': descriptors[0], 'layers': descriptors[1:]})
    _, headers = request('/v2/' + image + '/manifests/' + tag, manifest, 'PUT', 'application/vnd.oci.image.manifest.v1+json')
    assert headers['Docker-Content-Digest'] == sha(manifest)
    request('/v2/' + image + '/manifests/unauthorized', manifest, 'PUT', 'application/vnd.oci.image.manifest.v1+json', 403)
    print('Published exact-source OCI image', sha(manifest))
