#!/usr/bin/env python3
"""Offline trust-boundary checks; no Docker, accounts or inference required."""
import importlib.util
import io
import json
import os
from pathlib import Path
import tarfile
import tempfile
import sys
sys.dont_write_bytecode = True
from types import SimpleNamespace

spec = importlib.util.spec_from_file_location('codex_local', Path(__file__).with_name('codex-local.py'))
local = importlib.util.module_from_spec(spec); spec.loader.exec_module(local)


def denied(action):
    try: action()
    except (ValueError, OSError): return
    raise AssertionError('Unsafe operation accepted')


def archive(path, name, kind=tarfile.REGTYPE, size=1):
    with tarfile.open(path,'w:') as destination:
        item = tarfile.TarInfo(name); item.type = kind; item.size = size
        if kind == tarfile.SYMTYPE: item.linkname = '/auth/auth.json'; item.size = 0
        destination.addfile(item, io.BytesIO(b'x'*size) if kind == tarfile.REGTYPE else None)


with tempfile.TemporaryDirectory(prefix='golf-codex-offline-') as directory:
    root = Path(directory); source = root/'source.tar'
    archive(source,'README.md')
    sanitized = local.source_archive(source)
    with tarfile.open(fileobj=io.BytesIO(sanitized)) as value:
        member = value.next(); assert member.uid == 1000 and member.gid == 1000 and member.mode == 0o600
    for name, kind in [('../escape',tarfile.REGTYPE),('/auth/auth.json',tarfile.REGTYPE),
        ('.git/config',tarfile.REGTYPE),('nested/.codex/config.toml',tarfile.REGTYPE),
        ('alias',tarfile.SYMTYPE),('pipe',tarfile.FIFOTYPE),('a/./b',tarfile.REGTYPE),('a//b',tarfile.REGTYPE),('bad\nname',tarfile.REGTYPE)]:
        archive(source,name,kind); denied(lambda:local.source_archive(source))
    with tarfile.open(source,'w:') as destination:
        for name in ['parent','parent/child']:
            item=tarfile.TarInfo(name);item.size=1;destination.addfile(item,io.BytesIO(b'x'))
    denied(lambda:local.source_archive(source))
    archive(source,'huge',size=(8<<20)+1); denied(lambda:local.source_archive(source))
    key = root/'key'; key.write_text('private'); key.chmod(0o600)
    assert local.private_file(key,20) == b'private'
    key.chmod(0o644); denied(lambda:local.private_file(key,20)); key.chmod(0o600)
    link = root/'link'; link.symlink_to(key); denied(lambda:local.private_file(link,20))
    image = 'sha256:'+'a'*64
    state = root/'connection'
    with local.connection(state,image) as (_,record):
        denied(lambda:local.connection(state,image).__enter__())
        labels = {local.LABEL:record['identity'],'io.golf.codex.owner':str(os.getuid())}
        assert local.owned(record,labels) and not local.owned(record,{**labels,local.LABEL:'foreign'})
        command = local.create_command(record)
        assert '--privileged' not in command and '--network' not in command
        assert command[command.index('--user')+1] == '1000:1000' and '--read-only' in command
        assert command[command.index('--mount')+1] == 'type=volume,source='+record['volume']+',target=/auth'
        assert 'no-new-privileges:true' in command and 'unconfined' not in ' '.join(command)
    original_docker, calls = local.docker, []
    def inventory(*args,**kwargs):
        calls.append(args)
        data=json.dumps([{'Config':{'Labels':labels}}]).encode() if args[0]=='inspect' else ('c'*64+'\n').encode()
        return SimpleNamespace(stdout=data)
    try:
        local.docker=inventory
        assert local.containers(record)==['c'*64]
        assert '--no-trunc' in calls[0], 'Cleanup inventory must preserve full container IDs'
    finally: local.docker=original_docker
    denied(lambda:local.connection(state,'sha256:'+'b'*64).__enter__())
    denied(lambda:local.connection(local.ROOT/'unwanted-state',image).__enter__())
    denied(lambda:local.connection(root/'invalid','codex:latest').__enter__())
    event = lambda names: b'\n'.join(json.dumps({'type':name}).encode() for name in names)
    assert local.completed_events(event(['thread.started','turn.started','turn.completed']),0)
    for names,code in [(['turn.started','turn.failed'],0),(['turn.started','turn.completed'],1),
        (['turn.started','item.completed'],0),(['turn.started','error','turn.completed'],0),
        (['turn.started','turn.completed','turn.completed'],0)]:
        assert not local.completed_events(event(names),code)
    denied(lambda:local.completed_events(b'agent says success',0))
    archive(source,'README.md');before=local.source_archive(source)
    with tarfile.open(source,'w:') as destination:
        item=tarfile.TarInfo('README.md');item.size=2;destination.addfile(item,io.BytesIO(b'y\n'))
    after=local.source_archive(source);diff,binary=local.proposal(before,after)
    assert b'--- a/README.md' in diff and b'+y' in diff and not binary
    flags = local.exec_flags()
    assert 'workspace-write' in flags and 'approval_policy="never"' in flags
    assert '--ignore-user-config' in flags and '--ignore-rules' in flags and '--ephemeral' in flags
    assert not any('dangerously' in value for value in flags)
assert local.device_codes(b'https://auth.openai.com/codex/device\nEnter this one-time code (expires in 15 minutes)\n   \x1b[34mSAMPLE-CODE\x1b[0m\n') == [b'SAMPLE-CODE']
assert local.device_codes(b'Error: SAMPLE-CODE') == []
print('PASS: source, private inputs, connection locking, resource ownership, Docker isolation, native flags and terminal outcome boundaries')
