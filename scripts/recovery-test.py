#!/usr/bin/env python3
"""Offline checks for recovery archive boundaries; no Docker/data mutations."""
import io
import json
import os
from pathlib import Path
import sys
import tarfile
import tempfile

sys.dont_write_bytecode = True
import recovery


def entry(name, kind=tarfile.REGTYPE, target='', data=b'text', mode=0o600, uid=1000):
    row = tarfile.TarInfo(name)
    row.type, row.linkname, row.mode, row.uid, row.gid = kind, target, mode, uid, uid
    row.size = len(data) if kind == tarfile.REGTYPE else 0
    return row, data


def archive(path, entries):
    with tarfile.open(path, 'w:') as file:
        for row, data in entries:
            file.addfile(row, io.BytesIO(data) if row.isfile() else None)


def denied(check):
    try:
        check()
    except (ValueError, OSError):
        return
    raise AssertionError('Unsafe recovery input accepted')


def main():
    compose_files = [Path('/fixture/compose.yaml'), Path('/fixture/compose.ci.yaml'), Path('/fixture/compose.storage.yaml')]
    for label in ['/fixture/compose.yaml', '/fixture/compose.yaml,/fixture/compose.storage.yaml',
                  '/fixture/compose.yaml,/fixture/compose.ci.yaml,/fixture/compose.storage.yaml']:
        assert recovery.matching_compose_files(label, compose_files)
    for label in ['', None, '/foreign/compose.yaml', '/fixture/compose.ci.yaml',
                  '/fixture/compose.yaml,/foreign/overlay.yaml',
                  '/fixture/compose.yaml,/fixture/compose.ci.yaml,/fixture/compose.ci.yaml',
                  '/fixture/compose.yaml,/fixture/compose.storage.yaml,/fixture/compose.ci.yaml']:
        assert not recovery.matching_compose_files(label, compose_files)
    assert not recovery.matching_compose_files('/fixture/compose.yaml', [compose_files[0], compose_files[0]])
    with tempfile.TemporaryDirectory(prefix='golf-recovery-test-') as directory:
        path = Path(directory)/'volume.tar'
        root = entry('gitea', tarfile.DIRTYPE, mode=0o700)
        file = entry('gitea/regular')
        cases = [
            [entry('/gitea/absolute')], [entry('gitea/../escape')], [entry('gitea/./alias')],
            [entry('gitea//alias')], [file, file], [entry('gitea/socket', b's')],
            [entry('gitea/device', tarfile.CHRTYPE)], [entry('gitea/suid', mode=0o4600)],
            [entry('gitea/foreign-owner', uid=1234)], [entry('gitea/missing/file')],
            [entry('gitea/link', tarfile.SYMTYPE, '/etc/passwd')],
            [entry('gitea/link', tarfile.SYMTYPE, '../escape')],
            [entry('gitea/link', tarfile.LNKTYPE, '../escape')],
            [entry('gitea/link', tarfile.LNKTYPE, 'gitea')],
            [entry('gitea/link', tarfile.SYMTYPE, 'missing')],
            [entry('gitea/link', tarfile.SYMTYPE, 'regular'), entry('gitea/link/child')],
        ]
        for rows in cases:
            archive(path, [root, file, *rows] if file not in rows else [root, *rows])
            denied(lambda: recovery.validate_volume(path))
        archive(path, [root, file, entry('gitea/link', tarfile.SYMTYPE, 'regular'),
                       entry('gitea/hard', tarfile.LNKTYPE, 'gitea/regular')])
        recovery.validate_volume(path)
        ini = b'[database]\nDB_TYPE=postgres\nHOST=postgres:5432\nNAME=gitea\nUSER=gitea\n[repository]\nROOT=/var/lib/gitea/git/repositories\n'
        archive(path, [root, entry('gitea/app.ini', data=ini)])
        recovery.validate_volume(path, config=True)
        for data in [ini+b'[storage]\nSTORAGE_TYPE=minio\n', ini.replace(b'/var/lib/gitea/git/repositories', b'/external/repositories'),
                     ini.replace(b'/var/lib/gitea/git/repositories', b'/var/lib/gitea/../../external'),
                     ini+b'[security]\nSECRET_KEY_URI=file:/external/key\n',
                     ini+b'[security]\nSECRET_KEY_URI=file:/var/lib/gitea/%2e%2e/key\n',
                     ini+b'[server]\nSSH_SERVER_HOST_KEYS=/external/hostkey\n',
                     ini.replace(b'postgres:5432', b'external:5432')]:
            archive(path, [root, entry('gitea/app.ini', data=data)])
            denied(lambda: recovery.validate_volume(path, config=True))
        archive(path, [root, entry('gitea/app.ini', data=ini, mode=0o644)])
        denied(lambda: recovery.validate_volume(path, config=True))
        stage = Path(directory)
        archive(stage/'gitea-config.tar', [root, entry('gitea/app.ini', data=ini+b'[security]\nSECRET_KEY_URI=file:/var/lib/gitea/secret\n')])
        archive(stage/'gitea-data.tar', [root, file])
        denied(lambda: recovery.validate_pair(stage))
        archive(stage/'gitea-data.tar', [root, file, entry('gitea/secret')])
        recovery.validate_pair(stage)
        storage_root = entry('data', tarfile.DIRTYPE, mode=0o700, uid=10001)
        storage_file = entry('data/object', uid=10001)
        archive(path, [storage_root, storage_file])
        recovery.validate_volume(path, rustfs=True)
        for rows in [
            [entry('/data/absolute', uid=10001)], [entry('data/../escape', uid=10001)],
            [entry('data/nested/missing', uid=10001)], [storage_file, storage_file],
            [entry('data/link', tarfile.SYMTYPE, 'object', uid=10001)],
            [entry('data/hard', tarfile.LNKTYPE, 'data/object', uid=10001)],
            [entry('data/device', tarfile.CHRTYPE, uid=10001)],
            [entry('data/suid', mode=0o4600, uid=10001)], [entry('data/foreign', uid=1000)],
            [entry('gitea/wrong-root', uid=10001)],
        ]:
            archive(path, [storage_root, *rows])
            denied(lambda: recovery.validate_volume(path, rustfs=True))
        local = {'services': {
            'golf': {'environment': {'GOLF_OBJECT_ENDPOINT': 'http://rustfs:9000', 'GOLF_OBJECT_BUCKET': 'golf-ci',
                'GOLF_OBJECT_REGION': 'us-east-1', 'GOLF_OBJECT_PREFIX': 'golf', 'GOLF_OBJECT_PATH_STYLE': 'true',
                'GOLF_OBJECT_ALLOW_HTTP': 'true', 'GOLF_OBJECT_ACCESS_KEY_ID': 'fixture-key', 'GOLF_OBJECT_SECRET_ACCESS_KEY': 'fixture-secret'}},
            'rustfs': {'environment': {'RUSTFS_VOLUMES': '/data', 'RUSTFS_ADDRESS': '0.0.0.0:9000',
                'RUSTFS_CONSOLE_ENABLE': 'false', 'RUSTFS_OBS_LOG_DIRECTORY': '/logs',
                'RUSTFS_ACCESS_KEY': 'fixture-key', 'RUSTFS_SECRET_KEY': 'fixture-secret'}}}}
        fingerprint = recovery.storage_fingerprint(local)
        external_keys = json.loads(json.dumps(local))
        external_keys['services']['rustfs']['environment']['RUSTFS_KMS_ENDPOINT'] = 'https://external.invalid'
        denied(lambda: recovery.storage_fingerprint(external_keys))
        assert len(fingerprint) == 64 and recovery.profile_files(True) - recovery.FILES == {'rustfs-data.tar'}
        assert recovery.profile_files(False) == recovery.FILES
        for key, value in [('GOLF_OBJECT_ENDPOINT', 'https://remote.invalid'), ('GOLF_OBJECT_BUCKET', 'other'),
                           ('GOLF_OBJECT_PREFIX', 'other'), ('GOLF_OBJECT_ACCESS_KEY_ID', 'wrong'),
                           ('GOLF_OBJECT_SESSION_TOKEN', 'temporary')]:
            config = json.loads(json.dumps(local))
            config['services']['golf']['environment'][key] = value
            denied(lambda: recovery.storage_fingerprint(config))
        denied(lambda: recovery.storage_fingerprint({'services': {'golf': local['services']['golf']}}))
        assert recovery.storage_fingerprint({'services': {'golf': {'environment': {}}}}) == ''
        native_run = recovery.run
        try:
            replies = iter([b'0', b'0'])
            recovery.run = lambda *args, **kwargs: next(replies)
            recovery.validate_source_bindings('fixture', local, '202610020021')
            for replies in [iter([b'1']), iter([b'0', b'1'])]:
                denied(lambda: recovery.validate_source_bindings('fixture', local, '202610020021'))
        finally:
            recovery.run = native_run
        identity = Path(directory)/'identity'
        recovery.write(identity, b'fixture')
        recovery.private_file(identity)
        os.chmod(identity, 0o644)
        denied(lambda: recovery.private_file(identity))
        identity.unlink(); identity.symlink_to(path)
        denied(lambda: recovery.private_file(identity))
        output = Path(directory)/'private'
        recovery.write(output, b'original')
        denied(lambda: recovery.write(output, b'replacement'))
        assert output.read_bytes() == b'original' and output.stat().st_mode & 0o777 == 0o600
        values = {'VALUE': 'p$UNSET_${HOME}$$tail', 'QUOTE': "'quoted'", 'LINES': 'a\nb'}
        compose = Path(directory)/'compose.json'
        recovery.write(compose, recovery.compose_bytes({'services': {'fixture': {'image': 'alpine:3.23', 'environment': values}}}))
        interpreted = json.loads(recovery.run(['docker', 'compose', '-f', str(compose), 'config', '--format', 'json']))
        assert {key: value.replace('$$', '$') for key, value in interpreted['services']['fixture']['environment'].items()} == values
        payload = 8 << 30
        assert recovery.envelope_limit(payload) > payload + (payload // 65536 + 1) * 16 + (64 << 10)
        bounded = Path(directory)/'bounded'
        denied(lambda: recovery.run([sys.executable, '-c', 'import sys; sys.stdout.buffer.write(b"x"*(2<<20))'],
                                    output=bounded, limit=1 << 20))
        assert bounded.stat().st_size <= 1 << 20
    print('PASS: nested archive paths/links/duplicates/types/owners/modes/local RustFS/source bindings and private-file boundaries')


if __name__ == '__main__':
    main()
