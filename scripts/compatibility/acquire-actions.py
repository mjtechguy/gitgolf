#!/usr/bin/env python3
"""Acquire public GitHub actions into a new, bounded, immutable operator bundle.

Runs installed Git without ambient credentials/config/helpers/hooks. Does not
execute action or repository code. Runtime admission independently reconstructs
Git commit/tree identities and refuses altered cache contents.
"""
import argparse
import base64
import hashlib
import json
import io
import tarfile
import os
from pathlib import Path
import re
import resource
import subprocess
import tempfile


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('actions', nargs='+', help='owner/repository[/path]@full-commit-or-ref')
    args = parser.parse_args()
    assert 1 <= len(args.actions) <= 8 and len(set(args.actions)) == len(args.actions)
    output = args.output.resolve()
    output.mkdir(parents=True, mode=0o700, exist_ok=False)
    receipt = {'passed': False, 'actions': [], 'scope': 'Trusted public action acquisition; no job execution'}
    bundles = []
    total = 0

    def record():
        file = output / 'manifest.json'
        file.write_text(json.dumps(receipt, indent=2) + '\n')
        file.chmod(0o600)

    def limits():
        resource.setrlimit(resource.RLIMIT_FSIZE, (16 << 20, 16 << 20))
        resource.setrlimit(resource.RLIMIT_NOFILE, (128, 128))

    record()
    try:
        for uses in args.actions:
            match = re.fullmatch(r'([A-Za-z0-9_-]{1,64})/([A-Za-z0-9_.-]{1,64})(/[A-Za-z0-9_./-]{1,256})?@([A-Za-z0-9_./-]{1,128})', uses)
            assert match and not any(p in ('.', '..') for p in (match[3] or '').split('/')[1:])
            owner, repo, _, ref = match.groups()
            assert not ref.startswith('-')
            with tempfile.TemporaryDirectory(prefix='action-', dir=output) as directory:
                environment = {'PATH': '/usr/local/bin:/usr/bin:/bin', 'HOME': directory, 'XDG_CONFIG_HOME': directory, 'GIT_CONFIG_NOSYSTEM': '1', 'GIT_CONFIG_GLOBAL': '/dev/null', 'GIT_TERMINAL_PROMPT': '0', 'LANG': 'C'}
                options = ['git', '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-c', 'credential.helper=', '-c', 'protocol.allow=never', '-c', 'protocol.https.allow=always', '-c', 'http.proxy=', '-c', 'http.followRedirects=false', '-c', 'gc.auto=0', '-c', 'maintenance.auto=false']

                def git(*argv, bound=16 << 20):
                    result = subprocess.run(options + list(argv), cwd=directory, env=environment, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=120, preexec_fn=limits)
                    assert result.returncode == 0 and len(result.stdout) <= bound, 'Bounded Git acquisition failed; provider output withheld'
                    return result.stdout

                git('init', '--bare', '--template=', bound=4096)
                git('fetch', '--no-tags', '--depth=1', 'https://github.com/' + owner + '/' + repo, ref, bound=4096)
                commit = git('rev-parse', 'FETCH_HEAD', bound=128).decode().strip()
                assert re.fullmatch('[0-9a-f]{40}', commit) and (not re.fullmatch('[0-9a-f]{40}', ref) or ref == commit)
                body = git('cat-file', 'commit', commit, bound=64 << 10)
                raw_archive = git('archive', '--format=tar', commit)
                normalized = io.BytesIO()
                with tarfile.open(fileobj=io.BytesIO(raw_archive)) as source, tarfile.open(fileobj=normalized, mode='w', format=tarfile.USTAR_FORMAT) as target:
                    members = source.getmembers()
                    assert len(members) <= 4096
                    for member in sorted(members, key=lambda item: item.name):
                        if member.isdir():
                            continue
                        assert (member.isfile() or member.issym()) and member.size <= 8 << 20 and not member.name.startswith('/') and '..' not in member.name.split('/') and '.git' not in member.name.split('/')
                        entry = tarfile.TarInfo(member.name)
                        entry.size, entry.mode = member.size, member.mode & 0o777
                        if member.issym():
                            import posixpath
                            resolved = posixpath.normpath(posixpath.join(posixpath.dirname(member.name), member.linkname))
                            assert not member.linkname.startswith('/') and resolved != '..' and not resolved.startswith('../')
                            entry.type, entry.linkname, entry.size = tarfile.SYMTYPE, member.linkname, 0
                            target.addfile(entry)
                        else:
                            target.addfile(entry, source.extractfile(member))
                archive = normalized.getvalue()
                total += len(archive)
                assert total <= 20 << 20
                digest = hashlib.sha256(archive).hexdigest()
                bundles.append({'uses': uses, 'commitId': commit, 'commit': base64.b64encode(body).decode(), 'archive': base64.b64encode(archive).decode(), 'archiveSha256': digest})
                receipt['actions'].append({'uses': uses, 'commitId': commit, 'archiveSha256': digest, 'archiveBytes': len(archive)})
                record()
        data = (json.dumps(bundles, separators=(',', ':')) + '\n').encode()
        assert len(data) <= 32 << 20
        file = output / 'bundles.json'
        with file.open('xb') as stream:
            file.chmod(0o600)
            stream.write(data)
        receipt.update(passed=True, bundleSHA256=hashlib.sha256(data).hexdigest())
        record()
        print('Acquired', len(bundles), 'immutable action bundles; no source executed.')
    except Exception:
        receipt['failure'] = 'Acquisition failed or exceeded a bound; private provider output withheld.'
        record()
        raise SystemExit(1)


if __name__ == '__main__':
    main()
