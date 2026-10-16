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


def check_native_settings():
    # Forgejo 15.0.9 cron inventory (services/cron/tasks_basic.go and
    # tasks_extended.go at v15.0.9); actions tasks never register while
    # [actions] ENABLED=false.
    assert len(recovery.NATIVE_CRON_TASKS) == len(set(recovery.NATIVE_CRON_TASKS)) == 24
    assert 'remove_resolved_reports' in recovery.NATIVE_CRON_TASKS
    # Forgejo's environment-to-ini encoding: literal or _0X2E_-escaped dots.
    settings = recovery.native_settings({'FORGEJO__cron.update_mirrors__ENABLED': 'false',
        'FORGEJO__cron_0X2E_gc_lfs__ENABLED': 'false', 'FORGEJO__Database__HOST': 'postgres:5432',
        'FORGEJO__server__ROOT_0X5F_URL': 'x', 'FORGEJO__no_key': 'ignored', 'UNRELATED': 'ignored'})
    assert settings == {('cron.update_mirrors', 'ENABLED'): 'false', ('cron.gc_lfs', 'ENABLED'): 'false',
                        ('database', 'HOST'): 'postgres:5432', ('server', 'ROOT_URL'): 'x'}
    for env in [{'FORGEJO__cron.gc_lfs__ENABLED': 'false', 'FORGEJO__cron_0X2E_gc_lfs__ENABLED': 'true'},
                {'FORGEJO__actions__ENABLED': 'false', 'FORGEJO__ACTIONS__enabled': 'true'},
                {recovery.UPSTREAM_ENV_PREFIX+'actions__ENABLED': 'true'},
                {'FORGEJO__database__PASSWD__FILE': '/run/secret'}]:
        denied(lambda: recovery.native_settings(env))
    data = str(recovery.FORGEJO_DATA)
    native = {'GITEA_WORK_DIR': data, 'GITEA_CUSTOM': data+'/custom',  # Forgejo's upstream name
              'GITEA_APP_INI': str(recovery.FORGEJO_APP_INI), 'HOME': data+'/git',  # Forgejo's upstream name
              'FORGEJO__database__DB_TYPE': 'postgres', 'FORGEJO__database__HOST': 'postgres:5432',
              'FORGEJO__database__NAME': 'forgejo', 'FORGEJO__database__USER': 'forgejo',
              'FORGEJO__database__PASSWD': 'fixture'}
    recovery.validate_forgejo_environment(native, 'fixture')
    for key, value in [('FORGEJO__database__NAME', 'golf'), ('FORGEJO__database__PASSWD', 'other'),
                       ('GITEA_APP_INI', '/etc/forge/app.ini'),  # Forgejo's upstream name
                       ('FORGEJO_CUSTOM', '/external'),
                       ('FORGEJO_WORK_DIR', '/external'), ('HOME', '/root'),
                       (recovery.UPSTREAM_ENV_PREFIX+'database__HOST', 'external:5432')]:
        denied(lambda: recovery.validate_forgejo_environment(dict(native, **{key: value}), 'fixture'))
    assert recovery.forgejo_volumes() == ['forgejo-data:'+data]
    assert recovery.FILES == {'compose.json', 'postgres-init.sh', 'golf.dump', 'forgejo.dump', 'forgejo-data.tar'}
    assert (recovery.ROOT/recovery.POSTGRES_INIT).is_file()


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
    # Forgejo's rootless image keeps data and app.ini in one volume; derive its
    # upstream path names from recovery.py instead of restating them.
    data, top = str(recovery.FORGEJO_DATA), recovery.DATA_ROOT
    with tempfile.TemporaryDirectory(prefix='golf-recovery-test-') as directory:
        path = Path(directory)/'volume.tar'
        root = entry(top, tarfile.DIRTYPE, mode=0o700)
        file = entry(top+'/regular')
        cases = [
            [entry('/'+top+'/absolute')], [entry(top+'/../escape')], [entry(top+'/./alias')],
            [entry(top+'//alias')], [file, file], [entry(top+'/socket', b's')],
            [entry(top+'/device', tarfile.CHRTYPE)], [entry(top+'/suid', mode=0o4600)],
            [entry(top+'/foreign-owner', uid=1234)], [entry(top+'/missing/file')],
            [entry(top+'/link', tarfile.SYMTYPE, '/etc/passwd')],
            [entry(top+'/link', tarfile.SYMTYPE, '../escape')],
            [entry(top+'/link', tarfile.LNKTYPE, '../escape')],
            [entry(top+'/link', tarfile.LNKTYPE, top)],
            [entry(top+'/link', tarfile.SYMTYPE, 'missing')],
            [entry(top+'/link', tarfile.SYMTYPE, 'regular'), entry(top+'/link/child')],
            [entry('other-root/regular')],
        ]
        for rows in cases:
            archive(path, [root, file, *rows] if file not in rows else [root, *rows])
            denied(lambda: recovery.validate_volume(path))
        archive(path, [root, file, entry(top+'/link', tarfile.SYMTYPE, 'regular'),
                       entry(top+'/hard', tarfile.LNKTYPE, top+'/regular')])
        recovery.validate_volume(path)
        conf = [entry(top+'/custom', tarfile.DIRTYPE, mode=0o700), entry(top+'/custom/conf', tarfile.DIRTYPE, mode=0o700)]
        assert recovery.DATA_APP_INI == top+'/custom/conf/app.ini'

        def ini_volume(data, mode=0o600, extra=()):
            return [root, *conf, entry(recovery.DATA_APP_INI, data=data, mode=mode), *extra]

        repositories = (data+'/git/repositories').encode()
        ini = (b'[database]\nDB_TYPE=postgres\nHOST=postgres:5432\nNAME=forgejo\nUSER=forgejo\n[repository]\nROOT='+
               repositories+b'\n[repository.local]\nLOCAL_COPY_PATH='+str(recovery.FORGEJO_TEMP).encode()+b'/local-repo\n')
        archive(path, ini_volume(ini))
        recovery.validate_volume(path, config=True)
        for value in [ini+b'[storage]\nSTORAGE_TYPE=minio\n', ini.replace(repositories, b'/external/repositories'),
                      ini.replace(repositories, data.encode()+b'/../../external'),
                      ini.replace(b'NAME=forgejo', b'NAME=golf'), ini.replace(b'USER=forgejo', b'USER=postgres'),
                      ini+b'[security]\nSECRET_KEY_URI=file:/external/key\n',
                      ini+b'[security]\nSECRET_KEY_URI=file:'+data.encode()+b'/%2e%2e/key\n',
                      ini+b'[server]\nSSH_SERVER_HOST_KEYS=/external/hostkey\n',
                      ini+b'[repository.upload]\nTEMP_PATH=/external/uploads\n',
                      ini.replace(b'postgres:5432', b'external:5432')]:
            archive(path, ini_volume(value))
            denied(lambda: recovery.validate_volume(path, config=True))
        archive(path, ini_volume(ini, mode=0o644))
        denied(lambda: recovery.validate_volume(path, config=True))
        archive(path, [root, file])
        denied(lambda: recovery.validate_volume(path, config=True))
        stage = Path(directory)
        referenced = ini+b'[security]\nSECRET_KEY_URI=file:'+data.encode()+b'/secret\n'
        archive(stage/'forgejo-data.tar', ini_volume(referenced, extra=[file]))
        denied(lambda: recovery.validate_forgejo_data(stage))
        archive(stage/'forgejo-data.tar', ini_volume(referenced, extra=[file, entry(top+'/secret')]))
        recovery.validate_forgejo_data(stage)
        check_native_settings()
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
            [entry(top+'/wrong-root', uid=10001)],
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
    print('PASS: Forgejo single-volume archive paths/links/duplicates/types/owners/modes/app.ini references, FORGEJO__ setting decoding/conflicts, local RustFS/source bindings and private-file boundaries')


if __name__ == '__main__':
    main()
