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
    print('PASS: nested archive paths/links/duplicates/types/owners/modes/storage and private-file boundaries')


if __name__ == '__main__':
    main()
